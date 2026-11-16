// zparse: a fast Markdown renderer whose parse(markdown) returns exactly the
// HTML marked 18.1.3 renders with its default options (gfm on, breaks off),
// written from scratch: a per-block dispatch over a delimiter-stack inline
// engine, with a per-block fallback to the vendored marked build for complex
// blocks. Dependency-free ES module; the only import is the vendored marked,
// used solely as that fallback (vendor/marked/LICENSE, MIT).

import { Lexer, Parser } from './vendor/marked/marked.esm.js';

/** Thrown when a block's inline content is too tricky for the fast engine. */
class Bail extends Error {}

/* ---------------- small character helpers ---------------- */

const PUNCT_RE = /[\p{P}\p{S}]/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;

/** True when ch is a Unicode punctuation or symbol character. */
function isPunct(ch) {
  if (ch === '') return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
  return PUNCT_RE.test(ch);
}

/** True when ch is a Unicode letter or number. */
function isAlnum(ch) {
  if (ch === '') return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  return ALNUM_RE.test(ch);
}

/** True for Markdown whitespace: space, tab, newline, form feed, carriage return. */
function isWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r';
}
// Unicode-aware whitespace (JS \s: includes U+00A0, U+2000-U+200A, U+202F,
// U+205F, U+3000, U+FEFF) — the flanking rules use this, matching marked's
// [\s\p{P}\p{S}] classes and CommonMark's Unicode whitespace (Zs).
const WS_U_RE = /\s/;
function isWsU(ch) {
  return WS_U_RE.test(ch);
}
// True when the char at position p is escaped by an odd run of backslashes
// immediately before it (e.g. \~ is an escaped tilde, \\~ is not).
function isEscapedChar(src, p) {
  let n = 0;
  for (let k = p - 1; k >= 0 && src[k] === '\\'; k--) n++;
  return n % 2 === 1;
}

/** True for an ASCII punctuation character (backslash-escape set). */
function isAsciiPunct(code) {
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}

/* ---------------- escaping and entities ---------------- */

const ENT_RE = /(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);/y;

/** Escape & < > " ' (the & only when it does not start a valid entity). */
function escText(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '&') {
      ENT_RE.lastIndex = i + 1;
      if (ENT_RE.test(s)) { out += '&'; i++; continue; }
      out += '&amp;'; i++; continue;
    }
    if (c === '<') { out += '&lt;'; i++; continue; }
    if (c === '>') { out += '&gt;'; i++; continue; }
    if (c === '"') { out += '&quot;'; i++; continue; }
    if (c === "'") { out += '&#39;'; i++; continue; }
    out += c; i++;
  }
  return out;
}

/** Escape every & < > " '. */
function escAll(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') out += '&amp;';
    else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else out += c;
  }
  return out;
}

const NUM_REF = /&#(?:(\d{1,7})|[Xx]([0-9A-Fa-f]{1,6}));/g;
const NUM_REF_TEST = /&#[0-9Xx]/;
const BARE_AMP = /&(?!(#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)/g;

/** Decode numeric character references; a bare & that starts no entity becomes &amp;. */
function decodeRefs(s) {
  if (!NUM_REF_TEST.test(s)) return s;
  NUM_REF.lastIndex = 0;
  const t = s.replace(NUM_REF, (m, dec, hex) => {
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
  BARE_AMP.lastIndex = 0;
  return t.replace(BARE_AMP, '&amp;');
}

/** encodeURI with %25 put back (marked's href handling); null when it throws. */
function encodeHref(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch { return null; }
}

/** Normalize a link label: trim, collapse whitespace, fold case. */
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** Drop a backslash before any punctuation character. */
function unescapePunct(s) {
  return s.replace(/\\([\p{P}\p{S}])/gu, '$1');
}

/** Expand tabs to the next multiple of 4 columns, tracking the column. */
function expandTabs(s, col) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; }
    else { out += c; col++; }
  }
  return out;
}

/* ---------------- inline piece parsers ---------------- */

/** Match an inline HTML tag at src[i] ('<'). Returns end index + flags, or null. */
function parseTag(src, i) {
  const n = src.length;
  if (src[i] !== '<') return null;
  // Comment: <!-- ... -->  (also <!--> and <!--->)
  if (src.startsWith('<!--', i)) {
    if (src[i + 4] === '>') return { end: i + 5 };
    if (src[i + 4] === '-' && src[i + 5] === '>') return { end: i + 6 };
    const close = src.indexOf('-->', i + 4);
    if (close === -1) return null;
    return { end: close + 3 };
  }
  // Close tag: </name ...>
  let m = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>/.exec(src.slice(i, i + 128));
  if (m) {
    const raw = m[0];
    return { end: i + raw.length, preEnd: /^<\/(pre|code|kbd|script)(\s|>)/i.test(raw), aEnd: /^<\/a>/i.test(raw) };
  }
  // Processing instruction: <? ... ?>
  if (src[i + 1] === '?') {
    const close = src.indexOf('?>', i + 2);
    if (close === -1) return null;
    return { end: close + 2 };
  }
  // CDATA section: <![CDATA[ ... ]]>  (the '[' is not a letter, so this
  // check must come before the <!Letter declaration branch)
  if (src.startsWith('<![CDATA[', i)) {
    const close = src.indexOf(']]>', i + 9);
    if (close === -1) return null;
    return { end: close + 3 };
  }
  // Declaration: <!Name ...>
  if (src[i + 1] === '!' && i + 2 < n && /[a-zA-Z]/.test(src[i + 2])) {
    let j = i + 2;
    while (j < n && /[a-zA-Z]/.test(src[j])) j++;
    if (j < n && isWs(src[j])) {
      const close = src.indexOf('>', j);
      if (close === -1) return null;
      return { end: close + 1 };
    }
    return null;
  }
  // Open tag: <name (attr="..."|'...'|bare)* /?>
  if (i + 1 < n && /[a-zA-Z]/.test(src[i + 1])) {
    let j = i + 1;
    while (j < n && /[a-zA-Z0-9-]/.test(src[j])) j++;
    for (;;) {
      let k = j;
      while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n' || src[k] === '\r' || src[k] === '\f')) k++;
      if (k < n && src[k] === '>') {
        const raw = src.slice(i, k + 1);
        return { end: k + 1, preStart: /^<(pre|code|kbd|script)(\s|>)/i.test(raw), aStart: /^<a /i.test(raw) };
      }
      if (k < n && src[k] === '/' && src[k + 1] === '>') {
        const raw = src.slice(i, k + 2);
        return { end: k + 2, preStart: /^<(pre|code|kbd|script)(\s|>)/i.test(raw), aStart: /^<a /i.test(raw) };
      }
      if (k === j) return null; // no whitespace before an attribute: not a tag
      j = k;
      if (j >= n || !/[a-zA-Z:_]/.test(src[j])) return null;
      while (j < n && /[\w.:-]/.test(src[j])) j++;
      let v = j;
      while (v < n && (src[v] === ' ' || src[v] === '\t')) v++;
      if (v < n && src[v] === '=') {
        v++;
        while (v < n && (src[v] === ' ' || src[v] === '\t')) v++;
        if (v >= n) return null;
        if (src[v] === '"') { const c = src.indexOf('"', v + 1); if (c === -1) return null; j = c + 1; }
        else if (src[v] === "'") { const c = src.indexOf("'", v + 1); if (c === -1) return null; j = c + 1; }
        else {
          while (v < n && !/[\s"'=<>`]/.test(src[v])) v++;
          if (v === j) return null;
          j = v;
        }
      }
    }
  }
  return null;
}

/** Match an autolink <scheme:...> or <email> at src[i]. */
function parseAutolink(src, i) {
  if (src[i] !== '<') return null;
  const rest = src.slice(i + 1);
  const gt = rest.indexOf('>');
  if (gt === -1 || gt === 0) return null;
  const inner = rest.slice(0, gt);
  if (/[\s\x00-\x1f<>]/.test(inner)) return null;
  const sm = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.exec(inner);
  if (sm) return { end: i + 1 + gt + 1, text: inner, href: inner };
  const em = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.exec(inner);
  if (em && !/[-_]$/.test(inner)) return { end: i + 1 + gt + 1, text: inner, href: 'mailto:' + inner };
  return null;
}

/** Match a code span starting at the backtick run at src[i]. */
function parseCodeSpan(src, i) {
  let n = 0;
  while (src[i + n] === '`') n++;
  if (n === 0) return null;
  const N = src.length;
  let j = i + n;
  for (;;) {
    const k = src.indexOf('`', j);
    if (k === -1) return null;
    let r = 0;
    while (src[k + r] === '`') r++;
    if (r === n) {
      const content = src.slice(i + n, k);
      if (content.length === 0) return null;
      let text = content.indexOf('\n') === -1 ? content : content.replace(/\n/g, ' ');
      if (/[^ ]/.test(text) && text[0] === ' ' && text[text.length - 1] === ' ') text = text.slice(1, -1);
      return { end: k + n, text };
    }
    j = k + r;
  }
}

const BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
/** Trim trailing punctuation off an extended autolink, keeping balanced parens. */
function backpedal(s) {
  let cur = s;
  for (;;) {
    const m = BACKPEDAL.exec(cur);
    const next = m ? m[0] : '';
    if (next === cur) return cur;
    cur = next;
  }
}

/** Match a GFM extended autolink (www./scheme:// / email / mailto:) at src[i]. */
function matchFullEmail(src, i) {
  // the maximal bare-email match WITHOUT the (?![\w-]) lookahead (used to
  // detect when the lookahead backtracked the address)
  const m = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+/.exec(src.slice(i));
  if (!m) return null;
  return { end: i + m[0].length, text: m[0] };
}
function hasOpenDelim(items, ch) {
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k];
    if (it.k === 1 && it.ch === ch && it.open && it.n > 0) return true;
  }
  return false;
}
function parseExtUrl(src, i) {
  const rest = src.slice(i);
  let m = /^(?:mailto:[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![\w-])|xmpp:[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![\w-])(?:\/[a-zA-Z0-9@.]+)?)/.exec(rest);
  if (m) {
    const text = backpedal(m[0]);
    if (!text) return null;
    return { end: i + text.length, text, href: text };
  }
  m = /^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/.exec(rest);
  if (m) {
    let text = backpedal(m[0]);
    if (!text) return null;
    const href = m[1] === 'www.' ? 'http://' + text : text;
    return { end: i + text.length, text, href };
  }
  m = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/.exec(rest);
  if (m) return { end: i + m[0].length, text: m[0], href: 'mailto:' + m[0] };
  return null;
}

/**
 * Parse a link label starting at src[i] ('['). Returns the end index just
 * past the closing ']' and the label text, or null. Nested [...] groups one
 * level deep are kept; a backslash escapes the next character; code spans
 * are skipped whole.
 */
function parseLabel(src, i) {
  const N = src.length;
  let j = i + 1;
  while (j < N) {
    const c = src[j];
    if (c === '\\' && j + 1 < N) { j += 2; continue; }
    if (c === '`') {
      // A code span inside a label is matched loosely by marked's label
      // regex: a maximal backtick run, non-backtick content, then a maximal
      // backtick run of ANY length (unlike the real code span, which needs
      // equal runs). The backticks stay literal when the real code span
      // later fails, but the label still parses.
      let r1 = 0;
      while (src[j + r1] === '`') r1++;
      // Trailing run first: a run of 2+ backticks immediately before ] is
      // label content (marked's ``+(?=\]) alternative), not a code-span
      // start. This must be checked BEFORE the code-span scan, or the
      // scan swallows the ] and everything up to a far-away backtick
      // (e.g. in a later link), producing a giant bogus label.
      if (r1 >= 2 && src[j + r1] === ']') { j += r1; continue; }
      let k = j + r1;
      while (k < N && src[k] !== '`') k++;
      if (k > j + r1 && k < N) {
        let r2 = 0;
        while (src[k + r2] === '`') r2++;
        if (src[k + r2] !== '`') { j = k + r2; continue; }
      }
      return null;
    }
    if (c === '[') {
      // one nested group; the group itself may hold one inner [...] group
      const g = scanBracketGroup(src, j);
      if (g === -1) return null;
      j = g;
      continue;
    }
    if (c === ']') return { end: j + 1, label: src.slice(i + 1, j) };
    if (c === '\n') {
      // newline inside a label is allowed only when the next line is not blank
      let k = j + 1;
      while (k < N && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k >= N || src[k] === '\n') return null;
      j++;
      continue;
    }
    j++;
  }
  return null;
}

/** Scan a quoted/paren title starting at src[i] ('"', "'", '('). */
function parseTitle(src, i) {
  const N = src.length;
  const q = src[i];
  if (q === '"') {
    let j = i + 1;
    while (j < N) {
      if (src[j] === '\\' && j + 1 < N) { j += 2; continue; }
      if (src[j] === '"') return { end: j + 1, title: src.slice(i + 1, j) };
      j++;
    }
    return null;
  }
  if (q === "'") {
    let j = i + 1;
    while (j < N) {
      if (src[j] === '\\' && j + 1 < N) { j += 2; continue; }
      if (src[j] === "'") return { end: j + 1, title: src.slice(i + 1, j) };
      if (src[j] === '\n' && src[j + 1] === '\n') return null;
      j++;
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1;
    while (j < N) {
      if (src[j] === '\\' && j + 1 < N) { j += 2; continue; }
      if (src[j] === ')') return { end: j + 1, title: src.slice(i + 1, j) };
      if (src[j] === '(') return null;
      j++;
    }
    return null;
  }
  return null;
}

/** Balanced-paren scan of s: -1 balanced, -2 too many opens, else bad close index. */
function parenBalance(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

/**
 * Parse an inline link/image starting at src[i] ('[' or '![').
 * Returns {end, href, title, text, isImage} or null.
 */
function scanBracketGroup(src, j) {
  // src[j] === '['; returns the index just past the matching ']' or -1.
  // The group may hold one inner [...] group (escapes / non-bracket chars
  // only, no deeper nesting). A newline is allowed only when the next line
  // is not blank (same rule as a label).
  const N = src.length;
  let k = j + 1;
  while (k < N) {
    const c = src[k];
    if (c === '\\' && k + 1 < N) { k += 2; continue; }
    if (c === ']') return k + 1;
    if (c === '[') {
      let m = k + 1;
      let ok = false;
      while (m < N) {
        if (src[m] === '\\' && m + 1 < N) { m += 2; continue; }
        if (src[m] === ']') { ok = true; break; }
        if (src[m] === '[') break;
        if (src[m] === '\n') {
          let t = m + 1;
          while (t < N && (src[t] === ' ' || src[t] === '\t')) t++;
          if (t >= N || src[t] === '\n') break;
        }
        m++;
      }
      if (!ok) return -1;
      k = m + 1;
      continue;
    }
    if (c === '\n') {
      let t = k + 1;
      while (t < N && (src[t] === ' ' || src[t] === '\t')) t++;
      if (t >= N || src[t] === '\n') return -1;
    }
    k++;
  }
  return -1;
}
function parseInlineLink(src, i) {
  const N = src.length;
  let p = i;
  let isImage = false;
  if (src[p] === '!') { isImage = true; p++; }
  if (src[p] !== '[') return null;
  const lab = parseLabel(src, p);
  if (!lab) return null;
  let q = lab.end;
  if (src[q] !== '(') return null;
  q++;
  while (q < N && (src[q] === ' ' || src[q] === '\t' || src[q] === '\n')) q++;
  // destination
  let href = '';
  let hrefEnd = q;
  if (src[q] === '<') {
    let j = q + 1;
    let ok = false;
    while (j < N) {
      if (src[j] === '\\' && j + 1 < N) { j += 2; continue; }
      if (src[j] === '\n' || src[j] === '<') break;
      if (src[j] === '>') { ok = true; break; }
      j++;
    }
    if (!ok) return null;
    href = src.slice(q + 1, j);
    // the closing > must not be escaped: odd backslashes before it
    let bs = 0;
    for (let k = j - 1; k > q && src[k] === '\\'; k--) bs++;
    if (bs % 2 === 1) return null;
    hrefEnd = j + 1;
  } else if (src[q] === ')') {
    href = '';
    hrefEnd = q;
  } else {
    // bare destination: any char except space, tab, newline or control
    // (NOT \s — a non-breaking space is a valid destination char)
    let j = q;
    while (j < N) {
      const cc = src.charCodeAt(j);
      if (cc === 32 || cc === 9 || cc === 10 || cc < 32) break;
      j++;
    }
    href = src.slice(q, j);
    hrefEnd = j;
    const bal = parenBalance(href);
    if (bal === -2) return null;
    if (bal > -1) {
      // truncate the destination at the unmatched close paren
      href = href.slice(0, bal);
      hrefEnd = q + bal;
    }
  }
  // optional title
  let title = null;
  let end = hrefEnd;
  {
    let r = hrefEnd;
    let tstart = -1;
    if (src[r] === ' ' || src[r] === '\t' || src[r] === '\n') {
      let s = r;
      while (s < N && (src[s] === ' ' || src[s] === '\t')) s++;
      if (src[s] === '\n') {
        let t = s + 1;
        while (t < N && (src[t] === ' ' || src[t] === '\t')) t++;
        if (t < N && (src[t] === '"' || src[t] === "'" || src[t] === '(')) tstart = t;
      } else if (src[s] === '"' || src[s] === "'" || src[s] === '(') {
        tstart = s;
      }
    }
    if (tstart !== -1) {
      const tp = parseTitle(src, tstart);
      if (tp) {
        title = tp.title;
        let w = tp.end;
        while (w < N && (src[w] === ' ' || src[w] === '\t' || src[w] === '\n')) w++;
        if (src[w] === ')') end = w + 1;
        else return null;
      } else {
        return null;
      }
    } else {
      let w = r;
      while (w < N && (src[w] === ' ' || src[w] === '\t' || src[w] === '\n')) w++;
      if (src[w] === ')') end = w + 1;
      else return null;
    }
  }
  // the closing paren must not be escaped
  {
    let bs = 0;
    for (let k = end - 2; k >= i && src[k] === '\\'; k--) bs++;
    if (bs % 2 === 1) return null;
  }
  return { end, href, title, text: lab.label, isImage };
}

/** The Be check: the label must not hold a tag/autolink reaching past its end. */
function labelHoldsOpenTag(src, labelStart, labelEnd, labelText) {
  for (let s = 0; s < labelText.length; s++) {
    const c = labelText[s];
    if (c === '\\') { s++; continue; }
    if (c === '`') {
      const cs = parseCodeSpan(labelText, s);
      if (cs) { s = cs.end - 1; continue; }
    }
    if (c !== '<') continue;
    const abs = labelStart + s;
    const tag = parseTag(src, abs) || parseAutolink(src, abs);
    if (tag && tag.end > labelEnd) return true;
  }
  return false;
}

/**
 * Parse a reference link/image starting at src[i]. Needs the refs map.
 * Returns {end, href, title, text, isImage} or null; when the label parses
 * but the reference is undefined, returns {undefinedRef:true, end:i+1}.
 */
function parseRefLink(src, i, refs) {
  const N = src.length;
  let p = i;
  let isImage = false;
  if (src[p] === '!') { isImage = true; p++; }
  if (src[p] !== '[') return null;
  const lab = parseLabel(src, p);
  if (!lab) return null;
  let refText = lab.label;
  let q = lab.end;
  if (src[q] === '[') {
    // full reference [label][ref], or collapsed [label][] (empty ref)
    let j = q + 1;
    const start = j;
    let ok = false;
    while (j < N) {
      if (src[j] === '\\' && j + 1 < N) { j += 2; continue; }
      if (src[j] === ']') { ok = true; break; }
      if (src[j] === '[') break;
      if (src[j] === '\n') {
        let k = j + 1;
        while (k < N && (src[k] === ' ' || src[k] === '\t')) k++;
        if (k >= N || src[k] === '\n') break;
        j++;
        continue;
      }
      j++;
    }
    if (ok) {
      if (j !== start) refText = src.slice(start, j);
      q = j + 1;
    }
    // when the [ref] part does not close, fall through to the shortcut ref
  }
  const ref = refs.get(normLabel(refText));
  if (!ref) return { undefinedRef: true, end: i + (isImage ? 1 : 1) };
  return { end: q, href: ref.href, title: ref.title, text: lab.label, isImage };
}

/* ---------------- the inline engine ---------------- */

// Node kinds: 0 text span {s,e}, 1 delimiter run, 2 atom html, 3 em/strong/del
function flanking(src, s, e) {
  const before = s > 0 ? src[s - 1] : '';
  const after = e < src.length ? src[e] : '';
  const beforeWs = before === '' || isWsU(before);
  const afterWs = after === '' || isWsU(after);
  const beforePunct = before !== '' && isPunct(before);
  const afterPunct = after !== '' && isPunct(after);
  const left = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const right = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return { left, right, before, after, beforeWs, afterWs, beforePunct, afterPunct };
}

/** Render inline markdown to HTML. Returns {html, hasLink}.
 * st is the document-level lexer state ({inLink, inRaw}) shared across
 * blocks: marked's lexer keeps inLink/inRawBlock for the whole document,
 * so an unclosed <a ...> (or <pre>/<code>/...) tag in one paragraph
 * disables bare-URL autolinks (or entity decoding) in later paragraphs.
 * Top-level calls pass st (read + write back); nested calls (link text,
 * alt text) pass nothing and use only the inLink argument. */
function renderInline(src, refs, inLink, st) {
  const N = src.length;
  const items = [];
  let textStart = -1;
  let i = 0;
  let inRaw = st ? st.inRaw : false;
  let curInLink = st ? st.inLink : !!inLink;
  let hasLink = false;

  // Fast path: plain text with no inline-significant characters and no
  // hard break (2+ spaces before a newline) is a single text span —
  // skip item building, emphasis resolution and emission entirely.
  // `!` alone needs no handling (only `![` matters, and `[` is covered);
  // `&` is still handled by decodeRefs/escText below. Bare URLs, www.
  // links and emails are GFM autolinks, so they opt out via `://`,
  // `www.` and `@`.
  if (!/[\\<[`*_~@]/.test(src) && !/  +\n/.test(src) && !src.includes('://') && !src.includes('www.')) {
    if (inRaw) return { html: src, text: src, hasLink: false };
    const decoded = decodeRefs(src);
    return { html: escText(decoded), text: decoded, hasLink: false };
  }

  function flushText(upto) {
    if (textStart !== -1 && upto > textStart) items.push({ k: 0, s: textStart, e: upto, r: inRaw });
    textStart = -1;
  }
  function pushAtom(html, text) { items.push({ k: 2, h: html, t: text }); }

  while (i < N) {
    const c = src[i];
    // --- backslash: escape or hard break
    if (c === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') {
        // hard break, unless only whitespace remains
        let k = i + 2;
        while (k < N && isWs(src[k])) k++;
        if (k < N) {
          flushText(i);
          pushAtom('<br>', '');
          i += 2;
          while (i < N && (src[i] === ' ' || src[i] === '\t')) i++;
          continue;
        }
      } else if (nx !== undefined && nx !== '' && isAsciiPunct(nx.charCodeAt(0))) {
        flushText(i);
        pushAtom(escText(nx), nx);
        i += 2;
        continue;
      }
      if (textStart === -1) textStart = i;
      i++;
      continue;
    }
    // --- < : tag or autolink
    if (c === '<') {
      const tag = parseTag(src, i);
      if (tag) {
        flushText(i);
        const raw = src.slice(i, tag.end);
        pushAtom(raw, raw);
        if (tag.preStart) inRaw = true;
        if (tag.preEnd) inRaw = false;
        if (tag.aStart) curInLink = true;
        if (tag.aEnd) curInLink = false;
        i = tag.end;
        continue;
      }
      const al = parseAutolink(src, i);
      if (al) {
        flushText(i);
        const href = encodeHref(al.href);
        if (href !== null) {
          // an autolink does NOT count as a link for the link-in-link rule
          // (marked's linkEmitted is set only by [x](y) / [x][r] links)
          pushAtom('<a href="' + escText(href) + '">' + escAll(al.text) + '</a>', al.text);
        } else {
          pushAtom(escAll(al.text), al.text);
        }
        i = al.end;
        continue;
      }
      if (textStart === -1) textStart = i;
      i++;
      continue;
    }
    // --- [ or ![ : link / reference link
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const link = parseInlineLink(src, i);
      if (link && !labelHoldsOpenTag(src, i + (link.isImage ? 2 : 1), i + (link.isImage ? 2 : 1) + link.text.length, link.text)) {
        const inner = renderInline(link.text, refs, true);
        if (link.isImage || !inner.hasLink) {
          flushText(i);
          const href = encodeHref(unescapePunct(link.href));
          if (link.isImage) {
            const alt = inner.text;
            if (href === null) { pushAtom(escText(alt), alt); }
            else {
              let h = '<img src="' + escText(href) + '" alt="' + escText(alt) + '"';
              if (link.title != null) h += ' title="' + escText(unescapePunct(link.title)) + '"';
              pushAtom(h + '>', alt);
            }
          } else {
            if (href === null) { pushAtom(inner.html, inner.text); }
            else {
              let h = '<a href="' + escText(href) + '"';
              if (link.title != null) h += ' title="' + escText(unescapePunct(link.title)) + '"';
              pushAtom(h + '>' + inner.html + '</a>', inner.text);
              hasLink = true;
            }
          }
          i = link.end;
          continue;
        }
      }
      const ref = parseRefLink(src, i, refs);
      if (ref && !ref.undefinedRef) {
        const labStart = i + (ref.isImage ? 2 : 1);
        if (!labelHoldsOpenTag(src, labStart, labStart + ref.text.length, ref.text)) {
          const inner = renderInline(ref.text, refs, true);
          if (ref.isImage || !inner.hasLink) {
            flushText(i);
            const href = encodeHref(unescapePunct(ref.href));
            if (ref.isImage) {
              const alt = inner.text;
              if (href === null) { pushAtom(escText(alt), alt); }
              else {
                let h = '<img src="' + escText(href) + '" alt="' + escText(alt) + '"';
                if (ref.title != null) h += ' title="' + escText(unescapePunct(ref.title)) + '"';
                pushAtom(h + '>', alt);
              }
            } else {
              if (href === null) { pushAtom(inner.html, inner.text); }
              else {
                let h = '<a href="' + escText(href) + '"';
                if (ref.title != null) h += ' title="' + escText(unescapePunct(ref.title)) + '"';
                pushAtom(h + '>' + inner.html + '</a>', inner.text);
                hasLink = true;
              }
            }
            i = ref.end;
            continue;
          }
        }
      }
      if (ref && ref.undefinedRef) {
        // only the opening [ (or !) is literal text; rescan from there
        if (textStart === -1) textStart = i;
        i = ref.end;
        continue;
      }
      if (textStart === -1) textStart = i;
      i++;
      continue;
    }
    // --- ` : code span
    if (c === '`') {
      const cs = parseCodeSpan(src, i);
      if (cs) {
        flushText(i);
        pushAtom('<code>' + escAll(cs.text) + '</code>', cs.text);
        i = cs.end;
        continue;
      }
      // the whole run is literal text (marked's text token takes a backtick
      // run as a unit, so a code span never starts inside a failed run)
      if (textStart === -1) textStart = i;
      let n = 0;
      while (src[i + n] === '`') n++;
      i += n;
      continue;
    }
    // --- * _ ~ : delimiter runs
    if (c === '*' || c === '_' || c === '~') {
      let n = 0;
      while (src[i + n] === c) n++;
      if (c === '~' && n >= 3) {
        // a run of 3+ tildes: all but the last two are literal text
        if (textStart === -1) textStart = i;
        i += n - 2;
        n = 2;
        // fall through to record the remaining run of two
      }
      flushText(i);
      const f = flanking(src, i, i + n);
      let open = false, close = false;
      if (c === '~') {
        open = f.after !== '' && !isWsU(f.after) && f.after !== '~';
        // a closer must be immediately preceded by a non-space, non-~ char
        // (the del content must end with a non-space char); a ~ that is
        // itself escaped (\~) is literal content, not a delimiter, so it
        // does not block the close
        close = f.before !== '' && (f.before !== '~' || isEscapedChar(src, i - 1)) && !isWsU(f.before);
        if (n >= 3) close = false; // the run came from a longer run: its left neighbour is ~
      } else if (c === '*') {
        open = f.left;
        close = f.right;
      } else {
        open = f.left && (!f.right || f.beforePunct);
        close = f.right && (!f.left || f.afterPunct);
      }
      items.push({ k: 1, ch: c, n, open, close, s: i, e: i + n });
      i += n;
      continue;
    }
    // --- newline: hard break on 2+ trailing spaces, else soft break
    if (c === '\n') {
      let spaces = 0;
      if (textStart !== -1) {
        let k = i - 1;
        while (k >= textStart && src[k] === ' ') { spaces++; k--; }
      }
      let rest = i + 1;
      while (rest < N && isWs(src[rest])) rest++;
      if (spaces >= 2 && rest < N) {
        flushText(i - spaces);
        pushAtom('<br>', '');
        i++;
        while (i < N && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      if (textStart === -1) textStart = i;
      i++;
      continue;
    }
    // --- extended autolink (not inside a link)
    if (!curInLink) {
      let tried = false;
      if (c === 'w' && src.startsWith('www.', i)) {
        const prev = i === 0 ? '' : src[i - 1];
        if (prev === '' || isWs(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(') tried = true;
      } else if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
        const rest = src.slice(i, i + 8).toLowerCase();
        if (rest.startsWith('https://') || rest.startsWith('http://') || rest.startsWith('ftp://')) tried = true;
        else if (rest.startsWith('mailto:') || rest.startsWith('xmpp:')) {
          const prev = i === 0 ? '' : src[i - 1];
          if (prev === '' || !isAlnum(prev)) tried = true;
        }
      }
      if (!tried && (isAlnum(c) || c === '.' || c === '!' || c === '#' || c === '$' || c === '%' || c === '&' || c === "'" || c === '*' || c === '+' || c === '/' || c === '=' || c === '?' || c === '^' || c === '_' || c === '`' || c === '{' || c === '|' || c === '}' || c === '~' || c === '-')) {
        const prev = i === 0 ? '' : src[i - 1];
        if (prev === '' || !(isAlnum(prev) || prev === '.' || prev === '!' || prev === '#' || prev === '$' || prev === '%' || prev === '&' || prev === "'" || prev === '*' || prev === '+' || prev === '/' || prev === '=' || prev === '?' || prev === '^' || prev === '_' || prev === '`' || prev === '{' || prev === '|' || prev === '}' || prev === '~' || prev === '-')) {
          const at = src.indexOf('@', i);
          if (at !== -1 && at - i <= 256) {
            let ok = true;
            for (let k = i; k < at; k++) {
              const ch = src[k];
              if (!(isAlnum(ch) || ch === '.' || ch === '!' || ch === '#' || ch === '$' || ch === '%' || ch === '&' || ch === "'" || ch === '*' || ch === '+' || ch === '/' || ch === '=' || ch === '?' || ch === '^' || ch === '_' || ch === '`' || ch === '{' || ch === '|' || ch === '}' || ch === '~' || ch === '-')) { ok = false; break; }
            }
            if (ok) tried = true;
          }
        }
      }
      if (tried) {
        let u = parseExtUrl(src, i);
        if (!u || (u.text.includes('@') && u.text.indexOf('://') === -1)) {
          // an email match may have been backtracked (or rejected) by the
          // (?![\w-]) lookahead because a * / _ run follows it; if that run
          // closes an opener seen earlier, the address sits inside an
          // emphasis span and the full address is the match (marked parses
          // the address in the emphasis inner text, where the closer is
          // absent), so use the maximal match instead
          const full = matchFullEmail(src, i);
          if (full && (!u || full.end > u.end)) {
            const ch = src[full.end];
            if ((ch === '*' || ch === '_') && hasOpenDelim(items, ch)) {
              u = { end: full.end, text: full.text, href: 'mailto:' + full.text };
            }
          }
        }
        if (u) {
          flushText(i);
          const href = encodeHref(u.href);
          if (href !== null) {
            // a bare URL / email autolink does NOT count as a link for the
            // link-in-link rule (marked's linkEmitted is set only by
            // [x](y) / [x][r] links)
            pushAtom('<a href="' + escText(href) + '">' + escAll(u.text) + '</a>', u.text);
          } else {
            pushAtom(escAll(u.text), u.text);
          }
          i = u.end;
          continue;
        }
      }
    }
    // --- ordinary text character
    if (textStart === -1) textStart = i;
    i++;
  }
  flushText(N);

  resolveEmphasis(items, src);
  if (st) { st.inLink = curInLink; st.inRaw = inRaw; }
  return { html: emitItems(items, src, 'html'), text: emitItems(items, src, 'text'), hasLink };
}

/** Resolve delimiter runs into em/strong/del nodes (CommonMark stack walk). */
// True when the closer run at [cS, cE) is skipped by marked's RDelim
// first alternative: a * run lying between a __ before it and a __
// after it (with no other * or _ in between) is skipped, because the __
// strong claims that span; symmetrically a _ run between ** ... ** is
// skipped. oEnd is the end of the opener's run (the scan start). The
// double run before the closer must be the FIRST one reachable from the
// scan start (the regex's [^_*]*? cannot cross a delimiter), not merely
// the nearest one before the closer.
function isSkippedCloser(src, oEnd, cS, cE, ch) {
  const d = ch === '*' ? '_' : '*'; // the double-run char (opposite of the closer)
  const dbl = d + d;
  const dp = src.indexOf(dbl, oEnd);
  if (dp === -1 || dp + 2 > cS) return false;
  // the text from the scan start to the double run, and from the double
  // run to the closer, must contain no * or _
  for (let q = oEnd; q < dp; q++) if (src[q] === '*' || src[q] === '_') return false;
  for (let q = dp + 2; q < cS; q++) if (src[q] === '*' || src[q] === '_') return false;
  // a double run after the closer, with no * or _ between the closer and it
  for (let p = cE; p + 1 < src.length; p++) {
    const c = src[p];
    if (c === '*' || c === '_') {
      if (c === d && src[p + 1] === d) return true;
      return false;
    }
  }
  return false;
}

// Masked source for emphasis/del scanning, replicating the two masking
// passes marked applies to an inline source before emStrong/del run:
// (1) neutralise inner backticks of equal-run code spans and escaped
// punctuation; (2) replace [label](dest) links, code spans and HTML tags
// with [aaa...] of the same length. A delimiter run whose characters were
// replaced is invisible to emphasis. This matters when a code span has
// unequal runs (e.g. ``url` in a link label): pass 1 then matches one
// long equal-run code span that swallows the text up to a later `` run —
// including _..._ delimiters — and pass 2 hides the whole span, so no
// emphasis forms there even though the delimiters look live in the raw
// source (doc-09, doc-16, doc-20, doc-23, doc-28).
function computeMasked(src) {
  const N = src.length;
  const a = src.split('');
  // ---- pass 1: equal-run code spans — inner backticks -> '+'
  let i = 0;
  while (i < N) {
    if (a[i] === '`') {
      let n = 0;
      while (i + n < N && a[i + n] === '`') n++;
      let j = i + n, close = -1;
      while (j < N) {
        if (a[j] === '`') {
          let r = 0;
          while (j + r < N && a[j + r] === '`') r++;
          if (r === n) { close = j; break; }
          j += r;
        } else j++;
      }
      if (close !== -1 && close > i + n) {
        for (let k = i + n; k < close; k++) if (a[k] === '`') a[k] = '+';
        i = close + n;
        continue;
      }
      i += n;
      continue;
    }
    if (a[i] === '\\' && i + 1 < N && isPunct(a[i + 1])) { a[i] = '+'; a[i + 1] = '+'; i += 2; continue; }
    i++;
  }
  const s = a.join('');
  const out = s.split('');
  const maskRange = (from, to) => {
    for (let k = from; k < to; k++) out[k] = 'a';
    out[from] = '[';
    out[to - 1] = ']';
  };
  // ---- pass 2 helpers (operate on the pass-1 result s)
  const codeSpanEnd = (p) => {
    // s[p] === '`': end (exclusive) of an equal-run code span whose
    // content holds no backtick, or -1. The run must start at p
    // (blockSkip's (?<!`) lookbehind: never match mid-run).
    if (p > 0 && s[p - 1] === '`') return -1;
    let n = 0;
    while (p + n < N && s[p + n] === '`') n++;
    let j = p + n;
    while (j < N) {
      if (s[j] === '`') {
        let r = 0;
        while (j + r < N && s[j + r] === '`') r++;
        if (r === n) return j + r;
        return -1;
      }
      j++;
    }
    return -1;
  };
  const linkEnd = (p) => {
    // s[p] === '[': end (exclusive) of a [label](dest) construct, or -1.
    // Label: no nested '[', code spans with equal runs only.
    let j = p + 1;
    while (j < N) {
      const c = s[j];
      if (c === '\\' && j + 1 < N) { j += 2; continue; }
      if (c === '`') {
        const e = codeSpanEnd(j);
        if (e === -1) return -1;
        j = e;
        continue;
      }
      if (c === '[') return -1;
      if (c === ']') break;
      j++;
    }
    if (j >= N || s[j] !== ']') return -1;
    let q = j + 1;
    if (s[q] !== '(') return -1;
    q++;
    while (q < N && (s[q] === ' ' || s[q] === '\t' || s[q] === '\n')) q++;
    if (q >= N) return -1;
    if (s[q] === '<') {
      const gt = s.indexOf('>', q + 1);
      if (gt === -1) return -1;
      const inner = s.slice(q + 1, gt);
      if (inner.includes('\n') || inner.includes('<')) return -1;
      q = gt + 1;
    } else {
      let depth = 0, k = q;
      while (k < N) {
        const ch = s[k];
        if (ch === '\\' && k + 1 < N) { k += 2; continue; }
        if (ch === ' ' || ch === '\t' || ch === '\n') break;
        if (ch === '(') depth++;
        else if (ch === ')') { if (depth === 0) break; depth--; }
        k++;
      }
      q = k;
    }
    let r = q;
    while (r < N && (s[r] === ' ' || s[r] === '\t')) r++;
    if (r < N && s[r] === '\n') {
      let t = r + 1;
      while (t < N && (s[t] === ' ' || s[t] === '\t')) t++;
      if (t < N && s[t] !== '\n') r = t;
    }
    if (r !== q && r < N && (s[r] === '"' || s[r] === "'" || s[r] === '(')) {
      const tt = parseTitle(s, r);
      if (tt) r = tt.end;
    }
    while (r < N && (s[r] === ' ' || s[r] === '\t' || s[r] === '\n')) r++;
    if (r < N && s[r] === ')') return r + 1;
    return -1;
  };
  const htmlEnd = (p) => {
    // s[p] === '<': a tag <...> (no space right after <, no <> inside)
    if (p + 1 >= N || s[p + 1] === ' ' || s[p + 1] === '>') return -1;
    const gt = s.indexOf('>', p + 1);
    if (gt === -1) return -1;
    const inner = s.slice(p + 1, gt);
    if (inner.includes('<') || inner.includes('>')) return -1;
    return gt + 1;
  };
  let p = 0;
  while (p < N) {
    if (s[p] === '[') {
      const e = linkEnd(p);
      if (e !== -1) { maskRange(p, e); p = e; continue; }
    }
    if (s[p] === '`') {
      const e = codeSpanEnd(p);
      if (e !== -1) { maskRange(p, e); p = e; continue; }
      // no code span here: skip the whole run (a mid-run position can
      // never start one, same as the (?<!`) lookbehind)
      let n = 0;
      while (p + n < N && s[p + n] === '`') n++;
      p += n;
      continue;
    }
    if (s[p] === '<') {
      const e = htmlEnd(p);
      if (e !== -1) { maskRange(p, e); p = e; continue; }
    }
    p++;
  }
  return out.join('');
}

function resolveEmphasis(items, src) {
  // Hide delimiter runs swallowed by the masked source (computeMasked):
  // a run whose characters were replaced by the masking is invisible to
  // emphasis, so it can neither open nor close. Masking only changes
  // anything when a code span has UNEQUAL backtick runs (``url`) or a
  // link label fails on a code span holding a backtick — both need a
  // run of 2+ backticks. Single-backtick spans and links are consumed
  // atomically by the inline scan already, so skip the two masking
  // passes (a full source rebuild) when no `` run exists.
  let hasDelim = false;
  for (const it of items) if (it.k === 1 && (it.open || it.close)) { hasDelim = true; break; }
  if (hasDelim && src.includes('``')) {
    const masked = computeMasked(src);
    for (const it of items) {
      if (it.k === 1 && masked[it.s] !== it.ch) { it.open = false; it.close = false; }
    }
  }
  // Pre-pass (marked's emStrong m-accumulation): an opener whose forward
  // scan never reaches m <= 0 can never form an emphasis, even though a
  // closer exists further right — an opener-only run in between (e.g. **
  // inside *...*) inflates m past what the closers can repay. Mark such
  // openers dead so the closer-driven walk below never pairs them. The
  // scan is tried for every suffix length of the run (kk), mirroring
  // marked trying emStrong at each position of a run.
  for (let idx = 0; idx < items.length; idx++) {
    const o = items[idx];
    if (o.k !== 1 || !o.open || o.n === 0 || o.ch === '~') continue;
    let alive = false;
    for (let kk = o.n; kk >= 1 && !alive; kk--) {
      let m = kk, f = 0;
      const y = kk;
      for (let j = idx + 1; j < items.length; j++) {
        const cand = items[j];
        if (cand.k !== 1 || cand.ch !== o.ch || cand.n === 0) continue;
        const b = cand.n;
        // RDelim first alternative first: a run skipped by the opposite
        // strong is ignored entirely — it neither adds to m (as an
        // opener) nor subtracts from it (as a closer)
        if (isSkippedCloser(src, o.e, cand.s, cand.e, o.ch)) continue;
        if (cand.open && !cand.close) { m += b; continue; }
        if (!cand.open && !cand.close) continue;
        if ((cand.open && cand.close) || (o.open && o.close)) {
          if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
        }
        m -= b;
        if (m > 0) continue;
        alive = true;
        break;
      }
    }
    if (!alive) o.open = false;
  }
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    if (it.k !== 1 || !it.close || it.n === 0) continue;
    let j = idx - 1;
    while (j >= 0) {
      const o = items[j];
      if (o.k !== 1 || o.ch !== it.ch || !o.open || o.n === 0) { j--; continue; }
      if (it.ch === '~') {
        if (o.n !== it.n) { j--; continue; }
        const kids = items.slice(j + 1, idx);
        items.splice(j, idx - j + 1, { k: 3, tag: 'del', kids });
        idx = j;
        break;
      }
      // rule of 3 (marked's emStrong): skip this opener when the closer can
      // both open and close, or the opener can both open and close, and the
      // opener's length is not a multiple of 3 while the sum is
      if ((it.open && it.close || o.open && o.close) && o.n % 3 !== 0 && (o.n + it.n) % 3 === 0) { j--; continue; }
      // RDelim first alternative: a closer inside a __...__ (for *) or
      // **...** (for _) span does not pair with this opener
      if (isSkippedCloser(src, o.e, it.s, it.e, it.ch)) { j--; continue; }
      const use = (o.n >= 2 && it.n >= 2) ? 2 : 1;
      const kids = items.slice(j + 1, idx);
      const node = { k: 3, tag: use === 2 ? 'strong' : 'em', kids };
      o.n -= use;
      it.n -= use;
      // a partially used run keeps only its outer delimiters: the opener
      // keeps its leftmost, the closer its rightmost (the used ones are the
      // ones adjacent to the emphasis content)
      if (o.n > 0) o.e = o.s + o.n;
      if (it.n > 0) it.s = it.e - it.n;
      if (o.n === 0 && it.n === 0) {
        items.splice(j, idx - j + 1, node);
        idx = j;
      } else if (o.n === 0) {
        items.splice(j, idx - j, node);
        idx = j;
      } else if (it.n === 0) {
        items.splice(j + 1, idx - j, node);
        idx = j + 1;
      } else {
        items.splice(j + 1, idx - j - 1, node);
        idx = j + 1;
      }
      break;
    }
  }
}

/** Emit items to HTML (mode 'html') or plain text (mode 'text', for alt text). */
function emitItems(items, src, mode) {
  let out = '';
  for (const it of items) {
    if (it.k === 0) {
      const raw = src.slice(it.s, it.e);
      if (mode === 'text') out += it.r ? raw : decodeRefs(raw);
      else out += it.r ? raw : escText(decodeRefs(raw));
    } else if (it.k === 1) {
      out += src.slice(it.s, it.e);
    } else if (it.k === 2) {
      out += mode === 'text' ? it.t : it.h;
    } else {
      if (mode === 'html') out += '<' + it.tag + '>' + emitItems(it.kids, src, mode) + '</' + it.tag + '>';
      else out += emitItems(it.kids, src, mode);
    }
  }
  return out;
}

/** Plain-text rendering of inline markdown (image alt text). */
function renderAltText(src, refs) {
  return renderInline(src, refs, false).text;
}

/* ---------------- block layer: lines ---------------- */

function makeLines(src) {
  const starts = [];
  const ends = [];
  const nl = [];
  let pos = 0;
  while (pos < src.length) {
    const j = src.indexOf('\n', pos);
    if (j === -1) { starts.push(pos); ends.push(src.length); nl.push(false); break; }
    starts.push(pos); ends.push(j); nl.push(true); pos = j + 1;
  }
  return { starts, ends, nl, count: starts.length, src };
}

function lineAt(L, i) { return L.src.slice(L.starts[i], L.ends[i]); }

function isBlankLine(L, i) {
  for (let p = L.starts[i]; p < L.ends[i]; p++) {
    const c = L.src[p];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}
// A line of spaces only (no tab): the table-row regex's blank alternative is
// ` *\n`, so a tab-only line is a table row, not a row terminator.
function isSpaceBlankLine(L, i) {
  for (let p = L.starts[i]; p < L.ends[i]; p++) {
    if (L.src[p] !== ' ') return false;
  }
  return true;
}

/** Columns of leading whitespace of line i (tab = next multiple of 4). */
function indentCols(L, i) {
  let col = 0;
  for (let p = L.starts[i]; p < L.ends[i]; p++) {
    const c = L.src[p];
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

/** Offset of the first non-space/tab char of line i. */
function contentPos(L, i) {
  let p = L.starts[i];
  while (p < L.ends[i] && (L.src[p] === ' ' || L.src[p] === '\t')) p++;
  return p;
}

/** Count of leading spaces (not tabs) of line i. */
function leadSpaces(L, i) {
  let n = 0;
  for (let p = L.starts[i]; p < L.ends[i] && L.src[p] === ' '; p++) n++;
  return n;
}

/** Remove up to `cols` columns of indent from a line's text (tab-aware). */
function stripIndentText(text, cols) {
  let col = 0;
  let i = 0;
  while (i < text.length && col < cols) {
    const c = text[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w > cols) return ' '.repeat(col + w - cols) + text.slice(i + 1);
      col += w; i++;
    } else break;
  }
  return text.slice(i);
}

/* ---------------- link reference definitions ---------------- */

/** Parse a def label at src[i] ('['): the `le` shape (no nested brackets). */
function parseDefLabel(src, i) {
  const N = src.length;
  let j = i + 1;
  let hasNonWs = false;
  while (j < N) {
    const c = src[j];
    if (c === '\\' && j + 1 < N) { hasNonWs = true; j += 2; continue; }
    if (c === ']') {
      if (!hasNonWs) return null;
      return { end: j + 1, label: src.slice(i + 1, j) };
    }
    if (c === '[') return null;
    if (c === '\n') {
      let k = j + 1;
      while (k < N && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k >= N || src[k] === '\n') return null;
      j++;
      continue;
    }
    if (c !== ' ' && c !== '\t') hasNonWs = true;
    j++;
  }
  return null;
}

/**
 * Match a link reference definition at src[pos] (0-3 spaces may precede).
 * Returns {end, label, href, title, raw} (end excludes trailing newlines) or null.
 */
function matchDef(src, pos) {
  const N = src.length;
  let i = pos;
  let sp = 0;
  while (src[i] === ' ' && sp < 3) { i++; sp++; }
  if (src[i] !== '[') return null;
  const lab = parseDefLabel(src, i);
  if (!lab) return null;
  let j = lab.end;
  if (src[j] !== ':') return null;
  j++;
  while (src[j] === ' ') j++;
  if (src[j] === '\n') {
    j++;
    while (src[j] === ' ' || src[j] === '\t') j++;
  }
  // destination
  let href = '';
  let hrefEnd = j;
  if (src[j] === '<') {
    // angle destination: marked's def regex is <.*?> — it stops at the
    // FIRST '>' with no escape handling, and '<' is allowed inside
    let k = j + 1;
    let ok = false;
    while (k < N) {
      if (src[k] === '\n') break;
      if (src[k] === '>') { ok = true; break; }
      k++;
    }
    if (!ok) return null;
    href = src.slice(j + 1, k);
    hrefEnd = k + 1;
  } else {
    if (j >= N || src[j] === '<' || isWs(src[j])) return null;
    let k = j;
    while (k < N && !isWs(src[k])) k++;
    href = src.slice(j, k);
    hrefEnd = k;
    if (parenBalance(href) !== -1) return null;
  }
  // optional title, same line or the next (backtrack to no-title when the
  // def does not end cleanly after the title)
  let title = null;
  let end = hrefEnd;
  {
    let r = hrefEnd;
    let tstart = -1;
    if (src[r] === ' ' || src[r] === '\t' || src[r] === '\n') {
      let s = r;
      while (s < N && (src[s] === ' ' || src[s] === '\t')) s++;
      if (src[s] === '\n') {
        let t = s + 1;
        while (t < N && (src[t] === ' ' || src[t] === '\t')) t++;
        if (t < N && (src[t] === '"' || src[t] === "'" || src[t] === '(')) tstart = t;
      } else if (src[s] === '"' || src[s] === "'" || src[s] === '(') {
        tstart = s;
      }
    }
    if (tstart !== -1) {
      const tp = parseTitle(src, tstart);
      if (tp) {
        let w = tp.end;
        while (src[w] === ' ' || src[w] === '\t') w++;
        if (w >= N || src[w] === '\n') { title = tp.title; end = w; }
      }
    }
  }
  if (title === null) {
    let w = hrefEnd;
    while (src[w] === ' ' || src[w] === '\t') w++;
    if (w < N && src[w] !== '\n') return null;
    end = w;
  }
  return { end, label: lab.label, href: unescapePunct(href), title: title === null ? null : unescapePunct(title), raw: src.slice(pos, end) };
}

/* ---------------- block start detectors (one line of text) ---------------- */

function fenceStart(text) {
  let i = 0;
  while (i < 3 && text[i] === ' ') i++;
  const ch = text[i];
  if (ch !== '`' && ch !== '~') return null;
  let n = 0;
  while (text[i + n] === ch) n++;
  if (n < 3) return null;
  const info = text.slice(i + n);
  if (ch === '`' && info.indexOf('`') !== -1) return null;
  return { ch, len: n, indent: i, info };
}

function fenceEndLine(text, ch, len) {
  let i = 0;
  while (i < 3 && text[i] === ' ') i++;
  if (text[i] !== ch) return false;
  let n = 0;
  while (text[i + n] === ch) n++;
  if (n < len) return false;
  for (let k = i + n; k < text.length; k++) if (text[k] !== ' ') return false;
  return true;
}

function atxHeading(text) {
  let i = 0;
  while (i < 3 && text[i] === ' ') i++;
  if (text[i] !== '#') return null;
  let n = 0;
  while (text[i + n] === '#') n++;
  if (n > 6) return null;
  const after = text[i + n];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  let content = text.slice(i + n).trim();
  if (content.charCodeAt(content.length - 1) === 35) {
    const stripped = content.replace(/#+$/, '');
    if (stripped === '' || /[ \t]$/.test(stripped)) content = stripped.trim();
  }
  return { depth: n, text: content };
}

function isHr(text) {
  let i = 0;
  while (i < 3 && text[i] === ' ') i++;
  const ch = text[i];
  if (ch !== '-' && ch !== '_' && ch !== '*') return false;
  let count = 0;
  for (let k = i; k < text.length; k++) {
    const c = text[k];
    if (c === ch) count++;
    else if (c !== ' ' && c !== '\t') return false;
  }
  return count >= 3;
}

const BLOCK_TAGS = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul'.split(' '));

/** HTML block start: {type 1-6, tag?} or null. */
function htmlBlockStart(text) {
  let i = 0;
  while (i < 3 && text[i] === ' ') i++;
  if (text[i] !== '<') return null;
  const rest = text.slice(i);
  let m = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(rest);
  if (m) return { type: 1, tag: m[1].toLowerCase() };
  if (rest.startsWith('<!--')) return { type: 2 };
  if (rest.startsWith('<?')) return { type: 3 };
  if (/^<![A-Za-z]/.test(rest)) return { type: 4 };
  if (rest.startsWith('<![CDATA[')) return { type: 5 };
  m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)(?: +|$|\/?>)/.exec(rest);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return { type: 6, tag: m[1].toLowerCase() };
  return null;
}

function quoteStart(text) {
  let i = 0;
  while (i < 3 && text[i] === ' ') i++;
  return text[i] === '>';
}

/** Strip one blockquote marker from a line (marker + optional space, tabs expanded). */
function stripQuoteMarker(text) {
  let i = 0;
  while (i < 3 && text[i] === ' ') i++;
  const markerEnd = i + 1; // past '>'
  let j = markerEnd;
  let ws = '';
  while (text[j] === ' ' || text[j] === '\t') { ws += text[j]; j++; }
  if (ws.length === 0) return text.slice(markerEnd);
  if (ws.length === 1) return text.slice(markerEnd + 1);
  return expandTabs(ws, markerEnd) + text.slice(j);
}

function listStart(text) {
  let i = 0;
  while (i < 3 && text[i] === ' ') i++;
  const ch = text[i];
  if (ch === '-' || ch === '*' || ch === '+') {
    const nx = text[i + 1];
    if (nx === undefined || nx === ' ' || nx === '\t') return { ordered: false, start: 0, markerLen: 1, indent: i };
    return null;
  }
  if (ch >= '0' && ch <= '9') {
    let j = i;
    while (j < i + 9 && text[j] >= '0' && text[j] <= '9') j++;
    const d = text[j];
    if (d === '.' || d === ')') {
      const nx = text[j + 1];
      if (nx === undefined || nx === ' ' || nx === '\t') {
        return { ordered: true, start: parseInt(text.slice(i, j), 10), delim: d, markerLen: j + 1 - i, indent: i };
      }
    }
    return null;
  }
  return null;
}

/** A line that interrupts a paragraph (GFM rule: any bullet, or ordered 1.). */
function interruptsParagraph(text) {
  let i = 0;
  while (i < 3 && text[i] === ' ') i++;
  const ch = text[i];
  if (ch === '-' || ch === '*' || ch === '+') {
    let j = i + 1, sp = 0;
    while (text[j] === ' ' || text[j] === '\t') { j++; sp++; }
    return sp > 0 && j < text.length;
  }
  if (ch === '1') {
    const d = text[i + 1];
    if (d === '.' || d === ')') {
      let j = i + 2, sp = 0;
      while (text[j] === ' ' || text[j] === '\t') { j++; sp++; }
      return sp > 0 && j < text.length;
    }
  }
  return false;
}

/** A line that stops a blockquote's lazy paragraph (any bullet/ordered + space/EOL). */
function quoteLazyStop(text) {
  let i = 0;
  while (i < 3 && text[i] === ' ') i++;
  const ch = text[i];
  if (ch === '-' || ch === '*' || ch === '+') {
    const nx = text[i + 1];
    return nx === undefined || nx === ' ' || nx === '\t';
  }
  if (ch >= '0' && ch <= '9') {
    let j = i;
    while (j < i + 9 && text[j] >= '0' && text[j] <= '9') j++;
    const d = text[j];
    if (d === '.' || d === ')') {
      const nx = text[j + 1];
      return nx === undefined || nx === ' ' || nx === '\t';
    }
  }
  return false;
}

/** Setext underline depth (1 for =, 2 for -), else 0. */
function setextUnderline(text) {
  let i = 0;
  while (i < 3 && text[i] === ' ') i++;
  const ch = text[i];
  if (ch !== '=' && ch !== '-') return 0;
  let j = i;
  while (text[j] === ch) j++;
  for (let k = j; k < text.length; k++) if (text[k] !== ' ' && text[k] !== '\t') return 0;
  return ch === '=' ? 1 : 2;
}

/** A GFM table delimiter line: returns the alignments array or null. */
function tableDelimiter(text) {
  let i = 0;
  while (i < 3 && text[i] === ' ') i++;
  let p = i;
  const aligns = [];
  if (text[p] === '|') { p++; while (text[p] === ' ') p++; }
  for (;;) {
    let left = false, right = false;
    if (text[p] === ':') { left = true; p++; }
    let dashes = 0;
    while (text[p] === '-') { dashes++; p++; }
    if (dashes === 0) return null;
    if (text[p] === ':') { right = true; p++; }
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
    while (text[p] === ' ') p++;
    if (text[p] === '|') {
      p++;
      while (text[p] === ' ') p++;
      if (p >= text.length) return aligns;
      continue;
    }
    if (p >= text.length) return aligns;
    return null;
  }
}

/** Split a table row/header line into cells (handles escaped pipes). */
function splitTableRow(text) {
  const cells = [];
  let cur = '';
  let i = 0;
  // leading pipe: drop the empty first cell later by trimming
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length && text[i + 1] === '|') { cur += '\\|'; i += 2; continue; }
    if (c === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  cells.push(cur);
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map(s => s.trim().replace(/\\\|/g, '|'));
}

/* ---------------- block helpers ---------------- */

/** ge(): drop trailing blank lines, keeping at most one trailing newline. */
function geText(text) {
  const lines = text.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && isBlankText(lines[t])) t--;
  if (lines.length - t <= 2) return text;
  return lines.slice(0, t + 1).join('\n');
}

function isBlankText(s) {
  for (let i = 0; i < s.length; i++) if (s[i] !== ' ' && s[i] !== '\t') return false;
  return true;
}

/** A line is an indented-code line: >=4 cols indent and has content. */
function isCodeLine(L, i) {
  if (indentCols(L, i) < 4) return false;
  const p = contentPos(L, i);
  return p < L.ends[i];
}

/** Strip up to `cols` columns of indent from a line's text (tab-aware). */
function stripIndentLine(text, cols) {
  return stripIndentText(text, cols);
}

/** Raw source text of lines [first..last] inclusive (with newlines). */
function linesRaw(L, first, last) {
  if (last < first) return '';
  let s = L.src.slice(L.starts[first], L.ends[last]);
  if (L.nl[last]) s += '\n';
  return s;
}

/** HTML start, types 1-6 only (no "complete tag alone" type 7). */
function htmlStart67(text) {
  const hb = htmlBlockStart(text);
  if (!hb || hb.type === 7) return null;
  return hb;
}

/** The lheading's html break pattern: a line that is a complete tag. */
function lheadingHtmlBreak(text) {
  let i = 0;
  while (i < 3 && text[i] === ' ') i++;
  if (text[i] !== '<') return false;
  let j = i + 1;
  while (j < text.length && text[j] !== '>') j++;
  return j === text.length - 1;
}

/** A complete tag alone on the line (type 7): returns its end offset or -1. */
function matchTagAlone(text) {
  let i = 0;
  while (i < 3 && text[i] === ' ') i++;
  if (text[i] !== '<') return -1;
  // close tag
  if (text[i + 1] === '/') {
    let j = i + 2;
    if (!(text[j] >= 'a' && text[j] <= 'z' || text[j] >= 'A' && text[j] <= 'Z')) return -1;
    while (j < text.length && /[a-zA-Z0-9-]/.test(text[j])) j++;
    while (text[j] === ' ' || text[j] === '\t') j++;
    if (text[j] !== '>') return -1;
    j++;
    while (text[j] === ' ' || text[j] === '\t') j++;
    return j >= text.length ? j : -1;
  }
  // open tag (not a comment / PI / declaration / CDATA)
  if (text[i + 1] === '!' || text[i + 1] === '?') return -1;
  let j = i + 1;
  if (!(text[j] >= 'a' && text[j] <= 'z' || text[j] >= 'A' && text[j] <= 'Z')) return -1;
  while (j < text.length && /[a-zA-Z0-9-]/.test(text[j])) j++;
  // attributes: space + name + optional =value
  for (;;) {
    let k = j;
    while (text[k] === ' ' || text[k] === '\t') k++;
    if (k === j) break;
    const nc = text[k];
    if (!(nc >= 'a' && nc <= 'z' || nc >= 'A' && nc <= 'Z' || nc === ':' || nc === '_')) break;
    let n = k;
    while (n < text.length && /[\w.:-]/.test(text[n])) n++;
    let v = n;
    while (text[v] === ' ' || text[v] === '\t') v++;
    if (text[v] === '=') {
      v++;
      while (text[v] === ' ' || text[v] === '\t') v++;
      if (text[v] === '"' || text[v] === "'") {
        const q = text[v];
        let w = v + 1;
        while (w < text.length && text[w] !== q && text[w] !== '\n') w++;
        if (text[w] !== q) return -1;
        v = w + 1;
      } else {
        let w = v;
        while (w < text.length && text[w] !== ' ' && text[w] !== '\t' && text[w] !== '"' && text[w] !== "'" && text[w] !== '=' && text[w] !== '<' && text[w] !== '>' && text[w] !== '`') w++;
        if (w === v) return -1;
        v = w;
      }
    }
    j = v;
  }
  while (text[j] === ' ' || text[j] === '\t') j++;
  if (text[j] === '/') j++;
  if (text[j] !== '>') return -1;
  j++;
  while (text[j] === ' ' || text[j] === '\t') j++;
  return j >= text.length ? j : -1;
}

/* ---------------- indented code ---------------- */

function matchCodeBlock(L, i) {
  if (!isCodeLine(L, i)) return null;
  let j = i;
  while (j < L.count) {
    if (isCodeLine(L, j)) { j++; continue; }
    if (isBlankLine(L, j)) {
      let k = j;
      while (k < L.count && isBlankLine(L, k)) k++;
      if (k < L.count && isCodeLine(L, k)) { j = k; continue; }
      // trailing blank run belongs to the block's raw
      j = k;
      break;
    }
    break;
  }
  // lines i..j-1; if the last line is blank, the raw includes it (ge drops it)
  let last = j - 1;
  const rawAll = linesRaw(L, i, last);
  const raw = geText(rawAll);
  const text = raw.split('\n').map(ln => stripIndentLine(ln, 4)).join('\n');
  return { block: { type: 'code', lang: '', text, raw, first: i, last }, next: j };
}

/* ---------------- fenced code ---------------- */

function matchFence(L, i) {
  const text = lineAt(L, i);
  const fs = fenceStart(text);
  if (!fs) return null;
  let j = i + 1;
  while (j < L.count) {
    if (fenceEndLine(lineAt(L, j), fs.ch, fs.len)) break;
    j++;
  }
  const hasClose = j < L.count;
  const contentLines = [];
  for (let k = i + 1; k < j; k++) contentLines.push(lineAt(L, k));
  let content = contentLines.join('\n');
  if (contentLines.length > 0 && L.nl[j - 1]) content += '\n';
  if (content.charCodeAt(content.length - 1) === 10) content = content.slice(0, -1);
  if (fs.ch === '`' && fs.indent > 0) {
    const ind = fs.indent;
    content = content.split('\n').map(ln => {
      const m = /^\s+/.exec(ln);
      if (!m) return ln;
      return ln.slice(Math.min(m[0].length, ind));
    }).join('\n');
  }
  const lang = fs.info.trim() ? unescapePunct(fs.info.trim()) : '';
  const raw = linesRaw(L, i, hasClose ? j : j - 1);
  return { block: { type: 'code', lang, text: content, raw, first: i, last: hasClose ? j : j - 1 }, next: j + (hasClose ? 1 : 0) };
}

/* ---------------- html block ---------------- */

function matchHtmlBlock(L, i) {
  const text = lineAt(L, i);
  const hb = htmlBlockStart(text);
  if (!hb) {
    // type 7: a complete tag alone on the line
    if (matchTagAlone(text) !== -1) return matchHtmlBlockEnd(L, i, 7, null);
    return null;
  }
  if (hb.type === 6) return matchHtmlBlockEnd(L, i, 6, null);
  // types 1-5: find the closing sequence
  const tag = hb.tag;
  let closeRe = null;
  if (hb.type === 1) closeRe = new RegExp('</' + tag + '>', 'i');
  else if (hb.type === 2) closeRe = /-->/;
  else if (hb.type === 3) closeRe = /\?>/;
  else if (hb.type === 4) closeRe = />/;
  else if (hb.type === 5) closeRe = /\]\]>/;
  let j = i;
  // the close sequence may be on the start line itself
  let rest = text.slice(text.indexOf('<'));
  let found = false;
  for (let k = i; k < L.count; k++) {
    const lt = k === i ? rest : lineAt(L, k);
    const idx = lt.search(closeRe);
    if (idx !== -1) { j = k; found = true; break; }
    // for type 4, the '>' may be later on the same line; search handles it
  }
  if (!found) j = L.count - 1;
  return matchHtmlBlockEnd(L, i, hb.type, j);
}

function matchHtmlBlockEnd(L, i, type, closeLine) {
  let last;
  if (type === 6 || type === 7) {
    // ends at the first blank line or EOF
    let j = i;
    while (j < L.count && !isBlankLine(L, j)) j++;
    last = j - 1;
    // raw extends through the following blank lines (ge drops them)
    let endLine = last;
    while (endLine + 1 < L.count && isBlankLine(L, endLine + 1)) endLine++;
    const raw = geText(linesRaw(L, i, endLine));
    return { block: { type: 'html', text: raw, raw, first: i, last }, next: endLine + 1 };
  }
  last = closeLine;
  let endLine = last;
  // Types 1-5 end with `[^\n]*(\n+|$)` after the close sequence: only
  // consecutive newlines are consumed, so only EMPTY lines (not spaces-only
  // or tab-only lines) extend the raw. A tab-only line after the close is a
  // separate space token and the html text keeps its trailing newline.
  while (endLine + 1 < L.count && L.starts[endLine + 1] === L.ends[endLine + 1]) endLine++;
  const raw = geText(linesRaw(L, i, endLine));
  return { block: { type: 'html', text: raw, raw, first: i, last }, next: endLine + 1 };
}

/* ---------------- table ---------------- */

function matchTable(L, i) {
  if (i + 1 >= L.count) return null;
  const headerText = lineAt(L, i);
  let p = 0;
  while (p < 3 && headerText[p] === ' ') p++;
  if (p >= headerText.length) return null;
  const delimText = lineAt(L, i + 1);
  if (!/[:|]/.test(delimText)) return null;
  const aligns = tableDelimiter(delimText);
  if (!aligns) return null;
  const headerCells = splitTableCells(headerText);
  if (headerCells.length !== aligns.length) return null;
  let j = i + 2;
  const rows = [];
  while (j < L.count) {
    const rt = lineAt(L, j);
    if (isSpaceBlankLine(L, j)) break;
    if (isHr(rt) || atxHeading(rt) || quoteStart(rt) || isCodeLine(L, j) || fenceStart(rt) || interruptsParagraphList(rt) || htmlStart67(rt)) break;
    rows.push(rt);
    j++;
  }
  // Keep the trailing newline in the raw: marked's table-row regex only
  // counts a whitespace-only (tab) row line when it is newline-terminated,
  // so stripping it would drop such a row at EOF.
  const raw = linesRaw(L, i, j - 1);
  return { block: { type: 'table', headerCells, aligns, rows, raw, first: i, last: j - 1 }, next: j };
}

/** GFM paragraph-list pattern: any bullet or ordered 1. + space/tab + non-space. */
function interruptsParagraphList(text) {
  return interruptsParagraph(text);
}

/** Split a table line into cells (the `de` algorithm). */
function splitTableCells(text, padTo) {
  let t = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '|') {
      let bs = 0;
      for (let q = i - 1; q >= 0 && text[q] === '\\'; q--) bs++;
      t += (bs % 2 === 1) ? '|' : ' |';
    } else {
      t += text[i];
    }
  }
  const parts = t.split(' |');
  if (parts.length > 0 && parts[0].trim() === '') parts.shift();
  if (parts.length > 0 && parts[parts.length - 1].trim() === '') parts.pop();
  if (padTo !== undefined) {
    if (parts.length > padTo) parts.length = padTo;
    else while (parts.length < padTo) parts.push('');
  }
  return parts.map(s => s.trim().replace(/\\\|/g, '|'));
}

/* ---------------- paragraph / setext heading ---------------- */

/** Lines that break a setext heading's text (lheading inner lookahead). */
function lheadingBreakLine(L, j) {
  const text = lineAt(L, j);
  if (isBreakBlank(L, j)) return true;
  if (quoteLazyStop(text)) return true;      // bull (any bullet/ordered)
  if (fenceStart(text)) return true;
  if (quoteStart(text)) return true;
  if (atxHeading(text)) return true;
  if (isHr(text)) return true;
  if (lheadingHtmlBreak(text)) return true;
  return false;
}

/** Lines that break a paragraph (GFM paragraph regex lookahead). */
function paragraphBreakLine(L, j) {
  const text = lineAt(L, j);
  if (isBreakBlank(L, j)) return true;
  if (isHr(text)) return true;
  if (atxHeading(text)) return true;
  if (quoteStart(text)) return true;
  if (fenceStart(text)) return true;
  if (interruptsParagraph(text)) return true;
  if (htmlStart67(text)) return true;
  return false;
}

/**
 * A blank line breaks a paragraph/setext text only when it is followed by a
 * newline (the `[ \t]+\n` / `\s*?\n` alternatives): a whitespace-only last
 * line with no trailing newline is part of the paragraph.
 */
function isBreakBlank(L, j) {
  return isBlankLine(L, j) && (j < L.count - 1 || L.nl[j]);
}

function matchParagraph(L, i, top) {
  // setext heading first (lheading): the text group is non-greedy, so it
  // stops at the first line that is a setext underline
  let j = i + 1;
  while (j < L.count) {
    if (setextUnderline(lineAt(L, j)) > 0) break;
    if (lheadingBreakLine(L, j)) break;
    j++;
  }
  if (j < L.count) {
    const depth = setextUnderline(lineAt(L, j));
    if (depth > 0) {
      const text = linesRaw(L, i, j - 1).replace(/\n+$/, '').trim();
      return { block: { type: 'heading', depth, text, raw: linesRaw(L, i, j), first: i, last: j }, next: j + 1 };
    }
  }
  if (!top) {
    // text token: a single line
    const text = lineAt(L, i);
    return { block: { type: 'para', text, raw: text, first: i, last: i }, next: i + 1 };
  }
  // paragraph: collect lines per the paragraph rule
  let k = i + 1;
  while (k < L.count && !paragraphBreakLine(L, k)) k++;
  const text = linesRaw(L, i, k - 1).replace(/\n+$/, '');
  return { block: { type: 'para', text, raw: linesRaw(L, i, k - 1), first: i, last: k - 1 }, next: k };
}

/* ---------------- blockquote ---------------- */

/** Collect the quote's lines (blockquote regex: '>' lines + lazy paragraph lines). */
function collectQuoteLines(L, start) {
  const lines = [];
  let i = start;
  while (i < L.count) {
    const text = lineAt(L, i);
    const mm = /^( {0,3})> ?/.exec(text);
    if (!mm) break;
    lines.push(i);
    const rest = text.slice(mm[0].length);
    if (rest.trim() === '') { i++; continue; }
    let j = i + 1;
    while (j < L.count) {
      const lt = lineAt(L, j);
      if (isBlankLine(L, j)) break;
      if (isHr(lt) || atxHeading(lt) || quoteStart(lt) || fenceStart(lt) || quoteLazyStop(lt) || htmlStart67(lt)) break;
      lines.push(j);
      j++;
    }
    i = j;
  }
  return lines;
}

function matchQuote(L, start, refs) {
  const qlines = collectQuoteLines(L, start);
  if (qlines.length === 0) return null;
  // chunk processing (marked's blockquote tokenizer)
  const innerBlocks = [];
  let n = qlines.slice();
  let consumed = 0;
  let quoteText = '';
  while (n.length > 0) {
    let seen = false;
    const chunk = [];
    let p = 0;
    for (; p < n.length; p++) {
      if (quoteStart(lineAt(L, n[p]))) { chunk.push(n[p]); seen = true; }
      else if (!seen) chunk.push(n[p]);
      else break;
    }
    n = n.slice(p);
    consumed += p;
    const h = chunk.map(idx => lineAt(L, idx)).join('\n');
    // transform: expand tabs after '>', indent setext lines, strip markers
    let u = h.replace(/^( {0,3}>)([ \t]+)/gm, (g, b, m) => b + expandTabs(m, b.length));
    u = u.replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1');
    u = u.replace(/^ {0,3}>[ \t]?/gm, '');
    quoteText = quoteText ? quoteText + '\n' + u : u;
    // parse this chunk's inner text; a leading paragraph/code/def merges into
    // the previous paragraph (marked's blockTokens merge across chunks)
    const refsBefore = new Set(refs.keys());
    const chunkBlocks = parseBlocks(u, true, refs);
    if (chunkBlocks.length > 0 && innerBlocks.length > 0) {
      const prev = innerBlocks[innerBlocks.length - 1];
      const first = chunkBlocks[0];
      if (prev.type === 'para' && first.type === 'para') {
        prev.text = prev.text + '\n' + first.text;
        prev.raw = prev.raw + '\n' + first.raw;
        chunkBlocks.shift();
      } else if (prev.type === 'para' && first.type === 'code') {
        prev.text = prev.text + '\n' + first.text;
        prev.raw = prev.raw + '\n' + first.raw;
        chunkBlocks.shift();
      } else if (prev.type === 'para' && first.type === 'def') {
        prev.text = prev.text + '\n' + first.raw;
        prev.raw = prev.raw + '\n' + first.raw;
        if (!refsBefore.has(first.tag)) refs.delete(first.tag);
        chunkBlocks.shift();
      }
    }
    for (const b of chunkBlocks) innerBlocks.push(b);
    if (n.length === 0) break;
    const k = innerBlocks[innerBlocks.length - 1];
    if (!k) break;
    if (k.type === 'code' || k.type === 'heading' || k.type === 'hr' || k.type === 'html' || k.type === 'table') break;
    if (k.type === 'quote') {
      // re-parse the nested quote together with the remaining lines
      const restText = n.map(idx => lineAt(L, idx)).join('\n');
      const m2 = k.raw + '\n' + restText.replace(/^ {0,3}>[ \t]?/gm, '');
      const f = parseBlocks(m2, true, refs)[0];
      if (f && f.type === 'quote') {
        innerBlocks[innerBlocks.length - 1] = f;
        const consumed2 = m2.slice(f.raw.length).replace(/^\n/, '');
        const rCount = consumed2 ? consumed2.split('\n').length : 0;
        const taken = rCount > 0 ? n.slice(0, n.length - rCount) : n;
        if (taken.length > 0) {
          quoteText = quoteText.substring(0, quoteText.length - k.text.length) + f.text;
        }
        consumed += taken.length;
        n = n.slice(taken.length);
        if (n.length > 0 && quoteStart(lineAt(L, n[0]))) continue;
      }
      break;
    }
    if (k.type === 'list') {
      const restText = n.map(idx => lineAt(L, idx)).join('\n');
      const b2 = k.raw + '\n' + restText;
      const f = parseBlocks(b2, true, refs)[0];
      if (f && f.type === 'list') {
        innerBlocks[innerBlocks.length - 1] = f;
        let extra = 0;
        if (f.raw.length > k.raw.length) {
          extra = b2.slice(k.raw.length + 1, f.raw.length).split('\n').length;
        }
        if (extra > 0) {
          const y = n.slice(0, extra).map(idx => lineAt(L, idx)).join('\n');
          quoteText = quoteText + '\n' + y;
        }
        consumed += extra;
        n = n.slice(extra);
        continue;
      }
    }
    // a paragraph/text tail: loop again for the next chunk
  }
  const usedLines = qlines.slice(0, consumed);
  const endLine = usedLines.length > 0 ? usedLines[usedLines.length - 1] : start;
  const raw = usedLines.map(idx => lineAt(L, idx)).join('\n');
  return { block: { type: 'quote', blocks: innerBlocks, text: quoteText, raw, first: start, last: endLine }, next: endLine + 1 };
}

/* ---------------- list ---------------- */

function matchItemStart(text, ordered, delim, markerChar) {
  let i = 0;
  while (i < 3 && text[i] === ' ') i++;
  if (ordered) {
    const ch = text[i];
    if (!(ch >= '0' && ch <= '9')) return null;
    let j = i;
    while (j < i + 9 && text[j] >= '0' && text[j] <= '9') j++;
    if (text[j] !== delim) return null;
    const nx = text[j + 1];
    if (nx !== undefined && nx !== ' ' && nx !== '\t') return null;
    return { markerLen: j + 1, markerEnd: j + 1, indent: i };
  }
  if (text[i] !== markerChar) return null;
  const nx = text[i + 1];
  if (nx !== undefined && nx !== ' ' && nx !== '\t') return null;
  return { markerLen: i + 1, markerEnd: i + 1, indent: i };
}

function indentLimitRe(text, R, kind) {
  // marked's D() wrapper clamps the indent limit to R-1 (0..3)
  const limit = Math.max(0, Math.min(3, R - 1));
  let i = 0;
  while (i < text.length && text[i] === ' ') i++;
  if (i > limit) return false;
  const rest = text.slice(i);
  if (kind === 'bullet') {
    let j = 0;
    if (rest[j] === '-' || rest[j] === '*' || rest[j] === '+') {
      const nx = rest[j + 1];
      return nx === undefined || nx === ' ' || nx === '\t';
    }
    if (rest[j] >= '0' && rest[j] <= '9') {
      let k = j;
      while (k < j + 9 && rest[k] >= '0' && rest[k] <= '9') k++;
      const d = rest[k];
      if (d === '.' || d === ')') {
        const nx = rest[k + 1];
        return nx === undefined || nx === ' ' || nx === '\t';
      }
    }
    return false;
  }
  if (kind === 'hr') return isHr(rest);
  if (kind === 'fence') return fenceStart(rest) !== null;
  if (kind === 'heading') return atxHeading(rest) !== null;
  if (kind === 'html') return htmlStart67(rest) !== null;
  if (kind === 'quote') return quoteStart(rest);
  return false;
}

/** Whether a single-line string could be a setext heading's text. */
function lheadingTextOk(m) {
  if (m.trim() === '') return false;
  if (quoteLazyStop(m) || fenceStart(m) || quoteStart(m) || atxHeading(m) || isHr(m)) return false;
  if (indentColsOfText(m) >= 4) return false;
  if (lheadingHtmlBreak(m)) return false;
  return true;
}

function indentColsOfText(text) {
  let col = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

function matchList(L, start, refs) {
  const firstText = lineAt(L, start);
  const ls = listStart(firstText);
  if (!ls) return null;
  if (isHr(firstText)) return null;
  const ordered = ls.ordered;
  const delim = ls.delim;
  const markerChar = ordered ? null : firstText[ls.indent];
  const items = [];
  let loose = false;
  let pFlag = false;
  let i = start;
  let listEnd = start;
  while (i < L.count) {
    const text = lineAt(L, i);
    const ms = matchItemStart(text, ordered, delim, markerChar);
    if (!ms) break;
    if (isHr(text)) break;
    const itemStartLine = i;
    const b = ms.markerLen;
    let g = text.slice(ms.markerEnd);
    const leadMatch = /^[ \t]+/.exec(g);
    let m = leadMatch ? expandTabs(leadMatch[0], b) + g.slice(leadMatch[0].length) : g;
    const f = (i + 1 < L.count) ? lineAt(L, i + 1) : '';
    let y = m.trim() === '';
    let R, d;
    if (y) { R = b + 1; d = ''; }
    else {
      R = m.search(/[^ ]/);
      if (R === -1) R = m.length;
      if (R > 4) R = 1;
      d = m.slice(R);
      R += b;
    }
    let u = false;
    let j = i + 1;
    if (y && i + 1 < L.count && isBlankText(f)) {
      j = i + 2;
      u = true;
    }
    if (!u) {
      while (j < L.count) {
        const U = lineAt(L, j);
        if (indentLimitRe(U, R, 'fence') || indentLimitRe(U, R, 'heading') || indentLimitRe(U, R, 'html') || indentLimitRe(U, R, 'quote') || indentLimitRe(U, R, 'bullet') || indentLimitRe(U, R, 'hr')) break;
        const lead2 = /^[ \t]+/.exec(U);
        const Z = lead2 ? expandTabs(lead2[0], 0) + U.slice(lead2[0].length) : U;
        if (Z.search(/[^ ]/) >= R || U.trim() === '') {
          d += '\n' + Z.slice(R);
        } else {
          const mTabs = m.replace(/\t/g, '    ');
          if (y || mTabs.search(/[^ ]/) >= 4 || indentLimitRe(m, R, 'fence') || indentLimitRe(m, R, 'heading') || indentLimitRe(m, R, 'html') || indentLimitRe(m, R, 'hr')) break;
          let qe = U;
          if (/^ {0,3}(?:=+|-+) *$/.test(U) && lheadingTextOk(m) && setextUnderline(U) > 0) {
            qe = '    ' + Z.replace(/^ {0,3}/, '');
          }
          d += '\n' + qe;
        }
        y = U.trim() === '';
        j++;
        m = Z.slice(R);
      }
    }
    const itemLast = j - 1;
    const itemRaw = linesRaw(L, itemStartLine, itemLast);
    if (!loose) {
      if (pFlag) loose = true;
      else if (/\n[ \t]*\n[ \t]*$/.test(itemRaw)) pFlag = true;
    }
    items.push({ raw: itemRaw, text: d, first: itemStartLine, last: itemLast });
    listEnd = itemLast;
    i = j;
  }
  if (items.length === 0) return null;
  // the list's last line is the last non-blank line: a trailing blank line
  // is a separator, not part of the list — it must not hide the gap between
  // this list and the next block for the loose check
  while (listEnd > start && isBlankLine(L, listEnd)) listEnd--;
  const lastItem = items[items.length - 1];
  lastItem.raw = lastItem.raw.replace(/[ \t\n]+$/, '');
  lastItem.text = lastItem.text.replace(/[ \t\n]+$/, '');
  const listRaw = linesRaw(L, start, listEnd).replace(/[ \t\n]+$/, '');
  for (const item of items) {
    item.blocks = parseBlocks(item.text, false, refs);
    item.task = false;
    item.checked = false;
    const tm = /^\[[ xX]\][ \t]+\S/.exec(item.text);
    if (tm && item.blocks.length > 0 && item.blocks[0].type === 'para') {
      item.task = true;
      item.checked = item.text.charAt(1) !== ' ';
    }
  }
  // loose check (b): a blank line between two tokens (blocks or defs) of an item
  if (!loose) {
    for (const item of items) {
      const IL = makeLines(item.text);
      const blocks = item.blocks;
      // gap before the first token: a leading space token is loose only when
      // its raw holds 2+ newlines, i.e. the first token starts at line >= 2
      if (blocks.length > 0 && blocks[0].first >= 2) { loose = true; break; }
      if (!loose) {
        for (let k = 1; k < blocks.length; k++) {
          for (let ln = blocks[k - 1].last + 1; ln < blocks[k].first; ln++) {
            if (isBlankLine(IL, ln)) { loose = true; break; }
          }
          if (loose) break;
        }
      }
      if (loose) break;
    }
  }
  return {
    block: { type: 'list', ordered, start: ordered ? ls.start : 0, loose, items, raw: listRaw, first: start, last: listEnd },
    next: listEnd + 1,
  };
}

/* ---------------- main block parser ---------------- */

function parseBlocks(src, top, refs) {
  const L = makeLines(src);
  const out = [];
  let i = 0;
  const N = L.count;
  while (i < N) {
    if (isBlankLine(L, i)) { i++; continue; }
    const text = lineAt(L, i);
    // indented code
    if (isCodeLine(L, i)) {
      const cb = matchCodeBlock(L, i);
      if (top || !mergeIntoPrev(out, cb.block, i)) out.push(cb.block);
      i = cb.next;
      continue;
    }
    // fenced code
    const fs = fenceStart(text);
    if (fs) {
      const fb = matchFence(L, i);
      out.push(fb.block);
      i = fb.next;
      continue;
    }
    // ATX heading
    const ah = atxHeading(text);
    if (ah) {
      out.push({ type: 'heading', depth: ah.depth, text: ah.text, raw: text, first: i, last: i });
      i++;
      continue;
    }
    // hr
    if (isHr(text)) {
      out.push({ type: 'hr', raw: text, first: i, last: i });
      i++;
      continue;
    }
    // blockquote
    if (quoteStart(text)) {
      const q = matchQuote(L, i, refs);
      if (q) { out.push(q.block); i = q.next; continue; }
    }
    // list
    if (listStart(text)) {
      const l = matchList(L, i, refs);
      if (l) { out.push(l.block); i = l.next; continue; }
    }
    // html block
    const hb = htmlBlockStart(text);
    if (hb || matchTagAlone(text) !== -1) {
      const h = matchHtmlBlock(L, i);
      if (h) { out.push(h.block); i = h.next; continue; }
    }
    // link reference definition
    const d = matchDef(src, L.starts[i]);
    if (d) {
      const defEndLine = lineIndexAtOffset(L, d.end);
      const tag = normLabel(d.label);
      if (top || !mergeDefIntoPrev(out, d, i, defEndLine)) {
        if (!refs.has(tag)) refs.set(tag, { href: d.href, title: d.title, raw: d.raw });
        out.push({ type: 'def', tag, raw: d.raw, first: i, last: defEndLine });
        i = defEndLine + 1;
        continue;
      }
      i = defEndLine + 1;
      continue;
    }
    // table
    if (i + 1 < N) {
      const tb = matchTable(L, i);
      if (tb) { out.push(tb.block); i = tb.next; continue; }
    }
    // paragraph / setext / text
    const p = matchParagraph(L, i, top);
    if (top) {
      out.push(p.block);
    } else if (!mergeTextIntoPrev(out, p.block, i)) {
      out.push(p.block);
    }
    i = p.next;
  }
  return out;
}

/** Line index containing the source offset `off`. */
function lineIndexAtOffset(L, off) {
  let lo = 0, hi = L.count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (L.starts[mid] <= off) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Merge an indented code block into a preceding text/para block (top=false only). */
function mergeIntoPrev(out, codeBlock, startLine) {
  const prev = out[out.length - 1];
  if (!prev || (prev.type !== 'para')) return false;
  if (prev.last !== startLine - 1) return false;
  prev.text = prev.text + '\n' + codeBlock.text;
  prev.raw = prev.raw + '\n' + codeBlock.raw;
  prev.last = codeBlock.last;
  return true;
}

/** Merge a def into a preceding text/para block (top=false only); the def is NOT registered. */
function mergeDefIntoPrev(out, def, startLine, defEndLine) {
  const prev = out[out.length - 1];
  if (!prev || (prev.type !== 'para')) return false;
  if (prev.last !== startLine - 1) return false;
  prev.text = prev.text + '\n' + def.raw;
  prev.raw = prev.raw + '\n' + def.raw;
  prev.last = defEndLine;
  return true;
}

/** Merge a text line into a preceding text/para block (top=false only). */
function mergeTextIntoPrev(out, textBlock, startLine) {
  const prev = out[out.length - 1];
  if (!prev || (prev.type !== 'para')) return false;
  if (prev.last !== startLine - 1) return false;
  prev.text = prev.text + '\n' + textBlock.text;
  prev.raw = prev.raw + '\n' + textBlock.raw;
  prev.last = textBlock.last;
  return true;
}

/* ---------------- block rendering ---------------- */

function renderCode(b) {
  const langFirst = (b.lang || '').match(/^\S*/)?.[0] || '';
  const r = b.text ? b.text.replace(/\n$/, '') + '\n' : '';
  const inner = escAll(r);
  if (langFirst) return '<pre><code class="language-' + escText(langFirst) + '">' + inner + '</code></pre>\n';
  return '<pre><code>' + inner + '</code></pre>\n';
}

function renderListItem(item, listLoose, refs, st) {
  let inner = '';
  const blocks = item.blocks;
  if (item.task && blocks.length > 0 && blocks[0].type === 'para') {
    const stripped = blocks[0].text.replace(/^\[[ xX]\][ \t]+/, '');
    const checkbox = '<input ' + (item.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
    if (listLoose) {
      inner = '<p>' + checkbox + renderInline(stripped, refs, false, st).html + '</p>\n';
      for (let k = 1; k < blocks.length; k++) inner += renderBlock(blocks[k], refs, listLoose, st);
    } else {
      inner = checkbox + renderInline(stripped, refs, false, st).html;
      for (let k = 1; k < blocks.length; k++) inner += renderBlock(blocks[k], refs, listLoose, st);
    }
  } else {
    for (const b of blocks) inner += renderBlock(b, refs, listLoose, st);
  }
  return '<li>' + inner + '</li>\n';
}

function renderList(b, refs, st) {
  const tag = b.ordered ? 'ol' : 'ul';
  const startAttr = (b.ordered && b.start !== 1) ? ' start="' + b.start + '"' : '';
  let s = '<' + tag + startAttr + '>\n';
  for (const item of b.items) s += renderListItem(item, b.loose, refs, st);
  return s + '</' + tag + '>\n';
}

function renderBlock(b, refs, loose, st) {
  switch (b.type) {
    case 'para':
      return loose
        ? '<p>' + renderInline(b.text, refs, false, st).html + '</p>\n'
        : renderInline(b.text, refs, false, st).html;
    case 'heading':
      return '<h' + b.depth + '>' + renderInline(b.text, refs, false, st).html + '</h' + b.depth + '>\n';
    case 'code':
      return renderCode(b);
    case 'hr':
      return '<hr>\n';
    case 'html':
      return b.text;
    case 'quote': {
      let s = '<blockquote>\n';
      for (const ib of b.blocks) s += renderBlock(ib, refs, true, st);
      return s + '</blockquote>\n';
    }
    case 'list':
      return renderList(b, refs, st);
    case 'table':
      throw new Bail('table');
    case 'def':
      return '';
    default:
      throw new Bail('unknown block ' + b.type);
  }
}

/** Fallback to the vendored marked for one block, preserving the
 * document-level inLink/inRawBlock state across the boundary (a fresh
 * marked.parse would reset it, wrongly re-enabling bare-URL autolinks
 * after an unclosed <a ...> tag). Reads the final state back into st. */
function markedFallback(raw, st) {
  const lx = new Lexer();
  lx.state.inLink = st.inLink;
  lx.state.inRawBlock = st.inRaw;
  const tokens = lx.lex(raw);
  const html = new Parser().parse(tokens);
  st.inLink = lx.state.inLink;
  st.inRaw = lx.state.inRawBlock;
  return html;
}

/* ---------------- public entry point ---------------- */

/**
 * Render Markdown to HTML, byte-identical to marked 18.1.3 defaults
 * (gfm true, breaks false). Deterministic: no clock, no env, no cache.
 */
export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const refs = new Map();
  const blocks = parseBlocks(src, true, refs);
  let defsText = '';
  if (refs.size > 0) {
    let first = true;
    for (const v of refs.values()) {
      defsText += (first ? '' : '\n') + v.raw;
      first = false;
    }
  }
  let out = '';
  const st = { inLink: false, inRaw: false };
  for (const b of blocks) {
    if (b.type === 'def') continue;
    try {
      out += renderBlock(b, refs, true, st);
    } catch (e) {
      if (e instanceof Bail) {
        const raw = b.raw;
        out += raw.indexOf('[') !== -1 && defsText
          ? markedFallback(defsText + '\n' + raw, st)
          : markedFallback(raw, st);
      } else {
        throw e;
      }
    }
  }
  return out;
}
