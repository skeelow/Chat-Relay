// M2.3 + M3.1 + M3.2a — hermetic tests for the GUI's pure delivery decisions
// (app/src/deliveries.ts): the per-target status tables, the Send-to-Codex /
// Send-to-ChatGPT button visibility, the pending count, the keyed delivery
// state (messageId:target, G2) with the snapshot's pendingClicks reset (G1),
// the exact protocol frames the GUI sends, and the M3.2a views: the approval
// line with an interrupted note and the final failed-after-3-attempts row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyClick,
  applyDeliveryUpdate,
  applySnapshotDeliveries,
  approveFrame,
  deliveryKey,
  deliveryStatusView,
  emptyDeliveryState,
  forwardFrame,
  pendingCount,
  rejectFrame,
  sendButton,
  targetFor,
  type DeliveryRow,
} from '../app/src/deliveries.ts';

const row = (messageId: string, target: string, status: string, error?: string, attempts = 1): DeliveryRow => ({
  messageId,
  target,
  status,
  attempts,
  updatedAt: '2026-10-22T00:00:00.000Z',
  ...(error !== undefined ? { error } : {}),
});

test('deliveryStatusView: codex labels stay as they were', () => {
  assert.deepEqual(deliveryStatusView(row('m1', 'codex', 'pending_approval'), 'codex'),
    { label: 'Waiting for your approval', actions: ['approve', 'reject'] });
  assert.deepEqual(deliveryStatusView(row('m1', 'codex', 'queued'), 'codex'),
    { label: 'Approved, waiting for Codex adapter', actions: [] });
  assert.deepEqual(deliveryStatusView(row('m1', 'codex', 'delivering'), 'codex'),
    { label: 'Sending to Codex…', actions: [] });
  assert.deepEqual(deliveryStatusView(row('m1', 'codex', 'delivered'), 'codex'),
    { label: 'Sent to Codex', actions: [] });
  assert.deepEqual(deliveryStatusView(row('m1', 'codex', 'failed', 'thread busy'), 'codex'),
    { label: 'Failed: thread busy', actions: ['forward'] });
  assert.deepEqual(deliveryStatusView(row('m1', 'codex', 'cancelled'), 'codex'),
    { label: 'Cancelled', actions: [] });
  assert.deepEqual(deliveryStatusView(row('m1', 'codex', 'weird'), 'codex'),
    { label: 'weird', actions: [] }, 'unknown statuses show raw text — never guessed');
});

test('deliveryStatusView: astra labels (typing, never sent)', () => {
  assert.deepEqual(deliveryStatusView(row('m1', 'astra', 'queued'), 'astra'),
    { label: 'Approved, waiting for the ChatGPT extension', actions: [] });
  assert.deepEqual(deliveryStatusView(row('m1', 'astra', 'delivering'), 'astra'),
    { label: 'Typing into ChatGPT…', actions: [] });
  assert.deepEqual(deliveryStatusView(row('m1', 'astra', 'delivered'), 'astra'),
    { label: 'Typed into ChatGPT — click Send there', actions: [] });
  assert.deepEqual(deliveryStatusView(row('m1', 'astra', 'failed', 'the draft was in the way'), 'astra'),
    { label: 'Failed: the draft was in the way', actions: ['forward'] });
  assert.deepEqual(deliveryStatusView(row('m1', 'astra', 'cancelled'), 'astra'),
    { label: 'Cancelled', actions: [] });
});

test('M3.2a: a pending row with an error shows the approval line plus the note', () => {
  const note = 'interrupted by a restart — it may already have arrived';
  assert.deepEqual(deliveryStatusView(row('m1', 'codex', 'pending_approval', note), 'codex'),
    { label: `Waiting for your approval — ${note}`, actions: ['approve', 'reject'] });
  assert.deepEqual(deliveryStatusView(row('m2', 'astra', 'pending_approval', note), 'astra'),
    { label: `Waiting for your approval — ${note}`, actions: ['approve', 'reject'] });
});

test('M3.2a: failed after 3 attempts is final — no action, no Send again; attempts 2 still retries', () => {
  for (const target of ['codex', 'astra'] as const) {
    const source = target === 'codex' ? 'astra' : 'codex';
    const final = row('m1', target, 'failed', 'thread busy', 3);
    assert.deepEqual(deliveryStatusView(final, target),
      { label: 'Failed after 3 attempts: thread busy', actions: [] });
    assert.deepEqual(sendButton(source, final), { show: false, label: '', target });

    const again = row('m1', target, 'failed', 'thread busy', 2);
    assert.deepEqual(deliveryStatusView(again, target),
      { label: 'Failed: thread busy', actions: ['forward'] });
    assert.deepEqual(sendButton(source, again), { show: true, label: 'Send again', target });
  }
});

test('sendButton: astra → Send to Codex, codex → Send to ChatGPT; user never', () => {
  assert.deepEqual(sendButton('astra', undefined),
    { show: true, label: 'Send to Codex', target: 'codex' });
  assert.deepEqual(sendButton('codex', undefined),
    { show: true, label: 'Send to ChatGPT', target: 'astra' });
  assert.deepEqual(sendButton('user', undefined), { show: false, label: '', target: null });
});

test('sendButton: failed deliveries get Send again; other statuses hide the button', () => {
  assert.deepEqual(sendButton('astra', row('m1', 'codex', 'failed', 'x', 1)),
    { show: true, label: 'Send again', target: 'codex' });
  assert.deepEqual(sendButton('codex', row('m1', 'astra', 'failed', 'x', 1)),
    { show: true, label: 'Send again', target: 'astra' });
  for (const status of ['pending_approval', 'queued', 'delivering', 'delivered', 'cancelled']) {
    assert.deepEqual(sendButton('astra', row('m1', 'codex', status)), { show: false, label: '', target: 'codex' }, status);
    assert.deepEqual(sendButton('codex', row('m1', 'astra', status)), { show: false, label: '', target: 'astra' }, status);
  }
});

test('targetFor maps each source to the only other AI; user maps to nothing', () => {
  assert.equal(targetFor('astra'), 'codex');
  assert.equal(targetFor('codex'), 'astra');
  assert.equal(targetFor('user'), null);
});

test('pendingCount counts pending_approval rows across every target', () => {
  const rows = [
    row('m1', 'codex', 'pending_approval'), row('m2', 'astra', 'pending_approval'),
    row('m3', 'astra', 'queued'), row('m4', 'codex', 'delivered'),
    row('m5', 'astra', 'failed', 'x'),
  ];
  assert.equal(pendingCount(rows), 2);
  assert.equal(pendingCount([]), 0);
});

test('G2: rows are keyed messageId:target — one message with two targets stays two rows', () => {
  const empty = emptyDeliveryState();
  const one = applyDeliveryUpdate(empty, row('m1', 'codex', 'queued'));
  const two = applyDeliveryUpdate(one, row('m1', 'astra', 'pending_approval'));
  assert.equal(two.rows.size, 2);
  assert.equal(two.rows.get(deliveryKey('m1', 'codex'))?.status, 'queued');
  assert.equal(two.rows.get(deliveryKey('m1', 'astra'))?.status, 'pending_approval');
  assert.equal(one.rows.size, 1, 'pure: the previous state is untouched');
  // A delivery_update for a message not on screen yet is kept for later.
  const kept = applyDeliveryUpdate(two, row('unknown-msg', 'astra', 'delivering'));
  assert.equal(kept.rows.get(deliveryKey('unknown-msg', 'astra'))?.status, 'delivering');
});

test('G1: a snapshot clears pendingClicks; a click clears on that delivery_update', () => {
  const clicked = applyClick(applyClick(emptyDeliveryState(), deliveryKey('m1', 'codex')), deliveryKey('m2', 'astra'));
  assert.equal(clicked.pendingClicks.size, 2);

  // The delivery_update for a clicked item re-enables just that item.
  const afterUpdate = applyDeliveryUpdate(clicked, row('m1', 'codex', 'queued'));
  assert.equal(afterUpdate.pendingClicks.has(deliveryKey('m1', 'codex')), false);
  assert.equal(afterUpdate.pendingClicks.has(deliveryKey('m2', 'astra')), true);

  // A snapshot resets every pending click (G1) and reseeds the rows.
  const afterSnapshot = applySnapshotDeliveries(afterUpdate, [row('m9', 'astra', 'queued')]);
  assert.equal(afterSnapshot.pendingClicks.size, 0, 'the snapshot clears all pending clicks');
  assert.equal(afterSnapshot.rows.size, 1);
  assert.equal(afterSnapshot.rows.get(deliveryKey('m9', 'astra'))?.status, 'queued');
});

test('frame builders are target-aware with exact JSON', () => {
  assert.deepEqual(forwardFrame('m1', 'codex'), { type: 'forward', messageId: 'm1', target: 'codex' });
  assert.equal(JSON.stringify(forwardFrame('m1', 'codex')), '{"type":"forward","messageId":"m1","target":"codex"}');
  assert.deepEqual(forwardFrame('m2', 'astra'), { type: 'forward', messageId: 'm2', target: 'astra' });
  assert.equal(JSON.stringify(forwardFrame('m2', 'astra')), '{"type":"forward","messageId":"m2","target":"astra"}');
  assert.deepEqual(approveFrame('m1', 'astra'), { type: 'approve', messageId: 'm1', target: 'astra' });
  assert.equal(JSON.stringify(approveFrame('m1', 'astra')), '{"type":"approve","messageId":"m1","target":"astra"}');
  assert.deepEqual(rejectFrame('m2', 'codex'), { type: 'reject', messageId: 'm2', target: 'codex' });
  assert.equal(JSON.stringify(rejectFrame('m2', 'codex')), '{"type":"reject","messageId":"m2","target":"codex"}');
});
