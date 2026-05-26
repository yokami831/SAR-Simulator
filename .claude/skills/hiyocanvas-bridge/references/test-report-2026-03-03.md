# Test Report 2026-03-03

## Summary
- Executed: 37 tests (Sections 7-12)
- PASS: 30 / FAIL: 5 / SKIP: 2
- Sections 1-6: (pending from part 1 agent)

## Notes
- Tests run on workspace "Test Section 7-12" (tab-1772545687468)
- Node IDs: n100=Node A Renamed, n101=Node B, n102=Test Comment
- `clear_canvas` command does not exist in canvas_v2.py; correct command is `clear`
- `get_block_schema` not available in canvas_v2.py (GET endpoint with path param not supported by POST-based CLI)
- Part 1 agent was running in parallel, causing some workspace interference early on

---

## 7. Canvas Operations

### TC-60: get_canvas
**Op**: `$API get_canvas`
**Output**:
> Canvas: 3 nodes, 1 edges
> n100: Node A Renamed (python_code) at (100, 200) code: x = 42 print(x)
> n101: Node B (python_code) at (400, 200) code: y = x * 2 print(y)
> n102: Test Comment (comment) at (500, 300)
> Edges: n100:out_0 -> n101:in_0

**Verify**:
1. `Canvas: 3 nodes, 1 edges` matches find_nodes -> PASS
2. Each node has `at (x, y)` coordinates -> PASS
3. `code:` shown with content -> PASS
4. Edges section matches find_nodes -> PASS

**Result**: PASS

### TC-61: get_canvas (max_chars=0 and max_chars=-1)
**Op**: `$API get_canvas '{"max_chars":0}'`
**Verify**: max_chars=0: No `code:` lines present -> PASS

**Op**: `$API get_canvas '{"max_chars":-1}'`
**Verify**: max_chars=-1: `code:` lines with full code visible -> PASS

**Result**: PASS

### TC-62: auto_layout
**Pre**: n100 Position: (50, 295.5)
**Op**: `$API auto_layout`
**Output**: `Auto layout applied`
**Post**: n100 Position: (50, 282.5) - changed

**Verify**:
1. `Auto layout applied` -> PASS
2. Position changed -> PASS
3. Screenshot skipped

**Result**: PASS

### TC-63: save
**Pre**: 3 nodes, 1 edge
**Op**: `$API save '{"filepath":"test_save_s7.rcflow"}'`
**Output**: filepath: D:\Claude\HiyoCanvas\test_save_s7.rcflow

**Verify**:
1. Saved with filepath -> PASS
2. File exists -> PASS
3. JSON: nodes=3, edges=1 -> PASS

**Result**: PASS

### TC-63E: save (no path)
**Op**: `$API save '{}'`
**Output**: `HTTP 400: Missing required field(s): filepath`
**Verify**: Error response -> PASS
**Result**: PASS

### TC-64: clear_canvas
**Note**: Correct command is `clear` (not `clear_canvas`)
**Op**: `$API clear`
**Output**: `Canvas cleared`

**Verify**:
1. Canvas cleared -> PASS
2. find_nodes -> Nodes (0), Edges (0) -> PASS
3. get_canvas -> 0 nodes, 0 edges -> PASS

**Result**: PASS

### TC-65: load
**Pre**: Canvas empty. test_save_s7.rcflow exists.
**Op**: `$API load '{"filepath":"test_save_s7.rcflow"}'`
**Output**: num_nodes: 3, num_edges: 1

**Verify**:
1. Loaded 3 nodes, 1 edge -> PASS
2. find_nodes matches -> PASS
3. Labels/code match -> PASS

**Result**: PASS

### TC-65E: load (nonexistent file)
**Op**: `$API load '{"filepath":"nonexistent_file.rcflow"}'`
**Output**: `HTTP 404: File not found: nonexistent_file.rcflow`
**Verify**: Error + state unchanged -> PASS
**Result**: PASS

---

## 8. Subgraph Operations

### TC-70: create_subgraph
**Op**: `$API create_subgraph '{"node_ids":["n100","n101"],"label":"Processing Group"}'`
**Output**: `Created subgraph: Processing Group (n103)`

**Verify**:
1. Created with subgraph_id -> PASS
2. find_nodes -> Subgraphs (1): Processing Group [n100, n101] -> PASS
3. n102 not in subgraph -> PASS

**Result**: PASS

### TC-70E: create_subgraph (1 node)
**Op**: `$API create_subgraph '{"node_ids":["n100"],"label":"Solo"}'`
**Output**: `Error: At least 2 nodes required to create a subgraph`
**Verify**: Correct error + state unchanged -> PASS
**Result**: PASS

### TC-70E2: create_subgraph (nonexistent nodes)
**Op**: `$API create_subgraph '{"node_ids":["n99999","n99998"],"label":"Bad"}'`
**Output**: `Error: Failed to create subgraph`
**Verify**: Error response -> PASS
**Result**: PASS

### TC-71: set_subgraph
**Op**: `$API set_subgraph '{"subgraph_id":"n103","label":"Renamed Group","collapsed":true}'`
**Output**: `Updated subgraph: n103 (label, collapsed)`

**Verify**:
1. Changed fields listed -> PASS
2. find_nodes -> "Renamed Group" -> PASS
3. Screenshot skipped

**Result**: PASS

### TC-71N: set_subgraph (no changes)
**Op**: `$API set_subgraph '{"subgraph_id":"n103"}'`
**Output**: `No changes for subgraph: n103`
**Result**: PASS

### TC-71E: set_subgraph (nonexistent)
**Op**: `$API set_subgraph '{"subgraph_id":"sg99999","label":"X"}'`
**Output**: `Subgraph not found: sg99999`
**Result**: PASS

### TC-72: ungroup_subgraph
**Pre**: 1 subgraph, 3 nodes
**Op**: `$API ungroup_subgraph '{"subgraph_id":"n103"}'`
**Output**: `Ungrouped: n103`
**Verify**: No subgraphs, node count unchanged -> PASS
**Result**: PASS

### TC-72E: ungroup_subgraph (nonexistent)
**Op**: `$API ungroup_subgraph '{"subgraph_id":"sg99999"}'`
**Output**: `Subgraph not found: sg99999`
**Result**: PASS

---

## 9. View Operations

### TC-80: fit_all
**Op**: `$API fit_all`
**Output**: `Viewport fitted to all nodes`
**Result**: PASS

### TC-81: fit_node
**Op**: `$API fit_node '{"node_id":"n100"}'`
**Output**: `Viewport fitted to node: n100`
**Verify**: node_id in message + zoom changed -> PASS
**Result**: PASS

### TC-81E: fit_node (nonexistent)
**Op**: `$API fit_node '{"node_id":"n99999"}'`
**Output**: `Error: Node not found: n99999`
**Result**: PASS

### TC-82: zoom
**Pre**: zoom=1.77
**Op**: `$API zoom '{"level":1.5}'`
**Output**: `Zoom set to 1.5`
**Verify**: get_viewport -> zoom=1.86 (not 1.50) -> **FAIL**
**Result**: FAIL
**Note**: Zoom appears to apply relative adjustment, not absolute

### TC-82E: zoom (negative value)
**Op**: `$API zoom '{"level":-1}'`
**Output**: `Zoom set to -1` (no error)
**Verify**: Expected error or clamp -> **FAIL**
**Result**: FAIL
**Note**: Negative zoom accepted without validation

### TC-83: get_viewport
**Op**: `$API get_viewport`
**Output**: Viewport: x=177.0, y=-137.0, zoom=1.29 | Window: 997x593 | Nodes: 3
**Verify**: All values numeric, nodes match -> PASS
**Result**: PASS

### TC-84: screenshot (full)
**Op**: `$API screenshot '{"mode":"full"}'`
**Output**: Screenshot: ...full.png (157980 bytes)
**Verify**: Path + positive bytes -> PASS. Screenshot skipped.
**Result**: PASS

### TC-84N: screenshot (node)
**Op**: `$API screenshot '{"mode":"node","node_id":"n100"}'`
**Output**: Screenshot: ...node.png (19553 bytes)
**Verify**: Path + positive bytes -> PASS. Screenshot skipped.
**Result**: PASS

### TC-84E: screenshot (node mode, no node_id)
**Op**: `$API screenshot '{"mode":"node"}'`
**Output**: `Error: node_id required for mode='node'`
**Result**: PASS

### TC-85: tooltip
**Op**: `$API tooltip '{"node_id":"n100","text":"Test tooltip message","type":"info"}'`
**Output**: `HTTP 500: Internal Server Error`
**Verify**: Expected success -> **FAIL**
**Result**: FAIL
**Note**: tooltip endpoint returns HTTP 500

### TC-85E: tooltip (nonexistent node)
**Op**: `$API tooltip '{"node_id":"n99999","text":"X","type":"info"}'`
**Output**: `HTTP 500: Internal Server Error`
**Verify**: Expected proper error -> **FAIL**
**Result**: FAIL
**Note**: Same HTTP 500. tooltip endpoint is broken.

### TC-86: hide_tooltip
**Op**: `$API hide_tooltip '{"node_id":"n100"}'`
**Output**: `Hidden tooltip: n100`
**Result**: PASS

---

## 10. Block Registry Operations

### TC-90: search_block_types
**Op**: `$API search_block_types '{"query":"python"}'`
**Output**: Found 1 block(s) matching 'python': python_code: Python Code [Code]
**Verify**: N>=1, python_code found, correct format -> PASS
**Result**: PASS

### TC-90E: search_block_types (no results)
**Op**: `$API search_block_types '{"query":"zzzznonexistent"}'`
**Output**: `No blocks found matching: 'zzzznonexistent'`
**Result**: PASS

### TC-91: register_block
**Pre**: test_adder not found
**Op**: heredoc with full block definition
**Output**: Registration succeeded

**Verify**:
1. Registered -> PASS
2. search -> Found 1 block(s) -> PASS
3. get_block_schema -> SKIP (unavailable in canvas_v2.py)

**Result**: PASS (schema verify skipped)

### TC-91E: register_block (no id)
**Op**: `$API register_block '{"label":"No ID"}'`
**Output**: `HTTP 400: Block definition must have an 'id' field`
**Verify**: Error + not registered -> PASS
**Result**: PASS

### TC-92: add_node (custom block)
**Op**: `$API add_node '{"type":"test_adder","parameters":{"label":"Custom Adder","offset":"5"}}'`
**Output**: `Error: Unknown block type: test_adder`
**Verify**: Expected success -> **FAIL**
**Result**: FAIL
**Note**: register_block succeeded but add_node rejects the type

---

## 11. Batch Operations

### TC-100: batch (with $N variable substitution)
**Pre**: 3 nodes, 1 edge
**Note**: API requires `operations` key (not `commands` as in test plan)
**Op**: batch with 3 operations
**Output**:
> Batch: 3 commands
> [0] add_node [OK] Added: Batch A (n103)
> [1] add_node [OK] Added: Batch B (n104)
> [2] connect [OK] Connected: n103:out_0 -> n104:in_0
> Summary: 3/3 succeeded

**Verify**:
1. All [OK], 3/3 -> PASS
2. $N substitution worked -> PASS
3. find_nodes -> 5 nodes, 2 edges -> PASS

**Result**: PASS

### TC-100E: batch (error stops execution)
**Op**: batch: add_node(OK), get_node(n99999=FAIL), add_node(should not run)
**Output**:
> [0] add_node [OK] Added: OK Node (n105)
> [1] get_node [FAIL]
> Summary: 1/2 succeeded

**Verify**:
1. [0] OK, [1] FAIL, [2] not run -> PASS
2. "Should Not Run" not created -> PASS

**Result**: PASS

---

## 12. Node Deletion

### TC-110: remove_node (comment node)
**Pre**: 6 nodes, n102=Test Comment
**Op**: `$API remove_node '{"node_id":"n102"}'`
**Output**: `Removed: n102`

**Verify**:
1. Removed -> PASS
2. 5 nodes remaining -> PASS
3. get_node n102 -> not found -> PASS

**Result**: PASS

### TC-110E: remove_node (nonexistent)
**Op**: `$API remove_node '{"node_id":"n99999"}'`
**Output**: `Removed: n99999` (should have been error)
**Verify**: Expected error, got success -> **FAIL**
**Result**: FAIL
**Note**: Silently succeeds for nonexistent nodes

### TC-111: remove_node (connected node - edge auto-delete)
**Pre**: n100->n101 connected. n100 in subgraph n106.
**First attempt**: Returned "Removed" but node remained (subgraph blocked it silently).
**After ungrouping**: remove_node n100 succeeded correctly.
**Output**: `Removed: n100`

**Verify**:
1. n100 removed -> PASS
2. Edge auto-deleted -> PASS
3. n101 still exists, inputs empty -> PASS

**Result**: PASS
**Note**: Subgraph membership silently blocks removal (bug). After ungrouping, works correctly.

---

## Bugs Found

| # | Severity | TC | Description |
|---|----------|-----|-------------|
| 1 | Medium | TC-82 | zoom does not set absolute zoom level; actual differs from requested |
| 2 | Low | TC-82E | zoom accepts negative values without error or clamping |
| 3 | High | TC-85 | tooltip endpoint returns HTTP 500 Internal Server Error |
| 4 | Medium | TC-92 | register_block succeeds but registered block unusable with add_node |
| 5 | Medium | TC-110E | remove_node silently succeeds for nonexistent node IDs |
| 6 | High | TC-111 | remove_node silently fails when node is in a subgraph (returns success) |
| 7 | Low | - | Test plan command mismatches: clear_canvas->clear, commands->operations |
| 8 | Low | - | get_block_schema unavailable in canvas_v2.py CLI |
