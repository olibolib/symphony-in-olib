import {
  clearInversions,
  colourShift,
  decor,
  glitchChars,
  glitchParagraphs,
  glitchWord,
  glitchWords,
  invertBlock,
  newLayout,
  removeGlitches,
  pulse,
  retext,
  scroll,
  stopScroll,
  swell,
  unswell,
  whenHolding,
} from '../effects';
import type { EffectRef } from '../effects/types';
import type { TextMode } from '../text/Typesetter';
import type { Bindings } from './Conductor';

/**
 * Visual presets. DESIGN.md §11.1.
 *
 * A preset bundles how text is selected with what the lanes do to it. Note what is *not*
 * here: palette and layout set. Those are user settings in the HUD, chosen because of what
 * the output is being composited over, and a preset overriding them would silently undo a
 * decision the user made for a reason.
 */

export type EnergyTag = 'sparse' | 'mid' | 'peak' | 'any';

export interface VisualPreset {
  readonly name: string;

  /**
   * Which section this suits. Unused until structure detection lands (§10.1), but recorded
   * now so the bank does not need reshaping later — a breakdown must not cycle into the
   * densest preset available.
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

  readonly bindings: Bindings;
  readonly ambient?: readonly EffectRef[];

  /** Minimum phrases before this one may be cycled away from. */
  readonly minPhrases?: number;
}

/** Decay shared by most presets — without it the stage saturates within a few bars. */
const standardDecay: readonly EffectRef[] = [
  removeGlitches({ amount: 0.06 }),
  clearInversions({ amount: 0.02 }),
  unswell({ amount: 0.03 }),
];

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
    bindings: {
      kick: [invertBlock({ count: 1 })],
      bar: [glitchWord({})],
      phrase: [
        retext({ hold: [1, 2] }),
        newLayout(),
        stopScroll(),
        // Held text in a sparse preset only needs a little: one word turning over.
        whenHolding([glitchWord({}), glitchWord({})]),
      ],
    },
    ambient: [removeGlitches({ amount: 0.03 }), clearInversions({ amount: 0.04 })],
    minPhrases: 4,
  },

  /** Two blocks of short sentences, moderate movement. The workhorse. */
  {
    name: 'scatter',
    energy: 'mid',
    text: { mode: 'shortSentences', count: 5, splitChars: true, blocks: 2 },
    fontScale: 28,
    bindings: {
      hat: [glitchWord({})],
      kick: [glitchWords({ amount: 0.05 }), invertBlock({ count: 2 })],
      snare: [glitchChars({}), decor({ count: 2 })],
      bar: [newLayout()],
      phrase: [
        retext({ hold: [1, 2] }),
        colourShift({ accents: 2 }),
        // Compensate for static text with more corruption, so the second phrase does not
        // feel like a stall.
        whenHolding([glitchWords({ amount: 0.2 }), glitchChars({}), decor({ count: 4 })]),
      ],
    },
    ambient: [...standardDecay, pulse({ amount: 0.012 })],
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
    bindings: {
      hat: [glitchWord({}), decor({ count: 1 })],
      kick: [glitchWords({ amount: 0.12 }), swell({ count: 3, amount: 1.6 })],
      snare: [glitchChars({}), glitchParagraphs({ amount: 0.15 })],
      bar: [newLayout(), invertBlock({ count: 4 })],
      phrase: [
        retext({ hold: [1, 2] }),
        colourShift({ accents: 3 }),
        whenHolding([
          glitchParagraphs({ amount: 0.4 }),
          glitchChars({}),
          invertBlock({ count: 8 }),
        ]),
      ],
    },
    ambient: [
      removeGlitches({ amount: 0.1 }),
      clearInversions({ amount: 0.05 }),
      unswell({ amount: 0.06 }),
      // Hard on the beat, falling away fast. Reads as the kick.
      pulse({ amount: 0.022 }),
    ],
    minPhrases: 2,
  },

  /** Long sentences, drifting. Slow, readable, moves as a whole rather than in pieces. */
  {
    name: 'drift',
    energy: 'mid',
    text: { mode: 'longSentences', count: 3, splitChars: false, blocks: 1 },
    fontScale: 30,
    bindings: {
      kick: [glitchWords({ amount: 0.03 })],
      snare: [decor({ count: 2 })],
      bar: [glitchWord({})],
      phrase: [
        retext({ hold: [1, 2] }),
        newLayout(),
        // Held text drifts instead of sitting still.
        whenHolding([scroll({ power: 0.14 }), glitchWords({ amount: 0.08 })]),
      ],
    },
    // Slow even breathing rather than a hit, to match the pace.
    ambient: [...standardDecay, pulse({ amount: 0.016, shape: 'sine' })],
    minPhrases: 4,
  },
];
