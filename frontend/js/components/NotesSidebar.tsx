/**
 * NotesSidebar.tsx — Page list sidebar for the Notes tab.
 *
 * Features:
 * - Folders with expand/collapse
 * - Pages inside folders or at root level
 * - Drag-and-drop to reorder pages and move into/out of folders
 * - Right-click context menu (rename, delete, move to folder)
 * - Resizable width via drag handle
 * - Auto-rename mode for newly created pages/folders
 */

import { useState, useRef, useEffect, useCallback, createElement as h, Fragment } from 'react'
import { rcConfirm } from '../modal.js'

export interface NotesPage {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  folderId?: string
}

export interface NotesFolder {
  id: string
  title: string
  collapsed: boolean
}

interface NotesSidebarProps {
  pages: NotesPage[]
  folders: NotesFolder[]
  activePageId: string | null
  onSelectPage: (id: string) => void
  onAddPage: () => void
  onDeletePage: (id: string) => void
  onRenamePage: (id: string, newTitle: string) => void
  onReorderPages: (reordered: NotesPage[]) => void
  onAddFolder: () => void
  onDeleteFolder: (id: string) => void
  onRenameFolder: (id: string, newTitle: string) => void
  onToggleFolder: (id: string) => void
  onMovePageToFolder: (pageId: string, folderId: string | null) => void
  onReorderFolders: (reordered: NotesFolder[]) => void
  pendingEditId: string | null
  onPendingEditConsumed: () => void
}

/** Hamburger menu with Save/Save As for Notes sidebar */
function NotesHamburgerMenu() {
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

  return h('div', { className: 'notes-hamburger', ref },
    h('button', {
      className: 'notes-hamburger-btn',
      onClick: () => setOpen(!open),
      title: 'Menu',
    }, h('svg', { viewBox: '0 0 20 20', width: 16, height: 16 },
      h('path', { d: 'M3.5 5h13M3.5 10h13M3.5 15h13', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', fill: 'none' }),
    )),
    open && h('div', { className: 'notes-hamburger-menu' },
      h('div', { className: 'notes-hamburger-item', onClick: () => { setOpen(false); window.__hiyoSave?.() } },
        'Save', h('span', { className: 'notes-hamburger-shortcut' }, 'Ctrl+S'),
      ),
      h('div', { className: 'notes-hamburger-item', onClick: () => { setOpen(false); window.__hiyoSaveAs?.() } },
        'Save As...', h('span', { className: 'notes-hamburger-shortcut' }, 'Ctrl+Shift+S'),
      ),
    ),
  )
}

export function NotesSidebar({
  pages, folders, activePageId, onSelectPage, onAddPage, onDeletePage, onRenamePage,
  onReorderPages, onAddFolder, onDeleteFolder, onRenameFolder, onToggleFolder,
  onMovePageToFolder, onReorderFolders, pendingEditId, onPendingEditConsumed,
}: NotesSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingType, setEditingType] = useState<'page' | 'folder'>('page')
  const [editValue, setEditValue] = useState('')
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [dragOverType, setDragOverType] = useState<'page' | 'folder' | null>(null)
  const [dragSourceId, setDragSourceId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    type: 'page' | 'folder'; id: string; x: number; y: number
  } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const dragSourceRef = useRef<string | null>(null)
  const dragSourceTypeRef = useRef<'page' | 'folder' | null>(null)

  // Sidebar resize handle
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const sidebar = sidebarRef.current
    if (!sidebar) return
    const startX = e.clientX
    const startWidth = sidebar.offsetWidth
    sidebar.style.transition = 'none'
    const onMouseMove = (ev: MouseEvent) => {
      const newW = Math.max(150, Math.min(400, startWidth + (ev.clientX - startX)))
      sidebar.style.width = newW + 'px'
    }
    const onMouseUp = () => {
      sidebar.style.transition = ''
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [])

  // Focus input when editing starts
  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return
    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [contextMenu])

  // Handle pendingEditId from parent (auto-rename new page/folder)
  useEffect(() => {
    if (pendingEditId) {
      const page = pages.find(p => p.id === pendingEditId)
      const folder = folders.find(f => f.id === pendingEditId)
      if (page) {
        setEditingId(pendingEditId)
        setEditingType('page')
        setEditValue(page.title)
        onPendingEditConsumed()
      } else if (folder) {
        setEditingId(pendingEditId)
        setEditingType('folder')
        setEditValue(folder.title)
        onPendingEditConsumed()
      }
    }
  }, [pendingEditId, pages, folders, onPendingEditConsumed])

  // === Rename ===
  const startRenamePage = (page: NotesPage) => {
    setEditingId(page.id)
    setEditingType('page')
    setEditValue(page.title)
  }
  const startRenameFolder = (folder: NotesFolder) => {
    setEditingId(folder.id)
    setEditingType('folder')
    setEditValue(folder.title)
  }

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      if (editingType === 'page') onRenamePage(editingId, editValue.trim())
      else onRenameFolder(editingId, editValue.trim())
    }
    setEditingId(null)
  }

  // === Context Menu ===
  const handlePageContextMenu = (e: React.MouseEvent, page: NotesPage) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ type: 'page', id: page.id, x: e.clientX, y: e.clientY })
  }
  const handleFolderContextMenu = (e: React.MouseEvent, folder: NotesFolder) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ type: 'folder', id: folder.id, x: e.clientX, y: e.clientY })
  }

  const handleContextRename = () => {
    if (!contextMenu) return
    if (contextMenu.type === 'page') {
      const page = pages.find(p => p.id === contextMenu.id)
      if (page) startRenamePage(page)
    } else {
      const folder = folders.find(f => f.id === contextMenu.id)
      if (folder) startRenameFolder(folder)
    }
    setContextMenu(null)
  }

  const handleContextDelete = async () => {
    if (!contextMenu) return
    const { type, id } = contextMenu
    setContextMenu(null)
    if (type === 'page') {
      const page = pages.find(p => p.id === id)
      if (page) {
        const confirmed = await rcConfirm(`Delete "${page.title}"?`)
        if (confirmed) onDeletePage(id)
      }
    } else {
      const folder = folders.find(f => f.id === id)
      if (folder) {
        const childCount = pages.filter(p => p.folderId === id).length
        const msg = childCount > 0
          ? `Delete folder "${folder.title}"? (${childCount} page(s) will be moved to root)`
          : `Delete folder "${folder.title}"?`
        const confirmed = await rcConfirm(msg)
        if (confirmed) onDeleteFolder(id)
      }
    }
  }

  const handleContextMoveToFolder = (folderId: string | null) => {
    if (!contextMenu || contextMenu.type !== 'page') return
    onMovePageToFolder(contextMenu.id, folderId)
    setContextMenu(null)
  }

  // === Drag-and-Drop ===
  const handleDragStart = (e: React.DragEvent, pageId: string) => {
    dragSourceRef.current = pageId
    dragSourceTypeRef.current = 'page'
    setDragSourceId(pageId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', pageId)
  }

  const handleFolderDragStart = (e: React.DragEvent, folderId: string) => {
    dragSourceRef.current = folderId
    dragSourceTypeRef.current = 'folder'
    setDragSourceId(folderId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', folderId)
  }

  const handlePageDragOver = (e: React.DragEvent, pageId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (pageId !== dragSourceRef.current) {
      setDragOverId(pageId)
      setDragOverType('page')
    }
  }

  const handleFolderDragOver = (e: React.DragEvent, folderId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverId(folderId)
    setDragOverType('folder')
  }

  const handleDragLeave = () => {
    setDragOverId(null)
    setDragOverType(null)
  }

  const handlePageDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    setDragOverId(null)
    setDragOverType(null)
    const sourceId = dragSourceRef.current
    setDragSourceId(null)
    dragSourceRef.current = null
    dragSourceTypeRef.current = null
    if (!sourceId || sourceId === targetId) return

    // Reorder within page list
    const reordered = [...pages]
    const sourceIdx = reordered.findIndex(p => p.id === sourceId)
    const targetIdx = reordered.findIndex(p => p.id === targetId)
    if (sourceIdx === -1 || targetIdx === -1) return
    const [moved] = reordered.splice(sourceIdx, 1)
    // Match target's folder
    const targetPage = reordered[targetIdx >= reordered.length ? reordered.length - 1 : targetIdx]
    if (targetPage && moved.folderId !== targetPage.folderId) {
      moved.folderId = targetPage.folderId
    }
    reordered.splice(targetIdx, 0, moved)
    onReorderPages(reordered)
  }

  const handleFolderDrop = (e: React.DragEvent, targetFolderId: string) => {
    e.preventDefault()
    setDragOverId(null)
    setDragOverType(null)
    const sourceId = dragSourceRef.current
    const sourceType = dragSourceTypeRef.current
    setDragSourceId(null)
    dragSourceRef.current = null
    dragSourceTypeRef.current = null
    if (!sourceId) return

    if (sourceType === 'folder') {
      // Reorder folders
      if (sourceId === targetFolderId) return
      const reordered = [...folders]
      const srcIdx = reordered.findIndex(f => f.id === sourceId)
      const tgtIdx = reordered.findIndex(f => f.id === targetFolderId)
      if (srcIdx === -1 || tgtIdx === -1) return
      const [moved] = reordered.splice(srcIdx, 1)
      reordered.splice(tgtIdx, 0, moved)
      onReorderFolders(reordered)
    } else {
      // Move page into folder
      onMovePageToFolder(sourceId, targetFolderId)
    }
  }

  const handleDragEnd = () => {
    setDragOverId(null)
    setDragOverType(null)
    setDragSourceId(null)
    dragSourceRef.current = null
    dragSourceTypeRef.current = null
  }

  // === Render helpers ===
  const rootPages = pages.filter(p => !p.folderId)

  const renderEditInput = () =>
    h('input', {
      ref: inputRef,
      className: 'notes-sidebar-rename-input',
      value: editValue,
      onChange: (e: any) => setEditValue(e.target.value),
      onBlur: commitRename,
      onKeyDown: (e: any) => {
        if (e.key === 'Enter') commitRename()
        if (e.key === 'Escape') setEditingId(null)
      },
      onClick: (e: any) => e.stopPropagation(),
    })

  const renderPageItem = (page: NotesPage, indented = false) =>
    h('div', {
      key: page.id,
      className: [
        'notes-sidebar-item',
        page.id === activePageId ? 'active' : '',
        page.id === dragOverId && dragOverType === 'page' ? 'drag-over' : '',
        page.id === dragSourceId ? 'dragging' : '',
        indented ? 'indented' : '',
      ].filter(Boolean).join(' '),
      onClick: () => onSelectPage(page.id),
      onDoubleClick: () => startRenamePage(page),
      onContextMenu: (e: any) => handlePageContextMenu(e, page),
      draggable: editingId !== page.id,
      onDragStart: (e: any) => handleDragStart(e, page.id),
      onDragOver: (e: any) => handlePageDragOver(e, page.id),
      onDragLeave: handleDragLeave,
      onDrop: (e: any) => handlePageDrop(e, page.id),
      onDragEnd: handleDragEnd,
    },
      editingId === page.id ? renderEditInput()
        : h('span', { className: 'notes-sidebar-title' }, page.title),
    )

  // === Main render ===
  return h('div', { className: 'notes-sidebar', ref: sidebarRef },
    // Header buttons
    h('div', { className: 'notes-sidebar-add-row' },
      h(NotesHamburgerMenu),
      h('button', { className: 'notes-sidebar-add', onClick: onAddPage }, '+ Page'),
      h('button', { className: 'notes-sidebar-add notes-sidebar-add-folder', onClick: onAddFolder }, '+ Folder'),
    ),
    // Page/folder list
    h('div', { className: 'notes-sidebar-list' },
      // Folders
      ...folders.map(folder => {
        const childPages = pages.filter(p => p.folderId === folder.id)
        return h(Fragment, { key: `folder-${folder.id}` },
          h('div', {
            className: [
              'notes-sidebar-folder',
              folder.id === dragOverId && dragOverType === 'folder' ? 'drag-over' : '',
              folder.id === dragSourceId ? 'dragging' : '',
            ].filter(Boolean).join(' '),
            onClick: () => onToggleFolder(folder.id),
            onContextMenu: (e: any) => handleFolderContextMenu(e, folder),
            draggable: editingId !== folder.id,
            onDragStart: (e: any) => handleFolderDragStart(e, folder.id),
            onDragOver: (e: any) => handleFolderDragOver(e, folder.id),
            onDragLeave: handleDragLeave,
            onDrop: (e: any) => handleFolderDrop(e, folder.id),
            onDragEnd: handleDragEnd,
          },
            h('span', { className: 'notes-folder-toggle' }, folder.collapsed ? '\u25B6' : '\u25BC'),
            editingId === folder.id
              ? renderEditInput()
              : h('span', { className: 'notes-sidebar-title' }, folder.title),
          ),
          // Child pages (if expanded)
          !folder.collapsed && childPages.length > 0 && h('div', { className: 'notes-folder-children' },
            ...childPages.map(page => renderPageItem(page, true)),
          ),
        )
      }),
      // Root pages (no folder)
      ...rootPages.map(page => renderPageItem(page)),
    ),
    // Context menu
    contextMenu && h('div', {
      ref: contextMenuRef,
      className: 'notes-context-menu',
      style: { top: contextMenu.y, left: contextMenu.x },
    },
      h('button', { className: 'notes-context-item', onClick: handleContextRename }, 'Rename'),
      h('button', { className: 'notes-context-item notes-context-delete', onClick: handleContextDelete }, 'Delete'),
      // Move to folder options (page only)
      contextMenu.type === 'page' && folders.length > 0 && h('div', { className: 'notes-context-separator' }),
      contextMenu.type === 'page' && folders.map(f =>
        h('button', {
          key: f.id,
          className: 'notes-context-item',
          onClick: () => handleContextMoveToFolder(f.id),
        }, `Move to ${f.title}`),
      ),
      contextMenu.type === 'page' && pages.find(p => p.id === contextMenu.id)?.folderId &&
        h('button', {
          className: 'notes-context-item',
          onClick: () => handleContextMoveToFolder(null),
        }, 'Move to Root'),
    ),
    // Resize handle
    h('div', { className: 'notes-sidebar-resize-handle', onMouseDown: handleResizeStart }),
  )
}
