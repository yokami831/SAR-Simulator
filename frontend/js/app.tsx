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
import React, { useState, useCallback, useRef, useEffect, Fragment, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow, Background, Controls, MiniMap,
  useNodesState, useEdgesState,
} from '@xyflow/react';
import type { Node, Edge, NodeChange, EdgeChange, ReactFlowInstance } from '@xyflow/react';
import { SelectionMode } from '@xyflow/react';

import { apiRun, apiStop, apiStatus, apiClear, apiAutoLayout, apiStepStart, apiStepNext, apiStepReset, apiRunRemaining, connectWebSocket, vizDataStore, consoleLog, setToolCommandHandler, setNodeExecutionHandler, setNodeOutputStreamHandler, setStatusChangeHandler, setStepReadyHandler, sendWsMessage, setErrorCountHandler } from './backend.js';
import { setNodesRef, setAddBlockCallback, resetNodeIdCounter, fetchBlockData, getSetNodesRef, type BlockLibraryData } from './blockLibraryData.js';
import { BlockLibrarySidebar } from './components/BlockLibrarySidebar.js';
import { CanvasNode, ContextMenu, Tooltip, HighlightRing } from './components.js';
import { SubgraphNode } from './subgraph.js';
import { GradientEdge } from './edges/GradientEdge.js';
import { rcConfirmSave, rcStyleEditor } from './modal.js';
import type { StyleField } from './modal.js';
import { BookmarkBar } from './bookmarkBar.js';
import { BottomTaskbar } from './taskbar.js';
import './mindmap.js';
import './excalidraw.js';
import './notes.js';
import './files.js';
import { createPortal } from 'react-dom';
import type { TabInstance, TabState, TabContentProps, ToolbarProps } from './types.js';
import { getTabUiConfig, getTabType, registerToolbarComponent } from './tabRegistry.js';
import { FlowToolbar } from './components/FlowToolbar.js';
import type { FlowToolbarProps } from './components/FlowToolbar.js';
import { useUndoRedo } from './hooks/useUndoRedo.js';
import { useClipboard } from './hooks/useClipboard.js';
import { parseError, showToast } from './utils.js';
import { DELAY_RESOLVE_OVERLAPS, CANVAS_BG, CANVAS_GRID_COLOR, MINIMAP_BG, MINIMAP_NODE_COLOR, MINIMAP_MASK } from './constants.js';
import { useSubgraphOps } from './hooks/useSubgraphOps.js';
import { useNodeOperations } from './hooks/useNodeOperations.js';
import { useFlowPersistence } from './hooks/useFlowPersistence.js';
import { useTabManager } from './hooks/useTabManager.js';
import { useToolCommandHandler } from './hooks/useToolCommandHandler.js';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.js';
import { useStatusPolling } from './hooks/useStatusPolling.js';

// 'flow' remains the default — too deeply integrated to wrap as a plugin tab

// ===== Register FlowToolbar =====
registerToolbarComponent('flow', FlowToolbar as any);

// ===== Node & Edge Types Registration =====
const nodeTypes = { canvasNode: CanvasNode, subgraph: SubgraphNode };
const edgeTypes = { rateEdge: GradientEdge };

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
  const [nodes, setNodes, onNodesChangeBase] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState(initialEdges);
  interface ContextMenuState {
    x: number;
    y: number;
    nodeId?: string;
    edgeId?: string;
    selectionCount?: number;
    nodeType?: string;
    collapsed?: boolean;
    nodeLabel?: string;
    nodeDescription?: string;
    barColor?: string;
  }
  interface TooltipEntry {
    nodeId: string;
    text: string;
    type: string;
    highlight?: boolean;
    requireOk?: boolean;
    _respond?: (data: Record<string, unknown>) => void;
  }
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [running, setRunning] = useState(false);
  const [stepping, setStepping] = useState(false);
  const [nextStepNodeId, setNextStepNodeId] = useState<string | null>(null);
  const runningRef = useRef(false);
  const steppingRef = useRef(false);
  const rfInstance = useRef<ReactFlowInstance | null>(null);
  const flowContainer = useRef(null);
  const flowNameRef = useRef('flowgraph');
  const [tooltips, setTooltips] = useState<TooltipEntry[]>([]);

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
  const subgraphStoreRef = useRef({});

  // ===== Undo/Redo (extracted hook) =====
  const { pushHistory, undo, redo, skipHistoryRef, historyRef, futureRef } = useUndoRedo({
    rfInstance, setNodes, setEdges, subgraphStoreRef,
  });

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
    rfInstance, setNodes, setEdges, skipHistoryRef, historyRef: historyRef as any, futureRef: futureRef as any,
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

  // ===== Node click handler =====
  const onNodeClick = useCallback((_event: React.MouseEvent, _node: { id: string; data: Record<string, unknown> }) => {
    // No-op: available for future extension
  }, []);

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

  // ===== Delete Selected (needed by clipboard hook) =====

  // ===== Node Operations (extracted hook) =====
  const {
    addNodeShared, addEdgeShared, deleteNodeShared, deleteEdge, deleteSelected,
    clearAllShared, onConnect, onDragOver, onDrop, addBlockToCanvas,
    autoLayout, resolveOverlaps, resolveOverlapsTimerRef, buildFlowgraphJson,
  } = useNodeOperations({
    rfInstance, setNodes, setEdges, pushHistory, skipHistoryRef,
    subgraphStoreRef,
  });

  // Wrap onConnect to block new connections while stepping
  const onConnectGuarded = useCallback((params: any) => {
    if (steppingRef.current) {
      showToast('Cannot edit during step execution — Reset first');
      return;
    }
    onConnect(params);
  }, [onConnect]);

  // Expose setNodes for block library and components
  setNodesRef(setNodes);

  // Expose addBlockToCanvas for sidebar double-click
  setAddBlockCallback(addBlockToCanvas as any);

  // updateWindowTitle is defined outside the component (no React state dependency)

  // Used by useFlowPersistence to update title on file load (no-op, title shows folder name now)
  const updateTitleFilename = useCallback((_name: string | null) => {}, []);

  // ===== Clipboard (extracted hook) =====
  const { copySelected, pasteClipboard, cutSelected, clipboardRef } = useClipboard({
    rfInstance, setNodes, setEdges, pushHistory, deleteSelected,
  });

  // ===== Subgraph Operations (extracted hook) =====
  const {
    createSubgraph, expandSubgraph, collapseSubgraph, toggleSubgraph,
    ungroupSubgraph, groupSelected, ungroupSelected, renameSubgraph, setSubgraphDescription,
  } = useSubgraphOps({
    rfInstance, setNodes, setEdges, pushHistory, subgraphStoreRef,
  });

  // Alias for backward compatibility (context menu uses deleteNode)
  const deleteNode = deleteNodeShared;
  const clearAll = clearAllShared;

  // Decoration style editor: invoked from ContextMenu's "Edit Style..." for
  // comment / frame nodes. Reads the node's current defaultParameters,
  // shows the per-type field set in a modal, and merges the result back.
  const onEditStyle = useCallback(async (nodeId: string) => {
    const node = (rfInstance.current?.getNodes() || []).find((n) => n.id === nodeId);
    if (!node) return;
    const data = node.data as { blockType?: string; defaultParameters?: Record<string, string> };
    const bt = data.blockType;
    const params = data.defaultParameters || {};
    // Comment is the single decoration node; with border_width > 0 it acts
    // as a labelled frame. The editor exposes both the text-style and the
    // border/background fields so users can dial it to either role.
    if (bt !== 'comment') return;
    const fields: StyleField[] = [
      { id: 'font_size', label: 'Font Size', dtype: 'enum', options: ['12', '14', '16', '20', '24', '32', '48'], default: '14' },
      { id: 'font_weight', label: 'Weight', dtype: 'enum', options: ['normal', 'bold'], default: 'normal' },
      { id: 'text_color', label: 'Text Color', dtype: 'color', default: '#e0e0e0' },
      { id: 'bg_color', label: 'Background', dtype: 'color', default: 'transparent' },
      { id: 'border_color', label: 'Border Color', dtype: 'color', default: '#5078c8' },
      { id: 'border_style', label: 'Border Style', dtype: 'enum', options: ['solid', 'dashed', 'dotted'], default: 'dashed' },
      { id: 'border_width', label: 'Border Width', dtype: 'enum', options: ['0', '1', '2', '3', '4'], default: '0' },
    ];
    const result = await rcStyleEditor(fields, params, { title: 'Comment Style' });
    if (!result) return;
    setNodes((nds) => nds.map((n) => {
      if (n.id !== nodeId) return n;
      const d = n.data as { defaultParameters?: Record<string, string> };
      return { ...n, data: { ...n.data, defaultParameters: { ...(d.defaultParameters || {}), ...result } } };
    }));
  }, [setNodes]);

  // Per-node bar color: opens a native <input type="color"> picker positioned
  // off-screen, applies the chosen color to node.data.barColor. The CSS
  // custom property --cat-color is overridden inline on the .grc-block div
  // (see RegularBlockNode), so the 6px sidebar + exec-state borders all
  // follow the new color automatically.
  const handleSetBarColor = useCallback((nodeId: string) => {
    const node = rfInstance.current?.getNode(nodeId);
    const current = (node?.data as { barColor?: string } | undefined)?.barColor || '#a855f7';
    const input = document.createElement('input');
    input.type = 'color';
    input.value = current;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';
    document.body.appendChild(input);
    const cleanup = () => {
      if (input.parentNode) input.parentNode.removeChild(input);
    };
    input.addEventListener('change', () => {
      const v = input.value;
      setNodes((nds) => nds.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, barColor: v } } : n
      ));
      cleanup();
    });
    input.addEventListener('blur', cleanup, { once: true });
    input.click();
  }, [setNodes]);

  const handleResetBarColor = useCallback((nodeId: string) => {
    setNodes((nds) => nds.map((n) => {
      if (n.id !== nodeId) return n;
      const data = n.data as Record<string, unknown>;
      const { barColor: _drop, ...rest } = data;
      void _drop;
      return { ...n, data: rest };
    }));
  }, [setNodes]);

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

  const dragSnapshotRef = useRef(false);
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Snapshot at drag START so Undo restores the pre-drag position
    const hasDragStart = changes.some((c: NodeChange) => c.type === 'position' && (c as any).dragging === true);
    const hasDragEnd = changes.some((c: NodeChange) => c.type === 'position' && (c as any).dragging === false);
    const hasRemove = changes.some((c: NodeChange) => c.type === 'remove');
    const hasAdd = changes.some((c: NodeChange) => c.type === 'add');
    if (hasDragStart && !dragSnapshotRef.current) {
      pushHistory();
      dragSnapshotRef.current = true;
    }
    if (hasDragEnd) dragSnapshotRef.current = false;
    if (hasRemove) pushHistory();

    // Block structure changes while stepping
    if (steppingRef.current && (hasRemove || hasAdd)) {
      showToast('Cannot edit during step execution — Reset first');
      changes = changes.filter((c: NodeChange) => c.type !== 'remove' && c.type !== 'add');
      if (changes.length === 0) return;
    }

    // Clean up vizDataStore for removed nodes
    if (hasRemove) {
      changes.filter((c: NodeChange) => c.type === 'remove').forEach((c: NodeChange) => delete vizDataStore[(c as any).id]);
    }

    onNodesChangeBase(changes);

    // Mark dirty for structural/position changes
    if (hasAdd || hasRemove || hasDragEnd) {
      markDirty();
    }

    // Check if any node's dimensions changed (e.g. viz canvas expanded)
    const hasDimensionChange = changes.some(
      (c: NodeChange) => c.type === 'dimensions' && (c as any).dimensions
    );
    if (hasDimensionChange && !runningRef.current && !steppingRef.current) {
      // Debounce: wait for layout to settle (multiple nodes may resize)
      // Skip during execution — output area expanding/collapsing changes node sizes
      clearTimeout(resolveOverlapsTimerRef.current);
      resolveOverlapsTimerRef.current = setTimeout(resolveOverlaps, DELAY_RESOLVE_OVERLAPS);
    }
  }, [onNodesChangeBase, resolveOverlaps, pushHistory, markDirty]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const hasRemove = changes.some((c: EdgeChange) => c.type === 'remove');
    const hasAdd = changes.some((c: EdgeChange) => c.type === 'add');
    // Block structure changes while stepping
    if (steppingRef.current && (hasRemove || hasAdd)) {
      showToast('Cannot edit during step execution — Reset first');
      changes = changes.filter((c: EdgeChange) => c.type !== 'remove' && c.type !== 'add');
      if (changes.length === 0) return;
    }
    if (hasRemove) pushHistory();
    onEdgesChangeBase(changes);
    if (hasAdd || hasRemove) markDirty();
  }, [onEdgesChangeBase, pushHistory, markDirty]);

  // ===== Tooltip Management =====
  const removeTooltip = useCallback((nodeId: string) => {
    setTooltips(prev => {
      const target = prev.find(t => t.nodeId === nodeId);
      if (target?._respond) {
        target._respond({ success: true, node_id: nodeId, action: 'ok_clicked' });
      }
      return prev.filter(t => t.nodeId !== nodeId);
    });
  }, []);

  // ===== Flow Persistence (extracted hook) =====
  const {
    buildSaveData, restoreFlowgraph, handleSave, handleSaveAs,
    fileHandleRef,
  } = useFlowPersistence({
    rfInstance, setNodes, setEdges, pushHistory, subgraphStoreRef,
    flowNameRef, tabs, activeTabRef,
    updateTitleFilename, createSubgraph, setSubgraphDescription,
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
  const { handleToolCommand } = useToolCommandHandler({
    rfInstance, setNodes, setEdges, setRunning, setTooltips: setTooltips as any,
    pushHistory, subgraphStoreRef, updateRunStopButton,
    addNodeShared, addEdgeShared, deleteNodeShared, clearAllShared, autoLayout,
    createSubgraph, toggleSubgraph, expandSubgraph, ungroupSubgraph, renameSubgraph, setSubgraphDescription,
    buildSaveData, restoreFlowgraph, flowNameRef,
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

  // Register node execution status handler (from flow_executor broadcasts)
  // Stream output buffer + throttling (100ms batches to avoid UI freeze from rapid print())
  const streamBufferRef = useRef<Record<string, string>>({});
  const streamFlushTimerRef = useRef<number | null>(null);
  const flushStreamBuffer = useCallback(() => {
    const buf = streamBufferRef.current;
    if (Object.keys(buf).length === 0) return;
    const snapshot = { ...buf };
    streamBufferRef.current = {};
    streamFlushTimerRef.current = null;
    setNodes(prev => prev.map(n => {
      const append = snapshot[n.id];
      if (!append) return n;
      const current = (n.data.executionOutput as string) || '';
      // Process \r: within each line, keep only the last \r-separated segment
      const combined = (current + append).split('\n').map(line => {
        const parts = line.split('\r');
        return parts[parts.length - 1];
      }).join('\n');
      return { ...n, data: { ...n.data, executionOutput: combined } };
    }));
  }, [setNodes]);

  useEffect(() => {
    setNodeExecutionHandler((msg: Record<string, unknown>) => {
      const nodeId = msg.node_id as string;
      const status = msg.status as string;
      if (!nodeId) return;
      // Flush any pending stream output before applying final result
      if (status === 'completed' || status === 'error') {
        if (streamFlushTimerRef.current) {
          clearTimeout(streamFlushTimerRef.current);
          streamFlushTimerRef.current = null;
        }
        // Flush remaining buffer synchronously
        const buf = streamBufferRef.current;
        streamBufferRef.current = {};
        // Apply final flush + status in one setNodes call
        setNodes(prev => prev.map(n => {
          if (n.id !== nodeId) return n;
          // Flush remaining stream buffer into executionOutput
          let output = (n.data.executionOutput as string) || '';
          const pending = buf[nodeId];
          if (pending) {
            output = (output + pending).split('\n').map(line => {
              const parts = line.split('\r');
              return parts[parts.length - 1];
            }).join('\n');
          }
          // Remove explicit height so node auto-sizes to new content
          const { height: _h, ...restStyle } = (n as any).style || {};
          const { height: _mh, ...restMeasured } = (n as any).measured || {};
          const { height: _nh, ...restNode } = n;
          return { ...restNode, style: restStyle, measured: restMeasured, data: { ...n.data, executionStatus: status, executionOutput: output, executionError: msg.error || '', executionTime: msg.execution_time || 0, executionOrder: (msg.order as number | undefined) ?? n.data.executionOrder, displayData: msg.display_data || [], resultValue: msg.result_value || '', vcdFiles: (msg.vcd_files as string[] | undefined) || n.data.vcdFiles } };
        }));
        return;
      }
      // For non-completion statuses (executing, etc.), set status and clear output
      setNodes(prev => prev.map(n => {
        if (n.id !== nodeId) return n;
        return { ...n, data: { ...n.data, executionStatus: status, executionOutput: msg.output || '', executionError: msg.error || '', executionTime: msg.execution_time || 0, executionOrder: (msg.order as number | undefined) ?? n.data.executionOrder, displayData: msg.display_data || [], resultValue: msg.result_value || '', vcdFiles: (msg.vcd_files as string[] | undefined) || n.data.vcdFiles } };
      }));
    });
    // Streaming print output handler (throttled)
    setNodeOutputStreamHandler((msg: Record<string, unknown>) => {
      const nodeId = msg.node_id as string;
      const text = msg.text as string;
      if (!nodeId || !text) return;
      streamBufferRef.current[nodeId] = (streamBufferRef.current[nodeId] || '') + text;
      if (!streamFlushTimerRef.current) {
        streamFlushTimerRef.current = window.setTimeout(flushStreamBuffer, 100);
      }
    });
    setStatusChangeHandler((msg: Record<string, unknown>) => {
      const status = msg.status as string;
      if (status === 'running') {
        setRunning(true);
        updateToolbarButtons('running');
        // Clear previous execution status from all nodes
        setNodes(prev => prev.map(n => ({ ...n, data: { ...n.data, executionStatus: undefined, executionOutput: undefined, executionError: undefined, executionTime: undefined, executionOrder: undefined, displayData: undefined, resultValue: undefined } })));
      } else if (status === 'stepping') {
        setStepping(true);
        setRunning(false);
        updateToolbarButtons('stepping');
      } else {
        // stopped or any other status → go to idle
        setRunning(false);
        setStepping(false);
        setNextStepNodeId(null);
        updateToolbarButtons('idle');
        // Clear 'next' status from all nodes
        setNodes(prev => prev.map(n => {
          if (n.data.executionStatus === 'next') {
            return { ...n, data: { ...n.data, executionStatus: undefined } };
          }
          return n;
        }));
      }
    });
    setStepReadyHandler((msg: Record<string, unknown>) => {
      const nodeId = msg.next_node_id as string;
      setStepping(true);
      setNextStepNodeId(nodeId);
      updateToolbarButtons('stepping');
      if (nodeId) {
        // Mark the next node with 'next' status, clear previous 'next'
        setNodes(prev => prev.map(n => {
          if (n.id === nodeId) {
            return { ...n, data: { ...n.data, executionStatus: 'next' } };
          }
          if (n.data.executionStatus === 'next') {
            return { ...n, data: { ...n.data, executionStatus: undefined } };
          }
          return n;
        }));
      }
    });
    return () => {
      setNodeExecutionHandler(null as unknown as (msg: Record<string, unknown>) => void);
      setNodeOutputStreamHandler(null as unknown as (msg: Record<string, unknown>) => void);
      setStatusChangeHandler(null as unknown as (msg: Record<string, unknown>) => void);
      setStepReadyHandler(null as unknown as (msg: Record<string, unknown>) => void);
      if (streamFlushTimerRef.current) clearTimeout(streamFlushTimerRef.current);
    };
  }, [setNodes, updateToolbarButtons]);

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

  // ===== Flowgraph State Element (AI agent accessibility) =====
  // Updates a hidden DOM element with current flowgraph state (debounced)
  useEffect(() => {
    const timer = setTimeout(() => {
      const stateEl = document.getElementById('flowgraph-state');
      if (!stateEl) return;
      stateEl.setAttribute('data-node-count', String(nodes.length));
      stateEl.setAttribute('data-edge-count', String(edges.length));
      stateEl.setAttribute('data-is-running', String(running));

      const stateJson = {
        nodes: nodes.map(n => ({
          id: n.id,
          blockType: n.data.blockType,
          label: n.data.label,
          category: n.data.category,
          position: n.position,
          parameters: n.data.defaultParameters || {},
          inputs: ((n.data.inputs || []) as Array<{ id: string }>).map((p: { id: string }) => p.id),
          outputs: ((n.data.outputs || []) as Array<{ id: string }>).map((p: { id: string }) => p.id),
        })),
        edges: edges.map(e => ({
          id: e.id,
          source: e.source,
          sourceHandle: e.sourceHandle,
          target: e.target,
          targetHandle: e.targetHandle,
        })),
      };
      const jsonEl = stateEl.querySelector('[data-role="flowgraph-json"]');
      if (jsonEl) jsonEl.textContent = JSON.stringify(stateJson);
    }, 300);
    return () => clearTimeout(timer);
  }, [nodes, edges, running]);

  // (Old toolbar button handlers and enable/disable logic removed —
  //  now handled by per-tab toolbar components via React props)

  // ===== Keyboard Shortcuts (extracted hook) =====
  useKeyboardShortcuts({
    undo, redo, copySelected,
    pasteClipboard: () => steppingGuard(pasteClipboard),
    deleteSelected: () => steppingGuard(deleteSelected),
    handleSave, handleSaveAs,
    clearAll: () => steppingGuard(clearAllShared),
    groupSelected, ungroupSelected, toggleSidebar,
    handleRunAll, handleStep, handleStopReset,
    isFlowTab,
  });

  // ===== Context Menu (with right-drag detection) =====
  // Track right-button mousedown position to distinguish click vs drag (pan)
  const rightMouseDownRef = useRef<{ x: number; y: number } | null>(null);
  const DRAG_THRESHOLD = 5; // pixels — beyond this, treat as drag not click

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 2) rightMouseDownRef.current = { x: e.clientX, y: e.clientY };
    };
    const onMouseUp = (e: MouseEvent) => {
      // Clear after a short delay so contextmenu handler can still read it
      if (e.button === 2) setTimeout(() => { rightMouseDownRef.current = null; }, 50);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const wasRightDrag = useCallback((e: any): boolean => {
    const start = rightMouseDownRef.current;
    if (!start) return false;
    const dx = Math.abs(e.clientX - start.x);
    const dy = Math.abs(e.clientY - start.y);
    return dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD;
  }, []);

  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node) => {
    e.preventDefault();
    if (wasRightDrag(e)) return;
    // Pass the *block* type (data.blockType) when it's a wrapped canvasNode.
    // ContextMenu uses this to decide which items to show (e.g. "Edit Style"
    // for decoration nodes vs subgraph-specific items). Falls back to the
    // React Flow type for non-wrapped nodes like 'subgraph'.
    const effectiveType = (node.data?.blockType as string | undefined) || node.type;
    setContextMenu({
      x: e.clientX, y: e.clientY, nodeId: node.id,
      nodeType: effectiveType,
      collapsed: node.data?.collapsed as boolean | undefined,
      nodeLabel: node.data?.label as string | undefined,
      nodeDescription: node.data?.description as string | undefined,
      barColor: node.data?.barColor as string | undefined,
    });
  }, [wasRightDrag]);

  const onEdgeContextMenu = useCallback((e: React.MouseEvent, edge: Edge) => {
    e.preventDefault();
    if (wasRightDrag(e)) return;
    setContextMenu({ x: e.clientX, y: e.clientY, edgeId: edge.id });
  }, [wasRightDrag]);

  const onSelectionContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    if (wasRightDrag(e)) return;
    const selected = (rfInstance.current?.getNodes() || []).filter((n: Node) => n.selected);
    if (selected.length >= 2) {
      setContextMenu({ x: e.clientX, y: e.clientY, selectionCount: selected.length });
    }
  }, [wasRightDrag]);

  const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    // No useful actions on empty canvas — always suppress
  }, []);

  // ===== Render =====
  // Expose subgraph callbacks on window so SubgraphNode can access them
  // without injecting functions into node.data (which breaks structuredClone in pushHistory)
  window._subgraphCallbacks = { onToggle: toggleSubgraph, onUngroup: ungroupSubgraph, onSetDescription: setSubgraphDescription };

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
      onAddBlock: addBlockToCanvas as any,
      blocks: blockLibraryData,
    }),

    // Dynamic toolbar (floating inside content area)
    ToolbarComponent && h(ToolbarComponent as any, {
        tabId: activeTab?.id || '',
        tab: activeTab,
        onSave: handleSave,
        onSaveAs: handleSaveAs,
        onUndo: undo,
        onRedo: redo,
        // Flow-specific props (ignored by other toolbars)
        executionMode: running ? 'running' : stepping ? 'stepping' : 'idle',
        hasMultiSelection: nodes.filter(n => n.selected).length >= 2,
        hasSubgraphSelected: nodes.filter(n => n.selected).some(n => n.type === 'subgraph'),
        onGroup: () => groupSelected(),
        onUngroup: () => ungroupSelected(),
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
    // Default: flow tab with ReactFlow
    isFlowTab && h(ReactFlow, {
          ref: flowContainer,
          nodes, edges, onNodesChange, onEdgesChange, onConnect: onConnectGuarded,
          onInit: inst => { rfInstance.current = inst; window.rfInstance = inst; },
          onNodeContextMenu, onEdgeContextMenu, onSelectionContextMenu, onPaneContextMenu,
          onDragOver, onDrop,
          onNodeClick,
          nodeTypes, edgeTypes, fitView: true, deleteKeyCode: null, connectOnClick: true, minZoom: 0.05,
          selectionOnDrag: isFlowTab, panOnDrag: [1, 2], selectionMode: SelectionMode.Partial,
          style: { background: CANVAS_BG },
          defaultEdgeOptions: { type: 'rateEdge' },
          nodesDraggable: true,
          nodesConnectable: true,
          elementsSelectable: true,
          elevateNodesOnSelect: true,  // clicked/selected node rises above overlapping ones
        },
          h(Background, { color: CANVAS_GRID_COLOR, gap: 20, size: 1 }),
          h(Controls, null),
          h(MiniMap, { nodeColor: MINIMAP_NODE_COLOR, maskColor: MINIMAP_MASK, style: { background: MINIMAP_BG }, pannable: true, zoomable: true })
        ),
    ...tooltips.map((t, i) => {
      const sameNodeIndex = tooltips.slice(0, i).filter(tt => tt.nodeId === t.nodeId).length;
      return h(Fragment, { key: 'tt_' + t.nodeId },
        t.highlight && h(HighlightRing, { nodeId: t.nodeId }),
        h(Tooltip, { nodeId: t.nodeId, text: t.text, type: t.type,
          onClose: () => removeTooltip(t.nodeId),
          requireOk: t.requireOk,
          onOk: () => removeTooltip(t.nodeId),
          index: sameNodeIndex }),
      );
    }),
    contextMenu && h(ContextMenu, {
      ...contextMenu,
      onClose: () => setContextMenu(null),
      onDelete: deleteNode,
      onDeleteEdge: deleteEdge,
      onToggleCollapse: toggleSubgraph,
      onUngroup: ungroupSubgraph,
      onRename: renameSubgraph,
      onSetDescription: setSubgraphDescription,
      onCreateSubgraph: createSubgraph,
      onEditStyle,
      onSetBarColor: handleSetBarColor,
      onResetBarColor: handleResetBarColor,
    })
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
