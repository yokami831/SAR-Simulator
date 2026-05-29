/**
 * useFlowPersistence.ts — Save/Load flowgraph operations
 *
 * Handles .rcflow file save/load and workspace API save.
 * handleRun/handleStop remain in app.tsx (trivial, ~30 lines).
 */

import { useCallback, useRef } from 'react';
import { consoleLog } from '../backend.js';
import { getTabType } from '../tabRegistry.js';
import { resetNodeIdCounter, createNode, getBlockDef } from '../blockLibraryData.js';
import { flattenSubgraphs } from '../subgraph.js';
import { buildWorkspaceSavePayload, computeMaxNodeId, FIT_VIEW_PADDING } from '../utils.js';
import { DELAY_FIT_VIEW_LOAD } from '../constants.js';
import { rcNewFlow } from '../modal.js';

interface UseFlowPersistenceOptions {
  rfInstance: React.MutableRefObject<any>;
  setNodes: (updater: any) => void;
  setEdges: (updater: any) => void;
  pushHistory: () => void;
  subgraphStoreRef: React.MutableRefObject<Record<string, any>>;
  flowNameRef: React.MutableRefObject<string>;
  tabs: Array<{ id: string; type: string; title: string; workspaceFilename: string | null }>;
  activeTabRef: React.MutableRefObject<string>;
  updateTitleFilename: (name: string | null) => void;
  createSubgraph: (nodeIds: string[], label?: string) => string | null;
  setSubgraphDescription: (sgId: string, desc: string) => void;
  tabDataRef: React.MutableRefObject<Map<string, any>>;
  clearDirty: (tabId?: string) => void;
  /** Phase 1 snapshot dirty detection: re-anchor the saved fingerprint after
   *  a successful save (so subsequent edits compare against the new disk state)
   *  or after restoreFlowgraph (so a freshly-loaded workspace is clean). */
  setSavedFingerprint?: (tabId: string, fingerprint: string) => void;
  /** Called after a successful "Save As" that created a new workspace: rebinds
   *  the active tab to the new file (title + filename) and refreshes the list. */
  onSavedAs?: (tabId: string, newTitle: string, newFilename: string) => void;
}

export function useFlowPersistence({
  rfInstance, setNodes, setEdges, pushHistory, subgraphStoreRef,
  flowNameRef, tabs, activeTabRef,
  updateTitleFilename, createSubgraph, setSubgraphDescription,
  tabDataRef,
  clearDirty,
  setSavedFingerprint,
  onSavedAs,
}: UseFlowPersistenceOptions) {

  const fileHandleRef = useRef<any>(null);

  /** Build save data from current flowgraph state. */
  const buildSaveData = useCallback((saveName: string) => {
    const currentNodes = rfInstance.current?.getNodes() || [];
    const currentEdges = rfInstance.current?.getEdges() || [];
    const { nodes: flatNodes, edges: flatEdges } = flattenSubgraphs(currentNodes, currentEdges, subgraphStoreRef.current);

    const subgraphGroups: Array<{ label: string; childNodeIds: string[]; description: string }> = [];
    for (const n of currentNodes) {
      if (n.type === 'subgraph') {
        subgraphGroups.push({
          label: n.data.label,
          childNodeIds: n.data.childNodeIds || [],
          description: n.data.description || '',
        });
      }
    }

    return {
      name: saveName,
      savedAt: new Date().toISOString(),
      subgraphGroups: subgraphGroups.length > 0 ? subgraphGroups : undefined,
      nodes: flatNodes.filter(n => n.type !== 'subgraph').map(n => ({
        id: n.id,
        type: 'canvasNode',
        position: { x: n.position.x, y: n.position.y },
        width: n.width || n.style?.width || undefined,
        height: n.height || undefined,
        data: {
          label: n.data.label,
          category: n.data.category,
          blockType: n.data.blockType,
          inputs: n.data.inputs || [],
          outputs: n.data.outputs || [],
          defaultParameters: n.data.defaultParameters || {},
          ...(n.data.enabled === false ? { enabled: false } : {}),
          ...(n.data.codeCollapsed === true ? { codeCollapsed: true } : {}),
          ...(n.data.specCollapsed === true ? { specCollapsed: true } : {}),
          ...(typeof n.data.specHeight === 'number' ? { specHeight: n.data.specHeight } : {}),
          ...(n.data.barColor ? { barColor: n.data.barColor } : {}),
        },
      })),
      edges: flatEdges.map(e => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle,
        target: e.target,
        targetHandle: e.targetHandle,
      })),
    };
  }, []);

  /**
   * Compute a stable fingerprint of the Flow state's saved-relevant fields.
   * Used by snapshot-based dirty detection (Phase 1). Equal fingerprint ↔
   * disk-equal. Reuses buildSaveData's whitelist (it already strips execution
   * noise: executionStatus / output / error / etc.). The save-name and savedAt
   * timestamp are excluded explicitly so the fingerprint doesn't change-on-load
   * or change-on-save just because the timestamp moved.
   */
  const computeFlowFingerprint = useCallback((): string => {
    const data = buildSaveData('__fingerprint__') as Record<string, unknown>;
    return JSON.stringify({
      nodes: data.nodes,
      edges: data.edges,
      subgraphGroups: data.subgraphGroups,
    });
  }, [buildSaveData]);

  /** Restore flowgraph from parsed JSON data */
  const restoreFlowgraph = useCallback((data: any, fileName: string) => {
    pushHistory();
    if (!data.nodes || !data.edges) {
      throw new Error('Invalid flowgraph file format');
    }
    if (data.name) flowNameRef.current = data.name;

    const restoredNodes = data.nodes.map(n => {
      const registryDef = getBlockDef(n.data.blockType);
      const node = createNode({
        id: n.id, position: n.position,
        blockDef: {
          type: n.data.blockType, label: n.data.label, category: n.data.category,
          inputs: n.data.inputs || [], outputs: n.data.outputs || [],
          params: '', defaultParameters: n.data.defaultParameters || {},
          ...(registryDef?.gui_widget ? { gui_widget: registryDef.gui_widget } : {}),
        },
        width: n.width, height: n.height,
      });
      if (n.data.enabled === false) {
        node.data = { ...node.data, enabled: false };
      }
      if (n.data.codeCollapsed === true) {
        node.data = { ...node.data, codeCollapsed: true };
      }
      if (n.data.specCollapsed === true) {
        node.data = { ...node.data, specCollapsed: true };
      }
      if (typeof n.data.specHeight === 'number') {
        node.data = { ...node.data, specHeight: n.data.specHeight };
      }
      if (n.data.barColor) {
        node.data = { ...node.data, barColor: n.data.barColor };
      }
      return node;
    });
    const restoredEdges = data.edges.map(e => ({
      id: e.id, source: e.source, sourceHandle: e.sourceHandle,
      target: e.target, targetHandle: e.targetHandle,
    }));
    resetNodeIdCounter(computeMaxNodeId(restoredNodes) + 1);
    subgraphStoreRef.current = {};
    setNodes(restoredNodes);
    setEdges(restoredEdges);

    // Restore subgraph groups (auto-collapse them)
    if (data.subgraphGroups && data.subgraphGroups.length > 0) {
      setTimeout(() => {
        for (const group of data.subgraphGroups) {
          const currentNodes = rfInstance.current?.getNodes() || [];
          const aliveIds = group.childNodeIds.filter(id => currentNodes.find(n => n.id === id));
          if (aliveIds.length < 2) continue;
          const sgId = createSubgraph(aliveIds, group.label || 'Group');
          if (sgId && group.description) {
            setSubgraphDescription(sgId, group.description);
          }
        }
      }, 200);
    }

    setTimeout(() => rfInstance.current?.fitView({ padding: FIT_VIEW_PADDING }), DELAY_FIT_VIEW_LOAD);
    updateTitleFilename(fileName);
    consoleLog('info', `Loaded: ${fileName}`, '', 'file');
    // Phase 1: re-anchor the fingerprint to the just-loaded state so the
    // freshly-loaded flow is treated as clean. Deferred to a microtask so
    // setNodes/setEdges have committed before we snapshot.
    if (setSavedFingerprint) {
      const tabId = activeTabRef.current;
      setTimeout(() => {
        try { setSavedFingerprint(tabId, computeFlowFingerprint()); }
        catch { /* ignore — ref not yet populated */ }
      }, 0);
    }
  }, [setNodes, setEdges, updateTitleFilename, pushHistory, createSubgraph, setSubgraphDescription, setSavedFingerprint, computeFlowFingerprint]);

  const handleSaveAs = useCallback(async () => {
    const currentTab = tabs.find(t => t.id === activeTabRef.current);
    const tabType = getTabType(currentTab?.type);

    // Flow workspace tab → "Save As" means CLONE THE WORKSPACE (a registered
    // .rcflow in the correct {canvas:{nodes,edges,viewport}} format that shows
    // in the file list), not a browser file download. Create a new workspace,
    // write the current canvas to it, then rebind this tab to the new file.
    if (currentTab?.type === 'flow' && currentTab.workspaceFilename) {
      let errorMessage = '';
      while (true) {
        const input = await rcNewFlow({
          title: 'Save Workspace As', submitLabel: 'Save As',
          initialTitle: currentTab.title, errorMessage,
        });
        if (!input) return; // cancelled
        const createResp = await fetch('/api/workspaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'flow', title: input.title, description: input.description }),
        });
        if (createResp.status === 409) {
          const err = await createResp.json();
          errorMessage = err.detail || 'A workspace with this name already exists.';
          continue;
        }
        if (!createResp.ok) {
          consoleLog('error', 'Save As: failed to create workspace', '', 'file');
          return;
        }
        const ws = await createResp.json();
        const currentNodes = rfInstance.current?.getNodes() || [];
        const currentEdges = rfInstance.current?.getEdges() || [];
        const viewport = rfInstance.current?.getViewport() || { x: 0, y: 0, zoom: 1 };
        const saveResp = await fetch(`/api/workspaces/${ws.filename}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildWorkspaceSavePayload(currentNodes, currentEdges, viewport)),
        });
        if (!saveResp.ok) {
          consoleLog('error', 'Save As: failed to write workspace', '', 'file');
          return;
        }
        onSavedAs?.(currentTab.id, ws.title, ws.filename);
        clearDirty(currentTab.id);
        // Phase 1: re-anchor fingerprint to the just-saved state.
        setSavedFingerprint?.(currentTab.id, computeFlowFingerprint());
        consoleLog('info', `Saved As: ${ws.title}`, '', 'file');
        return;
      }
    }

    // Determine extension, description, and data based on tab type
    let ext = '.rcflow';
    let desc = 'HiyoCanvas Flowgraph';
    let data: any;

    if (tabType?.fileExtension) {
      ext = tabType.fileExtension;
      desc = `HiyoCanvas ${tabType.label || 'File'}`;
    }

    const baseName = currentTab?.title || flowNameRef.current;

    if (currentTab?.type === 'flow' || !currentTab?.type) {
      data = buildSaveData(baseName);
    } else if (tabType?.dataKey) {
      data = tabDataRef.current.get(currentTab!.id) || {};
    } else {
      return;
    }

    const json = JSON.stringify(data, null, 2);
    const mimeType = 'application/json';

    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: `${baseName}${ext}`,
          types: [{ description: desc, accept: { [mimeType]: [ext] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(json);
        await writable.close();
        consoleLog('info', `Saved: ${handle.name}`, '', 'file');
      } catch (e: any) {
        if (e.name !== 'AbortError') {
          consoleLog('error', `Save error: ${e.message}`, '', 'file');
        }
      }
    } else {
      const blob = new Blob([json], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${baseName}${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      consoleLog('info', `Saved: ${baseName}${ext}`, '', 'file');
    }
  }, [tabs, buildSaveData, tabDataRef, setSavedFingerprint, computeFlowFingerprint]);

  const handleSave = useCallback(async () => {
    const currentTab = tabs.find(t => t.id === activeTabRef.current);

    // Plugin tabs (mindmap, excalidraw, etc.): save plugin data to workspace API
    const tabType = getTabType(currentTab?.type);
    if (tabType?.dataKey && currentTab?.workspaceFilename) {
      try {
        const pluginData = tabDataRef.current.get(currentTab.id);
        await fetch(`/api/workspaces/${currentTab.workspaceFilename}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [tabType.dataKey]: pluginData || null }),
        });
        consoleLog('info', `Saved workspace: ${currentTab.title}`, '', 'file');
        // Reset Excalidraw snapshot so onChange doesn't re-dirty immediately
        ;window.__excalidrawResetSnapshot?.()
        clearDirty();
      } catch (err: any) {
        consoleLog('error', `Failed to save: ${err.message}`, '', 'file');
      }
      return;
    }

    // For flow tabs with a workspace, save to workspace API
    if (currentTab?.type === 'flow' && currentTab.workspaceFilename) {
      try {
        const currentNodes = rfInstance.current?.getNodes() || [];
        const currentEdges = rfInstance.current?.getEdges() || [];
        const viewport = rfInstance.current?.getViewport() || { x: 0, y: 0, zoom: 1 };
        await fetch(`/api/workspaces/${currentTab.workspaceFilename}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildWorkspaceSavePayload(currentNodes, currentEdges, viewport)),
        });
        consoleLog('info', `Saved workspace: ${currentTab.title}`, '', 'file');
        clearDirty();
        // Phase 1: re-anchor fingerprint to the just-saved state.
        setSavedFingerprint?.(currentTab.id, computeFlowFingerprint());
        return;
      } catch (e: any) {
        consoleLog('error', `Save error: ${e.message}`, '', 'file');
        return;
      }
    }
    // Legacy: file-based save
    if (fileHandleRef.current) {
      try {
        const saveData = buildSaveData(flowNameRef.current);
        const json = JSON.stringify(saveData, null, 2);
        const writable = await fileHandleRef.current.createWritable();
        await writable.write(json);
        await writable.close();
        consoleLog('info', `Saved: ${fileHandleRef.current.name}`, '', 'file');
        clearDirty();
        // Phase 1: re-anchor fingerprint to the just-saved state.
        setSavedFingerprint?.(activeTabRef.current, computeFlowFingerprint());
        return;
      } catch (e) {
        fileHandleRef.current = null;
      }
    }
    await handleSaveAs();
  }, [tabs, buildSaveData, handleSaveAs, setSavedFingerprint, computeFlowFingerprint]);

  return {
    buildSaveData,
    computeFlowFingerprint,
    restoreFlowgraph,
    handleSave,
    handleSaveAs,
    fileHandleRef,
  };
}
