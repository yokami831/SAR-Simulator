/**
 * bookmarkBar.tsx - Top bookmark bar (Chrome-style)
 *
 * Folders and files are displayed as a unified list.
 * Drag-and-drop supports reordering AND moving files into folders.
 * "New" menu supports creating folders.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react'
import { TAB_TYPES, getTabType } from './tabRegistry.js'
import { rcPrompt } from './modal.js'

// ===== Types =====

export interface WorkspaceFile {
  filename: string
  type: string
  title: string
  modified: string
}

export interface FolderEntry {
  name: string
  files: WorkspaceFile[]
}

/** Unified bookmark item: either a folder or a root file */
type BookmarkItem =
  | { kind: 'folder'; name: string; files: WorkspaceFile[] }
  | { kind: 'file'; file: WorkspaceFile }

interface BookmarkBarProps {
  rootFiles: WorkspaceFile[]
  folders: FolderEntry[]
  onOpenFile: (filename: string) => void
  onAddNew: (type: string) => void
  onCreateFolder: (name: string) => void
  onMoveToFolder: (filename: string, targetFolder: string) => void
  onChangeFolder: () => void
  bookmarkOrder: string[]
  onReorder: (newOrder: string[]) => void
}

// Monochrome SVG icons (Chrome bookmark bar style)
const svgStyle = { width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, flexShrink: 0 } as const

function FileIcon() {
  return <svg viewBox="0 0 16 16" style={svgStyle}><path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z"/><path d="M9 1v4h4"/></svg>
}
function FolderIcon() {
  return <svg viewBox="0 0 16 16" style={svgStyle}><path d="M2 3h4l2 2h6a1 1 0 011 1v7a1 1 0 01-1 1H2a1 1 0 01-1-1V4a1 1 0 011-1z"/></svg>
}
function FolderOpenIcon() {
  return <svg viewBox="0 0 16 16" style={svgStyle}><path d="M1 4v9a1 1 0 001 1h12l2-7H3"/><path d="M2 3h4l2 2h5a1 1 0 011 1v1"/></svg>
}

const TYPE_ICONS: Record<string, () => React.ReactElement> = {
  flow: FileIcon,
  mindmap: FileIcon,
  note: FileIcon,
  notes: FileIcon,
  draw: FileIcon,
  excalidraw: FileIcon,
}

function TypeIcon({ type }: { type: string }) {
  const Icon = TYPE_ICONS[type] || FileIcon
  return <Icon />
}

// ===== Dropdown Menu (folder contents) =====

function DropdownMenu({ folder, files, onSelect, onClose, anchorRect, onDropFile }: {
  folder: string
  files: WorkspaceFile[]
  onSelect: (filename: string) => void
  onClose: () => void
  anchorRect: DOMRect | null
  onDropFile: (filename: string, targetFolder: string) => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const left = anchorRect
    ? Math.max(4, Math.min(anchorRect.left, window.innerWidth - 280))
    : 0
  const top = anchorRect ? anchorRect.bottom + 2 : 40

  return (
    <div ref={menuRef} className="bookmark-dropdown" style={{ top, left }}>
      <div className="bookmark-dropdown-header">{folder}</div>
      {files.map((file) => (
        <div
          key={file.filename}
          className="bookmark-dropdown-item"
          draggable
          onClick={() => { onSelect(file.filename); onClose() }}
          onDragStart={(e) => {
            e.dataTransfer.setData('text/bookmark-key', file.filename)
            e.dataTransfer.effectAllowed = 'move'
            // Close dropdown shortly after drag starts so user can drop on bar
            setTimeout(() => onClose(), 150)
          }}
        >
          <span className="bdi-icon"><TypeIcon type={file.type} /></span>
          <span className="bdi-name">{file.title}</span>
          <span className="bdi-drag-hint" title="Drag to move">⠿</span>
        </div>
      ))}
    </div>
  )
}

// ===== New Menu (files + folder) =====

export const NewMenu = React.forwardRef<HTMLDivElement, {
  onSelectType: (type: string) => void
  onCreateFolder: (name: string) => void
  onClose: () => void
  style?: React.CSSProperties
}>(({ onSelectType, onCreateFolder, onClose, style }, ref) => {
  const types = TAB_TYPES.filter(t => t.id !== 'launcher')

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = (ref as React.RefObject<HTMLDivElement | null>)?.current
      if (el && !el.contains(e.target as Node)) onClose()
    }
    setTimeout(() => document.addEventListener('click', handler), 0)
    return () => document.removeEventListener('click', handler)
  }, [onClose, ref])

  const handleNewFolder = useCallback(async () => {
    const name = await rcPrompt('フォルダ名を入力:', '', { title: 'New Folder' })
    if (name?.trim()) {
      onCreateFolder(name.trim())
      onClose()
    }
  }, [onCreateFolder, onClose])

  return (
    <div className="new-tab-popup" ref={ref} style={style}>
      <div className="new-tab-popup-title">New Workspace</div>
      {types.map(t => (
        <button key={t.id} className="new-tab-popup-item" onClick={() => onSelectType(t.id)}>
          <span className="new-tab-popup-icon">{t.icon}</span>
          <div>
            <div className="new-tab-popup-label">{t.label}</div>
            <div className="new-tab-popup-desc">{t.description}</div>
          </div>
        </button>
      ))}
      <div style={{ borderTop: '1px solid var(--border-color)', margin: '4px 0' }} />
      <button className="new-tab-popup-item" onClick={handleNewFolder}>
        <span className="new-tab-popup-icon" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}><FolderIcon /></span>
        <div>
          <div className="new-tab-popup-label">Folder</div>
          <div className="new-tab-popup-desc">Create a new folder</div>
        </div>
      </button>
    </div>
  )
})

// ===== BookmarkBar Component =====

export function BookmarkBar({
  rootFiles, folders, onOpenFile, onAddNew,
  onCreateFolder, onMoveToFolder, onChangeFolder,
  bookmarkOrder, onReorder,
}: BookmarkBarProps) {
  const [openDropdown, setOpenDropdown] = useState<string | null>(null)
  const [dropdownRect, setDropdownRect] = useState<DOMRect | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const [dragOverSide, setDragOverSide] = useState<'left' | 'right'>('left')

  // Build unified item list: folders use key "folder:NAME", files use filename
  const allItems: BookmarkItem[] = []
  const folderMap = new Map(folders.map(f => [f.name, f]))

  // Folders as items
  for (const f of folders) {
    allItems.push({ kind: 'folder', name: f.name, files: f.files })
  }
  // Root files as items
  for (const f of rootFiles) {
    allItems.push({ kind: 'file', file: f })
  }

  // Key function
  const itemKey = (item: BookmarkItem) =>
    item.kind === 'folder' ? `folder:${item.name}` : item.file.filename

  // Sort by bookmarkOrder (items not in order go to end)
  const orderedItems = [...allItems].sort((a, b) => {
    const ak = itemKey(a)
    const bk = itemKey(b)
    const ai = bookmarkOrder.indexOf(ak)
    const bi = bookmarkOrder.indexOf(bk)
    if (ai === -1 && bi === -1) return 0
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })

  // Handlers
  const handleFolderClick = useCallback((name: string, e: React.MouseEvent) => {
    if (openDropdown === name) { setOpenDropdown(null); return }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setDropdownRect(rect)
    setOpenDropdown(name)
  }, [openDropdown])


  // Drag: start
  const handleDragStart = useCallback((e: React.DragEvent, key: string) => {
    e.dataTransfer.setData('text/bookmark-key', key)
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  // Drag: over — detect left/right half for insertion indicator
  const handleDragOver = useCallback((e: React.DragEvent, key: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const side = (e.clientX - rect.left) < rect.width / 2 ? 'left' : 'right'
    setDragOverKey(key)
    setDragOverSide(side)
  }, [])

  // Drag: drop — move into folder OR reorder
  const handleDrop = useCallback((e: React.DragEvent, targetKey: string) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverKey(null)
    const fromKey = e.dataTransfer.getData('text/bookmark-key')
    console.log('[drop]', { fromKey: fromKey || '(empty)', targetKey })
    if (!fromKey || fromKey === targetKey) return

    // Dropping a file onto a folder → move file into folder
    if (targetKey.startsWith('folder:') && !fromKey.startsWith('folder:')) {
      const folderName = targetKey.slice(7)
      onMoveToFolder(fromKey, folderName)
      return
    }

    // File dragged from inside a folder onto a non-folder item → move to root
    const currentOrder = orderedItems.map(itemKey)
    const fromIdx = currentOrder.indexOf(fromKey)
    if (fromIdx === -1 && !fromKey.startsWith('folder:')) {
      onMoveToFolder(fromKey, '')
      return
    }

    // Reorder items within the bar
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const dropSide = (e.clientX - rect.left) < rect.width / 2 ? 'left' : 'right'
    let toIdx = currentOrder.indexOf(targetKey)
    if (fromIdx === -1 || toIdx === -1) return
    currentOrder.splice(fromIdx, 1)
    toIdx = currentOrder.indexOf(targetKey)
    const insertIdx = dropSide === 'right' ? toIdx + 1 : toIdx
    currentOrder.splice(insertIdx, 0, fromKey)
    onReorder(currentOrder)
  }, [orderedItems, onReorder, onMoveToFolder])

  return (
    <>
      {/* Change workspace directory button */}
      <button
        className="bookmark-change-folder"
        onClick={onChangeFolder}
        title="Change workspace folder"
      ><FolderOpenIcon /></button>

      {/* Unified items: folders and files intermixed */}
      {orderedItems.map(item => {
        const key = itemKey(item)
        const isDragOver = dragOverKey === key

        if (item.kind === 'folder') {
          const isOpen = openDropdown === item.name
          const isSingle = item.files.length === 1
          if (isSingle) {
            // Single-file folder: flat button, click opens directly
            const file = item.files[0]
            return (
              <button
                key={key}
                className={`bookmark-item${isDragOver ? ` drag-over-${dragOverSide}` : ''}`}
                onClick={() => onOpenFile(file.filename)}
                title={`${item.name} / ${file.title}`}
                draggable
                onDragStart={e => handleDragStart(e, key)}
                onDragOver={e => handleDragOver(e, key)}
                onDragLeave={() => setDragOverKey(null)}
                onDrop={e => handleDrop(e, key)}
                onDragEnd={() => setDragOverKey(null)}
              >
                {file.title}
              </button>
            )
          }
          // Multi-file folder: dropdown
          return (
            <button
              key={key}
              className={`bookmark-item${isOpen ? ' active-dropdown' : ''}${isDragOver ? ' folder-drop-target' : ''}`}
              onClick={e => handleFolderClick(item.name, e)}
              draggable
              onDragStart={e => handleDragStart(e, key)}
              onDragOver={e => handleDragOver(e, key)}
              onDragLeave={() => setDragOverKey(null)}
              onDrop={e => handleDrop(e, key)}
              onDragEnd={() => setDragOverKey(null)}
            >
              <span className="bookmark-icon"><FolderIcon /></span>
              {item.name}
              <span className="bookmark-arrow">▼</span>
            </button>
          )
        }

        // Root file
        const file = item.file
        return (
          <button
            key={key}
            className={`bookmark-item${isDragOver ? ` drag-over-${dragOverSide}` : ''}`}
            onClick={() => onOpenFile(file.filename)}
            title={file.title}
            draggable
            onDragStart={e => handleDragStart(e, key)}
            onDragOver={e => handleDragOver(e, key)}
            onDragLeave={() => setDragOverKey(null)}
            onDrop={e => handleDrop(e, key)}
            onDragEnd={() => setDragOverKey(null)}
          >
            {file.title}
          </button>
        )
      })}

      {/* Spacer */}
      <div className="bookmark-spacer" />

      {/* Folder dropdown */}
      {openDropdown && (() => {
        const folder = folders.find(f => f.name === openDropdown)
        if (!folder) return null
        return (
          <DropdownMenu
            folder={folder.name}
            files={folder.files}
            onSelect={onOpenFile}
            onClose={() => setOpenDropdown(null)}
            anchorRect={dropdownRect}
            onDropFile={onMoveToFolder}
          />
        )
      })()}

    </>
  )
}
