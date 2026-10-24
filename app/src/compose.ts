// Relay Chat — GUI compose decisions (M4.1), pure and DOM-free so Node's
// test runner can exercise them (tests/compose.test.ts). The renderer owns
// the text box and the Send button; nothing here touches the document.
//
// The user picks a target with the @Astra / @Codex / @both selector, or by
// starting the text with @astra / @codex / @both (case-insensitive) — the
// prefix wins and is removed from the body. Empty text cannot be sent.

/** The engine's body cap (D14-2): longer sends are ignored engine-side, so
 *  the GUI refuses them instead and keeps the typed text. */
export const COMPOSE_BODY_CAP = 20000;

/** A sendable compose result. */
export interface ComposeSend {
  ok: true;
  body: string;
  targets: Array<'astra' | 'codex'>;
}

/** Why the text cannot be sent (the box keeps its text either way). */
export type ComposeRefusal = { ok: false; reason: 'empty' | 'too-long' };

/** The @-prefix: the tag must end at a word boundary, so a mid-sentence
 *  mention (@codex later, …) and a glued word (@astrahello) are plain text.
 *  Separators right after the tag (", hi", ": hi") are part of the prefix. */
const PREFIX = /^\s*@(?<tag>astra|codex|both)\b[,;:\s]*/i;

const TARGETS_OF: Record<string, Array<'astra' | 'codex'>> = {
  astra: ['astra'],
  codex: ['codex'],
  both: ['astra', 'codex'],
};

/**
 * Decide what a Send click would do with the box's text and the selector's
 * value: the target list and the trimmed body — or why it cannot go out.
 */
export function parseCompose(text: string, selector: string): ComposeSend | ComposeRefusal {
  const match = PREFIX.exec(text);
  const tag = match?.groups?.tag.toLowerCase();
  const rest = tag === undefined
    ? text.trim()
    : text.slice((match?.index ?? 0) + (match?.[0]?.length ?? 0)).trim();
  if (rest === '') return { ok: false, reason: 'empty' };
  if (rest.length > COMPOSE_BODY_CAP) return { ok: false, reason: 'too-long' };
  // The prefix wins over the selector; an unknown selector value falls back
  // to both (the renderer only offers the three real choices).
  const choice = tag ?? (selector in TARGETS_OF ? selector : 'both');
  return { ok: true, body: rest, targets: TARGETS_OF[choice] as Array<'astra' | 'codex'> };
}
