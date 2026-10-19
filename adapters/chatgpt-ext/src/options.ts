// Relay Chat — astra adapter, options page (M1.4). The extension cannot
// read %APPDATA%, so the user pastes the engine token once (publisher's
// decision); it lives in chrome.storage.local. The service worker picks it
// up immediately via storage.onChanged and connects.
export {}; // module scope: top-level names must not collide with other scripts

const TOKEN_KEY = 'token';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

interface OptionsChrome {
  storage: {
    local: {
      get(keys: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}
const chromeApi = (globalThis as unknown as { chrome?: OptionsChrome }).chrome;

const textarea = document.getElementById('token') as HTMLTextAreaElement | null;
const button = document.getElementById('save') as HTMLButtonElement | null;
const state = document.getElementById('state') as HTMLElement | null;

function say(text: string, cls: 'ok' | 'err'): void {
  if (state === null) return;
  state.textContent = text;
  state.className = cls;
}

async function refreshSavedState(): Promise<void> {
  if (chromeApi === undefined) {
    say('no chrome API — open this page from the installed extension', 'err');
    return;
  }
  const bag = await chromeApi.storage.local.get(TOKEN_KEY);
  const saved = bag[TOKEN_KEY];
  say(typeof saved === 'string' && TOKEN_PATTERN.test(saved)
    ? 'A token is saved. Replace it only if the engine regenerated its token file.'
    : 'No token saved yet.', 'ok');
}

button?.addEventListener('click', async () => {
  if (textarea === null || chromeApi === undefined) return;
  const token = textarea.value.trim();
  if (!TOKEN_PATTERN.test(token)) {
    say('That does not look like the engine token — expecting 64 hex characters, one line.', 'err');
    return;
  }
  try {
    await chromeApi.storage.local.set({ [TOKEN_KEY]: token });
    textarea.value = '';
    say('Saved — the adapter connects within a few seconds.', 'ok');
  } catch (err) {
    say(`could not save: ${String(err)}`, 'err');
  }
});

void refreshSavedState();
