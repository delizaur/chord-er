import { TRACK_STEP } from './tempo.js';

// Beat grid for the chosen tempo source: { beats (s), downbeats (flag per beat, or null when the
// bars have to be inferred) }. `source` is a classic tempo candidate (see detectTempo) or the
// Beat This! result { times, downbeats }. `mult` scales the tempo (2 = double, 0.5 = half);
// `half` shifts the grid by half a beat.
export function buildBeats(source, { mult, half }, duration) {
  if (source?.times) return fromTrackedBeats(source, { mult, half }, duration);
  return { beats: fromTempo(source, { mult, half }, duration), downbeats: null };
}

function fromTempo(candidate, { mult, half }, duration) {
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

function fromTrackedBeats({ times, downbeats }, { mult, half }, duration) {
  let beats = Array.from(times);
  let flags = Array.from(downbeats);
  if (beats.length < 2) return { beats: fromTempo(null, {}, duration), downbeats: null };
  if (mult === 2) {
    const b = [];
    const f = [];
    beats.forEach((t, i) => {
      b.push(t);
      f.push(flags[i]);
      if (i + 1 < beats.length) {
        b.push((t + beats[i + 1]) / 2);
        f.push(0);
      }
    });
    [beats, flags] = [b, f];
  } else if (mult === 0.5) {
    // Keep every other beat, on the side that holds most downbeats.
    const even = flags.filter((d, i) => d && i % 2 === 0).length;
    const odd = flags.filter((d, i) => d && i % 2 === 1).length;
    const parity = even >= odd ? 0 : 1;
    flags = flags.filter((_, i) => i % 2 === parity);
    beats = beats.filter((_, i) => i % 2 === parity);
  }
  if (half) {
    beats = beats.slice(1).map((t, i) => (t + beats[i]) / 2);
    flags = null; // the bars no longer line up with the beats; infer them instead
  }

  // Extend the grid to the start and end of the song with the local beat length, so chords
  // are shown where the tracker found no beats (a quiet intro, a fade-out).
  const span = (a, b) => (beats[b] - beats[a]) / (b - a);
  const k = Math.min(4, beats.length - 1);
  const head = span(0, k);
  const tail = span(beats.length - 1 - k, beats.length - 1);
  while (beats[0] - head >= 0) {
    beats.unshift(beats[0] - head);
    flags?.unshift(0);
  }
  while (beats[beats.length - 1] + tail < duration) {
    beats.push(beats[beats.length - 1] + tail);
    flags?.push(0);
  }
  return { beats: Float64Array.from(beats), downbeats: flags && Uint8Array.from(flags) };
}

// Evenly spaced slot start times, for decoding chords independently of the beats (songs without
// a reliable beat): chord changes then land wherever the harmony changes, to within a slot.
export function timeSlots(duration, slot = 0.2) {
  return Float64Array.from({ length: Math.max(1, Math.ceil(duration / slot)) }, (_, i) => i * slot);
}

// Position of each beat in its bar (0 = downbeat), the bar's length in beats and its number
// (1-based; a pickup before the first downbeat is bar 0 or lower), from downbeat flags.
export function barInfo(flags) {
  const n = flags.length;
  const starts = [];
  for (let i = 0; i < n; i++) if (flags[i]) starts.push(i);
  const pos = new Int16Array(n);
  const length = new Int16Array(n);
  const number = new Int32Array(n);
  if (!starts.length) starts.push(0);

  // The most common bar length fills in before the first and after the last downbeat.
  const counts = {};
  for (let k = 1; k < starts.length; k++) counts[starts[k] - starts[k - 1]] = (counts[starts[k] - starts[k - 1]] || 0) + 1;
  const typical = Number(Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] ?? 4);

  for (let i = 0; i < starts[0]; i++) {
    const d = i - starts[0];
    pos[i] = ((d % typical) + typical) % typical;
    length[i] = typical;
    number[i] = Math.floor(d / typical) + 1;
  }
  starts.forEach((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : n;
    for (let i = s; i < end; i++) {
      const last = k + 1 >= starts.length;
      pos[i] = last ? (i - s) % typical : i - s;
      length[i] = last ? typical : end - s;
      number[i] = last ? k + 1 + Math.floor((i - s) / typical) : k + 1;
    }
  });
  return { pos, length, number };
}

// Averages frame-level features over each beat: chroma and energy from `frames`, bass-note
// salience from `bassFrames` (the bass stem when separated, otherwise the same source).
export function beatSync(beats, duration, frames, bassFrames = frames) {
  const [treble, bass, energy] = averagePerBeat(beats, duration, frames.frameTimes, [
    [frames.treble, 12],
    [frames.bass, 12],
    [frames.energy, 1],
  ]);
  const [bassSalience] = averagePerBeat(beats, duration, bassFrames.frameTimes, [[bassFrames.bassSalience, 12]]);

  // Loudness in dB relative to the loud parts of the song (95th percentile).
  const n = beats.length;
  const db = Array.from(energy, (e) => 10 * Math.log10(e + 1e-12));
  const reference = [...db].sort((a, b) => a - b)[Math.floor(0.95 * (n - 1))] ?? 0;
  const loudness = Float32Array.from(db, (d) => d - reference);

  return { treble, bass, bassSalience, loudness };
}

// Weighted mean of each [array, values per frame] over the frames of each beat. Frames near the
// middle of a beat weigh more, since their analysis window overlaps the neighbouring beats least.
function averagePerBeat(beats, duration, frameTimes, features) {
  const n = beats.length;
  const frames = frameTimes.length;
  const out = features.map(([, width]) => new Float32Array(n * width));
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
      features.forEach(([data, width], k) => {
        for (let c = 0; c < width; c++) out[k][i * width + c] += w * data[t * width + c];
      });
      total += w;
    }
    features.forEach(([, width], k) => {
      for (let c = 0; c < width; c++) out[k][i * width + c] /= total;
    });
  }
  return out;
}
