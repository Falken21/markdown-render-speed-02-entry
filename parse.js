// parse.js — a dependency-free Markdown-to-HTML renderer that returns, for every
// input string, exactly the HTML that marked 18.1.3 returns with its default
// options (GFM on, breaks off). Written from the CommonMark 0.31.2 and GFM 0.29
// specifications, with marked's observable behaviour wherever the two diverge.
//
// Shape: a line-oriented block parser (containers: blockquote, list item; leaf
// blocks: fenced/indented code, ATX/setext headings, thematic breaks, HTML
// blocks, GFM tables, paragraphs) that records link reference definitions as it
// goes, then an inline parser (code spans, links, images, autolinks, emphasis
// via a delimiter stack, strikethrough, entities, raw HTML) run at render time
// so forward references resolve. Output formats mirror marked's renderer.

'use strict';

// ---------------------------------------------------------------------------
// Character classes and small helpers
// ---------------------------------------------------------------------------

/** ASCII punctuation, per the CommonMark spec. */
const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

function isAsciiPunct(ch) {
  return ch !== undefined && ASCII_PUNCT.has(ch);
}

const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
const UNICODE_SPACE_RE = /\s/;

/** Whitespace in the CommonMark sense (JS \s covers the Unicode space set). */
function isSpaceCh(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' ||
    (ch !== undefined && ch > '\u007f' && UNICODE_SPACE_RE.test(ch));
}

function isPunctCh(ch) {
  if (ch === undefined) return false;
  if (ch < '\u0080') return ASCII_PUNCT.has(ch);
  return UNICODE_PUNCT_RE.test(ch);
}

/** Count of leading spaces/tabs of `s` from index `i`, in columns (tab = to next multiple of 4). */
function indentCols(s, i, col) {
  let c = col;
  let j = i;
  while (j < s.length) {
    const ch = s[j];
    if (ch === ' ') { c += 1; j += 1; }
    else if (ch === '\t') { c += 4 - (c % 4); j += 1; }
    else break;
  }
  return c - col;
}

/** True when the line's leading whitespace run contains a tab. */
function tabInLeadingRun(line) {
  const m = /^[ \t]+/.exec(line);
  return m !== null && m[0].includes('\t');
}

/**
 * Expand a line's leading whitespace run the way marked's J does: each tab
 * becomes the spaces needed to reach the next multiple of 4, counting from
 * the start of the line.
 */
function expandLeadingRun(line) {
  const m = /^[ \t]+/.exec(line);
  if (!m) return line;
  let col = 0;
  let out = '';
  for (const ch of m[0]) {
    if (ch === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else {
      out += ' ';
      col += 1;
    }
  }
  return out + line.slice(m[0].length);
}

/** True when s[i..] is only spaces and tabs. */
function isBlankRest(s, i) {
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// HTML escaping. One escaper serves text, code and attribute values, matching
// marked: & < > " ' are escaped; in text/attribute contexts an & that begins
// an entity-looking sequence (&name; &#123; &#x1F;) is passed through as-is,
// while in code every & is escaped.
// ---------------------------------------------------------------------------

const ESC_NEEDED_RE = /[&<>"']/;
function escHtml(s, inCode) {
  if (!ESC_NEEDED_RE.test(s)) return s;
  let out = '';
  let last = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) { // &
      if (!inCode) {
        const m = matchEntityRef(s, i);
        if (m > 0) { i += m - 1; continue; }
      }
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

/**
 * If s[i..] (s[i] === '&') starts an entity-looking reference that renderers
 * pass through untouched, return its length, else 0. Named references are any
 * &name; (marked passes even unknown names through); numeric references are
 * &# + 1-7 digits or &#x + 1-6 hex digits, then ';'.
 */
function matchEntityRef(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return 0;
  if (s[j] === '#') {
    j += 1;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) {
      j += 1;
      const start = j;
      while (j < n && j - start < 6 && isHexDigit(s[j])) j += 1;
      if (j > start && j < n && s[j] === ';') return j - i + 1;
      return 0;
    }
    const start = j;
    while (j < n && j - start < 7 && s[j] >= '0' && s[j] <= '9') j += 1;
    if (j > start && j < n && s[j] === ';') return j - i + 1;
    return 0;
  }
  if (!isWordCh(s[j])) return 0;
  j += 1;
  while (j < n && isWordCh(s[j])) j += 1;
  if (j < n && s[j] === ';') return j - i + 1;
  return 0;
}

function isWordCh(ch) {
  return isAlnum(ch) || ch === '_';
}

function isAlpha(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}
function isAlnum(ch) {
  return isAlpha(ch) || (ch >= '0' && ch <= '9');
}
function isHexDigit(ch) {
  return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

/**
 * Decode a numeric character reference at s[i] (s[i] === '&', s[i+1] === '#').
 * Returns { text, len } or null when it is not a reference marked decodes.
 * Code point 0, surrogates and values above U+10FFFF become U+FFFD; decimal
 * references are 1-7 digits, hex references 1-6 digits (marked's limits).
 */
function decodeNumericRef(s, i) {
  const n = s.length;
  let j = i + 2;
  let value;
  if (j < n && (s[j] === 'x' || s[j] === 'X')) {
    j += 1;
    const start = j;
    while (j < n && j - start < 6 && isHexDigit(s[j])) j += 1;
    if (j === start || j >= n || s[j] !== ';') return null;
    value = parseInt(s.slice(start, j), 16);
  } else {
    const start = j;
    while (j < n && j - start < 7 && s[j] >= '0' && s[j] <= '9') j += 1;
    if (j === start || j >= n || s[j] !== ';') return null;
    value = parseInt(s.slice(start, j), 10);
  }
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return { text: '\ufffd', len: j - i + 1 };
  }
  return { text: String.fromCodePoint(value), len: j - i + 1 };
}

/** Resolve backslash escapes of ASCII punctuation (CommonMark §backslash escapes). */
function unescapePunct(s) {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && ASCII_PUNCT.has(s[i + 1])) {
      out += s[i + 1];
      i += 1;
    } else {
      out += s[i];
    }
  }
  return out;
}

/** Normalise a link label for definition lookup: collapse whitespace, fold case. */
function normalizeLabel(raw) {
  // Unicode case folding: ß folds to ss (so [SS] and [ß] and [ẞ] all match).
  return raw.replace(/[ \t\n]+/g, ' ').replace(/^ | $/g, '').toLowerCase().replace(/ß/g, 'ss');
}

/**
 * The href/src value marked emits: the destination (escapes already resolved)
 * percent-encoded the way encodeURI does, then attribute-escaped.
 */
function hrefOut(dest, fullEscape) {
  let encoded;
  try {
    encoded = encodeURI(dest).replace(/%25/g, '%');
  } catch {
    return null; // marked drops the anchor entirely when encodeURI throws
  }
  return escHtml(encoded, fullEscape === true);
}

// ---------------------------------------------------------------------------
// Inline parsing
//
// A scanner produces a flat node list; link/image brackets resolve against
// the definition map as ']' is met; emphasis and strikethrough are then
// matched with the CommonMark delimiter-stack algorithm. Node shapes:
//   { k:'text', s } { k:'code', s } { k:'html', s } { k:'soft' } { k:'hard' }
//   { k:'delim', ch, n, canOpen, canClose, dead }
//   { k:'open', image }                       an unmatched '[' or '!['
//   { k:'link'|'image', dest, title, kids }   title === null when absent
//   { k:'em'|'strong'|'del', kids }
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/;
const SCHEME_AUTOLINK_RE = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*$/;

/** Skip spaces, tabs and newlines (the whitespace allowed inside link parts). */
function skipLinkWs(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i += 1;
  return i;
}

/**
 * Parse `( destination "title" )` starting at s[i] === '('. On success return
 * { dest, title, end } with end just past ')'; else null.
 */
function parseInlineLink(s, i) {
  const n = s.length;
  let j = skipLinkWs(s, i + 1);
  let dest = '';
  if (j < n && s[j] === '<') {
    // Pointy-bracket destination: no line endings, no unescaped < or >.
    let k = j + 1;
    let buf = '';
    let ok = false;
    while (k < n) {
      const c = s[k];
      if (c === '\\' && k + 1 < n && isAsciiPunct(s[k + 1])) { buf += s[k] + s[k + 1]; k += 2; continue; }
      if (c === '>') { ok = true; break; }
      if (c === '<' || c === '\n') break;
      buf += c; k += 1;
    }
    if (!ok) return null;
    dest = buf;
    j = k + 1;
  } else {
    // Bare destination: no spaces or controls, parentheses balanced or escaped.
    let k = j;
    let depth = 0;
    let buf = '';
    while (k < n) {
      const c = s[k];
      if (c === '\\' && k + 1 < n && isAsciiPunct(s[k + 1])) { buf += s[k] + s[k + 1]; k += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c === '<') break;
      if (c === '(') { depth += 1; if (depth > 32) return null; buf += c; k += 1; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth -= 1; buf += c; k += 1; continue;
      }
      buf += c; k += 1;
    }
    if (depth !== 0) return null;
    dest = buf;
    j = k;
  }
  const afterDest = j;
  j = skipLinkWs(s, j);
  const hadWs = j > afterDest;
  let title = null;
  if (j < n && (s[j] === '"' || s[j] === "'" || s[j] === '(')) {
    if (!hadWs && dest !== '') return null;
    const open = s[j];
    const close = open === '(' ? ')' : open;
    let k = j + 1;
    let buf = '';
    let ok = false;
    while (k < n) {
      const c = s[k];
      if (c === '\\' && k + 1 < n && isAsciiPunct(s[k + 1])) { buf += s[k] + s[k + 1]; k += 2; continue; }
      if (c === close) { ok = true; break; }
      if (open === '(' && c === '(') break;
      buf += c; k += 1;
    }
    if (!ok) return null;
    title = buf;
    j = skipLinkWs(s, k + 1);
  }
  if (j < n && s[j] === ')') {
    return { dest: unescapePunct(dest), title: title === null ? null : unescapePunct(title), end: j + 1 };
  }
  return null;
}

/** Scan an HTML tag/comment/etc. at s[i] === '<' (inline HTML, CommonMark grammar). Returns raw text or null. */
function scanInlineHtml(s, i) {
  const n = s.length;
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return '<!-->';
    if (s.startsWith('<!--->', i)) return '<!--->';
    // marked accepts any body (including '--' and newlines) up to '-->'.
    const end = s.indexOf('-->', i + 4);
    if (end === -1) return null;
    return s.slice(i, end + 3);
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    return end === -1 ? null : s.slice(i, end + 2);
  }
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    return end === -1 ? null : s.slice(i, end + 3);
  }
  if (s[i + 1] === '!' && i + 2 < n && s[i + 2] >= 'A' && s[i + 2] <= 'Z') {
    const end = s.indexOf('>', i + 2);
    return end === -1 ? null : s.slice(i, end + 1);
  }
  // Open or closing tag.
  let j = i + 1;
  if (s[j] === '/') j += 1;
  if (j >= n || !isAlpha(s[j])) return null;
  j += 1;
  while (j < n && (isAlnum(s[j]) || s[j] === '-')) j += 1;
  if (s[i + 1] === '/') {
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j += 1;
    return j < n && s[j] === '>' ? s.slice(i, j + 1) : null;
  }
  // Attributes.
  for (;;) {
    let k = j;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k += 1;
    if (k === j) {
      // No whitespace: only '/>' or '>' may follow the tag name / an attribute.
      if (s[j] === '/' && s[j + 1] === '>') return s.slice(i, j + 2);
      if (s[j] === '>') return s.slice(i, j + 1);
      return null;
    }
    if (s[k] === '/' && s[k + 1] === '>') return s.slice(i, k + 2);
    if (s[k] === '>') return s.slice(i, k + 1);
    // Attribute name.
    if (k >= n || !(isAlpha(s[k]) || s[k] === '_' || s[k] === ':')) return null;
    k += 1;
    while (k < n && (isAlnum(s[k]) || s[k] === '_' || s[k] === '.' || s[k] === ':' || s[k] === '-')) k += 1;
    // Optional value.
    let m = k;
    while (m < n && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n')) m += 1;
    if (s[m] === '=') {
      m += 1;
      while (m < n && (s[m] === ' ' || s[m] === '\t' || s[m] === '\n')) m += 1;
      if (s[m] === '"' || s[m] === "'") {
        const q = s[m];
        const end = s.indexOf(q, m + 1);
        if (end === -1) return null;
        j = end + 1;
      } else {
        let e = m;
        while (e < n && !(s[e] === ' ' || s[e] === '\t' || s[e] === '\n' || s[e] === '"' || s[e] === "'" || s[e] === '=' || s[e] === '<' || s[e] === '>' || s[e] === '`')) e += 1;
        if (e === m) return null;
        j = e;
      }
    } else {
      j = k;
    }
  }
}

/** An autolink in angle brackets: <scheme:...> or <email>. Returns { dest, text, end } or null. */
function scanAngleAutolink(s, i) {
  const end = s.indexOf('>', i + 1);
  if (end === -1) return null;
  const body = s.slice(i + 1, end);
  if (body.length === 0 || body.includes('<')) return null;
  if (SCHEME_AUTOLINK_RE.test(body)) return { dest: body, text: body, end: end + 1 };
  if (EMAIL_RE.test(body) && EMAIL_RE.exec(body)[0] === body) return { dest: 'mailto:' + body, text: body, end: end + 1 };
  return null;
}

/** Trim an extended (bare) autolink candidate per GFM: trailing punctuation, unbalanced ')', trailing entity. */
const BACKPEDAL_RE = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

/** marked's url trim: repeatedly cut the match back to the _backpedal prefix. */
function trimAutolink(u) {
  let prev;
  do {
    prev = u;
    const m = BACKPEDAL_RE.exec(u);
    u = m ? m[0] : '';
  } while (u !== prev);
  return u;
}

const EMAIL_LOCAL_TABLE = new Uint8Array(128);
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?^_`{|}~-") {
  EMAIL_LOCAL_TABLE[ch.charCodeAt(0)] = 1;
}
function isEmailLocalCh(ch) {
  if (ch === undefined) return false;
  const cc = ch.charCodeAt(0);
  return cc < 128 && EMAIL_LOCAL_TABLE[cc] === 1;
}
// Chars that may appear inside a plain-text run: email-local chars minus the
// ones with their own inline dispatch (* _ ~ ` & !). A run may only START
// after an alphanumeric or '_' — after any other character an autolink
// attempt or a construct dispatch could still fire at this position.
const RUN_TABLE = new Uint8Array(128);
for (let cc = 0; cc < 128; cc++) RUN_TABLE[cc] = EMAIL_LOCAL_TABLE[cc];
for (const ch of '*_~`&!') RUN_TABLE[ch.charCodeAt(0)] = 0;
const ALNUM_US_TABLE = new Uint8Array(128);
for (let cc = 0; cc < 128; cc++) {
  const ch = String.fromCharCode(cc);
  if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_') {
    ALNUM_US_TABLE[cc] = 1;
  }
}

/**
 * Scan an email address at s[j]: local part, '@', dotted domain. The domain
 * must end in an alphanumeric; an address immediately followed by '-' or
 * '_' is rejected wholesale (marked/GFM behaviour). Returns { end } or null.
 */
function scanEmail(s, j) {
  const n = s.length;
  let k = j;
  while (k < n && isEmailLocalCh(s[k])) k += 1;
  if (k === j || s[k] !== '@') return null;
  return scanEmailDomain(s, k + 1);
}

/** Domain part of an email starting at s[d] (just past '@'). Returns { end } or null. */
function scanEmailDomain(s, d) {
  const n = s.length;
  // First domain label: [A-Za-z0-9-_]+
  if (d >= n || !(isAlnum(s[d]) || s[d] === '-' || s[d] === '_')) return null;
  while (d < n && (isAlnum(s[d]) || s[d] === '-' || s[d] === '_')) d += 1;
  // Further labels: '.' + [A-Za-z0-9-_]* ending in an alphanumeric. marked's
  // regex backtracks label by label against its (?![\w-]) lookahead, so
  // record every alphanumeric end position and take the longest whose
  // following character is not a word char or '-'.
  const candidates = [];
  while (s[d] === '.' && d + 1 < n && (isAlnum(s[d + 1]) || s[d + 1] === '-' || s[d + 1] === '_')) {
    let l = d + 1;
    while (l < n && (isAlnum(s[l]) || s[l] === '-' || s[l] === '_')) {
      l += 1;
      if (isAlnum(s[l - 1])) candidates.push(l);
    }
    d = l;
  }
  for (let c = candidates.length - 1; c >= 0; c--) {
    const e = candidates[c];
    const after = s[e];
    if (after === undefined || !(isAlnum(after) || after === '_' || after === '-')) return { end: e };
  }
  return null;
}

/** Index just past the scheme characters when s[i..] starts with
 * [A-Za-z][A-Za-z0-9+.-]{1,31} followed by '://', else -1. */
function schemeEnd(s, i) {
  if (!isAlpha(s[i])) return -1;
  let e = i + 1;
  let cnt = 0;
  while (e < s.length && cnt < 32 && (isAlnum(s[e]) || s[e] === '+' || s[e] === '-' || s[e] === '.')) {
    e += 1;
    cnt += 1;
  }
  return cnt >= 1 && cnt <= 31 && s.startsWith('://', e) ? e : -1;
}

/** Try a bare extended autolink (www., scheme://, mailto:/xmpp:, email) at s[i]. Returns { dest, text, len } or null. */
function scanBareAutolink(s, i, inBrackets) {
  if (s.startsWith('mailto:', i)) {
    const em = scanEmail(s, i + 7);
    if (!em) return null;
    const full = s.slice(i, em.end);
    return { dest: full, text: full, len: full.length };
  }
  if (s.startsWith('xmpp:', i)) {
    const em = scanEmail(s, i + 5);
    if (!em) return null;
    let end = em.end;
    if (s[end] === '/') {
      let r = end + 1;
      while (r < s.length && (isAlnum(s[r]) || s[r] === '@' || s[r] === '.' || s[r] === '-' || s[r] === '_' || s[r] === '~')) r += 1;
      let e2 = r;
      while (e2 > end + 1 && s[e2 - 1] === '.') e2 -= 1;
      if (e2 > end + 1) end = e2;
    }
    const full = s.slice(i, end);
    return { dest: full, text: full, len: full.length };
  }
  let raw = null;
  let isWww = false;
  if (s.startsWith('www.', i)) {
    let e = i + 4;
    while (e < s.length && !isSpaceCh(s[e]) && s[e] !== '<' && s[e] !== '>') e += 1;
    if (e === i + 4) return null;
    raw = s.slice(i, e);
    isWww = true;
    const host = raw.slice(4).split('/')[0];
    if (!host.includes('.')) return null;
  } else {
    // One walk over the email-local run decides both remaining forms: a
    // scheme needs the run to be [A-Za-z][A-Za-z0-9+.-]{1,31} followed by
    // '://'; an email needs the run followed by '@' and a valid domain.
    const n = s.length;
    let e = i;
    let schemeOk = isAlpha(s[i]);
    while (e < n && isEmailLocalCh(s[e])) {
      const ch = s[e];
      if (schemeOk && !(isAlnum(ch) || ch === '+' || ch === '-' || ch === '.')) schemeOk = false;
      e += 1;
    }
    if (schemeOk && e - i >= 2 && e - i <= 32 && s.startsWith('://', e)) {
      let r = e + 3;
      while (r < n && !isSpaceCh(s[r]) && s[r] !== '<' && s[r] !== '>') r += 1;
      if (r > e + 3) raw = s.slice(i, r);
    }
    if (raw === null) {
      if (s[e] !== '@' || e === i) return null;
      const em = scanEmailDomain(s, e + 1);
      if (!em) return null;
      const addr = s.slice(i, em.end);
      return { dest: 'mailto:' + addr, text: addr, len: addr.length };
    }
  }
  if (inBrackets) {
    // Inside a potential link label the scan must not swallow the closing
    // bracket of a following ( or [ (marked lexes the label with bare
    // autolinks disabled, so the outer link gets to form).
    for (let k = 0; k < raw.length; k++) {
      if (raw[k] === ']' && (s[i + k + 1] === '(' || s[i + k + 1] === '[')) {
        raw = raw.slice(0, k);
        break;
      }
    }
  }
  const trimmed = trimAutolink(raw);
  if (trimmed.length === 0) return null;
  if (isWww && trimmed.length <= 4) return null;
  return { dest: isWww ? 'http://' + trimmed : trimmed, text: trimmed, len: trimmed.length };
}

const EMAIL_LOCAL_TAIL = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/;

// ---------------------------------------------------------------------------
// marked's emStrong tokenizer, ported faithfully (regex algorithm, not the
// CommonMark delimiter stack — the two diverge on inputs like
// '**a *b*c* d**' and '*a **b**c*', and the reference is marked).
// ---------------------------------------------------------------------------

const PUNCT_SRC = '[\\p{P}\\p{S}]';
const PUNCTSPACE_SRC = '[\\s\\p{P}\\p{S}]';
const NOTPUNCTSPACE_SRC = '[^\\s\\p{P}\\p{S}]';

function buildDelimRe(raw) {
  return new RegExp(
    raw
      .replace(/notPunctSpace/g, NOTPUNCTSPACE_SRC)
      .replace(/punctSpace/g, PUNCTSPACE_SRC)
      .replace(/punct/g, PUNCT_SRC),
    'gu',
  );
}

const EM_LDELIM = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const EM_RDELIM_AST = new RegExp(
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)'
    .replace(/notPunctSpace/g, '(?:[^\\s\\p{P}\\p{S}]|~)')
    .replace(/punctSpace/g, '(?!~)[\\s\\p{P}\\p{S}]')
    .replace(/punct/g, '(?!~)[\\p{P}\\p{S}]'),
  'gu',
);
const EM_RDELIM_UND = buildDelimRe('^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)');
const EM_PUNCT_TEST = /^((?![*_])[\s\p{P}\p{S}])/u;
const EM_UNIALNUM = /[\p{L}\p{N}]/u;

const MASK_OT_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_SKIP_RE = /(?:\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\))|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const REFLINK_SEARCH = /!?\[((?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`[^`]*?`|[^\[\]\\`])*?)\]\[((?:\\[\s\S]|[^\[\]\\])*)\]|!?\[((?:\\[\s\S]|[^\[\]\\])+?)\](?!\()/g;
const REFLINK_SEARCH_INNER = new RegExp(REFLINK_SEARCH.source, 'g');

function linkInText(e, defs) {
  if (!e.includes('[')) return false;
  for (const m of e.matchAll(MASK_SKIP_RE)) {
    if (m[0][0] === '[' && e.charAt(m.index - 1) !== '!') return true;
  }
  if (defs && defs.size > 0) {
    for (const m of e.matchAll(REFLINK_SEARCH_INNER)) {
      const r = m[0];
      const o = r.lastIndexOf('[');
      if (defs.has(normalizeLabel(r.slice(o + 1, -1)))) return true;
    }
  }
  return false;
}

function maskReflink(r, defs) {
  const o = r.lastIndexOf('[');
  if (!defs.has(normalizeLabel(r.slice(o + 1, -1)))) return r;
  if (o > 1 && r.charAt(0) !== '!') {
    const inner = r.slice(1, o - 1);
    if (linkInText(inner, defs)) {
      return '[' + inner.replace(REFLINK_SEARCH_INNER, (m) => maskReflink(m, defs)) + '][' + 'a'.repeat(r.length - o - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(r.length - 2) + ']';
}

/**
 * marked's emStrong mask (#n): a length-preserving copy of the source where
 * resolved reference links, escaped punctuation ('+'), code spans (only
 * delimiters kept) and link/code/html spans ('[aaa...]') are hidden —
 * emphasis delimiters inside them must not be seen by the closer search.
 */
const MASK_NEEDED_RE = /[`\\[<]/;
function maskSrc(src, defs) {
  // With no backtick, backslash, '[' or '<' anywhere, every masking pass
  // below is a no-op.
  if (!MASK_NEEDED_RE.test(src)) return src;
  let t = src;
  if (defs && defs.size > 0 && t.includes('[')) {
    t = t.replace(REFLINK_SEARCH, (r) => maskReflink(r, defs));
  }
  if (t.includes('`') || t.includes('\\')) {
    t = t.replace(MASK_OT_RE, (n, s, r) => {
      if (r) return '+'.repeat(n.length);
      if (s) return s + n.slice(s.length, n.length - s.length).replace(/`/g, '+') + s;
      return n;
    });
  }
  if (t.includes('[') || t.includes('`') || t.includes('<')) {
    t = t.replace(MASK_SKIP_RE, (n) => '[' + 'a'.repeat(Math.max(0, n.length - 2)) + ']');
  }
  return t;
}

const DEL_LDELIM = /^~~?(?:((?!~)[\p{P}\p{S}])|([^\s~]))/u;
const DEL_RDELIM = /[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;

/**
 * Try marked's del tokenizer at t[i0] ('~'), mt = masked copy of t.
 * Returns { len, content } or null. The closer run must have exactly the
 * opener's length; group 3/4 matches accumulate instead of closing.
 */
const DEL_LDELIM_Y = new RegExp(DEL_LDELIM.source.replace(/^\^/, ''), 'uy');
function tryDel(t, mt, i0, prevChar, lastPos) {
  DEL_LDELIM_Y.lastIndex = i0;
  const s = DEL_LDELIM_Y.exec(t);
  if (!s) return null;
  if (!(!s[1] || prevChar === '' || EM_PUNCT_TEST.test(prevChar))) return null;
  const o = cpLen(s[0]) - 1;
  const v = lastPos['~'];
  const Q = i0 + o;
  if (v < Q) return null;
  const t2 = mt.slice(i0 + o);
  const ee = v - Q;
  let p = o;
  DEL_RDELIM.lastIndex = 0;
  let s2;
  while ((s2 = DEL_RDELIM.exec(t2)) !== null) {
    if (s2.index > ee) break;
    const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
    if (!g) continue;
    const b = cpLen(g);
    if (b !== o) continue;
    if (s2[3] || s2[4]) { p += b; continue; }
    p -= b;
    if (p > 0) continue;
    const bl = Math.min(b, b + p);
    const te = firstCpLen(s2[0]);
    const raw = t.slice(i0, i0 + o + s2.index + te + bl);
    return { len: raw.length, content: raw.slice(o, raw.length - o) };
  }
  return null;
}

/** marked's fe(): last index of a possibly-closing delimiter run per char. */
const NO_CLOSERS = { '*': -1, '_': -1, '~': -1 };
/** Code-point length of a short string (allocation-free [...x].length). */
function cpLen(x) {
  let n = 0;
  for (let k = 0; k < x.length; k++) {
    const c = x.charCodeAt(k);
    if (c >= 0xDC00 && c <= 0xDFFF && k > 0) {
      const p = x.charCodeAt(k - 1);
      if (p >= 0xD800 && p <= 0xDBFF) continue;
    }
    n += 1;
  }
  return n;
}
/** UTF-16 length of the first code point of x ([...x][0].length). */
function firstCpLen(x) {
  const c = x.charCodeAt(0);
  if (c >= 0xD800 && c <= 0xDBFF && x.length > 1) {
    const d = x.charCodeAt(1);
    if (d >= 0xDC00 && d <= 0xDFFF) return 2;
  }
  return 1;
}
/** The code point immediately before index l in t, as a string. */
function prevCpChar(t, l) {
  const c = t.charCodeAt(l - 1);
  if (c >= 0xDC00 && c <= 0xDFFF && l >= 2) {
    const p = t.charCodeAt(l - 2);
    if (p >= 0xD800 && p <= 0xDBFF) return t.slice(l - 2, l);
  }
  return t[l - 1];
}
const DELIM_RUN_RE = /\*+|_+|~+/g;
function lastPossibleClosers(t) {
  const e = { '*': -1, '_': -1, '~': -1 };
  DELIM_RUN_RE.lastIndex = 0;
  let m;
  while ((m = DELIM_RUN_RE.exec(t)) !== null) {
    const s = m.index;
    const o = s === 0 ? '\n' : t[s - 1];
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') e[m[0][0]] = s;
  }
  return e;
}

/**
 * Try marked's emStrong at t[i0], where mt is the masked copy of t.
 * prevChar is the raw character before i0 ('' at the start).
 * Returns { len, kind, content } or null.
 */
// Sticky twin of EM_LDELIM: the '^' anchors are dropped — stickiness
// anchors the match at lastIndex instead (with 'y', '^' would assert
// position 0 and never match mid-string).
const EM_LDELIM_Y = new RegExp(EM_LDELIM.source.replace(/^\^/, '').replace('|^', '|'), 'uy');
function tryEmStrong(t, mt, i0, prevChar, lastPos) {
  EM_LDELIM_Y.lastIndex = i0;
  const s = EM_LDELIM_Y.exec(t);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const o = prevChar === r;
  let l = i0;
  while (l > 0 && mt[l - 1] === r) l -= 1;
  const p = l === 0 ? '' : prevCpChar(mt, l);
  const h = p === '*' || p === '_' || EM_PUNCT_TEST.test(p);
  let n = prevChar;
  if (l < i0) n = p;
  const u = l < i0 ? h : EM_PUNCT_TEST.test(n);
  if (s[4] && EM_UNIALNUM.test(n)) return null;
  const d = s[1] || s[3] || '';
  if (d && n && !u) return null;
  const k = cpLen(s[0]) - 1;
  let m = k;
  let f = 0;
  const y = i0 - l + k;
  const R = !!p.trim() && (!!d || (r === '*' && !h));
  const A = r === '*' ? EM_RDELIM_AST : EM_RDELIM_UND;
  const v = lastPos[r];
  const Q = i0 + k;
  if (v < Q) return null;
  const t2 = mt.slice(i0 + k);
  const ee = v - Q;
  A.lastIndex = 0;
  let s2;
  while ((s2 = A.exec(t2)) !== null && !(s2.index > ee)) {
    const g = s2[1] || s2[2] || s2[3] || s2[4] || s2[5] || s2[6];
    if (!g) continue;
    let b = cpLen(g);
    if (s2[3] || s2[4]) {
      m += b;
      continue;
    }
    if (s2[6]) {
      // A group-6 run (word char after; word char or punct before) can
      // never close (CommonMark canClose is false for this shape): with a
      // punctuation context it is opener-like and accumulates; with a word
      // context (intraword) it is inert.
      const ctxCh = t2[s2.index];
      if (/[\p{P}\p{S}]/u.test(ctxCh)) {
        m += b;
        continue;
      }
      if (r === '_') continue;
    }
    if (s2[5] || s2[6] || R) {
      if (o && (s2[5] || s2[6])) break;
      if (y % 3 && !((y + b) % 3)) {
        f += b;
        continue;
      }
    }
    m -= b;
    if (m > 0) continue;
    b = Math.min(b, b + m + f);
    const te = firstCpLen(s2[0]);
    const M = t.slice(i0, i0 + k + s2.index + te + b);
    if (Math.min(k, b) % 2) return { len: M.length, kind: 'em', content: M.slice(1, -1) };
    return { len: M.length, kind: 'strong', content: M.slice(2, -2) };
  }
  return null;
}

/** The delimiter-stack emphasis/strikethrough pass over one node list. */
function processEmphasis(nodes) {
  const delims = [];
  for (const nd of nodes) if (nd.k === 'delim') delims.push(nd);
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (closer.dead || !closer.canClose || closer.n === 0) continue;
    let opener = null;
    let oi = -1;
    for (let k = ci - 1; k >= 0; k--) {
      const cand = delims[k];
      if (cand.dead || cand.ch !== closer.ch || !cand.canOpen || cand.n === 0) continue;
      if (cand.ch !== '~') {
        // The "multiple of 3" rule.
        if ((closer.canOpen || cand.canClose) && (cand.n + closer.n) % 3 === 0 && !(cand.n % 3 === 0 && closer.n % 3 === 0)) continue;
      }
      opener = cand;
      oi = k;
      break;
    }
    if (!opener) {
      if (!closer.canOpen) closer.dead = true;
      continue;
    }
    let use;
    if (closer.ch === '~') use = Math.min(2, opener.n, closer.n);
    else use = opener.n >= 2 && closer.n >= 2 ? 2 : 1;
    opener.n -= use;
    closer.n -= use;
    const oiIdx = nodes.indexOf(opener);
    const ciIdx = nodes.indexOf(closer);
    const inner = nodes.splice(oiIdx + 1, ciIdx - oiIdx - 1);
    const wrap = { k: closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em', kids: inner };
    nodes.splice(oiIdx + 1, 0, wrap);
    for (let k = oi + 1; k < ci; k++) delims[k].dead = true;
    if (opener.n === 0) opener.dead = true;
    if (closer.n > 0) ci -= 1;
    else closer.dead = true;
  }
  // Descend into container children (their delimiters are their own pass);
  // a link may sit inside a freshly formed em/strong/del wrapper.
  for (const nd of nodes) {
    if (nd.kids) processEmphasis(nd.kids);
  }
}

/** Render an autolink's kids: marked escapes the link text with full escaping. */
function renderAutoKids(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.k === 'text') out += escHtml(nd.s, true);
    else out += renderNodes([nd]);
  }
  return out;
}

/** Plain-text content of a node list (image alt text): tags vanish, but a
 * nested image contributes its own alt text and a link its text. */
function altText(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 'text':
      case 'code': out += nd.s; break;
      case 'soft':
      case 'hard': out += '\n'; break;
      case 'open': out += nd.image ? '![' : '['; break;
      case 'delim': out += nd.ch.repeat(nd.n); break;
      case 'em':
      case 'strong':
      case 'del':
      case 'link':
      case 'image': out += altText(nd.kids); break;
      default: break; // raw html contributes nothing
    }
  }
  return out;
}

/** Render a node list to HTML. */
function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 'text': out += nd.raw ? nd.s : escHtml(nd.s, false); break;
      case 'code': out += '<code>' + escHtml(nd.s, true) + '</code>'; break;
      case 'html': out += nd.s; break;
      case 'soft': out += '\n'; break;
      case 'hard': out += '<br>'; break;
      case 'open': out += nd.image ? '![' : '['; break;
      case 'delim': out += nd.ch.repeat(nd.n); break;
      case 'em': out += '<em>' + renderNodes(nd.kids) + '</em>'; break;
      case 'strong': out += '<strong>' + renderNodes(nd.kids) + '</strong>'; break;
      case 'del': out += '<del>' + renderNodes(nd.kids) + '</del>'; break;
      case 'link': {
        const href = hrefOut(nd.dest, nd.auto !== undefined);
        const inner = nd.auto !== undefined ? renderAutoKids(nd.kids) : renderNodes(nd.kids);
        if (href === null) {
          out += inner;
          break;
        }
        out += '<a href="' + href + '"' +
          (nd.title !== null ? ' title="' + escHtml(nd.title, false) + '"' : '') +
          '>' + inner + '</a>';
        break;
      }
      case 'image': {
        const alt = altText(nd.kids);
        const src = hrefOut(nd.dest, false);
        if (src === null) {
          out += escHtml(alt, false);
          break;
        }
        out += '<img src="' + src + '" alt="' + escHtml(alt, false) + '"' +
          (nd.title !== null ? ' title="' + escHtml(nd.title, false) + '"' : '') + '>';
        break;
      }
      default: break;
    }
  }
  return out;
}

/** Flanking booleans for a delimiter run spanning s[i..j). */
function flanking(s, i, j) {
  const prev = i === 0 ? '' : s[i - 1];
  const next = j >= s.length ? '' : s[j];
  const prevWs = prev === '' || isSpaceCh(prev);
  const nextWs = next === '' || isSpaceCh(next);
  const prevP = prev !== '' && isPunctCh(prev);
  const nextP = next !== '' && isPunctCh(next);
  return {
    left: !nextWs && (!nextP || prevWs || prevP),
    right: !prevWs && (!prevP || nextWs || nextP),
    prevP,
    nextP,
  };
}

const DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/;

/** Parse one block's inline text into a rendered node tree (not yet rendered). */
/**
 * Index of the ']' that pairs with the bracket whose label starts at
 * topB.after, or -1. Scans the label region with marked's label-shape
 * rules: escapes, lenient code spans (any closing backtick run) and
 * balanced nested brackets are skipped.
 */
function findCloseBracket(text, topB) {
  let j = topB.after;
  const n = text.length;
  let depth = 0;
  while (j < n) {
    const ch = text[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '`') {
      let run = 0;
      while (text[j + run] === '`') run += 1;
      if (run >= 2 && text[j + run] === ']') { j += run; continue; }
      let k = j + run;
      let closed = false;
      while (k < n) {
        if (text[k] === '`') { closed = true; while (text[k] === '`') k += 1; break; }
        k += 1;
      }
      if (!closed) return -1;
      j = k;
      continue;
    }
    if (ch === '[') { depth += 1; j += 1; continue; }
    if (ch === ']') {
      if (depth === 0) return j;
      depth -= 1;
      j += 1;
      continue;
    }
    j += 1;
  }
  return -1;
}

/**
 * marked's link-label shape (the Lt pattern): text, escapes, one level of
 * nested brackets, and code spans whose closing run is any backtick run —
 * plus a trailing run of 2+ backticks. An unclosed backtick or bracket
 * makes the label (and so the link) invalid.
 */
function labelValid(label) {
  let j = 0;
  const n = label.length;
  while (j < n) {
    const ch = label[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '[') {
      let depth = 1;
      j += 1;
      while (j < n && depth > 0) {
        if (label[j] === '\\') { j += 2; continue; }
        if (label[j] === '[') depth += 1;
        else if (label[j] === ']') depth -= 1;
        j += 1;
      }
      if (depth !== 0) return false;
      continue;
    }
    if (ch === ']') return false;
    if (ch === '`') {
      let run = 0;
      while (label[j + run] === '`') run += 1;
      if (run >= 2 && j + run === n) return true;
      let k = j + run;
      let closed = false;
      while (k < n) {
        if (label[k] === '`') { closed = true; while (label[k] === '`') k += 1; break; }
        k += 1;
      }
      if (!closed) return false;
      j = k;
      continue;
    }
    j += 1;
  }
  return true;
}

/**
 * Would the bracket whose label starts at topB.after form a link at the
 * ']' at closeIdx? Mirrors the ']' handler's formation logic (without the
 * emission gate). Used to keep emphasis from spanning a formed link's ']'.
 */
function bracketWouldForm(text, closeIdx, topB, defs) {
  const labelSrc = text.slice(topB.after, closeIdx);
  const mayForm = topB.image || !topB.noLink;
  if (!mayForm) return false;
  if (!labelValid(labelSrc)) return false;
  const j = closeIdx + 1;
  let valid = false;
  if (text[j] === '(') valid = !!parseInlineLink(text, j);
  else if (text[j] === '[') {
    let k = j + 1;
    let inner = '';
    let ok = false;
    const n = text.length;
    while (k < n) {
      const ch = text[k];
      if (ch === '\\' && k + 1 < n && isAsciiPunct(text[k + 1])) { inner += ch + text[k + 1]; k += 2; continue; }
      if (ch === '[') break;
      if (ch === ']') { ok = true; break; }
      inner += ch;
      k += 1;
    }
    if (ok) valid = defs.has(normalizeLabel(inner === '' ? labelSrc : inner));
  } else {
    valid = defs.has(normalizeLabel(labelSrc));
  }
  if (!valid) return false;
  if (topB.image) return true;
  // De gate: a link emitted inside the label rejects the outer link.
  const savedLeak = inlineLinkLeak;
  const savedEm = inlineLinkEmitted;
  inlineLinkEmitted = false;
  parseInline(labelSrc, defs);
  const innerEm = inlineLinkEmitted;
  inlineLinkLeak = savedLeak;
  inlineLinkEmitted = savedEm;
  return !innerEm;
}

/** Splice out bare-autolink nodes at any depth (their kids take their place). */
function unwrapBareAutos(kids) {
  for (let k = kids.length - 1; k >= 0; k--) {
    const nd = kids[k];
    if (nd.k === 'link' && nd.auto === 'bare') {
      kids.splice(k, 1, ...nd.kids);
    } else if (nd.kids) {
      unwrapBareAutos(nd.kids);
    }
  }
}

function parseInline(text, defs) {
  const nodes = [];
  const brackets = [];
  const n = text.length;
  let buf = '';
  let i = 0;
  // Masking and the closer index only feed the emStrong/del tokenizers;
  // without any emphasis character in the text both are skipped.
  const hasEmph = text.includes('*') || text.includes('_') || text.includes('~');
  const masked = hasEmph ? maskSrc(text, defs) : text;
  const lastPos = hasEmph ? lastPossibleClosers(masked) : NO_CLOSERS;
  const flush = () => {
    if (buf) {
      nodes.push(inlineRawBlock ? { k: 'text', s: buf, raw: true } : { k: 'text', s: buf });
      buf = '';
    }
  };
  // True when the nearest open bracket would form a link at its ']' —
  // constructs scanned inside its label must not consume that ']'.
  // Both the close scan and the would-form probe are pure in
  // (text, bracket, defs), so they are memoized on the bracket object.
  const bracketProtects = () => {
    if (!brackets.length) return false;
    const topB = brackets[brackets.length - 1];
    if (topB._ci === undefined) topB._ci = findCloseBracket(text, topB);
    if (topB._ci === -1) return false;
    if (topB._wf === undefined) topB._wf = bracketWouldForm(text, topB._ci, topB, defs);
    return topB._wf;
  };

  while (i < n) {
    const c = text[i];

    // Fast path: a run of plain text characters (word tails and similar)
    // that cannot start any construct and cannot be an autolink start —
    // consumed in one slice instead of per-character dispatch.
    {
      const cc = text.charCodeAt(i);
      if (i > 0 && cc < 128 && RUN_TABLE[cc] === 1) {
        const pc = text.charCodeAt(i - 1);
        if (pc < 128 && ALNUM_US_TABLE[pc] === 1) {
          let j = i + 1;
          while (j < n) {
            const cj = text.charCodeAt(j);
            if (cj >= 128 || RUN_TABLE[cj] !== 1) break;
            j += 1;
          }
          buf += text.slice(i, j);
          i = j;
          continue;
        }
      }
    }

    // Extended autolinks (www / scheme / mailto: / xmpp: / bare email) are
    // attempted at the start of an email-ish run: a local-part character
    // whose predecessor is not one.
    if (!inlineLinkLeak && isEmailLocalCh(c) && (i === 0 || !isEmailLocalCh(text[i - 1]))) {
      const r = scanBareAutolink(text, i, bracketProtects());
      if (r) {
        flush();
        nodes.push({ k: 'link', dest: r.dest, title: null, kids: [{ k: 'text', s: r.text }], auto: 'bare' });
        i += r.len;
        continue;
      }
    }

    if (c === '\n') {
      let sp = 0;
      while (sp < buf.length && buf[buf.length - 1 - sp] === ' ') sp += 1;
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flush();
        nodes.push({ k: 'hard' });
        i += 1;
        // A hard break swallows the next line's leading spaces/tabs.
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i += 1;
      } else {
        flush();
        nodes.push({ k: 'soft' });
        i += 1;
      }
      continue;
    }

    if (c === '\\') {
      const d = text[i + 1];
      if (d === '\n') {
        flush();
        nodes.push({ k: 'hard' });
        i += 2;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i += 1;
        continue;
      }
      if (d !== undefined && isAsciiPunct(d)) {
        flush();
        nodes.push({ k: 'text', s: d });
        i += 2;
        continue;
      }
      buf += c;
      i += 1;
      continue;
    }

    if (c === '`') {
      let run = 0;
      while (text[i + run] === '`') run += 1;
      // Find a closing run of exactly the same length.
      let j = i + run;
      let closeAt = -1;
      while (j < n) {
        if (text[j] === '`') {
          let r2 = 0;
          while (text[j + r2] === '`') r2 += 1;
          if (r2 === run) { closeAt = j; break; }
          j += r2;
        } else j += 1;
      }
      if (closeAt !== -1 && brackets.length) {
        // A code span must not swallow the ']' of a bracket that will
        // form a link (marked matches the link before scanning the label).
        const topB = brackets[brackets.length - 1];
        if (topB._ci === undefined) topB._ci = findCloseBracket(text, topB);
        if (topB._ci !== -1 && closeAt + run > topB._ci && bracketProtects()) {
          closeAt = -1;
        }
      }
      if (closeAt === -1) {
        buf += text.slice(i, i + run);
        i += run;
        continue;
      }
      flush();
      let content = text.slice(i + run, closeAt).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      nodes.push({ k: 'code', s: content });
      i = closeAt + run;
      continue;
    }

    if (c === '&') {
      if (text[i + 1] === '#') {
        const dec = decodeNumericRef(text, i);
        if (dec) {
          flush();
          nodes.push({ k: 'text', s: dec.text });
          i += dec.len;
          continue;
        }
      }
      buf += c;
      i += 1;
      continue;
    }

    if (c === '<') {
      const auto = scanAngleAutolink(text, i);
      if (auto) {
        flush();
        nodes.push({ k: 'link', dest: auto.dest, title: null, kids: [{ k: 'text', s: auto.text }], auto: 'angle' });
        i = auto.end;
        continue;
      }
      const html = scanInlineHtml(text, i);
      if (html) {
        flush();
        nodes.push({ k: 'html', s: html });
        // marked's tag tokenizer state: an '<a ' start tag sets inLink
        // (suppressing bare autolinks) until a literal '</a>'; pre/code/
        // kbd/script start tags set inRawBlock (text renders unescaped).
        if (!inlineLinkLeak && /^<a /i.test(html)) inlineLinkLeak = true;
        else if (inlineLinkLeak && /^<\/a>/i.test(html)) inlineLinkLeak = false;
        if (!inlineRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(html)) inlineRawBlock = true;
        else if (inlineRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(html)) inlineRawBlock = false;
        i += html.length;
        continue;
      }
      buf += c;
      i += 1;
      continue;
    }

    if (c === '!' && text[i + 1] === '[') {
      flush();
      const marker = { k: 'open', image: true };
      nodes.push(marker);
      brackets.push({ node: marker, image: true, after: i + 2, leakBefore: inlineLinkLeak, emittedBefore: inlineLinkEmitted });
      i += 2;
      continue;
    }

    if (c === '[') {
      flush();
      const marker = { k: 'open', image: false };
      nodes.push(marker);
      brackets.push({ node: marker, image: false, after: i + 1, leakBefore: inlineLinkLeak, emittedBefore: inlineLinkEmitted });
      i += 1;
      continue;
    }

    if (c === ']') {
      if (brackets.length === 0) {
        buf += c;
        i += 1;
        continue;
      }
      const top = brackets[brackets.length - 1];
      flush();
      const labelSrc = text.slice(top.after, i);
      let formed = null;
      let end = i + 1;
      // A ']' consumes exactly the nearest opener. An opener deactivated by
      // an inner link (noLink) can no longer form a link, though an image
      // opener can still form an image.
      const mayForm = (top.image || !top.noLink) && labelValid(labelSrc);
      if (mayForm && text[i + 1] === '(') {
        const r = parseInlineLink(text, i + 1);
        if (r) {
          formed = { dest: r.dest, title: r.title };
          end = r.end;
        }
      }
      if (!formed && mayForm) {
        let label2 = null;
        let refEnd = -1;
        if (text[i + 1] === '[') {
          let k = i + 2;
          let inner = '';
          let ok = false;
          while (k < n) {
            const ch = text[k];
            if (ch === '\\' && k + 1 < n && isAsciiPunct(text[k + 1])) { inner += ch + text[k + 1]; k += 2; continue; }
            if (ch === '[') break;
            if (ch === ']') { ok = true; break; }
            inner += ch;
            k += 1;
          }
          if (ok) {
            label2 = inner === '' ? labelSrc : inner;
            refEnd = k + 1;
          }
        }
        let def = null;
        if (label2 !== null) {
          def = defs.get(normalizeLabel(label2));
          if (def) {
            formed = { dest: def.dest, title: def.title };
            end = refEnd;
          }
        }
        if (!formed && label2 === null) {
          // Shortcut reference — only when no [label] ref form was present;
          // a present-but-unresolved ref form forbids the fallback.
          def = defs.get(normalizeLabel(labelSrc));
          if (def) {
            formed = { dest: def.dest, title: def.title };
            end = i + 1;
          }
        }
      }
      if (formed) {
        // marked's link creation (De): the label is lexed as its own inline
        // string in a fresh emission scope; if a LINK was emitted inside a
        // link's label, the outer link is rejected (links cannot nest).
        inlineLinkLeak = top.leakBefore;
        inlineLinkEmitted = false;
        const rawBefore = inlineRawBlock;
        const kids = parseInline(labelSrc, defs);
        const innerEmitted = inlineLinkEmitted;
        inlineLinkLeak = top.leakBefore;
        inlineLinkEmitted = top.emittedBefore;
        if (!top.image && innerEmitted) {
          inlineRawBlock = rawBefore;
          formed = null;
        } else {
          brackets.pop();
          const idx = nodes.indexOf(top.node);
          nodes.splice(idx + 1, nodes.length - idx - 1);
          nodes.pop();
          // Bare (extended) autolinks never nest inside a link (marked
          // lexes labels with the url tokenizer disabled); angle autolinks
          // do nest (marked renders them as nested anchors).
          unwrapBareAutos(kids);
          nodes.push({ k: top.image ? 'image' : 'link', dest: formed.dest, title: formed.title, kids });
          if (!top.image) {
            inlineLinkEmitted = true;
            // Links cannot nest: every opener below a formed link loses
            // the ability to form a link (image openers keep image ability).
            for (const b of brackets) b.noLink = true;
          }
          i = end;
          continue;
        }
      }
      brackets.pop();
      buf += c;
      i += 1;
      continue;
    }

    if (c === '*' || c === '_') {
      // marked tries the link tokenizer at '[' before any emphasis inside
      // the label can span past the link's ']': if the nearest open
      // bracket would form a link, this delimiter belongs to the label's
      // own inline pass, not to this one.
      if (brackets.length && bracketProtects()) {
        buf += c;
        i += 1;
        continue;
      }
      // marked's emStrong tokenizer (regex algorithm) — attempted at every
      // delimiter position; on failure the char is literal text.
      const r = tryEmStrong(text, masked, i, i === 0 ? '' : text[i - 1], lastPos);
      if (r) {
        flush();
        nodes.push({ k: r.kind, kids: parseInline(r.content, defs) });
        i += r.len;
        continue;
      }
      buf += c;
      i += 1;
      continue;
    }

    if (c === '~') {
      // marked's del tokenizer (atomic span, like emStrong).
      const r = tryDel(text, masked, i, i === 0 ? '' : text[i - 1], lastPos);
      if (r) {
        flush();
        nodes.push({ k: 'del', kids: parseInline(r.content, defs) });
        i += r.len;
        continue;
      }
      buf += c;
      i += 1;
      continue;
    }

    if (c === '@' && buf && !inlineLinkLeak) {
      const m = EMAIL_LOCAL_TAIL.exec(buf);
      if (m) {
        const dm = DOMAIN_RE.exec(text.slice(i + 1));
        if (dm) {
          const afterDm = text[i + 1 + dm[0].length];
          if (afterDm !== '-' && afterDm !== '_') {
            const email = m[0] + '@' + dm[0];
            buf = buf.slice(0, buf.length - m[0].length);
            flush();
            nodes.push({ k: 'link', dest: 'mailto:' + email, title: null, kids: [{ k: 'text', s: email }], auto: 'bare' });
            i += 1 + dm[0].length;
            continue;
          }
        }
      }
      buf += c;
      i += 1;
      continue;
    }

    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
      const prevOk = i === 0 || !(isAlnum(text[i - 1]) || text[i - 1] === '_');
      if (!inlineLinkLeak && prevOk && (text.startsWith('www.', i) || schemeEnd(text, i) !== -1)) {
        const r = scanBareAutolink(text, i, bracketProtects());
        if (r) {
          flush();
          nodes.push({ k: 'link', dest: r.dest, title: null, kids: [{ k: 'text', s: r.text }], auto: 'bare' });
          i += r.len;
          continue;
        }
      }
      buf += c;
      i += 1;
      continue;
    }

    buf += c;
    i += 1;
  }
  flush();
  return nodes;
}

/** Render inline source text to HTML. */
function renderInline(text, defs) {
  if (!text) return '';
  return renderNodes(parseInline(text, defs));
}

// ---------------------------------------------------------------------------
// Block parsing
//
// Incremental, line by line: match open containers (blockquote, list item),
// continue open leaf blocks (fence, indented code, HTML, table), then try new
// block starts, else feed the open paragraph. A line cursor tracks character
// index, column and the un-consumed remainder of a split tab ("debt").
// ---------------------------------------------------------------------------

function newCur(s) {
  return { s, i: 0, col: 0, debt: 0 };
}
function curClone(c) {
  return { s: c.s, i: c.i, col: c.col, debt: c.debt };
}
function curCode(c) {
  if (c.debt > 0) return 32;
  return c.i < c.s.length ? c.s.charCodeAt(c.i) : -1;
}
function curChar(c) {
  if (c.debt > 0) return ' ';
  return c.i < c.s.length ? c.s[c.i] : '';
}
function curAdvance(c) {
  if (c.debt > 0) {
    c.debt -= 1;
    c.col += 1;
    return;
  }
  if (c.i >= c.s.length) return;
  const ch = c.s[c.i];
  c.i += 1;
  c.col += ch === '\t' ? 4 - (c.col % 4) : 1;
}
function curIndentCols(c) {
  let cols = c.debt;
  let col = c.col + c.debt;
  let j = c.i;
  while (j < c.s.length) {
    const ch = c.s[j];
    if (ch === ' ') {
      cols += 1;
      col += 1;
      j += 1;
    } else if (ch === '\t') {
      const w = 4 - (col % 4);
      cols += w;
      col += w;
      j += 1;
    } else break;
  }
  return cols;
}
function curConsumeCols(c, n) {
  while (n > 0) {
    if (c.debt > 0) {
      const take = Math.min(n, c.debt);
      c.debt -= take;
      c.col += take;
      n -= take;
      continue;
    }
    const ch = c.s[c.i];
    if (ch === ' ') {
      c.i += 1;
      c.col += 1;
      n -= 1;
    } else if (ch === '\t') {
      const w = 4 - (c.col % 4);
      if (w <= n) {
        c.i += 1;
        c.col += w;
        n -= w;
      } else {
        c.i += 1;
        c.debt = w - n;
        c.col += n;
        n = 0;
      }
    } else break;
  }
}
function curRest(c) {
  return c.debt > 0 ? ' '.repeat(c.debt) + c.s.slice(c.i) : c.s.slice(c.i);
}
function curBlank(c) {
  for (let j = c.i; j < c.s.length; j++) {
    const ch = c.s[j];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}
function skipIndentUpTo(c, max) {
  const take = Math.min(curIndentCols(c), max);
  curConsumeCols(c, take);
  return take;
}
/** Consume a single column of whitespace (the optional space after '>'). */
function consumeOneSpace(c) {
  if (c.debt > 0) {
    c.debt -= 1;
    c.col += 1;
    return;
  }
  const ch = c.s[c.i];
  if (ch === ' ') {
    c.i += 1;
    c.col += 1;
  } else if (ch === '\t') {
    const w = 4 - (c.col % 4);
    c.i += 1;
    if (w > 1) c.debt = w - 1;
    c.col += 1;
  }
}

// --- Block-start matchers (work on clones; return info or null) -------------

function matchFence(cur) {
  if (curIndentCols(cur) > 3) return null;
  const c = curClone(cur);
  // marked's Dt compensation measures the opener's whitespace prefix in
  // CHARACTERS of the post-container line (a tab counts once).
  const prefix = curRest(c).match(/^\s*/)[0].length;
  const indent = skipIndentUpTo(c, 3);
  const ch = curChar(c);
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (curChar(c) === ch) {
    curAdvance(c);
    len += 1;
  }
  if (len < 3) return null;
  const info = curRest(c).trim();
  if (ch === '`' && info.includes('`')) return null;
  return { ch, len, info, indent, prefix };
}

// marked's Dt: a BACKTICK fence's content lines each lose
// min(their own leading-whitespace char count, the opener's prefix char
// count) characters. Tilde fences get no compensation at all (the
// indentCodeCompensation regex only matches ``` openers).
function fenceContentLine(tp, s) {
  if (tp.ch !== '`' || !tp.prefix) return s;
  const ws = s.match(/^\s*/)[0].length;
  if (!ws) return s;
  return s.slice(Math.min(ws, tp.prefix));
}

function isFenceClose(cur, fence) {
  const c = curClone(cur);
  skipIndentUpTo(c, 3);
  if (curChar(c) !== fence.ch) return false;
  let len = 0;
  while (curChar(c) === fence.ch) {
    curAdvance(c);
    len += 1;
  }
  if (len < fence.len) return false;
  return curBlank(c);
}

function matchAtx(cur) {
  if (curIndentCols(cur) > 3) return null;
  const c = curClone(cur);
  skipIndentUpTo(c, 3);
  let level = 0;
  while (curChar(c) === '#') {
    curAdvance(c);
    level += 1;
  }
  if (level === 0 || level > 6) return null;
  const ch = curChar(c);
  if (ch !== '' && ch !== ' ' && ch !== '\t') return null;
  let content = curRest(c).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (/^#+$/.test(content)) content = '';
  else content = content.replace(/[ \t]#+$/, '').replace(/[ \t]+$/, '');
  return { level, text: content };
}

function matchSetext(cur) {
  if (curIndentCols(cur) > 3) return null;
  const c = curClone(cur);
  skipIndentUpTo(c, 3);
  const ch = curChar(c);
  if (ch !== '=' && ch !== '-') return null;
  while (curChar(c) === ch) curAdvance(c);
  if (!curBlank(c)) return null;
  return { level: ch === '=' ? 1 : 2 };
}

function matchHr(cur) {
  if (curIndentCols(cur) > 3) return null;
  const c = curClone(cur);
  skipIndentUpTo(c, 3);
  let marker = '';
  let count = 0;
  for (;;) {
    const ch = curChar(c);
    if (ch === '-' || ch === '*' || ch === '_') {
      if (marker === '') marker = ch;
      else if (ch !== marker) return null;
      count += 1;
      curAdvance(c);
    } else if (ch === ' ' || ch === '\t') {
      curAdvance(c);
    } else break;
  }
  if (curChar(c) !== '') return null;
  return count >= 3 ? {} : null;
}

function matchQuote(cur) {
  if (curIndentCols(cur) > 3) return null;
  const c = curClone(cur);
  skipIndentUpTo(c, 3);
  if (curChar(c) !== '>') return null;
  curAdvance(c);
  consumeOneSpace(c);
  return c;
}

/**
 * marked J-expands the whitespace run after a blockquote marker (tab stops
 * counted from the marker's own length) before stripping the marker plus one
 * whitespace char. If the line at `cur` has a quote marker followed by a run
 * containing a tab, rewrite the line with the run expanded and return true.
 */
function expandQuoteRunAt(lines, li, cur) {
  const c = curClone(cur);
  const startI = c.i;
  skipIndentUpTo(c, 3);
  if (curChar(c) !== '>') return false;
  curAdvance(c);
  const line = lines[li];
  let j = c.i;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j += 1;
  const run = line.slice(c.i, j);
  if (!run.includes('\t')) return false;
  let col = c.i - startI;
  let out = '';
  for (const ch of run) {
    if (ch === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else {
      out += ' ';
      col += 1;
    }
  }
  lines[li] = line.slice(0, c.i) + out + line.slice(j);
  return true;
}

function matchListMarker(cur) {
  if (curIndentCols(cur) > 3) return null;
  const c = curClone(cur);
  const lead = skipIndentUpTo(c, 3);
  const markerStartCol = c.col - lead;
  let ordered = false;
  let num = 0;
  let bullet = '';
  let delim = '';
  const ch = curChar(c);
  if (ch === '-' || ch === '+' || ch === '*') {
    bullet = ch;
    curAdvance(c);
  } else if (ch >= '0' && ch <= '9') {
    let digits = '';
    while (digits.length < 9) {
      const d = curChar(c);
      if (d < '0' || d > '9') break;
      digits += d;
      curAdvance(c);
    }
    const d = curChar(c);
    if (digits.length === 0 || (d !== '.' && d !== ')')) return null;
    ordered = true;
    num = parseInt(digits, 10);
    delim = d;
    curAdvance(c);
  } else return null;
  const markerWidth = c.col - markerStartCol - lead;
  const restBlank = curBlank(c);
  const sp = curIndentCols(c);
  if (restBlank) {
    return { ordered, num, bullet, delim, indent: lead + markerWidth + 1, end: c, hasContent: false, spAfter: 0, mw: markerWidth };
  }
  if (sp === 0) return null;
  const consume = sp <= 4 ? sp : 1;
  curConsumeCols(c, consume);
  return { ordered, num, bullet, delim, indent: lead + markerWidth + consume, end: c, hasContent: true, spAfter: sp, mw: markerWidth };
}

const BLOCK_TAGS = new Set((
  'address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt ' +
  'fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link ' +
  'main menu menuitem nav noframes ol optgroup option p param section summary table tbody td tfoot th thead title tr track ul'
).split(' '));

function matchHtmlStart(cur, forInterrupt) {
  if (curIndentCols(cur) > 3) return null;
  const c = curClone(cur);
  skipIndentUpTo(c, 3);
  const rest = curRest(c);
  if (rest[0] !== '<') return null;
  if (rest.startsWith('<!--')) return { type: 2 };
  if (rest.startsWith('<?')) return { type: 3 };
  if (rest.startsWith('<![CDATA[')) return { type: 5 };
  if (/^<![A-Z]/.test(rest)) return { type: 4 };
  const m1 = /^<(script|pre|style|textarea)(?=[ \t]|>|$)/i.exec(rest);
  if (m1) return { type: 1, tag: m1[1].toLowerCase() };
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) {
    const after = rest.slice(m[0].length);
    if (after === '' || after[0] === ' ' || after[0] === '\t' || after[0] === '>' || after.startsWith('/>')) {
      return { type: 6 };
    }
    return null;
  }
  if (!forInterrupt) {
    const tag = scanInlineHtml(rest, 0);
    if (tag && rest.slice(tag.length).trim() === '') {
      const tm = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
      if (tm && !BLOCK_TAGS.has(tm[1].toLowerCase())) return { type: 7 };
    }
  }
  return null;
}

function htmlEndMet(b, line) {
  switch (b.htmlType) {
    case 1: return new RegExp('</' + b.tag + '(?=[\\s>]|$)', 'i').test(line);
    case 2: return line.includes('-->');
    case 3: return line.includes('?>');
    case 4: return line.includes('>');
    case 5: return line.includes(']]>');
    default: return false;
  }
}

/**
 * Split a table row into trimmed cell texts, mirroring marked's splitCells:
 * a pipe preceded by an odd number of backslashes is escaped (kept, and the
 * backslash is later removed); any other pipe is a separator. Code spans
 * play no role. A leading/trailing empty cell is dropped.
 */
function splitRow(s) {
  let t = '';
  let bs = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      bs += 1;
      t += c;
      continue;
    }
    if (c === '|') {
      t += bs % 2 === 1 ? '|' : ' |';
      bs = 0;
      continue;
    }
    bs = 0;
    t += c;
  }
  const cells = t.split(' |');
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((x) => x.trim().replace(/\\\|/g, '|'));
}

/** If lines[li] + lines[li+1] form a table header + delimiter row, return { align, head }. */
function matchTableStart(lines, li) {
  if (li + 1 >= lines.length) return null;
  const headerLine = lines[li];
  const delimLine = lines[li + 1];
  if (!/[:|]/.test(delimLine)) return null;
  if (indentCols(headerLine, 0, 0) > 3 || indentCols(delimLine, 0, 0) > 3) return null;
  const head = splitRow(headerLine);
  const delim = splitRow(delimLine);
  if (delim.length !== head.length || head.length === 0) return null;
  const align = [];
  for (const cellText of delim) {
    if (!/^:?-+:?$/.test(cellText)) return null;
    const left = cellText.startsWith(':');
    const right = cellText.endsWith(':');
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return { align, head };
}

// --- Link reference definitions (extracted when a paragraph closes) ---------

function skipSpacesTabsStr(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return i;
}

function skipIndentUpToStr(s, i, max) {
  let cols = 0;
  let j = i;
  let col = 0;
  while (j < s.length && cols <= max) {
    const ch = s[j];
    if (ch === ' ') {
      cols += 1;
      col += 1;
      j += 1;
    } else if (ch === '\t') {
      const w = 4 - (col % 4);
      cols += w;
      col += w;
      j += 1;
    } else break;
  }
  return cols <= max ? j : -1;
}

/** Parse a link destination at s[i]: pointy or bare. Returns { raw, end } or null. */
function scanDestStr(s, i, allowEmpty) {
  const n = s.length;
  if (s[i] === '<') {
    let k = i + 1;
    let buf = '';
    while (k < n) {
      const c = s[k];
      if (c === '\\' && k + 1 < n && isAsciiPunct(s[k + 1])) { buf += c + s[k + 1]; k += 2; continue; }
      if (c === '>') return { raw: buf, end: k + 1 };
      if (c === '<' || c === '\n') return null;
      buf += c;
      k += 1;
    }
    return null;
  }
  let k = i;
  let depth = 0;
  let buf = '';
  while (k < n) {
    const c = s[k];
    if (c === '\\' && k + 1 < n && isAsciiPunct(s[k + 1])) { buf += c + s[k + 1]; k += 2; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c === '<') break;
    if (c === '(') { depth += 1; if (depth > 32) return null; buf += c; k += 1; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth -= 1;
      buf += c;
      k += 1;
      continue;
    }
    buf += c;
    k += 1;
  }
  if (depth !== 0) return null;
  if (buf === '' && !allowEmpty) return null;
  return { raw: buf, end: k };
}

/** Parse a link title at s[i] ("..." '...' or (...)). Returns { raw, end } or null. */
function scanTitleStr(s, i) {
  const open = s[i];
  if (open !== '"' && open !== "'" && open !== '(') return null;
  const close = open === '(' ? ')' : open;
  let k = i + 1;
  let buf = '';
  while (k < s.length) {
    const c = s[k];
    if (c === '\\' && k + 1 < s.length && isAsciiPunct(s[k + 1])) { buf += c + s[k + 1]; k += 2; continue; }
    if (c === close) return { raw: buf, end: k + 1 };
    if (open === '(' && c === '(') return null;
    buf += c;
    k += 1;
  }
  return null;
}

/** Try to parse one link reference definition at s[pos]. Returns { label, dest, title, end } or null. */
function parseDefAt(s, pos) {
  const n = s.length;
  let i = skipIndentUpToStr(s, pos, 3);
  if (i < 0 || s[i] !== '[') return null;
  let j = i + 1;
  let label = '';
  let closed = false;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) { label += c + s[j + 1]; j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') { closed = true; break; }
    label += c;
    j += 1;
  }
  if (!closed || label.length === 0) return null;
  if (s[j + 1] !== ':') return null;
  j += 2;
  j = skipSpacesTabsStr(s, j);
  if (s[j] === '\n') j = skipSpacesTabsStr(s, j + 1);
  const destRes = scanDestStr(s, j, false);
  if (!destRes) return null;
  j = destRes.end;
  // Optional title: on the same line after whitespace, or alone on the next line.
  let title = null;
  let k = skipSpacesTabsStr(s, j);
  if (k < n && s[k] !== '\n') {
    if (k === j) return null;
    const t = scanTitleStr(s, k);
    if (!t) return null;
    title = t.raw;
    k = skipSpacesTabsStr(s, t.end);
  } else if (k < n && s[k] === '\n') {
    const m = skipSpacesTabsStr(s, k + 1);
    if (m < n && (s[m] === '"' || s[m] === "'" || s[m] === '(')) {
      const t = scanTitleStr(s, m);
      if (t) {
        const after = skipSpacesTabsStr(s, t.end);
        if (after >= n || s[after] === '\n') {
          title = t.raw;
          k = after;
        }
        // Junk after a next-line title: the definition stands without the
        // title and the title line becomes paragraph text (marked).
      }
    }
  }
  if (k < n && s[k] !== '\n') return null;
  const normLabel = normalizeLabel(label);
  if (normLabel === '') return null; // a whitespace-only label is not a definition
  return {
    label: normLabel,
    dest: unescapePunct(destRes.raw),
    title: title === null ? null : unescapePunct(title),
    end: k,
  };
}

/** Extract leading link reference definitions from a paragraph's text. */
function extractDefs(para, defs) {
  const s = para.text;
  let pos = 0;
  for (;;) {
    const r = parseDefAt(s, pos);
    if (!r) break;
    if (!defs.has(r.label)) defs.set(r.label, { dest: r.dest, title: r.title });
    pos = r.end;
    if (pos < s.length && s[pos] === '\n') pos += 1;
  }
  if (pos > 0) {
    const rest = s.slice(pos);
    if (rest.trim() === '') para.remove = true;
    else para.text = rest;
  }
}

// ---------------------------------------------------------------------------
// Document parsing driver
// ---------------------------------------------------------------------------

/** First significant character of the line at `cur` (after up to 3 columns
 * of indent), or '' when the indent exceeds 3 columns or the line is blank.
 * Every block-start matcher's first character is fixed, so callers can
 * dispatch on this instead of trying every matcher. */
function sigChar(cur) {
  if (curIndentCols(cur) > 3) return '';
  const c = curClone(cur);
  skipIndentUpTo(c, 3);
  return curChar(c);
}

function isDigitCh(ch) {
  return ch >= '0' && ch <= '9';
}

/** True when the line at `cur` would start a block that may interrupt a paragraph. */
function startsInterruptingBlock(cur, inItem) {
  const ch = sigChar(cur);
  switch (ch) {
    case '`': case '~': return !!matchFence(cur);
    case '#': return !!matchAtx(cur);
    case '<': return !!matchHtmlStart(cur, true);
    case '>': return !!matchQuote(cur);
    case '_': return !!matchHr(cur);
    case '-': case '*':
      if (matchHr(cur)) return true;
      break;
    case '+':
      break;
    default:
      if (!isDigitCh(ch)) return false;
      break;
  }
  if (ch === '-' || ch === '*' || ch === '+' || isDigitCh(ch)) {
    const lm = matchListMarker(cur);
    // At the top level an ordered list interrupts only when it starts at 1;
    // inside a list item (marked lexes item text with top=false) any list
    // interrupts.
    if (lm && lm.hasContent && (!lm.ordered || lm.num === 1 || inItem)) return true;
  }
  return false;
}

/**
 * True when the line at `cur` starts any block, for the laziness test at a
 * failed container: there the open paragraph sits inside the failed container,
 * so the paragraph-interruption guard for lists (non-empty / starts at 1)
 * does not apply — any list marker counts (marked/CommonMark).
 */
/**
 * marked's list-item line collection breaks before a lazy line when the
 * item's previous line itself starts a fence, heading, HTML block or HR.
 * `lines`/`li` here are the raw source line array and the current index, so
 * the previous line is checked in its raw form (approximation of the
 * item-relative form marked sees).
 */
function prevLineStartsBlock(lines, li) {
  if (li <= 0) return false;
  const cur = newCur(lines[li - 1]);
  const ch = sigChar(cur);
  switch (ch) {
    case '`': case '~': return !!matchFence(cur);
    case '#': return !!matchAtx(cur);
    case '<': return !!matchHtmlStart(cur, true);
    case '-': case '*': case '_': return !!matchHr(cur);
    default: return false;
  }
}

function startsAnyBlock(cur) {
  const ch = sigChar(cur);
  switch (ch) {
    case '`': case '~': return !!matchFence(cur);
    case '#': return !!matchAtx(cur);
    case '<': return !!matchHtmlStart(cur, true);
    case '>': return !!matchQuote(cur);
    case '_': return !!matchHr(cur);
    case '-': case '*': return !!(matchHr(cur) || matchListMarker(cur));
    case '+': return !!matchListMarker(cur);
    default: return isDigitCh(ch) ? !!matchListMarker(cur) : false;
  }
}

function listCompatible(L, lm) {
  return L.ordered === lm.ordered && (lm.ordered ? L.delim === lm.delim : L.bullet === lm.bullet);
}

function parseDocument(lines, defs, endsWithNl) {
  const root = { t: 'doc', kids: [], startLine: 0, endLine: lines.length - 1 };
  const stack = [root];
  const blankSet = new Set();
  lines.forEach((l, idx) => {
    if (/^[ \t]*$/.test(l)) blankSet.add(idx);
  });
  // Lines that turned out structurally blank at a list item's own level
  // during parsing (not absorbed as code/HTML content, not shadowed by a
  // deeper blockquote). Drives list looseness the way marked computes it.
  const itemBlankLines = new Set();
  // Lines whose leading whitespace run has been tab-expanded (marked's list
  // collection expands before slicing); each line expands at most once.
  const expandedLines = new Set();
  // suffixContent[i] === true when some line at index >= i carries real
  // content (anything other than whitespace and '>' markers).
  const suffixContent = new Array(lines.length + 1).fill(false);
  for (let i = lines.length - 1; i >= 0; i--) {
    suffixContent[i] = suffixContent[i + 1] || /[^ \t>]/.test(lines[i]);
  }
  const tip = () => stack[stack.length - 1];

  function pushBlock(node) {
    node.parent = tip();
    tip().kids.push(node);
    stack.push(node);
    return node;
  }
  function addLeaf(node) {
    node.parent = tip();
    tip().kids.push(node);
    return node;
  }
  function closeBlock() {
    const b = stack.pop();
    if (b.kids && b.kids.length) {
      b.endLine = Math.max(b.endLine, b.kids[b.kids.length - 1].endLine);
    }
    finalizeBlock(b);
    return b;
  }
  function closeTo(depth) {
    while (stack.length > depth) closeBlock();
  }

  function finalizeBlock(b) {
    if (b.t === 'para') {
      extractDefs(b, defs);
      if (b.remove) {
        const p = b.parent;
        const ix = p.kids.indexOf(b);
        if (ix >= 0) p.kids.splice(ix, 1);
      }
    } else if (b.t === 'code') {
      if (!b.fenced) {
        while (b.lines.length && b.lines[b.lines.length - 1].trim() === '') b.lines.pop();
        b.text = b.lines.length ? b.lines.join('\n') + '\n' : '';
      } else {
        // marked: the newline before the closing fence (or the final
        // newline at EOF) is structural; the content keeps a trailing
        // newline only when its last line is non-empty.
        const last = b.lines[b.lines.length - 1];
        b.text = b.lines.length ? b.lines.join('\n') + (last !== '' ? '\n' : '') : '';
      }
    } else if (b.t === 'html') {
      // Text (incl. the trailing-newline decision) is computed in a post-pass
      // once the whole tree exists: marked keeps one trailing newline when a
      // non-blank line follows in the same container frame.
      b.text = b.lines.join('\n');
    } else if (b.t === 'list') {
      b.tight = computeTight(b);
    }
  }

  /** A list is loose when a structural blank line appears before its last block ends. */
  function computeTight(list) {
    const opaque = [];
    const walk = (node) => {
      for (const ch of node.kids || []) {
        if (ch.t === 'code' || ch.t === 'html' || ch.t === 'list') opaque.push([ch.startLine, ch.endLine]);
        else walk(ch);
      }
    };
    walk(list);
    const lastItem = list.kids[list.kids.length - 1];
    let lastEnd = list.startLine;
    if (lastItem) {
      lastEnd = lastItem.kids && lastItem.kids.length
        ? lastItem.kids[lastItem.kids.length - 1].endLine
        : lastItem.endLine;
    }
    for (let L = list.startLine + 1; L < lastEnd; L++) {
      if (!itemBlankLines.has(L)) continue;
      let inside = false;
      for (const [a, b] of opaque) {
        if (L >= a && L <= b) {
          inside = true;
          break;
        }
      }
      if (!inside) return false;
    }
    return true;
  }

  function addTableRow(b, rest) {
    const cells = splitRow(rest);
    while (cells.length < b.head.length) cells.push('');
    cells.length = b.head.length;
    b.rows.push(cells);
  }

  /** Phase 4: new block starts / paragraph continuation. Returns lines consumed (1 or 2). */
  function startsLoop(li, cur, ctx) {
    for (;;) {
      const tp = tip();
      if (tp.t === 'list') {
        const sch0 = sigChar(cur);
        if ((sch0 === '-' || sch0 === '*' || sch0 === '_') && matchHr(cur)) {
          closeBlock();
          continue;
        }
        const lm0 = (sch0 === '-' || sch0 === '*' || sch0 === '+' || isDigitCh(sch0)) ? matchListMarker(cur) : null;
        if (lm0 && listCompatible(tp, lm0)) {
          cur.i = lm0.end.i;
          cur.col = lm0.end.col;
          cur.debt = lm0.end.debt;
          pushBlock({ t: 'item', indent: lm0.indent, kids: [], startLine: li, endLine: li, _prev4: lm0.hasContent && lm0.spAfter + curIndentCols(cur) >= 4 });
          continue;
        }
        closeBlock();
        continue;
      }
      if (tp.t === 'para') {
        // A setext underline converts only when the line matched every open
        // container; a lazy underline stays literal paragraph text (marked).
        if (!ctx.lazy) {
          const sx = matchSetext(cur);
          if (sx) {
            // Definitions are stripped from the paragraph before the
            // remainder can become a heading (marked/CM).
            const preLen = tp.text.length;
            extractDefs(tp, defs);
            if (tp.remove) {
              closeBlock();
              pushBlock({ t: 'para', text: curRest(cur), startLine: li, endLine: li, segTextStart: 0, prevStripped: false });
              return 1;
            }
            if (tp.segTextStart > 0) {
              tp.segTextStart = Math.max(0, tp.segTextStart - (preLen - tp.text.length));
            }
            if (tp.segTextStart > 0 && tp.segTextStart < tp.text.length) {
              // marked re-lexes blockquote segments separately: only the
              // current segment's text becomes the heading.
              const headText = tp.text.slice(tp.segTextStart)
                .replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
              tp.text = tp.text.slice(0, tp.segTextStart - 1);
              tp.endLine = li - 1;
              closeBlock();
              addLeaf({ t: 'heading', level: sx.level, text: headText, kids: null, startLine: li, endLine: li });
              return 1;
            }
            tp.t = 'heading';
            tp.level = sx.level;
            tp.text = tp.text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
            tp.endLine = li;
            closeBlock();
            return 1;
          }
        }
        // Is the paragraph inside a list item (before any blockquote)?
        let inItem = false;
        for (let p = tp.parent; p; p = p.parent) {
          if (p.t === 'item') {
            inItem = true;
            break;
          }
          if (p.t === 'quote') break;
        }
        if (startsInterruptingBlock(cur, inItem)) {
          closeBlock();
          continue;
        }
        let lineText = curRest(cur);
        let stripped = false;
        if (ctx.lazy && (ctx.rewrite || inItem) && matchSetext(cur)) {
          // marked rewrites a lazy setext underline inside a blockquote
          // segment or a list item as indented paragraph text.
          lineText = '    ' + lineText.replace(/^[ \t]+/, '');
        } else if (ctx.lazy && (ctx.boundary || tp.prevStripped) && curIndentCols(cur) >= 4) {
          // marked merges an indented-code token at a blockquote segment
          // start into the paragraph, with the code indent removed.
          lineText = lineText.replace(/^(?: {0,3}\t| {1,4})/, '');
          stripped = true;
        } else if (inItem && curIndentCols(cur) >= 4) {
          // Item text is lexed line by line (top off): a line indented >= 4
          // becomes a code token that merges into the paragraph, its indent
          // removed (marked's codeRemoveIndent).
          lineText = lineText.replace(/^(?: {0,3}\t| {1,4})/, '');
        }
        tp.prevStripped = stripped;
        tp.text += '\n' + lineText;
        tp.endLine = li;
        return 1;
      }
      // Dispatch on the first significant character: each block-start
      // matcher has a fixed possible first character.
      const sch = sigChar(cur);
      if (sch === '`' || sch === '~') {
        const f = matchFence(cur);
        if (f) {
          pushBlock({ t: 'code', fenced: true, info: f.info, ch: f.ch, len: f.len, indent: f.indent, prefix: f.prefix, lines: [], startLine: li, endLine: li });
          return 1;
        }
      } else if (sch === '#') {
        const atx = matchAtx(cur);
        if (atx) {
          addLeaf({ t: 'heading', level: atx.level, text: atx.text, kids: null, startLine: li, endLine: li });
          return 1;
        }
      } else if (sch === '<') {
        const hs = matchHtmlStart(cur, false);
        if (hs) {
          const b = pushBlock({ t: 'html', htmlType: hs.type, tag: hs.tag, lines: [], startLine: li, endLine: li });
          const rest = curRest(cur);
          b.lines.push(rest);
          if (htmlEndMet(b, rest)) closeBlock();
          return 1;
        }
      } else if (sch === '>') {
        if (expandQuoteRunAt(lines, li, cur)) return 0;
        const q = matchQuote(cur);
        if (q) {
          cur.i = q.i;
          cur.col = q.col;
          cur.debt = q.debt;
          pushBlock({ t: 'quote', kids: [], startLine: li, endLine: li, prevLazy: false, _wasMarked: true });
          continue;
        }
      } else if (sch === '-' || sch === '*' || sch === '+' || sch === '_' || isDigitCh(sch)) {
        if (sch !== '+' && !isDigitCh(sch) && matchHr(cur)) {
          addLeaf({ t: 'hr', kids: null, startLine: li, endLine: li });
          return 1;
        }
        if (sch !== '_') {
          const lm = matchListMarker(cur);
          if (lm) {
            const L = pushBlock({ t: 'list', ordered: lm.ordered, start: lm.num, bullet: lm.bullet, delim: lm.delim, kids: [], startLine: li, endLine: li });
            cur.i = lm.end.i;
            cur.col = lm.end.col;
            cur.debt = lm.end.debt;
            pushBlock({ t: 'item', indent: lm.indent, kids: [], startLine: li, endLine: li, _prev4: lm.hasContent && lm.spAfter + curIndentCols(cur) >= 4 });
            continue;
          }
        }
      }
      if (tp.t === 'doc') {
        const ts = matchTableStart(lines, li);
        if (ts) {
          pushBlock({ t: 'table', align: ts.align, head: ts.head, rows: [], startLine: li, endLine: li + 1 });
          return 2;
        }
      }
      if (curIndentCols(cur) >= 4) {
        const b = pushBlock({ t: 'code', fenced: false, lines: [], startLine: li, endLine: li });
        curConsumeCols(cur, 4);
        b.lines.push(curRest(cur));
        return 1;
      }
      const rest0 = curRest(cur);
      if (rest0.trim() === '') return 1; // no paragraph for an empty content line
      pushBlock({ t: 'para', text: rest0, startLine: li, endLine: li, segTextStart: 0, prevStripped: false });
      return 1;
    }
  }

  /** Process one line; returns the number of lines consumed (1 or 2). */
  function processLine(li) {
    const rawLine = lines[li];
    let cur = newCur(rawLine);
    // Roll blockquote segment state: a quote whose marker was absent on the
    // previous line was "lazy" for that line (marked re-lexes quotes in
    // segments; see the setext rules in startsLoop).
    for (const b of stack) {
      if (b.t === 'quote') {
        b.prevLazy = b._wasMarked ? false : true;
        b._wasMarked = false;
      }
    }
    // Phase 1: match open containers.
    let failDepth = -1;
    let blank = false;
    for (let depth = 1; depth < stack.length; depth++) {
      const b = stack[depth];
      if (b.t === 'doc' || b.t === 'list') continue;
      if (b.t !== 'quote' && b.t !== 'item') break;
      if (curBlank(cur)) {
        blank = true;
        if (b.t === 'quote') {
          // A blank line without the marker ends the blockquote (marked).
          failDepth = depth;
        }
        // A list item matches a blank line trivially; keep scanning.
        if (failDepth !== -1) break;
        continue;
      }
      if (b.t === 'quote') {
        const save = curClone(cur);
        skipIndentUpTo(cur, 3);
        if (curCode(cur) === 62) {
          if (expandQuoteRunAt(lines, li, save)) return 0;
          curAdvance(cur);
          consumeOneSpace(cur);
          b._wasMarked = true;
        } else {
          cur = save;
          failDepth = depth;
          break;
        }
      } else if (b.sawBlankEmpty && b.kids.length === 0) {
        // An item that was empty and then met a blank line is finished: a
        // later content line does not belong to it (marked/CM).
        failDepth = depth;
        break;
      } else if (curIndentCols(cur) >= b.indent) {
        if (!expandedLines.has(li) && tabInLeadingRun(lines[li])) {
          // marked's list collection tab-expands the line's leading
          // whitespace run before slicing off item indents; rewrite the
          // line and restart its processing on the expanded form.
          lines[li] = expandLeadingRun(lines[li]);
          expandedLines.add(li);
          return 0;
        }
        curConsumeCols(cur, b.indent);
        b._prev4 = !curBlank(cur) && curIndentCols(cur) >= 4;
      } else {
        failDepth = depth;
        break;
      }
    }
    let lazyAbsorb = false;
    if (failDepth !== -1) {
      if (blank) {
        closeTo(failDepth);
      } else {
        let isLazy = tip().t === 'para' && !startsAnyBlock(cur);
        let deepItem = null;
        if (isLazy) {
          // marked ends an item's line collection before a lazy line when
          // the item's previous line was itself indented >= 4 (a code line).
          for (let p = tip().parent; p; p = p.parent) {
            if (p.t === 'item') {
              deepItem = p;
              break;
            }
          }
          if (deepItem && deepItem._prev4) isLazy = false;
        }
        if (isLazy) {
          lazyAbsorb = true;
          if (deepItem) deepItem._prev4 = false;
        } else if (
          (tip().t === 'code' || tip().t === 'html') &&
          !startsAnyBlock(cur) &&
          !prevLineStartsBlock(lines, li) &&
          stack.slice(failDepth, stack.length - 1).every((b) => b.t === 'item' || b.t === 'list')
        ) {
          // A fence/code/html leaf inside a list item also absorbs a lazy
          // (under-indented) line: marked's item collection gathers the line
          // verbatim unless it starts another block or the item's previous
          // line was itself indented >= 4.
          const failItem = stack.slice(failDepth, stack.length - 1).find((b) => b.t === 'item');
          if (!(failItem && failItem._prev4)) {
            lazyAbsorb = true;
          } else {
            closeTo(failDepth);
          }
        } else {
          closeTo(failDepth);
        }
      }
    }
    // Blockquote segment bookkeeping for the tip paragraph (marked's
    // blockquote tokenizer re-lexes in segments: a lazy line right after a
    // marked line starts a new segment).
    const ctx = { lazy: lazyAbsorb, rewrite: false, boundary: false };
    if (lazyAbsorb && tip().t === 'para') {
      let q = tip().parent;
      while (q && q.t !== 'quote') q = q.parent;
      if (q && !q._wasMarked) {
        if (q.prevLazy) {
          ctx.rewrite = true;
        } else {
          const tp = tip();
          tp.segTextStart = tp.text.length + 1;
          ctx.boundary = true;
        }
      }
    }
    // A whitespace-only line at the very end of the (sub)document is
    // paragraph content in marked, not a blank line: at doc level when it is
    // the last line without a trailing newline; inside a blockquote whenever
    // no content line follows (the quote capture is right-trimmed).
    let wsContent = false;
    if ((blank || curBlank(cur)) && tip().t === 'para') {
      let inQuote = false;
      for (let p = tip().parent; p; p = p.parent) {
        if (p.t === 'quote') {
          inQuote = true;
          break;
        }
      }
      if (inQuote ? !suffixContent[li + 1] : li === lines.length - 1 && !endsWithNl) wsContent = true;
    }
    if ((blank || curBlank(cur)) && !wsContent) {
      const tp = tip();
      if (tp.t === 'table' && !/^ *$/.test(curRest(cur))) {
        // marked's table body treats only space-only lines as blank; a line
        // containing a tab is a (possibly all-empty) body row.
        addTableRow(tp, curRest(cur));
        tp.endLine = li;
        return 1;
      }
      if (tp.t === 'code') {
        if (tp.fenced) {
          tp.lines.push(fenceContentLine(tp, curRest(cur)));
          tp.endLine = li;
        } else if (curIndentCols(cur) >= 4) {
          const c2 = curClone(cur);
          curConsumeCols(c2, 4);
          tp.lines.push(curRest(c2));
          tp.endLine = li;
        } else {
          tp.lines.push('');
        }
        return 1;
      }
      if (tp.t === 'html' && tp.htmlType <= 5) {
        tp.lines.push('');
        tp.endLine = li;
        return 1;
      }
      // Looseness bookkeeping: the blank counts for a list when the deepest
      // item ancestor of the tip is not shadowed by a deeper blockquote.
      {
        let seenItem = null;
        let seenQuote = null;
        for (let p = tip(); p; p = p.parent) {
          if (p.t === 'item' && !seenItem) seenItem = p;
          if (p.t === 'quote' && !seenQuote) seenQuote = p;
        }
        if (seenItem && (!seenQuote || stack.indexOf(seenItem) > stack.indexOf(seenQuote))) {
          itemBlankLines.add(li);
        }
      }
      for (const b of stack) {
        if (b.t === 'item') b._prev4 = false;
      }
      if (tp.t === 'item' && tp.kids.length === 0) tp.sawBlankEmpty = true;
      if (tp.t === 'html') {
        tp.endByBlank = true;
        closeBlock();
      }
      if (tip().t === 'para') closeBlock();
      if (tip().t === 'table') closeBlock();
      return 1;
    }
    // Phase 3: leaf continuations.
    let tp = tip();
    if (tp.t === 'code' && tp.fenced) {
      if (isFenceClose(cur, tp)) {
        tp.endLine = li;
        closeBlock();
        return 1;
      }
      tp.lines.push(fenceContentLine(tp, curRest(cur)));
      tp.endLine = li;
      return 1;
    }
    if (tp.t === 'code') {
      if (curIndentCols(cur) >= 4) {
        curConsumeCols(cur, 4);
        tp.lines.push(curRest(cur));
        tp.endLine = li;
        return 1;
      }
      closeBlock();
      tp = tip();
    }
    if (tp.t === 'html') {
      const rest = curRest(cur);
      tp.lines.push(rest);
      tp.endLine = li;
      if (htmlEndMet(tp, rest)) closeBlock();
      return 1;
    }
    if (tp.t === 'table') {
      const rest = curRest(cur);
      // Body rows need no pipe (cells are padded), but a line that starts
      // another block ends the table.
      if (!startsAnyBlock(cur)) {
        addTableRow(tp, rest);
        tp.endLine = li;
        return 1;
      }
      closeBlock();
    }
    // Phase 4.
    return startsLoop(li, cur, ctx);
  }

  let li = 0;
  while (li < lines.length) {
    li += processLine(li);
  }
  closeTo(1);
  return root;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function alignAttr(a) {
  return a ? ' align="' + a + '"' : '';
}

function renderTable(b, defs) {
  let out = '<table>\n<thead>\n<tr>\n';
  b.head.forEach((cell, idx) => {
    out += '<th' + alignAttr(b.align[idx]) + '>' + renderInline(cell, defs) + '</th>\n';
  });
  out += '</tr>\n</thead>\n';
  if (b.rows.length) {
    out += '<tbody>';
    for (const row of b.rows) {
      out += '<tr>\n';
      row.forEach((cell, idx) => {
        out += '<td' + alignAttr(b.align[idx]) + '>' + renderInline(cell, defs) + '</td>\n';
      });
      out += '</tr>\n';
    }
    out += '</tbody></table>\n';
  } else {
    out += '</table>\n';
  }
  return out;
}

function renderItem(item, list, defs) {
  let content = '';
  const kids = item.kids;
  let taskHtml = '';
  if (kids.length && kids[0].t === 'para') {
    const m = /^\[([ xX])\] /.exec(kids[0].text);
    if (m && kids[0].text.slice(4).trim() !== '') {
      taskHtml = m[1] === ' '
        ? '<input disabled="" type="checkbox"> '
        : '<input checked="" disabled="" type="checkbox"> ';
      kids[0].text = kids[0].text.slice(4);
    }
  }
  kids.forEach((child, idx) => {
    if (child.t === 'para' && list.tight) {
      content += (idx === 0 ? taskHtml : '') + renderInline(child.text, defs);
    } else if (child.t === 'para' && idx === 0 && taskHtml) {
      content += '<p>' + taskHtml + renderInline(child.text, defs) + '</p>\n';
    } else {
      content += renderBlock(child, defs);
    }
  });
  return '<li>' + content + '</li>\n';
}

function renderBlock(b, defs) {
  switch (b.t) {
    case 'doc': {
      let out = '';
      for (const k of b.kids) out += renderBlock(k, defs);
      return out;
    }
    case 'para':
      return '<p>' + renderInline(b.text, defs) + '</p>\n';
    case 'heading':
      return '<h' + b.level + '>' + renderInline(b.text, defs) + '</h' + b.level + '>\n';
    case 'code': {
      const lang = b.fenced && b.info ? unescapePunct(b.info.split(/\s+/)[0]) : '';
      return '<pre><code' + (lang ? ' class="language-' + escHtml(lang, false) + '"' : '') + '>' +
        escHtml(b.text, true) + '</code></pre>\n';
    }
    case 'html':
      return b.text;
    case 'hr':
      return '<hr>\n';
    case 'quote': {
      let out = '<blockquote>\n';
      for (const k of b.kids) out += renderBlock(k, defs);
      return out + '</blockquote>\n';
    }
    case 'list': {
      let items = '';
      for (const k of b.kids) items += renderItem(k, b, defs);
      if (b.ordered) {
        return '<ol' + (b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n' + items + '</ol>\n';
      }
      return '<ul>\n' + items + '</ul>\n';
    }
    case 'table':
      return renderTable(b, defs);
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
// marked leaks its inline lexer's inLink state across inline runs: an
// unclosed <a> tag anywhere suppresses bare (extended) autolinks for the
// rest of the document, until a </a> tag appears. Reset per document.
let inlineLinkLeak = false;
let inlineLinkEmitted = false;
let inlineRawBlock = false;

/** Post-pass: HTML block trailing newline (marked's ge() normalization). */
function fixHtmlTrailing(b, parent, endsWithNl, lines) {
  if (b.t === 'html') {
    let trailing = '';
    if (b.endByBlank) {
      // Blocks that end AT a blank line (types 6/7) include that blank in
      // marked's ge() text computation, which slices it away together with
      // the final newline: the text never gains a trailing newline.
      b.text = b.lines.join('\n');
      if (b.kids) for (const k of b.kids) fixHtmlTrailing(k, b, endsWithNl, lines);
      return;
    }
    const sibs = parent ? parent.kids : [];
    const ix = sibs.indexOf(b);
    const next = ix >= 0 ? sibs[ix + 1] : undefined;
    if (next && next.startLine === b.endLine + 1) {
      trailing = '\n';
    } else if (next) {
      // Blank line(s) between this block and the next sibling: marked
      // merges a following space token of raw '\n' (an exactly-empty blank
      // line) into the html token, and ge() then strips the trailing
      // newline; a blank line containing spaces/tabs does not merge, so
      // the newline survives.
      const firstBlank = lines ? lines[b.endLine + 1] : undefined;
      if (firstBlank !== undefined && firstBlank.replace(/>/g, '') !== '') {
        trailing = '\n';
      }
    } else if (!next) {
      // Globally last block (every ancestor is a last child) + source
      // newline at EOF keeps one trailing newline.
      let n = b;
      let p = parent;
      let last = true;
      while (p) {
        if (p.kids[p.kids.length - 1] !== n) {
          last = false;
          break;
        }
        n = p;
        p = p.parent;
      }
      if (last && endsWithNl) trailing = '\n';
    }
    b.text = b.lines.join('\n') + trailing;
  }
  if (b.kids) {
    for (const k of b.kids) fixHtmlTrailing(k, b, endsWithNl, lines);
  }
}

export function parse(markdown) {
  const rawSrc = String(markdown);
  const src = rawSrc.includes('\r') ? rawSrc.replace(/\r\n?/g, '\n') : rawSrc;
  const endsWithNl = src.endsWith('\n');
  const lines = src.split('\n');
  if (endsWithNl) lines.pop();
  const defs = new Map();
  inlineLinkLeak = false;
  inlineLinkEmitted = false;
  inlineRawBlock = false;
  const doc = parseDocument(lines, defs, endsWithNl);
  fixHtmlTrailing(doc, null, endsWithNl, lines);
  return renderBlock(doc, defs);
}
