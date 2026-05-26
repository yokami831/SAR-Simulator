"""Narrator: lightweight event buffer for HiyoCanvas runtime observability."""

from __future__ import annotations

import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Optional


class TYPES:
    FLOW      = "flow"
    NODE      = "node"
    WEBSOCKET = "websocket"
    JS_ERROR  = "js_error"
    KERNEL    = "kernel"


class NAMES:
    FLOW_STARTED    = "flow_started"
    FLOW_COMPLETED  = "flow_completed"
    FLOW_ERROR      = "flow_error"
    FLOW_CANCELLED  = "flow_cancelled"
    NODE_EXECUTING  = "node_executing"
    NODE_COMPLETED  = "node_completed"
    NODE_ERROR      = "node_error"
    WS_CONNECTED      = "ws_connected"
    WS_DISCONNECTED   = "ws_disconnected"
    JS_ERROR          = "js_error"
    JS_UNHANDLED      = "js_unhandled_rejection"
    KERNEL_STARTING   = "kernel_starting"
    KERNEL_STARTED    = "kernel_started"
    KERNEL_START_ERROR = "kernel_start_error"
    KERNEL_STOPPED    = "kernel_stopped"
    NODE_SKIPPED      = "node_skipped"


_ERROR_NAMES = {NAMES.FLOW_ERROR, NAMES.NODE_ERROR, NAMES.JS_ERROR, NAMES.JS_UNHANDLED, NAMES.KERNEL_START_ERROR}
_NODE_NAMES  = {NAMES.NODE_EXECUTING, NAMES.NODE_COMPLETED, NAMES.NODE_ERROR, NAMES.NODE_SKIPPED}


class NarratorBuffer:
    """Ring buffer that records runtime events and maintains derived state."""

    def __init__(self) -> None:
        self._buf: deque[dict] = deque(maxlen=500)
        self._flow_status: str = "stopped"
        self._ws_connected: bool = False
        self._ws_client_count: int = 0
        self._last_event: Optional[dict] = None
        self._last_error: Optional[dict] = None
        self._node_statuses: dict[str, str] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def emit(self, type: str, name: str, data: Optional[dict] = None) -> dict:
        """Create an event dict, append it to the buffer, and return it."""
        event: dict = {
            "id":   uuid.uuid4().hex[:12],
            "ts":   datetime.now(timezone.utc).isoformat(),
            "type": type,
            "name": name,
            "data": data or {},
        }
        self._buf.append(event)
        self._update_state(event)
        return event

    def recent(self, n: int = 50) -> list[dict]:
        """Return the most recent N events, newest first."""
        items = list(self._buf)
        return list(reversed(items[-n:]))

    def errors(self, n: int = 20) -> list[dict]:
        """Return the most recent N error events, newest first."""
        err_events = [e for e in self._buf if e["name"] in _ERROR_NAMES]
        return list(reversed(err_events[-n:]))

    def get_state(self) -> dict:
        """Return a snapshot of derived runtime state."""
        return {
            "flow_status":      self._flow_status,
            "ws_connected":     self._ws_connected,
            "ws_client_count":  self._ws_client_count,
            "last_event":       self._last_event,
            "last_error":       self._last_error,
            "node_statuses":    dict(self._node_statuses),
            "buffer_size":      len(self._buf),
        }

    def clear(self) -> None:
        """Clear the event buffer and per-node statuses; preserve live connection state."""
        self._buf.clear()
        self._node_statuses.clear()
        self._last_event = None
        self._last_error = None
        # flow_status, ws_connected, ws_client_count are intentionally kept

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _update_state(self, event: dict) -> None:
        """Update derived state fields from the incoming event."""
        name = event["name"]
        data = event["data"]

        self._last_event = event

        if name == NAMES.FLOW_STARTED:
            self._flow_status = "running"
        elif name in (NAMES.FLOW_COMPLETED, NAMES.FLOW_CANCELLED):
            self._flow_status = "stopped"
        elif name == NAMES.FLOW_ERROR:
            self._flow_status = "error"

        if name in _ERROR_NAMES:
            self._last_error = event

        if name == NAMES.WS_CONNECTED:
            self._ws_connected = True
            self._ws_client_count = data.get("client_count", 1)
        elif name == NAMES.WS_DISCONNECTED:
            self._ws_client_count = data.get("client_count", 0)
            if self._ws_client_count == 0:
                self._ws_connected = False

        if name in _NODE_NAMES:
            node_id: str = data.get("node_id", "")
            if node_id:
                self._node_statuses[node_id] = name


# ------------------------------------------------------------------
# Module-level singleton
# ------------------------------------------------------------------

_narrator = NarratorBuffer()


def get_narrator() -> NarratorBuffer:
    """Return the global NarratorBuffer singleton."""
    return _narrator


def emit(type: str, name: str, data: Optional[dict] = None) -> dict:
    """Emit an event to the global narrator buffer."""
    return _narrator.emit(type, name, data)
