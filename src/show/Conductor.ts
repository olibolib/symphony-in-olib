import type { EffectContext, EffectRef } from '../effects/types';
import type { Layer } from './Layer';

/**
 * Routes lane events to layers and stage effects. DESIGN.md §7, §11.1 and §11.5.
 *
 * This is the piece that replaces Acid's 968-line `react()` function — one if/else chain
 * over twenty-five hardcoded scene numbers. Here a preset is data, and nothing is keyed on
 * position, so presets can be reordered and edited without breaking anything.
 *
 * Two kinds of thing are dispatched, and the split is not arbitrary:
 *
 * - **Layers** do something to *elements*, and are built from a target and a treatment that
 *   the VJ chose separately (§11.5).
 * - **Stage effects** do something to the *stage* — layout, colour, scroll, pulse — where
 *   there is no target to separate out, so they stay closures.
 */

export type Lane = 'kick' | 'snare' | 'hat' | 'beat' | 'bar' | 'phrase';

/**
 * What a layer can be triggered by. A superset of the lanes.
 *
 * `held` fires on a phrase boundary where the text was *not* replaced — the layer form of
 * `whenHolding`, which exists because static text for two phrases needs more happening to
 * it or the second phrase reads as a stall. `always` fires every frame, for anything that
 * should be continuously present rather than struck.
 *
 * `enter` fires once, when a preset goes live. It is where anything that should hold for the
 * preset's whole run belongs — the palette, most obviously. A setting bound to `phrase`
 * changes under text that is still on screen, and on a conveyor that is text the audience is
 * still reading.
 *
 * None of the three is a real lane: no audio event produces them and they are dispatched by
 * the engine alongside the lanes they shadow.
 */
export type LayerTrigger = Lane | 'held' | 'always' | 'enter';

export type Bindings = Partial<Record<LayerTrigger, readonly EffectRef[]>>;

export interface Programme {
  /** Ordered: later layers sit on top when they contend for a channel. */
  readonly layers: readonly Layer[];
  readonly bindings: Bindings;
  /** Stage effects run every frame rather than on an event — drift, pulse, and so on. */
  readonly ambient?: readonly EffectRef[];
}

export class Conductor {
  private programme: Programme = { layers: [], bindings: {} };

  /** Effects that threw, so a broken one is reported once rather than every frame. */
  private readonly reported = new Set<string>();

  load(programme: Programme): void {
    this.programme = programme;
  }

  get layers(): readonly Layer[] {
    return this.programme.layers;
  }

  /**
   * Dispatch a lane event.
   *
   * Layers fire before stage effects. A stage effect on the same lane may re-typeset, and
   * anything a layer wrote to elements that no longer exist is wasted work — cheap, but
   * this way round the ordering is at least deliberate rather than accidental.
   */
  fire(trigger: LayerTrigger, ctx: EffectContext): void {
    for (const layer of this.programme.layers) {
      if (!layer.respondsTo(trigger)) continue;
      this.guard(() => layer.fire(ctx), `layer:${layer.spec.treatment}`);
    }

    const effects = this.programme.bindings[trigger];
    if (!effects) return;
    for (const effect of effects) this.guard(() => effect(ctx), trigger);
  }

  /**
   * Per-frame work: every layer fades its own elements, then the stage effects run.
   *
   * Decay used to be a single ambient effect clearing everything at one rate, which meant
   * an inversion could not fade slower than a glitch. It is now a property of the layer.
   */
  tick(ctx: EffectContext): void {
    this.fire('always', ctx);

    for (const layer of this.programme.layers) {
      this.guard(() => layer.decay(ctx), `decay:${layer.spec.treatment}`);
    }

    const ambient = this.programme.ambient;
    if (!ambient) return;
    for (const effect of ambient) this.guard(() => effect(ctx), 'ambient');
  }

  /**
   * Run one piece of work, containing any failure.
   *
   * DESIGN.md §14: an uncaught error in one effect must not take down the frame loop. A
   * broken effect during a set should cost that effect, not the visual — but it must also
   * not fail *silently*, so it is logged once per site and then suppressed.
   */
  private guard(run: () => void, site: string): void {
    try {
      run();
    } catch (error) {
      const key = `${site}:${String(error)}`;
      if (!this.reported.has(key)) {
        this.reported.add(key);
        console.error(`[olib] failed at "${site}"`, error);
      }
    }
  }
}
