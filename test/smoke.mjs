// End-to-end smoke test: starts real sessions, posts comments the way the
// browser page does, and checks what Claude would receive.
// Run: mise run test   (or: node test/smoke.mjs)
import { spawn } from 'node:child_process';
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
