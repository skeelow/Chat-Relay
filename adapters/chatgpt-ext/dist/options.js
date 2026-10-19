"use strict";
(() => {
  // adapters/chatgpt-ext/src/options.ts
  var TOKEN_KEY = "token";
  var TOKEN_PATTERN = /^[0-9a-f]{64}$/;
  var chromeApi = globalThis.chrome;
  var textarea = document.getElementById("token");
  var button = document.getElementById("save");
  var state = document.getElementById("state");
  function say(text, cls) {
    if (state === null) return;
    state.textContent = text;
    state.className = cls;
  }
  async function refreshSavedState() {
    if (chromeApi === void 0) {
      say("no chrome API \u2014 open this page from the installed extension", "err");
      return;
    }
    const bag = await chromeApi.storage.local.get(TOKEN_KEY);
    const saved = bag[TOKEN_KEY];
    say(typeof saved === "string" && TOKEN_PATTERN.test(saved) ? "A token is saved. Replace it only if the engine regenerated its token file." : "No token saved yet.", "ok");
  }
  button?.addEventListener("click", async () => {
    if (textarea === null || chromeApi === void 0) return;
    const token = textarea.value.trim();
    if (!TOKEN_PATTERN.test(token)) {
      say("That does not look like the engine token \u2014 expecting 64 hex characters, one line.", "err");
      return;
    }
    try {
      await chromeApi.storage.local.set({ [TOKEN_KEY]: token });
      textarea.value = "";
      say("Saved \u2014 the adapter connects within a few seconds.", "ok");
    } catch (err) {
      say(`could not save: ${String(err)}`, "err");
    }
  });
  void refreshSavedState();
})();
