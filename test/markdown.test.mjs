// Unit tests for the Markdown helpers the page uses: highlighting must keep
// the source text (so line anchoring works), tables and mermaid blocks must
// map back to their source lines.
// Run: mise run test   (or: node test/markdown.test.mjs)
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  MD_FILE, flatten, inline, highlight, scanMarkdown, splitCells, fitCells, findDiagramLine, describePick,
  codeLang, codeLine, OPENCODE_THEME, OPENCODE_STYLES, themeCss,
} from '../plugins/annotate/skills/annotate/markdown.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'plugins', 'annotate', 'skills', 'annotate', 'markdown.mjs');
const lines = fs.readFileSync(path.join(here, 'fixtures', 'adr-fr.md'), 'utf8').split('\n');
if (lines.at(-1) === '') lines.pop();
const lineOf = (needle) => lines.findIndex((l) => l.includes(needle)) + 1;

async function test(name, fn) {
  try { await fn(); console.log('ok  ', name); }
  catch (e) { console.log('FAIL', name, '\n', e.message); process.exitCode = 1; }
}
// Classes of the spans covering `text` on a highlighted line.
function classesOf(nodes, text, acc = [], stack = []) {
  for (const n of nodes) {
    if (typeof n === 'string') { if (n.includes(text)) acc.push(stack.join(' ')); }
    else classesOf(n.k, text, acc, [...stack, n.c]);
  }
  return acc;
}

const blocks = scanMarkdown(lines);
const H = highlight(lines, blocks);

await test('highlighting keeps every line\'s text exactly (anchoring unchanged)', () => {
  assert.equal(H.length, lines.length);
  H.forEach((h, i) => assert.equal(flatten(h), lines[i], `line ${i + 1}`));
  const tricky = ['**a *b* c**', '_x_ y_z_ __b__', '`` a ` b ``', '``` unclosed', '[t](u (v)) ![i](j "k")', '\\*not\\*', '<br/> <https://x.y>', '***', ''];
  for (const t of tricky) assert.equal(flatten(inline(t)), t, t);
});

await test('headings, bold, italic, code, links, lists, quotes get styles', () => {
  const at = (needle, text) => classesOf(H[lineOf(needle) - 1], text);
  assert.deepEqual(at('# Restructurer', 'Restructurer avant'), ['h1']);
  assert.deepEqual(at('Le module', 'l_tt'), ['cd']);
  assert.deepEqual(at('Le module', 'un domaine à la fois'), ['b']);
  assert.deepEqual(at('Le module', 'traduction'), ['i']);
  assert.deepEqual(at('Le module', 'ADR 2'), ['ln lt']);
  assert.deepEqual(at('Le module', './0002.md'), ['ln url']);
  assert.deepEqual(at('Le module', '['), ['ln mk'], 'OpenCode conceals "[" (dimmed here)');
  assert.deepEqual(at('Le module', '('), ['ln lp'], '"(url)" stays visible, in the link colour');
  assert.deepEqual(at('controle_saisie_tt', 'https://example.org/doc'), ['url']);
  assert.ok(!at('controle_saisie_tt', 'saisie').some((c) => c.includes('i')), 'snake_case is not italic');
  assert.deepEqual(at('1. **Restructurer', '1.'), ['ol']);
  assert.deepEqual(at('Les appelants passent', '-'), ['li']);
  assert.deepEqual(at('# Restructurer', '#'), ['h1 mk'], 'heading marker concealed (dimmed)');
  assert.deepEqual(at('Le module', '**'), ['b mk', 'b mk']);
  assert.deepEqual(at('LegacyAdapters', 'LegacyAdapters'), ['i']);
  assert.deepEqual(at('~~vite~~', 'vite'), ['s']);
  assert.deepEqual(at('> Note', 'rien'), ['q b']);
  assert.deepEqual(at('statut:', 'statut'), ['fm'], 'frontmatter is keyword.directive');
  assert.deepEqual(at('pas du markdown', 'const'), ['code sx-keyword']);
  assert.deepEqual(at('pas du markdown', '**pas du markdown**'), ['code sx-string'], 'no markdown inside code blocks');
  assert.deepEqual(at('```js', '```js'), ['fence']);
  assert.deepEqual(at('| Terme employé ici', 'Terme employé ici'), ['th']);
  assert.deepEqual(at('| Terme employé ici', '|'), ['pipe', 'pipe', 'pipe', 'pipe']);
  assert.deepEqual(classesOf(H[lineOf('P_TT["') - 1], 'P_TT'), ['code'], 'mermaid is not highlighted (OpenCode has no parser)');
});

await test('GFM table: one row per source line, cells split, alignment', () => {
  const t = blocks.find((b) => b.type === 'table');
  const head = lineOf('| Terme employé ici');
  assert.equal(t.start, head);
  assert.equal(t.end, lineOf('| `Conversion`'));
  assert.deepEqual(t.rows.map((r) => r.n), [head, head + 1, head + 2, head + 3]);
  assert.ok(t.rows[1].delim);
  assert.deepEqual(t.align, ['', 'center', 'right']);
  assert.deepEqual(t.rows[0].cells, ['Terme employé ici', 'Source', 'Sens dans cet ADR']);
  assert.deepEqual(t.rows[3].cells, ['`Conversion`', 'ISO \\| IEEE', 'Étapes 2 et 3.']);
  // a selection inside a cell is a substring of its source line
  for (const r of t.rows) for (const c of r.cells) assert.ok(lines[r.n - 1].includes(c));
  assert.deepEqual(splitCells('a | b | c'), ['a', 'b', 'c']);
  assert.equal(blocks.filter((b) => b.type === 'table').length, 1, 'pipes in prose or code are not tables');
});

await test('mermaid block range, and clicks on shapes map to source lines', () => {
  const m = blocks.find((b) => b.type === 'mermaid');
  assert.equal(m.start, lineOf('```mermaid'));
  assert.equal(m.end, m.start + 9);
  assert.equal(lines[m.end - 1], '```');
  assert.equal(blocks.find((b) => b.type === 'code').lang, 'js');
  // Pele gives each shape a data-id (the Mermaid id) and its label text.
  const f = (id, label) => findDiagramLine(lines, m.start, m.end, id, label);
  assert.equal(f('P_TT', 'l_tt sous-écran télétravail'), lineOf('P_TT["'));
  assert.equal(f('DB', 'PostgreSQL base partagée'), lineOf('DB[("'));
  assert.equal(f('WD', 'Serveur WebDev (système patrimonial)'), lineOf('subgraph WD'));
  assert.equal(f(null, 'iframe'), lineOf('-- "iframe"'));
  assert.equal(f('nope', 'introuvable'), null);
  assert.equal(describePick('node', 'P_TT', 'l_tt sous-écran télétravail', 25),
    'Mermaid diagram, node P_TT at line 25: l_tt sous-écran télétravail');
  assert.equal(describePick('edge label', 'L_P_TT_POSE_0', 'iframe', 29), 'Mermaid diagram, edge label at line 29: iframe');
  const unclosed = scanMarkdown(['```mermaid', 'flowchart LR', 'A-->B']);
  assert.equal(unclosed[0].type, 'code', 'an unclosed mermaid fence is not drawn');
});

await test('only Markdown files get the Markdown view; module is safe to inline in <script>', () => {
  assert.ok(MD_FILE.test('adr.md') && MD_FILE.test('X.MDX') && !MD_FILE.test('a.mdj') && !MD_FILE.test('a.ts'));
  const src = fs.readFileSync(SRC, 'utf8');
  assert.ok(!/<\/script|<!--/i.test(src));
  assert.ok(!/^\s*import /m.test(src), 'no imports: the page inlines it as a classic script');
});

await test('code blocks: OpenCode languages get syntax tokens, others stay plain', () => {
  assert.equal(codeLang('ts'), 'typescript');
  assert.equal(codeLang('Kotlin'), 'kotlin');
  assert.equal(codeLang('mermaid'), null);
  assert.equal(codeLang('sql'), null);
  const kinds = (line, lang, st) => codeLine(line, lang, st).filter((n) => typeof n !== 'string').map((n) => n.c + ':' + flatten(n.k));
  assert.deepEqual(kinds('fun main() = println("hi") // note', 'kotlin'),
    ['sx-function:fun', 'sx-function:main', 'sx-punctuation:(', 'sx-punctuation:)', 'sx-operator:=', 'sx-function:println', 'sx-punctuation:(', 'sx-string:"hi"', 'sx-punctuation:)', 'sx-comment:// note']);
  assert.deepEqual(kinds('import { Foo } from "x"', 'typescript'),
    ['sx-kwplain:import', 'sx-punctuation:{', 'sx-type:Foo', 'sx-punctuation:}', 'sx-kwplain:from', 'sx-string:"x"']);
  assert.deepEqual(kinds('port: 8080 # comment', 'yaml'), ['sx-variable:port', 'sx-operator::', 'sx-number:8080', 'sx-comment:# comment']);
  const st = {};
  assert.deepEqual(kinds('a /* start', 'c', st), ['sx-variable:a', 'sx-comment:/* start']);
  assert.deepEqual(codeLine('still */ b', 'c', st).map((n) => (typeof n === 'string' ? n : n.c)), ['sx-comment', ' ', 'sx-variable']);
  for (const [l, lang] of [['x = "a\\"b" # c', 'python'], ['+added', 'diff'], ['  "k": [1, true]', 'json']]) assert.equal(flatten(codeLine(l, lang)), l);
});

await test('OpenCode theme: token -> colour mapping, dark and light', () => {
  assert.match(OPENCODE_THEME.source, /^https:\/\/github\.com\/anomalyco\/opencode\/blob\/[0-9a-f]{40}\//);
  // Values of the "opencode" theme (v2 file, $hue references resolved).
  const expect = {
    markdownHeading: ['#9d7cd8', '#d68c27'], markdownLink: ['#fab283', '#3b7dd8'], markdownLinkText: ['#56b6c2', '#318795'],
    markdownCode: ['#7fd88f', '#3d9a57'], markdownBlockQuote: ['#e5c07b', '#b0851f'], markdownEmph: ['#e5c07b', '#b0851f'],
    markdownStrong: ['#f5a742', '#d68c27'], markdownHorizontalRule: ['#808080', '#8a8a8a'], markdownListItem: ['#fab283', '#3b7dd8'],
    markdownListEnumeration: ['#56b6c2', '#318795'], markdownImage: ['#fab283', '#3b7dd8'], markdownCodeBlock: ['#eeeeee', '#1a1a1a'],
    syntaxComment: ['#808080', '#8a8a8a'], syntaxKeyword: ['#9d7cd8', '#d68c27'], syntaxFunction: ['#fab283', '#3b7dd8'],
    syntaxVariable: ['#e06c75', '#d1383d'], syntaxString: ['#7fd88f', '#3d9a57'], syntaxNumber: ['#f5a742', '#d68c27'],
    syntaxType: ['#e5c07b', '#b0851f'], syntaxOperator: ['#56b6c2', '#318795'], syntaxPunctuation: ['#eeeeee', '#1a1a1a'],
  };
  for (const [k, [dark, light]] of Object.entries(expect)) {
    assert.equal(OPENCODE_THEME.dark[k], dark, 'dark ' + k);
    assert.equal(OPENCODE_THEME.light[k], light, 'light ' + k);
  }
  // Which token each kind of Markdown span uses.
  const tok = (c) => OPENCODE_STYLES[c].token;
  assert.deepEqual(
    ['h1', 'b', 'i', 'cd', 'lt', 'url', 'li', 'ol', 'q', 'hr', 'it', 'img', 'code', 'sx-keyword', 'sx-string', 'sx-comment'].map(tok),
    ['markdownHeading', 'markdownStrong', 'markdownEmph', 'markdownCode', 'markdownLinkText', 'markdownLink', 'markdownListItem',
      'markdownListEnumeration', 'markdownBlockQuote', 'markdownHorizontalRule', 'markdownImageText', 'markdownImage',
      'markdownCodeBlock', 'syntaxKeyword', 'syntaxString', 'syntaxComment']);
  for (const n of H.flat(Infinity)) if (typeof n !== 'string') (function walk(x) { if (typeof x === 'string') return; assert.ok(OPENCODE_STYLES[x.c], 'no style for class ' + x.c); x.k.forEach(walk); })(n);
  // The CSS the page gets: light by default, dark under prefers-color-scheme.
  const css = themeCss();
  const [light, dark] = css.split('@media (prefers-color-scheme:dark)');
  assert.match(light, /--oc-markdownHeading:#d68c27/);
  assert.match(dark, /--oc-markdownHeading:#9d7cd8/);
  assert.match(css, /\.m-h1\{color:var\(--oc-markdownHeading\);font-weight:700;text-decoration:underline\}/);
  assert.match(css, /\.m-i\{color:var\(--oc-markdownEmph\);font-style:italic\}/);
  assert.match(css, /\.m-mk\{color:var\(--oc-textMuted\);opacity:\.45;/);
  assert.ok(css.lastIndexOf('.m-mk{') > css.lastIndexOf('.m-b{'), 'concealed markers override the span they sit in');
});

await test('fitCells: a row (also an old, deleted one) fits the table\'s columns', () => {
  assert.deepEqual(fitCells(['a', 'b'], 3), ['a', 'b', '']);
  assert.deepEqual(fitCells(['a', 'b', 'c', 'd'], 3), ['a', 'b', 'c | d']);
  assert.deepEqual(fitCells(splitCells('| `x` | ISO \\| IEEE | y |'), 3), ['`x`', 'ISO \\| IEEE', 'y']);
});
