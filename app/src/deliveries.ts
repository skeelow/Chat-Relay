// Relay Chat — GUI delivery decisions (M2.3 + M3.1), pure and DOM-free so
// Node's test runner can exercise them (tests/gui-deliveries.test.ts). The
// renderer owns all DOM work; nothing here touches the document or socket.
//
// The GUI never guesses: every status line comes from the snapshot's
// deliveries or a delivery_update, mapped through the per-target tables.
// M3.1 (G2): rows are keyed `${messageId}:${target}` — one message can carry
// a delivery to each AI. M3.1 (G1): a snapshot clears every pending click.
import type { Target } from './compose.ts';

/** A delivery row as the engine reports it (snapshot deliveries / delivery_update). */
export interface DeliveryRow {
  messageId: string;
  target: string;
  status: string;
  attempts: number;
  updatedAt: string;
  /** Present on failed rows. */
  error?: string;
}

/** What the user can do with a delivery from the GUI. */
export type DeliveryAction = 'forward' | 'approve' | 'reject';

/**
 * The status → (status line, actions) table, per target. The codex labels are
 * M2.3's; the astra labels say what actually happened on the ChatGPT page:
 * delivered means TYPED, waiting for the user to click Send (D10).
 * M3.2a: a pending row with an error shows the approval line plus the note
 * (the restart's "may already have arrived"); a row that failed after 3
 * attempts is final — no action, no Send again.
 */
export function deliveryStatusView(
  delivery: DeliveryRow,
  target: string,
): { label: string; actions: DeliveryAction[] } {
  switch (delivery.status) {
    case 'pending_approval':
      return {
        label: delivery.error === undefined
          ? 'Waiting for your approval'
          : `Waiting for your approval — ${delivery.error}`,
        actions: ['approve', 'reject'],
      };
    case 'queued':
      return {
        label: target === 'astra'
          ? 'Approved, waiting for the ChatGPT extension'
          : target === 'codex'
            ? 'Approved, waiting for Codex adapter'
            : 'Approved, waiting for Hermes',
        actions: [],
      };
    case 'delivering':
      return {
        label: target === 'astra'
          ? 'Typing into ChatGPT…'
          : target === 'codex'
            ? 'Sending to Codex…'
            : 'Hermes is working…',
        actions: [],
      };
    case 'delivered':
      return {
        label: target === 'astra'
          ? 'Typed into ChatGPT — click Send there'
          : target === 'codex'
            ? 'Sent to Codex'
            : 'Hermes replied',
        actions: [],
      };
    case 'failed':
      if (delivery.attempts >= 3) {
        return { label: `Failed after 3 attempts: ${delivery.error ?? 'unknown error'}`, actions: [] };
      }
      return { label: `Failed: ${delivery.error ?? 'unknown error'}`, actions: ['forward'] };
    case 'cancelled':
      return { label: 'Cancelled', actions: [] };
    default:
      return { label: delivery.status, actions: [] }; // unknown statuses show raw text — never guessed
  }
}

/**
 * The only other AI a message can be forwarded to in M3.1: astra → codex,
 * codex → astra. User messages forward nowhere yet.
 */
export function targetFor(source: string): 'codex' | 'astra' | null {
  if (source === 'astra') return 'codex';
  if (source === 'codex') return 'astra';
  return null;
}

/**
 * Does this message get a send button, with what label, and for which target?
 * Only AI messages, and only with no delivery yet (Send to …) or a failed one
 * (Send again — a fresh forward resets it). M3.2a: a failure after 3 attempts
 * is final, so its Send again is gone too; the text stays copyable.
 */
export function sendButton(
  source: string,
  delivery: DeliveryRow | undefined,
): { show: boolean; label: string; target: 'codex' | 'astra' | null } {
  const target = targetFor(source);
  if (target === null) return { show: false, label: '', target: null };
  const plain = source === 'astra' ? 'Send to Codex' : 'Send to ChatGPT';
  if (delivery === undefined) return { show: true, label: plain, target };
  if (delivery.status === 'failed' && delivery.attempts >= 3) {
    return { show: false, label: '', target }; // three attempts: no more retries
  }
  if (delivery.status === 'failed') return { show: true, label: 'Send again', target };
  return { show: false, label: '', target };
}

/** The label shown on each per-target send button. */
const SEND_LABEL: Record<Target, string> = {
  astra: 'Send to ChatGPT',
  codex: 'Send to Codex',
  hermes: 'Send to Hermes',
};

/** The targets offered to the source AI, in label order: the "other" AIs. */
function otherTargets(source: string): Target[] {
  if (source === 'astra') return ['codex', 'hermes'];
  if (source === 'codex') return ['astra', 'hermes'];
  if (source === 'hermes') return ['astra', 'codex'];
  return []; // user (or anything else) — no send buttons
}

/** One per-target send button entry: show/hide plus label and target. */
export interface SendButtonEntry {
  show: boolean;
  label: string;
  target: Target;
}

/** M6.3a: one send-button entry per other AI for this message.
 *
 * The same rules as today's `sendButton` apply per entry: shown when there is
 * no delivery row for that target; "Send again" after a failure with fewer
 * than 3 attempts; hidden after 3 failed attempts or when a row is in any
 * other state. `sendButton` and `targetFor` are unchanged.
 */
export function sendButtons(source: string, rowsForThisMessage: DeliveryRow[]): SendButtonEntry[] {
  return otherTargets(source).map((target) => {
    const delivery = rowsForThisMessage.find((row) => row.target === target);
    const plain = SEND_LABEL[target];
    if (delivery === undefined) return { show: true, label: plain, target };
    if (delivery.status === 'failed' && delivery.attempts >= 3) {
      return { show: false, label: '', target };
    }
    if (delivery.status === 'failed') return { show: true, label: 'Send again', target };
    return { show: false, label: '', target };
  });
}

/** Header count: how many rows wait for the user's approval, across targets. */
export function pendingCount(rows: DeliveryRow[]): number {
  return rows.filter((row) => row.status === 'pending_approval').length;
}

/**
 * M4.1: the targets a user message has delivery rows for, in a stable order
 * (astra, codex) — one footer line per target. Empty until the rows arrive.
 * Hermes footer lines are rendered in part b (screen work); here the pure
 * helpers already accept `hermes` for deliveryStatusView, sendButtons and the
 * frames.
 */
export function userFooterTargets(messageId: string, rows: DeliveryRow[]): Array<'astra' | 'codex'> {
  const order: Array<'astra' | 'codex'> = ['astra', 'codex'];
  return order.filter((target) => rows.some((row) => row.messageId === messageId && row.target === target));
}

/** G2: the row key — one message may carry a delivery per AI. */
export function deliveryKey(messageId: string, target: string): string {
  return `${messageId}:${target}`;
}

/** The GUI's whole delivery state, owned by these pure transitions. */
export interface DeliveryUiState {
  /** Keyed deliveryKey(messageId, target). */
  rows: Map<string, DeliveryRow>;
  /** Clicked keys waiting for their own delivery_update (double-click guard). */
  pendingClicks: Set<string>;
}

export function emptyDeliveryState(): DeliveryUiState {
  return { rows: new Map(), pendingClicks: new Set() };
}

/**
 * G1: a snapshot reseeds every row and clears all pending clicks — a
 * reconnect must not leave items stuck disabled. Pure: new state returned.
 */
export function applySnapshotDeliveries(state: DeliveryUiState, rows: DeliveryRow[]): DeliveryUiState {
  const nextRows = new Map<string, DeliveryRow>();
  for (const row of rows) nextRows.set(deliveryKey(row.messageId, row.target), row);
  return { rows: nextRows, pendingClicks: new Set() };
}

/**
 * Apply one delivery_update. Rows for messages that are not on screen yet
 * are kept — they apply when the message arrives later. The item's pending
 * click resolves, so its buttons may return.
 */
export function applyDeliveryUpdate(state: DeliveryUiState, update: DeliveryRow): DeliveryUiState {
  const key = deliveryKey(update.messageId, update.target);
  const rows = new Map(state.rows);
  rows.set(key, update);
  const pendingClicks = new Set(state.pendingClicks);
  pendingClicks.delete(key);
  return { rows, pendingClicks };
}

/** A click disables that item's buttons until its next delivery_update. */
export function applyClick(state: DeliveryUiState, key: string): DeliveryUiState {
  const pendingClicks = new Set(state.pendingClicks);
  pendingClicks.add(key);
  return { rows: state.rows, pendingClicks };
}

// --- the exact frames the GUI sends (SPEC protocol table) ---

export function forwardFrame(messageId: string, target: Target): { type: 'forward'; messageId: string; target: Target } {
  return { type: 'forward', messageId, target };
}

export function approveFrame(messageId: string, target: Target): { type: 'approve'; messageId: string; target: Target } {
  return { type: 'approve', messageId, target };
}

export function rejectFrame(messageId: string, target: Target): { type: 'reject'; messageId: string; target: Target } {
  return { type: 'reject', messageId, target };
}

// --- M3.2b: Stop and Resume (the state comes only from snapshot.paused / pause_update) ---

/** The banner under the header while stopped (exact packet text). */
export const PAUSE_BANNER = 'Stopped — nothing will be delivered until you resume';
/** The title that explains a disabled Approve while stopped. */
export const APPROVE_PAUSED_TITLE = 'Approve is disabled while stopped — press Resume first';

/** The banner text while stopped; null while running. */
export function pauseBannerText(paused: boolean): string | null {
  return paused ? PAUSE_BANNER : null;
}

/** The header button's label: Stop while running, Resume while stopped. */
export function stopButtonLabel(paused: boolean): 'Stop' | 'Resume' {
  return paused ? 'Resume' : 'Stop';
}

/** The title explaining a disabled Approve while stopped; null otherwise. */
export function approveDisabledTitle(paused: boolean): string | null {
  return paused ? APPROVE_PAUSED_TITLE : null;
}

export function stopFrame(): { type: 'stop' } {
  return { type: 'stop' };
}

export function resumeFrame(): { type: 'resume' } {
  return { type: 'resume' };
}
