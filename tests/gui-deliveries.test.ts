// M2.3 + M3.1 — hermetic tests for the GUI's pure delivery decisions
// (app/src/deliveries.ts): the per-target status tables, the Send-to-Codex /
// Send-to-ChatGPT button visibility, the pending count, the keyed delivery
// state (messageId:target, G2) with the snapshot's pendingClicks reset (G1),
// and the exact protocol frames the GUI sends.
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

const row = (messageId: string, target: string, status: string, error?: string): DeliveryRow => ({
  messageId,
  target,
  status,
  attempts: 1,
  updatedAt: '2026-10-20T00:00:00.000Z',
  ...(error !== undefined ? { error } : {}),
});

test('deliveryStatusView: codex labels stay as they were', () => {
  assert.deepEqual(deliveryStatusView('pending_approval', 'codex'),
    { label: 'Waiting for your approval', actions: ['approve', 'reject'] });
  assert.deepEqual(deliveryStatusView('queued', 'codex'),
    { label: 'Approved, waiting for Codex adapter', actions: [] });
  assert.deepEqual(deliveryStatusView('delivering', 'codex'),
    { label: 'Sending to Codex…', actions: [] });
  assert.deepEqual(deliveryStatusView('delivered', 'codex'),
    { label: 'Sent to Codex', actions: [] });
  assert.deepEqual(deliveryStatusView('failed', 'codex', 'thread busy'),
    { label: 'Failed: thread busy', actions: ['forward'] });
  assert.deepEqual(deliveryStatusView('cancelled', 'codex'),
    { label: 'Cancelled', actions: [] });
  assert.deepEqual(deliveryStatusView('weird', 'codex'),
    { label: 'weird', actions: [] }, 'unknown statuses show raw text — never guessed');
});

test('deliveryStatusView: astra labels (typing, never sent)', () => {
  assert.deepEqual(deliveryStatusView('pending_approval', 'astra'),
    { label: 'Waiting for your approval', actions: ['approve', 'reject'] });
  assert.deepEqual(deliveryStatusView('queued', 'astra'),
    { label: 'Approved, waiting for the ChatGPT extension', actions: [] });
  assert.deepEqual(deliveryStatusView('delivering', 'astra'),
    { label: 'Typing into ChatGPT…', actions: [] });
  assert.deepEqual(deliveryStatusView('delivered', 'astra'),
    { label: 'Typed into ChatGPT — click Send there', actions: [] });
  assert.deepEqual(deliveryStatusView('failed', 'astra', 'the draft was in the way'),
    { label: 'Failed: the draft was in the way', actions: ['forward'] });
  assert.deepEqual(deliveryStatusView('cancelled', 'astra'),
    { label: 'Cancelled', actions: [] });
});

test('sendButton: astra → Send to Codex, codex → Send to ChatGPT; user never', () => {
  assert.deepEqual(sendButton('astra', undefined),
    { show: true, label: 'Send to Codex', target: 'codex' });
  assert.deepEqual(sendButton('codex', undefined),
    { show: true, label: 'Send to ChatGPT', target: 'astra' });
  assert.deepEqual(sendButton('user', undefined), { show: false, label: '', target: null });
});

test('sendButton: failed deliveries get Send again; other statuses hide the button', () => {
  assert.deepEqual(sendButton('astra', row('m1', 'codex', 'failed', 'x')),
    { show: true, label: 'Send again', target: 'codex' });
  assert.deepEqual(sendButton('codex', row('m1', 'astra', 'failed', 'x')),
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
