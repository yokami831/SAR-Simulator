# SKILL / AI操作ガイド

本ドキュメントは Claude Code や外部ツールから HiyoCanvas を操作する**使い方ガイド**です。
エンドポイントの詳細（パラメータ、レスポンス形式）は **[api_reference.md](api_reference.md)** を参照。

## Overview

HiyoCanvas は REST API + WebSocket 経由で全操作をプログラムから実行可能。Claude Code、RINA、外部ツールから統一的にアクセスできる。

## アクセスパターン

```
Claude Code / 外部ツール
  ↓ stdin pipe or CLI arg
canvas_api.py <action> [json]
  ↓ HTTP POST
FastAPI Server (127.0.0.1:18731 — デフォルト。シフトする場合あり、`.hiyocanvas-runtime.json` 参照)
  ↓ send_command()
WebSocket → Frontend (React)
  ↓ 処理結果
HTTP Response → stdout
```

## SKILLs

### hiyocanvas (メインスキル)

- **場所**: `.claude/skills/hiyocanvas/`
- **スクリプト**: `scripts/canvas_api.py`
- **用途**: キャンバス操作、ノード/エッジCRUD、実行制御、タブ管理

### hiyocanvas-bridge (ライフサイクル管理)

- **場所**: `.claude/skills/hiyocanvas-bridge/`
- **スクリプト**: `scripts/ctl.py`, `scripts/screenshot.py`
- **用途**: アプリの起動/停止/再起動、スクリーンショット

## canvas_api.py 使い方

```powershell
# 引数で JSON を渡す
python canvas_api.py frontend_status
python canvas_api.py get_tabs

# stdin パイプで JSON を渡す (PowerShell)
'{"type":"python_code"}' | python canvas_api.py add_element

# stdin パイプで JSON を渡す (Bash)
echo '{"type":"python_code"}' | python canvas_api.py add_element
```

## REST API エンドポイント一覧

### ノード操作 (POST /api/tools/...)

| Endpoint | Description |
|----------|-------------|
| add_element | ノード追加 |
| remove_element | ノード削除 |
| get_element | ノード取得 |
| update_element | ノード更新 |
| get_elements | 全ノード取得 |

### エッジ操作

| Endpoint | Description |
|----------|-------------|
| connect | エッジ作成 |
| disconnect | エッジ削除 |

### 実行制御

| Endpoint | Description |
|----------|-------------|
| start_execution | フロー実行開始 |
| stop_execution | 実行停止 |
| get_execution_status | 実行状態取得 |
| get_execution_result | ノード結果取得 |
| step_start | ステップ実行開始 |
| step_next | 次ステップ |
| step_reset | ステップリセット |
| run_remaining | 残り実行 |

### タブ管理

| Endpoint | Description |
|----------|-------------|
| get_tabs | 開いているタブ一覧 |
| open_tab | タブを開く/作成 |
| close_tab | タブを閉じる |
| switch_tab | タブ切替 |
| rename_tab | タブ名変更 |
| get_tab_contents | アクティブタブの内容取得 |

### プラグインタブ操作

| Endpoint | Description |
|----------|-------------|
| tab_action | プラグインタブにアクション送信 |

`tab_action` は `{"action": "...", ...}` を WebSocket 経由でフロントエンドに転送。各タブの `toolActions` で処理。

### ビュー制御

| Endpoint | Description |
|----------|-------------|
| fit_all | ビューポートをフィット |
| fit_node | 特定ノードにフォーカス |
| zoom | ズーム調整 |
| get_viewport | ビューポート情報取得 |
| auto_layout | 自動レイアウト |

### サブグラフ

| Endpoint | Description |
|----------|-------------|
| create_subgraph | サブグラフ作成 |
| set_subgraph | サブグラフ設定 |
| ungroup_subgraph | グループ解除 |

### サーバー管理

| Endpoint | Description |
|----------|-------------|
| frontend_status | フロントエンド接続状態 |
| reload | フロントエンドリロード |
| shutdown | サーバー停止 |
| get_console_logs | コンソールログ取得 |
| get_frontend_errors | JSエラー取得 |
| clear_logs | ログクリア |

### ワークスペース API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/workspaces | 一覧取得 |
| POST | /api/workspaces | 新規作成 |
| GET | /api/workspaces/{filename} | 読み込み |
| PUT | /api/workspaces/{filename} | 保存 |
| DELETE | /api/workspaces/{filename} | 削除 |
| PATCH | /api/workspaces/{filename} | リネーム |

### CDP (Chrome DevTools Protocol)

| Endpoint | Description |
|----------|-------------|
| screenshot | スクリーンショット撮影 |
| send_chat | RINAにチャット送信 |
| get_chat | チャットメッセージ取得 |
| viewport | ビューポート寸法取得 |

## WebSocket 通信

- **URL**: `ws://127.0.0.1:18731/ws/data`（18731 はデフォルト。シフトする場合あり、`.hiyocanvas-runtime.json` 参照）
- **send_command()**: リクエスト送信 → UUID で応答追跡 → タイムアウト15秒
- フロントエンドが処理し、結果を返す

## アプリライフサイクル (hiyocanvas-bridge)

```powershell
# 起動
python .claude\skills\hiyocanvas-bridge\scripts\ctl.py start

# 状態確認
python .claude\skills\hiyocanvas-bridge\scripts\ctl.py status

# 停止 (graceful)
python .claude\skills\hiyocanvas-bridge\scripts\ctl.py stop

# スクリーンショット
python .claude\skills\hiyocanvas-bridge\scripts\screenshot.py
```

**注意**: `taskkill` 直接使用禁止。`ctl.py stop` が `/api/tools/shutdown` を呼び、Electron の graceful shutdown を経由する。
