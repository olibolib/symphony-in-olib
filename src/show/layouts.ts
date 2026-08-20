/**
 * Layout sets. DESIGN.md §12.4.
 *
 * A layout is a number on the stage; CSS decides what it looks like. A *set* is which
 * numbers the `newLayout` effect is allowed to pick from.
 *
 * `edges` exists because this is often composited over other visuals, and those visuals
 * usually have their subject in the middle of the frame. Text landing on top of it is the
 * single fastest way to make a good VJ set look like a mistake — so the edge layouts keep
 * the centre of the stage clear and work around it.
 */
export type LayoutSetName = 'centre' | 'edges' | 'all';

/**
 * Weighting is expressed by repetition rather than a separate weights map.
 *
 * Crude, but it keeps the whole thing readable at a glance and there is no arithmetic to
 * get wrong. The single-band layouts (10, 11) are deliberately rare: a lone strip of text
 * across the top or bottom is the least interesting thing here, and at equal weight it was
 * coming up nearly half the time.
 */
export const LAYOUT_SETS: Record<LayoutSetName, readonly number[]> = {
  /** The default vocabulary, ported from Acid. Uses the whole stage. */
  centre: [0, 1, 2, 3, 4, 5, 6, 7, 8],

  /** Keeps the middle clear. Scattered blocks dominate; plain bands are occasional. */
  edges: [
    15, 15, 15, // scattered blocks — the most interesting, so the most frequent
    16, 16,     // corners
    17, 17,     // diagonal, large type
    12, 12,     // two rails
    13,         // left rail
    14,         // right rail
    10,         // top band
    11,         // bottom band
  ],

  all: [
    0, 1, 2, 3, 4, 5, 6, 7, 8,
    15, 15, 16, 17, 12, 13, 14, 10, 11,
  ],
};

export const LAYOUT_SET_NAMES = Object.keys(LAYOUT_SETS) as LayoutSetName[];
