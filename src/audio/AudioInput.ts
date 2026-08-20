/**
 * Audio capture and device selection. DESIGN.md §8.
 *
 * Two kinds of source:
 *   - a real input device (interface, mic, loopback cable, Stereo Mix)
 *   - "System output", which captures whatever the machine is playing
 *
 * The second is the one that matters for the intended use, and it is only possible because
 * this is Electron. In a plain browser it would need a virtual audio cable installed, or
 * a screen-share prompt with a "you are sharing" bar stuck on screen.
 */

export const SYSTEM_SOURCE_ID = '__system__';

export interface InputOption {
  readonly id: string;
  readonly label: string;
  readonly isSystem: boolean;
}

const STORAGE_KEY = 'olib.inputDeviceId';

/**
 * Set while a source is being opened and cleared once it succeeds. If it is still set at
 * startup, the last attempt did not survive — the renderer died mid-open — so we know not
 * to try that source again automatically and loop forever.
 */
const PENDING_KEY = 'olib.pendingSource';

export class AudioInput {
  private stream: MediaStream | null = null;
  private currentId: string | null = null;

  /** Fired when the OS device list changes (something plugged in or removed). */
  onDevicesChanged: (() => void) | null = null;

  constructor() {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      this.onDevicesChanged?.();
    });
  }

  /** The device the app was last using, if any. */
  static remembered(): string | null {
    return localStorage.getItem(STORAGE_KEY);
  }

  /** A source that was mid-open when the app last died, if any. */
  static crashedOn(): string | null {
    return localStorage.getItem(PENDING_KEY);
  }

  static clearCrashFlag(): void {
    localStorage.removeItem(PENDING_KEY);
  }

  get activeId(): string | null {
    return this.currentId;
  }

  /** Label of the audio track actually captured — not what we asked for, what we got. */
  get activeTrackLabel(): string | null {
    return this.stream?.getAudioTracks()[0]?.label ?? null;
  }

  /**
   * List selectable sources.
   *
   * Device *labels* are hidden until the page has been granted microphone access at least
   * once — a browser privacy measure that Electron inherits even though we auto-grant the
   * permission. So we open a throwaway stream first to unlock the names, then close it.
   */
  async list(): Promise<InputOption[]> {
    let devices = await navigator.mediaDevices.enumerateDevices();

    if (devices.some((d) => d.kind === 'audioinput' && d.label === '')) {
      try {
        const primer = await navigator.mediaDevices.getUserMedia({ audio: true });
        primer.getTracks().forEach((t) => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
      } catch {
        // No input devices at all, or access refused. The system source may still work.
      }
    }

    const inputs: InputOption[] = devices
      .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications')
      .map((d) => ({
        id: d.deviceId,
        label: d.label || 'Unnamed input',
        isSystem: false,
      }));

    return [
      { id: SYSTEM_SOURCE_ID, label: 'System output (what you hear)', isSystem: true },
      ...inputs,
    ];
  }

  /** Open a source and return its stream. Closes any previous one first. */
  async open(id: string): Promise<MediaStream> {
    this.close();
    localStorage.setItem(PENDING_KEY, id);

    const stream =
      id === SYSTEM_SOURCE_ID ? await captureSystemAudio() : await captureDevice(id);

    this.stream = stream;
    this.currentId = id;
    localStorage.setItem(STORAGE_KEY, id);
    localStorage.removeItem(PENDING_KEY);
    return stream;
  }

  close(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.currentId = null;
  }
}

async function captureDevice(deviceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      // All three of these "helpfully" destroy music. They exist for speech.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });
}
/**
 * System loopback, via `getDisplayMedia` answered by the main process with
 * `audio: 'loopback'` (see electron/main.ts). No picker appears.
 *
 * Three things here are load-bearing, all learned the hard way:
 *
 * 1. **Ask for audio only.** Requesting a video track made Windows Graphics Capture try to
 *    open the monitor, which fails with E_ACCESSDENIED on some machines and takes the audio
 *    down with it. We never wanted the video.
 *
 * 2. **Never use the legacy `chromeMediaSource: 'desktop'` constraint for audio-only.**
 *    That path requires audio and video together; audio with `video: false` is rejected by
 *    the browser process as a malformed IPC, which terminates the whole renderer — a black
 *    window with no error in the page.
 *
 * 3. **If a video track does arrive anyway, do not stop it.** Chromium ties the capture
 *    session to it, so stopping it to save CPU silently kills the audio too. Shrink it.
 */
async function captureSystemAudio(): Promise<MediaStream> {
  let stream: MediaStream;

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false });
  } catch {
    // Some Chromium builds refuse a display capture with no video requested at all.
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  }

  const video = stream.getVideoTracks()[0];
  if (video) {
    try {
      await video.applyConstraints({ width: 2, height: 2, frameRate: 1 });
    } catch {
      // Shrinking is an optimisation; the capture still works without it.
    }
  }

  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('system capture returned no audio track — loopback unavailable');
  }

  return stream;
}
