/**
 * Where text may be placed. DESIGN.md §11.6.
 *
 * A 7x7 grid of cells, written as rows of characters so a preset file shows you the shape
 * rather than making you decode coordinates:
 *
 * ```
 * "#######"     "#######"     "..###.."
 * "#######"     "#.....#"     "..###.."
 * "##...##"     "#.....#"     "..###.."
 * "##...##"     "#.....#"     "..###.."
 * "##...##"     "#.....#"     "..###.."
 * "#######"     "#.....#"     "..###.."
 * "#######"     "#######"     "..###.."
 *  keep the      edges only    a centre column
 *  middle clear
 * ```
 *
 * It diffs sensibly in git, which a packed bitfield does not, and it is legible in a code
 * review, which a list of coordinates is not.
 *
 * **7x7 rather than 5x5** because odd is required — an even grid has no centre cell, and
 * "keep off the middle" is the thing this must express well — and because at 5x5, excluding
 * the middle 3x3 leaves text only on the outermost ring, hard against the frame edge with
 * nowhere else to go. At 7x7 the same exclusion leaves two rings.
 */

import { pick, randomRange, shuffled } from '../util/random';

export const GRID = 7;

const ON = '#';
const OFF = '.';

/** Rows of `#` and `.`, one string per row. */
export type Mask = readonly string[];

export interface Cell {
  readonly row: number;
  readonly col: number;
}

/** A placed block, as percentages of the stage. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface Range {
  readonly min: number;
  readonly max: number;
}

/**
 * A candidate block size in cells.
 *
 * A list of these rather than one pair of ranges, because width and height are *related*:
 * rolling them independently keeps landing on the square blob between the tall column and
 * the wide band that were actually wanted (§11.6).
 */
export interface BlockShape {
  readonly cols: Range;
  readonly rows: Range;
}

/** Every cell allowed. The default for a preset that has not been given a shape. */
export const FULL: Mask = Array.from({ length: GRID }, () => ON.repeat(GRID));

/**
 * The historical default, and what the 3x3 grid did: keep the middle clear.
 *
 * Composited output usually has its subject in the centre — a logo, a visualiser's focal
 * point — and text landing on it is the fastest way to spoil the frame.
 */
export const KEEP_CENTRE_CLEAR: Mask = [
  '#######',
  '#######',
  '##...##',
  '##...##',
  '##...##',
  '#######',
  '#######',
];

/**
 * Normalise anything to a well-formed mask.
 *
 * Masks arrive from preset files and from saved settings, so they can be the wrong length,
 * ragged, or full of characters nobody intended. Rather than throwing during a set, short
 * rows are padded as allowed and unknown characters are read as allowed — the failure mode
 * of "more space than expected" is visible and recoverable, where "no space at all" is a
 * blank screen with no explanation (§14).
 */
export function normalise(mask: Mask | undefined): Mask {
  if (!mask || mask.length === 0) return FULL;

  const rows: string[] = [];
  for (let row = 0; row < GRID; row++) {
    const source = mask[row] ?? '';
    let out = '';
    for (let col = 0; col < GRID; col++) {
      out += source[col] === OFF ? OFF : ON;
    }
    rows.push(out);
  }
  return rows;
}

export function isAllowed(mask: Mask, row: number, col: number): boolean {
  return mask[row]?.[col] !== OFF;
}

/**
 * Both masks must allow a cell.
 *
 * The VJ's global mask is a fact about tonight — there is a logo bottom-right and nothing
 * should start there. The preset's is its own composition. Intersecting means a preset can
 * only ever be *more* restricted than the global rule, never less, so a preset built weeks
 * ago and forgotten cannot start somewhere deliberately ruled out.
 */
export function intersect(a: Mask, b: Mask): Mask {
  const left = normalise(a);
  const right = normalise(b);

  return left.map((row, r) =>
    Array.from(row, (char, c) => (char === OFF || right[r]?.[c] === OFF ? OFF : ON)).join(''),
  );
}

/** Every cell a block may anchor at. Empty means the preset cannot be placed. */
export function anchors(mask: Mask): readonly Cell[] {
  const out: Cell[] = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      if (isAllowed(mask, row, col)) out.push({ row, col });
    }
  }
  return out;
}

/**
 * Place a block of the given size at an anchor, as percentages of the stage.
 *
 * **A block may extend past the mask, and that is deliberate.** The mask says where a block
 * may *start*; how big it is, is a separate decision the VJ made. Requiring the whole block
 * to fit would mean the app searching for somewhere it fits, silently shrinking it, or
 * refusing to place it — all three second-guess a size that was chosen on purpose.
 *
 * **Position clamps to the canvas; size never does.** Overflowing into the middle of the
 * frame is a look you chose and can see. Overflowing off the *edge* is not: text nobody can
 * read reads as a fault rather than a decision. So a block that would run off is shifted
 * back until it fits, keeping every pixel of the size it was given.
 */
export function place(anchor: Cell, cols: number, rows: number): Box {
  const w = clampSpan(cols);
  const h = clampSpan(rows);

  const col = Math.min(anchor.col, GRID - w);
  const row = Math.min(anchor.row, GRID - h);

  const unit = 100 / GRID;
  return {
    left: col * unit,
    top: row * unit,
    width: w * unit,
    height: h * unit,
  };
}

/**
 * Nudge a placed box, in percentages of the stage.
 *
 * Applied after the grid has done its work, so it is genuinely fine adjustment rather than a
 * second placement system. **Clamped to the canvas like the anchor is**: an offset that pushed
 * a block off the edge would hide the text, and the grid exists precisely so that cannot
 * happen by accident.
 */
export function nudge(box: Box, dx: number, dy: number): Box {
  const left = Math.min(Math.max(0, box.left + dx), Math.max(0, 100 - box.width));
  const top = Math.min(Math.max(0, box.top + dy), Math.max(0, 100 - box.height));
  return { ...box, left, top };
}

function clampSpan(cells: number): number {
  if (!Number.isFinite(cells)) return 1;
  return Math.min(GRID, Math.max(1, Math.round(cells)));
}

/** For the control window's clickable grid, and for writing a mask back to settings. */
export function toggle(mask: Mask, row: number, col: number): Mask {
  const rows = normalise(mask).map((line, r) => {
    if (r !== row) return line;
    const chars = Array.from(line);
    chars[col] = chars[col] === OFF ? ON : OFF;
    return chars.join('');
  });

  // A mask with nothing allowed has no failure mode worth having: every preset would be
  // skipped and the stage would simply go empty with no indication why. Refuse the last one.
  return anchors(rows).length === 0 ? normalise(mask) : rows;
}

/**
 * Place every block for one typeset, optionally keeping them apart.
 *
 * Blocks *can* overlap under anchor semantics — the VJ picks the anchor and the size, and
 * the app second-guessing that is worse than the occasional collision. But when the shapes
 * are authored rather than arbitrary, a non-overlapping arrangement almost always exists,
 * and finding it is cheap: this runs once per typeset, a few times a minute.
 *
 * So `avoidOverlap` is a preset setting, on by default. It changes *which* of the allowed
 * placements is chosen, never whether a placement happens.
 */
export function placeBlocks(
  cells: readonly Cell[],
  shapes: readonly BlockShape[],
  count: number,
  avoidOverlap: boolean,
): readonly Box[] {
  const placed: Box[] = [];

  for (let i = 0; i < count; i++) {
    placed.push(placeOne(cells, shapes, placed, avoidOverlap));
  }
  return placed;
}

function placeOne(
  cells: readonly Cell[],
  shapes: readonly BlockShape[],
  placed: readonly Box[],
  avoidOverlap: boolean,
): Box {
  const roll = (): Box => {
    const anchor = pick(cells) ?? { row: 0, col: 0 };
    const shape = pick(shapes);
    const cols = shape ? randomRange(shape.cols.min, shape.cols.max) : 1;
    const rows = shape ? randomRange(shape.rows.min, shape.rows.max) : 1;
    return place(anchor, cols, rows);
  };

  if (!avoidOverlap || placed.length === 0) return roll();

  // Every anchor against every shape, in random order, taking the first that fits. Bounded
  // at 49 x shapes and only reached on a re-typeset, so exhaustive is affordable — and
  // exhaustive is what makes "no arrangement exists" mean it, rather than meaning the
  // random attempts ran out.
  for (const anchor of shuffled(cells)) {
    for (const shape of shuffled(shapes)) {
      const box = place(
        anchor,
        randomRange(shape.cols.min, shape.cols.max),
        randomRange(shape.rows.min, shape.rows.max),
      );
      if (!placed.some((other) => overlaps(box, other))) return box;
    }
  }

  // Nothing fits: the mask is tight, the shapes are large, or there are simply too many
  // blocks. Place it anyway. An overlapping block is a visible compromise; a missing one is
  // indistinguishable from text that failed to render (§14).
  return roll();
}

/** Touching edges do not count — blocks carry their own padding, so abutting reads fine. */
function overlaps(a: Box, b: Box): boolean {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}
