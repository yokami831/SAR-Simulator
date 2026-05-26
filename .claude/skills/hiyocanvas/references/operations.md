# Operation Details

Reference for all API operations. Read specific sections with:
```
Grep "### operation_name" -A 40 references/operations.md
```

## Table of Contents

- [Element Operations](#element-operations): add_element, remove_element, get_element, update_element, get_elements
- [Edge Operations](#edge-operations): connect, disconnect
- [Execution Operations](#execution-operations): start_execution, stop_execution, get_execution_status, get_execution_result
- [Tab Operations](#tab-operations): open_tab, close_tab, switch_tab, get_tabs, list_saved, delete_tab, rename_tab
- [Canvas Operations](#canvas-operations): auto_layout, clear_canvas, save_tab, load_tab
- [Subgraph Operations](#subgraph-operations): create_subgraph, set_subgraph, ungroup_subgraph
- [View Operations](#view-operations): fit_all, fit_node, zoom, get_viewport, screenshot, tooltip, hide_tooltip
- [Block Registry Operations](#block-registry-operations): register_block, get_block_schema, search_block_types
- [Diagnostics](#diagnostics): frontend_status, get_console_logs, clear_logs, get_frontend_errors
- [Batch Operations](#batch-operations): batch

---

## Element Operations

### add_element

Add a node to the canvas.

**Parameters:**
- `type` (required): Block type ID (e.g. `"python_code"`, `"comment"`)
- `parameters` (optional): Dict of parameter values. MUST include `"label"`.
- `position` (optional): `{"x": number, "y": number}`

**Example:**
```bash
API add_element '{"type":"python_code","parameters":{"label":"Data Loader","code":"x = 10"}}'
```

**With code (PowerShell stdin pipe):**
```powershell
'{"type":"python_code","parameters":{"label":"Data Loader","code":"import pandas as pd\ndf = pd.read_csv(''data.csv'')\nprint(df.head())"}}' | python .claude/skills/hiyocanvas/scripts/canvas_api.py add_element
```

**With code (bash heredoc):**
```bash
cat <<'ENDJSON' | python .claude/skills/hiyocanvas/scripts/canvas_api.py add_element -
{"type":"python_code","parameters":{"label":"Data Loader","code":"import pandas as pd\ndf = pd.read_csv('data.csv')\nprint(df.head())"}}
ENDJSON
```

**Response:**
```
[OK] add_element
  Added node: Data Loader (n100) [python_code]
```

### remove_element

Remove a node from the canvas. Connected edges are automatically removed.

**Parameters:**
- `node_id` (required): Node ID

**Example:**
```bash
API remove_element '{"node_id":"n100"}'
```

### get_element

Get full details of a node including all parameters, connections, and code.

**Parameters:**
- `node_id` (required): Node ID

**Example:**
```bash
API get_element '{"node_id":"n100"}'
```

**Response:**
```
[OK] get_element
  Node: Data Loader (n100)
    Type: python_code
    Enabled: true
    Position: (150, 200)
    Size: 300 x auto
    Parameters:
      label: Data Loader
      code: |
        import pandas as pd
        df = pd.read_csv('data.csv')
        print(df.head())
    Inputs: in_0
    Outputs: out_0 → n101:in_0
```

### update_element

Set one or more properties of an existing node.

**Parameters (these go at the TOP LEVEL of the JSON, not inside `parameters`):**
- `node_id` (required): Node ID
- `label` (optional): Display name
- `code` (optional): Python code (for python_code blocks). Or `code_file` (a path) to avoid shell escaping.
- `spec` (optional): The node's free-text description (the "Spec" panel — what the block does / its parameters).
- `enabled` (optional): true/false
- `code_collapsed` (optional): true/false
- `position` (optional): `{"x": number, "y": number}`
- `width` (optional): Pixel width
- `height` (optional): Pixel height
- `params` (optional): **dict of node-parameter values** to update — this is how you change a GUI block's value or any block parameter: `{"value": ...}`, `{"var_name": ...}`, `{"min": ..., "max": ...}`, etc.

**CAUTION — common mistakes (these now return an error instead of a silent no-op):**
- ❌ `{"node_id":"n1","parameters":{"code":"..."}}` — `update_element` does NOT take `parameters` (that's `add_element`). Use top-level `code` / `code_file`.
- ❌ `{"node_id":"n1","value":"..."}` — a GUI/block value at the top level is NOT applied. Use `params`.
- ✅ Change a GUI block's value: `{"node_id":"n1","params":{"value":"image"}}`
- Note the asymmetry: **`add_element` uses `parameters`, `update_element` uses `params`** for block parameters (and code/label/enabled at top level).

**Example (label + enabled):**
```bash
API update_element '{"node_id":"n100","label":"CSV Loader","enabled":false}'
```

**Example (GUI block value via params):**
```bash
API update_element '{"node_id":"n23","params":{"value":"2"}}'
```

**Example (code, heredoc):**
```bash
cat <<'ENDJSON' | python .claude/skills/hiyocanvas/scripts/canvas_api.py update_element -
{"node_id":"n100","code":"import numpy as np\nx = np.array([1,2,3])\nprint(x)"}
ENDJSON
```

### get_elements

List all nodes or search by text. Returns overview without code details.

**Parameters (all optional):**
- `query` (optional): Text to search in labels and block types

**Example:**
```bash
API get_elements
API get_elements '{"query":"FFT"}'
```

**Response:**
```
[OK] get_elements
  Nodes (5):
    n100: Data Loader (python_code)
    n101: FFT計算 (python_code) [DISABLED]
    n102: Plot (python_code)
  Edges (3):
    n100:out_0 → n101:in_0
    n101:out_0 → n102:in_0
  Subgraphs (1):
    sg1: Signal Processing [n101, n104]
```

---

## Edge Operations

### connect

Create an edge between two nodes.

**Parameters:**
- `source` (required): Source node ID
- `source_port` (required): Source port (e.g. `"out_0"`)
- `target` (required): Target node ID
- `target_port` (required): Target port (e.g. `"in_0"`)

**Example:**
```bash
API connect '{"source":"n100","source_port":"out_0","target":"n101","target_port":"in_0"}'
```

### disconnect

Remove an edge between two nodes. Same parameters as `connect`.

**Example:**
```bash
API disconnect '{"source":"n100","source_port":"out_0","target":"n101","target_port":"in_0"}'
```

---

## Execution Operations

### start_execution

Execute the flow. Automatically stops any previous execution before starting.

**Parameters:** None.

```bash
API start_execution
```

No need to call `stop_execution` before `start_execution` — it is handled automatically.

### stop_execution

Cancel a running flow execution.

**Parameters:** None.

```bash
API stop_execution
```

### get_execution_status

Get execution status summary. Shows each node's success/failure/time but NOT output content.

**Parameters:** None.

**Response:**
```
[OK] get_execution_status
  Status: completed (2.34s)
    n100: Data Loader — OK (0.12s)
    n101: FFT計算 — SKIPPED [DISABLED]
    n102: Plot — ERROR (0.37s): NameError: name 'fig' is not defined
    n104: Filter — OK (1.85s)
```

### get_execution_result

Get detailed execution result for a specific node.

**Parameters:**
- `node_id` (required): Node ID
- `max_lines` (optional, default: 50): Maximum output lines. `-1` for unlimited.

**Example:**
```bash
API get_execution_result '{"node_id":"n101"}'
API get_execution_result '{"node_id":"n101","max_lines":-1}'
```

---

## Tab Operations

### open_tab

Open an existing workspace or create a new one.

**Parameters:**
- `title` (optional): Title for new workspace
- `filename` (optional): Existing workspace filename to open

```bash
API open_tab '{"title":"Signal Analysis"}'
API open_tab '{"filename":"signal-analysis"}'
```

### close_tab

**Parameters:** `tab_id` (required)

```bash
API close_tab '{"tab_id":"tab-abc123"}'
```

### switch_tab

**Parameters:** `tab_id` (required)

```bash
API switch_tab '{"tab_id":"tab-abc123"}'
```

### get_tabs

List open workspaces. Active marked with `*`.

```bash
API get_tabs
```

### list_saved

List all saved workspaces on disk.

```bash
API list_saved
```

### delete_tab

**Parameters:** `filename` (required)

```bash
API delete_tab '{"filename":"old-project"}'
```

### rename_tab

**Parameters:** `filename` (required), `new_title` (required)

```bash
API rename_tab '{"filename":"old-project","new_title":"Renamed Project"}'
```

---

## Canvas Operations

> **Note:** `get_canvas` has been removed. Use `get_tab_contents '{"max_chars":200}'` instead.
> Parameters: `max_chars` (optional, default: 200): `0` = omit code, `-1` = full, positive = truncate.

### auto_layout

Automatically arrange nodes. No parameters.

```bash
API auto_layout
```

### clear_canvas

Remove all nodes and edges. No parameters.

```bash
API clear_canvas
```

### save_tab

**Parameters:** none. Auto-saves the active tab to its workspace file.

```bash
API save_tab
```

### load_tab

**Parameters:** `filepath` (required)

```bash
API load_tab '{"filepath":"my_flow.json"}'
```

---

## Subgraph Operations

### create_subgraph

**Parameters:** `node_ids` (required, min 2), `label` (required)

```bash
API create_subgraph '{"node_ids":["n101","n104"],"label":"Signal Processing"}'
```

### set_subgraph

**Parameters:** `subgraph_id` (required), optional: `label`, `description`, `collapsed`

```bash
API set_subgraph '{"subgraph_id":"sg1","label":"DSP","collapsed":true}'
```

### ungroup_subgraph

**Parameters:** `subgraph_id` (required)

```bash
API ungroup_subgraph '{"subgraph_id":"sg1"}'
```

---

## View Operations

### fit_all

Move camera to show all nodes. No parameters.

```bash
API fit_all
```

### fit_node

**Parameters:** `node_id` (required)

```bash
API fit_node '{"node_id":"n100"}'
```

### zoom

**Parameters:** `level` (required, e.g. `1.0` = 100%)

```bash
API zoom '{"level":1.5}'
```

### get_viewport

Get camera position and zoom. No parameters.

```bash
API get_viewport
```

### screenshot

Take a screenshot. Read saved PNG with Read tool to view.

**Parameters:** `mode` (`"full"` or `"node"`), `node_id` (for mode `"node"`)

```bash
API screenshot '{"mode":"full"}'
API screenshot '{"mode":"node","node_id":"n100"}'
```

### tooltip

**Parameters:** `node_id` (required), `text` (required), `type` (optional: `"info"`, `"warning"`, `"error"`)

```bash
API tooltip '{"node_id":"n100","text":"Computes x*2","type":"info"}'
```

### hide_tooltip

**Parameters:** `node_id` (required)

```bash
API hide_tooltip '{"node_id":"n100"}'
```

---

## Block Registry Operations

### register_block

Register a custom block type. See [blocks.md](blocks.md) for code_template conventions.

**Parameters:** `id`, `label`, `category`, `parameters`, `inputs`, `outputs`, `code_template`

```bash
API register_block '{"id":"my_add","label":"Adder","category":"Math","parameters":[{"id":"offset","label":"Offset","dtype":"float","default":"0"}],"inputs":[{"id":"in_0","label":"","dtype":"any"}],"outputs":[{"id":"out_0","label":"","dtype":"any"}],"code_template":"total = x + float(${offset})\nprint(total)"}'
```

### get_block_schema

**Parameters:** `type_id` (required)

```bash
API get_block_schema '{"type_id":"python_code"}'
```

### search_block_types

**Parameters:** `query` (required)

```bash
API search_block_types '{"query":"python"}'
```

---

## Diagnostics

### frontend_status

Check server connection. No parameters.

```bash
API frontend_status
```

### get_console_logs

**Parameters:** `limit` (optional, default: 20)

```bash
API get_console_logs
API get_console_logs '{"limit":50}'
```

### clear_logs

No parameters.

```bash
API clear_logs
```

### get_frontend_errors

No parameters.

```bash
API get_frontend_errors
```

---

## Batch Operations

### batch

Execute multiple operations sequentially. Stops on first error.

**Parameters:**
- `operations` (required): Array (max 20). Each: `{"operation": "...", "params": {...}}`

**Variable substitution:** `$N` references `node_id`/`edge_id` from operation N (0-indexed).

**Example:**
```bash
API batch '{"operations":[
  {"operation":"add_element","params":{"type":"python_code","parameters":{"label":"A","code":"x=1"}}},
  {"operation":"add_element","params":{"type":"python_code","parameters":{"label":"B","code":"y=x*2\nprint(y)"}}},
  {"operation":"connect","params":{"source":"$0","source_port":"out_0","target":"$1","target_port":"in_0"}}
]}'
```

**Heredoc for code-containing batch:**
```bash
cat <<'ENDJSON' | python .claude/skills/hiyocanvas/scripts/canvas_api.py batch -
{"operations":[
  {"operation":"add_element","params":{"type":"python_code","parameters":{"label":"Setup","code":"import numpy as np\nx = np.linspace(0, 2*np.pi, 100)"}}},
  {"operation":"add_element","params":{"type":"python_code","parameters":{"label":"Plot","code":"import matplotlib.pyplot as plt\nplt.plot(x, np.sin(x))\nplt.show()"}}},
  {"operation":"connect","params":{"source":"$0","source_port":"out_0","target":"$1","target_port":"in_0"}}
]}
ENDJSON
```
