/**
 * useSubgraphOps.ts — Subgraph (node grouping) operations hook
 *
 * Handles create, expand, collapse, toggle, ungroup, rename, setDescription.
 * State setters are passed in from app.tsx to avoid circular dependencies.
 */

import { useCallback } from 'react';
import type { Node, Edge, ReactFlowInstance } from '@xyflow/react';
import { buildProxyEdges, NODE_DEFAULT_WIDTH } from '../utils.js';
import { detectExternalLinks, computeGroupCenter } from '../subgraph.js';
import { consoleLog } from '../backend.js';
import { getNextNodeId } from '../blockLibraryData.js';
import { rcPrompt } from '../modal.js';

interface SubgraphStoreEntry {
  nodes: Node[]
  edges: Edge[]
  proxyMap: Record<string, {
    proxyEdgeIds?: string[]
    originalEdges: Edge[]
  }>
}

interface UseSubgraphOpsOptions {
  rfInstance: React.MutableRefObject<ReactFlowInstance | null>;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  pushHistory: () => void;
  subgraphStoreRef: React.MutableRefObject<Record<string, unknown>>;
}

export function useSubgraphOps({
  rfInstance, setNodes, setEdges, pushHistory, subgraphStoreRef,
}: UseSubgraphOpsOptions) {

  /** Create a subgraph from selected node IDs. Returns the subgraph node ID or null. */
  const createSubgraph = useCallback((selectedNodeIds: string[], label?: string) => {
    const currentNodes = rfInstance.current?.getNodes() || [];
    const currentEdges = rfInstance.current?.getEdges() || [];
    const selectedSet = new Set(selectedNodeIds);
    const selectedNodes = currentNodes.filter(n => selectedSet.has(n.id));

    // Validate all requested node IDs exist
    const foundIds = new Set(selectedNodes.map(n => n.id));
    const missingIds = selectedNodeIds.filter(id => !foundIds.has(id));
    if (missingIds.length > 0) {
      consoleLog('error', `Node IDs not found: ${missingIds.join(', ')}`, '', 'subgraph');
      return null;
    }

    // Nest prevention
    if (selectedNodes.some(n => n.type === 'subgraph')) {
      consoleLog('warning', 'Cannot group: selection contains a subgraph. Expand it first.', '', 'subgraph');
      return null;
    }
    if (selectedNodes.length < 2) {
      consoleLog('warning', 'Select at least 2 blocks to create a group.', '', 'subgraph');
      return null;
    }

    pushHistory();
    const sgId = getNextNodeId();
    const { internalEdges, externalInputs, externalOutputs, externalEdges } = detectExternalLinks(selectedSet, currentEdges, currentNodes);

    // Build proxyMap and proxy edges
    const { proxyMap, proxyEdges } = buildProxyEdges(sgId, externalInputs, externalOutputs, currentEdges);
    const externalEdgeSet = new Set(externalEdges);
    const internalEdgeSet = new Set(internalEdges);

    // Store child nodes and internal edges
    const childNodes = structuredClone(selectedNodes);
    const childEdges = structuredClone(currentEdges.filter(e => internalEdgeSet.has(e.id)));
    subgraphStoreRef.current[sgId] = { nodes: childNodes, edges: childEdges, proxyMap };

    // Create subgraph container node at the center of selected nodes
    const center = computeGroupCenter(selectedNodes);
    const sgNode: Node = {
      id: sgId,
      type: 'subgraph',
      position: center,
      data: {
        label: label || 'Group',
        collapsed: true,
        childNodeIds: selectedNodeIds.slice(),
        externalInputs,
        externalOutputs,
        description: '',
      },
    };

    // Update React Flow: remove children + external edges, add container + proxy edges
    setNodes(nds => [
      ...nds.filter(n => !selectedSet.has(n.id)),
      sgNode,
    ]);
    setEdges(eds => [
      ...eds.filter(e => !externalEdgeSet.has(e.id) && !internalEdgeSet.has(e.id)),
      ...(proxyEdges as Edge[]),
    ]);

    return sgId;
  }, [setNodes, setEdges, pushHistory]);

  /** Expand a collapsed subgraph — restore children to React Flow */
  const expandSubgraph = useCallback((sgId: string) => {
    const entry = subgraphStoreRef.current[sgId] as SubgraphStoreEntry | null;
    if (!entry) return; // Already expanded or not a subgraph

    pushHistory();
    const restoredNodes = entry.nodes;
    const restoredEdges = entry.edges;

    // Collect all proxy edge IDs to remove
    const proxyEdgeIds = new Set<string>();
    for (const [proxyId, info] of Object.entries(entry.proxyMap)) {
      proxyEdgeIds.add(proxyId);
      if (info.proxyEdgeIds) info.proxyEdgeIds.forEach((id: string) => proxyEdgeIds.add(id));
    }

    // Collect original external edges to restore
    const restoredExtEdges: Edge[] = [];
    for (const info of Object.values(entry.proxyMap)) {
      for (const e of info.originalEdges) restoredExtEdges.push(e);
    }

    // Compute bounding box of child nodes for the expanded overlay
    const PADDING = 50;
    const HEADER_OFFSET = 40;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of restoredNodes) {
      const nAny = n as Record<string, unknown>;
      const measured = nAny.measured as Record<string, number> | undefined;
      const w = measured?.width ?? nAny.width as number ?? NODE_DEFAULT_WIDTH;
      const hh = measured?.height ?? nAny.height as number ?? 80;
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + w);
      maxY = Math.max(maxY, n.position.y + hh);
    }
    const overlayX = minX - PADDING;
    const overlayY = minY - PADDING - HEADER_OFFSET;
    const overlayW = maxX - minX + PADDING * 2;
    const overlayH = maxY - minY + PADDING * 2 + HEADER_OFFSET;

    // Convert child positions to be relative to the overlay container
    const relativeNodes = restoredNodes.map(n => ({
      ...n,
      position: {
        x: n.position.x - overlayX,
        y: n.position.y - overlayY,
      },
      parentId: sgId,
      expandParent: false,
    } as Node));

    // Clear store entry (marks as expanded)
    subgraphStoreRef.current[sgId] = null;

    // Keep subgraph container as expanded overlay, add back children as its children
    setNodes(nds => [
      ...nds.map(n => n.id === sgId ? ({
        ...n,
        position: { x: overlayX, y: overlayY },
        style: { width: overlayW, height: overlayH },
        data: { ...n.data, collapsed: false },
      } as Node) : n),
      ...relativeNodes,
    ]);
    setEdges(eds => {
      const filtered = eds.filter(e => !proxyEdgeIds.has(e.id));
      const allNew = [...filtered, ...restoredEdges, ...restoredExtEdges];
      // Deduplicate by edge ID (keep last occurrence)
      const seen = new Map<string, Edge>();
      for (const e of allNew) seen.set(e.id, e);
      return [...seen.values()];
    });

  }, [setNodes, setEdges, pushHistory]);

  /** Collapse an expanded subgraph — move children back to store */
  const collapseSubgraph = useCallback((sgId: string) => {
    const currentNodes = rfInstance.current?.getNodes() || [];
    const currentEdges = rfInstance.current?.getEdges() || [];
    const sgNode = currentNodes.find(n => n.id === sgId);
    if (!sgNode || sgNode.type !== 'subgraph') return;

    // Check which children still exist (user may have deleted some)
    const currentNodeIds = new Set(currentNodes.map(n => n.id));
    const aliveChildIds = ((sgNode.data.childNodeIds as string[] | undefined) || []).filter((id: string) => currentNodeIds.has(id));

    if (aliveChildIds.length === 0) {
      // No children left — remove the subgraph container
      pushHistory();
      delete subgraphStoreRef.current[sgId];
      setNodes(nds => nds.filter(n => n.id !== sgId));
      return;
    }

    pushHistory();
    const aliveChildSet = new Set(aliveChildIds);
    const childNodes = currentNodes.filter(n => aliveChildSet.has(n.id));

    // Convert child positions to absolute if they have parentId (expanded state)
    const sgPos = sgNode.position;
    const absoluteChildNodes = childNodes.map(n => (n as Record<string, unknown>).parentId === sgId ? {
      ...n,
      position: { x: n.position.x + sgPos.x, y: n.position.y + sgPos.y },
      parentId: undefined,
    } as Node : n);

    const { internalEdges, externalInputs, externalOutputs, externalEdges } = detectExternalLinks(aliveChildSet, currentEdges, absoluteChildNodes);

    // Build proxyMap and proxy edges
    const { proxyMap, proxyEdges } = buildProxyEdges(sgId, externalInputs, externalOutputs, currentEdges);
    const externalEdgeSet = new Set(externalEdges);
    const internalEdgeSet = new Set(internalEdges);

    // Store children with absolute positions (for later restore)
    subgraphStoreRef.current[sgId] = {
      nodes: structuredClone(absoluteChildNodes),
      edges: structuredClone(currentEdges.filter(e => internalEdgeSet.has(e.id))),
      proxyMap,
    };

    // Update subgraph node data
    const center = computeGroupCenter(absoluteChildNodes);
    const updatedSgData = {
      ...sgNode.data,
      collapsed: true,
      childNodeIds: aliveChildIds,
      externalInputs,
      externalOutputs,
    };

    setNodes(nds => [
      ...nds.filter(n => !aliveChildSet.has(n.id) && n.id !== sgId),
      { ...sgNode, position: center, style: undefined, data: updatedSgData } as Node,
    ]);
    setEdges(eds => {
      const filtered = eds.filter(e => !externalEdgeSet.has(e.id) && !internalEdgeSet.has(e.id));
      const allNew = [...filtered, ...(proxyEdges as Edge[])];
      // Remove any leftover edges referencing collapsed child nodes
      return allNew.filter(e => !aliveChildSet.has(e.source) && !aliveChildSet.has(e.target));
    });

  }, [setNodes, setEdges, pushHistory]);

  /** Toggle collapse/expand of a subgraph */
  const toggleSubgraph = useCallback((sgId: string) => {
    if (subgraphStoreRef.current[sgId]) {
      expandSubgraph(sgId);
    } else {
      collapseSubgraph(sgId);
    }
  }, [expandSubgraph, collapseSubgraph]);

  /** Permanently ungroup a subgraph */
  const ungroupSubgraph = useCallback((sgId: string) => {
    const entry = subgraphStoreRef.current[sgId];
    if (entry) {
      // Collapsed — expand first, then remove container
      expandSubgraph(sgId);
    }
    // Convert children to absolute positions and remove parentId, then remove container
    pushHistory();
    delete subgraphStoreRef.current[sgId];
    setNodes(nds => {
      const sgNode = nds.find(n => n.id === sgId);
      const sgPos = sgNode?.position || { x: 0, y: 0 };
      return nds.filter(n => n.id !== sgId).map(n =>
        (n as Record<string, unknown>).parentId === sgId ? {
          ...n,
          position: { x: n.position.x + sgPos.x, y: n.position.y + sgPos.y },
          parentId: undefined,
        } as Node : n
      );
    });
  }, [expandSubgraph, setNodes, pushHistory]);

  const groupSelected = useCallback(async () => {
    const selected = rfInstance.current?.getNodes().filter(n => n.selected) || [];
    if (selected.length >= 2) {
      const name = await rcPrompt('Group name:', 'Group', { title: 'Create Group' });
      if (name !== null) createSubgraph(selected.map(n => n.id), name);
    }
  }, [createSubgraph]);

  const ungroupSelected = useCallback(() => {
    const selected = rfInstance.current?.getNodes().filter(n => n.selected && n.type === 'subgraph') || [];
    if (selected.length > 0) ungroupSubgraph(selected[0].id);
  }, [ungroupSubgraph]);

  /** Rename a subgraph */
  const renameSubgraph = useCallback((sgId: string, newLabel: string) => {
    pushHistory();
    setNodes(nds => nds.map(n =>
      n.id === sgId ? { ...n, data: { ...n.data, label: newLabel } } : n
    ));
  }, [setNodes, pushHistory]);

  /** Set subgraph description */
  const setSubgraphDescription = useCallback((sgId: string, desc: string) => {
    pushHistory();
    setNodes(nds => nds.map(n =>
      n.id === sgId ? { ...n, data: { ...n.data, description: desc } } : n
    ));
  }, [setNodes, pushHistory]);

  return {
    createSubgraph,
    expandSubgraph,
    collapseSubgraph,
    toggleSubgraph,
    ungroupSubgraph,
    groupSelected,
    ungroupSelected,
    renameSubgraph,
    setSubgraphDescription,
  };
}
