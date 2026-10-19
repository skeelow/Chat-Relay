// M1.2 — tests for relay/engine.ts: token auth, hello, status, captured → store,
// broadcasts to the GUI, and the read-only/no-replay rules. Uses Node's built-in
// WebSocket client against the engine's ws server on 127.0.0.1 with an
// OS-assigned port and temp token/db files per test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const gui = await openClient(url, token);
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
    const gui = await openClient(url, token);
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
    const gui = await openClient(url, token);
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
    // Run 2: same db, same token. A freshly connected GUI must hear nothing from
    // the old transcript — only live events.
    {
      const engine = await startEngine({ port: 0, dbPath, tokenPath });
      const token = readFileSync(tokenPath, 'utf8').trim();
      const url = `ws://127.0.0.1:${engine.port}`;
      const gui = await openClient(url, token);
      await gui.expectSilence(600); // nothing replayed on connect
      const codex = await openAdapter(url, token, 'codex');
      await gui.nextMessage(); // idle status_update from the new hello
      codex.send({ type: 'captured', body: 'live reply', sourceRef: 'turn-new' });
      const update = await gui.nextMessage() as { message?: { body?: string } };
      assert.equal(update.message?.body, 'live reply');
      engine.stop();
    }
  } finally {
    cleanupDir(dir);
  }
});
