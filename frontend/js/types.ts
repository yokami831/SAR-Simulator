/** Port definition for block inputs/outputs */
export interface PortDef {
  id: string
  label: string
  dtype: string
  vlen?: number
  optional?: boolean
}

/** Block parameter definition */
export interface BlockParam {
  id: string
  label: string
  dtype: 'string' | 'number' | 'code' | 'select' | 'boolean'
  default: string
  options?: Array<{ label: string; value: string }>
}

/** Block definition from the registry */
export interface BlockDefinition {
  id: string
  label: string
  category: string
  description?: string
  parameters: BlockParam[]
  inputs: PortDef[]
  outputs: PortDef[]
  code_template?: string
}

/** UI visibility config for a tab type */
export interface TabUiConfig {
  showBlockLibrary?: boolean   // default true (flow only)
  showToolbar?: boolean        // default true
  containerClass?: string      // extra CSS class on container
}

/** Props passed to plugin tab components */
export interface TabContentProps {
  tabId: string
  isActive: boolean
  dataRef: import('react').MutableRefObject<Map<string, any>>
  markDirty: () => void
  tab?: TabInstance
}

/** Context passed to plugin tab tool action handlers */
export interface TabPluginContext {
  tabId: string
  dataRef: import('react').MutableRefObject<Map<string, any>>
  tabsRef: import('react').MutableRefObject<TabInstance[]>
  activeTabRef: import('react').MutableRefObject<string>
  respond: (data: any) => void
}

/** Props passed to toolbar components (shared interface for all tab toolbars) */
export interface ToolbarProps {
  tabId: string
  tab?: TabInstance
  onSave: () => void
  onSaveAs: () => void
  onUndo: () => void
  onRedo: () => void
}

/** Tab type definition (plugin-extensible) */
export interface TabTypeDefinition {
  id: string
  label: string
  icon: string
  description: string
  defaultTitle: string
  component?: import('react').ComponentType<TabContentProps>
  /** Toolbar component for this tab type. null = no toolbar. undefined = use default. */
  toolbarComponent?: import('react').ComponentType<ToolbarProps> | null
  uiConfig?: TabUiConfig
  /** Key in workspace JSON for this tab's data (e.g. "mindmapData") */
  dataKey?: string
  /** File extension for workspace files (e.g. ".rcmind") */
  fileExtension?: string
  /** Tool command handlers dispatched by useToolCommandHandler */
  toolActions?: Record<string, (msg: any, ctx: TabPluginContext) => Promise<void>>
}

/** One tab instance (frontend state) */
export interface TabInstance {
  id: string
  type: string
  title: string
  workspaceFilename: string | null
  workspacePath: string | null
}

/** Per-tab canvas state (stored in memory, swapped on tab switch) */
export interface TabState {
  nodes: import('@xyflow/react').Node[]
  edges: import('@xyflow/react').Edge[]
  viewport: { x: number; y: number; zoom: number }
  undoStack: Array<{ nodes: import('@xyflow/react').Node[]; edges: import('@xyflow/react').Edge[]; subgraphStore: Record<string, unknown> }>
  redoStack: Array<{ nodes: import('@xyflow/react').Node[]; edges: import('@xyflow/react').Edge[]; subgraphStore: Record<string, unknown> }>
  subgraphStore: Record<string, unknown>
  dirty: boolean
  /** Per-tab panel visibility */
  panels?: {
    sidebar?: boolean    // block library
    console?: boolean
    terminal?: boolean
  }
}

/** Workspace card node data (for launcher tab) */
export interface WorkspaceCardData {
  filename: string
  title: string
  type: string
  modified: string
  description: string
  path: string
  [key: string]: unknown
}

/** Tool command from backend via WebSocket */
export interface ToolCommand {
  action: string
  request_id: string
  [key: string]: unknown
}

/** Console log entry */
export interface ConsoleLogEntry {
  id: string
  timestamp: string
  level: 'info' | 'warning' | 'error' | 'debug'
  message: string
  details: string
  source: string
}

/** Operation surface of the active Flow tab.
 * Step1 of the Flow-tab refactor: App registers its own functions here so that
 * App-level features (toolbar, keyboard shortcuts, tool commands) call into the
 * active Flow through a single ref instead of capturing function references
 * directly. In later steps the registrant moves into a FlowTab component. */
export interface FlowTabApi {
  rfInstance: () => import('@xyflow/react').ReactFlowInstance | null
  undo: () => void
  redo: () => void
  groupSelected: () => void
  ungroupSelected: () => void
  copySelected: () => void
  pasteClipboard: () => void
  cutSelected: () => void
  deleteSelected: () => void
  clearAllShared: () => void
  pushHistory: () => void
  // node/subgraph ops (used by tool commands)
  addNodeShared: (blockDef: import('./blockLibraryData.js').BlockData, position?: { x: number; y: number }, paramOverrides?: Record<string, string>) => string
  addEdgeShared: (source: string, sourceHandle: string, target: string, targetHandle: string) => string
  deleteNodeShared: (nodeId: string) => void
  autoLayout: () => void
  createSubgraph: (nodeIds: string[], label?: string) => string | null
  toggleSubgraph: (sgId: string) => void
  expandSubgraph: (sgId: string) => void
  ungroupSubgraph: (sgId: string) => void
  renameSubgraph: (sgId: string, newLabel: string) => void
  setSubgraphDescription: (sgId: string, desc: string) => void
  buildSaveData: (saveName: string) => Record<string, unknown>
  restoreFlowgraph: (data: Record<string, unknown>, fileName: string) => void
  setNodes: import('react').Dispatch<import('react').SetStateAction<import('@xyflow/react').Node[]>>
  setEdges: import('react').Dispatch<import('react').SetStateAction<import('@xyflow/react').Edge[]>>
  setTooltips: import('react').Dispatch<import('react').SetStateAction<Array<Record<string, unknown>>>>
  /** Sidebar double-click / D&D add. Forwarded so App's sidebar adds into the active Flow. */
  addBlockToCanvas: (blockDef: import('./blockLibraryData.js').BlockData) => string
}

/** Props passed to the FlowTab component (Step2b extraction).
 * App owns the shared refs (rfInstance/subgraphStore/history) because
 * useTabManager writes to them directly; FlowTab receives them and threads
 * them into its own useUndoRedo / useNodeOperations / etc. */
export interface FlowTabProps {
  /** Unique key for this Flow tab instance. FlowTab is mounted with key={tabId}
   *  so each tab gets a fresh component instance that self-initialises from the
   *  initial* props below — no post-mount restore from App is needed. */
  tabId: string
  initialNodes: import('@xyflow/react').Node[]
  initialEdges: import('@xyflow/react').Edge[]
  /** Initial viewport for this tab; passed to ReactFlow as defaultViewport.
   *  When undefined (brand-new tab) FlowTab falls back to fitView. */
  initialViewport?: { x: number; y: number; zoom: number }
  initialSubgraphStore?: Record<string, unknown>
  initialUndoStack?: Array<{ nodes: unknown[]; edges: unknown[]; subgraphStore: Record<string, unknown> }>
  initialRedoStack?: Array<{ nodes: unknown[]; edges: unknown[]; subgraphStore: Record<string, unknown> }>
  rfInstance: import('react').MutableRefObject<import('@xyflow/react').ReactFlowInstance | null>
  subgraphStoreRef: import('react').MutableRefObject<Record<string, unknown>>
  skipHistoryRef: import('react').MutableRefObject<boolean>
  historyRef: import('react').MutableRefObject<Array<{ nodes: unknown[]; edges: unknown[]; subgraphStore: Record<string, unknown> }>>
  futureRef: import('react').MutableRefObject<Array<{ nodes: unknown[]; edges: unknown[]; subgraphStore: Record<string, unknown> }>>
  markDirty: () => void
  registerApi: (api: FlowTabApi) => void
  /** Called on unmount so App can null the activeFlowApiRef when it still
   *  points at this instance's API (identity-checked to avoid clobbering a
   *  newly-mounted tab). */
  unregisterApi: (api: FlowTabApi) => void
  /** Persistence operations from App's useFlowPersistence (which stays in App
   *  because it depends on App-level tab state). FlowTab includes them in the
   *  registered FlowTabApi so the App-level wrappers resolve to them. */
  buildSaveData: (saveName: string) => Record<string, unknown>
  restoreFlowgraph: (data: Record<string, unknown>, fileName: string) => void
  setRunning: import('react').Dispatch<import('react').SetStateAction<boolean>>
  setStepping: import('react').Dispatch<import('react').SetStateAction<boolean>>
  setNextStepNodeId: import('react').Dispatch<import('react').SetStateAction<string | null>>
  updateToolbarButtons: (mode: 'idle' | 'running' | 'stepping') => void
  running: boolean
  runningRef: import('react').MutableRefObject<boolean>
  steppingRef: import('react').MutableRefObject<boolean>
}

/** React Flow node data for HiyoCanvas blocks */
export interface CanvasNodeData {
  blockType: string
  label: string
  category?: string
  parameters: Record<string, string>
  inputs: PortDef[]
  outputs: PortDef[]
  isSubgraph?: boolean
  collapsed?: boolean
  childNodeIds?: string[]
  width?: number
  height?: number
  [key: string]: unknown
}
