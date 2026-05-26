"""Python Canvas plugin for AI Canvas platform."""

import asyncio
import logging

from backend.config import OUTPUT_TRUNCATE_SUMMARY
from backend.plugin_base import CanvasPlugin
from backend.plugins.python_canvas.kernel import KernelManager, ExecutionResult
from backend.plugins.python_canvas.flow_executor import FlowExecutor

logger = logging.getLogger(__name__)


class PythonCanvasPlugin(CanvasPlugin):

    def __init__(self, ws_broadcast, console_log_broadcast):
        """
        Args:
            ws_broadcast: async callable(msg_dict) for WebSocket broadcast
            console_log_broadcast: async callable(level, message, details, source)
        """
        self._ws_broadcast = ws_broadcast
        self._console_log_broadcast = console_log_broadcast
        self._kernel: KernelManager | None = None
        self._executor: FlowExecutor | None = None
        self._execution_task: asyncio.Task | None = None
        self._last_execution_result: dict | None = None

    @property
    def plugin_id(self) -> str:
        return "python"

    @property
    def display_name(self) -> str:
        return "Python Canvas"

    @property
    def is_running(self) -> bool:
        return self._executor is not None and self._executor.running

    @property
    def is_stepping(self) -> bool:
        return self._executor is not None and self._executor.stepping

    def get_block_definitions(self) -> dict:
        from backend import block_registry
        return block_registry.get_blocks_by_category()

    async def run(self, flowgraph: dict, workspace_path: str | None = None) -> dict:
        """Run the flowgraph using Jupyter kernel."""
        if self.is_running:
            return {"success": False, "message": "Error: Flowgraph is already running"}

        # Stop previous kernel before creating a fresh one (clean state for each run)
        if self._kernel is not None:
            try:
                await self._kernel.stop()
            except Exception:
                pass
        self._kernel = KernelManager()
        self._executor = FlowExecutor(self._kernel, self._ws_broadcast)

        async def _run():
            from backend import narrator as _narrator
            await self._console_log_broadcast("info", "Flow execution started", "", "runner")
            _narrator.emit(_narrator.TYPES.FLOW, _narrator.NAMES.FLOW_STARTED,
                           {"node_count": len(flowgraph.get("nodes", []))})
            await self._ws_broadcast({"type": "status_change", "status": "running"})
            try:
                result = await self._executor.execute_flow(flowgraph, workspace_path)
                self._last_execution_result = result
                status_msg = f"Flow {result['status']} in {result['total_time']}s"
                level = "info" if result["status"] == "completed" else "error"
                details_lines = []
                for nid, nr in result.get("node_results", {}).items():
                    status_icon = "OK" if nr["success"] else "FAIL"
                    _so = nr.get("start_offset")
                    _eo = nr.get("end_offset")
                    _tspan = f"@{_so:.2f}->{_eo:.2f}s " if _so is not None and _eo is not None else ""
                    line = f"  {nid}: [{status_icon}] {_tspan}exec={nr['execution_time']:.3f}s"
                    if nr.get("output"):
                        line += f" | {nr['output'].strip()[:100]}"
                    if nr.get("error") and nr["error"] != "Cancelled":
                        err_lines = nr["error"].strip().split("\n")
                        err_summary = err_lines[-1][:150] if err_lines else ""
                        line += f" | {err_summary}"
                    details_lines.append(line)
                details = "\n".join(details_lines)
                await self._console_log_broadcast(level, status_msg, details, "runner")
                if result["status"] == "completed":
                    _narrator.emit(_narrator.TYPES.FLOW, _narrator.NAMES.FLOW_COMPLETED,
                                   {"total_time": result["total_time"],
                                    "node_count": len(result.get("node_results", {}))})
                elif result["status"] == "cancelled":
                    _narrator.emit(_narrator.TYPES.FLOW, _narrator.NAMES.FLOW_CANCELLED,
                                   {"total_time": result["total_time"]})
                else:
                    failed = [nid for nid, nr in result.get("node_results", {}).items()
                              if not nr["success"] and nr.get("error") not in ("Cancelled", "")]
                    _narrator.emit(_narrator.TYPES.FLOW, _narrator.NAMES.FLOW_ERROR,
                                   {"total_time": result["total_time"], "failed_nodes": failed})
            except Exception as e:
                self._last_execution_result = {"status": "error", "error": str(e)}
                await self._console_log_broadcast("error", f"Flow execution failed: {e}", "", "runner")
                _narrator.emit(_narrator.TYPES.FLOW, _narrator.NAMES.FLOW_ERROR, {"error": str(e)})
                if "kernel" in str(e).lower() or "jupyter" in str(e).lower():
                    _narrator.emit(_narrator.TYPES.KERNEL, _narrator.NAMES.KERNEL_START_ERROR,
                                   {"error": str(e)})
            finally:
                await self._ws_broadcast({"type": "status_change", "status": "stopped"})

        self._execution_task = asyncio.create_task(_run())
        return {"success": True, "message": "Flow execution started"}

    async def stop(self) -> dict:
        """Stop the running flowgraph."""
        if not self._executor or not self._executor.running:
            return {"success": True, "message": "Not running"}

        await self._executor.cancel()
        await self._console_log_broadcast("info", "Flow execution cancelled", "", "runner")
        return {"success": True, "message": "Flow execution cancelled"}

    async def get_status(self) -> dict:
        """Get current execution status."""
        stepping = self._executor.stepping if self._executor else False
        running = self._executor.running if self._executor else False
        if stepping:
            status = "stepping"
        elif running:
            status = "running"
        else:
            status = "stopped"
        result = {"status": status}
        if stepping:
            result["step_index"] = self._executor.step_index
            result["total_steps"] = len(self._executor.step_queue)
            result["step_order"] = self._executor.step_queue
            next_idx = self._executor.step_index
            queue = self._executor.step_queue
            result["next_node_id"] = queue[next_idx] if next_idx < len(queue) else None
        if self._last_execution_result:
            result["last_result"] = self._last_execution_result
        if self._executor and self._executor.node_results:
            statuses = self._executor.node_statuses
            _starts = getattr(self._executor, "_node_start_offsets", {})
            _ends = getattr(self._executor, "_node_end_offsets", {})
            result["node_results"] = {
                nid: {
                    "success": r.success,
                    "output": r.output[:OUTPUT_TRUNCATE_SUMMARY],
                    "error": r.error[:OUTPUT_TRUNCATE_SUMMARY],
                    "execution_time": r.execution_time,
                    "status": statuses.get(nid, "unknown"),
                    "start_offset": _starts.get(nid),
                    "end_offset": _ends.get(nid),
                }
                for nid, r in self._executor.node_results.items()
            }
        return result

    async def step_start(self, flowgraph: dict, workspace_path: str | None = None) -> dict:
        """Start step-by-step execution."""
        if self.is_running:
            return {"success": False, "message": "Error: Flowgraph is already running"}
        if self.is_stepping:
            return {"success": False, "message": "Error: Already in stepping mode"}

        self._kernel = KernelManager()
        self._executor = FlowExecutor(self._kernel, self._ws_broadcast)

        await self._console_log_broadcast("info", "Step execution started", "", "runner")
        result = await self._executor.prepare_step(flowgraph, self._ws_broadcast, workspace_path)

        if result["total_steps"] == 0:
            await self._console_log_broadcast("info", "No enabled blocks to execute", "", "runner")
            await self._ws_broadcast({"type": "status_change", "status": "stopped"})
            return {"success": True, "message": "No enabled blocks to execute", **result}

        return {"success": True, "message": "Step execution ready", **result}

    async def step_next(self) -> dict:
        """Execute the next step."""
        if not self.is_stepping:
            return {"success": False, "message": "Error: Not in stepping mode"}

        result = await self._executor.execute_step()
        node_id = result["node_id"]

        if not result["success"]:
            await self._console_log_broadcast(
                "error", f"Step failed at node {node_id}", "", "runner"
            )
        else:
            await self._console_log_broadcast(
                "info",
                f"Step {result['step_index'] + 1}/{result['total_steps']} completed ({node_id})",
                "", "runner",
            )

        return {"success": True, **result}

    async def step_reset(self) -> dict:
        """Reset step execution state."""
        if self._executor and self._executor.stepping:
            self._executor.reset_step()
        if self._kernel:
            await self._kernel.stop()
            self._kernel = None
        await self._ws_broadcast({"type": "status_change", "status": "stopped"})
        await self._console_log_broadcast("info", "Step execution reset", "", "runner")
        return {"success": True, "message": "Step execution reset"}

    async def run_remaining(self) -> dict:
        """Run all remaining steps without pausing."""
        if not self.is_stepping:
            return {"success": False, "message": "Error: Not in stepping mode"}

        await self._console_log_broadcast("info", "Running remaining steps", "", "runner")
        await self._ws_broadcast({"type": "status_change", "status": "running"})

        try:
            result = await self._executor.run_remaining()
            self._last_execution_result = result
            status_msg = f"Flow {result['status']} in {result['total_time']}s"
            level = "info" if result["status"] == "completed" else "error"
            await self._console_log_broadcast(level, status_msg, "", "runner")
        except Exception as e:
            self._last_execution_result = {"status": "error", "error": str(e)}
            await self._console_log_broadcast("error", f"Run remaining failed: {e}", "", "runner")
        finally:
            await self._ws_broadcast({"type": "status_change", "status": "stopped"})

        return {"success": True, "result": self._last_execution_result}

    async def ensure_kernel(self) -> bool:
        """Ensure a kernel is running. Start one if needed."""
        if self._kernel is not None and await self._kernel.is_alive():
            return True
        try:
            if self._kernel is None:
                self._kernel = KernelManager()
            await self._kernel.start()
            return True
        except Exception as e:
            logger.error("Failed to start standalone kernel: %s", e)
            return False

    async def execute_code(self, code: str) -> ExecutionResult:
        """Execute arbitrary code in the current kernel."""
        if self._kernel is None:
            return ExecutionResult(
                success=False, output="", error="No kernel running",
                result_value="", execution_time=0.0,
            )
        return await self._kernel.execute(code)

    async def execute_code_with_stream(self, code: str, on_stream=None) -> ExecutionResult:
        """Execute code with optional streaming callback for print output."""
        if self._kernel is None:
            return ExecutionResult(
                success=False, output="", error="No kernel running",
                result_value="", execution_time=0.0,
            )
        return await self._kernel.execute(code, on_stream=on_stream)

    async def get_node_result(self, node_id: str) -> dict:
        """Get execution result for a specific node."""
        if not self._executor:
            return {"success": False, "message": "Error: No execution results available"}
        result = self._executor.node_results.get(node_id)
        if not result:
            return {"success": False, "message": f"Error: No result for node '{node_id}'"}
        return {
            "node_id": node_id,
            "success": result.success,
            "output": result.output,
            "error": result.error,
            "result_value": result.result_value,
            "execution_time": result.execution_time,
            "display_data": [
                {"mime_type": d["mime_type"], "data": d["data"][:100] + "..." if len(str(d["data"])) > 100 else d["data"]}
                for d in result.display_data
            ] if result.display_data else [],
        }


