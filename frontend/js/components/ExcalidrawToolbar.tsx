/**
 * ExcalidrawToolbar.tsx - Toolbar for Excalidraw tab
 *
 * Undo/Redo/Delete/Cut: via Excalidraw internal actionManager (React fiber access)
 * Copy/Paste: via getSceneElements()/updateScene() (internal clipboard)
 *   - actionManager.copy/paste use OS clipboard which requires user gesture permissions
 *   - Scene-based copy/paste avoids this restriction
 */

import { createElement as h, useCallback } from 'react'
import { TbSaveButton, TbSep, TbSpacer, TbUndoRedo, TbClipboardButtons } from './ToolbarButtons.js'
import type { ToolbarProps } from '../types.js'

/** Find Excalidraw App instance's actionManager via React fiber */
function getActionManager(): any {
  const el = document.querySelector('.excalidraw')
  if (!el) return null
  const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber'))
  if (!fiberKey) return null
  const queue = [(el as any)[fiberKey]]
  for (let i = 0; i < 200 && queue.length > 0; i++) {
    const c = queue.shift()
    if (c.stateNode?.actionManager) return c.stateNode.actionManager
    if (c.child) queue.push(c.child)
    if (c.sibling) queue.push(c.sibling)
    if (c.return && i < 5) queue.push(c.return)
  }
  return null
}

function execAction(name: string) {
  const am = getActionManager()
  if (am?.actions?.[name]) am.executeAction(am.actions[name])
}

function getApi(): any {
  return (window as any).__excalidrawAPI
}

function getSelectedIds(): Set<string> {
  const api = getApi()
  if (!api) return new Set()
  return new Set(Object.keys(api.getAppState().selectedElementIds || {}))
}

// Internal clipboard (scene-based, avoids OS clipboard permission issues)
let _clipboard: any[] = []

export function ExcalidrawToolbar({ onSave, onSaveAs }: ToolbarProps) {
  // Undo/Redo: actionManager (works reliably)
  const handleUndo = useCallback(() => execAction('undo'), [])
  const handleRedo = useCallback(() => execAction('redo'), [])

  // Delete: actionManager
  const handleDelete = useCallback(() => execAction('deleteSelectedElements'), [])

  // Copy: scene-based (internal clipboard)
  const handleCopy = useCallback(() => {
    const api = getApi()
    if (!api) return
    const selectedIds = getSelectedIds()
    if (selectedIds.size === 0) return
    _clipboard = api.getSceneElements()
      .filter((el: any) => selectedIds.has(el.id) && !el.isDeleted)
      .map((el: any) => JSON.parse(JSON.stringify(el)))
  }, [])

  // Cut: copy to internal clipboard + delete via actionManager
  const handleCut = useCallback(() => {
    const api = getApi()
    if (!api) return
    const selectedIds = getSelectedIds()
    if (selectedIds.size === 0) return
    _clipboard = api.getSceneElements()
      .filter((el: any) => selectedIds.has(el.id) && !el.isDeleted)
      .map((el: any) => JSON.parse(JSON.stringify(el)))
    execAction('deleteSelectedElements')
  }, [])

  // Paste: from internal clipboard
  const handlePaste = useCallback(() => {
    const api = getApi()
    if (!api || _clipboard.length === 0) return
    const offset = 20
    const newElements = _clipboard.map((el: any) => ({
      ...el,
      id: crypto.randomUUID(),
      x: el.x + offset,
      y: el.y + offset,
      seed: Math.floor(Math.random() * 2 ** 31),
    }))
    const existing = api.getSceneElements()
    api.updateScene({ elements: [...existing, ...newElements] })
  }, [])

  return h('div', { id: 'toolbar' },
    h(TbSaveButton, { onSave, onSaveAs }),
    h(TbSep),
    h(TbUndoRedo, { onUndo: handleUndo, onRedo: handleRedo }),
    h(TbSep),
    h(TbClipboardButtons, {
      onCut: handleCut,
      onCopy: handleCopy,
      onPaste: handlePaste,
      onDelete: handleDelete,
      hasSelection: true,
      hasClipboard: true,
    }),
    h(TbSpacer),
  )
}
