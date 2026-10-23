// Relay Chat — astra adapter, MV3 service worker (M1.4). Owns the single
// WebSocket connection to the engine (content scripts come and go, and
// only one adapter may hello as 'astra'):
//   first frame → {type:'auth', token}       token from chrome.storage.local
//   then        → {type:'hello', name:'astra', version}
//   forwards    → {type:'captured', body, sourceRef} and {type:'status', status}
//
// The user pastes the token once into the options page (the extension
// cannot read %APPDATA%). MV3 kills idle workers: from Chrome 116 an
// open WebSocket with traffic every <30s keeps the worker alive, which
// the 20s ping provides; the 30s watchdog alarm still re-connects after
// an engine outage or browser restart. The engine reports 'disconnected'
// while the socket is down and assumes 'idle' again on hello.
//
// M1.4 fixes applied (review):
//   F2 — the latest status lives in chrome.storage.session and is
//        replayed after every hello unless it is 'idle'.
//   F3 — queued captures drain only after the socket has been open
//        500ms, survive a 4401 token rejection, and persist in
//        chrome.storage.session so a worker death cannot drop them.
//   F4 — a 20s {"type":"ping"} keepalive; the manifest's
//        minimum_chrome_version 116 gates the WebSocket keepalive rule.
import { deliveryTabDecision, isRelayHeaderEcho, statusToReplayAfterHello } from './protocol.ts';

const BUILD_MARKER = '2026-10-22.1';
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
const STATUS_KEY = 'latestStatus';      // F2: last status from the content script
const QUEUE_KEY = 'queuedCaptures';      // F3: captures that must survive worker death
const SENDER_TAB_KEY = 'lastSenderTabId'; // S1 (M3.2a): the tab deliveries go to
const DRAIN_SETTLE_MS = 500;             // F3: wait out the token-rejection window
const PING_INTERVAL_MS = 20000;         // F4: under the ~30s MV3 idle kill
const MAX_PERSISTED_QUEUE = 20;          // F3: keep the persisted queue small
const PING_FRAME = JSON.stringify({ type: 'ping' });

// --- minimal chrome API view (structural typing, as in the spike) ---

interface SwChrome {
  runtime: {
    onMessage: {
      addListener: (
        handler: (msg: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void,
      ) => void;
    };
  };
  tabs: {
    /** No "tabs" permission needed — messaging a known id is open to all extensions. */
    sendMessage: (tabId: number, message: unknown) => Promise<unknown>;
  };
  storage: {
    local: { get(keys: string): Promise<Record<string, unknown>> };
    session: {
      get(keys: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
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
let socketOpenAt: number | null = null; // F3: when the current socket opened
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

/**
 * F3: the socket has been open long enough that a drain is safe. The
 * engine's token rejection (4401) lands right after open; captures acked
 * before it would be lost while the content script believes them sent.
 */
function drainReady(): boolean {
  return engineSocketOpen() &&
    socketOpenAt !== null && Date.now() - socketOpenAt >= DRAIN_SETTLE_MS;
}

async function storedToken(): Promise<string | null> {
  const bag = await chromeApi.storage.local.get(TOKEN_KEY);
  const value = bag[TOKEN_KEY];
  return typeof value === 'string' && TOKEN_PATTERN.test(value) ? value : null;
}

/** F3: the queue mirrored to chrome.storage.session (no ack callbacks —
 * they do not survive a worker death anyway), capped to stay small.
 * Newest items win when over the cap. */
function persistQueue(): void {
  const persistable = queuedCaptures
    .slice(-MAX_PERSISTED_QUEUE)
    .map(({ body, sourceRef }) => ({ body, sourceRef }));
  void chromeApi.storage.session.set({ [QUEUE_KEY]: persistable });
}

/** F3: on worker revival, bring back whatever the previous worker had
 * queued — its in-memory copy died with it. */
async function restoreQueue(): Promise<void> {
  const bag = await chromeApi.storage.session.get(QUEUE_KEY);
  const stored = bag[QUEUE_KEY];
  if (Array.isArray(stored)) {
    for (const raw of stored) {
      const item = raw as { body?: unknown; sourceRef?: unknown };
      if (typeof item.body === 'string' && typeof item.sourceRef === 'string' &&
          !queuedCaptures.some((q) => q.sourceRef === item.sourceRef)) {
        queuedCaptures.push({ body: item.body, sourceRef: item.sourceRef });
      }
    }
  }
  // N5: re-mirror the merged queue. A capture can arrive while this
  // restore is still reading storage — its own persistQueue() would then
  // overwrite the stored queue with only itself, leaving the restored
  // items in memory alone until the next save. This write puts them back.
  persistQueue();
}

function drainCaptures(): void {
  let drained = false;
  while (queuedCaptures.length > 0 && engineSocketOpen() && socket !== null) {
    const item = queuedCaptures.shift();
    if (item === undefined) break;
    socket.send(JSON.stringify({ type: 'captured', body: item.body, sourceRef: item.sourceRef }));
    item.ack?.({ ok: true, sent: true });
    drained = true;
    debug('captured frame sent:', item.sourceRef);
  }
  if (drained) persistQueue(); // F3: drained items leave the persisted queue too
}

/**
 * F2: the engine resets astra to 'idle' on every hello, and the worker may
 * have restarted since the last status. Replay the remembered status
 * unless it is 'idle' (which the engine already assumes).
 */
async function replayStatusAfterHello(ws: WebSocket): Promise<void> {
  const bag = await chromeApi.storage.session.get(STATUS_KEY);
  const stored = bag[STATUS_KEY];
  const replay = statusToReplayAfterHello(typeof stored === 'string' ? stored : null);
  if (replay !== null && ws === socket && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'status', status: replay }));
    lastSentStatus = replay;
    debug('status replayed after hello:', replay);
  }
}

/** M3.1 (D10): the ChatGPT tab that most recently sent us a message. */
let lastSenderTabId: number | null = null;

/** Send a frame to the engine if the socket is open. */
function sendEngineFrame(frame: unknown): boolean {
  if (socket !== null && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
    return true;
  }
  return false;
}

/**
 * M3.1: forward one deliver to the chosen tab's content script. `delivered`
 * means TYPED into the box, waiting for the user to click Send — the
 * extension never sends. Any failure is reported at once; never retried.
 */
async function deliverToChatGpt(messageId: string, text: string): Promise<void> {
  const decision = deliveryTabDecision(lastSenderTabId);
  if (!decision.ok) {
    sendEngineFrame({ type: 'failed', messageId, error: decision.error });
    return;
  }
  const tabId = decision.tabId as number;
  try {
    const response = await chromeApi.tabs.sendMessage(tabId, { type: 'type-relay-text', messageId, text }) as
      | { ok?: boolean; error?: string };
    if (response?.ok === true) {
      sendEngineFrame({ type: 'delivered', messageId });
    } else {
      sendEngineFrame({ type: 'failed', messageId, error: response?.error ?? 'the ChatGPT page refused the text' });
    }
  } catch (err) {
    sendEngineFrame({
      type: 'failed',
      messageId,
      error: `could not reach the ChatGPT tab (closed or reloaded?) — reopen chatgpt.com, then forward again: ${String(err).slice(0, 120)}`,
    });
  }
}

/** M3.1: the engine's frames to the astra adapter — so far only `deliver`. */
function handleEngineFrame(frame: unknown): void {
  const record = frame as { type?: unknown; messageId?: unknown; text?: unknown };
  if (record?.type === 'deliver') {
    if (typeof record.messageId === 'string' && typeof record.text === 'string') {
      void deliverToChatGpt(record.messageId, record.text);
    }
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
    // Per-connection timers (F3/F4): a replaced socket's close event must
    // not clear the live socket's timers, so each closes over its own handles.
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    ws.onopen = () => {
      socketOpenAt = Date.now();
      ws.send(JSON.stringify({ type: 'auth', token }));
      ws.send(JSON.stringify({ type: 'hello', name: 'astra', version: ADAPTER_VERSION }));
      lastSentStatus = null; // the engine assumes idle on hello; F2 may replay next
      console.log('[relay-astra worker] engine connection open');
      // F3: the engine can still reject the token moments after open —
      // drain only once the connection has settled, and only if still open.
      drainTimer = setTimeout(() => { drainTimer = null; drainCaptures(); }, DRAIN_SETTLE_MS);
      // F4: traffic every 20s keeps Chrome 116+ from killing the worker.
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(PING_FRAME);
      }, PING_INTERVAL_MS);
      void replayStatusAfterHello(ws); // F2
    };
    ws.onmessage = (event) => {
      let frame: unknown;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      handleEngineFrame(frame); // M3.1: the engine's deliver frames
    };
    ws.onclose = (event) => {
      if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null; }
      if (drainTimer !== null) { clearTimeout(drainTimer); drainTimer = null; }
      if (socket === ws) { socket = null; socketOpenAt = null; }
      if (event.code === 1000) {
        // B2: we closed the socket for a token change — reconnect now with
        // no 2 s wait (the fresh token is re-read per attempt). This is not
        // an auth rejection and not a replacement; it never sets authRejected.
        console.log('[relay-astra worker] token changed — reconnecting with the new one');
        void connectEngine();
        return;
      }
      if (event.code === 4401) {
        // The engine rejected the token — retrying with the same one loops forever.
        // F3: anything not yet drained stays queued (and persisted) for the
        // next successful connect after a fresh token paste.
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
  sender: unknown,
  sendResponse: (response: unknown) => void,
): boolean | void {
  // M3.1 (D10): deliveries go to the tab that most recently messaged us —
  // the conversation the relay is actually watching. S1 (M3.2a): the id
  // also goes to chrome.storage.session, so an MV3 worker restart between
  // messages does not forget the tab.
  const senderTabId = (sender as { tab?: { id?: number } } | null | undefined)?.tab?.id;
  if (typeof senderTabId === 'number' && senderTabId !== lastSenderTabId) {
    lastSenderTabId = senderTabId;
    void chromeApi.storage.session.set({ [SENDER_TAB_KEY]: senderTabId });
  }

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
    persistQueue(); // F3: the queue survives worker death
    if (drainReady()) {
      drainCaptures(); // sends and acks synchronously
      return;
    }
    void connectEngine(); // no-op while connected; reconnects when down
    return true;         // keep the sendResponse channel open for the async ack
  }
  if (frame?.type === 'status') {
    if (typeof frame.status !== 'string') {
      sendResponse({ ok: false, error: 'malformed status' });
      return;
    }
    void chromeApi.storage.session.set({ [STATUS_KEY]: frame.status }); // F2: survives worker death
    if (frame.status !== lastSentStatus && engineSocketOpen() && socket !== null) {
      socket.send(JSON.stringify({ type: 'status', status: frame.status }));
      lastSentStatus = frame.status;
      debug('status frame sent:', frame.status);
      sendResponse({ ok: true, sent: true });
    } else {
      // Not sent now; the worker replays the remembered status after the
      // next hello (F2), so the content script may treat this as handled.
      sendResponse({ ok: true, sent: false });
    }
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
    if (socket !== null) {
      // B2: close with 1000 so onclose reconnects straight away with the
      // new token — a bad paste surfaces as a 4401 rejection immediately,
      // instead of at the next idle watchdog pass.
      socket.close(1000, 'token replaced');
    } else {
      void connectEngine();
    }
  }
});

// Restore the persisted queue first (F3), then the remembered sender tab
// (S1), then connect — a capture the previous worker had queued must be in
// place before the post-hello drain, and a delivery that races the restore
// still fails visibly (no tab known) rather than silently.
void restoreQueue().then(() => {
  void restoreSenderTab().then(() => { void connectEngine(); });
});

/** S1 (M3.2a): bring back the tab id the previous worker chose. A tab that
 *  has since closed still fails visibly when messaged — storage.session
 *  lives exactly as long as the browser session, which is the tab's life. */
async function restoreSenderTab(): Promise<void> {
  const bag = await chromeApi.storage.session.get(SENDER_TAB_KEY);
  const stored = bag[SENDER_TAB_KEY];
  if (typeof stored === 'number') {
    lastSenderTabId = stored;
    debug('sender tab restored from storage.session:', stored);
  }
}
