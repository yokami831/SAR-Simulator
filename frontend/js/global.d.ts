import type { ReactFlowInstance } from '@xyflow/react'

declare global {
  interface Window {
    rfInstance: ReactFlowInstance | null
    __errorQueue: Array<{ type: string; message: string;[key: string]: unknown }>
    __sendErrorToBackend?: (entry: object) => void
    __consoleLog?: (level: string, message: string, details?: string, source?: string) => void
    __lastErrorKey?: string
    showSaveFilePicker?: (options?: Record<string, unknown>) => Promise<FileSystemFileHandle>
    showOpenFilePicker?: (options?: Record<string, unknown>) => Promise<FileSystemFileHandle[]>
    _subgraphCallbacks?: {
      onToggle?: (nodeId: string) => void
      onUngroup?: (nodeId: string) => void
      onSetDescription?: (nodeId: string, desc: string) => void
    }
    _getActiveTab?: () => { id: string; type: string; workspacePath?: string | null } | null
    isFlowRunning?: () => boolean
    electronAPI?: {
      onWindowCloseRequested: (callback: () => void) => void
      confirmClose: () => void
      showOpenDialog: (options: { properties?: string[]; title?: string }) => Promise<{ canceled: boolean; filePaths: string[] }>
      // File system operations (Files tab)
      fsListDir: (dirPath: string, rootPath: string) => Promise<{ items?: Array<{ id: string; name: string; size: number; date: string; type: 'file' | 'folder'; lazy: boolean }>; error?: string }>
      fsCreateFolder: (parentPath: string, name: string, rootPath: string) => Promise<{ success?: boolean; path?: string; error?: string }>
      fsRenameItem: (oldPath: string, newName: string, rootPath: string) => Promise<{ success?: boolean; oldPath?: string; newPath?: string; error?: string }>
      fsCopyItems: (srcPaths: string[], destDir: string, rootPath: string) => Promise<{ success?: boolean; error?: string }>
      fsMoveItems: (srcPaths: string[], destDir: string, rootPath: string) => Promise<{ success?: boolean; error?: string }>
      fsTrashItems: (filePaths: string[], rootPath: string) => Promise<{ success?: boolean; error?: string }>
      fsOpenFile: (filePath: string) => Promise<{ success?: boolean; error?: string }>
    }
    // Third-party library instances (set by tab components)
    __excalidrawAPI?: any
    __excalidrawResetSnapshot?: () => void
    __mindElixirInstance?: any
    // Global save functions (set by app.tsx, used by tab-internal menus)
    __hiyoSave?: () => Promise<void>
    __hiyoSaveAs?: () => Promise<void>
  }
}

export {}
