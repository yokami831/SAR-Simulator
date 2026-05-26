---
name: hiyocanvas
description: |
  Control HiyoCanvas visual flow editor via REST API. Use when asked to:
  build/edit flowgraphs, run Python code flows, create custom blocks,
  take canvas screenshots, or interact with HiyoCanvas (127.0.0.1:18731).
  Triggers: "canvas", "flow", "block", "node", "フロー", "ブロック", "ノード",
  or any reference to the visual flow editor.
---

# HiyoCanvas

Visual node-based flow editor with Jupyter kernel execution. All operations go through one CLI script.

```
API = python D:/Claude/HiyoCanvas/scripts/canvas_api.py
```

`API` above is shorthand for `python D:/Claude/HiyoCanvas/scripts/canvas_api.py`. Use the full path in actual commands.

**Prerequisites:** Server running + browser open at http://127.0.0.1:18731. Without browser → 503.

```bash
# Start from VSCode terminal (ELECTRON_RUN_AS_NODE must be unset):
cd D:/Claude/HiyoCanvas && unset ELECTRON_RUN_AS_NODE && npx electron .
```

**References** (read as needed):
- [references/blocks.md](references/blocks.md) — Block definitions, code_template conventions, built-in blocks
- [references/api-reference.md](references/api-reference.md) — All REST endpoints
- [references/troubleshooting.md](references/troubleshooting.md) — Common errors and fixes

## Workflow

```bash
API status                          # 1. Verify connection
API open_flow_tab '{"title":"My Flow"}'  # 2. Open a workspace (REQUIRED before block ops)
API block_schema python_code        # 3. ALWAYS check schema before add_block
API add_block '{"type":"python_code","parameters":{"label":"Generate X","code":"x = 10"}}'  # → n100
API add_block '{"type":"python_code","parameters":{"label":"Compute Y","code":"y = x * 2\nprint(y)"}}'  # → n101
API connect '{"source":"n100","source_port":"out_0","target":"n101","target_port":"in_0"}'
API auto_layout
API run
API status                          # Poll until completed
API result n101                     # → output: "20"
```

## Key Rules

1. **Use the active workspace** — Always work in the currently active workspace. Do NOT create a new workspace unless the user explicitly asks. Check `tabs` first to see which workspace is active. Only use `open_flow_tab` if no flow workspace exists yet.
2. **Workspace title is REQUIRED** — When creating a new workspace, you MUST provide a descriptive title (e.g. "Signal Analysis", "FFT Demo"). NEVER use generic names like "New Flow". The title becomes the workspace folder name. Empty titles will be rejected by the server.
3. **block_schema before add_block** — Run `block_schema <type_id>` for every block type before using. No exceptions.
4. **Always set a label** — Every `add_block` MUST include `"label":"Descriptive Name"` in parameters. Never leave the default generic label.
5. **Save node_id** — `add_block` returns `node_id`. Use these exact IDs for connect/result/tooltip. Never guess.
6. **Port naming** — Inputs: `in_0`, `in_1`, ... Outputs: `out_0`, `out_1`, ...
7. **stop before re-run** — Always `stop` then `run`. Even if status shows "stopped", call `stop` first.
8. **auto_layout ≠ view fit_all** — `auto_layout` repositions nodes. `view '{"action":"fit_all"}'` moves camera only.
9. **Verify after run** — Check `status` → `result <node_id>` → `logs`.
10. **Edges = execution order only** — Variables are shared via Jupyter kernel namespace. No data_in_0 / result convention. Use `print()` to show output on nodes.
11. **Use node names, not IDs** — When reporting to the user, always show the node's display name (`parameters.label`) instead of raw node IDs like "n100". Example: say "Data Loader (n100)" not just "Node n100". Get the flowgraph state first to read labels.
12. **ALWAYS use heredoc for code values (CRITICAL)** — When calling `set_parameter` with `param:"code"` or `add_block` with code in parameters, you MUST ALWAYS use stdin heredoc. NEVER pass code as a shell argument — quotes WILL break. Format: `cat <<'ENDJSON' | python D:/Claude/HiyoCanvas/scripts/canvas_api.py <action> -` then JSON, then `ENDJSON`. The single-quoted `<<'ENDJSON'` prevents shell expansion. This is NOT optional — every code-containing JSON must use heredoc.
13. **Canvas coordinate system** — Origin (0,0) is at the top-left. X increases rightward, Y increases downward. Coordinates are in canvas space (unaffected by zoom/pan). Typical node spacing: 250-300px horizontal, 150-200px vertical.

## Node Positioning & Sizing

Move or resize nodes with `update_node`. Changes are reflected on the canvas immediately.

```bash
API update_node '{"node_id":"n100", "position":{"x":100,"y":200}}'
API update_node '{"node_id":"n100", "width":400}'
API update_node '{"node_id":"n100", "position":{"x":0,"y":0}, "width":350, "height":200}'
```

- `position`: `{"x": number, "y": number}` — canvas coordinates
- `width` / `height`: pixels (optional, omit to keep current size)
- Use `flowgraph` to read current positions before rearranging
- Do NOT use `set_parameter` for position — it only changes block data, not canvas layout

## Block Search

Never guess block type IDs:

```bash
API search_blocks "python"
API block_schema python_code    # Then inspect exact params/ports
```

## Built-in Blocks

| type ID | Action | Purpose |
|---------|--------|---------|
| `python_code` | `add_block '{"type":"python_code","parameters":{"label":"My Node","code":"print(x)"}}'` | Run arbitrary Python |
| `comment` | `add_block '{"type":"comment","parameters":{"label":"Note","text":"memo here"}}'` | Text note (not executed) |

Nodes display rich output: `print()` → text, `plt.show()` → inline image, DataFrame → HTML table.

For code_template conventions (`${param}`), see [references/blocks.md](references/blocks.md).

## Custom Block Registration

```bash
API register_block '{"id":"my_add","label":"Adder","category":"Math","parameters":[{"id":"offset","label":"Offset","dtype":"float","default":"0"}],"inputs":[{"id":"in_0","label":"","dtype":"any"}],"outputs":[{"id":"out_0","label":"","dtype":"any"}],"code_template":"total = x + float(${offset})\nprint(total)"}'
```

Full format and code_template rules: [references/blocks.md](references/blocks.md)

## Common Operations

```bash
# Workspace management (IMPORTANT — must be in a flow workspace for block operations)
API tabs                                                # List all workspaces (* = active)
API open_flow_tab '{"title":"New Flow"}'                # Create new flow workspace
API open_flow_tab '{"workspace_folder":"my-project"}'   # Open existing workspace
API switch_tab '{"tab_id":"tab-123"}'                   # Switch workspace
API close_tab '{"tab_id":"tab-123"}'                    # Close workspace

# Workspace
API workspaces                                              # List all
API create_workspace '{"title":"My Project","type":"flow"}'

# Canvas state
API flowgraph            # Shows nodes + edges + subgraph membership
API save '{"filepath":"my_flow.json"}'
API load '{"filepath":"my_flow.json"}'

# Subgraph (group nodes visually)
API create_subgraph '{"node_ids":["n1","n2"],"label":"Group"}'
API toggle_collapse '{"subgraph_id":"n10"}'
API ungroup_subgraph '{"subgraph_id":"n10"}'

# Diagnostics
API logs                 # Console log (after run, check for warnings)
API errors               # Runtime + JS errors
API clear_logs

# Tooltip (show info on nodes)
API tooltip '{"node_id":"n1","text":"Computes x*2","type":"info"}'
API hide_tooltip '{"node_id":"n1"}'

# Screenshot (CDP) — read saved PNG with Read tool to view
API screenshot '{"mode":"full"}'
API screenshot '{"mode":"node","node_id":"n2"}'
API viewport             # Current camera position
API view '{"action":"fit_all"}'

# Edit existing nodes (use heredoc for code with quotes/special chars)
cat <<'ENDJSON' | python D:/Claude/HiyoCanvas/scripts/canvas_api.py set_parameter -
{"node_id":"n1","param":"code","value":"print(f'hello {name}')"}
ENDJSON
API set_parameter '{"node_id":"n1","param":"label","value":"My Node"}'   # Rename node header
API set_block_enabled '{"node_id":"n1","enabled":false}'               # Disable block (skip during execution, greyed out)
API set_block_enabled '{"node_id":"n1","enabled":true}'                # Re-enable block
API remove_block '{"node_id":"n1"}'
API disconnect '{"source":"n1","source_port":"out_0","target":"n2","target_port":"in_0"}'

# Raw JSON output (for parsing)
API --json status
API --json flowgraph     # Useful to see full edge details
```

## Block Enable/Disable — Use Cases

Each block has a checkbox to enable/disable execution. Disabled blocks are greyed out and skipped during `run`, but their connections are preserved.

### 1. Commenting out a block
Temporarily disable a block without removing it or its edges. Useful for debugging — disable a suspected block, re-run, and see if the problem persists.

```bash
API set_block_enabled '{"node_id":"n2","enabled":false}'   # "Comment out" block n2
API stop && API run                                         # Run without n2
API set_block_enabled '{"node_id":"n2","enabled":true}'    # Restore
```

### 2. Switching between alternative processing paths
Prepare multiple blocks that do the same job differently (e.g., FIR filter vs IIR filter, CSV loader vs API loader). Enable only one at a time to switch which path executes.

```bash
# Example: two filter blocks, only one active at a time
API add_block '{"type":"python_code","parameters":{"label":"FIR Filter","code":"y = fir_filter(x)"}}'   # → n10
API add_block '{"type":"python_code","parameters":{"label":"IIR Filter","code":"y = iir_filter(x)"}}'   # → n11
# Use FIR, disable IIR:
API set_block_enabled '{"node_id":"n10","enabled":true}'
API set_block_enabled '{"node_id":"n11","enabled":false}'
# Switch to IIR:
API set_block_enabled '{"node_id":"n10","enabled":false}'
API set_block_enabled '{"node_id":"n11","enabled":true}'
```

This pattern is like `#ifdef` in C or commenting out code — keep both implementations on the canvas and toggle which one runs.

## Limitations

- **No Undo/Redo API** — Undo/Redo is browser-only (Ctrl+Z/Y). Use `save` before destructive changes.
- **Node IDs are sequential** — Deleted IDs are not reused.
