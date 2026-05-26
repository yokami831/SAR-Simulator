/**
 * electron/main.js - HiyoCanvas Electron main process
 *
 * Manages:
 * - FastAPI backend server (child process)
 * - Voice agent (child process)
 * - BrowserWindow pointing to localhost:18731
 * - Graceful shutdown on quit
 */

const { app, BrowserWindow, dialog, net, Menu, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const nodeNet = require('net');  // Node net (for free-port probing) — distinct from Electron `net`

// ---------------------------------------------------------------------------
// Configuration (ports resolved dynamically at startup — see startup IIFE)
// ---------------------------------------------------------------------------

const PREFERRED_SERVER_PORT = 18731;
const PREFERRED_VOICE_PORT = 18733;
const PREFERRED_CDP_PORT = 9222;

// Resolved at startup by findFreePort(); start at preferred values as a hint.
let SERVER_PORT = PREFERRED_SERVER_PORT;
let VOICE_AGENT_PORT = PREFERRED_VOICE_PORT;
let CDP_PORT = PREFERRED_CDP_PORT;
let serverUrl = `http://127.0.0.1:${SERVER_PORT}`;  // recomputed after SERVER_PORT resolves

const PROJECT_DIR = path.resolve(__dirname, '..');
const RUNTIME_FILE = path.join(PROJECT_DIR, '.hiyocanvas-runtime.json');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow = null;
let fastapiProcess = null;
let voiceAgentProcess = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Python detection
// ---------------------------------------------------------------------------

function getPythonPath() {
  // Use .venv if it exists
  const venvPython = path.join(PROJECT_DIR, '.venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venvPython)) return venvPython;
  // Fallback to system python
  return 'python';
}

function getFeatureFlags() {
  const configPath = path.join(PROJECT_DIR, 'app-config.json');
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return config.features || {};
    }
  } catch {
    // Config missing or invalid — use defaults
  }
  return {};
}

// ---------------------------------------------------------------------------
// Dynamic port discovery
// ---------------------------------------------------------------------------

/**
 * Return the first bindable port starting at `preferred`, shifting up by 1
 * each time a port is taken. Mirrors backend/config.py find_free_port().
 */
function findFreePort(preferred, maxTries = 50) {
  return new Promise((resolve, reject) => {
    const tryPort = (port, triesLeft) => {
      if (triesLeft <= 0) {
        reject(new Error(`No free port found starting at ${preferred}`));
        return;
      }
      const server = nodeNet.createServer();
      server.once('error', () => {
        // Port taken (or otherwise unbindable) — try the next one.
        tryPort(port + 1, triesLeft - 1);
      });
      server.once('listening', () => {
        server.close(() => resolve(port));
      });
      server.listen(port, '127.0.0.1');
    };
    tryPort(preferred, maxTries);
  });
}

// ---------------------------------------------------------------------------
// Child process management
// ---------------------------------------------------------------------------

function startFastAPI(pythonPath) {
  // Remove Electron-specific env vars that interfere with spawning nested
  // Node.js processes, and inject the resolved ports so the backend (and any
  // child it spawns) learns the shifted values.
  const { ELECTRON_RUN_AS_NODE, ELECTRON_NO_ASAR, ...cleanEnv } = process.env;
  const env = {
    ...cleanEnv,
    HIYOCANVAS_SERVER_PORT: String(SERVER_PORT),
    HIYOCANVAS_CDP_PORT: String(CDP_PORT),
    HIYOCANVAS_VOICE_PORT: VOICE_AGENT_PORT !== undefined ? String(VOICE_AGENT_PORT) : '',
  };

  fastapiProcess = spawn(pythonPath, [
    '-m', 'uvicorn', 'backend.server:app',
    '--host', '127.0.0.1',
    '--port', String(SERVER_PORT),
    '--log-level', 'info',
  ], {
    cwd: PROJECT_DIR,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  fastapiProcess.stdout.on('data', (data) => {
    process.stdout.write(`[FastAPI] ${data}`);
  });
  fastapiProcess.stderr.on('data', (data) => {
    process.stderr.write(`[FastAPI] ${data}`);
  });
  fastapiProcess.on('exit', (code) => {
    console.log(`[FastAPI] exited with code ${code}`);
    fastapiProcess = null;
    if (!isQuitting) {
      // code 0 or SIGTERM(15) from shutdown API is intentional
      if (code !== 0 && code !== 15 && code !== null) {
        dialog.showErrorBox('Server Error', `FastAPI server exited unexpectedly (code ${code}).`);
      }
      isQuitting = true;
      app.quit();
    }
  });
}

function startVoiceAgent(pythonPath) {
  const agentScript = path.join(PROJECT_DIR, 'voice-agent', 'agent.py');
  if (!fs.existsSync(agentScript)) {
    console.log('[VoiceAgent] agent.py not found, skipping.');
    return;
  }

  // Remove Electron-specific env vars that interfere with spawning
  // nested Node.js processes (e.g. claude CLI via npm .CMD wrapper)
  const { ELECTRON_RUN_AS_NODE, ELECTRON_NO_ASAR, ...cleanEnv } = process.env;
  const env = {
    ...cleanEnv,
    VOICE_AGENT_PORT: String(VOICE_AGENT_PORT),
    HIYOCANVAS_VOICE_PORT: String(VOICE_AGENT_PORT),
  };

  voiceAgentProcess = spawn(pythonPath, [agentScript], {
    cwd: PROJECT_DIR,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  voiceAgentProcess.stdout.on('data', (data) => {
    process.stdout.write(`[VoiceAgent] ${data}`);
  });
  voiceAgentProcess.stderr.on('data', (data) => {
    process.stderr.write(`[VoiceAgent] ${data}`);
  });
  voiceAgentProcess.on('exit', (code) => {
    console.log(`[VoiceAgent] exited with code ${code}`);
    voiceAgentProcess = null;
  });
}

// ---------------------------------------------------------------------------
// Health check - wait for FastAPI to be ready
// ---------------------------------------------------------------------------

async function waitForServer(maxRetries = 30) {
  const healthUrl = `http://127.0.0.1:${SERVER_PORT}/api/health`;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await net.fetch(healthUrl);
      if (resp.ok) {
        // Verify we reached *our* HiyoCanvas on the *resolved* port — not some
        // foreign process that happens to answer /api/health.
        const body = await resp.json();
        if (body && body.app === 'hiyocanvas' && body.server_port === SERVER_PORT) {
          return true;
        }
      }
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  // Minimal menu with Edit shortcuts (Copy/Paste/Cut/SelectAll)
  // Without this, Ctrl+C/V/X don't work in Electron
  const template = [
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'HiyoCanvas',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: true,
    },
  });

  // Clear all caches to prevent stale JS/CSS after rebuilds
  const ses = mainWindow.webContents.session;
  ses.clearCache();
  ses.clearCodeCaches({});
  ses.clearStorageData({ storages: ['cachestorage', 'serviceworkers'] });
  ses.setSpellCheckerLanguages(['en-US']);

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadURL(serverUrl);
  }

  // Open external links in default browser (not inside Electron).
  // Exception: blank popups (window.open('') / 'about:blank') are allowed so
  // node rich-display content (e.g. plotly 3D "Expand") can write a large
  // standalone view into a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === '' || url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1100,
          height: 800,
          webPreferences: { contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Open DevTools with F12
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  // -----------------------------------------------------------------------
  // Renderer crash diagnostics. The renderer (React app) can die as a whole
  // process (OOM, GPU crash, native fault) BEFORE any JS error handler runs,
  // so window.onerror / get_frontend_errors never see it — the only symptom is
  // a blank white window and a dropped WebSocket. These main-process handlers
  // capture WHY: they append a timestamped line (reason, exitCode, the URL the
  // renderer was on, and recent renderer console errors) to a crash log so the
  // failure can be investigated after the fact. Log file:
  //   <project>/logs/renderer-crash.log
  const crashLogDir = path.join(__dirname, '..', 'logs');
  const crashLogFile = path.join(crashLogDir, 'renderer-crash.log');
  const crashLog = (tag, detail) => {
    try {
      if (!fs.existsSync(crashLogDir)) fs.mkdirSync(crashLogDir, { recursive: true });
      const url = (() => { try { return mainWindow?.webContents?.getURL() || '?'; } catch { return '?'; } })();
      const line = `${new Date().toISOString()}  [${tag}]  url=${url}  ${JSON.stringify(detail)}\n`;
      fs.appendFileSync(crashLogFile, line);
      console.error('[crash-diag]', line.trim());
    } catch (e) {
      console.error('[crash-diag] failed to write crash log:', e);
    }
  };

  // Ring buffer of the most recent renderer console messages (esp. errors), so
  // when the process dies we can see what it was complaining about just before.
  const consoleRing = [];
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    // level: 0=verbose 1=info 2=warning 3=error
    if (level >= 2) {
      consoleRing.push(`L${level} ${message} (${sourceId}:${line})`);
      if (consoleRing.length > 40) consoleRing.shift();
    }
  });

  // Per-process memory sampler. The white-screen crash is reported as
  // reason="oom", but the machine has 64 GB free — so the real question is
  // whether it's the RENDERER's V8 heap / process working set hitting a
  // per-process ceiling, or the GPU process, not system RAM. app.getAppMetrics()
  // gives each Electron child process's workingSetSize (KB). We sample it on a
  // timer into a ring buffer AND ask the renderer for V8 heap + WebGL context
  // count, then dump the latest samples into the crash log so the failure mode
  // can be read directly. heap/webgl come from the preload bridge (see
  // preload.js 'mem-stats'); if that channel isn't wired they're omitted.
  const memRing = [];
  let lastRendererStats = null;
  ipcMain.on('renderer-mem-stats', (_e, stats) => { lastRendererStats = stats; });
  const sampleMem = () => {
    try {
      const metrics = app.getAppMetrics();
      const byType = {};
      for (const m of metrics) {
        const t = m.type + (m.serviceName ? `:${m.serviceName}` : '');
        byType[t] = Math.round((m.memory?.workingSetSize || 0) / 1024); // MB
      }
      const sample = { t: new Date().toISOString(), procMB: byType, renderer: lastRendererStats };
      memRing.push(sample);
      if (memRing.length > 30) memRing.shift();
    } catch (e) { /* ignore sampling errors */ }
  };
  const memTimer = setInterval(sampleMem, 5000);
  sampleMem();
  mainWindow.on('closed', () => clearInterval(memTimer));

  // The renderer process is gone (crashed / killed / OOM / GPU fault).
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    crashLog('render-process-gone', {
      reason: details.reason,        // 'crashed' | 'oom' | 'killed' | 'launch-failed' | ...
      exitCode: details.exitCode,
      memSamples: memRing.slice(-6),  // last ~30s of per-process MB + renderer heap/webgl
      recentConsole: consoleRing.slice(-15),
    });
  });

  // The renderer stopped responding (hang / heavy synchronous work) and recovered.
  mainWindow.on('unresponsive', () => crashLog('unresponsive', { recentConsole: consoleRing.slice(-15) }));
  mainWindow.on('responsive', () => crashLog('responsive', {}));

  // Page load failures (e.g. dev server / static server not up).
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    crashLog('did-fail-load', { errorCode, errorDescription, validatedURL });
  });

  // Right-click context menu (Copy/Paste/Cut)
  mainWindow.webContents.on('context-menu', (event, params) => {
    const contextMenu = Menu.buildFromTemplate([
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll' },
    ]);
    contextMenu.popup();
  });

  // Unsaved changes check: ask React to handle dirty tabs before closing
  let closeConfirmed = false;
  mainWindow.on('close', (e) => {
    if (closeConfirmed || isQuitting) return;
    e.preventDefault();
    mainWindow.webContents.send('window-close-requested');
  });

  ipcMain.on('close-confirmed', () => {
    closeConfirmed = true;
    if (mainWindow) mainWindow.close();
  });

  ipcMain.handle('show-open-dialog', async (event, options) => {
    return await dialog.showOpenDialog(mainWindow, options || {});
  });

  // -----------------------------------------------------------------------
  // File system IPC handlers (for Files tab)
  // -----------------------------------------------------------------------

  /** Prevent path traversal: ensure targetPath is within rootDir */
  function isWithinRoot(rootDir, targetPath) {
    const resolved = path.resolve(targetPath);
    const root = path.resolve(rootDir);
    return resolved === root || resolved.startsWith(root + path.sep);
  }

  ipcMain.handle('fs-list-dir', async (event, dirPath, rootPath) => {
    if (!isWithinRoot(rootPath, dirPath)) {
      return { error: 'Access denied: path outside root folder' };
    }
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      const items = [];
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        try {
          const stat = await fs.promises.stat(fullPath);
          items.push({
            id: fullPath,
            name: entry.name,
            size: entry.isDirectory() ? 0 : stat.size,
            date: stat.mtime.toISOString(),
            type: entry.isDirectory() ? 'folder' : 'file',
            lazy: entry.isDirectory(),
          });
        } catch {
          // Skip files we can't stat (permission issues, broken symlinks)
        }
      }
      return { items };
    } catch (err) {
      return { error: `Failed to read directory: ${err.message}` };
    }
  });

  ipcMain.handle('fs-create-folder', async (event, parentPath, name, rootPath) => {
    const target = path.join(parentPath, name);
    if (!isWithinRoot(rootPath, target)) {
      return { error: 'Access denied: path outside root folder' };
    }
    try {
      await fs.promises.mkdir(target, { recursive: false });
      return { success: true, path: target };
    } catch (err) {
      return { error: `Failed to create folder: ${err.message}` };
    }
  });

  ipcMain.handle('fs-rename-item', async (event, oldPath, newName, rootPath) => {
    const dir = path.dirname(oldPath);
    const newPath = path.join(dir, newName);
    if (!isWithinRoot(rootPath, oldPath) || !isWithinRoot(rootPath, newPath)) {
      return { error: 'Access denied: path outside root folder' };
    }
    try {
      await fs.promises.rename(oldPath, newPath);
      return { success: true, oldPath, newPath };
    } catch (err) {
      return { error: `Failed to rename: ${err.message}` };
    }
  });

  ipcMain.handle('fs-copy-items', async (event, srcPaths, destDir, rootPath) => {
    for (const src of srcPaths) {
      if (!isWithinRoot(rootPath, src)) return { error: 'Access denied: source outside root' };
    }
    if (!isWithinRoot(rootPath, destDir)) return { error: 'Access denied: destination outside root' };
    try {
      for (const src of srcPaths) {
        const dest = path.join(destDir, path.basename(src));
        await fs.promises.cp(src, dest, { recursive: true });
      }
      return { success: true };
    } catch (err) {
      return { error: `Failed to copy: ${err.message}` };
    }
  });

  ipcMain.handle('fs-move-items', async (event, srcPaths, destDir, rootPath) => {
    for (const src of srcPaths) {
      if (!isWithinRoot(rootPath, src)) return { error: 'Access denied: source outside root' };
    }
    if (!isWithinRoot(rootPath, destDir)) return { error: 'Access denied: destination outside root' };
    try {
      for (const src of srcPaths) {
        const dest = path.join(destDir, path.basename(src));
        await fs.promises.rename(src, dest);
      }
      return { success: true };
    } catch (err) {
      return { error: `Failed to move: ${err.message}` };
    }
  });

  ipcMain.handle('fs-trash-items', async (event, filePaths, rootPath) => {
    for (const fp of filePaths) {
      if (!isWithinRoot(rootPath, fp)) return { error: 'Access denied: path outside root' };
    }
    try {
      for (const fp of filePaths) {
        await shell.trashItem(fp);
      }
      return { success: true };
    } catch (err) {
      return { error: `Failed to delete: ${err.message}` };
    }
  });

  ipcMain.handle('fs-open-file', async (event, filePath) => {
    try {
      const errStr = await shell.openPath(filePath);
      if (errStr) return { error: errStr };
      return { success: true };
    } catch (err) {
      return { error: `Failed to open file: ${err.message}` };
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

async function gracefulShutdown() {
  if (isQuitting) return;
  isQuitting = true;

  // 0. Remove the runtime discovery file so external consumers stop targeting us.
  try {
    if (fs.existsSync(RUNTIME_FILE)) fs.unlinkSync(RUNTIME_FILE);
  } catch {
    // Best effort — ignore
  }

  // 1. Tell FastAPI to shut down gracefully
  try {
    await net.fetch(`${serverUrl}/api/tools/shutdown`, { method: 'POST' });
  } catch {
    // Server may already be down
  }

  // 2. Kill voice agent (Windows: taskkill needed for tree kill)
  if (voiceAgentProcess && voiceAgentProcess.pid) {
    try {
      spawn('taskkill', ['/pid', String(voiceAgentProcess.pid), '/f', '/t']);
    } catch {
      // Already dead
    }
  }

  // 3. Force-kill FastAPI if still alive after 2s
  setTimeout(() => {
    if (fastapiProcess && fastapiProcess.pid) {
      try {
        spawn('taskkill', ['/pid', String(fastapiProcess.pid), '/f', '/t']);
      } catch {}
    }
    app.exit(0);
  }, 2000);
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

/** Kill any process listening on the given port (Windows) */
function killPortProcess(port) {
  return new Promise((resolve) => {
    const { execSync } = require('child_process');
    try {
      const output = execSync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
        { encoding: 'utf8', timeout: 5000 }
      );
      const pids = new Set();
      for (const line of output.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[parts.length - 1], 10);
        if (pid && pid !== process.pid) pids.add(pid);
      }
      for (const pid of pids) {
        console.log(`[Main] Killing stale process on port ${port}: PID ${pid}`);
        try { execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 }); } catch {}
      }
    } catch {
      // No process on port — good
    }
    // Wait a moment for socket to release
    setTimeout(resolve, 500);
  });
}

/**
 * If a previous HiyoCanvas instance is still answering on the legacy port,
 * ask it to shut down gracefully (we shift our own ports rather than
 * blind-killing foreign holders of 18731).
 */
async function shutdownStaleHiyoCanvas() {
  const legacyHealth = `http://127.0.0.1:${PREFERRED_SERVER_PORT}/api/health`;
  try {
    const resp = await net.fetch(legacyHealth);
    if (!resp.ok) return;
    const body = await resp.json();
    if (body && body.app === 'hiyocanvas') {
      console.log('[Main] Found stale HiyoCanvas on legacy port — requesting shutdown.');
      try {
        await net.fetch(`http://127.0.0.1:${PREFERRED_SERVER_PORT}/api/tools/shutdown`, { method: 'POST' });
      } catch {
        // It may exit before responding
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch {
    // Nothing answering — nothing to do
  }
}

// Single instance lock — prevent multiple Electron windows.
// MUST be the first synchronous code so a second launch bails immediately.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  dialog.showErrorBox('HiyoCanvas', 'HiyoCanvas is already running.\nClose the existing window first.');
  process.exit(0);
}

// Startup orchestration: resolve free ports, then start backend + window.
(async () => {
  // (a2) NOTE on renderer OOM (white-screen crash, render-process-gone
  // reason="oom"): the renderer's V8 old-space is HARD-CAPPED at ~4 GB by
  // pointer compression (enabled since Electron 14) and CANNOT be raised —
  // `--max-old-space-size` / `--js-flags` have no effect on the renderer heap
  // (verified: jsHeapSizeLimit stays 4096 MB regardless). So the fix is to
  // REDUCE renderer memory, not raise the ceiling: data-heavy nodes (many
  // Three.js surface3d iframes, each a WebGL context + large vertex payload)
  // are what exhaust it. Mitigations live in the flow's Plot Library node
  // (single-renderer Full/Crop toggle, max-pool vertex downsample) and in
  // disabling intermediate 3D plots. The crash diagnostics below
  // (render-process-gone + memSamples in logs/renderer-crash.log) are what
  // pinned this down; keep them.

  // (b) Resolve CDP port BEFORE app is ready (appendSwitch must run pre-ready).
  CDP_PORT = await findFreePort(PREFERRED_CDP_PORT);
  // (c) Enable CDP debug port for cdp.py screenshot compatibility.
  app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));

  // (d) Wait for Electron to be ready.
  await app.whenReady();

  // (e) Resolve Python + feature flags.
  const pythonPath = getPythonPath();
  console.log(`[Main] Python: ${pythonPath}`);
  const features = getFeatureFlags();

  // (f) If a previous HiyoCanvas is still on the legacy port, shut it down.
  await shutdownStaleHiyoCanvas();

  // (g) Resolve server + (optionally) voice ports, shifting up if taken.
  SERVER_PORT = await findFreePort(PREFERRED_SERVER_PORT);
  serverUrl = `http://127.0.0.1:${SERVER_PORT}`;
  if (features.rina) {
    VOICE_AGENT_PORT = await findFreePort(PREFERRED_VOICE_PORT);
  }
  console.log(`[Main] Ports — server:${SERVER_PORT} cdp:${CDP_PORT} voice:${features.rina ? VOICE_AGENT_PORT : '(disabled)'}`);

  // (h) Start FastAPI backend.
  startFastAPI(pythonPath);

  // (i) Wait for FastAPI — verify it is *our* HiyoCanvas on the resolved port.
  console.log('[Main] Waiting for FastAPI server...');
  const ready = await waitForServer();
  if (!ready) {
    dialog.showErrorBox(
      'Startup Error',
      'FastAPI server failed to start within 15 seconds.\n\n' +
      'Check the console output for errors.'
    );
    await gracefulShutdown();
    return;
  }
  console.log('[Main] FastAPI server is ready.');

  // (j) Write the runtime discovery file (server is health-verified).
  try {
    fs.writeFileSync(RUNTIME_FILE, JSON.stringify({
      app: 'hiyocanvas',
      pid: process.pid,
      started: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      server_port: SERVER_PORT,
      cdp_port: CDP_PORT,
      voice_port: features.rina ? VOICE_AGENT_PORT : null,
      server_url: serverUrl,
    }, null, 2), 'utf8');
  } catch (err) {
    console.error(`[Main] Failed to write runtime file: ${err.message}`);
  }

  // (k) Create window first, then (l) start voice agent
  // (so frontend is ready to receive greeting message).
  createWindow();
  if (features.rina) {
    startVoiceAgent(pythonPath);
  } else {
    console.log('[Main] RINA voice agent disabled by feature flag.');
  }
})();

app.on('window-all-closed', () => {
  gracefulShutdown();
});
