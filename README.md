# Symphony in Olib

*(working title)*

A live VJ tool. It listens to whatever audio is playing on the machine, works out the beat,
and generates reactive typography — which you capture in OBS, or send to a MilkDrop host
over Spout and let it warp the text.

Built to run unattended: start it, alt-tab to your DJ software, and leave it for the rest of
the set.

For *why* anything is the way it is — the architecture, the things that were tried and
rejected, the open questions — see [DESIGN.md](DESIGN.md). This file is just how to run it.

---

## Requirements

- **Windows 10/11.** System audio loopback and the window behaviour are Windows-specific.
- **Node 20+**
- No C++ toolchain, no native modules.

## Setup

```bash
npm install
npm run dev
```

If `npm install` warns about blocked install scripts, `electron` and `esbuild` both need
theirs — they download a platform binary. The approval is already recorded in `package.json`
under `allowScripts`, but if npm asks again:

```bash
npm approve-scripts electron esbuild
```

| Command | Does |
|---|---|
| `npm run dev` | Development, with hot reload. What you want almost always |
| `npm run typecheck` | Types, the two guard scripts, and the test suite. The gate |
| `npm test` | Tests only. Faster while iterating on one |
| `npm run build` | Typechecks, then builds to `out/` |
| `npm run preview` | Runs the built version |

`typecheck` is deliberately more than its name: `tsc`, then `check-ids` (every element id the
code reaches for exists in the HTML), then `check-animations` (every keyframe is driven by
something, and everything driven exists), then the tests. `build` runs it first, so a broken
build cannot be packaged.

Changes to `src/`, `style/`, `index.html` and `control.html` hot-reload. Changes to
`electron/` need a restart — that process owns the windows.

### Building an executable

```bash
npm run dist
```

Produces, in `release/`:

| File | Notes |
|---|---|
| `Symphony in Olib Setup <version>.exe` | Installer. Start Menu entry, desktop shortcut, uninstaller |
| `SymphonyInOlib-portable-<version>.exe` | Single file, no install. Slightly slower to start — it unpacks to temp each run |
| `win-unpacked/` | Unpacked, runs directly. What you want while iterating |

`npm run dist:dir` skips the installers and builds only the unpacked folder, which is much
faster.

**The build is unsigned**, so Windows SmartScreen shows "Windows protected your PC" on first
run — More info, then Run anyway. Nothing is wrong; a signing certificate costs a few hundred
a year and is not worth it for a personal tool.

Binaries are not committed. `release/` is gitignored and anyone can build their own from
source.

To use a custom icon, replace `build/icon.png` with a square PNG of at least 256x256;
electron-builder generates the `.ico` from it. `build/tray.png` is the tray icon.

---

## Using it

**Two windows.**

- The **canvas** is the output and nothing else — 1280x720 by default, no title bar, no
  chrome, no HUD. An OBS window capture of it needs no crop.
- The **control window** is everything you touch: readouts down the left, seven tabs on the
  right. Closing it does not quit — it hides to the tray, and the show carries on.

The canvas is frameless, so there is nothing to drag it by. Its position and size are set as
numbers in the **Canvas** tab, and both are remembered between launches.

It comes up already capturing, using whatever source it used last.

### Keys

| Key | Where | Does |
|---|---|---|
| `Space` | Either window | Tap tempo. First tap sets the downbeat |
| `Esc` | Either window | Hand tempo back to automatic detection |
| `Tab` | Canvas | Bring the control window to the front |

Tapping wins until detection agrees with it again, or until you press `Esc`. Space is a bare
key on purpose — reaching for a modifier mid-set means looking at the keyboard — so it stands
aside while you are typing in a text field or a dropdown.

### The tray

Right-click the tray icon for: show the control window, keep it always on top, centre the
canvas on screen, and quit. Double-click shows the control window.

Quit lives here rather than on the canvas, since the canvas has no title bar to close.

### Readouts

Always visible, whichever tab is open.

| Readout | Meaning |
|---|---|
| **BPM** / `est` | Locked tempo, and the tracker's raw reading. These disagreeing is meaningful — it means the clock is refusing a correction |
| **Source** | `detected`, `tapped`, or `none` |
| **Confidence** | How strongly periodic the audio actually is |
| **Preset** | Which one is running, and its energy tag |
| **Beat dot** | Flashes on the beat, ringed on the downbeat. The fastest way to see whether it is locked |
| **kick / snare / hat** | Band level. The band's name lights on a detected onset |
| **Status** | What is being captured, and at what sample rate |

`OBS crop`, `FPS` and `Clipped` are in the **Settings** tab. Clipped counts blocks whose text
does not fit; red means text is being lost, and the fix is a lower `take` on that preset.

### The tabs

| Tab | What is in it |
|---|---|
| **Audio** | Capture source, and the three onset sensitivity sliders |
| **Text** | The texts themselves — edit, add, import a file, delete. Apply lands on a phrase boundary |
| **Effects** | The preset list. A checkbox includes a preset in the automatic cycle; the arrow queues it for the next phrase. Disabled presets dim rather than vanish, since you can still trigger one by hand |
| **Presets** | The editor: text selection, placement, layers. New, duplicate, delete, restore defaults |
| **Canvas** | Canvas size and position, and the spawn mask — which cells text may anchor in |
| **Colours** | Palette and background |
| **Settings** | Crop, FPS, clipped count, key reminders |

Everything persists between launches.

---

## Output

### Into OBS directly

Add a **Window Capture** for the canvas window. It is exactly the canvas, so no crop is
needed — the `OBS crop` readout in Settings has the numbers if you want to check.

Set **Background** to `Transparent` in the Colours tab to composite the text over other
layers.

### Into MilkDrop / NestDrop over Spout

So the visualiser warps the typography rather than sitting beside it.

1. Install the [Off-World-Live Spout2 plugin](https://github.com/Off-World-Live/obs-spout2-plugin)
   for OBS.
2. Right-click the Olib source in OBS → **Filters** → add **Spout Filter**.
3. Point NestDrop at that Spout sender.
4. Bring NestDrop back into OBS as its own source.

**Use the per-source filter, not the global Spout output.** The global output publishes OBS's
whole program feed — which contains NestDrop — so NestDrop would feed itself, blow out to
white, and gain a frame of latency per round. The filter carries only the Olib source, so
there is no cycle.

Spout lives entirely in OBS. Nothing in this app knows about it, so if a sender does not turn
up in NestDrop, the filter is the place to look.

---

## Tuning

### Capture source

The **Audio** tab lists three kinds of source:

- **System output (what you hear)** — loopback. The default, and right almost always.
- **Input devices** — a line in, an interface, a mic.
- **Applications** — one running program's output on its own, so a Discord call or a browser
  tab never reaches the beat tracker. This path arrives as PCM over IPC rather than as a
  `MediaStream`, but everything downstream is identical.

### Onset sensitivity

Three sliders, one per band. The number is how many standard deviations above that band's
own recent average the flux must jump. **Higher is fussier.** Defaults: kick 4.0, snare 2.0,
hat 2.2.

The kick default is high on purpose. In 40–120 Hz a kick and a synth bass note are not
meaningfully different — both are real transients in the same band — so this is a fussiness
setting rather than a fix. Beat tracking tolerates the extra onsets; the indicator just looks
twitchier than it tracks.

### Compositing over other visuals

Two settings matter when the output sits over something busy:

- **Palette** — `mono` or `none` keep the whole typographic vocabulary and drop the accent
  colours, which are what usually clash.
- **The spawn mask**, in the Canvas tab — clear the middle and text keeps to the edges.
  Useful whenever your visuals (or a logo) live in the centre of frame.

The mask decides where a block *anchors*, not where it ends: a block is sized by its preset
and can extend past the cell it started in. A preset can narrow the mask further, never widen
it.

---

## Changing the text

In the app: the **Text** tab. Texts are files in the app's own data folder
(`%APPDATA%/Symphony in Olib/texts`), so they survive an update and you never edit the repo
to change what is on screen. Presets live beside them in `presets/`.

`presets/text/prologue.txt` in this repo is the *bundled default* — the one a fresh install
starts with. Editing it changes that, not what your copy shows.

**Selection works in whole sentences**, found by scanning for `.`, `!` or `?`. A sentence may
span several lines. Nothing is ever cut mid-sentence — if it does not fit the budget, it is
not shown at all.

Punctuation outside `A-Za-z0-9 !.?` is stripped, because stray commas become their own glyphs
in dense layouts and read as debris. That is why the text avoids contractions: `it's` would
become `its`.

---

## Licence

**This repository is public. It is not open source.**

The source is here to be read, not reused. All rights are reserved — see
[LICENSE](LICENSE). Making a repository public on GitHub grants every GitHub user the right
to view and fork it, and nothing beyond that; it is not a grant to use, run, or redistribute
the code.

Dependencies keep their own licences, all permissive (MIT, ISC, BSD, Apache-2.0). Nothing
here is under a copyleft licence, so none of them obliges this project to be open source.
`application-loopback`, the one runtime dependency, is MIT and ships inside the built exe —
distributing a build to anyone else means including its copyright notice.

---

## Layout

```
electron/       windows, permissions, loopback and per-application capture
src/
  Engine.ts     the show: one frame, one command switch
  main.ts       the canvas window's composition root
  control.ts    the control window's composition root
  audio/        capture, band analysis, onset detection
  time/         tempo estimation, the beat clock
  show/         presets, layers, channels, the spawn mask
  text/         loading, sentence grouping, typesetting
  render/       stage, palettes
  hud/          the control panel and the preset editor
  ipc/          the wire protocol between the two windows
  util/         random, settings
style/          base, stage typography, hud
presets/text/   the bundled default text
scripts/        the two build guards
```
