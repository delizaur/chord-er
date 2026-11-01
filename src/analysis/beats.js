import { FFT, hannWindow } from './fft.js';

// Spectral-flux onset strength, one value per hop, normalized to unit variance.
export function onsetEnvelope(samples, sampleRate, frameSize, hop, onProgress = () => {}) {
  const fft = new FFT(frameSize);
  const window = hannWindow(frameSize);
  const binCount = Math.min(frameSize / 2, Math.floor((8000 * frameSize) / sampleRate));
  const frameCount = Math.max(0, Math.floor((samples.length - frameSize) / hop) + 1);
  const flux = new Float32Array(frameCount);
  const frame = new Float64Array(frameSize);
  let prev = new Float64Array(binCount);
  let cur = new Float64Array(binCount);

  for (let t = 0; t < frameCount; t++) {
    const start = t * hop;
    for (let i = 0; i < frameSize; i++) frame[i] = samples[start + i] * window[i];
    fft.magnitudes(frame, cur);
    let sum = 0;
    for (let k = 0; k < binCount; k++) {
      cur[k] = Math.log1p(10 * cur[k]);
      if (t > 0 && cur[k] > prev[k]) sum += cur[k] - prev[k];
    }
    flux[t] = sum;
    [prev, cur] = [cur, prev];
    if (t % 512 === 0) onProgress(t / frameCount);
  }

  // Remove the slowly varying loudness trend (~1 s moving average), keep peaks.
  const half = Math.round(sampleRate / hop / 2);
  const env = new Float32Array(frameCount);
  let acc = 0;
  let lo = 0;
  let hi = -1;
  for (let t = 0; t < frameCount; t++) {
    while (hi < Math.min(frameCount - 1, t + half)) acc += flux[++hi];
    while (lo < t - half) acc -= flux[lo++];
    env[t] = Math.max(0, flux[t] - acc / (hi - lo + 1));
  }

  let sq = 0;
  for (const v of env) sq += v * v;
  const std = Math.sqrt(sq / Math.max(1, frameCount)) || 1;
  for (let t = 0; t < frameCount; t++) env[t] /= std;
  return env;
}

// Beat period (in onset frames) from the autocorrelation of the onset envelope,
// weighted by a log-normal prior centered on 120 BPM.
export function estimateTempo(env, frameRate) {
  const n = env.length;
  const minLag = Math.max(1, Math.floor((frameRate * 60) / 220));
  const maxLag = Math.min(n - 1, Math.ceil((frameRate * 60) / 40));
  if (maxLag <= minLag) return (frameRate * 60) / 120;

  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;

  const score = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let ac = 0;
    for (let i = 0; i + lag < n; i++) ac += (env[i] - mean) * (env[i + lag] - mean);
    ac /= n - lag;
    const bpm = (frameRate * 60) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    score[lag] = Math.max(0, ac) * prior;
  }

  let best = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if (score[lag] > score[best]) best = lag;

  // Parabolic interpolation for a fractional period.
  const a = score[best - 1] ?? 0;
  const b = score[best];
  const c = score[best + 1] ?? 0;
  const denom = a - 2 * b + c;
  const offset = denom < 0 ? (0.5 * (a - c)) / denom : 0;
  return best + Math.max(-0.5, Math.min(0.5, offset));
}

// Dynamic-programming beat tracker (Ellis 2007). Returns beat positions in onset frames.
export function trackBeats(env, period, tightness = 100) {
  const n = env.length;
  if (n === 0) return [];

  // Smooth the onset envelope with a narrow Gaussian so near-misses still score.
  const radius = Math.round(period);
  const local = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let d = -radius; d <= radius; d++) {
      const i = t + d;
      if (i < 0 || i >= n) continue;
      s += env[i] * Math.exp(-0.5 * ((d * 32) / period) ** 2);
    }
    local[t] = s;
  }

  const cumulative = new Float64Array(n);
  const backlink = new Int32Array(n).fill(-1);
  const minPrev = Math.max(1, Math.round(period / 2));
  const maxPrev = Math.round(2 * period);
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let bestPrev = -1;
    for (let prev = Math.max(0, t - maxPrev); prev <= t - minPrev; prev++) {
      const dev = Math.log((t - prev) / period);
      const s = cumulative[prev] - tightness * dev * dev;
      if (s > best) {
        best = s;
        bestPrev = prev;
      }
    }
    if (bestPrev >= 0 && best > 0) {
      cumulative[t] = local[t] + best;
      backlink[t] = bestPrev;
    } else {
      cumulative[t] = local[t];
    }
  }

  // End on the last strong local maximum of the cumulative score.
  const maxima = [];
  for (let t = 1; t < n - 1; t++) {
    if (cumulative[t] >= cumulative[t - 1] && cumulative[t] >= cumulative[t + 1]) maxima.push(t);
  }
  let last = n - 1;
  if (maxima.length) {
    const sorted = maxima.map((t) => cumulative[t]).sort((x, y) => x - y);
    const threshold = 0.5 * sorted[sorted.length >> 1];
    for (let i = maxima.length - 1; i >= 0; i--) {
      if (cumulative[maxima[i]] > threshold) {
        last = maxima[i];
        break;
      }
    }
  }

  const beats = [];
  for (let t = last; t >= 0; t = backlink[t]) beats.push(t);
  return beats.reverse();
}

// Extends a beat list with the detected period so it spans the whole song.
export function completeBeatGrid(beats, period, duration) {
  const grid = beats.filter((t) => t >= 0 && t < duration);
  if (grid.length === 0) grid.push(0);
  while (grid[0] - period >= 0) grid.unshift(grid[0] - period);
  while (grid[grid.length - 1] + period < duration) grid.push(grid[grid.length - 1] + period);
  return grid;
}
