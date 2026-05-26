"""FastAPI server for HiyoCanvas.

Provides REST API endpoints for canvas management and WebSocket
for real-time communication with the frontend.

API routes are organized into router modules:
    /api/tools/*       - Tool endpoints for AI agents (routers/tools_router.py)
    /api/workspaces/*  - Workspace CRUD (routers/workspaces_router.py)
    /api/cdp/*         - CDP screenshot & view control (routers/cdp_router.py)
    /api/blocks        - Block definitions (routers/blocks_router.py)
    /ws/data           - Real-time WebSocket
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend.config import (
    APP_NAME, CDP_PORT, LOCALHOST, SERVER_PORT, VITE_DEV_PORT, VOICE_AGENT_PORT,
    get_workspaces_dir, set_workspaces_dir,
    read_app_config, write_app_config, restore_workspaces_dir,
    get_feature_flags,
)
from backend import tools, plugin_manager
from backend import narrator as _narrator
from backend.routers import tools_router, workspaces_router, cdp_router, blocks_router, notes_router, narrator_router

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Module-level WebSocket client set
_ws_clients: set[WebSocket] = set()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan — run startup side-effects here."""
    # Restore last used workspaces directory from app-config.json
    restore_workspaces_dir()

    # Initialize tools module with shared server resources
    tools.init_tools(_ws_clients)

    # Register plugins
    from backend.plugins.python_canvas.plugin import PythonCanvasPlugin
    from backend import block_registry

    # Register Python Canvas block directory
    _python_blocks_dir = Path(__file__).parent / "plugins" / "python_canvas" / "blocks"
    block_registry.register_block_dir(_python_blocks_dir)

    # Apply feature flag filtering to block registry
    features = get_feature_flags()
    if not features.get("fpga"):
        block_registry.set_excluded_categories(["hdl"])

    # Create and register Python Canvas plugin
    _python_plugin = PythonCanvasPlugin(
        ws_broadcast=tools._ws_broadcast,
        console_log_broadcast=tools.broadcast_console_log,
    )
    plugin_manager.register(_python_plugin)

    yield


# ---------------------------------------------------------------------------
# Application Setup
# ---------------------------------------------------------------------------

app = FastAPI(title="HiyoCanvas", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        f"http://{LOCALHOST}:{SERVER_PORT}",
        f"http://localhost:{SERVER_PORT}",
        f"http://localhost:{VITE_DEV_PORT}",  # Vite dev server (npm run dev)
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(tools_router.router)
app.include_router(workspaces_router.router)
app.include_router(cdp_router.router)
app.include_router(blocks_router.router)
app.include_router(notes_router.router)
app.include_router(narrator_router.router)

# Conditionally include FPGA-related router
if get_feature_flags().get("fpga"):
    from backend.routers import vcd_router
    app.include_router(vcd_router.router)


# ---------------------------------------------------------------------------
# Core Endpoints
# ---------------------------------------------------------------------------


@app.get("/api/health")
async def api_health() -> JSONResponse:
    """Health check endpoint for Electron startup.

    Returns app identity + resolved ports so external consumers can verify
    they actually reached HiyoCanvas (not another process on a shifted port).
    """
    return JSONResponse(content={
        "status": "ok",
        "app": APP_NAME,
        "pid": os.getpid(),
        "server_port": SERVER_PORT,
        "cdp_port": CDP_PORT,
        "version": "0.1.0",
    })


@app.get("/api/plugins")
async def list_plugins() -> JSONResponse:
    """Return available canvas plugins for tab creation UI."""
    return JSONResponse(content={"plugins": plugin_manager.get_plugin_list()})


@app.get("/api/config")
async def get_config() -> JSONResponse:
    """Return server configuration for the frontend."""
    features = get_feature_flags()
    config: dict = {
        "server_port": SERVER_PORT,
        "cdp_port": CDP_PORT,
        "features": features,
    }
    # Only expose voice_ws when RINA is enabled
    if features.get("rina"):
        config["voice_ws"] = f"ws://{LOCALHOST}:{VOICE_AGENT_PORT}/ws"
    return JSONResponse(content=config)


# --- App State (persistent JSON file, per workspace folder) ---


def _app_state_path() -> Path:
    return get_workspaces_dir() / "app-state.json"


def _read_app_state() -> dict:
    p = _app_state_path()
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _write_app_state(state: dict) -> None:
    p = _app_state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


@app.get("/api/app-state")
async def get_app_state() -> JSONResponse:
    """Read the persistent app state."""
    return JSONResponse(content=_read_app_state())


@app.patch("/api/app-state")
async def patch_app_state(updates: dict) -> JSONResponse:
    """Merge updates into the persistent app state."""
    state = _read_app_state()
    state.update(updates)
    _write_app_state(state)
    return JSONResponse(content=state)


# --- Workspaces Directory (configurable workspace folder) ---


@app.get("/api/workspaces-dir")
async def get_workspaces_dir_endpoint() -> JSONResponse:
    """Return the current workspaces directory path."""
    return JSONResponse(content={"path": str(get_workspaces_dir())})


@app.put("/api/workspaces-dir")
async def set_workspaces_dir_endpoint(req: dict) -> JSONResponse:
    """Change the workspaces directory.

    Requires all tabs to be closed first (handled by frontend).
    """
    new_path = req.get("path")
    if not new_path:
        return JSONResponse(status_code=400, content={"error": "Missing 'path'"})

    p = Path(new_path)
    if not p.is_dir():
        return JSONResponse(status_code=400, content={"error": f"Directory not found: {new_path}"})

    set_workspaces_dir(p)

    # Persist to app-config.json (project root, not workspace folder)
    cfg = read_app_config()
    cfg["lastWorkspacesDir"] = str(p)
    write_app_config(cfg)

    return JSONResponse(content={"success": True, "path": str(p)})


# --- Chat Log (append-only Markdown, per workspace folder) ---


def _chat_log_path() -> Path:
    return get_workspaces_dir() / "chat-log.md"


@app.post("/api/chat-log")
async def append_chat_log(entry: dict) -> JSONResponse:
    """Append a chat message to the Markdown log file (RINA only)."""
    if not get_feature_flags().get("rina"):
        return JSONResponse(status_code=404, content={"error": "RINA feature disabled"})
    from datetime import datetime, timezone
    role = entry.get("role", "unknown")
    content = entry.get("content", "")
    if not content.strip():
        return JSONResponse(content={"ok": True})
    label = "Rina" if role == "assistant" else "User"
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    line = f"**{label}** ({timestamp}): {content}\n\n"
    log_path = _chat_log_path()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(line)
    return JSONResponse(content={"ok": True})


@app.get("/screenshots/{filename}")
async def serve_screenshot(filename: str):
    """Serve screenshot image files."""
    screenshots_dir = Path(__file__).parent.parent / "screenshots"
    filepath = (screenshots_dir / filename).resolve()
    if not filepath.is_relative_to(screenshots_dir.resolve()):
        raise HTTPException(403, "Access denied")
    if not filepath.exists():
        raise HTTPException(404, f"Screenshot not found: {filename}")
    return FileResponse(filepath, media_type="image/png")


# ---------------------------------------------------------------------------
# WebSocket Endpoint
# ---------------------------------------------------------------------------


@app.websocket("/ws/data")
async def ws_data(websocket: WebSocket) -> None:
    """WebSocket endpoint for real-time communication with the frontend."""
    await websocket.accept()
    _ws_clients.add(websocket)
    _narrator.emit(_narrator.TYPES.WEBSOCKET, _narrator.NAMES.WS_CONNECTED,
                   {"client_count": len(_ws_clients)})
    logger.info("WebSocket client connected")

    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                if "response_to" in msg:
                    tools.handle_frontend_response(msg)
                elif msg.get("type") in ("js_error", "unhandled_rejection"):
                    logger.error(
                        "Frontend JS error: %s at %s:%s\n%s",
                        msg.get("message", "?"),
                        msg.get("source", "?"),
                        msg.get("lineno", "?"),
                        msg.get("stack", ""),
                    )
                    tools.report_frontend_error(msg)
                    _narrator.emit(_narrator.TYPES.JS_ERROR, _narrator.NAMES.JS_ERROR,
                                   {"message": msg.get("message", "?"),
                                    "source": msg.get("source", "?"),
                                    "lineno": msg.get("lineno", "?")})
                elif msg.get("type") == "frontend_ready":
                    logger.info("Frontend ready signal received")
                    tools.on_frontend_ready()
                elif msg.get("type") == "console_log":
                    tools.store_console_log(msg)
                elif msg.get("type") == "console_clear":
                    tools.clear_stored_console_logs()
                else:
                    logger.debug("WebSocket client message: %s", data)
            except json.JSONDecodeError:
                logger.warning("Invalid JSON from WebSocket client: %s", data[:200])
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
    except Exception as e:
        logger.warning("WebSocket error: %s", e)
    finally:
        _ws_clients.discard(websocket)
        _narrator.emit(_narrator.TYPES.WEBSOCKET, _narrator.NAMES.WS_DISCONNECTED,
                       {"client_count": len(_ws_clients)})
        if not _ws_clients:
            tools.on_frontend_disconnect()


# ---------------------------------------------------------------------------
# Static Files (must be last - catches all unmatched routes)
# ---------------------------------------------------------------------------

FRONTEND_DIR = Path(__file__).parent.parent / "dist"
if not FRONTEND_DIR.exists():
    raise RuntimeError(f"Frontend dist directory not found: {FRONTEND_DIR}. Run 'npm run build' first.")
logger.info("Serving frontend from: %s", FRONTEND_DIR)


@app.middleware("http")
async def add_no_cache_for_dev(request, call_next):
    """Prevent browser caching of local JS/CSS files."""
    response = await call_next(request)
    path = request.url.path
    if path.endswith((".js", ".css")) and not path.startswith("/ws"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


# Serve workspace files (VRM models, images, etc.) at /workspaces/
# Note: StaticFiles is fixed at mount time. For dynamic folder changes,
# workspace files are accessed via the /api/workspaces/ endpoints instead.
_ws_dir = get_workspaces_dir()
if _ws_dir.exists():
    app.mount("/workspaces", StaticFiles(directory=str(_ws_dir)), name="workspaces")

if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


# ---------------------------------------------------------------------------
# Main Entry Point
# ---------------------------------------------------------------------------


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=SERVER_PORT,
        log_level="info",
    )
