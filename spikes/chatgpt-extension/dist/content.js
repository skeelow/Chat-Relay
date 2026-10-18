(() => {
  // spikes/chatgpt-extension/src/selectors.ts
  var SELECTORS = {
    /** One element per assistant reply. */
    assistantMessage: '[data-message-author-role="assistant"]',
    /** The composer (desktop UI: ProseMirror contenteditable with id prompt-textarea). */
    composer: '#prompt-textarea, div[contenteditable="true"], form textarea',
    /** The send button — completion signal 1: the stop button has returned to send. */
    sendButton: 'button[data-testid="send-button"], button[aria-label="Send prompt"]',
    /** The stop button — its presence means a reply is still streaming. */
    stopButton: 'button[data-testid="stop-button"], button[aria-label="Stop streaming"]'
  };

  // spikes/chatgpt-extension/src/content.ts
  var chromeApi = globalThis.chrome;
  var seen = /* @__PURE__ */ new Set();
  var stabilityTimer = null;
  var watchingText = "";
  async function sha256(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function lastAssistant() {
    const all = document.querySelectorAll(SELECTORS.assistantMessage);
    return all.length > 0 ? all[all.length - 1] : null;
  }
  function streamingNow() {
    return document.querySelector(SELECTORS.stopButton) !== null;
  }
  async function seedSeen() {
    for (const el of document.querySelectorAll(SELECTORS.assistantMessage)) {
      seen.add(await sha256(el.innerText));
    }
  }
  function checkCompletion() {
    if (streamingNow()) return;
    const el = lastAssistant();
    if (el === null) return;
    const text = el.innerText;
    if (text === watchingText) return;
    watchingText = text;
    if (stabilityTimer !== null) clearTimeout(stabilityTimer);
    stabilityTimer = setTimeout(async () => {
      const expected = watchingText;
      const current = lastAssistant();
      if (current === null) return;
      const currentText = current.innerText;
      if (currentText !== expected) return;
      if (streamingNow()) return;
      const hash = await sha256(currentText);
      if (!seen.has(hash)) {
        seen.add(hash);
        console.log(`[relay-spike] assistant reply completed
hash: ${hash}
---
${currentText}
---`);
      }
    }, 1500);
  }
  new MutationObserver(() => checkCompletion()).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
  void seedSeen();
  chromeApi?.runtime?.addListener((msg, _sender, sendResponse) => {
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
