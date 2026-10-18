// M0.2 spike — content script. Logging only; it sends nothing (no network, no storage).
//
// A reply is logged only when it was WITNESSED STREAMING during this page session —
// its turn carried data-talvt-turn-state="in_progress", or the stop button was present —
// and then ALL of: the stop button is gone, the turn state is "complete", and the reply
// text has not changed for 1.5 seconds. Replies that merely appear (reload, sidebar
// conversation switch) were never seen streaming and are never logged.
// Replies are tracked by data-dil-message-id so identical texts each log; the sha256 in
// the log line is the fingerprint the SPEC asks for.
import { SELECTORS } from './selectors.ts';

interface TestMessage { type?: string; text?: string; }
type SendResponse = (response: unknown) => void;

interface ChromeRuntime {
  runtime: {
    onMessage: {
      addListener: (handler: (msg: TestMessage, sender: unknown, sendResponse: SendResponse) => void) => void;
    };
  };
}
const chromeApi = (globalThis as unknown as { chrome?: ChromeRuntime }).chrome;

const seen = new Set<string>();        // data-dil-message-ids already logged
const witnessed = new Set<string>();   // message-ids seen streaming this page session
let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
let watchingText = '';
let warnedNoTurns = false;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function turns(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(SELECTORS.turn)];
}

function replyBodies(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(SELECTORS.replyBody)];
}

function lastReply(): HTMLElement | null {
  const all = replyBodies();
  return all.length > 0 ? all[all.length - 1] : null;
}

function streamingNow(): boolean {
  return document.querySelector(SELECTORS.stopButton) !== null;
}

function messageId(el: HTMLElement): string {
  return el.getAttribute('data-dil-message-id') ?? '';
}

function onConversationUrl(): boolean {
  return /^\/(c|g)\//.test(location.pathname);
}

function checkCompletion(): void {
  const allTurns = turns();

  // Fail loudly when the page changes under us: a conversation page must contain turns.
  if (!warnedNoTurns && onConversationUrl() && allTurns.length === 0) {
    warnedNoTurns = true;
    console.warn('[relay-spike] WARNING: no turns found, selectors may be stale');
  }

  // Witness everything that is streaming right now.
  for (const turn of allTurns) {
    if (turn.getAttribute('data-talvt-turn-state') === 'in_progress') {
      const replies = turn.querySelectorAll<HTMLElement>(SELECTORS.replyBody);
      const last = replies.length > 0 ? replies[replies.length - 1] : null;
      if (last !== null && messageId(last) !== '') witnessed.add(messageId(last));
    }
  }
  if (streamingNow()) {
    const last = lastReply();
    if (last !== null && messageId(last) !== '') witnessed.add(messageId(last));
    return; // still streaming: never log mid-stream
  }

  const reply = lastReply();
  if (reply === null) return;
  const id = messageId(reply);
  if (id === '' || !witnessed.has(id) || seen.has(id)) return;

  const text = reply.innerText;
  if (text === watchingText) return; // unchanged since the last tick
  watchingText = text;
  if (stabilityTimer !== null) clearTimeout(stabilityTimer);
  stabilityTimer = setTimeout(async () => {
    const expected = watchingText;
    const current = lastReply();
    if (current === null || messageId(current) !== id) return;
    if (current.innerText !== expected) return; // it changed again — keep waiting
    if (streamingNow()) return;                 // a new reply started
    const currentTurns = turns();
    const state = currentTurns.length > 0
      ? currentTurns[currentTurns.length - 1].getAttribute('data-talvt-turn-state')
      : null;
    if (state !== 'complete') return;           // turn not finished
    const hash = await sha256(current.innerText);
    seen.add(id);
    console.log(`[relay-spike] assistant reply completed (message-id: ${id})\nhash: ${hash}\n---\n${current.innerText}\n---`);
  }, 1500);
}

new MutationObserver(() => checkCompletion()).observe(document.body, {
  childList: true, subtree: true, characterData: true,
});
checkCompletion();

// Manual test from the popup: type the test text into the composer.
// It must NOT press send — the user clicks Send (SPEC M0.2 step 4).
chromeApi?.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
