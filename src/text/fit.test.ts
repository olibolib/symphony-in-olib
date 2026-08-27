import { describe, expect, it } from 'vitest';
import { shiftInto } from './Typesetter';

/**
 * Keeping spilled text on the canvas. DESIGN.md §11.6.
 *
 * The rule is deliberately about a span and a container rather than about `align`, because
 * working out which way text overhangs from its alignment is four rules to keep in step — five
 * with `justify`, which behaves like `left` only for the lines it cannot stretch. One rule
 * applied to the painted rectangle covers all of them.
 */

/** The canvas, in the arbitrary units these are all in. */
const LOW = 0;
const HIGH = 100;

const shift = (start: number, end: number): number => shiftInto(start, end, LOW, HIGH);

/** Where the span ends up once the shift is applied. */
const after = (start: number, end: number): [number, number] => {
  const by = shift(start, end);
  return [start + by, end + by];
};

describe('shiftInto', () => {
  it('leaves something already inside alone', () => {
    expect(shift(10, 90)).toBe(0);
    expect(shift(0, 100)).toBe(0);
  });

  it('brings back something hanging off the end', () => {
    // The reported case: a block anchored near the right edge, spilling past it.
    expect(shift(60, 130)).toBe(-30);
    expect(after(60, 130)).toEqual([30, 100]);
  });

  it('brings back something hanging off the start', () => {
    // Which is what the same block does with `align: right`, spilling the other way.
    expect(shift(-25, 40)).toBe(25);
    expect(after(-25, 40)).toEqual([0, 65]);
  });

  it('moves by the least it can', () => {
    // Flush with the edge it was leaving, never further — the placement you chose still shows
    // through as much as it can.
    expect(after(95, 110)[1]).toBe(HIGH);
    expect(after(-5, 20)[0]).toBe(LOW);
  });

  it('keeps the beginning when the text is wider than the canvas', () => {
    // Nothing can be moved into view that does not fit; bringing one edge in pushes the other
    // out. The opening is the half you cannot do without.
    expect(after(-40, 200)[0]).toBe(LOW);
    expect(after(20, 300)[0]).toBe(LOW);
  });

  it('is the same rule whichever way the text is aligned', () => {
    // `align` decides which of these a block produces; none of them is a separate case here.
    const spans: readonly [number, number][] = [
      [70, 140], // left-aligned in a block near the right edge
      [-40, 30], // right-aligned in a block near the left edge
      [-20, 120], // centred, over-wide, spilling both ways
    ];

    for (const [start, end] of spans) {
      const [a, b] = after(start, end);
      const fits = end - start <= HIGH - LOW;
      expect(a).toBeGreaterThanOrEqual(LOW - 1e-9);
      if (fits) expect(b).toBeLessThanOrEqual(HIGH + 1e-9);
    }
  });

  it('is idempotent', () => {
    // A second pass over an already-fitted span must not move it again, or a re-typeset would
    // walk the block across the frame.
    for (const [start, end] of [[60, 130], [-25, 40], [10, 90]] as const) {
      const [a, b] = after(start, end);
      expect(shift(a, b)).toBe(0);
    }
  });
});
