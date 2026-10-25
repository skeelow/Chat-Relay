// M5.1 — hermetic tests for app/src/countdown.ts, the GUI's pure auto-send
// decisions: the row and header text, the held notice, the countdown state
// machine (start / cancel / local tick), the Auto-only controls, and the
// pending-item labels while a countdown runs. The renderer owns the DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCountdownFrame, autoSendControlsEnabled, countdownHeaderText, countdownRowText,
  emptyCountdownState, heldNotice, heldNoticeHelp, pendingDecision, tickCountdowns,
} from '../app/src/countdown.ts';

test('countdownRowText and countdownHeaderText', () => {
  assert.equal(countdownRowText(7), 'Sending in 7s');
  assert.equal(countdownRowText(0), 'Sending in 0s');
  assert.equal(countdownHeaderText(0), '');
  assert.equal(countdownHeaderText(1), '1 countdown running');
  assert.equal(countdownHeaderText(3), '3 countdowns running');
});

test('heldNotice: the exact packet text, plus the chain-reset help', () => {
  assert.equal(heldNotice(4, 'Codex'),
    'Turn cap reached (4) — not forwarded automatically. Use Send to Codex to continue by hand.');
  assert.equal(heldNotice(2, 'Astra'),
    'Turn cap reached (2) — not forwarded automatically. Use Send to Astra to continue by hand.');
  assert.equal(heldNoticeHelp(),
    'A new user message resets the chain — it starts from hop 0 again.');
});

test('the countdown state machine: start, cancel, local tick', () => {
  let state = emptyCountdownState();
  assert.equal(Object.keys(state.secondsLeft).length, 0);
  state = applyCountdownFrame(state, { messageId: '01A', target: 'astra', seconds: 3 });
  state = applyCountdownFrame(state, { messageId: '01B', target: 'codex', seconds: 10 });
  assert.deepEqual(state.secondsLeft, { '01A:astra': 3, '01B:codex': 10 });
  state = applyCountdownFrame(state, { messageId: '01A', target: 'astra', seconds: null });
  assert.deepEqual(state.secondsLeft, { '01B:codex': 10 }, 'the server null clears the item');
  state = tickCountdowns(state);
  assert.deepEqual(state.secondsLeft, { '01B:codex': 9 }, 'one second passes locally');
  for (let i = 0; i < 12; i++) state = tickCountdowns(state);
  assert.deepEqual(state.secondsLeft, { '01B:codex': 0 }, 'ticks floor at zero until the server clears');
  state = applyCountdownFrame(state, { messageId: '01D', target: 'astra' });
  assert.deepEqual(state.secondsLeft, { '01B:codex': 0 }, 'a frame without seconds changes nothing');
  state = applyCountdownFrame(state, { messageId: '01B', target: 'codex', seconds: null });
  assert.deepEqual(state.secondsLeft, {}, 'cleared');
});

test('autoSendControlsEnabled: the auto-send controls live only in Auto', () => {
  assert.equal(autoSendControlsEnabled('auto'), true);
  assert.equal(autoSendControlsEnabled('approve_each'), false);
  assert.equal(autoSendControlsEnabled('manual'), false);
});

test('pendingDecision: countdown labels versus the plain pending labels', () => {
  assert.deepEqual(pendingDecision(true, 7),
    { label: 'Sending in 7s', approveLabel: 'Send now', rejectLabel: 'Cancel' });
  assert.deepEqual(pendingDecision(false, 0),
    { label: 'Waiting for your approval', approveLabel: 'Approve', rejectLabel: 'Reject' });
});
