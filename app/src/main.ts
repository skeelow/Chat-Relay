// Relay Chat — Electron main (M1.5 + M4.3). Opens the room window, hands
// the renderer the engine token (Chromium cannot read %APPDATA%; the
// adapters read the file directly because they are Node — the GUI's pages
// are not). Re-read per request, like the adapters re-read per attempt.
//
// M4.3 adds: the system tray (icon drawn in code, Show window / Quit,
// click toggles the window, tooltip follows the renderer's counts), the
// hide-to-tray close rule, the export save dialog (the one narrow file
// API), and window bounds saved to window-state.json in userData.
import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, screen } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIconPng, trayTooltipText } from './trayicon.ts';
import { boundsOnADisplay, DEFAULT_BOUNDS, parseWindowState, type WindowBounds } from './windowstate.ts';

const TOKEN_PATH = join(process.env.APPDATA ?? '.', 'RelayChat', 'token');
const STATE_PATH = join(app.getPath('userData'), 'window-state.json');

ipcMain.handle('relay:get-token', (): string | null => {
  if (!existsSync(TOKEN_PATH)) return null;
  return readFileSync(TOKEN_PATH, 'utf8').trim();
});

// M4.3 (D17-3): the one narrow file API. The engine builds the Markdown;
// this only asks the user where to put it and writes the file as UTF-8.
// There is no generic read/write bridge into the renderer.
ipcMain.handle('relay:save-export', async (_event, markdown: unknown): Promise<string | null> => {
  if (typeof markdown !== 'string' || markdown.length === 0) return null;
  const day = new Date().toISOString().slice(0, 10);
  const fileName = `relay-chat-${day}.md`;
  const result = await dialog.showSaveDialog({
    defaultPath: join(app.getPath('downloads'), fileName),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || result.filePath === undefined || result.filePath === '') return null;
  writeFileSync(result.filePath, markdown, 'utf8');
  console.log(`[main] export saved: ${result.filePath}`);
  return result.filePath;
});

// M4.3 (D17-4): the tray counts arrive from the renderer as the state
// changes; the tooltip and the icon follow.
const trayCounts = { pending: 0, approvals: 0 };
const iconNormal = nativeImage.createFromBuffer(buildIconPng({ alert: false }));
const iconAlert = nativeImage.createFromBuffer(buildIconPng({ alert: true }));
let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

const updateTray = (): void => {
  if (tray === null) return;
  const text = trayTooltipText(trayCounts.pending, trayCounts.approvals);
  tray.setToolTip(text);
  tray.setImage(trayCounts.approvals > 0 ? iconAlert : iconNormal);
  console.log(`[main] tray: ${text}${trayCounts.approvals > 0 ? ' (alert icon)' : ''}`);
};

ipcMain.on('relay:tray-counts', (_event, pending: unknown, approvals: unknown): void => {
  trayCounts.pending = Number(pending) || 0;
  trayCounts.approvals = Number(approvals) || 0;
  updateTray();
});

// M4.3 (D17-5): window bounds are restored at launch only when they parse
// and lie on a currently attached display — a corrupt file or an unplugged
// monitor falls back to the default. Written debounced on move/resize and
// once on close.
const saveWindowState = (win: BrowserWindow): void => {
  try {
    const bounds: WindowBounds = win.getBounds();
    writeFileSync(STATE_PATH, JSON.stringify(bounds), 'utf8');
  } catch (err) {
    console.warn(`[main] could not save the window state: ${String(err)}`);
  }
};

app.whenReady().then(() => {
  let bounds: WindowBounds = DEFAULT_BOUNDS;
  try {
    if (existsSync(STATE_PATH)) {
      const parsed = parseWindowState(readFileSync(STATE_PATH, 'utf8'));
      const displays = screen.getAllDisplays().map((display) => display.bounds);
      if (parsed !== null && boundsOnADisplay(parsed, displays)) bounds = parsed;
      else console.log('[main] the saved window state was unusable — using the default bounds');
    }
  } catch (err) {
    console.warn(`[main] ignoring the window state file: ${String(err)}`);
  }

  const win = new BrowserWindow({
    ...bounds,
    title: 'Relay Chat',
    webPreferences: {
      preload: join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  console.log(`[main] window bounds: ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);
  // Renderer console → terminal output: this is how the smoke runs are
  // verified without eyes on the window.
  win.webContents.on('console-message', (event) => {
    console.log(`[renderer] ${event.message}`);
  });
  // N4: the room is read-only local data — deny window.open and any
  // navigation away from the loaded file.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  void win.loadFile(join(__dirname, '..', 'index.html'));

  // M4.3 (D17-5): debounced saves while the user moves/resizes, a final
  // save on close — the last position wins.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedSave = (): void => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveWindowState(win); }, 500);
  };
  win.on('resize', debouncedSave);
  win.on('move', debouncedSave);
  win.on('close', (event) => {
    if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
    saveWindowState(win);
    // M4.3 (D17-4): closing hides to the tray — the relay keeps running
    // because the engine is a separate process. Quit comes from the tray.
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });

  // The tray: Show window / Quit; clicking the icon toggles the window.
  tray = new Tray(iconNormal);
  tray.setToolTip(trayTooltipText(0, 0));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show window', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => {
    if (mainWindow === null) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  });
  updateTray();
  console.log('[main] the tray is up');
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());
