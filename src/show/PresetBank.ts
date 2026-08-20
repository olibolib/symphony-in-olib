import { pick, randomRange } from '../util/random';
import type { VisualPreset } from './presets';

/**
 * Preset cycling. DESIGN.md §11.2.
 *
 * The timer is the floor, not the mechanism: it exists so the visual never goes static over
 * a two-hour set with nobody watching it. Structure-driven changes (§10.1) and manual
 * override (Increment 5) will both sit on top and win, which is why `advance` is separate
 * from the timer that usually calls it.
 */

/** Bars between automatic changes. Randomised so it never feels metronomic. */
const MIN_BARS = 16;
const MAX_BARS = 32;

export class PresetBank {
  private readonly presets: readonly VisualPreset[];
  private index: number;

  private barsSinceChange = 0;
  private phrasesSinceChange = 0;
  private targetBars: number;

  constructor(presets: readonly VisualPreset[]) {
    if (presets.length === 0) throw new Error('PresetBank needs at least one preset');
    this.presets = presets;
    this.index = 0;
    this.targetBars = randomRange(MIN_BARS, MAX_BARS);
  }

  get current(): VisualPreset {
    // Non-null: the constructor rejects an empty bank, and index is always in range.
    return this.presets[this.index] as VisualPreset;
  }

  countBar(): void {
    this.barsSinceChange++;
  }

  countPhrase(): void {
    this.phrasesSinceChange++;
  }

  /**
   * Whether the timer wants a change.
   *
   * Only ever consulted on a phrase boundary — arriving on the 1 of a new 16 is what makes
   * a switch feel intentional rather than random. A preset's `minPhrases` can hold it
   * longer: the sparse ones need room to breathe or they read as a glitch rather than a
   * change of pace.
   */
  get due(): boolean {
    const minimum = this.current.minPhrases ?? 0;
    if (this.phrasesSinceChange < minimum) return false;
    return this.barsSinceChange >= this.targetBars;
  }

  /** Move to a different preset. Returns the new one. */
  advance(): VisualPreset {
    if (this.presets.length > 1) {
      const others = this.presets.filter((_, i) => i !== this.index);
      const next = pick(others);
      if (next) this.index = this.presets.indexOf(next);
    }

    this.barsSinceChange = 0;
    this.phrasesSinceChange = 0;
    this.targetBars = randomRange(MIN_BARS, MAX_BARS);

    return this.current;
  }

  /** Bars remaining before the timer is due, for the HUD. */
  get barsRemaining(): number {
    return Math.max(0, this.targetBars - this.barsSinceChange);
  }
}
