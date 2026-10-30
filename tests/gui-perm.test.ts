// M6.4d — hermetic tests for the GUI's permission picker, Kill control and
// audit view (app/src/perm.ts, app/src/deliveries.ts, app/src/audit.ts).
// No DOM, no socket — Node's test runner exercises the pure decisions; the
// renderer only paints what these return. The same frames are pushed through
// the real engine in tests/hermes-engine.test.ts ('M6.4d GUI builder frames').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PERM,
  PERM_CHOICES,
  PERM_NOTE,
  choosePerm,
  forwardFrameWithPerm,
  permAfterSend,
  permChoiceView,
  sendFrameWithPerm,
  type Perm,
} from '../app/src/perm.ts';
import {
  applyKillDelivery,
  finishKillWait,
  hermesInFlight,
  isKillHotkey,
  killConfirmation,
  killFrame,
  startKillWait,
  type DeliveryRow,
} from '../app/src/deliveries.ts';
import {
  AUDIT_LIMIT,
  applyAuditResult,
  auditFrame,
  auditRows,
  closeAudit,
  emptyAuditState,
  openAudit,
  type AuditEntry,
} from '../app/src/audit.ts';

const row = (messageId: string, target: string, status: string): DeliveryRow => ({
  messageId, target, status, attempts: 1, updatedAt: '2026-10-30T00:00:00.000Z',
});

// ---------------- Item 1: the picker ----------------

test('M6.4d picker: default is conversation', () => {
  assert.equal(DEFAULT_PERM, 'conversation');
  assert.deepEqual(PERM_CHOICES.map((c) => c.value), ['conversation', 'work', 'full']);
});

test('M6.4d picker: choosePerm accepts the three modes and never guesses', () => {
  assert.equal(choosePerm('conversation', 'work'), 'work');
  assert.equal(choosePerm('work', 'full'), 'full');
  assert.equal(choosePerm('full', 'conversation'), 'conversation');
  assert.equal(choosePerm('work', 'everything'), 'work', 'an invalid choice changes nothing');
  assert.equal(choosePerm('work', undefined), 'work');
});

test('M6.4d picker: every send resets to conversation — work and full are never sticky', () => {
  assert.equal(permAfterSend('work'), DEFAULT_PERM);
  assert.equal(permAfterSend('full'), DEFAULT_PERM);
  assert.equal(permAfterSend('conversation'), DEFAULT_PERM);
});

test('M6.4d picker: work and full carry a visible mark (tone + label), conversation is plain', () => {
  assert.deepEqual(permChoiceView('conversation'), { label: 'Conversation', tone: 'safe' });
  assert.equal(permChoiceView('work').tone, 'warning');
  assert.equal(permChoiceView('work').label, 'Work — tools on');
  assert.equal(permChoiceView('full').tone, 'danger');
  assert.equal(permChoiceView('full').label, 'Full — no blocks');
});

test('M6.4d picker: the UI note says each mode has its own session', () => {
  assert.match(PERM_NOTE, /own .*session/i);
  assert.match(PERM_NOTE, /memory/i);
  assert.match(PERM_NOTE, /files/i);
});

test('M6.4d frame: send carries the perm only when Hermes is a target', () => {
  assert.deepEqual(sendFrameWithPerm('hi', ['hermes'], 'work'),
    { type: 'send', body: 'hi', targets: ['hermes'], perm: 'work' });
  assert.deepEqual(sendFrameWithPerm('hi', ['astra', 'codex', 'hermes'], 'full'),
    { type: 'send', body: 'hi', targets: ['astra', 'codex', 'hermes'], perm: 'full' });
  assert.deepEqual(sendFrameWithPerm('hi', ['astra', 'codex'], 'work'),
    { type: 'send', body: 'hi', targets: ['astra', 'codex'] },
    'no Hermes target — no perm field, so nothing is audited for it');
  assert.deepEqual(sendFrameWithPerm('hi', ['hermes'], 'conversation'),
    { type: 'send', body: 'hi', targets: ['hermes'], perm: 'conversation' });
});

test('M6.4d frame: a Hermes forward carries the perm; astra/codex forwards never do', () => {
  assert.deepEqual(forwardFrameWithPerm('m1', 'hermes', 'work'),
    { type: 'forward', messageId: 'm1', target: 'hermes', perm: 'work' });
  assert.deepEqual(forwardFrameWithPerm('m1', 'codex', 'work'),
    { type: 'forward', messageId: 'm1', target: 'codex' });
});

// ---------------- Item 2: Kill ----------------

test('M6.4d kill: the frame builder and the hotkey', () => {
  assert.deepEqual(killFrame(), { type: 'kill' });
  assert.equal(isKillHotkey({ key: 'K', ctrlKey: true, shiftKey: true }), true);
  assert.equal(isKillHotkey({ key: 'k', ctrlKey: true, shiftKey: true }), true);
  assert.equal(isKillHotkey({ key: 'k', ctrlKey: true, shiftKey: false }), false);
  assert.equal(isKillHotkey({ key: 'k', ctrlKey: false, shiftKey: true }), false);
  assert.equal(isKillHotkey({ key: 'k', ctrlKey: true, shiftKey: true, metaKey: true }), false,
    'the hotkey is Ctrl+Shift+K alone');
  assert.equal(isKillHotkey({ key: 'x', ctrlKey: true, shiftKey: true }), false);
});

test('M6.4d kill: in flight means a queued or delivering Hermes row', () => {
  assert.equal(hermesInFlight([row('m1', 'hermes', 'queued')]), true);
  assert.equal(hermesInFlight([row('m1', 'hermes', 'delivering')]), true);
  assert.equal(hermesInFlight([row('m1', 'hermes', 'delivered')]), false);
  assert.equal(hermesInFlight([row('m1', 'hermes', 'pending_approval')]), false);
  assert.equal(hermesInFlight([row('m1', 'codex', 'delivering')]), false, 'a codex row is not Hermes');
  assert.equal(hermesInFlight([]), false);
});

test('M6.4d kill: the wait counts the engine reply rows and the confirmation says what stopped', () => {
  let wait = startKillWait();
  wait = applyKillDelivery(wait, row('m1', 'hermes', 'pending_approval'));
  wait = applyKillDelivery(wait, row('m1', 'codex', 'pending_approval'));
  wait = applyKillDelivery(wait, row('m2', 'hermes', 'delivered')); // not a return-to-pending
  assert.equal(wait.returned, 2);
  assert.equal(killConfirmation(wait.returned),
    'Killed — 2 in-flight row(s) returned to pending; nothing runs; the relay is stopped until you Resume');
  const empty = finishKillWait(startKillWait());
  assert.equal(killConfirmation(empty.returned),
    'Killed — nothing was in flight; the relay is stopped until you Resume');
});

test('M6.4d kill: deliveries before the click do not count (the wait starts at zero)', () => {
  let wait = startKillWait();
  wait = finishKillWait(wait);
  assert.equal(wait.awaiting, false);
  assert.equal(applyKillDelivery(wait, row('m1', 'hermes', 'pending_approval')).returned, 0,
    'an update after the reply resolved changes nothing');
});

// ---------------- Item 3: audit view ----------------

const entry = (
  id: number, at: string, actor: string, event: string,
  detail?: string, messageId?: string, target?: string,
): AuditEntry => ({
  id, at, actor, event,
  target: target ?? null,
  messageId: messageId ?? null,
  detail: detail ?? null,
});

test('M6.4d audit: the frame asks for the newest 100 rows', () => {
  assert.equal(AUDIT_LIMIT, 100);
  assert.deepEqual(auditFrame('r1'), { type: 'audit', requestId: 'r1', limit: 100 });
});

test('M6.4d audit: rows render time, perm, event and detail — newest first, capped', () => {
  const entries = [
    entry(3, '2026-10-30T10:00:03Z', 'gui', 'kill'),
    entry(2, '2026-10-30T10:00:02Z', 'engine', 'hermes_delivering', 'work', 'm1', 'hermes'),
    entry(1, '2026-10-30T10:00:01Z', 'gui', 'perm_requested', 'work', 'm1', 'hermes'),
  ];
  const rows = auditRows(entries);
  assert.deepEqual(rows.map((r) => r.time), [
    '2026-10-30T10:00:03Z', '2026-10-30T10:00:02Z', '2026-10-30T10:00:01Z',
  ], 'newest first even when the frames arrive shuffled');
  assert.equal(rows[2].perm, 'work', 'perm_requested shows its perm');
  assert.equal(rows[1].perm, 'work', 'hermes_delivering shows the perm from its detail');
  assert.equal(rows[1].detail, null, 'the perm detail is shown in the perm column, not twice');
  assert.equal(rows[0].perm, null, 'a kill row has no perm');
  const capped = auditRows(Array.from({ length: 250 }, (_, i) => entry(i, `t${i}`, 'gui', 'set_mode')));
  assert.equal(capped.length, AUDIT_LIMIT, 'the view is capped at the limit');
  assert.equal(capped[0].time, 't249', 'the cap keeps the newest');
});

test('M6.4d audit: junk entries are dropped, never guessed', () => {
  const rows = auditRows([
    { id: 1, at: 5, actor: 'gui', event: 'x' },          // at is not a string
    { id: 2, at: 't2', actor: 'gui', event: 7 },          // event is not a string
    entry(3, 't3', 'gui', 'stop'),                         // the one good row
    null, 'not an object',
  ] as unknown as AuditEntry[]);
  assert.deepEqual(rows.map((r) => r.event), ['stop']);
});

test('M6.4d audit: the panel state — open/refresh answers only the current request', () => {
  let state = openAudit(emptyAuditState(), 'r1');
  assert.equal(state.open, true);
  assert.equal(state.requestId, 'r1');
  const next = applyAuditResult(state, { requestId: 'stale', entries: [entry(9, 't', 'gui', 'stop')] });
  assert.equal(next, state, 'a stale requestId is ignored');
  const answered = applyAuditResult(state, { requestId: 'r1', entries: [entry(9, 't', 'gui', 'stop')] });
  assert.notEqual(answered, state);
  assert.equal(answered.entries.length, 1);
  const closed = closeAudit(answered);
  assert.equal(closed.open, false);
  const ignored = applyAuditResult(closed, { requestId: 'r1', entries: [] });
  assert.equal(ignored.entries.length, answered.entries.length, 'a closed panel keeps its last rows');
});

// keep TS from pruning the type import
export type _Perm = Perm;
