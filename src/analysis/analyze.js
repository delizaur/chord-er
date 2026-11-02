import { computeChroma } from './chroma.js';
import { detectTempo } from './tempo.js';

const PEAKS_PER_SEC = 100;

// Heavy, settings-independent analysis: tempo candidates, frame-level chroma, frame energy
// and a waveform overview. The beat grid, beat-synchronous chroma and chords are derived on the
// main thread, so tempo and chord settings can change without re-analyzing.
export function analyzeAudio(samples, sampleRate, onProgress = () => {}) {
  const duration = samples.length / sampleRate;

  onProgress('Detecting beats', 0);
  const tempoCandidates = detectTempo(samples, sampleRate);

  onProgress('Analyzing harmony', 0.3);
  const { frameTimes, treble, bass, bassSalience, energy } = computeChroma(samples, sampleRate, (p) =>
    onProgress('Analyzing harmony', 0.3 + 0.7 * p),
  );

  return {
    duration,
    tempoCandidates,
    frameTimes,
    treble,
    bass,
    bassSalience,
    energy,
    peaks: computePeaks(samples, sampleRate),
    peaksPerSec: PEAKS_PER_SEC,
  };
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
