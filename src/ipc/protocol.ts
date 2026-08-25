import type { BandName } from '../audio/bands';
import type { PaletteName } from '../render/palette';
import type { BlockShape, Mask } from '../show/mask';
import type { LayerSpec } from '../show/Layer';
import type { EnergyTag } from '../show/presets';
import type { Align, Flow, TextMode } from '../text/Typesetter';
import type { ClockSource } from '../types';

/**
 * The contract between the two windows. DESIGN.md §7.1.
 *
 * The engine runs in the output window; the control window is a view and an input surface.
 * Everything they say to each other is one of the types below, and both ends are checked
 * against this file — which is most of the argument for TypeScript in a two-process design.
 *
 * Direction is in the names: a **command** goes control to engine, an **event** comes back.
 */

// --- engine to control -------------------------------------------------------------------

/** Per-band meter values. Sent at a reduced rate — see `STATE_INTERVAL_MS`. */
export interface BandSnapshot {
  readonly level: number;
}

/**
 * The editable half of a preset. DESIGN.md §11.4.
 *
 * A preset is two things: **data** — layers, placement, text settings — and **stage
 * effects**, which are closures (`retext`, `colourShift`, `pulse`) and cannot cross a window
 * boundary or be written to a file. Only the data half is a document.
 *
 * That split is not a workaround. Everything here is what §11.5 pulled apart into
 * independent choices, and it is exactly the part worth editing during a set; the stage
 * effects are the part that has no target to separate out and no slider to put on it. They
 * are held engine-side and merged back by name.
 *
 * Sent whole and replaced whole rather than diffed. A preset is a few kilobytes, the editor
 * always has the current version, and "replace this document" is idempotent in a way that a
 * patch stream is not — which matters when the thing being edited is also running.
 */
export interface PresetDoc {
  readonly name: string;
  readonly energy: EnergyTag;

  readonly text: {
    readonly mode: TextMode;
    readonly count: number;
    readonly splitChars: boolean;
    readonly blocks: 1 | 2 | 3;
    readonly size: { readonly min: number; readonly max: number };
    readonly varyBy?: 'word' | 'char';
  };

  readonly spawn: Mask;
  readonly blockShapes: readonly BlockShape[];
  readonly align: Align;
  readonly flow: Flow;
  readonly avoidOverlap: boolean;

  readonly layers: readonly LayerSpec[];
}

export interface PresetSnapshot {
  readonly name: string;
  readonly energy: string;
  readonly enabled: boolean;
}

/**
 * Everything the control window needs to draw itself.
 *
 * One batched object rather than a message per readout. At sixty frames a second the
 * per-setter approach would be thousands of messages a minute for information nobody can
 * read that fast.
 */
export interface EngineState {
  readonly bpm: number | null;
  readonly estimate: number | null;
  readonly source: ClockSource;
  readonly confidence: number | null;

  readonly presets: readonly PresetSnapshot[];

  /** Every preset's editable document, for the Presets tab (§11.4). */
  readonly docs: readonly PresetDoc[];
  readonly livePreset: string;
  readonly queuedPreset: string | null;

  readonly liveText: string;
  readonly queuedText: string | null;

  readonly bands: Readonly<Record<BandName, BandSnapshot>>;

  readonly device: string | null;
  readonly devices: readonly { id: string; label: string }[];
  readonly apps: readonly { processId: string; title: string }[];
  readonly sensitivities: Readonly<Record<BandName, number>>;

  readonly palette: PaletteName;
  /**
   * The VJ's global spawn mask (§11.6) — where text may anchor, whatever a preset asks for.
   *
   * Sent as rows of `#` and `.` because that is what it *is*; the control window draws a
   * grid from it and sends a whole mask back rather than a diff, which keeps both ends
   * holding the same kind of value and makes the command idempotent.
   */
  readonly mask: Mask;
  readonly background: 'white' | 'black' | 'transparent';

  readonly status: string;
  readonly statusIsError: boolean;
  readonly clipped: number;
  readonly fps: number;
  readonly crop: { x: number; y: number; width: number; height: number };
}

export type EngineEvent =
  | { readonly type: 'state'; readonly state: EngineState }
  /** Discrete, so the indicator flashes exactly on the beat rather than on the next tick. */
  | { readonly type: 'beat'; readonly isDownbeat: boolean; readonly periodMs: number }
  | { readonly type: 'onset'; readonly band: BandName }
  /** Sent when a text's content changes on the engine side, so editors can resync. */
  | { readonly type: 'textContent'; readonly name: string; readonly content: string };

// --- control to engine -------------------------------------------------------------------

export type ControlCommand =
  /**
   * Sent when the control window opens.
   *
   * Without it a window opened mid-set shows blanks until something happens to change. The
   * protocol has to be able to answer "tell me everything", not only "tell me what changed".
   */
  | { readonly type: 'requestState' }
  | { readonly type: 'setDevice'; readonly id: string }
  /** Capture one application's audio rather than a device. */
  | { readonly type: 'setAppSource'; readonly processId: string; readonly title: string }
  | { readonly type: 'setSensitivity'; readonly band: BandName; readonly value: number }
  | { readonly type: 'setPalette'; readonly name: PaletteName }
  | { readonly type: 'setMask'; readonly mask: Mask }
  | { readonly type: 'setBackground'; readonly mode: 'white' | 'black' | 'transparent' }
  | { readonly type: 'queuePreset'; readonly name: string }
  | { readonly type: 'setPresetEnabled'; readonly name: string; readonly enabled: boolean }

  /**
   * Replace one preset's document.
   *
   * How it lands depends on what changed, and the rule is §11.4's: a parameter moves
   * immediately, because waiting for a phrase would make a slider feel broken, while
   * anything structural waits for the next phrase because it is a decision rather than an
   * adjustment. The engine works out which this is; the control window just sends the
   * document it has.
   */
  | { readonly type: 'updatePreset'; readonly doc: PresetDoc }
  | { readonly type: 'createPreset'; readonly from: string | null }
  | { readonly type: 'deletePreset'; readonly name: string }
  | { readonly type: 'renamePreset'; readonly from: string; readonly to: string }
  /**
   * Text editing lives in the control window; the engine only ever receives finished
   * content. Drafts, undo and the editor's own state never cross the boundary.
   */
  | { readonly type: 'applyText'; readonly name: string; readonly content: string }
  | { readonly type: 'selectText'; readonly name: string }
  | { readonly type: 'tapTempo' }
  | { readonly type: 'releaseManual' };

// --- channels ----------------------------------------------------------------------------

export const COMMAND_CHANNEL = 'olib:command';

/**
 * Raw PCM from per-application capture, main to the output window.
 *
 * Its own channel because it is high-rate — about 46 chunks a second — and has nothing to do
 * with the command/event protocol above.
 */
export const PCM_CHANNEL = 'olib:pcm';

/**
 * Marks a source as an application rather than an audio device.
 *
 * Both windows construct and parse these, so the format lives with the protocol rather than
 * in the UI: `app:<processId>|<title>`.
 */
export const APP_PREFIX = 'app:';

/** What the capture helper emits. */
export const PCM_SAMPLE_RATE = 48_000;
export const PCM_CHANNELS = 2;
export const EVENT_CHANNEL = 'olib:event';

/**
 * How often the engine publishes a full state snapshot, in ms.
 *
 * Meters do not need sixty updates a second — nobody reads a bar chart that fast, and the
 * cost is paid on every one. Beats and onsets bypass this as discrete events, because those
 * genuinely do need to land on time.
 */
export const STATE_INTERVAL_MS = 50;
