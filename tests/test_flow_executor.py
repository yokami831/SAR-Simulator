"""Tests for FlowExecutor topological sort and execution flow."""

import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from backend.plugins.python_canvas.flow_executor import FlowExecutor
from backend.plugins.python_canvas.kernel import ExecutionResult


@pytest.fixture
def mock_kernel():
    km = AsyncMock()
    km.start = AsyncMock()
    km.stop = AsyncMock()
    km.execute = AsyncMock(return_value=ExecutionResult(
        success=True, output="ok", error="", result_value="", execution_time=0.01,
    ))
    return km


@pytest.fixture
def executor(mock_kernel):
    ws_broadcast = AsyncMock()
    return FlowExecutor(mock_kernel, ws_broadcast)


class TestTopologicalSort:
    """Tests for _topological_sort method."""

    def test_empty_graph(self, executor):
        result = executor._topological_sort([], [])
        assert result == []

    def test_single_node(self, executor):
        nodes = [{"id": "n1"}]
        result = executor._topological_sort(nodes, [])
        assert result == ["n1"]

    def test_linear_chain(self, executor):
        nodes = [{"id": "n1"}, {"id": "n2"}, {"id": "n3"}]
        edges = [
            {"source": "n1", "target": "n2"},
            {"source": "n2", "target": "n3"},
        ]
        result = executor._topological_sort(nodes, edges)
        assert result == ["n1", "n2", "n3"]

    def test_diamond_graph(self, executor):
        nodes = [{"id": "n1"}, {"id": "n2"}, {"id": "n3"}, {"id": "n4"}]
        edges = [
            {"source": "n1", "target": "n2"},
            {"source": "n1", "target": "n3"},
            {"source": "n2", "target": "n4"},
            {"source": "n3", "target": "n4"},
        ]
        result = executor._topological_sort(nodes, edges)
        assert result.index("n1") < result.index("n2")
        assert result.index("n1") < result.index("n3")
        assert result.index("n2") < result.index("n4")
        assert result.index("n3") < result.index("n4")

    def test_disconnected_nodes(self, executor):
        nodes = [{"id": "n1"}, {"id": "n2"}, {"id": "n3"}]
        edges = []
        result = executor._topological_sort(nodes, edges)
        assert set(result) == {"n1", "n2", "n3"}

    def test_ignores_edges_to_missing_nodes(self, executor):
        nodes = [{"id": "n1"}, {"id": "n2"}]
        edges = [
            {"source": "n1", "target": "n2"},
            {"source": "n1", "target": "n99"},  # n99 not in nodes
        ]
        result = executor._topological_sort(nodes, edges)
        assert result == ["n1", "n2"]


class TestExecutorState:
    """Tests for FlowExecutor state management."""

    def test_initial_state(self, executor):
        assert executor.running is False
        assert executor.node_results == {}

    @pytest.mark.asyncio
    async def test_execute_empty_flow(self, executor):
        result = await executor.execute_flow({"nodes": [], "edges": []})
        assert result["status"] == "completed"
        assert result["total_time"] == 0.0

    @pytest.mark.asyncio
    async def test_cancel(self, executor, mock_kernel):
        # Setup a flow that will be cancelled
        mock_kernel.execute = AsyncMock(return_value=ExecutionResult(
            success=True, output="", error="", result_value="", execution_time=0.01,
        ))
        # Cancel before execution
        await executor.cancel()
        assert executor.running is False
