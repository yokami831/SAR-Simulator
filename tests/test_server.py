"""Tests for backend.server REST API endpoints.

Tests the FastAPI endpoints using TestClient (synchronous wrapper).
These tests verify HTTP-level behavior of the FastAPI server.
"""

import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))

from backend.server import app


@pytest.fixture
def client():
    """Create a test client for the FastAPI app."""
    return TestClient(app)


class TestGetBlocks:
    """Tests for GET /api/blocks."""

    def test_returns_200(self, client):
        response = client.get("/api/blocks")
        assert response.status_code == 200

    def test_returns_categories(self, client):
        response = client.get("/api/blocks")
        data = response.json()
        assert "categories" in data
        assert len(data["categories"]) > 0

    def test_blocks_have_required_fields(self, client):
        response = client.get("/api/blocks")
        data = response.json()
        # Check at least one block in any category
        for cat_path, cat_data in data["categories"].items():
            assert "label" in cat_data
            assert "blocks" in cat_data
            if cat_data["blocks"]:
                block = cat_data["blocks"][0]
                assert "id" in block
                assert "label" in block
                break



class TestFlowgraphStop:
    """Tests for POST /api/tools/stop_execution."""

    def test_stop_when_not_running(self, client):
        response = client.post("/api/tools/stop_execution")
        assert response.status_code == 200
        data = response.json()
        assert data["success"] is True
