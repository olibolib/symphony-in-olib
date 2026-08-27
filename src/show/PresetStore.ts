import type { EffectRef } from '../effects/types';
import type { PresetDoc } from '../ipc/protocol';
import { retext } from '../effects';
import { FULL } from './mask';
import type { Bindings } from './Conductor';
import { PRESET_VERSION, parsePreset } from './presetIo';
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
 * Documents persist as one JSON file each, beside the texts (§11.3). Built-ins are seeded on
 * first run from the compiled copies, which is what makes "restore defaults" possible without
 * keeping a second copy of everything in the list: the compiled version is always there to
 * seed from again.
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
    phrase: [retext({ hold: [1, 2] })],
  },
};

const NEW_PRESET_DOC: Omit<PresetDoc, 'name'> = {
  version: PRESET_VERSION,
  energy: 'any',
  text: {
    slice: 'sentence',
    take: 3,
    length: 'short',
    pick: 'random',
    position: 1,
    splitChars: true,
    blocks: 1,
    // One size, not a range. The editor opens a range only when you ask for it, and a new
    // preset should start from the simple case.
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
  // One visible layer, so a new preset does something the moment it goes live rather than
  // looking broken until you have added one.
  layers: [
    {
      treatment: 'invert',
      target: { slice: 'word', proportion: 0.05 },
      triggers: { kick: true },
      decayBars: 0.5,
    },
    // Colour, as a layer. A new preset should show that colour works the way everything else
    // does — chosen once when the preset goes live, held until it ends — rather than arriving
    // from somewhere the editor cannot see.
    {
      treatment: 'accent',
      target: { slice: 'word', proportion: 0.2 },
      triggers: { typeset: true },
      decayBars: 0,
    },
  ],
};

export class PresetStore {
  private docs: PresetDoc[];
  private readonly parts = new Map<string, StageParts>();

  /** Names with unsaved changes, and the timer that will flush them. */
  private readonly dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Reported to the control window after a load. Corrections, never silent (§14). */
  problems: readonly string[] = [];

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

  /**
   * Read the folder, seeding it with the built-ins on first run.
   *
   * A preset on disk **replaces** its compiled namesake rather than being added alongside:
   * the built-ins are ordinary presets that happen to ship with the app (§11.4), so an edited
   * `scatter` is still `scatter`. Its stage effects are already registered under that name,
   * which is what lets an edited built-in keep working.
   */
  async load(): Promise<void> {
    const problems: string[] = [];

    let names: readonly string[];
    try {
      names = await window.olib.presets.list();
    } catch {
      // No folder, no permissions, nothing readable. The compiled built-ins are already in
      // place, so the app runs — it simply will not remember edits until this is fixed.
      this.problems = ['Could not read the presets folder — edits will not be saved'];
      return;
    }

    if (names.length === 0) {
      await this.seed();
      return;
    }

    const loaded: PresetDoc[] = [];
    const upgraded: PresetDoc[] = [];
    for (const name of names) {
      try {
        const raw = await window.olib.presets.read(name);
        const fallback = this.find(name) ?? { ...NEW_PRESET_DOC, name };
        const result = parsePreset(name, raw, fallback);
        loaded.push(result.doc);
        problems.push(...result.problems);

        // A format migration is written back at once. It preserves the behaviour exactly, so
        // there is nothing to lose by saving it — and not saving it means the same notice on
        // every launch for the rest of the preset's life.
        if (result.migrated) upgraded.push(result.doc);
      } catch {
        problems.push(`${name}: could not be read, skipped`);
      }
    }

    // Never end up with nothing. An empty bank has no way back without a restart, and the
    // compiled presets are right there.
    if (loaded.length > 0) this.docs = loaded;
    else problems.push('No preset loaded, using the built-ins');

    this.problems = problems;

    await Promise.all(upgraded.map((doc) => this.write(doc)));
  }

  /** Write every compiled preset out, so the folder starts as a full, editable set. */
  private async seed(): Promise<void> {
    this.docs = PRESETS.map(toDoc);
    await Promise.all(this.docs.map((doc) => this.write(doc)));
  }

  /**
   * Put the built-ins back.
   *
   * The safety net that replaces forking (§11.4): because the compiled copies never go away,
   * a preset can be edited directly and still be recoverable. Only touches presets that ship
   * with the app — anything you made yourself is left alone, since "restore defaults" should
   * not be a way to lose your own work.
   */
  async restoreDefaults(): Promise<void> {
    const builtIn = new Set(PRESETS.map((preset) => preset.name));

    this.docs = [
      ...PRESETS.map(toDoc),
      ...this.docs.filter((doc) => !builtIn.has(doc.name)),
    ];

    await Promise.all(PRESETS.map((preset) => this.write(toDoc(preset))));
  }

  /**
   * Mark a preset for saving.
   *
   * Debounced, because an edit arrives on every frame of a slider drag and each one would
   * otherwise be a file write. 600ms after you stop moving is invisible to you and turns a
   * few hundred writes into one.
   */
  private touch(name: string): void {
    this.dirty.add(name);
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), 600);
  }

  /** Write everything outstanding. Safe to call at any time. */
  async flush(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const names = Array.from(this.dirty);
    this.dirty.clear();

    for (const name of names) {
      const doc = this.find(name);
      if (doc) await this.write(doc);
    }
  }

  private async write(doc: PresetDoc): Promise<void> {
    try {
      await window.olib.presets.write(doc.name, `${JSON.stringify(doc, null, 2)}\n`);
    } catch {
      this.problems = [`Could not save "${doc.name}"`];
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
    this.touch(doc.name);
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
    this.touch(name);
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
    this.dirty.delete(name);
    void window.olib.presets.remove(name);
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

    const index = this.docs.findIndex((existing) => existing.name === from);
    if (index !== -1) this.docs[index] = { ...doc, name };

    // The old file is not the new file: a rename has to remove one and write the other, or
    // the folder would accumulate a copy under every name a preset ever had.
    this.dirty.delete(from);
    void window.olib.presets.remove(from);
    this.touch(name);
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
