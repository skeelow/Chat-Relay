// Relay Chat — preload (M1.5). The only bridge into the renderer: it asks
// the main process for the engine token, which Chromium pages cannot read
// from disk themselves.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relay', {
  getToken: () => ipcRenderer.invoke('relay:get-token'),
});
