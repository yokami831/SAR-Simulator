/**
 * subgraph.tsx - Subgraph (node grouping/hierarchy) logic
 *
 * Separate Store architecture: collapsed child nodes/edges are removed from
 * React Flow and stored in subgraphStoreRef. React Flow always contains only
 * visible nodes. This eliminates the need to filter hidden nodes anywhere.
 *
 * Exports:
 * - detectExternalLinks(selectedNodeIds, allEdges, allNodes)
 * - computeGroupCenter(nodes)
 * - flattenSubgraphs(rfNodes, rfEdges, store)
 * - SubgraphNode (React component for collapsed state)
 */

import { useCallback, memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { Node, Edge } from '@xyflow/react';
import { rcPrompt } from './modal.js';
import { NODE_DEFAULT_WIDTH, NODE_COMPACT_HEIGHT, NODE_MIN_WIDTH } from './utils.js';
import { SUBGRAPH_BG, SUBGRAPH_ACCENT } from './constants.js';

// ===== Types =====

interface Connection {
  nodeId: string
  handleId: string
  edgeId: string
}

interface ExternalPort {
  handleId: string
  innerConnections: Connection[]
  originalEdgeIds: string[]
  label: string
  type: string
  innerSourceNodeId?: string
  innerSourceHandleId?: string
}

interface SubgraphStoreEntry {
  nodes: Node[]
  edges: Edge[]
  proxyMap?: Record<string, {
    proxyEdgeIds?: string[]
    originalEdges: Edge[]
  }>
}

interface SubgraphNodeData {
  label: string
  description?: string
  collapsed?: boolean
  childNodeIds?: string[]
  externalInputs?: ExternalPort[]
  externalOutputs?: ExternalPort[]
  [key: string]: unknown
}

// ===== External Link Detection =====

export function detectExternalLinks(selectedNodeIds: Set<string>, allEdges: Edge[], allNodes?: Node[]) {
  const nodeYMap = new Map<string, number>();
  if (allNodes) {
    for (const n of allNodes) nodeYMap.set(n.id, n.position.y);
  }

  const internalEdges: string[] = [];
  const externalEdges: string[] = [];

  const inputMap = new Map<string, { externalSource: string; edgeIds: string[]; connections: Connection[] }>();
  const outputMap = new Map<string, { innerSourceNodeId: string; innerSourceHandleId: string; edgeIds: string[]; connections: Connection[] }>();

  for (const edge of allEdges) {
    const sourceInside = selectedNodeIds.has(edge.source);
    const targetInside = selectedNodeIds.has(edge.target);

    if (sourceInside && targetInside) {
      internalEdges.push(edge.id);
    } else if (sourceInside && !targetInside) {
      externalEdges.push(edge.id);
      const key = `${edge.source}::${edge.sourceHandle || 'out_0'}`;
      const existing = outputMap.get(key);
      if (existing) {
        existing.edgeIds.push(edge.id);
        existing.connections.push({
          nodeId: edge.target,
          handleId: edge.targetHandle || 'in_0',
          edgeId: edge.id,
        });
      } else {
        outputMap.set(key, {
          innerSourceNodeId: edge.source,
          innerSourceHandleId: edge.sourceHandle || 'out_0',
          edgeIds: [edge.id],
          connections: [{
            nodeId: edge.target,
            handleId: edge.targetHandle || 'in_0',
            edgeId: edge.id,
          }],
        });
      }
    } else if (!sourceInside && targetInside) {
      externalEdges.push(edge.id);
      const key = `${edge.source}::${edge.sourceHandle || 'out_0'}`;
      const existing = inputMap.get(key);
      if (existing) {
        existing.edgeIds.push(edge.id);
        existing.connections.push({
          nodeId: edge.target,
          handleId: edge.targetHandle || 'in_0',
          edgeId: edge.id,
        });
      } else {
        inputMap.set(key, {
          externalSource: edge.source,
          edgeIds: [edge.id],
          connections: [{
            nodeId: edge.target,
            handleId: edge.targetHandle || 'in_0',
            edgeId: edge.id,
          }],
        });
      }
    }
  }

  const minY = (connections: Connection[]): number => {
    let min = Infinity;
    for (const c of connections) {
      const y = nodeYMap.get(c.nodeId) ?? 0;
      if (y < min) min = y;
    }
    return min;
  };

  const inputEntries = [...inputMap.values()].sort((a, b) => minY(a.connections) - minY(b.connections));
  const externalInputs: ExternalPort[] = inputEntries.map((entry, i) => ({
    handleId: `subgraph_in_${i}`,
    innerConnections: entry.connections,
    originalEdgeIds: entry.edgeIds,
    label: `in_${i}`,
    type: 'target',
  }));

  const outputEntries = [...outputMap.values()].sort((a, b) => {
    const ay = nodeYMap.get(a.innerSourceNodeId) ?? 0;
    const by = nodeYMap.get(b.innerSourceNodeId) ?? 0;
    return ay - by;
  });
  const externalOutputs: ExternalPort[] = outputEntries.map((entry, i) => ({
    handleId: `subgraph_out_${i}`,
    innerConnections: entry.connections,
    innerSourceNodeId: entry.innerSourceNodeId,
    innerSourceHandleId: entry.innerSourceHandleId,
    originalEdgeIds: entry.edgeIds,
    label: `out_${i}`,
    type: 'source',
  }));

  return { internalEdges, externalInputs, externalOutputs, externalEdges };
}

// ===== Layout Helpers =====

export function computeGroupCenter(nodes: Node[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 0, y: 0 };
  let sumX = 0, sumY = 0;
  for (const n of nodes) {
    const w = n.measured?.width ?? n.width ?? NODE_DEFAULT_WIDTH;
    const nodeH = n.measured?.height ?? n.height ?? NODE_COMPACT_HEIGHT;
    sumX += n.position.x + w / 2;
    sumY += n.position.y + nodeH / 2;
  }
  return {
    x: sumX / nodes.length - NODE_DEFAULT_WIDTH / 2,
    y: sumY / nodes.length - NODE_COMPACT_HEIGHT / 2,
  };
}

// ===== Flatten Subgraphs (Pure Function) =====

export function flattenSubgraphs(rfNodes: Node[], rfEdges: Edge[], store: Record<string, SubgraphStoreEntry>) {
  const subgraphIds = new Set<string>();
  for (const n of rfNodes) {
    if (n.type === 'subgraph' && store[n.id]) subgraphIds.add(n.id);
  }

  const allSubgraphNodeIds = new Set<string>();
  for (const n of rfNodes) {
    if (n.type === 'subgraph') allSubgraphNodeIds.add(n.id);
  }

  const parentPosMap = new Map<string, { x: number; y: number }>();
  for (const n of rfNodes) {
    if (allSubgraphNodeIds.has(n.id)) parentPosMap.set(n.id, n.position);
  }

  const absoluteNodes = allSubgraphNodeIds.size > 0 ? rfNodes.map(n => {
    if (n.parentId && parentPosMap.has(n.parentId)) {
      const pp = parentPosMap.get(n.parentId)!;
      return { ...n, position: { x: n.position.x + pp.x, y: n.position.y + pp.y }, parentId: undefined };
    }
    return n;
  }) : rfNodes;

  if (subgraphIds.size === 0) {
    if (allSubgraphNodeIds.size === 0) return { nodes: rfNodes, edges: rfEdges, edgeIdMap: {} as Record<string, string> };
    const fNodes = absoluteNodes.filter(n => !allSubgraphNodeIds.has(n.id));
    const fNodeIds = new Set(fNodes.map(n => n.id));
    return {
      nodes: fNodes,
      edges: rfEdges.filter(e => fNodeIds.has(e.source) && fNodeIds.has(e.target)),
      edgeIdMap: {} as Record<string, string>,
    };
  }

  const resultNodes: Node[] = [];
  const resultEdges: Edge[] = [];
  const edgeIdMap: Record<string, string> = {};

  for (const n of absoluteNodes) {
    if (!subgraphIds.has(n.id) && !allSubgraphNodeIds.has(n.id)) {
      resultNodes.push(n);
    }
  }

  for (const sgId of subgraphIds) {
    const entry = store[sgId];
    if (!entry) continue;
    for (const n of entry.nodes) resultNodes.push(n);
    for (const e of entry.edges) resultEdges.push(e);
  }

  const proxyEdgeIds = new Set<string>();
  for (const sgId of subgraphIds) {
    const entry = store[sgId];
    if (!entry?.proxyMap) continue;
    for (const [proxyId, info] of Object.entries(entry.proxyMap)) {
      proxyEdgeIds.add(proxyId);
      if (info.proxyEdgeIds) {
        for (const id of info.proxyEdgeIds) proxyEdgeIds.add(id);
      }
      for (const origEdge of info.originalEdges) {
        resultEdges.push(origEdge);
        edgeIdMap[origEdge.id] = proxyId;
      }
    }
  }

  for (const e of rfEdges) {
    if (!proxyEdgeIds.has(e.id) && !allSubgraphNodeIds.has(e.source) && !allSubgraphNodeIds.has(e.target)) {
      resultEdges.push(e);
    }
  }

  const nodeIdSet = new Set(resultNodes.map(n => n.id));
  const cleanEdges = resultEdges.filter(e => nodeIdSet.has(e.source) && nodeIdSet.has(e.target));

  return { nodes: resultNodes, edges: cleanEdges, edgeIdMap };
}

// ===== SubgraphNode Component (Collapsed State) =====

const HEADER_HEIGHT = 28;
const INFO_HEIGHT = 24;
const PORT_ROW_HEIGHT = 18;
const PORT_PADDING_TOP = 8;

function SubgraphNodeInner({ id, data }: { id: string; data: SubgraphNodeData }) {
  const d = data;

  const handleToggle = useCallback(() => {
    window._subgraphCallbacks?.onToggle?.(id);
  }, [id]);

  const handleUngroup = useCallback(() => {
    window._subgraphCallbacks?.onUngroup?.(id);
  }, [id]);

  const handleEditDescription = useCallback(async () => {
    const desc = await rcPrompt('Description:', d.description || '', { title: 'Edit Description' });
    if (desc !== null) window._subgraphCallbacks?.onSetDescription?.(id, desc);
  }, [id, d.description]);

  if (d.collapsed) {
    const maxPorts = Math.max(
      (d.externalInputs || []).length,
      (d.externalOutputs || []).length,
      1
    );
    const portSectionStart = HEADER_HEIGHT + INFO_HEIGHT + PORT_PADDING_TOP;

    return (
      <div
        data-node-id={id}
        data-role="canvas-node"
        style={{
          background: SUBGRAPH_BG,
          border: `2px solid ${SUBGRAPH_ACCENT}`,
          borderRadius: 8,
          minWidth: NODE_MIN_WIDTH,
          color: '#eee',
          fontSize: 13,
        }}
      >
        {/* Header */}
        <div
          style={{
            background: SUBGRAPH_ACCENT,
            padding: '4px 10px',
            borderRadius: '6px 6px 0 0',
            fontWeight: 600,
            cursor: 'pointer',
            height: HEADER_HEIGHT,
            display: 'flex',
            alignItems: 'center',
          }}
          onClick={handleToggle}
        >
          <span>{'\u25B6 '}{d.label}</span>
        </div>

        {/* Info row */}
        <div
          style={{ padding: '4px 10px', opacity: 0.7, fontSize: 11, height: INFO_HEIGHT, cursor: 'pointer' }}
          onDoubleClick={handleEditDescription}
        >
          {d.description || `(${(d.childNodeIds || []).length} nodes)`}
        </div>

        {/* Port rows */}
        <div style={{ padding: '0 10px 8px' }}>
          {Array.from({ length: maxPorts }).map((_, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                height: PORT_ROW_HEIGHT,
                alignItems: 'center',
              }}
            >
              <span style={{ fontSize: 11, opacity: 0.8 }}>
                {(d.externalInputs || [])[i] ? `\u25CB ${d.externalInputs![i].label}` : ''}
              </span>
              <span style={{ fontSize: 11, opacity: 0.8 }}>
                {(d.externalOutputs || [])[i] ? `${d.externalOutputs![i].label} \u25CB` : ''}
              </span>
            </div>
          ))}
        </div>

        {/* Input Handles */}
        {(d.externalInputs || []).map((p, i) => (
          <Handle
            key={p.handleId}
            type="target"
            position={Position.Left}
            id={p.handleId}
            style={{
              background: SUBGRAPH_ACCENT,
              top: portSectionStart + i * PORT_ROW_HEIGHT + PORT_ROW_HEIGHT / 2,
            }}
          />
        ))}

        {/* Output Handles */}
        {(d.externalOutputs || []).map((p, i) => (
          <Handle
            key={p.handleId}
            type="source"
            position={Position.Right}
            id={p.handleId}
            style={{
              background: SUBGRAPH_ACCENT,
              top: portSectionStart + i * PORT_ROW_HEIGHT + PORT_ROW_HEIGHT / 2,
            }}
          />
        ))}
      </div>
    );
  }

  // Expanded state — dashed overlay
  return (
    <div
      data-node-id={id}
      data-role="canvas-node"
      style={{
        border: '2px dashed rgba(156, 39, 176, 0.5)',
        borderRadius: 12,
        padding: 10,
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        color: '#eee',
        fontSize: 13,
        background: 'transparent',
        pointerEvents: 'all',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
          cursor: 'pointer',
        }}
      >
        <span onClick={handleToggle} style={{ fontWeight: 600 }}>{'\u25BC '}{d.label}</span>
        <button
          onClick={handleUngroup}
          style={{
            background: SUBGRAPH_ACCENT,
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            padding: '2px 8px',
            cursor: 'pointer',
            fontSize: 11,
          }}
        >
          Ungroup
        </button>
      </div>
    </div>
  );
}

export const SubgraphNode = memo(SubgraphNodeInner);
