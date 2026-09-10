import { describe, expect, it } from 'vitest';
import { PresetBank } from './PresetBank';
import { memorySettings } from '../util/settings';
import type { VisualPreset } from './presets';

/**
 * Cycle policy. DESIGN.md §11.2.
 *
 * Which preset is on stage, when it may change, and what it changes to. Pure decision logic
 * that was reachable only through a browser until its `localStorage` reads became a port.
 */

const preset = (name: string, over: Partial<VisualPreset> = {}): VisualPreset =>
  ({
    name,
    energy: 'any',
    text: { slice: 'sentence', take: 2, length: 'any', pick: 'random', position: 1, splitChars: false, blocks: 1, size: { min: 28, max: 28 } },
    texts: ['default'],
    spawn: [],
    blockShapes: [],
    align: 'centre',
    flow: 'stack',
    avoidOverlap: true,
    offset: { x: 0, y: 0 },
    wholeLines: true,
    layers: [],
    bindings: {},
    ...over,
  }) as unknown as VisualPreset;

const THREE = [preset('still'), preset('scatter'), preset('swarm')];

const bankOf = (
  presets: readonly VisualPreset[] = THREE,
  stored: Record<string, string> = {},
): PresetBank => new PresetBank(presets, memorySettings(stored));

/**
 * Play some bars, and report every change the timer made.
 *
 * All of them, not the last one: the window is randomised and short enough that a long run
 * fires several times, so a run of 200 bars can perfectly well end back where it started.
 */
function runBars(bank: PresetBank, bars: number): VisualPreset[] {
  const changes: VisualPreset[] = [];
  for (let i = 0; i < bars; i++) {
    bank.countBar();
    if (i % 4 === 3) {
      bank.countPhrase();
      const next = bank.takeNext();
      if (next) changes.push(next);
    }
  }
  return changes;
}

describe('what is live', () => {
  it('starts at the head of the list', () => {
    expect(bankOf().current.name).toBe('still');
  });

  it('refuses to exist with nothing to play', () => {
    expect(() => bankOf([])).toThrow();
  });

  it('comes back on the preset that was live', () => {
    // A restart should feel continuous — the show resumes where it was rather than at the top.
    expect(bankOf(THREE, { 'olib.livePreset': 'swarm' }).current.name).toBe('swarm');
  });

  it('falls back to the head when the remembered preset has been deleted', () => {
    expect(bankOf(THREE, { 'olib.livePreset': 'gone' }).current.name).toBe('still');
  });
});

describe('queueing', () => {
  it('holds a choice until a phrase boundary', () => {
    const bank = bankOf();
    bank.queue('swarm');
    expect(bank.current.name).toBe('still');
    expect(bank.pending).toBe('swarm');

    bank.countPhrase();
    expect(bank.takeNext()?.name).toBe('swarm');
  });

  it('beats the timer', () => {
    // If you picked something, the machine does not talk over you.
    const bank = bankOf();
    runBars(bank, 60);

    // Whatever the timer landed on, ask for something else — queueing the live preset is the
    // cancel gesture, not a change.
    const wanted = THREE.map((p) => p.name).find((name) => name !== bank.current.name) ?? '';
    bank.queue(wanted);
    bank.countPhrase();
    expect(bank.takeNext()?.name).toBe(wanted);
  });

  it('treats clicking the live preset as cancelling', () => {
    // The natural "actually, stay put" gesture, rather than queueing a no-op.
    const bank = bankOf();
    bank.queue('swarm');
    bank.queue('still');
    expect(bank.pending).toBeNull();
  });

  it('ignores a queued preset that no longer exists', () => {
    const bank = bankOf();
    bank.queue('gone');
    bank.countPhrase();
    expect(bank.takeNext()).toBeNull();
    expect(bank.current.name).toBe('still');
  });
});

describe('the timer', () => {
  it('stays put until it is due', () => {
    const bank = bankOf();
    bank.countPhrase();
    expect(bank.takeNext()).toBeNull();
  });

  it('changes eventually, and to something else', () => {
    const bank = bankOf();
    const changes = runBars(bank, 200);
    expect(changes.length).toBeGreaterThan(0);
    // The first change specifically. Later ones may well come back round to where it started.
    expect(changes[0]?.name).not.toBe('still');
  });

  it('honours minPhrases so a sparse preset gets room to breathe', () => {
    const patient = [preset('still', { minPhrases: 8 } as Partial<VisualPreset>), preset('scatter')];
    const bank = bankOf(patient);

    // Well past the bar timer, but not past the phrase floor.
    for (let i = 0; i < 200; i++) bank.countBar();
    for (let i = 0; i < 4; i++) bank.countPhrase();
    expect(bank.takeNext()).toBeNull();

    for (let i = 0; i < 6; i++) bank.countPhrase();
    expect(bank.takeNext()).not.toBeNull();
  });

  it('has nowhere to go when everything else is disabled', () => {
    // Not an error: the timer comes due, finds nothing else enabled, and stays put.
    const bank = bankOf();
    bank.setEnabled('scatter', false);
    bank.setEnabled('swarm', false);

    expect(runBars(bank, 400)).toEqual([]);
    expect(bank.current.name).toBe('still');
  });

  it('only ever changes to something enabled', () => {
    const bank = bankOf();
    bank.setEnabled('swarm', false);

    for (const change of runBars(bank, 2000)) {
      expect(change.name).not.toBe('swarm');
    }
  });
});

describe('enabling', () => {
  it('refuses to disable the last one standing', () => {
    // A silent bank is much worse than one preset you have to switch off again.
    const bank = bankOf();
    expect(bank.setEnabled('scatter', false)).toBe(true);
    expect(bank.setEnabled('swarm', false)).toBe(true);
    expect(bank.setEnabled('still', false)).toBe(false);
    expect(bank.isEnabled('still')).toBe(true);
  });

  it('lets one be switched back on', () => {
    const bank = bankOf();
    bank.setEnabled('swarm', false);
    expect(bank.isEnabled('swarm')).toBe(false);
    bank.setEnabled('swarm', true);
    expect(bank.isEnabled('swarm')).toBe(true);
  });
});

describe('persistence', () => {
  it('remembers exclusions across a restart', () => {
    // Written on every change rather than on close: a VJ tool gets killed, not quit.
    const settings = memorySettings();
    const first = new PresetBank(THREE, settings);
    first.setEnabled('swarm', false);

    expect(new PresetBank(THREE, settings).isEnabled('swarm')).toBe(false);
  });

  it('migrates a previous session that stored an enabled list', () => {
    const settings = memorySettings({ 'olib.enabledPresets': JSON.stringify(['still', 'scatter']) });
    const bank = new PresetBank(THREE, settings);

    expect(bank.isEnabled('still')).toBe(true);
    expect(bank.isEnabled('swarm')).toBe(false);
    expect(settings.get('olib.enabledPresets')).toBeNull();
  });

  it('plays everything when the stored value is corrupt', () => {
    // The safe direction to fail in.
    const bank = bankOf(THREE, { 'olib.disabledPresets': 'not json' });
    for (const p of THREE) expect(bank.isEnabled(p.name)).toBe(true);
  });
});
