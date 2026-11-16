// Harness driver: render every case in /input/cases.json with the
// parser in ./parse.js and write the HTML strings, in order, as a
// JSON array to /output/html.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

const data = JSON.parse(readFileSync('/input/cases.json', 'utf8'));
const list = Array.isArray(data) ? data : data.cases;
const out: string[] = [];
for (const c of list) {
  const md = typeof c === 'string'
    ? c
    : (c.markdown ?? c.input ?? c.source ?? c.text ?? '');
  out.push(parse(md));
}
mkdirSync('/output', { recursive: true });
writeFileSync('/output/html.json', JSON.stringify(out));
