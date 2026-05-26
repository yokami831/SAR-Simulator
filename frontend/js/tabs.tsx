/**
 * tabs.tsx - Tab bar component + Workspace card node
 *
 * TabBar: Horizontal tab strip above toolbar
 * WorkspaceCard: React Flow node for launcher tab
 * NewTabPopup: Type selection dropdown for [+] button
 */

import React, { useState, useCallback, useRef, useEffect } from 'react'
import type { TabInstance } from './types.js'
import { TAB_TYPES, getTabType } from './tabRegistry.js'

// ===== TabBar Component =====

interface TabBarProps {
  tabs: TabInstance[]
  activeTabId: string
  onSwitch: (tabId: string) => void
  onClose: (tabId: string) => void
  onEdit: (tabId: string) => void
  onAdd: (type: string) => void
  onReorder: (fromId: string, toId: string) => void
  dirtyTabs?: Set<string>
}

export function TabBar({ tabs, activeTabId, onSwitch, onClose, onEdit, onAdd, onReorder, dirtyTabs }: TabBarProps) {
  const [showPopup, setShowPopup] = useState(false)
  const [popupPos, setPopupPos] = useState({ top: 0, left: 0 })
  const popupRef = useRef<HTMLDivElement>(null)
  const addBtnRef = useRef<HTMLButtonElement>(null)

  // Close popup on outside click
  useEffect(() => {
    if (!showPopup) return
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        setShowPopup(false)
      }
    }
    setTimeout(() => document.addEventListener('click', handler), 0)
    return () => document.removeEventListener('click', handler)
  }, [showPopup])

  const handleAddClick = useCallback(() => {
    if (addBtnRef.current) {
      const rect = addBtnRef.current.getBoundingClientRect()
      setPopupPos({ top: rect.bottom + 2, left: rect.left })
    }
    setShowPopup(prev => !prev)
  }, [])

  return (
    <>
      {tabs.map(tab => (
        <Tab
          key={tab.id}
          tab={tab}
          isActive={tab.id === activeTabId}
          isDirty={dirtyTabs?.has(tab.id) || false}
          onSwitch={onSwitch}
          onClose={onClose}
          onEdit={onEdit}
          onReorder={onReorder}
        />
      ))}
      <div className="tab-add-wrapper" style={{ position: 'relative' }}>
        <button
          ref={addBtnRef}
          className="tab-add"
          onClick={handleAddClick}
          title="New workspace"
        >+</button>
        {showPopup && (
          <NewTabPopup
            ref={popupRef}
            style={{ top: popupPos.top, left: popupPos.left }}
            onSelect={(type) => {
              setShowPopup(false)
              onAdd(type)
            }}
            onClose={() => setShowPopup(false)}
          />
        )}
      </div>
    </>
  )
}

// ===== Single Tab =====

function Tab({ tab, isActive, isDirty, onSwitch, onClose, onEdit, onReorder }: {
  tab: TabInstance
  isActive: boolean
  isDirty: boolean
  onSwitch: (id: string) => void
  onClose: (id: string) => void
  onEdit: (id: string) => void
  onReorder: (fromId: string, toId: string) => void
}) {
  const [showMenu, setShowMenu] = useState(false)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  const [dragOver, setDragOver] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const tabType = getTabType(tab.type)
  const icon = tabType?.icon || ''
  const isLauncher = tab.type === 'launcher'

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

  return (
    <div
      className={`tab${isActive ? ' active' : ''}${dragOver ? ' drag-over' : ''}`}
      onClick={() => onSwitch(tab.id)}
      draggable={!isLauncher}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/tab-id', tab.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const fromId = e.dataTransfer.getData('text/tab-id')
        if (fromId && fromId !== tab.id) onReorder(fromId, tab.id)
      }}
      onDragEnd={() => setDragOver(false)}
      onContextMenu={(e) => {
        if (!isLauncher) {
          e.preventDefault()
          setMenuPos({ x: e.clientX, y: e.clientY })
          setShowMenu(true)
        }
      }}
    >
      <span className="tab-icon">{icon}</span>
      <span className="tab-title">{isDirty ? `\u25CF ${tab.title}` : tab.title}</span>
      {!isLauncher && (
        <button
          className="tab-close"
          onClick={e => { e.stopPropagation(); onClose(tab.id) }}
          title="Close workspace"
        >{'\u2715'}</button>
      )}
      {showMenu && (
        <div
          ref={menuRef}
          className="tab-context-menu"
          style={{ position: 'fixed', left: menuPos.x, top: menuPos.y, zIndex: 1000 }}
        >
          <button onClick={(e) => { e.stopPropagation(); setShowMenu(false); onEdit(tab.id) }}>
            Edit...
          </button>
        </div>
      )}
    </div>
  )
}

// ===== New Tab Popup =====

const NewTabPopup = React.forwardRef<HTMLDivElement, {
  onSelect: (type: string) => void
  onClose: () => void
  style?: React.CSSProperties
}>(({ onSelect, onClose, style }, ref) => {
  // Only show non-launcher types
  const types = TAB_TYPES.filter(t => t.id !== 'launcher')

  return (
    <div className="new-tab-popup" ref={ref} style={style}>
      <div className="new-tab-popup-title">New Workspace</div>
      {types.map(t => (
        <button
          key={t.id}
          className="new-tab-popup-item"
          onClick={() => onSelect(t.id)}
        >
          <span className="new-tab-popup-icon">{t.icon}</span>
          <div>
            <div className="new-tab-popup-label">{t.label}</div>
            <div className="new-tab-popup-desc">{t.description}</div>
          </div>
        </button>
      ))}
    </div>
  )
})

// ===== WorkspaceCard Node (for launcher tab) =====

export function WorkspaceCard({ data, onAdd }: { data: Record<string, unknown>; onAdd?: (type: string) => void }) {
  const filename = (data.filename as string) || ''
  const title = filename ? filename.replace(/\.[^.]+$/, '') : ((data.title as string) || 'Untitled')
  const wsType = (data.type as string) || 'flow'
  const modified = data.modified as string
  const description = (data.description as string) || ''
  const isNewCard = data.isNewCard as boolean
  const tabType = getTabType(wsType)

  const modifiedStr = modified
    ? new Date(modified).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ''

  // New card with popup (same as TabBar [+])
  const [showPopup, setShowPopup] = useState(false)
  const [popupPos, setPopupPos] = useState({ x: 0, y: 0 })
  const cardRef = useRef<HTMLDivElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showPopup) return
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node) &&
          cardRef.current && !cardRef.current.contains(e.target as Node)) {
        setShowPopup(false)
      }
    }
    setTimeout(() => document.addEventListener('click', handler), 0)
    return () => document.removeEventListener('click', handler)
  }, [showPopup])

  if (isNewCard) {
    // "Open Folder" card — placed first in launcher grid
    const onOpenFolder = data.onOpenFolder as (() => void) | undefined
    return (
      <div
        className="workspace-card workspace-card-new"
        data-role="workspace-card-open-folder"
        onClick={(e) => {
          e.stopPropagation()
          onOpenFolder?.()
        }}
      >
        <div className="workspace-card-icon">{'\uD83D\uDCC2'}</div>
        <div className="workspace-card-title">Open Folder</div>
      </div>
    )
  }

  return (
    <div className="workspace-card" data-role="workspace-card" data-folder={data.filename as string}>
      <div className="workspace-card-header">
        <span className="workspace-card-type-icon">{tabType?.icon || ''}</span>
        <span className="workspace-card-type-label">{tabType?.label || wsType}</span>
      </div>
      <div className="workspace-card-title">{title}</div>
      {description && <div className="workspace-card-desc">{description}</div>}
      {modifiedStr && <div className="workspace-card-date">{modifiedStr}</div>}
    </div>
  )
}
