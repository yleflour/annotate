// Unit tests for the git/difftastic changes the page highlights. Builds a
// throwaway git repo where HEAD, the index and the working tree all differ.
// Needs git and difftastic (difft) on PATH.
// Run: mise run test   (or: node test/changes.test.mjs)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { gitChanges, lineRanges, fromDifft, project, toLines } from '../plugins/annotate/skills/annotate/changes.mjs';

async function test(name, fn) {
  try { await fn(); console.log('ok  ', name); }
  catch (e) { console.log('FAIL', name, '\n', e.message); process.exitCode = 1; }
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'annotate-git-'));
const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: repo, stdio: 'pipe' });
const write = (name, text) => fs.writeFileSync(path.join(repo, name), text);
const changes = (name) => gitChanges(path.join(repo, name), toLines(fs.readFileSync(path.join(repo, name), 'utf8')));
git('init', '-q');

await test('byte offsets become character offsets; a fully listed line is the whole line', () => {
  const tok = (s, e, content = 'x') => ({ start: s, end: e, content });
  // "é" is 2 bytes, "😀" 4 bytes (2 UTF-16 units).
  assert.deepEqual(lineRanges('café = 1', [tok(7, 8)]), [[6, 7]]);
  assert.deepEqual(lineRanges('a = "😀"; f(1)', [tok(14, 15)]), [[12, 13]]);
  assert.deepEqual(lineRanges('x = 1 + 2', [tok(4, 5), tok(5, 6), tok(6, 7)]), [[4, 7]], 'adjacent tokens merge');
  assert.deepEqual(lineRanges('  ab cd', [tok(2, 4), tok(5, 7)]), [], 'every word changed = whole line');
  assert.deepEqual(lineRanges('ab', [tok(1, 1, '')]), [], 'empty tokens are ignored');
});

await test('old lines are placed before the line they became, removed lines after the previous one', () => {
  const d = fromDifft({ status: 'changed', aligned_lines: [[0, 0], [1, null], [2, 1]], chunks: [[
    { lhs: { line_number: 1, changes: [{ start: 0, end: 1, content: 'b' }] } },
    { lhs: { line_number: 2, changes: [{ start: 0, end: 1, content: 'c' }] }, rhs: { line_number: 1, changes: [{ start: 0, end: 1, content: 'C' }] } },
  ]] }, ['a', 'b', 'c'], ['a', 'C']);
  const v = project(d, ['a', 'b', 'c'], ['a', 'C'], ['a', 'C']);
  assert.deepEqual(v.add, { 2: [] });
  assert.deepEqual(v.del, [{ after: 1, lines: [{ text: 'b', ranges: [] }, { text: 'c', ranges: [] }] }]);
  assert.equal(v.added, 1); assert.equal(v.removed, 2);
});

await test('unstaged, staged and all views on the working-tree lines', async () => {
  write('a.js', 'const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\n');
  git('add', 'a.js'); git('commit', '-qm', 'init');
  write('a.js', 'const alpha = 10;\nconst beta = 2;\nconst gamma = 3;\n');
  git('add', 'a.js'); // staged: alpha = 1 -> 10
  write('a.js', '// header\nconst alpha = 10;\nconst gamma = 30;\n'); // unstaged: new comment, beta removed, gamma = 3 -> 30
  const { modes: { unstaged, staged, all } } = await changes('a.js');

  assert.deepEqual(Object.keys(unstaged.add), ['1', '3']);
  assert.deepEqual(unstaged.add[3], [[14, 16]], 'only the changed token "30"');
  assert.deepEqual(unstaged.del.flatMap((g) => g.lines.map((l) => l.text)), ['const beta = 2;', 'const gamma = 3;']);

  // HEAD -> index, shown on the working tree: index line 1 is working-tree line 2.
  assert.deepEqual(staged.add, { 2: [[14, 16]] });
  assert.deepEqual(staged.del, [{ after: 1, lines: [{ text: 'const alpha = 1;', ranges: [[14, 15]] }] }]);

  assert.deepEqual(Object.keys(all.add), ['1', '2', '3']);
  assert.equal(all.removed, 3);
});

await test('Markdown (difftastic Text mode) with accents: whole changed lines', async () => {
  write('doc.md', '# Titre\n\nCafé **été**\n');
  git('add', 'doc.md'); git('commit', '-qm', 'doc');
  write('doc.md', '# Titre\n\nCafé **hiver**\nNouvelle ligne\n');
  const { modes } = await changes('doc.md');
  assert.deepEqual(modes.unstaged.add, { 3: [], 4: [] });
  assert.deepEqual(modes.unstaged.del, [{ after: 2, lines: [{ text: 'Café **été**', ranges: [] }] }]);
  assert.equal(modes.staged.added + modes.staged.removed, 0);
});

await test('new file staged but never committed; untracked; unchanged; outside git', async () => {
  write('new.txt', 'one\ntwo\n');
  git('add', 'new.txt');
  const { modes } = await changes('new.txt');
  assert.deepEqual(modes.staged.add, { 1: [], 2: [] });
  assert.equal(modes.unstaged.added, 0);
  assert.deepEqual(modes.all.add, { 1: [], 2: [] });

  write('loose.txt', 'x\n');
  assert.deepEqual(await changes('loose.txt'), { untracked: true });

  git('commit', '-qm', 'more');
  const clean = await changes('new.txt');
  for (const v of Object.values(clean.modes)) assert.equal(v.added + v.removed, 0);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'annotate-nogit-'));
  fs.writeFileSync(path.join(outside, 'f.txt'), 'x\n');
  assert.equal(await gitChanges(path.join(outside, 'f.txt'), ['x']), null);
});
