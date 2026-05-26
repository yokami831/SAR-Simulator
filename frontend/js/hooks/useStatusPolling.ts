/**
 * useStatusPolling - Poll execution status to detect runtime errors/crashes.
 */
import { useEffect } from 'react';
import { apiStatus, vizDataStore, consoleLog } from '../backend.js';
import { parseError } from '../utils.js';

interface StatusPollingArgs {
  running: boolean;
  setRunning: (v: boolean) => void;
  updateRunStopButton: (v: boolean) => void;
}

export function useStatusPolling({ running, setRunning, updateRunStopButton }: StatusPollingArgs) {
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(async () => {
      try {
        const status = await apiStatus();
        if (status.status === 'error') {
          setRunning(false);
          updateRunStopButton(false);
          const errMsg = status.error_message || 'Process exited unexpectedly';
          const { summary, traceback } = parseError(errMsg);
          consoleLog('error', summary, traceback, 'runtime');
          Object.keys(vizDataStore).forEach(k => delete vizDataStore[k]);
        } else if (status.status === 'stopped' && running) {
          setRunning(false);
          updateRunStopButton(false);
          consoleLog('info', 'Process ended', '', 'runner');
          Object.keys(vizDataStore).forEach(k => delete vizDataStore[k]);
        }
      } catch (_) {
        // Ignore fetch errors (server might be temporarily unavailable)
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [running, updateRunStopButton]);
}
