/**
 * notes.tsx - Notes tab plugin (self-registering)
 *
 * Registers its tab type, component, and tool actions via tabRegistry.
 * Provides a Notion-style block editor (BlockNote) with multi-page support.
 *
 * Tool actions (via tab_action, consistent with mindmap/excalidraw):
 *   get_elements    — list pages (summary)
 *   get_element     — read a specific page's content
 *   add_element     — create a new page
 *   remove_element  — delete a page
 *   update_element  — rename page and/or update content
 *   set_data        — replace full notesData
 */

import { useState, useCallback, useRef, useEffect, createElement as h } from 'react'
import { registerTabType, registerTabComponent, registerToolbarComponent } from './tabRegistry.js'
import { SimpleToolbar } from './components/SimpleToolbar.js'
import type { TabContentProps, TabPluginContext } from './types.js'
import { NoteEditor } from './components/NoteEditor.js'
import { NotesSidebar, type NotesPage, type NotesFolder } from './components/NotesSidebar.js'

// ===== Types =====

interface NotesData {
  pages: NotesPage[]
  folders: NotesFolder[]
  content: Record<string, any[]>
  activePageId: string | null
}

function emptyNotesData(): NotesData {
  return { pages: [], folders: [], content: {}, activePageId: null }
}

/** Ensure backward compat: add missing folders field */
function normalizeData(data: any): NotesData {
  return { ...emptyNotesData(), ...data, folders: data?.folders ?? [] }
}

// ===== Live component updater =====
// Tool actions update dataRef, but NotesPanel has its own React state.
// The panel exposes its updater via this module-level ref so tool actions
// can push changes to the live UI (same pattern as mindmap's __mindElixirInstance).

type NotesUpdater = (updater: (prev: NotesData) => NotesData) => void
const _liveUpdater: { current: NotesUpdater | null } = { current: null }
const _bumpRevision: { current: (() => void) | null } = { current: null }

/** Apply an update to both dataRef and the live React component */
function applyUpdate(ctx: TabPluginContext, updater: (prev: NotesData) => NotesData): NotesData {
  const prev: NotesData = normalizeData(ctx.dataRef.current.get(ctx.tabId))
  const next = updater(prev)
  ctx.dataRef.current.set(ctx.tabId, next)
  if (_liveUpdater.current) {
    _liveUpdater.current(() => next)
  }
  return next
}

// ===== Tool Actions =====

/** List all pages (summary). Includes full notesData for save_tab. */
async function handleGetElements(msg: any, ctx: TabPluginContext): Promise<void> {
  const data: NotesData = normalizeData(ctx.dataRef.current.get(ctx.tabId))
  ctx.respond({
    success: true,
    pages: data.pages.map(p => ({ id: p.id, title: p.title, folderId: p.folderId })),
    folders: data.folders.map(f => ({ id: f.id, title: f.title, collapsed: f.collapsed })),
    activePageId: data.activePageId,
    count: data.pages.length,
    notesData: data,
  })
}

/** Get a single page's full content. Params: node_id or elementId */
async function handleGetElement(msg: any, ctx: TabPluginContext): Promise<void> {
  const pageId = msg.node_id || msg.elementId
  if (!pageId) {
    ctx.respond({ success: false, error: 'node_id or elementId is required' })
    return
  }
  const data: NotesData = normalizeData(ctx.dataRef.current.get(ctx.tabId))
  const page = data.pages.find(p => p.id === pageId)
  if (!page) {
    ctx.respond({ success: false, error: `Page not found: ${pageId}` })
    return
  }
  ctx.respond({
    success: true,
    element: { id: page.id, title: page.title, createdAt: page.createdAt, updatedAt: page.updatedAt },
    content: data.content[pageId] || [],
  })
}

/** Create a new page. Params: title (optional), content (optional BlockNote blocks) */
async function handleAddElement(msg: any, ctx: TabPluginContext): Promise<void> {
  const title = msg.title || msg.topic || 'Untitled'
  const content = msg.content || []
  const folderId = msg.folderId || undefined
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  applyUpdate(ctx, prev => ({
    ...prev,
    pages: [...prev.pages, { id, title, createdAt: now, updatedAt: now, folderId }],
    content: { ...prev.content, [id]: content },
    activePageId: id,
  }))
  ctx.respond({ success: true, elementId: id, title, message: `Created page: ${title}` })
}

/** Delete a page. Params: node_id or elementId */
async function handleRemoveElement(msg: any, ctx: TabPluginContext): Promise<void> {
  const pageId = msg.node_id || msg.elementId
  if (!pageId) {
    ctx.respond({ success: false, error: 'node_id or elementId is required' })
    return
  }
  const data: NotesData = normalizeData(ctx.dataRef.current.get(ctx.tabId))
  if (!data.pages.find(p => p.id === pageId)) {
    ctx.respond({ success: false, error: `Page not found: ${pageId}` })
    return
  }
  applyUpdate(ctx, prev => {
    const pages = prev.pages.filter(p => p.id !== pageId)
    const content = { ...prev.content }
    delete content[pageId]
    const activePageId = prev.activePageId === pageId
      ? (pages.length > 0 ? pages[0].id : null)
      : prev.activePageId
    return { ...prev, pages, content, activePageId }
  })
  ctx.respond({ success: true, elementId: pageId, message: `Deleted page: ${pageId}` })
}

/** Update page title and/or content. Params: node_id/elementId + title and/or content */
async function handleUpdateElement(msg: any, ctx: TabPluginContext): Promise<void> {
  const pageId = msg.node_id || msg.elementId
  if (!pageId) {
    ctx.respond({ success: false, error: 'node_id or elementId is required' })
    return
  }
  const data: NotesData = normalizeData(ctx.dataRef.current.get(ctx.tabId))
  if (!data.pages.find(p => p.id === pageId)) {
    ctx.respond({ success: false, error: `Page not found: ${pageId}` })
    return
  }

  const newTitle = msg.title || msg.topic
  const newContent = msg.content
  const changes: string[] = []

  applyUpdate(ctx, prev => {
    let pages = prev.pages
    let content = prev.content
    let activePageId = prev.activePageId

    if (newTitle) {
      pages = pages.map(p =>
        p.id === pageId ? { ...p, title: newTitle, updatedAt: new Date().toISOString() } : p
      )
      changes.push('title')
    }
    if (newContent) {
      content = { ...content, [pageId]: newContent }
      pages = pages.map(p =>
        p.id === pageId ? { ...p, updatedAt: new Date().toISOString() } : p
      )
      // Switch to updated page so user sees the change
      activePageId = pageId
      changes.push('content')
    }

    return { ...prev, pages, content, activePageId }
  })
  // Force editor remount if content was changed
  if (newContent && _bumpRevision.current) {
    _bumpRevision.current()
  }
  ctx.respond({ success: true, elementId: pageId, message: `Updated ${pageId}: ${changes.join(', ')}` })
}

/** Replace full notesData. Params: notesData */
async function handleSetData(msg: any, ctx: TabPluginContext): Promise<void> {
  if (msg.notesData) {
    applyUpdate(ctx, () => normalizeData(msg.notesData))
    if (_bumpRevision.current) _bumpRevision.current()
  }
  const activeTab = ctx.tabsRef.current.find(t => t.id === ctx.tabId)
  ctx.respond({ success: true, workspaceFilename: activeTab?.workspaceFilename ?? null })
}

// ===== NotesPanel Component =====

function NotesPanel({ tabId, dataRef, markDirty, tab }: TabContentProps) {
  const initData = dataRef.current.get(tabId)
  const [notesData, setNotesData] = useState<NotesData>(() => normalizeData(initData))
  const [pendingEditId, setPendingEditId] = useState<string | null>(null)
  const [editorRevision, setEditorRevision] = useState(0)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const updateData = useCallback((updater: (prev: NotesData) => NotesData) => {
    setNotesData(prev => {
      const next = updater(prev)
      dataRef.current.set(tabId, next)
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => markDirty(), 300)
      return next
    })
  }, [tabId, dataRef, markDirty])

  // Expose updater and revision bumper for tool actions
  useEffect(() => {
    _liveUpdater.current = updateData
    _bumpRevision.current = () => setEditorRevision(r => r + 1)
    return () => {
      _liveUpdater.current = null
      _bumpRevision.current = null
    }
  }, [updateData])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  // UI page operations
  const handleAddPageUI = useCallback(() => {
    const now = new Date().toISOString()
    const id = crypto.randomUUID()
    updateData(prev => ({
      ...prev,
      pages: [...prev.pages, { id, title: 'Untitled', createdAt: now, updatedAt: now }],
      content: { ...prev.content, [id]: [] },
      activePageId: id,
    }))
    setPendingEditId(id)
  }, [updateData])

  const handleSelectPageUI = useCallback((id: string) => {
    updateData(prev => ({ ...prev, activePageId: id }))
  }, [updateData])

  const handleDeletePageUI = useCallback((id: string) => {
    updateData(prev => {
      const pages = prev.pages.filter(p => p.id !== id)
      const content = { ...prev.content }
      delete content[id]
      const activePageId = prev.activePageId === id
        ? (pages.length > 0 ? pages[0].id : null)
        : prev.activePageId
      return { ...prev, pages, content, activePageId }
    })
  }, [updateData])

  const handleRenamePageUI = useCallback((id: string, newTitle: string) => {
    updateData(prev => ({
      ...prev,
      pages: prev.pages.map(p =>
        p.id === id ? { ...p, title: newTitle, updatedAt: new Date().toISOString() } : p
      ),
    }))
  }, [updateData])

  const handleReorderPages = useCallback((reordered: NotesPage[]) => {
    updateData(prev => ({ ...prev, pages: reordered }))
  }, [updateData])

  const handlePendingEditConsumed = useCallback(() => {
    setPendingEditId(null)
  }, [])

  // Folder operations
  const handleAddFolder = useCallback(() => {
    const id = crypto.randomUUID()
    updateData(prev => ({
      ...prev,
      folders: [...prev.folders, { id, title: 'New Folder', collapsed: false }],
    }))
    setPendingEditId(id)
  }, [updateData])

  const handleDeleteFolder = useCallback((folderId: string) => {
    updateData(prev => ({
      ...prev,
      folders: prev.folders.filter(f => f.id !== folderId),
      pages: prev.pages.map(p => p.folderId === folderId ? { ...p, folderId: undefined } : p),
    }))
  }, [updateData])

  const handleRenameFolder = useCallback((id: string, newTitle: string) => {
    updateData(prev => ({
      ...prev,
      folders: prev.folders.map(f => f.id === id ? { ...f, title: newTitle } : f),
    }))
  }, [updateData])

  const handleToggleFolder = useCallback((id: string) => {
    updateData(prev => ({
      ...prev,
      folders: prev.folders.map(f => f.id === id ? { ...f, collapsed: !f.collapsed } : f),
    }))
  }, [updateData])

  const handleMovePageToFolder = useCallback((pageId: string, folderId: string | null) => {
    updateData(prev => ({
      ...prev,
      pages: prev.pages.map(p => p.id === pageId ? { ...p, folderId: folderId ?? undefined } : p),
    }))
  }, [updateData])

  const handleReorderFolders = useCallback((reordered: NotesFolder[]) => {
    updateData(prev => ({ ...prev, folders: reordered }))
  }, [updateData])

  const handleContentChange = useCallback((content: any[]) => {
    const activeId = notesData.activePageId
    if (!activeId) return
    updateData(prev => {
      const pages = prev.pages.map(p => {
        if (p.id !== activeId) return p
        let title = p.title
        if (title === 'Untitled' && content.length > 0) {
          const first = content[0]
          if (first.type === 'heading' && first.content?.length > 0) {
            const text = first.content.map((c: any) => c.text || '').join('').trim()
            if (text) title = text
          }
        }
        return { ...p, title, updatedAt: new Date().toISOString() }
      })
      return { ...prev, pages, content: { ...prev.content, [activeId]: content } }
    })
  }, [notesData.activePageId, updateData])

  const uploadFile = useCallback(async (file: File): Promise<string> => {
    const workspaceFilename = tab?.workspaceFilename
    if (!workspaceFilename) {
      throw new Error('Cannot upload image: no workspace file associated with this tab')
    }
    const formData = new FormData()
    formData.append('file', file)
    formData.append('workspace', workspaceFilename)
    const response = await fetch('/api/notes/upload', { method: 'POST', body: formData })
    if (!response.ok) {
      throw new Error(`Image upload failed: ${response.status} ${response.statusText}`)
    }
    const result = await response.json()
    return result.url
  }, [tab?.workspaceFilename])

  const activeContent = notesData.activePageId
    ? notesData.content[notesData.activePageId]
    : undefined

  const activePage = notesData.activePageId
    ? notesData.pages.find(p => p.id === notesData.activePageId)
    : null

  return h('div', { className: 'notes-panel' },
    h(NotesSidebar, {
      pages: notesData.pages,
      folders: notesData.folders ?? [],
      activePageId: notesData.activePageId,
      onSelectPage: handleSelectPageUI,
      onAddPage: handleAddPageUI,
      onDeletePage: handleDeletePageUI,
      onRenamePage: handleRenamePageUI,
      onReorderPages: handleReorderPages,
      onAddFolder: handleAddFolder,
      onDeleteFolder: handleDeleteFolder,
      onRenameFolder: handleRenameFolder,
      onToggleFolder: handleToggleFolder,
      onMovePageToFolder: handleMovePageToFolder,
      onReorderFolders: handleReorderFolders,
      pendingEditId,
      onPendingEditConsumed: handlePendingEditConsumed,
    }),
    h('div', { className: 'notes-editor-container' },
      notesData.activePageId && activePage
        ? h('div', { className: 'notes-editor-wrapper' },
            h('div', { className: 'notes-page-title' }, activePage.title),
            h(NoteEditor, {
              key: `${notesData.activePageId}-${editorRevision}`,
              initialContent: activeContent,
              onChange: handleContentChange,
              uploadFile,
            }),
          )
        : h('div', { className: 'notes-placeholder' },
            h('p', null, 'Select or create a page to start'),
          ),
    ),
  )
}

// ===== Registration =====

registerTabType('notes', {
  label: 'Notes',
  icon: '\uD83D\uDCDD',
  description: 'Notion-style block editor for notes and documents',
  defaultTitle: 'New Notes',
  uiConfig: { showBlockLibrary: false, showToolbar: true, containerClass: 'notes-mode' },
  dataKey: 'notesData',
  fileExtension: '.rcnotes',
  toolActions: {
    get_elements: handleGetElements,
    get_element: handleGetElement,
    add_element: handleAddElement,
    remove_element: handleRemoveElement,
    update_element: handleUpdateElement,
    set_data: handleSetData,
  },
})

registerTabComponent('notes', NotesPanel)
registerToolbarComponent('notes', null)
