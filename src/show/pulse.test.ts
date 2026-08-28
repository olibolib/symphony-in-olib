import { describe, expect, it } from 'vitest';
import { pulseAt, pulseOptions, type PulseSpec } from './wiring';
import { drawsABox, isMotion, isStage, MOTION_TREATMENTS, STAGE_TREATMENTS } from './treatments';
import type { LayerSpec } from './Layer';

/**
 * The stage pulse. DESIGN.md §11.5.
 *
 * It was the last stage effect, and it is a treatment now — so the curve it draws is worth
 * holding down, because it is the one thing in the app that scales the whole frame and a
 * mistake in it moves everything at once.
 */

const pulseLayer = (amount: number, shape: 'decay' | 'sine' = 'decay'): LayerSpec => ({
  treatment: 'pulse',
  target: { slice: 'block', count: 1 },
  triggers: {},
  decayBars: 0,
  pulse: { amount, shape },
});

const other: LayerSpec = {
  treatment: 'invert',
  target: { slice: 'word', proportion: 0.1 },
  triggers: { kick: true },
  decayBars: 0.5,
};

describe('pulseOptions', () => {
  it('finds nothing in a preset without one', () => {
    expect(pulseOptions([other])).toBeNull();
  });

  it('reads the amount and shape', () => {
    expect(pulseOptions([pulseLayer(0.02, 'sine')])).toEqual({
      amount: 0.02,
      shape: 'sine',
      rateBars: 0.25,
    });
  });

  it('lets the last of two win, like channels and motion do', () => {
    expect(pulseOptions([pulseLayer(0.01), pulseLayer(0.03)])?.amount).toBe(0.03);
  });

  it('ignores one with no amount', () => {
    expect(pulseOptions([pulseLayer(0)])).toBeNull();
  });

  it('breathes once a beat unless told otherwise', () => {
    // What it always did, kept as the default so no existing preset changes.
    expect(pulseOptions([pulseLayer(0.02)])?.rateBars).toBe(0.25);
  });

  it('takes a rate in bars, like flicker and decay do', () => {
    const slow: LayerSpec = { ...pulseLayer(0.02, 'sine'), rateBars: 4 };
    expect(pulseOptions([slow])?.rateBars).toBe(4);
  });
});

describe('pulseAt', () => {
  const decay: PulseSpec = { amount: 0.02, shape: 'decay', rateBars: 0.25 };
  const sine: PulseSpec = { amount: 0.02, shape: 'sine', rateBars: 0.25 };

  it('hits hardest on the beat and falls away', () => {
    // Which is what makes `decay` read as a kick.
    expect(pulseAt(decay, 0)).toBeCloseTo(0.02, 5);
    expect(pulseAt(decay, 0.5)).toBeLessThan(pulseAt(decay, 0.25));
    expect(pulseAt(decay, 1)).toBeCloseTo(0, 5);
  });

  it('breathes evenly, peaking between beats', () => {
    // `sine` is the opposite shape: quietest on the beat, fullest halfway through it.
    expect(pulseAt(sine, 0)).toBeCloseTo(0, 5);
    expect(pulseAt(sine, 0.5)).toBeCloseTo(0.02, 5);
    expect(pulseAt(sine, 1)).toBeCloseTo(0, 5);
  });

  it('never exceeds the amount asked for', () => {
    for (const spec of [decay, sine]) {
      for (let phase = 0; phase <= 1; phase += 0.01) {
        const value = pulseAt(spec, phase);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(spec.amount + 1e-9);
      }
    }
  });

  it('snaps up on the beat for decay, which is the hit', () => {
    // The one deliberate discontinuity. `decay` is an attack: it arrives at full amount on the
    // beat and falls away, so the step at the boundary is the thing that reads as a kick.
    expect(pulseAt(decay, 0.999)).toBeLessThan(0.0001);
    expect(pulseAt(decay, 0)).toBeCloseTo(decay.amount, 5);
  });

  it('is continuous across the beat boundary for sine', () => {
    // Read from the predicted grid every frame, so a step here would be a jolt rather than a
    // breath — which is exactly what `sine` exists not to do.
    expect(Math.abs(pulseAt(sine, 0.999) - pulseAt(sine, 0))).toBeLessThan(0.001);
  });

  it('falls smoothly for decay everywhere except the beat', () => {
    let previous = pulseAt(decay, 0);
    for (let phase = 0.01; phase <= 1; phase += 0.01) {
      const value = pulseAt(decay, phase);
      expect(value).toBeLessThanOrEqual(previous + 1e-9);
      previous = value;
    }
  });
});

/**
 * Which treatments are which kind. DESIGN.md §11.5.
 *
 * Three kinds now, and the differences are load-bearing: a motion treatment has no target, a
 * stage treatment has no target and runs every frame, and one treatment draws a box round what
 * it is given rather than marking the type inside it.
 */
describe('treatment kinds', () => {
  it('knows the two that move something', () => {
    expect(MOTION_TREATMENTS).toEqual(['scroll', 'travel']);
    expect(isMotion('scroll')).toBe(true);
    expect(isMotion('invert')).toBe(false);
  });

  it('knows the one that moves the stage', () => {
    expect(STAGE_TREATMENTS).toEqual(['pulse']);
    expect(isStage('pulse')).toBe(true);
    expect(isStage('travel')).toBe(false);
  });

  it('knows the one that draws a box', () => {
    // Outlining "every paragraph" has to mean a box per paragraph. Every other treatment marks
    // the type, and for those a paragraph target means every word in it.
    expect(drawsABox('outline')).toBe(true);
    for (const other of ['invert', 'accent', 'dingbat', 'underline', 'strike', 'swell', 'flicker', 'blank'] as const) {
      expect(drawsABox(other)).toBe(false);
    }
  });
});
