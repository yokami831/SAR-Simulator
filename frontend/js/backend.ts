/**
 * backend.js - Backend communication module
 *
 * Handles all communication with the FastAPI server:
 * - REST API calls (run, stop, status)
 * - WebSocket connection with auto-reconnect (exponential backoff)
 * - Real-time visualization data store (vizDataStore)
 * - Bidirectional WebSocket: tool commands from server + responses back
 * - Status bar helper
 */

// ===== Constants =====
const API_BASE = '';  // Same origin

import { WS_RECONNECT_BASE, WS_RECONNECT_MAX, CATEGORY_COLORS, MAX_CONSOLE_LOGS } from './constants.js';
import { notifyConsoleEntry, notifyConsoleClear } from './components/ConsolePanel.js';

const WS_MAX_RETRIES = 10;
const WS_BACKOFF_BASE = WS_RECONNECT_BASE;
const WS_BACKOFF_MAX = WS_RECONNECT_MAX;

// ===== Status Bar Helper =====


// ===== REST API =====

/**
 * Common fetch helper: sends request, checks resp.ok, returns parsed JSON.
 * Throws on HTTP errors with server-provided message.
 */
export async function apiFetch(path: string, options: RequestInit = {}): Promise<unknown> {
  const resp = await fetch(`${API_BASE}${path}`, options);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || err.detail || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export function apiRun() {
  return apiFetch('/api/tools/start_execution', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
}

export function apiStop() {
  return apiFetch('/api/tools/stop_execution', { method: 'POST' });
}

export function apiStatus() {
  return apiFetch('/api/tools/get_execution_status', { method: 'POST' });
}

export function apiClear() {
  return apiFetch('/api/tools/clear', { method: 'POST' });
}

export function apiStepStart() {
  return apiFetch('/api/tools/step_start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
}

export function apiStepNext() {
  return apiFetch('/api/tools/step_next', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
}

export function apiStepReset() {
  return apiFetch('/api/tools/step_reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
}

export function apiRunRemaining() {
  return apiFetch('/api/tools/run_remaining', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
}

export function apiAutoLayout() {
  return apiFetch('/api/tools/auto_layout', { method: 'POST' });
}

// ===== WebSocket with Auto-Reconnect =====

// Module-scoped state (encapsulated, not global)
let wsConnection: WebSocket | null = null;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsReconnectAttempts = 0;
let wsShouldReconnect = false;

/**
 * Stores latest data from WebSocket, keyed by frontend node ID.
 * As a reference type, importing this from another module shares the same object.
 */
export const vizDataStore: Record<string, {
  dataType: string
  data: number[]
  timestamp: number
  traces: Record<number, number[]>
  fftSize?: number
  sampleRate?: number
  isComplex?: boolean
  [key: string]: unknown
}> = {};

// ===== Tool Command Handler (bidirectional WebSocket) =====

/**
 * Callback registered by app.js to handle tool commands from server.
 * @type {((msg: object) => void) | null}
 */
let _toolCommandHandler: ((msg: Record<string, unknown>) => void | Promise<void>) | null = null;
let _nodeExecutionHandler: ((msg: Record<string, unknown>) => void) | null = null;
let _statusChangeHandler: ((msg: Record<string, unknown>) => void) | null = null;
let _stepReadyHandler: ((msg: Record<string, unknown>) => void) | null = null;
let _nodeOutputStreamHandler: ((msg: Record<string, unknown>) => void) | null = null;

export function setToolCommandHandler(handler: (msg: Record<string, unknown>) => void): void {
  _toolCommandHandler = handler;
}

export function setNodeExecutionHandler(handler: (msg: Record<string, unknown>) => void): void {
  _nodeExecutionHandler = handler;
}

export function setStatusChangeHandler(handler: (msg: Record<string, unknown>) => void): void {
  _statusChangeHandler = handler;
}

export function setNodeOutputStreamHandler(handler: (msg: Record<string, unknown>) => void): void {
  _nodeOutputStreamHandler = handler;
}

export function setStepReadyHandler(handler: (msg: Record<string, unknown>) => void): void {
  _stepReadyHandler = handler;
}

/**
 * Send a message back to the server via WebSocket.
 * Used for command responses (response_to pattern).
 * @param {object} data - JSON-serializable message
 */
export function sendWsMessage(data: Record<string, unknown>): void {
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify(data));
  }
}

/**
 * Open a WebSocket connection to /ws/data with auto-reconnect enabled.
 */
export function connectWebSocket(): void {
  if (wsConnection && wsConnection.readyState <= 1) return;
  wsShouldReconnect = true;
  wsReconnectAttempts = 0;
  _doConnect();
}

function _doConnect(): void {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/ws/data`;
  try {
    wsConnection = new WebSocket(wsUrl);
  } catch (e) {
    console.error('WebSocket creation failed:', e);
    _scheduleReconnect();
    return;
  }
  wsConnection.onopen = () => {
    wsReconnectAttempts = 0;
    // Restore status if we were in reconnecting state
    consoleLog('info', 'WebSocket reconnected', '', 'system');
    // Register error sender for global error handler (see index.html)
    window.__sendErrorToBackend = (entry) => {
      if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        wsConnection.send(JSON.stringify(entry));
      }
    };
    // Drain errors that occurred before WebSocket connected
    if (window.__errorQueue && window.__errorQueue.length > 0) {
      window.__errorQueue.forEach(entry => window.__sendErrorToBackend!(entry));
      window.__errorQueue = [];
    }
  };
  wsConnection.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); }
    catch (e) { console.error('Invalid JSON from WebSocket:', e); return; }

    // Data stream messages (visualization data from ZMQ bridge)
    if (msg.block_id && msg.data_type) {
      const inputIndex = msg.input_index || 0;
      const now = Date.now();
      const existing = vizDataStore[msg.block_id];
      if (existing) {
        // Update existing entry — store per-trace data
        existing.dataType = msg.data_type;
        existing.fftSize = msg.fft_size;
        existing.sampleRate = msg.sample_rate;
        existing.isComplex = msg.is_complex;
        existing.timestamp = now;
        if (!existing.traces) existing.traces = {};
        existing.traces[inputIndex] = msg.data;
        // Primary data = first trace (backward compat)
        if (inputIndex === 0) existing.data = msg.data;
      } else {
        const traces: Record<number, number[]> = {};
        traces[inputIndex as number] = msg.data;
        vizDataStore[msg.block_id] = {
          dataType: msg.data_type,
          data: msg.data,
          fftSize: msg.fft_size,
          sampleRate: msg.sample_rate,
          isComplex: msg.is_complex,
          timestamp: now,
          traces,
        };
      }
      return;
    }

    // Reload command from server (triggered by POST /api/tools/reload)
    if (msg.action === 'reload') {
      consoleLog('info', 'Reload command received from server');
      window.location.reload();
      return;
    }

    // Backend-pushed console log (from tools.py broadcast_console_log)
    if (msg.type === 'console_log_push') {
      consoleLog(msg.level, msg.message, msg.details || '', msg.source || '', true);
      return;
    }

    // Block definitions changed (e.g. workspace switch loaded different blocks/)
    if (msg.type === 'blocks_changed') {
      consoleLog('info', `Block definitions changed (source: ${msg.source || 'unknown'}). Reloading library.`);
      // Dynamic import to avoid circular dependency with blockLibraryData.ts
      import('./blockLibraryData').then(mod => {
        mod.fetchBlockData().catch(e => {
          consoleLog('error', 'Failed to reload block library after blocks_changed', String(e));
        });
      });
      return;
    }

    // Node execution status (from flow_executor via tools.py)
    if (msg.type === 'node_execution_status') {
      if (_nodeExecutionHandler) _nodeExecutionHandler(msg);
      return;
    }

    // Streaming print output during execution
    if (msg.type === 'node_output_stream') {
      if (_nodeOutputStreamHandler) _nodeOutputStreamHandler(msg);
      return;
    }

    // Lint warnings (e.g. direct float-to-int bypass detection)
    if (msg.type === 'node_lint_warning') {
      if (_nodeOutputStreamHandler) {
        const warningText = (msg.warnings || [])
          .map((w: string) => `⚠ ${w}`)
          .join('\n');
        _nodeOutputStreamHandler({
          type: 'node_output_stream',
          node_id: msg.node_id,
          text: warningText + '\n',
        });
      }
      return;
    }

    // Step execution ready (next block to execute)
    if (msg.type === 'step_ready') {
      if (_stepReadyHandler) _stepReadyHandler(msg);
      return;
    }

    // Flow status change (running/stopped)
    if (msg.type === 'status_change') {
      if (_statusChangeHandler) _statusChangeHandler(msg);
      return;
    }

    // Tool command messages from server (add_element, remove_element, etc.)
    if (msg.action && msg.request_id) {
      if (_toolCommandHandler) {
        // Handler is async — catch unhandled rejections to ensure error response
        Promise.resolve(_toolCommandHandler(msg)).catch((err) => {
          console.error('Tool command handler error:', err);
          sendWsMessage({
            response_to: msg.request_id as string,
            success: false,
            error: String(err?.message || err),
          });
        });
      } else {
        console.warn('Tool command received but handler not registered:', msg.action);
        sendWsMessage({
          response_to: msg.request_id,
          success: false,
          error: `Frontend tool handler not ready (action: ${msg.action}). ` +
                 `React components may still be initializing. Retry in 1-2 seconds.`,
        });
      }
      return;
    }
  };
  wsConnection.onclose = () => {
    wsConnection = null;
    if (wsShouldReconnect) _scheduleReconnect();
  };
  wsConnection.onerror = (e) => {
    console.error('WebSocket error:', e);
  };
}

function _scheduleReconnect(): void {
  if (!wsShouldReconnect || wsReconnectAttempts >= WS_MAX_RETRIES) {
    if (wsReconnectAttempts >= WS_MAX_RETRIES) {
      consoleLog('error', 'Connection lost — max retries reached', '', 'system');
    }
    return;
  }
  wsReconnectAttempts++;
  const delay = Math.min(WS_BACKOFF_BASE * Math.pow(2, wsReconnectAttempts - 1), WS_BACKOFF_MAX);
  consoleLog('info', `Reconnecting (${wsReconnectAttempts}/${WS_MAX_RETRIES})...`, '', 'system');
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    if (wsShouldReconnect) _doConnect();
  }, delay);
}

/**
 * Close the WebSocket connection and cancel any pending reconnect.
 */
export function disconnectWebSocket(): void {
  wsShouldReconnect = false;
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (wsConnection) { wsConnection.close(); wsConnection = null; }
}

// ===== Console Log System =====

interface ConsoleLogEntry {
  id: string
  timestamp: string
  level: 'info' | 'warning' | 'error'
  message: string
  details: string
  source: string
}

const _consoleLogs: ConsoleLogEntry[] = [];

function _appendConsoleEntry(entry: ConsoleLogEntry): void {
  // Notify React component to render the entry
  notifyConsoleEntry(entry);
}

function _showConsolePanel(): void {
  const panel = document.getElementById('console-panel');
  if (!panel) return;
  if (panel.classList.contains('console-hidden')) {
    panel.classList.remove('console-hidden');
    const arrow = document.getElementById('console-edge-tab')?.querySelector('.tab-arrow');
    if (arrow) arrow.textContent = '▼';
  }
  if (panel.classList.contains('console-collapsed')) {
    panel.classList.remove('console-collapsed');
  }
  setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
}

/**
 * Add a message to the console log panel.
 * @param {'info'|'warning'|'error'} level
 * @param {string} message - Short summary
 * @param {string} [details] - Expandable details (e.g., traceback)
 * @param {string} [source] - Origin identifier (e.g., 'codegen', 'runtime', 'frontend')
 */
export type ConsoleLevel = 'info' | 'warning' | 'error';

// Error count tracking for taskbar status indicator
let _errorCount = 0;
let _onErrorCountChange: ((count: number) => void) | null = null;

export function setErrorCountHandler(handler: (count: number) => void): void {
  _onErrorCountChange = handler;
  // Immediately sync current count
  handler(_errorCount);
}

export function getErrorCount(): number { return _errorCount; }

export function consoleLog(level: ConsoleLevel, message: string, details: string = '', source: string = '', skipForward: boolean = false): void {
  const entry = {
    id: Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    level,
    message,
    details,
    source,
  };
  _consoleLogs.push(entry);
  if (_consoleLogs.length > MAX_CONSOLE_LOGS) _consoleLogs.shift();

  _appendConsoleEntry(entry);

  // Track error count for taskbar indicator
  if (level === 'error') {
    _errorCount++;
    _onErrorCountChange?.(_errorCount);
  }

  // Auto-show panel on error or warning
  if (level === 'error' || level === 'warning') {
    _showConsolePanel();
  }

  // Forward to backend for AI agent API access (skip if pushed from backend)
  if (!skipForward) {
    sendWsMessage({ type: 'console_log', ...entry });
  }
}

/** Get all console logs (for API/testing). */
function getConsoleLogs(): ConsoleLogEntry[] {
  return [..._consoleLogs];
}

/** Clear all console logs. */
export function clearConsoleLogs(): void {
  _consoleLogs.length = 0;
  _errorCount = 0;
  _onErrorCountChange?.(0);
  notifyConsoleClear();
  sendWsMessage({ type: 'console_clear' });
}

// Expose consoleLog globally for inline error handler in index.html
window.__consoleLog = consoleLog as (level: string, message: string, details?: string, source?: string) => void;
// Drain any errors queued before this module loaded
if (window.__errorQueue) {
  for (const entry of window.__errorQueue) {
    consoleLog('error', (entry as { message?: string }).message || String(entry), (entry as { stack?: string }).stack || '', 'js');
  }
  window.__errorQueue = [];
}

// ===== Category Colors (used by sidebar and minimap) =====

export const categoryColors: Record<string, string> = CATEGORY_COLORS;
