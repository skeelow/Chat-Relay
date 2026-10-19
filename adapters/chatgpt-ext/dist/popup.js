"use strict";
(() => {
  // adapters/chatgpt-ext/src/popup.ts
  var chromeApi = globalThis.chrome;
  var TEST_TEXT = "[Relay \xB7 test] Reply with PONG.";
  var button = document.getElementById("type-test");
  var status = document.getElementById("status");
  button?.addEventListener("click", async () => {
    if (status === null || chromeApi === void 0) return;
    const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === void 0 || tab.url === void 0 || !tab.url.startsWith("https://chatgpt.com/")) {
      status.textContent = "Open a chatgpt.com tab first.";
      return;
    }
    try {
      const res = await chromeApi.tabs.sendMessage(tab.id, { type: "type-test-text", text: TEST_TEXT });
      status.textContent = res.ok ? res.note ?? "typed" : `failed: ${res.error}`;
    } catch (err) {
      status.textContent = `failed: ${String(err)} \u2014 reload the chatgpt.com tab after (re)installing the extension`;
    }
  });
})();
