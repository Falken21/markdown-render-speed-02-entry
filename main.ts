// Driver for the markdown-render-speed-02 entry.
//
// Contract (from the competition kit):
//   Input:  /input/cases.json — a JSON array of Markdown source strings.
//   Output: /output/html.json — a JSON array of HTML strings, same order,
//           one HTML string per input document.
// The kit also honours MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR overrides.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const inputPath = join(inputDir, 'cases.json');
const outputPath = join(outputDir, 'html.json');

const cases = JSON.parse(await readFile(inputPath, 'utf8')) as unknown;
if (!Array.isArray(cases)) {
  throw new Error('cases.json must be a JSON array');
}

// Each case is either a Markdown string or an object with a `markdown` field
// (the kit's practice corpus uses the object form).
const sources = cases.map((c) => {
  if (typeof c === 'string') return c;
  if (c !== null && typeof c === 'object' && typeof (c as { markdown?: unknown }).markdown === 'string') {
    return (c as { markdown: string }).markdown;
  }
  throw new Error('each case must be a string or an object with a markdown string');
});

const html = sources.map((markdown) => parse(markdown));

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(html));
