// M6.3a — hermetic tests for the GUI's pure Hermes logic
// (app/src/compose.ts, app/src/deliveries.ts, app/src/hermes.ts).
// No DOM, no socket — Node's test runner exercises them directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCompose } from '../app/src/compose.ts';
import {
  applyCountdownFrame,
  emptyCountdownState,
} from '../app/src/countdown.ts';
import {
  approveFrame,
  deliveryStatusView,
  forwardFrame,
  rejectFrame,
  sendButtons,
  targetFor,
  userFooterTargets,
  type DeliveryRow,
} from '../app/src/deliveries.ts';
import { hermesModeBadge, hermesStatusLabel } from '../app/src/hermes.ts';
import { aiFooterLines, type AiFooterContext, type AiFooterLine } from '../app/src/footer.ts';

const row = (messageId: string, target: string, status: string, error?: string, attempts = 1): DeliveryRow => ({
  messageId,
  target,
  status,
  attempts,
  updatedAt: '2026-10-22T00:00:00.000Z',
  ...(error !== undefined ? { error } : {}),
});

// ---------------- Item 1: compose targets ----------------

test('compose: @hermes targets only Hermes', () => {
  assert.deepEqual(parseCompose('@hermes hello', 'astra'), {
    ok: true, body: 'hello', targets: ['hermes'],
  });
});

test('compose: @hermes is case-insensitive', () => {
  assert.deepEqual(parseCompose('@HERMES, hello', 'codex'), {
    ok: true, body: 'hello', targets: ['hermes'],
  });
});

test('compose: @all targets Astra, Codex and Hermes', () => {
  assert.deepEqual(parseCompose('@all do x', 'both'), {
    ok: true, body: 'do x', targets: ['astra', 'codex', 'hermes'],
  });
});

test('compose: @both still means exactly Astra and Codex', () => {
  assert.deepEqual(parseCompose('@both do x', 'hermes'), {
    ok: true, body: 'do x', targets: ['astra', 'codex'],
  });
});

test('compose: glued word @hermesfoo stays plain text', () => {
  assert.deepEqual(parseCompose('@hermesfoo', 'both'), {
    ok: true, body: '@hermesfoo', targets: ['astra', 'codex'],
  });
});

test('compose: empty body after the tag refuses', () => {
  assert.deepEqual(parseCompose('@hermes', 'both'), { ok: false, reason: 'empty' });
  assert.deepEqual(parseCompose('@hermes   ', 'both'), { ok: false, reason: 'empty' });
});

test('compose: selector hermes without a prefix targets Hermes', () => {
  assert.deepEqual(parseCompose('hi there', 'hermes'), {
    ok: true, body: 'hi there', targets: ['hermes'],
  });
});

// ---------------- Item 2: delivery views and send buttons ----------------

test('deliveryStatusView: hermes labels', () => {
  assert.deepEqual(deliveryStatusView(row('m1', 'hermes', 'queued'), 'hermes'),
    { label: 'Approved, waiting for Hermes', actions: [] });
  assert.deepEqual(deliveryStatusView(row('m1', 'hermes', 'delivering'), 'hermes'),
    { label: 'Hermes is working…', actions: [] });
  assert.deepEqual(deliveryStatusView(row('m1', 'hermes', 'delivered'), 'hermes'),
    { label: 'Hermes replied', actions: [] });
  assert.deepEqual(deliveryStatusView(row('m1', 'hermes', 'failed', 'thread busy'), 'hermes'),
    { label: 'Failed: thread busy', actions: ['forward'] });
  assert.deepEqual(deliveryStatusView(row('m1', 'hermes', 'failed', 'thread busy', 3), 'hermes'),
    { label: 'Failed after 3 attempts: thread busy', actions: [] });
  assert.deepEqual(deliveryStatusView(row('m1', 'hermes', 'pending_approval'), 'hermes'),
    { label: 'Waiting for your approval', actions: ['approve', 'reject'] });
  assert.deepEqual(deliveryStatusView(row('m1', 'hermes', 'pending_approval', 'interrupted'), 'hermes'),
    { label: 'Waiting for your approval — interrupted', actions: ['approve', 'reject'] });
});

test('deliveryStatusView: astra and codex labels unchanged', () => {
  assert.deepEqual(deliveryStatusView(row('m1', 'codex', 'queued'), 'codex'),
    { label: 'Approved, waiting for Codex adapter', actions: [] });
  assert.deepEqual(deliveryStatusView(row('m1', 'codex', 'delivering'), 'codex'),
    { label: 'Sending to Codex…', actions: [] });
  assert.deepEqual(deliveryStatusView(row('m1', 'codex', 'delivered'), 'codex'),
    { label: 'Sent to Codex', actions: [] });
  assert.deepEqual(deliveryStatusView(row('m1', 'astra', 'queued'), 'astra'),
    { label: 'Approved, waiting for the ChatGPT extension', actions: [] });
  assert.deepEqual(deliveryStatusView(row('m1', 'astra', 'delivering'), 'astra'),
    { label: 'Typing into ChatGPT…', actions: [] });
  assert.deepEqual(deliveryStatusView(row('m1', 'astra', 'delivered'), 'astra'),
    { label: 'Typed into ChatGPT — click Send there', actions: [] });
});

test('sendButtons: astra offers Codex and Hermes', () => {
  assert.deepEqual(sendButtons('astra', []), [
    { show: true, label: 'Send to Codex', target: 'codex' },
    { show: true, label: 'Send to Hermes', target: 'hermes' },
  ]);
});

test('sendButtons: codex offers ChatGPT and Hermes', () => {
  assert.deepEqual(sendButtons('codex', []), [
    { show: true, label: 'Send to ChatGPT', target: 'astra' },
    { show: true, label: 'Send to Hermes', target: 'hermes' },
  ]);
});

test('sendButtons: hermes offers ChatGPT and Codex', () => {
  assert.deepEqual(sendButtons('hermes', []), [
    { show: true, label: 'Send to ChatGPT', target: 'astra' },
    { show: true, label: 'Send to Codex', target: 'codex' },
  ]);
});

test('sendButtons: user offers none', () => {
  assert.deepEqual(sendButtons('user', []), []);
});

test('sendButtons: a hermes message with an existing codex row only offers ChatGPT', () => {
  const rows = [row('m1', 'codex', 'queued')];
  assert.deepEqual(sendButtons('hermes', rows), [
    { show: true, label: 'Send to ChatGPT', target: 'astra' },
    { show: false, label: '', target: 'codex' },
  ]);
});

test('sendButtons: failed hermes row with 2 attempts shows Send again', () => {
  const rows = [row('m1', 'hermes', 'failed', 'x', 2)];
  assert.deepEqual(sendButtons('codex', rows), [
    { show: true, label: 'Send to ChatGPT', target: 'astra' },
    { show: true, label: 'Send again', target: 'hermes' },
  ]);
});

test('sendButtons: failed hermes row with 3 attempts shows nothing', () => {
  const rows = [row('m1', 'hermes', 'failed', 'x', 3)];
  assert.deepEqual(sendButtons('codex', rows), [
    { show: true, label: 'Send to ChatGPT', target: 'astra' },
    { show: false, label: '', target: 'hermes' },
  ]);
});

test('targetFor unchanged: user maps to nothing', () => {
  assert.equal(targetFor('user'), null);
});

test('userFooterTargets order is astra, codex, hermes', () => {
  const rows = [
    row('m1', 'hermes', 'queued'),
    row('m1', 'codex', 'queued'),
    row('m1', 'astra', 'queued'),
  ];
  assert.deepEqual(userFooterTargets('m1', rows), ['astra', 'codex', 'hermes']);
});

test('frame builders accept hermes', () => {
  assert.deepEqual(forwardFrame('m1', 'hermes'), { type: 'forward', messageId: 'm1', target: 'hermes' });
  assert.deepEqual(approveFrame('m1', 'hermes'), { type: 'approve', messageId: 'm1', target: 'hermes' });
  assert.deepEqual(rejectFrame('m1', 'hermes'), { type: 'reject', messageId: 'm1', target: 'hermes' });
});

// ---------------- Item 3: mode badge text ----------------

test('hermesModeBadge: mode A and undefined', () => {
  assert.deepEqual(hermesModeBadge(undefined), { text: 'Conversation: no tools', tone: 'safe' });
  assert.deepEqual(hermesModeBadge('A'), { text: 'Conversation: no tools', tone: 'safe' });
});

test('hermesModeBadge: mode B', () => {
  assert.deepEqual(hermesModeBadge('B'), { text: 'Supervised: asks first', tone: 'caution' });
});

test('hermesModeBadge: mode C', () => {
  assert.deepEqual(hermesModeBadge('C'), { text: 'Work: tools on, no time limit', tone: 'warning' });
});

test('hermesModeBadge: mode D', () => {
  assert.deepEqual(hermesModeBadge('D'), { text: 'Full access', tone: 'danger' });
});

test('hermesModeBadge: unknown mode is never guessed safe', () => {
  assert.deepEqual(hermesModeBadge('Z'), { text: 'Unknown mode (Z)', tone: 'danger' });
  assert.deepEqual(hermesModeBadge('auto'), { text: 'Unknown mode (auto)', tone: 'danger' });
});

test('hermesStatusLabel: known statuses are lowercase (M6.3c — matches Astra/Codex pills)', () => {
  assert.equal(hermesStatusLabel('idle'), 'idle');
  assert.equal(hermesStatusLabel('thinking'), 'thinking');
  assert.equal(hermesStatusLabel('disconnected'), 'disconnected');
  assert.equal(hermesStatusLabel('failed'), 'failed');
});

test('hermesStatusLabel: unknown status shown raw', () => {
  assert.equal(hermesStatusLabel('weird'), 'weird');
});

// D29 defence: the countdown parser rejects a hermes target frame
test('D29 defence: countdown parser rejects target hermes', () => {
  const state = emptyCountdownState();
  const next = applyCountdownFrame(state, { messageId: 'm1', target: 'hermes', seconds: 5 });
  assert.deepEqual(next, state, 'a hermes target frame is not a countdown');
});

// ---------------- M6.3c: aiFooterLines (the AI-message footer) ----------------
// Extracted from renderDelivery per review m6.3b S1. The vanishing-label cases
// (queued/delivering/delivered, final failed) fail on 13189a2's skip rule.

const footerCtx = (
  messageId: string,
  countdownSeconds: Record<string, number> = {},
  held?: { cap: number },
): AiFooterContext => ({ messageId, countdownSeconds, ...(held !== undefined ? { held } : {}) });

const lineFor = (lines: AiFooterLine[], target: string): AiFooterLine | undefined =>
  lines.find((line) => line.target === target);

test('aiFooterLines: queued/delivering/delivered rows keep their label and show no button', () => {
  const cases: Array<[string, string]> = [
    ['queued', 'Approved, waiting for Codex adapter'],
    ['delivering', 'Sending to Codex…'],
    ['delivered', 'Sent to Codex'],
  ];
  for (const [status, label] of cases) {
    const lines = aiFooterLines('astra', [row('m1', 'codex', status)], footerCtx('m1'));
    const codex = lineFor(lines, 'codex');
    assert.ok(codex, `codex line is present for status ${status}`);
    assert.equal(codex.label, label);
    assert.deepEqual(codex.buttons, []);
  }
});

test('aiFooterLines: astra message with a delivered codex row shows the codex label and a Send to Hermes line', () => {
  const lines = aiFooterLines('astra', [row('m1', 'codex', 'delivered')], footerCtx('m1'));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].target, 'codex');
  assert.equal(lines[1].target, 'hermes');
  assert.equal(lines[0].label, 'Sent to Codex');
  assert.deepEqual(lines[0].buttons, []);
  assert.equal(lines[1].label, '');
  assert.deepEqual(lines[1].buttons, [{ action: 'forward', label: 'Send to Hermes' }]);
});

test('aiFooterLines: pending codex row with a countdown shows Sending in Ns / Send now / Cancel', () => {
  const lines = aiFooterLines('astra', [row('m1', 'codex', 'pending_approval')], footerCtx('m1', { 'm1:codex': 5 }));
  const codex = lineFor(lines, 'codex');
  assert.ok(codex);
  assert.equal(codex.label, 'Sending in 5s');
  assert.deepEqual(codex.buttons, [
    { action: 'approve', label: 'Send now' },
    { action: 'reject', label: 'Cancel' },
  ]);
});

test('aiFooterLines: D29 — a pending hermes row never counts down, shows plain Approve/Reject', () => {
  // A countdown key for the hermes row must be ignored (D29: no Hermes countdown).
  const lines = aiFooterLines('astra', [row('m1', 'hermes', 'pending_approval')], footerCtx('m1', { 'm1:hermes': 5 }));
  const hermes = lineFor(lines, 'hermes');
  assert.ok(hermes);
  assert.equal(hermes.label, 'Waiting for your approval');
  assert.deepEqual(hermes.buttons, [
    { action: 'approve', label: 'Approve' },
    { action: 'reject', label: 'Reject' },
  ]);
});

test('aiFooterLines: a held message shows the held notice on the codex line only', () => {
  const lines = aiFooterLines('astra', [], footerCtx('m1', {}, { cap: 3 }));
  const codex = lineFor(lines, 'codex');
  const hermes = lineFor(lines, 'hermes');
  assert.ok(codex && hermes);
  assert.ok(codex.label.startsWith('Turn cap reached (3)'));
  assert.ok(codex.label.includes('Use Send to Codex to continue by hand.'));
  assert.equal(hermes.label, ''); // never on a Hermes line (D29)
});

test('aiFooterLines: failed row — 3 attempts shows its label and no button, 2 attempts shows Send again', () => {
  const three = lineFor(aiFooterLines('astra', [row('m1', 'codex', 'failed', 'boom', 3)], footerCtx('m1')), 'codex');
  assert.ok(three);
  assert.equal(three.label, 'Failed after 3 attempts: boom');
  assert.deepEqual(three.buttons, []);

  const two = lineFor(aiFooterLines('astra', [row('m1', 'codex', 'failed', 'boom', 2)], footerCtx('m1')), 'codex');
  assert.ok(two);
  assert.equal(two.label, 'Failed: boom');
  assert.deepEqual(two.buttons, [{ action: 'forward', label: 'Send again' }]);
});

test('aiFooterLines: a message from user produces no AI footer lines', () => {
  assert.deepEqual(aiFooterLines('user', [row('m1', 'codex', 'queued')], footerCtx('m1')), []);
});
