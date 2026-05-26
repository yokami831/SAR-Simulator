"""HiyoCanvas CDP integration module.

Provides CDP (Chrome DevTools Protocol) based screenshot capture
and view control for visual verification of the HiyoCanvas UI.

Requires browser launched with --remote-debugging-port=9222.
All operations are optional — HiyoCanvas works without CDP.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import time
from pathlib import Path

import aiohttp

from backend.config import CDP_PORT, CDP_MAX_MSG_SIZE, LOCALHOST

logger = logging.getLogger(__name__)

SCREENSHOT_DIR = Path(__file__).parent.parent / "screenshots"


class CDPClient:
    """CDP WebSocket client (minimal implementation)."""

    def __init__(self, debug_port: int = CDP_PORT):
        self.debug_port = debug_port
        self._ws = None
        self._session: aiohttp.ClientSession | None = None
        self._msg_id = 0

    async def connect(self) -> None:
        """Connect to the first browser tab."""
        self._session = aiohttp.ClientSession()
        async with self._session.get(
            f"http://{LOCALHOST}:{self.debug_port}/json"
        ) as resp:
            tabs = await resp.json()

        if not tabs:
            raise ConnectionError("No browser tabs found")

        ws_url = tabs[0]["webSocketDebuggerUrl"]
        self._ws = await self._session.ws_connect(
            ws_url, max_msg_size=CDP_MAX_MSG_SIZE
        )

    async def send(self, method: str, params: dict | None = None) -> dict:
        """Send a CDP command and return the result.

        Raises ConnectionError on transport failure so callers can reconnect.
        """
        if self._ws is None or self._ws.closed:
            raise ConnectionError("CDP WebSocket is not connected")

        self._msg_id += 1
        msg: dict = {"id": self._msg_id, "method": method}
        if params:
            msg["params"] = params

        try:
            await self._ws.send_json(msg)
        except (ConnectionResetError, OSError) as e:
            raise ConnectionError(f"CDP send failed: {e}")

        while True:
            resp = await self._ws.receive_json()
            if resp.get("id") == self._msg_id:
                if "error" in resp:
                    raise RuntimeError(f"CDP error: {resp['error']}")
                return resp.get("result", {})

    async def evaluate(self, expression: str):
        """Execute JavaScript in the page and return the result value."""
        result = await self.send("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": True,
        })
        if result.get("exceptionDetails"):
            raise RuntimeError(
                f"JS error: {result['exceptionDetails']['text']}"
            )
        return result.get("result", {}).get("value")

    async def close(self) -> None:
        if self._ws:
            await self._ws.close()
        if self._session:
            await self._session.close()


class HiyoCanvasCDP:
    """HiyoCanvas-specific CDP operations."""

    def __init__(self, debug_port: int = CDP_PORT):
        self.cdp = CDPClient(debug_port)
        self._connected = False

    async def ensure_connected(self) -> None:
        # Check if existing connection is still alive
        if self._connected and self.cdp._ws is not None:
            if self.cdp._ws.closed:
                logger.info("CDP WebSocket closed, will reconnect")
                self._connected = False
                try:
                    await self.cdp.close()
                except Exception as e:
                    logger.debug("CDP close during reconnect: %s", e)

        if not self._connected:
            try:
                await self.cdp.connect()
                self._connected = True
                logger.info("CDP connected to port %d", self.cdp.debug_port)
            except Exception as e:
                raise ConnectionError(
                    f"CDP connection failed. Ensure browser is launched with "
                    f"--remote-debugging-port={self.cdp.debug_port}. Error: {e}"
                )

    async def screenshot_full(
        self,
        filename: str | None = None,
        output_dir: str | None = None,
    ) -> dict:
        """Full page screenshot."""
        await self.ensure_connected()
        save_dir = Path(output_dir) if output_dir else SCREENSHOT_DIR
        save_dir.mkdir(exist_ok=True)

        if not filename:
            filename = "full.png"

        filepath = save_dir / filename
        result = await self.cdp.send("Page.captureScreenshot", {
            "format": "png",
            "fromSurface": True,
            "captureBeyondViewport": False,
            "optimizeForSpeed": True,
        })
        png_bytes = base64.b64decode(result["data"])
        filepath.write_bytes(png_bytes)

        size = await self.cdp.evaluate(
            "JSON.parse(JSON.stringify({width: window.innerWidth, height: window.innerHeight}))"
        )

        return {
            "filepath": str(filepath),
            "width": size["width"],
            "height": size["height"],
            "size_bytes": len(png_bytes),
        }

    async def screenshot_node(
        self,
        node_id: str,
        filename: str | None = None,
        output_dir: str | None = None,
        padding: int = 20,
    ) -> dict:
        """Zoom into a specific node and capture screenshot.

        Takes a full-page screenshot then crops to the node region in Python
        to avoid CDP clip/scale viewport manipulation that causes flash in
        headful mode.
        """
        await self.ensure_connected()
        save_dir = Path(output_dir) if output_dir else SCREENSHOT_DIR
        save_dir.mkdir(exist_ok=True)

        # Verify node exists
        _nid = json.dumps(node_id)
        node_info = await self.cdp.evaluate(f"""
            (() => {{
                const rf = window.rfInstance;
                if (!rf) throw new Error('React Flow instance not found (window.rfInstance)');
                const node = rf.getNode({_nid});
                if (!node) throw new Error('Node not found: ' + {_nid});
                return JSON.parse(JSON.stringify({{
                    id: node.id,
                    blockType: node.data?.blockType || node.type,
                    position: node.position
                }}));
            }})()
        """)

        # fitView to zoom into node
        await self.cdp.evaluate(f"""
            window.rfInstance.fitView({{
                nodes: [{{ id: {_nid} }}],
                padding: 0.3,
                duration: 400
            }});
        """)
        await asyncio.sleep(0.5)

        # Get DOM bounding rect
        dom_rect = await self.cdp.evaluate(f"""
            (() => {{
                const nid = {_nid};
                const el = document.querySelector('[data-node-id="' + CSS.escape(nid) + '"]');
                if (!el) throw new Error('Node DOM element not found: ' + {_nid});
                const r = el.getBoundingClientRect();
                return JSON.parse(JSON.stringify({{
                    x: r.x, y: r.y, width: r.width, height: r.height
                }}));
            }})()
        """)

        # Full-page screenshot (no clip → no viewport manipulation → no flash)
        result = await self.cdp.send("Page.captureScreenshot", {
            "format": "png",
            "fromSurface": True,
            "captureBeyondViewport": False,
            "optimizeForSpeed": True,
        })
        full_png = base64.b64decode(result["data"])

        # Crop to node region in Python
        from PIL import Image
        img = Image.open(io.BytesIO(full_png))
        dpr = img.width / await self.cdp.evaluate("window.innerWidth")
        x1 = max(0, int((dom_rect["x"] - padding) * dpr))
        y1 = max(0, int((dom_rect["y"] - padding) * dpr))
        x2 = min(img.width, int((dom_rect["x"] + dom_rect["width"] + padding) * dpr))
        y2 = min(img.height, int((dom_rect["y"] + dom_rect["height"] + padding) * dpr))
        cropped = img.crop((x1, y1, x2, y2))

        if not filename:
            filename = "node.png"

        filepath = save_dir / filename
        cropped.save(filepath, "PNG")
        png_bytes = filepath.read_bytes()

        return {
            "filepath": str(filepath),
            "node_id": node_id,
            "block_type": node_info.get("blockType"),
            "dom_rect": dom_rect,
            "size_bytes": len(png_bytes),
        }

    async def screenshot_region(
        self,
        x: float,
        y: float,
        width: float,
        height: float,
        filename: str | None = None,
        output_dir: str | None = None,
    ) -> dict:
        """Screenshot a specific region.

        Takes a full-page screenshot then crops in Python to avoid flash.
        """
        await self.ensure_connected()
        save_dir = Path(output_dir) if output_dir else SCREENSHOT_DIR
        save_dir.mkdir(exist_ok=True)

        # Full-page screenshot (no clip → no flash)
        result = await self.cdp.send("Page.captureScreenshot", {
            "format": "png",
            "fromSurface": True,
            "captureBeyondViewport": False,
            "optimizeForSpeed": True,
        })
        full_png = base64.b64decode(result["data"])

        # Crop to requested region in Python
        from PIL import Image
        img = Image.open(io.BytesIO(full_png))
        dpr = img.width / await self.cdp.evaluate("window.innerWidth")
        x1 = max(0, int(x * dpr))
        y1 = max(0, int(y * dpr))
        x2 = min(img.width, int((x + width) * dpr))
        y2 = min(img.height, int((y + height) * dpr))
        cropped = img.crop((x1, y1, x2, y2))

        if not filename:
            filename = "region.png"

        filepath = save_dir / filename
        cropped.save(filepath, "PNG")
        png_bytes = filepath.read_bytes()

        return {
            "filepath": str(filepath),
            "clip": {"x": x, "y": y, "width": width, "height": height},
            "size_bytes": len(png_bytes),
        }

    async def _eval_with_reconnect(self, expression: str):
        """Evaluate JS expression, auto-reconnecting on transport errors."""
        try:
            return await self.cdp.evaluate(expression)
        except (ConnectionError, ConnectionResetError, OSError):
            await self._reconnect_and_retry_noop()
            return await self.cdp.evaluate(expression)

    async def _reconnect_and_retry_noop(self):
        """Reconnect CDP (helper for _eval_with_reconnect)."""
        logger.info("CDP reconnecting after transport error...")
        self._connected = False
        try:
            await self.cdp.close()
        except Exception as e:
            logger.debug("CDP close during reconnect: %s", e)
        self.cdp = CDPClient(self.cdp.debug_port)
        await self.ensure_connected()

    async def view_fit_all(self) -> dict:
        await self.ensure_connected()
        await self._eval_with_reconnect(
            "window.rfInstance.fitView({ padding: 0.2, duration: 400 });"
        )
        await asyncio.sleep(0.5)
        return {"action": "fit_all", "success": True}

    async def view_fit_node(self, node_id: str, padding: float = 0.3) -> dict:
        await self.ensure_connected()
        _nid = json.dumps(node_id)
        await self._eval_with_reconnect(f"""
            (() => {{
                const rf = window.rfInstance;
                if (!rf) throw new Error('React Flow instance not found');
                const node = rf.getNode({_nid});
                if (!node) throw new Error('Node not found: ' + {_nid});
                rf.fitView({{
                    nodes: [{{ id: {_nid} }}],
                    padding: {padding},
                    duration: 400
                }});
            }})()
        """)
        await asyncio.sleep(0.5)
        return {"action": "fit_node", "node_id": node_id, "success": True}

    async def view_zoom(self, level: float) -> dict:
        await self.ensure_connected()
        await self._eval_with_reconnect(
            f"window.rfInstance.zoomTo({json.dumps(level)}, {{ duration: 300 }});"
        )
        await asyncio.sleep(0.4)
        return {"action": "zoom", "level": level, "success": True}

    async def view_center(self, x: float, y: float) -> dict:
        await self.ensure_connected()
        await self._eval_with_reconnect(f"""
            window.rfInstance.setCenter({json.dumps(x)}, {json.dumps(y)}, {{ duration: 400, zoom: undefined }});
        """)
        await asyncio.sleep(0.5)
        return {"action": "center", "x": x, "y": y, "success": True}

    async def get_viewport_info(self) -> dict:
        await self.ensure_connected()
        return await self.cdp.evaluate("""
            (() => {
                const rf = window.rfInstance;
                if (!rf) throw new Error('React Flow instance not found');
                const viewport = rf.getViewport();
                const nodes = rf.getNodes();
                return JSON.parse(JSON.stringify({
                    viewport: viewport,
                    node_count: nodes.length,
                    window_size: {
                        width: window.innerWidth,
                        height: window.innerHeight
                    }
                }));
            })()
        """)

    async def get_cdp_status(self) -> dict:
        try:
            await self.ensure_connected()
            title = await self.cdp.evaluate("document.title")
            return {
                "connected": True,
                "page_title": title,
                "debug_port": self.cdp.debug_port,
            }
        except Exception as e:
            return {
                "connected": False,
                "error": str(e),
                "debug_port": self.cdp.debug_port,
                "hint": f"Launch browser with --remote-debugging-port={CDP_PORT}",
            }

    async def close(self) -> None:
        self._connected = False
        await self.cdp.close()


# Singleton
_instance: HiyoCanvasCDP | None = None


def get_cdp() -> HiyoCanvasCDP:
    global _instance
    if _instance is None:
        _instance = HiyoCanvasCDP()
    return _instance
