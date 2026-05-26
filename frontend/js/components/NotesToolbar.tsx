/**
 * NotesToolbar.tsx - Toolbar for Notes tab (BlockNote/Tiptap/ProseMirror)
 *
 * Uses BlockNote editor's commands API accessed via DOM (.bn-editor.editor).
 * Undo/Redo/Cut/Delete: via editor.commands.keyboardShortcut()
 * Copy/Paste: via editor.commands.keyboardShortcut() (Tiptap handles internally)
 */

import { createElement as h, useCallback } from 'react'
import { TbSaveButton, TbSep, TbSpacer, TbUndoRedo, TbClipboardButtons } from './ToolbarButtons.js'
import type { ToolbarProps } from '../types.js'

/** Get the BlockNote/Tiptap editor instance from DOM */
function getEditor(): any {
  const el = document.querySelector('.bn-editor') as any
  return el?.editor || null
}

/** Execute a Tiptap keyboard shortcut command */
function execShortcut(shortcut: string) {
  const ed = getEditor()
  if (ed?.commands?.keyboardShortcut) {
    ed.commands.keyboardShortcut(shortcut)
  }
}

export function NotesToolbar({ onSave, onSaveAs }: ToolbarProps) {
  const handleUndo = useCallback(() => execShortcut('Mod-z'), [])
  const handleRedo = useCallback(() => execShortcut('Mod-Shift-z'), [])
  const handleCut = useCallback(() => execShortcut('Mod-x'), [])
  const handleCopy = useCallback(() => execShortcut('Mod-c'), [])
  const handlePaste = useCallback(() => execShortcut('Mod-v'), [])
  const handleDelete = useCallback(() => {
    const ed = getEditor()
    if (ed?.commands?.deleteSelection) {
      ed.commands.deleteSelection()
    }
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
