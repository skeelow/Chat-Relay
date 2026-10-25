// M4.3 — hermetic tests for relay/export.ts, the engine's pure Markdown
// builder: order and format, a body that contains triple backticks (the
// fence cannot be broken by the body), delivery lines, and the 5,000 cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportMarkdown, fenceFor, type ExportDelivery } from '../relay/export.ts';
import type { RelayMessage } from '../relay/store.ts';

const msg = (over: {
  id: string; source?: RelayMessage['source']; body?: string; hop?: number; createdAt?: string;
}): RelayMessage => ({
  source: 'astra', targets: [], contentHash: 'hash', body: 'body', hop: 0,
  createdAt: '2026-01-02T03:04:05.000Z', ...over,
});
const row = (messageId: string, target: string, status: string): ExportDelivery =>
  ({ messageId, target: target as ExportDelivery['target'], status: status as ExportDelivery['status'] });

test('exportMarkdown: heading, generation line, one section per message, oldest first', () => {
  const m1 = msg({ id: '01A', body: 'first message', hop: 0, createdAt: '2026-01-02T03:04:05.000Z' });
  const m2 = msg({ id: '01B', source: 'codex', body: 'second message', hop: 1, createdAt: '2026-01-02T03:05:05.000Z' });
  const markdown = exportMarkdown([m1, m2], [row('01A', 'codex', 'pending_approval'), row('01B', 'astra', 'delivered')],
    '2026-01-03T00:00:00.000Z');
  assert.ok(markdown.startsWith('# Relay Chat transcript\n'), 'the heading');
  assert.ok(markdown.includes('Generated 2026-01-03T00:00:00.000Z — 2 messages'),
    'the generation line carries the time and the count');
  assert.ok(!markdown.includes('export cap'), 'no cap note under the cap');
  const sections = markdown.split('\n').filter((line) => line.startsWith('### '));
  assert.deepEqual(sections, ['### Astra — 2026-01-02T03:04:05.000Z — hop 0', '### Codex — 2026-01-02T03:05:05.000Z — hop 1'],
    'oldest first, sender labels, ISO time, hop');
  assert.ok(markdown.indexOf('first message') < markdown.indexOf('second message'), 'bodies in order');
  assert.ok(markdown.includes('Delivery: codex pending_approval'), 'delivery lines');
  assert.ok(markdown.includes('Delivery: astra delivered'), 'one line per row');
});

test('exportMarkdown: the body goes in verbatim inside a fence it cannot break', () => {
  const fenced = '```js\nconsole.log("hi");\n```\nplain text after';
  const m1 = msg({ id: '01A', body: fenced, hop: 2 });
  const markdown = exportMarkdown([m1], [], '2026-01-02T03:04:05.000Z');
  assert.ok(markdown.includes(fenced), 'the body is verbatim');
  const lines = markdown.split('\n');
  const open = lines.indexOf('````'); // the fence is longer than any run in the body
  assert.equal(open > 0, true, 'a 4-backtick fence opens the body');
  assert.equal(lines[open + 1], '```js', 'the body fence line sits inside, verbatim');
  assert.equal(lines.filter((l) => l === '````').length, 2, 'exactly one open and one close');
  assert.equal(fenceFor('no backticks'), '```', 'a plain body gets a standard fence');
  assert.equal(fenceFor('```'), '````', 'a triple-backtick body forces a longer fence');
  assert.equal(fenceFor('`````'), '``````', 'even a five-backtick body is contained');
});

test('exportMarkdown: the 5,000 cap is marked at the top', () => {
  const many: RelayMessage[] = [];
  for (let i = 0; i < 5000; i++) {
    many.push(msg({ id: `id-${String(i).padStart(5, '0')}`, body: `m${i}`, createdAt: '2026-01-02T03:04:05.000Z' }));
  }
  const markdown = exportMarkdown(many, [], '2026-01-02T03:04:05.000Z');
  assert.ok(markdown.includes('Generated 2026-01-02T03:04:05.000Z — 5,000 messages — newest 5,000 only (export cap)'),
    'the cap note');
  assert.equal(markdown.split('\n').filter((l) => l.startsWith('### ')).length, 5000, 'every message still exported');
});
