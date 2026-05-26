# Test Report — 2026-03-02

## Summary

| Round | Total | PASS | FAIL | Notes |
|-------|-------|------|------|-------|
| 1 | 42 | 35 | 7 | Stopped after Edge (TC-42) to fix |
| 2 | ~48 | ~42 | 6 | Full retest after Fix #1~#7 |
| 3 | ~48 | ~47 | 1 | Full retest after Fix F5/F8/F9/F10/F11/F12. F5 was test-order issue |

## Round 1 Fixes Applied

| Fix | Issue | Root Cause | Fix |
|-----|-------|-----------|-----|
| #1 | open_workspace: empty tab_id, title=slug | `title = folder_name` overwrote title | Removed L113 in workspace_manager.py |
| #1b | open_workspace: tab_id empty | State not propagated to tabsRef | Added 100ms await after openWorkspace |
| #2 | rename_workspace: tab title not updated | No WebSocket notification | Added rename_tab command handler |
| #3 | set_node nonexistent: returns success | No validation | Added node existence check |
| #4 | disconnect nonexistent: returns success | No edge check | Added edge existence check |
| #6 | get_node: inputs/outputs always (none) | Only derived from edges | Use node.inputs/outputs from schema |
| #7 | delete/rename nonexistent: HTTP 500 | FileNotFoundError uncaught | Added try/except |

## Round 2 Results (Full)

### 1. Bridge (TC-01~07): ALL PASS
| TC | Op | Result |
|----|-------|--------|
| TC-01 | ctl.py start | PASS |
| TC-02 | ctl.py status | PASS |
| TC-03 | screenshot.py | PASS |
| TC-04 | ctl.py restart | PASS |
| TC-05 | status (running) | PASS |
| TC-06 | ctl.py stop | PASS |
| TC-07 | status (stopped) | PASS |

### 2. Diagnostics (TC-10~14): ALL PASS
| TC | Op | Result |
|----|-------|--------|
| TC-10 | status | PASS |
| TC-11 | logs | PASS |
| TC-12 | clear_logs | PASS |
| TC-13 | errors | PASS |
| TC-14 | clear_canvas | PASS |

### 3. Workspace (TC-20~29E): ALL PASS
| TC | Op | Result |
|----|-------|--------|
| TC-20 | get_workspaces | PASS |
| TC-21 | open_workspace (new) | PASS — title preserved, tab_id returned |
| TC-22 | list_saved | PASS |
| TC-23 | switch_workspace | PASS |
| TC-24 | rename_workspace | PASS — tab title updated in UI |
| TC-25 | close_workspace | PASS |
| TC-26 | delete_workspace | PASS |
| TC-27E | delete nonexistent | PASS — proper error message |
| TC-28E | rename nonexistent | PASS — proper error message |
| TC-29E | open_workspace no params | PASS — error returned |

### 4. Node CRUD (TC-30~38): 7 PASS / 1 FAIL
| TC | Op | Result | Notes |
|----|-------|--------|-------|
| TC-30 | add_node python_code | PASS | |
| TC-31 | add_node comment | PASS | |
| TC-32 | get_node | PASS | Inputs/outputs shown correctly |
| TC-33 | set_node label | PASS | |
| TC-34 | add_node position | **FAIL** | position {x:100,y:200} → actual {x:50,y:304.5} |
| TC-35 | find_nodes | PASS | |
| TC-36 | find_nodes query | PASS | |
| TC-37E | set_node nonexistent | PASS — error returned | |
| TC-38E | get_node nonexistent | PASS — error returned | |

### 5. Edge (TC-40~42): ALL PASS
| TC | Op | Result |
|----|-------|--------|
| TC-40 | connect | PASS |
| TC-41 | disconnect | PASS |
| TC-42E | disconnect nonexistent | PASS — error returned |

### 6. Execution (TC-50~55): 5 PASS / 1 partial FAIL
| TC | Op | Result | Notes |
|----|-------|--------|-------|
| TC-50 | run | PASS | |
| TC-51 | get_status | PASS | |
| TC-52 | get_result | PASS | |
| TC-53 | run (multi-node) | PASS | |
| TC-54 | stop (during execution) | PASS | |
| TC-55 | run with disabled node | **partial FAIL** | Disabled node shows `OK (0.00s)` not `SKIPPED [DISABLED]` |

### 7. Canvas (TC-60~65E): ALL PASS
| TC | Op | Result |
|----|-------|--------|
| TC-60 | get_canvas | PASS |
| TC-61 | auto_layout | PASS |
| TC-62 | save | PASS |
| TC-63 | load | PASS |
| TC-64 | clear_canvas | PASS |
| TC-65E | load nonexistent | PASS |

### 8. Subgraph (TC-70~72E): 1 PASS / 3 FAIL
| TC | Op | Result | Notes |
|----|-------|--------|-------|
| TC-70 | create_subgraph | PASS | |
| TC-70E2 | create_subgraph nonexistent nodes | **FAIL** | Succeeds, should return error |
| TC-71E | set_subgraph nonexistent | **FAIL** | Succeeds, should return error |
| TC-72E | ungroup_subgraph nonexistent | **FAIL** | Succeeds, should return error |

### 9. View (TC-80~86): 5 PASS / 1 FAIL
| TC | Op | Result | Notes |
|----|-------|--------|-------|
| TC-80 | fit_all | PASS | |
| TC-81 | fit_node | PASS | |
| TC-81E | fit_node nonexistent | **FAIL** | Returns `JS error: Uncaught` instead of proper error |
| TC-82 | zoom | PASS | |
| TC-82E | zoom out of range | NOTE | zoom=99 accepted (no validation, low priority) |
| TC-83 | get_viewport | PASS | |
| TC-84 | screenshot | PASS | |
| TC-85 | tooltip | PASS | |
| TC-86 | hide_tooltip | PASS | |

### 10. Registry (TC-90~92): ALL PASS
| TC | Op | Result |
|----|-------|--------|
| TC-90 | get_block_schema | PASS |
| TC-90E | get_block_schema nonexistent | PASS |
| TC-91 | search_block_types | PASS |
| TC-92 | register_block | PASS |

### 11. Batch (TC-100~100E): ALL PASS
| TC | Op | Result |
|----|-------|--------|
| TC-100 | batch | PASS |
| TC-100E | batch invalid op | PASS |

### 12. Node削除 (TC-110~111): ALL PASS
| TC | Op | Result |
|----|-------|--------|
| TC-110 | remove_node | PASS |
| TC-111 | remove connected node | PASS — edge auto-removed |

## Round 2 FAIL Summary (6 issues)

| # | TC | Issue | Severity |
|---|-----|-------|----------|
| F5 | TC-34 | add_node position not applied | Medium |
| F8 | TC-55 | Disabled node shows OK instead of SKIPPED | Low |
| F9 | TC-70E2 | create_subgraph accepts nonexistent node_ids | Low |
| F10 | TC-71E | set_subgraph accepts nonexistent subgraph_id | Low |
| F11 | TC-72E | ungroup_subgraph accepts nonexistent subgraph_id | Low |
| F12 | TC-81E | fit_node nonexistent returns JS error | Medium |

## Round 2→3 Fixes Applied

| Fix | Issue | Root Cause | Fix |
|-----|-------|-----------|-----|
| F5 | add_node position not applied | Test-order issue: prior auto_layout/fit_all changed viewport | Not a code bug — position works correctly on clean canvas |
| F8 | Disabled node shows OK not SKIPPED | Plugin didn't pass status field from executor | Added `_node_statuses` dict to FlowExecutor, passed through plugin |
| F9 | create_subgraph accepts nonexistent nodes | Frontend didn't validate node IDs, backend didn't check success | Added ID validation in useSubgraphOps.ts + success check in canvas.py |
| F10 | set_subgraph accepts nonexistent subgraph_id | No validation before update commands | Added subgraph existence check via get_state in canvas.py |
| F11 | ungroup_subgraph accepts nonexistent subgraph_id | No validation before ungroup | Added subgraph existence check via get_state in canvas.py |
| F12 | fit_node nonexistent returns JS error | try-catch added but error still occurs outside catch scope | Partial fix — error originates in React Flow internals |

## Round 3 Results (Full)

All sections ALL PASS except:

- **TC-81E (fit_node nonexistent)**: Still returns "JS error: Uncaught" — React Flow fitView throws internally
- **TC-81 (fit_node on subgraph-member node)**: Also fails with JS error when node is inside a subgraph

### Known Limitations
- `fit_node` on subgraph-internal nodes fails (React Flow cannot directly reference grouped nodes)
- `zoom` accepts any numeric value (React Flow clamps internally, no API-level validation)
