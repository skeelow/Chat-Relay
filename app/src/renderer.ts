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
  approvalAnswerFrame,
  approvalCard,
  approvalsBadgeText,
  applyApprovalClick,
  applyApprovalDismiss,
  applyApprovalRequest,
  applyApprovalResolved,
  applySnapshotApprovals,
  emptyApprovalsState,
  visibleApprovals,
  type ApprovalView,
} from './approvals.ts';
import {
  applyClick,
  applyDeliveryUpdate,
  applySnapshotDeliveries,
  approveDisabledTitle,
  approveFrame,
  deliveryKey,
  deliveryStatusView,
  emptyDeliveryState,
  forwardFrame,
  pauseBannerText,
  pendingCount,
  rejectFrame,
  resumeFrame,
  sendButton,
  stopButtonLabel,
  stopFrame,
  targetFor,
  userFooterTargets,
  type DeliveryRow,
  type DeliveryUiState,
} from './deliveries.ts';
import { parseCompose } from './compose.ts';

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
const stopButton = document.getElementById('stop') as HTMLButtonElement | null;
const pauseBanner = document.getElementById('banner');
const approvalsArea = document.getElementById('approvals');
const approvalsBadge = document.getElementById('approvals-badge');
const composeText = document.getElementById('compose-text') as HTMLTextAreaElement | null;
const composeTarget = document.getElementById('compose-target') as HTMLSelectElement | null;
const composeSend = document.getElementById('compose-send') as HTMLButtonElement | null;

// M2.3 + M3.1: delivery state — rows keyed messageId:target (G2), clicks
// waiting for their own update. All transitions live in deliveries.ts (pure).
let deliveryState: DeliveryUiState = emptyDeliveryState();
const messageFooters = new Map<string, { source: string; status: HTMLDivElement; actions: HTMLDivElement }>();
let engineOnline = false;
// M3.2b: the stopped state — only snapshot.paused and pause_update change it.
let paused = false;
// M3.3: the codex approval cards — only snapshot.approvals,
// approval_request and approval_resolved change the list.
let approvalState = emptyApprovalsState();

const SENDER_LABELS: Record<string, string> = { astra: 'Astra', codex: 'Codex', user: 'You' };

function engineState(label: string, on: boolean): void {
  if (engineLabel !== null) engineLabel.textContent = label;
  if (dot !== null) dot.className = on ? 'on' : 'off';
  if (stopButton !== null) stopButton.disabled = !on; // M3.2b: Stop/Resume needs the engine
  if (composeText !== null) composeText.disabled = !on; // M4.1: the compose area needs the engine
  if (composeTarget !== null) composeTarget.disabled = !on;
  if (composeSend !== null) composeSend.disabled = !on;
  if (engineOnline !== on) {
    engineOnline = on;
    // Going offline disables every action button; coming back re-enables them.
    for (const id of messageFooters.keys()) renderDelivery(id);
    renderApprovals(); // M3.3: the approval cards' buttons follow the engine link
  }
}

/** M3.2b: banner, Stop/Resume label and Approve enable/disable from the server state. */
function setPausedUi(): void {
  const bannerText = pauseBannerText(paused);
  if (pauseBanner !== null) {
    pauseBanner.textContent = bannerText ?? '';
    pauseBanner.hidden = bannerText === null;
  }
  if (stopButton !== null) stopButton.textContent = stopButtonLabel(paused);
  for (const id of messageFooters.keys()) renderDelivery(id); // Approve follows the state
  console.log(`[relay-gui] pause state: ${paused ? 'stopped' : 'running'}`);
}

/** M3.3: the header badge — "N approvals waiting" is hard to miss. */
function updateApprovalsBadge(): void {
  if (approvalsBadge !== null) {
    approvalsBadge.textContent = approvalsBadgeText(visibleApprovals(approvalState).length);
  }
}

/** M4.1 (N4): the local Dismiss on a card the relay cannot answer. Purely
 *  GUI-side — it never talks to the engine, so it stays clickable. */
function appendDismissButton(actions: HTMLElement, requestId: string): void {
  const button = document.createElement('button');
  button.textContent = 'Dismiss';
  button.addEventListener('click', () => {
    approvalState = applyApprovalDismiss(approvalState, requestId);
    console.log(`[relay-gui] approval card ${requestId} dismissed locally`);
    renderApprovals();
  });
  actions.append(button);
}

/** M3.3: rebuild the approval banner cards from the server state (textContent only). */
function renderApprovals(): void {
  updateApprovalsBadge();
  if (approvalsArea === null) return;
  approvalsArea.textContent = '';
  const visible = visibleApprovals(approvalState);
  for (const view of visible) {
    const card = approvalCard(view);
    const box = document.createElement('div');
    box.className = 'approval-card';
    const title = document.createElement('div');
    title.className = 'approval-title';
    title.textContent = card.title;
    box.append(title);
    if (card.body !== '') {
      const body = document.createElement('div');
      body.className = 'approval-body';
      body.textContent = card.body;
      box.append(body);
    }
    if (card.actions.length > 0) {
      const actions = document.createElement('div');
      actions.className = 'approval-actions';
      const clickPending = approvalState.pendingClicks.has(view.requestId);
      for (const action of card.actions) {
        const button = document.createElement('button');
        button.textContent = action === 'approve_once' ? 'Approve once' : 'Decline';
        button.disabled = clickPending || !engineOnline; // one frame per click; none while offline
        button.addEventListener('click', () => {
          approvalState = applyApprovalClick(approvalState, view.requestId);
          sendFrameToEngine(approvalAnswerFrame(view.requestId, action === 'approve_once' ? 'accept' : 'decline'));
          console.log(`[relay-gui] approval ${view.requestId}: ${action === 'approve_once' ? 'accept' : 'decline'} sent`);
          renderApprovals(); // disable immediately, until approval_resolved
        });
        actions.append(button);
      }
      box.append(actions);
    } else {
      // M4.1 (N4): a card the relay cannot answer can at least be hidden.
      const actions = document.createElement('div');
      actions.className = 'approval-actions';
      appendDismissButton(actions, view.requestId);
      box.append(actions);
    }
    approvalsArea.append(box);
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
  // M2.3 + M3.1: every AI message carries its delivery status and actions.
  // M4.1: user messages carry a footer too — one line per target.
  if (targetFor(message.source) !== null || message.source === 'user') {
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

/** One action button: the pending-click lock, the offline lock, and the
 *  Approve-while-stopped title. Shared by the AI and user footers. */
function appendActionButton(
  container: HTMLElement,
  spec: { action: 'forward' | 'approve' | 'reject'; label: string },
  messageId: string,
  target: 'codex' | 'astra',
): void {
  const key = deliveryKey(messageId, target);
  const clickPending = deliveryState.pendingClicks.has(key);
  // M3.2b: while stopped, Approve is disabled with a title explaining why.
  // Forward and Reject still work — creating or cancelling a pending item is
  // not a delivery.
  const approveTitle = spec.action === 'approve' ? approveDisabledTitle(paused) : null;
  const button = document.createElement('button');
  button.textContent = spec.label;
  if (approveTitle !== null) {
    button.disabled = true;
    button.title = approveTitle;
  } else {
    button.disabled = clickPending || !engineOnline; // one frame per click; none while offline
    button.removeAttribute('title');
  }
  button.addEventListener('click', () => {
    deliveryState = applyClick(deliveryState, key);
    sendFrameToEngine(spec.action === 'forward' ? forwardFrame(messageId, target)
      : spec.action === 'approve' ? approveFrame(messageId, target)
      : rejectFrame(messageId, target));
    console.log(`[relay-gui] ${spec.action} sent for ${messageId} → ${target}`);
    renderDelivery(messageId); // disable immediately, until the next delivery_update
  });
  container.append(button);
}

/** M2.3 + M3.1 + M4.1: render one message's delivery footer. AI messages keep
 *  their single footer; a user message shows one line per target. */
function renderDelivery(messageId: string): void {
  const footer = messageFooters.get(messageId);
  if (footer === undefined) return;
  footer.status.textContent = '';
  footer.actions.textContent = '';
  if (footer.source === 'user') {
    // M4.1: one footer line per target the message has rows for, with the
    // existing status labels — Approve/Reject while pending, Send again on
    // failure (the existing forward flow).
    for (const target of userFooterTargets(messageId, [...deliveryState.rows.values()])) {
      const delivery = deliveryState.rows.get(deliveryKey(messageId, target));
      if (delivery === undefined) continue;
      const view = deliveryStatusView(delivery, target);
      const line = document.createElement('div');
      line.className = 'delivery-line';
      const status = document.createElement('span');
      status.className = 'line-status';
      status.textContent = view.label; // textContent only — error text included
      line.append(status);
      const actions = document.createElement('span');
      actions.className = 'line-actions';
      line.append(actions);
      footer.actions.append(line);
      for (const action of view.actions) {
        appendActionButton(actions, {
          action,
          label: action === 'approve' ? 'Approve' : action === 'reject' ? 'Reject' : 'Send again',
        }, messageId, target);
      }
    }
    return;
  }
  const target = targetFor(footer.source);
  if (target === null) return;
  const key = deliveryKey(messageId, target);
  const delivery = deliveryState.rows.get(key);
  const view = delivery === undefined
    ? { label: '', actions: [] as Array<'forward' | 'approve' | 'reject'> }
    : deliveryStatusView(delivery, target);
  footer.status.textContent = view.label; // textContent only — error text included
  const buttons: Array<{ action: 'forward' | 'approve' | 'reject'; label: string }> = [];
  const send = sendButton(footer.source, delivery);
  if (send.show) buttons.push({ action: 'forward', label: send.label });
  for (const action of view.actions) {
    if (action === 'approve') buttons.push({ action, label: 'Approve' });
    else if (action === 'reject') buttons.push({ action, label: 'Reject' });
    // 'forward' in the table is the failed case — sendButton shows it as Send again.
  }
  for (const spec of buttons) appendActionButton(footer.actions, spec, messageId, target);
}

/** M2.3 + M3.1: "N pending" in the header — pending_approval rows, all targets. */
function updatePendingBadge(): void {
  if (pendingBadge === null) return;
  const count = pendingCount([...deliveryState.rows.values()]);
  pendingBadge.textContent = count === 0 ? '' : `${count} pending`;
}

/** Send one frame if the engine link is up; report whether it went out (M4.1:
 *  the compose box clears only when it did). */
function sendFrameToEngine(frame: unknown): boolean {
  if (socket !== null && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
    return true;
  }
  return false;
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
    // M3.2b: the stopped state arrives with the catch-up.
    paused = frame.paused === true;
    setPausedUi();
    // M3.3: the pending approvals replace the list.
    approvalState = applySnapshotApprovals(approvalState, (frame.approvals ?? []) as ApprovalView[]);
    renderApprovals();
    console.log(`[relay-gui] snapshot: ${messages.length} messages, statuses ${JSON.stringify(statuses)}`);
    engineState('engine connected', true); // N3: the engine counts as connected only once the snapshot has arrived
    return;
  }
  if (type === 'pause_update') {
    // M3.2b: the only other source of the stopped state.
    paused = frame.paused === true;
    setPausedUi();
    return;
  }
  if (type === 'approval_request') {
    // M3.3: one new banner card from the codex adapter, via the engine.
    const requestId = frame.requestId;
    if (typeof requestId !== 'string') return;
    const view: ApprovalView = {
      requestId,
      kind: typeof frame.kind === 'string' ? frame.kind : 'other',
      summary: typeof frame.summary === 'string' ? frame.summary : '',
      method: typeof frame.method === 'string' ? frame.method : '',
    };
    approvalState = applyApprovalRequest(approvalState, view);
    console.log(`[relay-gui] approval request ${requestId} (${view.kind})`);
    renderApprovals();
    return;
  }
  if (type === 'approval_resolved') {
    // M3.3: the card is gone — answered, lost with the adapter, or Stop.
    const requestId = frame.requestId;
    if (typeof requestId !== 'string') return;
    approvalState = applyApprovalResolved(approvalState, requestId);
    console.log(`[relay-gui] approval ${requestId} resolved: ${String(frame.decision)}`);
    renderApprovals();
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

// M3.2b: the Stop/Resume button sends the frame; the label and banner follow
// the server's pause_update only. Both frames are idempotent engine-side, so
// a double-click while a round-trip is in flight is harmless.
if (stopButton !== null) {
  stopButton.textContent = stopButtonLabel(paused);
  stopButton.disabled = true; // until the engine connects
  stopButton.addEventListener('click', () => {
    sendFrameToEngine(paused ? resumeFrame() : stopFrame());
    console.log(`[relay-gui] ${paused ? 'resume' : 'stop'} sent`);
  });
}

// M4.1: the compose area — parseCompose decides the target (@-prefix wins)
// and the trimmed body; Enter sends, Shift+Enter is a newline. The text is
// kept whenever the frame could not go out.
function submitCompose(): void {
  if (composeText === null || composeTarget === null) return;
  const parsed = parseCompose(composeText.value, composeTarget.value);
  if (!parsed.ok) {
    console.log(`[relay-gui] compose refused: ${parsed.reason} — text kept`);
    return;
  }
  const wentOut = sendFrameToEngine({ type: 'send', body: parsed.body, targets: parsed.targets });
  if (wentOut) {
    composeText.value = '';
    console.log(`[relay-gui] sent to ${parsed.targets.join(' + ')}: ${parsed.body.slice(0, 60)}`);
  } else {
    console.log('[relay-gui] send could not go out — engine link down, text kept');
  }
}

if (composeText !== null) {
  composeText.disabled = true; // until the engine connects
  composeText.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault(); // Enter sends; Shift+Enter keeps the newline
      submitCompose();
    }
  });
}
if (composeTarget !== null) composeTarget.disabled = true;
if (composeSend !== null) {
  composeSend.disabled = true;
  composeSend.addEventListener('click', submitCompose);
}

connect();
