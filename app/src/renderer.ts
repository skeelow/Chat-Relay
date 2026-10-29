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
  sendButtons,
  stopButtonLabel,
  stopFrame,
  userFooterTargets,
  type DeliveryRow,
  type DeliveryUiState,
} from './deliveries.ts';
import { parseCompose, type Target } from './compose.ts';
import { hermesModeBadge, hermesStatusLabel } from './hermes.ts';
import {
  applySearchResult, closeSearch, emptySearchState, exportFrame, isSearchQueryValid,
  searchFrame, startSearch, type SearchState,
} from './search.ts';
import {
  delayToSeconds, isDelayValid, isTurnCapValid, modeLabel, setModeFrame, settingsControls,
  type RelaySettings,
} from './settings.ts';
import {
  applyCountdownFrame, autoSendControlsEnabled, countdownHeaderText, emptyCountdownState,
  heldNotice, heldNoticeHelp, pendingDecision, tickCountdowns, type CountdownState,
} from './countdown.ts';
import { summaryLine, type SessionSummary } from './summary.ts';

const ENGINE_URL = 'ws://127.0.0.1:8787';
const RECONNECT_MS = 2000;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

interface GuiMessage {
  id: string;
  source: 'user' | 'astra' | 'codex' | 'hermes';
  targets: string[];
  body: string;
  contentHash: string;
  sourceRef?: string;
  hop: number;
  createdAt: string;
}

interface Frame { [key: string]: unknown; }

interface PreloadApi {
  getToken(): Promise<string | null>;
  /** M4.3 (D17-3): the one narrow file API — the export save dialog. */
  saveExport(markdown: string): Promise<string | null>;
  /** M4.3 (D17-4): the tray tooltip counts, reported as the state changes. */
  reportTrayCounts(pending: number, approvals: number): void;
}
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
const settingsButton = document.getElementById('settings-btn') as HTMLButtonElement | null;
const settingsPanel = document.getElementById('settings');
const settingsHint = document.getElementById('settings-hint');
const modeLabelEl = document.getElementById('mode-label');
const modeManualInput = document.getElementById('mode-manual') as HTMLInputElement | null;
const hermesModeChip = document.getElementById('hermes-mode');
const modeApproveInput = document.getElementById('mode-approve-each') as HTMLInputElement | null;
const modeAutoInput = document.getElementById('mode-auto') as HTMLInputElement | null;
const turnCapInput = document.getElementById('turn-cap') as HTMLInputElement | null;
const autoSendInput = document.getElementById('auto-send') as HTMLInputElement | null;
const autoSendDelayInput = document.getElementById('auto-send-delay') as HTMLInputElement | null;
const autoSendUnitInput = document.getElementById('auto-send-unit') as HTMLSelectElement | null;
const searchButton = document.getElementById('search-btn') as HTMLButtonElement | null;
const searchPanel = document.getElementById('search');
const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
const searchResults = document.getElementById('search-results');
const searchTotal = document.getElementById('search-total');
const exportButton = document.getElementById('export-btn') as HTMLButtonElement | null;
const exportNote = document.getElementById('export-note');
const countdownCountEl = document.getElementById('countdown-count');
const sessionSummaryEl = document.getElementById('session-summary');

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
// M4.2: the relay settings — only snapshot.settings and settings_update.
let relaySettings: RelaySettings | null = null;
// M4.3: the search panel — the engine answers, the pure state machine in
// search.ts decides what is current (a new query supersedes an older one).
let searchState: SearchState = emptySearchState();
// M4.3: the export in flight, matched by requestId when it comes back.
let pendingExport: string | null = null;
// M5.1: the auto-send countdowns (server-announced only) and the turn-cap
// holds shown as notices. The seconds tick locally; the server's null clears.
let countdownState: CountdownState = emptyCountdownState();
const heldNotices = new Map<string, { hop: number; cap: number }>();
// M5.2: the session summary — server-fed only; the line is live-view only.
let sessionSummary: SessionSummary | null = null;

/** M5.2: the pinned session line, built only from the server's summary. */
function renderSessionSummary(): void {
  if (sessionSummaryEl === null) return;
  const line = summaryLine(sessionSummary);
  if (line === null) {
    sessionSummaryEl.textContent = '';
    sessionSummaryEl.classList.remove('attention');
    return;
  }
  sessionSummaryEl.textContent = line.text;
  sessionSummaryEl.classList.toggle('attention', line.approvalsEmphasised);
}

const SENDER_LABELS: Record<string, string> = { astra: 'Astra', codex: 'Codex', hermes: 'Hermes', user: 'You' };

function engineState(label: string, on: boolean): void {
  if (engineLabel !== null) engineLabel.textContent = label;
  if (dot !== null) dot.className = on ? 'on' : 'off';
  if (stopButton !== null) stopButton.disabled = !on; // M3.2b: Stop/Resume needs the engine
  if (composeText !== null) composeText.disabled = !on; // M4.1: the compose area needs the engine
  if (composeTarget !== null) composeTarget.disabled = !on;
  if (composeSend !== null) composeSend.disabled = !on;
  if (settingsButton !== null) settingsButton.disabled = !on; // M4.2: the settings panel too
  if (searchButton !== null) searchButton.disabled = !on; // M4.3: search needs the engine
  if (searchInput !== null) searchInput.disabled = !on;
  if (exportButton !== null) exportButton.disabled = !on; // M4.3: so does export
  if (modeManualInput !== null) modeManualInput.disabled = !on;
  if (modeApproveInput !== null) modeApproveInput.disabled = !on;
  if (modeAutoInput !== null) modeAutoInput.disabled = !on;
  if (turnCapInput !== null) turnCapInput.disabled = !on;
  if (autoSendInput !== null) autoSendInput.disabled = !on;
  if (autoSendDelayInput !== null) autoSendDelayInput.disabled = !on;
  if (autoSendUnitInput !== null) autoSendUnitInput.disabled = !on;
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
  reportTray(); // M4.3: the tray tooltip rides every count change
}

/** M4.2: apply the server's settings to the panel — the only writer of the
 *  controls. A user's click sends a frame and waits; the update snaps the
 *  control to the server's truth. */
function renderSettings(): void {
  if (relaySettings === null) return;
  const controls = settingsControls(relaySettings);
  if (modeManualInput !== null) modeManualInput.checked = controls.mode === 'manual';
  if (modeApproveInput !== null) modeApproveInput.checked = controls.mode === 'approve_each';
  if (modeAutoInput !== null) modeAutoInput.checked = controls.mode === 'auto';
  if (turnCapInput !== null) turnCapInput.value = controls.turnCap;
  // M5.1 (D18 GUI): the auto-send controls live only in Auto mode.
  const autoUsable = autoSendControlsEnabled(relaySettings.mode) && engineOnline;
  if (autoSendInput !== null) autoSendInput.disabled = !autoUsable;
  if (autoSendDelayInput !== null) autoSendDelayInput.disabled = !autoUsable;
  if (autoSendUnitInput !== null) autoSendUnitInput.disabled = !autoUsable;
  if (autoSendInput !== null) autoSendInput.checked = controls.autoSend;
  if (autoSendDelayInput !== null) autoSendDelayInput.value = String(controls.delay.value);
  if (autoSendUnitInput !== null) autoSendUnitInput.value = controls.delay.unit;
  if (modeLabelEl !== null) modeLabelEl.textContent = `Mode: ${modeLabel(relaySettings.mode)}`;
  if (settingsHint !== null) settingsHint.textContent = '';
  console.log(`[relay-gui] settings: ${JSON.stringify(relaySettings)}`);
}

/** M4.3: the search panel over the transcript — sender, time and a snippet
 *  per hit. Clicking a hit scrolls to the message if it is loaded, else
 *  the full text unfolds right here in the panel. */
function renderSearchPanel(): void {
  if (searchPanel !== null) searchPanel.hidden = !searchState.open;
  if (searchResults === null) return;
  searchResults.textContent = '';
  if (searchTotal !== null) searchTotal.textContent = '';
  if (!searchState.open) return;
  if (searchTotal !== null) {
    searchTotal.textContent = searchState.total > searchState.results.length
      ? `${searchState.results.length} of ${searchState.total} matches (newest first)`
      : `${searchState.results.length} ${searchState.results.length === 1 ? 'match' : 'matches'} (newest first)`;
  }
  for (const hit of searchState.results) {
    const item = document.createElement('div');
    item.className = 'search-hit';
    const meta = document.createElement('div');
    meta.className = 'search-hit-meta';
    meta.textContent = `${SENDER_LABELS[hit.source] ?? hit.source} — ${hit.createdAt}`;
    const snippet = document.createElement('div');
    snippet.className = 'search-hit-snippet';
    snippet.textContent = hit.snippet;
    item.append(meta, snippet);
    item.addEventListener('click', () => {
      const loaded = document.getElementById(hit.id);
      if (loaded !== null) {
        loaded.scrollIntoView({ block: 'center' });
        loaded.classList.add('found');
        setTimeout(() => loaded.classList.remove('found'), 1200);
        return;
      }
      // Older than the snapshot window: show the full text in the panel.
      const existing = item.querySelector('.search-hit-full');
      if (existing !== null) { existing.remove(); return; }
      const full = document.createElement('div');
      full.className = 'search-hit-full';
      full.textContent = hit.body;
      item.append(full);
    });
    searchResults.append(item);
  }
}

/** M4.3 (D17-4): the tray tooltip follows the GUI state — the renderer owns
 *  the counts, the main process owns the tray. Reported on every change to
 *  either list. */
function reportTray(): void {
  const pending = pendingCount([...deliveryState.rows.values()]);
  const approvals = visibleApprovals(approvalState).length;
  preload?.reportTrayCounts(pending, approvals);
}

/** M5.1: the header's "N countdowns running" count. */
function updateCountdownHeader(): void {
  if (countdownCountEl === null) return;
  const running = Object.keys(countdownState.secondsLeft).length;
  countdownCountEl.textContent = countdownHeaderText(running);
}

/** M5.1: re-render every footer a running countdown touches (a frame arrived
 *  or a local second passed). */
function renderCountdownFooters(): void {
  for (const key of Object.keys(countdownState.secondsLeft)) {
    const messageId = key.slice(0, key.lastIndexOf(':'));
    renderDelivery(messageId);
  }
  updateCountdownHeader();
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
  if (statusEl !== null) {
    statusEl.textContent = adapter === 'hermes'
      ? hermesStatusLabel(status)
      : status.replaceAll('_', ' ');
  }
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
  row.id = message.id; // M4.3: search results scroll to it by id
  const sender = document.createElement('div');
  sender.className = 'sender';
  sender.textContent = SENDER_LABELS[message.source] ?? message.source;
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = message.body; // relayed text is data, never HTML
  row.append(sender, body);
  // M2.3 + M3.1: every AI message carries its delivery status and actions.
  // M4.1: user messages carry a footer too — one line per target.
  if (message.source === 'user' || message.source === 'astra' || message.source === 'codex' || message.source === 'hermes') {
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
  target: Target,
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
  const source = footer.source as Target;
  const rowsForThisMessage = [...deliveryState.rows.values()].filter(
    (row) => row.messageId === messageId,
  );
  const entries = sendButtons(source, rowsForThisMessage);
  for (const entry of entries) {
    const target = entry.target;
    const key = deliveryKey(messageId, target);
    const delivery = deliveryState.rows.get(key);
    const view = delivery === undefined
      ? { label: '', actions: [] as Array<'forward' | 'approve' | 'reject'> }
      : deliveryStatusView(delivery, target);
    // Nothing to show for this target: no send button and no actions.
    if (!entry.show && view.actions.length === 0) continue;

    const line = document.createElement('div');
    line.className = 'delivery-line';

    // Status label: held notice (never on Hermes per D29), then view label.
    const held = heldNotices.get(messageId);
    let label = view.label;
    if (held !== undefined && target !== 'hermes') {
      label = `${heldNotice(held.cap, SENDER_LABELS[target] ?? target)} ${heldNoticeHelp()}`;
    }
    // M5.1 (D18 GUI): while a countdown runs on a pending item, labels read
    // Sending in Ns / Send now / Cancel. D29: no countdown on a Hermes line.
    const countdownSeconds = countdownState.secondsLeft[key];
    const hasCountdown =
      countdownSeconds !== undefined && view.actions.includes('approve') && target !== 'hermes';
    const decision = pendingDecision(hasCountdown, countdownSeconds ?? 0);
    if (hasCountdown) {
      label = decision.label;
    }

    const status = document.createElement('span');
    status.className = 'line-status';
    status.textContent = label; // textContent only — error text included
    line.append(status);

    const actions = document.createElement('span');
    actions.className = 'line-actions';

    // Forward button: Send to X / Send again (from sendButtons).
    if (entry.show) {
      appendActionButton(actions, { action: 'forward', label: entry.label }, messageId, target);
    }

    // Approve/Reject buttons for pending rows.
    for (const action of view.actions) {
      if (action === 'approve') {
        appendActionButton(actions, {
          action,
          label: hasCountdown ? decision.approveLabel : 'Approve',
        }, messageId, target);
      } else if (action === 'reject') {
        appendActionButton(actions, {
          action,
          label: hasCountdown ? decision.rejectLabel : 'Reject',
        }, messageId, target);
      }
      // 'forward' in the table is the failed case — sendButtons shows it as Send again.
    }

    line.append(actions);
    footer.actions.append(line);
  }
}

/** M2.3 + M3.1: "N pending" in the header — pending_approval rows, all targets. */
function updatePendingBadge(): void {
  if (pendingBadge === null) return;
  const count = pendingCount([...deliveryState.rows.values()]);
  pendingBadge.textContent = count === 0 ? '' : `${count} pending`;
  reportTray(); // M4.3: the tray tooltip rides every count change
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
    setPill('hermes', statuses.hermes ?? 'disconnected');
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
    // M4.2: the settings arrive with the catch-up.
    relaySettings = (frame.settings ?? null) as RelaySettings | null;
    renderSettings();
    // M5.1: any running countdowns (with the seconds left) and holds ride
    // along, so a joining GUI shows them at once.
    if (Array.isArray(frame.countdowns)) {
      countdownState = emptyCountdownState();
      for (const entry of frame.countdowns as Array<{ messageId?: unknown; target?: unknown; secondsLeft?: unknown }>) {
        countdownState = applyCountdownFrame(countdownState, {
          messageId: entry.messageId, target: entry.target, seconds: entry.secondsLeft,
        });
      }
    }
    if (Array.isArray(frame.held)) {
      heldNotices.clear();
      for (const entry of frame.held as Array<{ messageId?: unknown; hop?: unknown; cap?: unknown }>) {
        if (typeof entry.messageId === 'string') {
          heldNotices.set(entry.messageId, {
            hop: typeof entry.hop === 'number' ? entry.hop : 0,
            cap: typeof entry.cap === 'number' ? entry.cap : 0,
          });
        }
      }
    }
    renderCountdownFooters();
    for (const messageId of heldNotices.keys()) renderDelivery(messageId);
    // M5.2: the session line rides along with the catch-up.
    if (frame.summary !== undefined && frame.summary !== null) {
      const summary = frame.summary as { turnsUsed?: unknown; held?: unknown; approvalsPending?: unknown; since?: unknown };
      sessionSummary = {
        turnsUsed: typeof summary.turnsUsed === 'number' ? summary.turnsUsed : 0,
        held: typeof summary.held === 'number' ? summary.held : 0,
        approvalsPending: typeof summary.approvalsPending === 'number' ? summary.approvalsPending : 0,
        since: typeof summary.since === 'string' ? summary.since : '',
      };
      renderSessionSummary();
    }
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
  if (type === 'settings_update') {
    // M4.2 + M5.1: the server's settings are the panel's only truth —
    // manual, approve_each or auto.
    relaySettings = {
      mode: frame.mode === 'approve_each' ? 'approve_each' : frame.mode === 'auto' ? 'auto' : 'manual',
      turnCap: typeof frame.turnCap === 'number' ? frame.turnCap : 4,
      autoSend: frame.autoSend === true,
      autoSendDelaySec: typeof frame.autoSendDelaySec === 'number' ? frame.autoSendDelaySec : 10,
    };
    renderSettings();
    return;
  }
  if (type === 'search_result') {
    // M4.3: the pure state machine drops stale requestIds; a live one
    // re-renders the panel.
    const next = applySearchResult(searchState, frame);
    if (next !== null) {
      searchState = next;
      renderSearchPanel();
      console.log(`[relay-gui] search results: ${next.results.length} of ${next.total}`);
    }
    return;
  }
  if (type === 'export_result') {
    // M4.3: hand the finished Markdown to the save dialog — the one narrow
    // file API — and show where it landed.
    if (typeof frame.requestId === 'string' && frame.requestId === pendingExport) {
      const markdown = typeof frame.markdown === 'string' ? frame.markdown : '';
      const count = typeof frame.messageCount === 'number' ? frame.messageCount : 0;
      pendingExport = null;
      void Promise.resolve(preload?.saveExport(markdown)).then((path) => {
        if (exportNote !== null) {
          exportNote.textContent = path === null || path === undefined
            ? 'Export cancelled'
            : `Saved ${count} messages: ${path}`;
        }
        console.log(`[relay-gui] export ${path === null || path === undefined ? 'cancelled' : `saved to ${path}`}`);
      });
    }
    return;
  }
  if (type === 'countdown') {
    // M5.1: the server announces every start (seconds = the delay) and every
    // end or cancel (seconds = null). Nothing is shown the server has not
    // announced; the visible seconds tick locally.
    countdownState = applyCountdownFrame(countdownState, frame);
    renderDelivery(String(frame.messageId ?? ''));
    renderCountdownFooters();
    console.log(`[relay-gui] countdown: ${JSON.stringify(frame)}`);
    return;
  }
  if (type === 'routing_held') {
    // M5.1: the turn cap held this message — a notice on its footer; the
    // manual Send button still works.
    if (typeof frame.messageId === 'string') {
      heldNotices.set(frame.messageId, {
        hop: typeof frame.hop === 'number' ? frame.hop : 0,
        cap: typeof frame.cap === 'number' ? frame.cap : 0,
      });
      renderDelivery(frame.messageId);
    }
    console.log(`[relay-gui] routing held: ${JSON.stringify(frame)}`);
    return;
  }
  if (type === 'session_summary') {
    // M5.2: the three live numbers; the line is built purely from them.
    sessionSummary = {
      turnsUsed: typeof frame.turnsUsed === 'number' ? frame.turnsUsed : 0,
      held: typeof frame.held === 'number' ? frame.held : 0,
      approvalsPending: typeof frame.approvalsPending === 'number' ? frame.approvalsPending : 0,
      since: typeof frame.since === 'string' ? frame.since : '',
    };
    renderSessionSummary();
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

// M4.2: the settings panel — server-driven controls; a change sends set_mode
// and the panel updates only when settings_update comes back. Invalid input
// is never sent; an inline hint explains instead.
if (settingsButton !== null) {
  settingsButton.disabled = true; // until the engine connects
  settingsButton.addEventListener('click', () => {
    if (settingsPanel !== null) settingsPanel.hidden = !settingsPanel.hidden;
  });
}
if (modeManualInput !== null) {
  modeManualInput.disabled = true;
  modeManualInput.addEventListener('change', () => {
    if (modeManualInput.checked) sendFrameToEngine(setModeFrame({ mode: 'manual' }));
  });
}
if (modeApproveInput !== null) {
  modeApproveInput.disabled = true;
  modeApproveInput.addEventListener('change', () => {
    if (modeApproveInput.checked) sendFrameToEngine(setModeFrame({ mode: 'approve_each' }));
  });
}
if (modeAutoInput !== null) {
  // M5.1 (D18-1): Auto is selectable now — same frame, same validation.
  modeAutoInput.disabled = true;
  modeAutoInput.addEventListener('change', () => {
    if (modeAutoInput.checked) sendFrameToEngine(setModeFrame({ mode: 'auto' }));
  });
}
if (turnCapInput !== null) {
  turnCapInput.disabled = true;
  turnCapInput.addEventListener('change', () => {
    const value = Number(turnCapInput.value);
    if (!isTurnCapValid(value)) {
      if (settingsHint !== null) settingsHint.textContent = 'Turn cap must be a whole number from 1 to 50.';
      return; // never send invalid input
    }
    sendFrameToEngine(setModeFrame({ turnCap: value }));
  });
}
if (autoSendInput !== null) {
  autoSendInput.disabled = true;
  autoSendInput.addEventListener('change', () => {
    sendFrameToEngine(setModeFrame({ autoSend: autoSendInput.checked }));
  });
}
const submitDelay = (): void => {
  if (autoSendDelayInput === null || autoSendUnitInput === null) return;
  const value = Number(autoSendDelayInput.value);
  const seconds = delayToSeconds(value, autoSendUnitInput.value === 'minutes' ? 'minutes' : 'seconds');
  if (!isDelayValid(seconds)) {
    if (settingsHint !== null) settingsHint.textContent = 'The delay must be 3 seconds to 30 minutes.';
    return; // never send invalid input
  }
  sendFrameToEngine(setModeFrame({ autoSendDelaySec: seconds }));
};
if (autoSendDelayInput !== null) {
  autoSendDelayInput.disabled = true;
  autoSendDelayInput.addEventListener('change', submitDelay);
}
if (autoSendUnitInput !== null) {
  autoSendUnitInput.disabled = true;
  autoSendUnitInput.addEventListener('change', submitDelay);
}

// M4.3: search — the panel over the transcript, engine queries over the
// whole history. A new query supersedes an older one (requestIds); Escape
// or Clear closes.
const submitSearch = (): void => {
  if (searchInput === null) return;
  const query = searchInput.value;
  if (!isSearchQueryValid(query)) return; // never send invalid input
  const requestId = crypto.randomUUID();
  searchState = startSearch(searchState, requestId, query);
  renderSearchPanel();
  sendFrameToEngine(searchFrame(requestId, query));
};
const closeSearchPanel = (): void => {
  searchState = closeSearch(searchState);
  renderSearchPanel();
};
if (searchButton !== null) {
  searchButton.disabled = true; // until the engine connects
  searchButton.addEventListener('click', () => {
    if (searchPanel === null) return;
    if (searchState.open) { closeSearchPanel(); return; }
    searchState = startSearch(searchState, crypto.randomUUID(), '');
    renderSearchPanel();
    searchInput?.focus();
  });
}
if (searchInput !== null) {
  searchInput.disabled = true;
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); submitSearch(); }
  });
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && searchState.open) closeSearchPanel();
});
const searchClear = document.getElementById('search-clear');
if (searchClear !== null) {
  searchClear.addEventListener('click', () => {
    if (searchInput !== null) searchInput.value = '';
    closeSearchPanel();
  });
}
// M4.3: export — the engine builds the Markdown; the main process shows
// the save dialog and writes the file. The note says where it landed.
if (exportButton !== null) {
  exportButton.disabled = true; // until the engine connects
  exportButton.addEventListener('click', () => {
    pendingExport = crypto.randomUUID();
    if (exportNote !== null) exportNote.textContent = 'Building the export…';
    sendFrameToEngine(exportFrame(pendingExport));
  });
}

// M5.1: the visible seconds tick locally, one per second — the server's
// seconds: null is the only thing that ever removes an item.
setInterval(() => {
  if (Object.keys(countdownState.secondsLeft).length === 0) return;
  countdownState = tickCountdowns(countdownState);
  renderCountdownFooters();
}, 1000);

// Hermes mode chip — the engine does not report a mode yet, so it always
// shows "Conversation: no tools" with a safe tone. Updated here in case the
// engine ever reports a mode in a later milestone.
const hermesBadge = hermesModeBadge(undefined);
if (hermesModeChip !== null) {
  hermesModeChip.textContent = hermesBadge.text;
  hermesModeChip.className = `chip tone-${hermesBadge.tone}`;
}

connect();
