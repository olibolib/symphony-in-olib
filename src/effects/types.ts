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
  readonly glitches: GlitchState;

  /** Continuous 0–1 lanes, for scaling how much an effect does. */
  readonly energy: number;
  readonly bass: number;

  /** Accent colours the user has selected. Empty means "no colour". */
  readonly palette: readonly string[];
  /** Layout numbers `newLayout` may choose from. */
  readonly layouts: readonly number[];

  /** Re-render the current text preset. Some effects change what is on screen. */
  retext(): void;
}

/**
 * An effect, already bound to its parameters. Built by the helpers in `effects/index.ts`,
 * so a preset reads as `glitchWords({ amount: 0.2 })` and gets checked at compile time
 * rather than failing silently at 2am.
 */
export type EffectRef = (ctx: EffectContext) => void;

/**
 * Tracks which elements currently carry a non-zero glitch slot.
 *
 * Without this, decaying glitches means a `querySelectorAll('[data-glitch]:not(...)')`
 * across the whole stage every frame — thousands of elements, sixty times a second, to
 * find the handful that are lit. Keeping a set makes decay proportional to what is
 * actually glitched, which is usually a few dozen. DESIGN.md §14.
 */
export class GlitchState {
  private readonly active = new Set<HTMLElement>();

  set(el: HTMLElement, value: number): void {
    if (value === 0) {
      this.clear(el);
      return;
    }
    el.dataset['glitch'] = String(value);
    this.active.add(el);
  }

  clear(el: HTMLElement): void {
    delete el.dataset['glitch'];
    this.active.delete(el);
  }

  /** Randomly clear a proportion of lit elements. Acid's `removeGlitches`. */
  decay(fraction: number): void {
    if (this.active.size === 0) return;
    for (const el of Array.from(this.active)) {
      if (Math.random() < fraction) this.clear(el);
    }
  }

  clearAll(): void {
    for (const el of this.active) delete el.dataset['glitch'];
    this.active.clear();
  }

  /** Called after a re-typeset: the tracked elements no longer exist. */
  forget(): void {
    this.active.clear();
  }

  get size(): number {
    return this.active.size;
  }
}
