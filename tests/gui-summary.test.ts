// M5.2 — hermetic tests for app/src/summary.ts, the GUI's pure session
// summary line: the exact text (zero, singular, plural), the emphasis flag,
// and the locale-driven time formatting. The time is rendered in the local
// timezone from the ISO `since`, so the time-of-day is matched by shape,
// not by a fixed clock reading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryLine, type SessionSummary } from '../app/src/summary.ts';

const base = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({ turnsUsed: 0, held: 0, approvalsPending: 0, since: '2026-10-25T14:02:00.000Z', ...over });

test('summaryLine: zero, singular and plural, with the emphasis flag', () => {
  const shape = (line: { text: string } | null): string => line?.text.replace(/\d{2}:\d{2}/, 'HH:MM') ?? '';
  assert.equal(shape(summaryLine(base())),
    'Session since HH:MM · 0 AI turns · 0 held · 0 approvals waiting');
  assert.equal(shape(summaryLine(base({ turnsUsed: 1 }))),
    'Session since HH:MM · 1 AI turn · 0 held · 0 approvals waiting');
  assert.equal(shape(summaryLine(base({ turnsUsed: 7, held: 2 }))),
    'Session since HH:MM · 7 AI turns · 2 held · 0 approvals waiting');
  assert.equal(summaryLine(base())?.approvalsEmphasised, false);
  assert.equal(shape(summaryLine(base({ approvalsPending: 1 }))),
    'Session since HH:MM · 0 AI turns · 0 held · 1 approval waiting');
  assert.equal(summaryLine(base({ approvalsPending: 1 }))?.approvalsEmphasised, true,
    'waiting approvals are emphasised');
  assert.equal(shape(summaryLine(base({ turnsUsed: 7, held: 1, approvalsPending: 3 }))),
    'Session since HH:MM · 7 AI turns · 1 held · 3 approvals waiting');
  assert.equal(summaryLine(base({ approvalsPending: 3 }))?.approvalsEmphasised, true);
});

test('summaryLine: no summary means no line', () => {
  assert.equal(summaryLine(null), null);
});

test('summaryLine: the time is local and follows the locale shape', () => {
  const enGb = summaryLine(base())?.text ?? '';
  assert.match(enGb, /Session since \d{2}:\d{2} ·/, 'en-GB default: 24-hour clock');
  const enUs = summaryLine(base(), 'en-US')?.text ?? '';
  assert.match(enUs, /Session since \d{1,2}:\d{2} (AM|PM) ·/, 'en-US: 12-hour clock with AM/PM');
  assert.equal(enGb.startsWith('Session since '), true);
});
