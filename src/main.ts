import './types';

/**
 * Last-resort startup failure display.
 *
 * Everything downstream depends on the HUD existing, including the error handlers — so a
 * throw while building it leaves an app that looks alive and does nothing. This is the only
 * reporting path that depends on nothing but the DOM.
 */
function fatal(error: unknown): never {
  const message = error instanceof Error ? `${error.message}

${error.stack ?? ''}` : String(error);
  const box = document.createElement('pre');
  box.style.cssText =
    'position:fixed;inset:0;z-index:9999;margin:0;padding:24px;background:#140909;' +
    'color:#ff8b73;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;' +
    'overflow:auto';
  box.textContent = `Symphony in Olib failed to start.

${message}`;
  document.body.append(box);
  throw error;
}

window.addEventListener('error', (event) => {
  console.error('[olib] uncaught error', event.error ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[olib] unhandled rejection', event.reason);
});
import { Stage } from './render/Stage';
import { EngineBridge } from './ipc/EngineBridge';
import { AudioInput, SYSTEM_SOURCE_ID } from './audio/AudioInput';
import { Analyser } from './audio/Analyser';
import { AppCapture } from './audio/AppCapture';
import { APP_PREFIX } from './ipc/protocol';
import { BANDS, type BandName } from './audio/bands';
import { BeatTracker } from './time/BeatTracker';
import { Clock } from './time/Clock';
import { parseText, type TextPreset } from './text/TextSource';
import { Typesetter, type TextMode } from './text/Typesetter';
import { randomRange } from './util/random';
import prologueRaw from '../presets/text/prologue.txt?raw';
import { Conductor, type Lane } from './show/Conductor';
import { PRESETS } from './show/presets';
import { PresetBank } from './show/PresetBank';
import { GlitchState, type EffectContext } from './effects/types';
type BackgroundMode = 'white' | 'black' | 'transparent';
import { PALETTES, type PaletteName } from './render/palette';
import { LAYOUT_SETS, type LayoutSetName } from './show/layouts';

/**
 * Increment 1 complete.
 *
 * Audio in, tempo out, a predicted beat grid driving lanes, lanes driving effects, and a
 * bank of presets cycling on phrase boundaries so it runs unattended.
 */

let stage: Stage;
let hud: EngineBridge;
try {
  stage = new Stage(el('#stage'), el('#container'));
  hud = new EngineBridge();
} catch (error) {
  fatal(error);
}
const input = new AudioInput();
const tracker = new BeatTracker();
const clock = new Clock();
const typesetter = new Typesetter(stage);
const conductor = new Conductor();
const glitches = new GlitchState();
const bank = new PresetBank(PRESETS);

/** Phrases the current text has been on screen. Drives `retext` holds and `whenHolding`. */
let textAge = 0;

let analyser: Analyser | null = null;
const appCapture = new AppCapture();

/**
 * What is actually being captured, in the dropdown's own vocabulary.
 *
 * A device id, or `app:<pid>|<title>`. Kept here because `refreshDevices` republishes the
 * source list periodically and would otherwise report the last *device* as active even while
 * an application is being captured — which made the selection appear to revert.
 */
let activeSourceId: string | null = null;

// PCM from per-application capture. Straight through to the worklet; nothing inspects it.
window.olib.apps.onPcm((chunk) => appCapture.accept(chunk));

/**
 * Capture one application rather than a device.
 *
 * Works whatever output device the application is using, and cannot pick up anything else —
 * no notification pings in the club PA. The catch is ASIO: an application driving its
 * interface directly bypasses the Windows audio engine, and there is nothing to capture. We
 * detect that by seeing no frames arrive at all, which is a different thing from silence.
 */
async function startAppCapture(processId: string, title: string): Promise<void> {
  try {
    hud.setStatus(`Opening ${title}…`);
    analyser?.close();
    analyser = null;
    input.close();

    const node = await appCapture.start(processId, title);
    const next = new Analyser(node);
    await next.resume();
    for (const band of BANDS) next.setSensitivity(band.name, sensitivityFor(band.name));
    analyser = next;

    activeSourceId = `${APP_PREFIX}${processId}|${title}`;
    captureLabel = title;
    hud.setStatus(`Capturing ${title}`);
    await refreshDevices();

    // If nothing at all has arrived after a few seconds, say why rather than showing a dead
    // meter and letting it look like the app is broken.
    window.setTimeout(() => {
      if (appCapture.framesReceived === 0) {
        hud.setStatus(
          `No audio from ${title} — it may be using ASIO, which bypasses Windows audio capture`,
          true,
        );
      }
    }, 4000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    hud.setStatus(`Could not capture ${title} — ${message}`, true);
  }
}
let captureLabel = '';
let lastStatusAt = 0;

/**
 * Onset sensitivities, tuned from the HUD and remembered. These want to be set against
 * real records rather than guessed at, so they are a live control rather than a constant.
 */
const SENS_KEY = 'olib.sensitivity';

function loadSensitivities(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SENS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

const sensitivities = loadSensitivities();

function sensitivityFor(band: BandName): number {
  const stored = sensitivities[band];
  if (typeof stored === 'number') return stored;
  return BANDS.find((b) => b.name === band)?.sensitivity ?? 2;
}

for (const band of BANDS) hud.setSensitivity(band.name, sensitivityFor(band.name));

function setSensitivity(band: BandName, value: number): void {
  sensitivities[band] = value;
  localStorage.setItem(SENS_KEY, JSON.stringify(sensitivities));
  analyser?.setSensitivity(band, value);
  hud.setSensitivity(band, value);
}

/**
 * Stage background. Transparent is for compositing over other layers in OBS (§13.3) — the
 * text colour flips to white with it, since black type over arbitrary video is unreadable.
 */
const BG_KEY = 'olib.background';

function applyBackground(mode: BackgroundMode): void {
  document.documentElement.dataset['bg'] = mode;
  stage.backgroundMode = mode;
  localStorage.setItem(BG_KEY, mode);
  hud.setBackground(mode);
}

const storedBackground = (localStorage.getItem(BG_KEY) as BackgroundMode | null) ?? 'white';
applyBackground(storedBackground);
hud.setBackground(storedBackground);

/**
 * Palette and layout set. Both exist for compositing over other visuals: saturated accents
 * clash with whatever is underneath, and centre layouts land text on top of it.
 */
const PALETTE_KEY = 'olib.palette';
const LAYOUT_KEY = 'olib.layoutSet';

let paletteName = (localStorage.getItem(PALETTE_KEY) as PaletteName | null) ?? 'acid';
let layoutSetName = (localStorage.getItem(LAYOUT_KEY) as LayoutSetName | null) ?? 'centre';

hud.setPalette(paletteName);
hud.setLayoutSet(layoutSetName);

function setPalette(name: PaletteName): void {
  paletteName = name;
  localStorage.setItem(PALETTE_KEY, name);
  hud.setPalette(name);
}

function setLayoutSet(name: LayoutSetName): void {
  layoutSetName = name;
  localStorage.setItem(LAYOUT_KEY, name);
  hud.setLayoutSet(name);

  // Apply immediately rather than waiting for the next bar — if you have just switched to
  // "edges" because text is sitting on your visuals, four beats is too long to wait.
  const options = LAYOUT_SETS[name];
  const next = options[Math.floor(Math.random() * options.length)];
  if (next !== undefined) stage.container.dataset['layout'] = String(next);
}

hud.setSource('none');
hud.setBpm(null);
hud.setConfidence(null);
hud.setCrop(stage.cropRect());
// Base size everything else is a percentage of. Raised from 24: small type is unreadable
// on a projector and gets smeared into mush by a visualiser warping the output.


// --- text -----------------------------------------------------------------------------

/**
 * The engine holds only the text that is *on the stage*.
 *
 * Editing — drafts, one-level undo, the file list, create and delete — lives in the control
 * window, which owns the editor. The engine receives finished content and nothing else, so
 * none of that state crosses the window boundary. DESIGN.md §7.1.
 */
let activeText: TextPreset = parseText('empty', '');
let activeTextName = '';
let pendingText: { name: string; content: string } | null = null;

/** Queued rather than applied, like every other change (§11.2). */
function queueText(name: string, content: string): void {
  pendingText = { name, content };
  hud.setTextList(activeTextName, pendingText.name);
}

function takePendingText(): boolean {
  if (pendingText === null) return false;
  activeText = parseText(pendingText.name, pendingText.content);
  activeTextName = pendingText.name;
  pendingText = null;
  hud.setTextList(activeTextName, null);
  return true;
}

/** Render the current preset's text selection. */
function typesetNext(): void {
  const preset = bank.current;

  typesetter.render(activeText, {
    mode: preset.text.mode,
    splitChars: preset.text.splitChars,
    count: preset.text.count,
    blocks: preset.text.blocks,
  });

  // The tracked elements no longer exist after a re-render.
  glitches.forget();
  textAge = 0;

  hud.setClipped(typesetter.clipped);
}

/**
 * Switch preset: load its bindings, apply its sizing, and re-typeset.
 *
 * Everything a preset changes happens in one place, so a preset can never be half-applied —
 * new bindings running against text selected by the previous one.
 */
function applyPreset(): void {
  const preset = bank.current;

  conductor.load({
    bindings: preset.bindings,
    ...(preset.ambient ? { ambient: preset.ambient } : {}),
  });

  hud.setPresetState(preset.name, bank.pending);
  stage.setFontScale(preset.fontScale);

  // Continuous stage state persists until something sets it, so a preset that does not use
  // pulse or scroll would otherwise inherit whatever the previous one left running — and a
  // pulse with nothing driving it freezes at its last value rather than stopping.
  stage.pulse = 0;
  stage.scrollSpeed = 0;

  typesetNext();
  hud.setPreset(preset.name, preset.energy);
}

function publishPresets(): void {
  hud.setPresets(
    PRESETS.map((p) => ({ name: p.name, energy: p.energy, enabled: bank.isEnabled(p.name) })),
  );
}

publishPresets();

applyPreset();

/** Built fresh each frame so effects always see current levels. */
function effectContext(): EffectContext {
  return {
    stage,
    typesetter,
    glitches,
    energy: analyser?.energy ?? 0,
    bass: analyser?.bass ?? 0,
    palette: PALETTES[paletteName],
    layouts: LAYOUT_SETS[layoutSetName],
    beatPhase: clock.phase(performance.now()),
    textAge,
    retext: typesetNext,
  };
}

// Surface anything that escapes, rather than leaving a dead-looking window with no clue
// why. DESIGN.md §14 — never fail silently.
window.addEventListener('error', (event) => {
  console.error('[olib]', event.error ?? event.message);
  hud.setStatus(`Error: ${event.message}`, true);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[olib] rejection', event.reason);
  hud.setStatus(`Error: ${String(event.reason)}`, true);
});

// --- audio ---------------------------------------------------------------------------

async function refreshDevices(): Promise<void> {
  hud.setApps(await window.olib.apps.list());
  const options = await input.list();
  hud.setDevices(
    options.map((o) => ({ id: o.id, label: o.label })),
    // The tracked source, not `input.activeId` — that only knows about devices, so it would
    // report the previous device as active while an application is being captured.
    activeSourceId ?? AudioInput.remembered() ?? SYSTEM_SOURCE_ID,
  );
}

async function startCapture(id: string): Promise<void> {
  try {
    hud.setStatus('Opening…');
    analyser?.close();
    analyser = null;

    appCapture.stop();
    const stream = await input.open(id);
    const next = new Analyser(stream);
    await next.resume();
    for (const band of BANDS) next.setSensitivity(band.name, sensitivityFor(band.name));
    analyser = next;

    activeSourceId = id;
    captureLabel = `${input.activeTrackLabel ?? 'unknown source'} · ${next.sampleRate / 1000} kHz`;
    hud.setStatus(`Capturing · ${captureLabel}`);
    await refreshDevices();
  } catch (error) {
    // DESIGN.md §14: never fail silently, never take the app down.
    const message = error instanceof Error ? error.message : String(error);
    hud.setStatus(`Could not open source — ${message}`, true);
    }
}


input.onDevicesChanged = () => void refreshDevices();

// Come up already capturing: last used source, or system output on a first run.
//
// Unless the last attempt killed us. A source that crashes the renderer would otherwise be
// retried on every launch, and since the reload happens automatically that is an infinite
// loop with a black window. If we find the crash flag set, we stop and hand it to the user.
void (async () => {
  await refreshDevices();

  const crashed = AudioInput.crashedOn();
  if (crashed !== null) {
    AudioInput.clearCrashFlag();
    hud.setStatus(`"${crashed}" failed last time — pick a source to try again`, true);
      return;
  }

  await startCapture(AudioInput.remembered() ?? SYSTEM_SOURCE_ID);
})();

// --- commands from the control window -------------------------------------------------

/**
 * One switch, exhaustively checked.
 *
 * Because `ControlCommand` is a discriminated union, adding a command without handling it
 * here is a compile error rather than a message that silently does nothing.
 */
hud.onCommand = (command) => {
  switch (command.type) {
    case 'requestState':
      // A window that just opened needs everything, not the next delta.
      publishPresets();
      hud.publish();
      break;

    case 'setDevice':
      void startCapture(command.id);
      break;

    case 'setAppSource':
      void startAppCapture(command.processId, command.title);
      break;

    case 'setSensitivity':
      setSensitivity(command.band, command.value);
      break;

    case 'setPalette':
      setPalette(command.name);
      break;

    case 'setLayoutSet':
      setLayoutSet(command.name);
      break;

    case 'setBackground':
      applyBackground(command.mode);
      break;

    case 'queuePreset':
      bank.queue(command.name);
      hud.setPresetState(bank.current.name, bank.pending);
      break;

    case 'setPresetEnabled':
      bank.setEnabled(command.name, command.enabled);
      publishPresets();
      break;

    case 'applyText':
      queueText(command.name, command.content);
      break;

    case 'selectText':
      // Selecting only changes what the editor shows; nothing on the stage moves.
      break;

    case 'tapTempo':
      clock.tap(performance.now());
      hud.setBpm(clock.bpm);
      hud.setSource(clock.source);
      hud.setConfidence(clock.confidence);
      break;

    case 'releaseManual':
      clock.releaseManual();
      hud.setSource('detected');
      break;
  }
};

/**
 * Keep the stage the size of the window.
 *
 * The stage is still a fixed, exact resolution — you set it from the Canvas tab rather than
 * by dragging, so layout stays deterministic (§13.1). This only makes the CSS follow when
 * that number changes.
 */
function syncStageSize(): void {
  document.documentElement.style.setProperty('--stage-w', `${window.innerWidth}px`);
  document.documentElement.style.setProperty('--stage-h', `${window.innerHeight}px`);
  hud.setCrop(stage.cropRect());
}

window.addEventListener('resize', syncStageSize);
syncStageSize();

// --- frame loop ----------------------------------------------------------------------

let lastFrameAt = performance.now();

function frame(now: number): void {
  // Seconds since the previous frame, clamped: after a stall, a huge delta would teleport
  // the scroll rather than continuing it.
  const dt = Math.min((now - lastFrameAt) / 1000, 0.1);
  lastFrameAt = now;

  // Advance the grid before building the context. Anything derived from musical position —
  // beat phase, text age — has to be current when effects read it, and the phrase handler
  // below mutates text age.
  const beat = clock.update(now);
  if (beat?.isPhraseStart === true) textAge++;

  const ctx = effectContext();

  if (analyser) {
    const bands = analyser.read(now);
    hud.setBands(bands);

    // Onset lanes. These fire on the audio itself rather than the grid, so they carry the
    // detail — syncopation, fills, anything the beat grid cannot know about.
    for (const lane of ['kick', 'snare', 'hat'] as const) {
      if (bands[lane]?.onset === true) conductor.fire(lane satisfies Lane, ctx);
    }

    // The envelope the tracker works from. Weighted toward the kick, because that is what
    // carries the beat in this material, but not exclusively — a track with a soft kick
    // still needs something to lock onto.
    const onsetEnergy =
      (bands.kick?.flux ?? 0) * 1 +
      (bands.snare?.flux ?? 0) * 0.6 +
      (bands.hat?.flux ?? 0) * 0.3;

    tracker.push(now, onsetEnergy);

    const estimate = tracker.estimate(now);
    if (estimate) {
      hud.setEstimate(estimate.bpm);
      clock.apply(estimate);
      hud.setBpm(clock.bpm);
      hud.setSource(clock.source);
      hud.setConfidence(clock.confidence);
    }

    // Report the raw input peak a few times a second. If this reads -inf while music is
    // playing, nothing is reaching us and the fault is in capture, not analysis.
    if (now - lastStatusAt > 250) {
      lastStatusAt = now;
      const peak = analyser.peak;
      const db = peak > 0 ? `${(20 * Math.log10(peak)).toFixed(1)} dB` : 'silent';
      hud.setStatus(`Capturing · ${captureLabel} · peak ${db}`);
    }
  }

  // Grid lanes. Predicted rather than detected (§9.3), so they land on the beat instead of
  // just after it.
  if (beat) {
    hud.flashBeat(beat.isDownbeat, clock.bpm === null ? 500 : 60_000 / clock.bpm);
    conductor.fire('beat', ctx);

    if (beat.isDownbeat) {
      conductor.fire('bar', ctx);
      bank.countBar();
    }

    if (beat.isPhraseStart) {
      conductor.fire('phrase', ctx);
      bank.countPhrase();

      // Preset changes land on a phrase boundary — arriving on the 1 of a new 16 is what
      // makes a switch read as intentional rather than as something going wrong. One path
      // whether the change came from the timer or from you clicking it.
      if (bank.takeNext()) applyPreset();
      hud.setPresetState(bank.current.name, bank.pending);

      // Queued text goes live on the same boundary, through the same one-path rule.
      if (takePendingText()) typesetNext();
    }
  }

  conductor.tick(ctx);
  stage.updateScroll(dt);

  hud.countFrame(now);
  hud.tick(now);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// --- keys ------------------------------------------------------------------------------

window.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    event.preventDefault();
    window.olib.showControl();
    return;
  }

  if (event.code === 'Space') {
    event.preventDefault();
    clock.tap(performance.now());
    hud.setBpm(clock.bpm);
    hud.setSource(clock.source);
    hud.setConfidence(clock.confidence);
    return;
  }

  // Hand the grid back to detection without waiting for a track change.
  if (event.key === 'Escape' && clock.isManual) {
    event.preventDefault();
    clock.releaseManual();
    hud.setSource('detected');
    return;
  }
});

function el(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}
