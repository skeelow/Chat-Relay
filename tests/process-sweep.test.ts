// M6.4g: the relay-cwd marker process sweep, tested against REAL processes.
// Every spawned child is a real detached node process; every swept child is
// verified dead with tasklist (Windows) / signal 0 (POSIX). The tests scope
// their sweeps with a unique `contains` token so a concurrent test file's
// marker children are never touched by this file's sweeps (and vice versa).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import { hasRelayCwdMarker, sweepRelayOrphans } from '../relay/process-sweep.ts';

const ORPHAN = join(process.cwd(), 'tests', 'fake-orphan.ts');

/** The relay cwd in its Windows form with a per-spawn scope token appended
 *  (the marker regex allows a trailing '-': real prompt files do the same). */
function markerArg(token: string): string {
  return `C:/Users/tester/AppData/Roaming/RelayChat/hermes-cwd-${token}`;
}

/** A look-alike path: RelayChat folder but NOT the hermes-cwd marker. */
function lookalikeArg(token: string): string {
  return `C:/Users/tester/AppData/Roaming/RelayChat/hermes-data-${token}`;
}

const spawned: number[] = [];

function spawnDetached(arg: string): number {
  const child = spawn(process.execPath, [ORPHAN, arg], { detached: true, stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('orphan spawn got no pid');
  child.unref();
  spawned.push(pid);
  return pid;
}

function pidIsAlive(pid: number): boolean {
  if (process.platform === 'win32') {
    try {
      const out = execSync(`tasklist /FI "PID eq ${pid}"`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      return String(out).includes(String(pid)) && !String(out).includes('No tasks');
    } catch {
      return false;
    }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* already gone */ }
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitGone(pid: number, tries = 25): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (!pidIsAlive(pid)) return true;
    await pause(200);
  }
  return !pidIsAlive(pid);
}

async function waitAlive(pid: number): Promise<void> {
  for (let i = 0; i < 15; i++) {
    if (pidIsAlive(pid)) return;
    await pause(200);
  }
  throw new Error(`pid ${pid} never started`);
}

test('marker regex: both path forms, case-insensitive; look-alikes rejected', () => {
  // The exact observed defect form (MSYS path inside a bash -c string).
  assert.equal(hasRelayCwdMarker(
    'bash.exe -c "source x.sh 2>/dev/null; builtin cd -- /c/Users/me/AppData/Roaming/RelayChat/hermes-cwd && eval \'for i in 1 2\'"'), true);
  assert.equal(hasRelayCwdMarker('node run.js C:\\Users\\me\\AppData\\Roaming\\RelayChat\\hermes-cwd\\prompt-1.txt'), true);
  assert.equal(hasRelayCwdMarker('node run.js C:\\...\\RELAYCHAT\\HERMES-CWD\\prompt-1.txt'), true);
  assert.equal(hasRelayCwdMarker('node run.js .../RelayChat/hermes-cwd-extra'), true); // a path below it
  // Negatives: nothing may match unless it is the real marker path.
  assert.equal(hasRelayCwdMarker('node run.js C:/Users/me/other-cwd'), false);
  assert.equal(hasRelayCwdMarker('node run.js C:/Users/me/RelayChat/hermes-data'), false);
  assert.equal(hasRelayCwdMarker('node run.js /notrelaychat/hermes-cwd'), false);
  assert.equal(hasRelayCwdMarker('node run.js C:/x/RelayChat/hermes-cwdX'), false);
});

test('sweep: a marker child OUTSIDE the run tree is killed; a look-alike survives', async (t) => {
  const token = `sweep-${process.pid}-${t.name.replace(/\W+/g, '')}`;
  const orphan = spawnDetached(markerArg(token));
  const lookalike = spawnDetached(lookalikeArg(token));
  try {
    await waitAlive(orphan);
    await waitAlive(lookalike);
    const killed = sweepRelayOrphans({ contains: token });
    assert.equal(killed, 1, 'exactly the marker child is swept');
    assert.equal(await waitGone(orphan), true, 'the marker orphan is dead');
    assert.equal(pidIsAlive(lookalike), true, 'the look-alike (no marker) survives');
  } finally {
    killTree(lookalike);
    killTree(orphan);
  }
});

test('sweep age gate: processes younger than the adapter start survive', async (t) => {
  const token = `sweepage-${process.pid}-${t.name.replace(/\W+/g, '')}`;
  const orphan = spawnDetached(markerArg(token));
  try {
    await waitAlive(orphan);
    // The adapter "started" a minute before this process existed: the orphan
    // is YOUNGER than the adapter start → the start sweep must leave it alone.
    assert.equal(sweepRelayOrphans({ contains: token, olderThanMs: Date.now() - 60_000 }), 0);
    assert.equal(pidIsAlive(orphan), true, 'younger-than-start orphan survives the start sweep');
    // The adapter "started" a minute after it: it is an orphan of a previous
    // crashed run (created before the adapter start) → swept.
    assert.equal(sweepRelayOrphans({ contains: token, olderThanMs: Date.now() + 60_000 }), 1);
    assert.equal(await waitGone(orphan), true, 'older-than-start orphan is swept');
  } finally {
    killTree(orphan);
  }
});

test('sweep with no match returns 0', () => {
  assert.equal(sweepRelayOrphans({ contains: `no-such-token-${process.pid}-zzz` }), 0);
});
