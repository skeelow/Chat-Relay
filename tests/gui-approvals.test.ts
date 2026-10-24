// M3.3 — hermetic tests for the GUI's pure approval-banner decisions
// (app/src/approvals.ts): the card text per kind, the other-kind card with no
// buttons, the header count, the click lock cleared by approval_resolved, and
// the exact approval_answer frame. The renderer owns the DOM; nothing here
// touches the document or the socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
} from '../app/src/approvals.ts';

const view = (requestId: string, kind: string, summary = 'the summary',
  method = 'item/commandExecution/requestApproval'): ApprovalView =>
  ({ requestId, kind, summary, method });

test('approvalCard: answerable kinds get a title, the summary and both buttons', () => {
  assert.deepEqual(approvalCard(view('r1', 'command', 'git status')), {
    title: 'Codex wants approval: Command',
    body: 'git status',
    actions: ['approve_once', 'decline'],
  });
  assert.deepEqual(approvalCard(view('r1', 'file_change', 'write it')), {
    title: 'Codex wants approval: File change',
    body: 'write it',
    actions: ['approve_once', 'decline'],
  });
  assert.deepEqual(approvalCard(view('r1', 'permissions', 'net')), {
    title: 'Codex wants approval: Permissions',
    body: 'net',
    actions: ['approve_once', 'decline'],
  });
});

test('approvalCard: other has no buttons and says the relay cannot answer', () => {
  const card = approvalCard(view('r9', 'other', '', 'item/tool/requestUserInput'));
  assert.deepEqual(card.actions, [], 'nothing the relay could send anyway');
  assert.equal(card.title,
    'Codex asked for something the relay cannot answer (item/tool/requestUserInput). Answer it in the Codex app, or press Stop.');
});

test('approvalsBadgeText: zero hides the badge; one and many read naturally', () => {
  assert.equal(approvalsBadgeText(0), '');
  assert.equal(approvalsBadgeText(1), '1 approval waiting');
  assert.equal(approvalsBadgeText(3), '3 approvals waiting');
});

test('state: requests add in order; resolve removes the card and clears its click lock', () => {
  let state = emptyApprovalsState();
  state = applyApprovalRequest(state, view('r1', 'command'));
  state = applyApprovalRequest(state, view('r2', 'other', '', 'mcpServer/elicitation/request'));
  assert.deepEqual([...state.requests.keys()], ['r1', 'r2'], 'arrival order is kept');

  state = applyApprovalClick(state, 'r1');
  assert.ok(state.pendingClicks.has('r1'));

  state = applyApprovalResolved(state, 'r1');
  assert.equal(state.requests.has('r1'), false, 'the resolved card is gone');
  assert.equal(state.pendingClicks.has('r1'), false, 'its click lock resolves with it');
  assert.equal(state.requests.size, 1, 'the other card stays');
});

test('state: a snapshot replaces the whole list and clears every lock', () => {
  let state = emptyApprovalsState();
  state = applyApprovalRequest(state, view('r1', 'command'));
  state = applyApprovalRequest(state, view('r2', 'permissions'));
  state = applyApprovalClick(state, 'r1');
  state = applyApprovalClick(state, 'r2');
  state = applySnapshotApprovals(state, [view('r3', 'file_change')]);
  assert.deepEqual([...state.requests.keys()], ['r3'], 'the server list is the truth');
  assert.equal(state.pendingClicks.size, 0, 'a snapshot clears all locks');
});

test('approvalAnswerFrame is the exact protocol frame', () => {
  assert.deepEqual(approvalAnswerFrame('r1', 'accept'),
    { type: 'approval_answer', requestId: 'r1', decision: 'accept' });
  assert.equal(JSON.stringify(approvalAnswerFrame('r1', 'decline')),
    '{"type":"approval_answer","requestId":"r1","decision":"decline"}');
});

// --- M4.1 (N4): the local Dismiss on an `other` card ---

test('M4.1 N4: Dismiss hides a card locally; the same id arriving again shows it once more', () => {
  let state = emptyApprovalsState();
  state = applyApprovalRequest(state, view('r9', 'other', '', 'item/tool/requestUserInput'));
  state = applyApprovalRequest(state, view('r1', 'command', 'x'));
  assert.deepEqual(visibleApprovals(state).map((v) => v.requestId), ['r9', 'r1']);

  state = applyApprovalDismiss(state, 'r9');
  assert.deepEqual(visibleApprovals(state).map((v) => v.requestId), ['r1'],
    'the dismissed card is hidden in the GUI only');
  assert.ok(state.requests.has('r9'), 'the engine truth is untouched');

  // A fresh request with the same id clears the dismissal:
  state = applyApprovalRequest(state, view('r9', 'other', '', 'item/tool/requestUserInput'));
  assert.deepEqual(visibleApprovals(state).map((v) => v.requestId), ['r9', 'r1'],
    'the same id arriving again shows the card');

  // A new snapshot shows everything:
  state = applyApprovalDismiss(state, 'r9');
  state = applySnapshotApprovals(state, [view('r9', 'other', '', 'item/tool/requestUserInput')]);
  assert.deepEqual(visibleApprovals(state).map((v) => v.requestId), ['r9'],
    'a snapshot replaces the list and shows it again');
});

test('M4.1 N4: a dismissed card leaves the visible count', () => {
  let state = emptyApprovalsState();
  state = applyApprovalRequest(state, view('r9', 'other', '', 'item/tool/requestUserInput'));
  state = applyApprovalRequest(state, view('r2', 'other', '', 'mcpServer/elicitation/request'));
  state = applyApprovalDismiss(state, 'r9');
  assert.equal(visibleApprovals(state).length, 1);
  assert.equal(approvalsBadgeText(visibleApprovals(state).length), '1 approval waiting');
  // resolving a dismissed card is still a safe no-op:
  state = applyApprovalResolved(state, 'r9');
  assert.deepEqual(visibleApprovals(state).map((v) => v.requestId), ['r2']);
});
