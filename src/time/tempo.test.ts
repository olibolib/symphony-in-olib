import { describe, expect, it } from 'vitest';
import { Clock } from './Clock';
import { KickHistory } from './KickHistory';

/**
 * Tempo tracking. DESIGN.md §9.2.4 and §9.3.
 *
 * Every case here came from a record misbehaving, and each one names the record's behaviour
 * rather than the constant it happens to exercise — the numbers have been retuned twice and
 * will be again, but "a breakdown must not move the grid" is the thing that has to stay true.
 */

const bpmToPeriod = (bpm: number): number => 60_000 / bpm;

const estimateOf = (bpm: number, at: number) => ({
  periodMs: bpmToPeriod(bpm),
  phaseMs: at,
  bpm,
  confidence: 0.9,
});

interface Passage {
  /** null is a passage with no kick in it at all — a hats-and-snares intro. */
  kickBpm?: number | null;
  /** Kick strength relative to what came before: a breakdown is 0.1, a drop is 1.4. */
  level?: number;
  /** Energy in the kick band that is not a kick — hats bleeding down. */
  bleed?: number;
}

/**
 * A record playing into a KickHistory, one frame at a time.
 *
 * The kick's phase is carried across calls. An earlier version of this harness restarted it on
 * every call, and because the estimate loop advances a quarter-second at a time that quietly
 * turned a "174 BPM kick" into one landing every 250ms — which the code then correctly refused
 * to believe was 174. The measurement was wrong, not the thing being measured.
 */
class Deck {
  t = 0;
  private next = 0;
  readonly kicks = new KickHistory();

  play(seconds: number, { kickBpm = 128, level = 1, bleed = 0 }: Passage = {}): void {
    const until = this.t + seconds * 1000;
    const period = kickBpm === null ? Infinity : bpmToPeriod(kickBpm);
    if (kickBpm === null) this.next = Infinity;
    else if (!Number.isFinite(this.next)) this.next = this.t;

    for (; this.t < until; this.t += 16) {
      let flux = bleed;
      if (this.t >= this.next) {
        flux = level;
        this.kicks.pushOnset(this.t);
        this.next += period;
      }
      this.kicks.push(this.t, flux);
    }
  }

  /** Start a different record, at its own phase. */
  cut(): void {
    this.next = this.t;
  }

  get evidence() {
    return {
      authority: this.kicks.authority,
      agreementFor: (periodMs: number) => this.kicks.agreement(periodMs, this.t),
    };
  }
}

/** Estimates arrive every 250ms, which is what BeatTracker actually does. */
function feed(clock: Clock, deck: Deck, count: number, bpm: number, passage?: Passage): void {
  for (let i = 0; i < count; i++) {
    deck.play(0.25, passage);
    clock.apply(estimateOf(bpm, deck.t), deck.evidence);
  }
}

function locked(bpm: number, seconds = 90): { clock: Clock; deck: Deck } {
  const deck = new Deck();
  const clock = new Clock();
  deck.play(seconds, { kickBpm: bpm });
  clock.apply(estimateOf(bpm, deck.t), deck.evidence);
  return { clock, deck };
}

describe('KickHistory', () => {
  it('reads the same at any level', () => {
    // Relative, not absolute: a quiet master and a loud one differ by more than a breakdown
    // and a drop do, so a fixed threshold would be tuned to one record and wrong for the next.
    const read = (level: number): number => {
      const deck = new Deck();
      deck.play(120, { kickBpm: 128, level });
      deck.play(6, { kickBpm: 128, level: level * 0.1 });
      return deck.kicks.authority;
    };
    expect(read(0.05)).toBeCloseTo(read(4), 2);
  });

  it('does not let a minute without a kick become typical', () => {
    // The window is the definition of "typical", so it has to outlast an intro.
    const deck = new Deck();
    deck.play(120, { kickBpm: 128 });
    deck.play(58, { kickBpm: null, bleed: 0.12 });
    expect(deck.kicks.authority).toBeLessThan(0.5);
  });

  it('agrees with the tempo its kicks are on, and not with another', () => {
    const deck = new Deck();
    deck.play(20, { kickBpm: 130 });
    expect(deck.kicks.agreement(bpmToPeriod(130), deck.t)).toBeGreaterThan(0.9);
    expect(deck.kicks.agreement(bpmToPeriod(170), deck.t)).toBeLessThan(0.4);
  });

  it('reports no agreement at all when there are no kicks', () => {
    // Absence of evidence is the answer, not a missing one: no kick is a reason not to believe
    // a new tempo rather than a reason to shrug.
    const deck = new Deck();
    deck.play(20, { kickBpm: null, bleed: 0.15 });
    expect(deck.kicks.agreement(bpmToPeriod(170), deck.t)).toBe(0);
  });

  it('answers 1 before it has enough history to have an opinion', () => {
    const deck = new Deck();
    deck.play(2, { kickBpm: 128 });
    expect(deck.kicks.authority).toBe(1);
  });
});

describe('Clock', () => {
  it('locks hard to the first estimate', () => {
    const { clock } = locked(128);
    expect(clock.bpm).toBeCloseTo(128, 1);
  });

  it('refuses a hats-and-snares intro', () => {
    // The observed failure: a minute of loud hats and snares jumped the grid 130 to 170 on a
    // record that was 130 throughout.
    const { clock, deck } = locked(130);
    feed(clock, deck, 200, 170, { kickBpm: null, bleed: 0.15 });
    expect(clock.bpm).toBeCloseTo(130, 1);
  });

  it('still has the real tempo when the record drops', () => {
    const { clock, deck } = locked(130);
    feed(clock, deck, 200, 170, { kickBpm: null, bleed: 0.15 });
    deck.cut();
    feed(clock, deck, 60, 130, { kickBpm: 130 });
    expect(clock.bpm).toBeCloseTo(130, 0);
  });

  it('cannot be walked by a breakdown', () => {
    const { clock, deck } = locked(128, 120);
    feed(clock, deck, 80, 128 * 1.3, { kickBpm: 128, level: 0.08 });
    expect(clock.bpm).toBeCloseTo(128, 2);
  });

  it('takes a genuine hard cut, and reasonably soon', () => {
    const { clock, deck } = locked(128);
    const cutAt = deck.t;
    deck.cut();

    let followedAfter: number | null = null;
    for (let i = 0; i < 160; i++) {
      deck.play(0.25, { kickBpm: 174, level: 1.1 });
      clock.apply(estimateOf(174, deck.t), deck.evidence);
      if (followedAfter === null && (clock.bpm ?? 0) > 140) followedAfter = (deck.t - cutAt) / 1000;
    }

    expect(clock.bpm).toBeCloseTo(174, 0);
    expect(followedAfter).toBeLessThan(10);
  });

  it('absorbs a beatmatched mix without re-locking', () => {
    const { clock, deck } = locked(128);
    deck.cut();
    feed(clock, deck, 40, 131, { kickBpm: 131 });
    expect(clock.bpm).toBeCloseTo(131, 0);
  });

  it('drifts with a pitch fader rather than snapping', () => {
    // DJs pitch by ±8% as a matter of course, so this must not read as a track change.
    const { clock, deck } = locked(128);
    deck.cut();
    feed(clock, deck, 48, 138, { kickBpm: 138 });
    expect(clock.bpm).toBeCloseTo(138, 0);
  });

  it('generates a beat grid from tempo and phase rather than from transients', () => {
    const { clock, deck } = locked(120);
    let beats = 0;
    // Four seconds of silence. A reactive clock would stop; a predictive one keeps counting.
    for (let t = deck.t; t < deck.t + 4000; t += 16) {
      if (clock.update(t)) beats++;
    }
    expect(beats).toBe(8);
  });
});

describe('tap tempo', () => {
  it('takes effect immediately', () => {
    const { clock, deck } = locked(128);
    clock.tap(deck.t);
    clock.tap(deck.t + bpmToPeriod(174));
    clock.tap(deck.t + 2 * bpmToPeriod(174));
    expect(clock.bpm).toBeCloseTo(174, 0);
    expect(clock.isManual).toBe(true);
  });

  it('hands back once detection agrees with it', () => {
    // Agreement is the track change seen from the other side, and tapping is the manual way
    // past a jump the automatic rule is being careful about.
    const { clock, deck } = locked(128);
    deck.cut();
    deck.play(2, { kickBpm: 174 });
    clock.tap(deck.t);
    clock.tap(deck.t + bpmToPeriod(174));
    clock.tap(deck.t + 2 * bpmToPeriod(174));

    feed(clock, deck, 12, 174, { kickBpm: 174 });
    expect(clock.isManual).toBe(false);
    expect(clock.source).toBe('detected');
    expect(clock.bpm).toBeCloseTo(174, 0);
  });

  it('is not undone by a few disagreeing estimates', () => {
    const { clock, deck } = locked(128);
    clock.tap(deck.t);
    clock.tap(deck.t + bpmToPeriod(100));
    const tapped = clock.bpm ?? 0;

    feed(clock, deck, 6, 128, { kickBpm: 128 });
    expect(clock.isManual).toBe(true);
    expect(clock.bpm ?? 0).toBeCloseTo(tapped, 2);
  });

  it('gives way to detection eventually, which is §9.4', () => {
    const { clock, deck } = locked(128);
    clock.tap(deck.t);
    clock.tap(deck.t + bpmToPeriod(100));

    feed(clock, deck, 18, 128, { kickBpm: 128 });
    expect(clock.isManual).toBe(false);
    expect(clock.bpm).toBeCloseTo(128, 0);
  });

  it('releases manual on request', () => {
    const { clock, deck } = locked(128);
    clock.tap(deck.t);
    clock.tap(deck.t + bpmToPeriod(140));
    clock.releaseManual();
    expect(clock.isManual).toBe(false);
  });
});
