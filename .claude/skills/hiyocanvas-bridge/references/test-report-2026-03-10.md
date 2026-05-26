# Test Report 2026-03-10

## Summary

| Metric | Value |
|--------|-------|
| Total Tests | 107 |
| PASS | 93 |
| FAIL | 12 |
| SKIP | 2 |
| Pass Rate | 86.9% |

## Results by Section

| # | Section | PASS | FAIL | SKIP |
|---|---------|------|------|------|
| 1 | Bridge (起動/終了) | 3 | 0 | 0 |
| 2 | Diagnostics | 5 | 0 | 0 |
| 3 | Workspace CRUD | 8 | 2 | 0 |
| 4 | Node CRUD | 14 | 2 | 0 |
| 5 | Edge | 5 | 2 | 0 |
| 6 | Execution | 7 | 3 | 0 |
| 6b | Step Execution | 5 | 0 | 1 |
| 7 | Canvas Operations | 7 | 1 | 0 |
| 8 | Subgraph | 8 | 0 | 0 |
| 9 | View / Tooltip | 9 | 2 | 0 |
| 10 | Block Registry | 5 | 0 | 0 |
| 11 | Batch | 2 | 0 | 0 |
| 12 | Node削除 | 3 | 0 | 0 |
| 13 | Mindmap | 12 | 0 | 1 |

## FAIL Details

### TC-22: canvas_api.py [OK]/[FAIL] judgment (Section 3)
- **Command**: `tab_action '{"action":"rename_tab","tabId":"nonexistent","title":"X"}'`
- **Expected**: `[FAIL]` (HTTP 200 but response has `success: false`)
- **Actual**: `[OK]` — canvas_api.py judges only by HTTP status code, not response body
- **Category**: Bug (canvas_api.py)

### TC-24: rename_tab changes filename (Section 3)
- **Command**: `tab_action '{"action":"rename_tab","tabId":"...","title":"New Name"}'`
- **Expected**: Tab title changes, filename unchanged
- **Actual**: Both title and filename changed
- **Category**: Spec mismatch — test plan expects title-only change, but implementation intentionally renames file too

### TC-30: label not in block schema (Section 4)
- **Command**: `tab_action '{"action":"add_element","type":"python_code","label":"Test"}'`
- **Expected**: Node created with label "Test"
- **Actual**: Node created but `label` is not a recognized parameter in the block schema; node uses default label
- **Category**: Spec issue — test plan references `label` param which doesn't exist in add_element

### TC-31: Position mismatch (Section 4)
- **Command**: `tab_action '{"action":"add_element","type":"python_code","position":{"x":100,"y":200}}'`
- **Expected**: Node at exactly (100, 200)
- **Actual**: Node placed at different coordinates
- **Category**: Bug or spec — position may be adjusted by React Flow layout

### TC-40: connect output format (Section 5)
- **Command**: `tab_action '{"action":"connect","source":"...","target":"..."}'`
- **Expected**: Response includes edge ID in specific format
- **Actual**: Response format differs from test plan spec
- **Category**: Spec issue — test plan needs update

### TC-40E: connect nonexistent source (Section 5)
- **Command**: `tab_action '{"action":"connect","source":"nonexistent","target":"..."}'`
- **Expected**: Error response
- **Actual**: Silently succeeds or returns success without validation
- **Category**: Bug — missing validation in connect handler

### TC-51: Execution status wording (Section 6)
- **Command**: `tab_action '{"action":"get_execution_status"}'`
- **Expected**: Status "completed" after run finishes
- **Actual**: Status "stopped"
- **Category**: Spec issue — test plan says "completed", actual uses "stopped"

### TC-52E: get_execution_result for nonexistent node (Section 6)
- **Command**: `tab_action '{"action":"get_execution_result","nodeId":"nonexistent"}'`
- **Expected**: Error response
- **Actual**: Returns success with empty/null result
- **Category**: Bug — missing validation

### TC-60: get_tab_contents default format (Section 6)
- **Command**: `tab_action '{"action":"get_tab_contents"}'`
- **Expected**: Includes coordinates and code by default
- **Actual**: Omits coordinates and code without `max_chars` parameter
- **Category**: Spec issue — test plan assumes default includes everything

### TC-85: tooltip type field None (Section 9)
- **Command**: `tab_action '{"action":"set_tooltip","nodeId":"...","tooltip":"text"}'` then get
- **Expected**: tooltip with type field populated
- **Actual**: type field shows `None`
- **Category**: Bug — tooltip type not being set

### TC-85E: tooltip nonexistent node (Section 9)
- **Command**: `tab_action '{"action":"set_tooltip","nodeId":"nonexistent","tooltip":"text"}'`
- **Expected**: Error response
- **Actual**: Silently succeeds
- **Category**: Bug — missing validation

---

## Fix Plan

### Category A: Code Bugs to Fix (6 items)

| # | TC | Issue | Fix Location | Priority |
|---|-----|-------|-------------|----------|
| A1 | TC-22 | canvas_api.py judges success by HTTP status only | `scripts/canvas_api.py` | High |
| A2 | TC-40E | connect allows nonexistent source/target | `frontend/js/hooks/useToolCommandHandler.ts` | Medium |
| A3 | TC-52E | get_execution_result returns success for nonexistent node | `backend/tools/execution.py` | Medium |
| A4 | TC-85 | tooltip type field is None | `backend/tools/canvas.py` or frontend handler | Low |
| A5 | TC-85E | set_tooltip succeeds for nonexistent node | `backend/tools/canvas.py` or frontend handler | Medium |
| A6 | TC-31 | Position not applied on add_element | `frontend/js/hooks/useToolCommandHandler.ts` | Medium |

### Category B: Test Plan Spec Updates (6 items)

| # | TC | Issue | Action |
|---|-----|-------|--------|
| B1 | TC-24 | rename_tab intentionally renames file too | Update test plan expected behavior |
| B2 | TC-30 | `label` param doesn't exist in add_element | Change test to use valid params or document label support |
| B3 | TC-40 | connect response format differs | Update test plan to match actual format |
| B4 | TC-51 | Status is "stopped" not "completed" | Update test plan expected value |
| B5 | TC-60 | get_tab_contents default omits coords/code | Update test plan expected behavior |
| B6 | TC-31 | Position may need tolerance | If A6 fix isn't feasible, update spec with tolerance |

### Execution Order

1. **A1** (canvas_api.py success判定) — 全テストの信頼性に影響するため最優先
2. **A2, A3, A5** (バリデーション追加) — 並行して修正可能
3. **A4** (tooltip type) — 小修正
4. **A6** (position) — 調査してからbug/spec判断
5. **B1-B6** (test plan更新) — コード修正完了後にまとめて更新
