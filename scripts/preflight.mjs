// scripts/preflight.mjs
//
// Preflight checks run before reporting a task done. Prints one line per
// check (`PASS`, `FAIL` or `WARN` plus the reason) and a final
// `PREFLIGHT: PASS` or `PREFLIGHT: FAIL`, and exits 1 on any FAIL.
//
// Usage: node scripts/preflight.mjs --task <id> --scope <comma-separated paths>
//
// Pure logic (status parser, scope matcher, numstat parser, flaky matcher)
// is exported and unit tested in tests/preflight.test.ts. It never commits,
// pushes or edits anything.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REPO = process.cwd();

// Known-flaky test names (the packet seeds this with one entry).
export const KNOWN_FLAKY = [
  'restart: a delivering user row returns to pending and nothing is re-sent',
];

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let task = null;
  let scope = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--task') task = argv[++i];
    else if (argv[i] === '--scope') scope = argv[++i];
  }
  return { task, scope: scope.split(',').map((s) => s.trim()).filter(Boolean) };
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

// Run a shell command, never throw on nonzero exit.
function run(command) {
  const { status, stdout, stderr } = spawnSync(command, {
    shell: true,
    encoding: 'utf8',
    cwd: REPO,
    maxBuffer: 50 * 1024 * 1024,
  });
  return { code: status === null ? 1 : status, stdout: String(stdout), stderr: String(stderr) };
}

function git(args) {
  return run('git ' + args.join(' '));
}

// ---------------------------------------------------------------------------
// Pure logic (exported for unit tests)
// ---------------------------------------------------------------------------

export function isBuiltFile(file) {
  return (
    file.startsWith('adapters/chatgpt-ext/dist/') || file.startsWith('app/dist/')
  );
}

export function isTestFile(file) {
  return file.startsWith('tests/') || file.endsWith('.test.ts');
}

export function parseStatusFile(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let surprises = null;
  let surprisesIndex = -1;
  let removed = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^-\s*\[(x|)\](.*)$/);
    if (m) {
      items.push({ checked: m[1] === 'x', rest: m[2], line, index: i });
    }
    if (/^Surprises:/.test(line)) {
      surprises = line;
      surprisesIndex = i;
    }
    if (/^Removed:/.test(line)) {
      removed = line;
    }
  }
  return { lines, items, surprises, surprisesIndex, removed, lineCount: lines.length };
}

// Check the structural status-file rules the preflight can verify.
export function checkStatusFile(text) {
  const { lines, items, surprises, surprisesIndex, removed, lineCount } =
    parseStatusFile(text);
  const result = { pass: true, warns: [], fails: [] };

  if (lineCount > 40) {
    result.pass = false;
    result.fails.push(`status file is ${lineCount} lines (limit 40)`);
  }

  for (const item of items) {
    if (item.checked) {
      const onSameLine = /Evidence:\s*\S.{9,}/.test(item.rest);
      const onNextLine =
        lines[item.index + 1] && /^(\s*)Evidence:\s*\S.{9,}/.test(lines[item.index + 1]);
      if (!onSameLine && !onNextLine) {
        result.pass = false;
        result.fails.push(`ticked item lacks Evidence: (>=10 chars): ${item.line}`);
      }
    } else {
      result.warns.push(`unticked item: ${item.line}`);
    }
  }

  if (!surprises) {
    result.pass = false;
    result.fails.push('missing Surprises: line');
  } else if (/^Surprises:\s*none\b/i.test(surprises)) {
    const onSameLine = /\(checked:\s*.+/i.test(surprises);
    const onNextLine =
      lines[surprisesIndex + 1] && /\(checked:\s*.+/i.test(lines[surprisesIndex + 1]);
    if (!onSameLine && !onNextLine) {
      result.pass = false;
      result.fails.push('Surprises: none must be followed by (checked: <what you checked>)');
    }
  }

  if (!removed) {
    result.pass = false;
    result.fails.push('missing Removed: line');
  }

  return result;
}

export function parseNumstat(text) {
  const files = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const m = line.match(/^(\d+)\t(\d+)\t(.+)$/);
    if (m) {
      let path = m[3];
      if (path.includes(' => ')) path = path.split(' => ')[1].trim();
      files[path] = { added: +m[1], deleted: +m[2] };
    }
  }
  return files;
}

// Files (non-test source, non-built) with >= 15 deleted lines.
export function deletedSourceFiles(numstatText) {
  const files = parseNumstat(numstatText);
  const out = [];
  for (const [path, stat] of Object.entries(files)) {
    if (isTestFile(path)) continue;
    if (isBuiltFile(path)) continue;
    if (stat.deleted >= 15) out.push({ path, deleted: stat.deleted });
  }
  return out;
}

export function isFlakyTestName(name) {
  return KNOWN_FLAKY.some((f) => name === f || name.startsWith(f));
}

// Scope check: every changed/new file must be in scope, be the status file,
// or be a built dist file.
export function scopeProblems(changedFiles, scopeList, task) {
  const statusFile = `docs/status/${task}.md`;
  const problems = [];
  for (const file of changedFiles) {
    if (file === statusFile) continue;
    if (isBuiltFile(file)) continue;
    if (scopeList.includes(file)) continue;
    problems.push(file);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Repository state
// ---------------------------------------------------------------------------

function getChangedFiles() {
  const res = git(['status', '--porcelain', '--untracked-files=all']);
  const files = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const rest = line.slice(3);
    let path = rest;
    if (rest.includes(' -> ')) path = rest.split(' -> ')[1].trim();
    path = path.trim();
    if (path) files.push(path);
  }
  return files;
}

// ---------------------------------------------------------------------------
// Step checks
// ---------------------------------------------------------------------------

function step1Scope(scopeList, task) {
  const changed = getChangedFiles();
  const problems = scopeProblems(changed, scopeList, task);
  if (problems.length > 0) {
    return { pass: false, line: `FAIL scope: out-of-scope file(s): ${problems.join(', ')}` };
  }
  return { pass: true, line: `PASS scope: ${changed.length} file(s) changed, all in scope or built` };
}

function step2Typecheck() {
  const res = run('npm run typecheck');
  if (res.code === 0) return { pass: true, line: 'PASS typecheck: clean' };
  return { pass: false, line: 'FAIL typecheck: ' + (res.stderr || res.stdout).trim().split('\n').slice(-3).join(' | ') };
}

function parseTestOutput(output) {
  const testsM = output.match(/ℹ tests (\d+)/);
  const passM = output.match(/ℹ pass (\d+)/);
  const failM = output.match(/ℹ fail (\d+)/);
  const failingNames = [];
  const failIdx = output.indexOf('failing tests:');
  if (failIdx !== -1) {
    const section = output.slice(failIdx);
    for (const line of section.split(/\r?\n/)) {
      const m = line.match(/^\s{4}'([^']+)'/);
      if (m) failingNames.push(m[1]);
    }
  }
  return {
    tests: testsM ? +testsM[1] : 0,
    pass: passM ? +passM[1] : 0,
    fail: failM ? +failM[1] : 0,
    failingNames,
  };
}

async function step3Tests() {
  const first = run('npm test');
  const p1 = parseTestOutput(first.stdout);
  const lines = [];
  if (p1.fail === 0) {
    lines.push(`PASS tests: ${p1.pass} pass / ${p1.fail} fail (${p1.tests} total)`);
    return { pass: true, lines };
  }
  if (p1.fail === 1 && p1.failingNames.length === 1 && isFlakyTestName(p1.failingNames[0])) {
    lines.push(`WARN tests run 1: flaky failure '${p1.failingNames[0]}', rerunning`);
    const second = run('npm test');
    const p2 = parseTestOutput(second.stdout);
    lines.push(`PASS tests run 2: ${p2.pass} pass / ${p2.fail} fail (${p2.tests} total)`);
    lines.push(`Flaky failure '${p1.failingNames[0]}' on run 1, clean on run 2`);
    return { pass: p2.fail === 0, lines };
  }
  lines.push(
    `FAIL tests: ${p1.fail} failure(s)${p1.failingNames.length ? ' (' + p1.failingNames.join(', ') + ')' : ''}`,
  );
  return { pass: false, lines };
}

function step4Builds() {
  const lines = [];
  let allOk = true;
  for (const script of ['build:ext', 'build:gui']) {
    const res = run(`npm run ${script}`);
    if (res.code !== 0) {
      allOk = false;
      lines.push(`FAIL build:${script.split(':')[1]}: exited ${res.code}`);
      continue;
    }
    // Content-only diff check on the dist folder (CR-only changes ignored).
    const folder = script === 'build:ext' ? 'adapters/chatgpt-ext/dist' : 'app/dist';
    const diff = git(['diff', '--ignore-cr-at-eol', '--quiet', '--', folder]);
    if (diff.code !== 0) {
      allOk = false;
      lines.push(`FAIL build:${script.split(':')[1]}: built output differs from committed`);
    } else {
      lines.push(`PASS build:${script.split(':')[1]}: no content change`);
    }
  }
  return { pass: allOk, lines };
}

function step5StatusFile(task) {
  const path = `docs/status/${task}.md`;
  if (!existsSync(path)) {
    return { pass: false, line: `FAIL status: ${path} missing` };
  }
  const text = readFileSync(path, 'utf8');
  const result = checkStatusFile(text);
  const lines = [];
  if (result.pass) lines.push(`PASS status: ${path} (${result.lineCount || text.split(/\r?\n/).length} lines)`);
  else lines.push(`FAIL status: ${path}`);
  for (const f of result.fails) lines.push(`  FAIL ${f}`);
  for (const w of result.warns) lines.push(`  WARN ${w}`);
  return { pass: result.pass, lines };
}

// Exported pure function: checks that every deleted source file is named in
// the status file's `Removed:` line. Returns {pass, lines}.
export function checkRemoved(deletedFiles, removedText) {
  const lines = [];
  let allOk = true;
  if (deletedFiles.length === 0) {
    if (!/\bnone\b/i.test(removedText)) {
      allOk = false;
      lines.push(`FAIL removed: no deleted source files but Removed: does not say 'none'`);
    } else {
      lines.push(`PASS removed: no source files deleted (Removed: none)`);
    }
  } else {
    for (const entry of deletedFiles) {
      const f = entry.path;
      const deleted = entry.deleted;
      if (!removedText.includes(f)) {
        allOk = false;
        lines.push(`FAIL removed: ${f} deleted ${deleted} lines but not named in Removed:`);
      } else {
        lines.push(`PASS removed: ${f} (${deleted} deleted lines) named in Removed:`);
      }
    }
  }
  return { pass: allOk, lines };
}

function step6DeletedBehaviour(task) {
  const diff = git(['diff', 'HEAD', '--numstat']);
  const deleted = deletedSourceFiles(diff.stdout);
  const path = `docs/status/${task}.md`;
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const removedLine = text.match(/^Removed:\s*(.*)$/m);
  const removedText = removedLine ? removedLine[1] : '';
  return checkRemoved(deleted, removedText);
}

function step7DebugLeftovers(scopeList) {
  const warnings = [];
  // Added lines in modified (unstaged) tracked files.
  const diff = git(['diff', '-U0']);
  for (const line of diff.stdout.split(/\r?\n/)) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const content = line.slice(1);
    if (
      content.includes('debugger') ||
      content.includes("console.log('DEBUG") ||
      content.includes('.only(') ||
      content.includes('TODO')
    ) {
      warnings.push(`DEBUG leftover added line: ${content.slice(0, 90)}`);
    }
  }
  // New untracked files: check all lines.
  const status = git(['status', '--porcelain', '--untracked-files=all']);
  for (const line of status.stdout.split(/\r?\n/)) {
    if (!line.startsWith('??')) continue;
    const path = line.slice(3).trim();
    if (path === 'scripts/preflight.mjs') continue;
    if (!scopeList.includes(path)) continue;
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, 'utf8');
      for (const srcLine of content.split(/\r?\n/)) {
        if (
          srcLine.includes('debugger') ||
          srcLine.includes("console.log('DEBUG") ||
          srcLine.includes('.only(') ||
          srcLine.includes('TODO')
        ) {
          warnings.push(`DEBUG leftover in ${path}: ${srcLine.slice(0, 90)}`);
        }
      }
    } catch { /* ignore unreadable */ }
  }
  const lines = warnings.map((w) => `WARN ${w}`);
  if (lines.length === 0) lines.push('PASS debug: no debugger/TODO/.only/console.log("DEBUG leftovers');
  return { pass: true, lines }; // debug is WARN only, never FAIL
}

// ---------------------------------------------------------------------------
// CLI main
// ---------------------------------------------------------------------------

async function main() {
  const { task, scope: scopeList } = parseArgs(process.argv.slice(2));
  if (!task) {
    console.error('Usage: node scripts/preflight.mjs --task <id> --scope <comma-separated paths>');
    process.exit(2);
  }

  const allLines = [];
  let overall = true;

  const s1 = step1Scope(scopeList, task);
  allLines.push(s1.line);
  overall = overall && s1.pass;

  const s2 = step2Typecheck();
  allLines.push(s2.line);
  overall = overall && s2.pass;

  const s3 = await step3Tests();
  allLines.push(...s3.lines);
  overall = overall && s3.pass;

  const s4 = step4Builds();
  allLines.push(...s4.lines);
  overall = overall && s4.pass;

  const s5 = step5StatusFile(task);
  allLines.push(...s5.lines);
  overall = overall && s5.pass;

  const s6 = step6DeletedBehaviour(task);
  allLines.push(...s6.lines);
  overall = overall && s6.pass;

  const s7 = step7DebugLeftovers(scopeList);
  allLines.push(...s7.lines);

  const verdict = overall ? 'PREFLIGHT: PASS' : 'PREFLIGHT: FAIL';
  console.log(allLines.join('\n'));
  console.log(verdict);
  process.exit(overall ? 0 : 1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
