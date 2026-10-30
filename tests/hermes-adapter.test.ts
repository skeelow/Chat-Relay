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
import { execSync, spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';
import {
  HermesAdapter,
  buildArgv,
  connectToEngine,
  MODE_A_TOOLSETS,
  WORK_TOOLSETS,
  WORK_MAX_TURNS,
  WORK_MAX_RUN_SEC,
  DEFAULT_MAX_TURNS,
  DEFAULT_MAX_RUN_SEC,
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

// --- M6.4b: argv per permission mode (conversation | work | full) ---

test('M6.4b: WORK_TOOLSETS is the fixed code constant', () => {
  assert.equal(WORK_TOOLSETS, 'terminal,file,code_execution,web,todo,memory,session_search');
});

test('M6.4b buildArgv: conversation perm (and default) is the M6.1 argv exactly', () => {
  const base = { executable: FAKE, profile: 'claude', queryFile: 'q.txt', maxTurns: 6, maxRunSec: 300 };
  assert.deepEqual(buildArgv(base), [
    FAKE, '-p', 'claude', 'chat', '--query-file', 'q.txt', '--format', 'stream-json',
    '-t', MODE_A_TOOLSETS, '--max-turns', '6',
  ]);
  assert.deepEqual(buildArgv({ ...base, perm: 'conversation' }), buildArgv(base));
});

test('M6.4b buildArgv: work perm uses -t WORK_TOOLSETS and never --yolo', () => {
  const argv = buildArgv({
    executable: FAKE, profile: 'claude', queryFile: 'q.txt',
    maxTurns: WORK_MAX_TURNS, maxRunSec: WORK_MAX_RUN_SEC, perm: 'work',
  });
  assert.deepEqual(argv, [
    FAKE, '-p', 'claude', 'chat', '--query-file', 'q.txt', '--format', 'stream-json',
    '-t', WORK_TOOLSETS, '--max-turns', '60',
  ]);
});

test('M6.4b buildArgv: full perm has --yolo exactly once, no -t, and resumes', () => {
  const argv = buildArgv({
    executable: FAKE, profile: 'claude', queryFile: 'q.txt',
    maxTurns: WORK_MAX_TURNS, maxRunSec: WORK_MAX_RUN_SEC, resume: 'sess-1', perm: 'full',
  });
  assert.deepEqual(argv, [
    FAKE, '-p', 'claude', 'chat', '--query-file', 'q.txt', '--format', 'stream-json',
    '--yolo', '--max-turns', '60', '--resume', 'sess-1',
  ]);
  assert.equal(argv.filter((v) => v === '--yolo').length, 1, '--yolo exactly once');
  assert.equal(argv.includes('-t'), false, 'full has no -t (profile toolsets)');
});

test('M6.4b buildArgv: --yolo count 0/0/1, -t present/present/absent, forbidden flags never appear', () => {
  for (const perm of ['conversation', 'work', 'full'] as const) {
    const argv = buildArgv({
      executable: FAKE, profile: 'claude', queryFile: 'q.txt',
      maxTurns: 6, maxRunSec: 300, resume: 'sess-1', perm,
    });
    assert.equal(argv.filter((v) => v === '--yolo').length, perm === 'full' ? 1 : 0, `--yolo count for ${perm}`);
    assert.equal(argv.includes('-t'), perm !== 'full', `-t present only for conversation and work (${perm})`);
    for (const banned of ['--source', '--ignore-user-config', '--safe-mode', '--accept-hooks', '-q', '--query', '--run-budget']) {
      assert.ok(!argv.includes(banned), `${banned} must never appear in ${perm} argv`);
    }
    assert.ok(!argv.includes(WORK_TOOLSETS) || perm === 'work', 'work toolsets only in work argv');
    // --resume unchanged: the same relay session continues across perms.
    assert.equal(argv.indexOf('--resume'), argv.length - 2);
    assert.equal(argv[argv.length - 1], 'sess-1');
  }
});

// --- M6.4b2: fake-hermes enforces the real resume-policy rule ---
// Verified against the real Hermes CLI: a resume may repeat the session's
// launch -t and --max-turns (or omit both) but re-passing different values
// exits 2. --yolo is NOT session policy and may be added or omitted.

const RESUME_POLICY_ERROR =
  'Error: Resume retains gateway session policy; creation overrides are unsupported on resume. ' +
  "-t/--toolsets, --max-turns differ from this session's launch: resume without them, or start a new session to use them.";

interface FakeRun { code: number; stdout: string; stderr: string }

// Run tests/fake-hermes.ts directly (not through the adapter) with an
// isolated control+state directory. The per-file FAKE_HERMES_* env vars are
// stripped so a direct run cannot clobber the adapter tests' shared files.
function runFake(dir: string, control: Record<string, unknown>, extraArgs: string[]): FakeRun {
  const controlFile = join(dir, 'control.json');
  writeFileSync(controlFile, JSON.stringify(control), 'utf8');
  const env = { ...process.env };
  delete env.FAKE_HERMES_ARGV_FILE;
  delete env.FAKE_HERMES_ENV_FILE;
  delete env.FAKE_HERMES_GRANDCHILD_PID_FILE;
  env.FAKE_HERMES_CONTROL = controlFile;
  const base = ['-p', 'claude', 'chat', '--query-file', join(dir, 'q.txt'), '--format', 'stream-json'];
  const res = spawnSync(process.execPath, [FAKE, ...base, ...extraArgs], { encoding: 'utf8', env, cwd: dir });
  return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function fakeResultEvent(run: FakeRun): any {
  const lines = run.stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
  const last = lines[lines.length - 1];
  return JSON.parse(last) as any;
}

test('M6.4b2 fake-hermes: resume with the same -t and --max-turns as the launch works', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-fake-resume-'));
  try {
    const launch = runFake(dir, { mode: 'normal', sessionId: 'sess-r-1' },
      ['-t', 'memory,session_search', '--max-turns', '6']);
    assert.equal(launch.code, 0, 'fresh launch works');
    const resume = runFake(dir, { mode: 'normal', sessionId: 'sess-r-1' },
      ['-t', 'memory,session_search', '--max-turns', '6', '--resume', 'sess-r-1']);
    assert.equal(resume.code, 0, 'resume with identical overrides works');
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('M6.4b2 fake-hermes: resume with a different -t exits 2 with the policy error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-fake-resume-'));
  try {
    runFake(dir, { mode: 'normal', sessionId: 'sess-r-2' }, ['-t', 'memory,session_search', '--max-turns', '6']);
    const bad = runFake(dir, { mode: 'normal', sessionId: 'sess-r-2' },
      ['-t', WORK_TOOLSETS, '--max-turns', '6', '--resume', 'sess-r-2']);
    assert.equal(bad.code, 2, 'different -t on resume exits 2');
    assert.ok(bad.stderr.includes(RESUME_POLICY_ERROR), `stderr carries the error line, got: ${bad.stderr}`);
    const ev = fakeResultEvent(bad);
    assert.equal(ev.type, 'result');
    assert.equal(ev.exit_code, 2);
    assert.equal(ev.error, RESUME_POLICY_ERROR, 'result event carries the same error text');
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('M6.4b2 fake-hermes: resume with a different --max-turns exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-fake-resume-'));
  try {
    runFake(dir, { mode: 'normal', sessionId: 'sess-r-3' }, ['-t', 'memory,session_search', '--max-turns', '6']);
    const bad = runFake(dir, { mode: 'normal', sessionId: 'sess-r-3' },
      ['-t', 'memory,session_search', '--max-turns', '60', '--resume', 'sess-r-3']);
    assert.equal(bad.code, 2, 'different --max-turns on resume exits 2');
    assert.ok(bad.stderr.includes(RESUME_POLICY_ERROR));
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('M6.4b2 fake-hermes: resume without -t or --max-turns keeps the session policy and works', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-fake-resume-'));
  try {
    runFake(dir, { mode: 'normal', sessionId: 'sess-r-4' }, ['-t', 'memory,session_search', '--max-turns', '6']);
    const bare = runFake(dir, { mode: 'normal', sessionId: 'sess-r-4' }, ['--resume', 'sess-r-4']);
    assert.equal(bare.code, 0, 'resume with neither override works');
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('M6.4b2 fake-hermes: --yolo is not session policy — add or omit it on a resume freely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-fake-resume-'));
  try {
    runFake(dir, { mode: 'normal', sessionId: 'sess-r-5' },
      ['-t', 'memory,session_search', '--max-turns', '6']);
    const withYolo = runFake(dir, { mode: 'normal', sessionId: 'sess-r-5' },
      ['-t', 'memory,session_search', '--max-turns', '6', '--yolo', '--resume', 'sess-r-5']);
    assert.equal(withYolo.code, 0, 'adding --yolo on a resume works');
    const noYolo = runFake(dir, { mode: 'normal', sessionId: 'sess-r-5' },
      ['--yolo', '--resume', 'sess-r-5']);
    assert.equal(noYolo.code, 0, 'resume with only --yolo (overrides omitted) works');
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('M6.4b2 fake-hermes: a fresh run (no --resume) with any -t/--max-turns/--yolo works', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-fake-resume-'));
  try {
    const a = runFake(dir, { mode: 'normal', sessionId: 'sess-r-6a' }, ['-t', WORK_TOOLSETS, '--max-turns', '60']);
    assert.equal(a.code, 0);
    const b = runFake(dir, { mode: 'normal', sessionId: 'sess-r-6b' }, ['--yolo', '--max-turns', '60']);
    assert.equal(b.code, 0);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
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

test('static guard: --source/--run-budget/shell:true absent; --yolo only inside the full branch', () => {
  const src = readFileSync(join(process.cwd(), 'adapters', 'hermes', 'adapter.ts'), 'utf8');
  const stripped = stripComments(src);
  for (const banned of ['--source', '--run-budget', 'shell: true']) {
    assert.ok(!stripped.includes(banned), `${banned} must not appear in the adapter source outside comments`);
  }
  // '--yolo' may appear in adapter source ONLY inside buildArgv's full branch:
  // exactly once in the whole stripped source, and inside the `if (perm === 'full') { … }` block.
  const yoloCount = stripped.split("--yolo").length - 1;
  assert.equal(yoloCount, 1, 'the literal --yolo appears exactly once in the adapter source');
  const branch = stripped.indexOf("perm === 'full'");
  assert.ok(branch !== -1, 'the full branch exists in buildArgv');
  const open = stripped.indexOf('{', branch);
  assert.ok(open !== -1);
  let depth = 0;
  let close = -1;
  for (let i = open; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') { depth--; if (depth === 0) { close = i; break; } }
  }
  assert.ok(close !== -1, 'the full branch block closes');
  const yoloIdx = stripped.indexOf("--yolo");
  assert.ok(yoloIdx > branch && yoloIdx < close,
    'the only --yolo sits inside the full branch (no conversation/work path can reach it)');
  // and it never appears in the conversation/work argv (runtime guard, mirrors the argv tests)
  for (const perm of ['conversation', 'work'] as const) {
    const argv = buildArgv({
      executable: 'x', profile: 'claude', queryFile: 'q.txt', maxTurns: 6, maxRunSec: 300, perm,
    });
    assert.ok(!argv.includes('--yolo'), `--yolo must never appear in ${perm} argv`);
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

// M6.4b2 integration: real engine + real adapter + the resume-policy enforcing
// fake, across all three perms with an engine restart in the middle. Each
// perm must resume only its own session, and the three ids must survive the
// restart and be resent in the config frame.
test('M6.4b2 integration: conv→work→full→conv→work per-mode sessions, engine restart, ids resent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-m64b2-chain-'));
  const dbPath = join(dir, 'relay.db');
  const tokenPath = join(dir, 'token');
  const token = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
  writeFileSync(tokenPath, token, 'utf8');

  const adapter = new HermesAdapter({
    executable: FAKE,
    sendFrame: () => { /* bound by connectToEngine */ },
    maxRunSec: 1,
    timeoutExtraSec: 1,
    cwd: TMP,
  });

  function settingOf(key: string): string | null {
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value ?? null;
    } finally { db.close(); }
  }

  function makeGui(url: string) {
    const ws = new WebSocket(url);
    const frames: unknown[] = [];
    let resolve: ((v: unknown) => void) | null = null;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
    ws.onmessage = (event) => {
      try { frames.push(JSON.parse(String(event.data))); } catch { /* ignore */ }
      if (resolve) { const r = resolve; resolve = null; r(frames[frames.length - 1]); }
    };
    const send = (o: unknown): void => ws.send(JSON.stringify(o));
    const next = (timeoutMs = 15000): Promise<unknown> =>
      new Promise((res, rej) => {
        if (frames.length > 0) { res(frames.shift()); return; }
        resolve = res;
        setTimeout(() => rej(new Error('gui frame timeout')), timeoutMs);
      });
    return { ws, send, next, opened: new Promise<void>((r) => { ws.on('open', r); }) };
  }

  async function waitIdle(gui: ReturnType<typeof makeGui>): Promise<void> {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      gui.send({ type: 'gui_hello' });
      try {
        const snap = await gui.next(2000) as { statuses?: Record<string, string> };
        if (snap.statuses?.hermes === 'idle') return;
      } catch { /* keep polling */ }
    }
    throw new Error('hermes never went idle');
  }

  // One GUI send; returns the argv the fake received. Throws on a failed row.
  async function guiSend(gui: ReturnType<typeof makeGui>, body: string, perm?: string): Promise<string[]> {
    try { unlinkSync(argvFile); } catch { /* fresh */ }
    const frame: Record<string, unknown> = { type: 'send', body, targets: ['hermes'] };
    if (perm !== undefined) frame.perm = perm;
    gui.send(frame);
    let mid = '';
    for (;;) {
      const ft = await gui.next() as any;
      if (ft.type === 'transcript_update' && ft.message?.source === 'user' && ft.message?.body === body) { mid = String(ft.message.id); break; }
    }
    for (;;) {
      const ft = await gui.next() as any;
      if (ft.type === 'delivery_update' && ft.messageId === mid && ft.target === 'hermes') {
        if (ft.status === 'delivered') break;
        if (ft.status === 'failed') throw new Error(`delivery failed: ${ft.error}`);
      }
    }
    return JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
  }

  const engine1 = await startEngine({ port: 0, dbPath, tokenPath });
  const port = engine1.port;
  const url = `ws://127.0.0.1:${port}`;
  let engine2: EngineHandle | null = null;
  connectToEngine(url, token, adapter);
  const gui1 = makeGui(url);
  await gui1.opened;
  await new Promise((r) => setTimeout(r, 400));

  try {
    await waitIdle(gui1);

    // 1. first conversation send: fresh session.
    clearControl();
    setControl('normal', { sessionId: 'sess-pm-c1', text: 'c one' });
    const a1 = await guiSend(gui1, 'chain conv 1');
    assert.equal(a1.includes('--resume'), false, 'first conversation run is fresh');
    assert.equal(settingOf('hermes_session_id'), 'sess-pm-c1', 'conversation id stored under the old key');
    assert.equal(settingOf('hermes_session_id_work'), null, 'work key still unset');
    assert.equal(settingOf('hermes_session_id_full'), null, 'full key still unset');

    // 2. first work send: its own fresh session, no exit 2.
    setControl('normal', { sessionId: 'sess-pm-w1', text: 'w one' });
    const a2 = await guiSend(gui1, 'chain work 1', 'work');
    assert.equal(a2.includes('--resume'), false, 'first work run does not resume the conversation session');
    assert.equal(a2[a2.indexOf('-t') + 1], WORK_TOOLSETS);
    assert.equal(settingOf('hermes_session_id_work'), 'sess-pm-w1', 'work id stored under hermes_session_id_work');

    // 3. first full send: its own fresh session.
    setControl('normal', { sessionId: 'sess-pm-f1', text: 'f one' });
    const a3 = await guiSend(gui1, 'chain full 1', 'full');
    assert.equal(a3.includes('--resume'), false, 'first full run does not resume a foreign session');
    assert.equal(a3.filter((v) => v === '--yolo').length, 1);
    assert.equal(a3.includes('-t'), false);
    assert.equal(settingOf('hermes_session_id_full'), 'sess-pm-f1', 'full id stored under hermes_session_id_full');

    // 4. back to conversation: resumes the CONVERSATION session with its own
    //    launch overrides — the run the old code failed with exit 2.
    setControl('normal', { sessionId: 'sess-pm-c1', text: 'c two' });
    const a4 = await guiSend(gui1, 'chain conv 2');
    assert.equal(a4[a4.indexOf('--resume') + 1], 'sess-pm-c1', 'second conversation run resumes its own id');
    assert.equal(a4[a4.indexOf('-t') + 1], MODE_A_TOOLSETS, 'resumed with the conversation toolsets');

    // 5. work again: resumes the WORK session.
    setControl('normal', { sessionId: 'sess-pm-w1', text: 'w two' });
    const a5 = await guiSend(gui1, 'chain work 2', 'work');
    assert.equal(a5[a5.indexOf('--resume') + 1], 'sess-pm-w1', 'second work run resumes its own id');

    // 6. engine restart mid-run: the three ids survive and are resent.
    engine1.stop();
    gui1.ws.close();
    await new Promise((r) => setTimeout(r, 500));
    engine2 = await startEngine({ port, dbPath, tokenPath });
    connectToEngine(url, token, adapter);
    const gui2 = makeGui(url);
    await gui2.opened;
    await new Promise((r) => setTimeout(r, 400));
    await waitIdle(gui2);

    assert.equal(settingOf('hermes_session_id'), 'sess-pm-c1');
    assert.equal(settingOf('hermes_session_id_work'), 'sess-pm-w1');
    assert.equal(settingOf('hermes_session_id_full'), 'sess-pm-f1');

    setControl('normal', { sessionId: 'sess-pm-c1', text: 'c three' });
    const a6 = await guiSend(gui2, 'chain conv 3');
    assert.equal(a6[a6.indexOf('--resume') + 1], 'sess-pm-c1', 'after restart conversation resumes its own id');

    setControl('normal', { sessionId: 'sess-pm-f1', text: 'f two' });
    const a7 = await guiSend(gui2, 'chain full 2', 'full');
    assert.equal(a7[a7.indexOf('--resume') + 1], 'sess-pm-f1', 'after restart full resumes its own id');

    gui2.ws.close();
  } finally {
    adapter.close();
    try { gui1.ws.close(); } catch { /* already closed */ }
    try { engine1.stop(); } catch { /* already stopped */ }
    try { engine2?.stop(); } catch { /* never started or already stopped */ }
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* best effort */ }
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

// --- M6.4b / M6.4b2: work and full runs; one session per perm ---

test('M6.4b: deliver perm=work runs with the work argv, no --yolo, work limits', async () => {
  clearControl();
  setControl('normal', { sessionId: 'sess-perm-w1', text: 'work reply' });
  const { adapter, frames } = makeAdapter();
  await adapter.deliver('m-work', 'do work', 'work');
  assert.equal(lastFrameOfType(frames, 'delivered')?.messageId, 'm-work', 'work delivery completes');
  const argv = readArgv();
  assert.equal(argv[argv.indexOf('-t') + 1], WORK_TOOLSETS, '-t with the work toolsets');
  assert.equal(argv.filter((v) => v === '--yolo').length, 0, 'work argv has no --yolo');
  assert.equal(argv[argv.indexOf('--max-turns') + 1], '60', 'work uses maxTurns 60');
  assert.equal(argv.includes('--resume'), false, 'M6.4b2: the first work delivery starts a fresh work session');
});

test('M6.4b2: each perm has its own session — work and full start fresh, later runs resume only their own', async () => {
  clearControl();
  const { adapter, frames } = makeAdapter();
  setControl('normal', { sessionId: 'sess-perm-c', text: 'conv reply' });
  await adapter.deliver('m-c', 'hello');
  assert.equal(lastFrameOfType(frames, 'delivered')?.messageId, 'm-c', 'conversation run delivered');

  setControl('normal', { sessionId: 'sess-perm-w', text: 'work reply' });
  await adapter.deliver('m-w', 'go work', 'work');
  assert.equal(lastFrameOfType(frames, 'delivered')?.messageId, 'm-w', 'first work run delivered fresh');
  assert.equal(readArgv().includes('--resume'), false, 'first work run has no --resume');
  const workThread = frames.filter((f) => (f as { type?: string }).type === 'thread').pop() as any;
  assert.deepEqual(workThread, { type: 'thread', threadId: 'sess-perm-w', perm: 'work' },
    'the work thread frame carries perm=work');

  setControl('normal', { sessionId: 'sess-perm-f', text: 'full reply' });
  await adapter.deliver('m-f', 'go full', 'full');
  assert.equal(lastFrameOfType(frames, 'delivered')?.messageId, 'm-f', 'first full run delivered fresh');
  const fullArgv = readArgv();
  assert.equal(fullArgv.includes('--resume'), false, 'first full run has no --resume (own session, not work\'s)');
  assert.equal(fullArgv.filter((v) => v === '--yolo').length, 1, 'full argv has --yolo exactly once');
  assert.equal(fullArgv.includes('-t'), false, 'full argv has no -t (profile toolsets)');
  assert.equal(fullArgv[fullArgv.indexOf('--max-turns') + 1], '60', 'full uses maxTurns 60');
  const fullThread = frames.filter((f) => (f as { type?: string }).type === 'thread').pop() as any;
  assert.deepEqual(fullThread, { type: 'thread', threadId: 'sess-perm-f', perm: 'full' },
    'the full thread frame carries perm=full');

  setControl('normal', { sessionId: 'sess-perm-w', text: 'work reply 2' });
  await adapter.deliver('m-w2', 'work again', 'work');
  assert.equal(lastFrameOfType(frames, 'delivered')?.messageId, 'm-w2', 'second work run delivered');
  const workArgv2 = readArgv();
  assert.equal(workArgv2[workArgv2.indexOf('--resume') + 1], 'sess-perm-w',
    'the second work run resumes the WORK session, not the conversation or full one');
  assert.equal(workArgv2[workArgv2.indexOf('-t') + 1], WORK_TOOLSETS, 'resumed with the same work toolsets');

  setControl('normal', { sessionId: 'sess-perm-c', text: 'conv reply 2' });
  await adapter.deliver('m-c2', 'back to chat');
  assert.equal(lastFrameOfType(frames, 'delivered')?.messageId, 'm-c2', 'second conversation run delivered');
  const convArgv2 = readArgv();
  assert.equal(convArgv2[convArgv2.indexOf('--resume') + 1], 'sess-perm-c',
    'returning to conversation resumes the CONVERSATION session');
  assert.equal(frames.filter((f) => (f as { type?: string }).type === 'failed').length, 0,
    'no run failed — every perm resumed only its own session');
});

test('M6.4b2: the old config shape (threadId only) is accepted and leaves the work/full slots untouched', async () => {
  clearControl();
  const frames: unknown[] = [];
  const adapter = new HermesAdapter({
    executable: FAKE, sendFrame: (f) => frames.push(f),
    maxRunSec: 1, timeoutExtraSec: 1, cwd: TMP, startMs: 1_700_000_000_000,
  });
  adapter.start();
  adapter.handleConfig('sess-old-c'); // old shape: no threadIds argument at all
  setControl('normal', { sessionId: 'sess-old-c', text: 'old c' });
  await adapter.deliver('m-old', 'chat'); // resumes the conversation id
  const convArgv = readArgv();
  assert.equal(convArgv[convArgv.indexOf('--resume') + 1], 'sess-old-c', 'threadId still drives conversation');
  setControl('normal', { sessionId: 'sess-old-w', text: 'old w' });
  await adapter.deliver('m-old-w', 'work', 'work'); // work slot untouched → fresh run
  assert.equal(readArgv().includes('--resume'), false, 'old-shape config did not give work a session to resume');
});

test('M6.4b2: config threadIds seed the work/full slots; null clears them', async () => {
  clearControl();
  const { adapter } = makeAdapter();
  adapter.handleConfig(null, { work: 'sess-cls-w', full: 'sess-cls-f' });
  setControl('normal', { sessionId: 'sess-cls-w', text: 'w' });
  await adapter.deliver('m-w', 'work', 'work');
  assert.equal(readArgv()[readArgv().indexOf('--resume') + 1], 'sess-cls-w',
    'a work delivery resumes the id the engine seeded (survived restart scenario)');
  adapter.handleConfig(null, { work: null, full: null });
  setControl('normal', { sessionId: 'sess-cls-w', text: 'w2' });
  await adapter.deliver('m-w2', 'work 2', 'work');
  assert.equal(readArgv().includes('--resume'), false, 'after threadIds null the work session starts fresh');
});

test('M6.4b: deliver with an unknown perm fails closed and starts no process', async () => {
  clearControl();
  setControl('normal', { text: 'should never run' });
  const { adapter, frames } = makeAdapter();
  const marker = join(TMP, 'argv-perm-bogus.json');
  try { unlinkSync(marker); } catch { /* absent is what we want */ }
  const prev = process.env.FAKE_HERMES_ARGV_FILE;
  process.env.FAKE_HERMES_ARGV_FILE = marker;
  try {
    await adapter.deliver('m-bogus', 'evil', 'everything');
    const failed = lastFrameOfType(frames, 'failed');
    assert.equal(failed?.messageId, 'm-bogus');
    assert.equal(failed?.error, 'unknown permission mode');
    assert.ok(!frames.some((f) => (f as { type?: string; status?: string }).type === 'status' && (f as { status?: string }).status === 'thinking'),
      'no run started (no thinking status)');
    assert.equal(existsSync(marker), false, 'the fake executable was never spawned');
  } finally {
    if (prev === undefined) delete process.env.FAKE_HERMES_ARGV_FILE; else process.env.FAKE_HERMES_ARGV_FILE = prev;
  }
});

test('M6.4b: a deliver without perm is conversation (memory,session_search, no --yolo)', async () => {
  clearControl();
  setControl('normal', { text: 'plain reply' });
  const { adapter, frames } = makeAdapter();
  await adapter.deliver('m-plain', 'hello');
  assert.equal(lastFrameOfType(frames, 'delivered')?.messageId, 'm-plain');
  const argv = readArgv();
  assert.equal(argv[argv.indexOf('-t') + 1], MODE_A_TOOLSETS);
  assert.equal(argv.filter((v) => v === '--yolo').length, 0);
});

test('M6.4b: limits per perm — conversation 6/300 defaults, work and full 60/3600 defaults', () => {
  assert.equal(DEFAULT_MAX_TURNS, 6);
  assert.equal(DEFAULT_MAX_RUN_SEC, 300);
  assert.equal(WORK_MAX_TURNS, 60);
  assert.equal(WORK_MAX_RUN_SEC, 3600);
});

test('M6.4b: a hanging work run is wall-clock killed with the work maxRunSec', async () => {
  clearControl();
  setControl('grandchild-hang');
  const { adapter, frames } = makeAdapter({ workMaxRunSec: 1 }); // work kill fires after 1 s + 1 s extra
  const before = Date.now();
  await adapter.deliver('m-work-hang', 'hang forever', 'work');
  assert.ok(Date.now() - before >= 1900, 'the work wall-clock kill used the work maxRunSec, not the conversation one');
  assert.equal(String(lastFrameOfType(frames, 'failed')?.error), 'Hermes timed out');
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
