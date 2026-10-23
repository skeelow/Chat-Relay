// Relay Chat — GUI renderer (M1.5 + M2.3): the room with the approval flow.
// Connects to the engine, auths, greets with gui_hello, renders the snapshot,
// then applies transcript_update / status_update / delivery_update frames on
// top. Any message whose id is already shown is skipped — a capture can land
// right before the snapshot, so the same message can arrive both as a live
// update and inside the snapshot; that is what makes "Restarting the app
// shows the stored transcript and no duplicates" pass.
//
// M2.3: each astra message carries a Send-to-Codex button and a status line
// driven only by the snapshot's deliveries and delivery_update — the GUI never
// guesses. All text (error text included) renders via textContent, never HTML.

import {
  applyClick,
  applyDeliveryUpdate,
  applySnapshotDeliveries,
  approveFrame,
  deliveryKey,
  deliveryStatusView,
  emptyDeliveryState,
  forwardFrame,
  pendingCount,
  rejectFrame,
  sendButton,
  targetFor,
  type DeliveryRow,
  type DeliveryUiState,
} from './deliveries.ts';

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
const pendingBadge = document.getElementById('pending');

// M2.3 + M3.1: delivery state — rows keyed messageId:target (G2), clicks
// waiting for their own update. All transitions live in deliveries.ts (pure).
let deliveryState: DeliveryUiState = emptyDeliveryState();
const messageFooters = new Map<string, { source: string; status: HTMLDivElement; actions: HTMLDivElement }>();
let engineOnline = false;

const SENDER_LABELS: Record<string, string> = { astra: 'Astra', codex: 'Codex', user: 'You' };

function engineState(label: string, on: boolean): void {
  if (engineLabel !== null) engineLabel.textContent = label;
  if (dot !== null) dot.className = on ? 'on' : 'off';
  if (engineOnline !== on) {
    engineOnline = on;
    // Going offline disables every action button; coming back re-enables them.
    for (const id of messageFooters.keys()) renderDelivery(id);
  }
}

function setPill(adapter: string, status: string): void {
  const pill = document.getElementById(`pill-${adapter}`);
  if (pill === null) return;
  pill.dataset.status = status; // raw value — the CSS keys on it (S1)
  const statusEl = pill.querySelector('.status');
  if (statusEl !== null) statusEl.textContent = status.replaceAll('_', ' ');
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
  if (targetFor(message.source) !== null) {
    // M2.3 + M3.1: every AI message carries its delivery status and actions.
    const footer = document.createElement('div');
    footer.className = 'delivery';
    const status = document.createElement('div');
    status.className = 'delivery-status';
    const actions = document.createElement('div');
    actions.className = 'delivery-actions';
    footer.append(status, actions);
    row.append(footer);
    messageFooters.set(message.id, { source: message.source, status, actions });
    renderDelivery(message.id); // a kept delivery_update may already be waiting for it
  }
  transcript.appendChild(row);
  console.log(`[relay-gui] appended ${message.id} (${message.source})`);
  transcript.scrollTop = transcript.scrollHeight;
}

/** M2.3 + M3.1: render one AI message's delivery footer from the keyed rows. */
function renderDelivery(messageId: string): void {
  const footer = messageFooters.get(messageId);
  if (footer === undefined) return;
  const target = targetFor(footer.source);
  if (target === null) return;
  const key = deliveryKey(messageId, target);
  const delivery = deliveryState.rows.get(key);
  const view = delivery === undefined
    ? { label: '', actions: [] as Array<'forward' | 'approve' | 'reject'> }
    : deliveryStatusView(delivery, target);
  footer.status.textContent = view.label; // textContent only — error text included
  footer.actions.textContent = '';
  const buttons: Array<{ action: 'forward' | 'approve' | 'reject'; label: string }> = [];
  const send = sendButton(footer.source, delivery);
  if (send.show) buttons.push({ action: 'forward', label: send.label });
  for (const action of view.actions) {
    if (action === 'approve') buttons.push({ action, label: 'Approve' });
    else if (action === 'reject') buttons.push({ action, label: 'Reject' });
    // 'forward' in the table is the failed case — sendButton shows it as Send again.
  }
  const clickPending = deliveryState.pendingClicks.has(key);
  for (const spec of buttons) {
    const button = document.createElement('button');
    button.textContent = spec.label;
    button.disabled = clickPending || !engineOnline; // one frame per click; none while offline
    button.addEventListener('click', () => {
      deliveryState = applyClick(deliveryState, key);
      sendFrameToEngine(spec.action === 'forward' ? forwardFrame(messageId, target)
        : spec.action === 'approve' ? approveFrame(messageId, target)
        : rejectFrame(messageId, target));
      console.log(`[relay-gui] ${spec.action} sent for ${messageId} → ${target}`);
      renderDelivery(messageId); // disable immediately, until the next delivery_update
    });
    footer.actions.append(button);
  }
}

/** M2.3 + M3.1: "N pending" in the header — pending_approval rows, all targets. */
function updatePendingBadge(): void {
  if (pendingBadge === null) return;
  const count = pendingCount([...deliveryState.rows.values()]);
  pendingBadge.textContent = count === 0 ? '' : `${count} pending`;
}

function sendFrameToEngine(frame: unknown): void {
  if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

function handleFrame(frame: Frame): void {
  const type = frame.type;
  if (type === 'snapshot') {
    const statuses = (frame.statuses ?? {}) as Record<string, string>;
    setPill('astra', statuses.astra ?? 'disconnected');
    setPill('codex', statuses.codex ?? 'disconnected');
    const messages = (frame.messages ?? []) as GuiMessage[];
    // M3.1: no codex filter — every delivery row seeds the state (keyed
    // messageId:target), and a snapshot clears every pending click (G1).
    deliveryState = applySnapshotDeliveries(deliveryState, (frame.deliveries ?? []) as DeliveryRow[]);
    for (const message of messages) appendMessage(message);
    for (const id of messageFooters.keys()) renderDelivery(id); // G1: re-render existing footers
    updatePendingBadge();
    console.log(`[relay-gui] snapshot: ${messages.length} messages, statuses ${JSON.stringify(statuses)}`);
    engineState('engine connected', true); // N3: the engine counts as connected only once the snapshot has arrived
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
  if (type === 'delivery_update') {
    // M2.3 + M3.1: the only source of truth for delivery state. Rows for
    // messages not on screen yet are kept and apply when the message arrives
    // later. The keyed state clears that item's pending click (G2).
    const messageId = frame.messageId;
    if (typeof messageId !== 'string' || typeof frame.status !== 'string') return;
    const update: DeliveryRow = {
      messageId,
      target: typeof frame.target === 'string' ? frame.target : 'codex',
      status: String(frame.status),
      attempts: typeof frame.attempts === 'number' ? frame.attempts : 0,
      updatedAt: typeof frame.updatedAt === 'string' ? frame.updatedAt : '',
      ...(typeof frame.error === 'string' ? { error: frame.error } : {}),
    };
    deliveryState = applyDeliveryUpdate(deliveryState, update);
    console.log(`[relay-gui] delivery ${messageId} → ${update.target}: ${update.status}`);
    renderDelivery(messageId); // no-op when the message is not on screen — the row is kept
    updatePendingBadge();
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
      // N3: no "engine connected" here — the socket being open says nothing
      // until auth is accepted and the snapshot arrives; the label stays on
      // its previous state until the snapshot handler flips it.
      ws.send(JSON.stringify({ type: 'auth', token }));
      ws.send(JSON.stringify({ type: 'gui_hello' })); // M1.5 handshake
    };
    ws.onmessage = (event) => {
      let frame: Frame;
      try { frame = JSON.parse(String(event.data)) as Frame; } catch { return; }
      handleFrame(frame);
    };
    ws.onclose = (event) => {
      if (socket === ws) socket = null;
      // N3: a rejected token gets its own message; the 2 s retry loop
      // keeps trying either way (a fresh token file is re-read per attempt).
      if (event.code === 4401) {
        engineState('token rejected — restart the engine or check %APPDATA%\\RelayChat\\token', false);
      } else {
        engineState('engine disconnected — retrying', false);
      }
      setTimeout(() => connect(), RECONNECT_MS);
    };
    ws.onerror = () => { /* onclose follows; retry handled there */ };
  });
}

connect();
