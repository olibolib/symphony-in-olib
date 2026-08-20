/**
 * Tempo and phase estimation from the onset envelope. DESIGN.md §9.2 steps 4–7.
 *
 * The approach is autocorrelation: a periodic signal correlates with a delayed copy of
 * itself most strongly at a delay equal to its period. Feed in "how much did energy jump
 * just now", and the lag with the strongest correlation is the beat.
 */

/**
 * The envelope is resampled to a fixed rate before any of this runs.
 *
 * That matters: analysis happens once per animation frame, and frame timing is not
 * guaranteed — 60fps normally, less under load. Autocorrelation on unevenly spaced samples
 * measures the frame rate as much as the music. So frames write into a fixed 100 Hz grid,
 * filling whatever slots have elapsed, and the maths sees an even series regardless.
 */
const ENVELOPE_HZ = 100;

/**
 * Eight seconds is about 17 beats at 126 BPM. Six was roughly 12, and that turned out to be
 * too few for a stable correlation peak on music with any syncopation — the peak wandered
 * between neighbouring lags from one estimate to the next.
 *
 * The cost is re-lock speed: for this many seconds after a mix the envelope holds both
 * records. Acceptable, since mixes are long.
 */
const ENVELOPE_SECONDS = 8;
const ENVELOPE_LEN = ENVELOPE_HZ * ENVELOPE_SECONDS;

/**
 * Window of the moving average subtracted from the envelope, in samples (~1s).
 *
 * This is a high-pass filter, and it is not optional. Subtracting only the *global* mean
 * removes a constant offset but leaves slow swells over seconds — and slow drift correlates
 * broadly, with an influence that grows with lag, so it drags the peak toward longer
 * periods. Observed: a 126 BPM track reading a stable 120.
 *
 * One second passes beat-rate movement (about 2 Hz) untouched while removing anything
 * slower than roughly 1 Hz.
 */
const DETREND_WINDOW = ENVELOPE_HZ;

/**
 * Search range — deliberately **exactly one octave** (92 x 2 = 184).
 *
 * This is the single most important constant here. A wider window makes octave errors
 * structurally possible: a house track at 126 BPM genuinely *is* periodic at 63, so both
 * lags score almost identically and noise decides which wins — producing a reading that
 * flips between the two. Observed in testing: house locked to 63.2, corrected itself, then
 * uncorrected.
 *
 * Confining the search to one octave means that for any candidate, its half and double both
 * fall outside the window and cannot compete. The ambiguity is removed by construction
 * rather than adjudicated after the fact.
 *
 * The cost is that genuinely slow material reads at double time — a 75 BPM track reports
 * 150. For a visualizer that is a much smaller error than half-timing a house record, and
 * it is stable rather than oscillating.
 */
const MIN_BPM = 92;
const MAX_BPM = 184;

const MIN_LAG = Math.floor((60 / MAX_BPM) * ENVELOPE_HZ);
const MAX_LAG = Math.ceil((60 / MIN_BPM) * ENVELOPE_HZ);

/** Tempo does not change quickly; re-estimating 4x a second is plenty and much cheaper. */
const ESTIMATE_INTERVAL_MS = 250;

/**
 * How much of each new correlation curve is blended into the running one.
 *
 * Averaging the whole curve over time, rather than picking a winner from each snapshot, is
 * what stops the reading wandering: a genuine periodicity reinforces at the same lag every
 * time, while noise peaks land somewhere different and average away.
 */
const ACF_SMOOTHING = 0.2;

export interface TempoEstimate {
  readonly bpm: number;
  readonly periodMs: number;
  /** Timestamp of the most recent beat implied by the estimate. */
  readonly phaseMs: number;
  /** 0–1. How strongly periodic the envelope actually is. */
  readonly confidence: number;
}

export class BeatTracker {
  /** Circular buffer; `head` is where the next sample goes, so index 0 is the oldest. */
  private readonly buffer = new Float32Array(ENVELOPE_LEN);
  private head = 0;

  /** Detrended, rectified envelope — what the correlation actually runs on. */
  private readonly work = new Float32Array(ENVELOPE_LEN);
  /** Prefix sums, so the moving average costs one pass rather than one per sample. */
  private readonly prefix = new Float64Array(ENVELOPE_LEN + 1);

  /** Timestamp of the most recently written slot. */
  private lastSampleMs = 0;
  private lastEstimateMs = 0;
  private filled = 0;

  /** Previously chosen lag, so the estimate prefers to stay put. See resolveOctave. */
  private lastLag = 0;

  /** Running average of the correlation curve across estimates. */
  private readonly smoothed = new Float32Array(MAX_LAG + 2);
  private hasSmoothed = false;

  /**
   * Add a frame's onset energy, resampling onto the fixed grid.
   *
   * If several grid slots have elapsed since the last call, they are all filled: a dropped
   * frame becomes a short plateau rather than a hole that looks like a rhythm.
   *
   * The value is log-compressed on the way in. Raw flux is extremely peaky, and without
   * compression a handful of loud hits dominate the correlation while the steady pulse of
   * ordinary ones — which is what actually carries the tempo — contributes almost nothing.
   */
  push(now: number, energy: number): void {
    const compressed = Math.log1p(Math.max(0, energy) * 50);

    if (this.lastSampleMs === 0) {
      this.lastSampleMs = now;
      this.write(compressed);
      return;
    }

    const msPerSample = 1000 / ENVELOPE_HZ;
    let elapsed = now - this.lastSampleMs;

    // Guard against a long stall (window hidden, machine hitched) writing thousands of
    // samples and wiping the entire history.
    if (elapsed > ENVELOPE_SECONDS * 1000) {
      elapsed = ENVELOPE_SECONDS * 1000;
      this.lastSampleMs = now - elapsed;
    }

    while (elapsed >= msPerSample) {
      this.write(compressed);
      this.lastSampleMs += msPerSample;
      elapsed -= msPerSample;
    }
  }

  /** True once there is enough history for an estimate to mean anything. */
  get ready(): boolean {
    return this.filled >= ENVELOPE_LEN;
  }

  /**
   * Estimate tempo and phase, or null if it is not time to re-estimate yet or there is
   * not enough signal to bother.
   */
  estimate(now: number): TempoEstimate | null {
    if (!this.ready) return null;
    if (now - this.lastEstimateMs < ESTIMATE_INTERVAL_MS) return null;
    this.lastEstimateMs = now;

    const variance = this.prepare();
    if (variance <= 1e-12) return null; // silence, or nothing but drift

    let scoreSum = 0;

    for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
      let acc = 0;
      const overlap = ENVELOPE_LEN - lag;
      for (let i = 0; i < overlap; i++) {
        acc += (this.work[i] ?? 0) * (this.work[i + lag] ?? 0);
      }
      // Normalise by overlap so short lags are not favoured simply for having more terms.
      const score = acc / overlap / variance;
      scoreSum += score;

      this.smoothed[lag] = this.hasSmoothed
        ? (this.smoothed[lag] ?? 0) * (1 - ACF_SMOOTHING) + score * ACF_SMOOTHING
        : score;
    }
    this.hasSmoothed = true;

    // Peak-pick from the smoothed curve, not from this snapshot.
    let bestLag = 0;
    let bestScore = -Infinity;
    for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
      const score = this.smoothed[lag] ?? 0;
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }

    if (bestLag === 0 || bestScore <= 0) return null;

    const lag = this.resolveOctave(bestLag);
    this.lastLag = lag;

    // Sub-sample refinement.
    //
    // Lags are whole envelope samples, and near lag 47 one sample is worth about 2.7 BPM —
    // so 126 BPM is simply not expressible: the choices are 125.0 and 127.7. Fitting a
    // parabola through the peak and its two neighbours recovers where the true maximum lies
    // between them, which costs nothing and removes the quantisation entirely.
    const periodMs = (this.refineLag(lag) / ENVELOPE_HZ) * 1000;

    const averageScore = scoreSum / (MAX_LAG - MIN_LAG + 1);
    const spread = 1 - averageScore;
    const confidence = clamp01((bestScore - averageScore) / (spread === 0 ? 1 : spread));

    return {
      bpm: 60_000 / periodMs,
      periodMs,
      phaseMs: this.findPhase(lag),
      confidence,
    };
  }

  /**
   * Build the working envelope: detrend, then half-wave rectify. Returns its variance.
   *
   * Rectifying after the high-pass keeps only where the signal rises above its local
   * baseline. Troughs carry no rhythmic information — a gap between hits is not itself an
   * event — and letting them contribute negatively to the correlation only adds noise.
   */
  private prepare(): number {
    this.prefix[0] = 0;
    for (let i = 0; i < ENVELOPE_LEN; i++) {
      this.prefix[i + 1] = (this.prefix[i] ?? 0) + this.at(i);
    }

    const half = Math.floor(DETREND_WINDOW / 2);
    let sum = 0;

    for (let i = 0; i < ENVELOPE_LEN; i++) {
      const from = Math.max(0, i - half);
      const to = Math.min(ENVELOPE_LEN, i + half);
      const local = ((this.prefix[to] ?? 0) - (this.prefix[from] ?? 0)) / (to - from);
      const value = Math.max(0, this.at(i) - local);
      this.work[i] = value;
      sum += value;
    }

    // Re-centre: rectification leaves a positive mean, which would otherwise dominate the
    // correlation exactly the way the original offset did.
    const mean = sum / ENVELOPE_LEN;
    let energy = 0;
    for (let i = 0; i < ENVELOPE_LEN; i++) {
      const centred = (this.work[i] ?? 0) - mean;
      this.work[i] = centred;
      energy += centred * centred;
    }

    return energy / ENVELOPE_LEN;
  }

  /**
   * Parabolic interpolation around a correlation peak, returning a fractional lag.
   *
   * Three points define a parabola; its vertex is a far better estimate of the true peak
   * than the sampled maximum. Falls back to the integer lag if the curve is not actually
   * peaked there or the correction is implausibly large.
   */
  private refineLag(lag: number): number {
    const y1 = this.smoothed[lag - 1];
    const y2 = this.smoothed[lag];
    const y3 = this.smoothed[lag + 1];
    if (y1 === undefined || y2 === undefined || y3 === undefined) return lag;

    // Must be concave down, i.e. actually a maximum. If it is not, the vertex formula
    // points away from the peak rather than toward it.
    const denominator = y1 - 2 * y2 + y3;
    if (denominator >= 0) return lag;

    const delta = (0.5 * (y1 - y3)) / denominator;
    return Math.abs(delta) <= 1 ? lag + delta : lag;
  }

  /**
   * Safety net for octave ambiguity. With a one-octave search window this normally has no
   * alternatives to consider, but it stays for the boundary cases and to keep the choice
   * stable between estimates.
   *
   * Where there is a choice, the tie is broken by asking a different question from the
   * autocorrelation: how much stronger is the signal *on* the beats than exactly *between*
   * them? At the true tempo that ratio is large. At half tempo the "off-beats" are real
   * beats too and it collapses.
   *
   * A candidate at or near the previously chosen lag also gets a bonus. Two readings that
   * score within noise of each other should not produce a different answer each time — a
   * BPM that flickers is worse than one that is slightly wrong.
   */
  private resolveOctave(lag: number): number {
    const candidates = [Math.round(lag / 2), lag, lag * 2].filter(
      (l) => l >= MIN_LAG && l <= MAX_LAG,
    );

    let best = lag;
    let bestRatio = -Infinity;

    for (const candidate of candidates) {
      const phase = this.findPhaseIndex(candidate);
      const onBeat = this.pulseMean(candidate, phase);
      const offBeat = this.pulseMean(candidate, phase + Math.floor(candidate / 2));
      const ratio = onBeat / (Math.abs(offBeat) + 1e-6);

      // A mild pull toward the range most dance music lives in, used only to separate
      // candidates that are otherwise close.
      const bpm = 60_000 / ((candidate / ENVELOPE_HZ) * 1000);
      const plausible = bpm >= 110 && bpm <= 165 ? 1.1 : 1;

      // Stickiness: prefer where we already were, unless the alternative is clearly better.
      const sticky = this.lastLag !== 0 && Math.abs(candidate - this.lastLag) <= 1 ? 1.3 : 1;

      const scored = ratio * plausible * sticky;
      if (scored > bestRatio) {
        bestRatio = scored;
        best = candidate;
      }
    }

    return best;
  }

  /** Mean envelope value at every position hit by a pulse train of this period and phase. */
  private pulseMean(period: number, phase: number): number {
    let total = 0;
    let count = 0;
    for (let i = phase % period; i < ENVELOPE_LEN; i += period) {
      total += this.work[i] ?? 0;
      count++;
    }
    return count > 0 ? total / count : 0;
  }

  /** Which offset within the period the beats fall on. */
  private findPhaseIndex(period: number): number {
    let bestPhase = 0;
    let bestTotal = -Infinity;
    for (let phase = 0; phase < period; phase++) {
      const total = this.pulseMean(period, phase);
      if (total > bestTotal) {
        bestTotal = total;
        bestPhase = phase;
      }
    }
    return bestPhase;
  }

  /** Phase as a wall-clock timestamp of the most recent beat. */
  private findPhase(period: number): number {
    const phase = this.findPhaseIndex(period);
    const latest = phase + period * Math.floor((ENVELOPE_LEN - 1 - phase) / period);
    const samplesAgo = ENVELOPE_LEN - 1 - latest;
    return this.lastSampleMs - (samplesAgo / ENVELOPE_HZ) * 1000;
  }

  /** Oldest-first access into the circular buffer. */
  private at(i: number): number {
    return this.buffer[(this.head + i) % ENVELOPE_LEN] ?? 0;
  }

  private write(value: number): void {
    this.buffer[this.head] = value;
    this.head = (this.head + 1) % ENVELOPE_LEN;
    if (this.filled < ENVELOPE_LEN) this.filled++;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
