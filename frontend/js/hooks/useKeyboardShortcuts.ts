/**
 * useKeyboardShortcuts - Data-driven keyboard shortcut handler.
 */
import { useEffect, useCallback } from 'react';

interface ShortcutActions {
  undo: () => void;
  redo: () => void;
  copySelected: () => void;
  pasteClipboard: () => void;
  deleteSelected: () => void;
  handleSave: () => void;
  handleSaveAs: () => void;
  clearAll: () => void;
  groupSelected: () => void;
  ungroupSelected: () => void;
  toggleSidebar: () => void;
  handleRunAll?: () => void;
  handleStep?: () => void;
  handleStopReset?: () => void;
  isFlowTab: boolean;
}

function isTextInput(): boolean {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

export function useKeyboardShortcuts(actions: ShortcutActions) {
  const handler = useCallback((e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;

    // Clipboard, undo/redo, delete, group — flow tab only; let mind-elixir handle its own
    if (!actions.isFlowTab) {
      if (mod && (e.key === 'z' || e.key === 'y' || e.key === 'Z' || e.key === 'c' || e.key === 'v' || e.key === 'x')) return;
      if (e.key === 'Delete' || e.key === 'Backspace') return;
      if (mod && e.key.toLowerCase() === 'g') return;
    }

    if (mod && e.key === 'z' && !e.shiftKey) {
      e.preventDefault(); actions.undo(); return;
    }
    if (mod && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
      e.preventDefault(); actions.redo(); return;
    }
    if (mod && e.key === 'c') {
      if (isTextInput()) return;
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      e.preventDefault(); actions.copySelected(); return;
    }
    if (mod && e.key === 'v') {
      if (isTextInput()) return;
      e.preventDefault(); actions.pasteClipboard(); return;
    }
    if (mod && e.shiftKey && e.key === 'S') {
      e.preventDefault(); actions.handleSaveAs(); return;
    }
    if (mod && e.key === 's') {
      e.preventDefault(); actions.handleSave(); return;
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'g') {
      if (isTextInput()) return;
      e.preventDefault(); actions.groupSelected(); return;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'g') {
      e.preventDefault(); actions.ungroupSelected(); return;
    }
    if (mod && e.key === 'b') {
      e.preventDefault(); actions.toggleSidebar(); return;
    }
    if (e.key === 'F5' && !e.shiftKey) {
      e.preventDefault(); actions.handleRunAll?.(); return;
    }
    if (e.key === 'F5' && e.shiftKey) {
      e.preventDefault(); actions.handleStopReset?.(); return;
    }
    if (e.key === 'F10') {
      e.preventDefault(); actions.handleStep?.(); return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (isTextInput()) return;
      actions.deleteSelected();
    }
  }, [actions]);

  useEffect(() => {
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handler]);
}
