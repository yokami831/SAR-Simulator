"""Jupyter Kernel manager for HiyoCanvas.

Manages a single IPython kernel. Nodes execute code in the same
kernel, sharing variables and connections across the flow.
"""

import asyncio
import logging
import queue
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from jupyter_client import KernelManager as JupyterKM

from backend.config import (
    KERNEL_STARTUP_TIMEOUT, KERNEL_EXECUTION_TIMEOUT,
    KERNEL_SHELL_MSG_TIMEOUT, KERNEL_IOPUB_MSG_TIMEOUT,
)

logger = logging.getLogger(__name__)

_ANSI_ESCAPE_RE = re.compile(r'\x1b\[[0-9;]*m')


@dataclass
class ExecutionResult:
    success: bool
    output: str              # stdout
    error: str               # stderr + traceback
    result_value: str        # last expression value (execute_result)
    execution_time: float    # seconds
    display_data: list = field(default_factory=list)  # [{mime_type, data}, ...]


class KernelManager:
    """Async wrapper around jupyter_client.KernelManager."""

    def __init__(self) -> None:
        self._km: JupyterKM | None = None
        self._kc = None  # KernelClient
        self._loop: asyncio.AbstractEventLoop | None = None

    async def start(self, cwd: str | None = None) -> None:
        """Start an IPython kernel. cwd sets the working directory."""
        # Stop existing kernel first to avoid ZMQ context leaks
        if self._km is not None:
            await self.stop()
        from backend import narrator as _narrator
        _narrator.emit(_narrator.TYPES.KERNEL, _narrator.NAMES.KERNEL_STARTING, {})
        _start_time = time.monotonic()
        self._loop = asyncio.get_event_loop()
        self._km = JupyterKM(kernel_name="python3")
        if cwd:
            self._km.cwd = cwd

        # Force lightweight Agg backend before kernel starts (avoids heavy Qt init)
        import os
        os.environ["MPLBACKEND"] = "agg"

        # start_kernel is synchronous — run in executor
        await self._loop.run_in_executor(None, self._km.start_kernel)
        self._kc = self._km.client()
        self._kc.start_channels()

        # Wait for kernel to be ready
        await self._loop.run_in_executor(None, self._kc.wait_for_ready, KERNEL_STARTUP_TIMEOUT)

        # Use lightweight Agg backend instead of qtagg (Qt) for faster rendering
        await self.execute("%matplotlib inline")

        # Disable stdout buffering so print() output is sent immediately via IOPub
        await self.execute(
            "import sys\n"
            "try:\n"
            "    sys.stdout.reconfigure(line_buffering=True)\n"
            "except AttributeError:\n"
            "    pass  # ipykernel OutStream — already unbuffered\n"
        )

        logger.info("Kernel started (cwd=%s)", cwd)
        _narrator.emit(_narrator.TYPES.KERNEL, _narrator.NAMES.KERNEL_STARTED,
                       {"startup_time": round(time.monotonic() - _start_time, 2),
                        "cwd": cwd or ""})

    async def stop(self) -> None:
        """Stop the kernel gracefully."""
        if not self._km:
            return
        try:
            if self._kc:
                self._kc.stop_channels()
            # Try graceful shutdown first
            await self._loop.run_in_executor(
                None, lambda: self._km.shutdown_kernel(now=False, restart=False)
            )
        except Exception as e:
            logger.debug("Graceful kernel shutdown failed, forcing: %s", e)
            # Force kill if graceful fails
            try:
                await self._loop.run_in_executor(
                    None, lambda: self._km.shutdown_kernel(now=True, restart=False)
                )
            except Exception as e:
                logger.warning("Force kernel shutdown failed: %s", e)
        finally:
            self._km = None
            self._kc = None
            logger.info("Kernel stopped")
            from backend import narrator as _narrator
            _narrator.emit(_narrator.TYPES.KERNEL, _narrator.NAMES.KERNEL_STOPPED, {})

    async def execute(self, code: str, timeout: float = KERNEL_EXECUTION_TIMEOUT, on_stream: Callable | None = None) -> ExecutionResult:
        """Execute code in the kernel and return the result."""
        if not self._kc:
            return ExecutionResult(
                success=False, output="", error="Kernel not started",
                result_value="", execution_time=0.0,
            )

        start_time = time.monotonic()
        stdout_parts: list[str] = []
        stderr_parts: list[str] = []
        result_value = ""
        traceback_parts: list[str] = []
        display_data_list: list[dict] = []
        success = True

        # Send execute request
        msg_id = self._kc.execute(code)

        try:
            result = await asyncio.wait_for(
                self._collect_output(msg_id, stdout_parts, stderr_parts, traceback_parts, display_data_list, on_stream=on_stream),
                timeout=timeout,
            )
            if result is not None:
                result_value = result
            # Check shell reply for error status (filter by msg_id to skip stale replies)
            while True:
                reply = await self._loop.run_in_executor(
                    None, lambda: self._kc.get_shell_msg(timeout=KERNEL_SHELL_MSG_TIMEOUT)
                )
                if reply["parent_header"].get("msg_id") == msg_id:
                    break
                logger.debug("Skipping stale shell reply (expected %s, got %s)",
                             msg_id, reply["parent_header"].get("msg_id"))
            if reply["content"]["status"] == "error":
                success = False
        except asyncio.TimeoutError:
            await self.interrupt()
            success = False
            stderr_parts.append(f"Execution timed out after {timeout}s")
        except Exception as e:
            success = False
            stderr_parts.append(str(e))

        elapsed = time.monotonic() - start_time

        error_text = "\n".join(traceback_parts) if traceback_parts else "\n".join(stderr_parts)

        return ExecutionResult(
            success=success,
            output="\n".join(stdout_parts),
            error=error_text,
            result_value=result_value,
            execution_time=round(elapsed, 4),
            display_data=display_data_list,
        )

    # Rich mime types to capture from display_data (priority order)
    _RICH_MIME_TYPES = ["application/x-hiyocanvas-surface3d", "image/png", "image/jpeg", "image/svg+xml", "text/html", "text/plain"]

    async def _collect_output(
        self,
        msg_id: str,
        stdout_parts: list[str],
        stderr_parts: list[str],
        traceback_parts: list[str],
        display_data_list: list[dict] | None = None,
        on_stream: Callable | None = None,
    ) -> str | None:
        """Collect IOPub messages until execution completes. Returns result_value."""
        result_value = None
        while True:
            try:
                msg = await self._loop.run_in_executor(
                    None, lambda: self._kc.get_iopub_msg(timeout=KERNEL_IOPUB_MSG_TIMEOUT)
                )
            except queue.Empty:
                # Timeout waiting for IOPub message — keep waiting
                # (long-running computation produces no output until done)
                continue
            except Exception as e:
                logger.warning("Unexpected error reading IOPub message: %s", e)
                break
            # Only process messages for our execution
            if msg["parent_header"].get("msg_id") != msg_id:
                continue

            msg_type = msg["msg_type"]
            content = msg["content"]

            if msg_type == "stream":
                text = content.get("text", "")
                if content.get("name") == "stderr":
                    stderr_parts.append(text)
                else:
                    stdout_parts.append(text)
                    if on_stream:
                        await on_stream(text)
            elif msg_type == "execute_result":
                data = content.get("data", {})
                result_value = data.get("text/plain", "")
                # Also capture rich output from execute_result
                if display_data_list is not None:
                    self._extract_rich_data(data, display_data_list)
            elif msg_type == "display_data":
                data = content.get("data", {})
                if display_data_list is not None:
                    self._extract_rich_data(data, display_data_list)
                # Fallback: text/plain as stdout if no rich data captured
                if not any(mt in data for mt in ["image/png", "image/jpeg", "image/svg+xml", "text/html"]):
                    text = data.get("text/plain", "")
                    if text:
                        stdout_parts.append(text)
            elif msg_type == "error":
                # Strip ANSI color codes from traceback
                for line in content.get("traceback", []):
                    traceback_parts.append(_ANSI_ESCAPE_RE.sub("", line))
            elif msg_type == "status" and content.get("execution_state") == "idle":
                break

        return result_value

    def _extract_rich_data(self, data: dict, display_data_list: list[dict]) -> None:
        """Extract rich mime data from a display_data/execute_result message."""
        for mime_type in self._RICH_MIME_TYPES:
            if mime_type in data:
                display_data_list.append({
                    "mime_type": mime_type,
                    "data": data[mime_type],
                })
                break  # Take highest priority only

    async def is_alive(self) -> bool:
        """Check if the kernel is alive."""
        if not self._km:
            return False
        return await self._loop.run_in_executor(None, self._km.is_alive)

    async def interrupt(self) -> None:
        """Interrupt the running code."""
        if self._km:
            await self._loop.run_in_executor(None, self._km.interrupt_kernel)

    async def restart(self) -> None:
        """Restart the kernel. All variables are cleared."""
        if self._km:
            await self._loop.run_in_executor(
                None, lambda: self._km.restart_kernel(now=True)
            )
            self._kc = self._km.client()
            self._kc.start_channels()
            await self._loop.run_in_executor(None, self._kc.wait_for_ready, KERNEL_STARTUP_TIMEOUT)
            logger.info("Kernel restarted")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    async def test():
        km = KernelManager()
        print("Starting kernel...")
        await km.start()

        print("\n--- Test 1: Variable assignment ---")
        r1 = await km.execute("x = 42")
        print(f"  success={r1.success}, output='{r1.output}', error='{r1.error}'")

        print("\n--- Test 2: Variable sharing ---")
        r2 = await km.execute("print(x * 2)")
        print(f"  success={r2.success}, output='{r2.output.strip()}' (expected: 84)")

        print("\n--- Test 3: Expression result ---")
        r3 = await km.execute("x + 10")
        print(f"  success={r3.success}, result_value='{r3.result_value}' (expected: 52)")

        print("\n--- Test 4: Error handling ---")
        r4 = await km.execute("1/0")
        print(f"  success={r4.success} (expected: False)")
        print(f"  error contains ZeroDivisionError: {'ZeroDivisionError' in r4.error}")

        print("\n--- Test 5: Post-error recovery ---")
        r5 = await km.execute("print('recovered')")
        print(f"  success={r5.success}, output='{r5.output.strip()}' (expected: recovered)")

        alive = await km.is_alive()
        print(f"\nKernel alive: {alive}")

        print("\nStopping kernel...")
        await km.stop()
        print("Done.")

    asyncio.run(test())
