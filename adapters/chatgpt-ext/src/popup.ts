// Relay Chat — astra adapter, popup (M1.4, carried over from the M0.2
// spike unchanged): one button that types the [Relay · test] PONG prompt
// into the chatgpt.com composer. It never presses Send (SPEC M0.2 step 4).
export {}; // module scope: top-level names must not collide with other scripts

const chromeApi = (globalThis as unknown as {
  chrome?: {
    tabs: {
      query: (q: { active: boolean; currentWindow: boolean }) => Promise<Array<{ id?: number; url?: string }>>;
      sendMessage: (tabId: number, msg: unknown) => Promise<unknown>;
    };
  };
}).chrome;

const TEST_TEXT = '[Relay · test] Reply with PONG.';

const button = document.getElementById('type-test') as HTMLButtonElement | null;
const status = document.getElementById('status') as HTMLElement | null;

button?.addEventListener('click', async () => {
  if (status === null || chromeApi === undefined) return;
  const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || tab.url === undefined || !tab.url.startsWith('https://chatgpt.com/')) {
    status.textContent = 'Open a chatgpt.com tab first.';
    return;
  }
  try {
    const res = await chromeApi.tabs.sendMessage(tab.id, { type: 'type-test-text', text: TEST_TEXT }) as
      | { ok: boolean; note?: string; error?: string };
    status.textContent = res.ok ? (res.note ?? 'typed') : `failed: ${res.error}`;
  } catch (err) {
    status.textContent = `failed: ${String(err)} — reload the chatgpt.com tab after (re)installing the extension`;
  }
});
