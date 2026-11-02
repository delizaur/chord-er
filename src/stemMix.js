// Mixes the separated stems with per-stem volumes into a 16-bit stereo WAV, which the <audio>
// element plays in place of the original file. One element keeps a single playback clock for the
// synths and the click, and keeps the pitch at the slower speeds.

// [left, right] Float32Arrays → [left, right] Int16Arrays, halving the memory kept per stem.
export function toInt16(stereo) {
  return stereo.map((channel) => {
    const out = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) out[i] = Math.max(-1, Math.min(1, channel[i])) * 32767;
    return out;
  });
}

// `stems` are [left, right] Int16Arrays of equal length, `gains` their volumes (0–1).
export function mixToWav(stems, gains, sampleRate) {
  const used = stems.filter((_, k) => gains[k] > 0);
  const usedGains = gains.filter((g) => g > 0);
  const length = stems[0][0].length;
  const view = new DataView(new ArrayBuffer(44 + length * 4));
  const text = (offset, s) => [...s].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + length * 4, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true); // stereo
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, length * 4, true);
  const out = new Int16Array(view.buffer, 44);
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < length; i++) {
      let v = 0;
      for (let k = 0; k < used.length; k++) v += used[k][c][i] * usedGains[k];
      out[2 * i + c] = Math.max(-32768, Math.min(32767, Math.round(v)));
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}
