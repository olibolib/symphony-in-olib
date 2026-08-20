import type { Stage } from '../render/Stage';
import { pick, pickSome, randomInt } from '../util/random';
import { sentenceLength, type Sentence, type TextPreset } from './TextSource';

/**
 * Turns a text preset into DOM on the stage, and keeps a registry of what it produced.
 *
 * The element structure follows Acid: paragraphs contain words contain characters. Short
 * custom tag names (`w`, `c`) rather than spans — at several thousand nodes the DOM size is
 * worth caring about, and they give clean CSS selectors. Unknown tags are perfectly legal;
 * the browser treats them as generic inline elements and CSS styles them normally.
 */

/**
 * Selection modes, all of which work in whole sentences.
 *
 * `count` means a number of sentences, never words or lines. Cutting by word count
 * produced fragments ending mid-thought, which reads as a bug rather than an effect.
 */
export type TextMode =
  | 'whole'
  | 'sentence'
  | 'sentences'
  | 'shortSentences'
  | 'longSentences'
  | 'word';

export interface TypesetOptions {
  readonly mode: TextMode;
  /** One element per glyph. Required for character effects; costly at scale. */
  readonly splitChars: boolean;
  /** How many sentences. Never a word or line count. */
  readonly count?: number;
  /** Put each line in its own paragraph, rather than running them together. */
  readonly separateLines?: boolean;
  /** Hard ceiling on elements produced. DESIGN.md §14 — presets declare a budget. */
  readonly maxElements?: number;
  /**
   * How many independent text blocks to place, 1–3.
   *
   * Each block gets its own selection, so they show different text rather than repeating.
   * Blocks are assigned distinct cells of a 3x3 grid, which is what guarantees they cannot
   * overlap — the alternative, positioning them freely and hoping, produces collisions
   * exactly when the text is longest.
   */
  readonly blocks?: number;
}

/** Number of colour slots. Must match the `--c0`..`--c7` variables in CSS (§12.5). */
const COLOUR_SLOTS = 8;

const DEFAULT_MAX_ELEMENTS = 6000;

/**
 * Grid cells a block may occupy: a 3x3 grid with the middle removed.
 *
 * The centre is never used. Composited output usually has its subject there — a logo, a
 * visualiser's focal point — and text landing on it is the fastest way to spoil the frame.
 */
const BLOCK_CELLS: readonly { row: number; col: number }[] = [
  { row: 1, col: 1 }, { row: 1, col: 2 }, { row: 1, col: 3 },
  { row: 2, col: 1 },                     { row: 2, col: 3 },
  { row: 3, col: 1 }, { row: 3, col: 2 }, { row: 3, col: 3 },
];

export class Typesetter {
  private readonly stage: Stage;

  /** Live registries, refreshed on every render so effects never walk a stale DOM. */
  blocks: readonly HTMLElement[] = [];

  /**
   * How many blocks have content that does not fit and is being clipped.
   *
   * Blocks must clip, or they would spill into the protected centre — but §14 says nothing
   * should be lost *silently*. This is reported to the HUD so overfull presets are visible
   * while tuning instead of looking like text that mysteriously failed to appear.
   */
  clipped = 0;
  paragraphs: readonly HTMLElement[] = [];
  words: readonly HTMLElement[] = [];
  chars: readonly HTMLElement[] = [];

  constructor(stage: Stage) {
    this.stage = stage;
  }

  /** Every element that can carry a glitch slot — words when whole, characters when split. */
  get targets(): readonly HTMLElement[] {
    return this.chars.length > 0 ? this.chars : this.words;
  }

  render(preset: TextPreset, options: TypesetOptions): void {
    const blocks = Math.min(3, Math.max(1, options.blocks ?? 1));
    const budget = options.maxElements ?? DEFAULT_MAX_ELEMENTS;

    // Share the element budget across blocks rather than per block, so two blocks cost the
    // same as one rather than twice as much.
    const budgetPerBlock = Math.max(1, Math.floor(budget / blocks));

    const cells = pickSome(BLOCK_CELLS, blocks);
    const parts: string[] = [];

    // `count` is a total across blocks, not per block. Passing the full count to each was a
    // bug: two blocks asking for four sentences produced eight, crammed into cells a third
    // of the stage wide, where the surplus was silently clipped.
    const perBlock = Math.max(1, Math.round((options.count ?? 1) / blocks));

    for (let index = 0; index < blocks; index++) {
      // Each block selects independently, so they show different text.
      const lines = this.select(preset, { ...options, count: perBlock });
      const cell = cells[index] ?? BLOCK_CELLS[0];
      const area = cell ? `grid-area:${cell.row}/${cell.col};` : '';

      parts.push(`<div class="block" data-block="${index}" style="${area}">`);
      parts.push(this.build(lines, options, budgetPerBlock));
      parts.push('</div>');
    }

    // One assignment, not an append per word. Parsing a single string is dramatically
    // faster than thousands of DOM insertions, and it is the difference between a preset
    // change being invisible and being a visible hitch.
    this.stage.container.innerHTML = parts.join('');

    this.refresh();
    this.measureClipping();
  }

  /**
   * One layout read per block, once per re-typeset — a few times a minute, not per frame.
   * That is well inside the §14 rule against reading layout in a loop.
   */
  private measureClipping(): void {
    let clipped = 0;
    for (const block of this.blocks) {
      if (
        block.scrollHeight > block.clientHeight + 1 ||
        block.scrollWidth > block.clientWidth + 1
      ) {
        clipped++;
      }
    }
    this.clipped = clipped;
  }

  clear(): void {
    this.stage.container.innerHTML = '';
    this.refresh();
  }

  private refresh(): void {
    const root = this.stage.container;
    this.blocks = Array.from(root.querySelectorAll<HTMLElement>('.block'));
    this.paragraphs = Array.from(root.querySelectorAll<HTMLElement>('p'));
    this.words = Array.from(root.querySelectorAll<HTMLElement>('w'));
    this.chars = Array.from(root.querySelectorAll<HTMLElement>('c'));
  }

  /** Pick which sentences to show. DESIGN.md §12.3. */
  private select(preset: TextPreset, options: TypesetOptions): readonly Sentence[] {
    const { sentences } = preset;
    if (sentences.length === 0) return [];

    const count = options.count ?? 1;

    switch (options.mode) {
      case 'whole':
        return sentences;

      case 'sentence': {
        const sentence = pick(sentences);
        return sentence ? [sentence] : [];
      }

      case 'word': {
        // The one deliberate fragment: a single word, isolated. Reads as emphasis rather
        // than as truncation, because there is obviously nothing missing.
        const sentence = pick(sentences);
        const line = sentence ? pick(sentence) : undefined;
        const word = line ? pick(line) : undefined;
        return word ? [[[word]]] : [];
      }

      case 'sentences': {
        // Consecutive, so it reads as a passage rather than a shuffle.
        const span = Math.min(count, sentences.length);
        const from = randomInt(Math.max(1, sentences.length - span + 1));
        return sentences.slice(from, from + span);
      }

      case 'shortSentences':
        return this.pickByLength(sentences, count, (x) => sentenceLength(x) <= 12);

      case 'longSentences':
        return this.pickByLength(sentences, count, (x) => sentenceLength(x) > 12);

      default:
        return sentences;
    }
  }

  private pickByLength(
    sentences: readonly Sentence[],
    count: number,
    matches: (sentence: Sentence) => boolean,
  ): readonly Sentence[] {
    const pool = sentences.filter(matches);
    if (pool.length === 0) return sentences.slice(0, count);

    const out: Sentence[] = [];
    for (let i = 0; i < count; i++) {
      const sentence = pick(pool);
      if (sentence) out.push(sentence);
    }
    return out;
  }

  /**
   * Build the markup.
   *
   * The budget is checked *between* sentences, never inside one. Stopping mid-sentence to
   * stay under an element count produces exactly the fragment this whole redesign exists to
   * avoid — so a sentence is either rendered whole or not at all.
   *
   * The first sentence always renders even if it alone exceeds the budget: a blank stage is
   * a worse failure than a busy one.
   */
  private build(
    sentences: readonly Sentence[],
    options: TypesetOptions,
    budget: number,
  ): string {
    const parts: string[] = [];
    let produced = 0;
    let slot = 0;

    for (const sentence of sentences) {
      const cost = sentenceCost(sentence, options.splitChars);
      if (produced > 0 && produced + cost > budget) break;

      for (const line of sentence) {
        parts.push('<p>');

        for (const word of line) {
          // `data-len` lets CSS treat long and short words differently, as Acid does.
          const long = word.length >= 4 ? '1' : '0';
          parts.push(`<w data-len="${long}" data-slot="${slot % COLOUR_SLOTS}">`);

          if (options.splitChars) {
            for (const char of word) {
              // The character code is what lets an effect find every instance of one letter
              // at once — `c[data-ch="101"]` is every "e" on the stage (§12.2).
              parts.push(`<c data-ch="${char.charCodeAt(0)}">${escapeHtml(char)}</c>`);
            }
          } else {
            parts.push(escapeHtml(word));
          }

          parts.push('</w>');
          slot++;
        }

        parts.push('</p>');
      }

      produced += cost;
    }

    return parts.join('');
  }
}

/** Elements a sentence will produce, so the budget can be checked before committing to it. */
function sentenceCost(sentence: Sentence, splitChars: boolean): number {
  let total = 0;
  for (const line of sentence) {
    for (const word of line) total += splitChars ? word.length : 1;
  }
  return total;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;',
  );
}
