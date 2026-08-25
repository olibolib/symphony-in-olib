import {
  colourShift,
  newLayout,
  pulse,
  retext,
  scroll,
  stopScroll,
} from '../effects';
import type { EffectRef } from '../effects/types';
import type { TextMode } from '../text/Typesetter';
import type { Bindings } from './Conductor';
import type { LayerSpec } from './Layer';

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
    readonly blocks: 1 | 2;
  };

  /** Base size in px; everything in CSS is a percentage of this. */
  readonly fontScale: number;

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
    text: { mode: 'sentence', count: 1, splitChars: true, blocks: 1 },
    fontScale: 40,
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
      phrase: [retext({ hold: [1, 2] }), newLayout(), stopScroll()],
    },
    minPhrases: 4,
  },

  /** Two blocks of short sentences, moderate movement. The workhorse. */
  {
    name: 'scatter',
    energy: 'mid',
    text: { mode: 'shortSentences', count: 5, splitChars: true, blocks: 2 },
    fontScale: 28,
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
      bar: [newLayout()],
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
    text: { mode: 'sentences', count: 8, splitChars: true, blocks: 2 },
    fontScale: 24,
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
      bar: [newLayout()],
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
    text: { mode: 'longSentences', count: 3, splitChars: false, blocks: 1 },
    fontScale: 30,
    // Whole words, not characters — `splitChars` is false, so `char` targets would find
    // nothing here.
    layers: [
      { treatment: 'invert', target: { slice: 'word', proportion: 0.03 }, triggers: { kick: true }, decayBars: FADE.fast },
      { treatment: 'underline', target: { slice: 'word', count: 2 }, triggers: { snare: true }, decayBars: FADE.fast },
      { treatment: 'invert', target: { slice: 'word', count: 1 }, triggers: { bar: true }, decayBars: FADE.fast },
      { treatment: 'invert', target: { slice: 'word', proportion: 0.08 }, triggers: { held: true }, decayBars: FADE.fast },
    ],
    bindings: {
      phrase: [retext({ hold: [1, 2] }), newLayout()],
      // Held text drifts instead of sitting still. `held` is a real trigger now, so this
      // no longer needs a wrapper effect to detect the hold for itself.
      held: [scroll({ power: 0.14 })],
    },
    // Slow even breathing rather than a hit, to match the pace.
    ambient: [pulse({ amount: 0.016, shape: 'sine' })],
    minPhrases: 4,
  },
];
