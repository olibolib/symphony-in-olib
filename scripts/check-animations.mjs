/**
 * Verify every motion keyframe is matched by the code that drives it.
 *
 * Two regexes decide whether an animation is re-timed to the tempo and whether its position
 * survives a re-typeset. Both used to list the keyframe families by name, and both silently
 * stopped covering the wrapping keyframes the moment those were added — so a wrapping block
 * ran at the wrong tempo and teleported back to its anchor on every phrase, for as long as
 * nobody happened to look.
 *
 * Nothing in TypeScript can catch that: the link is a string in a stylesheet.
 */

import { readFileSync } from 'node:fs';

const css = readFileSync('style/stage.css', 'utf8');
const stage = readFileSync('src/render/Stage.ts', 'utf8');
const typesetter = readFileSync('src/text/Typesetter.ts', 'utf8');

const names = [...new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]))];

const pattern = (source, constant) => {
  const found = source.match(new RegExp(`const ${constant} = (/[^;]+/);`));
  if (!found) throw new Error(`could not find ${constant}`);
  return eval(found[1]);
};

const motion = pattern(stage, 'MOTION_ANIMATIONS');
const endless = pattern(typesetter, 'ENDLESS');

const problems = [];

for (const name of names) {
  const moves = name.startsWith('olib-move-');
  if (moves !== motion.test(name)) {
    problems.push(`${name} moves but is not rate-driven — it will ignore the tempo`);
  }
  // Everything that moves needs its position carried, except the deliberate single pass.
  const shouldPersist = moves && !name.includes('sweep');
  if (shouldPersist !== endless.test(name)) {
    problems.push(`${name} should ${shouldPersist ? '' : 'not '}survive a re-typeset`);
  }
}

if (problems.length > 0) {
  console.error('Animation wiring:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`check-animations: ${names.length} keyframes, all matched by the code that drives them`);
