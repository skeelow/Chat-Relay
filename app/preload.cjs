// Relay Chat — preload (M1.5 + M4.3). The only bridge into the renderer:
// the engine token (Chromium pages cannot read %APPDATA% themselves), the
// export save dialog (the one narrow file API — no generic read/write
// bridge exists), and the tray-count reports. Everything else the renderer
// needs comes over its WebSocket to the engine.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relay', {
  getToken: () => ipcRenderer.invoke('relay:get-token'),
  saveExport: (markdown) => ipcRenderer.invoke('relay:save-export', markdown),
  reportTrayCounts: (pending, approvals) => ipcRenderer.send('relay:tray-counts', pending, approvals),
});
