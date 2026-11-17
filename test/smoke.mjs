// End-to-end smoke test: starts real sessions, posts comments the way the
// browser page does, and checks what the harness would receive.
// Run: mise run test   (or: node test/smoke.mjs)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, '..', 'plugins', 'annotate', 'skills', 'annotate', 'annotate.mjs');
const ROOT = path.join(os.tmpdir(), 'claude-annotate');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'annotate-test-'));
const file = path.join(tmp, 'plan with spaces.md');
fs.writeFileSync(file, '# Plan\r\n\r\n1. Add login\r\n2. Add logout\r\n3. Write tests\r\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(args, env = {}) {
  const p = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ANNOTATE_NO_OPEN: '1', ...env } });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  return { done: new Promise((r) => p.on('exit', (code) => r({ code, out }))) };
}

async function newestSession(before) {
  for (let i = 0; i < 100; i++) {
    const ids = fs.existsSync(ROOT) ? fs.readdirSync(ROOT).filter((d) => !before.has(d)) : [];
    for (const id of ids) {
      const u = path.join(ROOT, id, 'url');
      if (fs.existsSync(u)) return { id, url: fs.readFileSync(u, 'utf8').trim() };
    }
    await sleep(100);
  }
  throw new Error('session did not start');
}
const existing = () => new Set(fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []);
const submit = (url, body) => fetch(url + 'submit', { method: 'POST', body: JSON.stringify(body) });

async function test(name, fn) {
  try { await fn(); console.log('ok  ', name); }
  catch (e) { console.log('FAIL', name, '\n', e.message); process.exitCode = 1; }
}

await test('comments round-trip, CRLF file, path with spaces', async () => {
  const before = existing();
  const r = run([file]);
  const { url } = await newestSession(before);
  const html = await (await fetch(url)).text();
  assert.match(html, /"lines":\["# Plan","","1\. Add login","2\. Add logout","3\. Write tests"\]/);
  assert.equal((await fetch(url.replace(/\/[^/]+\/$/, '/wrong/'))).status, 404);
  await submit(url, {
    comments: [
      { start: 4, end: 4, text: 'Drop logout' },
      { start: 3, end: 3, selection: 'Add login', text: 'Use OAuth' },
    ],
    general: 'Keep it short.',
  });
  const { code, out } = await r.done;
  assert.equal(code, 0);
  assert.match(out, /^ANNOTATIONS for .*plan with spaces\.md/);
  assert.match(out, /### 1\. Line 3\nSelected text: "Add login"\nComment: Use OAuth/);
  assert.match(out, /### 2\. Line 4\n````\n2\. Add logout\n````\nComment: Drop logout/);
  assert.match(out, /### General comment\nKeep it short\./);
});

await test('PENDING hand-off, then --wait picks up an approval', async () => {
  const before = existing();
  const first = await run([file], { ANNOTATE_WAIT_MS: '800' }).done;
  assert.match(first.out, /^PENDING [a-f0-9]+/);
  const { id, url } = await newestSession(before);
  const r = run(['--wait', id]);
  await sleep(300);
  await submit(url, { comments: [], general: '' });
  const { out } = await r.done;
  assert.match(out, /approved it with no comments/);
});

await test('cancel', async () => {
  const before = existing();
  const r = run([file]);
  const { url } = await newestSession(before);
  await submit(url, { cancelled: true });
  assert.match((await r.done).out, /^CANCELLED/);
});

await test('errors', async () => {
  assert.match((await run([path.join(tmp, 'missing.txt')]).done).out, /^ERROR: file not found/);
  assert.match((await run(['--wait', 'deadbeef']).done).out, /^ERROR: no annotation session/);
});

await test('Markdown file: page gets the Markdown view and Pele; table and diagram comments anchor to source lines', async () => {
  const md = path.join(here, 'fixtures', 'adr-fr.md');
  const src = fs.readFileSync(md, 'utf8').split('\n');
  const lineOf = (needle) => src.findIndex((l) => l.includes(needle)) + 1;
  const before = existing();
  const r = run([md]);
  const { url } = await newestSession(before);
  const html = await (await fetch(url)).text();
  assert.match(html, /"markdown":true/);
  assert.match(html, /"src":"https:\/\/cdn\.jsdelivr\.net\/npm\/pele@\d+\.\d+\.\d+\/dist\/pele\.global\.js","integrity":"sha384-[A-Za-z0-9+/=]+"/);
  assert.match(html, /function scanMarkdown\(lines\)/, 'markdown helpers are inlined');
  assert.doesNotMatch(html.split('<script>')[1], /^export /m);
  const row = lineOf('| `Conversion`'), m = lineOf('```mermaid'), node = lineOf('P_TT["');
  // What the page sends for: a table cell selection, a click on a diagram node, the whole diagram.
  await submit(url, {
    comments: [
      { start: row, end: row, selection: 'Étapes 2 et 3.', text: 'Préciser' },
      { start: m, end: m + 9, selection: `Mermaid diagram, node P_TT at line ${node}: l_tt sous-écran télétravail`, text: 'Renommer' },
      { start: m, end: m + 9, selection: null, text: 'Diagramme trop chargé' },
    ],
    general: '',
  });
  const { out } = await r.done;
  assert.match(out, new RegExp(`### 1\\. Line ${row}\\nSelected text: "Étapes 2 et 3\\."\\nComment: Préciser`));
  assert.match(out, new RegExp(`### 2\\. Lines ${m}-${m + 9}\\nSelected text: "Mermaid diagram, node P_TT at line ${node}: l_tt sous-écran télétravail"\\nComment: Renommer`));
  assert.match(out, new RegExp(`### 3\\. Lines ${m}-${m + 9}\\n\`\`\`\`\\n\`\`\`mermaid\\nflowchart TB\\n[\\s\\S]*?\\n…\\n\`\`\`\`\\nComment: Diagramme trop chargé`));
});

await test('non-Markdown file stays plain', async () => {
  const ts = path.join(tmp, 'a.ts');
  fs.writeFileSync(ts, 'const a = 1; // **not markdown**\n');
  const before = existing();
  const r = run([ts]);
  const { url } = await newestSession(before);
  assert.match(await (await fetch(url)).text(), /"markdown":false/);
  await submit(url, { cancelled: true });
  await r.done;
});

await test('git changes: --diff picks the view, the page gets the difftastic views, the harness is told which was shown', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'annotate-git-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: repo, stdio: 'pipe' });
  const f = path.join(repo, 'plan.md');
  git('init', '-q');
  fs.writeFileSync(f, '# Plan\n\nStep one\n');
  git('add', '.'); git('commit', '-qm', 'init');
  fs.writeFileSync(f, '# Plan\n\nStep one\nStep two\n');
  git('add', '.');
  fs.writeFileSync(f, '# Plan\n\nStep 1\nStep two\n');

  assert.match((await run(['--diff', 'bogus', f]).done).out, /^ERROR: --diff must be one of off, unstaged, staged, all/);
  const before = existing();
  const r = run(['--diff=staged', f]);
  const { url } = await newestSession(before);
  const html = await (await fetch(url)).text();
  const D = JSON.parse(html.match(/<script type="application\/json" id="data">(.*?)<\/script>/s)[1]);
  assert.equal(D.diff, 'staged');
  assert.deepEqual(D.changes.modes.staged.add, { 4: [] });
  assert.deepEqual(D.changes.modes.unstaged.add, { 3: [] });
  assert.deepEqual(D.changes.modes.unstaged.del, [{ after: 2, lines: [{ text: 'Step one', ranges: [] }] }]);
  await submit(url, { comments: [{ start: 4, end: 4, text: 'Merge with step 1' }], general: '', diff: 'staged' });
  const { out } = await r.done;
  assert.match(out, /The user was viewing the file with its staged git changes highlighted\./);
});
