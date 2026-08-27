import { chance, pick, pickSome, randomInt, randomRange } from '../util/random';
import type { EffectContext, EffectRef } from './types';

/**
 * The stage effect vocabulary. DESIGN.md §12.4.
 *
 * Each export is a *builder*: it takes parameters and returns a bound effect, so a preset
 * reads as `pulse({ amount: 0.02 })` with full type checking — a mistyped parameter is a
 * compile error rather than a visual that silently never happens, which was one of the main
 * arguments for TypeScript here (§15).
 *
 * **Element effects have left this file.** `glitchWords`, `invertBlock`, `decor` and the
 * rest were each a target fused to a treatment, which is why "invert every instance of the
 * letter e" could not be expressed even though both halves existed. They are now
 * `show/targets.ts` and `show/treatments.ts`, combined per layer by the preset (§11.5).
 *
 * What remains is stage-wide — layout, colour, scroll, pulse — where there is no target to
 * separate out.
 *
 * Every effect must tolerate an empty stage. There is no guarantee any text exists when a
 * lane fires, and §14 says failing silently is not acceptable — so they no-op deliberately
 * rather than by accident.
 */

export const retext = (params: { hold?: readonly [number, number] } = {}): EffectRef => {
  const [min, max] = params.hold ?? [1, 1];
  let target = randomRange(min, max);

  return (ctx: EffectContext) => {
    if (ctx.textAge < target) return;
    target = randomRange(min, max);
    ctx.retext();
  };
};

/**
 * Pulse the whole stage with the beat.
 *
 * Driven by the predicted grid rather than by detected onsets, so it stays smooth and in
 * time even through a passage with no transients — and lands *on* the beat rather than
 * just after it.
 *
 * `decay` hits hard and falls away, which reads as a kick. `sine` breathes evenly, which
 * suits slower presets. Amounts want to be small: 0.02 is already clearly visible at 720p,
 * and anything past about 0.05 starts to look like a fault rather than a pulse.
 */
export const pulse = (params: {
  amount: number;
  shape?: 'decay' | 'sine';
}): EffectRef => {
  return (ctx: EffectContext) => {
    const phase = ctx.beatPhase;
    const curve =
      params.shape === 'sine'
        ? (1 - Math.cos(phase * Math.PI * 2)) / 2
        : (1 - phase) * (1 - phase);

    ctx.stage.pulse = curve * params.amount;
  };
};
