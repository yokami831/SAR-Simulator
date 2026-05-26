"""Shared code generation utilities for HiyoCanvas."""

from backend import block_registry


def build_node_code(node: dict) -> str:
    """Build execution code for a single node.

    Resolves block type, applies parameter substitution on code_template,
    and handles GUI widget nodes (variable assignment code).
    """
    data = node.get("data", {})
    block_type = data.get("blockType") or data.get("label") or node.get("type", "")
    block_def = block_registry.get_block(block_type)
    params = data.get("parameters", {}) or node.get("parameters", {})

    # GUI widget nodes: generate variable assignment code
    if block_def and block_def.get("gui_widget"):
        var_name = params.get("var_name", "")
        if not var_name or not var_name.isidentifier():
            return ""
        value = params.get("value", "")
        dtype = block_def["gui_widget"].get("dtype", "string")
        return make_gui_assignment_code(var_name, value, dtype)

    code_template = block_def.get("code_template", "") if block_def else ""
    code = code_template
    for param_id, param_value in params.items():
        code = code.replace(f"${{{param_id}}}", param_value)
    return code


def make_gui_assignment_code(var_name: str, value, dtype: str) -> str:
    """Convert a GUI widget value to a Python variable assignment statement.

    Handles dtype: "string", "number", "boolean", "filepath", "select".
    Default (unknown dtype) uses triple-quoted string.
    """
    if dtype == "number":
        try:
            return f"{var_name} = {float(value)}"
        except (ValueError, TypeError):
            return f"{var_name} = 0"
    elif dtype == "boolean":
        py_val = "True" if str(value).lower() in ("true", "1") else "False"
        return f"{var_name} = {py_val}"
    elif dtype == "filepath":
        return f'{var_name} = r"{value}"'
    elif dtype == "select":
        escaped = str(value).replace("\\", "\\\\").replace('"', '\\"')
        return f'{var_name} = "{escaped}"'
    else:
        # string and unknown types — triple-quoted
        escaped = str(value).replace("\\", "\\\\").replace('"""', '\\"\\"\\"')
        return f'{var_name} = """{escaped}"""'
