// M1.2 — tests for relay/engine.ts: token auth, hello, status, captured → store,
// broadcasts to the GUI, and the read-only/no-replay rules. Uses Node's built-in
// WebSocket client against the engine's ws server on 127.0.0.1 with an
// OS-assigned port and temp token/db files per test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket as WsRawClient } from 'ws';
import { startEngine, type EngineHandle } from '../relay/engine.ts';
import { hashBody, isOverTurnCap } from '../relay/store.ts';

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

  /** M5.2: session_summary broadcasts follow every stored AI capture, hold
   *  and approval change. Tests written before M5.2 treat them as background
   *  chatter; a collector sets this to false to see every frame. */
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
      if (frame === null) return; // the window passed quietly
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

async function openClient(url: string, token: string): Promise<Client> {
  const client = await Client.open(url);
  client.send({ type: 'auth', token });
  return client;
}

async function openAdapter(url: string, token: string, name: string): Promise<Client> {
  const client = await openClient(url, token);
  client.send({ type: 'hello', name, version: '0.0.0-test' });
  if (name === 'codex') {
    // M2.2: every codex hello is followed by a config frame — consume it so
    // callers see only delivery traffic. The config tests read it raw below.
    const config = await client.nextMessage();
    assert.equal(config.type, 'config');
  }
  return client;
}

/** A GUI that authenticated and greeted: auth, gui_hello, consume the snapshot. */
async function openGui(url: string, token: string): Promise<Client> {
  const client = await openClient(url, token);
  client.send({ type: 'gui_hello' });
  const snapshot = await client.nextMessage();
  assert.equal(snapshot.type, 'snapshot');
  return client;
}

/**
 * Best-effort temp dir cleanup. On Windows a just-released handle (SQLite file,
 * async socket teardown, antivirus scan) can outlast every retry; test
 * assertions are the contract, so a stuck temp dir is warned about, not fatal.
 */
function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (err) {
    console.warn(`[test] could not remove temp dir ${dir}: ${String(err)}`);
  }
}

async function withEngine(
  label: string,
  run: (engine: EngineHandle, url: string, token: string, dir: string) => Promise<void>,
  options: { // M3.2b: tests may shorten the ack window; M5.1: inject the clock
    deliverAckTimeoutMs?: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `relay-engine-${label}-`));
  const engine = await startEngine({
    port: 0,
    dbPath: join(dir, 'relay.db'),
    tokenPath: join(dir, 'token'),
    ...options,
  });
  const token = readFileSync(join(dir, 'token'), 'utf8').trim(); // the file adapters read; value never printed
  const url = `ws://127.0.0.1:${engine.port}`;
  try {
    await run(engine, url, token, dir);
  } finally {
    engine.stop();
    cleanupDir(dir);
  }
}

test('auth: the token file is created; wrong or missing auth is rejected', async () => {
  await withEngine('auth', async (engine, url, token) => {
    assert.ok(engine.port > 0, 'engine reports its bound port');
    assert.match(token, /^[0-9a-f]{64}$/, 'a 32-byte hex token is generated');

    // Any frame before auth is an auth failure:
    const intruder = await Client.open(url);
    intruder.send({ type: 'hello', name: 'codex', version: '0' });
    assert.equal(await intruder.expectClosed(), 4401);

    // A wrong token is rejected:
    const wrong = await Client.open(url);
    wrong.send({ type: 'auth', token: `${token.slice(0, 63)}0` });
    assert.equal(await wrong.expectClosed(), 4401);

    // The right token keeps the connection open:
    const ok = await openClient(url, token);
    await ok.expectSilence(300);
    ok.close();
  });
});

test('hello: adapters register by participant name; unknown names are rejected', async () => {
  await withEngine('hello', async (_engine, url, token) => {
    const codex = await openAdapter(url, token, 'codex');
    const astra = await openAdapter(url, token, 'astra');
    await Promise.all([codex.expectSilence(300), astra.expectSilence(300)]);

    const bogus = await openClient(url, token);
    bogus.send({ type: 'hello', name: 'chatgpt-ext', version: '0' });
    assert.equal(await bogus.expectClosed(), 4400, 'only codex|astra are valid adapter names');
  });
});

test('captured: replies are stored and broadcast to the GUI, never pending', async () => {
  await withEngine('captured', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');

    // hello announces the adapter's initial status to GUIs:
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'idle' });

    codex.send({ type: 'captured', body: 'hello room', sourceRef: 'turn-1' });
    const update = await gui.nextMessage() as { type?: string; message?: Frame };
    assert.equal(update.type, 'transcript_update');
    const message = update.message as Record<string, unknown>;
    assert.equal(message.body, 'hello room');
    assert.equal(message.source, 'codex');
    assert.deepEqual(message.targets, ['user']);
    assert.equal(message.hop, 0);
    assert.match(String(message.id), /^[0-9A-HJKMNP-TV-Z]{26}$/, 'the engine assigned a ULID');
    assert.equal(message.contentHash, hashBody('hello room'));

    // The capture really reached the store — the duplicate rule sees it:
    assert.ok(engine.store.isDuplicate('codex', hashBody('hello room')));
    // And the read-only room holds nothing pending — 'captured' is not a pending status:
    assert.equal(engine.store.pendingDeliveries().length, 0);
  });
});

test('captured: duplicates are skipped, not re-broadcast', async () => {
  await withEngine('dupes', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // status_update from hello

    codex.send({ type: 'captured', body: 'repeat me', sourceRef: 'turn-2' });
    const first = await gui.nextMessage() as { message?: { body?: string } };
    assert.equal(first.message?.body, 'repeat me');

    // Same body, same sourceRef — the store rejects it as a duplicate:
    codex.send({ type: 'captured', body: 'repeat me', sourceRef: 'turn-2' });
    // The next broadcast the GUI receives must be the NEW capture, never a replay:
    codex.send({ type: 'captured', body: 'a different reply', sourceRef: 'turn-3' });
    const next = await gui.nextMessage() as { message?: { body?: string } };
    assert.equal(next.message?.body, 'a different reply');
  });
});

test('status: adapter statuses reach the GUI; a disconnect reports disconnected', async () => {
  await withEngine('status', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    await gui.nextMessage(); // idle from hello

    astra.send({ type: 'status', status: 'streaming' });
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'astra', status: 'streaming' });

    astra.send({ type: 'status', status: 'thinking' });
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'astra', status: 'thinking' });

    astra.close();
    assert.deepEqual(
      await gui.nextMessage(),
      { type: 'status_update', adapter: 'astra', status: 'disconnected' },
    );
  });
});

test('status: selectors_stale reaches the GUI, and recovery returns to idle', async () => {
  await withEngine('stale', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    await gui.nextMessage(); // idle from hello

    // M1.4 carry item 5: the astra adapter reports a stale-selector page
    // as a status so a chatgpt.com rename fails visibly.
    astra.send({ type: 'status', status: 'selectors_stale' });
    assert.deepEqual(await gui.nextMessage(),
      { type: 'status_update', adapter: 'astra', status: 'selectors_stale' });

    // Selectors working again (e.g. after an extension reload) recover:
    astra.send({ type: 'status', status: 'idle' });
    assert.deepEqual(await gui.nextMessage(),
      { type: 'status_update', adapter: 'astra', status: 'idle' });
  });
});

test('snapshot: a late GUI gets the current adapter statuses and the stored messages', async () => {
  await withEngine('snapshot', async (_engine, url, token) => {
    const codex = await openAdapter(url, token, 'codex');
    codex.send({ type: 'status', status: 'thinking' });
    codex.send({ type: 'captured', body: 'before the GUI joined', sourceRef: 'turn-snap-1' });

    const gui = await openClient(url, token);
    gui.send({ type: 'gui_hello' });
    const snapshot = await gui.nextMessage() as {
      type?: string;
      statuses?: Record<string, string>;
      messages?: Array<{ body?: string }>;
    };
    assert.equal(snapshot.type, 'snapshot');
    assert.deepEqual(snapshot.statuses, { codex: 'thinking', astra: 'disconnected' },
      'current statuses: codex said thinking; astra never connected');
    assert.deepEqual(snapshot.messages?.map((m) => m.body), ['before the GUI joined']);

    // The snapshot goes to that socket only, and exactly once:
    await gui.expectSilence(400);
    gui.send({ type: 'gui_hello' }); // a duplicate is ignored — one snapshot per connection
    await gui.expectSilence(400);
  });
});

test('snapshot after a restart: stored messages in order, nothing replayed as updates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-engine-snaprestart-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  try {
    // Run 1: two captures, a few milliseconds apart so their ULID time parts
    // differ (the suffix is random within one millisecond).
    {
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const codex = await openAdapter(`ws://127.0.0.1:${engine.port}`, token, 'codex');
      codex.send({ type: 'captured', body: 'first stored reply', sourceRef: 'turn-r1' });
      await new Promise((r) => setTimeout(r, 10));
      codex.send({ type: 'captured', body: 'second stored reply', sourceRef: 'turn-r2' });
      await new Promise((r) => setTimeout(r, 200)); // let the writes land
      engine.stop();
    }
    // Run 2: a GUI that greets gets the stored messages in order and no
    // transcript_update is ever pushed for them.
    {
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openClient(url, token);
      gui.send({ type: 'gui_hello' });
      const snapshot = await gui.nextMessage() as {
        type?: string;
        statuses?: Record<string, string>;
        messages?: Array<{ body?: string }>;
      };
      assert.equal(snapshot.type, 'snapshot');
      assert.deepEqual(snapshot.statuses, { codex: 'disconnected', astra: 'disconnected' },
        'a restart forgets adapter connections but not the stored transcript');
      assert.deepEqual(snapshot.messages?.map((m) => m.body),
        ['first stored reply', 'second stored reply'], 'stored messages, oldest first');
      await gui.expectSilence(500); // no transcript_update is pushed
      engine.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('a socket that never sends gui_hello receives no broadcasts', async () => {
  await withEngine('nogui', async (_engine, url, token) => {
    const bystander = await openClient(url, token); // authenticated, never greets
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'idle' });
    codex.send({ type: 'status', status: 'streaming' });
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'streaming' });
    codex.send({ type: 'captured', body: 'gui-only broadcast', sourceRef: 'turn-ng-1' });
    const update = await gui.nextMessage() as { type?: string; message?: { body?: string } };
    assert.equal(update.type, 'transcript_update');
    assert.equal(update.message?.body, 'gui-only broadcast');
    // The bystander saw none of it:
    await bystander.expectSilence(600);
  });
});

test('an adapter that sends gui_hello is closed 4400', async () => {
  await withEngine('adapterspam', async (_engine, url, token) => {
    const codex = await openAdapter(url, token, 'codex');
    codex.send({ type: 'gui_hello' });
    assert.equal(await codex.expectClosed(), 4400);
  });
});

test('a GUI that sends hello is closed 4400 (GUIs cannot be adapters)', async () => {
  await withEngine('guispam', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    gui.send({ type: 'hello', name: 'codex', version: '0.0.0-test' });
    assert.equal(await gui.expectClosed(), 4400);
  });
});

test('read-only: send/approve/set_mode/stop are ignored and store nothing', async () => {
  await withEngine('readonly', async (engine, url, token) => {
    const gui = await openClient(url, token);
    gui.send({ type: 'send', body: 'please send this', targets: ['codex'] });
    gui.send({ type: 'approve', messageId: 'x' });
    gui.send({ type: 'set_mode', mode: 'auto' });
    gui.send({ type: 'stop' });
    gui.send({ type: 'nonsense' });

    await gui.expectSilence(500);
    assert.equal(engine.store.isDuplicate('user', hashBody('please send this')), false,
      'an ignored send must not reach the store');
  });
});

test('no replay: a restart broadcasts nothing from the stored transcript', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-engine-noreplay-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  try {
    // Run 1: capture one reply into the store.
    {
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const codex = await openAdapter(`ws://127.0.0.1:${engine.port}`, token, 'codex');
      await new Promise((r) => setTimeout(r, 100));
      codex.send({ type: 'captured', body: 'persisted reply', sourceRef: 'turn-old' });
      await new Promise((r) => setTimeout(r, 200)); // let the write land
      engine.stop();
    }
    // Run 2: same db, same token. A GUI that greets gets exactly ONE frame
    // from the past — the snapshot carrying the stored transcript — and no
    // unsolicited frames after it. The stored rows are never re-sent as
    // transcript_update; only live events flow.
    {
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openClient(url, token);
      gui.send({ type: 'gui_hello' });
      const snapshot = await gui.nextMessage() as { type?: string; messages?: Array<{ body?: string }> };
      assert.equal(snapshot.type, 'snapshot');
      assert.deepEqual(snapshot.messages?.map((m) => m.body), ['persisted reply'],
        'the stored message arrives only inside the snapshot, never as an update');
      await gui.expectSilence(500); // nothing unsolicited: no transcript_update, no status_update
      // Live events flow as before:
      const codex = await openAdapter(url, token, 'codex');
      assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'idle' });
      codex.send({ type: 'captured', body: 'live reply', sourceRef: 'turn-new' });
      const update = await gui.nextMessage() as { type?: string; message?: { body?: string } };
      assert.equal(update.type, 'transcript_update');
      assert.equal(update.message?.body, 'live reply');
      engine.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('a malformed frame crashes nothing: the engine serves the next client normally', async () => {
  await withEngine('robust', async (engine, url, token) => {
    const gui = await openGui(url, token);

    // Handshake with the ws client, then write a masked text frame containing
    // invalid UTF-8 directly to the underlying socket.
    const bad = new WsRawClient(url);
    await new Promise<void>((resolve, reject) => {
      bad.once('open', resolve);
      bad.once('error', reject);
    });
    (bad as unknown as { _socket: { write(buf: Buffer): void } })._socket
      .write(Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0xff ^ 1, 0xfe ^ 2]));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      bad.once('close', () => { clearTimeout(timer); resolve(); });
    });

    // The engine must still be running and serving normally:
    const codex = await openAdapter(url, token, 'codex');
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'idle' });
    codex.send({ type: 'captured', body: 'still alive', sourceRef: 'turn-after-bad-frame' });
    const update = await gui.nextMessage() as { message?: { body?: string } };
    assert.equal(update.message?.body, 'still alive');
    assert.ok(engine.store.isDuplicate('codex', hashBody('still alive')));
  });
});

test('a replaced adapter is not reported as disconnected', async () => {
  await withEngine('replace', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const a = await openAdapter(url, token, 'codex');
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'idle' });

    const b = await openAdapter(url, token, 'codex');
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'idle' });

    // A raced capture from the replaced connection must be ignored:
    a.send({ type: 'captured', body: 'from replaced A', sourceRef: 'turn-a' });
    await a.expectClosed();
    await new Promise((r) => setTimeout(r, 200));
    await gui.expectSilence(400); // exactly idle, idle — no disconnected after B's hello
    assert.equal(engine.store.isDuplicate('codex', hashBody('from replaced A')), false,
      'a captured frame from the replaced connection must not be stored');

    b.close();
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'disconnected' });
  });
});

test('an empty token file is regenerated, not trusted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-engine-emptytoken-'));
  const tokenPath = join(dir, 'token');
  try {
    writeFileSync(tokenPath, '');
    const engine = await startEngine({ port: 0, dbPath: join(dir, 'relay.db'), tokenPath });
    try {
      const token = readFileSync(tokenPath, 'utf8').trim();
      assert.match(token, /^[0-9a-f]{64}$/, 'the token file was regenerated with a valid token');

      const url = `ws://127.0.0.1:${engine.port}`;
      const empty = await Client.open(url);
      empty.send({ type: 'auth', token: '' });
      assert.equal(await empty.expectClosed(), 4401);

      const good = await openClient(url, token);
      await good.expectSilence(300);
      good.close();
    } finally {
      engine.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('any frame before auth closes with 4401 and stores nothing', async () => {
  await withEngine('preauth', async (engine, url) => {
    const intruder = await Client.open(url);
    intruder.send({ type: 'captured', body: 'x' });
    assert.equal(await intruder.expectClosed(), 4401);
    // gui_hello is no exception — only authenticated sockets may send it:
    const guiIntruder = await Client.open(url);
    guiIntruder.send({ type: 'gui_hello' });
    assert.equal(await guiIntruder.expectClosed(), 4401);
    assert.equal(engine.store.isDuplicate('codex', hashBody('x')), false);
  });
});

// --- M2.1: forward / approve / reject / deliver workflow ---

/** Assert a delivery_update frame's payload, minus the timestamp text. */
function assertDeliveryUpdate(frame: Frame, messageId: string, target: string, status: string, attempts: number): void {
  assert.equal(frame.type, 'delivery_update', `expected a delivery_update, got ${JSON.stringify(frame)}`);
  assert.equal(frame.messageId, messageId);
  assert.equal(frame.target, target);
  assert.equal(frame.status, status);
  assert.equal(frame.attempts, attempts);
  assert.ok(typeof frame.updatedAt === 'string' && frame.updatedAt !== '', 'delivery_update carries updatedAt');
}

/** Capture one astra reply and return its message id (gui must be drained to the transcript_update). */
async function captureFromAstra(gui: Client, astra: Client, body: string, ref: string): Promise<string> {
  astra.send({ type: 'captured', body, sourceRef: ref });
  const update = await gui.nextMessage() as { message?: { id?: string } };
  const id = String(update.message?.id);
  assert.notEqual(id, '', 'the capture produced a message id');
  return id;
}

test('forward: a codex target gets a pending_approval row and one delivery_update; a second forward changes nothing', async () => {
  await withEngine('forward', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'astra', status: 'idle' });
    const id = await captureFromAstra(gui, astra, 'please relay me', 'turn-fwd-1');

    gui.send({ type: 'forward', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'pending_approval', 0);
    const row = engine.store.getDelivery(id, 'codex');
    assert.ok(row !== null && row.status === 'pending_approval');

    gui.send({ type: 'forward', messageId: id, target: 'codex' }); // idempotent
    await gui.expectSilence(400);
  });
});

test('forward: astra targets, a message\'s own source and unknown messages are ignored', async () => {
  await withEngine('forwardignored', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // astra idle
    await gui.nextMessage(); // codex idle
    const astraId = await captureFromAstra(gui, astra, 'not for astra', 'turn-fwd-2');
    const codexId = await captureFromAstra(gui, codex, 'not for codex either', 'turn-fwd-3');

    gui.send({ type: 'forward', messageId: astraId, target: 'astra' });   // only codex is a forward target in M2
    gui.send({ type: 'forward', messageId: codexId, target: 'codex' });   // target equals the message's source
    gui.send({ type: 'forward', messageId: 'UNKNOWN', target: 'codex' }); // unknown message
    await gui.expectSilence(400);

    assert.equal(engine.store.getDelivery(astraId, 'astra'), null, 'no astra-target row may exist');
    assert.equal(engine.store.getDelivery(codexId, 'codex'), null, 'a message is never forwarded to its own source');
  });
});

test('approve: the connected codex adapter receives one deliver with the exact relay header; the row goes delivering then delivered', async () => {
  await withEngine('approve', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // astra idle
    await gui.nextMessage(); // codex idle
    const id = await captureFromAstra(gui, astra, 'relay this body', 'turn-ap-1');

    gui.send({ type: 'forward', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'pending_approval', 0);

    gui.send({ type: 'approve', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivering', 1);

    const deliver = await codex.nextMessage();
    assert.equal(deliver.type, 'deliver');
    assert.equal(deliver.messageId, id);
    assert.equal(deliver.text, `[Relay · from Astra · #${id} · hop 1]\nrelay this body`);

    codex.send({ type: 'delivered', messageId: id });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivered', 1);
  });
});

test('approve twice: exactly one deliver is sent', async () => {
  await withEngine('approvetwice', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // astra idle
    await gui.nextMessage(); // codex idle
    const id = await captureFromAstra(gui, astra, 'just once please', 'turn-ap-2');

    gui.send({ type: 'forward', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'pending_approval', 0);
    gui.send({ type: 'approve', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivering', 1);
    assert.equal((await codex.nextMessage()).type, 'deliver');

    gui.send({ type: 'approve', messageId: id, target: 'codex' }); // the row is delivering — ignored
    await gui.expectSilence(300);
    await codex.expectSilence(300);
  });
});

test('approve with no codex adapter: the row queues and goes out exactly once when codex says hello', async () => {
  await withEngine('queuedhello', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    await gui.nextMessage(); // astra idle
    const id = await captureFromAstra(gui, astra, 'waiting for codex', 'turn-qh-1');

    gui.send({ type: 'forward', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'pending_approval', 0);
    gui.send({ type: 'approve', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'queued', 0);
    await gui.expectSilence(200);

    const codex = await openAdapter(url, token, 'codex');
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'idle' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivering', 1);

    const deliver = await codex.nextMessage();
    assert.equal(deliver.type, 'deliver');
    assert.equal(deliver.messageId, id);
    assert.equal(deliver.text, `[Relay · from Astra · #${id} · hop 1]\nwaiting for codex`);
    await codex.expectSilence(300); // exactly one deliver, ever
  });
});

test('reject: a pending row becomes cancelled (final); a later approve is ignored', async () => {
  await withEngine('reject', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    await gui.nextMessage(); // astra idle
    const id = await captureFromAstra(gui, astra, 'never mind', 'turn-rj-1');

    gui.send({ type: 'forward', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'pending_approval', 0);
    gui.send({ type: 'reject', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'cancelled', 0);

    gui.send({ type: 'approve', messageId: id, target: 'codex' });
    await gui.expectSilence(300);
    assert.equal(engine.store.getDelivery(id, 'codex')?.status, 'cancelled');
  });
});

test('delivered from the astra socket or a GUI socket is ignored', async () => {
  await withEngine('wrongack', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // astra idle
    await gui.nextMessage(); // codex idle
    const id = await captureFromAstra(gui, astra, 'only codex may confirm', 'turn-wa-1');

    gui.send({ type: 'forward', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'pending_approval', 0);
    gui.send({ type: 'approve', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivering', 1);
    assert.equal((await codex.nextMessage()).type, 'deliver');

    astra.send({ type: 'delivered', messageId: id }); // wrong adapter
    gui.send({ type: 'delivered', messageId: id });    // a GUI is not an adapter at all
    await gui.expectSilence(400);
    assert.equal(engine.store.getDelivery(id, 'codex')?.status, 'delivering',
      'a confirmation from the wrong socket changes nothing');

    codex.send({ type: 'delivered', messageId: id });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivered', 1);
  });
});

test('the target adapter disconnecting mid-delivery fails the row', async () => {
  await withEngine('disconnectfail', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // astra idle
    await gui.nextMessage(); // codex idle
    const id = await captureFromAstra(gui, astra, 'gone too soon', 'turn-df-1');

    gui.send({ type: 'forward', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'pending_approval', 0);
    gui.send({ type: 'approve', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivering', 1);
    assert.equal((await codex.nextMessage()).type, 'deliver');

    codex.close();
    const failed = await gui.nextMessage();
    assertDeliveryUpdate(failed, id, 'codex', 'failed', 1);
    assert.equal(failed.error, 'adapter disconnected before confirming');
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'disconnected' });
    assert.equal(engine.store.getDelivery(id, 'codex')?.error, 'adapter disconnected before confirming');
  });
});

test('the ack timer expires: the row fails with "no confirmation from adapter"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-engine-ackto-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  let engine: EngineHandle | undefined;
  try {
    engine = await startEngine({ port: 0, dbPath, tokenPath, deliverAckTimeoutMs: 80 });
    const token = readFileSync(tokenPath, 'utf8').trim();
    const url = `ws://127.0.0.1:${engine.port}`;
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // astra idle
    await gui.nextMessage(); // codex idle
    const id = await captureFromAstra(gui, astra, 'slow adapter', 'turn-ackto');

    gui.send({ type: 'forward', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'pending_approval', 0);
    gui.send({ type: 'approve', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivering', 1);
    assert.equal((await codex.nextMessage()).type, 'deliver'); // never confirmed

    const failed = await gui.nextMessage(3000);
    assertDeliveryUpdate(failed, id, 'codex', 'failed', 1);
    assert.equal(failed.error, 'no confirmation from adapter');
  } finally {
    engine?.stop();
    cleanupDir(dir);
  }
});

test('engine start resets queued and delivering rows to pending_approval; a connecting adapter gets nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-engine-reset-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  try {
    { // Run 1: one queued row, one delivering row.
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const queued = engine.store.insertMessage({ source: 'astra', targets: ['user'], body: 'queued one', hop: 0 });
      engine.store.insertDelivery(queued.id, 'codex');
      engine.store.markStatus(queued.id, 'codex', 'queued');
      const flying = engine.store.insertMessage({ source: 'astra', targets: ['user'], body: 'delivering one', hop: 0 });
      engine.store.insertDelivery(flying.id, 'codex');
      engine.store.markStatus(flying.id, 'codex', 'queued');
      engine.store.markStatus(flying.id, 'codex', 'delivering');
      engine.stop();
    }
    { // Run 2: the start reset put both back to pending_approval; codex hello delivers nothing.
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openGui(url, token);
      const codex = await openAdapter(url, token, 'codex');
      assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'idle' });
      await codex.expectSilence(400); // nothing goes out without a fresh approval
      await gui.expectSilence(400);
      const rows = engine.store.pendingDeliveries().filter((p) => p.target === 'codex');
      assert.equal(rows.length, 2);
      assert.ok(rows.every((p) => p.status === 'pending_approval'),
        'a restart must never resume a delivery on its own (hard rule: no replay)');
      engine.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('echo: a codex capture matching a recently delivered body is dropped; 11 minutes later it is stored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-engine-echo-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  const body = 'the echoed body text';
  try {
    { // Run 1: deliver to codex, then let codex "echo" the same body back.
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openGui(url, token);
      const astra = await openAdapter(url, token, 'astra');
      const codex = await openAdapter(url, token, 'codex');
      await gui.nextMessage(); // astra idle
      await gui.nextMessage(); // codex idle
      const id = await captureFromAstra(gui, astra, body, 'turn-echo-src');

      gui.send({ type: 'forward', messageId: id, target: 'codex' });
      assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'pending_approval', 0);
      gui.send({ type: 'approve', messageId: id, target: 'codex' });
      assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'queued', 0);
      assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivering', 1);
      assert.equal((await codex.nextMessage()).type, 'deliver');
      codex.send({ type: 'delivered', messageId: id });
      assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivered', 1);

      codex.send({ type: 'captured', body, sourceRef: 'turn-echo-1' }); // the echo, ~1 minute later
      await gui.expectSilence(400); // no transcript_update — silently dropped
      assert.equal(engine.store.isDuplicate('codex', hashBody(body)), false, 'the echo was never stored');
      engine.stop();
    }
    { // Backdate the delivery 11 minutes; restart: the same capture is now stored.
      const db = new DatabaseSync(dbPath);
      db.prepare('UPDATE deliveries SET updated_at = ? WHERE target = ?')
        .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), 'codex');
      db.close();

      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openGui(url, token);
      const codex = await openAdapter(url, token, 'codex');
      assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'idle' });
      codex.send({ type: 'captured', body, sourceRef: 'turn-echo-2' });
      const stored = await gui.nextMessage() as { type?: string; message?: { source?: string; body?: string } };
      assert.equal(stored.type, 'transcript_update', 'outside the echo window the capture is stored');
      assert.equal(stored.message?.source, 'codex');
      assert.equal(stored.message?.body, body);
      engine.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('the snapshot carries deliveries for the snapshot messages, minus user-target rows', async () => {
  await withEngine('snapshotdeliv', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    await gui.nextMessage(); // astra idle
    const id = await captureFromAstra(gui, astra, 'snapshot me', 'turn-snap-1');

    gui.send({ type: 'forward', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'pending_approval', 0);
    gui.send({ type: 'approve', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'queued', 0);

    const late = await openClient(url, token);
    late.send({ type: 'gui_hello' });
    const snap = await late.nextMessage() as {
      type?: string;
      deliveries?: Array<{ messageId?: string; target?: string; status?: string; attempts?: number }>;
    };
    assert.equal(snap.type, 'snapshot');
    assert.ok(Array.isArray(snap.deliveries), 'the snapshot carries a deliveries array');
    assert.equal(snap.deliveries?.length, 1, "the message's user-target row is not a delivery in the UI sense");
    const row = snap.deliveries?.[0];
    assert.equal(row?.messageId, id);
    assert.equal(row?.target, 'codex');
    assert.equal(row?.status, 'queued');
    assert.equal(row?.attempts, 0);
  });
});

// --- M2.2: config / thread / E1 / E2 ---

test('config: after codex hello the adapter receives the stored threadId, or null; a thread frame stores it', async () => {
  await withEngine('config', async (engine, url, token) => {
    // Raw hello — openAdapter drains the config frame, but this test reads it.
    const codex = await openClient(url, token);
    codex.send({ type: 'hello', name: 'codex', version: '0.0.0-test' });
    assert.deepEqual(await codex.nextMessage(), { type: 'config', threadId: null },
      'no thread recorded yet — config carries null');

    codex.send({ type: 'thread', threadId: 't-abc' });
    await new Promise((r) => setTimeout(r, 150)); // let the write land
    assert.equal(engine.store.getSetting('codex_thread_id'), 't-abc');

    // A fresh codex connection (the replacement) learns the recorded thread:
    const codex2 = await openClient(url, token);
    codex2.send({ type: 'hello', name: 'codex', version: '0.0.0-test' });
    assert.deepEqual(await codex2.nextMessage(), { type: 'config', threadId: 't-abc' });
  });
});

test('thread frames from astra or a GUI socket are ignored', async () => {
  await withEngine('threadguard', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'astra', status: 'idle' });

    astra.send({ type: 'thread', threadId: 'nope' });
    gui.send({ type: 'thread', threadId: 'nope' });
    await gui.expectSilence(400);
    assert.equal(engine.store.getSetting('codex_thread_id'), null, 'only codex may set the relay thread');
  });
});

test('E1: a late delivered upgrades a timed-out row; a genuinely failed row does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-engine-e1-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  let engine: EngineHandle | undefined;
  try {
    engine = await startEngine({ port: 0, dbPath, tokenPath, deliverAckTimeoutMs: 80 });
    const token = readFileSync(tokenPath, 'utf8').trim();
    const url = `ws://127.0.0.1:${engine.port}`;
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // astra idle
    await gui.nextMessage(); // codex idle

    // Row A: times out, then the adapter's late delivered arrives.
    const a = await captureFromAstra(gui, astra, 'timed out but arrived', 'turn-e1a');
    gui.send({ type: 'forward', messageId: a, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), a, 'codex', 'pending_approval', 0);
    gui.send({ type: 'approve', messageId: a, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), a, 'codex', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), a, 'codex', 'delivering', 1);
    assert.equal((await codex.nextMessage()).type, 'deliver');
    const timedOut = await gui.nextMessage(3000);
    assertDeliveryUpdate(timedOut, a, 'codex', 'failed', 1);
    assert.equal(timedOut.error, 'no confirmation from adapter');
    codex.send({ type: 'delivered', messageId: a }); // late — the turn did start
    assertDeliveryUpdate(await gui.nextMessage(), a, 'codex', 'delivered', 1);
    assert.equal(engine.store.getDelivery(a, 'codex')?.status, 'delivered');

    // Row B: a real failure from the adapter — a late delivered changes nothing.
    const b = await captureFromAstra(gui, astra, 'genuinely failed', 'turn-e1b');
    gui.send({ type: 'forward', messageId: b, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), b, 'codex', 'pending_approval', 0);
    gui.send({ type: 'approve', messageId: b, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), b, 'codex', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), b, 'codex', 'delivering', 1);
    assert.equal((await codex.nextMessage()).type, 'deliver');
    codex.send({ type: 'failed', messageId: b }); // the adapter itself reports failure
    const failed = await gui.nextMessage();
    assertDeliveryUpdate(failed, b, 'codex', 'failed', 1);
    assert.equal(failed.error, 'delivery failed');
    codex.send({ type: 'delivered', messageId: b }); // late ack after a real failure
    await gui.expectSilence(300);
    assert.equal(engine.store.getDelivery(b, 'codex')?.status, 'failed',
      'a late delivered must not resurrect a genuinely failed delivery');
  } finally {
    engine?.stop();
    cleanupDir(dir);
  }
});

test('E2: a replaced adapter fails its delivering rows immediately', async () => {
  await withEngine('replacedfail', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    const codexA = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // astra idle
    await gui.nextMessage(); // codex idle
    const id = await captureFromAstra(gui, astra, 'half confirmed', 'turn-e2');

    gui.send({ type: 'forward', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'pending_approval', 0);
    gui.send({ type: 'approve', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivering', 1);
    assert.equal((await codexA.nextMessage()).type, 'deliver');

    const codexB = await openAdapter(url, token, 'codex'); // replaces A
    const update = await gui.nextMessage();
    assertDeliveryUpdate(update, id, 'codex', 'failed', 1);
    assert.equal(update.error, 'adapter replaced before confirming');
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'idle' });
    assert.equal(engine.store.getDelivery(id, 'codex')?.error, 'adapter replaced before confirming');
  });
});

// --- M3.1: the astra direction (Codex → ChatGPT) ---

/** Capture one codex reply and return its message id (gui drained to the transcript_update). */
async function captureFromCodex(gui: Client, codex: Client, body: string, ref: string): Promise<string> {
  codex.send({ type: 'captured', body, sourceRef: ref });
  const update = await gui.nextMessage() as { message?: { id?: string } };
  const id = String(update.message?.id);
  assert.notEqual(id, '', 'the codex capture produced a message id');
  return id;
}

test('astra is a valid forward target: a codex message forwards; a self-forward is still ignored', async () => {
  await withEngine('forwardastra', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    const astra = await openAdapter(url, token, 'astra');
    await gui.nextMessage(); // codex idle
    await gui.nextMessage(); // astra idle
    const codexId = await captureFromCodex(gui, codex, 'route me to chatgpt', 'turn-m31-1');
    const astraId = await captureFromAstra(gui, astra, 'not to myself', 'turn-m31-2');

    gui.send({ type: 'forward', messageId: codexId, target: 'astra' });
    assertDeliveryUpdate(await gui.nextMessage(), codexId, 'astra', 'pending_approval', 0);
    const row = engine.store.getDelivery(codexId, 'astra');
    assert.ok(row !== null && row.status === 'pending_approval');

    gui.send({ type: 'forward', messageId: astraId, target: 'astra' }); // target equals the source
    await gui.expectSilence(400);
    assert.equal(engine.store.getDelivery(astraId, 'astra'), null, 'a message never forwards to its own source');
  });
});

test('deliver to astra: approve sends the exact from-Codex header, and delivered settles the row', async () => {
  await withEngine('approvastra', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    const astra = await openAdapter(url, token, 'astra');
    await gui.nextMessage(); // codex idle
    await gui.nextMessage(); // astra idle
    const id = await captureFromCodex(gui, codex, 'type this into chatgpt', 'turn-m31-3');

    gui.send({ type: 'forward', messageId: id, target: 'astra' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'pending_approval', 0);
    gui.send({ type: 'approve', messageId: id, target: 'astra' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'delivering', 1);

    const deliver = await astra.nextMessage();
    assert.equal(deliver.type, 'deliver');
    assert.equal(deliver.messageId, id);
    assert.equal(deliver.text, `[Relay · from Codex · #${id} · hop 1]\ntype this into chatgpt`);

    astra.send({ type: 'delivered', messageId: id });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'delivered', 1);
  });
});

test('approve to astra with no extension connected: queued until the astra hello flushes it once', async () => {
  await withEngine('queuedastra', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // codex idle
    const id = await captureFromCodex(gui, codex, 'waiting for the extension', 'turn-m31-4');

    gui.send({ type: 'forward', messageId: id, target: 'astra' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'pending_approval', 0);
    gui.send({ type: 'approve', messageId: id, target: 'astra' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'queued', 0);
    await gui.expectSilence(200);

    const astra = await openAdapter(url, token, 'astra');
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'astra', status: 'idle' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'delivering', 1);
    const deliver = await astra.nextMessage();
    assert.equal(deliver.type, 'deliver');
    assert.equal(deliver.messageId, id);
    await astra.expectSilence(300); // exactly one deliver, ever
  });
});

test('engine start resets astra rows to pending_approval; a connecting extension gets nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-engine-reset-astra-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  try {
    { // Run 1: one queued astra row, one delivering astra row.
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const queued = engine.store.insertMessage({ source: 'codex', targets: ['user'], body: 'queued one', hop: 0 });
      engine.store.insertDelivery(queued.id, 'astra');
      engine.store.markStatus(queued.id, 'astra', 'queued');
      const flying = engine.store.insertMessage({ source: 'codex', targets: ['user'], body: 'delivering one', hop: 0 });
      engine.store.insertDelivery(flying.id, 'astra');
      engine.store.markStatus(flying.id, 'astra', 'queued');
      engine.store.markStatus(flying.id, 'astra', 'delivering');
      engine.stop();
    }
    { // Run 2: both astra rows wait for approval again; astra hello delivers nothing.
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openGui(url, token);
      const astra = await openAdapter(url, token, 'astra');
      assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'astra', status: 'idle' });
      await astra.expectSilence(400);
      await gui.expectSilence(400);
      const rows = engine.store.pendingDeliveries().filter((p) => p.target === 'astra');
      assert.equal(rows.length, 2);
      assert.ok(rows.every((p) => p.status === 'pending_approval'));
      engine.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('echo applies to the astra direction: a capture matching a body delivered to astra is dropped', async () => {
  await withEngine('echoastra', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    const astra = await openAdapter(url, token, 'astra');
    await gui.nextMessage(); // codex idle
    await gui.nextMessage(); // astra idle
    const body = 'the astra echo body';
    const id = await captureFromCodex(gui, codex, body, 'turn-m31-5');

    gui.send({ type: 'forward', messageId: id, target: 'astra' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'pending_approval', 0);
    gui.send({ type: 'approve', messageId: id, target: 'astra' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'delivering', 1);
    assert.equal((await astra.nextMessage()).type, 'deliver');
    astra.send({ type: 'delivered', messageId: id });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'delivered', 1);

    astra.send({ type: 'captured', body, sourceRef: 'turn-m31-echo' }); // the echo back
    await gui.expectSilence(400); // no transcript_update — silently dropped
    assert.equal(engine.store.isDuplicate('astra', hashBody(body)), false, 'the echo was never stored');
  });
});

test('E1 for astra: a late delivered upgrades a timed-out astra row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-engine-e1astra-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  let engine: EngineHandle | undefined;
  try {
    engine = await startEngine({ port: 0, dbPath, tokenPath, deliverAckTimeoutMs: 80 });
    const token = readFileSync(tokenPath, 'utf8').trim();
    const url = `ws://127.0.0.1:${engine.port}`;
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    const astra = await openAdapter(url, token, 'astra');
    await gui.nextMessage(); // codex idle
    await gui.nextMessage(); // astra idle
    const id = await captureFromCodex(gui, codex, 'typed but slow to confirm', 'turn-m31-6');

    gui.send({ type: 'forward', messageId: id, target: 'astra' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'pending_approval', 0);
    gui.send({ type: 'approve', messageId: id, target: 'astra' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'delivering', 1);
    assert.equal((await astra.nextMessage()).type, 'deliver');

    const timedOut = await gui.nextMessage(3000);
    assertDeliveryUpdate(timedOut, id, 'astra', 'failed', 1);
    assert.equal(timedOut.error, 'no confirmation from adapter');
    astra.send({ type: 'delivered', messageId: id }); // the late ack
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'delivered', 1);
  } finally {
    engine?.stop();
    cleanupDir(dir);
  }
});

test('E2 for astra: a replaced extension fails its delivering rows immediately', async () => {
  await withEngine('replacedastra', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    const astraA = await openAdapter(url, token, 'astra');
    await gui.nextMessage(); // codex idle
    await gui.nextMessage(); // astra idle
    const id = await captureFromCodex(gui, codex, 'extension swapped mid-typing', 'turn-m31-7');

    gui.send({ type: 'forward', messageId: id, target: 'astra' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'pending_approval', 0);
    gui.send({ type: 'approve', messageId: id, target: 'astra' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'delivering', 1);
    assert.equal((await astraA.nextMessage()).type, 'deliver');

    const astraB = await openAdapter(url, token, 'astra'); // replaces A
    const update = await gui.nextMessage();
    assertDeliveryUpdate(update, id, 'astra', 'failed', 1);
    assert.equal(update.error, 'adapter replaced before confirming');
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'astra', status: 'idle' });
    assert.equal(engine.store.getDelivery(id, 'astra')?.error, 'adapter replaced before confirming');
  });
});

// --- M3.2a: routing rules — hop chain, outbound dedupe, retry limit, honest restarts ---

test('ten-turn simulation: exactly ten delivers, hops 1 to 10, no doubles', async () => {
  await withEngine('tenturn', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // astra idle
    await gui.nextMessage(); // codex idle

    const hopOf = (text: string): number => {
      const match = /· hop (\d+)\]$/.exec(text.split('\n')[0]);
      assert.ok(match !== null, `the deliver carries a relay header: ${text.slice(0, 60)}`);
      return Number(match[1]);
    };

    const seen: Array<{ id: string; hop: number; target: string }> = [];
    for (let turn = 1; turn <= 10; turn++) {
      const fromAstra = turn % 2 === 1;
      const body = `turn ${turn}: the relay continues`;
      const id = fromAstra
        ? await captureFromAstra(gui, astra, body, `m32a-turn-${turn}`)
        : await captureFromCodex(gui, codex, body, `m32a-turn-${turn}`);
      const target = fromAstra ? 'codex' : 'astra';
      const receiver = fromAstra ? codex : astra;

      gui.send({ type: 'forward', messageId: id, target });
      assertDeliveryUpdate(await gui.nextMessage(), id, target, 'pending_approval', 0);
      gui.send({ type: 'approve', messageId: id, target });
      assertDeliveryUpdate(await gui.nextMessage(), id, target, 'queued', 0);
      assertDeliveryUpdate(await gui.nextMessage(), id, target, 'delivering', 1);
      const deliver = await receiver.nextMessage();
      assert.equal(deliver.type, 'deliver');
      assert.equal(deliver.messageId, id, `turn ${turn}: the deliver is for this message`);
      const hop = hopOf(String(deliver.text));
      assert.equal(hop, turn, `turn ${turn} delivers with header hop ${turn}`);
      receiver.send({ type: 'delivered', messageId: id });
      assertDeliveryUpdate(await gui.nextMessage(), id, target, 'delivered', 1);
      seen.push({ id, hop, target });
    }

    assert.equal(seen.length, 10, 'exactly ten deliveries');
    assert.deepEqual(seen.map((d) => d.hop), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'hops strictly increase 1..10');
    assert.equal(new Set(seen.map((d) => d.id)).size, 10, 'no message is delivered twice');
    await astra.expectSilence(400);
    await codex.expectSilence(400);
    // The cap exists but never blocks manual forwards — hops went to 10 at cap 4.
    assert.equal(engine.store.turnCap(), 4);
    assert.ok(isOverTurnCap(10, engine.store.turnCap()), 'hop 10 is over the cap, and it went through anyway');
  });
});

test('outbound dedupe: identical text to the same target fails at approve inside 10 minutes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-engine-outdedupe-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  let engine: EngineHandle | undefined;
  try {
    engine = await startEngine({ port: 0, dbPath, tokenPath });
    let url = `ws://127.0.0.1:${engine.port}`;
    const token = readFileSync(tokenPath, 'utf8').trim();
    let repeatId = '';
    {
      const gui = await openGui(url, token);
      const astra = await openAdapter(url, token, 'astra');
      const codex = await openAdapter(url, token, 'codex');
      await gui.nextMessage(); await gui.nextMessage(); // idle x2

      const body = 'the exact same words';
      const firstId = await captureFromAstra(gui, astra, body, 'm32a-dup-1');
      gui.send({ type: 'forward', messageId: firstId, target: 'codex' });
      assertDeliveryUpdate(await gui.nextMessage(), firstId, 'codex', 'pending_approval', 0);
      gui.send({ type: 'approve', messageId: firstId, target: 'codex' });
      assertDeliveryUpdate(await gui.nextMessage(), firstId, 'codex', 'queued', 0);
      assertDeliveryUpdate(await gui.nextMessage(), firstId, 'codex', 'delivering', 1);
      assert.equal((await codex.nextMessage()).type, 'deliver');
      codex.send({ type: 'delivered', messageId: firstId });
      assertDeliveryUpdate(await gui.nextMessage(), firstId, 'codex', 'delivered', 1);

      // The user writes the identical text (the M4.1 send path, stored directly here):
      const repeat = engine.store.insertMessage({
        source: 'user', targets: ['user'], body, hop: 0, initialStatus: 'captured',
      });
      repeatId = repeat.id;
      gui.send({ type: 'forward', messageId: repeat.id, target: 'codex' });
      assertDeliveryUpdate(await gui.nextMessage(), repeat.id, 'codex', 'pending_approval', 0);
      gui.send({ type: 'approve', messageId: repeat.id, target: 'codex' });
      const blocked = await gui.nextMessage();
      assertDeliveryUpdate(blocked, repeat.id, 'codex', 'failed', 0);
      assert.equal(blocked.error, 'identical text was already sent to codex a moment ago');
      await codex.expectSilence(400); // nothing was sent
      assert.equal(engine.store.getDelivery(repeat.id, 'codex')?.attempts, 0, 'no attempt was made');
    }
    { // 11 minutes later the same text may go again (backdate while stopped).
      engine.stop();
      const db = new DatabaseSync(dbPath);
      db.prepare('UPDATE deliveries SET updated_at = ? WHERE target = ? AND status = ?')
        .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), 'codex', 'delivered');
      db.close();
      engine = await startEngine({ port: 0, dbPath, tokenPath });
      url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openGui(url, token);
      const codex = await openAdapter(url, token, 'codex');
      await gui.nextMessage(); // codex idle
      const blockedRow = engine.store.getDelivery(repeatId, 'codex');
      assert.equal(blockedRow?.status, 'failed', 'the blocked row survived the restart');
      assert.equal(blockedRow?.attempts, 0);

      gui.send({ type: 'forward', messageId: repeatId, target: 'codex' }); // failed → pending again
      assertDeliveryUpdate(await gui.nextMessage(), repeatId, 'codex', 'pending_approval', 0);
      gui.send({ type: 'approve', messageId: repeatId, target: 'codex' });
      assertDeliveryUpdate(await gui.nextMessage(), repeatId, 'codex', 'queued', 0);
      assertDeliveryUpdate(await gui.nextMessage(), repeatId, 'codex', 'delivering', 1);
      assert.equal((await codex.nextMessage()).type, 'deliver');
      codex.send({ type: 'delivered', messageId: repeatId });
      assertDeliveryUpdate(await gui.nextMessage(), repeatId, 'codex', 'delivered', 1);
    }
  } finally {
    engine?.stop();
    cleanupDir(dir);
  }
});

test('retry limit: after 3 attempts a forward on the failed row is ignored', async () => {
  await withEngine('retrylimit', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); await gui.nextMessage(); // idle x2
    const id = await captureFromAstra(gui, astra, 'flakey target', 'm32a-retry-1');

    for (let attempt = 1; attempt <= 3; attempt++) {
      gui.send({ type: 'forward', messageId: id, target: 'codex' });
      assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'pending_approval', attempt - 1);
      gui.send({ type: 'approve', messageId: id, target: 'codex' });
      assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'queued', attempt - 1);
      assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivering', attempt);
      assert.equal((await codex.nextMessage()).type, 'deliver');
      codex.send({ type: 'failed', messageId: id, error: `attempt ${attempt} failed` });
      const failed = await gui.nextMessage();
      assertDeliveryUpdate(failed, id, 'codex', 'failed', attempt);
    }

    // The row has now failed after 3 attempts — a fourth forward changes nothing.
    gui.send({ type: 'forward', messageId: id, target: 'codex' });
    await gui.expectSilence(400);
    const row = engine.store.getDelivery(id, 'codex');
    assert.equal(row?.status, 'failed');
    assert.equal(row?.attempts, 3, 'three attempts, and no fourth begins');
  });
});

test('restart: a delivering row returns pending with the interrupted note; a queued row returns clean', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-engine-restartnotes-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  try {
    { // Run 1: one delivering row, one queued row carrying a stale error.
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const flying = engine.store.insertMessage({ source: 'codex', targets: ['user'], body: 'mid-delivery', hop: 0, initialStatus: 'captured' });
      engine.store.insertDelivery(flying.id, 'astra');
      engine.store.markStatus(flying.id, 'astra', 'queued');
      engine.store.markStatus(flying.id, 'astra', 'delivering');
      const waiting = engine.store.insertMessage({ source: 'codex', targets: ['user'], body: 'still queued', hop: 0, initialStatus: 'captured' });
      engine.store.insertDelivery(waiting.id, 'astra');
      engine.store.markStatus(waiting.id, 'astra', 'queued');
      engine.stop();
      // A queued row should never carry an error, but if one ever does the
      // restart must clear it — plant one to prove it:
      const db = new DatabaseSync(dbPath);
      db.prepare('UPDATE deliveries SET error = ? WHERE message_id = ?').run('stale error text', waiting.id);
      db.close();
    }
    { // Run 2: both rows wait for approval again, with honest notes, and nothing sends.
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openClient(url, token);
      gui.send({ type: 'gui_hello' });
      const snapshot = await gui.nextMessage();
      assert.equal(snapshot.type, 'snapshot');
      const snapRows = (snapshot.deliveries ?? []) as Array<{ messageId?: string; error?: string | null; status?: string }>;
      const snapFlying = snapRows.find((r) => r.messageId !== undefined &&
        engine.store.getMessage(String(r.messageId))?.body === 'mid-delivery');
      const snapWaiting = snapRows.find((r) => r.messageId !== undefined &&
        engine.store.getMessage(String(r.messageId))?.body === 'still queued');
      assert.equal(snapFlying?.status, 'pending_approval');
      assert.equal(snapFlying?.error, 'interrupted by a restart — it may already have arrived',
        'the GUI sees the interrupted note in its snapshot');
      assert.equal(snapWaiting?.status, 'pending_approval');
      assert.equal(snapWaiting?.error, null, 'the queued row restarted clean');

      const astra = await openAdapter(url, token, 'astra');
      await gui.nextMessage(); // astra idle from hello
      await astra.expectSilence(400); // nothing is ever re-sent on hello
      await gui.expectSilence(400);
      engine.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

// --- M3.2b: Stop and Resume ---

test('stop: in-flight rows return to pending with the right notes within 1s, and codex receives interrupt', async () => {
  await withEngine('stoprows', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    await gui.nextMessage(); // astra idle

    // A delivering row through the real flow: the adapter never acks, so the
    // row sits in flight with its ack timer armed (shortened below).
    const flyingId = await captureFromAstra(gui, astra, 'in flight when stopped', 'm32b-fly-1');
    gui.send({ type: 'forward', messageId: flyingId, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), flyingId, 'codex', 'pending_approval', 0);
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // codex idle from hello
    gui.send({ type: 'approve', messageId: flyingId, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), flyingId, 'codex', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), flyingId, 'codex', 'delivering', 1);
    assert.equal((await codex.nextMessage()).type, 'deliver');

    // A queued row planted through the store (a codex hello would flush a
    // queued row, so it is planted after the adapter is connected).
    const waiting = engine.store.insertMessage({ source: 'astra', targets: ['user'], body: 'queued when stopped', hop: 0 });
    engine.store.insertDelivery(waiting.id, 'codex');
    engine.store.markStatus(waiting.id, 'codex', 'queued');

    const t0 = Date.now();
    gui.send({ type: 'stop' });
    const flyingUpdate = await gui.nextMessage();
    const waitingUpdate = await gui.nextMessage();
    const pauseFrame = await gui.nextMessage();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1000, `the stop broadcast must arrive within 1 second, took ${elapsed}ms`);
    assertDeliveryUpdate(flyingUpdate, flyingId, 'codex', 'pending_approval', 1);
    assert.equal(flyingUpdate.error, 'stopped before confirmation — it may already have arrived');
    assertDeliveryUpdate(waitingUpdate, waiting.id, 'codex', 'pending_approval', 0);
    assert.equal(waitingUpdate.error, 'stopped — approve again after you resume');
    assert.deepEqual(pauseFrame, { type: 'pause_update', paused: true });
    // The interrupt goes to the connected codex adapter only:
    assert.deepEqual(await codex.nextMessage(), { type: 'interrupt' });
    await astra.expectSilence(300);
    // The store agrees, and the stopped state persists:
    assert.equal(engine.store.getDelivery(flyingId, 'codex')?.error,
      'stopped before confirmation — it may already have arrived');
    assert.equal(engine.store.getDelivery(waiting.id, 'codex')?.error,
      'stopped — approve again after you resume');
    assert.equal(engine.store.getSetting('paused'), '1');
    // The reset rows' ack timers are gone: no late failure ever arrives.
    await gui.expectSilence(400);
  }, { deliverAckTimeoutMs: 120 });
});

test('while stopped: approve is ignored, a late delivered is ignored, captures still store, hello flushes nothing', async () => {
  await withEngine('stoprules', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    await gui.nextMessage(); // astra idle
    const flyingId = await captureFromAstra(gui, astra, 'never confirmed', 'm32b-late-1');
    gui.send({ type: 'forward', messageId: flyingId, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), flyingId, 'codex', 'pending_approval', 0);
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // codex idle
    gui.send({ type: 'approve', messageId: flyingId, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), flyingId, 'codex', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), flyingId, 'codex', 'delivering', 1);
    assert.equal((await codex.nextMessage()).type, 'deliver');
    const heldId = await captureFromAstra(gui, astra, 'waiting when stopped', 'm32b-late-2');
    gui.send({ type: 'forward', messageId: heldId, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), heldId, 'codex', 'pending_approval', 0);

    gui.send({ type: 'stop' });
    // Only the delivering row changed; the already-pending row gets no update.
    assertDeliveryUpdate(await gui.nextMessage(), flyingId, 'codex', 'pending_approval', 1);
    assert.deepEqual(await gui.nextMessage(), { type: 'pause_update', paused: true });
    assert.deepEqual(await codex.nextMessage(), { type: 'interrupt' });

    // Approve while stopped: ignored and logged — nothing queues.
    gui.send({ type: 'approve', messageId: heldId, target: 'codex' });
    await gui.expectSilence(300);
    assert.equal(engine.store.getDelivery(heldId, 'codex')?.status, 'pending_approval');

    // A late delivered for the reset row: ignored, so the stopped note stays.
    codex.send({ type: 'delivered', messageId: flyingId });
    await gui.expectSilence(300);
    assert.equal(engine.store.getDelivery(flyingId, 'codex')?.status, 'pending_approval');
    assert.equal(engine.store.getDelivery(flyingId, 'codex')?.error,
      'stopped before confirmation — it may already have arrived');

    // Stop pauses delivery, not reading: captures from both adapters still store.
    astra.send({ type: 'captured', body: 'astra captured while stopped', sourceRef: 'm32b-late-3' });
    const storedAstra = await gui.nextMessage() as { type?: string; message?: { body?: string } };
    assert.equal(storedAstra.type, 'transcript_update');
    assert.equal(storedAstra.message?.body, 'astra captured while stopped');
    codex.send({ type: 'captured', body: 'codex captured while stopped', sourceRef: 'm32b-late-4' });
    const storedCodex = await gui.nextMessage() as { type?: string; message?: { body?: string } };
    assert.equal(storedCodex.type, 'transcript_update');
    assert.equal(storedCodex.message?.body, 'codex captured while stopped');

    // A hello while stopped flushes nothing.
    codex.close();
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'disconnected' });
    const codex2 = await openAdapter(url, token, 'codex');
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'idle' });
    await codex2.expectSilence(400); // hello delivered nothing
    assert.equal(engine.store.pendingDeliveries().filter((p) => p.status !== 'pending_approval').length, 0,
      'nothing is queued or delivering while stopped');
  });
});

test('restart while stopped: the new engine reports paused: true and a flush on hello delivers nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-engine-stoprestart-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  try {
    { // Run 1: one pending row; stop with nothing in flight (harmless).
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openGui(url, token);
      const astra = await openAdapter(url, token, 'astra');
      await gui.nextMessage(); // astra idle
      const id = await captureFromAstra(gui, astra, 'survives the restart', 'm32b-restart-1');
      gui.send({ type: 'forward', messageId: id, target: 'codex' });
      assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'pending_approval', 0);
      gui.send({ type: 'stop' });
      assert.deepEqual(await gui.nextMessage(), { type: 'pause_update', paused: true });
      engine.stop();
    }
    { // Run 2: the stopped state survived; hello delivers nothing.
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openClient(url, token);
      gui.send({ type: 'gui_hello' });
      const snapshot = await gui.nextMessage() as {
        type?: string; paused?: boolean;
        deliveries?: Array<{ status?: string; error?: string | null }>;
      };
      assert.equal(snapshot.type, 'snapshot');
      assert.equal(snapshot.paused, true, 'a restarted engine that was stopped stays stopped');
      assert.equal((snapshot.deliveries ?? [])[0]?.status, 'pending_approval');
      const codex = await openAdapter(url, token, 'codex');
      assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'idle' });
      await codex.expectSilence(400); // a flush on hello delivers nothing
      await gui.expectSilence(400);
      assert.equal(engine.store.getSetting('paused'), '1');
      engine.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('resume: clears the state and delivers nothing; a fresh approve then delivers normally', async () => {
  await withEngine('resume', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); await gui.nextMessage(); // idle x2
    const id = await captureFromAstra(gui, astra, 'approve me after the resume', 'm32b-resume-1');
    gui.send({ type: 'forward', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'pending_approval', 0);

    gui.send({ type: 'stop' });
    assert.deepEqual(await gui.nextMessage(), { type: 'pause_update', paused: true });
    assert.deepEqual(await codex.nextMessage(), { type: 'interrupt' });

    gui.send({ type: 'resume' });
    assert.deepEqual(await gui.nextMessage(), { type: 'pause_update', paused: false });
    await codex.expectSilence(300); // resume delivers nothing
    assert.equal(engine.store.getDelivery(id, 'codex')?.status, 'pending_approval',
      'the item still waits for a fresh approval');
    assert.equal(engine.store.getSetting('paused'), null);

    gui.send({ type: 'approve', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivering', 1);
    const deliver = await codex.nextMessage();
    assert.equal(deliver.type, 'deliver');
    assert.equal(deliver.messageId, id);
    codex.send({ type: 'delivered', messageId: id });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivered', 1);

    // A GUI that joins after the resume sees paused: false in its snapshot.
    const late = await openClient(url, token);
    late.send({ type: 'gui_hello' });
    const snap = await late.nextMessage() as { paused?: boolean };
    assert.equal(snap.paused, false);
  });
});

test('stop twice and resume while not stopped are both idempotent', async () => {
  await withEngine('stopidem', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // codex idle

    gui.send({ type: 'stop' });
    assert.deepEqual(await gui.nextMessage(), { type: 'pause_update', paused: true });
    assert.deepEqual(await codex.nextMessage(), { type: 'interrupt' });

    gui.send({ type: 'stop' }); // twice is once: no second broadcast, no second interrupt
    await gui.expectSilence(300);
    await codex.expectSilence(300);
    assert.equal(engine.store.getSetting('paused'), '1');

    gui.send({ type: 'resume' });
    assert.deepEqual(await gui.nextMessage(), { type: 'pause_update', paused: false });
    gui.send({ type: 'resume' }); // resume while running: a no-op
    await gui.expectSilence(300);
    await codex.expectSilence(300);
    assert.equal(engine.store.getSetting('paused'), null);
  });
});

// --- M3.3: Codex approval requests surface in the GUI ---

test('approvals: a codex request is broadcast to GUIs and appears in a fresh snapshot; astra reports nothing', async () => {
  await withEngine('apprbcast', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // codex idle
    const astra = await openAdapter(url, token, 'astra');
    await gui.nextMessage(); // astra idle

    astra.send({ type: 'approval_request', requestId: 'req-x', kind: 'command', summary: 'x', method: 'item/commandExecution/requestApproval' });
    await gui.expectSilence(300); // only the codex socket may report approvals

    codex.send({ type: 'approval_request', requestId: 'req-1', kind: 'command', summary: 'git status', method: 'item/commandExecution/requestApproval' });
    assert.deepEqual(await gui.nextMessage(), {
      type: 'approval_request', requestId: 'req-1', kind: 'command',
      summary: 'git status', method: 'item/commandExecution/requestApproval',
    });

    const late = await openClient(url, token);
    late.send({ type: 'gui_hello' });
    const snapshot = await late.nextMessage() as {
      type?: string;
      approvals?: Array<{ requestId?: string; kind?: string; summary?: string; method?: string }>;
    };
    assert.equal(snapshot.type, 'snapshot');
    assert.deepEqual(snapshot.approvals, [{
      requestId: 'req-1', kind: 'command', summary: 'git status', method: 'item/commandExecution/requestApproval',
    }], 'the fresh GUI sees the pending approval in its catch-up');
  });
});

test('approvals: an answer is forwarded to the codex adapter and resolved; unknown, duplicate and malformed answers are ignored', async () => {
  await withEngine('appranswer', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // codex idle
    codex.send({ type: 'approval_request', requestId: 'req-1', kind: 'file_change', summary: 'write it', method: 'item/fileChange/requestApproval' });
    assert.equal((await gui.nextMessage()).type, 'approval_request');

    gui.send({ type: 'approval_answer', requestId: 'req-1', decision: 'accept' });
    assert.deepEqual(await codex.nextMessage(), { type: 'approval_answer', requestId: 'req-1', decision: 'accept' });
    assert.deepEqual(await gui.nextMessage(), { type: 'approval_resolved', requestId: 'req-1', decision: 'accept' });

    gui.send({ type: 'approval_answer', requestId: 'req-1', decision: 'decline' }); // already answered
    gui.send({ type: 'approval_answer', requestId: 'req-nope', decision: 'accept' }); // unknown
    gui.send({ type: 'approval_answer', requestId: 'req-1', decision: 'maybe' }); // bad decision
    await gui.expectSilence(300);
    await codex.expectSilence(300);
  });
});

test('approvals: an answer from a non-GUI socket is ignored; the GUI can still answer after', async () => {
  await withEngine('apprnongui', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // codex idle
    codex.send({ type: 'approval_request', requestId: 'req-1', kind: 'command', summary: 'ls', method: 'item/commandExecution/requestApproval' });
    assert.equal((await gui.nextMessage()).type, 'approval_request');

    const stranger = await openClient(url, token); // authenticated, never greeted
    stranger.send({ type: 'approval_answer', requestId: 'req-1', decision: 'accept' });
    await gui.expectSilence(300);
    await codex.expectSilence(300); // nothing was forwarded

    gui.send({ type: 'approval_answer', requestId: 'req-1', decision: 'decline' });
    assert.deepEqual(await codex.nextMessage(), { type: 'approval_answer', requestId: 'req-1', decision: 'decline' });
    assert.deepEqual(await gui.nextMessage(), { type: 'approval_resolved', requestId: 'req-1', decision: 'decline' });
  });
});

test('approvals: a codex disconnect resolves all approvals as lost; so does a replaced adapter', async () => {
  await withEngine('apprlost', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // codex idle
    codex.send({ type: 'approval_request', requestId: 'req-1', kind: 'command', summary: 'one', method: 'item/commandExecution/requestApproval' });
    assert.equal((await gui.nextMessage()).type, 'approval_request');
    codex.send({ type: 'approval_request', requestId: 'req-2', kind: 'permissions', summary: 'two', method: 'item/permissions/requestApproval' });
    assert.equal((await gui.nextMessage()).type, 'approval_request');

    codex.close();
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'disconnected' });
    const lost1 = await gui.nextMessage();
    const lost2 = await gui.nextMessage();
    assert.deepEqual([lost1.requestId, lost2.requestId].sort(), ['req-1', 'req-2']);
    assert.ok(lost1.decision === 'lost' && lost2.decision === 'lost', 'each pending approval resolves as lost');

    // A replaced adapter's approvals die with it too:
    const codex2 = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // codex idle
    codex2.send({ type: 'approval_request', requestId: 'req-3', kind: 'command', summary: 'three', method: 'item/commandExecution/requestApproval' });
    assert.equal((await gui.nextMessage()).type, 'approval_request');
    const codex3 = await openAdapter(url, token, 'codex'); // replaces codex2
    assert.deepEqual(await gui.nextMessage(), { type: 'approval_resolved', requestId: 'req-3', decision: 'lost' });
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'idle' });
  });
});

test('approvals: Stop resolves pending approvals as stopped and still interrupts codex', async () => {
  await withEngine('apprstop', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // codex idle
    codex.send({ type: 'approval_request', requestId: 'req-1', kind: 'command', summary: 'long one', method: 'item/commandExecution/requestApproval' });
    assert.equal((await gui.nextMessage()).type, 'approval_request');

    gui.send({ type: 'stop' });
    assert.deepEqual(await gui.nextMessage(), { type: 'approval_resolved', requestId: 'req-1', decision: 'stopped' });
    assert.deepEqual(await gui.nextMessage(), { type: 'pause_update', paused: true });
    assert.deepEqual(await codex.nextMessage(), { type: 'interrupt' });

    gui.send({ type: 'approval_answer', requestId: 'req-1', decision: 'accept' }); // gone
    await gui.expectSilence(300);
    await codex.expectSilence(300);
  });
});

test('approvals: a restart has none — they are memory only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-engine-apprrestart-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  try {
    { // Run 1: a pending request exists when the engine stops.
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openGui(url, token);
      const codex = await openAdapter(url, token, 'codex');
      await gui.nextMessage(); // codex idle
      codex.send({ type: 'approval_request', requestId: 'req-1', kind: 'command', summary: 'gone with the process', method: 'item/commandExecution/requestApproval' });
      assert.equal((await gui.nextMessage()).type, 'approval_request');
      engine.stop();
    }
    { // Run 2: nothing to answer — the codex request died with its connection.
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openClient(url, token);
      gui.send({ type: 'gui_hello' });
      const snapshot = await gui.nextMessage() as { type?: string; approvals?: unknown[] };
      assert.equal(snapshot.type, 'snapshot');
      assert.deepEqual(snapshot.approvals, [], 'approvals are never persisted');
      engine.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

// --- M4.1: the GUI send — the user writes to the room ---

test('send: a GUI send to codex stores a user message and delivers it with the from You header', async () => {
  await withEngine('sendone', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // codex idle

    gui.send({ type: 'send', body: '  hello codex  ', targets: ['codex'] });
    const update = await gui.nextMessage() as { type?: string; message?: Record<string, unknown> };
    assert.equal(update.type, 'transcript_update');
    const message = update.message as Record<string, unknown>;
    assert.equal(message.source, 'user');
    assert.equal(message.body, 'hello codex', 'the body is trimmed');
    assert.equal(message.hop, 0);
    assert.deepEqual(message.targets, ['codex']);
    const id = String(message.id);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivering', 1);
    const deliver = await codex.nextMessage();
    assert.equal(deliver.type, 'deliver');
    assert.equal(deliver.text, `[Relay · from You · #${id} · hop 1]\nhello codex`);
    codex.send({ type: 'delivered', messageId: id });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivered', 1);

    // D14-4: the chain reads sensibly — the hop-0 user message went out with
    // header hop 1, so codex's reply captures as hop 1.
    codex.send({ type: 'captured', body: 'PONG from codex', sourceRef: 'm41-turn-1' });
    const reply = await gui.nextMessage() as { message?: { source?: string; hop?: number } };
    assert.equal(reply.message?.source, 'codex');
    assert.equal(reply.message?.hop, 1, 'the reply continues the chain from the delivered user message');
  });
});

test('send to both: one deliver to each AI, once each, duplicates removed', async () => {
  await withEngine('sendboth', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); await gui.nextMessage(); // idle x2

    gui.send({ type: 'send', body: 'hi everyone', targets: ['astra', 'codex', 'codex'] });
    const update = await gui.nextMessage() as { message?: { id?: string; targets?: string[] } };
    assert.deepEqual(update.message?.targets, ['astra', 'codex'], 'duplicates are removed, order kept');
    const id = String(update.message?.id);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'delivering', 1);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivering', 1);
    const toAstra = await astra.nextMessage();
    const toCodex = await codex.nextMessage();
    assert.equal(toAstra.messageId, id);
    assert.equal(toCodex.messageId, id);
    assert.ok(String(toAstra.text).startsWith(`[Relay · from You · #${id} · hop 1]`));
    astra.send({ type: 'delivered', messageId: id });
    codex.send({ type: 'delivered', messageId: id });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'astra', 'delivered', 1);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivered', 1);
    await astra.expectSilence(300);
    await codex.expectSilence(300); // exactly once each
  });
});

test('send: only GUI sockets may send; bad targets, empty bodies and the cap are ignored', async () => {
  await withEngine('sendguard', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // codex idle
    const stranger = await openClient(url, token); // authenticated, never greeted

    stranger.send({ type: 'send', body: 'not from a GUI', targets: ['codex'] });
    gui.send({ type: 'send', body: '', targets: ['codex'] });
    gui.send({ type: 'send', body: '   ', targets: ['codex'] });
    gui.send({ type: 'send', body: 'to nobody', targets: [] });
    gui.send({ type: 'send', body: 'to user', targets: ['user'] });
    gui.send({ type: 'send', body: 'mixed bag', targets: ['codex', 'nonsense'] });
    gui.send({ type: 'send', body: 'x'.repeat(20001), targets: ['codex'] });
    await gui.expectSilence(400);
    await codex.expectSilence(400);
    for (const body of ['not from a GUI', 'to user', 'mixed bag']) {
      assert.equal(engine.store.isDuplicate('user', hashBody(body)), false, `${body} was never stored`);
    }
  });
});

test('send while stopped: rows wait as pending_approval with the note; resume plus approve delivers', async () => {
  await withEngine('sendstopped', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // codex idle
    gui.send({ type: 'stop' });
    assert.deepEqual(await gui.nextMessage(), { type: 'pause_update', paused: true });
    assert.deepEqual(await codex.nextMessage(), { type: 'interrupt' });

    gui.send({ type: 'send', body: 'hold this', targets: ['codex'] });
    const update = await gui.nextMessage() as { type?: string; message?: { id?: string } };
    assert.equal(update.type, 'transcript_update', 'the message is stored even while stopped');
    const id = String(update.message?.id);
    const row = await gui.nextMessage();
    assertDeliveryUpdate(row, id, 'codex', 'pending_approval', 0);
    assert.equal(row.error, 'the relay is stopped — approve after you resume');
    await codex.expectSilence(400); // nothing delivers while stopped

    gui.send({ type: 'resume' });
    assert.deepEqual(await gui.nextMessage(), { type: 'pause_update', paused: false });
    gui.send({ type: 'approve', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivering', 1);
    assert.equal((await codex.nextMessage()).type, 'deliver');
    codex.send({ type: 'delivered', messageId: id });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivered', 1);
  });
});

test('send with the adapter absent: queued, then flushed exactly once on hello', async () => {
  await withEngine('sendqueued', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    gui.send({ type: 'send', body: 'when you come back', targets: ['codex'] });
    const update = await gui.nextMessage() as { message?: { id?: string } };
    const id = String(update.message?.id);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'queued', 0);
    await gui.expectSilence(200);

    const codex = await openAdapter(url, token, 'codex');
    assert.deepEqual(await gui.nextMessage(), { type: 'status_update', adapter: 'codex', status: 'idle' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivering', 1);
    const deliver = await codex.nextMessage();
    assert.equal(deliver.type, 'deliver');
    assert.equal(deliver.messageId, id);
    await codex.expectSilence(300); // exactly once
  });
});

test('restart: a delivering user row returns to pending and nothing is re-sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-engine-sendrestart-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  try {
    { // Run 1: a user send in flight (the adapter never acks).
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openGui(url, token);
      const codex = await openAdapter(url, token, 'codex');
      await gui.nextMessage(); // codex idle
      gui.send({ type: 'send', body: 'mid flight user row', targets: ['codex'] });
      const update = await gui.nextMessage() as { message?: { id?: string } };
      const id = String(update.message?.id);
      assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'queued', 0);
      assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivering', 1);
      assert.equal((await codex.nextMessage()).type, 'deliver');
      engine.stop();
    }
    { // Run 2: the row waits again; a hello delivers nothing.
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openClient(url, token);
      gui.send({ type: 'gui_hello' });
      const snapshot = await gui.nextMessage() as {
        type?: string; deliveries?: Array<{ status?: string; error?: string | null; source?: unknown }>;
        messages?: Array<{ body?: string }>;
      };
      assert.equal(snapshot.type, 'snapshot');
      assert.deepEqual(snapshot.messages?.map((m) => m.body), ['mid flight user row']);
      const row = (snapshot.deliveries ?? [])[0];
      assert.equal(row?.status, 'pending_approval');
      assert.equal(row?.error, 'interrupted by a restart — it may already have arrived');
      const codex = await openAdapter(url, token, 'codex');
      await gui.nextMessage(); // codex idle
      await codex.expectSilence(400); // nothing is ever re-sent on hello
      await gui.expectSilence(400);
      engine.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('an echo of a user message is dropped by the capture-side filter', async () => {
  await withEngine('sendecho', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // codex idle
    gui.send({ type: 'send', body: 'say PONG please', targets: ['codex'] });
    const update = await gui.nextMessage() as { message?: { id?: string } };
    const id = String(update.message?.id);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivering', 1);
    assert.equal((await codex.nextMessage()).type, 'deliver');
    codex.send({ type: 'delivered', messageId: id });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivered', 1);

    codex.send({ type: 'captured', body: 'say PONG please', sourceRef: 'm41-echo-1' });
    await gui.expectSilence(400); // the echo is never stored or re-broadcast
    assert.equal(engine.store.isDuplicate('codex', hashBody('say PONG please')), false, 'the echo was dropped');
  });
});

test('send: identical text to the same AI within 10 minutes fails the row with the dedupe error', async () => {
  await withEngine('senddedupe', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); // codex idle
    gui.send({ type: 'send', body: 'repeat me twice', targets: ['codex'] });
    const first = await gui.nextMessage() as { message?: { id?: string } };
    const id1 = String(first.message?.id);
    assertDeliveryUpdate(await gui.nextMessage(), id1, 'codex', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), id1, 'codex', 'delivering', 1);
    assert.equal((await codex.nextMessage()).type, 'deliver');
    codex.send({ type: 'delivered', messageId: id1 });
    assertDeliveryUpdate(await gui.nextMessage(), id1, 'codex', 'delivered', 1);

    gui.send({ type: 'send', body: 'repeat me twice', targets: ['codex'] });
    const second = await gui.nextMessage() as { message?: { id?: string } };
    assert.equal((second.message?.id ?? '') !== id1, true, 'the deliberate resend is a new message, still shown');
    const id2 = String(second.message?.id);
    const failed = await gui.nextMessage();
    assertDeliveryUpdate(failed, id2, 'codex', 'failed', 0);
    assert.equal(failed.error, 'identical text was already sent to codex a moment ago');
    await codex.expectSilence(400); // nothing was sent a second time
    assert.equal(engine.store.getDelivery(id2, 'codex')?.attempts, 0, 'no attempt was made');
  });
});

// --- M4.2: relay mode, turn cap and the auto-send settings ---

test('set_mode: GUI sockets only; partial frames change only their fields; invalid frames are ignored whole', async () => {
  await withEngine('setmode', async (_engine, url, token) => {
    const gui = await openGui(url, token);
    const stranger = await openClient(url, token); // authenticated, never greeted
    stranger.send({ type: 'set_mode', mode: 'approve_each' });
    await gui.expectSilence(300); // non-GUI sockets are ignored

    gui.send({ type: 'set_mode', turnCap: 12 });
    assert.deepEqual(await gui.nextMessage(), {
      type: 'settings_update', mode: 'manual', turnCap: 12, autoSend: false, autoSendDelaySec: 10,
    }, 'a partial frame changes only its field; the broadcast carries the whole object');

    gui.send({ type: 'set_mode', mode: 'approve_each', turnCap: 99 }); // one bad field poisons all
    gui.send({ type: 'set_mode', mode: 'nonsense' }); // no such mode, ever
    await gui.expectSilence(300);

    const late = await openClient(url, token);
    late.send({ type: 'gui_hello' });
    const snapshot = await late.nextMessage() as { settings?: { mode?: string; turnCap?: number; autoSend?: boolean; autoSendDelaySec?: number } };
    assert.deepEqual(snapshot.settings, { mode: 'manual', turnCap: 12, autoSend: false, autoSendDelaySec: 10 },
      'the rejected frames changed nothing');
  });
});

test('set_mode: a full valid frame applies everything and the settings survive a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-engine-settingsrestart-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  try {
    { // Run 1: change all four settings.
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openGui(url, token);
      gui.send({ type: 'set_mode', mode: 'approve_each', turnCap: 5, autoSend: true, autoSendDelaySec: 300 });
      assert.deepEqual(await gui.nextMessage(), {
        type: 'settings_update', mode: 'approve_each', turnCap: 5, autoSend: true, autoSendDelaySec: 300,
      });
      engine.stop();
    }
    { // Run 2: everything persisted.
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openClient(url, token);
      gui.send({ type: 'gui_hello' });
      const snapshot = await gui.nextMessage() as { settings?: unknown };
      assert.deepEqual(snapshot.settings, { mode: 'approve_each', turnCap: 5, autoSend: true, autoSendDelaySec: 300 });
      engine.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('approve_each: a stored AI capture creates one pending row to the other AI; manual creates none', async () => {
  await withEngine('approeach', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); await gui.nextMessage(); // idle x2

    // manual (the default): a capture creates no row
    astra.send({ type: 'captured', body: 'in manual mode', sourceRef: 'm42-manual-1' });
    await gui.nextMessage(); // the transcript_update
    await gui.expectSilence(300); // no delivery_update

    gui.send({ type: 'set_mode', mode: 'approve_each' });
    assert.equal((await gui.nextMessage()).type, 'settings_update');

    astra.send({ type: 'captured', body: 'route me to codex', sourceRef: 'm42-ae-1' });
    const toCodex = await gui.nextMessage() as { message?: { id?: string } };
    assertDeliveryUpdate(await gui.nextMessage(), String(toCodex.message?.id), 'codex', 'pending_approval', 0);
    codex.send({ type: 'captured', body: 'route me back', sourceRef: 'm42-ae-2' });
    const toAstra = await gui.nextMessage() as { message?: { id?: string } };
    assertDeliveryUpdate(await gui.nextMessage(), String(toAstra.message?.id), 'astra', 'pending_approval', 0);

    // a duplicate capture is dropped by the store — no second row, no broadcast
    astra.send({ type: 'captured', body: 'route me to codex', sourceRef: 'm42-ae-1' });
    await gui.expectSilence(300);
    assert.equal(engine.store.getDelivery(String(toCodex.message?.id), 'codex')?.status, 'pending_approval');
  });
});

test('approve_each: Approve delivers once with the right header, and the cap never blocks it', async () => {
  await withEngine('approeachgo', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const astra = await openAdapter(url, token, 'astra');
    const codex = await openAdapter(url, token, 'codex');
    await gui.nextMessage(); await gui.nextMessage(); // idle x2
    gui.send({ type: 'set_mode', mode: 'approve_each' });
    await gui.nextMessage(); // settings_update

    // A delivered hop-8 message to astra makes the next astra capture hop 9 —
    // over the default cap of 4, which must not matter here.
    const planted = engine.store.insertMessage({ source: 'user', targets: ['user'], body: 'hop eight', hop: 8 });
    engine.store.insertDelivery(planted.id, 'astra');
    engine.store.markStatus(planted.id, 'astra', 'queued');
    engine.store.markStatus(planted.id, 'astra', 'delivered');

    astra.send({ type: 'captured', body: 'over the cap', sourceRef: 'm42-cap-1' });
    const message = await gui.nextMessage() as { message?: { id?: string; hop?: number } };
    assert.equal(message.message?.hop, 9, 'the capture continues the chain');
    const id = String(message.message?.id);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'pending_approval', 0);
    // (the row is created at hop 9 although the cap is 4 — the cap never applies)

    gui.send({ type: 'approve', messageId: id, target: 'codex' });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'queued', 0);
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivering', 1);
    const deliver = await codex.nextMessage();
    assert.equal(deliver.type, 'deliver');
    assert.equal(deliver.text, `[Relay · from Astra · #${id} · hop 10]\nover the cap`,
      'the header follows the existing rule: the capture hop plus one');
    codex.send({ type: 'delivered', messageId: id });
    assertDeliveryUpdate(await gui.nextMessage(), id, 'codex', 'delivered', 1);
    await codex.expectSilence(300); // exactly once
    assert.equal(engine.store.turnCap(), 4);
  });
});

test('approve_each: switching the mode back-fills nothing, and a restart replays nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-engine-approeachrestart-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  try {
    { // Run 1: capture in manual, then switch — no backfill; stop while approve_each.
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openGui(url, token);
      const astra = await openAdapter(url, token, 'astra');
      await gui.nextMessage(); // astra idle
      astra.send({ type: 'captured', body: 'old capture', sourceRef: 'm42-old-1' });
      await gui.nextMessage(); // transcript_update
      await gui.expectSilence(300); // manual: no row
      gui.send({ type: 'set_mode', mode: 'approve_each' });
      await gui.nextMessage(); // settings_update
      await gui.expectSilence(300); // the old capture is NOT back-filled
      engine.stop();
    }
    { // Run 2: nothing is replayed; the mode persisted.
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openClient(url, token);
      gui.send({ type: 'gui_hello' });
      const snapshot = await gui.nextMessage() as { settings?: { mode?: string }; deliveries?: unknown[] };
      assert.equal(snapshot.settings?.mode, 'approve_each', 'the mode persisted');
      assert.deepEqual(snapshot.deliveries, [], 'no rows were replayed for the old capture');
      const astra = await openAdapter(url, token, 'astra');
      await gui.nextMessage(); // astra idle from hello
      await gui.expectSilence(400); // and nothing appears out of thin air
      engine.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

// --- M4.3: transcript search and Markdown export ---

test('search: GUI-only, the query validated, and the result reaches the asking socket only', async () => {
  await withEngine('search', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const other = await openGui(url, token);
    const stranger = await openClient(url, token); // authenticated, never greeted

    const plant = (body: string, hop: number): string =>
      engine.store.insertMessage({ source: 'astra', targets: ['user'], body, hop }).id;
    plant('the needle is sharp', 0);
    plant('no match in this one', 0);
    const newest = plant('needle again', 1);

    stranger.send({ type: 'search', requestId: 'r0', query: 'needle' });
    await gui.expectSilence(300); // non-GUI sockets are ignored

    gui.send({ type: 'search', requestId: '', query: 'needle' }); // a bad requestId
    gui.send({ type: 'search', requestId: 'r1', query: '   ' }); // empty after trim
    gui.send({ type: 'search', requestId: 'r2', query: 'x'.repeat(201) }); // over 200
    await gui.expectSilence(300);
    await other.expectSilence(300);

    gui.send({ type: 'search', requestId: 'r3', query: '  needle  ' });
    const result = await gui.nextMessage() as {
      type?: string; requestId?: string; total?: number;
      messages?: Array<{ id?: string; body?: string; hop?: number }>;
    };
    assert.equal(result.type, 'search_result');
    assert.equal(result.requestId, 'r3');
    assert.equal(result.total, 2);
    assert.deepEqual(result.messages?.map((m) => m.body), ['needle again', 'the needle is sharp'],
      'the newest 100 matches, newest first');
    assert.equal(result.messages?.[0]?.id, newest);
    assert.equal(result.messages?.[0]?.hop, 1, 'the rows are full messages');
    await other.expectSilence(300); // nobody else sees it
  });
});

test('export: GUI-only, and export_result reaches the asking socket only', async () => {
  await withEngine('export', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const other = await openGui(url, token);
    const stranger = await openClient(url, token);

    engine.store.insertMessage({ source: 'user', targets: ['user'], body: 'searchable prose', hop: 0 });
    const second = engine.store.insertMessage({ source: 'codex', targets: ['user'], body: 'a reply with ``` fences', hop: 1 });
    engine.store.insertDelivery(second.id, 'astra'); // a pending row rides along as a Delivery line

    stranger.send({ type: 'export', requestId: 'r0' });
    await gui.expectSilence(300); // non-GUI sockets are ignored
    gui.send({ type: 'export', requestId: '' }); // a bad requestId is ignored
    await gui.expectSilence(300);

    gui.send({ type: 'export', requestId: 'r1' });
    const result = await gui.nextMessage() as {
      type?: string; requestId?: string; markdown?: string; messageCount?: number;
    };
    assert.equal(result.type, 'export_result');
    assert.equal(result.requestId, 'r1');
    assert.equal(result.messageCount, 2);
    assert.ok(result.markdown?.startsWith('# Relay Chat transcript'), 'the engine builds the Markdown');
    assert.ok(result.markdown?.includes('searchable prose'), 'oldest message included');
    assert.ok(result.markdown?.includes('a reply with ``` fences'), 'the fenced body is verbatim');
    assert.ok(result.markdown?.includes(`Delivery: astra pending_approval`), 'the delivery rows are in it');
    assert.ok(result.markdown?.includes(`### You —`), 'sender labels');
    await other.expectSilence(300); // nobody else sees it
    assert.equal(engine.store.getDelivery(second.id, 'astra')?.status, 'pending_approval', 'export changed nothing');
  });
});

// --- M5.1: Auto mode, the turn cap and the auto-send countdown ---

/** Real milliseconds for the local-socket round trips between clock moves. */
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A fake clock: the engine's injectable now/setTimer/clearTimer. advance()
 *  fires every due timer in order — including timers armed by the expiry of
 *  an earlier one — so a whole auto chain runs without real waiting. */
class FakeClock {
  private currentMs = 0;
  private timers = new Map<object, { at: number; fn: () => void }>();
  readonly now = (): number => this.currentMs;
  readonly setTimer = (fn: () => void, ms: number): object => {
    const handle = {};
    this.timers.set(handle, { at: this.currentMs + ms, fn });
    return handle;
  };
  readonly clearTimer = (handle: unknown): void => { this.timers.delete(handle as object); };
  advance(ms: number): void {
    const target = this.currentMs + ms;
    for (;;) {
      let next: { handle: object; at: number; fn: () => void } | null = null;
      for (const [handle, timer] of this.timers) {
        if (timer.at <= target && (next === null || timer.at < next.at)) {
          next = { handle, at: timer.at, fn: timer.fn };
        }
      }
      if (next === null) break;
      this.timers.delete(next.handle);
      this.currentMs = next.at;
      next.fn();
    }
    this.currentMs = target;
  }
}

/** Collect every frame a client receives, for broadcast assertions. */
function collector(client: Client): { frames: Frame[]; stop: () => void } {
  const frames: Frame[] = [];
  client.summaryTolerant = false; // M5.2: collectors see every frame, summaries included
  let running = true;
  const loop = async (): Promise<void> => {
    while (running) {
      try { frames.push(await client.nextMessage(250)); } catch { /* keep polling */ }
    }
  };
  void loop();
  return { frames, stop: () => { running = false; } };
}

/** A fake adapter that replies to every deliver instantly with a unique
 *  capture — the fuel for the auto chains. */
async function autoReplyAdapter(url: string, token: string, name: 'astra' | 'codex')
  : Promise<{ client: Client; delivers: Frame[]; stop: () => void }> {
  const client = await openAdapter(url, token, name);
  const delivers: Frame[] = [];
  let running = true;
  let n = 0;
  const loop = async (): Promise<void> => {
    while (running) {
      let frame: Frame | null = null;
      try { frame = await client.nextMessage(250); } catch { continue; }
      if (frame.type === 'deliver') {
        delivers.push(frame);
        client.send({ type: 'delivered', messageId: frame.messageId });
        n += 1;
        client.send({ type: 'captured', body: `auto reply ${name} ${n}`, sourceRef: `m51-${name}-${n}` });
      }
    }
  };
  void loop();
  return { client, delivers, stop: () => { running = false; } };
}

/** The standard M5.1 setup: auto mode + auto-send, a delivered hop-0 user
 *  message to codex, and one codex capture at hop 1 → a pending row to
 *  astra with a countdown armed. Polls until the row exists, so a loaded
 *  parallel run cannot race it. Returns the captured message. */
async function armCountdown(
  engine: EngineHandle, gui: Client, codex: Client,
): Promise<{ id: string; seconds: number }> {
  gui.send({ type: 'set_mode', mode: 'auto', turnCap: 4, autoSend: true, autoSendDelaySec: 3 });
  const seed = engine.store.insertMessage({ source: 'user', targets: ['user'], body: 'seed', hop: 0 });
  engine.store.insertDelivery(seed.id, 'codex');
  engine.store.markStatus(seed.id, 'codex', 'queued');
  engine.store.markStatus(seed.id, 'codex', 'delivered');
  codex.send({ type: 'captured', body: 'count me down', sourceRef: 'm51-arm-1' });
  const deadline = Date.now() + 8000;
  for (;;) {
    await pause(200);
    const message = engine.store.recentMessages(1)[0];
    if (message.id !== seed.id && engine.store.getDelivery(message.id, 'astra')?.status === 'pending_approval') {
      return { id: message.id, seconds: 3 };
    }
    if (Date.now() > deadline) throw new Error(`armCountdown never settled; newest is ${message.body}`);
  }
}

test('auto: the cap is never exceeded — the chain holds and never moves again', async () => {
  const clock = new FakeClock();
  await withEngine('autocap', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const guiLog = collector(gui);
    const codex = await autoReplyAdapter(url, token, 'codex');
    const astra = await autoReplyAdapter(url, token, 'astra');
    gui.send({ type: 'set_mode', mode: 'auto', turnCap: 4, autoSend: true, autoSendDelaySec: 3 });
    gui.send({ type: 'send', body: 'start the chain', targets: ['codex'] });
    for (let round = 0; round < 12; round++) {
      await pause(300);
      clock.advance(3000);
      await pause(300);
    }
    const delivers = [...codex.delivers, ...astra.delivers];
    const hops = delivers.map((d) => Number(/hop (\d+)\]/.exec(String(d.text))?.[1] ?? 0));
    assert.equal(delivers.length, 4, 'exactly four deliveries: the user turn plus three AI hops');
    assert.deepEqual([...hops].sort((a, b) => a - b), [1, 2, 3, 4], 'header hops 1..4 — none pass the cap');
    assert.equal(hops.every((h) => h <= 4), true, 'no delivered header hop exceeds the cap');
    const held = guiLog.frames.filter((f) => f.type === 'routing_held');
    assert.equal(held.length, 1, 'exactly one hold');
    assert.equal(held[0].hop, 4, 'the hold fires at hop 4');
    assert.equal(held[0].cap, 4);
    assert.equal(guiLog.frames.filter((f) => f.type === 'countdown' && f.seconds === 3).length, 3,
      'three countdowns started (hops 1, 2, 3)');
    assert.equal(guiLog.frames.filter((f) => f.type === 'countdown' && f.seconds === null).length, 3,
      'each countdown announced its end');
    assert.equal(engine.store.getDelivery(String(held[0].messageId), 'codex'), null,
      'the held message has no delivery row');
    // Nothing moves however far the clock advances:
    clock.advance(60000);
    await pause(400);
    clock.advance(60000);
    await pause(400);
    assert.equal([...codex.delivers, ...astra.delivers].length, 4, 'the hold froze the chain for good');
    guiLog.stop(); codex.stop(); astra.stop();
  }, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
});

test('auto with auto-send off: rows are created pending; nothing delivers without an approve', async () => {
  const clock = new FakeClock();
  await withEngine('autooff', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const guiLog = collector(gui);
    const codex = await autoReplyAdapter(url, token, 'codex');
    const astra = await openAdapter(url, token, 'astra'); // plain — never auto-delivered
    gui.send({ type: 'set_mode', mode: 'auto', turnCap: 4 });
    gui.send({ type: 'send', body: 'kick', targets: ['codex'] });
    await pause(1000);
    clock.advance(30000);
    await pause(300);
    const reply = engine.store.recentMessages(1)[0];
    assert.equal(reply.source, 'codex', 'the codex reply was captured');
    assert.equal(engine.store.getDelivery(reply.id, 'astra')?.status, 'pending_approval', 'the row waits');
    assert.equal(guiLog.frames.some((f) => f.type === 'countdown'), false, 'no countdown ever started');
    await astra.expectSilence(300);
    // The user's own approve is still the only way it moves:
    gui.send({ type: 'approve', messageId: reply.id, target: 'astra' });
    const deliver = await astra.nextMessage();
    assert.equal(deliver.type, 'deliver');
    astra.send({ type: 'delivered', messageId: reply.id });
    await pause(300);
    await astra.expectSilence(300);
    guiLog.stop(); codex.stop();
  }, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
});

test('auto-send: the countdown fires once after the delay and delivers once', async () => {
  const clock = new FakeClock();
  await withEngine('autoonce', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const guiLog = collector(gui);
    const codex = await openAdapter(url, token, 'codex');
    const astra = await openAdapter(url, token, 'astra');
    const { id } = await armCountdown(engine, gui, codex);
    assert.equal(engine.store.getDelivery(id, 'astra')?.status, 'pending_approval');
    assert.equal(guiLog.frames.some((f) => f.type === 'countdown' && f.seconds === 3), true, 'the countdown was announced');
    clock.advance(2999); // one millisecond short
    await pause(300);
    await astra.expectSilence(300);
    clock.advance(1);
    await pause(400);
    const deliver = await astra.nextMessage();
    assert.equal(deliver.type, 'deliver');
    assert.ok(String(deliver.text).startsWith(`[Relay · from Codex · #${id} · hop 2]`), 'the usual header');
    astra.send({ type: 'delivered', messageId: id });
    await pause(300);
    clock.advance(30000);
    await pause(300);
    await astra.expectSilence(300, ); // the timer fired once — nothing more
    assert.equal(engine.store.getDelivery(id, 'astra')?.status, 'delivered');
    guiLog.stop();
  }, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
});

test('auto-send: reject cancels the countdown — nothing delivers, the row is cancelled', async () => {
  const clock = new FakeClock();
  await withEngine('autocancel', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const guiLog = collector(gui);
    const codex = await openAdapter(url, token, 'codex');
    const astra = await openAdapter(url, token, 'astra');
    const { id } = await armCountdown(engine, gui, codex);
    gui.send({ type: 'reject', messageId: id, target: 'astra' });
    await pause(400);
    assert.equal(engine.store.getDelivery(id, 'astra')?.status, 'cancelled');
    assert.equal(guiLog.frames.some((f) => f.type === 'countdown' && f.seconds === null
      && f.messageId === id), true, 'the cancel was announced');
    clock.advance(60000);
    await pause(300);
    await astra.expectSilence(300);
    guiLog.stop();
  }, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
});

test('auto-send: Send now delivers immediately, and the expiry does nothing after', async () => {
  const clock = new FakeClock();
  await withEngine('autosendnow', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    const astra = await openAdapter(url, token, 'astra');
    const { id } = await armCountdown(engine, gui, codex);
    gui.send({ type: 'approve', messageId: id, target: 'astra' });
    const deliver = await astra.nextMessage();
    assert.equal(deliver.type, 'deliver');
    astra.send({ type: 'delivered', messageId: id });
    await pause(300);
    clock.advance(60000); // the cleared timer never fires
    await pause(300);
    await astra.expectSilence(300);
    assert.equal(engine.store.getDelivery(id, 'astra')?.status, 'delivered');
  }, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
});

test('Stop cancels every countdown, leaves the rows pending; Resume starts nothing', async () => {
  const clock = new FakeClock();
  await withEngine('autostop', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const guiLog = collector(gui);
    const codex = await openAdapter(url, token, 'codex');
    const astra = await openAdapter(url, token, 'astra');
    const { id } = await armCountdown(engine, gui, codex);
    gui.send({ type: 'stop' });
    await pause(400);
    assert.equal(engine.store.getDelivery(id, 'astra')?.status, 'pending_approval',
      'Stop leaves a pending row alone');
    assert.equal(guiLog.frames.some((f) => f.type === 'countdown' && f.seconds === null
      && f.messageId === id), true, 'the countdown ended');
    clock.advance(60000);
    await pause(300);
    await astra.expectSilence(300);
    gui.send({ type: 'resume' });
    await pause(300);
    clock.advance(60000);
    await pause(300);
    await astra.expectSilence(300); // resume never restarts a timer
    guiLog.stop();
  }, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
});

test('a turn-cap hold cancels every running countdown', async () => {
  const clock = new FakeClock();
  await withEngine('autoholdcancel', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const guiLog = collector(gui);
    const codex = await openAdapter(url, token, 'codex');
    const astra = await openAdapter(url, token, 'astra');
    // cap 2, so a hop-2 capture is held while the hop-1 countdown runs
    gui.send({ type: 'set_mode', mode: 'auto', turnCap: 2, autoSend: true, autoSendDelaySec: 3 });
    const seed = engine.store.insertMessage({ source: 'user', targets: ['user'], body: 'seed', hop: 0 });
    engine.store.insertDelivery(seed.id, 'codex');
    engine.store.markStatus(seed.id, 'codex', 'queued');
    engine.store.markStatus(seed.id, 'codex', 'delivered');
    codex.send({ type: 'captured', body: 'first hop', sourceRef: 'm51-hold-1' });
    await pause(600);
    const first = engine.store.recentMessages(1)[0];
    assert.equal(engine.store.getDelivery(first.id, 'astra')?.status, 'pending_approval', 'the hop-1 row + countdown');
    // make the next astra capture hop 2:
    const seedA = engine.store.insertMessage({ source: 'codex', targets: ['user'], body: 'seed a', hop: 1 });
    engine.store.insertDelivery(seedA.id, 'astra');
    engine.store.markStatus(seedA.id, 'astra', 'queued');
    engine.store.markStatus(seedA.id, 'astra', 'delivered');
    astra.send({ type: 'captured', body: 'over the top', sourceRef: 'm51-hold-2' });
    await pause(600);
    const second = engine.store.recentMessages(1)[0];
    assert.equal(guiLog.frames.some((f) => f.type === 'routing_held' && f.messageId === second.id
      && f.hop === 2 && f.cap === 2), true, 'the hold was broadcast');
    assert.equal(guiLog.frames.some((f) => f.type === 'countdown' && f.seconds === null
      && f.messageId === first.id), true, 'the running countdown was cancelled by the hold');
    assert.equal(engine.store.getDelivery(first.id, 'astra')?.status, 'pending_approval', 'still pending');
    assert.equal(engine.store.getDelivery(second.id, 'codex'), null, 'the held message has no row');
    clock.advance(60000);
    await pause(300);
    await astra.expectSilence(300);
    guiLog.stop();
  }, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
});

test('unticking auto_send and leaving Auto both cancel the countdowns', async () => {
  const clock = new FakeClock();
  await withEngine('autountick', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const guiLog = collector(gui);
    const codex = await openAdapter(url, token, 'codex');
    const astra = await openAdapter(url, token, 'astra');
    // Part A — untick.
    const first = await armCountdown(engine, gui, codex);
    gui.send({ type: 'set_mode', autoSend: false });
    await pause(400);
    assert.equal(engine.store.getDelivery(first.id, 'astra')?.status, 'pending_approval');
    assert.equal(guiLog.frames.some((f) => f.type === 'countdown' && f.seconds === null
      && f.messageId === first.id), true, 'the untick cancelled the countdown');
    clock.advance(60000);
    await pause(300);
    await astra.expectSilence(300);
    // Part B — tick again, arm a second countdown, then leave Auto entirely.
    gui.send({ type: 'set_mode', autoSend: true });
    await pause(300);
    codex.send({ type: 'captured', body: 'second try', sourceRef: 'm51-untick-2' });
    await pause(600);
    const second = engine.store.recentMessages(1)[0];
    assert.notEqual(second.id, first.id);
    assert.equal(engine.store.getDelivery(second.id, 'astra')?.status, 'pending_approval');
    gui.send({ type: 'set_mode', mode: 'manual' });
    await pause(400);
    assert.equal(guiLog.frames.some((f) => f.type === 'countdown' && f.seconds === null
      && f.messageId === second.id), true, 'the mode change cancelled the countdown');
    clock.advance(60000);
    await pause(300);
    await astra.expectSilence(300);
    assert.equal(engine.store.getDelivery(second.id, 'astra')?.status, 'pending_approval');
    guiLog.stop();
  }, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
});

test('a restart drops the countdowns; nothing resumes or re-creates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-engine-autorestart-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  try {
    const clock = new FakeClock();
    { // Run 1: arm a countdown and die with it running.
      const engine = await startEngine({ port: 0, dbPath, tokenPath,
        now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openGui(url, token);
      const codex = await openAdapter(url, token, 'codex');
      await armCountdown(engine, gui, codex);
      engine.stop();
    }
    { // Run 2: a fresh engine has no timers, and nothing is re-created.
      const clock2 = new FakeClock();
      const engine = await startEngine({ port: 0, dbPath, tokenPath,
        now: clock2.now, setTimer: clock2.setTimer, clearTimer: clock2.clearTimer });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const astra = await openAdapter(url, token, 'astra');
      const gui = await openClient(url, token);
      gui.send({ type: 'gui_hello' });
      const snapshot = await gui.nextMessage() as {
        countdowns?: unknown[]; held?: unknown[]; deliveries?: Array<{ status?: string }>;
      };
      assert.deepEqual(snapshot.countdowns, [], 'no countdowns survive a restart');
      assert.deepEqual(snapshot.held, [], 'no holds survive a restart');
      assert.equal(snapshot.deliveries?.some((d) => d.status === 'pending_approval'), true,
        'the row came back pending, as ever');
      clock2.advance(60000);
      await pause(300);
      await astra.expectSilence(300); // nothing resumed, nothing re-created
      engine.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});

test('while stopped, an auto capture creates no row and no hold; Resume starts nothing', async () => {
  const clock = new FakeClock();
  await withEngine('autostopped', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const guiLog = collector(gui);
    const codex = await openAdapter(url, token, 'codex');
    const astra = await openAdapter(url, token, 'astra');
    gui.send({ type: 'stop' });
    await pause(300);
    const seed = engine.store.insertMessage({ source: 'user', targets: ['user'], body: 'seed', hop: 0 });
    engine.store.insertDelivery(seed.id, 'codex');
    engine.store.markStatus(seed.id, 'codex', 'queued');
    engine.store.markStatus(seed.id, 'codex', 'delivered');
    codex.send({ type: 'captured', body: 'while stopped', sourceRef: 'm51-stopped-1' });
    await pause(600);
    const message = engine.store.recentMessages(1)[0];
    assert.equal(message.body, 'while stopped', 'the capture is stored');
    assert.equal(engine.store.getDelivery(message.id, 'astra'), null, 'no row while stopped');
    assert.equal(guiLog.frames.some((f) => f.type === 'routing_held'), false, 'no hold while stopped');
    assert.equal(guiLog.frames.some((f) => f.type === 'countdown'), false, 'no countdown while stopped');
    gui.send({ type: 'resume' });
    await pause(300);
    clock.advance(60000);
    await pause(300);
    await astra.expectSilence(300); // resume creates nothing, starts nothing
    assert.equal(engine.store.getDelivery(message.id, 'astra'), null, 'still no row');
    guiLog.stop();
  }, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
});

test('the expiry re-check: state set directly (bypassing set_mode) still stops the delivery', async () => {
  const clock = new FakeClock();
  await withEngine('autorecheck', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    const astra = await openAdapter(url, token, 'astra');
    const first = await armCountdown(engine, gui, codex);
    // Bypass the clearing path entirely: the engine's cached settings still
    // say auto, but the store (the source of truth) says manual.
    engine.store.setRelayMode('manual');
    clock.advance(3000);
    await pause(400);
    assert.equal(engine.store.getDelivery(first.id, 'astra')?.status, 'pending_approval', 'nothing moved');
    await astra.expectSilence(300);
    // The same safety net for auto_send, again set directly:
    engine.store.setRelayMode('auto');
    codex.send({ type: 'captured', body: 'second wind', sourceRef: 'm51-recheck-2' });
    await pause(600);
    const second = engine.store.recentMessages(1)[0];
    assert.equal(engine.store.getDelivery(second.id, 'astra')?.status, 'pending_approval');
    engine.store.setAutoSend(false);
    clock.advance(30000);
    await pause(400);
    assert.equal(engine.store.getDelivery(second.id, 'astra')?.status, 'pending_approval', 'still nothing');
    await astra.expectSilence(300);
  }, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
});

test('the outbound dedupe at expiry fails the row visibly', async () => {
  const clock = new FakeClock();
  await withEngine('autodedupe', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const guiLog = collector(gui);
    const codex = await openAdapter(url, token, 'codex');
    const astra = await openAdapter(url, token, 'astra');
    gui.send({ type: 'set_mode', mode: 'auto', turnCap: 10, autoSend: true, autoSendDelaySec: 3 });
    // "D" was already delivered to astra moments ago:
    const twin = engine.store.insertMessage({ source: 'astra', targets: ['user'], body: 'D', hop: 1,
      sourceRef: 'm51-dup-1' });
    engine.store.insertDelivery(twin.id, 'astra');
    engine.store.markStatus(twin.id, 'astra', 'queued');
    engine.store.markStatus(twin.id, 'astra', 'delivered');
    codex.send({ type: 'captured', body: 'D', sourceRef: 'm51-dup-2' }); // same text, other source
    await pause(600);
    const message = engine.store.recentMessages(1)[0];
    assert.equal(message.body, 'D');
    assert.equal(engine.store.getDelivery(message.id, 'astra')?.status, 'pending_approval');
    clock.advance(3000);
    await pause(400);
    const row = engine.store.getDelivery(message.id, 'astra');
    assert.equal(row?.status, 'failed', 'the dedupe fails the row');
    assert.equal(row?.error, 'identical text was already sent to astra a moment ago');
    assert.equal(guiLog.frames.some((f) => f.type === 'delivery_update' && f.status === 'failed'
      && f.messageId === message.id), true, 'the failure was broadcast');
    await astra.expectSilence(300);
    guiLog.stop();
  }, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
});

test('codex approvals ride through an auto run untouched', async () => {
  const clock = new FakeClock();
  await withEngine('autoapprovals', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const guiLog = collector(gui);
    const codex = await openAdapter(url, token, 'codex');
    const astra = await openAdapter(url, token, 'astra');
    const { id } = await armCountdown(engine, gui, codex);
    // An approval arrives mid-countdown:
    codex.send({ type: 'approval_request', requestId: 'req-51', kind: 'command_execution',
      method: 'shell', summary: 'a smoke approval' });
    await pause(400);
    assert.equal(guiLog.frames.some((f) => f.type === 'approval_request' && f.requestId === 'req-51'),
      true, 'the approval reached the GUI');
    await codex.expectSilence(300); // the relay never answers on its own
    clock.advance(3000); // the auto-send fires anyway — approvals delay nothing
    await pause(400);
    const deliver = await astra.nextMessage();
    assert.equal(deliver.type, 'deliver', 'the countdown delivered despite the pending approval');
    astra.send({ type: 'delivered', messageId: id });
    await pause(300);
    await codex.expectSilence(300); // still not answered after the delivery
    const late = await openClient(url, token);
    late.send({ type: 'gui_hello' });
    const snapshot = await late.nextMessage() as { approvals?: Array<{ requestId?: string }> };
    assert.equal(snapshot.approvals?.some((a) => a.requestId === 'req-51'), true, 'still pending');
    // The only answering path is still the GUI's approval_answer:
    gui.send({ type: 'approval_answer', requestId: 'req-51', decision: 'decline' });
    const answer = await codex.nextMessage();
    assert.equal(answer.type, 'approval_answer');
    assert.equal(answer.requestId, 'req-51');
    assert.equal(answer.decision, 'decline');
    guiLog.stop();
  }, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
});

test('a new user message resets the chain after a hold', async () => {
  const clock = new FakeClock();
  await withEngine('autoreset', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const guiLog = collector(gui);
    const codex = await openAdapter(url, token, 'codex');
    const astra = await openAdapter(url, token, 'astra');
    gui.send({ type: 'set_mode', mode: 'auto', turnCap: 2, autoSend: true, autoSendDelaySec: 3 });
    const seed = engine.store.insertMessage({ source: 'user', targets: ['user'], body: 'seed', hop: 0 });
    engine.store.insertDelivery(seed.id, 'codex');
    engine.store.markStatus(seed.id, 'codex', 'queued');
    engine.store.markStatus(seed.id, 'codex', 'delivered');
    codex.send({ type: 'captured', body: 'one', sourceRef: 'm51-reset-1' }); // hop 1 → routed
    await pause(600);
    clock.advance(3000); // delivered to astra
    await pause(400);
    const ack = await astra.nextMessage();
    assert.equal(ack.type, 'deliver');
    astra.send({ type: 'delivered', messageId: ack.messageId });
    await pause(300);
    astra.send({ type: 'captured', body: 'two', sourceRef: 'm51-reset-2' }); // hop 2 → held
    await pause(600);
    assert.equal(guiLog.frames.filter((f) => f.type === 'routing_held').length, 1, 'the chain hit the cap');
    // A fresh user message resets the chain — it is hop 0:
    gui.send({ type: 'send', body: 'fresh start', targets: ['codex'] });
    const userDeliver = await codex.nextMessage();
    assert.equal(userDeliver.type, 'deliver');
    codex.send({ type: 'delivered', messageId: userDeliver.messageId });
    await pause(300);
    codex.send({ type: 'captured', body: 'reborn', sourceRef: 'm51-reset-3' }); // hop 1 again
    await pause(600);
    const reborn = engine.store.recentMessages(1)[0];
    assert.equal(engine.store.getDelivery(reborn.id, 'astra')?.status, 'pending_approval',
      'the reset chain routes again');
    assert.equal(guiLog.frames.filter((f) => f.type === 'routing_held').length, 1, 'no second hold');
    assert.equal(guiLog.frames.some((f) => f.type === 'countdown' && f.seconds === 3
      && f.messageId === reborn.id), true, 'a new countdown started');
    clock.advance(3000);
    await pause(400);
    const redeliver = await astra.nextMessage();
    assert.ok(String(redeliver.text).includes('reborn'), 'the reset chain delivered');
    guiLog.stop();
  }, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
});

test('the snapshot carries countdowns and held', async () => {
  const clock = new FakeClock();
  await withEngine('autosnapshot', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const codex = await openAdapter(url, token, 'codex');
    const astra = await openAdapter(url, token, 'astra');
    const { id } = await armCountdown(engine, gui, codex);
    clock.advance(1000); // one second in
    const midRun = await openClient(url, token);
    midRun.send({ type: 'gui_hello' });
    const mid = await midRun.nextMessage() as {
      countdowns?: Array<{ messageId?: string; target?: string; secondsLeft?: number }>; held?: unknown[];
    };
    assert.deepEqual(mid.countdowns, [{ messageId: id, target: 'astra', secondsLeft: 2 }],
      'a joining GUI sees the countdown with the seconds left');
    assert.deepEqual(mid.held, []);
    // Now an astra capture at hop 2 under cap 1 is held — and the hold
    // cancels the running countdown. (The capture must come from the other
    // side: a second codex capture would read as a fresh hop-0 chain.)
    gui.send({ type: 'set_mode', turnCap: 1 });
    await pause(300);
    const seedA = engine.store.insertMessage({ source: 'codex', targets: ['user'], body: 'seed a', hop: 1 });
    engine.store.insertDelivery(seedA.id, 'astra');
    engine.store.markStatus(seedA.id, 'astra', 'queued');
    engine.store.markStatus(seedA.id, 'astra', 'delivered');
    astra.send({ type: 'captured', body: 'over now', sourceRef: 'm51-snap-2' });
    await pause(600);
    const afterHold = await openClient(url, token);
    afterHold.send({ type: 'gui_hello' });
    const after = await afterHold.nextMessage() as {
      countdowns?: unknown[]; held?: Array<{ messageId?: string; hop?: number; cap?: number }>;
    };
    const heldMsg = engine.store.recentMessages(1)[0];
    assert.deepEqual(after.countdowns, [], 'the hold cancelled the running countdown');
    assert.equal(after.held?.length, 1, 'the hold rides in the snapshot');
    assert.equal(after.held?.[0]?.messageId, heldMsg.id);
    assert.equal(after.held?.[0]?.hop, 2);
    assert.equal(after.held?.[0]?.cap, 1);
  }, { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
});

// --- M5.2: the per-session summary line ---

test('session summary: turnsUsed counts stored AI captures only', async () => {
  await withEngine('summaryturns', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const guiLog = collector(gui);
    const astra = await openAdapter(url, token, 'astra');
    const codex = await openAdapter(url, token, 'codex');
    // A stored AI capture counts:
    astra.send({ type: 'captured', body: 'count me', sourceRef: 'm52-1' });
    await pause(600);
    assert.equal(engine.store.recentMessages(1)[0].source, 'astra');
    const summaries = () => guiLog.frames.filter((f) => f.type === 'session_summary');
    assert.equal(summaries().length, 1, 'one broadcast for one stored capture');
    assert.equal(summaries()[0].turnsUsed, 1);
    assert.equal(summaries()[0].held, 0);
    assert.equal(summaries()[0].approvalsPending, 0);
    assert.equal(typeof summaries()[0].since, 'string', 'the engine start time, ISO 8601');
    // A duplicate capture is dropped by the store — nothing counts, nothing broadcasts:
    astra.send({ type: 'captured', body: 'count me', sourceRef: 'm52-1' });
    await pause(600);
    assert.equal(summaries().length, 1);
    // An echo is dropped too: deliver the user's text to codex, then codex
    // "replies" with the same text — the echo rule eats it.
    gui.send({ type: 'send', body: 'echo bait', targets: ['codex'] });
    await pause(800);
    codex.send({ type: 'captured', body: 'echo bait', sourceRef: 'm52-echo' });
    await pause(600);
    assert.equal(summaries().length, 1, 'the echo never counted');
    // A user message is not an AI turn — the summary is unchanged by the
    // send above, and a no-op frame changes nothing either:
    gui.send({ type: 'approve', messageId: 'UNKNOWN', target: 'codex' });
    await pause(600);
    assert.equal(summaries().length, 1, 'nothing changed, nothing broadcast');
    // The snapshot carries the same summary:
    const late = await openClient(url, token);
    late.send({ type: 'gui_hello' });
    const snapshot = await late.nextMessage() as { summary?: { turnsUsed?: number; held?: number; approvalsPending?: number; since?: string } };
    assert.equal(snapshot.summary?.turnsUsed, 1, 'the user message and the drops did not count');
    assert.equal(snapshot.summary?.held, 0);
    assert.equal(snapshot.summary?.approvalsPending, 0);
    assert.equal(typeof snapshot.summary?.since, 'string');
    guiLog.stop();
  });
});

test('session summary: held and approvalsPending follow the live state', async () => {
  await withEngine('summarylive', async (engine, url, token) => {
    const gui = await openGui(url, token);
    const guiLog = collector(gui);
    const codex = await openAdapter(url, token, 'codex');
    // A hold (M5.1): auto, cap 1, a hop-1 capture is held.
    gui.send({ type: 'set_mode', mode: 'auto', turnCap: 1 });
    const seed = engine.store.insertMessage({ source: 'user', targets: ['user'], body: 'seed', hop: 0 });
    engine.store.insertDelivery(seed.id, 'codex');
    engine.store.markStatus(seed.id, 'codex', 'queued');
    engine.store.markStatus(seed.id, 'codex', 'delivered');
    codex.send({ type: 'captured', body: 'over the cap', sourceRef: 'm52-hold-1' });
    await pause(700);
    const heldSummary = guiLog.frames.filter((f) => f.type === 'session_summary').find((f) => f.held === 1);
    assert.notEqual(heldSummary, undefined, 'the hold is in the summary');
    assert.equal(heldSummary?.turnsUsed, 1, 'the held capture still counts as a stored AI turn');
    // Approvals arrive, are answered, arrive again, and Stop clears them:
    codex.send({ type: 'approval_request', requestId: 'req-52a', kind: 'command_execution',
      method: 'shell', summary: 'a summary' });
    await pause(500);
    assert.notEqual(guiLog.frames.find((f) => f.type === 'session_summary' && f.approvalsPending === 1), undefined,
      'a waiting approval shows');
    gui.send({ type: 'approval_answer', requestId: 'req-52a', decision: 'decline' });
    await pause(500);
    assert.notEqual(guiLog.frames.find((f) => f.type === 'session_summary' && f.approvalsPending === 0), undefined,
      'answering clears it');
    codex.send({ type: 'approval_request', requestId: 'req-52b', kind: 'command_execution',
      method: 'shell', summary: 'another' });
    await pause(500);
    gui.send({ type: 'stop' });
    await pause(500);
    assert.notEqual(guiLog.frames.find((f) => f.type === 'session_summary' && f.approvalsPending === 0
      && f.held === 1), undefined, 'Stop resolves the approval and the hold count survives');
    // A lost approval (the adapter disconnects while one waits):
    gui.send({ type: 'resume' });
    await pause(300);
    codex.send({ type: 'approval_request', requestId: 'req-52c', kind: 'command_execution',
      method: 'shell', summary: 'third' });
    await pause(500);
    assert.notEqual(guiLog.frames.find((f) => f.type === 'session_summary' && f.approvalsPending === 1), undefined);
    codex.close();
    await pause(700);
    assert.notEqual(guiLog.frames.find((f) => f.type === 'session_summary' && f.approvalsPending === 0), undefined,
      'the disconnect lost the approval and the summary followed');
    guiLog.stop();
  });
});

test('session summary: nothing is persisted — a restarted engine starts from zero', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-engine-summaryrestart-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  try {
    let firstSince: string | undefined;
    { // Run 1: two stored captures, then a no-op that must not broadcast.
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openGui(url, token);
      const guiLog = collector(gui);
      const astra = await openAdapter(url, token, 'astra');
      astra.send({ type: 'captured', body: 'one', sourceRef: 'm52-r1' });
      astra.send({ type: 'captured', body: 'two', sourceRef: 'm52-r2' });
      await pause(800);
      assert.equal(guiLog.frames.filter((f) => f.type === 'session_summary').length, 2,
        'a broadcast per change, and none for anything else');
      gui.send({ type: 'reject', messageId: 'UNKNOWN', target: 'astra' }); // a no-op: nothing changes
      await pause(600);
      assert.equal(guiLog.frames.filter((f) => f.type === 'session_summary').length, 2,
        'no broadcast when nothing changed');
      firstSince = String(guiLog.frames.find((f) => f.type === 'session_summary')?.since);
      guiLog.stop();
      engine.stop();
    }
    { // Run 2: zero again, with a new session start time.
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openClient(url, token);
      gui.send({ type: 'gui_hello' });
      const snapshot = await gui.nextMessage() as { summary?: { turnsUsed?: number; held?: number; approvalsPending?: number; since?: string } };
      assert.equal(snapshot.summary?.turnsUsed, 0, 'nothing is replayed into the new session');
      assert.equal(snapshot.summary?.held, 0);
      assert.equal(snapshot.summary?.approvalsPending, 0);
      assert.notEqual(snapshot.summary?.since, firstSince, 'a new session has a new start time');
      assert.equal((snapshot.summary?.since ?? '') > (firstSince ?? ''), true, 'the new session started later');
      engine.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});
