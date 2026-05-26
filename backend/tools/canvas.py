"""Canvas operations: block CRUD, connections, state, view, tooltips, subgraphs."""

from __future__ import annotations

import logging
from typing import Any

from backend.config import WS_COMMAND_TIMEOUT
from backend import block_registry, workspace_manager
from backend.tools.ws import send_command, broadcast_console_log

logger = logging.getLogger(__name__)


async def _cmd(action: str, success_msg: str = "", **params) -> dict[str, Any]:
    """Send a WebSocket command and return a standardized result."""
    try:
        result = await send_command({"action": action, **params})
    except Exception as e:
        return {"success": False, "message": f"Error: {e}"}
    if not result.get("success"):
        detail = result.get("error") or result.get("message") or "Unknown error"
        return {"success": False, "message": f"Error: {detail}"}
    msg = success_msg or f"{action} completed"
    return {"success": True, "message": msg, **{k: result[k] for k in result if k != "success"}}


# ===========================================================================
# V2 Node Operations (new)
# ===========================================================================



async def add_element(
    type: str,
    parameters: dict | None = None,
    position: dict | None = None,
) -> dict[str, Any]:
    """Add a node to the canvas."""
    result = await _cmd("add_element", "", block_type=type, parameters=parameters or {}, position=position)
    if not result.get("success"):
        return result
    node_id = result.get("node_id", "")
    label = (parameters or {}).get("label") or type
    return {"success": True, "message": f"Added: {label} ({node_id})", "node_id": node_id, "type": type}


async def remove_element(node_id: str) -> dict[str, Any]:
    """Remove a node (and its connected edges) from the canvas."""
    flowgraph = await get_flowgraph()
    nodes = flowgraph.get("nodes", [])
    if not any(n.get("id") == node_id for n in nodes):
        return {"success": False, "message": f"Error: Node '{node_id}' not found"}
    return await _cmd("remove_element", f"Removed: {node_id}", node_id=node_id)


async def get_element(node_id: str) -> dict[str, Any]:
    """Get detailed information about a specific node."""
    try:
        flowgraph = await get_flowgraph()
    except Exception as e:
        return {"success": False, "message": f"Error: {e}"}

    nodes = flowgraph.get("nodes", [])
    edges = flowgraph.get("edges", [])

    node = next((n for n in nodes if n.get("id") == node_id), None)
    if node is None:
        return {"success": False, "message": f"Error: Node '{node_id}' not found"}

    label = node.get("label", node_id)
    node_type = node.get("blockType") or node.get("type", "")
    enabled = node.get("enabled") is not False
    code_collapsed = node.get("codeCollapsed") is True
    pos = node.get("position", {})
    x = pos.get("x", 0)
    y = pos.get("y", 0)
    width = node.get("width")
    params = node.get("parameters", {})

    # Build edges info for this node
    output_edges: dict[str, list[str]] = {}
    for edge in edges:
        if edge.get("source") == node_id:
            src_port = edge.get("sourcePort", "out_0")
            tgt = edge.get("target", "")
            tgt_port = edge.get("targetPort", "in_0")
            output_edges.setdefault(src_port, []).append(f"{tgt}:{tgt_port}")

    # Use node's port definitions (from block schema), not just edges
    node_inputs = node.get("inputs", [])
    node_outputs = node.get("outputs", [])

    lines: list[str] = [
        f"Node: {label} ({node_id})",
        f"  Type: {node_type}",
        f"  Enabled: {'true' if enabled else 'false'}",
        f"  Code collapsed: {'true' if code_collapsed else 'false'}",
        f"  Position: ({x}, {y})",
        f"  Size: {width} x auto" if width else "  Size: auto x auto",
        "  Parameters:",
    ]

    for k, v in params.items():
        if isinstance(v, str) and "\n" in v:
            lines.append(f"    {k}: |")
            for line in v.splitlines():
                lines.append(f"      {line}")
        else:
            lines.append(f"    {k}: {v}")

    # Show input ports with connection info
    if node_inputs:
        input_parts = []
        for port in node_inputs:
            # Check if this input has an incoming edge
            incoming = [e for e in edges if e.get("target") == node_id and e.get("targetPort") == port]
            if incoming:
                src = incoming[0]
                input_parts.append(f"{port} ← {src.get('source')}:{src.get('sourcePort', 'out_0')}")
            else:
                input_parts.append(port)
        lines.append(f"  Inputs: {', '.join(input_parts)}")
    else:
        lines.append("  Inputs: (none)")

    # Show output ports with connection info
    if node_outputs:
        out_parts = []
        for port in node_outputs:
            targets = output_edges.get(port, [])
            if targets:
                out_parts.append(f"{port} → {', '.join(targets)}")
            else:
                out_parts.append(port)
        lines.append(f"  Outputs: {', '.join(out_parts)}")
    else:
        lines.append("  Outputs: (none)")

    return {"success": True, "message": "\n".join(lines)}


async def update_element(node_id: str, **kwargs: Any) -> dict[str, Any]:
    """Update one or more properties of a node.

    Supported kwargs: label, code, spec, enabled, code_collapsed, position, width, height, params
    The 'params' dict updates arbitrary node parameters via update_param WebSocket command.
    'spec' is the node's free-text description (the "Spec" panel in the UI).
    """
    # Validate node exists
    try:
        flowgraph = await get_flowgraph()
        nodes = flowgraph.get("nodes", [])
        if not any(n.get("id") == node_id for n in nodes):
            return {"success": False, "message": f"Error: Node '{node_id}' not found"}
    except Exception as e:
        return {"success": False, "message": f"Error: {e}"}

    changed: list[str] = []
    errors: list[str] = []

    # Reject unknown top-level fields instead of silently ignoring them. A
    # common mistake is passing GUI/node parameter values at the top level
    # (e.g. {"value": ...}) or wrapping code in "parameters" — those keys are
    # NOT applied here and used to return success with an empty change set,
    # masking the error. Fail loudly with a hint to the correct form.
    _KNOWN = {"label", "code", "spec", "enabled", "code_collapsed",
              "position", "width", "height", "params"}
    unknown = [k for k in kwargs if k not in _KNOWN]
    if unknown:
        hint = ""
        if "value" in unknown or "var_name" in unknown or "min" in unknown or "max" in unknown:
            hint = " — node parameter values go in params, e.g. params:{\"value\": ...}"
        elif "parameters" in unknown:
            hint = " — use top-level code/label, or params:{...} for node parameters (not 'parameters')"
        return {"success": False,
                "message": "Error: unknown field(s) %s for update_element. "
                           "Allowed: %s%s" % (sorted(unknown), sorted(_KNOWN), hint)}

    label = kwargs.get("label")
    code = kwargs.get("code")
    spec = kwargs.get("spec")
    enabled = kwargs.get("enabled")
    code_collapsed = kwargs.get("code_collapsed")
    position = kwargs.get("position")
    width = kwargs.get("width")
    height = kwargs.get("height")

    # params dict: update arbitrary parameters (e.g. var_name, value, min, max)
    params = kwargs.get("params")
    if params and isinstance(params, dict):
        for param_name, param_value in params.items():
            try:
                result = await send_command({
                    "action": "update_param",
                    "node_id": node_id,
                    "param": param_name,
                    "value": str(param_value) if param_value is not None else "",
                })
                if result.get("success"):
                    changed.append(param_name)
                else:
                    errors.append(f"{param_name}: {result.get('error', 'failed')}")
            except Exception as e:
                errors.append(f"{param_name}: {e}")

    # label, code and spec all use update_param (generic param write; the
    # frontend update_param handler stores any param into defaultParameters).
    for param_name, param_value in (("label", label), ("code", code), ("spec", spec)):
        if param_value is not None:
            try:
                result = await send_command({
                    "action": "update_param",
                    "node_id": node_id,
                    "param": param_name,
                    "value": param_value,
                })
                if result.get("success"):
                    changed.append(param_name)
                else:
                    errors.append(f"{param_name}: {result.get('error', 'failed')}")
            except Exception as e:
                errors.append(f"{param_name}: {e}")

    # enabled uses set_enabled
    if enabled is not None:
        try:
            result = await send_command({
                "action": "set_enabled",
                "node_id": node_id,
                "enabled": enabled,
            })
            if result.get("success"):
                changed.append("enabled")
            else:
                errors.append(f"enabled: {result.get('error', 'failed')}")
        except Exception as e:
            errors.append(f"enabled: {e}")

    # code_collapsed uses set_code_collapsed
    if code_collapsed is not None:
        try:
            result = await send_command({
                "action": "set_code_collapsed",
                "node_id": node_id,
                "collapsed": bool(code_collapsed),
            })
            if result.get("success"):
                changed.append("code_collapsed")
            else:
                errors.append(f"code_collapsed: {result.get('error', 'failed')}")
        except Exception as e:
            errors.append(f"code_collapsed: {e}")

    # position, width, height use update_node
    if any(v is not None for v in (position, width, height)):
        cmd: dict[str, Any] = {"action": "update_node", "node_id": node_id}
        field_names: list[str] = []
        if position is not None:
            cmd["position"] = position
            field_names.append("position")
        if width is not None:
            cmd["width"] = width
            field_names.append("width")
        if height is not None:
            cmd["height"] = height
            field_names.append("height")
        try:
            result = await send_command(cmd)
            if result.get("success"):
                changed.extend(field_names)
            else:
                errors.append(f"update_node: {result.get('error', 'failed')}")
        except Exception as e:
            errors.append(f"update_node: {e}")

    if errors and not changed:
        return {"success": False, "message": f"Error: {'; '.join(errors)}"}

    # Nothing was applied (no recognized field carried a value): report failure
    # rather than a misleading "Updated: nodeX ()" success. Callers relied on
    # the empty-change success and could not tell their update was a no-op.
    if not changed:
        return {"success": False,
                "message": "Error: update_element changed nothing for %s — "
                           "no recognized field had a value (pass code/label/"
                           "enabled/position/width/height at top level, or "
                           "params:{...} for node parameters)" % node_id}

    msg = f"Updated: {node_id} ({', '.join(changed)})"
    if errors:
        msg += f" [warnings: {'; '.join(errors)}]"

    return {"success": True, "message": msg}


async def get_elements(query: str | None = None) -> dict[str, Any]:
    """List all nodes (optionally filtered by label/type) plus edges and subgraphs."""
    try:
        flowgraph = await get_flowgraph()
    except Exception as e:
        return {"success": False, "message": f"Error: {e}"}

    nodes = flowgraph.get("nodes", [])
    edges = flowgraph.get("edges", [])
    subgraphs = flowgraph.get("subgraphs") or []

    # Filter nodes by query
    if query:
        q = query.lower()
        nodes = [
            n for n in nodes
            if q in n.get("label", "").lower()
            or q in (n.get("blockType") or "").lower()
        ]

    lines: list[str] = [f"Nodes ({len(nodes)}):"]
    for node in nodes:
        nid = node.get("id", "?")
        label = node.get("label", nid)
        ntype = node.get("blockType") or node.get("type", "")
        disabled_tag = " [DISABLED]" if node.get("enabled") is False else ""
        lines.append(f"  {nid}: {label} ({ntype}){disabled_tag}")

    lines.append(f"Edges ({len(edges)}):")
    for edge in edges:
        src = edge.get("source", "?")
        src_p = edge.get("sourcePort", "out_0")
        tgt = edge.get("target", "?")
        tgt_p = edge.get("targetPort", "in_0")
        lines.append(f"  {src}:{src_p} → {tgt}:{tgt_p}")

    if subgraphs:
        lines.append(f"Subgraphs ({len(subgraphs)}):")
        for sg in subgraphs:
            sgid = sg.get("id", "?")
            sglabel = sg.get("label", sgid)
            child_ids = sg.get("childNodeIds") or []
            children_str = f" [{', '.join(child_ids)}]" if child_ids else ""
            lines.append(f"  {sgid}: {sglabel}{children_str}")

    return {"success": True, "message": "\n".join(lines)}


# ===========================================================================
# V2 Edge Operations (replace old connect/disconnect)
# ===========================================================================


async def connect(
    source: str,
    source_port: str,
    target: str,
    target_port: str,
) -> dict[str, Any]:
    """Connect two blocks with an edge.

    Args:
        source: ID of the source block.
        source_port: Output port name on the source block.
        target: ID of the target block.
        target_port: Input port name on the target block.

    Returns:
        dict with success, message, and edge_id on success.
    """
    result = await _cmd("add_edge", f"Connected: {source}:{source_port} → {target}:{target_port}",
                        source=source, source_port=source_port, target=target, target_port=target_port)
    if not result.get("success"):
        return result
    edge_id = result.get("edge_id", "")
    if not edge_id:
        return {"success": False, "message": f"Error: Failed to create edge (check that nodes {source} and {target} exist)"}
    return {**result, "edge_id": edge_id}


async def disconnect(
    source: str | None = None,
    source_port: str | None = None,
    target: str | None = None,
    target_port: str | None = None,
    edge_id: str | None = None,
) -> dict[str, Any]:
    """Remove an edge between two blocks.

    Args:
        source: ID of the source block (required if edge_id not provided).
        source_port: Output port name on the source block.
        target: ID of the target block.
        target_port: Input port name on the target block.
        edge_id: Edge ID to remove directly (alternative to source/target params).

    Returns:
        dict with success and message.
    """
    if edge_id is not None:
        return await _cmd("remove_edge", f"Disconnected edge: {edge_id}", edge_id=edge_id)
    if source and source_port and target and target_port:
        return await _cmd("remove_edge", f"Disconnected: {source}:{source_port} → {target}:{target_port}",
                         source=source, source_port=source_port, target=target, target_port=target_port)
    return {"success": False, "message": "Error: provide either edge_id or all of source, source_port, target, target_port"}


# ===========================================================================
# State Retrieval
# ===========================================================================


async def get_flowgraph() -> dict:
    """Get the current flowgraph state from the frontend.

    Raises RuntimeError if the frontend fails to respond.
    """
    result = await send_command({"action": "get_elements"})
    if not result.get("success", True):
        raise RuntimeError(result.get("error", "Failed to get flowgraph state from frontend"))
    flowgraph = result.get("flowgraph")
    if flowgraph is None:
        raise RuntimeError("Frontend returned no flowgraph data")
    return flowgraph



# ===========================================================================
# Canvas Operations
# ===========================================================================


async def auto_layout() -> dict[str, Any]:
    """Apply automatic layout to canvas nodes."""
    return await _cmd("auto_layout", "Auto layout applied")


async def clear_canvas() -> dict[str, Any]:
    """Clear all nodes and edges from the canvas."""
    return await _cmd("clear", "Canvas cleared")


async def save_tab() -> dict[str, Any]:
    """Save the active tab (any type: flow, mindmap, excalidraw, notes).

    Detects the active tab type and saves via the appropriate mechanism:
    - flow: WebSocket get_save_data → workspace file
    - mindmap/excalidraw/notes: WebSocket tab_action get_elements → workspace file
    """
    from backend.tools.ws import send_command, get_active_tab_type
    from backend import workspace_manager

    # Get active tab info
    result = await send_command({"action": "list_tabs"})
    if not result.get("success"):
        return {"success": False, "message": "Failed to get tab info"}

    active_tab = None
    for tab in result.get("tabs", []):
        if tab.get("active"):
            active_tab = tab
            break

    if not active_tab:
        return {"success": False, "message": "No active tab"}

    tab_type = active_tab.get("type", "flow")
    filename = active_tab.get("workspace_file")
    title = active_tab.get("title", "Untitled")

    if not filename:
        return {"success": False, "message": f"Tab '{title}' has no workspace file"}

    if tab_type == "flow":
        # Flow tabs: get_save_data returns nodes/edges/viewport
        save_result = await send_command({"action": "get_save_data"})
        if not save_result.get("success"):
            return {"success": False, "message": save_result.get("error", "Failed to get save data")}
        save_data = save_result.get("save_data", {})
        workspace_manager.save_workspace(filename, {"canvas": save_data})
    else:
        # Plugin tabs (mindmap, excalidraw): get_elements returns typed data
        data_key_map = {"mindmap": "mindmapData", "excalidraw": "excalidrawData", "notes": "notesData"}
        data_key = data_key_map.get(tab_type)
        if not data_key:
            return {"success": False, "message": f"Unknown tab type: {tab_type}"}

        elements = await send_command({"action": "get_elements"})
        if not elements.get("success"):
            return {"success": False, "message": elements.get("error", "Failed to get tab data")}

        plugin_data = elements.get(data_key)
        if plugin_data is None:
            return {"success": False, "message": f"No {data_key} in response"}

        workspace_manager.save_workspace(filename, {data_key: plugin_data})

    return {"success": True, "message": f"Saved: {filename}"}


async def save_tab_as(new_title: str, description: str = "") -> dict[str, Any]:
    """Save the active tab as a new workspace with a different name.

    Creates a new workspace file, copies current canvas data into it,
    and updates the frontend tab to reference the new file.
    """
    from backend.tools.ws import send_command
    from backend import workspace_manager

    if not new_title or not new_title.strip():
        return {"success": False, "message": "new_title must not be empty"}

    # Get active tab info
    result = await send_command({"action": "list_tabs"})
    if not result.get("success"):
        return {"success": False, "message": "Failed to get tab info"}

    active_tab = None
    for tab in result.get("tabs", []):
        if tab.get("active"):
            active_tab = tab
            break

    if not active_tab:
        return {"success": False, "message": "No active tab"}

    tab_type = active_tab.get("type", "flow")

    # Create new workspace file
    try:
        ws = workspace_manager.create_workspace(tab_type, new_title.strip(), description)
    except ValueError as e:
        return {"success": False, "message": f"Failed to create workspace: {e}"}

    new_filename = ws["filename"]

    # Get current canvas data and save to new workspace
    if tab_type == "flow":
        save_result = await send_command({"action": "get_save_data"})
        if not save_result.get("success"):
            return {"success": False, "message": save_result.get("error", "Failed to get save data")}
        save_data = save_result.get("save_data", {})
        workspace_manager.save_workspace(new_filename, {"canvas": save_data})
    else:
        data_key_map = {"mindmap": "mindmapData", "excalidraw": "excalidrawData", "notes": "notesData"}
        data_key = data_key_map.get(tab_type)
        if not data_key:
            return {"success": False, "message": f"Unknown tab type: {tab_type}"}
        elements = await send_command({"action": "get_elements"})
        if not elements.get("success"):
            return {"success": False, "message": elements.get("error", "Failed to get tab data")}
        plugin_data = elements.get(data_key)
        if plugin_data is None:
            return {"success": False, "message": f"No {data_key} in response"}
        workspace_manager.save_workspace(new_filename, {data_key: plugin_data})

    # Update frontend tab to reference the new workspace file
    old_filename = active_tab.get("workspace_file", "")
    try:
        await send_command({
            "action": "rename_tab",
            "workspace_file": old_filename,
            "new_workspace_file": new_filename,
            "title": new_title.strip(),
        })
    except Exception as e:
        logger.warning("save_tab_as: failed to update frontend tab: %s", e)

    return {
        "success": True,
        "message": f"Saved as: {new_filename}",
        "filename": new_filename,
        "title": new_title.strip(),
    }


async def load_tab(filepath: str) -> dict[str, Any]:
    """Load a flowgraph from a file."""
    try:
        from backend.tools.file_io import load_flowgraph
        result = await load_flowgraph(filepath)
        path = result.get("filepath", filepath)
        num_nodes = result.get("num_nodes", 0)
        num_edges = result.get("num_edges", 0)
        return {"success": True, "message": f"Loaded: {path} ({num_nodes} nodes, {num_edges} edges)"}
    except Exception as e:
        return {"success": False, "message": f"Error: {e}"}


# ===========================================================================
# View Operations
# ===========================================================================


async def fit_all() -> dict[str, Any]:
    """Fit the viewport to show all nodes."""
    return await _cmd("fit_all", "Viewport fitted to all nodes")



async def fit_node(node_id: str) -> dict[str, Any]:
    """Fit the viewport to a specific node."""
    return await _cmd("fit_node", f"Viewport fitted to node: {node_id}", node_id=node_id)



async def zoom(level: float) -> dict[str, Any]:
    """Set viewport zoom level."""
    if level <= 0:
        return {"success": False, "message": f"Error: zoom level must be positive, got {level}"}
    return await _cmd("zoom", f"Zoom set to {level}", level=level)



async def get_viewport() -> dict[str, Any]:
    """Get current viewport information."""
    result = await _cmd("get_viewport", "Viewport info retrieved")
    if not result.get("success"):
        return result
    viewport = result.get("viewport", {})
    window = result.get("window_size", {})
    node_count = result.get("node_count", 0)
    msg = (
        f"Viewport: x={viewport.get('x', 0):.1f}, y={viewport.get('y', 0):.1f}, "
        f"zoom={viewport.get('zoom', 1):.2f} | "
        f"Window: {window.get('width', 0)}x{window.get('height', 0)} | "
        f"Nodes: {node_count}"
    )
    return {"success": True, "message": msg, "viewport": viewport, "window_size": window}


async def screenshot(mode: str = "full", node_id: str | None = None) -> dict[str, Any]:
    """Take a screenshot of the canvas.

    mode: 'full' for full page, 'node' to zoom into a specific node (requires node_id).
    Note: Uses CDP because screenshot requires browser-level screen capture.
    """
    try:
        from backend.cdp import get_cdp
        cdp = get_cdp()
        if mode == "node":
            if not node_id:
                return {"success": False, "message": "Error: node_id required for mode='node'"}
            result = await cdp.screenshot_node(node_id)
        else:
            result = await cdp.screenshot_full()
        filepath = result.get("filepath", "")
        size_bytes = result.get("size_bytes", 0)
        return {
            "success": True,
            "message": f"Screenshot: {filepath} ({size_bytes} bytes)",
            "filepath": filepath,
        }
    except Exception as e:
        return {"success": False, "message": f"Error: {e}"}


# ===========================================================================
# Tooltip Operations
# ===========================================================================


async def tooltip(node_id: str, text: str, type: str = "info") -> dict[str, Any]:
    """Show a tooltip on a node."""
    flowgraph = await get_flowgraph()
    nodes = flowgraph.get("nodes", [])
    if not any(n.get("id") == node_id for n in nodes):
        return {"success": False, "message": f"Error: Node '{node_id}' not found"}
    return await _cmd("show_tooltip", f"Tooltip: {node_id} ({type})",
                      node_id=node_id, text=text, type=type, highlight=True)



async def hide_tooltip(node_id: str) -> dict[str, Any]:
    """Hide the tooltip on a node."""
    return await _cmd("hide_tooltip", f"Hidden tooltip: {node_id}", node_id=node_id)


async def clear_tooltips() -> dict:
    """Clear all tooltips from the canvas."""
    return await _cmd("clear_tooltips", "All tooltips cleared")


# ===========================================================================
# Subgraph Operations
# ===========================================================================


async def create_subgraph(node_ids: list[str], label: str = "Group") -> dict[str, Any]:
    """Group a set of nodes into a subgraph."""
    if len(node_ids) < 2:
        return {"success": False, "message": "Error: At least 2 nodes required to create a subgraph"}
    result = await _cmd("create_subgraph", f"Created subgraph: {label}", node_ids=node_ids, label=label)
    if not result.get("success"):
        return result
    return {**result, "subgraph_id": result.get("subgraph_id", "")}


async def set_subgraph(
    subgraph_id: str,
    label: str | None = None,
    description: str | None = None,
    collapsed: bool | None = None,
) -> dict[str, Any]:
    """Update properties of an existing subgraph."""
    try:
        # Validate subgraph exists
        flowgraph = await get_flowgraph()
        subgraphs = flowgraph.get("subgraphs", [])
        if not any(sg.get("id") == subgraph_id for sg in subgraphs):
            return {"success": False, "message": f"Subgraph not found: {subgraph_id}"}

        changed = []

        if label is not None:
            r = await send_command({
                "action": "rename_subgraph",
                "subgraph_id": subgraph_id,
                "label": label,
            })
            if not r.get("success", True):
                return {"success": False, "message": f"Failed to rename subgraph: {r.get('error', 'unknown')}"}
            changed.append("label")

        if description is not None:
            r = await send_command({
                "action": "set_subgraph_description",
                "subgraph_id": subgraph_id,
                "description": description,
            })
            if not r.get("success", True):
                return {"success": False, "message": f"Failed to set description: {r.get('error', 'unknown')}"}
            changed.append("description")

        if collapsed is not None:
            # Re-fetch state: label/description updates above may have changed it
            flowgraph = await get_flowgraph()
            subgraphs = flowgraph.get("subgraphs", [])
            current_collapsed = None
            for sg in subgraphs:
                if sg.get("id") == subgraph_id:
                    current_collapsed = sg.get("collapsed", False)
                    break
            if current_collapsed != collapsed:
                r = await send_command({
                    "action": "toggle_collapse",
                    "subgraph_id": subgraph_id,
                })
                if not r.get("success", True):
                    return {"success": False, "message": f"Failed to toggle collapse: {r.get('error', 'unknown')}"}
            changed.append("collapsed")

        if not changed:
            return {"success": True, "message": f"No changes for subgraph: {subgraph_id}"}

        return {"success": True, "message": f"Updated subgraph: {subgraph_id} ({', '.join(changed)})"}

    except Exception as e:
        return {"success": False, "message": f"Error: {e}"}


async def ungroup_subgraph(subgraph_id: str) -> dict[str, Any]:
    """Dissolve a subgraph back into individual nodes."""
    try:
        flowgraph = await get_flowgraph()
    except Exception as e:
        return {"success": False, "message": f"Error: {e}"}
    subgraphs = flowgraph.get("subgraphs", [])
    if not any(sg.get("id") == subgraph_id for sg in subgraphs):
        return {"success": False, "message": f"Subgraph not found: {subgraph_id}"}
    return await _cmd("ungroup_subgraph", f"Ungrouped: {subgraph_id}", subgraph_id=subgraph_id)


# ===========================================================================
# Block Registry
# ===========================================================================


async def get_block_schema(type_id: str) -> dict[str, Any]:
    """Get the schema/definition of a block type."""
    try:
        block = block_registry.get_block(type_id)
        if block is None:
            return {"success": False, "message": f"Error: Block type not found: {type_id}"}

        lines = [
            f"Block: {block.get('id', type_id)}",
            f"  Label: {block.get('label', '?')}",
            f"  Category: {block.get('category', 'Uncategorized')}",
        ]
        if block.get("description"):
            lines.append(f"  Description: {block['description']}")

        params = block.get("parameters", [])
        if params:
            lines.append("  Parameters:")
            for p in params:
                p_id = p.get("id", "?")
                p_type = p.get("type", "str")
                p_default = p.get("default", "")
                p_label = p.get("label", p_id)
                lines.append(f"    {p_id} ({p_type}): {p_label} [default: {p_default!r}]")

        inputs = block.get("inputs", [])
        if inputs:
            lines.append("  Inputs:")
            for inp in inputs:
                lines.append(f"    {inp.get('id', '?')}: {inp.get('label', '')}")

        outputs = block.get("outputs", [])
        if outputs:
            lines.append("  Outputs:")
            for out in outputs:
                lines.append(f"    {out.get('id', '?')}: {out.get('label', '')}")

        return {"success": True, "message": "\n".join(lines)}
    except Exception as e:
        return {"success": False, "message": f"Error: {e}"}


async def register_block_v2(block_def: dict) -> dict[str, Any]:
    """Register a new block definition."""
    try:
        saved = block_registry.register(block_def)
        block_id = saved.get("id", "?")
        label = saved.get("label", "?")
        return {"success": True, "message": f"Registered: {block_id} ({label})"}
    except Exception as e:
        return {"success": False, "message": f"Error: {e}"}


async def get_tab_contents(max_chars: int | None = None) -> dict[str, Any]:
    """Get contents of the active tab, auto-detecting tab type.

    Args:
        max_chars: When provided and tab is a flow, include code snippets truncated
                   to max_chars per node (0 = omit code, -1 = full code, positive = truncate).
                   When None, return element list without code snippets.
    """
    from backend.tools.ws import get_active_tab_type, send_command

    tab_type = await get_active_tab_type()
    if not tab_type:
        return {"success": False, "message": "Error: No active tab (frontend not connected?)"}

    if tab_type == "flow":
        if max_chars is not None:
            # Include code snippets (logic from former get_canvas)
            try:
                flowgraph = await get_flowgraph()

                nodes = flowgraph.get("nodes", [])
                edges = flowgraph.get("edges", [])
                subgraphs = flowgraph.get("subgraphs", [])

                lines = [f"Canvas: {len(nodes)} nodes, {len(edges)} edges"]
                if subgraphs:
                    lines[0] += f", {len(subgraphs)} subgraph(s)"

                if nodes:
                    lines.append("Nodes:")
                    for node in nodes:
                        node_id = node.get("id", "?")
                        block_type = node.get("blockType", node.get("type", "?"))
                        label = node.get("label", "")
                        pos = node.get("position", {})
                        x = pos.get("x", 0)
                        y = pos.get("y", 0)
                        disabled = " [DISABLED]" if node.get("enabled") is False else ""
                        lines.append(f"  {node_id}: {label} ({block_type}){disabled} at ({x:.0f}, {y:.0f})")

                        if max_chars != 0:
                            params = node.get("parameters", {})
                            code = params.get("code", "")
                            if code:
                                if max_chars == -1:
                                    lines.append(f"    code: {code}")
                                elif len(code) > max_chars:
                                    lines.append(f"    code: {code[:max_chars]}... (truncated)")
                                else:
                                    lines.append(f"    code: {code}")

                if edges:
                    lines.append("Edges:")
                    for edge in edges:
                        src = edge.get("source", "?")
                        src_port = edge.get("sourcePort", "out_0")
                        tgt = edge.get("target", "?")
                        tgt_port = edge.get("targetPort", "in_0")
                        lines.append(f"  {src}:{src_port} → {tgt}:{tgt_port}")

                result = {"success": True, "message": "\n".join(lines)}
            except Exception as e:
                result = {"success": False, "message": f"Error: {e}"}
        else:
            result = await get_elements()
        result["tab_type"] = "flow"
        return result

    if tab_type == "mindmap":
        result = await send_command({"action": "get_elements"})
        if not result.get("success"):
            return {"success": False, "message": f"Error: {result.get('error', 'Failed to get mindmap')}", "tab_type": "mindmap"}
        return {"success": True, "tab_type": "mindmap", **result}

    # Unknown plugin tab — try unified get_elements action
    result = await send_command({"action": "get_elements"})
    if result.get("success"):
        return {"success": True, "tab_type": tab_type, **result}
    return {"success": False, "message": f"Tab type '{tab_type}' does not support get_tab_contents", "tab_type": tab_type}


async def search_block_types(query: str) -> dict[str, Any]:
    """Search block types by keyword."""
    try:
        results = block_registry.search(query)
        if not results:
            return {"success": True, "message": f"No blocks found matching: {query!r}"}

        lines = [f"Found {len(results)} block(s) matching {query!r}:"]
        for block in sorted(results, key=lambda b: b.get("label", "")):
            block_id = block.get("id", "?")
            label = block.get("label", "?")
            category = block.get("category", "")
            desc = block.get("description", "")
            cat_str = f" [{category}]" if category else ""
            desc_str = f" - {desc}" if desc else ""
            lines.append(f"  {block_id}: {label}{cat_str}{desc_str}")

        return {"success": True, "message": "\n".join(lines)}
    except Exception as e:
        return {"success": False, "message": f"Error: {e}"}

