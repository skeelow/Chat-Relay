// Test A — tests for relay/store.ts (docs/SPEC.md, Interfaces section).
// Zero dependencies: node:test, node:assert and the store's own node:sqlite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore, hashBody, isOverTurnCap, validateModeUpdate, StoreError, ulid, type Participant, type RelayStore } from '../relay/store.ts';

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
  return { store, dbPath, done: () => { store.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 }); } catch { /* temp dir pruned after 24h */ } } };
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
  } finally { try { rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 }); } catch { /* temp dir pruned after 24h */ } }
});

// --- M2.1 ---

test('B4: ulid stays strictly increasing when the clock steps backwards', () => {
  const a = ulid(1_700_000_000_000);
  const b = ulid(1_700_000_000_000 - 5000);
  assert.ok(a < b, `a backwards clock step must not sort the new id first (${a} → ${b})`);
  const c = ulid(1_699_999_000_000);
  assert.ok(b < c, 'repeated backwards steps keep incrementing');
  assert.match(c, ULID);
});

test('resetInFlightToPending: queued and delivering rows wait for approval again', () => {
  const { store, done } = freshStore('reset');
  try {
    const one = store.insertMessage({ source: 'astra', targets: ['user'], body: 'queued one', hop: 0 });
    store.insertDelivery(one.id, 'codex');
    store.markStatus(one.id, 'codex', 'queued');
    const two = store.insertMessage({ source: 'astra', targets: ['user'], body: 'delivering one', hop: 0 });
    store.insertDelivery(two.id, 'codex');
    store.markStatus(two.id, 'codex', 'queued');
    store.markStatus(two.id, 'codex', 'delivering');

    assert.equal(store.resetInFlightToPending(), 2);
    const rows = store.pendingDeliveries().filter((p) => p.target === 'codex');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((p) => p.status === 'pending_approval'),
      'a restart must never resume a delivery on its own (hard rule: no replay)');
  } finally { done(); }
});

// --- M2.2 ---

test('getSetting/setSetting: round-trip, overwrite; a missing key returns null', () => {
  const { store, done } = freshStore('settings');
  try {
    assert.equal(store.getSetting('codex_thread_id'), null, 'a missing key reads back null');
    store.setSetting('codex_thread_id', 't-123');
    assert.equal(store.getSetting('codex_thread_id'), 't-123');
    store.setSetting('codex_thread_id', 't-456');
    assert.equal(store.getSetting('codex_thread_id'), 't-456', 'the second write overwrites');
    assert.equal(store.getSetting('something_else'), null, 'other keys are untouched');
  } finally { done(); }
});

// --- M3.2a: hop assignment, turn cap, honest restart notes ---

test('hopForCapture: 0 with nothing delivered; delivered hop + 1 once; 0 on a second capture', () => {
  const { store, done } = freshStore('hopfor');
  try {
    assert.equal(store.hopForCapture('codex'), 0, 'no delivery to codex yet → hop 0');

    // The user writes something (hop 0) and it is delivered to codex:
    const userMsg = store.insertMessage({ source: 'user', targets: ['codex'], body: 'please reply', hop: 0 });
    store.markStatus(userMsg.id, 'codex', 'queued');
    store.markStatus(userMsg.id, 'codex', 'delivering');
    store.markStatus(userMsg.id, 'codex', 'delivered');

    assert.equal(store.hopForCapture('codex'), 1, 'the first capture after the delivery continues the chain');
    const reply = store.insertMessage({ source: 'codex', targets: ['user'], body: 'a reply', hop: store.hopForCapture('codex') });
    assert.equal(reply.hop, 1);

    assert.equal(store.hopForCapture('codex'), 0, 'a second capture after the same delivery is hop 0 — the chain broke');

    // The reply itself is delivered on: the next participant continues from its hop.
    store.insertDelivery(reply.id, 'astra');
    store.markStatus(reply.id, 'astra', 'queued');
    store.markStatus(reply.id, 'astra', 'delivering');
    store.markStatus(reply.id, 'astra', 'delivered');
    assert.equal(store.hopForCapture('astra'), 2, 'astra continues the chain from the delivered hop 1');
  } finally { done(); }
});

test('hopForCapture: a restart between the delivery and the capture keeps the chain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-hoprestart-'));
  try {
    {
      const store = openStore(join(dir, 'relay.db'));
      const userMsg = store.insertMessage({ source: 'user', targets: ['codex'], body: 'pre-restart', hop: 0 });
      store.markStatus(userMsg.id, 'codex', 'queued');
      store.markStatus(userMsg.id, 'codex', 'delivering');
      store.markStatus(userMsg.id, 'codex', 'delivered');
      store.close();
    }
    {
      const store = openStore(join(dir, 'relay.db'));
      assert.equal(store.hopForCapture('codex'), 1, 'the delivered hop survives the restart');
      store.close();
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 }); } catch { /* temp dir pruned after 24h */ }
  }
});

test('turn_cap: defaults to 4; isOverTurnCap is hop >= cap', () => {
  const { store, done } = freshStore('turncap');
  try {
    assert.equal(store.turnCap(), 4, 'the SPEC default');
    store.setSetting('turn_cap', '2');
    assert.equal(store.turnCap(), 2);
    store.setSetting('turn_cap', 'not a number');
    assert.equal(store.turnCap(), 4, 'an invalid value falls back to the default, never to zero');
    assert.equal(isOverTurnCap(3, 4), false);
    assert.equal(isOverTurnCap(4, 4), true, 'the cap is inclusive: hop 4 at cap 4 is over');
    assert.equal(isOverTurnCap(5, 4), true);
  } finally { done(); }
});

test('resetInFlightToPending: a delivering row carries the interrupted note; a queued row restarts clean', () => {
  const { store, done } = freshStore('resetnotes');
  try {
    const flying = store.insertMessage({ source: 'codex', targets: ['user'], body: 'was delivering', hop: 0 });
    store.insertDelivery(flying.id, 'astra');
    store.markStatus(flying.id, 'astra', 'queued');
    store.markStatus(flying.id, 'astra', 'delivering');
    const waiting = store.insertMessage({ source: 'codex', targets: ['user'], body: 'was queued', hop: 0 });
    store.insertDelivery(waiting.id, 'astra');
    store.markStatus(waiting.id, 'astra', 'queued');

    assert.equal(store.resetInFlightToPending(), 2);
    const flyingRow = store.getDelivery(flying.id, 'astra');
    const waitingRow = store.getDelivery(waiting.id, 'astra');
    assert.equal(flyingRow?.status, 'pending_approval');
    assert.equal(flyingRow?.error, 'interrupted by a restart — it may already have arrived');
    assert.equal(waitingRow?.status, 'pending_approval');
    assert.equal(waitingRow?.error, null);
    // A second reset of settled rows is a no-op — the note is never re-applied.
    assert.equal(store.resetInFlightToPending(), 0);
  } finally { done(); }
});

// --- M3.2b: the persisted stopped state ---

test('paused accessors: absent reads false, "1" survives a reopen, clearing removes the key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-paused-'));
  try {
    {
      const store = openStore(join(dir, 'relay.db'));
      assert.equal(store.paused(), false, 'absent means running');
      store.setPaused(true);
      assert.equal(store.paused(), true);
      assert.equal(store.getSetting('paused'), '1', '"1" or absent — never "0"');
      store.close();
    }
    {
      const store = openStore(join(dir, 'relay.db'));
      assert.equal(store.paused(), true, 'the stopped state survives a restart');
      store.setPaused(false);
      assert.equal(store.paused(), false);
      assert.equal(store.getSetting('paused'), null, 'clearing removes the key entirely');
      store.close();
    }
  } finally {
    // Windows can EPERM on a just-released SQLite handle — best-effort retries.
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
    catch (err) { console.warn(`[test] could not remove temp dir ${dir}: ${String(err)}`); }
  }
});

test('markStatus: an informational note sticks to a pending_approval row (the Stop notes)', () => {
  const { store, done } = freshStore('pendingnote');
  try {
    const msg = store.insertMessage({ source: 'astra', targets: ['codex'], body: 'note carrier', hop: 0 });
    store.markStatus(msg.id, 'codex', 'queued');
    store.markStatus(msg.id, 'codex', 'delivering');
    store.markStatus(msg.id, 'codex', 'pending_approval', 'stopped — approve again after you resume');
    const row = store.getDelivery(msg.id, 'codex');
    assert.equal(row?.status, 'pending_approval');
    assert.equal(row?.error, 'stopped — approve again after you resume',
      'the stop note rides on the row, like the restart notes do');
    // Any ordinary transition clears it again — notes never linger stale:
    store.markStatus(msg.id, 'codex', 'queued');
    assert.equal(store.getDelivery(msg.id, 'codex')?.error, null);
  } finally { done(); }
});

// --- M4.2: the relay settings ---

test('relay settings: defaults, accessors and persistence across a reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-settings-'));
  try {
    {
      const store = openStore(join(dir, 'relay.db'));
      assert.equal(store.relayMode(), 'manual', 'the default mode');
      assert.equal(store.turnCap(), 4, 'the existing default cap');
      assert.equal(store.autoSend(), false, 'absent means off');
      assert.equal(store.autoSendDelaySec(), 10, 'the SPEC default');
      store.setRelayMode('approve_each');
      store.setTurnCap(7);
      store.setAutoSend(true);
      store.setAutoSendDelaySec(42);
      assert.equal(store.relayMode(), 'approve_each');
      assert.equal(store.turnCap(), 7);
      assert.equal(store.autoSend(), true);
      assert.equal(store.getSetting('auto_send'), '1', '"1" or absent — never another value');
      assert.equal(store.autoSendDelaySec(), 42);
      store.close();
    }
    {
      const store = openStore(join(dir, 'relay.db'));
      assert.equal(store.relayMode(), 'approve_each', 'the mode survives a restart');
      assert.equal(store.turnCap(), 7);
      assert.equal(store.autoSend(), true);
      assert.equal(store.autoSendDelaySec(), 42);
      store.setAutoSend(false);
      assert.equal(store.autoSend(), false);
      assert.equal(store.getSetting('auto_send'), null, 'clearing removes the key entirely');
      store.close();
    }
    {
      const store = openStore(join(dir, 'relay.db'));
      // M5.1: auto is a real mode now — it round-trips like the others.
      store.setRelayMode('auto');
      assert.equal(store.relayMode(), 'auto');
      store.close();
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
    catch (err) { console.warn(`[test] could not remove temp dir ${dir}: ${String(err)}`); }
  }
});

test('validateModeUpdate: good and bad values per field; one bad field poisons the frame', () => {
  assert.deepEqual(validateModeUpdate({}), {}, 'an empty frame is valid — it changes nothing');
  assert.deepEqual(validateModeUpdate({ mode: 'manual' }), { mode: 'manual' });
  assert.deepEqual(validateModeUpdate({ mode: 'approve_each' }), { mode: 'approve_each' });
  assert.deepEqual(validateModeUpdate({ mode: 'auto' }), { mode: 'auto' }, 'M5.1: auto is accepted now');
  assert.equal(validateModeUpdate({ mode: 'nonsense' }), null);
  assert.deepEqual(validateModeUpdate({ turnCap: 1 }), { turnCap: 1 });
  assert.deepEqual(validateModeUpdate({ turnCap: 50 }), { turnCap: 50 });
  assert.equal(validateModeUpdate({ turnCap: 0 }), null);
  assert.equal(validateModeUpdate({ turnCap: 51 }), null);
  assert.equal(validateModeUpdate({ turnCap: 4.5 }), null);
  assert.equal(validateModeUpdate({ turnCap: 'x' }), null);
  assert.deepEqual(validateModeUpdate({ autoSend: true }), { autoSend: true });
  assert.deepEqual(validateModeUpdate({ autoSend: false }), { autoSend: false });
  assert.equal(validateModeUpdate({ autoSend: 'yes' }), null);
  assert.deepEqual(validateModeUpdate({ autoSendDelaySec: 3 }), { autoSendDelaySec: 3 });
  assert.deepEqual(validateModeUpdate({ autoSendDelaySec: 1800 }), { autoSendDelaySec: 1800 });
  assert.equal(validateModeUpdate({ autoSendDelaySec: 2 }), null);
  assert.equal(validateModeUpdate({ autoSendDelaySec: 1801 }), null);
  assert.equal(validateModeUpdate({ autoSendDelaySec: 'later' }), null);
  assert.deepEqual(
    validateModeUpdate({ mode: 'approve_each', turnCap: 2, autoSend: true, autoSendDelaySec: 300 }),
    { mode: 'approve_each', turnCap: 2, autoSend: true, autoSendDelaySec: 300 });
  assert.equal(validateModeUpdate({ mode: 'manual', turnCap: 99 }), null,
    'one invalid field ignores the whole frame');
});

// --- M4.3: the search read query ---

test('searchMessages: case-insensitive; literal % and _; quotes and backslashes are safe', () => {
  const { store, done } = freshStore('search');
  try {
    const plant = (body: string): void => {
      store.insertMessage({ source: 'astra', targets: ['user'], body, hop: 0 });
    };
    plant('the NEEDLE is here');
    plant('profit 100% growth');
    plant('run at %growth speed');
    plant('snake_case naming');
    plant('plain body');
    plant('quote "it" and \\ backslash');

    const hits = (query: string): string[] => store.searchMessages(query, 100).messages.map((m) => m.body);
    assert.deepEqual(hits('needle'), ['the NEEDLE is here'], 'case-insensitive');
    assert.deepEqual(hits('100%'), ['profit 100% growth'], '% matches literally');
    assert.deepEqual(hits('%growth'), ['run at %growth speed'], 'a leading % is literal too');
    assert.deepEqual(hits('%'), ['run at %growth speed', 'profit 100% growth'],
      'a bare % matches only literal percent signs — never everything');
    assert.deepEqual(hits('snake_'), ['snake_case naming'], '_ matches literally');
    assert.equal(hits('_').length, 1, 'an escaped _ does not match every one-character window');
    assert.deepEqual(hits('"it" and \\'), ['quote "it" and \\ backslash'], 'a quote and a backslash in the query');
    assert.equal(store.searchMessages('nothing', 100).total, 0, 'a miss has no results and total 0');
  } finally { done(); }
});

test('searchMessages: limit 100, newest first, total counts past the limit', () => {
  const { store, done } = freshStore('searchlimit');
  try {
    for (let i = 0; i < 120; i++) {
      store.insertMessage({ source: 'astra', targets: ['user'], body: `matchword number ${i}`, hop: 0, sourceRef: `sr-${i}` });
    }
    const { messages, total } = store.searchMessages('matchword', 100);
    assert.equal(total, 120, 'total counts every match, past the limit');
    assert.equal(messages.length, 100, 'the newest 100 come back');
    for (let i = 1; i < messages.length; i++) {
      assert.equal(messages[i - 1].id > messages[i].id, true, `newest first at ${i}`);
    }
    assert.equal(messages[0].body, 'matchword number 119', 'the newest match leads');
  } finally { done(); }
});

// --- M6.2: the one-time user_version migration (hermes Participant) ---

/** The pre-M6.2 schema: CHECKs without 'hermes', user_version stays 0. */
const OLD_SCHEMA = `
  CREATE TABLE messages (
    id           TEXT PRIMARY KEY,
    source       TEXT NOT NULL CHECK (source IN ('user','astra','codex')),
    body         TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source_ref   TEXT,
    hop          INTEGER NOT NULL CHECK (hop >= 0),
    created_at   TEXT NOT NULL
  );
  CREATE UNIQUE INDEX messages_source_ref
    ON messages (source_ref) WHERE source_ref IS NOT NULL;
  CREATE INDEX messages_dedupe
    ON messages (source, content_hash, created_at);

  CREATE TABLE deliveries (
    message_id TEXT NOT NULL REFERENCES messages (id),
    target     TEXT NOT NULL CHECK (target IN ('user','astra','codex')),
    status     TEXT NOT NULL CHECK (status IN
      ('captured','pending_approval','queued','delivering','delivered','failed','cancelled')),
    attempts   INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    error      TEXT,\n    PRIMARY KEY (message_id, target)
  );

  CREATE TABLE settings (key   TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE adapter_state (adapter       TEXT PRIMARY KEY, last_seen_ref TEXT, updated_at    TEXT NOT NULL);
`;

function userVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  db.close();
  return row?.user_version ?? 0;
}

function columnCheck(dbPath: string, table: string, column: string): string | null {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table) as { sql: string } | undefined;
  db.close();
  if (row === undefined) return null;
  const m = row.sql.match(new RegExp(`CHECK \\(${column} IN \\(([^)]+)\\)\\)`));
  return m ? m[1] : null;
}

test('store: fresh database has the new CHECKs and user_version 1', () => {
  const { store, dbPath, done } = freshStore('mig-fresh');
  try {
    assert.equal(userVersion(dbPath), 1, 'fresh database starts at user_version 1');
    assert.equal(columnCheck(dbPath, 'messages', 'source'),
      "'user','astra','codex','hermes'", 'messages.source CHECK includes hermes');
    assert.equal(columnCheck(dbPath, 'deliveries', 'target'),
      "'user','astra','codex','hermes'", 'deliveries.target CHECK includes hermes');
    // Inserting a hermes message and delivery works on a fresh database.
    const msg = store.insertMessage({ source: 'hermes', targets: ['user'], body: 'hi from hermes', hop: 0 });
    store.insertDelivery(msg.id, 'hermes');
    assert.equal(store.getDelivery(msg.id, 'hermes')?.status, 'pending_approval');
  } finally { done(); }
});

test('store: old-schema database migrates with identical rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-mig-old-'));
  const dbPath = join(dir, 'relay.db');
  try {
    // Build an old-schema database and fill it (all five statuses, error values, a source_ref).
    const old = new DatabaseSync(dbPath);
    old.exec('PRAGMA foreign_keys = OFF;');
    old.exec(OLD_SCHEMA);
    const msg = old.prepare(
      'INSERT INTO messages (id, source, body, content_hash, source_ref, hop, created_at) VALUES (?,?,?,?,?,?,?)',
    );
    msg.run('m-1', 'astra', 'body one', hashBody('body one'), 'ref-1', 0, '2026-01-01T00:00:00Z');
    msg.run('m-2', 'codex', 'body two', hashBody('body two'), null, 1, '2026-01-02T00:00:00Z');
    const del = old.prepare(
      'INSERT INTO deliveries (message_id, target, status, attempts, updated_at, error) VALUES (?,?,?,?,?,?)',
    );
    del.run('m-1', 'codex', 'delivered', 2, '2026-01-01T01:00:00Z', null);
    del.run('m-2', 'astra', 'failed', 1, '2026-01-02T02:00:00Z', 'boom');
    old.exec('PRAGMA user_version = 0;'); // explicit: pre-M6.2
    old.close();

    assert.equal(userVersion(dbPath), 0, 'old database is at user_version 0');
    assert.equal(columnCheck(dbPath, 'messages', 'source'),
      "'user','astra','codex'", 'old messages CHECK lacks hermes');

    // Snapshot the old rows before migration.
    const oldRows = (() => {
      const db = new DatabaseSync(dbPath);
      const messages = db.prepare('SELECT * FROM messages ORDER BY id').all() as Record<string, unknown>[];
      const deliveries = db.prepare('SELECT * FROM deliveries ORDER BY message_id, target').all() as Record<string, unknown>[];
      db.close();
      return { messages, deliveries };
    })();

    // Open with openStore -> migration runs.
    const { store, done } = freshStore('mig-old-reuse');
    // freshStore makes its own db; instead open the migrated db directly:
    done();
    const migrated = openStore(dbPath);
    try {
      assert.equal(userVersion(dbPath), 1, 'migrated database is at user_version 1');
      assert.equal(columnCheck(dbPath, 'messages', 'source'),
        "'user','astra','codex','hermes'", 'migrated messages CHECK includes hermes');
      assert.equal(columnCheck(dbPath, 'deliveries', 'target'),
        "'user','astra','codex','hermes'", 'migrated deliveries CHECK includes hermes');

      // Row counts and every column identical after migration.
      // Re-read via a fresh store handle to compare raw rows.
      const check = openStore(dbPath);
      try {
        const db = new DatabaseSync(dbPath);
        const newMessages = db.prepare('SELECT * FROM messages ORDER BY id').all() as Record<string, unknown>[];
        const newDeliveries = db.prepare('SELECT * FROM deliveries ORDER BY message_id, target').all() as Record<string, unknown>[];
        db.close();
        assert.deepEqual(newMessages, oldRows.messages, 'messages rows identical after migration');
        assert.deepEqual(newDeliveries, oldRows.deliveries, 'deliveries rows identical after migration');
        assert.equal(newMessages.length, 2, 'message row count preserved');
        assert.equal(newDeliveries.length, 2, 'delivery row count preserved');
      } finally { check.close(); }

      // foreign_key_check is clean after migration.
      const fk = (() => {
        const db = new DatabaseSync(dbPath);
        const rows = db.prepare('PRAGMA foreign_key_check').all();
        db.close();
        return rows;
      })();
      assert.deepEqual(fk, [], 'foreign_key_check clean after migration');

      // Inserting a hermes message works after migration.
      const hmsg = migrated.insertMessage({ source: 'hermes', targets: ['user'], body: 'hermes now', hop: 0 });
      migrated.insertDelivery(hmsg.id, 'hermes');
      assert.equal(migrated.getDelivery(hmsg.id, 'hermes')?.status, 'pending_approval');

      // Re-opening is a no-op (user_version stays 1, rows unchanged).
      const again = openStore(dbPath);
      try {
        assert.equal(userVersion(dbPath), 1, 're-open keeps user_version 1');
        const db = new DatabaseSync(dbPath);
        const count = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
        db.close();
        assert.equal(count.n, 3, 're-open did not add or lose rows');
      } finally {
        again.close();
      }
    } finally { migrated.close(); }
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 }); } catch { /* temp dir pruned after 24h */ }
  }
});

test('store: inserting a hermes message fails on the old schema', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-mig-fail-'));
  const dbPath = join(dir, 'relay.db');
  try {
    const old = new DatabaseSync(dbPath);
    old.exec('PRAGMA foreign_keys = OFF;');
    old.exec(OLD_SCHEMA);
    old.close();
    assert.equal(userVersion(dbPath), 0, 'old database at user_version 0');

    // openStore migrates it to user_version 1.
    const store = openStore(dbPath);
    assert.equal(userVersion(dbPath), 1, 'migrated to user_version 1');
    // hermes insert now works.
    const msg = store.insertMessage({ source: 'hermes', targets: ['user'], body: 'ok', hop: 0 });
    assert.equal(msg.source, 'hermes');
    store.close();

    // Re-open a brand-new old-schema DB and confirm hermes is rejected pre-migration.
    const dbPath2 = join(dir, 'relay2.db');
    const old2 = new DatabaseSync(dbPath2);
    old2.exec(OLD_SCHEMA);
    old2.close();
    assert.throws(() => {
      const db = new DatabaseSync(dbPath2);
      db.prepare("INSERT INTO messages (id, source, body, content_hash, source_ref, hop, created_at) VALUES (?,?,?,?,?,?,?)")
        .run('x', 'hermes', 'h', hashBody('h'), null, 0, '2026-01-01T00:00:00Z');
      db.close();
    }, /CHECK constraint failed|constraint failed/, 'hermes source rejected by old CHECK');
    try { rmSync(dbPath2, { force: true, maxRetries: 15, retryDelay: 300 }); } catch { /* dbPath2 locked by leaked handle; pruned after 24h */ }
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 }); } catch { /* temp dir pruned after 24h */ }
  }
});

test('store: failed migration rolls back and leaves the old database untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-mig-rollback-'));
  const dbPath = join(dir, 'relay.db');
  try {
    // Old schema with a delivery that references a non-existent message
    // (a foreign-key violation that only foreign_key_check can catch).
    const old = new DatabaseSync(dbPath);
    old.exec('PRAGMA foreign_keys = OFF;');
    old.exec(OLD_SCHEMA);
    old.prepare('INSERT INTO messages (id, source, body, content_hash, source_ref, hop, created_at) VALUES (?,?,?,?,?,?,?)')
      .run('m-1', 'astra', 'body', hashBody('body'), null, 0, '2026-01-01T00:00:00Z');
    old.prepare('INSERT INTO deliveries (message_id, target, status, attempts, updated_at, error) VALUES (?,?,?,?,?,?)')
      .run('does-not-exist', 'codex', 'delivering', 0, '2026-01-01T01:00:00Z', null);
    old.close();
    assert.equal(userVersion(dbPath), 0, 'pre-migration user_version 0');

    // Migration should abort (foreign_key_check non-empty) and throw.
    assert.throws(() => openStore(dbPath), /migration aborted/, 'openStore throws on failed migration');

    // The database is left untouched: user_version still 0, old CHECK intact.
    assert.equal(userVersion(dbPath), 0, 'rollback left user_version at 0');
    assert.equal(columnCheck(dbPath, 'messages', 'source'),
      "'user','astra','codex'", 'rollback left the old CHECK intact');
    // And hermes is still rejected.
    assert.throws(() => {
      const db = new DatabaseSync(dbPath);
      db.prepare("INSERT INTO messages (id, source, body, content_hash, source_ref, hop, created_at) VALUES (?,?,?,?,?,?,?)")
        .run('x', 'hermes', 'h', hashBody('h'), null, 0, '2026-01-01T00:00:00Z');
      db.close();
    }, /CHECK constraint failed|constraint failed/, 'hermes still rejected after rolled-back migration');
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 }); } catch { /* temp dir pruned after 24h */ }
  }
});

// --- M6.2 migration: additional checks requested in review ---

test('store: fresh database does not run the migration rebuild', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-mig-norebuild-'));
  const dbPath = join(dir, 'relay.db');
  try {
    // Open a fresh database — no old tables exist, so the migration branch
    // must not run; SCHEMA creates everything directly.
    let msgId: string | null = null;
    const fresh = openStore(dbPath);
    try {
      assert.equal(userVersion(dbPath), 1, 'fresh database at user_version 1');
      assert.equal(columnCheck(dbPath, 'messages', 'source'),
        "'user','astra','codex','hermes'", 'fresh messages CHECK includes hermes');
      // Insert a marker and verify it survives (no rebuild wiped it).
      const msg = fresh.insertMessage({ source: 'user', targets: ['codex'], body: 'marker', hop: 0, sourceRef: 'marker-1' });
      msgId = msg.id;
    } finally {
      fresh.close(); // close fresh before opening again on the same db file
    }

    // Re-open: the marker survives, no rebuild ran.
    const again = openStore(dbPath);
    try {
      assert.equal(userVersion(dbPath), 1, 're-open keeps user_version 1');
      assert.notEqual(msgId, null, 'marker message id captured');
      const row = again.getDelivery(msgId!, 'codex');
      assert.equal(row?.status, 'pending_approval', 'marker delivery survived re-open');
      // No _old tables left behind by a migration.
      const db = new DatabaseSync(dbPath);
      const oldTables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_old'",
      ).all() as Array<{ name: string }>;
      db.close();
      assert.deepEqual(oldTables, [], 'no _old tables from a rebuild');
    } finally { again.close(); }
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 }); } catch { /* temp dir pruned after 24h */ }
  }
});

test('store: migrated database keeps messages_source_ref and messages_dedupe indexes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-mig-indexes-'));
  const dbPath = join(dir, 'relay.db');
  try {
    // Old-schema database WITH the error column (post-M2.1, pre-M6.2).
    const old = new DatabaseSync(dbPath);
    old.exec('PRAGMA foreign_keys = OFF;');
    old.exec(OLD_SCHEMA);
    old.prepare('INSERT INTO messages (id, source, body, content_hash, source_ref, hop, created_at) VALUES (?,?,?,?,?,?,?)')
      .run('m-1', 'astra', 'body one', hashBody('body one'), 'ref-1', 0, '2026-01-01T00:00:00Z');
    old.exec('PRAGMA user_version = 0;');
    old.close();
    assert.equal(userVersion(dbPath), 0, 'pre-migration user_version 0');

    // Snapshot index definitions before migration.
    const beforeIndexes = (() => {
      const db = new DatabaseSync(dbPath);
      const rows = db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' ORDER BY name",
      ).all() as Array<{ name: string; sql: string }>;
      db.close();
      return rows;
    })();
    const beforeNames = beforeIndexes.map((r) => r.name);

    // Migrate.
    const store = openStore(dbPath);
    try {
      assert.equal(userVersion(dbPath), 1, 'migrated to user_version 1');

      // Indexes exist after migration with the same names.
      const afterIndexes = (() => {
        const db = new DatabaseSync(dbPath);
        const rows = db.prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' ORDER BY name",
        ).all() as Array<{ name: string; sql: string }>;
        db.close();
        return rows;
      })();
      const afterNames = afterIndexes.map((r) => r.name);
      assert.ok(afterNames.includes('messages_source_ref'), 'messages_source_ref exists after migration');
      assert.ok(afterNames.includes('messages_dedupe'), 'messages_dedupe exists after migration');

      // The duplicate source_ref rule is still enforced (unique partial index works).
      expectStoreError('duplicate', () =>
        store.insertMessage({ source: 'codex', targets: ['user'], body: 'dup', hop: 0, sourceRef: 'ref-1' }),
      );

      // hermes inserts work after migration.
      const hmsg = store.insertMessage({ source: 'hermes', targets: ['user'], body: 'hermes ok', hop: 0 });
      store.insertDelivery(hmsg.id, 'hermes');
      assert.equal(store.getDelivery(hmsg.id, 'hermes')?.status, 'pending_approval');
    } finally { store.close(); }
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 }); } catch { /* temp dir pruned after 24h */ }
  }
});

test('store: error column survives migration when the old table lacks it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-mig-noerror-'));
  const dbPath = join(dir, 'relay.db');
  try {
    // Pre-M2.1 old schema: deliveries table WITHOUT the error column.
    const OLD_NO_ERROR = OLD_SCHEMA.replace(
      '    error      TEXT,\n    PRIMARY KEY (message_id, target)',
      '    PRIMARY KEY (message_id, target)',
    );
    const old = new DatabaseSync(dbPath);
    old.exec('PRAGMA foreign_keys = OFF;');
    old.exec(OLD_NO_ERROR);
    old.prepare('INSERT INTO messages (id, source, body, content_hash, source_ref, hop, created_at) VALUES (?,?,?,?,?,?,?)')
      .run('m-1', 'astra', 'body one', hashBody('body one'), null, 0, '2026-01-01T00:00:00Z');
    old.prepare('INSERT INTO deliveries (message_id, target, status, attempts, updated_at) VALUES (?,?,?,?,?)')
      .run('m-1', 'codex', 'queued', 2, '2026-01-01T01:00:00Z');
    old.exec('PRAGMA user_version = 0;');
    old.close();
    assert.equal(userVersion(dbPath), 0, 'pre-M2.1 old database at user_version 0');

    // Migrate — the error column must be added and the delivery preserved.
    const store = openStore(dbPath);
    try {
      assert.equal(userVersion(dbPath), 1, 'migrated to user_version 1');
      const row = store.getDelivery('m-1', 'codex');
      assert.equal(row?.status, 'queued', 'delivery row preserved across migration');
      assert.equal(row?.error, null, 'error column exists and is null for preserved rows');
      // The error column is writable after migration.
      store.markStatus('m-1', 'codex', 'failed', 'post-migration failure');
      assert.equal(store.getDelivery('m-1', 'codex')?.error, 'post-migration failure');
    } finally { store.close(); }
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 }); } catch { /* temp dir pruned after 24h */ }
  }
});
