// Relay Chat — GUI Hermes permission picker (M6.4d), pure and DOM-free so
// Node's test runner can exercise it (tests/gui-perm.test.ts). The renderer
// owns the buttons; nothing here touches the document or socket.
//
// D33: the mode is chosen per message by the user, and Work/Full are never
// the default — the picker resets to Conversation after every send. The
// engine already reads `perm` on send/forward (M6.4a); the GUI only ever
// puts the field on frames that involve Hermes, so an Astra/Codex-only send
// never audits a perm it does not use.
import type { Target } from './compose.ts';

/** The three permission modes. */
export type Perm = 'conversation' | 'work' | 'full';

/** Conversation is the default on every send (SPEC hard rule: work and full
 *  are never the default). */
export const DEFAULT_PERM: Perm = 'conversation';

/** A picker choice: value, label and the visible mark (colour tone). */
export interface PermChoice {
  value: Perm;
  label: string;
  tone: 'safe' | 'warning' | 'danger';
}

/** The picker's three buttons, in order. */
export const PERM_CHOICES: readonly PermChoice[] = [
  { value: 'conversation', label: 'Conversation', tone: 'safe' },
  { value: 'work', label: 'Work — tools on', tone: 'warning' },
  { value: 'full', label: 'Full — no blocks', tone: 'danger' },
];

/** The short note shown beside the picker (packet M6.4d item 1). */
export const PERM_NOTE =
  'Each mode has its own Hermes session — to carry context across modes use memory or files.';

/** The view (label + tone) for the chip that marks the current choice. */
export function permChoiceView(perm: Perm): { label: string; tone: 'safe' | 'warning' | 'danger' } {
  const choice = PERM_CHOICES.find((c) => c.value === perm) ?? PERM_CHOICES[0];
  return { label: choice.label, tone: choice.tone };
}

/** The user's click on a picker button. An invalid value changes nothing —
 *  the GUI never guesses a mode. */
export function choosePerm(current: Perm, chosen: unknown): Perm {
  return chosen === 'conversation' || chosen === 'work' || chosen === 'full'
    ? chosen
    : current;
}

/** The picker after a send goes out: never sticky, always Conversation. */
export function permAfterSend(_current: Perm): Perm {
  return DEFAULT_PERM;
}

/** A send frame with the picked perm — the perm rides only when Hermes is a
 *  target (Astra and Codex ignore it entirely). */
export function sendFrameWithPerm(
  body: string,
  targets: Target[],
  perm: Perm,
): { type: 'send'; body: string; targets: Target[]; perm?: Perm } {
  return targets.includes('hermes')
    ? { type: 'send', body, targets, perm }
    : { type: 'send', body, targets };
}

/** A forward frame with the picked perm, same rule: only a Hermes forward
 *  carries it. `forwardFrame` (deliveries.ts) stays unchanged for the rest. */
export function forwardFrameWithPerm(
  messageId: string,
  target: Target,
  perm: Perm,
): { type: 'forward'; messageId: string; target: Target; perm?: Perm } {
  return target === 'hermes'
    ? { type: 'forward', messageId, target, perm }
    : { type: 'forward', messageId, target };
}
