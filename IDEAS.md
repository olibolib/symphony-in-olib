# Ideas

A running list of things that might become features. Nothing here is committed to —
entries are kept as written until they are either built or dropped.

---

## 1. Unravel — a treatment that pulls text through the line breaks

Instead of moving the whole block up or down its box like `scroll`, this shifts the text
**one character position per tick through its own wrapping**, so the block eats itself a
glyph at a time.

The text is treated as a single stream inside the box. Every tick the whole stream steps
one character. A character sitting leftmost on a line becomes the last character of the
line above; next tick, second-to-last; then third-to-last, walking the full width until it
joins that line properly — and every other character in the block is doing exactly the same
thing at the same time. Nothing waits its turn. The visible effect is the whole paragraph
crawling backwards through its line breaks.

Like pulling a loose thread on a jumper and watching the knit unravel.

Notes:
- Direction runs both ways — pulling up, or feeding down.
- The tick is beat-based, on the same beat-division control as every other timed setting —
  one character-step per division, not a free-running speed.
- Possible toggle: **single-thread mode**, where only the leading character detaches and
  travels across the line on its own while the rest of the block sits still, and the next
  character only sets off once that one has arrived. Slower, more legible, more obviously
  a thread being pulled.
- Because it reflows the text rather than transforming it, it is closer to a content
  treatment than to `scroll` / `travel`, which move a block that stays intact.

---

## 2. Preset lifespan — automatic advance to the next preset

Right now a preset stays live until a person changes it. This is a way of giving a preset a
lifespan, so the show can rotate presets on its own over a long set instead of sitting on
one look until touched.

Three ways to set how long a preset lives, chosen per preset:

- **Fixed bars** — a set number of bars, then advance.
- **Ranged bars** — a min/max, a random pick within it each time the preset is entered, so
  a rotation doesn't read as a metronome.
- **Text-out** — hold until the text on screen finishes emptying out (no more of it left to
  read), then advance at the next bar boundary rather than cutting mid-line. Ties the
  preset's life to how much text it was actually given rather than to a clock.

Notes:
- All three should land on a bar boundary, not an arbitrary frame — this is the `bar` lane,
  already in Conductor's event stream (DESIGN.md §10).
- "Advance to the next preset" needs a notion of what "next" means — sequence order,
  random, weighted by `energy` tag — worth deciding alongside this rather than assuming.
- Text-out depends on the treatment in play: something like `still` (near-motionless) may
  never naturally empty out, so it likely wants a fallback (max bars) even in that mode.

---

## 3. Unravel and fly away — a departure for characters that finish unravelling

A variant on [Unravel](#1-unravel--a-treatment-that-pulls-text-through-the-line-breaks): what
happens to a character once it has finished walking into the line above.

Instead of just vanishing once it reaches the top line (or the end of the stream, in the
feed-down direction), it keeps going — carries its velocity straight past the boundary and
flies on off the edge of the screen, rather than stopping dead. It does not loop back or
reappear. Once it is gone, it is gone.

Notes:
- Reads as the thread not just being pulled loose but being pulled clean out of the jumper.
- Only makes sense as a toggle on Unravel, not a treatment of its own — it is about what
  happens at the far end of the same motion, not a different motion.
- Implies characters leaving the block permanently rather than the block being a closed loop
  — worth checking that against how `splitChars` / block membership currently assumes a
  fixed set of characters.

---

## 4. A cap on scroll/travel wraps or passes — feeding into idea 2

An option to stop `scroll` and `travel` after a set number of loops/wraps rather than running
`continuous` forever, so the *text-out* mode of [Preset lifespan](#2-preset-lifespan--automatic-advance-to-the-next-preset)
has something to count for these two treatments.

Right now `continuous` on either treatment is just on or off (§ "Both kinds wrap" /
"The conveyor loops, or passes through once") — a belt that never stops, or a single pass.
This sits between the two: still a belt, but one that stops itself after N trips round.

- For `scroll`'s conveyor: N full loops of the content passing through the block.
- For `travel`: N wraps — same idea, on whichever axis is doing the wrapping (`wrap side` /
  `wrap top`).
- Once the count is spent, the block reads as "out of text" the same way a single pass does
  when it finishes — which is exactly the signal idea 2's text-out mode needs to advance the
  preset. Without a count, a continuous conveyor never naturally empties, so text-out has
  nothing to watch for on these two treatments as they stand today.

Notes:
- A fixed number, not a min/max range — idea 2 already owns the randomised-range idea at the
  preset level; this only needs to give it something countable underneath.
- Should probably read as a third position alongside on/off for `continuous`, not a separate
  control — off (one pass), N (counted passes), continuous (unbounded).

---

## 5. Blink out — a treatment that removes elements over time

A new treatment: pick elements one (or a few) at a time and take them out of view, in a
run, rather than all at once. What's left on screen thins out as the preset plays, instead
of it being one static picture start to finish.

Not a new vocabulary — this is meant to sit on the **normal universal settings** every other
treatment already uses, not invent its own:

- **Target/slice** — same `char` · `word` · `sentence` · `paragraph` · `block` grain every
  other treatment selects by (DESIGN.md §11.5 / `targets.ts`), deciding what one "blink"
  removes.
- **Trigger** — same tick vocabulary as everything else: `kick` · `snare` · `hat` · `beat` ·
  `bar` · `phrase`, deciding how often one more piece goes.
- **Pick** — random or in order, the same split idea 2's text selection already draws
  (`pick: random` vs `order`) — so blinking can either feel chaotic or read left-to-right /
  top-to-bottom like something being crossed off.

Notes:
- Close cousin of the existing `blank` treatment (§11.5, writes the `vis` channel) — the
  difference is `blank` marks a selection invisible as a single decision that can decay back,
  where this is a *sequence*, steadily consuming more of the block over the treatment's life
  rather than one selection at one moment.
- Natural partner for idea 2's **text-out** advance mode and idea 4's wrap cap — a preset
  built on `blink out` empties itself by construction, which is exactly the condition
  text-out is watching for.
- Open question: once blinked, does it come back if the preset holds past a full pass (loop),
  or is it gone for the life of the typeset, same as [Unravel and fly away](#3-unravel-and-fly-away--a-departure-for-characters-that-finish-unravelling)?

---

## 6. Bugs

- **Mask invert refuses to reach empty.** `MaskGrid.invert()` (`src/hud/MaskGrid.ts`) flips
  every cell but then discards the result if it would leave nothing allowed — a deliberate
  refusal, per its own comment, on the reasoning that an empty mask means every preset gets
  skipped with no visible cause. Report is that empty should be a reachable state — inverting
  a full mask should be allowed to land on empty, not silently no-op. Needs deciding what
  should communicate "mask is empty" instead of just blocking the invert.
- **Setting a max below the min.** In `rangeField` (`src/hud/PresetEditor.ts`), used for
  every min/max control in the editor — text size, block shapes, layer size — this already
  seems to be guarded: moving max below min pulls min down to match, and moving min above max
  pushes max up (its own comment describes fixing exactly this). Loading a preset file by hand
  is also covered — `presetIo.ts` swaps `text.size.min`/`max` on read if min ended up above
  max. Flagging rather than logging as still-open: worth saying where this is still showing up,
  since the obvious spots already push the other value out of the way.

---

## 7. Bug — scroll not smooth on tiny text at 1080p

Reported live at 1080p: scroll stops being smooth, and it's suspected some other setting
change is behind it. Suspicion is that it's caused by small text size specifically.

---

## 8. Bug — "bars" label wrong on the layer UI

The label reading "bars" in the layer UI, next to the checkboxes where a time length is
selected, is wrong — it's not counting bars, it's measuring the length of some other unit
of time for that selection.

---

## 9. Bug — avoidOverlap doesn't avoid overlap for travelling blocks

`avoidOverlap` (§11.6, `mask.ts`'s `placeBlocks`) is meant to search for a non-colliding
arrangement before falling back to letting blocks overlap. Report is that it isn't finding
that arrangement in a case where one should exist: two blocks each at their max height (or
max width) should be placeable lower/higher than each other, or left/right of each other,
rather than overlapping — and that placement is being missed when the blocks are set to
`travel` up/down or sideways through overlapping heights/widths.

Travelling off part of the time doesn't disqualify a placement — a block that's moving on
and off screen not being fully visible at any one instant is expected and fine; that's not a
reason to accept an overlap that a lower/higher or left/right placement would have avoided.

---

## 10. The big-jump tempo rule is too strong

`BeatTracker`'s re-lock rule (DESIGN.md §9.2.3) scales evidence demanded with the size of a
tempo jump — 30% or more needs 0.80 agreement held for 28 estimates (~7s) before the grid
moves, measured at 11.8s to actually take a genuine 128→174 cut. Report is that this is too
strong — it's holding out for too much proof, or too long, on a big jump.

---

## 11. A drag-and-drop timeline for the preset bank

Dependent on the app having a general drag-and-drop UI first — once that exists, build a
timeline for `PresetBank` where presets can be dragged into an order, for the show to
auto-play through in that sequence.

`PresetBank.takeNext()` currently auto-advances on a randomised bar timer, picking randomly
among enabled presets (`MIN_BARS`/`MAX_BARS`, `src/show/PresetBank.ts`) — there's no notion
of a chosen order today, only enabled/disabled and random pick. This would sit alongside
that as an authored sequence rather than a random draw.

Notes:
- Natural companion to [Preset lifespan](#2-preset-lifespan--automatic-advance-to-the-next-preset)
  — a timeline is what "next" means once presets are ordered rather than randomly picked, and
  each slot in the timeline could carry its own lifespan setting from idea 2.
