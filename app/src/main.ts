// Relay Chat — Electron main (M1.5). Opens the read-only room window and
// hands the renderer the engine token (Chromium cannot read %APPDATA%; the
// adapters read the file directly because they are Node — the GUI's pages
// are not). Re-read per request, like the adapters re-read per attempt.
import { app, BrowserWindow, ipcMain } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN_PATH = join(process.env.APPDATA ?? '.', 'RelayChat', 'token');

ipcMain.handle('relay:get-token', (): string | null => {
  if (!existsSync(TOKEN_PATH)) return null;
  return readFileSync(TOKEN_PATH, 'utf8').trim();
});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 980,
    height: 720,
    title: 'Relay Chat',
    webPreferences: {
      preload: join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Renderer console → terminal output: this is how the M1.5 smoke run is
  // verified without eyes on the window.
  win.webContents.on('console-message', (event) => {
    console.log(`[renderer] ${event.message}`);
  });
  void win.loadFile(join(__dirname, '..', 'index.html'));
});

app.on('window-all-closed', () => app.quit());
