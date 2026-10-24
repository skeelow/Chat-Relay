// M4.2 — hermetic tests for the GUI's pure settings decisions
// (app/src/settings.ts): the delay conversion and bounds, the turn-cap
// bounds, the control state for each server value, the mode label and the
// exact set_mode frames. The renderer owns the DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  delayToSeconds,
  isDelayValid,
  isTurnCapValid,
  modeLabel,
  secondsToDelay,
  setModeFrame,
  settingsControls,
  type RelaySettings,
} from '../app/src/settings.ts';

const server = (over: Partial<RelaySettings> = {}): RelaySettings => ({
  mode: 'manual', turnCap: 4, autoSend: false, autoSendDelaySec: 10, ...over,
});

test('delayToSeconds: seconds and minutes convert; the reverse round-trips', () => {
  assert.equal(delayToSeconds(10, 'seconds'), 10);
  assert.equal(delayToSeconds(5, 'minutes'), 300);
  assert.deepEqual(secondsToDelay(15), { value: 15, unit: 'seconds' });
  assert.deepEqual(secondsToDelay(300), { value: 5, unit: 'minutes' });
  assert.deepEqual(secondsToDelay(1800), { value: 30, unit: 'minutes' });
  assert.deepEqual(secondsToDelay(90), { value: 90, unit: 'seconds' }, 'not a whole minute of minutes');
  // round-trip through the allowed range:
  for (const seconds of [3, 10, 60, 300, 1799, 1800]) {
    const { value, unit } = secondsToDelay(seconds);
    assert.equal(delayToSeconds(value, unit), seconds, `round-trip ${seconds}s`);
  }
});

test('isDelayValid: 3 and 1800 pass; 2, 1801 and fractions fail', () => {
  assert.equal(isDelayValid(3), true);
  assert.equal(isDelayValid(1800), true);
  assert.equal(isDelayValid(2), false);
  assert.equal(isDelayValid(1801), false);
  assert.equal(isDelayValid(300.5), false, 'whole seconds only');
  assert.equal(isDelayValid(Number.NaN), false);
});

test('isTurnCapValid: 1 and 50 pass; 0, 51 and fractions fail', () => {
  assert.equal(isTurnCapValid(1), true);
  assert.equal(isTurnCapValid(50), true);
  assert.equal(isTurnCapValid(0), false);
  assert.equal(isTurnCapValid(51), false);
  assert.equal(isTurnCapValid(4.5), false);
});

test('settingsControls: the panel state for each server value', () => {
  assert.deepEqual(settingsControls(server()), {
    mode: 'manual', turnCap: '4', autoSend: false, delay: { value: 10, unit: 'seconds' },
  });
  assert.deepEqual(settingsControls(server({ mode: 'approve_each', autoSend: true, autoSendDelaySec: 300 })), {
    mode: 'approve_each', turnCap: '4', autoSend: true, delay: { value: 5, unit: 'minutes' },
  });
  assert.deepEqual(settingsControls(server({ turnCap: 50, autoSendDelaySec: 3 })), {
    mode: 'manual', turnCap: '50', autoSend: false, delay: { value: 3, unit: 'seconds' },
  });
});

test('modeLabel and the exact set_mode frames', () => {
  assert.equal(modeLabel('manual'), 'Manual');
  assert.equal(modeLabel('approve_each'), 'Approve each');
  assert.deepEqual(setModeFrame({ mode: 'approve_each' }), { type: 'set_mode', mode: 'approve_each' });
  assert.equal(JSON.stringify(setModeFrame({ turnCap: 5 })), '{"type":"set_mode","turnCap":5}');
  assert.equal(JSON.stringify(setModeFrame({ autoSend: true, autoSendDelaySec: 300 })),
    '{"type":"set_mode","autoSend":true,"autoSendDelaySec":300}');
});
