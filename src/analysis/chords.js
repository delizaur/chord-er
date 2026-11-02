// Chord vocabulary, template matching, Viterbi smoothing, key detection and naming.

export const QUALITIES = {
  maj: { suffix: '', intervals: [0, 4, 7], penalty: 0 },
  min: { suffix: 'm', intervals: [0, 3, 7], penalty: 0 },
  7: { suffix: '7', intervals: [0, 4, 7, 10], penalty: 0.03 },
  maj7: { suffix: 'maj7', intervals: [0, 4, 7, 11], penalty: 0.03 },
  m7: { suffix: 'm7', intervals: [0, 3, 7, 10], penalty: 0.03 },
  dim: { suffix: 'dim', intervals: [0, 3, 6], penalty: 0.05 },
  sus4: { suffix: 'sus4', intervals: [0, 5, 7], penalty: 0.05 },
};

export const VOCABULARIES = {
  basic: ['maj', 'min'],
  sevenths: ['maj', 'min', '7', 'maj7', 'm7'],
  full: ['maj', 'min', '7', 'maj7', 'm7', 'dim', 'sus4'],
};

const KAPPA = 10; // emission scale: cosine similarity → log-likelihood
const BASS_WEIGHT = 0.12; // bonus when the bass pitch class matches the root
const QUIET_DB = -40; // beats this far below the loud parts become N.C.
const HARMONICS = [0, 12, 19, 24, 28, 31]; // semitone offsets of partials 1..6
const HARMONIC_DECAY = 0.6;

const mod12 = (x) => ((x % 12) + 12) % 12;

export const beatInBar = (beat, phase, beatsPerBar) =>
  (((beat - phase) % beatsPerBar) + beatsPerBar) % beatsPerBar;

// Template includes the first few harmonics of each chord tone, since the
// observed chroma does too (e.g. the 5th partial of A adds C#).
function chordTemplate(root, intervals) {
  const t = new Float64Array(12);
  for (const iv of intervals) {
    HARMONICS.forEach((h, i) => (t[mod12(root + iv + h)] += HARMONIC_DECAY ** i));
  }
  const norm = Math.hypot(...t);
  return t.map((v) => v / norm);
}

function buildStates(vocabulary) {
  const states = [];
  for (const quality of VOCABULARIES[vocabulary]) {
    const { intervals, penalty } = QUALITIES[quality];
    for (let root = 0; root < 12; root++) {
      states.push({ root, quality, penalty, template: chordTemplate(root, intervals) });
    }
  }
  states.push({ root: -1, quality: 'N' });
  return states;
}

function emissions(analysis, states) {
  const { treble, bass, loudness } = analysis;
  const n = loudness.length;
  const S = states.length;
  const em = new Float64Array(n * S);
  const chroma = new Float64Array(12);
  const bassNorm = new Float64Array(12);

  for (let i = 0; i < n; i++) {
    let norm = 0;
    let bassMax = 0;
    for (let c = 0; c < 12; c++) {
      chroma[c] = treble[i * 12 + c];
      norm += chroma[c] * chroma[c];
      bassMax = Math.max(bassMax, bass[i * 12 + c]);
    }
    norm = Math.sqrt(norm) || 1;
    for (let c = 0; c < 12; c++) {
      chroma[c] /= norm;
      bassNorm[c] = bassMax > 0 ? bass[i * 12 + c] / bassMax : 0;
    }
    const quiet = loudness[i] < QUIET_DB;

    for (let s = 0; s < S; s++) {
      const st = states[s];
      let score;
      if (st.root < 0) {
        score = quiet ? 2 : 0.2;
      } else {
        score = -st.penalty + BASS_WEIGHT * bassNorm[st.root];
        for (let c = 0; c < 12; c++) score += chroma[c] * st.template[c];
      }
      em[i * S + s] = KAPPA * score;
    }
  }
  return em;
}

// Viterbi with a uniform chord-change cost; O(n·S) thanks to the shared max.
function viterbi(em, n, S, changeCost) {
  if (n === 0) return [];
  const back = new Int32Array(n * S);
  let prev = new Float64Array(S);
  let cur = new Float64Array(S);
  for (let s = 0; s < S; s++) prev[s] = em[s];

  for (let i = 1; i < n; i++) {
    let best = 0;
    for (let s = 1; s < S; s++) if (prev[s] > prev[best]) best = s;
    const switchScore = prev[best] - changeCost(i);
    for (let s = 0; s < S; s++) {
      if (prev[s] >= switchScore) {
        cur[s] = prev[s];
        back[i * S + s] = s;
      } else {
        cur[s] = switchScore;
        back[i * S + s] = best;
      }
      cur[s] += em[i * S + s];
    }
    [prev, cur] = [cur, prev];
  }

  let s = 0;
  for (let k = 1; k < S; k++) if (prev[k] > prev[s]) s = k;
  const path = new Int32Array(n);
  for (let i = n - 1; i >= 0; i--) {
    path[i] = s;
    s = back[i * S + s];
  }
  return path;
}

// Bar phase = the beat offset at which chord changes happen most often.
function downbeatPhase(path, beatsPerBar) {
  const counts = new Array(beatsPerBar).fill(0);
  for (let i = 1; i < path.length; i++) if (path[i] !== path[i - 1]) counts[i % beatsPerBar]++;
  return counts.indexOf(Math.max(...counts));
}

export function decodeChords(analysis, { vocabulary, smoothing, beatsPerBar }) {
  const { beats, duration } = analysis;
  const n = beats.length;
  const states = buildStates(vocabulary);
  const S = states.length;
  const em = emissions(analysis, states);
  const cost = 0.3 * smoothing;

  // First pass finds where bars start; second pass prefers changes on downbeats.
  const phase = downbeatPhase(viterbi(em, n, S, () => cost), beatsPerBar);
  const path = viterbi(em, n, S, (i) => {
    const pos = beatInBar(i, phase, beatsPerBar);
    if (pos === 0) return cost * 0.6;
    if (beatsPerBar % 2 === 0 && pos === beatsPerBar / 2) return cost;
    return cost * 1.5;
  });

  const chords = [];
  for (let i = 0; i < n; i++) {
    if (i > 0 && path[i] === path[i - 1]) continue;
    const { root, quality } = states[path[i]];
    if (chords.length) chords[chords.length - 1].end = beats[i];
    chords.push({ start: beats[i], end: duration, startBeat: i, root, quality });
  }
  return { chords, phase };
}

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a, b) {
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / (Math.sqrt(da * db) || 1);
}

// Krumhansl–Schmuckler key estimate over the whole song's chroma.
export function detectKey({ treble, bass, loudness }) {
  const total = new Array(12).fill(0);
  for (let i = 0; i < loudness.length; i++) {
    if (loudness[i] < QUIET_DB) continue;
    let norm = 0;
    for (let c = 0; c < 12; c++) norm += treble[i * 12 + c] + bass[i * 12 + c];
    if (norm <= 0) continue;
    for (let c = 0; c < 12; c++) total[c] += (treble[i * 12 + c] + bass[i * 12 + c]) / norm;
  }
  let best = { tonic: 0, mode: 'major', score: -Infinity };
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = total.map((_, c) => total[mod12(c + tonic)]);
    for (const [mode, profile] of [['major', MAJOR_PROFILE], ['minor', MINOR_PROFILE]]) {
      const score = correlation(rotated, profile);
      if (score > best.score) best = { tonic, mode, score };
    }
  }
  return { tonic: best.tonic, mode: best.mode };
}

export const transposeKey = (key, semitones) => ({ ...key, tonic: mod12(key.tonic + semitones) });
export const transposeRoot = (root, semitones) => (root < 0 ? -1 : mod12(root + semitones));

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const NATURAL_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// Spell notes by the key signature: sharp keys use sharps, flat keys use flats.
export function noteNames(key) {
  const signature = key.mode === 'minor' ? mod12(key.tonic + 3) : key.tonic;
  if (signature === 0) return NATURAL_NAMES;
  return [7, 2, 9, 4, 11, 6].includes(signature) ? SHARP_NAMES : FLAT_NAMES;
}

export function chordLabel(root, quality, key) {
  if (root < 0) return 'N.C.';
  return noteNames(key)[root] + QUALITIES[quality].suffix;
}

export const keyLabel = (key) => `${noteNames(key)[key.tonic]} ${key.mode}`;

// Index of the last element whose value (via `get`) is <= t, or -1.
export function indexAt(list, t, get = (x) => x) {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (get(list[mid]) <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
