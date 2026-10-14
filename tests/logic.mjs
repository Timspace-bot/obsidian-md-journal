// Pure-logic tests: node tests/logic.mjs (no dependencies).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '../main.js'), 'utf8');
class Stub {}
const obsidian = new Proxy({ Platform: { isPhone: false } }, { get: (o, k) => (k in o ? o[k] : Stub) });
const module = { exports: {} };
new Function('require', 'module', source)(() => obsidian, module);
const J = module.exports;

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name); throw e; }
};
const textOf = (html) => html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

test('inline rendering keeps every source character, in order', () => {
  const samples = [
    'plain text', '**bold** and *italic* and _under_ and __strong__', 'a `code` span with ``double `tick``',
    '[[Note]] and [[Note|alias]] and ![[embed.png]]', '[text](https://example.com/a_(b)) after',
    '~~gone~~ ==marked== #tag #2024 not#tag', 'snake_case_word and 2*3*4', 'https://obsidian.md/x?y=1, then',
    '**unclosed and *also', '<b>& "quotes"</b>', '***both***', 'emoji 👩‍👩‍👧 and ✍️', '',
  ];
  for (const s of samples) assert.equal(textOf(J.renderInline(s)), s, s);
});

test('inline rendering recognises the usual Markdown', () => {
  assert.match(J.renderInline('**b**'), /mj-b/);
  assert.match(J.renderInline('*i*'), /mj-i/);
  assert.match(J.renderInline('a `c` d'), /mj-ic/);
  assert.match(J.renderInline('[[Page|Alias]]'), /data-href="Page">Alias</);
  assert.match(J.renderInline('see #idea'), /mj-tag">#idea/);
  assert.doesNotMatch(J.renderInline('snake_case_word'), /mj-i/);
  assert.doesNotMatch(J.renderInline('issue #12'), /mj-tag/);
});

test('every line kind renders back to its exact source', () => {
  const lines = ['# Title', '## Monday', '- item', '  * nested', '1. first', '- [ ] todo', '- [x] done', '> quote',
    '> > deeper', '---', '```js', 'const a = 1 < 2;', '```', '<!-- pagebreak -->', '![[photo.jpg]]', '![alt](pic.png)', '', '   ', 'text'];
  const kinds = J.computeKinds(lines);
  lines.forEach((l, i) => {
    const html = J.renderLine(l, kinds[i], () => 'app://img');
    assert.equal(l === '' ? '' : textOf(html), l, l);
  });
});

test('line kinds', () => {
  const k = J.computeKinds(['# H', 'text', '```', '# not heading', '```', '- [x] t', '3) n', '#tag']);
  assert.deepEqual(k.map((x) => x.type), ['h', 'p', 'fence', 'code', 'fence', 'task', 'ol', 'p']);
  assert.equal(k[5].checked, true);
  assert.equal(k[6].num, 3);
  assert.equal(J.lineKind('![[a.pdf]]').type, 'p');
  assert.equal(J.lineKind('![[a.PNG|200]]').type, 'image');
  assert.equal(J.lineKind('<!-- page-break -->').type, 'pagebreak');
});

test('frontmatter is kept apart and round-trips', () => {
  const t = '---\ntags: [a]\n---\n# Entry\n';
  const { front, body } = J.splitFrontmatter(t);
  assert.equal(front, '---\ntags: [a]\n---\n');
  assert.equal(front + body, t);
  assert.equal(J.splitFrontmatter('---\n---\nx').body, 'x');
  assert.equal(J.splitFrontmatter('no front\n---\n').front, '');
  assert.equal(J.splitFrontmatter('---\r\na: 1\r\n---\r\nbody').body, 'body');
});

test('list continuation on Enter', () => {
  const cont = (line) => J.continuationPrefix(line, J.lineKind(line), line.length);
  assert.equal(cont('- milk'), '- ');
  assert.equal(cont('\t* eggs'), '\t* ');
  assert.equal(cont('9. nine'), '10. ');
  assert.equal(cont('- [x] done'), '- [ ] ');
  assert.equal(cont('> said'), '> ');
  assert.equal(cont('- '), null);
  assert.equal(cont('plain'), '');
  assert.equal(J.continuationPrefix('- milk', J.lineKind('- milk'), 1), '');
});

test('grapheme and word boundaries', () => {
  const s = 'ab 👩‍👩‍👧 cd';
  const afterEmoji = 3 + '👩‍👩‍👧'.length;
  assert.equal(J.prevBoundary(s, afterEmoji), 3);
  assert.equal(J.nextBoundary(s, 3), afterEmoji);
  assert.equal(J.prevWordStart('hello wor', 9), 6);
  assert.equal(J.prevWordStart('end.  ', 6), 3);
  assert.equal(J.nextWordEnd('one two', 3), 7);
  assert.equal(J.countWords('Dear diary — it’s 3 o’clock.'), 5);
});

test('page geometry keeps the writing on whole lines', () => {
  for (const pageSize of Object.keys(J.PAGE_SIZES).filter((k) => k !== 'custom')) {
    for (const fontSize of [11, 15, 22]) {
      const g = J.pageGeometry({ ...J.DEFAULT_SETTINGS, pageSize, fontSize });
      assert.equal(g.contentH % g.lh, 0);
      assert.ok(g.top + g.contentH + g.bottom === g.H && g.bottom >= g.top);
      assert.equal(g.colW + g.gap, g.W);
    }
  }
});

test('Obsidian view geometry fills the pane', () => {
  const s = { ...J.DEFAULT_SETTINGS, layout: 'screen' };
  const wide = J.screenGeometry(1700, 800, s, 16, false);
  assert.equal(wide.n, 2);
  assert.ok(wide.colW <= s.screenMaxWidth && wide.W === wide.colW + wide.gap);
  assert.ok(wide.n * wide.colW + (wide.n - 1) * wide.gap <= 1700);
  assert.equal(wide.top + wide.contentH + wide.bottom, wide.H);
  assert.equal(J.screenGeometry(700, 800, s, 16, false).n, 1);
  assert.equal(J.screenGeometry(1700, 800, s, 16, true).n, 1);
  assert.equal(J.screenGeometry(1700, 800, { ...s, screenMaxWidth: 0 }, 16, false).colW, Math.floor((1700 - 112 - 64) / 2));
});

test('code highlighting keeps each line\'s text', () => {
  // a tiny Prism stand-in: one token that spans a line break
  const Prism = {
    languages: { powershell: {} },
    tokenize: (code) => [{ type: 'variable', content: '$s' }, ' = ', { type: 'string', content: ["@'\nhere", { type: 'x', content: '<b>' }, "\n'@"] }],
  };
  const code = "$s = @'\nhere<b>\n'@";
  const lines = J.prismLines(Prism, code, 'ps1');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(textOf), code.split('\n'));
  assert.match(lines[1], /token string token x/);
  assert.equal(J.prismLines(Prism, code, 'cobol'), null);
  assert.equal(J.computeKinds(['```PowerShell extra', 'x', '```'])[0].lang, 'powershell');
});

console.log('logic: ' + passed + ' passed');
