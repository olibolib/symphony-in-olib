/**
 * Throwaway spike: can we capture a specific application's audio?
 *
 * The question this answers is whether process loopback sees Traktor at all. It goes through
 * the Windows audio engine, so if Traktor is driving the interface over ASIO it bypasses
 * that entirely and we would capture silence — which would rule the whole approach out.
 *
 *   node scripts/spike-loopback.mjs            list capturable windows
 *   node scripts/spike-loopback.mjs <pid>      capture that process for 8s and report levels
 *   node scripts/spike-loopback.mjs traktor    match a window title instead of a pid
 */

import { getActiveWindowProcessIds, startAudioCapture, stopAudioCapture } from 'application-loopback';

const arg = process.argv[2];

const windows = await getActiveWindowProcessIds();

if (!arg) {
  console.log('Capturable windows:\n');
  for (const w of windows) {
    console.log(`  ${String(w.processId).padStart(7)}  ${w.title}`);
  }
  console.log('\nRe-run with a pid, or part of a window title:');
  console.log('  node scripts/spike-loopback.mjs traktor');
  process.exit(0);
}

const target = /^\d+$/.test(arg)
  ? windows.find((w) => String(w.processId) === arg)
  : windows.find((w) => w.title.toLowerCase().includes(arg.toLowerCase()));

if (!target) {
  console.error(`No window matching "${arg}". Run with no arguments to list them.`);
  process.exit(1);
}

console.log(`Capturing: ${target.title}  (pid ${target.processId})`);
console.log('Play something now — listening for 8 seconds.\n');

let chunks = 0;
let bytes = 0;
let peak = 0;
let sumSquares = 0;
let samples = 0;
let firstDataAt = 0;
const startedAt = Date.now();

startAudioCapture(String(target.processId), {
  onData: (data) => {
    if (firstDataAt === 0) firstDataAt = Date.now() - startedAt;
    chunks++;
    bytes += data.byteLength;

    // 16-bit signed stereo, little-endian.
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i + 1 < data.byteLength; i += 2) {
      const s = view.getInt16(i, true) / 32768;
      const a = Math.abs(s);
      if (a > peak) peak = a;
      sumSquares += s * s;
      samples++;
    }
  },
});

setTimeout(() => {
  stopAudioCapture(String(target.processId));

  const rms = samples > 0 ? Math.sqrt(sumSquares / samples) : 0;
  const db = (v) => (v > 0 ? `${(20 * Math.log10(v)).toFixed(1)} dB` : '-inf');

  console.log('--- result ---');
  console.log(`chunks        ${chunks}`);
  console.log(`bytes         ${bytes}  (~${Math.round(bytes / 8 / 1024)} KB/s)`);
  console.log(`samples       ${samples}`);
  console.log(`first data    ${firstDataAt > 0 ? `${firstDataAt} ms after start` : 'never arrived'}`);
  console.log(`peak          ${db(peak)}`);
  console.log(`rms           ${db(rms)}`);
  console.log('');

  if (samples === 0) {
    console.log('VERDICT: no audio at all. Either the process makes no sound, or it is');
    console.log('bypassing the Windows audio engine (ASIO), which process loopback cannot see.');
  } else if (peak < 0.0005) {
    console.log('VERDICT: data arrives but it is silence. Same ASIO suspicion — the stream');
    console.log('exists but carries nothing.');
  } else {
    console.log('VERDICT: working. Real audio is reaching us from that process.');
  }

  process.exit(0);
}, 8000);
