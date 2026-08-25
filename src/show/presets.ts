import { colourShift, pulse, retext, scroll, stopScroll } from '../effects';
import type { EffectRef } from '../effects/types';
import type { Align, Flow, TextMode } from '../text/Typesetter';
import type { Bindings } from './Conductor';
import type { LayerSpec } from './Layer';
import type { PresetDoc } from '../ipc/protocol';
import { KEEP_CENTRE_CLEAR, type BlockShape, type Mask } from './mask';

/**
 * Visual presets. DESIGN.md §11.1 and §11.5.
 *
 * A preset bundles how text is selected, a stack of **layers** that do things to elements,
 * and stage effects for everything that is not element-level. Note what is *not* here:
 * palette and layout set. Those are user settings in the control window, chosen because of
 * what the output is being composited over, and a preset overriding them would silently
 * undo a decision the user made for a reason.
 *
 * ## Ported from the closure form, deliberately unchanged
 *
 * These four are the old presets expressed as layers, not redesigned. If one looks
 * different from before, the layer engine is wrong — which is much easier to find while
 * there is still something to compare against (§11.5, "Decided").
 *
 * Two differences are unavoidable and were accepted when the model was agreed:
 *
 * - **`decor` variant 4 was italic**, and there is no italic treatment. Ported as
 *   `underline`, so that one random variant in four is gone.
 * - **`swell` set a `min-width` floor** scaled by live bass; it is now a `transform: scale`
 *   rolled within bounds, because per-element reflow several times a bar reads as broken
 *   and continuous following was dropped (§11.5).
 *
 * ## Placement is not a port
 *
 * The layout table is gone (§11.6), and unlike the layers it was not reproduced. Variety
 * used to come from `newLayout` switching between eighteen fixed arrangements every bar; it
 * now comes from the anchor and the block shape being rolled on every typeset, with `align`
 * and `flow` fixed per preset. That is a deliberate change of character, not a regression —
 * these are the first four presets authored in the new vocabulary rather than translated.
 */

export type EnergyTag = 'sparse' | 'mid' | 'peak' | 'any';

export interface VisualPreset {
  readonly name: string;

  /**
   * A label the VJ applies to organise their own presets. Drives nothing.
   *
   * `PresetBank.takeNext()` has never read it, and §11.5 settles that as the intended
   * design rather than an omission: with per-layer control over targets, amounts and
   * decays, an automatic energy rating has nothing left to decide.
   */
  readonly energy: EnergyTag;

  readonly text: {
    readonly mode: TextMode;
    readonly count: number;
    readonly splitChars: boolean;
    readonly blocks: 1 | 2 | 3;

    /**
     * Base size in px, rolled once per typeset (§11.5).
     *
     * `min === max` is what `fontScale` used to be. A range makes it a look: the text is a
     * different size each phrase without anything having to drive it.
     */
    readonly size: { readonly min: number; readonly max: number };

    /** Give each word or character its own size within the range. */
    readonly varyBy?: 'word' | 'char';
  };

  /** Texts this preset may draw from, by name. `['default']` follows the menu (§11.7). */
  readonly texts: readonly string[];

  /**
   * Where blocks may anchor (§11.6). Intersected with the VJ's global mask before use, so a
   * preset can only ever be more restricted than the global rule, never less.
   */
  readonly spawn: Mask;

  /**
   * Candidate shapes in cells. One is chosen per block, then rolled within its ranges.
   *
   * A list rather than a pair of ranges because width and height are *related*: rolling them
   * independently keeps landing on the square blob between the column and the band that were
   * actually wanted (§11.6).
   */
  readonly blockShapes: readonly BlockShape[];

  readonly align: Align;
  readonly flow: Flow;

  /**
   * Keep blocks off each other. Defaults to on for every built-in.
   *
   * Anchors allow overlap by design — the VJ chooses the anchor and the size. But the shapes
   * in a preset are *authored*, so a non-overlapping arrangement nearly always exists, and
   * preferring it is free. Turn it off for a preset where blocks colliding is the look.
   */
  readonly avoidOverlap: boolean;

  /**
   * The Lego. Order matters: a later layer contending for the same channel sits on top.
   *
   * **A layer's slice must match `text.splitChars`.** A `char` target against text that was
   * typeset as whole words resolves to nothing and the layer silently does not happen —
   * which §14 would rather it did not, and which the editor will warn about in 2c.
   */
  readonly layers: readonly LayerSpec[];

  readonly bindings: Bindings;
  readonly ambient?: readonly EffectRef[];

  /** Minimum phrases before this one may be cycled away from. */
  readonly minPhrases?: number;
}

/**
 * Decay rates, converted from the per-frame fractions they used to be.
 *
 * The old `removeGlitches({ amount: 0.06 })` cleared 6% of lit elements *per frame*, which
 * made the look depend on the frame rate — twice as fast at 60fps as at 30. These are the
 * equivalents in bars, computed at 60fps and a 2-second bar so the ported presets fade at
 * the speed they used to:
 *
 * | Old per-frame | Survives 1s | Bars |
 * |---|---|---|
 * | 0.02 | 30%  | 1.25 |
 * | 0.03 | 16%  | 0.8  |
 * | 0.04 | 8.6% | 0.6  |
 * | 0.05 | 4.6% | 0.5  |
 * | 0.06 | 2.5% | 0.4  |
 * | 0.10 | 0.2% | 0.25 |
 *
 * They are now *musical*: a fade of 0.4 bars takes 0.4 bars at 128 and at 174, where the
 * old rates were the same wall-clock speed regardless of tempo.
 */
const FADE = {
  slow: 1.25,
  medium: 0.8,
  quick: 0.6,
  fast: 0.4,
  instant: 0.25,
} as const;

/**
 * Strip a preset down to its editable document (§11.4).
 *
 * The inverse lives in `PresetStore.resolve`. Explicit field-by-field rather than a spread
 * with deletions, so adding a field to `VisualPreset` that should *not* be editable does not
 * silently start being sent to the control window.
 */
export function toDoc(preset: VisualPreset): PresetDoc {
  return {
    name: preset.name,
    energy: preset.energy,
    text: {
      mode: preset.text.mode,
      count: preset.text.count,
      splitChars: preset.text.splitChars,
      blocks: preset.text.blocks,
      size: preset.text.size,
      ...(preset.text.varyBy ? { varyBy: preset.text.varyBy } : {}),
    },
    texts: preset.texts,
    spawn: preset.spawn,
    blockShapes: preset.blockShapes,
    align: preset.align,
    flow: preset.flow,
    avoidOverlap: preset.avoidOverlap,
    layers: preset.layers,
  };
}

export const PRESETS: readonly VisualPreset[] = [
  /**
   * One sentence, large, almost still.
   *
   * The restraint is the point. Acid lets text sit and be read, and a bank where everything
   * moves constantly has no dynamic range — the busy presets only register as busy if
   * something quiet came before them.
   */
  {
    name: 'still',
    energy: 'sparse',
    text: { mode: 'sentence', count: 1, splitChars: true, blocks: 1, size: { min: 36, max: 44 } },
    texts: ['default'],
    spawn: KEEP_CENTRE_CLEAR,
    // One large statement. Wide rather than tall, because a single sentence set big wants
    // room to breathe across rather than a column to fall down.
    blockShapes: [{ cols: { min: 4, max: 6 }, rows: { min: 2, max: 3 } }],
    align: 'centre',
    flow: 'stack',
    avoidOverlap: true,
    layers: [
      // Was `invertBlock({ count: 1 })` — one character, black block behind it.
      {
        treatment: 'invert',
        target: { slice: 'char', count: 1 },
        triggers: { kick: true },
        decayBars: FADE.quick,
      },
      // Was `glitchWord({})` on the bar.
      {
        treatment: 'invert',
        target: { slice: 'word', count: 1 },
        triggers: { bar: true },
        decayBars: FADE.medium,
      },
      // Was `whenHolding([glitchWord({}), glitchWord({})])`. Held text in a sparse preset
      // only needs a little: a word or two turning over.
      {
        treatment: 'invert',
        target: { slice: 'word', count: 2 },
        triggers: { held: true },
        decayBars: FADE.medium,
      },
    ],
    bindings: {
      phrase: [retext({ hold: [1, 2] }), stopScroll()],
    },
    minPhrases: 4,
  },

  /** Two blocks of short sentences, moderate movement. The workhorse. */
  {
    name: 'scatter',
    energy: 'mid',
    text: { mode: 'shortSentences', count: 5, splitChars: true, blocks: 2, size: { min: 24, max: 32 } },
    texts: ['default'],
    spawn: KEEP_CENTRE_CLEAR,
    // A column and a band, so two blocks on stage rarely look like the same thing twice.
    blockShapes: [
      { cols: { min: 2, max: 3 }, rows: { min: 3, max: 5 } },
      { cols: { min: 4, max: 6 }, rows: { min: 1, max: 2 } },
    ],
    align: 'left',
    flow: 'stack',
    avoidOverlap: true,
    layers: [
      { treatment: 'invert', target: { slice: 'word', count: 1 }, triggers: { hat: true }, decayBars: FADE.fast },
      { treatment: 'invert', target: { slice: 'word', proportion: 0.05 }, triggers: { kick: true }, decayBars: FADE.fast },
      { treatment: 'invert', target: { slice: 'char', count: 2 }, triggers: { kick: true }, decayBars: FADE.slow },
      // Every instance of one character at once — the best thing inherited from Acid.
      { treatment: 'invert', target: { match: '' }, triggers: { snare: true }, decayBars: FADE.fast },
      { treatment: 'underline', target: { slice: 'char', count: 2 }, triggers: { snare: true }, decayBars: FADE.fast },

      // Compensate for static text with more corruption, so a second phrase on the same
      // words does not feel like a stall.
      { treatment: 'invert', target: { slice: 'word', proportion: 0.2 }, triggers: { held: true }, decayBars: FADE.fast },
      { treatment: 'invert', target: { match: '' }, triggers: { held: true }, decayBars: FADE.fast },
      { treatment: 'underline', target: { slice: 'char', count: 4 }, triggers: { held: true }, decayBars: FADE.fast },
    ],
    bindings: {
      phrase: [retext({ hold: [1, 2] }), colourShift({ accents: 2 })],
    },
    ambient: [pulse({ amount: 0.012 })],
  },

  /**
   * Dense and character-level. Everything on at once — this is the one the others exist to
   * contrast with, so it deliberately does not run for long.
   */
  {
    name: 'swarm',
    energy: 'peak',
    text: {
      mode: 'sentences',
      count: 8,
      splitChars: true,
      blocks: 2,
      size: { min: 20, max: 30 },
      // Uneven word sizes, rolled once and then still. The one preset dense enough for
      // ransom-note type to read as intent rather than as a fault.
      varyBy: 'word',
    },
    texts: ['default'],
    spawn: KEEP_CENTRE_CLEAR,
    blockShapes: [
      { cols: { min: 3, max: 4 }, rows: { min: 3, max: 5 } },
      { cols: { min: 5, max: 7 }, rows: { min: 2, max: 3 } },
    ],
    align: 'left',
    flow: 'wrapped',
    avoidOverlap: true,
    layers: [
      { treatment: 'invert', target: { slice: 'word', count: 1 }, triggers: { hat: true }, decayBars: FADE.instant },
      { treatment: 'underline', target: { slice: 'char', count: 1 }, triggers: { hat: true }, decayBars: FADE.instant },
      { treatment: 'invert', target: { slice: 'word', proportion: 0.12 }, triggers: { kick: true }, decayBars: FADE.instant },
      {
        treatment: 'swell',
        target: { slice: 'char', count: 3 },
        triggers: { kick: true },
        decayBars: FADE.fast,
        size: { min: 1, max: 1.6 },
      },
      { treatment: 'invert', target: { match: '' }, triggers: { snare: true }, decayBars: FADE.instant },
      // Whole paragraphs together — a much heavier gesture than scattered words.
      { treatment: 'invert', target: { slice: 'paragraph', proportion: 0.15 }, triggers: { snare: true }, decayBars: FADE.instant },
      { treatment: 'invert', target: { slice: 'char', count: 4 }, triggers: { bar: true }, decayBars: FADE.medium },

      { treatment: 'invert', target: { slice: 'paragraph', proportion: 0.4 }, triggers: { held: true }, decayBars: FADE.instant },
      { treatment: 'invert', target: { match: '' }, triggers: { held: true }, decayBars: FADE.instant },
      { treatment: 'invert', target: { slice: 'char', count: 8 }, triggers: { held: true }, decayBars: FADE.medium },
    ],
    bindings: {
      phrase: [retext({ hold: [1, 2] }), colourShift({ accents: 3 })],
    },
    // Hard on the beat, falling away fast. Reads as the kick.
    ambient: [pulse({ amount: 0.022 })],
    minPhrases: 2,
  },

  /** Long sentences, drifting. Slow, readable, moves as a whole rather than in pieces. */
  {
    name: 'drift',
    energy: 'mid',
    text: { mode: 'longSentences', count: 3, splitChars: false, blocks: 1, size: { min: 26, max: 34 } },
    texts: ['default'],
    spawn: KEEP_CENTRE_CLEAR,
    // A tall column or a wide band, never the square in between — the reason shapes are a
    // list rather than two independent ranges (§11.6).
    blockShapes: [
      { cols: { min: 2, max: 2 }, rows: { min: 4, max: 7 } },
      { cols: { min: 5, max: 7 }, rows: { min: 2, max: 3 } },
    ],
    align: 'justify',
    // Paragraphs run together into a single justified slab. Was layout 7, and it suits long
    // sentences better than anything else in the old table did.
    flow: 'run-on',
    avoidOverlap: true,
    // Whole words, not characters — `splitChars` is false, so `char` targets would find
    // nothing here.
    layers: [
      { treatment: 'invert', target: { slice: 'word', proportion: 0.03 }, triggers: { kick: true }, decayBars: FADE.fast },
      { treatment: 'underline', target: { slice: 'word', count: 2 }, triggers: { snare: true }, decayBars: FADE.fast },
      { treatment: 'invert', target: { slice: 'word', count: 1 }, triggers: { bar: true }, decayBars: FADE.fast },
      { treatment: 'invert', target: { slice: 'word', proportion: 0.08 }, triggers: { held: true }, decayBars: FADE.fast },
    ],
    bindings: {
      phrase: [retext({ hold: [1, 2] })],
      // Held text drifts instead of sitting still. `held` is a real trigger now, so this
      // no longer needs a wrapper effect to detect the hold for itself.
      held: [scroll({ power: 0.14 })],
    },
    // Slow even breathing rather than a hit, to match the pace.
    ambient: [pulse({ amount: 0.016, shape: 'sine' })],
    minPhrases: 4,
  },
];
