// M1.4 — hermetic tests for the astra (ChatGPT extension) adapter's pure
// logic: the relay-header echo guard, the page-status precedence, and the
// code-block header stripping (m0.2 carry items 1 and 5). The live
// pipeline — engine + extension + a logged-in chatgpt.com tab — is
// exercised by the manual smoke run in docs/status/m1.4.md.
//
// M1.4-fixes F1 — the review proved in real Chrome that innerText on a
// DETACHED element falls back to flat textContent (every paragraph, list
// and <br> break vanishes). The stub now models that rule, and replyText
// must mount the clone (via the injected mount) for the read — the same
// thing the content script does offscreen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  autoSendClickPlan,
  AUTO_SEND_MIN_GAP_MS,
  deliveryPageDecision,
  deliveryTabDecision,
  isRelayHeaderEcho,
  linesForInsert,
  pageStatus,
  replyText,
  statusToReplayAfterHello,
  textsMatch,
  type ReplyElement,
} from '../adapters/chatgpt-ext/src/protocol.ts';

// --- isRelayHeaderEcho (SPEC relay header) ---

test('a capture whose first line is a relay header is an echo and is dropped', () => {
  assert.equal(isRelayHeaderEcho('[Relay · from Codex · #01JA8 · hop 1]\nsure, here you go'), true);
  assert.equal(isRelayHeaderEcho('[Relay · test] Reply with PONG.'), true);
});

test('ordinary replies are not echoes; only the first line counts', () => {
  assert.equal(isRelayHeaderEcho('PONG'), false);
  assert.equal(isRelayHeaderEcho('Here is the code:\n[Relay-ish] not really'), false);
  assert.equal(isRelayHeaderEcho('x\n[Relay · from Codex · #01JA8 · hop 1]'), false,
    'a header on a later line is part of the reply, not an echo');
  assert.equal(isRelayHeaderEcho(''), false);
});

// --- pageStatus (precedence: selectors_stale > streaming > idle) ---

test('a confirmed stale page outranks live signals; live signals read as streaming', () => {
  assert.equal(
    pageStatus({ staleConfirmed: true, stopButtonPresent: true, anyTurnInProgress: true }),
    'selectors_stale');
  assert.equal(
    pageStatus({ staleConfirmed: false, stopButtonPresent: true, anyTurnInProgress: false }),
    'streaming');
  assert.equal(
    pageStatus({ staleConfirmed: false, stopButtonPresent: false, anyTurnInProgress: true }),
    'streaming');
  assert.equal(
    pageStatus({ staleConfirmed: false, stopButtonPresent: false, anyTurnInProgress: false }),
    'idle');
});

// --- replyText (carry item 1: strip code-block header labels) ---

/**
 * Minimal DOM stub implementing exactly the ReplyElement interface — the
 * same structural-typing trick the adapter uses for the real HTMLElement.
 *
 * F1: it models the real browser rule the review proved — an element
 * attached to the document reads laid-out innerText (block boundaries
 * become newlines); a DETACHED element has no layout, so its innerText
 * falls back to flat textContent.
 */
class FakeElement implements ReplyElement {
  readonly tag: string;
  private readonly ownText: string;
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  isRoot = false;         // the fake document root — attachment stops here
  throwsOnRead = false;   // test hook: the innerText getter throws

  constructor(tag: string, ownText = '') {
    this.tag = tag;
    this.ownText = ownText;
  }

  add(...kids: FakeElement[]): this {
    for (const kid of kids) { kid.parent = this; this.children.push(kid); }
    return this;
  }

  /** True when an ancestor chain reaches the fake document root. */
  private isAttached(): boolean {
    let cur: FakeElement | null = this;
    while (cur !== null) {
      if (cur.isRoot) return true;
      cur = cur.parent;
    }
    return false;
  }

  /** No layout, no line breaks — what textContent gives a detached node. */
  private flatText(): string {
    const parts: string[] = [this.ownText];
    const walk = (el: FakeElement): void => {
      for (const kid of el.children) { parts.push(kid.ownText); walk(kid); }
    };
    walk(this);
    return parts.join('');
  }

  get previousElementSibling(): FakeElement | null {
    if (this.parent === null) return null;
    const index = this.parent.children.indexOf(this);
    return index > 0 ? this.parent.children[index - 1] : null;
  }

  cloneNode(deep: boolean): FakeElement {
    const clone = new FakeElement(this.tag, this.ownText);
    clone.throwsOnRead = this.throwsOnRead;
    if (deep) {
      for (const kid of this.children) clone.add(kid.cloneNode(true) as FakeElement);
    }
    return clone;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const want = selector.toLowerCase();
    const found: FakeElement[] = [];
    const walk = (el: FakeElement): void => {
      for (const kid of el.children) {
        if (kid.tag === want) found.push(kid);
        walk(kid);
      }
    };
    walk(this);
    return found;
  }

  remove(): void {
    if (this.parent === null) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }

  get innerText(): string {
    // Like a real page read gone wrong: the throw only happens once the
    // element is attached — a detached read just returns flat text.
    if (this.throwsOnRead && this.isAttached()) throw new Error('boom');
    if (!this.isAttached()) return this.flatText();
    // Attached: approximate layout — block-level elements start on a new line.
    const blocks = new Set(['p', 'div', 'pre', 'button', 'li', 'ul', 'ol', 'h1', 'h2', 'h3']);
    const parts: string[] = [];
    for (const kid of this.children) {
      parts.push(blocks.has(kid.tag) ? `\n${kid.innerText}\n` : kid.innerText);
    }
    return `${this.ownText}${parts.join('')}`.replace(/\n{3,}/g, '\n\n').trim();
  }
}

/** The shape chatgpt.com renders for prose + one code block:
 *  p, header bar (language label + buttons), pre>code, p. */
function replyWithCodeBlock(): FakeElement {
  const reply = new FakeElement('div');
  const intro = new FakeElement('p', 'Here is the code:');
  const header = new FakeElement('div', 'python');
  header.add(new FakeElement('button', 'Run'), new FakeElement('button', 'Copy code'));
  const pre = new FakeElement('pre');
  pre.add(new FakeElement('code', 'x = 1\nprint(x)'));
  const outro = new FakeElement('p', 'Done.');
  reply.add(intro, header, pre, outro);
  return reply;
}

/** The fake document the mount attaches clones to — content.ts's document.body. */
const fakeDoc = new FakeElement('#document');
fakeDoc.isRoot = true;

/** A mount like the content script's offscreen one: attach, return unmount. */
function attachMount(el: ReplyElement): () => void {
  const node = el as FakeElement;
  fakeDoc.add(node);
  return () => { node.remove(); };
}

// --- F1: the stub models the real browser (detached innerText is flat) ---

test('a detached element reads flat text, the way real browsers do', () => {
  const el = new FakeElement('div');
  el.add(new FakeElement('p', 'First paragraph.'), new FakeElement('p', 'Second paragraph.'));
  assert.equal(el.innerText, 'First paragraph.Second paragraph.',
    'no layout, no line breaks — innerText falls back to textContent');
});

test('an element attached to the document reads laid-out text with breaks', () => {
  const el = new FakeElement('div');
  el.add(new FakeElement('p', 'First paragraph.'), new FakeElement('p', 'Second paragraph.'));
  fakeDoc.add(el);
  try {
    assert.ok(el.innerText.includes('First paragraph.\n\nSecond paragraph.'),
      'block boundaries become newlines once the element has layout');
  } finally {
    el.remove();
  }
});

// --- F1: replyText must read the clone while it is mounted ---

test('replyText reads the clone while it is mounted, so paragraph and list breaks survive', () => {
  const reply = new FakeElement('div');
  reply.add(new FakeElement('p', 'First paragraph.'), new FakeElement('p', 'Second paragraph.'));
  const list = new FakeElement('ul');
  list.add(new FakeElement('li', 'one'), new FakeElement('li', 'two'));
  reply.add(list);
  let mounted = 0;
  let unmounted = 0;
  const text = replyText(reply, (el) => {
    mounted += 1;
    fakeDoc.add(el as FakeElement);
    return () => { unmounted += 1; (el as FakeElement).remove(); };
  });
  assert.equal(mounted, 1, 'the clone is mounted exactly once, for the read');
  assert.equal(unmounted, 1, 'the clone is unmounted afterwards');
  assert.equal(fakeDoc.children.length, 0, 'nothing stays attached to the fake document');
  assert.ok(text.includes('First paragraph.\n\nSecond paragraph.'), 'paragraph breaks survive');
  assert.ok(/one\n+two/.test(text), 'list lines survive');
  assert.ok(!text.includes('First paragraph.Second paragraph.'),
    'the text was read while mounted — a detached read would be flat');
});

test('replyText unmounts the clone even when reading the text throws', () => {
  const reply = new FakeElement('div');
  reply.add(new FakeElement('p', 'boom'));
  reply.throwsOnRead = true; // the clone copies the flag
  assert.throws(() => replyText(reply, attachMount), /boom/);
  assert.equal(fakeDoc.children.length, 0, 'the finally unmounts even on the throwing path');
});

// --- F2: what the worker replays after hello (pure decision) ---

test('after hello, a remembered non-idle status is replayed', () => {
  assert.equal(statusToReplayAfterHello('selectors_stale'), 'selectors_stale');
  assert.equal(statusToReplayAfterHello('streaming'), 'streaming');
});

test('idle and nothing-remembered are not replayed — the engine already assumes idle on hello', () => {
  assert.equal(statusToReplayAfterHello('idle'), null);
  assert.equal(statusToReplayAfterHello(null), null);
});

// --- header stripping (carry item 1, now through the mount) ---

test('code-block header labels are stripped; prose and code survive intact', () => {
  const text = replyText(replyWithCodeBlock(), attachMount);
  assert.ok(text.includes('Here is the code:'), 'prose before the block survives');
  assert.ok(text.includes('x = 1\nprint(x)'), 'the code block survives line for line');
  assert.ok(text.includes('Done.'), 'prose after the block survives');
  assert.ok(!text.includes('python'), 'the language label is stripped');
  assert.ok(!text.includes('Run'), 'the header Run label is stripped');
  assert.ok(!text.includes('Copy code'), 'the header Copy label is stripped');
});

test('a paragraph directly before a pre is kept (no false header)', () => {
  // No header bar in this markup — the paragraph has no button, so the
  // structural rule must NOT mistake it for a header.
  const reply = new FakeElement('div');
  reply.add(new FakeElement('p', 'inline example:'), new FakeElement('pre', 'const a = 1;'));
  const text = replyText(reply, attachMount);
  assert.ok(text.includes('inline example:'));
  assert.ok(text.includes('const a = 1;'));
});

test('a header candidate containing its own pre is never stripped', () => {
  // An element that sits right before a pre AND holds a code block of its
  // own is a wrapper, not a header bar — only its button is dropped.
  const reply = new FakeElement('div');
  const wrapper = new FakeElement('div');
  wrapper.add(new FakeElement('button', 'Copy'), new FakeElement('pre', 'keep this code'));
  const tail = new FakeElement('pre', 'tail code');
  reply.add(wrapper, tail);
  const text = replyText(reply, attachMount);
  assert.ok(text.includes('keep this code'), 'the wrapper was not mistaken for a header bar');
  assert.ok(text.includes('tail code'));
  assert.ok(!text.includes('Copy'), 'standalone buttons are still dropped');
});

test('consecutive code blocks each lose their own header', () => {
  // Collecting all header candidates BEFORE any removal keeps the second
  // block's lookup stable (pre1's removal must not make pre1 itself the
  // element that sits before pre2).
  const reply = new FakeElement('div');
  const h1 = new FakeElement('div', 'bash');
  h1.add(new FakeElement('button', 'Run'));
  const p1 = new FakeElement('pre', 'ls -la');
  const h2 = new FakeElement('div', 'python');
  h2.add(new FakeElement('button', 'Run'));
  const p2 = new FakeElement('pre', 'x = 2');
  reply.add(h1, p1, h2, p2);
  const text = replyText(reply, attachMount);
  assert.ok(text.includes('ls -la') && text.includes('x = 2'), 'both code blocks survive');
  assert.ok(!text.includes('bash') && !text.includes('python') && !text.includes('Run'),
    'both header bars are stripped');
});

test('stripping never mutates the live reply element', () => {
  const reply = replyWithCodeBlock();
  const before = reply.innerText;
  replyText(reply, attachMount);
  assert.equal(reply.innerText, before, 'all removals happen on the clone');
});

// --- M3.1: the deliver path (typing, never sending) ---

test('deliveryPageDecision: the page rules in order — missing composer, streaming, draft, ok', () => {
  assert.deepEqual(
    deliveryPageDecision({ composerFound: false, streaming: false, composerHasText: false }),
    { ok: false, error: "ChatGPT's input box was not found (page changed?)", selectorsStale: true },
    'a missing composer is a stale-selector report, not a silent failure');
  assert.deepEqual(
    deliveryPageDecision({ composerFound: true, streaming: true, composerHasText: false }),
    { ok: false, error: 'ChatGPT is still replying — wait, then forward again' });
  assert.deepEqual(
    deliveryPageDecision({ composerFound: true, streaming: false, composerHasText: true }),
    { ok: false, error: "ChatGPT's input box already has text — send or clear it, then forward again" },
    'the publisher draft is never touched');
  assert.deepEqual(
    deliveryPageDecision({ composerFound: true, streaming: false, composerHasText: false }),
    { ok: true });
});

test('linesForInsert: splits on newlines, keeping blank lines and the header line', () => {
  assert.deepEqual(linesForInsert('[Relay · from Codex · #01H · hop 1]\nfirst\n\nsecond'), [
    '[Relay · from Codex · #01H · hop 1]', 'first', '', 'second',
  ]);
  assert.deepEqual(linesForInsert('single line'), ['single line']);
  assert.deepEqual(linesForInsert(''), []);
});

test('textsMatch: whitespace-collapsed comparison, and a real mismatch fails', () => {
  assert.equal(textsMatch('a  b\nc', 'a b c'), true, 'collapsed whitespace compares equal');
  assert.equal(textsMatch('  [Relay · header]\nline one\n\nline two  ', '[Relay · header] line one line two'), true);
  assert.equal(textsMatch('typed something else', 'expected text'), false);
});

test('deliveryTabDecision: the latest sender tab wins; no known tab fails at once', () => {
  assert.deepEqual(deliveryTabDecision(42), { ok: true, tabId: 42 });
  const none = deliveryTabDecision(null);
  assert.equal(none.ok, false);
  assert.ok((none.error ?? '').length > 0, 'the no-tab failure carries an actionable error');
});

// M6.4e (D36) replaced the M3.1/D10 "never presses Send" guard with the
// rule the publisher chose: the Send click happens ONLY when the engine's
// extension-clicks-Send setting is on, on an empty composer, at most once
// per minimum gap — and the old never-submit/never-keyboard rules stand.

test('M6.4e autoSendClickPlan: no click with the setting off; a click when on; a 5 s minimum gap between clicks', () => {
  assert.equal(AUTO_SEND_MIN_GAP_MS, 5000, 'the constant: at most one auto-send per 5 s, in one place');
  assert.deepEqual(autoSendClickPlan(false, 100000, null), { click: false, delayMs: 0 });
  assert.deepEqual(autoSendClickPlan(false, 100000, 0), { click: false, delayMs: 0 },
    'off is off whatever the clock says');
  assert.deepEqual(autoSendClickPlan(true, 100000, null), { click: true, delayMs: 0 },
    'on with no previous click: click now');
  assert.deepEqual(autoSendClickPlan(true, 100000, 50000), { click: true, delayMs: 0 },
    'older than the gap: click now');
  assert.equal(autoSendClickPlan(true, 100000, 95000).delayMs, 0, 'exactly the gap elapsed: click now');
  const gated = autoSendClickPlan(true, 100000, 97000);
  assert.equal(gated.click, true, 'the click is only delayed, never dropped');
  assert.equal(gated.delayMs, AUTO_SEND_MIN_GAP_MS - 3000, 'inside the gap: wait out the remainder');
});

test('M6.4e D36 guard: the Send click happens only when the setting is on', () => {
  const srcDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'adapters', 'chatgpt-ext', 'src');
  for (const file of ['content.ts', 'background.ts', 'popup.ts', 'options.ts', 'protocol.ts', 'selectors.ts']) {
    const src = readFileSync(join(srcDir, file), 'utf8');
    // The old never-submit rules stand unchanged (D10 carried over).
    assert.ok(!src.includes('requestSubmit'), `${file} must not submit the form`);
    assert.ok(!/\.submit\(/.test(src), `${file} must not submit the form`);
    assert.ok(!/new KeyboardEvent/.test(src), `${file} must not dispatch keyboard events (Enter could submit)`);
    if (file !== 'content.ts') {
      assert.ok(!/sendButton[\s\S]{0,120}?\.click\(/.test(src), `${file} must not click the send button`);
    }
  }
  // The worker only schedules the click through the plan, and never when the
  // engine config left the switch off: the click message ('click-send') is
  // dispatched only after autoSendClickPlan(...).click — there is exactly one
  // such dispatch site in the worker source.
  const bg = readFileSync(join(srcDir, 'background.ts'), 'utf8');
  assert.equal(bg.split("'click-send'").length - 1, 1, 'the worker sends click-send from exactly one place');
  assert.match(bg, /autoSendClickPlan/, 'that place plans through the pure gate');
  assert.match(bg, /if \(plan\.click\)/, 'and only clicks when the plan says so');
  assert.match(bg, /extClicksSend === true/, 'the switch arrives from the engine config');
  // In the content script the click lives in the click-send handler, never
  // in the type path (typing alone still sends nothing).
  const content = readFileSync(join(srcDir, 'content.ts'), 'utf8');
  const clickIdx = content.search(/sendButton[\s\S]{0,120}?\.click\(/);
  const typeIdx = content.indexOf('function typeRelayText');
  assert.ok(clickIdx >= 0, 'content.ts clicks the send button somewhere');
  assert.ok(typeIdx >= 0);
  assert.ok(clickIdx < typeIdx, 'the click is in the click-send handler, not the type path');
  assert.equal(content.split('.click(').length - 1, 1, 'content.ts clicks exactly one thing — the send button');
});
