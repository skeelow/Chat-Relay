"use strict";
(() => {
  // adapters/chatgpt-ext/src/protocol.ts
  var RELAY_HEADER = /^\[Relay ·/;
  function isRelayHeaderEcho(body) {
    const firstLine = body.split("\n", 1)[0] ?? "";
    return RELAY_HEADER.test(firstLine);
  }

  // adapters/chatgpt-ext/src/background.ts
  var BUILD_MARKER = "2026-10-19.1";
  console.log("[relay-astra worker] service worker started", BUILD_MARKER);
  var DEBUG = false;
  function debug(...parts) {
    if (DEBUG) console.log("[relay-astra worker]", ...parts);
  }
  var ENGINE_URL = "ws://127.0.0.1:8787";
  var ADAPTER_VERSION = "0.1.0";
  var TOKEN_KEY = "token";
  var TOKEN_PATTERN = /^[0-9a-f]{64}$/;
  var RECONNECT_MS = 2e3;
  var WATCHDOG_ALARM = "relay-astra-watchdog";
  var WATCHDOG_PERIOD_MIN = 0.5;
  var maybeChrome = globalThis.chrome;
  if (maybeChrome === void 0) {
    throw new Error("[relay-astra worker] no chrome API \u2014 this file must run as the extension service worker");
  }
  var chromeApi = maybeChrome;
  var socket = null;
  var connectInFlight = false;
  var tokenMissingLogged = false;
  var authRejected = false;
  var lastSentStatus = null;
  var queuedCaptures = [];
  function engineSocketOpen() {
    return socket !== null && socket.readyState === WebSocket.OPEN;
  }
  async function storedToken() {
    const bag = await chromeApi.storage.local.get(TOKEN_KEY);
    const value = bag[TOKEN_KEY];
    return typeof value === "string" && TOKEN_PATTERN.test(value) ? value : null;
  }
  function drainCaptures() {
    while (queuedCaptures.length > 0 && engineSocketOpen() && socket !== null) {
      const item = queuedCaptures.shift();
      if (item === void 0) break;
      socket.send(JSON.stringify({ type: "captured", body: item.body, sourceRef: item.sourceRef }));
      item.ack?.({ ok: true, sent: true });
      debug("captured frame sent:", item.sourceRef);
    }
  }
  function scheduleReconnect() {
    setTimeout(() => {
      void connectEngine();
    }, RECONNECT_MS);
  }
  async function connectEngine() {
    if (connectInFlight || engineSocketOpen() || authRejected) return;
    connectInFlight = true;
    try {
      const token = await storedToken();
      if (token === null) {
        if (!tokenMissingLogged) {
          tokenMissingLogged = true;
          console.log("[relay-astra worker] no token yet \u2014 paste it into the extension options (from %APPDATA%\\RelayChat\\token); retrying every 30s");
        }
        return;
      }
      tokenMissingLogged = false;
      const ws = new WebSocket(ENGINE_URL);
      socket = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "auth", token }));
        ws.send(JSON.stringify({ type: "hello", name: "astra", version: ADAPTER_VERSION }));
        lastSentStatus = null;
        drainCaptures();
        console.log("[relay-astra worker] engine connection open");
      };
      ws.onclose = (event) => {
        if (socket === ws) socket = null;
        if (event.code === 4401) {
          authRejected = true;
          console.error("[relay-astra worker] engine rejected the saved token \u2014 paste the current one in the extension options");
          return;
        }
        if (event.code === 4400) return;
        console.log("[relay-astra worker] engine connection lost \u2014 retrying");
        scheduleReconnect();
      };
      ws.onerror = () => {
      };
    } finally {
      connectInFlight = false;
    }
  }
  function handleMessage(msg, _sender, sendResponse) {
    const frame = msg;
    if (frame?.type === "captured") {
      if (typeof frame.body !== "string" || typeof frame.sourceRef !== "string") {
        sendResponse({ ok: false, error: "malformed capture" });
        return;
      }
      if (frame.body.trim().length === 0) {
        sendResponse({ ok: true, dropped: "empty" });
        return;
      }
      if (isRelayHeaderEcho(frame.body)) {
        sendResponse({ ok: true, dropped: "relay-header" });
        return;
      }
      const ack = sendResponse;
      const existing = queuedCaptures.find((q) => q.sourceRef === frame.sourceRef);
      if (existing !== void 0) {
        existing.ack = ack;
      } else {
        queuedCaptures.push({ body: frame.body, sourceRef: frame.sourceRef, ack });
      }
      if (engineSocketOpen()) {
        drainCaptures();
        return;
      }
      void connectEngine();
      return true;
    }
    if (frame?.type === "status") {
      if (typeof frame.status === "string" && frame.status !== lastSentStatus && engineSocketOpen() && socket !== null) {
        socket.send(JSON.stringify({ type: "status", status: frame.status }));
        lastSentStatus = frame.status;
        debug("status frame sent:", frame.status);
      }
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: "unexpected message" });
  }
  chromeApi.runtime.onMessage.addListener(handleMessage);
  chromeApi.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MIN });
  chromeApi.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WATCHDOG_ALARM && !engineSocketOpen()) void connectEngine();
  });
  chromeApi.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[TOKEN_KEY] !== void 0) {
      authRejected = false;
      tokenMissingLogged = false;
      if (!engineSocketOpen()) void connectEngine();
    }
  });
  void connectEngine();
})();
