// Markdown -> HTML renderer matching marked 18.1.3 (gfm:true, breaks:false)
// byte-for-byte. Dependency-free ES module exporting parse(markdown).

// ------------------------------------------------------------- helpers

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' ||
    ch === '\v' || ch === '\f' || ch === ' ' || ch === '﻿';
}
function isAsciiPunct(ch) {
  return ch !== undefined && /[!-/:-@[-`{-~]/.test(ch);
}
const RE_UNI_PUNCT = /[\p{P}\p{S}]/u;
function isPunct(ch) {
  if (ch === undefined) return false;
  if (/[!-/:-@[-`{-~]/.test(ch)) return true; // ASCII punctuation
  return RE_UNI_PUNCT.test(ch) && !isSpace(ch);
}

function escapeText(s) {
  // text nodes never contain real entities (those are separate nodes),
  // so every '&' here is a literal ampersand
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeCode(s) {
  if (!/[&<>"']/.test(s)) return s;
  return s.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) {
  // attribute values may contain entity references from the source;
  // those are preserved, bare ampersands are escaped
  if (!/[&"]/.test(s)) return s;
  return s.replace(/&(?![A-Za-z][A-Za-z0-9]*;|#[0-9]+;|#[xX][0-9A-Fa-f]+;)/g, '&amp;')
    .replace(/"/g, '&quot;');
}

function codePointToChar(cp) {
  if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '�';
  return String.fromCodePoint(cp);
}
function decodeNumericRefs(s) {
  if (!s.includes('&#')) return s;
  return s.replace(/&#(?:(\d+)|[xX]([0-9A-Fa-f]+));/g, (m, dec, hex) => {
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp > 0x10FFFF) return m; // out of range: not a character reference
    return codePointToChar(cp);
  });
}
function unescapeStr(s) {
  if (!s.includes('\\')) return s;
  return s.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}
function cleanUrl(s) {
  try {
    return encodeURI(s).replace(/%25/g, '%');
  } catch {
    return s;
  }
}
function hrefValue(raw) {
  return cleanUrl(decodeNumericRefs(unescapeStr(raw)));
}
function titleValue(raw) {
  return decodeNumericRefs(unescapeStr(raw));
}

function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().replace(/ß/g, 'ss');
}

// --------------------------------------- link reference definition parts

// Parse a link destination at text[j]. Returns { href, endPos } or null.
function parseDestAt(text, j) {
  if (text[j] === '<') {
    let k = j + 1;
    while (k < text.length) {
      const ch = text[k];
      if (ch === '\\') { k += 2; continue; }
      if (ch === '\n') return null;
      if (ch === '<') return null;
      if (ch === '>') {
        return { href: hrefValue(text.slice(j + 1, k)), endPos: k + 1 };
      }
      k++;
    }
    return null;
  }
  let k = j, balance = 0;
  while (k < text.length) {
    const ch = text[k];
    if (ch === '\\') { k += 2; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break;
    if (ch < ' ') break;
    if (ch === '(') balance++;
    else if (ch === ')') {
      if (balance === 0) break;
      balance--;
    }
    k++;
  }
  if (k === j) return null; // bare empty destination is invalid
  return { href: hrefValue(text.slice(j, k)), endPos: k };
}

// Parse a link title at text[j] ("..." '...' or (...)).
// Returns { title, endPos } or null.
function parseTitleAt(text, j) {
  const open = text[j];
  if (open !== '"' && open !== "'" && open !== '(') return null;
  const close = open === '(' ? ')' : open;
  let k = j + 1;
  while (k < text.length) {
    const ch = text[k];
    if (ch === '\\') { k += 2; continue; }
    if (open === '(' && ch === '(') return null;
    if (ch === close) {
      return { title: titleValue(text.slice(j + 1, k)), endPos: k + 1 };
    }
    k++;
  }
  return null;
}

// Parse a full link reference definition at the start of text (which may
// contain newlines). Returns { label, href, title, endPos } or null.
function parseDef(text) {
  let j = 0, cols = 0;
  while (text[j] === ' ' && cols < 4) { j++; cols++; }
  if (cols > 3) return null;
  if (text[j] === '\t') return null;
  if (text[j] !== '[') return null;
  // scan the label: no unescaped '[' inside; '\' escapes the next char
  let k = j + 1;
  while (k < text.length) {
    const ch = text[k];
    if (ch === '\\') { k += 2; continue; }
    if (ch === '[') return null;
    if (ch === ']') break;
    if (ch === '\n' && text[k + 1] === '\n') return null;
    k++;
  }
  if (k >= text.length || text[k] !== ']') return null;
  const label = text.slice(j + 1, k);
  if (label.length === 0 || label.length > 999) return null;
  if (text[k + 1] !== ':') return null;
  let p = k + 2;
  // whitespace (incl. newlines) before the destination
  while (text[p] === ' ' || text[p] === '\t' || text[p] === '\n' || text[p] === '\r') p++;
  const dest = parseDestAt(text, p);
  if (!dest) return null;
  p = dest.endPos;
  const afterDest = p;
  // the destination's own line must end here (spaces/tabs to EOL)
  let q = p;
  while (text[q] === ' ' || text[q] === '\t') q++;
  const destLineEnds = q >= text.length || text[q] === '\n' || text[q] === '\r';
  // try a title: whitespace (incl. newlines) then a title, after which
  // the rest of that line must be blank
  let title = null, endPos = -1;
  let r = p;
  let sawWs = false;
  while (text[r] === ' ' || text[r] === '\t' || text[r] === '\n' || text[r] === '\r') { r++; sawWs = true; }
  if (sawWs && r < text.length && (text[r] === '"' || text[r] === "'" || text[r] === '(')) {
    const t = parseTitleAt(text, r);
    if (t) {
      let u = t.endPos;
      while (text[u] === ' ' || text[u] === '\t') u++;
      if (u >= text.length || text[u] === '\n' || text[u] === '\r') {
        title = t.title;
        endPos = u;
      }
    }
  }
  if (endPos === -1) {
    if (!destLineEnds) return null; // garbage after the destination
    endPos = q;
  }
  const normLabel = normalizeLabel(label);
  if (normLabel === '') return null; // a label needs a non-space character
  return { label: normLabel, href: dest.href, title, endPos };
}

// ---------------------------------------------------------- HTML tags

const BLOCK_TAGS = new Set((
  'address article aside base basefont blockquote body caption center col ' +
  'colgroup dd details dialog dir div dl dt fieldset figcaption figure footer ' +
  'form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li ' +
  'link main menu menuitem nav noframes ol optgroup option p param section ' +
  'source summary table tbody td tfoot th thead title tr track ul').split(' '));

// Match an HTML tag at text[i]; return the end index or null.
function matchTag(text, i) {
  let j = i + 1;
  let closing = false;
  if (text[j] === '/') { closing = true; j++; }
  if (!/[A-Za-z]/.test(text[j] || '')) return null;
  j++;
  while (/[A-Za-z0-9-]/.test(text[j] || '')) j++;
  if (closing) {
    while (text[j] === ' ' || text[j] === '\t' || text[j] === '\n') j++;
    return text[j] === '>' ? j + 1 : null;
  }
  // attributes
  for (;;) {
    let ws = 0;
    while (text[j] === ' ' || text[j] === '\t' || text[j] === '\n') { j++; ws++; }
    if (text[j] === '>') return j + 1;
    if (text[j] === '/' && text[j + 1] === '>') return j + 2;
    if (ws === 0) return null;
    // attribute name
    if (!/[A-Za-z_:]/.test(text[j] || '')) return null;
    while (/[A-Za-z0-9_.:-]/.test(text[j] || '')) j++;
    // optional value
    let k = j;
    while (text[k] === ' ' || text[k] === '\t' || text[k] === '\n') k++;
    if (text[k] === '=') {
      k++;
      while (text[k] === ' ' || text[k] === '\t' || text[k] === '\n') k++;
      const q = text[k];
      if (q === '"' || q === "'") {
        const e = text.indexOf(q, k + 1);
        if (e === -1) return null;
        j = e + 1;
      } else {
        if (!/[^\s"'=<>`]/.test(text[k] || '')) return null;
        while (/[^\s"'=<>`]/.test(text[k] || '')) k++;
        j = k;
      }
    }
  }
}

// HTML block start type (1-7) for a line remainder, or 0.
function matchHtmlBlockStart(rest) {
  if (rest[0] !== '<') return 0;
  const m = /^<(script|pre|style|textarea)(?=[\s>]|$)/i.exec(rest);
  if (m) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![A-Z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  const tm = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(rest);
  if (tm && BLOCK_TAGS.has(tm[1].toLowerCase())) return 6;
  // type 7: one complete tag spanning the whole line, no backtick
  if (!rest.includes('`')) {
    const end = matchTag(rest, 0);
    if (end && /^[ \t]*$/.test(rest.slice(end))) return 7;
  }
  return 0;
}

function htmlTerminatorFound(block, tail) {
  switch (block.htmlType) {
    case 1: return /<\/(?:script|pre|style|textarea)>/i.test(tail);
    case 2: return tail.includes('-->');
    case 3: return tail.includes('?>');
    case 4: return tail.includes('>');
    case 5: return tail.includes(']]>');
    default: return false;
  }
}

// ---------------------------------------------------------- block parse

function blockParse(src, refs) {
  const srcNl = src.endsWith('\n');
  const lines = src.split('\n');
  if (srcNl) lines.pop();

  const doc = { t: 'doc', children: [] };
  const stack = [doc];
  const baseStack = [0];
  let s = '', pos = 0, col = 0, pad = 0;
  let curLineBlank = false;
  let curQuoteCol = -1;
  const quoteColAt = []; // '>' column per stack index, for stable list bases
  let pendingDef = null;
  let curLineIdx = 0;

  // does a closing fence for this fenced block appear on a later line?
  function fenceClosesAhead(fence) {
    for (let k = curLineIdx + 1; k < lines.length; k++) {
      const m = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(lines[k]);
      if (m && m[1][0] === fence.fenceChar && m[1].length >= fence.fenceLen) return true;
    }
    return false;
  }

  const tip = () => stack[stack.length - 1];

  function newBlock(t) { return { t, children: [] }; }

  function openBlock(b) {
    const parent = tip();
    if (parent.t === 'item') {
      // a blank line (directly in the item, or trailing a just-closed
      // child subtree) separates this new child from the previous ones;
      // either way it is no longer a trailing blank
      if ((parent._ownBlank || parent._sepPending) && parent.children.length > 0) {
        parent._sepKids = true;
      }
      parent._ownBlank = false;
      parent._sepPending = false;
    }
    parent.children.push(b);
    stack.push(b);
    baseStack.push(col);
  }

  function finalizeTop(eof) {
    const b = tip();
    b.lastLineBlank = curLineBlank;
    if (b.t === 'para') {
      if (stripDefsText(b) === 'removed') b.dead = true;
    }
    if (b.t === 'code' && !b.fenced) {
      b.literal = b.literal.replace(/(?:\n[ \t]*)+$/, '\n');
    }
    if (b.t === 'html' && eof && srcNl && !b.literal.endsWith('\n')) {
      b.literal += '\n';
    }
    if (b.t === 'list') {
      // loose if an item has blank-separated children, or a non-last
      // item ends with a blank line (a trailing blank on the last item
      // does not loosen)
      const items = b.children;
      b.loose = items.some((it, ix) =>
        it._sepKids || (ix < items.length - 1 && itemEndsBlank(it)));
    }
    stack.pop();
    baseStack.pop();
    // a subtree that ends with a blank line separates the parent item's
    // next child from its previous ones
    const nt = tip();
    if (nt && nt.t === 'item' && blockEndsBlank(b)) nt._sepPending = true;
  }

  function blockEndsBlank(b) {
    if (b.t === 'item') return itemEndsBlank(b);
    if (b.t === 'list') {
      const li = b.children[b.children.length - 1];
      return li ? itemEndsBlank(li) : false;
    }
    return !!b.lastLineBlank;
  }

  function closeTo(idx, eof) {
    while (stack.length - 1 > idx) finalizeTop(eof);
  }

  function itemEndsBlank(item) {
    if (item._ownBlank) return true;
    const kids = item.children;
    const last = kids[kids.length - 1];
    if (!last) return false;
    if (last.lastLineBlank) return true;
    if (last.t === 'list') {
      const li = last.children[last.children.length - 1];
      return li ? itemEndsBlank(li) : false;
    }
    return false;
  }

  // consume complete link reference definitions from a paragraph's start
  function stripDefsText(para) {
    let text = para.text;
    let any = false;
    let lastDef = null, lastDefWasNew = false;
    for (;;) {
      // skip line separators and blank lines between definitions
      let t2 = text;
      for (;;) {
        let u = 0;
        while (t2[u] === ' ' || t2[u] === '\t') u++;
        if (t2[u] === '\n') { t2 = t2.slice(u + 1); continue; }
        break;
      }
      if (t2 === '' ) { text = t2; break; }
      const d = parseDef(t2);
      if (!d) break;
      lastDefWasNew = !refs.has(d.label);
      if (lastDefWasNew) refs.set(d.label, { href: d.href, title: d.title });
      text = t2.slice(d.endPos);
      any = true;
      lastDef = d;
    }
    if (text === '') {
      // a trailing definition may take its title from the next line
      if (lastDef && lastDef.title === null) {
        pendingDef = lastDefWasNew ? refs.get(lastDef.label) : { title: null };
      }
      return 'removed';
    }
    para.text = text;
    return any ? 'stripped' : 'none';
  }

  // ---- per-line scanning state
  function wsInfo() {
    let p = pos, c = col + pad, cols = pad;
    while (p < s.length) {
      if (s[p] === ' ') { p++; c++; cols++; }
      else if (s[p] === '\t') { const w = 4 - (c % 4); p++; c += w; cols += w; }
      else break;
    }
    return { cols, endPos: p, endCol: c };
  }
  function consumeWsCols(n) {
    consumeCols(col + n);
  }
  function consumeCols(target) {
    // an existing partial-tab pad counts toward the target first
    if (pad > 0) {
      if (col + pad >= target) { pad = col + pad - target; col = target; return true; }
      col += pad; pad = 0;
    }
    while (col < target) {
      if (s[pos] === ' ') { pos++; col++; }
      else if (s[pos] === '\t') {
        const w = 4 - (col % 4);
        if (col + w > target) {
          // partial tab: the rest becomes spaces of content padding
          pad = col + w - target;
          pos++; col = target;
          break;
        }
        pos++; col += w;
      } else break;
    }
    return col >= target;
  }
  function contentSlice() {
    return pad ? ' '.repeat(pad) + s.slice(pos) : s.slice(pos);
  }

  function listMarkerData(rest, endCol) {
    let m = /^([-+*])(?:[ \t]|$)/.exec(rest);
    if (m) {
      return {
        ordered: false, bullet: m[1], delim: m[1], start: null,
        markerWidth: 1, restBlank: /^[ \t]*$/.test(rest.slice(1)),
      };
    }
    m = /^(\d{1,9})([.)])(?:[ \t]|$)/.exec(rest);
    if (m) {
      return {
        ordered: true, bullet: null, delim: m[2], start: parseInt(m[1], 10),
        markerWidth: m[1].length + 1, restBlank: /^[ \t]*$/.test(rest.slice(m[1].length + 1)),
      };
    }
    return null;
  }
  function isCompatList(listB, lm) {
    if (listB.ordered !== lm.ordered) return false;
    if (lm.ordered) return listB.delim === lm.delim;
    return listB.bullet === lm.bullet;
  }

  function interruptsParagraph(rest, info, allowList = true) {
    if (info.cols > 3) return false;
    if (rest[0] === '>') return true;
    if (/^#{1,6}(?:[ \t]|$)/.test(rest)) return true;
    const fm = /^(`{3,}|~{3,})(.*)$/.exec(rest);
    if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) return true;
    const ht = matchHtmlBlockStart(rest);
    if (ht >= 1 && ht <= 6) return true;
    if (/^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})[ \t]*$/.test(rest)) return true;
    if (allowList) {
      const lm = listMarkerData(rest, info.endCol);
      // an ordered list interrupts a paragraph with any start number
      // when the paragraph lives inside a list item
      if (lm && !lm.restBlank && (!lm.ordered || lm.start === 1 || stack.some(b => b.t === 'item'))) return true;
    }
    return false;
  }

  // split a table row into cell texts (\| becomes |, pipes inside code
  // spans do not split)
  function splitRow(line) {
    // pipes split cells unconditionally (only \| is protected); the
    // reference does not track code spans when splitting rows
    const cells = [];
    let cur = '', i = 0;
    const t = line.trim();
    while (i < t.length) {
      const ch = t[i];
      if (ch === '\\' && t[i + 1] === '|') { cur += '|'; i += 2; continue; }
      if (ch === '|') { cells.push(cur); cur = ''; i++; continue; }
      cur += ch; i++;
    }
    cells.push(cur);
    // drop the empty artifacts of leading/trailing pipes
    if (cells.length && cells[0].trim() === '' && t.startsWith('|')) cells.shift();
    if (cells.length && cells[cells.length - 1].trim() === '' && /\|$/.test(t.replace(/\\\|$/, ''))) cells.pop();
    return cells.map(c => c.trim());
  }
  function parseDelimiterRow(line) {
    const cells = splitRow(line);
    if (!cells.length) return null;
    const aligns = [];
    for (const c of cells) {
      if (!/^:?-+:?$/.test(c)) return null;
      aligns.push(c.startsWith(':') && c.endsWith(':') ? 'center'
        : c.startsWith(':') ? 'left' : c.endsWith(':') ? 'right' : null);
    }
    return aligns;
  }

  function tryTableConvert(para, rest) {
    if (!rest.includes('|')) return false; // a bare --- is a setext underline
    const aligns = parseDelimiterRow(rest);
    if (!aligns) return false;
    const textLines = para.text.split('\n');
    const headerCells = splitRow(textLines[textLines.length - 1]);
    if (headerCells.length !== aligns.length) return false;
    const parent = stack[stack.length - 2];
    if (textLines.length > 1) {
      para.text = textLines.slice(0, -1).join('\n');
      finalizeTop();
    } else {
      parent.children.pop();
      stack.pop(); baseStack.pop();
    }
    const tb = newBlock('table');
    tb.header = headerCells;
    tb.aligns = aligns;
    tb.rows = [];
    openBlock(tb);
    return true;
  }

  function addTableRow(tb, lineText) {
    const cells = splitRow(lineText);
    while (cells.length < tb.header.length) cells.push('');
    tb.rows.push(cells.slice(0, tb.header.length));
  }

  function applyListStart(lm, info) {
    let t = tip();
    if (t.t === 'list' && !isCompatList(t, lm)) { finalizeTop(); t = tip(); }
    let listIdx;
    if (t.t !== 'list') {
      const L = newBlock('list');
      L.ordered = lm.ordered;
      L.bullet = lm.bullet;
      L.delim = lm.delim;
      L.start = lm.start;
      L.loose = false;
      L.offParent = info.endCol - baseStack[stack.length - 1];
      openBlock(L);
      baseStack[stack.length - 1] = info.endCol; // marker column
      listIdx = stack.length - 1;
    } else {
      listIdx = stack.length - 1;
    }
    const markerOffset = info.endCol - baseStack[listIdx];
    // consume the marker
    pos = info.endPos + lm.markerWidth;
    col = info.endCol + lm.markerWidth;
    pad = 0;
    const item = newBlock('item');
    item.markerOffset = markerOffset;
    const sp = wsInfo();
    if (lm.restBlank) {
      item.contentIndent = lm.markerWidth + 1;
      if (s[pos] === '\t') { pad = 3 - (col % 4); pos++; col++; }
      else if (s[pos] === ' ') { pos++; col++; }
    } else if (sp.cols >= 5) {
      item.contentIndent = lm.markerWidth + 1;
      if (s[pos] === '\t') { pad = 3 - (col % 4); pos++; col++; }
      else { pos++; col++; }
    } else {
      item.contentIndent = lm.markerWidth + sp.cols;
      pos = sp.endPos; col = sp.endCol;
    }
    // _sepKids: a new child opening in an item that had a blank line
    openBlock(item);
    baseStack[stack.length - 1] = baseStack[listIdx] + markerOffset + item.contentIndent;
  }

  // code text inside a list item gets its tabs expanded to the next
  // multiple-of-4 column (the item's dedent machinery works in columns)
  function codeText(str, startCol) {
    if (!str.includes('\t')) return str;
    for (let k = 0; k < stack.length; k++) {
      if (stack[k].t !== 'item') continue;
      let out = '', c = startCol;
      for (let j = 0; j < str.length; j++) {
        const ch = str[j];
        if (ch === '\t') { const w = 4 - (c % 4); out += ' '.repeat(w); c += w; }
        else { out += ch; c++; }
      }
      return out;
    }
    return str;
  }

  // fenced-code content: inside a blockquote, tab stops are measured
  // from the quote marker's column (the quote's local line)
  function codeTextFence(str, startCol) {
    if (!str.includes('\t')) return str;
    if (curQuoteCol >= 0 && stack.some(b => b.t === 'quote')) {
      let out = '', c = startCol - curQuoteCol;
      for (let j = 0; j < str.length; j++) {
        const ch = str[j];
        if (ch === '\t') { const w = 4 - (c % 4); out += ' '.repeat(w); c += w; }
        else { out += ch; c++; }
      }
      return out;
    }
    return codeText(str, startCol);
  }

  function processLine(rawLine, nextRaw) {
    s = rawLine; pos = 0; col = 0; pad = 0; curQuoteCol = -1;
    const lineBlank = /^[ \t]*$/.test(s);
    let failedAt = -1, matchedIdx = stack.length - 1, newItemListIdx = -1;

    // ---- phase 1: match open containers
    for (let i = 1; i < stack.length; i++) {
      const b = stack[i];
      if (b.t === 'para' || b.t === 'heading' || b.t === 'code' || b.t === 'html' || b.t === 'table') {
        matchedIdx = i; // leaf tip: matched by definition
        break;
      }
      const savePos = pos, saveCol = col, savePad = pad;
      if (b.t === 'quote') {
        consumeWsCols(3);
        if (s[pos] === '>') {
          curQuoteCol = col;
          quoteColAt[i] = col;
          pos++; col++;
          if (s[pos] === ' ') { pos++; col++; }
          else if (s[pos] === '\t') { pad = 3 - (col % 4); pos++; col++; }
          baseStack[i] = col;
          matchedIdx = i;
        } else {
          failedAt = i; matchedIdx = i - 1;
          pos = savePos; col = saveCol; pad = savePad;
          break;
        }
      } else if (b.t === 'list') {
        // the list's base on this line: the parent container's content
        // column on this line plus the list's offset within the parent
        baseStack[i] = baseStack[i - 1] + (b.offParent || 0);
        matchedIdx = i;
      } else if (b.t === 'item') {
        if (/^[ \t]*$/.test(s.slice(pos))) {
          // a blank remainder matches an item at any indent
          baseStack[i] = baseStack[i - 1];
          matchedIdx = i;
        } else if (b.children.length === 0 && b._blankSep) {
          failedAt = i; matchedIdx = i - 1;
          pos = savePos; col = saveCol; pad = savePad;
          break;
        } else {
          const target = baseStack[i - 1] + b.markerOffset + b.contentIndent;
          if (consumeCols(target)) {
            baseStack[i] = target;
            matchedIdx = i;
          } else {
            failedAt = i; matchedIdx = i - 1;
            pos = savePos; col = saveCol; pad = savePad;
            break;
          }
        }
      }
    }

    // ---- phase 1.5: an item failed; maybe a sibling/new list item here
    if (failedAt !== -1 && stack[failedAt].t === 'item' &&
        stack[failedAt - 1] && stack[failedAt - 1].t === 'list') {
      const infoH = wsInfo();
      const isHr = infoH.cols <= 3 &&
        /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})[ \t]*$/.test(s.slice(infoH.endPos));
      const lmHere = isHr ? null : (infoH.cols <= 3 ? listMarkerData(s.slice(infoH.endPos), infoH.endCol) : null);
      if (!lmHere) {
        matchedIdx = failedAt - 2;
      } else {
        const found = { lm: lmHere, col: infoH.endCol };
        matchedIdx = failedAt - 2;
        let idx = failedAt - 1;
        while (idx >= 1 && stack[idx].t === 'list') {
          const listBase = baseStack[idx];
          if (isCompatList(stack[idx], found.lm) &&
              found.col - listBase <= 3 && listBase - found.col <= 3) {
            newItemListIdx = idx;
            matchedIdx = idx;
            break;
          }
          matchedIdx = idx - 1;
          idx -= 2;
        }
      }
    }

    // effective blankness: a whitespace-only remainder counts as blank
    // only when nothing was consumed (a matched container's trailing
    // space, e.g. "> ", is paragraph content, not a blank)
    const remWsBlank = /^[ \t]*$/.test(s.slice(pos));
    const effBlank = lineBlank || s.slice(pos) === '' || (pos === 0 && remWsBlank);
    curLineBlank = effBlank;

    const tipB = tip();

    // a pending definition title may sit on this line
    if (pendingDef && failedAt === -1 && tipB.t !== 'para') {
      if (effBlank) {
        // stays pending across blank lines
      } else {
        const info = wsInfo();
        const rest = s.slice(info.endPos);
        const tm = parseTitleAt(rest, 0);
        if (tm && /^[ \t]*$/.test(rest.slice(tm.endPos))) {
          pendingDef.title = tm.title;
          pendingDef = null;
          return;
        }
        pendingDef = null;
      }
    }

    // a blank line inside a fenced code block is content, even when an
    // item fails to match on it (but not when a quote fails: the blank
    // then lies outside the quote and ends the fence)
    if (effBlank && tipB.t === 'code' && tipB.fenced) {
      let onlyItems = failedAt === -1;
      if (!onlyItems) {
        onlyItems = true;
        for (let k = failedAt; k < stack.length - 1; k++) {
          if (stack[k].t !== 'item' && stack[k].t !== 'list') { onlyItems = false; break; }
        }
      }
      if (onlyItems) {
        tipB.literal += contentSlice() + '\n';
        tipB.fenceFed = true;
        return;
      }
    }

    // ---- lazy leaf continuation: a fenced code block (or type 1-5 html
    // block) inside list items keeps consuming lines even when an item
    // fails to match, unless a new item of an enclosing list starts here
    if (failedAt !== -1 && newItemListIdx === -1 &&
        ((tipB.t === 'code' && tipB.fenced && tipB.fenceFed && fenceClosesAhead(tipB)) ||
         (tipB.t === 'html' && tipB.htmlType < 6))) {
      let onlyItems = true;
      for (let k = failedAt; k < stack.length - 1; k++) {
        if (stack[k].t !== 'item' && stack[k].t !== 'list') { onlyItems = false; break; }
      }
      if (onlyItems) {
        if (tipB.t === 'code') {
          const info = wsInfo();
          const rest = s.slice(info.endPos);
          const cm = /^(`{3,}|~{3,})[ \t]*$/.exec(rest);
          if (info.cols <= 3 && cm && cm[1][0] === tipB.fenceChar && cm[1].length >= tipB.fenceLen) {
            if (tipB.literal === '\n' || tipB.literal.endsWith('\n\n')) tipB.literal = tipB.literal.slice(0, -1);
            finalizeTop();
            closeTo(matchedIdx);
            return;
          }
          tipB.literal += codeTextFence(contentSlice(), col) + '\n';
          return;
        }
        const lineText = contentSlice();
        const tail = tipB.literal.slice(-200) + '\n' + lineText;
        tipB.literal += '\n' + lineText;
        if (htmlTerminatorFound(tipB, tail)) {
          if (nextRaw === null ? srcNl : nextRaw !== "") tipB.literal += "\n";
          finalizeTop();
          closeTo(matchedIdx);
        }
        return;
      }
    }

    // ---- leaf continuations (only when every container matched)
    if (failedAt === -1) {
      if (tipB.t === 'code' && tipB.fenced) {
        const info = wsInfo();
        const rest = s.slice(info.endPos);
        const cm = /^(`{3,}|~{3,})[ \t]*$/.exec(rest);
        if (info.cols <= 3 && cm && cm[1][0] === tipB.fenceChar && cm[1].length >= tipB.fenceLen) {
          if (tipB.literal === '\n' || tipB.literal.endsWith('\n\n')) tipB.literal = tipB.literal.slice(0, -1);
          finalizeTop();
          return;
        }
        // tilde fences keep their content indentation; backtick fences
        // dedent by the fence's indent
        if (tipB.fenceChar === '`') consumeWsCols(tipB.fenceIndent);
        tipB.literal += codeTextFence(contentSlice(), col) + '\n';
        tipB.fenceFed = true;
        return;
      }
      if (tipB.t === 'code' && !tipB.fenced) {
        if (lineBlank) {
          const rem = s.slice(pos);
          tipB.literal += (/^ +$/.test(rem) && rem.length > 4 ? rem.slice(4) : '') + '\n';
          return;
        }
        if (wsInfo().cols >= 4) {
          consumeWsCols(4);
          tipB.literal += codeText(contentSlice(), col) + '\n';
          return;
        }
        finalizeTop(); // fall through: the line starts something else
      } else if (tipB.t === 'html') {
        if (tipB.htmlType >= 6) {
          if (remWsBlank) finalizeTop(); // then blank handling below
          else { tipB.literal += '\n' + contentSlice(); return; }
        } else {
          const lineText = contentSlice();
          const tail = tipB.literal.slice(-200) + '\n' + lineText;
          tipB.literal += '\n' + lineText;
          if (htmlTerminatorFound(tipB, tail)) {
            if (nextRaw === null ? srcNl : nextRaw !== "") tipB.literal += "\n";
            finalizeTop();
          }
          return;
        }
      } else if (tipB.t === 'table') {
        if (s.slice(pos) === '' || /^ +$/.test(s)) {
          finalizeTop(); // then blank handling below
        } else {
          const info = wsInfo();
          const rest = s.slice(info.endPos);
          if (interruptsParagraph(rest, info)) {
            finalizeTop(); // then block starts below
          } else {
            addTableRow(tipB, contentSlice());
            return;
          }
        }
      }
    } else if (tipB.t === 'code' || tipB.t === 'html' || tipB.t === 'table') {
      // a container above the leaf failed to match: the leaf is closed
      closeTo(matchedIdx);
    }

    // ---- blank line
    if (effBlank) {
      if (tip().t === 'para') finalizeTop();
      // a blank closes a failed quote, but lists/items survive blanks
      if (failedAt !== -1 && stack[failedAt] && stack[failedAt].t === 'quote') closeTo(matchedIdx);
      const t = tip();
      if (t !== doc) {
        t._blankSep = true;
        if (t.t === 'item') t._ownBlank = true;
      }
      return;
    }

    // ---- paragraph conversions and continuation
    if (tip().t === 'para') {
      const para = tip();
      if (failedAt !== -1 && newItemListIdx !== -1) {
        finalizeTop();
        closeTo(matchedIdx);
        blockStarts();
        return;
      }
      // consume complete link reference definitions (deferred when the
      // line could still turn out to be a definition's title)
      {
        const info0 = wsInfo();
        const fc = s[info0.endPos];
        if (fc !== '"' && fc !== "'" && fc !== '(' && stripDefsText(para) === 'removed') {
          // the paragraph was entirely definitions: remove it
          stack.pop(); baseStack.pop();
          tip().children.pop();
          if (failedAt === -1) closeTo(matchedIdx);
          blockStarts();
          return;
        }
      }
      if (failedAt !== -1) {
        // lazy continuation: the line's content is the remainder after
        // the containers that did match (an open paragraph implies no
        // blank line has intervened)
        const savePos = pos, saveCol = col, savePad = pad;
        const infoL = wsInfo();
        const restL = s.slice(infoL.endPos);
        let interrupt;
        if (stack[failedAt].t === 'item') {
          const lmL = listMarkerData(restL, infoL.endCol);
          if (lmL && infoL.endCol - baseStack[failedAt - 1] <= 3) interrupt = true;
          else if (lmL) interrupt = interruptsParagraph(restL, infoL, false);
          else interrupt = interruptsParagraph(restL, infoL);
        } else {
          interrupt = interruptsParagraph(restL, infoL);
        }
        if (interrupt) {
          pos = savePos; col = saveCol; pad = savePad;
          finalizeTop();
          closeTo(matchedIdx);
          blockStarts();
          return;
        }
        if (stack[failedAt].t === 'quote') {
          // a lazy line inside a quote gives up the marker's columns
          let c4 = 0;
          while (pos < s.length && c4 < 4) {
            if (s[pos] === ' ') { pos++; c4++; }
            else if (s[pos] === '\t') { const w = 4 - (c4 % 4); if (c4 + w > 4) break; pos++; c4 += w; }
            else break;
          }
        }
        para.text += '\n' + contentSlice();
        return;
      }
      const info = wsInfo();
      const rest = s.slice(info.endPos);
      if (info.cols < 4) {
        if (tryTableConvert(para, rest)) return;
        if (/^(=+|-+)[ \t]*$/.test(rest)) {
          para.t = 'heading';
          para.level = rest[0] === '=' ? 1 : 2;
          para.text = para.text.trim();
          finalizeTop();
          return;
        }
      }
      if (interruptsParagraph(rest, info)) {
        finalizeTop();
        closeTo(matchedIdx);
        blockStarts();
        return;
      }
      para.text += '\n' + contentSlice();
      return;
    }

    closeTo(matchedIdx);
    blockStarts();
    return;

    // ---------------------------------------------------- block starts
    function blockStarts() {
      while (true) {
        const t = tip();
        if (t.t !== 'doc' && t.t !== 'quote' && t.t !== 'list' && t.t !== 'item') break;
        const info = wsInfo();
        const rest = s.slice(info.endPos);
        // blockquote
        if (info.cols <= 3 && rest[0] === '>') {
          pos = info.endPos + 1; col = info.endCol + 1; pad = 0;
          if (s[pos] === ' ') { pos++; col++; }
          else if (s[pos] === '\t') { pad = 3 - (col % 4); pos++; col++; }
          openBlock(newBlock('quote'));
          baseStack[stack.length - 1] = col;
          quoteColAt[stack.length - 1] = info.endCol;
          continue;
        }
        // ATX heading
        if (info.cols <= 3) {
          const m = /^(#{1,6})(?:[ \t]+(.*))?$/.exec(rest);
          if (m) {
            let text = m[2] || '';
            text = text.replace(/[ \t]+#+[ \t]*$/, '').replace(/[ \t]+$/, '');
            if (/^#+$/.test(text)) text = '';
            const h = newBlock('heading');
            h.level = m[1].length;
            h.text = text;
            openBlock(h);
            finalizeTop();
            return;
          }
        }
        // fenced code
        if (info.cols <= 3) {
          const m = /^(`{3,}|~{3,})(.*)$/.exec(rest);
          if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
            const c = newBlock('code');
            c.fenced = true;
            c.fenceChar = m[1][0];
            c.fenceLen = m[1].length;
            c.fenceIndent = info.cols;
            c.info = m[2].trim();
            c.literal = '';
            openBlock(c);
            return;
          }
        }
        // HTML block
        if (info.cols <= 3) {
          const ht = matchHtmlBlockStart(rest);
          if (ht) {
            const hb = newBlock('html');
            hb.htmlType = ht;
            hb.literal = contentSlice();
            openBlock(hb);
            if (ht < 6 && htmlTerminatorFound(hb, hb.literal)) {
              if (nextRaw === null ? srcNl : nextRaw !== "") hb.literal += "\n";
              finalizeTop();
            }
            return;
          }
        }
        // thematic break
        if (info.cols <= 3 &&
            /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})[ \t]*$/.test(rest)) {
          openBlock(newBlock('hr'));
          finalizeTop();
          return;
        }
        // list item
        const lm = info.cols <= 3 ? listMarkerData(rest, info.endCol) : null;
        if (lm) {
          applyListStart(lm, info);
          continue;
        }
        // link reference definition
        if (info.cols <= 3 && rest[0] === '[') {
          const d = parseDef(rest);
          if (d && /^[ \t]*$/.test(rest.slice(d.endPos))) {
            if (!refs.has(d.label)) {
              refs.set(d.label, { href: d.href, title: d.title });
              if (d.title === null) pendingDef = refs.get(d.label);
            } else if (d.title === null) {
              // a duplicate definition still absorbs a title line
              pendingDef = { title: null };
            }
            return;
          }
        }
        // indented code
        if (info.cols >= 4) {
          consumeWsCols(4);
          const c = newBlock('code');
          c.fenced = false;
          c.literal = codeText(contentSlice(), col) + '\n';
          openBlock(c);
          return;
        }
        break;
      }
      // paragraph
      const t = tip();
      if (t.t === 'doc' || t.t === 'quote' || t.t === 'item') {
        if (/^[ \t]*$/.test(contentSlice())) return; // never a para from blank
        const p = newBlock('para');
        p.text = contentSlice();
        openBlock(p);
      }
    }
  }

  for (let li = 0; li < lines.length; li++) {
    curLineIdx = li;
    processLine(lines[li], li + 1 < lines.length ? lines[li + 1] : null);
  }
  closeTo(0, true);
  return doc;
}

// --------------------------------------------------------- inline parsing

const RE_ENTITY = /^&(?:#(\d+)|#[xX]([0-9A-Fa-f]+)|([A-Za-z][A-Za-z0-9]*));/;
const RE_AUTOLINK = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/;
const RE_EMAIL_AUTOLINK = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)>/;
const RE_URL_EXT = /^(?:[Hh][Tt][Tt][Pp][Ss]?:\/\/|www\.)[^\s<]+/;
const RE_SCHEME_EXT = /^(?:mailto|xmpp):[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+(?:\/[^\s/<]+)?/i;
const EMAIL_SRC = "[A-Za-z0-9.!#$%&'*+\\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+";
const RE_SCHEME_RUN = new RegExp('(?:mailto|xmpp):' + EMAIL_SRC + '(?:\\/[^\\s/<]+)?', 'yi');
const RE_EMAIL_RUN = new RegExp(EMAIL_SRC, 'y');
const RE_SPECIAL = /[\\`&<[\]!*_~\n]/;

function inlineParse(text, refs) {
  const nodes = [];
  const delims = [];   // { node, char, len, canOpen, canClose }
  const brackets = []; // { node, image, active, srcPos, delimCount }
  const n = text.length;
  let i = 0;

  function pushText(s) {
    if (!s) return;
    const last = nodes[nodes.length - 1];
    if (last && last.k === 'text' && !last.delim && !last.bracket) last.s += s;
    else nodes.push({ k: 'text', s });
  }
  function pushNode(node) { nodes.push(node); return node; }
  function flattenExtAutolinks(list) {
    for (let k = 0; k < list.length; k++) {
      const nd = list[k];
      if (nd.k === 'link' && nd.auto === 'ext') list[k] = nd.children[0];
      else if (nd.children) flattenExtAutolinks(nd.children);
    }
  }

  function skipInlineWs(str, j) {
    while (str[j] === ' ' || str[j] === '\t' || str[j] === '\n') j++;
    return j;
  }

  // GFM extended autolink trimming
  function trimAutolink(url) {
    let u = url;
    while (u.length) {
      const last = u[u.length - 1];
      if (last === ';') {
        const em = /&[A-Za-z#][A-Za-z0-9#]*;$/.exec(u);
        if (em) { u = u.slice(0, u.length - em[0].length); continue; }
        u = u.slice(0, -1); continue;
      }
      if ('?!.,:*_~'.includes(last) || last === "'" || last === '"') { u = u.slice(0, -1); continue; }
      if (last === ')') {
        let open = 0, close = 0;
        for (const ch of u) { if (ch === '(') open++; else if (ch === ')') close++; }
        if (close > open) { u = u.slice(0, -1); continue; }
      }
      if (last === ']') {
        let open = 0, close = 0;
        for (const ch of u) { if (ch === '[') open++; else if (ch === ']') close++; }
        if (close > open) { u = u.slice(0, -1); continue; }
      }
      break;
    }
    return u;
  }

  function processEmphasis(bottomCount) {
    let closerIdx = bottomCount;
    while (closerIdx < delims.length) {
      const closer = delims[closerIdx];
      if (!closer.canClose || closer.len === 0) { closerIdx++; continue; }
      let openerIdx = -1;
      for (let k = closerIdx - 1; k >= bottomCount; k--) {
        const op = delims[k];
        if (op.char !== closer.char || !op.canOpen || op.len === 0) continue;
        if ((closer.canOpen || op.canClose) &&
            (op.len + closer.len) % 3 === 0 && !(op.len % 3 === 0 && closer.len % 3 === 0)) continue;
        if (op.char === '~' && !((op.len >= 2 && closer.len >= 2) || (op.len === 1 && closer.len === 1))) continue;
        if (op.char !== '~' && closer.len === 1 && op.len >= 2) {
          // a length-1 closer cannot reach back across a formed emphasis
          // element to take one unit of a longer opener
          const oi0 = nodes.indexOf(op.node), ci0 = nodes.indexOf(closer.node);
          let spans = false;
          for (let q = oi0 + 1; q < ci0; q++) {
            const kk = nodes[q].k;
            if (kk === 'em' || kk === 'strong' || kk === 'del') { spans = true; break; }
          }
          if (spans) continue;
        }
        if (op.char === '*' && op.len === 1 && closer.len === 1) {
          // an em cannot span a strong that is spaced before it but
          // glued to a word character after it
          const oi0 = nodes.indexOf(op.node), ci0 = nodes.indexOf(closer.node);
          let blocked = false;
          for (let q = oi0 + 1; q < ci0; q++) {
            if (nodes[q].k !== 'strong') continue;
            const beforeNode = nodes[q - 1];
            const afterNode = nodes[q + 1];
            const beforeChar = beforeNode && beforeNode.k === 'text'
              ? beforeNode.s[beforeNode.s.length - 1] : '';
            const afterChar = afterNode && afterNode.k === 'text'
              ? afterNode.s[0] : '';
            if (beforeChar === ' ' && /[A-Za-z0-9]/.test(afterChar || '')) { blocked = true; break; }
          }
          if (blocked) { op.len = 0; openerIdx = -2; break; }
        }
        openerIdx = k; break;
      }
      if (openerIdx === -2) { closerIdx++; continue; }
      if (openerIdx === -1) {
        if (!closer.canOpen) delims.splice(closerIdx, 1);
        else closerIdx++;
        continue;
      }
      const opener = delims[openerIdx];
      const use = opener.char === '~' ? (opener.len >= 2 ? 2 : 1)
        : (opener.len >= 2 && closer.len >= 2 ? 2 : 1);
      opener.len -= use;
      closer.len -= use;
      opener.node.s = opener.node.s.slice(0, opener.node.s.length - use);
      closer.node.s = closer.node.s.slice(use);
      const oi = nodes.indexOf(opener.node);
      const ci = nodes.indexOf(closer.node);
      const inner = nodes.splice(oi + 1, ci - oi - 1);
      nodes.splice(oi + 1, 0, {
        k: opener.char === '~' ? 'del' : (use === 2 ? 'strong' : 'em'),
        children: inner,
      });
      delims.splice(openerIdx + 1, closerIdx - openerIdx - 1);
      closerIdx = openerIdx + 1;
      if (closer.len === 0) {
        nodes.splice(nodes.indexOf(closer.node), 1);
        delims.splice(closerIdx, 1);
      }
      if (opener.len === 0) {
        nodes.splice(nodes.indexOf(opener.node), 1);
        delims.splice(openerIdx, 1);
        closerIdx--;
      }
      if (closer.len > 0) closerIdx = delims.indexOf(closer);
      if (closerIdx < bottomCount) closerIdx = bottomCount;
    }
  }

  // try to form a link/image at a ']' (position pos in text, bracket br)
  function handleBracket(br, pos) {
    // a label holding an odd number of backtick runs never forms a link
    // in the reference: the unmatched '`' poisons the label scan
    {
      let cnt = 0, lastRunEnd = -1;
      for (let q = br.srcPos + (br.image ? 2 : 1); q < pos; q++) {
        if (text[q] === '\\') { q++; continue; }
        if (text[q] === '`') { cnt++; while (text[q + 1] === '`') q++; lastRunEnd = q + 1; }
      }
      if (cnt % 2 === 1 && lastRunEnd !== pos) {
        brackets.pop();
        pushText(']');
        return pos + 1;
      }
    }
    let link = null, end = -1;
    const after = pos + 1;
    if (text[after] === '(') {
      let j = skipInlineWs(text, after + 1);
      if (text[j] === ')') {
        link = { href: '', title: null };
        end = j + 1;
      } else {
        const d = parseDestAt(text, j);
        if (d) {
          j = skipInlineWs(text, d.endPos);
          let title = null, ok = true;
          if (text[j] === '"' || text[j] === "'" || text[j] === '(') {
            if (j === d.endPos) ok = false; // title needs separation
            else {
              const t = parseTitleAt(text, j);
              if (!t) ok = false;
              else { title = t.title; j = skipInlineWs(text, t.endPos); }
            }
          }
          if (ok && text[j] === ')') {
            link = { href: d.href, title };
            end = j + 1;
          }
        }
      }
    }
    if (!link) {
      // reference forms
      const rawBetween = text.slice(br.srcPos + (br.image ? 2 : 1), pos);
      let label = null, refEnd = -1;
      if (text[after] === '[') {
        // find the closing ']' of the second bracket
        let k = after + 1;
        while (k < n) {
          if (text[k] === '\\') { k += 2; continue; }
          if (text[k] === ']') break;
          if (text[k] === '[') { k = -1; break; }
          k++;
        }
        if (k > 0 && text[k] === ']') {
          const second = text.slice(after + 1, k);
          label = second === '' ? rawBetween : second;
          refEnd = k + 1;
        }
      } else {
        label = rawBetween;
        refEnd = after;
      }
      if (label !== null) {
        const key = normalizeLabel(label);
        const ref = key === '' ? undefined : refs.get(key);
        if (ref) {
          link = { href: ref.href, title: ref.title };
          end = refEnd;
        }
      }
    }
    if (!link) {
      brackets.pop();
      pushText(']');
      return pos + 1;
    }
    processEmphasis(br.delimCount);
    delims.length = br.delimCount;
    const bi = nodes.indexOf(br.node);
    nodes.splice(bi, 1);
    const children = nodes.splice(bi);
    if (!br.image) flattenExtAutolinks(children);
    const linkNode = { k: br.image ? 'img' : 'link', href: link.href, title: link.title, children };
    if (br.image) linkNode.alt = plainText(children);
    nodes.push(linkNode);
    brackets.pop();
    if (!br.image) for (const b of brackets) if (!b.image) b.active = false;
    return end;
  }

  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      const nx = text[i + 1];
      if (nx === '\n') {
        pushNode({ k: 'br' });
        i += 2;
        while (text[i] === ' ' || text[i] === '\t') i++; // spaces after a hard break drop
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) { pushText(nx); i += 2; continue; }
      pushText('\\'); i++; continue;
    }
    if (c === '`') {
      let run = 0;
      while (text[i + run] === '`') run++;
      // find a closing run of exactly the same length; a multi-backtick
      // run inside a full-reference bracket does not cross its ']['
      let j = i + run, closeAt = -1;
      while (j < n) {
        if (text[j] === ']' && brackets.length) {
          if (run >= 2 && text[j + 1] === '[') break;
          // a ']' bounds the search when the bracket's text so far
          // (including this run) holds an even number of backtick runs:
          // the would-be link text is then backtick-balanced
          const br = brackets[brackets.length - 1];
          const cs = br.srcPos + (br.image ? 2 : 1);
          let cnt = 0;
          for (let q = cs; q < j; q++) {
            if (text[q] === '`') { cnt++; while (text[q + 1] === '`') q++; }
          }
          if (cnt % 2 === 0) break;
        }
        if (text[j] === '`') {
          let r2 = 0;
          while (text[j + r2] === '`') r2++;
          if (r2 === run) { closeAt = j; break; }
          j += r2;
        } else j++;
      }
      if (closeAt === -1) { pushText(text.slice(i, i + run)); i += run; continue; }
      let content = text.slice(i + run, closeAt).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' &&
          /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      pushNode({ k: 'code', s: content });
      i = closeAt + run;
      continue;
    }
    if (c === '&') {
      const m = RE_ENTITY.exec(text.slice(i, i + 40));
      if (m) {
        if (m[3] !== undefined) pushNode({ k: 'entity', s: m[0] });
        else {
          const cp = m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2], 16);
          if (cp > 0x10FFFF) pushText(m[0]); // out of range: literal text
          else pushText(codePointToChar(cp));
        }
        i += m[0].length;
        continue;
      }
      // fall through to the text run (which will emit the '&' alone)
    }
    if (c === '<') {
      let m = RE_AUTOLINK.exec(text.slice(i));
      if (m) {
        pushNode({ k: 'link', href: cleanUrl(decodeNumericRefs(m[1])), title: null, auto: 'angle', children: [{ k: 'text', s: m[1] }] });
        i += m[0].length; continue;
      }
      m = RE_EMAIL_AUTOLINK.exec(text.slice(i));
      if (m) {
        pushNode({ k: 'link', href: 'mailto:' + m[1], title: null, auto: 'angle', children: [{ k: 'text', s: m[1] }] });
        i += m[0].length; continue;
      }
      const rest = text.slice(i);
      let html = null;
      if (rest.startsWith('<!--')) {
        const mm = /^<!--(?:->|>)/.exec(rest) || /^<!--(?:[^-]|-(?!->))*-->/.exec(rest);
        if (mm) html = mm[0];
      } else if (rest.startsWith('<?')) {
        const e = rest.indexOf('?>');
        if (e !== -1) html = rest.slice(0, e + 2);
      } else if (rest.startsWith('<![CDATA[')) {
        const e = rest.indexOf(']]>');
        if (e !== -1) html = rest.slice(0, e + 3);
      } else if (/^<![A-Za-z]/.test(rest)) {
        const e = rest.indexOf('>');
        if (e !== -1) html = rest.slice(0, e + 1);
      } else {
        const end = matchTag(text, i);
        if (end) html = text.slice(i, end);
      }
      if (html !== null) { pushNode({ k: 'html', s: html }); i += html.length; continue; }
      // fall through: literal '<' in a text run
    }
    if (c === '!' && text[i + 1] === '[') {
      const node = pushNode({ k: 'text', s: '![', bracket: true });
      brackets.push({ node, image: true, active: true, srcPos: i, delimCount: delims.length });
      i += 2; continue;
    }
    if (c === '[') {
      const node = pushNode({ k: 'text', s: '[', bracket: true });
      brackets.push({ node, image: false, active: true, srcPos: i, delimCount: delims.length });
      i++; continue;
    }
    if (c === ']') {
      const br = brackets[brackets.length - 1];
      if (!br) { pushText(']'); i++; continue; }
      if (!br.active) {
        // a bracket deactivated by an inner link: ']' is literal text
        brackets.pop();
        pushText(']');
        i++; continue;
      }
      i = handleBracket(br, i);
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let run = 0;
      while (text[i + run] === c) run++;
      if (c === '~' && run >= 3) { pushText(text.slice(i, i + run)); i += run; continue; }
      const before = i === 0 ? '\n' : text[i - 1];
      const after = i + run >= n ? '\n' : text[i + run];
      let canOpen, canClose;
      if (c === '~') {
        const lf = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
        const rf = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
        canOpen = lf;
        canClose = rf;
      } else {
        const leftFlanking = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
        const rightFlanking = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
        if (c === '*') { canOpen = leftFlanking; canClose = rightFlanking; }
        else {
          canOpen = leftFlanking && (!rightFlanking || isPunct(before));
          canClose = rightFlanking && (!leftFlanking || isPunct(after));
        }
      }
      const node = pushNode({ k: 'text', s: text.slice(i, i + run), delim: true });
      delims.push({ node, char: c, len: run, canOpen, canClose });
      i += run; continue;
    }
    if (c === '\n') {
      const last = nodes[nodes.length - 1];
      if (last && last.k === 'text' && !last.delim) {
        const sp = / +$/.exec(last.s);
        if (sp && sp[0].length >= 2) {
          last.s = last.s.slice(0, last.s.length - sp[0].length);
          pushNode({ k: 'br' });
          i++;
          while (text[i] === ' ' || text[i] === '\t') i++; // spaces after a hard break drop
          continue;
        }
      }
      pushText('\n');
      i++; continue;
    }
    // GFM extended autolink (URL and scheme forms) at a word boundary;
    // these also fire inside link text (nested links), unlike bare emails
    if ('hwmxHWMX'.includes(c)) {
      const prevCh = i === 0 ? '\n' : text[i - 1];
      if (isSpace(prevCh) || '*_~([{\'"<'.includes(prevCh)) {
        if (c === 'm' || c === 'x' || c === 'M' || c === 'X') {
          const sm = RE_SCHEME_EXT.exec(text.slice(i));
          if (sm && text[i + sm[0].length] !== '-' && text[i + sm[0].length] !== '_') {
            pushNode({ k: 'link', href: sm[0], title: null, auto: 'ext', raw: sm[0], children: [{ k: 'text', s: sm[0] }] });
            i += sm[0].length;
            continue;
          }
        }
        const um = RE_URL_EXT.exec(text.slice(i));
        if (um) {
          // an unmatched ']' ends the autolink candidate
          let raw = um[0], depth = 0;
          for (let q = 0; q < raw.length; q++) {
            if (raw[q] === '[') depth++;
            else if (raw[q] === ']') {
              if (depth === 0) { raw = raw.slice(0, q); break; }
              depth--;
            }
          }
          const url = trimAutolink(raw);
          const urlLow = url.toLowerCase();
          let ok = url !== '' && urlLow !== 'http://' && urlLow !== 'https://';
          if (ok && urlLow.startsWith('www.') && !/^www\.[^\s.]+\.[^\s]+/i.test(url)) ok = false;
          if (ok) {
            pushNode({ k: 'link', href: cleanUrl(urlLow.startsWith('www.') ? 'http://' + url : url), title: null, auto: 'ext', raw, children: [{ k: 'text', s: url }] });
            i += url.length;
            continue;
          }
        }
      }
    }
    // plain text run (with GFM email autolink splitting)
    let j = i;
    while (j < n) {
      const ch = text[j];
      if (RE_SPECIAL.test(ch)) {
        // an intraword _ or ~ can neither emphasise nor strike: it is text
        if ((ch === '_' || ch === '~') && j > 0 && j + 1 < n &&
            /[A-Za-z0-9]/.test(text[j - 1]) && /[A-Za-z0-9]/.test(text[j + 1])) { j++; continue; }
        break;
      }
      if ('hwHW'.includes(ch) && j > i) {
        const prevCh = text[j - 1];
        if ((isSpace(prevCh) || '*_~([{\'"<'.includes(prevCh)) &&
            /^(?:[Hh][Tt][Tt][Pp][Ss]?:\/\/|www\.)/.test(text.slice(j))) break;
      }
      j++;
    }
    if (j === i) { pushText(c); i++; continue; }
    const run = text.slice(i, j);
    if (brackets.length === 0) {
      i = appendWithAutolinks(run, i);
    } else {
      pushText(run);
      i = j;
    }
  }

  processEmphasis(0);
  return nodes;

  // Split a plain text run at GFM autolinks: bare emails and the
  // mailto:/xmpp: scheme forms.
  function appendWithAutolinks(run, base) {
    let k = 0, textStart = 0;
    while (k < run.length) {
      const prevCh = k === 0 ? (base === 0 ? '\n' : text[base - 1]) : run[k - 1];
      if (isSpace(prevCh) || '*_~([{\'"<'.includes(prevCh)) {
        RE_SCHEME_RUN.lastIndex = k;
        let m = RE_SCHEME_RUN.exec(run);
        let href = null;
        if (m) href = m[0];
        else {
          RE_EMAIL_RUN.lastIndex = k;
          m = RE_EMAIL_RUN.exec(run);
          if (m) href = 'mailto:' + m[0];
        }
        // an address immediately followed by - or _ is not an autolink,
        // unless the _ is an emphasis closer (an opener is pending)
        if (m) {
          const endAt = k + m[0].length;
          const nextCh = endAt < run.length ? run[endAt] : text[base + run.length];
          if (nextCh === '-' || (nextCh === '_' && !delims.some(d => d.char === '_' && d.canOpen && d.len > 0))) m = null;
        }
        if (m) {
          if (k > textStart) pushText(run.slice(textStart, k));
          pushNode({ k: 'link', href, title: null, auto: 'ext', raw: m[0], children: [{ k: 'text', s: m[0] }] });
          k += m[0].length;
          textStart = k;
          continue;
        }
      }
      k++;
    }
    if (textStart < run.length) pushText(run.slice(textStart));
    return base + run.length;
  }
}

function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 'text': out += nd.s; break;
      case 'entity': out += nd.s; break;
      case 'code': out += nd.s; break;
      case 'br': out += ' '; break;
      case 'html': break;
      default: if (nd.children) out += plainText(nd.children);
    }
  }
  return out;
}

// ------------------------------------------------------------ rendering

function renderNodes(nodes, refs) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.k) {
      case 'text': out += escapeText(nd.s); break;
      case 'entity': out += nd.s; break;
      case 'code': out += '<code>' + escapeCode(nd.s) + '</code>'; break;
      case 'br': out += '<br>'; break;
      case 'html': out += nd.s; break;
      case 'em': out += '<em>' + renderNodes(nd.children, refs) + '</em>'; break;
      case 'strong': out += '<strong>' + renderNodes(nd.children, refs) + '</strong>'; break;
      case 'del': out += '<del>' + renderNodes(nd.children, refs) + '</del>'; break;
      case 'link':
        out += '<a href="' + escapeAttr(nd.href) + '"' +
          (nd.title !== null && nd.title !== undefined ? ' title="' + escapeAttr(nd.title) + '"' : '') +
          '>' + renderNodes(nd.children, refs) + '</a>';
        break;
      case 'img':
        out += '<img src="' + escapeAttr(nd.href) + '" alt="' + escapeAttr(nd.alt || '') + '"' +
          (nd.title !== null && nd.title !== undefined ? ' title="' + escapeAttr(nd.title) + '"' : '') + '>';
        break;
    }
  }
  return out;
}

function renderInline(text, refs) {
  return renderNodes(inlineParse(text, refs), refs);
}

function renderPara(para, refs, opts) {
  const inner = (opts.prefix || '') + renderInline(para.text.slice(opts.skip || 0), refs);
  return opts.tight ? inner : '<p>' + inner + '</p>\n';
}

function renderBlock(b, refs) {
  if (b.dead) return '';
  switch (b.t) {
    case 'doc':
      return b.children.map(c => renderBlock(c, refs)).join('');
    case 'para':
      return '<p>' + renderInline(b.text, refs) + '</p>\n';
    case 'heading':
      return '<h' + b.level + '>' + renderInline(b.text, refs) + '</h' + b.level + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'quote':
      return '<blockquote>\n' + b.children.map(c => renderBlock(c, refs)).join('') + '</blockquote>\n';
    case 'code': {
      const info = b.info ? unescapeStr(b.info).split(/\s+/)[0] : '';
      return '<pre><code' + (info ? ' class="language-' + escapeAttr(info) + '"' : '') + '>' +
        escapeCode(b.literal) + '</code></pre>\n';
    }
    case 'html':
      return b.literal;
    case 'list': {
      let out = b.ordered
        ? '<ol' + (b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n'
        : '<ul>\n';
      for (const item of b.children) out += renderItem(item, refs, !b.loose);
      return out + (b.ordered ? '</ol>\n' : '</ul>\n');
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < b.header.length; k++) {
        out += '<th' + (b.aligns[k] ? ' align="' + b.aligns[k] + '"' : '') + '>' +
          renderInline(b.header[k], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let k = 0; k < row.length; k++) {
            out += '<td' + (b.aligns[k] ? ' align="' + b.aligns[k] + '"' : '') + '>' +
              renderInline(row[k], refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    default:
      return '';
  }
}

function renderItem(item, refs, tight) {
  if (item.dead) return '';
  let out = '<li>';
  const kids = item.children;
  for (let ci = 0; ci < kids.length; ci++) {
    const c = kids[ci];
    if (c.dead) continue;
    if (c.t === 'para') {
      let prefix = '', skip = 0;
      if (ci === 0) {
        const m = /^\[([ xX])\] /.exec(c.text);
        if (m) {
          prefix = m[1] === ' '
            ? '<input disabled="" type="checkbox"> '
            : '<input checked="" disabled="" type="checkbox"> ';
          skip = 4;
        }
      }
      out += renderPara(c, refs, { tight, prefix, skip });
    } else {
      out += renderBlock(c, refs);
    }
  }
  return out + '</li>\n';
}

// ---------------------------------------------------------------- parse

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const refs = new Map();
  const doc = blockParse(src, refs);
  return renderBlock(doc, refs);
}
