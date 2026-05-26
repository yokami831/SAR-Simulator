/**
 * mindmap.tsx - MindMap tab plugin (self-registering)
 *
 * Registers its tab type, component, and tool actions via tabRegistry.
 * No mindmap-specific code needed in app.tsx or useToolCommandHandler.
 */

import { useEffect, useRef, useState, useCallback, createElement as h, Fragment } from 'react'
// (createPortal removed — toolbar portal no longer used)
import MindElixir from 'mind-elixir'
import 'mind-elixir/style'
import type { MindElixirInstance, MindElixirData } from 'mind-elixir'
import { registerTabType, registerTabComponent, registerToolbarComponent } from './tabRegistry.js'
import type { TabContentProps, TabPluginContext } from './types.js'
import { MindmapToolbar } from './components/MindmapToolbar.js'

// ===== Helpers =====

/** Ensure all nodes with children have explicit expanded field (default true).
 *  MindElixir's getData() omits expanded for expanded nodes (undefined),
 *  causing all nodes to appear expanded on reload. */
function ensureExpandedField(node: any): void {
  if (node.children && node.children.length > 0) {
    if (node.expanded === undefined) node.expanded = true
    for (const child of node.children) ensureExpandedField(child)
  }
}

// ===== Tool Actions (plugin handlers for WebSocket commands) =====

async function handleGetMindmap(msg: any, ctx: TabPluginContext): Promise<void> {
  const me = window.__mindElixirInstance as MindElixirInstance | null
  if (me) {
    const data = me.getData()
    ;(data as any).direction = (me as any).direction
    ctx.respond({ success: true, mindmapData: data })
  } else {
    // Tab not active — read from in-memory store
    const tab = ctx.tabsRef.current.find(t => t.id === ctx.tabId)
    const mmData = ctx.dataRef.current.get(ctx.tabId)
    ctx.respond({ success: true, mindmapData: mmData || null })
  }
}

async function handleSetMindmap(msg: any, ctx: TabPluginContext): Promise<void> {
  const me = window.__mindElixirInstance as MindElixirInstance | null
  if (me && msg.mindmapData) {
    me.refresh(msg.mindmapData)
    me.toCenter()
  }
  if (ctx.tabId) {
    ctx.dataRef.current.set(ctx.tabId, msg.mindmapData)
  }
  const activeTab = ctx.tabsRef.current.find(t => t.id === ctx.tabId)
  ctx.respond({ success: true, workspaceFilename: activeTab?.workspaceFilename || null })
}

async function handleGetMindmapNode(msg: any, ctx: TabPluginContext): Promise<void> {
  const me = window.__mindElixirInstance as MindElixirInstance | null
  const elementId = msg.node_id || msg.elementId
  if (!elementId) {
    ctx.respond({ success: false, error: 'node_id or elementId is required' })
    return
  }

  // Helper: recursively find node by ID in the mind map tree
  const findNode = (node: any, id: string): any => {
    if (node.id === id) return node
    for (const child of (node.children || [])) {
      const found = findNode(child, id)
      if (found) return found
    }
    return null
  }

  let data: any = null
  if (me) {
    data = me.getData()
  } else {
    data = ctx.dataRef.current.get(ctx.tabId)
  }
  if (!data?.nodeData) {
    ctx.respond({ success: false, error: 'No mindmap data available' })
    return
  }
  const node = findNode(data.nodeData, elementId)
  if (!node) {
    ctx.respond({ success: false, error: `Node '${elementId}' not found` })
    return
  }
  ctx.respond({
    success: true,
    element: {
      id: node.id,
      topic: node.topic,
      style: node.style,
      tags: node.tags,
      icons: node.icons,
      hyperLink: node.hyperLink,
      note: node.note,
      branchColor: node.branchColor,
      childCount: (node.children || []).length,
      children: (node.children || []).map((c: any) => ({ id: c.id, topic: c.topic })),
    },
  })
}

async function handleAddMindmapNode(msg: any, ctx: TabPluginContext): Promise<void> {
  const me = window.__mindElixirInstance as MindElixirInstance | null
  if (!me) {
    ctx.respond({ success: false, error: 'Mindmap not active (tab must be visible)' })
    return
  }
  const parentId = msg.parentId || msg.parent_id
  if (!parentId) {
    ctx.respond({ success: false, error: 'parentId is required' })
    return
  }
  const topic = msg.topic || 'New Node'
  const childId = msg.id || `mm-${Date.now()}`

  // findEle returns the DOM element MindElixir needs (addChild expects DOM, not data obj)
  const parentEl = me.findEle(parentId)
  if (!parentEl) {
    ctx.respond({ success: false, error: `Parent node '${parentId}' not found` })
    return
  }

  // Add child using MindElixir API
  me.addChild(parentEl, { id: childId, topic })

  // Update dataRef
  const data = me.getData()
  ;(data as any).direction = (me as any).direction
  ctx.dataRef.current.set(ctx.tabId, data)

  ctx.respond({ success: true, elementId: childId, message: `Added: ${topic} (${childId})` })
}

async function handleRemoveMindmapNode(msg: any, ctx: TabPluginContext): Promise<void> {
  const me = window.__mindElixirInstance as MindElixirInstance | null
  if (!me) {
    ctx.respond({ success: false, error: 'Mindmap not active (tab must be visible)' })
    return
  }
  const elementId = msg.node_id || msg.elementId
  if (!elementId) {
    ctx.respond({ success: false, error: 'node_id or elementId is required' })
    return
  }
  if (elementId === me.nodeData.id) {
    ctx.respond({ success: false, error: 'Cannot remove root node' })
    return
  }

  const nodeEl = me.findEle(elementId)
  if (!nodeEl) {
    ctx.respond({ success: false, error: `Node '${elementId}' not found` })
    return
  }

  me.removeNodes([nodeEl])

  // Update dataRef
  const data = me.getData()
  ;(data as any).direction = (me as any).direction
  ctx.dataRef.current.set(ctx.tabId, data)

  ctx.respond({ success: true, message: `Removed: ${elementId}` })
}

async function handleUpdateMindmapNode(msg: any, ctx: TabPluginContext): Promise<void> {
  const me = window.__mindElixirInstance as MindElixirInstance | null
  if (!me) {
    ctx.respond({ success: false, error: 'Mindmap not active (tab must be visible)' })
    return
  }
  const elementId = msg.node_id || msg.elementId
  if (!elementId) {
    ctx.respond({ success: false, error: 'node_id or elementId is required' })
    return
  }
  // Build patch data from all supported fields
  const patchData: any = {}
  const changes: string[] = []

  if (msg.topic !== undefined) { patchData.topic = msg.topic; changes.push(`topic="${msg.topic}"`) }
  if (msg.style !== undefined) { patchData.style = msg.style; changes.push('style') }
  if (msg.tags !== undefined) { patchData.tags = msg.tags; changes.push('tags') }
  if (msg.icons !== undefined) { patchData.icons = msg.icons; changes.push('icons') }
  if (msg.hyperLink !== undefined) { patchData.hyperLink = msg.hyperLink; changes.push('hyperLink') }
  if (msg.note !== undefined) { patchData.note = msg.note; changes.push('note') }
  if (msg.branchColor !== undefined) { patchData.branchColor = msg.branchColor; changes.push('branchColor') }
  const expanded = msg.expanded

  if (Object.keys(patchData).length === 0 && expanded === undefined) {
    ctx.respond({ success: false, error: 'At least one property to update is required' })
    return
  }

  const nodeEl = me.findEle(elementId)
  if (!nodeEl) {
    ctx.respond({ success: false, error: `Node '${elementId}' not found` })
    return
  }

  // Apply reshape if there are patch fields
  if (Object.keys(patchData).length > 0) {
    me.reshapeNode(nodeEl, patchData)
  }

  // Expand/collapse via MindElixir API
  if (expanded !== undefined) {
    me.expandNode(nodeEl, !!expanded)
    changes.push(expanded ? 'expanded' : 'collapsed')
  }

  // Update dataRef
  const data = me.getData()
  ;(data as any).direction = (me as any).direction
  ctx.dataRef.current.set(ctx.tabId, data)

  ctx.respond({ success: true, message: `Updated ${elementId}: ${changes.join(', ')}` })
}

/** Get currently selected node(s) */
async function handleGetSelection(msg: any, ctx: TabPluginContext): Promise<void> {
  const me = window.__mindElixirInstance as MindElixirInstance | null
  if (!me) {
    ctx.respond({ success: true, selectedIds: [], selectedElements: [], count: 0 })
    return
  }
  const nodes = (me as any).currentNodes || ((me as any).currentNode ? [(me as any).currentNode] : [])
  const selectedElements = nodes.map((n: any) => ({
    id: n.id,
    topic: n.topic,
    children: n.children?.map((c: any) => c.id) ?? [],
  }))
  ctx.respond({
    success: true,
    selectedIds: nodes.map((n: any) => n.id),
    selectedElements,
    count: nodes.length,
  })
}

// ===== Tab Type Registration =====

registerTabType('mindmap', {
  label: 'Mind Map',
  icon: '\uD83E\uDDE0',
  description: 'Mind map workspace with AI generation',
  defaultTitle: 'New Mind Map',
  uiConfig: { showBlockLibrary: false, showToolbar: true, containerClass: 'mindmap-mode' },
  dataKey: 'mindmapData',
  fileExtension: '.rcmind',
  toolActions: {
    get_elements: handleGetMindmap,
    set_data: handleSetMindmap,
    get_element: handleGetMindmapNode,
    add_element: handleAddMindmapNode,
    remove_element: handleRemoveMindmapNode,
    update_element: handleUpdateMindmapNode,
    get_selection: handleGetSelection,
  },
})

// ===== Node Style Panel =====

const ICON_LIST = [
  '\u2B50', '\u2705', '\u274C', '\u26A0\uFE0F',  // star, check, cross, warning
  '\uD83D\uDCCB', '\uD83D\uDCA1', '\uD83D\uDCCC', '\uD83D\uDD0D',  // clipboard, bulb, pin, search
  '\uD83D\uDD25', '\uD83D\uDCC5', '\u231B', '\uD83D\uDD12',  // fire, calendar, hourglass, lock
  '\uD83D\uDE80', '\u2699\uFE0F', '\u26A1', '\uD83D\uDCCA',  // rocket, gear, lightning, chart
  '\uD83C\uDFAF', '\u270F\uFE0F', '\uD83D\uDCAC', '\uD83C\uDF10',  // target, pencil, speech, globe
  '\uD83C\uDFA8', '\u2764\uFE0F', '\uD83D\uDCF7', '\uD83C\uDF89',  // palette, heart, camera, party
]

interface NodeStylePanelProps {
  nodeObj: any
  meInstance: MindElixirInstance
  onClose: () => void
}

function NodeStylePanel({ nodeObj, meInstance, onClose }: NodeStylePanelProps) {
  const applyReshape = useCallback((patch: any) => {
    const nodes = (meInstance as any).currentNodes || []
    if (nodes.length > 1) {
      for (const n of nodes) {
        const tpc = meInstance.findEle(n.nodeObj.id)
        if (tpc) meInstance.reshapeNode(tpc, patch)
      }
    } else {
      const tpc = meInstance.findEle(nodeObj.id)
      if (tpc) meInstance.reshapeNode(tpc, patch)
    }
  }, [nodeObj.id, meInstance])

  const style = nodeObj.style || {}
  const tags: string[] = (nodeObj.tags || []).map((t: any) => typeof t === 'string' ? t : t.text)
  const icons: string[] = nodeObj.icons || []

  const section = (label: string, ...children: any[]) =>
    h('div', { className: 'msp-section' },
      h('div', { className: 'msp-label' }, label),
      ...children
    )

  const colorRow = (label: string, value: string | undefined, onChange: (v: string) => void, onClear?: () => void) =>
    h('div', { className: 'msp-color-row' },
      h('span', { className: 'msp-color-label' }, label),
      h('input', {
        type: 'color',
        value: value || '#ffffff',
        onChange: (e: any) => onChange(e.target.value),
        className: 'msp-color-input',
      }),
      h('span', { className: 'msp-color-value' }, value || 'Default'),
      onClear && h('button', {
        className: 'msp-clear-btn',
        onClick: onClear,
        title: 'Clear',
      }, '×'),
    )

  const fontSize = parseInt(style.fontSize || '16', 10)

  return h('div', {
    className: 'mindmap-style-panel',
    onMouseDown: (e: any) => e.stopPropagation(),
    onClick: (e: any) => e.stopPropagation(),
  },
    h('div', { className: 'msp-header' },
      h('span', null, 'Node Style'),
      h('button', { className: 'msp-close', onClick: onClose, title: 'Close' }, '\u00D7'),
    ),

    // Colors (compact: 3 rows in 1 section)
    section('Colors',
      colorRow('Text', style.color,
        (v) => applyReshape({ style: { ...style, color: v } }),
        style.color ? () => applyReshape({ style: { ...style, color: '' } }) : undefined,
      ),
      colorRow('BG', style.background,
        (v) => applyReshape({ style: { ...style, background: v } }),
        style.background ? () => applyReshape({ style: { ...style, background: '' } }) : undefined,
      ),
      colorRow('Branch', nodeObj.branchColor,
        (v) => applyReshape({ branchColor: v }),
        nodeObj.branchColor ? () => applyReshape({ branchColor: '' }) : undefined,
      ),
    ),

    // Font Size
    section('Font Size',
      h('div', { className: 'msp-font-size-row' },
        h('span', { className: 'msp-font-size-value' }, `${fontSize}px`),
        h('input', {
          type: 'range',
          min: 10,
          max: 36,
          value: fontSize,
          onChange: (e: any) => applyReshape({ style: { ...style, fontSize: `${e.target.value}px` } }),
          className: 'msp-range',
        }),
      ),
    ),

    // Font Weight
    section('Font Weight',
      h('button', {
        className: `msp-bold-btn ${style.fontWeight === 'bold' ? 'active' : ''}`,
        onClick: () => applyReshape({ style: { ...style, fontWeight: style.fontWeight === 'bold' ? undefined : 'bold' } }),
      }, 'B'),
    ),

    // Tags
    section('Tags',
      h('input', {
        type: 'text',
        className: 'msp-text-input',
        placeholder: 'Comma-separated tags',
        defaultValue: tags.join(', '),
        key: `tags-${nodeObj.id}-${tags.join(',')}`,
        onBlur: (e: any) => {
          const newTags = e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean)
          applyReshape({ tags: newTags.length > 0 ? newTags : undefined })
        },
        onKeyDown: (e: any) => { if (e.key === 'Enter') e.target.blur() },
      }),
    ),

    // Icons
    section('Icons',
      h('div', { className: 'msp-icon-grid' },
        ...ICON_LIST.map(icon =>
          h('button', {
            key: icon,
            className: `msp-icon-btn ${icons.includes(icon) ? 'active' : ''}`,
            onClick: () => {
              const newIcons = icons.includes(icon)
                ? icons.filter((i: string) => i !== icon)
                : [...icons, icon]
              applyReshape({ icons: newIcons.length > 0 ? newIcons : undefined })
            },
          }, icon)
        ),
      ),
    ),

    // URL
    section('URL',
      h('input', {
        type: 'text',
        className: 'msp-text-input',
        placeholder: 'https://...',
        defaultValue: nodeObj.hyperLink || '',
        key: `url-${nodeObj.id}-${nodeObj.hyperLink || ''}`,
        onBlur: (e: any) => applyReshape({ hyperLink: e.target.value || undefined }),
        onKeyDown: (e: any) => { if (e.key === 'Enter') e.target.blur() },
      }),
    ),

    // Note
    section('Note',
      h('textarea', {
        className: 'msp-textarea',
        placeholder: 'Add a note...',
        defaultValue: nodeObj.note || '',
        key: `note-${nodeObj.id}-${nodeObj.note || ''}`,
        rows: 6,
        onBlur: (e: any) => applyReshape({ note: e.target.value || undefined }),
      }),
    ),
  )
}

// ===== Component =====

interface MindMapTabProps {
  initialData?: MindElixirData
  onDataChange?: (data: MindElixirData) => void
  visible: boolean
}

function MindMapTab({ initialData, onDataChange, visible }: MindMapTabProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const meRef = useRef<MindElixirInstance | null>(null)
  const [selectedNodeObj, setSelectedNodeObj] = useState<any>(null)
  const selectedNodeObjRef = useRef<any>(null)
  selectedNodeObjRef.current = selectedNodeObj
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [isFocused, setIsFocused] = useState(false)
  // Track which nodes were collapsed before a drag operation
  const collapsedBeforeDragRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!containerRef.current || meRef.current) return

    const savedDirection = (initialData as any)?.direction ?? MindElixir.SIDE
    const me = new MindElixir({
      el: containerRef.current,
      direction: savedDirection,
      editable: true,
      toolBar: false,
      contextMenu: false,
      keypress: true,
      locale: 'en' as any,
      allowUndo: true,
      theme: MindElixir.DARK_THEME,
      // Wheel = zoom (match React Flow behavior)
      handleWheel(e: WheelEvent) {
        e.stopPropagation()
        e.preventDefault()
        const delta = e.deltaY < 0 ? 'in' : 'out'
        const rect = me.container.getBoundingClientRect()
        const point = { x: e.clientX - rect.left, y: e.clientY - rect.top }
        if (delta === 'in') {
          me.scale(me.scaleVal + me.scaleSensitivity, point)
        } else if (me.scaleVal - me.scaleSensitivity > 0) {
          me.scale(me.scaleVal - me.scaleSensitivity, point)
        }
      },
    })

    const data = initialData ?? MindElixir.new('New Topic')
    me.init(data)
    meRef.current = me
    ;window.__mindElixirInstance = me

    // Electron doesn't fire native copy/paste events on non-editable elements,
    // so we handle Ctrl+C/V/X via keydown and use mind-elixir's API directly.
    const MAGIC = 'mind-elixir-clipboard'
    const cleanNode = (obj: any): any => {
      if (!obj || typeof obj !== 'object') return obj
      const out: any = {}
      for (const k of Object.keys(obj)) {
        if (k === 'el' || k === 'parent' || k === 'root') continue
        if (k === 'children' && Array.isArray(obj[k])) {
          out[k] = obj[k].map(cleanNode)
        } else {
          out[k] = obj[k]
        }
      }
      return out
    }

    // Toolbar enable/disable + style panel selection tracking
    let _mmHasClipboard = false
    const updateToolbarButtons = () => {
      const hasSelection = ((me as any).currentNodes?.length ?? 0) > 0
      const btnCut = document.getElementById('btn-cut') as HTMLButtonElement | null
      const btnCopy = document.getElementById('btn-copy') as HTMLButtonElement | null
      const btnPaste = document.getElementById('btn-paste') as HTMLButtonElement | null
      const btnDelete = document.getElementById('btn-delete') as HTMLButtonElement | null
      if (btnCut) btnCut.disabled = !hasSelection
      if (btnCopy) btnCopy.disabled = !hasSelection
      if (btnDelete) btnDelete.disabled = !hasSelection
      if (_mmHasClipboard !== undefined && btnPaste) btnPaste.disabled = !_mmHasClipboard
    }

    // Selection tracking for style panel
    const updateSelection = () => {
      const nodes = (me as any).currentNodes as any[] | undefined
      if (nodes && nodes.length > 0) {
        const obj = nodes[0].nodeObj
        setSelectedNodeObj(obj ? { ...obj } : null)
      } else {
        setSelectedNodeObj(null)
      }
    }

    // moveNodeIn auto-expand: MindElixir expands collapsed nodes on drop (default).
    // We re-collapse them after the operation via the 'operation' event listener below.

    me.bus.addListener('selectNodes', () => { updateToolbarButtons(); updateSelection() })
    me.bus.addListener('unselectNodes', () => { updateToolbarButtons(); updateSelection() })
    me.bus.addListener('operation', () => {
      setTimeout(updateToolbarButtons, 0)
      // Re-sync selected node data after reshapeNode or other operations
      if (selectedNodeObjRef.current) {
        setTimeout(updateSelection, 0)
      }
    })

    const mc = containerRef.current.querySelector('.map-container') as HTMLElement
    if (mc) {
      // Snapshot collapsed node IDs on pointerdown (before drag starts)
      mc.addEventListener('pointerdown', () => {
        collapsedBeforeDragRef.current = new Set()
        const walk = (node: any) => {
          if (node.expanded === false) collapsedBeforeDragRef.current.add(node.id)
          ;(node.children || []).forEach(walk)
        }
        walk(me.getData().nodeData)
      })

      // Shift+click: toggle node in/out of multi-selection (capture phase to beat MindElixir)
      mc.addEventListener('pointerdown', (e: PointerEvent) => {
        if (!e.shiftKey) return
        const target = e.target as HTMLElement
        const tpc = target.tagName === 'ME-TPC' ? target : target.closest('me-tpc') as HTMLElement
        if (!tpc) return
        const meInst = meRef.current as any
        if (!meInst) return
        e.stopPropagation()
        e.preventDefault()
        const current: HTMLElement[] = meInst.currentNodes || []
        if (current.includes(tpc)) {
          meInst.unselectNodes([tpc])
        } else {
          meInst.selectNodes([...current, tpc])
        }
      }, true)

      // Keyboard shortcuts (capture phase to override MindElixir defaults)
      mc.addEventListener('keydown', (e: KeyboardEvent) => {
        const meInst = meRef.current as any
        if (!meInst) return
        const mod = e.ctrlKey || e.metaKey

        // Ctrl+Up/Down: reorder node among siblings
        // Block PgUp/PgDn (laptop-unfriendly) — use Ctrl+Up/Down instead
        if (e.key === 'PageUp' || e.key === 'PageDown') {
          e.preventDefault(); e.stopPropagation(); return
        }

        // Ctrl+Up/Down: reorder node among siblings
        if (mod && e.key === 'ArrowUp') {
          const node = meInst.currentNode
          if (node) meInst.moveUpNode(node)
          e.preventDefault(); e.stopPropagation(); return
        }
        if (mod && e.key === 'ArrowDown') {
          const node = meInst.currentNode
          if (node) meInst.moveDownNode(node)
          e.preventDefault(); e.stopPropagation(); return
        }
        // Ctrl+Left/Right: move root's direct child between left/right side
        // Always intercept in SIDE mode to prevent MindElixir's initLeft/initRight
        // from changing global layout direction
        if (mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          if ((meInst as any).direction === 2) {
            const node = meInst.currentNode
            if (node) {
              const nodeObj = node.nodeObj
              if (nodeObj.parent && nodeObj.parent === (meInst as any).nodeData) {
                const wantSide = e.key === 'ArrowLeft' ? 0 : 1
                const currentSide = node.closest('me-main')?.className === 'lhs' ? 0 : 1
                if (currentSide !== wantSide) {
                  nodeObj.direction = wantSide
                  meInst.refresh()
                  meInst.selectNode(meInst.findEle(nodeObj.id))
                  const data = meInst.getData()
                  ;(data as any).direction = (meInst as any).direction
                  onDataChange?.(data)
                }
              }
              // Non-root-children: do nothing (no side switching)
            }
            e.preventDefault(); e.stopPropagation(); return
          }
          // Non-SIDE mode: let MindElixir handle normally
        }

        if (!mod) return

        // Skip node clipboard ops when editing text (input-box is contentEditable)
        if (mc.querySelector('#input-box') && (e.key === 'c' || e.key === 'v' || e.key === 'x')) return

        if (e.key === 'c' || e.key === 'x') {
          const nodes = meInst.currentNodes
          if (!nodes || nodes.length === 0) return
          const data = nodes.map((n: any) => cleanNode(n.nodeObj))
          navigator.clipboard.writeText(JSON.stringify({ magic: MAGIC, data }))
          _mmHasClipboard = true
          updateToolbarButtons()
          if (e.key === 'x') {
            meInst.removeNodes(nodes)
          }
          e.preventDefault()
        } else if (e.key === 'v') {
          navigator.clipboard.readText().then((text: string) => {
            try {
              const parsed = JSON.parse(text)
              if (parsed?.magic === MAGIC && Array.isArray(parsed.data) && parsed.data.length > 0) {
                const target = meInst.currentNode
                if (!target) return
                const wrapped = parsed.data.map((d: any) => ({ nodeObj: d }))
                meInst.copyNodes(wrapped, target)
              }
            } catch { /* not our data, ignore */ }
          })
          e.preventDefault()
        }
      }, true)

      // Track right-button mousedown to distinguish click vs drag (pan)
      let rightDownPos: { x: number; y: number } | null = null
      const DRAG_THRESHOLD = 5
      mc.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.button === 2) rightDownPos = { x: e.clientX, y: e.clientY }
      })

      // Custom right-click context menu (suppressed if right-drag)
      mc.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        if (rightDownPos) {
          const dx = Math.abs(e.clientX - rightDownPos.x)
          const dy = Math.abs(e.clientY - rightDownPos.y)
          rightDownPos = null
          if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) return // was a drag, skip menu
        }
        const rect = containerRef.current!.getBoundingClientRect()
        setCtxMenu({ x: e.clientX - rect.left, y: e.clientY - rect.top })
      })
    }

    me.bus.addListener('operation', (op: any) => {
      // Re-collapse nodes that were collapsed before a moveNodeIn drag operation
      if (op?.name === 'moveNodeIn' && op.toObj) {
        const targetId = op.toObj.id
        if (collapsedBeforeDragRef.current.has(targetId)) {
          const targetEl = me.findEle(targetId)
          if (targetEl) {
            setTimeout(() => me.expandNode(targetEl, false), 0)
          }
        }
      }

      const data = me.getData()
      ;(data as any).direction = (me as any).direction
      ensureExpandedField(data.nodeData)
      onDataChange?.(data)
    })

    return () => {
      if (containerRef.current) {
        containerRef.current.innerHTML = ''
      }
      meRef.current = null
      ;window.__mindElixirInstance = null
    }
  }, [])

  const zoomIn = () => {
    const me = meRef.current
    if (me) me.scale((me as any).scaleVal + 0.2)
  }
  const zoomOut = () => {
    const me = meRef.current
    if (me) me.scale((me as any).scaleVal - 0.2)
  }
  const center = () => meRef.current?.toCenter()
  const setDirection = (dir: number) => {
    const me = meRef.current
    if (!me) return
    ;(me as any).direction = dir
    me.refresh()
    me.toCenter()
    const data = me.getData()
    ;(data as any).direction = dir
    onDataChange?.(data)
  }
  const expandAll = () => {
    const me = meRef.current
    if (!me) return
    const root = me.nodeData.el as any
    if (root) me.expandNodeAll(root, true)
  }
  const collapseAll = () => {
    const me = meRef.current
    if (!me) return
    const root = me.nodeData.el as any
    if (root) me.expandNodeAll(root, false)
  }

  // Close context menu on click outside or Escape
  useEffect(() => {
    if (!ctxMenu) return
    const handleClick = () => setCtxMenu(null)
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null) }
    window.addEventListener('click', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('click', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [ctxMenu])

  const ctxAction = useCallback((action: () => void) => {
    action()
    setCtxMenu(null)
  }, [])

  const renderContextMenu = () => {
    if (!ctxMenu || !meRef.current) return null
    const me = meRef.current as any
    const hasNode = !!me.currentNode
    const nodeObj = hasNode ? me.currentNode.nodeObj : null
    const isRoot = hasNode && (!nodeObj?.parent || nodeObj === me.nodeData)
    // Check if node is a direct child of root (can move left/right in SIDE mode)
    const isDirectChild = hasNode && !isRoot && nodeObj?.parent === me.nodeData
    const isSideMode = me.direction === 2

    // Move node between left/right side of root
    const moveSide = (targetSide: number) => {
      const node = me.currentNode
      if (!node) return
      const nodeObj = node.nodeObj
      nodeObj.direction = targetSide
      me.refresh()
      me.selectNode(me.findEle(nodeObj.id))
      const data = me.getData()
      ;(data as any).direction = me.direction
      onDataChange?.(data)
    }

    // Arrow creation: show tip and wait for target click (matches MindElixir built-in behavior)
    const startArrow = (opts?: { bidirectional: boolean }) => {
      const source = me.currentNode
      if (!source) return
      const tip = document.createElement('div')
      tip.className = 'mindmap-ctx-tip'
      tip.textContent = 'Click target node...'
      me.container.appendChild(tip)
      me.map.addEventListener('click', (ev: MouseEvent) => {
        ev.preventDefault()
        tip.remove()
        const target = ev.target as HTMLElement
        if (target.parentElement?.tagName === 'ME-PARENT' || target.parentElement?.tagName === 'ME-ROOT') {
          me.createArrow(source, target, opts)
        }
      }, { once: true })
    }

    type MenuItem = { label: string; key?: string; action: () => void; disabled?: boolean } | 'sep'
    const items: MenuItem[] = [
      { label: 'Add child', key: 'Tab', action: () => me.addChild(), disabled: !hasNode },
      { label: 'Add parent', key: 'Ctrl+Enter', action: () => me.insertParent(), disabled: isRoot || !hasNode },
      { label: 'Add sibling', key: 'Enter', action: () => me.insertSibling('after'), disabled: isRoot || !hasNode },
      { label: 'Remove node', key: 'Delete', action: () => me.removeNodes(me.currentNodes || []), disabled: isRoot || !hasNode },
      'sep',
      { label: 'Move up', key: 'Ctrl+\u2191', action: () => me.moveUpNode(), disabled: isRoot || !hasNode },
      { label: 'Move down', key: 'Ctrl+\u2193', action: () => me.moveDownNode(), disabled: isRoot || !hasNode },
      ...(isSideMode ? [
        { label: 'Move to left', key: 'Ctrl+\u2190', action: () => moveSide(0), disabled: !isDirectChild },
        { label: 'Move to right', key: 'Ctrl+\u2192', action: () => moveSide(1), disabled: !isDirectChild },
      ] : []),
      'sep',
      { label: 'Summary', action: () => { me.createSummary(); me.unselectNodes(me.currentNodes) }, disabled: !hasNode },
      ...(isFocused
        ? [{ label: 'Cancel Focus', action: () => { me.cancelFocus(); setIsFocused(false) } }]
        : [{ label: 'Focus Mode', action: () => { me.focusNode(me.currentNode); setIsFocused(true) }, disabled: !hasNode }]),
      'sep',
      { label: 'Link', action: () => startArrow(), disabled: !hasNode },
      { label: 'Bidirectional Link', action: () => startArrow({ bidirectional: true }), disabled: !hasNode },
    ]

    return h('div', {
      className: 'mindmap-ctx-menu',
      style: { left: ctxMenu.x, top: ctxMenu.y },
      onClick: (e: any) => e.stopPropagation(),
      ref: (el: HTMLDivElement | null) => {
        if (!el || !containerRef.current) return
        const containerRect = containerRef.current.getBoundingClientRect()
        const menuRect = el.getBoundingClientRect()
        if (menuRect.bottom > containerRect.bottom) {
          el.style.top = Math.max(0, ctxMenu.y - (menuRect.bottom - containerRect.bottom) - 8) + 'px'
        }
        if (menuRect.right > containerRect.right) {
          el.style.left = Math.max(0, ctxMenu.x - menuRect.width - 8) + 'px'
        }
      },
    },
      ...items.map((item, i) => {
        if (item === 'sep') return h('div', { key: `sep-${i}`, className: 'mindmap-ctx-sep' })
        return h('div', {
          key: item.label,
          className: `mindmap-ctx-item ${item.disabled ? 'disabled' : ''}`,
          onClick: item.disabled ? undefined : () => ctxAction(item.action),
        },
          h('span', null, item.label),
          item.key ? h('span', { className: 'mindmap-ctx-key' }, item.key) : null,
        )
      }),
    )
  }

  // (Toolbar portal removed — now handled by MindmapToolbar component)

  return h(Fragment, null,
    // Context menu (custom)
    visible && renderContextMenu(),
    // Style panel (left overlay)
    visible && selectedNodeObj && meRef.current && h(NodeStylePanel, {
      nodeObj: selectedNodeObj,
      meInstance: meRef.current,
      onClose: () => setSelectedNodeObj(null),
    }),
    h('div', {
      ref: containerRef,
      style: {
        width: '100%',
        height: '100%',
        position: visible ? 'relative' as const : 'absolute' as const,
        visibility: visible ? 'visible' as const : 'hidden' as const,
        pointerEvents: visible ? 'auto' as const : 'none' as const,
      },
    }),
  )
}

// ===== Wrapper + Component Registration =====

function MindMapTabWrapper({ tabId, dataRef, markDirty }: TabContentProps) {
  return h(MindMapTab, {
    visible: true,
    initialData: dataRef.current.get(tabId),
    onDataChange: (data: any) => {
      ensureExpandedField(data?.nodeData)
      dataRef.current.set(tabId, data)
      markDirty()
    },
    key: tabId,
  })
}

registerTabComponent('mindmap', MindMapTabWrapper)
registerToolbarComponent('mindmap', MindmapToolbar as any)
