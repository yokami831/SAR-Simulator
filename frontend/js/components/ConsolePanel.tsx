/**
 * ConsolePanel - React component for the console/log panel.
 *
 * Replaces DOM direct manipulation in backend.ts with React rendering.
 * Subscribes to console log entries via a callback registry.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';

export interface ConsoleLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  details: string;
  source: string;
}

// ===== Subscriber pattern for backend.ts → React bridge =====

type ConsoleLogSubscriber = (entry: ConsoleLogEntry) => void;
type ConsoleClearSubscriber = () => void;

let _logSubscriber: ConsoleLogSubscriber | null = null;
let _clearSubscriber: ConsoleClearSubscriber | null = null;

/** Called by backend.ts when a new log entry is added. */
export function notifyConsoleEntry(entry: ConsoleLogEntry): void {
  _logSubscriber?.(entry);
}

/** Called by backend.ts when logs are cleared. */
export function notifyConsoleClear(): void {
  _clearSubscriber?.();
}


// ===== Components =====

function ConsoleEntry({ entry }: { entry: ConsoleLogEntry }) {
  const [expanded, setExpanded] = useState(false);

  const time = new Date(entry.timestamp);
  const timeStr = time.toLocaleTimeString('en-US', { hour12: false });
  const levelIcons: Record<string, string> = { info: 'I', warning: 'W', error: 'E' };

  return (
    <div className={`console-entry console-${entry.level}`} data-entry-id={entry.id}>
      <span className="console-time">{timeStr}</span>
      <span className={`console-level console-level-${entry.level}`}>
        {levelIcons[entry.level] || '?'}
      </span>
      <span className="console-msg">{entry.message}</span>
      {entry.details && (
        <>
          <button
            className="console-expand"
            title="Show details"
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
          >
            {expanded ? '\u25BC' : '\u25B6'}
          </button>
          {expanded && (
            <pre className="console-details" style={{ display: 'block' }}>{entry.details}</pre>
          )}
        </>
      )}
    </div>
  );
}


export default function ConsoleBody() {
  const [entries, setEntries] = useState<ConsoleLogEntry[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    _logSubscriber = (entry: ConsoleLogEntry) => {
      setEntries(prev => [...prev, entry]);
    };
    _clearSubscriber = () => {
      setEntries([]);
    };
    return () => {
      _logSubscriber = null;
      _clearSubscriber = null;
    };
  }, []);

  // Auto-scroll to bottom on new entries
  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <div ref={bodyRef} style={{ overflow: 'auto', height: '100%' }}>
      {entries.map(entry => (
        <ConsoleEntry key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
