/**
 * Turns pushed PCM into a live audio node.
 *
 * Per-application capture arrives as buffers over IPC rather than as a MediaStream, so there
 * is nothing for Web Audio to connect to. This worklet is the adapter: chunks are posted in,
 * and it plays them out like any other source — which means the Analyser, the tracker and
 * everything downstream carry on unchanged.
 *
 * Plain JavaScript, not TypeScript: worklets are loaded as separate modules at runtime, so
 * this file is served as-is rather than going through the bundler.
 */

/**
 * Ring buffer size in frames — about 0.7s at 48kHz.
 *
 * Big enough to ride out IPC jitter, small enough that latency stays low. It only ever holds
 * what has arrived and not yet played.
 */
const CAPACITY = 32768;

class PcmSource extends AudioWorkletProcessor {
  constructor() {
    super();

    this.left = new Float32Array(CAPACITY);
    this.right = new Float32Array(CAPACITY);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.available = 0;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (data === 'reset') {
        this.writeIndex = 0;
        this.readIndex = 0;
        this.available = 0;
        return;
      }
      this.push(data);
    };
  }

  /** Interleaved 16-bit stereo in, deinterleaved float out. */
  push(buffer) {
    const view = new DataView(buffer);
    const frames = Math.floor(buffer.byteLength / 4);

    for (let i = 0; i < frames; i++) {
      // Oldest data is dropped rather than blocking. A late frame is worth less than a
      // stalled graph, and this only overflows if the engine has stopped consuming.
      if (this.available >= CAPACITY) {
        this.readIndex = (this.readIndex + 1) % CAPACITY;
        this.available--;
      }

      this.left[this.writeIndex] = view.getInt16(i * 4, true) / 32768;
      this.right[this.writeIndex] = view.getInt16(i * 4 + 2, true) / 32768;
      this.writeIndex = (this.writeIndex + 1) % CAPACITY;
      this.available++;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];
    const frames = outL.length;

    for (let i = 0; i < frames; i++) {
      if (this.available === 0) {
        // Underrun: silence rather than repeating the last block, which would read as a
        // rhythmic artefact to the onset detector.
        outL[i] = 0;
        outR[i] = 0;
        continue;
      }

      outL[i] = this.left[this.readIndex];
      outR[i] = this.right[this.readIndex];
      this.readIndex = (this.readIndex + 1) % CAPACITY;
      this.available--;
    }

    return true;
  }
}

registerProcessor('pcm-source', PcmSource);
