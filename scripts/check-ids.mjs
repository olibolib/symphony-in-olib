/**
 * Verify every element id the renderers require actually exists in their document.
 *
 * TypeScript cannot check this: the code finds its elements by string selector, so removing
 * an element from the markup is invisible to the compiler and throws at runtime — inside a
 * constructor, before any error handling is wired, which kills the whole window silently.
 *
 * That happened once (`#options` was replaced by tabbed panels and the lookup left behind),
 * and the symptom was "nothing works" with no error anywhere. Hence this.
 */

import { readFileSync } from 'node:fs';

// Two windows, two documents. Selectors in Hud.ts and control.ts must exist in control.html;
// selectors in main.ts must exist in index.html.
const documents = {
  'src/hud/Hud.ts': 'control.html',
  'src/control.ts': 'control.html',
  'src/main.ts': 'index.html',
};

const html = Object.fromEntries(
  [...new Set(Object.values(documents))].map((f) => [f, readFileSync(f, 'utf8')]),
);

const SELECTOR =
  /(?:must|requireSelect)\([^,]+,\s*'(#[a-zA-Z0-9_-]+)'\)|querySelector<[^>]*>\('(#[a-zA-Z0-9_-]+)'\)|\bel\('(#[a-zA-Z0-9_-]+)'\)/g;

const required = new Map();

for (const file of Object.keys(documents)) {
  const code = readFileSync(file, 'utf8');
  for (const match of code.matchAll(SELECTOR)) {
    const id = match[1] ?? match[2] ?? match[3];
    if (id) required.set(id, file);
  }
}

const missing = [...required].filter(
  ([id, file]) => !html[documents[file]].includes(`id="${id.slice(1)}"`),
);

if (missing.length > 0) {
  console.error('Missing element ids:');
  for (const [id, file] of missing) {
    console.error(`  ${id}  required by ${file}, absent from ${documents[file]}`);
  }
  console.error('The window would throw at startup and appear to do nothing.');
  process.exit(1);
}

console.log(`check-ids: ${required.size} element ids present across both windows`);
