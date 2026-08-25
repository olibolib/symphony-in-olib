import { pick, randomRange } from '../util/random';
import type { VisualPreset } from './presets';

/**
 * Preset selection and cycling. DESIGN.md §11.2.
 *
 * Three ways a preset changes, and they all funnel through the same place:
 *
 * - the timer, so it never goes static over a long set with nobody watching
 * - you choosing one in the HUD
 * - later, a MIDI pad, or structure detection reacting to a drop
 *
 * Whichever it is, the change is *queued* and applied on the next phrase boundary. A change
 * landing mid-phrase reads as a fault rather than as a decision, and having one path for all
 * of them means that stays true no matter what triggers it.
 */

/** Bars between automatic changes. Randomised so it never feels metronomic. */
const MIN_BARS = 16;
const MAX_BARS = 32;

const ENABLED_KEY = 'olib.enabledPresets';

export class PresetBank {
  private presets: readonly VisualPreset[];
  private index: number;

  /** Names the cycle may choose from. Never empty — see `setEnabled`. */
  private enabledNames: Set<string>;

  /** Chosen but not yet applied. Applied at the next phrase. */
  private queued: string | null = null;

  private barsSinceChange = 0;
  private phrasesSinceChange = 0;
  private targetBars: number;

  constructor(presets: readonly VisualPreset[]) {
    if (presets.length === 0) throw new Error('PresetBank needs at least one preset');
    this.presets = presets;
    this.index = 0;
    this.targetBars = randomRange(MIN_BARS, MAX_BARS);
    this.enabledNames = this.loadEnabled();
  }

  get all(): readonly VisualPreset[] {
    return this.presets;
  }

  /**
   * Swap in a rebuilt set after an edit (§11.4).
   *
   * The live preset is followed **by name**, not by index: editing a preset rebuilds the
   * whole array, and an index would silently point at a different preset the moment one was
   * added or deleted above it. If the live one has been deleted, the index is clamped rather
   * than reset to zero, so the stage lands on its neighbour instead of jumping to the top of
   * the list mid-set.
   */
  replace(presets: readonly VisualPreset[]): void {
    if (presets.length === 0) return;

    const liveName = this.current.name;
    this.presets = presets;

    const found = presets.findIndex((p) => p.name === liveName);
    this.index = found >= 0 ? found : Math.min(this.index, presets.length - 1);

    // A queued name that no longer exists would sit there being checked forever.
    if (this.queued !== null && !presets.some((p) => p.name === this.queued)) {
      this.queued = null;
    }

    // Same for the enabled set — and it must never end up empty, since the cycle would then
    // have nothing to choose from.
    const names = new Set(presets.map((p) => p.name));
    for (const name of Array.from(this.enabledNames)) {
      if (!names.has(name)) this.enabledNames.delete(name);
    }
    if (this.enabledNames.size === 0) this.enabledNames.add(this.current.name);
  }

  get current(): VisualPreset {
    // Non-null: the constructor rejects an empty bank, and index is always in range.
    return this.presets[this.index] as VisualPreset;
  }

  /** The queued preset's name, for the HUD to show as pending. */
  get pending(): string | null {
    return this.queued;
  }

  isEnabled(name: string): boolean {
    return this.enabledNames.has(name);
  }

  /**
   * Enable or disable a preset for the automatic cycle.
   *
   * **At least one must stay enabled.** Disabling the last one would leave the cycle with
   * nothing to choose and the visual frozen on whatever happened to be running — a silent
   * failure of exactly the kind §14 rules out. The request is refused instead.
   */
  setEnabled(name: string, enabled: boolean): boolean {
    if (!enabled && this.enabledNames.size <= 1 && this.enabledNames.has(name)) {
      return false;
    }

    if (enabled) this.enabledNames.add(name);
    else this.enabledNames.delete(name);

    this.saveEnabled();
    return true;
  }

  /**
   * Ask for a preset. Applied at the next phrase, not now.
   *
   * Choosing the one already live cancels a pending change instead of queueing a no-op —
   * that is the natural "actually, stay where you are" gesture.
   */
  queue(name: string): void {
    if (name === this.current.name) {
      this.queued = null;
      return;
    }
    this.queued = name;
  }

  cancelQueue(): void {
    this.queued = null;
  }

  countBar(): void {
    this.barsSinceChange++;
  }

  countPhrase(): void {
    this.phrasesSinceChange++;
  }

  /**
   * Called on a phrase boundary. Returns the preset to switch to, or null to stay.
   *
   * A queued choice always beats the timer: if you picked something, the machine should not
   * talk over you.
   */
  takeNext(): VisualPreset | null {
    if (this.queued !== null) {
      const target = this.presets.findIndex((p) => p.name === this.queued);
      this.queued = null;
      if (target >= 0) {
        this.index = target;
        this.resetCounters();
        return this.current;
      }
    }

    if (!this.timerDue) return null;

    const others = this.presets.filter(
      (p) => this.enabledNames.has(p.name) && p.name !== this.current.name,
    );
    const next = pick(others);
    if (!next) {
      // Only one preset enabled — nothing to move to. Reset anyway so we do not re-check
      // every phrase from here on.
      this.resetCounters();
      return null;
    }

    this.index = this.presets.indexOf(next);
    this.resetCounters();
    return this.current;
  }

  /**
   * Whether the timer wants a change.
   *
   * A preset's `minPhrases` can hold it longer: the sparse ones need room to breathe or they
   * read as a glitch rather than as a change of pace.
   */
  private get timerDue(): boolean {
    if (this.phrasesSinceChange < (this.current.minPhrases ?? 0)) return false;
    return this.barsSinceChange >= this.targetBars;
  }

  private resetCounters(): void {
    this.barsSinceChange = 0;
    this.phrasesSinceChange = 0;
    this.targetBars = randomRange(MIN_BARS, MAX_BARS);
  }

  private loadEnabled(): Set<string> {
    try {
      const raw = localStorage.getItem(ENABLED_KEY);
      if (raw) {
        const names = (JSON.parse(raw) as string[]).filter((n) =>
          this.presets.some((p) => p.name === n),
        );
        if (names.length > 0) return new Set(names);
      }
    } catch {
      // Corrupt or absent — fall through to everything enabled.
    }
    return new Set(this.presets.map((p) => p.name));
  }

  private saveEnabled(): void {
    localStorage.setItem(ENABLED_KEY, JSON.stringify([...this.enabledNames]));
  }
}
