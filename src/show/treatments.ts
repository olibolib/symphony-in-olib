import { randomRange } from '../util/random';

/**
 * What visually happens to an element. DESIGN.md §11.5.
 *
 * The other half of what an effect used to be. A treatment knows nothing about *which*
 * elements it is applied to — that is `targets.ts` — so any treatment composes with any
 * target, which is the whole point of the split.
 */

export type Treatment =
  | 'invert'
  | 'accent'
  | 'dingbat'
  | 'underline'
  | 'strike'
  | 'outline'
  | 'swell'
  | 'flicker'
  | 'blank'
  | 'scroll'
  | 'travel'
  | 'pulse';

/**
 * The two that move something rather than mark it.
 *
 * They are treatments so that a preset is authored in **one list**. Motion used to be its own
 * pair of settings in the placement section, which meant two places to look and two shapes of
 * control for what is, from the VJ's side, the same kind of decision: pick a thing, say what
 * it does.
 *
 * What they do not have is a target. `scroll` moves the text through its block and `travel`
 * moves the block across the canvas; neither picks elements, so neither writes a channel and
 * neither decays. The editor hides the controls that would be meaningless.
 */
export const MOTION_TREATMENTS: readonly Treatment[] = ['scroll', 'travel'];

/**
 * Treatments that act on the stage rather than on anything in it.
 *
 * `pulse` scales the whole frame with the beat. Like the motion pair it has no target and
 * writes no channel — but unlike them it is not a one-off applied at typeset: it is a curve
 * read from the predicted beat grid every frame, which is what keeps it smooth through a
 * passage with no transients and lands it *on* the beat rather than after it.
 *
 * It was the last stage effect, and it was a layer-shaped idea sitting outside the layer
 * system for no better reason than history. Making it a treatment is what let stage effects
 * be deleted rather than converted.
 *
 * **Not the same as `swell` on everything**, which is the obvious question. Swell scales each
 * targeted element about its own origin, so glyphs fatten in place and the composition does not
 * move; this scales the container, so the whole picture zooms and blocks travel outward from
 * centre. Swell also rolls a fresh size per element and fires on a trigger with a decay, where
 * this is one deterministic curve applied continuously.
 */
export const STAGE_TREATMENTS: readonly Treatment[] = ['pulse'];

export function isStage(treatment: Treatment): boolean {
  return STAGE_TREATMENTS.includes(treatment);
}

export function isMotion(treatment: Treatment): boolean {
  return treatment === 'scroll' || treatment === 'travel';
}

/**
 * A CSS property being contended for.
 *
 * Named after the property rather than after the treatment, which is what lets `invert` and
 * `accent` compose: invert writes `bg` and `fg`, a later accent overwrites only `fg`, and
 * the result is a black block with accent-coloured text. Under the old single `data-glitch`
 * attribute the later effect simply erased the earlier one.
 */
export type Channel = 'bg' | 'fg' | 'font' | 'deco' | 'outline' | 'size' | 'anim' | 'vis';

export const CHANNELS: Readonly<Record<Treatment, readonly Channel[]>> = {
  invert: ['bg', 'fg'],
  accent: ['fg'],
  dingbat: ['font'],
  underline: ['deco'],
  strike: ['deco'],
  outline: ['outline'],
  swell: ['size'],
  flicker: ['anim'],
  blank: ['vis'],

  // Nothing. They move a block, or the whole stage, rather than marking anything inside it —
  // so there is no channel to contend for and nothing for decay to clear.
  scroll: [],
  travel: [],
  pulse: [],
};

/**
 * What a treatment writes into each channel it owns.
 *
 * Values are **slot numbers**, not colours — §12.1's mechanism, preserved. The engine picks
 * a number and `stage.css` decides what it looks like, so a wildly different palette needs
 * no JavaScript. What changed is that there is now one attribute per channel rather than
 * one shared `data-glitch`.
 */
export interface Written {
  readonly channel: Channel;
  readonly value: string;
}

/**
 * Highest slot defined per channel in `stage.css`. Keep in sync.
 *
 * `bg` and `fg` slots 1–4 are authored as matched pairs, so `invert` writing both to the
 * same number gives a coherent block — a dark ground with light type, or yellow with blue.
 * They are still separate channels, so a later `accent` can take `fg` alone.
 *
 * Accent writes `p0`..`p7` instead — the VJ's palette. Kept in a separate namespace because
 * the paired values assume a background is behind them: white type is correct over black and
 * invisible on the default white stage.
 */
const BG_FG_PAIRS = 4;

/** How many palette slots `accent` may choose from. Matches `--c0`..`--c7`. */
const PALETTE_SLOTS = 8;
const DECO_UNDERLINE = 1;
const DECO_STRIKE = 2;

/**
 * Decide what to write for one application of a treatment.
 *
 * There is no general "amount": a treatment is a switch, and a half-applied inversion is not
 * a thing. *How much* is the target's business — 5% of words rather than 40% — and the
 * treatments that do carry a quantity carry a specific one, `size` for swell and `rateBars`
 * for flicker. A second knob meaning roughly "strength" is how presets got confusing before.
 */
export function write(
  treatment: Treatment,
  options: {
    readonly size?: { min: number; max: number };
    readonly rateBars?: number;
  },
): readonly Written[] {
  switch (treatment) {
    case 'invert': {
      // One roll for both channels, so the pair stays coherent.
      const slot = String(randomRange(1, BG_FG_PAIRS));
      return [
        { channel: 'bg', value: slot },
        { channel: 'fg', value: slot },
      ];
    }

    case 'accent': {
      // A palette slot, written as `p<n>` so it cannot collide with the numbered pairs
      // `invert` uses — those are chosen for contrast against a background, these are the
      // VJ's colours. Rolled per application, the way `invert` rolls its pair.
      return [{ channel: 'fg', value: `p${Math.floor(Math.random() * PALETTE_SLOTS)}` }];
    }

    case 'dingbat':
      return [{ channel: 'font', value: '1' }];

    case 'underline':
      return [{ channel: 'deco', value: String(DECO_UNDERLINE) }];

    case 'strike':
      return [{ channel: 'deco', value: String(DECO_STRIKE) }];

    case 'outline':
      return [{ channel: 'outline', value: '1' }];

    case 'swell': {
      // Rolled within bounds, like every other pair of bounds in the design (§11.5).
      // Nothing tracks live audio continuously any more — the trigger already decides
      // whether this fires at all.
      const bounds = options.size ?? { min: 1, max: 1.4 };
      const scale = bounds.min + Math.random() * (bounds.max - bounds.min);
      return [{ channel: 'size', value: scale.toFixed(3) }];
    }

    case 'flicker':
      // A multiplier of a bar, not a duration. CSS multiplies it by the live bar length, so
      // the blink stays on the grid through a tempo change without the engine touching it.
      return [{ channel: 'anim', value: String(options.rateBars ?? 0.25) }];

    case 'blank':
      return [{ channel: 'vis', value: '1' }];

    // Applied when the text is laid out, not by writing to elements — see `Typesetter`.
    case 'scroll':
    case 'travel':
      return [];

    // Read from the beat grid every frame and written to the stage — see `Engine`.
    case 'pulse':
      return [];
  }
}

/**
 * Whether a channel carries a free value rather than a slot number.
 *
 * `size` is a scale factor and `anim` is a period in bars: both are continuous quantities a
 * slider produces, and 1.37 cannot be expressed as one of five numbered rules. Everything
 * else is a slot and stays one — that is what keeps the appearance in CSS where a preset can
 * restyle it without touching any JavaScript.
 */
export function isScalar(channel: Channel): boolean {
  return channel === 'size' || channel === 'anim';
}
