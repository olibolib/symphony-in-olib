import { pick } from '../util/random';
import type { Typesetter } from '../text/Typesetter';

/**
 * Which elements a layer touches. DESIGN.md §11.5.
 *
 * Half of what an effect used to be. `glitchWords` was *5% of words* welded to *apply a
 * glitch*; this file is the first half on its own, so the same selection can drive any
 * treatment — which is what makes "invert every instance of the letter e" expressible.
 */

export type Slice = 'char' | 'word' | 'sentence' | 'paragraph' | 'block';

/**
 * The stored form. The `apply()` sugar in §11.5 normalises to this, so `{ word: '5%' }`
 * arrives here as `{ slice: 'word', proportion: 0.05 }`.
 *
 * A proportion and a count are separate fields rather than one number interpreted by type:
 * JavaScript has a single number type, so `1` and `1.0` are indistinguishable, and the
 * collision would land on exactly the value you reach for when you want all of them.
 */
export type Target =
  | { readonly match: string }
  | { readonly slice: Slice; readonly proportion: number }
  | { readonly slice: Slice; readonly count: number }
  | { readonly slice: Slice; readonly every: number };

/**
 * Resolve a target to the elements a treatment can be written to.
 *
 * Always returns `<w>` or `<c>` elements, never a `<p>` or a block — those are *grouping*
 * for selection, not things that get styled. Selecting by paragraph means "every word in
 * these paragraphs", which is what `glitchParagraphs` did and what reads correctly: a
 * paragraph with a background but uncoloured words looks like a bug rather than a look.
 */
export function resolve(
  target: Target,
  typesetter: Typesetter,
  boxed = false,
): readonly HTMLElement[] {
  if ('match' in target) return matching(target.match, typesetter);

  const groups = groupsOf(target.slice, typesetter, boxed);
  if (groups.length === 0) return [];

  if ('every' in target) {
    const step = Math.max(1, Math.floor(target.every));
    return flatten(groups.filter((_, i) => i % step === 0));
  }

  if ('count' in target) {
    // Sampled with replacement, matching what `pick` in a loop did before. Duplicates are
    // harmless — writing the same channel twice is idempotent — and rejection sampling
    // would spin when the count exceeds what is on screen.
    const wanted = Math.max(0, Math.floor(target.count));
    const chosen: HTMLElement[][] = [];
    for (let i = 0; i < wanted; i++) {
      const group = pick(groups);
      if (group) chosen.push(group);
    }
    return flatten(chosen);
  }

  const proportion = clamp01(target.proportion);
  return flatten(groups.filter(() => Math.random() < proportion));
}

/**
 * Every instance of one character on the stage.
 *
 * The best effect inherited from Acid, and the reason characters are addressable at all: it
 * reads as systematic corruption of the alphabet rather than as noise on the screen.
 *
 * An empty string means "pick a character at random and use every instance of that", which
 * is what `glitchChars` did with no argument.
 */
function matching(text: string, typesetter: Typesetter): readonly HTMLElement[] {
  const { chars } = typesetter;
  if (chars.length === 0) return [];

  const wanted = text.length > 0 ? text : (pick(chars)?.textContent ?? '');
  if (wanted.length === 0) return [];

  const codes = new Set<string>();
  for (const char of wanted) codes.add(String(char.charCodeAt(0)));

  return chars.filter((el) => {
    const code = el.dataset['ch'];
    return code !== undefined && codes.has(code);
  });
}

/**
 * The units a slice selects *by*, each carrying the elements it would light.
 *
 * `char` and `word` produce one-element groups, so proportion and count mean the obvious
 * thing. `sentence`, `paragraph` and `block` produce many, so choosing one lights all of it —
 * the heavier gesture that made `glitchParagraphs` feel different from `glitchWords`.
 *
 * A `<p>` is a *line*, not a sentence: a sentence can run to several, and `sentence` selects
 * whole thoughts where `paragraph` selects however the text happened to break.
 */
function groupsOf(
  slice: Slice,
  typesetter: Typesetter,
  boxed: boolean,
): readonly HTMLElement[][] {
  const inside = boxed ? boxOf : treatable;

  switch (slice) {
    case 'char':
      return typesetter.chars.map((el) => [el]);

    case 'word':
      return typesetter.words.map((el) => [el]);

    case 'sentence':
      return typesetter.sentences.map(inside);

    case 'paragraph':
      return typesetter.paragraphs.map(inside);

    case 'block':
      return typesetter.blocks.map(inside);
  }
}

/**
 * The treatable elements inside a container.
 *
 * Characters when the text was split, words when it was not — the same rule
 * `Typesetter.targets` follows, so a preset with `splitChars: false` still works and simply
 * operates at word granularity.
 */
/**
 * The elements inside a grouping element that a treatment can be written to.
 *
 * Selecting by paragraph means "every word in these paragraphs", which is what reads correctly
 * for a *mark*: a paragraph with a background but uncoloured words looks like a bug rather than
 * a look.
 */
function treatable(root: HTMLElement): HTMLElement[] {
  const chars = root.querySelectorAll<HTMLElement>('c');
  if (chars.length > 0) return Array.from(chars);
  return Array.from(root.querySelectorAll<HTMLElement>('w'));
}

/**
 * The grouping element itself, for a treatment that draws a **box** rather than marking text.
 *
 * `outline` is the whole of that list. Selecting a paragraph and outlining every word in it
 * gives a box round each word, which is a different effect and not the one anyone asks for by
 * outlining a paragraph. The rest of the vocabulary marks the type — an inversion, an accent, a
 * dingbat — and those genuinely do want every word.
 *
 * A sentence is skipped even so: `<sn>` is `display: contents`, an element with no box of its
 * own precisely so it does not disturb the flow layouts, so there is nothing to draw round.
 */
function boxOf(root: HTMLElement): HTMLElement[] {
  return root.tagName === 'SN' ? treatable(root) : [root];
}

function flatten(groups: readonly HTMLElement[][]): readonly HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const group of groups) out.push(...group);
  return out;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
