import './style.css';
import { decodeToMono, decodeToStereo, resampleToMono } from './audio.js';
import {
  chordLabel,
  decodeBassLine,
  decodeChords,
  detectKey,
  dropShortSlashes,
  indexAt,
  keyLabel,
  noteNames,
  QUALITIES,
  refineChanges,
  splitByBass,
  transposeKey,
  transposeRoot,
} from './analysis/chords.js';
import { beatSync, buildBeats, timeSlots } from './analysis/grid.js';
import { MODEL_CACHE, MODEL_URLS } from './modelFiles.js';
import { MODEL_SAMPLE_RATE } from './separation/demucs.js';
import { BassSynth, ChordSynth, Metronome, chordVoicing } from './synth.js';
import { NoteGraph } from './view/noteGraph.js';
import { Timeline } from './view/timeline.js';

const ANALYSIS_SAMPLE_RATE = 22050;

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const ui = {
  file: $('file'),
  title: $('song-title'),
  key: $('key'),
  tempo: $('tempo'),
  status: $('status'),
  enableModels: $('enable-models'),
  modelDialog: $('model-dialog'),
  source: $('source'),
  slash: $('slash'),
  timing: $('timing'),
  notesLabel: $('notes-label'),
  dropzone: $('dropzone'),
  dropError: $('drop-error'),
  player: $('player'),
  now: $('now-chord'),
  next: $('next-chord'),
  nextIn: $('next-in'),
  barDots: $('bar-dots'),
  play: $('play'),
  time: $('time'),
  musicVolume: $('music-volume'),
  synthVolume: $('synth-volume'),
  bassVolume: $('bass-volume'),
  clickVolume: $('click-volume'),
  zoom: $('zoom'),
  tempoSelect: $('tempo-select'),
  halfBeat: $('half-beat'),
  speed: $('speed'),
  vocabulary: $('vocabulary'),
  smoothing: $('smoothing'),
  keyBias: $('key-bias'),
  meter: $('meter'),
  trDown: $('tr-down'),
  trUp: $('tr-up'),
  trValue: $('tr-value'),
  overlay: $('overlay'),
  stage: $('stage'),
  progress: $('progress-fill'),
};

const settings = {
  source: 'mix', // chords from the full 'mix' or the separated 'harmony' (bass + other)
  slash: true, // split chords where the bass note changes and show it as C/E
  timing: 'auto', // chord changes on the 'beats', 'free' (where the harmony changes), or 'auto'
  tempo: '0:1', // "<steady-tempo candidate index, or 'ai' for Beat This!>:<tempo multiplier>"
  halfBeat: false,
  vocabulary: 'sevenths',
  smoothing: 5,
  keyBias: 0.1, // score bonus for chords that fit the key (slider value × 0.02)
  beatsPerBar: 4,
  transpose: 0,
};
let analysis = null; // worker output, independent of the settings above; later also .tracked
// (Beat This! beats), .harmony (chroma of bass + other), .bassStem (analysis of the bass stem)
// and .drumShare (the drums' share of the instrumental energy)
let grid = null; // beat grid and beat-synchronous chroma for the current tempo settings
let key = null;
let song = null; // decoded chords with display labels
// Model workers, kept alive so each model loads once; `busy` holds those mid-job.
const workers = { beats: null, stems: null };
// Written out literally so Vite bundles each worker for the production build.
const createWorker = {
  beats: () => new Worker(new URL('./beats/worker.js', import.meta.url), { type: 'module' }),
  stems: () => new Worker(new URL('./separation/worker.js', import.meta.url), { type: 'module' }),
};
const busy = new Set();
let loadId = 0; // identifies the current song, so results for a replaced song are dropped
let objectUrl = null;

const volumeOf = (slider) => Number(slider.value) / 100;
const synth = new ChordSynth(volumeOf(ui.synthVolume));
const bassSynth = new BassSynth(volumeOf(ui.bassVolume));
const metronome = new Metronome(volumeOf(ui.clickVolume));
let audioCtx = null;
let musicGain = null;

const noteGraph = new NoteGraph($('note-graph'));
const timeline = new Timeline($('timeline'), {
  onSeek: seek,
  onZoom: (pxPerSec) => (ui.zoom.value = pxPerSec),
});

// ---------- Loading & analysis ----------

async function loadFile(file) {
  if (!file) return;
  const id = ++loadId;
  ui.dropError.hidden = true;
  showProgress('Decoding audio…', 0);
  audio.pause();
  for (const name of busy) {
    // Still busy with the previous song; restart the worker (its model reloads from cache).
    workers[name].terminate();
    workers[name] = null;
  }
  busy.clear();
  try {
    const samples = await decodeToMono(await file.arrayBuffer(), ANALYSIS_SAMPLE_RATE);
    const beatSamples = samples.slice(); // the analysis worker takes ownership of `samples`
    analysis = await runAnalysis({ samples, sampleRate: ANALYSIS_SAMPLE_RATE }, showProgress);
    key = null;
    populateTempoOptions();
    settings.source = ui.source.value = 'mix';
    ui.source.querySelector('[value=harmony]').disabled = true;
    ui.source.parentElement.hidden = false;
    ui.slash.disabled = true;
    ui.slash.parentElement.hidden = false;
    ui.timing.parentElement.hidden = false;

    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    audio.src = objectUrl;
    audio.playbackRate = Number(ui.speed.value);
    ui.title.textContent = file.name.replace(/\.[^.]+$/, '');
    ui.dropzone.hidden = true;
    ui.player.hidden = false;
    refresh();
    seek(0);
    enhance(file, beatSamples, id);
  } catch (err) {
    console.error(err);
    ui.dropError.textContent = `Could not analyze “${file.name}”: ${err.message || err}`;
    ui.dropError.hidden = false;
    ui.dropzone.hidden = false;
    ui.player.hidden = true;
  } finally {
    ui.overlay.hidden = true;
  }
}

// Sends one job to a worker and resolves with its result, reporting progress on the way.
function runJob(worker, message, transfer, onProgress) {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress(data.stage, data.value);
      else if (data.type === 'result') resolve(data);
      else reject(new Error(data.message));
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Worker failed'));
    worker.postMessage(message, transfer);
  });
}

async function runAnalysis(message, onProgress) {
  const worker = new Worker(new URL('./analysis/worker.js', import.meta.url), { type: 'module' });
  try {
    return (await runJob(worker, message, [message.samples.buffer], onProgress)).result;
  } finally {
    worker.terminate();
  }
}

// Runs a job on one of the model workers, created on first use.
async function runModel(name, message, transfer) {
  workers[name] ??= createWorker[name]();
  busy.add(name);
  try {
    return await runJob(workers[name], message, transfer, showStatus);
  } finally {
    busy.delete(name);
  }
}

const CONSENT_KEY = 'chord-er-models-consent';
let consentPrompt = null; // the open dialog's answer, shared by everyone waiting on it
let declined = false; // "Not now" this session: don't ask again on every song

// True when the AI models may be used: they are already cached, the user agreed before, or the
// user agrees now. Asks with a dialog before the first download; after "Not now", only when
// `ask` is set (the user clicked the button).
async function modelsAllowed(ask = !declined) {
  try {
    if (localStorage.getItem(CONSENT_KEY) === 'yes') return true;
  } catch {
    // storage blocked: just ask
  }
  if (await modelsCached()) return true;
  if (!ask) return false;
  if (!consentPrompt) {
    consentPrompt = new Promise((resolve) =>
      ui.modelDialog.addEventListener(
        'close',
        () => {
          consentPrompt = null;
          resolve(ui.modelDialog.returnValue);
        },
        { once: true },
      ),
    );
    ui.modelDialog.showModal();
  }
  const answer = await consentPrompt;
  declined = answer !== 'download';
  if (declined) return false;
  try {
    localStorage.setItem(CONSENT_KEY, 'yes');
  } catch {
    // not remembered; the cached models skip the question next time anyway
  }
  return true;
}

async function modelsCached() {
  try {
    const cache = await caches.open(MODEL_CACHE);
    const found = await Promise.all(MODEL_URLS.map((url) => cache.match(url)));
    return found.every(Boolean);
  } catch {
    return false;
  }
}

// Background improvements once the song is playable: Beat This! beats (seconds), then the
// stem separation (tens of seconds). Each one switches the view over when it is ready. Without
// the user's go-ahead for the model download, the basic analysis stays and a button offers it.
async function enhance(file, beatSamples, id, ask) {
  ui.enableModels.hidden = true;
  if (!(await modelsAllowed(ask))) {
    if (id === loadId) {
      ui.enableModels.hidden = false;
      ui.enableModels.onclick = () => enhance(file, beatSamples, id, true);
    }
    return;
  }
  if (id !== loadId) return;
  let failed = null;
  try {
    await trackBeats(beatSamples.slice(), id);
  } catch (err) {
    if (id !== loadId) return;
    console.error(err);
    failed = `Beat tracking failed: ${err.message || err}`;
  }
  try {
    await separateHarmony(file, id);
  } catch (err) {
    if (id !== loadId) return;
    console.error(err);
    failed = `Stem separation failed: ${err.message || err}`;
  }
  if (id === loadId) showStatus(failed);
}

// Beat This! follows tempo changes and finds the downbeats; it becomes the default grid.
async function trackBeats(samples, id) {
  showStatus('Loading beat model', 0);
  const { beats, downbeats } = await runModel('beats', { samples }, [samples.buffer]);
  if (id !== loadId) return;
  analysis.tracked = { times: beats, downbeats };
  populateTempoOptions();
  refresh();
}

// Separates the bass, other and drum stems, then analyzes the harmony (bass + other: no vocals,
// no drums) for the chords and the bass stem alone for the bass line, and switches over to them.
// The drums only tell whether the song has a beat to follow. Tempo stays on the full mix.
async function separateHarmony(file, id) {
  showStatus('Preparing stem separation', 0);
  const stereo = await decodeToStereo(await file.arrayBuffer(), MODEL_SAMPLE_RATE);
  if (id !== loadId) return;
  const { stems } = await runModel(
    'stems',
    { left: stereo[0], right: stereo[1], groups: [['bass'], ['other'], ['drums']] },
    stereo.map((c) => c.buffer),
  );
  if (id !== loadId) return;
  const [bass, other, drums] = stems;
  const harmony = bass.map((channel, c) => channel.map((v, i) => v + other[c][i]));
  const energy = (stem) => stem.reduce((sum, channel) => sum + channel.reduce((s, v) => s + v * v, 0), 0);
  const drumEnergy = energy(drums);
  analysis.drumShare = drumEnergy / (drumEnergy + energy(harmony) || 1);
  const analyze = async (stereoStem) =>
    runAnalysis(
      { samples: await resampleToMono(stereoStem, MODEL_SAMPLE_RATE, ANALYSIS_SAMPLE_RATE), sampleRate: ANALYSIS_SAMPLE_RATE, mode: 'chroma' },
      showStatus,
    );
  const harmonyFrames = await analyze(harmony);
  const bassFrames = await analyze(bass);
  if (id !== loadId) return;
  analysis.harmony = harmonyFrames;
  analysis.bassStem = bassFrames;
  ui.source.querySelector('[value=harmony]').disabled = false;
  ui.slash.disabled = false;
  settings.source = ui.source.value = 'harmony';
  key = null;
  refresh();
}

function showStatus(stage, value) {
  ui.status.hidden = !stage;
  if (stage) ui.status.textContent = value == null ? stage : `${stage}… ${Math.round(value * 100)}%`;
}

function showProgress(stage, value) {
  ui.overlay.hidden = false;
  ui.stage.textContent = stage;
  ui.progress.style.width = `${Math.round(value * 100)}%`;
}

// Beat This! beats (when ready) at ½, ×1 and ×2, then the steady-tempo candidates: the
// detected tempo, its double and half, and the others, slowest first.
function populateTempoOptions() {
  const { tempoCandidates: candidates, tracked } = analysis;
  const groups = [];
  if (tracked) {
    const bpm = medianBpm(tracked.times);
    const group = document.createElement('optgroup');
    group.label = 'Beat This! (follows tempo changes)';
    group.append(
      ...[0.5, 1, 2].map((mult) => new Option(`${Math.round(bpm * mult)} BPM${mult === 1 ? ' (detected)' : ''}`, `ai:${mult}`)),
    );
    groups.push(group);
  }
  const options = [];
  const add = (i, mult) => {
    const bpm = candidates[i].bpm * mult;
    if (!options.some((o) => Math.abs(o.bpm / bpm - 1) < 0.03)) options.push({ value: `${i}:${mult}`, bpm });
  };
  if (candidates.length) {
    [1, 2, 0.5].forEach((mult) => add(0, mult));
    candidates.forEach((_, i) => add(i, 1));
  }
  options.sort((a, b) => a.bpm - b.bpm);
  const steady = document.createElement('optgroup');
  steady.label = 'Steady tempo';
  steady.append(
    ...options.map(({ value, bpm }) => new Option(`${Math.round(bpm)} BPM${!tracked && value === '0:1' ? ' (detected)' : ''}`, value)),
  );
  if (!options.length) steady.append(new Option('120 BPM (no clear beat)', '0:1'));
  groups.push(steady);
  ui.tempoSelect.replaceChildren(...groups);
  settings.tempo = ui.tempoSelect.value = tracked ? 'ai:1' : '0:1';
  settings.halfBeat = ui.halfBeat.checked = false;
}

// Median tempo of a list of beat times.
function medianBpm(beats) {
  const intervals = Array.from(beats.slice(1), (t, i) => t - beats[i]).sort((a, b) => a - b);
  return intervals.length ? 60 / intervals[intervals.length >> 1] : 120;
}

// Tempo for the header: one value, or the range (10th–90th percentile over 8-beat spans) when
// the tempo moves.
function tempoText(beats) {
  const bpms = [];
  for (let i = 8; i < beats.length; i++) bpms.push((60 * 8) / (beats[i] - beats[i - 8]));
  if (!bpms.length) return `${Math.round(medianBpm(beats))} BPM`;
  bpms.sort((a, b) => a - b);
  const [low, mid, high] = [0.1, 0.5, 0.9].map((q) => Math.round(bpms[Math.floor(q * (bpms.length - 1))]));
  return high / low > 1.04 ? `${low}–${high} BPM` : `${mid} BPM`;
}

// Rebuilds the beat grid and re-decodes chords from the cached analysis; cheap enough to run
// on every slider move.
function refresh() {
  if (!analysis) return;
  const { duration, tempoCandidates, tracked } = analysis;
  const [index, multiplier] = settings.tempo.split(':');
  const mult = Number(multiplier);
  const beatSource = index === 'ai' ? tracked : (tempoCandidates[Number(index)] ?? null);
  const { beats, downbeats } = buildBeats(beatSource, { mult, half: settings.halfBeat }, duration);
  const frames = settings.source === 'harmony' && analysis.harmony ? analysis.harmony : analysis;
  grid = { duration, beats, downbeats, ...beatSync(beats, duration, frames, analysis.bassStem ?? frames) };
  key ??= detectKey(grid);

  // The beat grid always gives the bars; the chords come from it too, or, with free timing, from
  // a plain time grid so they change wherever the harmony does.
  let { chords, bars } = decodeChords(grid, key, settings);
  const free = chordTimingIsFree();
  const bassFrames = analysis.bassStem ?? frames;
  let chordGrid = grid;
  if (free) {
    const slots = timeSlots(duration);
    chordGrid = { duration, beats: slots, downbeats: null, uniform: true, ...beatSync(slots, duration, frames, bassFrames) };
    ({ chords } = decodeChords(chordGrid, key, settings));
  }
  // Pieces of constant chord and bass note. The bass line needs the bass stem: in the full mix
  // the kick drum reads as bass notes.
  const detectedBass = analysis.bassStem ? decodeBassLine(chordGrid, settings.smoothing) : null;
  let pieces = detectedBass ? splitByBass(chords, detectedBass, chordGrid.beats) : chords.map((c) => ({ ...c, bass: -1 }));
  if (free) pieces = refineChanges(pieces, frames, bassFrames);
  pieces = dropShortSlashes(pieces, settings.smoothing, 60 / medianBpm(beats));
  // The bass synth plays each piece's bass note (the root where the bass is unclear).
  song = { bass: pieces.map((p) => ({ start: p.start, pc: p.bass >= 0 ? p.bass : p.root })) };
  if (!settings.slash) pieces = mergeSameChord(pieces);

  const shownKey = transposeKey(key, settings.transpose);
  Object.assign(song, {
    bars,
    chords: pieces.map((c) => {
      const root = transposeRoot(c.root, settings.transpose);
      const bass = transposeRoot(c.bass ?? -1, settings.transpose);
      // The synth and note graph use the untransposed chord so it can be checked against the recording.
      return {
        ...c,
        root,
        label: chordLabel(root, c.quality, shownKey, bass),
        voicing: chordVoicing(c.root, c.quality),
        tones: c.root < 0 ? [] : QUALITIES[c.quality].intervals.map((iv) => (c.root + iv) % 12),
      };
    }),
  });
  ui.timing.querySelector('[value=auto]').text = `Auto (${free ? 'free' : 'on beats'})`;
  timeline.setData({
    duration,
    beats,
    bars,
    chords: song.chords,
    peaks: analysis.peaks,
    peaksPerSec: analysis.peaksPerSec,
  });
  noteGraph.setData({ frameTimes: frames.frameTimes, chroma: frames.treble, names: noteNames(key) });
  ui.notesLabel.textContent = frames === analysis ? 'Notes in the audio' : 'Notes in the harmony';

  ui.key.textContent = `Key: ${keyLabel(shownKey)}`;
  ui.tempo.textContent = tempoText(beats);
  // Tracked downbeats set the bars; the meter only matters when bars are inferred.
  ui.meter.disabled = !!downbeats;
  ui.meter.title = downbeats ? 'Bars come from the downbeats Beat This! found' : '';
  ui.key.hidden = ui.tempo.hidden = false;
  ui.trValue.textContent = settings.transpose > 0 ? `+${settings.transpose}` : String(settings.transpose);
  shown = {};
  resetSchedule();
}

// Free chord timing when chosen, or automatically for songs (nearly) without drums, whose beat
// grid is unreliable. Until the stems are separated, the drums' share is unknown: beats.
function chordTimingIsFree() {
  if (settings.timing !== 'auto') return settings.timing === 'free';
  return analysis.drumShare !== undefined && analysis.drumShare < 0.05;
}

// Joins neighbouring pieces of the same chord (that differ only in bass note).
function mergeSameChord(pieces) {
  const out = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last && last.root === p.root && last.quality === p.quality) last.end = p.end;
    else out.push({ ...p, bass: -1 });
  }
  return out;
}

// ---------- Playback ----------

function seek(t) {
  if (!analysis) return;
  const clamped = Math.max(0, Math.min(analysis.duration, t));
  audio.currentTime = clamped;
  lastAudioTime = -1;
  resetSchedule();
  timeline.setTime(clamped);
}

function togglePlay() {
  if (!analysis) return;
  startAudio();
  if (audio.paused) audio.play();
  else audio.pause();
}

// audio.currentTime updates in coarse steps; extrapolate between them for smooth scrolling.
let lastAudioTime = -1;
let lastAudioStamp = 0;
function playbackTime() {
  const t = audio.currentTime;
  if (audio.paused) return t;
  const now = performance.now();
  if (t !== lastAudioTime) {
    lastAudioTime = t;
    lastAudioStamp = now;
    return t;
  }
  return t + Math.min(0.25, (now - lastAudioStamp) / 1000) * audio.playbackRate;
}

const formatTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

let shown = {};
function updatePanel(t) {
  const { chords, bars } = song;
  const ci = indexAt(chords, t, (c) => c.start);
  const beat = indexAt(grid.beats, t);
  const next = chords[ci + 1];

  if (ci !== shown.chord) {
    ui.now.textContent = ci >= 0 ? chords[ci].label : '–';
    ui.next.textContent = next ? next.label : '–';
    shown.chord = ci;
  }

  const beatsLeft = next && beat >= 0 ? Math.max(0, indexAt(grid.beats, next.start + 0.02) - beat) : null;
  if (beatsLeft !== shown.beatsLeft) {
    ui.nextIn.textContent =
      beatsLeft == null ? '' : beatsLeft === 0 ? 'next' : `in ${beatsLeft} beat${beatsLeft === 1 ? '' : 's'}`;
    shown.beatsLeft = beatsLeft;
  }

  // One dot per beat of the current bar (bars can differ in length).
  const barLength = beat >= 0 ? bars.length[beat] : bars.length[0];
  if (barLength !== shown.barLength) {
    ui.barDots.replaceChildren(...Array.from({ length: barLength }, () => document.createElement('span')));
    shown.barLength = barLength;
    shown.pos = null;
  }
  const pos = beat >= 0 ? bars.pos[beat] : -1;
  if (pos !== shown.pos) {
    [...ui.barDots.children].forEach((dot, i) => dot.classList.toggle('on', i === pos));
    shown.pos = pos;
  }

  const timeText = `${formatTime(t)} / ${formatTime(analysis.duration)}`;
  if (timeText !== shown.time) {
    ui.time.textContent = timeText;
    shown.time = timeText;
  }
}

// ---------- Scheduled sounds: chord synth and metronome ----------

// One AudioContext for the song, the synth and the clicks, so they share the output latency.
// It must be created from a user gesture.
function startAudio() {
  if (!audioCtx) {
    audioCtx = new AudioContext({ latencyHint: 'interactive' });
    musicGain = audioCtx.createGain();
    musicGain.gain.value = volumeOf(ui.musicVolume);
    audioCtx.createMediaElementSource(audio).connect(musicGain).connect(audioCtx.destination);
    synth.attach(audioCtx);
    bassSynth.attach(audioCtx);
    metronome.attach(audioCtx);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

const LOOKAHEAD = 0.15; // seconds of song scheduled ahead of the playback position
let scheduledUntil = null; // song time up to which beats are scheduled; null = (re)start
let clockOffsets = []; // recent samples of (context time − song time / rate)

function resetSchedule() {
  scheduledUntil = null;
  clockOffsets = [];
  synth.stopAll();
  bassSynth.stopAll();
  metronome.stopAll();
}

// Schedules clicks on every beat, chord strikes where each chord starts and on every downbeat
// while it lasts, and bass notes where each bass note starts and on every downbeat, on the
// AudioContext clock so they land exactly on time.
function schedule() {
  if (!audioCtx || audio.paused) {
    if (scheduledUntil !== null) resetSchedule();
    return;
  }
  const rate = audio.playbackRate;
  const songNow = audio.currentTime;
  // audio.currentTime is jittery; the median of recent samples gives a stable clock mapping.
  clockOffsets.push(audioCtx.currentTime - songNow / rate);
  if (clockOffsets.length > 60) clockOffsets.shift();
  const offset = [...clockOffsets].sort((a, b) => a - b)[clockOffsets.length >> 1];

  const { beats } = grid;
  const { chords, bars, bass } = song;
  const chordAt = (t) => chords[indexAt(chords, t, (c) => c.start)];
  const bassAt = (t) => bass[indexAt(bass, t, (b) => b.start)]?.pc ?? -1;
  if (scheduledUntil === null) {
    synth.play(chordAt(songNow)?.voicing ?? [], audioCtx.currentTime);
    bassSynth.play(bassAt(songNow), audioCtx.currentTime);
    scheduledUntil = songNow;
  }
  const until = songNow + LOOKAHEAD * rate;
  const inWindow = (t) => t > scheduledUntil && t <= until;
  const at = (t) => Math.max(audioCtx.currentTime, offset + t / rate);

  // Song times of the chord and bass strikes in this window: starts, plus downbeat re-strikes
  // (skipped right next to a start, where free-timing changes sit just off the beat).
  const chordTimes = chords.filter((c) => inWindow(c.start)).map((c) => c.start);
  const bassTimes = bass.filter((b) => inWindow(b.start)).map((b) => b.start);
  const near = (times, t) => times.some((s) => Math.abs(s - t) < 0.08);
  for (let i = indexAt(beats, scheduledUntil) + 1; i < beats.length && beats[i] <= until; i++) {
    const downbeat = bars.pos[i] === 0;
    metronome.click(at(beats[i]), downbeat);
    if (!downbeat) continue;
    if (!near(chordTimes, beats[i])) chordTimes.push(beats[i]);
    if (!near(bassTimes, beats[i])) bassTimes.push(beats[i]);
  }
  // In time order: each strike releases the notes before it.
  for (const t of chordTimes.sort((a, b) => a - b)) {
    const chord = chordAt(t + 1e-6);
    if (chord) synth.play(chord.voicing, at(t));
  }
  for (const t of bassTimes.sort((a, b) => a - b)) bassSynth.play(bassAt(t + 1e-6), at(t));
  scheduledUntil = until;
}

function frame() {
  if (song) {
    const t = playbackTime();
    timeline.setTime(t);
    updatePanel(t);
    schedule();
    noteGraph.update(t, song.chords[indexAt(song.chords, t, (c) => c.start)]?.tones, song.bass[indexAt(song.bass, t, (b) => b.start)]?.pc ?? -1);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

audio.addEventListener('play', () => (ui.play.textContent = '❚❚'));
audio.addEventListener('pause', () => (ui.play.textContent = '▶'));

// ---------- Controls ----------

ui.file.addEventListener('change', () => {
  loadFile(ui.file.files[0]);
  ui.file.value = '';
});
ui.play.addEventListener('click', togglePlay);
ui.musicVolume.addEventListener('input', () => {
  startAudio();
  musicGain.gain.setTargetAtTime(volumeOf(ui.musicVolume), audioCtx.currentTime, 0.02);
});
ui.bassVolume.addEventListener('input', () => {
  startAudio();
  bassSynth.setVolume(volumeOf(ui.bassVolume));
});
ui.synthVolume.addEventListener('input', () => {
  startAudio();
  synth.setVolume(volumeOf(ui.synthVolume));
});
ui.clickVolume.addEventListener('input', () => {
  startAudio();
  metronome.setVolume(volumeOf(ui.clickVolume));
});
ui.zoom.addEventListener('input', () => timeline.setZoom(Number(ui.zoom.value)));
ui.speed.addEventListener('change', () => {
  audio.playbackRate = Number(ui.speed.value);
  resetSchedule();
});
ui.timing.addEventListener('change', () => {
  settings.timing = ui.timing.value;
  refresh();
});
ui.slash.addEventListener('change', () => {
  settings.slash = ui.slash.checked;
  refresh();
});
ui.source.addEventListener('change', () => {
  settings.source = ui.source.value;
  key = null;
  refresh();
});
ui.tempoSelect.addEventListener('change', () => {
  settings.tempo = ui.tempoSelect.value;
  refresh();
});
ui.halfBeat.addEventListener('change', () => {
  settings.halfBeat = ui.halfBeat.checked;
  refresh();
});
ui.vocabulary.addEventListener('change', () => {
  settings.vocabulary = ui.vocabulary.value;
  refresh();
});
ui.smoothing.addEventListener('input', () => {
  settings.smoothing = Number(ui.smoothing.value);
  refresh();
});
ui.keyBias.addEventListener('input', () => {
  settings.keyBias = Number(ui.keyBias.value) * 0.02;
  refresh();
});
ui.meter.addEventListener('change', () => {
  settings.beatsPerBar = Number(ui.meter.value);
  refresh();
});
for (const [button, delta] of [
  [ui.trDown, -1],
  [ui.trUp, 1],
]) {
  button.addEventListener('click', () => {
    settings.transpose = Math.max(-11, Math.min(11, settings.transpose + delta));
    refresh();
  });
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    // Blur first so the keyup doesn't also "click" a focused button.
    if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
    togglePlay();
  } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    e.preventDefault();
    seek(audio.currentTime + (e.code === 'ArrowLeft' ? -5 : 5));
  }
});

// Drag & drop anywhere on the page.
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  loadFile(e.dataTransfer.files[0]);
});
