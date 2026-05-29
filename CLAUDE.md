# CLAUDE.md - HiyoCanvas

## Project Overview

HiyoCanvas: React FlowベースのビジュアルノードエディタをElectron + FastAPIで構築するプロジェクト。
Jupyter Kernelでフロー実行可能。venv環境で動作し、GNU Radio/Radioconda依存を排除。

**現状の主な特徴**: エッジ＝実行順序のみ（データパッシング廃止）、ノードUI（タブ廃止、コードtextarea、ポートラベル非表示、ヘッダーリネーム）、リッチ表示（matplotlib画像、pandas HTML表、result_value）。タブごとに独立したAIターミナル（PTY/WebSocket）、パネル表示状態のタブ別保存・復元。

- **References**: `references/` にアーキテクチャ、タブ別仕様、API、RINA 文書（目次は `references/INDEX.md`）
- **SKILL.md** (`.claude/skills/hiyocanvas/SKILL.md`): AIからキャンバスを操作するための全手順・ルール

## Git / リポジトリ構成 (IMPORTANT)

**場所**: `d:\kamijo\HiyoCanvas`（ブランチ `main`）。

**Remote 構成（2026-05-26〜）**:

| Remote | URL | 用途 |
|--------|-----|------|
| `origin` | `https://github.com/yokami831/SAR-Simulator.git` | 本プロジェクトの正リポジトリ。push 先はここのみ |
| `upstream` | `https://github.com/manahiyo831/HiyoCanvas.git` | HiyoCanvas 本家。**fetch 専用**（push URL は `no_push` に差し替え済み、誤 push 防止） |

- 本家 HiyoCanvas のアップデートを取り込む時は `git fetch upstream` → 必要な部分のみ cherry-pick。**`git push upstream` は実行禁止**（URL レベルで失敗するよう設定済み）。
- ローカルの作業はすべて `d:\kamijo\HiyoCanvas` 内。**他フォルダの git status は無関係**。
- このリポジトリには複数の作業（`workspace-SAR-SIM/`, `workspace-FPGA-HIL/` など）と一時ファイルが混在する。**コミット方針:**
  1. **関連ファイルだけ `git add` で名指し**（`git add .` / `git add -A` は禁止 — 無関係な別タスクの変更や一時ファイルを巻き込む）
  2. **一時ファイル** (`tmp_*`, `tmp.json`, `ids.txt` 等) と **`logs/`**（レンダラークラッシュ診断ログ）は `.gitignore` 済み。コミットしない
  3. **`tmp/` フォルダ専用**: SKILL ワークフロー (`canvas_api.py update_element` の `code_file` / `add_element` の `@file`) で作る一時ファイルは **必ず `tmp/<name>.{py,json}` に書く**。リポジトリルートに `tmp_*.py` / `tmp_*.json` を散らかさない（旧パターンは非推奨）。`tmp/` は `.gitignore` 済み
  4. コミット前に `git status --short` で意図したファイルのみがステージされているか確認

**セーフティタグ**: `safety/pre-upstream-merge-2026-05-26` — 本家からの取り込み前の main を固定。万が一に備えてローカル保持。

## 一時ファイルは `tmp/` に置く (IMPORTANT)

作業用スクラッチファイル・調査スクリプト・中間 JSON ペイロード・作業中の指示書 (`*_spec.md`) は **必ず `tmp/` フォルダに作成すること**。プロジェクトルートを散らかさない。

- **対象**: `tmp_*.py` / `tmp_*.json` / `tmp_*.png` 等のスクラッチ、Claude Code 用の中間 JSON ペイロード (`@file` パターンで使うもの)、作業中の指示書 (`*_spec.md`)、その他の使い捨てファイル
- **例外**: ユーザーが明示的に別の場所を指定した場合のみ。プロジェクト永続文書は `references/` 配下
- **使い方**: `tmp/payload.json` のように `tmp/` 配下に作る。`@file` で渡す時も `'@tmp/payload.json'`
- **`tmp/` フォルダは `.gitignore` 済み**でコミット対象外。フォルダが存在しない場合は `mkdir tmp` で作る
- ⚠️ 古い習慣でプロジェクトルートに `tmp_*` を作らないこと（過去にはルート直下に置く例があったが廃止）

## Architecture

```
src/
  main.js                 ← Electron main process（子プロセス管理 + BrowserWindow）
frontend/                 ← ソースコード（直接配信しない。Viteでビルド → dist/）
  index.html              ← HTML構造（Viteエントリポイント）
  styles.css              ← 全スタイル定義
  js/
    app.tsx               ← メインAppコンポーネント + エントリポイント + タブ管理
    backend.ts            ← API通信 + WebSocket + コンソールログ + 実行状態ハンドラ
    blockLibraryData.ts   ← ブロック定義データ + 純粋関数（createNode, parseCategoryTree等）
    components.tsx        ← CanvasNode + ContextMenu + Legend + InlineParamRow + 実行結果表示
    chat.tsx              ← AIチャットUI（voice-agent bridge経由、音声/テキスト統一セッション）
    tabs.tsx              ← TabBar + Tab + NewTabPopup + WorkspaceCard
    tabRegistry.ts        ← タブタイプ定義（launcher, flow）
    subgraph.tsx          ← サブグラフ（ノードグルーピング/階層）
    modal.ts              ← カスタムモーダルダイアログ (confirm/prompt/alert)
    types.ts              ← 共通型定義
    global.d.ts           ← Window拡張の型宣言
    constants.ts          ← フロントエンド定数（タイミング、色、UIバッファ上限）
    notes.tsx             ← Notesタブ（BlockNoteベースリッチテキストエディタ、.rcnotes）
    utils.ts              ← 純粋ユーティリティ関数（React依存なし）
    components/
      PythonEditor.tsx    ← CodeMirror 6 Pythonエディタ（シンタックスハイライト、エラー行表示）
      NoteEditor.tsx      ← BlockNote エディタラッパー
      NotesSidebar.tsx    ← Notes ページリストサイドバー
      BlockLibrarySidebar.tsx ← ブロックライブラリサイドバー（React Portal経由）
    hooks/
      useUndoRedo.ts      ← Undo/Redoヒストリ管理
      useClipboard.ts     ← コピー/ペースト/カット操作
      useTabManager.ts    ← ワークスペース（タブ）CRUD・切り替え・状態保存復元
      useToolCommandHandler.ts ← AI tool command dispatch（WebSocket経由）
      useFlowPersistence.ts ← フロー保存/読込（.rcflow + workspace API）
      useNodeOperations.ts  ← ノード/エッジCRUD・レイアウト・D&D
      useSubgraphOps.ts     ← サブグラフ全操作（グループ化/展開/折り畳み）
      useKeyboardShortcuts.ts ← キーボードショートカット管理
      useStatusPolling.ts   ← 実行ステータスポーリング
dist/                     ← Viteビルド出力（FastAPIが配信。.gitignore対象）
backend/
  server.py               ← FastAPI app + WebSocket + ミドルウェア + 静的ファイル
  config.py               ← ポート/ネットワーク/タイムアウト/出力切り詰め定数の一元管理
  code_utils.py           ← 共有コード生成ユーティリティ（GUI変数代入コード等）
  tools/                  ← AI agent用ツール関数パッケージ（WebSocket経由でフロントエンド操作）
    __init__.py           ← 全関数の再エクスポート
    ws.py                 ← WebSocket通信基盤 + ブロードキャスト
    canvas.py             ← ブロックCRUD・状態・ビュー・ツールチップ・サブグラフ・マインドマップ
    workspaces.py         ← ワークスペースCRUD（open/close/switch/list/delete/rename）
    execution.py          ← run/stop/status/result
    file_io.py            ← save/load/reload/shutdown
    batch.py              ← バッチ操作
  plugins/python_canvas/
    kernel.py             ← Jupyter IPythonカーネル管理（start/stop/execute/interrupt）
    flow_executor.py      ← フロー実行エンジン（トポロジカルソート + 順次実行 + WebSocket通知）
    blocks/
      _builtin/           ← 組み込みブロック定義（python_code, comment）
      user/               ← ユーザー定義ブロック（JSON、自動読み込み）
  block_registry.py       ← ブロック定義レジストリ（JSON読み込み + ランタイム登録）
  workspace_manager.py    ← ワークスペースCRUD（list/create/load/save/delete/rename）
  cdp.py                  ← CDP (Chrome DevTools Protocol) スクリーンショット + ビュー制御
  routers/                ← FastAPI APIRouter モジュール
    tools_router.py       ← /api/tools/* エンドポイント
    workspaces_router.py  ← /api/workspaces/* エンドポイント
    cdp_router.py         ← /api/cdp/* エンドポイント
    blocks_router.py      ← /api/blocks エンドポイント
    notes_router.py       ← /api/notes/* エンドポイント（Notesタブ用）
    vcd_router.py         ← /api/vcd/* エンドポイント（VCDファイルビューア）
workspaces/               ← デフォルトのワークスペースフォルダ（変更可能、HOME画面から切替）
app-config.json           ← アプリ全体設定（lastWorkspacesDir等、プロジェクトルートに固定）
references/
  INDEX.md                ← references/ の目次
  architecture.md         ← 共通アーキテクチャ（プラグインシステム、保存、ショートカット、UI構造）
  api_reference.md        ← 全REST APIエンドポイント一覧
  blocks.md               ← ブロック定義フォーマット仕様
  rich_display.md         ← リッチHTML/3D表示テンプレート
  troubleshooting.md      ← よくある問題と解決策
  skill-api.md            ← SKILL / AI操作API
  rina-voice-agent.md     ← RINA ボイスエージェント
  tab-flow.md             ← Flow タブ仕様
  tab-flow-fpga.md        ← FPGA/HDL 拡張
  tab-mindmap.md          ← Mindmap タブ仕様
  tab-excalidraw.md       ← Excalidraw タブ仕様
  tab-notes.md            ← Notes タブ仕様
  tab-files.md            ← Files タブ仕様
vite.config.js            ← Vite設定（root=frontend, build→dist/, proxy設定）
package.json              ← Electron + Vite + React/xyflow/xterm依存
start.bat                 ← 起動スクリプト（venv activate → Electron起動）
tests/
  test_server.py          ← APIエンドポイントテスト
  test_flow_executor.py   ← フロー実行エンジンテスト
  test_workspace_manager.py ← ワークスペースCRUDテスト
  test_block_registry.py  ← ブロック定義レジストリテスト
  test_batch_vars.py      ← バッチ変数展開テスト
```

## Feature Map（機能インデックス）

実装済み機能の一覧。詳細は各ファイルや references/ を参照。

### タブタイプ
| Type | ファイル | 説明 |
|------|---------|------|
| flow | app.tsx, components.tsx | ノードフローエディタ（デフォルト） |
| mindmap | mindmap.tsx | MindElixirベース、ノードスタイルパネル付き |
| excalidraw | excalidraw.tsx | 手書きドローイング（.rcexcalidraw） |
| notes | notes.tsx | BlockNoteベースリッチテキストエディタ（.rcnotes） |
| launcher | tabs.tsx | ホーム画面 |

タブプラグインシステム: `tabRegistry.ts` で registerTabType/registerTabComponent

### 設定ファイル（2種類）

**フォルダ固有設定**: `<workspace_dir>/app-state.json`、API: `GET/PATCH /api/app-state`
- ワークスペースフォルダごとに存在。フォルダ切替で自動的に切り替わる。

| Key | Default | 説明 |
|-----|---------|------|
| chatEnabled | true | AIチャットパネル表示/非表示 |

**アプリ全体設定**: `app-config.json`（プロジェクトルート固定）
- ワークスペースフォルダとは独立。

| Key | Default | 説明 |
|-----|---------|------|
| lastWorkspacesDir | workspaces/ | 最後に使ったワークスペースフォルダ。起動時に自動復元 |

### 追加APIエンドポイント（api_reference.md未記載）
| Endpoint | 説明 |
|----------|------|
| GET/PATCH /api/app-state | フォルダ固有設定 |
| GET/PUT /api/workspaces-dir | ワークスペースフォルダの取得/変更 |
| POST /api/chat-log | チャットログ追記 |
| GET /api/config | サーバー設定（voice WS, CDPポート） |

### Voice Agent（RINA）
- 場所: `voice-agent/`（agent.py, bridge.py, claude_llm_plugin.py）
- 構成: LiveKit + Claude Agent SDK、WebSocket bridge
- ポート: VOICE_AGENT_PORT=18733（backend/config.py）
- agent.pyが存在しない場合は自動スキップ

### リファレンスドキュメント

`references/INDEX.md` を参照（リスト本体は上の Architecture セクションに集約）。

## Terminology

| ユーザー向け | コード内部 | 説明 |
|-------------|-----------|------|
| ブロック | ノード (node) | キャンバス上に配置する部品 |
| 接続 | エッジ (edge) | ブロック間の線 |
| ワークスペース | workspace / tab | 作業単位（保存・切替の単位） |
| キャンバス | canvas | ブロックを置く領域 |

**重要:** ユーザーに見える部分（UI、AIの発言、ドキュメント）は「ワークスペース」で統一。「タブ」は画面上部のUI部品の説明でのみ使用。コード内部では `tab` と `workspace` 両方可。

## Technology Stack

- **Desktop**: Electron 33 (BrowserWindow → localhost:18731)
- **Build**: Vite 6 (frontend/ → dist/ バンドル)
- **Frontend**: React 18.2.0 + @xyflow/react 12 (npm, Viteでバンドル), TSX
- **Backend**: FastAPI + uvicorn
- **Execution**: jupyter_client + ipykernel（IPythonカーネルでフロー実行）
- **Runtime**: Python venv (`.venv/`)

### 通信方式の使い分け

- **WebSocket (`send_command`)**: 原則すべての操作はこちらを使う
- **CDP (Chrome DevTools Protocol)**: WebSocketでは実現できない操作のみ（例: screenshot = ブラウザ画面キャプチャ）
- 新規操作を追加する際はまずWebSocketで実現可能か検討し、不可能な場合のみCDPを使う

## Block Definition System (3層構成) (IMPORTANT)

ブロック定義の置き場所は **3層** に分かれている。**新規ブロックを追加する/既存ブロックを動かすときは必ずこの優先順位に従うこと。**

| 層 | 場所 | 役割 | 例 |
|----|------|------|-----|
| 1. Built-in | `backend/plugins/python_canvas/blocks/_builtin/` | HiyoCanvas本体の土台。**触らない** | `python_code`, `comment`, `gui_slider`, `gui_dropdown`, … |
| 2. Global Library (汎用テンプレ) | `backend/plugins/python_canvas/blocks/user/` | プロジェクトを跨いで使う汎用ブロック | `csv_reader`, `http_request`, `plot_chart`, `timer`, `data_filter`, `sdf_3d_*` |
| 3. Workspace-scoped | `<workspaces_dir>/blocks/*.json` | そのワークスペース専用のブロック | `workspace-SAR-SIM/blocks/sar_visualizer.json`, `workspace-FPGA-HIL/blocks/hil_*.json` |

### ロード順と優先順位

`_builtin → plugin user → workspace` の順でロード、**同IDがあれば後勝ち + WARNING ログ**。
つまり workspace > plugin user > _builtin。 workspaceでカスタマイズすれば global を上書きできる。

### ワークスペース切替時の挙動

`workspaces_dir` を切り替えると、 backend が自動的に旧 workspace の `blocks/` をアンロード、新 workspace の `blocks/` をロードする。同時に WebSocket で `blocks_changed` をフロントへ通知し、ブロックライブラリパネルが再フェッチされる。

### 新規ブロックをどこに置くか判断

- そのブロックが **特定ワークスペース固有** (SAR専用、HIL専用) → **`<該当workspace>/blocks/` に置く** ← **デフォルトはこれ**
- 複数プロジェクトで汎用的に再利用したい (CSV読み込みのような) → `backend/plugins/python_canvas/blocks/user/` に置く
- HiyoCanvas本体の土台機能 → `_builtin/` (ほぼ追加することはない)

**判断に迷う場合は workspace 配下に置く。** あとから global に「昇格」させる方が、global を汚染してから戻すより安全。

### `register_block` API のデフォルト保存先

`POST /api/tools/register_block` で動的にブロックを追加するとき:
- デフォルト (`scope:"auto"` または未指定): **active workspace の `blocks/` に保存**
- `scope:"global"` 明示時のみ `plugin/blocks/user/` に保存
- `scope:"workspace"` で workspace 強制 (未設定ならエラー)

### 未知ブロックの扱い

`.rcflow` を開いたときに使用ブロックが registry に見つからない場合:
- **flow 自体は開ける** (shimブロック = 灰色プレースホルダで表示)
- **不足ブロック名がバナーで明示通知**される
- **実行は中断**される (中途半端な実行を防ぐ)
- 復旧手順: 元 workspace から該当 `.json` を該当 workspace の `blocks/` フォルダにコピー → リロード

### ⚠️ ファイル配布時の注意

ワークスペースを誰かに渡す/別フォルダにコピーする時は、 **必ず `<workspace>/blocks/` フォルダごと**コピーすること。 `.rcflow` 単体ではブロック定義は付いてこない (定義埋め込みは行わない設計)。

### ⚠️ やってはいけないこと

- ❌ workspace 専用のブロックを `plugin/blocks/user/` (global) に置く — 他プロジェクトに不要なブロックが混ざる
- ❌ `.rcflow` ファイルにブロック定義を直接埋め込む — 真実の源が分裂し、同期問題が発生する
- ❌ `register_block` で global を上書きする — workspace スコープを明示すること
- ❌ `<workspace>/blocks/` のJSONファイル名と `id` フィールドを不一致にする — ロード時の確認に使う

## Coding Conventions

### 共通関数・ヘルパーの置き場所 (CRITICAL)

フロー（Flowタブ）で複数ノードが使う共通関数（例: `surface3d` のような3D表示ヘルパー、`upsample_complex` のような信号処理ヘルパー、ライブラリ的な関数群）は、**HiyoCanvas本体（backend）にヘルパーとして追加してはならない。**

**正しい置き場所: ワークスペース先頭の「ライブラリノード」**
- 共通関数は、そのワークスペースの**先頭に置いた未接続の python_code ノード**（例: ラベル「Plot Library」）に定義する。
- 未接続（入力エッジなし）のノードはトポロジカルソートで**最初に実行される**ため、後続の全ノードが kernel namespace 経由でその関数を使える。エッジで繋ぐ必要はない。
- ノードの **SPEC に各関数の役割を記述**しておく（後から見て分かるように）。

**理由 / なぜ本体ヘルパーにしてはいけないか:**
1. **見える場所に置く** — ノードとして画面に見えるので、いつでも確認・編集できる。`.rcflow` に焼き込まれて「見えない所に保存」される問題（アップデートが反映されない、古い版が残る）を、ライブラリノードは起こさない（ノード自体を編集すればよい）。
2. **本体を汚さない** — `surface3d` 等は特定ワークスペース（SAR等）固有の機能であって HiyoCanvas の普遍機能ではない。本体（kernel起動時の注入など）に入れると、無関係なプロジェクトにも常に注入され、本体がワークスペース都合の関数を抱え込む。
3. **ワークスペースごとに適切な関数セット** — SAR用はSARワークスペースに、別用途は別ワークスペースに。

**禁止事項:**
- `backend/plugins/python_canvas/kernel.py` の起動時にヘルパーコードを注入する仕組みを作らない。
- `backend/` に「ノードから使う共通Python関数」を集めたヘルパーモジュールを新設しない（`code_utils.py` のような**コード生成**ユーティリティとは別物。あくまで「ノード実行時に呼ばれる表示/処理関数」の話）。
- 過去にこの判断を誤り `kernel_helpers.py` を作って kernel 起動時に注入したことがあるが、上記理由で**撤回済み**。同じことを繰り返さないこと。

### SAR画像ターゲット & 3D表示のメモリ（CRITICAL — 恒久。定量値で判断すること）

SAR シミュレータ（`workspace-SAR-SIM/SAR-Simulator-NUFFT2.rcflow`、ユーザーが NUFFT→NUFFT2 にリネーム）の画像ターゲット対応。詳細な引き継ぎは `workspace-SAR-SIM/docs/image-target-handoff-2026-05-24.md`。

**⚠️ 新エージェントへ: 3D表示のメモリ問題は「GLバイナリ単一レンダラー方式」で解決済み。曖昧に『メモリが危険』と警告したり max-pool 間引きを再提案したりしないこと。判断は下の定量値で行う。**

**現在の3D表示 = `surface3d_gl` / `surface3d_pair_gl`（GLバイナリ単一レンダラー方式、実装済み）**
- 頂点を **float32 base64 で1回だけ** emit（新mime `application/x-hiyocanvas-surface3d`）→ React `Surface3D.tsx` + `SurfaceRendererManager.ts`（**単一WebGLレンダラー共有**）で描画。**iframe不使用**。
- Plot Library(n31) は `surface3d_gl`/`surface3d_pair_gl` **のみ**定義。**旧 `surface3d`/`surface3d_pair`/`_maxpool_to_cap`/間引きは撤回・削除済み**（`MAX_VERTS` の残骸があれば未使用）。**max-pool 間引きはもう無い = 忠実 full-res 表示**（ユーザーの最重要要件）。
- 頂点バッファは**案A実装済み**（`SurfaceRendererManager._rebuildMesh`、2026-05-24）: **position は頂点シェーダーで `gl_VertexID` から生成**（indexed draw では gl_VertexID = index要素値 = flat k=r*C+c → `c=k%C, r=k/C, x=c*invC-1, z=r*invR-1, y=t*H`）、**height t は uv.x 属性**で渡す、**color はフラグメントで inferno LUT テクスチャ参照**（フラグメントtexfetchは動く）。per-vertex の pos(12N)/col(12N) 属性を全廃 → geometry は **uv(8N) + index(24N)**。さらに **index は同次元(R,C)サーフェス間で共有**（`acquireIndex`/`releaseIndex` refcount、detach-before-dispose、context-loss時 `indexCache.clear()`）。**position属性が無い→boundingSphere計算不可→`mesh.frustumCulled=false`必須**（これを忘れるとカリングでメッシュが消える）。**忠実性: 旧per-vertexとピクセル一致を確認**（gl_VertexIDで同じ式・同じLUT）。

**⚠️ 頂点シェーダーのテクスチャフェッチはこの Electron/ANGLE 環境で動かない（実測確定 2026-05-24、知見として残す）。** float も uint8 も頂点段で 0 を返す（フラグメント段は動く。CDP で transform-feedback と本番three経路の両方で確認）。だから「方式C＝height を GPUテクスチャ化し**頂点段で**サンプリング」は不可能だった。**一方 `gl_VertexID` は頂点段で動く**（実測確定）ので案Aが成立した。**height を uv.x 属性で渡す中間版（48N→44N=8%）は割に合わず revert 済み（commit a41badd）→ その後この案Aを実装。**

**メモリ実測（案A、現フロー3エントリ=240²+2460×9844×2、CDP実測 2026-05-24）**: pos/color 属性ゼロ、index は同次元2エントリで refcount=2 共有（uniqueIndexBuffers=2種）。uv 369.9MB + 共有index 555.3MB = **925MB**（旧48Nの同構成 ~2327MB に対し **約60%減**）。同次元プロットが増えるほど index 共有が効く。引き継ぎ書 §14 に詳細。さらに削るなら height を uint8(R8) 化（uv→1/4）等が候補だが現状で十分なら不要。

**定量的メモリ実態**（案A、1プロットあたり。2026-05-24 コード実測）:
| 項目 | サイズ | 置き場所 |
|------|--------|---------|
| float32 base64 文字列（emit時、一時→GC） | **~14 MB** | V8文字列ヒープ（一時のみ） |
| uv (Float32×2, height in .x) = 8N | per-entry | GPU/ArrayBuffer（**V8の4GB枠外**） |
| index (Uint32×6/quad) = 24N | **同次元で1個共有** | GPU/ArrayBuffer |
| WebGLコンテキスト | **1個（共有）** | — |

全7プロット フルグリッド: V8文字列ピーク数十MB（順次GC）、GPU/native ~870MB（4GB枠外）。
→ **旧方式で V8 4GBヒープを圧迫していた文字列 ~1005MB（同一頂点を文字列で4重持ち）が ~14MB一時に激減（約70分の1）。頂点本体は GPU/ArrayBuffer に移ったので 4GB上限とほぼ無関係。間引き不要で忠実表示が成立している。**

**レンダラーV8ヒープ ~4GB は硬上限**（Electron 14+ のポインタ圧縮。`--max-old-space-size`/`--js-flags` では上げられない＝実測 jsHeapSizeLimit=4096固定。システムRAM 64GB とは別物）。白画面クラッシュ = renderer OOM（`render-process-gone reason="oom"`、`logs/renderer-crash.log`、診断は src/main.js + src/preload.js）。**この上限は変えられないが、GL方式が頂点を V8外に出したことで現状は余裕がある**。新たに大量の文字列/巨大JS配列を V8 に積む実装（例: payloadを文字列で多重保持、巨大 number[]、全グリッド matplotlib imshow）を**足さない**限り問題ない。

**echo生成は NUFFT（finufft）一本**。echo = 不均等点→均等グリッドのフーリエ変換 = NUFFT Type1、コスト O(Nr·logNr + 散乱点数)。規約（崩すと焦点画像が壊れる）: `chirp_fft = fft(ref_chirp)`（ifftshiftもconjも掛けない）、`x_j = (-2πFs(tau-t_r_center)/Nr).astype(float32)`（finufft complex64 plan は float32 座標必須）、`S = ifftshift(nufft1d1(x,W,Nr,isign=+1))`、carrier `exp(-4jπR/lam)` は **float64** で計算してから complex64 化。画像は **1ピクセル=1分解能セル**（slant `c/(2B)`, az `La/2`）で配置すると連続形状になる。

**n32 は GPU NUFFT (cufinufft) を使う（実装済み・実測 2026-05-24）**。画像ターゲット(NT=714万散乱点)で**241s→89s**。内訳実測: 旧CPU版194s = CPU finufft 84s + GPU precompute 66s + GPU→CPU転送 37s。cufinufft は x_b/w_b を GPU に残し(転送消滅)、type-1 を GPU実行(CPU finufft消滅) → 転送+finufft 121s が ~16s に。peak|s| は CPU版と一致(1506.7、差0.04%=eps床、**忠実**)。残る支配項は GPU precompute 66s(将来 float32化で削減可)。
- **⚠️ Windows kernel で cufinufft を使う罠（恒久・重要）: `import cupy` を `import cufinufft` より必ず先に行う。** cupy が CUDA ランタイムDLLディレクトリを `os.add_dll_directory` で登録し、それが無いと cufinufft のネイティブlibロードが `ImportError: Could not find cufinufft library in system path` で失敗する(順序を逆にすると Electron kernel 内で必ず再現。スタンドアロンでも cupy 未import時は失敗)。n32 はこの順序 + cufinufft import 失敗時は**明示告知して** CPU finufft へフォールバック(サイレントでない)。依存: `pip install cufinufft`(Windows wheel あり。過去「Windowsで全滅」は古い情報、現在は2.5.1 wheel が公式提供)。
- **NUFFTコストは散乱点数 NT 支配**(画像714万点で precompute/transfer/finufft 全段が NT比例)。間引きは禁止(ユーザー方針)なので、高速化は GPU化(cufinufft)・float32 precompute・パイプライン化で行う。`gpu_pb`(パルスバッチ)は NT大で8に落ちる(2e9/NT/32、GPU OOM回避)。

**サンプリング周波数 Fs は手動制御**（n1 で固定値、Bから自動計算しない）。B を上げる実験時は Fs も手動で上げる（Fs ≥ 1.1〜1.2×B でないとエイリアシング）。n30 Fixed Parameters に Fs / Fs比 / サンプル間隔を表示済み。サンプル間隔 `c/(2Fs)` と range分解能 `c/(2B)` は別物。

### SAR n32 = 4 ノードの「FPGA 3 ルート」構成（CRITICAL — 恒久）

`workspace-SAR-SIM/SAR-Simulator-FPGA.rcflow` の n32 は **NUFFTによる係数生成のみ**を行う共通ステージで、s_raw は計算しない。s_raw は下記4ノードのいずれかが生成する:

| ノード | ラベル | 動作 | 既定 |
|--------|--------|------|------|
| n42 | FPGA Route A: Float Ideal (IFFT) | `ifft(S_all × chirp_fft)` を complex64 で計算（旧 n32 末尾と等価）| Enabled |
| n43 | FPGA Route B: Fixed-point (Q-format 3-stage) | `fxpmath` で FFT × 周波数乗算 × IFFT の各ステージを量子化 | Disabled |
| n44 | FPGA Route C-out: Save Coefficients (.mat) | `chirp_replica` / `fir_coefficients` / `S_all` / 任意で `golden_iq_data` を .mat に保存（HDL コシミュ用テストベンチ入力） | Disabled |
| n47 | FPGA Route C-in: Load FPGA IQ (.npy) | 外部 FPGA / HDL シミュ出力の `.npy` を読み込み s_raw に流し込む | Disabled |

**排他ルール**: **Route A / B / C-in は同時 Enable 不可**（同じ `s_raw` を上書きするため最後に実行されたものが残り、誤解を生む）。Route C-out (n44) は副作用のみで s_raw を変更しないので Route A/B と併用可（Route A + Route C-out で golden 付き .mat を生成するのが標準）。

**n32 の出力（kernel namespace）**:
- `S_all` (Na, Nr) complex64 — 周波数領域反射係数
- `chirp_fft` (Nr,) complex64 — `fft(ref_chirp)`、共役なし・ifftshift なし
- `fir_coefficients` (Na, Nr) complex64 — `ifft(S_all, axis=1)` **fftshift なし**。`fft(fir_coefficients) ≡ S_all` を成立させるため。Notebook が fftshift していたのは時間領域可視化都合であり、FFT-mult-IFFT 経路では入れないのが正しい。

**Route B の 3 ステージ Q-format**（ノード code 冒頭で編集）:
- Stage A 入力時間領域 (= ADC ビット幅): `Q_IN_W=10, Q_IN_F=9` (Q1.9, 10bit ADC)
- Stage B FFT 後周波数領域 + 乗算後 (FPGA 内部): `Q_FFT_W=18, Q_FFT_F=10` (整数部 8bit、Xilinx 7系 DSP 18bit に整合、log2(Nr) のビット成長を吸収)
- Stage C IFFT 後時間領域 (= DAC ビット幅): `Q_OUT_W=10, Q_OUT_F=9` (Q1.9, 10bit DAC)
- 各ステージは auto-scale (peak → Q full-scale × 0.95) で量子化し、SNR を per-stage で表示
- 単一点標的での実測: Route A peak\|s\|=1.005 vs Route B peak\|s\|=1.013 (差 0.8%, 出力 SNR=57.7 dB)

**実装**: 量子化は cupy GPU ベクトル化（`cp.clip(cp.round(v*scale/step), iv_min, iv_max)*step/scale`）。fxpmath は per-element Python 経路で 12M 点 × 6 ステージで ~35s、numpy で ~3.4s、cupy で **~0.22s** (JIT キャッシュ後)。signed Q n_word.n_frac の挙動（round-half-to-even / convergent rounding + saturate）は fxpmath と同等を維持。auto-scale (peak → full-scale × 0.95) は実 FPGA の Block Floating Point に相当する shift amount を per-stage で決める方式。

**Block Floating Point (BFP) の文脈と現状の前提**: 動機は「FPGA側でのスケーリングが画像によって大きく変動する」現象の検証。BFP はブロック単位で shift を決める手法で、純固定小数点（全データで同じ shift = 最悪ケースで決まる）と浮動小数点（サンプルごとに指数 = 高コスト）の中間。

**Stage A は fixed Q (実 FPGA の BRAM / 入力テンプレート精度)** に変更済（Level 2）:
- `qz(..., mode='fixed')` で auto-scale なし、FS=2^(n_word-1-n_frac) に対して clip + 量子化
- fir_coefficients は **BRAM 事前スケーリング (1/peak × 0.95)** で FS に入れてから fixed Q1.7 量子化、復元時に逆スケール（BFP の block exponent と等価）。シーンごとに pre-scale が動的に変動するが、固定 shift と等価な実装：シーンごとに 1 つの "BRAM scaling factor" を計算しているだけ
- ref_chirp は peak 1.0 で固定（FPGA テンプレート）、Q1.7 max=0.992 に少し clip（0.22%）

**Stage B/C は引き続き auto BFP**（FPGA 内部 datapath / DAC 出力）。BFP のブロック粒度は **per-stage（ステージ全体 1 shift）= 上限性能** で、実 FPGA の per-FFT-stage / per-pulse BFP より楽観的。

**将来の拡張オプション**:
1. **per-pulse BFP モード**: `mode='per_pulse'` で pulse(row) ごとに shift（SAR の SDF FFT で標準）— 暗いパルスを救う効果あり
2. **receiver-side ADC 量子化ノード**: 現状 Route B Stage A は BRAM/テンプレート量子化（FPGA 内部）であり、受信機 ADC 量子化（n25 LNA 出力に対する）は未実装。SAR 処理チェイン（n9 BPF）の直前に挿入する別ノードが必要

実装は `qz` 関数のシグネチャに `mode` を増やすだけ。ユーザーが画像実験で必要性が見えたら追加する。

### Level 2 RF 物理モデル（CRITICAL — 恒久）

`workspace-SAR-SIM/SAR-Simulator-FPGA2.rcflow` で実装した RF 物理レイヤー。動機: **絶対信号レベルなしの正規化シミュレーションでは ADC 飽和・underflow を観測できない**。Level 2 で追加した要素:

#### n32 (Reflection Coefficients NUFFT) の追加処理
- **σ°_max スライダ (n52, var=`sigma0_max_db`)**: 散乱体振幅のグローバルゲイン。`sigma0_amp = 10^(sigma0_max_db/20)` を全散乱体に掛ける
  - 画像: `src_re = image_amp × sigma0_amp`（白ピクセル＝σ°_max、黒ピクセル＝0）
  - 点標的: `src_re = sigma0_amp`（全点が σ°_max）
- **1/R² range loss (per-scatterer per-pulse)**: NUFFT 重みに `(R0/R_eta)²` を乗算。`R_eta ≈ R0` なのでスワス内変動は小さい（±10⁻⁴）が、物理的正当性のため。レンジが大きく違うシーン（深い斜視角等）で効く

#### n25 (LNA Level 2, fixed gain) の処理
GUI: NF_dB (n26, renamed from "Noise level"), signal_peak_dBFS (n53)

Step 1 — **固定 LNA ゲイン**（AGC ではない）:
```
sig_peak_target = 10^(signal_peak_dbfs / 20) × ADC_FS_V
K_lna = sig_peak_target / S_RAW_REFERENCE_PEAK   # シーン非依存定数 (S_RAW_REFERENCE_PEAK=1.0)
s_raw *= K_lna
```

**校正の意味**: `signal_peak_dbfs` は「1 点標的 (σ°_max=0 dB, 中心) を入れたときの ADC 受信 peak」という設計値。他のシーンには同じ K_lna が適用されるので:
- 強反射シーン（多数散乱体のコヒーレント和、または σ°_max 増加）→ peak 上昇 → **ADC 飽和の可能性（実機 SAR と同じ）**
- 暗いシーン → peak 低下 → 熱雑音に埋もれる
- 物理的等価性が保たれる: **「画像の1白ピクセル ≡ 1点標的」**

Step 2 — 熱雑音注入（kTBF, Friis 支配段モデル）:
```
F_lin = 10^(nf_db / 10)
thermal_power_W = k × T × B × F_lin   (k=1.38e-23, T=290K, B from n1)
thermal_voltage_V = sqrt(P × R_load)   (R_load=50Ω)
noise_std_FS = thermal_voltage_V / ADC_FS_V
complex AWGN: per-component σ = noise_std_FS / √2
```

参照: `ADC_FS_V = 1.0`（ADC FS = ±1 V at 50Ω = +13 dBm peak）。例: NF=3, B=75 MHz → 熱雑音床 -105.2 dBFS。

**自動診断**: LNA 通過後の実 ADC ピーク (`achieved_peak_dbfs`) と **ADC clip 率 (%)** を per-run で表示。clip > 0% で「signal_peak_dbfs を下げるか σ°_max を下げる」と警告。

**実機シミュレーションとして正しい振る舞い**（旧 AGC モデルからの修正点）:
- σ°_max を上げると ADC ピークも上がる（飽和観測可）
- 多数散乱体の画像は s_raw が sqrt(N)〜N 倍に成長して飽和しうる（実機の Bright scene 問題）
- 「scene による絶対レベル変動」がそのまま ADC で観測される
- 強反射体 (corner reflector 等) には受信ゲイン低減が必要、という運用がそのまま再現される

#### SAR 処理チェイン正規化（n14 range comp, n17 az comp）
旧実装は NumPy の unnormalized FFT で matched filter を作っていたため、点標的の総処理ゲインが +90 dB 近く（非現実的）になっていた。Cumming/Wong 標準の matched filter L2 ノルム正規化を導入:
- **n14 (range)**: `H_range /= sqrt(sum(|ref_chirp|²))` → 範囲圧縮ゲイン = sqrt(Tp·B) ≈ +29 dB
- **n17 (azimuth)**: 既存実装が偶然 sqrt(Na) 相当のゲインを生んでいる（NumPy の 1/N IFFT + LFM 帯域分散の組合せ）ので**変更不要**
- 合計処理ゲイン ≈ sqrt(Tp·B · Na) ≈ +60 dB voltage（実測一致）。教科書値。

検証: 点標的で focused = ADC + 60 dB ≈ -50+60 = +10 dBFS（軽い飽和、displayable）。

#### Level 2 の物理モデル限界（将来拡張）
**距離減衰 vs LNA バランス**: 厳密物理では (1) n32 に絶対 1/R²（R=R0=690 km で voltage -234 dB）、(2) Tx 側 (P_t × G² × λ²/(4π)³) で +200 dB 程度、(3) LNA を真の正のゲイン (10–50 dB) として再定義、が筋。現状は (1)(2)(3) を全部 `K_lna` 一個に押し込んだ「抽象化」モデル。FPGA ビット幅検証目的では問題ないが、絶対 SNR・受信機ノイズ Figure とのバランス検証が必要になったら full link budget モデルへ拡張予定。

#### 標準実験軸（Level 2）
```
[σ°_max_dB] × [signal_peak_dbfs] × [NF_dB] × [Stage A Q-format] × [Stage B/C Q-format]
```
- σ°_max: シーン全体の明るさ。Stage A の BRAM shift 量に影響
- signal_peak_dbfs: ADC のどこに信号ピークが乗るか。-3 dBFS で clip ぎりぎり、-40 dBFS で thermal noise 支配
- NF: 受信機雑音床。-105 dBFS @ NF=3 が典型
- Stage A Q: BRAM/テンプレート精度。10bit 相当 (Q1.9) が ADC 並み、16bit (Q1.15) が現実的 BRAM
- Stage B Q: FPGA datapath 幅。18bit (Q8.10) が Xilinx 7系 DSP に整合

**依存**: `fxpmath>=0.4.9` は `requirements.txt` に残してあるが Route B の current 実装からは import していない（将来 ASIC ライク な特殊 rounding/overflow モードが必要になったら復活させる前提）。

**禁止事項**:
- n32 を「n42 等と統合して旧 n32 形式に戻す」改造をしないこと。3ルート公平比較ができなくなる。
- n32 の `fir_coefficients` に `fftshift`/`ifftshift` を適用しないこと。Route B の `s_raw` が Route A に対して circular shift する（Notebook が時間領域可視化のため fftshift していた経緯と混同しない）。
- Route A/B/C-in を複数同時 Enable して実行しないこと。narrator で `node_completed` の最後勝ちになるが、混乱を招くだけ。

### SARフロー / 3D表示ノードの運用ルール (CRITICAL)

- **フロー実行中に canvas API 操作（connect/update_element/add_element 等）を送らない。** 重い3D表示でレンダラーが負荷下にあるとクラッシュする。実行中は **server-side narrator（read-only HTTP, `/api/narrator/events`）でポーリング**し、`flow_completed` を確認してから編集する。
- **構造変更のたびに `save_tab`。** レンダラークラッシュで未保存分（追加ノード・配線）が失われるため。
- **GUI ブロックの `value` 更新は `update_element` の `params` で行う**: `update_element '{"node_id":"n23","params":{"value":"2"}}'`。`code`/`label`/`enabled` はトップレベル、ブロック/GUIパラメータ(value, var_name, min, max…)は **`params:{...}`**（複数形）。`add_element` は `parameters`、`update_element` は `params` という非対称に注意。誤って `value` をトップレベルや `parameters` で渡すと**エラーで弾かれる**（2026-05-24に修正。以前は黙殺して空成功＝サイレントフォールバックだった）。
- **巨大配列を matplotlib で imshow/表示しない。** 全グリッド(数百万要素)の imshow はレンダラー負荷の原因。3D表示は `surface3d_gl`（GLバイナリ方式、上記）を使う。matplotlib を使うなら表示用に縮小してから。

### FPGA HIL: Amaranth FFT + Verilator pipeline (CRITICAL — 恒久)

`workspace-SAR-SIM/scripts/` に Amaranth radix-2 DIT FFT + Verilator HIL の参照実装あり。詳細は `workspace-SAR-SIM/scripts/README.md`。

**役割分担**:
- **`SAR-Simulator-FPGA3.rcflow` の Route A/B (n42/n43)**: cupy 量子化 (Q-format-accurate, 速い、本番 HIL ループ向け)
- **`FPGA-HIL-Stub.rcflow` の n4 FPGA Compute (cupy)**: 上記と同等、ファイル境界経由
- **`FPGA-HIL-Stub.rcflow` の n6 FPGA Compute (Verilator HIL)** [enabled=false がデフォルト]: Amaranth → Verilog → Verilator → 実 .exe で **bit-exact ゲートレベル**動作。本物 HDL と同じ算術
- **本番 FPGA**: 別途 pipelined streaming FFT (Xilinx FFT IP / dblclockfft 等) を実装。Amaranth コードはその検証用 reference

**性能 (現フロー Nr=5040 → padded 8192、Na=2016)**:
- cupy (n4 既存): ~0.1 秒/フレーム
- Verilator (n6 新規): フルフレーム ~18 秒、bit-exact reference
- 純粋 Amaranth pysim: 6 時間 (使わない、Verilator が 1200× 高速化)

**ツールチェイン (1回セットアップ)**:
```
winget install --id MSYS2.MSYS2
C:\msys64\usr\bin\bash.exe -lc "pacman -S --noconfirm mingw-w64-x86_64-verilator mingw-w64-x86_64-toolchain make"
.venv\Scripts\python.exe -m pip install amaranth amaranth-yosys
```
Windows ネイティブで Verilator を呼ぶには **MSYS2 bash 経由**でないとパス変換が壊れる。`verilator_fft_drive.py` は subprocess を `bash -lc` でラップしてこれを吸収。

**禁止事項**:
- ❌ `workspace-SAR-SIM/scripts/amaranth_seq_fft.py` の Q1.15 / Q(WG).15 / WG=16+log2(N) ビット幅を本番 FPGA 設計と無関係に変えない。Route B の `qz()` Q-format と整合させる
- ❌ シーケンシャル単体バタフライ設計のまま実 FPGA に流さない (PRF=4kHz リアルタイムには pipelined streaming 必須)
- ❌ `fpga_io/` を git に commit しない (中間データのみ、.gitignore 済み)

**🔥 重要**: cupy 経路は Q-format-accurate ながら**ゲート動作と完全一致しない** (cupy は round-half-to-even、HDL は通常 truncate)。実機ビット幅検証では n6 Verilator 経路を真の参照として使うこと。

### Error Handling (CRITICAL)

- **No silent errors** - Every error must display a meaningful message
- **No fallbacks that hide problems** - Fallbacks make debugging difficult. If something fails, report it clearly

### Python (Backend)

- Type hints on function signatures
- Use `pathlib.Path` for file paths
- Use `async/await` with FastAPI
- Python path: `.venv/Scripts/python.exe` (auto-detected by Electron)

### TypeScript/TSX (Frontend)

- ESM modules, Viteでバンドル (TSX → JS)
- `.tsx` ファイルはJSX構文使用、`.ts` ファイルは純TypeScript
- npm packages (react, @xyflow/react, @xterm/*) — bare specifier import

### タブ・サイドバー実装ガイドライン

新しいタブタイプやサイドバーを追加する際は以下のルールに従う:

**タブタイプの追加:**
1. `tabRegistry.ts` で `registerTabType()` + `registerTabComponent()` で登録
2. `uiConfig` で `showToolbar`, `containerClass` を設定
3. 自己登録パターン: タブモジュール内で `registerTabType()` を呼ぶ（mindmap.tsx, notes.tsx 参照）

**サイドバー/サイドパネルの実装:**
- **必ず React コンポーネントとして実装する**（DOM 直接操作禁止）
- body flex レイアウトに参加する場合: **React Portal** を使用（BlockLibrarySidebar.tsx 参照）
- content-area 内のオーバーレイ: `position: absolute` を使用（NotesSidebar.tsx, mindmap-style-panel 参照）
- `index.html` に静的 HTML を書かない — React でレンダリングする

**状態管理:**
- サイドバーの表示/非表示は React state で管理（DOM class toggle 禁止）
- パネルの表示状態は `useTabManager.ts` の `panels` オブジェクトでタブごとに保存・復元

### Frontend Build Workflow (CRITICAL)

- **ソースコード**: `frontend/` を編集
- **ビルド**: `npm run build` で `dist/` に出力（Vite）
- **配信**: FastAPIが `dist/` を配信（`frontend/` は直接配信しない）
- **フロントエンド変更後は必ず `npm run build` を実行すること**
- **反映にはElectron再起動が必要** — Electronはブラウザと違いリロード不可。`start.bat` で再起動するようユーザーに伝えること
- 開発時は `npm run dev` でVite dev server (localhost:5173) + HMR可能
- 起動: `start.bat`（venv activate → Electron起動）

### Testing

- Always run tests after creating or modifying code
- **統合チェック**: `python scripts/check.py --all` で全チェック一発実行
  - `--build`: Vite ビルドエラー検出
  - `--types`: TypeScript 型エラー（ベースライン比較付き）
  - `--pytest`: バックエンド回帰テスト
  - `--lint`: レガシー文字列検出
  - `--runtime`: 実行時JSエラー取得（F12不要、アプリ起動中のみ）
- Backend: pytest (`python -m pytest tests/ -v`)
- Frontend: manual browser testing (describe what to verify)
- CLI: `python .claude/skills/hiyocanvas/scripts/canvas_api.py frontend_status` で接続確認

### 検証の原則

機能テストでは「レスポンスが返った」だけでなく「仕様通り動作した」ことを確認する:

1. **Before/After差分** — 操作前後で状態取得コマンド（get_elements, get_tabs等）を実行し、差分を確認
2. **フィールド単位の正確な検証** — get_elementでlabel, type, code, enabled等を個別に確認。「何かが返った」ではなく「期待値と一致」
3. **ファイルシステム直接確認** — workspaces/フォルダや.rcflowファイルの内容をRead toolで直接確認
4. **スクリーンショットでUI反映確認** — ノード表示、接続線、グレーアウト等の視覚的変化を定性確認
5. **エラーケースは状態不変を確認** — エラー応答だけでなく、操作前後で状態が変わっていないことを確認

### エージェント活用ワークフロー

複雑なタスク（設計、調査、テストケース設計等）はエージェントに委託し、自分がレビュー・統合する:

1. タスクを独立した領域に分割（例: カテゴリ別のテスト設計）
2. 各領域をExplore/Planエージェントに並列で委託
3. エージェントの出力をレビューし、品質・整合性を確認
4. 最終成果物に統合

### テスト結果レポート

テスト実行時は手順ごとの詳細結果を記録する（PASS/FAILだけでなく実際の出力を残す）:
- レポートファイル: `references/test-report-YYYY-MM-DD.md`（test-plan.mdと同じフォルダ）
- 各TCにつき: 実行コマンド、実際の出力、検証ステップごとの結果、判定、備考

## File Operations

- **Creating files**: Proceed without asking
- **Updating existing files**: Proceed without asking
- **Deleting files**: Ask for approval first

## HiyoCanvas制御（Claude Codeから）

### SKILLs

| SKILL | 場所 | 用途 |
|-------|------|------|
| `hiyocanvas` | `.claude/skills/hiyocanvas/` | キャンバス操作API（canvas_api.py経由） |
| `hiyocanvas-bridge` | `.claude/skills/hiyocanvas-bridge/` | アプリ起動/終了/スクリーンショット |

### HiyoCanvas起動/終了

```powershell
# 起動（ゾンビプロセス自動クリーンアップ付き）
.venv\Scripts\python.exe .claude\skills\hiyocanvas-bridge\scripts\ctl.py start

# 状態確認
.venv\Scripts\python.exe .claude\skills\hiyocanvas-bridge\scripts\ctl.py status

# 終了（graceful shutdown — taskkill直接使用禁止）
.venv\Scripts\python.exe .claude\skills\hiyocanvas-bridge\scripts\ctl.py stop

# スクリーンショット（Read toolで画像確認可能）
.venv\Scripts\python.exe .claude\skills\hiyocanvas-bridge\scripts\screenshot.py
```

**注意:**
- VSCodeターミナルでは `ELECTRON_RUN_AS_NODE=1` が設定されるため、`start.bat` は使えない。`ctl.py start` が自動的にunsetする
- 終了は必ず `ctl.py stop`（= `/api/tools/shutdown` POST）を使う。`taskkill` 直接はElectronのgraceful shutdownをバイパスしプロセスが孤立する
- 試験手順書: `.claude/skills/hiyocanvas-bridge/references/test-plan.md`

### ナレーター（動作確認・デバッグ）

HiyoCanvasにはランタイム観測システム（ナレーター）が組み込まれている。コードを追わずにアプリの動作状態を即座に確認できる。**開発・デバッグ時は積極的に活用すること。**

```powershell
# 現在の状態（フロー実行中か、WSが繋がっているか）
Invoke-RestMethod http://127.0.0.1:18731/api/narrator/state | ConvertTo-Json -Depth 3

# 最近のイベント履歴（フロー実行順序・ノード結果の確認）
Invoke-RestMethod "http://127.0.0.1:18731/api/narrator/events?n=20" | ConvertTo-Json -Depth 5

# エラーのみ（失敗ノードの特定）
Invoke-RestMethod http://127.0.0.1:18731/api/narrator/errors | ConvertTo-Json -Depth 5

# テスト前クリア
Invoke-RestMethod -Method Post http://127.0.0.1:18731/api/narrator/clear | Out-Null
```

詳細仕様: `.claude/skills/hiyocanvas/references/narrator.md`
