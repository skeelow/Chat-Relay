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
    switch (delivery.status) {
      case "pending_approval":
        return {
          label: delivery.error === void 0 ? "Waiting for your approval" : `Waiting for your approval \u2014 ${delivery.error}`,
          actions: ["approve", "reject"]
        };
      case "queued":
        return {
          label: target === "astra" ? "Approved, waiting for the ChatGPT extension" : target === "codex" ? "Approved, waiting for Codex adapter" : "Approved, waiting for Hermes",
          actions: []
        };
      case "delivering":
        return {
          label: target === "astra" ? "Typing into ChatGPT\u2026" : target === "codex" ? "Sending to Codex\u2026" : "Hermes is working\u2026",
          actions: []
        };
      case "delivered":
        return {
          label: target === "astra" ? "Typed into ChatGPT \u2014 click Send there" : target === "codex" ? "Sent to Codex" : "Hermes replied",
          actions: []
        };
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
  var SENDER_LABELS = { astra: "Astra", codex: "Codex", hermes: "Hermes", user: "You" };
  var SEND_LABEL = {
    astra: "Send to ChatGPT",
    codex: "Send to Codex",
    hermes: "Send to Hermes"
  };
  function otherTargets(source) {
    if (source === "astra") return ["codex", "hermes"];
    if (source === "codex") return ["astra", "hermes"];
    if (source === "hermes") return ["astra", "codex"];
    return [];
  }
  function sendButtons(source, rowsForThisMessage) {
    return otherTargets(source).map((target) => {
      const delivery = rowsForThisMessage.find((row) => row.target === target);
      const plain = SEND_LABEL[target];
      if (delivery === void 0) return { show: true, label: plain, target };
      if (delivery.status === "failed" && delivery.attempts >= 3) {
        return { show: false, label: "", target };
      }
      if (delivery.status === "failed") return { show: true, label: "Send again", target };
      return { show: false, label: "", target };
    });
  }
  function pendingCount(rows) {
    return rows.filter((row) => row.status === "pending_approval").length;
  }
  function userFooterTargets(messageId, rows) {
    const order = ["astra", "codex", "hermes"];
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
  var PREFIX = /^\s*@(?<tag>astra|codex|both|hermes|all)\b[,;:\s]*/i;
  var TARGETS_OF = {
    astra: ["astra"],
    codex: ["codex"],
    both: ["astra", "codex"],
    hermes: ["hermes"],
    all: ["astra", "codex", "hermes"]
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

  // app/src/hermes.ts
  function hermesModeBadge(mode) {
    switch (mode) {
      case void 0:
      case "A":
        return { text: "Conversation: no tools", tone: "safe" };
      case "B":
        return { text: "Supervised: asks first", tone: "caution" };
      case "C":
        return { text: "Work: tools on, no time limit", tone: "warning" };
      case "D":
        return { text: "Full access", tone: "danger" };
      default:
        return { text: `Unknown mode (${mode})`, tone: "danger" };
    }
  }
  function hermesStatusLabel(status) {
    return status.replaceAll("_", " ");
  }

  // app/src/search.ts
  function isSearchQueryValid(query) {
    const trimmed = query.trim();
    return trimmed.length >= 1 && trimmed.length <= 200;
  }
  function searchFrame(requestId, query) {
    return { type: "search", requestId, query: query.trim() };
  }
  function exportFrame(requestId) {
    return { type: "export", requestId };
  }
  function snippetAround(body, query, radius = 40) {
    const at = body.toLowerCase().indexOf(query.trim().toLowerCase());
    const qLen = query.trim().length;
    if (at < 0) {
      return body.length <= radius * 2 ? body : `\u2026${body.slice(0, radius * 2 - 1)}\u2026`;
    }
    const start = Math.max(0, at - radius);
    const end = Math.min(body.length, at + qLen + radius);
    return `${start > 0 ? "\u2026" : ""}${body.slice(start, end)}${end < body.length ? "\u2026" : ""}`;
  }
  function emptySearchState() {
    return { open: false, requestId: null, query: "", results: [], total: 0 };
  }
  function startSearch(state, requestId, query) {
    void state;
    return { open: true, requestId, results: [], total: 0, query };
  }
  function applySearchResult(state, frame) {
    if (!state.open || frame.requestId !== state.requestId) return null;
    const messages = Array.isArray(frame.messages) ? frame.messages : [];
    const query = state.query ?? "";
    const results = messages.slice(0, 100).map((message) => ({
      id: String(message.id ?? ""),
      source: String(message.source ?? ""),
      createdAt: String(message.createdAt ?? ""),
      body: String(message.body ?? ""),
      snippet: snippetAround(String(message.body ?? ""), query)
    }));
    return { ...state, results, total: typeof frame.total === "number" ? frame.total : results.length };
  }
  function closeSearch(state) {
    void state;
    return emptySearchState();
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
    if (mode === "approve_each") return "Approve each";
    if (mode === "auto") return "Auto";
    return "Manual";
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

  // app/src/countdown.ts
  function emptyCountdownState() {
    return { secondsLeft: {} };
  }
  function applyCountdownFrame(state, frame) {
    if (typeof frame.messageId !== "string" || frame.target !== "astra" && frame.target !== "codex") {
      return state;
    }
    const key = `${frame.messageId}:${frame.target}`;
    const next = { secondsLeft: { ...state.secondsLeft } };
    if (frame.seconds === null) {
      delete next.secondsLeft[key];
      return next;
    }
    if (typeof frame.seconds === "number" && Number.isFinite(frame.seconds) && frame.seconds >= 0) {
      next.secondsLeft[key] = Math.floor(frame.seconds);
    }
    return next;
  }
  function tickCountdowns(state) {
    const secondsLeft = {};
    for (const [key, seconds] of Object.entries(state.secondsLeft)) {
      secondsLeft[key] = Math.max(0, seconds - 1);
    }
    return { secondsLeft };
  }
  function countdownRowText(secondsLeft) {
    return `Sending in ${Math.max(0, Math.floor(secondsLeft))}s`;
  }
  function countdownHeaderText(count) {
    if (count <= 0) return "";
    return `${count} countdown${count === 1 ? "" : "s"} running`;
  }
  function heldNotice(cap, otherAi) {
    return `Turn cap reached (${cap}) \u2014 not forwarded automatically. Use Send to ${otherAi} to continue by hand.`;
  }
  function heldNoticeHelp() {
    return "A new user message resets the chain \u2014 it starts from hop 0 again.";
  }
  function autoSendControlsEnabled(mode) {
    return mode === "auto";
  }
  function pendingDecision(hasCountdown, secondsLeft) {
    if (hasCountdown) {
      return { label: countdownRowText(secondsLeft), approveLabel: "Send now", rejectLabel: "Cancel" };
    }
    return { label: "Waiting for your approval", approveLabel: "Approve", rejectLabel: "Reject" };
  }

  // app/src/summary.ts
  function summaryLine(summary, locale = "en-GB") {
    if (summary === null) return null;
    const since = new Date(summary.since);
    const time = Number.isNaN(since.getTime()) ? summary.since : since.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    const turns = summary.turnsUsed === 1 ? "1 AI turn" : `${summary.turnsUsed} AI turns`;
    const approvals = summary.approvalsPending === 1 ? "1 approval waiting" : `${summary.approvalsPending} approvals waiting`;
    return {
      text: `Session since ${time} \xB7 ${turns} \xB7 ${summary.held} held \xB7 ${approvals}`,
      approvalsEmphasised: summary.approvalsPending > 0
    };
  }

  // app/src/footer.ts
  function aiFooterLines(source, rows, ctx) {
    const lines = [];
    for (const entry of sendButtons(source, rows)) {
      const target = entry.target;
      const key = deliveryKey(ctx.messageId, target);
      const delivery = rows.find((row) => row.target === target);
      const view = delivery === void 0 ? { label: "", actions: [] } : deliveryStatusView(delivery, target);
      let label = view.label;
      if (ctx.held !== void 0 && target !== "hermes") {
        label = `${heldNotice(ctx.held.cap, SENDER_LABELS[target] ?? target)} ${heldNoticeHelp()}`;
      }
      const countdownSeconds = ctx.countdownSeconds[key];
      const hasCountdown = countdownSeconds !== void 0 && view.actions.includes("approve") && target !== "hermes";
      const decision = pendingDecision(hasCountdown, countdownSeconds ?? 0);
      if (hasCountdown) {
        label = decision.label;
      }
      const buttons = [];
      if (entry.show) {
        buttons.push({ action: "forward", label: entry.label });
      }
      for (const action of view.actions) {
        if (action === "approve") {
          buttons.push({ action, label: hasCountdown ? decision.approveLabel : "Approve" });
        } else if (action === "reject") {
          buttons.push({ action, label: hasCountdown ? decision.rejectLabel : "Reject" });
        }
      }
      if (label === "" && buttons.length === 0) continue;
      lines.push({ target, label, buttons });
    }
    return lines;
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
  var hermesModeChip = document.getElementById("hermes-mode");
  var modeApproveInput = document.getElementById("mode-approve-each");
  var modeAutoInput = document.getElementById("mode-auto");
  var turnCapInput = document.getElementById("turn-cap");
  var autoSendInput = document.getElementById("auto-send");
  var autoSendDelayInput = document.getElementById("auto-send-delay");
  var autoSendUnitInput = document.getElementById("auto-send-unit");
  var searchButton = document.getElementById("search-btn");
  var searchPanel = document.getElementById("search");
  var searchInput = document.getElementById("search-input");
  var searchResults = document.getElementById("search-results");
  var searchTotal = document.getElementById("search-total");
  var exportButton = document.getElementById("export-btn");
  var exportNote = document.getElementById("export-note");
  var countdownCountEl = document.getElementById("countdown-count");
  var sessionSummaryEl = document.getElementById("session-summary");
  var deliveryState = emptyDeliveryState();
  var messageFooters = /* @__PURE__ */ new Map();
  var engineOnline = false;
  var paused = false;
  var approvalState = emptyApprovalsState();
  var relaySettings = null;
  var searchState = emptySearchState();
  var pendingExport = null;
  var countdownState = emptyCountdownState();
  var heldNotices = /* @__PURE__ */ new Map();
  var sessionSummary = null;
  function renderSessionSummary() {
    if (sessionSummaryEl === null) return;
    const line = summaryLine(sessionSummary);
    if (line === null) {
      sessionSummaryEl.textContent = "";
      sessionSummaryEl.classList.remove("attention");
      return;
    }
    sessionSummaryEl.textContent = line.text;
    sessionSummaryEl.classList.toggle("attention", line.approvalsEmphasised);
  }
  function engineState(label, on) {
    if (engineLabel !== null) engineLabel.textContent = label;
    if (dot !== null) dot.className = on ? "on" : "off";
    if (stopButton !== null) stopButton.disabled = !on;
    if (composeText !== null) composeText.disabled = !on;
    if (composeTarget !== null) composeTarget.disabled = !on;
    if (composeSend !== null) composeSend.disabled = !on;
    if (settingsButton !== null) settingsButton.disabled = !on;
    if (searchButton !== null) searchButton.disabled = !on;
    if (searchInput !== null) searchInput.disabled = !on;
    if (exportButton !== null) exportButton.disabled = !on;
    if (modeManualInput !== null) modeManualInput.disabled = !on;
    if (modeApproveInput !== null) modeApproveInput.disabled = !on;
    if (modeAutoInput !== null) modeAutoInput.disabled = !on;
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
    reportTray();
  }
  function renderSettings() {
    if (relaySettings === null) return;
    const controls = settingsControls(relaySettings);
    if (modeManualInput !== null) modeManualInput.checked = controls.mode === "manual";
    if (modeApproveInput !== null) modeApproveInput.checked = controls.mode === "approve_each";
    if (modeAutoInput !== null) modeAutoInput.checked = controls.mode === "auto";
    if (turnCapInput !== null) turnCapInput.value = controls.turnCap;
    const autoUsable = autoSendControlsEnabled(relaySettings.mode) && engineOnline;
    if (autoSendInput !== null) autoSendInput.disabled = !autoUsable;
    if (autoSendDelayInput !== null) autoSendDelayInput.disabled = !autoUsable;
    if (autoSendUnitInput !== null) autoSendUnitInput.disabled = !autoUsable;
    if (autoSendInput !== null) autoSendInput.checked = controls.autoSend;
    if (autoSendDelayInput !== null) autoSendDelayInput.value = String(controls.delay.value);
    if (autoSendUnitInput !== null) autoSendUnitInput.value = controls.delay.unit;
    if (modeLabelEl !== null) modeLabelEl.textContent = `Mode: ${modeLabel(relaySettings.mode)}`;
    if (settingsHint !== null) settingsHint.textContent = "";
    console.log(`[relay-gui] settings: ${JSON.stringify(relaySettings)}`);
  }
  function renderSearchPanel() {
    if (searchPanel !== null) searchPanel.hidden = !searchState.open;
    if (searchResults === null) return;
    searchResults.textContent = "";
    if (searchTotal !== null) searchTotal.textContent = "";
    if (!searchState.open) return;
    if (searchTotal !== null) {
      searchTotal.textContent = searchState.total > searchState.results.length ? `${searchState.results.length} of ${searchState.total} matches (newest first)` : `${searchState.results.length} ${searchState.results.length === 1 ? "match" : "matches"} (newest first)`;
    }
    for (const hit of searchState.results) {
      const item = document.createElement("div");
      item.className = "search-hit";
      const meta = document.createElement("div");
      meta.className = "search-hit-meta";
      meta.textContent = `${SENDER_LABELS[hit.source] ?? hit.source} \u2014 ${hit.createdAt}`;
      const snippet = document.createElement("div");
      snippet.className = "search-hit-snippet";
      snippet.textContent = hit.snippet;
      item.append(meta, snippet);
      item.addEventListener("click", () => {
        const loaded = document.getElementById(hit.id);
        if (loaded !== null) {
          loaded.scrollIntoView({ block: "center" });
          loaded.classList.add("found");
          setTimeout(() => loaded.classList.remove("found"), 1200);
          return;
        }
        const existing = item.querySelector(".search-hit-full");
        if (existing !== null) {
          existing.remove();
          return;
        }
        const full = document.createElement("div");
        full.className = "search-hit-full";
        full.textContent = hit.body;
        item.append(full);
      });
      searchResults.append(item);
    }
  }
  function reportTray() {
    const pending = pendingCount([...deliveryState.rows.values()]);
    const approvals = visibleApprovals(approvalState).length;
    preload?.reportTrayCounts(pending, approvals);
  }
  function updateCountdownHeader() {
    if (countdownCountEl === null) return;
    const running = Object.keys(countdownState.secondsLeft).length;
    countdownCountEl.textContent = countdownHeaderText(running);
  }
  function renderCountdownFooters() {
    for (const key of Object.keys(countdownState.secondsLeft)) {
      const messageId = key.slice(0, key.lastIndexOf(":"));
      renderDelivery(messageId);
    }
    updateCountdownHeader();
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
    if (statusEl !== null) {
      statusEl.textContent = adapter === "hermes" ? hermesStatusLabel(status) : status.replaceAll("_", " ");
    }
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
    row.id = message.id;
    const sender = document.createElement("div");
    sender.className = "sender";
    sender.textContent = SENDER_LABELS[message.source] ?? message.source;
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = message.body;
    row.append(sender, body);
    if (message.source === "user" || message.source === "astra" || message.source === "codex" || message.source === "hermes") {
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
      for (const target of userFooterTargets(messageId, [...deliveryState.rows.values()])) {
        const delivery = deliveryState.rows.get(deliveryKey(messageId, target));
        if (delivery === void 0) continue;
        const view = deliveryStatusView(delivery, target);
        const line = document.createElement("div");
        line.className = "delivery-line";
        const status = document.createElement("span");
        status.className = "line-status";
        status.textContent = view.label;
        line.append(status);
        const actions = document.createElement("span");
        actions.className = "line-actions";
        line.append(actions);
        footer.actions.append(line);
        for (const action of view.actions) {
          appendActionButton(actions, {
            action,
            label: action === "approve" ? "Approve" : action === "reject" ? "Reject" : "Send again"
          }, messageId, target);
        }
      }
      return;
    }
    const source = footer.source;
    const rowsForThisMessage = [...deliveryState.rows.values()].filter(
      (row) => row.messageId === messageId
    );
    const held = heldNotices.get(messageId);
    const lines = aiFooterLines(source, rowsForThisMessage, {
      messageId,
      countdownSeconds: countdownState.secondsLeft,
      held: held === void 0 ? void 0 : { cap: held.cap }
    });
    for (const line of lines) {
      const lineEl = document.createElement("div");
      lineEl.className = "delivery-line";
      const status = document.createElement("span");
      status.className = "line-status";
      status.textContent = line.label;
      lineEl.append(status);
      const actions = document.createElement("span");
      actions.className = "line-actions";
      for (const button of line.buttons) {
        appendActionButton(actions, { action: button.action, label: button.label }, messageId, line.target);
      }
      lineEl.append(actions);
      footer.actions.append(lineEl);
    }
  }
  function updatePendingBadge() {
    if (pendingBadge === null) return;
    const count = pendingCount([...deliveryState.rows.values()]);
    pendingBadge.textContent = count === 0 ? "" : `${count} pending`;
    reportTray();
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
      setPill("hermes", statuses.hermes ?? "disconnected");
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
      if (Array.isArray(frame.countdowns)) {
        countdownState = emptyCountdownState();
        for (const entry of frame.countdowns) {
          countdownState = applyCountdownFrame(countdownState, {
            messageId: entry.messageId,
            target: entry.target,
            seconds: entry.secondsLeft
          });
        }
      }
      if (Array.isArray(frame.held)) {
        heldNotices.clear();
        for (const entry of frame.held) {
          if (typeof entry.messageId === "string") {
            heldNotices.set(entry.messageId, {
              hop: typeof entry.hop === "number" ? entry.hop : 0,
              cap: typeof entry.cap === "number" ? entry.cap : 0
            });
          }
        }
      }
      renderCountdownFooters();
      for (const messageId of heldNotices.keys()) renderDelivery(messageId);
      if (frame.summary !== void 0 && frame.summary !== null) {
        const summary = frame.summary;
        sessionSummary = {
          turnsUsed: typeof summary.turnsUsed === "number" ? summary.turnsUsed : 0,
          held: typeof summary.held === "number" ? summary.held : 0,
          approvalsPending: typeof summary.approvalsPending === "number" ? summary.approvalsPending : 0,
          since: typeof summary.since === "string" ? summary.since : ""
        };
        renderSessionSummary();
      }
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
        mode: frame.mode === "approve_each" ? "approve_each" : frame.mode === "auto" ? "auto" : "manual",
        turnCap: typeof frame.turnCap === "number" ? frame.turnCap : 4,
        autoSend: frame.autoSend === true,
        autoSendDelaySec: typeof frame.autoSendDelaySec === "number" ? frame.autoSendDelaySec : 10
      };
      renderSettings();
      return;
    }
    if (type === "search_result") {
      const next = applySearchResult(searchState, frame);
      if (next !== null) {
        searchState = next;
        renderSearchPanel();
        console.log(`[relay-gui] search results: ${next.results.length} of ${next.total}`);
      }
      return;
    }
    if (type === "export_result") {
      if (typeof frame.requestId === "string" && frame.requestId === pendingExport) {
        const markdown = typeof frame.markdown === "string" ? frame.markdown : "";
        const count = typeof frame.messageCount === "number" ? frame.messageCount : 0;
        pendingExport = null;
        void Promise.resolve(preload?.saveExport(markdown)).then((path) => {
          if (exportNote !== null) {
            exportNote.textContent = path === null || path === void 0 ? "Export cancelled" : `Saved ${count} messages: ${path}`;
          }
          console.log(`[relay-gui] export ${path === null || path === void 0 ? "cancelled" : `saved to ${path}`}`);
        });
      }
      return;
    }
    if (type === "countdown") {
      countdownState = applyCountdownFrame(countdownState, frame);
      renderDelivery(String(frame.messageId ?? ""));
      renderCountdownFooters();
      console.log(`[relay-gui] countdown: ${JSON.stringify(frame)}`);
      return;
    }
    if (type === "routing_held") {
      if (typeof frame.messageId === "string") {
        heldNotices.set(frame.messageId, {
          hop: typeof frame.hop === "number" ? frame.hop : 0,
          cap: typeof frame.cap === "number" ? frame.cap : 0
        });
        renderDelivery(frame.messageId);
      }
      console.log(`[relay-gui] routing held: ${JSON.stringify(frame)}`);
      return;
    }
    if (type === "session_summary") {
      sessionSummary = {
        turnsUsed: typeof frame.turnsUsed === "number" ? frame.turnsUsed : 0,
        held: typeof frame.held === "number" ? frame.held : 0,
        approvalsPending: typeof frame.approvalsPending === "number" ? frame.approvalsPending : 0,
        since: typeof frame.since === "string" ? frame.since : ""
      };
      renderSessionSummary();
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
  if (modeAutoInput !== null) {
    modeAutoInput.disabled = true;
    modeAutoInput.addEventListener("change", () => {
      if (modeAutoInput.checked) sendFrameToEngine(setModeFrame({ mode: "auto" }));
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
  var submitSearch = () => {
    if (searchInput === null) return;
    const query = searchInput.value;
    if (!isSearchQueryValid(query)) return;
    const requestId = crypto.randomUUID();
    searchState = startSearch(searchState, requestId, query);
    renderSearchPanel();
    sendFrameToEngine(searchFrame(requestId, query));
  };
  var closeSearchPanel = () => {
    searchState = closeSearch(searchState);
    renderSearchPanel();
  };
  if (searchButton !== null) {
    searchButton.disabled = true;
    searchButton.addEventListener("click", () => {
      if (searchPanel === null) return;
      if (searchState.open) {
        closeSearchPanel();
        return;
      }
      searchState = startSearch(searchState, crypto.randomUUID(), "");
      renderSearchPanel();
      searchInput?.focus();
    });
  }
  if (searchInput !== null) {
    searchInput.disabled = true;
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitSearch();
      }
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && searchState.open) closeSearchPanel();
  });
  var searchClear = document.getElementById("search-clear");
  if (searchClear !== null) {
    searchClear.addEventListener("click", () => {
      if (searchInput !== null) searchInput.value = "";
      closeSearchPanel();
    });
  }
  if (exportButton !== null) {
    exportButton.disabled = true;
    exportButton.addEventListener("click", () => {
      pendingExport = crypto.randomUUID();
      if (exportNote !== null) exportNote.textContent = "Building the export\u2026";
      sendFrameToEngine(exportFrame(pendingExport));
    });
  }
  setInterval(() => {
    if (Object.keys(countdownState.secondsLeft).length === 0) return;
    countdownState = tickCountdowns(countdownState);
    renderCountdownFooters();
  }, 1e3);
  var hermesBadge = hermesModeBadge(void 0);
  if (hermesModeChip !== null) {
    hermesModeChip.textContent = hermesBadge.text;
    hermesModeChip.className = `chip tone-${hermesBadge.tone}`;
  }
  connect();
})();
