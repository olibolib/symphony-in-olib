/**
 * Verify every element id the HUD requires actually exists in index.html.
 *
 * TypeScript cannot check this: the HUD finds its elements by string selector, so removing
 * an element from the markup is invisible to the compiler and throws at runtime — inside a
 * constructor, before any error handling is wired, which kills the whole app silently.
 *
 * That happened once (`#options` was replaced by tabbed panels and the lookup left behind),
 * and the symptom was "nothing works" with no error anywhere. Hence this.
 */

import { readFileSync } from 'node:fs';

const html = readFileSync('index.html', 'utf8');
const sources = ['src/hud/Hud.ts', 'src/main.ts'];

const SELECTOR = /(?:must|requireSelect)\([^,]+,\s*'(#[a-zA-Z0-9_-]+)'\)|querySelector<[^>]*>\('(#[a-zA-Z0-9_-]+)'\)|\bel\('(#[a-zA-Z0-9_-]+)'\)/g;

const required = new Map();

for (const file of sources) {
  const code = readFileSync(file, 'utf8');
  for (const match of code.matchAll(SELECTOR)) {
    const id = match[1] ?? match[2] ?? match[3];
    if (id) required.set(id, file);
  }
}

const missing = [...required].filter(([id]) => !html.includes(`id="${id.slice(1)}"`));

if (missing.length > 0) {
  console.error('Missing element ids in index.html:\n');
  for (const [id, file] of missing) console.error(`  ${id}  required by ${file}`);
  console.error('\nThe app would throw at startup and appear to do nothing.');
  process.exit(1);
}

console.log(`check-ids: ${required.size} element ids present`);
