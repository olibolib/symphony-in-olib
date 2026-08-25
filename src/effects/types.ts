import type { Channels } from '../show/Channels';
import type { Stage } from '../render/Stage';
import type { Typesetter } from '../text/Typesetter';

/**
 * What an effect is handed when it fires. DESIGN.md §12.
 *
 * Effects are deliberately given the live registries rather than the DOM, so none of them
 * have to know how text was built — only what elements exist right now.
 */
export interface EffectContext {
  readonly stage: Stage;
  readonly typesetter: Typesetter;

  /** Where layers write, and who owns what (§11.5). */
  readonly channels: Channels;

  /**
   * Continuous 0–1 lanes.
   *
   * No longer wired into what layers do — `follow` was dropped in §11.5, because scaling an
   * amount by live energy doubled up on the triggers, which already thin out when the kick
   * stops. Kept because the analyser computes them for the meters regardless and structure
   * detection (§10.1) will want them.
   */
  readonly energy: number;
  readonly bass: number;

  /** Accent colours the user has selected. Empty means "no colour". */
  readonly palette: readonly string[];
  /** Layout numbers `newLayout` may choose from. */
  readonly layouts: readonly number[];

  /** Position within the current beat, 0–1. Continuous, for anything that pulses. */
  readonly beatPhase: number;

  /** Phrases the current text has been on screen. 0 means it was just replaced. */
  readonly textAge: number;

  /** Seconds since the previous frame, clamped. */
  readonly dt: number;

  /**
   * Seconds in four beats, from the live tempo.
   *
   * The unit for everything the audience sees (§11.5). A fade of one bar takes a bar at 128
   * and at 174, and a decay expressed this way is frame-rate independent as well as
   * tempo-relative.
   */
  readonly barSeconds: number;

  /** Re-render the current text preset. Some effects change what is on screen. */
  retext(): void;
}

/**
 * An effect, already bound to its parameters. Built by the helpers in `effects/index.ts`,
 * so a preset reads as `pulse({ amount: 0.02 })` and gets checked at compile time rather
 * than failing silently at 2am.
 *
 * Element effects have moved out: they were a target welded to a treatment, and §11.5
 * splits them into `targets.ts` and `treatments.ts`. What remains here is stage-wide —
 * layout, colour, scroll, pulse — where there is nothing to separate.
 */
export type EffectRef = (ctx: EffectContext) => void;
