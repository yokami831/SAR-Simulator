/**
 * SimpleToolbar.tsx - Toolbar for Excalidraw and Notes tabs
 *
 * Save button + keyboard shortcut hints.
 * These editors handle undo/redo/clipboard internally via Ctrl+Z/Y/C/V.
 */

import { createElement as h } from 'react'
import { TbSaveButton, TbSpacer, TbShortcutHints } from './ToolbarButtons.js'
import type { ToolbarProps } from '../types.js'

export function SimpleToolbar({ onSave, onSaveAs }: ToolbarProps) {
  return h('div', { id: 'toolbar' },
    h(TbSaveButton, { onSave, onSaveAs }),
    h(TbShortcutHints),
    h(TbSpacer),
  )
}
