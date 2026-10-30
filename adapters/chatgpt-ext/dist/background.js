"use strict";
(() => {
  // adapters/chatgpt-ext/src/protocol.ts
  var RELAY_HEADER = /^\[Relay ·/;
  function isRelayHeaderEcho(body) {
    const firstLine = body.split("\n", 1)[0] ?? "";
    return RELAY_HEADER.test(firstLine);
  }
  function statusToReplayAfterHello(latest) {
    return latest !== null && latest !== "idle" ? latest : null;
  }
  var AUTO_SEND_MIN_GAP_MS = 5e3;
  function autoSendClickPlan(enabled, nowMs, lastClickMs) {
    if (!enabled) return { click: false, delayMs: 0 };
    const wait = lastClickMs === null ? 0 : AUTO_SEND_MIN_GAP_MS - (nowMs - lastClickMs);
    return { click: true, delayMs: wait > 0 ? wait : 0 };
  }
  function deliveryTabDecision(knownTabId) {
    if (knownTabId === null) {
      return {
        ok: false,
        error: "no ChatGPT tab is known to the relay extension \u2014 open chatgpt.com and let it load"
      };
    }
    return { ok: true, tabId: knownTabId };
  }

  // adapters/chatgpt-ext/src/background.ts
  var BUILD_MARKER = "2026-10-30.1";
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
  var STATUS_KEY = "latestStatus";
  var QUEUE_KEY = "queuedCaptures";
  var SENDER_TAB_KEY = "lastSenderTabId";
  var DRAIN_SETTLE_MS = 500;
  var PING_INTERVAL_MS = 2e4;
  var MAX_PERSISTED_QUEUE = 20;
  var PING_FRAME = JSON.stringify({ type: "ping" });
  var AUTO_SEND_CONFIG_KEY = "extClicksSend";
  var AUTO_SEND_AT_KEY = "lastAutoSendAt";
  var maybeChrome = globalThis.chrome;
  if (maybeChrome === void 0) {
    throw new Error("[relay-astra worker] no chrome API \u2014 this file must run as the extension service worker");
  }
  var chromeApi = maybeChrome;
  var socket = null;
  var socketOpenAt = null;
  var connectInFlight = false;
  var tokenMissingLogged = false;
  var authRejected = false;
  var lastSentStatus = null;
  var queuedCaptures = [];
  function engineSocketOpen() {
    return socket !== null && socket.readyState === WebSocket.OPEN;
  }
  function drainReady() {
    return engineSocketOpen() && socketOpenAt !== null && Date.now() - socketOpenAt >= DRAIN_SETTLE_MS;
  }
  async function storedToken() {
    const bag = await chromeApi.storage.local.get(TOKEN_KEY);
    const value = bag[TOKEN_KEY];
    return typeof value === "string" && TOKEN_PATTERN.test(value) ? value : null;
  }
  function persistQueue() {
    const persistable = queuedCaptures.slice(-MAX_PERSISTED_QUEUE).map(({ body, sourceRef }) => ({ body, sourceRef }));
    void chromeApi.storage.session.set({ [QUEUE_KEY]: persistable });
  }
  async function restoreQueue() {
    const bag = await chromeApi.storage.session.get(QUEUE_KEY);
    const stored = bag[QUEUE_KEY];
    if (Array.isArray(stored)) {
      for (const raw of stored) {
        const item = raw;
        if (typeof item.body === "string" && typeof item.sourceRef === "string" && !queuedCaptures.some((q) => q.sourceRef === item.sourceRef)) {
          queuedCaptures.push({ body: item.body, sourceRef: item.sourceRef });
        }
      }
    }
    persistQueue();
  }
  function drainCaptures() {
    let drained = false;
    while (queuedCaptures.length > 0 && engineSocketOpen() && socket !== null) {
      const item = queuedCaptures.shift();
      if (item === void 0) break;
      socket.send(JSON.stringify({ type: "captured", body: item.body, sourceRef: item.sourceRef }));
      item.ack?.({ ok: true, sent: true });
      drained = true;
      debug("captured frame sent:", item.sourceRef);
    }
    if (drained) persistQueue();
  }
  async function replayStatusAfterHello(ws) {
    const bag = await chromeApi.storage.session.get(STATUS_KEY);
    const stored = bag[STATUS_KEY];
    const replay = statusToReplayAfterHello(typeof stored === "string" ? stored : null);
    if (replay !== null && ws === socket && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "status", status: replay }));
      lastSentStatus = replay;
      debug("status replayed after hello:", replay);
    }
  }
  var lastSenderTabId = null;
  function sendEngineFrame(frame) {
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
      return true;
    }
    return false;
  }
  var extClicksSend = false;
  var lastAutoSendAtMs = null;
  var pendingAutoSend = null;
  function cancelPendingAutoSend() {
    if (pendingAutoSend === null) return;
    const { messageId, timer } = pendingAutoSend;
    pendingAutoSend = null;
    clearTimeout(timer);
    sendEngineFrame({ type: "failed", messageId, error: "stopped before the click \u2014 nothing was sent to ChatGPT" });
    console.log("[relay-astra worker] pending auto-send cancelled (Stop/Kill)");
  }
  async function clickSend(messageId, tabId) {
    if (pendingAutoSend === null || pendingAutoSend.messageId !== messageId) return;
    pendingAutoSend = null;
    try {
      const response = await chromeApi.tabs.sendMessage(tabId, { type: "click-send", messageId });
      if (response?.ok === true && response.clicked === true) {
        lastAutoSendAtMs = Date.now();
        void chromeApi.storage.session.set({ [AUTO_SEND_AT_KEY]: lastAutoSendAtMs });
        sendEngineFrame({ type: "delivered", messageId, autoSend: true });
        console.log("[relay-astra worker] auto-send: the extension clicked Send");
      } else {
        sendEngineFrame({
          type: "failed",
          messageId,
          error: response?.error ?? "the Send button was not found \u2014 the text stays in the box; click Send yourself"
        });
      }
    } catch (err) {
      sendEngineFrame({
        type: "failed",
        messageId,
        error: `could not reach the ChatGPT tab to click Send \u2014 the text stays in the box: ${String(err).slice(0, 120)}`
      });
    }
  }
  async function deliverToChatGpt(messageId, text) {
    const decision = deliveryTabDecision(lastSenderTabId);
    if (!decision.ok) {
      sendEngineFrame({ type: "failed", messageId, error: decision.error });
      return;
    }
    const tabId = decision.tabId;
    try {
      const response = await chromeApi.tabs.sendMessage(tabId, { type: "type-relay-text", messageId, text });
      if (response?.ok !== true) {
        sendEngineFrame({ type: "failed", messageId, error: response?.error ?? "the ChatGPT page refused the text" });
        return;
      }
      if (extClicksSend === true) {
        const plan = autoSendClickPlan(true, Date.now(), lastAutoSendAtMs);
        if (plan.click) {
          if (plan.delayMs > 0) {
            console.log(`[relay-astra worker] auto-send waits ${plan.delayMs}ms (minimum gap)`);
          }
          cancelPendingAutoSend();
          pendingAutoSend = { messageId, timer: setTimeout(() => {
            void clickSend(messageId, tabId);
          }, plan.delayMs) };
        }
      } else {
        sendEngineFrame({ type: "delivered", messageId });
      }
    } catch (err) {
      sendEngineFrame({
        type: "failed",
        messageId,
        error: `could not reach the ChatGPT tab (closed or reloaded?) \u2014 reopen chatgpt.com, then forward again: ${String(err).slice(0, 120)}`
      });
    }
  }
  function handleEngineFrame(frame) {
    const record = frame;
    if (record?.type === "deliver") {
      if (typeof record.messageId === "string" && typeof record.text === "string") {
        void deliverToChatGpt(record.messageId, record.text);
      }
      return;
    }
    if (record?.type === "config") {
      if (typeof record.extClicksSend === "boolean") {
        extClicksSend = record.extClicksSend;
        void chromeApi.storage.session.set({ [AUTO_SEND_CONFIG_KEY]: extClicksSend });
        console.log(`[relay-astra worker] extension-clicks-Send is ${extClicksSend ? "ON" : "off"}`);
      }
      return;
    }
    if (record?.type === "interrupt") {
      cancelPendingAutoSend();
      return;
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
      let drainTimer = null;
      let pingTimer = null;
      ws.onopen = () => {
        socketOpenAt = Date.now();
        ws.send(JSON.stringify({ type: "auth", token }));
        ws.send(JSON.stringify({ type: "hello", name: "astra", version: ADAPTER_VERSION }));
        lastSentStatus = null;
        console.log("[relay-astra worker] engine connection open");
        drainTimer = setTimeout(() => {
          drainTimer = null;
          drainCaptures();
        }, DRAIN_SETTLE_MS);
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(PING_FRAME);
        }, PING_INTERVAL_MS);
        void replayStatusAfterHello(ws);
      };
      ws.onmessage = (event) => {
        let frame;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          return;
        }
        handleEngineFrame(frame);
      };
      ws.onclose = (event) => {
        if (pingTimer !== null) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        if (drainTimer !== null) {
          clearTimeout(drainTimer);
          drainTimer = null;
        }
        if (socket === ws) {
          socket = null;
          socketOpenAt = null;
        }
        if (event.code === 1e3) {
          console.log("[relay-astra worker] token changed \u2014 reconnecting with the new one");
          void connectEngine();
          return;
        }
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
  function handleMessage(msg, sender, sendResponse) {
    const senderTabId = sender?.tab?.id;
    if (typeof senderTabId === "number" && senderTabId !== lastSenderTabId) {
      lastSenderTabId = senderTabId;
      void chromeApi.storage.session.set({ [SENDER_TAB_KEY]: senderTabId });
    }
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
      persistQueue();
      if (drainReady()) {
        drainCaptures();
        return;
      }
      void connectEngine();
      return true;
    }
    if (frame?.type === "status") {
      if (typeof frame.status !== "string") {
        sendResponse({ ok: false, error: "malformed status" });
        return;
      }
      void chromeApi.storage.session.set({ [STATUS_KEY]: frame.status });
      if (frame.status !== lastSentStatus && engineSocketOpen() && socket !== null) {
        socket.send(JSON.stringify({ type: "status", status: frame.status }));
        lastSentStatus = frame.status;
        debug("status frame sent:", frame.status);
        sendResponse({ ok: true, sent: true });
      } else {
        sendResponse({ ok: true, sent: false });
      }
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
      if (socket !== null) {
        socket.close(1e3, "token replaced");
      } else {
        void connectEngine();
      }
    }
  });
  void restoreQueue().then(() => {
    void restoreSenderTab().then(() => {
      void restoreAutoSendState().then(() => {
        void connectEngine();
      });
    });
  });
  async function restoreAutoSendState() {
    const bag = await chromeApi.storage.session.get(AUTO_SEND_CONFIG_KEY);
    if (typeof bag[AUTO_SEND_CONFIG_KEY] === "boolean") {
      extClicksSend = bag[AUTO_SEND_CONFIG_KEY];
    }
    const at = await chromeApi.storage.session.get(AUTO_SEND_AT_KEY);
    if (typeof at[AUTO_SEND_AT_KEY] === "number") {
      lastAutoSendAtMs = at[AUTO_SEND_AT_KEY];
    }
  }
  async function restoreSenderTab() {
    const bag = await chromeApi.storage.session.get(SENDER_TAB_KEY);
    const stored = bag[SENDER_TAB_KEY];
    if (typeof stored === "number") {
      lastSenderTabId = stored;
      debug("sender tab restored from storage.session:", stored);
    }
  }
})();
