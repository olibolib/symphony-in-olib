import type {
  Align,
  Flow,
  TextLength,
  TextPick,
  TextSlice,
} from '../text/Typesetter';
import type { LayerSpec } from './Layer';
import type { PresetDoc } from '../ipc/protocol';
import { PRESET_VERSION } from './presetIo';
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
 * ## Colour is a layer like anything else
 *
 * There is no colouring effect any more. Acid gave every word a colour slot and shifted them
 * periodically, so words changed colour with nothing driving them — and on a conveyor, where
 * the belt rolls straight through a re-typeset, that was the only visible event and nothing
 * motivated it.
 *
 * The scattered colour is rebuilt here out of the ordinary parts: an `accent` layer on
 * `enter` with no decay. Set when the preset goes live, held for as long as it runs, and
 * reachable with a target and a trigger like every other look in the app.
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

/**
 * A preset is one document, and that is the whole of it.
 *
 * It used to be two halves. The serialisable part lived in `PresetDoc`; the rest — bindings,
 * ambient effects, `minPhrases` — was a `StageParts` record held in a map keyed by preset name
 * and glued back on with a cast. Every awkward thing in this layer came from that seam: a
 * duplicated preset lost its behaviour, a rename had to migrate the map by hand, and no preset
 * you made yourself could ever have a pulse or a hold of its own, because the editor had
 * nowhere to put one.
 *
 * There is nothing left on the other side of the line. `pulse` is a treatment, text hold and
 * `minPhrases` are fields, and the rest of the stage effects were deleted rather than
 * converted because nothing called them.
 */
export type VisualPreset = PresetDoc;

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
    version: PRESET_VERSION,
    energy: preset.energy,
    text: {
      slice: preset.text.slice,
      take: preset.text.take,
      length: preset.text.length,
      pick: preset.text.pick,
      position: preset.text.position,
      hold: preset.text.hold,
      splitChars: preset.text.splitChars,
      blocks: preset.text.blocks,
      size: preset.text.size,
      ...(preset.text.varyBy ? { varyBy: preset.text.varyBy } : {}),
    },
    texts: preset.texts,
    minPhrases: preset.minPhrases,
    spawn: preset.spawn,
    blockShapes: preset.blockShapes,
    align: preset.align,
    flow: preset.flow,
    avoidOverlap: preset.avoidOverlap,
    offset: preset.offset,
    wholeLines: preset.wholeLines,
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
    version: PRESET_VERSION,
    name: 'still',
    energy: 'sparse',
    text: { slice: 'sentence', take: 1, length: 'any', pick: 'random', position: 1, hold: { min: 1, max: 2 }, splitChars: true, blocks: 1, size: { min: 36, max: 44 } },
    texts: ['default'],
    spawn: KEEP_CENTRE_CLEAR,
    // One large statement. Wide rather than tall, because a single sentence set big wants
    // room to breathe across rather than a column to fall down.
    blockShapes: [{ cols: { min: 4, max: 6 }, rows: { min: 2, max: 3 } }],
    align: 'centre',
    flow: 'stack',
    avoidOverlap: true,
    offset: { x: 0, y: 0 },
    wholeLines: true,
    layers: [
      { treatment: 'accent', target: { slice: 'word', count: 2 }, triggers: { typeset: true }, decayBars: 0 },

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
    minPhrases: 4,
  },

  /** Two blocks of short sentences, moderate movement. The workhorse. */
  {
    version: PRESET_VERSION,
    name: 'scatter',
    energy: 'mid',
    text: { slice: 'sentence', take: 5, length: 'short', pick: 'random', position: 1, hold: { min: 1, max: 2 }, splitChars: true, blocks: 2, size: { min: 24, max: 32 } },
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
    offset: { x: 0, y: 0 },
    wholeLines: true,
    layers: [
      // Acid's scattered colour, rebuilt out of the same parts as everything else: a quarter
      // of the words take a palette colour when the preset goes live, and never fade. What
      // used to happen to every word whether or not anything had asked for it is now a layer
      // with a target and a trigger, which is the whole argument of §11.5.
      { treatment: 'accent', target: { slice: 'word', proportion: 0.25 }, triggers: { typeset: true }, decayBars: 0 },

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

      // The stage breathing with the beat. A treatment like anything else now — it has no
      // target and writes no channel, the same as the motion pair (§11.5).
      {
        treatment: 'pulse',
        target: { slice: 'block', count: 1 },
        triggers: {},
        decayBars: 0,
        pulse: { amount: 0.012, shape: 'decay' },
      },
    ],

    // The workhorse: no floor, it can be cycled away from whenever the timer says.
    minPhrases: 0,
  },

  /**
   * Dense and character-level. Everything on at once — this is the one the others exist to
   * contrast with, so it deliberately does not run for long.
   */
  {
    version: PRESET_VERSION,
    name: 'swarm',
    energy: 'peak',
    text: {
      slice: 'sentence',
      take: 8,
      length: 'any',
      pick: 'random',
      position: 1,
      hold: { min: 1, max: 2 },
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
    offset: { x: 0, y: 0 },
    wholeLines: true,
    layers: [
      { treatment: 'accent', target: { slice: 'word', proportion: 0.4 }, triggers: { typeset: true }, decayBars: 0 },
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

      // The stage breathing with the beat. A treatment like anything else now — it has no
      // target and writes no channel, the same as the motion pair (§11.5).
      {
        treatment: 'pulse',
        target: { slice: 'block', count: 1 },
        triggers: {},
        decayBars: 0,
        pulse: { amount: 0.022, shape: 'decay' },
      },
    ],
    // Hard on the beat, falling away fast. Reads as the kick.
    minPhrases: 2,
  },

  /** Long sentences, drifting. Slow, readable, moves as a whole rather than in pieces. */
  {
    version: PRESET_VERSION,
    name: 'drift',
    energy: 'mid',
    text: { slice: 'sentence', take: 3, length: 'long', pick: 'random', position: 1, hold: { min: 1, max: 2 }, splitChars: false, blocks: 1, size: { min: 26, max: 34 } },
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
    offset: { x: 0, y: 0 },
    wholeLines: true,
    // Whole words, not characters — `splitChars` is false, so `char` targets would find
    // nothing here.
    layers: [
      { treatment: 'accent', target: { slice: 'word', proportion: 0.15 }, triggers: { typeset: true }, decayBars: 0 },

      // The conveyor, as a layer like everything else: the block stays where it was anchored
      // and the text moves through it, which is the look `drift` was always named for.
      {
        treatment: 'scroll',
        target: { slice: 'block', count: 1 },
        triggers: {},
        decayBars: 0,
        motion: { direction: 'up', speed: 0.12, continuous: true },
      },
      { treatment: 'invert', target: { slice: 'word', proportion: 0.03 }, triggers: { kick: true }, decayBars: FADE.fast },
      { treatment: 'underline', target: { slice: 'word', count: 2 }, triggers: { snare: true }, decayBars: FADE.fast },
      { treatment: 'invert', target: { slice: 'word', count: 1 }, triggers: { bar: true }, decayBars: FADE.fast },
      { treatment: 'invert', target: { slice: 'word', proportion: 0.08 }, triggers: { held: true }, decayBars: FADE.fast },

      // The stage breathing with the beat. A treatment like anything else now — it has no
      // target and writes no channel, the same as the motion pair (§11.5).
      {
        treatment: 'pulse',
        target: { slice: 'block', count: 1 },
        triggers: {},
        decayBars: 0,
        pulse: { amount: 0.016, shape: 'sine' },
      },
    ],
    // Slow even breathing rather than a hit, to match the pace.
    minPhrases: 4,
  },
];
