"""Execution control: run/stop flowgraph, status, node results, step execution."""

from __future__ import annotations

import logging
import time

from backend import plugin_manager, block_registry
from backend.code_utils import build_node_code
from backend.config import OUTPUT_TRUNCATE_FULL, RESULT_VALUE_TRUNCATE
from backend.tools.canvas import get_flowgraph
from backend.tools.ws import send_command, _ws_broadcast

logger = logging.getLogger(__name__)


def _get_active_plugin():
    """Get the plugin for the currently active tab."""
    # TODO: Resolve plugin dynamically based on active tab type
    return plugin_manager.get("python")


async def start_execution() -> dict:
    """Run the current flowgraph. Auto-stops if already running."""
    plugin = _get_active_plugin()
    if plugin is None:
        return {"success": False, "message": "Error: No Python plugin available"}

    if plugin.is_running:
        await plugin.stop()

    state = await send_command({"action": "get_elements"})
    flowgraph = state.get("flowgraph", {"nodes": [], "edges": []})
    nodes = flowgraph.get("nodes", [])
    if not nodes:
        return {"success": False, "message": "Error: No nodes in flowgraph"}

    await plugin.run(flowgraph)
    return {"success": True, "message": f"Flow execution started ({len(nodes)} nodes)"}



async def stop_execution() -> dict:
    """Stop flow execution."""
    plugin = _get_active_plugin()
    if plugin is not None:
        await plugin.stop()
    return {"success": True, "message": "Flow execution stopped"}




async def get_execution_status() -> dict:
    """Get current execution status with per-node results."""
    plugin = _get_active_plugin()
    if plugin is None:
        return {"success": False, "message": "Error: No Python plugin available"}

    status_dict = await plugin.get_status()
    status = status_dict.get("status", "unknown")
    total_time = status_dict.get("total_time", 0)
    node_results = status_dict.get("node_results", {})

    # Get node labels from frontend
    fg_result = await send_command({"action": "get_elements"})
    flowgraph = fg_result.get("flowgraph", {"nodes": [], "edges": []})
    node_labels = {
        n["id"]: n.get("label", n["id"])
        for n in flowgraph.get("nodes", [])
    }

    lines = [f"Status: {status} ({total_time:.2f}s)"]
    for node_id, result in node_results.items():
        label = node_labels.get(node_id, node_id)
        node_status = result.get("status", "unknown")
        node_time = result.get("execution_time", 0)

        if node_status == "skipped":
            lines.append(f"  {node_id}: {label} — SKIPPED [DISABLED]")
        elif node_status == "cancelled":
            lines.append(f"  {node_id}: {label} — CANCELLED (upstream error)")
        elif node_status == "error":
            error_msg = result.get("error", "")
            first_line = error_msg.splitlines()[0] if error_msg else ""
            lines.append(f"  {node_id}: {label} — ERROR ({node_time:.2f}s): {first_line}")
        else:
            lines.append(f"  {node_id}: {label} — OK ({node_time:.2f}s)")

    return {
        "success": True,
        "message": "\n".join(lines),
        "status": status,
        "node_count": len(node_results),
    }


async def get_execution_result(node_id: str, max_lines: int = 50) -> dict:
    """Get detailed execution result for a specific node.

    Reads directly from the frontend node state (what is displayed on the node),
    ensuring API results always match the visual display.
    """
    fg_result = await send_command({"action": "get_elements"})
    flowgraph = fg_result.get("flowgraph", {"nodes": [], "edges": []})

    node = None
    for n in flowgraph.get("nodes", []):
        if n["id"] == node_id:
            node = n
            break
    if not node:
        return {"success": False, "message": f"Error: Node '{node_id}' not found"}

    label = node.get("label", node_id)
    status = node.get("executionStatus")
    if not status:
        return {"success": False, "message": f"Error: No execution result for node '{label}' ({node_id})"}

    output = node.get("executionOutput", "")
    error = node.get("executionError", "")
    exec_time = node.get("executionTime", 0)
    result_value = node.get("resultValue", "")

    ok_or_error = "ERROR" if status == "error" else "OK"
    lines = [f"Result: {label} ({node_id}) — {ok_or_error} ({exec_time:.2f}s)"]

    if output:
        output_lines = output.splitlines()
        if len(output_lines) > max_lines:
            extra = len(output_lines) - max_lines
            output_lines = output_lines[:max_lines]
            output_lines.append(f"... ({extra} more lines)")
        lines.append("Output:")
        lines.extend(f"  {l}" for l in output_lines)

    if error:
        lines.append("Error:")
        lines.extend(f"  {l}" for l in error.splitlines())

    if result_value:
        lines.append(f"Result value: {result_value}")

    return {"success": True, "message": "\n".join(lines)}


async def step_start() -> dict:
    """Start step-by-step execution of the current flowgraph."""
    plugin = _get_active_plugin()
    if not plugin:
        return {"success": False, "message": "No active canvas plugin"}
    if plugin.is_running:
        return {"success": False, "message": "Flowgraph is already running"}
    if plugin.is_stepping:
        return {"success": False, "message": "Already in stepping mode"}
    flowgraph = await get_flowgraph()
    nodes = flowgraph.get("nodes", [])
    if not nodes:
        return {"success": False, "message": "No blocks on the canvas to execute"}
    return await plugin.step_start(flowgraph)


async def step_next() -> dict:
    """Execute the next step in step-by-step mode."""
    plugin = _get_active_plugin()
    if not plugin:
        return {"success": False, "message": "No active canvas plugin"}
    if not plugin.is_stepping:
        return {"success": False, "message": "Not in stepping mode"}
    return await plugin.step_next()


async def step_reset() -> dict:
    """Reset step execution state."""
    plugin = _get_active_plugin()
    if not plugin:
        return {"success": False, "message": "No active canvas plugin"}
    return await plugin.step_reset()


async def run_remaining() -> dict:
    """Run all remaining steps without pausing."""
    plugin = _get_active_plugin()
    if not plugin:
        return {"success": False, "message": "No active canvas plugin"}
    if not plugin.is_stepping:
        return {"success": False, "message": "Not in stepping mode"}
    return await plugin.run_remaining()


async def run_single_node(node_id: str) -> dict:
    """Execute a single node's code in the kernel without running the full flow."""
    plugin = _get_active_plugin()
    if plugin is None:
        return {"success": False, "message": "No Python plugin available"}

    # Get node info from frontend
    fg_result = await send_command({"action": "get_elements"})
    flowgraph = fg_result.get("flowgraph", {"nodes": [], "edges": []})
    node = None
    for n in flowgraph.get("nodes", []):
        if n["id"] == node_id:
            node = n
            break
    if not node:
        return {"success": False, "message": f"Node not found: {node_id}"}

    code = build_node_code(node)
    if not code.strip():
        return {"success": False, "message": "Node has no executable code"}

    # Ensure kernel is available
    if not await plugin.ensure_kernel():
        return {"success": False, "message": "Failed to start kernel"}

    # Broadcast executing status
    await _ws_broadcast({
        "type": "node_execution_status",
        "node_id": node_id,
        "status": "executing",
    })

    # Execute with streaming support
    start_time = time.monotonic()

    async def on_stream(text: str) -> None:
        try:
            await _ws_broadcast({
                "type": "node_output_stream",
                "node_id": node_id,
                "text": text,
            })
        except Exception as e:
            logger.warning("Failed to broadcast stream output: %s", e)

    result = await plugin.execute_code_with_stream(code, on_stream=on_stream)
    elapsed = time.monotonic() - start_time

    # Broadcast completion
    status = "completed" if result.success else "error"
    await _ws_broadcast({
        "type": "node_execution_status",
        "node_id": node_id,
        "status": status,
        "output": result.output[:OUTPUT_TRUNCATE_FULL],
        "error": result.error[:OUTPUT_TRUNCATE_FULL],
        "execution_time": round(elapsed, 4),
        "result_value": result.result_value[:RESULT_VALUE_TRUNCATE] if result.result_value else "",
        "display_data": result.display_data,
    })

    return {
        "success": True,
        "message": f"Node {node_id} executed ({status})",
        "status": status,
    }
