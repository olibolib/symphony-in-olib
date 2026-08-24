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
  private readonly root: HTMLElement;
  private readonly backgroundSelect: HTMLSelectElement;
  private readonly paletteSelect: HTMLSelectElement;
  private readonly layoutSelect: HTMLSelectElement;
  private readonly deviceSelect: HTMLSelectElement;
  private readonly status: HTMLElement;

  /** Meter bar and onset LED for each band, looked up once rather than every frame. */
  private readonly meters = new Map<BandName, { bar: HTMLElement; name: HTMLElement }>();

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

  /** Called when a preset is enabled or disabled for the automatic cycle. */
  onPresetToggle: ((name: string, enabled: boolean) => void) | null = null;

  /** Called when a preset is chosen to go next. */
  onPresetGo: ((name: string) => void) | null = null;

  private readonly presetRows = new Map<string, HTMLElement>();

  /** Called when a text sub-tab is selected for editing. */
  onTextSelect: ((name: string) => void) | null = null;
  /** Called when the editor content changes. */
  onTextEdit: ((content: string) => void) | null = null;
  onTextApply: (() => void) | null = null;
  onTextRevert: (() => void) | null = null;
  onTextImport: (() => void) | null = null;
  /** Called with a name for a new, empty text. */
  onTextCreate: ((name: string) => void) | null = null;
  onTextDelete: (() => void) | null = null;

  private readonly textTabs = new Map<string, HTMLElement>();

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
    this.wireTabs(root);
    this.wireTextPanel(root);

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
      const name = el.querySelector<HTMLElement>('.name');
      if (band && bar && name) this.meters.set(band, { bar, name });
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

  /**
   * Sticky until cleared or superseded by another error.
   *
   * Routine updates — the rolling peak readout, which runs four times a second — must not
   * overwrite an error. That is exactly what happened: errors were visible for 250ms and
   * then gone, which is indistinguishable from not reporting them at all.
   */
  private errorUntil = 0;

  setStatus(message: string, isError = false): void {
    if (isError) {
      this.errorUntil = performance.now() + 20_000;
      this.status.textContent = message;
      this.status.dataset['error'] = 'true';
      console.error('[olib]', message);
      return;
    }

    if (performance.now() < this.errorUntil) return;

    this.status.textContent = message;
    this.status.dataset['error'] = 'false';
  }

  /** Drop a sticky error, e.g. once the thing that failed has succeeded. */
  clearError(): void {
    this.errorUntil = 0;
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
      els.bar.style.height = `${(reading.level * 100).toFixed(1)}%`;
      if (reading.onset) {
        els.name.dataset['on'] = 'true';
        window.setTimeout(() => {
          els.name.dataset['on'] = 'false';
        }, 70);
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
   * Show or hide the HUD.
   *
   * The window is **not** resized. That was the old behaviour and it moved the capture
   * geometry under OBS every time — with a fixed height and the transparent gap above, the
   * crop is set once and the HUD can stay open through a set without appearing in it.
   */
  setVisible(visible: boolean): void {
    this.root.toggleAttribute('hidden', !visible);
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

  /**
   * Build the preset list. Each row: an enable toggle for the automatic cycle, the name, its
   * energy tag, and a button to queue it next.
   *
   * Disabling only removes a preset from the *cycle* — you can still trigger it by hand,
   * which is why disabled rows dim rather than vanish.
   */
  setPresets(presets: readonly { name: string; energy: string }[], enabled: (n: string) => boolean): void {
    const list = must(document, '#opt-presets');
    list.replaceChildren();
    this.presetRows.clear();

    for (const preset of presets) {
      const row = document.createElement('div');
      row.className = 'preset';
      row.dataset['enabled'] = String(enabled(preset.name));

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = enabled(preset.name);
      toggle.title = 'Include in the automatic cycle';
      toggle.addEventListener('change', () => {
        this.onPresetToggle?.(preset.name, toggle.checked);
      });

      const name = document.createElement('span');
      name.className = 'pname';
      name.textContent = preset.name;

      const energy = document.createElement('span');
      energy.className = 'penergy';
      energy.textContent = preset.energy;

      const go = document.createElement('button');
      go.className = 'go';
      go.textContent = '→';
      go.title = 'Go to this preset at the next phrase';
      go.addEventListener('click', () => this.onPresetGo?.(preset.name));

      row.append(toggle, name, energy, go);
      list.append(row);
      this.presetRows.set(preset.name, row);
    }
  }

  /** Reflect a toggle the bank refused — disabling the last enabled preset. */
  setPresetEnabled(name: string, enabled: boolean): void {
    const row = this.presetRows.get(name);
    if (!row) return;
    row.dataset['enabled'] = String(enabled);
    const toggle = row.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (toggle) toggle.checked = enabled;
  }

  /** Green for what is running, pulsing red for what is waiting on the next phrase. */
  setPresetState(live: string, queued: string | null): void {
    for (const [name, row] of this.presetRows) {
      row.dataset['state'] = name === live ? 'live' : name === queued ? 'queued' : '';
    }
  }

  /**
   * Publish the beat period so queued indicators pulse in time.
   *
   * A CSS animation duration rather than a per-frame write: it stays smooth, costs nothing,
   * and follows the tempo automatically when it changes.
   */
  setBeatPeriod(ms: number | null): void {
    document.documentElement.style.setProperty('--beat-ms', `${ms ?? 500}ms`);
  }

  private wireTextPanel(root: ParentNode): void {
    const body = root.querySelector<HTMLTextAreaElement>('#opt-text-body');
    if (body) {
      body.addEventListener('input', () => this.onTextEdit?.(body.value));
    }

    must(root, '#opt-text-apply').addEventListener('click', () => this.onTextApply?.());
    must(root, '#opt-text-revert').addEventListener('click', () => this.onTextRevert?.());
    must(root, '#opt-text-import').addEventListener('click', () => this.onTextImport?.());
    this.wireDelete(root);
  }

  /**
   * Delete is two-step rather than a modal confirm.
   *
   * A modal steals focus and blocks the frame loop, which is the last thing wanted during a
   * set. Arming the button instead is reversible, needs no dialog, and disarms itself.
   */
  private wireDelete(root: ParentNode): void {
    const button = must(root, '#opt-text-delete');
    let armed = false;
    let timer: number | undefined;

    const disarm = (): void => {
      armed = false;
      button.dataset['armed'] = 'false';
      button.textContent = '\u{1F5D1}';
      if (timer !== undefined) window.clearTimeout(timer);
    };

    button.addEventListener('click', () => {
      if (armed) {
        disarm();
        this.onTextDelete?.();
        return;
      }
      armed = true;
      button.dataset['armed'] = 'true';
      button.textContent = 'Delete?';
      timer = window.setTimeout(disarm, 4000);
    });
  }

  /** Rebuild the text sub-tabs. */
  setTextList(names: readonly string[], selected: string): void {
    const tabs = must(document, '#opt-text-tabs');
    tabs.replaceChildren();
    this.textTabs.clear();

    for (const name of names) {
      const button = document.createElement('button');
      button.textContent = name;
      button.classList.toggle('selected', name === selected);
      button.addEventListener('click', () => this.onTextSelect?.(name));
      tabs.append(button);
      this.textTabs.set(name, button);
    }

    this.buildAddButton(tabs);
  }

  /**
   * The `+` that adds a text.
   *
   * It becomes an inline name field rather than opening a prompt — Electron does not
   * implement `window.prompt`, and a dialog would be heavier than this needs to be.
   */
  private buildAddButton(tabs: HTMLElement): void {
    const add = document.createElement('button');
    add.className = 'add';
    add.textContent = '+';
    add.title = 'New text';

    add.addEventListener('click', () => {
      const input = document.createElement('input');
      input.className = 'add-name';
      input.placeholder = 'name…';
      input.maxLength = 32;

      /**
       * Closing has to be idempotent and it has to detach its own blur listener first.
       *
       * Removing a focused element fires `blur` *synchronously*, so replacing the input
       * re-enters this function while the replacement is still in flight — at which point
       * the node has no parent and `replaceWith` throws. A DOM-state check is not enough;
       * the guard has to be a flag.
       */
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        input.removeEventListener('blur', close);
        if (input.parentNode !== null) input.replaceWith(add);
      };

      input.addEventListener('keydown', (event) => {
        // The HUD keys are global; typing a name must not tap tempo or hide the panel.
        event.stopPropagation();

        if (event.key === 'Enter') {
          const name = input.value.trim();
          close();
          if (name.length > 0) this.onTextCreate?.(name);
        } else if (event.key === 'Escape') {
          close();
        }
      });

      input.addEventListener('blur', close);

      add.replaceWith(input);
      input.focus();
    });

    tabs.append(add);
  }

  /** Which text is being edited, which is on the stage, and which is waiting for a phrase. */
  setTextState(selected: string, live: string, queued: string | null, edited: (n: string) => boolean): void {
    for (const [name, button] of this.textTabs) {
      button.classList.toggle('selected', name === selected);
      button.dataset['state'] = name === queued ? 'queued' : name === live ? 'live' : '';
      button.dataset['edited'] = String(edited(name));
    }
  }

  setTextBody(content: string): void {
    const body = document.querySelector<HTMLTextAreaElement>('#opt-text-body');
    if (body) body.value = content;
  }

  setTextControls(options: { canRevert: boolean; note: string }): void {
    const revert = document.querySelector<HTMLButtonElement>('#opt-text-revert');
    if (revert) revert.disabled = !options.canRevert;

    const note = document.querySelector<HTMLElement>('#opt-text-note');
    if (note) note.textContent = options.note;
  }

  /** Tab bar: one panel visible at a time, which is what makes the HUD fit its height. */
  private wireTabs(root: ParentNode): void {
    const buttons = Array.from(root.querySelectorAll<HTMLElement>('.tabs button'));
    const panels = Array.from(root.querySelectorAll<HTMLElement>('.panel'));

    for (const button of buttons) {
      button.addEventListener('click', () => {
        const name = button.dataset['tab'];
        for (const other of buttons) other.classList.toggle('active', other === button);
        for (const panel of panels) {
          panel.toggleAttribute('hidden', panel.dataset['panel'] !== name);
        }
      });
    }
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
