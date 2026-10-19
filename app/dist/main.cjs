"use strict";

// app/src/main.ts
var import_electron = require("electron");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var TOKEN_PATH = (0, import_node_path.join)(process.env.APPDATA ?? ".", "RelayChat", "token");
import_electron.ipcMain.handle("relay:get-token", () => {
  if (!(0, import_node_fs.existsSync)(TOKEN_PATH)) return null;
  return (0, import_node_fs.readFileSync)(TOKEN_PATH, "utf8").trim();
});
import_electron.app.whenReady().then(() => {
  const win = new import_electron.BrowserWindow({
    width: 980,
    height: 720,
    title: "Relay Chat",
    webPreferences: {
      preload: (0, import_node_path.join)(__dirname, "..", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  win.webContents.on("console-message", (event) => {
    console.log(`[renderer] ${event.message}`);
  });
  void win.loadFile((0, import_node_path.join)(__dirname, "..", "index.html"));
});
import_electron.app.on("window-all-closed", () => import_electron.app.quit());
