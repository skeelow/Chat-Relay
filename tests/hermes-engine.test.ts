// M6.2 — Hermes as a third participant in the engine and the store.
// Tests the engine's hermes handling: hello/config, thread persistence,
// per-target ack timeout, send/forward targets, Stop interrupt, and the
// safety rule that nothing routes automatically into or out of Hermes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket as WsRawClient } from 'ws';
import {
  startEngine,
  type EngineHandle,
  DEFAULT_ACK_TIMEOUT_MS,
  HERMES_ACK_TIMEOUT_MS,
  HERMES_WORK_ACK_TIMEOUT_MS,
  hermesAckTimeoutMs,
} from '../relay/engine.ts';
import { hashBody } from '../relay/store.ts';
// M6.4d: the GUI's frame builders are pushed through this real engine — the
// exact JSON the picker/Kill/audit buttons send, not a hand-typed copy.
import { forwardFrameWithPerm, sendFrameWithPerm } from '../app/src/perm.ts';
import { killFrame } from '../app/src/deliveries.ts';
import { AUDIT_LIMIT, auditFrame } from '../app/src/audit.ts';

test('ack timeouts: Hermes 6 minutes, Codex 30 seconds', () => {
  assert.equal(HERMES_ACK_TIMEOUT_MS, 360000);
  assert.equal(DEFAULT_ACK_TIMEOUT_MS, 30000);
});

// M6.4b (D33): work/full rows must cover maxRunSec 3600 + 30 wall-clock + 60 slack.
test('M6.4b ack timeouts: hermes work/full = 3600+30+60 s, conversation stays 360 s', () => {
  assert.equal(HERMES_WORK_ACK_TIMEOUT_MS, (3600 + 30 + 60) * 1000);
  assert.equal(hermesAckTimeoutMs('work'), 3690000);
  assert.equal(hermesAckTimeoutMs('full'), 3690000);
  assert.equal(hermesAckTimeoutMs('conversation'), 360000);
  assert.equal(hermesAckTimeoutMs(undefined), 360000, 'a missing perm is conversation');
});

// --- minimal WebSocket client, mirroring tests/engine.test.ts ---

interface Frame { [key: string]: unknown; }

class Client {
  private readonly socket: WebSocket;
  private readonly queue: Frame[] = [];
  private readonly messageWaiters: Array<(m: Frame | null) => void> = [];
  private readonly closeWaiters: Array<(code: number | null) => void> = [];
  private closedCode: number | null = null;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.onmessage = (event) => {
      let frame: Frame;
      try { frame = JSON.parse(String(event.data)) as Frame; } catch { return; }
      const waiter = this.messageWaiters.shift();
      if (waiter !== undefined) waiter(frame); else this.queue.push(frame);
    };
    socket.onclose = (event) => {
      this.closedCode = event.code;
      for (const waiter of this.messageWaiters.splice(0)) waiter(null);
      for (const waiter of this.closeWaiters.splice(0)) waiter(event.code);
    };
  }

  static open(url: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.onopen = () => resolve(new Client(socket));
      socket.onerror = () => reject(new Error(`could not connect to ${url}`));
    });
  }

  summaryTolerant = true;

  send(frame: Frame): void {
    this.socket.send(JSON.stringify(frame));
  }

  async nextMessage(timeoutMs = 3000): Promise<Frame> {
    for (;;) {
      const queued = this.queue.shift();
      if (queued !== undefined) {
        if (queued.type === 'session_summary' && this.summaryTolerant) continue;
        return queued;
      }
      const frame = await new Promise<Frame | null>((resolve) => {
        let wrapper: (m: Frame | null) => void;
        const timer = setTimeout(() => {
          const index = this.messageWaiters.indexOf(wrapper);
          if (index !== -1) this.messageWaiters.splice(index, 1);
          resolve(null);
        }, timeoutMs);
        wrapper = (message) => { clearTimeout(timer); resolve(message); };
        this.messageWaiters.push(wrapper);
      });
      if (frame === null) throw new Error('timed out waiting for a message');
      if (frame.type === 'session_summary' && this.summaryTolerant) continue;
      return frame;
    }
  }

  async expectSilence(timeoutMs = 500): Promise<void> {
    for (;;) {
      const queued = this.queue.shift();
      if (queued !== undefined) {
        if (queued.type === 'session_summary' && this.summaryTolerant) continue;
        throw new Error(`expected silence, got ${JSON.stringify(queued)}`);
      }
      const frame = await new Promise<Frame | null>((resolve) => {
        let wrapper: (m: Frame | null) => void;
        const timer = setTimeout(() => {
          const index = this.messageWaiters.indexOf(wrapper);
          if (index !== -1) this.messageWaiters.splice(index, 1);
          resolve(null);
        }, timeoutMs);
        wrapper = (message) => { clearTimeout(timer); resolve(message); };
        this.messageWaiters.push(wrapper);
      });
      if (frame === null) return;
      if (frame.type === 'session_summary' && this.summaryTolerant) continue;
      throw new Error(`expected silence, got ${JSON.stringify(frame)}`);
    }
  }

  async expectClosed(timeoutMs = 3000): Promise<number | null> {
    if (this.closedCode !== null) return this.closedCode;
    const code = await new Promise<number | null>((resolve) => {
      let wrapper: (code: number | null) => void;
      const timer = setTimeout(() => {
        const index = this.closeWaiters.indexOf(wrapper);
        if (index !== -1) this.closeWaiters.splice(index, 1);
        resolve(NaN);
      }, timeoutMs);
      wrapper = (value) => { clearTimeout(timer); resolve(value); };
      this.closeWaiters.push(wrapper);
    });
    if (Number.isNaN(code)) throw new Error('timed out waiting for the connection to close');
    return code;
  }

  close(): void {
    this.socket.close();
  }
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function openClient(url: string, token: string): Promise<Client> {
  const client = await Client.open(url);
  client.send({ type: 'auth', token });
  return client;
}

async function openAdapter(url: string, token: string, name: string): Promise<Client> {
  const client = await openClient(url, token);
  client.send({ type: 'hello', name, version: '0.0.0-test' });
  return client;
}

async function openGui(url: string, token: string): Promise<Client> {
  const client = await openClient(url, token);
  client.send({ type: 'gui_hello' });
  const snapshot = await client.nextMessage();
  assert.equal(snapshot.type, 'snapshot');
  return client;
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (err) {
    console.warn(`[test] could not remove temp dir ${dir}: ${String(err)}`);
  }
}

async function withEngine(
  label: string,
  run: (engine: EngineHandle, url: string, token: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `relay-hermes-engine-${label}-`));
  const engine = await startEngine({
    port: 0,
    dbPath: join(dir, 'relay.db'),
    tokenPath: join(dir, 'token'),
  });
  const token = readFileSync(join(dir, 'token'), 'utf8').trim();
  const url = `ws://127.0.0.1:${engine.port}`;
  try {
    await run(engine, url, token);
  } finally {
    engine.stop();
    cleanupDir(dir);
  }
}

interface HermesAdapter { client: Client; config: Frame; }

// Open a hermes adapter and consume (and return) the config frame the engine
// sends after hello, so callers see only delivery traffic afterwards.
async function openHermesAdapter(url: string, token: string): Promise<HermesAdapter> {
  const client = await openAdapter(url, token, 'hermes');
  const config = await client.nextMessage();
  assert.equal(config.type, 'config', 'hermes hello must be answered with config');
  return { client, config };
}

test('hello hermes: accepts hermes, sends config {threadId: null} first', async () => {
  await withEngine('hello-hermes', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const { client: hermes, config } = await openHermesAdapter(url, token);
    assert.deepEqual(config, { type: 'config', threadId: null, threadIds: { work: null, full: null } },
      'config arrives right after hello, before any deliver');
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'hermes', status: 'idle' });
    const late = await openClient(url, token);
    late.send({ type: 'gui_hello' });
    const snapshot = await late.nextMessage() as { statuses?: Record<string, string> };
    assert.equal(snapshot.statuses?.hermes, 'idle', 'snapshot statuses include hermes');
  });
});

test('config arrives before a queued deliver', async () => {
  await withEngine('config-first', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const { client: hermes } = await openHermesAdapter(url, token);
    // config was consumed on hello (before any deliver); now a send to hermes:
    gui.send({ type: 'send', body: 'hi hermes', targets: ['hermes'] });
    const deliver = (await hermes.nextMessage()) as { type: string; messageId: string; text: string };
    assert.equal(deliver.type, 'deliver');
    assert.ok(String(deliver.text).startsWith('[Relay · from You · #'), 'exact relay header');
    assert.equal(deliver.text.split('\n')[1], 'hi hermes');
    hermes.send({ type: 'delivered', messageId: deliver.messageId });
    // Give the engine a tick to process the delivered frame.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(engine.store.getDelivery(deliver.messageId, 'hermes')?.status, 'delivered');
  });
});

test('thread persistence: config null, then stored id across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-hermes-thread-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  try {
    {
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const { client: hermes, config } = await openHermesAdapter(url, token);
      assert.deepEqual(config, { type: 'config', threadId: null, threadIds: { work: null, full: null } });
      hermes.send({ type: 'thread', threadId: 'h-1' });
      await pause(200);
      assert.equal(engine.store.getSetting('hermes_session_id'), 'h-1');
      engine.stop();
    }
    {
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const { client: hermes, config } = await openHermesAdapter(url, token);
      assert.deepEqual(config, { type: 'config', threadId: 'h-1', threadIds: { work: null, full: null } },
        'persisted thread returned in config after restart');
      engine.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('thread from a non-hermes socket is ignored', async () => {
  await withEngine('thread-ignore', async (engine, url, token) => {
    const astra = await openAdapter(url, token, 'astra');
    await astra.expectSilence(200);
    astra.send({ type: 'thread', threadId: 'should-not-stick' });
    await pause(300);
    assert.equal(engine.store.getSetting('hermes_session_id'), null, 'astra thread not stored as hermes session');
  });
});

// --- M6.4b2: one Hermes session per permission mode ---

test('M6.4b2 thread perm: work and full record their own keys; no perm is the conversation key', async () => {
  await withEngine('thread-perm', async (engine, url, token) => {
    const { client: hermes } = await openHermesAdapter(url, token);
    hermes.send({ type: 'thread', threadId: 'h-conv' });
    hermes.send({ type: 'thread', threadId: 'h-work', perm: 'work' });
    hermes.send({ type: 'thread', threadId: 'h-full', perm: 'full' });
    await pause(200);
    assert.equal(engine.store.getSetting('hermes_session_id'), 'h-conv');
    assert.equal(engine.store.getSetting('hermes_session_id_work'), 'h-work');
    assert.equal(engine.store.getSetting('hermes_session_id_full'), 'h-full');
  });
});

test('M6.4b2 thread with an invalid perm ignores the whole frame', async () => {
  await withEngine('thread-bad-perm', async (engine, url, token) => {
    const { client: hermes } = await openHermesAdapter(url, token);
    hermes.send({ type: 'thread', threadId: 'h-ok', perm: 'work' });
    await pause(200);
    hermes.send({ type: 'thread', threadId: 'h-bad', perm: 'everything' });
    hermes.send({ type: 'thread', threadId: 'h-bad2', perm: 7 });
    await pause(300);
    assert.equal(engine.store.getSetting('hermes_session_id_work'), 'h-ok', 'valid work thread stored');
    assert.equal(engine.store.getSetting('hermes_session_id'), null, 'invalid-perm frame stored nothing');
    assert.equal(engine.store.getSetting('hermes_session_id_full'), null);
  });
});

test('M6.4b2 thread perm from a non-hermes socket changes nothing', async () => {
  await withEngine('thread-perm-ignore', async (engine, url, token) => {
    const astra = await openAdapter(url, token, 'astra');
    astra.send({ type: 'thread', threadId: 'astra-should-not-stick', perm: 'work' });
    const codex = await openAdapter(url, token, 'codex');
    await pause(300);
    assert.equal(engine.store.getSetting('hermes_session_id_work'), null);
    assert.equal(engine.store.getSetting('hermes_session_id'), null);
    assert.equal(engine.store.getSetting('codex_thread_id'), null);
    codex.close();
  });
});

test('M6.4b2 config threadIds: all three session ids survive an engine restart and are resent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-hermes-threadids-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  try {
    {
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const { client: hermes } = await openHermesAdapter(url, token);
      hermes.send({ type: 'thread', threadId: 'pm-conv' });
      hermes.send({ type: 'thread', threadId: 'pm-work', perm: 'work' });
      hermes.send({ type: 'thread', threadId: 'pm-full', perm: 'full' });
      await pause(200);
      engine.stop();
    }
    {
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const { client: hermes, config } = await openHermesAdapter(url, token);
      assert.deepEqual(config, {
        type: 'config', threadId: 'pm-conv',
        threadIds: { work: 'pm-work', full: 'pm-full' },
      }, 'restart resends the conversation id and both mode session ids');
      engine.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('M6.4b2 codex config shape is unchanged (no threadIds)', async () => {
  await withEngine('codex-config-shape', async (_engine, url, token) => {
    const codex = await openAdapter(url, token, 'codex');
    const config = await codex.nextMessage();
    assert.deepEqual(config, { type: 'config', threadId: null }, 'codex gets the old config shape');
  });
});

test('@hermes send: queued row, exact header, delivered when adapter answers', async () => {
  await withEngine('send-hermes', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const { client: hermes } = await openHermesAdapter(url, token);
    gui.send({ type: 'send', body: 'hi hermes', targets: ['hermes'] });
    const deliver = (await hermes.nextMessage()) as { type: string; messageId: string; text: string };
    assert.equal(deliver.type, 'deliver');
    assert.ok(String(deliver.text).startsWith('[Relay · from You · #'), 'exact relay header');
    assert.equal(deliver.text.split('\n')[1], 'hi hermes');
    let row = engine.store.getDelivery(deliver.messageId, 'hermes');
    assert.equal(row?.status, 'delivering');
    hermes.send({ type: 'delivered', messageId: deliver.messageId });
    // Give the engine a tick to process the delivered frame.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(engine.store.getDelivery(deliver.messageId, 'hermes')?.status, 'delivered');
  });
});

test('hermes capture: stored with source hermes, dedupe, echo and header dropped', async () => {
  await withEngine('hermes-capture', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const { client: hermes } = await openHermesAdapter(url, token);
    await gui.nextMessage(); // status_update from hello

    hermes.send({ type: 'captured', body: 'from hermes', sourceRef: 'h-turn-1' });
    const update = await gui.nextMessage() as { type?: string; message?: { source?: string; body?: string } };
    assert.equal(update.type, 'transcript_update');
    assert.equal(update.message?.source, 'hermes');
    assert.equal(update.message?.body, 'from hermes');
    assert.ok(engine.store.isDuplicate('hermes', hashBody('from hermes')));

    // Duplicate source_ref dropped:
    hermes.send({ type: 'captured', body: 'from hermes', sourceRef: 'h-turn-1' });
    await gui.expectSilence(400);

    // Echo: hermes echoes back the text it was just delivered (with header) ->
    // dropped as relay_header, no new hermes message stored.
    const hermesBefore = engine.store.recentMessages(200).filter((m) => m.source === 'hermes').length;
    gui.send({ type: 'send', body: 'echo bait', targets: ['hermes'] });
    const deliver = (await hermes.nextMessage()) as { type: string; messageId: string; text: string };
    hermes.send({ type: 'delivered', messageId: deliver.messageId });
    hermes.send({ type: 'captured', body: deliver.text, sourceRef: 'h-turn-echo' });
    // Give the engine a tick to process both frames, then drain GUI broadcasts.
    await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 5; i++) {
      try { await gui.nextMessage(50); } catch { break; }
    }
    const hermesAfter = engine.store.recentMessages(200).filter((m) => m.source === 'hermes').length;
    assert.equal(hermesAfter, hermesBefore); // echo capture dropped, no new hermes message

    // Header dropped:
    hermes.send({ type: 'captured', body: '[Relay · from Astra · #01XYZ · hop 1]\nrelayed body', sourceRef: 'h-turn-hdr' });
    await gui.expectSilence(400);
  });
});

test('approve_each and auto: no automatic routing into or out of Hermes', async () => {
  await withEngine('no-auto-hermes', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const guiLog: Frame[] = [];
    let running = true;
    const loop = async () => {
      while (running) {
        try { guiLog.push(await gui.nextMessage(250)); } catch { /* keep polling */ }
      }
    };
    void loop();
    const { client: hermes } = await openHermesAdapter(url, token);
    const astra = await openAdapter(url, token, 'astra');
    const codex = await openAdapter(url, token, 'codex');
    await codex.nextMessage(); // codex config
    await astra.expectSilence(200);

    gui.send({ type: 'set_mode', mode: 'approve_each' });
    await pause(300);

    // A Hermes capture creates no row to anyone:
    hermes.send({ type: 'captured', body: 'hermes speaks', sourceRef: 'h-auto-1' });
    await pause(600);
    const hcap = engine.store.recentMessages(1)[0];
    assert.equal(engine.store.getDelivery(hcap.id, 'codex'), null, 'hermes capture -> no codex row');
    assert.equal(engine.store.getDelivery(hcap.id, 'astra'), null, 'hermes capture -> no astra row');
    assert.equal(guiLog.some((f) => f.type === 'countdown'), false, 'no countdown for hermes capture');

    // An Astra capture creates a row for Codex only, never Hermes:
    astra.send({ type: 'captured', body: 'astra speaks', sourceRef: 'a-auto-1' });
    await pause(600);
    const acap = engine.store.recentMessages(1)[0];
    assert.equal(engine.store.getDelivery(acap.id, 'codex')?.status, 'pending_approval', 'astra capture -> codex row');
    assert.equal(engine.store.getDelivery(acap.id, 'hermes'), null, 'astra capture -> no hermes row');

    // A Codex capture creates a row for Astra only, never Hermes:
    codex.send({ type: 'captured', body: 'codex speaks', sourceRef: 'c-auto-1' });
    await pause(600);
    const ccap = engine.store.recentMessages(1)[0];
    assert.equal(engine.store.getDelivery(ccap.id, 'astra')?.status, 'pending_approval', 'codex capture -> astra row');
    assert.equal(engine.store.getDelivery(ccap.id, 'hermes'), null, 'codex capture -> no hermes row');

    // Auto-send on: no countdown ever starts for a Hermes row.
    gui.send({ type: 'set_mode', mode: 'auto', autoSend: true, autoSendDelaySec: 3 });
    await pause(300);
    const hmsg = engine.store.insertMessage({ source: 'hermes', targets: ['user'], body: 'h manual', hop: 0 });
    engine.store.insertDelivery(hmsg.id, 'codex');
    engine.store.markStatus(hmsg.id, 'codex', 'queued');
    await pause(600);
    assert.equal(guiLog.some((f) => f.type === 'countdown' && f.messageId === hmsg.id), false, 'no countdown for a hermes row');
    running = false;
  });
});

test('manual forward Astra to Hermes and Hermes to Codex: needs approve, not blocked by cap', async () => {
  await withEngine('manual-hermes', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const { client: hermes } = await openHermesAdapter(url, token);
    const astra = await openAdapter(url, token, 'astra');
    await astra.expectSilence(200);

    // Astra capture, then manual forward Astra -> Hermes (turn cap 1, hop 2 — manual never blocked):
    gui.send({ type: 'set_mode', mode: 'auto', turnCap: 1 });
    await pause(300);
    const seed = engine.store.insertMessage({ source: 'user', targets: ['user'], body: 'seed', hop: 0 });
    engine.store.insertDelivery(seed.id, 'codex');
    engine.store.markStatus(seed.id, 'codex', 'queued');
    engine.store.markStatus(seed.id, 'codex', 'delivered');
    astra.send({ type: 'captured', body: 'astra says', sourceRef: 'mfh-1' });
    await pause(600);
    const astraCap = engine.store.recentMessages(1)[0];
    assert.equal(engine.store.getDelivery(astraCap.id, 'codex')?.status, 'pending_approval', 'astra -> codex row');
    assert.equal(engine.store.getDelivery(astraCap.id, 'hermes'), null, 'no hermes row from auto');

    gui.send({ type: 'forward', messageId: astraCap.id, target: 'hermes' });
    await pause(300);
    assert.equal(engine.store.getDelivery(astraCap.id, 'hermes')?.status, 'pending_approval', 'manual forward astra->hermes pending');
    gui.send({ type: 'approve', messageId: astraCap.id, target: 'hermes' });
    const deliver = (await hermes.nextMessage()) as { type: string; messageId: string; text: string };
    assert.equal(deliver.type, 'deliver');
    assert.ok(String(deliver.text).includes('[Relay · from Astra · #'), 'forward header from Astra');
    hermes.send({ type: 'delivered', messageId: deliver.messageId });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(engine.store.getDelivery(astraCap.id, 'hermes')?.status, 'delivered');

    // Manual forward a hermes capture to codex:
    hermes.send({ type: 'captured', body: 'hermes reply', sourceRef: 'mfh-2' });
    await pause(600);
    const hcap = engine.store.recentMessages(1)[0];
    assert.equal(engine.store.getDelivery(hcap.id, 'codex'), null, 'hermes capture -> no auto codex row');
    gui.send({ type: 'forward', messageId: hcap.id, target: 'codex' });
    await pause(300);
    assert.equal(engine.store.getDelivery(hcap.id, 'codex')?.status, 'pending_approval', 'manual forward hermes->codex pending');
  });
});

test('Stop sends interrupt to hermes and returns its rows to pending_approval', async () => {
  await withEngine('stop-hermes', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const { client: hermes } = await openHermesAdapter(url, token);
    gui.send({ type: 'send', body: 'stop me', targets: ['hermes'] });
    const deliver = (await hermes.nextMessage()) as { type: string; messageId: string; text: string };
    assert.equal(deliver.type, 'deliver');
    assert.equal(engine.store.getDelivery(deliver.messageId, 'hermes')?.status, 'delivering');
    gui.send({ type: 'stop' });
    await pause(300);
    // Interrupt received by the hermes adapter:
    assert.deepEqual(await hermes.nextMessage(), { type: 'interrupt' });
    assert.equal(engine.store.getDelivery(deliver.messageId, 'hermes')?.status, 'pending_approval', 'row back to pending after stop');
    assert.equal(engine.store.getDelivery(deliver.messageId, 'hermes')?.error, 'stopped before confirmation — it may already have arrived');
    // Resume delivers nothing:
    gui.send({ type: 'resume' });
    await pause(300);
    assert.equal(engine.store.getDelivery(deliver.messageId, 'hermes')?.status, 'pending_approval', 'resume delivers nothing');
    await hermes.expectSilence(300);
  });
});

test('replaced hermes adapter fails its in-flight rows', async () => {
  await withEngine('replace-hermes', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const { client: hermes1 } = await openHermesAdapter(url, token);
    gui.send({ type: 'send', body: 'in flight', targets: ['hermes'] });
    const deliver = (await hermes1.nextMessage()) as { type: string; messageId: string; text: string };
    assert.equal(deliver.type, 'deliver');
    assert.equal(engine.store.getDelivery(deliver.messageId, 'hermes')?.status, 'delivering');
    const { client: hermes2 } = await openHermesAdapter(url, token);
    await pause(300);
    assert.equal(engine.store.getDelivery(deliver.messageId, 'hermes')?.status, 'failed', 'replaced adapter fails in-flight row');
    assert.equal(engine.store.getDelivery(deliver.messageId, 'hermes')?.error, 'adapter replaced before confirming');
  });
});

test('restart resets delivering hermes rows to pending_approval and re-sends nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-hermes-restart-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  try {
    {
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const { client: hermes } = await openHermesAdapter(url, token);
      const id = engine.store.insertMessage({ source: 'user', targets: ['hermes'], body: 'restart me', hop: 0 }).id;
      engine.store.markStatus(id, 'hermes', 'queued');
      engine.store.markStatus(id, 'hermes', 'delivering');
      assert.equal(engine.store.getDelivery(id, 'hermes')?.status, 'delivering');
      engine.stop();
    }
    {
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      assert.equal(engine.store.getSetting('hermes_session_id'), null);
      const rows = engine.store.pendingDeliveries();
      assert.ok(rows.some((r) => r.status === 'pending_approval' && r.target === 'hermes'), 'delivering hermes row back to pending after restart');
      engine.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('session summary counts a hermes capture as a turn', async () => {
  await withEngine('summary-hermes', async (engine, url, token) => {
    const gui = await openGui(url, token);
    gui.summaryTolerant = false; // collector must see session_summary frames
    const guiLog: Frame[] = [];
    let running = true;
    const loop = async () => {
      while (running) {
        try { guiLog.push(await gui.nextMessage(250)); } catch { /* keep polling */ }
      }
    };
    void loop();
    const { client: hermes } = await openHermesAdapter(url, token);
    await hermes.expectSilence(200);
    hermes.send({ type: 'captured', body: 'hermes turn', sourceRef: 'h-sum-1' });
    await pause(600);
    const summaries = guiLog.filter((f) => f.type === 'session_summary');
    assert.equal(summaries[summaries.length - 1].turnsUsed, 1, 'hermes capture counts as a turn');
    running = false;
  });
});

// --- M6.4a: perm through the protocol, audit log, kill ---

test('M6.4a perm: send to hermes with perm=work stores it and the deliver frame carries it', async () => {
  await withEngine('perm-hermes', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const { client: hermes } = await openHermesAdapter(url, token);
    gui.send({ type: 'send', body: 'privileged please', targets: ['hermes'], perm: 'work' });
    const deliver = (await hermes.nextMessage()) as { type: string; messageId: string; perm?: string };
    assert.equal(deliver.type, 'deliver');
    assert.equal(deliver.perm, 'work', 'deliver frame to hermes carries perm');
    assert.equal(engine.store.getDeliveryPerm(deliver.messageId, 'hermes'), 'work', 'perm stored for the hermes row');
  });
});

test('M6.4a perm: astra/codex rows are always conversation even if the GUI sends work', async () => {
  await withEngine('perm-astra-codex', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    const codex = await openAdapter(url, token, 'codex');
    gui.send({ type: 'send', body: 'hi both', targets: ['astra', 'codex'], perm: 'work' });
    // codex (like hermes) gets a config frame on hello, so drain to the deliver.
    let aDeliver: { messageId: string } | null = null;
    for (let i = 0; i < 5 && aDeliver === null; i++) { const m = (await astra.nextMessage()) as { type: string; messageId: string }; if (m.type === 'deliver') aDeliver = m; }
    let cDeliver: { messageId: string } | null = null;
    for (let i = 0; i < 5 && cDeliver === null; i++) { const m = (await codex.nextMessage()) as { type: string; messageId: string }; if (m.type === 'deliver') cDeliver = m; }
    assert.ok(aDeliver !== null && cDeliver !== null, 'both adapters received a deliver frame');
    assert.equal(aDeliver!.messageId, cDeliver!.messageId, 'same message, two targets');
    assert.equal(engine.store.getDeliveryPerm(aDeliver!.messageId, 'astra'), 'conversation', 'astra forced to conversation');
    assert.equal(engine.store.getDeliveryPerm(cDeliver!.messageId, 'codex'), 'conversation', 'codex forced to conversation');
  });
});

test('M6.4a perm: an invalid perm value ignores the whole send frame', async () => {
  await withEngine('perm-invalid', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const { client: hermes } = await openHermesAdapter(url, token);
    const before = engine.store.recentMessages(50).length;
    gui.send({ type: 'send', body: 'bad perm', targets: ['hermes'], perm: 'everything' });
    await hermes.expectSilence(400);
    assert.equal(engine.store.recentMessages(50).length, before, 'no message stored for an invalid perm');
  });
});

test('M6.4a perm: forward stores perm on the hermes row; invalid perm forward ignored', async () => {
  await withEngine('perm-forward', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const id = engine.store.insertMessage({ source: 'astra', targets: ['user'], body: 'forward me', hop: 0 }).id;
    gui.send({ type: 'forward', messageId: id, target: 'hermes', perm: 'full' });
    await pause(200);
    assert.equal(engine.store.getDelivery(id, 'hermes')?.status, 'pending_approval', 'forward created a pending row');
    assert.equal(engine.store.getDeliveryPerm(id, 'hermes'), 'full', 'forward stored perm');
    const id2 = engine.store.insertMessage({ source: 'astra', targets: ['user'], body: 'forward me too', hop: 0 }).id;
    gui.send({ type: 'forward', messageId: id2, target: 'hermes', perm: 'bogus' });
    await pause(200);
    assert.equal(engine.store.getDelivery(id2, 'hermes'), null, 'invalid perm forward created no delivery row');
  });
});

test('M6.4a perm: survives an engine restart and is re-delivered with the same perm', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-m64a-restart-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  try {
    let messageId = '';
    {
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      messageId = engine.store.insertMessage({ source: 'user', targets: ['hermes'], body: 'restart perm', hop: 0 }).id;
      engine.store.setDeliveryPerm(messageId, 'hermes', 'work');
      engine.store.markStatus(messageId, 'hermes', 'queued');
      engine.store.markStatus(messageId, 'hermes', 'delivering');
      engine.stop();
    }
    {
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      assert.equal(engine.store.getDelivery(messageId, 'hermes')?.status, 'pending_approval', 'delivering row back to pending after restart');
      assert.equal(engine.store.getDeliveryPerm(messageId, 'hermes'), 'work', 'perm survived the restart');
      const gui = await openGui(url, token);
      const { client: hermes } = await openHermesAdapter(url, token);
      gui.send({ type: 'approve', messageId, target: 'hermes' });
      const deliver = (await hermes.nextMessage()) as { type: string; perm?: string };
      assert.equal(deliver.type, 'deliver');
      assert.equal(deliver.perm, 'work', 're-delivered with the same perm');
      engine.stop();
    }
  } finally { cleanupDir(dir); }
});

test('M6.4a perm: snapshot and delivery_update include perm for hermes rows only', async () => {
  await withEngine('perm-snapshot', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const { client: hermes } = await openHermesAdapter(url, token);
    gui.send({ type: 'send', body: 'perm snapshot', targets: ['hermes'], perm: 'full' });
    const deliver = (await hermes.nextMessage()) as { messageId: string };
    // delivery_update for the hermes row carries perm:
    const update = (await gui.nextMessage()) as { type: string; target?: string; perm?: string };
    // (the first gui frame after send is transcript_update; drain to the delivery_update)
    let du = update.type === 'delivery_update' ? update : null;
    for (let i = 0; i < 6 && du === null; i++) {
      const m = (await gui.nextMessage()) as { type: string; target?: string; perm?: string };
      if (m.type === 'delivery_update' && m.target === 'hermes') du = m;
    }
    assert.ok(du !== null, 'got a hermes delivery_update');
    assert.equal(du!.perm, 'full', 'delivery_update includes perm for the hermes row');
    // A fresh GUI's snapshot includes perm on the hermes delivery row:
    const gui2 = await openClient(url, token);
    gui2.send({ type: 'gui_hello' });
    const snap = (await gui2.nextMessage()) as { type: string; deliveries: Array<{ messageId: string; target: string; perm?: string }> };
    assert.equal(snap.type, 'snapshot');
    const hermesRow = snap.deliveries.find((d) => d.messageId === deliver.messageId && d.target === 'hermes') as { perm?: string } | undefined;
    assert.equal(hermesRow?.perm, 'full', 'snapshot hermes delivery row includes perm');
  });
});

test('M6.4a audit: hermes delivery started/delivered/failed audited; bodies never stored', async () => {
  await withEngine('audit-hermes', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const { client: hermes } = await openHermesAdapter(url, token);
    const secretBody = 'TOP-SECRET-BODY-XYZ';
    gui.send({ type: 'send', body: secretBody, targets: ['hermes'] });
    const deliver = (await hermes.nextMessage()) as { messageId: string };
    await pause(120);
    let entries = engine.store.recentAudit(50);
    assert.ok(entries.some((e) => e.event === 'hermes_delivering' && e.messageId === deliver.messageId), 'hermes_delivering audited');
    hermes.send({ type: 'delivered', messageId: deliver.messageId });
    await pause(150);
    entries = engine.store.recentAudit(50);
    assert.ok(entries.some((e) => e.event === 'hermes_delivered' && e.messageId === deliver.messageId), 'hermes_delivered audited');
    gui.send({ type: 'send', body: 'a second message', targets: ['hermes'] });
    const deliver2 = (await hermes.nextMessage()) as { messageId: string };
    hermes.send({ type: 'failed', messageId: deliver2.messageId, error: 'boom-detail' });
    await pause(150);
    entries = engine.store.recentAudit(50);
    const failedEntry = entries.find((e) => e.event === 'hermes_failed' && e.messageId === deliver2.messageId);
    assert.ok(failedEntry, 'hermes_failed audited');
    assert.equal(failedEntry!.detail, 'boom-detail', 'adapter error text stored in detail');
    for (const e of entries) {
      assert.ok(!String(e.detail ?? '').includes(secretBody), 'message body never appears in audit detail');
      assert.ok(!('body' in e), 'no body field on audit entries');
    }
  });
});

test('M6.4a audit: perm_requested audited for non-conversation send, not for conversation', async () => {
  await withEngine('audit-perm', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const { client: hermes } = await openHermesAdapter(url, token);
    gui.send({ type: 'send', body: 'work please', targets: ['hermes'], perm: 'work' });
    const deliver = (await hermes.nextMessage()) as { messageId: string };
    await pause(120);
    const pr = engine.store.recentAudit(50).find((e) => e.event === 'perm_requested' && e.messageId === deliver.messageId);
    assert.ok(pr, 'perm_requested audited for a send with work');
    assert.equal(pr!.detail, 'work');
    assert.equal(pr!.actor, 'gui');
    gui.send({ type: 'send', body: 'plain conversation', targets: ['hermes'] });
    const d2 = (await hermes.nextMessage()) as { messageId: string };
    await pause(120);
    const none = engine.store.recentAudit(50).filter((e) => e.event === 'perm_requested' && e.messageId === d2.messageId);
    assert.equal(none.length, 0, 'a conversation send does not audit perm_requested');
  });
});

// M6.4b: the hermes_delivering audit detail carries the perm; full adds a distinct event.
test('M6.4b audit: hermes_delivering detail carries the perm; full adds hermes_full_started', async () => {
  await withEngine('audit-perm-detail', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const { client: hermes } = await openHermesAdapter(url, token);
    gui.send({ type: 'send', body: 'work run body', targets: ['hermes'], perm: 'work' });
    const deliver = (await hermes.nextMessage()) as { messageId: string };
    await pause(120);
    let entries = engine.store.recentAudit(50);
    const hd = entries.find((e) => e.event === 'hermes_delivering' && e.messageId === deliver.messageId);
    assert.ok(hd, 'hermes_delivering audited for a work run');
    assert.equal(hd!.detail, 'work', 'hermes_delivering detail is the perm');
    assert.ok(!entries.some((e) => e.event === 'hermes_full_started' && e.messageId === deliver.messageId),
      'no hermes_full_started for a work run');
    gui.send({ type: 'send', body: 'full run body', targets: ['hermes'], perm: 'full' });
    const deliver2 = (await hermes.nextMessage()) as { messageId: string };
    await pause(120);
    entries = engine.store.recentAudit(50);
    const hd2 = entries.find((e) => e.event === 'hermes_delivering' && e.messageId === deliver2.messageId);
    assert.equal(hd2!.detail, 'full', 'hermes_delivering detail is the perm (full)');
    const fs = entries.find((e) => e.event === 'hermes_full_started' && e.messageId === deliver2.messageId);
    assert.ok(fs, 'hermes_full_started audited for a full run');
    assert.equal(fs!.actor, 'engine', 'hermes_full_started actor is engine');
    for (const e of entries) {
      assert.ok(!String(e.detail ?? '').includes('run body'), 'message body never appears in audit detail');
    }
  });
});

test('M6.4a audit: stop, kill and set_mode are audited', async () => {
  await withEngine('audit-ctl', async (engine, url, token) => {
    const gui = await openGui(url, token);
    gui.send({ type: 'set_mode', mode: 'manual' });
    await pause(100);
    gui.send({ type: 'stop' });
    await pause(100);
    gui.send({ type: 'resume' });
    await pause(100);
    gui.send({ type: 'kill' });
    await pause(120);
    const entries = engine.store.recentAudit(50);
    assert.ok(entries.some((e) => e.event === 'set_mode' && e.actor === 'gui'), 'set_mode audited');
    assert.ok(entries.some((e) => e.event === 'stop' && e.actor === 'gui'), 'stop audited');
    assert.ok(entries.some((e) => e.event === 'kill' && e.actor === 'gui'), 'kill audited');
  });
});

test('M6.4a audit: audit frame answered to the asking GUI only; non-GUI gets nothing', async () => {
  await withEngine('audit-frame', async (engine, url, token) => {
    const gui1 = await openGui(url, token);
    const gui2 = await openGui(url, token);
    gui1.send({ type: 'set_mode', mode: 'manual' }); // generate an audit entry
    await pause(120);
    gui1.send({ type: 'audit', requestId: 'r1', limit: 10 });
    let result: { type: string; requestId: string; entries: unknown[] } | null = null;
    for (let i = 0; i < 8 && result === null; i++) {
      const m = (await gui1.nextMessage()) as { type: string };
      if (m.type === 'audit_result') result = m as { type: string; requestId: string; entries: unknown[] };
    }
    assert.ok(result !== null, 'asking GUI receives audit_result');
    assert.equal(result!.requestId, 'r1');
    assert.ok(Array.isArray(result!.entries));
    assert.ok(result!.entries.some((e) => (e as { event?: string }).event === 'set_mode'), 'entries include the set_mode event');
    // gui2 never asked: drain its broadcasts and assert no audit_result arrives.
    let gui2GotResult = false;
    for (let i = 0; i < 12; i++) {
      try { const m = await gui2.nextMessage(120); if (m.type === 'audit_result') { gui2GotResult = true; break; } } catch { break; }
    }
    assert.equal(gui2GotResult, false, 'audit_result goes to the asking socket only');
    // A non-GUI (adapter) socket asking for audit gets nothing.
    const astra = await openAdapter(url, token, 'astra');
    astra.send({ type: 'audit', requestId: 'r2' });
    await astra.expectSilence(300);
  });
});

test('M6.4a kill: stopped state, kill to hermes, interrupt to codex, in-flight row back to pending', async () => {
  await withEngine('kill-frames', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const { client: hermes } = await openHermesAdapter(url, token);
    const codex = await openAdapter(url, token, 'codex');
    gui.send({ type: 'send', body: 'long run', targets: ['hermes'] });
    const deliver = (await hermes.nextMessage()) as { messageId: string };
    assert.equal(engine.store.getDelivery(deliver.messageId, 'hermes')?.status, 'delivering', 'hermes run in flight');
    gui.send({ type: 'kill' });
    let sawKill = false;
    for (let i = 0; i < 6; i++) { try { const m = await hermes.nextMessage(500); if (m.type === 'kill') { sawKill = true; break; } } catch { break; } }
    assert.ok(sawKill, 'hermes adapter receives {type:kill}');
    let sawInterrupt = false;
    for (let i = 0; i < 6; i++) { try { const m = await codex.nextMessage(500); if (m.type === 'interrupt') { sawInterrupt = true; break; } } catch { break; } }
    assert.ok(sawInterrupt, 'codex adapter receives {type:interrupt}');
    await pause(150);
    assert.equal(engine.store.getDelivery(deliver.messageId, 'hermes')?.status, 'pending_approval', 'in-flight row back to pending');
    assert.equal(engine.store.paused(), true, 'engine is stopped after kill');
  });
});

test('M6.4a kill: works when nothing is running (records audit + stopped state)', async () => {
  await withEngine('kill-idle', async (engine, url, token) => {
    const gui = await openGui(url, token);
    assert.equal(engine.store.paused(), false, 'engine starts running');
    gui.send({ type: 'kill' });
    await pause(150);
    assert.equal(engine.store.paused(), true, 'kill enters the stopped state even when idle');
    assert.ok(engine.store.recentAudit(50).some((e) => e.event === 'kill'), 'kill audited even when idle');
  });
});

// --- M6.4d: the GUI's builder frames, pushed through this real engine ---

test('M6.4d GUI builders through the real engine: work send, kill round-trip, audit_result', async () => {
  await withEngine('gui-builder-frames', async (_engine, url, token) => {
    const hermes = await openHermesAdapter(url, token);
    const gui = await openGui(url, token);
    // 1. The picker's send frame arrives with its perm on the deliver frame.
    gui.send(sendFrameWithPerm('builder body', ['hermes'], 'work'));
    const deliver = await hermes.client.nextMessage();
    assert.equal(deliver.type, 'deliver');
    assert.equal(deliver.perm, 'work', 'the send perm built in the GUI reaches the adapter');
    // 2. The Kill button's frame: in-flight row returns, engine stops, Hermes gets kill.
    gui.send(killFrame());
    let gotReturn = false;
    let gotPause = false;
    for (let i = 0; i < 6 && !(gotReturn && gotPause); i++) {
      const m = await gui.nextMessage();
      if (m.type === 'delivery_update' && m.status === 'pending_approval') gotReturn = true;
      if (m.type === 'pause_update' && m.paused === true) gotPause = true;
    }
    assert.ok(gotReturn, "the engine's kill reply returns the in-flight row to pending_approval");
    assert.ok(gotPause, 'the kill ends in the stopped state (the GUI confirmation follows it)');
    const killed = await hermes.client.nextMessage();
    assert.deepEqual(killed, { type: 'kill' }, 'the hermes adapter is told to kill its tree');
    // 3. The audit panel's frame: the engine answers with newest-first rows.
    gui.send(auditFrame('gui-a1'));
    let result: { type: string; requestId: string; entries: Array<{ id: number; event: string }> } | null = null;
    for (let i = 0; i < 8 && result === null; i++) {
      const m = await gui.nextMessage();
      if (m.type === 'audit_result' && m.requestId === 'gui-a1') {
        result = m as unknown as { type: string; requestId: string; entries: Array<{ id: number; event: string }> };
      }
    }
    assert.ok(result !== null, 'audit_result answers the frame built by the GUI');
    const ids = (result as { entries: Array<{ id: number }> }).entries.map((e) => e.id);
    assert.deepEqual([...ids].sort((a, b) => b - a), ids, 'entries come newest first');
    assert.ok(ids.length <= AUDIT_LIMIT, 'the asked limit is respected');
    const events = (result as { entries: Array<{ event: string }> }).entries.map((e) => e.event);
    assert.ok(events.includes('kill'), 'the kill shows in the audit rows');
    assert.ok(events.includes('perm_requested'), 'the work perm request shows in the audit rows');
    // 4. The forward builder never puts a perm on a non-Hermes frame.
    assert.deepEqual(forwardFrameWithPerm('m1', 'codex', 'work'),
      { type: 'forward', messageId: 'm1', target: 'codex' });
  });
});
