// M2.3 — hermetic tests for the GUI's pure delivery decisions (app/src/deliveries.ts):
// the D9 status table, the Send-to-Codex button visibility, the pending count,
// applying delivery_update to state (including not-yet-shown messages), and the
// exact protocol frames the GUI sends. DOM wiring is covered by the live smoke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDeliveryUpdate,
  approveFrame,
  deliveryStatusView,
  forwardFrame,
  pendingCount,
  rejectFrame,
  sendButton,
  type DeliveryRow,
} from '../app/src/deliveries.ts';

const row = (status: string, error?: string): DeliveryRow => ({
  messageId: 'm1',
  target: 'codex',
  status,
  attempts: 1,
  updatedAt: '2026-10-20T00:00:00.000Z',
  ...(error !== undefined ? { error } : {}),
});

test('deliveryStatusView: the D9 status → (label, actions) table', () => {
  assert.deepEqual(deliveryStatusView('pending_approval'),
    { label: 'Waiting for your approval', actions: ['approve', 'reject'] });
  assert.deepEqual(deliveryStatusView('queued'),
    { label: 'Approved, waiting for Codex adapter', actions: [] });
  assert.deepEqual(deliveryStatusView('delivering'),
    { label: 'Sending to Codex…', actions: [] });
  assert.deepEqual(deliveryStatusView('delivered'),
    { label: 'Sent to Codex', actions: [] });
  assert.deepEqual(deliveryStatusView('failed', 'thread busy — try again later'),
    { label: 'Failed: thread busy — try again later', actions: ['forward'] });
  assert.deepEqual(deliveryStatusView('cancelled'),
    { label: 'Cancelled', actions: [] });
  // The GUI never guesses: an unknown status shows its raw text, no actions.
  assert.deepEqual(deliveryStatusView('weird'),
    { label: 'weird', actions: [] });
});

test('sendButton: astra with no delivery gets Send to Codex; failed gets Send again', () => {
  assert.deepEqual(sendButton('astra', undefined), { show: true, label: 'Send to Codex' });
  assert.deepEqual(sendButton('astra', row('failed', 'x')), { show: true, label: 'Send again' });
});

test('sendButton: every non-failed delivery hides the button; other sources never get it', () => {
  for (const status of ['pending_approval', 'queued', 'delivering', 'delivered', 'cancelled']) {
    assert.deepEqual(sendButton('astra', row(status)), { show: false, label: '' }, status);
  }
  assert.deepEqual(sendButton('codex', undefined), { show: false, label: '' });
  assert.deepEqual(sendButton('codex', row('failed', 'x')), { show: false, label: '' });
  assert.deepEqual(sendButton('user', undefined), { show: false, label: '' });
});

test('pendingCount counts only pending_approval rows', () => {
  const rows = [
    row('pending_approval'), row('queued'), row('pending_approval'),
    row('delivered'), row('failed', 'x'), row('cancelled'),
  ];
  assert.equal(pendingCount(rows), 2);
  assert.equal(pendingCount([]), 0);
});

test('applyDeliveryUpdate: replaces the row; unknown messages are kept for later', () => {
  const empty = new Map<string, DeliveryRow>();
  const withUnknown = applyDeliveryUpdate(empty, row('queued'));
  assert.equal(withUnknown.get('m1')?.status, 'queued',
    'a delivery_update for a message not on screen is kept');
  const updated = applyDeliveryUpdate(withUnknown, row('delivering'));
  assert.equal(updated.get('m1')?.status, 'delivering');
  assert.equal(updated.size, 1);
  assert.equal(withUnknown.get('m1')?.status, 'queued',
    'pure: the previous state is untouched');
});

test('frame builders produce the exact protocol frames', () => {
  assert.deepEqual(forwardFrame('m1'), { type: 'forward', messageId: 'm1', target: 'codex' });
  assert.equal(JSON.stringify(forwardFrame('m1')), '{"type":"forward","messageId":"m1","target":"codex"}');
  assert.deepEqual(approveFrame('m2'), { type: 'approve', messageId: 'm2', target: 'codex' });
  assert.equal(JSON.stringify(approveFrame('m2')), '{"type":"approve","messageId":"m2","target":"codex"}');
  assert.deepEqual(rejectFrame('m3'), { type: 'reject', messageId: 'm3', target: 'codex' });
  assert.equal(JSON.stringify(rejectFrame('m3')), '{"type":"reject","messageId":"m3","target":"codex"}');
});
