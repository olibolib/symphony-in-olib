import type { PresetDoc } from '../ipc/protocol';
import type { LayerSpec } from './Layer';
import type { Target } from './targets';
import { CHANNELS, type Treatment } from './treatments';
import { GRID, normalise, type BlockShape, type Mask } from './mask';
import type {
  Align,
  Flow,
  TextLength,
  TextPick,
  TextSlice,
} from '../text/Typesetter';

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

  /**
   * The file was written in an older shape and has been brought forward.
   *
   * Kept apart from `problems` because it is not one. A malformed value is a correction and
   * the file should be left alone — rewriting it would destroy whatever was meant. A format
   * migration preserves the behaviour exactly, so saving it is safe, and saving it is what
   * stops the same notice appearing on every launch for ever.
   */
  readonly migrated: boolean;
}

const TREATMENTS = new Set<string>(Object.keys(CHANNELS));
const SLICES = new Set(['char', 'word', 'sentence', 'paragraph', 'block']);
const SLICES_TEXT = new Set<string>(['word', 'paragraph', 'sentence', 'whole']);
const LENGTHS = new Set<string>(['any', 'short', 'long']);
const PICKS = new Set<string>(['random', 'order', 'position']);

/**
 * What the old `mode` values become.
 *
 * `mode` bundled the slice, the quantity and a length filter into one dropdown, which is why
 * `count` was a live setting in three of its six values and dead in the other three.
 * Splitting them is the point of the new shape; carrying the old files across is the price.
 */
const OLD_MODES: Record<string, { slice: TextSlice; length: TextLength; take?: number }> = {
  whole: { slice: 'whole', length: 'any' },
  // Both of these were hardcoded to one piece, whatever `count` said.
  sentence: { slice: 'sentence', length: 'any', take: 1 },
  word: { slice: 'word', length: 'any', take: 1 },
  sentences: { slice: 'sentence', length: 'any' },
  shortSentences: { slice: 'sentence', length: 'short' },
  longSentences: { slice: 'sentence', length: 'long' },
};
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
/**
 * A step from one document version to the next, applied in order.
 *
 * Each entry rewrites the **raw record**, before any validation runs, so a migrated field is
 * then checked exactly like one that was written in the current format. That matters: the motion
 * migration used to build `LayerSpec` objects and append them past the validator, which is one
 * more thing that could put an unchecked value on the stage.
 *
 * Index `n` takes a version `n` document to version `n + 1`. A file with no `version` at all is
 * version 0 — everything written before this existed.
 */
type Migration = (o: Record<string, unknown>, say: Say, fallback: PresetDoc) => void;

const MIGRATIONS: readonly Migration[] = [toV1, toV2, toV3];

/** What this build writes. Bump it and add a migration in the same commit, never one alone. */
export const PRESET_VERSION = MIGRATIONS.length;

/**
 * Version 0 to 1: text selection became slice/take/pick, and motion became a layer.
 *
 * Both were previously detected by sniffing for a field — `text.mode` for one, `contentMotion`
 * for the other. Sniffing works for one migration and stops working the moment two have to be
 * applied in order, or one has to be told apart from a field simply being absent. Version 1
 * exists so the second one does not have to invent a third sniff.
 */
function toV1(o: Record<string, unknown>, say: Say): void {
  const text = isRecord(o['text']) ? o['text'] : null;

  // `text.mode` bundled the slice, the quantity and a length filter into one dropdown.
  if (text) {
    const oldMode = text['mode'];
    if (typeof oldMode === 'string' && text['slice'] === undefined) {
      // `continuous` was itself a mode before it was a modifier, so an even older file can
      // arrive with it here.
      const reading = oldMode === 'continuous';
      const mapped = OLD_MODES[reading ? 'sentences' : oldMode];

      if (mapped) {
        text['slice'] = mapped.slice;
        text['length'] = mapped.length;
        text['take'] = mapped.take ?? text['count'];
        text['pick'] = reading || bool(text['continuous'], false) ? 'order' : 'random';
        say(`text selection is now slice, take and pick — migrated from "${oldMode}"`);
      }
    }
  }

  // Motion was a pair of fields on the document and is now a layer like anything else (§11.5).
  // A preset saved before that would otherwise stop moving with no explanation.
  const migratedLayers = [
    ...motionLayer(o['contentMotion'], 'scroll', CONTENT_DIRECTIONS, say),
    ...motionLayer(o['blockMotion'], 'travel', BLOCK_DIRECTIONS, say),
  ];

  if (migratedLayers.length > 0) {
    const existing = Array.isArray(o['layers']) ? o['layers'] : [];
    o['layers'] = [...existing, ...migratedLayers];
  }

  delete o['contentMotion'];
  delete o['blockMotion'];
}

/**
 * Version 1 to 2: the stage pulse became a layer.
 *
 * It was the last stage effect — a closure held engine-side in a map keyed by preset name, so
 * it never appeared in the file at all. That is why this migration needs the fallback: the
 * value being carried across was never in the document to read.
 *
 * Only a preset whose compiled namesake had one gets it, which is the same rule the map
 * followed. A preset you made yourself never had a pulse and does not acquire one here.
 */
function toV2(o: Record<string, unknown>, say: Say, fallback: PresetDoc): void {
  const layers = Array.isArray(o['layers']) ? o['layers'] : [];
  if (layers.some((l) => isRecord(l) && l['treatment'] === 'pulse')) return;

  const inherited = fallback.layers.find((l) => l.treatment === 'pulse');
  if (!inherited) return;

  o['layers'] = [...layers, { ...inherited }];
  say('the stage pulse is a layer now — carried across');
}

/**
 * Version 2 to 3: text hold and `minPhrases` became fields.
 *
 * `retext({ hold: [1, 2] })` was a closure bound to the phrase trigger and identical in every
 * preset — not because that suits all of them, but because it was written in TypeScript where
 * nobody could reach it. `minPhrases` was in the same record for the same reason.
 *
 * Both come off the fallback, like the pulse did, because neither was ever in the document.
 */
function toV3(o: Record<string, unknown>, say: Say, fallback: PresetDoc): void {
  const text = isRecord(o['text']) ? o['text'] : null;
  let carried = false;

  if (text && text['hold'] === undefined) {
    text['hold'] = { ...fallback.text.hold };
    carried = true;
  }

  if (o['minPhrases'] === undefined) {
    o['minPhrases'] = fallback.minPhrases;
    carried = true;
  }

  if (carried) say('how long text holds is a setting now — carried across');
}

export function parsePreset(name: string, raw: string, fallback: PresetDoc): ParseResult {
  const problems: string[] = [];
  let migrated = false;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // Not recoverable field by field — there are no fields. Say so plainly and hand back the
    // fallback, so the preset still exists and can be re-saved over the broken file.
    return {
      doc: { ...fallback, name },
      problems: [`${name}: not valid JSON, using defaults`],
      migrated: false,
    };
  }

  const o = isRecord(value) ? value : {};
  if (!isRecord(value)) problems.push(`${name}: not an object, using defaults`);

  const say = (what: string): void => {
    problems.push(`${name}: ${what}`);
  };

  // Bring the document up to date before anything is read from it, so every field the
  // validator sees is in the current shape whatever version it arrived in.
  const from =
    typeof o['version'] === 'number' && Number.isFinite(o['version'])
      ? Math.max(0, Math.floor(o['version']))
      : 0;

  for (let v = Math.min(from, MIGRATIONS.length); v < MIGRATIONS.length; v++) {
    MIGRATIONS[v]?.(o, say, fallback);
  }

  // Stamped rather than reported. A file from before versions existed is upgraded silently;
  // only a step that actually rewrote something says so, above.
  migrated = from !== PRESET_VERSION;

  const text = isRecord(o['text']) ? o['text'] : {};
  const size = isRecord(text['size']) ? text['size'] : {};
  const varyBy = text['varyBy'];

  const doc: PresetDoc = {
    name,
    version: PRESET_VERSION,
    energy: pickFrom(o['energy'], ENERGIES, fallback.energy, 'energy', say) as PresetDoc['energy'],

    text: {
      slice: pickFrom(text['slice'], SLICES_TEXT, fallback.text.slice, 'text.slice', say) as TextSlice,
      take: clampNumber(text['take'], 1, 40, fallback.text.take, 'text.take', say),
      length: pickFrom(text['length'], LENGTHS, fallback.text.length, 'text.length', say) as TextLength,
      pick: pickFrom(text['pick'], PICKS, fallback.text.pick, 'text.pick', say) as TextPick,
      position: clampNumber(text['position'], 1, 999, fallback.text.position, 'text.position', say),
      hold: holdRange(text['hold'], fallback.text.hold, say),
      splitChars: bool(text['splitChars'], fallback.text.splitChars),
      blocks: clampNumber(text['blocks'], 1, 3, fallback.text.blocks, 'text.blocks', say) as 1 | 2 | 3,
      size: {
        min: clampNumber(size['min'], 8, 200, fallback.text.size.min, 'text.size.min', say),
        max: clampNumber(size['max'], 8, 200, fallback.text.size.max, 'text.size.max', say),
      },
      ...(varyBy === 'word' || varyBy === 'char' ? { varyBy } : {}),
    },

    texts: stringList(o['texts'], fallback.texts),
    minPhrases: clampNumber(o['minPhrases'], 0, 64, fallback.minPhrases, 'minPhrases', say),
    spawn: mask(o['spawn'], fallback.spawn, say),
    blockShapes: shapes(o['blockShapes'], fallback.blockShapes, say),
    align: pickFrom(o['align'], ALIGNS, fallback.align, 'align', say) as Align,
    flow: pickFrom(o['flow'], FLOWS, fallback.flow, 'flow', say) as Flow,
    avoidOverlap: bool(o['avoidOverlap'], fallback.avoidOverlap),
    wholeLines: bool(o['wholeLines'], fallback.wholeLines),
    offset: offset(o['offset'], fallback.offset),
    // Migrated layers are in here too, because a migration rewrites the raw record before
    // this runs — so they are validated like any other layer rather than appended past it.
    layers: layers(o['layers'], say),
  };

  // A size range with min above max would silently swap or misbehave downstream; fixing it
  // here keeps every consumer able to assume min <= max.
  if (doc.text.size.min > doc.text.size.max) {
    say('text.size min was above max, swapped');
    return {
      doc: { ...doc, text: { ...doc.text, size: { min: doc.text.size.max, max: doc.text.size.min } } },
      problems,
      migrated,
    };
  }

  return { doc, problems, migrated };
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
    const motion = readMotion(
      item['motion'],
      treatment === 'scroll' ? CONTENT_DIRECTIONS : BLOCK_DIRECTIONS,
    );
    // Not `range` — that clamps to grid cells, and a swell bound is a scale factor.
    const size = scaleRange(item['size']);
    const stagePulse = pulseSpec(item['pulse']);

    if ((treatment === 'scroll' || treatment === 'travel') && !motion) {
      say(`layer ${index + 1} is a ${treatment} with no direction or speed, dropped`);
      return;
    }

    if (treatment === 'pulse' && !stagePulse) {
      say(`layer ${index + 1} is a pulse with no amount, dropped`);
      return;
    }

    out.push({
      treatment: treatment as Treatment,
      target,
      triggers,
      decayBars: typeof decay === 'number' && decay >= 0 ? decay : 0.5,
      ...(typeof rate === 'number' && rate > 0 ? { rateBars: rate } : {}),
      ...(motion ? { motion } : {}),
      ...(size ? { size } : {}),
      ...(stagePulse ? { pulse: stagePulse } : {}),
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
function readMotion(value: unknown, directions: Set<string>): LayerSpec['motion'] | null {
  if (!isRecord(value)) return null;

  const direction = value['direction'];
  if (typeof direction !== 'string' || !directions.has(direction)) return null;

  const speed = value['speed'];
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) return null;

  return {
    direction: direction as 'up' | 'down' | 'left' | 'right',
    // Faster than four canvases a bar is not a look, it is a strobe of unreadable smear.
    speed: Math.min(4, speed),
    // `scroll` keeps one flag; `travel` has one per axis. A file written when both shared a
    // single `continuous` seeds both axes from it, so nothing changes behaviour on upgrade.
    continuous: bool(value['continuous'], true),
    wrapSide: bool(value['wrapSide'], bool(value['continuous'], true)),
    wrapTop: bool(value['wrapTop'], bool(value['continuous'], true)),
  };
}

/** Turn a document-level motion setting into the layer it is now. */
/**
 * A document-level motion setting, as the layer it would be written as today.
 *
 * Returned as a plain record rather than a `LayerSpec`, because it is going back into the raw
 * document to be validated with everything else.
 */
function motionLayer(
  value: unknown,
  treatment: 'scroll' | 'travel',
  directions: Set<string>,
  say: Say,
): Record<string, unknown>[] {
  if (value === undefined) return [];

  const motion = readMotion(value, directions);
  if (!motion) {
    say(`${treatment} motion could not be read, dropped`);
    return [];
  }

  say(`motion is a layer now — migrated to a "${treatment}" layer`);
  return [
    {
      treatment,
      target: { slice: 'block', count: 1 },
      triggers: {},
      decayBars: 0,
      motion,
    },
  ];
}

/**
 * How many phrases a passage holds, in whole phrases.
 *
 * A hold of zero would replace the text every phrase and then some, so the floor is one — and
 * the ceiling is high enough for a preset that wants a passage to stay for a couple of minutes.
 */
function holdRange(
  value: unknown,
  fallbackHold: { readonly min: number; readonly max: number },
  say: Say,
): { min: number; max: number } {
  if (!isRecord(value)) return { ...fallbackHold };

  const lo = clampNumber(value['min'], 1, 64, fallbackHold.min, 'text.hold.min', say);
  const hi = clampNumber(value['max'], 1, 64, fallbackHold.max, 'text.hold.max', say);
  return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
}

/** How hard the stage breathes, for a `pulse` layer. */
function pulseSpec(value: unknown): { amount: number; shape: 'decay' | 'sine' } | null {
  if (!isRecord(value)) return null;
  const amount = value['amount'];
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;

  // Capped well below the point where it stops reading as a pulse and starts reading as a
  // fault, which is around 0.05 at 720p.
  return {
    amount: Math.min(0.2, Math.max(0, amount)),
    shape: value['shape'] === 'sine' ? 'sine' : 'decay',
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
