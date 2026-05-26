/**
 * files.tsx - Files tab plugin (self-registering)
 *
 * Registers its tab type, component, and tool actions via tabRegistry.
 * Provides a project-scoped file explorer using @svar-ui/react-filemanager.
 * Supports multiple root folders displayed as top-level entries in the tree.
 *
 * Tool actions (via tab_action):
 *   get_elements  — list current directory contents or history
 *   open_file     — open a file with system default app
 *   list_history  — get file open history
 *   navigate      — navigate to a specific path
 *   set_data      — replace full filesData (rootFolders, history)
 */

import { useState, useCallback, useRef, useEffect, useMemo, createElement as h } from 'react'
import { Filemanager, WillowDark } from '@svar-ui/react-filemanager'
import { Locale } from '@svar-ui/react-core'
import '@svar-ui/react-filemanager/all.css'
import { registerTabType, registerTabComponent, registerToolbarComponent } from './tabRegistry.js'
import type { TabContentProps, TabPluginContext } from './types.js'
import type { IApi, IEntity } from '@svar-ui/filemanager-store'

// ===== Types =====

interface HistoryEntry {
  path: string
  name: string
  ext: string
  openedAt: string
}

interface RootFolderEntry {
  name: string   // display name (last segment of path, or user-customized)
  path: string   // absolute path
}

interface FilesData {
  rootFolders: RootFolderEntry[]
  history: HistoryEntry[]
}

const MAX_HISTORY = 200

function emptyFilesData(): FilesData {
  return { rootFolders: [], history: [] }
}

function normalizeData(data: any): FilesData {
  const base = { ...emptyFilesData(), ...data }
  // Backward compat: migrate old rootFolder string to rootFolders array
  if (data?.rootFolder && (!data.rootFolders || data.rootFolders.length === 0)) {
    const oldPath: string = data.rootFolder
    const name = oldPath.split(/[\\/]/).pop() || 'Root'
    base.rootFolders = [{ name, path: oldPath }]
  }
  delete (base as any).rootFolder
  return base
}

// ===== Live component updater =====

type FilesUpdater = (updater: (prev: FilesData) => FilesData) => void
const _liveUpdater: { current: FilesUpdater | null } = { current: null }
const _liveApi: { current: IApi | null } = { current: null }
const _currentDir: { current: string | null } = { current: null }
const _rootFoldersRef: { current: RootFolderEntry[] } = { current: [] }

function applyUpdate(ctx: TabPluginContext, updater: (prev: FilesData) => FilesData): FilesData {
  const prev: FilesData = normalizeData(ctx.dataRef.current.get(ctx.tabId))
  const next = updater(prev)
  ctx.dataRef.current.set(ctx.tabId, next)
  if (_liveUpdater.current) {
    _liveUpdater.current(() => next)
  }
  return next
}

// ===== Path conversion: SVAR IDs ↔ absolute paths =====
// Multi-root: SVAR tree has "/" as virtual root. Each root folder appears as "/<name>".
// Example: /ProjectA/src/file.ts → D:\Work\ProjectA\src\file.ts

function findRootForAbsPath(rootFolders: RootFolderEntry[], absPath: string): RootFolderEntry | null {
  const normPath = absPath.replace(/\\/g, '/')
  for (const rf of rootFolders) {
    const normRoot = rf.path.replace(/\\/g, '/').replace(/\/$/, '')
    if (normPath === normRoot || normPath.startsWith(normRoot + '/')) {
      return rf
    }
  }
  return null
}

function findRootByName(rootFolders: RootFolderEntry[], name: string): RootFolderEntry | null {
  return rootFolders.find(rf => rf.name === name) || null
}

/** Convert absolute path to SVAR ID: /<rootName>/<relative> */
function toSvarId(rootFolders: RootFolderEntry[], absPath: string): string {
  const rf = findRootForAbsPath(rootFolders, absPath)
  if (!rf) return '/'
  const normRoot = rf.path.replace(/\\/g, '/').replace(/\/$/, '')
  const normPath = absPath.replace(/\\/g, '/')
  const rel = normPath.slice(normRoot.length) // e.g. "/src/main.ts" or ""
  return '/' + rf.name + (rel || '')
}

/** Convert SVAR ID back to absolute file path */
function toAbsPath(rootFolders: RootFolderEntry[], svarId: string): string | null {
  if (svarId === '/') return null // virtual root
  const withoutLeading = svarId.slice(1) // "ProjectA/src/file.ts"
  const slashIdx = withoutLeading.indexOf('/')
  const name = slashIdx === -1 ? withoutLeading : withoutLeading.slice(0, slashIdx)
  const rest = slashIdx === -1 ? '' : withoutLeading.slice(slashIdx) // "/src/file.ts"
  const rf = findRootByName(rootFolders, name)
  if (!rf) return null
  const normRoot = rf.path.replace(/\\/g, '/').replace(/\/$/, '')
  return (normRoot + rest).replace(/\//g, '\\')
}

/** Get the rootPath for IPC validation from a SVAR ID */
function rootPathForSvarId(rootFolders: RootFolderEntry[], svarId: string): string | null {
  if (svarId === '/') return null
  const withoutLeading = svarId.slice(1)
  const slashIdx = withoutLeading.indexOf('/')
  const name = slashIdx === -1 ? withoutLeading : withoutLeading.slice(0, slashIdx)
  return findRootByName(rootFolders, name)?.path || null
}

/** Check if a SVAR ID is a root folder entry (top-level) */
function isRootEntry(rootFolders: RootFolderEntry[], svarId: string): boolean {
  return rootFolders.some(rf => '/' + rf.name === svarId)
}

// ===== SVAR data helpers =====

function ipcItemsToSvar(rootFolders: RootFolderEntry[], items: Array<{ id: string; name: string; size: number; date: string; type: 'file' | 'folder'; lazy: boolean }>): IEntity[] {
  return items.map(item => ({
    id: toSvarId(rootFolders, item.id),
    type: item.type,
    size: item.type === 'file' ? item.size : undefined,
    date: new Date(item.date),
    lazy: item.type === 'folder' ? true : undefined,
  }))
}

/** Build initial data for all root folders + one level of subfolders */
async function buildInitialData(rootFolders: RootFolderEntry[]): Promise<IEntity[]> {
  const api = window.electronAPI
  if (!api || rootFolders.length === 0) return []

  const result: IEntity[] = []

  const preloadedFolders = new Set<string>() // SVAR IDs of folders with pre-loaded children

  for (const rf of rootFolders) {
    const listing = await api.fsListDir(rf.path, rf.path)
    const rootSvarId = '/' + rf.name
    // Root entry: mark as pre-loaded
    preloadedFolders.add(rootSvarId)
    result.push({ id: rootSvarId, type: 'folder', date: new Date() })
    if (!listing.error && listing.items) {
      result.push(...ipcItemsToSvar(rootFolders, listing.items))
      // Pre-load one more level for expand arrows
      const folders = listing.items.filter(i => i.type === 'folder')
      const subLoads = folders.map(async (folder) => {
        const folderSvarId = toSvarId(rootFolders, folder.id)
        const sub = await api.fsListDir(folder.id, rf.path)
        if (!sub.error && sub.items) {
          preloadedFolders.add(folderSvarId)
          result.push(...ipcItemsToSvar(rootFolders, sub.items))
        }
      })
      await Promise.all(subLoads)
    }
  }

  // Mark pre-loaded folders as NOT lazy, others (deeper) as lazy
  for (const item of result) {
    if (item.type === 'folder') {
      item.lazy = !preloadedFolders.has(item.id as string)
    }
  }
  return result
}

// ===== Tool Actions =====

async function handleGetElements(msg: any, ctx: TabPluginContext) {
  const data: FilesData = normalizeData(ctx.dataRef.current.get(ctx.tabId))

  if (msg.mode === 'history') {
    ctx.respond({ success: true, history: data.history })
    return
  }

  if (data.rootFolders.length === 0) {
    ctx.respond({ success: false, error: 'No root folders configured' })
    return
  }
  const rootFolders = data.rootFolders
  let absDir: string | null
  if (msg.path) {
    absDir = msg.path.startsWith('/') && !msg.path.match(/^[A-Za-z]:/)
      ? toAbsPath(rootFolders, msg.path)
      : msg.path
  } else {
    absDir = _currentDir.current ? toAbsPath(rootFolders, _currentDir.current) : rootFolders[0].path
  }
  if (!absDir) {
    ctx.respond({ success: false, error: 'Cannot resolve path' })
    return
  }
  const rootPath = findRootForAbsPath(rootFolders, absDir)?.path
  if (!rootPath) {
    ctx.respond({ success: false, error: 'Path not within any root folder' })
    return
  }
  const api = window.electronAPI
  if (!api) {
    ctx.respond({ success: false, error: 'electronAPI not available' })
    return
  }
  const result = await api.fsListDir(absDir, rootPath)
  if (result.error) {
    ctx.respond({ success: false, error: result.error })
    return
  }
  ctx.respond({
    success: true,
    path: absDir,
    rootFolders: rootFolders.map(rf => ({ name: rf.name, path: rf.path })),
    items: result.items?.map(i => ({ name: i.name, type: i.type, size: i.size, path: i.id })) || [],
  })
}

async function handleOpenFile(msg: any, ctx: TabPluginContext) {
  if (!msg.path) {
    ctx.respond({ success: false, error: 'Missing path parameter' })
    return
  }
  const api = window.electronAPI
  if (!api) {
    ctx.respond({ success: false, error: 'electronAPI not available' })
    return
  }
  const result = await api.fsOpenFile(msg.path)
  if (result.error) {
    ctx.respond({ success: false, error: result.error })
    return
  }
  const name = msg.path.split(/[\\/]/).pop() || msg.path
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  applyUpdate(ctx, prev => {
    const filtered = prev.history.filter(h => h.path !== msg.path)
    const entry: HistoryEntry = { path: msg.path, name, ext, openedAt: new Date().toISOString() }
    return { ...prev, history: [entry, ...filtered].slice(0, MAX_HISTORY) }
  })
  ctx.respond({ success: true })
}

async function handleListHistory(msg: any, ctx: TabPluginContext) {
  const data: FilesData = normalizeData(ctx.dataRef.current.get(ctx.tabId))
  let history = data.history
  if (msg.filter) {
    history = history.filter(h => h.ext === msg.filter)
  }
  ctx.respond({ success: true, history })
}

async function handleNavigate(msg: any, ctx: TabPluginContext) {
  if (!msg.path) {
    ctx.respond({ success: false, error: 'Missing path parameter' })
    return
  }
  const data: FilesData = normalizeData(ctx.dataRef.current.get(ctx.tabId))
  if (data.rootFolders.length === 0) {
    ctx.respond({ success: false, error: 'No root folders configured' })
    return
  }
  if (_liveApi.current) {
    _liveApi.current.exec('set-path', { id: msg.path })
    _currentDir.current = msg.path
  }
  ctx.respond({ success: true, path: msg.path })
}

async function handleSetData(msg: any, ctx: TabPluginContext) {
  const newData = msg.data || msg
  applyUpdate(ctx, () => normalizeData(newData))
  ctx.respond({ success: true })
}

// ===== FilesPanel Component =====

function FilesPanel({ tabId, dataRef, markDirty, tab }: TabContentProps) {
  const initData = dataRef.current.get(tabId)
  const [filesData, setFilesData] = useState<FilesData>(() => normalizeData(initData))
  const [initialData, setInitialData] = useState<IEntity[]>([])
  const [historyFilter, setHistoryFilter] = useState<string>('all')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const apiRef = useRef<IApi | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [historyWidth, setHistoryWidth] = useState(220)
  const panelRef = useRef<HTMLDivElement>(null)
  // Navigation history for back/forward
  const navHistory = useRef<string[]>([])
  const navIndex = useRef(-1)
  const isNavAction = useRef(false)
  const [, forceUpdate] = useState(0) // trigger re-render for button enable/disable

  // Keep ref in sync for interceptors to read dynamically
  _rootFoldersRef.current = filesData.rootFolders

  const updateData = useCallback((updater: (prev: FilesData) => FilesData) => {
    setFilesData(prev => {
      const next = updater(prev)
      dataRef.current.set(tabId, next)
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => markDirty(), 300)
      return next
    })
  }, [tabId, dataRef, markDirty])

  useEffect(() => {
    _liveUpdater.current = updateData
    return () => { _liveUpdater.current = null }
  }, [updateData])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      _liveApi.current = null
      _currentDir.current = null
    }
  }, [])

  // Inject resize handle for SVAR sidebar after mount
  useEffect(() => {
    if (!panelRef.current) return
    const tryInject = () => {
      const sidebar = panelRef.current?.querySelector('.wx-sidebar') as HTMLElement | null
      if (!sidebar || sidebar.querySelector('.files-sidebar-resize')) return
      const handle = document.createElement('div')
      handle.className = 'files-sidebar-resize'
      sidebar.style.position = 'relative'
      sidebar.appendChild(handle)
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault()
        const startX = e.clientX
        const startW = sidebar.offsetWidth
        const onMove = (ev: MouseEvent) => {
          const newW = Math.max(120, Math.min(500, startW + (ev.clientX - startX)))
          sidebar.style.width = newW + 'px'
          sidebar.style.minWidth = newW + 'px'
          sidebar.style.maxWidth = newW + 'px'
        }
        const onUp = () => {
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
        }
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      })
    }
    tryInject()
    const t = setTimeout(tryInject, 500)
    const t2 = setTimeout(tryInject, 1500)
    return () => { clearTimeout(t); clearTimeout(t2) }
  }, [initialData])

  // Load initial data when rootFolders changes, then background-preload all subfolders
  const rootFoldersKey = JSON.stringify(filesData.rootFolders)
  useEffect(() => {
    if (filesData.rootFolders.length === 0) return
    let cancelled = false
    buildInitialData(filesData.rootFolders).then(data => {
      setInitialData(data)
      _currentDir.current = '/' + filesData.rootFolders[0].name
    })
  }, [rootFoldersKey])

  // Add folder
  const handleAddFolder = useCallback(async () => {
    const api = window.electronAPI
    if (!api) return
    try {
      const result = await api.showOpenDialog({ properties: ['openDirectory'], title: 'Add Folder' })
      if (result.canceled || !result.filePaths.length) return
      const folderPath = result.filePaths[0]
      // Check duplicate path
      if (filesData.rootFolders.some(rf => rf.path === folderPath)) {
        setErrorMsg('This folder is already added')
        return
      }
      let name = folderPath.split(/[\\/]/).pop() || 'Folder'
      // Ensure unique name
      const existingNames = new Set(filesData.rootFolders.map(rf => rf.name))
      const baseName = name
      let suffix = 2
      while (existingNames.has(name)) {
        name = `${baseName} (${suffix++})`
      }
      updateData(prev => ({ ...prev, rootFolders: [...prev.rootFolders, { name, path: folderPath }] }))
    } catch (err: any) {
      setErrorMsg(`Failed to add folder: ${err.message}`)
    }
  }, [filesData.rootFolders, updateData])

  // Remove folder (from list only, not disk)
  const handleRemoveFolder = useCallback((index: number) => {
    updateData(prev => ({
      ...prev,
      rootFolders: prev.rootFolders.filter((_, i) => i !== index),
    }))
  }, [updateData])

  // Add file to open history
  const addToHistory = useCallback((filePath: string) => {
    const name = filePath.split(/[\\/]/).pop() || filePath
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
    updateData(prev => {
      const filtered = prev.history.filter(h => h.path !== filePath)
      const entry: HistoryEntry = { path: filePath, name, ext, openedAt: new Date().toISOString() }
      return { ...prev, history: [entry, ...filtered].slice(0, MAX_HISTORY) }
    })
  }, [updateData])

  // SVAR init callback — wire up file operations via IPC
  const handleInit = useCallback((api: IApi) => {
    apiRef.current = api
    _liveApi.current = api

    const elApi = window.electronAPI
    if (!elApi) return

    // Use _rootFoldersRef.current inside interceptors to avoid stale closure
    const rf = () => _rootFoldersRef.current

    // Lazy loading — only fetch if folder hasn't been loaded yet
    api.intercept('request-data', async (ev) => {
      if (ev.id === '/') return false // virtual root, already pre-loaded
      // Check if this folder already has data (avoid duplicates)
      const existing = api.getFile?.(ev.id)
      if (existing && !existing.lazy) return false // already loaded
      const absPath = toAbsPath(rf(), ev.id)
      const rootPath = rootPathForSvarId(rf(), ev.id)
      if (!absPath || !rootPath) return false
      const result = await elApi.fsListDir(absPath, rootPath)
      if (result.error) {
        console.error('[Files] request-data error:', result.error)
        return false
      }
      const items = ipcItemsToSvar(rf(), result.items || [])
      api.exec('provide-data', { id: ev.id, data: items, skipProvider: true })
      // Preload grandchildren so their expand arrows appear in tree
      const subFolders = (result.items || []).filter(i => i.type === 'folder')
      for (const sub of subFolders) {
        const subSvarId = toSvarId(rf(), sub.id)
        const subResult = await elApi.fsListDir(sub.id, rootPath!)
        if (!subResult.error && subResult.items) {
          api.exec('provide-data', { id: subSvarId, data: ipcItemsToSvar(rf(), subResult.items), skipProvider: true })
        }
      }
      return false
    })

    // File open
    api.on('open-file', async (ev) => {
      const absPath = toAbsPath(rf(), ev.id)
      if (!absPath) return
      const result = await elApi.fsOpenFile(absPath)
      if (result.error) {
        setErrorMsg(`Failed to open file: ${result.error}`)
        return
      }
      addToHistory(absPath)
    })

    // Track current directory + navigation history
    api.on('set-path', (ev) => {
      _currentDir.current = ev.id
      if (!isNavAction.current) {
        navHistory.current = navHistory.current.slice(0, navIndex.current + 1)
        navHistory.current.push(ev.id)
        navIndex.current = navHistory.current.length - 1
        forceUpdate(n => n + 1)
      }
      isNavAction.current = false
      // Expand tree folders + preload grandchildren asynchronously
      setTimeout(async () => {
        // Expand parent folders in tree
        const parts = ev.id.split('/').filter(Boolean)
        let p = ''
        for (const part of parts) {
          p += '/' + part
          const node = api.getFile?.(p)
          if (node && node.type === 'folder' && !node.open) {
            api.exec('open-tree-folder', { id: p, mode: true })
          }
        }
        // Preload grandchildren: for each subfolder visible in the current dir,
        // load its children so tree arrows appear
        const currentNode = api.getFile?.(ev.id)
        if (currentNode?.data) {
          for (const child of currentNode.data) {
            if (child.type === 'folder' && child.lazy) {
              const childAbs = toAbsPath(rf(), child.id)
              const childRoot = rootPathForSvarId(rf(), child.id)
              if (childAbs && childRoot) {
                const childResult = await elApi.fsListDir(childAbs, childRoot)
                if (!childResult.error && childResult.items) {
                  api.exec('provide-data', { id: child.id, data: ipcItemsToSvar(rf(), childResult.items), skipProvider: true })
                }
              }
            }
          }
        }
      }, 0)
    })

    // Create folder
    api.intercept('create-file', async (ev) => {
      if (ev.file?.type !== 'folder') return true
      const parentAbs = toAbsPath(rf(), ev.parent)
      const rootPath = rootPathForSvarId(rf(), ev.parent)
      if (!parentAbs || !rootPath) return false
      const result = await elApi.fsCreateFolder(parentAbs, ev.file.name, rootPath)
      if (result.error) {
        setErrorMsg(`Failed to create folder: ${result.error}`)
        return false
      }
      if (result.path) {
        ev.newId = toSvarId(rf(), result.path)
      }
      return true
    })

    // Rename (block root entries)
    api.intercept('rename-file', async (ev) => {
      if (isRootEntry(rf(), ev.id)) {
        setErrorMsg('Cannot rename a root folder here')
        return false
      }
      const absPath = toAbsPath(rf(), ev.id)
      const rootPath = rootPathForSvarId(rf(), ev.id)
      if (!absPath || !rootPath) return false
      const result = await elApi.fsRenameItem(absPath, ev.name, rootPath)
      if (result.error) {
        setErrorMsg(`Failed to rename: ${result.error}`)
        return false
      }
      if (result.newPath) {
        ev.newId = toSvarId(rf(), result.newPath)
      }
      return true
    })

    // Delete (block root entries, use trash)
    api.intercept('delete-files', async (ev) => {
      const filtered = ev.ids.filter((id: string) => !isRootEntry(rf(), id))
      if (filtered.length === 0) {
        setErrorMsg('Cannot delete root folders from here')
        return false
      }
      // All must be in same root
      const rootPath = rootPathForSvarId(rf(), filtered[0])
      if (!rootPath) return false
      const absPaths = filtered.map((id: string) => toAbsPath(rf(), id)).filter(Boolean) as string[]
      const result = await elApi.fsTrashItems(absPaths, rootPath)
      if (result.error) {
        setErrorMsg(`Failed to delete: ${result.error}`)
        return false
      }
      ev.ids = filtered // update to only delete non-root entries from SVAR
      return true
    })

    // Copy (block cross-root)
    api.intercept('copy-files', async (ev) => {
      const targetRoot = rootPathForSvarId(rf(), ev.target)
      if (!targetRoot) return false
      for (const id of ev.ids) {
        if (rootPathForSvarId(rf(), id) !== targetRoot) {
          setErrorMsg('Cannot copy between different root folders')
          return false
        }
      }
      const absSrcs = ev.ids.map((id: string) => toAbsPath(rf(), id)).filter(Boolean) as string[]
      const absTarget = toAbsPath(rf(), ev.target)
      if (!absTarget) return false
      const result = await elApi.fsCopyItems(absSrcs, absTarget, targetRoot)
      if (result.error) {
        setErrorMsg(`Failed to copy: ${result.error}`)
        return false
      }
      const targetResult = await elApi.fsListDir(absTarget, targetRoot)
      if (!targetResult.error && targetResult.items) {
        api.exec('provide-data', { id: ev.target, data: ipcItemsToSvar(rf(), targetResult.items), skipProvider: true })
      }
      return false
    })

    // Move (block cross-root)
    api.intercept('move-files', async (ev) => {
      const targetRoot = rootPathForSvarId(rf(), ev.target)
      if (!targetRoot) return false
      for (const id of ev.ids) {
        if (isRootEntry(rf(), id)) {
          setErrorMsg('Cannot move root folders')
          return false
        }
        if (rootPathForSvarId(rf(), id) !== targetRoot) {
          setErrorMsg('Cannot move between different root folders')
          return false
        }
      }
      const absSrcs = ev.ids.map((id: string) => toAbsPath(rf(), id)).filter(Boolean) as string[]
      const absTarget = toAbsPath(rf(), ev.target)
      if (!absTarget) return false
      const result = await elApi.fsMoveItems(absSrcs, absTarget, targetRoot)
      if (result.error) {
        setErrorMsg(`Failed to move: ${result.error}`)
        return false
      }
      return true
    })

    // Override root folder display names to include absolute path
    setTimeout(() => {
      const stores = api.getStores?.()
      if (!stores?.data) return
      for (const entry of rf()) {
        const node = stores.data.getFile?.('/' + entry.name) || api.getFile?.('/' + entry.name)
        if (node) {
          (node as any).name = `${entry.name} (${entry.path})`
        }
      }
    }, 100)
  }, [addToHistory])

  // Navigation: back/forward
  const goBack = useCallback(() => {
    if (navIndex.current > 0 && apiRef.current) {
      isNavAction.current = true
      navIndex.current--
      apiRef.current.exec('set-path', { id: navHistory.current[navIndex.current] })
      forceUpdate(n => n + 1)
    }
  }, [])
  const goForward = useCallback(() => {
    if (navIndex.current < navHistory.current.length - 1 && apiRef.current) {
      isNavAction.current = true
      navIndex.current++
      apiRef.current.exec('set-path', { id: navHistory.current[navIndex.current] })
      forceUpdate(n => n + 1)
    }
  }, [])

  // Mouse back/forward buttons
  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (e.button === 3) { e.preventDefault(); goBack() }
    if (e.button === 4) { e.preventDefault(); goForward() }
  }, [goBack, goForward])

  // Single-click on "Back to parent folder" — inject click handler into SVAR content
  useEffect(() => {
    if (!panelRef.current) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      const backItem = target.closest('[data-id=":parent"]') || target.closest('.wx-back-to-parent')
      if (!backItem) return
      // Find parent path from breadcrumbs
      const state = apiRef.current?.getState?.()
      if (!state) return
      const panels = state.panels as any[]
      const panel = panels?.[state.activePanel ?? 0]
      const crumbs = panel?._crumbs
      if (crumbs && crumbs.length >= 2) {
        e.preventDefault()
        e.stopPropagation()
        const parentId = crumbs[crumbs.length - 2].id
        apiRef.current?.exec('set-path', { id: parentId })
      }
    }
    panelRef.current.addEventListener('click', handler, true)
    return () => panelRef.current?.removeEventListener('click', handler, true)
  }, [initialData])

  // Manual refresh
  const handleRefresh = useCallback(async () => {
    const rootFolders = filesData.rootFolders
    if (rootFolders.length === 0) return
    const api = window.electronAPI
    if (!api) return
    const svarDir = _currentDir.current || '/' + rootFolders[0].name
    const absDir = toAbsPath(rootFolders, svarDir)
    const rootPath = rootPathForSvarId(rootFolders, svarDir)
    if (!absDir || !rootPath) return
    const result = await api.fsListDir(absDir, rootPath)
    if (result.error) {
      setErrorMsg(result.error)
      return
    }
    if (result.items && apiRef.current) {
      apiRef.current.exec('provide-data', { id: svarDir, data: ipcItemsToSvar(rootFolders, result.items), skipProvider: true })
    }
  }, [filesData.rootFolders])

  // Open history entry
  const handleHistoryClick = useCallback(async (entry: HistoryEntry) => {
    const api = window.electronAPI
    if (!api) return
    const result = await api.fsOpenFile(entry.path)
    if (result.error) {
      setErrorMsg(`Failed to open: ${result.error}`)
      return
    }
    addToHistory(entry.path)
  }, [addToHistory])

  // Remove history entry
  const handleRemoveHistory = useCallback((index: number) => {
    updateData(prev => ({
      ...prev,
      history: prev.history.filter((_, i) => i !== index),
    }))
  }, [updateData])

  // Filter history
  const filteredHistory = historyFilter === 'all'
    ? filesData.history
    : filesData.history.filter(h => {
        if (historyFilter === 'excel') return ['xlsx', 'xls', 'csv'].includes(h.ext)
        if (historyFilter === 'word') return ['doc', 'docx'].includes(h.ext)
        if (historyFilter === 'pdf') return h.ext === 'pdf'
        if (historyFilter === 'image') return ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'].includes(h.ext)
        return true
      })

  // Locale: use tab title as root label
  const rootLabel = tab?.title || 'Workspace'
  const localeWords = useMemo(() => ({
    filemanager: { 'My files': rootLabel },
  }), [rootLabel])

  // Error banner dismiss
  useEffect(() => {
    if (!errorMsg) return
    const t = setTimeout(() => setErrorMsg(null), 5000)
    return () => clearTimeout(t)
  }, [errorMsg])

  // Drag resize for history panel
  const startHistoryResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = historyWidth
    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX
      setHistoryWidth(Math.max(120, Math.min(500, startW + delta)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [historyWidth])

  // Custom menu options: add "Add Root Folder" to the "Add New" menu
  // (must be before early return to satisfy React Hooks rules)
  const menuOptions = useCallback((mode: string) => {
    if (mode === 'add') {
      return [
        { icon: 'mdi mdi-folder-plus-outline', text: 'Add new file', id: 'add-file', hotkey: '' },
        { icon: 'mdi mdi-file-plus-outline', text: 'Add new folder', id: 'add-folder', hotkey: '' },
        { icon: 'mdi mdi-file-upload-outline', text: 'Upload file', id: 'upload', comp: 'upload', hotkey: '' },
        { comp: 'separator', hotkey: '' },
        { icon: 'mdi mdi-folder-network-outline', text: 'Add Root Folder...', id: 'add-root-folder', hotkey: '', handler: () => handleAddFolder() },
      ]
    }
    return null // use defaults for other menus
  }, [handleAddFolder])

  // ===== Render =====

  // No root folders
  if (filesData.rootFolders.length === 0) {
    return h('div', { className: 'files-panel' },
      h('div', { className: 'files-select-root' },
        h('div', { className: 'files-select-root-icon' }, '\uD83D\uDCC2'),
        h('h2', null, 'Select a Folder'),
        h('p', null, 'Choose a root folder to browse files'),
        h('button', { className: 'files-select-btn', onClick: handleAddFolder }, 'Select Folder'),
      ),
    )
  }

  const canGoBack = navIndex.current > 0
  const canGoForward = navIndex.current < navHistory.current.length - 1

  return h('div', { className: 'files-panel', ref: panelRef, onMouseUp: handleMouseUp },
    // Error toast
    errorMsg && h('div', { className: 'files-error-toast', onClick: () => setErrorMsg(null) }, errorMsg),

    // Main area (nav bar + SVAR)
    h('div', { className: 'files-main-col' },
      // Navigation bar (React-rendered, not DOM-injected)
      h('div', { className: 'files-nav-bar' },
        h('button', {
          className: 'files-nav-btn', onClick: goBack, disabled: !canGoBack, title: 'Back',
        }, h('svg', { viewBox: '0 0 20 20', width: 16, height: 16 },
          h('path', { d: 'M10 4l-6 6 6 6M4 10h13', stroke: 'currentColor', strokeWidth: 2.5, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' }),
        )),
        h('button', {
          className: 'files-nav-btn', onClick: goForward, disabled: !canGoForward, title: 'Forward',
        }, h('svg', { viewBox: '0 0 20 20', width: 16, height: 16 },
          h('path', { d: 'M10 4l6 6-6 6M16 10H3', stroke: 'currentColor', strokeWidth: 2.5, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' }),
        )),
      ),
      h(WillowDark, null,
        h(Locale as any, { words: localeWords },
          h(Filemanager as any, {
            key: rootFoldersKey,
            data: initialData,
            mode: 'table',
            init: handleInit,
            menuOptions,
          }),
        ),
      ),
    ),

    // History resize handle
    h('div', { className: 'files-resize-handle', onMouseDown: startHistoryResize }),

    // History right-side panel
    h('div', { className: 'files-history-panel-right', style: { width: historyWidth } },
      h('div', { className: 'files-history-header' }, 'History'),
      h('div', { className: 'files-history-filter' },
        ['all', 'excel', 'word', 'pdf', 'image'].map(f =>
          h('button', {
            key: f,
            className: `files-filter-btn ${historyFilter === f ? 'active' : ''}`,
            onClick: () => setHistoryFilter(f),
          }, f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)),
        ),
      ),
      filteredHistory.length === 0
        ? h('div', { className: 'files-history-empty' },
            filesData.history.length === 0 ? 'No history yet' : 'No matching files',
          )
        : h('div', { className: 'files-history-list' },
            filteredHistory.map((entry, i) => {
              const origIndex = filesData.history.indexOf(entry)
              return h('div', {
                key: `${entry.path}-${i}`,
                className: 'files-history-item',
                onDoubleClick: () => handleHistoryClick(entry),
                title: entry.path,
              },
                h('span', { className: 'files-history-name' }, entry.name),
                h('span', { className: 'files-history-date' },
                  new Date(entry.openedAt).toLocaleDateString(),
                ),
                h('button', {
                  className: 'files-history-remove',
                  onClick: (e: any) => { e.stopPropagation(); handleRemoveHistory(origIndex) },
                  title: 'Remove from history',
                }, '\u00d7'),
              )
            }),
          ),
    ),
  )
}

// ===== Registration =====

registerTabType('files', {
  label: 'Files',
  icon: '\uD83D\uDCC1',
  description: 'File explorer with project folder management',
  defaultTitle: 'New Files',
  uiConfig: { showBlockLibrary: false, showToolbar: false, containerClass: 'files-mode' },
  dataKey: 'filesData',
  fileExtension: '.rcfiles',
  toolActions: {
    get_elements: handleGetElements,
    open_file: handleOpenFile,
    list_history: handleListHistory,
    navigate: handleNavigate,
    set_data: handleSetData,
  },
})

registerTabComponent('files', FilesPanel)
registerToolbarComponent('files', null)
