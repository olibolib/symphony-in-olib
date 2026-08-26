import type { ClockSource } from '../types';
import type { TempoEstimate } from './BeatTracker';

/**
 * Musical position. DESIGN.md §9.3 — prediction, not reaction.
 *
 * The Clock does not fire beats when it hears one. It holds a tempo and a phase, and
 * *generates* beats from them; the tracker only nudges those two numbers. That is the whole
 * point: reacting to a detected transient is always late by the length of the analysis
 * window, and on a projector that reads as sloppy. A predicted grid lands on the beat, or
 * deliberately just before it.
 *
 * It also means the visual keeps moving through a breakdown with no transients at all,
 * rather than stalling until something hits.
 */

const BEATS_PER_BAR = 4;
const BARS_PER_PHRASE = 4;

/**
 * How hard the kick must be hitting before a *different* tempo is believed.
 *
 * Slightly below 1 — the kick has to be doing roughly what it has been, not more. Demanding
 * more than its typical strength would mean only a drop could ever change the tempo, and a
 * new record often comes in at the same weight as the last one.
 */
const KICK_AUTHORITY = 0.8;

/**
 * How well the kicks must land on the proposed tempo before it is believed.
 *
 * Strength says a kick is there; this says it agrees. They are different questions, and the
 * observed 130-to-170 jump answered the first one honestly — the intro was loud, it simply had
 * no kick in it, only hats and snares for the best part of a minute.
 */
const KICK_AGREEMENT = 0.45;

/**
 * A change this large has to prove itself completely.
 *
 * **DJs beatmatch.** Two records in a transition are at nearly the same tempo, because that is
 * what a transition *is* — so a large jump is almost never a mix, and is nearly always the
 * correlation locking onto a pattern rather than a pulse. Between {@link TRACK_CHANGE_RATIO}
 * and here, the evidence demanded ramps up: more kick, better agreement, and longer to hold it.
 *
 * Not a flat refusal, because a hard cut between genres does happen and the grid should follow
 * it. It just needs serious clues rather than eight seconds of hats.
 */
const LARGE_CHANGE_RATIO = 0.3;

/** What a change at {@link LARGE_CHANGE_RATIO} has to show instead. */
const LARGE_KICK_AUTHORITY = 1;
const LARGE_KICK_AGREEMENT = 0.8;
const LARGE_CHANGE_ESTIMATES = 28;

/**
 * Kick strength below which fine correction stops entirely.
 *
 * Between here and its typical strength the correction ramps, so the grid becomes gradually
 * more stubborn as the kick fades rather than switching off at a line.
 */
const CORRECTION_FLOOR = 0.5;

/** Fraction of the measured phase error corrected per estimate. Low, to avoid jitter. */
const PHASE_CORRECTION = 0.18;

/** Fraction of the tempo difference absorbed per estimate once locked. ~2s to converge. */
const TEMPO_CORRECTION = 0.15;

/**
 * Relative tempo difference beyond which we suspect a different record rather than drift.
 *
 * This was 0.04 and that was far too tight, for two reasons. DJs pitch records by ±8% as a
 * matter of course, so a pitched-up track read as a track change. And estimation error of a
 * few percent is normal — meaning a correct estimate 5% from the locked tempo would take
 * the "possible new track" branch and return *without applying the correction*, while never
 * accumulating enough consecutive disagreements to re-lock either. The clock could sit at
 * 120 indefinitely while the tracker was reporting 126.
 *
 * Anything below this is now absorbed by the gentle correction, which is what it is for.
 */
const TRACK_CHANGE_RATIO = 0.12;

/** Consecutive disagreeing estimates before we accept it really is a new track (~2s). */
const TRACK_CHANGE_ESTIMATES = 8;

/** How close to exactly half or double counts as an octave disagreement rather than a mix. */
const OCTAVE_TOLERANCE = 0.06;

/** Taps older than this are stale and start a new count. */
const TAP_TIMEOUT_MS = 2500;

/**
 * What the kick has to say about a tempo. Supplied by `KickHistory` (§9.2.4).
 *
 * A function rather than a number for the agreement, because the Clock needs it for two
 * periods — the one being proposed and the one it is already holding — and only the Clock
 * knows the second.
 */
export interface KickEvidence {
  /** Kick strength now against its recent typical. 1 is business as usual. */
  readonly authority: number;
  /** How well recent kicks fall on a grid of this period, 0 to 1. */
  agreementFor(periodMs: number): number;
}

/** Used when nothing is listening to the kick, so the Clock stays usable on its own. */
const NO_EVIDENCE: KickEvidence = { authority: 1, agreementFor: () => 1 };

export interface BeatEvent {
  /** Beats since the clock's origin. */
  readonly index: number;
  /** Position within the bar, 0–3. */
  readonly inBar: number;
  readonly isDownbeat: boolean;
  /** True on the first beat of a phrase — where preset changes should land (§11.2). */
  readonly isPhraseStart: boolean;
}

export class Clock {
  private periodMs = 500;
  /** Timestamp of beat zero. Beats are generated from this and the period. */
  private originMs = 0;

  private lastBeatIndex = -1;
  private started = false;

  private disagreements = 0;
  private taps: number[] = [];

  source: ClockSource = 'none';
  confidence = 0;

  /**
   * True while a tap has taken over. DESIGN.md §9.4: manual wins until a track change is
   * detected, then automatic resumes.
   */
  private manual = false;

  get bpm(): number | null {
    return this.started ? 60_000 / this.periodMs : null;
  }

  get isManual(): boolean {
    return this.manual;
  }

  /**
   * Position within the current beat, 0 at the beat and approaching 1 just before the next.
   *
   * Continuous rather than event-based, so anything driven by it moves smoothly between
   * beats instead of stepping. Predicted from the grid like everything else (§9.3), so it
   * stays smooth through a passage with no transients at all.
   */
  phase(now: number): number {
    if (!this.started) return 0;
    const p = ((now - this.originMs) / this.periodMs) % 1;
    return p < 0 ? p + 1 : p;
  }

  /**
   * Fold in a new measurement.
   *
   * The first one locks hard. After that, corrections are deliberately gentle — the grid
   * is the thing keeping time, and yanking it toward every estimate would reintroduce
   * exactly the jitter the prediction model exists to avoid.
   */
  /**
   * @param kick What the kick has to say (§9.2.4). Below its typical strength the kick has
   * dropped away, and a tempo estimate made without it is not evidence about the tempo.
   */
  apply(estimate: TempoEstimate, kick: KickEvidence = NO_EVIDENCE): void {
    const authority = kick.authority;
    this.confidence = estimate.confidence;

    if (!this.started) {
      this.lock(estimate, 'detected');
      return;
    }

    // An estimate at almost exactly half or double the current tempo is an octave
    // disagreement, not a different record — nobody mixes 126 into 63. Treating it as a
    // track change is what produced the observed "corrected itself, then uncorrected"
    // flip-flop: the grid would re-lock to the wrong octave and then back again.
    //
    // The one-octave search window in BeatTracker should stop these being produced at all.
    // This is here so that if one ever is, it is ignored rather than acted on.
    const octaveRatio = estimate.periodMs / this.periodMs;
    const nearOctave =
      Math.abs(octaveRatio - 2) < OCTAVE_TOLERANCE * 2 ||
      Math.abs(octaveRatio - 0.5) < OCTAVE_TOLERANCE / 2;
    if (nearOctave) return;

    const ratio = Math.abs(estimate.periodMs - this.periodMs) / this.periodMs;

    if (ratio > TRACK_CHANGE_RATIO) {
      // A different tempo is only believable while the kick is carrying one.
      //
      // Everything else in the mix is periodic enough to produce a confident estimate that
      // happens to be wrong — eight seconds of eighth-note hats through a breakdown really
      // are periodic at twice the tempo, and the correlation cannot tell that from a record
      // change. Waiting for the kick to come back costs a few seconds at the start of a new
      // track and saves the grid from re-locking to a shaker.
      // How much this change has to prove, from 0 for a small one to 1 for a large one. A
      // beatmatched mix sits at the bottom of that and a suspicious leap at the top.
      const demand = clamp01(
        (ratio - TRACK_CHANGE_RATIO) / (LARGE_CHANGE_RATIO - TRACK_CHANGE_RATIO),
      );

      if (authority < lerp(KICK_AUTHORITY, LARGE_KICK_AUTHORITY, demand)) return;

      // And the kicks have to agree with the tempo being proposed — better than they agree
      // with the one already held, or there is no reason to move.
      //
      // This is the test strength could not do. A minute-long intro of hats and snares has a
      // strong onset on every beat of its own pattern and none on the record's pulse, so it
      // scores nothing against every candidate and moves nothing.
      const forNew = kick.agreementFor(estimate.periodMs);
      if (forNew < lerp(KICK_AGREEMENT, LARGE_KICK_AGREEMENT, demand)) return;
      if (forNew <= kick.agreementFor(this.periodMs)) return;

      // Could be a new record, could be one bad estimate. Require persistence, and more of it
      // the further the proposed tempo is from the one already playing.
      this.disagreements++;
      if (this.disagreements >= lerp(TRACK_CHANGE_ESTIMATES, LARGE_CHANGE_ESTIMATES, demand)) {
        this.manual = false;
        this.lock(estimate, 'detected');
      }
      return;
    }

    this.disagreements = 0;

    // A tap outranks detection until the track changes, so stop here.
    if (this.manual) return;

    // Fine correction ramps to nothing rather than scaling straight down.
    //
    // Scaling by the authority directly left a breakdown able to walk the tempo 2.5 BPM over
    // twenty estimates — small per estimate, and the grid is somewhere else by the time the
    // kick returns. Below half the typical kick there is no evidence worth acting on, so the
    // grid simply holds: it is predictive (§9.3), and running on the last known tempo through
    // a quiet passage is exactly what it is for.
    const trust = clamp01((authority - CORRECTION_FLOOR) / (1 - CORRECTION_FLOOR));
    this.periodMs += (estimate.periodMs - this.periodMs) * TEMPO_CORRECTION * trust;
    this.nudgePhase(estimate.phaseMs, trust);
    this.source = 'detected';
  }

  /**
   * Slide the origin toward the measured phase, by the shortest route.
   *
   * The correction is signed and wrapped to ±half a beat: if the estimate says the beat is
   * 90% of a period away, that is really 10% early, not 90% late, and correcting the long
   * way round would drag the grid backwards through a whole beat.
   */
  private nudgePhase(measuredMs: number, trust = 1): void {
    const elapsed = measuredMs - this.originMs;
    let error = elapsed % this.periodMs;
    if (error > this.periodMs / 2) error -= this.periodMs;
    this.originMs += error * PHASE_CORRECTION * trust;
  }

  private lock(estimate: TempoEstimate, source: ClockSource): void {
    this.periodMs = estimate.periodMs;
    this.originMs = estimate.phaseMs;
    this.source = source;
    this.started = true;
    this.disagreements = 0;
    // Re-anchor the beat counter so the new lock starts a fresh bar rather than inheriting
    // whatever count the previous track happened to end on.
    this.lastBeatIndex = Math.floor((performance.now() - this.originMs) / this.periodMs) - 1;
  }

  /**
   * Tap tempo. The first tap sets the downbeat; the intervals set the tempo.
   *
   * Two taps is enough to have an opinion, which matters live — you should not have to
   * commit to four before anything happens.
   */
  tap(now: number): void {
    const last = this.taps[this.taps.length - 1];
    if (last !== undefined && now - last > TAP_TIMEOUT_MS) this.taps = [];

    this.taps.push(now);
    if (this.taps.length > 6) this.taps.shift();

    if (this.taps.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < this.taps.length; i++) {
        intervals.push((this.taps[i] ?? 0) - (this.taps[i - 1] ?? 0));
      }
      // Median, not mean: one clumsy tap should not drag the tempo with it.
      intervals.sort((a, b) => a - b);
      const middle = intervals[Math.floor(intervals.length / 2)] ?? this.periodMs;
      this.periodMs = middle;
    }

    // Every tap is treated as a downbeat, so tapping also fixes bar alignment.
    this.originMs = now;
    this.lastBeatIndex = -1;
    this.started = true;
    this.manual = true;
    this.source = 'tapped';
    this.confidence = 1;
  }

  /** Hand control back to detection without waiting for a track change. */
  releaseManual(): void {
    this.manual = false;
    this.taps = [];
  }

  /**
   * Advance to `now`, returning a beat event if one was crossed since the last call.
   *
   * Returns at most one event per call even if several beats elapsed — after a stall we
   * want the grid back in sync, not a burst of catch-up flashes.
   */
  update(now: number): BeatEvent | null {
    if (!this.started) return null;

    const index = Math.floor((now - this.originMs) / this.periodMs);
    if (index === this.lastBeatIndex) return null;
    this.lastBeatIndex = index;

    const inBar = ((index % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR;
    const bar = Math.floor(index / BEATS_PER_BAR);
    const inPhrase = ((bar % BARS_PER_PHRASE) + BARS_PER_PHRASE) % BARS_PER_PHRASE;

    return {
      index,
      inBar,
      isDownbeat: inBar === 0,
      isPhraseStart: inBar === 0 && inPhrase === 0,
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function lerp(from: number, to: number, at: number): number {
  return from + (to - from) * at;
}
