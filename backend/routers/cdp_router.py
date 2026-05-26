"""CDP (Chrome DevTools Protocol) API endpoints (/api/cdp/*).

Screenshot capture and view control via browser DevTools.
"""

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from backend.cdp import get_cdp

router = APIRouter(prefix="/api/cdp", tags=["cdp"])


@router.get("/status")
async def status() -> JSONResponse:
    return JSONResponse(content=await get_cdp().get_cdp_status())


@router.post("/screenshot")
async def screenshot(req: dict) -> JSONResponse:
    cdp = get_cdp()
    mode = req.get("mode", "full")

    try:
        if mode == "full":
            result = await cdp.screenshot_full(
                filename=req.get("filename"),
                output_dir=req.get("output_dir"),
            )
        elif mode == "node":
            node_id = req.get("node_id")
            if not node_id:
                raise HTTPException(400, "node_id is required for mode='node'")
            result = await cdp.screenshot_node(
                node_id=node_id,
                filename=req.get("filename"),
                output_dir=req.get("output_dir"),
                padding=req.get("padding", 20),
            )
        elif mode == "region":
            for key in ("x", "y", "width", "height"):
                if key not in req:
                    raise HTTPException(400, f"{key} is required for mode='region'")
            result = await cdp.screenshot_region(
                x=req["x"], y=req["y"],
                width=req["width"], height=req["height"],
                filename=req.get("filename"),
                output_dir=req.get("output_dir"),
            )
        else:
            raise HTTPException(400, f"Unknown mode: {mode}")
    except ConnectionError as e:
        raise HTTPException(503, str(e))
    except RuntimeError as e:
        detail = str(e)
        if "Node not found" in detail:
            raise HTTPException(404, detail)
        raise HTTPException(500, detail)

    return JSONResponse(content=result)


@router.post("/view")
async def view(req: dict) -> JSONResponse:
    cdp = get_cdp()
    action = req.get("action")

    try:
        if action == "fit_all":
            result = await cdp.view_fit_all()
        elif action == "fit_node":
            node_id = req.get("node_id")
            if not node_id:
                raise HTTPException(400, "node_id is required")
            result = await cdp.view_fit_node(node_id, padding=req.get("padding", 0.3))
        elif action == "zoom":
            level = req.get("level")
            if level is None:
                raise HTTPException(400, "level is required")
            result = await cdp.view_zoom(level)
        elif action == "center":
            if "x" not in req or "y" not in req:
                raise HTTPException(400, "x and y are required")
            result = await cdp.view_center(req["x"], req["y"])
        else:
            raise HTTPException(400, f"Unknown action: {action}")
    except ConnectionError as e:
        raise HTTPException(503, str(e))
    except RuntimeError as e:
        detail = str(e)
        if "Node not found" in detail:
            raise HTTPException(404, detail)
        raise HTTPException(500, detail)

    return JSONResponse(content=result)


@router.get("/viewport")
async def viewport() -> JSONResponse:
    try:
        result = await get_cdp().get_viewport_info()
    except ConnectionError as e:
        raise HTTPException(503, str(e))
    return JSONResponse(content=result)


@router.post("/send_chat")
async def send_chat(req: dict) -> JSONResponse:
    """Send a text message to RINA via the chat UI (CDP).

    Simulates user typing into the chat textarea and clicking send.
    The message appears in the chat UI just like a real user message.
    """
    text = req.get("text", "").strip()
    if not text:
        raise HTTPException(400, "text is required")

    # Normalize newlines to spaces — chat messages don't need line breaks,
    # and newlines can cause truncation in the voice-agent pipeline.
    text = " ".join(text.split())

    cdp = get_cdp()
    # Escape for JS template literal
    escaped = text.replace("\\", "\\\\").replace("`", "\\`").replace("$", "\\$")
    js = f"""
    (() => {{
        const ta = document.querySelector('.chat-textarea');
        if (!ta) return {{ success: false, error: 'Chat textarea not found' }};
        const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
        ).set;
        nativeSetter.call(ta, `{escaped}`);
        ta.dispatchEvent(new Event('input', {{ bubbles: true }}));
        const btn = document.querySelector('.chat-send-btn');
        if (!btn) return {{ success: false, error: 'Send button not found' }};
        if (btn.disabled) return {{ success: false, error: 'Send button is disabled (RINA may be streaming)' }};
        btn.click();
        return {{ success: true }};
    }})()
    """
    try:
        result = await cdp._eval_with_reconnect(js)
    except ConnectionError as e:
        raise HTTPException(503, str(e))

    if isinstance(result, dict) and not result.get("success"):
        raise HTTPException(400, result.get("error", "Unknown error"))
    return JSONResponse(content=result)


@router.post("/get_chat")
async def get_chat(req: dict) -> JSONResponse:
    """Read chat messages from the chat UI (CDP).

    Returns the last N messages from the chat panel.
    """
    count = req.get("count", 1)

    cdp = get_cdp()
    js = f"""
    (() => {{
        const rows = document.querySelectorAll('.chat-bubble-row');
        const messages = [];
        const start = Math.max(0, rows.length - {count});
        for (let i = start; i < rows.length; i++) {{
            const row = rows[i];
            const isUser = row.classList.contains('user');
            const textEl = row.querySelector('.chat-bubble-text');
            const text = textEl ? textEl.textContent : '';
            messages.push({{ role: isUser ? 'user' : 'assistant', content: text }});
        }}
        return {{ success: true, messages, total: rows.length }};
    }})()
    """
    try:
        result = await cdp._eval_with_reconnect(js)
    except ConnectionError as e:
        raise HTTPException(503, str(e))

    return JSONResponse(content=result)
