"""WebSocket command infrastructure + frontend status tracking.

Handles sending commands to the frontend via WebSocket and receiving responses.
Also tracks frontend readiness and JavaScript errors.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

from backend.config import (
    LOCALHOST, SERVER_PORT,
    WS_COMMAND_TIMEOUT, MAX_FRONTEND_ERRORS, MAX_CONSOLE_LOGS,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# ToolsState — encapsulates all module-level mutable state
# ---------------------------------------------------------------------------

class ToolsState:
    """Encapsulates all WebSocket/frontend tracking state."""

    def __init__(self) -> None:
        self.pending_requests: dict[str, asyncio.Future] = {}
        self.frontend_errors: deque[dict] = deque(maxlen=MAX_FRONTEND_ERRORS)
        self.frontend_ready: bool = False
        self.console_logs: deque[dict] = deque(maxlen=MAX_CONSOLE_LOGS)
        self.ws_clients: set = set()
        self.ws_lock: asyncio.Lock = asyncio.Lock()

    def reset(self) -> None:
        """Reset all state (for testing)."""
        self.pending_requests.clear()
        self.frontend_errors.clear()
        self.frontend_ready = False
        self.console_logs.clear()


# Single global instance
_state = ToolsState()


def get_ws_clients() -> set:
    """Get the current WebSocket client set."""
    return _state.ws_clients


def init_tools(ws_clients: set | None = None) -> None:
    """Initialize tool module with shared server resources."""
    if ws_clients is not None:
        _state.ws_clients = ws_clients
    logger.info("Tools module initialized.")


# ---------------------------------------------------------------------------
# WebSocket Command Infrastructure
# ---------------------------------------------------------------------------


async def send_command(command: dict, timeout: float = WS_COMMAND_TIMEOUT) -> dict:
    """Send a command to the frontend via WebSocket and wait for response."""
    ws_clients = _state.ws_clients
    if not ws_clients:
        raise HTTPException(503, f"No frontend connected. Open http://{LOCALHOST}:{SERVER_PORT} in a browser first.")

    request_id = str(uuid.uuid4())
    command["request_id"] = request_id

    future = asyncio.get_running_loop().create_future()
    _state.pending_requests[request_id] = future

    try:
        msg_json = json.dumps(command)
        disconnected: set[Any] = set()

        for ws in list(ws_clients):
            try:
                await ws.send_text(msg_json)
            except Exception as e:
                logger.warning("Failed to send command to WebSocket client: %s", e)
                disconnected.add(ws)

        if disconnected:
            async with _state.ws_lock:
                ws_clients -= disconnected

        if not ws_clients and not future.done():
            raise HTTPException(503, "All frontend clients disconnected during command send.")

        result = await asyncio.wait_for(future, timeout=timeout)
        return result

    except asyncio.TimeoutError:
        client_count = len(ws_clients)
        diag_parts = [
            f"Frontend did not respond to '{command['action']}' within {timeout}s.",
            f"Connected clients: {client_count}.",
        ]
        if not _state.frontend_ready:
            diag_parts.append(
                "Frontend has NOT signaled ready — React may have failed to initialize."
            )
        if _state.frontend_errors:
            latest = _state.frontend_errors[-1]
            diag_parts.append(
                f"Latest JS error: {latest['message']} "
                f"at {latest.get('source', '?')}:{latest.get('lineno', '?')}"
            )
        elif _state.frontend_ready:
            diag_parts.append(
                "No JS errors reported. Browser tab may be frozen or minimized."
            )
        raise HTTPException(504, " ".join(diag_parts))
    finally:
        _state.pending_requests.pop(request_id, None)


def handle_frontend_response(msg: dict) -> None:
    """Process a response from the frontend to a pending command."""
    request_id = msg.get("response_to")
    if not request_id:
        return

    future = _state.pending_requests.get(request_id)
    if future and not future.done():
        future.set_result(msg)
    else:
        logger.warning("Received response for unknown/completed request: %s", request_id)


async def broadcast_console_log(
    level: str, message: str, details: str = "", source: str = ""
) -> None:
    """Broadcast a console log entry to all connected frontends (fire-and-forget)."""
    entry = {
        "type": "console_log_push",
        "id": f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:6]}",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "message": message,
        "details": details,
        "source": source,
    }
    store_console_log(entry)

    ws_clients = _state.ws_clients
    if not ws_clients:
        return
    msg_json = json.dumps(entry)
    disconnected: set[Any] = set()
    for ws in list(ws_clients):
        try:
            await ws.send_text(msg_json)
        except Exception as e:
            logger.debug("WebSocket send failed (client may have disconnected): %s", e)
            disconnected.add(ws)
    if disconnected:
        async with _state.ws_lock:
            ws_clients -= disconnected


async def _ws_broadcast(msg: dict) -> None:
    """Broadcast a message to all WebSocket clients (fire-and-forget)."""
    data = json.dumps(msg)
    for ws in list(_state.ws_clients):
        try:
            await ws.send_text(data)
        except Exception as e:
            logger.debug("WebSocket broadcast failed (client disconnected): %s", e)


async def notify_save_completed(filename: str, kind: str = "flow") -> None:
    """Broadcast 'save_completed' so renderers can clear their dirty flag and
    re-anchor the saved fingerprint for the workspace they hold under this
    filename. Called after every server-side workspace write (API save paths)
    so the frontend's dirty state stays in sync with disk.
    """
    try:
        await _ws_broadcast({
            "type": "save_completed",
            "filename": filename,
            "kind": kind,
        })
    except Exception as e:
        logger.warning("notify_save_completed broadcast failed: %s", e)


# ---------------------------------------------------------------------------
# Frontend Error Reporting + Readiness
# ---------------------------------------------------------------------------


def report_frontend_error(error: dict) -> None:
    """Store a frontend JS error reported via WebSocket."""
    _state.frontend_errors.append({
        "type": "frontend_js",
        "message": error.get("message", "Unknown"),
        "source": error.get("source", ""),
        "lineno": error.get("lineno", 0),
        "stack": error.get("stack", ""),
    })


def on_frontend_ready() -> None:
    """Mark the frontend as ready (React components initialized)."""
    _state.frontend_ready = True
    _state.frontend_errors.clear()


def on_frontend_disconnect() -> None:
    """Reset frontend readiness when all browser clients disconnect."""
    _state.frontend_ready = False


# ---------------------------------------------------------------------------
# Console Log Storage
# ---------------------------------------------------------------------------


def store_console_log(entry: dict) -> None:
    """Store a console log entry received from the frontend via WebSocket."""
    _state.console_logs.append({
        "id": entry.get("id", ""),
        "timestamp": entry.get("timestamp", ""),
        "level": entry.get("level", "info"),
        "message": entry.get("message", ""),
        "details": entry.get("details", ""),
        "source": entry.get("source", ""),
    })


def clear_stored_console_logs() -> None:
    """Clear all stored console logs."""
    _state.console_logs.clear()


async def get_console_logs() -> dict:
    """Return all stored console log entries."""
    return {"logs": list(_state.console_logs), "count": len(_state.console_logs)}


async def clear_console_logs() -> dict:
    """Clear all stored console logs."""
    _state.console_logs.clear()
    return {"success": True}


async def get_errors() -> dict:
    """Get current error information (runtime + frontend JS errors)."""
    errors = list(_state.frontend_errors)
    return {"errors": errors, "frontend_ready": _state.frontend_ready}


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------


async def get_frontend_status() -> dict:
    """Get server connection status, active workspace, and execution state."""
    from backend import plugin_manager

    frontend_connected = _state.frontend_ready and len(_state.ws_clients) > 0
    client_count = len(_state.ws_clients)

    # Active workspace (query frontend via WebSocket)
    active_workspace: str | None = None
    if frontend_connected:
        try:
            tabs_result = await send_command({"action": "get_tabs"}, timeout=3.0)
            tabs = tabs_result.get("tabs", [])
            for tab in tabs:
                if tab.get("active"):
                    active_workspace = tab.get("title") or tab.get("workspace_file")
                    break
        except Exception as e:
            logger.warning("Failed to query active workspace: %s", e)

    # Execution state
    execution_state = "stopped"
    for plugin in plugin_manager.get_all().values():
        if hasattr(plugin, "get_status"):
            try:
                plugin_status = plugin.get_status()
                if asyncio.iscoroutine(plugin_status):
                    plugin_status = await plugin_status
                if isinstance(plugin_status, dict):
                    execution_state = plugin_status.get("status", "stopped")
                elif isinstance(plugin_status, str):
                    execution_state = plugin_status
            except Exception as e:
                logger.warning("Failed to get plugin status: %s", e)

    # Build summary message
    parts = []
    if frontend_connected:
        parts.append(f"Frontend: connected ({client_count} client(s))")
    else:
        parts.append("Frontend: not connected")

    if active_workspace:
        parts.append(f"Workspace: {active_workspace}")

    parts.append(f"Execution: {execution_state}")

    message = "Server: OK" if frontend_connected else "Server: waiting for frontend"
    message += f" ({'; '.join(parts)})"

    return {
        "success": True,
        "message": message,
        "frontend_connected": frontend_connected,
        "client_count": client_count,
        "active_workspace": active_workspace,
        "execution": execution_state,
    }


async def get_console_logs_formatted(limit: int = 20) -> dict:
    """Get recent console logs (formatted)."""
    try:
        log_data = await get_console_logs()
        logs = log_data.get("logs", [])
        total = log_data.get("count", len(logs))
        recent = logs[-limit:] if limit > 0 else logs
        if not recent:
            return {"success": True, "message": "No logs"}
        lines = [f"Logs ({len(recent)}/{total}):"]
        for log in recent:
            ts = log.get("timestamp", "")
            if "T" in ts:
                ts = ts.split("T")[-1].split(".")[0]
            level = log.get("level", "info").upper()
            msg = log.get("message", "")
            lines.append(f"  [{ts}] {level}: {msg}")
        return {"success": True, "message": "\n".join(lines)}
    except Exception as e:
        return {"success": False, "message": f"Error: {e}"}


async def get_frontend_errors_formatted() -> dict:
    """Get runtime and JS errors (human-readable formatted version)."""
    try:
        error_data = await get_errors()
        errors = error_data.get("errors", [])
        if not errors:
            return {"success": True, "message": "No errors"}
        lines = [f"Errors ({len(errors)}):"]
        for err in errors:
            msg = err.get("message", str(err))
            src = err.get("source", "")
            lineno = err.get("lineno", "")
            location = f" at {src}:{lineno}" if src else ""
            lines.append(f"  {msg}{location}")
        return {"success": True, "message": "\n".join(lines)}
    except Exception as e:
        return {"success": False, "message": f"Error: {e}"}


async def clear_logs() -> dict:
    """Clear all stored console logs (returns success dict)."""
    try:
        await clear_console_logs()
        return {"success": True, "message": "Logs cleared"}
    except Exception as e:
        return {"success": False, "message": f"Error: {e}"}


async def get_active_tab_type() -> str | None:
    """Get the type of the currently active tab (e.g. 'flow', 'mindmap')."""
    result = await send_command({"action": "list_tabs"})
    if not result.get("success"):
        return None
    for tab in result.get("tabs", []):
        if tab.get("active"):
            return tab.get("type")
    return None
