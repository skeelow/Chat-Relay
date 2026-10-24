"use strict";
(() => {
  // app/src/approvals.ts
  var ANSWERABLE_KINDS = /* @__PURE__ */ new Set(["command", "file_change", "permissions"]);
  var KIND_LABELS = {
    command: "Command",
    file_change: "File change",
    permissions: "Permissions"
  };
  function isAnswerable(kind) {
    return ANSWERABLE_KINDS.has(kind);
  }
  function approvalCard(view) {
    if (!isAnswerable(view.kind)) {
      return {
        title: `Codex asked for something the relay cannot answer (${view.method}). Answer it in the Codex app, or press Stop.`,
        body: view.summary,
        actions: []
      };
    }
    return {
      title: `Codex wants approval: ${KIND_LABELS[view.kind] ?? view.kind}`,
      body: view.summary,
      actions: ["approve_once", "decline"]
    };
  }
  function approvalsBadgeText(count) {
    if (count === 0) return "";
    return `${count} ${count === 1 ? "approval" : "approvals"} waiting`;
  }
  function emptyApprovalsState() {
    return { requests: /* @__PURE__ */ new Map(), pendingClicks: /* @__PURE__ */ new Set() };
  }
  function applyApprovalRequest(state, view) {
    const requests = new Map(state.requests);
    requests.set(view.requestId, view);
    return { requests, pendingClicks: state.pendingClicks };
  }
  function applyApprovalResolved(state, requestId) {
    const requests = new Map(state.requests);
    requests.delete(requestId);
    const pendingClicks = new Set(state.pendingClicks);
    pendingClicks.delete(requestId);
    return { requests, pendingClicks };
  }
  function applySnapshotApprovals(state, views) {
    const requests = /* @__PURE__ */ new Map();
    for (const view of views) requests.set(view.requestId, view);
    return { requests, pendingClicks: /* @__PURE__ */ new Set() };
  }
  function applyApprovalClick(state, requestId) {
    const pendingClicks = new Set(state.pendingClicks);
    pendingClicks.add(requestId);
    return { requests: state.requests, pendingClicks };
  }
  function approvalAnswerFrame(requestId, decision) {
    return { type: "approval_answer", requestId, decision };
  }

  // app/src/deliveries.ts
  function deliveryStatusView(delivery, target) {
    const toAstra = target === "astra";
    switch (delivery.status) {
      case "pending_approval":
        return {
          label: delivery.error === void 0 ? "Waiting for your approval" : `Waiting for your approval \u2014 ${delivery.error}`,
          actions: ["approve", "reject"]
        };
      case "queued":
        return {
          label: toAstra ? "Approved, waiting for the ChatGPT extension" : "Approved, waiting for Codex adapter",
          actions: []
        };
      case "delivering":
        return { label: toAstra ? "Typing into ChatGPT\u2026" : "Sending to Codex\u2026", actions: [] };
      case "delivered":
        return { label: toAstra ? "Typed into ChatGPT \u2014 click Send there" : "Sent to Codex", actions: [] };
      case "failed":
        if (delivery.attempts >= 3) {
          return { label: `Failed after 3 attempts: ${delivery.error ?? "unknown error"}`, actions: [] };
        }
        return { label: `Failed: ${delivery.error ?? "unknown error"}`, actions: ["forward"] };
      case "cancelled":
        return { label: "Cancelled", actions: [] };
      default:
        return { label: delivery.status, actions: [] };
    }
  }
  function targetFor(source) {
    if (source === "astra") return "codex";
    if (source === "codex") return "astra";
    return null;
  }
  function sendButton(source, delivery) {
    const target = targetFor(source);
    if (target === null) return { show: false, label: "", target: null };
    const plain = source === "astra" ? "Send to Codex" : "Send to ChatGPT";
    if (delivery === void 0) return { show: true, label: plain, target };
    if (delivery.status === "failed" && delivery.attempts >= 3) {
      return { show: false, label: "", target };
    }
    if (delivery.status === "failed") return { show: true, label: "Send again", target };
    return { show: false, label: "", target };
  }
  function pendingCount(rows) {
    return rows.filter((row) => row.status === "pending_approval").length;
  }
  function deliveryKey(messageId, target) {
    return `${messageId}:${target}`;
  }
  function emptyDeliveryState() {
    return { rows: /* @__PURE__ */ new Map(), pendingClicks: /* @__PURE__ */ new Set() };
  }
  function applySnapshotDeliveries(state, rows) {
    const nextRows = /* @__PURE__ */ new Map();
    for (const row of rows) nextRows.set(deliveryKey(row.messageId, row.target), row);
    return { rows: nextRows, pendingClicks: /* @__PURE__ */ new Set() };
  }
  function applyDeliveryUpdate(state, update) {
    const key = deliveryKey(update.messageId, update.target);
    const rows = new Map(state.rows);
    rows.set(key, update);
    const pendingClicks = new Set(state.pendingClicks);
    pendingClicks.delete(key);
    return { rows, pendingClicks };
  }
  function applyClick(state, key) {
    const pendingClicks = new Set(state.pendingClicks);
    pendingClicks.add(key);
    return { rows: state.rows, pendingClicks };
  }
  function forwardFrame(messageId, target) {
    return { type: "forward", messageId, target };
  }
  function approveFrame(messageId, target) {
    return { type: "approve", messageId, target };
  }
  function rejectFrame(messageId, target) {
    return { type: "reject", messageId, target };
  }
  var PAUSE_BANNER = "Stopped \u2014 nothing will be delivered until you resume";
  var APPROVE_PAUSED_TITLE = "Approve is disabled while stopped \u2014 press Resume first";
  function pauseBannerText(paused2) {
    return paused2 ? PAUSE_BANNER : null;
  }
  function stopButtonLabel(paused2) {
    return paused2 ? "Resume" : "Stop";
  }
  function approveDisabledTitle(paused2) {
    return paused2 ? APPROVE_PAUSED_TITLE : null;
  }
  function stopFrame() {
    return { type: "stop" };
  }
  function resumeFrame() {
    return { type: "resume" };
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
  var stopButton = document.getElementById("stop");
  var pauseBanner = document.getElementById("banner");
  var approvalsArea = document.getElementById("approvals");
  var approvalsBadge = document.getElementById("approvals-badge");
  var deliveryState = emptyDeliveryState();
  var messageFooters = /* @__PURE__ */ new Map();
  var engineOnline = false;
  var paused = false;
  var approvalState = emptyApprovalsState();
  var SENDER_LABELS = { astra: "Astra", codex: "Codex", user: "You" };
  function engineState(label, on) {
    if (engineLabel !== null) engineLabel.textContent = label;
    if (dot !== null) dot.className = on ? "on" : "off";
    if (stopButton !== null) stopButton.disabled = !on;
    if (engineOnline !== on) {
      engineOnline = on;
      for (const id of messageFooters.keys()) renderDelivery(id);
      renderApprovals();
    }
  }
  function setPausedUi() {
    const bannerText = pauseBannerText(paused);
    if (pauseBanner !== null) {
      pauseBanner.textContent = bannerText ?? "";
      pauseBanner.hidden = bannerText === null;
    }
    if (stopButton !== null) stopButton.textContent = stopButtonLabel(paused);
    for (const id of messageFooters.keys()) renderDelivery(id);
    console.log(`[relay-gui] pause state: ${paused ? "stopped" : "running"}`);
  }
  function updateApprovalsBadge() {
    if (approvalsBadge !== null) {
      approvalsBadge.textContent = approvalsBadgeText(approvalState.requests.size);
    }
  }
  function renderApprovals() {
    updateApprovalsBadge();
    if (approvalsArea === null) return;
    approvalsArea.textContent = "";
    for (const view of approvalState.requests.values()) {
      const card = approvalCard(view);
      const box = document.createElement("div");
      box.className = "approval-card";
      const title = document.createElement("div");
      title.className = "approval-title";
      title.textContent = card.title;
      box.append(title);
      if (card.body !== "") {
        const body = document.createElement("div");
        body.className = "approval-body";
        body.textContent = card.body;
        box.append(body);
      }
      if (card.actions.length > 0) {
        const actions = document.createElement("div");
        actions.className = "approval-actions";
        const clickPending = approvalState.pendingClicks.has(view.requestId);
        for (const action of card.actions) {
          const button = document.createElement("button");
          button.textContent = action === "approve_once" ? "Approve once" : "Decline";
          button.disabled = clickPending || !engineOnline;
          button.addEventListener("click", () => {
            approvalState = applyApprovalClick(approvalState, view.requestId);
            sendFrameToEngine(approvalAnswerFrame(view.requestId, action === "approve_once" ? "accept" : "decline"));
            console.log(`[relay-gui] approval ${view.requestId}: ${action === "approve_once" ? "accept" : "decline"} sent`);
            renderApprovals();
          });
          actions.append(button);
        }
        box.append(actions);
      }
      approvalsArea.append(box);
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
    if (targetFor(message.source) !== null) {
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
    const target = targetFor(footer.source);
    if (target === null) return;
    const key = deliveryKey(messageId, target);
    const delivery = deliveryState.rows.get(key);
    const view = delivery === void 0 ? { label: "", actions: [] } : deliveryStatusView(delivery, target);
    footer.status.textContent = view.label;
    footer.actions.textContent = "";
    const buttons = [];
    const send = sendButton(footer.source, delivery);
    if (send.show) buttons.push({ action: "forward", label: send.label });
    for (const action of view.actions) {
      if (action === "approve") buttons.push({ action, label: "Approve" });
      else if (action === "reject") buttons.push({ action, label: "Reject" });
    }
    const clickPending = deliveryState.pendingClicks.has(key);
    const approveTitle = approveDisabledTitle(paused);
    for (const spec of buttons) {
      const button = document.createElement("button");
      button.textContent = spec.label;
      if (spec.action === "approve" && approveTitle !== null) {
        button.disabled = true;
        button.title = approveTitle;
      } else {
        button.disabled = clickPending || !engineOnline;
        button.removeAttribute("title");
      }
      button.addEventListener("click", () => {
        deliveryState = applyClick(deliveryState, key);
        sendFrameToEngine(spec.action === "forward" ? forwardFrame(messageId, target) : spec.action === "approve" ? approveFrame(messageId, target) : rejectFrame(messageId, target));
        console.log(`[relay-gui] ${spec.action} sent for ${messageId} \u2192 ${target}`);
        renderDelivery(messageId);
      });
      footer.actions.append(button);
    }
  }
  function updatePendingBadge() {
    if (pendingBadge === null) return;
    const count = pendingCount([...deliveryState.rows.values()]);
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
      deliveryState = applySnapshotDeliveries(deliveryState, frame.deliveries ?? []);
      for (const message of messages) appendMessage(message);
      for (const id of messageFooters.keys()) renderDelivery(id);
      updatePendingBadge();
      paused = frame.paused === true;
      setPausedUi();
      approvalState = applySnapshotApprovals(approvalState, frame.approvals ?? []);
      renderApprovals();
      console.log(`[relay-gui] snapshot: ${messages.length} messages, statuses ${JSON.stringify(statuses)}`);
      engineState("engine connected", true);
      return;
    }
    if (type === "pause_update") {
      paused = frame.paused === true;
      setPausedUi();
      return;
    }
    if (type === "approval_request") {
      const requestId = frame.requestId;
      if (typeof requestId !== "string") return;
      const view = {
        requestId,
        kind: typeof frame.kind === "string" ? frame.kind : "other",
        summary: typeof frame.summary === "string" ? frame.summary : "",
        method: typeof frame.method === "string" ? frame.method : ""
      };
      approvalState = applyApprovalRequest(approvalState, view);
      console.log(`[relay-gui] approval request ${requestId} (${view.kind})`);
      renderApprovals();
      return;
    }
    if (type === "approval_resolved") {
      const requestId = frame.requestId;
      if (typeof requestId !== "string") return;
      approvalState = applyApprovalResolved(approvalState, requestId);
      console.log(`[relay-gui] approval ${requestId} resolved: ${String(frame.decision)}`);
      renderApprovals();
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
      deliveryState = applyDeliveryUpdate(deliveryState, update);
      console.log(`[relay-gui] delivery ${messageId} \u2192 ${update.target}: ${update.status}`);
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
  if (stopButton !== null) {
    stopButton.textContent = stopButtonLabel(paused);
    stopButton.disabled = true;
    stopButton.addEventListener("click", () => {
      sendFrameToEngine(paused ? resumeFrame() : stopFrame());
      console.log(`[relay-gui] ${paused ? "resume" : "stop"} sent`);
    });
  }
  connect();
})();
