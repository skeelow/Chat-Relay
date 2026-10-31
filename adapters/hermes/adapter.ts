// Relay Chat — Hermes adapter (M6.1 conversation; M6.4b work and full modes;
// M6.4b2 one session per permission mode).
//
// One Hermes run per `deliver`. The adapter keeps one dedicated Hermes
// session per permission mode (conversation, work, full) and resumes only
// that mode's session: Hermes fixes a session's toolsets and turn limit when
// it starts, so a run in perm P resumes P's session (with the same -t and
// --max-turns P always uses). A first delivery in a perm with no session
// starts fresh (no --resume). A failed resume is a failed delivery, never a
// fresh session.
// The permission mode (conversation | work | full) arrives on the deliver
// frame from the engine, chosen per message by the user in the GUI (D33).
//
// Usage: node adapters/hermes/adapter.ts [--engine ws://127.0.0.1:8787]
//                                       [--token <path>] [--profile <name>]
// The executable is resolved with `where hermes` (hermes.exe on Windows) and
// spawned with an argv array, shell:false, never a shell string.
//
// Frame contract (SPEC WebSocket protocol), adapter name `hermes`:
//   adapter -> engine: hello, status (idle/thinking), captured, thread,
//                      delivered, failed
//   engine -> adapter: config {threadId, threadIds?}, deliver, interrupt

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashBody } from '../../relay/store.ts';
import { sweepRelayOrphans, type SweepOptions } from '../../relay/process-sweep.ts';

const ADAPTER_NAME = 'hermes';
const ADAPTER_VERSION = '0.1.0';

// Mode A toolsets — a constant in code, never read from settings, frames,
// message text or environment.
export const MODE_A_TOOLSETS = 'memory,session_search';

// M6.4b (D33/S-PERM): the Work mode toolsets — the same rule applies: a
// constant in code, never read from settings, frames, messages or environment.
export const WORK_TOOLSETS = 'terminal,file,code_execution,web,todo,memory,session_search';

// M6.4b: the three permission modes. Only a GUI frame (via the stored
// delivery row) can select one; Full runs the profile's own toolsets with
// Hermes's dangerous-command block lifted, Work keeps that block on (S-PERM).
export const PERMS = ['conversation', 'work', 'full'] as const;
export type HermesPerm = (typeof PERMS)[number];

// Delivered-body echo window (10 minutes). The store keeps DUPLICATE_WINDOW_MS
// under that name; the adapter reuses the same window for its echo drop.
export const ECHO_WINDOW_MS = 10 * 60 * 1000;

export const DEFAULT_PROFILE = 'claude';
export const DEFAULT_MAX_TURNS = 6;
export const DEFAULT_MAX_RUN_SEC = 300;
// M6.4b: limits for work and full runs. The wall-clock tree kill
// (maxRunSec + TIMEOUT_EXTRA_SEC) stays the only hung-process guard — there
// is no deadline on what the agent may do (D33).
export const WORK_MAX_TURNS = 60;
export const WORK_MAX_RUN_SEC = 3600;
// Hard wall-clock extra beyond maxRunSec, in seconds (production: 30).
// `--run-budget` is deliberately NOT sent to Hermes: real Hermes rejects it
// together with `--format stream-json` (exit 2). The wall-clock kill below
// is the enforcement (decision D31, review F1).
const TIMEOUT_EXTRA_SEC = 30;

// A profile name may only contain safe characters. Anything else fails closed.
export const PROFILE_RE = /^[A-Za-z0-9_-]+$/;

// M6.4g (D37): the marker sweep is INERT by default in the class — only the
// production entry points (runForever below, the engine's main) wire the real
// sweepRelayOrphans, so no test or embedded use can touch this machine's
// process table unless it opts in explicitly.
const NO_SWEEP = (): number => 0;

const RELAY_HEADER = /^\[Relay ·/;

// %APPDATA%\RelayChat\hermes-cwd — the adapter's dedicated working directory.
export function defaultCwd(): string {
  return join(process.env.APPDATA ?? '.', 'RelayChat', 'hermes-cwd');
}

// --- pure argument building (tested without spawning) ---

export interface BuildArgvOpts {
  executable: string;
  profile: string;
  queryFile: string;
  maxTurns: number;
  maxRunSec: number;
  resume?: string | null;
  /** M6.4b: the permission mode of this run; default conversation. */
  perm?: HermesPerm;
}

/** Exact argv for one Hermes run, element 0 being the executable.
 *  conversation: `hermes -p <profile> chat --query-file <file> --format
 *  stream-json -t memory,session_search --max-turns <N> [--resume <id>]`.
 *  work: the same with `-t WORK_TOOLSETS` (Hermes's own dangerous-command
 *  block stays on — a blocked command errors and the run continues, S-PERM).
 *  full: no `-t` at all (the profile's own configured toolsets) plus the one
 *  `--yolo` that lifts the block. Each perm resumes only its own Hermes
 *  session (M6.4b2): Hermes fixes a session's toolsets and turn limit when
 *  it starts, so switching perm switches session, never overrides on a
 *  foreign session (`--resume` itself is unchanged).
 *  `--run-budget` is intentionally omitted: real Hermes rejects it together
 *  with `--format stream-json` (exit 2). The adapter's wall-clock kill
 *  (maxRunSec + TIMEOUT_EXTRA_SEC) is the enforcement (decision D31).
 *  The adapter spawns spawn(argv[0], argv.slice(1)) (prefixing `node` for a
 *  .ts/.js fake executable in tests). */
export function buildArgv(opts: BuildArgvOpts): string[] {
  if (!PROFILE_RE.test(opts.profile)) {
    throw new Error(`invalid hermes profile: ${JSON.stringify(opts.profile)}`);
  }
  const perm = opts.perm ?? 'conversation';
  const argv: string[] = [
    opts.executable,
    '-p', opts.profile,
    'chat',
    '--query-file', opts.queryFile,
    '--format', 'stream-json',
  ];
  if (perm === 'full') {
    // M6.4b (S-PERM): the one place the flag that lifts Hermes's
    // dangerous-command block may appear (static guard test).
    argv.push('--yolo');
  } else {
    argv.push('-t', perm === 'work' ? WORK_TOOLSETS : MODE_A_TOOLSETS);
  }
  argv.push('--max-turns', String(opts.maxTurns));
  if (opts.resume) argv.push('--resume', opts.resume);
  return argv;
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.HERMES_YOLO_MODE;
  return env;
}

function deliveredBodyOf(text: string): string {
  const newline = text.indexOf('\n');
  return newline === -1 ? '' : text.slice(newline + 1);
}

// --- the adapter ---

export interface HermesAdapterOptions {
  executable: string;
  profile?: string;
  maxTurns?: number;
  maxRunSec?: number;
  /** M6.4b: limits for work and full runs (defaults WORK_MAX_TURNS / WORK_MAX_RUN_SEC). */
  workMaxTurns?: number;
  workMaxRunSec?: number;
  /** Hard wall-clock extra beyond maxRunSec, in seconds (production: 30). */
  timeoutExtraSec?: number;
  cwd?: string;
  sendFrame: (frame: unknown) => void;
  startMs?: number;
  /** M6.4g (D37): kills leftover relay-cwd marker processes whose command
   *  line carries the relay cwd but which are NOT in the run's process tree
   *  (the live defect: the leaked shell's parent is the long-lived hermes
   *  server). Inert by default; runForever wires the real sweep. */
  sweep?: (options?: SweepOptions) => number;
}

interface Run {
  child: ChildProcess;
  /** Set by interrupt() so the close handler reports "Stopped". */
  requestInterrupt: () => void;
}

/** One Hermes run per deliver. Only one run at a time. */
export class HermesAdapter {
  private readonly executable: string;
  private sendFrame: (frame: unknown) => void;
  private readonly profile: string;
  private readonly maxTurns: number;
  private readonly maxRunSec: number;
  private readonly workMaxTurns: number;
  private readonly workMaxRunSec: number;
  private readonly cwd: string;
  private readonly startMs: number;
  private readonly sweep: (options?: SweepOptions) => number;

  private runNumber = 0;
  /** M6.4b2: one Hermes session per permission mode. Each slot is the id we
   *  resume for that mode; null until that mode's first result arrives. The
   *  conversation slot is cleared to null by config {threadId: null}; the
   *  work and full slots by threadIds { work|null, full|null }. */
  private readonly sessionIds: Record<HermesPerm, string | null> = {
    conversation: null,
    work: null,
    full: null,
  };
  /** Set to true once the engine's first `config` frame has arrived. Until
   *  then, deliveries fail with "waiting for engine config" (review F4). */
  private configReceived = false;
  private busy = false;
  private current: Run | null = null;
  private interrupted = false;
  private readonly timeoutExtraSec: number;

  /** Delivered-body hashes remembered inside the echo window (10 min). */
  private readonly recentDelivered = new Map<string, number>();

  constructor(options: HermesAdapterOptions) {
    this.executable = options.executable;
    this.sendFrame = options.sendFrame;
    this.profile = options.profile ?? DEFAULT_PROFILE;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxRunSec = options.maxRunSec ?? DEFAULT_MAX_RUN_SEC;
    this.workMaxTurns = options.workMaxTurns ?? WORK_MAX_TURNS;
    this.workMaxRunSec = options.workMaxRunSec ?? WORK_MAX_RUN_SEC;
    this.timeoutExtraSec = options.timeoutExtraSec ?? 30;
    this.cwd = options.cwd ?? defaultCwd();
    this.startMs = options.startMs ?? Date.now();
    this.sweep = options.sweep ?? NO_SWEEP;
  }

  /** Rebind the frame sender to a live socket (used by connectToEngine). */
  bindSendFrame(send: (frame: unknown) => void): void {
    this.sendFrame = send;
  }

  start(): void {
    try { mkdirSync(this.cwd, { recursive: true }); } catch { /* best effort */ }
    this.sendFrame({ type: 'hello', name: ADAPTER_NAME, version: ADAPTER_VERSION });
    this.sendFrame({ type: 'status', status: 'idle' });
  }

  /** Engine sent config {threadId, threadIds?} after hello. Store the ids of
   *  the modes the engine knows; null means the engine cleared that mode
   *  (a fresh session next). M6.4b2: threadIds { work, full } is optional —
   *  the old shape (threadId only) is accepted and leaves the work and full
   *  slots untouched. */
  handleConfig(threadId: string | null, threadIds?: { work?: unknown; full?: unknown } | null): void {
    this.configReceived = true; // the engine has announced its thread (F4)
    if (threadId === null || threadId === '') {
      this.sessionIds.conversation = null;
    } else if (this.sessionIds.conversation === null) {
      this.sessionIds.conversation = threadId;
    }
    if (threadIds && typeof threadIds === 'object') {
      for (const perm of ['work', 'full'] as const) {
        const id = threadIds[perm];
        if (id === null) this.sessionIds[perm] = null;
        else if (typeof id === 'string' && id !== '' && this.sessionIds[perm] === null) {
          this.sessionIds[perm] = id;
        }
      }
    }
  }

  /** Deliver one message. Fails at once with "Hermes is busy" if a run is
   *  already active (never queued). Until the engine's first `config` frame
   *  has arrived, fails with "waiting for engine config" (review F4).
   *  M6.4b (D33): `perm` selects the permission mode — a deliver without perm
   *  is conversation; work and full run with their argv and limits. An
   *  unknown perm string fails closed before anything spawns. */
  deliver(messageId: string, text: string, perm?: string): Promise<void> {
    const mode: HermesPerm | null = perm === undefined
      ? 'conversation'
      : (PERMS as readonly string[]).includes(perm) ? perm as HermesPerm : null;
    if (mode === null) {
      this.fail(messageId, 'unknown permission mode');
      return Promise.resolve();
    }
    if (this.busy) {
      this.fail(messageId, 'Hermes is busy');
      return Promise.resolve();
    }
    if (!this.configReceived) {
      this.fail(messageId, 'waiting for engine config');
      return Promise.resolve();
    }
    this.busy = true;
    this.sendFrame({ type: 'status', status: 'thinking' });
    return this.runDelivery(messageId, text, mode);
  }

  /** Engine Stop: kill the active process tree and fail with "Stopped". */
  handleInterrupt(): void {
    if (this.current === null) return;
    this.current.requestInterrupt();
  }

  /** Engine Kill (M6.4a/D33): for Hermes this is the same as Stop — kill the
   *  whole process tree at once (no graceful wait) and report the row stopped.
   *  Both leave no orphan process; Kill is the engine-side guardrail that also
   *  works when nothing is running. */
  handleKill(): void {
    if (this.current === null) return;
    this.current.requestInterrupt();
  }

  /** Kill any running tree so no orphaned hermes.exe remains on exit.
   *  Also reset busy/current so a reconnected adapter can accept new deliveries. */
  close(): void {
    if (this.current !== null) {
      killTree(this.current.child, 'adapter exit', this.sweep);
      this.current = null;
      this.interrupted = true;
    }
    this.busy = false;
  }

  // --- one run ---

  private runDelivery(messageId: string, text: string, perm: HermesPerm): Promise<void> {
    // M6.4b: conversation uses maxTurns/maxRunSec (6/300 defaults); work and
    // full use workMaxTurns/workMaxRunSec (60/3600 defaults). The wall-clock
    // tree kill below stays the only hung-process guard (D33).
    const limits = perm === 'conversation'
      ? { maxTurns: this.maxTurns, maxRunSec: this.maxRunSec }
      : { maxTurns: this.workMaxTurns, maxRunSec: this.workMaxRunSec };
    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let interrupted = false;
      let stdoutOversized = false;
      let startError: string | null = null;
      let stdoutBuf = '';
      let stderrBuf = '';
      let resultEvent: { session_id?: unknown; exit_code?: unknown; text?: unknown } | null = null;
      const resumeId = this.sessionIds[perm]; // the id this perm's session resumes, if any

      const promptFile = join(this.cwd, `prompt-${this.startMs}-${++this.runNumber}.txt`);
      let child: ChildProcess;
      try {
        // F3: wrap setup (prompt file, argv build, spawn) in try/catch so a
        // setup error never leaves the adapter wedged with busy=true.
        writeFileSync(promptFile, text, 'utf8');
        const argv = buildArgv({
          executable: this.executable,
          profile: this.profile,
          queryFile: promptFile,
          maxTurns: limits.maxTurns,
          maxRunSec: limits.maxRunSec,
          resume: resumeId,
          perm,
        });
        child = spawnCommand(argv, this.cwd);
      } catch (err) {
        this.busy = false;
        try { unlinkSync(promptFile); } catch { /* the prompt file must always be deleted */ }
        this.sendFrame({ type: 'status', status: 'idle' });
        this.fail(messageId, String(err));
        resolve();
        return;
      }

      this.current = { child, requestInterrupt: () => { interrupted = true; killTree(child, 'interrupt', this.sweep); } };

      const timeoutMs = limits.maxRunSec * 1000 + this.timeoutExtraSec * 1000;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child, 'timeout', this.sweep);
      }, timeoutMs);
      timer.unref?.();

      const MAX_STDOUT_BYTES = 8 * 1024 * 1024; // C2

      child.stdout?.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        if (stdoutBuf.length > MAX_STDOUT_BYTES) {
          stdoutOversized = true;
          killTree(child, 'output too large', this.sweep);
        }
      });
      child.stderr?.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        if (stderrBuf.length > 2048) stderrBuf = stderrBuf.slice(-2048);
      });

      child.on('error', () => {
        // C1: the executable could not be started (e.g. missing hermes.exe).
        startError = 'Hermes could not be started';
      });

      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.current = null;
        try { unlinkSync(promptFile); } catch { /* the prompt file must always be deleted */ }
        this.busy = false;
        this.sendFrame({ type: 'status', status: 'idle' });

        let error: string | null = null;
        if (startError) {
          error = startError; // C1: "Hermes could not be started"
        } else if (stdoutOversized) {
          error = 'Hermes output too large'; // C2
        } else if (interrupted) {
          error = 'Stopped';
        } else if (timedOut) {
          error = 'Hermes timed out';
        } else {
          let exitCode: number | null = null;
          try { exitCode = child.exitCode === null ? null : child.exitCode; } catch { /* ignore */ }
          if (exitCode !== 0) {
            error = `Hermes exited with code ${exitCode ?? '?'}`;
          } else {
            let parseError = false;
            for (const line of stdoutBuf.split(/\r?\n/)) {
              if (!line.trim()) continue;
              try {
                const ev = JSON.parse(line);
                if (ev && ev.type === 'result') resultEvent = ev;
              } catch { parseError = true; }
            }
            if (parseError || resultEvent === null) {
              error = 'Hermes run produced no usable result';
            } else if (resultEvent.exit_code !== 0) {
              error = `Hermes run failed (exit_code ${resultEvent.exit_code})`;
            } else if (typeof resultEvent.text !== 'string') {
              error = 'Hermes result had no text';
            }
          }
        }

        // F2: plain failure text here. Only the two session-mismatch cases in
        // succeed() use the "could not resume session X" wording.
        if (error) {
          this.fail(messageId, error);
        } else {
          const deliveredBody = deliveredBodyOf(text);
          this.succeed(messageId, resultEvent!, perm, this.runNumber, resumeId, deliveredBody);
        }
        resolve();
      };

      child.on('close', finish);
    });
  }

  private succeed(
    messageId: string,
    result: { session_id?: unknown; exit_code?: unknown; text?: unknown },
    perm: HermesPerm,
    runNumber: number,
    resumeId: string | null,
    deliveredBody: string,
  ): void {
    const sessionId = typeof result.session_id === 'string' ? result.session_id : null;
    const body = typeof result.text === 'string' ? result.text.trim() : '';

    // A failed resume (resumed but got a different session, or none) is a
    // failed delivery, never a fresh session. Only these two cases use the
    // resume wording (review F2).
    if (resumeId !== null) {
      if (sessionId === null) {
        this.failResume(messageId, resumeId, 'no session id returned');
        return;
      }
      if (sessionId !== resumeId) {
        this.failResume(messageId, resumeId, `Hermes started session ${sessionId} instead`);
        return;
      }
    }

    let capture = true;
    if (body === '') capture = false;
    else if (RELAY_HEADER.test(body)) capture = false; // the relay header echoing back
    else {
      const now = Date.now();
      for (const [hash, at] of this.recentDelivered) {
        if (now - at > ECHO_WINDOW_MS) this.recentDelivered.delete(hash);
      }
      if (this.recentDelivered.has(hashBody(body))) capture = false; // a bounced delivery
    }

    if (capture && sessionId !== null) {
      this.sendFrame({
        type: 'captured',
        body,
        sourceRef: `${sessionId}:${this.startMs}-${runNumber}`,
      });
    }

    if (sessionId !== null && sessionId !== this.sessionIds[perm]) {
      this.sessionIds[perm] = sessionId;
      // M6.4b2: the thread frame records the id in that perm's own slot. A
      // conversation frame keeps the exact old shape (no perm).
      const threadFrame: Record<string, unknown> = { type: 'thread', threadId: sessionId };
      if (perm !== 'conversation') threadFrame.perm = perm;
      this.sendFrame(threadFrame);
    }

    if (deliveredBody !== '') {
      const now = Date.now();
      this.recentDelivered.set(hashBody(deliveredBody), now);
      for (const [hash, at] of this.recentDelivered) {
        if (now - at > ECHO_WINDOW_MS) this.recentDelivered.delete(hash);
      }
    }

    this.sendFrame({ type: 'delivered', messageId });
  }

  /** F2: the "could not resume session X … Nothing was sent to a new session"
   *  wording, used only for the two session-mismatch cases, exactly once. */
  private failResume(messageId: string, resumeId: string, reason: string): void {
    this.sendFrame({
      type: 'failed',
      messageId,
      error: `Hermes could not resume session ${resumeId}: ${reason}. Nothing was sent to a new session.`,
    });
  }

  /** F2: plain failure text — no resume wording, ever. Used for "Stopped",
   *  "Hermes timed out", "Hermes exited with code N", and so on. */
  private fail(messageId: string, error: string): void {
    this.sendFrame({ type: 'failed', messageId, error });
  }
}

// --- executable resolution & spawning ---

/** Resolve the real hermes executable (`where hermes`, pick hermes.exe) so we
 *  never depend on a .cmd shim that needs a shell. */
export function resolveHermes(): string {
  try {
    const out = execSync('where hermes', { encoding: 'utf8', windowsHide: true });
    for (const line of String(out).split(/\r?\n/)) {
      const p = line.trim();
      if (p.toLowerCase().endsWith('.exe') && existsSync(p)) return p;
    }
  } catch { /* fall through to the bare name */ }
  return 'hermes';
}

function spawnCommand(argv: string[], cwd: string = defaultCwd()): ChildProcess {
  const executable = argv[0];
  const args = argv.slice(1);
  // A .ts/.js fake executable (tests) is run through node; a real .exe is
  // spawned directly, never through a shell.
  const isScript = executable.endsWith('.ts') || executable.endsWith('.js');
  return spawn(isScript ? process.execPath : executable, isScript ? [executable, ...args] : args, {
    shell: false,
    cwd,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Kill the child's whole tree, then (M6.4g, D37) sweep leftover marker
 *  processes: a run's shell can outlive the tree because its PARENT is not
 *  the run's child but the long-lived hermes server — `taskkill /T` cannot
 *  reach it. Only processes whose command line carries the relay cwd marker
 *  are terminated, with their child trees; nothing else on the PC is touched. */
function killTree(child: ChildProcess, reason: string, sweep: (options?: SweepOptions) => number): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  } catch { /* best effort; the child may already be gone */ }
  try { child.kill(); } catch { /* ignore */ }
  try {
    const swept = sweep();
    if (swept > 0) console.error(`[hermes-adapter] swept ${swept} leftover marker process(es) (${reason})`);
  } catch { /* best effort; the sweep never throws (see process-sweep.ts) */ }
}

// --- script entry point (real engine connection) ---

interface CliArgs { engineUrl: string; tokenPath: string; profile: string; }

function parseArgs(argv: string[]): CliArgs {
  let engineUrl = 'ws://127.0.0.1:8787';
  let tokenPath = join(process.env.APPDATA ?? '.', 'RelayChat', 'token');
  let profile = DEFAULT_PROFILE;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--engine') engineUrl = argv[++i] ?? engineUrl;
    else if (a === '--token') tokenPath = argv[++i] ?? tokenPath;
    else if (a === '--profile') profile = argv[++i] ?? profile;
  }
  return { engineUrl, tokenPath, profile };
}

function readToken(tokenPath: string): string | null {
  try {
    return existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : null;
  } catch { return null; }
}

export function connectToEngine(
  url: string,
  token: string,
  adapter: HermesAdapter,
  WebSocketCtor: typeof WebSocket = WebSocket,
): WebSocket {
  const ws = new WebSocketCtor(url);
  const send = (frame: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  adapter.bindSendFrame(send);
  ws.onopen = () => {
    // Send auth and start the adapter at once — the engine never sends an
    // auth reply, so we must not wait for one (the Codex adapter sends auth
    // and hello together on open).
    ws.send(JSON.stringify({ type: 'auth', token }));
    adapter.start();
  };
  ws.onmessage = (event) => {
    let frame: unknown;
    try { frame = JSON.parse(String(event.data)); } catch { return; }
    const rec = frame as Record<string, unknown>;
    if (rec.type === 'config') {
      const threadIds = rec.threadIds;
      adapter.handleConfig(
        typeof rec.threadId === 'string' ? rec.threadId : null,
        threadIds && typeof threadIds === 'object'
          ? threadIds as { work?: unknown; full?: unknown }
          : undefined,
      );
    }
    else if (rec.type === 'deliver') {
      if (typeof rec.messageId === 'string' && typeof rec.text === 'string') {
        void adapter.deliver(rec.messageId, rec.text, typeof rec.perm === 'string' ? rec.perm : undefined);
      }
    } else if (rec.type === 'interrupt') {
      adapter.handleInterrupt();
    } else if (rec.type === 'kill') {
      adapter.handleKill();
    }
  };
  ws.onclose = () => {
    adapter.close(); // kill any running tree so no orphaned hermes.exe remains
  };
  ws.onerror = () => { /* onclose handles retry */ };
  return ws;
}

export interface RunForeverOptions {
  engineUrl: string;
  tokenPath: string;
  executable: string;
  profile?: string;
  maxTurns?: number;
  maxRunSec?: number;
  timeoutExtraSec?: number;
  cwd?: string;
  startMs?: number;
  /** M6.4g: the production entry wires the real marker sweep; tests pass a
   *  no-op. The default here is the REAL sweep (unlike the class default). */
  sweep?: (options?: SweepOptions) => number;
}

export async function runForever(
  options: RunForeverOptions,
  abortSignal?: AbortSignal,
): Promise<void> {
  const sweep = options.sweep ?? sweepRelayOrphans;

  // M6.4g (D37) start orphan sweep: marker processes created BEFORE this
  // adapter started are leftovers of a previous crashed run — they die now.
  // Processes created after the adapter start are left alone.
  const orphans = sweep({ olderThanMs: Date.now() });
  if (orphans > 0) console.error(`[hermes-adapter] start sweep: terminated ${orphans} orphan process(es)`);

  const adapter = new HermesAdapter({
    executable: options.executable,
    profile: options.profile,
    maxTurns: options.maxTurns,
    maxRunSec: options.maxRunSec,
    timeoutExtraSec: options.timeoutExtraSec,
    cwd: options.cwd,
    sweep,
    // Bound by connectToEngine on each successful connection.
    sendFrame: () => { /* no socket yet */ },
    startMs: options.startMs,
  });

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  try {
    while (!abortSignal?.aborted) {
      let token: string | null = null;
      if (existsSync(options.tokenPath)) {
        try {
          token = readFileSync(options.tokenPath, 'utf8').trim();
        } catch (err) {
          console.error(`[hermes-adapter] error reading token file: ${err}`);
          token = null;
        }
      } else {
        console.error(`[hermes-adapter] token file does not exist: ${options.tokenPath}`);
      }
      if (token === null) {
        console.error(`[hermes-adapter] token file not found: ${options.tokenPath} — retrying in 2s`);
        await sleep(2000);
        continue;
      }

      const ws = connectToEngine(options.engineUrl, token, adapter);
      await new Promise<void>((resolve) => {
        const originalOnClose = ws.onclose;
        ws.onclose = () => {
          (originalOnClose as () => void)?.();
          resolve();
        };
        if (abortSignal?.aborted) {
          ws.close();
          resolve();
        }
      });

      if (abortSignal?.aborted) break;
      await sleep(2000);
    }
  } finally {
    adapter.close();
  }
}

async function main(): Promise<void> {
  const { engineUrl, tokenPath, profile } = parseArgs(process.argv.slice(2));
  const executable = resolveHermes();
  const abortController = new AbortController();

  process.on('SIGINT', () => abortController.abort());
  process.on('SIGTERM', () => abortController.abort());

  await runForever({ engineUrl, tokenPath, profile, executable }, abortController.signal);
  process.exit(0);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
