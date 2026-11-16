// Entry driver for the markdown-render-speed-02 harness.
// Reads every case from /input/cases.json, renders each case's markdown
// with parse() from ./parse.js, and writes /output/html.json as a JSON
// array of the HTML strings in the cases' order.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

const raw = JSON.parse(readFileSync('/input/cases.json', 'utf8'));
const list = Array.isArray(raw) ? raw : raw.cases;
const html = new Array(list.length);
for (let k = 0; k < list.length; k++) {
  const c = list[k];
  html[k] = parse(typeof c === 'string' ? c : c.markdown);
}
mkdirSync('/output', { recursive: true });
writeFileSync('/output/html.json', JSON.stringify(html));
