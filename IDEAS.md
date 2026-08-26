# Ideas

A running list of things that might become features. Nothing here is committed to —
entries are kept as written until they are either built or dropped.

---

## 1. Unravel — a treatment that pulls text through the line breaks

Instead of moving the whole block up or down its box like `scroll`, this pulls the text
**character by character across the line boundary**, so the block eats itself one glyph at
a time.

Take an `a` sitting as the leftmost character of a line. On the next tick it is the *last*
character of the line above. The tick after that, second-to-last. Then third-to-last, and
so on until it has walked the whole width and joined the line above properly — at which
point the character behind it starts the same journey.

Like pulling a loose thread on a jumper and watching the knit unravel.

Notes:
- Direction runs both ways — pulling up, or feeding down.
- The tick is beat-based, on the same beat-division control as every other timed setting —
  one character-step per division, not a free-running speed.
- Because it reflows the text rather than transforming it, it is closer to a content
  treatment than to `scroll` / `travel`, which move a block that stays intact.
