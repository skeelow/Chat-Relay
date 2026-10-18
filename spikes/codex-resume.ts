// M0.1 — Codex app-server spike (docs/SPEC.md, Test B).
//
// Resume a thread by id, print its last 3 turns, then start one turn asking
// for PONG, printing every event type as it streams. All protocol shapes come
// from `codex app-server generate-ts` output in spikes/codex-schema — no
// protocol shape in this file is hand-written, only the stdio glue.
//
// Usage: node spikes/codex-resume.ts [thread-id]
//   no thread-id  -> initialize, verify ChatGPT login, list 10 recent threads.
//   with thread-id -> also resume it, print its last 3 turns, and append the
//                    PONG test turn to that thread (a real turn on the account).
//
// Hard rules honored here: no credential handling (the auth token is never
// requested or printed), no auto-approval of any server request.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { InitializeResponse } from '../codex-schema/InitializeResponse.ts';
import type { GetAuthStatusResponse } from '../codex-schema/GetAuthStatusResponse.ts';
import type { AgentMessageDeltaNotification } from '../codex-schema/v2/AgentMessageDeltaNotification.ts';
import type { ErrorNotification } from '../codex-schema/v2/ErrorNotification.ts';
import type { ThreadItem } from '../codex-schema/v2/ThreadItem.ts';
import type { ThreadListResponse } from '../codex-schema/v2/ThreadListResponse.ts';
import type { ThreadResumeResponse } from '../codex-schema/v2/ThreadResumeResponse.ts';
import type { ThreadTurnsListResponse } from '../codex-schema/v2/ThreadTurnsListResponse.ts';
import type { Turn } from '../codex-schema/v2/Turn.ts';
import type { TurnCompletedNotification } from '../codex-schema/v2/TurnCompletedNotification.ts';
import type { TurnStartResponse } from '../codex-schema/v2/TurnStartResponse.ts';
import type { UserInput } from '../codex-schema/v2/UserInput.ts';

const PONG_PROMPT = '[Relay · test] Reply with the word PONG and nothing else.';

// --- transport: newline-delimited JSON over stdio ---
const child = spawn('codex', ['app-server'], {
  shell: process.platform === 'win32', // npm's codex shim is a .cmd on Windows
  stdio: ['pipe', 'pipe', 'inherit'],
});
child.on('exit', (code) => { console.log(`[app-server exited code=${code}]`); process.exit(code ?? 0); });

function send(frame: unknown): void {
  child.stdin.write(JSON.stringify(frame) + '\n');
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; }
const pending = new Map<number, Pending>();
let nextId = 1;

function request<T>(method: string, params: unknown): Promise<T> {
  const id = nextId++;
  send({ method, id, params });
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
  });
}

// --- streaming bookkeeping for the PONG turn ---
let pongThreadId: string | null = null;
let turnDone: ((turn: Turn) => void) | null = null;
const agentText = new Map<string, string>();      // itemId -> streamed deltas
let finalText = '';
const eventTypes = new Map<string, number>();     // notification method -> count
const serverRequests: unknown[] = [];             // approval requests are never answered here

function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

function describeItem(item: ThreadItem): string {
  switch (item.type) {
    case 'userMessage': {
      const texts = item.content.filter(c => c.type === 'text').map(c => (c as { text: string }).text);
      return `user: ${clip(texts.join(' '))}`;
    }
    case 'agentMessage': return `agent: ${clip(item.text)}`;
    case 'reasoning': return `reasoning: ${clip([...item.summary, ...item.content].join(' '))}`;
    case 'plan': return `plan: ${clip(item.text)}`;
    case 'commandExecution': return `tool: ${clip(item.command)}`;
    case 'fileChange': return `fileChange (${item.changes.length} changes)`;
    case 'mcpToolCall': return `mcpToolCall: ${item.server}/${item.tool}`;
    default: return `[${item.type}]`;
  }
}

function printTurn(t: Turn, index: number): void {
  console.log(`--- turn ${index}: ${t.id} status=${t.status} ` +
              `started=${t.startedAt ?? '?'} completed=${t.completedAt ?? '?'}`);
  for (const item of t.items) console.log(`    ${describeItem(item)}`);
}

function onNotification(method: string, params: unknown): void {
  eventTypes.set(method, (eventTypes.get(method) ?? 0) + 1);
  const p = params as Record<string, unknown>;
  switch (method) {
    case 'item/agentMessage/delta': {
      const d = params as AgentMessageDeltaNotification;
      agentText.set(d.itemId, (agentText.get(d.itemId) ?? '') + d.delta);
      process.stdout.write(d.delta);
      return;
    }
    case 'item/started':
      console.log(`\n[event] item/started: ${(p.item as ThreadItem).type}`);
      return;
    case 'item/completed': {
      const item = p.item as ThreadItem;
      console.log(`\n[event] item/completed: ${item.type}`);
      if (item.type === 'agentMessage') finalText = item.text;
      return;
    }
    case 'turn/started':
      console.log(`\n[event] turn/started (${(p.turn as Turn).id})`);
      return;
    case 'turn/completed': {
      const done = params as TurnCompletedNotification;
      console.log(`\n[event] turn/completed status=${done.turn.status}`);
      if (done.threadId === pongThreadId && turnDone) turnDone(done.turn);
      return;
    }
    case 'error': {
      const e = params as ErrorNotification;
      console.log(`\n[event] error: ${JSON.stringify(e.error)} willRetry=${e.willRetry}`);
      return;
    }
    default:
      console.log(`\n[event] ${method}`);
  }
}

createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return;
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(`[non-JSON line] ${clip(line, 200)}`);
    return;
  }
  if ('method' in frame) {
    if ('id' in frame && frame.id !== null) {
      // A request FROM the server (approval, user input...). Hard rule: the
      // relay never approves automatically. Print it and leave it unanswered.
      console.log(`\n[server request] ${String(frame.method)} id=${String(frame.id)} — NOT auto-answered`);
      serverRequests.push(frame);
      return;
    }
    onNotification(frame.method as string, frame.params);
    return;
  }
  if ('id' in frame) {
    const id = Number(frame.id);
    const waiter = pending.get(id);
    if (waiter) {
      pending.delete(id);
      if (frame.error !== undefined) waiter.reject(new Error(JSON.stringify(frame.error)));
      else waiter.resolve('result' in frame ? frame.result : frame);
    } else {
      console.log(`[unmatched response] ${clip(line, 300)}`);
    }
  }
});

function shutdown(code: number): never {
  child.stdin.end();
  child.kill();
  process.exit(code);
}

async function main(): Promise<void> {
  // Step 2: initialize + initialized notification.
  const init = await request<InitializeResponse>('initialize', {
    clientInfo: { name: 'relay-chat', title: null, version: '0.1.0' },
    capabilities: null,
  });
  console.log(`initialized: userAgent=${String(init?.userAgent ?? '?')} platform=${String(init?.platformFamily)}/${String(init?.platformOs)}`);
  send({ method: 'initialized' });

  // Step 3: confirm ChatGPT login, not an API key. The token is never requested.
  const auth = await request<GetAuthStatusResponse>('getAuthStatus', { includeToken: false, refreshToken: false });
  console.log(`authMethod: ${String(auth?.authMethod)}`);
  if (auth?.authMethod !== 'chatgpt') {
    console.log('\nNot logged in with a ChatGPT account. Start the login flow yourself with:');
    console.log('    codex login');
    console.log('The spike never touches credentials (hard rule). Stopping.');
    shutdown(1);
  }

  // Step 4: the 10 most recent threads.
  const list = await request<ThreadListResponse>('thread/list', { limit: 10 });
  console.log(`\n=== ${list.data.length} most recent threads ===`);
  for (const t of list.data) {
    const when = new Date((t.recencyAt ?? t.updatedAt) * 1000).toISOString();
    console.log(`${t.id}  ${t.status.type.padEnd(10)} ${when}  ${clip(t.name ?? t.preview ?? '', 70)}`);
  }

  const threadId = process.argv[2];
  if (!threadId) {
    console.log('\nNo thread id given — stopping after the listing. Re-run with a thread id to resume + PONG.');
    shutdown(0);
  }

  // Step 5: resume and print the last 3 turns.
  console.log(`\n=== resume ${threadId} ===`);
  const resumed = await request<ThreadResumeResponse>('thread/resume', { threadId, excludeTurns: true });
  console.log(`resumed: ${clip(resumed.thread.name ?? resumed.thread.preview ?? '', 70)} ` +
              `model=${resumed.model} provider=${resumed.modelProvider} approvalPolicy=${String(resumed.approvalPolicy)}`);
  const turns = await request<ThreadTurnsListResponse>('thread/turns/list', {
    threadId, limit: 3, itemsView: 'full',
  });
  console.log(`\n=== last ${turns.data.length} turns (oldest first) ===`);
  turns.data.slice().reverse().forEach((t, i) => printTurn(t, i + 1));

  // Step 6: the PONG turn, streaming every event.
  console.log('\n=== starting PONG turn ===');
  pongThreadId = threadId;
  const input: UserInput[] = [{ type: 'text', text: PONG_PROMPT, text_elements: [] }];
  const started = await request<TurnStartResponse>('turn/start', { threadId, input });
  console.log(`turn started: ${started.turn.id}`);
  const done = new Promise<Turn>((resolve) => { turnDone = resolve; });
  const guard = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('no turn/completed event within 180s (safety guard, not completion detection)')), 180_000));
  const finalTurn = await Promise.race([done, guard]);

  // Final assistant text, separated from reasoning and tool events.
  const streamed = [...agentText.values()].join('');
  console.log('\n\n=== final assistant text ===');
  console.log(finalText || streamed || '(no agentMessage captured — see events above)');
  console.log(`\n[completion detected from the turn/completed event; turn status=${finalTurn.status}]`);
  console.log(`[final turn item types: ${finalTurn.items.map(i => i.type).join(', ')}]`);
  console.log('\n=== event types seen during the turn ===');
  for (const [m, n] of eventTypes) console.log(`${String(n).padStart(3)}x ${m}`);
  if (serverRequests.length > 0) console.log(`\n[!] ${serverRequests.length} server request(s) arrived and were NOT answered`);
  shutdown(0);
}

main().catch((err: unknown) => { console.error('SPIKE FAILED:', err); shutdown(1); });
