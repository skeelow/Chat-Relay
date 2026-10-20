// Relay Chat — GUI delivery decisions (M2.3), pure and DOM-free so Node's
// test runner can exercise them (tests/gui-deliveries.test.ts). The renderer
// owns all DOM work; nothing here touches the document or the socket.
//
// The GUI never guesses: every status line comes from the snapshot's
// deliveries or a delivery_update, mapped through the D9 table below.

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

/** The D9 status → (status line, actions) table. */
export function deliveryStatusView(
  status: string,
  error?: string | null,
): { label: string; actions: DeliveryAction[] } {
  switch (status) {
    case 'pending_approval':
      return { label: 'Waiting for your approval', actions: ['approve', 'reject'] };
    case 'queued':
      return { label: 'Approved, waiting for Codex adapter', actions: [] };
    case 'delivering':
      return { label: 'Sending to Codex…', actions: [] };
    case 'delivered':
      return { label: 'Sent to Codex', actions: [] };
    case 'failed':
      return { label: `Failed: ${error ?? 'unknown error'}`, actions: ['forward'] };
    case 'cancelled':
      return { label: 'Cancelled', actions: [] };
    default:
      return { label: status, actions: [] }; // unknown statuses show raw text — never guessed
  }
}

/**
 * Does this message get a Send-to-Codex button, and with what label?
 * Only astra messages, and only with no codex delivery yet (Send to Codex)
 * or a failed one (Send again — a fresh forward resets it). In M2 no other
 * source is ever forwardable.
 */
export function sendButton(
  source: string,
  delivery: DeliveryRow | undefined,
): { show: boolean; label: string } {
  if (source !== 'astra') return { show: false, label: '' };
  if (delivery === undefined) return { show: true, label: 'Send to Codex' };
  if (delivery.status === 'failed') return { show: true, label: 'Send again' };
  return { show: false, label: '' };
}

/** Header count: how many rows wait for the user's approval. */
export function pendingCount(rows: DeliveryRow[]): number {
  return rows.filter((row) => row.status === 'pending_approval').length;
}

/**
 * Apply one delivery_update to the rows state. Rows for messages that are not
 * on screen yet are kept — they apply when the message arrives later.
 * Pure: returns a new map, never mutates the input.
 */
export function applyDeliveryUpdate(
  rows: Map<string, DeliveryRow>,
  update: DeliveryRow,
): Map<string, DeliveryRow> {
  const next = new Map(rows);
  next.set(update.messageId, update);
  return next;
}

// --- the exact frames the GUI sends (SPEC protocol table) ---

export function forwardFrame(messageId: string): { type: 'forward'; messageId: string; target: 'codex' } {
  return { type: 'forward', messageId, target: 'codex' };
}

export function approveFrame(messageId: string): { type: 'approve'; messageId: string; target: 'codex' } {
  return { type: 'approve', messageId, target: 'codex' };
}

export function rejectFrame(messageId: string): { type: 'reject'; messageId: string; target: 'codex' } {
  return { type: 'reject', messageId, target: 'codex' };
}
