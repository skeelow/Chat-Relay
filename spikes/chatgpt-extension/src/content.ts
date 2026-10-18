// M0.2 spike — content script. Logging only; it sends nothing (no network, no storage).
//
// Detects completed assistant replies: BOTH signals together — the stop button has
// returned to the send button, and the last assistant message text has not changed
// for 1.5 seconds — then logs the final text and its sha256 exactly once per message.
// Messages already on the page at load are seeded as seen, so reloading never re-logs
// old messages as new.
import { SELECTORS } from './selectors.ts';

const chromeApi = (globalThis as unknown as { chrome?: { runtime: { onMessage: unknown } } }).chrome;
const seen = new Set<string>();
let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
let watchingText = '';

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function lastAssistant(): HTMLElement | null {
  const all = document.querySelectorAll(SELECTORS.assistantMessage);
  return all.length > 0 ? (all[all.length - 1] as HTMLElement) : null;
}

function streamingNow(): boolean {
  return document.querySelector(SELECTORS.stopButton) !== null;
}

/** Hash everything already on the page so a reload never logs old replies. */
async function seedSeen(): Promise<void> {
  for (const el of document.querySelectorAll(SELECTORS.assistantMessage)) {
    seen.add(await sha256((el as HTMLElement).innerText));
  }
}

function checkCompletion(): void {
  if (streamingNow()) return; // still streaming: never log mid-stream
  const el = lastAssistant();
  if (el === null) return;
  const text = el.innerText;
  if (text === watchingText) return; // nothing changed since the last tick
  watchingText = text;
  if (stabilityTimer !== null) clearTimeout(stabilityTimer);
  stabilityTimer = setTimeout(async () => {
    const expected = watchingText;
    const current = lastAssistant();
    if (current === null) return;
    const currentText = current.innerText;
    if (currentText !== expected) return; // it changed again — keep waiting
    if (streamingNow()) return;           // a new reply started
    const hash = await sha256(currentText);
    if (!seen.has(hash)) {
      seen.add(hash);
      console.log(`[relay-spike] assistant reply completed\nhash: ${hash}\n---\n${currentText}\n---`);
    }
  }, 1500);
}

new MutationObserver(() => checkCompletion()).observe(document.body, {
  childList: true, subtree: true, characterData: true,
});
void seedSeen();

// Manual test from the popup: type the test text into the composer.
// It must NOT press send — the user clicks Send (SPEC M0.2 step 4).
interface TestMessage { type?: string; text?: string; }
type SendResponse = (response: unknown) => void;

(chromeApi?.runtime as unknown as {
  onMessage: {
    addListener: (handler: (msg: TestMessage, sender: unknown, sendResponse: SendResponse) => void) => void;
  };
} | undefined)?.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'type-test-text' || typeof msg.text !== 'string') return;
  const composer = document.querySelector(SELECTORS.composer) as HTMLTextAreaElement | HTMLElement | null;
  if (composer === null) {
    sendResponse({ ok: false, error: 'composer not found on this page' });
    return;
  }
  composer.focus();
  if (composer instanceof HTMLTextAreaElement) {
    composer.value = msg.text;
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    document.execCommand('insertText', false, msg.text);
  }
  sendResponse({ ok: true, note: 'typed — Send is yours to click' });
});
