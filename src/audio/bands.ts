/**
 * Frequency bands. DESIGN.md §10.
 *
 * These ranges are chosen for dance music specifically: the kick fundamental sits low,
 * snares and claps carry in the low mids, and hats live up top. They are deliberately
 * narrow — a wide band catches everything and therefore distinguishes nothing.
 */
export interface BandSpec {
  readonly name: BandName;
  readonly fromHz: number;
  readonly toHz: number;
  /** Minimum gap between onsets, ms. Stops one transient reporting as several. */
  readonly refractoryMs: number;
  /**
   * Onset threshold, in standard deviations above the band's own rolling mean flux.
   * Higher = fussier. Tunable live from the HUD; these are the starting points.
   */
  readonly sensitivity: number;
}

export type BandName = 'kick' | 'snare' | 'hat';

export const BANDS: readonly BandSpec[] = [
  // 4.0 is empirical: at 2.0 bass synths in the same range still read as kicks. The kick
  // band and the bassline genuinely overlap, so this is a fussiness setting, not a fix —
  // see the note below.
  { name: 'kick', fromHz: 40, toHz: 120, refractoryMs: 110, sensitivity: 4.0 },
  { name: 'snare', fromHz: 150, toHz: 600, refractoryMs: 110, sensitivity: 2.0 },
  { name: 'hat', fromHz: 4000, toHz: 12000, refractoryMs: 45, sensitivity: 2.2 },
] as const;

/** Low-band range used for the continuous `bass` level and, later, structure detection. */
/**
 * A note on kick versus bass.
 *
 * No threshold cleanly separates them, because in 40–120 Hz they are not actually
 * different: a synth bass note has a real attack transient in exactly the band the kick
 * occupies. The detector is not being fooled — both *are* onsets. It simply cannot know
 * which one you meant.
 *
 * Two things make this survivable:
 *
 * - Beat tracking does not need a clean stream. Autocorrelation finds periodicity, and
 *   extra onsets between the kicks are noise it can reject, as long as the kicks are there.
 * - Visually, a bass stab firing an effect is not obviously wrong for a VJ tool.
 *
 * If it ever needs to be better, the discriminator to reach for is simultaneous energy
 * higher up: a bass note usually carries harmonics into 150–400 Hz at the moment of attack,
 * where a kick is concentrated much lower. That is a real test, but it is more machinery
 * and it can misfire on kicks with a lot of click, so it is not worth it yet.
 */
export const BASS_RANGE = { fromHz: 20, toHz: 140 } as const;
