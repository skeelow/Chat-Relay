// Relay Chat — GUI renderer (M1.5): the read-only room. Connects to the
// engine, auths, greets with gui_hello, renders the snapshot, then applies
// transcript_update / status_update frames on top. Any message whose id is
// already shown is skipped — a capture can land right before the snapshot,
// so the same message can arrive both as a live update and inside the
// snapshot; that is what makes "Restarting the app shows the stored
// transcript and no duplicates" pass.

const ENGINE_URL = 'ws://127.0.0.1:8787';
const RECONNECT_MS = 2000;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

interface GuiMessage {
  id: string;
  source: 'user' | 'astra' | 'codex';
  targets: string[];
  body: string;
  contentHash: string;
  sourceRef?: string;
  hop: number;
  createdAt: string;
}

interface Frame { [key: string]: unknown; }

interface PreloadApi { getToken(): Promise<string | null>; }
const preload = (window as unknown as { relay?: PreloadApi }).relay;

const shown = new Set<string>(); // message ids already on screen
const transcript = document.getElementById('transcript');
const dot = document.getElementById('dot');
const engineLabel = document.getElementById('engine-label');

const SENDER_LABELS: Record<string, string> = { astra: 'Astra', codex: 'Codex', user: 'You' };

function engineState(label: string, on: boolean): void {
  if (engineLabel !== null) engineLabel.textContent = label;
  if (dot !== null) dot.className = on ? 'on' : 'off';
}

function setPill(adapter: string, status: string): void {
  const pill = document.getElementById(`pill-${adapter}`);
  if (pill === null) return;
  pill.dataset.status = status;
  const statusEl = pill.querySelector('.status');
  if (statusEl !== null) statusEl.textContent = status.replace('_', ' ');
  console.log(`[relay-gui] pill ${adapter}: ${status}`);
}

function appendMessage(message: GuiMessage): void {
  if (transcript === null) return;
  if (shown.has(message.id)) {
    console.log(`[relay-gui] skipped duplicate ${message.id}`);
    return; // already on screen — no duplicates, ever (M1.5 acceptance)
  }
  shown.add(message.id);
  const row = document.createElement('div');
  row.className = `msg ${message.source}`;
  const sender = document.createElement('div');
  sender.className = 'sender';
  sender.textContent = SENDER_LABELS[message.source] ?? message.source;
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = message.body; // relayed text is data, never HTML
  row.append(sender, body);
  transcript.appendChild(row);
  console.log(`[relay-gui] appended ${message.id} (${message.source})`);
  transcript.scrollTop = transcript.scrollHeight;
}

function handleFrame(frame: Frame): void {
  const type = frame.type;
  if (type === 'snapshot') {
    const statuses = (frame.statuses ?? {}) as Record<string, string>;
    setPill('astra', statuses.astra ?? 'disconnected');
    setPill('codex', statuses.codex ?? 'disconnected');
    const messages = (frame.messages ?? []) as GuiMessage[];
    for (const message of messages) appendMessage(message);
    console.log(`[relay-gui] snapshot: ${messages.length} messages, statuses ${JSON.stringify(statuses)}`);
    return;
  }
  if (type === 'transcript_update') {
    appendMessage(frame.message as GuiMessage);
    return;
  }
  if (type === 'status_update') {
    setPill(String(frame.adapter), String(frame.status));
    return;
  }
}

let socket: WebSocket | null = null;

function connect(): void {
  if (preload === undefined) {
    engineState('no preload bridge — run via the Electron app', false);
    return;
  }
  void preload.getToken().then((token) => {
    if (token === null || !TOKEN_PATTERN.test(token)) {
      engineState('no token yet — start the engine', false);
      setTimeout(() => connect(), RECONNECT_MS);
      return;
    }
    const ws = new WebSocket(ENGINE_URL);
    socket = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
      ws.send(JSON.stringify({ type: 'gui_hello' })); // M1.5 handshake
      engineState('engine connected', true);
    };
    ws.onmessage = (event) => {
      let frame: Frame;
      try { frame = JSON.parse(String(event.data)) as Frame; } catch { return; }
      handleFrame(frame);
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      engineState('engine disconnected — retrying', false);
      setTimeout(() => connect(), RECONNECT_MS);
    };
    ws.onerror = () => { /* onclose follows; retry handled there */ };
  });
}

connect();
