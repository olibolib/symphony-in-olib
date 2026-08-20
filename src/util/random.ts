/**
 * Random helpers.
 *
 * Plain `Math.random`, deliberately. Seeded randomness was considered and dropped
 * (DESIGN.md §17): it makes sense for a fixed composed piece, where a good take is worth
 * being able to reproduce, but this is a live tool and the same preset looking different
 * tonight than last night is a feature rather than a bug.
 */

/** Integer in [0, n). */
export function randomInt(n: number): number {
  return Math.floor(Math.random() * n);
}

/** Integer in [min, max], inclusive. */
export function randomRange(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export function chance(p: number): boolean {
  return Math.random() < p;
}

export function pick<T>(items: readonly T[]): T | undefined {
  return items.length > 0 ? items[randomInt(items.length)] : undefined;
}

/** Up to `count` distinct members, for narrowing a palette (§12.5). */
export function pickSome<T>(items: readonly T[], count: number): T[] {
  const pool = Array.from(items);
  const out: T[] = [];
  while (out.length < count && pool.length > 0) {
    out.push(...pool.splice(randomInt(pool.length), 1));
  }
  return out;
}

/**
 * A value in [min, max] that differs from `current` — Acid's `findNew`.
 *
 * Used everywhere a slot changes: picking the same layout you already had reads as the
 * effect having failed rather than as a deliberate repeat.
 */
export function pickOther(current: number | string | null, min: number, max: number): number {
  const parsed = typeof current === 'number' ? current : Number.parseInt(String(current), 10);
  if (max <= min) return min;

  let result = Number.isNaN(parsed) ? min - 1 : parsed;
  let guard = 0;
  while (result === parsed && guard++ < 32) result = randomRange(min, max);
  return result;
}
