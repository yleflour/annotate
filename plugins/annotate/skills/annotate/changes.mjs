// changes.mjs: the file's uncommitted git changes, diffed by difftastic
// (https://difftastic.wilfred.me.uk) and projected onto the working-tree file,
// so the page can highlight them. Node only (runs in the server, not the page).
//
// Three views, all expressed in working-tree line numbers:
//   unstaged  index -> working tree   (git diff)
//   staged    HEAD  -> index          (git diff --cached), mapped onto the working tree
//   all       HEAD  -> working tree   (git diff HEAD)
//
// A view is { add, del, added, removed }:
//   add: { [line]: ranges }  changed/added working-tree lines (1-based). ranges are
//        [start, end) character offsets of the changed tokens; [] = the whole line.
//   del: [{ after, lines: [{ text, ranges }] }]  old lines (removed, or the old
//        version of a changed line), shown after working-tree line `after` (0 = top).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DIFF_MODES = ['off', 'unstaged', 'staged', 'all'];

const run = (cmd, args, opts = {}) => new Promise((res) =>
  execFile(cmd, args, { maxBuffer: 256 << 20, timeout: 30000, windowsHide: true, ...opts },
    (err, stdout, stderr) => res({ err, stdout, stderr })));

export function toLines(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const same = (a, b) => a.length === b.length && a.every((l, i) => l === b[i]);

// difftastic reports UTF-8 byte offsets; the page needs UTF-16 string offsets.
function byteToIndex(line) {
  const map = new Map();
  let b = 0;
  for (let i = 0; i < line.length;) {
    map.set(b, i);
    const cp = line.codePointAt(i);
    b += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += cp > 0xffff ? 2 : 1;
  }
  map.set(b, line.length);
  return (x) => map.get(x) ?? line.length;
}

// Merge the changed tokens of one line into character ranges. If they cover
// every non-blank character (difftastic's line-based Text mode lists every
// word of a changed line), return [] to mean "the whole line".
export function lineRanges(line, changes) {
  const at = byteToIndex(line);
  const rs = changes.filter((c) => c.content !== '' && c.end > c.start)
    .map((c) => [at(c.start), at(c.end)]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  let gap = false;
  let pos = 0;
  for (const [s, e] of out) { if (line.slice(pos, s).trim()) gap = true; pos = e; }
  if (!gap && !line.slice(pos).trim()) return [];
  return out;
}

// Pair lines when difftastic gives no alignment (no syntactic change, or one
// side missing): common prefix and suffix, then the middle side by side.
function fallbackAlign(lhs, rhs) {
  let p = 0;
  while (p < lhs.length && p < rhs.length && lhs[p] === rhs[p]) p++;
  let s = 0;
  while (s < lhs.length - p && s < rhs.length - p && lhs[lhs.length - 1 - s] === rhs[rhs.length - 1 - s]) s++;
  const out = [];
  for (let i = 0; i < p; i++) out.push([i, i]);
  const ml = lhs.length - p - s, mr = rhs.length - p - s;
  for (let i = 0; i < Math.max(ml, mr); i++) out.push([i < ml ? p + i : null, i < mr ? p + i : null]);
  for (let i = s; i > 0; i--) out.push([lhs.length - i, rhs.length - i]);
  return out;
}

// Turn one difftastic JSON result into { align, lhs, rhs }: the line alignment
// (0-based [lhs|null, rhs|null] pairs) and the changed lines on each side
// (Map of 0-based line -> ranges). lhs or rhs is null when that side is absent.
export function fromDifft(json, lhs, rhs) {
  const L = lhs || [], R = rhs || [];
  const res = { align: null, lhs: new Map(), rhs: new Map() };
  if (!lhs || !rhs || json.status === 'created' || json.status === 'deleted') {
    res.align = !lhs ? R.map((_, r) => [null, r]) : !rhs ? L.map((_, l) => [l, null]) : fallbackAlign(L, R);
    if (!lhs) R.forEach((t, r) => { if (t.trim()) res.rhs.set(r, []); });
    if (!rhs) L.forEach((t, l) => { if (t.trim()) res.lhs.set(l, []); });
    return res;
  }
  res.align = json.aligned_lines || fallbackAlign(L, R);
  for (const chunk of json.chunks || []) {
    for (const row of chunk) {
      for (const [side, lines, map] of [['lhs', L, res.lhs], ['rhs', R, res.rhs]]) {
        const s = row[side];
        if (!s || !s.changes || !s.changes.some((c) => c.content !== '')) continue;
        const text = lines[s.line_number] ?? '';
        if (!text.trim()) continue;
        map.set(s.line_number, lineRanges(text, s.changes));
      }
    }
  }
  // A non-blank line with no counterpart is new (or gone) even if difftastic
  // listed no token for it.
  for (const [l, r] of res.align) {
    if (l == null && r != null && R[r]?.trim() && !res.rhs.has(r)) res.rhs.set(r, []);
    if (r == null && l != null && L[l]?.trim() && !res.lhs.has(l)) res.lhs.set(l, []);
  }
  return res;
}

// Express a diff (old -> new) in working-tree lines. `toWork` maps a 0-based
// line of the new side to a 0-based working-tree line (or null if that line
// is gone from the working tree); `newLines`/`work` let token ranges be kept
// only where the line text is still the same.
export function project(d, oldLines, newLines, work, toWork = (r) => r) {
  const add = {};
  let added = 0, removed = 0;
  for (const [r, ranges] of d.rhs) {
    const w = toWork(r);
    if (w == null) continue;
    add[w + 1] = newLines[r] === work[w] ? ranges : [];
    added++;
  }
  // Where an old line goes: before the new line it is paired with, else after
  // the last new line seen. Then mapped onto the working tree.
  const del = [];
  let lastNew = -1;
  const afterWork = (newIdx) => { // newIdx: 0-based new line to insert after, -1 = top
    for (let k = newIdx; k >= 0; k--) { const w = toWork(k); if (w != null) return w + 1; }
    return 0;
  };
  for (const [l, r] of d.align) {
    if (l != null && d.lhs.has(l)) {
      const w = r != null ? toWork(r) : null;
      const after = w != null ? w : afterWork(r != null ? r - 1 : lastNew);
      const line = { text: oldLines[l], ranges: d.lhs.get(l) };
      const prev = del[del.length - 1];
      if (prev && prev.after === after) prev.lines.push(line); else del.push({ after, lines: [line] });
      removed++;
    }
    if (r != null) lastNew = r;
  }
  return { add, del, added, removed };
}

const EMPTY = () => ({ add: {}, del: [], added: 0, removed: 0 });
const identity = (lines) => ({ align: lines.map((_, i) => [i, i]), lhs: new Map(), rhs: new Map() });

class DifftMissing extends Error {}

async function difft(tmp, name, lhs, rhs) {
  if (lhs && rhs && same(lhs, rhs)) return identity(rhs);
  const dir = fs.mkdtempSync(path.join(tmp, 'd'));
  const a = path.join(dir, 'a'), b = path.join(dir, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  // Same file name on both sides, so difftastic detects the language.
  fs.writeFileSync(path.join(a, name), lhs ? lhs.join('\n') + '\n' : '');
  fs.writeFileSync(path.join(b, name), rhs ? rhs.join('\n') + '\n' : '');
  const { err, stdout, stderr } = await run('difft', ['--display', 'json', '--color', 'never', path.join(a, name), path.join(b, name)],
    { env: { ...process.env, DFT_UNSTABLE: 'yes' } });
  if (err && err.code === 'ENOENT') throw new DifftMissing();
  let json;
  try { json = JSON.parse(stdout); } catch {
    throw new Error(`difftastic failed: ${String(stderr || (err && err.message) || stdout).trim().split('\n')[0]}`);
  }
  if (Array.isArray(json)) json = json[0] || {};
  return fromDifft(json, lhs, rhs);
}

// The working-tree file's changes, or null when it is not in a git repository.
// Returns { untracked } | { error } | { modes: { unstaged, staged, all } }.
export async function gitChanges(file, work) {
  const cwd = path.dirname(file);
  const rel = './' + path.basename(file);
  const git = (...a) => run('git', a, { cwd });
  if ((await git('rev-parse', '--is-inside-work-tree')).err) return null;
  const ls = (await git('ls-files', '-s', '--', rel)).stdout.trim().split('\n').filter(Boolean);
  if (!ls.length) return { untracked: true };
  if (ls.length > 1) return { error: 'the file has unresolved merge conflicts' };
  const blob = await git('cat-file', 'blob', ls[0].split(/\s+/)[1]);
  if (blob.err) return { error: 'could not read the staged version' };
  const index = toLines(blob.stdout);
  const headBlob = await git('cat-file', 'blob', 'HEAD:' + rel);
  const head = headBlob.err ? null : toLines(headBlob.stdout); // not committed yet

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'annotate-diff-'));
  const name = path.basename(file);
  try {
    const [unstaged, staged, all] = await Promise.all([
      difft(tmp, name, index, work),
      head && same(head, index) ? identity(index) : difft(tmp, name, head, index),
      head && same(head, work) ? identity(work) : difft(tmp, name, head, work),
    ]);
    const indexToWork = new Map();
    for (const [l, r] of unstaged.align) if (l != null && r != null) indexToWork.set(l, r);
    return {
      modes: {
        unstaged: project(unstaged, index, work, work),
        staged: head && same(head, index) ? EMPTY() : project(staged, head || [], index, work, (r) => indexToWork.get(r) ?? null),
        all: project(all, head || [], work, work),
      },
    };
  } catch (e) {
    if (e instanceof DifftMissing) return { error: 'difftastic is not installed (the `difft` command was not found)' };
    return { error: e.message };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
