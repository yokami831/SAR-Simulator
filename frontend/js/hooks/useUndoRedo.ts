/**
 * useUndoRedo - History management for canvas state (undo/redo).
 *
 * Manages a stack of snapshots (nodes + edges + subgraphStore).
 * Provides pushHistory, undo, redo, and skip control.
 */

import { useCallback, useRef, type MutableRefObject } from 'react';

const MAX_HISTORY = 50;

interface HistoryEntry {
  nodes: unknown[];
  edges: unknown[];
  subgraphStore: Record<string, unknown>;
}

interface UseUndoRedoOptions {
  rfInstance: MutableRefObject<any>;
  setNodes: (updater: any) => void;
  setEdges: (updater: any) => void;
  subgraphStoreRef: MutableRefObject<Record<string, unknown>>;
}

interface UseUndoRedoReturn {
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
  skipHistoryRef: MutableRefObject<boolean>;
  historyRef: MutableRefObject<HistoryEntry[]>;
  futureRef: MutableRefObject<HistoryEntry[]>;
}

export function useUndoRedo({
  rfInstance,
  setNodes,
  setEdges,
  subgraphStoreRef,
}: UseUndoRedoOptions): UseUndoRedoReturn {
  const historyRef = useRef<HistoryEntry[]>([]);
  const futureRef = useRef<HistoryEntry[]>([]);
  const skipHistoryRef = useRef(false);

  const pushHistory = useCallback(() => {
    if (skipHistoryRef.current) return;
    const nodes = rfInstance.current?.getNodes();
    const edges = rfInstance.current?.getEdges();
    if (!nodes) return;
    historyRef.current.push({
      nodes: structuredClone(nodes),
      edges: structuredClone(edges),
      subgraphStore: structuredClone(subgraphStoreRef.current),
    });
    if (historyRef.current.length > MAX_HISTORY) historyRef.current.shift();
    futureRef.current = [];
  }, [rfInstance, subgraphStoreRef]);

  const undo = useCallback(() => {
    if (historyRef.current.length === 0) return;
    const currentNodes = rfInstance.current?.getNodes();
    const currentEdges = rfInstance.current?.getEdges();
    if (!currentNodes) return;
    futureRef.current.push({
      nodes: structuredClone(currentNodes),
      edges: structuredClone(currentEdges),
      subgraphStore: structuredClone(subgraphStoreRef.current),
    });
    const prev = historyRef.current.pop()!;
    skipHistoryRef.current = true;
    setNodes(prev.nodes);
    setEdges(prev.edges);
    subgraphStoreRef.current = (prev.subgraphStore || {}) as Record<string, unknown>;
    requestAnimationFrame(() => { skipHistoryRef.current = false; });
  }, [rfInstance, setNodes, setEdges, subgraphStoreRef]);

  const redo = useCallback(() => {
    if (futureRef.current.length === 0) return;
    const currentNodes = rfInstance.current?.getNodes();
    const currentEdges = rfInstance.current?.getEdges();
    if (!currentNodes) return;
    historyRef.current.push({
      nodes: structuredClone(currentNodes),
      edges: structuredClone(currentEdges),
      subgraphStore: structuredClone(subgraphStoreRef.current),
    });
    const next = futureRef.current.pop()!;
    skipHistoryRef.current = true;
    setNodes(next.nodes);
    setEdges(next.edges);
    subgraphStoreRef.current = (next.subgraphStore || {}) as Record<string, unknown>;
    requestAnimationFrame(() => { skipHistoryRef.current = false; });
  }, [rfInstance, setNodes, setEdges, subgraphStoreRef]);

  return { pushHistory, undo, redo, skipHistoryRef, historyRef, futureRef };
}
