const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onWindowCloseRequested: (callback) => {
    ipcRenderer.removeAllListeners('window-close-requested');
    ipcRenderer.on('window-close-requested', () => callback());
  },
  confirmClose: () => {
    ipcRenderer.send('close-confirmed');
  },
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),

  // File system operations (for Files tab)
  fsListDir: (dirPath, rootPath) => ipcRenderer.invoke('fs-list-dir', dirPath, rootPath),
  fsCreateFolder: (parentPath, name, rootPath) => ipcRenderer.invoke('fs-create-folder', parentPath, name, rootPath),
  fsRenameItem: (oldPath, newName, rootPath) => ipcRenderer.invoke('fs-rename-item', oldPath, newName, rootPath),
  fsCopyItems: (srcs, dest, rootPath) => ipcRenderer.invoke('fs-copy-items', srcs, dest, rootPath),
  fsMoveItems: (srcs, dest, rootPath) => ipcRenderer.invoke('fs-move-items', srcs, dest, rootPath),
  fsTrashItems: (paths, rootPath) => ipcRenderer.invoke('fs-trash-items', paths, rootPath),
  fsOpenFile: (filePath) => ipcRenderer.invoke('fs-open-file', filePath),
});

// Renderer memory telemetry for crash diagnosis (paired with main.js
// 'renderer-mem-stats' handler + memRing). Reports V8 heap usage and a proxy
// for WebGL load (count of iframes — surface3d renders each 3D plot in its own
// sandboxed iframe, each holding a WebGL context). Sampled every 5 s. This is
// observation only; if performance.memory is unavailable (non-Chromium) the
// heap fields are simply omitted.
setInterval(() => {
  try {
    const mem = performance.memory; // Chromium-only
    const iframes = document.querySelectorAll('iframe').length;
    ipcRenderer.send('renderer-mem-stats', {
      heapUsedMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
      heapLimitMB: mem ? Math.round(mem.jsHeapSizeLimit / 1048576) : null,
      iframes,
    });
  } catch (e) { /* ignore */ }
}, 5000);
