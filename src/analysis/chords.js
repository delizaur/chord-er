// Chord vocabulary, template matching, Viterbi smoothing, key detection and naming.

import { barInfo } from './grid.js';

export const QUALITIES = {
  maj: { suffix: '', intervals: [0, 4, 7], penalty: 0 },
  min: { suffix: 'm', intervals: [0, 3, 7], penalty: 0 },
  7: { suffix: '7', intervals: [0, 4, 7, 10], penalty: 0.03 },
  maj7: { suffix: 'maj7', intervals: [0, 4, 7, 11], penalty: 0.03 },
  m7: { suffix: 'm7', intervals: [0, 3, 7, 10], penalty: 0.03 },
  dim: { suffix: 'dim', intervals: [0, 3, 6], penalty: 0.05 },
  sus4: { suffix: 'sus4', intervals: [0, 5, 7], penalty: 0.05 },
  sus2: { suffix: 'sus2', intervals: [0, 2, 7], penalty: 0.05 },
  aug: { suffix: 'aug', intervals: [0, 4, 8], penalty: 0.05 },
  // Power chord (root and fifth, no third): a major or minor chord is relabeled when its third
  // isn't heard, by markPowerChords.
  5: { suffix: '5', intervals: [0, 7] },
  // Only reached by re-spelling slash chords, never detected directly.
  6: { suffix: '6', intervals: [0, 4, 7, 9] },
  m9: { suffix: 'm9', intervals: [0, 3, 7, 10, 14] },
  // Only in Chordino's output.
  m6: { suffix: 'm6', intervals: [0, 3, 7, 9] },
  m7b5: { suffix: 'm7b5', intervals: [0, 3, 6, 10] },
};

const NOTE_LETTERS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const CHORDINO_QUALITIES = { '': 'maj', m: 'min', 7: '7', maj7: 'maj7', m7: 'm7', 6: '6', m6: 'm6', dim: 'dim', aug: 'aug', m7b5: 'm7b5' };

// Parses a Chordino label ("F#m7", "C/E", "Bbmaj7", "N") into { root, quality, bass }, with -1 for
// no chord or no slash bass.
export function parseChordLabel(label) {
  const match = /^([A-G])([#b]?)([^/]*)(?:\/([A-G])([#b]?))?$/.exec(label);
  if (!match) return { root: -1, quality: 'N', bass: -1 };
  const pc = (letter, accidental) => mod12(NOTE_LETTERS[letter] + (accidental === '#' ? 1 : accidental === 'b' ? -1 : 0));
  return {
    root: pc(match[1], match[2]),
    quality: CHORDINO_QUALITIES[match[3]] ?? 'maj',
    bass: match[4] ? pc(match[4], match[5]) : -1,
  };
}

// The familiar chords a slash chord may be re-spelled as, rooted on its bass note. m9 is only
// reachable from a maj7 over its 6th (Dbmaj7/Bb → Bbm9).
const RESPELL_QUALITIES = ['maj', 'min', 'maj7', 'm7', '7', 'dim', 'sus4', 'sus2', '6', 'm9'];

// The chord groups the user can allow on top of major and minor (power chords are relabeled
// triads, see markPowerChords).
const CHORD_GROUPS = { sevenths: ['7', 'maj7', 'm7'], sus: ['sus2', 'sus4'], dim: ['dim'], aug: ['aug'] };

// The qualities the decoder may choose, for `allowed` = { sevenths, sus, dim, aug } (booleans).
export function vocabularyFor(allowed) {
  return ['maj', 'min', ...Object.entries(CHORD_GROUPS).flatMap(([group, qualities]) => (allowed[group] ? qualities : []))];
}

// The closest allowed quality, for chords another detector (Chordino) found: extended chords fall
// back to their triad (sixths count as sevenths here), m7b5 to dim or minor, dim to minor and aug
// to major.
export function allowedQuality(quality, allowed) {
  if (quality === 'N' || vocabularyFor(allowed).includes(quality)) return quality;
  if (quality === '6' || quality === 'm6') return allowed.sevenths ? quality : quality === '6' ? 'maj' : 'min';
  if (quality === 'm7b5') return allowed.sevenths && allowed.dim ? quality : allowed.dim ? 'dim' : 'min';
  return { 7: 'maj', maj7: 'maj', m7: 'min', dim: 'min', aug: 'maj', sus2: 'maj', sus4: 'maj' }[quality] ?? quality;
}

const KAPPA = 10; // emission scale: cosine similarity → log-likelihood
const BASS_WEIGHT = 0.12; // bonus when the bass note is the root (other chord tones: × BASS_TONE)
const BASS_TONE = 0.7;
const QUIET_DB = -40; // beats this far below the loud parts become N.C.
const KEY_BIAS = 0.1; // bonus for chords whose notes all belong to the song's key

const HARMONICS = [0, 12, 19, 24, 28, 31]; // semitone offsets of partials 1..6
const HARMONIC_DECAY = 0.6;

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10, 11]; // natural minor plus the raised 7th (for V)

const mod12 = (x) => ((x % 12) + 12) % 12;

const beatInBar = (beat, phase, beatsPerBar) =>
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

// Chords that fit the key get a small bonus. It only decides when the audio is ambiguous, as
// with power chords (no third), where E minor vs E major is implied by the key, not played.
function buildStates(vocabulary, key, keyBias) {
  const scale = new Set(
    (key.mode === 'minor' ? MINOR_SCALE : MAJOR_SCALE).map((d) => mod12(key.tonic + d)),
  );
  const states = [];
  for (const quality of vocabulary) {
    const { intervals, penalty } = QUALITIES[quality];
    for (let root = 0; root < 12; root++) {
      const inKey = intervals.every((iv) => scale.has(mod12(root + iv)));
      const bonus = inKey ? keyBias : 0;
      states.push({
        root,
        quality,
        penalty: penalty - bonus,
        template: chordTemplate(root, intervals),
        // Root, third and fifth: a 7th only in the bass reads as a slash chord (Am/G, not Am7/G).
        bassTones: intervals.slice(0, 3).map((iv) => mod12(root + iv)),
      });
    }
  }
  states.push({ root: -1, quality: 'N' });
  return states;
}

function emissions(grid, states) {
  const { treble, bassSalience, loudness } = grid;
  const n = loudness.length;
  const S = states.length;
  const em = new Float64Array(n * S);
  const chroma = new Float64Array(12);
  const bassNorm = new Float64Array(12);
  const { peaks } = bassLevels(bassSalience, n);

  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 12; c++) bassNorm[c] = peaks[i] > 0 ? bassSalience[i * 12 + c] / peaks[i] : 0;
    for (let c = 0; c < 12; c++) chroma[c] = treble[i * 12 + c];
    const norm = Math.hypot(...chroma) || 1;
    for (let c = 0; c < 12; c++) chroma[c] /= norm;
    const quiet = loudness[i] < QUIET_DB;

    for (let s = 0; s < S; s++) {
      const st = states[s];
      let score;
      if (st.root < 0) {
        score = quiet ? 2 : 0.2;
      } else {
        // The bass supports a chord when it plays one of its tones, the root most of all.
        let bassSupport = 0;
        for (const tone of st.bassTones) bassSupport = Math.max(bassSupport, bassNorm[tone] * (tone === st.root ? 1 : BASS_TONE));
        score = -st.penalty + BASS_WEIGHT * bassSupport;
        for (let c = 0; c < 12; c++) score += chroma[c] * st.template[c];
      }
      em[i * S + s] = KAPPA * score;
    }
  }
  return em;
}

// Per-beat peak bass salience, and the song's typical level (90th percentile) to judge whether a
// beat has a clear bass note.
function bassLevels(salience, n) {
  const peaks = Array.from({ length: n }, (_, i) => Math.max(...salience.subarray(i * 12, i * 12 + 12)));
  const reference = [...peaks].sort((a, b) => a - b)[Math.floor(0.9 * (n - 1))] || 1;
  return { peaks, reference };
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

// `grid` holds the beats, beat-synchronous chroma and, when the beat tracker found them, the
// downbeats. Returns the chord segments and the bars (see barInfo). A grid with `uniform` set is
// a plain time grid (see timeSlots): chords may change on any slot at the same cost, and it
// has no bars.
// `vocabulary` lists the allowed qualities (see vocabularyFor).
export function decodeChords(grid, key, { vocabulary, smoothing, beatsPerBar, keyBias = KEY_BIAS }) {
  const { beats, duration } = grid;
  const n = beats.length;
  const states = buildStates(vocabulary, key, keyBias);
  const S = states.length;
  const em = emissions(grid, states);
  const cost = 0.3 * smoothing;

  if (grid.uniform) {
    const path = viterbi(em, n, S, () => cost * FREE_CHANGE_SCALE);
    return { chords: segments(path, states, beats, duration), bars: null };
  }

  // Without tracked downbeats, a first pass finds where bars start: where chords change most.
  let downbeats = grid.downbeats;
  if (!downbeats) {
    const phase = downbeatPhase(viterbi(em, n, S, () => cost), beatsPerBar);
    downbeats = Uint8Array.from(beats, (_, i) => beatInBar(i, phase, beatsPerBar) === 0);
  }
  const bars = barInfo(downbeats);
  // Chord changes are cheapest on downbeats and dearest off the main beats of the bar.
  const path = viterbi(em, n, S, (i) => {
    const pos = bars.pos[i];
    const length = bars.length[i];
    if (pos === 0) return cost * 0.6;
    if (length % 2 === 0 && pos === length / 2) return cost;
    return cost * 1.5;
  });

  return { chords: segments(path, states, beats, duration), bars };
}

// Runs of equal states → chord segments with start/end times and the index of the first beat.
function segments(path, states, beats, duration) {
  const chords = [];
  for (let i = 0; i < path.length; i++) {
    if (i > 0 && path[i] === path[i - 1]) continue;
    const { root, quality } = states[path[i]];
    if (chords.length) chords[chords.length - 1].end = beats[i];
    chords.push({ start: beats[i], end: duration, startBeat: i, root, quality });
  }
  return chords;
}

// A power chord's strongest third (minor or major) stays below this share of its root and fifth
// level (log-compressed chroma), so the third is truly missing, not just quieter.
const POWER_THIRD = 0.2;

// Relabels major and minor chords whose third isn't heard as power chords (E5), instead of leaving
// the key bias to guess. Judged over each whole chord, from its beats' average chroma: a power
// chord when neither third reaches POWER_THIRD and root + fifth fit it at least as well as the
// decoded triad does (both templates include harmonics).
export function markPowerChords(chords, grid) {
  const { treble } = grid;
  const n = grid.beats.length;
  return chords.map((chord, k) => {
    if (chord.quality !== 'maj' && chord.quality !== 'min') return chord;
    const end = k + 1 < chords.length ? chords[k + 1].startBeat : n;
    const mean = new Float64Array(12);
    for (let i = chord.startBeat; i < end; i++) {
      const frame = treble.subarray(i * 12, i * 12 + 12);
      const norm = Math.hypot(...frame) || 1;
      for (let c = 0; c < 12; c++) mean[c] += frame[c] / norm;
    }
    const fit = (intervals) => chordTemplate(chord.root, intervals).reduce((sum, v, c) => sum + v * mean[c], 0);
    const at = (iv) => mean[mod12(chord.root + iv)];
    const third = Math.max(at(3), at(4)) / ((at(0) + at(7)) / 2 || 1);
    const power = third < POWER_THIRD && fit(QUALITIES[5].intervals) >= fit(QUALITIES[chord.quality].intervals);
    return power ? { ...chord, quality: '5' } : chord;
  });
}

const BASS_KAPPA = 6; // emission scale for bass notes
const BASS_PRESENT = 0.2; // a beat's bass counts above this share of the song's typical bass level
// Time slots (free timing) are shorter than beats; changes cost this much more on them, for about
// the same smoothing per second.
const FREE_CHANGE_SCALE = 2.5;
const MIN_PIECE = 0.4; // seconds; shorter free-timing pieces join a neighbour

// Bass pitch class per beat, or -1 where no clear bass sounds, from the beats' bass-note salience.
// Smoothed with its own Viterbi pass: a bass may move under a held chord, but a single unclear
// beat shouldn't flip it. A change costs as much as a chord change at the same `smoothing`.
export function decodeBassLine(grid, smoothing) {
  const { bassSalience: salience, beats } = grid;
  const n = beats.length;
  const S = 13; // 12 pitch classes + "no clear bass"
  const { peaks, reference } = bassLevels(salience, n);
  const em = new Float64Array(n * S);
  for (let i = 0; i < n; i++) {
    const peak = peaks[i] || 1;
    for (let c = 0; c < 12; c++) em[i * S + c] = (BASS_KAPPA * salience[i * 12 + c]) / peak;
    em[i * S + 12] = peaks[i] < BASS_PRESENT * reference ? 2 * BASS_KAPPA : 0.6 * BASS_KAPPA;
  }
  const change = 0.3 * smoothing * (grid.uniform ? FREE_CHANGE_SCALE : 1);
  return Array.from(viterbi(em, n, S, () => change), (s) => (s === 12 ? -1 : s));
}

// Splits chord segments where the bass note changes and gives each piece its `bass` (-1 when it is
// the root or unclear, so no slash is shown). Neighbouring pieces with the same bass stay merged.
export function splitByBass(chords, bassLine, beats) {
  const out = [];
  chords.forEach((chord, k) => {
    const endBeat = k + 1 < chords.length ? chords[k + 1].startBeat : beats.length;
    const bassAt = (i) => (chord.root < 0 || bassLine[i] === chord.root ? -1 : bassLine[i]);
    let runStart = chord.startBeat;
    for (let i = chord.startBeat + 1; i <= endBeat; i++) {
      if (i < endBeat && bassAt(i) === bassAt(runStart)) continue;
      out.push({
        ...chord,
        start: beats[runStart],
        end: i < endBeat ? beats[i] : chord.end,
        startBeat: runStart,
        bass: bassAt(runStart),
      });
      runStart = i;
    }
  });
  return out;
}

// Moves each change of a free-timing (time-slot) chart to the frame within ±`window` seconds that
// best separates the two sides: by chord template match on the frame chroma, or for a change of
// bass note under the same chord, by bass salience. `frames` and `bassFrames` are frame-level
// analyses (computeChroma).
export function refineChanges(chords, frames, bassFrames, window = 0.3) {
  const chordScore = (c, f) => {
    if (c.root < 0) return 0.2;
    const template = chordTemplate(c.root, QUALITIES[c.quality].intervals);
    let dot = 0;
    let norm = 0;
    for (let k = 0; k < 12; k++) {
      dot += frames.treble[f * 12 + k] * template[k];
      norm += frames.treble[f * 12 + k] ** 2;
    }
    return dot / (Math.sqrt(norm) || 1);
  };
  const bassScore = (pc, f) => {
    const v = bassFrames.bassSalience.subarray(f * 12, f * 12 + 12);
    return pc < 0 ? 0 : v[pc] / (Math.max(...v) || 1);
  };
  const out = chords.map((c) => ({ ...c }));
  for (let k = 1; k < out.length; k++) {
    const [a, b] = [out[k - 1], out[k]];
    const sameChord = a.root === b.root && a.quality === b.quality;
    const score = sameChord
      ? (c, f, times) => bassScore(c.bass >= 0 ? c.bass : c.root, Math.min(f, times.length - 1))
      : (c, f) => chordScore(c, f);
    const times = sameChord ? bassFrames.frameTimes : frames.frameTimes;
    const lo = Math.max(a.start + 0.05, b.start - window);
    const hi = Math.min(b.end - 0.05, b.start + window);
    const from = indexAt(times, lo) + 1;
    const to = indexAt(times, hi);
    if (to <= from) continue;
    // Best split: frames before it scored as `a`, from it on as `b`.
    let best = -Infinity;
    let split = b.start;
    let left = 0;
    let right = 0;
    for (let f = from; f <= to; f++) right += score(b, f, times);
    for (let f = from; f <= to; f++) {
      if (left + right > best) {
        best = left + right;
        split = times[f];
      }
      left += score(a, f, times);
      right -= score(b, f, times);
    }
    a.end = b.start = split;
  }
  return absorbShort(out, MIN_PIECE);
}

// Joins pieces shorter than `min` seconds to a neighbour, shortest first: to one with the same
// chord when there is one (a passing bass note), otherwise to the longer neighbour.
function absorbShort(pieces, min) {
  const out = pieces.map((p) => ({ ...p }));
  for (;;) {
    let k = -1;
    for (let i = 0; i < out.length; i++) {
      const d = out[i].end - out[i].start;
      if (d < min && (k < 0 || d < out[k].end - out[k].start)) k = i;
    }
    if (k < 0 || out.length < 2) return out;
    const p = out[k];
    const prev = out[k - 1];
    const next = out[k + 1];
    const same = (q) => q && q.root === p.root && q.quality === p.quality;
    const length = (q) => (q ? q.end - q.start : -1);
    const intoPrev = same(prev) || (!same(next) && length(prev) >= length(next));
    if (intoPrev) prev.end = p.end;
    else Object.assign(next, { start: p.start, startBeat: p.startBeat });
    out.splice(k, 1);
  }
}

// Chord changes the bass plays ahead of the harmony: a short slash piece (up to 2 beats) right
// before a different chord, whose bass is that chord's root (Bb/D → Dm), is where the bass already
// moved to the next chord, often a syncopated change ahead of the downbeat that the smoothed
// harmony picks up late. The next chord starts there instead. `beatLength` is the typical beat
// length in seconds.
export function anticipateChanges(pieces, beatLength) {
  const limit = 2 * beatLength * 1.1; // beats vary a little in length
  const out = [];
  let carried = null; // start of a dropped slash piece, taken over by the next chord
  pieces.forEach((piece, k) => {
    const p = carried ? { ...piece, ...carried } : piece;
    const next = pieces[k + 1];
    carried =
      next &&
      p.bass >= 0 &&
      p.bass === next.root &&
      (next.bass < 0 || next.bass === next.root) &&
      (next.root !== p.root || next.quality !== p.quality) &&
      p.end - p.start <= limit
        ? { start: p.start, startBeat: p.startBeat }
        : null;
    if (!carried) out.push(p);
  });
  return out;
}

// Chord qualities a slash chord may be rebuilt as, rooted on its bass note. (sus4 is left out:
// melody notes a fourth above the bass made it win too easily.)
const REBUILD_QUALITIES = ['maj', 'min', '7', 'maj7', 'm7'];
const REBUILD_MARGIN = 0.03; // how much worse than the slash chord the rebuilt chord may fit
const REBUILD_PRESENT = 0.3; // each of its notes reaches this share of the loudest note
const REBUILD_DROPPED = 0.5; // notes of the slash chord it leaves out stay below this share

const scaleOf = (key) => new Set((key.mode === 'minor' ? MINOR_SCALE : MAJOR_SCALE).map((d) => mod12(key.tonic + d)));

// Experimental: re-reads each remaining slash chord X/Y as a chord rooted on its bass Y that fits
// the key (Bm7/F# in B minor → F#m7), counting quieter notes the decoder passed over. Judged
// from the piece's average chroma: the rebuilt chord, with its bass on the root, must fit nearly
// as well as X/Y (both scored like the decoder: template fit plus the bass bonus), all its notes
// must actually sound, and the notes of X it drops must be quiet. Otherwise X/Y stays.
export function rebuildOnBass(pieces, grid, key) {
  const scale = scaleOf(key);
  const { treble, beats } = grid;
  return pieces.map((p) => {
    if (p.root < 0 || p.bass < 0) return p;
    const i0 = Math.max(0, indexAt(beats, p.start + 1e-3));
    const i1 = Math.max(i0 + 1, indexAt(beats, p.end - 1e-3) + 1);
    const mean = new Float64Array(12);
    for (let i = i0; i < i1; i++) {
      const frame = treble.subarray(i * 12, i * 12 + 12);
      const norm = Math.hypot(...frame) || 1;
      for (let c = 0; c < 12; c++) mean[c] += frame[c] / norm;
    }
    const norm = Math.hypot(...mean) || 1;
    const loudest = Math.max(...mean) || 1;
    const level = (pc) => mean[pc] / loudest;
    const fit = (root, intervals) => chordTemplate(root, intervals).reduce((sum, v, c) => sum + (v * mean[c]) / norm, 0);
    const own = QUALITIES[p.quality].intervals.map((iv) => mod12(p.root + iv));
    const bassInTriad = own.slice(0, 3).includes(p.bass);
    const current = fit(p.root, QUALITIES[p.quality].intervals) + (bassInTriad ? BASS_WEIGHT * BASS_TONE : 0);

    let best = null;
    for (const quality of REBUILD_QUALITIES) {
      const { intervals } = QUALITIES[quality];
      const tones = intervals.map((iv) => mod12(p.bass + iv));
      if (!tones.every((pc) => scale.has(pc))) continue;
      if (tones.slice(1).some((pc) => level(pc) < REBUILD_PRESENT)) continue;
      if (own.some((pc) => !tones.includes(pc) && level(pc) >= REBUILD_DROPPED)) continue;
      const score = fit(p.bass, intervals) + BASS_WEIGHT;
      if (score >= current - REBUILD_MARGIN && (!best || score > best.score)) best = { quality, score };
    }
    return best ? { ...p, root: p.bass, quality: best.quality, bass: -1 } : p;
  });
}

// Merges runs of neighbouring chords that share root and bass but differ in quality (Bm, Bm7;
// Bm/F#, Bm7/F#) into one chord, with the run's quality that best fits the notes heard over the
// whole run: its average chroma (`frames`: { frameTimes, treble }) against each quality's template.
export function mergeSimilar(pieces, frames) {
  const same = (a, b) => a.root >= 0 && a.root === b.root && a.bass === b.bass;
  const out = [];
  for (let i = 0; i < pieces.length; ) {
    let j = i + 1;
    while (j < pieces.length && same(pieces[i], pieces[j])) j++;
    const run = pieces.slice(i, j);
    const qualities = [...new Set(run.map((p) => p.quality))];
    let quality = qualities[0];
    if (qualities.length > 1) {
      const { frameTimes, treble } = frames;
      const mean = new Float64Array(12);
      for (let f = Math.max(0, indexAt(frameTimes, run[0].start)); f < frameTimes.length && frameTimes[f] < run[run.length - 1].end; f++) {
        for (let c = 0; c < 12; c++) mean[c] += treble[f * 12 + c];
      }
      const fit = (q) => chordTemplate(run[0].root, QUALITIES[q].intervals).reduce((sum, v, c) => sum + v * mean[c], 0);
      quality = qualities.reduce((best, q) => (fit(q) > fit(best) ? q : best));
    }
    out.push({ ...run[0], quality, end: run[run.length - 1].end });
    i = j;
  }
  return out;
}

// Puts chords found with their own timing (Chordino's) on the beat grid: each beat gets the chord
// that covers most of it, and neighbouring beats with the same chord (and bass) join.
export function snapToBeats(pieces, beats, duration) {
  const edges = [...(beats[0] > 0 ? [0] : []), ...beats, duration].filter((t, i, all) => t <= duration && (i === 0 || t > all[i - 1]));
  const out = [];
  let k = 0;
  for (let i = 0; i + 1 < edges.length; i++) {
    const [from, to] = [edges[i], edges[i + 1]];
    while (k + 1 < pieces.length && pieces[k].end <= from) k++;
    let best = null;
    let bestOverlap = 0;
    for (let j = k; j < pieces.length && pieces[j].start < to; j++) {
      const overlap = Math.min(to, pieces[j].end) - Math.max(from, pieces[j].start);
      if (overlap > bestOverlap) [best, bestOverlap] = [pieces[j], overlap];
    }
    if (!best) continue;
    const last = out[out.length - 1];
    if (last && last.root === best.root && last.quality === best.quality && last.bass === best.bass) last.end = to;
    else out.push({ ...best, start: from, end: to, startBeat: i });
  }
  return out;
}

// With more smoothing, short slash chords are left out: above 5, slash pieces up to
// (smoothing − 5) / 2.5 beats long (1 beat at 7.5, 2 at 10) lose their slash and join the same
// chord around them. `beatLength` is the typical beat length in seconds.
export function dropShortSlashes(pieces, smoothing, beatLength) {
  const minBeats = (smoothing - 5) / 2.5;
  if (minBeats <= 0) return pieces;
  const limit = minBeats * beatLength * 1.1; // beats vary a little in length
  const out = [];
  for (const piece of pieces) {
    const p = piece.bass >= 0 && piece.end - piece.start <= limit ? { ...piece, bass: -1 } : piece;
    const last = out[out.length - 1];
    if (last && last.root === p.root && last.quality === p.quality && last.bass === p.bass) last.end = p.end;
    else out.push({ ...p });
  }
  return out;
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

// "C", "Am7", or with a bass note other than the root, slash notation: "C/E".
// Re-spells a slash chord as the chord rooted on its bass note when its notes plus the bass form
// exactly one of RESPELL_QUALITIES: F#sus4/B → Bsus2, C/A → Am7, Dbmaj7/Bb → Bbm9. Others, such as C/B
// or C/E, stay as they are.
export function respellSlash(chord) {
  if (chord.root < 0 || chord.bass < 0) return chord;
  const notes = new Set(QUALITIES[chord.quality].intervals.map((iv) => mod12(chord.root + iv)));
  notes.add(chord.bass);
  for (const quality of RESPELL_QUALITIES) {
    const { intervals } = QUALITIES[quality];
    if (intervals.length === notes.size && intervals.every((iv) => notes.has(mod12(chord.bass + iv)))) {
      return { ...chord, root: chord.bass, quality, bass: -1 };
    }
  }
  return chord;
}

export function chordLabel(root, quality, key, bass = -1) {
  if (root < 0) return 'N.C.';
  const names = noteNames(key);
  const label = names[root] + QUALITIES[quality].suffix;
  return bass >= 0 && bass !== root ? `${label}/${names[bass]}` : label;
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
