#!/usr/bin/env node
// annotate.mjs: open a file in the browser, let the user leave line-anchored
// comments, and print them for your harness. No npm dependencies. Windows/macOS/Linux.
// Markdown files get syntax highlighting, tables shown as tables, and mermaid
// blocks drawn as diagrams you can click to comment on. Uncommitted git changes
// (unstaged, staged or all) are highlighted with difftastic when it is installed.
//
//   node annotate.mjs [--diff <off|unstaged|staged|all>] <file>
//                                 start a session and wait for the comments
//   node annotate.mjs --wait <id> keep waiting on a session that is still open
//   node annotate.mjs --serve <id> (internal) the detached local web server

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MD_FILE, themeCss, codeLang } from './markdown.mjs';
import { gitChanges, DIFF_MODES } from './changes.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.join(os.tmpdir(), 'claude-annotate');
// Stay under the harness's 10-minute Bash timeout, then hand back "PENDING".
const WAIT_MS = Number(process.env.ANNOTATE_WAIT_MS || 540000);
const IDLE_MS = 6 * 60 * 60 * 1000; // server gives up after 6h
const MAX_BYTES = 5 * 1024 * 1024;
// Mermaid diagrams are drawn in the page by Pele (https://pele.run, MIT),
// loaded from jsDelivr only when the file has a mermaid block. Pinned + SRI.
const PELE = {
  src: 'https://cdn.jsdelivr.net/npm/pele@1.12.0/dist/pele.global.js',
  integrity: 'sha384-c+QpxCAcAD72seekPP6lAUNHjqe/wUv+S2pk2yBo4ECNKMxym7WFtKKoR5xMtyhz',
};
// Pure Markdown helpers, shared with the tests and inlined into the page.
const MD_JS = fs.readFileSync(path.join(path.dirname(SELF), 'markdown.mjs'), 'utf8').replace(/^export /gm, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sessionDir = (id) => path.join(ROOT, String(id).replace(/[^a-f0-9]/gi, ''));

const args = process.argv.slice(2);
if (args[0] === '--serve') serve(args[1]);
else if (args[0] === '--wait') waitFor(args[1]);
else {
  // --diff <mode> or --diff=<mode> anywhere; everything else is the path (spaces allowed).
  let diff = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const m = args[i].match(/^--diff(?:=(.*))?$/);
    if (m) diff = m[1] ?? args[++i] ?? '';
    else rest.push(args[i]);
  }
  if (diff != null && !DIFF_MODES.includes(diff)) {
    console.log(`ERROR: --diff must be one of ${DIFF_MODES.join(', ')}`);
    process.exit(2);
  }
  if (rest.length && !rest[0].startsWith('--')) start(rest.join(' '), diff);
  else {
    console.log('Usage: node annotate.mjs [--diff off|unstaged|staged|all] <file>   |   node annotate.mjs --wait <session-id>');
    process.exit(2);
  }
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

async function start(fileArg, diff) {
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
    JSON.stringify({ file, diff, token: crypto.randomBytes(16).toString('hex') }));

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
  const { file, token, diff } = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
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
      const lines = text.split(/\r?\n/);
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      snapshot = lines;
      // Diffed against exactly the lines the page shows.
      gitChanges(file, lines).catch((e) => ({ error: e.message })).then((changes) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(page({ file, name: path.basename(file), lines, mtime, markdown: MD_FILE.test(file), code: MD_FILE.test(file) ? null : codeLang(path.extname(file).slice(1)), pele: PELE, changes, diff }));
      });
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
  out += `${comments.length} inline comment(s). Line numbers refer to the file as the user saw it.\n`;
  const shown = { unstaged: 'unstaged', staged: 'staged', all: 'uncommitted (staged and unstaged)' }[data.diff];
  if (shown) out += `The user was viewing the file with its ${shown} git changes highlighted.\n`;
  out += '\n';
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
${themeCss()}
:root{--bg:var(--oc-background);--fg:var(--oc-markdownText);--muted:var(--oc-textMuted);--line:var(--oc-borderSubtle);--gutter:var(--oc-backgroundPanel);--panel:var(--oc-backgroundPanel);
  --sel:#fff1bf;--cm:#ffe08a;--cmrow:#fff8dc;--accent:#c2410c;--card:#fffdf5;--btn:#1d1d1f;--btnfg:#fff}
@media (prefers-color-scheme:dark){:root{--sel:#4b3f10;--cm:#7a5f12;--cmrow:#2a2512;--accent:#fb923c;--card:#1e1c16;--btn:#e9e7e3;--btnfg:#17171a}}
/* git changes (difftastic): line background, gutter bar, token highlight */
:root{--add:#e6ffec;--addbar:#2da44e;--del:#ffebe9;--delbar:#cf222e}
@media (prefers-color-scheme:dark){:root{--add:#12261e;--addbar:#3fb950;--del:#2d1517;--delbar:#f85149}}
::highlight(dadd){background-color:#abf2bc}
::highlight(ddel){background-color:#ffc1c0}
@media (prefers-color-scheme:dark){::highlight(dadd){background-color:#1f6f3a}::highlight(ddel){background-color:#8e2b2f}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;grid-template-columns:minmax(0,1fr) 330px}
main{overflow:auto;height:100vh;position:relative}
.top{position:sticky;top:0;left:0;z-index:3;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;justify-content:space-between}
.top b{font-size:15px}
.path{font:12px ui-monospace,Consolas,monospace;color:var(--muted);word-break:break-all}
.hint{font-size:12px;color:var(--muted);text-align:right}
.hint label{cursor:pointer;white-space:nowrap;margin-left:8px}
#code{font:13px/20px ui-monospace,"Cascadia Code",Consolas,monospace;padding:8px 0 45vh;width:max-content;min-width:100%}
body.wrap #code{width:auto}
div.row{display:flex;min-height:20px}
.g{flex:0 0 var(--gw);text-align:right;padding:0 10px 0 4px;color:var(--muted);background:var(--gutter);user-select:none;cursor:pointer;border-right:1px solid var(--line);position:sticky;left:0;z-index:1}
.g:hover{color:var(--accent);font-weight:600}
.c{white-space:pre;padding:0 14px;tab-size:4}
body.wrap .c{white-space:pre-wrap;word-break:break-word;flex:1;min-width:0}
.row.hid,.ghost.hid,tr.delim{display:none}
.row.chg{background:var(--add)}
.row.chg>.g{box-shadow:inset -3px 0 0 var(--addbar)}
div.ghost{display:flex;min-height:20px;background:var(--del)}
tr.ghost td{background:var(--del)}
.gg{flex:0 0 var(--gw);text-align:right;padding:0 10px 0 4px;color:var(--delbar);background:var(--gutter);user-select:none;border-right:1px solid var(--line);position:sticky;left:0;z-index:1;box-shadow:inset -3px 0 0 var(--delbar)}
tr.ghost .gg{position:static;font:13px/20px ui-monospace,"Cascadia Code",Consolas,monospace}
tr.ghost .c{font:13px/20px ui-monospace,"Cascadia Code",Consolas,monospace;white-space:pre-wrap}
.diffbar{flex-basis:100%;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:12px;color:var(--muted)}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:5px;overflow:hidden}
.seg button{border:0;border-radius:0;padding:3px 9px;font-size:12px}
.seg button+button{border-left:1px solid var(--line)}
.seg button.on{background:var(--btn);color:var(--btnfg)}
.seg .ct{font:11px ui-monospace,Consolas,monospace;margin-left:5px;opacity:.85}
.diffbar .nav button{padding:2px 8px}
.dgchg{color:var(--addbar);font-weight:600;margin-left:6px}
.row.has{background:var(--cmrow)}
.row.has .g{background:var(--cm);color:var(--fg)}
.row.sel,.row.sel .g{background:var(--sel)}
.flash{animation:fl 1.2s}
@keyframes fl{0%{background:var(--accent)}100%{}}
/* Markdown colours and styles: OpenCode's default theme (see themeCss in markdown.mjs). */
/* tables: one table row per source line, gutter as first column */
.tblwrap{position:sticky;left:0;width:var(--mw,100%);max-width:100%;padding:4px 14px 8px 0}
table.mdt{width:100%;border-collapse:collapse;font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
table.mdt td.g{position:static;width:var(--gw);min-width:var(--gw);vertical-align:top;padding-top:5px;font:13px/20px ui-monospace,"Cascadia Code",Consolas,monospace}
/* OpenCode draws tables as a grid (single borders, #888888 when the theme has no conceal colour), 1 cell of horizontal padding, word wrap. */
table.mdt .cell{border:1px solid #888888;padding:4px 1ch;vertical-align:top;text-align:left;white-space:normal;overflow-wrap:anywhere}
table.mdt th.cell{font-weight:700;color:var(--oc-markdownHeading)}
table.mdt .m-cd{font:12px ui-monospace,Consolas,monospace}
table.mdt td.slotcell{padding:0}
/* mermaid diagrams, drawn by Pele */
.dg{position:sticky;left:0;width:var(--mw,100%);max-width:100%;padding:4px 14px 8px calc(var(--gw) + 14px)}
.dgbar{display:flex;gap:4px;align-items:center;font:12px system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--muted);margin-bottom:4px}
.dgbar .dgk{margin-right:auto}
.dgview{border:1px solid var(--line);border-radius:6px;background:var(--panel);padding:12px;display:flex;justify-content:center;overflow:hidden;
  --pele-bg:var(--panel);--pele-fg:var(--fg);--pele-muted:var(--muted);--pele-line:var(--muted);--pele-surface:var(--bg);--pele-surface-alt:var(--gutter);--pele-border:var(--muted);--pele-accent:var(--accent);--pele-font:system-ui,-apple-system,"Segoe UI",sans-serif}
.dgview svg{max-width:100%;height:auto}
.dgview [data-id]{cursor:pointer}
.dgview .pele-node:hover>:first-child,.dgview .pele-cluster:hover>:first-child,.dgview .pele-note:hover>:first-child{stroke:var(--accent);stroke-width:2.5}
.dgview .pele-edge-label:hover text,.dgview .pele-edge:hover path{fill:var(--accent);stroke:var(--accent)}
.dgview .picked>:first-child{fill:var(--cm);stroke:var(--accent);stroke-width:2.5}
.dgview.dgerr{display:block;color:var(--muted);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
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
    <div class="hint"><span id="hinttext">Click or drag line numbers, or highlight text, to comment</span> ·
      <label id="previewlab" hidden><input type="checkbox" id="preview" checked> Tables &amp; diagrams</label>
      <label><input type="checkbox" id="wrap"> Wrap</label></div>
    <div class="diffbar" id="diffbar" hidden></div>
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
${MD_JS}
(() => {
  const D = JSON.parse(document.getElementById('data').textContent);
  const KEY = 'annotate:' + D.file + ':' + D.mtime;
  const main = document.getElementById('main');
  const code = document.getElementById('code');
  const list = document.getElementById('list');
  const sendBtn = document.getElementById('send');
  const general = document.getElementById('general');
  const selBtn = document.getElementById('selbtn');
  const previewBox = document.getElementById('preview');
  document.documentElement.style.setProperty('--gw', (String(D.lines.length).length + 2.5) + 'ch');
  const setMw = () => document.documentElement.style.setProperty('--mw', main.clientWidth + 'px');
  new ResizeObserver(setMw).observe(main); setMw();

  // Markdown: highlighting for every line; tables and mermaid blocks can be previewed.
  // Other source files: the same code tokenizer, keyed by the file extension.
  const BLOCKS = D.markdown ? scanMarkdown(D.lines) : [];
  const codeState = {};
  const HL = D.markdown ? highlight(D.lines, BLOCKS)
    : D.code ? D.lines.map((l) => [N('code', ...codeLine(l, D.code, codeState))]) : null;
  const blockAt = new Map(BLOCKS.filter(b => b.type === 'table' || b.type === 'mermaid').map(b => [b.start, b]));
  const hasMermaid = BLOCKS.some(b => b.type === 'mermaid');
  if (blockAt.size) document.getElementById('previewlab').hidden = false;
  if (hasMermaid) document.getElementById('hinttext').textContent += ', or click a diagram shape';

  let comments = [], nextId = 1, selA = null, selB = null, dragging = false, pendingSel = null;
  let rows = [], preview = true;
  const srcOpen = new Set(), svgCache = new Map();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved) { comments = saved.comments || []; general.value = saved.general || ''; nextId = comments.reduce((m, c) => Math.max(m, c.id), 0) + 1; }
  } catch {}
  try { preview = localStorage.getItem('annotate:preview') !== '0'; } catch {}
  previewBox.checked = preview;

  // Git changes, diffed by difftastic on the server: D.changes.modes has an
  // unstaged, staged and all view, each in this file's line numbers.
  const CH = D.changes, MODES = CH && CH.modes;
  const anyChange = MODES && Object.values(MODES).some(v => v.added || v.removed);
  let diffMode = 'off';
  if (anyChange) {
    let saved = null;
    try { saved = localStorage.getItem('annotate:diff'); } catch {}
    diffMode = D.diff || (saved && (saved === 'off' || MODES[saved]) ? saved : 'all');
  }
  let V = null, ghostsAt = new Map(), marks = [];
  const hlAdd = window.Highlight && window.CSS && CSS.highlights ? new Highlight() : null;
  const hlDel = hlAdd && new Highlight();
  if (hlAdd) { CSS.highlights.set('dadd', hlAdd); CSS.highlights.set('ddel', hlDel); }

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function paint(nodes, parent) {
    for (const n of nodes) {
      if (typeof n === 'string') parent.append(n);
      else { const s = el('span', 'm-' + n.c); paint(n.k, s); parent.append(s); }
    }
  }

  function lineRow(i) {
    const r = el('div', 'row'); r.dataset.n = i + 1;
    const c = el('span', 'c');
    if (HL) paint(HL[i], c);
    else c.textContent = D.lines[i];
    r.append(el('span', 'g', i + 1), c);
    const ch = V && V.add[i + 1];
    if (ch) { r.classList.add('chg'); if (ch.length) marks.push([c, ch, hlAdd]); }
    rows[i] = r; return r;
  }

  // Old lines (removed, or the previous version of a changed line) that sit
  // after line n. Shown without a line number and not commentable.
  function ghostEls(n, blk) {
    if (!blk && tableAfter(n)) return []; // the table draws them (see tableEl)
    return (ghostsAt.get(n) || []).map(l => ghostLine(l, blk));
  }
  function ghostLine(l, blk) {
    const r = el('div', 'ghost'), c = el('span', 'c', l.text);
    r.append(el('span', 'gg', '−'), c);
    if (l.ranges.length) marks.push([c, l.ranges, hlDel]);
    if (blk) { r.dataset.blk = blk.start; if (!srcOpen.has(blk.start)) r.classList.add('hid'); }
    return r;
  }
  // Highlight character ranges of a line's text, across its highlighting spans.
  function addRanges(c, ranges, hl) {
    const nodes = [], tw = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    let off = 0;
    for (let t; (t = tw.nextNode());) { nodes.push([t, off]); off += t.length; }
    const at = x => { for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k][1] <= x) return [nodes[k][0], Math.min(x - nodes[k][1], nodes[k][0].length)]; return null; };
    for (const [s, e] of ranges) {
      const a = at(s), b = at(e); if (!a || !b) continue;
      const r = new Range(); r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]); hl.add(r);
    }
  }

  const tableAfter = n => preview && blockAt.has(n + 1) && blockAt.get(n + 1).type === 'table';
  // An old line inside a table: a table row is drawn as cells, like the rows
  // around it; anything else (or a delimiter row) as its source text.
  const isRowText = t => t.includes('|') && !isTableDelim(t);
  function ghostRow(l, b, head) {
    const g = el('tr', 'ghost');
    g.append(el('td', 'gg', '−'));
    if (!isRowText(l.text)) {
      const td = el('td', 'c', l.text); td.colSpan = b.cols; g.append(td);
      if (l.ranges.length) marks.push([td, l.ranges, hlDel]);
      return g;
    }
    fitCells(splitCells(l.text), b.cols).forEach((cell, k) => {
      const td = el(head ? 'th' : 'td', 'cell');
      if (b.align[k]) td.style.textAlign = b.align[k];
      paint(inline(cell), td); g.append(td);
    });
    return g;
  }
  // Old lines just outside the table that are not table rows stay outside it.
  function tableEl(b) {
    const wrap = el('div', 'tblwrap'), t = el('table', 'mdt'), body = el('tbody');
    const before = [], after = [];
    for (const l of ghostsAt.get(b.start - 1) || []) {
      if (isRowText(l.text)) body.append(ghostRow(l, b, true)); else before.push(ghostLine(l));
    }
    for (const row of b.rows) {
      const tr = el('tr', 'row' + (row.delim ? ' delim' : '')); tr.dataset.n = row.n;
      tr.append(el('td', 'g', row.n));
      if (row.delim) { const td = el('td'); td.colSpan = b.cols; tr.append(td); }
      row.cells.forEach((cell, k) => {
        const td = el(row.head ? 'th' : 'td', 'cell');
        if (b.align[k]) td.style.textAlign = b.align[k];
        paint(inline(cell), td); tr.append(td);
      });
      if (V && V.add[row.n]) tr.classList.add('chg');
      rows[row.n - 1] = tr; body.append(tr);
      for (const l of ghostsAt.get(row.n) || []) {
        if (row.n === b.end && !isRowText(l.text)) after.push(ghostLine(l));
        else body.append(ghostRow(l, b, false));
      }
    }
    t.append(body); wrap.append(t);
    return [...before, wrap, ...after];
  }

  function setSource(b, open) {
    if (open) srcOpen.add(b.start); else srcOpen.delete(b.start);
    for (let n = b.start + 1; n < b.end; n++) rows[n - 1].classList.toggle('hid', !open);
    code.querySelectorAll('.ghost[data-blk="' + b.start + '"]').forEach(g => g.classList.toggle('hid', !open));
    const btn = code.querySelector('.dg[data-start="' + b.start + '"] .srcbtn');
    if (btn) btn.textContent = open ? 'Hide source' : 'Show source';
  }

  function diagramEl(b) {
    const box = el('div', 'dg'); box.dataset.start = b.start;
    const bar = el('div', 'dgbar');
    const k = el('span', 'dgk', 'Mermaid diagram · click a shape to comment on it');
    let changed = false;
    for (let n = b.start; V && n <= b.end; n++) if (V.add[n] || (n < b.end && ghostsAt.has(n))) changed = true;
    if (changed) k.append(el('span', 'dgchg', 'changed'));
    bar.append(k);
    const whole = el('button', 'link', 'Comment on the whole diagram');
    whole.onclick = () => { selA = b.start; selB = b.end; paintSel(); openComposer(b.start, b.end); };
    const src = el('button', 'link srcbtn', srcOpen.has(b.start) ? 'Hide source' : 'Show source');
    src.onclick = () => setSource(b, !srcOpen.has(b.start));
    bar.append(whole, src);
    const view = el('div', 'dgview', 'Drawing the diagram…');
    view.addEventListener('click', e => pickShape(e, b));
    box.append(bar, view); return box;
  }

  function build() {
    code.textContent = ''; rows = [];
    V = anyChange && diffMode !== 'off' ? MODES[diffMode] : null;
    ghostsAt = new Map(V ? V.del.map(g => [g.after, g.lines]) : []);
    marks = [];
    if (hlAdd) { hlAdd.clear(); hlDel.clear(); }
    const frag = document.createDocumentFragment();
    frag.append(...ghostEls(0));
    for (let i = 0; i < D.lines.length; i++) {
      const b = preview ? blockAt.get(i + 1) : null;
      if (b && b.type === 'table') { frag.append(...tableEl(b)); i = b.end - 1; continue; }
      frag.append(lineRow(i));
      if (b && b.type === 'mermaid') {
        frag.append(diagramEl(b), ...ghostEls(b.start, b));
        for (let n = b.start + 1; n < b.end; n++) { const r = lineRow(n - 1); if (!srcOpen.has(b.start)) r.classList.add('hid'); frag.append(r, ...ghostEls(n, b)); }
        frag.append(lineRow(b.end - 1), ...ghostEls(b.end)); i = b.end - 1;
      } else frag.append(...ghostEls(i + 1));
    }
    code.append(frag);
    // Ranges are made once the rows are in the document (moving nodes collapses them).
    if (hlAdd) for (const [c, rs, hl] of marks) addRanges(c, rs, hl);
    renderDiffbar();
    render(); drawDiagrams();
  }

  const diffbar = document.getElementById('diffbar');
  function renderDiffbar() {
    if (!CH) return; // not in a git repository
    diffbar.hidden = false; diffbar.textContent = '';
    if (CH.untracked) { diffbar.append('Git: untracked file, no changes to highlight'); return; }
    if (CH.error) { diffbar.append('Git changes unavailable: ' + CH.error); return; }
    if (!anyChange) { diffbar.append('Git: no uncommitted changes'); return; }
    diffbar.append(el('span', '', 'Changes'));
    const seg = el('span', 'seg');
    for (const [m, name] of [['off', 'Off'], ['unstaged', 'Unstaged'], ['staged', 'Staged'], ['all', 'All']]) {
      const btn = el('button', m === diffMode ? 'on' : '', name);
      if (m !== 'off') { const v = MODES[m]; btn.append(el('span', 'ct', v.added || v.removed ? '+' + v.added + ' −' + v.removed : '0')); }
      btn.onclick = () => {
        if (m === diffMode) return;
        diffMode = m;
        try { localStorage.setItem('annotate:diff', m); } catch {}
        document.querySelectorAll('.composer').forEach(c => c.remove()); clearSel();
        build();
      };
      seg.append(btn);
    }
    diffbar.append(seg);
    if (V && (V.added || V.removed)) {
      const nav = el('span', 'nav'), up = el('button', '', '↑'), dn = el('button', '', '↓');
      up.title = 'Previous change'; dn.title = 'Next change';
      up.onclick = () => stepChange(-1); dn.onclick = () => stepChange(1);
      nav.append(up, ' ', dn); diffbar.append(nav);
    }
    diffbar.append(el('span', '', 'via difftastic'));
  }
  // Scroll to the next/previous block of changed or removed lines.
  function stepChange(dir) {
    const isChg = e => e && e.offsetParent && e.matches('.row.chg, .ghost');
    const heads = [...code.querySelectorAll('.row.chg, .ghost')].filter(e => {
      if (!e.offsetParent) return false;
      let p = e.previousElementSibling;
      while (p && p.classList.contains('slot')) p = p.previousElementSibling;
      return !isChg(p);
    });
    const m = main.getBoundingClientRect(), mid = m.top + m.height / 2;
    const center = e => { const r = e.getBoundingClientRect(); return (r.top + r.bottom) / 2; };
    const t = dir > 0 ? heads.find(h => center(h) > mid + 4) : heads.reverse().find(h => center(h) < mid - 4);
    if (!t) return;
    t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash');
  }

  let peleP = null;
  function loadPele() {
    return peleP || (peleP = new Promise((res, rej) => {
      if (window.pele) return res(window.pele);
      const s = document.createElement('script');
      s.src = D.pele.src; s.integrity = D.pele.integrity; s.crossOrigin = 'anonymous';
      s.onload = () => window.pele ? res(window.pele) : rej(new Error('Pele did not load'));
      s.onerror = () => rej(new Error('could not load ' + D.pele.src));
      document.head.append(s);
    }));
  }
  function mermaidSource(b) {
    const inner = D.lines.slice(b.start, b.end - 1);
    const ind = Math.min(...inner.filter(l => l.trim()).map(l => l.length - l.trimStart().length), 99);
    return inner.map(l => l.slice(Math.min(ind, l.length - l.trimStart().length))).join('\\n');
  }
  function diagramFailed(b, msg) {
    const v = code.querySelector('.dg[data-start="' + b.start + '"] .dgview');
    if (v) { v.classList.add('dgerr'); v.textContent = msg; }
    setSource(b, true);
  }
  function drawDiagrams() {
    const boxes = [...code.querySelectorAll('.dg')];
    if (!boxes.length) return;
    loadPele().then(p => {
      for (const box of boxes) {
        const b = blockAt.get(+box.dataset.start), view = box.querySelector('.dgview');
        try {
          let svg = svgCache.get(b.start);
          if (!svg) {
            svg = p.render(mermaidSource(b), { idPrefix: 'dg' + b.start + '-', maxWidth: Math.max(320, view.clientWidth - 24),
              fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' }).svg;
            svgCache.set(b.start, svg);
          }
          view.innerHTML = svg;
        } catch (err) {
          diagramFailed(b, 'Pele could not draw this diagram: ' + ((err && err.message) || err) +
            (err && err.line ? ' (file line ' + (b.start + err.line) + ')' : '') + '. The source is shown below.');
        }
      }
      markPicks();
    }, err => boxes.forEach(box => diagramFailed(blockAt.get(+box.dataset.start),
      'Diagram preview unavailable: ' + err.message + ' (offline?). The source is shown below; you can still comment on its lines.')));
  }

  // A click on a shape: comment anchored to the whole mermaid block, naming the shape.
  function pickShape(e, b) {
    const g = e.target.closest('[data-id]');
    if (!g || !e.currentTarget.contains(g)) return;
    const cl = g.classList;
    const kind = cl.contains('pele-cluster') ? 'group' : cl.contains('pele-edge-label') ? 'edge label'
      : cl.contains('pele-note') ? 'note' : cl.contains('pele-actor') ? 'participant'
      : cl.contains('pele-node') ? 'node' : cl.contains('pele-edge') ? 'edge' : 'element';
    const texts = [...g.querySelectorAll('text')].map(t => {
      const ts = t.querySelectorAll('tspan');
      return ts.length ? [...ts].map(x => x.textContent).join(' ') : t.textContent;
    });
    const label = texts.join(' ').split(' ').filter(Boolean).join(' ');
    const id = g.dataset.id;
    const line = findDiagramLine(D.lines, b.start, b.end, /edge/.test(kind) ? null : id, label);
    selA = b.start; selB = b.end; paintSel();
    openComposer(b.start, b.end, describePick(kind, id, label, line), null, { block: b.start, id });
  }
  function markPicks() {
    code.querySelectorAll('.picked').forEach(x => x.classList.remove('picked'));
    for (const c of comments) {
      if (!c.pick) continue;
      const v = code.querySelector('.dg[data-start="' + c.pick.block + '"] .dgview');
      if (v) v.querySelectorAll('[data-id]').forEach(g => { if (g.dataset.id === c.pick.id) g.classList.add('picked'); });
    }
  }

  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify({ comments, general: general.value })); } catch {} };
  general.addEventListener('input', () => { persist(); updateSend(); });

  function paintSel() {
    code.querySelectorAll('.row.sel').forEach(r => r.classList.remove('sel'));
    if (selA == null) return;
    const a = Math.min(selA, selB), b = Math.max(selA, selB);
    for (let i = a; i <= b; i++) rows[i - 1] && rows[i - 1].classList.add('sel');
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
      if (!a || !b || !code.contains(a) || !code.contains(b)) return;
      const text = s.toString(); if (!text.trim()) return;
      const x = +a.dataset.n, y = +b.dataset.n;
      pendingSel = { start: Math.min(x, y), end: Math.max(x, y), selection: text };
      // Open the comment box straight away, unless that would throw away a
      // comment being written; then offer the button instead.
      const draft = [...document.querySelectorAll('.composer textarea')].some(t => t.value.trim());
      if (!draft) { commentOnSelection(); return; }
      selBtn.style.left = Math.min(e.clientX + 8, innerWidth - 130) + 'px';
      selBtn.style.top = (e.clientY + 12) + 'px';
      selBtn.style.display = 'block';
    }, 0);
  });
  selBtn.addEventListener('mousedown', e => e.preventDefault());
  function commentOnSelection() {
    selBtn.style.display = 'none';
    if (!pendingSel) return;
    const p = pendingSel; pendingSel = null;
    window.getSelection().removeAllRanges();
    selA = p.start; selB = p.end; paintSel();
    openComposer(p.start, p.end, p.selection);
  }
  selBtn.addEventListener('click', commentOnSelection);

  // Insert a comment box below line n (inside a table, as a full-width table row).
  function place(n, box, kind, id) {
    const r = rows[n - 1];
    let holder = box;
    if (r.tagName === 'TR') { holder = el('tr'); const td = el('td', 'slotcell'); td.colSpan = 99; td.append(box); holder.append(td); }
    holder.classList.add('slot', kind);
    if (id != null) holder.dataset.id = id;
    let node = r;
    while (node.nextElementSibling && node.nextElementSibling.classList.contains('slot')) node = node.nextElementSibling;
    if (kind === 'card' && node.classList.contains('composer')) node.before(holder); else node.after(holder);
  }
  const label = (a, b) => a === b ? 'Line ' + a : 'Lines ' + a + '–' + b;

  function openComposer(start, end, selection, existing, pick) {
    document.querySelectorAll('.composer').forEach(c => c.remove());
    render();
    if (existing) { const card = code.querySelector('.card[data-id="' + existing.id + '"]'); if (card) card.style.display = 'none'; }
    const box = el('div', 'box');
    box.append(el('div', 'meta', label(start, end)));
    if (selection) box.append(el('div', 'q', selection));
    const ta = el('textarea'); ta.placeholder = 'What should your harness do here?';
    if (existing) ta.value = existing.text;
    const acts = el('div', 'acts');
    acts.append(el('span', 'k', 'Ctrl+Enter to save · Esc to cancel'));
    const cancel = el('button', '', 'Cancel');
    const save = el('button', 'primary', existing ? 'Update' : 'Add comment');
    acts.append(cancel, save); box.append(ta, acts);
    place(end, box, 'composer');
    ta.focus();
    const close = () => { document.querySelectorAll('.composer').forEach(c => c.remove()); clearSel(); render(); };
    cancel.onclick = close;
    save.onclick = () => {
      const text = ta.value.trim(); if (!text) { ta.focus(); return; }
      if (existing) existing.text = text;
      else comments.push({ id: nextId++, start, end, selection: selection || null, text, pick: pick || null });
      persist(); close();
    };
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save.click(); }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
  }

  function jumpTo(c) {
    let r = rows[c.start - 1];
    const dg = c.pick && code.querySelector('.dg[data-start="' + c.pick.block + '"]');
    if (dg) r = dg;
    while (r && !r.offsetParent && r.previousElementSibling) r = r.previousElementSibling;
    if (!r) return;
    r.scrollIntoView({ block: 'center', behavior: 'smooth' });
    r.classList.remove('flash'); void r.offsetWidth; r.classList.add('flash');
  }

  function render() {
    code.querySelectorAll('.card').forEach(c => c.remove());
    code.querySelectorAll('.row.has').forEach(r => r.classList.remove('has'));
    comments.sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id);
    for (const c of comments) {
      for (let i = c.start; i <= c.end; i++) rows[i - 1] && rows[i - 1].classList.add('has');
      const card = el('div', 'box');
      card.append(el('div', 'meta', label(c.start, c.end)));
      if (c.selection) card.append(el('div', 'q', c.selection));
      const acts = el('div', 'acts');
      const ed = el('button', 'link', 'Edit');
      const del = el('button', 'link', 'Delete');
      ed.onclick = () => openComposer(c.start, c.end, c.selection, c);
      del.onclick = () => { comments = comments.filter(x => x !== c); persist(); render(); };
      acts.append(ed, del); card.append(el('div', 'txt', c.text), acts);
      if (rows[c.end - 1]) place(c.end, card, 'card', c.id);
    }
    markPicks();
    list.innerHTML = '';
    if (!comments.length) {
      list.innerHTML = '<div class="empty">No comments yet. Click a line number (shift-click or drag for a range), or highlight text to comment on it.' +
        (hasMermaid ? ' Click a shape in a diagram to comment on it.' : '') + '</div>';
    }
    for (const c of comments) {
      const it = el('div', 'item');
      it.append(el('div', 'ln', label(c.start, c.end)), el('div', 't', c.text));
      it.onclick = () => jumpTo(c);
      list.append(it);
    }
    updateSend();
  }
  function updateSend() {
    const n = comments.length, g = general.value.trim();
    sendBtn.textContent = n ? 'Send ' + n + ' comment' + (n > 1 ? 's' : '') + ' to your harness' : g ? 'Send comment to your harness' : 'Approve with no comments';
  }

  async function submit(payload) {
    sendBtn.disabled = true;
    try {
      const r = await fetch('submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!r.ok) throw new Error(r.status);
      try { localStorage.removeItem(KEY); } catch {}
      document.body.innerHTML = '<div class="done"><div><h1>' + (payload.cancelled ? 'Discarded' : 'Sent to your harness') +
        '</h1><p id="donemsg">Closing this tab…</p></div></div>';
      setTimeout(() => {
        window.close();
        // Some browsers refuse to close a tab they did not open; say so again if we are still here.
        setTimeout(() => { const m = document.getElementById('donemsg'); if (m) m.textContent = 'You can close this tab and go back to your harness.'; }, 250);
      }, 3000);
    } catch (e) {
      sendBtn.disabled = false;
      alert('Could not reach your harness. Your comments are kept in this tab; try again, or restart /annotate.');
    }
  }
  sendBtn.onclick = () => submit({ comments: comments.map(({ start, end, selection, text }) => ({ start, end, selection, text })), general: general.value, diff: anyChange ? diffMode : 'off' });
  document.getElementById('discard').onclick = () => { if (confirm('Discard all comments and close this session?')) submit({ cancelled: true }); };

  const wrap = document.getElementById('wrap');
  let wrapPref = null;
  try { wrapPref = localStorage.getItem('annotate:wrap'); } catch {}
  wrap.checked = wrapPref == null ? !!D.markdown : wrapPref === '1';
  const applyWrap = () => { document.body.classList.toggle('wrap', wrap.checked); setMw(); };
  wrap.onchange = () => { applyWrap(); try { localStorage.setItem('annotate:wrap', wrap.checked ? '1' : '0'); } catch {} };
  applyWrap();
  previewBox.onchange = () => {
    preview = previewBox.checked;
    try { localStorage.setItem('annotate:preview', preview ? '1' : '0'); } catch {}
    document.querySelectorAll('.composer').forEach(c => c.remove()); clearSel();
    build();
  };

  build();
})();
</script>
</body></html>`;
}
