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

Two roots, one per window. Neither knows about the other's objects.

```
main.ts                 the output window's composition root — 94 lines
└── Engine              the show: one frame, one command switch
    ├── Sources         two capture paths, the live Analyser, sensitivities
    │   ├── AudioInput  device enumeration
    │   ├── AppCapture  one application's output, as PCM over IPC
    │   └── Analyser    bands, levels, onsets
    ├── BeatTracker     tempo and phase estimation
    ├── KickHistory     kick strength, and whether kicks agree with a tempo
    ├── Clock           beat/bar/phrase position; tap override
    ├── Conductor       trigger dispatch
    │   └── Layer       one target, one treatment, its triggers and decay
    ├── Channels        who owns which property on which element
    ├── PresetStore     preset documents on disk
    │   └── PresetBank  which is live, which is queued, when it may change
    ├── TextPool        the active text, the queued one, the pinned ones
    ├── Look            background, palette, global mask
    ├── Stage           fixed-resolution root; the transform's single writer
    ├── Typesetter      text → paragraphs → words → chars → DOM
    └── EngineBridge    batches state for the control window

control.ts              the control window's composition root
├── Hud                 panels, readouts, controls
├── PresetEditor        the Presets tab
└── TextBank            drafts, undo, the file list
```

#### The engine was a script, and that was a real cost

Every collaborator was a module-level binding — 33 of them, 15 mutable — and every function a
closure over the module. Module *initialisation order* was acting as an implicit constructor,
with no way to enforce it and no way to build the thing twice.

The symptom that gave it away: `frameDelta` was declared eight hundred lines from its use site,
carrying a comment explaining that reading it any earlier threw. `applyPreset` ran during module
evaluation and built an effect context from it. As a class that cannot happen — the constructor
finishes, and only then does `start()` run the things that need a finished object.

Four objects came out on the way, each one a cluster that was never the engine's business:

| | |
|---|---|
| `Sources` | how an analyser came to exist, and which of a dozen sources it points at |
| `TextPool` | §7.1's boundary made structural — reading a text is a function passed in, so the engine literally cannot reach a draft |
| `Look` | the three settings that describe tonight's frame rather than any preset |
| `show/wiring.ts` | four pure decisions the engine makes, now testable without a DOM |

`main.ts` went from 1,050 lines to 94, and from 15 mutable module bindings to none.

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

Three kinds of thing, in three places.

| What | Where |
|---|---|
| Presets | one JSON file each, in `presets/` in app data |
| Texts | one `.txt` file each, in `texts/` |
| Canvas position and size | `stage-window.json` (§13.1) |
| Everything else | `localStorage`, one key per setting |

Files for anything you might want to copy, send to someone, or edit by hand. A corrupt preset
costs you that preset rather than the whole bank.

The `localStorage` keys are `olib.` plus: `inputDeviceId`, `pendingSource`, `sensitivity`,
`palette`, `background`, `mask`, `activeText`, `disabledPresets`, `livePreset`, `editingPreset`.

The last two are what makes a restart feel continuous — the show comes back on the preset that
was live, and the editor reopens on the preset you were editing. Both store a *name*, so a
preset deleted between sessions falls back to the first one instead of erroring.

**Reached through a port, not a global.** `Settings` is two methods, and classes that remember
something take one rather than calling `localStorage` directly. That is what it costs to make
`PresetBank` testable: its job is cycle policy, which is pure decision logic, and it could not be
exercised outside a browser purely because its constructor read a key.

**Still open:** folding those keys into one `config.json` beside the presets. One inspectable,
backup-able place is the goal; localStorage is what is there now, and when the file lands it
implements `Settings` rather than being threaded through every caller again.

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

### 9.2.4 The kick decides whether a tempo change is believed

The tempo of this music is carried by the kick. Everything else — pads, vocals, a shaker
running through a breakdown, a minute of hats and snares over an intro — is periodic enough to
produce a *confident* estimate that happens to be wrong, and correlation cannot tell the
difference: eight seconds of eighth-note hats genuinely are periodic at twice the tempo.

So a change of tempo has to answer **two** questions, and they are not the same question.

#### Is the kick doing what it has been doing?

`KickHistory` records the strongest kick in each of the last **three minutes** and reports the
last two seconds against the median of the seconds that had a kick in them. 1 means business as
usual; below 1 is a breakdown or a filter sweep; above 1 is a drop.

**Relative, not absolute**, because a quiet master and a loud one differ by more than a
breakdown and a drop do — a fixed threshold would be tuned to one record and wrong for the next.
Verified level-independent: the same passage at 0.05 and at 4.0 reads identically.

*Per-second peaks, and the median of them.* An earlier version sampled ten times a second and
took an 80th percentile, which made the answer depend on the kick's **duty cycle** — how much of
each second the transient occupied — so it drifted with tempo. It happened to work at 128 and
fell apart after a breakdown. A second contains at least one kick at any tempo this app tracks,
so every slot measures a kick rather than the gaps between them.

*Three minutes, and quiet seconds excluded.* Both come from the same observed failure: an intro
of hats and snares lasting the best part of a minute jumped the grid from 130 to 170. The window
**is** the definition of typical, so a section longer than the window becomes typical — a minute
of hats eroded the baseline down to the hats themselves, at which point the hats read as a
perfectly healthy kick and the gate opened. Three minutes outlasts any intro or breakdown in a
record that runs five to seven, and dropping the quiet seconds from the median stops a long
passage voting itself normal from the other direction.

#### Do the kicks land on the tempo being proposed?

Strength says a kick is *there*. It does not say it agrees — and the intro that jumped the grid
answered the strength question honestly, because it was loud. It simply had no kick in it.

So each recent kick is placed on a circle by where it falls within the candidate period. On the
grid, the points pile up; off it, they spread out, and the length of their average is that
pile-up. Measured: kicks at 130 score **1.00** against 130 and **0.07** against 170.

With too few kicks in the last eight seconds the answer is **0**, not "unknown". No kick is not
a reason to believe a new tempo — it is a reason not to. That intro now scores 0 against every
candidate, including the one the hats genuinely are periodic at.

#### How much has to be proved

**DJs beatmatch.** Two records in a transition are at nearly the same tempo, because that is
what a transition *is*. So the evidence demanded scales with the size of the jump: a small one
is ordinary, and a large one is nearly always the correlation locking onto a pattern rather than
a pulse.

| Change | Kick strength | Agreement | Held for |
|---|---|---|---|
| under 12% | — | — | absorbed by fine correction, no re-lock |
| 12% | 0.8× typical | 0.45 | 8 estimates (~2s) |
| 30% or more | 0.95× typical | 0.70 | 14 estimates (~3.5s) |

Ramped between the two, and on top of all of it the proposed tempo must agree with the kicks
*better than the one already playing does* — otherwise there is no reason to move.

Not a flat refusal at the top end, because a hard cut between genres does happen and the grid
should follow it. Measured: a genuine 128 → 174 cut with real kicks behind it is taken after
**7.9 seconds**.

The top row started at 1.0 / 0.80 / 28 and took 11.8 seconds, which a real house-to-drum-and-
bass change showed to be too long — long enough to be visibly on the wrong grid through a
transition. **The agreement test is what rejects an intro**; the long hold was belt and braces
on top of it, and it cost more than it bought. Softening it did not cost any of the cases the
rule exists for: the hats-and-snares intro still moves nothing, a breakdown still cannot walk
the tempo, and a beatmatched mix is still absorbed by fine correction rather than re-locking.

#### A tap is also a way out

Detection *agreeing* with a tapped tempo is the track change seen from the other side. So
manual hands back at that point rather than going on refusing corrections from a tracker that
has already caught up — which also leaves the phase locked to wherever the taps happened to
land rather than to the record.

That makes tapping the fast path past a jump the automatic rule is being careful about: tap the
new tempo once and detection resumes on it immediately. A tap that *disagrees* with what is
playing still holds, and detection still wins eventually on the ordinary track-change rule
(§9.4) — a few disagreeing estimates do not undo a tap.

#### Fine correction

Separate from all of the above, and ramped to nothing below **half** the typical kick. Scaling
by strength directly left a breakdown able to walk the tempo 2.5 BPM over twenty estimates —
small each time, and the grid is somewhere else by the time the kick returns. Below half there
is no evidence worth acting on, and the grid is predictive: running on the last known tempo
through a quiet passage is exactly what it is for.

An unknown answer reads as 1, so nothing is blocked at startup — at which point agreement is
still holding the other end.


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

When the text does hold, the preset compensates — that is the `held` trigger (§11.5).

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
TypeScript, checked by the compiler, wrapped by other effects. But a closure is **opaque**:
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
  /** Effects that wrap other effects accept children; leaf effects do not. */
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
  /** A free-form label the VJ applies. Drives nothing — see §11.5. */
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
  /**
   * Candidate shapes, in cells. One is chosen per block, per typeset, then
   * rolled within its ranges. A list rather than a pair so width and height
   * stay coupled — see §11.6.
   */
  blockShapes: {
    cols: { min: number; max: number };
    rows: { min: number; max: number };
  }[];
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
  /** Only read by size treatments. Rolled within these bounds when it fires. */
  size?: { min: number; max: number };
  /** Period in bars. Only read by periodic treatments — flicker. */
  rateBars?: number;
}

interface EffectData {
  id: string;
  values: Record<string, number | boolean | string>;
  children?: EffectData[];   // for effects that wrap other effects
}
```

Which makes a preset a JSON file, stored the same way texts are (§11.3) — a writable app-data
folder, seeded with the built-ins on first run. `PresetBank` grows the shape `TextBank`
already has: list, load, edit, apply, revert, save.

**`children` was never needed.** It was here for `whenHolding`, the one effect that wrapped
others — and that became a trigger rather than a wrapper (§12.2.1). A layer is flat by
construction, which is one of the quieter benefits of the split.

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
  spawn    ▓▓▓▓▓▓▓   shapes                        align left
           ▓▓▓▓▓▓▓     column  cols 1●●1  rows 4●──●7   [x]
           ▓▓···▓▓     band    cols 5●─●7  rows 1●●2    [x]
           ▓▓···▓▓     + add shape
           ▓▓···▓▓
           ▓▓▓▓▓▓▓                                   flow stack
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

#### Three rules the editor follows

**Ranges collapse to one number.** A min and a max, where you nearly always want a single
value, is two fields to keep in step. Every range shows one value with a `±` toggle; open it and
you get both handles. Typing a min above the max pushes the max up with it, and the same in
reverse, so the pair can never cross.

**Choosing a treatment does not change anything else.** Picking a different treatment swaps the
controls that belong to it and leaves the triggers and decay alone. It used to reset the
triggers to `kick` every time, because the row's handlers had closed over a stale copy of the
layer.

**A typed number is held to its own bounds.** `min` and `max` on a number input are advisory —
the browser draws the spinner and marks the field invalid, but nothing stops you typing 500 into
an 8–200 size box, and reading `.value` hands it straight back. Every field in the editor read
it that way, so a size of 500px or a decay of −3 bars went into the preset unchallenged.

Clearing a field is the same bug from the other side: `.value` is `''` and `Number('')` is
**0**, so emptying the size box set the type to 0px rather than doing nothing. Empty means
"still typing", so the last good value stands.

The *ordering* guard was already right in both the editor and the loader, which is why this
never showed up as a min above a max.

**Space types a space.** Tap tempo is on the space bar and used to fire while you were typing
into a text field. Key handling checks for a focused field first.

**Units go after the number.** The decay field read `bars [n]`, which put the word between the
target amount and the number it belonged to and left it looking like a label for the trigger
checkboxes on its other side — reported as exactly that. It reads `fade [n] bars` now, like
`every [n] bars` beside it.

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
| Slice | `char` · `word` · `sentence` · `paragraph` · `block` — a `<p>` is a *line*, so a sentence gets its own wrapper |
| Text | any mode, plus `continuous` to read it in order rather than sample it |
| Treatment | `invert` · `accent` · `dingbat` · `underline` · `strike` · `outline` · `swell` · `flicker` · `blank` · `scroll` · `travel` |
| Trigger | `typeset` · `kick` · `snare` · `hat` · `beat` · `bar` · `phrase` · `held` · `always` |

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

#### Static means static: colour is decided at typeset

**There is no colouring effect any more.** Acid gave every word a colour slot and shifted
those slots periodically, so words changed colour with nothing driving them — no target, no
trigger, nothing to turn off. On a looping conveyor that was the only visible event, since the
belt rolls straight through a re-typeset and hides the text swap entirely.

Colour reaches a word through an **`accent` layer** and no other way. Target, trigger, decay,
channel ownership, conveyor mirroring — the same rules as every other look.

The scattered colour Acid gave for free is rebuilt out of those parts: `accent` on a
proportion of words, trigger `typeset`, `decayBars: 0`. Applied when the text is laid out,
held until it is replaced. Having to ask for it is the point — a word nothing has targeted is
now the stage foreground and stays there.

This needed one new trigger. **`typeset`** fires when new text has been laid out, before any
beat has touched it, and it is the only way to say "applied once, then left alone" — every
other trigger is an event that recurs. It has to be a trigger rather than something a preset
does when it goes live, because the text is rebuilt every phrase or two and a look established
once would be destroyed with the elements carrying it.

The palette itself is written to the stage when the VJ picks one, which is a deliberate act
like switching the background and should take effect at once. `--c0`..`--c7` are now simply
the chosen palette: the values a layer may pick from, rather than a colouring applied to
everything.

A word's base colour behaves the way its base size does — **decided when the text is typeset
and then left alone unless a layer takes the channel**. It is the same rule §11.5 already
applies to size, and it was being broken in the one place nobody looked.

The other half was where it was written. `colourShift` used to write `--c0`..`--c7` onto the
*stage*, which every word inherits. So it
recoloured **text already on screen**, including words no layer was targeting. Those changed on
their own, out of time with anything, which reads as a fault rather than as an effect — and it
is worst on a conveyor, where the same words come round again looking different.

The palette assignment is now held on the stage as data and copied onto each **block** as it is
built. Eight declarations per block rather than one per element, so it is still the mechanism
§12.5 exists for — just scoped so a change lands on the next typeset instead of rewriting what
is being read.

*Kept:* unaccented slots stay `var(--stage-fg)` rather than a literal colour, so switching to a
black or transparent background still makes the text readable. Verified: repainting the stage
slots leaves existing words untouched, accents survive a background flip, and unaccented words
still follow it.

#### Text selection: slice, take, pick

`mode` bundled three separate decisions into one dropdown, and it showed: `count` was a live
setting in three of its six values and dead in the other three. Same fault as an effect welding
a target to a treatment — one control doing several jobs, so it means something different
depending on where you are standing.

| | |
|---|---|
| **Slice** | what one piece is: `word` · `paragraph` · `sentence` · `whole` |
| **Length** | `any` · `short` · `long`, filtering the pool |
| **Take** | how many pieces, in total across blocks |
| **Pick** | `random` · `order` · `position`, and a position when it is one |

`slice` is deliberately the same word a layer's target uses, and means the same thing: a
`paragraph` is one line of the source, a `sentence` is however many lines it runs to. The two
halves of the app finally agree on their vocabulary.

**Every control now means the same thing whatever the slice.** Take 3 with Pick at position 7
is three sentences from the seventh; change Slice to `word` and it is three words from the
seventh. Picking the Nth of something was not reachable at all before — `word` mode chose one
at random and ignored `count` entirely.

`pick: order` **replaces the "read in order" checkbox**, which was itself a modifier bolted
onto a mode. Reading the text is one of three ways of choosing from it, not a flag on top of
choosing.

The cursor for a reading is keyed by text, slice and filter together: a position among the long
sentences means nothing to a reading of the short ones. Within the same pool two presets share
it, so switching preset mid-poem changes how it looks rather than where it is.

*Whole* takes no other settings, and the editor hides them rather than showing controls that do
nothing — which is the fault this rework exists to remove.

*Migration:* every old `mode` maps across, including the two that were hardcoded to one piece
regardless of `count`, and both historical forms of `continuous`.

#### There are no stage effects left

Everything a preset does is a layer or a field. `EffectRef`, `Bindings`, `ambient`, the
`effects/` directory and the name-keyed `StageParts` map are all deleted, and `VisualPreset` is
now literally `PresetDoc` — a preset is one document, with nothing on the other side of the line.

That was the last critical finding of the architecture review, and most of it closed by
**deletion rather than conversion**. Nine stage effects existed; seven had no callers:

| | |
|---|---|
| `scroll` / `stopScroll` | the `scroll` **treatment** replaced them when motion became layers — but the old binding was left wired up, so `drift` had been running a conveyor *and* a whole-stage translate at once on held phrases |
| `columns` | `flow: 'columns'`, a preset setting rather than a random effect |
| `borders` | already a no-op: it wrote `data-borders`, which nothing has styled since the layout table went |
| `background` | a deliberate control (§13.3.1), which already said an effect must not overrule an explicit choice about output |
| `stopPulse`, `resetStage` | `applyPreset` resets what it owns, by construction |

Of the two that were called, `retext` became a text field (§12.3) and `pulse` became a
treatment. Which also settles a finding about stage effects having no ownership model: its
example was `resetStage` having to enumerate every property anyone might have set, and
`resetStage` was a function nothing called, clearing properties written by effects nothing
called.

**`EffectContext` fell from ten fields to four** — the typesetter, the channels, `dt` and
`barSeconds`, which is all a layer has ever read. The other six existed for the stage effects,
and were the reason a closure was always the path of least resistance: when the context is a god
object, nothing is ever forced into data.

#### Pulse is a treatment, with a rate

It scales the whole stage with the beat, and it was a layer-shaped idea sitting outside the
layer system for no better reason than history. Like the motion pair it has no target and writes
no channel; unlike them it is read from the grid every frame rather than applied once at
typeset, which is what keeps it smooth through a passage with nothing hitting in it.

**Not `swell` on everything**, which is the obvious question. Swell scales each targeted element
about its own origin, so glyphs fatten in place and the composition does not move; this scales
the container, so the whole picture zooms and blocks travel outward from centre. Swell also
rolls a fresh size per element and fires on a trigger with a decay, where this is one
deterministic curve applied continuously.

It takes `rateBars` like `flicker` does — 0.25 is a beat, 1 a bar, 4 a phrase. It arrived from
Acid welded to the beat and stayed that way while everything around it learned to be expressed
in bars. `Clock.phaseIn(bars, now)` is what makes a four-bar breath worth having: predicted from
the grid, so it stays in step through a passage where anything counted from transients would
drift.

*`decay` is deliberately discontinuous on the beat.* It arrives at full amount and falls away,
so the step at the boundary is the thing that reads as a kick. `sine` is the smooth one.

#### Motion, in two kinds — and both are treatments

Omitted from this section when the proposal was folded in, and therefore never built until it
was noticed missing.

**`scroll` and `travel` are treatments, so motion is authored in the same list as everything
else.** They began as their own pair of settings in the placement section, which meant two
places to look and two shapes of control for what is, from the VJ's side, one kind of
decision: pick a thing, say what it does. Choosing one in the treatment dropdown swaps the
row's controls for a direction and a speed.

What they do not have is a **target**. `scroll` moves the text through its block and `travel`
moves the block across the canvas; neither selects elements, so neither writes a channel and
neither decays — the editor hides the controls that would be meaningless, and the parser drops
a motion layer that carries no direction or speed rather than leaving it inert.

Where two of a kind exist, the **last wins**, matching the rule channels already follow.

#### Both kinds wrap

`travel` takes the same `continuous` modifier as `scroll`, and by the same construction: a copy
one canvas behind, and one cycle moving exactly that far, so as the block leaves the right edge
its copy arrives at the left and at the wrap the copy is standing where the original began.
Off, it crosses the frame once and is gone until the next typeset.

Measured on a wrapping block: the copy reaches the original's start position to the pixel, and
across a full cycle there is never a frame with nothing on screen.

`scroll` and `travel` **overlap** in the up and down directions, and that is fine. Scrolling
moves text through a stationary window; travelling carries the window itself. They coincide
only when the block already fills the frame — the same observation that made them two settings
in the first place — and diverge completely as soon as it does not.

`travel`'s wrap is **two toggles, one per axis** — `wrap side` and `wrap top` — rather than
borrowing `scroll`'s "loop". One control with the same name in two rows that behave differently
is a control nobody can predict, and the two duly got mistaken for each other. Only the axis
being travelled along does any work; the other is there for when the direction changes.

The copy needs the same treatment as the conveyor's: it is not in the registries and is never
targeted, and `Channels` mirrors every write into it. Line trimming mirrors too, since a copy
still showing a line its twin had hidden would give the trick away.

**An element can have more than one copy**, and missing that was a real bug. A wrapping
`travel` clones a block whose contents a seamless conveyor has already doubled, so there are
two levels of duplication and a *copy of a copy*. Pairings were held one-per-element, so the
second pairing silently replaced the first: with both running, the conveyor's copy stopped
receiving anything and arrived on screen as plain text. Pairings are now a list, and mirroring
follows copies of copies — with a depth guard, so a pairing bug cannot become a hang.

| Kind | What moves | Directions |
|---|---|---|
| **Content motion** | Text slides *through* a block that stays bolted to the frame — the conveyor | `up` · `down` |
| **Block motion** | The block itself travels across the canvas | `up` · `down` · `left` · `right` |

Like a ticker board: the board is bolted to the wall, the letters travel across it. Block
motion moves the board.

**They are the same movement and a completely different look.** That is not a contradiction
— it is the reason both exist. A conveyor is text passing a fixed window, so the frame stays
composed and only the words move; block motion is the window itself travelling, so the
composition changes and the text within it does not. The two converge only when the block
already spans the frame, because only then is the clipping window the whole picture.

Content motion is up and down only. Text scrolling sideways through its own box reads as a
fault rather than as an effect.

#### One speed unit, so the same number means the same velocity

Both are **fractions of the canvas per four beats**. Set to the same number they move at the
same pixels per second, whatever size the box is.

Measuring content motion against the *box* was the obvious alternative and is wrong: it would
mean a one-cell strip and a full-height column scrolling at visibly different speeds from the
same setting, and the VJ having to re-tune the number every time they changed a shape.

Content motion still *travels* one box, because text has to sweep through its own window and
a short strip would otherwise sit empty most of the time. Only the duration is
canvas-derived. Measured at 128bpm with speed `0.5`:

| Box | Height | Cycle | Velocity |
|---|---|---|---|
| Full-height column | 720px | 8.0s | **180 px/s** |
| One-cell strip | 103px | 1.14s | **180 px/s** |

**Both are CSS animations, and both are re-timed by `playbackRate` rather than by duration.**

That distinction is the difference between smooth and unusable. `animation-duration` does not
preserve position: the browser keeps the elapsed time and recomputes progress against the new
duration, so every change jumps. The tempo estimate drifts continuously, so `--bar` was being
rewritten most frames and the conveyor stuttered — worst exactly when the tracker was working
hardest. Measured on a 2s→1.5s change a third of the way through: rewriting the duration moved
the content **157px** in one frame; `updatePlaybackRate` moved it 4px, which is one frame of
its normal travel.

So the keyframes are written against a *nominal* two-second bar and scaled by rate.

**A block's speed is fixed when it is typeset and never changes while it runs.** A text lasts
a phrase or two — a handful of bars — and is rebuilt at whatever the tempo has become, so it
is never far out of step. The alternative is worse than the error it corrects: every
adjustment to a running animation is a chance to disturb it, and a conveyor is the one thing
on stage where a disturbance is unmistakable, because the eye is tracking a constant velocity
and notices any departure from it. Nothing touches a moving block between typesets, so nothing
can make it stutter.

The smoothed tempo below still feeds flicker's period and the decay clock, where a step is
imperceptible.

**And that rate is chased, not set.** Preserving position is only half of it: a tap or a track
change moves the target a long way in one step — 128 to 174 is a 36% speed change — and
applying that instantly is a lurch even though nothing jumps. The running tempo eases toward
the target by closing a fixed *proportion* of the remaining gap each frame, so the move is
quick while the gap is large and settles gently as it closes.

A fixed rate of change would be wrong in both directions at once: slow enough to be smooth on
a track change is far too slow for a half-beat correction, and fast enough for a correction is
a visible step on a track change.

Measured over a 128→174 jump: 92% of the way inside a second, no overshoot, no reversal, and a
largest single-frame speed change of 1.3% — below what reads as a step. Identical at 30fps and
144fps, since the step comes from elapsed time rather than a frame count.

The motion animations are **cached** rather than queried each frame: `getAnimations` with a
subtree walks every descendant, and on a stage carrying hundreds of flickering characters that
is far too much to do sixty times a second. The set only changes when blocks are rebuilt, so
it is re-collected on typeset — which is also when new animations need bringing up to speed,
since they start at the nominal rate.

Flicker keeps its `--bar` duration: a strobe changing phase is imperceptible, and there can be
hundreds at once. The tempo write itself is also thresholded, since a live estimate never
holds still. The block's height
is written into it as a length *and* as a fraction of the canvas, because `calc` cannot
divide a length by a length — the duration needs the ratio as a plain number.

Not `translateY(100%)`, which resolves against the *content's* own height: a block holding
three screens of text would scroll three times as far for the same setting.

#### The conveyor loops, or passes through once

The same modifier again, on `contentMotion`. **Continuous** is a belt that never stops — the
point of a conveyor. **Off** is a single pass: the text enters from below the box, leaves past
the top, and is gone until the next typeset, which is a different effect worth having and the
cheaper one.

A seamless loop needs the text duplicated; there is no way round that. The objection was never
the elements — it was that a layer lighting 5% of words would pick words in each copy
independently, so the same word would flicker differently in its two halves and give the trick
away. So the copy is **not** in the registries and is never targeted; `Channels` mirrors every
write and every clear into it, which keeps the halves identical by construction rather than by
luck.

**The copies must be laid out exactly as the original was measured**, and getting that wrong
is what made an early version jump on every wrap rather than only when the tempo moved.

An absolutely positioned box resolves against its containing block's *padding* box. With
nothing positioned between the copies and `.block`, each copy came out wider than the in-flow
original by twice the padding, wrapped its lines differently, and so did not match the height
the travel had been measured from. The trap in fixing it: an animated `transform` *also*
creates a containing block, so once the animation started the correction applied twice and the
text sat inset by double the padding instead. `.block-content` is therefore made a containing
block explicitly, so the geometry is the same whether the animation is running or not — and
the switch to conveyor layout happens *before* the measurement, not after.

Verified across a tall narrow column and a wide short band: the copy's width is identical in
flow, absolutely positioned, and mid-transform, and the rendered gap between copies equals the
travel exactly.

**The passage repeats until it fills the box**, then once more. Travel is one text-height, so
every copy lands where the one above it began and the seam is never visible; the spare copy is
what covers the box while the first is leaving.

An earlier version used a single copy at `max(text, box)`. That never *jumps* — but a passage
shorter than its box left an empty stretch between the end of the text and the start of the
repeat, and a conveyor with a gap in it is a conveyor you can see the trick of. A 40px line in
a 720px column left 720px of empty belt.

The limit on repeats is **elements, not copies**, because that is where the cost is. One short
line needs nineteen repeats and costs almost nothing; a dense paragraph needs three and costs a
great deal. Capping the copies punished the cheap case and let the expensive one through. Half
the element budget, so a conveyor can never cost more in repeats than the text itself, with a
floor of two — one repeat is what makes it a loop at all.

**The budget rises as the type gets smaller**, and it has to. A flat cap ran out of copies
exactly when the text was small: shrinking the type shrinks the text height, so the number of
copies needed to fill the same box grows, while the elements per copy — the same words — do
not. The cap bound, the belt stopped covering the box, and a gap crossed the frame once a
cycle. Reported as scroll losing its smoothness on small text at 1080p, which is where the box
is tallest.

Inverse in the size, because the cost that matters is pixels painted and that falls as the type
shrinks, with a ceiling since nothing stops a preset asking for 8px. A dense split-chars passage
at 360 elements per copy in a 1080px box wanted 19 copies and could afford 8; it can now afford
29.

Widening the gaps between copies instead would have been cheaper and was rejected outright: a
conveyor with visible spacing in it is not the effect. Using the text height alone would leave a gap whenever
a passage is shorter than its box — the seam by another name. Verified: text taller than its
box and text shorter than it both land the copy at the original's start position, both moving
at the same velocity.

A single pass needs no copy at all, so it costs nothing extra.

**A trimmed line keeps its box.** `wholeLines` hides a line rather than showing half of one, and
it did that with the `hidden` attribute — which is `display: none`, so the line left the layout
and the passage got shorter *after* the belt had been measured against it. The belt carried on
moving the distance it had been told:

| flow | travel | content | paragraphs in view |
|---|---|---|---|
| `stack` | 8411 | 8411 | 8 |
| `wrapped` | 8554 | **811** | **0** |
| `columns` | 7319 | **764** | **0** |

`stack` never showed it because nothing was being trimmed there; `wrapped` and `columns` pack
paragraphs into rows, so far more of them straddle the box edge. `visibility: hidden` keeps the
box, and all three then agree.

**Order is load-bearing in `render`.** Growing a block re-wraps its text and changes its height,
and the conveyor's entire geometry comes from that height — so growth has to happen before the
belt is measured. It did not, at first, and the copies sat spaced for a passage three thousand
pixels taller than the one actually there. That is the third time in one increment that a step
inserted into this sequence broke a later one, which is what the architecture review's finding
about `Typesetter` doing five jobs is actually about.

*Block motion does not take the modifier.* A travelling block leaves the frame and re-enters
from the other side either way, so there is nothing to choose.

*Not built:* per-element motion. Moving a block is one transform; making individual words
drift is one per element, and at a few thousand elements that is where the frame rate goes.

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
  size: { min: 0.7, max: 1.6 } }
```

Both ends earn their place. The maximum stops a word overrunning the block; the minimum stops
it shrinking past legibility on a projector at the back of the room. The scale is **rolled
within the range each time the layer fires** — the same rule every other pair of bounds in this
design follows.

**Base size** is not a layer. It is how big the text is, and it should not need a trigger or a
decay to set it. It lives on `text`, is rolled once at typeset and never touched again:

```ts
size: { min: 40, max: 40 }                    // uniform, as `fontScale` is now
size: { min: 28, max: 52 }, varyBy: 'word'    // every word its own size
size: { min: 28, max: 52 }, varyBy: 'char'    // ransom-note
```

Without `varyBy` the block picks one size and everything matches; with it, each word or
character rolls its own.

#### No continuous following: triggers and rolls, nothing else

Every rate and quantity in this design is one of two things — **a trigger fires it**, or **a
roll within bounds sets it**. Nothing tracks live audio continuously.

That removes `follow: 'energy' | 'bass'`, which scaled how much an effect did by the live
signal. It had exactly two consumers: `glitchWords` multiplying its amount by
`0.4 + 0.6 * energy`, and `swell` sizing by `0.5 + bass`.

**It was doubling up on something the triggers already do.** In a breakdown the kick stops, so
kick-triggered layers stop firing, so the visual thins out on its own. Scaling the amount *as
well* meant intensity was governed in two places at once — which is exactly why a preset was
hard to reason about, and why "turn this down a bit" was not a thing you could actually do.

With a per-layer amount and a per-layer decay, the VJ says how much and how long. That is
finer control than an automatic curve, and it is predictable, which an authoring tool needs
more than it needs cleverness.

It also makes the design consistent: base size, block shapes and swell bounds are now all the
same rule — *roll within these bounds* — rather than three superficially similar fields with
different behaviour.

> `energy` and `bass` stay on `EffectContext`. The analyser computes them for the meters
> regardless, and structure detection (§10.1) will want them. They are simply no longer wired
> into what layers do.

#### The energy tag is a label

`EnergyTag` — `'sparse' | 'mid' | 'peak' | 'any'` — stays, and stays **exactly as inert as it
already is**. `PresetBank.takeNext()` has never read it; it reaches the control window for
display and nothing else.

Confirmed as the intended design rather than an omission: it is a label the VJ applies to
organise their own presets. With per-layer control over targets, amounts and decays, an
automatic energy rating has nothing left to decide that the preset does not already say
outright.

**This changes what Increment 5 is.** Its premise was "activates the `energy` tags already
present on presets". Structure detection is still worth having — knowing a breakdown from a
drop is real information — but it will have to act on something other than a tag-to-preset
mapping. Left open rather than redesigned here.

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

#### No general "amount"

A layer has no strength dial. A treatment is a switch — a half-applied inversion is not a
thing — and *how much* is the target's business: 5% of words rather than 40%. The treatments
that do carry a quantity carry a specific one, `size` for swell and `rateBars` for flicker.

`amount` existed on `LayerSpec` for a while, was passed through every call, and was read by
nothing. Removed rather than wired up: a second knob meaning roughly "strength" alongside the
target proportion is how presets got confusing in the first place.

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
separately. The mask says where blocks may start; `blockShapes` says how big they are.

#### Shapes are a list, so width and height stay coupled

Width and height are each a min and a max in cells, rolled per block on every typeset — the
same treatment base size gets (§11.5), for the same reason: a shape that varies within bounds
you set is a look, where a fixed one is a setting.

But rolling the two axes **independently** does not work. `cols 1–7, rows 1–7` gives a
rectangle anywhere in the bounding box, so a preset asking for columns and bands will keep
producing square blobs in between. "Tall or wide, never square" is a constraint two independent
ranges cannot express, because the whole point is that the choices are *related*.

So a preset holds a **list of candidate shapes**. One is chosen per block, then rolled within
its own ranges:

```ts
blockShapes: [
  { cols: { min: 1, max: 1 }, rows: { min: 4, max: 7 } },   // a tall column
  { cols: { min: 5, max: 7 }, rows: { min: 1, max: 2 } },   // a wide band
]
```

Width and height are now picked *together*, as a pair that was authored to make sense. There is
no blob, because no entry describes one. Weighting is by repetition, the way `LAYOUT_SETS` did
it — list the column twice to see it twice as often.

**This introduces no new concept.** Presets already roll from lists: texts (§11.7), spawn cells,
and previously the layout set. A single fixed shape is a one-entry list, and `min === max`
inside it pins the size exactly.

#### Which also puts different shapes on stage together

With two or three blocks, each draws from the list **independently** — so a tall column and a
wide band can be on the canvas at the same time, one beside the other. That is a composition the
3x3 grid could not produce at all, since every block there got a cell of identical size.

Not forced to be distinct. Two blocks may both roll the column, and that is a real look rather
than a failure — the same reasoning as the text lists (§11.7): random still produces the
one-each case often enough to show whether it is worth making explicit.

#### Why the shapes are reachable at all

The non-square cells work in our favour here. A one-column block seven rows tall is about **14%
of the frame wide and its full height** — a genuinely narrow vertical column of text. A
seven-column block one row tall is full width and 14% high — a band. Neither was reachable on
the 3x3 grid, because a third of the stage is neither narrow nor short. The shapes did not
become configurable; they became *possible*.

**Clamped to 1–7, and clipping stays visible.** A tall narrow column holding three sentences
will overflow, and §12.4.1's rule still applies — the block clips and the count is reported,
rather than text quietly going missing. Worth pairing narrow shapes with a smaller `count` in
the preset's text settings.

#### Overlap is allowed, and avoided anyway

Anchor semantics permit two blocks to collide: the VJ picks the anchor and the size, and the
app is not going to second-guess either. But permitting it and *choosing* it are different
things, and the shapes in a preset are **authored** rather than arbitrary — so a
non-overlapping arrangement nearly always exists, and finding it costs nothing at typeset
time.

So `avoidOverlap` is a preset setting, **on by default**. Measured over 4000 typesets with the
built-in shapes, it is not a marginal fix:

| Preset | Overlapping typesets, off | On |
|---|---|---|
| `scatter`, 2 blocks | 46.0% | 0.0% |
| `swarm`, 2 blocks | 69.3% | 0.7% |
| `scatter`, 3 blocks | — | 0.1% |

**Placing the blocks one at a time was a bug**, and it survived those numbers because the
built-in shapes are small enough to hide it. The first block took a blind roll and only later
blocks searched, so a first block that landed badly could make a clean arrangement impossible —
and nothing ever went back to move it. Two full-height blocks can only sit side by side; roll
the first into a middle column and the second has nowhere to go, however exhaustively it looks.
Found by a preset with two full-height travelling blocks, which is exactly the shape that
exposes it.

Placement is now **one decision rather than a sequence of independent ones**: random whole
arrangements first, so the ordinary case draws anchors and sizes exactly as it always did and
is simply rejected if it collides, then a backtracking search over every distinct box the mask
and shapes allow, then overlapping. Over 3000 typesets of the case that found it:

| Shapes | One at a time | As an arrangement |
|---|---|---|
| two full-height | 13.9% | **0%** |
| two full-width | 14.5% | **0%** |
| three full-height | 8.2% | **0%** |
| two blocks that cannot both fit | 100% | 100% |

The last row is the point of the exercise: an arrangement that genuinely does not exist still
overlaps. The search considers every size in a shape's range rather than one rolled size,
because it only runs when the rolled sizes did not fit — and it is bounded by a node budget, so
a pathological mask cannot stall a frame. Worst case measured at 0.03ms.

**It changes which placement is chosen, never whether one happens.** If nothing fits — the
mask is tight, the shapes are large, or there are simply too many blocks — the block is
placed anyway and overlaps. A colliding block is a visible compromise; a missing one is
indistinguishable from text that failed to render (§14).

Turn it off for a preset where blocks piling up *is* the look.

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

#### The box is a minimum, not a cage

A cell is a seventh of the frame. At a size chosen to be readable on a projector one word is
easily wider than that, and three rules follow, in this order:

**Text may leave its box.** Clipping meant a long word — sometimes a whole line — silently did
not appear, and a `swell` near an edge lost its side. The grid decides where a block *starts*,
which is what anchor semantics rest on; it was never meant to decide what fits.

A conveyor still clips, because it is a window and that is what makes it one — but only on the
axis the text travels. `clip-path` rather than `overflow`, because CSS will not give one axis
`hidden` and the other `visible`: setting either turns the other into `auto`, which clips just
the same.

**A block grows until its longest word fits**, away from the edge its alignment is anchored to,
capped at the frame. Without this a block disagrees with itself line by line: `text-align`
positions a line's content inside its line box, but a word wider than the line box always
overflows toward the **inline end** — rightward — whatever the alignment says. So in a
right-aligned block the lines that fit hug the right edge and the lines that do not start at the
left edge and run off the other side.

Measured on a one-cell column at 50px on a 1920 frame: box `1646..1920`, text `1660..2058`,
off the canvas by 138. Grown, it is box `1493..1920`, text `1507..1906` — the right edge kept,
the overhang inside the frame.

**Whatever still leaves the canvas is nudged back.** Measured rather than reasoned about, which
is what makes it universal: working out which way text overhangs from `align` is four rules to
keep in step, five with `justify`, which behaves like `left` only for the lines it cannot
stretch. Reading the painted rectangle is one rule for all of them, and it accounts for `swell`
and any other transform for free.

The move is the smallest one that works and never more than flush with the edge it was leaving.
Text wider than the whole canvas keeps its opening — bringing one edge in pushes the other out,
and the beginning is the half you cannot do without.

*Never vertically for a conveyor.* Its content is deliberately several canvases tall and
deliberately outside its box; measuring all of it and concluding the block is misplaced shoved
it off the bottom of the frame.

*Words, not lines.* A `<p>` is a block box that takes the width of its container, so an
inline-block word wider than that hangs out of it and the line's rectangle does not include the
thing being measured.

#### Flows take no parameters

`columns` is two columns and `wrapped` breaks at a quarter of the block, both hardcoded and both
inherited from the layout table. Neither became a setting, and neither should.

A flow says *how paragraphs sit inside a block* and nothing else. Anything you would reach a
column-count slider for, the block system already does better: two blocks are two columns you
can also anchor, size, target and animate separately. A setting would be a second and weaker way
to reach the same picture, which is how the layout table got to eighteen entries.

#### `align: auto` sets a block toward the nearer edge

A fifth option beside left, centre, right and justify, not a mode. Text throws inward: a block
anchored at the left sets left, so a long word extends into the frame rather than out of it.

By the block's **centre** rather than its near edge, or every block would be left-aligned however
far it reached. With a dead zone in the middle, or a block straddling the centre would swap
alignment between typesets over a few pixels, which reads as a fault rather than as an effect.

#### Whole characters only, and a nudge

Two settings, both about the edges of a block.

**Whole lines and whole characters.** A scrolling block otherwise shows a half-height line at
the top and bottom of its box, and a block at the frame edge shows a clipped letter. Turned on,
anything not fully visible is hidden rather than drawn — `hidden`, not removed, so a layer that
owns the element keeps its ownership and the line returns intact when it fits again.

**Nudge.** Anchors are grid cells, which is deliberately coarse. Four pixel offsets — up, down,
left, right — move a block off its anchor without giving up the grid: fine control where you
want it, nothing to think about where you don't.

#### A mask may be empty, and says which one is empty

Clicking the last allowed cell, or inverting a full grid, used to be refused. The reason given
was that an empty mask skipped every preset and left the stage blank with nothing to explain
it — which was true when the only message named the global mask whatever the cause.

There are **three ways to have no cells**, and they are fixed in different tabs:

| | |
|---|---|
| The global mask is empty | nothing at all can be placed — Canvas tab |
| The preset's own grid is empty | only this preset — Presets tab |
| Both have cells but they do not overlap | the global mask being absolute — Canvas tab |

With those separated, empty is a reachable state, which it should be: clearing the grid is a
reasonable thing to do on the way to choosing somewhere else, and a control that silently
declines the last click is worse than one that lets you see what empty looks like.

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

**The global mask is absolute.** It is the VJ's statement about tonight's frame, and a preset
cannot widen it, work around it, or fall back past it — a preset's mask only ever narrows it
further. A preset works in the overlap and nowhere else.

So an empty overlap means the preset genuinely cannot be placed, and the honest response is to
say so rather than quietly substitute a placement nobody asked for. Falling back to the global
mask was tried and rejected for exactly that reason: it put text somewhere the preset had not
chosen, which is a stranger outcome than showing nothing.

**The message names the global mask, plainly**, and points at the tab that fixes it. The
preset's own grid is the one open in the editor and the two grids look identical, so anything
vaguer sends you to widen the mask that was never the problem.

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

### 12.2 Element effects — replaced by §11.5

The old effects fused a target and a treatment together: `glitchChars` could only pick
characters, `invertBlock` could only invert. Layers separate the two, which is what made
"invert every instance of the letter e" expressible at all.

The migration is done, so the table of what became what has gone with the code. One effect was
dropped rather than translated: `addLink`, which turned words into Google search links —
unclickable on a projector.

### 12.2.1 Holding, and the pulse

**Held phrases need more happening to them.** Text that stays for two phrases reads as a stall
unless the preset does something about it, and each does so in its own character: `scatter`
corrupts more, `drift` starts scrolling, `swarm` glitches whole paragraphs, `still` turns over
two words.

This was a wrapper effect, `whenHolding([...])`, which detected a hold by noticing that
`textAge` had not been reset — and therefore had to be ordered after `retext` in the lane, which
was invisible from reading either effect. It is now the `held` trigger (§11.5), dispatched once
after the phrase bindings with a fresh context. Same behaviour, no ordering rule.

**`pulse({ amount, shape })`** scales the whole stage with the beat. Driven by the predicted
grid rather than detected onsets (§9.3), so it lands *on* the beat and keeps breathing through a
passage with no transients at all. `decay` hits hard and falls away, reading as the kick; `sine`
breathes evenly and suits slower presets.

Amounts want to be small. 0.02 is clearly visible at 720p; past about 0.05 it stops looking like
a pulse and starts looking like a fault.

### 12.2.2 Why the remaining effects are still functions

An effect has no identity worth naming: one method, no shared implementation, and no state
beyond the parameters it was built with. A class would add a name, a constructor and a field to
hold one number.

**That stops working the moment effects need to be data.** A closure cannot report its own name
or parameters, so no UI can be generated for it and no preset containing one can be written to a
file. That is why layers are data (§11.4) and what is left here is not.

What is left is genuinely stage-wide — pulse, the stage-scroll used on held phrases, colour
wave — where there is no target to aim at and nothing for the editor to show.

### 12.3 Text selection

Four independent settings now — slice, length, take and pick — described in §11.5. Three things
from the original design survive the change and are worth keeping written down.

**Sentences can span lines.** They are found by scanning for a terminating `.`, `!` or `?`, so
the prologue's 53 lines become 34 sentences of 3 to 27 words.

**The element budget is checked between pieces, never inside one.** A sentence renders whole or
not at all. The first always renders even if it alone exceeds the budget — a blank stage is a
worse failure than a busy one.

**`word` is the one deliberate fragment.** Selecting by word count produced text ending
mid-thought, which reads as a bug rather than an effect. A single isolated word reads as
emphasis instead, because nothing is obviously missing.

Alongside them, `splitChars` decides whether each glyph is its own element. It governs whether
character-level effects are possible at all, and it has real performance cost (§14).

**How long a passage holds is a field too.** `text.hold` is a range in phrases, rolled fresh
each time — a fixed hold is legible but predictable, and you begin anticipating the change.

It was `retext({ hold: [1, 2] })`, a closure bound to the phrase trigger and *identical in every
preset* — not because one to two phrases suits all of them, but because it was written in
TypeScript where nobody could reach it. `still` is the sparse, near-motionless preset and had
been changing text as often as `swarm`. `minPhrases`, how long the preset itself stays, was
stuck in the same place and is a field now as well.

### 12.4 Layout effects — replaced by §11.6

The `layout` slot and its numbers `0..17` are gone, along with `newLayout`, which picked from
them, and `fontScale`, which is now a text setting with a min and max. Most of that table turned
out to be typography wearing a placement name.

Never coupled to placement, and unchanged: the colour wave (§12.5). `columns` survives as a
**flow** rather than an effect; `borders` and `background` are gone (see §11.5).

**`grid` is gone too**, and it was the last survivor of the table. It welded an arrangement to a
*decoration*, and the decoration half is `outline`, a treatment that already exists. Its column
count came from `minmax(6em, 1fr)`, so scaling the type for readability silently changed the
layout. And once a block grows to fit its longest word (§11.6), subdividing it into columns puts
that word back outside a cell — measured at an 811px line in a 420px cell, crossing its own
outline. `wrapped` gives the arrangement and one `outline` layer over paragraphs gives the
boxes, with the option of outlining only some, or on a trigger, or with a fade.

**The flows were being applied to the wrong element**, which is older than any of that. They set
`display: flex` or `display: grid` on `.block` — and `.block` has exactly one child. The
paragraphs live two levels down: `.block` holds `.block-content`, which holds `.loop`, which
holds the text. So the flex container had nothing to wrap and the grid had nothing to lay out;
both were arranging the conveyor's wrapper. That is why `grid` never looked like a grid. They are
on `.loop` now: 58 paragraphs across 7 rows where before each had a row to itself. `stack` and
`run-on` were never affected — they set `display` on the paragraph itself, which works wherever
it sits.

There are now two things called scroll and it is worth being clear which is which: the layer
treatment (§11.5) moves text through one block, and the older stage effect scrolls the whole
stage. Only `drift` still uses the stage one, on held phrases.

Two rules carried forward from the old block model:

- **Take is a total across blocks, not per block.** Passing the full count to each was a bug —
  two blocks asking for four sentences produced eight, crammed into cells a third of the stage
  wide, with the surplus silently clipped.
- **Blocks must clip, and say so.** §14 says nothing is lost silently, so the number of clipped
  blocks is reported to the control window.

*No longer a guarantee:* that blocks cannot overlap. That followed from one block per cell,
which a 7x7 grid gives up. `avoidOverlap` (§11.6) searches for a non-colliding arrangement
instead, and is on by default.

### 12.4.2 Size floor — **a principle, not a check**

Small type fails twice over: it is unreadable on a projector at the back of a room, and a
visualiser warping the output (§13.4) smears fine detail into mush within a frame or two. Fewer,
larger words survive both. Selection counts were cut accordingly — passages are two or three
sentences, not ninety words.

This used to say "nothing renders below about 76% of the base size, and the base is 28px", which
was true in Acid and has not been true here for some time. **There is no such check anywhere in
the code**, and the sentence had survived as an assertion about behaviour that nothing enforced
— which is worse than saying nothing, because it is the kind of guarantee someone would build
on.

What exists now is better suited to the problem anyway: base size is a per-preset range with its
own bounds (§11.5), the editor holds a typed value to those bounds, and a block **grows to fit
its longest word** rather than shrinking type to fit a cell (§11.6). Sizes in use run to 50px,
well clear of any floor. If one is ever wanted it belongs in `presetIo`'s clamp, where the rest
of the bounds live.

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

#### Position and size are remembered

OBS captures this window by its rectangle, so where it is and how big it is are part of a
working setup rather than a convenience. Losing them on every launch means re-cropping the
source in OBS every time — exactly the setup work this app should be doing once.

Written to `stage-window.json` in app data on every move and resize, debounced so a drag is one
write rather than a hundred, and flushed synchronously as the window closes: a size typed in
seconds before quitting is precisely the one worth keeping.

Read back through the same guard that has always protected the control window. A saved position
is checked against the displays that exist **now**, and a window that would land on a monitor
that has since been unplugged is recentred on the primary instead. Anything unreadable — a
half-written file, a hand-edit, a leftover from an older version — falls back to the default
rather than opening a window at NaN.

Verified all three ways: a restart restores 960x540 at 300,180; a truncated file opens at the
default; and a position at 99999,99999 comes back centred on the primary display.

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
| **Placement** — the global mask | Other visuals usually put their subject in the middle of frame. Clearing the centre cells keeps it free and works around it (§11.6) |

Two things had to learn about these rather than assuming: colour is based on the stage
foreground instead of hardcoded black, which would blank the stage on a dark background; and the
`background` flip does not run unless the mode is white, because an explicit choice about output
should not be overruled by an effect.

The mask applies immediately on change rather than at the next bar — if text is
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

#### Tests

`vitest`, node environment, no DOM. 147 tests across eight suites, gating the build.

Everything worth testing here is already DOM-free, and that is not an accident — the clock, the
kick evidence, the placement grid, the preset validator and the cycle policy are all pure. What
the suite is *for* is the invariants the comments state, because those are what quietly stop
being true:

| Suite | What it holds down |
|---|---|
| `mask` | a block never runs off the canvas, an intersection can only narrow, blocks are placed as one arrangement |
| `tempo` | a breakdown cannot move the grid, an intro of hats moves nothing, a pitch nudge drifts rather than snapping |
| `presetIo` | a corrupt file loads as something usable, decay is frame-rate independent |
| `wiring` | a layer edit does not re-typeset, the right mask gets blamed |
| `PresetBank` | the last enabled preset cannot be switched off, a queued choice beats the timer |
| `pulse` | the curve peaks on the beat and never exceeds its amount; `sine` is continuous where `decay` is not |
| `fit` | the smallest move that works, and it is idempotent — a second pass must not walk the block across the frame |
| `align` | symmetrical about the centre, and steady for a block straddling it |

Two of those record **deliberate reversals** — a mask may now reach empty, and blocks are placed
as an arrangement rather than one at a time. Until they were written down, the only record of
which behaviour was current was the comment beside the code that had just changed.

Cases are named after the behaviour, not the constant they exercise. The tempo numbers have been
retuned twice and will be again; "a breakdown must not move the grid" is the thing that has to
stay true.

**What a unit test cannot see.** Three geometry bugs shipped in one session — a conveyor
shoved off the bottom of the frame, a measurement pointed at the wrong element, a belt spaced
for a passage that no longer existed — and none of them was a failure of the rule being tested.
`shiftInto` was correct; what it was aimed at was not. Those were found by instrumenting the
running app and reading the numbers, which is the tool for that class of bug, and the tests are
what made changing the surrounding code safe enough to do it.

#### Build guards

`npm run typecheck` runs four things: the compiler, two scripts that catch mistakes types cannot
see, and the tests.

- **`check-ids`** — every element id the renderer looks up exists in the HTML. A renamed id
  otherwise fails silently at runtime.
- **`check-animations`** — every CSS keyframe is matched by the code that drives it, and the
  other way round. Added after a keyframe rename left the wrapping motion unmatched by the
  pattern that re-times animations to tempo: it kept animating, at the wrong speed, and
  restarted on every re-typeset. Nothing in the type system could have caught that.

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

- **2a — the layer engine — done.** Targets, treatments, triggers and channels (§11.5).
  Built-ins ported unchanged so the port can be checked against what they look like now.
  Decay moved to per-layer and to bars, fixing the frame-rate dependence.

  Two live bugs went with it. Decay ran per *frame*, so 2.4% of lit elements survived a
  second at 60fps against 15.6% at 30 — a six-fold difference in fade speed depending on how
  busy the machine was. And `whenHolding` fired on the phrase where the text was *replaced*
  as well as on held ones: its own comment insisted that ordering within the lane prevented
  this, but the effect context is a snapshot taken at the top of the frame, so ordering could
  not have mattered. It is now a real `held` trigger dispatched with a fresh context after
  the phrase bindings — the only point at which a re-typeset is observable — and
  `whenHolding` is deleted.

  Two accepted deviations from the old look: `decor` variant 4 was italic and there is no
  italic treatment, and `swell` was a bass-scaled `min-width` floor where it is now a
  transform rolled within bounds (§11.5).
- **2b — the spawn grid — done.** 7x7 mask, anchor plus shape list, global mask in the
  canvas tab (§11.6). `LAYOUT_SETS`, `LayoutSetName`, `layouts.ts`, `newLayout`, the
  `fontScale` effect and every `[data-layout]` rule are deleted; `align`, `flow` and base
  size replace them. Base size gained `varyBy`, so §11.5 is complete too.

  The mask editor went into the Canvas tab as a clickable 7x7 grid, aspect-correct at 16:9
  so it reads as a picture of the frame rather than an abstract matrix. The per-preset mask
  gets its own grid in the Effects tab in 2c; until then a preset's `spawn` is authored in
  TypeScript and the global mask is what is adjustable live.

  **One guarantee was deliberately given up:** a block may extend past the mask, since the
  mask constrains where it starts rather than where it ends.

  Overlap was given up too and then largely won back. §12.4.1 promised non-overlap "by
  construction", which held only because each block took a distinct cell of a 3x3. Anchors
  cannot promise that — but `avoidOverlap`, on by default, searches for an arrangement that
  does not collide and finds one nearly always. Measured at 46% of `scatter` typesets and
  69% of `swarm` typesets overlapping without it, which was too high to leave.
- **2c — live editing — done.** A **Presets** tab rather than the Effects tab: a preset list
  beside a form for text, placement and layers. A preset splits into a serialisable document
  and its stage effects, which are closures and stay engine-side, merged back by name.
- **2d — saving — done.** One JSON file per preset in writable app data, seeded from the
  compiled built-ins on first run, debounced 600ms and flushed on close. Validation on load
  reports every correction by name and keeps as much of a preset as can be understood.
  Per-preset text lists and delete protection landed with it (§11.7).

- **2e — the gaps — done.** Three things §11.5 described that the first four stages did not build:
  the `sentence` slice (deferred in 2a because sentences had no wrapping element, and the
  layout CSS that made adding one risky was deleted in 2b), the `always` trigger reaching the
  editor, and **motion**, which was dropped when the proposal was folded into this document
  and so was never scheduled. `LayerSpec.amount` was removed rather than wired up.

**Increment 2 is complete.** What it cost that was not planned: four treatment bugs found by
using the editor for five minutes (a colour-slot selector outranking the channel, so `accent`
did nothing and word-level `invert` was black-on-black; `text-decoration` not crossing into
inline-block characters; a dingbat font that does not exist on Windows), a stale-closure bug
that reverted a layer's triggers whenever its treatment changed, and flicker running at a
fixed wall-clock rate despite §11.5 having decided otherwise.

#### After 2e

Motion is where the time went, and none of it was in the design — it was in making the motion
*hold together* once it existed.

- **Colour became a layer.** `colourShift` was a stage effect writing colour whenever it liked,
  which meant a word could change colour while it sat on screen. Colour is now decided at
  typeset and only changed by a layer that owns the channel (§11.5). The palette binds to the
  preset rather than the phrase, so switching preset changes the colours and holding text
  does not.
- **The conveyor got a real loop.** A duplicate of the content one length behind, with channel
  writes mirrored to it, its scroll position carried across a re-typeset, and enough copies to
  fill the box rather than a fixed number. Four separate causes of the same visible stutter,
  found one at a time.
- **Travel wraps too**, in all four directions, by a copy of the block one canvas behind. Its
  wrap is separate from the conveyor's loop, because a preset can want one and not the other,
  and an element can now have several copies rather than one.
- **The global mask is absolute.** A preset works in the overlap and nowhere else; if the
  overlap is empty the preset is refused, and the message names the global mask rather than
  saying something cryptic about cells.

### Increment 3 — detection hardening — **started**

Confidence scoring, octave correction, faster re-lock on track change, downbeat and phrase
heuristics, behaviour through breakdowns and silence.

**Done so far:** the kick decides whether a tempo change is believed (§9.2.4). Strength against
its own recent typical, agreement between the kicks and the tempo being proposed, and a bar that
rises with the size of the jump because DJs beatmatch. Three observed failures drove it — a
breakdown re-locking the grid to a shaker, a minute-long intro of hats and snares jumping 130 to
170 on a track that was 130, and then the rule being strict enough that a real house-to-DnB
change did not take. A tap now hands control back to detection when the two agree, which is the
manual way past the same problem.

### Architecture review — **all criticals closed**

An outside review of the branch, against §7 to §16. Twelve findings, three marked critical, and
they were taken in the order that made the work cheapest rather than the order they were listed.

**Tests first, not the refactor first.** The intuition was that restructuring the engine would
make it testable — but all six modules worth testing import nothing from `main.ts`; they were
leaves already. The one that genuinely could not be tested was blocked by `localStorage`, not by
the engine. And the dependency runs the other way round: the tests are what make it safe to
restructure a thousand-line file. Doing it in that order meant every step of the refactor was
checked rather than trusted.

| | Finding | |
|---|---|---|
| 01 | A preset is only half a document | **closed** (§11.5) — mostly by deletion |
| 02 | `main.ts` is a module-scope singleton | **closed** (§7.1) |
| 03 | No tests, on a codebase built to be tested | **closed** (§15) |
| 05 | `ALL_CHANNELS` is a union maintained by hand | **closed** — derived from the treatment table |
| 06 | The wire protocol imports the domain | **partly** — `PresetDoc` has a version and an ordered migration chain; the import direction is untouched |
| 09 | Stage effects have no ownership model | **moot** — its example was a function nothing called |
| 10 | Persistence is scattered `localStorage` | **partly** — three classes take a port; the keys are still scattered |
| 11 | Unreferenced exports | **partly** — seven stage effects deleted |

**01 was the interesting one, and it was smaller than it looked.** The review scoped it as
converting nine stage effects to data. Seven had no callers at all, so they were deleted; of the
two left, one became a field and one became a treatment. Reading the code before planning the
work turned roughly a day into an afternoon, and closed 09 and part of 11 on the way.

**The version field came first, deliberately.** Making stage effects data changes `PresetDoc`'s
shape — that is a migration, and there were already two, both detected by sniffing for a field
the old format happened to have. Sniffing works exactly once. Building the ordered chain
immediately before the migration that needed it is the whole reason 01 went in the order it did.

04, 07, 08 and 12 are open. **07 is the one that has cost something**: `Typesetter.render` is a
sequence where each step reads a layout the one before it settled, enforced only by comments, and
three separate bugs this increment came from inserting a step into the middle of it.

### Increment 4 — palettes

Palette presets with roles (text, background, accent), selectable, optionally shifting with
energy.

### Increment 5 — energy and structure

Breakdown, drop and build detection from low-band energy (§10.1), so the visual responds to
arrangement rather than just pulse.

**Premise needs rethinking.** This was going to activate the `energy` tags on presets. Those
are now a label the VJ applies and nothing else (§11.5), so structure detection has to act on
something else — a preset change, a decay multiplier, a mask swap. Worth deciding after the
layer system has been used, not before.

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
| Rolling block width and height independently | **Dropped** | Produces square blobs between the column and band that were wanted; the axes are related, so they are chosen together from a shape list (§11.6) |
| `follow: 'energy' \| 'bass'` — continuous audio scaling per layer | **Dropped** | Doubles up on the triggers, which already thin out when the kick stops. Governing intensity in two places is why presets were hard to reason about (§11.5) |
| `whenHolding` as a wrapper effect | **Dropped** | It read a stale context snapshot, so it could not tell a held phrase from a replaced one. `held` is a real trigger dispatched after the phrase bindings (§11.5) |
| An energy rating that selects presets automatically | **Dropped** | Superfluous once layers are individually controllable. Stays a label the VJ applies; was never wired up anyway (§11.5) |
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
| `colourShift` as a stage effect | **Dropped** | Colour could change while text sat on screen. Colour is a layer like everything else (§11.5) |
| Motion as a document setting | **Dropped** | Two settings that behaved like layers but were edited somewhere else. `scroll` and `travel` are treatments (§11.5) |
| A preset overriding the global mask | **Dropped** | The global mask is the frame you have decided to use. A preset works in the overlap or is refused (§11.6) |
| Falling back to the global mask when a preset is blocked | **Dropped** | Silently doing something other than what the preset says. It is refused, and the message says why (§11.6) |
| An absolute threshold for kick strength | **Dropped** | A quiet master and a loud one differ by more than a breakdown and a drop. Relative to its own recent typical (§9.2.4) |
| Believing any confident tempo estimate | **Dropped** | Hats through a breakdown genuinely are periodic. The kicks have to agree with the tempo, not merely be loud (§9.2.4) |
| A one-minute kick history | **Dropped** | A section longer than the window becomes the window's idea of normal. Three minutes (§9.2.4) |
| Canvas bounds reset on every launch | **Dropped** | OBS captures the window by its rectangle; losing it means re-cropping every time (§13.1) |
| Placing blocks one at a time | **Dropped** | Greedy: a bad first placement made a clean arrangement impossible and nothing went back to move it. Placement is one decision (§11.6) |
| Refusing to let a mask reach empty | **Dropped** | Held only while one message named the global mask for all three ways of having no cells. Separate the messages and empty is fine (§11.6) |
| Widening the gaps between conveyor copies | **Dropped** | Cheaper than raising the budget, and not the effect. A conveyor with visible spacing in it is a different thing (§11.5) |
| Trusting `min`/`max` on a number input | **Dropped** | Advisory only. Every editor field read straight past them, and an empty field read as 0 (§11.4) |
| Manual holding after detection agrees with it | **Dropped** | Agreement *is* the track change, seen from the other side. Handing back makes a tap the fast way past a big jump (§9.2.4) |
| The engine as a module-scope script | **Dropped** | Initialisation order was acting as a constructor. Nothing could be built twice, injected into, or tested (§7.1) |
| Typecheck as the whole quality gate | **Dropped** | The invariants that matter here are stated in comments and are exactly what tests are for (§15) |
| `localStorage` reached directly | **Dropped** | It made pure decision logic need a browser. A two-method port instead (§7.3) |
| A hand-written list of every channel | **Dropped** | Adding a ninth compiled cleanly and left `clearAll` skipping it. Derived from the treatment table (§11.5) |
| Two sets of error handlers | **Dropped** | Not duplicates — one logged, one reported — so every error surfaced twice. One guarded pair (§14) |
| Stage effects as closures | **Dropped** | Seven had no callers, one is a field and one is a treatment. A preset is one document (§11.5) |
| Detecting an old preset by sniffing for a field | **Dropped** | Works exactly once. `version` plus an ordered chain (§11.4) |
| Blocks clipping their text | **Dropped** | The grid decides where a block starts, not what fits. It spills, and grows to its longest word (§11.6) |
| Reasoning about overhang from `align` | **Dropped** | Four rules to keep in step. Measure the painted rectangle instead (§11.6) |
| The `grid` flow | **Dropped** | Welded an arrangement to a decoration, sized its columns in `em`, and had been laying out the wrapper rather than the paragraphs (§12.4) |
| `display: none` for a trimmed line | **Dropped** | It leaves the layout, so the passage shortens after the conveyor was measured against it (§11.5) |
| `data-len` on every word | **Dropped** | Acid's long/short flag. The CSS that read it never came across, so it was an attribute per word that nothing has ever used |
| One resolution rule for every treatment | **Dropped** | `outline` draws a box, so "every paragraph" has to mean the paragraph. The rest mark type, and for those it means every word in it (§11.5) |
| A column count setting on the `columns` flow | **Dropped** | No flow takes a parameter, and blocks already give you columns you can place, size and target independently. A setting would be a second, weaker way to do it (§12.4) |

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
| Q12 | Are long sentences (up to 27 words) too dense at the new size floor, especially two blocks at once? | §12.4.2 |
| ~~Q16~~ | ~~A genuine hard cut of 30%+ takes ~12s to follow. Right trade, or should the top of the scale be softened?~~ **Answered: softened**, to 0.95 / 0.70 / 14 and 7.9s, after a real house-to-DnB change failed to take. A tap now also hands control back | §9.2.4 |
| Q17 | Should the control window's position be remembered too? Same few lines, but it hides to the tray rather than closing | §7.3 |
| Q18 | The conveyor budget fix is reasoned from the formula, not measured — the trigger is a rendered text height. Worth confirming on a 1080p stage with small type | §11.5 |
| ~~Q19~~ | ~~`wrapped` packs paragraphs at uneven widths, so `grid`'s even columns are gone. Worth a flow that does only that?~~ **Answered: no.** Even columns are what `columns` is for, and more of them is more blocks | §12.4 |
| Q20 | Growth happens after placement, so `avoidOverlap` cannot see it — two blocks in adjacent cells can grow into each other | §11.6 |
| Q13 | Pulse amounts are guesses (0.012–0.022). Worth tuning against a projector rather than a monitor — apparent scale changes with viewing distance | §12.2.1 |
| ~~Q14~~ | ~~Fork on editing a built-in?~~ **Answered: no fork.** Built-ins are editable directly; "Restore defaults" re-seeds them | §11.4 |
| ~~Q15~~ | ~~Do built-ins stay compiled?~~ **Answered: no.** Everything becomes data, for consistency. Type safety comes from `as const` definitions plus validation on load | §11.4 |
| ~~Q16~~ | ~~How do two layers on one element resolve?~~ **Answered: fine-grained channels** named after CSS properties. Different properties compose; same property, later wins | §11.5 |
| ~~Q17~~ | ~~Cap the number of layers?~~ **Answered: soft limit and a warning**, keyed to elements-touched-per-second rather than layer count. Never a hard cap | §11.5 |
| ~~Q18~~ | ~~Does `flicker` belong with the treatments given it is continuous?~~ **Answered: yes** — same authoring, CSS runs the animation | §11.5 |
| ~~Q19~~ | ~~Region targets?~~ **Answered: no** — replaced by the spawn grid, which was the actual intent | §11.6 |
| Q20 | Does `flow: 'columns'` need a tunable gap, or is one number enough to recover layout 12's look? | §11.6 |
| Q24 | Structure detection has lost its intended output now that energy tags drive nothing. What should knowing "this is a breakdown" actually change? | §10.1 |
| Q28 | Presets are saved but not versioned. A file written by a future build could lose fields on load — worth a version stamp before the format changes again? | §11.4 |
| Q29 | Text lists roll per block, so a preset with two texts and two blocks shows one each only by chance. Is explicit one-each worth an option? | §11.7 |
| Q26 | Variety now comes from anchors and shapes rolling per typeset, where `newLayout` changed the whole arrangement every bar. Is a per-typeset roll enough, or does something want to move on the bar again? | §11.6 |
| Q27 | `flow: 'grid'` and `'columns'` are implemented but no built-in uses them. Worth building a preset around, or do they only make sense once presets are editable? | §11.6 |
| Q25 | `whenHolding` fired on replacement phrases as well as held ones for the whole of Increment 1. Did the presets get tuned around that? If held layers now look thin, that is why | §11.5 |
| ~~Q23~~ | ~~Independent width and height ranges cannot say "tall or wide, never square".~~ **Answered: a list of candidate shapes**, rolled per block, so the two axes are chosen together as an authored pair | §11.6 |
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
