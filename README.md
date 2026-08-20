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
| `npm run typecheck` | Type errors only. Fast |
| `npm run build` | Typechecks, then builds to `out/` |
| `npm run preview` | Runs the built version |

Changes to `src/`, `style/` and `index.html` hot-reload. Changes to `electron/` need a
restart — that process owns the window.

---

## Using it

The window is the **stage** (1280×720) with the **HUD** below it. Drag the window by the
move icon at the top left of the HUD; close it with the ✕ at the top right.

It comes up already capturing, using whatever source it used last.

### Keys

| Key | Does |
|---|---|
| `Tab` | Show/hide the HUD. Hidden, the window *is* the stage |
| `Space` | Tap tempo. First tap sets the downbeat |
| `Esc` | Hand tempo back to automatic detection |

Tapping wins until a track change is detected, then automatic resumes.

### The HUD

| Readout | Meaning |
|---|---|
| **BPM** / `est` | Locked tempo, and the tracker's raw reading. These disagreeing is meaningful — it means the clock is refusing a correction |
| **Source** | `detected`, `tapped`, or `none` |
| **Confidence** | How strongly periodic the audio actually is |
| **Preset** | Which of the four is running, and its energy tag |
| **Beat dot** | Flashes on the beat, ringed on the downbeat. The fastest way to see whether it is locked |
| **kick / snare / hat** | Band level, with a red LED on detected onsets |
| **Clipped** | Blocks whose text does not fit. Red means text is being lost — lower the preset's `count` |
| **FPS** | Should sit at 60 |

`Tab` also reveals the options: audio source, layout set, palette, background mode, and the
three onset sensitivity sliders. Everything persists between launches.

---

## Output

### Into OBS directly

Add a **Window Capture** for the app. Press `Tab` to hide the HUD and the window is exactly
the stage, so no crop is needed.

Set **Background** to `Transparent` in the options to composite the text over other layers.

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

---

## Tuning

### Onset sensitivity

Three sliders, one per band. The number is how many standard deviations above that band's
own recent average the flux must jump. **Higher is fussier.** Defaults: kick 4.0, snare 2.0,
hat 2.2.

The kick default is high on purpose. In 40–120 Hz a kick and a synth bass note are not
meaningfully different — both are real transients in the same band — so this is a fussiness
setting rather than a fix. Beat tracking tolerates the extra onsets; the indicator just looks
twitchier than it tracks.

### Compositing over other visuals

Two settings exist for this, and both matter when the output sits over something busy:

- **Palette** — `mono` or `none` keep the whole typographic vocabulary and drop the accent
  colours, which are what usually clash.
- **Layouts** — `edges` keeps the centre of frame clear. Useful whenever your visuals (or a
  logo) live in the middle.

---

## Changing the text

`presets/text/prologue.txt`. One line per line; blank lines ignored.

**Selection works in whole sentences**, found by scanning for `.`, `!` or `?`. A sentence may
span several lines. Nothing is ever cut mid-sentence — if it does not fit the budget, it is
not shown at all.

Punctuation outside `A-Za-z0-9 !.?` is stripped, because stray commas become their own glyphs
in grid layouts and read as debris. That is why the text avoids contractions: `it's` would
become `its`.

---

## Layout

```
electron/     window, permissions, system loopback capture
src/
  audio/      capture, band analysis, onset detection
  time/       tempo estimation, the beat clock
  show/       preset bank, lane dispatch, layout sets
  text/       loading, sentence grouping, typesetting
  effects/    the effect vocabulary
  render/     stage, palettes
  hud/        the control panel
style/        base, stage typography and slots, hud
presets/text/ the text itself
```
