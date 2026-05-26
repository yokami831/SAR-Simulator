"""Tests for block_registry loading and search."""

import json
import logging
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from backend import block_registry

# Register the Python Canvas block directory (normally done by server.py)
_python_blocks_dir = Path(__file__).parent.parent / "backend" / "plugins" / "python_canvas" / "blocks"
if _python_blocks_dir not in block_registry._block_dirs:
    block_registry.register_plugin_block_dir(_python_blocks_dir)


@pytest.fixture(autouse=True)
def reload_registry():
    """Ensure registry is freshly loaded for each test, with no workspace dir."""
    block_registry.set_workspace_blocks_dir(None)
    block_registry.reload()
    yield
    block_registry.set_workspace_blocks_dir(None)


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
        # No workspace set, so scope='auto' falls back to global (plugin user)
        result = block_registry.register(definition)
        assert result["id"] == "test_block_register_xyz"
        block = block_registry.get_block("test_block_register_xyz")
        assert block is not None
        assert block["_source"] == "plugin_user"
        user_file = _python_blocks_dir / "user" / "test_block_register_xyz.json"
        if user_file.exists():
            user_file.unlink()

    def test_register_invalid_scope(self):
        with pytest.raises(ValueError, match="Invalid scope"):
            block_registry.register({"id": "x", "label": "X"}, scope="bogus")

    def test_register_workspace_scope_without_dir(self):
        with pytest.raises(ValueError, match="workspace"):
            block_registry.register({"id": "x", "label": "X"}, scope="workspace")

    def test_register_workspace_scope_saves_to_workspace(self, tmp_path):
        ws = tmp_path / "blocks"
        ws.mkdir()
        block_registry.set_workspace_blocks_dir(ws)
        result = block_registry.register(
            {"id": "test_ws_block_abc", "label": "WS Block"},
            scope="workspace",
        )
        assert result["id"] == "test_ws_block_abc"
        assert (ws / "test_ws_block_abc.json").exists()
        assert block_registry.get_block("test_ws_block_abc")["_source"] == "workspace"


class TestWorkspaceBlocksDir:
    """Tests for the workspace-scoped (Tier 3) block layer."""

    def test_set_workspace_adds_blocks(self, tmp_path):
        ws = tmp_path / "blocks"
        ws.mkdir()
        (ws / "ws_only_block.json").write_text(
            json.dumps({"id": "ws_only_block", "label": "WS Only"}),
            encoding="utf-8",
        )
        block_registry.set_workspace_blocks_dir(ws)
        block = block_registry.get_block("ws_only_block")
        assert block is not None
        assert block["_source"] == "workspace"

    def test_set_workspace_none_removes_workspace_blocks(self, tmp_path):
        ws = tmp_path / "blocks"
        ws.mkdir()
        (ws / "tmp_x.json").write_text(
            json.dumps({"id": "tmp_x", "label": "X"}),
            encoding="utf-8",
        )
        block_registry.set_workspace_blocks_dir(ws)
        assert block_registry.get_block("tmp_x") is not None
        block_registry.set_workspace_blocks_dir(None)
        assert block_registry.get_block("tmp_x") is None

    def test_set_workspace_nonexistent_dir(self, tmp_path):
        """Pointing at a path that doesn't exist should not crash."""
        block_registry.set_workspace_blocks_dir(tmp_path / "does_not_exist")
        # builtin/plugin_user still loaded
        assert block_registry.get_block("python_code") is not None

    def test_workspace_overrides_plugin_user(self, tmp_path, caplog):
        """A workspace block with the same id as a global block must win."""
        ws = tmp_path / "blocks"
        ws.mkdir()
        # python_code exists in _builtin/. Override its label from workspace.
        (ws / "python_code.json").write_text(
            json.dumps({"id": "python_code", "label": "WS Python Code Override"}),
            encoding="utf-8",
        )
        with caplog.at_level(logging.WARNING):
            block_registry.set_workspace_blocks_dir(ws)
        block = block_registry.get_block("python_code")
        assert block["label"] == "WS Python Code Override"
        assert block["_source"] == "workspace"
        assert any("collision" in r.message.lower() for r in caplog.records)

    def test_source_field_present_for_all_tiers(self, tmp_path):
        ws = tmp_path / "blocks"
        ws.mkdir()
        (ws / "src_test.json").write_text(
            json.dumps({"id": "src_test", "label": "T"}),
            encoding="utf-8",
        )
        block_registry.set_workspace_blocks_dir(ws)
        # Workspace tier
        assert block_registry.get_block("src_test")["_source"] == "workspace"
        # Builtin tier
        assert block_registry.get_block("python_code")["_source"] == "builtin"

    def test_switch_workspace_clears_old(self, tmp_path):
        ws1 = tmp_path / "ws1" / "blocks"
        ws2 = tmp_path / "ws2" / "blocks"
        ws1.mkdir(parents=True)
        ws2.mkdir(parents=True)
        (ws1 / "a.json").write_text(json.dumps({"id": "a", "label": "A"}), encoding="utf-8")
        (ws2 / "b.json").write_text(json.dumps({"id": "b", "label": "B"}), encoding="utf-8")
        block_registry.set_workspace_blocks_dir(ws1)
        assert block_registry.get_block("a") is not None
        assert block_registry.get_block("b") is None
        block_registry.set_workspace_blocks_dir(ws2)
        assert block_registry.get_block("a") is None
        assert block_registry.get_block("b") is not None

    def test_reload_includes_workspace(self, tmp_path):
        ws = tmp_path / "blocks"
        ws.mkdir()
        (ws / "z.json").write_text(json.dumps({"id": "z", "label": "Z"}), encoding="utf-8")
        block_registry.set_workspace_blocks_dir(ws)
        # Add a file after registration
        (ws / "z2.json").write_text(json.dumps({"id": "z2", "label": "Z2"}), encoding="utf-8")
        block_registry.reload()
        assert block_registry.get_block("z2") is not None

    def test_origin_not_leaked_to_public_view(self, tmp_path):
        ws = tmp_path / "blocks"
        ws.mkdir()
        (ws / "pubv.json").write_text(
            json.dumps({"id": "pubv", "label": "P"}),
            encoding="utf-8",
        )
        block_registry.set_workspace_blocks_dir(ws)
        for b in block_registry.load_all():
            assert "_origin" not in b
        cats = block_registry.get_blocks_by_category()
        for cat in cats.values():
            for b in cat["blocks"]:
                assert "_origin" not in b
