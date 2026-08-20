/**
 * Named palettes. DESIGN.md §12.5.
 *
 * Colour is an accent on a couple of slots, never across the whole stage — narrowing to a
 * few at a time is what keeps Acid coherent rather than confetti.
 *
 * When compositing over existing visuals, saturated accents clash badly with whatever is
 * underneath. `mono` and `none` exist for that: they keep the typographic effects and drop
 * the colour entirely, which is usually what you want over a busy background.
 */
export type PaletteName = 'acid' | 'mono' | 'warm' | 'cool' | 'none';

export const PALETTES: Record<PaletteName, readonly string[]> = {
  /** Acid's original set. Loud, and designed for a plain white background. */
  acid: ['#00ffff', '#ff3300', '#ffff00', '#ff0000', '#0000ff', '#999999', '#444444', '#cccccc'],

  /** Greys only. Reads as tonal variation rather than colour — safest over video. */
  mono: ['#ffffff', '#cccccc', '#999999', '#666666', '#333333'],

  warm: ['#ff3300', '#ff8800', '#ffcc00', '#ff0055', '#cc2200'],

  cool: ['#00ffff', '#0088ff', '#0000ff', '#00ffaa', '#6600ff'],

  /** No accents at all — every slot stays the stage foreground colour. */
  none: [],
};

export const PALETTE_NAMES = Object.keys(PALETTES) as PaletteName[];

/** Kept for anything still importing the old flat export. */
export const PALETTE = PALETTES.acid;
