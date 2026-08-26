import { Analyser } from './Analyser';
import { AppCapture } from './AppCapture';
import { AudioInput, SYSTEM_SOURCE_ID } from './AudioInput';
import { BANDS, type BandName } from './bands';
import { APP_PREFIX } from '../ipc/protocol';
import { browserSettings, type Settings } from '../util/settings';

/**
 * What is being captured, and the sensitivities it is read with. DESIGN.md §8.
 *
 * Two capture paths that produce the same thing. A device arrives as a `MediaStream`; an
 * application arrives as PCM over IPC and is handed to a worklet — and `Analyser` takes either,
 * which is what made the second path cheap. Everything downstream is unchanged either way.
 *
 * Pulled out of `main.ts` because none of it is the engine's business. The engine wants an
 * `Analyser` to read each frame; how that analyser came to exist, which of a dozen sources it
 * is pointed at, and what to say when one fails are a separate job with its own state.
 */

const SENS_KEY = 'olib.sensitivity';

/** How this reports back. The engine supplies the HUD; a test supplies nothing much. */
export interface SourceReporter {
  status(message: string, isError?: boolean): void;
  devices(options: readonly { id: string; label: string }[], activeId: string): void;
  apps(list: readonly { processId: string; title: string }[]): void;
  sensitivity(band: BandName, value: number): void;
}

export class Sources {
  private readonly input = new AudioInput();
  private readonly appCapture = new AppCapture();
  private readonly sensitivities: Record<string, number>;

  /** The live analyser, or null while nothing is open. */
  private current: Analyser | null = null;

  /**
   * What is being captured, in the dropdown's own vocabulary: a device id, or
   * `app:<pid>|<title>`.
   *
   * Tracked separately from `input.activeId`, which only knows about devices — publishing that
   * one would report the previous device as active while an application is being captured,
   * which made the selection appear to revert.
   */
  private activeId: string | null = null;

  private label = '';

  constructor(
    private readonly report: SourceReporter,
    private readonly settings: Settings = browserSettings,
  ) {
    this.sensitivities = this.loadSensitivities();
    this.input.onDevicesChanged = () => void this.refresh();
    for (const band of BANDS) this.report.sensitivity(band.name, this.sensitivityFor(band.name));
  }

  /** The analyser to read this frame, if there is one. */
  get analyser(): Analyser | null {
    return this.current;
  }

  /** What to show beside the capture readout. */
  get captureLabel(): string {
    return this.label;
  }

  /** Frames received from an application capture, for the ASIO check. */
  get framesReceived(): number {
    return this.appCapture.framesReceived;
  }

  /** PCM from per-application capture. Straight through to the worklet; nothing inspects it. */
  acceptPcm(chunk: Float32Array | ArrayBuffer): void {
    this.appCapture.accept(chunk as never);
  }

  /** Republish the source lists, with whatever is actually being captured marked active. */
  async refresh(): Promise<void> {
    this.report.apps(await window.olib.apps.list());
    const options = await this.input.list();
    this.report.devices(
      options.map((o) => ({ id: o.id, label: o.label })),
      this.activeId ?? AudioInput.remembered() ?? SYSTEM_SOURCE_ID,
    );
  }

  /** Open a device. */
  async openDevice(id: string): Promise<void> {
    try {
      this.report.status('Opening…');
      this.close();
      this.appCapture.stop();

      const stream = await this.input.open(id);
      const analyser = await this.attach(new Analyser(stream));

      this.activeId = id;
      this.label = `${this.input.activeTrackLabel ?? 'unknown source'} · ${analyser.sampleRate / 1000} kHz`;
      this.report.status(`Capturing · ${this.label}`);
      await this.refresh();
    } catch (error) {
      // DESIGN.md §14: never fail silently, never take the app down.
      this.report.status(`Could not open source — ${describe(error)}`, true);
    }
  }

  /**
   * Capture one application rather than a device.
   *
   * Works whatever output device the application is using, and cannot pick up anything else —
   * no notification pings in the club PA. The catch is ASIO: an application driving its
   * interface directly bypasses the Windows audio engine, and there is nothing to capture. We
   * detect that by seeing no frames arrive at all, which is a different thing from silence.
   */
  async openApp(processId: string, title: string): Promise<void> {
    try {
      this.report.status(`Opening ${title}…`);
      this.close();
      this.input.close();

      const node = await this.appCapture.start(processId, title);
      await this.attach(new Analyser(node));

      this.activeId = `${APP_PREFIX}${processId}|${title}`;
      this.label = title;
      this.report.status(`Capturing ${title}`);
      await this.refresh();

      // If nothing at all has arrived after a few seconds, say why rather than showing a dead
      // meter and letting it look like the app is broken.
      window.setTimeout(() => {
        if (this.appCapture.framesReceived === 0) {
          this.report.status(
            `No audio from ${title} — it may be using ASIO, which bypasses Windows audio capture`,
            true,
          );
        }
      }, 4000);
    } catch (error) {
      this.report.status(`Could not capture ${title} — ${describe(error)}`, true);
    }
  }

  /**
   * Come up already capturing: last used source, or system output on a first run.
   *
   * Unless the last attempt killed us. A source that crashes the renderer would otherwise be
   * retried on every launch, and since the reload happens automatically that is an infinite
   * loop with a black window. If the crash flag is set we stop and hand it to the user.
   */
  async start(): Promise<void> {
    await this.refresh();

    const crashed = AudioInput.crashedOn();
    if (crashed !== null) {
      AudioInput.clearCrashFlag();
      this.report.status(`"${crashed}" failed last time — pick a source to try again`, true);
      return;
    }

    await this.openDevice(AudioInput.remembered() ?? SYSTEM_SOURCE_ID);
  }

  /**
   * Onset sensitivity for one band.
   *
   * These want to be set against real records rather than guessed at, so they are a live
   * control rather than a constant (§9.2.1).
   */
  sensitivityFor(band: BandName): number {
    const stored = this.sensitivities[band];
    if (typeof stored === 'number') return stored;
    return BANDS.find((b) => b.name === band)?.sensitivity ?? 2;
  }

  setSensitivity(band: BandName, value: number): void {
    this.sensitivities[band] = value;
    this.settings.set(SENS_KEY, JSON.stringify(this.sensitivities));
    this.current?.setSensitivity(band, value);
    this.report.sensitivity(band, value);
  }

  private async attach(next: Analyser): Promise<Analyser> {
    await next.resume();
    for (const band of BANDS) next.setSensitivity(band.name, this.sensitivityFor(band.name));
    this.current = next;
    return next;
  }

  private close(): void {
    this.current?.close();
    this.current = null;
  }

  private loadSensitivities(): Record<string, number> {
    try {
      const raw = this.settings.get(SENS_KEY);
      return raw ? (JSON.parse(raw) as Record<string, number>) : {};
    } catch {
      // Corrupt or absent. The band defaults are perfectly usable.
      return {};
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
