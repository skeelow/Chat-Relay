// M1.3 — hermetic tests for the Codex adapter's pure poll-planning logic
// (planPoll). The live pipeline — engine + adapter + a real codex app-server —
// is exercised by the manual smoke run documented in docs/status/m1.3.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPoll, type ObservedTurn } from '../adapters/codex/adapter.ts';

const NOW_MS = 1_700_000_000_000;
const fresh = (secAgo: number): number => Math.floor(NOW_MS / 1000 - secAgo);

function turn(id: string, status: string, items: Array<{ type: string; text?: string }>, startedAt: number | null): ObservedTurn {
  return { id, status, startedAt, items };
}

test('a newly completed turn is captured with its last agent message', () => {
  const turns = [turn('t1', 'completed', [
    { type: 'agentMessage', text: 'first draft' },
    { type: 'agentMessage', text: 'final answer' },
  ], fresh(30))];
  const plan = planPoll(turns, new Set(), NOW_MS);
  assert.deepEqual(plan.captures, [{ body: 'final answer', sourceRef: 't1' }]);
  assert.deepEqual(plan.seenWithoutCapture, []);
  assert.equal(plan.adapterStatus, 'idle');
});

test('several new completed turns are captured oldest first', () => {
  // turns/list is newest-first
  const turns = [
    turn('newest', 'completed', [{ type: 'agentMessage', text: 'newest body' }], fresh(10)),
    turn('middle', 'completed', [{ type: 'agentMessage', text: 'middle body' }], fresh(20)),
    turn('oldest', 'completed', [{ type: 'agentMessage', text: 'oldest body' }], fresh(30)),
  ];
  const plan = planPoll(turns, new Set(), NOW_MS);
  assert.deepEqual(
    plan.captures.map((c) => c.body),
    ['oldest body', 'middle body', 'newest body'],
  );
  assert.deepEqual(plan.captures.map((c) => c.sourceRef), ['oldest', 'middle', 'newest']);
});

test('an already-reported turn is never captured again', () => {
  const turns = [turn('t1', 'completed', [{ type: 'agentMessage', text: 'again' }], fresh(30))];
  const plan = planPoll(turns, new Set(['t1']), NOW_MS);
  assert.deepEqual(plan.captures, []);
  assert.deepEqual(plan.seenWithoutCapture, []);
});

test('a completed turn without reportable text is marked seen, not captured', () => {
  const turns = [
    turn('empty', 'completed', [{ type: 'reasoning' }, { type: 'agentMessage', text: '   ' }], fresh(30)),
    turn('noitems', 'completed', [], fresh(40)),
  ];
  const plan = planPoll(turns, new Set(), NOW_MS);
  assert.deepEqual(plan.captures, []);
  assert.deepEqual(plan.seenWithoutCapture, ['empty', 'noitems']);
});

test('a fresh foreign turn showing interrupted reads as streaming; a stale one reads as idle', () => {
  const freshInterrupted = [turn('t1', 'interrupted', [], fresh(20))];
  assert.equal(planPoll(freshInterrupted, new Set(), NOW_MS).adapterStatus, 'streaming');

  const staleInterrupted = [turn('t1', 'interrupted', [], fresh(400))];
  assert.equal(planPoll(staleInterrupted, new Set(), NOW_MS).adapterStatus, 'idle');

  const completed = [turn('t1', 'completed', [{ type: 'agentMessage', text: 'x' }], fresh(10))];
  assert.equal(planPoll(completed, new Set(), NOW_MS).adapterStatus, 'idle');

  const ancientNoTimestamp = [turn('t1', 'interrupted', [], null)];
  assert.equal(planPoll(ancientNoTimestamp, new Set(), NOW_MS).adapterStatus, 'idle');
});

test('a newest turn inProgress reads as streaming', () => {
  const turns = [turn('live', 'inProgress', [], fresh(5))];
  const plan = planPoll(turns, new Set(), NOW_MS);
  assert.equal(plan.adapterStatus, 'streaming');
  assert.deepEqual(plan.captures, []);
});

test('an empty list yields idle and nothing to send', () => {
  const plan = planPoll([], new Set(), NOW_MS);
  assert.deepEqual(plan.captures, []);
  assert.deepEqual(plan.seenWithoutCapture, []);
  assert.equal(plan.adapterStatus, 'idle');
});

test('planPoll never mutates its inputs', () => {
  const turns = [turn('t1', 'completed', [{ type: 'agentMessage', text: 'x' }], fresh(30))];
  const reported = new Set<string>();
  const snapshot = JSON.stringify(turns);
  planPoll(turns, reported, NOW_MS);
  assert.equal(JSON.stringify(turns), snapshot);
  assert.equal(reported.size, 0, 'the caller marks ids; planPoll does not touch the set');
});
