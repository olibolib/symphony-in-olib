import { chance, pick, pickSome, randomInt, randomRange } from '../util/random';
import type { EffectContext, EffectRef } from './types';

/**
 * The effect vocabulary. DESIGN.md §12.2 and §12.4.
 *
 * Each export is a *builder*: it takes parameters and returns a bound effect. That is what
 * lets a preset read as `glitchWords({ amount: 0.2 })` with full type checking — a mistyped
 * parameter is a compile error rather than a visual that silently never happens, which was
 * one of the main arguments for TypeScript here (§15).
 *
 * Every effect must tolerate an empty stage. There is no guarantee any text exists when a
 * lane fires, and §14 says failing silently is not acceptable — so they no-op deliberately
 * rather than by accident.
 */

/** Highest glitch slot defined in CSS. Keep in sync with style/stage.css. */
const MAX_GLITCH = 5;
const MAX_DECOR = 4;

// --- element effects -------------------------------------------------------------------

/**
 * Glitch every instance of one character at once — every "e" on the stage.
 *
 * The best effect in Acid, and the reason characters are addressable at all. It reads as
 * systematic corruption of the text rather than as random noise, which is a completely
 * different feeling: something is wrong with the alphabet, not with the screen.
 */
export const glitchChars = (params: { slot?: number } = {}): EffectRef => {
  return (ctx: EffectContext) => {
    const { chars } = ctx.typesetter;
    if (chars.length === 0) return;

    const seed = pick(chars);
    const code = seed?.dataset['ch'];
    if (!code) return;

    const slot = params.slot ?? randomRange(1, MAX_GLITCH);
    const group = ctx.stage.container.querySelectorAll<HTMLElement>(`c[data-ch="${code}"]`);
    for (const el of group) ctx.glitches.set(el, slot);
  };
};

/** Glitch a proportion of words. */
export const glitchWords = (params: { amount: number; slot?: number }): EffectRef => {
  return (ctx: EffectContext) => {
    const { words } = ctx.typesetter;
    if (words.length === 0) return;

    // Scale with the music: a quiet passage should not look like a loud one.
    const amount = params.amount * (0.4 + 0.6 * ctx.energy);
    const slot = params.slot ?? randomRange(1, MAX_GLITCH);

    for (const word of words) {
      if (chance(amount)) ctx.glitches.set(word, slot);
    }
  };
};

/** Glitch a single word. Cheap, good for dense lanes like hats. */
export const glitchWord = (params: { slot?: number } = {}): EffectRef => {
  return (ctx: EffectContext) => {
    const word = pick(ctx.typesetter.words);
    if (word) ctx.glitches.set(word, params.slot ?? randomRange(1, MAX_GLITCH));
  };
};

/** Glitch whole paragraphs together — a much heavier gesture than scattered words. */
export const glitchParagraphs = (params: { amount: number }): EffectRef => {
  return (ctx: EffectContext) => {
    const { paragraphs } = ctx.typesetter;
    if (paragraphs.length === 0) return;

    const slot = randomRange(1, MAX_GLITCH);
    for (const paragraph of paragraphs) {
      if (!chance(params.amount)) continue;
      for (const el of paragraph.querySelectorAll<HTMLElement>('w')) {
        ctx.glitches.set(el, slot);
      }
    }
  };
};

/** Decay glitches back to normal. Belongs in `ambient`, not on a lane. */
export const removeGlitches = (params: { amount: number }): EffectRef => {
  return (ctx: EffectContext) => ctx.glitches.decay(params.amount);
};

/** The second slot: underlines, strikes, outlines. Independent of `glitch`. */
export const decor = (params: { count: number }): EffectRef => {
  return (ctx: EffectContext) => {
    const targets = ctx.typesetter.targets;
    if (targets.length === 0) return;

    for (let i = 0; i < params.count; i++) {
      const el = pick(targets);
      if (el) el.dataset['decor'] = String(randomRange(1, MAX_DECOR));
    }
  };
};

/** Inversion blocks — Acid's `.selected`. Black block, white text. */
export const invertBlock = (params: { count: number }): EffectRef => {
  return (ctx: EffectContext) => {
    const targets = ctx.typesetter.targets;
    if (targets.length === 0) return;

    for (let i = 0; i < params.count; i++) {
      pick(targets)?.classList.add('selected');
    }
  };
};

export const clearInversions = (params: { amount: number }): EffectRef => {
  return (ctx: EffectContext) => {
    const selected = ctx.stage.container.querySelectorAll<HTMLElement>('.selected');
    for (const el of selected) {
      if (chance(params.amount)) el.classList.remove('selected');
    }
  };
};

/**
 * Swell elements so they push the layout around.
 *
 * Sets a minimum size and lets the CSS transition animate it. The shoving of neighbouring
 * text is the point — it is the layout being deformed rather than decorated.
 */
export const swell = (params: { count: number; amount: number }): EffectRef => {
  return (ctx: EffectContext) => {
    const targets = ctx.typesetter.targets;
    if (targets.length === 0) return;

    for (let i = 0; i < params.count; i++) {
      const el = pick(targets);
      if (el) el.style.minWidth = `${params.amount * (0.5 + ctx.bass)}em`;
    }
  };
};

export const unswell = (params: { amount: number }): EffectRef => {
  return (ctx: EffectContext) => {
    const swollen = ctx.stage.container.querySelectorAll<HTMLElement>('[style*="min-width"]');
    for (const el of swollen) {
      if (chance(params.amount)) el.style.removeProperty('min-width');
    }
  };
};

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
 * Re-render the text.
 *
 * `every` skips invocations, so bound to `phrase` with `every: 2` the text changes every
 * other phrase. That matters when the output is being warped by a visualiser: changing the
 * source every 16 beats means the warp never has time to develop before the thing it is
 * warping disappears.
 *
 * The counter lives in the closure — effects are built once and called many times, so a
 * builder is a perfectly good place to keep state that belongs to one binding.
 */
export const retext = (params: { every?: number } = {}): EffectRef => {
  const every = Math.max(1, params.every ?? 1);
  let count = 0;

  return (ctx: EffectContext) => {
    count++;
    if (count % every !== 0) return;
    ctx.retext();
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
    ctx.glitches.clearAll();
  };
};
