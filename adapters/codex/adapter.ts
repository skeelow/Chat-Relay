// Relay Chat — Codex adapter (M1.3 + M2.2).
//
// Read side (M1.3, validated by experiment, docs/status/m1.3.md): the adapter
// spawns its OWN `codex app-server` (never the desktop app's) and polls
// thread/turns/list on the relay thread WITHOUT resuming it for reads, so it
// never holds the thread's single-writer lock for reading and the user's own
// Codex sessions (desktop app, CLI) keep working. A live foreign turn reads
// as status "interrupted" with completedAt null; a genuinely interrupted turn
// has completedAt set (live observation on a dedicated thread, 2026-10-19).
// A completed turn's last agentMessage text is sent to the engine as
// {type:'captured'} with the turn id as sourceRef; the store dedupes across
// restarts via that sourceRef.
//
// Write side (M2.2, publisher decision): `deliver` starts a turn on the
// relay's DEDICATED Codex thread — chosen by CLI arg, then the engine's
// config {threadId} (settings.codex_thread_id), then a fresh thread/start
// named "Relay Chat". The writer is taken only when the first deliver arrives
// (thread/resume, never at startup). turn/start's acceptance acks `delivered`
// immediately — the engine's ack timer never waits for the turn to finish.
// A -32600 writer conflict fails visibly with the busy hint and is never
// retried. Experiment (2026-10-19, dedicated thread): thread/unsubscribe does
// NOT release the writer — the subscription is kept, so the relay thread
// cannot be typed into in the Codex app while the adapter runs.
//
// Usage: node adapters/codex/adapter.ts [thread-id] [--engine ws://127.0.0.1:8787]
//                                                [--token <path>] [--poll-ms 1000]
// A thread id given on the command line is saved (settings.codex_thread_id) —
// later runs without the arg reuse it.
// The token comes from %APPDATA%\RelayChat\token (the engine creates it).

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ThreadTurnsListResponse } from '../../spikes/codex-schema/v2/ThreadTurnsListResponse.ts';
import { hashBody } from '../../relay/store.ts';

const ADAPTER_VERSION = '0.1.0';

/** First poll only: a completed turn counts as fresh if it finished within this window. */
export const FIRST_POLL_WINDOW_SEC = 600;

/** M2.2: how the adapter picks its relay thread (publisher decision):
 *  CLI arg > engine config > start a dedicated one. */
export function chooseThread(
  argThreadId: string | undefined,
  configThreadId: string | null,
): { action: 'use'; threadId: string } | { action: 'start' } {
  if (argThreadId !== undefined) return { action: 'use', threadId: argThreadId };
  if (configThreadId !== null) return { action: 'use', threadId: configThreadId };
  return { action: 'start' };
}

/** M2.2 SPEC relay header — the same shape the store and astra's protocol use. */
const RELAY_HEADER = /^\[Relay ·/;

/** M2.2: delivered-body hashes are remembered (and echo-dropped) this long. */
export const ECHO_WINDOW_MS = 10 * 60 * 1000;

/** M2.2: the writer-conflict hint — fail visibly, never retry (publisher decision). */
const BUSY_TEXT = 'thread busy — close the Relay Chat thread in the Codex app, then forward again';

/**
 * M2.2: map a failed turn/start (or resume) to the text the engine stores on
 * the delivery row. The single-writer conflict (-32600 / "active writer")
 * gets the actionable busy hint; a JSON-RPC error surfaces its message.
 */
export function deliverFailureText(err: unknown): string {
  const text = String(err);
  if (text.includes('-32600') || text.includes('active writer')) return BUSY_TEXT;
  const match = text.match(/\{.*\}/); // the JSON.stringify'd JSON-RPC payload, if any
  if (match !== null) {
    try {
      const parsed = JSON.parse(match[0]) as { message?: unknown };
      if (typeof parsed.message === 'string' && parsed.message !== '') return parsed.message;
    } catch { /* not JSON — fall through to the raw text */ }
  }
  return text;
}

/**
 * M2.2: a delivered text is `header + '\n' + body`; only the body is worth
 * remembering for the echo drop. A malformed text has no memorable body.
 */
export function deliveredBodyOf(text: string): string {
  const newline = text.indexOf('\n');
  return newline === -1 ? '' : text.slice(newline + 1);
}

/** One remembered delivered body, for the capture-side echo drop. */
export interface DeliveredBody {
  bodyHash: string;
  atMs: number;
}

/** Minimal structural view of a Turn — the generated Turn type is assignable to this. */
export interface ObservedTurn {
  id: string;
  status: string;                          // TurnStatus values, kept loose for resilience
  startedAt: number | null;               // unix seconds
  completedAt: number | null;             // unix seconds — null while a foreign turn is live
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
 *
 * firstPoll: on the first successful poll, completed turns older than
 * FIRST_POLL_WINDOW_SEC (or with a null completedAt) are marked seen instead
 * of captured — the adapter never dumps the thread's whole history on start.
 *
 * delivered (M2.2): hashes of bodies this adapter delivered recently. A
 * capture that starts with the relay header, or whose body matches one of
 * them inside ECHO_WINDOW_MS, is the relayed text bouncing back — dropped
 * and marked seen, never queued. The engine's echo filter is the second
 * line of defence.
 */
export function planPoll(
  turnsDesc: ObservedTurn[],
  reportedIds: Set<string>,
  nowMs: number,
  firstPoll: boolean,
  delivered: DeliveredBody[] = [],
): PollPlan {
  const captures: PlannedCapture[] = [];
  const seenWithoutCapture: string[] = [];
  const deliveredHashes = new Set(
    delivered.filter((d) => nowMs - d.atMs <= ECHO_WINDOW_MS).map((d) => d.bodyHash));
  for (const turn of turnsDesc) {
    if (turn.status !== 'completed' || reportedIds.has(turn.id)) continue;
    if (firstPoll && (turn.completedAt === null ||
        nowMs / 1000 - turn.completedAt > FIRST_POLL_WINDOW_SEC)) {
      seenWithoutCapture.push(turn.id); // history, not fresh news
      continue;
    }
    const agent = [...turn.items].reverse()
      .find((item) => item.type === 'agentMessage' && (item.text ?? '').trim() !== '');
    if (agent !== undefined && agent.text !== undefined) {
      if (RELAY_HEADER.test(agent.text.trim())) {
        seenWithoutCapture.push(turn.id); // the relay header echoing back — never a reply
        continue;
      }
      if (deliveredHashes.has(hashBody(agent.text))) {
        seenWithoutCapture.push(turn.id); // a bounced delivery body (M1.4 carry, adapter side)
        continue;
      }
      captures.push({ body: agent.text, sourceRef: turn.id });
    } else {
      seenWithoutCapture.push(turn.id); // completed but no final text — never capture partials
    }
  }
  captures.reverse(); // report oldest first

  const newest = turnsDesc[0];
  let adapterStatus: 'idle' | 'streaming' = 'idle';
  if (newest !== undefined) {
    // Live observation (dedicated thread, 2026-10-19): a live foreign turn reads
    // as interrupted with completedAt null; a genuinely interrupted turn has
    // completedAt set. So no time window is needed.
    if (newest.status === 'inProgress' ||
        (newest.status === 'interrupted' && newest.completedAt === null)) {
      adapterStatus = 'streaming';
    }
  }
  return { captures, seenWithoutCapture, adapterStatus };
}

// --- minimal codex app-server client (NDJSON JSON-RPC over stdio, M0.1-proven) ---

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; }

export const REQUEST_TIMEOUT_MS = 10000;

/**
 * Pending-request bookkeeping with per-request timeouts, exported so the
 * timeout logic is testable without spawning codex. A response arriving for
 * a timed-out id is simply ignored (the lookup misses), and a hung request
 * counts as a poll failure so the failure logic behaves as designed.
 */
export class RequestTracker {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  readonly timeoutMs: number;

  constructor(timeoutMs: number = REQUEST_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  request<T>(method: string, write: (id: number) => void): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); // late responses for this id are then ignored
        reject(new Error(`codex request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      write(id);
    });
  }

  /** Settle a response; unknown ids (already timed out) are ignored. */
  handleResponse(id: number, result: unknown, error: unknown): void {
    const waiter = this.pending.get(id);
    if (waiter === undefined) return;
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    if (error !== undefined) waiter.reject(new Error(JSON.stringify(error)));
    else waiter.resolve(result);
  }
}

class CodexClient {
  private readonly child: ChildProcess;
  private readonly tracker: RequestTracker;

  constructor(timeoutMs: number = REQUEST_TIMEOUT_MS) {
    this.tracker = new RequestTracker(timeoutMs);
    this.child = spawn('codex', ['app-server'], {
      shell: process.platform === 'win32', // npm's codex shim is a .cmd on Windows
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    // stdio is piped above, so stdin/stdout are never null at runtime —
    // the nullable spawn typings cannot see the configuration (M1.4 typecheck).
    this.child.on('exit', (code) => {
      console.error(`[codex-adapter] codex app-server exited (code=${code ?? '?'})`);
      process.exit(1);
    });
    createInterface({ input: this.child.stdout! }).on('line', (line) => this.onLine(line));
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
      this.tracker.handleResponse(Number(frame.id), frame.result, frame.error);
    }
  }

  send(frame: unknown): void {
    this.child.stdin!.write(JSON.stringify(frame) + '\n');
  }

  request<T>(method: string, params: unknown): Promise<T> {
    return this.tracker.request(method, (id) => this.send({ method, id, params }));
  }

  async handshake(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'relay-chat', title: null, version: ADAPTER_VERSION },
      capabilities: null,
    });
    this.send({ method: 'initialized' });
  }

  close(): void {
    this.child.stdin!.end(); // makes app-server exit cleanly (M0.1 finding)
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

let tokenMissingLogged = false;

// --- M2.2: the write path ---

/** The thread this adapter reads and writes: CLI arg > engine config > a fresh dedicated one. */
let activeThread: string | null = null;
/** A1: the last resolveThread failure — while set, new deliveries fail at once
 *  instead of waiting for the engine's ack timeout; the next config retries. */
let resolveError: string | null = null;
/** Set once in main(); the delivery path needs the app-server client. */
let codexClient: CodexClient | null = null;
/** Resume (taking the writer) happens once, when the first deliver arrives. */
let resumedForWriting = false;
/** Hashes of bodies delivered inside the echo window, for the capture drop. */
const recentDelivered = new Map<string, number>(); // bodyHash -> delivered-at ms
/** Deliveries run one at a time — a thread has a single writer. */
let deliveryChain: Promise<void> = Promise.resolve();
/** The poll interval from the CLI, used by the single watch loop. */
let pollMsGlobal = 1000;
/** The read side starts once, on the thread this adapter settled on. */
let watching = false;

function connectEngine(url: string, tokenPath: string): void {
  // The token is re-read on every attempt (never logged), so a token recreated
  // by a restarted engine is picked up on the next reconnect.
  if (!existsSync(tokenPath)) {
    if (!tokenMissingLogged) {
      console.error(`[codex-adapter] token file not found: ${tokenPath} — will keep retrying (start the engine)`);
      tokenMissingLogged = true;
    }
    setTimeout(() => { if (!shuttingDown) connectEngine(url, tokenPath); }, 2000);
    return;
  }
  tokenMissingLogged = false;
  const token = readFileSync(tokenPath, 'utf8').trim();
  const socket = new WebSocket(url);
  engineSocket = socket;
  socket.onopen = () => {
    socket.send(JSON.stringify({ type: 'auth', token }));
    socket.send(JSON.stringify({ type: 'hello', name: 'codex', version: ADAPTER_VERSION }));
    lastEngineStatus = ''; // re-announce after a reconnect
    if (activeThread !== null) {
      // The CLI-arg case reports its thread on every hello (idempotent).
      sendFrame({ type: 'thread', threadId: activeThread });
    }
    console.log('[codex-adapter] engine connection open');
  };
  socket.onmessage = (event) => {
    let frame: unknown;
    try { frame = JSON.parse(String(event.data)); } catch { return; }
    handleEngineFrame(frame);
  };
  socket.onclose = () => {
    if (engineSocket === socket) engineSocket = null;
    if (!shuttingDown) {
      console.error('[codex-adapter] engine connection lost — retrying in 2s');
      setTimeout(() => { if (!shuttingDown) connectEngine(url, tokenPath); }, 2000);
    }
  };
  socket.onerror = () => { /* onclose follows; retry handled there */ };
}

/** M2.2: the engine sends config (right after hello) and deliver (approved rows). */
function handleEngineFrame(frame: unknown): void {
  const record = frame as { type?: unknown; threadId?: unknown; messageId?: unknown; text?: unknown };
  if (record?.type === 'config') {
    // The CLI arg overrides the stored id; otherwise settle the thread now.
    // A1: every config is a fresh chance to resolve — clear a stale failure.
    if (activeThread === null) {
      resolveError = null;
      const configThreadId = typeof record.threadId === 'string' && record.threadId !== ''
        ? record.threadId
        : null;
      void resolveThread(configThreadId);
    }
    return;
  }
  if (record?.type === 'deliver') {
    if (typeof record.messageId === 'string' && typeof record.text === 'string') {
      const request = { messageId: record.messageId, text: record.text };
      if (activeThread === null) {
        if (resolveError !== null) {
          // A1: resolution already failed — fail at once, don't let the row
          // sit in the buffer until the engine's ack timeout.
          sendFrame({ type: 'failed', messageId: request.messageId, error: unresolvedDeliveryError(resolveError) });
        } else {
          // config precedes the first deliver, but a fresh thread/start is still
          // in flight — buffer instead of failing; resolveThread flushes these.
          earlyDeliveries.push(request);
        }
      } else {
        deliveryChain = deliveryChain.then(() => performDelivery(request));
      }
    }
    return;
  }
}

/** A1: the delivery failure text while the relay thread is unresolved. */
export function unresolvedDeliveryError(error: string): string {
  return `relay thread not resolved: ${error}`;
}

/** Deliveries that arrived before the thread was resolved — flushed by resolveThread. */
const earlyDeliveries: Array<{ messageId: string; text: string }> = [];

/** M2.2: settle on the relay thread, tell the engine, start the read side. */
async function resolveThread(configThreadId: string | null): Promise<void> {
  const codex = codexClient;
  if (codex === null || activeThread !== null) return;
  try {
    const decision = chooseThread(undefined, configThreadId); // the arg case never reaches here
    let threadId: string;
    if (decision.action === 'use') {
      threadId = decision.threadId;
      console.log(`[codex-adapter] using relay thread ${threadId} (from engine config)`);
    } else {
      const started = await codex.request<{ thread: { id: string } }>('thread/start', {});
      threadId = started.thread.id;
      await codex.request('thread/name/set', { threadId, name: 'Relay Chat' });
      console.log(`[codex-adapter] created dedicated relay thread ${threadId} ("Relay Chat")`);
    }
    activeThread = threadId;
    sendFrame({ type: 'thread', threadId }); // the engine stores it in settings.codex_thread_id
    startWatching(threadId);
    for (const early of earlyDeliveries.splice(0)) {
      deliveryChain = deliveryChain.then(() => performDelivery(early));
    }
  } catch (err) {
    const error = deliverFailureText(err);
    resolveError = error; // A1: fail later deliveries at once until the next config
    console.error(`[codex-adapter] cannot resolve the relay thread: ${error}`);
    for (const early of earlyDeliveries.splice(0)) {
      sendFrame({ type: 'failed', messageId: early.messageId, error: unresolvedDeliveryError(error) });
    }
  }
}

/**
 * M2.2: perform one approved delivery. `delivered` acks the moment turn/start
 * is accepted — the engine's ack timer never waits for the turn to complete.
 * On failure (a -32600 writer conflict above all) the row fails visibly; the
 * adapter never retries on its own (publisher decision).
 */
async function performDelivery(request: { messageId: string; text: string }): Promise<void> {
  const codex = codexClient;
  const threadId = activeThread;
  if (codex === null || threadId === null) {
    sendFrame({ type: 'failed', messageId: request.messageId, error: 'relay thread not resolved yet' });
    return;
  }
  try {
    if (!resumedForWriting) {
      // The writer is taken only when a delivery actually arrives — never at
      // startup, so the thread stays openable in the app until the relay
      // needs it. The subscription is then held for the adapter's lifetime:
      // thread/unsubscribe does not release the writer (experiment, 2026-10-19).
      await codex.request('thread/resume', { threadId, excludeTurns: true });
      resumedForWriting = true;
      console.log(`[codex-adapter] took the writer on ${threadId} (held until the adapter exits)`);
    }
    await codex.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: request.text, text_elements: [] }],
    });
    const body = deliveredBodyOf(request.text);
    if (body !== '') {
      recentDelivered.set(hashBody(body), Date.now());
      for (const [hash, at] of recentDelivered) {
        if (Date.now() - at > ECHO_WINDOW_MS) recentDelivered.delete(hash);
      }
    }
    if (sendFrame({ type: 'delivered', messageId: request.messageId })) {
      console.log(`[codex-adapter] delivered ${request.messageId} to codex`);
    }
  } catch (err) {
    const error = deliverFailureText(err);
    if (!sendFrame({ type: 'failed', messageId: request.messageId, error })) {
      console.error(`[codex-adapter] delivery ${request.messageId} failed (engine link down): ${error}`);
    } else {
      console.error(`[codex-adapter] delivery ${request.messageId} failed: ${error}`);
    }
  }
}

/** The M1.3 read side: readability check + poll loop, started once the thread is known. */
function startWatching(threadId: string): void {
  if (watching) return;
  watching = true;
  void watchLoop(threadId);
}

async function watchLoop(threadId: string): Promise<void> {
  const codex = codexClient;
  if (codex === null) return;
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
    process.exit(1);
  }
  console.log(`[codex-adapter] watching thread ${threadId} (read-only, every ${pollMsGlobal}ms)`);

  const reported = new Set<string>();
  let firstPoll = true; // the first successful poll must not dump the thread's history
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
      // M2.2: bodies delivered recently bounce back as echoes — planPoll drops them.
      const deliveredSnapshot: DeliveredBody[] = [...recentDelivered.entries()]
        .map(([bodyHash, atMs]) => ({ bodyHash, atMs }));
      const plan = planPoll(resp.data as ObservedTurn[], reported, Date.now(), firstPoll, deliveredSnapshot);
      firstPoll = false; // the window applied to this poll's data; excluded turns were marked seen
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
  const timer = setInterval(() => { void tick(); }, pollMsGlobal);
  timer.unref?.();
}

// --- main ---

async function main(): Promise<void> {
  const { threadId, engineUrl, tokenPath, pollMs } = parseArgs(process.argv.slice(2));
  // M2.2: the thread id is optional — CLI arg > engine config {threadId} > a
  // fresh dedicated thread. The token file is re-read per connection attempt.
  pollMsGlobal = pollMs;

  const codex = new CodexClient();
  codexClient = codex;
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

  if (threadId !== undefined) {
    // The CLI arg overrides everything; it is reported to the engine after hello.
    activeThread = threadId;
    // A2: say it once — the id is saved (settings.codex_thread_id), so a later
    // run without the arg silently reuses this thread.
    console.log(`[codex-adapter] relay thread ${threadId} (from command line — saved; later runs reuse it)`);
    startWatching(threadId);
    connectEngine(engineUrl, tokenPath);
    return;
  }
  connectEngine(engineUrl, tokenPath);
  console.log('[codex-adapter] waiting for the engine to send the relay thread (or to start one)');
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
