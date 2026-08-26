import { describe, expect, it } from 'vitest';
import { blockedMessage, motionOptions, needsRetypeset, textsForBlocks } from './wiring';
import { FULL, type Mask } from './mask';
import type { LayerSpec } from './Layer';
import type { PresetDoc } from '../ipc/protocol';
import type { TextPreset } from '../text/TextSource';

/**
 * The engine's decisions, pinned before the engine moves.
 *
 * These four came out of `main.ts` unchanged. They are here so the extraction can be checked
 * rather than trusted, and so the `Engine` class that replaces the module-scope script has
 * something to disagree with if it gets any of them wrong on the way.
 */

const DOC: PresetDoc = {
  name: 'under-test',
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

type Motion = NonNullable<LayerSpec['motion']>;

const motionLayer = (treatment: 'scroll' | 'travel', motion: Motion): LayerSpec => ({
  treatment,
  target: { slice: 'block', count: 1 },
  triggers: {},
  decayBars: 0,
  motion,
});

const scroll = (over: Partial<Motion> = {}): LayerSpec =>
  motionLayer('scroll', { direction: 'up', speed: 0.2, ...over });

const travel = (over: Partial<Motion> = {}): LayerSpec =>
  motionLayer('travel', { direction: 'right', speed: 0.3, ...over });

describe('motionOptions', () => {
  it('finds nothing in a preset with no motion', () => {
    expect(motionOptions(DOC.layers)).toEqual({});
  });

  it('reads a scroll layer as content motion', () => {
    expect(motionOptions([scroll()]).contentMotion).toEqual({
      direction: 'up',
      speed: 0.2,
      continuous: true,
    });
  });

  it('reads a travel layer as block motion', () => {
    expect(motionOptions([travel()]).blockMotion?.direction).toBe('right');
  });

  it('carries both at once', () => {
    const both = motionOptions([scroll(), travel()]);
    expect(both.contentMotion).toBeDefined();
    expect(both.blockMotion).toBeDefined();
  });

  it('lets the last of two win, like channels do', () => {
    const out = motionOptions([scroll({ direction: 'up' }), scroll({ direction: 'down' })]);
    expect(out.contentMotion?.direction).toBe('down');
  });

  it('ignores a layer with no speed', () => {
    expect(motionOptions([scroll({ speed: 0 })]).contentMotion).toBeUndefined();
  });

  it('defaults both wraps to on', () => {
    expect(motionOptions([scroll()]).contentMotion?.continuous).toBe(true);
    expect(motionOptions([travel()]).blockMotion?.continuous).toBe(true);
  });

  it('consults only the wrap for the axis being travelled', () => {
    // The other toggle is there for when the direction changes, and must not be read now —
    // these two used to interact, which showed up as a jump at the top right corner.
    const sideways = motionOptions([travel({ direction: 'right', wrapSide: false, wrapTop: true })]);
    expect(sideways.blockMotion?.continuous).toBe(false);

    const vertical = motionOptions([travel({ direction: 'up', wrapSide: false, wrapTop: true })]);
    expect(vertical.blockMotion?.continuous).toBe(true);
  });

  it('refuses a sideways scroll', () => {
    // Text scrolling sideways through its own box reads as a fault, so `scroll` is up or down.
    expect(motionOptions([scroll({ direction: 'left' })]).contentMotion).toBeUndefined();
  });
});

describe('needsRetypeset', () => {
  it('says no when nothing changed', () => {
    expect(needsRetypeset(DOC, { ...DOC })).toBe(false);
  });

  it('says no to a layer edit', () => {
    // This is the one that matters. A layer change is pushed into the running stack in place;
    // re-typesetting on it would strobe the stage while a slider is being dragged.
    const edited: PresetDoc = {
      ...DOC,
      layers: [{ ...DOC.layers[0]!, decayBars: 3 }],
    };
    expect(needsRetypeset(DOC, edited)).toBe(false);
  });

  it('says no to a rename or an energy tag', () => {
    expect(needsRetypeset(DOC, { ...DOC, name: 'other' })).toBe(false);
    expect(needsRetypeset(DOC, { ...DOC, energy: 'peak' })).toBe(false);
  });

  for (const [what, after] of [
    ['text selection', { ...DOC, text: { ...DOC.text, take: 5 } }],
    ['type size', { ...DOC, text: { ...DOC.text, size: { min: 40, max: 40 } } }],
    ['the spawn mask', { ...DOC, spawn: ['#######', '.......', '.......', '.......', '.......', '.......', '.......'] }],
    ['block shapes', { ...DOC, blockShapes: [{ cols: { min: 2, max: 2 }, rows: { min: 2, max: 2 } }] }],
    ['align', { ...DOC, align: 'left' }],
    ['flow', { ...DOC, flow: 'columns' }],
    ['avoidOverlap', { ...DOC, avoidOverlap: false }],
  ] as const) {
    it(`says yes to ${what}`, () => {
      expect(needsRetypeset(DOC, after as PresetDoc)).toBe(true);
    });
  }
});

describe('blockedMessage', () => {
  const EMPTY: Mask = ['.......', '.......', '.......', '.......', '.......', '.......', '.......'];
  const LEFT: Mask = ['#......', '#......', '#......', '#......', '#......', '#......', '#......'];
  const RIGHT: Mask = ['......#', '......#', '......#', '......#', '......#', '......#', '......#'];

  it('says nothing when there is somewhere to go', () => {
    expect(blockedMessage('scatter', FULL, FULL)).toBeNull();
    expect(blockedMessage('scatter', LEFT, FULL)).toBeNull();
  });

  it('blames the global mask when it is the empty one', () => {
    const message = blockedMessage('scatter', FULL, EMPTY);
    expect(message).toMatch(/global mask/);
    expect(message).toMatch(/Canvas tab/);
  });

  it('blames the preset when its own grid is empty', () => {
    const message = blockedMessage('scatter', EMPTY, FULL);
    expect(message).toMatch(/scatter/);
    expect(message).toMatch(/Presets tab/);
    expect(message).not.toMatch(/global/);
  });

  it('blames the global mask when the two do not overlap', () => {
    // The global mask is absolute (§11.6): a preset works in the overlap or not at all.
    const message = blockedMessage('scatter', LEFT, RIGHT);
    expect(message).toMatch(/global mask is blocking/);
    expect(message).toMatch(/scatter/);
  });
});

describe('textsForBlocks', () => {
  const text = (name: string): TextPreset => ({ name, lines: [[name]], sentences: [[[name]]] });
  const active = text('active');
  const bank = new Map([
    ['prologue', text('prologue')],
    ['manifesto', text('manifesto')],
  ]);

  it('gives every block a text', () => {
    for (const blocks of [1, 2, 3]) {
      expect(textsForBlocks(['prologue'], blocks, active, bank)).toHaveLength(blocks);
    }
  });

  it('follows the menu when a preset pins nothing', () => {
    expect(textsForBlocks([], 1, active, bank)[0]).toBe(active);
  });

  it('treats "default" as the menu rather than as a filename', () => {
    // It keeps following the menu as it changes mid-set, which is the whole point (§11.7).
    expect(textsForBlocks(['default'], 1, active, bank)[0]).toBe(active);
  });

  it('uses a pinned text by name', () => {
    expect(textsForBlocks(['prologue'], 1, active, bank)[0]?.name).toBe('prologue');
  });

  it('falls back to the menu for a text that has been deleted', () => {
    // A blank block is indistinguishable from a render failure (§14).
    expect(textsForBlocks(['gone'], 1, active, bank)[0]).toBe(active);
  });

  it('draws from every pinned text across blocks', () => {
    const names = ['prologue', 'manifesto'];
    const picked = textsForBlocks(names, 2, active, bank, (n) => (n === 2 ? 1 : 0));
    expect(picked.map((t) => t.name)).toEqual(['manifesto', 'manifesto']);
  });
});
