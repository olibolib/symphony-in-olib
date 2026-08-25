import './types';
import { Hud } from './hud/Hud';
import { TextBank } from './text/TextBank';
import prologueRaw from '../presets/text/prologue.txt?raw';
import { APP_PREFIX, type EngineState } from './ipc/protocol';

/**
 * The control window. DESIGN.md §7.1.
 *
 * Holds no engine state of its own except text editing, which genuinely belongs here — the
 * editor owns drafts, one level of undo, and the file list, and none of that needs to cross
 * the window boundary. Everything else is a view of the snapshot the engine publishes.
 *
 * The `Hud` class is reused as-is for now, adapted from the state object. It will be replaced
 * by the panel system (§7.2); doing that at the same time as the window split would have
 * meant debugging two new things at once.
 */

let hud: Hud;
try {
  hud = new Hud();
} catch (error) {
  const message = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error);
  const box = document.createElement('pre');
  box.style.cssText =
    'position:fixed;inset:0;z-index:9999;margin:0;padding:24px;background:#140909;' +
    'color:#ff8b73;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow:auto';
  box.textContent = `Control window failed to start.\n\n${message}`;
  document.body.append(box);
  throw error;
}

const texts = new TextBank();

/** Which file the editor is showing. Not necessarily the one on the stage. */
let editing = '';

/** Latest snapshot, kept so text UI refreshes can read live/queued without asking again. */
let latest: EngineState | null = null;

// --- rendering the snapshot ------------------------------------------------------------

function render(state: EngineState): void {
  latest = state;

  hud.setBpm(state.bpm);
  hud.setEstimate(state.estimate);
  hud.setSource(state.source);
  hud.setConfidence(state.confidence);
  hud.setPreset(state.livePreset, energyOf(state, state.livePreset));
  hud.setBandLevels(state.bands);
  hud.setStatus(state.status, state.statusIsError);
  hud.setClipped(state.clipped);
  hud.setCrop(state.crop);
  hud.setPalette(state.palette);
  hud.setLayoutSet(state.layoutSet);
  hud.setBackgroundMode(state.background);
  hud.setDevices(
    state.devices.map((d) => ({ id: d.id, label: d.label, isSystem: false })),
    state.device,
    state.apps,
  );

  for (const band of ['kick', 'snare', 'hat'] as const) {
    hud.setSensitivity(band, state.sensitivities[band]);
  }

  // Rebuilding the preset rows on every snapshot would fight the pointer, so they are only
  // rebuilt when the set of names or their enabled flags actually changes.
  const signature = state.presets.map((p) => `${p.name}:${String(p.enabled)}`).join('|');
  if (signature !== presetSignature) {
    presetSignature = signature;
    hud.setPresets(state.presets, (name) =>
      state.presets.some((p) => p.name === name && p.enabled),
    );
  }
  hud.setPresetState(state.livePreset, state.queuedPreset);

  refreshTextUi();
}

let presetSignature = '';

function energyOf(state: EngineState, name: string): string {
  return state.presets.find((p) => p.name === name)?.energy ?? '';
}

// --- events from the engine --------------------------------------------------------------

window.olib.onEvent((message) => {
  switch (message.type) {
    case 'state':
      render(message.state);
      break;

    case 'beat':
      hud.flashBeat(message.isDownbeat);
      hud.setBeatPeriod(message.periodMs);
      break;

    case 'onset':
      hud.flashOnset(message.band);
      break;

    case 'textContent':
      break;
  }
});

// --- text editing -------------------------------------------------------------------------

function refreshTextUi(): void {
  const live = latest?.liveText ?? '';
  const queued = latest?.queuedText ?? null;

  hud.setTextState(editing, live, queued, (n) => texts.isEdited(n));
  hud.setTextControls({
    canRevert: texts.canRevert(editing),
    note:
      queued !== null
        ? `"${queued}" goes live at the next phrase`
        : texts.isEdited(editing)
          ? 'Unsaved edits — Apply to save and use them'
          : '',
  });
}

function selectText(name: string): void {
  editing = name;
  hud.setTextBody(texts.draft(name));
  window.olib.sendCommand({ type: 'selectText', name });
  refreshTextUi();
}

function reportTextError(action: string, error: unknown): void {
  console.error(`[olib] text ${action} failed`, error);
  const message = error instanceof Error ? error.message : String(error);
  hud.setStatus(`Text ${action} failed — ${message}`, true);
}

hud.onTextSelect = selectText;

hud.onTextEdit = (content) => {
  texts.setDraft(editing, content);
  refreshTextUi();
};

hud.onTextApply = () => {
  const name = editing;
  texts
    .apply(name)
    .then(() => {
      // The engine receives finished content; it never sees a draft.
      window.olib.sendCommand({ type: 'applyText', name, content: texts.contentOf(name) });
      refreshTextUi();
    })
    .catch((error: unknown) => reportTextError('apply', error));
};

hud.onTextRevert = () => {
  const older = texts.revert(editing);
  // Revert only refills the editor. It still has to be applied, like any other change.
  if (older !== null) hud.setTextBody(older);
  refreshTextUi();
};

hud.onTextCreate = (name) => {
  texts
    .create(name)
    .then((made) => {
      if (!made) {
        hud.setTextControls({ canRevert: texts.canRevert(editing), note: `"${name}" already exists` });
        return;
      }
      hud.setTextList(texts.list, name);
      selectText(name);
    })
    .catch((error: unknown) => reportTextError('create', error));
};

hud.onTextDelete = () => {
  texts
    .remove(editing)
    .then((next) => {
      if (next === null) {
        hud.setTextControls({
          canRevert: texts.canRevert(editing),
          note: 'Cannot delete the only text',
        });
        return;
      }
      hud.setTextList(texts.list, next);
      selectText(next);
    })
    .catch((error: unknown) => reportTextError('delete', error));
};

hud.onTextImport = () => {
  texts
    .import()
    .then((name) => {
      if (name === null) return;
      hud.setTextList(texts.list, name);
      selectText(name);
    })
    .catch((error: unknown) => reportTextError('import', error));
};

// --- commands out --------------------------------------------------------------------------

hud.onDeviceChange = (id) => {
  if (id.startsWith(APP_PREFIX)) {
    const [processId, ...rest] = id.slice(APP_PREFIX.length).split('|');
    window.olib.sendCommand({
      type: 'setAppSource',
      processId: processId ?? '',
      title: rest.join('|'),
    });
    return;
  }
  window.olib.sendCommand({ type: 'setDevice', id });
};
hud.onSensitivityChange = (band, value) =>
  window.olib.sendCommand({ type: 'setSensitivity', band, value });
hud.onPaletteChange = (name) => window.olib.sendCommand({ type: 'setPalette', name });
hud.onLayoutSetChange = (name) => window.olib.sendCommand({ type: 'setLayoutSet', name });
hud.onBackgroundChange = (mode) => window.olib.sendCommand({ type: 'setBackground', mode });
hud.onPresetGo = (name) => window.olib.sendCommand({ type: 'queuePreset', name });
hud.onPresetToggle = (name, enabled) =>
  window.olib.sendCommand({ type: 'setPresetEnabled', name, enabled });

// --- canvas placement ---------------------------------------------------------------------

/**
 * The canvas window is frameless, so it has no title bar to drag. Placement is typed here.
 *
 * Frameless is not a style choice: Windows requires it for a transparent window, and
 * transparency is worth keeping — verified 2026-08-21, alpha does survive OBS window capture.
 */
const outField = (id: string): HTMLInputElement => {
  const el = document.querySelector<HTMLInputElement>(id);
  if (!el) throw new Error(`Canvas field missing: ${id}`);
  return el;
};

const outW = outField('#opt-out-w');
const outH = outField('#opt-out-h');
const outX = outField('#opt-out-x');
const outY = outField('#opt-out-y');

function loadOutputBounds(): void {
  void window.olib.output.bounds().then((bounds) => {
    if (!bounds) return;
    outW.value = String(bounds.width);
    outH.value = String(bounds.height);
    outX.value = String(bounds.x);
    outY.value = String(bounds.y);
  });
}

function applyOutputBounds(): void {
  window.olib.output.setBounds({
    x: Number(outX.value),
    y: Number(outY.value),
    width: Number(outW.value),
    height: Number(outH.value),
  });
  // Read back rather than trusting the request — the main process clamps to a visible
  // display, so what you asked for is not always what you get.
  window.setTimeout(loadOutputBounds, 60);
}

document.querySelector('#opt-out-apply')?.addEventListener('click', applyOutputBounds);

document.querySelector('#opt-out-centre')?.addEventListener('click', () => {
  window.olib.output.centre();
  window.setTimeout(loadOutputBounds, 60);
});

document.querySelector('#opt-out-preset-720')?.addEventListener('click', () => {
  outW.value = '1280';
  outH.value = '720';
  applyOutputBounds();
});

document.querySelector('#opt-out-preset-1080')?.addEventListener('click', () => {
  outW.value = '1920';
  outH.value = '1080';
  applyOutputBounds();
});

loadOutputBounds();

// --- keys ----------------------------------------------------------------------------------

// Only while this window has focus. Global shortcuts would steal keys from the DJ software,
// which is the one thing the tool must never do.
window.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    event.preventDefault();
    window.olib.sendCommand({ type: 'tapTempo' });
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    window.olib.sendCommand({ type: 'releaseManual' });
  }
});

// --- start ---------------------------------------------------------------------------------

void texts
  .load('prologue', prologueRaw)
  .then(() => {
    editing = texts.liveName;
    hud.setTextList(texts.list, editing);
    hud.setTextBody(texts.draft(editing));

    // Push the loaded text to the engine, which starts with nothing on the stage.
    window.olib.sendCommand({
      type: 'applyText',
      name: editing,
      content: texts.contentOf(editing),
    });

    refreshTextUi();
  })
  .catch((error: unknown) => reportTextError('load', error));

// Ask for everything. Without this the window shows blanks until something happens to change.
window.olib.sendCommand({ type: 'requestState' });
