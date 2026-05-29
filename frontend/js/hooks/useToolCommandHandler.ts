/**
 * useToolCommandHandler.ts — AI tool command dispatch via WebSocket
 *
 * All cases delegate to shared operation functions passed in as dependencies.
 * No direct state mutation — only calls hook functions from useNodeOperations,
 * useSubgraphOps, useFlowPersistence, and useTabManager.
 */

import { useCallback } from 'react';
import type { Node, Edge, ReactFlowInstance } from '@xyflow/react';
import type { TabInstance, TabState, ToolCommand } from '../types.js';
import type { BlockData } from '../blockLibraryData.js';
import { vizDataStore, sendWsMessage } from '../backend.js';
import { ANIM_PAN_DURATION, ANIM_FIT_VIEW_DURATION, ANIM_ZOOM_DURATION, DELAY_FIT_VIEW } from '../constants.js';
import { getBlockDataForNode } from '../blockLibraryData.js';
import { flattenSubgraphs } from '../subgraph.js';
import { findTabTypeForAction } from '../tabRegistry.js';
import { NODE_DEFAULT_WIDTH, NODE_DEFAULT_HEIGHT, DEFAULT_BASE_X, DEFAULT_BASE_Y, FIT_VIEW_PADDING } from '../utils.js';

interface UseToolCommandHandlerOptions {
  rfInstance: React.MutableRefObject<ReactFlowInstance | null>;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  setRunning: (v: boolean) => void;
  setTooltips: React.Dispatch<React.SetStateAction<Array<Record<string, unknown>>>>;
  pushHistory: () => void;
  subgraphStoreRef: React.MutableRefObject<Record<string, unknown>>;
  updateRunStopButton: (isRunning: boolean) => void;

  // From useNodeOperations
  addNodeShared: (blockDef: BlockData, position?: { x: number; y: number }, paramOverrides?: Record<string, string>) => string;
  addEdgeShared: (source: string, sourceHandle: string, target: string, targetHandle: string) => string;
  deleteNodeShared: (nodeId: string) => void;
  clearAllShared: () => void;
  autoLayout: () => void;

  // From useSubgraphOps
  createSubgraph: (nodeIds: string[], label?: string) => string | null;
  toggleSubgraph: (sgId: string) => void;
  expandSubgraph: (sgId: string) => void;
  ungroupSubgraph: (sgId: string) => void;
  renameSubgraph: (sgId: string, newLabel: string) => void;
  setSubgraphDescription: (sgId: string, desc: string) => void;

  // From useFlowPersistence
  buildSaveData: (saveName: string) => Record<string, unknown>;
  restoreFlowgraph: (data: Record<string, unknown>, fileName: string) => void;
  flowNameRef: React.MutableRefObject<string>;

  // Tab refs (for async access)
  tabsRef: React.MutableRefObject<TabInstance[]>;
  activeTabRef: React.MutableRefObject<string>;
  openWorkspaceRef: React.MutableRefObject<((filename: string) => Promise<void>) | null>;
  switchTabRef: React.MutableRefObject<((tabId: string) => void) | null>;
  onCloseTabRef: React.MutableRefObject<((tabId: string) => void) | null>;
  setTabs: React.Dispatch<React.SetStateAction<TabInstance[]>>;
  tabDataRef: React.MutableRefObject<Map<string, unknown>>;
  tabStatesRef: React.MutableRefObject<Map<string, TabState>>;
}

export function useToolCommandHandler({
  rfInstance, setNodes, setEdges, setRunning, setTooltips,
  pushHistory, subgraphStoreRef, updateRunStopButton,
  addNodeShared, addEdgeShared, deleteNodeShared, clearAllShared, autoLayout,
  createSubgraph, toggleSubgraph, expandSubgraph, ungroupSubgraph, renameSubgraph, setSubgraphDescription,
  buildSaveData, restoreFlowgraph, flowNameRef,
  tabsRef, activeTabRef, openWorkspaceRef, switchTabRef, onCloseTabRef,
  setTabs, tabDataRef, tabStatesRef,
}: UseToolCommandHandlerOptions) {

  const handleToolCommand = useCallback(async (msg: ToolCommand) => {
    const { action, request_id } = msg;

    /** Send response back to server via WebSocket */
    const respond = (data: Record<string, unknown>) => {
      sendWsMessage({ response_to: request_id, ...data });
    };

    /** Get the currently active tab */
    const getActiveTab = () => tabsRef.current.find(t => t.id === activeTabRef.current);

    /** Delegate action to plugin tab handler. Returns true if handled. */
    const delegateToPlugin = async (): Promise<boolean> => {
      const activeId = activeTabRef.current;
      const activeT = tabsRef.current.find(t => t.id === activeId);
      const pluginTabType = findTabTypeForAction(action, activeT?.type);
      if (pluginTabType && pluginTabType.toolActions) {
        let targetTabId = activeId;
        if (activeT?.type !== pluginTabType.id) {
          const alt = tabsRef.current.find(t => t.type === pluginTabType.id);
          if (alt) targetTabId = alt.id;
        }
        await pluginTabType.toolActions[action](msg, {
          tabId: targetTabId,
          dataRef: tabDataRef,
          tabsRef,
          activeTabRef,
          respond,
        });
        return true;
      }
      return false;
    };

    try {
      switch (action) {
        case 'add_element': {
          if (getActiveTab()?.type !== 'flow') { if (await delegateToPlugin()) return; }
          const blockDef = getBlockDataForNode(msg.block_type as string);
          if (!blockDef) {
            respond({ success: false, error: `Unknown block type: ${msg.block_type}` });
            return;
          }
          const position = msg.position as { x: number; y: number } | undefined;
          const nodeId = addNodeShared(blockDef, position, msg.parameters as Record<string, string> | undefined);
          // Center view on the newly added node (query inside setTimeout so React state is committed)
          setTimeout(() => {
            const nodePos = rfInstance.current?.getNode(nodeId)?.position || position || { x: DEFAULT_BASE_X, y: DEFAULT_BASE_Y };
            rfInstance.current?.setCenter(
              nodePos.x + NODE_DEFAULT_WIDTH / 2, nodePos.y + NODE_DEFAULT_HEIGHT / 2,
              { zoom: rfInstance.current.getZoom(), duration: ANIM_PAN_DURATION }
            );
          }, DELAY_FIT_VIEW);
          respond({ success: true, node_id: nodeId });
          break;
        }

        case 'remove_element': {
          if (getActiveTab()?.type !== 'flow') { if (await delegateToPlugin()) return; }
          const targetId = msg.node_id as string;
          const currentEdges = rfInstance.current?.getEdges() || [];
          const removedEdges = currentEdges
            .filter(e => e.source === targetId || e.target === targetId)
            .map(e => e.id);
          deleteNodeShared(targetId);
          respond({ success: true, removed_edges: removedEdges });
          break;
        }

        case 'add_edge': {
          const currentNodes = rfInstance.current?.getNodes() || [];
          if (!currentNodes.find(n => n.id === msg.source as string)) {
            respond({ success: false, error: `Source node '${msg.source}' not found` });
            break;
          }
          if (!currentNodes.find(n => n.id === msg.target as string)) {
            respond({ success: false, error: `Target node '${msg.target}' not found` });
            break;
          }
          const edgeId = addEdgeShared(msg.source as string, msg.source_port as string, msg.target as string, msg.target_port as string);
          respond({ success: true, edge_id: edgeId });
          break;
        }

        case 'remove_edge': {
          const currentEdges = rfInstance.current?.getEdges() || [];
          const edgeIdParam = msg.edge_id as string | undefined;
          const srcParam = msg.source as string | undefined;
          const srcPortParam = msg.source_port as string | undefined;
          const tgtParam = msg.target as string | undefined;
          const tgtPortParam = msg.target_port as string | undefined;
          let edgeFound = false;
          if (edgeIdParam) {
            edgeFound = currentEdges.some(e => e.id === edgeIdParam);
          } else {
            edgeFound = currentEdges.some(e =>
              e.source === srcParam &&
              e.sourceHandle === srcPortParam &&
              e.target === tgtParam &&
              e.targetHandle === tgtPortParam
            );
          }
          if (!edgeFound) {
            respond({ success: false, error: `Edge not found: ${srcParam}:${srcPortParam} → ${tgtParam}:${tgtPortParam}` });
            break;
          }
          pushHistory();
          if (edgeIdParam) {
            setEdges(eds => eds.filter(e => e.id !== edgeIdParam));
          } else {
            setEdges(eds => eds.filter(e => !(
              e.source === srcParam &&
              e.sourceHandle === srcPortParam &&
              e.target === tgtParam &&
              e.targetHandle === tgtPortParam
            )));
          }
          respond({ success: true });
          break;
        }

        case 'update_param': {
          pushHistory();
          const upNodeId = msg.node_id as string;
          const upParam = msg.param as string;
          const upValue = msg.value as string;
          setNodes(nds => nds.map(node => {
            if (node.id === upNodeId) {
              return {
                ...node,
                data: {
                  ...node.data,
                  defaultParameters: {
                    ...((node.data.defaultParameters as Record<string, string>) || {}),
                    [upParam]: upValue,
                  },
                },
              };
            }
            return node;
          }));
          respond({ success: true });
          break;
        }

        case 'set_enabled': {
          pushHistory();
          const enNodeId = msg.node_id as string;
          setNodes(nds => nds.map(node => {
            if (node.id === enNodeId) {
              return { ...node, data: { ...node.data, enabled: msg.enabled } };
            }
            return node;
          }));
          respond({ success: true });
          break;
        }

        case 'set_bar_color': {
          // Per-node bar color override (CSS color string), or null/'' to clear.
          // Stored on node.data.barColor. RegularBlockNode applies it inline
          // as --cat-color, so the 6px sidebar + exec-state borders follow it.
          pushHistory();
          const bcNodeId = msg.node_id as string;
          const bcValue = msg.bar_color as string | null | undefined;
          setNodes(nds => nds.map(node => {
            if (node.id !== bcNodeId) return node;
            if (bcValue === null || bcValue === undefined || bcValue === '') {
              const { barColor: _drop, ...restData } = node.data as Record<string, unknown>;
              void _drop;
              return { ...node, data: restData };
            }
            return { ...node, data: { ...node.data, barColor: bcValue } };
          }));
          respond({ success: true });
          break;
        }

        case 'set_code_collapsed': {
          pushHistory();
          const ccNodeId = msg.node_id as string;
          setNodes(nds => nds.map(node => {
            if (node.id !== ccNodeId) return node;
            const collapsed = !!msg.collapsed;
            const { height: _h, ...restStyle } = (node.style || {}) as Record<string, unknown>;
            const { height: _mh, ...restMeasured } = ((node as Record<string, unknown>).measured || {}) as Record<string, unknown>;
            const { height: _nh, ...restNode } = node as Record<string, unknown>;
            return { ...restNode, data: { ...node.data, codeCollapsed: collapsed }, style: { ...restStyle }, measured: { ...restMeasured } } as unknown as Node;
          }));
          respond({ success: true });
          break;
        }

        case 'update_node': {
          pushHistory();
          const unNodeId = msg.node_id as string;
          const unPos = msg.position as { x: number; y: number } | undefined;
          const unWidth = msg.width as number | undefined;
          const unHeight = msg.height as number | undefined;
          setNodes(nds => nds.map(node => {
            if (node.id !== unNodeId) return node;
            const updated = { ...node };
            if (unPos) updated.position = { x: unPos.x, y: unPos.y };
            if (unWidth !== undefined || unHeight !== undefined) {
              updated.style = { ...updated.style };
              if (unWidth !== undefined) (updated.style as Record<string, unknown>).width = unWidth;
              if (unHeight !== undefined) (updated.style as Record<string, unknown>).height = unHeight;
            }
            return updated;
          }));
          respond({ success: true });
          break;
        }

        case 'update_runtime_value': {
          // Update GUI control display value: find node whose id param matches msg.name
          const rvName = msg.name as string;
          const rvValue = msg.value as string;
          setNodes(nds => nds.map(node => {
            const params = node.data?.defaultParameters as Record<string, string> | undefined;
            if (params && params.id === rvName) {
              return {
                ...node,
                data: {
                  ...node.data,
                  defaultParameters: { ...params, value: rvValue },
                },
              };
            }
            return node;
          }));
          respond({ success: true });
          break;
        }

        case 'clear': {
          clearAllShared();
          respond({ success: true });
          break;
        }

        case 'get_selection': {
          if (getActiveTab()?.type !== 'flow') { if (await delegateToPlugin()) return; }
          const selNodes = (rfInstance.current?.getNodes() || []).filter(n => n.selected);
          const selEdges = (rfInstance.current?.getEdges() || []).filter(e => e.selected);
          respond({
            success: true,
            selectedIds: selNodes.map(n => n.id),
            selectedElements: selNodes.map(n => {
              const d = n.data as Record<string, unknown>;
              return {
                id: n.id,
                type: (d.blockType as string) || n.type,
                label: (d.label as string) || '',
                code: (d.code as string) || '',
              };
            }),
            selectedEdges: selEdges.map(e => ({ id: e.id, source: e.source, target: e.target })),
            count: selNodes.length,
          });
          return;
        }

        case 'get_elements': {
          if (getActiveTab()?.type !== 'flow') { if (await delegateToPlugin()) return; }
          const currentNodes = rfInstance.current?.getNodes() || [];
          const currentEdges = rfInstance.current?.getEdges() || [];
          // Flatten subgraphs so backend sees real blocks for codegen
          const { nodes: flatStateNodes, edges: flatStateEdges } = flattenSubgraphs(currentNodes, currentEdges, subgraphStoreRef.current as Record<string, never>);
          // Collect subgraph info from current nodes
          const subgraphs = currentNodes
            .filter(n => n.type === 'subgraph')
            .map(n => {
              const d = n.data as Record<string, unknown>;
              return {
                id: n.id,
                label: d.label as string,
                description: (d.description as string) || '',
                collapsed: !!subgraphStoreRef.current[n.id],
                childNodeIds: (d.childNodeIds as string[]) || [],
              };
            });
          const flowgraph = {
            nodes: flatStateNodes.filter(n => n.type !== 'subgraph').map(n => {
              const d = n.data as Record<string, unknown>;
              const defParams = (d.defaultParameters as Record<string, string>) || {};
              const inputs = (d.inputs as Array<{ id: string }>) || [];
              const outputs = (d.outputs as Array<{ id: string }>) || [];
              return {
                id: n.id,
                type: (d.blockType as string) || n.type,
                blockType: d.blockType as string,
                label: defParams.label || (d.label as string),
                category: d.category as string,
                parameters: defParams,
                position: n.position,
                inputs: inputs.map((p: { id: string }) => p.id || p),
                outputs: outputs.map((p: { id: string }) => p.id || p),
                ...(d.enabled === false ? { enabled: false } : {}),
                ...(d.codeCollapsed === true ? { codeCollapsed: true } : {}),
                ...(d.specCollapsed === true ? { specCollapsed: true } : {}),
                ...(d.barColor ? { barColor: d.barColor } : {}),
                // Execution result data (matches what is displayed on the node)
                ...(d.executionStatus ? {
                  executionStatus: d.executionStatus,
                  executionOutput: (d.executionOutput as string) || '',
                  executionError: (d.executionError as string) || '',
                  executionTime: d.executionTime,
                  resultValue: (d.resultValue as string) || '',
                } : {}),
              };
            }),
            edges: flatStateEdges.map(e => ({
              id: e.id,
              source: e.source,
              sourcePort: e.sourceHandle,
              target: e.target,
              targetPort: e.targetHandle,
            })),
            subgraphs: subgraphs.length > 0 ? subgraphs : undefined,
          };
          respond({ success: true, flowgraph });
          break;
        }

        case 'status_change': {
          if ((msg.status as string) === 'running') {
            setRunning(true);
            updateRunStopButton(true);
          } else {
            setRunning(false);
            updateRunStopButton(false);
            Object.keys(vizDataStore).forEach(k => delete vizDataStore[k]);
          }
          respond({ success: true });
          break;
        }

        case 'auto_layout': {
          autoLayout();
          respond({ success: true });
          break;
        }

        case 'fit_all': {
          if (rfInstance.current) {
            rfInstance.current.fitView({ padding: FIT_VIEW_PADDING, duration: ANIM_FIT_VIEW_DURATION });
            respond({ success: true });
          } else {
            respond({ success: false, error: 'React Flow instance not available' });
          }
          break;
        }

        case 'fit_node': {
          const fitNodeId = msg.node_id as string | undefined;
          if (!fitNodeId) {
            respond({ success: false, error: 'node_id is required' });
            break;
          }
          if (!rfInstance.current) {
            respond({ success: false, error: 'React Flow instance not available' });
            break;
          }
          const fitNode = rfInstance.current.getNode(fitNodeId);
          if (!fitNode) {
            respond({ success: false, error: `Node not found: ${fitNodeId}` });
            break;
          }
          try {
            rfInstance.current.fitView({
              nodes: [{ id: fitNodeId }],
              padding: 0.3,
              duration: ANIM_FIT_VIEW_DURATION,
            });
            respond({ success: true, node_id: fitNodeId });
          } catch (err: unknown) {
            respond({ success: false, error: `Failed to fit view: ${(err as Error).message || String(err)}` });
          }
          break;
        }

        case 'zoom': {
          const zoomLevel = parseFloat(msg.level as string);
          if (isNaN(zoomLevel)) {
            respond({ success: false, error: 'level must be a number' });
            break;
          }
          if (!rfInstance.current) {
            respond({ success: false, error: 'React Flow instance not available' });
            break;
          }
          rfInstance.current.zoomTo(zoomLevel, { duration: ANIM_ZOOM_DURATION });
          respond({ success: true, level: zoomLevel });
          break;
        }

        case 'get_viewport': {
          if (!rfInstance.current) {
            respond({ success: false, error: 'React Flow instance not available' });
            break;
          }
          const vp = rfInstance.current.getViewport();
          const container = document.getElementById('content-area');
          const rect = container?.getBoundingClientRect();
          const nodeCount = rfInstance.current.getNodes().length;
          respond({
            success: true,
            viewport: { x: Math.round(vp.x), y: Math.round(vp.y), zoom: vp.zoom },
            window_size: { width: rect?.width || 0, height: rect?.height || 0 },
            node_count: nodeCount,
          });
          break;
        }

        case 'get_save_data': {
          respond({ success: true, save_data: buildSaveData(flowNameRef.current) });
          break;
        }

        case 'restore_flowgraph': {
          try {
            restoreFlowgraph(msg.data as Record<string, unknown>, (msg.filename as string) || 'flowgraph.rcflow');
            respond({ success: true });
          } catch (err: unknown) {
            respond({ success: false, error: (err as Error).message });
          }
          break;
        }

        case 'show_tooltip': {
          const tooltipData: Record<string, unknown> = {
            nodeId: msg.node_id,
            text: msg.text,
            type: msg.type || 'info',
            highlight: msg.highlight !== false,
          };
          if (msg.require_ok) {
            tooltipData._respond = respond;
            tooltipData.requireOk = true;
          }
          setTooltips(prev => {
            const filtered = prev.filter(t => t.nodeId !== msg.node_id);
            return [...filtered, tooltipData];
          });
          if (msg.tab) {
            const ttNodeId = msg.node_id as string;
            setNodes(prev => prev.map(n =>
              n.id === ttNodeId
                ? { ...n, data: { ...n.data, _requestedTab: msg.tab, _tabRequestId: Date.now() } }
                : n
            ));
          }
          if (!msg.require_ok) {
            respond({ success: true, node_id: msg.node_id, type: msg.type || 'info' });
          }
          break;
        }

        case 'hide_tooltip': {
          setTooltips(prev => prev.filter(t => t.nodeId !== msg.node_id));
          respond({ success: true, node_id: msg.node_id });
          break;
        }

        case 'clear_tooltips': {
          setTooltips([]);
          respond({ success: true });
          break;
        }

        // ===== Subgraph Tool Commands =====
        case 'create_subgraph': {
          const sgId = createSubgraph(msg.node_ids as string[], (msg.label as string) || 'Group');
          if (sgId) {
            respond({ success: true, subgraph_id: sgId });
          } else {
            respond({ success: false, error: 'Failed to create subgraph' });
          }
          break;
        }
        case 'toggle_collapse': {
          toggleSubgraph(msg.subgraph_id as string);
          respond({ success: true });
          break;
        }
        case 'expand_subgraph': {
          expandSubgraph(msg.subgraph_id as string);
          respond({ success: true });
          break;
        }
        case 'ungroup_subgraph': {
          ungroupSubgraph(msg.subgraph_id as string);
          respond({ success: true });
          break;
        }
        case 'rename_subgraph': {
          renameSubgraph(msg.subgraph_id as string, msg.label as string);
          respond({ success: true });
          break;
        }
        case 'set_subgraph_description': {
          setSubgraphDescription(msg.subgraph_id as string, msg.description as string);
          respond({ success: true });
          break;
        }

        case 'get_dirty_tabs': {
          // Returns workspace tabs with unsaved changes. Used by the shutdown
          // endpoint's dirty-guard (POST /api/tools/shutdown) so AI/CLI tooling
          // does not silently discard unsaved work. Reads the same dirty flag
          // the UI close-confirmation (rcConfirmSave) consults — see app.tsx
          // onWindowCloseRequested.
          const dirty: Array<{ id: string; title: string }> = [];
          for (const tab of tabsRef.current) {
            if (tabStatesRef.current.get(tab.id)?.dirty) {
              dirty.push({ id: tab.id, title: tab.title });
            }
          }
          respond({ success: true, dirty_tabs: dirty });
          break;
        }

        // ===== Tab Operations =====
        case 'list_tabs': {
          const tabList = tabsRef.current.map(t => ({
            id: t.id,
            type: t.type,
            title: t.title,
            workspace_file: t.workspaceFilename || null,
            active: t.id === activeTabRef.current,
          }));
          respond({ success: true, tabs: tabList });
          break;
        }
        case 'open_flow_tab': {
          if (!openWorkspaceRef.current) {
            respond({ success: false, error: 'Workspace manager not ready' });
            break;
          }
          const wsFile = msg.workspace_file as string | undefined;
          if (wsFile) {
            // Delegate to openWorkspace (handles "already open" + tab creation + switchTab)
            await openWorkspaceRef.current(wsFile);
            // Wait for React state to propagate to tabsRef
            await new Promise(r => setTimeout(r, 100));
            const openedTab = tabsRef.current.find(t => t.workspaceFilename === wsFile);
            if (!openedTab) {
              respond({ success: false, error: `Failed to open workspace: ${wsFile}` });
              break;
            }
            respond({ success: true, tab_id: openedTab.id, title: openedTab.title, workspace_file: wsFile });
          } else {
            // Create new workspace via API, then open it
            const createResp = await fetch('/api/workspaces', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: (msg.type as string) || 'flow', title: (msg.title as string) || '' }),
            });
            if (!createResp.ok) { respond({ success: false, error: 'Failed to create workspace' }); break; }
            const ws = await createResp.json();
            await openWorkspaceRef.current(ws.filename);
            // Wait for React state to propagate to tabsRef
            await new Promise(r => setTimeout(r, 100));
            const openedTab = tabsRef.current.find(t => t.workspaceFilename === ws.filename);
            if (!openedTab) {
              respond({ success: false, error: `Failed to open created workspace: ${ws.filename}` });
              break;
            }
            respond({ success: true, tab_id: openedTab.id, title: ws.title, workspace_file: ws.filename });
          }
          break;
        }
        case 'switch_tab': {
          const swTabId = msg.tab_id as string;
          const targetTab = tabsRef.current.find(t => t.id === swTabId);
          if (!targetTab) {
            respond({ success: false, error: `Tab not found: ${swTabId}` });
            break;
          }
          if (!switchTabRef.current) {
            respond({ success: false, error: 'Tab manager not ready' });
            break;
          }
          switchTabRef.current(swTabId);
          respond({ success: true, tab_id: swTabId, title: targetTab.title });
          break;
        }
        case 'close_tab': {
          const clTabId = msg.tab_id as string;
          const tabToClose = tabsRef.current.find(t => t.id === clTabId);
          if (!tabToClose) {
            respond({ success: false, error: `Tab not found: ${clTabId}` });
            break;
          }
          if (!onCloseTabRef.current) {
            respond({ success: false, error: 'Tab manager not ready' });
            break;
          }
          onCloseTabRef.current(clTabId);
          respond({ success: true });
          break;
        }

        case 'rename_tab': {
          const folder = msg.workspace_file as string;
          const newFolder = (msg.new_workspace_file as string) || folder;
          const newTitle = msg.title as string;
          const tab = tabsRef.current.find(t => t.workspaceFilename === folder);
          if (!tab) {
            respond({ success: false, error: `Tab not found for folder: ${folder}` });
            break;
          }
          setTabs(prev => prev.map(t =>
            t.workspaceFilename === folder ? { ...t, title: newTitle, workspaceFilename: newFolder } : t
          ));
          respond({ success: true });
          break;
        }

        case 'get_modal_state': {
          const overlay = document.querySelector('.rc-modal-overlay');
          if (!overlay) {
            respond({ success: true, visible: false });
            break;
          }
          const modal = overlay.querySelector('.rc-modal');
          const title = modal?.querySelector('.rc-modal-title')?.textContent || '';
          const message = modal?.querySelector('.rc-modal-message')?.textContent || '';
          const buttons = Array.from(modal?.querySelectorAll('.rc-modal-buttons button') || [])
            .map(b => b.textContent || '');
          respond({ success: true, visible: true, title, message, buttons });
          break;
        }

        case 'dismiss_modal': {
          const modalOverlay = document.querySelector('.rc-modal-overlay');
          if (!modalOverlay) {
            respond({ success: false, error: 'No modal dialog is currently open' });
            break;
          }
          const buttonLabel = msg.button as string | undefined;
          if (!buttonLabel) {
            respond({ success: false, error: 'button parameter is required (e.g. "Save", "Don\'t Save", "Cancel")' });
            break;
          }
          const allButtons = Array.from(modalOverlay.querySelectorAll('.rc-modal-buttons button'));
          const targetBtn = allButtons.find(b => b.textContent === buttonLabel) as HTMLButtonElement | undefined;
          if (!targetBtn) {
            const available = allButtons.map(b => b.textContent).join(', ');
            respond({ success: false, error: `Button "${buttonLabel}" not found. Available: ${available}` });
            break;
          }
          targetBtn.click();
          respond({ success: true, clicked: buttonLabel });
          break;
        }

        default: {
          // Plugin tab actions (mindmap, excalidraw, etc.)
          const defActiveId = activeTabRef.current;
          const defActiveT = tabsRef.current.find(t => t.id === defActiveId);
          const pluginTabType = findTabTypeForAction(action, defActiveT?.type);
          if (pluginTabType && pluginTabType.toolActions) {
            let targetTabId = defActiveId;
            if (defActiveT?.type !== pluginTabType.id) {
              const alt = tabsRef.current.find(t => t.type === pluginTabType.id);
              if (alt) targetTabId = alt.id;
            }
            await pluginTabType.toolActions[action](msg, {
              tabId: targetTabId,
              dataRef: tabDataRef,
              tabsRef,
              activeTabRef,
              respond,
            });
            return;
          }
          respond({ success: false, error: `Unknown action: ${action}` });
        }
      }
    } catch (err: unknown) {
      respond({ success: false, error: (err as Error).message || String(err) });
    }
  }, [setNodes, setEdges, setRunning, setTooltips, updateRunStopButton, autoLayout, pushHistory,
      addNodeShared, addEdgeShared, deleteNodeShared, clearAllShared,
      createSubgraph, toggleSubgraph, expandSubgraph, ungroupSubgraph, renameSubgraph, setSubgraphDescription,
      buildSaveData, restoreFlowgraph]);

  return { handleToolCommand };
}
