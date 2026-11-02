import { FFT, hannWindow } from './fft.js';

const FRAME_SIZE = 8192;
const HOP_SIZE = 1024;
const MIDI_LOW = 28; // E1, the lowest note of a 4-string bass
const MIDI_HIGH = 95; // B6
const BASS_LOW = 33; // bass chroma: A1..G#3
const BASS_HIGH = 57;
const TREBLE_LOW = 48; // treble chroma: C3..B6
const SEMITONES = MIDI_HIGH - MIDI_LOW + 1;

const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);
const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);

// Computes treble and bass chromagrams and bass-note salience (12 bins per frame each) plus
// frame energy.
export function computeChroma(samples, sampleRate, onProgress = () => {}) {
  const fft = new FFT(FRAME_SIZE);
  const window = hannWindow(FRAME_SIZE);
  const binCount = Math.min(
    FRAME_SIZE / 2,
    Math.ceil((midiToHz(MIDI_HIGH + 0.5) * FRAME_SIZE) / sampleRate) + 2,
  );
  const frameCount = Math.max(1, Math.floor((samples.length - FRAME_SIZE) / HOP_SIZE) + 1);

  // Only bins below ~2 kHz are kept, so storing the whole magnitude spectrogram is cheap.
  const mags = new Float32Array(frameCount * binCount);
  const frame = new Float64Array(FRAME_SIZE);
  const spectrum = new Float64Array(binCount);
  for (let t = 0; t < frameCount; t++) {
    const start = t * HOP_SIZE;
    for (let i = 0; i < FRAME_SIZE; i++) {
      const j = start + i;
      frame[i] = j < samples.length ? samples[j] * window[i] : 0;
    }
    fft.magnitudes(frame, spectrum);
    mags.set(spectrum, t * binCount);
    if (t % 64 === 0) onProgress((0.85 * t) / frameCount);
  }

  const tuning = estimateTuning(mags, frameCount, binCount, sampleRate);
  const { power, energy } = semitoneSpectrogram(mags, frameCount, binCount, sampleRate, tuning);
  onProgress(0.9);
  const bassSalience = bassNoteSalience(power, frameCount);
  const pitch = enhance(power, frameCount);

  const treble = new Float32Array(frameCount * 12);
  const bass = new Float32Array(frameCount * 12);
  for (let t = 0; t < frameCount; t++) {
    for (let s = 0; s < SEMITONES; s++) {
      const midi = MIDI_LOW + s;
      const v = pitch[t * SEMITONES + s];
      if (midi >= TREBLE_LOW) treble[t * 12 + (midi % 12)] += v;
      if (midi >= BASS_LOW && midi < BASS_HIGH) bass[t * 12 + (midi % 12)] += v;
    }
  }

  const frameTimes = new Float64Array(frameCount);
  for (let t = 0; t < frameCount; t++) frameTimes[t] = (t * HOP_SIZE + FRAME_SIZE / 2) / sampleRate;
  onProgress(1);
  return { frameTimes, treble, bass, bassSalience, energy, tuning };
}

// Bass-note candidates E1..E3 and the partials (semitone offset, weight) that vote for each.
const BASS_NOTES = [28, 52];
const BASS_PARTIALS = [[0, 1], [12, 0.7], [19, 0.45], [24, 0.3], [28, 0.2]];

// How strongly each pitch class sounds as a bass note, per frame (subharmonic summation): every
// candidate note collects its fundamental and overtones, so the fundamental of a bass line beats
// its own octave, fifth and third partials. Each pitch class keeps its best octave.
function bassNoteSalience(power, frameCount) {
  const out = new Float32Array(frameCount * 12);
  const amp = new Float64Array(SEMITONES);
  for (let t = 0; t < frameCount; t++) {
    for (let s = 0; s < SEMITONES; s++) amp[s] = Math.sqrt(power[t * SEMITONES + s]);
    for (let m = BASS_NOTES[0]; m <= BASS_NOTES[1]; m++) {
      let v = 0;
      for (const [offset, weight] of BASS_PARTIALS) {
        const s = m + offset - MIDI_LOW;
        if (s < SEMITONES) v += weight * amp[s];
      }
      const o = t * 12 + (m % 12);
      if (v > out[o]) out[o] = v;
    }
  }
  return out;
}

// Global tuning offset in semitones (-0.5..0.5), from a magnitude-weighted
// histogram of how far spectral peaks sit from equal-tempered pitches.
function estimateTuning(mags, frameCount, binCount, sampleRate) {
  const hist = new Float64Array(100);
  const kLow = Math.ceil((100 * FRAME_SIZE) / sampleRate);
  for (let t = 0; t < frameCount; t += 2) {
    const o = t * binCount;
    let frameMax = 0;
    for (let k = kLow; k < binCount; k++) frameMax = Math.max(frameMax, mags[o + k]);
    const floor = frameMax * 0.05;
    for (let k = kLow; k < binCount - 1; k++) {
      const m = mags[o + k];
      if (m <= floor || m <= mags[o + k - 1] || m < mags[o + k + 1]) continue;
      const a = Math.log(mags[o + k - 1] + 1e-9);
      const b = Math.log(m + 1e-9);
      const c = Math.log(mags[o + k + 1] + 1e-9);
      const denom = a - 2 * b + c;
      const delta = denom < 0 ? (0.5 * (a - c)) / denom : 0;
      const pitch = hzToMidi(((k + delta) * sampleRate) / FRAME_SIZE);
      const dev = pitch - Math.round(pitch);
      hist[Math.min(99, Math.floor((dev + 0.5) * 100))] += m;
    }
  }
  // Circular smoothing so a peak straddling ±50 cents is not split.
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < 100; i++) {
    let s = 0;
    for (let d = -3; d <= 3; d++) s += hist[(i + d + 100) % 100];
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return (best + 0.5) / 100 - 0.5;
}

function semitoneSpectrogram(mags, frameCount, binCount, sampleRate, tuning) {
  const binSemitone = new Int16Array(binCount).fill(-1);
  const binWeight = new Float32Array(binCount);
  for (let k = 1; k < binCount; k++) {
    const pitch = hzToMidi((k * sampleRate) / FRAME_SIZE) - tuning;
    const m = Math.round(pitch);
    if (m < MIDI_LOW || m > MIDI_HIGH) continue;
    binSemitone[k] = m - MIDI_LOW;
    binWeight[k] = Math.cos(Math.PI * (pitch - m)) ** 2;
  }

  const power = new Float32Array(frameCount * SEMITONES);
  const energy = new Float32Array(frameCount);
  for (let t = 0; t < frameCount; t++) {
    const o = t * binCount;
    let e = 0;
    for (let k = 1; k < binCount; k++) {
      const p = mags[o + k] * mags[o + k];
      e += p;
      if (binSemitone[k] >= 0) power[t * SEMITONES + binSemitone[k]] += p * binWeight[k];
    }
    energy[t] = e;
  }
  return { power, energy };
}

// Log compression, temporal median filtering (suppresses drums and transients)
// and spectral whitening across pitch (suppresses timbre / broadband noise).
function enhance(power, frameCount) {
  let max = 0;
  for (const v of power) if (v > max) max = v;
  const scale = max > 0 ? 1e4 / max : 0;
  const log = new Float32Array(power.length);
  for (let i = 0; i < power.length; i++) log[i] = Math.log1p(power[i] * scale);

  const harmonic = medianFilterTime(log, frameCount, SEMITONES, 9);

  const out = new Float32Array(harmonic.length);
  for (let t = 0; t < frameCount; t++) {
    const o = t * SEMITONES;
    for (let s = 0; s < SEMITONES; s++) {
      let sum = 0;
      let n = 0;
      for (let d = -6; d <= 6; d++) {
        const j = s + d;
        if (j < 0 || j >= SEMITONES) continue;
        sum += harmonic[o + j];
        n++;
      }
      out[o + s] = Math.max(0, harmonic[o + s] - sum / n);
    }
  }
  return out;
}

function medianFilterTime(data, frames, bins, width) {
  const out = new Float32Array(data.length);
  const half = width >> 1;
  const buf = new Float32Array(width);
  for (let b = 0; b < bins; b++) {
    for (let t = 0; t < frames; t++) {
      let n = 0;
      for (let j = Math.max(0, t - half); j <= Math.min(frames - 1, t + half); j++) {
        buf[n++] = data[j * bins + b];
      }
      const sorted = buf.subarray(0, n).sort();
      out[t * bins + b] = n % 2 ? sorted[n >> 1] : 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
    }
  }
  return out;
}
