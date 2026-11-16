// A Markdown -> HTML renderer matching marked 18.1.3 (default options:
// gfm true, breaks false, pedantic false) byte-for-byte, written from
// scratch against the CommonMark 0.31.2 + GFM behaviour the reference
// exhibits. Dependency-free ES module: export function parse(markdown).

// ------------------------------------------------------------- entities


// Decode a numeric entity body (the part between &# and ;) to a
// character. Out-of-range values are not entities at all (null);
// zero and surrogates become the replacement character.
function decodeNumericEntity(body) {
  let cp;
  if (body[0] === 'x' || body[0] === 'X') {
    cp = parseInt(body.slice(1), 16);
  } else {
    cp = parseInt(body, 10);
  }
  if (Number.isNaN(cp) || cp > 0x10ffff) return null;
  if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
  return String.fromCodePoint(cp);
}

// Try to read a NUMERIC entity reference at s[i] === '&'. Returns
// { ch, len } with the decoded character, or null when the reference
// is malformed or out of range.
function readEntity(s, i) {
  const m = /^&#([xX][0-9a-fA-F]+|[0-9]+);/.exec(s.slice(i));
  if (!m) return null;
  const ch = decodeNumericEntity(m[1]);
  return ch === null ? null : { ch, len: m[0].length };
}

// ------------------------------------------------------------- escaping

function escapeCharForText(ch) {
  if (ch === '&') return '&amp;';
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === '"') return '&quot;';
  if (ch === "'") return '&#39;';
  return ch;
}

// Escape text or an attribute value, the way marked does: numeric
// character references are decoded (and the resulting character
// escaped if special); any &name; -shaped sequence passes through
// verbatim, defined or not; a bare & becomes &amp;.
function escapeText(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '&') {
      const ent = readEntity(s, i);
      if (ent) {
        out += escapeCharForText(ent.ch);
        i += ent.len;
        continue;
      }
      const named = /^&[a-zA-Z][a-zA-Z0-9]*;/.exec(s.slice(i));
      if (named) {
        out += named[0];
        i += named[0].length;
        continue;
      }
      out += '&amp;';
      i++;
      continue;
    }
    if (c === '<' || c === '>' || c === '"' || c === "'") {
      out += escapeCharForText(c);
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Escape code content: everything is literal.
function escapeFull(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ------------------------------------------------------------- small helpers

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

function isPunct(ch) {
  return ch !== undefined && ASCII_PUNCT.has(ch);
}

const SPACE_RE = /\s/;
function isSpace(ch) {
  // string boundaries count as whitespace for flanking purposes
  return ch === undefined || SPACE_RE.test(ch);
}

const PUNCT_RE = /[\p{P}\p{S}]/u;
function isUnicodePunct(ch) {
  return ch !== undefined && PUNCT_RE.test(ch);
}

// Resolve backslash escapes of ASCII punctuation.
function unescapeBackslash(text) {
  return text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])/g, '$1');
}

// Reference labels: whitespace collapsed, matched with Unicode full
// case folding (ß -> ss, ligatures unfold); backslash escapes are NOT
// resolved for matching.
function normalizeLabel(label) {
  return label
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ﬀ/g, 'ff')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi')
    .replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st')
    .replace(/ﬆ/g, 'st');
}

// Clean a link destination the way marked does before it lands in an
// href/src attribute: percent-encode it, then undo the encoding of
// literal % characters (so existing %XX escapes survive).
function cleanUrl(url) {
  try {
    return encodeURI(url).replace(/%25/g, '%');
  } catch {
    return url;
  }
}

// ------------------------------------------------------------- line geometry

// The first line of src (without its newline).
function firstLineOf(src) {
  const nl = src.indexOf('\n');
  return nl === -1 ? src : src.slice(0, nl);
}

function isBlankLine(line) {
  return /^[ \t]*$/.test(line);
}

// Measure the leading indentation of a line starting at column `base`.
// Returns { cols, chars }: columns of indentation and characters used.
function indentColumns(line, base) {
  let cols = 0;
  let chars = 0;
  while (chars < line.length) {
    const c = line[chars];
    if (c === ' ') {
      cols++;
      chars++;
    } else if (c === '\t') {
      cols += 4 - ((base + cols) % 4);
      chars++;
    } else break;
  }
  return { cols, chars };
}

// Expand the leading whitespace run of a line to spaces (tabs become
// the spaces up to the next multiple-of-4 column), keeping the rest of
// the line untouched.
function expandLeadingWs(line) {
  let out = '';
  let cols = 0;
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') {
      out += ' ';
      cols++;
      i++;
    } else {
      const w = 4 - (cols % 4);
      out += ' '.repeat(w);
      cols += w;
      i++;
    }
  }
  return out + line.slice(i);
}

// Remove the first n columns of indentation from a line. The leading
// whitespace run is expanded to spaces at its original column widths
// first, so a tab straddling the cut leaves its remainder as spaces
// and later indentation math sees the source's true geometry.
function stripColumns(line, n) {
  const expanded = expandLeadingWs(line);
  let cols = 0;
  let i = 0;
  while (i < expanded.length && cols < n && expanded[i] === ' ') {
    cols++;
    i++;
  }
  return expanded.slice(i);
}

// Remove up to n columns of leading indentation, keeping the rest of
// the line byte-for-byte (a straddling tab leaves its remainder as
// spaces). Used where the stripped text is final content (code lines),
// so tabs that survive the cut stay tabs.
function stripIndentRaw(line, n) {
  let cols = 0;
  let i = 0;
  while (i < line.length && cols < n) {
    const c = line[i];
    if (c === ' ') {
      cols++;
      i++;
    } else if (c === '\t') {
      const w = 4 - (cols % 4);
      if (cols + w > n) return ' '.repeat(cols + w - n) + line.slice(i + 1);
      cols += w;
      i++;
    } else break;
  }
  return line.slice(i);
}

// Drop the first n columns of a line regardless of the characters in
// that range (used for a list item's first line, where the marker
// itself occupies columns). Tabs in the surviving leading whitespace
// are expanded to spaces at their original column widths.
function dropColumns(line, n) {
  let cols = 0;
  let i = 0;
  let prefix = '';
  while (i < line.length && cols < n) {
    if (line[i] === '\t') {
      const w = 4 - (cols % 4);
      if (cols + w > n) {
        prefix = ' '.repeat(cols + w - n);
        cols += w;
        i++;
        break;
      }
      cols += w;
      i++;
    } else {
      cols += 1;
      i++;
    }
  }
  let out = prefix;
  let col = cols;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') {
      out += ' ';
      col += 1;
      i++;
    } else {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      i++;
    }
  }
  return out + line.slice(i);
}

// ------------------------------------------------------------- HTML tags

const TAG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]*/;
const ATTR_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_.:-]*/;

// Parse an HTML tag at the start of s (s[0] === '<'). Returns the length
// of the tag or null.
function parseTag(s) {
  let i = 1;
  let closing = false;
  if (s[i] === '/') { closing = true; i++; }
  const nm = TAG_NAME_RE.exec(s.slice(i));
  if (!nm) return null;
  i += nm[0].length;
  if (closing) {
    // a closing tag allows only whitespace before the '>'
    while (s[i] === ' ' || s[i] === '\t' || s[i] === '\n') i++;
    return s[i] === '>' ? i + 1 : null;
  }
  // attributes
  for (;;) {
    let j = i;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j === i) break; // no whitespace: no attribute follows
    const an = ATTR_NAME_RE.exec(s.slice(j));
    if (!an) { i = j; break; }
    let k = j + an[0].length;
    let l = k;
    while (l < s.length && (s[l] === ' ' || s[l] === '\t')) l++;
    if (s[l] === '=') {
      l++;
      while (l < s.length && (s[l] === ' ' || s[l] === '\t')) l++;
      const q = s[l];
      if (q === '"' || q === "'") {
        const end = s.indexOf(q, l + 1);
        if (end === -1) return null;
        l = end + 1;
      } else {
        const vm = /^[^ \t\n"'=<>`]+/.exec(s.slice(l));
        if (!vm) return null;
        l += vm[0].length;
      }
      k = l;
    }
    i = k;
  }
  while (s[i] === ' ' || s[i] === '\t' || s[i] === '\n') i++;
  if (s[i] === '/') i++;
  return s[i] === '>' ? i + 1 : null;
}

function isCompleteTag(s) {
  return parseTag(s) !== null;
}

// Length of the inline HTML construct at the start of rest (which
// starts with '<'), or 0 if there is none.
function inlineHtmlLength(rest) {
  if (rest.startsWith('<!--')) {
    // abrupt closings are complete comments on their own
    if (rest.startsWith('<!-->')) return 5;
    if (rest.startsWith('<!--->')) return 6;
    const end = rest.indexOf('-->');
    return end === -1 ? 0 : end + 3;
  }
  if (rest.startsWith('<![CDATA[')) {
    const end = rest.indexOf(']]>');
    return end === -1 ? 0 : end + 3;
  }
  if (rest.startsWith('<?')) {
    const end = rest.indexOf('?>');
    return end === -1 ? 0 : end + 2;
  }
  if (/^<![a-zA-Z]/.test(rest)) {
    const end = rest.indexOf('>');
    return end === -1 ? 0 : end + 1;
  }
  if (rest[1] === '!') return 0;
  const tag = parseTag(rest);
  return tag === null ? 0 : tag;
}

// Strip up to n columns of fence indentation: spaces count one
// column each; a tab that the cut reaches is removed whole, even
// when only part of its width falls inside the cut.
function stripFenceIndent(line, n) {
  let cols = 0;
  let i = 0;
  while (i < line.length && cols < n) {
    const c = line[i];
    if (c === ' ') {
      cols++;
      i++;
    } else if (c === '\t') {
      cols += 4 - (cols % 4);
      i++;
    } else break;
  }
  return line.slice(i);
}

// ------------------------------------------------------------- fenced code

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n]*)(?:\n|$)/;

function lexFence(src) {
  const m = FENCE_RE.exec(src);
  if (!m) return null;
  const fence = m[1];
  const info = m[2];
  if (fence[0] === '`' && info.includes('`')) return null;
  const indent = /^ */.exec(m[0])[0].length;
  let len = m[0].length;
  const contentLines = [];
  let rest = src.slice(len);
  let closed = false;
  while (rest.length) {
    const line = firstLineOf(rest);
    const lineLen = line.length + (rest.length > line.length ? 1 : 0);
    const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (cm && cm[1][0] === fence[0] && cm[1].length >= fence.length) {
      len += lineLen;
      closed = true;
      break;
    }
    contentLines.push(stripFenceIndent(line, indent));
    len += lineLen;
    rest = rest.slice(lineLen);
  }
  const lang = unescapeBackslash(info.trim()).split(/\s+/)[0] || '';
  let text = contentLines.length ? contentLines.join('\n') + '\n' : '';
  // A closed fence's content loses exactly one trailing newline (the
  // one ending the last content line); the renderer restores it when
  // the text does not already end with one.
  if (closed && text.endsWith('\n')) text = text.slice(0, -1);
  return { tokens: [{ type: 'code', text, lang }], len };
}

// ------------------------------------------------------------- ATX headings

function lexHeading(src) {
  const line = firstLineOf(src);
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
  if (!m) return null;
  let text = m[2] === undefined ? '' : m[2];
  text = text.replace(/[ \t]+$/, '');
  if (/^#+$/.test(text)) text = '';
  else text = text.replace(/[ \t]+#+$/, '').replace(/[ \t]+$/, '');
  const len = line.length + (src.length > line.length ? 1 : 0);
  return { tokens: [{ type: 'heading', depth: m[1].length, text }], len };
}

// ------------------------------------------------------------- thematic break

const HR_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/;

function lexHr(src) {
  const line = firstLineOf(src);
  if (!HR_RE.test(line)) return null;
  const len = line.length + (src.length > line.length ? 1 : 0);
  return { tokens: [{ type: 'hr' }], len };
}

// ------------------------------------------------------------- indented code

function lexIndentedCode(src) {
  // At a block boundary: lines indented by 4+ columns. Whitespace-only
  // lines are blank separators: they join the content (with any excess
  // indentation kept) only when more code follows; leading and trailing
  // ones are not content, and trailing ones are not consumed either.
  const lines = [];
  let len = 0;
  let endLen = 0;
  let rest = src;
  let pendingBlanks = [];
  let sawCode = false;
  while (rest.length) {
    const line = firstLineOf(rest);
    const lineLen = line.length + (rest.length > line.length ? 1 : 0);
    const ind = indentColumns(line, 0);
    if (ind.cols >= 4 && line.trim() !== '') {
      for (const b of pendingBlanks) lines.push(b);
      pendingBlanks = [];
      lines.push(stripIndentRaw(line, 4));
      sawCode = true;
      len += lineLen;
      endLen = len;
      rest = rest.slice(lineLen);
      continue;
    }
    if (isBlankLine(line)) {
      pendingBlanks.push(stripIndentRaw(line, 4));
      len += lineLen;
      rest = rest.slice(lineLen);
      continue;
    }
    break;
  }
  if (!sawCode) return null;
  const text = lines.join('\n') + '\n';
  return { tokens: [{ type: 'code', text, lang: '' }], len: endLen };
}

// ------------------------------------------------------------- HTML blocks

const HTML_BLOCK_TAGS = new Set((
  'address article aside base basefont blockquote body caption center col ' +
  'colgroup dd details dialog dir div dl dt fieldset figcaption figure ' +
  'footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html ' +
  'iframe legend li link main menu menuitem nav noframes ol optgroup ' +
  'option p param section source summary table tbody td tfoot th thead ' +
  'title tr track ul'
).split(' '));

// Which HTML block flavour starts on this line? 0 = none, else 1..7.
function htmlBlockStart(line) {
  const ind = indentColumns(line, 0);
  if (ind.cols > 3) return 0;
  const rest = line.slice(ind.chars);
  if (!rest.startsWith('<')) return 0;
  if (/^<(script|pre|style|textarea)(?=[\s>]|$)/i.test(rest)) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![a-zA-Z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  const tm = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest);
  if (tm && HTML_BLOCK_TAGS.has(tm[1].toLowerCase())) {
    const after = rest.slice(tm[0].length);
    if (/^[\s>]/.test(after) || after === '' || after.startsWith('/>')) return 6;
  }
  // type 7: the line consists of exactly one complete tag
  const tagLen = parseTag(rest);
  if (tagLen !== null && /^[ \t]*$/.test(rest.slice(tagLen))) return 7;
  return 0;
}

function lexHtmlBlock(src) {
  const first = firstLineOf(src);
  const type = htmlBlockStart(first);
  if (type === 0) return null;
  if (type === 1 || (type >= 2 && type <= 5)) {
    // The block runs until the line carrying its terminator (the close
    // tag for type 1, the flavour's terminator string otherwise); text
    // after the terminator on that line belongs to the block too.
    let isTerminated;
    if (type === 1) {
      const name = /^ {0,3}<(script|pre|style|textarea)/i.exec(first)[1];
      const closeRe = new RegExp('</' + name, 'i');
      isTerminated = (line) => closeRe.test(line);
    } else {
      const term = type === 2 ? '-->' : type === 3 ? '?>' : type === 4 ? '>' : ']]>';
      isTerminated = (line, acc) => (acc + line).includes(term);
    }
    let len = 0;
    let rest = src;
    const lines = [];
    let acc = '';
    while (rest.length) {
      const line = firstLineOf(rest);
      const ll = line.length + (rest.length > line.length ? 1 : 0);
      lines.push(line);
      len += ll;
      rest = rest.slice(ll);
      if (isTerminated(line, acc)) break;
      acc += line + '\n';
    }
    // Text rule: when a truly empty line follows, the block's
    // trailing newline is dropped; otherwise (including tab-only
    // and spaces-only lines) the verbatim slice stands.
    let text;
    if (rest.length && firstLineOf(rest) === '') text = lines.join('\n');
    else text = src.slice(0, len);
    return { tokens: [{ type: 'html', text }], len };
  }
  // types 6 and 7: run until a blank line
  let len = 0;
  let rest = src;
  const lines = [];
  while (rest.length) {
    const line = firstLineOf(rest);
    if (isBlankLine(line)) break;
    lines.push(line);
    const ll = line.length + (rest.length > line.length ? 1 : 0);
    len += ll;
    rest = rest.slice(ll);
  }
  // at EOF the trailing newline is kept; before a blank line it is not
  const text = rest.length ? lines.join('\n') : src.slice(0, len);
  return { tokens: [{ type: 'html', text }], len };
}

// ------------------------------------------------------------- blockquote

// Strip a blockquote marker ('>' plus one optional space column) from
// a line. Returns the content or null when the line has no marker.
function stripQuotePrefix(line) {
  const ind = indentColumns(line, 0);
  if (ind.cols > 3) return null;
  if (line[ind.chars] !== '>') return null;
  const next = line[ind.chars + 1];
  const hasSpace = next === ' ' || next === '\t';
  // the prefix is the indentation + '>' + one optional space column;
  // dropping that many columns (with tab expansion) yields the content
  return dropColumns(line, ind.cols + 1 + (hasSpace ? 1 : 0));
}

function lexBlockquote(src, links, inList = false) {
  let rest = src;
  let len = 0;
  const contentLines = [];
  const lazyIdx = new Set();
  let seenLazy = false;
  while (rest.length) {
    const line = firstLineOf(rest);
    const lineLen = line.length + (rest.length > line.length ? 1 : 0);
    const stripped = stripQuotePrefix(line);
    if (stripped !== null) {
      contentLines.push(stripped);
      seenLazy = false;
      len += lineLen;
      rest = rest.slice(lineLen);
      continue;
    }
    // Lines without the marker: only lazy paragraph continuations join.
    if (isBlankLine(line)) break;
    if (!contentLines.length) break;
    if (contentLines[contentLines.length - 1].trim() === '') break;
    if (!contentEndsWithParagraph(contentLines.join('\n'), links, lazyIdx, inList)) break;
    if (isSetextUnderline(line)) {
      // A setext underline directly after a marked line ends the quote
      // (it becomes a thematic break outside). After a lazy line it is
      // absorbed literally, defused with a 4-space indent.
      if (!seenLazy) break;
      contentLines.push('    ' + line.trim());
      len += lineLen;
      rest = rest.slice(lineLen);
      continue;
    }
    if (matchItemStart(line)) break;
    if (/^ {0,3}\[[^\]]*\]:/.test(line)) break;
    const after = rest.slice(lineLen);
    if (interruptsParagraph(line, firstLineOf(after))) break;
    lazyIdx.add(contentLines.length);
    contentLines.push(line);
    seenLazy = true;
    len += lineLen;
    rest = rest.slice(lineLen);
  }
  if (!contentLines.length) return null;
  const inner = lexBlocks(contentLines.join('\n'), links, lazyIdx, inList);
  return { tokens: [{ type: 'blockquote', tokens: inner }], len };
}

// ------------------------------------------------------------- link definitions

// Parse a link reference definition at the start of src. On success the
// definition is registered in `links` and { len } is returned (the
// definition itself produces no token).
function lexDef(src, links) {
  let i = 0;
  const ind = indentColumns(src, 0);
  if (ind.cols > 3) return null;
  i = ind.chars;
  if (src[i] !== '[') return null;
  // label: up to an unescaped ']', may span lines but not a blank line
  let j = i + 1;
  let label = '';
  let closed = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\' && j + 1 < src.length) {
      label += c + src[j + 1];
      j += 2;
      continue;
    }
    if (c === ']') { closed = true; break; }
    if (c === '[') return null;
    if (c === '\n') {
      // a blank line ends the label attempt
      let k = j + 1;
      while (src[k] === ' ' || src[k] === '\t') k++;
      if (src[k] === '\n' || k >= src.length) return null;
    }
    label += c;
    j++;
  }
  if (!closed || label.trim() === '') return null;
  j++; // past ]
  if (src[j] !== ':') return null;
  j++;
  // optional whitespace (may include ONE newline)
  let newlines = 0;
  while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) {
    if (src[j] === '\n') {
      newlines++;
      if (newlines > 1) return null;
    }
    j++;
  }
  // destination
  let dest = '';
  if (src[j] === '<') {
    let k = j + 1;
    let ok = false;
    while (k < src.length) {
      const c = src[k];
      if (c === '\\' && k + 1 < src.length) { dest += c + src[k + 1]; k += 2; continue; }
      if (c === '>') { ok = true; break; }
      if (c === '<' || c === '\n') return null;
      dest += c;
      k++;
    }
    if (!ok) return null;
    j = k + 1;
  } else {
    // bare destination: no spaces, balanced parentheses
    let depth = 0;
    let k = j;
    while (k < src.length) {
      const c = src[k];
      if (c === '\\' && k + 1 < src.length) { dest += c + src[k + 1]; k += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === '(') depth++;
      if (c === ')') {
        depth--;
        if (depth < 0) return null;
      }
      if (c.charCodeAt(0) < 0x20) return null;
      dest += c;
      k++;
    }
    if (depth !== 0 || dest === '') return null;
    j = k;
  }
  const destLineEnd = (() => {
    const nl = src.indexOf('\n', j);
    return nl === -1 ? src.length : nl;
  })();
  // optional title on the rest of the destination line (it must be
  // separated from the destination by whitespace)
  let title = null;
  let k = j;
  while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
  if (k < src.length && src[k] !== '\n') {
    if (k === j) return null; // e.g. <bar>(baz): not a title, junk
    const t = parseDefTitle(src, k);
    if (!t) return null; // junk on the destination line invalidates it
    title = t.title;
    k = t.end;
    while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
    if (k < src.length && src[k] !== '\n') return null;
    j = k;
  } else if (k >= src.length || src[k] === '\n') {
    // title may sit alone on the following line
    let n = k + (src[k] === '\n' ? 1 : 0);
    if (src[k] === '\n') {
      let m2 = n;
      while (src[m2] === ' ' || src[m2] === '\t') m2++;
      const q = src[m2];
      if (q === '"' || q === "'" || q === '(') {
        const lineEnd = (() => {
          const nl = src.indexOf('\n', m2);
          return nl === -1 ? src.length : nl;
        })();
        const t = parseDefTitle(src, m2);
        if (t) {
          let e = t.end;
          while (src[e] === ' ' || src[e] === '\t') e++;
          if (e >= src.length || src[e] === '\n') {
            title = t.title;
            j = e;
          }
        }
      }
    }
    if (title === null) j = k;
  }
  const key = normalizeLabel(label);
  if (!links.has(key)) {
    links.set(key, {
      href: cleanUrl(unescapeBackslash(dest)),
      title: title === null ? null : unescapeBackslash(title),
    });
  }
  return { len: j };
}

// Parse a definition title starting at src[i] (a quote or paren). A
// title may span several lines but not a blank line.
// Returns { title, end } or null.
function parseDefTitle(src, i) {
  const open = src[i];
  const close = open === '(' ? ')' : open;
  if (open !== '"' && open !== "'" && open !== '(') return null;
  let j = i + 1;
  let title = '';
  while (j < src.length) {
    const c = src[j];
    if (c === '\\' && j + 1 < src.length) {
      title += c + src[j + 1];
      j += 2;
      continue;
    }
    if (c === close) return { title, end: j + 1 };
    if (open === '(' && c === '(') return null;
    if (c === '\n') {
      // a blank line inside the title kills the definition
      let k = j + 1;
      while (src[k] === ' ' || src[k] === '\t') k++;
      if (k >= src.length || src[k] === '\n') return null;
    }
    title += c;
    j++;
  }
  return null;
}

// ------------------------------------------------------------- tables

// Split a table row into cell texts. Pipes inside code spans do not
// split; \| becomes a literal | in the cell text; any other escaped
// character is structurally inert.
function splitCells(line) {
  // Code spans protect the pipes inside them. The span scan walks
  // the row: at a backtick run it looks for an equal-length closing
  // run; a matched span is skipped whole, an unmatched run advances
  // the scan by a single character (so the second backtick of
  // "``add`" can still open the span "`add`", and the pipe after it
  // splits).
  const spans = [];
  let si = 0;
  while (si < line.length) {
    if (line[si] !== '`') { si++; continue; }
    let bs = 0;
    for (let k = si - 1; k >= 0 && line[k] === '\\'; k--) bs++;
    if (bs % 2 === 1) { si++; continue; } // escaped: opens nothing
    let runLen = 0;
    while (line[si + runLen] === '`') runLen++;
    let k = si + runLen;
    let closed = -1;
    while (k < line.length) {
      if (line[k] === '`') {
        let n = 0;
        while (line[k + n] === '`') n++;
        if (n === runLen) { closed = k + n; break; }
        k += n;
      } else k++;
    }
    if (closed === -1) { si++; continue; }
    spans.push([si, closed]);
    si = closed;
  }
  const inSpan = (pos) => spans.some(([a, b]) => pos >= a && pos < b);
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '|') {
      cur += '|';
      i += 2;
      continue;
    }
    if (c === '\\' && i + 1 < line.length && isPunct(line[i + 1])) {
      cur += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '|' && !inSpan(i)) {
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  cells.push(cur);
  // drop the empty artefacts of a leading/trailing pipe
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

function parseDelimiterRow(line) {
  const cells = splitCells(line);
  if (!cells.length) return null;
  const aligns = [];
  for (const cell of cells) {
    const m = /^(:?)-+(:?)$/.exec(cell);
    if (!m) return null;
    aligns.push(m[1] && m[2] ? 'center' : m[2] ? 'right' : m[1] ? 'left' : null);
  }
  return aligns;
}

function isTableStart(headerLine, delimLine) {
  if (delimLine === undefined) return false;
  if (!headerLine.includes('|') && !delimLine.includes('|')) return false;
  const aligns = parseDelimiterRow(delimLine);
  if (!aligns) return false;
  const header = splitCells(headerLine);
  return header.length === aligns.length && aligns.length > 0;
}

function lexTable(src) {
  const headerLine = firstLineOf(src);
  let rest = src.slice(headerLine.length + (src.length > headerLine.length ? 1 : 0));
  if (rest === '' && src.length <= headerLine.length) return null;
  const delimLine = firstLineOf(rest);
  if (!isTableStart(headerLine, delimLine)) return null;
  const aligns = parseDelimiterRow(delimLine);
  const headerCells = splitCells(headerLine);
  let len = headerLine.length + (src.length > headerLine.length ? 1 : 0);
  len += delimLine.length + (rest.length > delimLine.length ? 1 : 0);
  rest = rest.slice(delimLine.length + (rest.length > delimLine.length ? 1 : 0));
  const header = headerCells.map((text, i) => ({ text, align: aligns[i] }));
  const rows = [];
  while (rest.length) {
    const line = firstLineOf(rest);
    // the body runs until an empty or spaces-only line or another
    // block start; tab-only and plain text lines become (padded) rows
    if (/^ *$/.test(line)) break;
    if (startsBlockForTable(line)) break;
    const cells = splitCells(line);
    while (cells.length < aligns.length) cells.push('');
    rows.push(cells.slice(0, aligns.length));
    const ll = line.length + (rest.length > line.length ? 1 : 0);
    len += ll;
    rest = rest.slice(ll);
  }
  return { tokens: [{ type: 'table', header, rows }], len };
}

// Lines that end a table body: the start of another block structure.
function startsBlockForTable(line) {
  if (stripQuotePrefix(line) !== null) return true;
  if (/^ {0,3}(#{1,6})([ \t]+|$)/.test(line)) return true;
  if (/^ {0,3}(`{3,}|~{3,})/.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (matchItemStart(line)) return true;
  if (htmlBlockStart(line) !== 0) return true;
  return false;
}

// ------------------------------------------------------------- lists

// Match a list item start on a line. Returns null or:
// { ordered, bullet, delim, num, contentIndent, markerCol }
function matchItemStart(line) {
  const ind = indentColumns(line, 0);
  if (ind.cols > 3) return null;
  let i = ind.chars;
  let ordered = false;
  let bullet = '';
  let delim = '';
  let num = 0;
  const c = line[i];
  if (c === '*' || c === '+' || c === '-') {
    bullet = c;
    i += 1;
  } else {
    const dm = /^(\d{1,9})([.)])/.exec(line.slice(i));
    if (!dm) return null;
    ordered = true;
    num = parseInt(dm[1], 10);
    delim = dm[2];
    i += dm[0].length;
  }
  const markerEndCol = ind.cols + (i - ind.chars);
  const after = line.slice(i);
  if (after !== '' && after[0] !== ' ' && after[0] !== '\t') return null;
  const ws = indentColumns(after, markerEndCol);
  const restBlank = after.slice(ws.chars) === '';
  let contentIndent;
  if (restBlank || ws.cols >= 5) contentIndent = markerEndCol + 1;
  else contentIndent = markerEndCol + ws.cols;
  return { ordered, bullet, delim, num, contentIndent, markerCol: ind.cols };
}

function sameListType(a, b) {
  if (a.ordered !== b.ordered) return false;
  return a.ordered ? a.delim === b.delim : a.bullet === b.bullet;
}

// If a line opens a fenced code block, return { ch, len } of the fence.
function fenceOpenOf(line) {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n]*)$/.exec(line);
  if (!m) return null;
  if (m[1][0] === '`' && m[2].includes('`')) return null;
  return { ch: m[1][0], len: m[1].length };
}

function isFenceClose(line, fence) {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return m !== null && m[1][0] === fence.ch && m[1].length >= fence.len;
}

function lexList(src, links) {
  const firstStart = matchItemStart(firstLineOf(src));
  if (!firstStart) return null;
  const items = [];
  let loose = false;
  let len = 0;
  let endLen = 0; // len just past the last non-blank line consumed
  let rest = src;
  let cur = null; // { lines, contentIndent, lazy }
  let pendingBlanks = 0;
  let fence = null; // open fence inside the current item, if any
  let fenceLines = 0; // content lines the open fence has so far

  const finishItem = () => {
    if (cur) items.push(cur);
    cur = null;
    fence = null;
    fenceLines = 0;
  };

  while (rest.length) {
    const line = firstLineOf(rest);
    const lineLen = line.length + (rest.length > line.length ? 1 : 0);

    if (cur === null) {
      const st = matchItemStart(line);
      if (!st || !sameListType(st, firstStart)) break;
      const firstContent = dropColumns(line, st.contentIndent);
      cur = { lines: [firstContent], contentIndent: st.contentIndent, lazy: new Set() };
      fence = fenceOpenOf(firstContent);
      fenceLines = 0;
      pendingBlanks = 0;
      len += lineLen;
      endLen = len;
      rest = rest.slice(lineLen);
      continue;
    }

    if (fence) {
      // Inside a fenced code block within the item, lines are
      // content however they are indented — except that a fence
      // which has no content lines yet is abandoned (with the
      // item) at a non-blank line dedented below the item's
      // content indent.
      const indPre = indentColumns(line, 0);
      if (fenceLines === 0 && !isBlankLine(line) && indPre.cols < cur.contentIndent) {
        finishItem();
        continue;
      }
      if (pendingBlanks > 0) {
        for (let k = 0; k < pendingBlanks; k++) cur.lines.push('');
        pendingBlanks = 0;
      }
      const ind0 = indPre;
      const content = ind0.cols >= cur.contentIndent
        ? stripColumns(line, cur.contentIndent)
        : line;
      cur.lines.push(content);
      if (isFenceClose(content, fence)) fence = null;
      else if (!isBlankLine(line)) fenceLines++;
      len += lineLen;
      endLen = len;
      rest = rest.slice(lineLen);
      continue;
    }

    if (isBlankLine(line)) {
      if (cur.lines.length === 1 && cur.lines[0] === '') {
        // An item whose first line is empty ends the list at a blank
        // line, unless another item of the same list follows.
        let scan = rest;
        while (scan.length && isBlankLine(firstLineOf(scan))) {
          const sl = firstLineOf(scan);
          scan = scan.slice(sl.length + (scan.length > sl.length ? 1 : 0));
        }
        const nst = scan.length ? matchItemStart(firstLineOf(scan)) : null;
        if (nst && sameListType(nst, firstStart)) {
          loose = true;
          finishItem();
          while (rest.length && isBlankLine(firstLineOf(rest))) {
            const bl = firstLineOf(rest);
            const bll = bl.length + (rest.length > bl.length ? 1 : 0);
            len += bll;
            rest = rest.slice(bll);
          }
          pendingBlanks = 0;
          continue;
        }
        break;
      }
      pendingBlanks++;
      len += lineLen;
      rest = rest.slice(lineLen);
      continue;
    }

    const ind = indentColumns(line, 0);

    // a new item starting below this item's content indent?
    if (ind.cols < cur.contentIndent) {
      if (HR_RE.test(line)) break; // a thematic break ends the list
      const st = matchItemStart(line);
      if (st && sameListType(st, firstStart)) {
        if (pendingBlanks > 0) loose = true;
        finishItem();
        continue; // the cur===null branch consumes the line
      }
    }

    if (ind.cols >= cur.contentIndent) {
      if (pendingBlanks > 0) {
        for (let k = 0; k < pendingBlanks; k++) cur.lines.push('');
        pendingBlanks = 0;
      }
      const content = stripColumns(line, cur.contentIndent);
      cur.lines.push(content);
      fence = fenceOpenOf(content);
      fenceLines = 0;
      len += lineLen;
      endLen = len;
      rest = rest.slice(lineLen);
      continue;
    }

    // dedented, not an item: a lazy continuation of the item's paragraph?
    if (pendingBlanks === 0 &&
        !isSetextUnderline(line) &&
        !matchItemStart(line) &&
        contentEndsWithParagraph(cur.lines.join('\n'), links, cur.lazy, true)) {
      const after = rest.slice(lineLen);
      if (!interruptsParagraph(line, firstLineOf(after))) {
        cur.lazy.add(cur.lines.length);
        cur.lines.push(line);
        len += lineLen;
        endLen = len;
        rest = rest.slice(lineLen);
        continue;
      }
    }

    break; // the list ends here; the line belongs to the outer context
  }
  finishItem();
  if (!items.length) return null;

  const outItems = items.map((item) => {
    // Lex the item block by block: if two of its direct blocks are
    // separated by a blank line, the list is loose.
    const toks = [];
    let restText = item.lines.join('\n');
    let sawBlock = false;
    let lineNo = 0;
    while (restText.length) {
      const r = lexOneBlock(restText, links, item.lazy, lineNo, true);
      if (r.len === 0) break;
      if (sawBlock && r.blanks > 0 && r.block) loose = true;
      if (r.block) sawBlock = true;
      toks.push(...r.tokens);
      lineNo += (restText.slice(0, r.len).match(/\n/g) || []).length;
      restText = restText.slice(r.len);
    }
    let task = false;
    let checked = false;
    if (toks.length && toks[0].type === 'paragraph') {
      const tm = /^\[([ xX])\] /.exec(toks[0].text);
      if (tm) {
        task = true;
        checked = tm[1] !== ' ';
        toks[0].text = toks[0].text.slice(tm[0].length);
      }
    }
    return { tokens: toks, task, checked };
  });

  return {
    tokens: [{
      type: 'list',
      ordered: firstStart.ordered,
      start: firstStart.num,
      loose,
      items: outItems,
    }],
    // trailing blank lines the loop speculatively consumed are not
    // part of the list: the following block must still see them (list
    // looseness in an enclosing item depends on it)
    len: endLen,
  };
}

// ------------------------------------------------------------- paragraphs

function isSetextUnderline(line) {
  return /^ {0,3}(=+|-+)[ \t]*$/.test(line);
}

// Does `line` start a block that interrupts a paragraph? (Setext
// underlines are checked by callers before this.)
function interruptsParagraph(line, nextLine, inList = false) {
  if (/^ {0,3}(#{1,6})([ \t]+|$)/.test(line)) return true; // ATX heading
  if (fenceOpenOf(line) !== null) return true; // fence
  if (HR_RE.test(line)) return true; // thematic break
  if (stripQuotePrefix(line) !== null) return true; // blockquote
  const st = matchItemStart(line);
  if (st) {
    const content = dropColumns(line, st.contentIndent);
    // an ordered list interrupts a paragraph only when it starts at 1 —
    // except inside a list item, where marked starts a nested list at
    // any number
    if (content.trim() !== '' && (!st.ordered || st.num === 1 || inList)) return true;
  }
  const hb = htmlBlockStart(line);
  if (hb !== 0 && hb !== 7) return true; // html blocks except type 7 interrupt
  if (nextLine !== undefined && isTableStart(line, nextLine)) return true;
  return false;
}

function lexParagraph(src, lazyRel = null, inList = false, stripFirst = false) {
  const firstRaw = firstLineOf(src);
  const first = stripFirst
    ? stripColumns(firstRaw, Math.min(3, indentColumns(firstRaw, 0).cols))
    : firstRaw;
  const lines = [first];
  let len = firstRaw.length + (src.length > firstRaw.length ? 1 : 0);
  let rest = src.slice(len);
  let lineIdx = 0;
  while (rest.length) {
    const line = firstLineOf(rest);
    lineIdx++;
    const ll = line.length + (rest.length > line.length ? 1 : 0);
    if (isBlankLine(line)) {
      // A whitespace-only line joins the paragraph only when nothing
      // at all follows it; otherwise it is a blank separator.
      if (line !== '' && rest.slice(ll) === '') {
        lines.push(line);
        len += ll;
        rest = rest.slice(ll);
      }
      break;
    }
    if (lazyRel && lazyRel.has(lineIdx)) {
      // a lazy continuation line absorbed by a container: it can never
      // interrupt or convert the paragraph. A lazy line indented by
      // three or more columns loses its indent; a line with at most
      // two columns is kept verbatim.
      lines.push(indentColumns(line, 0).cols >= 3 ? line.replace(/^[ \t]+/, '') : line);
      len += ll;
      rest = rest.slice(ll);
      continue;
    }
    if (isSetextUnderline(line)) {
      const level = line.trimStart()[0] === '=' ? 1 : 2;
      return {
        tokens: [{ type: 'heading', depth: level, text: lines.join('\n').trim() }],
        len: len + ll,
      };
    }
    const after = rest.slice(ll);
    if (interruptsParagraph(line, firstLineOf(after), inList)) break;
    lines.push(line);
    len += ll;
    rest = rest.slice(ll);
  }
  return { tokens: [{ type: 'paragraph', text: lines.join('\n') }], len };
}

// ------------------------------------------------------------- block driver

function tokensEndWithParagraph(toks) {
  if (!toks.length) return false;
  const last = toks[toks.length - 1];
  if (last.type === 'paragraph') return true;
  if (last.type === 'blockquote') return tokensEndWithParagraph(last.tokens);
  if (last.type === 'list' && last.items.length) {
    return tokensEndWithParagraph(last.items[last.items.length - 1].tokens);
  }
  return false;
}

function contentEndsWithParagraph(text, links, lazyAbs = null, inList = false) {
  const toks = lexBlocks(text, links, lazyAbs, inList);
  return tokensEndWithParagraph(toks);
}

// Lex one block from the front of src (after skipping blank lines).
// Returns { tokens, len, blanks, block } where blanks counts the blank
// lines skipped before the block and block says a block-level construct
// was consumed (definitions count, though they produce no token) —
// list looseness detection needs both.
function lexOneBlock(src, links, lazyAbs = null, startLine = 0, inList = false, afterQuote = false) {
  let rest = src;
  let len = 0;
  let blanks = 0;
  while (rest.length) {
    const line = firstLineOf(rest);
    if (!isBlankLine(line)) break;
    blanks++;
    const ll = line.length + (rest.length > line.length ? 1 : 0);
    len += ll;
    rest = rest.slice(ll);
  }
  if (!rest.length) return { tokens: [], len, blanks, block: false, kind: 'other' };
  let r;
  const done = (tokens, kind = 'other') => ({ tokens, len: len + r.len, blanks, block: true, kind });
  if ((r = lexIndentedCode(rest))) return done(r.tokens);
  if ((r = lexFence(rest))) return done(r.tokens);
  if ((r = lexHeading(rest))) return done(r.tokens);
  if ((r = lexHr(rest))) return done(r.tokens);
  if ((r = lexBlockquote(rest, links, inList))) return done(r.tokens, 'quote');
  if ((r = lexList(rest, links))) return done(r.tokens);
  if ((r = lexHtmlBlock(rest))) return done(r.tokens);
  if ((r = lexDef(rest, links))) return done([]);
  if ((r = lexTable(rest))) return done(r.tokens);
  let lazyRel = null;
  if (lazyAbs) {
    const blockStart = startLine + blanks;
    lazyRel = new Set();
    for (const n of lazyAbs) {
      if (n >= blockStart) lazyRel.add(n - blockStart);
    }
  }
  // a paragraph that starts immediately after a blockquote (the line
  // was examined as a lazy candidate and left outside) loses its
  // first line's indent
  r = lexParagraph(rest, lazyRel, inList, afterQuote && blanks === 0);
  return done(r.tokens);
}

function lexBlocks(src, links, lazyAbs = null, inList = false) {
  const tokens = [];
  let rest = src;
  let lineNo = 0;
  let prevQuote = false;
  while (rest.length) {
    const r = lexOneBlock(rest, links, lazyAbs, lineNo, inList, prevQuote);
    if (r.len === 0) break; // safety: never spin
    tokens.push(...r.tokens);
    lineNo += (rest.slice(0, r.len).match(/\n/g) || []).length;
    rest = rest.slice(r.len);
    prevQuote = r.kind === 'quote';
  }
  return tokens;
}

// ------------------------------------------------------------- inline lexer
//
// Inline content is tokenised into nodes, emphasis/strikethrough are
// resolved with a delimiter-run pass, and the nodes are rendered to the
// exact HTML marked produces.
//
// Node shapes:
//   { t: 'text', s }        raw text (entities resolved at render)
//   { t: 'raw', s }         final HTML (inline tags, autolinks)
//   { t: 'code', s }        code span content (raw)
//   { t: 'br' }
//   { t: 'link', href, title, kids }
//   { t: 'image', href, title, kids }
//   { t: 'delim', ch, n, canOpen, canClose }
//   { t: 'em' | 'strong' | 'del', kids }

const AUTOLINK_SCHEME_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/;
const AUTOLINK_EMAIL_RE = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
const EXT_URL_RE = /(?:[hH][tT][tT][pP][sS]?:\/\/|www\.)(?:[^\s<(]+|\((?![^\s<()]*:\/\/)[^\s<()]*\))+/g;
const EXT_EMAIL_RE = /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;
const EXT_SCHEME_MAIL_RE = /(mailto|xmpp):([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)(\/[a-zA-Z0-9._~@-]+)?/g;

// Find GFM extended autolinks in a text fragment. Returns a list of
// { start, end, href, text } sorted by start, non-overlapping: the
// leftmost candidate wins, ties keep pass priority (url, email,
// scheme-mail).
function findExtAutolinks(s) {
  const candidates = [];
  // URLs (http/https in any case, or a lowercase www.)
  EXT_URL_RE.lastIndex = 0;
  let m;
  while ((m = EXT_URL_RE.exec(s)) !== null) {
    const start = m.index;
    const prev = start > 0 ? s[start - 1] : undefined;
    if (prev !== undefined && /[a-zA-Z0-9]/.test(prev)) continue;
    let url = m[0];
    let end = start + url.length;
    // an entity-looking tail is not part of the link at all: the link
    // ends just before its &
    const ent = /&[a-zA-Z#][a-zA-Z0-9]*;$/.exec(url);
    if (ent) {
      end -= url.length - ent.index;
      url = url.slice(0, ent.index);
    }
    // trailing punctuation (and a bare trailing semicolon) and
    // unmatched closing parens are not part of the link; the two
    // strippings interleave until the end is stable. A ')' counts as
    // matched when a '(' opened earlier in the URL is still open at
    // its position (a ')' with no open pending is kept mid-URL but
    // is strippable at the tail).
    const matchedClose = new Set();
    {
      let depth = 0;
      for (let k = 0; k < url.length; k++) {
        if (url[k] === '(') depth++;
        else if (url[k] === ')') {
          if (depth > 0) { depth--; matchedClose.add(k); }
        }
      }
    }
    while (url.length) {
      const last = url[url.length - 1];
      if ('?!.,:*_~;'.includes(last)) {
        url = url.slice(0, -1);
        end--;
        continue;
      }
      if (last === ')' && !matchedClose.has(url.length - 1)) {
        url = url.slice(0, -1);
        end--;
        continue;
      }
      break;
    }
    if (!url.length) continue;
    const href = cleanUrl(url.startsWith('www.') ? 'http://' + url : url);
    candidates.push({ start, end, href, text: url, pass: 0 });
  }
  // Addresses rejected only because a '_' follows are "rescued": if
  // that '_' turns out to be the closer of an emphasis span whose
  // content ends exactly at the address, the address is evaluated
  // against the extracted content (where nothing follows it) and
  // links after all. processDelimiters confirms those.
  const rescued = [];
  // plain email addresses
  EXT_EMAIL_RE.lastIndex = 0;
  while ((m = EXT_EMAIL_RE.exec(s)) !== null) {
    const start = m.index;
    // an address that is the tail of a mailto:/xmpp: token belongs to
    // the scheme pass: if that token is not a valid autolink, the bare
    // address inside it is not linked either (gfm-632)
    let prefixLen = 0;
    if (s.slice(start - 7, start) === 'mailto:') prefixLen = 7;
    else if (s.slice(start - 5, start) === 'xmpp:') prefixLen = 5;
    if (prefixLen > 0) {
      const prevCh = start - prefixLen > 0 ? s[start - prefixLen - 1] : undefined;
      if (prevCh === undefined || !/[a-zA-Z0-9]/.test(prevCh)) continue;
    }
    // an address immediately followed by a word character or - is
    // part of a longer token, not an autolink (gfm-632)
    const next = s[start + m[0].length];
    if (next !== undefined && /[a-zA-Z0-9-]/.test(next)) continue;
    const cand = {
      start,
      end: start + m[0].length,
      href: 'mailto:' + m[0],
      text: m[0],
      pass: 1,
    };
    if (next === '_') { rescued.push(cand); continue; }
    candidates.push(cand);
  }
  // mailto: / xmpp: scheme addresses
  EXT_SCHEME_MAIL_RE.lastIndex = 0;
  while ((m = EXT_SCHEME_MAIL_RE.exec(s)) !== null) {
    const start = m.index;
    const prev = start > 0 ? s[start - 1] : undefined;
    if (prev !== undefined && /[a-zA-Z0-9]/.test(prev)) continue;
    let text = m[0];
    let end = start + text.length;
    if (m[1] === 'mailto' && m[4]) {
      // the resource part is not part of a mailto link
      text = text.slice(0, text.length - m[4].length);
      end = start + text.length;
    }
    // without a resource part, a word character or - right after the
    // address means it is a longer token, not an autolink
    const hasResource = m[1] === 'xmpp' && m[4];
    if (!hasResource) {
      const next = s[end];
      if (next !== undefined && /[a-zA-Z0-9-]/.test(next)) continue;
      if (next === '_') {
        rescued.push({ start, end, href: text, text, pass: 2 });
        continue;
      }
    }
    candidates.push({ start, end, href: text, text, pass: 2 });
  }
  candidates.sort((a, b) => a.start - b.start || a.pass - b.pass || b.end - a.end);
  const ranges = [];
  let covered = -1;
  for (const c of candidates) {
    if (c.start < covered) continue;
    ranges.push(c);
    covered = c.end;
  }
  return { ranges, rescued };
}

// Find the ']' closing the bracket opened at s[i] === '[', honouring
// escapes, code spans (single-backtick chunks, as marked scans them),
// inline HTML and angle autolinks. Returns the index or -1.
function findClosingBracket(s, i) {
  let depth = 1;
  let spanPoisoned = false;
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isPunct(s[j + 1])) {
      j += 2;
      continue;
    }
    if (c === '`') {
      // a code span swallows brackets, but only when it closes with
      // the same run length on the same line; once a run fails to
      // close on the line, later runs no longer open spans in this
      // scan (an unmatched run poisons the rest of the scan)
      let runLen = 0;
      while (s[j + runLen] === '`') runLen++;
      if (spanPoisoned) { j += runLen; continue; }
      let k = j + runLen;
      let closed = -1;
      while (k < s.length && s[k] !== '\n') {
        if (s[k] === '`') {
          let n = 0;
          while (s[k + n] === '`') n++;
          if (n === runLen) { closed = k + n; break; }
          k += n;
        } else k++;
      }
      if (closed === -1) spanPoisoned = true;
      j = closed === -1 ? j + runLen : closed;
      continue;
    }
    if (c === '<') {
      const htmlLen = inlineHtmlLength(s.slice(j));
      if (htmlLen > 0) { j += htmlLen; continue; }
      const am = AUTOLINK_SCHEME_RE.exec(s.slice(j)) || AUTOLINK_EMAIL_RE.exec(s.slice(j));
      if (am) { j += am[0].length; continue; }
      j++;
      continue;
    }
    if (c === '[') depth++;
    if (c === ']') {
      depth--;
      if (depth === 0) return j;
    }
    j++;
  }
  return -1;
}

// Parse an inline link destination at s[i] === '('. Returns
// { href, title, end } or null.
function parseLinkDestination(s, i) {
  let j = i + 1;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  let dest = '';
  if (s[j] === '<') {
    let k = j + 1;
    let ok = false;
    while (k < s.length) {
      const c = s[k];
      if (c === '\\' && k + 1 < s.length && isPunct(s[k + 1])) {
        dest += c + s[k + 1];
        k += 2;
        continue;
      }
      if (c === '>') { ok = true; break; }
      if (c === '<' || c === '\n') return null;
      dest += c;
      k++;
    }
    if (!ok) return null;
    j = k + 1;
  } else {
    let depth = 0;
    let k = j;
    while (k < s.length) {
      const c = s[k];
      if (c === '\\' && k + 1 < s.length && isPunct(s[k + 1])) {
        dest += c + s[k + 1];
        k += 2;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === '(') depth++;
      if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      if (c.charCodeAt(0) < 0x20) return null;
      dest += c;
      k++;
    }
    if (depth !== 0) return null;
    j = k;
  }
  // optional title
  let title = null;
  let k = j;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
  const q = s[k];
  if (q === '"' || q === "'" || q === '(') {
    const close = q === '(' ? ')' : q;
    let t = k + 1;
    let raw = '';
    let ok = false;
    while (t < s.length) {
      const c = s[t];
      if (c === '\\' && t + 1 < s.length && isPunct(s[t + 1])) {
        raw += c + s[t + 1];
        t += 2;
        continue;
      }
      if (c === close) { ok = true; break; }
      if (q === '(' && c === '(') return null;
      if (c === '\n' && s[t + 1] === '\n') return null; // no blank lines
      raw += c;
      t++;
    }
    if (!ok) return null;
    title = unescapeBackslash(raw);
    k = t + 1;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
  }
  if (s[k] !== ')') return null;
  return { href: cleanUrl(unescapeBackslash(dest)), title, end: k + 1 };
}

function nodesContainCodeRun2(nodes) {
  for (const nd of nodes) {
    if (nd.t === 'code' && nd.run >= 2) return true;
    if (nd.kids && nodesContainCodeRun2(nd.kids)) return true;
  }
  return false;
}

function nodesContainLink(nodes) {
  for (const nd of nodes) {
    if (nd.t === 'link') return true;
    if (nd.kids && nodesContainLink(nd.kids)) return true;
  }
  return false;
}

function flankAt(text, runStart, runEnd, ch) {
  const before = runStart > 0 ? text[runStart - 1] : undefined;
  const after = runEnd < text.length ? text[runEnd] : undefined;
  const leftFlank = !isSpace(after) && (!isUnicodePunct(after) || isSpace(before) || isUnicodePunct(before));
  const rightFlank = !isSpace(before) && (!isUnicodePunct(before) || isSpace(after) || isUnicodePunct(after));
  if (ch === '_') {
    return {
      canOpen: leftFlank && (!rightFlank || isUnicodePunct(before)),
      canClose: rightFlank && (!leftFlank || isUnicodePunct(after)),
    };
  }
  return { canOpen: leftFlank, canClose: rightFlank };
}

// Locate code spans of run length >= 2 in `text` (a run closes only
// with an equal-length run). Returns [{ st, en }].
function codeSpans2(text) {
  const spans = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '`') { i++; continue; }
    let j = i;
    while (j < text.length && text[j] === '`') j++;
    const runLen = j - i;
    let k = j, closeStart = -1;
    while (k < text.length) {
      if (text[k] === '`') {
        let e = k;
        while (e < text.length && text[e] === '`') e++;
        if (e - k === runLen) { closeStart = k; break; }
        k = e;
      } else k++;
    }
    if (closeStart === -1) { i = j; continue; }
    if (runLen >= 2) spans.push({ st: i, en: closeStart + runLen });
    i = closeStart + runLen;
  }
  return spans;
}

// marked's link-text pattern cannot consume an emphasis span whose
// content holds a multi-backtick code span: a link whose text has a
// use-1 '_' opener run and closer run on either side of such a span
// does not form, and in the literal fallback those runs stay inert.
// Returns the offending run pairs (offsets within `text`).
function findEmCodeChunks(text) {
  const spans = codeSpans2(text);
  if (!spans.length) return [];
  // collect delimiter runs with their flanking abilities
  const runs = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c !== '*' && c !== '_' && c !== '~') { i++; continue; }
    let j = i;
    while (j < text.length && text[j] === c) j++;
    const f = flankAt(text, i, j, c);
    runs.push({ ch: c, st: i, en: j, ...f });
    i = j;
  }
  const pairs = [];
  for (const sp of spans) {
    const opens = runs.filter(r => r.ch === '_' && r.en <= sp.st && r.canOpen);
    const closes = runs.filter(r => r.ch === '_' && r.st >= sp.en && r.canClose);
    for (const o of opens) {
      for (const c of closes) {
        // only a use-1 pairing is blocked ('__' pairs are fine)
        if (!(o.en - o.st >= 2 && c.en - c.st >= 2)) pairs.push({ o, c });
      }
    }
  }
  return pairs;
}

function textHasEmCodeChunk(text) {
  return findEmCodeChunks(text).length > 0;
}

// Try to parse a link or image at s[i] ('[' or '!' followed by '[').
// Returns { href, title, textSrc, end, image } or null.
function tryLink(s, i, links) {
  const image = s[i] === '!';
  const start = image ? i + 1 : i;
  const close = findClosingBracket(s, start);
  if (close === -1) return null;
  const textSrc = s.slice(start + 1, close);
  // marked's label pattern only allows a multi-backtick code span
  // as the final chunk of the link text
  if (codeSpans2(textSrc).some(sp => sp.en < textSrc.length)) return null;
  const after = close + 1;
  let found = null;
  if (s[after] === '(') {
    const dest = parseLinkDestination(s, after);
    if (dest) {
      found = { href: dest.href, title: dest.title, textSrc, end: dest.end, image };
    } else {
      // marked falls back to a reference link when the inline
      // destination does not parse
      const def = links.get(normalizeLabel(textSrc));
      if (def) found = { href: def.href, title: def.title, textSrc, end: after, image };
    }
  } else if (s[after] === '[') {
    const labelEnd = findClosingBracket(s, after);
    if (labelEnd !== -1) {
      const label = s.slice(after + 1, labelEnd);
      const def = links.get(normalizeLabel(label === '' ? textSrc : label));
      if (def) found = { href: def.href, title: def.title, textSrc, end: labelEnd + 1, image };
    } else {
      // an unclosed second bracket pair falls back to a shortcut ref
      const def = links.get(normalizeLabel(textSrc));
      if (def) found = { href: def.href, title: def.title, textSrc, end: after, image };
    }
  } else {
    const def = links.get(normalizeLabel(textSrc));
    if (def) found = { href: def.href, title: def.title, textSrc, end: after, image };
  }
  if (!found) return null;
  if (!image) {
    // a link may not contain another link
    const kids = inlineNodes(textSrc, links, false);
    if (nodesContainLink(kids)) return null;
    if (textHasEmCodeChunk(textSrc)) return null;
  }
  return found;
}

const INLINE_SPECIALS = new Set(['\\', '`', '<', '[', '!', '*', '_', '~', '\n']);

// Tokenise inline content into nodes (emphasis not yet resolved).
// Extended autolinks are only collected at the top level: marked does
// not autolink inside link text or image alt text.
function inlineNodes(text, links, inLink, autolink = false) {
  const found = autolink ? findExtAutolinks(text) : { ranges: [], rescued: [] };
  const ranges = found.ranges;
  // Dead zones: '_' runs inside the bracket text of a link that
  // failed because of the emphasis/code-span chunk limit stay inert
  // in the literal fallback (marked never tokenises them as
  // emphasis there). Only computed outside link text.
  const deadUnderscores = new Set();
  if (!inLink) {
    for (let b = 0; b < text.length; b++) {
      const isImg = text[b] === '!' && text[b + 1] === '[';
      if (text[b] !== '[' && !isImg) continue;
      const start = isImg ? b + 1 : b;
      if (tryLink(text, b, links)) continue;
      const close = findClosingBracket(text, start);
      if (close === -1) continue;
      const inner = text.slice(start + 1, close);
      for (const p of findEmCodeChunks(inner)) {
        deadUnderscores.add(start + 1 + p.o.st);
        deadUnderscores.add(start + 1 + p.c.st);
      }
    }
  }
  const nodes = [];
  let buf = '';
  let bufStart = 0;
  let rangeIdx = 0;
  let trimNext = false; // just after a hard break: trim leading spaces
  const flush = () => {
    if (buf) {
      nodes.push({ t: 'text', s: buf, st: bufStart, en: bufStart + buf.length });
      buf = '';
    }
  };
  const addBuf = (str, at) => {
    if (!buf) bufStart = at;
    buf += str;
  };
  let i = 0;
  while (i < text.length) {
    while (rangeIdx < ranges.length && ranges[rangeIdx].start < i) rangeIdx++;
    if (rangeIdx < ranges.length && ranges[rangeIdx].start === i) {
      flush();
      const r = ranges[rangeIdx++];
      nodes.push({
        t: 'raw',
        s: `<a href="${escapeText(r.href, false)}">${escapeText(r.text)}</a>`,
      });
      i = r.end;
      trimNext = false;
      continue;
    }
    const c = text[i];
    if (trimNext) {
      if (c === ' ' || c === '\t') { i++; continue; }
      trimNext = false;
    }
    if (c === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') {
        flush();
        nodes.push({ t: 'br' });
        i += 2;
        trimNext = true;
        continue;
      }
      if (nx !== undefined && isPunct(nx)) {
        flush();
        nodes.push({ t: 'text', s: nx, st: i, en: i + 2 });
        i += 2;
        continue;
      }
      addBuf(c, i);
      i++;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < text.length && text[j] === '`') j++;
      const runLen = j - i;
      // find a closing run of exactly the same length
      let k = j;
      let closeStart = -1;
      while (k < text.length) {
        if (text[k] === '`') {
          let e = k;
          while (e < text.length && text[e] === '`') e++;
          if (e - k === runLen) { closeStart = k; break; }
          k = e;
        } else k++;
      }
      if (closeStart === -1) {
        addBuf(text.slice(i, j), i);
        i = j;
        continue;
      }
      flush();
      let content = text.slice(j, closeStart).replace(/\n/g, ' ');
      if (
        content.length > 1 &&
        content[0] === ' ' &&
        content[content.length - 1] === ' ' &&
        content.trim() !== ''
      ) {
        content = content.slice(1, -1);
      }
      nodes.push({ t: 'code', s: content, run: runLen });
      i = closeStart + runLen;
      continue;
    }
    if (c === '<') {
      const rest = text.slice(i);
      const sm = AUTOLINK_SCHEME_RE.exec(rest);
      if (sm) {
        flush();
        nodes.push({
          t: 'raw',
          s: `<a href="${escapeText(cleanUrl(sm[1]), false)}">${escapeText(sm[1])}</a>`,
        });
        i += sm[0].length;
        continue;
      }
      const em = AUTOLINK_EMAIL_RE.exec(rest);
      if (em) {
        flush();
        nodes.push({
          t: 'raw',
          s: `<a href="mailto:${escapeText(em[1], false)}">${escapeText(em[1])}</a>`,
        });
        i += em[0].length;
        continue;
      }
      const hl = inlineHtmlLength(rest);
      if (hl > 0) {
        flush();
        nodes.push({ t: 'raw', s: rest.slice(0, hl) });
        i += hl;
        continue;
      }
      addBuf(c, i);
      i++;
      continue;
    }
    if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      const image = c === '!';
      if (image || !inLink) {
        const link = tryLink(text, i, links);
        if (link) {
          flush();
          // link text may not contain links; image alt text is parsed
          // as ordinary inline content (links flatten to their text)
          const kids = inlineNodes(link.textSrc, links, !image);
          nodes.push({
            t: image ? 'image' : 'link',
            href: link.href,
            title: link.title,
            kids,
          });
          i = link.end;
          continue;
        }
      }
      addBuf(c, i);
      i++;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < text.length && text[j] === c) j++;
      const runLen = j - i;
      if (c === '_' && deadUnderscores.has(i)) {
        addBuf(text.slice(i, j), i);
        i = j;
        continue;
      }
      if (c === '~' && runLen > 2) {
        // three or more tildes never form strikethrough in marked
        addBuf(text.slice(i, j), i);
        i = j;
        continue;
      }
      flush();
      const before = i > 0 ? text[i - 1] : undefined;
      const after = j < text.length ? text[j] : undefined;
      const leftFlank = !isSpace(after) && (!isUnicodePunct(after) || isSpace(before) || isUnicodePunct(before));
      const rightFlank = !isSpace(before) && (!isUnicodePunct(before) || isSpace(after) || isUnicodePunct(after));
      let canOpen, canClose;
      if (c === '*') {
        canOpen = leftFlank;
        canClose = rightFlank;
      } else if (c === '_') {
        canOpen = leftFlank && (!rightFlank || isUnicodePunct(before));
        canClose = rightFlank && (!leftFlank || isUnicodePunct(after));
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      nodes.push({ t: 'delim', ch: c, n: runLen, n0: runLen, canOpen, canClose, st: i, en: j, usedL: 0, usedR: 0 });
      i = j;
      continue;
    }
    if (c === '\n') {
      addBuf(c, i);
      i++;
      continue;
    }
    if (c === ' ') {
      // a run of 2+ spaces ending at a newline is a hard break
      let k = i;
      while (k < text.length && text[k] === ' ') k++;
      if (text[k] === '\n' && k - i >= 2) {
        flush();
        nodes.push({ t: 'br' });
        i = k + 1;
        trimNext = true;
        continue;
      }
    }
    // plain text run: consume until the next special, the next
    // autolink range, or a hard-break opportunity (2+ spaces before a
    // newline)
    let j = i;
    const stopAt = rangeIdx < ranges.length ? ranges[rangeIdx].start : Infinity;
    while (j < text.length && j < stopAt) {
      const ch = text[j];
      if (INLINE_SPECIALS.has(ch)) break;
      if (ch === ' ') {
        let k = j;
        while (k < text.length && text[k] === ' ') k++;
        if (text[k] === '\n' && k - j >= 2) break;
        j = k;
        continue;
      }
      j++;
    }
    if (j === i) {
      // a lone special we do not handle above (e.g. '!' not before '[')
      addBuf(c, i);
      i++;
      continue;
    }
    addBuf(text.slice(i, j), i);
    i = j;
    // hard break: the run stopped at 2+ spaces before a newline
    if (text[i] === ' ') {
      let k = i;
      while (k < text.length && text[k] === ' ') k++;
      if (text[k] === '\n' && k - i >= 2) {
        flush();
        nodes.push({ t: 'br' });
        i = k + 1;
        trimNext = true;
      }
    }
  }
  flush();
  return processDelimiters(nodes, found.rescued, text);
}

// ------------------------------------------------------------- emphasis pass

// Resolve delim nodes into em/strong/del wrappers (CommonMark's
// delimiter-run algorithm).

function processDelimiters(nodes, rescued = [], srcText = '') {
  const delims = [];
  for (let k = 0; k < nodes.length; k++) {
    if (nodes[k].t === 'delim') delims.push({ node: nodes[k], idx: k });
  }
  let ci = 0;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (!closer.node.canClose || closer.node.n === 0) { ci++; continue; }
    // find the nearest matching opener below
    let oi = ci - 1;
    let matched = false;
    while (oi >= 0) {
      const opener = delims[oi];
      if (opener.node.ch !== closer.node.ch || !opener.node.canOpen || opener.node.n === 0) { oi--; continue; }
      // rule of three
      if ((opener.node.canClose || closer.node.canOpen) &&
          (opener.node.n + closer.node.n) % 3 === 0 &&
          !(opener.node.n % 3 === 0 && closer.node.n % 3 === 0)) {
        oi--;
        continue;
      }
      break;
    }
    if (oi < 0) { ci++; continue; }
    const opener = delims[oi];
    const use = opener.node.n >= 2 && closer.node.n >= 2 ? 2 : 1;
    // marked deviation D3: a single '*' closer does not pair when the
    // run just before it is a fully consumed '**' run and only word
    // text separates them ("*a **b**c*" and "*a **b** c*" differ: a
    // whitespace gap lets the pair form after all)
    if (use === 1 && closer.node.ch === '*') {
      // the nearest preceding delimiter run in the node stream (it
      // may already have been consumed and dropped from `delims`)
      let pred = null;
      for (let k = nodes.indexOf(closer.node) - 1; k >= 0; k--) {
        if (nodes[k].t === 'delim') { pred = nodes[k]; break; }
      }
      if (
        pred &&
        pred.ch === '*' && pred.n === 0 && pred.n0 >= 2 && pred.usedL >= 2 &&
        pred.en !== undefined && closer.node.st !== undefined &&
        closer.node.st > pred.en &&
        !/\s/.test(srcText.slice(pred.en, closer.node.st)) &&
        /\s/.test(srcText.slice(opener.node.en - opener.node.usedR, pred.st)) &&
        // ... and the strong the previous run closed began at a
        // word boundary: "**a *b* c**d*" stays literal, but in
        // "*returns first**stream**because*" (strong glued to the
        // preceding word) the outer emphasis forms after all
        pred.lastWrapOpenBy &&
        (pred.lastWrapOpenBy.st === 0 || /\s/.test(srcText[pred.lastWrapOpenBy.st - 1]))
      ) {
        // the vetoed pair is rejected as a unit: the opener may not
        // spend a later strong closer either ("**a *b **c**d* e**"
        // pairs the two '**' runs, leaving both singles literal)
        opener.node.canOpen = false;
        ci++;
        continue;
      }
    }
    // marked deviation from the pure delimiter algorithm:
    if (use === 1 && closer.node.n === 1 && opener.node.n === 2) {
      // D1: a single closer does not spend one character of a strong
      // opener when a later strong closer (with no other strong
      // opener in between) can take the whole run
      let blocked = false;
      for (let k = ci + 1; k < delims.length; k++) {
        const d = delims[k].node;
        if (d.ch !== closer.node.ch || d.n === 0) continue;
        if (d.n >= 2 && d.canOpen) break;
        if (d.n >= 2 && d.canClose) { blocked = true; break; }
      }
      if (blocked) { ci++; continue; }
    }
    const tag = closer.node.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    const between = nodes.slice(opener.idx + 1, closer.idx);
    // confirm rescued autolinks: an address that ends exactly where
    // this span's content ends is followed, inside the content, by
    // nothing — it links after all
    if (rescued.length && opener.node.en !== undefined && closer.node.st !== undefined) {
      const contentStart = opener.node.en - opener.node.usedR;
      const contentEnd = closer.node.st + closer.node.usedL;
      for (const r of rescued) {
        if (r.done || r.end !== contentEnd || r.start < contentStart) continue;
        for (let k = 0; k < between.length; k++) {
          const nd = between[k];
          if (nd.t !== 'text' || nd.st === undefined) continue;
          if (nd.en - nd.st !== nd.s.length) continue;
          if (r.start < nd.st || r.end > nd.en) continue;
          const a = r.start - nd.st;
          const b = r.end - nd.st;
          const parts = [];
          if (a > 0) parts.push({ t: 'text', s: nd.s.slice(0, a), st: nd.st, en: nd.st + a });
          parts.push({
            t: 'raw',
            s: `<a href="${escapeText(r.href, false)}">${escapeText(r.text)}</a>`,
          });
          if (b < nd.s.length) parts.push({ t: 'text', s: nd.s.slice(b), st: nd.st + b, en: nd.en });
          between.splice(k, 1, ...parts);
          r.done = true;
          break;
        }
      }
    }
    const wrap = { t: tag, kids: between, closedBy: closer.node, use };
    closer.node.lastWrapOpenBy = opener.node;
    nodes.splice(opener.idx + 1, closer.idx - opener.idx - 1, wrap);
    opener.node.n -= use;
    closer.node.n -= use;
    opener.node.usedR += use;
    closer.node.usedL += use;
    // delimiter indices shifted by the splice; rebuild bookkeeping:
    // delimiters strictly between opener and closer are deactivated.
    for (let k = oi + 1; k < ci; k++) delims[k].node.dead = true;
    delims.splice(oi + 1, ci - oi - 1);
    ci = oi + 1; // closer is now at index oi+1
    // recompute node indices for the remaining delimiters
    for (let k = 0; k < delims.length; k++) delims[k].idx = nodes.indexOf(delims[k].node);
    matched = true;
    if (closer.node.n === 0) {
      delims.splice(ci, 1);
      // ci stays: next delimiter shifted into place
    }
    // if the closer still has length, try matching it again (loop
    // without advancing)
    if (closer.node.n > 0 && delims[ci] === closer) continue;
    if (!matched) ci++;
  }
  // marked deviation D5: the leftover of a partially used closer run
  // renders INSIDE the element it closed when that element's content
  // holds an emphasis element the run took no part in closing
  // ("**by command *tool*one***" -> "...one*</strong>", but plain
  // "**foo***" keeps the star outside)
  const sweep = (arr) => {
    for (let i = 0; i + 1 < arr.length; i++) {
      const w = arr[i];
      if (w.t === 'strong' && w.use === 2 && w.closedBy) {
        const d = arr[i + 1];
        if (
          d === w.closedBy && d.t === 'delim' && d.n > 0 &&
          d.usedL > 0 && d.usedR === 0 &&
          w.kids.some((k) =>
            (k.t === 'em' || k.t === 'strong' || k.t === 'del') && k.closedBy !== d)
        ) {
          w.kids.push({ t: 'text', s: d.ch.repeat(d.n) });
          d.n = 0;
        }
      }
    }
    for (const nd of arr) if (nd.kids) sweep(nd.kids);
  };
  sweep(nodes);
  return nodes;
}

// ------------------------------------------------------------- inline render

function plainTextOf(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text':
        out += nd.s;
        break;
      case 'code':
        out += nd.s;
        break;
      case 'delim':
        out += nd.ch.repeat(nd.n);
        break;
      case 'em':
      case 'strong':
      case 'del':
      case 'link':
      case 'image':
        out += plainTextOf(nd.kids);
        break;
      default:
        break; // raw html and breaks contribute nothing
    }
  }
  return out;
}

function renderNodes(nodes, links) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text':
        out += escapeText(nd.s);
        break;
      case 'raw':
        out += nd.s;
        break;
      case 'code':
        out += '<code>' + escapeFull(nd.s) + '</code>';
        break;
      case 'br':
        out += '<br>';
        break;
      case 'delim':
        out += nd.ch.repeat(nd.n);
        break;
      case 'em':
        out += '<em>' + renderNodes(nd.kids, links) + '</em>';
        break;
      case 'strong':
        out += '<strong>' + renderNodes(nd.kids, links) + '</strong>';
        break;
      case 'del':
        out += '<del>' + renderNodes(nd.kids, links) + '</del>';
        break;
      case 'link': {
        const title = nd.title !== null && nd.title !== undefined
          ? ` title="${escapeText(nd.title, false)}"`
          : '';
        out += `<a href="${escapeText(nd.href, false)}"${title}>` +
          renderNodes(nd.kids, links) + '</a>';
        break;
      }
      case 'image': {
        const title = nd.title !== null && nd.title !== undefined
          ? ` title="${escapeText(nd.title, false)}"`
          : '';
        out += `<img src="${escapeText(nd.href, false)}" alt="${escapeText(plainTextOf(nd.kids), false)}"${title}>`;
        break;
      }
    }
  }
  return out;
}

function parseInline(text, links, inLink) {
  return renderNodes(inlineNodes(text, links, inLink, true), links);
}

// ------------------------------------------------------------- block render

function renderBlocks(tokens, links, tight) {
  let out = '';
  for (const tk of tokens) {
    switch (tk.type) {
      case 'heading':
        out += `<h${tk.depth}>${parseInline(tk.text, links, false)}</h${tk.depth}>\n`;
        break;
      case 'paragraph': {
        const inner = parseInline(tk.text, links, false);
        out += tight ? inner : `<p>${inner}</p>\n`;
        break;
      }
      case 'code': {
        const cls = tk.lang ? ` class="language-${tk.lang}"` : '';
        const tail = tk.text === '' || tk.text.endsWith('\n') ? '' : '\n';
        out += `<pre><code${cls}>${escapeFull(tk.text)}${tail}</code></pre>\n`;
        break;
      }
      case 'hr':
        out += '<hr>\n';
        break;
      case 'html':
        out += tk.text;
        break;
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(tk.tokens, links, false) + '</blockquote>\n';
        break;
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        tk.header.forEach((cell) => {
          out += `<th${cell.align ? ` align="${cell.align}"` : ''}>${parseInline(cell.text, links, false)}</th>\n`;
        });
        out += '</tr>\n</thead>\n';
        if (tk.rows.length) {
          out += '<tbody>';
          for (const row of tk.rows) {
            out += '<tr>\n';
            row.forEach((cell, ci2) => {
              const al = tk.header[ci2] ? tk.header[ci2].align : null;
              out += `<td${al ? ` align="${al}"` : ''}>${parseInline(cell, links, false)}</td>\n`;
            });
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        break;
      }
      case 'list': {
        out += tk.ordered
          ? (tk.start !== 1 ? `<ol start="${tk.start}">\n` : '<ol>\n')
          : '<ul>\n';
        for (const item of tk.items) {
          const checkbox = item.task
            ? `<input ${item.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `
            : '';
          if (tk.loose) {
            let inner = renderBlocks(item.tokens, links, false);
            // in a loose item the checkbox lives inside the paragraph
            if (item.task) {
              inner = inner.startsWith('<p>')
                ? '<p>' + checkbox + inner.slice(3)
                : checkbox + inner;
            }
            out += '<li>' + inner + '</li>\n';
          } else {
            out += '<li>' + checkbox + renderBlocks(item.tokens, links, true) + '</li>\n';
          }
        }
        out += tk.ordered ? '</ol>\n' : '</ul>\n';
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------- entry point

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const links = new Map();
  const tokens = lexBlocks(src, links);
  return renderBlocks(tokens, links, false);
}
