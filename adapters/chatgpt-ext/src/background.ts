// Relay Chat — astra adapter, MV3 service worker (M1.4). Owns the single
// WebSocket connection to the engine (content scripts come and go, and
// only one adapter may hello as 'astra'):
//   first frame → {type:'auth', token}       token from chrome.storage.local
//   then        → {type:'hello', name:'astra', version}
//   forwards    → {type:'captured', body, sourceRef} and {type:'status', status}
//
// The user pastes the token once into the options page (the extension
// cannot read %APPDATA%). MV3 kills idle workers: a 30s watchdog alarm
// re-connects a dropped socket; the engine reports 'disconnected' while
// it is down and assumes 'idle' again on hello.
import { isRelayHeaderEcho } from './protocol.ts';

const BUILD_MARKER = '2026-10-19.1';
console.log('[relay-astra worker] service worker started', BUILD_MARKER);

const DEBUG = false;
function debug(...parts: unknown[]): void {
  if (DEBUG) console.log('[relay-astra worker]', ...parts);
}

const ENGINE_URL = 'ws://127.0.0.1:8787';
const ADAPTER_VERSION = '0.1.0';
const TOKEN_KEY = 'token';
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const RECONNECT_MS = 2000;
const WATCHDOG_ALARM = 'relay-astra-watchdog';
const WATCHDOG_PERIOD_MIN = 0.5; // Chrome 120+ allows 30s alarm periods

// --- minimal chrome API view (structural typing, as in the spike) ---

interface SwChrome {
  runtime: {
    onMessage: {
      addListener: (
        handler: (msg: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void,
      ) => void;
    };
  };
  storage: {
    local: { get(keys: string): Promise<Record<string, unknown>> };
    onChanged: {
      addListener: (handler: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => void;
    };
  };
  alarms: {
    create: (name: string, info: { periodInMinutes: number }) => void;
    onAlarm: { addListener: (handler: (alarm: { name: string }) => void) => void };
  };
}
const maybeChrome = (globalThis as unknown as { chrome?: SwChrome }).chrome;
if (maybeChrome === undefined) {
  throw new Error('[relay-astra worker] no chrome API — this file must run as the extension service worker');
}
// A narrowed const: its declared type is SwChrome, so every closure below
// sees a non-optional API (narrowing itself does not cross function walls).
const chromeApi: SwChrome = maybeChrome;

// --- engine connection ---

let socket: WebSocket | null = null;
let connectInFlight = false;
let tokenMissingLogged = false;
let authRejected = false; // the engine rejected the saved token; needs a fresh paste
let lastSentStatus: string | null = null;

interface QueuedCapture {
  body: string;
  sourceRef: string;
  ack?: (response: { ok: boolean; sent?: boolean; dropped?: string }) => void;
}
const queuedCaptures: QueuedCapture[] = [];

function engineSocketOpen(): boolean {
  return socket !== null && socket.readyState === WebSocket.OPEN;
}

async function storedToken(): Promise<string | null> {
  const bag = await chromeApi.storage.local.get(TOKEN_KEY);
  const value = bag[TOKEN_KEY];
  return typeof value === 'string' && TOKEN_PATTERN.test(value) ? value : null;
}

function drainCaptures(): void {
  while (queuedCaptures.length > 0 && engineSocketOpen() && socket !== null) {
    const item = queuedCaptures.shift();
    if (item === undefined) break;
    socket.send(JSON.stringify({ type: 'captured', body: item.body, sourceRef: item.sourceRef }));
    item.ack?.({ ok: true, sent: true });
    debug('captured frame sent:', item.sourceRef);
  }
}

function scheduleReconnect(): void {
  setTimeout(() => { void connectEngine(); }, RECONNECT_MS);
}

async function connectEngine(): Promise<void> {
  if (connectInFlight || engineSocketOpen() || authRejected) return;
  connectInFlight = true;
  try {
    const token = await storedToken(); // re-read every attempt, like the codex adapter
    if (token === null) {
      if (!tokenMissingLogged) {
        tokenMissingLogged = true;
        console.log('[relay-astra worker] no token yet — paste it into the extension options (from %APPDATA%\\RelayChat\\token); retrying every 30s');
      }
      return; // the watchdog alarm (or a token save) triggers the next attempt
    }
    tokenMissingLogged = false;
    const ws = new WebSocket(ENGINE_URL);
    socket = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
      ws.send(JSON.stringify({ type: 'hello', name: 'astra', version: ADAPTER_VERSION }));
      lastSentStatus = null; // the engine assumes idle on hello; re-announce on change
      drainCaptures();
      console.log('[relay-astra worker] engine connection open');
    };
    ws.onclose = (event) => {
      if (socket === ws) socket = null;
      if (event.code === 4401) {
        // The engine rejected the token — retrying with the same one loops forever.
        authRejected = true;
        console.error('[relay-astra worker] engine rejected the saved token — paste the current one in the extension options');
        return;
      }
      if (event.code === 4400) return; // replaced by a newer connection — it is live
      console.log('[relay-astra worker] engine connection lost — retrying');
      scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows; retry handled there */ };
  } finally {
    connectInFlight = false;
  }
}

// --- content-script messages ---

function handleMessage(
  msg: unknown,
  _sender: unknown,
  sendResponse: (response: unknown) => void,
): boolean | void {
  const frame = msg as { type?: string; body?: unknown; sourceRef?: unknown; status?: unknown };
  if (frame?.type === 'captured') {
    if (typeof frame.body !== 'string' || typeof frame.sourceRef !== 'string') {
      sendResponse({ ok: false, error: 'malformed capture' });
      return;
    }
    if (frame.body.trim().length === 0) {
      sendResponse({ ok: true, dropped: 'empty' });
      return;
    }
    if (isRelayHeaderEcho(frame.body)) {
      sendResponse({ ok: true, dropped: 'relay-header' }); // SPEC: adapters ignore relay headers
      return;
    }
    const ack = sendResponse as QueuedCapture['ack'];
    const existing = queuedCaptures.find((q) => q.sourceRef === frame.sourceRef);
    if (existing !== undefined) {
      existing.ack = ack; // latest waiter wins; earlier channels already timed out
    } else {
      queuedCaptures.push({ body: frame.body, sourceRef: frame.sourceRef, ack });
    }
    if (engineSocketOpen()) {
      drainCaptures(); // sends and acks synchronously
      return;
    }
    void connectEngine(); // start reconnecting; the queued item acks when sent
    return true;         // keep the sendResponse channel open for the async ack
  }
  if (frame?.type === 'status') {
    if (typeof frame.status === 'string' && frame.status !== lastSentStatus &&
        engineSocketOpen() && socket !== null) {
      socket.send(JSON.stringify({ type: 'status', status: frame.status }));
      lastSentStatus = frame.status;
      debug('status frame sent:', frame.status);
    }
    sendResponse({ ok: true });
    return;
  }
  sendResponse({ ok: false, error: 'unexpected message' });
}

chromeApi.runtime.onMessage.addListener(handleMessage);

// --- watchdog + token changes ---

chromeApi.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MIN });
chromeApi.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM && !engineSocketOpen()) void connectEngine();
});

chromeApi.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[TOKEN_KEY] !== undefined) {
    authRejected = false; // a new token deserves fresh attempts
    tokenMissingLogged = false;
    if (!engineSocketOpen()) void connectEngine();
  }
});

void connectEngine();
