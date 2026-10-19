// Relay Chat — Codex adapter (M1.3). Read-only.
//
// Turns the M0.1 spike into an adapter per the SPEC's adapter contract: report
// status, report completed messages — nothing else. It NEVER starts, resumes or
// writes turns; the spike's write path belongs to M2.2's `deliver`.
//
// Architecture (validated by experiment, docs/status/m1.3.md):
//   - The adapter spawns its OWN `codex app-server` (never the desktop app's).
//   - It polls thread/turns/list on the configured thread WITHOUT resuming it,
//     so it never holds the thread's single-writer lock and the user's own
//     Codex sessions (desktop app, CLI) keep working on that thread.
//   - A live foreign turn appears as status "interrupted" to a non-owner; a
//     fresh interrupted turn therefore reads as "streaming", guarded by a
//     time window so a genuinely interrupted turn falls back to "idle".
//   - A turn that reaches "completed" is captured: its last agentMessage text
//     is sent to the engine as {type:'captured'} with the turn id as sourceRef.
//     The engine's store dedupes across restarts via that sourceRef.
//
// Usage: node adapters/codex/adapter.ts <thread-id> [--engine ws://127.0.0.1:8787]
//                                          [--token <path>] [--poll-ms 1000]
// The token comes from %APPDATA%\RelayChat\token (the engine creates it).

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ThreadTurnsListResponse } from '../../spikes/codex-schema/v2/ThreadTurnsListResponse.ts';

const ADAPTER_VERSION = '0.1.0';

/** How long a foreign turn showing "interrupted" still counts as streaming. */
export const STREAMING_WINDOW_SEC = 180;

/** Minimal structural view of a Turn — the generated Turn type is assignable to this. */
export interface ObservedTurn {
  id: string;
  status: string;                          // TurnStatus values, kept loose for resilience
  startedAt: number | null;               // unix seconds
  items: Array<{ type: string; text?: string }>;
}

export interface PlannedCapture { body: string; sourceRef: string; }

export interface PollPlan {
  /** Captures ready to send, oldest turn first. Mark each sourceRef seen after a successful send. */
  captures: PlannedCapture[];
  /** Completed turns with no reportable final text — mark them seen without capturing. */
  seenWithoutCapture: string[];
  adapterStatus: 'idle' | 'streaming';
}

/**
 * Pure decision from one turns/list poll (newest-first list, never mutates its inputs).
 * The caller marks sourceRefs seen only after successful sends, so disconnects
 * retry instead of losing turns.
 */
export function planPoll(turnsDesc: ObservedTurn[], reportedIds: Set<string>, nowMs: number): PollPlan {
  const captures: PlannedCapture[] = [];
  const seenWithoutCapture: string[] = [];
  for (const turn of turnsDesc) {
    if (turn.status !== 'completed' || reportedIds.has(turn.id)) continue;
    const agent = [...turn.items].reverse()
      .find((item) => item.type === 'agentMessage' && (item.text ?? '').trim() !== '');
    if (agent !== undefined && agent.text !== undefined) {
      captures.push({ body: agent.text, sourceRef: turn.id });
    } else {
      seenWithoutCapture.push(turn.id); // completed but no final text — never capture partials
    }
  }
  captures.reverse(); // report oldest first

  const newest = turnsDesc[0];
  let adapterStatus: 'idle' | 'streaming' = 'idle';
  if (newest !== undefined) {
    const fresh = newest.startedAt !== null && nowMs / 1000 - newest.startedAt < STREAMING_WINDOW_SEC;
    if (newest.status === 'inProgress' || (newest.status === 'interrupted' && fresh)) {
      adapterStatus = 'streaming';
    }
  }
  return { captures, seenWithoutCapture, adapterStatus };
}

// --- minimal codex app-server client (NDJSON JSON-RPC over stdio, M0.1-proven) ---

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; }

class CodexClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor() {
    this.child = spawn('codex', ['app-server'], {
      shell: process.platform === 'win32', // npm's codex shim is a .cmd on Windows
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.child.on('exit', (code) => {
      console.error(`[codex-adapter] codex app-server exited (code=${code ?? '?'})`);
      process.exit(1);
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (frame.method !== undefined) {
      if (frame.id !== undefined && frame.id !== null) {
        // A request FROM codex (approval, user input). Hard rule: never auto-answer.
        console.error(`[codex-adapter] server request (not answered): ${String(frame.method)}`);
        return;
      }
      if (frame.method === 'error') {
        console.error('[codex-adapter] codex error notification:', JSON.stringify(frame.params));
      }
      return; // lifecycle noise is tolerated, not acted on
    }
    if (frame.id !== undefined) {
      const waiter = this.pending.get(Number(frame.id));
      if (waiter !== undefined) {
        this.pending.delete(Number(frame.id));
        if (frame.error !== undefined) waiter.reject(new Error(JSON.stringify(frame.error)));
        else waiter.resolve(frame.result);
      }
    }
  }

  send(frame: unknown): void {
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ method, id, params });
    });
  }

  async handshake(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'relay-chat', title: null, version: ADAPTER_VERSION },
      capabilities: null,
    });
    this.send({ method: 'initialized' });
  }

  close(): void {
    this.child.stdin.end(); // makes app-server exit cleanly (M0.1 finding)
    this.child.kill();
  }
}

// --- CLI ---

interface Args { threadId?: string; engineUrl: string; tokenPath: string; pollMs: number; }

function parseArgs(argv: string[]): Args {
  let threadId: string | undefined;
  let engineUrl = 'ws://127.0.0.1:8787';
  let tokenPath = join(process.env.APPDATA ?? '.', 'RelayChat', 'token');
  let pollMs = 1000;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--engine') engineUrl = argv[++i] ?? '';
    else if (arg === '--token') tokenPath = argv[++i] ?? '';
    else if (arg === '--poll-ms') pollMs = Number(argv[++i] ?? '1000');
    else threadId = arg;
  }
  return { threadId, engineUrl, tokenPath, pollMs };
}

// --- engine connection (native WebSocket client) ---

let engineSocket: WebSocket | null = null;
let shuttingDown = false;
let lastEngineStatus = '';

function sendFrame(frame: unknown): boolean {
  if (engineSocket !== null && engineSocket.readyState === WebSocket.OPEN) {
    engineSocket.send(JSON.stringify(frame));
    return true;
  }
  return false;
}

function connectEngine(url: string, token: string): void {
  const socket = new WebSocket(url);
  engineSocket = socket;
  socket.onopen = () => {
    socket.send(JSON.stringify({ type: 'auth', token }));
    socket.send(JSON.stringify({ type: 'hello', name: 'codex', version: ADAPTER_VERSION }));
    lastEngineStatus = ''; // re-announce after a reconnect
    console.log('[codex-adapter] engine connection open');
  };
  socket.onclose = () => {
    if (engineSocket === socket) engineSocket = null;
    if (!shuttingDown) {
      console.error('[codex-adapter] engine connection lost — retrying in 2s');
      setTimeout(() => { if (!shuttingDown) connectEngine(url, token); }, 2000);
    }
  };
  socket.onerror = () => { /* onclose follows; retry handled there */ };
  // M1 is read-only: the engine sends this adapter nothing until M2's deliver.
}

// --- main ---

async function main(): Promise<void> {
  const { threadId, engineUrl, tokenPath, pollMs } = parseArgs(process.argv.slice(2));
  if (threadId === undefined) {
    console.error('Usage: node adapters/codex/adapter.ts <thread-id> [--engine url] [--token path] [--poll-ms n]');
    process.exit(2);
  }
  if (!existsSync(tokenPath)) {
    console.error(`[codex-adapter] token file not found: ${tokenPath} — start the engine first (it creates the token)`);
    process.exit(1);
  }
  const token = readFileSync(tokenPath, 'utf8').trim(); // value never logged

  const codex = new CodexClient();
  process.on('SIGINT', () => shutdown(codex));
  process.on('SIGTERM', () => shutdown(codex));

  await codex.handshake();
  const auth = await codex.request<{ authMethod: string | null }>('getAuthStatus',
    { includeToken: false, refreshToken: false });
  if (auth.authMethod !== 'chatgpt') {
    console.error(`[codex-adapter] codex is not logged in with a ChatGPT account (authMethod=${String(auth.authMethod)}). Run: codex login`);
    codex.close();
    process.exit(1);
  }

  // Fail fast on a thread we cannot read at all — but tolerate a brand-new
  // thread whose rollout file has not materialized on disk yet ("thread not
  // loaded"), which resolves within a few seconds.
  let readable = false;
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= 5 && !readable; attempt++) {
    try {
      await codex.request<ThreadTurnsListResponse>('thread/turns/list',
        { threadId, limit: 10, itemsView: 'full' });
      readable = true;
    } catch (err) {
      lastError = String(err);
      if (attempt < 5) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!readable) {
    console.error(`[codex-adapter] cannot read thread ${threadId}: ${lastError}`);
    codex.close();
    process.exit(1);
  }

  connectEngine(engineUrl, token);
  console.log(`[codex-adapter] watching thread ${threadId} (read-only, every ${pollMs}ms)`);

  const reported = new Set<string>();
  let consecutiveFailures = 0;
  let reportedDisconnect = false;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight || shuttingDown) return;
    inFlight = true;
    try {
      const resp = await codex.request<ThreadTurnsListResponse>('thread/turns/list',
        { threadId, limit: 10, itemsView: 'full' });
      consecutiveFailures = 0;
      reportedDisconnect = false;
      const plan = planPoll(resp.data as ObservedTurn[], reported, Date.now());
      for (const capture of plan.captures) {
        if (!sendFrame({ type: 'captured', body: capture.body, sourceRef: capture.sourceRef })) break;
        reported.add(capture.sourceRef); // only mark seen after a successful send
      }
      for (const id of plan.seenWithoutCapture) reported.add(id);
      if (plan.adapterStatus !== lastEngineStatus) {
        if (sendFrame({ type: 'status', status: plan.adapterStatus })) {
          lastEngineStatus = plan.adapterStatus;
        }
      }
    } catch (err) {
      consecutiveFailures++;
      console.error(`[codex-adapter] poll failed (${consecutiveFailures}): ${String(err).slice(0, 200)}`);
      if (consecutiveFailures >= 5 && !reportedDisconnect) {
        if (sendFrame({ type: 'status', status: 'disconnected' })) {
          reportedDisconnect = true;
          lastEngineStatus = 'disconnected';
        }
      }
    } finally {
      inFlight = false;
    }
  };

  await tick();
  const timer = setInterval(() => { void tick(); }, pollMs);
  timer.unref?.();
}

function shutdown(codex: CodexClient): void {
  shuttingDown = true;
  if (engineSocket !== null) engineSocket.close();
  codex.close();
  process.exit(0);
}

// Only run as a script, not when imported (e.g. by the tests).
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
