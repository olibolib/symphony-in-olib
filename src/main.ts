import './types';
import { Stage } from './render/Stage';
import { Hud } from './hud/Hud';
import { AudioInput, SYSTEM_SOURCE_ID } from './audio/AudioInput';
import { Analyser } from './audio/Analyser';
import { BANDS, type BandName } from './audio/bands';
import { BeatTracker } from './time/BeatTracker';
import { Clock } from './time/Clock';
import { parseText } from './text/TextSource';
import { Typesetter, type TextMode } from './text/Typesetter';
import { randomRange } from './util/random';
import prologueRaw from '../presets/text/prologue.txt?raw';
import { Conductor, type Lane } from './show/Conductor';
import { PRESETS } from './show/presets';
import { PresetBank } from './show/PresetBank';
import { GlitchState, type EffectContext } from './effects/types';
import type { BackgroundMode } from './hud/Hud';
import { PALETTES, type PaletteName } from './render/palette';
import { LAYOUT_SETS, type LayoutSetName } from './show/layouts';

/**
 * Increment 1 complete.
 *
 * Audio in, tempo out, a predicted beat grid driving lanes, lanes driving effects, and a
 * bank of presets cycling on phrase boundaries so it runs unattended.
 */

const stage = new Stage(el('#stage'), el('#container'));
const hud = new Hud();
const input = new AudioInput();
const tracker = new BeatTracker();
const clock = new Clock();
const typesetter = new Typesetter(stage);
const prologue = parseText('prologue', prologueRaw);
const conductor = new Conductor();
const glitches = new GlitchState();
const bank = new PresetBank(PRESETS);

/** Phrases the current text has been on screen. Drives `retext` holds and `whenHolding`. */
let textAge = 0;

let analyser: Analyser | null = null;
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

hud.onSensitivityChange = (band, value) => {
  sensitivities[band] = value;
  localStorage.setItem(SENS_KEY, JSON.stringify(sensitivities));
  analyser?.setSensitivity(band, value);
};

/**
 * Stage background. Transparent is for compositing over other layers in OBS (§13.3) — the
 * text colour flips to white with it, since black type over arbitrary video is unreadable.
 */
const BG_KEY = 'olib.background';

function applyBackground(mode: BackgroundMode): void {
  document.documentElement.dataset['bg'] = mode;
  stage.backgroundMode = mode;
  localStorage.setItem(BG_KEY, mode);
}

const storedBackground = (localStorage.getItem(BG_KEY) as BackgroundMode | null) ?? 'white';
applyBackground(storedBackground);
hud.setBackgroundMode(storedBackground);
hud.onBackgroundChange = applyBackground;

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

hud.onPaletteChange = (name) => {
  paletteName = name;
  localStorage.setItem(PALETTE_KEY, name);
};

hud.onLayoutSetChange = (name) => {
  layoutSetName = name;
  localStorage.setItem(LAYOUT_KEY, name);
  // Apply immediately rather than waiting for the next bar — if you have just switched to
  // "edges" because text is sitting on your visuals, four beats is too long to wait.
  const options = LAYOUT_SETS[name];
  const next = options[Math.floor(Math.random() * options.length)];
  if (next !== undefined) stage.container.dataset['layout'] = String(next);
};

hud.setSource('none');
hud.setBpm(null);
hud.setConfidence(null);
hud.setCrop(stage.cropRect());
// Base size everything else is a percentage of. Raised from 24: small type is unreadable
// on a projector and gets smeared into mush by a visualiser warping the output.


/** Render the current preset's text selection. */
function typesetNext(): void {
  const preset = bank.current;

  typesetter.render(prologue, {
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

  stage.setFontScale(preset.fontScale);

  // Continuous stage state persists until something sets it, so a preset that does not use
  // pulse or scroll would otherwise inherit whatever the previous one left running — and a
  // pulse with nothing driving it freezes at its last value rather than stopping.
  stage.pulse = 0;
  stage.scrollSpeed = 0;

  typesetNext();
  hud.setPreset(preset.name, preset.energy);
}

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
  hud.setStatus(`Error: ${event.message}`, true);
  hud.showOptions();
});
window.addEventListener('unhandledrejection', (event) => {
  hud.setStatus(`Error: ${String(event.reason)}`, true);
  hud.showOptions();
});

// --- audio ---------------------------------------------------------------------------

async function refreshDevices(): Promise<void> {
  const options = await input.list();
  hud.setDevices(options, input.activeId ?? AudioInput.remembered() ?? SYSTEM_SOURCE_ID);
}

async function startCapture(id: string): Promise<void> {
  try {
    hud.setStatus('Opening…');
    analyser?.close();
    analyser = null;

    const stream = await input.open(id);
    const next = new Analyser(stream);
    await next.resume();
    for (const band of BANDS) next.setSensitivity(band.name, sensitivityFor(band.name));
    analyser = next;

    captureLabel = `${input.activeTrackLabel ?? 'unknown source'} · ${next.sampleRate / 1000} kHz`;
    hud.setStatus(`Capturing · ${captureLabel}`);
    await refreshDevices();
  } catch (error) {
    // DESIGN.md §14: never fail silently, never take the app down.
    const message = error instanceof Error ? error.message : String(error);
    hud.setStatus(`Could not open source — ${message}`, true);
    hud.showOptions();
  }
}

hud.onDeviceChange = (id) => void startCapture(id);
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
    hud.showOptions();
    return;
  }

  await startCapture(AudioInput.remembered() ?? SYSTEM_SOURCE_ID);
})();

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
    hud.flashBeat(beat.isDownbeat);
    conductor.fire('beat', ctx);

    if (beat.isDownbeat) {
      conductor.fire('bar', ctx);
      bank.countBar();
    }

    if (beat.isPhraseStart) {
      conductor.fire('phrase', ctx);
      bank.countPhrase();

      // Preset changes land on a phrase boundary — arriving on the 1 of a new 16 is what
      // makes a switch read as intentional rather than as something going wrong.
      if (bank.due) {
        bank.advance();
        applyPreset();
      }
    }
  }

  conductor.tick(ctx);
  stage.updateScroll(dt);

  hud.countFrame(now);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// --- keys ------------------------------------------------------------------------------

window.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    event.preventDefault();
    hud.toggle();
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
