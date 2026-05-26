# HiyoCanvas Narrator リファレンス

## 概要

ナレーターはHiyoCanvasの実行時観測システム。AIエージェントがコードを追わずにアプリの動作状態を把握できる。

- リングバッファ500件（古いイベントから自動削除）
- FastAPI経由でHTTPアクセス（アプリ起動中のみ）
- フロー実行、WebSocket接続、JSエラーをリアルタイム記録

---

## APIエンドポイント一覧

ベースURL: `http://127.0.0.1:18731`

| Method | Path | 説明 |
|--------|------|------|
| GET | `/api/narrator/events?n=50` | 最近N件のイベント（新しい順、max 500） |
| GET | `/api/narrator/state` | 現在の状態サマリ |
| GET | `/api/narrator/errors?n=20` | エラーイベントのみ（新しい順） |
| POST | `/api/narrator/clear` | バッファクリア（テスト前に使用） |

---

## stateレスポンス形式

```json
{
  "flow_status": "stopped",
  "ws_connected": true,
  "ws_client_count": 1,
  "last_event": {...},
  "last_error": null,
  "node_statuses": {"n1": "node_completed", "n2": "node_error"},
  "buffer_size": 42
}
```

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `flow_status` | string | `stopped` / `running` / `error` |
| `ws_connected` | bool | WebSocketクライアントが1件以上接続中か |
| `ws_client_count` | int | 現在の接続クライアント数 |
| `last_event` | object \| null | 最後に記録されたイベント |
| `last_error` | object \| null | 最後に記録されたエラーイベント |
| `node_statuses` | object | ノードIDをキーとする最新ステータスのマップ |
| `buffer_size` | int | バッファ内の現在のイベント件数 |

---

## eventsレスポンス形式

```json
{
  "events": [
    {
      "id": "abc123",
      "ts": "2026-04-20T12:34:56.789Z",
      "type": "flow",
      "name": "flow_completed",
      "data": {"total_time": 1.23, "node_count": 2}
    }
  ],
  "count": 1,
  "total_buffered": 6
}
```

---

## イベント型とイベント名

### type フィールドの値

| type | 説明 |
|------|------|
| `flow` | フロー実行ライフサイクル |
| `node` | ノード実行ライフサイクル |
| `websocket` | WebSocket接続状態 |
| `js_error` | フロントエンドJSエラー |

### name フィールドの値

#### Flow系

| name | 説明 | data フィールド |
|------|------|----------------|
| `flow_started` | フロー開始 | `{node_count}` |
| `flow_completed` | フロー完了 | `{total_time, node_count}` |
| `flow_error` | フローエラー | `{total_time, failed_nodes}` または `{error}` |
| `flow_cancelled` | フローキャンセル | `{total_time}` |

#### Node系

| name | 説明 | data フィールド |
|------|------|----------------|
| `node_executing` | ノード実行開始 | `{node_id}` |
| `node_completed` | ノード実行完了 | `{node_id, execution_time}` |
| `node_error` | ノード実行エラー | `{node_id, execution_time, error_summary}` |

#### WebSocket系

| name | 説明 | data フィールド |
|------|------|----------------|
| `ws_connected` | クライアント接続 | `{client_count}` |
| `ws_disconnected` | クライアント切断 | `{client_count}` |

#### JS Error系

| name | 説明 | data フィールド |
|------|------|----------------|
| `js_error` | JSエラー | `{message, source, lineno}` |
| `js_unhandled_rejection` | 未処理Promise拒否 | `{message, source, lineno}` |

---

## 典型的な使用パターン（PowerShellコマンド例）

### 動作確認の基本フロー

```powershell
# 1. テスト前にクリア
Invoke-RestMethod -Method Post http://127.0.0.1:18731/api/narrator/clear

# 2. 現在の状態確認
Invoke-RestMethod http://127.0.0.1:18731/api/narrator/state | ConvertTo-Json -Depth 3

# 3. フロー実行後にイベント確認
Invoke-RestMethod "http://127.0.0.1:18731/api/narrator/events?n=20" | ConvertTo-Json -Depth 5

# 4. エラーのみ確認
Invoke-RestMethod http://127.0.0.1:18731/api/narrator/errors | ConvertTo-Json -Depth 5
```

### フロー実行の確認パターン

```powershell
# フロー実行
'{}' | .venv\Scripts\python.exe .claude\skills\hiyocanvas\scripts\canvas_api.py start_execution
Start-Sleep 10

# 実行順序と結果を確認
Invoke-RestMethod "http://127.0.0.1:18731/api/narrator/events?n=30" | ConvertTo-Json -Depth 5
# 期待: flow_started → node_executing×N → node_completed×N → flow_completed の順

# エラーがあった場合のノード特定
Invoke-RestMethod http://127.0.0.1:18731/api/narrator/errors | ConvertTo-Json -Depth 5
# node_error の data.error_summary でエラー内容確認
```

### 接続状態の確認

```powershell
Invoke-RestMethod http://127.0.0.1:18731/api/narrator/state | ConvertTo-Json
# ws_connected: true かつ ws_client_count >= 1 なら正常
```

---

## いつ使うか

- フロー実行が期待通りに動いているか確認するとき
- エラーが発生したノードを特定するとき
- WebSocket接続が確立しているか確認するとき（503エラー対処）
- 操作後に状態が正しく変わったか確認するとき

---

## 実装ファイル

| ファイル | 役割 |
|---------|------|
| `backend/narrator.py` | リングバッファ・イベント定義・シングルトン |
| `backend/routers/narrator_router.py` | FastAPIルーター（4エンドポイント） |
