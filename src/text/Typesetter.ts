import type { Stage } from '../render/Stage';
import { anchors, normalise, place, type Cell, type Mask } from '../show/mask';
import { pick, randomInt, randomRange } from '../util/random';
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
   *
   * They may now **overlap**. Under the 3x3 grid every block took a distinct cell, so
   * non-overlap was true by construction; anchors plus a VJ-chosen size gives that up
   * deliberately (§11.6). Two blocks anchored close together and sized large will collide,
   * and that is the author's call rather than the app's to prevent.
   */
  readonly blocks?: number;

  /** Which cells a block may anchor at (§11.6). Already intersected with the global mask. */
  readonly mask?: Mask;

  /** Candidate shapes in cells; one is chosen per block, then rolled within its ranges. */
  readonly shapes?: readonly BlockShape[];

  readonly align?: Align;
  readonly flow?: Flow;

  /**
   * Base size in px, rolled once per typeset and then left alone.
   *
   * `min === max` is a fixed size, which is what `fontScale` used to be. A range makes it a
   * look rather than a setting — and because it is rolled at typeset rather than driven by
   * audio, it costs nothing per frame and nothing has to decay it.
   */
  readonly size?: { readonly min: number; readonly max: number };

  /**
   * What gets its own roll of the size dice. Omit and the whole block matches.
   *
   * Uses `font-size`, and therefore reflows — which is correct here: uneven word sizes need
   * the line to re-wrap around them or the text overlaps itself, and it happens once. The
   * reactive `swell` treatment uses a transform for the opposite reason (§11.5).
   */
  readonly varyBy?: 'word' | 'char';
}

export type Align = 'left' | 'centre' | 'right' | 'justify';

/**
 * How paragraphs arrange inside a block.
 *
 * What is left of the old layout table once placement and typography are taken out of it:
 * `run-on` was layout 7, `grid` was 6, `wrapped` was 5, and `columns` was 12's two rails.
 * As a setting they combine with any anchor and any size, which none of them could before.
 */
export type Flow = 'stack' | 'run-on' | 'grid' | 'wrapped' | 'columns';

export interface Range {
  readonly min: number;
  readonly max: number;
}

export interface BlockShape {
  readonly cols: Range;
  readonly rows: Range;
}

/** A shape that fills most of the frame. Used when a preset declares none. */
const DEFAULT_SHAPES: readonly BlockShape[] = [
  { cols: { min: 5, max: 5 }, rows: { min: 3, max: 3 } },
];

/** Number of colour slots. Must match the `--c0`..`--c7` variables in CSS (§12.5). */
const COLOUR_SLOTS = 8;

const DEFAULT_MAX_ELEMENTS = 6000;

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

  /**
   * True when the effective mask had no allowed cell, so nothing could be placed.
   *
   * Reported rather than silently rendering an empty stage — a preset that never appears is
   * exactly the kind of thing §14 says must not fail quietly.
   */
  unplaceable = false;
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

    const mask = normalise(options.mask);
    const cells = anchors(mask);
    const shapes = options.shapes?.length ? options.shapes : DEFAULT_SHAPES;
    const parts: string[] = [];

    // No allowed cell means nowhere to anchor. Rendering nothing and saying nothing would
    // look exactly like a broken preset, so the caller is told (§14).
    if (cells.length === 0) {
      this.stage.container.innerHTML = '';
      this.refresh();
      this.unplaceable = true;
      return;
    }
    this.unplaceable = false;

    // `count` is a total across blocks, not per block. Passing the full count to each was a
    // bug: two blocks asking for four sentences produced eight, crammed into cells a third
    // of the stage wide, where the surplus was silently clipped.
    const perBlock = Math.max(1, Math.round((options.count ?? 1) / blocks));

    for (let index = 0; index < blocks; index++) {
      // Each block selects independently, so they show different text.
      const lines = this.select(preset, { ...options, count: perBlock });

      // Anchor and shape are rolled per block, independently. That is what puts a tall
      // column beside a wide band — a composition the 3x3 grid could not produce, since
      // every cell there was the same size (§11.6).
      const anchor = pick(cells) as Cell;
      const shape = pick(shapes) ?? DEFAULT_SHAPES[0]!;
      const box = place(
        anchor,
        randomRange(shape.cols.min, shape.cols.max),
        randomRange(shape.rows.min, shape.rows.max),
      );

      const style =
        `left:${box.left.toFixed(3)}%;top:${box.top.toFixed(3)}%;` +
        `width:${box.width.toFixed(3)}%;height:${box.height.toFixed(3)}%;`;

      parts.push(`<div class="block" data-block="${index}" style="${style}">`);
      parts.push(this.build(lines, options, budgetPerBlock));
      parts.push('</div>');
    }

    // One assignment, not an append per word. Parsing a single string is dramatically
    // faster than thousands of DOM insertions, and it is the difference between a preset
    // change being invisible and being a visible hitch.
    // Base size is rolled once here, not per frame and not per trigger. Nothing decays it
    // and nothing follows the audio with it — it is simply how big the text is (§11.5).
    const size = options.size ?? { min: 28, max: 28 };
    this.stage.setFontScale(randomRange(size.min, size.max));

    const container = this.stage.container;
    container.dataset['align'] = options.align ?? 'centre';
    container.dataset['flow'] = options.flow ?? 'stack';

    container.innerHTML = parts.join('');

    this.refresh();
    if (options.varyBy) this.varySizes(options.varyBy, size);
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

  /**
   * Give each word or character its own size within the range.
   *
   * Written as a multiplier of the base rather than an absolute, so the two settings stay
   * independent — changing the base range moves everything, and `varyBy` decides how evenly.
   *
   * Applied after the DOM exists rather than baked into the markup string: it is one style
   * write per element on a re-typeset, which happens a few times a minute, and keeping it
   * out of `build` leaves that function about text and nothing else.
   */
  private varySizes(slice: 'word' | 'char', size: { min: number; max: number }): void {
    if (size.max <= size.min) return;

    const elements = slice === 'char' ? this.chars : this.words;
    const base = (size.min + size.max) / 2;

    for (const el of elements) {
      const px = size.min + Math.random() * (size.max - size.min);
      el.style.fontSize = `${(px / base).toFixed(3)}em`;
    }
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
