// Test A — tests for relay/store.ts (docs/SPEC.md, Interfaces section).
// Zero dependencies: node:test, node:assert and the store's own node:sqlite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore, hashBody, StoreError, type RelayStore } from '../relay/store.ts';

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

function expectStoreError(code: 'duplicate' | 'relay_header' | 'not_found', fn: () => void): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof StoreError, `expected StoreError, got ${String(err)}`);
    assert.equal((err as StoreError).code, code);
    return;
  }
  assert.fail(`expected StoreError('${code}')`);
}

test('insertMessage stores the capture and queues one delivery row per target', () => {
  const { store, done } = freshStore('insert');
  try {
    const msg = store.insertMessage({ source: 'astra', targets: ['codex', 'user'], body: '  hello world  ', hop: 1 });
    assert.match(msg.id, ULID);
    assert.equal(msg.contentHash, hashBody('hello world')); // hashed after trimming
    assert.equal(msg.body, '  hello world  ');               // stored verbatim
    assert.equal(msg.hop, 1);
    assert.ok(msg.createdAt.endsWith('Z'));
    const pending = store.pendingDeliveries();
    assert.equal(pending.length, 2);
    assert.deepEqual(new Set(pending.map(p => p.target)), new Set(['codex', 'user']));
    assert.ok(pending.every(p => p.status === 'queued' && p.attempts === 0));
    assert.ok(pending.every(p => p.body === '  hello world  '));
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
    assert.equal(store.pendingDeliveries().length, 0); // nothing was stored
    // The header only decides as the first line; mentions later in the text are normal content:
    store.insertMessage({ source: 'user', targets: ['codex'], body: 'see [Relay · from Codex] in the transcript', hop: 0 });
    assert.equal(store.pendingDeliveries().length, 1);
    store.insertMessage({ source: 'astra', targets: ['codex'], body: '[Relaychat] prefix', hop: 0 });
    assert.equal(store.pendingDeliveries().length, 2);
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

test('failed and cancelled deliveries leave the pending list', () => {
  const { store, done } = freshStore('settled');
  try {
    const m1 = store.insertMessage({ source: 'astra', targets: ['codex'], body: 'one', hop: 0 });
    const m2 = store.insertMessage({ source: 'astra', targets: ['user'], body: 'two', hop: 0 });
    store.markStatus(m1.id, 'codex', 'failed');
    store.markStatus(m2.id, 'user', 'cancelled');
    assert.equal(store.pendingDeliveries().length, 0);
  } finally { done(); }
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
