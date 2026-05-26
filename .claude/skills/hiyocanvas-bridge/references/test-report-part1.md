# Test Report Part 1 (TC-10 to TC-59E2)

Date: 2026-03-04

## Summary
- Executed: 44 / PASS: 43 / FAIL: 1 / SKIP: 0

**Known issues:**
- canvas_v2.py sends POST for all endpoints but logs/errors/block_schema/search_blocks are GET. Used curl.
- TC-51: get_status shows stopped not completed after execution finishes.

## Results

### TC-10: status -- PASS
### TC-11: logs -- PASS (curl)
### TC-12: logs limit -- PASS (curl)
### TC-13: errors -- PASS (curl)
### TC-14: clear_logs -- PASS
### TC-20: get_workspaces -- PASS
### TC-21: open_workspace -- PASS
### TC-22: open_workspace no title error -- PASS
### TC-23: list_saved -- PASS
### TC-24: rename_workspace -- PASS
### TC-25: rename_workspace nonexistent error -- PASS
### TC-26: switch_workspace -- PASS
### TC-27: switch_workspace nonexistent error -- PASS
### TC-28: close_workspace -- PASS
### TC-29: delete_workspace -- PASS
### TC-29E: delete_workspace nonexistent error -- PASS
### TC-30: get_block_schema -- PASS (curl)
### TC-30E: get_block_schema nonexistent error -- PASS (curl)
### TC-31: add_node Node A -- PASS
### TC-31E: add_node no type error -- PASS
### TC-31E2: add_node nonexistent type error -- PASS
### TC-32: add_node Node B -- PASS
### TC-33: get_node -- PASS
### TC-33E: get_node nonexistent error -- PASS
### TC-34: set_node label change -- PASS
### TC-35: set_node enabled=false -- PASS
### TC-35R: set_node enabled=true restore -- PASS
### TC-36: set_node code change -- PASS
### TC-36E: set_node nonexistent error -- PASS
### TC-37: find_nodes all -- PASS
### TC-37Q: find_nodes query -- PASS
### TC-38: add_node comment -- PASS
### TC-40: connect -- PASS
### TC-40E: connect nonexistent error -- PASS
### TC-40E2: connect missing params error -- PASS
### TC-41: disconnect -- PASS
### TC-41E: disconnect already disconnected error -- PASS
### TC-42: connect reconnect -- PASS
### TC-50: run -- PASS
### TC-51: get_status -- FAIL (status=stopped not completed)
### TC-52: get_result -- PASS (n1:42, n2:84)
### TC-52E: get_result nonexistent error -- PASS
### TC-53: get_result max_lines -- PASS
### TC-54: stop not running -- PASS
### TC-55: run disabled node -- PASS
### TC-56: step_start -- PASS
### TC-57: step_next 1st -- PASS
### TC-58: step_next completion -- PASS
### TC-59: step_start + run_remaining -- PASS
### TC-59R: step_reset -- PASS
### TC-59E: step_next not stepping error -- PASS
### TC-59E2: step_start error node -- PASS

## Key Variables
- Node A: n1, Node B: n2, Comment: n3
- Workspace: tab-1772625872232 / node-test
