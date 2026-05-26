# Flow Tab

## Overview

ビジュアルノードエディタ。Pythonコードブロックをノードとして配置し、エッジで実行順序を定義。Jupyter IPython カーネルでフロー実行。

## Registration

- **ID**: `flow`
- **Label**: Flow
- **Icon**: 🔧
- **File Extension**: `.rcflow`
- **Block Library**: あり（左サイドバー）
- **Toolbar**: FlowToolbar (フローティング)

## UI Components

- **Canvas**: @xyflow/react (React Flow) — ノード/エッジ/コントロール/ミニマップ/背景グリッド
- **Block Library**: 左サイドバー、カテゴリ別ブロック一覧、ドラッグ＆ドロップでキャンバスに追加
- **Code Editor**: CodeMirror 6 (PythonEditor.tsx) — シンタックスハイライト、エラー行表示
- **Context Menu**: 右クリックでノード/エッジ/選択/キャンバスメニュー

## Toolbar (FlowToolbar)

フローティング配置（キャンバス上部中央）:

| Button | Action | Shortcut |
|--------|--------|----------|
| ≡ Menu | Save / Save As | Ctrl+S / Ctrl+Shift+S |
| Group | 選択ノードをグループ化 | Ctrl+G |
| Ungroup | グループ解除 | Ctrl+Shift+G |
| Run All | 全ノード実行 | F5 |
| Step | ステップ実行 | F10 |
| Stop/Reset | 停止/リセット | Shift+F5 |
| Auto Layout | 自動レイアウト | — |

### 実行モード

| Mode | Run All | Step | Stop |
|------|---------|------|------|
| idle | ▶ Run All (enabled) | Step (enabled) | Stop (disabled) |
| running | Run All (disabled) | Step (disabled) | ■ Stop (enabled) |
| stepping | Run Remaining (enabled) | Step (enabled) | ↻ Reset (enabled) |

## ノードタイプ

- **canvasNode**: 標準ブロック（python_code, comment 等）
- **subgraph**: グループ化されたノード（折りたたみ/展開可能）

## ブロック定義

JSON ファイルで定義 (`backend/plugins/python_canvas/blocks/`):
- `_builtin/`: 組み込みブロック (python_code, comment)
- `user/`: ユーザー定義ブロック

## 実行エンジン

- **Kernel**: jupyter_client + ipykernel (IPython)
- **Flow Executor**: トポロジカルソートで実行順序を決定、順次実行
- **エッジ**: 実行順序のみ（データパッシングなし）
- **リッチ表示**: matplotlib画像、pandas HTML表、result_value をノード上に表示

## サブグラフ

- 複数ノードを選択 → Group (Ctrl+G) で折りたたみ
- 折りたたみ時: 子ノードは `subgraphStore` に保存、親ノードのみ表示
- 展開時: 子ノードを復元

## コードエディタ (PythonEditor)

CodeMirror 6 ベースの Python エディタ (`components/PythonEditor.tsx`):
- シンタックスハイライト (@codemirror/lang-python)
- 行番号表示
- ブラケットマッチング / 自動閉じ
- エラー行ハイライト（実行エラー時に赤表示）
- Undo/Redo 履歴
- 読み取り専用モード対応
- ダークテーマ（constants.ts の EDITOR_* 変数）

## ノード操作 (useNodeOperations)

- ノード追加: ビューポート中央に自動配置
- ノード削除: エッジも連動削除
- エッジ作成: 重複防止、ポートタイプ検証
- ドラッグ＆ドロップ: サイドバーからキャンバスへ
- 自動レイアウト: トポロジカルソート + レイヤーベース配置
- オーバーラップ解消: ノードリサイズ時に垂直方向の重なりを防止

## Undo/Redo

- スタック方式（undoStack / redoStack）
- ノード/エッジ/サブグラフの変更を記録
- タブ切替時にスタックも保存/復元

## 保存データ

```json
{
  "type": "flow",
  "canvas": {
    "nodes": [...],
    "edges": [...],
    "viewport": { "x": 0, "y": 0, "zoom": 1 }
  },
  "subgraphStore": { ... }
}
```
