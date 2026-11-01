import { computeChroma } from './chroma.js';
import { completeBeatGrid, estimateTempo, onsetEnvelope, trackBeats } from './beats.js';

const ONSET_FRAME = 1024;
const ONSET_HOP = 512;
const PEAKS_PER_SEC = 100;

// Heavy, chord-vocabulary-independent analysis: beats, beat-synchronous chroma,
// loudness and a waveform overview. Chord decoding happens later on the main
// thread so settings can change without re-analyzing.
export function analyzeAudio(samples, sampleRate, onProgress = () => {}) {
  const duration = samples.length / sampleRate;

  onProgress('Detecting beats', 0);
  const env = onsetEnvelope(samples, sampleRate, ONSET_FRAME, ONSET_HOP, (p) =>
    onProgress('Detecting beats', 0.25 * p),
  );
  const frameRate = sampleRate / ONSET_HOP;
  const period = estimateTempo(env, frameRate);
  const frameOffset = ONSET_FRAME / 2 / sampleRate;
  const tracked = trackBeats(env, period).map((f) => f / frameRate + frameOffset);
  const beatPeriod = period / frameRate;
  const beats = Float64Array.from(completeBeatGrid(tracked, beatPeriod, duration));

  onProgress('Analyzing harmony', 0.3);
  const chroma = computeChroma(samples, sampleRate, (p) =>
    onProgress('Analyzing harmony', 0.3 + 0.65 * p),
  );

  onProgress('Aligning to beats', 0.97);
  return {
    duration,
    tempo: 60 / beatPeriod,
    tuning: chroma.tuning,
    beats,
    ...beatSync(beats, duration, chroma),
    peaks: computePeaks(samples, sampleRate),
    peaksPerSec: PEAKS_PER_SEC,
  };
}

// Averages frame-level chroma over each beat interval.
function beatSync(beats, duration, { frameTimes, treble, bass, energy }) {
  const n = beats.length;
  const frames = frameTimes.length;
  const beatTreble = new Float32Array(n * 12);
  const beatBass = new Float32Array(n * 12);
  const beatEnergy = new Float64Array(n);

  let f = 0;
  for (let i = 0; i < n; i++) {
    const end = i + 1 < n ? beats[i + 1] : duration;
    while (f < frames && frameTimes[f] < beats[i]) f++;
    let first = f;
    let last = f;
    while (last < frames && frameTimes[last] < end) last++;
    if (last === first) {
      // Beat shorter than a hop: use the nearest frame.
      first = Math.min(frames - 1, f);
      last = first + 1;
    }
    for (let t = first; t < last; t++) {
      for (let c = 0; c < 12; c++) {
        beatTreble[i * 12 + c] += treble[t * 12 + c];
        beatBass[i * 12 + c] += bass[t * 12 + c];
      }
      beatEnergy[i] += energy[t];
    }
    const count = last - first;
    for (let c = 0; c < 12; c++) {
      beatTreble[i * 12 + c] /= count;
      beatBass[i * 12 + c] /= count;
    }
    beatEnergy[i] /= count;
  }

  // Loudness in dB relative to the loud parts of the song (95th percentile).
  const db = Array.from(beatEnergy, (e) => 10 * Math.log10(e + 1e-12));
  const reference = [...db].sort((a, b) => a - b)[Math.floor(0.95 * (n - 1))] ?? 0;
  const loudness = Float32Array.from(db, (d) => d - reference);

  return { treble: beatTreble, bass: beatBass, loudness };
}

function computePeaks(samples, sampleRate) {
  const size = Math.max(1, Math.floor(sampleRate / PEAKS_PER_SEC));
  const peaks = new Float32Array(Math.ceil(samples.length / size));
  let max = 0;
  for (let i = 0; i < peaks.length; i++) {
    let p = 0;
    const end = Math.min(samples.length, (i + 1) * size);
    for (let j = i * size; j < end; j++) p = Math.max(p, Math.abs(samples[j]));
    peaks[i] = p;
    max = Math.max(max, p);
  }
  if (max > 0) for (let i = 0; i < peaks.length; i++) peaks[i] /= max;
  return peaks;
}
