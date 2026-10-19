// Relay Chat — astra adapter, content script (M1.4). Turns the M0.2 spike
// into the read-only ChatGPT side of the relay: it detects completed
// replies exactly as the spike did (witnessed streaming + stop button
// gone + turn complete + 1.5s stable text) and reports them to the engine
// through the service worker. It never sends anything into ChatGPT —
// typing the test prompt (popup) waits for the user to click Send, per
// the SPEC.
//
// Carry items applied (docs/status/m0.2.md):
//   1. Code-block header labels are stripped before reporting (replyText).
//   2. The "no turns found" warning waits STALE_DELAY_MS — it fired as a
//      false alarm before ChatGPT drew the chat.
//   3. Debug logs are off by default; the startup line stays.
//   5. A still-turnless conversation page after the delay reports
//      'selectors_stale' to the engine as a status, not just the console.
import { SELECTORS } from './selectors.ts';
import { pageStatus, replyText, type AstraStatus, type ReplyElement } from './protocol.ts';

// Bump this marker on every build so the console shows which version runs.
const BUILD_MARKER = '2026-10-19.2';
console.log('[relay-astra] content script loaded', BUILD_MARKER);

// Debug logging is off by default (carry item 3); flip to true to trace
// every decision point in checkCompletion/onStableText like the M0.2 run.
const DEBUG = false;

function debug(...parts: unknown[]): void {
  if (DEBUG) console.log('[relay-astra]', ...parts);
}

let lastReason = '';
/** Log a decision reason once per change, so hot ticks don't flood the console. */
function debugReason(reason: string): void {
  if (!DEBUG || reason === lastReason) return;
  lastReason = reason;
  console.log('[relay-astra]', reason);
}

// --- minimal chrome API view (same structural-typing trick as the spike) ---

type SendResponse = (response: unknown) => void;
interface TestMessage { type?: string; text?: string; }
interface ChromeRuntime {
  runtime: {
    onMessage: {
      addListener: (handler: (msg: TestMessage, sender: unknown, sendResponse: SendResponse) => void) => void;
    };
    sendMessage: (msg: unknown) => Promise<unknown>;
  };
}
const chromeApi = (globalThis as unknown as { chrome?: ChromeRuntime }).chrome;

// --- page reading (every selector/attribute lives in selectors.ts) ---

const seen = new Set<string>();        // reply ids already reported
const witnessed = new Set<string>();  // reply ids seen streaming this page session
let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
let watchingId = '';                   // the reply the stability watch belongs to
let watchingText = '';

// Stale-selector state (carry items 2 + 5): a conversation page with zero
// turns for STALE_DELAY_MS warns once and reports 'selectors_stale'.
const STALE_DELAY_MS = 5000;
let staleTimer: ReturnType<typeof setTimeout> | null = null;
let staleConfirmed = false;

// Status reporting: send to the service worker only on change; a failed
// send leaves lastStatus untouched so the next tick retries it.
let lastStatus: AstraStatus | null = null;

/**
 * F1 (review): innerText is only laid out for attached elements, so the
 * clone replyText strips must be mounted for the read. Fixed offscreen
 * style — never display:none or visibility:hidden, both defeat innerText.
 * Passed in so protocol.ts stays free of DOM calls; replyText always
 * unmounts via the returned callback, even when the read throws.
 */
function mountOffscreen(el: ReplyElement): () => void {
  const node = el as unknown as HTMLElement;
  node.style.position = 'fixed';
  node.style.left = '-100000px';
  node.style.top = '0';
  document.body.appendChild(node);
  return () => { node.remove(); };
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
  return el.getAttribute(SELECTORS.replyIdAttribute) ?? '';
}

function onConversationUrl(): boolean {
  return /^\/(c|g)\//.test(location.pathname);
}

function sendWithTimeout(msg: unknown, timeoutMs: number): Promise<unknown> {
  if (chromeApi === undefined) return Promise.reject(new Error('no chrome runtime'));
  return Promise.race([
    chromeApi.runtime.sendMessage(msg),
    new Promise((_, reject) => setTimeout(() => reject(new Error('send timed out')), timeoutMs)),
  ]);
}

function reportStatus(status: AstraStatus): void {
  if (status === lastStatus || chromeApi === undefined) return;
  sendWithTimeout({ type: 'status', status }, 3000).then(
    () => { lastStatus = status; },
    () => { debug('status send failed (service worker restarting?) — will retry on change'); },
  );
}

function onStaleConfirmed(): void {
  staleTimer = null;
  staleConfirmed = true;
  console.warn(`[relay-astra] WARNING: no turns found after ${STALE_DELAY_MS / 1000}s, selectors may be stale — reporting to the engine`);
  reportStatus('selectors_stale');
}

function checkCompletion(): void {
  const allTurns = turns();

  // Carry item 2: arm the stale warning only after the delay — the page
  // legitimately shows zero turns for a moment while ChatGPT draws the chat.
  if (onConversationUrl() && allTurns.length === 0 && staleTimer === null && !staleConfirmed) {
    staleTimer = setTimeout(onStaleConfirmed, STALE_DELAY_MS);
  } else if (allTurns.length > 0 && staleTimer !== null) {
    clearTimeout(staleTimer);
    staleTimer = null;
  }
  // Selectors work again (usually after a reload with fresh ones): recover.
  if (allTurns.length > 0 && staleConfirmed) staleConfirmed = false;

  reportStatus(pageStatus({
    staleConfirmed,
    stopButtonPresent: streamingNow(),
    anyTurnInProgress: allTurns.some(
      (turn) => turn.getAttribute(SELECTORS.turnStateAttribute) === 'in_progress'),
  }));

  // Witness everything that is streaming right now.
  for (const turn of allTurns) {
    if (turn.getAttribute(SELECTORS.turnStateAttribute) === 'in_progress') {
      const replies = turn.querySelectorAll<HTMLElement>(SELECTORS.replyBody);
      const last = replies.length > 0 ? replies[replies.length - 1] : null;
      if (last !== null && messageId(last) !== '') {
        if (!witnessed.has(messageId(last))) debug('witnessed (turn in_progress):', messageId(last));
        witnessed.add(messageId(last));
      }
    }
  }
  if (streamingNow()) {
    const last = lastReply();
    if (last !== null && messageId(last) !== '' && !witnessed.has(messageId(last))) {
      debug('witnessed (stop button):', messageId(last));
      witnessed.add(messageId(last));
    }
    debugReason('tick skipped: reply is streaming (stop button present)');
    return; // still streaming: never report mid-stream
  }

  const reply = lastReply();
  if (reply === null) { debugReason('tick skipped: no reply body on the page'); return; }
  const id = messageId(reply);
  if (id === '') { debugReason('tick skipped: reply has no reply id attribute'); return; }
  if (!witnessed.has(id)) { debugReason(`tick skipped: ${id} was not witnessed streaming this session`); return; }
  if (seen.has(id)) { debugReason(`tick skipped: ${id} was already reported`); return; }

  // A different reply always starts a fresh watch cycle, even when its text is
  // identical to the previous one — keying on the message id is what lets a
  // second "PONG" through (a text-only guard silently undid the message-id fix).
  if (id !== watchingId) {
    watchingId = id;
    watchingText = '';
    debug('watching reply:', id);
  }
  const text = reply.innerText;
  if (text === watchingText) { debugReason('tick skipped: text unchanged (stability timer is running)'); return; }
  watchingText = text;
  if (stabilityTimer !== null) clearTimeout(stabilityTimer);
  stabilityTimer = setTimeout(onStableText, 1500);
  debug('timer armed for', id, '(1.5s stability window)');
}

function onStableText(): void {
  debug('timer fired; watching:', watchingId);
  const id = watchingId;
  const expected = watchingText;
  const current = lastReply();
  if (current === null) { debug('timer: no reply body — nothing to report'); return; }
  if (messageId(current) !== id) { debug('timer: last reply changed to', messageId(current), '— standing down'); return; }
  if (current.innerText !== expected) { debug('timer: text changed again — the tick rescheduled us'); return; }
  if (streamingNow()) { debug('timer: a new reply is streaming — standing down'); return; }
  const currentTurns = turns();
  const state = currentTurns.length > 0
    ? currentTurns[currentTurns.length - 1].getAttribute(SELECTORS.turnStateAttribute)
    : null;
  debug('turn state:', state);
  if (state !== 'complete') {
    // The turn is marked complete a moment late: keep waiting instead of
    // silently dropping the reply — re-check after another stability window.
    debug('turn not complete — re-arming the timer');
    stabilityTimer = setTimeout(onStableText, 1500);
    return;
  }
  seen.add(id);
  watchingId = '';   // fresh cycle: the next reply reports even with identical text
  watchingText = '';
  debug('reporting reply:', id);
  const body = replyText(current as unknown as ReplyElement, mountOffscreen); // carry item 1 + F1
  void deliverCapture(body, id);
}

// --- delivery to the service worker (which owns the engine socket) ---

const DELIVERY_ATTEMPTS = 15;     // bounded: roughly 45s of outage tolerated
const DELIVERY_TIMEOUT_MS = 3000;
const DELIVERY_RETRY_MS = 2000;

/**
 * Best-effort, at-least-once handoff to the service worker. The worker
 * queues captures while the engine socket is down and the store dedupes by
 * sourceRef, so a duplicate after a worker death is safe. Giving up only
 * means the delivery was unconfirmed — the worker may still have it
 * queued for the next successful connect.
 */
async function deliverCapture(body: string, sourceRef: string): Promise<void> {
  if (body.trim().length === 0) {
    console.warn('[relay-astra] reply was empty after stripping — not reported');
    return;
  }
  for (let attempt = 1; attempt <= DELIVERY_ATTEMPTS; attempt++) {
    try {
      const res = (await sendWithTimeout(
        { type: 'captured', body, sourceRef }, DELIVERY_TIMEOUT_MS,
      )) as { ok?: boolean; sent?: boolean; dropped?: string; error?: string };
      if (res?.ok === true) {
        if (res.dropped !== undefined) {
          debug(`capture ${sourceRef} dropped by the worker (${res.dropped})`);
        } else {
          console.log(`[relay-astra] reply reported to the engine (message-id ${sourceRef})`);
        }
        return;
      }
      debug('worker refused the capture:', res?.error ?? 'unknown');
    } catch (err) {
      debug(`capture attempt ${attempt} failed:`, String(err));
    }
    if (attempt < DELIVERY_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, DELIVERY_RETRY_MS));
    }
  }
  console.error(`[relay-astra] could not confirm delivery of ${sourceRef} to the engine — is the relay engine running? (the service worker may still deliver it once the engine returns)`);
}

new MutationObserver(() => checkCompletion()).observe(document.body, {
  childList: true, subtree: true, characterData: true,
  attributes: true, attributeFilter: [SELECTORS.turnStateAttribute],
});
checkCompletion();

// Manual test from the popup: type the test text into the composer.
// It must NOT press send — the user clicks Send (SPEC M0.2 step 4).
chromeApi?.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'type-test-text' || typeof msg.text !== 'string') return;
  debug('popup asked to type the test text');
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
