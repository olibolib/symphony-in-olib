import { BANDS, BASS_RANGE, type BandName } from './bands';

/**
 * Spectral analysis: band levels and onset detection. DESIGN.md §9.2 steps 1–3.
 *
 * This produces the raw material the beat tracker (step 3) works from. It deliberately
 * knows nothing about tempo — its whole job is "how much energy is in each band right now,
 * and did something just hit".
 */

export interface BandReading {
  /** Smoothed level, 0–1, for driving continuous things. */
  readonly level: number;
  /** Raw spectral flux this frame — rising energy only. */
  readonly flux: number;
  /** True on the frame an onset was detected. */
  readonly onset: boolean;
}

export type Readings = Record<BandName, BandReading>;

const FFT_SIZE = 2048;

/**
 * Flux history for the adaptive threshold, in frames (~3s at 60fps).
 *
 * This was 0.7s and that was far too short. At 128 BPM, 0.7s is about a beat and a half —
 * so the statistics were made almost entirely of the kicks themselves, and when the kick
 * dropped out mean and deviation collapsed within a second. The detector became *most*
 * sensitive exactly when there was nothing to detect. Three seconds spans several bars, so
 * the baseline survives a breakdown.
 */
const HISTORY = 180;

/**
 * Absolute flux floor. Without one, a quiet passage drags the rolling mean toward zero and
 * then noise clears the threshold — the detector gets *more* trigger-happy the less there
 * is to detect.
 */
const FLUX_FLOOR = 5e-4;

/**
 * An onset must reach this fraction of the band's recent peak flux.
 *
 * This is what separates a kick from a bassline. Statistics tell you a value is unusual;
 * they cannot tell you it is *big*. A sub swell during a breakdown is statistically
 * remarkable and musically nothing. Requiring a real fraction of what an actual hit
 * measures in this band rejects it without any per-track tuning.
 */
const MIN_PEAK_RATIO = 0.28;

/**
 * Per-frame decay of that rolling peak — roughly halving every 4s at 60fps. Peak-hold with
 * a slow release, the same idea a compressor uses: it follows the track down over bars
 * rather than beats, so one quiet moment doesn't reset the reference.
 */
const PEAK_RELEASE = 0.997;

/**
 * Flux must fall back below `threshold × this` before another onset can fire. Sustained
 * energy in a band would otherwise re-trigger every refractory period, which is what made
 * the indicators look permanently lit.
 */
const REARM_RATIO = 0.6;

export class Analyser {
  private readonly ctx: AudioContext;
  private readonly node: AnalyserNode;
  // The explicit <ArrayBuffer> matters: bare `Float32Array` now widens to ArrayBufferLike,
  // which includes SharedArrayBuffer and so no longer matches getFloatFrequencyData.
  private readonly spectrum: Float32Array<ArrayBuffer>;

  /** Previous frame's magnitudes, for computing flux. */
  private readonly previous: Float32Array<ArrayBuffer>;

  /** Time-domain buffer, used only for the raw peak readout. */
  private readonly waveform: Float32Array<ArrayBuffer>;
  private peakLevel = 0;

  private readonly bins = new Map<BandName, { from: number; to: number }>();
  private readonly history = new Map<BandName, number[]>();
  private readonly lastOnsetAt = new Map<BandName, number>();
  private readonly armed = new Map<BandName, boolean>();
  private readonly peakFlux = new Map<BandName, number>();
  /** Last two flux values per band, for local-peak picking. */
  private readonly recent = new Map<BandName, [number, number]>();
  private readonly sensitivity = new Map<BandName, number>();
  private readonly levels = new Map<BandName, number>();

  private bassBins = { from: 0, to: 0 };
  private bassLevel = 0;
  private overallLevel = 0;

  private firstFrame = true;

  constructor(stream: MediaStream) {
    this.ctx = new AudioContext();
    this.node = this.ctx.createAnalyser();
    this.node.fftSize = FFT_SIZE;

    // Zero smoothing: the AnalyserNode's built-in smoothing averages across frames, which
    // is exactly what flux needs to *not* happen. We smooth levels ourselves, downstream.
    this.node.smoothingTimeConstant = 0;

    this.spectrum = new Float32Array(this.node.frequencyBinCount);
    this.previous = new Float32Array(this.node.frequencyBinCount);
    this.waveform = new Float32Array(this.node.fftSize);

    const source = this.ctx.createMediaStreamSource(stream);

    // A silent sink. Web Audio only reliably pulls a graph that reaches the destination,
    // but routing captured system audio back to the speakers would be a feedback loop —
    // so it goes to the destination through a gain of zero.
    const silence = this.ctx.createGain();
    silence.gain.value = 0;

    source.connect(this.node);
    this.node.connect(silence);
    silence.connect(this.ctx.destination);

    this.computeBins();

    for (const band of BANDS) {
      this.history.set(band.name, []);
      this.lastOnsetAt.set(band.name, 0);
      this.levels.set(band.name, 0);
      this.armed.set(band.name, true);
      this.peakFlux.set(band.name, 0);
      this.recent.set(band.name, [0, 0]);
      this.sensitivity.set(band.name, band.sensitivity);
    }
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  /** Onset threshold for a band, in standard deviations above its rolling mean flux. */
  setSensitivity(name: BandName, value: number): void {
    this.sensitivity.set(name, value);
  }

  getSensitivity(name: BandName): number {
    return this.sensitivity.get(name) ?? 0;
  }

  /** Browsers start audio contexts suspended until a user gesture. */
  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  close(): void {
    void this.ctx.close();
  }

  /**
   * Raw peak sample this frame, 0–1, straight off the waveform.
   *
   * Deliberately bypasses every bit of band and threshold logic: if this is dead, the
   * problem is capture; if this moves but the meters don't, the problem is our analysis.
   * It exists to make that distinction answerable without a debugger.
   */
  get peak(): number {
    return this.peakLevel;
  }

  /** Overall loudness 0–1. Not useful for structure detection — see DESIGN.md §10.1. */
  get energy(): number {
    return this.overallLevel;
  }

  /** Low-band level 0–1. This *is* the structure signal. */
  get bass(): number {
    return this.bassLevel;
  }

  /** Read the spectrum and update every band. Call once per frame. */
  read(now: number): Readings {
    this.node.getFloatFrequencyData(this.spectrum);

    this.node.getFloatTimeDomainData(this.waveform);
    let peak = 0;
    for (let i = 0; i < this.waveform.length; i++) {
      const v = Math.abs(this.waveform[i] ?? 0);
      if (v > peak) peak = v;
    }
    this.peakLevel = peak;

    const result = {} as Record<BandName, BandReading>;
    let magnitudeSum = 0;

    for (const band of BANDS) {
      const range = this.bins.get(band.name);
      if (!range) continue;

      let flux = 0;
      let magnitude = 0;

      for (let i = range.from; i <= range.to; i++) {
        const current = toLinear(this.spectrum[i] ?? -100);
        const delta = current - (this.previous[i] ?? 0);
        if (delta > 0) flux += delta;
        magnitude += current;
      }

      const width = range.to - range.from + 1;
      const level = magnitude / width;

      // Envelope: fast attack so hits register, slow release so the meter is readable.
      const smoothed = this.levels.get(band.name) ?? 0;
      const next = level > smoothed ? level : smoothed * 0.88 + level * 0.12;
      this.levels.set(band.name, next);

      result[band.name] = {
        level: clamp01(next * 4),
        flux,
        onset: this.detectOnset(band.name, flux, now),
      };
    }

    // Bass and overall level, for structure detection later.
    let bassSum = 0;
    for (let i = this.bassBins.from; i <= this.bassBins.to; i++) {
      bassSum += toLinear(this.spectrum[i] ?? -100);
    }
    const bassWidth = this.bassBins.to - this.bassBins.from + 1;
    this.bassLevel = clamp01((bassSum / bassWidth) * 4);

    for (let i = 0; i < this.spectrum.length; i++) {
      const v = toLinear(this.spectrum[i] ?? -100);
      magnitudeSum += v;
      this.previous[i] = v;
    }
    this.overallLevel = clamp01((magnitudeSum / this.spectrum.length) * 6);

    // The very first frame has no previous spectrum, so its "flux" is the entire signal
    // appearing from nothing. Reporting that would fire every onset at once.
    if (this.firstFrame) {
      this.firstFrame = false;
      for (const band of BANDS) {
        const existing = result[band.name];
        if (existing) result[band.name] = { ...existing, onset: false, flux: 0 };
      }
    }

    return result;
  }

  /**
   * Onset detection. Four independent gates, because no single one is sufficient.
   *
   * 1. **Shape** — the flux must be a local peak. A kick is a spike; a pad swelling or a
   *    sub rising is a ramp. Both can be large, only one is an onset. This is checked one
   *    frame late (we need the value after the candidate to know it turned over), which
   *    costs ~16ms — irrelevant, since the visual runs off a predicted grid anyway.
   *
   * 2. **Statistics** — above `mean + k × stddev` over ~3s. Catches "unusual for this
   *    track right now".
   *
   * 3. **Magnitude** — at least {@link MIN_PEAK_RATIO} of the band's recent peak. Catches
   *    "actually a hit, not merely unusual". This is the gate that stops bass notes reading
   *    as kicks during a breakdown, and it needs no per-track tuning because the reference
   *    is the track's own hits.
   *
   * 4. **Timing** — past the refractory period, and re-armed since the last onset.
   */
  private detectOnset(name: BandName, flux: number, now: number): boolean {
    const history = this.history.get(name);
    const spec = BANDS.find((b) => b.name === name);
    const recent = this.recent.get(name);
    if (!history || !spec || !recent) return false;

    // Rolling peak: jumps to any new maximum, leaks away slowly otherwise.
    const peak = Math.max(flux, (this.peakFlux.get(name) ?? 0) * PEAK_RELEASE);
    this.peakFlux.set(name, peak);

    history.push(flux);
    if (history.length > HISTORY) history.shift();

    // The candidate is the previous frame's flux; `flux` is only here to confirm it peaked.
    const [twoAgo, candidate] = recent;
    this.recent.set(name, [candidate, flux]);

    if (history.length < HISTORY) return false;

    // Gate 1 — shape.
    if (!(candidate > twoAgo && candidate >= flux)) return false;

    let sum = 0;
    for (const v of history) sum += v;
    const mean = sum / history.length;

    let variance = 0;
    for (const v of history) {
      const d = v - mean;
      variance += d * d;
    }
    const deviation = Math.sqrt(variance / history.length);

    const k = this.sensitivity.get(name) ?? spec.sensitivity;
    const threshold = mean + k * deviation;

    // Gate 4a — re-arm once the band has quietened down again.
    if (this.armed.get(name) !== true) {
      if (candidate < threshold * REARM_RATIO) this.armed.set(name, true);
      return false;
    }

    if (candidate < FLUX_FLOOR) return false;

    // Gate 2 — statistics.
    if (candidate <= threshold) return false;

    // Gate 3 — magnitude relative to what a real hit measures in this band.
    if (candidate < peak * MIN_PEAK_RATIO) return false;

    // Gate 4b — refractory.
    if (now - (this.lastOnsetAt.get(name) ?? 0) < spec.refractoryMs) return false;

    this.lastOnsetAt.set(name, now);
    this.armed.set(name, false);
    return true;
  }

  /** Map each band's Hz range onto FFT bin indices. */
  private computeBins(): void {
    const nyquist = this.ctx.sampleRate / 2;
    const binCount = this.node.frequencyBinCount;
    const toBin = (hz: number): number =>
      Math.max(0, Math.min(binCount - 1, Math.round((hz / nyquist) * binCount)));

    for (const band of BANDS) {
      this.bins.set(band.name, { from: toBin(band.fromHz), to: toBin(band.toHz) });
    }
    this.bassBins = { from: toBin(BASS_RANGE.fromHz), to: toBin(BASS_RANGE.toHz) };
  }
}

/** getFloatFrequencyData returns decibels; we want linear magnitude. */
function toLinear(db: number): number {
  return db <= -100 ? 0 : Math.pow(10, db / 20);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
