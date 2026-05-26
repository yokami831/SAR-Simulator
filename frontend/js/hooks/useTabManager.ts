/**
 * useTabManager.ts — Tab CRUD, switching, and state persistence
 *
 * Handles switchTab, openWorkspace, onAddTab, onCloseTab, onRenameTab.
 * State setters are passed in from app.tsx to avoid circular dependencies.
 */

import { useCallback, useRef } from 'react';
import type { Node, Edge, ReactFlowInstance } from '@xyflow/react';
import { consoleLog } from '../backend.js';
import { resetNodeIdCounter } from '../blockLibraryData.js';
import { DELAY_RESIZE_EVENT } from '../constants.js';
import { initGlobalChat } from '../chat.js';
import { rcNewFlow, rcConfirmSave } from '../modal.js';
import { createTabState, computeMaxNodeId } from '../utils.js';
import type { TabInstance, TabState } from '../types.js';
import { getTabType } from '../tabRegistry.js';

interface UseTabManagerOptions {
  rfInstance: React.MutableRefObject<ReactFlowInstance | null>;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  skipHistoryRef: React.MutableRefObject<boolean>;
  historyRef: React.MutableRefObject<Array<{ nodes: Node[]; edges: Edge[]; subgraphStore: Record<string, unknown> }>>;
  futureRef: React.MutableRefObject<Array<{ nodes: Node[]; edges: Edge[]; subgraphStore: Record<string, unknown> }>>;
  subgraphStoreRef: React.MutableRefObject<Record<string, unknown>>;
  tabs: TabInstance[];
  setTabs: React.Dispatch<React.SetStateAction<TabInstance[]>>;
  activeTabRef: React.MutableRefObject<string>;
  setActiveTabId: (id: string) => void;
  tabStatesRef: React.MutableRefObject<Map<string, TabState>>;
  tabDataRef: React.MutableRefObject<Map<string, any>>;
  handleSaveRef: React.MutableRefObject<(() => Promise<void>) | null>;
  sidebarVisibleRef: React.MutableRefObject<boolean>;
  setSidebarVisible: (v: boolean) => void;
}

export function useTabManager({
  rfInstance, setNodes, setEdges, skipHistoryRef, historyRef, futureRef,
  subgraphStoreRef, tabs, setTabs, activeTabRef, setActiveTabId,
  tabStatesRef, tabDataRef,
  handleSaveRef, sidebarVisibleRef, setSidebarVisible,
}: UseTabManagerOptions) {

  /** Persist open tabs list to app-state.json for session restore */
  const persistOpenTabs = useCallback((currentTabs: TabInstance[], activeId: string) => {
    const openTabs = currentTabs
      .filter(t => t.workspaceFilename)
      .map(t => ({ filename: t.workspaceFilename!, type: t.type }));
    const activeTab = currentTabs.find(t => t.id === activeId);
    const activeFilename = activeTab?.workspaceFilename || null;
    fetch('/api/app-state', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openTabs, activeTab: activeFilename }),
    }).catch(() => {});
  }, []);

  /** Save current tab's canvas state into tabStatesRef */
  const saveCurrentTabState = useCallback(() => {
    const id = activeTabRef.current;
    const currentNodes = rfInstance.current?.getNodes() || [];
    const currentEdges = rfInstance.current?.getEdges() || [];
    const viewport = rfInstance.current?.getViewport() || { x: 0, y: 0, zoom: 1 };
    tabStatesRef.current.set(id, {
      nodes: structuredClone(currentNodes),
      edges: structuredClone(currentEdges),
      viewport: { ...viewport },
      undoStack: structuredClone(historyRef.current),
      redoStack: structuredClone(futureRef.current),
      subgraphStore: structuredClone(subgraphStoreRef.current),
      dirty: tabStatesRef.current.get(id)?.dirty || false,
      panels: {
        sidebar: sidebarVisibleRef.current,
        console: !document.getElementById('console-panel')?.classList.contains('console-hidden'),
        terminal: !document.getElementById('terminal-panel')?.classList.contains('terminal-panel-hidden'),
      },
    });
  }, []);

  /** Mark the current tab as dirty (has unsaved changes) */
  const markDirty = useCallback(() => {
    const tabId = activeTabRef.current;
    const state = tabStatesRef.current.get(tabId);
    if (state && !state.dirty) {
      state.dirty = true;
      setTabs(prev => [...prev]);
    }
  }, []);

  /** Clear dirty flag for a tab */
  const clearDirty = useCallback((tabId?: string) => {
    const id = tabId || activeTabRef.current;
    const state = tabStatesRef.current.get(id);
    if (state) {
      state.dirty = false;
      setTabs(prev => [...prev]);
    }
  }, []);

  /** Switch to a different tab */
  const switchTab = useCallback((newTabId: string) => {
    if (newTabId === activeTabRef.current) return;
    // Save current tab state to in-memory tabStatesRef
    saveCurrentTabState();

    // Restore new tab state
    activeTabRef.current = newTabId;
    setActiveTabId(newTabId);
    const newTab = tabs.find(t => t.id === newTabId);
    const saved = tabStatesRef.current.get(newTabId);
    if (saved) {
      skipHistoryRef.current = true;
      setNodes(saved.nodes);
      setEdges(saved.edges);
      historyRef.current = saved.undoStack;
      futureRef.current = saved.redoStack;
      subgraphStoreRef.current = saved.subgraphStore;
      // Reset nodeIdCounter to avoid ID collisions (e.g. in createSubgraph)
      resetNodeIdCounter(computeMaxNodeId(saved.nodes) + 1);
      requestAnimationFrame(() => {
        skipHistoryRef.current = false;
        if (saved.viewport) rfInstance.current?.setViewport(saved.viewport);
      });
    } else {
      skipHistoryRef.current = true;
      setNodes([]);
      setEdges([]);
      historyRef.current = [];
      futureRef.current = [];
      subgraphStoreRef.current = {};
      resetNodeIdCounter(100);
      requestAnimationFrame(() => { skipHistoryRef.current = false; });
    }

    // Restore panel visibility for new tab
    const panels = saved?.panels;
    const consolePanel = document.getElementById('console-panel');
    const termPanel = document.getElementById('terminal-panel');
    const termContainer = document.getElementById('terminal-container');

    if (panels) {
      // Sidebar (React state)
      setSidebarVisible(panels.sidebar);
      // Console
      if (panels.console) consolePanel?.classList.remove('console-hidden');
      else consolePanel?.classList.add('console-hidden');
    } else {
      // No saved panel state (new tab) → defaults: sidebar visible, console hidden
      setSidebarVisible(true);
      consolePanel?.classList.add('console-hidden');
    }
    // Terminal/Chat panel: keep current visibility (global chat, not per-tab)
    if (termContainer && !termPanel?.classList.contains('terminal-panel-hidden')) {
      initGlobalChat(termContainer);
    }
    // Trigger layout recalc after panel changes
    setTimeout(() => window.dispatchEvent(new Event('resize')), DELAY_RESIZE_EVENT);

    // Document title is managed by app.tsx (shows workspace folder name)
  }, [tabs, saveCurrentTabState, setNodes, setEdges]);

  /** Open a workspace in a new flow tab (or switch if already open) */
  const openWorkspace = useCallback(async (filename: string) => {
    // Check if already open
    const existing = tabs.find(t => t.workspaceFilename === filename);
    if (existing) {
      switchTab(existing.id);
      return;
    }
    try {
      const resp = await fetch(`/api/workspaces/${filename}`);
      if (!resp.ok) throw new Error('Failed to load workspace');
      const wsData = await resp.json();
      const tabId = `tab-${Date.now()}`;
      const newTab: TabInstance = {
        id: tabId,
        type: wsData.type || 'flow',
        title: wsData.title || filename,
        workspaceFilename: filename,
        workspacePath: wsData.path || null,
      };
      // Prepare tab state from workspace canvas data
      const canvas = wsData.canvas || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
      const restoredNodes = (canvas.nodes || []).map((n: Record<string, unknown>) => {
        // Strip transient execution state from saved data
        if (n.data) {
          const { executionStatus, executionOutput, executionError, executionTime, displayData, resultValue, ...cleanData } = n.data as Record<string, unknown>;
          return { ...n, data: cleanData };
        }
        return n;
      });
      tabStatesRef.current.set(tabId, createTabState({
        nodes: restoredNodes,
        edges: canvas.edges || [],
        viewport: canvas.viewport || { x: 0, y: 0, zoom: 1 },
        subgraphStore: wsData.subgraphStore || {},
      }));
      // Restore plugin tab data if present (mindmap, excalidraw, etc.)
      const openedTabType = getTabType(newTab.type);
      if (openedTabType?.dataKey && wsData[openedTabType.dataKey]) {
        tabDataRef.current.set(tabId, wsData[openedTabType.dataKey]);
      }
      // Reset nodeIdCounter based on restored nodes to avoid ID collisions
      resetNodeIdCounter(computeMaxNodeId(restoredNodes) + 1);
      // Use the functional update's `prev` (latest tabs) to persist — the
      // `tabs` closure is stale when workspaces are opened back-to-back (e.g.
      // session restore), which dropped all but the last tab from app-state.
      setTabs(prev => {
        const next = [...prev, newTab];
        persistOpenTabs(next, tabId);
        return next;
      });
      // Switch to new tab after state update
      setTimeout(() => switchTab(tabId), 0);
    } catch (err) {
      consoleLog('error', `Failed to open workspace: ${err}`, '', 'file');
    }
  }, [tabs, switchTab, persistOpenTabs]);

  /** Handle add tab from TabBar [+] button */
  const onAddTab = useCallback(async (type: string) => {
    let errorMessage = '';
    // Loop until successful creation or user cancels
    while (true) {
      const input = await rcNewFlow({ errorMessage });
      if (!input) return; // cancelled
      const resp = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, title: input.title, description: input.description }),
      });
      if (resp.status === 409) {
        // Duplicate name — show error and re-prompt
        const err = await resp.json();
        errorMessage = err.detail || 'A workspace with this name already exists.';
        continue;
      }
      if (!resp.ok) {
        consoleLog('error', 'Failed to create workspace', '', 'file');
        return;
      }
      const ws = await resp.json();
      const tabId = `tab-${Date.now()}`;
      const newTab: TabInstance = {
        id: tabId, type, title: ws.title,
        workspaceFilename: ws.filename,
        workspacePath: ws.path || null,
      };
      tabStatesRef.current.set(tabId, createTabState());
      setTabs(prev => {
        const next = [...prev, newTab];
        persistOpenTabs(next, tabId);
        return next;
      });
      setTimeout(() => switchTab(tabId), 0);
      return;
    }
  }, [switchTab, persistOpenTabs]);

  /** Close a tab (with dirty check) */
  const onCloseTab = useCallback(async (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    // Check for unsaved changes
    // For the active tab, snapshot current state first
    if (activeTabRef.current === tabId) {
      saveCurrentTabState();
    }
    const state = tabStatesRef.current.get(tabId);
    if (state?.dirty) {
      const choice = await rcConfirmSave(tab.title);
      if (choice === 'cancel') return;
      if (choice === 'save') {
        await handleSaveRef.current?.();
      }
      // 'discard' → just close
    }

    tabStatesRef.current.delete(tabId);
    tabDataRef.current.delete(tabId);
    const remaining = tabs.filter(t => t.id !== tabId);
    setTabs(remaining);

    if (activeTabRef.current === tabId) {
      // Switch to the most recent remaining tab, or empty state
      const nextTab = remaining.length > 0 ? remaining[remaining.length - 1] : null;
      const nextActiveId = nextTab?.id || '';
      activeTabRef.current = nextActiveId;
      setActiveTabId(nextActiveId);
      if (nextTab) {
        // Use switchTab logic but we already set activeTabRef, so call directly
        setTimeout(() => switchTab(nextTab.id), 0);
      }
      persistOpenTabs(remaining, nextActiveId);
    } else {
      persistOpenTabs(remaining, activeTabRef.current);
    }
  }, [tabs, saveCurrentTabState, switchTab, persistOpenTabs]);

  /** Edit a tab (title + description) via dialog */
  const onEditTab = useCallback(async (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;

    // Fetch current description from backend
    let currentDesc = '';
    if (tab.workspaceFilename) {
      try {
        const resp = await fetch(`/api/workspaces/${tab.workspaceFilename}`);
        if (resp.ok) {
          const ws = await resp.json();
          currentDesc = ws.description || '';
        }
      } catch { /* ignore */ }
    }

    const result = await rcNewFlow({
      title: 'Edit Workspace',
      initialTitle: tab.title,
      initialDescription: currentDesc,
      submitLabel: 'Save',
    });
    if (!result) return;

    if (tab.workspaceFilename) {
      try {
        const resp = await fetch(`/api/workspaces/${tab.workspaceFilename}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: result.title, description: result.description }),
        });
        if (resp.ok) {
          const data = await resp.json();
          const newFilename = data.filename || tab.workspaceFilename;
          setTabs(prev => prev.map(t => t.id === tabId
            ? { ...t, title: result.title, workspaceFilename: newFilename }
            : t));
          return;
        }
      } catch { /* fall through */ }
    }
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, title: result.title } : t));
  }, [tabs]);

  /** Reorder tabs by moving fromId to toId's position */
  const reorderTabs = useCallback((fromId: string, toId: string) => {
    const arr = [...tabs];
    const fromIdx = arr.findIndex(t => t.id === fromId);
    const toIdx = arr.findIndex(t => t.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, moved);
    setTabs(arr);
    persistOpenTabs(arr, activeTabRef.current);
  }, [tabs, setTabs, persistOpenTabs]);

  return {
    saveCurrentTabState,
    switchTab,
    openWorkspace,
    onAddTab,
    onCloseTab,
    onEditTab,
    reorderTabs,
    markDirty,
    clearDirty,
    persistOpenTabs,
  };
}
