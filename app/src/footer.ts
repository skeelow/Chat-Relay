// Relay Chat — GUI AI-message footer lines (M6.3c), pure and DOM-free so
// Node's test runner can exercise them (tests/gui-hermes.test.ts). Extracted
// from renderDelivery (app/src/renderer.ts) per review m6.3b S1: the renderer
// owns the DOM; this module decides which lines and buttons an AI message's
// footer shows.
//
// Inputs: the message's source, that message's delivery rows, and a context
// carrying the running countdown seconds (keyed `${messageId}:${target}`) and
// the held notice (if any). One line per "other AI" for the source.
import type { Target } from './compose.ts';
import {
  SENDER_LABELS,
  deliveryKey,
  deliveryStatusView,
  sendButtons,
  type DeliveryAction,
  type DeliveryRow,
} from './deliveries.ts';
import { heldNotice, heldNoticeHelp, pendingDecision } from './countdown.ts';

/** One footer button: the action frame to send plus its label. */
export interface FooterButton {
  action: DeliveryAction;
  label: string;
}

/** One AI-footer line: a target AI, its status label, and its buttons. */
export interface AiFooterLine {
  target: Target;
  label: string;
  buttons: FooterButton[];
}

/** What aiFooterLines needs beyond the source and the message's rows. */
export interface AiFooterContext {
  messageId: string;
  /** Running countdown seconds, keyed `${messageId}:${target}` (M5.1/D18). */
  countdownSeconds: Record<string, number>;
  /** The D18-5 held notice for this message, if any (cap = turn cap reached). */
  held?: { cap: number };
}

/**
 * The AI-message footer: one line per other AI for `source` (astra → codex,
 * hermes; codex → astra, hermes; hermes → astra, codex; user → none). Pure.
 *
 * Status labels come from deliveryStatusView; the held notice overrides on the
 * codex/astra line only (never Hermes, D29); a running countdown overrides both
 * with Sending in Ns / Send now / Cancel (never on a Hermes row, D29). Buttons:
 * the forward button (Send to X / Send again) first, then Approve/Reject for a
 * pending row. A line is skipped only when it has nothing to show.
 */
export function aiFooterLines(
  source: string,
  rows: DeliveryRow[],
  ctx: AiFooterContext,
): AiFooterLine[] {
  const lines: AiFooterLine[] = [];
  for (const entry of sendButtons(source, rows)) {
    const target = entry.target;
    const key = deliveryKey(ctx.messageId, target);
    const delivery = rows.find((row) => row.target === target);
    const view = delivery === undefined
      ? { label: '', actions: [] as DeliveryAction[] }
      : deliveryStatusView(delivery, target);

    // Status label: held notice (never on Hermes per D29), then the view label.
    let label = view.label;
    if (ctx.held !== undefined && target !== 'hermes') {
      label = `${heldNotice(ctx.held.cap, SENDER_LABELS[target] ?? target)} ${heldNoticeHelp()}`;
    }
    // M5.1 (D18 GUI): while a countdown runs on a pending item, labels read
    // Sending in Ns / Send now / Cancel. D29: no countdown on a Hermes line.
    const countdownSeconds = ctx.countdownSeconds[key];
    const hasCountdown =
      countdownSeconds !== undefined && view.actions.includes('approve') && target !== 'hermes';
    const decision = pendingDecision(hasCountdown, countdownSeconds ?? 0);
    if (hasCountdown) {
      label = decision.label;
    }

    // Buttons: forward (Send to X / Send again) first, then Approve/Reject.
    const buttons: FooterButton[] = [];
    if (entry.show) {
      buttons.push({ action: 'forward', label: entry.label });
    }
    for (const action of view.actions) {
      if (action === 'approve') {
        buttons.push({ action, label: hasCountdown ? decision.approveLabel : 'Approve' });
      } else if (action === 'reject') {
        buttons.push({ action, label: hasCountdown ? decision.rejectLabel : 'Reject' });
      }
      // 'forward' in the table is the failed case — sendButtons shows it (entry.show).
    }

    // M1 fix (m6.3b): skip a line only when it has nothing to show — an empty
    // label AND no buttons. The old rule (!show && no actions) wrongly dropped
    // queued/delivering/delivered and final-failed rows, which have a label.
    if (label === '' && buttons.length === 0) continue;

    lines.push({ target, label, buttons });
  }
  return lines;
}
