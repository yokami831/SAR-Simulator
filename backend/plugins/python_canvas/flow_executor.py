"""Flow execution engine for HiyoCanvas.

Executes a flowgraph by:
1. Topological sort (left-to-right)
2. Sequential execution of each node's code in the Jupyter kernel
3. Edges define execution order only (variables shared via kernel namespace)
4. Real-time status updates via WebSocket
"""

import asyncio
import heapq
import logging
import time
from collections import defaultdict
from pathlib import Path

from backend.plugins.python_canvas.kernel import KernelManager, ExecutionResult
from backend import block_registry
from backend.code_utils import build_node_code, make_gui_assignment_code
from backend.config import OUTPUT_TRUNCATE_FULL, RESULT_VALUE_TRUNCATE

logger = logging.getLogger(__name__)


class FlowExecutor:
    """Executes a flow using a Jupyter kernel."""

    def __init__(self, kernel: KernelManager, ws_broadcast):
        """
        Args:
            kernel: KernelManager instance
            ws_broadcast: async callable(msg_dict) to broadcast to WebSocket clients
        """
        self._kernel = kernel
        self._ws_broadcast = ws_broadcast
        self._running = False
        self._cancelled = False
        self._node_results: dict[str, ExecutionResult] = {}
        self._node_statuses: dict[str, str] = {}
        # Per-node wall-clock offset from flow start (s), for timing diagnostics
        self._node_start_offsets: dict[str, float] = {}
        self._node_end_offsets: dict[str, float] = {}
        self._flow_start_time: float = 0.0
        # Step execution state
        self._stepping = False
        self._step_executing = False
        self._step_queue: list[str] = []
        self._step_index: int = 0
        self._step_flowgraph: dict = {}
        self._workspace_path: str | None = None

    @property
    def running(self) -> bool:
        return self._running

    @property
    def node_results(self) -> dict[str, ExecutionResult]:
        return self._node_results

    def _determine_final_status(self) -> str:
        """Determine final flow status based on node results."""
        if not self._cancelled:
            return "completed"
        has_error = any(
            not r.success
            and r.error != "Cancelled"
            and "KeyboardInterrupt" not in r.error
            for r in self._node_results.values()
        )
        return "error" if has_error else "cancelled"

    @property
    def node_statuses(self) -> dict[str, str]:
        return self._node_statuses

    async def execute_flow(self, flowgraph: dict, workspace_path: str | None = None) -> dict:
        """Execute the entire flow.

        Returns:
            {"status": "completed"|"error"|"cancelled",
             "node_results": {node_id: {...}},
             "total_time": float}
        """
        self._running = True
        self._cancelled = False
        self._node_results = {}
        self._node_start_offsets = {}
        self._node_end_offsets = {}
        self._workspace_path = workspace_path
        start_time = time.monotonic()
        self._flow_start_time = start_time

        nodes = flowgraph.get("nodes", [])
        edges = flowgraph.get("edges", [])

        if not nodes:
            self._running = False
            return {"status": "completed", "node_results": {}, "total_time": 0.0}

        # Refuse to execute flows containing unknown block types (shim nodes).
        # Mid-flight discovery of a missing block would corrupt downstream
        # state; we surface it up-front so the user can copy the missing
        # JSON into <workspace>/blocks/ and try again.
        from backend import block_registry
        missing_ids: dict[str, list[str]] = {}
        for n in nodes:
            bt = self._get_block_type(n)
            if not bt or bt in ("subgraph", "group", "groupSpec", "comment"):
                continue
            if block_registry.get_block(bt) is None:
                missing_ids.setdefault(bt, []).append(n.get("id", "?"))
        if missing_ids:
            self._running = False
            summary = ", ".join(f"{bt}({len(ids)})" for bt, ids in sorted(missing_ids.items()))
            err_msg = (
                "Flow contains unknown block types: " + summary
                + ". Copy the missing block JSON file(s) into <workspace>/blocks/ "
                "and reload, then retry."
            )
            logger.error(err_msg)
            from backend import narrator as _narrator
            _narrator.emit("FLOW", "FLOW_LOAD_WARNING", {
                "missing_blocks": list(missing_ids.keys()),
                "stage": "pre_execute",
            })
            return {
                "status": "error",
                "node_results": {},
                "total_time": 0.0,
                "error": err_msg,
                "missing_blocks": [
                    {"type": t, "count": len(ids), "node_ids": ids}
                    for t, ids in sorted(missing_ids.items())
                ],
            }

        try:
            # Start kernel
            await self._kernel.start(cwd=workspace_path)

            # Topological sort for all nodes
            if not self._cancelled and nodes:
                node_map = {n["id"]: n for n in nodes}
                sorted_ids = self._topological_sort(nodes, edges)
                logger.debug("Execution order: %s", sorted_ids)

                run_order = 0  # 1-based counter over nodes that actually execute
                for node_id in sorted_ids:
                    if self._cancelled:
                        # Mark remaining as cancelled
                        await self._broadcast_status(node_id, "cancelled")
                        self._node_results[node_id] = ExecutionResult(
                            success=False, output="", error="Cancelled",
                            result_value="", execution_time=0.0,
                        )
                        self._node_statuses[node_id] = "cancelled"
                        from backend import narrator as _narrator
                        _narrator.emit(_narrator.TYPES.NODE, _narrator.NAMES.NODE_SKIPPED,
                                       {"node_id": node_id, "reason": "upstream_error"})
                        continue
                    node = node_map.get(node_id)
                    if node:
                        # Skip disabled nodes and comment nodes
                        if node.get("enabled") is False or self._get_block_type(node) == "comment":
                            await self._broadcast_status(node_id, "skipped")
                            from backend import narrator as _narrator
                            reason = "disabled" if node.get("enabled") is False else "comment"
                            _narrator.emit(_narrator.TYPES.NODE, _narrator.NAMES.NODE_SKIPPED,
                                           {"node_id": node_id, "reason": reason})
                            self._node_results[node_id] = ExecutionResult(
                                success=True, output="", error="",
                                result_value="", execution_time=0.0,
                            )
                            self._node_statuses[node_id] = "skipped"
                            continue
                        run_order += 1
                        result = await self._execute_node(node, edges, nodes, order=run_order)
                        if not result.success:
                            self._cancelled = True

            # Determine final status
            status = self._determine_final_status()

        except Exception as e:
            logger.error("Flow execution failed: %s", e)
            status = "error"
        finally:
            # Keep kernel alive for single-node re-execution after flow completes.
            # Kernel is stopped when a new run() creates a fresh KernelManager.
            self._running = False

        total_time = round(time.monotonic() - start_time, 4)

        return {
            "status": status,
            "node_results": {
                nid: {
                    "success": r.success,
                    "output": r.output,
                    "error": r.error,
                    "result_value": r.result_value,
                    "execution_time": r.execution_time,
                    "display_data": r.display_data,
                    "start_offset": self._node_start_offsets.get(nid),
                    "end_offset": self._node_end_offsets.get(nid),
                }
                for nid, r in self._node_results.items()
            },
            "total_time": total_time,
        }

    # --- Step Execution ---

    @property
    def stepping(self) -> bool:
        return self._stepping

    @property
    def step_index(self) -> int:
        return self._step_index

    @property
    def step_queue(self) -> list[str]:
        return list(self._step_queue)

    async def prepare_step(self, flowgraph: dict, ws_broadcast, workspace_path: str | None = None) -> dict:
        """Prepare for step-by-step execution: start kernel, compute order, broadcast step_ready.

        Args:
            flowgraph: {"nodes": [...], "edges": [...]}
            ws_broadcast: async callable (stored for later use)
            workspace_path: working directory for kernel

        Returns:
            {"step_order": [...], "total_steps": int}
        """
        if self._running:
            raise RuntimeError("Cannot start stepping while running")
        if self._stepping:
            raise RuntimeError("Already in stepping mode")

        self._ws_broadcast = ws_broadcast
        nodes = flowgraph.get("nodes", [])
        edges = flowgraph.get("edges", [])

        # Filter out disabled nodes from step queue
        node_map = {n["id"]: n for n in nodes}
        sorted_ids = self._topological_sort(nodes, edges)
        enabled_ids = [nid for nid in sorted_ids
                       if node_map.get(nid, {}).get("enabled") is not False
                       and FlowExecutor._get_block_type(node_map.get(nid, {})) != "comment"]

        if not enabled_ids:
            return {"step_order": [], "total_steps": 0}

        # Start kernel
        await self._kernel.start(cwd=workspace_path)

        self._stepping = True
        self._step_executing = False
        self._step_queue = enabled_ids
        self._step_index = 0
        self._step_flowgraph = flowgraph
        self._node_results = {}
        self._node_statuses = {}

        # Broadcast stepping status
        await self._ws_broadcast({"type": "status_change", "status": "stepping"})

        # Broadcast step_ready
        await self._broadcast_step_ready()

        return {"step_order": enabled_ids, "total_steps": len(enabled_ids)}

    async def execute_step(self) -> dict:
        """Execute exactly the next node in the step queue.

        Returns:
            {"node_id": str, "success": bool, "step_index": int, "total_steps": int}
        """
        if not self._stepping:
            raise RuntimeError("Not in stepping mode")
        if self._step_executing:
            raise RuntimeError("A step is already executing")
        if self._step_index >= len(self._step_queue):
            raise RuntimeError("All steps completed")

        self._step_executing = True
        node_id = self._step_queue[self._step_index]

        try:
            nodes = self._step_flowgraph.get("nodes", [])
            edges = self._step_flowgraph.get("edges", [])
            node_map = {n["id"]: n for n in nodes}
            node = node_map.get(node_id)

            if not node:
                raise RuntimeError(f"Node {node_id} not found in flowgraph")

            result = await self._execute_node(node, edges, nodes)
            self._step_index += 1

            if not result.success:
                # Error → transition to idle (keep kernel for single-node re-execution)
                self._stepping = False
                self._step_executing = False
                await self._ws_broadcast({"type": "status_change", "status": "stopped"})
                return {
                    "node_id": node_id,
                    "success": False,
                    "step_index": self._step_index - 1,
                    "total_steps": len(self._step_queue),
                }

            # Check if all done
            if self._step_index >= len(self._step_queue):
                # Keep kernel alive for single-node re-execution
                self._stepping = False
                self._step_executing = False
                await self._ws_broadcast({"type": "status_change", "status": "stopped"})
            else:
                await self._broadcast_step_ready()

            return {
                "node_id": node_id,
                "success": True,
                "step_index": self._step_index - 1,
                "total_steps": len(self._step_queue),
            }
        except Exception:
            self._step_executing = False
            raise
        finally:
            self._step_executing = False

    async def run_remaining(self) -> dict:
        """Execute all remaining nodes from current step position without pausing.

        Returns same format as execute_flow().
        """
        if not self._stepping:
            raise RuntimeError("Not in stepping mode")
        if self._step_executing:
            raise RuntimeError("A step is currently executing")

        self._stepping = False
        self._running = True
        self._cancelled = False
        start_time = time.monotonic()

        nodes = self._step_flowgraph.get("nodes", [])
        edges = self._step_flowgraph.get("edges", [])
        node_map = {n["id"]: n for n in nodes}

        try:
            remaining = self._step_queue[self._step_index:]
            for node_id in remaining:
                if self._cancelled:
                    await self._broadcast_status(node_id, "cancelled")
                    self._node_results[node_id] = ExecutionResult(
                        success=False, output="", error="Cancelled",
                        result_value="", execution_time=0.0,
                    )
                    self._node_statuses[node_id] = "cancelled"
                    continue

                node = node_map.get(node_id)
                if node:
                    result = await self._execute_node(node, edges, nodes)
                    if not result.success:
                        self._cancelled = True

            status = self._determine_final_status()

        except Exception as e:
            logger.error("Run remaining failed: %s", e)
            status = "error"
        finally:
            # Keep kernel alive for single-node re-execution
            self._running = False

        total_time = round(time.monotonic() - start_time, 4)
        return {
            "status": status,
            "node_results": {
                nid: {
                    "success": r.success, "output": r.output, "error": r.error,
                    "result_value": r.result_value, "execution_time": r.execution_time,
                    "display_data": r.display_data,
                }
                for nid, r in self._node_results.items()
            },
            "total_time": total_time,
        }

    def reset_step(self) -> None:
        """Reset stepping state. Kernel stop must be called separately."""
        self._stepping = False
        self._step_executing = False
        self._step_queue = []
        self._step_index = 0
        self._step_flowgraph = {}

    async def _broadcast_step_ready(self) -> None:
        """Broadcast step_ready message with next node info."""
        next_node_id = self._step_queue[self._step_index] if self._step_index < len(self._step_queue) else None
        msg = {
            "type": "step_ready",
            "next_node_id": next_node_id,
            "step_index": self._step_index,
            "total_steps": len(self._step_queue),
            "step_order": self._step_queue,
        }
        try:
            await self._ws_broadcast(msg)
        except Exception as e:
            logger.warning("Failed to broadcast step_ready: %s", e)

    async def cancel(self) -> None:
        """Cancel the running flow."""
        self._cancelled = True
        await self._kernel.interrupt()

    async def _execute_node(
        self, node: dict, edges: list, all_nodes: list, order: int | None = None
    ) -> ExecutionResult:
        """Execute a single node."""
        node_id = node["id"]
        self._node_start_offsets[node_id] = round(time.monotonic() - self._flow_start_time, 4)
        await self._broadcast_status(node_id, "executing", order=order)
        from backend import narrator as _narrator
        _narrator.emit(_narrator.TYPES.NODE, _narrator.NAMES.NODE_EXECUTING,
                       {"node_id": node_id})

        # Snapshot VCD files before execution (FPGA feature only)
        from backend.config import is_feature_enabled
        _fpga = is_feature_enabled("fpga")
        vcd_before = self._snapshot_vcd_files() if _fpga else {}

        code = build_node_code(node)
        if not code.strip():
            # Skip execution for empty-code nodes (e.g. comment blocks)
            logger.info("Skipping node %s (no code)", node_id)
            result = ExecutionResult(success=True, output="", error="", result_value="", execution_time=0.0)
        else:
            # Lint: detect direct float-to-int scaling bypass in HDL context
            if _fpga:
                lint_warnings = self._lint_fxp_bypass(code)
                if lint_warnings:
                    for w in lint_warnings:
                        logger.warning("Lint [%s]: %s", node_id, w)
                    try:
                        await self._ws_broadcast({
                            "type": "node_lint_warning",
                            "node_id": node_id,
                            "warnings": lint_warnings,
                        })
                    except Exception as e:
                        logger.warning("Failed to broadcast lint warning: %s", e)

            logger.info("Executing node %s:\n%s", node_id, code)

            async def on_stream(text: str) -> None:
                try:
                    logger.info("Stream output [%s]: %s", node_id, text[:80])
                    await self._ws_broadcast({
                        "type": "node_output_stream",
                        "node_id": node_id,
                        "text": text,
                    })
                except Exception as e:
                    logger.warning("Failed to broadcast stream output: %s", e)

            result = await self._kernel.execute(code, on_stream=on_stream)

        # Detect new/modified VCD files (FPGA feature only)
        vcd_files = self._detect_new_vcd_files(vcd_before) if _fpga else []

        self._node_results[node_id] = result
        self._node_end_offsets[node_id] = round(time.monotonic() - self._flow_start_time, 4)
        status = "completed" if result.success else "error"
        self._node_statuses[node_id] = status
        await self._broadcast_status(node_id, status, result,
                                     vcd_files=[p.name for p in vcd_files] if vcd_files else None,
                                     order=order)
        _node_evt = (_narrator.NAMES.NODE_COMPLETED if result.success
                     else _narrator.NAMES.NODE_ERROR)
        _node_data = {"node_id": node_id, "execution_time": result.execution_time}
        if not result.success:
            lines = result.error.splitlines() if result.error else []
            meaningful = next((l.strip() for l in reversed(lines) if l.strip() and not l.startswith("-")), "")
            _node_data["error_summary"] = meaningful[:200]
        _narrator.emit(_narrator.TYPES.NODE, _node_evt, _node_data)
        return result

    def _get_vcd_scan_dir(self) -> Path:
        """Get the directory to scan for VCD files (workspace path or project root)."""
        if self._workspace_path:
            return Path(self._workspace_path)
        # __file__ is backend/plugins/python_canvas/flow_executor.py → 4 levels up to project root
        return Path(__file__).parent.parent.parent.parent

    def _snapshot_vcd_files(self) -> dict[str, float]:
        """Get current VCD files and their modification times."""
        ws_dir = self._get_vcd_scan_dir()
        return {str(p): p.stat().st_mtime for p in ws_dir.glob("*.vcd") if p.is_file()}

    def _detect_new_vcd_files(self, before: dict[str, float]) -> list[Path]:
        """Detect VCD files created or modified since the snapshot."""
        ws_dir = self._get_vcd_scan_dir()
        new_files = []
        for p in ws_dir.glob("*.vcd"):
            if not p.is_file():
                continue
            key = str(p)
            if key not in before or p.stat().st_mtime > before[key]:
                new_files.append(p)
        return new_files

    @staticmethod
    def _is_gui_widget(node: dict) -> bool:
        """True if the node's block definition is a GUI widget (slider, etc.).

        GUI widgets only assign a kernel variable; among ready (input-unconnected)
        nodes they must run before ordinary code blocks, which may read those
        variables. See _topological_sort's tie-break.
        """
        data = node.get("data", {})
        block_type = data.get("blockType") or data.get("label") or node.get("type", "")
        block_def = block_registry.get_block(block_type)
        return bool(block_def and block_def.get("gui_widget"))

    def _topological_sort(self, nodes: list, edges: list) -> list[str]:
        """Topological sort (Kahn's algorithm).

        Tie-break among simultaneously-ready nodes: GUI widgets first, then by
        id. Edges still define the hard ordering; this only decides the order of
        nodes that have no remaining dependency on each other. GUI-first ensures
        a widget's variable assignment happens before any code block that reads
        it (e.g. a code block consuming `n_targets`).
        """
        node_map = {n["id"]: n for n in nodes}
        node_ids = set(node_map)
        in_degree: dict[str, int] = defaultdict(int)
        adjacency: dict[str, list[str]] = defaultdict(list)

        for nid in node_ids:
            in_degree[nid] = 0

        for edge in edges:
            src = edge.get("source")
            tgt = edge.get("target")
            if src in node_ids and tgt in node_ids:
                adjacency[src].append(tgt)
                in_degree[tgt] += 1

        # Heap key among simultaneously-ready nodes: (gui_rank, y, id).
        #   1. GUI widgets first (their variable assignment must precede any code
        #      block that reads it).
        #   2. Then by vertical position only — TOP first. The flow runs left to
        #      right, so a branch fans out into nodes stacked vertically at about
        #      the same x; their order is therefore read top-to-bottom. x is NOT
        #      used: branch siblings share roughly the same x, and reading it
        #      would let small x jitter reorder them. Node id is only the final
        #      deterministic tie-break for identical y (ids are creation order,
        #      unrelated to execution).
        def _y(nid: str) -> float:
            p = node_map[nid].get("position", {}) or {}
            return float(p.get("y", 0.0))
        def _key(nid: str) -> tuple:
            return (0 if self._is_gui_widget(node_map[nid]) else 1, _y(nid), nid)

        queue = [_key(nid) for nid in node_ids if in_degree[nid] == 0]
        heapq.heapify(queue)
        result = []

        while queue:
            nid = heapq.heappop(queue)[2]
            result.append(nid)
            for neighbor in adjacency[nid]:
                in_degree[neighbor] -= 1
                if in_degree[neighbor] == 0:
                    heapq.heappush(queue, _key(neighbor))

        return result

    async def _broadcast_status(
        self, node_id: str, status: str, result: ExecutionResult | None = None,
        vcd_files: list[str] | None = None, order: int | None = None,
    ) -> None:
        """Broadcast node execution status to WebSocket clients.

        ``order`` is the 1-based position of this node in the run just executed;
        the frontend shows it next to the run button as a record of the order
        this run actually used.
        """
        msg = {
            "type": "node_execution_status",
            "node_id": node_id,
            "status": status,
        }
        if order is not None:
            msg["order"] = order
        if result:
            msg["output"] = result.output[:OUTPUT_TRUNCATE_FULL]
            msg["error"] = result.error[:OUTPUT_TRUNCATE_FULL]
            msg["execution_time"] = result.execution_time
            msg["result_value"] = result.result_value[:RESULT_VALUE_TRUNCATE] if result.result_value else ""
            msg["display_data"] = result.display_data
        if vcd_files:
            msg["vcd_files"] = vcd_files
        try:
            await self._ws_broadcast(msg)
        except Exception as e:
            logger.warning("Failed to broadcast status: %s", e)

    @staticmethod
    def _get_block_type(node: dict) -> str:
        """Extract block type from node data."""
        return (node.get("data", {}).get("blockType")
                or node.get("blockType")
                or node.get("type", ""))

    @staticmethod
    def _lint_fxp_bypass(code: str) -> list[str]:
        """Detect direct float-to-int scaling patterns that bypass fxp_convert.

        Only warns in HDL context (code containing Amaranth imports or Signal usage).
        Returns a list of warning strings (empty if no issues found).
        """
        import ast

        # Only check in HDL context
        hdl_indicators = ["from amaranth", "import amaranth", "Signal(", "Elaboratable"]
        if not any(ind in code for ind in hdl_indicators):
            return []

        try:
            tree = ast.parse(code)
        except SyntaxError:
            return []

        warnings = []

        class BypassDetector(ast.NodeVisitor):
            def visit_Call(self, node):
                # Detect .astype(int), .astype(np.int16), .astype(np.int32), etc.
                if isinstance(node.func, ast.Attribute) and node.func.attr == "astype":
                    if node.args and self._is_int_type(node.args[0]):
                        # Check if the value being converted involves multiplication
                        if self._involves_scale_multiply(node.func.value):
                            warnings.append(
                                f"Line {node.lineno}: Direct float-to-int scaling detected "
                                f"(e.g. np.round(...).astype(int)). "
                                f"Use fxp_convert block for explicit bit-width specification."
                            )
                self.generic_visit(node)

            def _is_int_type(self, node):
                # Match: int
                if isinstance(node, ast.Name) and node.id == "int":
                    return True
                # Match: np.int16, np.int32, np.int64, np.intc
                if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
                    if node.value.id == "np" and node.attr.startswith("int"):
                        return True
                return False

            def _involves_scale_multiply(self, node):
                """Check if node or its subtree contains multiplication (BinOp Mult)
                or np.round() wrapping a multiply."""
                if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mult):
                    return True
                # np.round(... * CONST) pattern
                if isinstance(node, ast.Call):
                    func = node.func
                    if isinstance(func, ast.Attribute) and func.attr == "round":
                        if node.args:
                            return self._involves_scale_multiply(node.args[0])
                    if isinstance(func, ast.Name) and func.id == "round":
                        if node.args:
                            return self._involves_scale_multiply(node.args[0])
                # Recurse into sub-expressions
                for child in ast.iter_child_nodes(node):
                    if isinstance(child, ast.expr) and self._involves_scale_multiply(child):
                        return True
                return False

        BypassDetector().visit(tree)
        return warnings
