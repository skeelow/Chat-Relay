// Relay Chat — engine (M1.2): the localhost WebSocket server.
//
// One engine owns all routing and state (SPEC: Architecture); adapters connect
// through it and never decide where a message goes. Milestone 1 is the read-only
// room: captured replies are stored and broadcast to GUI connections, and nothing
// is ever sent to either AI — send/approve/reject/set_mode/stop are ignored until
// their milestones.
//
// Protocol (SPEC: WebSocket protocol, ws://127.0.0.1:8787, JSON one per frame):
//   client → engine  {type:'auth', token}            first frame on every connection
//   adapter → engine {type:'hello', name, version}   name is the participant it speaks for
//   adapter → engine {type:'status', status}         idle|thinking|streaming|awaiting_approval|disconnected
//   adapter → engine {type:'captured', body, sourceRef?}
//   engine → GUI     {type:'transcript_update', message}
//   engine → GUI     {type:'status_update', adapter, status}
//
// The token comes from %APPDATA%\RelayChat\token (created with a random value on
// first start). The token value is never logged. Hard rule: local only — the server
// binds 127.0.0.1, never 0.0.0.0. Hard rule: no replay — connecting a GUI
// broadcasts nothing from the stored transcript.

import { WebSocketServer, type WebSocket } from 'ws';
import { openStore, StoreError, type Participant, type RelayMessage, type RelayStore } from './store.ts';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface EngineOptions {
  port?: number;       // default 8787; 0 = OS-assigned (tests)
  host?: string;       // default '127.0.0.1' — hard rule: never 0.0.0.0
  dbPath?: string;     // default 'relay.db'
  tokenPath?: string;  // default %APPDATA%\RelayChat\token
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
  ['idle', 'thinking', 'streaming', 'awaiting_approval', 'disconnected'];
const AUTH_GRACE_MS = 5000;

interface ClientState {
  authenticated: boolean;
  participant: Participant | null;   // set by hello — adapters only
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

  const server = new WebSocketServer({ host, port: options.port ?? 8787 });
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

  const guiSockets = (): WebSocket[] =>
    [...clients.entries()].filter(([, s]) => s.authenticated && s.participant === null)
      .map(([ws]) => ws);

  const broadcast = (frame: unknown): void => {
    const text = JSON.stringify(frame);
    for (const ws of guiSockets()) ws.send(text);
  };

  const broadcastAdapterStatus = (participant: Participant, status: string): void => {
    broadcast({ type: 'status_update', adapter: participant, status });
  };

  server.on('connection', (ws: WebSocket) => {
    // First thing on every socket: a malformed frame (e.g. invalid UTF-8)
    // emits 'error' and would crash the process without a listener. Log one
    // line — never the token — and let ws close the socket.
    ws.on('error', (err: Error) => {
      console.error(`[engine] socket error: ${err.message}`);
    });

    const state: ClientState = {
      authenticated: false, participant: null, status: 'disconnected', authTimer: null,
    };
    clients.set(ws, state);
    state.authTimer = setTimeout(() => {
      if (!state.authenticated) ws.close(4400, 'auth timeout');
    }, AUTH_GRACE_MS);

    ws.on('close', () => {
      if (state.authTimer !== null) clearTimeout(state.authTimer);
      clients.delete(ws);
      if (state.participant !== null) broadcastAdapterStatus(state.participant, 'disconnected');
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
            const name = record.name;
            if (name !== 'codex' && name !== 'astra') { ws.close(4400, 'unknown adapter'); return; }
            // One adapter per participant: a new connection replaces the old one.
            // Null the old socket's participant FIRST, so its close handler
            // reports nothing — it was replaced, not disconnected — and any
            // frames it races in are ignored by the participant === null checks.
            for (const [other, otherState] of clients) {
              if (other !== ws && otherState.participant === name) {
                otherState.participant = null;
                other.close(4400, 'replaced by a new connection');
              }
            }
            state.participant = name;
            state.status = 'idle';
            broadcastAdapterStatus(name, 'idle');
            return;
          }
          case 'status': {
            if (state.participant === null) return;
            const status = record.status;
            if (typeof status !== 'string' || !VALID_STATUSES.includes(status)) return;
            state.status = status;
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
                hop: 0,                   // nothing has been relayed yet in M1
                initialStatus: 'captured',
              });
              broadcast({ type: 'transcript_update', message });
            } catch (err) {
              if (err instanceof StoreError && (err.code === 'duplicate' || err.code === 'relay_header')) {
                return; // adapters may resend; the store is the authority on duplicates
              }
              throw err;
            }
            return;
          }
          case 'send':
          case 'approve':
          case 'reject':
          case 'set_mode':
          case 'stop':
            // Milestone 1 is read-only: nothing is ever sent to either AI.
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
      for (const ws of server.clients) ws.terminate(); // server.clients is the authoritative set
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
    const code = (err as { code?: string }).code ?? String(err);
    console.error(`[engine] cannot listen on 127.0.0.1:8787: ${code}`);
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
