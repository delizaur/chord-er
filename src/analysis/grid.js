import { TRACK_STEP } from './tempo.js';

// Beat times (seconds) across the song from a tempo candidate (see detectTempo).
// `mult` scales the tempo (2 = double, 0.5 = half); `half` shifts the grid by half a beat.
export function buildBeats(candidate, { mult, half }, duration) {
  const beats = [];
  if (!candidate) {
    for (let t = 0; t < duration; t += 0.5) beats.push(t);
    return Float64Array.from(beats);
  }
  const { period, phase } = candidate;
  const tracked = candidate.beats.length > 1 ? candidate.beats : null;
  // Time (ms) of the candidate's beat x (fractional; 0 = the beat at phase).
  const timeOf = (x) => {
    if (!tracked) return phase + x * period;
    const i = Math.max(0, Math.min(tracked.length - 2, Math.floor(x / TRACK_STEP)));
    return tracked[i] + (tracked[i + 1] - tracked[i]) * (x / TRACK_STEP - i);
  };
  const step = 1 / mult;
  let x = half ? step / 2 : 0;
  while (timeOf(x - step) >= 0) x -= step;
  while (timeOf(x) < 0) x += step;
  for (; timeOf(x) < duration * 1000; x += step) beats.push(timeOf(x) / 1000);
  return Float64Array.from(beats);
}

// Averages frame-level chroma over each beat. Frames near the middle of a beat weigh more,
// since their analysis window overlaps the neighbouring beats the least.
export function beatSync(beats, duration, { frameTimes, treble, bass, energy }) {
  const n = beats.length;
  const frames = frameTimes.length;
  const beatTreble = new Float32Array(n * 12);
  const beatBass = new Float32Array(n * 12);
  const beatEnergy = new Float64Array(n);

  let f = 0;
  for (let i = 0; i < n; i++) {
    const start = beats[i];
    const end = i + 1 < n ? beats[i + 1] : duration;
    while (f < frames && frameTimes[f] < start) f++;
    let first = f;
    let last = f;
    while (last < frames && frameTimes[last] < end) last++;
    if (last === first) {
      // Beat shorter than a hop: use the nearest frame.
      first = Math.min(frames - 1, f);
      last = first + 1;
    }
    let total = 0;
    for (let t = first; t < last; t++) {
      const w = 0.1 + Math.sin((Math.PI * (frameTimes[t] - start)) / (end - start)) ** 2;
      for (let c = 0; c < 12; c++) {
        beatTreble[i * 12 + c] += w * treble[t * 12 + c];
        beatBass[i * 12 + c] += w * bass[t * 12 + c];
      }
      beatEnergy[i] += w * energy[t];
      total += w;
    }
    for (let c = 0; c < 12; c++) {
      beatTreble[i * 12 + c] /= total;
      beatBass[i * 12 + c] /= total;
    }
    beatEnergy[i] /= total;
  }

  // Loudness in dB relative to the loud parts of the song (95th percentile).
  const db = Array.from(beatEnergy, (e) => 10 * Math.log10(e + 1e-12));
  const reference = [...db].sort((a, b) => a - b)[Math.floor(0.95 * (n - 1))] ?? 0;
  const loudness = Float32Array.from(db, (d) => d - reference);

  return { treble: beatTreble, bass: beatBass, loudness };
}
