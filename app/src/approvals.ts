// Relay Chat — GUI approval-banner decisions (M3.3), pure and DOM-free so
// Node's test runner can exercise them (tests/gui-approvals.test.ts). The
// renderer owns all DOM work; nothing here touches the document or socket.
//
// State comes only from the server: snapshot.approvals, approval_request and
// approval_resolved frames. A snapshot replaces the whole list (G1-style),
// and a resolved card takes its click lock with it.
//
// Hard rule (SPEC: no automatic approvals): the banner offers approve-once
// and decline only. `other`-kind cards — things the relay cannot answer —
// carry no buttons at all.

/** One pending codex approval as the engine reports it. */
export interface ApprovalView {
  requestId: string;
  kind: string;
  summary: string;
  method: string;
}

export type ApprovalAction = 'approve_once' | 'decline';

const ANSWERABLE_KINDS = new Set(['command', 'file_change', 'permissions']);

const KIND_LABELS: Record<string, string> = {
  command: 'Command',
  file_change: 'File change',
  permissions: 'Permissions',
};

export function isAnswerable(kind: string): boolean {
  return ANSWERABLE_KINDS.has(kind);
}

/**
 * One banner card: the title line, the summary body, and the actions the user
 * may take. Answerable kinds get Approve once + Decline; `other` explains it
 * cannot be answered here and offers no buttons.
 */
export function approvalCard(view: ApprovalView): { title: string; body: string; actions: ApprovalAction[] } {
  if (!isAnswerable(view.kind)) {
    return {
      title: `Codex asked for something the relay cannot answer (${view.method}). Answer it in the Codex app, or press Stop.`,
      body: view.summary,
      actions: [],
    };
  }
  return {
    title: `Codex wants approval: ${KIND_LABELS[view.kind] ?? view.kind}`,
    body: view.summary,
    actions: ['approve_once', 'decline'],
  };
}

/** The header badge text; empty hides it (the GUI never shows "0 …"). */
export function approvalsBadgeText(count: number): string {
  if (count === 0) return '';
  return `${count} ${count === 1 ? 'approval' : 'approvals'} waiting`;
}

/** The GUI's whole approval state, owned by these pure transitions. */
export interface ApprovalsUiState {
  /** Pending approvals in arrival order, keyed by requestId. */
  requests: Map<string, ApprovalView>;
  /** Clicked requestIds waiting for their approval_resolved (double-click guard). */
  pendingClicks: Set<string>;
}

export function emptyApprovalsState(): ApprovalsUiState {
  return { requests: new Map(), pendingClicks: new Set() };
}

export function applyApprovalRequest(state: ApprovalsUiState, view: ApprovalView): ApprovalsUiState {
  const requests = new Map(state.requests);
  requests.set(view.requestId, view);
  return { requests, pendingClicks: state.pendingClicks };
}

export function applyApprovalResolved(state: ApprovalsUiState, requestId: string): ApprovalsUiState {
  const requests = new Map(state.requests);
  requests.delete(requestId);
  const pendingClicks = new Set(state.pendingClicks);
  pendingClicks.delete(requestId);
  return { requests, pendingClicks };
}

/** A snapshot replaces the list and clears every click lock. */
export function applySnapshotApprovals(state: ApprovalsUiState, views: ApprovalView[]): ApprovalsUiState {
  const requests = new Map<string, ApprovalView>();
  for (const view of views) requests.set(view.requestId, view);
  return { requests, pendingClicks: new Set() };
}

/** A click locks that card's buttons until its approval_resolved arrives. */
export function applyApprovalClick(state: ApprovalsUiState, requestId: string): ApprovalsUiState {
  const pendingClicks = new Set(state.pendingClicks);
  pendingClicks.add(requestId);
  return { requests: state.requests, pendingClicks };
}

/** The exact frame the GUI sends (SPEC protocol table). */
export function approvalAnswerFrame(
  requestId: string,
  decision: 'accept' | 'decline',
): { type: 'approval_answer'; requestId: string; decision: 'accept' | 'decline' } {
  return { type: 'approval_answer', requestId, decision };
}
