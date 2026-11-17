// markdown.mjs: DOM-free Markdown helpers for the annotation page.
// annotate.mjs inlines this file into the page (with the `export` keywords
// stripped), and the tests import it directly. No dependencies.
//
// Highlighting never changes the text: every line becomes a tree of nodes
// whose concatenated text is exactly the source line, so line numbers and
// selected text still refer to the file.
//
// A node is either a string or { c: className, k: [child nodes] }.

export const MD_FILE = /\.(md|markdown|mdx|mdown|mkd|mkdn)$/i;

const N = (c, ...k) => ({ c, k: k.filter((x) => x !== '' && x != null) });

export function flatten(nodes) {
  let s = '';
  for (const n of nodes) s += typeof n === 'string' ? n : flatten(n.k);
  return s;
}

// ---------- inline spans ----------
const RE = {
  esc: /\\[!-/:-@[-`{-~]/y,
  code: /(`+)([\s\S]*?[^`])\1(?!`)/y,
  ticks: /`+/y,
  link: /(!?\[)((?:\\.|[^\\[\]]|\[(?:\\.|[^\\[\]])*\])*)(\]\()([^()\s]*(?:\([^()\s]*\)[^()\s]*)*(?:\s+"[^"]*")?)(\))/y,
  ref: /(!?\[)((?:\\.|[^\\[\]])+)(\]\[)([^\]]*)(\])/y,
  foot: /\[\^[^\]\s]+\]/y,
  auto: /<(?:https?|mailto|ftp):[^\s<>]*>|<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>/y,
  html: /<\/?[A-Za-z][\w:-]*(?:\s[^<>]*?)?\/?>|<!-{2}[\s\S]*?-{2}>/y,
  bold: /(\*\*|__)(?!\s)([\s\S]*?[^\s])\1/y,
  strike: /~~(?!\s)([\s\S]*?[^\s])~~/y,
  emStar: /\*(?![\s*])((?:\*\*(?:(?!\*\*)[\s\S])+?\*\*|[^*])*?[^\s*]|[^\s*])\*/y,
  emUnder: /_(?![\s_])([^_]*?[^\s_]|[^\s_])_/y,
  url: /https?:\/\/[^\s<>`]*[^\s<>`.,;:!?'")\]]/y,
};
const isWord = (ch) => !!ch && /[\p{L}\p{N}_]/u.test(ch);

export function inline(text) {
  const out = [];
  let buf = '';
  let i = 0;
  const push = (n) => { if (buf) { out.push(buf); buf = ''; } out.push(n); };
  const at = (re) => { re.lastIndex = i; return re.exec(text); };
  while (i < text.length) {
    const ch = text[i];
    const prev = text[i - 1];
    let m = null;
    if (ch === '\\' && (m = at(RE.esc))) push(N('esc', m[0]));
    else if (ch === '`') {
      if ((m = at(RE.code))) push(N('cd', N('mk', m[1]), m[2], N('mk', m[1])));
      else { m = at(RE.ticks); buf += m[0]; i += m[0].length; continue; }
    } else if ((ch === '[' || (ch === '!' && text[i + 1] === '[')) && (m = at(RE.link))) {
      // OpenCode conceals "[" and shows "]" as a space; "(url)" stays visible.
      // For an image only the description stays visible.
      if (m[1] === '![') push(N('img', N('mk', '!['), N('it', ...inline(m[2])), N('mk', '](' + m[4] + ')')));
      else push(N('ln', N('mk', '['), N('lt', ...inline(m[2])), N('mk', ']'), N('lp', '('), N('url', m[4]), N('lp', ')')));
    } else if (ch === '[' && (m = at(RE.foot))) push(N('ln', m[0]));
    else if ((ch === '[' || ch === '!') && (m = at(RE.ref))) {
      push(N(m[1] === '![' ? 'img' : 'ln', N('mk', m[1]), N(m[1] === '![' ? 'it' : 'lt', ...inline(m[2])), N('mk', m[3] + m[4] + m[5])));
    } else if (ch === '<' && (m = at(RE.auto))) push(N('url', N('mk', '<'), m[0].slice(1, -1), N('mk', '>')));
    else if (ch === '<' && (m = at(RE.html))) push(N('html', m[0]));
    else if ((ch === '*' || (ch === '_' && !isWord(prev))) && (m = at(RE.bold))
      && !(ch === '_' && isWord(text[i + m[0].length]))) {
      push(N('b', N('mk', m[1]), ...inline(m[2]), N('mk', m[1])));
    } else if (ch === '~' && (m = at(RE.strike))) push(N('s', N('mk', '~~'), ...inline(m[1]), N('mk', '~~')));
    else if (ch === '*' && (m = at(RE.emStar))) push(N('i', N('mk', '*'), ...inline(m[1]), N('mk', '*')));
    else if (ch === '_' && !isWord(prev) && (m = at(RE.emUnder)) && !isWord(text[i + m[0].length])) {
      push(N('i', N('mk', '_'), ...inline(m[1]), N('mk', '_')));
    } else if (ch === 'h' && !isWord(prev) && (m = at(RE.url))) push(N('url', m[0]));
    else m = null;
    if (m) { i += m[0].length; continue; }
    buf += ch;
    i++;
  }
  if (buf) out.push(buf);
  return out;
}

// ---------- block structure ----------
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/;
export const isTableDelim = (line) => line.includes('|') && line.includes('-')
  && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);

// Split a table line into cell texts (trimmed). An escaped \| stays in the cell.
export function splitCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '\\|'; i++; }
    else if (s[i] === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

// Fit a row's cells to the table's column count: extra cells are joined into
// the last column, missing ones are empty.
export function fitCells(cells, cols) {
  const c = cells.slice(0, cols);
  if (cells.length > cols) c[cols - 1] += ' | ' + cells.slice(cols).join(' | ');
  while (c.length < cols) c.push('');
  return c;
}

// Finds the blocks that need special treatment. Line numbers are 1-based and
// inclusive. Types: frontmatter, code, mermaid (fenced, fences included), table.
export function scanMarkdown(lines) {
  const blocks = [];
  let i = 0;
  if (lines.length && /^---\s*$/.test(lines[0])) {
    for (let j = 1; j < lines.length; j++) {
      if (/^(---|\.\.\.)\s*$/.test(lines[j])) { blocks.push({ type: 'frontmatter', start: 1, end: j + 1 }); i = j + 1; break; }
    }
  }
  for (; i < lines.length; i++) {
    const l = lines[i];
    const f = l.match(FENCE);
    if (f) {
      const close = new RegExp('^\\s*' + (f[2][0] === '`' ? '`' : '~') + '{' + f[2].length + ',}\\s*$');
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j])) j++;
      const closed = j < lines.length;
      const end = closed ? j : lines.length - 1;
      const lang = (f[3] || '').toLowerCase();
      blocks.push({ type: lang === 'mermaid' && closed ? 'mermaid' : 'code', lang, start: i + 1, end: end + 1, closed });
      i = end;
      continue;
    }
    if (l.includes('|') && i + 1 < lines.length && isTableDelim(lines[i + 1])) {
      const head = splitCells(l);
      const delim = splitCells(lines[i + 1]);
      if (head.length !== delim.length) continue;
      const cols = head.length;
      const align = delim.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
      const rows = [{ n: i + 1, head: true, cells: head }, { n: i + 2, delim: true, cells: [] }];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes('|') && !FENCE.test(lines[j])) {
        rows.push({ n: j + 1, cells: fitCells(splitCells(lines[j]), cols) });
        j++;
      }
      blocks.push({ type: 'table', start: i + 1, end: j, cols, align, rows });
      i = j - 1;
    }
  }
  return blocks;
}

// ---------- line highlighting ----------
export function mdLine(line) {
  let m;
  if ((m = line.match(/^(\s{0,3})(#{1,6})(?=\s|$)(.*)$/))) return [m[1], N('h' + m[2].length, N('mk', m[2]), ...inline(m[3]))];
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return [N('hr', line)];
  if ((m = line.match(/^(\s{0,3}>\s?)(.*)$/))) return [N('q', N('mk', m[1]), ...mdLine(m[2]))];
  if ((m = line.match(/^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)(\[[ xX]\](?=\s|$))?(.*)$/))) {
    const task = m[4] ? N(/x/i.test(m[4]) ? 'done' : 'todo', m[4]) : '';
    return [m[1], N(/\d/.test(m[2]) ? 'ol' : 'li', m[2]), m[3], task, ...inline(m[5])].filter((x) => x !== '');
  }
  if ((m = line.match(/^(\s{0,3})(\[[^\]]+\]:)(\s*)(\S+)(.*)$/))) return [m[1], N('ln', m[2]), m[3], N('url', m[4]), m[5]].filter((x) => x !== '');
  return inline(line);
}

function tableLine(line, delim, head) {
  if (delim) return [N('pipe', line)];
  const out = [];
  let cur = '';
  const cell = () => {
    if (!cur) return;
    const lead = cur.match(/^\s*/)[0];
    const trail = cur.slice(lead.length).match(/\s*$/)[0];
    const body = cur.slice(lead.length, cur.length - trail.length);
    out.push(lead, ...(head && body ? [N('th', ...inline(body))] : inline(body)), trail);
    cur = '';
  };
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && line[i + 1] === '|') { cur += '\\|'; i++; }
    else if (line[i] === '|') { cell(); out.push(N('pipe', '|')); }
    else cur += line[i];
  }
  cell();
  return out.filter((x) => x !== '');
}

// One node list per line.
export function highlight(lines, blocks = scanMarkdown(lines)) {
  const out = new Array(lines.length);
  for (const b of blocks) {
    const lang = codeLang(b.lang), state = {};
    for (let n = b.start; n <= b.end; n++) {
      const l = lines[n - 1];
      // OpenCode styles the whole frontmatter as keyword.directive.
      if (b.type === 'frontmatter') out[n - 1] = [N('fm', l)];
      else if (b.type === 'table') out[n - 1] = tableLine(l, n === b.start + 1, n === b.start);
      else if (n === b.start || (b.closed && n === b.end)) out[n - 1] = [N('fence', l)];
      else out[n - 1] = [N('code', ...(lang ? codeLine(l, lang, state) : [l]))];
    }
  }
  for (let i = 0; i < lines.length; i++) if (!out[i]) out[i] = mdLine(lines[i]);
  return out;
}

// ---------- code blocks ----------
// Languages OpenCode highlights in fenced code blocks: @opentui/core's built-in
// parsers (javascript, typescript, tsx, markdown, zig) plus the ones OpenCode
// registers in packages/tui/src/parsers-config.ts. Others (mermaid, sql…) stay
// plain, as in OpenCode. This is a small lexer, not tree-sitter: it gives the
// same token kinds the same colours, not the same parse.
const CODE_LANGS = 'javascript typescript typescriptreact markdown zig agda bash c clojure cpp csharp css diff elixir fsharp go haskell hcl html java json julia kotlin lua make nix ocaml php python r ruby rust scala swift toml vim vue xml yaml'.split(' ');
const LANG_ALIAS = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'typescriptreact', ts: 'typescript', mts: 'typescript', tsx: 'typescriptreact',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', py: 'python', rb: 'ruby', rs: 'rust', kt: 'kotlin', kts: 'kotlin',
  cs: 'csharp', 'c++': 'cpp', hpp: 'cpp', h: 'c', yml: 'yaml', jsonc: 'json', json5: 'json', md: 'markdown', ex: 'elixir', exs: 'elixir',
  hs: 'haskell', ml: 'ocaml', fs: 'fsharp', tf: 'hcl', makefile: 'make', svg: 'xml', htm: 'html', patch: 'diff',
};
export function codeLang(info) {
  const l = String(info || '').toLowerCase();
  const n = LANG_ALIAS[l] || l;
  return CODE_LANGS.includes(n) ? n : null;
}
const HASH = new Set(['bash', 'python', 'ruby', 'r', 'yaml', 'toml', 'make', 'nix', 'elixir', 'julia', 'hcl']);
const DASH = new Set(['lua', 'haskell', 'agda']);
const KEYWORDS = new Set(('if else elif for while do switch case default break continue return throw throws try catch except finally raise new delete typeof instanceof in of is not and or ' +
  'await async yield class extends implements interface enum type const let var val static public private protected internal override abstract final sealed data object ' +
  'struct impl trait mod pub mut match when where lambda pass with then end local defer go chan select loop unless until begin rescue ensure module').split(' '));
const KW_FUNCTION = new Set(['function', 'fun', 'fn', 'def', 'func', 'defn', 'defp']);
const KW_IMPORT = new Set(['import', 'export', 'from', 'package', 'use', 'require', 'include', 'using', 'as']);
const CONSTANTS = new Set(['true', 'false', 'null', 'undefined', 'nil', 'None', 'True', 'False', 'NaN', 'Infinity']);
const BUILTINS = new Set(['this', 'self', 'super', 'it']);
const CODE_RE = {
  string: /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?/y,
  number: /(?:0x[\da-f_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)[a-z]*/iy,
  ident: /[A-Za-z_$@][\w$]*/y,
  op: /[+\-*/%=<>!&|^~?:.,;]+/y,
  punct: /[()[\]{}]/y,
  space: /\s+/y,
};

// Tokens for one line of a fenced code block. state carries an open /* */ comment.
export function codeLine(line, lang, state = {}) {
  if (lang === 'diff') {
    const c = /^\+/.test(line) ? 'sx-added' : /^-/.test(line) ? 'sx-removed' : /^@@/.test(line) ? 'sx-hunk' : null;
    return c ? [N(c, line)] : [line];
  }
  if (lang === 'markdown') return mdLine(line);
  const out = [];
  let i = 0;
  const lineComment = HASH.has(lang) ? '#' : DASH.has(lang) ? '--' : lang === 'clojure' ? ';' : lang === 'vim' ? '"' : '//';
  const block = !HASH.has(lang) && !DASH.has(lang) && lang !== 'clojure' && lang !== 'vim';
  const at = (re) => { re.lastIndex = i; return re.exec(line); };
  // YAML / TOML / JSON keys are properties (OpenCode: variable colour).
  if (lang === 'yaml' || lang === 'toml') {
    const k = line.match(/^(\s*-?\s*)([\w.-]+|"[^"]*"|'[^']*')(\s*[:=])/);
    if (k) { out.push(k[1], N('sx-variable', k[2]), N('sx-operator', k[3])); i = k[0].length; }
  }
  while (i < line.length) {
    const rest = line.slice(i);
    let m;
    if (state.inBlock) {
      const e = rest.indexOf('*/');
      const len = e < 0 ? rest.length : e + 2;
      out.push(N('sx-comment', rest.slice(0, len))); i += len;
      if (e >= 0) state.inBlock = false;
      continue;
    }
    if (block && rest.startsWith('/*')) { state.inBlock = true; continue; }
    if (rest.startsWith(lineComment) && (lineComment !== '"' || !rest.slice(1).includes('"'))) { out.push(N('sx-comment', rest)); break; }
    if ((m = at(CODE_RE.space))) { out.push(m[0]); i += m[0].length; continue; }
    if ((m = at(CODE_RE.string))) {
      const key = lang === 'json' && /^\s*:/.test(line.slice(i + m[0].length));
      out.push(N(key ? 'sx-variable' : 'sx-string', m[0])); i += m[0].length; continue;
    }
    if (!isWord(line[i - 1]) && (m = at(CODE_RE.number))) { out.push(N('sx-number', m[0])); i += m[0].length; continue; }
    if ((m = at(CODE_RE.ident))) {
      const w = m[0];
      const next = line.slice(i + w.length).match(/^\s*(.)/);
      let c = 'sx-variable';
      if (w[0] === '@') c = 'sx-attr';
      else if (KW_FUNCTION.has(w)) c = 'sx-function';
      else if (KW_IMPORT.has(w)) c = 'sx-kwplain';
      else if (KEYWORDS.has(w)) c = 'sx-keyword';
      else if (CONSTANTS.has(w)) c = 'sx-number';
      else if (BUILTINS.has(w)) c = 'sx-builtin';
      else if (next && next[1] === '(') c = 'sx-function';
      else if (/^[A-Z]/.test(w)) c = 'sx-type';
      else if (lang === 'yaml') c = 'sx-string';
      out.push(N(c, w)); i += w.length; continue;
    }
    if ((m = at(CODE_RE.op))) { out.push(N('sx-operator', m[0])); i += m[0].length; continue; }
    if ((m = at(CODE_RE.punct))) { out.push(N('sx-punctuation', m[0])); i += m[0].length; continue; }
    out.push(line[i]); i++;
  }
  return out;
}

// ---------- OpenCode theme ----------
// Colours of OpenCode's default theme ("opencode"), dark and light, from
//   https://github.com/anomalyco/opencode/blob/617a770aecc757ec79cc08f7727a1d5d3801e210/packages/tui/src/theme/assets/v2/opencode.json
// (the default TUI theme; sst/opencode now redirects to anomalyco/opencode), with
// its $hue references resolved. The token names are those of the v1 theme JSON
// format (https://opencode.ai/docs/themes/), whose packages/tui/src/theme/assets/opencode.json
// at the same commit has the same values.
export const OPENCODE_THEME = {
  source: 'https://github.com/anomalyco/opencode/blob/617a770aecc757ec79cc08f7727a1d5d3801e210/packages/tui/src/theme/assets/v2/opencode.json',
  dark: {
    text: '#eeeeee', textMuted: '#808080', background: '#0a0a0a', backgroundPanel: '#141414', backgroundElement: '#1e1e1e',
    border: '#484848', borderSubtle: '#3c3c3c', primary: '#fab283', error: '#e06c75', success: '#7fd88f',
    markdownText: '#eeeeee', markdownHeading: '#9d7cd8', markdownLink: '#fab283', markdownLinkText: '#56b6c2',
    markdownCode: '#7fd88f', markdownBlockQuote: '#e5c07b', markdownEmph: '#e5c07b', markdownStrong: '#f5a742',
    markdownHorizontalRule: '#808080', markdownListItem: '#fab283', markdownListEnumeration: '#56b6c2',
    markdownImage: '#fab283', markdownImageText: '#56b6c2', markdownCodeBlock: '#eeeeee',
    syntaxComment: '#808080', syntaxKeyword: '#9d7cd8', syntaxFunction: '#fab283', syntaxVariable: '#e06c75',
    syntaxString: '#7fd88f', syntaxNumber: '#f5a742', syntaxType: '#e5c07b', syntaxOperator: '#56b6c2', syntaxPunctuation: '#eeeeee',
    diffAdded: '#4fd6be', diffRemoved: '#c53b53', diffHunkHeader: '#828bb8', warning: '#f5a742',
  },
  light: {
    text: '#1a1a1a', textMuted: '#8a8a8a', background: '#ffffff', backgroundPanel: '#fafafa', backgroundElement: '#f5f5f5',
    border: '#b8b8b8', borderSubtle: '#d4d4d4', primary: '#3b7dd8', error: '#d1383d', success: '#3d9a57',
    markdownText: '#1a1a1a', markdownHeading: '#d68c27', markdownLink: '#3b7dd8', markdownLinkText: '#318795',
    markdownCode: '#3d9a57', markdownBlockQuote: '#b0851f', markdownEmph: '#b0851f', markdownStrong: '#d68c27',
    markdownHorizontalRule: '#8a8a8a', markdownListItem: '#3b7dd8', markdownListEnumeration: '#318795',
    markdownImage: '#3b7dd8', markdownImageText: '#318795', markdownCodeBlock: '#1a1a1a',
    syntaxComment: '#8a8a8a', syntaxKeyword: '#d68c27', syntaxFunction: '#3b7dd8', syntaxVariable: '#d1383d',
    syntaxString: '#3d9a57', syntaxNumber: '#d68c27', syntaxType: '#b0851f', syntaxOperator: '#318795', syntaxPunctuation: '#1a1a1a',
    diffAdded: '#1e725c', diffRemoved: '#c53b53', diffHunkHeader: '#7086b5', warning: '#d68c27',
  },
};

// Node class -> OpenCode token and text attributes. Rules follow OpenCode's
// syntax styles (packages/theme/src/tui/syntax.ts, same commit) and the
// Markdown renderer it uses, @opentui/core 0.8.1 (tree-sitter-markdown
// highlight queries + MarkdownRenderable), in its default "rendered" mode.
// conceal: OpenCode hides these characters; here they are only dimmed so each
// line keeps its exact source text.
export const OPENCODE_STYLES = {
  h1: { token: 'markdownHeading', bold: true, underline: true }, // markup.heading.1
  h2: { token: 'markdownHeading', bold: true }, h3: { token: 'markdownHeading', bold: true },
  h4: { token: 'markdownHeading', bold: true }, h5: { token: 'markdownHeading', bold: true },
  h6: { token: 'markdownHeading', bold: true },
  b: { token: 'markdownStrong', bold: true },            // markup.strong
  i: { token: 'markdownEmph', italic: true },             // markup.italic
  s: { token: 'textMuted' },                              // markup.strikethrough
  cd: { token: 'markdownCode' },                          // markup.raw.inline
  ln: { token: 'markdownLinkText' },
  lt: { token: 'markdownLinkText', underline: true },     // markup.link.label
  lp: { token: 'markdownLink', underline: true },         // markup.link: "(" ")"
  url: { token: 'markdownLink', underline: true },        // markup.link.url
  img: { token: 'markdownImage' },
  it: { token: 'markdownImageText', underline: true },    // image description
  li: { token: 'markdownListItem' },                      // markup.list
  ol: { token: 'markdownListEnumeration' },
  done: { token: 'success' },                             // markup.list.checked
  todo: { token: 'textMuted' },                           // markup.list.unchecked
  q: { token: 'markdownBlockQuote', italic: true },       // markup.quote
  hr: { token: 'markdownHorizontalRule' },
  th: { token: 'markdownHeading', bold: true },           // table header cells: markup.heading
  pipe: { token: 'syntaxOperator' },                      // table pipes: punctuation.special
  fm: { token: 'syntaxKeyword', italic: true },           // frontmatter: keyword.directive
  html: { token: 'error' },                               // tag
  esc: { token: 'syntaxKeyword' },                        // string.escape
  code: { token: 'markdownCodeBlock' },
  'sx-comment': { token: 'syntaxComment', italic: true },
  'sx-keyword': { token: 'syntaxKeyword', italic: true },
  'sx-kwplain': { token: 'syntaxKeyword' },               // keyword.import / export
  'sx-function': { token: 'syntaxFunction' },
  'sx-variable': { token: 'syntaxVariable' },
  'sx-string': { token: 'syntaxString' },
  'sx-number': { token: 'syntaxNumber' },
  'sx-type': { token: 'syntaxType' },
  'sx-operator': { token: 'syntaxOperator' },
  'sx-punctuation': { token: 'syntaxPunctuation' },
  'sx-builtin': { token: 'error' },                       // variable.builtin
  'sx-attr': { token: 'warning' },                        // attribute / annotation
  'sx-added': { token: 'diffAdded' }, 'sx-removed': { token: 'diffRemoved' }, 'sx-hunk': { token: 'diffHunkHeader' },
  // Last, so concealed markers inside styled spans are dimmed.
  mk: { token: 'textMuted', conceal: true },
  fence: { token: 'textMuted', conceal: true },           // fence lines are hidden whole (conceal_lines)
};

// CSS for the page: --oc-<token> variables (light, and dark under
// prefers-color-scheme) and one rule per node class (.m-<class>).
export function themeCss() {
  const vars = (t) => Object.entries(t).map(([k, v]) => `--oc-${k}:${v}`).join(';');
  let css = `:root{${vars(OPENCODE_THEME.light)}}\n@media (prefers-color-scheme:dark){:root{${vars(OPENCODE_THEME.dark)}}}\n`;
  for (const [cls, st] of Object.entries(OPENCODE_STYLES)) {
    const d = [`color:var(--oc-${st.token})`];
    if (st.bold) d.push('font-weight:700');
    if (st.italic) d.push('font-style:italic');
    if (st.underline) d.push('text-decoration:underline');
    if (st.conceal) d.push('opacity:.45', 'font-weight:400', 'font-style:normal');
    css += `.m-${cls}{${d.join(';')}}\n`;
  }
  return css;
}

// ---------- mermaid diagrams ----------
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plain = (s) => s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/["'`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Line (1-based, in the file) where a clicked diagram element is written.
// start/end are the fence lines of the mermaid block. id is the element's
// data-id from Pele's SVG, label its visible text. Returns null if unknown.
export function findDiagramLine(lines, start, end, id, label) {
  const inner = [];
  for (let n = start + 1; n < end; n++) inner.push([n, lines[n - 1] || '']);
  if (id) {
    const i = reEsc(id);
    const def = new RegExp('(^|[^\\w-])' + i + '\\s*(\\[|\\(|\\{|>|@\\{)');
    const decl = new RegExp('^\\s*(participant|actor|subgraph|class|state|section)\\s+' + i + '(?![\\w-])');
    for (const [n, l] of inner) if (def.test(l) || decl.test(l)) return n;
  }
  const want = label ? plain(label) : '';
  if (want) {
    for (const [n, l] of inner) if (plain(l).includes(want)) return n;
    const head = want.split(' ').slice(0, 3).join(' ');
    for (const [n, l] of inner) if (plain(l).includes(head)) return n;
  }
  if (id) {
    const word = new RegExp('(^|[^\\w-])' + reEsc(id) + '(?![\\w-])');
    for (const [n, l] of inner) if (word.test(l)) return n;
  }
  return null;
}

// Text sent to your harness (as the comment's selected text) for a click on a diagram element.
export function describePick(kind, id, label, line) {
  // Only nodes, groups and participants have ids written in the source;
  // edges, edge labels and notes get ids generated by the renderer.
  const name = id && /^(node|group|participant)$/.test(kind) ? ' ' + id : '';
  return `Mermaid diagram, ${kind}${name}${line ? ` at line ${line}` : ''}` + (label ? `: ${label}` : '');
}
