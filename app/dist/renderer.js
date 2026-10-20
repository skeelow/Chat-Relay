"use strict";
(() => {
  // app/src/deliveries.ts
  function deliveryStatusView(status, error) {
    switch (status) {
      case "pending_approval":
        return { label: "Waiting for your approval", actions: ["approve", "reject"] };
      case "queued":
        return { label: "Approved, waiting for Codex adapter", actions: [] };
      case "delivering":
        return { label: "Sending to Codex\u2026", actions: [] };
      case "delivered":
        return { label: "Sent to Codex", actions: [] };
      case "failed":
        return { label: `Failed: ${error ?? "unknown error"}`, actions: ["forward"] };
      case "cancelled":
        return { label: "Cancelled", actions: [] };
      default:
        return { label: status, actions: [] };
    }
  }
  function sendButton(source, delivery) {
    if (source !== "astra") return { show: false, label: "" };
    if (delivery === void 0) return { show: true, label: "Send to Codex" };
    if (delivery.status === "failed") return { show: true, label: "Send again" };
    return { show: false, label: "" };
  }
  function pendingCount(rows) {
    return rows.filter((row) => row.status === "pending_approval").length;
  }
  function applyDeliveryUpdate(rows, update) {
    const next = new Map(rows);
    next.set(update.messageId, update);
    return next;
  }
  function forwardFrame(messageId) {
    return { type: "forward", messageId, target: "codex" };
  }
  function approveFrame(messageId) {
    return { type: "approve", messageId, target: "codex" };
  }
  function rejectFrame(messageId) {
    return { type: "reject", messageId, target: "codex" };
  }

  // app/src/renderer.ts
  var ENGINE_URL = "ws://127.0.0.1:8787";
  var RECONNECT_MS = 2e3;
  var TOKEN_PATTERN = /^[0-9a-f]{64}$/;
  var preload = window.relay;
  var shown = /* @__PURE__ */ new Set();
  var transcript = document.getElementById("transcript");
  var dot = document.getElementById("dot");
  var engineLabel = document.getElementById("engine-label");
  var pendingBadge = document.getElementById("pending");
  var deliveryRows = /* @__PURE__ */ new Map();
  var messageFooters = /* @__PURE__ */ new Map();
  var pendingClicks = /* @__PURE__ */ new Set();
  var engineOnline = false;
  var SENDER_LABELS = { astra: "Astra", codex: "Codex", user: "You" };
  function engineState(label, on) {
    if (engineLabel !== null) engineLabel.textContent = label;
    if (dot !== null) dot.className = on ? "on" : "off";
    if (engineOnline !== on) {
      engineOnline = on;
      for (const id of messageFooters.keys()) renderDelivery(id);
    }
  }
  function setPill(adapter, status) {
    const pill = document.getElementById(`pill-${adapter}`);
    if (pill === null) return;
    pill.dataset.status = status;
    const statusEl = pill.querySelector(".status");
    if (statusEl !== null) statusEl.textContent = status.replaceAll("_", " ");
    console.log(`[relay-gui] pill ${adapter}: ${status}`);
  }
  function appendMessage(message) {
    if (transcript === null) return;
    if (shown.has(message.id)) {
      console.log(`[relay-gui] skipped duplicate ${message.id}`);
      return;
    }
    shown.add(message.id);
    const row = document.createElement("div");
    row.className = `msg ${message.source}`;
    const sender = document.createElement("div");
    sender.className = "sender";
    sender.textContent = SENDER_LABELS[message.source] ?? message.source;
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = message.body;
    row.append(sender, body);
    if (message.source === "astra") {
      const footer = document.createElement("div");
      footer.className = "delivery";
      const status = document.createElement("div");
      status.className = "delivery-status";
      const actions = document.createElement("div");
      actions.className = "delivery-actions";
      footer.append(status, actions);
      row.append(footer);
      messageFooters.set(message.id, { source: message.source, status, actions });
      renderDelivery(message.id);
    }
    transcript.appendChild(row);
    console.log(`[relay-gui] appended ${message.id} (${message.source})`);
    transcript.scrollTop = transcript.scrollHeight;
  }
  function renderDelivery(messageId) {
    const footer = messageFooters.get(messageId);
    if (footer === void 0) return;
    const delivery = deliveryRows.get(messageId);
    const view = delivery === void 0 ? { label: "", actions: [] } : deliveryStatusView(delivery.status, delivery.error ?? null);
    footer.status.textContent = view.label;
    footer.actions.textContent = "";
    const buttons = [];
    const send = sendButton(footer.source, delivery);
    if (send.show) buttons.push({ action: "forward", label: send.label });
    for (const action of view.actions) {
      if (action === "approve") buttons.push({ action, label: "Approve" });
      else if (action === "reject") buttons.push({ action, label: "Reject" });
    }
    const clickPending = pendingClicks.has(messageId);
    for (const spec of buttons) {
      const button = document.createElement("button");
      button.textContent = spec.label;
      button.disabled = clickPending || !engineOnline;
      button.addEventListener("click", () => {
        pendingClicks.add(messageId);
        sendFrameToEngine(spec.action === "forward" ? forwardFrame(messageId) : spec.action === "approve" ? approveFrame(messageId) : rejectFrame(messageId));
        console.log(`[relay-gui] ${spec.action} sent for ${messageId}`);
        renderDelivery(messageId);
      });
      footer.actions.append(button);
    }
  }
  function updatePendingBadge() {
    if (pendingBadge === null) return;
    const count = pendingCount([...deliveryRows.values()]);
    pendingBadge.textContent = count === 0 ? "" : `${count} pending`;
  }
  function sendFrameToEngine(frame) {
    if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }
  function handleFrame(frame) {
    const type = frame.type;
    if (type === "snapshot") {
      const statuses = frame.statuses ?? {};
      setPill("astra", statuses.astra ?? "disconnected");
      setPill("codex", statuses.codex ?? "disconnected");
      const messages = frame.messages ?? [];
      for (const delivery of frame.deliveries ?? []) {
        if (delivery.target === "codex") deliveryRows.set(delivery.messageId, delivery);
      }
      for (const message of messages) appendMessage(message);
      updatePendingBadge();
      console.log(`[relay-gui] snapshot: ${messages.length} messages, statuses ${JSON.stringify(statuses)}`);
      engineState("engine connected", true);
      return;
    }
    if (type === "transcript_update") {
      appendMessage(frame.message);
      return;
    }
    if (type === "status_update") {
      setPill(String(frame.adapter), String(frame.status));
      return;
    }
    if (type === "delivery_update") {
      const messageId = frame.messageId;
      if (typeof messageId !== "string" || typeof frame.status !== "string") return;
      const update = {
        messageId,
        target: typeof frame.target === "string" ? frame.target : "codex",
        status: String(frame.status),
        attempts: typeof frame.attempts === "number" ? frame.attempts : 0,
        updatedAt: typeof frame.updatedAt === "string" ? frame.updatedAt : "",
        ...typeof frame.error === "string" ? { error: frame.error } : {}
      };
      deliveryRows = applyDeliveryUpdate(deliveryRows, update);
      pendingClicks.delete(messageId);
      console.log(`[relay-gui] delivery ${messageId}: ${update.status}`);
      renderDelivery(messageId);
      updatePendingBadge();
      return;
    }
  }
  var socket = null;
  function connect() {
    if (preload === void 0) {
      engineState("no preload bridge \u2014 run via the Electron app", false);
      return;
    }
    void preload.getToken().then((token) => {
      if (token === null || !TOKEN_PATTERN.test(token)) {
        engineState("no token yet \u2014 start the engine", false);
        setTimeout(() => connect(), RECONNECT_MS);
        return;
      }
      const ws = new WebSocket(ENGINE_URL);
      socket = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "auth", token }));
        ws.send(JSON.stringify({ type: "gui_hello" }));
      };
      ws.onmessage = (event) => {
        let frame;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          return;
        }
        handleFrame(frame);
      };
      ws.onclose = (event) => {
        if (socket === ws) socket = null;
        if (event.code === 4401) {
          engineState("token rejected \u2014 restart the engine or check %APPDATA%\\RelayChat\\token", false);
        } else {
          engineState("engine disconnected \u2014 retrying", false);
        }
        setTimeout(() => connect(), RECONNECT_MS);
      };
      ws.onerror = () => {
      };
    });
  }
  connect();
})();
