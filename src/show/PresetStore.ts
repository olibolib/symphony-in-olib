import type { EffectRef } from '../effects/types';
import type { PresetDoc } from '../ipc/protocol';
import { colourShift, retext } from '../effects';
import { FULL } from './mask';
import type { Bindings } from './Conductor';
import { PRESETS, toDoc, type VisualPreset } from './presets';

/**
 * The editable preset bank. DESIGN.md §11.4.
 *
 * Holds a **document** per preset — the data half, which the control window edits — and the
 * **stage effects** that go with it, which are closures and therefore stay here. `resolve`
 * puts the two back together into the `VisualPreset` the engine actually runs.
 *
 * Effects are keyed by name rather than carried on the document, which has one consequence
 * worth stating: renaming a preset has to move its effects too, or the preset would keep its
 * layers and quietly lose its ability to change text. {@link rename} does that.
 *
 * Nothing here persists yet. Edits last for the session; saving to disk is 2d, and the shape
 * above is what makes that a file-writing job rather than a design problem.
 */

interface StageParts {
  readonly bindings: Bindings;
  readonly ambient?: readonly EffectRef[];
  readonly minPhrases?: number;
}

/**
 * What a brand-new preset gets.
 *
 * Not empty: a preset with no bindings never re-typesets, so the text would freeze on
 * whatever was on screen when it went live and never change again. That reads as a crash,
 * not as a blank canvas — so a new preset arrives able to do the one thing every preset must.
 */
const NEW_PRESET_PARTS: StageParts = {
  bindings: {
    phrase: [retext({ hold: [1, 2] }), colourShift({ accents: 2 })],
  },
};

const NEW_PRESET_DOC: Omit<PresetDoc, 'name'> = {
  energy: 'any',
  text: {
    mode: 'shortSentences',
    count: 3,
    splitChars: true,
    blocks: 1,
    size: { min: 28, max: 34 },
  },
  spawn: FULL,
  blockShapes: [{ cols: { min: 3, max: 5 }, rows: { min: 2, max: 3 } }],
  align: 'centre',
  flow: 'stack',
  avoidOverlap: true,
  // One visible layer, so a new preset does something the moment it goes live rather than
  // looking broken until you have added one.
  layers: [
    {
      treatment: 'invert',
      target: { slice: 'word', proportion: 0.05 },
      triggers: { kick: true },
      decayBars: 0.5,
    },
  ],
};

export class PresetStore {
  private docs: PresetDoc[];
  private readonly parts = new Map<string, StageParts>();

  constructor() {
    this.docs = PRESETS.map(toDoc);
    for (const preset of PRESETS) {
      this.parts.set(preset.name, {
        bindings: preset.bindings,
        ...(preset.ambient ? { ambient: preset.ambient } : {}),
        ...(preset.minPhrases !== undefined ? { minPhrases: preset.minPhrases } : {}),
      });
    }
  }

  get all(): readonly PresetDoc[] {
    return this.docs;
  }

  /** Rebuild the runnable presets. Called whenever a document changes. */
  resolve(): readonly VisualPreset[] {
    return this.docs.map((doc) => {
      const parts = this.parts.get(doc.name) ?? NEW_PRESET_PARTS;
      return {
        ...doc,
        bindings: parts.bindings,
        ...(parts.ambient ? { ambient: parts.ambient } : {}),
        ...(parts.minPhrases !== undefined ? { minPhrases: parts.minPhrases } : {}),
      } as VisualPreset;
    });
  }

  find(name: string): PresetDoc | undefined {
    return this.docs.find((doc) => doc.name === name);
  }

  /** Replace a document wholesale. Returns false if the name is unknown. */
  update(doc: PresetDoc): boolean {
    const index = this.docs.findIndex((existing) => existing.name === doc.name);
    if (index === -1) return false;
    this.docs[index] = doc;
    return true;
  }

  /**
   * Add a preset, optionally copying an existing one.
   *
   * A duplicate copies the document but **not** the stage effects, because those are keyed
   * by name — so a copy is given the default set instead. Worth knowing: duplicating `drift`
   * gives you its layers and placement, not its held-text scroll.
   */
  create(from: string | null): PresetDoc {
    const source = from === null ? null : this.find(from);
    const name = this.uniqueName(source ? `${source.name} copy` : 'new preset');

    const doc: PresetDoc = source ? { ...source, name } : { ...NEW_PRESET_DOC, name };
    this.docs.push(doc);
    return doc;
  }

  /**
   * Remove a preset. Refused when it is the last one.
   *
   * `PresetBank` cannot run on an empty bank — and more to the point, a stage with no preset
   * has nothing to show and no way back without a restart.
   */
  remove(name: string): boolean {
    if (this.docs.length <= 1) return false;

    const index = this.docs.findIndex((doc) => doc.name === name);
    if (index === -1) return false;

    this.docs.splice(index, 1);
    this.parts.delete(name);
    return true;
  }

  /** Rename, carrying the stage effects across so the preset keeps working. */
  rename(from: string, to: string): string | null {
    const doc = this.find(from);
    if (!doc || from === to) return null;

    const name = this.uniqueName(to.trim() === '' ? from : to.trim());
    const parts = this.parts.get(from);
    if (parts) {
      this.parts.delete(from);
      this.parts.set(name, parts);
    }

    this.update({ ...doc, name });
    const index = this.docs.findIndex((existing) => existing.name === from);
    if (index !== -1) this.docs[index] = { ...doc, name };
    return name;
  }

  /** Names are the key for stage effects and for the enabled set, so they must be unique. */
  private uniqueName(wanted: string): string {
    if (!this.docs.some((doc) => doc.name === wanted)) return wanted;

    for (let n = 2; ; n++) {
      const candidate = `${wanted} ${n}`;
      if (!this.docs.some((doc) => doc.name === candidate)) return candidate;
    }
  }
}
