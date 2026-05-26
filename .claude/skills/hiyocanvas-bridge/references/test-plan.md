# HiyoCanvas SKILL Test Plan

全API操作 + hiyocanvas-bridge SKILLの試験手順書。各機能が仕様通り動作していることを確認する。

## 共通定義

```bash
API = python .claude/skills/hiyocanvas/scripts/canvas_api.py
PYTHON = .venv/Scripts/python.exe
BRIDGE = .claude/skills/hiyocanvas-bridge/scripts
WS_DIR = workspaces
```

## 試験実行ポリシー

- **小さなエラーで中断しない** — FAIL記録して次へ。全体を流すことを優先
- **中断条件**: 5件以上連続FAIL、または後続テストに波及する場合 → ユーザーに判断を仰ぐ
- **結果記録**: 各TCに PASS / FAIL / SKIP。FAILには実際の出力を添付

## 試験結果レポート

テスト実行時は `test-report-YYYY-MM-DD.md` に詳細結果を記録する。

**レポートテンプレート:**
```markdown
# Test Report YYYY-MM-DD

## Summary
- 実行: NN件 / PASS: NN件 / FAIL: NN件 / SKIP: NN件
- 所要時間: 約NNm

## Results

### TC-01: status（停止状態）
**Op**: `$PYTHON $BRIDGE/ctl.py status`
**Output**:
> stopped

**Verify**:
1. 出力が `stopped` → PASS
2. exit code 0 → PASS

**Result**: PASS

### TC-XX: （FAILの例）
**Op**: `$API update_element '{"node_id":"n100","label":"New"}'`
**Output**:
> [OK] update_element
>   Updated: New (n100)

**Verify**:
1. [OK]レスポンス → PASS
2. get_element n100 → label="New" → PASS
3. スクリーンショット → ヘッダーが"New"に変わっていない → **FAIL**
   - 実際: ヘッダーは旧名のまま（キャッシュ？）

**Result**: FAIL
**Note**: フロントエンドのラベル更新にWebSocket通知が必要な可能性
```

## 検証の原則

1. **Before/After差分** — 操作前後でget_elements等を実行し、ノード数・エッジ数・内容の差分を確認
2. **フィールド単位の正確な検証** — get_elementでlabel, type, code, enabled, position, inputs, outputsを個別に確認
3. **ファイルシステム直接確認** — workspaces/フォルダ、.rcflowファイルの内容を直接読んで確認
4. **スクリーンショットはUI反映の定性確認** — ノード表示、接続線、グレーアウト等の視覚的変化
5. **エラーケースは状態不変を確認** — [FAIL]が返るだけでなく、状態が変わっていないことを確認

---

## 1. Bridge（hiyocanvas-bridge SKILL）

### TC-01: status（停止状態）
**Pre**: HiyoCanvas未起動。`netstat | grep :18731 | grep LISTEN` → 結果なし
**Op**: `$PYTHON $BRIDGE/ctl.py status`
**Verify**:
1. 出力が正確に `stopped`
2. exit code 0

### TC-02: start
**Pre**: `$PYTHON $BRIDGE/ctl.py status` → `stopped`
**Op**: `$PYTHON $BRIDGE/ctl.py start`
**Verify**:
1. 出力に `OK` と秒数が含まれる（`OK (Ns)`形式）
2. `$PYTHON $BRIDGE/ctl.py status` → `running`
3. `$API frontend_status` → `Server: OK` + `Frontend: connected` + client数1以上
4. `netstat | grep :18731 | grep LISTEN` → PIDが1つ存在
5. `netstat | grep :18733 | grep LISTEN` → voice-agentも起動
6. スクリーンショット → HiyoCanvasランチャー画面が表示、ワークスペースカードが見える

### TC-03: status（起動状態）
**Op**: `$PYTHON $BRIDGE/ctl.py status`
**Verify**: 出力が正確に `running`

### TC-04: start（二重起動防止）
**Pre**: TC-02で起動済み。`netstat | grep :18731 | grep LISTEN` → PIDを記録
**Op**: `$PYTHON $BRIDGE/ctl.py start`
**Verify**:
1. 出力が `HiyoCanvas is already running.`
2. `netstat | grep :18731 | grep LISTEN` → PIDが記録値と同じ（新プロセス未生成）

### TC-05: screenshot
**Op**: `$PYTHON $BRIDGE/screenshot.py test_screenshot.png`
**Verify**:
1. 出力に `Saved:` + ファイルパス + `(WxH)` でW,Hが正の整数
2. ファイルが存在する
3. Read toolで画像確認 → HiyoCanvasウィンドウ、タブバー、キャンバス領域が見える

### TC-06: stop
**Pre**: TC-02で起動済み
**Op**: `$PYTHON $BRIDGE/ctl.py stop`
**Verify**:
1. 出力に `Shutdown request: 200` + `done` + 秒数
2. `$PYTHON $BRIDGE/ctl.py status` → `stopped`
3. `netstat | grep :18731 | grep LISTEN` → 結果なし（ポート解放）
4. `netstat | grep :18733 | grep LISTEN` → 結果なし（voice-agentも終了）

### TC-07: stop（未起動時）
**Pre**: HiyoCanvas未起動
**Op**: `$PYTHON $BRIDGE/ctl.py stop`
**Verify**:
1. 出力が `HiyoCanvas is not running.`
2. エラーやスタックトレースが出ない

---

## 2. Diagnostics

**前提**: HiyoCanvas起動済み

### TC-10: frontend_status
**Op**: `$API frontend_status`
**Verify**:
1. `Server: OK` が含まれる（`waiting for frontend`ではない）
2. `Frontend: connected` + `client(s)` の数が1以上
3. `Workspace:` にワークスペース名が表示される
4. `Execution:` に実行状態（`stopped`等）が表示される

### TC-11: get_console_logs
**Pre**: 何か操作を行いログを生成（例: `$API get_elements`）
**Op**: `$API get_console_logs`
**Verify**:
1. `Logs (N/M):` 形式でN,Mが数値
2. 各ログ行に `[HH:MM:SS]` タイムスタンプ + `LEVEL:` が含まれる

### TC-12: get_console_logs（limit指定）
**Op**: `$API get_console_logs '{"limit":3}'`
**Verify**:
1. `Logs (N/M):` でNが3以下
2. 表示されるログ行数が3以内

### TC-13: get_frontend_errors
**Op**: `$API get_frontend_errors`
**Verify**:
1. `No errors` または `Errors (N):` 形式
2. エラーがある場合: 各行に`at src:lineno`形式のソース位置

### TC-14: clear_logs → get_console_logs
**Pre**: `$API get_console_logs` → ログ件数を記録
**Op**: `$API clear_logs`
**Verify**:
1. `Logs cleared` が含まれる
2. `$API get_console_logs` → `No logs` またはクリア後に発生した最小限のログのみ（クリア前より大幅に減少）

---

## 3. Workspace Operations

### TC-20: get_tabs（初期状態）
**Pre**: 起動直後
**Op**: `$API get_tabs`
**Verify**:
1. `Open workspaces (N):` でN=1（Homeタブのみ）
2. `Home (launcher) *` — Homeがアクティブ（`*`マーク）
3. スクリーンショット → タブバーに「Home」タブのみ

### TC-21: open_tab
**Pre**: `$API get_tabs` → タブ数を記録（例: 1）
**Op**: `$API open_tab '{"title":"Test WS"}'`
**Verify**:
1. `Opened: Test WS (tab: tab-xxx)` — タイトルとtab_idが含まれる
2. `$API get_tabs` → タブ数が+1、`Test WS (flow) *` がアクティブ、Homeは`*`なし
3. `ls $WS_DIR/*.rcflow` → 新しい `.rcflow` ファイルが作成される
4. `Read $WS_DIR/<filename>.rcflow` → JSONに `"title": "Test WS"`, `"type": "flow"` が含まれる
5. スクリーンショット → タブバーに「Home」+「Test WS」、Test WSが選択状態、空のキャンバス表示

### TC-22: open_tab（タイトルなし — エラー）
**Pre**: `$API get_tabs` → 現状を記録
**Op**: `$API open_tab '{}'`
**Verify**:
1. `[FAIL]` + `Must provide at least one of: title, filename`
2. `$API get_tabs` → Pre と完全一致（状態不変）

### TC-23: list_saved
**Pre**: `ls $WS_DIR/*.rcflow $WS_DIR/*.rcmind` → ファイル一覧を記録
**Op**: `$API list_saved`
**Verify**:
1. `Saved workspaces (N):` のNがファイル数と一致
2. `$WS_DIR`の各ファイル名が一覧に含まれる
3. 各行に `filename: title (type)` 形式

### TC-24: rename_tab
**Pre**: TC-21のfilename(例: test-ws.rcflow)を取得。`Read $WS_DIR/<filename>` → title=`Test WS`
**Op**: `$API rename_tab '{"filename":"<filename>","new_title":"Renamed WS"}'`
**Verify**:
1. `Renamed: <filename> → Renamed WS`
2. `Read $WS_DIR/<filename>` → `"title": "Renamed WS"`（ファイル上で変更確認）
3. ファイル名も新タイトルに合わせて変更される場合がある（実装仕様）
4. `$API get_tabs` → タイトルが`Renamed WS`に変わっている

### TC-25: rename_tab（存在しないfilename — エラー）
**Pre**: `$API list_saved` → 現状を記録
**Op**: `$API rename_tab '{"filename":"nonexistent-xyz.rcflow","new_title":"X"}'`
**Verify**:
1. `[FAIL]` + `Failed to rename`を含むエラー
2. `$API list_saved` → Preと完全一致（状態不変）

### TC-26: switch_tab
**Pre**: `$API get_tabs` → アクティブタブを記録、非アクティブのtab_idを取得
**Op**: `$API switch_tab '{"tab_id":"<home_tab_id>"}'`
**Verify**:
1. `Switched to: Home (tab: <id>)` — 切替先タイトルとtab_id
2. `$API get_tabs` → Homeに`*`マーク、Renamed WSから`*`消失
3. スクリーンショット → Homeタブが選択状態、ランチャー画面が表示

### TC-27: switch_tab（存在しないtab_id — エラー）
**Pre**: `$API get_tabs` → アクティブタブを記録
**Op**: `$API switch_tab '{"tab_id":"tab-nonexistent-999"}'`
**Verify**:
1. `[FAIL]` + エラーメッセージ
2. `$API get_tabs` → アクティブタブがPreと同じ（状態不変）

### TC-28: close_tab
**Pre**: `$API get_tabs` → タブ数とtab_id一覧を記録
**Op**: `$API close_tab '{"tab_id":"<test_ws_tab_id>"}'`
**Verify**:
1. `Closed: <tab_id>`
2. `$API get_tabs` → タブ数が-1、そのtab_idが消えている
3. 別のタブがアクティブになっている
4. スクリーンショット → タブバーからTest WSタブが消えている

### TC-29: delete_tab
**Pre**: `ls $WS_DIR/<filename>` → ファイル存在確認。`$API list_saved` → 件数記録
**Op**: `$API delete_tab '{"filename":"<filename>"}'`
**Verify**:
1. `Deleted: <filename>`
2. `ls $WS_DIR/<filename>` → ファイルが存在しない
3. `$API list_saved` → 件数が-1、そのファイルが消えている

### TC-29E: delete_tab（存在しないfilename — エラー）
**Pre**: `$API list_saved` → 現状を記録。`ls $WS_DIR` → 現状を記録
**Op**: `$API delete_tab '{"filename":"nonexistent-xyz.rcflow"}'`
**Verify**:
1. `[FAIL]` + `Failed to delete`
2. `$API list_saved` → Preと完全一致
3. `ls $WS_DIR` → Preと完全一致

---

## 4. Node CRUD

**前提**: テスト用ワークスペースを開く（`open_tab '{"title":"Node Test"}'`）

### TC-30: get_block_schema
**Op**: `$API get_block_schema '{"type_id":"python_code"}'`
**Verify**:
1. `Block: python_code` が含まれる
2. Parameters セクションに `code` が存在（`label` はパラメータではなくノードプロパティとして設定される）
3. Inputs セクションに `in_0` が存在
4. Outputs セクションに `out_0` が存在

### TC-30E: get_block_schema（存在しないtype — エラー）
**Op**: `$API get_block_schema '{"type_id":"nonexistent_block"}'`
**Verify**:
1. `[FAIL]` + `Block type not found: nonexistent_block`（type_idがエラーメッセージに含まれる）

### TC-31: add_element（Node A）
**Pre**: `$API get_elements` → `Nodes (0):`, `Edges (0):`
**Op**: `$API add_element '{"type":"python_code","parameters":{"label":"Node A","code":"x = 42\nprint(x)"},"position":{"x":100,"y":200}}'`
**Verify**:
1. `Added: Node A (nXXX)` — ラベルとnode_idが含まれる
2. **Before/After**: `$API get_elements` → `Nodes (1):` に `nXXX: Node A (python_code)`
3. **フィールド検証**: `$API get_element '{"node_id":"<id>"}'` で全フィールド確認:
   - `Node: Node A (<id>)` — ラベルとID一致
   - `Type: python_code`
   - `Enabled: true`
   - `Position:` — 指定座標付近（React Flowが微調整する場合あり）
   - `Parameters:` に `label: Node A` と `code:` に `x = 42` 含む
   - `Inputs: in_0`
   - `Outputs: out_0` （接続なし）
4. スクリーンショット → キャンバスにNode Aが表示、ラベル「Node A」が読める

### TC-31E: add_element（type未指定 — エラー）
**Pre**: `$API get_elements` → ノード数を記録
**Op**: `$API add_element '{"parameters":{"label":"No Type"}}'`
**Verify**:
1. `[FAIL]` + `Error:`
2. `$API get_elements` → ノード数がPreと同じ（状態不変）

### TC-31E2: add_element（存在しないtype — エラー）
**Pre**: `$API get_elements` → ノード数を記録
**Op**: `$API add_element '{"type":"nonexistent_xyz","parameters":{"label":"Bad"}}'`
**Verify**:
1. `[FAIL]` + `Error:`
2. `$API get_elements` → ノード数がPreと同じ

### TC-32: add_element（Node B）
**Pre**: `$API get_elements` → `Nodes (1):`
**Op**: `$API add_element '{"type":"python_code","parameters":{"label":"Node B","code":"y = x * 2\nprint(y)"},"position":{"x":400,"y":200}}'`
**Verify**:
1. `Added: Node B (nYYY)` — node_idがNode Aと異なる
2. `$API get_elements` → `Nodes (2):` にNode AとNode Bの両方
3. `$API get_element` → code が改行付きで正しく表示（`|`記法でy = x * 2, print(y)）

### TC-33: get_element
**Op**: `$API get_element '{"node_id":"<node_a_id>"}'`
**Verify**:
1. `Node: Node A (<id>)` — 正しいラベル
2. `Type: python_code`
3. `Enabled: true`
4. `Position:` の(x, y)が数値（NaN等でない）
5. `Parameters:` に label と code の両方
6. `Inputs: in_0`, `Outputs: out_0`

### TC-33E: get_element（存在しないnode_id — エラー）
**Op**: `$API get_element '{"node_id":"n99999"}'`
**Verify**: `[FAIL]` + `Node 'n99999' not found`（node_idがメッセージに含まれる）

### TC-34: update_element（ラベル変更）
**Pre**: `$API get_element` → `Node: Node A`
**Op**: `$API update_element '{"node_id":"<id>","label":"Node A Renamed"}'`
**Verify**:
1. `Updated: <id> (label)` — 変更フィールドが明示
2. `$API get_element` → `Node: Node A Renamed` に変更
3. `$API get_elements` → `<id>: Node A Renamed (python_code)`（旧名`Node A`ではない）

### TC-35: update_element（enabled=false）
**Pre**: `$API get_element` → `Enabled: true`
**Op**: `$API update_element '{"node_id":"<id>","enabled":false}'`
**Verify**:
1. `Updated: <id> (enabled)`
2. `$API get_element` → `Enabled: false`
3. `$API get_elements` → `[DISABLED]` マーク付き
4. スクリーンショット → ノードがグレーアウト（半透明）

### TC-35R: update_element（enabled=true に戻す）
**Op**: `$API update_element '{"node_id":"<id>","enabled":true}'`
**Verify**:
1. `$API get_element` → `Enabled: true`
2. `$API get_elements` → `[DISABLED]`マークなし
3. スクリーンショット → グレーアウト解除

### TC-36: update_element（コード変更 — heredoc）
**Pre**: `$API get_element` → code に `x = 42` を確認
**Op**:
```bash
cat <<'ENDJSON' | $API update_element -
{"node_id":"<id>","code":"x = 42\nprint(f'x = {x}')"}
ENDJSON
```
**Verify**:
1. `Updated: <id> (code)`
2. `$API get_element` → code に `print(f'x = {x}')` が含まれる
3. 旧コード `print(x)` が含まれない

### TC-36E: update_element（存在しないnode_id — エラー）
**Pre**: `$API get_elements` → 現状を記録
**Op**: `$API update_element '{"node_id":"n99999","label":"X"}'`
**Verify**:
1. `[FAIL]` + `Error:`
2. `$API get_elements` → Preと完全一致

### TC-37: get_elements（全件）
**Op**: `$API get_elements`
**Verify**:
1. `Nodes (2):` — 正確に2ノード
2. Node A RenamedとNode Bが両方リストに含まれる
3. 各行に `node_id: label (type)` 形式
4. `Edges (0):` — まだ接続なし

### TC-37Q: get_elements（クエリ検索）
**Op**: `$API get_elements '{"query":"Node B"}'`
**Verify**:
1. Node Bのみ表示
2. Node A Renamedが含まれない

### TC-38: add_element（comment型）
**Pre**: `$API get_elements` → ノード数を記録
**Op**: `$API add_element '{"type":"comment","parameters":{"label":"Test Comment","text":"This is a test comment"}}'`
**Verify**:
1. `Added: Test Comment (nZZZ)`
2. `$API get_elements` → ノード数が+1、`Test Comment (comment)` が含まれる
3. `$API get_element` → `Type: comment`、Parameters に `text: This is a test comment`

---

## 5. Edge Operations

**前提**: Node A Renamed, Node Bが存在

### TC-40: connect
**Pre**:
- `$API get_elements` → `Edges (0):`
- `$API get_element '{"node_id":"<node_a>"}'` → `Outputs:` に接続なし
**Op**: `$API connect '{"source":"<node_a>","source_port":"out_0","target":"<node_b>","target_port":"in_0"}'`
**Verify**:
1. `[OK] connect` + `edge_id:` が含まれる
2. `$API get_elements` → `Edges (1):` に `<node_a>:out_0 → <node_b>:in_0`
3. **Source側**: `$API get_element '{"node_id":"<node_a>"}'` → Outputs に `out_0 → <node_b>:in_0`
4. **Target側**: `$API get_element '{"node_id":"<node_b>"}'` → Inputs にin_0が接続済み
5. スクリーンショット → 2ノード間に接続線が表示

### TC-40E: connect（存在しないnode_id — エラー）
**Pre**: `$API get_elements` → エッジ数を記録
**Op**: `$API connect '{"source":"n99999","source_port":"out_0","target":"<node_b>","target_port":"in_0"}'`
**Verify**:
1. `[FAIL]` + `Error:`
2. `$API get_elements` → エッジ数がPreと同じ（状態不変）

### TC-40E2: connect（パラメータ不足 — エラー）
**Op**: `$API connect '{"source":"<node_a>"}'`
**Verify**: `[FAIL]` + 必須パラメータに関するエラー

### TC-41: disconnect
**Pre**:
- `$API get_elements` → `Edges (1):`
- `$API get_element '{"node_id":"<node_a>"}'` → Outputs に接続あり
**Op**: `$API disconnect '{"source":"<node_a>","source_port":"out_0","target":"<node_b>","target_port":"in_0"}'`
**Verify**:
1. `Disconnected: <node_a>:out_0 → <node_b>:in_0`
2. `$API get_elements` → `Edges (0):`
3. `$API get_element '{"node_id":"<node_a>"}'` → Outputs に接続なし
4. `$API get_element '{"node_id":"<node_b>"}'` → Inputs に接続なし
5. スクリーンショット → 接続線が消えている

### TC-41E: disconnect（既に切断済み — エラー）
**Op**: TC-41と同じコマンドを再実行
**Verify**:
1. `[FAIL]` + `Error:`
2. `$API get_elements` → `Edges (0):`（状態不変）

### TC-42: connect（再接続 — 後続テスト用）
**Op**: TC-40と同じ
**Verify**: `$API get_elements` → `Edges (1):`

---

## 6. Execution Operations

**前提**: Node A Renamed(x=42) → Node B(y=x*2, print(y)) が接続済み

### TC-50: start_execution
**Op**: `$API start_execution`
**Verify**:
1. `Flow execution started (N nodes)` — Nがenabledノード数と一致
2. 3秒待機後、`$API get_execution_status` が実行可能

### TC-51: get_execution_status
**Op**: `$API get_execution_status`（TC-50完了後）
**Verify**:
1. `Status: stopped (X.XXs)` — 正常完了（実行完了後のステータスは`stopped`）
2. Node A Renamed: `OK (X.XXs)` — 実行時間が正の数
3. Node B: `OK (X.XXs)` — 実行時間が正の数
4. ノードラベルが表示されている（IDではなくラベル）
5. `SKIPPED`や`ERROR`がない

### TC-52: get_execution_result（計算結果の検証）
**Op**: `$API get_execution_result '{"node_id":"<node_a>"}'`
**Verify**:
1. `Result: Node A Renamed (<id>) — OK`
2. `Output:` に `42` が含まれる（print(x)の出力）
3. `Error:` セクションがない

**Op**: `$API get_execution_result '{"node_id":"<node_b>"}'`
**Verify**:
1. `Result: Node B (<id>) — OK`
2. `Output:` に `84` が含まれる（x=42, y=42*2=84 — Jupyterカーネル名前空間でxが共有されていることの証明）
3. `Error:` セクションがない

### TC-52E: get_execution_result（存在しないnode — エラー）
**Op**: `$API get_execution_result '{"node_id":"n99999"}'`
**Verify**: `[FAIL]` + `No result found for node n99999`

### TC-53: get_execution_result（max_lines指定）
**Op**: `$API get_execution_result '{"node_id":"<node_b>","max_lines":1}'`
**Verify**: Output行数が1以内

### TC-54: stop_execution（実行中でない時）
**Op**: `$API stop_execution`
**Verify**: `Flow execution stopped` — クラッシュせず正常応答

### TC-55: start_execution（disabledノード含む）
**Pre**: `$API update_element '{"node_id":"<node_a>","enabled":false}'` → `Enabled: false`確認
**Op**: `$API start_execution` → 3秒待機 → `$API get_execution_status`
**Verify**:
1. Node A Renamed: `SKIPPED [DISABLED]`
2. Node B: `ERROR` の可能性（xが未定義）または `OK`（前回のカーネル状態が残っている場合）
3. `$API get_execution_result '{"node_id":"<node_a>"}'` → 結果なし or SKIPPED
**後処理**: `$API update_element '{"node_id":"<node_a>","enabled":true}'`

---

## 6b. Step Execution Operations

**前提**: Node A Renamed(x=42) → Node B(y=x*2, print(y)) が接続済み。TC-55後処理でNode Aがenabled=trueに戻っていること

### TC-56: step_start
**Pre**: `$API frontend_status` → `Execution: stopped`
**Op**: `$API step_start`
**Verify**:
1. `Step execution started` + `total_steps` が2以上（enabledノード数）
2. `$API frontend_status` → `Execution: stepping`
3. スクリーンショット → 最初のノードに青い破線枠（exec-next表示）

### TC-57: step_next（1回目）
**Op**: `$API step_next`
**Verify**:
1. `Step executed:` + ノードIDが含まれる
2. `$API get_execution_result '{"node_id":"<executed_node>"}'` → `OK` + 出力あり
3. スクリーンショット → 実行済みノードに緑枠、次ノードに青い破線枠

### TC-58: step_next（2回目 — 全完了）
**Op**: `$API step_next`
**Verify**:
1. `Step executed:` + ノードIDが含まれる
2. `$API get_execution_status` → `Status: completed`
3. `$API get_execution_result '{"node_id":"<node_b>"}'` → `Output:` に `84`
4. `$API frontend_status` → `Execution: stopped`（ステッピング完了でidle復帰）

### TC-59: step_start + run_remaining
**Pre**: `$API step_start` → stepping状態
**Op1**: `$API step_next` → 1ノード実行
**Op2**: `$API run_remaining`
**Verify**:
1. `Running remaining` + 残りステップ数
2. 3秒待機 → `$API get_execution_status` → `Status: completed`
3. 全ノードの結果が取得可能

### TC-59R: step_reset
**Pre**: `$API step_start` → stepping状態
**Op**: `$API step_reset`
**Verify**:
1. `Step execution reset`
2. `$API frontend_status` → `Execution: stopped`（idle復帰）
3. スクリーンショット → 青い破線枠が消えている

### TC-59E: step_next（stepping中でない — エラー）
**Pre**: `$API frontend_status` → `Execution: stopped`
**Op**: `$API step_next`
**Verify**: `[FAIL]` + エラーメッセージ（クラッシュしない）

### TC-59E2: step_start（エラーノード）
**Pre**: Node Aのコードを構文エラーに変更: `$API update_element '{"node_id":"<node_a>","code":"x = !!!"}'`
**Op**: `$API step_start` → `$API step_next`
**Verify**:
1. step_nextで `Error:` を含むエラー応答
2. `$API frontend_status` → `Execution: stopped`（エラーでidle復帰）
**後処理**: `$API update_element '{"node_id":"<node_a>","code":"x = 42\nprint(x)"}'` でコード復元

---

## 7. Canvas Operations

### TC-60: get_tab_contents
**Pre**: `$API get_elements` → ノード数N、エッジ数Mを記録
**Op**: `$API get_tab_contents`
**Verify**:
1. `Nodes (N):` — get_elementsと同じノードリスト形式（max_chars未指定時はget_elements相当）
2. `Edges (M):` — 接続がget_elementsと一致
3. 座標・コードはmax_chars指定時のみ表示される（未指定時は要素リストのみ）

### TC-61: get_tab_contents（max_chars=0 — コード省略）
**Op**: `$API get_tab_contents '{"max_chars":0}'`
**Verify**: `code:` 行が含まれないこと

**Op**: `$API get_tab_contents '{"max_chars":-1}'`
**Verify**: `code:` 行にコードが完全表示（切り詰めなし）

### TC-62: auto_layout
**Pre**: 各ノードの位置を`$API get_element`で記録
**Op**: `$API auto_layout`
**Verify**:
1. `Auto layout applied`
2. 少なくとも1つのノードのPosition が変更されている（get_elementで確認）
3. スクリーンショット → ノードが整列（重なっていない）

### TC-63: save_tab
**Pre**: `$API get_elements` → ノード数N、エッジ数Mを記録
**Op**: `$API save_tab '{"filepath":"test_save.rcflow"}'`
**Verify**:
1. `Saved:` + ファイルパス
2. ファイルが存在する（`ls`で確認）
3. ファイルをReadで直接読み、JSONとして: nodes配列のlength=N, edges配列のlength=M

### TC-63E: save_tab（パスなし — エラー）
**Op**: `$API save_tab '{}'`
**Verify**: `[FAIL]` + `Error:`

### TC-64: clear_canvas
**Pre**: `$API get_elements` → `Nodes (N):` でN>0
**Op**: `$API clear_canvas`
**Verify**:
1. `Canvas cleared`
2. `$API get_elements` → `Nodes (0):`, `Edges (0):`
3. `$API get_tab_contents` → `Canvas: 0 nodes, 0 edges`

### TC-65: load_tab
**Pre**: TC-64でキャンバス空。TC-63のファイルが存在
**Op**: `$API load_tab '{"filepath":"test_save.rcflow"}'`
**Verify**:
1. `Loaded:` + `(N nodes, M edges)` — TC-63の保存時と一致
2. `$API get_elements` → ノード数・エッジ数がTC-63 Preと一致
3. `$API get_element` → ノードのラベル・コード内容が保存前と一致

### TC-65E: load_tab（存在しないファイル — エラー）
**Pre**: `$API get_elements` → 現状を記録
**Op**: `$API load_tab '{"filepath":"nonexistent_file.rcflow"}'`
**Verify**:
1. `[FAIL]` + `Error:`
2. `$API get_elements` → Preと同じ（状態不変）

---

## 8. Subgraph Operations

**前提**: Node A Renamed, Node B, Test Commentが存在

### TC-70: create_subgraph
**Pre**: `$API get_elements` → Subgraphsセクションなし
**Op**: `$API create_subgraph '{"node_ids":["<node_a>","<node_b>"],"label":"Processing Group"}'`
**Verify**:
1. `Created subgraph: Processing Group (sgXXX)` — subgraph_id取得
2. `$API get_elements` → `Subgraphs (1):` に `Processing Group [<node_a>, <node_b>]`
3. Test Comment（nZZZ）はサブグラフに含まれない

### TC-70E: create_subgraph（ノード1つ — エラー）
**Pre**: `$API get_elements` → サブグラフ数を記録
**Op**: `$API create_subgraph '{"node_ids":["<node_a>"],"label":"Solo"}'`
**Verify**:
1. `[FAIL]` + `At least 2 nodes required`
2. `$API get_elements` → サブグラフ数がPreと同じ

### TC-70E2: create_subgraph（存在しないnode — エラー）
**Op**: `$API create_subgraph '{"node_ids":["n99999","n99998"],"label":"Bad"}'`
**Verify**: `[FAIL]` + `Error:`

### TC-71: set_subgraph
**Op**: `$API set_subgraph '{"subgraph_id":"<sg_id>","label":"Renamed Group","collapsed":true}'`
**Verify**:
1. `Updated subgraph: <sg_id> (label, collapsed)` — 変更フィールドが明示
2. `$API get_elements` → サブグラフ名が `Renamed Group`
3. スクリーンショット → サブグラフが折り畳まれている

### TC-71N: set_subgraph（変更なし）
**Op**: `$API set_subgraph '{"subgraph_id":"<sg_id>"}'`
**Verify**: `No changes for subgraph: <sg_id>`

### TC-71E: set_subgraph（存在しないsubgraph — エラー）
**Op**: `$API set_subgraph '{"subgraph_id":"sg99999","label":"X"}'`
**Verify**: `[FAIL]` + `Error:`

### TC-72: ungroup_subgraph
**Pre**: `$API get_elements` → `Subgraphs (1):`、ノード数を記録
**Op**: `$API ungroup_subgraph '{"subgraph_id":"<sg_id>"}'`
**Verify**:
1. `Ungrouped: <sg_id>`
2. `$API get_elements` → Subgraphsなし、ノード数がPreと同じ（ノードは削除されない）

### TC-72E: ungroup_subgraph（存在しないsubgraph — エラー）
**Op**: `$API ungroup_subgraph '{"subgraph_id":"sg99999"}'`
**Verify**: `[FAIL]` + `Error:`

---

## 9. View Operations

### TC-80: fit_all
**Op**: `$API fit_all`
**Verify**:
1. `Viewport fitted to all nodes`
2. スクリーンショット → 全ノードが画面内に収まっている

### TC-81: fit_node
**Op**: `$API fit_node '{"node_id":"<node_a>"}'`
**Verify**:
1. `Viewport fitted to node: <node_a>` — node_idが含まれる
2. `$API get_viewport` → zoom値が変化（ノード単体にフィットするため拡大）

### TC-81E: fit_node（存在しないnode — エラー）
**Op**: `$API fit_node '{"node_id":"n99999"}'`
**Verify**: `[FAIL]` + `Error:`

### TC-82: zoom
**Pre**: `$API get_viewport` → zoom値を記録
**Op**: `$API zoom '{"level":1.5}'`
**Verify**:
1. `Zoom set to 1.5`
2. `$API get_viewport` → `zoom=1.50` 付近（Before/Afterで変化確認）

### TC-82E: zoom（負の値）
**Op**: `$API zoom '{"level":-1}'`
**Verify**: `[FAIL]` + `Error:` またはクランプされて正常応答（クラッシュしない）

### TC-83: get_viewport
**Pre**: `$API get_elements` → ノード数を記録
**Op**: `$API get_viewport`
**Verify**:
1. `Viewport: x=N, y=N, zoom=N` — x,y,zoomが数値
2. `Window: WxH` — W,Hが正の整数
3. `Nodes: N` — get_elementsのノード数と一致

### TC-84: screenshot（full）
**Op**: `$API screenshot '{"mode":"full"}'`
**Verify**:
1. `Screenshot: <path> (N bytes)` — Nが正の整数
2. ファイルが存在する
3. Read toolで画像確認 → キャンバス全体（ノード、接続線）が写っている

### TC-84N: screenshot（node）
**Op**: `$API screenshot '{"mode":"node","node_id":"<node_a>"}'`
**Verify**:
1. `Screenshot: <path> (N bytes)`
2. Read toolで画像確認 → Node Aが写っている

### TC-84E: screenshot（node指定なしでmode=node — エラー）
**Op**: `$API screenshot '{"mode":"node"}'`
**Verify**: `[FAIL]` + `node_id required for mode='node'`

### TC-85: tooltip
**Op**: `$API tooltip '{"node_id":"<node_a>","text":"Test tooltip message","type":"info"}'`
**Verify**:
1. `Tooltip: <node_a> (info)` — node_idとtypeが含まれる
2. スクリーンショット → Node Aにツールチップバルーンが表示

### TC-85E: tooltip（存在しないnode — エラー）
**Op**: `$API tooltip '{"node_id":"n99999","text":"X","type":"info"}'`
**Verify**: `[FAIL]` + `Error:`

### TC-86: hide_tooltip
**Pre**: TC-85でツールチップ表示済み
**Op**: `$API hide_tooltip '{"node_id":"<node_a>"}'`
**Verify**:
1. `Hidden tooltip: <node_a>`
2. スクリーンショット → ツールチップが消えている

---

## 10. Block Registry Operations

### TC-90: search_block_types
**Op**: `$API search_block_types '{"query":"python"}'`
**Verify**:
1. `Found N block(s) matching 'python':` でN≥1
2. `python_code` が結果に含まれる
3. 各行に `id: label [category] - description` 形式

### TC-90E: search_block_types（結果なし）
**Op**: `$API search_block_types '{"query":"zzzznonexistent"}'`
**Verify**:
1. `[OK]`（エラーではない）+ `No blocks found matching: 'zzzznonexistent'`（検索語が含まれる）

### TC-91: register_block
**Pre**: `$API search_block_types '{"query":"test_adder"}'` → `No blocks found`
**Op**:
```bash
cat <<'ENDJSON' | $API register_block -
{"id":"test_adder","label":"Test Adder","category":"Test","parameters":[{"id":"offset","label":"Offset","dtype":"float","default":"0"}],"inputs":[{"id":"in_0","label":"","dtype":"any"}],"outputs":[{"id":"out_0","label":"","dtype":"any"}],"code_template":"result = x + float(${offset})\nprint(result)"}
ENDJSON
```
**Verify**:
1. `Registered: test_adder (Test Adder)` — idとlabelが含まれる
2. `$API search_block_types '{"query":"test_adder"}'` → `Found 1 block(s)` に`test_adder`
3. `$API get_block_schema '{"type_id":"test_adder"}'` → `Block: test_adder`、Parameters に `offset (float)` + `default: '0'`

### TC-91E: register_block（id欠落 — エラー）
**Pre**: `$API search_block_types '{"query":"test"}'` → 件数記録
**Op**: `$API register_block '{"label":"No ID"}'`
**Verify**:
1. `[FAIL]` + `Error:`
2. `$API search_block_types '{"query":"No ID"}'` → ヒットしない（登録されていない）

### TC-92: add_element（カスタムブロック使用）
**Pre**: `$API get_elements` → ノード数記録
**Op**: `$API add_element '{"type":"test_adder","parameters":{"label":"Custom Adder","offset":"5"}}'`
**Verify**:
1. `Added: Custom Adder (nXXX)`
2. `$API get_element` → `Type: test_adder`、Parameters に `offset: 5`
3. `$API get_elements` → ノード数が+1

---

## 11. Batch Operations

### TC-100: batch（基本 + $N変数置換）
**Pre**: `$API get_elements` → ノード数N_before、エッジ数E_before
**Op**:
```bash
cat <<'ENDJSON' | $API batch -
{"operations":[
  {"operation":"add_element","params":{"type":"python_code","parameters":{"label":"Batch A","code":"a = 1"}}},
  {"operation":"add_element","params":{"type":"python_code","parameters":{"label":"Batch B","code":"b = a + 1\nprint(b)"}}},
  {"operation":"connect","params":{"source":"$0","source_port":"out_0","target":"$1","target_port":"in_0"}}
]}
ENDJSON
```
**Verify**:
1. `Batch: 3 commands` + 全行 `[OK]` + `Summary: 3/3 succeeded`
2. [2]のconnectに実際のnode_id（`$0`,`$1`ではなく）が含まれる → $N置換が機能
3. `$API get_elements` → ノード数=N_before+2、エッジ数=E_before+1
4. `Batch A`, `Batch B` が存在し、エッジで接続されている

### TC-100E: batch（途中エラーで停止）
**Pre**: `$API get_elements` → ノード数N_before
**Op**:
```bash
$API batch '{"operations":[{"operation":"add_element","params":{"type":"python_code","parameters":{"label":"OK Node","code":"x=1"}}},{"operation":"get_element","params":{"node_id":"n99999"}},{"operation":"add_element","params":{"type":"python_code","parameters":{"label":"Should Not Run","code":"y=2"}}}]}'
```
**Verify**:
1. [0] `[OK]`、[1] `[FAIL]`、[2]は実行されない
2. `Summary: 1/3 succeeded`（または`1/2`）
3. `$API get_elements` → ノード数=N_before+1（`OK Node`のみ）
4. `$API get_elements '{"query":"Should Not Run"}'` → `Nodes (0):`（作成されていない）

---

## 12. Node削除

### TC-110: remove_element（commentノード）
**Pre**: `$API get_elements` → ノード数N、commentノードのIDを確認
**Op**: `$API remove_element '{"node_id":"<comment_id>"}'`
**Verify**:
1. `Removed: <comment_id>`
2. `$API get_elements` → ノード数=N-1
3. `$API get_element '{"node_id":"<comment_id>"}'` → `[FAIL]` + `Node not found`（確実に削除）

### TC-110E: remove_element（存在しないnode — エラー）
**Pre**: `$API get_elements` → ノード数記録
**Op**: `$API remove_element '{"node_id":"n99999"}'`
**Verify**:
1. `[FAIL]` + `Error:`
2. `$API get_elements` → ノード数がPreと同じ

### TC-111: remove_element（接続ありノード — エッジ自動削除）
**Pre**: Node A → Node B が接続済み。`$API get_elements` → エッジ数を記録
**Op**: `$API remove_element '{"node_id":"<node_a>"}'`
**Verify**:
1. `Removed: <node_a>`
2. `$API get_elements` → Node Aが消え、エッジも消えている
3. Node Bはそのまま存在（接続先は削除されない）
4. `$API get_element '{"node_id":"<node_b>"}'` → Inputs に接続なし

---

## 13. Mindmap Operations

**前提**: HiyoCanvas起動済み

### TC-120: open_tab（mindmap型）
**Pre**: `$API get_tabs` → タブ数を記録
**Op**: `$API open_tab '{"title":"Test Mind Map","type":"mindmap"}'`
**Verify**:
1. `Opened: Test Mind Map (tab: tab-xxx)` — タイトルとtab_idが含まれる
2. `$API get_tabs` → タブ数が+1、`Test Mind Map (mindmap) *` がアクティブ
3. `ls $WS_DIR/*.rcmind` → 新しい `.rcmind` ファイルが作成される
4. スクリーンショット → マインドマップUIが表示（mind-elixirキャンバス）

### TC-121: get_elements（マインドマップ）
**Pre**: TC-120でマインドマップタブがアクティブ
**Op**: `$API tab_action '{"action":"get_elements"}'`
**Verify**:
1. レスポンスに `mindmapData` が含まれる
2. `nodeData` オブジェクトにルートノードの `topic` フィールドがある
3. flow の `flowgraph` ではなく mindmap のデータが返ること

### TC-122: set_data（マインドマップ全体設定）
**Pre**: TC-121で取得したデータ構造を把握
**Op**:
```bash
cat <<'ENDJSON' | $API tab_action -
{"action":"set_data","mindmapData":{"nodeData":{"id":"root","topic":"Updated Root","children":[{"id":"child1","topic":"Child 1"},{"id":"child2","topic":"Child 2"}]}}}
ENDJSON
```
**Verify**:
1. 成功レスポンス（`success: true`）
2. `$API tab_action '{"action":"get_elements"}'` → `topic` が `Updated Root`、children に `Child 1`, `Child 2`
3. スクリーンショット → マインドマップにルート+2子ノードが表示

### TC-123: get_element（マインドマップ個別ノード取得）
**Op**: `$API tab_action '{"action":"get_element","node_id":"root"}'`
**Verify**:
1. `element` オブジェクトに `id: "root"`, `topic: "Updated Root"` が含まれる
2. `childCount` が 2
3. `children` 配列に `child1`, `child2` が含まれる

### TC-124: add_element（マインドマップノード追加）
**Pre**: `$API tab_action '{"action":"get_element","node_id":"child1"}'` → 子ノード数を記録
**Op**: `$API tab_action '{"action":"add_element","parentId":"child1","topic":"Grandchild 1"}'`
**Verify**:
1. `success: true` + `elementId` が返される
2. `$API tab_action '{"action":"get_element","node_id":"child1"}'` → `childCount` が +1
3. スクリーンショット → Child 1 の下に Grandchild 1 が表示

### TC-125: update_element（マインドマップ topic変更）
**Op**: `$API tab_action '{"action":"update_element","node_id":"child2","topic":"Child 2 Renamed"}'`
**Verify**:
1. `success: true` + `Updated child2: topic="Child 2 Renamed"`
2. `$API tab_action '{"action":"get_element","node_id":"child2"}'` → `topic` が `Child 2 Renamed`
3. スクリーンショット → ノード名が「Child 2 Renamed」に変わっている

### TC-126: update_element（マインドマップ 折りたたみ）
**Pre**: child1 に子ノードがある状態（TC-124で追加済み）
**Op**: `$API tab_action '{"action":"update_element","node_id":"child1","expanded":false}'`
**Verify**:
1. `success: true` + `Updated child1: collapsed`
2. スクリーンショット → Child 1 の子ノードが非表示（折りたたまれている）

### TC-126R: update_element（マインドマップ 展開）
**Op**: `$API tab_action '{"action":"update_element","node_id":"child1","expanded":true}'`
**Verify**:
1. `success: true` + `Updated child1: expanded`
2. スクリーンショット → Child 1 の子ノードが再表示

### TC-127: remove_element（マインドマップノード削除）
**Pre**: `$API tab_action '{"action":"get_element","node_id":"root"}'` → `childCount` を記録
**Op**: `$API tab_action '{"action":"remove_element","node_id":"child2"}'`
**Verify**:
1. `success: true` + `Removed: child2`
2. `$API tab_action '{"action":"get_element","node_id":"root"}'` → `childCount` が -1
3. `$API tab_action '{"action":"get_element","node_id":"child2"}'` → エラー（not found）
4. スクリーンショット → Child 2 Renamed が消えている

### TC-127E: remove_element（ルートノード削除 — エラー）
**Op**: `$API tab_action '{"action":"remove_element","node_id":"root"}'`
**Verify**:
1. `success: false` + `Cannot remove root node`
2. `$API tab_action '{"action":"get_elements"}'` → データが保持されている

### TC-128: switch_tab（フロー⇔マインドマップ切替）
**Pre**: フロータブとマインドマップタブが両方開いている。`$API get_tabs` → 各tab_id取得
**Op**: `$API switch_tab '{"tab_id":"<flow_tab_id>"}'`
**Verify**:
1. フロータブに切り替わる（`$API get_tabs` → フロータブに`*`マーク）
2. `$API switch_tab '{"tab_id":"<mindmap_tab_id>"}'` → マインドマップに戻る
3. `$API tab_action '{"action":"get_elements"}'` → TC-122で設定したデータが保持されている

### TC-129: ワークスペース保存検証
**Op**: `Read $WS_DIR/<mindmap_filename>.rcmind`
**Verify**:
1. JSONとして読める
2. `"type": "mindmap"` が含まれる
3. `mindmapData` に設定した内容が含まれる

### TC-129S: screenshot（マインドマップ表示確認）
**Op**: マインドマップタブがアクティブな状態で `$API screenshot '{"mode":"full"}'`
**Verify**:
1. スクリーンショット → マインドマップが表示されている
2. ルートノード「Updated Root」とその子ノードが見える

### TC-129C: close_tab（マインドマップ）
**Pre**: `$API get_tabs` → マインドマップタブのtab_idとタブ数を記録
**Op**: `$API close_tab '{"tab_id":"<mindmap_tab_id>"}'`
**Verify**:
1. `Closed: <tab_id>`
2. `$API get_tabs` → タブ数が-1、マインドマップタブが消えている
3. 別のタブがアクティブになっている

---

## テスト実行順序

1. **Bridge**: TC-01 → TC-07
2. **Diagnostics**: TC-10 → TC-14
3. **Workspace**: TC-20 → TC-29E
4. **Node CRUD**: TC-30 → TC-38
5. **Edge**: TC-40 → TC-42
6. **Execution**: TC-50 → TC-55
6b. **Step Execution**: TC-56 → TC-59E2
7. **Canvas**: TC-60 → TC-65E
8. **Subgraph**: TC-70 → TC-72E
9. **View**: TC-80 → TC-86
10. **Registry**: TC-90 → TC-92
11. **Batch**: TC-100 → TC-100E
12. **Node削除**: TC-110 → TC-111
13. **Mindmap**: TC-120 → TC-129C

## 後処理

1. テスト用ワークスペースを削除
2. テスト用ファイル（test_save.rcflow, test_screenshot.png）を削除
3. `$PYTHON $BRIDGE/ctl.py stop` でHiyoCanvas終了
