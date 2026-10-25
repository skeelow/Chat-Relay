// Relay Chat — the GUI's pure auto-send decisions (M5.1), DOM-free and
// socket-free so Node's test runner can exercise them
// (tests/gui-countdown.test.ts). The renderer owns the DOM and the local
// ticking; the engine owns the truth: a countdown appears only when the
// server announces it, and disappears when the server says seconds: null.

/** One running countdown, keyed `${messageId}:${target}`. */
export interface CountdownState {
  secondsLeft: Record<string, number>;
}

export function emptyCountdownState(): CountdownState {
  return { secondsLeft: {} };
}

/** Apply one countdown frame: a number starts (or restarts) the item, null
 *  clears it. Frames without a usable seconds field change nothing. */
export function applyCountdownFrame(
  state: CountdownState,
  frame: { messageId?: unknown; target?: unknown; seconds?: unknown },
): CountdownState {
  if (typeof frame.messageId !== 'string' || frame.target !== 'astra' && frame.target !== 'codex') {
    return state;
  }
  const key = `${frame.messageId}:${frame.target}`;
  const next = { secondsLeft: { ...state.secondsLeft } };
  if (frame.seconds === null) {
    delete next.secondsLeft[key];
    return next;
  }
  if (typeof frame.seconds === 'number' && Number.isFinite(frame.seconds) && frame.seconds >= 0) {
    next.secondsLeft[key] = Math.floor(frame.seconds);
  }
  return next;
}

/** One local second passes. Items floor at zero — only the server's
 *  seconds: null ever removes one. */
export function tickCountdowns(state: CountdownState): CountdownState {
  const secondsLeft: Record<string, number> = {};
  for (const [key, seconds] of Object.entries(state.secondsLeft)) {
    secondsLeft[key] = Math.max(0, seconds - 1);
  }
  return { secondsLeft };
}

/** The pending item's row text while a countdown runs. */
export function countdownRowText(secondsLeft: number): string {
  return `Sending in ${Math.max(0, Math.floor(secondsLeft))}s`;
}

/** The small header count while any countdown runs. */
export function countdownHeaderText(count: number): string {
  if (count <= 0) return '';
  return `${count} countdown${count === 1 ? '' : 's'} running`;
}

/** The D18-5 held notice on the message. */
export function heldNotice(cap: number, otherAi: string): string {
  return `Turn cap reached (${cap}) — not forwarded automatically. Use Send to ${otherAi} to continue by hand.`;
}

/** The packet's chain-reset help line for the notice. */
export function heldNoticeHelp(): string {
  return 'A new user message resets the chain — it starts from hop 0 again.';
}

/** D18 GUI: the auto-send controls are enabled only in Auto mode. */
export function autoSendControlsEnabled(mode: string): boolean {
  return mode === 'auto';
}

/** The labels of a pending item: the countdown pair (Send now / Cancel)
 *  while a countdown runs, the usual Approve / Reject otherwise. The frames
 *  are the existing approve and reject — there are no new GUI frames. */
export function pendingDecision(hasCountdown: boolean, secondsLeft: number): {
  label: string;
  approveLabel: string;
  rejectLabel: string;
} {
  if (hasCountdown) {
    return { label: countdownRowText(secondsLeft), approveLabel: 'Send now', rejectLabel: 'Cancel' };
  }
  return { label: 'Waiting for your approval', approveLabel: 'Approve', rejectLabel: 'Reject' };
}
