/**
 * MindmapToolbar.tsx - Floating toolbar for Mindmap tab
 *
 * Renders inside the canvas area (not the top bar).
 * ≡ hamburger menu for Save/Save As.
 * Floating button bar for Zoom, Direction, Expand/Collapse.
 */

import { createElement as h, useCallback, useState, useEffect, useRef } from 'react'
import { TbButton } from './ToolbarButtons.js'
import type { ToolbarProps } from '../types.js'

// SVG icons
const IconZoomIn = () => h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
  h('circle', { cx: 9, cy: 9, r: 6 }), h('path', { d: 'M13 13l4 4' }), h('path', { d: 'M6 9h6M9 6v6' }))
const IconZoomOut = () => h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
  h('circle', { cx: 9, cy: 9, r: 6 }), h('path', { d: 'M13 13l4 4' }), h('path', { d: 'M6 9h6' }))
const IconCenter = () => h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
  h('circle', { cx: 10, cy: 10, r: 3 }), h('circle', { cx: 10, cy: 10, r: 7 }),
  h('path', { d: 'M10 1v4M10 15v4M1 10h4M15 10h4' }))
const IconBothSides = () => h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
  h('path', { d: 'M10 4v12' }), h('path', { d: 'M10 10H3M10 6H5M10 14H5' }), h('path', { d: 'M10 10h7M10 6h5M10 14h5' }))
const IconRight = () => h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
  h('path', { d: 'M4 10h12M4 10V4M4 6h8M4 14h8M4 10v4' }))
const IconLeft = () => h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 2 },
  h('path', { d: 'M16 10H4M16 10V4M16 6H8M16 14H8M16 10v4' }))
// Expand/Collapse icons removed — MindElixir v5 doesn't have expandAll/collapseAll

const SIDE = 0, RIGHT = 1, LEFT = 2

function getME(): any {
  return (window as any).__mindElixirInstance
}

function HamburgerMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    setTimeout(() => document.addEventListener('click', handler), 0)
    return () => document.removeEventListener('click', handler)
  }, [open])

  return h('div', { className: 'floating-hamburger', ref },
    h('button', {
      className: 'floating-hamburger-btn',
      onClick: () => setOpen(!open),
      title: 'Menu',
    }, h('svg', { viewBox: '0 0 20 20', width: 18, height: 18 },
      h('path', { d: 'M3.5 5h13M3.5 10h13M3.5 15h13', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', fill: 'none' }),
    )),
    open && h('div', { className: 'floating-hamburger-menu' },
      h('div', { className: 'floating-hamburger-item', onClick: () => { setOpen(false); window.__hiyoSave?.() } },
        'Save', h('span', { className: 'floating-hamburger-shortcut' }, 'Ctrl+S'),
      ),
      h('div', { className: 'floating-hamburger-item', onClick: () => { setOpen(false); window.__hiyoSaveAs?.() } },
        'Save As...', h('span', { className: 'floating-hamburger-shortcut' }, 'Ctrl+Shift+S'),
      ),
    ),
  )
}

export function MindmapToolbar({ onSave, onSaveAs }: ToolbarProps) {
  const zoomIn = useCallback(() => getME()?.scale(1.2), [])
  const zoomOut = useCallback(() => getME()?.scale(0.8), [])
  const center = useCallback(() => getME()?.toCenter(), [])
  const setDirection = useCallback((dir: number) => {
    const me = getME()
    if (!me) return
    me.direction = dir
    me.refresh()
    me.toCenter()
  }, [])
  // expandAll/collapseAll removed — not available in MindElixir v5

  return h('div', { className: 'floating-toolbar-container' },
    h(HamburgerMenu),

    h('div', { className: 'floating-toolbar' },
      // Zoom
      h(TbButton, { title: 'Zoom In', icon: IconZoomIn, onClick: zoomIn }),
      h(TbButton, { title: 'Zoom Out', icon: IconZoomOut, onClick: zoomOut }),
      h(TbButton, { title: 'Center', icon: IconCenter, onClick: center }),
      h('div', { className: 'floating-sep' }),

      // Direction
      h(TbButton, { title: 'Both Sides', icon: IconBothSides, onClick: () => setDirection(SIDE), className: 'icon-btn accent-cyan' }),
      h(TbButton, { title: 'Right', icon: IconRight, onClick: () => setDirection(RIGHT), className: 'icon-btn accent-cyan' }),
      h(TbButton, { title: 'Left', icon: IconLeft, onClick: () => setDirection(LEFT), className: 'icon-btn accent-cyan' }),
      // Expand/Collapse removed — not available in MindElixir v5
    ),
  )
}
