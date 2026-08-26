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
import { KickHistory } from './time/KickHistory';
import { Clock } from './time/Clock';
import { parseText, type TextPreset } from './text/TextSource';
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
type BackgroundMode = 'white' | 'black' | 'transparent';
import { PALETTES, type PaletteName } from './render/palette';
import { anchors, FULL, intersect, normalise, type Mask } from './show/mask';

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
/**
 * Also read by an inline script in `index.html`, which applies the mode before the first
 * paint. Change one and change the other, or launching flashes white.
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
 * Palette and the global spawn mask. Both exist for compositing over other visuals:
 * saturated accents clash with whatever is underneath, and text landing on the subject of
 * the frame is the fastest way to spoil it.
 */
const PALETTE_KEY = 'olib.palette';
const MASK_KEY = 'olib.mask';

let paletteName = (localStorage.getItem(PALETTE_KEY) as PaletteName | null) ?? 'acid';

/**
 * Where text may anchor, whatever a preset asks for (§11.6).
 *
 * Defaults to everything allowed: a mask is a constraint the VJ adds for tonight's video,
 * and starting with one already applied would be the app inventing a restriction nobody
 * asked for. The presets carry their own, and the two are intersected.
 */
let globalMask: Mask = readMask();

function readMask(): Mask {
  const saved = localStorage.getItem(MASK_KEY);
  if (saved === null) return FULL;
  try {
    return normalise(JSON.parse(saved) as Mask);
  } catch {
    // A corrupt setting must not stop the app starting. Falling back to "everywhere" is
    // visible and recoverable; failing to launch is not (§14).
    return FULL;
  }
}

hud.setPalette(paletteName);
stage.setPalette(PALETTES[paletteName]);
hud.setMask(globalMask);

function setPalette(name: PaletteName): void {
  paletteName = name;
  localStorage.setItem(PALETTE_KEY, name);
  hud.setPalette(name);

  // Applied at once. Choosing a palette is a deliberate act, like switching the background —
  // unlike the old periodic shifting, which changed colours nobody had asked to change.
  stage.setPalette(PALETTES[name]);
}

/**
 * Apply a new global mask.
 *
 * Re-typesets immediately rather than waiting for the next phrase. If you have just excluded
 * a corner because text is sitting on the club's logo, sixteen bars is much too long to
 * wait — the same reasoning the layout set was changed under.
 */
function setMask(mask: Mask): void {
  globalMask = normalise(mask);
  localStorage.setItem(MASK_KEY, JSON.stringify(globalMask));
  hud.setMask(globalMask);
  typesetNext();
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

/**
 * Texts a preset has pinned by name (§11.7), parsed and kept.
 *
 * The engine is handed the *active* text and nothing else — editing lives in the control
 * window (§7.1) — so a preset naming a different text has to fetch it. Read straight from the
 * folder rather than routed through the other window: it is saved content, which is exactly
 * what the engine is allowed to see, and it keeps drafts on the side of the boundary they
 * belong.
 *
 * Loaded ahead of time because typesetting is synchronous and happens on a phrase boundary.
 * Waiting on a file read there would mean a missed phrase.
 */
const pinnedTexts = new Map<string, TextPreset>();

/** Names that could not be loaded, so the warning is given once rather than every phrase. */
const missingTexts = new Set<string>();

async function loadPinnedTexts(): Promise<void> {
  const wanted = new Set<string>();
  for (const doc of store.all) {
    for (const name of doc.texts) if (name !== 'default') wanted.add(name);
  }

  for (const name of wanted) {
    if (pinnedTexts.has(name) || missingTexts.has(name)) continue;
    try {
      pinnedTexts.set(name, parseText(name, await window.olib.texts.read(name)));
    } catch {
      // §11.7: a pinned name will eventually not resolve — a text renamed or deleted outside
      // the app, or a preset imported from someone else. Say so and fall back; nothing should
      // vanish because a file was renamed in October.
      missingTexts.add(name);
      hud.setStatus(`Text "${name}" is missing — presets using it fall back`, true);
    }
  }

  // A text that has come back should stop being treated as missing.
  for (const name of Array.from(missingTexts)) {
    if (!wanted.has(name)) missingTexts.delete(name);
  }
}

/**
 * Resolve a preset's text list to one text per block.
 *
 * `'default'` is a reference to the menu selection rather than a filename, so it is looked up
 * fresh each time and keeps following the menu as it changes. Each block rolls independently,
 * which is what puts two different passages side by side (§11.7).
 */
function textsForBlocks(preset: VisualPreset, blocks: number): readonly TextPreset[] {
  const options = preset.texts.length > 0 ? preset.texts : ['default'];

  const resolve = (name: string): TextPreset =>
    name === 'default' ? activeText : (pinnedTexts.get(name) ?? activeText);

  const out: TextPreset[] = [];
  for (let i = 0; i < blocks; i++) {
    out.push(resolve(options[Math.floor(Math.random() * options.length)] ?? 'default'));
  }
  return out;
}

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
  return intersect(globalMask, spawn);
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

  if (anchors(globalMask).length === 0) {
    hud.setStatus(
      'The global mask has no cells, so nothing can be placed — allow some in the Canvas tab',
      true,
    );
    return;
  }

  if (anchors(normalise(spawn)).length === 0) {
    hud.setStatus(
      `"${name}" has no cells of its own — allow it some in the Presets tab`,
      true,
    );
    return;
  }

  hud.setStatus(
    `The global mask is blocking "${name}" — allow it some cells in the Canvas tab`,
    true,
  );
}

/**
 * Pull the motion settings out of the layer list.
 *
 * Motion is authored as a layer so a preset is described in one place, but it is applied by
 * the typesetter rather than by writing to elements — so it has to be found again here.
 *
 * **The last one wins**, which is the same rule channels follow: layers are ordered and later
 * ones sit on top. Two scroll layers is not a sensible preset, but it is an easy one to end up
 * with while experimenting, and silently using the first would be the surprising answer.
 */
function motionOptions(layers: readonly LayerSpec[]): {
  contentMotion?: ContentMotion;
  blockMotion?: BlockMotion;
} {
  let content: ContentMotion | undefined;
  let block: BlockMotion | undefined;

  for (const layer of layers) {
    const motion = layer.motion;
    if (!motion || motion.speed <= 0) continue;

    if (layer.treatment === 'scroll' && (motion.direction === 'up' || motion.direction === 'down')) {
      content = {
        direction: motion.direction,
        speed: motion.speed,
        continuous: motion.continuous !== false,
      };
    } else if (layer.treatment === 'travel') {
      // Only the axis being travelled along can wrap, so the other toggle is simply not
      // consulted — it is there for when the direction changes.
      const sideways = motion.direction === 'left' || motion.direction === 'right';
      block = {
        direction: motion.direction,
        speed: motion.speed,
        continuous: (sideways ? motion.wrapSide : motion.wrapTop) !== false,
      };
    }
  }

  return {
    ...(content ? { contentMotion: content } : {}),
    ...(block ? { blockMotion: block } : {}),
  };
}

/** Render the current preset's text selection. */
function typesetNext(): void {
  const preset = bank.current;

  typesetter.render(textsForBlocks(preset, preset.text.blocks), {
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
  void loadPinnedTexts();
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

  if (layoutChanged(before, doc)) {
    // Placement and text settings are only visible in a re-typeset, so there is nothing to
    // do in place — and doing it now rather than at the phrase is what makes dragging the
    // block-shape numbers legible.
    applyPreset();
    return;
  }

  retuneLayers(doc);
}

/** Whether anything that only a re-typeset can show has changed. */
function layoutChanged(before: PresetDoc, after: PresetDoc): boolean {
  return (
    JSON.stringify(before.text) !== JSON.stringify(after.text) ||
    JSON.stringify(before.spawn) !== JSON.stringify(after.spawn) ||
    JSON.stringify(before.blockShapes) !== JSON.stringify(after.blockShapes) ||
    before.align !== after.align ||
    before.flow !== after.flow ||
    before.avoidOverlap !== after.avoidOverlap
  );
}

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
  await loadPinnedTexts();
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
    energy: analyser?.energy ?? 0,
    bass: analyser?.bass ?? 0,
    palette: PALETTES[paletteName],
    beatPhase: clock.phase(performance.now()),
    textAge,
    dt: frameDelta,
    // The smoothed tempo, not the raw estimate, so decay agrees with what is on screen.
    barSeconds: stage.barSeconds,
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

    case 'setMask':
      setMask(command.mask);
      break;

    case 'setBackground':
      applyBackground(command.mode);
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
      if (takePendingText()) typesetNext();
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
