---
name: hiyocanvas-bridge
description: |
  Start, stop, and monitor HiyoCanvas Electron app from Claude Code.
  Use when: launching HiyoCanvas for testing or development, taking screenshots,
  shutting down after work, or chatting with RINA for testing.
  Triggers: "start HiyoCanvas", "stop HiyoCanvas", "screenshot",
  "HiyoCanvas起動", "HiyoCanvas終了", "スクリーンショット",
  "talk to RINA", "send chat", "RINAと会話",
  or when HiyoCanvas needs to be running for canvas operations.
---

# HiyoCanvas Bridge

Control HiyoCanvas Electron app lifecycle from Claude Code.

```
PYTHON = .venv\Scripts\python.exe
SCRIPTS = ${CLAUDE_SKILL_DIR}/scripts
```

Note: Paths are relative to the project root. `ctl.py` and `screenshot.py` auto-detect the project root from their file location.

## Start

```powershell
$PYTHON $SCRIPTS/ctl.py start
```

Launches Electron + FastAPI + voice-agent. Waits for health check (up to 30s).
Automatically unsets `ELECTRON_RUN_AS_NODE` (required in VSCode terminal).

## Stop

```powershell
$PYTHON $SCRIPTS/ctl.py stop            # refuses if any workspace is dirty
$PYTHON $SCRIPTS/ctl.py stop --force    # discard unsaved changes
```

Sends `POST /api/tools/shutdown` to trigger Electron's graceful shutdown.
All child processes (FastAPI, voice-agent, terminal-server) are cleaned up properly.

### Dirty-guard

`stop` first asks the renderer for the list of workspaces with unsaved
changes (`get_dirty_tabs` WS action). If any are dirty, the server
returns `{"success": false, "dirty_tabs": [{"id","title"}, ...]}` and
`ctl.py` exits non-zero, printing the offending workspace titles. The
server does **not** shut down in that case — there are no dialogs on
this path because it is meant for AI/CLI callers.

Recommended flow:

1. `canvas_api.py get_dirty_tabs` — list workspaces with unsaved
   changes (`{"success": true, "dirty_tabs": [{"id","title"}, ...]}`).
   Empty list → safe to stop.
2. For each dirty workspace, switch to it (`switch_tab`) and
   `canvas_api.py save_tab` (or save in the UI).
3. `ctl.py stop`.

`get_dirty_tabs` is exposed as a regular REST/CLI endpoint, so the
check can be performed without invoking `stop` first. The shutdown
endpoint uses the same backend function internally.

If the frontend is unreachable (no WS client, or the renderer is
hung), the dirty check times out after ~2s and shutdown proceeds — a
warning is logged server-side. The UI close button (× / Cmd+Q) is
unaffected; it still uses the IPC path with `rcConfirmSave` dialogs.

`ctl.py restart` always force-shuts the current instance (restart
implies discarding any in-flight work).

**NEVER use `taskkill` directly** — it bypasses Electron's shutdown and orphans processes.

## Status

```powershell
$PYTHON $SCRIPTS/ctl.py status
```

Prints `running` or `stopped`.

## Restart

```powershell
$PYTHON $SCRIPTS/ctl.py restart
```

## Screenshot

```powershell
$PYTHON $SCRIPTS/screenshot.py [output_path]
```

Captures the full screen. Default output: `<project_root>/tmp_screenshot.png` (auto-detected).
View the result with Claude Code's Read tool (multimodal image support).

## Chat with RINA

Send messages to RINA via the chat UI and read responses. Uses CDP to manipulate the actual chat DOM (textarea + send button), so messages appear in the UI just like real user input.

**Prerequisite:** HiyoCanvas must be running with browser open.

### Send a message

```powershell
# Write message to temp file
# tmp_chat.json: {"text": "Hello RINA!"}
API send_chat '@tmp_chat.json'
```

### Read chat messages

```powershell
API get_chat                       # Last message (default: 1)
API get_chat '{\"count\":5}'        # Last 5 messages
```

Returns `messages` array with `role` (user/assistant) and `content`.

### Typical workflow (debugging RINA)

```powershell
$PYTHON $SCRIPTS/ctl.py start                          # 1. Start HiyoCanvas
API frontend_status                                     # 2. Verify connection
# Write {"text":"Excalidrawに簡単な図を描いて"} to tmp_chat.json
API send_chat '@tmp_chat.json'                            # 3. Send to RINA
# Wait for RINA to finish (10-30s for tool use)
API get_chat '{\"count\":5}'                              # 4. Read response
$PYTHON $SCRIPTS/screenshot.py                          # 5. Visual confirmation
```

**Notes:**
- If send button is disabled, RINA is still streaming — wait and retry
- RINA tool use (drawing, etc.) takes time; poll `get_chat` or take screenshots to check progress
- `send_chat` and `get_chat` are CDP endpoints (not canvas_api tab_action)

## Automated Checks

Run the integrated check script to verify the entire project.
Note: `scripts/check.py` is in the project root (not `$SCRIPTS`).

```powershell
$PYTHON scripts/check.py --all        # All checks (build, types, pytest, lint, runtime)
$PYTHON scripts/check.py --build      # Vite build only
$PYTHON scripts/check.py --runtime    # Runtime JS errors (requires HiyoCanvas running)
```

The `--runtime` check uses `canvas_api.py get_frontend_errors` and `get_console_logs` to detect JS errors without opening F12 DevTools.

## Prerequisites

- `.venv/` with `requests` and `Pillow` installed
- Node.js + npm (for `npx electron`)
