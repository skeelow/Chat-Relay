// Spawns tests/fake-orphan.ts DETACHED, writes its pid to
// FAKE_HERMES_ORPHAN_PID_FILE, then exits. Used by the fake-hermes
// `orphan-hang` mode: because this spawner exits immediately, the orphan is
// NOT inside the run's live process tree — the Windows parent-child table
// points at a dead pid, so `taskkill /T` on the run cannot reach it. This is
// the exact shape of the M6.4g live defect (the leaked bash.exe parented to
// the long-lived hermes server, not the relay run).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const pidFile = process.env.FAKE_HERMES_ORPHAN_PID_FILE;
const script = join(dirname(process.argv[1] ?? '.'), 'fake-orphan.ts');
const child = spawn(process.execPath, [script, process.argv[2] ?? 'no-arg'], {
  detached: true,
  stdio: 'ignore',
});
child.unref();
if (pidFile) {
  try { writeFileSync(pidFile, String(child.pid), 'utf8'); } catch { /* ignore */ }
}
process.exit(0);
