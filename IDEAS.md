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
