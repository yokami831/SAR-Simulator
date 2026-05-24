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
        widget_dtype = block_def["gui_widget"].get("dtype", "string")
        # Multi-parameter widgets (e.g. sar_visualizer) emit several kernel
        # variables from one node. Each parameter def carries "var" (kernel
        # variable name) and "scale" (numeric multiplier, "deg2rad", or "str").
        if widget_dtype == "sar_params":
            return make_sar_params_code(block_def, params)
        var_name = params.get("var_name", "")
        if not var_name or not var_name.isidentifier():
            return ""
        value = params.get("value", "")
        return make_gui_assignment_code(var_name, value, widget_dtype)

    code_template = block_def.get("code_template", "") if block_def else ""
    code = code_template
    for param_id, param_value in params.items():
        code = code.replace(f"${{{param_id}}}", param_value)
    return code


def make_sar_params_code(block_def: dict, params: dict) -> str:
    """Generate kernel variable assignments for a sar_visualizer node.

    Reads each parameter definition's "var" (kernel variable name) and "scale"
    (a numeric multiplier as a string, the literal "deg2rad", or "str") and
    converts the node's current value (or the param default) into a Python
    assignment. Produces a `math` import plus one assignment per variable, e.g.:

        import math
        H = 514.0 * 1000.0
        look = math.radians(25.0)
        chirp_dir = "up"

    Variables whose def lacks "var" are skipped. Unparseable numbers surface as
    a clear comment rather than silently defaulting (CLAUDE.md: no silent
    fallbacks).

    After the assignments, the block's ``code_template`` is appended verbatim.
    For sar_visualizer this carries the imports (numpy / scipy.constants) and the
    library helpers (make_rand / make_point_targets) so the node fully replaces
    the workspace's Common Parameters node when that one is disabled.
    """
    # numpy + scipy.constants.c so downstream SAR nodes (and the appended
    # helpers) have the same environment the Common Parameters node provided.
    lines = [
        "import math  # sar_visualizer parameter assignments",
        "import numpy as np",
        "from scipy.constants import c",
    ]
    for pdef in block_def.get("parameters", []):
        var = pdef.get("var")
        if not var or not str(var).isidentifier():
            continue
        pid = pdef.get("id")
        raw = params.get(pid, pdef.get("default", ""))
        scale = str(pdef.get("scale", "1"))
        if scale == "str":
            escaped = str(raw).replace("\\", "\\\\").replace('"', '\\"')
            lines.append(f'{var} = "{escaped}"')
            continue
        try:
            num = float(raw)
        except (ValueError, TypeError):
            lines.append(f"# {var}: could not parse {raw!r} from param {pid!r}")
            continue
        if scale == "deg2rad":
            lines.append(f"{var} = math.radians({num})")
        else:
            try:
                factor = float(scale)
            except (ValueError, TypeError):
                factor = 1.0
            if factor == 1.0:
                lines.append(f"{var} = {num}")
            else:
                # Emit a single exponent literal (e.g. "10e-6", "514e3") rather
                # than "10.0 * 1e-06". The literal form is parsed as one float
                # and so reproduces values like Tp=10e-6 (=1e-05) bit-for-bit,
                # matching the original Common Parameters node. "10.0 * 1e-06"
                # rounds to 9.999...e-06 and perturbs downstream results.
                import math as _math
                exp = _math.log10(factor)
                if abs(exp - round(exp)) < 1e-9:
                    e = int(round(exp))
                    # render value without a trailing ".0" when integral
                    vs = f"{num:.0f}" if num == int(num) else repr(num)
                    lines.append(f"{var} = {vs}e{e}")
                else:
                    lines.append(f"{var} = {num} * {factor}")
    code = "\n".join(lines)
    template = block_def.get("code_template", "")
    if template:
        code = code + "\n\n" + template
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
