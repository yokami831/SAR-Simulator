/**
 * FlowToolbar.tsx - Floating toolbar for Flow tab
 *
 * Renders inside the canvas area (not the top bar).
 * ≡ hamburger menu for Save/Save As.
 * Floating button bar for Group/Ungroup, Run/Step/Stop, Auto Layout.
 */

import { createElement as h, useState, useEffect, useRef } from 'react'
import { TbButton, ToolbarIcons } from './ToolbarButtons.js'
import type { ToolbarProps } from '../types.js'

export type ExecutionMode = 'idle' | 'running' | 'stepping'

export interface FlowToolbarProps extends ToolbarProps {
  executionMode: ExecutionMode
  hasMultiSelection: boolean
  hasSubgraphSelected: boolean
  onGroup: () => void
  onUngroup: () => void
  onRunAll: () => void
  onStep: () => void
  onStopReset: () => void
  onAutoLayout: () => void
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

export function FlowToolbar(props: FlowToolbarProps) {
  const {
    executionMode, hasMultiSelection, hasSubgraphSelected,
    onGroup, onUngroup,
    onRunAll, onStep, onStopReset, onAutoLayout,
  } = props

  const isRunning = executionMode === 'running'
  const isStepping = executionMode === 'stepping'

  return h('div', { className: 'floating-toolbar-container' },
    // Hamburger menu (top-left)
    h(HamburgerMenu),

    // Floating button bar
    h('div', { className: 'floating-toolbar' },
      // Group / Ungroup
      h(TbButton, {
        title: 'Group (Ctrl+G)', icon: ToolbarIcons.Group, onClick: onGroup,
        disabled: !hasMultiSelection, className: 'accent-purple',
      }),
      h(TbButton, {
        title: 'Ungroup (Ctrl+Shift+G)', icon: ToolbarIcons.Ungroup, onClick: onUngroup,
        disabled: !hasSubgraphSelected, className: 'accent-purple',
      }),
      h('div', { className: 'floating-sep' }),

      // Execution
      h(TbButton, {
        title: isStepping ? 'Run Remaining' : 'Run All (F5)',
        icon: ToolbarIcons.Play,
        label: isStepping ? 'Run Remaining' : 'Run All',
        onClick: onRunAll,
        disabled: isRunning,
        className: isStepping ? 'run-remaining' : 'run',
      }),
      h(TbButton, {
        title: 'Step (F10)',
        icon: ToolbarIcons.Step,
        label: 'Step',
        onClick: onStep,
        disabled: isRunning,
        className: isRunning ? '' : 'step',
      }),
      h(TbButton, {
        title: isStepping ? 'Reset' : 'Stop (Shift+F5)',
        icon: isStepping ? ToolbarIcons.Reset : ToolbarIcons.Stop,
        label: isStepping ? 'Reset' : 'Stop',
        onClick: onStopReset,
        disabled: executionMode === 'idle',
        className: isStepping ? 'reset' : (isRunning ? 'stop' : ''),
      }),
      h('div', { className: 'floating-sep' }),

      // Auto Layout
      h(TbButton, {
        title: 'Auto Layout',
        icon: ToolbarIcons.Layout,
        label: 'Auto Layout',
        onClick: onAutoLayout,
        className: 'accent-cyan',
      }),
    ),
  )
}
