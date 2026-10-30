// Fake Hermes executable for the hermes-adapter tests.
//
// The adapter spawns the executable given to it (tests pass this script via
// node). Behaviour is driven by the FAKE_HERMES_CONTROL env var (path to a JSON
// control file) and FAKE_HERMES_ARGV_FILE (path to write process.argv to).
//
// Modes (control.mode):
//   normal        print a normal stream-json run, then exit 0
//   fail          exit 1 with no output
//   no-result     print text chunks, no result event, exit 0
//   diff-session  print a result with a different session_id, exit 0
//   hang          never exit (tests the timeout + tree kill)
//   grandchild-hang spawn a non-detached grandchild that loops forever, then
//                   hang itself (tests that the whole tree dies)
//   echo-argv     write process.argv to FAKE_HERMES_ARGV_FILE, then a normal
//                   run
//
// M6.4b2 resume-policy enforcement (like the real CLI): each session's launch
// -t/--max-turns are remembered in fake-hermes-sessions.json next to the
// control file (FAKE_HERMES_STATE_FILE to relocate). A --resume with
// different values prints the real error line to stderr, emits a result
// event with exit_code 2 and exits 2; same values or neither works;
// --yolo is not session policy.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const controlPath = process.env.FAKE_HERMES_CONTROL;
const argvFile = process.env.FAKE_HERMES_ARGV_FILE;
const grandchildPidFile = process.env.FAKE_HERMES_GRANDCHILD_PID_FILE;

let control: { mode?: string; sessionId?: string; exitCode?: number; text?: string; echoQuery?: boolean } = { mode: 'normal' };
if (controlPath && existsSync(controlPath)) {
  try { control = JSON.parse(readFileSync(controlPath, 'utf8')); } catch { /* keep default */ }
}

if (argvFile) {
  writeFileSync(argvFile, JSON.stringify(process.argv), 'utf8');
}

const mode = control.mode ?? 'normal';
const sessionId = control.sessionId ?? 'local-sess';
const exitCode = control.exitCode ?? 0;
const text = control.text ?? 'ok';
const envFile = process.env.FAKE_HERMES_ENV_FILE;

// --- M6.4b2: the real resume-policy rule -----------------------------------
// Verified against the real Hermes CLI: a session's `-t/--toolsets` and
// `--max-turns` are fixed when it starts. `--resume <id>` with the SAME
// values (or with neither) works; re-passing DIFFERENT values fails with
// exit 2 and this exact error line. `--yolo` is not session policy and may
// be added or omitted on a resume. Each session's launch overrides are kept
// in a state file next to the control file (FAKE_HERMES_STATE_FILE to
// relocate), so fakes behave like the real thing (AGENTS.md rule 4).
const RESUME_POLICY_ERROR =
  'Error: Resume retains gateway session policy; creation overrides are unsupported on resume. ' +
  "-t/--toolsets, --max-turns differ from this session's launch: resume without them, or start a new session to use them.";

const stateFile = process.env.FAKE_HERMES_STATE_FILE
  ?? (controlPath ? join(dirname(controlPath), 'fake-hermes-sessions.json') : undefined);

interface SessionPolicy { toolsets: string | null; maxTurns: string | null }

function loadSessions(): Record<string, SessionPolicy> {
  if (!stateFile || !existsSync(stateFile)) return {};
  try { return JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, SessionPolicy>; } catch { return {}; }
}

function saveSessions(sessions: Record<string, SessionPolicy>): void {
  if (!stateFile) return;
  try { writeFileSync(stateFile, JSON.stringify(sessions), 'utf8'); } catch { /* best effort */ }
}

// Parse --resume, -t/--toolsets and --max-turns from the received argv.
let resumeId: string | undefined;
let launchToolsets: string | undefined;
let launchMaxTurns: string | undefined;
for (let i = 0; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--resume') resumeId = process.argv[i + 1];
  else if (a === '-t' || a === '--toolsets') launchToolsets = process.argv[i + 1];
  else if (a === '--max-turns') launchMaxTurns = process.argv[i + 1];
}

function resumeGate(): void {
  if (!stateFile) return;
  const sessions = loadSessions();
  if (resumeId === undefined) {
    // A fresh run: any -t/--max-turns/--yolo works; the session is born with
    // these overrides. Modes that never report a session (fail, hang) do not
    // create one.
    if (mode === 'fail' || mode === 'hang' || mode === 'grandchild-hang') return;
    sessions[sessionId] = { toolsets: launchToolsets ?? null, maxTurns: launchMaxTurns ?? null };
    saveSessions(sessions);
    return;
  }
  const policy = sessions[resumeId];
  if (policy === undefined) {
    // Unknown session: adopt the overrides it is resumed with as its policy
    // (the real CLI only knows a session's launch values; tests that need a
    // recorded policy launch the session first).
    if (launchToolsets !== undefined || launchMaxTurns !== undefined) {
      sessions[resumeId] = { toolsets: launchToolsets ?? null, maxTurns: launchMaxTurns ?? null };
      saveSessions(sessions);
    }
    return;
  }
  const differs =
    (launchToolsets !== undefined && launchToolsets !== policy.toolsets) ||
    (launchMaxTurns !== undefined && launchMaxTurns !== policy.maxTurns);
  if (!differs) return; // same values, or neither passed: the resume works
  process.stderr.write(RESUME_POLICY_ERROR + '\n');
  const line = (obj: unknown): void => { process.stdout.write(JSON.stringify(obj) + '\n'); };
  line({ type: 'result', session_id: resumeId, exit_code: 2, error: RESUME_POLICY_ERROR, text: '' });
  process.exit(2);
}

resumeGate();

// Parse --query-file <path> from the argv the adapter handed us.
let queryFile: string | undefined;
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--query-file') { queryFile = process.argv[i + 1]; break; }
}

const line = (obj: unknown): void => { process.stdout.write(JSON.stringify(obj) + '\n'); };

function run(): void {
  // A failed run exits before printing anything.
  if (mode === 'fail') { process.exit(1); }

  // Normal-ish runs print the system init line.
  if (mode === 'normal' || mode === 'diff-session' || mode === 'echo-argv' || mode === 'no-result' || mode === 'print-env') {
    line({ type: 'system', subtype: 'init' });
  }

  if (mode === 'grandchild-hang' || mode === 'hang') {
    if (mode === 'grandchild-hang') {
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      if (grandchildPidFile) {
        try { writeFileSync(grandchildPidFile, String(grandchild.pid), 'utf8'); } catch { /* ignore */ }
      }
    }
    // Keep this process alive until the adapter kills the whole tree.
    setInterval(() => {}, 1000);
    return;
  }

  if (mode === 'no-result') {
    line({ type: 'text', text: 'partial ' });
    // Never prints a result event, then exits 0.
    return;
  }

  if (mode === 'print-env') {
    if (envFile) {
      try { writeFileSync(envFile, JSON.stringify(process.env), 'utf8'); } catch { /* ignore */ }
    }
    return;
  }

  if (mode === 'huge-output') {
    // Produce more than 8 MB of stdout to trip the adapter's output cap.
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'text', text: 'x'.repeat(9_000_000) }) + '\n');
    return;
  }

  if (mode === 'garbage') {
    process.stdout.write('{ not valid json ever');
    return;
  }

  let resultText = text;
  if (control.echoQuery && queryFile) {
    try { resultText = readFileSync(queryFile, 'utf8'); } catch { /* keep default text */ }
  }

  if (mode === 'normal' || mode === 'echo-argv') {
    line({ type: 'text', text: 'partial ' });
  }

  line({ type: 'result', session_id: sessionId, exit_code: exitCode, text: resultText, tokens: {} });
}

run();
