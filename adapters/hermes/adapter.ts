// Relay Chat — Hermes adapter (M6.1, Mode A conversation only).
//
// One Hermes run per `deliver`. The adapter keeps one dedicated Hermes session
// and resumes it every time: the first delivery has no --resume, every later
// one does. A failed resume is a failed delivery, never a fresh session.
//
// Usage: node adapters/hermes/adapter.ts [--engine ws://127.0.0.1:8787]
//                                       [--token <path>] [--profile <name>]
// The executable is resolved with `where hermes` (hermes.exe on Windows) and
// spawned with an argv array, shell:false, never a shell string.
//
// Frame contract (SPEC WebSocket protocol), adapter name `hermes`:
//   adapter -> engine: hello, status (idle/thinking), captured, thread,
//                      delivered, failed
//   engine -> adapter: config {threadId}, deliver, interrupt

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashBody } from '../../relay/store.ts';

const ADAPTER_NAME = 'hermes';
const ADAPTER_VERSION = '0.1.0';

// Mode A toolsets — a constant in code, never read from settings, frames,
// message text or environment.
export const MODE_A_TOOLSETS = 'memory,session_search';

// Delivered-body echo window (10 minutes). The store keeps DUPLICATE_WINDOW_MS
// under that name; the adapter reuses the same window for its echo drop.
export const ECHO_WINDOW_MS = 10 * 60 * 1000;

export const DEFAULT_PROFILE = 'claude';
export const DEFAULT_MAX_TURNS = 6;
export const DEFAULT_MAX_RUN_SEC = 300;
// Hard wall-clock extra beyond maxRunSec, in seconds (production: 30).
// `--run-budget` is deliberately NOT sent to Hermes: real Hermes rejects it
// together with `--format stream-json` (exit 2). The wall-clock kill below
// is the enforcement (decision D31, review F1).
const TIMEOUT_EXTRA_SEC = 30;

// A profile name may only contain safe characters. Anything else fails closed.
export const PROFILE_RE = /^[A-Za-z0-9_-]+$/;

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
}

/** Exact argv for one Hermes run, element 0 being the executable. Matches
 *  `hermes -p <profile> chat --query-file <file> --format stream-json
 *  -t memory,session_search --max-turns <N> [--resume <id>]`.
 *  `--run-budget` is intentionally omitted: real Hermes rejects it together
 *  with `--format stream-json` (exit 2). The adapter's wall-clock kill
 *  (maxRunSec + TIMEOUT_EXTRA_SEC) is the enforcement (decision D31).
 *  The adapter spawns spawn(argv[0], argv.slice(1)) (prefixing `node` for a
 *  .ts/.js fake executable in tests). */
export function buildArgv(opts: BuildArgvOpts): string[] {
  if (!PROFILE_RE.test(opts.profile)) {
    throw new Error(`invalid hermes profile: ${JSON.stringify(opts.profile)}`);
  }
  const argv: string[] = [
    opts.executable,
    '-p', opts.profile,
    'chat',
    '--query-file', opts.queryFile,
    '--format', 'stream-json',
    '-t', MODE_A_TOOLSETS,
    '--max-turns', String(opts.maxTurns),
  ];
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
  /** Hard wall-clock extra beyond maxRunSec, in seconds (production: 30). */
  timeoutExtraSec?: number;
  cwd?: string;
  sendFrame: (frame: unknown) => void;
  startMs?: number;
}

interface Run {
  child: ChildProcess;
  /** Set by interrupt() so the close handler reports "Stopped". */
  requestInterrupt: () => void;
}

/** One Hermes run per deliver. Only one run at a time. */
export class HermesAdapter {
  private readonly executable: string;
  private readonly sendFrame: (frame: unknown) => void;
  private readonly profile: string;
  private readonly maxTurns: number;
  private readonly maxRunSec: number;
  private readonly cwd: string;
  private readonly startMs: number;

  private runNumber = 0;
  /** The Hermes session id we resume; null until the first result arrives,
   *  and cleared to null by config {threadId: null}. */
  private knownSessionId: string | null = null;
  /** Set to true once the engine's first `config` frame has arrived. Until
   *  then, deliveries fail with "waiting for engine config" (review F4). */
  private configReceived = false;
  private busy = false;
  private current: Run | null = null;
  private readonly timeoutExtraSec: number;

  /** Delivered-body hashes remembered inside the echo window (10 min). */
  private readonly recentDelivered = new Map<string, number>();

  constructor(options: HermesAdapterOptions) {
    this.executable = options.executable;
    this.sendFrame = options.sendFrame;
    this.profile = options.profile ?? DEFAULT_PROFILE;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxRunSec = options.maxRunSec ?? DEFAULT_MAX_RUN_SEC;
    this.timeoutExtraSec = options.timeoutExtraSec ?? 30;
    this.cwd = options.cwd ?? defaultCwd();
    this.startMs = options.startMs ?? Date.now();
  }

  start(): void {
    try { mkdirSync(this.cwd, { recursive: true }); } catch { /* best effort */ }
    this.sendFrame({ type: 'hello', name: ADAPTER_NAME, version: ADAPTER_VERSION });
    this.sendFrame({ type: 'status', status: 'idle' });
  }

  /** Engine sent config {threadId} after hello. Store it as the resume id;
   *  null means the engine cleared the session (a fresh session next). */
  handleConfig(threadId: string | null): void {
    this.configReceived = true; // the engine has announced its thread (F4)
    if (threadId === null || threadId === '') {
      this.knownSessionId = null;
      return;
    }
    if (this.knownSessionId === null) this.knownSessionId = threadId;
  }

  /** Deliver one message. Fails at once with "Hermes is busy" if a run is
   *  already active (never queued). Until the engine's first `config` frame
   *  has arrived, fails with "waiting for engine config" (review F4). */
  deliver(messageId: string, text: string): Promise<void> {
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
    return this.runDelivery(messageId, text);
  }

  /** Engine Stop: kill the active process tree and fail with "Stopped". */
  handleInterrupt(): void {
    if (this.current === null) return;
    this.current.requestInterrupt();
  }

  /** Kill any running tree so no orphaned hermes.exe remains on exit. */
  close(): void {
    if (this.current !== null) killTree(this.current.child, 'adapter exit');
  }

  // --- one run ---

  private runDelivery(messageId: string, text: string): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let timedOut = false;
      let interrupted = false;
      let stdoutOversized = false;
      let startError: string | null = null;
      let stdoutBuf = '';
      let stderrBuf = '';
      let resultEvent: { session_id?: unknown; exit_code?: unknown; text?: unknown } | null = null;
      const resumeId = this.knownSessionId; // the id we asked to resume, if any

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
          maxTurns: this.maxTurns,
          maxRunSec: this.maxRunSec,
          resume: resumeId,
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

      this.current = { child, requestInterrupt: () => { interrupted = true; killTree(child, 'interrupt'); } };

      const timeoutMs = this.maxRunSec * 1000 + this.timeoutExtraSec * 1000;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child, 'timeout');
      }, timeoutMs);
      timer.unref?.();

      const MAX_STDOUT_BYTES = 8 * 1024 * 1024; // C2

      child.stdout?.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        if (stdoutBuf.length > MAX_STDOUT_BYTES) {
          stdoutOversized = true;
          killTree(child, 'output too large');
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
          this.succeed(messageId, resultEvent!, this.runNumber, resumeId, deliveredBody);
        }
        resolve();
      };

      child.on('close', finish);
    });
  }

  private succeed(
    messageId: string,
    result: { session_id?: unknown; exit_code?: unknown; text?: unknown },
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

    if (sessionId !== null && sessionId !== this.knownSessionId) {
      this.knownSessionId = sessionId;
      this.sendFrame({ type: 'thread', threadId: sessionId });
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

function killTree(child: ChildProcess, reason: string): void {
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

async function main(): Promise<void> {
  const { engineUrl, tokenPath, profile } = parseArgs(process.argv.slice(2));
  const executable = resolveHermes();
  // sendFrame is a mutable holder so it can be bound to the socket after auth.
  const sendHolder: { send: (frame: unknown) => void } = { send: () => { /* no socket yet */ } };
  const adapter = new HermesAdapter({ executable, profile, sendFrame: (f) => sendHolder.send(f) });
  let ws: WebSocket | null = null;

  const connect = (): void => {
    const token = readToken(tokenPath);
    if (token === null) {
      console.error(`[hermes-adapter] token file not found: ${tokenPath} — will keep retrying`);
      setTimeout(connect, 2000);
      return;
    }
    ws = new WebSocket(engineUrl);
    let authenticated = false;
    ws.onopen = () => { ws!.send(JSON.stringify({ type: 'auth', token })); };
    ws.onmessage = (event) => {
      let frame: unknown;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      const rec = frame as Record<string, unknown>;
      if (!authenticated) {
        if (rec.type === 'auth') {
          authenticated = true;
          sendHolder.send = (frame) => {
            if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
          };
          adapter.start(); // hello + idle, now that we're authenticated
        }
        return;
      }
      if (rec.type === 'config') adapter.handleConfig(typeof rec.threadId === 'string' ? rec.threadId : null);
      else if (rec.type === 'deliver') {
        if (typeof rec.messageId === 'string' && typeof rec.text === 'string') {
          void adapter.deliver(rec.messageId, rec.text);
        }
      } else if (rec.type === 'interrupt') {
        adapter.handleInterrupt();
      }
    };
    ws.onclose = () => {
      ws = null;
      adapter.close(); // kill any running tree so no orphaned hermes.exe remains
      if (!process.exitCode) setTimeout(connect, 2000);
    };
    ws.onerror = () => { /* onclose handles retry */ };
  };

  connect();
  process.on('SIGINT', () => { adapter.close(); process.exit(0); });
  process.on('SIGTERM', () => { adapter.close(); process.exit(0); });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
