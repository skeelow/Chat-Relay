"use strict";
(() => {
  // adapters/chatgpt-ext/src/selectors.ts
  var SELECTORS = {
    /** One element per exchange; the turn-state attribute flips in_progress → complete. */
    turn: "[data-talvt-turn-state]",
    /** The reply body inside a turn; the reply-id attribute is a stable per-message id. */
    replyBody: "[data-dil-message-id]",
    /** The stop button while a reply is streaming (data-testid is gone in the current UI). */
    stopButton: 'form[data-chatgpt-composer] button[aria-label="Stop"]',
    /** The composer (ProseMirror contenteditable; the old #prompt-textarea no longer exists). */
    composer: 'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]',
    /**
     * The send button. NOT present while the box is empty (a Dictate button shows
     * instead), so completion is judged by the stop button disappearing, the turn
     * state, and text stability (deliberate M0.2 deviation, kept — see
     * docs/status/m0.2.md).
     */
    sendButton: 'form[data-chatgpt-composer] button[aria-label="Send"]',
    /** The attribute on a turn element that carries its state ("in_progress" | "complete"). */
    turnStateAttribute: "data-talvt-turn-state",
    /** The attribute on a reply body that carries its stable message id (the capture's sourceRef). */
    replyIdAttribute: "data-dil-message-id"
  };

  // adapters/chatgpt-ext/src/protocol.ts
  function pageStatus(view) {
    if (view.staleConfirmed) return "selectors_stale";
    if (view.stopButtonPresent || view.anyTurnInProgress) return "streaming";
    return "idle";
  }
  function deliveryPageDecision(view) {
    if (!view.composerFound) {
      return { ok: false, error: "ChatGPT's input box was not found (page changed?)", selectorsStale: true };
    }
    if (view.streaming) {
      return { ok: false, error: "ChatGPT is still replying \u2014 wait, then forward again" };
    }
    if (view.composerHasText) {
      return { ok: false, error: "ChatGPT's input box already has text \u2014 send or clear it, then forward again" };
    }
    return { ok: true };
  }
  function linesForInsert(text) {
    if (text === "") return [];
    return text.split("\n");
  }
  function textsMatch(typed, expected) {
    return typed.replace(/\s+/g, " ").trim() === expected.replace(/\s+/g, " ").trim();
  }
  function replyText(reply, mount) {
    const clone = reply.cloneNode(true);
    const headers = [];
    for (const pre of clone.querySelectorAll("pre")) {
      const candidate = pre.previousElementSibling;
      if (candidate !== null && candidate.querySelectorAll("button").length > 0 && candidate.querySelectorAll("pre").length === 0) {
        headers.push(candidate);
      }
    }
    for (const header of headers) header.remove();
    for (const button of clone.querySelectorAll("button")) button.remove();
    const unmount = mount(clone);
    try {
      return clone.innerText;
    } finally {
      unmount();
    }
  }

  // adapters/chatgpt-ext/src/content.ts
  var BUILD_MARKER = "2026-10-20.1";
  console.log("[relay-astra] content script loaded", BUILD_MARKER);
  var DEBUG = false;
  function debug(...parts) {
    if (DEBUG) console.log("[relay-astra]", ...parts);
  }
  var lastReason = "";
  function debugReason(reason) {
    if (!DEBUG || reason === lastReason) return;
    lastReason = reason;
    console.log("[relay-astra]", reason);
  }
  var chromeApi = globalThis.chrome;
  var seen = /* @__PURE__ */ new Set();
  var witnessed = /* @__PURE__ */ new Set();
  var stabilityTimer = null;
  var watchingId = "";
  var watchingText = "";
  var STALE_DELAY_MS = 5e3;
  var staleTimer = null;
  var staleConfirmed = false;
  var lastStatus = null;
  function mountOffscreen(el) {
    const node = el;
    node.style.position = "fixed";
    node.style.left = "-100000px";
    node.style.top = "0";
    document.body.appendChild(node);
    return () => {
      node.remove();
    };
  }
  function turns() {
    return [...document.querySelectorAll(SELECTORS.turn)];
  }
  function replyBodies() {
    return [...document.querySelectorAll(SELECTORS.replyBody)];
  }
  function lastReply() {
    const all = replyBodies();
    return all.length > 0 ? all[all.length - 1] : null;
  }
  function streamingNow() {
    return document.querySelector(SELECTORS.stopButton) !== null;
  }
  function messageId(el) {
    return el.getAttribute(SELECTORS.replyIdAttribute) ?? "";
  }
  function onConversationUrl() {
    return /^\/(c|g)\//.test(location.pathname);
  }
  function sendWithTimeout(msg, timeoutMs) {
    if (chromeApi === void 0) return Promise.reject(new Error("no chrome runtime"));
    return Promise.race([
      chromeApi.runtime.sendMessage(msg),
      new Promise((_, reject) => setTimeout(() => reject(new Error("send timed out")), timeoutMs))
    ]);
  }
  function reportStatus(status) {
    if (status === lastStatus || chromeApi === void 0) return;
    sendWithTimeout({ type: "status", status }, 3e3).then(
      () => {
        lastStatus = status;
      },
      () => {
        debug("status send failed (service worker restarting?) \u2014 will retry on change");
      }
    );
  }
  function onStaleConfirmed() {
    staleTimer = null;
    staleConfirmed = true;
    console.warn(`[relay-astra] WARNING: no turns found after ${STALE_DELAY_MS / 1e3}s, selectors may be stale \u2014 reporting to the engine`);
    reportStatus("selectors_stale");
  }
  function checkCompletion() {
    const allTurns = turns();
    if (onConversationUrl() && allTurns.length === 0 && staleTimer === null && !staleConfirmed) {
      staleTimer = setTimeout(onStaleConfirmed, STALE_DELAY_MS);
    } else if (allTurns.length > 0 && staleTimer !== null) {
      clearTimeout(staleTimer);
      staleTimer = null;
    }
    if (allTurns.length > 0 && staleConfirmed) staleConfirmed = false;
    reportStatus(pageStatus({
      staleConfirmed,
      stopButtonPresent: streamingNow(),
      anyTurnInProgress: allTurns.some(
        (turn) => turn.getAttribute(SELECTORS.turnStateAttribute) === "in_progress"
      )
    }));
    for (const turn of allTurns) {
      if (turn.getAttribute(SELECTORS.turnStateAttribute) === "in_progress") {
        const replies = turn.querySelectorAll(SELECTORS.replyBody);
        const last = replies.length > 0 ? replies[replies.length - 1] : null;
        if (last !== null && messageId(last) !== "") {
          if (!witnessed.has(messageId(last))) debug("witnessed (turn in_progress):", messageId(last));
          witnessed.add(messageId(last));
        }
      }
    }
    if (streamingNow()) {
      const last = lastReply();
      if (last !== null && messageId(last) !== "" && !witnessed.has(messageId(last))) {
        debug("witnessed (stop button):", messageId(last));
        witnessed.add(messageId(last));
      }
      debugReason("tick skipped: reply is streaming (stop button present)");
      return;
    }
    const reply = lastReply();
    if (reply === null) {
      debugReason("tick skipped: no reply body on the page");
      return;
    }
    const id = messageId(reply);
    if (id === "") {
      debugReason("tick skipped: reply has no reply id attribute");
      return;
    }
    if (!witnessed.has(id)) {
      debugReason(`tick skipped: ${id} was not witnessed streaming this session`);
      return;
    }
    if (seen.has(id)) {
      debugReason(`tick skipped: ${id} was already reported`);
      return;
    }
    if (id !== watchingId) {
      watchingId = id;
      watchingText = "";
      debug("watching reply:", id);
    }
    const text = reply.innerText;
    if (text === watchingText) {
      debugReason("tick skipped: text unchanged (stability timer is running)");
      return;
    }
    watchingText = text;
    if (stabilityTimer !== null) clearTimeout(stabilityTimer);
    stabilityTimer = setTimeout(onStableText, 1500);
    debug("timer armed for", id, "(1.5s stability window)");
  }
  function onStableText() {
    debug("timer fired; watching:", watchingId);
    const id = watchingId;
    const expected = watchingText;
    const current = lastReply();
    if (current === null) {
      debug("timer: no reply body \u2014 nothing to report");
      return;
    }
    if (messageId(current) !== id) {
      debug("timer: last reply changed to", messageId(current), "\u2014 standing down");
      return;
    }
    if (current.innerText !== expected) {
      debug("timer: text changed again \u2014 the tick rescheduled us");
      return;
    }
    if (streamingNow()) {
      debug("timer: a new reply is streaming \u2014 standing down");
      return;
    }
    const currentTurns = turns();
    const state = currentTurns.length > 0 ? currentTurns[currentTurns.length - 1].getAttribute(SELECTORS.turnStateAttribute) : null;
    debug("turn state:", state);
    if (state !== "complete") {
      debug("turn not complete \u2014 re-arming the timer");
      stabilityTimer = setTimeout(onStableText, 1500);
      return;
    }
    seen.add(id);
    watchingId = "";
    watchingText = "";
    debug("reporting reply:", id);
    const body = replyText(current, mountOffscreen);
    void deliverCapture(body, id);
  }
  var DELIVERY_ATTEMPTS = 15;
  var DELIVERY_TIMEOUT_MS = 3e3;
  var DELIVERY_RETRY_MS = 2e3;
  async function deliverCapture(body, sourceRef) {
    if (body.trim().length === 0) {
      console.warn("[relay-astra] reply was empty after stripping \u2014 not reported");
      return;
    }
    for (let attempt = 1; attempt <= DELIVERY_ATTEMPTS; attempt++) {
      try {
        const res = await sendWithTimeout(
          { type: "captured", body, sourceRef },
          DELIVERY_TIMEOUT_MS
        );
        if (res?.ok === true) {
          if (res.dropped !== void 0) {
            debug(`capture ${sourceRef} dropped by the worker (${res.dropped})`);
          } else {
            console.log(`[relay-astra] reply reported to the engine (message-id ${sourceRef})`);
          }
          return;
        }
        debug("worker refused the capture:", res?.error ?? "unknown");
      } catch (err) {
        debug(`capture attempt ${attempt} failed:`, String(err));
      }
      if (attempt < DELIVERY_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, DELIVERY_RETRY_MS));
      }
    }
    console.error(`[relay-astra] could not confirm delivery of ${sourceRef} to the engine \u2014 is the relay engine running? (the service worker may still deliver it once the engine returns)`);
  }
  new MutationObserver(() => checkCompletion()).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [SELECTORS.turnStateAttribute]
  });
  checkCompletion();
  chromeApi?.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "type-relay-text" && typeof msg.text === "string" && typeof msg.messageId === "string") {
      sendResponse(typeRelayText(msg.text));
      return;
    }
    if (msg?.type !== "type-test-text" || typeof msg.text !== "string") return;
    debug("popup asked to type the test text");
    const composer = document.querySelector(SELECTORS.composer);
    if (composer === null) {
      sendResponse({ ok: false, error: "composer not found on this page" });
      return;
    }
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
      composer.value = msg.text;
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.execCommand("insertText", false, msg.text);
    }
    sendResponse({ ok: true, note: "typed \u2014 Send is yours to click" });
  });
  function composerText(composer) {
    return composer instanceof HTMLTextAreaElement ? composer.value : composer.textContent ?? "";
  }
  function clearComposer(composer) {
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
      composer.value = "";
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.execCommand("selectAll");
      document.execCommand("delete");
    }
  }
  function insertRelayText(composer, text) {
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
      composer.value = text;
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    const lines = linesForInsert(text);
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) document.execCommand("insertLineBreak");
      if (lines[i] !== "") document.execCommand("insertText", false, lines[i]);
    }
  }
  function typeRelayText(text) {
    const composer = document.querySelector(SELECTORS.composer);
    const streaming = streamingNow() || [...document.querySelectorAll(SELECTORS.turn)].some((turn) => turn.getAttribute(SELECTORS.turnStateAttribute) === "in_progress");
    const decision = deliveryPageDecision({
      composerFound: composer !== null,
      streaming,
      composerHasText: composer !== null && composerText(composer).trim() !== ""
    });
    if (!decision.ok) {
      if (decision.selectorsStale === true) reportStatus("selectors_stale");
      return { ok: false, error: decision.error };
    }
    insertRelayText(composer, text);
    if (!textsMatch(composerText(composer), text)) {
      clearComposer(composer);
      return { ok: false, error: "typed text did not match; input box cleared" };
    }
    console.log("[relay-astra] relayed text typed \u2014 Send is the user's to click");
    return { ok: true };
  }
})();
