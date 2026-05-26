"""Tests for backend.code_utils shared functions."""

from pathlib import Path

import pytest
from backend import block_registry
from backend.code_utils import (
    make_gui_assignment_code,
    build_node_code,
    make_gui_form_code,
    _eval_visible_when,
)

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


class TestEvalVisibleWhen:
    def test_empty_expression_is_true(self):
        assert _eval_visible_when("", {}) is True
        assert _eval_visible_when(None, {}) is True

    def test_eq_match(self):
        assert _eval_visible_when("mode == \"point\"", {"mode": "point"}) is True

    def test_eq_single_quotes(self):
        assert _eval_visible_when("mode == 'image'", {"mode": "image"}) is True

    def test_eq_no_match(self):
        assert _eval_visible_when("mode == \"point\"", {"mode": "image"}) is False

    def test_ne_match(self):
        assert _eval_visible_when("mode != \"point\"", {"mode": "image"}) is True

    def test_ne_no_match(self):
        assert _eval_visible_when("mode != \"point\"", {"mode": "point"}) is False

    def test_missing_var_eq_empty(self):
        # absent var compares as empty string
        assert _eval_visible_when("mode == \"\"", {}) is True

    def test_unknown_grammar_fails_open(self):
        # No operator -> True (show field)
        assert _eval_visible_when("weird", {"mode": "x"}) is True


class TestMakeGuiFormCode:
    def _make_def(self, fields):
        return {
            "id": "test_form",
            "label": "Test Form",
            "gui_widget": {"type": "form", "dtype": "gui_form"},
            "parameters": fields,
        }

    def test_simple_assignment(self):
        bd = self._make_def([
            {"id": "x", "widget": "slider", "var_name": "x", "dtype": "number", "default": "5"},
        ])
        code = make_gui_form_code(bd, {"x": "7"})
        assert code == "x = 7.0"

    def test_uses_default_when_missing(self):
        bd = self._make_def([
            {"id": "y", "widget": "slider", "var_name": "y", "dtype": "number", "default": "3"},
        ])
        assert make_gui_form_code(bd, {}) == "y = 3.0"

    def test_visible_when_false_skips_field(self):
        bd = self._make_def([
            {"id": "mode", "widget": "dropdown", "var_name": "mode", "dtype": "select", "default": "point"},
            {"id": "img", "widget": "file_picker", "var_name": "image_path", "dtype": "filepath", "default": "",
             "visible_when": "mode == 'image'"},
        ])
        code = make_gui_form_code(bd, {"mode": "point"})
        assert "mode" in code
        assert "image_path" not in code  # hidden, no assignment

    def test_visible_when_true_includes_field(self):
        bd = self._make_def([
            {"id": "mode", "widget": "dropdown", "var_name": "mode", "dtype": "select", "default": "image"},
            {"id": "img", "widget": "file_picker", "var_name": "image_path", "dtype": "filepath", "default": "/tmp/x.png",
             "visible_when": "mode == 'image'"},
        ])
        code = make_gui_form_code(bd, {"mode": "image", "img": "/tmp/x.png"})
        assert "mode" in code
        assert "image_path" in code

    def test_hidden_skips_field(self):
        bd = self._make_def([
            {"id": "secret", "var_name": "secret", "dtype": "string", "default": "x", "hidden": True},
        ])
        assert make_gui_form_code(bd, {}) == ""

    def test_invalid_var_name_skipped(self):
        bd = self._make_def([
            {"id": "bad", "var_name": "not a valid identifier", "dtype": "string", "default": "x"},
        ])
        assert make_gui_form_code(bd, {}) == ""

    def test_visible_when_can_reference_var_name(self):
        # Some authors will use var_name in expressions instead of field id
        bd = self._make_def([
            {"id": "mode", "widget": "dropdown", "var_name": "target_mode", "dtype": "select", "default": "point"},
            {"id": "img", "widget": "file_picker", "var_name": "image_path", "dtype": "filepath", "default": "",
             "visible_when": "target_mode == 'image'"},
        ])
        assert "image_path" not in make_gui_form_code(bd, {"mode": "point"})
        assert "image_path" in make_gui_form_code(bd, {"mode": "image", "img": "/tmp/x"})

