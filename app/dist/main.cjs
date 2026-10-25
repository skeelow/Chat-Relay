"use strict";

// app/src/main.ts
var import_electron = require("electron");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");

// app/src/trayicon.ts
var import_node_zlib = require("node:zlib");
function trayTooltipText(pending, approvals) {
  return `Relay Chat \u2014 ${pending} pending, ${approvals} approvals waiting`;
}
function crc32(buf) {
  let crc = 4294967295;
  for (const byte of buf) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc >>> 1 ^ 3988292384 & -(crc & 1);
    }
  }
  return (crc ^ 4294967295) >>> 0;
}
var chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 0);
  return Buffer.concat([head, data, tail]);
};
function buildIconPng(options) {
  const size = 16;
  const [dotR, dotG, dotB] = options.alert ? [227, 27, 27] : [46, 204, 113];
  const px = (x, y) => {
    const inSquare = x >= 2 && x < 14 && y >= 2 && y < 14;
    if (!inSquare) return [0, 0, 0, 0];
    const dx = x - 8;
    const dy = y - 9;
    if (dx * dx + dy * dy <= 9) return [dotR, dotG, dotB, 255];
    return [27, 30, 33, 255];
  };
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = px(x, y);
      raw[rowStart + 1 + x * 4] = r;
      raw[rowStart + 2 + x * 4] = g;
      raw[rowStart + 3 + x * 4] = b;
      raw[rowStart + 4 + x * 4] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", (0, import_node_zlib.deflateSync)(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// app/src/windowstate.ts
var DEFAULT_BOUNDS = { x: 120, y: 100, width: 980, height: 720 };
var MIN_WIDTH = 200;
var MIN_HEIGHT = 150;
var MAX_SIZE = 4e3;
var isInteger = (value) => typeof value === "number" && Number.isInteger(value);
function parseWindowState(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed;
  if (!isInteger(record.x) || !isInteger(record.y) || !isInteger(record.width) || !isInteger(record.height)) {
    return null;
  }
  const bounds = { x: record.x, y: record.y, width: record.width, height: record.height };
  if (bounds.width < MIN_WIDTH || bounds.width > MAX_SIZE) return null;
  if (bounds.height < MIN_HEIGHT || bounds.height > MAX_SIZE) return null;
  return bounds;
}
function boundsOnADisplay(bounds, displays) {
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return false;
  for (const display of displays) {
    const overlapX = Math.min(bounds.x + bounds.width, display.x + display.width) - Math.max(bounds.x, display.x);
    const overlapY = Math.min(bounds.y + bounds.height, display.y + display.height) - Math.max(bounds.y, display.y);
    if (overlapX > 0 && overlapY > 0) return true;
  }
  return false;
}

// app/src/main.ts
var TOKEN_PATH = (0, import_node_path.join)(process.env.APPDATA ?? ".", "RelayChat", "token");
var STATE_PATH = (0, import_node_path.join)(import_electron.app.getPath("userData"), "window-state.json");
import_electron.ipcMain.handle("relay:get-token", () => {
  if (!(0, import_node_fs.existsSync)(TOKEN_PATH)) return null;
  return (0, import_node_fs.readFileSync)(TOKEN_PATH, "utf8").trim();
});
import_electron.ipcMain.handle("relay:save-export", async (_event, markdown) => {
  if (typeof markdown !== "string" || markdown.length === 0) return null;
  const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const fileName = `relay-chat-${day}.md`;
  const result = await import_electron.dialog.showSaveDialog({
    defaultPath: (0, import_node_path.join)(import_electron.app.getPath("downloads"), fileName),
    filters: [{ name: "Markdown", extensions: ["md"] }]
  });
  if (result.canceled || result.filePath === void 0 || result.filePath === "") return null;
  (0, import_node_fs.writeFileSync)(result.filePath, markdown, "utf8");
  console.log(`[main] export saved: ${result.filePath}`);
  return result.filePath;
});
var trayCounts = { pending: 0, approvals: 0 };
var iconNormal = import_electron.nativeImage.createFromBuffer(buildIconPng({ alert: false }));
var iconAlert = import_electron.nativeImage.createFromBuffer(buildIconPng({ alert: true }));
var tray = null;
var mainWindow = null;
var quitting = false;
var updateTray = () => {
  if (tray === null) return;
  const text = trayTooltipText(trayCounts.pending, trayCounts.approvals);
  tray.setToolTip(text);
  tray.setImage(trayCounts.approvals > 0 ? iconAlert : iconNormal);
  console.log(`[main] tray: ${text}${trayCounts.approvals > 0 ? " (alert icon)" : ""}`);
};
import_electron.ipcMain.on("relay:tray-counts", (_event, pending, approvals) => {
  trayCounts.pending = Number(pending) || 0;
  trayCounts.approvals = Number(approvals) || 0;
  updateTray();
});
var saveWindowState = (win) => {
  try {
    const bounds = win.getBounds();
    (0, import_node_fs.writeFileSync)(STATE_PATH, JSON.stringify(bounds), "utf8");
  } catch (err) {
    console.warn(`[main] could not save the window state: ${String(err)}`);
  }
};
import_electron.app.whenReady().then(() => {
  let bounds = DEFAULT_BOUNDS;
  try {
    if ((0, import_node_fs.existsSync)(STATE_PATH)) {
      const parsed = parseWindowState((0, import_node_fs.readFileSync)(STATE_PATH, "utf8"));
      const displays = import_electron.screen.getAllDisplays().map((display) => display.bounds);
      if (parsed !== null && boundsOnADisplay(parsed, displays)) bounds = parsed;
      else console.log("[main] the saved window state was unusable \u2014 using the default bounds");
    }
  } catch (err) {
    console.warn(`[main] ignoring the window state file: ${String(err)}`);
  }
  const win = new import_electron.BrowserWindow({
    ...bounds,
    title: "Relay Chat",
    webPreferences: {
      preload: (0, import_node_path.join)(__dirname, "..", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  mainWindow = win;
  console.log(`[main] window bounds: ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);
  win.webContents.on("console-message", (event) => {
    console.log(`[renderer] ${event.message}`);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  void win.loadFile((0, import_node_path.join)(__dirname, "..", "index.html"));
  let saveTimer = null;
  const debouncedSave = () => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveWindowState(win);
    }, 500);
  };
  win.on("resize", debouncedSave);
  win.on("move", debouncedSave);
  win.on("close", (event) => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveWindowState(win);
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  tray = new import_electron.Tray(iconNormal);
  tray.setToolTip(trayTooltipText(0, 0));
  tray.setContextMenu(import_electron.Menu.buildFromTemplate([
    { label: "Show window", click: () => {
      mainWindow?.show();
      mainWindow?.focus();
    } },
    { type: "separator" },
    { label: "Quit", click: () => {
      quitting = true;
      import_electron.app.quit();
    } }
  ]));
  tray.on("click", () => {
    if (mainWindow === null) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  updateTray();
  console.log("[main] the tray is up");
});
import_electron.app.on("before-quit", () => {
  quitting = true;
});
import_electron.app.on("window-all-closed", () => import_electron.app.quit());
