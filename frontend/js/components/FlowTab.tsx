/**
 * FlowTab.tsx — The Flow (canvas) tab, extracted from app.tsx (Step2b).
 *
 * Owns the nodes/edges state and all Flow-local hooks, callbacks, effects and
 * the ReactFlow render. App keeps the toolbar / keyboard / tool-command surface
 * and reaches the active Flow through the FlowTabApi registered via props.registerApi.
 * Behaviour is identical to the previous App-embedded implementation; this is a
 * pure relocation of ownership.
 */

import React, { useState, useCallback, useRef, useEffect, Fragment, createElement as h } from 'react';
import {
  ReactFlow, Background, Controls, MiniMap,
  useNodesState, useEdgesState,
} from '@xyflow/react';
import type { Node, Edge, NodeChange, EdgeChange } from '@xyflow/react';
import { SelectionMode } from '@xyflow/react';

import { vizDataStore, setNodeExecutionHandler, setNodeOutputStreamHandler, setStatusChangeHandler, setStepReadyHandler } from '../backend.js';
import { setNodesRef, setAddBlockCallback } from '../blockLibraryData.js';
import { CanvasNode, ContextMenu, Tooltip, HighlightRing } from '../components.js';
import { SubgraphNode } from '../subgraph.js';
import { GradientEdge } from '../edges/GradientEdge.js';
import { rcStyleEditor } from '../modal.js';
import type { StyleField } from '../modal.js';
import type { FlowTabApi, FlowTabProps } from '../types.js';
import { useUndoRedo } from '../hooks/useUndoRedo.js';
import { useClipboard } from '../hooks/useClipboard.js';
import { showToast, computeMaxNodeId } from '../utils.js';
import { resetNodeIdCounter } from '../blockLibraryData.js';
import { DELAY_RESOLVE_OVERLAPS, CANVAS_BG, CANVAS_GRID_COLOR, MINIMAP_BG, MINIMAP_NODE_COLOR, MINIMAP_MASK } from '../constants.js';
import { useSubgraphOps } from '../hooks/useSubgraphOps.js';
import { useNodeOperations } from '../hooks/useNodeOperations.js';

// ===== Node & Edge Types Registration =====
const nodeTypes = { canvasNode: CanvasNode, subgraph: SubgraphNode };
const edgeTypes = { rateEdge: GradientEdge };

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

export function FlowTab(props: FlowTabProps) {
  const {
    initialNodes, initialEdges, initialViewport,
    initialSubgraphStore, initialUndoStack, initialRedoStack,
    rfInstance, subgraphStoreRef, skipHistoryRef, historyRef, futureRef,
    markDirty, registerApi, unregisterApi, buildSaveData, restoreFlowgraph,
    setRunning, setStepping, setNextStepNodeId, updateToolbarButtons,
    running, runningRef, steppingRef,
  } = props;

  const [nodes, setNodes, onNodesChangeBase] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState(initialEdges);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [tooltips, setTooltips] = useState<TooltipEntry[]>([]);
  const flowContainer = useRef(null);

  // ===== Mount-time self-initialisation (key-remount restore) =====
  // App mounts FlowTab with key={tab.id}, so each tab switch produces a fresh
  // instance. Instead of App pushing state in after the switch (which raced the
  // mount and crashed on a null FlowTabApi), the new instance seeds the
  // App-owned shared refs from its initial* props right here — synchronously,
  // before the first paint — so undo history, subgraph store and the node-id
  // counter all match the freshly-mounted nodes/edges.
  // useState(() => …) runs exactly once per mount (not on re-renders).
  useState(() => {
    subgraphStoreRef.current = (initialSubgraphStore ?? {}) as Record<string, unknown>;
    historyRef.current = (initialUndoStack ?? []) as typeof historyRef.current;
    futureRef.current = (initialRedoStack ?? []) as typeof futureRef.current;
    // Suppress history capture until React Flow has finished applying the
    // initial nodes (mirrors the old switchTab skip-window).
    skipHistoryRef.current = true;
    resetNodeIdCounter(computeMaxNodeId(initialNodes) + 1);
    return null;
  });
  useEffect(() => {
    const raf = requestAnimationFrame(() => { skipHistoryRef.current = false; });
    return () => cancelAnimationFrame(raf);
  }, []);

  // ===== Undo/Redo (extracted hook) — uses App-owned history refs =====
  const { pushHistory, undo, redo } = useUndoRedo({
    rfInstance, setNodes, setEdges, subgraphStoreRef,
    skipHistoryRef, historyRef: historyRef as any, futureRef: futureRef as any,
  });

  // ===== Node Operations (extracted hook) =====
  const {
    addNodeShared, addEdgeShared, deleteNodeShared, deleteEdge, deleteSelected,
    clearAllShared, onConnect, onDragOver, onDrop, addBlockToCanvas,
    autoLayout, resolveOverlaps, resolveOverlapsTimerRef,
  } = useNodeOperations({
    rfInstance, setNodes, setEdges, pushHistory, skipHistoryRef,
    subgraphStoreRef, markDirty,
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

  // ===== Clipboard (extracted hook) =====
  const { copySelected, pasteClipboard, cutSelected } = useClipboard({
    rfInstance, setNodes, setEdges, pushHistory, deleteSelected, markDirty,
  });

  // ===== Subgraph Operations (extracted hook) =====
  const {
    createSubgraph, expandSubgraph, toggleSubgraph,
    ungroupSubgraph, groupSelected, ungroupSelected, renameSubgraph, setSubgraphDescription,
  } = useSubgraphOps({
    rfInstance, setNodes, setEdges, pushHistory, subgraphStoreRef, markDirty,
  });

  // Alias for backward compatibility (context menu uses deleteNode)
  const deleteNode = deleteNodeShared;

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

  // ===== Node click handler =====
  const onNodeClick = useCallback((_event: React.MouseEvent, _node: { id: string; data: Record<string, unknown> }) => {
    // No-op: available for future extension
  }, []);

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

  // Register the active Flow's operation surface (Step1 indirection).
  // Plain per-render assignment, mirroring setNodesRef / window._subgraphCallbacks above.
  // We also keep the latest api object in a ref so the unmount cleanup can
  // unregister *this* instance's api by identity — never clobbering a
  // newly-mounted FlowTab that has already registered its own api (React mounts
  // the new tab before unmounting the old one on a key change).
  const myApi: FlowTabApi = {
    rfInstance: () => rfInstance.current,
    undo, redo, groupSelected, ungroupSelected,
    copySelected, pasteClipboard, cutSelected, deleteSelected,
    clearAllShared, pushHistory,
    addNodeShared, addEdgeShared, deleteNodeShared, autoLayout,
    createSubgraph, toggleSubgraph, expandSubgraph, ungroupSubgraph,
    renameSubgraph, setSubgraphDescription,
    buildSaveData, restoreFlowgraph,
    setNodes, setEdges, setTooltips: setTooltips as any,
    addBlockToCanvas: addBlockToCanvas as any,
  } as FlowTabApi;
  registerApi(myApi);
  const myApiRef = useRef(myApi);
  myApiRef.current = myApi;
  useEffect(() => {
    return () => { unregisterApi(myApiRef.current); };
  }, []);

  return h(Fragment, null,
    h(ReactFlow, {
          ref: flowContainer,
          nodes, edges, onNodesChange, onEdgesChange, onConnect: onConnectGuarded,
          onInit: inst => { rfInstance.current = inst; window.rfInstance = inst; },
          onNodeContextMenu, onEdgeContextMenu, onSelectionContextMenu, onPaneContextMenu,
          onDragOver, onDrop,
          onNodeClick,
          nodeTypes, edgeTypes,
          // Restore the saved viewport when this tab has one; otherwise fit the
          // view. Using both fitView + defaultViewport conflicts (a known
          // black-tab cause), so pick exactly one.
          ...(initialViewport ? { defaultViewport: initialViewport } : { fitView: true }),
          deleteKeyCode: null, connectOnClick: true, minZoom: 0.05,
          selectionOnDrag: true, panOnDrag: [1, 2], selectionMode: SelectionMode.Partial,
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
