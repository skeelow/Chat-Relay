// Relay Chat — GUI Hermes status text (M6.3a, item 3), pure and DOM-free so
// Node's test runner can exercise them (tests/gui-hermes.test.ts).
//
// D29: nothing from another participant routes into Hermes automatically;
// only the user's own messages and the user's clicks do. These helpers only
// format what the GUI already knows.

/** The tone of a mode badge pill. */
export type BadgeTone = 'safe' | 'caution' | 'warning' | 'danger';

/** A mode badge: text plus tone. */
export interface ModeBadge {
  text: string;
  tone: BadgeTone;
}

/** The known Hermes statuses shown as a plain pill label. */
const HERMES_STATUSES = ['idle', 'thinking', 'disconnected', 'failed'];

/** The badge text and tone for a Hermes mode. Unknown modes are never
 *  guessed safe — they show raw and tone `danger`. */
export function hermesModeBadge(mode: string | undefined): ModeBadge {
  switch (mode) {
    case undefined:
    case 'A':
      return { text: 'Conversation: no tools', tone: 'safe' };
    case 'B':
      return { text: 'Supervised: asks first', tone: 'caution' };
    case 'C':
      return { text: 'Mission: autonomous, time-limited', tone: 'warning' };
    case 'D':
      return { text: 'Full access', tone: 'danger' };
    default:
      return { text: `Unknown mode (${mode})`, tone: 'danger' };
  }
}

/** The pill label for a Hermes status: known statuses are plain, anything
 *  else is shown raw — never guessed. */
export function hermesStatusLabel(status: string): string {
  if (HERMES_STATUSES.includes(status)) return status;
  return status;
}
