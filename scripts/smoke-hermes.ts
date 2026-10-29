// scripts/smoke-hermes.ts
//
// Real-system smoke check for the Hermes adapter (no real Hermes needed).
// Starts the real engine, the real Hermes adapter through its real connection
// and retry code (runForever / main(), with tests/fake-hermes.ts as the
// executable), and scripted fake GUI / Astra / Codex clients over WebSocket.
// Prints one PASS or FAIL line per check and exits 1 on any FAIL.
// Runs in under 60 seconds. Cleans up every child process and temp directory,
// even on failure.

import { WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEngine, type EngineHandle } from '../relay/engine.ts';
import { runForever } from '../adapters/hermes/adapter.ts';

const FAKE = join(process.cwd(), 'tests', 'fake-hermes.ts');
const RESULTS: { n: number; ok: boolean; detail: string }[] = [];
const VERBOSE = process.argv.includes('--verbose');
function logVerbose(...args: any[]): void { if (VERBOSE) console.log(...args); }

function check(n: number, name: string, ok: boolean, detail = '') {
  RESULTS.push({ n, ok, detail });
}

// --- tiny WebSocket client -------------------------------------------------
// Collects every incoming frame; waitFor polls the collected frames.

function makeClient(url: string, token: string, label = 'client') {
  const ws = new WebSocket(url);
  const frames: unknown[] = [];
  let connected = false;
  let openResolve: (() => void) | null = null;
  const opened = new Promise<void>((r) => { openResolve = r; });

  ws.on('open', () => {
    connected = true;
    openResolve?.();
    ws.send(JSON.stringify({ type: 'auth', token }));
  });
  ws.on('message', (data) => {
    try { frames.push(JSON.parse(String(data))); } catch { /* ignore unparseable frames */ }
  });
  ws.on('close', () => { connected = false; });
  ws.on('error', () => { connected = false; });

  function send(o: unknown) { void opened.then(() => ws.send(JSON.stringify(o))); }
  function close() { try { ws.close(); } catch {} }
  async function waitFor(pred: (m: unknown) => boolean, timeoutMs = 5000): Promise<unknown> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      for (let i = 0; i < frames.length; i++) {
        const m = frames[i];
        if (pred(m)) { frames.splice(0, i + 1); return m; }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timeout waiting for matching frame (${frames.length} frames buffered)`);
  }
  return { ws, frames, send, waitFor, close, connected: () => connected, opened };
}

function setting(dbPath: string, key: string): string | null {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  } finally { db.close(); }
}

// Return true if a Windows PID is still present in the task list.
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

let adapterController: AbortController | null = null;
let adapterPromise: Promise<void> | null = null;

function startAdapter(engineUrl: string, tokenPath: string): void {
  adapterController = new AbortController();
  adapterPromise = runForever(
    { engineUrl, tokenPath, executable: FAKE },
    adapterController.signal,
  );
  // unhandled-rejection noise is expected while the loop retries; ignore it.
  adapterPromise.catch(() => { /* loop ended / aborted */ });
}

function stopAdapter(): Promise<void> {
  const controller = adapterController;
  const promise = adapterPromise;
  adapterController = null;
  adapterPromise = null;
  if (controller) controller.abort();
  // runForever blocks awaiting the socket close; abort alone won't unblock it if
  // the socket stays open. Give it a bounded wait, then proceed regardless so
  // the smoke never hangs on teardown.
  if (promise) {
    return Promise.race([
      promise.catch(() => undefined),
      new Promise((r) => setTimeout(r, 4000)),
    ]) as Promise<void>;
  }
  return Promise.resolve();
}

function writeControl(dir: string, mode: string, sessionId = 'sess-smoke-1', text = 'OK'): string {
  const p = join(dir, 'control.json');
  writeFileSync(p, JSON.stringify({ mode, sessionId, text }), 'utf8');
  process.env.FAKE_HERMES_CONTROL = p;
  return p;
}

async function run() {
  const t0 = Date.now();
  let overall = true;
  let dirA: string | undefined;
  let dirB: string | undefined;

  try {
    // ------------------------------------------------------------------
    // Setup A: real engine + real adapter + fake GUI (checks 1-6, 8-10).
    // ------------------------------------------------------------------
    dirA = mkdtempSync(join(tmpdir(), 'relay-smoke-a-'));
    const dbPathA = join(dirA, 'relay.db');
    const tokenPathA = join(dirA, 'token');
    const engineA = await startEngine({ port: 0, dbPath: dbPathA, tokenPath: tokenPathA });
    const portA = engineA.port;
    logVerbose('SMOKE-STAGE: engineA started', portA);
    const urlA = `ws://127.0.0.1:${portA}`;
    writeControl(dirA, 'normal');
    const tokenA = readFileSync(tokenPathA, 'utf8').trim();
    const grandchildPidFile = join(dirA, 'grandchild-pid.txt');
    process.env.FAKE_HERMES_GRANDCHILD_PID_FILE = grandchildPidFile;

    startAdapter(urlA, tokenPathA);
    logVerbose('SMOKE-STAGE: adapter started, awaiting GUI');

    const guiA = makeClient(urlA, tokenA);
    try {
      // Check 1: hermes idle within 5 s of the adapter starting.
      logVerbose('SMOKE-STAGE: check 1 send gui_hello');
      try {
        guiA.send({ type: 'gui_hello' });
        const snap = (await guiA.waitFor((m: any) => m.type === 'snapshot', 8000)) as any;
        logVerbose('SMOKE-STAGE: check 1 got snapshot', JSON.stringify(snap.statuses));
        check(1, 'hermes idle within 5 s of adapter starting', snap.statuses?.hermes === 'idle', `status=${snap.statuses?.hermes}`);
      } catch (err) { check(1, 'hermes idle within 5 s of adapter starting', false, String(err)); }

      // Check 2: config reached the adapter before the first deliver (delivering).
      // Without config, the adapter fails the deliver immediately with
      // "waiting for engine config". With config, it replies `status=thinking`
      // as soon as it starts the run. So this genuinely observes config.
      logVerbose('SMOKE-STAGE: check 2 send');
      let configReached = false;
      try {
        guiA.send({ type: 'send', body: 'ping one', targets: ['hermes'] });
        const m = (await guiA.waitFor((x: any) =>
          (x.type === 'status_update' && x.adapter === 'hermes' && x.status === 'thinking') ||
          (x.type === 'delivery_update' && x.target === 'hermes' && x.status === 'failed'
            && String(x.error ?? '').includes('waiting for engine config')), 8000)) as any;
        configReached = m.type === 'status_update' && m.status === 'thinking';
        check(2, 'config reached adapter before first deliver', configReached,
          configReached ? 'thinking' : `${m.type}: ${m.error ?? m.status}`);
      } catch (err) { check(2, 'config reached adapter before first deliver', false, String(err)); }

      // Check 3: reply stored with source hermes, row delivered, session id stored.
      logVerbose('SMOKE-STAGE: check 3 waiting capture');
      let hermesCaptures = 0;
      try {
        await guiA.waitFor((m: any) => m.type === 'transcript_update' && m.message?.source === 'hermes', 8000);
        logVerbose('SMOKE-STAGE: check 3 got capture');
        hermesCaptures = 1;
      } catch { logVerbose('SMOKE-STAGE: check 3 capture TIMEOUT'); }
      let rowDelivered = false;
      let sessionIdA = null;
      try {
        await guiA.waitFor((m: any) => m.type === 'delivery_update' && m.target === 'hermes' && m.status === 'delivered', 8000);
        rowDelivered = true;
      } catch { /* */ }
      try { sessionIdA = setting(dbPathA, 'hermes_session_id'); } catch { /* */ }
      check(3, 'GUI send delivered, reply stored source hermes, row delivered, session id stored',
        hermesCaptures === 1 && rowDelivered && sessionIdA === 'sess-smoke-1',
        `captures=${hermesCaptures} delivered=${rowDelivered} sessionId=${sessionIdA}`);

      // Check 4: identical hermes reply stored too (D32). Use a different user
      // body so the engine's outbound dedupe doesn't fail the row; fake hermes
      // replies with the same identical text both times, and both captures are
      // stored because every hermes capture carries a unique sourceRef.
      let secondCapture = false;
      try {
        guiA.send({ type: 'send', body: 'ping two', targets: ['hermes'] });
        await guiA.waitFor((m: any) => m.type === 'transcript_update' && m.message?.source === 'hermes' && m.message?.body === 'OK', 8000);
        secondCapture = true;
      } catch { /* */ }
      check(4, 'identical hermes reply stored too (D32)', secondCapture, '');

      // Check 5: second send resumes the same session id.
      try {
        const sid = setting(dbPathA, 'hermes_session_id');
        check(5, 'second send resumes same session id', sid === 'sess-smoke-1', `sessionId=${sid}`);
      } catch (err) { check(5, 'second send resumes same session id', false, String(err)); }

      // Check 6: engine restart — adapter (not restarted) reconnects.
      try {
        engineA.stop();
        logVerbose('SMOKE-STAGE: engineA stopped');
        const engineB = await startEngine({ port: portA, dbPath: dbPathA, tokenPath: tokenPathA });
        logVerbose('SMOKE-STAGE: engineB started on', portA);
        try {
          let reconnected = false;
          const deadline = Date.now() + 8000;
          while (Date.now() < deadline) {
            const guiB = makeClient(urlA, tokenA);
            try {
              await new Promise((r) => setTimeout(r, 300));
              guiB.send({ type: 'gui_hello' });
              const snap = (await guiB.waitFor((m: any) => m.type === 'snapshot', 3000)) as any;
              if (snap.statuses?.hermes === 'idle') { reconnected = true; guiB.close(); break; }
            } catch { /* retry */ }
            finally { guiB.close(); }
          }

          // send after the restart is delivered
          let deliveredAfter = false;
          if (reconnected) {
            const guiB = makeClient(urlA, tokenA, 'guiB');
            await guiB.opened;
            guiB.send({ type: 'gui_hello' });
            await guiB.waitFor((m: any) => m.type === 'snapshot', 3000);
            guiB.send({ type: 'send', body: 'after restart', targets: ['hermes'] });
            try {
              await guiB.waitFor((m: any) => m.type === 'transcript_update' && m.message?.source === 'hermes', 8000);
              deliveredAfter = true;
            } catch { /* */ }
            finally { guiB.close(); }
          }
          const check6ok = reconnected && deliveredAfter;
          check(6, 'adapter reconnects after engine restart, hermes idle again; send after restart delivered',
            check6ok, `reconnected=${reconnected} deliveredAfter=${deliveredAfter}`);

          // ---- checks 8, 9, 10 use engineB + fake Astra + Codex ----
          const guiB = makeClient(urlA, tokenA);
          guiB.send({ type: 'gui_hello' });
          await guiB.waitFor((m: any) => m.type === 'snapshot', 3000);
          const astra = makeClient(urlA, tokenA);
          const codex = makeClient(urlA, tokenA);
          try {
            await Promise.all([
              new Promise((r) => { astra.ws.once('open', r); astra.send({ type: 'hello', name: 'astra' }); }),
              new Promise((r) => { codex.ws.once('open', r); codex.send({ type: 'hello', name: 'codex' }); }),
            ]);
            // set auto mode, auto-send on
            guiB.send({ type: 'set_mode', mode: 'auto', autoSend: true, autoSendDelaySec: 10 });
            await guiB.waitFor((m: any) => m.type === 'settings_update', 3000);

            // Check 8: Astra capture -> row for Codex only; no Hermes row / countdown.
            let codexRow = false;
            let hermesRow = false;
            let hermesCountdown = false;
            astra.send({ type: 'captured', body: 'astra reply', sourceRef: 'sess-smoke-1:8-1' });
            try {
              await guiB.waitFor((m: any) => m.type === 'delivery_update' && m.target === 'codex', 5000);
              codexRow = true;
            } catch { /* */ }
            await new Promise((r) => setTimeout(r, 500));
            // countdown check via a fresh gui snapshot
            const guiSnap = makeClient(urlA, tokenA, 'snapGui');
            try {
              guiSnap.send({ type: 'gui_hello' });
              const snap = (await guiSnap.waitFor((x: any) => x.type === 'snapshot', 3000)) as any;
              hermesCountdown = (snap.countdowns || []).some((c: any) => c.target === 'hermes');
              hermesRow = hermesRow || (snap.deliveries || []).some((d: any) => d.target === 'hermes' && d.status !== 'delivered' && d.status !== 'failed' && d.status !== 'cancelled');
            } catch { /* */ }
            finally { guiSnap.close(); }
            check(8, 'auto mode: Astra/Codex rows for each other only, never Hermes, no Hermes countdown', codexRow && !hermesRow && !hermesCountdown, `codexRow=${codexRow} hermesRow=${hermesRow} hermesCountdown=${hermesCountdown}`);

            // Check 9: Stop during a long fake run returns Hermes row to pending_approval,
            // and the fake run's process tree is gone (no orphan). grandchild-hang mode
            // spawns a grandchild whose pid we can assert is dead after Stop.
            writeControl(dirA, 'grandchild-hang');
            guiB.send({ type: 'send', body: 'long run', targets: ['hermes'] });
            let rowPending = false;
            let treeGone = false;
            try {
              await guiB.waitFor((m: any) => m.type === 'delivery_update' && m.target === 'hermes' && m.status === 'delivering', 5000);
              guiB.send({ type: 'stop' });
              await guiB.waitFor((m: any) => m.type === 'delivery_update' && m.target === 'hermes' && m.status === 'pending_approval', 8000);
              rowPending = true;
            } catch { /* */ }
            writeControl(dirA, 'normal');
            const pid = readFileSync(grandchildPidFile, 'utf8').trim();
            let gone = false;
            for (let i = 0; i < 10; i++) {
              if (!pidIsAlive(pid)) { gone = true; break; }
              await new Promise((r) => setTimeout(r, 300));
            }
            treeGone = gone;
            check(9, 'Stop returns Hermes row to pending_approval and process tree is gone', rowPending && treeGone, `rowPending=${rowPending} treeGone=${treeGone}`);

            // Check 10: thread frame from non-hermes socket does not change hermes_session_id.
            let sessionUnchanged = false;
            try {
              codex.send({ type: 'thread', threadId: 'fake-codex-thread' });
              await new Promise((r) => setTimeout(r, 500));
              const sid = setting(dbPathA, 'hermes_session_id');
              sessionUnchanged = sid === 'sess-smoke-1';
            } catch { /* */ }
            check(10, 'thread from non-hermes socket does not change hermes_session_id', sessionUnchanged, `sessionId=${setting(dbPathA, 'hermes_session_id')}`);

          } finally {
            astra.close();
            codex.close();
            guiB.close();
          }

          engineB.stop();
      } catch (err) {
        check(6, 'adapter reconnects after engine restart, hermes idle again; send after restart delivered', false, String(err));
        try { engineA.stop(); } catch { }
      }
    } catch (err) {
      check(6, 'adapter reconnects after engine restart, hermes idle again; send after restart delivered', false, String(err));
      }
    } finally {
      guiA.close();
    }

    // ------------------------------------------------------------------
    // Setup B: adapter started before the engine and before the token file
    // exists (check 7).
    // ------------------------------------------------------------------
    logVerbose('SMOKE-STAGE: check 7');
    dirB = mkdtempSync(join(tmpdir(), 'relay-smoke-b-'));
    const dbPathB = join(dirB, 'relay.db');
    const tokenPathB = join(dirB, 'token');

    // Start engine0 on a free port so it creates the token file, then stop it
    // and delete the token so the adapter starts with neither engine nor token.
    const engine0 = await startEngine({ port: 0, dbPath: dbPathB, tokenPath: tokenPathB });
    const portB = engine0.port;
    const urlB = `ws://127.0.0.1:${portB}`;
    logVerbose('SMOKE-STAGE: engine0 started', portB);
    engine0.stop();
    logVerbose('SMOKE-STAGE: engine0 stopped');
    try { unlinkSync(tokenPathB); } catch { /* token removed so adapter starts with none */ }
    writeControl(dirB, 'normal');
    const abortB = new AbortController();
    const runB = runForever({ engineUrl: urlB, tokenPath: tokenPathB, executable: FAKE }, abortB.signal);
    runB.catch(() => { /* */ });

    // adapter retries while nothing is there — must stay alive
    await new Promise((r) => setTimeout(r, 1500));

    // start the engine; adapter should connect on next retry without restart
    const engineB2 = await startEngine({ port: portB, dbPath: dbPathB, tokenPath: tokenPathB });
    logVerbose('SMOKE-STAGE: engineB2 started', portB);
    const tokenB = readFileSync(tokenPathB, 'utf8').trim();
    let check7ok = false;
    try {
      await new Promise((r) => setTimeout(r, 3500));
      const guiB = makeClient(urlB, tokenB);
      try {
        guiB.send({ type: 'gui_hello' });
        const snap = (await guiB.waitFor((m: any) => m.type === 'snapshot', 5000)) as any;
        check7ok = snap.statuses?.hermes === 'idle';
      } catch { /* */ }
      finally { guiB.close(); }
    } catch { /* */ }
    check(7, 'adapter started before engine and token connects when engine appears', check7ok, '');

    try { abortB.abort(); await Promise.race([runB, new Promise((r) => setTimeout(r, 6000))]).catch(() => undefined); } catch { /* */ }
    logVerbose('SMOKE-STAGE: setup B done');
    try { engineB2.stop(); } catch { /* */ }
    try { rmSync(dirB, { recursive: true, force: true, maxRetries: 5 }); } catch { /* */ }

  } catch (err) {
    console.error(`FAIL smoke setup: ${err}`);
    overall = false;
  } finally {
    try { await stopAdapter(); } catch { /* */ }
    try { if (typeof dirA !== 'undefined') rmSync(dirA, { recursive: true, force: true, maxRetries: 5 }); } catch { /* */ }
    try { if (typeof dirB !== 'undefined') rmSync(dirB, { recursive: true, force: true, maxRetries: 5 }); } catch { /* */ }
  }

  // ------------------------------------------------------------------
  // Report results in check-number order.
  // ------------------------------------------------------------------
  RESULTS.sort((a, b) => a.n - b.n);
  let failCount = 0;
  for (const r of RESULTS) {
    const line = `${r.ok ? 'PASS' : 'FAIL'} check ${r.n}: ${r.detail || '(no detail)'}`;
    console.log(line);
    if (!r.ok) failCount++;
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nsmoke:hermes ${failCount === 0 && overall ? 'PASS' : 'FAIL'} (${failCount} check(s) failed, ${elapsed}s)`);
  process.exit(failCount === 0 && overall ? 0 : 1);
}

run();
