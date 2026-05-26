"""Plugin base class for HiyoCanvas platform.

Each canvas type (e.g. Python) implements this interface
to provide its execution engine, block definitions, and configuration.
"""

from __future__ import annotations

from abc import ABC, abstractmethod


class CanvasPlugin(ABC):
    """Base class for canvas type plugins."""

    @property
    @abstractmethod
    def plugin_id(self) -> str:
        """Unique identifier (e.g. 'python')."""
        ...

    @property
    @abstractmethod
    def display_name(self) -> str:
        """Display name shown in tab creation UI (e.g. 'Python Canvas')."""
        ...

    @abstractmethod
    def get_block_definitions(self) -> dict:
        """Return block definitions for the library sidebar.

        Returns:
            Same format as block_registry.get_blocks_by_category()
        """
        ...

    @abstractmethod
    async def run(self, flowgraph: dict, workspace_path: str | None = None) -> dict:
        """Execute the flowgraph.

        Args:
            flowgraph: {"nodes": [...], "edges": [...]}
            workspace_path: Path to the workspace folder

        Returns:
            {"success": True, "message": "..."} on start
        """
        ...

    @abstractmethod
    async def stop(self) -> dict:
        """Stop the running execution."""
        ...

    @abstractmethod
    async def get_status(self) -> dict:
        """Get current execution status."""
        ...

    @abstractmethod
    async def get_node_result(self, node_id: str) -> dict:
        """Get execution result for a specific node."""
        ...

    @property
    def is_running(self) -> bool:
        """Whether execution is currently in progress."""
        return False

    @property
    def is_stepping(self) -> bool:
        """Whether step execution is in progress."""
        return False

    async def step_start(self, flowgraph: dict, workspace_path: str | None = None) -> dict:
        """Start step-by-step execution."""
        raise NotImplementedError("Step execution not supported by this plugin")

    async def step_next(self) -> dict:
        """Execute the next step."""
        raise NotImplementedError("Step execution not supported by this plugin")

    async def step_reset(self) -> dict:
        """Reset step execution state."""
        raise NotImplementedError("Step execution not supported by this plugin")

    async def run_remaining(self) -> dict:
        """Run all remaining steps without pausing."""
        raise NotImplementedError("Step execution not supported by this plugin")
