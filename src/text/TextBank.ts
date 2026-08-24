import { parseText, type TextPreset } from './TextSource';

/**
 * The available texts, their editor drafts, and which one is live.
 *
 * Text used to be bundled at build time, which meant changing a line required a rebuild.
 * It now lives in files the app can write, so it can be edited during a set.
 *
 * Changes are **queued**, not immediate — exactly like preset changes (§11.2). Text
 * swapping mid-phrase reads as a fault rather than as a decision, and routing every change
 * through the same phrase boundary keeps that true whether it came from you pressing Apply
 * or from the machine cycling on its own.
 */

const ACTIVE_KEY = 'olib.activeText';

export class TextBank {
  /** Content as saved on disk. */
  private readonly saved = new Map<string, string>();

  /** Editor buffers. Kept per file so switching tabs does not lose unsaved work. */
  private readonly drafts = new Map<string, string>();

  /**
   * One level of undo per file: the content that was live before the last Apply.
   *
   * Deliberately one deep. This is for un-doing a mistake you just made, not a history —
   * and Revert only refills the editor, so it still has to be applied like any other change.
   */
  private readonly previous = new Map<string, string>();

  private names: string[] = [];
  private activeName = '';
  private activePreset: TextPreset = parseText('empty', '');

  private pending: string | null = null;

  /**
   * Load the folder, seeding it on first run.
   *
   * The seed text is bundled with the renderer, so it is handed to the main process rather
   * than read from disk — the packaged app does not ship the source `presets/` folder.
   */
  async load(seedName: string, seedContent: string): Promise<void> {
    let names = await window.olib.texts.list();

    if (names.length === 0) {
      await window.olib.texts.write(seedName, seedContent);
      names = await window.olib.texts.list();
    }

    this.names = names;
    for (const name of names) {
      this.saved.set(name, await window.olib.texts.read(name));
    }

    const remembered = localStorage.getItem(ACTIVE_KEY);
    const initial = remembered !== null && names.includes(remembered) ? remembered : names[0];
    if (initial !== undefined) this.activate(initial);
  }

  get list(): readonly string[] {
    return this.names;
  }

  get active(): TextPreset {
    return this.activePreset;
  }

  get liveName(): string {
    return this.activeName;
  }

  /** The name waiting to go live at the next phrase, if any. */
  get pendingName(): string | null {
    return this.pending;
  }

  /** Editor content for a file: the draft if edited, otherwise what is on disk. */
  draft(name: string): string {
    return this.drafts.get(name) ?? this.saved.get(name) ?? '';
  }

  setDraft(name: string, content: string): void {
    this.drafts.set(name, content);
  }

  isEdited(name: string): boolean {
    const draft = this.drafts.get(name);
    return draft !== undefined && draft !== this.saved.get(name);
  }

  canRevert(name: string): boolean {
    return this.previous.has(name);
  }

  /**
   * Put the previously applied content back in the editor.
   *
   * Does **not** apply it. That is the point: an undo you still have to confirm cannot
   * itself become a mistake, and it goes through the same phrase boundary as everything
   * else.
   */
  revert(name: string): string | null {
    const older = this.previous.get(name);
    if (older === undefined) return null;
    this.drafts.set(name, older);
    return older;
  }

  /**
   * Save the draft and queue this text to go live at the next phrase.
   *
   * Applies even when the file is already live: you have edited it, so the stage needs to
   * re-typeset from the new content.
   */
  async apply(name: string): Promise<void> {
    const content = this.draft(name);
    const wasLive = this.saved.get(name);

    if (wasLive !== undefined && wasLive !== content) {
      this.previous.set(name, wasLive);
    }

    await window.olib.texts.write(name, content);
    this.saved.set(name, content);
    this.drafts.delete(name);
    this.pending = name;
  }

  /**
   * Create a new, empty text. Returns false if the name is unusable or already taken.
   */
  async create(rawName: string): Promise<boolean> {
    const name = rawName.replace(/[^A-Za-z0-9 _-]/g, '').trim();
    if (name.length === 0 || this.names.includes(name)) return false;

    await window.olib.texts.write(name, '');
    this.saved.set(name, '');
    this.names = [...this.names, name].sort();
    return true;
  }

  /**
   * Delete a text. Returns the name that should be selected afterwards, or null if the
   * deletion was refused.
   *
   * **The last text cannot be deleted.** An empty folder would leave the stage with nothing
   * to typeset and no way back through the UI, which is a worse outcome than refusing.
   */
  async remove(name: string): Promise<string | null> {
    if (this.names.length <= 1 || !this.names.includes(name)) return null;

    await window.olib.texts.remove(name);
    this.names = this.names.filter((n) => n !== name);
    this.saved.delete(name);
    this.drafts.delete(name);
    this.previous.delete(name);

    if (this.pending === name) this.pending = null;

    const next = this.names[0] as string;

    // If the deleted text was on the stage, queue a replacement rather than swapping
    // immediately — same phrase-boundary rule as every other change.
    if (this.activeName === name) this.pending = next;

    return next;
  }

  /** Import a file from elsewhere on disk. Returns its name, or null if cancelled. */
  async import(): Promise<string | null> {
    const name = await window.olib.texts.import();
    if (name === null) return null;

    this.saved.set(name, await window.olib.texts.read(name));
    if (!this.names.includes(name)) this.names = [...this.names, name].sort();
    return name;
  }

  /**
   * Called on a phrase boundary. Activates a queued text, or returns null to stay.
   */
  takePending(): TextPreset | null {
    if (this.pending === null) return null;
    const name = this.pending;
    this.pending = null;
    this.activate(name);
    return this.activePreset;
  }

  private activate(name: string): void {
    this.activeName = name;
    this.activePreset = parseText(name, this.saved.get(name) ?? '');
    // Remembered so the same text loads next launch.
    localStorage.setItem(ACTIVE_KEY, name);
  }
}
