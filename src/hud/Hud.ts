import type { ClockSource } from '../types';
import type { BandName } from '../audio/bands';
import type { Readings } from '../audio/Analyser';
import type { InputOption } from '../audio/AudioInput';

import type { PaletteName } from '../render/palette';
import type { LayoutSetName } from '../show/layouts';

export type BackgroundMode = 'white' | 'black' | 'transparent';

/**
 * The status strip below the stage. Never captured by OBS.
 *
 * Everything here exists to answer one question from across a room: is it locked?
 * DESIGN.md §13.2.
 */
export class Hud {
  private readonly bpm: HTMLElement;
  private readonly source: HTMLElement;
  private readonly confidence: HTMLElement;
  private readonly estimate: HTMLElement;
  private readonly preset: HTMLElement;
  private readonly energy: HTMLElement;
  private readonly beatDot: HTMLElement;
  private readonly crop: HTMLElement;
  private readonly fps: HTMLElement;
  private readonly clip: HTMLElement;
  private readonly options: HTMLElement;
  private readonly root: HTMLElement;
  private readonly backgroundSelect: HTMLSelectElement;
  private readonly paletteSelect: HTMLSelectElement;
  private readonly layoutSelect: HTMLSelectElement;
  private readonly deviceSelect: HTMLSelectElement;
  private readonly status: HTMLElement;

  /** Meter bar and onset LED for each band, looked up once rather than every frame. */
  private readonly meters = new Map<BandName, { bar: HTMLElement; led: HTMLElement }>();

  /** Called when the user picks a different audio source. */
  onDeviceChange: ((id: string) => void) | null = null;

  /** Called when an onset sensitivity slider moves. */
  onSensitivityChange: ((band: BandName, value: number) => void) | null = null;

  /** Called when the stage background mode changes. */
  onBackgroundChange: ((mode: BackgroundMode) => void) | null = null;

  /** Called when the accent palette changes. */
  onPaletteChange: ((name: PaletteName) => void) | null = null;

  /** Called when the layout set changes. */
  onLayoutSetChange: ((name: LayoutSetName) => void) | null = null;

  private readonly sensInputs = new Map<BandName, { input: HTMLInputElement; out: HTMLElement }>();

  /** Frames counted since the last FPS sample. */
  private frames = 0;
  private lastFpsSample = performance.now();

  constructor(root: ParentNode = document) {
    this.bpm = must(root, '#r-bpm');
    this.source = must(root, '#r-source');
    this.confidence = must(root, '#r-conf');
    this.estimate = must(root, '#r-est');
    this.preset = must(root, '#r-preset');
    this.energy = must(root, '#r-energy');
    this.beatDot = must(root, '#r-beat');
    this.crop = must(root, '#r-crop');
    this.fps = must(root, '#r-fps');
    this.clip = must(root, '#r-clip');
    this.options = must(root, '#options');
    this.root = must(root, '#hud');
    this.status = must(root, '#opt-status');

    const bg = root.querySelector<HTMLSelectElement>('#opt-bg');
    if (!bg) throw new Error('HUD element missing: #opt-bg');
    this.backgroundSelect = bg;
    this.backgroundSelect.addEventListener('change', () => {
      this.onBackgroundChange?.(this.backgroundSelect.value as BackgroundMode);
    });

    this.paletteSelect = requireSelect(root, '#opt-palette');
    this.paletteSelect.addEventListener('change', () => {
      this.onPaletteChange?.(this.paletteSelect.value as PaletteName);
    });

    this.layoutSelect = requireSelect(root, '#opt-layout');
    this.layoutSelect.addEventListener('change', () => {
      this.onLayoutSetChange?.(this.layoutSelect.value as LayoutSetName);
    });

    must(root, '#opt-close').addEventListener('click', () => window.olib.close());

    const select = root.querySelector<HTMLSelectElement>('#opt-device');
    if (!select) throw new Error('HUD element missing: #opt-device');
    this.deviceSelect = select;
    this.deviceSelect.addEventListener('change', () => {
      this.onDeviceChange?.(this.deviceSelect.value);
    });

    for (const el of root.querySelectorAll<HTMLInputElement>('.sens input[type="range"]')) {
      const band = el.dataset['band'] as BandName | undefined;
      const out = el.parentElement?.querySelector<HTMLElement>('code');
      if (!band || !out) continue;
      this.sensInputs.set(band, { input: el, out });
      el.addEventListener('input', () => {
        const value = Number(el.value);
        out.textContent = value.toFixed(1);
        this.onSensitivityChange?.(band, value);
      });
    }

    for (const el of root.querySelectorAll<HTMLElement>('.meter')) {
      const band = el.dataset['band'] as BandName | undefined;
      const bar = el.querySelector<HTMLElement>('.bar i');
      const led = el.querySelector<HTMLElement>('.led');
      if (band && bar && led) this.meters.set(band, { bar, led });
    }
  }

  /** Populate the source dropdown, preserving the current selection where possible. */
  setDevices(options: InputOption[], selectedId: string | null): void {
    this.deviceSelect.replaceChildren(
      ...options.map((option) => {
        const el = document.createElement('option');
        el.value = option.id;
        el.textContent = option.label;
        el.selected = option.id === selectedId;
        return el;
      }),
    );
  }

  /** Push a sensitivity value into its slider without firing the change callback. */
  setSensitivity(band: BandName, value: number): void {
    const entry = this.sensInputs.get(band);
    if (!entry) return;
    entry.input.value = String(value);
    entry.out.textContent = value.toFixed(1);
  }

  setStatus(message: string, isError = false): void {
    this.status.textContent = message;
    this.status.dataset['error'] = String(isError);
  }

  /** Bring the HUD back — used when startup needs the user to choose something. */
  showOptions(): void {
    this.setVisible(true);
  }

  /**
   * Update the band meters. Writes only what changed: levels move every frame, but the
   * onset LED is a data attribute flip that CSS animates, so JS does no work decaying it.
   */
  setBands(readings: Readings): void {
    for (const [band, els] of this.meters) {
      const reading = readings[band];
      if (!reading) continue;
      els.bar.style.width = `${(reading.level * 100).toFixed(1)}%`;
      if (reading.onset) {
        els.led.dataset['on'] = 'true';
        window.setTimeout(() => {
          els.led.dataset['on'] = 'false';
        }, 60);
      }
    }
  }

  setBpm(bpm: number | null): void {
    this.bpm.textContent = bpm === null ? '—' : bpm.toFixed(1);
  }

  /** The tracker's raw reading, before the clock decides what to do with it. */
  setEstimate(bpm: number | null): void {
    this.estimate.textContent = bpm === null ? '—' : bpm.toFixed(1);
  }

  /** Which preset is running. Worth showing: it is the main thing that changes on its own. */
  setPreset(name: string, energy: string): void {
    this.preset.textContent = name;
    this.energy.textContent = energy;
  }

  setSource(source: ClockSource): void {
    this.source.textContent = source;
  }

  /** Confidence is 0–1; shown as a percentage because that reads faster. */
  setConfidence(value: number | null): void {
    this.confidence.textContent = value === null ? '—' : `${Math.round(value * 100)}%`;
  }

  /**
   * Flash the beat indicator. Downbeats get a ring so phase is visible, not just pulse.
   * The dot is turned off again on a timer rather than on the next beat, so a stalled
   * clock looks stalled instead of looking like a held note.
   */
  flashBeat(isDownbeat: boolean): void {
    this.beatDot.dataset['on'] = 'true';
    this.beatDot.dataset['downbeat'] = String(isDownbeat);
    window.setTimeout(() => {
      this.beatDot.dataset['on'] = 'false';
    }, 70);
  }

  /** Blocks whose text does not fit. Anything above zero means text is being lost. */
  setClipped(count: number): void {
    this.clip.textContent = String(count);
    this.clip.dataset['warn'] = String(count > 0);
  }

  setCrop(rect: { x: number; y: number; width: number; height: number }): void {
    this.crop.textContent = `${rect.x},${rect.y} ${rect.width}×${rect.height}`;
  }

  /**
   * Show or hide the whole HUD, shrinking the window with it.
   *
   * Hiding it leaves the window as exactly the stage, so an OBS window capture needs no
   * crop at all. The trade-off of a frameless window is that the HUD is also the drag
   * handle — with it hidden there is nothing to grab, so bring it back to move the window.
   */
  setVisible(visible: boolean): void {
    this.root.toggleAttribute('hidden', !visible);
    window.olib.setHudVisible(visible);
  }

  get visible(): boolean {
    return !this.root.hasAttribute('hidden');
  }

  toggle(): boolean {
    const next = !this.visible;
    this.setVisible(next);
    return next;
  }

  setBackgroundMode(mode: BackgroundMode): void {
    this.backgroundSelect.value = mode;
  }

  setPalette(name: PaletteName): void {
    this.paletteSelect.value = name;
  }

  setLayoutSet(name: LayoutSetName): void {
    this.layoutSelect.value = name;
  }

  /** Call once per rendered frame; updates the FPS readout about twice a second. */
  countFrame(now: number): void {
    this.frames++;
    const elapsed = now - this.lastFpsSample;
    if (elapsed >= 500) {
      this.fps.textContent = Math.round((this.frames * 1000) / elapsed).toString();
      this.frames = 0;
      this.lastFpsSample = now;
    }
  }
}

function requireSelect(root: ParentNode, selector: string): HTMLSelectElement {
  const el = root.querySelector<HTMLSelectElement>(selector);
  if (!el) throw new Error(`HUD element missing: ${selector}`);
  return el;
}

/** Query an element that must exist, and fail loudly at startup if it doesn't. */
function must(root: ParentNode, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`HUD element missing: ${selector}`);
  return el;
}
