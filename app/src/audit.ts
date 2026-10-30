// Relay Chat — GUI audit view (M6.4d), pure and DOM-free so Node's test
// runner can exercise it (tests/gui-perm.test.ts). The engine answers the
// `audit` frame with `audit_result` (newest first, M6.4a); this decides what
// the panel shows. Rows carry time, perm, event and detail only — the store
// never keeps a message body, and neither does the view.
import type { Perm } from './perm.ts';

/** One audit row exactly as the engine's audit_result sends it. */
export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  event: string;
  target: string | null;
  messageId: string | null;
  detail: string | null;
}

/** One row of the panel: the four columns the packet names. */
export interface AuditRowView {
  time: string;
  perm: Perm | null;
  event: string;
  detail: string | null;
}

/** The panel cap — the newest 100 rows (the engine allows up to 500). */
export const AUDIT_LIMIT = 100;

/** The frame asking the engine for the recent audit rows. */
export function auditFrame(
  requestId: string,
  limit: number = AUDIT_LIMIT,
): { type: 'audit'; requestId: string; limit: number } {
  return { type: 'audit', requestId, limit };
}

/** The panel state — which request is current (a new one supersedes an
 *  older one, like the search panel), and the last answered rows. */
export interface AuditUiState {
  open: boolean;
  requestId: string | null;
  entries: AuditEntry[];
}

export function emptyAuditState(): AuditUiState {
  return { open: false, requestId: null, entries: [] };
}

/** Open (or refresh) the panel: this requestId is now the current one. */
export function openAudit(state: AuditUiState, requestId: string): AuditUiState {
  return { open: true, requestId, entries: state.entries };
}

/** Close the panel; the rows are kept for the next open until refreshed. */
export function closeAudit(state: AuditUiState): AuditUiState {
  return { ...state, open: false, requestId: null };
}

/** Apply one audit_result. A stale requestId is ignored; a result while the
 *  panel is closed leaves the last rows untouched (still no new answer). */
export function applyAuditResult(
  state: AuditUiState,
  frame: { requestId?: unknown; entries?: unknown },
): AuditUiState {
  if (!state.open || state.requestId === null) return state;
  if (frame.requestId !== state.requestId) return state;
  const entries = Array.isArray(frame.entries) ? frame.entries : [];
  const valid = entries.filter(isAuditEntry);
  // Newest first by the store's ascending id — the GUI never trusts the order.
  const sorted = [...valid].sort((a, b) => b.id - a.id);
  return { ...state, entries: sorted.slice(0, AUDIT_LIMIT) };
}

/** Is this really an audit row? Junk is dropped, never guessed. */
function isAuditEntry(value: unknown): value is AuditEntry {
  if (value === null || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return typeof e.id === 'number' && typeof e.at === 'string'
    && typeof e.actor === 'string' && typeof e.event === 'string'
    && (e.detail === null || typeof e.detail === 'string');
}

/** The perm an entry carries: the engine puts it in `detail` on
 *  perm_requested and hermes_delivering rows; every other row has none. */
function permOf(entry: AuditEntry): Perm | null {
  if (entry.event !== 'perm_requested' && entry.event !== 'hermes_delivering') return null;
  return entry.detail === 'conversation' || entry.detail === 'work' || entry.detail === 'full'
    ? entry.detail
    : null;
}

/** The panel rows: junk dropped, newest first, capped at AUDIT_LIMIT, four
 *  columns each. */
export function auditRows(entries: AuditEntry[]): AuditRowView[] {
  const sorted = entries.filter(isAuditEntry)
    .sort((a, b) => b.id - a.id)
    .slice(0, AUDIT_LIMIT);
  return sorted.map((entry) => {
    const perm = permOf(entry);
    return {
      time: entry.at,
      perm,
      event: entry.event,
      detail: perm !== null ? null : entry.detail, // the perm shows once
    };
  });
}
