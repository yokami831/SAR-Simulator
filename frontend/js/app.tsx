/**
 * app.js - Main application entry point and App component
 *
 * This is the root module loaded by index.html.
 * Contains:
 * - App component with React Flow setup and all callbacks
 * - Initial demo flowgraph data
 * - Entry point: createRoot().render()
 * - Toolbar button bindings and keyboard shortcuts
 * - Block library initialization
 */

import '@xyflow/react/dist/style.css';
import { useState, useCallback, useRef, useEffect, Fragment, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import type { Node, Edge, ReactFlowInstance } from '@xyflow/react';

import { apiRun, apiStop, apiAutoLayout, apiStepStart, apiStepNext, apiStepReset, apiRunRemaining, connectWebSocket, consoleLog, setToolCommandHandler, sendWsMessage, setErrorCountHandler } from './backend.js';
import { resetNodeIdCounter, fetchBlockData, getSetNodesRef, type BlockLibraryData } from './blockLibraryData.js';
import { BlockLibrarySidebar } from './components/BlockLibrarySidebar.js';
import { FlowTab } from './components/FlowTab.js';
import { rcConfirmSave } from './modal.js';
import { BookmarkBar } from './bookmarkBar.js';
import { BottomTaskbar } from './taskbar.js';
import './mindmap.js';
import './excalidraw.js';
import './notes.js';
import './files.js';
import { createPortal } from 'react-dom';
import type { TabInstance, TabState, FlowTabApi } from './types.js';
import { getTabUiConfig, getTabType, registerToolbarComponent } from './tabRegistry.js';
import { FlowToolbar } from './components/FlowToolbar.js';
import { parseError, showToast } from './utils.js';
import { useFlowPersistence } from './hooks/useFlowPersistence.js';
import { useTabManager } from './hooks/useTabManager.js';
import { useToolCommandHandler } from './hooks/useToolCommandHandler.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { useStatusPolling } from './hooks/useStatusPolling.js';

// 'flow' remains the default — too deeply integrated to wrap as a plugin tab

// ===== Register FlowToolbar =====
registerToolbarComponent('flow', FlowToolbar as any);

// ===== Initial Empty Canvas =====

const initialNodes: Node[] = [];

const initialEdges: Edge[] = [];

// ===== Main App Component =====

/** Update window title with workspace folder name (pure function, no React dependency) */
function updateWindowTitle(folderPath?: string) {
  if (folderPath) {
    const parts = folderPath.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
    const folderName = parts[parts.length - 1] || 'HiyoCanvas';
    document.title = `HiyoCanvas — ${folderName}`;
  } else {
    document.title = 'HiyoCanvas';
  }
}

function App() {
  const [running, setRunning] = useState(false);
  const [stepping, setStepping] = useState(false);
  const [nextStepNodeId, setNextStepNodeId] = useState<string | null>(null);
  const runningRef = useRef(false);
  const steppingRef = useRef(false);
  const rfInstance = useRef<ReactFlowInstance | null>(null);
  const flowNameRef = useRef('flowgraph');

  // ===== Bookmark Bar Data =====
  const [bookmarkData, setBookmarkData] = useState<{ rootFiles: any[]; folders: any[] }>({ rootFiles: [], folders: [] });
  const [bookmarkOrder, setBookmarkOrder] = useState<string[]>([]);
  const [errorCount, setErrorCount] = useState(0);

  const [blockLibraryData, setBlockLibraryData] = useState<BlockLibraryData | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(
    localStorage.getItem('hiyocanvas-sidebar-hidden') !== '1'
  );

  // ===== Multi-Tab State =====
  const [tabs, setTabs] = useState<TabInstance[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const tabStatesRef = useRef<Map<string, TabState>>(new Map());
  const tabDataRef = useRef<Map<string, any>>(new Map());
  const activeTabRef = useRef('');
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  runningRef.current = running;
  steppingRef.current = stepping;
  window.isFlowRunning = () => runningRef.current || steppingRef.current;

  // ===== Refs for tab operation functions (used by tool commands) =====
  const openWorkspaceRef = useRef<((filename: string) => Promise<void>) | null>(null);

  const switchTabRef = useRef<((tabId: string) => void) | null>(null);
  const onCloseTabRef = useRef<((tabId: string) => void) | null>(null);
  const handleSaveRef = useRef<(() => Promise<void>) | null>(null);

  // ===== Subgraph Store =====
  // App owns this ref (shared with FlowTab) because useTabManager writes to it
  // directly on tab switch / restore.
  const subgraphStoreRef = useRef({});

  // ===== Undo/Redo history refs (App-owned, shared with FlowTab) =====
  // useTabManager swaps these on tab switch; FlowTab's useUndoRedo reads/writes
  // them. App itself does not call pushHistory/undo/redo — it routes those
  // through activeFlowApiRef.
  const skipHistoryRef = useRef(false);
  const historyRef = useRef<Array<{ nodes: Node[]; edges: Edge[]; subgraphStore: Record<string, unknown> }>>([]);
  const futureRef = useRef<Array<{ nodes: Node[]; edges: Edge[]; subgraphStore: Record<string, unknown> }>>([]);

  // ===== Active Flow API (Step1 indirection) =====
  // FlowTab registers its operations here each render; App-level features
  // (toolbar, keyboard shortcuts, tool commands) call through this ref instead
  // of capturing function references directly. Single instance today, so the
  // calls resolve to the same functions — behaviour is unchanged.
  const activeFlowApiRef = useRef<FlowTabApi | null>(null);
  const registerApi = useCallback((api: FlowTabApi) => { activeFlowApiRef.current = api; }, []);
  // Unregister with an identity guard: React mounts the next FlowTab (which
  // registers its api) BEFORE unmounting the previous one, so the outgoing
  // tab's cleanup must only clear the ref when it still points at *its own*
  // api — otherwise it would null out the freshly-mounted tab's api.
  const unregisterApi = useCallback((api: FlowTabApi) => {
    if (activeFlowApiRef.current === api) activeFlowApiRef.current = null;
  }, []);

  // ===== Stable ref-reading wrappers for the active Flow's operations =====
  // These are stable (empty deps) so the consumers (useTabManager,
  // useFlowPersistence, useToolCommandHandler) see identical identities to
  // before. The wrappers only forward to whatever FlowTab registered, and use
  // optional chaining so they no-op safely when no Flow tab is mounted (e.g.
  // a mindmap tab is active, or mid tab-switch before the new FlowTab mounts).
  const flowSetNodes = useCallback<FlowTabApi['setNodes']>(
    (...args) => activeFlowApiRef.current?.setNodes(...args), []);
  const flowSetEdges = useCallback<FlowTabApi['setEdges']>(
    (...args) => activeFlowApiRef.current?.setEdges(...args), []);
  const flowSetTooltips = useCallback<FlowTabApi['setTooltips']>(
    (...args) => activeFlowApiRef.current?.setTooltips(...args), []);
  const flowPushHistory = useCallback(() => activeFlowApiRef.current?.pushHistory(), []);
  const flowAddNodeShared = useCallback<FlowTabApi['addNodeShared']>(
    (...args) => activeFlowApiRef.current?.addNodeShared(...args) ?? '', []);
  const flowAddEdgeShared = useCallback<FlowTabApi['addEdgeShared']>(
    (...args) => activeFlowApiRef.current?.addEdgeShared(...args) ?? '', []);
  const flowDeleteNodeShared = useCallback<FlowTabApi['deleteNodeShared']>(
    (nodeId) => activeFlowApiRef.current?.deleteNodeShared(nodeId), []);
  const flowClearAllShared = useCallback(() => activeFlowApiRef.current?.clearAllShared(), []);
  const flowAutoLayout = useCallback(() => activeFlowApiRef.current?.autoLayout(), []);
  const flowCreateSubgraph = useCallback<FlowTabApi['createSubgraph']>(
    (nodeIds, label) => activeFlowApiRef.current?.createSubgraph(nodeIds, label) ?? null, []);
  const flowToggleSubgraph = useCallback<FlowTabApi['toggleSubgraph']>(
    (sgId) => activeFlowApiRef.current?.toggleSubgraph(sgId), []);
  const flowExpandSubgraph = useCallback<FlowTabApi['expandSubgraph']>(
    (sgId) => activeFlowApiRef.current?.expandSubgraph(sgId), []);
  const flowUngroupSubgraph = useCallback<FlowTabApi['ungroupSubgraph']>(
    (sgId) => activeFlowApiRef.current?.ungroupSubgraph(sgId), []);
  const flowRenameSubgraph = useCallback<FlowTabApi['renameSubgraph']>(
    (sgId, newLabel) => activeFlowApiRef.current?.renameSubgraph(sgId, newLabel), []);
  const flowSetSubgraphDescription = useCallback<FlowTabApi['setSubgraphDescription']>(
    (sgId, desc) => activeFlowApiRef.current?.setSubgraphDescription(sgId, desc), []);
  const flowBuildSaveData = useCallback<FlowTabApi['buildSaveData']>(
    (saveName) => activeFlowApiRef.current?.buildSaveData(saveName) ?? {}, []);
  const flowRestoreFlowgraph = useCallback<FlowTabApi['restoreFlowgraph']>(
    (data, fileName) => activeFlowApiRef.current?.restoreFlowgraph(data, fileName), []);

  // ===== Tab Helpers =====
  const activeTab = tabs.find(t => t.id === activeTabId);
  const isFlowTab = activeTab?.type === 'flow';

  /** Load bookmark bar data (workspaces + folders) */
  const loadBookmarkData = useCallback(async () => {
    try {
      const resp = await fetch('/api/workspaces');
      if (!resp.ok) return;
      const data = await resp.json();
      setBookmarkData({
        rootFiles: data.rootFiles || [],
        folders: data.folders || [],
      });
    } catch (err) {
      console.error('Failed to load bookmark data:', err);
    }
  }, []);

  // ===== Tab Manager (extracted hook) =====
  const sidebarVisibleRef = useRef(sidebarVisible);
  sidebarVisibleRef.current = sidebarVisible;
  const {
    saveCurrentTabState, switchTab, openWorkspace, onAddTab, onCloseTab, onEditTab, reorderTabs,
    markDirty, clearDirty, persistOpenTabs,
  } = useTabManager({
    rfInstance, setNodes: flowSetNodes, setEdges: flowSetEdges, skipHistoryRef, historyRef: historyRef as any, futureRef: futureRef as any,
    subgraphStoreRef, tabs, setTabs, activeTabRef, setActiveTabId,
    tabStatesRef, tabDataRef,
    handleSaveRef, sidebarVisibleRef, setSidebarVisible,
  });

  // Auto-reset stepping when tab changes
  useEffect(() => {
    if (steppingRef.current) {
      apiStepReset();
    }
  }, [activeTabId]);

  // Keep refs in sync for tool command handler
  openWorkspaceRef.current = openWorkspace;
  switchTabRef.current = switchTab;
  onCloseTabRef.current = onCloseTab;

  /** Change workspace folder — close all tabs first, then switch */
  const changeFolder = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.showOpenDialog) {
      console.warn('Electron dialog not available');
      return;
    }
    const result = await api.showOpenDialog({ properties: ['openDirectory'], title: 'Select Workspace Folder' });
    if (result.canceled || !result.filePaths[0]) return;

    const newPath = result.filePaths[0];

    // Close all open tabs
    if (tabs.length > 0) {
      if (!confirm('All open tabs will be closed. Continue?')) return;
      for (const t of tabs) {
        onCloseTab(t.id);
      }
    }

    // Switch folder on backend
    try {
      const resp = await fetch('/api/workspaces-dir', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newPath }),
      });
      if (!resp.ok) {
        const err = await resp.json();
        alert(`Failed to switch folder: ${err.error || 'Unknown error'}`);
        return;
      }
      await loadBookmarkData();
      updateWindowTitle(newPath);
    } catch (err) {
      console.error('Failed to switch workspace folder:', err);
    }
  }, [tabs, onCloseTab, loadBookmarkData]);

  // ===== Load bookmark data + block library on mount =====
  useEffect(() => {
    loadBookmarkData();
    setErrorCountHandler(setErrorCount);
    // Load bookmark order from app-state
    fetch('/api/app-state').then(r => r.json()).then(state => {
      if (state.bookmarkOrder) setBookmarkOrder(state.bookmarkOrder);
    }).catch(() => {});
    fetchBlockData().then(data => {
      setBlockLibraryData(data);
      // Force re-render of existing nodes so they pick up block definitions
      const setNodesFn = getSetNodesRef();
      if (setNodesFn) setNodesFn((nds: any) => nds.map((n: any) => ({ ...n })));
    });
  }, [loadBookmarkData]);

  // ===== Restore open tabs from previous session (once) =====
  const tabsRestoredRef = useRef(false);
  useEffect(() => {
    if (tabsRestoredRef.current) return;
    tabsRestoredRef.current = true;
    fetch('/api/app-state').then(r => r.json()).then(async (state) => {
      const savedTabs: Array<{ filename: string; type: string }> = state.openTabs || [];
      if (savedTabs.length === 0) return;
      for (const st of savedTabs) {
        try {
          await openWorkspaceRef.current?.(st.filename);
        } catch { /* file may have been deleted — skip */ }
      }
      // Switch to the previously active tab
      if (state.activeTab) {
        // Need fresh tab list — read from DOM/state after all opens complete
        setTimeout(() => {
          const currentTabs = tabsRef.current;
          const matchTab = currentTabs?.find((t: any) => t.workspaceFilename === state.activeTab);
          if (matchTab) switchTabRef.current?.(matchTab.id);
        }, 100);
      }
    }).catch(() => {});
  }, []);

  // ===== Sidebar Toggle (React state) =====
  const toggleSidebar = useCallback(() => {
    setSidebarVisible(prev => {
      const next = !prev;
      localStorage.setItem('hiyocanvas-sidebar-hidden', next ? '0' : '1');
      return next;
    });
  }, []);

  // Used by useFlowPersistence to update title on file load (no-op, title shows folder name now)
  const updateTitleFilename = useCallback((_name: string | null) => {}, []);

  // Guarded destructive operations — blocked during stepping
  const steppingGuard = useCallback((fn: () => void) => {
    if (steppingRef.current) { showToast('Cannot edit during step execution — Reset first'); return; }
    fn();
  }, []);

  /** Update toolbar buttons — now a no-op (FlowToolbar handles via React props) */
  const updateToolbarButtons = useCallback((_mode: 'idle' | 'running' | 'stepping') => {
    // Toolbar button state is now managed by FlowToolbar component via executionMode prop.
    // This function is kept as a no-op because handleRunAll/handleStep/handleStopReset
    // and useStatusPolling still call it.
  }, []);

  // Backward-compatible alias used by tool command handler and status polling
  const updateRunStopButton = useCallback((isRunning: boolean) => {
    if (isRunning) {
      updateToolbarButtons('running');
    } else if (steppingRef.current) {
      updateToolbarButtons('stepping');
    } else {
      updateToolbarButtons('idle');
    }
  }, [updateToolbarButtons]);

  // ===== Flow Persistence (extracted hook) =====
  // Stays in App because it depends on App-level tab state (tabs/activeTabRef/
  // onSavedAs). Its node-touching args route through the flow wrappers so the
  // operations land on the active FlowTab. buildSaveData/restoreFlowgraph are
  // passed down to FlowTab so the registered FlowTabApi resolves to them.
  const {
    buildSaveData, restoreFlowgraph, handleSave, handleSaveAs,
  } = useFlowPersistence({
    rfInstance, setNodes: flowSetNodes, setEdges: flowSetEdges, pushHistory: flowPushHistory, subgraphStoreRef,
    flowNameRef, tabs, activeTabRef,
    updateTitleFilename, createSubgraph: flowCreateSubgraph, setSubgraphDescription: flowSetSubgraphDescription,
    tabDataRef, clearDirty,
    onSavedAs: (tabId, newTitle, newFilename) => {
      // Rebind the tab to the newly-created workspace, persist the open-tab list
      // (so a restart reopens the NEW file, not the old one), and refresh the
      // file list.
      setTabs(prev => {
        const next = prev.map(t =>
          t.id === tabId ? { ...t, title: newTitle, workspaceFilename: newFilename } : t);
        persistOpenTabs(next, tabId);
        return next;
      });
      loadBookmarkData();
    },
  });

  // Wire handleSaveRef for useTabManager dirty-check on close
  handleSaveRef.current = async () => { await handleSave(); clearDirty(); };

  // Expose save functions globally for tab-internal menus (Excalidraw MainMenu, Notes sidebar)
  (window as any).__hiyoSave = handleSave;
  (window as any).__hiyoSaveAs = handleSaveAs;

  // ===== Tool Command Handler (extracted hook) =====
  // The flow* ref-reading wrappers are defined near the top of App so that
  // useTabManager / useFlowPersistence (which run earlier) can also use them.
  const { handleToolCommand } = useToolCommandHandler({
    rfInstance, setNodes: flowSetNodes, setEdges: flowSetEdges, setRunning, setTooltips: flowSetTooltips as any,
    pushHistory: flowPushHistory, subgraphStoreRef, updateRunStopButton,
    addNodeShared: flowAddNodeShared, addEdgeShared: flowAddEdgeShared, deleteNodeShared: flowDeleteNodeShared, clearAllShared: flowClearAllShared, autoLayout: flowAutoLayout,
    createSubgraph: flowCreateSubgraph, toggleSubgraph: flowToggleSubgraph, expandSubgraph: flowExpandSubgraph, ungroupSubgraph: flowUngroupSubgraph, renameSubgraph: flowRenameSubgraph, setSubgraphDescription: flowSetSubgraphDescription,
    buildSaveData: flowBuildSaveData, restoreFlowgraph: flowRestoreFlowgraph, flowNameRef,
    tabsRef, activeTabRef, openWorkspaceRef, switchTabRef, onCloseTabRef,
    setTabs, tabDataRef,
  });

  // Register tool command handler with WebSocket module
  useEffect(() => {
    setToolCommandHandler(handleToolCommand as unknown as (msg: Record<string, unknown>) => void);
    // Notify backend that frontend is ready to handle commands.
    // Use setTimeout to ensure WebSocket connection is established first.
    const readyTimer = setTimeout(() => {
      sendWsMessage({ type: 'frontend_ready' });
    }, 500);
    return () => {
      clearTimeout(readyTimer);
      setToolCommandHandler(null as unknown as (msg: Record<string, unknown>) => void);
    };
  }, [handleToolCommand]);

  // Node execution status handlers (setNodeExecutionHandler / OutputStream /
  // StatusChange / StepReady) are registered inside FlowTab, which owns the
  // nodes state they mutate.

  // ===== Run / Stop (toggle) =====

  const handleRun = useCallback(async () => {
    try {
      await apiRun();
    } catch (e: unknown) {
      const { summary, traceback } = parseError((e as Error).message);
      consoleLog('error', summary, traceback, 'runtime');
    }
  }, []);

  const handleStop = useCallback(async () => {
    try {
      await apiStop();
    } catch (e: unknown) {
      consoleLog('error', `Stop error: ${(e as Error).message}`, '', 'runtime');
    }
  }, []);

  /** Toggle handler: Run if stopped, Stop if running */
  const handleRunStop = useCallback(() => {
    if (running) {
      handleStop();
    } else {
      handleRun();
    }
  }, [running, handleRun, handleStop]);

  /** Step execution: start stepping or advance to next */
  const handleStep = useCallback(async () => {
    try {
      if (steppingRef.current) {
        await apiStepNext();
      } else {
        await apiStepStart();
      }
    } catch (e: unknown) {
      const { summary, traceback } = parseError((e as Error).message);
      consoleLog('error', summary, traceback, 'runtime');
    }
  }, []);

  /** Stop (if running) or Reset (if stepping) */
  const handleStopReset = useCallback(async () => {
    try {
      if (running) {
        await apiStop();
      } else if (steppingRef.current) {
        await apiStepReset();
      }
    } catch (e: unknown) {
      consoleLog('error', `Stop/Reset error: ${(e as Error).message}`, '', 'runtime');
    }
  }, [running]);

  /** Run All (if idle) or Run Remaining (if stepping) */
  const handleRunAll = useCallback(async () => {
    try {
      if (steppingRef.current) {
        await apiRunRemaining();
      } else {
        await apiRun();
      }
    } catch (e: unknown) {
      const { summary, traceback } = parseError((e as Error).message);
      consoleLog('error', summary, traceback, 'runtime');
    }
  }, []);

  // ===== Status Polling (detect runtime errors/crashes) =====
  useStatusPolling({ running, setRunning, updateRunStopButton });

  // (The flowgraph-state hidden DOM element is updated inside FlowTab, which
  //  owns the nodes/edges it serializes.)

  // (Old toolbar button handlers and enable/disable logic removed —
  //  now handled by per-tab toolbar components via React props)

  // ===== Keyboard Shortcuts (extracted hook) =====
  useKeyboardShortcuts({
    undo: () => activeFlowApiRef.current?.undo(),
    redo: () => activeFlowApiRef.current?.redo(),
    copySelected: () => activeFlowApiRef.current?.copySelected(),
    pasteClipboard: () => steppingGuard(() => activeFlowApiRef.current?.pasteClipboard()),
    deleteSelected: () => steppingGuard(() => activeFlowApiRef.current?.deleteSelected()),
    handleSave, handleSaveAs,
    clearAll: () => steppingGuard(() => activeFlowApiRef.current?.clearAllShared()),
    groupSelected: () => activeFlowApiRef.current?.groupSelected(),
    ungroupSelected: () => activeFlowApiRef.current?.ungroupSelected(),
    toggleSidebar,
    handleRunAll, handleStep, handleStopReset,
    isFlowTab,
  });

  // ===== Render =====
  // The active Flow's operation surface and window._subgraphCallbacks are
  // registered by FlowTab (see FlowTab.tsx registerApi).

  // Expose active tab info for terminal panel (outside React scope)
  window._getActiveTab = () => tabs.find(t => t.id === activeTabId) || null;

  // Electron IPC: handle window close by checking dirty tabs
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    api.onWindowCloseRequested(async () => {
      // Process dirty tabs using existing rcConfirmSave dialog
      const dirtyTabs = tabsRef.current.filter(t => {
        return tabStatesRef.current.get(t.id)?.dirty;
      });
      for (const tab of dirtyTabs) {
        // Switch to tab so handleSave works on the right context
        switchTabRef.current?.(tab.id);
        await new Promise(r => setTimeout(r, 50));
        const choice = await rcConfirmSave(tab.title);
        if (choice === 'cancel') return; // abort close
        if (choice === 'save') {
          await handleSaveRef.current?.();
        }
      }
      api.confirmClose();
    });
  }, []);

  // Portal targets
  const bookmarkBarEl = document.getElementById('bookmark-bar');
  const toolbarEl = document.getElementById('toolbar');
  const taskbarEl = document.getElementById('taskbar');

  // Conditionally hide/show sidebar and toolbar based on tab type uiConfig
  const uiConfig = getTabUiConfig(activeTab?.type);

  // Sidebar visibility is now React state — managed by BlockLibrarySidebar component
  const showSidebar = uiConfig.showBlockLibrary;

  // Bookmark order save handler
  const handleBookmarkReorder = useCallback((newOrder: string[]) => {
    setBookmarkOrder(newOrder);
    fetch('/api/app-state', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookmarkOrder: newOrder }),
    }).catch(() => {});
  }, []);

  // Console toggle for taskbar error click
  const toggleConsole = useCallback(() => {
    const cp = document.getElementById('console-panel');
    if (cp) cp.classList.toggle('console-hidden');
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  }, []);

  // Dirty tabs set for taskbar
  const dirtyTabs = new Set(
    Array.from(tabStatesRef.current.entries())
      .filter(([, s]) => s.dirty)
      .map(([id]) => id)
  );

  // Toolbar: now rendered as floating components inside content area (not the top bar)
  const activeTabType = activeTab?.type ? getTabType(activeTab.type) : undefined;
  const ToolbarComponent = activeTabType?.toolbarComponent;
  // Hide the legacy #toolbar div permanently
  useEffect(() => {
    const toolbar = document.getElementById('toolbar');
    if (toolbar) toolbar.style.display = 'none';
  }, []);

  return h(Fragment, null,
    // Block Library sidebar (position: absolute inside content-area)
    showSidebar && h(BlockLibrarySidebar, {
      visible: sidebarVisible,
      onToggle: toggleSidebar,
      onAddBlock: ((blockDef: any) => activeFlowApiRef.current?.addBlockToCanvas?.(blockDef)) as any,
      blocks: blockLibraryData,
    }),

    // Dynamic toolbar (floating inside content area)
    ToolbarComponent && h(ToolbarComponent as any, {
        tabId: activeTab?.id || '',
        tab: activeTab,
        onSave: handleSave,
        onSaveAs: handleSaveAs,
        onUndo: () => activeFlowApiRef.current?.undo(),
        onRedo: () => activeFlowApiRef.current?.redo(),
        // Flow-specific props (ignored by other toolbars)
        executionMode: running ? 'running' : stepping ? 'stepping' : 'idle',
        hasMultiSelection: (activeFlowApiRef.current?.rfInstance()?.getNodes() || []).filter(n => n.selected).length >= 2,
        hasSubgraphSelected: (activeFlowApiRef.current?.rfInstance()?.getNodes() || []).filter(n => n.selected).some(n => n.type === 'subgraph'),
        onGroup: () => activeFlowApiRef.current?.groupSelected(),
        onUngroup: () => activeFlowApiRef.current?.ungroupSelected(),
        onRunAll: () => handleRunAll(),
        onStep: () => handleStep(),
        onStopReset: () => handleStopReset(),
        onAutoLayout: async () => { try { await apiAutoLayout(); } catch (e: any) { consoleLog('error', `Layout error: ${e.message}`, '', 'system'); } },
      }),

    // Bookmark bar (rendered via portal into #bookmark-bar div)
    bookmarkBarEl && createPortal(
      h(BookmarkBar, {
        rootFiles: bookmarkData.rootFiles,
        folders: bookmarkData.folders,
        onOpenFile: openWorkspace,
        onAddNew: async (type: string) => { await onAddTab(type); loadBookmarkData(); },
        onCreateFolder: async (name: string) => {
          try {
            await fetch('/api/workspaces-folder', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name }),
            });
            loadBookmarkData();
          } catch (err) { consoleLog('error', `Failed to create folder: ${err}`, '', 'file'); }
        },
        onMoveToFolder: async (filename: string, targetFolder: string) => {
          try {
            const resp = await fetch('/api/workspaces-move', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filename, targetFolder }),
            });
            if (resp.ok) {
              const data = await resp.json();
              // Update open tab's filename if it was moved
              setTabs(prev => prev.map(t =>
                t.workspaceFilename === filename
                  ? { ...t, workspaceFilename: data.filename }
                  : t
              ));
              loadBookmarkData();
            }
          } catch (err) { consoleLog('error', `Failed to move file: ${err}`, '', 'file'); }
        },
        onChangeFolder: changeFolder,
        bookmarkOrder,
        onReorder: handleBookmarkReorder,
      }),
      bookmarkBarEl
    ),

    // Bottom taskbar (rendered via portal into #taskbar div)
    taskbarEl && createPortal(
      h(BottomTaskbar, {
        tabs, activeTabId,
        onSwitch: switchTab,
        onClose: onCloseTab,
        onEdit: onEditTab,
        onReorder: reorderTabs,
        dirtyTabs,
        errorCount,
        onToggleConsole: toggleConsole,
        onAddNew: async (type: string) => { await onAddTab(type); loadBookmarkData(); },
        onCreateFolder: async (name: string) => {
          try {
            await fetch('/api/workspaces-folder', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name }),
            });
            loadBookmarkData();
          } catch (err) { consoleLog('error', `Failed to create folder: ${err}`, '', 'file'); }
        },
      }),
      taskbarEl
    ),

    // Empty state when no tabs are open
    !activeTab && h('div', { className: 'empty-state' },
      h('div', { className: 'empty-state-icon' }, '\uD83D\uDC23'),
      h('div', { className: 'empty-state-text' }, 'ブックマークバーからファイルを選択してください'),
    ),

    // Plugin tab rendering: use registered component if available
    (() => {
      if (!isFlowTab && activeTab?.type) {
        const entry = getTabType(activeTab.type);
        const PluginComponent = entry?.component;
        if (PluginComponent) {
          return h(PluginComponent, {
            tabId: activeTab.id,
            isActive: true,
            dataRef: tabDataRef,
            markDirty,
            tab: activeTab,
            key: activeTab.id,
          });
        }
      }
      return null;
    })() ||
    // Default: flow tab (owns nodes/edges + ReactFlow + tooltips + context menu)
    // Mounted with key={activeTab.id} so every tab gets its own instance: a tab
    // switch unmounts the old FlowTab and mounts a fresh one that self-restores
    // from tabStatesRef (read below). App no longer pushes state in after the
    // switch — that race was what produced the null-setNodes crash + empty
    // canvas. saveCurrentTabState() (called at switchTab top) has already
    // snapshotted the outgoing tab into tabStatesRef before this remount.
    (isFlowTab && activeTab) && (() => {
      const st = tabStatesRef.current.get(activeTab.id);
      return h(FlowTab, {
        key: activeTab.id,
        tabId: activeTab.id,
        initialNodes: st?.nodes ?? initialNodes,
        initialEdges: st?.edges ?? initialEdges,
        initialViewport: st?.viewport,
        initialSubgraphStore: st?.subgraphStore ?? {},
        initialUndoStack: st?.undoStack ?? [],
        initialRedoStack: st?.redoStack ?? [],
        rfInstance, subgraphStoreRef, skipHistoryRef, historyRef, futureRef,
        markDirty, registerApi, unregisterApi,
        buildSaveData, restoreFlowgraph,
        setRunning, setStepping, setNextStepNodeId, updateToolbarButtons,
        running, runningRef, steppingRef,
      });
    })()
  );
}

// ===== Application Bootstrap =====

// Hide loading overlay
document.getElementById('loading')!.style.display = 'none';

// Mount React app
const root = createRoot(document.getElementById('content-area')!);
root.render(h(App));

// Mount React console panel into the existing console-body element
import ConsoleBody from './components/ConsolePanel.js';
const consoleBodyEl = document.getElementById('console-body');
if (consoleBodyEl) {
  const consoleRoot = createRoot(consoleBodyEl);
  consoleRoot.render(h(ConsoleBody));
}

// Block library is now loaded via React useEffect in App component

// Connect WebSocket immediately for tool command support
// (also used for data streaming when flowgraph is running)
connectWebSocket();

// Set window title with workspace folder name
fetch('/api/workspaces-dir').then(r => r.json()).then(data => {
  if (data.path) {
    const parts = data.path.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
    document.title = `HiyoCanvas — ${parts[parts.length - 1] || 'HiyoCanvas'}`;
  }
}).catch(() => {});

// ===== Panel Initialization (extracted to dom/ modules) =====
import { initTerminalPanel } from './dom/terminalPanelInit.js';
import { initConsolePanel } from './dom/consolePanelInit.js';
initTerminalPanel();
initConsolePanel();

// Search filtering is now handled by React BlockLibrarySidebar component
