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

// --- layout effects --------------------------------------------------------------------

/**
 * Change the layout slot on the stage — the main look switch.
 *
 * Picks from whichever set the user has selected rather than a numeric range, so choosing
 * "edges" in the HUD genuinely constrains every layout change from then on.
 */
export const newLayout = (): EffectRef => {
  return (ctx: EffectContext) => {
    const options = ctx.layouts;
    if (options.length === 0) return;

    const current = ctx.stage.container.dataset['layout'];
    const choices = options.length > 1 ? options.filter((n) => String(n) !== current) : options;

    const next = pick(choices);
    if (next !== undefined) ctx.stage.container.dataset['layout'] = String(next);
  };
};

export const columns = (params: { min: number; max: number }): EffectRef => {
  return (ctx: EffectContext) => {
    ctx.stage.container.style.columnCount = String(randomRange(params.min, params.max));
  };
};

export const fontScale = (params: { min: number; max: number }): EffectRef => {
  return (ctx: EffectContext) => {
    const scale = params.min + Math.random() * (params.max - params.min);
    ctx.stage.setFontScale(scale);
  };
};

export const borders = (params: { max: number }): EffectRef => {
  return (ctx: EffectContext) => {
    ctx.stage.container.dataset['borders'] = chance(0.5)
      ? String(randomRange(1, params.max))
      : '0';
  };
};

/**
 * Set a vertical drift. DESIGN.md §12.4.
 *
 * Follows Acid's `randomScrollSpd`: mostly it picks a new speed and direction, but it also
 * has a real chance of stopping altogether. Constant motion stops registering as motion —
 * the stillness is what makes the drift readable when it returns.
 */
export const scroll = (params: { power: number }): EffectRef => {
  return (ctx: EffectContext) => {
    if (chance(0.25)) {
      ctx.stage.scrollSpeed = 0;
      return;
    }
    const direction = chance(0.7) ? 1 : -1;
    ctx.stage.scrollSpeed = direction * Math.random() * params.power;
  };
};

export const stopScroll = (): EffectRef => {
  return (ctx: EffectContext) => {
    ctx.stage.scrollSpeed = 0;
  };
};

/**
 * Re-render the text, holding it for a variable number of phrases.
 *
 * `hold: [1, 2]` means the text stays for one phrase or two, chosen fresh each time. A fixed
 * hold is legible but predictable — you start anticipating the change, which is exactly what
 * a generative visual should not let you do.
 *
 * When the text is being warped by a visualiser, a longer hold also gives the warp time to
 * develop before the thing it is warping disappears.
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

export const stopPulse = (): EffectRef => {
  return (ctx: EffectContext) => {
    ctx.stage.pulse = 0;
  };
};

// --- colour ----------------------------------------------------------------------------

/**
 * Reseat the colour slots. DESIGN.md §12.5.
 *
 * Writes eight CSS variables, not inline styles on thousands of elements — the elements
 * were assigned a slot at typeset time and CSS does the rest. Most slots stay black; a
 * couple take an accent. Narrowing to a few colours at a time is what keeps Acid coherent
 * rather than confetti, and it is worth preserving exactly.
 */
export const colourShift = (params: { accents: number } = { accents: 2 }): EffectRef => {
  return (ctx: EffectContext) => {
    const accents = pickSome(ctx.palette, params.accents);
    const style = ctx.stage.el.style;

    // Base slots follow the stage foreground rather than a hardcoded black. On a
    // transparent or black background, black text is invisible — and the colour slots
    // override --stage-fg, so hardcoding here would silently blank the stage.
    for (let slot = 0; slot < 8; slot++) {
      style.setProperty(`--c${slot}`, 'var(--stage-fg)');
    }
    for (const accent of accents) {
      style.setProperty(`--c${randomInt(8)}`, accent);
    }
  };
};

/**
 * Flip the stage background. Rare and heavy — a whole-screen event.
 *
 * No-ops in transparent mode. Painting a background there would silently undo the setting,
 * and the first anyone would know is a solid rectangle appearing on the stream.
 */
export const background = (params: { accents?: boolean } = {}): EffectRef => {
  return (ctx: EffectContext) => {
    // Only flips in the default white mode, where inverting is part of the Acid look.
    // An explicit black or transparent choice is a decision about output, not a style, and
    // an effect should not quietly overrule it.
    if (ctx.stage.backgroundMode !== 'white') return;

    const dark = params.accents === true ? pick(ctx.palette) : chance(0.5) ? '#000000' : '#ffffff';
    ctx.stage.el.style.background = dark ?? '#ffffff';
    ctx.stage.el.style.setProperty('--stage-fg', dark === '#000000' ? '#ffffff' : '#000000');
  };
};

export const resetStage = (): EffectRef => {
  return (ctx: EffectContext) => {
    const el = ctx.stage.container;
    delete el.dataset['layout'];
    delete el.dataset['borders'];
    el.style.removeProperty('column-count');
    ctx.stage.scrollSpeed = 0;
    ctx.stage.el.style.removeProperty('background');
    ctx.stage.el.style.removeProperty('--stage-fg');
    ctx.channels.clearAll();
  };
};
