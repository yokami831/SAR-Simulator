/**
 * ToolbarButtons.tsx - Shared toolbar button components
 *
 * Reusable building blocks for per-tab toolbar components.
 * Each tab type composes its toolbar from these shared buttons.
 */

import { useState, useCallback, useEffect, useRef, createElement as h, Fragment } from 'react'

// ===== SVG Icons (extracted from index.html static toolbar) =====

const IconSave = () => h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
  h('path', { d: 'M3 2h11l4 4v11a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z' }),
  h('path', { d: 'M6 2v5h8V2' }),
  h('rect', { x: 5, y: 11, width: 10, height: 6 }),
)

const IconUndo = () => h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
  h('path', { d: 'M4 8l4-4M4 8l4 4' }),
  h('path', { d: 'M4 8h9a5 5 0 010 10H10' }),
)

const IconRedo = () => h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
  h('path', { d: 'M16 8l-4-4M16 8l-4 4' }),
  h('path', { d: 'M16 8H7a5 5 0 000 10h3' }),
)

const IconCut = () => h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
  h('circle', { cx: 6, cy: 16, r: 2.5 }),
  h('circle', { cx: 14, cy: 16, r: 2.5 }),
  h('path', { d: 'M8 14l6-10M12 14L6 4' }),
)

const IconCopy = () => h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
  h('rect', { x: 6, y: 6, width: 11, height: 12, rx: 1 }),
  h('path', { d: 'M3 14V3a1 1 0 011-1h9' }),
)

const IconPaste = () => h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
  h('rect', { x: 3, y: 4, width: 14, height: 14, rx: 1 }),
  h('path', { d: 'M7 4V2h6v2' }),
  h('path', { d: 'M7 10h6M7 13h4' }),
)

const IconDelete = () => h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
  h('circle', { cx: 10, cy: 10, r: 7 }),
  h('path', { d: 'M7 7l6 6M13 7l-6 6', stroke: '#e57373' }),
)

const IconGroup = () => h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
  h('rect', { x: 1, y: 1, width: 18, height: 18, rx: 2, strokeDasharray: '3 2', stroke: '#b39ddb' }),
  h('rect', { x: 4, y: 4, width: 5, height: 5, rx: 1 }),
  h('rect', { x: 11, y: 4, width: 5, height: 5, rx: 1 }),
  h('rect', { x: 4, y: 11, width: 5, height: 5, rx: 1 }),
)

const IconUngroup = () => h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
  h('rect', { x: 1, y: 1, width: 7, height: 7, rx: 1 }),
  h('rect', { x: 12, y: 1, width: 7, height: 7, rx: 1 }),
  h('rect', { x: 1, y: 12, width: 7, height: 7, rx: 1 }),
  h('path', { d: 'M12 12h7v7h-7z', strokeDasharray: '2 2', stroke: '#b39ddb' }),
)

const IconPlay = () => h('svg', { viewBox: '0 0 20 20', fill: 'currentColor', stroke: 'none' },
  h('polygon', { points: '5,3 17,10 5,17' }),
)

const IconStep = () => h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
  h('polygon', { points: '3,3 10,10 3,17', fill: 'currentColor' }),
  h('line', { x1: 13, y1: 3, x2: 13, y2: 17 }),
)

const IconStop = () => h('svg', { viewBox: '0 0 20 20', fill: 'currentColor', stroke: 'none' },
  h('rect', { x: 4, y: 4, width: 12, height: 12 }),
)

const IconReset = () => h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
  h('path', { d: 'M4 4a8 8 0 1 1 0 12', stroke: 'currentColor', fill: 'none' }),
  h('polygon', { points: '2,2 6,4 2,6', fill: 'currentColor' }),
)

const IconLayout = () => h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
  h('rect', { x: 1, y: 1, width: 7, height: 7, rx: 1 }),
  h('rect', { x: 12, y: 1, width: 7, height: 7, rx: 1 }),
  h('rect', { x: 6, y: 12, width: 7, height: 7, rx: 1 }),
  h('path', { d: 'M4.5 8v2h5.5v2M15.5 8v2h-5.5', stroke: '#4dd0e1' }),
)

// Export icons for reuse
export const ToolbarIcons = {
  Save: IconSave, Undo: IconUndo, Redo: IconRedo,
  Cut: IconCut, Copy: IconCopy, Paste: IconPaste, Delete: IconDelete,
  Group: IconGroup, Ungroup: IconUngroup,
  Play: IconPlay, Step: IconStep, Stop: IconStop, Reset: IconReset, Layout: IconLayout,
}

// ===== Base Components =====

/** Generic toolbar icon button */
export function TbButton({ title, icon, label, onClick, disabled, className }: {
  title: string
  icon?: () => ReturnType<typeof h>
  label?: string
  onClick: () => void
  disabled?: boolean
  className?: string
}) {
  return h('button', {
    className: `icon-btn ${className || ''}`.trim(),
    title,
    onClick,
    disabled: disabled || false,
  },
    icon && h(icon),
    label && ` ${label}`,
  )
}

/** Toolbar separator */
export function TbSep() {
  return h('div', { className: 'sep' })
}

/** Toolbar spacer (flex: 1) */
export function TbSpacer() {
  return h('div', { className: 'spacer' })
}

/** Single shortcut hint (label on top, key below) */
export function TbHint({ label, shortcut }: { label: string; shortcut: string }) {
  return h('div', { className: 'toolbar-shortcut-hint' },
    h('span', { className: 'hint-label' }, label),
    h('span', { className: 'hint-key' }, shortcut),
  )
}

/** Common shortcut hints group */
export function TbShortcutHints() {
  return h('div', { className: 'toolbar-shortcut-hints' },
    h(TbHint, { label: 'Undo', shortcut: 'Ctrl+Z' }),
    h(TbHint, { label: 'Redo', shortcut: 'Ctrl+Y' }),
    h(TbHint, { label: 'Copy', shortcut: 'Ctrl+C' }),
    h(TbHint, { label: 'Paste', shortcut: 'Ctrl+V' }),
    h(TbHint, { label: 'Delete', shortcut: 'Del' }),
  )
}

/** Save button with dropdown */
export function TbSaveButton({ onSave, onSaveAs }: { onSave: () => void; onSaveAs: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [open])

  return h('div', { className: 'split-btn', ref },
    h('button', {
      className: 'icon-btn',
      title: 'Save (Ctrl+S)',
      onClick: onSave,
    }, h(IconSave)),
    h('button', {
      className: 'split-btn-arrow',
      title: 'Save options',
      onClick: (e: React.MouseEvent) => { e.stopPropagation(); setOpen(!open) },
    }, '\u25BE'),
    h('div', { className: `split-btn-menu ${open ? 'open' : ''}` },
      h('div', { onClick: () => { setOpen(false); onSaveAs() } }, 'Save As... (Ctrl+Shift+S)'),
    ),
  )
}

/** Undo/Redo button pair */
export function TbUndoRedo({ onUndo, onRedo }: { onUndo: () => void; onRedo: () => void }) {
  return h(Fragment, null,
    h(TbButton, { title: 'Undo (Ctrl+Z)', icon: IconUndo, onClick: onUndo }),
    h(TbButton, { title: 'Redo (Ctrl+Y)', icon: IconRedo, onClick: onRedo }),
  )
}

/** Clipboard button group (Cut, Copy, Paste, Delete) */
export function TbClipboardButtons({ onCut, onCopy, onPaste, onDelete, hasSelection, hasClipboard }: {
  onCut: () => void
  onCopy: () => void
  onPaste: () => void
  onDelete: () => void
  hasSelection: boolean
  hasClipboard: boolean
}) {
  return h(Fragment, null,
    h(TbButton, { title: 'Cut (Ctrl+X)', icon: IconCut, onClick: onCut, disabled: !hasSelection }),
    h(TbButton, { title: 'Copy (Ctrl+C)', icon: IconCopy, onClick: onCopy, disabled: !hasSelection }),
    h(TbButton, { title: 'Paste (Ctrl+V)', icon: IconPaste, onClick: onPaste, disabled: !hasClipboard }),
    h(TbButton, { title: 'Delete (Del)', icon: IconDelete, onClick: onDelete, disabled: !hasSelection, className: 'accent-red' }),
  )
}
