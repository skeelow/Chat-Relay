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
import { hashBody } from '../relay/store.ts';

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

  send(frame: Frame): void {
    this.socket.send(JSON.stringify(frame));
  }

  async nextMessage(timeoutMs = 3000): Promise<Frame> {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
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
    return frame;
  }

  async expectSilence(timeoutMs = 500): Promise<void> {
    const queued = this.queue.shift();
    if (queued !== undefined) throw new Error(`expected silence, got ${JSON.stringify(queued)}`);
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
    if (frame !== null) throw new Error(`expected silence, got ${JSON.stringify(frame)}`);
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
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `relay-engine-${label}-`));
  const engine = await startEngine({
    port: 0,
    dbPath: join(dir, 'relay.db'),
    tokenPath: join(dir, 'token'),
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
