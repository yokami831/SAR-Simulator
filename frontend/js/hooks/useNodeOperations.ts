/**
 * useNodeOperations.ts — Node and edge CRUD operations hook
 *
 * Consolidates duplicated logic for add/delete/clear operations
 * that previously existed separately for UI and AI tool paths.
 */

import { useCallback, useRef } from 'react';
import type { Node, Edge, ReactFlowInstance } from '@xyflow/react';
import { addEdge } from '@xyflow/react';
import { findFreePosition, getPortType, NODE_DEFAULT_WIDTH, NODE_DEFAULT_HEIGHT, GRID_SIZE, LAYOUT_H_GAP, LAYOUT_V_GAP, FIT_VIEW_PADDING, LAYOUT_CENTER_Y } from '../utils.js';
import { vizDataStore } from '../backend.js';
import { getNextNodeId, resetNodeIdCounter, createNode, getBlockDataForNode, setAddBlockCallback } from '../blockLibraryData.js';
import type { BlockData } from '../blockLibraryData.js';
import type { BlockDefinition } from '../types.js';
import { flattenSubgraphs } from '../subgraph.js';

interface UseNodeOperationsOptions {
  rfInstance: React.MutableRefObject<ReactFlowInstance | null>;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  pushHistory: () => void;
  skipHistoryRef: React.MutableRefObject<boolean>;
  subgraphStoreRef: React.MutableRefObject<Record<string, unknown>>;
}

export function useNodeOperations({
  rfInstance, setNodes, setEdges, pushHistory, skipHistoryRef,
  subgraphStoreRef,
}: UseNodeOperationsOptions) {

  const resolveOverlapsTimerRef = useRef<any>(null);

  // ===== Shared: Compute viewport center position =====
  function getViewportCenter(): { x: number; y: number } {
    let baseX = 300, baseY = 200;
    const viewport = rfInstance.current?.getViewport();
    const container = document.getElementById('content-area');
    if (viewport && container) {
      const rect = container.getBoundingClientRect();
      const flowPos = rfInstance.current!.screenToFlowPosition({
        x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
      });
      baseX = flowPos.x;
      baseY = flowPos.y;
    }
    return { x: baseX, y: baseY };
  }

  // ===== Add Node (unified: sidebar double-click, D&D, AI tool) =====
  /**
   * @param blockDef - Block definition object (from library or getBlockDataForNode)
   * @param position - Optional explicit position. If omitted, auto-places near viewport center.
   * @param paramOverrides - Optional parameter overrides (from AI tool).
   * @returns The new node ID.
   */
  const addNodeShared = useCallback((
    blockDef: BlockData,
    position?: { x: number; y: number },
    paramOverrides?: Record<string, string>,
  ): string => {
    pushHistory();
    const currentNodes = rfInstance.current?.getNodes() || [];
    if (!position) {
      const center = getViewportCenter();
      position = findFreePosition(currentNodes, center.x, center.y);
    }
    const nodeId = getNextNodeId();
    const newNode = createNode({
      id: nodeId, position, blockDef,
      paramOverrides,
    });
    setNodes(nds => [...nds, newNode]);
    return nodeId;
  }, [setNodes, pushHistory]);

  // ===== Add Edge (unified: UI onConnect, AI tool) =====
  const addEdgeShared = useCallback((
    source: string, sourceHandle: string,
    target: string, targetHandle: string,
  ): string => {
    // Check for duplicate edge (same source+sourceHandle+target+targetHandle)
    const currentEdges = rfInstance.current?.getEdges() || [];
    const existing = currentEdges.find(e =>
      e.source === source && e.sourceHandle === sourceHandle &&
      e.target === target && e.targetHandle === targetHandle
    );
    if (existing) return existing.id;

    pushHistory();
    const currentNodes = rfInstance.current?.getNodes() || [];
    const srcType = getPortType(currentNodes, source, sourceHandle);
    const tgtType = getPortType(currentNodes, target, targetHandle);
    const edgeId = `e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setEdges(eds => [...eds, {
      id: edgeId,
      source, sourceHandle,
      target, targetHandle,
    }]);
    return edgeId;
  }, [setEdges, pushHistory]);

  // ===== Delete Node (unified: UI context menu, AI tool) =====
  /** Fixes AI-side bug: now always cleans up vizDataStore + subgraphStore */
  const deleteNodeShared = useCallback((nodeId: string) => {
    pushHistory();
    if (subgraphStoreRef.current[nodeId]) {
      delete subgraphStoreRef.current[nodeId];
    }
    setNodes(nds => nds.filter(n => n.id !== nodeId));
    setEdges(eds => eds.filter(e => e.source !== nodeId && e.target !== nodeId));
    delete vizDataStore[nodeId];
  }, [setNodes, setEdges, pushHistory]);

  // ===== Delete Edge =====
  const deleteEdge = useCallback((edgeId: string) => {
    pushHistory();
    setEdges(eds => eds.filter(e => e.id !== edgeId));
  }, [setEdges, pushHistory]);

  // ===== Delete Selected =====
  const deleteSelected = useCallback(() => {
    pushHistory();
    skipHistoryRef.current = true;
    const currentNodes = rfInstance.current?.getNodes() || [];
    const selectedIds = new Set(currentNodes.filter(n => n.selected).map(n => n.id));
    selectedIds.forEach(id => {
      delete vizDataStore[id];
      if (subgraphStoreRef.current[id]) delete subgraphStoreRef.current[id];
    });
    setNodes(nds => nds.filter(n => !n.selected));
    setEdges(eds => eds.filter(e =>
      !e.selected && !selectedIds.has(e.source) && !selectedIds.has(e.target)
    ));
    requestAnimationFrame(() => { skipHistoryRef.current = false; });
  }, [setNodes, setEdges, pushHistory]);

  // ===== Clear All (unified: UI + AI tool) =====
  /** Always includes resetNodeIdCounter(100) — fixes previous inconsistency */
  const clearAllShared = useCallback(() => {
    pushHistory();
    setNodes([]);
    setEdges([]);
    subgraphStoreRef.current = {};
    resetNodeIdCounter(100);
  }, [setNodes, setEdges, pushHistory]);

  // ===== Edge Connection (UI onConnect callback) =====
  // Uses @xyflow/react's addEdge() for duplicate prevention (unlike addEdgeShared)
  const onConnect = useCallback((params: { source: string; sourceHandle: string; target: string; targetHandle: string }) => {
    pushHistory();
    const currentNodes = rfInstance.current?.getNodes() || [];
    const srcType = getPortType(currentNodes, params.source, params.sourceHandle);
    const tgtType = getPortType(currentNodes, params.target, params.targetHandle);
    setEdges(eds => addEdge({
      ...params,
    }, eds));
  }, [setEdges, pushHistory]);

  // ===== Drag & Drop from Sidebar =====
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/blocktype');
    if (!raw || !rfInstance.current) return;
    const blockDef = JSON.parse(raw);
    const position = rfInstance.current.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addNodeShared(blockDef, position);
  }, [addNodeShared]);

  // ===== Sidebar double-click handler =====
  const addBlockToCanvas = useCallback((blockDef: BlockData) => {
    const nodeId = addNodeShared(blockDef);
    // Temporarily mark the new node as just-added for AI identification
    setTimeout(() => {
      const el = document.querySelector(`[data-node-id="${nodeId}"]`);
      if (el) {
        el.setAttribute('data-just-added', 'true');
        setTimeout(() => el.removeAttribute('data-just-added'), 3000);
      }
    }, 100);
  }, [addNodeShared]);

  // ===== Auto Layout (Topological Sort) =====
  const autoLayout = useCallback(() => {
    pushHistory();
    setNodes(currentNodes => {
      const currentEdges = rfInstance.current?.getEdges() || [];

      // Exclude portless nodes (e.g. comment blocks) — keep their position
      const layoutNodes = currentNodes.filter(n => {
        const inputs = (n.data?.inputs as unknown[]) || [];
        const outputs = (n.data?.outputs as unknown[]) || [];
        return inputs.length > 0 || outputs.length > 0;
      });

      // Build adjacency info for topological layering
      const inDegree = new Map<string, number>();
      const children = new Map<string, string[]>();
      layoutNodes.forEach(n => { inDegree.set(n.id, 0); children.set(n.id, []); });
      currentEdges.forEach(e => {
        inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
        (children.get(e.source) || []).push(e.target);
      });
      const layers: string[][] = [];
      const visited = new Set<string>();
      let queue = layoutNodes.filter(n => inDegree.get(n.id) === 0).map(n => n.id);
      if (queue.length === 0 && layoutNodes.length > 0) queue = [layoutNodes[0].id];
      while (queue.length > 0) {
        layers.push([...queue]);
        queue.forEach(id => visited.add(id));
        const next = new Set<string>();
        queue.forEach(id => (children.get(id) || []).forEach(c => { if (!visited.has(c)) next.add(c); }));
        queue = [...next];
        if (queue.length === 0) {
          const rem = layoutNodes.find(n => !visited.has(n.id));
          if (rem) queue = [rem.id];
        }
      }

      const nodeMap = new Map(currentNodes.map(n => [n.id, n]));
      const getNodeWidth = (n: Node): number => {
        const measured = (n as Record<string, unknown>).measured as Record<string, number> | undefined;
        return measured?.width || (n as Record<string, unknown>).width as number || parseFloat(String((n.style as Record<string, unknown>)?.width)) || NODE_DEFAULT_WIDTH;
      };
      const getNodeHeight = (n: Node): number => {
        const measured = (n as Record<string, unknown>).measured as Record<string, number> | undefined;
        return measured?.height || (n as Record<string, unknown>).height as number || NODE_DEFAULT_HEIGHT;
      };
      const layerX: number[] = [];
      const layerWidths: number[] = [];

      for (let li = 0; li < layers.length; li++) {
        const maxW = Math.max(...layers[li].map(id => {
          const n = nodeMap.get(id);
          return n ? getNodeWidth(n) : NODE_DEFAULT_WIDTH;
        }));
        layerWidths.push(maxW);
        layerX.push(li === 0 ? GRID_SIZE : layerX[li - 1] + layerWidths[li - 1] + LAYOUT_H_GAP);
      }

      let result = [...currentNodes];

      for (let li = 0; li < layers.length; li++) {
        const layerNodes = layers[li].map(id => nodeMap.get(id)).filter((n): n is Node => !!n);
        const heights = layerNodes.map(n => getNodeHeight(n));
        const totalH = heights.reduce((sum, h) => sum + h, 0) + LAYOUT_V_GAP * (heights.length - 1);
        const midY = LAYOUT_CENTER_Y;
        let curY = midY - totalH / 2;

        for (let pi = 0; pi < layerNodes.length; pi++) {
          const n = layerNodes[pi];
          const nw = getNodeWidth(n);
          const nodeX = layerX[li] + (layerWidths[li] - nw) / 2;
          const idx = result.findIndex(r => r.id === n.id);
          if (idx !== -1) {
            result[idx] = { ...result[idx], position: { x: nodeX, y: curY } };
          }
          curY += heights[pi] + LAYOUT_V_GAP;
        }
      }

      // Safety pass: resolve vertical overlaps
      for (const layer of layers) {
        const layerNodes = layer.map(id => result.find(n => n.id === id)).filter((n): n is Node => !!n)
          .sort((a: Node, b: Node) => a.position.y - b.position.y);
        for (let i = 1; i < layerNodes.length; i++) {
          const prev = layerNodes[i - 1];
          const curr = layerNodes[i];
          const prevH = ((prev as Record<string, unknown>).measured as Record<string, number> | undefined)?.height ?? (prev as Record<string, unknown>).height as number | undefined;
          if (prevH == null) continue;
          const minY = prev.position.y + prevH + LAYOUT_V_GAP;
          if (curr.position.y < minY) {
            curr.position = { ...curr.position, y: minY };
          }
        }
      }

      setTimeout(() => rfInstance.current?.fitView({ padding: FIT_VIEW_PADDING }), 50);
      return result;
    });
  }, [setNodes, pushHistory]);

  // ===== Overlap Resolution on Node Resize =====
  const resolveOverlaps = useCallback(() => {
    setNodes(currentNodes => {
      const LAYOUT_V_GAP = 30;
      // Comment nodes are deliberately overlap-friendly: they live behind /
      // around real blocks (especially when border_width > 0 makes one act
      // as a frame). Excluding them here means resizing a comment never
      // displaces the blocks sitting on top of it.
      const isDecoration = (n: Node) => {
        const bt = (n.data as { blockType?: string } | undefined)?.blockType;
        return bt === 'comment';
      };
      const physicalNodes = currentNodes.filter(n =>
        !(n.type === 'subgraph' && n.data?.collapsed === false)
        && !(n as Record<string, unknown>).parentId
        && !isDecoration(n));
      const columns = new Map();
      for (const n of physicalNodes) {
        const colKey = Math.round(n.position.x / 100) * 100;
        if (!columns.has(colKey)) columns.set(colKey, []);
        columns.get(colKey).push(n);
      }

      let changed = false;
      const result = currentNodes.map(n => ({ ...n, position: { ...n.position } }));

      for (const [, colNodes] of columns) {
        if (colNodes.length < 2) continue;
        const sorted = colNodes.map((n: Node) => result.find(r => r.id === n.id)).filter((n: Node | undefined): n is Node => !!n)
          .sort((a: Node, b: Node) => a.position.y - b.position.y);
        for (let i = 1; i < sorted.length; i++) {
          const prev = sorted[i - 1];
          const curr = sorted[i];
          const prevH = ((prev as Record<string, unknown>).measured as Record<string, number> | undefined)?.height ?? (prev as Record<string, unknown>).height as number ?? NODE_DEFAULT_HEIGHT;
          const minY = prev.position.y + prevH + LAYOUT_V_GAP;
          if (curr.position.y < minY) {
            curr.position.y = minY;
            changed = true;
          }
        }
      }
      return changed ? result : currentNodes;
    });
  }, [setNodes]);

  // ===== Flowgraph JSON for execution =====
  const buildFlowgraphJson = useCallback(() => {
    const currentNodes = rfInstance.current?.getNodes() || [];
    const currentEdges = rfInstance.current?.getEdges() || [];
    const { nodes: flatNodes, edges: flatEdges } = flattenSubgraphs(currentNodes, currentEdges, subgraphStoreRef.current as Record<string, never>);
    const apiNodes = flatNodes.filter(n => n.type !== 'subgraph').map(n => {
      const d = n.data as Record<string, unknown>;
      return {
        id: n.id,
        type: (d.blockType as string) || (d.label as string),
        position: { x: n.position.x, y: n.position.y },
        parameters: (d.defaultParameters as Record<string, string>) || {},
      };
    });
    const apiEdges = flatEdges.map(e => ({
      source: e.source,
      sourcePort: e.sourceHandle || 'out_0',
      target: e.target,
      targetPort: e.targetHandle || 'in_0',
    }));
    return { nodes: apiNodes, edges: apiEdges };
  }, []);

  return {
    addNodeShared,
    addEdgeShared,
    deleteNodeShared,
    deleteEdge,
    deleteSelected,
    clearAllShared,
    onConnect,
    onDragOver,
    onDrop,
    addBlockToCanvas,
    autoLayout,
    resolveOverlaps,
    resolveOverlapsTimerRef,
    buildFlowgraphJson,
  };
}
