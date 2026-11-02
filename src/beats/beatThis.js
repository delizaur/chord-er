// Beat and downbeat tracking with Beat This! (Foscarin, Schlüter, Widmer, ISMIR 2024; CPJKU/beat_this,
// MIT), using an ONNX export of the network only. The log-mel front end, chunking and "minimal"
// postprocessing replicate beat_this.preprocessing.LogMelSpect and beat_this.inference.

import { FFT } from '../analysis/fft.js';
import { trackBars, trackBeats } from './dbn.js';

export const SAMPLE_RATE = 22050;
const N_FFT = 1024;
const HOP = 441; // 50 frames per second
const FPS = SAMPLE_RATE / HOP;
const N_MELS = 128;
const BINS = N_FFT / 2 + 1;
const CHUNK = 1500; // frames per network call (30 s), as trained
const BORDER = 6; // frames discarded at each chunk edge

// Log-mel spectrogram, frames × 128 (row-major): |STFT| / sqrt(n_fft) (torchaudio
// normalized="frame_length"), mel projection, then log1p(1000 · x).
// `window` (n_fft) and `melFilters` (128 rows × 513 bins) come from the export's frontend.json.
export function logMel(samples, window, melFilters) {
  const pad = N_FFT / 2; // center=True with reflect padding
  const n = samples.length;
  const frames = Math.floor(n / HOP) + 1;
  const fft = new FFT(N_FFT);
  const frame = new Float64Array(N_FFT);
  const mag = new Float64Array(BINS);
  const out = new Float32Array(frames * N_MELS);
  const norm = Math.sqrt(N_FFT);
  for (let t = 0; t < frames; t++) {
    const start = t * HOP - pad;
    for (let i = 0; i < N_FFT; i++) {
      let j = start + i;
      if (j < 0) j = -j;
      if (j >= n) j = 2 * (n - 1) - j;
      frame[i] = (samples[j] ?? 0) * window[i];
    }
    fft.forward(frame);
    for (let k = 0; k < BINS; k++) mag[k] = Math.sqrt(fft.re[k] ** 2 + fft.im[k] ** 2) / norm;
    for (let m = 0; m < N_MELS; m++) {
      let s = 0;
      const row = m * BINS;
      for (let k = 0; k < BINS; k++) s += melFilters[row + k] * mag[k];
      out[t * N_MELS + m] = Math.log1p(1000 * s);
    }
  }
  return { spect: out, frames };
}

// beat_this.inference.split_piece (avoid_short_end=True): chunk start frames, possibly negative.
function chunkStarts(frames) {
  const step = CHUNK - 2 * BORDER;
  const starts = [];
  for (let s = -BORDER; s < frames - BORDER; s += step) starts.push(s);
  if (frames > step) starts[starts.length - 1] = frames - (CHUNK - BORDER);
  return starts;
}

// Runs the network over overlapping chunks and stitches the logits like aggregate_prediction
// with overlap_mode="keep_first". `run(spect, frames)` resolves to { beat, downbeat } logits.
export async function predict(spect, frames, run, onProgress = () => {}) {
  const beat = new Float32Array(frames).fill(-1000);
  const downbeat = new Float32Array(frames).fill(-1000);
  const starts = chunkStarts(frames);
  const results = [];
  for (const [i, start] of starts.entries()) {
    // Zero padding on the left before the piece starts, and up to BORDER frames on the right.
    const from = Math.max(start, 0);
    const to = Math.min(start + CHUNK, frames);
    const left = Math.max(0, -start);
    const right = Math.max(0, Math.min(BORDER, start + CHUNK - frames));
    const length = left + (to - from) + right;
    const chunk = new Float32Array(length * N_MELS);
    chunk.set(spect.subarray(from * N_MELS, to * N_MELS), left * N_MELS);
    results.push({ start, length, ...(await run(chunk, length)) });
    onProgress((i + 1) / starts.length);
  }
  // Later chunks first, so earlier chunks overwrite the overlap ("keep_first").
  for (const { start, length, beat: b, downbeat: d } of results.reverse()) {
    for (let k = BORDER; k < length - BORDER; k++) {
      const f = start + k;
      if (f < 0 || f >= frames || f >= start + CHUNK - BORDER) continue;
      beat[f] = b[k];
      downbeat[f] = d[k];
    }
  }
  return { beat, downbeat };
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

// Beat times (s) and downbeat flags from the network's logits: DBN beat tracking (steady
// metrical level, follows tempo drift), bars of 3 or 4 beats, and each beat refined between
// frames by fitting a parabola to the logits around its peak.
export function beatsFromLogits({ beat, downbeat }) {
  // The DBN only works with whole-frame beat intervals; it decides which beats exist, and each
  // beat then moves to the network's own peak within ±3 frames (beats are ≥ 14 frames apart).
  const frames = trackBeats(Float32Array.from(beat, sigmoid), FPS).map((f) => {
    let peak = f;
    for (let k = Math.max(0, f - 3); k <= Math.min(beat.length - 1, f + 3); k++) if (beat[k] > beat[peak]) peak = k;
    return peak;
  });
  const downbeats = trackBars(frames, Float32Array.from(downbeat, sigmoid));
  const beats = frames.map((f) => {
    const a = beat[f - 1];
    const b = beat[f];
    const c = beat[f + 1];
    if (a === undefined || c === undefined || b < a || b < c) return f / FPS;
    const denom = a - 2 * b + c;
    return (f + (denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0)) / FPS;
  });
  return { beats, downbeats };
}
