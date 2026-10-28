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

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

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
