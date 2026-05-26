/**
 * excalidraw.tsx - Excalidraw tab plugin (self-registering)
 *
 * Registers its tab type, component, and tool actions via tabRegistry.
 * No excalidraw-specific code needed in app.tsx or useToolCommandHandler.
 */

import { useState, useEffect, useCallback, useRef, createElement as h, Fragment } from 'react'
import { Excalidraw, convertToExcalidrawElements, THEME, MainMenu } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawImperativeAPI, ExcalidrawElement } from '@excalidraw/excalidraw/types'
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw'
import { registerTabType, registerTabComponent, registerToolbarComponent } from './tabRegistry.js'
import type { TabContentProps, TabPluginContext } from './types.js'

// ===== Helpers =====

/**
 * convertToExcalidrawElements rewrites element IDs. This function builds
 * an old→new ID map and patches containerId / boundElements references
 * so that bound text relationships survive the conversion.
 */
function convertAndFixRefs(skeletons: any[]): ReturnType<typeof convertToExcalidrawElements> {
  // Remember original IDs in order
  const oldIds = skeletons.map((s: any) => s.id as string | undefined)
  const elements = convertToExcalidrawElements(skeletons)
  // Build old→new ID map
  const idMap = new Map<string, string>()
  oldIds.forEach((oldId, i) => {
    if (oldId && elements[i]) {
      idMap.set(oldId, (elements[i] as any).id)
    }
  })
  // Patch references
  for (const el of elements as any[]) {
    if (el.containerId && idMap.has(el.containerId)) {
      el.containerId = idMap.get(el.containerId)
    }
    if (Array.isArray(el.boundElements)) {
      el.boundElements = el.boundElements.map((ref: any) => ({
        ...ref,
        id: idMap.get(ref.id) ?? ref.id,
      }))
    }
  }
  return elements
}

// ===== Tool Actions (plugin handlers for WebSocket commands) =====

function getAPI(): ExcalidrawImperativeAPI | null {
  return window.__excalidrawAPI ?? null
}

/** Summarize a single element for compact get_elements response */
function summarizeElement(el: any, allElements: readonly any[]): any {
  const s: any = {
    id: el.id,
    type: el.type,
    x: Math.round(el.x),
    y: Math.round(el.y),
    width: Math.round(el.width ?? 0),
    height: Math.round(el.height ?? 0),
  }
  if (el.strokeColor) s.strokeColor = el.strokeColor
  if (el.backgroundColor && el.backgroundColor !== 'transparent') s.backgroundColor = el.backgroundColor
  if (el.type === 'text') {
    s.text = el.text
    s.fontSize = el.fontSize
  }
  // Resolve bound text as label
  if (el.boundElements?.length) {
    const boundText = el.boundElements.find((b: any) => b.type === 'text')
    if (boundText) {
      const textEl = allElements.find((e: any) => e.id === boundText.id)
      if (textEl) s.label = textEl.text
    }
  }
  // Arrow bindings
  if (el.type === 'arrow') {
    if (el.startBinding) s.startBinding = el.startBinding.elementId
    if (el.endBinding) s.endBinding = el.endBinding.elementId
  }
  return s
}

/** Return all scene elements (summary mode — compact, label-resolved) */
async function handleGetElements(msg: any, ctx: TabPluginContext): Promise<void> {
  const api = getAPI()
  let rawElements: readonly any[]
  if (api) {
    rawElements = api.getSceneElements()
  } else {
    const data = ctx.dataRef.current.get(ctx.tabId)
    rawElements = data?.elements ?? []
  }
  // Filter out bound text elements (they appear as label on parent) and deleted
  const visibleElements = rawElements.filter((el: any) => !el.isDeleted && !el.containerId)
  const summaries = visibleElements.map((el: any) => summarizeElement(el, rawElements))
  ctx.respond({ success: true, elements: summaries, count: summaries.length })
}

/** Add files (images) to the Excalidraw scene if provided */
function addFilesToScene(api: ExcalidrawImperativeAPI, files: any): void {
  if (!files || typeof files !== 'object') return
  const fileArray = Array.isArray(files) ? files : Object.values(files)
  if (fileArray.length > 0) {
    api.addFiles(fileArray as any)
  }
}

/** Replace entire scene */
async function handleSetData(msg: any, ctx: TabPluginContext): Promise<void> {
  const rawElements = msg.elements ?? msg.excalidrawData?.elements ?? []
  const elements = convertAndFixRefs(rawElements)
  const appState = msg.appState ?? msg.excalidrawData?.appState
  const files = msg.files ?? msg.excalidrawData?.files
  const api = getAPI()
  if (api) {
    const sceneData: any = { elements }
    if (appState) sceneData.appState = appState
    api.updateScene(sceneData)
    addFilesToScene(api, files)
    setTimeout(() => api.scrollToContent(undefined, { fitToViewport: true }), 100)
  }
  ctx.dataRef.current.set(ctx.tabId, { elements: JSON.parse(JSON.stringify(elements)) })
  const activeTab = ctx.tabsRef.current.find(t => t.id === ctx.tabId)
  ctx.respond({ success: true, workspaceFilename: activeTab?.workspaceFilename ?? null })
}

/** Get single element by ID */
async function handleGetElement(msg: any, ctx: TabPluginContext): Promise<void> {
  const elementId = msg.node_id || msg.elementId
  if (!elementId) {
    ctx.respond({ success: false, error: 'node_id or elementId is required' })
    return
  }
  const api = getAPI()
  let elements: readonly any[]
  if (api) {
    elements = api.getSceneElements()
  } else {
    const data = ctx.dataRef.current.get(ctx.tabId)
    elements = data?.elements ?? []
  }
  const el = elements.find((e: any) => e.id === elementId)
  if (!el) {
    ctx.respond({ success: false, error: `Element '${elementId}' not found` })
    return
  }
  ctx.respond({ success: true, element: JSON.parse(JSON.stringify(el)) })
}

/** Add element(s) to the scene */
async function handleAddElement(msg: any, ctx: TabPluginContext): Promise<void> {
  const api = getAPI()
  if (!api) {
    ctx.respond({ success: false, error: 'Excalidraw not active (tab must be visible)' })
    return
  }
  const input = msg.element || msg.elements
  if (!input) {
    ctx.respond({ success: false, error: 'element or elements is required' })
    return
  }
  const skeletons = Array.isArray(input) ? input : [input]
  // convertToExcalidrawElements fills in required fields (id, version, seed, etc.)
  const newElements = convertAndFixRefs(skeletons)
  const existing = api.getSceneElements()
  api.updateScene({ elements: [...existing, ...newElements] })
  addFilesToScene(api, msg.files)

  // Update dataRef
  const updated = api.getSceneElements()
  ctx.dataRef.current.set(ctx.tabId, { elements: JSON.parse(JSON.stringify(updated)) })

  const ids = newElements.map((e: any) => e.id)
  ctx.respond({ success: true, elementIds: ids, message: `Added ${ids.length} element(s)` })
}

/** Update element properties by ID */
async function handleUpdateElement(msg: any, ctx: TabPluginContext): Promise<void> {
  const api = getAPI()
  if (!api) {
    ctx.respond({ success: false, error: 'Excalidraw not active (tab must be visible)' })
    return
  }
  const elementId = msg.node_id || msg.elementId
  if (!elementId) {
    ctx.respond({ success: false, error: 'node_id or elementId is required' })
    return
  }
  const props = msg.props || msg.properties
  if (!props) {
    ctx.respond({ success: false, error: 'props is required (object with properties to update)' })
    return
  }
  const elements = api.getSceneElements()
  const targetEl = elements.find((el: any) => el.id === elementId)
  if (!targetEl) {
    ctx.respond({ success: false, error: `Element '${elementId}' not found` })
    return
  }

  // Determine if we need to update bound text (label change)
  const newLabel = props.label ?? props.text
  const boundTextIds = new Set<string>()
  if (newLabel !== undefined && targetEl.boundElements?.length) {
    for (const ref of targetEl.boundElements) {
      if (ref.type === 'text') boundTextIds.add(ref.id)
    }
  }

  // Remove label/text from props applied to parent (these are bound text properties)
  const parentProps = { ...props }
  delete parentProps.label
  delete parentProps.text

  const updated = elements.map((el: any) => {
    if (el.id === elementId) {
      return { ...el, ...parentProps, version: (el.version || 0) + 1 }
    }
    // Update bound text element if label changed
    if (boundTextIds.has(el.id) && newLabel !== undefined) {
      return { ...el, text: newLabel, originalText: newLabel, version: (el.version || 0) + 1 }
    }
    return el
  })
  api.updateScene({ elements: updated })
  ctx.dataRef.current.set(ctx.tabId, { elements: JSON.parse(JSON.stringify(api.getSceneElements())) })
  ctx.respond({ success: true, message: `Updated element ${elementId}` })
}

/** Remove element by ID */
async function handleRemoveElement(msg: any, ctx: TabPluginContext): Promise<void> {
  const api = getAPI()
  if (!api) {
    ctx.respond({ success: false, error: 'Excalidraw not active (tab must be visible)' })
    return
  }
  const elementId = msg.node_id || msg.elementId
  if (!elementId) {
    ctx.respond({ success: false, error: 'node_id or elementId is required' })
    return
  }
  const elements = api.getSceneElements()
  const targetEl = elements.find((el: any) => el.id === elementId)
  if (!targetEl) {
    ctx.respond({ success: false, error: `Element '${elementId}' not found` })
    return
  }

  // Collect IDs to remove: target + its bound text elements
  const toRemove = new Set([elementId])
  if (targetEl.boundElements?.length) {
    for (const ref of targetEl.boundElements) {
      if (ref.type === 'text') toRemove.add(ref.id)
    }
  }

  const filtered = elements.filter((el: any) => !toRemove.has(el.id))
  api.updateScene({ elements: filtered })
  ctx.dataRef.current.set(ctx.tabId, { elements: JSON.parse(JSON.stringify(api.getSceneElements())) })
  ctx.respond({ success: true, message: `Removed element ${elementId}` })
}

/** Get currently selected elements */
async function handleGetSelection(msg: any, ctx: TabPluginContext): Promise<void> {
  const api = getAPI()
  if (!api) {
    ctx.respond({ success: false, error: 'Excalidraw not active (tab must be visible)' })
    return
  }
  const appState = api.getAppState()
  const selectedIds = Object.keys(appState.selectedElementIds || {}).filter(
    id => appState.selectedElementIds[id]
  )
  const elements = api.getSceneElements()
  const selected = elements.filter((el: any) => selectedIds.includes(el.id))
  ctx.respond({
    success: true,
    selectedIds,
    selectedElements: JSON.parse(JSON.stringify(selected)),
    count: selected.length,
  })
}

/** Clear the entire scene */
async function handleClear(msg: any, ctx: TabPluginContext): Promise<void> {
  const api = getAPI()
  if (api) {
    api.resetScene()
  }
  ctx.dataRef.current.set(ctx.tabId, { elements: [] })
  ctx.respond({ success: true, message: 'Scene cleared' })
}

/** Convert Mermaid syntax and add to scene */
async function mermaidToScene(api: ExcalidrawImperativeAPI, mermaidText: string): Promise<{ elements: any[]; count: number }> {
  const { elements: skeletons, files } = await parseMermaidToExcalidraw(mermaidText, {
    themeVariables: { fontSize: '16px' },
  })
  const newElements = convertAndFixRefs(skeletons as any[])

  // Offset below existing content
  const existing = api.getSceneElements()
  if (existing.length > 0) {
    const maxY = existing.reduce((max, el: any) => Math.max(max, (el.y || 0) + (el.height || 0)), 0)
    const offsetY = maxY + 80
    for (const el of newElements as any[]) {
      el.y = (el.y || 0) + offsetY
    }
  }

  api.updateScene({ elements: [...existing, ...newElements] })
  if (files && Object.keys(files).length > 0) {
    api.addFiles(Object.values(files) as any)
  }
  setTimeout(() => api.scrollToContent(newElements as any, { fitToContent: true }), 100)
  return { elements: newElements as any[], count: newElements.length }
}

/** Import Mermaid diagram via WebSocket tool action */
async function handleImportMermaid(msg: any, ctx: TabPluginContext): Promise<void> {
  const api = getAPI()
  if (!api) {
    ctx.respond({ success: false, error: 'Excalidraw not active (tab must be visible)' })
    return
  }
  const definition = msg.mermaid || msg.definition
  if (!definition) {
    ctx.respond({ success: false, error: 'mermaid (string) is required' })
    return
  }
  try {
    const { elements, count } = await mermaidToScene(api, definition)
    ctx.dataRef.current.set(ctx.tabId, { elements: JSON.parse(JSON.stringify(api.getSceneElements())) })
    const ids = elements.map((e: any) => e.id)
    ctx.respond({ success: true, elementIds: ids, count, message: `Imported ${count} elements from Mermaid` })
  } catch (err: any) {
    ctx.respond({ success: false, error: `Mermaid parse error: ${err.message || err}` })
  }
}

/** Convert compact structure JSON {nodes, edges, annotations} to Excalidraw elements */
function structureToElements(diagram: any): any[] {
  const elements: any[] = []
  const nodeMap: Record<string, { x: number; y: number; w: number; h: number }> = {}

  // Title
  if (diagram.title) {
    const t = diagram.title
    elements.push({
      type: 'text',
      x: t.x ?? 400, y: t.y ?? 10,
      text: t.text,
      fontSize: t.fontSize ?? 24,
      strokeColor: t.color ?? '#ffffff',
    })
  }

  // Nodes
  const typeMap: Record<string, string> = { rect: 'rectangle', ellipse: 'ellipse', diamond: 'diamond' }
  for (const n of diagram.nodes ?? []) {
    nodeMap[n.id] = { x: n.x, y: n.y, w: n.w, h: n.h }
    const el: any = {
      type: typeMap[n.type] ?? n.type,
      x: n.x, y: n.y,
      width: n.w, height: n.h,
      strokeColor: n.stroke ?? '#ffffff',
      strokeWidth: n.strokeWidth ?? 2,
    }
    if (n.bg) el.backgroundColor = n.bg
    if (n.roundness) el.roundness = { type: 3 }
    if (n.text) {
      el.label = { text: n.text, fontSize: n.fontSize ?? 15, strokeColor: n.stroke ?? '#ffffff' }
    }
    elements.push(el)
  }

  // Edges
  for (const e of diagram.edges ?? []) {
    const src = nodeMap[e.from]
    const dst = nodeMap[e.to]
    if (!src || !dst) continue

    let sx: number, sy: number, ex: number, ey: number
    if (e.dir === 'down') {
      sx = src.x + src.w / 2; sy = src.y + src.h
      ex = dst.x + dst.w / 2; ey = dst.y
    } else if (e.dir === 'up') {
      sx = src.x + src.w / 2; sy = src.y
      ex = dst.x + dst.w / 2; ey = dst.y + dst.h
    } else if (e.dir === 'left') {
      sx = src.x; sy = src.y + src.h / 2
      ex = dst.x + dst.w; ey = dst.y + dst.h / 2
    } else {
      // Default: right
      sx = src.x + src.w; sy = src.y + src.h / 2
      ex = dst.x; ey = dst.y + dst.h / 2
    }

    const arrow: any = {
      type: 'arrow',
      x: sx, y: sy,
      points: [[0, 0], [ex - sx, ey - sy]],
      strokeColor: e.color ?? '#ffffff',
      strokeWidth: e.strokeWidth ?? 2,
    }
    if (e.text) {
      arrow.label = { text: e.text, fontSize: e.fontSize ?? 14, strokeColor: e.color ?? '#888888' }
    }
    elements.push(arrow)
  }

  // Annotations (free text/labels)
  for (const a of diagram.annotations ?? []) {
    elements.push({
      type: 'text',
      x: a.x ?? 0, y: a.y ?? 0,
      text: a.text,
      fontSize: a.fontSize ?? 14,
      strokeColor: a.color ?? '#ffffff',
    })
  }

  return elements
}

/** Import structure diagram via WebSocket tool action */
async function handleImportStructure(msg: any, ctx: TabPluginContext): Promise<void> {
  const api = getAPI()
  if (!api) {
    ctx.respond({ success: false, error: 'Excalidraw not active (tab must be visible)' })
    return
  }
  const diagram = msg.diagram || msg.structure
  if (!diagram || !diagram.nodes) {
    ctx.respond({ success: false, error: 'diagram (object with nodes array) is required' })
    return
  }

  const skeletons = structureToElements(diagram)
  const newElements = convertAndFixRefs(skeletons)

  // Offset below existing content if requested
  const existing = api.getSceneElements()
  if (existing.length > 0 && msg.append !== false) {
    const maxY = existing.reduce((max, el: any) => Math.max(max, (el.y || 0) + (el.height || 0)), 0)
    const offsetY = maxY + 80
    for (const el of newElements as any[]) {
      el.y = (el.y || 0) + offsetY
    }
    api.updateScene({ elements: [...existing, ...newElements] })
  } else {
    api.updateScene({ elements: newElements })
  }

  setTimeout(() => api.scrollToContent(newElements as any, { fitToContent: true }), 100)
  ctx.dataRef.current.set(ctx.tabId, { elements: JSON.parse(JSON.stringify(api.getSceneElements())) })
  const ids = newElements.map((e: any) => e.id)
  ctx.respond({ success: true, elementIds: ids, count: ids.length, message: `Imported ${ids.length} elements from structure` })
}

// ===== Tab Type Registration =====

registerTabType('excalidraw', {
  label: 'Drawing',
  icon: '✏️',
  description: 'Excalidraw whiteboard for sketching and diagrams',
  defaultTitle: 'New Drawing',
  uiConfig: { showBlockLibrary: false, showToolbar: true, containerClass: 'excalidraw-mode' },
  dataKey: 'excalidrawData',
  fileExtension: '.rcexcalidraw',
  toolActions: {
    get_elements: handleGetElements,
    set_data: handleSetData,
    get_element: handleGetElement,
    add_element: handleAddElement,
    remove_element: handleRemoveElement,
    update_element: handleUpdateElement,
    clear: handleClear,
    get_selection: handleGetSelection,
    import_mermaid: handleImportMermaid,
    import_structure: handleImportStructure,
  },
})

// ===== Mermaid Import Dialog =====

interface MermaidImportDialogProps {
  api: ExcalidrawImperativeAPI
  onClose: () => void
  onImported: () => void
}

function MermaidImportDialog({ api, onClose, onImported }: MermaidImportDialogProps) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleConvert = async () => {
    if (!text.trim()) return
    setError('')
    setLoading(true)
    try {
      await mermaidToScene(api, text.trim())
      onImported()
      onClose()
    } catch (err: any) {
      setError(err.message || 'Failed to parse Mermaid syntax')
    } finally {
      setLoading(false)
    }
  }

  return h('div', { className: 'rc-modal-overlay', onClick: (e: any) => { if (e.target === e.currentTarget) onClose() } },
    h('div', { className: 'rc-modal', style: { minWidth: 440, maxWidth: 560 } },
      h('div', { className: 'rc-modal-title' }, 'Import Mermaid Diagram'),
      h('div', { className: 'rc-modal-message' }, 'Paste Mermaid syntax below. Flowcharts are converted to editable shapes; other diagram types render as images.'),
      h('textarea', {
        className: 'mermaid-textarea',
        value: text,
        onChange: (e: any) => setText(e.target.value),
        placeholder: 'graph TD\n    A[Start] --> B{Decision}\n    B -->|Yes| C[OK]\n    B -->|No| D[Retry]\n    D --> B',
        disabled: loading,
        autoFocus: true,
      }),
      error && h('div', { className: 'mermaid-error' }, error),
      h('div', { className: 'rc-modal-buttons', style: { marginTop: 12 } },
        h('button', { onClick: onClose, disabled: loading }, 'Cancel'),
        h('button', { className: 'primary', onClick: handleConvert, disabled: loading || !text.trim() },
          loading ? 'Converting...' : 'Convert'),
      ),
    ),
  )
}

// ===== Component =====

interface ExcalidrawTabProps {
  initialData?: { elements?: any[]; appState?: any }
  onDataChange?: (data: { elements: any[] }) => void
  visible: boolean
}

const DRAG_THRESHOLD = 5

function ExcalidrawTab({ initialData, onDataChange, visible }: ExcalidrawTabProps) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [showMermaid, setShowMermaid] = useState(false)
  const panRef = useRef<{ startX: number; startY: number; scrollX: number; scrollY: number; isPanning: boolean } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Suppress context menu during pan using capture phase (before Excalidraw's handler)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handler = (e: MouseEvent) => {
      if (panRef.current?.isPanning) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }
    el.addEventListener('contextmenu', handler, true)  // capture phase
    return () => el.removeEventListener('contextmenu', handler, true)
  }, [])

  // Store API globally for tool actions
  useEffect(() => {
    if (api) {
      window.__excalidrawAPI = api
    }
    return () => {
      if (window.__excalidrawAPI === api) {
        window.__excalidrawAPI = null
      }
    }
  }, [api])

  // Trigger resize when tab becomes visible so Excalidraw recalculates canvas size
  useEffect(() => {
    if (visible && api) {
      setTimeout(() => {
        api.refresh()
        window.dispatchEvent(new Event('resize'))
      }, 50)
    }
  }, [visible, api])

  // onChange handler — save data to dataRef
  const handleChange = useCallback(
    (elements: readonly ExcalidrawElement[]) => {
      if (!visible) return
      const data = { elements: JSON.parse(JSON.stringify(elements)) }
      onDataChange?.(data)
    },
    [visible, onDataChange],
  )

  // Notify parent of data change after Mermaid import
  const handleMermaidImported = useCallback(() => {
    if (!api) return
    const data = { elements: JSON.parse(JSON.stringify(api.getSceneElements())) }
    onDataChange?.(data)
  }, [api, onDataChange])

  return h(Fragment, null,
    h('div', {
      ref: containerRef,
      className: 'excalidraw-container',
      onPointerDown: (e: React.PointerEvent) => {
        if (e.button === 2 && api) {
          const { scrollX, scrollY } = api.getAppState()
          panRef.current = { startX: e.clientX, startY: e.clientY, scrollX, scrollY, isPanning: false }
        }
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (!panRef.current || !api) return
        const dx = e.clientX - panRef.current.startX
        const dy = e.clientY - panRef.current.startY
        if (!panRef.current.isPanning && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
          panRef.current.isPanning = true
        }
        if (panRef.current.isPanning) {
          api.updateScene({ appState: {
            scrollX: panRef.current.scrollX + dx,
            scrollY: panRef.current.scrollY + dy,
          } })
        }
      },
      onPointerUp: () => {
        // Delay clearing so contextmenu handler (fired after pointerup) can still check isPanning
        setTimeout(() => { panRef.current = null }, 0)
      },
    },
      h(Excalidraw, {
        excalidrawAPI: (api: ExcalidrawImperativeAPI) => setApi(api),
        initialData: initialData ? {
          elements: initialData.elements ?? [],
          appState: { ...initialData.appState, theme: THEME.DARK, viewModeEnabled: false },
        } : { appState: { theme: THEME.DARK, viewModeEnabled: false } },
        theme: THEME.DARK,
        viewModeEnabled: false,
        UIOptions: {
          canvasActions: {
            loadScene: false,
            export: false,
            saveAsImage: false,
            saveToActiveFile: false,
            saveFileToDisk: false,
          },
        },
        onChange: handleChange,
        renderTopRightUI: () => h('button', {
          className: 'mermaid-import-btn',
          onClick: () => setShowMermaid(true),
          title: 'Import Mermaid diagram',
        }, 'Mermaid'),
      } as any,
        // MainMenu: add Save/Save As to Excalidraw's hamburger menu
        h(MainMenu as any, null,
          h((MainMenu as any).Item, {
            onSelect: () => { window.__hiyoSave?.(); return false },
            shortcut: 'Ctrl+S',
          }, 'Save'),
          h((MainMenu as any).Item, {
            onSelect: () => { window.__hiyoSaveAs?.(); return false },
            shortcut: 'Ctrl+Shift+S',
          }, 'Save As...'),
          h((MainMenu as any).Separator),
          h((MainMenu as any).DefaultItems.ToggleTheme),
          h((MainMenu as any).DefaultItems.ChangeCanvasBackground),
        ),
      ),
    ),
    showMermaid && api && h(MermaidImportDialog, {
      api,
      onClose: () => setShowMermaid(false),
      onImported: handleMermaidImported,
    }),
  )
}

// ===== Wrapper + Component Registration =====

function ExcalidrawTabWrapper({ tabId, dataRef, markDirty }: TabContentProps) {
  // Track last-saved snapshot to avoid false dirty flags from Excalidraw's
  // continuous onChange (fires on cursor/selection changes, not just edits).
  const snapshotRef = useRef('')
  const initData = dataRef.current.get(tabId)
  if (!snapshotRef.current && initData) {
    snapshotRef.current = JSON.stringify(initData.elements ?? [])
  }

  // Expose resetSnapshot so clearDirty can sync after save
  useEffect(() => {
    ;window.__excalidrawResetSnapshot = () => {
      const cur = dataRef.current.get(tabId)
      snapshotRef.current = JSON.stringify(cur?.elements ?? [])
    }
    return () => { delete window.__excalidrawResetSnapshot }
  }, [tabId, dataRef])

  return h(ExcalidrawTab, {
    visible: true,
    initialData: initData,
    onDataChange: (data: { elements: any[] }) => {
      dataRef.current.set(tabId, data)
      const serialized = JSON.stringify(data.elements)
      if (serialized !== snapshotRef.current) {
        markDirty()
      }
    },
    key: tabId,
  })
}

registerTabComponent('excalidraw', ExcalidrawTabWrapper)
registerToolbarComponent('excalidraw', null)
