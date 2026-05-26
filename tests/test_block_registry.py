"""Tests for block_registry loading and search."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from backend import block_registry

# Register the Python Canvas block directory (normally done by server.py)
_python_blocks_dir = Path(__file__).parent.parent / "backend" / "plugins" / "python_canvas" / "blocks"
if _python_blocks_dir not in block_registry._block_dirs:
    block_registry.register_block_dir(_python_blocks_dir)


@pytest.fixture(autouse=True)
def reload_registry():
    """Ensure registry is freshly loaded for each test."""
    block_registry.reload()
    yield


class TestLoadAll:
    def test_returns_list(self):
        blocks = block_registry.load_all()
        assert isinstance(blocks, list)

    def test_has_python_code_block(self):
        blocks = block_registry.load_all()
        ids = [b["id"] for b in blocks]
        assert "python_code" in ids

    def test_block_has_required_fields(self):
        block = block_registry.get_block("python_code")
        assert block is not None
        assert "id" in block
        assert "label" in block or "name" in block


class TestGetBlock:
    def test_existing_block(self):
        block = block_registry.get_block("python_code")
        assert block is not None
        assert block["id"] == "python_code"

    def test_nonexistent_block(self):
        block = block_registry.get_block("nonexistent_block_12345")
        assert block is None


class TestSearch:
    def test_search_by_id(self):
        results = block_registry.search("python")
        assert len(results) > 0
        assert any("python" in r["id"].lower() for r in results)

    def test_search_empty_query(self):
        results = block_registry.search("")
        assert isinstance(results, list)

    def test_search_no_match(self):
        results = block_registry.search("zzzzzznonexistent12345")
        assert results == []


class TestGetBlocksByCategory:
    def test_returns_dict(self):
        categories = block_registry.get_blocks_by_category()
        assert isinstance(categories, (dict, list))


class TestRegister:
    def test_register_new_block(self):
        definition = {
            "id": "test_block_register_xyz",
            "label": "Test Block",
            "category": "test",
            "parameters": {},
            "inputs": [],
            "outputs": [],
        }
        result = block_registry.register(definition)
        assert result["id"] == "test_block_register_xyz"
        # Verify it's retrievable
        block = block_registry.get_block("test_block_register_xyz")
        assert block is not None
        # Cleanup: remove the file
        user_file = _python_blocks_dir / "user" / "test_block_register_xyz.json"
        if user_file.exists():
            user_file.unlink()
