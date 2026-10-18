(() => {
  // spikes/chatgpt-extension/src/selectors.ts
  var SELECTORS = {
    /** One element per exchange. data-talvt-turn-state: "in_progress" while streaming, "complete" when done. */
    turn: "[data-talvt-turn-state]",
    /** The reply body inside a turn; data-dil-message-id is a stable per-message id. */
    replyBody: "[data-dil-message-id]",
    /** The stop button while a reply is streaming (data-testid is gone in the current UI). */
    stopButton: 'form[data-chatgpt-composer] button[aria-label="Stop"]',
    /** The composer (ProseMirror contenteditable; the old #prompt-textarea no longer exists). */
    composer: 'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]',
    /**
     * The send button. NOT present while the box is empty (a Dictate button shows instead),
     * so the spike deliberately never relies on it: completion is judged by the stop button
     * disappearing, the turn state, and text stability. Kept here so the M1.4 adapter can
     * adopt it when needed — deliberate deviation, noted in docs/status/m0.2.md.
     */
    sendButton: 'form[data-chatgpt-composer] button[aria-label="Send"]'
  };

  // spikes/chatgpt-extension/src/content.ts
  var chromeApi = globalThis.chrome;
  var seen = /* @__PURE__ */ new Set();
  var witnessed = /* @__PURE__ */ new Set();
  var stabilityTimer = null;
  var watchingId = "";
  var watchingText = "";
  var warnedNoTurns = false;
  async function sha256(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
    return el.getAttribute("data-dil-message-id") ?? "";
  }
  function onConversationUrl() {
    return /^\/(c|g)\//.test(location.pathname);
  }
  function checkCompletion() {
    const allTurns = turns();
    if (!warnedNoTurns && onConversationUrl() && allTurns.length === 0) {
      warnedNoTurns = true;
      console.warn("[relay-spike] WARNING: no turns found, selectors may be stale");
    }
    for (const turn of allTurns) {
      if (turn.getAttribute("data-talvt-turn-state") === "in_progress") {
        const replies = turn.querySelectorAll(SELECTORS.replyBody);
        const last = replies.length > 0 ? replies[replies.length - 1] : null;
        if (last !== null && messageId(last) !== "") witnessed.add(messageId(last));
      }
    }
    if (streamingNow()) {
      const last = lastReply();
      if (last !== null && messageId(last) !== "") witnessed.add(messageId(last));
      return;
    }
    const reply = lastReply();
    if (reply === null) return;
    const id = messageId(reply);
    if (id === "" || !witnessed.has(id) || seen.has(id)) return;
    if (id !== watchingId) {
      watchingId = id;
      watchingText = "";
    }
    const text = reply.innerText;
    if (text === watchingText) return;
    watchingText = text;
    if (stabilityTimer !== null) clearTimeout(stabilityTimer);
    stabilityTimer = setTimeout(onStableText, 1500);
  }
  function onStableText() {
    const id = watchingId;
    const expected = watchingText;
    const current = lastReply();
    if (current === null || messageId(current) !== id) return;
    if (current.innerText !== expected) return;
    if (streamingNow()) return;
    const currentTurns = turns();
    const state = currentTurns.length > 0 ? currentTurns[currentTurns.length - 1].getAttribute("data-talvt-turn-state") : null;
    if (state !== "complete") {
      stabilityTimer = setTimeout(onStableText, 1500);
      return;
    }
    seen.add(id);
    watchingId = "";
    watchingText = "";
    void (async () => {
      const hash = await sha256(expected);
      console.log(`[relay-spike] assistant reply completed (message-id: ${id})
hash: ${hash}
---
${expected}
---`);
    })();
  }
  new MutationObserver(() => checkCompletion()).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["data-talvt-turn-state"]
  });
  checkCompletion();
  chromeApi?.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "type-test-text" || typeof msg.text !== "string") return;
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
})();
