import { decayProbability } from './Channels';
import { resolve, type Target } from './targets';
import { CHANNELS, write, type Treatment } from './treatments';
import type { EffectContext } from '../effects/types';
import type { LayerTrigger } from './Conductor';

/**
 * One brick. DESIGN.md §11.5.
 *
 * A target, a treatment, when it fires and how long it lasts. Four independent choices
 * where an effect used to be one fused decision — which is what turns a fixed vocabulary
 * into a set of combinations the VJ can reach.
 */
export interface LayerSpec {
  readonly treatment: Treatment;
  readonly target: Target;

  /** Several may be true. A checkbox each in the editor. */
  readonly triggers: Partial<Record<LayerTrigger, boolean>>;

  /**
   * Bars to fade. After this many bars about 5% remains.
   *
   * 0 means it holds until the text is replaced — which is what you want for something
   * meant to accumulate over a phrase rather than twinkle.
   */
  readonly decayBars: number;

  /** Only read by size treatments. Rolled within these bounds each time it fires. */
  readonly size?: { readonly min: number; readonly max: number };

  /**
   * Period of one cycle, in bars. Only read by periodic treatments — `flicker` today.
   *
   * 0.25 is one beat, 0.125 an eighth, 1 a whole bar. It is not a duration in seconds
   * precisely so that it stays on the grid when the tempo changes (§11.5).
   */
  readonly rateBars?: number;
}

/**
 * A layer, bound to its identity.
 *
 * The `id` is what `Channels` records as the owner of a value, so this layer's decay only
 * clears what this layer still holds. It is assigned by position in the preset, which also
 * makes it the stacking order: later layers sit on top.
 */
export class Layer {
  readonly id: number;

  /**
   * Mutable, so a live edit can retune a running layer without rebuilding the stack.
   *
   * The id is what `Channels` records as the owner of every value this layer has lit, so
   * constructing a replacement orphans all of them and the stage flashes. Editing the spec
   * in place keeps the id — and therefore keeps the ownership — which is what lets a slider
   * be dragged rather than nudged (§11.4).
   */
  spec: LayerSpec;

  constructor(id: number, spec: LayerSpec) {
    this.id = id;
    this.spec = spec;
  }

  /** Retune without disturbing what this layer already owns. */
  update(spec: LayerSpec): void {
    this.spec = spec;
  }

  /** Does this layer respond to the given trigger? */
  respondsTo(trigger: LayerTrigger): boolean {
    return this.spec.triggers[trigger] === true;
  }

  /**
   * Apply the treatment to whatever the target resolves to right now.
   *
   * Resolved per fire rather than cached, because the DOM is replaced on every re-typeset
   * and a cached selection would be a list of detached nodes within a phrase.
   */
  fire(ctx: EffectContext): void {
    const elements = resolve(this.spec.target, ctx.typesetter);
    if (elements.length === 0) return;

    for (const el of elements) {
      // Rolled per element, so a treatment with a size range scatters rather than
      // resizing every target to the same value.
      const written = write(this.spec.treatment, {
        ...(this.spec.size ? { size: this.spec.size } : {}),
        ...(this.spec.rateBars !== undefined ? { rateBars: this.spec.rateBars } : {}),
      });

      for (const { channel, value } of written) {
        ctx.channels.set(el, channel, value, this.id);
      }
    }
  }

  /** Fade this layer's own elements. Called every frame. */
  decay(ctx: EffectContext): void {
    const perFrame = decayProbability(this.spec.decayBars, ctx.dt, ctx.barSeconds);
    if (perFrame <= 0) return;

    ctx.channels.decay(this.id, CHANNELS[this.spec.treatment], perFrame);
  }

  /** Drop everything this layer holds, without waiting for it to fade. */
  clear(ctx: EffectContext): void {
    ctx.channels.clearOwner(this.id, CHANNELS[this.spec.treatment]);
  }

  /**
   * Rough cost, for the soft limit warning (§11.5).
   *
   * The number that matters is elements touched per second, not layer count — four layers
   * on 30% of characters is far heavier than ten on one word each. This is the per-fire
   * half of it; the caller multiplies by how often the lane fires.
   */
  estimateTouched(ctx: EffectContext): number {
    return resolve(this.spec.target, ctx.typesetter).length;
  }
}
