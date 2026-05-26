"""Tests for backend.code_utils shared functions."""

from pathlib import Path

import pytest
from backend import block_registry
from backend.code_utils import make_gui_assignment_code, build_node_code

# Ensure blocks are loaded for build_node_code tests
_blocks_dir = Path(__file__).parent.parent / "backend" / "plugins" / "python_canvas" / "blocks"
if not block_registry._cache:
    block_registry.register_block_dir(_blocks_dir)


class TestMakeGuiAssignmentCode:
    """Test make_gui_assignment_code for all dtype variants."""

    def test_number_int(self):
        assert make_gui_assignment_code("x", "42", "number") == "x = 42.0"

    def test_number_float(self):
        assert make_gui_assignment_code("x", "3.14", "number") == "x = 3.14"

    def test_number_invalid_returns_zero(self):
        assert make_gui_assignment_code("x", "abc", "number") == "x = 0"

    def test_number_none_returns_zero(self):
        assert make_gui_assignment_code("x", None, "number") == "x = 0"

    def test_boolean_true(self):
        assert make_gui_assignment_code("flag", "true", "boolean") == "flag = True"

    def test_boolean_one(self):
        assert make_gui_assignment_code("flag", "1", "boolean") == "flag = True"

    def test_boolean_false(self):
        assert make_gui_assignment_code("flag", "false", "boolean") == "flag = False"

    def test_boolean_zero(self):
        assert make_gui_assignment_code("flag", "0", "boolean") == "flag = False"

    def test_filepath(self):
        result = make_gui_assignment_code("path", "C:\\data\\file.txt", "filepath")
        assert result == 'path = r"C:\\data\\file.txt"'

    def test_select(self):
        result = make_gui_assignment_code("mode", "fast", "select")
        assert result == 'mode = "fast"'

    def test_select_with_quotes(self):
        result = make_gui_assignment_code("s", 'say "hi"', "select")
        assert result == 's = "say \\"hi\\""'

    def test_string_default(self):
        result = make_gui_assignment_code("msg", "hello world", "string")
        assert result == 'msg = """hello world"""'

    def test_string_with_triple_quotes(self):
        result = make_gui_assignment_code("s", 'a"""b', "string")
        assert '"""' not in result.split("= ", 1)[1].strip('"""') or '\\"' in result

    def test_unknown_dtype_uses_triple_quotes(self):
        result = make_gui_assignment_code("x", "val", "custom_type")
        assert result == 'x = """val"""'

    def test_empty_value(self):
        result = make_gui_assignment_code("x", "", "string")
        assert result == 'x = """"""'


class TestBuildNodeCode:
    """Test build_node_code with mock block registry data."""

    def test_no_block_def_returns_empty(self):
        """Node with unknown block type returns empty code."""
        node = {"id": "n1", "data": {"blockType": "nonexistent"}}
        assert build_node_code(node) == ""

    def test_python_code_block(self):
        """Python code block uses code parameter directly."""
        node = {
            "id": "n1",
            "data": {
                "blockType": "python_code",
                "parameters": {"code": "print('hello')", "label": "Test"},
            },
        }
        code = build_node_code(node)
        assert "print('hello')" in code

    def test_comment_block_returns_empty(self):
        """Comment block has no code_template, returns empty."""
        node = {
            "id": "n1",
            "data": {
                "blockType": "comment",
                "parameters": {"text": "This is a note", "label": "Note"},
            },
        }
        code = build_node_code(node)
        assert code.strip() == ""

    def test_node_without_data(self):
        """Node with no data dict returns empty."""
        node = {"id": "n1"}
        assert build_node_code(node) == ""

    def test_parameter_substitution(self):
        """Parameters are substituted in code_template."""
        # Register a temporary block for testing
        from backend import block_registry
        block_registry._cache["_test_sub"] = {
            "id": "_test_sub",
            "label": "Test Sub",
            "code_template": "x = ${value}\nprint(x)",
            "parameters": [],
        }
        try:
            node = {
                "id": "n1",
                "data": {
                    "blockType": "_test_sub",
                    "parameters": {"value": "42"},
                },
            }
            code = build_node_code(node)
            assert "x = 42" in code
            assert "print(x)" in code
        finally:
            block_registry._cache.pop("_test_sub", None)
