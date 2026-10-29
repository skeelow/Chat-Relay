// Unit tests for the pure logic in scripts/preflight.mjs.
// Sample texts cover: a ticked item without Evidence:, Surprises: none without
// (checked: …), a deletion of 20 lines not mentioned in Removed:, an
// out-of-scope file, and a CR-only change.
//
// scripts/preflight.mjs is outside the tsconfig `include` and is an untyped
// .mjs module, so the import is intentionally untyped here.

// @ts-nocheck -- imports the untyped scripts/preflight.mjs module from a type-checked test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkStatusFile,
  parseNumstat,
  deletedSourceFiles,
  scopeProblems,
  isFlakyTestName,
  isBuiltFile,
  checkRemoved,
} from '../scripts/preflight.mjs';

test('checkStatusFile: a ticked item whose [x] lacks Evidence: fails', () => {
  const text = `Task: t1\nResult: pass\nItems:\n- [x] do something\n- [ ] do other\nRemoved: none\nSurprises: none (checked: nothing)\nOpen questions: none`;
  const r = checkStatusFile(text);
  assert.equal(r.pass, false);
  assert.ok(r.fails.some((f) => f.includes('lacks Evidence')));
});

test('checkStatusFile: Surprises: none without (checked: …) fails', () => {
  const text = `Task: t1\nResult: pass\nItems:\n- [x] do something Evidence: ran npm test\nRemoved: none\nSurprises: none\nOpen questions: none`;
  const r = checkStatusFile(text);
  assert.equal(r.pass, false);
  assert.ok(r.fails.some((f) => f.includes('(checked:')));
});

test('checkStatusFile: a valid status file passes', () => {
  const text = `Task: t1\nResult: pass\nItems:\n- [x] one Evidence: ran npm test\n- [ ] two\nRemoved: none\nSurprises: none (checked: everything)\nOpen questions: none`;
  const r = checkStatusFile(text);
  assert.equal(r.pass, true);
});

test('checkStatusFile: more than 40 lines fails', () => {
  const lines = ['Task: t', 'Result: pass', 'Items:'];
  for (let i = 0; i < 40; i++) lines.push('- [ ] item Evidence: x');
  lines.push('Removed: none');
  lines.push('Surprises: none (checked: x)');
  lines.push('Open questions: none');
  const r = checkStatusFile(lines.join('\n'));
  assert.equal(r.pass, false);
  assert.ok(r.fails.some((f) => f.includes('limit 40')));
});

test('parseNumstat: parses added and deleted line counts', () => {
  const files = parseNumstat('5\t3\tadapters/hermes/adapter.ts\n0\t0\tapp/dist/x.js\n');
  assert.deepEqual(files['adapters/hermes/adapter.ts'], { added: 5, deleted: 3 });
  assert.deepEqual(files['app/dist/x.js'], { added: 0, deleted: 0 });
});

test('deletedSourceFiles: returns non-test files with >= 15 deleted lines', () => {
  const files = deletedSourceFiles(
    '10\t20\tsrc/a.ts\n5\t2\tsrc/b.ts\n3\t30\ttests/c.test.ts\n0\t16\tapp/dist/d.js\n',
  );
  assert.deepEqual(files.map((f) => f.path), ['src/a.ts']);
});

test('deletedSourceFiles: a CR-only change shows 0 deleted lines', () => {
  const files = deletedSourceFiles('0\t0\tadapters/chatgpt-ext/dist/x.js\n');
  assert.deepEqual(files, []);
});

test('scopeProblems: an out-of-scope file is reported', () => {
  const problems = scopeProblems(
    ['scripts/preflight.mjs', 'relay/store.ts', 'docs/status/t1.md', 'app/dist/x.js'],
    ['scripts/preflight.mjs'],
    't1',
  );
  assert.deepEqual(problems, ['relay/store.ts']);
});

test('scopeProblems: the status file, built files and in-scope files are allowed', () => {
  const problems = scopeProblems(
    ['docs/status/t1.md', 'adapters/chatgpt-ext/dist/x.js', 'scripts/preflight.mjs'],
    ['scripts/preflight.mjs'],
    't1',
  );
  assert.deepEqual(problems, []);
});

test('isBuiltFile: dist folders are built files', () => {
  assert.equal(isBuiltFile('adapters/chatgpt-ext/dist/x.js'), true);
  assert.equal(isBuiltFile('app/dist/y.js'), true);
  assert.equal(isBuiltFile('src/a.ts'), false);
  assert.equal(isBuiltFile('tests/x.test.ts'), false);
});

test('isFlakyTestName: matches the known flaky restart test', () => {
  assert.equal(
    isFlakyTestName('restart: a delivering user row returns to pending and nothing is re-sent'),
    true,
  );
  assert.equal(
    isFlakyTestName('restart: a delivering user row returns to pending and nothing is re-sent x'),
    true,
  );
  assert.equal(isFlakyTestName('some other test'), false);
});

test('checkRemoved: deletion of 20 lines not named in Removed: fails', () => {
  const r = checkRemoved([{ path: 'relay/engine.ts', deleted: 20 }], 'Removed: none');
  assert.equal(r.pass, false);
  assert.ok(r.lines.some((l) => l.includes('FAIL removed: relay/engine.ts deleted 20 lines')));
});

test('checkRemoved: deletion named in Removed: passes', () => {
  const r = checkRemoved([{ path: 'relay/engine.ts', deleted: 20 }], 'Removed: relay/engine.ts (20 deleted lines) removed the stale loop');
  assert.equal(r.pass, true);
  assert.ok(r.lines.some((l) => l.includes('PASS removed: relay/engine.ts')));
});

test('checkRemoved: empty list with Removed: none passes', () => {
  const r = checkRemoved([], 'Removed: none');
  assert.equal(r.pass, true);
  assert.ok(r.lines.some((l) => l.includes("PASS removed: no source files deleted")));
});

test('checkRemoved: empty list without none fails', () => {
  const r = checkRemoved([], 'Removed: something else');
  assert.equal(r.pass, false);
  assert.ok(r.lines.some((l) => l.includes("FAIL removed: no deleted source files")));
});
