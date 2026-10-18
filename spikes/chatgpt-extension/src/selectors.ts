// M0.2 spike — every chatgpt.com selector lives here (SPEC: "Keep every selector in selectors.ts").
// Observed in the logged-in desktop UI by the publisher's review, 2026-10-18 — the page
// had been rebuilt and NONE of the previous selectors matched. data-talvt-turn-state looks
// like an internal name and may be renamed again: content.ts logs a loud warning when a
// conversation page shows no turns, so a future rename fails visibly instead of silently.
export const SELECTORS = {
  /** One element per exchange. data-talvt-turn-state: "in_progress" while streaming, "complete" when done. */
  turn: '[data-talvt-turn-state]',
  /** The reply body inside a turn; data-dil-message-id is a stable per-message id. */
  replyBody: '[data-dil-message-id]',
  /** The stop button while a reply is streaming (data-testid is gone in the current UI). */
  stopButton: 'form[data-chatgpt-composer] button[aria-label="Stop"]',
  /** The composer (ProseMirror contenteditable; the old #prompt-textarea no longer exists). */
  composer: 'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]',
  /**
   * The send button. NOT present while the box is empty (a Dictate button shows instead),
   * so the spike deliberately never relies on it: completion is judged by the stop button
   * disappearing, the turn state, and text stability. Kept here so the M1.4 adapter can
   * adopt it when needed — deliberate deviation, noted in docs/status/m0.2.md.
   */
  sendButton: 'form[data-chatgpt-composer] button[aria-label="Send"]',
} as const;
