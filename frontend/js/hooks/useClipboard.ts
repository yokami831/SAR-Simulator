/**
 * useClipboard - Copy/paste/cut operations for canvas nodes.
 */

import { useCallback, useRef, type MutableRefObject } from 'react';
import { getNextNodeId } from '../blockLibraryData.js';

interface UseClipboardOptions {
  rfInstance: MutableRefObject<any>;
  setNodes: (updater: any) => void;
  setEdges: (updater: any) => void;
  pushHistory: () => void;
  deleteSelected: () => void;
}

interface ClipboardData {
  nodes: any[];
  edges: any[];
}

export function useClipboard({
  rfInstance,
  setNodes,
  setEdges,
  pushHistory,
  deleteSelected,
}: UseClipboardOptions) {
  const clipboardRef = useRef<ClipboardData | null>(null);

  const copySelected = useCallback(() => {
    const currentNodes = rfInstance.current?.getNodes() || [];
    const currentEdges = rfInstance.current?.getEdges() || [];
    const selectedNodes = currentNodes.filter((n: any) => n.selected);
    if (selectedNodes.length === 0) return;
    const selectedIds = new Set(selectedNodes.map((n: any) => n.id));
    const internalEdges = currentEdges.filter(
      (e: any) => selectedIds.has(e.source) && selectedIds.has(e.target)
    );
    clipboardRef.current = {
      nodes: structuredClone(selectedNodes),
      edges: structuredClone(internalEdges),
    };
  }, [rfInstance]);

  const pasteClipboard = useCallback(() => {
    if (!clipboardRef.current || clipboardRef.current.nodes.length === 0) return;
    pushHistory();
    const { nodes: copiedNodes, edges: copiedEdges } = clipboardRef.current;
    const idMap: Record<string, string> = {};
    copiedNodes.forEach((n: any) => { idMap[n.id] = getNextNodeId(); });
    const OFFSET = 50;
    const newNodes = copiedNodes.map((n: any) => ({
      ...structuredClone(n),
      id: idMap[n.id],
      position: { x: n.position.x + OFFSET, y: n.position.y + OFFSET },
      selected: true,
    }));
    const newEdges = copiedEdges.map((e: any) => ({
      ...structuredClone(e),
      id: `e_${idMap[e.source]}_${e.sourceHandle}_${idMap[e.target]}_${e.targetHandle}`,
      source: idMap[e.source],
      target: idMap[e.target],
    }));
    setNodes((nds: any[]) => [...nds.map((n: any) => ({ ...n, selected: false })), ...newNodes]);
    setEdges((eds: any[]) => [...eds, ...newEdges]);
    clipboardRef.current = {
      nodes: copiedNodes.map((n: any) => ({
        ...n,
        position: { x: n.position.x + OFFSET, y: n.position.y + OFFSET },
      })),
      edges: copiedEdges,
    };
  }, [setNodes, setEdges, pushHistory]);

  const cutSelected = useCallback(() => {
    copySelected();
    deleteSelected();
  }, [copySelected, deleteSelected]);

  return { copySelected, pasteClipboard, cutSelected, clipboardRef };
}
