// Relay Chat — the relay-cwd marker process sweep (M6.4g, D37).
//
// Live defect (M6.4g): a Hermes work run's shell can outlive the run tree the
// adapter kills, because its PARENT is the long-lived hermes server process,
// not the relay-launched run. `taskkill /T` on the run never reaches it. The
// one fact that always identifies such a leftover is its command line: every
// process the relay launches runs inside %APPDATA%\RelayChat\hermes-cwd, so
// that path appears in its command line (Windows `\` form or MSYS `/` form).
//
// Rule: terminate ONLY processes whose command line contains the marker path,
// together with their child trees. Never kill by process name; never kill
// anything whose command line lacks the marker — other Hermes processes,
// gateways, Hal or Claude sessions must stay untouched.
//
// Windows: PowerShell Get-CimInstance Win32_Process (real command lines +
// creation times) and taskkill /F /T /PID per match. POSIX fallback: ps +
// kill. Every failure is best effort and returns 0 — the sweep never throws.
import { execFileSync } from 'node:child_process';

/** The marker: the RelayChat folder and the hermes-cwd folder adjacent in a
 *  path, in either separator form, case-insensitive. The leading boundary
 *  rejects look-alikes like `/notrelaychat/hermes-cwd`; the trailing one
 *  rejects `hermes-cwdX` while still matching a path BELOW the cwd
 *  (`hermes-cwd\prompt-1.txt`, `hermes-cwd-scope`). */
const MARKER_RE = /(?:^|[^A-Za-z0-9_])RelayChat[\\/]+hermes-cwd(?![A-Za-z0-9_])/i;

export interface SweepOptions {
  /** Only processes CREATED STRICTLY BEFORE this wall-clock time (epoch ms)
   *  are swept — the adapter-start orphan sweep uses the adapter's start so a
   *  sweep can never kill a run that is current. Kill/Stop sweeps pass
   *  nothing (every marker process is then fair game). */
  olderThanMs?: number;
  /** An extra substring the command line must also contain. Production never
   *  uses it; tests scope their sweeps so concurrent test files' marker
   *  children are never touched by another file's sweep. */
  contains?: string;
}

/** Does this command line carry the relay cwd marker? */
export function hasRelayCwdMarker(commandLine: string, contains?: string): boolean {
  if (!MARKER_RE.test(commandLine)) return false;
  return contains === undefined || commandLine.includes(contains);
}

interface MatchedProcess {
  pid: number;
  createdMs: number;
  commandLine: string;
}

/** List the live processes whose command line carries the marker. */
function listMarkerProcesses(): MatchedProcess[] {
  if (process.platform === 'win32') {
    // Coarse PS-side filter ('relaychat', case-insensitive by default), the
    // exact marker decision stays in JS so one regex governs everything.
    const ps = 'Get-CimInstance Win32_Process | ForEach-Object {'
      + ' if ($_.CommandLine -match "relaychat") {'
      + ' $ms = [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds();'
      + ' Write-Output "$($_.ProcessId)`t$ms`t$($_.CommandLine)"'
      + ' } }';
    let out = '';
    try {
      out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      return [];
    }
    const found: MatchedProcess[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      const first = line.indexOf('\t');
      const second = line.indexOf('\t', first + 1);
      if (first <= 0 || second <= first) continue;
      const pid = Number(line.slice(0, first));
      const createdMs = Number(line.slice(first + 1, second));
      const commandLine = line.slice(second + 1);
      if (!Number.isInteger(pid) || !Number.isFinite(createdMs)) continue;
      if (hasRelayCwdMarker(commandLine)) found.push({ pid, createdMs, commandLine });
    }
    return found;
  }
  // POSIX fallback: command lines via ps; creation time unknown here, so an
  // age gate resolves etimes per match (the live product is Windows).
  let out = '';
  try {
    out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const found: MatchedProcess[] = [];
  for (const line of out.split('\n')) {
    const first = line.indexOf(' ');
    if (first <= 0) continue;
    const pid = Number(line.slice(0, first).trim());
    const commandLine = line.slice(first + 1);
    if (!Number.isInteger(pid) || !hasRelayCwdMarker(commandLine)) continue;
    let createdMs = 0; // unknown → always "older than anything"
    try {
      const et = Number(execFileSync('ps', ['-o', 'etimes=', '-p', String(pid)],
        { encoding: 'utf8' }).trim());
      if (Number.isFinite(et)) createdMs = Date.now() - et * 1000;
    } catch { /* leave 0 */ }
    found.push({ pid, createdMs, commandLine });
  }
  return found;
}

function killProcessTree(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return true;
    }
    try {
      process.kill(-pid, 'SIGKILL'); // the whole process group (detached shell)
    } catch {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch {
    return false; // already gone
  }
}

/**
 * Terminate every leftover process whose command line carries the relay cwd
 * marker, with its child tree, and return how many were terminated.
 * Processes without the marker are never touched.
 */
export function sweepRelayOrphans(options: SweepOptions = {}): number {
  let killed = 0;
  let matches: MatchedProcess[];
  try {
    matches = listMarkerProcesses();
  } catch {
    return 0;
  }
  for (const m of matches) {
    if (m.pid === process.pid) continue; // never self
    if (options.olderThanMs !== undefined && m.createdMs >= options.olderThanMs) continue;
    if (options.contains !== undefined && !m.commandLine.includes(options.contains)) continue;
    if (killProcessTree(m.pid)) killed++;
  }
  return killed;
}
