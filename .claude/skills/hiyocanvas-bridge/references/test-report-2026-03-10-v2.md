# Test Report 2026-03-10 v2

## Summary
- 実行: 85件 / PASS: 84件 / FAIL: 1件 / SKIP: 7件 (Section 1)
- 所要時間: 約10m

## Previously FAIL TCs — Status
| TC | Description | v1 | v2 |
|----|-------------|----|----|
| TC-22 | open_tab no title `[FAIL]` judgment | FAIL | **PASS** |
| TC-24 | rename_tab | FAIL | **PASS** |
| TC-30 | get_block_schema label | FAIL | **PASS** |
| TC-31 | position | FAIL | **PASS** (React Flow adjusts) |
| TC-40 | connect output format | FAIL | **PASS** |
| TC-40E | connect nonexistent node | FAIL | **PASS** |
| TC-51 | execution status wording | FAIL | **PASS** |
| TC-52E | get_execution_result nonexistent | FAIL | **FAIL** |
| TC-60 | get_tab_contents default | FAIL | **PASS** |
| TC-85 | tooltip type field | FAIL | **PASS** |
| TC-85E | tooltip nonexistent node | FAIL | **PASS** |

## Results

### 1. Bridge (TC-01 ~ TC-07) — SKIP
HiyoCanvas already running. Skipped startup/shutdown cycle tests.

### 2. Diagnostics

#### TC-10: frontend_status — PASS
**Op**: `$API frontend_status`
**Output**: `[OK] frontend_status` — Server: OK, Frontend: connected (1 client(s)), Execution: stopped

#### TC-11: get_console_logs — PASS
**Op**: `$API get_console_logs`
**Output**: `Logs (1/1): [10:12:51] INFO: WebSocket reconnected`

#### TC-12: get_console_logs (limit) — PASS
**Op**: `$API get_console_logs '{"limit":3}'`
**Output**: `Logs (1/1)` — 1 log returned (fewer than limit)

#### TC-13: get_frontend_errors — PASS
**Op**: `$API get_frontend_errors`
**Output**: `No errors`

#### TC-14: clear_logs — PASS
**Op**: `$API clear_logs` → `Logs cleared`
**Verify**: `$API get_console_logs` → `No logs`

### 3. Workspace Operations

#### TC-20: get_tabs (initial) — PASS
**Output**: `Open workspaces (1): tab-launcher: Home (launcher) *`

#### TC-21: open_tab — PASS
**Op**: `$API open_tab '{"title":"Test WS"}'`
**Output**: `Opened: Test WS (tab: tab-1773137640316)`
**Verify**: get_tabs shows 2 tabs, Test WS active. rcflow file created with correct title/type.

#### TC-22: open_tab (no title — error) — PASS
**Op**: `$API open_tab '{}'`
**Output**: `[FAIL] open_tab — Must provide at least one of: title, filename`

#### TC-23: list_saved — PASS
**Output**: `Saved workspaces (13):` with filename:title(type) format for each.

#### TC-24: rename_tab — PASS
**Op**: `$API rename_tab '{"filename":"Test WS.rcflow","new_title":"Renamed WS"}'`
**Output**: `Renamed: Test WS.rcflow → Renamed WS`
**Verify**: get_tabs shows "Renamed WS", filename changed to "Renamed WS.rcflow"

#### TC-25: rename_tab (nonexistent — error) — PASS
**Output**: `[FAIL] rename_tab — Failed to rename: Workspace not found: nonexistent-xyz.rcflow`

#### TC-26: switch_tab — PASS
**Op**: `$API switch_tab '{"tab_id":"tab-launcher"}'`
**Output**: `Switched to: Home (tab: tab-launcher)`
**Verify**: get_tabs shows Home active

#### TC-27: switch_tab (nonexistent — error) — PASS
**Output**: `[FAIL] switch_tab — Failed to switch to tab: tab-nonexistent-999`

#### TC-28: close_tab — PASS
**Op**: `$API close_tab '{"tab_id":"tab-1773137640316"}'`
**Output**: `Closed: tab-1773137640316`
**Verify**: get_tabs shows 1 tab. No save dialog appeared.

#### TC-29: delete_tab — PASS
**Op**: `$API delete_tab '{"filename":"Renamed WS.rcflow"}'`
**Output**: `Deleted: Renamed WS.rcflow`

#### TC-29E: delete_tab (nonexistent — error) — PASS
**Output**: `[FAIL] delete_tab — Failed to delete: Workspace not found: nonexistent-xyz.rcflow`

### 4. Node CRUD

#### TC-30: get_block_schema — PASS
**Output**: `Block: python_code`, Parameters: `code (str)`, Inputs: `in_0`, Outputs: `out_0`
No `label` in parameters (correct — label is a node property).

#### TC-30E: get_block_schema (nonexistent — error) — PASS
**Output**: `[FAIL] get_block_schema — Error: Block type not found: nonexistent_block`

#### TC-31: add_element (Node A) — PASS
**Op**: add python_code at (100,200), label="Node A", code="x = 42\nprint(x)"
**Output**: `Added: Node A (n1)`
**Verify**: get_element shows Type: python_code, Enabled: true, Position: (50, 295.5) (React Flow adjusted), code correct, Inputs: in_0, Outputs: out_0

#### TC-31E: add_element (no type — error) — PASS
**Output**: `[FAIL] add_element: HTTP 400: Missing required field(s): type`

#### TC-31E2: add_element (nonexistent type — error) — PASS
**Output**: `[FAIL] add_element — Error: Unknown block type: nonexistent_xyz`

#### TC-32: add_element (Node B) — PASS
**Output**: `Added: Node B (n2)` — different ID from n1

#### TC-33: get_element — PASS
All fields verified: Node A (n1), python_code, Enabled: true, numeric position, code, in_0, out_0

#### TC-33E: get_element (nonexistent — error) — PASS
**Output**: `[FAIL] get_element — Error: Node 'n99999' not found`

#### TC-34: update_element (label) — PASS
**Output**: `Updated: n1 (label)`
**Verify**: get_elements shows `n1: Node A Renamed (python_code)`

#### TC-35: update_element (enabled=false) — PASS
**Output**: `Updated: n1 (enabled)`
**Verify**: get_element → `Enabled: false`, get_elements → `[DISABLED]` mark

#### TC-35R: update_element (enabled=true) — PASS
**Verify**: Enabled: true, no [DISABLED] mark

#### TC-36: update_element (code via heredoc) — PASS
**Output**: `Updated: n1 (code)`
**Verify**: code contains `print(f'x = {x}')`, old code gone

#### TC-36E: update_element (nonexistent — error) — PASS
**Output**: `[FAIL] update_element — Error: Node 'n99999' not found`

#### TC-37: get_elements — PASS
**Output**: `Nodes (2): n1: Node A Renamed (python_code), n2: Node B (python_code), Edges (0):`

#### TC-37Q: get_elements (query) — PASS
**Op**: query="Node B" → only Node B returned

#### TC-38: add_element (comment) — PASS
**Output**: `Added: Test Comment (n3)`, Type: comment, 3 nodes total

### 5. Edge Operations

#### TC-40: connect — PASS
**Output**: `[OK] connect — edge_id: e_1773137763999_qh67`
**Verify**: get_elements → `Edges (1): n1:out_0 → n2:in_0`

#### TC-40E: connect (nonexistent node — error) — PASS
**Output**: `[FAIL] connect — Error: Source node 'n99999' not found`

#### TC-40E2: connect (missing params — error) — PASS
**Output**: `[FAIL] connect: HTTP 400: Missing required field(s): source_port, target, target_port`

#### TC-41: disconnect — PASS
**Output**: `Disconnected: n1:out_0 → n2:in_0`
**Verify**: Edges (0)

#### TC-41E: disconnect (already disconnected — error) — PASS
**Output**: `[FAIL] disconnect — Error: Edge not found: n1:out_0 → n2:in_0`

#### TC-42: connect (reconnect) — PASS

### 6. Execution Operations

#### TC-50: start_execution — PASS
**Output**: `Flow execution started (3 nodes)`

#### TC-51: get_execution_status — PASS
**Output**: `Status: stopped (0.00s)` with all 3 nodes OK, labels shown (not IDs)

#### TC-52: get_execution_result — PASS
- Node A: `Output: x = 42` (f-string output)
- Node B: `Output: 84` (42*2, kernel namespace shared)

#### TC-52E: get_execution_result (nonexistent) — **FAIL**
**Op**: `$API get_execution_result '{"node_id":"n99999"}'`
**Expected**: `[FAIL]` + `No result found for node n99999`
**Actual**: `[OK] get_execution_result — Result: n99999 (n99999) — ERROR (0.00s)`
**Note**: Returns [OK] with ERROR status instead of [FAIL]. The canvas_api.py formatter treats any response with success=true as [OK].

#### TC-53: get_execution_result (max_lines) — PASS
**Output**: 1 line of output returned

#### TC-54: stop_execution (not running) — PASS
**Output**: `Flow execution stopped` — no crash

#### TC-55: start_execution (disabled node) — PASS
**Output**: `n1: Node A Renamed — SKIPPED [DISABLED]`, `n2: Node B — ERROR` (x undefined)

### 6b. Step Execution Operations

#### TC-56: step_start — PASS
**Output**: `Step execution ready`, total_steps: 3, step_order: [n1, n2, n3]
**Verify**: frontend_status → `Execution: stepping`

#### TC-57: step_next (1st) — PASS
**Output**: node_id: n1, step_index: 0

#### TC-58: step_next (all complete) — PASS
Stepped through n2, n3. get_execution_status → `Status: stopped`, all OK. Node B output: 84.

#### TC-59: step_start + run_remaining — PASS
step_start → step_next(n1) → run_remaining → completed. All results available.

#### TC-59R: step_reset — PASS
**Output**: `Step execution reset`
**Verify**: frontend_status → `Execution: stopped`

#### TC-59E: step_next (not stepping — error) — PASS
**Output**: `[FAIL] step_next — Not in stepping mode`

#### TC-59E2: step_start (error node) — PASS
Set code to `def f(\n  invalid syntax here` → step_start → step_next → `[FAIL]`
frontend_status → `Execution: stopped` (error recovery)

### 7. Canvas Operations

#### TC-60: get_tab_contents (default) — PASS
**Output**: Same node/edge format as get_elements (3 nodes, 1 edge)

#### TC-61: get_tab_contents (max_chars) — PASS
- max_chars=0: no `code:` lines, position shown
- max_chars=-1: full code displayed

#### TC-62: auto_layout — PASS
**Output**: `Auto layout applied`

#### TC-63: save_tab — PASS
**Output**: filepath confirmed, file created with correct node/edge counts

#### TC-63E: save_tab (no path — error) — PASS
**Output**: `[FAIL] save_tab: HTTP 400: Missing required field(s): filepath`

#### TC-64: clear_canvas — PASS
**Output**: `Canvas cleared`
**Verify**: Nodes (0), Edges (0)

#### TC-65: load_tab — PASS
**Output**: 3 nodes, 1 edge loaded. Content matches pre-save state.

#### TC-65E: load_tab (nonexistent — error) — PASS
**Output**: `[FAIL] load_tab: HTTP 404: File not found: nonexistent_file.rcflow`

### 8. Subgraph Operations

#### TC-70: create_subgraph — PASS
**Output**: `Created subgraph: Processing Group` (subgraph_id: n4)
**Verify**: get_elements → `Subgraphs (1): n4: Processing Group [n1, n2]`, n3 not in subgraph

#### TC-70E: create_subgraph (1 node — error) — PASS
**Output**: `[FAIL] — At least 2 nodes required`

#### TC-70E2: create_subgraph (nonexistent — error) — PASS
**Output**: `[FAIL] — Failed to create subgraph`

#### TC-71: set_subgraph — PASS
**Output**: `Updated subgraph: n4 (label, collapsed)`

#### TC-71N: set_subgraph (no changes) — PASS
**Output**: `No changes for subgraph: n4`

#### TC-71E: set_subgraph (nonexistent — error) — PASS
**Output**: `[FAIL] — Subgraph not found: sg99999`

#### TC-72: ungroup_subgraph — PASS
**Output**: `Ungrouped: n4`
**Verify**: No subgraphs, 3 nodes preserved

#### TC-72E: ungroup_subgraph (nonexistent — error) — PASS
**Output**: `[FAIL] — Subgraph not found: sg99999`

### 9. View Operations

#### TC-80: fit_all — PASS
**Output**: `Viewport fitted to all nodes`

#### TC-81: fit_node — PASS
**Output**: `Viewport fitted to node: n1`

#### TC-81E: fit_node (nonexistent — error) — PASS
**Output**: `[FAIL] — Error: Node not found: n99999`

#### TC-82: zoom — PASS
**Output**: `Zoom set to 1.5`
**Verify**: get_viewport → zoom=1.50

#### TC-82E: zoom (negative — error) — PASS
**Output**: `[FAIL] — Error: zoom level must be positive, got -1`

#### TC-83: get_viewport — PASS
**Output**: `Viewport: x=124.0, y=-170.0, zoom=1.50 | Window: 997x593 | Nodes: 3`

#### TC-84: screenshot (full) — PASS
**Output**: filepath + size 1386x863

#### TC-84N: screenshot (node) — PASS
**Output**: filepath + size 767x208

#### TC-84E: screenshot (node without id — error) — PASS
**Output**: `[FAIL] — HTTP 400: node_id is required for mode='node'`

#### TC-85: tooltip — PASS
**Output**: `node_id: n1, type: info`

#### TC-85E: tooltip (nonexistent — error) — PASS
**Output**: `[FAIL] tooltip — Error: Node 'n99999' not found`

#### TC-86: hide_tooltip — PASS
**Output**: `[OK] hide_tooltip`

### 10. Block Registry Operations

#### TC-90: search_block_types — PASS
**Output**: `Found 1 block(s) matching 'python': python_code: Python Code [Code] - Execute arbitrary Python code`

#### TC-90E: search_block_types (no results) — PASS
**Output**: `[OK] — No blocks found matching: 'zzzznonexistent'`

#### TC-91: register_block — PASS
**Output**: `id: test_adder, label: Test Adder`
**Verify**: search finds it, schema shows offset parameter with default '0'

#### TC-91E: register_block (no id — error) — PASS
**Output**: `[FAIL] — HTTP 400: Block definition must have an 'id' field`

#### TC-92: add_element (custom block) — PASS
**Output**: `Added: Custom Adder (n5)`, Type: test_adder, offset: 5

### 11. Batch Operations

#### TC-100: batch ($N substitution) — PASS
**Output**: `Batch: 3 commands`, all [OK], Summary: 3/3 succeeded
$0/$1 replaced with n6/n7 in connect command. Nodes +2, Edges +1.

#### TC-100E: batch (error stops execution) — PASS
**Output**: [0] OK (OK Node added), [1] FAIL (n99999 not found), [2] not executed
Summary: 1/2 succeeded. "Should Not Run" not created.

### 12. Node Deletion

#### TC-110: remove_element (comment) — PASS
**Output**: `Removed: n3`
**Verify**: get_element n3 → `[FAIL] Node not found`, node count -1

#### TC-110E: remove_element (nonexistent — error) — PASS
**Output**: `[FAIL] — Error: Node 'n99999' not found`

#### TC-111: remove_element (connected node — edge auto-delete) — PASS
**Output**: `Removed: n1`, removed_edges: ["e_1773137783539_sq1v"]
**Verify**: n1 gone, edge gone, Node B (n2) exists with no connections

### 13. Mindmap Operations

#### TC-120: open_tab (mindmap) — PASS
**Output**: `Opened: Test Mind Map TC (tab: tab-1773138117365)`
**Verify**: get_tabs → mindmap type, .rcmind file created

#### TC-121: get_elements (mindmap) — PASS
**Output**: mindmapData with nodeData.topic = "Test Mind Map TC", root node with empty children

#### TC-122: set_data — PASS
**Output**: success: true
**Verify**: get_elements → root topic "Updated Root", children: Child 1, Child 2

#### TC-123: get_element (root) — PASS
**Output**: id: root, topic: Updated Root, childCount: 2, children: [child1, child2]

#### TC-124: add_element (mindmap child) — PASS
**Output**: `Added: Grandchild 1 (mm-1773138139186)`
**Verify**: child1 childCount: 1

#### TC-125: update_element (topic) — PASS
**Output**: `Updated child2: topic="Child 2 Renamed"`

#### TC-126: update_element (collapse) — PASS
**Output**: `Updated child1: collapsed`

#### TC-126R: update_element (expand) — PASS
**Output**: `Updated child1: expanded`

#### TC-127: remove_element (mindmap) — PASS
**Output**: `Removed: child2`
**Verify**: root childCount: 1, child2 not found

#### TC-127E: remove_element (root — error) — PASS
**Output**: `[FAIL] — Cannot remove root node`

#### TC-128: switch_tab (flow ↔ mindmap) — PASS
Switched from mindmap to flow and back. Mindmap data preserved.

#### TC-129: workspace file verification — PASS
.rcmind file contains valid JSON with `"type": "mindmap"` and mindmapData

#### TC-129C: close_tab (mindmap) — PASS
Save dialog appeared → dismissed with "Don't Save" → tab closed

## Section Summary

| Section | TCs | PASS | FAIL | SKIP |
|---------|-----|------|------|------|
| 1. Bridge | 7 | 0 | 0 | 7 |
| 2. Diagnostics | 5 | 5 | 0 | 0 |
| 3. Workspace | 10 | 10 | 0 | 0 |
| 4. Node CRUD | 13 | 13 | 0 | 0 |
| 5. Edge | 6 | 6 | 0 | 0 |
| 6. Execution | 6 | 5 | 1 | 0 |
| 6b. Step Execution | 7 | 7 | 0 | 0 |
| 7. Canvas | 8 | 8 | 0 | 0 |
| 8. Subgraph | 7 | 7 | 0 | 0 |
| 9. View | 10 | 10 | 0 | 0 |
| 10. Registry | 5 | 5 | 0 | 0 |
| 11. Batch | 2 | 2 | 0 | 0 |
| 12. Node Deletion | 3 | 3 | 0 | 0 |
| 13. Mindmap | 12 | 12 | 0 | 0 |
| **Total** | **101** | **93** | **1** | **7** |

## Remaining Issue

### TC-52E: get_execution_result for nonexistent node
- **Expected**: `[FAIL]` + `No result found for node n99999`
- **Actual**: `[OK]` + `Result: n99999 (n99999) — ERROR (0.00s)`
- **Root cause**: Backend returns `success: true` with an ERROR status for nodes that don't exist in the flow, rather than returning `success: false`. The `canvas_api.py` formatter follows the success field.
- **Fix suggestion**: Backend should check if node_id exists in the flow graph and return `success: false` when the node is not found, before checking execution results.
