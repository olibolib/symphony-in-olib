import { describe, expect, it } from 'vitest';
import { parsePreset } from './presetIo';
import { decayProbability } from './Channels';
import { FULL } from './mask';
import type { PresetDoc } from '../ipc/protocol';

/**
 * Loading a preset from disk, and the decay curve. DESIGN.md §11.4 and §11.5.
 *
 * `parsePreset` takes a string and returns a value, which makes it the easiest thing in the
 * codebase to test and the one with the most to lose from being wrong: a preset file can be
 * hand-edited, can be from an older version, and can be half-written if the machine lost power
 * mid-save. Every one of those has to end in something usable rather than a throw mid-set.
 */

const BLANK: PresetDoc = {
  name: 'blank',
  energy: 'any',
  text: {
    slice: 'sentence',
    take: 3,
    length: 'short',
    pick: 'random',
    position: 1,
    splitChars: true,
    blocks: 1,
    size: { min: 30, max: 30 },
  },
  texts: ['default'],
  spawn: FULL,
  blockShapes: [{ cols: { min: 4, max: 4 }, rows: { min: 3, max: 3 } }],
  align: 'centre',
  flow: 'stack',
  avoidOverlap: true,
  offset: { x: 0, y: 0 },
  wholeLines: true,
  layers: [
    {
      treatment: 'invert',
      target: { slice: 'word', proportion: 0.05 },
      triggers: { kick: true },
      decayBars: 0.5,
    },
  ],
};

const parse = (raw: unknown): ReturnType<typeof parsePreset> =>
  parsePreset('under-test', typeof raw === 'string' ? raw : JSON.stringify(raw), BLANK);

describe('parsePreset: surviving bad input', () => {
  it('falls back rather than throwing on unparseable JSON', () => {
    const result = parse('{"name": "half-writ');
    expect(result.doc.name).toBe('under-test');
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it('falls back on a document that is not an object', () => {
    expect(parse('42').doc.name).toBe('under-test');
    expect(parse('null').doc.name).toBe('under-test');
    expect(parse('[]').problems.length).toBeGreaterThan(0);
  });

  it('keeps the file name rather than trusting the one inside', () => {
    // The file is the identity. A name inside that disagrees would give two presets one name.
    expect(parse({ ...BLANK, name: 'something-else' }).doc.name).toBe('under-test');
  });

  it('reports every correction by name', () => {
    const result = parse({ ...BLANK, align: 'sideways', flow: 'spiral' });
    expect(result.problems.join(' ')).toMatch(/align/);
    expect(result.problems.join(' ')).toMatch(/flow/);
  });

  it('keeps as much of a preset as it can understand', () => {
    // One bad field must not cost the other twenty.
    const result = parse({ ...BLANK, align: 'sideways', text: { ...BLANK.text, take: 7 } });
    expect(result.doc.text.take).toBe(7);
  });
});

describe('parsePreset: ranges', () => {
  it('swaps a size range that arrived the wrong way round', () => {
    const result = parse({ ...BLANK, text: { ...BLANK.text, size: { min: 90, max: 20 } } });
    expect(result.doc.text.size.min).toBeLessThanOrEqual(result.doc.text.size.max);
  });

  it('sorts a block shape that arrived the wrong way round', () => {
    const result = parse({
      ...BLANK,
      blockShapes: [{ cols: { min: 6, max: 2 }, rows: { min: 5, max: 1 } }],
    });
    for (const shape of result.doc.blockShapes) {
      expect(shape.cols.min).toBeLessThanOrEqual(shape.cols.max);
      expect(shape.rows.min).toBeLessThanOrEqual(shape.rows.max);
    }
  });

  it('clamps a size far outside anything renderable', () => {
    const result = parse({ ...BLANK, text: { ...BLANK.text, size: { min: -50, max: 5000 } } });
    expect(result.doc.text.size.min).toBeGreaterThan(0);
    expect(result.doc.text.size.max).toBeLessThan(1000);
  });
});

describe('parsePreset: the mask', () => {
  it('squares up a ragged spawn grid', () => {
    const result = parse({ ...BLANK, spawn: ['##', '###########'] });
    expect(result.doc.spawn).toHaveLength(7);
    for (const row of result.doc.spawn) expect(row).toHaveLength(7);
  });

  it('keeps a well-formed one unchanged', () => {
    const spawn = ['#######', '#######', '##...##', '##...##', '##...##', '#######', '#######'];
    expect(parse({ ...BLANK, spawn }).doc.spawn).toEqual(spawn);
  });
});

describe('parsePreset: layers', () => {
  it('drops a layer with an unknown treatment rather than keeping a broken one', () => {
    const result = parse({
      ...BLANK,
      layers: [...BLANK.layers, { treatment: 'sparkle', target: { slice: 'word', count: 1 }, triggers: {}, decayBars: 0 }],
    });
    expect(result.doc.layers).toHaveLength(1);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it('drops an unknown trigger and keeps the layer', () => {
    const result = parse({
      ...BLANK,
      layers: [{ ...BLANK.layers[0], triggers: { kick: true, wobble: true } }],
    });
    expect(result.doc.layers[0]?.triggers).toHaveProperty('kick', true);
    expect(result.doc.layers[0]?.triggers).not.toHaveProperty('wobble');
  });

  it('survives a preset with no layers at all', () => {
    expect(parse({ ...BLANK, layers: [] }).doc.layers).toEqual([]);
  });
});

describe('parsePreset: migration', () => {
  it('carries an old text mode across to slice, take and pick', () => {
    const old = { ...BLANK, text: { ...BLANK.text, mode: 'shortSentences', count: 2 } };
    delete (old.text as Record<string, unknown>)['slice'];
    const result = parse(old);
    expect(result.migrated).toBe(true);
    expect(result.doc.text.slice).toBe('sentence');
    expect(result.doc.text.length).toBe('short');
  });

  it('does not claim to have migrated a current document', () => {
    expect(parse(BLANK).migrated).toBe(false);
  });

  it('round-trips a document it just produced', () => {
    // Whatever comes out must go back in unchanged, or every save quietly rewrites the file.
    const once = parse(BLANK).doc;
    const twice = parse(once).doc;
    expect(twice).toEqual(once);
  });
});

describe('decayProbability', () => {
  const BAR = 2; // seconds, 120bpm

  /**
   * Survivors after `seconds`, stepping at a given frame rate.
   *
   * The step count is worked out up front rather than by accumulating `t += dt`. Adding 1/60
   * a hundred and eighty times does not land on 3, so an accumulating loop runs one extra step
   * at one frame rate and not the other — which shows up as a 1.3% difference that belongs to
   * the harness rather than to the thing being measured.
   */
  function survivors(bars: number, seconds: number, fps: number): number {
    const dt = 1 / fps;
    const steps = Math.round(seconds * fps);
    let alive = 1;
    for (let i = 0; i < steps; i++) alive *= 1 - decayProbability(bars, dt, BAR);
    return alive;
  }

  it('leaves about 5% after the stated number of bars', () => {
    // "Fades over two bars" has to mean what it sounds like.
    expect(survivors(2, 2 * BAR, 60)).toBeCloseTo(0.05, 2);
    expect(survivors(4, 4 * BAR, 60)).toBeCloseTo(0.05, 2);
  });

  it('fades identically at 30fps and 60fps', () => {
    // The bug this replaced: decay ran per frame, so 2.4% survived a second at 60fps against
    // 15.6% at 30 — a six-fold difference in fade speed depending on how busy the machine was.
    expect(survivors(2, 3, 30)).toBeCloseTo(survivors(2, 3, 60), 3);
    expect(survivors(0.5, 1, 24)).toBeCloseTo(survivors(0.5, 1, 144), 3);
  });

  it('holds for ever at zero bars', () => {
    // 0 means "until the text is replaced", not "instantly".
    expect(decayProbability(0, 1 / 60, BAR)).toBe(0);
    expect(decayProbability(-1, 1 / 60, BAR)).toBe(0);
  });

  it('is a probability, whatever it is handed', () => {
    for (const bars of [0.01, 1, 100]) {
      for (const dt of [1 / 240, 1 / 60, 2]) {
        const p = decayProbability(bars, dt, BAR);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });

  it('refuses to divide by a stopped clock', () => {
    expect(decayProbability(2, 1 / 60, 0)).toBe(0);
  });
});
