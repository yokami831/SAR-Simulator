# HiyoCanvas API Reference

Base URL: `http://127.0.0.1:18731` (preferred default — the port may shift if 18731 is occupied. The actual resolved port is written to `.hiyocanvas-runtime.json` at the project root as `server_port` / `server_url`, and is also returned by `GET /api/health`.)

All `/api/tools/*` endpoints accept POST with JSON body (unless noted as GET).

## Health & Configuration

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| GET | `/api/health` | — | `{"status": "ok", "app": "hiyocanvas", "pid": N, "server_port": N, "cdp_port": N, "version": "0.1.0"}` |
| GET | `/api/config` | — | `{"server_port": N, "cdp_port": N, "features": {...}, "voice_ws": "ws://..."}` — `voice_ws` only present when RINA feature enabled |
| GET | `/api/blocks` | — | `{"categories": {...}}` — All block definitions |

## Element Operations (`/api/tools/`)

| Method | Path | Required Params | Optional Params | Response |
|--------|------|----------------|-----------------|----------|
| POST | `/api/tools/add_element` | `type` | `parameters`, `position` | `{"node_id": "n1", ...}` |
| POST | `/api/tools/remove_element` | `node_id` | — | `{"success": true}` |
| POST | `/api/tools/update_element` | `node_id` | `label`, `code`, `enabled`, `position`, `width`, `height`, etc. | `{"success": true}` |
| POST | `/api/tools/get_element` | `node_id` | — | Node data (label, type, code, position, ports, etc.) |
| POST | `/api/tools/get_elements` | — | `query` | `{"nodes": [...]}` |

### add_element details
- `type`: Block type ID (e.g., `"python_code"`)
- `parameters`: dict of parameter values (e.g., `{"code": "result = 42"}`)
- `position`: `{"x": 100, "y": 200}`

### update_element details
- `node_id` is required; all other fields are optional kwargs
- Supports: `label`, `code`, `enabled`, `position`, `width`, `height`, and any parameter key

## Edge Operations (`/api/tools/`)

| Method | Path | Required Params | Response |
|--------|------|----------------|----------|
| POST | `/api/tools/connect` | `source`, `source_port`, `target`, `target_port` | `{"edge_id": "e_..."}` |
| POST | `/api/tools/disconnect` | `edge_id` OR (`source`, `source_port`, `target`, `target_port`) | `{"success": true}` |

## Canvas State (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| POST | `/api/tools/get_tab_contents` | optional: `max_chars` | Active tab type + contents (auto-detects tab type) |
| POST | `/api/tools/clear_canvas` | — | `{"success": true}` |
| POST | `/api/tools/auto_layout` | — | `{"success": true}` |
| POST | `/api/tools/batch` | `operations` (list) | `{"results": [...]}` |

## View Control (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| POST | `/api/tools/fit_all` | — | `{"success": true}` |
| POST | `/api/tools/fit_node` | `node_id` | `{"success": true}` |
| POST | `/api/tools/zoom` | `level` | `{"success": true}` |
| POST | `/api/tools/get_viewport` | — | `{"x": N, "y": N, "zoom": N, ...}` |
| POST | `/api/tools/screenshot` | optional: `mode`, `node_id` | `{"filepath": "...", ...}` |

## Block Registry (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| POST | `/api/tools/register_block` | block definition (id, label, category, etc.) | `{"success": true, "block": {...}}` |
| POST | `/api/tools/get_block_schema` | `type_id` | Block definition (params, inputs, outputs) |
| GET | `/api/tools/block_schema/{block_type}` | path: block_type | Block definition (legacy GET form) |
| POST | `/api/tools/search_block_types` | `query` | `{"blocks": [...]}` |

## Execution (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| POST | `/api/tools/start_execution` | — | `{"success": true, "message": "Flow execution started"}` |
| POST | `/api/tools/stop_execution` | — | `{"success": true, "message": "Flow execution cancelled"}` |
| POST | `/api/tools/get_execution_status` | — | Execution status |
| POST | `/api/tools/get_execution_result` | `node_id`, optional: `max_lines` | Node execution result |
| POST | `/api/tools/step_start` | — | `{"success": true, "message": "Step execution started", "total_steps": N}` |
| POST | `/api/tools/step_next` | — | `{"success": true, "message": "Step executed: node_id"}` |
| POST | `/api/tools/step_reset` | — | `{"success": true, "message": "Step execution reset"}` |
| POST | `/api/tools/run_remaining` | — | `{"success": true, "message": "Running remaining N steps"}` |

### Execution flow
1. `POST /start_execution` starts async execution via Jupyter kernel
2. Poll `POST /get_execution_status` for completion
3. `POST /get_execution_result` for individual node results
4. `POST /stop_execution` interrupts running execution

### Step execution flow
1. `POST /step_start` — prepares kernel, computes topological order
2. `POST /step_next` — executes next block (repeat as needed)
3. `POST /run_remaining` — runs all remaining blocks at once (optional)
4. `POST /step_reset` — cancels stepping, returns to idle

## Workspace / Tab Operations (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| POST | `/api/tools/get_tabs` | — | `{"workspaces": [...]}` — List open tabs |
| POST | `/api/tools/open_tab` | optional: `title`, `filename`, `type` | `{"tab_id": "...", "title": "..."}` |
| POST | `/api/tools/switch_tab` | `tab_id` | `{"success": true}` |
| POST | `/api/tools/close_tab` | `tab_id` | `{"success": true}` |
| POST | `/api/tools/list_saved` | — | `{"workspaces": [...]}` — List saved workspace files |
| POST | `/api/tools/delete_tab` | `filename` | `{"success": true}` |
| POST | `/api/tools/rename_tab` | `filename`, `new_title` | `{"success": true}` |

## File I/O (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| POST | `/api/tools/save_tab` | *(none)* | `{"success": true, "message": "Saved: ..."}` |
| POST | `/api/tools/save_tab_as` | `new_title`, `description?` | `{"success": true, "filename": "...", "title": "..."}` |
| POST | `/api/tools/load_tab` | `filepath` | `{"success": true}` |

## Subgraph (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| POST | `/api/tools/create_subgraph` | `node_ids` (min 2), optional: `label` | `{"subgraph_id": "..."}` |
| POST | `/api/tools/set_subgraph` | `subgraph_id`, optional: `label`, `description`, `collapsed` | `{"success": true}` |
| POST | `/api/tools/ungroup_subgraph` | `subgraph_id` | `{"success": true}` |

## Tooltips (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| POST | `/api/tools/tooltip` | `node_id`, `text`, optional: `type` | `{"node_id": "...", "type": "..."}` |
| POST | `/api/tools/hide_tooltip` | `node_id` | `{"success": true}` |
| POST | `/api/tools/clear_tooltips` | — | `{"success": true}` |

## Mindmap (`/api/tools/tab_action`)

| Method | Path | Action | Parameters | Response |
|--------|------|--------|-----------|----------|
| POST | `/api/tools/tab_action` | `get_elements` | — | Mindmap data |
| POST | `/api/tools/tab_action` | `get_element` | `elementId` | Node details |
| POST | `/api/tools/tab_action` | `add_element` | `parentId`, `topic` | `{elementId}` |
| POST | `/api/tools/tab_action` | `remove_element` | `elementId` | `{success}` |
| POST | `/api/tools/tab_action` | `update_element` | `elementId`, `topic` | `{success}` |
| POST | `/api/tools/tab_action` | `set_data` | `mindmapData` | `{success}` |

## Logging (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| POST | `/api/tools/get_frontend_errors` | — | `{"runtime_error": null, "js_errors": [...]}` |
| POST | `/api/tools/get_console_logs` | optional: `limit` | `{"logs": [...]}` |
| POST | `/api/tools/clear_logs` | — | `{"success": true}` |

## Server Management (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| POST | `/api/tools/frontend_status` | — | Server status info |
| POST | `/api/tools/reload` | — | `{"success": true}` |
| POST | `/api/tools/shutdown` | — | `{"success": true}` |

## Workspaces REST API (`/api/workspaces/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| GET | `/api/workspaces` | — | `{"workspaces": [...]}` |
| POST | `/api/workspaces` | `title`, optional: `type` | `{"filename": "...", "title": "..."}` |
| GET | `/api/workspaces/{filename}` | path: filename | Full workspace data |
| PUT | `/api/workspaces/{filename}` | body: workspace data | `{"success": true}` |
| DELETE | `/api/workspaces/{filename}` | path: filename | `{"success": true}` |
| PATCH | `/api/workspaces/{filename}` | `title` | `{"success": true, "filename": "..."}` |

## Workspaces Directory (`/api/workspaces-dir`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| GET | `/api/workspaces-dir` | — | `{"path": "D:\\...\\workspaces"}` |
| PUT | `/api/workspaces-dir` | `path` | `{"success": true, "path": "..."}` |

フォルダ変更時は全タブを閉じてから実行すること。変更は`app-config.json`（プロジェクトルート）に永続化され、次回起動時に自動復元される。

## CDP - Chrome DevTools Protocol (`/api/cdp/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| GET | `/api/cdp/status` | — | `{"connected": true, "debug_port": 9222}` |
| POST | `/api/cdp/screenshot` | `mode` ("full", "node", "region") | `{"filepath": "...", "width": N, "height": N}` |
| POST | `/api/cdp/view` | `action` ("fit_all", "fit_node", "zoom", "center") | `{"success": true}` |
| GET | `/api/cdp/viewport` | — | `{"x": N, "y": N, "zoom": N, ...}` |

### Screenshot modes
- `full`: Capture entire page
- `node`: Capture specific node (`node_id` required, optional `padding`)
- `region`: Capture region (`x`, `y`, `width`, `height` required)

## WebSocket

| Endpoint | Purpose |
|----------|---------|
| WS `/ws/data` | Bidirectional: tool commands, node execution status, console logs |

### WebSocket message types
- `node_execution_status`: `{"type": "...", "node_id": "...", "status": "executing"|"completed"|"error"|"cancelled"}`
- `status_change`: `{"type": "status_change", "status": "running"|"stopped"|"stepping"}`
- `step_ready`: `{"type": "step_ready", "next_node_id": "...", "step_index": N, "total_steps": N, "step_order": [...]}`
- `console_log_push`: `{"type": "console_log_push", "level": "...", "message": "..."}`

## Narrator / App State (`/api/narrator/`)

ランタイム観測システム。コードを追わずにアプリの動作状態（フロー実行順序、ノード結果、エラー）を即座に確認できる。read-only HTTP のため、フロー実行中も安全にポーリングできる。

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| GET | `/api/narrator/events` | `n` (1-500, default 50) | `{"events": [...], "count": N, "total_buffered": N}` |
| GET | `/api/narrator/state` | — | 現在のナレーター状態（実行中か、WS接続状況など） |
| GET | `/api/narrator/errors` | `n` (1-100, default 20) | `{"errors": [...], "count": N}` |
| POST | `/api/narrator/clear` | — | `{"success": true, "message": "..."}` |

フロー実行中は canvas API 操作を送らず、`/api/narrator/events` で `flow_completed` を確認してから編集すること（重い3D表示中のレンダラークラッシュ回避）。
