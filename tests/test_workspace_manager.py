"""Tests for workspace_manager CRUD operations (single-file storage)."""

import sys
import json
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from backend import workspace_manager
from backend.config import WORKSPACES_DIR


@pytest.fixture(autouse=True)
def clean_test_workspaces():
    """Clean up test workspace files before and after each test."""
    def _cleanup():
        for f in WORKSPACES_DIR.glob("Test WS*"):
            if f.is_file():
                f.unlink()
        for f in WORKSPACES_DIR.glob("Old Name*"):
            if f.is_file():
                f.unlink()
        for f in WORKSPACES_DIR.glob("New Name*"):
            if f.is_file():
                f.unlink()
        for f in WORKSPACES_DIR.glob("Rename Test*"):
            if f.is_file():
                f.unlink()
    _cleanup()
    yield
    _cleanup()


class TestCreateWorkspace:
    def test_create_basic(self):
        result = workspace_manager.create_workspace(
            workspace_type="flow", title="Test WS Create"
        )
        assert result["filename"] == "Test WS Create.rcflow"
        assert result["title"] == "Test WS Create"
        assert (WORKSPACES_DIR / "Test WS Create.rcflow").exists()

    def test_create_mindmap(self):
        result = workspace_manager.create_workspace(
            workspace_type="mindmap", title="Test WS Mind"
        )
        assert result["filename"] == "Test WS Mind.rcmind"
        assert (WORKSPACES_DIR / "Test WS Mind.rcmind").exists()
        data = json.loads((WORKSPACES_DIR / "Test WS Mind.rcmind").read_text(encoding="utf-8"))
        assert "mindmapData" in data

    def test_create_duplicate_raises(self):
        workspace_manager.create_workspace(workspace_type="flow", title="Test WS Dup")
        with pytest.raises(ValueError, match="already exists"):
            workspace_manager.create_workspace(workspace_type="flow", title="Test WS Dup")

    def test_create_empty_title_raises(self):
        with pytest.raises(ValueError, match="cannot be empty"):
            workspace_manager.create_workspace(workspace_type="flow", title="  ")


class TestLoadWorkspace:
    def test_load_existing(self):
        workspace_manager.create_workspace(
            workspace_type="flow", title="Test WS Load"
        )
        result = workspace_manager.load_workspace("Test WS Load.rcflow")
        assert result["title"] == "Test WS Load"
        assert result["type"] == "flow"
        assert result["filename"] == "Test WS Load.rcflow"

    def test_load_nonexistent(self):
        with pytest.raises(FileNotFoundError):
            workspace_manager.load_workspace("nonexistent-file.rcflow")


class TestSaveWorkspace:
    def test_save_canvas(self):
        workspace_manager.create_workspace(workspace_type="flow", title="Test WS Save")
        canvas = {"nodes": [{"id": "n1"}], "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}}
        result = workspace_manager.save_workspace("Test WS Save.rcflow", {"canvas": canvas})
        assert result["success"] is True
        loaded = workspace_manager.load_workspace("Test WS Save.rcflow")
        assert len(loaded["canvas"]["nodes"]) == 1


class TestDeleteWorkspace:
    def test_delete_existing(self):
        workspace_manager.create_workspace(
            workspace_type="flow", title="Test WS Delete"
        )
        result = workspace_manager.delete_workspace("Test WS Delete.rcflow")
        assert result["success"] is True
        assert not (WORKSPACES_DIR / "Test WS Delete.rcflow").exists()

    def test_delete_nonexistent(self):
        with pytest.raises(FileNotFoundError):
            workspace_manager.delete_workspace("nonexistent-file.rcflow")


class TestRenameWorkspace:
    def test_rename(self):
        workspace_manager.create_workspace(
            workspace_type="flow", title="Old Name"
        )
        result = workspace_manager.rename_workspace("Old Name.rcflow", "New Name")
        assert result["title"] == "New Name"
        assert result["filename"] == "New Name.rcflow"
        assert not (WORKSPACES_DIR / "Old Name.rcflow").exists()
        assert (WORKSPACES_DIR / "New Name.rcflow").exists()
        loaded = workspace_manager.load_workspace("New Name.rcflow")
        assert loaded["title"] == "New Name"

    def test_rename_empty_title(self):
        workspace_manager.create_workspace(
            workspace_type="flow", title="Test WS RenameEmpty"
        )
        with pytest.raises(ValueError):
            workspace_manager.rename_workspace("Test WS RenameEmpty.rcflow", "")

    def test_rename_same_title(self):
        workspace_manager.create_workspace(
            workspace_type="flow", title="Test WS SameName"
        )
        result = workspace_manager.rename_workspace("Test WS SameName.rcflow", "Test WS SameName")
        assert result["success"] is True


class TestPathTraversal:
    def test_load_traversal_raises(self):
        with pytest.raises(ValueError, match="Invalid filename"):
            workspace_manager.load_workspace("../../etc/passwd")

    def test_save_traversal_raises(self):
        with pytest.raises(ValueError, match="Invalid filename"):
            workspace_manager.save_workspace("../../etc/passwd", {})

    def test_delete_traversal_raises(self):
        with pytest.raises(ValueError, match="Invalid filename"):
            workspace_manager.delete_workspace("../../etc/passwd")

    def test_rename_traversal_old_raises(self):
        with pytest.raises(ValueError, match="Invalid filename"):
            workspace_manager.rename_workspace("../../etc/passwd", "safe")

    def test_rename_traversal_new_raises(self):
        workspace_manager.create_workspace(workspace_type="flow", title="Test WS Trav")
        with pytest.raises(ValueError):
            workspace_manager.rename_workspace("Test WS Trav.rcflow", "../../evil")


class TestInvalidFilenameChars:
    @pytest.mark.parametrize("char", [':', '?', '*', '"', '<', '>', '|', '\\', '/'])
    def test_create_rejects_invalid_chars(self, char):
        with pytest.raises(ValueError, match="not allowed in filenames"):
            workspace_manager.create_workspace(workspace_type="flow", title=f"Test{char}Name")

    def test_rename_rejects_colon(self):
        workspace_manager.create_workspace(workspace_type="flow", title="Rename Test")
        with pytest.raises(ValueError, match="not allowed in filenames"):
            workspace_manager.rename_workspace("Rename Test.rcflow", "Bad:Name")


class TestListWorkspaces:
    def test_list_includes_created(self):
        workspace_manager.create_workspace(workspace_type="flow", title="Test WS List")
        workspaces = workspace_manager.list_workspaces()
        titles = [w["title"] for w in workspaces]
        assert "Test WS List" in titles
