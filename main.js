'use strict';

/*
 * MD Journal — write in fixed-size book pages.
 *
 * Forked from MD Reader (https://github.com/mrrepac/obsidian-md-reader), which
 * paginates rendered notes with CSS columns. MD Journal keeps the book spread but
 * makes the page itself the editor: the note's Markdown lives in a contenteditable
 * surface laid out as fixed-size columns, so text that no longer fits on a page
 * flows onto the next one as you type, exactly like a paper journal.
 *
 * The Markdown source is the model (an array of lines). The DOM is only a view of
 * it: every edit goes through the model and the affected lines are repainted, so
 * the file on disk is always exactly what you typed — nothing is converted from
 * HTML. IME composition is the one thing browsers do not let us intercept; for it
 * the editor lets the browser type and then reads the changed lines back.
 */

const obsidian = require('obsidian');
const { Plugin, ItemView, PluginSettingTab, Setting, Modal, Notice, TFile, TFolder, Platform } = obsidian;

const VIEW_TYPE_JOURNAL = 'md-journal-view';
const PX_PER_MM = 96 / 25.4;

const PAGE_SIZES = {
  a6: { label: 'A6 · pocket (105 × 148 mm)', w: 105, h: 148 },
  b6: { label: 'B6 (125 × 176 mm)', w: 125, h: 176 },
  a5: { label: 'A5 · classic journal (148 × 210 mm)', w: 148, h: 210 },
  'half-letter': { label: 'Half letter (5.5 × 8.5 in)', w: 139.7, h: 215.9 },
  b5: { label: 'B5 (176 × 250 mm)', w: 176, h: 250 },
  a4: { label: 'A4 (210 × 297 mm)', w: 210, h: 297 },
  custom: { label: 'Custom size', w: 0, h: 0 },
};

const FONTS = {
  theme: { label: 'Theme font', css: 'var(--font-text)' },
  serif: { label: 'Book serif', css: '"Literata", "Iowan Old Style", Georgia, "PT Serif", "Times New Roman", serif' },
  sans: { label: 'Sans serif', css: '"Inter", "Segoe UI", Roboto, system-ui, -apple-system, sans-serif' },
  hand: { label: 'Handwriting', css: '"Segoe Print", "Bradley Hand", "Noteworthy", "Caveat", "Kalam", "Comic Sans MS", cursive' },
  mono: { label: 'Typewriter', css: '"Courier Prime", "American Typewriter", "Courier New", var(--font-monospace), monospace' },
  custom: { label: 'Custom…', css: '' },
};

const PAPERS = { plain: 'Plain', ruled: 'Ruled', dotted: 'Dot grid', grid: 'Squared' };
const TINTS = { theme: 'Theme colours', white: 'White', cream: 'Cream', sepia: 'Sepia', gray: 'Gray', night: 'Night' };

const LAYOUTS = { screen: 'Obsidian view (your theme)', journal: 'Journal pages (on paper)' };

const DEFAULT_SETTINGS = {
  layout: 'screen',       // 'screen' (the user's theme) | 'journal' (paper)
  screenMaxWidth: 760,    // px — widest column in the Obsidian view (0 = no limit)
  fixedPage: false,       // Obsidian view: fixed text area per page, scaled to the window
  pageSize: 'a5',
  customWidth: 148,       // mm, when pageSize === 'custom'
  customHeight: 210,      // mm
  pageMode: 'auto',       // 'auto' | 'single' | 'double'
  margin: 14,             // mm, on every side of the page
  fontFamily: 'serif',
  fontFamilyCustom: '',
  fontSize: 15,           // px at 100 % zoom; the page scales to fit the window
  lineHeight: 1.6,
  paper: 'ruled',
  tint: 'cream',
  hideSyntax: true,       // hide Markdown marks on lines you are not editing
  pageNumbers: true,
  headingNewPage: false,  // every top-level heading starts a new page
  animate: true,
  spellcheck: true,
  saveDelay: 700,         // ms after the last keystroke
  journalFile: 'Journal.md',
  dateFormat: 'dddd, D MMMM YYYY',
  openIn: 'tab',          // 'tab' | 'current' | 'split'
  openAt: 'end',          // 'end' | 'last'
  positions: {},          // path -> { line, ch } — where the caret was
};

/* ------------------------------------------------------------------------- */
/*  Markdown: line kinds and inline highlighting (pure, unit-tested)          */
/* ------------------------------------------------------------------------- */

const RE_FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const RE_HEADING = /^(#{1,6})[ \t]+/;
const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_TASK = /^([ \t]*)([-*+])([ \t]+)\[([ xX])\]([ \t]+|$)/;
const RE_UL = /^([ \t]*)([-*+])([ \t]+)/;
const RE_OL = /^([ \t]*)(\d{1,9})([.)])([ \t]+)/;
const RE_QUOTE = /^(?:[ \t]*>[ \t]?)+/;
const RE_PAGEBREAK = /^\s*<!--\s*page-?break\s*-->\s*$/i;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp|svg|avif)$/i;
const RE_IMAGE_WIKI = /^\s*!\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]\s*$/;
const RE_IMAGE_MD = /^\s*!\[[^\]]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)\s*$/;
const PAGEBREAK_LINE = '<!-- pagebreak -->';

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

function splitFrontmatter(text) {
  const m = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { front: '', body: text };
  return { front: m[0], body: text.slice(m[0].length) };
}

function lineKind(t) {
  if (!t.trim()) return { type: 'blank', key: 'blank' };
  if (RE_PAGEBREAK.test(t)) return { type: 'pagebreak', key: 'pagebreak' };
  let m = RE_IMAGE_WIKI.exec(t) || RE_IMAGE_MD.exec(t);
  if (m && (IMAGE_EXT.test(m[1]) || /^https?:/i.test(m[1]))) {
    return { type: 'image', src: m[1], key: 'image' };
  }
  if ((m = RE_HEADING.exec(t))) {
    const level = m[1].length;
    return { type: 'h', level, prefix: m[0].length, key: 'h' + level };
  }
  if (RE_HR.test(t)) return { type: 'hr', key: 'hr' };
  if ((m = RE_TASK.exec(t))) {
    const checkAt = m[1].length + m[2].length + m[3].length;
    const checked = m[4] !== ' ';
    return { type: 'task', indent: m[1], checkAt, checked, prefix: m[0].length, key: 'task' + (checked ? 'x' : '') };
  }
  if ((m = RE_UL.exec(t))) return { type: 'ul', indent: m[1], prefix: m[0].length, key: 'ul' };
  if ((m = RE_OL.exec(t))) {
    return { type: 'ol', indent: m[1], num: Number(m[2]), delim: m[3], space: m[4], prefix: m[0].length, key: 'ol' };
  }
  if ((m = RE_QUOTE.exec(t))) return { type: 'quote', prefix: m[0].length, key: 'quote' };
  return { type: 'p', key: 'p' };
}

function computeKinds(lines) {
  const out = new Array(lines.length);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    const f = RE_FENCE.exec(t);
    if (fence) {
      if (f && f[2][0] === fence.ch && f[2].length >= fence.len && !f[3].trim()) {
        out[i] = { type: 'fence', key: 'fence' };
        fence = null;
      } else {
        out[i] = { type: 'code', key: 'code' };
      }
      continue;
    }
    if (f && !(f[2][0] === '`' && f[3].includes('`'))) {
      fence = { ch: f[2][0], len: f[2].length };
      out[i] = { type: 'fence', key: 'fence', lang: (f[3].trim().split(/\s+/)[0] || '').toLowerCase() };
      continue;
    }
    out[i] = lineKind(t);
  }
  return out;
}

const mark = (s) => '<span class="mj-mark">' + escapeHtml(s) + '</span>';
const linkSpan = (text, href) => '<span class="mj-link" data-href="' + escapeHtml(href) + '">' + escapeHtml(text) + '</span>';
const isWordChar = (c) => !!c && /[\p{L}\p{N}_]/u.test(c);

const RE_CODE_SPAN = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/y;
const RE_WIKILINK = /(!?\[\[)([^[\]\n]+?)(\]\])/y;
const RE_MDLINK = /(!?\[)([^[\]\n]*)(\]\()([^()\n]*)(\))/y;
const RE_STRONG = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/y;
const RE_STRIKE = /~~(?=\S)([\s\S]*?\S)~~/y;
const RE_HIGHLIGHT = /==(?=\S)([\s\S]*?\S)==/y;
const RE_EM = /([*_])(?=[^\s*_])([\s\S]*?[^\s*_]|[^\s*_])\1/y;
const RE_TAG = /#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*/uy;
const RE_URL = /https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/y;

function at(re, s, i) {
  re.lastIndex = i;
  return re.exec(s);
}

/* Renders one line of inline Markdown. Every character of `s` ends up in exactly
   one text node, in order — the editor relies on textContent === source. */
function renderInline(s) {
  let out = '';
  let buf = '';
  let i = 0;
  const flush = () => { if (buf) { out += escapeHtml(buf); buf = ''; } };
  while (i < s.length) {
    const c = s[i];
    const prev = i > 0 ? s[i - 1] : '';
    let m = null;
    let html = null;
    if (c === '`' && (m = at(RE_CODE_SPAN, s, i))) {
      html = mark(m[1]) + '<span class="mj-ic">' + escapeHtml(m[2]) + '</span>' + mark(m[1]);
    } else if ((c === '[' || c === '!') && (m = at(RE_WIKILINK, s, i))) {
      const inner = m[2];
      const bar = inner.indexOf('|');
      const cls = m[1][0] === '!' ? ' mj-embed' : '';
      if (bar >= 0) {
        html = mark(m[1]) + mark(inner.slice(0, bar + 1))
          + linkSpan(inner.slice(bar + 1), inner.slice(0, bar)).replace('mj-link"', 'mj-link' + cls + '"') + mark(m[3]);
      } else {
        html = mark(m[1]) + linkSpan(inner, inner).replace('mj-link"', 'mj-link' + cls + '"') + mark(m[3]);
      }
    } else if ((c === '[' || c === '!') && (m = at(RE_MDLINK, s, i))) {
      html = mark(m[1]) + linkSpan(m[2], m[4]) + mark(m[3] + m[4] + m[5]);
    } else if ((c === '*' || c === '_') && (m = at(RE_STRONG, s, i)) && (c === '*' || !isWordChar(prev))) {
      html = mark(m[1]) + '<span class="mj-b">' + renderInline(m[2]) + '</span>' + mark(m[1]);
    } else if (c === '~' && (m = at(RE_STRIKE, s, i))) {
      html = mark('~~') + '<span class="mj-s">' + renderInline(m[1]) + '</span>' + mark('~~');
    } else if (c === '=' && (m = at(RE_HIGHLIGHT, s, i))) {
      html = mark('==') + '<span class="mj-hlt">' + renderInline(m[1]) + '</span>' + mark('==');
    } else if ((c === '*' || c === '_') && (m = at(RE_EM, s, i))
      && (c === '*' || (!isWordChar(prev) && !isWordChar(s[i + m[0].length])))) {
      html = mark(m[1]) + '<span class="mj-i">' + renderInline(m[2]) + '</span>' + mark(m[1]);
    } else if (c === '#' && (!prev || /\s/.test(prev)) && (m = at(RE_TAG, s, i))) {
      html = '<span class="mj-tag">' + escapeHtml(m[0]) + '</span>';
    } else if (c === 'h' && !isWordChar(prev) && (m = at(RE_URL, s, i))) {
      html = linkSpan(m[0], m[0]);
    }
    if (html !== null) {
      flush();
      out += html;
      i += m[0].length;
    } else {
      buf += c;
      i++;
    }
  }
  flush();
  return out;
}

function renderLine(text, k, resolveImage) {
  switch (k.type) {
    case 'code':
      if (k.html != null) return k.html || '<br>';
      return text ? escapeHtml(text) : '<br>';
    case 'blank':
      return text ? escapeHtml(text) : '<br>';
    case 'fence':
    case 'pagebreak':
      return mark(text);
    case 'hr':
      return '<span class="mj-hr-src">' + escapeHtml(text) + '</span>';
    case 'h':
    case 'quote':
      return mark(text.slice(0, k.prefix)) + renderInline(text.slice(k.prefix));
    case 'ul':
      return escapeHtml(k.indent) + '<span class="mj-bullet">' + escapeHtml(text.slice(k.indent.length, k.prefix)) + '</span>'
        + renderInline(text.slice(k.prefix));
    case 'ol':
      return escapeHtml(k.indent) + '<span class="mj-olmark">' + escapeHtml(text.slice(k.indent.length, k.prefix)) + '</span>'
        + renderInline(text.slice(k.prefix));
    case 'task':
      return escapeHtml(k.indent) + mark(text.slice(k.indent.length, k.checkAt))
        + '<span class="mj-check">' + escapeHtml(text.slice(k.checkAt, k.checkAt + 3)) + '</span>'
        + escapeHtml(text.slice(k.checkAt + 3, k.prefix)) + renderInline(text.slice(k.prefix));
    case 'image': {
      const src = resolveImage ? resolveImage(k.src) : null;
      return '<span class="mj-imgsrc">' + escapeHtml(text) + '</span>'
        + (src ? '<img class="mj-img" contenteditable="false" draggable="false" alt="" src="' + escapeHtml(src) + '">' : '');
    }
    default:
      return renderInline(text) || '<br>';
  }
}

function lineClass(k) {
  let c = 'mj-line mj-' + k.type;
  if (k.type === 'h') c += ' mj-h' + k.level;
  if (k.type === 'task' && k.checked) c += ' mj-task-done';
  return c;
}

/* What a new line after `line` should start with (list continuation). Returns
   null when Enter should end the list instead, '' for a plain new line. */
function continuationPrefix(line, k, ch) {
  if (!k || !['ul', 'ol', 'task', 'quote'].includes(k.type) || ch < k.prefix) return '';
  if (!line.slice(k.prefix).trim()) return null;
  if (k.type === 'task') return line.slice(0, k.checkAt) + '[ ] ';
  if (k.type === 'ol') return k.indent + (k.num + 1) + k.delim + k.space;
  return line.slice(0, k.prefix);
}

let graphemes = null;
function segmenter() {
  if (graphemes === null) {
    graphemes = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : false;
  }
  return graphemes;
}

function prevBoundary(s, ch) {
  if (ch <= 0) return 0;
  const seg = segmenter();
  if (seg) {
    const base = Math.max(0, ch - 64);
    let last = base;
    for (const x of seg.segment(s.slice(base, ch))) last = base + x.index;
    return last;
  }
  const c = s.charCodeAt(ch - 1);
  return c >= 0xdc00 && c <= 0xdfff && ch >= 2 ? ch - 2 : ch - 1;
}

function nextBoundary(s, ch) {
  if (ch >= s.length) return s.length;
  const seg = segmenter();
  if (seg) {
    for (const x of seg.segment(s.slice(ch, ch + 64))) return ch + x.segment.length;
  }
  const c = s.charCodeAt(ch);
  return c >= 0xd800 && c <= 0xdbff && ch + 2 <= s.length ? ch + 2 : ch + 1;
}

const isSpace = (c) => /\s/.test(c);
function prevWordStart(s, ch) {
  let i = ch;
  while (i > 0 && isSpace(s[i - 1])) i--;
  if (i > 0 && isWordChar(s[i - 1])) while (i > 0 && isWordChar(s[i - 1])) i--;
  else while (i > 0 && !isWordChar(s[i - 1]) && !isSpace(s[i - 1])) i--;
  return i;
}
function nextWordEnd(s, ch) {
  let i = ch;
  while (i < s.length && isSpace(s[i])) i++;
  if (i < s.length && isWordChar(s[i])) while (i < s.length && isWordChar(s[i])) i++;
  else while (i < s.length && !isWordChar(s[i]) && !isSpace(s[i])) i++;
  return i;
}

function countWords(text) {
  const m = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
  return m ? m.length : 0;
}

/* Reads a contenteditable DOM back into lines: block elements and <br> break
   lines, a trailing <br> in a block is only a placeholder. Also locates (fNode,
   fOff) as a { line, ch } position. */
function domToLines(root, fNode, fOff) {
  const lines = [];
  let cur = null;
  let caret = null;
  const here = () => ({ line: lines.length, ch: cur === null ? 0 : cur.length });
  const isBlock = (n) => n.nodeName === 'DIV' || n.nodeName === 'P' || n.nodeName === 'LI';
  const visit = (node) => {
    if (node.nodeType === 3) {
      if (cur === null) cur = '';
      if (node === fNode) caret = { line: lines.length, ch: cur.length + Math.min(fOff, node.data.length) };
      cur += node.data;
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.nodeName === 'BR') {
      const placeholder = !node.nextSibling && node.parentNode && node.parentNode !== root && isBlock(node.parentNode);
      if (!placeholder) { lines.push(cur === null ? '' : cur); cur = ''; }
      return;
    }
    const block = isBlock(node);
    if (block && cur !== null) { lines.push(cur); }
    if (block) cur = '';
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i++) {
      if (node === fNode && i === fOff && !caret) caret = here();
      visit(kids[i]);
    }
    if (node === fNode && fOff >= kids.length && !caret) caret = here();
    if (block) { lines.push(cur); cur = null; }
  };
  const kids = root.childNodes;
  for (let i = 0; i < kids.length; i++) {
    if (root === fNode && i === fOff && !caret) caret = here();
    visit(kids[i]);
  }
  if (cur !== null) lines.push(cur);
  if (!lines.length) lines.push('');
  if (caret && caret.line >= lines.length) caret = { line: lines.length - 1, ch: lines[lines.length - 1].length };
  return { lines, caret };
}

const cmpPos = (a, b) => (a.line - b.line) || (a.ch - b.ch);
const samePos = (a, b) => cmpPos(a, b) === 0;
const ordered = (a, b) => (cmpPos(a, b) <= 0 ? [a, b] : [b, a]);
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');

function pageGeometry(s) {
  const preset = PAGE_SIZES[s.pageSize] || PAGE_SIZES.a5;
  const wMm = s.pageSize === 'custom' ? s.customWidth : preset.w;
  const hMm = s.pageSize === 'custom' ? s.customHeight : preset.h;
  const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const W = Math.round(clamp(wMm, 50, 420, 148) * PX_PER_MM);
  const H = Math.round(clamp(hMm, 50, 600, 210) * PX_PER_MM);
  const fs = clamp(s.fontSize, 8, 48, 15);
  const lh = Math.max(8, Math.round(fs * clamp(s.lineHeight, 1, 3, 1.6)));
  const m = Math.min(Math.round(clamp(s.margin, 2, 50, 14) * PX_PER_MM), Math.floor((W - 80) / 2));
  const colW = W - 2 * m;
  const top = Math.min(m, Math.floor((H - 2 * lh) / 2));
  const contentH = Math.max(lh * 2, Math.floor((H - 2 * top) / lh) * lh);
  return { W, H, fs, lh, m, colW, gap: 2 * m, top, contentH, bottom: H - top - contentH };
}

/* Obsidian view: the page is whatever the pane gives us, like MD Reader. */
function screenGeometry(vw, vh, s, fs, phone) {
  const narrow = vw < 600;
  const side = narrow ? 12 : 56;            // room for the side page buttons
  const gap = narrow ? 24 : 64;
  const lh = Math.max(8, Math.round(fs * (Number.isFinite(s.lineHeight) ? Math.min(3, Math.max(1, s.lineHeight)) : 1.6)));
  const avail = Math.max(120, vw - 2 * side);
  let n = s.pageMode === 'single' ? 1 : s.pageMode === 'double' ? 2 : (!phone && avail >= 2 * 380 + gap ? 2 : 1);
  let colW = Math.floor((avail - (n - 1) * gap) / n);
  if (n === 2 && colW < 220) { n = 1; colW = avail; }
  if (s.screenMaxWidth > 0) colW = Math.min(colW, Math.max(200, s.screenMaxWidth));
  const top = vh < 500 ? 12 : 24;
  const H = Math.max(lh * 3, Math.floor(vh));
  const contentH = Math.max(lh * 2, H - 2 * top);
  return { W: colW + gap, H, fs, lh, m: gap / 2, colW, gap, top, contentH, bottom: H - top - contentH, n, narrow };
}

const PRISM_ALIASES = {
  ps1: 'powershell', ps: 'powershell', pwsh: 'powershell', sh: 'bash', shell: 'bash', zsh: 'bash', js: 'javascript',
  ts: 'typescript', py: 'python', 'c++': 'cpp', cs: 'csharp', 'c#': 'csharp', md: 'markdown', yml: 'yaml',
  html: 'markup', xml: 'markup', svg: 'markup', rb: 'ruby', rs: 'rust', kt: 'kotlin',
};

/* Highlights a fenced block with Prism and splits the result back into one HTML
   string per source line (tokens may span lines, e.g. here-strings). The text of
   each line is unchanged, only wrapped in token spans. */
function prismLines(Prism, code, lang) {
  if (!Prism || !Prism.languages || !Prism.tokenize) return null;
  const grammar = Prism.languages[lang] || Prism.languages[PRISM_ALIASES[lang]];
  if (!grammar) return null;
  let tokens;
  try { tokens = Prism.tokenize(code, grammar); } catch (e) { return null; }
  const lines = [''];
  const walk = (tok, cls) => {
    if (typeof tok === 'string') {
      tok.split('\n').forEach((part, i) => {
        if (i) lines.push('');
        if (part) lines[lines.length - 1] += cls ? '<span class="' + cls + '">' + escapeHtml(part) + '</span>' : escapeHtml(part);
      });
    } else if (Array.isArray(tok)) {
      for (const t of tok) walk(t, cls);
    } else if (tok) {
      const own = 'token ' + tok.type + (tok.alias ? ' ' + [].concat(tok.alias).join(' ') : '');
      walk(tok.content, cls ? cls + ' ' + own : own);
    }
  };
  walk(tokens, '');
  return lines;
}

/* ------------------------------------------------------------------------- */
/*  PagedEditor — the journal page itself (DOM only, no Obsidian API)         */
/* ------------------------------------------------------------------------- */

class PagedEditor {
  constructor(parent, host, settings) {
    this.host = host || {};
    this.settings = settings;
    this.lines = [''];
    this.lineEls = [];
    this.rendered = [];
    this.kinds = [];
    this.activeEls = new Set();
    this.sel = null;
    this.undoStack = [];
    this.redoStack = [];
    this.lastUndoKind = null;
    this.lastUndoTime = 0;
    this.composing = false;
    this.spread = 0;
    this.n = 1;
    this.scale = 1;
    this.totalPages = 1;
    this.paperEls = [];
    this.laidOut = false;
    this.status = '';
    this.wordTimer = null;
    this.build(parent);
    this.configure(settings);
    this.syncDOM();
  }

  /* ---------- DOM ---------- */

  build(parent) {
    const el = (tag, cls, p) => { const e = document.createElement(tag); if (cls) e.className = cls; if (p) p.appendChild(e); return e; };
    this.root = el('div', 'mj-root', parent);
    this.viewport = el('div', 'mj-viewport', this.root);
    this.book = el('div', 'mj-book', this.viewport);
    this.stage = el('div', 'mj-stage', this.book);
    this.track = el('div', 'mj-track', this.stage);
    this.papers = el('div', 'mj-papers', this.track);
    this.content = el('div', 'mj-content', this.track);
    this.content.contentEditable = 'true';
    this.content.setAttribute('role', 'textbox');
    this.content.setAttribute('aria-multiline', 'true');
    this.content.setAttribute('autocapitalize', 'sentences');
    this.spine = el('div', 'mj-spine', this.stage);

    this.bar = el('div', 'mj-bar', this.root);
    this.prevBtn = el('button', 'mj-nav clickable-icon', this.bar);
    this.prevBtn.textContent = '‹';
    this.prevBtn.setAttribute('aria-label', 'Previous page');
    this.info = el('span', 'mj-info', this.bar);
    this.nextBtn = el('button', 'mj-nav clickable-icon', this.bar);
    this.nextBtn.textContent = '›';
    this.nextBtn.setAttribute('aria-label', 'Next page');
    this.meta = el('span', 'mj-meta', this.bar);

    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      (this._listeners || (this._listeners = [])).push([target, type, fn, opts]);
    };
    const c = this.content;
    on(c, 'beforeinput', (e) => this.onBeforeInput(e));
    on(c, 'input', (e) => this.onInput(e));
    on(c, 'keydown', (e) => this.onKeyDown(e));
    on(c, 'compositionstart', () => this.onCompositionStart());
    on(c, 'compositionend', () => this.onCompositionEnd());
    on(c, 'copy', (e) => this.onCopy(e, false));
    on(c, 'cut', (e) => this.onCopy(e, true));
    on(c, 'paste', (e) => this.onPaste(e));
    on(c, 'drop', (e) => this.onDrop(e));
    on(c, 'dragstart', (e) => e.preventDefault());
    on(c, 'mousedown', (e) => this.onContentMouseDown(e));
    on(c, 'load', (e) => { if (e.target && e.target.nodeName === 'IMG') this.fitImage(e.target); }, true);
    on(this.papers, 'mousedown', (e) => this.onPaperMouseDown(e));
    on(document, 'selectionchange', () => this.onSelectionChange());
    on(this.viewport, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(this.viewport, 'touchstart', (e) => this.onTouchStart(e), { passive: true });
    on(this.viewport, 'touchend', (e) => this.onTouchEnd(e), { passive: true });
    on(this.prevBtn, 'click', () => this.flip(-1));
    on(this.nextBtn, 'click', () => this.flip(1));
    on(this.bar, 'mousedown', (e) => e.preventDefault()); // keep the caret in the page
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.layout());
      this.ro.observe(this.viewport);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (this.root.isConnected) this.layout(); });
  }

  destroy() {
    for (const [t, type, fn, opts] of this._listeners || []) t.removeEventListener(type, fn, opts);
    this._listeners = [];
    if (this.ro) this.ro.disconnect();
    clearTimeout(this.wordTimer);
    this.root.remove();
  }

  configure(settings) {
    this.settings = settings;
    this.screen = settings.layout === 'screen';
    // the Obsidian view always wears the theme; paper and type are journal settings
    const font = this.screen ? FONTS.theme.css : settings.fontFamily === 'custom'
      ? (settings.fontFamilyCustom || FONTS.serif.css)
      : (FONTS[settings.fontFamily] || FONTS.serif).css;
    const tint = this.screen ? 'theme' : settings.tint;
    this.root.style.setProperty('--mj-font', font);
    const cls = this.root.classList;
    cls.toggle('mj-screen', this.screen);
    for (const t of Object.keys(TINTS)) cls.toggle('mj-tint-' + t, tint === t);
    for (const p of Object.keys(PAPERS)) cls.toggle('mj-paper-' + p, !this.screen && settings.paper === p);
    cls.toggle('mj-hide-syntax', !!settings.hideSyntax);
    cls.toggle('mj-no-pnum', this.screen || !settings.pageNumbers);
    cls.toggle('mj-h1-newpage', !!settings.headingNewPage);
    this.content.spellcheck = settings.spellcheck !== false;
    this.geo = null;
    this.laidOut = false;
    // A fixed page never depends on the window: same text per page, just scaled.
    this.fixed = !this.screen || !!settings.fixedPage;
    cls.toggle('mj-fixed', this.fixed);
    if (!this.screen) this.applyGeometry(pageGeometry(settings));
    else if (this.fixed) this.applyGeometry(pageGeometry({ ...settings, fontSize: this.themeFontSize() }));
    this.layout();
  }

  themeFontSize() {
    return parseFloat(getComputedStyle(this.root).getPropertyValue('--font-text-size')) || 16;
  }

  applyGeometry(g) {
    this.geo = g;
    const st = this.root.style;
    st.setProperty('--mj-page-w', g.W + 'px');
    st.setProperty('--mj-page-h', g.H + 'px');
    st.setProperty('--mj-margin', g.m + 'px');
    st.setProperty('--mj-top', g.top + 'px');
    st.setProperty('--mj-bottom', g.bottom + 'px');
    st.setProperty('--mj-col-w', g.colW + 'px');
    st.setProperty('--mj-content-h', g.contentH + 'px');
    st.setProperty('--mj-fs', g.fs + 'px');
    st.setProperty('--mj-lh', g.lh + 'px');
    this.content.querySelectorAll('img.mj-img').forEach((img) => this.fitImage(img, true));
  }

  /* Journal pages: scale the fixed-size page to the window, one page or a spread.
     Obsidian view: the pane is the page, so the columns are re-cut to fit it. */
  layout() {
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    if (!vw || !vh) return;
    const phone = !!(Platform && Platform.isPhone);
    const firstPage = this.spread * this.n;
    let n;
    let scale;
    let reflowed = false;
    if (!this.fixed) {
      const g = screenGeometry(vw, vh, this.settings, this.themeFontSize(), phone);
      const old = this.geo;
      if (!old || old.W !== g.W || old.H !== g.H || old.colW !== g.colW || old.lh !== g.lh || old.fs !== g.fs) {
        this.applyGeometry(g);
        reflowed = !!old;
      }
      this.root.classList.toggle('mj-narrow', g.narrow);
      n = g.n;
      scale = 1;
    } else {
      const g = this.geo;
      this.root.classList.remove('mj-narrow');
      const pad = vw < 520 ? 8 : this.screen ? 52 : 28; // the theme view keeps room for its side buttons
      const aw = Math.max(50, vw - 2 * pad);
      const ah = Math.max(50, vh - 2 * pad);
      const single = Math.min(aw / g.W, ah / g.H);
      const double = Math.min(aw / (2 * g.W), ah / g.H);
      const mode = this.settings.pageMode;
      n = mode === 'single' ? 1 : mode === 'double' ? 2 : (double >= 0.8 * single && !phone ? 2 : 1);
      scale = Math.min(n === 2 ? double : single, 3);
    }
    const g = this.geo;
    this.n = n;
    this.scale = scale;
    this.root.classList.toggle('mj-double', n === 2);
    this.book.style.width = (n * g.W * scale) + 'px';
    this.book.style.height = (g.H * scale) + 'px';
    this.stage.style.width = (n * g.W) + 'px';
    this.stage.style.height = g.H + 'px';
    this.stage.style.transform = 'scale(' + scale + ')';
    this.content.style.width = (n * g.colW + (n - 1) * g.gap) + 'px';
    this.content.style.columnCount = String(n);
    this.spread = Math.floor(firstPage / n);
    this.laidOut = true;
    this.measure();
    // pages were re-cut (Obsidian view resized): stay with the caret, not the page number
    if (this._revealPending || reflowed) { this._revealPending = false; this.revealCaret(false); }
  }

  /* Repaint every line (e.g. once code highlighting becomes available). */
  repaint() {
    for (const el of this.lineEls) el._mjKey = null;
    this.syncDOM();
    if (this.sel && this.hasFocus()) this.setSelection(this.sel.anchor, this.sel.head);
    this.measure();
  }

  /* Fenced blocks with a language get Prism token spans, one HTML string per line. */
  highlightCode(lines, kinds) {
    const hl = this.host.highlight;
    if (!hl) return;
    const cache = this._hlCache || (this._hlCache = new Map());
    for (let i = 0; i < kinds.length; i++) {
      const k = kinds[i];
      if (k.type !== 'fence' || !k.lang) continue;
      let j = i + 1;
      while (j < kinds.length && kinds[j].type === 'code') j++;
      if (j > i + 1) {
        const code = lines.slice(i + 1, j).join('\n');
        const ck = k.lang + '\u0000' + code;
        let html = cache.get(ck);
        if (html === undefined) {
          html = hl(code, k.lang) || null;
          cache.set(ck, html);
          if (cache.size > 64) cache.delete(cache.keys().next().value);
        }
        if (html && html.length === j - i - 1) {
          for (let x = i + 1; x < j; x++) kinds[x] = { type: 'code', key: 'code\u0001' + html[x - i - 1], html: html[x - i - 1] };
        }
      }
      i = j - 1;
    }
  }

  pageOfRect(r) {
    const cb = this.content.getBoundingClientRect();
    const x = ((r.left + r.right) / 2 - cb.left) / (this.scale || 1);
    return Math.max(0, Math.floor(x / (this.geo.colW + this.geo.gap)));
  }

  measure() {
    if (!this.laidOut) return;
    let pages = 1;
    const last = this.lineEls[this.lineEls.length - 1];
    if (last) {
      const rs = last.getClientRects();
      if (rs.length) pages = this.pageOfRect(rs[rs.length - 1]) + 1;
      if (this.kinds[this.kinds.length - 1] && this.kinds[this.kinds.length - 1].type === 'pagebreak') pages++;
    }
    this.totalPages = pages;
    this.renderPapers();
    const spreads = this.spreadCount();
    if (this.spread > spreads - 1) this.showSpread(spreads - 1, false);
    else this.showSpread(this.spread, false, true);
  }

  spreadCount() { return Math.max(1, Math.ceil(this.totalPages / this.n)); }

  renderPapers() {
    const g = this.geo;
    const count = this.spreadCount() * this.n;
    while (this.paperEls.length < count) {
      const p = document.createElement('div');
      p.className = 'mj-paper';
      const rules = document.createElement('div');
      rules.className = 'mj-rules';
      const num = document.createElement('div');
      num.className = 'mj-pnum';
      p.append(rules, num);
      this.papers.appendChild(p);
      this.paperEls.push(p);
    }
    while (this.paperEls.length > count) this.paperEls.pop().remove();
    this.paperEls.forEach((p, i) => {
      p.style.left = (i * g.W) + 'px';
      p.className = 'mj-paper' + (this.n === 2 ? (i % 2 ? ' mj-paper-r' : ' mj-paper-l') : '');
      p.lastChild.textContent = String(i + 1);
    });
  }

  showSpread(s, animate, silent) {
    if (!this.geo) return;
    const spreads = this.spreadCount();
    s = Math.max(0, Math.min(s, spreads - 1));
    const changed = s !== this.spread || !this._shown;
    this.spread = s;
    this._shown = true;
    if (changed || !silent) {
      this.track.style.transition = animate && this.settings.animate ? 'transform 0.38s cubic-bezier(.25,.75,.25,1)' : 'none';
      this.track.style.transform = 'translate3d(' + (-s * this.n * this.geo.W) + 'px,0,0)';
    }
    this.updateBar();
  }

  flip(delta) {
    const before = this.spread;
    this.showSpread(this.spread + delta, true);
    if (this.spread === before) return;
    if (this.hasFocus()) {
      const pos = this.posAtPageStart(this.spread * this.n);
      if (pos) this.setSelection(pos, pos);
    }
  }

  updateBar() {
    const first = this.spread * this.n + 1;
    const total = this.spreadCount() * this.n;
    this.info.textContent = (this.n === 2 ? 'Pages ' + first + '–' + (first + 1) : 'Page ' + first) + ' of ' + total;
    this.prevBtn.disabled = this.spread <= 0;
    this.nextBtn.disabled = this.spread >= this.spreadCount() - 1;
  }

  setStatus(text) {
    this.status = text;
    this.renderMeta();
  }

  renderMeta() {
    const words = this.words == null ? '' : this.words.toLocaleString() + (this.words === 1 ? ' word' : ' words');
    this.meta.textContent = [words, this.status].filter(Boolean).join(' · ');
  }

  scheduleWordCount() {
    clearTimeout(this.wordTimer);
    this.wordTimer = setTimeout(() => { this.words = countWords(this.getText()); this.renderMeta(); }, 300);
  }

  /* ---------- model <-> DOM ---------- */

  getText() { return this.lines.join('\n'); }

  setText(text, opts = {}) {
    if (opts.resetHistory) { this.undoStack = []; this.redoStack = []; this.lastUndoKind = null; }
    else this.pushUndo('other');
    const old = this.sel;
    this.lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    this.syncDOM();
    const c = this.clampPos(opts.caret || (old && old.head) || this.endPos());
    this.sel = { anchor: c, head: c };
    this.updateActive(this.sel);
    if (this.hasFocus()) this.setSelection(c, c);
    this.measure();
    if (this.laidOut) this.revealCaret(false);
    else this._revealPending = true;
    this.scheduleWordCount();
  }

  endPos() { const l = this.lines.length - 1; return { line: l, ch: this.lines[l].length }; }

  clampPos(p) {
    const int = (v) => (Number.isFinite(v) ? Math.trunc(v) : v > 0 ? Number.MAX_SAFE_INTEGER : 0);
    const line = Math.max(0, Math.min(int(p.line), this.lines.length - 1));
    return { line, ch: Math.max(0, Math.min(int(p.ch), this.lines[line].length)) };
  }

  syncDOM() {
    const old = this.rendered;
    const neu = this.lines;
    let s = 0;
    const min = Math.min(old.length, neu.length);
    while (s < min && old[s] === neu[s]) s++;
    let eo = old.length;
    let en = neu.length;
    while (eo > s && en > s && old[eo - 1] === neu[en - 1]) { eo--; en--; }
    if (eo > s || en > s) {
      const ref = this.lineEls[eo] || null;
      for (let i = s; i < eo; i++) { this.activeEls.delete(this.lineEls[i]); this.lineEls[i].remove(); }
      const fresh = [];
      const frag = document.createDocumentFragment();
      for (let i = s; i < en; i++) {
        const d = document.createElement('div');
        fresh.push(d);
        frag.appendChild(d);
      }
      this.content.insertBefore(frag, ref);
      this.lineEls = this.lineEls.slice(0, s).concat(fresh, this.lineEls.slice(eo));
    }
    this.rendered = neu.slice();
    const kinds = computeKinds(neu);
    this.highlightCode(neu, kinds);
    for (let i = 0; i < neu.length; i++) {
      const el = this.lineEls[i];
      el._mjIdx = i;
      const k = kinds[i];
      if (el._mjText !== neu[i] || el._mjKey !== k.key) this.paintLine(el, neu[i], k);
    }
    this.kinds = kinds;
    this.content.classList.toggle('mj-empty', neu.length === 1 && neu[0] === '');
  }

  paintLine(el, text, k) {
    el.className = lineClass(k) + (this.activeEls.has(el) ? ' mj-active' : '');
    el.innerHTML = renderLine(text, k, this.host.resolveImage);
    el._mjText = text;
    el._mjKey = k.key;
  }

  fitImage(img, quiet) {
    const g = this.geo;
    if (!g) return;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh) return;
    let h = Math.min(g.colW, nw) * nh / nw;
    h = Math.min(h, g.contentH - g.lh);
    h = Math.max(g.lh, Math.floor(h / g.lh) * g.lh); // keep the text on the ruling
    img.style.height = h + 'px';
    img.style.width = Math.min(g.colW, h * nw / nh) + 'px';
    if (!quiet) this.measure();
  }

  lineElOf(node) {
    let el = node && (node.nodeType === 1 ? node : node.parentNode);
    while (el && el.parentNode !== this.content) el = el.parentNode;
    return el && el._mjIdx != null && this.lineEls[el._mjIdx] === el ? el : null;
  }

  posFromDOM(node, offset) {
    if (node === this.content) {
      const n = this.lineEls.length;
      if (offset >= n) return this.endPos();
      return { line: offset, ch: 0 };
    }
    const el = this.lineElOf(node);
    if (!el) return null;
    const line = el._mjIdx;
    const r = document.createRange();
    r.setStart(el, 0);
    try { r.setEnd(node, offset); } catch (e) { return { line, ch: 0 }; }
    return { line, ch: Math.min(r.toString().length, this.lines[line].length) };
  }

  domPoint(pos) {
    const el = this.lineEls[pos.line];
    if (!el) return [this.content, 0];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let t;
    let last = null;
    while ((t = w.nextNode())) {
      const len = t.data.length;
      if (pos.ch <= acc + len) return [t, pos.ch - acc];
      acc += len;
      last = t;
    }
    return last ? [last, last.data.length] : [el, 0];
  }

  readSelection() {
    const s = document.getSelection();
    if (!s || !s.rangeCount || !s.anchorNode) return null;
    if (!this.content.contains(s.anchorNode) || !this.content.contains(s.focusNode)) return null;
    const anchor = this.posFromDOM(s.anchorNode, s.anchorOffset);
    const head = this.posFromDOM(s.focusNode, s.focusOffset);
    return anchor && head ? { anchor, head } : null;
  }

  hasFocus() { return document.activeElement === this.content; }

  focus() {
    this.content.focus({ preventScroll: true });
    const c = this.sel ? this.sel : { anchor: this.endPos(), head: this.endPos() };
    this.setSelection(this.clampPos(c.anchor), this.clampPos(c.head));
    this.revealCaret(false);
  }

  setSelection(anchor, head = anchor) {
    this.sel = { anchor, head };
    this.updateActive(this.sel);
    this._expected = this.sel;
    const [an, ao] = this.domPoint(anchor);
    const [hn, ho] = this.domPoint(head);
    const s = document.getSelection();
    if (s) s.setBaseAndExtent(an, ao, hn, ho);
  }

  /* Lines that hold the caret show their Markdown marks; the rest hide them. */
  updateActive(sel) {
    const want = new Set();
    if (sel) {
      for (const p of [sel.anchor, sel.head]) { const el = this.lineEls[p.line]; if (el) want.add(el); }
    }
    let changed = false;
    for (const el of this.activeEls) if (!want.has(el)) { el.classList.remove('mj-active'); changed = true; }
    for (const el of want) if (!this.activeEls.has(el)) { el.classList.add('mj-active'); changed = true; }
    this.activeEls = want;
    return changed;
  }

  rectAt(pos) {
    const [node, off] = this.domPoint(pos);
    const r = document.createRange();
    if (node.nodeType === 3) {
      r.setStart(node, off);
      r.collapse(true);
      let rs = r.getClientRects();
      if (rs.length) return rs[rs.length - 1];
      if (off < node.data.length) {
        r.setEnd(node, off + 1);
        rs = r.getClientRects();
        if (rs.length) return rs[0];
      }
      if (off > 0) {
        r.setStart(node, off - 1);
        r.setEnd(node, off);
        rs = r.getClientRects();
        if (rs.length) { const x = rs[rs.length - 1]; return { left: x.right, right: x.right, top: x.top, bottom: x.bottom }; }
      }
    }
    const el = this.lineEls[pos.line];
    if (el) { const rs = el.getClientRects(); if (rs.length) return rs[0]; }
    return null;
  }

  revealCaret(animate) {
    if (!this.sel || !this.laidOut) return;
    const r = this.rectAt(this.sel.head);
    if (!r) return;
    const s = Math.floor(this.pageOfRect(r) / this.n);
    if (s !== this.spread) this.showSpread(s, animate);
  }

  /* First caret position on page p (for flipping with the editor focused). */
  posAtPageStart(p) {
    const els = this.lineEls;
    const pageOf = (r) => this.pageOfRect(r);
    let lo = 0;
    let hi = els.length - 1;
    let found = -1;
    while (lo <= hi) { // first line whose last fragment is on page >= p
      const mid = (lo + hi) >> 1;
      const rs = els[mid].getClientRects();
      if (rs.length && pageOf(rs[rs.length - 1]) >= p) { found = mid; hi = mid - 1; } else lo = mid + 1;
    }
    if (found < 0) return this.endPos();
    const el = els[found];
    const first = el.getClientRects();
    if (!first.length || pageOf(first[0]) >= p) return { line: found, ch: 0 };
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const r = document.createRange();
    let t;
    while ((t = w.nextNode())) {
      r.selectNodeContents(t);
      const rs = r.getClientRects();
      if (!rs.length || pageOf(rs[rs.length - 1]) < p) continue;
      let a = 0;
      let b = t.data.length - 1;
      let k = t.data.length;
      while (a <= b) {
        const mid = (a + b) >> 1;
        r.setStart(t, mid);
        r.setEnd(t, mid + 1);
        const cr = r.getClientRects();
        if (cr.length && pageOf(cr[0]) >= p) { k = mid; b = mid - 1; } else a = mid + 1;
      }
      return this.posFromDOM(t, k) || { line: found, ch: 0 };
    }
    return { line: found, ch: 0 };
  }

  /* ---------- editing ---------- */

  snapshot() {
    return { lines: this.lines.slice(), sel: this.sel ? { anchor: { ...this.sel.anchor }, head: { ...this.sel.head } } : null };
  }

  pushUndo(kind) {
    const now = Date.now();
    const coalesce = (kind === 'type' || kind === 'delete') && kind === this.lastUndoKind && now - this.lastUndoTime < 1200;
    this.lastUndoKind = kind;
    this.lastUndoTime = now;
    if (coalesce) return;
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.restore(this.undoStack.pop());
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.restore(this.redoStack.pop());
  }

  restore(snap) {
    this.lastUndoKind = null;
    this.lines = snap.lines;
    const sel = snap.sel || { anchor: this.endPos(), head: this.endPos() };
    this.commit(this.clampPos(sel.anchor), this.clampPos(sel.head));
  }

  replaceRange(from, to, text) {
    from = this.clampPos(from);
    to = this.clampPos(to);
    const before = this.lines[from.line].slice(0, from.ch);
    const after = this.lines[to.line].slice(to.ch);
    const parts = text.split('\n');
    const endCh = parts[parts.length - 1].length + (parts.length === 1 ? before.length : 0);
    parts[0] = before + parts[0];
    parts[parts.length - 1] += after;
    this.lines = this.lines.slice(0, from.line).concat(parts, this.lines.slice(to.line + 1));
    return { line: from.line + parts.length - 1, ch: endCh };
  }

  edit(from, to, text, kind) {
    [from, to] = ordered(from, to);
    this.pushUndo(kind === 'type' && !samePos(from, to) ? 'replace' : kind);
    const caret = this.replaceRange(from, to, text);
    this.commit(caret, caret);
  }

  commit(anchor, head = anchor) {
    this.syncDOM();
    if (this.hasFocus()) this.setSelection(anchor, head);
    else { this.sel = { anchor, head }; this.updateActive(this.sel); }
    this.measure();
    this.revealCaret(true);
    this.changed();
  }

  changed() {
    this.scheduleWordCount();
    if (this.host.onChange) this.host.onChange();
  }

  currentSel() {
    return this.readSelection() || this.sel;
  }

  getRangeText(from, to) {
    [from, to] = ordered(from, to);
    if (from.line === to.line) return this.lines[from.line].slice(from.ch, to.ch);
    const out = [this.lines[from.line].slice(from.ch)];
    for (let l = from.line + 1; l < to.line; l++) out.push(this.lines[l]);
    out.push(this.lines[to.line].slice(0, to.ch));
    return out.join('\n');
  }

  insertNewline(sel, plain) {
    const [from, to] = ordered(sel.anchor, sel.head);
    if (!plain && samePos(from, to)) {
      const line = this.lines[from.line];
      const k = this.kinds[from.line];
      const next = continuationPrefix(line, k, from.ch);
      if (next === null && from.ch === line.length) { // Enter on an empty item ends the list
        this.edit({ line: from.line, ch: 0 }, { line: from.line, ch: line.length }, '', 'other');
        return;
      }
      if (next) { this.edit(from, to, '\n' + next, 'other'); return; }
    }
    this.edit(from, to, '\n', 'other');
  }

  deleteBackward(sel, unit) {
    const [from, to] = ordered(sel.anchor, sel.head);
    if (!samePos(from, to)) { this.edit(from, to, '', 'other'); return; }
    const p = from;
    if (p.ch === 0) {
      if (p.line > 0) this.edit({ line: p.line - 1, ch: this.lines[p.line - 1].length }, p, '', 'delete');
      return;
    }
    const line = this.lines[p.line];
    const k = this.kinds[p.line];
    if (unit === 'char' && k && ['ul', 'ol', 'task'].includes(k.type) && p.ch === k.prefix) {
      this.edit({ line: p.line, ch: k.indent.length }, p, '', 'other'); // Backspace right after "- " drops the bullet
      return;
    }
    const start = unit === 'word' ? prevWordStart(line, p.ch) : unit === 'line' ? 0 : prevBoundary(line, p.ch);
    this.edit({ line: p.line, ch: start }, p, '', 'delete');
  }

  deleteForward(sel, unit) {
    const [from, to] = ordered(sel.anchor, sel.head);
    if (!samePos(from, to)) { this.edit(from, to, '', 'other'); return; }
    const p = from;
    const line = this.lines[p.line];
    if (p.ch >= line.length) {
      if (p.line < this.lines.length - 1) this.edit(p, { line: p.line + 1, ch: 0 }, '', 'delete');
      return;
    }
    const end = unit === 'word' ? nextWordEnd(line, p.ch) : unit === 'line' ? line.length : nextBoundary(line, p.ch);
    this.edit(p, { line: p.line, ch: end }, '', 'delete');
  }

  indent(sel, outdent) {
    const [from, to] = ordered(sel.anchor, sel.head);
    const k = this.kinds[from.line];
    const listy = k && ['ul', 'ol', 'task'].includes(k.type);
    if (!outdent && samePos(from, to) && !listy) { this.edit(from, to, '\t', 'other'); return; }
    this.pushUndo('other');
    const shift = {};
    for (let l = from.line; l <= to.line; l++) {
      if (outdent) {
        const m = /^(\t| {1,4})/.exec(this.lines[l]);
        if (!m) continue;
        this.lines[l] = this.lines[l].slice(m[0].length);
        shift[l] = -m[0].length;
      } else {
        this.lines[l] = '\t' + this.lines[l];
        shift[l] = 1;
      }
    }
    const move = (p) => ({ line: p.line, ch: Math.max(0, p.ch + (shift[p.line] || 0)) });
    this.commit(move(sel.anchor), move(sel.head));
  }

  toggleWrap(marker) {
    const sel = this.currentSel();
    if (!sel) return;
    const [from, to] = ordered(sel.anchor, sel.head);
    if (from.line !== to.line) return;
    const line = this.lines[from.line];
    const L = marker.length;
    this.pushUndo('other');
    if (line.slice(from.ch - L, from.ch) === marker && line.slice(to.ch, to.ch + L) === marker) {
      this.lines[from.line] = line.slice(0, from.ch - L) + line.slice(from.ch, to.ch) + line.slice(to.ch + L);
      this.commit({ line: from.line, ch: from.ch - L }, { line: from.line, ch: to.ch - L });
    } else {
      this.lines[from.line] = line.slice(0, from.ch) + marker + line.slice(from.ch, to.ch) + marker + line.slice(to.ch);
      this.commit({ line: from.line, ch: from.ch + L }, { line: from.line, ch: to.ch + L });
    }
  }

  /* Puts a block (a date heading, a page break) on its own line at the caret. */
  insertBlock(text) {
    const sel = this.currentSel() || { anchor: this.endPos(), head: this.endPos() };
    this.content.focus({ preventScroll: true });
    const [, to] = ordered(sel.anchor, sel.head);
    const line = this.lines[to.line];
    if (!line.trim()) {
      this.edit({ line: to.line, ch: 0 }, { line: to.line, ch: line.length }, text + '\n', 'other');
    } else {
      this.edit({ line: to.line, ch: line.length }, { line: to.line, ch: line.length }, '\n' + text + '\n', 'other');
    }
  }

  toggleTask(lineIdx) {
    const k = this.kinds[lineIdx];
    if (!k || k.type !== 'task') return;
    const line = this.lines[lineIdx];
    const i = k.checkAt + 1;
    this.pushUndo('other');
    this.lines[lineIdx] = line.slice(0, i) + (line[i] === ' ' ? 'x' : ' ') + line.slice(i + 1);
    const sel = this.sel;
    this.syncDOM();
    if (sel && this.hasFocus()) this.setSelection(sel.anchor, sel.head);
    this.measure();
    this.changed();
  }

  /* ---------- events ---------- */

  onBeforeInput(e) {
    if (this.composing || e.isComposing || e.inputType === 'insertCompositionText') return;
    if (!e.cancelable) { this.pushUndo('type'); return; } // let it happen, read it back in onInput
    const sel = this.readSelection() || this.sel;
    e.preventDefault();
    if (!sel) return;
    const t = e.inputType;
    let range = null;
    const tr = e.getTargetRanges ? e.getTargetRanges() : [];
    if (tr.length) {
      const a = this.posFromDOM(tr[0].startContainer, tr[0].startOffset);
      const b = this.posFromDOM(tr[0].endContainer, tr[0].endOffset);
      if (a && b) range = [a, b];
    }
    const [from, to] = ordered(sel.anchor, sel.head);
    switch (t) {
      case 'insertText':
      case 'insertReplacementText':
      case 'insertFromDrop':
      case 'insertFromPaste':
      case 'insertFromYank': {
        let text = e.data;
        if (text == null && e.dataTransfer) text = e.dataTransfer.getData('text/plain');
        if (text == null) return;
        text = text.replace(/\r\n?/g, '\n');
        const r = t === 'insertText' ? [from, to] : (range || [from, to]);
        this.edit(r[0], r[1], text, t === 'insertText' && text.length === 1 ? 'type' : 'other');
        return;
      }
      case 'insertParagraph': this.insertNewline(sel, false); return;
      case 'insertLineBreak': this.insertNewline(sel, true); return;
      case 'deleteContentBackward': this.deleteBackward(sel, 'char'); return;
      case 'deleteContentForward': this.deleteForward(sel, 'char'); return;
      case 'deleteWordBackward': this.deleteBackward(sel, 'word'); return;
      case 'deleteWordForward': this.deleteForward(sel, 'word'); return;
      case 'deleteSoftLineBackward':
      case 'deleteHardLineBackward':
        if (range && !samePos(range[0], range[1])) this.edit(range[0], range[1], '', 'other');
        else this.deleteBackward(sel, 'line');
        return;
      case 'deleteSoftLineForward':
      case 'deleteHardLineForward':
        if (range && !samePos(range[0], range[1])) this.edit(range[0], range[1], '', 'other');
        else this.deleteForward(sel, 'line');
        return;
      case 'deleteByCut':
      case 'deleteContent':
      case 'deleteByDrag':
        if (!samePos(from, to)) this.edit(from, to, '', 'other');
        return;
      case 'historyUndo': this.undo(); return;
      case 'historyRedo': this.redo(); return;
      case 'formatBold': this.toggleWrap('**'); return;
      case 'formatItalic': this.toggleWrap('*'); return;
      default: // formatting the browser would do to the HTML — not Markdown
    }
  }

  onInput(e) {
    if (this.composing || (e && e.isComposing)) return;
    this.resyncFromDOM(); // only reached for input we could not intercept
  }

  onCompositionStart() {
    this.pushUndo('type');
    this.composing = true;
  }

  onCompositionEnd() {
    this.composing = false;
    this.resyncFromDOM();
  }

  /* The browser changed the DOM by itself (IME, some mobile keyboards): read the
     text back, then repaint so the DOM is ours again. */
  resyncFromDOM() {
    const s = document.getSelection();
    const { lines, caret } = domToLines(this.content, s && s.focusNode, s && s.focusOffset);
    const kids = this.content.childNodes;
    let intact = kids.length === this.lineEls.length && lines.length === this.lineEls.length;
    for (let i = 0; intact && i < kids.length; i++) if (kids[i] !== this.lineEls[i]) intact = false;
    if (intact) {
      let same = true;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] !== this.rendered[i]) { this.lineEls[i]._mjText = null; same = false; }
      }
      if (same) return;
      this.rendered = lines.slice();
    } else {
      this.content.textContent = '';
      this.lineEls = [];
      this.rendered = [];
      this.activeEls.clear();
    }
    this.lines = lines;
    const c = this.clampPos(caret || (this.sel && this.sel.head) || this.endPos());
    this.commit(c, c);
  }

  onKeyDown(e) {
    if (e.isComposing || e.keyCode === 229) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const k = e.key;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod && !e.altKey) {
      const lower = k.length === 1 ? k.toLowerCase() : k;
      if (lower === 'z') { stop(); if (e.shiftKey) this.redo(); else this.undo(); return; }
      if (lower === 'y' && !isMac) { stop(); this.redo(); return; }
      if (lower === 'b') { stop(); this.toggleWrap('**'); return; }
      if (lower === 'i') { stop(); this.toggleWrap('*'); return; }
    }
    if (k === 'Tab' && !mod && !e.altKey) {
      stop();
      const sel = this.currentSel();
      if (sel) this.indent(sel, e.shiftKey);
      return;
    }
    if (k === 'PageDown' || k === 'PageUp') { stop(); this.flip(k === 'PageDown' ? 1 : -1); }
  }

  onSelectionChange() {
    if (this.composing) return;
    const sel = this.readSelection();
    if (!sel) return;
    const exp = this._expected;
    this._expected = null;
    if (!exp || !samePos(exp.anchor, sel.anchor) || !samePos(exp.head, sel.head)) this.lastUndoKind = null;
    this.sel = sel;
    if (this.updateActive(sel)) this.measure();
    this.revealCaret(true);
    if (this.host.onCaret) this.host.onCaret(sel.head);
  }

  onCopy(e, cut) {
    const sel = this.readSelection();
    if (!sel || samePos(sel.anchor, sel.head) || !e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', this.getRangeText(sel.anchor, sel.head));
    if (cut) this.edit(sel.anchor, sel.head, '', 'other');
  }

  onPaste(e) {
    e.preventDefault();
    const dt = e.clipboardData;
    if (!dt) return;
    const files = Array.from(dt.files || []).filter((f) => /^image\//.test(f.type));
    if (files.length && this.host.saveAttachment) { this.insertFiles(files); return; }
    const text = dt.getData('text/plain');
    const sel = this.currentSel();
    if (!text || !sel) return;
    this.edit(sel.anchor, sel.head, text.replace(/\r\n?/g, '\n'), 'other');
  }

  onDrop(e) {
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => /^image\//.test(f.type));
    if (!files.length || !this.host.saveAttachment) return; // text drops arrive as beforeinput
    e.preventDefault();
    const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
    const pos = r && this.posFromDOM(r.startContainer, r.startOffset);
    if (pos) { this.content.focus({ preventScroll: true }); this.setSelection(pos, pos); }
    this.insertFiles(files);
  }

  async insertFiles(files) {
    const embeds = [];
    for (const f of files) {
      try { const md = await this.host.saveAttachment(f); if (md) embeds.push(md); } catch (err) { console.error('MD Journal: attachment', err); }
    }
    const sel = this.sel;
    if (!embeds.length || !sel) return;
    const [from, to] = ordered(sel.anchor, sel.head);
    let text = embeds.join('\n');
    if (from.ch > 0) text = '\n' + text;
    if (to.ch < this.lines[to.line].length) text += '\n';
    this.edit(from, to, text, 'other');
  }

  onContentMouseDown(e) {
    const t = e.target;
    const chk = t && t.closest && t.closest('.mj-check');
    if (chk && this.content.contains(chk)) {
      e.preventDefault();
      const el = this.lineElOf(chk);
      if (el) this.toggleTask(el._mjIdx);
      return;
    }
    const link = t && t.closest && t.closest('.mj-link');
    if (link && (e.ctrlKey || e.metaKey) && this.host.openLink) {
      e.preventDefault();
      this.host.openLink(link.dataset.href, e.shiftKey || e.altKey);
    }
  }

  /* A click on paper where there is no text (below the last line of a page, or a
     blank page) puts the caret at the end of the writing on that page. */
  onPaperMouseDown(e) {
    e.preventDefault();
    const paper = e.target.closest && e.target.closest('.mj-paper');
    const page = paper ? this.paperEls.indexOf(paper) : -1;
    this.content.focus({ preventScroll: true });
    let pos;
    if (page < 0 || page >= this.totalPages - 1) pos = this.endPos();
    else {
      pos = this.posAtPageStart(page + 1);
      if (pos.ch > 0) pos = { line: pos.line, ch: prevBoundary(this.lines[pos.line], pos.ch) };
      else if (pos.line > 0) pos = { line: pos.line - 1, ch: this.lines[pos.line - 1].length };
    }
    this.setSelection(pos, pos);
    this.revealCaret(true);
  }

  onWheel(e) {
    if (e.ctrlKey) return;
    e.preventDefault();
    const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(d) < 6) return;
    const now = Date.now();
    if (now - (this._lastWheel || 0) < 450) return;
    this._lastWheel = now;
    this.flip(d > 0 ? 1 : -1);
  }

  onTouchStart(e) {
    const t = e.touches[0];
    this._touch = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, time: Date.now() } : null;
  }

  onTouchEnd(e) {
    const s = this._touch;
    this._touch = null;
    if (!s || !e.changedTouches.length) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed) return; // the user was selecting text
    if (Date.now() - s.time < 500 && Math.abs(dx) > 60 && Math.abs(dy) < 45) this.flip(dx < 0 ? 1 : -1);
  }
}

/* ------------------------------------------------------------------------- */
/*  Obsidian view                                                             */
/* ------------------------------------------------------------------------- */

class JournalView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.file = null;
    this.editor = null;
    this.front = '';
    this.eol = '\n';
    this.lastSaved = null;
    this.dirty = false;
    this.saveTimer = null;
    this.posTimer = null;
  }

  getViewType() { return VIEW_TYPE_JOURNAL; }
  getDisplayText() { return this.file ? this.file.basename : 'Journal'; }
  getIcon() { return 'book-open'; }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass('mj-view-content');
    const host = {
      onChange: () => this.scheduleSave(),
      onCaret: () => this.schedulePosition(),
      resolveImage: (link) => this.resolveImage(link),
      openLink: (href, newLeaf) => this.openLink(href, newLeaf),
      saveAttachment: (file) => this.saveAttachment(file),
      highlight: (code, lang) => prismLines(this.plugin.prism, code, lang),
    };
    this.editor = new PagedEditor(this.contentEl, host, this.plugin.settings);
    this.addAction('pencil', 'Edit as Markdown', () => this.plugin.switchLeaf(this.leaf, 'markdown'));
    this.addAction('type', 'Journal appearance', () => new AppearanceModal(this.app, this.plugin).open());
    this.addAction('monitor', 'Switch between journal pages and Obsidian view', () => this.plugin.toggleLayout());
    this.registerEvent(this.app.vault.on('modify', (f) => { if (f === this.file) this.onExternalModify(); }));
    this.registerEvent(this.app.vault.on('delete', (f) => { if (f === this.file) { this.dirty = false; this.leaf.detach(); } }));
    this.registerEvent(this.app.vault.on('rename', (f, oldPath) => {
      if (f !== this.file) return;
      const pos = this.plugin.settings.positions;
      if (pos[oldPath]) { pos[f.path] = pos[oldPath]; delete pos[oldPath]; this.plugin.saveSettings(); }
      if (this.leaf.updateHeader) this.leaf.updateHeader();
    }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => { if (leaf === this.leaf && this.editor) this.editor.focus(); }));
    if (this._pendingFile) { const f = this._pendingFile; this._pendingFile = null; await this.loadFile(f); }
  }

  async onClose() {
    await this.flush();
    this.savePosition();
    if (this.editor) this.editor.destroy();
    this.editor = null;
  }

  getState() {
    const state = super.getState ? super.getState() : {};
    if (this.file) state.file = this.file.path;
    return state;
  }

  async setState(state, result) {
    const f = state && state.file ? this.app.vault.getAbstractFileByPath(state.file) : null;
    if (f instanceof TFile && f !== this.file) await this.loadFile(f);
    if (super.setState) await super.setState(state, result);
  }

  async loadFile(file) {
    if (!this.editor) { this._pendingFile = file; return; } // setState before onOpen
    if (this.file) { await this.flush(); this.savePosition(); }
    this.file = file;
    const text = await this.app.vault.read(file);
    if (!this.editor || this.file !== file) return;
    this.applyText(text, true);
    if (this.leaf.updateHeader) this.leaf.updateHeader();
    if (this.app.workspace.getActiveViewOfType && this.app.workspace.getActiveViewOfType(JournalView) === this) this.editor.focus();
  }

  applyText(text, initial) {
    this.eol = text.includes('\r\n') ? '\r\n' : '\n';
    const { front, body } = splitFrontmatter(text);
    this.front = front;
    this.lastSaved = text;
    let caret = null;
    if (initial) {
      const saved = this.plugin.settings.positions[this.file.path];
      if (this.plugin.settings.openAt === 'last' && saved) caret = saved;
      else caret = { line: Infinity, ch: Infinity };
    }
    this.editor.setText(body, { resetHistory: initial, caret });
    this.editor.setStatus('');
  }

  composeText() {
    let body = this.editor.getText();
    if (this.eol !== '\n') body = body.replace(/\n/g, this.eol);
    let front = this.front;
    if (front && !/\n$/.test(front) && body) front += this.eol;
    return front + body;
  }

  scheduleSave() {
    this.dirty = true;
    this.editor.setStatus('Editing…');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), Math.max(100, this.plugin.settings.saveDelay || 700));
  }

  async flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.dirty || !this.file || !this.editor) return;
    this.dirty = false;
    const data = this.composeText();
    if (data === this.lastSaved) { this.editor.setStatus('Saved'); return; }
    this.lastSaved = data;
    try {
      await this.app.vault.modify(this.file, data);
      if (this.editor && !this.dirty) this.editor.setStatus('Saved');
    } catch (err) {
      this.dirty = true;
      new Notice('MD Journal: could not save ' + this.file.path + ' — ' + (err && err.message));
    }
  }

  async onExternalModify() {
    const text = await this.app.vault.read(this.file);
    if (text === this.lastSaved || !this.editor) return;
    if (this.dirty) {
      // Edited here and elsewhere at once: keep what is being typed here, but
      // take the other side's properties (frontmatter), which this view never edits.
      this.front = splitFrontmatter(text).front;
      return;
    }
    this.applyText(text, false);
  }

  schedulePosition() {
    clearTimeout(this.posTimer);
    this.posTimer = setTimeout(() => this.savePosition(), 2000);
  }

  savePosition() {
    clearTimeout(this.posTimer);
    if (!this.file || !this.editor || !this.editor.sel) return;
    const h = this.editor.sel.head;
    const prev = this.plugin.settings.positions[this.file.path];
    if (prev && prev.line === h.line && prev.ch === h.ch) return;
    this.plugin.settings.positions[this.file.path] = { line: h.line, ch: h.ch };
    this.plugin.saveSettings();
  }

  resolveImage(link) {
    if (/^https?:/i.test(link)) return link;
    let path = link;
    try { path = decodeURIComponent(link); } catch (e) { /* keep as written */ }
    const f = this.app.metadataCache.getFirstLinkpathDest(path, this.file ? this.file.path : '');
    return f ? this.app.vault.getResourcePath(f) : null;
  }

  openLink(href, newLeaf) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) { window.open(href); return; }
    this.app.workspace.openLinkText(href, this.file ? this.file.path : '', newLeaf ? 'tab' : false);
  }

  async saveAttachment(file) {
    const buf = await file.arrayBuffer();
    const ext = ((file.name && file.name.includes('.') ? file.name.split('.').pop() : (file.type.split('/')[1] || 'png')) || 'png').toLowerCase();
    const stamp = window.moment ? window.moment().format('YYYYMMDDHHmmss') : String(Date.now());
    const base = file.name && file.name !== 'image.png' ? file.name.replace(/\.[^.]+$/, '') : 'Pasted image ' + stamp;
    const fm = this.app.fileManager;
    const path = fm.getAvailablePathForAttachment
      ? await fm.getAvailablePathForAttachment(base + '.' + ext, this.file ? this.file.path : '')
      : await this.app.vault.getAvailablePathForAttachments(base, ext, this.file);
    const created = await this.app.vault.createBinary(path, buf);
    const link = fm.generateMarkdownLink ? fm.generateMarkdownLink(created, this.file ? this.file.path : '') : '[[' + created.name + ']]';
    return link.startsWith('!') ? link : '!' + link;
  }
}

/* ------------------------------------------------------------------------- */
/*  Settings                                                                  */
/* ------------------------------------------------------------------------- */

function addAppearanceSettings(el, plugin, redisplay) {
  const s = plugin.settings;
  const apply = async () => { await plugin.saveSettings(); plugin.refreshViews(); };

  new Setting(el).setName('Layout').setDesc('Journal pages are a fixed size on paper. The Obsidian view fills the pane in your theme, like MD Reader — still editable.')
    .addDropdown((d) => d.addOptions(LAYOUTS).setValue(s.layout).onChange(async (v) => { s.layout = v; await apply(); redisplay(); }));
  if (s.layout === 'screen') {
    new Setting(el).setName('Columns').setDesc('Auto shows two columns when the pane is wide enough.')
      .addDropdown((d) => d.addOptions({ auto: 'Auto', single: 'One column', double: 'Two columns' })
        .setValue(s.pageMode).onChange(async (v) => { s.pageMode = v; await apply(); }));
    new Setting(el).setName('Fixed page').setDesc('Every page holds the same amount of text whatever the window size: the page is scaled to fit instead of re-flowing, so page breaks stay put.')
      .addToggle((t) => t.setValue(!!s.fixedPage).onChange(async (v) => { s.fixedPage = v; await apply(); redisplay(); }));
    if (s.fixedPage) {
      new Setting(el).setName('Page size')
        .addDropdown((d) => {
          for (const [k, v] of Object.entries(PAGE_SIZES)) d.addOption(k, v.label);
          d.setValue(s.pageSize).onChange(async (v) => { s.pageSize = v; await apply(); redisplay(); });
        });
      if (s.pageSize === 'custom') {
        new Setting(el).setName('Custom page size').setDesc('Width × height in millimetres.')
          .addText((t) => t.setPlaceholder('148').setValue(String(s.customWidth)).onChange(async (v) => {
            const n = Number(v); if (n >= 50 && n <= 420) { s.customWidth = n; await apply(); }
          }))
          .addText((t) => t.setPlaceholder('210').setValue(String(s.customHeight)).onChange(async (v) => {
            const n = Number(v); if (n >= 50 && n <= 600) { s.customHeight = n; await apply(); }
          }));
      }
      new Setting(el).setName('Margins').setDesc('Millimetres around the text on each page.')
        .addSlider((sl) => sl.setLimits(4, 30, 1).setValue(s.margin).setDynamicTooltip()
          .onChange(async (v) => { s.margin = v; await apply(); }));
    } else {
      new Setting(el).setName('Max column width').setDesc('Pixels. 0 = as wide as the pane allows.')
        .addSlider((sl) => sl.setLimits(0, 1400, 20).setValue(s.screenMaxWidth).setDynamicTooltip()
          .onChange(async (v) => { s.screenMaxWidth = v; await apply(); }));
    }
    new Setting(el).setName('Line spacing')
      .addSlider((sl) => sl.setLimits(1.2, 2.4, 0.05).setValue(s.lineHeight).setDynamicTooltip()
        .onChange(async (v) => { s.lineHeight = v; await apply(); }));
    new Setting(el).setName('Hide Markdown marks').setDesc('Show **, # and links as formatting except on the line you are writing.')
      .addToggle((t) => t.setValue(s.hideSyntax).onChange(async (v) => { s.hideSyntax = v; await apply(); }));
    new Setting(el).setName('New page for each top-level heading')
      .addToggle((t) => t.setValue(s.headingNewPage).onChange(async (v) => { s.headingNewPage = v; await apply(); }));
    return;
  }

  new Setting(el).setName('Page size').setDesc('The page stays this size whatever the window: it is scaled to fit, so the text never re-flows.')
    .addDropdown((d) => {
      for (const [k, v] of Object.entries(PAGE_SIZES)) d.addOption(k, v.label);
      d.setValue(s.pageSize).onChange(async (v) => { s.pageSize = v; await apply(); redisplay(); });
    });
  if (s.pageSize === 'custom') {
    new Setting(el).setName('Custom page size').setDesc('Width × height in millimetres.')
      .addText((t) => t.setPlaceholder('148').setValue(String(s.customWidth)).onChange(async (v) => {
        const n = Number(v); if (n >= 50 && n <= 420) { s.customWidth = n; await apply(); }
      }))
      .addText((t) => t.setPlaceholder('210').setValue(String(s.customHeight)).onChange(async (v) => {
        const n = Number(v); if (n >= 50 && n <= 600) { s.customHeight = n; await apply(); }
      }));
  }
  new Setting(el).setName('Pages').setDesc('Auto shows an open book (two pages) when the window is wide enough.')
    .addDropdown((d) => d.addOptions({ auto: 'Auto', single: 'One page', double: 'Two-page spread' })
      .setValue(s.pageMode).onChange(async (v) => { s.pageMode = v; await apply(); }));
  new Setting(el).setName('Paper')
    .addDropdown((d) => d.addOptions(PAPERS).setValue(s.paper).onChange(async (v) => { s.paper = v; await apply(); }));
  new Setting(el).setName('Paper colour')
    .addDropdown((d) => d.addOptions(TINTS).setValue(s.tint).onChange(async (v) => { s.tint = v; await apply(); }));
  new Setting(el).setName('Font')
    .addDropdown((d) => {
      for (const [k, v] of Object.entries(FONTS)) d.addOption(k, v.label);
      d.setValue(s.fontFamily).onChange(async (v) => { s.fontFamily = v; await apply(); redisplay(); });
    });
  if (s.fontFamily === 'custom') {
    new Setting(el).setName('Custom font').setDesc('Any CSS font-family, e.g. "Caveat", cursive.')
      .addText((t) => t.setValue(s.fontFamilyCustom).onChange(async (v) => { s.fontFamilyCustom = v; await apply(); }));
  }
  new Setting(el).setName('Font size').setDesc('In pixels on an unscaled page.')
    .addSlider((sl) => sl.setLimits(10, 28, 1).setValue(s.fontSize).setDynamicTooltip()
      .onChange(async (v) => { s.fontSize = v; await apply(); }));
  new Setting(el).setName('Line spacing')
    .addSlider((sl) => sl.setLimits(1.2, 2.4, 0.05).setValue(s.lineHeight).setDynamicTooltip()
      .onChange(async (v) => { s.lineHeight = v; await apply(); }));
  new Setting(el).setName('Margins').setDesc('Millimetres around the writing on each page.')
    .addSlider((sl) => sl.setLimits(4, 30, 1).setValue(s.margin).setDynamicTooltip()
      .onChange(async (v) => { s.margin = v; await apply(); }));
  new Setting(el).setName('Hide Markdown marks').setDesc('Show **, # and links as formatting except on the line you are writing.')
    .addToggle((t) => t.setValue(s.hideSyntax).onChange(async (v) => { s.hideSyntax = v; await apply(); }));
  new Setting(el).setName('Page numbers')
    .addToggle((t) => t.setValue(s.pageNumbers).onChange(async (v) => { s.pageNumbers = v; await apply(); }));
  new Setting(el).setName('New page for each top-level heading').setDesc('A "# " heading always starts on a fresh page — one entry per page.')
    .addToggle((t) => t.setValue(s.headingNewPage).onChange(async (v) => { s.headingNewPage = v; await apply(); }));
}

class AppearanceModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onOpen() { this.titleEl.setText('Journal appearance'); this.display(); }
  display() {
    this.contentEl.empty();
    addAppearanceSettings(this.contentEl, this.plugin, () => this.display());
  }
  onClose() { this.contentEl.empty(); }
}

class JournalSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const el = this.containerEl;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    el.empty();
    new Setting(el).setName('Journal').setHeading();
    new Setting(el).setName('Journal note').setDesc('The note the ribbon button and "Open journal" open. Created if it does not exist.')
      .addText((t) => t.setPlaceholder('Journal.md').setValue(s.journalFile).onChange(async (v) => { s.journalFile = v.trim(); await save(); }));
    new Setting(el).setName('Open at').setDesc('Where the caret goes when a note opens as a journal.')
      .addDropdown((d) => d.addOptions({ end: 'The end — ready for a new entry', last: 'Where I left off' })
        .setValue(s.openAt).onChange(async (v) => { s.openAt = v; await save(); }));
    new Setting(el).setName('Open in')
      .addDropdown((d) => d.addOptions({ tab: 'New tab', current: 'Current tab', split: 'Split' })
        .setValue(s.openIn).onChange(async (v) => { s.openIn = v; await save(); }));
    new Setting(el).setName('Date heading format').setDesc('For "Insert date heading" (Moment.js format).')
      .addText((t) => t.setPlaceholder(DEFAULT_SETTINGS.dateFormat).setValue(s.dateFormat).onChange(async (v) => { s.dateFormat = v || DEFAULT_SETTINGS.dateFormat; await save(); }));
    new Setting(el).setName('Spellcheck')
      .addToggle((t) => t.setValue(s.spellcheck).onChange(async (v) => { s.spellcheck = v; await save(); this.plugin.refreshViews(); }));
    new Setting(el).setName('Page-turn animation')
      .addToggle((t) => t.setValue(s.animate).onChange(async (v) => { s.animate = v; await save(); this.plugin.refreshViews(); }));
    new Setting(el).setName('Page').setHeading();
    addAppearanceSettings(el, this.plugin, () => this.display());
  }
}

/* ------------------------------------------------------------------------- */
/*  Plugin                                                                    */
/* ------------------------------------------------------------------------- */

class MdJournalPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE_JOURNAL, (leaf) => new JournalView(leaf, this));
    // Obsidian's own Prism, for code blocks like the reading view's
    if (obsidian.loadPrism) {
      obsidian.loadPrism().then((p) => { this.prism = p; this.refreshViews(true); }).catch(() => {});
    }
    this.addRibbonIcon('book-open', 'Open journal', () => this.openJournal());

    this.addCommand({ id: 'open-journal', name: 'Open journal', callback: () => this.openJournal() });
    this.addCommand({
      id: 'open-current-as-journal',
      name: 'Open current note as journal',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md' || this.activeJournal()) return false;
        if (!checking) this.openFile(file);
        return true;
      },
    });
    this.addCommand({
      id: 'toggle-journal-view',
      name: 'Toggle between journal and editor',
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getMostRecentLeaf ? this.app.workspace.getMostRecentLeaf() : this.app.workspace.activeLeaf;
        const type = leaf && leaf.view && leaf.view.getViewType();
        const file = leaf && leaf.view && leaf.view.file;
        if (!file || (type !== 'markdown' && type !== VIEW_TYPE_JOURNAL)) return false;
        if (!checking) this.switchLeaf(leaf, type === 'markdown' ? VIEW_TYPE_JOURNAL : 'markdown');
        return true;
      },
    });
    this.addCommand({
      id: 'insert-date-heading',
      name: 'Insert date heading',
      checkCallback: (checking) => {
        const v = this.activeJournal();
        if (!v) return false;
        if (!checking) {
          const m = window.moment;
          const date = m ? m().format(this.settings.dateFormat || DEFAULT_SETTINGS.dateFormat) : new Date().toDateString();
          v.editor.insertBlock('## ' + date);
        }
        return true;
      },
    });
    this.addCommand({
      id: 'insert-page-break',
      name: 'Insert page break',
      checkCallback: (checking) => {
        const v = this.activeJournal();
        if (!v) return false;
        if (!checking) v.editor.insertBlock(PAGEBREAK_LINE);
        return true;
      },
    });
    for (const [id, name, d] of [['next-page', 'Next page', 1], ['previous-page', 'Previous page', -1]]) {
      this.addCommand({
        id, name,
        checkCallback: (checking) => {
          const v = this.activeJournal();
          if (!v) return false;
          if (!checking) v.editor.flip(d);
          return true;
        },
      });
    }
    this.addCommand({ id: 'appearance', name: 'Journal appearance', callback: () => new AppearanceModal(this.app, this).open() });
    this.addCommand({ id: 'toggle-layout', name: 'Switch between journal pages and Obsidian view', callback: () => this.toggleLayout() });
    this.addCommand({
      id: 'toggle-fixed-page',
      name: 'Toggle fixed page (Obsidian view)',
      callback: async () => {
        this.settings.fixedPage = !this.settings.fixedPage;
        await this.saveSettings();
        this.refreshViews();
        new Notice(this.settings.fixedPage ? 'MD Journal: fixed page — text per page stays the same when resizing' : 'MD Journal: pages fill the window');
      },
    });

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      menu.addItem((item) => item.setTitle('Open as journal').setIcon('book-open').onClick(() => this.openFile(file)));
    }));
    this.addSettingTab(new JournalSettingTab(this.app, this));
  }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    if (!this.settings.positions || typeof this.settings.positions !== 'object') this.settings.positions = {};
  }

  async saveSettings() { await this.saveData(this.settings); }

  refreshViews(repaint) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_JOURNAL)) {
      const ed = leaf.view && leaf.view.editor;
      if (!ed) continue;
      ed.configure(this.settings);
      if (repaint) ed.repaint();
    }
  }

  async toggleLayout() {
    this.settings.layout = this.settings.layout === 'screen' ? 'journal' : 'screen';
    await this.saveSettings();
    this.refreshViews();
  }

  activeJournal() {
    const view = this.app.workspace.getActiveViewOfType(JournalView);
    return view && view.editor ? view : null;
  }

  async openFile(file) {
    const ws = this.app.workspace;
    const existing = ws.getLeavesOfType(VIEW_TYPE_JOURNAL).find((l) => l.view && l.view.file === file);
    if (existing) { ws.setActiveLeaf(existing, { focus: true }); return; }
    const where = this.settings.openIn;
    const leaf = where === 'current' ? ws.getLeaf(false) : where === 'split' ? ws.getLeaf('split') : ws.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE_JOURNAL, state: { file: file.path }, active: true });
    ws.setActiveLeaf(leaf, { focus: true });
  }

  async switchLeaf(leaf, type) {
    const view = leaf.view;
    const file = view && view.file;
    if (!file) return;
    if (view instanceof JournalView) await view.flush();
    const state = type === 'markdown' ? { file: file.path, mode: 'source' } : { file: file.path };
    await leaf.setViewState({ type, state, active: true });
  }

  async openJournal() {
    let path = (this.settings.journalFile || 'Journal.md').trim().replace(/^\/+/, '');
    if (!/\.md$/i.test(path)) path += '.md';
    if (obsidian.normalizePath) path = obsidian.normalizePath(path);
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (dir && !(this.app.vault.getAbstractFileByPath(dir) instanceof TFolder)) {
        try { await this.app.vault.createFolder(dir); } catch (e) { /* exists */ }
      }
      file = await this.app.vault.create(path, '');
    }
    if (file instanceof TFile) await this.openFile(file);
    else new Notice('MD Journal: ' + path + ' is not a note.');
  }
}

module.exports = MdJournalPlugin;
module.exports.default = MdJournalPlugin;
Object.assign(module.exports, {
  PagedEditor, JournalView, DEFAULT_SETTINGS, PAGE_SIZES, splitFrontmatter, computeKinds, lineKind,
  renderInline, renderLine, continuationPrefix, prevBoundary, nextBoundary, prevWordStart, nextWordEnd,
  domToLines, pageGeometry, screenGeometry, prismLines, countWords,
});
