// M1.4 — hermetic tests for the astra (ChatGPT extension) adapter's pure
// logic: the relay-header echo guard, the page-status precedence, and the
// code-block header stripping (m0.2 carry items 1 and 5). The live
// pipeline — engine + extension + a logged-in chatgpt.com tab — is
// exercised by the manual smoke run in docs/status/m1.4.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRelayHeaderEcho,
  pageStatus,
  replyText,
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
 */
class FakeElement implements ReplyElement {
  readonly tag: string;
  private readonly ownText: string;
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;

  constructor(tag: string, ownText = '') {
    this.tag = tag;
    this.ownText = ownText;
  }

  add(...kids: FakeElement[]): this {
    for (const kid of kids) { kid.parent = this; this.children.push(kid); }
    return this;
  }

  get previousElementSibling(): FakeElement | null {
    if (this.parent === null) return null;
    const index = this.parent.children.indexOf(this);
    return index > 0 ? this.parent.children[index - 1] : null;
  }

  cloneNode(deep: boolean): FakeElement {
    const clone = new FakeElement(this.tag, this.ownText);
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

  /** Approximates innerText: block-level elements start on a new line. */
  get innerText(): string {
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

test('code-block header labels are stripped; prose and code survive intact', () => {
  const text = replyText(replyWithCodeBlock());
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
  const text = replyText(reply);
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
  const text = replyText(reply);
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
  const text = replyText(reply);
  assert.ok(text.includes('ls -la') && text.includes('x = 2'), 'both code blocks survive');
  assert.ok(!text.includes('bash') && !text.includes('python') && !text.includes('Run'),
    'both header bars are stripped');
});

test('stripping never mutates the live reply element', () => {
  const reply = replyWithCodeBlock();
  const before = reply.innerText;
  replyText(reply);
  assert.equal(reply.innerText, before, 'all removals happen on the clone');
});
