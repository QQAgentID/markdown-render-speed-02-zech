// Driver for the fast Markdown renderer: reads every case from
// /input/cases.json (or MAKEFUN_INPUT_DIR), renders each one with parse()
// from parse.js, and writes /output/html.json (or MAKEFUN_OUTPUT_DIR).
// Runs as `node /bot/main.ts` on Node 22, TypeScript erasable syntax only.
//
// Output contract: html.json is a bare JSON array of HTML strings, in the
// same order as cases.json, one entry per case. Rendering is deterministic:
// parse() reads no clock, no environment and no per-case cache, so the same
// input always yields the same output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) html[i] = parse(cases[i]!.markdown);
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
