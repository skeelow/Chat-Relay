// M1.3 — hermetic tests for the Codex adapter's pure poll-planning logic
// (planPoll) and the RequestTracker timeout behavior. The live pipeline —
// engine + adapter + a real codex app-server — is exercised by the manual
// smoke run documented in docs/status/m1.3.md.
//
// M2.2 additions: the thread choice (arg > config > start), the turn/start
// failure mapping (the -32600 busy hint), the relay-header and recent-hash
// capture drops, and splitting the body off a delivered text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  approvalResponse,
  approvalSummary,
  chooseThread,
  classifyServerRequest,
  deliverFailureText,
  deliveredBodyOf,
  interruptTargets,
  planPoll,
  RequestTracker,
  unresolvedDeliveryError,
  type ObservedTurn,
} from '../adapters/codex/adapter.ts';
import { hashBody } from '../relay/store.ts';

const NOW_MS = 1_700_000_000_000;
const fresh = (secAgo: number): number => Math.floor(NOW_MS / 1000 - secAgo);

function turn(id: string, status: string, items: Array<{ type: string; text?: string }>, startedAt: number | null, completedAt: number | null = null): ObservedTurn {
  return { id, status, startedAt, completedAt, items };
}

test('a newly completed turn is captured with its last agent message', () => {
  const turns = [turn('t1', 'completed', [
    { type: 'agentMessage', text: 'first draft' },
    { type: 'agentMessage', text: 'final answer' },
  ], fresh(30), fresh(10))];
  const plan = planPoll(turns, new Set(), NOW_MS, false);
  assert.deepEqual(plan.captures, [{ body: 'final answer', sourceRef: 't1' }]);
  assert.deepEqual(plan.seenWithoutCapture, []);
  assert.equal(plan.adapterStatus, 'idle');
});

test('several new completed turns are captured oldest first', () => {
  // turns/list is newest-first
  const turns = [
    turn('newest', 'completed', [{ type: 'agentMessage', text: 'newest body' }], fresh(10), fresh(5)),
    turn('middle', 'completed', [{ type: 'agentMessage', text: 'middle body' }], fresh(20), fresh(15)),
    turn('oldest', 'completed', [{ type: 'agentMessage', text: 'oldest body' }], fresh(30), fresh(25)),
  ];
  const plan = planPoll(turns, new Set(), NOW_MS, false);
  assert.deepEqual(
    plan.captures.map((c) => c.body),
    ['oldest body', 'middle body', 'newest body'],
  );
  assert.deepEqual(plan.captures.map((c) => c.sourceRef), ['oldest', 'middle', 'newest']);
});

test('an already-reported turn is never captured again', () => {
  const turns = [turn('t1', 'completed', [{ type: 'agentMessage', text: 'again' }], fresh(30), fresh(10))];
  const plan = planPoll(turns, new Set(['t1']), NOW_MS, false);
  assert.deepEqual(plan.captures, []);
  assert.deepEqual(plan.seenWithoutCapture, []);
});

test('a completed turn without reportable text is marked seen, not captured', () => {
  const turns = [
    turn('empty', 'completed', [{ type: 'reasoning' }, { type: 'agentMessage', text: '   ' }], fresh(30), fresh(10)),
    turn('noitems', 'completed', [], fresh(40), fresh(20)),
  ];
  const plan = planPoll(turns, new Set(), NOW_MS, false);
  assert.deepEqual(plan.captures, []);
  assert.deepEqual(plan.seenWithoutCapture, ['empty', 'noitems']);
});

test('first poll captures only turns completed within the window; older ones are marked seen', () => {
  const turns = [
    turn('recent', 'completed', [{ type: 'agentMessage', text: 'fresh reply' }], fresh(40), fresh(30)),
    turn('ancient', 'completed', [{ type: 'agentMessage', text: 'old reply' }], fresh(7200), fresh(7100)),
  ];
  const plan = planPoll(turns, new Set(), NOW_MS, true);
  assert.deepEqual(plan.captures, [{ body: 'fresh reply', sourceRef: 'recent' }]);
  assert.deepEqual(plan.seenWithoutCapture, ['ancient']);
});

test('the same input with firstPoll false captures both turns', () => {
  const turns = [
    turn('recent', 'completed', [{ type: 'agentMessage', text: 'fresh reply' }], fresh(40), fresh(30)),
    turn('ancient', 'completed', [{ type: 'agentMessage', text: 'old reply' }], fresh(7200), fresh(7100)),
  ];
  const plan = planPoll(turns, new Set(), NOW_MS, false);
  assert.deepEqual(plan.captures.map((c) => c.body), ['old reply', 'fresh reply']);
  assert.deepEqual(plan.seenWithoutCapture, []);
});

test('first poll treats a completed turn with null completedAt as history', () => {
  const turns = [turn('unknown-age', 'completed', [{ type: 'agentMessage', text: 'x' }], fresh(30), null)];
  const plan = planPoll(turns, new Set(), NOW_MS, true);
  assert.deepEqual(plan.captures, []);
  assert.deepEqual(plan.seenWithoutCapture, ['unknown-age']);
});

test('interrupted with completedAt null reads as streaming however old the turn', () => {
  // Live observation (Fix 3): a foreign turn that is still running shows
  // interrupted with completedAt null — even a 10-minute-old long turn streams.
  const turns = [turn('live-long', 'interrupted', [], fresh(600), null)];
  assert.equal(planPoll(turns, new Set(), NOW_MS, false).adapterStatus, 'streaming');
});

test('interrupted with completedAt set reads as idle (it was really interrupted)', () => {
  const turns = [turn('stopped', 'interrupted', [], fresh(60), fresh(40))];
  assert.equal(planPoll(turns, new Set(), NOW_MS, false).adapterStatus, 'idle');
});

test('inProgress reads as streaming; completed reads as idle', () => {
  const live = [turn('live', 'inProgress', [], fresh(5), null)];
  assert.equal(planPoll(live, new Set(), NOW_MS, false).adapterStatus, 'streaming');
  const done = [turn('done', 'completed', [{ type: 'agentMessage', text: 'x' }], fresh(30), fresh(10))];
  assert.equal(planPoll(done, new Set(), NOW_MS, false).adapterStatus, 'idle');
});

test('an empty list yields idle and nothing to send', () => {
  const plan = planPoll([], new Set(), NOW_MS, false);
  assert.deepEqual(plan.captures, []);
  assert.deepEqual(plan.seenWithoutCapture, []);
  assert.equal(plan.adapterStatus, 'idle');
});

test('planPoll never mutates its inputs', () => {
  const turns = [turn('t1', 'completed', [{ type: 'agentMessage', text: 'x' }], fresh(30), fresh(10))];
  const reported = new Set<string>();
  const snapshot = JSON.stringify(turns);
  planPoll(turns, reported, NOW_MS, false);
  assert.equal(JSON.stringify(turns), snapshot);
  assert.equal(reported.size, 0, 'the caller marks ids; planPoll does not touch the set');
});

// --- RequestTracker: per-request timeouts (Fix 1) ---

test('a request that never gets a response rejects after the timeout', async () => {
  const tracker = new RequestTracker(50);
  await assert.rejects(
    tracker.request('thread/turns/list', () => {}),
    /codex request timed out: thread\/turns\/list/,
  );
});

test('a response arriving after the timeout is ignored; the tracker keeps working', async () => {
  const tracker = new RequestTracker(30);
  await assert.rejects(tracker.request('getAuthStatus', () => {}), /timed out/);
  tracker.handleResponse(1, { authMethod: 'chatgpt' }, undefined); // late — must be a no-op, no throw
  const second = tracker.request('next', () => {});
  tracker.handleResponse(2, 42, undefined);
  assert.equal(await second, 42);
});

test('a response before the timeout resolves the request; duplicates are ignored', async () => {
  const tracker = new RequestTracker(5000);
  const promise = tracker.request('x', (id) => {
    setTimeout(() => tracker.handleResponse(id, 42, undefined), 10);
  });
  assert.equal(await promise, 42);
  tracker.handleResponse(1, 43, undefined); // duplicate late response: no-op, no throw
});

// --- M2.2: thread choice, failure mapping, echo drops ---

test('chooseThread: the CLI arg wins over config; config wins over starting a thread', () => {
  assert.deepEqual(chooseThread('arg-id', 'config-id'), { action: 'use', threadId: 'arg-id' });
  assert.deepEqual(chooseThread('arg-id', null), { action: 'use', threadId: 'arg-id' });
  assert.deepEqual(chooseThread(undefined, 'config-id'), { action: 'use', threadId: 'config-id' });
  assert.deepEqual(chooseThread(undefined, null), { action: 'start' });
});

test('deliverFailureText: the writer conflict maps to the busy hint; other errors pass through', () => {
  const busy = 'thread busy — close the Relay Chat thread in the Codex app, then forward again';
  assert.equal(
    deliverFailureText('Error: {"code":-32600,"message":"thread-store conflict: already has an active writer"}'),
    busy);
  assert.equal(deliverFailureText('Error: active writer already exists'), busy);
  assert.equal(deliverFailureText('Error: {"code":-32000,"message":"codex exploded"}'), 'codex exploded',
    'a JSON-RPC error surfaces its message text');
  assert.equal(deliverFailureText('Error: plain failure'), 'Error: plain failure',
    'unrecognized text passes through unchanged');
});

test('a turn whose text starts with the relay header is dropped and marked seen', () => {
  // The engine injects '[Relay · from …]' as the first line; a codex turn
  // that starts with it is the relayed text echoing back, never a reply.
  const turns = [turn('echo-hdr', 'completed',
    [{ type: 'agentMessage', text: '[Relay · from Astra · #01HXYZ · hop 1]\nthe relayed body' }],
    fresh(30), fresh(10))];
  const plan = planPoll(turns, new Set(), NOW_MS, false);
  assert.deepEqual(plan.captures, []);
  assert.deepEqual(plan.seenWithoutCapture, ['echo-hdr']);
});

test('a capture whose body hash matches a recent delivery is dropped', () => {
  const body = 'PONG reply';
  const turns = [turn('echo-hash', 'completed', [{ type: 'agentMessage', text: body }], fresh(30), fresh(10))];
  const recent = [{ bodyHash: hashBody(body), atMs: NOW_MS - 60_000 }];
  const plan = planPoll(turns, new Set(), NOW_MS, false, recent);
  assert.deepEqual(plan.captures, []);
  assert.deepEqual(plan.seenWithoutCapture, ['echo-hash']);
});

test('a delivery hash older than the echo window no longer drops the capture', () => {
  const body = 'PONG reply';
  const turns = [turn('old-echo', 'completed', [{ type: 'agentMessage', text: body }], fresh(30), fresh(10))];
  const stale = [{ bodyHash: hashBody(body), atMs: NOW_MS - 11 * 60 * 1000 }];
  const plan = planPoll(turns, new Set(), NOW_MS, false, stale);
  assert.deepEqual(plan.captures, [{ body, sourceRef: 'old-echo' }]);
  assert.deepEqual(plan.seenWithoutCapture, []);
});

test('deliveredBodyOf splits the header line off the delivered text', () => {
  assert.equal(deliveredBodyOf('[Relay · from Astra · #01HXYZ · hop 1]\nthe actual body'), 'the actual body');
  assert.equal(deliveredBodyOf('no newline at all'), '',
    'a malformed deliver has no memorable body');
});

test('A1: the unresolved-thread failure text carries the resolve error', () => {
  assert.equal(
    unresolvedDeliveryError('codex request timed out: thread/start'),
    'relay thread not resolved: codex request timed out: thread/start');
});

// --- M3.2b: Stop's interrupt targets ---

test('interruptTargets: in-progress turns on the relay thread only, inputs never mutated', () => {
  const relay = 'thread-relay';
  const inProgress = { id: 'own-live', status: 'inProgress', startedAt: fresh(5), completedAt: null, items: [] };
  const taggedRelay = { id: 'relay-tagged', status: 'inProgress', threadId: relay, startedAt: fresh(4), completedAt: null, items: [] };
  const taggedForeign = { id: 'foreign-live', status: 'inProgress', threadId: 'thread-other', startedAt: fresh(3), completedAt: null, items: [] };
  const liveForeignShape = { id: 'streaming', status: 'interrupted', startedAt: fresh(2), completedAt: null, items: [] };
  const completed = { id: 'done', status: 'completed', startedAt: fresh(60), completedAt: fresh(10), items: [] };
  const alreadyInterrupted = { id: 'stopped', status: 'interrupted', startedAt: fresh(50), completedAt: fresh(40), items: [] };
  const turns = [completed, taggedForeign, inProgress, taggedRelay, alreadyInterrupted, liveForeignShape];
  const snapshot = JSON.stringify(turns);
  assert.deepEqual(interruptTargets(turns, relay), ['own-live', 'relay-tagged', 'streaming'],
    'in-progress turns on the relay thread; untagged turns are the relay-thread query results');
  assert.equal(JSON.stringify(turns), snapshot, 'the helper never mutates its input');
  assert.deepEqual(interruptTargets([], relay), []);
});

// --- M3.3: Codex approval requests (surface, never auto-answer) ---

test('classifyServerRequest: three answerable methods; everything else is other', () => {
  assert.equal(classifyServerRequest('item/commandExecution/requestApproval'), 'command');
  assert.equal(classifyServerRequest('item/fileChange/requestApproval'), 'file_change');
  assert.equal(classifyServerRequest('item/permissions/requestApproval'), 'permissions');
  for (const other of ['item/tool/requestUserInput', 'mcpServer/elicitation/request', 'item/tool/call',
    'applyPatchApproval', 'execCommandApproval', 'account/chatgptAuthTokens/refresh', 'attestation/generate',
    'item/somethingInventedLater']) {
    assert.equal(classifyServerRequest(other), 'other', other);
  }
});

test('approvalSummary: command, file_change and permissions summaries; other is empty', () => {
  assert.equal(approvalSummary('command', { command: 'git status', cwd: 'C:/repo', reason: 'check state' }),
    'git status — in C:/repo — reason: check state');
  assert.equal(approvalSummary('command', { command: 'ls' }), 'ls');
  assert.equal(approvalSummary('file_change', { reason: 'write the file', grantRoot: 'C:/repo/docs' }),
    'write the file — grant root: C:/repo/docs');
  assert.equal(approvalSummary('file_change', { reason: null }),
    'file change approval', 'no reason still reads sensibly');
  assert.equal(approvalSummary('permissions', {
    reason: 'network needed',
    permissions: { network: { enabled: true }, fileSystem: { read: ['C:/x'], write: null } },
  }), 'network needed — requests network access, file-system access');
  assert.equal(approvalSummary('other', {}), '');
});

test('approvalSummary: capped at 600 characters', () => {
  const summary = approvalSummary('command', { command: 'x'.repeat(700), reason: 'y'.repeat(50) });
  assert.equal(summary.length, 600, 'a 750-character raw summary is truncated to 600');
});

test('approvalResponse: command and file_change echo the decision, nothing more', () => {
  assert.deepEqual(approvalResponse('command', 'accept', {}), { decision: 'accept' });
  assert.deepEqual(approvalResponse('command', 'decline', {}), { decision: 'decline' });
  assert.deepEqual(approvalResponse('command', 'cancel', {}), { decision: 'cancel' });
  assert.deepEqual(approvalResponse('file_change', 'accept', {}), { decision: 'accept' });
  assert.deepEqual(approvalResponse('file_change', 'decline', {}), { decision: 'decline' });
});

test('approvalResponse: permissions decline grants nothing; accept grants the non-null parts, scope turn only', () => {
  const params = { permissions: { network: { enabled: true }, fileSystem: null } };
  assert.deepEqual(approvalResponse('permissions', 'decline', params), { permissions: {}, scope: 'turn' });
  assert.deepEqual(approvalResponse('permissions', 'cancel', params), { permissions: {}, scope: 'turn' });
  assert.deepEqual(approvalResponse('permissions', 'accept', params),
    { permissions: { network: { enabled: true } }, scope: 'turn' });
  assert.deepEqual(approvalResponse('permissions', 'accept', {
    permissions: { network: null, fileSystem: { read: null, write: ['C:/tmp'] } },
  }), { permissions: { fileSystem: { read: null, write: ['C:/tmp'] } }, scope: 'turn' });
  assert.deepEqual(approvalResponse('permissions', 'accept', {}),
    { permissions: {}, scope: 'turn' }, 'nothing requested, nothing granted');
  assert.equal(approvalResponse('other', 'accept', {}), null, 'the relay never answers an unanswerable request');
});

/** Strip // and /* comments, keeping string and template literals (test-only). */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'quote' = 'code';
  let quote = '';
  while (i < src.length) {
    const c = src[i] ?? '';
    const n = src[i + 1] ?? '';
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { mode = 'quote'; quote = c; out += c; i++; continue; }
      out += c; i++;
    } else if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; }
      i++;
    } else if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; i += 2; } else { if (c === '\n') out += c; i++; }
    } else {
      out += c;
      if (c === '\\') { out += n; i += 2; continue; }
      if (c === quote) mode = 'code';
      i++;
    }
  }
  return out;
}

const adapterSource = (): string =>
  readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'adapters', 'codex', 'adapter.ts'), 'utf8');

test('source guard: no session-wide grants anywhere in the adapter outside comments', () => {
  const src = stripComments(adapterSource());
  for (const banned of ['acceptForSession', 'acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment']) {
    assert.ok(!src.includes(banned), `${banned} must never appear in the adapter (outside comments)`);
  }
  assert.ok(!/['"]session['"]/.test(src), "the adapter never grants session scope — only 'turn'");
});

test('source guard: codex is answered only from the engine approval_answer handler and the Stop cancel', () => {
  const src = stripComments(adapterSource());
  // The one function that answers a GUI decision — its only call site must be
  // the engine approval_answer handler, before its own definition.
  const answerSites = [...src.matchAll(/\banswerApproval\(/g)].map((m) => m.index ?? -1);
  assert.equal(answerSites.length, 2, 'answerApproval: exactly one definition and one call site');
  const answerBranch = src.indexOf("record?.type === 'approval_answer'");
  const answerDefinition = src.indexOf('function answerApproval');
  assert.ok(answerBranch !== -1, 'the engine approval_answer handler exists');
  const answerCall = answerSites.find((index) => index !== answerDefinition) ?? -1;
  assert.ok(answerCall > answerBranch && answerCall < answerDefinition,
    'the only answerApproval call lives inside the approval_answer handler');
  // The raw response writer: definition + the answer + the Stop cancel, nothing else.
  const respondSites = [...src.matchAll(/\brespond\(/g)].map((m) => m.index ?? -1);
  assert.equal(respondSites.length, 3, 'respond: one definition, the answer call, the Stop-cancel call');
  // The Stop cancel itself runs only on the engine interrupt frame.
  const cancelSites = [...src.matchAll(/\bcancelPendingApprovals\(/g)].map((m) => m.index ?? -1);
  assert.equal(cancelSites.length, 2, 'cancelPendingApprovals: one definition and one call site');
  const interruptBranch = src.indexOf("record?.type === 'interrupt'");
  const cancelDefinition = src.indexOf('function cancelPendingApprovals');
  assert.ok(interruptBranch !== -1, 'the engine interrupt handler exists');
  const cancelCall = cancelSites.find((index) => index !== cancelDefinition) ?? -1;
  assert.ok(cancelCall > interruptBranch && cancelCall < src.indexOf('function unresolvedDeliveryError'),
    'the Stop cancel is chained only from the interrupt handler');
});
