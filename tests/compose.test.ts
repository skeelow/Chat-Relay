// M4.1 — hermetic tests for the GUI's pure compose decisions
// (app/src/compose.ts): the @-prefix parser that picks the target and the
// sendability rules. The renderer owns the DOM; nothing here touches it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCompose } from '../app/src/compose.ts';

test('parseCompose: the @-prefix wins over the selector', () => {
  assert.deepEqual(parseCompose('@codex hello there', 'astra'), { ok: true, body: 'hello there', targets: ['codex'] });
  assert.deepEqual(parseCompose('@astra hi', 'codex'), { ok: true, body: 'hi', targets: ['astra'] });
  assert.deepEqual(parseCompose('@both hi', 'codex'), { ok: true, body: 'hi', targets: ['astra', 'codex'] });
});

test('parseCompose: the prefix is case-insensitive', () => {
  assert.deepEqual(parseCompose('@Astra hi', 'both'), { ok: true, body: 'hi', targets: ['astra'] });
  assert.deepEqual(parseCompose('@CoDeX hi', 'both'), { ok: true, body: 'hi', targets: ['codex'] });
  assert.deepEqual(parseCompose('@BOTH hi', 'astra'), { ok: true, body: 'hi', targets: ['astra', 'codex'] });
});

test('parseCompose: with no prefix the selector decides', () => {
  assert.deepEqual(parseCompose('just talking', 'codex'), { ok: true, body: 'just talking', targets: ['codex'] });
  assert.deepEqual(parseCompose('just talking', 'both'), { ok: true, body: 'just talking', targets: ['astra', 'codex'] });
  assert.deepEqual(parseCompose('just talking', 'astra'), { ok: true, body: 'just talking', targets: ['astra'] });
  assert.deepEqual(parseCompose('  indented, no prefix  ', 'codex'), { ok: true, body: 'indented, no prefix', targets: ['codex'] });
});

test('parseCompose: a mid-sentence mention is not a prefix; no word boundary is not either', () => {
  assert.deepEqual(parseCompose('ask @codex later, please', 'both'),
    { ok: true, body: 'ask @codex later, please', targets: ['astra', 'codex'] });
  assert.deepEqual(parseCompose('@astrahello', 'codex'),
    { ok: true, body: '@astrahello', targets: ['codex'] }, 'the tag must end at a word boundary');
  assert.deepEqual(parseCompose('@codex, hi', 'both'),
    { ok: true, body: 'hi', targets: ['codex'] }, 'punctuation after the tag still counts');
});

test('parseCompose: empty or whitespace-only text cannot be sent', () => {
  assert.deepEqual(parseCompose('', 'both'), { ok: false, reason: 'empty' });
  assert.deepEqual(parseCompose('   \n\t ', 'both'), { ok: false, reason: 'empty' });
  assert.deepEqual(parseCompose('@codex', 'both'), { ok: false, reason: 'empty' }, 'a bare prefix leaves no body');
  assert.deepEqual(parseCompose('  @codex   ', 'both'), { ok: false, reason: 'empty' });
});

test('parseCompose: over the 20,000-character engine cap the send is refused, text kept', () => {
  assert.deepEqual(parseCompose(`@codex ${'x'.repeat(20001)}`, 'both'), { ok: false, reason: 'too-long' });
  assert.deepEqual(parseCompose(`@codex ${'x'.repeat(20000)}`, 'both'),
    { ok: true, body: 'x'.repeat(20000), targets: ['codex'] }, 'exactly at the cap is fine');
});

test('parseCompose: an unknown selector falls back to both', () => {
  assert.deepEqual(parseCompose('hi', 'not-a-choice'), { ok: true, body: 'hi', targets: ['astra', 'codex'] });
});
