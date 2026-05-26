"""WebSocket bridge for voice agent ↔ chat UI communication.

Sends text/events from Python voice agent to browser chat panel.
Receives text input and control commands from browser.

Runs on a SEPARATE thread with its own event loop to avoid
interfering with LiveKit's VAD/STT on the main event loop.

Based on Claude-Agent-SDK/backend/browser_bridge.py (simplified: WS-only, no static files).
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from typing import Any, Callable

import aiohttp
from aiohttp import web

logger = logging.getLogger(__name__)


class VoiceBridge:
    """WebSocket server for voice agent ↔ chat UI (runs on separate thread)."""

    def __init__(self, *, port: int = 18733) -> None:  # default: backend/config.py VOICE_AGENT_PORT
        self._port = port
        self._clients: set[web.WebSocketResponse] = set()
        self._app = web.Application()
        self._runner: web.AppRunner | None = None
        self._on_text_input: Callable[[str], Any] | None = None
        self._on_abort: Callable[[], Any] | None = None
        self._on_mic_toggle: Callable[[bool], Any] | None = None
        self._on_set_voice: Callable[[bool], Any] | None = None
        self._init_messages: list[dict] = []
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None

    def on_text_input(self, callback: Callable[[str], Any]) -> None:
        self._on_text_input = callback

    def on_abort(self, callback: Callable[[], Any]) -> None:
        self._on_abort = callback

    def on_mic_toggle(self, callback: Callable[[bool], Any]) -> None:
        self._on_mic_toggle = callback

    def on_set_voice(self, callback: Callable[[bool], Any]) -> None:
        self._on_set_voice = callback

    async def start(self) -> None:
        """Start the bridge server on a separate thread."""
        ready = threading.Event()

        def _run_bridge():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._loop = loop
            loop.run_until_complete(self._start_server())
            ready.set()
            loop.run_forever()

        self._thread = threading.Thread(target=_run_bridge, daemon=True)
        self._thread.start()
        if not ready.wait(timeout=10):  # VOICE_BRIDGE_STARTUP_TIMEOUT
            raise RuntimeError("VoiceBridge failed to start within 10 seconds")
        logger.info(f"Voice bridge WebSocket running on port {self._port}")

    async def _start_server(self) -> None:
        self._app.router.add_get("/ws", self._ws_handler)

        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "0.0.0.0", self._port)
        await site.start()

    async def stop(self) -> None:
        if self._loop and self._runner:
            try:
                future = asyncio.run_coroutine_threadsafe(
                    self._runner.cleanup(), self._loop
                )
                future.result(timeout=5)  # VOICE_BRIDGE_SHUTDOWN_TIMEOUT
            except Exception:
                logger.exception("Error stopping bridge server")
        if self._loop:
            self._loop.call_soon_threadsafe(self._loop.stop)

    async def _ws_handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self._clients.add(ws)
        logger.info(f"Chat UI connected ({len(self._clients)} total)")
        # Send cached init messages to new client
        for msg in self._init_messages:
            try:
                await ws.send_str(json.dumps(msg))
            except Exception:
                logger.debug("Failed to send init message to new client")

        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        data = json.loads(msg.data)
                        await self._handle_message(data)
                    except json.JSONDecodeError:
                        logger.warning(f"Invalid JSON from chat UI: {msg.data[:100]}")
                    except Exception:
                        logger.exception("Error handling chat UI message")
                elif msg.type == aiohttp.WSMsgType.ERROR:
                    logger.error(f"WebSocket error: {ws.exception()}")
        finally:
            self._clients.discard(ws)
            logger.info(f"Chat UI disconnected ({len(self._clients)} total)")

        return ws

    async def _handle_message(self, data: dict) -> None:
        msg_type = data.get("type")
        if msg_type == "text_input" and self._on_text_input:
            text = data.get("text", "")
            if text:
                self._on_text_input(text)
        elif msg_type == "abort" and self._on_abort:
            self._on_abort()
        elif msg_type == "mic_toggle" and self._on_mic_toggle:
            enabled = data.get("enabled", True)
            self._on_mic_toggle(enabled)
        elif msg_type == "set_voice" and self._on_set_voice:
            enabled = data.get("enabled", True)
            self._on_set_voice(enabled)

    def _send_threadsafe(self, data: dict) -> None:
        """Schedule broadcast on the bridge's own event loop (non-blocking for caller)."""
        if self._loop is None:
            return
        future = asyncio.run_coroutine_threadsafe(self._broadcast(data), self._loop)
        def _check(f):
            exc = f.exception()
            if exc:
                logger.error(f"Broadcast failed: {exc}")
        future.add_done_callback(_check)

    async def _broadcast(self, data: dict) -> None:
        """Send JSON to all connected chat UIs (runs on bridge loop)."""
        if not self._clients:
            return
        text = json.dumps(data)
        for ws in list(self._clients):
            try:
                await ws.send_str(text)
            except Exception as e:
                logger.debug(f"Removing dead WebSocket client: {e}")
                self._clients.discard(ws)

    # Public API — all synchronous, fire-and-forget, thread-safe

    def broadcast(self, data: dict) -> None:
        self._send_threadsafe(data)

    def send_text_delta(self, text: str) -> None:
        self._send_threadsafe({"type": "text_delta", "text": text})

    def send_message_start(self) -> None:
        self._send_threadsafe({"type": "message_start"})

    def send_message_end(self) -> None:
        self._send_threadsafe({"type": "message_end"})

    def set_init_message(self, data: dict) -> None:
        """Cache a message to send to every new chat UI client on connect."""
        self._init_messages.append(data)

    def clear_init_messages(self) -> None:
        """Clear cached init messages."""
        self._init_messages.clear()
