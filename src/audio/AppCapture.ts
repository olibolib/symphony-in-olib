import { PCM_SAMPLE_RATE } from '../ipc/protocol';
import workletUrl from './pcm-worklet.js?url';

/**
 * Per-application audio capture. DESIGN.md §8.2.
 *
 * Windows process loopback gives us one application's output — Traktor, rekordbox, a browser
 * — regardless of which device it is playing to, and with nothing else mixed in. That is the
 * difference between capturing your set and capturing your set plus a Discord notification.
 *
 * PCM arrives over IPC rather than as a `MediaStream`, so a worklet stands in as the source
 * node. From the Analyser's point of view nothing has changed.
 */
export class AppCapture {
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private frames = 0;

  /** Title of whatever is being captured, for the status line. */
  title = '';

  /**
   * Start capturing a process. Returns the node to analyse, or throws with a reason.
   *
   * The context is created at the helper's sample rate so nothing is resampled on the way
   * in — 48kHz throughout, which keeps the FFT bin maths honest.
   */
  async start(processId: string, title: string): Promise<AudioWorkletNode> {
    this.stop();

    const result = await window.olib.apps.start(processId);
    if (!result.ok) {
      throw new Error(result.message ?? 'could not start application capture');
    }

    const context = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
    await context.audioWorklet.addModule(workletUrl);

    const node = new AudioWorkletNode(context, 'pcm-source', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    this.context = context;
    this.node = node;
    this.title = title;
    this.frames = 0;

    return node;
  }

  /** Feed a chunk in. Called for every buffer the helper emits. */
  accept(chunk: ArrayBuffer): void {
    if (!this.node) return;
    this.frames += chunk.byteLength / 4;
    this.node.port.postMessage(chunk, [chunk]);
  }

  /**
   * Frames received so far.
   *
   * Used to tell "capturing silence" from "capturing nothing". An application on ASIO
   * bypasses the Windows audio engine entirely, so no data arrives at all — and that
   * deserves a different message from a track that happens to be quiet.
   */
  get framesReceived(): number {
    return this.frames;
  }

  get audioContext(): AudioContext | null {
    return this.context;
  }

  /** Safe to call when nothing is running, and safe to call twice. */
  stop(): void {
    window.olib.apps.stop();

    this.node?.port.postMessage('reset');
    this.node?.disconnect();

    const context = this.context;
    if (context !== null && context.state !== 'closed') {
      void context.close().catch(() => {
        // Already closing. Nothing to do and nothing worth reporting.
      });
    }

    this.node = null;
    this.context = null;
    this.frames = 0;
    this.title = '';
  }
}
