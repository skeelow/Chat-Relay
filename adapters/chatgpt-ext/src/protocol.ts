// Relay Chat — shared pure logic for the astra (ChatGPT extension) adapter.
//
// Kept free of chrome/DOM imports so Node's test runner can exercise every
// decision directly (tests/chatgpt-ext.test.ts). The DOM-facing function
// (replyText) takes a narrow structural interface that both the real DOM
// and the test stub satisfy — the same trick the M0.2 spike used for the
// chrome API.

/** Adapter-reported statuses. 'selectors_stale' is m0.2 carry item 5:
 * chatgpt.com renames its DOM attributes regularly, and the adapter
 * reports the breakage to the engine instead of silently capturing
 * nothing. The engine added it to its valid status list in M1.4. */
export type AstraStatus = 'idle' | 'streaming' | 'selectors_stale';

/** SPEC relay header — the same regex the store applies on capture (relay/store.ts). */
const RELAY_HEADER = /^\[Relay ·/;

/**
 * SPEC: adapters must ignore any captured message whose first line is a
 * relay header (the AI may echo the text the relay injected). The store
 * applies the same rule on arrival; the adapter drops it earlier so it
 * never even queues.
 */
export function isRelayHeaderEcho(body: string): boolean {
  const firstLine = body.split('\n', 1)[0] ?? '';
  return RELAY_HEADER.test(firstLine);
}

/**
 * Per-tick page view → the status the adapter reports. Precedence: a
 * confirmed stale-selector state outranks everything (a page we cannot
 * read cannot stream anything we can see); otherwise any live signal (the
 * stop button, or a turn still marked in_progress) reads as streaming.
 */
export function pageStatus(view: {
  staleConfirmed: boolean;
  stopButtonPresent: boolean;
  anyTurnInProgress: boolean;
}): AstraStatus {
  if (view.staleConfirmed) return 'selectors_stale';
  if (view.stopButtonPresent || view.anyTurnInProgress) return 'streaming';
  return 'idle';
}

/**
 * F2 (review): the engine resets an adapter to `idle` on every hello, and
 * MV3 can restart the worker at any time — so the worker remembers the
 * latest status it was given (chrome.storage.session, owned by the
 * background script) and replays it after each successful hello.
 * Replaying `idle` is pointless: the engine already assumes it. The
 * decision is pure so Node can test it directly; takes `string | null`
 * because storage reads back untyped values.
 */
export function statusToReplayAfterHello(latest: string | null): string | null {
  return latest !== null && latest !== 'idle' ? latest : null;
}

// --- M3.1: the deliver path (typing into the composer, never sending) ---

/** The page facts a delivery depends on, gathered by the content script. */
export interface DeliveryPageView {
  composerFound: boolean;
  streaming: boolean;
  composerHasText: boolean;
}

/** The content script's decision for one delivery attempt. */
export interface DeliveryPageDecision {
  ok: boolean;
  /** Present when ok is false — the exact text the engine stores on the row. */
  error?: string;
  /** A missing composer is a selector rename, not a quiet page. */
  selectorsStale?: boolean;
}

/**
 * The page rules, in order (D10): a missing composer fails visibly and
 * reports stale selectors; a streaming page fails; a draft in the composer
 * fails — the publisher's unsent text is never touched. Only an empty,
 * idle composer is typed into.
 */
export function deliveryPageDecision(view: DeliveryPageView): DeliveryPageDecision {
  if (!view.composerFound) {
    return { ok: false, error: "ChatGPT's input box was not found (page changed?)", selectorsStale: true };
  }
  if (view.streaming) {
    return { ok: false, error: 'ChatGPT is still replying — wait, then forward again' };
  }
  if (view.composerHasText) {
    return { ok: false, error: "ChatGPT's input box already has text — send or clear it, then forward again" };
  }
  return { ok: true };
}

/**
 * Split the delivered text into lines for insertion. The content script
 * inserts each line with insertText and a line break between lines (never
 * Enter, which could submit). Blank lines and the header line are kept.
 */
export function linesForInsert(text: string): string[] {
  if (text === '') return []; // nothing to type
  return text.split('\n');
}

/** Whitespace-collapsed equality — how the typed text is verified after insertion. */
export function textsMatch(typed: string, expected: string): boolean {
  return typed.replace(/\s+/g, ' ').trim() === expected.replace(/\s+/g, ' ').trim();
}

// --- M6.4e (D36): the extension-clicks-Send switch ---

/** Rate safety, in one place: at most one auto-Send click per this many ms. */
export const AUTO_SEND_MIN_GAP_MS = 5000;

/**
 * The click decision, pure (tests/chatgpt-ext.test.ts runs every branch):
 * with the setting off there is no click at all — the human clicks Send,
 * exactly the old D10 behaviour. With it on the click happens, but never
 * sooner than AUTO_SEND_MIN_GAP_MS after the previous one: inside the gap
 * the plan defers (delayMs), it never drops the send silently.
 */
export function autoSendClickPlan(
  enabled: boolean, nowMs: number, lastClickMs: number | null,
): { click: boolean; delayMs: number } {
  if (!enabled) return { click: false, delayMs: 0 };
  const wait = lastClickMs === null ? 0 : AUTO_SEND_MIN_GAP_MS - (nowMs - lastClickMs);
  return { click: true, delayMs: wait > 0 ? wait : 0 };
}

/** The worker's tab choice (D10): deliver to the most recent sender tab. */
export interface DeliveryTabDecision {
  ok: boolean;
  tabId?: number;
  error?: string;
}

export function deliveryTabDecision(knownTabId: number | null): DeliveryTabDecision {
  if (knownTabId === null) {
    return {
      ok: false,
      error: 'no ChatGPT tab is known to the relay extension — open chatgpt.com and let it load',
    };
  }
  return { ok: true, tabId: knownTabId };
}

/**
 * Minimal structural view of a DOM element. The real HTMLElement satisfies
 * this (the content script casts it in); tests provide a small stub.
 */
export interface ReplyElement {
  cloneNode(deep: boolean): ReplyElement;
  querySelectorAll(selector: string): ReplyElement[];
  readonly previousElementSibling: ReplyElement | null;
  remove(): void;
  readonly innerText: string;
}

/**
 * The text a completed reply reports (m0.2 carry item 1): the reply
 * body's innerText with the code-block header bars removed. chatgpt.com
 * renders each code block as a header element (language label + buttons
 * like Run / Copy code) followed by a <pre>, and the whole reply's
 * innerText includes those labels as stray lines. Structural rule instead
 * of a fragile extra selector: the element immediately before a <pre>
 * that contains a button (and no <pre> of its own) is a header bar.
 * Buttons are dropped everywhere — their labels are never reply content.
 * All removals happen on a clone; the live element is untouched.
 *
 * F1 (review, verified in real Chrome): innerText is only laid out for
 * ATTACHED elements — a detached clone's innerText falls back to flat
 * textContent and every paragraph, list and <br> break vanishes. So the
 * clone must be mounted before the read. The mount is injected
 * (mount(el) → unmount) to keep this module free of DOM calls; the
 * content script supplies the offscreen mount, tests supply a stub, and
 * the unmount always runs, even when the read throws.
 */
export function replyText(reply: ReplyElement, mount: (el: ReplyElement) => () => void): string {
  const clone = reply.cloneNode(true);
  // Collect header candidates from the intact clone first — removing one
  // must not change what sits before the next <pre> (consecutive blocks).
  const headers: ReplyElement[] = [];
  for (const pre of clone.querySelectorAll('pre')) {
    const candidate = pre.previousElementSibling;
    if (candidate !== null &&
        candidate.querySelectorAll('button').length > 0 &&
        candidate.querySelectorAll('pre').length === 0) {
      headers.push(candidate);
    }
  }
  for (const header of headers) header.remove();
  for (const button of clone.querySelectorAll('button')) button.remove();
  const unmount = mount(clone);
  try {
    return clone.innerText;
  } finally {
    unmount();
  }
}
