import type { EffectContext, EffectRef } from '../effects/types';

/**
 * Routes lane events to effects. DESIGN.md §7 and §11.1.
 *
 * This is the piece that replaces Acid's 968-line `react()` function — one if/else chain
 * over twenty-five hardcoded scene numbers. Here a preset is data: a map from lane name to
 * a list of effects. Adding behaviour means registering an effect, not editing a switch,
 * and reordering presets cannot break anything because nothing is keyed on position.
 */

export type Lane = 'kick' | 'snare' | 'hat' | 'beat' | 'bar' | 'phrase';

export type Bindings = Partial<Record<Lane, readonly EffectRef[]>>;

export interface Programme {
  readonly bindings: Bindings;
  /** Effects run every frame rather than on an event — decay, drift, and so on. */
  readonly ambient?: readonly EffectRef[];
}

export class Conductor {
  private programme: Programme = { bindings: {} };

  /** Effects that threw, so a broken one is reported once rather than every frame. */
  private readonly reported = new Set<string>();

  load(programme: Programme): void {
    this.programme = programme;
  }

  /** Dispatch a lane event. */
  fire(lane: Lane, ctx: EffectContext): void {
    const effects = this.programme.bindings[lane];
    if (!effects) return;
    for (const effect of effects) this.run(effect, ctx, lane);
  }

  /** Run the per-frame effects. */
  tick(ctx: EffectContext): void {
    const ambient = this.programme.ambient;
    if (!ambient) return;
    for (const effect of ambient) this.run(effect, ctx, 'ambient');
  }

  /**
   * Run one effect, containing any failure.
   *
   * DESIGN.md §14: an uncaught error in one effect must not take down the frame loop. A
   * broken effect during a set should cost that effect, not the visual — but it must also
   * not fail *silently*, so it is logged once per lane and then suppressed.
   */
  private run(effect: EffectRef, ctx: EffectContext, lane: string): void {
    try {
      effect(ctx);
    } catch (error) {
      const key = `${lane}:${String(error)}`;
      if (!this.reported.has(key)) {
        this.reported.add(key);
        console.error(`[olib] effect failed on lane "${lane}"`, error);
      }
    }
  }
}
