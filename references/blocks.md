# HiyoCanvas Block Reference

## Block Definition Format

Blocks are defined as JSON files in `blocks/` directory or registered at runtime via `register_block` API.

```json
{
  "id": "my_block",
  "label": "My Block",
  "category": "General",
  "description": "What this block does",
  "parameters": [
    {"id": "param1", "label": "Param 1", "dtype": "string", "default": "hello"},
    {"id": "count", "label": "Count", "dtype": "int", "default": "10"}
  ],
  "inputs": [
    {"id": "in_0", "label": "", "dtype": "any"}
  ],
  "outputs": [
    {"id": "out_0", "label": "", "dtype": "any"}
  ],
  "code_template": "result = int(${count}) * 2"
}
```

### Parameter dtypes
- `string` — Text input
- `int` — Integer
- `float` — Floating point
- `code` — Multi-line code editor (renders as textarea in node)
- `spec` — Spec/notes editor (renders as a collapsible spec field; not substituted into `code_template`)
- `enum` — Dropdown (requires `options` list)
- `bool` — Checkbox

## code_template Conventions

The `code_template` is executed in an IPython kernel with parameter substitution only.

### Parameter substitution
`${param_id}` is replaced with the parameter's current value before execution.

```
code_template: "x = ${value} * 2"
# With value="42" → executed as: x = 42 * 2
```

### Shared kernel namespace
All nodes execute in the same Jupyter kernel session. Variables set by any node are accessible to all subsequent nodes. **Edges define execution order only** — they do not pass data between nodes.

### Execution order
1. All blocks execute in topological order (left-to-right, based on edges)
2. Each block's code runs in the same kernel session (variables persist)

### inputs/outputs
Ports exist for **edge connections** (execution ordering). They do not inject or extract data. Labels are empty by default.

## Built-in Blocks

There are 8 built-in blocks: `python_code`, `comment`, `group_spec`, and 5 GUI controls (`gui_text_input`, `gui_slider`, `gui_dropdown`, `gui_toggle`, `gui_file_picker`).

### python_code
- **Category:** Code
- **Parameters:** `spec` (dtype: spec, default empty — design notes, not executed), then `code` (Python code, dtype: code)
- **Inputs/Outputs:** `in_0`, `out_0` (for execution order edges)
- **code_template:** `${code}` — only the `code` parameter is substituted/executed; `spec` is not.
- **Execution:** Runs the `code` parameter directly. Use `print()` to display output on the node.
- **Rename:** `update_element` with `label` changes the node header. Users can also double-click or right-click the header to rename.

```bash
canvas_api.py add_element '{"type":"python_code","parameters":{"code":"y = x * 2\nprint(y)"}}'
canvas_api.py add_element '{"type":"python_code","parameters":{"code":"import numpy as np\nresult = np.fft.fft(data)"}}'
```

### comment
- **Category:** Utility
- **Parameters:** `text` (dtype: code)
- **Inputs/Outputs:** none (no ports)
- **Execution:** Not executed (`code_template` is empty). Text note / comment on the canvas.

### group_spec
- **Category:** Documentation
- **Parameters:** `text` (dtype: code) — overall design spec for a group/subgraph
- **Inputs/Outputs:** none (no ports)
- **Execution:** Not executed (`code_template` is empty).
- **Usage:** Include a `group_spec` block inside a group when grouping so the group's overall spec survives `ungroup_subgraph`.

### GUI Controls

Five GUI widget blocks (category **GUI Controls**) provide interactive inputs. They have **no ports** and an empty `code_template` — at execution time they generate a variable-assignment statement (`<var_name> = <value>`) into the shared kernel namespace, so downstream blocks can read the variable. The `var_name` and `value` parameters are common to all; each adds a few widget-specific params.

| Block | Label | Key params (beyond `var_name`, `value`) |
|-------|-------|------------------------------------------|
| `gui_text_input` | Text Input | `placeholder` |
| `gui_slider` | Slider | `min`, `max`, `step` |
| `gui_dropdown` | Dropdown | `options_csv` (comma-separated choices) |
| `gui_toggle` | Toggle | `label_on`, `label_off` |
| `gui_file_picker` | File Picker | `accept` (allowed file types) |

### Rich output
Nodes display rich output automatically:
- `print()` → text output on node
- `matplotlib plt.show()` → inline plot image on node
- `pandas DataFrame` (as last expression) → HTML table on node
- Errors → red error message on node

## Registering Custom Blocks

Use the `register_block` API to add blocks at runtime:

```bash
canvas_api.py register_block '{
  "id": "numpy_fft",
  "label": "NumPy FFT",
  "category": "Processing",
  "description": "Compute FFT using NumPy",
  "parameters": [
    {"id": "n", "label": "FFT Size", "dtype": "int", "default": "1024"}
  ],
  "inputs": [{"id": "in_0", "label": "", "dtype": "any"}],
  "outputs": [{"id": "out_0", "label": "", "dtype": "any"}],
  "code_template": "import numpy as np\nspectrum = np.abs(np.fft.fft(signal, n=${n}))\nprint(f\"FFT computed: {len(spectrum)} bins\")"
}'
```

Registered blocks persist for the current session. To make them permanent, save as JSON in `blocks/user/`.

## Block Storage

```
blocks/
  _builtin/           ← Built-in blocks (do not modify)
    python_code.json
    comment.json
    group_spec.json
    gui_text_input.json
    gui_slider.json
    gui_dropdown.json
    gui_toggle.json
    gui_file_picker.json
  user/               ← User-defined blocks (JSON files auto-loaded)
```
