"""File operations: save/load flowgraph, reload frontend, shutdown."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

from fastapi import HTTPException

from backend.config import LOCALHOST, SERVER_PORT, FLOWGRAPH_EXTENSION
from backend.tools.ws import send_command, broadcast_console_log, get_ws_clients

logger = logging.getLogger(__name__)


def _validate_filepath(filepath: str) -> Path:
    """Validate that filepath is within the project directory."""
    project_root = Path(__file__).parent.parent.parent.resolve()
    resolved = Path(filepath).resolve()
    if not resolved.is_relative_to(project_root):
        raise HTTPException(403, f"Path outside project directory: {filepath}")
    return resolved


async def save_flowgraph(filepath: str) -> dict:
    """Save the current flowgraph to a .rcflow file."""
    if not filepath or not filepath.strip():
        return {"success": False, "message": "Error: filepath must not be empty"}
    path = _validate_filepath(filepath)
    if path.suffix.lower() not in (FLOWGRAPH_EXTENSION, ".json"):
        path = path.with_suffix(FLOWGRAPH_EXTENSION)

    result = await send_command({"action": "get_save_data"})
    if not result.get("success"):
        raise HTTPException(400, result.get("error", "Failed to get save data"))

    save_data = result.get("save_data", {})
    name = path.stem
    save_data["name"] = name

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(save_data, indent=2), encoding="utf-8")

    logger.info("Flowgraph saved to %s", path)
    await broadcast_console_log("info", f"Saved: {path.name}", "", "file")
    return {"success": True, "filepath": str(path), "name": name}


async def load_flowgraph(filepath: str) -> dict:
    """Load a flowgraph from a .rcflow or .json file."""
    path = _validate_filepath(filepath)
    if not path.exists():
        raise HTTPException(404, f"File not found: {filepath}")

    try:
        text = path.read_text(encoding="utf-8")
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"Invalid JSON in file: {e}")

    if "nodes" not in data or "edges" not in data:
        raise HTTPException(400, "Invalid flowgraph file: missing 'nodes' or 'edges'")

    result = await send_command({
        "action": "restore_flowgraph",
        "data": data,
        "filename": path.name,
    })
    if not result.get("success"):
        raise HTTPException(400, result.get("error", "Failed to restore flowgraph"))

    name = data.get("name", path.stem)
    await broadcast_console_log("info", f"Loaded: {path.name}", "", "file")
    return {
        "success": True,
        "filepath": str(path),
        "name": name,
        "num_nodes": len(data.get("nodes", [])),
        "num_edges": len(data.get("edges", [])),
    }


async def reload_frontend() -> dict:
    """Send reload command to all connected browser clients."""
    ws_clients = get_ws_clients()
    if not ws_clients:
        raise HTTPException(
            status_code=503,
            detail=f"No frontend connected. Open http://{LOCALHOST}:{SERVER_PORT} in a browser.",
        )
    message = json.dumps({"action": "reload"})
    count = 0
    for ws in list(ws_clients):
        try:
            await ws.send_text(message)
            count += 1
        except Exception as e:
            logger.warning("Failed to send reload to WebSocket client: %s", e)
    return {"success": True, "clients": count}


async def get_dirty_tabs() -> dict:
    """List workspace tabs with unsaved changes.

    Returns {success: True, dirty_tabs: [{id, title}, ...]} on success.
    On frontend-unreachable / timeout, returns success=True with an empty
    list and a 'frontend_unreachable' note — same semantics the shutdown
    guard uses (no renderer → no unsaved state to lose).
    """
    try:
        result = await asyncio.wait_for(
            send_command({"action": "get_dirty_tabs"}),
            timeout=2.0,
        )
        if result and result.get("success"):
            return {"success": True, "dirty_tabs": result.get("dirty_tabs", [])}
        return {
            "success": False,
            "message": f"Frontend returned failure: {result}",
            "dirty_tabs": [],
        }
    except asyncio.TimeoutError:
        logger.warning(
            "get_dirty_tabs: frontend did not respond within 2s — "
            "treating as no dirty tabs"
        )
        return {
            "success": True,
            "dirty_tabs": [],
            "frontend_unreachable": True,
        }
    except Exception as e:
        logger.warning("get_dirty_tabs failed: %s", e)
        return {
            "success": False,
            "message": f"get_dirty_tabs failed: {e}",
            "dirty_tabs": [],
        }


async def shutdown_server(force: bool = False) -> dict:
    """Shut down the uvicorn server process.

    Default behavior refuses shutdown when any workspace tab has unsaved
    changes — the caller must save (`save_tab`) or pass force=True to
    discard. This prevents silent data loss when AI/CLI tooling invokes
    the API (the UI path has its own dialog; the API path used to skip
    it).

    force=True bypasses the dirty check.

    If the frontend is unreachable (no WS client connected, or the
    request times out), we proceed with shutdown — there is no
    renderer to hold unsaved state in that case.
    """
    import os
    import threading

    if not force:
        check = await get_dirty_tabs()
        dirty = check.get("dirty_tabs", [])
        if dirty:
            titles = ", ".join(t.get("title", t.get("id", "?")) for t in dirty)
            return {
                "success": False,
                "message": (
                    f"Shutdown refused: unsaved changes in {len(dirty)} "
                    f"workspace(s): {titles}. Save with save_tab, or pass "
                    f"force=true to discard."
                ),
                "dirty_tabs": dirty,
            }

    def _exit():
        import time, signal
        time.sleep(0.5)
        logger.info("Shutdown requested via API (force=%s) — exiting.", force)
        os.kill(os.getpid(), signal.SIGTERM)

    threading.Thread(target=_exit, daemon=True).start()
    return {"success": True, "message": "Server shutting down..."}
