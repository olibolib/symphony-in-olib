import type { BandName } from '../audio/bands';
import type { Readings } from '../audio/Analyser';
import type { PaletteName } from '../render/palette';
import type { Mask } from '../show/mask';
import type { ClockSource } from '../types';
import {
  STATE_INTERVAL_MS,
  type ControlCommand,
  type EngineState,
  type PresetSnapshot,
} from './protocol';

/**
 * The engine's side of the window boundary. DESIGN.md §7.1.
 *
 * Deliberately mirrors the method names the HUD used, because the engine calls them from
 * about forty places and the difference between "one identifier changed" and "forty call
 * sites rewritten" is worth a little symmetry.
 *
 * The distinction that matters is *how* things leave: continuous readouts accumulate into a
 * snapshot published every {@link STATE_INTERVAL_MS}, while beats and onsets go out
 * immediately as discrete events. Nobody reads a meter sixty times a second, but a beat
 * indicator that arrives late is worse than useless.
 */
export class EngineBridge {
  private readonly state: {
    -readonly [K in keyof EngineState]: EngineState[K];
  } = {
    bpm: null,
    estimate: null,
    source: 'none',
    confidence: null,
    presets: [],
    livePreset: '',
    queuedPreset: null,
    liveText: '',
    queuedText: null,
    bands: {
      kick: { level: 0 },
      snare: { level: 0 },
      hat: { level: 0 },
    },
    device: null,
    devices: [],
    apps: [],
    sensitivities: { kick: 0, snare: 0, hat: 0 },
    palette: 'acid',
    mask: [],
    background: 'white',
    status: 'Starting…',
    statusIsError: false,
    clipped: 0,
    fps: 0,
    crop: { x: 0, y: 0, width: 1280, height: 720 },
  };

  /** Set by the engine; one handler per command type it cares about. */
  onCommand: ((command: ControlCommand) => void) | null = null;

  private lastPublish = 0;
  private frames = 0;
  private lastFpsSample = performance.now();

  /**
   * Sticky errors. The status line carries both a rolling readout and error messages, and
   * without this the readout overwrites an error within a tick — which is the same as never
   * having reported it.
   */
  private errorUntil = 0;

  constructor() {
    window.olib.onCommand((command) => this.onCommand?.(command));
  }

  // --- continuous state ------------------------------------------------------------------

  setBpm(bpm: number | null): void {
    this.state.bpm = bpm;
  }

  setEstimate(bpm: number | null): void {
    this.state.estimate = bpm;
  }

  setSource(source: ClockSource): void {
    this.state.source = source;
  }

  setConfidence(value: number | null): void {
    this.state.confidence = value;
  }

  setPreset(name: string, _energy: string): void {
    this.state.livePreset = name;
  }

  setPresetState(live: string, queued: string | null): void {
    this.state.livePreset = live;
    this.state.queuedPreset = queued;
  }

  setPresets(presets: readonly PresetSnapshot[]): void {
    this.state.presets = presets;
  }

  /** What is on the stage and what is waiting. The list itself lives in the control window. */
  setTextList(live: string, queued: string | null): void {
    this.state.liveText = live;
    this.state.queuedText = queued;
  }

  setDevices(devices: readonly { id: string; label: string }[], active: string | null): void {
    this.state.devices = devices;
    this.state.device = active;
  }

  /** Capturable applications, refreshed when the source list is rebuilt. */
  setApps(apps: readonly { processId: string; title: string }[]): void {
    this.state.apps = apps;
  }

  setSensitivity(band: BandName, value: number): void {
    this.state.sensitivities = { ...this.state.sensitivities, [band]: value };
  }

  setPalette(name: PaletteName): void {
    this.state.palette = name;
  }

  setMask(mask: Mask): void {
    this.state.mask = mask;
  }

  setBackground(mode: 'white' | 'black' | 'transparent'): void {
    this.state.background = mode;
  }

  setClipped(count: number): void {
    this.state.clipped = count;
  }

  setCrop(rect: { x: number; y: number; width: number; height: number }): void {
    this.state.crop = rect;
  }

  setStatus(message: string, isError = false): void {
    if (isError) {
      this.errorUntil = performance.now() + 20_000;
      this.state.status = message;
      this.state.statusIsError = true;
      console.error('[olib]', message);
      return;
    }

    if (performance.now() < this.errorUntil) return;
    this.state.status = message;
    this.state.statusIsError = false;
  }

  clearError(): void {
    this.errorUntil = 0;
  }

  /** Meter levels. Onsets go out separately, as events. */
  setBands(readings: Readings): void {
    this.state.bands = {
      kick: { level: readings.kick?.level ?? 0 },
      snare: { level: readings.snare?.level ?? 0 },
      hat: { level: readings.hat?.level ?? 0 },
    };

    for (const band of ['kick', 'snare', 'hat'] as const) {
      if (readings[band]?.onset === true) {
        window.olib.sendEvent({ type: 'onset', band });
      }
    }
  }

  // --- discrete events -------------------------------------------------------------------

  /** Sent the instant it happens, carrying the period so the indicator can pulse in time. */
  flashBeat(isDownbeat: boolean, periodMs: number): void {
    window.olib.sendEvent({ type: 'beat', isDownbeat, periodMs });
  }

  // --- publishing ------------------------------------------------------------------------

  countFrame(now: number): void {
    this.frames++;
    const elapsed = now - this.lastFpsSample;
    if (elapsed >= 500) {
      this.state.fps = Math.round((this.frames * 1000) / elapsed);
      this.frames = 0;
      this.lastFpsSample = now;
    }
  }

  /** Call once per frame. Publishes only when the interval has elapsed. */
  tick(now: number): void {
    if (now - this.lastPublish < STATE_INTERVAL_MS) return;
    this.lastPublish = now;
    this.publish();
  }

  /** Send everything now — the answer to a `requestState` from a window that just opened. */
  publish(): void {
    window.olib.sendEvent({ type: 'state', state: { ...this.state } });
  }
}
