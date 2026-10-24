// Relay Chat — engine (M1.2): the localhost WebSocket server.
//
// One engine owns all routing and state (SPEC: Architecture); adapters connect
// through it and never decide where a message goes. Milestone 1 was the
// read-only room; M2.1 adds the approved-delivery workflow: the GUI forwards
// a stored message to codex, approves or rejects it, and the engine delivers
// with the relay header. Nothing is ever delivered without an explicit approve,
// and a restart resets every in-flight delivery to pending (hard rule:
// no replay).
//
// Protocol (SPEC: WebSocket protocol, ws://127.0.0.1:8787, JSON one per frame):
//   client → engine  {type:'auth', token}            first frame on every connection
//   adapter → engine {type:'hello', name, version}   name is the participant it speaks for
//   adapter → engine {type:'status', status}         idle|thinking|streaming|awaiting_approval|disconnected|selectors_stale
//   adapter → engine {type:'captured', body, sourceRef?}
//   adapter → engine {type:'delivered' / 'failed', messageId, error?}   ack for a delivery (M2.1)
//   GUI → engine     {type:'forward', messageId, target}                 request a delivery row (M2.1)
//   GUI → engine     {type:'approve' / 'reject', messageId, target}      M2.1: approve now requires the target
//   GUI → engine     {type:'gui_hello'}                      once, right after auth (M1.5)
//   engine → adapter {type:'deliver', messageId, text}        text carries the relay header (M2.1)
//   engine → GUI     {type:'snapshot', statuses, messages, deliveries}   one-time catch-up (deliveries: M2.1)
//   engine → GUI     {type:'transcript_update', message}
//   engine → GUI     {type:'status_update', adapter, status}
//   engine → GUI     {type:'delivery_update', messageId, target, status, attempts, updatedAt, error?} (M2.1)
//   GUI → engine    {type:'stop'}                                M3.2b: Stop halts everything
//   GUI → engine    {type:'resume'}                              M3.2b: Resume clears the stopped state
//   engine → GUI    {type:'pause_update', paused}                M3.2b: broadcast on every change
//   engine → adapter {type:'interrupt'}                          M3.2b: to codex on Stop (best effort)
//
// The token comes from %APPDATA%\RelayChat\token (created with a random value on
// first start). The token value is never logged. Hard rule: local only — the server
// binds 127.0.0.1, never 0.0.0.0. Hard rule: no replay — connecting a GUI
// broadcasts nothing from the stored transcript, and nothing is delivered
// without a fresh approval.

import { WebSocketServer, type WebSocket } from 'ws';
import {
  openStore, StoreError,
  type Participant, type PendingDelivery, type RelayMessage, type RelayStore,
} from './store.ts';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface EngineOptions {
  port?: number;       // default 8787; 0 = OS-assigned (tests)
  host?: string;       // default '127.0.0.1' — hard rule: never 0.0.0.0
  dbPath?: string;     // default 'relay.db'
  tokenPath?: string;  // default %APPDATA%\RelayChat\token
  /** M2.1: how long a delivery waits for the adapter's delivered/failed
   *  ack before the row is marked failed. Default 30 s. */
  deliverAckTimeoutMs?: number;
}

export interface EngineHandle {
  /** The port actually bound (useful when port 0 was requested). */
  port: number;
  store: RelayStore;
  stop(): void;
}

/** Adapter names are the participants they speak for; hello with anything else is rejected. */
type AdapterName = 'codex' | 'astra';

const VALID_STATUSES: readonly string[] =
  ['idle', 'thinking', 'streaming', 'awaiting_approval', 'disconnected',
   // M1.4 (astra adapter, m0.2 carry item 5): chatgpt.com renames its DOM
   // selectors regularly; the extension reports 'selectors_stale' so the
   // breakage is visible in the room instead of a silently dead adapter.
   'selectors_stale'];
const AUTH_GRACE_MS = 5000;

/** Messages a joining GUI receives in its snapshot (M1.5 handshake). */
const SNAPSHOT_LIMIT = 200;

/** M2.1: default ack window for a delivery before the row is marked failed. */
const DEFAULT_ACK_TIMEOUT_MS = 30000;

/** Display names for the relay header (SPEC: '[Relay · from <Name> · #<id> · hop <n>]'). */
const SOURCE_NAMES: Record<Participant, string> = { user: 'You', astra: 'Astra', codex: 'Codex' };

/** M2.1 SPEC relay header — the first line of every delivered text. */
function relayHeader(pending: { messageId: string; source: Participant; hop: number }): string {
  return `[Relay · from ${SOURCE_NAMES[pending.source]} · #${pending.messageId} · hop ${pending.hop + 1}]`;
}

function isParticipant(value: unknown): value is Participant {
  return value === 'user' || value === 'astra' || value === 'codex';
}

interface ClientState {
  authenticated: boolean;
  participant: Participant | null;   // set by hello — adapters only
  isGui: boolean;                   // set by gui_hello — GUIs only (M1.5)
  status: string;
  authTimer: ReturnType<typeof setTimeout> | null;
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

function loadOrCreateToken(tokenPath: string): string {
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, 'utf8').trim();
    if (TOKEN_PATTERN.test(existing)) return existing;
    // an empty or malformed token file is regenerated, not trusted
  }
  mkdirSync(dirname(tokenPath), { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath, token);
  return token;
}

function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startEngine(options: EngineOptions = {}): Promise<EngineHandle> {
  const host = options.host ?? '127.0.0.1';            // hard rule: local only
  const tokenPath = options.tokenPath ?? join(process.env.APPDATA ?? '.', 'RelayChat', 'token');
  const token = loadOrCreateToken(tokenPath);
  const store = openStore(options.dbPath ?? 'relay.db');
  const ackTimeoutMs = options.deliverAckTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  // M2.1 no-replay: nothing resumes on its own after a (re)start — every
  // in-flight delivery goes back to waiting for the user's approval.
  const resetCount = store.resetInFlightToPending();
  if (resetCount > 0) {
    console.log(`[engine] reset ${resetCount} in-flight delivery(ies) to pending_approval`);
  }
  // M3.2b (D12-1): the stopped state is a persisted setting — a restarted
  // engine that was stopped stays stopped, until the user resumes.
  let paused = store.paused();
  if (paused) {
    console.log('[engine] starting stopped — nothing delivers until the user resumes');
  }

  const server = new WebSocketServer({ host, port: options.port ?? 8787 });
  // M2.1: once stop() runs, socket close events are just teardown noise —
  // they are not adapter disconnects (and the store is closing anyway).
  let stopped = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (err) {
    store.close(); // the db handle must not leak when listening fails (e.g. EADDRINUSE)
    throw err;
  }
  const port = (server.address() as { port: number }).port;
  server.on('error', (err: Error) => console.error('[engine] server error:', err));

  const clients = new Map<WebSocket, ClientState>();

  // Current status per adapter participant (M1.5): set on hello, status
  // frames and disconnect, read by the snapshot so a late-joining GUI sees
  // reality. The 'user' entry exists only for the Participant key type —
  // no adapter registers as the user, and the snapshot reads codex/astra.
  const adapterStatuses: Record<Participant, string> = {
    user: 'disconnected', astra: 'disconnected', codex: 'disconnected',
  };

  // Broadcasts reach only GUIs that greeted (M1.5); authenticated sockets
  // that sent neither hello nor gui_hello receive nothing.
  const guiSockets = (): WebSocket[] =>
    [...clients.entries()].filter(([, s]) => s.authenticated && s.isGui && s.participant === null)
      .map(([ws]) => ws);

  const broadcast = (frame: unknown): void => {
    const text = JSON.stringify(frame);
    for (const ws of guiSockets()) ws.send(text);
  };

  const broadcastAdapterStatus = (participant: Participant, status: string): void => {
    broadcast({ type: 'status_update', adapter: participant, status });
  };

  // --- M2.1: the approved-delivery workflow ---

  /** One ack timer per in-flight delivery, keyed `${messageId}:${target}`. */
  const ackTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearAckTimer = (messageId: string, target: Participant): void => {
    const key = `${messageId}:${target}`;
    const timer = ackTimers.get(key);
    if (timer !== undefined) { clearTimeout(timer); ackTimers.delete(key); }
  };

  const broadcastDeliveryUpdate = (messageId: string, target: Participant): void => {
    const row = store.getDelivery(messageId, target);
    if (row === null) return;
    broadcast({
      type: 'delivery_update',
      messageId,
      target,
      status: row.status,
      attempts: row.attempts,
      updatedAt: row.updatedAt,
      ...(row.error !== null ? { error: row.error } : {}),
    });
  };

  const adapterSocketFor = (participant: Participant): WebSocket | null => {
    for (const [ws, state] of clients) {
      if (state.participant === participant && state.authenticated) return ws;
    }
    return null;
  };

  const failDelivery = (messageId: string, target: Participant, error: string): void => {
    const row = store.getDelivery(messageId, target);
    if (row === null || row.status !== 'delivering') return;
    store.markStatus(messageId, target, 'failed', error);
    clearAckTimer(messageId, target);
    broadcastDeliveryUpdate(messageId, target);
  };

  /** Send one queued row to its adapter, mark it delivering, arm the ack timer. */
  const deliverTo = (ws: WebSocket, pending: PendingDelivery): void => {
    const text = `${relayHeader(pending)}\n${pending.body}`;
    ws.send(JSON.stringify({ type: 'deliver', messageId: pending.messageId, text }));
    store.markStatus(pending.messageId, pending.target, 'delivering');
    clearAckTimer(pending.messageId, pending.target); // a re-delivery replaces any stale timer
    const key = `${pending.messageId}:${pending.target}`;
    ackTimers.set(key, setTimeout(() => {
      ackTimers.delete(key);
      failDelivery(pending.messageId, pending.target, 'no confirmation from adapter');
    }, ackTimeoutMs));
    broadcastDeliveryUpdate(pending.messageId, pending.target);
  };

  server.on('connection', (ws: WebSocket) => {
    // First thing on every socket: a malformed frame (e.g. invalid UTF-8)
    // emits 'error' and would crash the process without a listener. Log one
    // line — never the token — and let ws close the socket.
    ws.on('error', (err: Error) => {
      console.error(`[engine] socket error: ${err.message}`);
    });

    const state: ClientState = {
      authenticated: false, participant: null, isGui: false, status: 'disconnected', authTimer: null,
    };
    clients.set(ws, state);
    state.authTimer = setTimeout(() => {
      if (!state.authenticated) ws.close(4400, 'auth timeout');
    }, AUTH_GRACE_MS);

    ws.on('close', () => {
      if (state.authTimer !== null) clearTimeout(state.authTimer);
      clients.delete(ws);
      if (stopped) return; // engine shutdown, not an adapter disconnect
      if (state.participant !== null) {
        // M2.1: a delivery dies with its adapter — the ack will never come.
        for (const pending of store.deliveriesForTarget(state.participant, 'delivering')) {
          failDelivery(pending.messageId, state.participant, 'adapter disconnected before confirming');
        }
        adapterStatuses[state.participant] = 'disconnected';
        broadcastAdapterStatus(state.participant, 'disconnected');
      }
    });

    ws.on('message', (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch {
        if (!state.authenticated) ws.close(4401, 'unauthorized'); // non-JSON before auth
        return;
      }
      // Any frame before auth — other than auth itself — is rejected up front.
      if (!state.authenticated) {
        const isAuth = frame !== null && typeof frame === 'object' &&
          (frame as Record<string, unknown>).type === 'auth';
        if (!isAuth) { ws.close(4401, 'unauthorized'); return; }
      }
      if (frame === null || typeof frame !== 'object') return; // authenticated junk is ignored
      const record = frame as Record<string, unknown>;
      if (typeof record.type !== 'string') return;
      try {
        switch (record.type) {
          case 'auth': {
            if (state.authenticated || typeof record.token !== 'string' || !tokenMatches(token, record.token)) {
              ws.close(4401, 'unauthorized');
              return;
            }
            state.authenticated = true;
            if (state.authTimer !== null) { clearTimeout(state.authTimer); state.authTimer = null; }
            return;
          }
          case 'hello': {
            // N2: a socket that greeted as a GUI must not silently turn
            // itself into an adapter — the mirror of gui_hello's guard.
            if (state.isGui) { ws.close(4400, 'GUIs cannot be adapters'); return; }
            const name = record.name;
            if (name !== 'codex' && name !== 'astra') { ws.close(4400, 'unknown adapter'); return; }
            // One adapter per participant: a new connection replaces the old one.
            // Null the old socket's participant FIRST, so its close handler
            // reports nothing — it was replaced, not disconnected — and any
            // frames it races in are ignored by the participant === null checks.
            for (const [other, otherState] of clients) {
              if (other !== ws && otherState.participant === name) {
                // E2: the replaced socket's in-flight rows die with it — the
                // new connection never saw those deliveries.
                for (const pending of store.deliveriesForTarget(name, 'delivering')) {
                  failDelivery(pending.messageId, name, 'adapter replaced before confirming');
                }
                otherState.participant = null;
                other.close(4400, 'replaced by a new connection');
              }
            }
            state.participant = name;
            state.status = 'idle';
            adapterStatuses[name] = 'idle';
            broadcastAdapterStatus(name, 'idle');
            if (name === 'codex') {
              // M2.2: the relay's dedicated thread (or null) — sent before
              // any queued deliver so the adapter can resolve its thread.
              ws.send(JSON.stringify({ type: 'config', threadId: store.getSetting('codex_thread_id') }));
            }
            // M2.1: approved items waiting for this adapter go out now,
            // oldest first, each exactly once (each leaves 'queued').
            // M3.2b (D12-3): while stopped, a hello flushes nothing.
            if (!paused) {
              for (const pending of store.deliveriesForTarget(name, 'queued')) {
                deliverTo(ws, pending);
              }
            }
            return;
          }
          case 'status': {
            if (state.participant === null) return;
            const status = record.status;
            if (typeof status !== 'string' || !VALID_STATUSES.includes(status)) return;
            state.status = status;
            adapterStatuses[state.participant] = status;
            broadcastAdapterStatus(state.participant, status);
            return;
          }
          case 'captured': {
            if (state.participant === null) return;
            const body = record.body;
            if (typeof body !== 'string' || body.length === 0) return;
            const sourceRef = typeof record.sourceRef === 'string' ? record.sourceRef : undefined;
            try {
              const message: RelayMessage = store.insertMessage({
                source: state.participant,
                targets: ['user'],        // read-only room: the user is the only receiver
                body,
                sourceRef,
                // M3.2a (D11-1): a capture continues the relay chain when the
                // participant's last relayed text was delivered and it has
                // said nothing since; otherwise it counts as hop 0.
                hop: store.hopForCapture(state.participant),
                initialStatus: 'captured',
              });
              broadcast({ type: 'transcript_update', message });
            } catch (err) {
              if (err instanceof StoreError &&
                  (err.code === 'duplicate' || err.code === 'relay_header' || err.code === 'echo')) {
                return; // adapters may resend or echo; the store is the authority
              }
              throw err;
            }
            return;
          }
          case 'forward': {
            // M2.1 + M3.1: the GUI asks for a delivery row. Valid targets are
            // codex and astra (never a message's own source, checked below).
            const messageId = record.messageId;
            if (typeof messageId !== 'string') return;
            if (record.target !== 'codex' && record.target !== 'astra') {
              console.log(`[engine] forward ignored: target ${String(record.target)} is not an AI`);
              return;
            }
            const target: Participant = record.target;
            const message = store.getMessage(messageId);
            if (message === null) {
              console.log(`[engine] forward ignored: unknown message ${messageId}`);
              return;
            }
            if (message.source === target) {
              console.log(`[engine] forward ignored: ${target} is the message's own source`);
              return;
            }
            const existing = store.getDelivery(messageId, target);
            if (existing === null) {
              store.insertDelivery(messageId, target);
              broadcastDeliveryUpdate(messageId, target);
            } else if (existing.status === 'failed') {
              // M3.2a (D11-4): the user may retry a failed delivery at most
              // twice — three attempts and the row is final. Retries are
              // never automatic anywhere in the relay.
              if (existing.attempts >= 3) {
                console.log(`[engine] forward ignored: ${messageId} → ${target} already failed after 3 attempts`);
                return;
              }
              // A failed delivery gets a fresh start: forward again, approve again.
              store.markStatus(messageId, target, 'pending_approval');
              broadcastDeliveryUpdate(messageId, target);
            }
            // Any other state: idempotent — nothing changes, nothing broadcasts.
            return;
          }
          case 'approve': {
            // M3.2b (D12-3): while stopped, approve is ignored and logged —
            // nothing may move until the user resumes.
            if (paused) {
              console.log('[engine] approve ignored while stopped — resume first');
              return;
            }
            // M2.1: only a pending_approval row can be approved. It queues,
            // and goes out immediately when the target adapter is connected
            // (otherwise its hello sends it) — approving twice sends once.
            const messageId = record.messageId;
            if (typeof messageId !== 'string' || !isParticipant(record.target)) return;
            const target = record.target;
            const row = store.getDelivery(messageId, target);
            if (row === null || row.status !== 'pending_approval') return;
            // M3.2a (D11-3): outbound dedupe — the same text must not go to
            // the same AI twice inside the window, whatever path created the
            // second copy (the capture-side echo filter is the first half).
            const message = store.getMessage(messageId);
            const twin = message === null ? null
              : store.recentIdenticalDelivery(message.contentHash, target, messageId);
            if (twin !== null) {
              store.markStatus(messageId, target, 'failed',
                `identical text was already sent to ${target} a moment ago`);
              broadcastDeliveryUpdate(messageId, target);
              return;
            }
            store.markStatus(messageId, target, 'queued');
            broadcastDeliveryUpdate(messageId, target);
            const adapter = adapterSocketFor(target);
            if (adapter !== null) {
              const pending = store.deliveriesForTarget(target, 'queued')
                .find((p) => p.messageId === messageId);
              if (pending !== undefined) deliverTo(adapter, pending);
            }
            return;
          }
          case 'reject': {
            // M2.1: pending or queued rows become cancelled — final, nothing sent.
            const messageId = record.messageId;
            if (typeof messageId !== 'string' || !isParticipant(record.target)) return;
            const target = record.target;
            const row = store.getDelivery(messageId, target);
            if (row === null || (row.status !== 'pending_approval' && row.status !== 'queued')) return;
            store.markStatus(messageId, target, 'cancelled');
            broadcastDeliveryUpdate(messageId, target);
            return;
          }
          case 'thread': {
            // M2.2: only the codex adapter may report the relay thread; the
            // engine persists it for the next adapter launch (and restarts).
            if (state.participant !== 'codex') return;
            const threadId = record.threadId;
            if (typeof threadId !== 'string' || threadId === '') return;
            store.setSetting('codex_thread_id', threadId);
            console.log(`[engine] codex relay thread recorded: ${threadId}`);
            return;
          }
          case 'delivered':
          case 'failed': {
            // M2.1: accept the ack only from the socket registered as this
            // delivery's target participant, and only while the row is in flight.
            const target = state.participant;
            if (target === null) return;
            const messageId = record.messageId;
            if (typeof messageId !== 'string') return;
            const row = store.getDelivery(messageId, target);
            if (record.type === 'delivered' &&
                row !== null && row.status === 'failed' && row.error === 'no confirmation from adapter') {
              // E1: the ack only lost the race with the timer — the adapter
              // did receive the text. Upgrade; a genuinely failed row (the
              // adapter itself reported failure, or a replacement) stays failed.
              store.markStatus(messageId, target, 'delivered');
              clearAckTimer(messageId, target);
              broadcastDeliveryUpdate(messageId, target);
              return;
            }
            if (row === null || row.status !== 'delivering') return;
            if (record.type === 'delivered') {
              store.markStatus(messageId, target, 'delivered');
            } else {
              const error = typeof record.error === 'string' && record.error.length > 0
                ? record.error
                : 'delivery failed';
              store.markStatus(messageId, target, 'failed', error);
            }
            clearAckTimer(messageId, target);
            broadcastDeliveryUpdate(messageId, target);
            return;
          }
          case 'gui_hello': {
            // M1.5: a GUI announces itself once, right after auth. Only
            // authenticated non-adapter sockets may send it; a duplicate is
            // ignored (one snapshot per connection). Nothing is ever sent to
            // an adapter because of this — the no-replay rule concerns the
            // AIs and holds as ever.
            if (state.participant !== null) { ws.close(4400, 'adapters cannot be GUIs'); return; }
            if (state.isGui) return;
            state.isGui = true;
            const messages = store.recentMessages(SNAPSHOT_LIMIT);
            ws.send(JSON.stringify({
              type: 'snapshot',
              statuses: { codex: adapterStatuses.codex, astra: adapterStatuses.astra },
              messages,
              // M2.1: every non-user delivery row of those messages.
              deliveries: store.deliveriesOf(messages.map((m) => m.id)),
              // M3.2b: the stopped state rides along, so a joining GUI knows
              // to show the banner and keep Approve disabled.
              paused,
            }));
            return;
          }
          case 'stop': {
            // M3.2b (D12-2): Stop means stop. One synchronous pass, nothing
            // awaited on adapters: set the persisted state, return every
            // in-flight row to the user with an honest note, broadcast each
            // change, broadcast the new state, then tell the codex adapter
            // to interrupt its in-progress turns. Stop twice is the same as
            // once — a second frame changes nothing.
            if (paused) return;
            paused = true;
            store.setPaused(true);
            const inFlight = store.pendingDeliveries()
              .filter((p) => p.status === 'queued' || p.status === 'delivering');
            for (const pending of inFlight) {
              const note = pending.status === 'queued'
                ? 'stopped — approve again after you resume'
                : 'stopped before confirmation — it may already have arrived';
              store.markStatus(pending.messageId, pending.target, 'pending_approval', note);
              clearAckTimer(pending.messageId, pending.target); // Stop cancels the ack wait too
              broadcastDeliveryUpdate(pending.messageId, pending.target);
            }
            broadcast({ type: 'pause_update', paused: true });
            const codex = adapterSocketFor('codex');
            if (codex !== null) codex.send(JSON.stringify({ type: 'interrupt' }));
            console.log(`[engine] stopped: paused until resume; ${inFlight.length} in-flight row(s) returned to pending_approval`);
            return;
          }
          case 'resume': {
            // M3.2b (D12-6): Resume clears the state and delivers NOTHING —
            // every item waits for a fresh approval. Resume while running is
            // a harmless no-op.
            if (!paused) return;
            paused = false;
            store.setPaused(false);
            broadcast({ type: 'pause_update', paused: false });
            console.log('[engine] resumed');
            return;
          }
          case 'send':
          case 'set_mode':
            // Still read-only from the GUI's side until their milestones
            // (M2.1 delivered only what the user explicitly approved).
            return;
          default:
            return; // unknown frame types are ignored
        }
      } catch (err) {
        console.error('[engine] error handling frame:', err);
      }
    });
  });

  return {
    port,
    store,
    stop(): void {
      stopped = true;
      for (const ws of server.clients) ws.terminate(); // server.clients is the authoritative set
      for (const timer of ackTimers.values()) clearTimeout(timer); // M2.1: no dangling ack timers
      ackTimers.clear();
      server.close();
      store.close();
    },
  };
}

async function main(): Promise<void> {
  try {
    const engine = await startEngine();
    console.log(`[engine] listening on ws://127.0.0.1:${engine.port} (read-only room)`);
    const shutdown = (): void => { engine.stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    const info = err as { code?: string; message?: string };
    if (info.code === 'EADDRINUSE') {
      // B1: the one failure a user can fix from the message alone.
      console.error('[engine] cannot listen on 127.0.0.1:8787 (port in use)');
    } else if (info.code !== undefined && info.message !== undefined) {
      console.error(`[engine] cannot listen on 127.0.0.1:8787: ${info.code} ${info.message}`);
    } else {
      console.error(`[engine] cannot listen on 127.0.0.1:8787: ${String(err)}`);
    }
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
