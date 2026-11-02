// Probabilistic beat and bar inference on Beat This! activations.
//
// trackBeats ports madmom's DBNBeatTrackingProcessor (Krebs, Böck & Widmer 2015): a hidden Markov
// model whose states are (beat interval, position within the beat). The tempo may only change at a
// beat, and large changes are unlikely, so the beats follow gradual tempo drift but don't jump
// between half and double time where the network is unsure.
//
// trackBars then groups the beats into bars of 3 or 4 beats with a small HMM over the downbeat
// activations, so a stray downbeat doesn't make a one-beat bar.

const MIN_BPM = 55;
const MAX_BPM = 215;
const TRANSITION_LAMBDA = 100; // higher = steadier tempo
const OBSERVATION_LAMBDA = 16; // the first 1/16 of each beat interval counts as "beat"

export function trackBeats(activations, fps) {
  const n = activations.length;
  if (n === 0) return [];
  const minInterval = Math.round((60 * fps) / MAX_BPM);
  const maxInterval = Math.round((60 * fps) / MIN_BPM);
  const intervals = [];
  for (let i = minInterval; i <= maxInterval; i++) intervals.push(i);
  const I = intervals.length;

  // State s = first[k] + position, for interval k.
  const first = [];
  let S = 0;
  for (const iv of intervals) {
    first.push(S);
    S += iv;
  }
  const stateInterval = new Int32Array(S);
  const isBeat = new Uint8Array(S);
  intervals.forEach((iv, k) => {
    for (let p = 0; p < iv; p++) {
      stateInterval[first[k] + p] = k;
      isBeat[first[k] + p] = p < iv / OBSERVATION_LAMBDA ? 1 : 0;
    }
  });

  // Tempo transitions from the last state of interval i to the first state of interval j.
  const logTrans = new Float64Array(I * I);
  for (let i = 0; i < I; i++) {
    let sum = 0;
    for (let j = 0; j < I; j++) {
      const p = Math.exp(-TRANSITION_LAMBDA * Math.abs(intervals[j] / intervals[i] - 1));
      logTrans[i * I + j] = p;
      sum += p;
    }
    for (let j = 0; j < I; j++) {
      const p = logTrans[i * I + j] / sum;
      logTrans[i * I + j] = p > Number.EPSILON ? Math.log(p) : -Infinity;
    }
  }

  const eps = 1e-7;
  let prev = new Float64Array(S).fill(-Math.log(S));
  let cur = new Float64Array(S);
  // Back pointers are only needed at first states (the others always come from s - 1).
  const back = new Int16Array(n * I);
  const obs = (s, a) => (isBeat[s] ? Math.log(a + eps) : Math.log((1 - a) / (OBSERVATION_LAMBDA - 1) + eps));

  for (let t = 0; t < n; t++) {
    const a = activations[t];
    if (t === 0) {
      for (let s = 0; s < S; s++) prev[s] += obs(s, a);
      continue;
    }
    for (let j = 0; j < I; j++) {
      // Entering interval j at position 0: from the last state of any interval i.
      let best = -Infinity;
      let arg = 0;
      for (let i = 0; i < I; i++) {
        const v = prev[first[i] + intervals[i] - 1] + logTrans[i * I + j];
        if (v > best) {
          best = v;
          arg = i;
        }
      }
      cur[first[j]] = best + obs(first[j], a);
      back[t * I + j] = arg;
      for (let p = 1; p < intervals[j]; p++) cur[first[j] + p] = prev[first[j] + p - 1] + obs(first[j] + p, a);
    }
    [prev, cur] = [cur, prev];
  }

  // Backtrack.
  let s = 0;
  for (let k = 1; k < S; k++) if (prev[k] > prev[s]) s = k;
  const path = new Int32Array(n);
  for (let t = n - 1; t >= 0; t--) {
    path[t] = s;
    const k = stateInterval[s];
    const pos = s - first[k];
    if (t > 0) s = pos > 0 ? s - 1 : (() => {
      const i = back[t * I + k];
      return first[i] + intervals[i] - 1;
    })();
  }

  // Like madmom's correct=True: one beat per run of "beat" states, at the activation peak.
  const beats = [];
  let start = -1;
  for (let t = 0; t <= n; t++) {
    const inBeat = t < n && isBeat[path[t]];
    if (inBeat && start < 0) start = t;
    if (!inBeat && start >= 0) {
      let peak = start;
      for (let u = start; u < t; u++) if (activations[u] > activations[peak]) peak = u;
      beats.push(peak);
      start = -1;
    }
  }
  return beats;
}

const METERS = [3, 4];
const METER_CHANGE = Math.log(0.01); // per bar

// Downbeat flags for `beatFrames`, from downbeat probabilities per frame. Each beat takes the
// strongest downbeat activation within ±2 frames.
export function trackBars(beatFrames, downbeatActivations) {
  const n = beatFrames.length;
  if (n === 0) return new Uint8Array(0);
  const q = beatFrames.map((f) => {
    let m = 0;
    for (let k = Math.max(0, f - 2); k <= Math.min(downbeatActivations.length - 1, f + 2); k++) {
      m = Math.max(m, downbeatActivations[k]);
    }
    return Math.min(1 - 1e-6, Math.max(1e-6, m));
  });

  // States (meter, position in bar).
  const states = METERS.flatMap((m) => Array.from({ length: m }, (_, p) => ({ m, p })));
  const S = states.length;
  const score = new Float64Array(S);
  const back = new Int16Array(n * S);
  const emit = (st, i) => Math.log(st.p === 0 ? q[i] : 1 - q[i]);
  states.forEach((st, s) => (score[s] = emit(st, 0)));
  for (let i = 1; i < n; i++) {
    const next = new Float64Array(S).fill(-Infinity);
    states.forEach((st, s) => {
      const candidates = [];
      if (st.p > 0) {
        candidates.push([states.findIndex((o) => o.m === st.m && o.p === st.p - 1), 0]);
      } else {
        // A bar starts after the last beat of a bar of either meter.
        for (const m of METERS) candidates.push([states.findIndex((o) => o.m === m && o.p === m - 1), m === st.m ? 0 : METER_CHANGE]);
      }
      for (const [from, cost] of candidates) {
        const v = score[from] + cost;
        if (v > next[s]) {
          next[s] = v;
          back[i * S + s] = from;
        }
      }
      next[s] += emit(st, i);
    });
    score.set(next);
  }
  let s = 0;
  for (let k = 1; k < S; k++) if (score[k] > score[s]) s = k;
  const flags = new Uint8Array(n);
  for (let i = n - 1; i >= 0; i--) {
    flags[i] = states[s].p === 0 ? 1 : 0;
    if (i > 0) s = back[i * S + s];
  }
  return flags;
}
