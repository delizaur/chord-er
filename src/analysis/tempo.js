// Beat-grid detection, ported from the drumcoach project (js/tempo.js and js/beatsync.js).
// Times are in milliseconds throughout; the onset curves have one value per millisecond.
//
// 1. Drum onsets: a low band (kicks) and a high band (snares, hats, cymbals), each turned into
//    an onset curve from the rise in log energy.
// 2. Coarse tempo candidates: peaks of the onset curve's autocorrelation (averaged over 20 s
//    windows), scored over the first four multiples of each lag, preferring tempos near 130 BPM.
// 3. For each candidate, a fine search of period and phase on a smoothed onset curve, a robust
//    straight-line fit through the clear onsets nearest to each predicted beat, and a final
//    fine-tune on a sharper curve.
// 4. Beat tracking: the beat's shift from the straight grid is followed in chunks of 16 beats,
//    so recordings that speed up or slow down stay on the beat.

// RBJ biquad, with Q given in dB like Web Audio's BiquadFilterNode (default 1 dB).
function biquad(x, sampleRate, type, freq, qDb = 1) {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * 10 ** (qDb / 20));
  const a0 = 1 + alpha;
  const b0 = (type === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2) / a0;
  const b1 = (type === 'lowpass' ? 1 - cos : -(1 + cos)) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

// Onset strength per millisecond: rise in log energy over a 4 ms window, normalized to mean 1.
function onsetCurve(x, sampleRate) {
  const W = 4;
  const n = Math.floor((x.length * 1000) / sampleRate);
  const sampleAt = (ms) => Math.round((ms * sampleRate) / 1000);
  const energy = new Float32Array(n);
  for (let i = W; i < n; i++) {
    const a = sampleAt(i - W);
    const b = sampleAt(i);
    let s = 0;
    for (let j = a; j < b; j++) s += x[j] * x[j];
    energy[i] = Math.log(1e-10 + s / (b - a));
  }
  const curve = new Float32Array(n);
  let mean = 0;
  for (let i = 3; i < n - 3; i++) {
    curve[i] = Math.max(0, energy[i + 2] - energy[i - 2]);
    mean += curve[i];
  }
  mean /= n;
  if (mean > 0) for (let i = 0; i < n; i++) curve[i] /= mean;
  return curve;
}

// Combined kick + snare/cymbal onset curve, one value per millisecond.
function drumOnsets(samples, sampleRate) {
  const low = onsetCurve(biquad(samples, sampleRate, 'lowpass', 150), sampleRate);
  const high = onsetCurve(biquad(samples, sampleRate, 'highpass', 2500), sampleRate);
  return low.map((v, i) => v + high[i]);
}

function smooth(x, sigma) {
  const r = Math.ceil(sigma * 3);
  const k = [];
  let ks = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-0.5 * (i / sigma) ** 2);
    k.push(v);
    ks += v;
  }
  const out = new Float32Array(x.length);
  for (let i = r; i < x.length - r; i++) {
    let s = 0;
    for (let j = -r; j <= r; j++) s += x[i + j] * k[j + r];
    out[i] = s / ks;
  }
  return out;
}

const at = (x, t) => {
  const i = Math.floor(t);
  const a = t - i;
  return (x[i] || 0) * (1 - a) + (x[i + 1] || 0) * a;
};

// Mean curve value on the grid phase + k·period within [from, to).
function comb(x, period, phase, from, to) {
  let s = 0;
  let c = 0;
  for (let t = from + phase; t < to; t += period) {
    s += at(x, t);
    c++;
  }
  return s / (c || 1);
}

function linfit(pts) {
  const n = pts.length;
  let sk = 0;
  let st = 0;
  let skk = 0;
  let skt = 0;
  for (const [k, t] of pts) {
    sk += k;
    st += t;
    skk += k * k;
    skt += k * t;
  }
  const b = (n * skt - sk * st) / (n * skk - sk * sk);
  return { a: (st - b * sk) / n, b };
}

const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1] || 0;
};

const ACF_WINDOW = 20000; // ms

function coarseCandidates(env, from, to, count) {
  const D = 4;
  const i0 = Math.floor(from / D);
  const n = Math.floor(to / D) - i0;
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < D; j++) s += env[(i0 + i) * D + j];
    e[i] = s;
  }
  // Autocorrelation in overlapping windows, each normalized by its own energy, so every part
  // of the song counts the same.
  const W = Math.min(n, ACF_WINDOW / D);
  const wins = [];
  for (let a = 0; a + W <= n; a += W / 2) {
    let mean = 0;
    let energy = 0;
    for (let i = a; i < a + W; i++) mean += e[i];
    mean /= W;
    for (let i = a; i < a + W; i++) energy += (e[i] - mean) ** 2;
    if (energy > 0) wins.push({ a, mean, energy });
  }
  const cache = new Map();
  const acf = (lag) => {
    if (cache.has(lag)) return cache.get(lag);
    let total = 0;
    for (const { a, mean, energy } of wins) {
      let s = 0;
      for (let i = a + lag; i < a + W; i++) s += (e[i] - mean) * (e[i - lag] - mean);
      total += s / energy;
    }
    cache.set(lag, total);
    return total;
  };
  const lo = Math.floor(240 / D);
  const hi = Math.ceil(1000 / D); // 60–250 BPM
  const score = {};
  for (let lag = lo; lag <= hi; lag++) {
    const bpm = 60000 / (lag * D);
    let s = 0;
    for (let m = 1; m <= 4; m++) s += acf(m * lag);
    score[lag] = s * Math.exp(-0.5 * (Math.log2(bpm / 130) / 1.1) ** 2);
  }
  const peaks = [];
  for (let lag = lo + 1; lag < hi; lag++) {
    if (score[lag] >= score[lag - 1] && score[lag] >= score[lag + 1]) peaks.push(lag);
  }
  peaks.sort((a, b) => score[b] - score[a]);
  const out = [];
  for (const lag of peaks) {
    if (out.every((o) => Math.abs(o / lag - 1) > 0.05)) out.push(lag);
    if (out.length === count) break;
  }
  return out.map((l) => l * D);
}

function refine(env, soft, sharp, P0, from, to) {
  // Fine search of period (±1.5 %) and phase on the smoothed curve.
  let P = P0;
  let phi = 0;
  let best = -1;
  for (let p = P0 * 0.985; p <= P0 * 1.015; p += P0 * 0.0005) {
    for (let f = 0; f < p; f += 4) {
      const v = comb(soft, p, f, from, to);
      if (v > best) {
        best = v;
        P = p;
        phi = f;
      }
    }
  }
  const Pc = P;
  const fc = phi;
  best = -1;
  for (let p = Pc - P0 * 0.0006; p <= Pc + P0 * 0.0006; p += 0.002) {
    for (let f = fc - 6; f <= fc + 6; f += 0.5) {
      const v = comb(soft, p, f, from, to);
      if (v > best) {
        best = v;
        P = p;
        phi = f;
      }
    }
  }
  // Robust line fit through the clear onsets nearest to each predicted beat.
  for (let iter = 0; iter < 3; iter++) {
    const win = Math.min(25, P / 8);
    const pts = [];
    for (let k = 0; from + phi + k * P < to; k++) {
      const t = from + phi + k * P;
      let bi = -1;
      let bv = 3; // clear onsets only: 3× the average strength
      for (let i = Math.round(t - win); i <= Math.round(t + win); i++) {
        if (env[i] > bv) {
          bv = env[i];
          bi = i;
        }
      }
      if (bi >= 0) pts.push([k, bi - from]);
    }
    if (pts.length < 12) break;
    let fit = linfit(pts);
    const res = pts.map(([k, t]) => t - (fit.a + fit.b * k));
    const mad = median(res.map(Math.abs)) * 1.4826 || 1;
    fit = linfit(pts.filter((_, i) => Math.abs(res[i]) <= 2.5 * mad));
    phi = fit.a;
    P = fit.b;
  }
  // Fine-tune directly against the sharp curve.
  const span = P * 0.0002;
  const P1 = P;
  const f1 = phi;
  best = -1;
  for (let p = P1 - span; p <= P1 + span; p += span / 100) {
    for (let f = f1 - 3; f <= f1 + 3; f += 0.25) {
      const v = comb(sharp, p, f, from, to);
      if (v > best) {
        best = v;
        P = p;
        phi = f;
      }
    }
  }
  const phase = (((from + phi) % P) + P) % P; // first beat at or after 0 ms
  return { period: P, phase, bpm: 60000 / P, fit: best };
}

export const TRACK_STEP = 16; // beats per chunk; the beat's shift from the straight tempo is measured on each
const TRACK_RANGE = 100; // ms the shift may reach (at most a sixth of a beat)
const TRACK_STIFF = 0.03; // cost of changing the shift between chunks, per ms² (the fit averages 1)
const TRACK_MIN = 4; // shifts that all stay within this (ms) keep the straight tempo

// Follows a candidate's beat through the song in chunks: times (ms) of beats 0, TRACK_STEP,
// 2·TRACK_STEP, … counted from the beat at `phase`, or [] when the straight tempo already fits.
function track(soft, sharp, period, phase) {
  const n = Math.ceil((soft.length - phase) / period / TRACK_STEP) + 1;
  // Mean curve value on the beats of chunk i (centred on beat i·TRACK_STEP), shifted by d ms.
  const fit = (curve, i, d) => {
    let s = 0;
    for (let k = i * TRACK_STEP - TRACK_STEP / 2; k < (i + 1) * TRACK_STEP - TRACK_STEP / 2; k++) {
      s += at(curve, phase + k * period + d);
    }
    return s / TRACK_STEP;
  };
  const R = Math.round(Math.min(TRACK_RANGE, period / 6));
  const S = 2 * R + 1;
  const score = new Float64Array(S);
  const next = new Float64Array(S);
  const from = [];
  for (let s = 0; s < S; s++) score[s] = fit(soft, 0, s - R);
  for (let i = 1; i < n; i++) {
    const back = new Int16Array(S);
    for (let s = 0; s < S; s++) {
      let best = -Infinity;
      for (let p = 0; p < S; p++) {
        const v = score[p] - TRACK_STIFF * (s - p) ** 2;
        if (v > best) {
          best = v;
          back[s] = p;
        }
      }
      next[s] = best + fit(soft, i, s - R);
    }
    score.set(next);
    from.push(back);
  }
  const shift = new Float64Array(n);
  let s = score.indexOf(Math.max(...score));
  for (let i = n - 1; i >= 0; i--) {
    shift[i] = s - R;
    if (i) s = from[i - 1][s];
  }
  // Finer, on the sharper curve.
  for (let i = 0; i < n; i++) {
    let best = -1;
    let d = shift[i];
    for (let x = shift[i] - 1.5; x <= shift[i] + 1.5; x += 0.25) {
      const v = fit(sharp, i, x);
      if (v > best) {
        best = v;
        d = x;
      }
    }
    if (best > 0) shift[i] = d;
  }
  // Smoothing: median of 3, then mean of 3.
  const med = shift.map((v, i) => median([shift[Math.max(0, i - 1)], v, shift[Math.min(n - 1, i + 1)]]));
  const smooth3 = med.map((v, i) => (med[Math.max(0, i - 1)] + v + med[Math.min(n - 1, i + 1)]) / 3);
  if (smooth3.every((v) => Math.abs(v) <= TRACK_MIN)) return [];
  return [...smooth3].map((d, i) => phase + i * TRACK_STEP * period + d);
}

// Tempo candidates in order of preference: { bpm, period, phase, fit, beats }, where phase is
// the time (ms) of a beat in [0, period) and beats the tracked times of every TRACK_STEP-th beat.
export function detectTempo(samples, sampleRate, count = 3) {
  const env = drumOnsets(samples, sampleRate);
  const from = 1000;
  const to = env.length - 1000;
  if (to - from < 10000) return [];
  const soft = smooth(env, 4);
  const sharp = smooth(env, 1.5);
  const candidates = coarseCandidates(env, from, to, count).map((P0) => refine(env, soft, sharp, P0, from, to));
  // The grid that sits best on the onsets first; a slower grid only lands on the strongest hits,
  // so it tends to fit better: when the best one has a double-tempo partner, the partner goes first.
  candidates.sort((a, b) => b.fit - a.fit);
  const double = candidates.findIndex((c) => Math.abs(candidates[0].period / c.period / 2 - 1) < 0.01);
  if (double > 0) candidates.unshift(...candidates.splice(double, 1));
  for (const c of candidates) c.beats = track(soft, sharp, c.period, c.phase);
  return candidates;
}
