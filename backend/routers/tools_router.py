"""Tool API endpoints for AI agents (/api/tools/*).

Thin routing layer that delegates to tools.py functions.
"""

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from backend import tools
from backend import block_registry
from backend.utils import require_keys as _require_keys

router = APIRouter(prefix="/api/tools", tags=["tools"])


async def _require_flow_tab() -> None:
    """Raise HTTPException if the active tab is not a flow tab.

    If no frontend is connected (tab_type is None), the guard passes
    through so that the downstream command can report its own error.
    """
    try:
        tab_type = await tools.get_active_tab_type()
    except Exception:
        return  # No frontend connected — let downstream handle it
    if tab_type and tab_type != "flow":
        raise HTTPException(
            400,
            f"This command requires a Flow tab, but active tab is '{tab_type}'. "
            "Use switch_tab to switch to a Flow tab first.",
        )


# --- State Retrieval ---


@router.post("/clear")
async def clear() -> JSONResponse:
    await _require_flow_tab()
    result = await tools.clear_canvas()
    return JSONResponse(content=result)


@router.post("/auto_layout")
async def auto_layout() -> JSONResponse:
    await _require_flow_tab()
    result = await tools.auto_layout()
    return JSONResponse(content=result)


@router.get("/block_schema/{block_type}")
async def block_schema(block_type: str) -> JSONResponse:
    await _require_flow_tab()
    result = await tools.get_block_schema(block_type)
    return JSONResponse(content=result)


@router.post("/get_block_schema")
async def get_block_schema_post(req: dict) -> JSONResponse:
    await _require_flow_tab()
    _require_keys(req, "type_id")
    result = await tools.get_block_schema(req["type_id"])
    return JSONResponse(content=result)


@router.post("/register_block")
async def register_block(req: dict) -> JSONResponse:
    await _require_flow_tab()
    try:
        result = block_registry.register(req)
        return JSONResponse(content={"success": True, "block": result})
    except ValueError as e:
        raise HTTPException(400, str(e))


# --- Errors & Logs ---


@router.post("/get_console_logs")
async def get_console_logs_post(req: dict = {}) -> JSONResponse:
    result = await tools.get_console_logs_formatted(limit=req.get("limit", 20))
    return JSONResponse(content=result)


@router.post("/get_frontend_errors")
async def get_frontend_errors_post(req: dict = {}) -> JSONResponse:
    result = await tools.get_frontend_errors_formatted()
    return JSONResponse(content=result)


@router.post("/clear_logs")
async def clear_logs() -> JSONResponse:
    result = await tools.clear_logs()
    return JSONResponse(content=result)


# --- File Operations ---


@router.post("/save_tab")
async def save_tab(req: dict = {}) -> JSONResponse:
    result = await tools.save_tab()
    return JSONResponse(content=result)


@router.post("/save_tab_as")
async def save_tab_as(req: dict) -> JSONResponse:
    _require_keys(req, "new_title")
    result = await tools.save_tab_as(
        new_title=req["new_title"],
        description=req.get("description", ""),
    )
    return JSONResponse(content=result)


@router.post("/load_tab")
async def load_tab(req: dict) -> JSONResponse:
    _require_keys(req, "filepath")
    result = await tools.load_tab(req["filepath"])
    return JSONResponse(content=result)


@router.post("/batch")
async def batch(req: dict) -> JSONResponse:
    await _require_flow_tab()
    _require_keys(req, "operations")
    result = await tools.run_batch(req["operations"])
    return JSONResponse(content=result)


# --- Execution ---


@router.post("/run_node")
async def run_node(req: dict) -> JSONResponse:
    await _require_flow_tab()
    _require_keys(req, "node_id")
    result = await tools.run_single_node(node_id=req["node_id"])
    return JSONResponse(content=result)


@router.post("/start_execution")
async def start_execution() -> JSONResponse:
    await _require_flow_tab()
    result = await tools.start_execution()
    return JSONResponse(content=result)


@router.post("/stop_execution")
async def stop_execution() -> JSONResponse:
    await _require_flow_tab()
    result = await tools.stop_execution()
    return JSONResponse(content=result)


@router.post("/step_start")
async def step_start() -> JSONResponse:
    await _require_flow_tab()
    result = await tools.step_start()
    return JSONResponse(content=result)


@router.post("/step_next")
async def step_next() -> JSONResponse:
    await _require_flow_tab()
    result = await tools.step_next()
    return JSONResponse(content=result)


@router.post("/step_reset")
async def step_reset() -> JSONResponse:
    await _require_flow_tab()
    result = await tools.step_reset()
    return JSONResponse(content=result)


@router.post("/run_remaining")
async def run_remaining() -> JSONResponse:
    await _require_flow_tab()
    result = await tools.run_remaining()
    return JSONResponse(content=result)


# --- Tab Operations (legacy aliases for workspace endpoints) ---


@router.get("/tabs")
async def list_tabs() -> JSONResponse:
    result = await tools.get_tabs()
    return JSONResponse(content=result)


@router.post("/open_flow_tab")
async def open_flow_tab(req: dict = None) -> JSONResponse:
    req = req or {}
    result = await tools.open_tab(
        filename=req.get("workspace_file"),
        title=req.get("title", "New Flow"),
    )
    return JSONResponse(content=result)


@router.post("/switch_tab")
async def switch_tab(req: dict) -> JSONResponse:
    _require_keys(req, "tab_id")
    result = await tools.switch_tab(req["tab_id"])
    return JSONResponse(content=result)


@router.post("/close_tab")
async def close_tab(req: dict) -> JSONResponse:
    _require_keys(req, "tab_id")
    result = await tools.close_tab(req["tab_id"])
    return JSONResponse(content=result)


# --- Tooltips ---


@router.post("/tooltip")
async def tooltip_endpoint(req: dict) -> JSONResponse:
    await _require_flow_tab()
    _require_keys(req, "node_id", "text")
    result = await tools.tooltip(
        node_id=req["node_id"],
        text=req["text"],
        type=req.get("type", "info"),
    )
    return JSONResponse(content=result)


@router.post("/hide_tooltip")
async def hide_tooltip(req: dict) -> JSONResponse:
    await _require_flow_tab()
    _require_keys(req, "node_id")
    result = await tools.hide_tooltip(req["node_id"])
    return JSONResponse(content=result)


@router.post("/clear_tooltips")
async def clear_tooltips() -> JSONResponse:
    await _require_flow_tab()
    result = await tools.clear_tooltips()
    return JSONResponse(content=result)


# --- Node & Canvas Operations ---


@router.post("/get_element")
async def get_element(req: dict) -> JSONResponse:
    await _require_flow_tab()
    _require_keys(req, "node_id")
    result = await tools.get_element(req["node_id"])
    return JSONResponse(content=result)


@router.post("/update_element")
async def update_element(req: dict) -> JSONResponse:
    await _require_flow_tab()
    _require_keys(req, "node_id")
    node_id = req["node_id"]
    params = {k: v for k, v in req.items() if k != "node_id"}
    result = await tools.update_element(node_id=node_id, **params)
    return JSONResponse(content=result)


@router.post("/get_elements")
async def get_elements(req: dict = {}) -> JSONResponse:
    await _require_flow_tab()
    result = await tools.get_elements(query=req.get("query"))
    return JSONResponse(content=result)


@router.post("/add_element")
async def add_element(req: dict) -> JSONResponse:
    await _require_flow_tab()
    _require_keys(req, "type")
    # Auto-lift common fields from top-level into parameters for convenience
    _KNOWN_TOP_KEYS = {"type", "parameters", "position"}
    _PARAM_FIELDS = {"code", "label"}
    params = dict(req.get("parameters") or {})
    lifted = []
    unknown = []
    for key in list(req.keys()):
        if key in _KNOWN_TOP_KEYS:
            continue
        if key in _PARAM_FIELDS:
            if key not in params:  # don't override explicit parameters
                params[key] = req[key]
                lifted.append(key)
        else:
            unknown.append(key)
    if unknown:
        raise HTTPException(400, f"Unknown field(s) for add_element: {', '.join(unknown)}. "
                            f"Did you mean to put them inside 'parameters'?")
    result = await tools.add_element(type=req["type"], parameters=params or None, position=req.get("position"))
    if result.get("success") and lifted:
        result["message"] = result.get("message", "") + f" (auto-lifted {', '.join(lifted)} into parameters)"
    return JSONResponse(content=result)


@router.post("/remove_element")
async def remove_element(req: dict) -> JSONResponse:
    await _require_flow_tab()
    _require_keys(req, "node_id")
    result = await tools.remove_element(node_id=req["node_id"])
    return JSONResponse(content=result)


@router.post("/connect")
async def connect(req: dict) -> JSONResponse:
    await _require_flow_tab()
    _require_keys(req, "source", "source_port", "target", "target_port")
    result = await tools.connect(
        source=req["source"], source_port=req["source_port"],
        target=req["target"], target_port=req["target_port"],
    )
    return JSONResponse(content=result)


@router.post("/disconnect")
async def disconnect(req: dict) -> JSONResponse:
    await _require_flow_tab()
    if "edge_id" in req:
        result = await tools.disconnect(edge_id=req["edge_id"])
    else:
        _require_keys(req, "source", "source_port", "target", "target_port")
        result = await tools.disconnect(
            source=req["source"], source_port=req["source_port"],
            target=req["target"], target_port=req["target_port"],
        )
    return JSONResponse(content=result)


@router.post("/get_viewport")
async def get_viewport(req: dict = {}) -> JSONResponse:
    result = await tools.get_viewport()
    return JSONResponse(content=result)


@router.post("/screenshot")
async def screenshot(req: dict = {}) -> JSONResponse:
    result = await tools.screenshot(mode=req.get("mode", "full"), node_id=req.get("node_id"))
    return JSONResponse(content=result)


@router.post("/open_tab")
async def open_tab(req: dict) -> JSONResponse:
    result = await tools.open_tab(title=req.get("title"), filename=req.get("filename"), workspace_type=req.get("type", "flow"))
    return JSONResponse(content=result)


@router.post("/get_tab_contents")
async def get_tab_contents_endpoint(req: dict = {}) -> JSONResponse:
    result = await tools.get_tab_contents(max_chars=req.get("max_chars"))
    return JSONResponse(content=result)


@router.post("/get_tabs")
async def get_tabs(req: dict = {}) -> JSONResponse:
    result = await tools.get_tabs()
    return JSONResponse(content=result)


@router.post("/list_saved")
async def list_saved(req: dict = {}) -> JSONResponse:
    result = await tools.list_saved()
    return JSONResponse(content=result)


@router.post("/delete_tab")
async def delete_tab(req: dict) -> JSONResponse:
    _require_keys(req, "filename")
    result = await tools.delete_tab(filename=req["filename"])
    return JSONResponse(content=result)


@router.post("/rename_tab")
async def rename_tab(req: dict) -> JSONResponse:
    _require_keys(req, "filename", "new_title")
    result = await tools.rename_tab(filename=req["filename"], new_title=req["new_title"])
    return JSONResponse(content=result)


@router.post("/set_subgraph")
async def set_subgraph(req: dict) -> JSONResponse:
    await _require_flow_tab()
    _require_keys(req, "subgraph_id")
    result = await tools.set_subgraph(subgraph_id=req["subgraph_id"], label=req.get("label"), description=req.get("description"), collapsed=req.get("collapsed"))
    return JSONResponse(content=result)


@router.post("/create_subgraph")
async def create_subgraph(req: dict) -> JSONResponse:
    await _require_flow_tab()
    _require_keys(req, "node_ids")
    result = await tools.create_subgraph(node_ids=req["node_ids"], label=req.get("label", "Group"))
    return JSONResponse(content=result)


@router.post("/ungroup_subgraph")
async def ungroup_subgraph(req: dict) -> JSONResponse:
    await _require_flow_tab()
    _require_keys(req, "subgraph_id")
    result = await tools.ungroup_subgraph(subgraph_id=req["subgraph_id"])
    return JSONResponse(content=result)


@router.post("/fit_all")
async def fit_all(req: dict = {}) -> JSONResponse:
    await _require_flow_tab()
    result = await tools.fit_all()
    return JSONResponse(content=result)


@router.post("/fit_node")
async def fit_node(req: dict) -> JSONResponse:
    await _require_flow_tab()
    _require_keys(req, "node_id")
    result = await tools.fit_node(node_id=req["node_id"])
    return JSONResponse(content=result)


@router.post("/zoom")
async def zoom(req: dict) -> JSONResponse:
    _require_keys(req, "level")
    result = await tools.zoom(level=req["level"])
    return JSONResponse(content=result)


@router.post("/search_block_types")
async def search_block_types(req: dict) -> JSONResponse:
    await _require_flow_tab()
    _require_keys(req, "query")
    result = await tools.search_block_types(query=req["query"])
    return JSONResponse(content=result)


@router.post("/frontend_status")
async def frontend_status(req: dict = {}) -> JSONResponse:
    result = await tools.get_frontend_status()
    return JSONResponse(content=result)


@router.post("/get_execution_status")
async def get_execution_status(req: dict = {}) -> JSONResponse:
    await _require_flow_tab()
    result = await tools.get_execution_status()
    return JSONResponse(content=result)


@router.post("/get_execution_result")
async def get_execution_result(req: dict) -> JSONResponse:
    await _require_flow_tab()
    _require_keys(req, "node_id")
    result = await tools.get_execution_result(req["node_id"], max_lines=req.get("max_lines", 50))
    return JSONResponse(content=result)


# --- Server Control ---


@router.post("/reload")
async def reload() -> JSONResponse:
    result = await tools.reload_frontend()
    return JSONResponse(content=result)


@router.post("/shutdown")
async def shutdown() -> JSONResponse:
    result = await tools.shutdown_server()
    return JSONResponse(content=result)


# --- Modal Dialog ---


@router.post("/get_modal_state")
async def get_modal_state(req: dict = {}) -> JSONResponse:
    result = await tools.send_command({"action": "get_modal_state"})
    return JSONResponse(content=result if result else {"success": False, "error": "No response from frontend"})


@router.post("/dismiss_modal")
async def dismiss_modal(req: dict = {}) -> JSONResponse:
    _require_keys(req, "button")
    result = await tools.send_command({"action": "dismiss_modal", "button": req["button"]})
    return JSONResponse(content=result if result else {"success": False, "error": "No response from frontend"})


# --- Plugin Tab Actions ---


@router.post("/tab_action")
async def tab_action_endpoint(req: dict):
    """Forward a tool action to the frontend via WebSocket for plugin tab handling."""
    if "action" not in req:
        return JSONResponse(content={"success": False, "error": "Missing 'action' field"}, status_code=400)
    result = await tools.send_command(req)
    return JSONResponse(content=result if result else {"success": False, "error": "No response from frontend"})
