// M6.1 — Hermes adapter tests (TDD). The live Hermes process is replaced by
// tests/fake-hermes.ts, whose behaviour is driven by env-controlled JSON:
//   FAKE_HERMES_CONTROL  path to a control JSON file (see fake-hermes.ts modes)
//   FAKE_HERMES_ARGV_FILE  path where the fake writes process.argv
//   FAKE_HERMES_ENV_FILE   path where print-env mode writes process.env
//   FAKE_HERMES_GRANDCHILD_PID_FILE  path where grandchild-hang writes the grandchild pid
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, unlinkSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { WebSocket } from 'ws';
import {
  HermesAdapter,
  buildArgv,
  connectToEngine,
  MODE_A_TOOLSETS,
  defaultCwd,
  resolveHermes,
  runForever,
  type HermesAdapterOptions,
} from '../adapters/hermes/adapter.ts';
import { startEngine, type EngineHandle } from '../relay/engine.ts';

const FAKE = join(process.cwd(), 'tests', 'fake-hermes.ts');
const TMP = mkdtempSync(join(tmpdir(), 'relay-hermes-test-'));
const argvFile = join(TMP, 'argv.json');
const envFile = join(TMP, 'env.json');
const pidFile = join(TMP, 'pid.txt');

process.env.FAKE_HERMES_ARGV_FILE = argvFile;
process.env.FAKE_HERMES_ENV_FILE = envFile;
process.env.FAKE_HERMES_GRANDCHILD_PID_FILE = pidFile;

function controlPath(name: string): string {
  return join(TMP, name);
}

function setControl(mode: string, extra: Record<string, unknown> = {}): string {
  const p = controlPath(`control-${mode}.json`);
  writeFileSync(p, JSON.stringify({ mode, ...extra }), 'utf8');
  process.env.FAKE_HERMES_CONTROL = p;
  return p;
}

function clearControl(): void {
  delete process.env.FAKE_HERMES_CONTROL;
}

function readArgv(): string[] {
  return JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
}

function readEnv(): Record<string, string> {
  return JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>;
}

function pidIsAlive(pid: string): boolean {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}"`, {
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    const text = String(out);
    return text.includes(pid) && !text.includes('No tasks');
  } catch {
    return false;
  }
}

function makeAdapter(opts: Partial<HermesAdapterOptions> & { configured?: boolean } = {}): { adapter: HermesAdapter; frames: unknown[] } {
  const { configured = true, ...adapterOpts } = opts;
  const frames: unknown[] = [];
  const adapter = new HermesAdapter({
    executable: FAKE,
    sendFrame: (f) => frames.push(f),
    maxRunSec: 1,
    timeoutExtraSec: 1, // keep the timeout test fast (production default is 30s)
    cwd: TMP,
    startMs: 1_700_000_000_000,
    ...adapterOpts,
  });
  adapter.start();
  if (configured) {
    adapter.handleConfig(null); // simulate the engine's config frame (fresh session)
  }
  return { adapter, frames };
}

function lastFrameOfType(frames: unknown[], type: string): any {
  return [...frames].reverse().find((f) => (f as { type?: string }).type === type);
}

test('buildArgv: exact argv for the first run (no --resume)', () => {
  const argv = buildArgv({
    executable: FAKE,
    profile: 'claude',
    queryFile: 'q.txt',
    maxTurns: 6,
    maxRunSec: 300,
  });
  assert.deepEqual(argv, [
    FAKE, '-p', 'claude', 'chat', '--query-file', 'q.txt', '--format', 'stream-json',
    '-t', MODE_A_TOOLSETS, '--max-turns', '6',
  ]);
});

test('buildArgv: resumed run appends --resume <id>', () => {
  const argv = buildArgv({
    executable: FAKE,
    profile: 'claude',
    queryFile: 'q.txt',
    maxTurns: 6,
    maxRunSec: 300,
    resume: 'sess-1',
  });
  assert.equal(argv.indexOf('--resume'), argv.length - 2);
  assert.equal(argv[argv.length - 1], 'sess-1');
});

test('buildArgv: every forbidden flag is absent; MODE_A_TOOLSETS present exactly once', () => {
  const argv = buildArgv({
    executable: FAKE,
    profile: 'claude',
    queryFile: 'q.txt',
    maxTurns: 6,
    maxRunSec: 300,
    resume: 'sess-1',
  });
  for (const banned of ['--yolo', '--source', '--ignore-user-config', '--safe-mode', '--accept-hooks', '-q', '--query', '--run-budget']) {
    assert.ok(!argv.includes(banned), `${banned} must never appear in argv`);
  }
  const toolsetCount = argv.filter((v) => v === MODE_A_TOOLSETS).length;
  assert.equal(toolsetCount, 1, 'MODE_A_TOOLSETS exactly once');
  const tCount = argv.filter((v) => v === '-t').length;
  assert.equal(tCount, 1, '-t exactly once');
  const tIdx = argv.indexOf('-t');
  assert.equal(argv[tIdx + 1], MODE_A_TOOLSETS);
});

test('buildArgv: the relay text is never an argv element', () => {
  const tricky = 'quotes "here" $(x) `backticks`\nnewline\n-t evil';
  const argv = buildArgv({
    executable: FAKE,
    profile: 'claude',
    queryFile: 'q.txt',
    maxTurns: 6,
    maxRunSec: 300,
  });
  assert.ok(!argv.includes(tricky));
  for (const chunk of tricky.split('\n')) assert.ok(!argv.includes(chunk));
});

test('buildArgv: profile validation fails closed', () => {
  assert.throws(() => buildArgv({
    executable: FAKE, profile: 'bad/profile', queryFile: 'q.txt', maxTurns: 6, maxRunSec: 300,
  }));
  assert.throws(() => buildArgv({
    executable: FAKE, profile: 'evil;rm', queryFile: 'q.txt', maxTurns: 6, maxRunSec: 300,
  }));
  assert.doesNotThrow(() => buildArgv({
    executable: FAKE, profile: 'claude_2', queryFile: 'q.txt', maxTurns: 6, maxRunSec: 300,
  }));
});

test('normal run: captured once, thread, delivered, temp file deleted', async () => {
  clearControl();
  setControl('normal', { text: 'the final reply' });
  const { adapter, frames } = makeAdapter();
  adapter.start();
  await adapter.deliver('m-1', 'hello hermes');

  const captured = lastFrameOfType(frames, 'captured') as { body?: string; sourceRef?: string } | undefined;
  assert.equal(captured?.body, 'the final reply');
  assert.equal(captured?.sourceRef, 'local-sess:1700000000000-1');
  const thread = lastFrameOfType(frames, 'thread') as { threadId?: string } | undefined;
  assert.equal(thread?.threadId, 'local-sess');
  assert.equal(lastFrameOfType(frames, 'delivered')?.messageId, 'm-1');
  assert.equal(frames.filter((f) => (f as { type?: string }).type === 'failed').length, 0);

  // The prompt file is deleted after the run.
  const prompt = join(TMP, `prompt-1700000000000-1.txt`);
  assert.equal(existsSync(prompt), false);
});

test('resume: second run passes --resume <first id>; thread not re-sent when unchanged', async () => {
  clearControl();
  setControl('normal', { text: 'reply one' });
  const { adapter, frames } = makeAdapter();
  adapter.start();
  await adapter.deliver('m-1', 'first');
  frames.length = 0;

  setControl('normal', { text: 'reply two' });
  await adapter.deliver('m-2', 'second');

  // argv passed to the fake hermes includes --resume <first id>.
  const argv = readArgv();
  assert.equal(argv.indexOf('--resume'), argv.length - 2);
  assert.equal(argv[argv.length - 1], 'local-sess');

  const captured = lastFrameOfType(frames, 'captured') as { body?: string } | undefined;
  assert.equal(captured?.body, 'reply two');
  // Same session id -> no new thread frame.
  assert.equal(frames.filter((f) => (f as { type?: string }).type === 'thread').length, 0);
  assert.equal(lastFrameOfType(frames, 'delivered')?.messageId, 'm-2');
});

test('config {threadId: null} clears the session so the next run is fresh', async () => {
  clearControl();
  setControl('normal', { text: 'reply one' });
  const { adapter, frames } = makeAdapter();
  adapter.start();
  await adapter.deliver('m-1', 'first');
  (adapter as { handleConfig: (t: string | null) => void }).handleConfig(null);
  frames.length = 0;

  setControl('normal', { text: 'reply two' });
  await adapter.deliver('m-2', 'second');
  const argv = readArgv();
  assert.equal(argv.includes('--resume'), false, 'no --resume after the session was cleared');
});

test('failed resume: a result with a different session id fails, no captured', async () => {
  clearControl();
  setControl('normal', { text: 'reply one' });
  const { adapter, frames } = makeAdapter();
  adapter.start();
  await adapter.deliver('m-1', 'first'); // session local-sess
  frames.length = 0;

  setControl('diff-session', { sessionId: 'other-sess', text: 'reply two' });
  await adapter.deliver('m-2', 'second');

  assert.equal(frames.filter((f) => (f as { type?: string }).type === 'captured').length, 0, 'no captured');
  const failed = lastFrameOfType(frames, 'failed') as { messageId?: string; error?: string } | undefined;
  assert.equal(failed?.messageId, 'm-2');
  assert.ok(String(failed?.error).includes('Hermes could not resume session local-sess'));
  assert.ok(String(failed?.error).includes('Nothing was sent to a new session.'));
});

test('failure: exit 1 -> failed, no captured, temp deleted', async () => {
  clearControl();
  setControl('fail');
  const { adapter, frames } = makeAdapter();
  adapter.start();
  await adapter.deliver('m-1', 'x');
  assert.equal(frames.filter((f) => (f as { type?: string }).type === 'captured').length, 0);
  const failed = lastFrameOfType(frames, 'failed') as { messageId?: string } | undefined;
  assert.equal(failed?.messageId, 'm-1');
});

test('failure: no result event -> failed, no captured', async () => {
  clearControl();
  setControl('no-result');
  const { adapter, frames } = makeAdapter();
  adapter.start();
  await adapter.deliver('m-1', 'x');
  assert.equal(frames.filter((f) => (f as { type?: string }).type === 'captured').length, 0);
  assert.equal(lastFrameOfType(frames, 'failed')?.messageId, 'm-1');
});

test('failure: result.exit_code 1 -> failed, no captured', async () => {
  clearControl();
  setControl('normal', { exitCode: 1, text: 'nope' });
  const { adapter, frames } = makeAdapter();
  adapter.start();
  await adapter.deliver('m-1', 'x');
  assert.equal(frames.filter((f) => (f as { type?: string }).type === 'captured').length, 0);
  assert.equal(lastFrameOfType(frames, 'failed')?.messageId, 'm-1');
});

test('failure: invalid JSON output -> failed, no captured', async () => {
  clearControl();
  // garbage mode prints an invalid line and exits 0.
  setControl('garbage');
  const { adapter, frames } = makeAdapter();
  adapter.start();
  await adapter.deliver('m-1', 'x');
  assert.equal(frames.filter((f) => (f as { type?: string }).type === 'captured').length, 0);
  assert.equal(lastFrameOfType(frames, 'failed')?.messageId, 'm-1');
});

test('busy: a second deliver during a run fails at once', async () => {
  clearControl();
  setControl('hang');
  const { adapter, frames } = makeAdapter();
  adapter.start();
  const p1 = adapter.deliver('m-1', 'hanging');
  // Let the run start and set the busy flag.
  await new Promise((r) => setTimeout(r, 150));
  const p2 = adapter.deliver('m-2', 'should fail busy');
  await p2;
  assert.equal(lastFrameOfType(frames, 'failed')?.messageId, 'm-2');
  assert.ok(String(lastFrameOfType(frames, 'failed')?.error).includes('Hermes is busy'));
  // The first run eventually times out.
  await p1;
});

test('timeout: the run is killed after the limit and the grandchild dies', async () => {
  clearControl();
  setControl('grandchild-hang');
  const { adapter, frames } = makeAdapter();
  adapter.start();
  await adapter.deliver('m-1', 'long answer');

  const failed = lastFrameOfType(frames, 'failed') as { error?: string } | undefined;
  assert.ok(String(failed?.error).includes('Hermes timed out'));

  // The grandchild process must be gone (whole tree killed).
  const pid = readFileSync(pidFile, 'utf8').trim();
  let gone = false;
  for (let i = 0; i < 10; i++) {
    if (!pidIsAlive(pid)) { gone = true; break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(gone, true, 'grandchild process should no longer be alive');
});

test('interrupt: kills the tree and fails with "Stopped"', async () => {
  clearControl();
  setControl('hang');
  const { adapter, frames } = makeAdapter();
  adapter.start();
  const p1 = adapter.deliver('m-1', 'hanging');
  await new Promise((r) => setTimeout(r, 150));
  adapter.handleInterrupt();
  await p1;
  assert.equal(lastFrameOfType(frames, 'failed')?.messageId, 'm-1');
  assert.equal(String(lastFrameOfType(frames, 'failed')?.error), 'Stopped');
});

test('environment: HERMES_YOLO_MODE is stripped from the child environment', async () => {
  clearControl();
  process.env.HERMES_YOLO_MODE = '1';
  try {
    setControl('print-env');
    const { adapter } = makeAdapter();
    adapter.start();
    await adapter.deliver('m-1', 'x');
    const env = readEnv();
    assert.equal(env.HERMES_YOLO_MODE, undefined, 'HERMES_YOLO_MODE must not reach the child');
  } finally {
    delete process.env.HERMES_YOLO_MODE;
  }
});

test('text with quotes, $(x), backticks, newlines: byte-exact in the prompt file, never in argv', async () => {
  clearControl();
  const tricky = 'quotes "here" $(x) `backticks`\nsecond line\n-t evil as text';
  setControl('normal', { echoQuery: true, text: tricky });
  const { adapter, frames } = makeAdapter();
  adapter.start();
  await adapter.deliver('m-1', tricky);

  const captured = lastFrameOfType(frames, 'captured') as { body?: string } | undefined;
  assert.equal(captured?.body, tricky, 'the query text arrives byte-exact');

  const argv = readArgv();
  assert.ok(!argv.includes(tricky), 'the text must not be an argv element');
  for (const chunk of tricky.split('\n')) assert.ok(!argv.includes(chunk));
});

test('header drop: a capture starting with [Relay · is not captured', async () => {
  clearControl();
  setControl('normal', { text: '[Relay · from Astra · #01XYZ · hop 1]\nthe relayed body' });
  const { adapter, frames } = makeAdapter();
  adapter.start();
  await adapter.deliver('m-1', 'x');
  assert.equal(frames.filter((f) => (f as { type?: string }).type === 'captured').length, 0, 'header echo dropped');
  assert.equal(lastFrameOfType(frames, 'delivered')?.messageId, 'm-1', 'delivery still acked');
});

test('echo drop: a body matching a recently delivered body is not captured', async () => {
  clearControl();
  const body = 'the body';
  const header = '[Relay · from Astra · #01XYZ · hop 1]';
  // Run 1: hermes replies with `body` (no header) -> captured, and the
  // delivered body `body` is remembered for the echo window.
  setControl('normal', { text: body });
  const { adapter, frames } = makeAdapter();
  adapter.start();
  await adapter.deliver('m-1', `${header}\n${body}`);
  assert.equal(lastFrameOfType(frames, 'captured')?.body, body);
  assert.equal(lastFrameOfType(frames, 'delivered')?.messageId, 'm-1');
  frames.length = 0;

  // Run 2: hermes replies with the same `body` -> echo drop, no captured.
  setControl('normal', { text: body });
  await adapter.deliver('m-2', `${header}\n${body}`);
  assert.equal(frames.filter((f) => (f as { type?: string }).type === 'captured').length, 0, 'echo dropped');
  assert.equal(lastFrameOfType(frames, 'delivered')?.messageId, 'm-2');
});

test('sourceRef is unique per run and across restarts', async () => {
  clearControl();
  setControl('normal', { text: 'a' });
  const { adapter, frames } = makeAdapter();
  adapter.start();
  await adapter.deliver('m-1', 'x');
  const first = (lastFrameOfType(frames, 'captured') as { sourceRef?: string }).sourceRef;
  frames.length = 0;
  setControl('normal', { text: 'b' });
  await adapter.deliver('m-2', 'x');
  const second = (lastFrameOfType(frames, 'captured') as { sourceRef?: string }).sourceRef;
  assert.notEqual(first, second);
  assert.ok(/^local-sess:1700000000000-[12]$/.test(first ?? ''));
  assert.ok(/^local-sess:1700000000000-[12]$/.test(second ?? ''));
});

test('static guard: no --yolo, --source or shell: true in adapter source outside comments', () => {
  const src = readFileSync(join(process.cwd(), 'adapters', 'hermes', 'adapter.ts'), 'utf8');
  const stripped = stripComments(src);
  for (const banned of ['--yolo', '--source', '--run-budget', 'shell: true']) {
    assert.ok(!stripped.includes(banned), `${banned} must not appear in the adapter source outside comments`);
  }
});

// Strip // and /* comments, keeping string/template literals (test-only).
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'quote' = 'code';
  let quote = '';
  while (i < src.length) {
    const c = src[i] ?? '';
    const n = src[i + 1] ?? '';
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { mode = 'quote'; quote = c; out += c; i++; continue; }
      out += c; i++;
    } else if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; }
      i++;
    } else if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; i += 2; } else { if (c === '\n') out += c; i++; }
    } else {
      out += c;
      if (c === '\\') { out += n; i += 2; continue; }
      if (c === quote) mode = 'code';
      i++;
    }
  }
  return out;
}

// resolveHermes resolves hermes.exe on this machine.
test('resolveHermes: resolves the real hermes executable', () => {
  const exe = resolveHermes();
  assert.ok(exe.length > 0);
  assert.ok(exe.toLowerCase().endsWith('.exe') || exe === 'hermes');
});

// defaultCwd points at the dedicated folder.
test('defaultCwd: the relay hermes-cwd folder', () => {
  const cwd = defaultCwd();
  assert.ok(cwd.includes('RelayChat') && cwd.endsWith('hermes-cwd'));
});

test('F2: interrupt on a resumed run fails with plain "Stopped" (no "resume")', async () => {
  clearControl();
  setControl('normal', { text: 'reply one' });
  const { adapter, frames } = makeAdapter();
  adapter.start();
  await adapter.deliver('m-1', 'first'); // establishes session local-sess
  frames.length = 0;

  setControl('hang');
  const p1 = adapter.deliver('m-2', 'hanging'); // resumed run
  await new Promise((r) => setTimeout(r, 150));
  adapter.handleInterrupt();
  await p1;
  const failed = lastFrameOfType(frames, 'failed');
  assert.equal(failed.messageId, 'm-2');
  assert.equal(String(failed.error), 'Stopped');
  assert.ok(!String(failed.error).includes('resume'), 'interrupt error must not mention resume');
});

test('F2: timeout on a resumed run fails with plain "Hermes timed out" (no "resume")', async () => {
  clearControl();
  setControl('normal', { text: 'reply one' });
  const { adapter, frames } = makeAdapter();
  adapter.start();
  await adapter.deliver('m-1', 'first'); // establishes session local-sess
  frames.length = 0;

  setControl('hang');
  await adapter.deliver('m-2', 'long answer'); // resumed run, times out
  const failed = lastFrameOfType(frames, 'failed');
  assert.equal(failed.messageId, 'm-2');
  assert.ok(String(failed.error).includes('Hermes timed out'));
  assert.ok(!String(failed.error).includes('resume'), 'timeout error must not mention resume');
});

test('F2: mismatch resume error contains the wording exactly once', async () => {
  clearControl();
  setControl('normal', { text: 'reply one' });
  const { adapter, frames } = makeAdapter();
  adapter.start();
  await adapter.deliver('m-1', 'first'); // establishes session local-sess
  frames.length = 0;

  setControl('diff-session', { sessionId: 'other-sess', text: 'reply two' });
  await adapter.deliver('m-2', 'second');
  const failed = lastFrameOfType(frames, 'failed');
  assert.equal(failed.messageId, 'm-2');
  const text = String(failed.error);
  assert.equal(text, `Hermes could not resume session local-sess: Hermes started session other-sess instead. Nothing was sent to a new session.`);
  // Wording appears exactly once (not doubled).
  assert.equal(text.split('Hermes could not resume session').length, 2);
});

test('F3: setup error (unwritable cwd) fails with a plain message and resets busy', async () => {
  clearControl();
  setControl('normal');
  const unwritableCwd = join(TMP, 'unwritable-cwd');
  writeFileSync(unwritableCwd, 'not a directory', 'utf8'); // cwd is a file, not a dir
  const { adapter, frames } = makeAdapter({ cwd: unwritableCwd });
  adapter.start();
  await adapter.deliver('m-1', 'x');
  const failed = lastFrameOfType(frames, 'failed');
  assert.equal(failed.messageId, 'm-1');
  assert.ok(String(failed.error).length > 0, 'plain error message');
  assert.ok(!String(failed.error).includes('resume'), 'setup error must not mention resume');
  // Busy was reset — a second deliver is not rejected as "busy".
  frames.length = 0;
  setControl('normal', { text: 'reply' });
  await adapter.deliver('m-2', 'x'); // this one will try to spawn the fake in TMP cwd? No — cwd is still unwritable.
  // Actually the second deliver will also fail with a setup error, not "busy".
  const failed2 = lastFrameOfType(frames, 'failed');
  assert.equal(failed2?.messageId, 'm-2');
  assert.ok(!String(failed2?.error).includes('Hermes is busy'), 'adapter is not wedged');
});

test('F4: deliver before config fails with "waiting for engine config", no process starts', async () => {
  clearControl();
  setControl('normal', { text: 'reply' });
  const { adapter, frames } = makeAdapter({ configured: false }); // no config frame yet
  // Delete any stale argv file so we can detect whether a process started.
  try { unlinkSync(argvFile); } catch { /* ignore */ }
  await adapter.deliver('m-1', 'x');
  const failed = lastFrameOfType(frames, 'failed');
  assert.equal(failed.messageId, 'm-1');
  assert.equal(String(failed.error), 'waiting for engine config');
  assert.equal(frames.filter((f) => (f as { type?: string }).type === 'thinking').length, 0, 'no thinking status');
  // No process was spawned: the fake never wrote argv.
  assert.equal(existsSync(argvFile), false);
});

test('F4: after config {threadId: null}, a delivery starts a fresh session (no --resume)', async () => {
  clearControl();
  setControl('normal', { text: 'reply one' });
  const { adapter, frames } = makeAdapter({ configured: false });
  adapter.start();
  (adapter as { handleConfig: (t: string | null) => void }).handleConfig(null);
  await adapter.deliver('m-1', 'x');
  const argv = readArgv();
  assert.equal(argv.includes('--resume'), false, 'no --resume after config null');
  assert.equal(lastFrameOfType(frames, 'captured')?.body, 'reply one');
});

test('C1: missing executable fails with "Hermes could not be started"', async () => {
  clearControl();
  setControl('normal');
  const { adapter, frames } = makeAdapter({ executable: 'C:\\nonexistent\\hermes-missing.exe' });
  adapter.start();
  await adapter.deliver('m-1', 'x');
  const failed = lastFrameOfType(frames, 'failed');
  assert.equal(failed.messageId, 'm-1');
  assert.equal(String(failed.error), 'Hermes could not be started');
});

test('C2: oversized stdout (> 8 MB) fails with "Hermes output too large"', async () => {
  clearControl();
  setControl('huge-output');
  // Long budget so the timeout doesn't fire before the oversized output is seen.
  const { adapter, frames } = makeAdapter({ maxRunSec: 30, timeoutExtraSec: 1 });
  adapter.start();
  await adapter.deliver('m-1', 'x');
  const failed = lastFrameOfType(frames, 'failed');
  assert.equal(failed.messageId, 'm-1');
  assert.equal(String(failed.error), 'Hermes output too large');
});

// N0 integration: real engine + real HermesAdapter + fake-hermes, hello and
// delivery flow end to end. This test must fail on the pre-fix code because
// main() waited for a server auth reply that never comes.
test('N0 integration: real engine delivers to hermes via connectToEngine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-n0-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');

  // Write a token file the engine will use (it's already created by startEngine,
  // but we write our own so we know the value).
  const token = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  writeFileSync(tokenPath, token, 'utf8');

  const engine = await startEngine({ port: 0, dbPath, tokenPath });
  const url = `ws://127.0.0.1:${engine.port}`;

  try {
    // Fake hermes: normal mode, a known session id, and a short reply.
    clearControl();
    setControl('normal', { sessionId: 'sess-n0-1', text: 'OK' });

    // Real HermesAdapter with the fake executable.
    const adapter = new HermesAdapter({
      executable: FAKE,
      sendFrame: () => { /* bound by connectToEngine */ },
      maxRunSec: 1,
      timeoutExtraSec: 1,
      cwd: TMP,
    });

    // connectToEngine binds the adapter's sendFrame to the socket and sends
    // auth + hello immediately on open (no waiting for a server auth reply).
    connectToEngine(url, token, adapter);

    // --- GUI client -------------------------------------------------------
    const gui = new WebSocket(url);
    const guiFrames: unknown[] = [];
    let guiFrameResolve: ((v: unknown) => void) | null = null;
    let guiAuthenticated = false;

    const guiNextFrame = (timeoutMs = 10000): Promise<unknown> =>
      new Promise((resolve, reject) => {
        if (guiFrames.length > 0) { resolve(guiFrames.shift()); return; }
        guiFrameResolve = resolve;
        setTimeout(() => reject(new Error('gui frame timeout')), timeoutMs);
      });

    gui.onopen = () => {
      gui.send(JSON.stringify({ type: 'auth', token }));
      setTimeout(() => { guiAuthenticated = true; }, 300);
    };
    gui.onmessage = (event) => {
      try { guiFrames.push(JSON.parse(String(event.data))); } catch {}
      if (guiFrameResolve) { const r = guiFrameResolve; guiFrameResolve = null; r(guiFrames[guiFrames.length - 1]); }
    };

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(guiAuthenticated, 'GUI authenticated');

    // gui_hello to get the snapshot (includes adapter statuses).
    gui.send(JSON.stringify({ type: 'gui_hello' }));
    const snapshot = (await guiNextFrame()) as { type: string; statuses: Record<string, string> };
    assert.equal(snapshot.type, 'snapshot');
    assert.equal(snapshot.statuses.hermes, 'idle', 'hermes status is idle after hello');

    // Send a message to hermes.
    gui.send(JSON.stringify({ type: 'send', body: 'Remember the code word PLUM-18.', targets: ['hermes'] }));

    // delivery_update (delivering) — proves config was received and the deliver went out.
    let delivering: unknown = null;
    for (let i = 0; i < 10; i++) {
      const f = await guiNextFrame(3000);
      const ft = f as { type?: string; target?: string; status?: string };
      if (ft.type === 'delivery_update' && ft.target === 'hermes' && ft.status === 'delivering') {
        delivering = f;
        break;
      }
    }
    assert.ok(delivering, 'delivery to hermes reached delivering (config was received)');

    // transcript_update with a hermes capture — the adapter stored the reply.
    let captured: unknown = null;
    for (let i = 0; i < 10; i++) {
      const f = await guiNextFrame(3000);
      const ft = f as { type?: string; message?: { source?: string; body?: string; sourceRef?: string } };
      if (ft.type === 'transcript_update' && ft.message?.source === 'hermes') {
        captured = f;
        break;
      }
    }
    assert.ok(captured, 'hermes capture stored in transcript');
    const capMsg = (captured as { message: { source: string; body: string; sourceRef?: string } }).message;
    assert.equal(capMsg.source, 'hermes');
    assert.ok(capMsg.sourceRef, 'capture carries a sourceRef');

    // delivery_update (delivered) — the adapter acknowledged delivery.
    let delivered: unknown = null;
    for (let i = 0; i < 10; i++) {
      const f = await guiNextFrame(3000);
      const ft = f as { type?: string; target?: string; status?: string };
      if (ft.type === 'delivery_update' && ft.target === 'hermes' && ft.status === 'delivered') {
        delivered = f;
        break;
      }
    }
    assert.ok(delivered, 'delivery to hermes ended delivered');

    // hermes_session_id is stored in settings.
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'hermes_session_id'").get() as { value: string } | undefined;
    db.close();
    assert.ok(row?.value, 'hermes_session_id stored in settings');
    assert.equal(row.value, 'sess-n0-1', 'hermes_session_id matches the fake hermes session id');

    gui.close();
    adapter.close();
  } finally {
    engine.stop();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// R1: adapter reconnects after engine restart (regression fix for N0 refactor)
// R1: adapter reconnects after engine restart (regression fix for N0 refactor)
test('R1: real engine + adapter: reconnects after engine restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-r1-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');

  // Start first engine — creates the token file
  const engine1 = await startEngine({ port: 0, dbPath, tokenPath });
  const port = engine1.port;
  const url = `ws://127.0.0.1:${port}`;
  const token = readFileSync(tokenPath, 'utf8').trim();

  try {
    clearControl();
    setControl('normal', { sessionId: 'sess-r1-1', text: 'OK' });

    const adapter = new HermesAdapter({
      executable: FAKE,
      sendFrame: () => {},
      maxRunSec: 1,
      timeoutExtraSec: 1,
      cwd: TMP,
    });

    // First connection
    const ws1 = connectToEngine(url, token, adapter);

    // Connect GUI
    const gui = new WebSocket(url);
    const guiFrames: unknown[] = [];
    let guiFrameResolve: ((v: unknown) => void) | null = null;
    let guiAuthenticated = false;

    const guiNextFrame = (timeoutMs = 10000): Promise<unknown> =>
      new Promise((resolve, reject) => {
        if (guiFrames.length > 0) { resolve(guiFrames.shift()); return; }
        guiFrameResolve = resolve;
        setTimeout(() => reject(new Error('gui frame timeout')), timeoutMs);
      });

    gui.onopen = () => {
      gui.send(JSON.stringify({ type: 'auth', token }));
      setTimeout(() => { guiAuthenticated = true; }, 300);
    };
    gui.onmessage = (event) => {
      try { guiFrames.push(JSON.parse(String(event.data))); } catch {}
      if (guiFrameResolve) { const r = guiFrameResolve; guiFrameResolve = null; r(guiFrames[guiFrames.length - 1]); }
    };

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(guiAuthenticated, 'GUI authenticated');

    // Verify hermes is idle before restart
    gui.send(JSON.stringify({ type: 'gui_hello' }));
    const snapshot = (await guiNextFrame()) as { type: string; statuses: Record<string, string> };
    assert.equal(snapshot.type, 'snapshot');
    assert.equal(snapshot.statuses.hermes, 'idle', 'hermes idle before engine restart');

    // Stop the engine
    engine1.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Close the old GUI connection
    gui.close();

    // Start a new engine on the same port with the same database
    const engine2 = await startEngine({ port, dbPath, tokenPath });

    try {
      // Reconnect the adapter
      const ws2 = connectToEngine(url, token, adapter);

      // Reconnect GUI
      const gui2 = new WebSocket(url);
      const gui2Frames: unknown[] = [];
      let gui2FrameResolve: ((v: unknown) => void) | null = null;
      let gui2Authenticated = false;

      const gui2NextFrame = (timeoutMs = 10000): Promise<unknown> =>
        new Promise((resolve, reject) => {
          if (gui2Frames.length > 0) { resolve(gui2Frames.shift()); return; }
          gui2FrameResolve = resolve;
          setTimeout(() => reject(new Error('gui frame timeout')), timeoutMs);
        });

      gui2.onopen = () => {
        gui2.send(JSON.stringify({ type: 'auth', token }));
        setTimeout(() => { gui2Authenticated = true; }, 300);
      };
      gui2.onmessage = (event) => {
        try { gui2Frames.push(JSON.parse(String(event.data))); } catch {}
        if (gui2FrameResolve) { const r = gui2FrameResolve; gui2FrameResolve = null; r(gui2Frames[gui2Frames.length - 1]); }
      };

      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.ok(gui2Authenticated, 'GUI2 authenticated');

      // Wait for adapter to reconnect (hermes becomes idle again within 5s)
      let reconnected = false;
      for (let i = 0; i < 25; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        gui2.send(JSON.stringify({ type: 'gui_hello' }));
        try {
          const snap = await gui2NextFrame(2000) as { type: string; statuses: Record<string, string> };
          if (snap.statuses.hermes === 'idle') {
            reconnected = true;
            break;
          }
        } catch { /* keep trying */ }
      }
      assert.ok(reconnected, 'adapter reconnected within 5s after engine restart');

      // Send a message after restart — should be delivered
      gui2.send(JSON.stringify({ type: 'send', body: 'after restart', targets: ['hermes'] }));

      let captured = false;
      for (let i = 0; i < 10; i++) {
        const f = await gui2NextFrame(3000);
        const ft = f as { type?: string; message?: { source?: string; body?: string } };
        if (ft.type === 'transcript_update' && ft.message?.source === 'hermes') {
          captured = true;
          break;
        }
      }
      assert.ok(captured, 'hermes capture after restart');

      ws2.close();
      adapter.close();
      gui2.close();
    } finally {
      engine2.stop();
    }

    gui.close();
  } finally {
    try { engine1.stop(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// R1: adapter starts with no engine and no token file, connects when engine appears
// R1: adapter starts with no engine and no token file, connects when engine appears
test('R1: adapter starts without engine or token, connects when engine appears', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-r1b-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  const port = 19998;
  const url = `ws://127.0.0.1:${port}`;

  // Start engine briefly to create token file, then stop it
  const engine0 = await startEngine({ port, dbPath, tokenPath });
  engine0.stop();
  try { rmSync(tokenPath); } catch {} // no token file when adapter starts

  try {
    clearControl();
    setControl('normal', { sessionId: 'sess-r1b-1', text: 'OK' });

    const abortController = new AbortController();
    const runPromise = runForever(
      { engineUrl: url, tokenPath, executable: FAKE },
      abortController.signal
    );

    // Adapter retries because no token and no engine — should stay alive
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.ok(!abortController.signal.aborted, 'adapter retry loop is still running');

    // Start the engine on the same port — adapter should connect on next retry
    const engine = await startEngine({ port, dbPath, tokenPath });
    const token = readFileSync(tokenPath, 'utf8').trim();

    try {
      // Give the adapter time to detect the engine and connect
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Verify by connecting a GUI — hermes should show as connected/idle
      const gui = new WebSocket(url);
      let guiAuthenticated = false;
      gui.onopen = () => {
        gui.send(JSON.stringify({ type: 'auth', token }));
        setTimeout(() => { guiAuthenticated = true; }, 300);
      };
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.ok(guiAuthenticated, 'GUI can connect to engine');

      gui.send(JSON.stringify({ type: 'gui_hello' }));
      const frames: unknown[] = [];
      let frameResolve: ((v: unknown) => void) | null = null;
      const nextFrame = (timeoutMs = 5000): Promise<unknown> =>
        new Promise((resolve, reject) => {
          if (frames.length > 0) { resolve(frames.shift()); return; }
          frameResolve = resolve;
          setTimeout(() => reject(new Error('frame timeout')), timeoutMs);
        });
      gui.onmessage = (event) => {
        try { frames.push(JSON.parse(String(event.data))); } catch {}
        if (frameResolve) { const r = frameResolve; frameResolve = null; r(frames[frames.length - 1]); }
      };
      const snap = (await nextFrame()) as { type: string; statuses: Record<string, string> };
      assert.equal(snap.type, 'snapshot');
      assert.equal(snap.statuses.hermes, 'idle', 'hermes is idle after adapter connected');
      gui.close();
    } finally {
      engine.stop();
    }

    abortController.abort();
    await runPromise;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
// R1: run killed when socket closes (already covered by
// the "interrupt" test; kept here for completeness per the packet).
test('R1: run killed when socket closes', async () => {
  clearControl();
  setControl('hang');
  const { adapter, frames } = makeAdapter();
  adapter.start();
  // Start a delivery (spawns a hermes process that will hang)
  void adapter.deliver('m-1', 'x');
  // Simulate socket close → adapter kills the tree
  adapter.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const failed = lastFrameOfType(frames, 'failed');
  assert.ok(failed, 'failed frame sent');
  const error = String(failed.error);
  assert.ok(error === 'Stopped' || error === 'Hermes exited with code 1', `expected 'Stopped' or 'Hermes exited with code 1', got '${error}'`);
});

// --- M6.4a: fail-closed perm + kill ---

test('M6.4a: deliver with perm=work fails closed with the exact message and starts no process', async () => {
  clearControl();
  setControl('normal', { text: 'should never run' });
  const { adapter, frames } = makeAdapter();
  const marker = join(TMP, 'argv-perm-work.json');
  try { unlinkSync(marker); } catch { /* absent is what we want */ }
  const prev = process.env.FAKE_HERMES_ARGV_FILE;
  process.env.FAKE_HERMES_ARGV_FILE = marker;
  try {
    await adapter.deliver('m-work', 'do privileged things', 'work');
    const failed = lastFrameOfType(frames, 'failed');
    assert.equal(failed?.messageId, 'm-work');
    assert.equal(failed?.error, 'work and full modes are not available yet');
    assert.ok(!frames.some((f) => (f as { type?: string; status?: string }).type === 'status' && (f as { status?: string }).status === 'thinking'),
      'no run started (no thinking status)');
    assert.equal(existsSync(marker), false, 'the fake executable was never spawned');
  } finally {
    if (prev === undefined) delete process.env.FAKE_HERMES_ARGV_FILE; else process.env.FAKE_HERMES_ARGV_FILE = prev;
  }
});

test('M6.4a: deliver with perm=full fails closed; conversation/undefined run normally', async () => {
  clearControl();
  setControl('normal', { text: 'normal reply' });
  const { adapter, frames } = makeAdapter();
  await adapter.deliver('m-full', 'privileged', 'full');
  assert.equal(lastFrameOfType(frames, 'failed')?.messageId, 'm-full');
  assert.equal(lastFrameOfType(frames, 'failed')?.error, 'work and full modes are not available yet');
  await adapter.deliver('m-conv', 'hello', 'conversation');
  for (let i = 0; i < 25 && lastFrameOfType(frames, 'delivered')?.messageId !== 'm-conv'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(lastFrameOfType(frames, 'delivered')?.messageId, 'm-conv', 'conversation perm runs normally');
  await adapter.deliver('m-undef', 'hello again');
  for (let i = 0; i < 25 && lastFrameOfType(frames, 'delivered')?.messageId !== 'm-undef'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(lastFrameOfType(frames, 'delivered')?.messageId, 'm-undef', 'undefined perm runs normally');
});

test('M6.4a: kill ends a hanging run, kills the grandchild tree, and reports Stopped', async () => {
  clearControl();
  setControl('grandchild-hang');
  const { adapter, frames } = makeAdapter();
  try { unlinkSync(pidFile); } catch { /* fresh */ }
  const p1 = adapter.deliver('m-kill', 'hanging run');
  let pid = '';
  for (let i = 0; i < 25; i++) {
    if (existsSync(pidFile)) { pid = readFileSync(pidFile, 'utf8').trim(); if (pid !== '') break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(pid !== '', 'grandchild started (pid file written)');
  adapter.handleKill();
  await p1;
  assert.equal(lastFrameOfType(frames, 'failed')?.messageId, 'm-kill');
  assert.equal(String(lastFrameOfType(frames, 'failed')?.error), 'Stopped');
  let gone = false;
  for (let i = 0; i < 15; i++) { if (!pidIsAlive(pid)) { gone = true; break; } await new Promise((r) => setTimeout(r, 200)); }
  assert.equal(gone, true, 'grandchild process is gone after kill (whole tree killed)');
});

// Cleanup the temp dir once all tests in this file are done.
test('teardown: remove the temp directory', () => {
  clearControl();
  delete process.env.FAKE_HERMES_ARGV_FILE;
  delete process.env.FAKE_HERMES_ENV_FILE;
  delete process.env.FAKE_HERMES_GRANDCHILD_PID_FILE;
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5 });
});
