/**
 * How strong the kick is now, against how strong it has recently been. DESIGN.md §9.2.4.
 *
 * The tempo of this music is carried by the kick. Everything else — pads, vocals, a shaker
 * running through a breakdown — is periodic enough to produce a confident tempo estimate that
 * happens to be wrong, and the tracker cannot tell the difference on its own: an eight-second
 * correlation window full of eighth-note hats is *genuinely* periodic at twice the tempo.
 *
 * So a tempo **change** is only credible when the kick is doing at least as much work as it
 * has been. That is what this measures. It is deliberately relative rather than absolute: a
 * quiet record and a loud one differ by more than a breakdown and a drop do, so a fixed
 * threshold would be tuned to one master and wrong for the next.
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
const SLOTS = 60;

/** Recent enough to mean "now", long enough to contain a kick. */
const RECENT_SLOTS = 2;

/** How much history is needed before the comparison means anything. */
const MIN_SLOTS = 10;

export class KickHistory {
  private readonly slots = new Float32Array(SLOTS);
  private head = 0;
  private filled = 0;
  private slotStartMs = 0;
  private started = false;

  /** Scratch, so taking the median does not allocate on every estimate. */
  private readonly sorted = new Float32Array(SLOTS);

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

  get ready(): boolean {
    return this.filled >= MIN_SLOTS;
  }

  /**
   * The kick's strength now, as a multiple of its recent typical strength.
   *
   * 1 means the kick is doing what it has been doing. Above 1 is a section hitting harder —
   * a drop, or simply a heavier record. Below 1 is a breakdown, a filter sweep, or a passage
   * with no kick at all.
   *
   * Returns 1 until there is enough history, so an unknown answer never blocks anything: at
   * startup there is nothing to compare against and refusing to track would be worse than
   * tracking something imperfect.
   */
  get authority(): number {
    if (!this.ready) return 1;

    // The median of a minute of per-second peaks. Half the recent seconds were at least this
    // hard, which is a fair description of "what the kick has been doing" — and unlike a mean
    // it is unmoved by a breakdown at one end or a stray transient at the other.
    const typical = this.median();
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

  private median(): number {
    const count = this.filled;
    for (let i = 0; i < count; i++) {
      this.sorted[i] = this.slots[(this.head - i + SLOTS) % SLOTS] ?? 0;
    }

    const view = this.sorted.subarray(0, count);
    view.sort();
    return view[count >> 1] ?? 0;
  }
}
