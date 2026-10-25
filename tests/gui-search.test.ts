// M4.3 — hermetic tests for app/src/search.ts, the GUI's pure search
// decisions: the exact frames, query validation, the snippet around a match,
// and the stale-requestId rule (a new query supersedes an older one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySearchResult, closeSearch, emptySearchState, isSearchQueryValid, searchFrame,
  snippetAround, startSearch, exportFrame,
} from '../app/src/search.ts';

test('isSearchQueryValid: trimmed length 1 to 200', () => {
  assert.equal(isSearchQueryValid('needle'), true);
  assert.equal(isSearchQueryValid('  needle  '), true);
  assert.equal(isSearchQueryValid('   '), false, 'whitespace only');
  assert.equal(isSearchQueryValid(''), false);
  assert.equal(isSearchQueryValid('x'.repeat(200)), true, '200 is allowed');
  assert.equal(isSearchQueryValid('x'.repeat(201)), false, '201 is not');
});

test('searchFrame and exportFrame are exactly the protocol frames', () => {
  assert.equal(JSON.stringify(searchFrame('r1', '  needle  ')), '{"type":"search","requestId":"r1","query":"needle"}',
    'the query is sent trimmed');
  assert.equal(JSON.stringify(exportFrame('r2')), '{"type":"export","requestId":"r2"}');
});

test('snippetAround: the window around the first case-insensitive match', () => {
  assert.equal(snippetAround('the needle is here', 'needle'), 'the needle is here', 'a short body is whole');
  const long = `${'a'.repeat(80)}needle${'b'.repeat(80)}`;
  assert.equal(snippetAround(long, 'NEEDLE'), `…${'a'.repeat(40)}needle${'b'.repeat(40)}…`,
    'case-insensitive, 40 characters of context each side, ellipses where cut');
  assert.equal(snippetAround(`${'a'.repeat(80)}needle`, 'needle'), `…${'a'.repeat(40)}needle`, 'cut only the start');
  assert.equal(snippetAround(`needle${'b'.repeat(80)}`, 'needle'), `needle${'b'.repeat(40)}…`, 'cut only the end');
  assert.equal(snippetAround('nothing here', 'needle'), 'nothing here', 'no match still shows the start');
  const veryLong = 'x'.repeat(300);
  assert.equal(snippetAround(veryLong, 'needle'), `…${'x'.repeat(79)}…`, 'a no-match long body is trimmed too');
});

test('the search state: a matching requestId stores the results; a stale one is ignored', () => {
  let state = emptySearchState();
  assert.equal(state.open, false);
  state = startSearch(state, 'r1', 'needle');
  assert.equal(state.open, true);
  assert.equal(applySearchResult(state, { requestId: 'r0', messages: [], total: 0 }), null,
    'a result for an older request is stale');
  const applied = applySearchResult(state, { requestId: 'r1', messages: [{ id: '01A' }], total: 7 });
  assert.notEqual(applied, null);
  assert.equal(applied?.total, 7);
  assert.equal(applied?.results.length, 1);
  state = startSearch(state, 'r2', 'other'); // supersedes r1
  assert.equal(applySearchResult(state, { requestId: 'r1', messages: [{ id: '01A' }], total: 7 }), null,
    'the superseded request no longer applies');
  state = closeSearch(state);
  assert.equal(state.open, false);
  assert.equal(applySearchResult(state, { requestId: 'r2', messages: [], total: 0 }), null,
    'a closed panel ignores late results');
});
