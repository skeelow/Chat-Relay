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
    return { requests: /* @__PURE__ */ new Map(), pendingClicks: /* @__PURE__ */ new Set(), dismissed: /* @__PURE__ */ new Set() };
  }
  function visibleApprovals(state) {
    return [...state.requests.values()].filter((view) => !state.dismissed.has(view.requestId));
  }
  function applyApprovalRequest(state, view) {
    const requests = new Map(state.requests);
    requests.set(view.requestId, view);
    const dismissed = new Set(state.dismissed);
    dismissed.delete(view.requestId);
    return { requests, pendingClicks: state.pendingClicks, dismissed };
  }
  function applyApprovalDismiss(state, requestId) {
    const dismissed = new Set(state.dismissed);
    dismissed.add(requestId);
    return { requests: state.requests, pendingClicks: state.pendingClicks, dismissed };
  }
  function applyApprovalResolved(state, requestId) {
    const requests = new Map(state.requests);
    requests.delete(requestId);
    const pendingClicks = new Set(state.pendingClicks);
    pendingClicks.delete(requestId);
    const dismissed = new Set(state.dismissed);
    dismissed.delete(requestId);
    return { requests, pendingClicks, dismissed };
  }
  function applySnapshotApprovals(state, views) {
    const requests = /* @__PURE__ */ new Map();
    for (const view of views) requests.set(view.requestId, view);
    return { requests, pendingClicks: /* @__PURE__ */ new Set(), dismissed: /* @__PURE__ */ new Set() };
  }
  function applyApprovalClick(state, requestId) {
    const pendingClicks = new Set(state.pendingClicks);
    pendingClicks.add(requestId);
    return { requests: state.requests, pendingClicks, dismissed: state.dismissed };
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
  function userFooterTargets(messageId, rows) {
    const order = ["astra", "codex"];
    return order.filter((target) => rows.some((row) => row.messageId === messageId && row.target === target));
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

  // app/src/compose.ts
  var COMPOSE_BODY_CAP = 2e4;
  var PREFIX = /^\s*@(?<tag>astra|codex|both)\b[,;:\s]*/i;
  var TARGETS_OF = {
    astra: ["astra"],
    codex: ["codex"],
    both: ["astra", "codex"]
  };
  function parseCompose(text, selector) {
    const match = PREFIX.exec(text);
    const tag = match?.groups?.tag.toLowerCase();
    const rest = tag === void 0 ? text.trim() : text.slice((match?.index ?? 0) + (match?.[0]?.length ?? 0)).trim();
    if (rest === "") return { ok: false, reason: "empty" };
    if (rest.length > COMPOSE_BODY_CAP) return { ok: false, reason: "too-long" };
    const choice = tag ?? (selector in TARGETS_OF ? selector : "both");
    return { ok: true, body: rest, targets: TARGETS_OF[choice] };
  }

  // app/src/settings.ts
  var TURN_CAP_MIN = 1;
  var TURN_CAP_MAX = 50;
  var DELAY_MIN_SEC = 3;
  var DELAY_MAX_SEC = 1800;
  function delayToSeconds(value, unit) {
    return unit === "minutes" ? value * 60 : value;
  }
  function secondsToDelay(seconds) {
    if (seconds >= 60 && seconds % 60 === 0) return { value: seconds / 60, unit: "minutes" };
    return { value: seconds, unit: "seconds" };
  }
  function isDelayValid(seconds) {
    return Number.isInteger(seconds) && seconds >= DELAY_MIN_SEC && seconds <= DELAY_MAX_SEC;
  }
  function isTurnCapValid(value) {
    return Number.isInteger(value) && value >= TURN_CAP_MIN && value <= TURN_CAP_MAX;
  }
  function modeLabel(mode) {
    return mode === "approve_each" ? "Approve each" : "Manual";
  }
  function settingsControls(server) {
    return {
      mode: server.mode,
      turnCap: String(server.turnCap),
      autoSend: server.autoSend,
      delay: secondsToDelay(server.autoSendDelaySec)
    };
  }
  function setModeFrame(update) {
    return { type: "set_mode", ...update };
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
  var composeText = document.getElementById("compose-text");
  var composeTarget = document.getElementById("compose-target");
  var composeSend = document.getElementById("compose-send");
  var settingsButton = document.getElementById("settings-btn");
  var settingsPanel = document.getElementById("settings");
  var settingsHint = document.getElementById("settings-hint");
  var modeLabelEl = document.getElementById("mode-label");
  var modeManualInput = document.getElementById("mode-manual");
  var modeApproveInput = document.getElementById("mode-approve-each");
  var turnCapInput = document.getElementById("turn-cap");
  var autoSendInput = document.getElementById("auto-send");
  var autoSendDelayInput = document.getElementById("auto-send-delay");
  var autoSendUnitInput = document.getElementById("auto-send-unit");
  var deliveryState = emptyDeliveryState();
  var messageFooters = /* @__PURE__ */ new Map();
  var engineOnline = false;
  var paused = false;
  var approvalState = emptyApprovalsState();
  var relaySettings = null;
  var SENDER_LABELS = { astra: "Astra", codex: "Codex", user: "You" };
  function engineState(label, on) {
    if (engineLabel !== null) engineLabel.textContent = label;
    if (dot !== null) dot.className = on ? "on" : "off";
    if (stopButton !== null) stopButton.disabled = !on;
    if (composeText !== null) composeText.disabled = !on;
    if (composeTarget !== null) composeTarget.disabled = !on;
    if (composeSend !== null) composeSend.disabled = !on;
    if (settingsButton !== null) settingsButton.disabled = !on;
    if (modeManualInput !== null) modeManualInput.disabled = !on;
    if (modeApproveInput !== null) modeApproveInput.disabled = !on;
    if (turnCapInput !== null) turnCapInput.disabled = !on;
    if (autoSendInput !== null) autoSendInput.disabled = !on;
    if (autoSendDelayInput !== null) autoSendDelayInput.disabled = !on;
    if (autoSendUnitInput !== null) autoSendUnitInput.disabled = !on;
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
      approvalsBadge.textContent = approvalsBadgeText(visibleApprovals(approvalState).length);
    }
  }
  function renderSettings() {
    if (relaySettings === null) return;
    const controls = settingsControls(relaySettings);
    if (modeManualInput !== null) modeManualInput.checked = controls.mode === "manual";
    if (modeApproveInput !== null) modeApproveInput.checked = controls.mode === "approve_each";
    if (turnCapInput !== null) turnCapInput.value = controls.turnCap;
    if (autoSendInput !== null) autoSendInput.checked = controls.autoSend;
    if (autoSendDelayInput !== null) autoSendDelayInput.value = String(controls.delay.value);
    if (autoSendUnitInput !== null) autoSendUnitInput.value = controls.delay.unit;
    if (modeLabelEl !== null) modeLabelEl.textContent = `Mode: ${modeLabel(relaySettings.mode)}`;
    if (settingsHint !== null) settingsHint.textContent = "";
    console.log(`[relay-gui] settings: ${JSON.stringify(relaySettings)}`);
  }
  function appendDismissButton(actions, requestId) {
    const button = document.createElement("button");
    button.textContent = "Dismiss";
    button.addEventListener("click", () => {
      approvalState = applyApprovalDismiss(approvalState, requestId);
      console.log(`[relay-gui] approval card ${requestId} dismissed locally`);
      renderApprovals();
    });
    actions.append(button);
  }
  function renderApprovals() {
    updateApprovalsBadge();
    if (approvalsArea === null) return;
    approvalsArea.textContent = "";
    const visible = visibleApprovals(approvalState);
    for (const view of visible) {
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
      } else {
        const actions = document.createElement("div");
        actions.className = "approval-actions";
        appendDismissButton(actions, view.requestId);
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
    if (targetFor(message.source) !== null || message.source === "user") {
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
  function appendActionButton(container, spec, messageId, target) {
    const key = deliveryKey(messageId, target);
    const clickPending = deliveryState.pendingClicks.has(key);
    const approveTitle = spec.action === "approve" ? approveDisabledTitle(paused) : null;
    const button = document.createElement("button");
    button.textContent = spec.label;
    if (approveTitle !== null) {
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
    container.append(button);
  }
  function renderDelivery(messageId) {
    const footer = messageFooters.get(messageId);
    if (footer === void 0) return;
    footer.status.textContent = "";
    footer.actions.textContent = "";
    if (footer.source === "user") {
      for (const target2 of userFooterTargets(messageId, [...deliveryState.rows.values()])) {
        const delivery2 = deliveryState.rows.get(deliveryKey(messageId, target2));
        if (delivery2 === void 0) continue;
        const view2 = deliveryStatusView(delivery2, target2);
        const line = document.createElement("div");
        line.className = "delivery-line";
        const status = document.createElement("span");
        status.className = "line-status";
        status.textContent = view2.label;
        line.append(status);
        const actions = document.createElement("span");
        actions.className = "line-actions";
        line.append(actions);
        footer.actions.append(line);
        for (const action of view2.actions) {
          appendActionButton(actions, {
            action,
            label: action === "approve" ? "Approve" : action === "reject" ? "Reject" : "Send again"
          }, messageId, target2);
        }
      }
      return;
    }
    const target = targetFor(footer.source);
    if (target === null) return;
    const key = deliveryKey(messageId, target);
    const delivery = deliveryState.rows.get(key);
    const view = delivery === void 0 ? { label: "", actions: [] } : deliveryStatusView(delivery, target);
    footer.status.textContent = view.label;
    const buttons = [];
    const send = sendButton(footer.source, delivery);
    if (send.show) buttons.push({ action: "forward", label: send.label });
    for (const action of view.actions) {
      if (action === "approve") buttons.push({ action, label: "Approve" });
      else if (action === "reject") buttons.push({ action, label: "Reject" });
    }
    for (const spec of buttons) appendActionButton(footer.actions, spec, messageId, target);
  }
  function updatePendingBadge() {
    if (pendingBadge === null) return;
    const count = pendingCount([...deliveryState.rows.values()]);
    pendingBadge.textContent = count === 0 ? "" : `${count} pending`;
  }
  function sendFrameToEngine(frame) {
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
      return true;
    }
    return false;
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
      relaySettings = frame.settings ?? null;
      renderSettings();
      console.log(`[relay-gui] snapshot: ${messages.length} messages, statuses ${JSON.stringify(statuses)}`);
      engineState("engine connected", true);
      return;
    }
    if (type === "pause_update") {
      paused = frame.paused === true;
      setPausedUi();
      return;
    }
    if (type === "settings_update") {
      relaySettings = {
        mode: frame.mode === "approve_each" ? "approve_each" : "manual",
        turnCap: typeof frame.turnCap === "number" ? frame.turnCap : 4,
        autoSend: frame.autoSend === true,
        autoSendDelaySec: typeof frame.autoSendDelaySec === "number" ? frame.autoSendDelaySec : 10
      };
      renderSettings();
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
  function submitCompose() {
    if (composeText === null || composeTarget === null) return;
    const parsed = parseCompose(composeText.value, composeTarget.value);
    if (!parsed.ok) {
      console.log(`[relay-gui] compose refused: ${parsed.reason} \u2014 text kept`);
      return;
    }
    const wentOut = sendFrameToEngine({ type: "send", body: parsed.body, targets: parsed.targets });
    if (wentOut) {
      composeText.value = "";
      console.log(`[relay-gui] sent to ${parsed.targets.join(" + ")}: ${parsed.body.slice(0, 60)}`);
    } else {
      console.log("[relay-gui] send could not go out \u2014 engine link down, text kept");
    }
  }
  if (composeText !== null) {
    composeText.disabled = true;
    composeText.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitCompose();
      }
    });
  }
  if (composeTarget !== null) composeTarget.disabled = true;
  if (composeSend !== null) {
    composeSend.disabled = true;
    composeSend.addEventListener("click", submitCompose);
  }
  if (settingsButton !== null) {
    settingsButton.disabled = true;
    settingsButton.addEventListener("click", () => {
      if (settingsPanel !== null) settingsPanel.hidden = !settingsPanel.hidden;
    });
  }
  if (modeManualInput !== null) {
    modeManualInput.disabled = true;
    modeManualInput.addEventListener("change", () => {
      if (modeManualInput.checked) sendFrameToEngine(setModeFrame({ mode: "manual" }));
    });
  }
  if (modeApproveInput !== null) {
    modeApproveInput.disabled = true;
    modeApproveInput.addEventListener("change", () => {
      if (modeApproveInput.checked) sendFrameToEngine(setModeFrame({ mode: "approve_each" }));
    });
  }
  if (turnCapInput !== null) {
    turnCapInput.disabled = true;
    turnCapInput.addEventListener("change", () => {
      const value = Number(turnCapInput.value);
      if (!isTurnCapValid(value)) {
        if (settingsHint !== null) settingsHint.textContent = "Turn cap must be a whole number from 1 to 50.";
        return;
      }
      sendFrameToEngine(setModeFrame({ turnCap: value }));
    });
  }
  if (autoSendInput !== null) {
    autoSendInput.disabled = true;
    autoSendInput.addEventListener("change", () => {
      sendFrameToEngine(setModeFrame({ autoSend: autoSendInput.checked }));
    });
  }
  var submitDelay = () => {
    if (autoSendDelayInput === null || autoSendUnitInput === null) return;
    const value = Number(autoSendDelayInput.value);
    const seconds = delayToSeconds(value, autoSendUnitInput.value === "minutes" ? "minutes" : "seconds");
    if (!isDelayValid(seconds)) {
      if (settingsHint !== null) settingsHint.textContent = "The delay must be 3 seconds to 30 minutes.";
      return;
    }
    sendFrameToEngine(setModeFrame({ autoSendDelaySec: seconds }));
  };
  if (autoSendDelayInput !== null) {
    autoSendDelayInput.disabled = true;
    autoSendDelayInput.addEventListener("change", submitDelay);
  }
  if (autoSendUnitInput !== null) {
    autoSendUnitInput.disabled = true;
    autoSendUnitInput.addEventListener("change", submitDelay);
  }
  connect();
})();
