import { describe, expect, it } from 'vitest';
import { alignFor } from './Typesetter';

/**
 * `align: auto`. DESIGN.md §11.6.
 *
 * One more option in the same dropdown as left, centre, right and justify — not a mode. A
 * preset that wants everything centred whatever the grid does still says `centre`.
 *
 * The rule is: set toward the nearer edge of the canvas, so text throws inward. A block
 * anchored at the left of the grid sets left, and a long word extends into the frame rather
 * than out of it.
 */

/** Blocks are placed on a 7x7 grid, so a cell is a seventh of the canvas. */
const CELL = 100 / 7;
const cells = (n: number): number => n * CELL;

describe('alignFor', () => {
  it('sets a block on the left edge to the left', () => {
    expect(alignFor(cells(0), cells(2))).toBe('left');
  });

  it('sets a block on the right edge to the right', () => {
    expect(alignFor(cells(5), cells(2))).toBe('right');
  });

  it('centres a block in the middle', () => {
    expect(alignFor(cells(2), cells(3))).toBe('centre');
  });

  it('centres a full-width block', () => {
    // It has no nearer edge, and picking one would throw its text at the other.
    expect(alignFor(0, 100)).toBe('centre');
  });

  it('goes by the centre of the block, not its near edge', () => {
    // A wide block anchored at the left is still mostly on the left; a narrow one at the same
    // anchor is emphatically so. Both should agree, and going by the left edge alone would make
    // every block left-aligned however far it reached.
    expect(alignFor(cells(0), cells(3))).toBe(alignFor(cells(0), cells(1)));
  });

  it('does not flip on a block straddling the middle', () => {
    // The dead zone. Without it a difference of a few pixels between two typesets would swap
    // the alignment, which reads as a fault rather than as an effect.
    for (const width of [cells(1), cells(2), cells(3)]) {
      expect(alignFor(50 - width / 2, width)).toBe('centre');
    }
  });

  it('only ever answers with a real alignment', () => {
    for (let left = 0; left <= 100; left += 2) {
      for (const width of [cells(1), cells(2), cells(4), cells(7)]) {
        if (left + width > 100) continue;
        expect(['left', 'centre', 'right']).toContain(alignFor(left, width));
      }
    }
  });

  it('is symmetrical about the centre', () => {
    // Mirroring a block should mirror its alignment, or one side of the frame behaves
    // differently from the other for no reason anyone could name.
    const mirror = (result: string): string =>
      result === 'left' ? 'right' : result === 'right' ? 'left' : 'centre';

    for (let left = 0; left <= 70; left += 5) {
      const width = cells(2);
      expect(alignFor(100 - left - width, width)).toBe(mirror(alignFor(left, width)));
    }
  });
});
