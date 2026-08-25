# Symphony in Olib — Design Document

**Status:** draft · **Last updated:** 2026-08-20

---

## 1. What this is

A **live VJ tool for DJs**. It listens to whatever audio is playing on the machine,
detects the beat, and generates a reactive typographic visual in the style of
[Symphony in Acid](../SymphonyInAcid) — which you capture in OBS and put on your stream.

It is not a composed piece. Acid was one artwork welded to one track, with every visual
event hand-transcribed from a MIDI file. This is a machine that does something similar to
*any* audio, driven by presets rather than a timeline.

**Primary user:** a DJ streaming a set, running DJ software full-screen on a single
monitor, who wants a visual that runs itself for two hours without being touched.

### The shape of a session

1. Launch the app. Pick an audio source from a dropdown.
2. Pick a text preset and a starting visual preset.
3. Alt-tab to rekordbox / Traktor / whatever. Never touch it again.
4. OBS window-captures it, cropped to the stage.

Everything in this document follows from that. The tool has to be **autonomous** —
the user cannot be relied upon to be looking at it, focusing it, or fixing it.

---

## 2. Goals

1. **DJ-software agnostic.** rekordbox, Traktor, Serato, Ableton, a CDJ with no laptop, or
   Spotify. If it makes sound, it works.
2. **Autonomous.** Set it up, walk away. It must never need attention mid-set.
3. **Unbreakable.** No white screens, no freezes, no crashes. Degrading gracefully beats
   being correct.
4. **Preset-driven.** Text and visuals are both prepared in advance and selected, never
   authored live.
5. **Clean capture.** The output is a fixed-size, fixed-aspect rectangle with no UI in it.
6. **Acid's visual language.** The look is the point; the generality is the mechanism.

## 3. Non-goals

- Hosting. This is not a website. It ships as an installed app.
- Cross-browser or cross-platform support. Windows, one Chromium, no compatibility matrix.
- Live text entry. Text is prepared in files, selected at runtime.
- Authored timelines. Nothing is pinned to a bar number, because we don't know the track.
- Musical structure understanding beyond energy and pulse. No key detection, no genre
  classification, no automatic verse/chorus segmentation.

---

## 4. Vocabulary

| Term | Meaning |
|---|---|
| **Stage** | The fixed-resolution rectangle the visual renders into. What OBS captures. |
| **HUD** | Status readout and settings, outside the stage. Never captured. |
| **Clock** | Tempo and beat phase. Where "the beat is now" comes from. |
| **Band** | A frequency range of the spectrum, e.g. 60–120 Hz. |
| **Lane** | A named event channel — `kick`, `snare`, `hat`, `beat`, `bar`, `phrase`. |
| **Visual preset** | A bundle: a stack of layers, placement, palette, intensity. |
| **Text preset** | A prepared body of text plus how it gets selected and displayed. |
| **Effect** | A named visual operation. Being split into **target** and **treatment** (§11.5). |
| **Layer** | One target, one treatment, its triggers and its decay. Presets are stacks of these (§11.5). |
| **Target** | Which elements a layer touches — a string to match, a proportion or a count of a slice. |
| **Treatment** | What visually happens to them — `invert`, `accent`, `dingbat`, `swell`. |
| **Channel** | A CSS property a treatment writes. Layers on different channels compose (§11.5). |
| **Slot** | An abstract attribute value (`glitch="3"`) whose *appearance* the preset's CSS defines. |

---

## 5. Platform and distribution

**Electron app, Windows, Chromium.** Not a hosted web page.

This was a late decision and it removed a lot of accidental complexity. What it bought:

| Problem | Browser answer | Electron answer |
|---|---|---|
| Background throttling while covered by DJ software | Chrome launch flags in a `.bat` | `backgroundThrottling: false` |
| Window with no tabs or address bar | `--app=` launcher trick | it's just a window |
| System audio without a virtual cable | impossible — needs Stereo Mix / VB-Cable | native desktop loopback capture |
| Permission prompts mid-set | unavoidable | granted programmatically |
| Transparent output for OBS compositing | impossible | `transparent: true` |
| Browser compatibility | a matrix to support | one known Chromium |

It also puts Node in reach, which keeps **Ableton Link** viable later (see §9.5) — that was
a dead end in the browser.

### 5.1 Chromium switches in use

| Switch | Why |
|---|---|
| `disable-renderer-backgrounding` | Keep rendering while covered by DJ software |
| `disable-background-timer-throttling` | As above, for timers |
| `disable-backgrounding-occluded-windows` | As above, for the occluded case specifically — the normal state for this app |
| `autoplay-policy: no-user-gesture-required` | Come up already capturing. There is nobody there to click |
| `disable-features: AllowWgcScreenCapturer` | Insurance: Windows Graphics Capture fails `E_ACCESSDENIED` on some machines (§8.1) |

`backgroundThrottling: false` is also set per-window. Redundant with the switches, and kept
because the failure mode — a frozen visual on a live stream — is worth the belt and braces.

The cost is a ~150 MB build and a packaging step. For a VJ tool that is normal; everything
else in the category is an installed app.

**The codebase stays a plain web app.** No Electron-specific APIs in the engine, only at
the edges (capture, window, file access). If we ever want it in a browser again, that
should be a packaging change and not a rewrite.

---

## 6. Background: what we take from Acid

Acid works, and the parts worth keeping are real. The problem is only that the music and
the piece are welded into the code.

### Kept

| Idea | Why |
|---|---|
| **DOM as the canvas** | Real text nodes get browser layout, reflow, `columns`, flexbox. It's what makes it feel like a document coming apart rather than a graphics demo. |
| **Attribute slots** | `[glitch="3"]`, `[layout="21"]`, `[decor="6"]` — one attribute flip restyles thousands of elements in CSS with no per-element JS. Fast, and the *meaning* lives in the preset's CSS. |
| **Word/char tokenization** | Splitting to glyph level is what enables per-character effects. |
| **Pixel sampling for colour** | Sampling a video frame at each element's screen position to colour it. The most interesting technique in the project, and it generalises (§13). |
| **Palette reseating** | Narrowing to ~3 active colours per scene keeps it coherent instead of confetti. |

### Replaced

| File | Size | Problem |
|---|---|---|
| `stems.js` | 2,496 lines | Hand-transcribed MIDI map keyed to frame numbers at a hardcoded 30fps. Belongs to one mp3. |
| `react.js` | 968 lines | One function, an if/else chain over `SCENE == 1..25`. Adding a scene means editing the chain. |
| `story.css` | 640 lines | Selectors like `#container[scene="17"]` — the look is bound to a scene *index*. |
| p5.js + jQuery | ~1 MB | Loaded for about a dozen helpers. Replaceable in a few dozen lines. |

### Two bugs not to inherit

- **Forced synchronous reflow.** `colorRGBFromMedia` calls `getBoundingClientRect()` and then
  immediately writes a style, inside a loop over every element on screen. Classic layout
  thrash, and the main frame-rate ceiling in the original. See §14.
- **Silent failure.** Effects that hit an empty element list just do nothing, with no signal.
  Fine for a fixed piece that was tested end to end; bad for a generative tool.

---

## 7. Architecture

```
  audio device / system loopback
              │
              ▼
      ┌───────────────┐
      │  AudioInput   │  device list, capture, AudioContext graph
      └───────┬───────┘
              ▼
      ┌───────────────┐
      │   Analyser    │  FFT → band energy + spectral flux
      └───────┬───────┘
              ▼
      ┌───────────────┐
      │  BeatTracker  │  tempo + phase + confidence
      └───────┬───────┘
              ▼
      ┌───────────────┐
      │     Clock     │  beat · bar · phrase, tap override
      └───────┬───────┘
              ▼
      ┌───────────────┐
      │   Conductor   │  lanes → effects · preset cycling
      └───────┬───────┘
              │  Event stream
              ▼
      ┌───────────────┐
      │   Renderer    │  Stage · Typesetter · DOM
      └───────────────┘
```

**One-way flow.** Each stage consumes the one above and knows nothing below it. The
Conductor emits an **event stream** — `beat`, `bar`, `phrase`, lane hits, preset changes,
level updates — and the Renderer consumes it.

That seam is deliberate. It costs nothing now, and it is what makes two later things cheap:
a separate output window, and feeding an OBS browser source over a socket (§13.3). If the
Renderer ever reaches back into the Conductor, both become refactors.

### Class model

```
App
├── AudioInput      device enumeration, capture, AudioContext
├── Analyser        bands, levels, onsets
├── BeatTracker     tempo/phase estimation, confidence, re-lock
├── Clock           beat/bar/phrase position; tap override
├── Conductor       lane dispatch, preset scheduling
│   ├── PresetBank  visual presets
│   └── TextBank    text presets
├── Renderer
│   ├── Stage       fixed-resolution root; attribute slots live here
│   └── Typesetter  text → paragraphs → words → chars → DOM
├── EffectRegistry  named, parameterized visual operations
└── Hud             readouts, settings, tap, crop values
```

### 7.1 Two windows

**Built.** Branch `two-window-hud`.

The HUD is currently welded to the canvas in one window. That worked, and produced two
workarounds it should not have needed: a transparent gap so an OBS crop had margin for error,
and a fixed window height so hiding the HUD did not move the capture geometry. Splitting them
removes both.

```
Output window     1280x720, frameless, transparent. The canvas, nothing else.
                  OBS captures it whole — no crop at all.

Control window    Ordinary resizable window. The HUD. Any size, any monitor,
                  optionally always-on-top. Minimises to the tray.
```

**The engine runs in the output window.** Its whole job is mutating DOM text, so it lives
where that DOM is. The control window is a view and an input surface.

#### What that costs

The HUD is currently driven by direct calls — `setBpm`, `flashBeat`, `setBands`. Across a
process boundary those become messages, and at 60fps there are far too many.

So **the HUD stops being a bag of setters and becomes a function of a state snapshot**: one
batched message per tick, meters throttled to about 20Hz because nobody reads a bar chart
sixty times a second, with beats and preset changes sent as discrete events.

> **Divergence from the plan.** `Hud` was *not* rewritten. The control window keeps it and
> adapts the snapshot into the existing setters, because rewriting it at the same time as
> introducing a process boundary would have meant debugging two new things at once. The
> snapshot arrives batched and throttled as intended; only the last step is still imperative.
> The panel system (§7.2) replaces `Hud` entirely, so this is a way-station rather than a
> decision.

The message protocol is a discriminated union shared by both windows — commands one way,
state and events the other. One of the clearer places TypeScript earns its keep, since both
ends are checked against the same definition.

#### What was built

| Piece | Where |
|---|---|
| `src/ipc/protocol.ts` | The contract. `EngineState`, `EngineEvent`, `ControlCommand` — both windows are checked against it |
| `src/ipc/EngineBridge.ts` | The engine's side. Mirrors the old `Hud` method names, so forty call sites changed by one identifier rather than being rewritten |
| `src/control.ts` | The control window's entry point |
| `control.html` | Its document. `index.html` is now the canvas and nothing else |

**Ownership moved with the split.** `TextBank` lives in the *control* window now: drafts, one
level of undo and the file list never need to cross the boundary, and the engine only ever
receives finished content via `applyText`. That is the split falling out naturally — editing
is a control concern, rendering is an engine one.

**The canvas window ignores the mouse.** A frameless transparent window otherwise swallows
every pointer event over its rectangle, making it an invisible hole in the desktop. It has no
interactive content now that the HUD has left.

**Placement is typed, not dragged** (§13.5). Frameless means no title bar, so the Canvas tab
carries width, height, x, y, presets and centre-on-screen. Exact numbers also reproduce on
every launch, which matters when OBS is pointed at the window.

#### Decisions taken

| Question | Decision |
|---|---|
| Closing the control window | Minimises to the tray; the show keeps running |
| Bringing it back | Tray icon menu. **Not** a menu bar on the canvas window — that window is on the stream, and even an auto-hidden menu bar appears on Alt |
| Keyboard | Only when the control window has focus. One place to control from, and no question about which window received a key |
| Always-on-top | A toggle, on the control window |
| Single-window mode | Not kept. Two modes means two layouts and two sets of bugs |
| Catching up | The control window requests a full state snapshot on open, rather than only listening for changes. Retrofitting that is much worse than designing it in |
| Stale window positions | Restored bounds are clamped to the displays currently attached. Saving a position on a second monitor, unplugging it, and finding the window unreachable is a bug worth never shipping |
| Tray | Built. Show control window, always-on-top toggle, centre canvas, quit. Icon copied via `extraResources`, since `build/` is build resources and is not inside the installed app |

### 7.2 The panel system

Everything in the control window is a **panel** — including the readouts. Consistency was the
argument: a fixed header plus movable panels would mean two mechanisms and a rule to remember.

Panels **float** inside the control window rather than tiling: each has a position and a size,
a grab at the top-left to move it, and a grab at the bottom-right to resize. Dropping one onto
another **merges them into a tabbed group**, which is how the layout stays usable when the
window is small.

> **Assumption to confirm.** Floating, not tiled. The sketch shows boxes with gaps between
> them and a corner resize grab, which is a floating-window gesture — in a tiled layout you
> would drag the boundary *between* two panels instead. Floating is also considerably simpler
> to build, since there is no split tree to keep balanced.

#### Model

```ts
/** What panels exist. A registry, so the View menu can list them. */
interface PanelSpec {
  readonly id: PanelId;          // 'readouts' | 'audio' | 'text' | 'effects' | ...
  readonly title: string;
  readonly minWidth: number;
  readonly minHeight: number;
}

/** A floating box. Holds one panel, or several shown as tabs. */
interface GroupState {
  readonly id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  panels: PanelId[];
  active: PanelId;
}

interface HudLayout {
  groups: GroupState[];
  /** Closed from the View menu. Not deleted — restorable. */
  hidden: PanelId[];
}
```

Panels are objects implementing an interface, not subclasses:

```ts
interface Panel {
  readonly spec: PanelSpec;
  mount(host: HTMLElement): void;
  update(state: HudState): void;   // called from the state snapshot
  dispose(): void;
}
```

That keeps the codebase's existing property — **no inheritance anywhere** (§ object model) —
while being fully object-based. Composition and interfaces, not a base class.

#### Classes

| Class | Owns |
|---|---|
| `PanelRegistry` | Which panels exist and how to construct them |
| `HudLayoutModel` | The group list. Every mutation — move, resize, merge, split out, close, restore — goes through it, so minimum sizes and clamping are enforced in one place |
| `HudDock` | The view: renders groups, handles pointer interaction, draws the drop preview |

#### The parts that will be fiddly

Hand-rolled rather than using a docking library, deliberately. These are where the time will
go, so they are worth naming before starting rather than discovering:

- **Drop-target detection.** Deciding, while dragging, which group the pointer is over and
  whether the gesture means "join as a tab" or "drop beside". Needs a live preview overlay or
  it feels like guessing.
- **Dragging the last panel out of a group.** The group must disappear and not leave an empty
  box behind. Most docking bugs live in this transition.
- **Minimum sizes composing.** A group's minimum is the largest minimum of the panels in it,
  so merging two panels can force a group to grow.
- **Restoring a layout that references a panel that no longer exists.** Drop it, say so, and
  carry on — never throw, never silently omit.
- **Clamping.** Panels must not be draggable off the edge of the control window, and must
  survive the window being resized smaller than the layout.

### 7.3 State that persists

One JSON file in the app-data folder, alongside the texts and (later) the presets.

Settings currently live in eight separate `localStorage` keys — device, palette, layout set,
background, sensitivities, enabled presets, active text, crash flag. Those move into the same
file. One inspectable, hand-editable, backup-able place, consistent with how everything else
is stored.

```
config.json
  windows      bounds for both windows, always-on-top flag
  hud          the panel layout (§7.2)
  audio        device id, per-band sensitivities
  show         palette, layout set, background mode, enabled presets, active text
```

---

## 8. Audio input

A dropdown listing, from `enumerateDevices()`:

- every real input device (interfaces, mics, loopback devices, Stereo Mix if present)
- **plus "System output"**, via Electron's desktop loopback capture

That second entry is the important one — it means capturing your master out needs no
virtual cable, no Stereo Mix, and no screen-share bar. In a plain browser it would have
been impossible.

Selection persists between launches. Device changes are watched (`devicechange`), and if
the active device disappears mid-set the app holds its last state rather than throwing.

> **Q1.** Should it try to auto-reconnect to a device that reappears, or stay stopped until
> you pick again? Auto-reconnect is friendlier but could grab the wrong source silently.

### 8.1 Platform notes

Loopback capture on Windows has three traps in it. All three were hit during Increment 1;
all three are silent or misleading when you hit them.

| Trap | Symptom | Rule |
|---|---|---|
| Legacy `chromeMediaSource: 'desktop'` constraint used for audio with `video: false` | Renderer terminated by the browser process (`bad_message` 263). Black window, no JS error — the renderer never runs any code to report | Never use the legacy constraint. Use `getDisplayMedia` with a main-process handler |
| Requesting a video track alongside loopback audio | Windows Graphics Capture tries to open the monitor and fails `E_ACCESSDENIED` (`0x80070005`), taking the audio with it | Answer the request with `{ audio: 'loopback' }` and no video source |
| Stopping the video track to save CPU, if one exists | Audio silently stops — Chromium ties the capture session to the video track | Shrink it (2×2 @ 1fps), never stop it |

Two consequences beyond the fixes themselves, both now implemented:

- **A renderer can die outright**, and the result is a permanently black window. `render-process-gone`
  reloads it. Mid-set, that is the difference between a two-second glitch and a dead stream.
- **A source that kills the renderer would be retried on every launch**, and with automatic
  reload that is an infinite loop. The source being opened is flagged in `localStorage` and
  cleared on success; a flag surviving a restart means the last attempt didn't, so it is not
  retried automatically.

**Routing caveat:** Windows loopback taps the *default output device*. A DJ setup sending its
master over ASIO straight to an interface bypasses that entirely, and there will be nothing to
capture. In that case the answer is a device-level loopback input, not code.

### 8.2 Per-application capture

**Working.** Verified 2026-08-25 against Traktor Pro 4: 186 KB/s, peak -0.1 dB, first data
156ms after start.

#### The problem it solves

Capturing a *named* output device — the S4's Main/Booth, say — is impossible through web
APIs. `getUserMedia` only reaches input endpoints; `getDisplayMedia` loopback taps only the
Windows **default** playback device.

Which leaves "make your booth output the Windows default", and that is not acceptable for a
DJ: every notification ping would go through the PA.

#### What it does instead

Windows **process loopback** (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, Windows 10
2004+) captures one application's output. You pick *Traktor*, not a device — which is how you
think about it anyway, and it means the capture follows the application whatever device it is
routed to, with nothing else mixed in.

**No native module.** The `application-loopback` package ships helper executables and talks to
them over stdout, so there is no C++ toolchain, no node-gyp, and no ABI matching against
Electron. This was the deciding factor; a native addon would have been the same cost as the
Spout sender we deferred for exactly that reason.

#### The audio path

```
helper.exe → stdout → main → IPC → AudioWorkletNode → the existing AnalyserNode
```

The helper emits 16-bit stereo 48kHz PCM. A worklet stands in for the missing `MediaStream`,
and `Analyser` was widened to accept either a stream or a node — so bands, flux, onsets, the
tracker and the clock are **completely unchanged**. Only the source differs.

The context runs at 48kHz to match the helper, so nothing is resampled on the way in and the
FFT bin arithmetic stays honest.

#### The limitation

**Process loopback goes through the Windows audio engine. ASIO bypasses it entirely.**

An application driving its interface over ASIO produces no capturable stream at all. Traktor
here is on WDM, which is why it works; a rekordbox user on a Pioneer controller may well be on
ASIO and would need one of the other sources.

So this is one option among several, not a replacement:

| Source | Works when |
|---|---|
| **Application** | The application uses the Windows audio engine |
| System output | Your mix is the Windows default device |
| Input device | A loopback input, Stereo Mix, or a virtual cable exists |

**No audio for four seconds is reported as a likely ASIO problem**, not left as a dead meter.
"Capturing silence" and "capturing nothing" look identical otherwise, and they have completely
different causes.

#### Two traps, both pre-empted

- **The worklet was being inlined as a `data:` URL** by Vite, being under the 4KB threshold.
  `audioWorklet.addModule` is inconsistent about accepting those. Inlining is off.
- **Executables cannot be spawned from inside `app.asar`.** `asarUnpack` plus
  `setExecutablesRoot` handle it. Without them this works in development and fails only in the
  installed build.

`scripts/spike-loopback.mjs` is kept as a diagnostic: it lists capturable windows and reports
whether real audio arrives from one, which answers the ASIO question for any machine in about
ten seconds.

---

## 9. Tempo and beat detection

The hardest part of the project, and the only source of timing. There is no MIDI clock, no
Link, no manual timeline — it is audio or nothing.

### 9.1 Why this is tractable

DJ mixes are close to the best case for beat detection: a strong 4/4 kick, near-constant
tempo within a track, and electronic material with sharp transients. It would be much
harder on jazz, orchestral, or anything rubato.

### 9.2 Method

1. **FFT** at `fftSize: 2048` — roughly 21.5 Hz per bin at 44.1 kHz. The AnalyserNode's own
   smoothing is switched off; it averages across frames, which is exactly what flux needs
   *not* to happen. Levels are smoothed separately, downstream.
2. **Spectral flux** per band: the sum of positive magnitude changes since the previous
   frame. Rising energy only, since that is what a transient is.
3. **Onset detection** — four gates, described in §9.2.1.
4. **Tempo** by autocorrelating the onset envelope over roughly a 6-second window, searching
   lags in the 60–180 BPM range.
5. **Octave correction.** Autocorrelation happily reports half or double tempo. Compare the
   candidate against its half and double, prefer the one whose pulse train aligns better
   with observed onsets, and break remaining ties toward the 120–140 range that most dance
   music sits in.
6. **Phase** by correlating the onset envelope against a pulse train at the chosen tempo and
   taking the best offset.
7. **Confidence** from the sharpness of the autocorrelation peak and its margin over the
   runner-up. Published to the HUD.

### 9.2.1 Onset gates

*Built in Increment 1. Every gate here exists because the version without it failed on real
records.*

A transient must clear all four:

| Gate | Test | Why |
|---|---|---|
| **Shape** | Flux is a local peak | A kick is a spike; a pad swelling or a sub rising is a ramp. Both can be large, only one is an onset. Costs one frame of latency to confirm the value turned over |
| **Statistics** | Above `mean + k × stddev` over ~3s | Catches "unusual for this track right now" |
| **Magnitude** | At least ~28% of the band's recent peak flux | Catches "actually a hit, not merely unusual" |
| **Timing** | Past the refractory period, and re-armed since the last onset | Stops sustained energy re-triggering forever |

Three findings worth keeping, all of them things that were wrong first:

**The statistics window must span bars, not beats.** At 0.7s — about a beat and a half at
128 BPM — the statistics are made almost entirely of the kicks themselves, so when the kick
drops out mean and deviation collapse within a second and the detector becomes *most*
sensitive exactly when there is nothing to detect. Three seconds spans several bars and
survives a breakdown.

**Threshold on deviation, not on the mean.** `mean × k` is cleared constantly by
steady-state signal, because music always has *some* energy in every band. What marks a
transient is flux jumping outside its own recent spread.

**Statistics alone cannot tell you a value is big.** A sub swell in a breakdown is
statistically remarkable and musically nothing. The magnitude gate is measured against the
band's own recent peak, so it self-calibrates across loud and quiet records with no tuning.

**Sensitivity (`k`) is a live control**, adjustable per band from the HUD and persisted.
Defaults are empirical: kick 4.0, snare 2.0, hat 2.2.

### 9.2.2 The kick/bass problem

**Accepted, not solved.** In 40–120 Hz a kick and a synth bass note are not meaningfully
different — a bass note has a real attack transient in exactly the band the kick occupies.
The detector is not being fooled; both *are* onsets. Any threshold that reliably rejects the
synth will eventually reject a soft kick too.

Two reasons this does not block the project:

- **Beat tracking does not need a clean stream.** Autocorrelation looks for periodicity, and
  extra onsets between the kicks are noise it can reject as long as the real kicks are there.
  A twitchy indicator looks worse than it tracks.
- **Visually, a bass stab firing an effect is not wrong** for a VJ tool. It is still a
  musical event.

If it ever needs to be better, the discriminator to reach for is simultaneous energy higher
up: a bass note usually carries harmonics into 150–400 Hz at the moment of attack, where a
kick is concentrated much lower. Real, but more machinery, and it misfires on clicky kicks.

### 9.2.3 Known issue: tempo accuracy

**Open, deferred.** Tempo lands within a few percent but is not exact — a 126 BPM house
track reads a stable 120, and DnB at 174 reads 171. The octave is correct and the reading is
stable, which is what matters most; the residual error is a systematic slight underestimate.

Accepted for now because the Clock re-anchors phase four times a second, so beats land close
with small periodic corrections rather than sliding away. Good enough to drive visuals.

Things already tried, none of which fixed it:

| Change | Effect |
|---|---|
| One-octave search window | Fixed half-time errors. Not this |
| Correlation-curve smoothing across estimates | Fixed the wandering. Not this |
| Parabolic sub-sample interpolation | Removed lag quantisation. Not this |
| Detrending (1s moving average) + half-wave rectification | Expected to fix it. Did not |
| Log compression of flux on input | No observable change |
| Raising the Clock's track-change threshold 0.04 → 0.12 | Real bug — the clock was refusing corrections — but not the whole story |

**Next step is instrumentation, not another hypothesis.** Two rounds were spent reasoning
about a signal neither of us can see. Before touching the algorithm again, plot the
correlation curve (score against BPM) in the HUD. If the true peak is visible but losing, the
fault is in peak selection; if the curve peaks in the wrong place, the fault is in the
envelope. That distinction is currently unobservable, which is why this stalled.

### 9.3 Prediction, not reaction

Once locked, **beats are generated from the grid, not from onsets.** Detection only
corrects phase drift, and slowly.

This matters more than it sounds. Reacting to a detected transient is always late by the
length of the analysis window, and on a projector that reads as sloppy. Predicting from a
locked grid lets us land exactly on the beat, or deliberately a little ahead of it. It is
the difference between "roughly moving with the music" and "locked".

It also means the visual keeps running smoothly through a passage with no clear transients,
instead of stalling.

### 9.4 Failure and recovery

- **Low confidence** → keep the previous grid, keep running, show it in the HUD. Never stop.
- **Track change** — detected by a sustained tempo shift or a large spectral discontinuity —
  → re-lock.
- **Silence** → hold the last grid and keep animating. A gap between tracks must not reset
  the visual.
- **Tap tempo (space)** → manual override. The first tap sets the downbeat, the intervals set
  the tempo. Manual wins until a track change is detected, then auto resumes.

Bars assume 4/4. Phrases are 4 and 16 bars. The downbeat is a guess until corrected by
energy patterns or a tap — and for a visualizer, landing on the *beat* matters much more
than knowing which bar you are in.

> **Q2.** How aggressive should auto-resume after a tap be? If someone taps because
> detection is consistently wrong on a track, having it silently take back control at the
> next mix could be annoying. An explicit "hold manual" toggle in the HUD might be worth it.

### 9.5 Later: Ableton Link

Electron puts Node in reach, so a native Link binding becomes possible. That would give
exact tempo *and* downbeat from rekordbox and Serato — the thing MIDI clock never could.
Long-term, behind the same `Clock` interface, so nothing downstream changes.

---

## 10. Lanes

Lanes are named event channels. Effects bind to lanes; lanes are fed by analysis or by the
grid.

| Lane | Source |
|---|---|
| `kick` | Low-band onset (~40–120 Hz) |
| `snare` | Mid-band onset (~150–600 Hz) |
| `hat` | High-band onset (~4–12 kHz) |
| `beat` | Predicted grid |
| `bar` | Predicted grid, every 4 beats |
| `phrase` | Predicted grid, every 16 bars |
| `energy` | Continuous 0–1 overall level, not an event |
| `bass` | Continuous 0–1 low-band level |

Continuous lanes drive intensity — how many elements an effect touches, how fast decay
runs. Event lanes drive discrete hits.

### 10.1 Structure detection

*Increment 4. Recorded here because the preset model (§11.1) depends on it.*

The obvious approach — watch overall volume for drops and breakdowns — **does not work on DJ
material.** Masters are limited to within an inch of 0 dBFS, so a breakdown and a drop have
near-identical RMS. Loudness is the one thing mastering removes.

What changes is *where* the energy sits. A breakdown strips out the kick and bass; a drop
slams them back. So the signal is **low-band energy**, tracked against its own rolling
average, not overall level.

| State | Signal |
|---|---|
| **Breakdown** | Bass falls below ~40% of its rolling average and stays there past ~2 bars |
| **Drop** | Bass returns after a breakdown, snapped to the nearest phrase boundary |
| **Build** | High-band energy and onset density climbing while bass is still absent — risers, snare rolls |

Breakdown and drop are cheap and reliable: an envelope with hysteresis over band data we
already compute. Build is the flaky one and should be treated as a hint, never a trigger.

---

## 11. Presets

### 11.1 The split

**Text presets hold content. Visual presets hold everything else** — including *how* text
is selected and displayed.

This keeps the two independent: swap the text without touching the look, swap the look
without touching the text. Acid tied the two together per scene, which is why its scenes
could not be reordered.

**Presets do not own the palette or the layout set.** Those are user settings in the HUD
(§13.3.1), chosen according to what the output is being composited over. A preset overriding
them would silently undo a decision made for a reason that the preset cannot know about.

```ts
interface TextPreset {
  name: string;
  source: string;          // path to a .txt file
}

interface VisualPreset {
  // As built. §11.4 to §11.7 replace most of this — layers instead of bindings,
  // a spawn mask instead of `layout`, per-preset texts, decay per layer in bars.
  name: string;
  layout: string;          // → [layout="grid"] on the stage
  columns?: number | 'auto';
  fontScale: number;
  splitChars: boolean;     // one element per glyph, or per word
  textMode: TextMode;      // how much text, selected how (§12.3)
  palette: string;
  decay: number;           // how fast glitches fall back to normal

  bindings: Partial<Record<Lane, EffectRef[]>>;   // discrete hits
  ambient?: EffectRef[];                          // every frame, intensity-scaled

  energy: 'sparse' | 'mid' | 'peak' | 'any';   // which section it suits (§10.1)
  minBars?: number;        // don't cycle away from this one too early
}
```

### 11.2 Cycling

Two mechanisms, layered.

**The timer** is the floor: cycle after a randomised 16–32 bars so it never goes static, and
never feels metronomic. Changes land on a **phrase boundary**, never mid-phrase — arriving on
the 1 of a new 16 is what makes a switch feel intentional rather than random.

**Text holds for one phrase or two**, chosen fresh each time rather than on a fixed
schedule. A fixed hold is legible but predictable: you begin anticipating the change, which
is exactly what a generative visual should not allow. A longer hold also gives a downstream
visualiser (§13.4) time to develop its warp before the thing it is warping disappears.

When the text does hold, the preset compensates — see `whenHolding` in §12.2.1.

**Structure events** override the timer. A detected drop forces a change immediately and
resets the counter; a breakdown switches to a sparse preset. This is Increment 4 — the timer
alone carries the MVP — but the preset model accounts for it now so it isn't a retrofit.

The `energy` tag is what makes the override work. Without it a breakdown could cycle into the
densest preset in the bank, which is exactly backwards. The selector picks from presets whose
tag suits the current section.

A preset is not repeated until the bank has been exhausted or a minimum gap has passed.
Manual override, when it exists (Increment 5), always wins.

### 11.3 Where presets live

Visual presets are code — they reference effects and CSS, so they are part of the build.
Text presets are plain `.txt` files loaded at runtime.

> **Q4.** Should text presets be a fixed bundled set, or a folder the user drops files into
> and the app scans? The second is barely more work and much more useful, but it means
> deciding where that folder lives.

---

### 11.4 Editable presets

**Planned, not built. Now the highest priority** — see the note below.

> **Why this moved up.** Used in a real set on 2026-08-21, with the DJ software on auto and
> the app left running. It worked: capture held, the beat tracked, the visual ran unattended
> for the length of the set. The one thing that did not hold up was **the presets themselves**
> — some were not effective, and there was no way to adjust them without a rebuild.
>
> That is the first priority change in this project driven by use rather than by reasoning,
> and it beat every guess that was ahead of it. MIDI pads and the panel system both dropped
> below it: hands-on control and a nicer interface are worth less than material that works.

Recorded before it is built because it changes what an effect *is*, and the longer that goes
unwritten the more code assumes the current shape.

The goal: take one of the built-in presets, open it, see what it is made of, tune each part
with a slider, add and remove parts, and save the result. Presets become editable objects
rather than compiled-in constants.

**§11.5 to §11.7 describe what is being made editable**, and they are the larger half of this
change: effects pulled apart into combinable pieces, placement moved to a spawn grid, and text
assignable per preset. Reviewed and agreed 2026-08-25.

#### The problem with today's effects

Effects are closures (§12.2). That is a good fit for how they are used *now* — authored in
TypeScript, checked by the compiler, composed with `whenHolding`. But a closure is **opaque**:
you cannot ask it its name, and you cannot ask it what parameters it has.

Two consequences, and both block this feature outright:

- **No UI can be generated for them.** A slider for `glitchWords.amount` requires knowing that
  the parameter exists, its range, and its current value. None of that survives into a closure.
- **They do not serialise.** A preset's `bindings` field contains functions, so a preset cannot
  be written to a file. Text presets are editable precisely because they are just strings.

It is also the one place the codebase is inconsistent with itself: everything that owns state
is a class, and effects are functions.

#### The shape

An effect becomes a class plus a **definition** describing its tunable surface. The definition
is what the UI reads; the class is what runs.

```ts
/** One tunable parameter, described well enough for a control to be built from it. */
interface ParamSpec {
  readonly key: string;
  readonly label: string;
  readonly kind: 'number' | 'integer' | 'boolean' | 'choice';
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly choices?: readonly string[];
  readonly fallback: number | boolean | string;
}

/** Registered once per effect type. The registry maps id to this. */
interface EffectDefinition {
  readonly id: string;            // 'glitchWords'
  readonly label: string;         // 'Glitch words'
  readonly params: readonly ParamSpec[];
  /** Container effects (whenHolding) accept children; leaf effects do not. */
  readonly acceptsChildren?: boolean;
  create(values: ParamValues, children?: readonly Effect[]): Effect;
}

abstract class Effect {
  constructor(protected values: ParamValues) {}
  abstract apply(ctx: EffectContext): void;
  /** Live tuning — the instance is mutated in place. */
  set(key: string, value: unknown): void;
  toJSON(): EffectData;
}
```

`Conductor` changes by one line: `effect.apply(ctx)` instead of `effect(ctx)`. Nothing else in
the dispatch path is affected.

#### Presets as data

```ts
interface PresetData {
  name: string;
  energy: EnergyTag;

  /** Names, not content — see §11.7. Empty means "follow the text menu". */
  texts: string[];

  text: {
    slice: Slice;
    count: number;
    splitChars: boolean;
    blocks: 1 | 2 | 3;
    /** Base size in px, rolled once per typeset (§11.5). */
    size: { min: number; max: number };
    varyBy?: Slice;
  };

  /** Where blocks may anchor, and how big they are (§11.6). */
  spawn: string[];
  /** In cells. Rolled per block, per typeset. min === max for a fixed shape. */
  blockSize: {
    cols: { min: number; max: number };
    rows: { min: number; max: number };
  };
  align: 'left' | 'centre' | 'right' | 'justify';
  flow: 'stack' | 'run-on' | 'grid' | 'wrapped' | 'columns';

  /** The Lego. Order matters: later layers sit on top (§11.5). */
  layers: LayerData[];

  /** Stage-wide: palette, background, pulse, colour movement. */
  stage: EffectData[];
}

interface LayerData {
  treatment: string;
  target: TargetData;
  triggers: Partial<Record<Lane, boolean>>;
  /** Bars to fade. 0 means it stays until re-typeset. */
  decayBars: number;
  amount: number;
  follow?: 'energy' | 'bass';
  /** Only read by size treatments. */
  size?: { min: number; max: number };
}

interface EffectData {
  id: string;
  values: Record<string, number | boolean | string>;
  children?: EffectData[];   // whenHolding and anything else that wraps
}
```

Which makes a preset a JSON file, stored the same way texts are (§11.3) — a writable app-data
folder, seeded with the built-ins on first run. `PresetBank` grows the shape `TextBank`
already has: list, load, edit, apply, revert, save.

**Container effects need the `children` field.** `whenHolding([...])` wraps other effects, and
a flat list of ids and values cannot express that. Easy to overlook until it is the one thing
that will not round-trip. Layers do not need it — a layer is flat by construction, which is
one of the quieter benefits of the split.

#### Two speeds of change

A rule worth fixing now, because it is not obvious:

| Change | When it takes effect |
|---|---|
| Moving a parameter slider | **Immediately.** The instance is mutated; the next `fire` uses the new value |
| Adding, removing or reordering effects; switching preset | **Next phrase** (§11.2) |

A parameter is a continuous adjustment, like the onset sensitivity sliders — waiting for a
phrase would make it feel broken. A structural change is a decision, and those land on the 1.

#### Sketch of the UI

Inside the Effects tab, per preset:

```
scatter                                          [live]  [→]
  text     prologue, default                            [edit]
  spawn    ▓▓▓▓▓▓▓   cols 1 ●──● 3   align left
           ▓▓▓▓▓▓▓   rows 2 ●────● 5   flow stack
           ▓▓···▓▓
           ▓▓···▓▓
           ▓▓···▓▓
           ▓▓▓▓▓▓▓
           ▓▓▓▓▓▓▓
  layers                                    kick snare hat
    accent    12% of words    ──●─────  1.0   ■    □    □   [x]
    invert    every "e"       ─────●──  1.0   □    ■    □   [x]
    dingbat   1 word          ──●─────  0.8   □    □    ■   [x]
    swell     3 words   0.9 ●──────● 1.5      ■    □    □   [x]
  + add layer
```

One row per layer, a dropdown per axis, a slider for amount, a checkbox per trigger, and a
two-handle range where the treatment takes one. The grid is clickable and drag-selectable.

#### Open risks

- **Ranges must be enforced by the `ParamSpec`, not by taste.** `glitchWords` at `amount: 1`
  glitches every word on screen — a white-out mid-set. The spec's `max` is a safety rail.
- **A preset with nothing bound to a firing lane is a silent no-op.** Same class of failure as
  §14 warns about: the Effects tab should show whether a binding is actually firing, not just
  that it exists.
- **Saved presets can reference an effect id that no longer exists** after a rename. Loading
  must drop the unknown effect and say so, rather than throwing or silently omitting it.
#### Decided

**Built-in presets are editable directly.** No automatic fork, no "Save as" step — the
built-ins are ordinary presets that happen to ship with the app.

The safety net is re-seeding rather than forking: because the built-ins are seeded into the
folder on first run from a compiled-in copy, **"Restore defaults" can always put them back**.
That gives the same guarantee a fork would, without a second copy of everything appearing in
the list the first time you move a slider.

**Everything becomes data, including the built-ins.** They are JSON in the presets folder like
any other, not a special compiled case. Consistency was the deciding argument: two mechanisms
for the same concept means two code paths, two failure modes, and a rule to remember about
which kind of preset you are looking at.

**The cost, stated plainly.** Today a mistyped effect parameter is a compile error — that is
what caught six stale text-mode names in an afternoon during Increment 1. Moving values to
`Record<string, unknown>` gives that up unless something replaces it. Two things do:

- **Derive the value types from the definitions.** Declaring `params` with `as const` lets
  TypeScript map a `ParamSpec[]` to the value object it describes, so authoring an effect in
  TypeScript stays checked even though its data form is untyped.
- **Validate on load, and report.** Every preset read from disk is checked against its
  effects' `ParamSpec`s: unknown keys, wrong kinds and out-of-range numbers are corrected to
  the `fallback` and *named in the HUD*. §14 again — a preset that silently loses an effect
  because a value was malformed is the worst version of this.

The compiler stops being the only guard; it becomes the first of two.

---

### 11.5 Effects as composable parts

Agreed 2026-08-25, after the set. This is the change that makes presets worth editing: without
it the editor would only offer sliders on effects that were already the wrong shape.

#### The fault

Every effect today welds two separate decisions together: **which elements** it touches, and
**what it does** to them.

```ts
glitchWords({ amount: 0.05 })   // picks 5% of words AND applies a glitch
glitchChars({})                 // picks every instance of a char AND applies a glitch
```

Both halves of "invert every instance of the letter e" already exist in the codebase —
*every instance of a character* lives in `glitchChars`, *invert* lives in `invertBlock` — and
there is no way to combine them. That is why the presets felt limited in a real set. The knobs
were not the problem; the fixed pairings were.

#### The axes

A **layer** is one choice on each axis. A **preset** is a stack of layers plus its placement,
text and stage settings.

| Axis | Options |
|---|---|
| Target | everything matching a string · a proportion of a slice · exactly N of a slice · every Nth |
| Slice | `char` · `word` · `sentence` · `paragraph` · `block` |
| Treatment | `invert` · `accent` · `dingbat` · `underline` · `strike` · `outline` · `swell` · `flicker` · `blank` |
| Trigger | `kick` · `snare` · `hat` · `beat` · `bar` · `phrase` · `held` · `always` |

Four targets by nine treatments is thirty-six combinations from thirteen primitives, and most
of them cannot be expressed today. The point is not that all thirty-six are good — it is that
you get to find out which ones are.

#### One call shape, for every treatment

The instinct was one `glitch` that dispatches on what you pass it. String versus number works
— `typeof` separates them. **Integer versus float does not**, because JavaScript has one
number type: `glitch(1.0)` *is* `glitch(1)`, and the collision lands on exactly the value you
reach for when you want *all of them*.

So the unit is named rather than encoded in the number's type:

```ts
apply('invert',  'e')                      // every instance of "e"
apply('accent',  { word: '5%' })           // 5% of words
apply('dingbat', { char: '5%' })           // 5% of characters
apply('swell',   { sentence: 1 })          // exactly one sentence
```

A proportion is a **percentage string**, a count is a **number**. No edge case at any value,
and it serialises straight to JSON, which saving requires anyway. The sugar normalises to the
stored `TargetData` form — `{ word: '5%' }` becomes `{ slice: 'word', proportion: 0.05 }`.

> Worth remembering who authors these: presets are built from dropdowns and sliders, not typed
> as function calls. The signature only needs to be good enough for the built-ins defined in
> TypeScript. Optimising call syntax at the cost of an ambiguity would trade the important
> thing for the unimportant one.

#### Channels, so several treatments share one element

Today an element is **one thing at a time** — a single `data-glitch` attribute, so whichever
layer runs last wins. That is a large part of why the presets read flat.

A treatment instead declares which **channels** it writes, and a channel is *a CSS property
being contended for*. Treatments touching different properties compose freely; only a literal
same-property collision resolves, and there the later layer wins.

| Treatment | Channels |
|---|---|
| `invert` | `bg` + `fg` |
| `accent` | `fg` |
| `dingbat` | `font` |
| `underline` / `strike` | `deco` |
| `outline` | `outline` |
| `swell` | `size` |
| `flicker` | `anim` |
| `blank` | `vis` |

```html
<!-- four layers landed on this word, all of them visible -->
<w data-bg="invert" data-fg="accent" data-deco="underline" data-size="swell">
```

**Because channels follow CSS properties rather than treatment names, `invert` and `accent`
compose.** Invert writes `bg` and `fg`; a later accent overwrites only `fg`. The result is a
black block with accent-coloured text — not currently reachable at all, and it falls out of
the model rather than being a special case.

#### Ownership, so decay does not clear what it no longer owns

Per-layer decay means each layer clears its own elements at its own rate. But a layer may have
been overwritten since it tagged something, and must not then clear a value belonging to
someone else. So each channel records who set it:

```html
<w data-fg="accent" data-fg-by="4">
```

Layer 4's decay only clears elements where `data-fg-by` is still `4`. If a later layer has
taken that channel, layer 4 finds it is no longer the owner, drops the element from its own
set, and leaves the attribute alone.

**The ownership lives on the element, not in a map.** The DOM is replaced wholesale on every
re-typeset, and a central registry would need invalidating each time; attributes vanish with
the elements that carried them. Self-healing, and the decay loop stays proportional to what is
actually lit.

#### Four beats is the unit for everything the audience sees

> **Anything visible is measured in bars. Anything the DSP does stays in seconds.**

| Measured in bars | Stays in seconds |
|---|---|
| Motion speed — fractions of the box per 4 beats | Onset refractory (~110ms) |
| Layer decay | Flux history window (3s) |
| Flicker rate | Correlation envelope (8s) |
| Pulse | Tempo re-estimate interval |
| Preset cycling, text holds | Status message timeouts |

The line is not arbitrary. The DSP measures *physical* properties — a drum transient is about
a tenth of a second whatever the tempo, and a correlation window needs a fixed span of signal
to work on. Tying those to the grid would make the detector change behaviour with the music it
is trying to detect, which is circular.

Everything above the grid should re-time itself when you change record. A fade that takes a
bar takes a bar at 128 and at 174.

**This also fixes a bug that is in the code now.** Decay currently clears a fixed fraction of
lit elements *per frame*, so it runs twice as fast at 60fps as at 30 — the visual quietly
changes character when the machine gets busy. Expressed in bars it becomes both tempo-relative
and frame-rate independent, because the per-frame probability is derived from elapsed time
rather than assumed: `p = 1 - (1 - f) ^ (dt / barSeconds)`.

#### Size, in two kinds

Every other treatment is a switch — a word is inverted or it is not. Size is a *quantity*, and
an unbounded quantity driven by live audio will eventually find a value that ruins the frame.

**Reactive size** is the `swell` treatment, and it carries a range:

```ts
{ treatment: 'swell', target: { slice: 'word', proportion: 0.1 },
  size: { min: 0.7, max: 1.6 }, follow: 'bass' }
```

Both ends earn their place. The maximum stops a word overrunning the block; the minimum stops
it shrinking past legibility on a projector at the back of the room. The range is also what
makes `follow` mean anything — quiet sits at `min`, a peak reaches `max`.

**Base size** is not a layer. It is how big the text is, and it should not need a trigger or a
decay to set it. It lives on `text`, is rolled once at typeset and never touched again:

```ts
size: { min: 40, max: 40 }                    // uniform, as `fontScale` is now
size: { min: 28, max: 52 }, varyBy: 'word'    // every word its own size
size: { min: 28, max: 52 }, varyBy: 'char'    // ransom-note
```

Without `varyBy` the block picks one size and everything matches; with it, each word or
character rolls its own.

#### Which settles reflow

| | Mechanism | Reflows? | When |
|---|---|---|---|
| Base size | `font-size` | Yes — and that is correct | Once, at typeset |
| Reactive swell | `transform: scale()` | No | On triggers, many times a bar |

Base size *should* reflow: uneven word sizes need the line to re-wrap around them or the text
overlaps itself, and it happens once so the cost is invisible. Reactive swell must not, because
re-wrapping a paragraph several times a bar reads as broken rather than as an effect.

They compose in that order: `font-size` sets the element's real box, `transform` scales what is
already there without disturbing the layout around it. Inline elements need
`display: inline-block` to accept a transform at all, which `<w>` and `<c>` can simply carry.

#### Decided

- **Fine-grained channels**, following CSS properties rather than treatment names.
- **Soft limit on layers, with a warning** — never a hard cap, since it would eventually block
  a look that ran fine. The FPS readout (`#r-fps`) already exists and gains thresholds. The
  warning is based on *elements touched per second*, not layer count: four layers on 30% of
  characters is far heavier than ten on one word each, and a preset knows that number before it
  renders a frame.
- **`flicker` stays a treatment**, authored identically to the rest even though it works
  differently underneath: applying it sets the `anim` channel and CSS runs the animation, so
  the engine writes one attribute and does nothing per frame. Its rate is in bars — a flicker
  on every eighth sits in the track, one at a fixed 12Hz drifts against it and reads as a
  broken monitor.
- **Per-element motion stays out.** Moving a block is one transform; making individual words
  drift is one per element, and at a few thousand elements that is where the frame rate goes.
  `swell` is not an exception — a transform applied once and left to decay is not per-frame
  animation.
- **The built-ins are ported as they are**, then adjusted from the UI. Redesigning them blind
  is guessing twice, and it keeps the port honest: if a rebuilt preset looks different from the
  current one, the layer engine is wrong, and that is much easier to find while there is still
  something to compare against.

#### Rejected

**Region targets** — `{ slice, where: 'left-half' }`, selecting elements by where they sit in
the frame. Dropped in favour of §11.6, which controls where text *appears* rather than sorting
words by where they landed. Regions needed a layout measurement pass, a position cache with an
invalidation rule, and motion-offset tracking to survive the conveyor; the spawn grid needs
none of that and was what was actually wanted.

---

### 11.6 Placement: the spawn grid

Supersedes §12.4 and §12.4.1.

Placement today is already a grid — a 3x3 with the middle cell removed (`BLOCK_CELLS` in
`Typesetter.ts`). "Avoid the centre" is not a rule in the code; it is one cell missing from a
list. So this is not a new mechanism. It is a finer grid, and letting each preset carry its own
list.

#### The mask

A **7x7 grid**, written as rows of characters so the file shows you the shape:

```
spawn: [           spawn: [           spawn: [
  "#######",         "#######",         "..###..",
  "#######",         "#.....#",         "..###..",
  "##...##",         "#.....#",         "..###..",
  "##...##",         "#.....#",         "..###..",
  "##...##",         "#.....#",         "..###..",
  "#######",         "#.....#",         "..###..",
  "#######",         "#######",         "..###..",
]                  ]                  ]
  keep the middle    edges only         a centre column
  clear — as now                        — not possible today
```

Readable without a tool and it diffs sensibly in git, neither of which is true of coordinates
or a packed bitfield.

**7x7 rather than 5x5.** Odd is required either way — an even grid has no centre cell, and
"keep off the middle" is the one thing this must express well. At 5x5, excluding the middle 3x3
leaves text only on the outermost ring, hard against the frame edge with nowhere else to go. At
7x7 the same exclusion leaves two rings, so you can be clear of the middle *and* off the very
edge, which is the arrangement that actually looks composed.

The cells are not square — on a 16:9 canvas a 7x7 cell is about 2.3 times wider than tall. That
is the right grain: text blocks are wider than they are tall too, so a one-cell-tall strip is a
sensible line of text where a square cell would be an awkward box.

#### A cell is an anchor, not a container

At 3x3 a cell was a third of the stage, so a block could simply be given one. At 7x7 a cell is
14% and text in it would be unreadably cramped — so a block is **anchored** at a cell and sized
separately. The mask says where blocks may start; `blockSize` says how big they are.

#### Width and height are ranges, not numbers

Both are given as a min and a max in cells, and rolled per block on every typeset — the same
treatment base size gets (§11.5), for the same reason: a shape that varies within bounds you
set is a look, where a fixed one is a setting.

```ts
blockSize: { cols: { min: 1, max: 1 }, rows: { min: 4, max: 7 } }   // a tall column
blockSize: { cols: { min: 5, max: 7 }, rows: { min: 1, max: 2 } }   // a wide band
blockSize: { cols: { min: 2, max: 4 }, rows: { min: 2, max: 4 } }   // varies, roughly square
blockSize: { cols: { min: 3, max: 3 }, rows: { min: 2, max: 2 } }   // fixed
```

The non-square cells matter here and work in our favour. A one-column block seven rows tall is
about **14% of the frame wide and the full height** — a genuinely narrow vertical column of
text. A seven-column block one row tall is full width and 14% high — a band. Both are shapes
the 3x3 grid could not produce at all, because a third of the stage is neither narrow nor
short.

**Rolled independently, which is a limitation worth naming.** Wide ranges on both axes give a
rectangle anywhere in the bounding box, so a preset asking for `cols 1–7, rows 1–7` will
sometimes produce a square blob rather than the column or band that was wanted. "Either tall or
wide, never square" is a constraint independent ranges cannot express.

That is deliberate rather than an oversight: the fix is two presets, or a tight range on one
axis, and both are clearer than an `orientation` mode that would need explaining every time it
is read. Reconsider only if the blob turns out to be common in practice.

**Clamped to 1–7, and clipping stays visible.** A tall narrow column holding three sentences
will overflow, and §12.4.1's rule still applies — the block clips and the count is reported,
rather than text quietly going missing.

**A block may extend past the mask, and that is deliberate.** The alternative — requiring the
whole block to fit inside allowed cells — means the app searches for somewhere it will fit,
silently shrinks it, or refuses to place it. All three are the app second-guessing a decision
already made. If a block anchored next to the centre is sized large enough to cover the centre,
that is an authoring choice with a visible result, and the fix is to change the number.

It is also much less machinery: pick an allowed cell, place a block of the stated size. No
rectangle search, no fit test, no fallback path — which is worth something on its own, because
those are exactly the paths that go wrong at 1am.

**Position clamps to the canvas; size never does.** Overflowing into the middle of the frame is
a look you chose. Overflowing off the *edge* is different — text nobody can see reads as a
fault rather than a decision. So a block that would run off the edge is shifted back until it
fits, keeping every pixel of the size it was given.

#### Two masks, intersected

```
effective = globalMask & presetMask
```

The **global mask** is the VJ's, set once at the start of the night in the canvas tab and
applying to everything — tonight there is a logo bottom-right and nothing should start there.
The **preset mask** is the preset's own composition. A preset can only ever be *more* restricted
than the global rule, never less, so a preset built weeks ago and forgotten cannot start
somewhere ruled out.

**It restricts anchors, so it is a strong default rather than a guarantee.** With anchor
semantics a large enough block can still reach into an excluded cell. That is the right trade
for an authoring tool, but if a hard "never draw here" is ever needed, this is not it — it
would have to be a clip.

**If the intersection is empty the preset is skipped for that cycle, and says so.** That is the
one case with no judgement in it: no allowed cell means nowhere to anchor, and §14 says it must
be visible rather than silent.

#### The layout table is deleted

`LAYOUT_SETS`, `LayoutSetName` and the numbers `0..17` all go. Not migrated, not partly kept.
They are eighteen fixed combinations inherited from Acid, and each one welds together things
this section exists to pull apart: layout 4 is *320% type, tight tracking and line-height 0.82*
as a single indivisible unit; layout 6 is *a six-column outlined grid at 84%*. You cannot have
the grid at a different size, or the tracking without the size. Same fault as `glitchWords`,
same answer.

| Old layouts | What they were | Where that lives now |
|---|---|---|
| 1, 2, 3, 4, 8 | Font size 82–320%, tracking, line-height, italic, alignment | Base size (§11.5) plus `align` |
| 10, 11, 13, 14, 15, 16, 17 | Bands, rails, and the 3x3 block grids | The spawn grid — anchor plus size |
| 5, 6, 7 | Flex-wrap, six-column outlined grid, paragraphs run together | `flow` — the one genuinely new piece |
| 12 | One text flowing through two rails | `flow: 'columns'` on a full-width block |

```ts
block: {
  anchor: /* a cell from the mask */,
  size:   { cols: 3, rows: 2 },
  align:  'left' | 'centre' | 'right' | 'justify',
  flow:   'stack' | 'run-on' | 'grid' | 'wrapped' | 'columns',
}
```

**Four independent settings replace eighteen fixed ones, and they multiply instead of listing.**
Nothing has to be added to a table to get the six-column grid at 300% type in a corner, because
there is no table.

*Lost:* layout 16's alternating alignment — `.block:nth-child(odd) { text-align: right }`, so
corner blocks face outward. That is a relationship between blocks and nothing here stores it.
Small, and worth losing rather than distorting the model; per-block `align` means two blocks can
be given opposite values by hand if it turns out to matter.

**§12.4.2's size floor survives unchanged.** Nothing renders below about 76% of the base size,
for the reasons given there — it is a legibility rule, not a layout one.

---

### 11.7 Text assigned per preset

A preset currently renders whatever the text menu has selected. But some looks are written for
particular words — a preset built around the Prologue is not the same preset with a different
message poured into it. So a preset carries **a list** of texts it may draw from:

```ts
texts: ['default']                             // follows the text menu — as now
texts: ['prologue']                            // always the Prologue
texts: ['prologue', 'tractatus', 'ampersand']  // one of these, per typeset
texts: ['default', 'prologue']                 // the selection, or the Prologue
```

`'default'` is not a filename — it is a *reference to the selection*, so it keeps following the
menu as it changes mid-set. Every preset that exists takes `['default']` and behaves as it does
now; an empty list means the same thing.

Mixing `'default'` with named texts falls out for free and is more useful than it looks:
`['default', 'prologue']` means a preset mostly shows the current selection but drops into the
Prologue every other typeset — recurring words threaded through changing ones, which is a
structural effect rather than a visual one.

#### Names, not content

Storage size is not the concern. The Prologue is 58 lines, about 2KB; twenty presets each naming
five texts is a few kilobytes of JSON, which next to a single icon is nothing.

**The reason to store names rather than copy the words in is staleness.** If a preset embeds the
Prologue and a typo is then fixed in the text tab, the preset keeps the old copy — and that gets
discovered during a set, staring at a mistake known to be corrected. A name is a live reference:
edit once, everything using it follows.

The one case for embedding is sharing, and it is an export concern rather than a storage one. A
preset sent to someone else is useless if it names texts they do not have, so the saved format
references by name and an export can inline what it needs.

#### A referenced text cannot be deleted

Deleting a text that presets refer to is refused, with the reason:

```
Cannot delete "prologue" — contained in preset: swarm, drift
```

**Decided in preference to a dangling-reference fallback.** The alternative was to allow the
delete and let presets degrade gracefully, but that is a worse trade: the failure would surface
mid-set, in the dark, as a preset quietly showing the wrong words. Refusing at the point of
deletion puts the problem where there is time to think about it, and the message says exactly
which presets to fix.

Rename is the same class of problem and should follow references rather than break them —
renaming a text updates every preset that names it, since the intent is obviously to keep the
association.

#### Still required, since references can rot anyway

A saved preset can name a text that no longer exists — a preset imported from elsewhere, or a
file removed outside the app. So loading still has to cope: drop unresolvable names, use the
rest, and say so in the status line. If nothing in the list resolves, fall back to the
selection. Nothing should vanish because a file was renamed in October.

#### Three rules

- **An override must be visible.** Changing the text and seeing nothing happen is
  indistinguishable from a broken Apply. The readout shows the text actually on stage and marks
  it as the preset's choice rather than the user's — the value is already in
  `EngineState.liveText`, it needs a flag beside it.
- **It lands on a phrase boundary.** Text changes are already queued rather than applied
  instantly (§11.2), because swapping mid-phrase reads as a fault. A preset carrying its own
  texts makes a preset change *also* a text change, and both already go through that boundary.
- **The pin is applied on top of the selection, never written into it.** Otherwise cycling
  through a pinned preset would permanently swallow the user's choice. When the preset cycles
  away, the menu selection is still there because it was never changed.

With several blocks on stage the list feeds **variety, not composition**: each block draws from
the list independently, which is the existing behaviour extended rather than a new rule. Three
blocks and three named texts will sometimes give one each, and that is the way to find out
whether one-each is worth making explicit.


---

## 12. Effect vocabulary

Taken from Acid, which is the agreed basis for the MVP.

### 12.1 The slot mechanism

The single best idea in Acid's CSS. `glitch` and `decor` are **abstract numbered slots** set
on elements by JavaScript. The number means nothing on its own — each preset's CSS decides
that `glitch="3"` is blue and underlined, or yellow on blue, or a dingbat substitution.

So wildly different presets need no new JavaScript at all. They redefine the slots. All the
engine does is decide *which elements* get *which slot*, and when.

### 12.2 Element effects — **being split by §11.5**

As built. Each row is a target and a treatment fused together, which is precisely what §11.5
separates — the left column becomes a *combination* a preset can express rather than a function
that has to exist.

| Effect | Behaviour | Becomes |
|---|---|---|
| `glitchChars` | Picks a character — every "e" — and slots every instance at once | target `{ match: 'e' }` |
| `glitchWords` | Slots a proportion of words | target `{ word: '5%' }` |
| `glitchParagraphs` | Slots whole paragraphs together | target `{ paragraph: 1 }` |
| `decor` | Second slot, for underlines and accents, independent of `glitch` | treatments `underline` / `strike` / `outline` |
| `invertBlock` | The `.selected` inversion — black block, white text | treatment `invert` |
| `swell` | Animates `min-width` / `min-height` so elements grow and shove the layout around | treatment `swell`, bounded and using `transform` (§11.5) |
| `removeGlitches` | Decays slots back to 0 over time, at one rate for everything | **deleted** — decay is per-layer and measured in bars |

Three targets by seven treatments is what the four rows above cannot reach: there is no way to
say "invert every instance of the letter e", because *every instance of a character* is trapped
in `glitchChars` and *invert* is trapped in `invertBlock`.

Dropped from Acid: `addLink`, which turned words into Google search links. Unclickable on a
projector.

### 12.2.1 Conditional and continuous effects

Two effects that are not simple gestures.

**`whenHolding([...])`** runs its children only on a phrase where the text is *not* being
replaced. Static text for two phrases needs more happening to it or the second phrase reads
as a stall, and each preset compensates in its own character: `scatter` corrupts more,
`drift` starts scrolling, `swarm` glitches whole paragraphs, `still` turns over two words.

> **Ordering dependency.** `whenHolding` must come *after* `retext` in a lane. It detects a
> hold by observing that `textAge` was not reset. Placed first it fires on the phrase where
> the text changes, which is precisely backwards. This is invisible from reading either
> effect alone.

**`pulse({ amount, shape })`** scales the whole stage with the beat. Driven by the predicted
grid rather than detected onsets (§9.3), so it lands *on* the beat and keeps breathing
through a passage with no transients at all. `decay` hits hard and falls away, reading as the
kick; `sine` breathes evenly and suits slower presets.

Amounts want to be small. 0.02 is clearly visible at 720p; past about 0.05 it stops looking
like a pulse and starts looking like a fault.

### 12.2.2 Why effects are functions, and when that stops working

An effect has no identity worth naming. Its interface is a single method, it shares no
implementation with any other effect, and its only state is the parameters it was built with —
so a class would add a name, a constructor, a field and a method to hold one number.

Composition is the other half: `whenHolding([...])` takes effects and returns an effect. As
functions that is five lines; as classes it needs a `CompositeEffect` type and a new concept.

**This stops working the moment effects need to be data.** A closure cannot report its own
name or parameters, so no UI can be generated for it and no preset containing one can be
written to a file. §11.4 sets out what replaces this.

**It stops working a second time for a different reason**, and that one is not about
serialisation: a closure that picks its own targets cannot have those targets changed. `glitchWords`
is 5% of words *and* a glitch, permanently. §11.5 splits that into a target and a treatment, which
is why the element effects below become a shorter list of treatments rather than a longer list of
functions — the combinations move out of the vocabulary and into the preset.

### 12.3 Text selection modes

Cheap, and responsible for most of the variety.

**The unit of selection is the sentence**, never the word or the line. Modes:

`whole` · `sentence` · `sentences` (N consecutive) · `shortSentences` · `longSentences` ·
`word`

Selecting by word or line count produced fragments that end mid-thought — *"and at her
heels, leashed in like"* — which reads as a bug rather than as an effect. Acid could get
away with it because Wittgenstein's propositions are short and self-contained; verse is not.

Sentences are found by scanning for a terminating `.`, `!` or `?`, so they can span several
lines. The prologue's 53 lines become 34 sentences of 3 to 27 words.

**The element budget is checked between sentences, never inside one.** A sentence renders
whole or not at all. The first always renders even if it alone exceeds the budget, because a
blank stage is a worse failure than a busy one.

`word` survives as the one deliberate fragment: a single isolated word reads as emphasis
rather than truncation, because nothing is obviously missing.

Plus `splitChars`, deciding whether each glyph is its own element — which governs whether
character-level effects are even possible, and has real performance consequences (§14).

### 12.4 Layout effects — **superseded by §11.6**

The `layout` slot, `LAYOUT_SETS`, `LayoutSetName` and the numbers `0..17` are replaced by the
spawn grid. What each layout actually did, and where that behaviour lives now, is tabulated in
§11.6; the short version is that most of the table was typography wearing a placement name.

These stage effects survive unchanged, because they were never coupled to placement:

| Effect | Behaviour |
|---|---|
| `columns` | CSS multi-column, 1–6 |
| `borders` | `borders` slot, 0–4 |
| `scroll` | Auto-scroll at variable speed |
| `background` | Stage background colour change |
| `colourWave` | Rotates the colour-slot variables so colour moves through the text (§12.5) |

**Deleted with the table:** `newLayout`, which picked from it, and `fontScale`, which is now a
text setting with a min and max rather than a stage effect (§11.5).

### 12.4.1 Text blocks — **superseded by §11.6**

Blocks themselves stay; where they go changes. Two things stated here are still true and are
carried forward rather than replaced:

**`count` is a total across blocks, not per block.** Passing the full count to each was a bug:
two blocks asking for four sentences produced eight, crammed into cells a third of the stage
wide, where the surplus was silently clipped and simply looked like missing text.

**Blocks must clip.** §14 says nothing should be lost silently, so the count of clipped blocks
is reported to the control window.

*No longer true:* that blocks occupy distinct cells of a 3x3 grid, and therefore that non-overlap
is guaranteed by construction. Anchor semantics (§11.6) allow two blocks to overlap if they are
anchored close together and sized large. That is the accepted cost of the VJ choosing the size:
the guarantee was a consequence of one-block-per-cell, and one-block-per-cell is what a 7x7 grid
gives up.

### 12.4.2 Size floor

Nothing renders below about 76% of the base size, and the base is 28px.

Small type fails twice over: it is unreadable on a projector at the back of a room, and a
visualiser warping the output (§13.4) smears fine detail into mush within a frame or two.
Fewer, larger words survive both. Selection counts were cut accordingly — passages are two
or three sentences, not ninety words.

### 12.5 Colour

A palette with a **reseat** that narrows to about three active colours at a time. This is
what keeps Acid coherent rather than confetti, and it is worth preserving exactly.

**Colour slots** give per-glyph colour variation cheaply, without the shader. Each element is
assigned a slot class (`c0`–`c7`) at typeset time from its position, and the preset's CSS maps
those slots to palette colours through CSS variables. Animating the whole text then means
changing eight variables rather than writing inline styles to five thousand elements — so
moving waves of colour through the type cost essentially nothing.

This matters because the naive version is the §14 layout-thrash bug wearing a hat. It also
fits the slot mechanism in §12.1 rather than being a special case.

Full per-glyph sampling from a live frame — the best trick in the original — is deliberately
held back to the three.js increment, where a shader replaces the video.

### 12.6 Fonts

Acid bundles `wingdings.woff` for its corruption effect. Wingdings is Microsoft's and
bundling it in a distributed app is a licensing question we do not need. The *effect* is
what matters, not that specific face, so an open dingbat font substitutes cleanly.

---

## 13. Output and OBS

### 13.1 The stage

A **fixed-resolution rectangle rendered 1:1, anchored top-left in the window.** Default
1280×720.

Not letterboxed and scaled, as first planned: scaling resamples text and costs crispness,
and anchoring at the origin makes the OBS crop exactly `0,0 1280×720` rather than something
you have to measure. The HUD sits below it and is cropped away.

Fixed rather than fluid for two reasons: OBS gets a stable crop target, and the type layout
becomes deterministic. A preset looks the same every time instead of reflowing with window
size — which matters a lot when font sizes are viewport-relative.

**Default 1280×720**, chosen over 1080p because rendering is lighter and the app is sharing a
machine with DJ software and OBS. The stage size is configurable.

### 13.2 Capture

Window capture in OBS, cropped to the stage. The HUD sits outside the stage and is cropped
away.

To make that painless, **the HUD displays the exact crop values** — position and size — so
they can be typed into OBS rather than dragged by eye.

### 13.3 Transparency

Electron windows can be genuinely transparent, which would let the visual composite over
other layers in a stream rather than sitting in an opaque box.

Two things to note. Chroma or colour keying is *not* an acceptable substitute here:
antialiased glyph edges blend into the key colour, producing halos and eating thin strokes.
And the blend-mode trick — render on black, use Screen in OBS — only works for light-on-dark
visuals. Acid is black on white, so it would not apply.

> **Needs verification:** whether OBS's window capture preserves the alpha channel from a
> transparent window. Recent versions have a transparency option for Windows Graphics
> Capture, but this is unconfirmed. If it does not, the fallback is an OBS browser source
> fed by the app over a local socket — which the event-stream seam in §7 already allows for.

**Default look is black text on white**, as in Acid. Noted here because it rules out the
blend-mode shortcut above.

### 13.3.1 Compositing controls

Added during Increment 1, once transparency made overlaying real. All persist between
launches.

| Control | Why |
|---|---|
| **Background** — white / black / transparent | Transparent composites over other layers; the foreground flips to white with it, since black type over arbitrary video is unreadable |
| **Palette** — acid / mono / warm / cool / none | Saturated accents clash badly with whatever is underneath. `mono` and `none` keep the whole typographic vocabulary and drop the colour |
| **Layouts** — centre / edges / all | Other visuals usually put their subject in the middle of frame. The `edges` set keeps the centre clear and works around it |

Two effects had to learn about these rather than assuming: `colourShift` bases its slots on
the stage foreground instead of hardcoded black, which would blank the stage on a dark
background; and the `background` flip does not run unless the mode is white, because an
explicit choice about output should not be overruled by an effect.

The layout set applies immediately on change rather than at the next bar — if text is
sitting on your visuals, four beats is too long to wait.

### 13.4 Spout output

**Working.** Verified 2026-08-21: the stage reaches NestDrop over Spout and the visualiser
warps the typography.

This is a second, independent output path, not a replacement. Two things are wanted:

| Path | Result |
|---|---|
| **Overlay** — Olib into OBS, over other layers | Text stays clean and readable on top of the visuals |
| **Warp** — Olib into MilkDrop, then into OBS | Typography becomes raw material for the visualiser |

Both must keep working. They pull in opposite directions — the transparent background and
the `edges` layout set exist to *avoid* the visuals, which is meaningless once the text is
being consumed by them — so neither should assume the other is off.

In practice `edges` turned out to matter for *both*: the brand mark sits centre frame in the
warped output too, which is why blocks never use the centre cell (§12.4.1).

#### How it is done

**An OBS per-source Spout filter.** No code, no native module.

Right-click the Olib source in OBS, Filters, add **Spout Filter**. That publishes only that
source. NestDrop receives it; NestDrop's own output goes back into OBS as a separate source.

```
Olib window ──► OBS source ──[Spout Filter]──► NestDrop ──► OBS source ──► program
```

**Publishing OBS's program feed instead would loop** — NestDrop is itself an OBS source, so
it would feed itself, blow out to white, and add a frame of latency per round. The per-source
filter carries only Olib, so there is no cycle. This distinction is the entire reason the
simple route works.

With the HUD hidden the window *is* the stage, so the capture needs no crop.

#### A native sender, if it is ever needed

Not needed now. Recorded because it was investigated in detail and the conclusion should not
have to be rediscovered.

`electron-spout` exists and uses `offscreenUseSharedTexture` for zero-copy GPU sharing. It
would remove OBS from the path entirely — lower latency, no plugin dependency.

Three real costs:

- **A C++ toolchain.** Visual Studio with MSVC, cmake-js, vcpkg. Not currently installed.
- **Rebuilds against Electron's ABI** on every Electron update, turning a clean
  `npm install` into a support burden. It would be the project's only dependency of this
  kind and should stay that way.
- **An architecture change.** Shared textures require offscreen rendering, and an offscreen
  window is not displayed — forcing the control/output window split (§7). That split is
  independently desirable, but it also means OBS could no longer window-capture the stage
  and would need a Spout *receiver* source instead.

The judgement: none of that is worth paying until the plugin route proves insufficient. It
has not.

**Alpha survives Spout**, so a transparent background carries through to the receiver.

### 13.5 Canvas placement

The canvas window is frameless, because Windows requires it for a transparent window and
transparency is worth having. Frameless means no title bar to drag it by, so placement is set
from the control window's Canvas tab: width, height, x, y, 720p/1080p presets, centre on
screen.

Better than dragging, as it turns out — exact numbers reproduce on every launch, which is
what you want when OBS is pointed at the window.

Two safeguards: requested bounds are clamped to an attached display, and the fields are **read
back after applying** rather than trusting the request, so what is shown is what happened. The
stage follows the window's content size, so changing resolution re-renders rather than
clipping.

---

## 14. Performance and reliability

Two hours unattended, sharing a machine with DJ software and OBS. Reliability is a feature.

### Rules

- **Never read layout then write style in a loop.** Batch all `getBoundingClientRect()`
  reads, then all writes. This is the bug that caps Acid's frame rate.
- **Cache element rects** per text render; invalidate on resize or re-typeset, not per frame.
- **Prefer attribute flips to inline styles.** One attribute on the stage restyles thousands
  of elements in CSS; a loop setting inline styles does not.
- **Budget elements.** `splitChars` on a large text run can produce tens of thousands of
  nodes. Presets declare a ceiling; the typesetter enforces it.
- **Degrade, don't fail.** Under frame-rate pressure, reduce element counts and effect
  density rather than dropping frames.
- **Never clip silently.** Text blocks must clip, or they would spill into the protected
  centre — so the HUD reports how many are clipped, and the count turns red above zero. Lost
  text is otherwise indistinguishable from text that mysteriously failed to appear, which is
  exactly how it presented the first time it happened.
- **One writer per shared property.** `Stage` owns `transform`, composing scroll and pulse.
  Two effects writing it independently would silently overwrite each other, with the winner
  depending on effect order within a lane.
- **Continuous state resets on preset change.** `pulse` and `scrollSpeed` persist until
  something sets them, so a preset that does not use them would inherit whatever the last one
  left running — and a pulse with nothing driving it freezes at its last value rather than
  stopping.
- **Derive state before building the effect context, not during dispatch.** The context is a
  snapshot; mutating something it captured, part-way through a frame, means effects read a
  stale value. This was a real bug with `textAge`.

### Unbreakable

- Every effect handles an empty element list without throwing, and **says so** rather than
  failing silently — Acid's quiet no-ops were fine for a fixed piece and are not fine here.
- Audio device loss, silence, and detection failure all degrade to "keep running on the last
  known grid".
- An uncaught error in one effect must not take down the frame loop.
- Target 60 fps; fall back to 30 cleanly if the machine is loaded.

---

## 15. Stack and layout

**TypeScript (strict), Vite, Electron.** No p5, no jQuery.

Built on Electron 43, Vite 7, TypeScript 7, via `electron-vite`. Two notes on that:

- **TypeScript 5.9**, pinned. 7 was never a decision — npm resolved it on day one and it
  became a problem the moment a dependency declared a `typescript@^5` peer. It is the same
  language and the same type system; the port is only faster to compile, and measured on this
  project that is 1.7s versus 3.0s. Not worth fighting the ecosystem over.
- **`npm` 11 blocks install scripts by default.** `electron` and `esbuild` both download a
  platform binary in `postinstall`, so nothing works until they are approved. The approval
  is recorded in `package.json` under `allowScripts`.
- **Typed arrays now carry a buffer type parameter.** A bare `Float32Array` widens to
  `ArrayBufferLike` and no longer satisfies Web Audio signatures; it must be written
  `Float32Array<ArrayBuffer>`. Expect this any time you touch audio buffers.

TypeScript earns its place twice: in the engine, where `Lane`, `EffectRef` and preset shapes
are naturally typed, and in preset definitions, where a mistyped lane name or effect
parameter should be a red squiggle rather than a visual that silently never happens.

```
SymphonyInOlib/
├─ DESIGN.md
├─ package.json · tsconfig.json · vite.config.ts
├─ electron/
│  ├─ main.ts           window, permissions, desktop loopback capture
│  └─ preload.ts        bridge
├─ presets/
│  ├─ visual/           visual preset definitions (code)
│  └─ text/             .txt files
├─ style/
│  ├─ base.css
│  ├─ slots.css         [glitch] [decor] [borders] — slot appearances
│  ├─ layouts.css       [layout="..."] definitions
│  └─ hud.css
└─ src/
   ├─ main.ts · types.ts
   ├─ audio/            AudioInput · Analyser · BeatTracker
   ├─ time/             Clock
   ├─ show/             Conductor · PresetBank · TextBank
   ├─ render/           Stage · Typesetter · Renderer
   ├─ effects/          registry + effect modules
   ├─ hud/              Hud
   └─ util/             math · color · dom
```

---

## 16. Roadmap

### Increment 1 — MVP: "runs my set unattended" — **done**

*Demo: launch, pick a source, alt-tab to the DJ software, OBS captures a clean visual locked
to the music for the rest of the night.*

- ~~Electron shell — window, permissions, no throttling~~ **done**
- ~~Audio device dropdown including system loopback~~ **done**
- ~~Band energy and onset analysis~~ **done** (§9.2.1)
- ~~Audio beat detection — tempo, phase, confidence, re-lock~~ **done** (tempo accuracy open, §9.2.3)
- ~~Predictive beat grid; bars and phrases~~ **done**
- ~~Tap tempo, HUD readouts, beat indicator~~ **done**
- ~~DOM typography engine — paragraphs, words, chars~~ **done**
- ~~Text presets from files~~ **done** (bundled; Q4 still open)
- ~~Effect vocabulary and lane bindings~~ **done** (§12)
- ~~Sentence-based text selection, multi-block placement, weighted layouts~~ **done**
- ~~Preset bank with cycling on phrase boundaries~~ **done**

**Increment 1 is complete.** Outstanding within it: tempo accuracy (§9.2.3), which is
deferred rather than solved.
- **Audio beat detection** — tempo, phase, confidence, re-lock
- Predictive beat grid; bars and phrases
- Tap tempo on space; Tab toggles options
- HUD: BPM, source, confidence, beat indicator, OBS crop values
- DOM typography engine — paragraphs, words, chars
- Text presets from files
- Colour slots + palette, with a moving colour wave
- Three visual presets, auto-cycling on phrase boundaries (timer only)
- Fixed-resolution stage at 1280×720

Detection goes in straight away rather than being stubbed. If it works poorly it still
works, and Increment 2 is where it gets good.

### Increment 1.2 — two windows and the panel system

*Branch `two-window-hud`. In progress.*

- ~~Canvas and HUD as separate windows, with a typed message protocol~~ **done** (§7.1)
- ~~Text editing moved to the control window~~ **done**
- ~~Tray, always-on-top, canvas placement~~ **done**
- ~~Per-application audio capture~~ **done** (§8.2, not originally scoped here)
- Saved window positions and the config file — **still to do** (§7.3)
- The floating panel system — **still to do** (§7.2)

Removed two workarounds that only existed because the windows were welded together: the
transparent gap, and the fixed window height. OBS no longer needs a crop at all.

### Increment 2 — modular presets

Branch `modular-presets`. The change that makes the tool configurable rather than merely
usable, and a prerequisite for mapping MIDI to anything finer than a whole preset.

Larger than it first looked, because the set did not ask for sliders on the existing effects —
it asked for effects that were worth having sliders on. §11.5 to §11.7 are the design.

Staged so each step is usable on its own:

- **2a — the layer engine.** Targets, treatments, triggers and channels (§11.5). Built-ins
  ported unchanged so the port can be checked against what they look like now. Decay moves to
  per-layer and to bars, which fixes the frame-rate dependence.
- **2b — the spawn grid.** 7x7 mask, anchor plus size, global mask in the canvas tab
  (§11.6). Deletes `LAYOUT_SETS` and the layout slot.
- **2c — live editing.** The Effects tab generates a control per parameter; layers added,
  removed and reordered. No serialisation needed yet, and this is the point where the tool
  starts paying for itself.
- **2d — saving.** Presets become JSON alongside the texts, with validation on load, plus
  per-preset text lists and delete protection (§11.7).

### Increment 3 — detection hardening

Confidence scoring, octave correction, faster re-lock on track change, downbeat and phrase
heuristics, behaviour through breakdowns and silence.

### Increment 4 — palettes

Palette presets with roles (text, background, accent), selectable, optionally shifting with
energy.

### Increment 5 — energy and structure

Breakdown, drop and build detection from low-band energy (§10.1), driving preset changes and
intensity so the visual responds to arrangement rather than just pulse. Activates the `energy`
tags already present on presets.

### Increment 6 — MIDI pads

Web MIDI for preset switching from a controller — the only control surface that works while
the window is unfocused.

### Spout output — **done**

Achieved with an OBS per-source Spout filter rather than a native sender (§13.4). No code
was needed. The native route is documented with its costs in case the plugin path ever
proves insufficient; it has not.

### Increment 7 — three.js layer

WebGL background plus the per-glyph sampler: a live shader colouring text, generalising
Acid's video-sampling trick.

### Increment 8+ — ongoing

Text preset manager, effect library expansion, transparent output, perf work, and possibly
Ableton Link via a native module for exact sync on rekordbox and Serato.

---

## 17. Decision log

Recording what was rejected, and why, so it doesn't get relitigated.

| Decision | Outcome | Reason |
|---|---|---|
| p5.js + jQuery | **Dropped** | ~1 MB for a dozen helpers |
| Composed piece with an authored timeline | **Dropped** | It's a live tool; the track is unknown |
| MIDI clock as the timing source | **Dropped** | rekordbox and Serato don't send it; agnostic was the goal |
| Tap tempo as the primary clock | **Dropped** | Can't re-tap a window you can't reach |
| Metronome-first development | **Dropped** | Detection is the risk; face it early |
| Seeded RNG for reproducible looks | **Dropped** | Made sense for a fixed piece; live, you *want* variation |
| Second monitor for the output window | **Dropped** | User has one screen; must work regardless |
| Keyboard as the live control surface | **Dropped** | Unfocused windows get no key events |
| Chroma/colour key for transparency | **Dropped** | Wrecks antialiased type |
| Screen/Add blend as a transparency shortcut | **Dropped** | Only works light-on-dark; Acid is black-on-white |
| Hosted web app | **Dropped** | Never going to be hosted; Electron solves five problems at once |
| `addLink` effect | **Dropped** | Unclickable on a projector |
| Text and visual presets coupled | **Dropped** | Coupling is why Acid's scenes can't be reordered |
| Overall volume as the structure signal | **Dropped** | DJ masters are limited; breakdown and drop have near-identical RMS. Use low-band energy |
| Per-glyph colour via inline styles | **Dropped** | It's the §14 layout-thrash bug. Colour slots + CSS variables instead |
| Legacy `chromeMediaSource: 'desktop'` capture | **Dropped** | Audio-only form is a malformed IPC; terminates the renderer (§8.1) |
| Requesting a video track for loopback audio | **Dropped** | WGC fails `E_ACCESSDENIED` and takes the audio with it (§8.1) |
| Effects that pick their own targets | **Dropped** | `glitchWords` is a target welded to a treatment; the pairings, not the knobs, were what limited the presets (§11.5) |
| `Number.isInteger` to tell a proportion from a count | **Dropped** | One number type: `1.0` *is* `1`, and the collision lands on "all of them". Percentage strings instead (§11.5) |
| One `data-glitch` attribute per element | **Dropped** | Last layer wins, so effects cannot stack. Channels named after CSS properties instead (§11.5) |
| Decay as a single ambient effect | **Dropped** | One rate for everything; also frame-rate dependent. Per-layer, measured in bars (§11.5) |
| Region targets — select elements by where they sit | **Dropped** | Needs a layout pass, a position cache and motion-offset tracking. The spawn grid controls where text *appears* instead (§11.6) |
| Spawn mask as permitted area — block must fit inside | **Dropped** | Forces the app to search, shrink or refuse; all three second-guess a size the VJ chose. Anchors, and overflow is on the author (§11.6) |
| `LAYOUT_SETS` and the layout numbers `0..17` | **Dropped** | Eighteen fixed combinations from Acid, each welding typography to placement. Four independent settings that multiply (§11.6) |
| Embedding text content inside preset files | **Dropped** | Not a size problem — a staleness one. Editing a text would leave stale copies in presets. Reference by name; inline only on export (§11.7) |
| Letting a referenced text be deleted, with graceful fallback | **Dropped** | Moves the failure into a live set. Refuse the delete and name the presets instead (§11.7) |
| Letterboxed, scaled stage | **Dropped** | Resamples text; 1:1 top-left also makes the OBS crop trivial (§13.1) |
| Onset threshold as `mean × k` | **Dropped** | Cleared constantly by steady-state signal. Use `mean + k × stddev` (§9.2.1) |
| 0.7s flux history window | **Dropped** | Spans a beat, not a bar; collapses in breakdowns (§9.2.1) |
| Separating kick from bass synths | **Not attempted** | They are genuinely the same event in that band. Tracking tolerates it (§9.2.2) |
| Spout via OBS program feed | **Dropped** | MilkDrop is already an OBS source, so it feeds itself. Direct sender instead (§13.4) |
| Whole HUD as the window drag region | **Dropped** | A drag region swallows pointer events — the panel could not be scrolled. Only the status strip drags |
| Native Spout sender | **Deferred** | An OBS per-source filter does the job with no code, no toolchain and no architecture change (§13.4) |
| Selecting text by word or line count | **Dropped** | Produces fragments ending mid-thought. Sentences are the unit (§12.3) |
| Three simultaneous text blocks | **Dropped** | Too much on screen once the size floor was raised. Two |
| Equal weighting across edge layouts | **Dropped** | Single bands are the least interesting and were appearing nearly half the time |
| Presets setting palette and layout set | **Dropped** | Those are user choices about compositing; a preset cannot know why they were made (§11.1) |
| Fixed text hold of two phrases | **Dropped** | Predictable — you start anticipating the change. One or two, chosen each time (§11.2) |
| Effects writing `transform` directly | **Dropped** | Scroll and pulse would overwrite each other. Stage is the single writer (§14) |
| `count` applied per block | **Dropped** | Multiplied the text and clipped the surplus silently (§12.4.1) |
| Effects as closures | **Correct for now, revisited** | Right while effects are authored in TypeScript; blocks editable and saveable presets, so §11.4 replaces them with classes plus definitions |
| Built-in presets as a compiled special case | **Dropped** | Two mechanisms for one concept means two code paths and two failure modes. Everything is data (§11.4) |
| Forking a built-in preset when edited | **Dropped** | Re-seeding gives the same safety net without duplicating every preset the first time a slider moves (§11.4) |
| HUD attached to the canvas window | **Dropped** | Forced a transparent gap and a fixed window height, both workarounds for the coupling itself (§7.1) |
| A menu bar on the canvas window | **Dropped** | That window is on the stream; even an auto-hidden menu bar appears on Alt. Tray menu instead (§7.1) |
| Global keyboard shortcuts | **Dropped** | Would steal keys from the DJ software. Control window focus only (§7.1) |
| A docking library | **Dropped** | Preference for owning the code unless the problem is excessive. The fiddly parts are named in §7.2 so they are planned for rather than discovered |
| Settings scattered across localStorage | **Dropped** | One config file, consistent with texts and presets (§7.3) |
| Requiring the booth output to be the Windows default | **Dropped** | Every notification would go through the PA. Per-application capture instead (§8.2) |
| A native addon for audio capture | **Not needed** | `application-loopback` ships helper executables, so no toolchain and no ABI matching (§8.2) |
| TypeScript 7 | **Dropped** | Never a decision — npm resolved it on day one. Same language, ~1.2s faster on 5k lines, and peers across the ecosystem still target `^5` |

---

## 18. Open questions

| # | Question | Section |
|---|---|---|
| Q1 | Auto-reconnect to a returning audio device, or wait for the user? | §8 |
| Q2 | How aggressively should auto-detect resume after a tap? Worth a "hold manual" toggle? | §9.4 |
| ~~Q4~~ | ~~Bundled set or a user folder?~~ **Answered: a folder the app scans**, in writable app data, seeded on first run. Built with create, import, edit, revert and delete | §11.3 |
| Q7 | What is the app actually called? "Symphony in Olib" is a placeholder. | — |
| ~~Q8~~ | ~~Three visual presets in the MVP?~~ **Answered: four.** `still` (sparse, one large sentence, almost motionless), `scatter` (mid, two blocks, the workhorse), `swarm` (peak, dense and character-level), `drift` (mid, long sentences, scrolling) | §11 |
| Q9 | Are the snare (2.0) and hat (2.2) sensitivity defaults as eager as kick was? If they also want ~4, that is a systematic scaling error, not three numbers | §9.2.1 |
| Q10 | Tempo reads a few percent low and the cause is not yet found. Deferred as good enough for visuals — revisit with a correlation-curve plot before changing the algorithm again | §9.2.3 |
| Q11 | Block count is currently random 1–2 per re-typeset. Should it correlate with something — energy, for instance — rather than being arbitrary? | §11.6 |
| Q12 | Are `longSentences` (up to 27 words) too dense at the new size floor, especially two blocks at once? | §12.4.2 |
| Q13 | Pulse amounts are guesses (0.012–0.022). Worth tuning against a projector rather than a monitor — apparent scale changes with viewing distance | §12.2.1 |
| ~~Q14~~ | ~~Fork on editing a built-in?~~ **Answered: no fork.** Built-ins are editable directly; "Restore defaults" re-seeds them | §11.4 |
| ~~Q15~~ | ~~Do built-ins stay compiled?~~ **Answered: no.** Everything becomes data, for consistency. Type safety comes from `as const` definitions plus validation on load | §11.4 |
| ~~Q16~~ | ~~How do two layers on one element resolve?~~ **Answered: fine-grained channels** named after CSS properties. Different properties compose; same property, later wins | §11.5 |
| ~~Q17~~ | ~~Cap the number of layers?~~ **Answered: soft limit and a warning**, keyed to elements-touched-per-second rather than layer count. Never a hard cap | §11.5 |
| ~~Q18~~ | ~~Does `flicker` belong with the treatments given it is continuous?~~ **Answered: yes** — same authoring, CSS runs the animation | §11.5 |
| ~~Q19~~ | ~~Region targets?~~ **Answered: no** — replaced by the spawn grid, which was the actual intent | §11.6 |
| Q20 | Does `flow: 'columns'` need a tunable gap, or is one number enough to recover layout 12's look? | §11.6 |
| Q23 | Independent width and height ranges cannot say "tall or wide, never square". Does that shape come up often enough to want an orientation setting, or do two presets cover it? | §11.6 |
| Q21 | With three blocks and three named texts, the list feeds variety (each block draws independently). Should one-each composition be an explicit option, or is random enough? | §11.7 |
| Q22 | Layout 16 aligned alternate blocks outward. Dropped as a between-blocks relationship the model does not store — does it turn out to matter? | §11.6 |

**Answered:** stage defaults to 1280×720 (Q5). Black on white (Q6). Preset cycling is a
randomised 16–32 bars on phrase boundaries, with structure overrides deferred to Increment 4
(Q3).

**Verified 2026-08-21:** OBS window capture **does** preserve the alpha channel from a
transparent Electron window. Tested with a colour source beneath the canvas source in the
scene — the colour shows through where the stage is transparent. This is what justifies the
canvas window being frameless, since Windows requires frameless for transparency (§13.3).

Note the test has to be a layer *below it in the OBS scene*, not a window physically behind
it on the desktop: window capture grabs the window's own pixels, so what is behind it on
screen is never part of the capture either way.
