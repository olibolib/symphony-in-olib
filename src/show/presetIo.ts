import type { PresetDoc } from '../ipc/protocol';
import type { LayerSpec } from './Layer';
import type { Target } from './targets';
import { CHANNELS, type Treatment } from './treatments';
import { GRID, normalise, type BlockShape, type Mask } from './mask';
import type { Align, Flow, TextMode } from '../text/Typesetter';

/**
 * Reading a preset off disk. DESIGN.md §11.4.
 *
 * A preset file can be wrong: hand-edited, written by an older build, or copied from someone
 * running a version that spelled a treatment differently. The compiler is no help — the file
 * is `unknown` by the time it reaches us — so this is the second of the two guards §11.4
 * describes, and the one that has to work while the app is running.
 *
 * **Every correction is reported.** A preset that quietly loses a layer because a value was
 * malformed is the worst version of this: the look is wrong, nothing says so, and the cause
 * is a character in a file nobody is looking at (§14). So parsing returns the problems
 * alongside the document, and the caller puts them in the status line.
 *
 * The bias throughout is to **keep as much of the preset as can be understood**. A preset
 * with one bad layer should come back missing that layer, not fail to load.
 */

export interface ParseResult {
  readonly doc: PresetDoc;
  readonly problems: readonly string[];
}

const TREATMENTS = new Set<string>(Object.keys(CHANNELS));
const SLICES = new Set(['char', 'word', 'sentence', 'paragraph', 'block']);
const MODES = new Set<string>([
  'whole', 'sentence', 'sentences', 'shortSentences', 'longSentences', 'word',
]);
const ALIGNS = new Set<string>(['left', 'centre', 'right', 'justify']);
const FLOWS = new Set<string>(['stack', 'run-on', 'grid', 'wrapped', 'columns']);
const ENERGIES = new Set<string>(['sparse', 'mid', 'peak', 'any']);
const TRIGGERS = new Set<string>([
  'typeset', 'kick', 'snare', 'hat', 'beat', 'bar', 'phrase', 'held', 'always',
]);

/**
 * Parse one preset file against a fallback.
 *
 * The fallback is what a field falls back *to*, so re-seeding a built-in that has picked up a
 * bad edit keeps whatever is still valid rather than resetting the whole preset.
 */
export function parsePreset(name: string, raw: string, fallback: PresetDoc): ParseResult {
  const problems: string[] = [];

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Not recoverable field by field — there are no fields. Say so plainly and hand back the
    // fallback, so the preset still exists and can be re-saved over the broken file.
    return { doc: { ...fallback, name }, problems: [`${name}: not valid JSON, using defaults`] };
  }

  const o = isRecord(value) ? value : {};
  if (!isRecord(value)) problems.push(`${name}: not an object, using defaults`);

  const say = (what: string): void => {
    problems.push(`${name}: ${what}`);
  };

  const text = isRecord(o['text']) ? o['text'] : {};
  const size = isRecord(text['size']) ? text['size'] : {};
  const varyBy = text['varyBy'];

  // `continuous` used to be a seventh mode and is now a modifier on all of them (§12.3).
  // A preset saved before that would otherwise fail its mode check and silently revert to
  // random selection — the reading it was written for, quietly gone. Migrated instead, and
  // said out loud so the file gets rewritten with the current shape on the next edit.
  let mode = text['mode'];
  let continuous = bool(text['continuous'], fallback.text.continuous);
  if (mode === 'continuous') {
    mode = 'sentences';
    continuous = true;
    say('mode "continuous" is now a modifier — migrated to sentences, read in order');
  }

  const doc: PresetDoc = {
    name,
    energy: pickFrom(o['energy'], ENERGIES, fallback.energy, 'energy', say) as PresetDoc['energy'],

    text: {
      mode: pickFrom(mode, MODES, fallback.text.mode, 'text.mode', say) as TextMode,
      count: clampNumber(text['count'], 1, 40, fallback.text.count, 'text.count', say),
      continuous,
      splitChars: bool(text['splitChars'], fallback.text.splitChars),
      blocks: clampNumber(text['blocks'], 1, 3, fallback.text.blocks, 'text.blocks', say) as 1 | 2 | 3,
      size: {
        min: clampNumber(size['min'], 8, 200, fallback.text.size.min, 'text.size.min', say),
        max: clampNumber(size['max'], 8, 200, fallback.text.size.max, 'text.size.max', say),
      },
      ...(varyBy === 'word' || varyBy === 'char' ? { varyBy } : {}),
    },

    texts: stringList(o['texts'], fallback.texts),
    spawn: mask(o['spawn'], fallback.spawn, say),
    blockShapes: shapes(o['blockShapes'], fallback.blockShapes, say),
    align: pickFrom(o['align'], ALIGNS, fallback.align, 'align', say) as Align,
    flow: pickFrom(o['flow'], FLOWS, fallback.flow, 'flow', say) as Flow,
    avoidOverlap: bool(o['avoidOverlap'], fallback.avoidOverlap),
    wholeLines: bool(o['wholeLines'], fallback.wholeLines),
    offset: offset(o['offset'], fallback.offset),
    ...motion(o['contentMotion'], CONTENT_DIRECTIONS, 'contentMotion', say),
    ...motion(o['blockMotion'], BLOCK_DIRECTIONS, 'blockMotion', say),
    layers: layers(o['layers'], say),
  };

  // A size range with min above max would silently swap or misbehave downstream; fixing it
  // here keeps every consumer able to assume min <= max.
  if (doc.text.size.min > doc.text.size.max) {
    say('text.size min was above max, swapped');
    return {
      doc: { ...doc, text: { ...doc.text, size: { min: doc.text.size.max, max: doc.text.size.min } } },
      problems,
    };
  }

  return { doc, problems };
}

// --- field readers ---------------------------------------------------------------------------

type Say = (what: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickFrom(value: unknown, allowed: Set<string>, fallback: string, field: string, say: Say): string {
  if (typeof value === 'string' && allowed.has(value)) return value;
  if (value !== undefined) say(`unknown ${field} "${String(value)}", using "${fallback}"`);
  return fallback;
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  field: string,
  say: Say,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    if (value !== undefined) say(`${field} is not a number, using ${fallback}`);
    return fallback;
  }
  if (value < min || value > max) {
    const clamped = Math.min(max, Math.max(min, value));
    say(`${field} ${value} is outside ${min}–${max}, using ${clamped}`);
    return clamped;
  }
  return value;
}

function stringList(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return fallback.slice();
  return value.filter((item): item is string => typeof item === 'string');
}

function mask(value: unknown, fallback: Mask, say: Say): Mask {
  if (!Array.isArray(value)) {
    if (value !== undefined) say('spawn is not a list of rows, using defaults');
    return fallback;
  }
  if (value.length !== GRID) say(`spawn has ${value.length} rows, expected ${GRID} — padded`);
  return normalise(value.filter((row): row is string => typeof row === 'string'));
}

function shapes(value: unknown, fallback: readonly BlockShape[], say: Say): readonly BlockShape[] {
  if (!Array.isArray(value)) {
    if (value !== undefined) say('blockShapes is not a list, using defaults');
    return fallback;
  }

  const out: BlockShape[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const cols = range(item['cols']);
    const rows = range(item['rows']);
    if (cols && rows) out.push({ cols, rows });
  }

  // Placement falls back to a default shape when the list is empty, which would not be the
  // one the editor is showing — the controls would look like they had stopped working.
  if (out.length === 0) {
    say('no usable blockShapes, using defaults');
    return fallback;
  }
  return out;
}

function range(value: unknown): { min: number; max: number } | null {
  if (!isRecord(value)) return null;
  const min = value['min'];
  const max = value['max'];
  if (typeof min !== 'number' || typeof max !== 'number') return null;

  const lo = Math.min(GRID, Math.max(1, Math.round(min)));
  const hi = Math.min(GRID, Math.max(1, Math.round(max)));
  return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
}

/**
 * Layers, dropping any that cannot be understood.
 *
 * A layer with an unknown treatment is named and discarded rather than coerced into a
 * different one: silently turning someone's `flicker` into an `invert` would be a preset that
 * loads without complaint and looks wrong.
 */
function layers(value: unknown, say: Say): readonly LayerSpec[] {
  if (!Array.isArray(value)) {
    if (value !== undefined) say('layers is not a list, using none');
    return [];
  }

  const out: LayerSpec[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      say(`layer ${index + 1} is not an object, dropped`);
      return;
    }

    const treatment = item['treatment'];
    if (typeof treatment !== 'string' || !TREATMENTS.has(treatment)) {
      say(`layer ${index + 1} has unknown treatment "${String(treatment)}", dropped`);
      return;
    }

    const target = parseTarget(item['target']);
    if (!target) {
      say(`layer ${index + 1} has an unreadable target, dropped`);
      return;
    }

    const triggers: LayerSpec['triggers'] = {};
    const raw = item['triggers'];
    if (isRecord(raw)) {
      for (const [key, on] of Object.entries(raw)) {
        if (TRIGGERS.has(key) && on === true) {
          (triggers as Record<string, boolean>)[key] = true;
        }
      }
    }

    const decay = item['decayBars'];
    const rate = item['rateBars'];
    // Not `range` — that clamps to grid cells, and a swell bound is a scale factor.
    const size = scaleRange(item['size']);

    out.push({
      treatment: treatment as Treatment,
      target,
      triggers,
      decayBars: typeof decay === 'number' && decay >= 0 ? decay : 0.5,
      ...(typeof rate === 'number' && rate > 0 ? { rateBars: rate } : {}),
      ...(size ? { size } : {}),
    });
  });

  return out;
}

/**
 * A pixel nudge off the anchor.
 *
 * Clamped to a stage-sized range: a value beyond that could only push a block off the canvas,
 * and placement clamps it back anyway, so accepting it would store a number that does nothing.
 */
function offset(value: unknown, fallback: { x: number; y: number }): { x: number; y: number } {
  if (!isRecord(value)) return fallback;

  const read = (key: string, from: number): number => {
    const raw = value[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return from;
    return Math.min(2000, Math.max(-2000, Math.round(raw)));
  };
  return { x: read('x', fallback.x), y: read('y', fallback.y) };
}

const CONTENT_DIRECTIONS = new Set(['up', 'down']);
const BLOCK_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

/**
 * A motion setting, or nothing.
 *
 * Absent is a valid and common state — most presets are still — so an unreadable one is
 * dropped rather than replaced with a default. Inventing movement nobody asked for is worse
 * than losing a setting that was already malformed.
 */
function motion(
  value: unknown,
  directions: Set<string>,
  field: string,
  say: Say,
): Record<string, { direction: string; speed: number; continuous?: boolean }> {
  if (value === undefined) return {};

  if (!isRecord(value)) {
    say(`${field} is not an object, ignored`);
    return {};
  }

  const direction = value['direction'];
  if (typeof direction !== 'string' || !directions.has(direction)) {
    say(`${field} has unknown direction "${String(direction)}", ignored`);
    return {};
  }

  const speed = value['speed'];
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) {
    say(`${field} has no usable speed, ignored`);
    return {};
  }

  // Faster than four canvases a bar is not a look, it is a strobe of unreadable smear.
  const clamped = Math.min(4, speed);

  // Only the conveyor has a loop/once choice — a travelling block leaves the frame and comes
  // back either way. Defaulting to `true` keeps a file written before the modifier existed
  // behaving as it did.
  if (field !== 'contentMotion') return { [field]: { direction, speed: clamped } };

  return {
    [field]: { direction, speed: clamped, continuous: bool(value['continuous'], true) },
  };
}

/** Scale bounds for `swell`, in multiples of the base size rather than in cells. */
function scaleRange(value: unknown): { min: number; max: number } | null {
  if (!isRecord(value)) return null;
  const min = value['min'];
  const max = value['max'];
  if (typeof min !== 'number' || typeof max !== 'number') return null;

  const lo = Math.min(8, Math.max(0.1, min));
  const hi = Math.min(8, Math.max(0.1, max));
  return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
}

function parseTarget(value: unknown): Target | null {
  if (!isRecord(value)) return null;

  if (typeof value['match'] === 'string') return { match: value['match'] };

  const slice = value['slice'];
  if (typeof slice !== 'string' || !SLICES.has(slice)) return null;
  const s = slice as 'char' | 'word' | 'paragraph' | 'block';

  if (typeof value['proportion'] === 'number') {
    return { slice: s, proportion: Math.min(1, Math.max(0, value['proportion'])) };
  }
  if (typeof value['count'] === 'number') {
    return { slice: s, count: Math.max(1, Math.round(value['count'])) };
  }
  if (typeof value['every'] === 'number') {
    return { slice: s, every: Math.max(1, Math.round(value['every'])) };
  }
  return null;
}
