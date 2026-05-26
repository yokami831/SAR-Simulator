# HiyoCanvas Troubleshooting

## Common Issues

### Port 18731 already in use (Errno 10048)

**Symptom:** Server fails to start with "address already in use" error.

**Cause:** A previous Python process is still running on port 18731.

**Fix:**
```cmd
netstat -ano | findstr :18731
taskkill /pid <PID> /f
```

The Electron main process (`src/main.js`) includes `killPortProcess()` which automatically kills stale processes on startup.

### 503 Service Unavailable

**Symptom:** All API calls return HTTP 503.

**Cause:** No browser/Electron window connected via WebSocket. The frontend is the source of truth for flowgraph state — without it, commands cannot be relayed.

**Fix:** Ensure the Electron window or browser is open at http://127.0.0.1:18731.

### Jupyter kernel fails to start

**Symptom:** `run` returns error about kernel startup.

**Cause:** `ipykernel` not installed in the Python environment.

**Fix:**
```cmd
.venv\Scripts\pip install jupyter_client ipykernel
```

### ELECTRON_RUN_AS_NODE prevents Electron launch

**Symptom:** Running `npx electron .` from VSCode terminal opens nothing or shows unexpected behavior.

**Cause:** VSCode sets `ELECTRON_RUN_AS_NODE=1` which makes Electron run as a Node.js process instead of a desktop app.

**Fix:**
```bash
unset ELECTRON_RUN_AS_NODE && npx electron .
```

Or use `start.bat` which handles this automatically.

### Shutdown error dialog (exit code 15)

**Symptom:** Error dialog "FastAPI server exited unexpectedly (code 15)" on shutdown.

**Cause:** The `/api/tools/shutdown` endpoint sends SIGTERM to uvicorn, which exits with code 15. This was incorrectly treated as an error.

**Status:** Fixed in Phase 1.5. Exit codes 0, 15, and null are now treated as normal shutdown.

### npm run build fails

**Symptom:** Vite build fails with TypeScript errors.

**Fix:** Check for:
1. Missing imports in `.tsx` files
2. Type errors in new code
3. Run `npm install` if dependencies are missing

### WebSocket reconnection loop

**Symptom:** Console shows repeated "Reconnecting (N/10)..." messages.

**Cause:** Backend server is not running or crashed.

**Fix:**
1. Check if uvicorn is running: `netstat -ano | findstr :18731`
2. Check FastAPI logs for errors
3. Restart with `start.bat`

## Server Management

### Start
```cmd
start.bat
```
Or manually:
```cmd
.venv\Scripts\activate
npx electron .
```

### Stop (graceful)
```bash
python scripts/canvas_api.py shutdown
```

### Restart
Stop then start. The `killPortProcess()` in `src/main.js` handles stale process cleanup.

### Check health
```bash
python scripts/canvas_api.py status
curl http://127.0.0.1:18731/api/health
```

### Excalidraw save_tab fails with "No excalidrawData in response"

**Symptom:** `save_tab` on an Excalidraw tab returns `[FAIL] No excalidrawData in response`.

**Status:** Known bug. The frontend does not include `excalidrawData` in the save response for Excalidraw tabs. Workaround: none currently available. The data may still be saved to the file — verify by reopening the tab.
