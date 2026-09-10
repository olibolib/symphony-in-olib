import { parseText, type TextPreset } from './TextSource';

/**
 * The text the engine is allowed to see. DESIGN.md §7.1 and §11.7.
 *
 * Editing — drafts, one-level undo, the file list, create and delete — lives in the control
 * window, which owns the editor. The engine receives finished content and nothing else, so
 * none of that state crosses the window boundary.
 *
 * Two kinds of text end up here. The **active** one is whatever the menu has selected, and it
 * arrives over IPC. A **pinned** one is named by a preset and read straight from the folder:
 * that is saved content, which is exactly what the engine is allowed to see, and it keeps
 * drafts on the side of the boundary they belong.
 */

/** How this reports back. The engine supplies the HUD. */
export interface TextReporter {
  status(message: string, isError?: boolean): void;
  list(active: string, pending: string | null): void;
}

/** Reading a saved text by name. The engine supplies the preload bridge; a test supplies a map. */
export type ReadText = (name: string) => Promise<string>;

export class TextPool {
  private active: TextPreset = parseText('empty', '');
  private activeName = '';
  private pending: { name: string; content: string } | null = null;

  /** Texts a preset has pinned by name, parsed and kept. */
  private readonly pinned = new Map<string, TextPreset>();

  /** Names that could not be loaded, so the warning is given once rather than every phrase. */
  private readonly missing = new Set<string>();

  constructor(
    private readonly report: TextReporter,
    private readonly readText: ReadText,
  ) {}

  /** What the menu currently has selected. */
  get current(): TextPreset {
    return this.active;
  }

  get currentName(): string {
    return this.activeName;
  }

  /** The pinned texts, by name, for resolving a preset's list. */
  get byName(): ReadonlyMap<string, TextPreset> {
    return this.pinned;
  }

  /** Queued rather than applied, like every other change (§11.2). */
  queue(name: string, content: string): void {
    this.pending = { name, content };
    this.report.list(this.activeName, name);
  }

  /** Swap in whatever was queued. Returns whether anything changed. */
  takePending(): boolean {
    if (this.pending === null) return false;
    this.active = parseText(this.pending.name, this.pending.content);
    this.activeName = this.pending.name;
    this.pending = null;
    this.report.list(this.activeName, null);
    return true;
  }

  /**
   * Fetch every text the presets name, ahead of time.
   *
   * Ahead of time because typesetting is synchronous and happens on a phrase boundary. Waiting
   * on a file read there would mean a missed phrase.
   */
  async load(wantedBy: readonly { readonly texts: readonly string[] }[]): Promise<void> {
    const wanted = new Set<string>();
    for (const doc of wantedBy) {
      for (const name of doc.texts) if (name !== 'default') wanted.add(name);
    }

    for (const name of wanted) {
      if (this.pinned.has(name) || this.missing.has(name)) continue;
      try {
        this.pinned.set(name, parseText(name, await this.readText(name)));
      } catch {
        // §11.7: a pinned name will eventually not resolve — a text renamed or deleted outside
        // the app, or a preset imported from someone else. Say so and fall back; nothing should
        // vanish because a file was renamed in October.
        this.missing.add(name);
        this.report.status(`Text "${name}" is missing — presets using it fall back`, true);
      }
    }

    // A text that has come back should stop being treated as missing.
    for (const name of Array.from(this.missing)) {
      if (!wanted.has(name)) this.missing.delete(name);
    }
  }
}
