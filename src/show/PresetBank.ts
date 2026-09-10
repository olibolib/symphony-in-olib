import { pick, randomRange } from '../util/random';
import type { VisualPreset } from './presets';
import { browserSettings, type Settings } from '../util/settings';

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

/**
 * What is switched **off**, not what is on.
 *
 * Storing the enabled list looks equivalent and is not: a preset that did not exist when the
 * list was written is absent from it, so it comes back disabled and never cycles. Since
 * presets are created and loaded from disk after the bank is built, that happened to every
 * preset the user made — it would be saved, reappear in the list, and silently never play.
 *
 * Recording the exclusions means anything new is on by default, which is the only sensible
 * answer for a preset nobody has expressed an opinion about.
 */
const DISABLED_KEY = 'olib.disabledPresets';

/** The old enabled-list key, read once to carry a previous session's choices over. */
const LEGACY_ENABLED_KEY = 'olib.enabledPresets';

/**
 * Which preset was on stage when the app last closed.
 *
 * The enabled set says what *may* play; this says what *was* playing. Without it every
 * launch starts on whichever preset happens to be first in the list, which is not a choice
 * anybody made — it is just the order the array is in.
 */
const LIVE_KEY = 'olib.livePreset';

export class PresetBank {
  private presets: readonly VisualPreset[];
  private index: number;

  /** Names excluded from the cycle. Everything else plays — see `setEnabled`. */
  private disabledNames: Set<string>;

  /** Whether the live preset is a remembered choice rather than the head of the list. */
  private restored: boolean;

  /** Chosen but not yet applied. Applied at the next phrase. */
  private queued: string | null = null;

  private barsSinceChange = 0;
  private phrasesSinceChange = 0;
  private targetBars: number;

  /**
   * @param settings Where the live preset and the exclusions are kept. Defaults to the browser,
   * so the engine constructs this the way it always did; a test passes an in-memory one and the
   * cycle policy becomes exercisable without a DOM (§7.3).
   */
  constructor(presets: readonly VisualPreset[], private readonly settings: Settings = browserSettings) {
    if (presets.length === 0) throw new Error('PresetBank needs at least one preset');
    this.presets = presets;
    const saved = presets.findIndex((p) => p.name === settings.get(LIVE_KEY));
    this.index = saved >= 0 ? saved : 0;
    this.restored = saved >= 0;

    this.targetBars = randomRange(MIN_BARS, MAX_BARS);
    this.disabledNames = this.loadDisabled();
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

    if (this.restored) {
      const found = presets.findIndex((p) => p.name === liveName);
      this.index = found >= 0 ? found : Math.min(this.index, presets.length - 1);
    } else {
      // The bank is built from the compiled presets and only later replaced by what is on
      // disk, so a preset the user made themselves does not exist yet when the constructor
      // looks for it. This is the second chance, and the only one it needs.
      const saved = presets.findIndex((p) => p.name === this.settings.get(LIVE_KEY));
      this.index = saved >= 0 ? saved : Math.min(this.index, presets.length - 1);
      this.restored = saved >= 0;
    }

    // A queued name that no longer exists would sit there being checked forever.
    if (this.queued !== null && !presets.some((p) => p.name === this.queued)) {
      this.queued = null;
    }

    // Exclusions for presets that no longer exist would sit there for ever, and would apply
    // again if a preset were later created with the same name.
    const names = new Set(presets.map((p) => p.name));
    for (const name of Array.from(this.disabledNames)) {
      if (!names.has(name)) this.disabledNames.delete(name);
    }

    // The cycle must never have nothing to choose from.
    if (this.enabledCount === 0) this.disabledNames.delete(this.current.name);
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
    return !this.disabledNames.has(name);
  }

  private get enabledCount(): number {
    return this.presets.filter((p) => this.isEnabled(p.name)).length;
  }

  /**
   * Enable or disable a preset for the automatic cycle.
   *
   * **At least one must stay enabled.** Disabling the last one would leave the cycle with
   * nothing to choose and the visual frozen on whatever happened to be running — a silent
   * failure of exactly the kind §14 rules out. The request is refused instead.
   */
  setEnabled(name: string, enabled: boolean): boolean {
    if (!enabled && this.enabledCount <= 1 && this.isEnabled(name)) {
      return false;
    }

    if (enabled) this.disabledNames.delete(name);
    else this.disabledNames.add(name);

    this.saveDisabled();
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
        this.saveLive();
        return this.current;
      }
    }

    if (!this.timerDue) return null;

    const others = this.presets.filter(
      (p) => this.isEnabled(p.name) && p.name !== this.current.name,
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
    this.saveLive();
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

  /**
   * Read the exclusions, migrating a previous session's enabled list if that is all there is.
   *
   * The migration cannot be perfect — an enabled list only describes the presets that existed
   * when it was written — but inverting it against the compiled built-ins carries over the
   * choice that was actually made about them, which is the part worth keeping.
   */
  private loadDisabled(): Set<string> {
    try {
      const raw = this.settings.get(DISABLED_KEY);
      if (raw !== null) return new Set(JSON.parse(raw) as string[]);

      const legacy = this.settings.get(LEGACY_ENABLED_KEY);
      if (legacy !== null) {
        const wasEnabled = new Set(JSON.parse(legacy) as string[]);
        const disabled = this.presets
          .map((p) => p.name)
          .filter((name) => !wasEnabled.has(name));

        this.settings.set(DISABLED_KEY, JSON.stringify(disabled));
        this.settings.remove(LEGACY_ENABLED_KEY);
        return new Set(disabled);
      }
    } catch {
      // Corrupt or absent. Everything plays, which is the safe direction to fail in: a
      // silent bank is much worse than one preset you have to switch off again.
    }
    return new Set();
  }

  /**
   * Remember what is on stage.
   *
   * Written on every change rather than on close: a VJ tool gets killed, not quit, and a
   * setting that only survives a clean shutdown is a setting that does not survive.
   */
  private saveLive(): void {
    this.restored = true;
    this.settings.set(LIVE_KEY, this.current.name);
  }

  private saveDisabled(): void {
    this.settings.set(DISABLED_KEY, JSON.stringify([...this.disabledNames]));
  }
}
