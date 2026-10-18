// M0.2 spike — every chatgpt.com selector lives here (SPEC: "Keep every selector in selectors.ts").
// The logged-out shell hides the composer, so these could not be verified against a live
// logged-in page by the agent; they use the long-standing stable attributes plus fallbacks.
// The manual acceptance check in the logged-in browser is what verifies them — fix them
// HERE and only here if the page has moved on.
export const SELECTORS = {
  /** One element per assistant reply. */
  assistantMessage: '[data-message-author-role="assistant"]',
  /** The composer (desktop UI: ProseMirror contenteditable with id prompt-textarea). */
  composer: '#prompt-textarea, div[contenteditable="true"], form textarea',
  /** The send button — completion signal 1: the stop button has returned to send. */
  sendButton: 'button[data-testid="send-button"], button[aria-label="Send prompt"]',
  /** The stop button — its presence means a reply is still streaming. */
  stopButton: 'button[data-testid="stop-button"], button[aria-label="Stop streaming"]',
} as const;
