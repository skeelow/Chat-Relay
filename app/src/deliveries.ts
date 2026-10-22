// Relay Chat — GUI delivery decisions (M2.3 + M3.1), pure and DOM-free so
// Node's test runner can exercise them (tests/gui-deliveries.test.ts). The
// renderer owns all DOM work; nothing here touches the document or socket.
//
// The GUI never guesses: every status line comes from the snapshot's
// deliveries or a delivery_update, mapped through the per-target tables.
// M3.1 (G2): rows are keyed `${messageId}:${target}` — one message can carry
// a delivery to each AI. M3.1 (G1): a snapshot clears every pending click.

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
 */
export function deliveryStatusView(
  status: string,
  target: string,
  error?: string | null,
): { label: string; actions: DeliveryAction[] } {
  const toAstra = target === 'astra';
  switch (status) {
    case 'pending_approval':
      return { label: 'Waiting for your approval', actions: ['approve', 'reject'] };
    case 'queued':
      return {
        label: toAstra ? 'Approved, waiting for the ChatGPT extension' : 'Approved, waiting for Codex adapter',
        actions: [],
      };
    case 'delivering':
      return { label: toAstra ? 'Typing into ChatGPT…' : 'Sending to Codex…', actions: [] };
    case 'delivered':
      return { label: toAstra ? 'Typed into ChatGPT — click Send there' : 'Sent to Codex', actions: [] };
    case 'failed':
      return { label: `Failed: ${error ?? 'unknown error'}`, actions: ['forward'] };
    case 'cancelled':
      return { label: 'Cancelled', actions: [] };
    default:
      return { label: status, actions: [] }; // unknown statuses show raw text — never guessed
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
 * (Send again — a fresh forward resets it).
 */
export function sendButton(
  source: string,
  delivery: DeliveryRow | undefined,
): { show: boolean; label: string; target: 'codex' | 'astra' | null } {
  const target = targetFor(source);
  if (target === null) return { show: false, label: '', target: null };
  const plain = source === 'astra' ? 'Send to Codex' : 'Send to ChatGPT';
  if (delivery === undefined) return { show: true, label: plain, target };
  if (delivery.status === 'failed') return { show: true, label: 'Send again', target };
  return { show: false, label: '', target };
}

/** Header count: how many rows wait for the user's approval, across targets. */
export function pendingCount(rows: DeliveryRow[]): number {
  return rows.filter((row) => row.status === 'pending_approval').length;
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

export function forwardFrame(messageId: string, target: 'codex' | 'astra'): { type: 'forward'; messageId: string; target: 'codex' | 'astra' } {
  return { type: 'forward', messageId, target };
}

export function approveFrame(messageId: string, target: 'codex' | 'astra'): { type: 'approve'; messageId: string; target: 'codex' | 'astra' } {
  return { type: 'approve', messageId, target };
}

export function rejectFrame(messageId: string, target: 'codex' | 'astra'): { type: 'reject'; messageId: string; target: 'codex' | 'astra' } {
  return { type: 'reject', messageId, target };
}
