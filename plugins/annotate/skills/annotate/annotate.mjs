#!/usr/bin/env node
// annotate.mjs: open a file in the browser, let the user leave line-anchored
// comments, and print them for Claude. No dependencies. Windows/macOS/Linux.
//
//   node annotate.mjs <file>      start a session and wait for the comments
//   node annotate.mjs --wait <id> keep waiting on a session that is still open
//   node annotate.mjs --serve <id> (internal) the detached local web server

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.join(os.tmpdir(), 'claude-annotate');
// Stay under Claude Code's 10-minute Bash timeout, then hand back "PENDING".
const WAIT_MS = Number(process.env.ANNOTATE_WAIT_MS || 540000);
const IDLE_MS = 6 * 60 * 60 * 1000; // server gives up after 6h
const MAX_BYTES = 5 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sessionDir = (id) => path.join(ROOT, String(id).replace(/[^a-f0-9]/gi, ''));

const args = process.argv.slice(2);
if (args[0] === '--serve') serve(args[1]);
else if (args[0] === '--wait') waitFor(args[1]);
else if (args.length && !args[0].startsWith('--')) start(args.join(' '));
else {
  console.log('Usage: node annotate.mjs <file>   |   node annotate.mjs --wait <session-id>');
  process.exit(2);
}

// ---------- launcher ----------
function normalizePath(p) {
  p = p.trim().replace(/^["']|["']$/g, '');
  // Git Bash / MSYS style /c/Users/... -> C:/Users/...
  if (process.platform === 'win32') {
    const m = p.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (m) p = `${m[1].toUpperCase()}:${m[2] || '/'}`;
  }
  return path.resolve(p);
}

function cleanupOld() {
  try {
    for (const name of fs.readdirSync(ROOT)) {
      const d = path.join(ROOT, name);
      if (Date.now() - fs.statSync(d).mtimeMs > 24 * 3600 * 1000) fs.rmSync(d, { recursive: true, force: true });
    }
  } catch {}
}

function openBrowser(url) {
  if (process.env.ANNOTATE_NO_OPEN) return Promise.resolve(true);
  let cmd;
  if (process.platform === 'win32') cmd = `start "" "${url}"`;
  else if (process.platform === 'darwin') cmd = `open "${url}"`;
  else cmd = `xdg-open "${url}"`;
  return new Promise((res) => exec(cmd, { windowsHide: true }, (err) => res(!err)));
}

async function start(fileArg) {
  const file = normalizePath(fileArg);
  let st;
  try { st = fs.statSync(file); } catch { console.log(`ERROR: file not found: ${file}`); process.exit(1); }
  if (!st.isFile()) { console.log(`ERROR: not a file: ${file}`); process.exit(1); }
  if (st.size > MAX_BYTES) { console.log(`ERROR: file is larger than 5 MB: ${file}`); process.exit(1); }
  const head = fs.readFileSync(file).subarray(0, 8000);
  if (head.includes(0)) { console.log(`ERROR: looks like a binary file: ${file}`); process.exit(1); }

  fs.mkdirSync(ROOT, { recursive: true });
  cleanupOld();
  const id = crypto.randomBytes(6).toString('hex');
  const dir = sessionDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.json'),
    JSON.stringify({ file, token: crypto.randomBytes(16).toString('hex') }));

  // Detached so the page keeps working even if this waiting process times out.
  spawn(process.execPath, [SELF, '--serve', id], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

  const urlFile = path.join(dir, 'url');
  const t0 = Date.now();
  while (!fs.existsSync(urlFile)) {
    if (Date.now() - t0 > 15000) { console.log('ERROR: the annotation server did not start.'); process.exit(1); }
    await sleep(100);
  }
  const url = fs.readFileSync(urlFile, 'utf8').trim();
  const opened = await openBrowser(url);
  if (!opened) {
    console.log(`OPEN_FAILED ${id}\nCould not open a browser. Ask the user to open ${url}\n` +
      `then run: node "${SELF}" --wait ${id}`);
    process.exit(0);
  }
  await waitFor(id);
}

async function waitFor(id) {
  const dir = sessionDir(id);
  const result = path.join(dir, 'result.md');
  if (!fs.existsSync(path.join(dir, 'session.json')) && !fs.existsSync(result)) {
    console.log(`ERROR: no annotation session ${id} (it may have expired).`);
    process.exit(1);
  }
  const t0 = Date.now();
  while (true) {
    if (fs.existsSync(result)) {
      await sleep(150); // let the write finish
      process.stdout.write(fs.readFileSync(result, 'utf8'));
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      process.exit(0);
    }
    if (!serverAlive(dir)) {
      console.log('ERROR: the annotation page was closed on the server side without sending comments.');
      process.exit(1);
    }
    if (Date.now() - t0 > WAIT_MS) {
      let url = '';
      try { url = fs.readFileSync(path.join(dir, 'url'), 'utf8').trim(); } catch {}
      console.log(`PENDING ${id}\nThe user is still annotating (${url}).\n` +
        `Keep waiting by running: node "${SELF}" --wait ${id}`);
      process.exit(0);
    }
    await sleep(500);
  }
}

function serverAlive(dir) {
  try {
    const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM' || !fs.existsSync(path.join(dir, 'pid')) ? true : false;
  }
}

// ---------- server ----------
function serve(id) {
  const dir = sessionDir(id);
  const { file, token } = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
  let snapshot = [];

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const prefix = `/${token}/`;
    if (!u.pathname.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
    const route = u.pathname.slice(prefix.length);

    if (req.method === 'GET' && route === '') {
      let text = '';
      let mtime = 0;
      try { text = fs.readFileSync(file, 'utf8'); mtime = fs.statSync(file).mtimeMs; } catch {}
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      snapshot = text.split(/\r?\n/);
      if (snapshot.length > 1 && snapshot[snapshot.length - 1] === '') snapshot.pop();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page({ file, name: path.basename(file), lines: snapshot, mtime }));
      return;
    }

    if (req.method === 'POST' && route === 'submit') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
      req.on('end', () => {
        let data;
        try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
        fs.writeFileSync(path.join(dir, 'result.md'), format(file, snapshot, data));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        setTimeout(() => process.exit(0), 300);
      });
      return;
    }
    res.writeHead(404); res.end();
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    fs.writeFileSync(path.join(dir, 'url'), `http://127.0.0.1:${port}/${token}/`);
  });
  setTimeout(() => process.exit(0), IDLE_MS);
}

function format(file, lines, data) {
  if (data.cancelled) return `CANCELLED: the user discarded the annotation session for ${file} without sending comments.\n`;
  const comments = (data.comments || [])
    .filter((c) => c && String(c.text || '').trim())
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const general = String(data.general || '').trim();
  let out = `ANNOTATIONS for ${file}\n`;
  if (!comments.length && !general) return out + 'The user reviewed the file and approved it with no comments.\n';
  out += `${comments.length} inline comment(s). Line numbers refer to the file as the user saw it.\n\n`;
  comments.forEach((c, i) => {
    const s = Math.max(1, c.start | 0), e = Math.max(s, c.end | 0);
    out += `### ${i + 1}. ${s === e ? `Line ${s}` : `Lines ${s}-${e}`}\n`;
    if (c.selection) {
      out += `Selected text: "${String(c.selection).slice(0, 500)}"\n`;
    } else {
      const shown = lines.slice(s - 1, Math.min(e, s - 1 + 8));
      out += '````\n' + shown.join('\n') + (e - s + 1 > 8 ? '\n…' : '') + '\n````\n';
    }
    out += `Comment: ${String(c.text).trim()}\n\n`;
  });
  if (general) out += `### General comment\n${general}\n`;
  return out;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page(d) {
  const json = JSON.stringify(d).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Annotate · ${esc(d.name)}</title>
<style>
:root{--bg:#fbfaf8;--fg:#1d1d1f;--muted:#76746f;--line:#e6e4df;--gutter:#f3f1ec;--sel:#fff1bf;--cm:#ffe08a;--cmrow:#fff8dc;--accent:#c2410c;--panel:#fff;--card:#fffdf5;--btn:#1d1d1f;--btnfg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#17171a;--fg:#e9e7e3;--muted:#9a9893;--line:#2d2d31;--gutter:#1e1e22;--sel:#4b3f10;--cm:#7a5f12;--cmrow:#2a2512;--accent:#fb923c;--panel:#1f1f23;--card:#26241c;--btn:#e9e7e3;--btnfg:#17171a}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;grid-template-columns:minmax(0,1fr) 330px}
main{overflow:auto;height:100vh;position:relative}
.top{position:sticky;top:0;left:0;z-index:3;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:16px;align-items:center;justify-content:space-between}
.top b{font-size:15px}
.path{font:12px ui-monospace,Consolas,monospace;color:var(--muted);word-break:break-all}
.hint{font-size:12px;color:var(--muted);white-space:nowrap}
.hint label{cursor:pointer}
#code{font:13px/20px ui-monospace,"Cascadia Code",Consolas,monospace;padding:8px 0 45vh;width:max-content;min-width:100%}
body.wrap #code{width:auto}
.row{display:flex;min-height:20px}
.g{flex:0 0 var(--gw);text-align:right;padding:0 10px 0 4px;color:var(--muted);background:var(--gutter);user-select:none;cursor:pointer;border-right:1px solid var(--line);position:sticky;left:0;z-index:1}
.g:hover{color:var(--accent);font-weight:600}
.c{white-space:pre;padding:0 14px;tab-size:4}
body.wrap .c{white-space:pre-wrap;word-break:break-word;flex:1;min-width:0}
.row.has{background:var(--cmrow)}
.row.has .g{background:var(--cm);color:var(--fg)}
.row.sel,.row.sel .g{background:var(--sel)}
.flash{animation:fl 1.2s}
@keyframes fl{0%{background:var(--accent)}100%{}}
.box{position:sticky;left:calc(var(--gw) + 14px);width:min(620px,calc(100vw - 400px));margin:6px 0 10px calc(var(--gw) + 14px);border:1px solid var(--line);border-left:3px solid var(--accent);background:var(--card);border-radius:6px;padding:10px 12px;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.box .meta{font-size:12px;color:var(--muted);margin-bottom:6px}
.box .q{font:12px ui-monospace,Consolas,monospace;color:var(--muted);border-left:2px solid var(--line);padding-left:8px;margin:0 0 8px;white-space:pre-wrap;max-height:90px;overflow:hidden}
.box textarea,#general{width:100%;min-height:80px;resize:vertical;border:1px solid var(--line);border-radius:5px;padding:8px;font:inherit;background:var(--bg);color:var(--fg)}
.box .txt{white-space:pre-wrap}
.acts{display:flex;gap:8px;justify-content:flex-end;margin-top:8px;align-items:center}
.acts .k{margin-right:auto;font-size:11px;color:var(--muted)}
button{font:inherit;font-size:13px;border-radius:5px;border:1px solid var(--line);background:transparent;color:var(--fg);padding:5px 12px;cursor:pointer}
button.primary{background:var(--btn);color:var(--btnfg);border-color:var(--btn)}
button.link{border:0;padding:2px 4px;color:var(--muted)}
button.link:hover{color:var(--accent)}
aside{border-left:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;height:100vh}
aside h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:16px 16px 8px}
#list{flex:1;overflow:auto;padding:0 8px}
#list .empty{color:var(--muted);font-size:13px;padding:4px 8px;line-height:1.5}
.item{padding:8px;border-radius:5px;cursor:pointer;font-size:13px}
.item:hover{background:var(--gutter)}
.item .ln{font:11px ui-monospace,Consolas,monospace;color:var(--accent)}
.item .t{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.foot{border-top:1px solid var(--line);padding:12px 16px 16px;display:flex;flex-direction:column;gap:10px}
.foot label{font-size:12px;color:var(--muted)}
#general{min-height:70px}
#send{padding:9px;font-weight:600}
#selbtn{position:fixed;z-index:10;display:none;background:var(--btn);color:var(--btnfg);border:0;box-shadow:0 2px 8px rgba(0,0,0,.25)}
.done{display:grid;place-items:center;height:100vh;grid-column:1/-1;text-align:center}
.done h1{font-size:20px;margin:0 0 6px}
.done p{color:var(--muted);margin:0}
</style></head>
<body>
<main id="main">
  <div class="top">
    <div><b>${esc(d.name)}</b><div class="path">${esc(d.file)}</div></div>
    <div class="hint">Click or drag line numbers, or highlight text, to comment ·
      <label><input type="checkbox" id="wrap"> Wrap</label></div>
  </div>
  <div id="code"></div>
</main>
<aside>
  <h2>Comments</h2>
  <div id="list"></div>
  <div class="foot">
    <label for="general">General comment (optional)</label>
    <textarea id="general" placeholder="Anything that applies to the whole file…"></textarea>
    <button class="primary" id="send">Approve with no comments</button>
    <button class="link" id="discard">Discard and close</button>
  </div>
</aside>
<button id="selbtn">💬 Comment</button>
<script type="application/json" id="data">${json}</script>
<script>
(() => {
  const D = JSON.parse(document.getElementById('data').textContent);
  const KEY = 'annotate:' + D.file + ':' + D.mtime;
  const code = document.getElementById('code');
  const list = document.getElementById('list');
  const sendBtn = document.getElementById('send');
  const general = document.getElementById('general');
  const selBtn = document.getElementById('selbtn');
  document.documentElement.style.setProperty('--gw', (String(D.lines.length).length + 2.5) + 'ch');

  let comments = [], nextId = 1, selA = null, selB = null, dragging = false, pendingSel = null;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved) { comments = saved.comments || []; general.value = saved.general || ''; nextId = comments.reduce((m, c) => Math.max(m, c.id), 0) + 1; }
  } catch {}

  const rows = [];
  const frag = document.createDocumentFragment();
  D.lines.forEach((t, i) => {
    const r = document.createElement('div'); r.className = 'row'; r.dataset.n = i + 1;
    const g = document.createElement('span'); g.className = 'g'; g.textContent = i + 1;
    const c = document.createElement('span'); c.className = 'c'; c.textContent = t;
    r.append(g, c); rows.push(r); frag.append(r);
  });
  code.append(frag);

  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify({ comments, general: general.value })); } catch {} };
  general.addEventListener('input', () => { persist(); updateSend(); });

  function paintSel() {
    code.querySelectorAll('.row.sel').forEach(r => r.classList.remove('sel'));
    if (selA == null) return;
    const a = Math.min(selA, selB), b = Math.max(selA, selB);
    for (let i = a; i <= b; i++) rows[i - 1].classList.add('sel');
  }
  function clearSel() { selA = selB = null; paintSel(); }
  const rowOf = n => n && (n.nodeType === 3 ? n.parentElement : n).closest('.row');

  code.addEventListener('mousedown', e => {
    const g = e.target.closest('.g'); if (!g) return;
    e.preventDefault();
    const n = +g.parentElement.dataset.n;
    if (e.shiftKey && selA != null) selB = n; else selA = selB = n;
    dragging = true; paintSel();
  });
  code.addEventListener('mouseover', e => {
    if (!dragging) return;
    const r = e.target.closest('.row'); if (r) { selB = +r.dataset.n; paintSel(); }
  });
  window.addEventListener('mouseup', e => {
    if (dragging) { dragging = false; openComposer(Math.min(selA, selB), Math.max(selA, selB)); return; }
    if (e.target === selBtn) return;
    setTimeout(() => {
      const s = window.getSelection();
      selBtn.style.display = 'none'; pendingSel = null;
      if (!s || s.isCollapsed) return;
      const a = rowOf(s.anchorNode), b = rowOf(s.focusNode);
      if (!a || !b || !code.contains(a)) return;
      const text = s.toString(); if (!text.trim()) return;
      const x = +a.dataset.n, y = +b.dataset.n;
      pendingSel = { start: Math.min(x, y), end: Math.max(x, y), selection: text };
      selBtn.style.left = Math.min(e.clientX + 8, innerWidth - 130) + 'px';
      selBtn.style.top = (e.clientY + 12) + 'px';
      selBtn.style.display = 'block';
    }, 0);
  });
  selBtn.addEventListener('mousedown', e => e.preventDefault());
  selBtn.addEventListener('click', () => {
    selBtn.style.display = 'none';
    if (!pendingSel) return;
    const p = pendingSel; pendingSel = null;
    window.getSelection().removeAllRanges();
    selA = p.start; selB = p.end; paintSel();
    openComposer(p.start, p.end, p.selection);
  });

  function afterRow(n) {
    let node = rows[n - 1];
    while (node.nextSibling && node.nextSibling.classList && node.nextSibling.classList.contains('box')) node = node.nextSibling;
    return node;
  }
  const label = (a, b) => a === b ? 'Line ' + a : 'Lines ' + a + '–' + b;

  function openComposer(start, end, selection, existing) {
    document.querySelectorAll('.composer').forEach(c => c.remove());
    render();
    if (existing) { const card = code.querySelector('.card[data-id="' + existing.id + '"]'); if (card) card.style.display = 'none'; }
    const box = document.createElement('div'); box.className = 'box composer';
    const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = label(start, end);
    box.append(meta);
    if (selection) { const q = document.createElement('div'); q.className = 'q'; q.textContent = selection; box.append(q); }
    const ta = document.createElement('textarea'); ta.placeholder = 'What should Claude do here?';
    if (existing) ta.value = existing.text;
    const acts = document.createElement('div'); acts.className = 'acts';
    acts.innerHTML = '<span class="k">Ctrl+Enter to save · Esc to cancel</span>';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    const save = document.createElement('button'); save.className = 'primary'; save.textContent = existing ? 'Update' : 'Add comment';
    acts.append(cancel, save); box.append(ta, acts);
    afterRow(end).after(box);
    ta.focus();
    const close = () => { box.remove(); clearSel(); render(); };
    cancel.onclick = close;
    save.onclick = () => {
      const text = ta.value.trim(); if (!text) { ta.focus(); return; }
      if (existing) existing.text = text;
      else comments.push({ id: nextId++, start, end, selection: selection || null, text });
      persist(); close();
    };
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save.click(); }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
  }

  function render() {
    code.querySelectorAll('.card').forEach(c => c.remove());
    code.querySelectorAll('.row.has').forEach(r => r.classList.remove('has'));
    comments.sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id);
    for (const c of comments) {
      for (let i = c.start; i <= c.end; i++) rows[i - 1] && rows[i - 1].classList.add('has');
      const card = document.createElement('div'); card.className = 'box card'; card.dataset.id = c.id;
      const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = label(c.start, c.end);
      card.append(meta);
      if (c.selection) { const q = document.createElement('div'); q.className = 'q'; q.textContent = c.selection; card.append(q); }
      const t = document.createElement('div'); t.className = 'txt'; t.textContent = c.text;
      const acts = document.createElement('div'); acts.className = 'acts';
      const ed = document.createElement('button'); ed.className = 'link'; ed.textContent = 'Edit';
      const del = document.createElement('button'); del.className = 'link'; del.textContent = 'Delete';
      ed.onclick = () => openComposer(c.start, c.end, c.selection, c);
      del.onclick = () => { comments = comments.filter(x => x !== c); persist(); render(); };
      acts.append(ed, del); card.append(t, acts);
      const anchor = afterRow(c.end);
      if (anchor.classList.contains('composer')) anchor.before(card); else anchor.after(card);
    }
    list.innerHTML = '';
    if (!comments.length) {
      list.innerHTML = '<div class="empty">No comments yet. Click a line number (shift-click or drag for a range), or highlight text and press “Comment”.</div>';
    }
    for (const c of comments) {
      const it = document.createElement('div'); it.className = 'item';
      const ln = document.createElement('div'); ln.className = 'ln'; ln.textContent = label(c.start, c.end);
      const t = document.createElement('div'); t.className = 't'; t.textContent = c.text;
      it.append(ln, t);
      it.onclick = () => {
        const r = rows[c.start - 1]; r.scrollIntoView({ block: 'center', behavior: 'smooth' });
        r.classList.remove('flash'); void r.offsetWidth; r.classList.add('flash');
      };
      list.append(it);
    }
    updateSend();
  }
  function updateSend() {
    const n = comments.length, g = general.value.trim();
    sendBtn.textContent = n ? 'Send ' + n + ' comment' + (n > 1 ? 's' : '') + ' to Claude' : g ? 'Send comment to Claude' : 'Approve with no comments';
  }

  async function submit(payload) {
    sendBtn.disabled = true;
    try {
      const r = await fetch('submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!r.ok) throw new Error(r.status);
      try { localStorage.removeItem(KEY); } catch {}
      document.body.innerHTML = '<div class="done"><div><h1>' + (payload.cancelled ? 'Discarded' : 'Sent to Claude') +
        '</h1><p>You can close this tab and go back to Claude Code.</p></div></div>';
    } catch (e) {
      sendBtn.disabled = false;
      alert('Could not reach Claude Code. Your comments are kept in this tab; try again, or restart /annotate.');
    }
  }
  sendBtn.onclick = () => submit({ comments: comments.map(({ start, end, selection, text }) => ({ start, end, selection, text })), general: general.value });
  document.getElementById('discard').onclick = () => { if (confirm('Discard all comments and close this session?')) submit({ cancelled: true }); };

  const wrap = document.getElementById('wrap');
  try { wrap.checked = localStorage.getItem('annotate:wrap') === '1'; } catch {}
  const applyWrap = () => { document.body.classList.toggle('wrap', wrap.checked); try { localStorage.setItem('annotate:wrap', wrap.checked ? '1' : '0'); } catch {} };
  wrap.onchange = applyWrap; applyWrap();

  render();
})();
</script>
</body></html>`;
}
