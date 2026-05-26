# HiyoCanvas Architecture

## Overview

HiyoCanvas は React Flow ベースのビジュアルノードエディタ。Electron + FastAPI + Jupyter Kernel で構成。
プラグイン方式のタブシステムにより、Flow（ノードエディタ）、Mindmap、Excalidraw、Notes、Files の5種類のワークスペースを統一UIで管理。

## 設計原則

1. **No silent errors** — エラーは必ず表示する。握りつぶさない。コンソールパネルに記録
2. **No fallbacks that hide problems** — フォールバックはデバッグを困難にする。失敗は明確に報告
3. **Plugin-first** — 新しいタブタイプは自己登録パターンで追加。app.tsx の変更を最小限に
4. **Save is explicit** — 自動保存なし。ユーザーが Ctrl+S で明示的に保存。ダーティ表示で通知
5. **Keyboard shortcuts work everywhere** — 共通操作（Ctrl+S, Ctrl+Z等）は全タブで動作
6. **AI-controllable** — 全操作が REST API + WebSocket 経由でプログラムから実行可能

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Electron 33 |
| Build | Vite 6 (frontend/ → dist/) |
| Frontend | React 18 + @xyflow/react 12, TSX |
| Backend | FastAPI + uvicorn |
| Execution | jupyter_client + ipykernel |
| Runtime | Python venv (.venv/) |

## Process Architecture

```
Electron Main Process (src/main.js)
  ├── BrowserWindow → http://127.0.0.1:18731
  ├── FastAPI Child Process (port 18731)
  │     ├── REST API (/api/tools/*, /api/workspaces/*, /api/cdp/*)
  │     ├── WebSocket (/ws/data)
  │     └── Static Files (dist/)
  └── Voice Agent Child Process (port 18733, optional)
        └── RINA (LiveKit + Claude Agent SDK)
```

> **ポートは動的**: 上記の番号（18731 / 18733 / 9222）は優先デフォルトであり固定ではない。起動時にポートが使用中なら Electron は空きポートに自動シフトする。実際に解決されたポートはプロジェクトルートの `.hiyocanvas-runtime.json`（`server_port` / `cdp_port` / `voice_port` / `server_url`）に書き出され、`/api/health`・`/api/config` でも公開される。外部から接続する場合はこれらを参照すること。

## データフロー（End-to-End シーケンス）

### フロー実行 (F5 → 結果表示)

```
User presses F5
  → FlowToolbar.onRunAll()
  → app.tsx handleRunAll()
  → POST /api/tools/start_execution
  → flow_executor.py: トポロジカルソート → 順次実行
  → kernel.py: IPython カーネルで各ノードのコード実行
  → WebSocket broadcast: 各ノードの実行状態 (running/success/error)
  → Frontend: ノード UI に結果表示 (出力テキスト, matplotlib画像, pandas表)
  → useStatusPolling: 2秒ごとにステータスポーリング
  → 完了時: running=false, ボタンを idle 状態に戻す
```

### ファイル保存 (Ctrl+S)

```
User presses Ctrl+S
  → useKeyboardShortcuts → handleSave()
  → useFlowPersistence.handleSave()
  → Flow タブ: buildWorkspaceSavePayload(nodes, edges, viewport)
  → Plugin タブ: tabDataRef.current.get(tabId) → { [dataKey]: data }
  → PUT /api/workspaces/{filename}
  → workspace_manager.save_workspace(): JSON マージ → ファイル書き込み
  → clearDirty(): タスクバーのダーティ表示を消す
```

### AI 操作 (Claude Code → キャンバス)

```
Claude Code: python canvas_api.py add_element '{"type":"python_code"}'
  → HTTP POST /api/tools/add_element
  → tools_router.py → canvas.add_element()
  → ws.send_command() → WebSocket broadcast
  → Frontend useToolCommandHandler: ノードを React Flow に追加
  → WebSocket response → HTTP response → canvas_api.py stdout
```

## 状態管理

### React 側の主要状態

```
app.tsx (トップレベル)
  ├── tabs: TabInstance[]              — オープン中のタブ一覧
  ├── activeTabId: string              — アクティブタブ ID
  ├── nodes: Node[]                    — 現在表示中の React Flow ノード (Flow タブ)
  ├── edges: Edge[]                    — 現在表示中のエッジ (Flow タブ)
  ├── running / stepping: boolean      — 実行状態
  │
  ├── tabStatesRef: Map<tabId, TabState>   — タブごとのキャンバス状態スナップショット
  │     └── TabState: { nodes, edges, viewport, undoStack, redoStack, subgraphStore, dirty, panels }
  │
  ├── tabDataRef: Map<tabId, any>          — プラグインタブのデータ (mindmapData, excalidrawData等)
  │
  └── rfInstance: ReactFlowInstance        — React Flow API インスタンス
```

### 状態のライフサイクル

1. **タブ切替** (`switchTab`): 現タブの state を `tabStatesRef` に保存 → 新タブの state を復元
2. **タブオープン** (`openWorkspace`): API から JSON 読み込み → `tabStatesRef` に初期 state 作成 → プラグインデータは `tabDataRef` に
3. **保存** (`handleSave`): `tabStatesRef` or `tabDataRef` のデータを API に PUT
4. **アプリ終了**: 未保存チェック → 確認ダイアログ → 保存 or 破棄

### 永続化レイヤー

| データ | 保存先 | タイミング |
|--------|--------|-----------|
| ワークスペース内容 | `.rcflow` / `.rcmind` 等 | Ctrl+S 手動保存 |
| オープンタブリスト | `app-state.json` | タブ操作時に自動 |
| アプリ設定 | `app-config.json` | 設定変更時 |

## Tab Plugin System

各タブタイプは自己登録パターンでプラグインとして登録される。

### 登録API

```typescript
registerTabType(id, {
  label, icon, description, defaultTitle,
  dataKey,           // ワークスペースJSONでのキー名 (例: 'mindmapData')
  fileExtension,     // ファイル拡張子 (例: '.rcmind')
  uiConfig,          // { showBlockLibrary, showToolbar, containerClass }
  toolActions,       // WebSocketコマンドハンドラ
})
registerTabComponent(id, ReactComponent)
registerToolbarComponent(id, ToolbarComponent | null)
```

### 登録済みタブタイプ

| Tab | ID | Icon | DataKey | Extension | Toolbar |
|-----|-----|------|---------|-----------|---------|
| Flow | flow | 🔧 | — (built-in) | .rcflow | FlowToolbar (floating) |
| Mindmap | mindmap | 🧠 | mindmapData | .rcmind | MindmapToolbar (floating) |
| Drawing | excalidraw | ✏️ | excalidrawData | .rcexcalidraw | null (Excalidraw内蔵) |
| Notes | notes | 📝 | notesData | .rcnotes | null |
| Files | files | 📁 | filesData | .rcfiles | null |

### コンポーネントライフサイクル

```
1. タブ選択 → switchTab()
2. 前タブの状態を tabStatesRef に保存
3. 新タブの状態を tabStatesRef から復元
4. isFlowTab → ReactFlow を表示
5. !isFlowTab → getTabType(type).component を表示
6. toolbarComponent があれば表示
```

## ワークスペース保存

### ファイル形式

全ワークスペースは単一JSONファイル:

```json
{
  "version": 1,
  "type": "flow",
  "title": "My Flow",
  "description": "",
  "created": "ISO timestamp",
  "modified": "ISO timestamp",
  "canvas": { "nodes": [...], "edges": [...], "viewport": {...} },
  "mindmapData": { ... },
  "excalidrawData": { ... },
  "notesData": { ... },
  "filesData": { ... }
}
```

### 保存フロー

- **Flow タブ**: `buildWorkspaceSavePayload(nodes, edges, viewport)` → PUT /api/workspaces/{filename}
- **プラグインタブ**: `tabDataRef.current.get(tabId)` → `{ [dataKey]: data }` → PUT /api/workspaces/{filename}

### セッション復元

- `app-state.json` にオープン中のタブリスト + アクティブタブを保存
- 起動時に自動復元

## ツールバーシステム

上部固定ツールバーは廃止。各タブが独自のフローティングUIを持つ。

| Tab | Menu | Floating Buttons |
|-----|------|-----------------|
| Flow | ≡ (Save, Save As) | Group/Ungroup, Run/Step/Stop, Layout |
| Mindmap | ≡ (Save, Save As) | Zoom, Direction |
| Excalidraw | Excalidraw内蔵≡ (Save, Save As追加) | Excalidraw内蔵 |
| Notes | サイドバー≡ (Save, Save As) | — |
| Files | — | ← → ナビゲーション |

Save 関数は `window.__hiyoSave` / `window.__hiyoSaveAs` でグローバル公開。

## キーボードショートカット

### 全タブ共通 (Ctrl+S等はグローバルで処理)

| Shortcut | Action |
|----------|--------|
| Ctrl+S | Save |
| Ctrl+Shift+S | Save As |

### Flow タブ専用

| Shortcut | Action |
|----------|--------|
| Ctrl+Z | Undo |
| Ctrl+Y | Redo |
| Ctrl+C | Copy |
| Ctrl+V | Paste |
| Delete | Delete selected |
| Ctrl+G | Group |
| Ctrl+Shift+G | Ungroup |
| Ctrl+B | Toggle block library |
| F5 | Run All |
| Shift+F5 | Stop/Reset |
| F10 | Step |

### 他タブ

Undo/Redo/Copy/Paste は各エディタ（MindElixir, Excalidraw, BlockNote）が内蔵ショートカットで処理。

## Electron IPC

### 既存ハンドラ (src/main.js)

| Channel | Purpose |
|---------|---------|
| show-open-dialog | ファイル/フォルダ選択ダイアログ |
| fs-list-dir | ディレクトリ内容取得 |
| fs-create-folder | フォルダ作成 |
| fs-rename-item | リネーム |
| fs-copy-items | コピー |
| fs-move-items | 移動 |
| fs-trash-items | ゴミ箱へ削除 |
| fs-open-file | システムアプリで開く |

全ハンドラで `isWithinRoot()` によるパストラバーサル防止。

## スペルチェック

Electron 内蔵 Chromium スペルチェック有効 (`webPreferences.spellcheck: true`, 言語: en-US)。
MindElixir のノード編集は patch-package で `contentEditable="true"` + `spellcheck=true` に修正済み。

## ブックマークバー

画面上部の Chrome 風ブックマークバー (`bookmarkBar.tsx`):
- ワークスペースファイルをブックマークとして表示
- フォルダ対応（クリックでドロップダウン）
- ドラッグ＆ドロップで並び替え
- ファイルをフォルダにドラッグで移動
- 「+ 新規」メニュー（タブタイプ選択 + フォルダ作成）→ タスクバーに移動済み
- ワークスペースフォルダ切替ボタン
- 並び順は `app-state.json` の `bookmarkOrder` に保存

## タスクバー

画面下部のタスクバー (`taskbar.tsx`):
- オープン中のタブをアイコン + タイトルで表示
- クリックでタブ切替（タブ全体がクリック対応）
- ドラッグ＆ドロップでタブ順序変更
- × ボタンでタブクローズ
- ダーティ表示（● + タイトル）で未保存タブを識別
- タブタイプごとのアクティブカラー（Flow: 青, Mindmap: 黄, Notes: 緑, Excalidraw: 紫）
- 右クリックコンテキストメニュー（Edit...）
- 「+ 新規」ボタン（右側）
- エラーステータス表示（右端）:
  - エラーあり: `⚠ N errors` (クリックでコンソールパネル表示)
  - エラーなし: `✓ エラーなし` (緑)

## コンソールパネル

画面下部の折りたたみ可能なログパネル:
- 実行ログ、エラー、警告を表示
- `consoleLog(level, message, details, source)` で追加
- 最大500件 (`MAX_CONSOLE_LOGS`)
- タスクバーのエラー数クリックで表示/非表示トグル
- `▲ Log` ボタンで手動トグル

## ツールチップシステム

ノードに関連付けられたフローティングツールチップ:
- AI操作（tooltip コマンド）でノード横に情報を表示
- `hide_tooltip` / `clear_tooltips` で非表示
- 各ツールチップに `_respond` コールバックで対話的応答

## コンテキストメニュー

右クリックメニュー（Flow タブ）:
- **ノード**: 編集、削除、グループ化等
- **エッジ**: 削除
- **選択**: グループ操作
- **キャンバス**: ペースト、全選択

## ウィンドウクローズ時の未保存チェック

Electron IPC 経由:
1. ユーザーがウィンドウを閉じようとする → Electron が `window-close-requested` 送信
2. React が `dirtyTabs` をチェック
3. 未保存あり → 確認ダイアログ（Save / Discard / Cancel）
4. Save → `handleSave()` 実行後にクローズ
5. Discard → そのままクローズ
6. Cancel → クローズ中断

## 設定定数 (backend/config.py)

ポート3種は**優先デフォルト**であり固定ではない。それぞれ環境変数 `HIYOCANVAS_SERVER_PORT` / `HIYOCANVAS_VOICE_PORT` / `HIYOCANVAS_CDP_PORT` で上書き可能で、ポートが使用中の場合は `find_free_port` が空きポートへ自動シフトする。解決後の値は `.hiyocanvas-runtime.json` に書き出され、`/api/health`・`/api/config` でも公開される。

| 定数 | デフォルト値 | 説明 |
|------|------|------|
| SERVER_PORT | 18731 | FastAPI サーバーポート（デフォルト、使用中ならシフト） |
| VOICE_AGENT_PORT | 18733 | RINA ボイスエージェントポート（デフォルト、使用中ならシフト） |
| CDP_PORT | 9222 | Chrome DevTools Protocol ポート（デフォルト、使用中ならシフト） |
| WS_COMMAND_TIMEOUT | 5s | WebSocket コマンドタイムアウト |
| FLOW_EXECUTION_TIMEOUT | 300s | フロー実行タイムアウト |
| KERNEL_START_TIMEOUT | 10s | Jupyter カーネル起動タイムアウト |
| MAX_FRONTEND_ERRORS | 20 | フロントエンドエラー保持数 |
| MAX_CONSOLE_LOGS | 500 | コンソールログ保持数 |
| OUTPUT_TRUNCATE_FULL | 5000 | 出力切り詰め（全体） |
| OUTPUT_TRUNCATE_SUMMARY | 500 | 出力切り詰め（要約） |

## パッチ (node_modules)

`patches/mind-elixir+5.9.2.patch`:
1. ノードを折りたたんだ親にドロップした時の自動展開を無効化
2. ノード編集時のスペルチェックを有効化 (`contentEditable="true"`)
