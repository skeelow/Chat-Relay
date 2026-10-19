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
 */
export function replyText(reply: ReplyElement): string {
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
  return clone.innerText;
}
