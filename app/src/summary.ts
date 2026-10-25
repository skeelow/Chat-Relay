// Relay Chat — the session summary line (M5.2), pure: the text is built
// only from the server's summary frame, with correct pluralisation, and an
// emphasis flag for waiting approvals. A session is one engine run; the
// numbers live in engine memory and never touch the database.

export interface SessionSummary {
  turnsUsed: number;
  held: number;
  approvalsPending: number;
  since: string; // ISO 8601, the engine start
}

/** The pinned line: "Session since 14:02 · 7 AI turns · 1 held · 0 approvals
 *  waiting". No summary (before the first frame) means no line at all. */
export function summaryLine(
  summary: SessionSummary | null,
  locale = 'en-GB',
): { text: string; approvalsEmphasised: boolean } | null {
  if (summary === null) return null;
  const since = new Date(summary.since);
  const time = Number.isNaN(since.getTime())
    ? summary.since
    : since.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const turns = summary.turnsUsed === 1 ? '1 AI turn' : `${summary.turnsUsed} AI turns`;
  const approvals = summary.approvalsPending === 1
    ? '1 approval waiting'
    : `${summary.approvalsPending} approvals waiting`;
  return {
    text: `Session since ${time} · ${turns} · ${summary.held} held · ${approvals}`,
    approvalsEmphasised: summary.approvalsPending > 0,
  };
}
