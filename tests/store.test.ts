// Test A — tests for relay/store.ts (docs/SPEC.md, Interfaces section).
// Zero dependencies: node:test, node:assert and the store's own node:sqlite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore, hashBody, StoreError, ulid, type Participant, type RelayStore } from '../relay/store.ts';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const here = (...parts: string[]): string =>
  join(fileURLToPath(new URL('.', import.meta.url)), ...parts);

interface Fresh {
  store: RelayStore;
  dbPath: string;
  done: () => void;
}

/** A fresh temp dir + store. Call done() when finished to clean up. */
function freshStore(label: string): Fresh {
  const dir = mkdtempSync(join(tmpdir(), `relay-${label}-`));
  const dbPath = join(dir, 'relay.db');
  const store = openStore(dbPath);
  return { store, dbPath, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function expectStoreError(code: 'duplicate' | 'relay_header' | 'not_found' | 'settled' | 'invalid_targets', fn: () => void): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof StoreError, `expected StoreError, got ${String(err)}`);
    assert.equal((err as StoreError).code, code);
    return;
  }
  assert.fail(`expected StoreError('${code}')`);
}

test('insertMessage stores the capture; delivery rows wait for approval by default', () => {
  const { store, done } = freshStore('insert');
  try {
    const msg = store.insertMessage({ source: 'astra', targets: ['codex', 'user'], body: '  hello world  ', hop: 1 });
    assert.match(msg.id, ULID);
    assert.equal(msg.contentHash, hashBody('hello world')); // hashed after trimming
    assert.equal(msg.body, '  hello world  ');              // stored verbatim
    assert.equal(msg.hop, 1);
    assert.ok(msg.createdAt.endsWith('Z'));
    const pending = store.pendingDeliveries();
    assert.equal(pending.length, 2);
    assert.deepEqual(new Set(pending.map(p => p.target)), new Set(['codex', 'user']));
    assert.ok(pending.every(p => p.status === 'pending_approval' && p.attempts === 0));
    assert.ok(pending.every(p => p.body === '  hello world  '));
    // An explicit starting status is honored:
    store.insertMessage({ source: 'astra', targets: ['codex'], body: 'queued on purpose', hop: 1, initialStatus: 'queued' });
    const queued = store.pendingDeliveries().filter(p => p.body === 'queued on purpose');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].status, 'queued');
  } finally { done(); }
});

test('same content from the same source within 10 minutes is rejected as a duplicate', () => {
  const { store, done } = freshStore('dupe');
  try {
    const first = store.insertMessage({ source: 'astra', targets: ['codex'], body: 'ping', hop: 0 });
    assert.ok(store.isDuplicate('astra', first.contentHash));
    expectStoreError('duplicate', () =>
      store.insertMessage({ source: 'astra', targets: ['codex'], body: 'ping', hop: 0 }));
    // Whitespace-only differences hash the same, so they are duplicates too:
    expectStoreError('duplicate', () =>
      store.insertMessage({ source: 'astra', targets: ['codex'], body: '  ping  ', hop: 0 }));
    assert.equal(store.pendingDeliveries().length, 1); // only the first insert made it in
  } finally { done(); }
});

test('the same body from a different source is not a duplicate', () => {
  const { store, done } = freshStore('cross-source');
  try {
    store.insertMessage({ source: 'astra', targets: ['codex'], body: 'shared text', hop: 0 });
    store.insertMessage({ source: 'user', targets: ['codex'], body: 'shared text', hop: 0 });
    assert.equal(store.pendingDeliveries().length, 2); // two messages, one delivery each
  } finally { done(); }
});

test('the same content is accepted again 11 minutes later', () => {
  const { store, done } = freshStore('window');
  try {
    const elevenMinAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    store.insertMessage({ source: 'astra', targets: ['codex'], body: 'old', hop: 0, createdAt: elevenMinAgo });
    store.insertMessage({ source: 'astra', targets: ['codex'], body: 'old', hop: 0 }); // now: outside the window
    assert.equal(store.pendingDeliveries().length, 2);
  } finally { done(); }
});

test('a source_ref already stored is rejected whatever the body', () => {
  const { store, done } = freshStore('sourceref');
  try {
    store.insertMessage({ source: 'codex', targets: ['astra'], body: 'first turn', hop: 0, sourceRef: 'turn-42' });
    assert.ok(store.isDuplicate('codex', hashBody('something else'), 'turn-42'));
    expectStoreError('duplicate', () =>
      store.insertMessage({ source: 'codex', targets: ['astra'], body: 'different words', hop: 0, sourceRef: 'turn-42' }));
    assert.equal(store.pendingDeliveries().length, 1);
  } finally { done(); }
});

test('messages carrying the relay header are never stored as new captures', () => {
  const { store, done } = freshStore('header');
  try {
    const headerBody = '[Relay · from Codex · #01JA8TEST0000000000ATEST · hop 1]\nHere is the answer.';
    assert.ok(!store.isDuplicate('codex', hashBody(headerBody))); // rejected for the header, not as a duplicate
    expectStoreError('relay_header', () =>
      store.insertMessage({ source: 'codex', targets: ['astra'], body: headerBody, hop: 1 }));
    // Copied text often starts with blank lines or spaces — still caught after trimming:
    expectStoreError('relay_header', () =>
      store.insertMessage({ source: 'codex', targets: ['astra'], body: '  \n[Relay · from Codex · hop 1]\nanswer', hop: 1 }));
    assert.equal(store.pendingDeliveries().length, 0); // nothing was stored
    // The header only decides as the first line; mentions later in the text are normal content:
    store.insertMessage({ source: 'user', targets: ['codex'], body: 'see [Relay · from Codex] in the transcript', hop: 0 });
    assert.equal(store.pendingDeliveries().length, 1);
    store.insertMessage({ source: 'astra', targets: ['codex'], body: '[Relaychat] prefix', hop: 0 });
    assert.equal(store.pendingDeliveries().length, 2);
    // Leading whitespace without a header is ordinary text:
    store.insertMessage({ source: 'user', targets: ['codex'], body: '   \nindented, but no header', hop: 0 });
    assert.equal(store.pendingDeliveries().length, 3);
  } finally { done(); }
});

test('markStatus walks a delivery through its lifecycle; unknown rows are rejected', () => {
  const { store, done } = freshStore('lifecycle');
  try {
    const msg = store.insertMessage({ source: 'user', targets: ['codex'], body: 'go', hop: 0 });
    store.markStatus(msg.id, 'codex', 'delivering');
    const pending = store.pendingDeliveries();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'delivering');
    assert.equal(pending[0].attempts, 1); // each 'delivering' marks one attempt
    store.markStatus(msg.id, 'codex', 'pending_approval'); // back to hold, attempt count kept
    assert.equal(store.pendingDeliveries()[0].attempts, 1);
    store.markStatus(msg.id, 'codex', 'delivered');
    assert.equal(store.pendingDeliveries().length, 0);
    expectStoreError('not_found', () => store.markStatus(msg.id, 'user', 'queued')); // that row never existed
  } finally { done(); }
});

test('failed and cancelled deliveries leave the pending list; failed may retry', () => {
  const { store, done } = freshStore('settled');
  try {
    const m1 = store.insertMessage({ source: 'astra', targets: ['codex'], body: 'one', hop: 0 });
    const m2 = store.insertMessage({ source: 'astra', targets: ['user'], body: 'two', hop: 0 });
    store.markStatus(m1.id, 'codex', 'delivering');
    store.markStatus(m1.id, 'codex', 'failed');
    store.markStatus(m2.id, 'user', 'cancelled');
    assert.equal(store.pendingDeliveries().length, 0);
    // 'failed' is not final — the engine may requeue and retry:
    store.markStatus(m1.id, 'codex', 'delivering');
    const retried = store.pendingDeliveries();
    assert.equal(retried.length, 1);
    assert.equal(retried[0].attempts, 2);
  } finally { done(); }
});

test('a delivered or cancelled delivery never changes again', () => {
  const { store, done } = freshStore('terminal');
  try {
    const msg = store.insertMessage({ source: 'user', targets: ['codex', 'astra'], body: 'one message', hop: 0 });
    store.markStatus(msg.id, 'codex', 'delivering');
    store.markStatus(msg.id, 'codex', 'delivered');
    store.markStatus(msg.id, 'astra', 'cancelled');
    expectStoreError('settled', () => store.markStatus(msg.id, 'codex', 'queued'));
    expectStoreError('settled', () => store.markStatus(msg.id, 'codex', 'delivering'));
    expectStoreError('settled', () => store.markStatus(msg.id, 'astra', 'failed'));
    expectStoreError('settled', () => store.markStatus(msg.id, 'astra', 'cancelled'));
    expectStoreError('not_found', () => store.markStatus(msg.id, 'user', 'queued'));
  } finally { done(); }
});

test('recentMessages: an empty store returns an empty list', () => {
  const { store, done } = freshStore('recent-empty');
  try {
    assert.deepEqual(store.recentMessages(200), []);
  } finally { done(); }
});

test('recentMessages returns the newest limit messages, oldest first', () => {
  const { store, done } = freshStore('recent-limit');
  try {
    // Explicit ULIDs keep the order deterministic: the generated ids are only
    // millisecond-ordered — the 16-char suffix is random within one millisecond.
    store.insertMessage({ id: '0000000000000000000000000A', source: 'astra', targets: ['user'], body: 'oldest reply', hop: 0 });
    store.insertMessage({ id: '0000000000000000000000000B', source: 'codex', targets: ['user'], body: 'middle reply', hop: 0 });
    store.insertMessage({ id: '0000000000000000000000000C', source: 'astra', targets: ['user'], body: 'newest reply', hop: 0 });
    const recent = store.recentMessages(2);
    assert.deepEqual(recent.map((m) => m.id),
      ['0000000000000000000000000B', '0000000000000000000000000C'],
      'the newest two, oldest first (ids are ULIDs, so id order is time order)');
    assert.deepEqual(recent.map((m) => m.body), ['middle reply', 'newest reply']);
  } finally { done(); }
});

test('recentMessages fills targets from the deliveries rows, sorted', () => {
  const { store, done } = freshStore('recent-targets');
  try {
    const msg = store.insertMessage({ source: 'astra', targets: ['user', 'codex'], body: 'both targets', hop: 0 });
    const recent = store.recentMessages(10);
    assert.equal(recent.length, 1);
    const row = recent[0];
    assert.equal(row.id, msg.id);
    assert.deepEqual(row.targets, ['codex', 'user'], 'targets rebuilt from deliveries, sorted');
    assert.equal(row.body, 'both targets');
    assert.equal(row.source, 'astra');
    assert.equal(row.hop, 0);
    assert.equal(row.contentHash, hashBody('both targets'));
    assert.ok(row.createdAt.endsWith('Z'));
  } finally { done(); }
});

test('an empty targets list is rejected', () => {
  const { store, done } = freshStore('empty-targets');
  try {
    expectStoreError('invalid_targets', () =>
      store.insertMessage({ source: 'user', targets: [], body: 'goes nowhere', hop: 0 }));
    assert.equal(store.pendingDeliveries().length, 0);
  } finally { done(); }
});

test('createdAt is normalized to UTC on the way in', () => {
  const { store, done } = freshStore('timestamps');
  try {
    const msg = store.insertMessage({
      source: 'user', targets: ['codex'], body: 'tz check', hop: 0,
      createdAt: '2026-10-18T10:00:00-04:00',
    });
    assert.equal(msg.createdAt, '2026-10-18T14:00:00.000Z');
    // Invalid timestamps are rejected and store nothing:
    assert.throws(() =>
      store.insertMessage({ source: 'user', targets: ['codex'], body: 'bad date', hop: 0, createdAt: 'not a date' }));
    assert.equal(store.pendingDeliveries().length, 1);
  } finally { done(); }
});

test('a failure while writing deliveries rolls the message back', () => {
  const { store, done } = freshStore('atomic');
  try {
    const bogus = 'bogus' as unknown as Participant;
    assert.throws(() =>
      store.insertMessage({ source: 'astra', targets: [bogus], body: 'atomic insert', hop: 0 }));
    // The message must not survive a failed delivery insert:
    assert.equal(store.isDuplicate('astra', hashBody('atomic insert')), false);
    assert.equal(store.pendingDeliveries().length, 0);
    // The same body inserts cleanly once the bad target is gone:
    store.insertMessage({ source: 'astra', targets: ['codex'], body: 'atomic insert', hop: 0 });
    assert.equal(store.pendingDeliveries().length, 1);
  } finally { done(); }
});

test('ulid is monotonic: 1000 ids in a tight loop are strictly increasing', () => {
  let previous = '';
  for (let i = 0; i < 1000; i++) {
    const id = ulid();
    if (previous !== '') {
      assert.ok(previous < id,
        `id #${i} (${id}) must sort after the previous one (${previous}) — ` +
        'same-millisecond ids increment instead of redrawing (N1)');
    }
    previous = id;
  }
});

test('killing the process mid-delivery and restarting lists the message as pending, never delivered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-crash-'));
  const dbPath = join(dir, 'relay.db');
  try {
    const crashed = spawnSync(process.execPath, [here('crash-child.ts'), dbPath]);
    assert.ok(!(crashed.status === 0 && crashed.signal === null), 'child must not exit cleanly');
    const restarted = spawnSync(process.execPath, [here('restart-child.ts'), dbPath]);
    assert.equal(restarted.status, 0, String(restarted.stderr));
    const pending = JSON.parse(String(restarted.stdout)) as Array<{ status: string; body: string }>;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].body, 'crash me mid-delivery');
    assert.notEqual(pending[0].status, 'delivered');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
