/**
 * What the kick is doing, and whether it agrees with a proposed tempo. DESIGN.md §9.2.4.
 *
 * The tempo of this music is carried by the kick. Everything else — pads, vocals, a shaker,
 * a minute of hats and snares over an intro — is periodic enough to produce a *confident*
 * tempo estimate that happens to be wrong, and correlation cannot tell the difference: eight
 * seconds of eighth-note hats genuinely are periodic at twice the tempo.
 *
 * So a tempo **change** has to answer two questions here, and they are not the same question:
 *
 * - {@link authority} — is the kick doing what it has been doing? A breakdown is not evidence.
 * - {@link agreement} — do the kicks actually land on the tempo being proposed?
 *
 * Strength alone was not enough. An intro can have a perfectly strong *snare* and still produce
 * a wrong estimate, because loudness says something is there, not that it agrees.
 */

/**
 * One slot per second, holding the strongest kick in it.
 *
 * A second contains at least one kick at any tempo this app tracks, so every slot is a
 * measurement *of a kick* rather than of the gaps between them. That is the whole reason for
 * the coarse slot: an earlier version sampled ten times a second and took a high percentile,
 * which meant the answer depended on the kick's duty cycle — how much of each second the
 * transient occupied — and so drifted with tempo. It happened to work at 128 and fell apart
 * after a breakdown.
 */
const SLOT_MS = 1000;

/**
 * Three minutes of history.
 *
 * One minute was not enough, and that is the bug that let a hat-and-snare intro through. The
 * window *is* the definition of "typical", so a section longer than the window becomes typical:
 * a minute of hats with no kick eroded the baseline down to the hats themselves, at which point
 * the hats read as a perfectly healthy kick and the gate opened. Three minutes outlasts any
 * intro or breakdown in a record that runs five to seven.
 */
const SLOTS = 180;

/** Recent enough to mean "now", long enough to contain a kick. */
const RECENT_SLOTS = 2;

/** How much history is needed before the comparison means anything. */
const MIN_SLOTS = 10;

/**
 * Slots below this fraction of the window's strongest are not describing a kick at all.
 *
 * They are left out of the typical, so a long quiet passage cannot vote itself normal. This is
 * the other half of the same fix: a longer window stops the baseline being *outlived*, and this
 * stops it being dragged down.
 */
const QUIET_FRACTION = 0.25;

/** Kick onsets kept for testing a candidate tempo against. About twelve seconds' worth. */
const ONSETS = 64;

/** Below this many recorded kicks there is nothing to judge a tempo by. */
const MIN_ONSETS = 8;

/**
 * Onsets older than this are from a different part of the record and prove nothing.
 *
 * Eight seconds rather than twelve, because this window is also how long a *real* hard cut
 * spends looking like mixed evidence: until the old track's kicks age out, the agreement score
 * is being dragged down by a record that has stopped playing. Eight still holds seventeen kicks
 * at 128, which is far more than enough to judge a period by.
 */
const ONSET_WINDOW_MS = 8_000;

export class KickHistory {
  private readonly slots = new Float32Array(SLOTS);
  private head = 0;
  private filled = 0;
  private slotStartMs = 0;
  private started = false;

  /** Scratch, so taking the median does not allocate on every estimate. */
  private readonly sorted = new Float32Array(SLOTS);

  /** When each recent kick landed, for {@link agreement}. */
  private readonly onsets = new Float64Array(ONSETS);
  private onsetHead = 0;
  private onsetCount = 0;

  /**
   * Record a frame's kick flux.
   *
   * The **peak** within each slot, not the mean: a kick is a transient, and averaging it
   * across a second of near-silence measures the silence more than the kick.
   */
  push(now: number, flux: number): void {
    if (!this.started) {
      this.started = true;
      this.slotStartMs = now;
    }

    let elapsed = now - this.slotStartMs;
    while (elapsed >= SLOT_MS) {
      // Skipped slots are genuinely empty — a frame that never arrived saw no kick.
      this.head = (this.head + 1) % SLOTS;
      this.slots[this.head] = 0;
      this.slotStartMs += SLOT_MS;
      elapsed -= SLOT_MS;
      if (this.filled < SLOTS) this.filled++;
    }

    const current = this.slots[this.head] ?? 0;
    if (flux > current) this.slots[this.head] = flux;
    if (this.filled === 0) this.filled = 1;
  }

  /** Record the moment a kick actually landed. */
  pushOnset(now: number): void {
    this.onsets[this.onsetHead] = now;
    this.onsetHead = (this.onsetHead + 1) % ONSETS;
    if (this.onsetCount < ONSETS) this.onsetCount++;
  }

  get ready(): boolean {
    return this.filled >= MIN_SLOTS;
  }

  /**
   * How well the recent kicks fall on a grid of this period. 0 to 1.
   *
   * Each kick's position within the candidate period is a point on a circle. If the kicks are
   * on the grid the points pile up in one place; if they are not, the points spread out. The
   * length of their average is that pile-up — 1 for a perfect fit, near 0 for a period the
   * kicks know nothing about.
   *
   * **Returns 0 when there are too few kicks**, which is the deliberate answer rather than a
   * missing one: no kick is not a reason to believe a new tempo, it is a reason not to. An
   * intro of hats and snares reads 0 here for *every* candidate — including the one the hats
   * genuinely are periodic at — and that is exactly right. Nothing in that passage is evidence
   * about where the record's tempo will land.
   */
  agreement(periodMs: number, now: number): number {
    if (periodMs <= 0) return 0;

    let x = 0;
    let y = 0;
    let used = 0;

    for (let i = 0; i < this.onsetCount; i++) {
      const at = this.onsets[(this.onsetHead - 1 - i + ONSETS) % ONSETS] ?? 0;
      if (now - at > ONSET_WINDOW_MS) break;

      const phase = ((at % periodMs) / periodMs) * Math.PI * 2;
      x += Math.cos(phase);
      y += Math.sin(phase);
      used++;
    }

    if (used < MIN_ONSETS) return 0;
    return Math.sqrt(x * x + y * y) / used;
  }

  /**
   * The kick's strength now, as a multiple of its recent typical strength.
   *
   * 1 means the kick is doing what it has been doing. Above 1 is a section hitting harder — a
   * drop, or simply a heavier record. Below 1 is a breakdown, a filter sweep, or an intro with
   * no kick in it at all.
   *
   * Deliberately relative rather than absolute: a quiet record and a loud one differ by more
   * than a breakdown and a drop do, so a fixed threshold would be tuned to one master and wrong
   * for the next.
   *
   * Returns 1 until there is enough history, so an unknown answer never blocks anything: at
   * startup there is nothing to compare against, and refusing to track would be worse than
   * tracking something imperfect. {@link agreement} still has an opinion at that point.
   */
  get authority(): number {
    if (!this.ready) return 1;

    const typical = this.typical();
    if (typical <= 1e-9) return 0;

    return this.recentPeak() / typical;
  }

  /** The strongest kick in the last couple of seconds. */
  private recentPeak(): number {
    let peak = 0;
    for (let i = 0; i < RECENT_SLOTS; i++) {
      const at = (this.head - i + SLOTS) % SLOTS;
      const value = this.slots[at] ?? 0;
      if (value > peak) peak = value;
    }
    return peak;
  }

  /**
   * What the kick has been doing, across the seconds that had a kick in them.
   *
   * The median rather than the mean, so a stray transient at one end and a breakdown at the
   * other both leave it alone — and taken over the loud slots only, so a passage with no kick
   * describes itself as an absence rather than as a new normal.
   */
  private typical(): number {
    const count = this.filled;

    let loudest = 0;
    for (let i = 0; i < count; i++) {
      const value = this.slots[(this.head - i + SLOTS) % SLOTS] ?? 0;
      if (value > loudest) loudest = value;
    }

    const floor = loudest * QUIET_FRACTION;
    let kept = 0;
    for (let i = 0; i < count; i++) {
      const value = this.slots[(this.head - i + SLOTS) % SLOTS] ?? 0;
      if (value >= floor) this.sorted[kept++] = value;
    }

    if (kept === 0) return 0;
    const view = this.sorted.subarray(0, kept);
    view.sort();
    return view[kept >> 1] ?? 0;
  }
}
