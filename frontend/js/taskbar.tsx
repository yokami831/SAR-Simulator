/**
 * taskbar.tsx - Bottom taskbar showing open files
 *
 * Replaces the old top tab bar. Shows open workspace tabs at the bottom
 * of the window (below LOG panel), with type-colored active indicator
 * and error status.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react'
import type { TabInstance } from './types.js'
import { getTabType } from './tabRegistry.js'
import { NewMenu } from './bookmarkBar.js'

// Type-specific border colors for active tab
const TYPE_COLORS: Record<string, string> = {
  flow: '#58a6ff',
  mindmap: '#d29922',
  note: '#3fb950',
  notes: '#3fb950',
  draw: '#bc8cff',
  excalidraw: '#bc8cff',
}

interface TaskbarProps {
  tabs: TabInstance[]
  activeTabId: string
  onSwitch: (tabId: string) => void
  onClose: (tabId: string) => void
  onEdit: (tabId: string) => void
  onReorder: (fromId: string, toId: string) => void
  dirtyTabs: Set<string>
  errorCount: number
  onToggleConsole?: () => void
  onAddNew: (type: string) => void
  onCreateFolder: (name: string) => void
}

export function BottomTaskbar({
  tabs, activeTabId, onSwitch, onClose, onEdit, onReorder,
  dirtyTabs, errorCount, onToggleConsole, onAddNew, onCreateFolder,
}: TaskbarProps) {
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [showMenu, setShowMenu] = useState(false)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  const [menuTabId, setMenuTabId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [showNewMenu, setShowNewMenu] = useState(false)
  const [newMenuPos, setNewMenuPos] = useState({ top: 0, left: 0 })
  const newMenuRef = useRef<HTMLDivElement>(null)
  const addBtnRef = useRef<HTMLButtonElement>(null)

  // Close context menu on outside click
  useEffect(() => {
    if (!showMenu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false)
      }
    }
    setTimeout(() => document.addEventListener('click', handler), 0)
    return () => document.removeEventListener('click', handler)
  }, [showMenu])

  const wasDragging = useRef(false)

  const handleDragStart = useCallback((e: React.DragEvent, tabId: string) => {
    wasDragging.current = true
    e.dataTransfer.setData('text/tab-id', tabId)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    setDragOverId(null)
    const fromId = e.dataTransfer.getData('text/tab-id')
    if (fromId && fromId !== targetId) onReorder(fromId, targetId)
  }, [onReorder])

  // Filter out launcher tabs (should not exist anymore, but safety check)
  const visibleTabs = tabs.filter(t => t.type !== 'launcher')

  return (
    <>
      {visibleTabs.length === 0 ? (
        <span className="taskbar-placeholder">開いているファイルはありません</span>
      ) : (
        visibleTabs.map(tab => {
          const isActive = tab.id === activeTabId
          const isDirty = dirtyTabs.has(tab.id)
          const tabType = getTabType(tab.type)
          const icon = tabType?.icon || '📄'
          const color = TYPE_COLORS[tab.type] || '#888'

          return (
            <div
              key={tab.id}
              className={`taskbar-tab${isActive ? ' active' : ''}${dragOverId === tab.id ? ' drag-over' : ''}`}
              style={isActive ? { borderBottomColor: color } : undefined}
              draggable
              onClick={() => { if (!wasDragging.current) onSwitch(tab.id); wasDragging.current = false }}
              onDragStart={e => handleDragStart(e, tab.id)}
              onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverId(tab.id) }}
              onDragLeave={() => setDragOverId(null)}
              onDrop={e => handleDrop(e, tab.id)}
              onDragEnd={() => { setDragOverId(null); setTimeout(() => { wasDragging.current = false }, 0) }}
              onContextMenu={e => {
                e.preventDefault()
                setMenuPos({ x: e.clientX, y: e.clientY })
                setMenuTabId(tab.id)
                setShowMenu(true)
              }}
            >
              <span className="tt-icon">{icon}</span>
              <span className="tt-title">{isDirty ? `\u25CF ${tab.title}` : tab.title}</span>
              <button
                className="tt-close"
                onClick={e => { e.stopPropagation(); onClose(tab.id) }}
                title="Close"
              >{'\u00D7'}</button>
            </div>
          )
        })
      )}

      <div className="taskbar-spacer" />

      {/* Add new button (right side) */}
      <button
        ref={addBtnRef}
        className="taskbar-add-btn"
        onClick={() => {
          if (addBtnRef.current) {
            const rect = addBtnRef.current.getBoundingClientRect()
            setNewMenuPos({ top: rect.top - 4, left: rect.left })
          }
          setShowNewMenu(prev => !prev)
        }}
      >+ 新規</button>

      {/* Error status indicator */}
      <div
        className={`taskbar-status${errorCount > 0 ? ' has-errors' : ''}`}
        onClick={errorCount > 0 ? onToggleConsole : undefined}
        title={errorCount > 0 ? 'Click to toggle log panel' : ''}
      >
        {errorCount > 0
          ? <><span>⚠</span> {errorCount} error{errorCount !== 1 ? 's' : ''}</>
          : <><span style={{ color: '#3fb950' }}>✓</span> エラーなし</>
        }
      </div>

      {/* Context menu */}
      {showMenu && menuTabId && (
        <div
          ref={menuRef}
          className="tab-context-menu"
          style={{ position: 'fixed', left: menuPos.x, top: menuPos.y - 40, zIndex: 1000 }}
        >
          <button onClick={e => { e.stopPropagation(); setShowMenu(false); onEdit(menuTabId) }}>
            Edit...
          </button>
        </div>
      )}

      {/* New workspace menu (opens upward from taskbar) */}
      {showNewMenu && (
        <NewMenu
          ref={newMenuRef}
          style={{ bottom: 42, left: newMenuPos.left, top: 'auto', position: 'fixed' }}
          onSelectType={(type) => { setShowNewMenu(false); onAddNew(type) }}
          onCreateFolder={onCreateFolder}
          onClose={() => setShowNewMenu(false)}
        />
      )}
    </>
  )
}
