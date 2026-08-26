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

/**
 * Surface anything that escapes, rather than leaving a dead-looking window with no clue why.
 * DESIGN.md §14 — never fail silently.
 *
 * Registered here, before anything else can throw, and guarded because the HUD does not exist
 * yet at this point. There used to be a second pair further down that did the same job with the
 * HUD attached, which meant every error was reported twice and the file was long enough that
 * nobody noticed.
 */
function surface(message: string, detail: unknown): void {
  console.error('[olib]', detail ?? message);
  try {
    hud?.setStatus(`Error: ${message}`, true);
  } catch {
    // Thrown before the HUD was built. The console line above is the whole report.
  }
}

window.addEventListener('error', (event) => surface(event.message, event.error));
window.addEventListener('unhandledrejection', (event) =>
  surface(String(event.reason), event.reason),
);
import { Stage } from './render/Stage';
import { EngineBridge } from './ipc/EngineBridge';
import { Sources } from './audio/Sources';
import { Analyser } from './audio/Analyser';
import { AppCapture } from './audio/AppCapture';
import { APP_PREFIX } from './ipc/protocol';
import { BANDS, type BandName } from './audio/bands';
import { BeatTracker } from './time/BeatTracker';
import { KickHistory } from './time/KickHistory';
import { Clock } from './time/Clock';
import { TextPool } from './text/TextPool';
import { Typesetter, type BlockMotion, type ContentMotion } from './text/Typesetter';
import { randomRange } from './util/random';
import prologueRaw from '../presets/text/prologue.txt?raw';
import { Conductor, type Lane } from './show/Conductor';
import { PresetStore } from './show/PresetStore';
import type { PresetDoc } from './ipc/protocol';
import type { VisualPreset } from './show/presets';
import { PresetBank } from './show/PresetBank';
import { type EffectContext } from './effects/types';
import { Channels } from './show/Channels';
import { Layer, type LayerSpec } from './show/Layer';
import { PALETTES } from './render/palette';
import { Look } from './show/Look';
import { FULL, intersect, normalise, type Mask } from './show/mask';
import { blockedMessage, motionOptions, needsRetypeset, textsForBlocks } from './show/wiring';

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
const tracker = new BeatTracker();
const kicks = new KickHistory();
const clock = new Clock();
const typesetter = new Typesetter(stage);
const conductor = new Conductor();
const channels = new Channels();

/**
 * Let channel writes reach a seamless conveyor's duplicate elements.
 *
 * Wired once: the lookup reads whatever pairing the typesetter holds now, and that is
 * replaced on every typeset.
 *
 * Without this the copy carries no treatments at all — the original scrolls past lit and its
 * replacement arrives plain, so every wrap looks like the colour dropping out. Which is
 * precisely what it was doing.
 */
channels.setMirror((el) => typesetter.twinsOf(el));
/**
 * Capture, and the sensitivities it is read with (§8). Reports through the bridge, which is
 * the only part of it the engine has an opinion about.
 */
const sources = new Sources({
  status: (message, isError) => hud.setStatus(message, isError),
  devices: (options, activeId) => hud.setDevices(options, activeId),
  apps: (list) => hud.setApps(list),
  sensitivity: (band, value) => hud.setSensitivity(band, value),
});

window.olib.apps.onPcm((chunk) => sources.acceptPcm(chunk));
void sources.start();

const store = new PresetStore();
const bank = new PresetBank(store.resolve());

/** Phrases the current text has been on screen. Drives `retext` holds and `whenHolding`. */
let textAge = 0;

/**
 * Seconds since the previous frame, shared with the effect context.
 *
 * Layer decay is derived from elapsed time rather than counted per frame, which is what
 * stops a fade running twice as fast at 60fps as at 30 (§11.5).
 *
 * Declared here rather than beside the frame loop because `applyPreset` runs during module
 * setup and builds an effect context — reading this while it was still in the temporal dead
 * zone threw before anything was on screen.
 */
let frameDelta = 0;

/**
 * Stage background. Transparent is for compositing over other layers in OBS (§13.3) — the
 * text colour flips to white with it, since black type over arbitrary video is unreadable.
 */
/** Background, palette and the global mask — the frame, rather than any preset (§13.3.1). */
const look = new Look(stage, {
  background: (mode) => hud.setBackground(mode),
  palette: (name) => hud.setPalette(name),
  mask: (mask) => hud.setMask(mask),
  retypeset: () => typesetNext(),
});
look.apply();

hud.setSource('none');
hud.setBpm(null);
hud.setConfidence(null);
hud.setCrop(stage.cropRect());

// --- text -----------------------------------------------------------------------------

/** What is on the stage, and the texts presets have pinned (§7.1, §11.7). */
const texts = new TextPool(
  {
    status: (message, isError) => hud.setStatus(message, isError),
    list: (active, pending) => hud.setTextList(active, pending),
  },
  (name) => window.olib.texts.read(name),
);

/**
 * Resolve a preset's text list to one text per block.
 *
 * `'default'` is a reference to the menu selection rather than a filename, so it is looked up
 * fresh each time and keeps following the menu as it changes. Each block rolls independently,
 * which is what puts two different passages side by side (§11.7).
 */
/**
 * Where this preset may anchor (§11.6).
 *
 * The overlap, and nothing else. **The global mask is absolute** — it is the VJ's statement
 * about tonight's frame, and a preset cannot widen it, work around it, or fall back past it.
 * A preset's own mask can only narrow it further.
 *
 * So an empty overlap means the preset genuinely cannot be placed, and the honest response is
 * to say so rather than to quietly substitute a placement nobody asked for.
 */
function effectiveMask(spawn: Mask): Mask {
  return intersect(look.mask, spawn);
}

/**
 * Say which mask has left a preset nowhere to go.
 *
 * Named plainly, and with the tab to fix it in. The two grids look identical and sit one tab
 * apart, so a message that only says "no space" sends you to widen whichever one you happen to
 * be looking at — which half the time is the one that was never the problem.
 *
 * Three cases, because there are three ways to end up with no cells:
 *
 * - the global mask is empty, so nothing at all can be placed;
 * - the preset's own grid is empty, so only this preset is affected;
 * - both have cells but they do not overlap, which is the global mask being absolute (§11.6).
 *
 * Said once per preset rather than every phrase: a sticky error repeating every few bars would
 * bury the capture readout for something that has not changed since it was reported.
 */
let blockedPreset = '';

function reportBlocked(name: string, spawn: Mask): void {
  if (name === blockedPreset) return;
  blockedPreset = name;

  if (name === '') {
    hud.clearError();
    return;
  }

  const message = blockedMessage(name, spawn, look.mask);
  if (message !== null) hud.setStatus(message, true);
}

/** Render the current preset's text selection. */
function typesetNext(): void {
  const preset = bank.current;

  typesetter.render(textsForBlocks(preset.texts, preset.text.blocks, texts.current, texts.byName), {
    slice: preset.text.slice,
    splitChars: preset.text.splitChars,
    take: preset.text.take,
    length: preset.text.length,
    pick: preset.text.pick,
    position: preset.text.position,
    blocks: preset.text.blocks,
    mask: effectiveMask(preset.spawn),
    shapes: preset.blockShapes,
    align: preset.align,
    flow: preset.flow,
    avoidOverlap: preset.avoidOverlap,
    offset: preset.offset,
    wholeLines: preset.wholeLines,
    ...motionOptions(preset.layers),
    size: preset.text.size,
    ...(preset.text.varyBy ? { varyBy: preset.text.varyBy } : {}),
  });

  // The tracked elements no longer exist after a re-render.
  channels.forget();
  textAge = 0;

  // New blocks mean new animations, and they start at the nominal rate rather than the live
  // one. Cheap: a handful of animations, a few times a minute.
  stage.syncMotion();

  // The text's settled look, applied to the elements that were just built. Before any beat
  // has landed, so a static layer is underneath whatever the music adds rather than fighting
  // it for the same channel.
  conductor.fire('typeset', effectContext());

  hud.setClipped(typesetter.clipped);

  reportBlocked(
    typesetter.unplaceable ? bank.current.name : '',
    typesetter.unplaceable ? preset.spawn : FULL,
  );
}

/**
 * Switch preset: load its bindings, apply its sizing, and re-typeset.
 *
 * Everything a preset changes happens in one place, so a preset can never be half-applied —
 * new bindings running against text selected by the previous one.
 */
function applyPreset(): void {
  const preset = bank.current;

  // Layers are constructed here rather than stored on the preset, because a layer's id is
  // its ownership token in `Channels` and has to be unique to the *running* stack. Building
  // them per activation also means an edited preset takes effect on the next cycle without
  // any invalidation logic.
  conductor.load({
    layers: preset.layers.map((spec, index) => new Layer(index, spec)),
    bindings: preset.bindings,
    ...(preset.ambient ? { ambient: preset.ambient } : {}),
  });

  // The outgoing preset's layers own values on elements that are about to be re-typeset
  // anyway, but a preset change that does not re-typeset would otherwise leave them lit
  // with nothing left to decay them.
  channels.clearAll();

  hud.setPresetState(preset.name, bank.pending);
  // Base size is rolled by the typesetter now, from the preset's range (§11.5).

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
    bank.all.map((p) => ({ name: p.name, energy: p.energy, enabled: bank.isEnabled(p.name) })),
  );
  hud.setPresetDocs(store.all);
  void texts.load(store.all);
}

/**
 * Apply an edited document. DESIGN.md §11.4, "two speeds of change".
 *
 * A parameter moves **immediately** — waiting a phrase would make a slider feel broken. A
 * structural change waits for the next phrase, because it is a decision rather than an
 * adjustment. The control window does not have to know which it sent: the difference is
 * visible here, by comparing what actually changed.
 */
function applyEdit(doc: PresetDoc): void {
  const before = store.find(doc.name);
  if (!before || !store.update(doc)) return;

  bank.replace(store.resolve());
  publishPresets();

  // Only the live preset has anything running to update. Editing one that is not on stage
  // is already done — it will be built fresh when it goes live.
  if (bank.current.name !== doc.name) return;

  if (needsRetypeset(before, doc)) {
    // Placement and text settings are only visible in a re-typeset, so there is nothing to
    // do in place — and doing it now rather than at the phrase is what makes dragging the
    // block-shape numbers legible.
    applyPreset();
    return;
  }

  retuneLayers(doc);
}

/** Whether anything that only a re-typeset can show has changed. */
/**
 * Push new layer settings into the running stack.
 *
 * Where the shape of the stack is unchanged — same count, same treatments, same order — the
 * `Layer` objects are updated **in place**. That matters more than it looks: a layer's id is
 * its ownership token in `Channels`, so rebuilding the stack orphans every value currently
 * lit and the stage flashes. Dragging a slider would strobe.
 *
 * When the shape *has* changed, rebuilding is unavoidable and the orphaned values are
 * cleared deliberately rather than left to decay against owners that no longer exist.
 */
function retuneLayers(doc: PresetDoc): void {
  const live = conductor.layers;
  const sameShape =
    live.length === doc.layers.length &&
    live.every((layer, i) => layer.spec.treatment === doc.layers[i]?.treatment);

  if (sameShape) {
    live.forEach((layer, i) => {
      const spec = doc.layers[i];
      if (spec) layer.update(spec);
    });
    return;
  }

  applyPreset();
}

publishPresets();

applyPreset();

/**
 * Load saved presets, then re-apply.
 *
 * Started after the first `applyPreset` rather than before it, so the stage has something on
 * it while the folder is read. A blank canvas during startup is indistinguishable from a
 * failure to launch.
 */
void (async () => {
  await store.load();
  bank.replace(store.resolve());
  await texts.load(store.all);
  publishPresets();
  applyPreset();

  for (const problem of store.problems) hud.setStatus(problem, true);
})();

// Anything still unsaved when the window goes away would be lost — the debounce is 600ms and
// closing the app is faster than that.
window.addEventListener('beforeunload', () => void store.flush());

/** Built fresh each frame so effects always see current levels. */
function effectContext(): EffectContext {
  return {
    stage,
    typesetter,
    channels,
    energy: sources.analyser?.energy ?? 0,
    bass: sources.analyser?.bass ?? 0,
    palette: PALETTES[look.palette],
    beatPhase: clock.phase(performance.now()),
    textAge,
    dt: frameDelta,
    // The smoothed tempo, not the raw estimate, so decay agrees with what is on screen.
    barSeconds: stage.barSeconds,
    retext: typesetNext,
  };
}

// --- audio ---------------------------------------------------------------------------

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
      void sources.openDevice(command.id);
      break;

    case 'setAppSource':
      void sources.openApp(command.processId, command.title);
      break;

    case 'setSensitivity':
      sources.setSensitivity(command.band, command.value);
      break;

    case 'setPalette':
      look.setPalette(command.name);
      break;

    case 'setMask':
      look.setMask(command.mask);
      break;

    case 'setBackground':
      look.setBackground(command.mode);
      break;

    case 'queuePreset':
      bank.queue(command.name);
      hud.setPresetState(bank.current.name, bank.pending);
      break;

    case 'updatePreset':
      applyEdit(command.doc);
      break;

    case 'createPreset': {
      const created = store.create(command.from);
      bank.replace(store.resolve());
      bank.setEnabled(created.name, true);
      publishPresets();
      // Queued rather than applied: a new preset arriving mid-phrase would read as a fault,
      // and §11.2 says every preset change goes through the same door.
      bank.queue(created.name);
      hud.setPresetState(bank.current.name, bank.pending);
      break;
    }

    case 'deletePreset':
      if (store.remove(command.name)) {
        bank.replace(store.resolve());
        publishPresets();
        hud.setPresetState(bank.current.name, bank.pending);
      } else {
        hud.setStatus('Cannot delete the last preset', true);
      }
      break;

    case 'renamePreset': {
      const renamed = store.rename(command.from, command.to);
      if (renamed !== null) {
        bank.replace(store.resolve());
        publishPresets();
        hud.setPresetState(bank.current.name, bank.pending);
      }
      break;
    }

    case 'restorePresetDefaults':
      void (async () => {
        await store.restoreDefaults();
        bank.replace(store.resolve());
        publishPresets();
        applyPreset();
        hud.setStatus('Built-in presets restored');
      })();
      break;

    case 'setPresetEnabled':
      bank.setEnabled(command.name, command.enabled);
      publishPresets();
      break;

    case 'applyText':
      texts.queue(command.name, command.content);
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

/** Throttles the capture readout, which is rewritten with a peak level as it changes. */
let lastStatusAt = 0;

let lastFrameAt = performance.now();


function frame(now: number): void {
  // Clamped: after a stall, a huge delta would teleport the scroll rather than continuing
  // it, and would clear a layer in one step rather than fading it.
  const dt = Math.min((now - lastFrameAt) / 1000, 0.1);
  frameDelta = dt;
  lastFrameAt = now;

  // Advance the grid before building the context. Anything derived from musical position —
  // beat phase, text age — has to be current when effects read it, and the phrase handler
  // below mutates text age.
  const beat = clock.update(now);
  if (beat?.isPhraseStart === true) textAge++;

  // Hand the stage the tempo the visual should be moving at, and let it chase. A tap and a
  // detected estimate both arrive here, and both can move a long way in one step (§11.5).
  stage.setTargetBar(clock.bpm === null ? 2 : (60 / clock.bpm) * 4);
  stage.tick(dt);

  const ctx = effectContext();

  const analyser = sources.analyser;
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

    // Kept separately from the tracker's envelope: the tracker wants everything periodic, and
    // this wants only the thing that actually carries the tempo (§9.2.4).
    kicks.push(now, bands.kick?.flux ?? 0);
    if (bands.kick?.onset === true) kicks.pushOnset(now);

    const estimate = tracker.estimate(now);
    if (estimate) {
      hud.setEstimate(estimate.bpm);
      clock.apply(estimate, {
        authority: kicks.authority,
        agreementFor: (periodMs) => kicks.agreement(periodMs, now),
      });
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
      hud.setStatus(`Capturing · ${sources.captureLabel} · peak ${db}`);
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

      // `held` fires only where the text was *not* replaced this phrase — static text for
      // two phrases needs more happening to it, or the second phrase reads as a stall.
      //
      // It has to be dispatched with a *fresh* context. `ctx` is a snapshot taken at the
      // top of the frame, so its `textAge` still holds the pre-phrase value; re-reading it
      // after the phrase bindings is the only way to see whether `retext` fired. This is
      // what `whenHolding` got wrong: it read the stale snapshot and so fired on the
      // replacement phrase as well as on held ones, despite a comment insisting that
      // ordering within the lane prevented exactly that.
      if (textAge >= 1) conductor.fire('held', effectContext());

      bank.countPhrase();

      // Preset changes land on a phrase boundary — arriving on the 1 of a new 16 is what
      // makes a switch read as intentional rather than as something going wrong. One path
      // whether the change came from the timer or from you clicking it.
      if (bank.takeNext()) applyPreset();
      hud.setPresetState(bank.current.name, bank.pending);

      // Queued text goes live on the same boundary, through the same one-path rule.
      if (texts.takePending()) typesetNext();
    }
  }

  conductor.tick(ctx);

  // Hide lines a moving block has carried half out of frame. No layout reads — it works from
  // the translation the animation has already applied.
  typesetter.trimLines();

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
