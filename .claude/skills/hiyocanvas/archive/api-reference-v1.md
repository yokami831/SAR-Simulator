# HiyoCanvas API Reference

Base URL: `http://127.0.0.1:18731`

## Health & Configuration

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| GET | `/api/health` | — | `{"status": "ok"}` |
| GET | `/api/config` | — | `{"terminal_ws": "ws://...", "cdp_port": 9222}` |
| GET | `/api/blocks` | — | `{"categories": {...}}` — All block definitions |

## Block Operations (`/api/tools/`)

| Method | Path | Required Params | Response |
|--------|------|----------------|----------|
| POST | `/api/tools/add_block` | `type` | `{"node_id": "n1", "block_type": "..."}` |
| POST | `/api/tools/remove_block` | `node_id` | `{"success": true}` |
| POST | `/api/tools/connect` | `source`, `source_port`, `target`, `target_port` | `{"edge_id": "e_..."}` |
| POST | `/api/tools/disconnect` | `edge_id` OR (`source`, `source_port`, `target`, `target_port`) | `{"success": true}` |
| POST | `/api/tools/set_parameter` | `node_id`, `param`, `value` | `{"success": true}` |
| POST | `/api/tools/add_variable` | `name`, `value` | `{"node_id": "n1", "name": "x"}` |
| POST | `/api/tools/register_block` | `id`, `label` + block definition | `{"id": "...", "label": "..."}` |

### Optional params for add_block
- `parameters`: dict of parameter values (e.g., `{"code": "result = 42"}`)
- `position`: `{"x": 100, "y": 200}`

## Block Information (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| GET | `/api/tools/block_info/{node_id}` | path: node_id | Node data with params, position, ports |
| GET | `/api/tools/block_schema/{block_type}` | path: block_type | Block definition (params, inputs, outputs) |
| GET | `/api/tools/search_blocks?q=query` | query: q | `{"blocks": [...]}` |

## Execution (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| POST | `/api/tools/run` | — | `{"success": true, "message": "Flow execution started"}` |
| POST | `/api/tools/stop` | — | `{"success": true, "message": "Flow execution cancelled"}` |
| GET | `/api/tools/status` | — | `{"status": "running"|"stopped", "last_result": {...}, "node_results": {...}}` |
| GET | `/api/tools/result/{node_id}` | path: node_id | `{"success": true, "output": "...", "error": "...", "execution_time": 0.1}` |

### Execution flow
1. `POST /run` starts async execution via Jupyter kernel
2. Poll `GET /status` for completion
3. `GET /result/{node_id}` for individual node results
4. `POST /stop` interrupts running execution

## Tab Operations (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| GET | `/api/tools/tabs` | — | `{"tabs": [{"id", "type", "title", "workspace_folder", "active"}]}` |
| POST | `/api/tools/open_flow_tab` | optional: `title`, `workspace_folder` | `{"tab_id": "...", "title": "...", "workspace_folder": "..."}` |
| POST | `/api/tools/switch_tab` | `tab_id` | `{"success": true, "tab_id": "...", "title": "..."}` |
| POST | `/api/tools/close_tab` | `tab_id` | `{"success": true}` |

## Canvas State (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| GET | `/api/tools/flowgraph` | — | `{"nodes": [...], "edges": [...]}` |
| POST | `/api/tools/clear` | — | `{"success": true}` |
| POST | `/api/tools/auto_layout` | — | `{"success": true}` |
| POST | `/api/tools/batch` | `operations` (list) | `{"results": [...]}` |
| POST | `/api/tools/view` | `action` ("fit_all", "fit_node", "zoom") | `{"success": true}` |

## File I/O (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| POST | `/api/tools/save` | `filepath` | `{"success": true, "filepath": "..."}` |
| POST | `/api/tools/load` | `filepath` | `{"success": true}` |

## Logging (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| GET | `/api/tools/errors` | — | `{"runtime_error": null, "js_errors": [...]}` |
| GET | `/api/tools/logs` | — | `{"logs": [{"timestamp", "level", "message", "details"}]}` |
| POST | `/api/tools/clear_logs` | — | `{"success": true}` |

## Tooltips (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| POST | `/api/tools/tooltip` | `node_id`, `text`, optional: `type`, `highlight`, `tab`, `require_ok` | `{"node_id": "...", "type": "..."}` |
| POST | `/api/tools/hide_tooltip` | `node_id` | `{"success": true}` |
| POST | `/api/tools/clear_tooltips` | — | `{"success": true}` |

## Subgraph (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| POST | `/api/tools/create_subgraph` | `node_ids` (min 2), optional: `label` | `{"subgraph_id": "..."}` |
| POST | `/api/tools/toggle_collapse` | `subgraph_id` | `{"success": true}` |
| POST | `/api/tools/expand_subgraph` | `subgraph_id` | `{"success": true}` |
| POST | `/api/tools/ungroup_subgraph` | `subgraph_id` | `{"success": true}` |
| POST | `/api/tools/rename_subgraph` | `subgraph_id`, `label` | `{"success": true}` |
| POST | `/api/tools/set_subgraph_description` | `subgraph_id`, `description` | `{"success": true}` |

## Workspaces (`/api/workspaces/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| GET | `/api/workspaces` | — | `{"workspaces": [...]}` |
| POST | `/api/workspaces` | `title`, optional: `type`, `folder_name` | `{"folder_name": "...", "title": "..."}` |
| GET | `/api/workspaces/{folder_name}` | path: folder_name | Full workspace data |
| PUT | `/api/workspaces/{folder_name}` | body: workspace data | `{"success": true}` |
| DELETE | `/api/workspaces/{folder_name}` | path: folder_name | `{"success": true}` |
| PATCH | `/api/workspaces/{folder_name}` | `title` | `{"success": true}` |

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

## Server Management (`/api/tools/`)

| Method | Path | Parameters | Response |
|--------|------|-----------|----------|
| POST | `/api/tools/reload` | — | `{"success": true}` |
| POST | `/api/tools/shutdown` | — | `{"success": true}` |

## WebSocket

| Endpoint | Purpose |
|----------|---------|
| WS `/ws/data` | Bidirectional: tool commands, node execution status, console logs |

### WebSocket message types
- `node_execution_status`: `{"type": "...", "node_id": "...", "status": "executing"|"completed"|"error"|"cancelled"}`
- `status_change`: `{"type": "status_change", "status": "running"|"stopped"}`
- `console_log_push`: `{"type": "console_log_push", "level": "...", "message": "..."}`
