// Relay Chat — every chatgpt.com selector and page attribute lives here
// (SPEC: "Keep every selector in selectors.ts"). Observed in the logged-in
// desktop UI, 2026-10-18 — chatgpt.com had been rebuilt and NONE of the
// older selectors matched. Expect renames: the adapter reports
// 'selectors_stale' to the engine when a conversation page still shows no
// turns after a delay (m0.2 carry item 5), so a rename fails visibly
// instead of silently capturing nothing.
export const SELECTORS = {
  /** One element per exchange; the turn-state attribute flips in_progress → complete. */
  turn: '[data-talvt-turn-state]',
  /** The reply body inside a turn; the reply-id attribute is a stable per-message id. */
  replyBody: '[data-dil-message-id]',
  /** The stop button while a reply is streaming (data-testid is gone in the current UI). */
  stopButton: 'form[data-chatgpt-composer] button[aria-label="Stop"]',
  /** The composer (ProseMirror contenteditable; the old #prompt-textarea no longer exists). */
  composer: 'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]',
  /**
   * The send button. NOT present while the box is empty (a Dictate button shows
   * instead), so completion is judged by the stop button disappearing, the turn
   * state, and text stability (deliberate M0.2 deviation, kept — see
   * docs/status/m0.2.md).
   */
  sendButton: 'form[data-chatgpt-composer] button[aria-label="Send"]',
  /** The attribute on a turn element that carries its state ("in_progress" | "complete"). */
  turnStateAttribute: 'data-talvt-turn-state',
  /** The attribute on a reply body that carries its stable message id (the capture's sourceRef). */
  replyIdAttribute: 'data-dil-message-id',
} as const;
