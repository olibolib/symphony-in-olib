import { describe, expect, it } from 'vitest';
import {
  anchors,
  FULL,
  GRID,
  intersect,
  normalise,
  nudge,
  place,
  placeBlocks,
  toggle,
  type Box,
  type BlockShape,
  type Mask,
} from './mask';

/**
 * The placement grid. DESIGN.md §11.6.
 *
 * These are the rules the comments in `mask.ts` state, written down somewhere a change can
 * disagree with them. Two of them are deliberate reversals of what the code used to do — a
 * mask may now reach empty, and blocks are placed as one arrangement rather than one at a time
 * — and a comment beside the code is not enough to say which behaviour is the current intent.
 */

const overlaps = (a: Box, b: Box): boolean =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height;

const anyOverlap = (boxes: readonly Box[]): boolean =>
  boxes.some((a, i) => boxes.slice(i + 1).some((b) => overlaps(a, b)));

const fixed = (cols: number, rows: number): BlockShape => ({
  cols: { min: cols, max: cols },
  rows: { min: rows, max: rows },
});

/** Collision rate over many typesets, as a percentage. Placement is random, so one run proves nothing. */
function collisionRate(
  shapes: readonly BlockShape[],
  count: number,
  mask: Mask = FULL,
  avoidOverlap = true,
  runs = 2000,
): number {
  const cells = anchors(normalise(mask));
  let bad = 0;
  for (let i = 0; i < runs; i++) {
    if (anyOverlap(placeBlocks(cells, shapes, count, avoidOverlap))) bad++;
  }
  return (bad / runs) * 100;
}

describe('normalise', () => {
  it('accepts a well-formed mask unchanged', () => {
    expect(normalise(FULL)).toEqual(FULL);
  });

  it('squares up a ragged mask rather than throwing mid-set', () => {
    const ragged = normalise(['##', '#######', '']);
    expect(ragged).toHaveLength(GRID);
    for (const row of ragged) expect(row).toHaveLength(GRID);
  });

  it('leaves something allowed when given nothing usable', () => {
    expect(anchors(normalise(undefined)).length).toBeGreaterThan(0);
  });
});

describe('intersect', () => {
  it('can only ever narrow', () => {
    const a: Mask = ['#######', '#######', '##...##', '##...##', '##...##', '#######', '#######'];
    const both = intersect(FULL, a);
    expect(anchors(both).length).toBeLessThanOrEqual(anchors(FULL).length);
    expect(both).toEqual(a);
  });

  it('is empty when the two do not overlap', () => {
    const left = normalise(['#......', '#......', '#......', '#......', '#......', '#......', '#......']);
    const right = normalise(['......#', '......#', '......#', '......#', '......#', '......#', '......#']);
    expect(anchors(intersect(left, right))).toHaveLength(0);
  });
});

describe('toggle', () => {
  it('flips one cell', () => {
    const off = toggle(FULL, 3, 3);
    expect(anchors(off)).toHaveLength(GRID * GRID - 1);
  });

  it('may reach empty', () => {
    // Deliberate reversal: this used to refuse the last cell. Empty is now a reachable state,
    // because the error names which mask is at fault rather than blaming the global one.
    let mask = FULL;
    for (let row = 0; row < GRID; row++) {
      for (let col = 0; col < GRID; col++) mask = toggle(mask, row, col);
    }
    expect(anchors(mask)).toHaveLength(0);
  });
});

describe('place', () => {
  it('never runs a block off the grid', () => {
    for (let row = 0; row < GRID; row++) {
      for (let col = 0; col < GRID; col++) {
        for (let span = 1; span <= GRID; span++) {
          const box = place({ row, col }, span, span);
          expect(box.left).toBeGreaterThanOrEqual(0);
          expect(box.top).toBeGreaterThanOrEqual(0);
          expect(box.left + box.width).toBeLessThanOrEqual(100.001);
          expect(box.top + box.height).toBeLessThanOrEqual(100.001);
        }
      }
    }
  });

  it('clamps an oversized span rather than overflowing', () => {
    const box = place({ row: 0, col: 0 }, 99, 99);
    expect(box.width).toBeCloseTo(100);
    expect(box.height).toBeCloseTo(100);
  });
});

describe('nudge', () => {
  it('cannot push a block off the canvas', () => {
    const box = place({ row: 0, col: 0 }, 2, 2);
    for (const delta of [-500, -1, 0, 1, 500]) {
      const moved = nudge(box, delta, delta);
      expect(moved.left).toBeGreaterThanOrEqual(0);
      expect(moved.top).toBeGreaterThanOrEqual(0);
      expect(moved.left + moved.width).toBeLessThanOrEqual(100.001);
      expect(moved.top + moved.height).toBeLessThanOrEqual(100.001);
    }
  });

  it('moves the box when there is room', () => {
    const box = place({ row: 3, col: 3 }, 1, 1);
    expect(nudge(box, 5, 0).left).toBeCloseTo(box.left + 5);
  });
});

describe('placeBlocks with avoidOverlap', () => {
  // The reported bug: placing blocks one at a time is greedy, so a bad first placement can
  // make a clean arrangement impossible and nothing goes back to move it. Measured at 13.9%,
  // 14.5% and 8.2% respectively before placement became one decision.
  it('finds the side-by-side arrangement for two full-height blocks', () => {
    expect(collisionRate([fixed(3, GRID)], 2)).toBe(0);
  });

  it('finds the stacked arrangement for two full-width blocks', () => {
    expect(collisionRate([fixed(GRID, 3)], 2)).toBe(0);
  });

  it('fits three full-height blocks', () => {
    expect(collisionRate([fixed(2, GRID)], 3)).toBe(0);
  });

  it('resolves inside a narrow mask', () => {
    const ring: Mask = ['#######', '#.....#', '#.....#', '#.....#', '#.....#', '#.....#', '#######'];
    expect(collisionRate([fixed(2, GRID)], 2, ring)).toBe(0);
  });

  it('still places blocks that cannot possibly fit', () => {
    // Overlapping is the correct answer here. A missing block is indistinguishable from text
    // that failed to render (§14).
    expect(collisionRate([fixed(5, 5)], 2)).toBe(100);
  });

  it('leaves placement alone when it is off', () => {
    expect(collisionRate([fixed(3, GRID)], 2, FULL, false)).toBeGreaterThan(5);
  });

  it('stays cheap in the worst case', () => {
    const cells = anchors(FULL);
    const started = performance.now();
    for (let i = 0; i < 200; i++) placeBlocks(cells, [fixed(5, 5)], 3, true);
    expect((performance.now() - started) / 200).toBeLessThan(20);
  });

  it('returns one box per block', () => {
    const cells = anchors(FULL);
    for (const count of [1, 2, 3]) {
      expect(placeBlocks(cells, [fixed(2, 2)], count, true)).toHaveLength(count);
    }
  });
});
