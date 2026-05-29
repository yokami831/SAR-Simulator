/**
 * utils.ts — Pure utility functions (no React dependency)
 *
 * Extracted from app.tsx to eliminate duplication and enable reuse
 * across hooks and components.
 */

import type { TabState } from './types.js';

// ===== Node Layout Constants =====

export const NODE_DEFAULT_WIDTH = 250;   // 通常ブロックのデフォルト幅
export const NODE_CODE_WIDTH = 400;      // コードブロック（textarea付き）のデフォルト幅
export const NODE_DEFAULT_HEIGHT = 150;  // auto_layout時のノード高さ見積もり
export const NODE_COMPACT_HEIGHT = 80;   // NodeResizer / subgraphの最小高さ
export const NODE_MIN_WIDTH = 200;       // NodeResizer / subgraphの最小幅
export const GRID_SIZE = 50;             // キャンバスのグリッドスナップ単位
export const LAYOUT_H_GAP = 60;          // auto_layout: ノード間の水平間隔
export const LAYOUT_V_GAP = 30;          // auto_layout: ノード間の垂直間隔
export const DEFAULT_BASE_X = 300;       // 新規ノード配置のデフォルトX座標
export const DEFAULT_BASE_Y = 200;       // 新規ノード配置のデフォルトY座標
export const FIT_VIEW_PADDING = 0.15;    // fitView時のビューポート余白比率
export const LAYOUT_CENTER_Y = 350;     // auto_layout: レイヤー垂直中心Y座標
export const MAX_OUTPUT_DISPLAY_LEN = 5000; // 実行結果表示の最大文字数

// ===== Node Update Helper =====

/**
 * Return a new array with the node matching `id` replaced by `updater(node)`.
 * All other nodes are returned unchanged. Use inside setNodes() to avoid
 * repeating the `nds.map(n => n.id !== id ? n : ...)` boilerplate.
 */
export function updateNodeById<T extends { id: string }>(
  nodes: T[],
  id: string,
  updater: (node: T) => T,
): T[] {
  return nodes.map((n) => (n.id === id ? updater(n) : n));
}

// ===== Position Helpers =====

/**
 * Find a non-overlapping position on the canvas using grid-snapping.
 * @param currentNodes - existing nodes from rfInstance.getNodes()
 * @param baseX - preferred X center in flow coordinates
 * @param baseY - preferred Y center in flow coordinates
 */
export function findFreePosition(
  currentNodes: Array<{ position: { x: number; y: number } }>,
  baseX: number,
  baseY: number,
): { x: number; y: number } {
  let posX = Math.round(baseX / GRID_SIZE) * GRID_SIZE;
  let posY = Math.round(baseY / GRID_SIZE) * GRID_SIZE;
  const occupied = new Set(currentNodes.map(n =>
    `${Math.round(n.position.x / GRID_SIZE) * GRID_SIZE},${Math.round(n.position.y / GRID_SIZE) * GRID_SIZE}`
  ));
  let attempts = 0;
  while (occupied.has(`${posX},${posY}`) && attempts < 20) {
    posX += NODE_DEFAULT_WIDTH + GRID_SIZE;
    if (attempts % 4 === 3) { posX = Math.round(baseX / GRID_SIZE) * GRID_SIZE; posY += NODE_DEFAULT_HEIGHT + GRID_SIZE; }
    attempts++;
  }
  return { x: posX, y: posY };
}

// ===== Error Parsing =====

/** Split an error string into summary and traceback for console log display. */
export function parseError(errorStr: string): { summary: string; traceback: string } {
  if (!errorStr) return { summary: 'Unknown error', traceback: '' };
  const tbIndex = errorStr.indexOf('Traceback');
  if (tbIndex > 0) {
    return { summary: errorStr.substring(0, tbIndex).trim(), traceback: errorStr.substring(tbIndex).trim() };
  }
  const lines = errorStr.split('\n');
  if (lines.length > 3) {
    return { summary: lines[0], traceback: lines.slice(1).join('\n') };
  }
  return { summary: errorStr, traceback: '' };
}

// ===== Port Type Lookup =====

/** Look up the port type (float, complex, etc.) for edge coloring */
export function getPortType(
  nodes: Array<{ id: string; data: { inputs?: Array<{ id: string; portType?: string }>; outputs?: Array<{ id: string; portType?: string }> } }>,
  nodeId: string,
  handleId: string,
): string {
  const node = nodes.find(n => n.id === nodeId);
  if (!node) return 'complex';
  const allPorts = [...(node.data.inputs || []), ...(node.data.outputs || [])];
  const port = allPorts.find(p => p.id === handleId);
  return port ? (port.portType || 'complex') : 'complex';
}

// ===== Subgraph Proxy Helpers =====

interface ExternalPort {
  handleId: string;
  originalEdgeIds: string[];
  innerConnections?: Array<{ edgeId: string; nodeId: string; handleId: string }>;
}

interface ProxyMapEntry {
  originalEdges: Array<Record<string, unknown>>;
  proxyEdgeIds?: string[];
}

/** Build proxyMap and proxyEdges for a subgraph collapse operation. */
export function buildProxyEdges(
  sgId: string,
  externalInputs: ExternalPort[],
  externalOutputs: ExternalPort[],
  currentEdges: Array<Record<string, unknown>>,
): { proxyMap: Record<string, ProxyMapEntry>; proxyEdges: Array<Record<string, unknown>> } {
  const proxyMap: Record<string, ProxyMapEntry> = {};
  const proxyEdges: Array<Record<string, unknown>> = [];
  for (const port of externalInputs) {
    const proxyEdgeId = `${sgId}_${port.handleId}`;
    const origEdges = currentEdges.filter((e: any) => port.originalEdgeIds.includes(e.id));
    proxyMap[proxyEdgeId] = { originalEdges: structuredClone(origEdges) };
    if (origEdges.length > 0) {
      const firstEdge = origEdges[0] as any;
      proxyEdges.push({
        id: proxyEdgeId,
        source: firstEdge.source,
        sourceHandle: firstEdge.sourceHandle,
        target: sgId,
        targetHandle: port.handleId,
        type: firstEdge.type || 'rateEdge',
        data: firstEdge.data ? { ...firstEdge.data } : {},
      });
    }
  }
  for (const port of externalOutputs) {
    const proxyEdgeId = `${sgId}_${port.handleId}`;
    const origEdges = currentEdges.filter((e: any) => port.originalEdgeIds.includes(e.id));
    proxyMap[proxyEdgeId] = { originalEdges: structuredClone(origEdges) };
    for (const conn of (port.innerConnections || [])) {
      const origEdge = currentEdges.find((e: any) => e.id === conn.edgeId) as any;
      proxyEdges.push({
        id: `${proxyEdgeId}_${conn.edgeId}`,
        source: sgId,
        sourceHandle: port.handleId,
        target: conn.nodeId,
        targetHandle: conn.handleId,
        type: origEdge?.type || 'rateEdge',
        data: origEdge?.data ? { ...origEdge.data } : {},
      });
    }
    proxyMap[proxyEdgeId].proxyEdgeIds = (port.innerConnections || []).map(c => `${proxyEdgeId}_${c.edgeId}`);
  }
  return { proxyMap, proxyEdges };
}

// ===== Tab State Factory =====

/** Create a default TabState. Used by switchTab, openWorkspace, onAddTab, onCloseTab. */
export function createTabState(overrides?: Partial<TabState>): TabState {
  return {
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    undoStack: [],
    redoStack: [],
    subgraphStore: {},
    dirty: false,
    ...overrides,
  };
}

// ===== Workspace Save Payload =====

/**
 * Build the workspace save payload (canvas data).
 * Consolidates the 4 places that construct workspace PUT body.
 */
export function buildWorkspaceSavePayload(
  nodes: Array<Record<string, unknown>>,
  edges: Array<Record<string, unknown>>,
  viewport: { x: number; y: number; zoom: number },
): { canvas: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>>; viewport: { x: number; y: number; zoom: number } } } {
  return {
    canvas: {
      nodes: nodes.map((n: any) => {
        const { executionStatus, executionOutput, executionError, executionTime, displayData, resultValue, ...cleanData } = n.data || {};
        return {
          id: n.id, type: n.type, position: n.position, data: cleanData,
          width: n.width, height: n.height, style: n.style,
        };
      }),
      edges,
      viewport,
    },
  };
}

// ===== Toast Notification =====

/** Show a temporary toast message at the bottom center of the screen. */
export function showToast(message: string, duration = 2500): void {
  const el = document.createElement('div');
  el.className = 'toast-notification';
  el.textContent = message;
  document.body.appendChild(el);
  // trigger reflow then add visible class for fade-in
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => {
    el.classList.remove('visible');
    el.addEventListener('transitionend', () => el.remove());
    // fallback removal
    setTimeout(() => el.remove(), 500);
  }, duration);
}

// ===== Node ID Counter Helper =====

/** Compute the max numeric ID from a node array, for resetNodeIdCounter. */
export function computeMaxNodeId(nodes: Array<{ id: string }>): number {
  return nodes.reduce((max, n) => {
    const num = parseInt(n.id.replace(/\D/g, ''), 10);
    return isNaN(num) ? max : Math.max(max, num);
  }, 0);
}
