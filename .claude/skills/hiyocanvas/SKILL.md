---
name: hiyocanvas
description: |
  Control HiyoCanvas visual workspace via REST API. Use when asked to:
  build/edit flowgraphs, work with mindmaps, create/edit notes,
  run Python code flows, create custom blocks, take canvas screenshots,
  or interact with HiyoCanvas (127.0.0.1:18731).
  Triggers: "canvas", "flow", "block", "node", "mindmap", "notes",
  "フロー", "ブロック", "ノード", "マインドマップ", "ノート",
  or any reference to the visual workspace editor.
---

# HiyoCanvas

Visual workspace app with multiple tab types (flow editor, mindmap, notes, drawing, and more).

**Architecture:**
```
Claude Code (this side - Agent)
  ↓ CLI command
canvas_api.py (HTTP client)
  ↓ http://127.0.0.1:18731/api/tools/
HiyoCanvas Server (FastAPI + Electron + React Flow)
  ↓
Frontend (WebSocket) / Jupyter Kernel
  ↓ result
canvas_api.py
  ↓ text output
Claude Code (receives result)
```

```
API = python ${CLAUDE_SKILL_DIR}/scripts/canvas_api.py
```

`API` above is shorthand for `python ${CLAUDE_SKILL_DIR}/scripts/canvas_api.py`. Use the full path in actual commands.

**Prerequisites:** Server running + browser open at http://127.0.0.1:18731. Without browser → 503.

```powershell
# Start from VSCode terminal (use ctl.py which handles ELECTRON_RUN_AS_NODE automatically):
.venv\Scripts\python.exe .claude\skills\hiyocanvas-bridge\scripts\ctl.py start
```

**Output format:** canvas_api.py outputs `[OK] action_name` or `[FAIL] action_name` on the first line, followed by human-readable formatted output. Some commands return JSON, others return key-value text.

**For programmatic use:** Add `--json` flag to get raw JSON output (no `[OK]`/`[FAIL]` prefix, no formatting):
```powershell
API --json get_element '{"node_id":"n1"}'   # Returns raw JSON
```

**References** (read before using unfamiliar operations):
- [references/blocks.md](references/blocks.md) — Block definitions, code_template conventions, built-in blocks
- [references/troubleshooting.md](references/troubleshooting.md) — Common errors and fixes
- [references/rich-display.md](references/rich-display.md) — CadQuery 3D, VRM/GLTF, plotly, SVG templates
- [references/hdl-simulation.md](references/hdl-simulation.md) — HDL simulation with Amaranth, fixed-point verification

## Command Format

```powershell
API <operation>                                    # No parameters
'{"key":"value"}' | API <operation>                # With JSON (stdin pipe)
```

**Always use stdin pipe for JSON parameters.** Do NOT pass JSON as a command-line argument (PS 5.1 strips double quotes):

```powershell
'{"node_id":"n100"}' | API get_element
'{"type":"python_code","parameters":{"label":"My Block","code":"x = 1"}}' | API add_element
```

**`@file` pattern** — use when JSON exceeds 100KB **OR contains non-ASCII text (Japanese, etc.)**. Write JSON to a temp file (UTF-8), then pass with single-quoted `'@file'`:

```powershell
API tab_action '@tmp_scene.json'
```

> ⚠️ **CRITICAL — Japanese / non-ASCII via PowerShell stdin corrupts data.**
> Piping a JSON string with Japanese through PowerShell stdin
> (`'{...日本語...}' | API ...`) silently mangles **the persisted data**
> (Notes pages, mindmap topics, labels) into `?` characters — not just
> the console echo. Windows PowerShell 5.1 passes the bytes through cp932
> and the multibyte text is destroyed before Python sees it.
> **Always** use the `@file` pattern for any JSON containing non-ASCII,
> regardless of size: write the JSON with the Write tool (UTF-8), then
> `API --json <op> '@D:\abs\path\payload.json'` (single quotes required).
> ASCII-only JSON is fine via stdin. After writing non-ASCII, **verify
> with a screenshot** — the CLI's title echo may show `?` even when the
> stored data is correct, and vice versa, so the console line is not
> proof either way.

## Output Format

All commands return structured text:

```
[OK] <operation>
  <result details>
```

On failure:
```
[FAIL] <operation>
  Error: <error message>
```

- `[OK]` = success, `[FAIL]` = failure — AI can check the first word for status
- Result details are human-readable text (not JSON)

## Tab Types

**CRITICAL: Always run `get_tabs` first to check the active tab type before using any command.**

HiyoCanvas has multiple tab types. Each type has its own commands. Operate on the ACTIVE tab — when the user says "nodes", "check the canvas", etc., use commands for whatever tab is active. Do NOT suggest switching unless the user explicitly asks.

| Tab Type | Description | File Extension | Key Commands |
|----------|-------------|----------------|--------------|
| **flow** | Visual node editor with Jupyter execution | `.rcflow` | `get_elements`, `add_element`, `start_execution`, etc. |
| **mindmap** | Mind map workspace | `.rcmind` | `tab_action` with `get_elements` / `set_data` / `add_element` / etc. |
| **notes** | Notion-style block editor (multi-page) | `.rcnotes` | `tab_action` with `get_elements` / `set_data` |
| **excalidraw** | Freeform drawing whiteboard | `.rcexcalidraw` | `tab_action` with `get_elements` / `set_data` / `add_element` / etc. |
| **files** | File explorer with project folder | `.rcfiles` | `tab_action` with `get_elements` / `open_file` / `list_history` / `navigate` / `set_data` |

**`get_tab_contents`** — Returns the active tab's type and contents in one call. Automatically uses the correct method for each tab type. Always start here.

- Tab-specific commands on the wrong tab return an error (e.g. `"This command requires a Flow tab"`).
- Universal commands work on any tab (see Universal Commands section below).

---

## Flow Tab

### Quick Start

```powershell
API frontend_status                                  # 1. Verify connection
API get_tabs                                         # 2. Check open tabs
'{"title":"Signal Analysis"}' | API open_tab         # 3. Open tab (if needed)
'{"type_id":"python_code"}' | API get_block_schema   # 4. Check schema before add
'{"type":"python_code","parameters":{"label":"Generate X","code":"x = 10"}}' | API add_element  # → n100
'{"type":"python_code","parameters":{"label":"Compute Y","code":"y = x * 2\nprint(y)"}}' | API add_element  # → n101
'{"source":"n100","source_port":"out_0","target":"n101","target_port":"in_0"}' | API connect
API auto_layout
API start_execution
API get_execution_status                             # Check execution result
'{"node_id":"n101"}' | API get_execution_result      # → output: "20"
```

### Key Rules

1. **get_block_schema before add_element** — Run `get_block_schema` for every block type before using. No exceptions.
2. **Always set a label** — Every `add_element` MUST include `"label":"Descriptive Name"` in parameters.
   - **`code` and `label` go inside `parameters`**, NOT at the top level:
     ```json
     ✅ {"type":"python_code","parameters":{"label":"My Block","code":"x = 1"}}
     ✗  {"type":"python_code","label":"My Block","code":"x = 1"}
     ```
   - Top-level `code`/`label` are auto-lifted into `parameters` with a warning. Unknown top-level keys cause an error.
3. **Save node_id** — `add_element` returns `node_id`. Use these exact IDs for all subsequent operations. Never guess.
4. **Port naming** — Inputs: `in_0`, `in_1`, ... Outputs: `out_0`, `out_1`, ...
5. **Verify after run** — Check `get_execution_status` → `get_execution_result` → `get_console_logs`.
6. **Edges = execution order only** — Variables are shared via Jupyter kernel namespace. Use `print()` to show output on nodes.
7. **Use node names, not IDs** — When reporting to the user, say "Data Loader (n100)" not "Node n100".
8. **Use `code_file` when code exceeds 20 lines or contains SVG/HTML** — Write code to a temp file and use `code_file`:
    ```powershell
    # Write code to file (use Write tool), then:
    '{"node_id":"n1","code_file":"tmp_code.py"}' | API update_element
    ```
9. **`@file` for JSON over 100KB OR containing non-ASCII (Japanese)** — Write JSON to a UTF-8 temp file and pass with `'@file'` (single quotes required). ASCII-only JSON under 100KB uses stdin pipe. PowerShell stdin corrupts Japanese into `?` — see the ⚠️ note in Command Format.
10. **Canvas coordinate system** — Origin (0,0) top-left. X→right, Y→down. Typical spacing: 250-300px horizontal, 150-200px vertical.
11. **auto_layout vs fit_all** — `auto_layout` repositions nodes. `fit_all` only moves the camera.
12. **Verify after update_element with code** — Run `get_element` to confirm the code was actually updated.

### Commands

| Operation | Description |
|-----------|-------------|
| `add_element` | Add element to the canvas |
| `remove_element` | Remove element |
| `get_element` | Get element details |
| `update_element` | Update element properties |
| `get_elements` | List/search elements |
| `connect` | Create edge between nodes |
| `disconnect` | Remove edge |
| `start_execution` | Execute the flow (alias: `run`) |
| `stop_execution` | Cancel execution (alias: `stop`) |
| `get_execution_status` | Get execution status summary |
| `get_execution_result` | Get node execution result |
| `step_start` | Start step execution |
| `step_next` | Execute next single block |
| `step_reset` | Reset step execution |
| `run_remaining` | Execute all remaining blocks |
| `get_tab_contents` | Get active tab type + contents (with optional `max_chars`) |
| `auto_layout` | Auto-arrange nodes |
| `clear_canvas` | Remove all nodes and edges |
| `save_tab` | Save active tab (any type: flow/mindmap/excalidraw/notes). No arguments needed |
| `load_tab` | Load flow tab from file |
| `create_subgraph` | Group nodes |
| `set_subgraph` | Set subgraph properties |
| `ungroup_subgraph` | Ungroup nodes |
| `register_block` | Register custom block type |
| `get_block_schema` | Get block type definition |
| `search_block_types` | Search registered block types |

### Built-in Block Types

| Type ID | Purpose |
|---------|---------|
| `python_code` | Run arbitrary Python code. Parameters: `label`, `code` |
| `comment` | Text note (not executed). Parameters: `label`, `text` |

Nodes display rich output: `print()` → text, `plt.show()` → inline image, DataFrame → HTML table, `display(SVG(...))` → inline SVG. For 3D/HTML/SVG templates, see [references/rich-display.md](references/rich-display.md).

**IMPORTANT:** Do NOT use `matplotlib.use("Agg")` in node code — it disables Jupyter inline display capture and `plt.show()` will produce no output. The kernel handles the backend automatically.

### GUI Controls (Widget Blocks)

GUI widget blocks set kernel variables directly via UI controls. During flow execution, they generate assignment code (e.g. `freq = 1000.0`).

| Type ID | Widget | Key Parameters |
|---------|--------|----------------|
| `gui_text_input` | Text area | `var_name`, `value`, `placeholder` |
| `gui_slider` | Numeric slider | `var_name`, `value`, `min`, `max`, `step` |
| `gui_dropdown` | Select menu | `var_name`, `value`, `options_csv` |
| `gui_toggle` | On/Off switch | `var_name`, `value` (true/false) |
| `gui_file_picker` | File chooser | `var_name`, `value` (file path), `accept` |

**API usage:** Use `params` in `update_element` to set widget parameters:
```powershell
# Slider
'{"type":"gui_slider"}' | API add_element                    # → n1
'{"node_id":"n1","params":{"var_name":"freq","value":"1000","min":"100","max":"10000"}}' | API update_element

# Dropdown (options are comma-separated)
'{"node_id":"n2","params":{"var_name":"mode","options_csv":"AM,FM,PM"}}' | API update_element

# File Picker — accept format: extensions without dots, comma or semicolon separated
'{"node_id":"n3","params":{"var_name":"config","accept":"yaml,yml"}}' | API update_element
# Also OK: "*.yaml;*.yml" or ".yaml,.yml" (prefixes are auto-stripped)
```

> GUI widget values are stored on the node and assigned to kernel variables only
> during flow execution (topological order). There is no out-of-band immediate send.

**`params` dict** works for all block types, not just GUI widgets:
```powershell
'{"node_id":"n2","params":{"filepath":"data.csv"}}' | API update_element
```

### Node Enable/Disable

Disabled nodes are greyed out and skipped during `start_execution`, but connections are preserved.

```powershell
'{"node_id":"n2","enabled":false}' | API update_element   # Disable (comment out)
'{"node_id":"n2","enabled":true}' | API update_element    # Re-enable
```

### Error Handling

When `get_execution_status` shows ERROR, always use `get_execution_result` for the full traceback:
```powershell
API get_execution_status                          # Shows brief status (may truncate errors)
'{"node_id":"n2"}' | API get_execution_result    # Full error traceback for specific node
```

### Step Execution

Execute flow one block at a time for debugging:
```powershell
API step_start                   # Prepare kernel + compute execution order
API step_next                    # Execute next block
API run_remaining                # Run all remaining blocks at once
API step_reset                   # Cancel stepping, return to idle
```

---

## Mindmap Tab

### Quick Start

```powershell
API get_tabs                                          # 1. Check active tab
'{"filename":"my-mindmap.rcmind"}' | API open_tab          # 2. Open mindmap (if needed)
'{"action":"get_elements"}' | API tab_action               # 3. Get current nodes
'{"action":"set_data","mindmapData":{"nodeData":{"id":"root","topic":"Main"}}}' | API tab_action  # 4. Update
```

### Commands

| Operation | Action | Description |
|-----------|--------|-------------|
| `tab_action` | `get_elements` | Get mindmap tree (text + JSON) |
| `tab_action` | `get_element` | Get single node details (`elementId`) |
| `tab_action` | `add_element` | Add child node (`parentId`, `topic`) |
| `tab_action` | `remove_element` | Remove node (`elementId`) |
| `tab_action` | `update_element` | Edit node (`elementId` + any fields below) |
| `tab_action` | `set_data` | Set mindmap data (full replace with refresh) |

### Node Data Structure

```json
{
  "nodeData": {
    "id": "unique-id",
    "topic": "Node text",
    "children": [
      { "id": "child-id", "topic": "Child text", "children": [] }
    ]
  }
}
```

- `id`: Unique string (e.g. `"n1"`, `"abc123"`)
- `topic`: Display text
- `children`: Array of child nodes (recursive)
- `direction`: Optional. `0`=left, `1`=right (root's direct children only)
- `style`: Optional. `{ color, background, fontSize, fontWeight }` — node appearance
- `tags`: Optional. `["tag1", "tag2"]` — displayed as labels on the node
- `icons`: Optional. `["⭐", "🔥"]` — emoji icons on the node
- `hyperLink`: Optional. URL string
- `note`: Optional. Note text (shown on hover)
- `branchColor`: Optional. CSS color for the branch line (e.g. `"#00ff00"`)

### Tips

- Always `get_elements` first to preserve existing nodes
- Add nodes by appending to the appropriate `children` array
- Remove nodes by filtering them out of `children`
- Edit text by changing the `topic` field
- **Sequential execution recommended** — Do NOT use `&` to run mindmap operations in parallel. Concurrent writes to the mindmap tree can cause race conditions. Use `&&` for sequential chaining.
- **set_data vs individual operations**: 1-2 node changes → `add_element`/`update_element`/`remove_element`を個別に呼ぶ。3個以上のノードを一度に変更する場合 → `set_data`（全置換）。

---

## Excalidraw Tab (Drawing)

Excalidraw whiteboard for freeform diagrams, flowcharts, architecture sketches.

### Quick Start

```powershell
'{"title":"My Drawing","type":"excalidraw"}' | API open_tab     # 1. Open excalidraw tab
'{"action":"get_elements"}' | API tab_action                      # 2. Get elements (summary)
'{"action":"get_element","elementId":"abc"}' | API tab_action     # 3. Get full detail of one element
API tab_action @scene.json                                  # 4. Set scene via @file
```

### Commands

| Operation | Action | Description |
|-----------|--------|-------------|
| `tab_action` | `get_elements` | Get all elements (compact summary) |
| `tab_action` | `get_element` | Get full element data (`elementId`) |
| `tab_action` | `set_data` | Replace entire scene (`elements`, optional `appState`, `files`) |
| `tab_action` | `add_element` | Add element(s) (`element` or `elements`, optional `files`) |
| `tab_action` | `update_element` | Update element props (`elementId`, `props`) |
| `tab_action` | `remove_element` | Remove element (`elementId`) |
| `tab_action` | `clear` | Clear entire scene |
| `tab_action` | `get_selection` | Get currently selected elements |
| `tab_action` | `import_mermaid` | Import Mermaid diagram as editable elements (`mermaid`: string) |
| `tab_action` | `import_structure` | Import structure diagram (`diagram`: object) — **AI must use this, not import_mermaid** |

### get_elements Response (Summary)

`get_elements` returns a **compact summary** (not full Excalidraw data). Each element includes only essential fields:

```json
{
  "elements": [
    { "id": "abc", "type": "rectangle", "x": 100, "y": 200, "width": 300, "height": 150,
      "strokeColor": "#1e1e1e", "backgroundColor": "#a5d8ff", "label": "FFT Block" },
    { "id": "def", "type": "arrow", "x": 400, "y": 275, "width": 60, "height": 0,
      "startBinding": "abc", "endBinding": "ghi" },
    { "id": "ghi", "type": "text", "x": 100, "y": 80, "text": "Title", "fontSize": 28 }
  ],
  "count": 3
}
```

- Bound text is resolved as `label` on the parent shape (bound text elements are excluded)
- Arrow `startBinding`/`endBinding` show connected element IDs
- Use `get_element` with `elementId` for full Excalidraw properties of a single element

### Element Types

- `rectangle`, `ellipse`, `diamond` — shapes (use `label` for text inside)
- `text` — standalone text
- `arrow`, `line` — connectors (use `points` for path)
- `freedraw` — freehand drawing

### Writing Elements (set_data / add_element)

**`label` is an OBJECT, not a string.** This is the most common mistake:

```json
// WRONG — label ignored, no text appears:
{ "type": "rectangle", "label": "FFT Block", ... }

// CORRECT — text auto-centered inside shape:
{ "type": "rectangle", "label": { "text": "FFT Block" }, ... }

// With options:
{ "type": "rectangle", "label": { "text": "FFT Block", "fontSize": 16, "strokeColor": "#ffffff" }, ... }
```

Arrow labels also use the same object syntax:
```json
{ "type": "arrow", "label": { "text": "data flow" }, "points": [[0,0],[100,0]], ... }
```

### Reading Elements (get_elements response)

In `get_elements` summary response, `label` is a **plain string** (for readability):
```json
{ "id": "abc", "type": "rectangle", "label": "FFT Block", ... }
```
This is read-only. When writing back, convert to object: `{ "text": "FFT Block" }`.

### Updating Labels

To change the text inside a shape, use `update_element` with `label` or `text` in `props`:
```powershell
'{"action":"update_element","elementId":"abc","props":{"label":"New Label"}}' | API tab_action
```
This automatically updates the bound text element. Do NOT try to update the bound text element directly.

### Tips

- Use `'@file'` only when JSON exceeds 100KB
- Set `roughness: 1` for hand-drawn style, `0` for clean lines
- Dark mode: include `"appState": {"theme": "dark"}` in `set_data`
- Standalone `text` elements don't need `label` — use `text` property directly
- **set_data vs individual operations**: 1-2要素の変更 → `add_element`/`update_element`/`remove_element`を個別に呼ぶ。3個以上の要素を一度に変更する場合 → `set_data`（全シーン置換）。
- **type changes** (e.g. rectangle→diamond): Use `update_element` with `props: {"type":"diamond"}`. Works for basic shape changes.

### Structure Diagram (import_structure) — AI MUST use this

**AIがフロー図・ブロック図を描くときはこれを使う。** コンパクトな構造JSON（ノード+エッジ）を渡すだけで、Excalidrawネイティブ要素に変換される。手書き風スタイルが維持され、個別要素の編集も可能。

**`import_mermaid` は使用禁止。** Mermaidはユーザーが手動でUI上のボタンから入力する専用機能。AIは常に `import_structure` を使うこと。

#### Structure JSON Format

```json
{
  "diagram": {
    "title": {"text": "My Diagram", "x": 300, "y": 10, "fontSize": 24, "color": "#89b4fa"},
    "nodes": [
      {"id": "a", "type": "rect",    "x": 50,  "y": 80, "w": 90, "h": 50, "text": "Start",  "stroke": "#f38ba8", "bg": "#45475a"},
      {"id": "b", "type": "diamond", "x": 200, "y": 70, "w": 80, "h": 70, "text": "OK?",    "stroke": "#f9e2af", "bg": "#3d3000"},
      {"id": "c", "type": "ellipse", "x": 350, "y": 80, "w": 70, "h": 50, "text": "Done",   "stroke": "#a6e3a1", "bg": "#1a3d1a"}
    ],
    "edges": [
      {"from": "a", "to": "b", "color": "#cdd6f4"},
      {"from": "b", "to": "c", "color": "#a6e3a1", "text": "Yes"}
    ],
    "annotations": [
      {"type": "text", "x": 50, "y": 180, "text": "Note: example diagram", "fontSize": 14, "color": "#888"}
    ]
  }
}
```

#### Node Properties

| Property | Required | Default | Description |
|----------|----------|---------|-------------|
| `id` | Yes | — | Unique ID (used by edges for `from`/`to`) |
| `type` | Yes | — | `rect`, `ellipse`, `diamond` |
| `x`, `y` | Yes | — | Position (top-left corner) |
| `w`, `h` | Yes | — | Width and height |
| `text` | No | — | Label text inside the shape |
| `stroke` | No | `#ffffff` | Border/text color |
| `bg` | No | — | Fill color |
| `fontSize` | No | 15 | Label font size |
| `strokeWidth` | No | 2 | Border width |

#### Edge Properties

| Property | Required | Default | Description |
|----------|----------|---------|-------------|
| `from` | Yes | — | Source node ID |
| `to` | Yes | — | Target node ID |
| `color` | No | `#ffffff` | Arrow color |
| `dir` | No | right | Direction: `right`, `down`, `up`, `left` |
| `text` | No | — | Label on the arrow |
| `strokeWidth` | No | 2 | Arrow width |

#### Usage via @file

```powershell
# Write structure JSON to file, then send
API tab_action '@my_diagram.json'
```

Where `my_diagram.json` contains:
```json
{"action": "import_structure", "diagram": {"nodes": [...], "edges": [...]}}
```

#### Behavior

- If canvas has existing elements, new elements are placed **below** (80px gap)
- To **replace** the scene instead, add `"append": false`
- All elements become native Excalidraw shapes — individually movable, resizable, recolorable
- Uses Excalidraw's hand-drawn rendering style

#### Example: Pipeline Diagram

```json
{"action": "import_structure", "diagram": {
  "title": {"text": "Data Pipeline", "x": 200, "y": 10, "color": "#89b4fa"},
  "nodes": [
    {"id": "src", "type": "rect", "x": 30,  "y": 70, "w": 90, "h": 50, "text": "Source",  "stroke": "#89b4fa", "bg": "#1e3a5f"},
    {"id": "tfm", "type": "rect", "x": 180, "y": 70, "w": 90, "h": 50, "text": "Transform","stroke": "#f9e2af", "bg": "#3d3000"},
    {"id": "dst", "type": "rect", "x": 330, "y": 70, "w": 90, "h": 50, "text": "Sink",    "stroke": "#a6e3a1", "bg": "#1a3d1a"}
  ],
  "edges": [
    {"from": "src", "to": "tfm", "color": "#cdd6f4"},
    {"from": "tfm", "to": "dst", "color": "#cdd6f4"}
  ]
}}
```

### Mermaid Import (UI feature)

ユーザー向けUI機能。Excalidrawキャンバス右上の「Mermaid」ボタンから手入力。AIが使う場合は`import_structure`を優先すること。

```powershell
'{"action":"import_mermaid","mermaid":"graph TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[OK]"}' | API tab_action
```

### SVG Image Embedding

`set_data` / `add_element` の `files` パラメータでSVG画像を埋め込み可能。画像として表示されるため個別要素の編集はできないが、ピクセル精度のレイアウトが必要な場合に使う。

**手順:** Pythonスクリプトで SVG → base64 → `files` + `image`要素として送信。

```python
import base64, json, hashlib, urllib.request

SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400">...</svg>'
b64 = base64.b64encode(SVG.encode()).decode()
file_id = hashlib.sha1(SVG.encode()).hexdigest()[:20]

payload = {
    "action": "set_data",
    "elements": [{"type": "image", "x": 50, "y": 30, "width": 800, "height": 400, "status": "saved", "fileId": file_id}],
    "files": {file_id: {"id": file_id, "dataURL": f"data:image/svg+xml;base64,{b64}", "mimeType": "image/svg+xml", "created": 1700000000000}}
}
# Send via urllib.request to http://127.0.0.1:18731/api/tools/tab_action
```

---

## Notes Tab

Notion-style block editor for rich text notes and documents. Each Notes tab contains multiple pages managed by an internal sidebar.

### Quick Start

```powershell
'{"title":"My Notes","type":"notes"}' | API open_tab                    # 1. Open notes tab
'{"action":"get_elements"}' | API tab_action                                # 2. List pages
'{"action":"add_element","title":"Meeting Notes"}' | API tab_action         # 3. Create page
'{"action":"get_element","elementId":"<page_id>"}' | API tab_action         # 4. Read page content
'{"action":"update_element","elementId":"<id>","title":"New Title"}' | API tab_action  # 5. Rename
'{"action":"remove_element","elementId":"<id>"}' | API tab_action           # 6. Delete page
```

### Commands

| Operation | Action | Description |
|-----------|--------|-------------|
| `tab_action` | `get_elements` | List all pages (summary + full notesData) |
| `tab_action` | `get_element` | Get page content (`elementId` → page ID) |
| `tab_action` | `add_element` | Create page (optional `title`, `content`) |
| `tab_action` | `remove_element` | Delete page (`elementId`) |
| `tab_action` | `update_element` | Update page (`elementId` + `title` and/or `content`) |
| `tab_action` | `set_data` | Replace full notes data (`notesData`) |

### get_elements Response

```json
{
  "pages": [
    { "id": "abc123", "title": "My First Page" },
    { "id": "def456", "title": "Second Page" }
  ],
  "activePageId": "abc123",
  "count": 2
}
```

### get_element Response

```json
{
  "element": { "id": "abc123", "title": "My Page", "createdAt": "...", "updatedAt": "..." },
  "content": [
    { "type": "heading", "props": { "level": 1 }, "content": [{ "type": "text", "text": "Title" }], "children": [] },
    { "type": "paragraph", "content": [{ "type": "text", "text": "Body text" }], "children": [] }
  ]
}
```

### Writing Content (add_element / update_element)

Content is an array of BlockNote blocks. Each block has `type`, `props`, `content`, `children`:

```json
[
  { "type": "heading", "props": { "level": 1 }, "content": [{ "type": "text", "text": "My Title" }], "children": [] },
  { "type": "paragraph", "content": [{ "type": "text", "text": "Some text here." }], "children": [] },
  { "type": "bulletListItem", "content": [{ "type": "text", "text": "Item 1" }], "children": [] }
]
```

Block types: `paragraph`, `heading` (level 1-3), `bulletListItem`, `numberedListItem`, `checkListItem`, `codeBlock`, `table`, `image`.

### Data Structure (notesData)

```json
{
  "pages": [
    { "id": "abc123", "title": "My Page", "createdAt": "...", "updatedAt": "..." }
  ],
  "content": {
    "abc123": [ ...BlockNote blocks... ]
  },
  "activePageId": "abc123"
}
```

### File Storage

- **Workspace file**: `<title>.rcnotes` — JSON with pages + content
- **Image assets**: `<title>_materials/` folder — companion directory for pasted/uploaded images
- Image upload endpoint: `POST /api/notes/upload` (multipart, workspace filename required)
- Image serve endpoint: `GET /api/notes/assets/{workspace_name}/{image_filename}`
- Deleting/renaming a notes workspace also handles the companion asset folder

### Tips

- Pages are managed within the Notes tab UI (sidebar) — no need to use API for page CRUD in normal use
- Use `get_elements` to check which pages exist
- Use `set_data` with full `notesData` to bulk-import content
- BlockNote supports headings, lists, code blocks, tables, images, and more
- Auto-title: if the first block is a heading on a new page titled "Untitled", the heading text becomes the page title
- Undo/Redo handled natively by BlockNote (Ctrl+Z / Ctrl+Y)

---

## Files Tab (File Explorer)

Browse and manage files in a project folder. Uses SVAR FileManager UI. All commands go through `tab_action`.

### Open a Files tab

```powershell
'{"action":"open_tab","title":"Project Files","type":"files"}' | python .claude\skills\hiyocanvas\scripts\canvas_api.py tab_action
```

### Get directory contents

```powershell
# Get current directory listing
'{"action":"get_elements"}' | python .claude\skills\hiyocanvas\scripts\canvas_api.py tab_action

# Get a specific directory
'{"action":"get_elements","path":"C:\\Users\\user\\project\\src"}' | python .claude\skills\hiyocanvas\scripts\canvas_api.py tab_action

# Get file open history
'{"action":"get_elements","mode":"history"}' | python .claude\skills\hiyocanvas\scripts\canvas_api.py tab_action
```

Returns: `{ success, path, rootFolder, items: [{ name, type, size, path }] }`

### Open a file with system default app

```powershell
'{"action":"open_file","path":"C:\\Users\\user\\project\\README.md"}' | python .claude\skills\hiyocanvas\scripts\canvas_api.py tab_action
```

Opens the file in the OS default application (e.g., Excel for .xlsx, VS Code for .py).

### List file open history

```powershell
# All history
'{"action":"list_history"}' | python .claude\skills\hiyocanvas\scripts\canvas_api.py tab_action

# Filter by extension
'{"action":"list_history","filter":"pdf"}' | python .claude\skills\hiyocanvas\scripts\canvas_api.py tab_action
```

### Navigate to a path

```powershell
'{"action":"navigate","path":"C:\\Users\\user\\project\\src"}' | python .claude\skills\hiyocanvas\scripts\canvas_api.py tab_action
```

### Update root folder

```powershell
'{"action":"set_data","data":{"rootFolder":"C:\\Users\\user\\new-project","history":[]}}' | python .claude\skills\hiyocanvas\scripts\canvas_api.py tab_action
```

### Notes

- Root folder is selected via folder picker dialog on first tab creation
- Files are opened with `shell.openPath()` (OS default app)
- Delete sends to OS trash (not permanent delete)
- File open history is saved per-workspace (max 200 entries, deduped)
- Manual refresh only — no file system watching

---

## Universal Commands

These commands work on any tab type.

### Tab Operations

**Important:** Tab IDs (e.g. `tab-1775781998746`) are regenerated on each app restart. Always call `get_tabs` first to get current IDs before using `switch_tab` or `close_tab`.

| Operation | Description |
|-----------|-------------|
| `get_tab_contents` | Get active tab type + contents (auto-detects tab type) |
| `get_tabs` | List open tabs (with tab type and active status) |
| `open_tab` | Open or create tab |
| `close_tab` | Close tab |
| `switch_tab` | Switch active tab |
| `list_saved` | List saved workspaces on disk |
| `delete_tab` | Delete workspace |
| `rename_tab` | Rename workspace: `{"filename": "...", "new_title": "..."}` |

### View Operations

| Operation | Description |
|-----------|-------------|
| `fit_all` | Fit camera to all nodes |
| `fit_node` | Fit camera to a node |
| `zoom` | Set zoom level |
| `get_viewport` | Get current camera position and zoom |
| `screenshot` | Take screenshot |
| `tooltip` | Show tooltip on node |
| `hide_tooltip` | Hide tooltip |

### Diagnostics

| Operation | Description |
|-----------|-------------|
| `frontend_status` | Check server connection and frontend status |
| `get_console_logs` | Get console logs |
| `clear_logs` | Clear console logs |
| `get_frontend_errors` | Get runtime errors |

### Batch Operations

| Operation | Description |
|-----------|-------------|
| `batch` | Execute multiple operations in one call |

## Key Rules (All Tabs)

1. **Use the active workspace** — Always work in the currently active workspace. Do NOT create a new workspace unless the user explicitly asks. Check `get_tabs` first.
2. **Workspace title is REQUIRED** — When opening a new tab, provide a descriptive title (e.g. "Signal Analysis"). NEVER use generic names like "New Flow".
3. **`@file` for JSON over 100KB OR non-ASCII (Japanese)** — ASCII-only JSON under 100KB uses stdin pipe. Use `'@file'` (UTF-8 temp file) when JSON exceeds 100KB or contains Japanese/non-ASCII (PowerShell stdin silently corrupts it to `?`). See ⚠️ note in Command Format.

## Operation Details

For parameters, examples, and response formats, see [references/api-reference.md](references/api-reference.md).

Quick lookup: `Grep "### operation_name" references/api-reference.md -A 30`

## Best Practices

### Verify State Before and After
```powershell
API get_tabs                         # Check tab type + active tab
API get_elements                       # (flow) or tab_action get_elements (mindmap)
# ... perform operations ...
API get_elements                       # Verify changes
```

### Recommended Workflow
1. **Check tab type** — `get_tabs` to know what commands are available
2. **Get current state** — `get_elements` (flow) or `tab_action get_elements` (mindmap)
3. **Execute commands** — Use `batch` for multiple related operations (flow only)
4. **Verify results** — Confirm changes applied correctly
5. **Run and check** — (flow only) `start_execution` → `get_execution_status` → `get_execution_result`

## Narrator (Runtime Observability)

HiyoCanvas has a built-in narrator system that records runtime events to a ring buffer (500 events). Use it to verify what actually happened — without reading code or logs.

**When to use:** After flow execution, when debugging errors, when checking connection state, or after any canvas operation to confirm it took effect.

### Quick Reference

```powershell
# Current state snapshot
Invoke-RestMethod http://127.0.0.1:18731/api/narrator/state | ConvertTo-Json -Depth 3

# Recent events (newest first)
Invoke-RestMethod "http://127.0.0.1:18731/api/narrator/events?n=20" | ConvertTo-Json -Depth 5

# Errors only
Invoke-RestMethod http://127.0.0.1:18731/api/narrator/errors | ConvertTo-Json -Depth 5

# Clear before a test
Invoke-RestMethod -Method Post http://127.0.0.1:18731/api/narrator/clear | Out-Null
```

### State Fields

| Field | Values | Meaning |
|-------|--------|---------|
| `flow_status` | `stopped` / `running` / `error` | Current flow execution state |
| `ws_connected` | `true` / `false` | Browser connected via WebSocket |
| `ws_client_count` | integer | Number of connected browser tabs |
| `last_error` | event or `null` | Most recent error event |
| `node_statuses` | `{node_id: name}` | Per-node execution state |

### Event Names

| name | type | data |
|------|------|------|
| `flow_started` | flow | `{node_count}` |
| `flow_completed` | flow | `{total_time, node_count}` |
| `flow_error` | flow | `{total_time, failed_nodes}` |
| `node_executing` | node | `{node_id}` |
| `node_completed` | node | `{node_id, execution_time}` |
| `node_error` | node | `{node_id, execution_time, error_summary}` |
| `ws_connected` | websocket | `{client_count}` |
| `ws_disconnected` | websocket | `{client_count}` |
| `js_error` | js_error | `{message, source, lineno}` |

For full detail see [references/narrator.md](references/narrator.md).

### Notes & Common Pitfalls

**update_element でコードを更新する場合:**
```powershell
'{"node_id":"n1","code":"x = 1"}' | API update_element   # ✅ 正しい
'{"node_id":"n1","parameters":{"code":"x = 1"}}' | API update_element  # ❌ 効かない
```

**エラーデバッグの手順:**
1. `GET /api/narrator/errors` → `error_summary` で失敗ノードを特定（概要のみ）
2. `get_execution_result '{"node_id":"nX"}'` → 完全なトレースバックを取得
`error_summary` は1行の概要。完全なトレースバックは必ず `get_execution_result` で別途取得すること。

### Typical Flow Verification Pattern

```powershell
# 1. Clear
Invoke-RestMethod -Method Post http://127.0.0.1:18731/api/narrator/clear | Out-Null
# 2. Execute
'{}' | .venv\Scripts\python.exe .claude\skills\hiyocanvas\scripts\canvas_api.py start_execution
Start-Sleep 15
# 3. Verify sequence
Invoke-RestMethod "http://127.0.0.1:18731/api/narrator/events?n=30" | ConvertTo-Json -Depth 5
# Expected: flow_started → node_executing×N → node_completed×N → flow_completed
```

---

## Limitations

- **No Undo/Redo API** — Undo/Redo is browser-only (Ctrl+Z/Y). Use `save_tab` before destructive changes.
- **Node IDs are sequential** — Deleted IDs are not reused.
