// Relay Chat — the engine's Markdown export (M4.3), pure: no store, no
// sockets. The engine hands it the newest EXPORT_CAP messages (oldest
// first) and their delivery rows, and gets back one Markdown document.
//
// Bodies are data, never Markdown structure: each body sits inside a code
// fence longer than any backtick run the body itself contains (fenceFor),
// so a body with triple backticks cannot break the document.

import type { RelayMessage } from './store.ts';

/** The export cap from the M4.3 packet (D17-3). */
export const EXPORT_CAP = 5000;

/** The delivery rows an export lists, one `Delivery:` line each. */
export interface ExportDelivery {
  messageId: string;
  target: 'user' | 'astra' | 'codex';
  status: string;
}

const SENDER_LABELS: Record<string, string> = { user: 'You', astra: 'Astra', codex: 'Codex' };

/** A code fence the body cannot close: one backtick longer than the body's
 *  longest run, three at minimum. */
export function fenceFor(body: string): string {
  let longest = 0;
  let run = 0;
  for (const ch of body) {
    run = ch === '`' ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

const countLabel = (n: number): string => n.toLocaleString('en-US');

/** Build the transcript Markdown: heading, generation line (with the cap
 *  note when the newest 5,000 only are exported), then one section per
 *  message, oldest first, with the body verbatim in a fence and one
 *  `Delivery: <target> <status>` line per delivery row. */
export function exportMarkdown(
  messages: RelayMessage[],
  deliveries: ExportDelivery[],
  generatedAt: string,
): string {
  const parts: string[] = ['# Relay Chat transcript', ''];
  const capped = messages.length >= EXPORT_CAP;
  parts.push(`Generated ${generatedAt} — ${countLabel(messages.length)} messages`
    + (capped ? ` — newest ${countLabel(EXPORT_CAP)} only (export cap)` : ''));
  parts.push('');
  for (const message of messages) {
    const sender = SENDER_LABELS[message.source] ?? message.source;
    parts.push(`### ${sender} — ${message.createdAt} — hop ${message.hop}`, '');
    const fence = fenceFor(message.body);
    parts.push(fence, message.body, fence, '');
    for (const row of deliveries) {
      if (row.messageId === message.id) parts.push(`Delivery: ${row.target} ${row.status}`);
    }
    parts.push('');
  }
  return parts.join('\n').trimEnd() + '\n';
}
