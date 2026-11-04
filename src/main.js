import './style.css';
import { decodeToMono, decodeToStereo, resampleToMono } from './audio.js';
import {
  allowedQuality,
  anticipateChanges,
  chordLabel,
  decodeBassLine,
  decodeChords,
  detectKey,
  dropShortSlashes,
  indexAt,
  keyLabel,
  markPowerChords,
  mergeSimilar,
  noteNames,
  parseChordLabel,
  QUALITIES,
  rebuildOnBass,
  refineChanges,
  respellSlash,
  snapToBeats,
  splitByBass,
  transposeKey,
  transposeRoot,
  vocabularyFor,
} from './analysis/chords.js';
import { beatSync, buildBeats, timeSlots } from './analysis/grid.js';
import { BEAT_FRONTEND_URL, BEAT_MODEL_URL, MODEL_CACHE, SEPARATION_MODEL_URL } from './modelFiles.js';
import { MODEL_SAMPLE_RATE } from './separation/demucs.js';
import { mixToWav, toInt16 } from './stemMix.js';
import { loadStems, saveStems } from './devStemCache.js';
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
  modelDialog: $('model-dialog'),
  modelTitle: $('model-title'),
  modelPurpose: $('model-purpose'),
  modelDownload: $('model-download'),
  sections: [...document.querySelectorAll('.sidebar details')],
  source: $('source'),
  timing: $('timing'),
  tempoSelect: $('tempo-select'),
  halfBeat: $('half-beat'),
  meter: $('meter'),
  detector: $('detector'),
  chorderOptions: $('chorder-options'),
  chordinoOptions: $('chordino-options'),
  chordinoInputs: [...document.querySelectorAll('[data-chordino]')],
  chordinoReset: $('chordino-reset'),
  smoothing: $('smoothing'),
  keyBias: $('key-bias'),
  allow: [...document.querySelectorAll('[data-allow]')],
  slash: $('slash'),
  respell: $('respell'),
  early: $('early'),
  rebuild: $('rebuild'),
  merge: $('merge'),
  mixRows: [...document.querySelectorAll('.mix-row')],
  stemRows: $('stem-rows'),
  stemsMissing: $('stems-missing'),
  separate: $('separate'),
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
  zoom: $('zoom'),
  speed: $('speed'),
  trDown: $('tr-down'),
  trUp: $('tr-up'),
  trValue: $('tr-value'),
  overlay: $('overlay'),
  stage: $('stage'),
  progress: $('progress-fill'),
};

// ---------- Preferences (the sidebar), kept across songs and visits ----------

const STEM_NAMES = ['vocals', 'drums', 'bass', 'other'];
const channel = (volume) => ({ volume, mute: false, solo: false });
const DEFAULTS = {
  source: 'mix', // chords from the full 'mix' or the separated 'harmony' (bass + other)
  timing: 'free', // chord changes 'free' (where the harmony changes), on the 'beats', or 'auto'
  tempo: 'steady', // beat grid from a steady-tempo candidate, or 'ai' (Beat This!)
  beatsPerBar: 4,
  detector: 'chorder', // 'chorder' or 'chordino'
  smoothing: 5,
  keyBias: 5, // slider value; the score bonus for chords that fit the key is × 0.02
  // Chordino's parameters, at its defaults (as in Sonic Visualiser). tuning: 0 global, 1 local.
  chordino: { useNNLS: true, shape: 0.7, whitening: 1, rollon: 0, boostN: 0.1, tuning: 0 },
  allowed: { sevenths: true, sus: false, power: true, dim: false, aug: false }, // besides maj/min
  slash: false, // split chords where the bass note changes and show it as C/E (needs the stems)
  respell: false, // re-spell slash chords rooted on the bass when that gives a familiar chord
  early: true, // start a chord where the bass already moved to it (Bb/D → Dm becomes an early Dm)
  rebuild: false, // experimental: re-read slash chords as in-key chords rooted on the bass
  merge: false, // merge neighbouring chords that differ only in quality (Bm, Bm7) into the best fit
  mixer: {
    music: channel(100),
    click: channel(0),
    chordSynth: channel(50),
    bassSynth: channel(50),
    ...Object.fromEntries(STEM_NAMES.map((name) => [name, channel(100)])),
  },
  sections: { setup: true, detector: true, namer: true, mixer: true },
};
const PREFS_KEY = 'chord-er-settings';

function loadPrefs() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {};
  } catch {
    // no saved settings, or storage blocked
  }
  const merged = { ...structuredClone(DEFAULTS), ...saved };
  for (const group of ['allowed', 'chordino', 'sections']) merged[group] = { ...DEFAULTS[group], ...saved[group] };
  merged.mixer = Object.fromEntries(Object.keys(DEFAULTS.mixer).map((c) => [c, { ...DEFAULTS.mixer[c], ...saved.mixer?.[c] }]));
  return merged;
}

const prefs = loadPrefs();
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // not remembered
  }
}

// Per-song choices.
const view = {
  tempo: '0:1', // "<steady-tempo candidate index, or 'ai' for Beat This!>:<tempo multiplier>"
  halfBeat: false,
  transpose: 0,
};

let analysis = null; // worker output, independent of the settings; later also .tracked (Beat This!
// beats), .harmony (chroma of bass + other), .bassStem (analysis of the bass stem), .drumShare (the
// drums' share of the instrumental energy) and .chordino (Chordino's chords per source and
// parameters; .chordinoLast keeps each source's latest, shown while new parameters run)
let stems = null; // the separated stems as 16-bit [left, right], in STEM_NAMES order
let grid = null; // beat grid and beat-synchronous chroma for the current tempo settings
let key = null;
let song = null; // decoded chords with display labels
// Model workers, kept alive so each model loads once; `busy` holds those mid-job.
const workers = { beats: null, stems: null, chordino: null };
// Written out literally so Vite bundles each worker for the production build.
const createWorker = {
  beats: () => new Worker(new URL('./beats/worker.js', import.meta.url), { type: 'module' }),
  stems: () => new Worker(new URL('./separation/worker.js', import.meta.url), { type: 'module' }),
  chordino: () => new Worker(new URL('./chordino/worker.js', import.meta.url), { type: 'module' }),
};
const busy = new Set();
let loadId = 0; // identifies the current song, so results for a replaced song are dropped
let songFile = null; // the loaded file, decoded again for the stems and Chordino
let beatSamples = null; // the mono analysis signal, for Beat This!
let jobs = {}; // per song: the AI model jobs ('beats', 'stems') asked for or running
let chordinoRunning = new Set(); // per song: Chordino runs (source and parameters) in progress
let objectUrl = null; // the original file
let mixUrl = null; // the current stem mix, when the stems aren't all at full volume

const synth = new ChordSynth(0);
const bassSynth = new BassSynth(0);
const metronome = new Metronome(0);
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
    beatSamples = samples.slice(); // the analysis worker takes ownership of `samples`
    analysis = await runAnalysis({ samples, sampleRate: ANALYSIS_SAMPLE_RATE }, showProgress);
    analysis.chordino = {};
    analysis.chordinoLast = {};
    songFile = file;
    key = null;
    stems = null;
    jobs = {};
    chordinoRunning = new Set();
    showStatus(null);
    populateTempoOptions();
    showStemRows();

    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (mixUrl) URL.revokeObjectURL(mixUrl);
    objectUrl = URL.createObjectURL(file);
    mixUrl = null;
    appliedStemGains = '';
    audio.src = objectUrl;
    audio.playbackRate = Number(ui.speed.value);
    ui.title.textContent = file.name.replace(/\.[^.]+$/, '');
    ui.dropzone.hidden = true;
    ui.player.hidden = false;
    refresh();
    seek(0);
    requestModels();
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

// ---------- AI models, on demand ----------

const MODELS = {
  beats: {
    urls: [BEAT_FRONTEND_URL, BEAT_MODEL_URL],
    title: 'Download the beat tracking model?',
    purpose: 'Beat This! (82 MB) follows tempo changes and finds the bars, for the Beat This! tempo.',
    size: '82 MB',
  },
  stems: {
    urls: [SEPARATION_MODEL_URL],
    title: 'Download the stem separation model?',
    purpose:
      'HTDemucs (166 MB) splits the song into vocals, drums, bass and other instruments. It is needed for chords from the harmony, slash chords and the stem mixer.',
    size: '166 MB',
  },
};

// The settings that need each model, and how to turn them back off when its download is declined.
const needs = {
  beats: () => prefs.tempo === 'ai',
  stems: () => prefs.source === 'harmony' || prefs.slash,
};
const decline = {
  beats: () => {
    prefs.tempo = 'steady';
    view.tempo = '0:1';
  },
  stems: () => {
    prefs.source = 'mix';
    prefs.slash = false;
  },
};

async function modelCached(kind) {
  try {
    const cache = await caches.open(MODEL_CACHE);
    return (await Promise.all(MODELS[kind].urls.map((url) => cache.match(url)))).every(Boolean);
  } catch {
    return false;
  }
}

// True when the model is cached, or the user agrees to download it now. One question at a time.
let prompts = Promise.resolve();
function modelAllowed(kind) {
  const answer = prompts.then(async () => {
    if (await modelCached(kind)) return true;
    const { title, purpose, size } = MODELS[kind];
    ui.modelTitle.textContent = title;
    ui.modelPurpose.textContent = purpose;
    ui.modelDownload.textContent = `Download (${size})`;
    ui.modelDialog.showModal();
    await new Promise((resolve) => ui.modelDialog.addEventListener('close', resolve, { once: true }));
    return ui.modelDialog.returnValue === 'download';
  });
  prompts = answer.catch(() => {});
  return answer;
}

// The model jobs run one after the other.
let jobQueue = Promise.resolve();

// Starts the model `kind` for the current song once allowed; when the download is declined, the
// settings that needed it are turned off.
async function requestModel(kind, onDecline = decline[kind]) {
  const id = loadId;
  if (!analysis || jobs[kind]) return;
  jobs[kind] = 'asking';
  if (!(await modelAllowed(kind))) {
    if (id === loadId) jobs[kind] = null;
    onDecline();
    savePrefs();
    syncControls();
    refresh();
    return;
  }
  if (id !== loadId) return;
  const run = kind === 'beats' ? trackBeats : separateHarmony;
  jobs[kind] = jobQueue = jobQueue.then(() =>
    run(id).catch((err) => {
      if (id !== loadId) return;
      console.error(err);
      jobs[kind] = null;
      showStatus(`${kind === 'beats' ? 'Beat tracking' : 'Stem separation'} failed: ${err.message || err}`);
    }),
  );
}

function requestModels() {
  for (const kind of ['beats', 'stems']) if (needs[kind]()) requestModel(kind);
}

// Beat This! follows tempo changes and finds the downbeats.
async function trackBeats(id) {
  if (id !== loadId) return;
  showStatus('Loading beat model', 0);
  const samples = beatSamples.slice();
  const { beats, downbeats } = await runModel('beats', { samples }, [samples.buffer]);
  if (id !== loadId) return;
  analysis.tracked = { times: beats, downbeats };
  showStatus(null);
  populateTempoOptions();
  refresh();
}

// Separates the four stems, then analyzes the harmony (bass + other: no vocals, no drums) for the
// chords and the bass stem alone for the bass line. The drums only tell whether the song has a
// beat to follow. Tempo stays on the full mix. All four stems are kept for the mixer.
async function separateHarmony(id) {
  if (id !== loadId) return;
  const file = songFile;
  showStatus('Preparing stem separation', 0);
  // In development, a song's stems are reused from earlier runs (see devStemCache.js).
  let stored = import.meta.env.DEV ? await loadStems(file, STEM_NAMES.length) : null;
  let separated;
  if (stored) {
    separated = stored.map((stem) => stem.map((ch) => Float32Array.from(ch, (v) => v / 32767)));
  } else {
    const stereo = await decodeToStereo(await file.arrayBuffer(), MODEL_SAMPLE_RATE);
    if (id !== loadId) return;
    ({ stems: separated } = await runModel(
      'stems',
      { left: stereo[0], right: stereo[1], groups: STEM_NAMES.map((name) => [name]) },
      stereo.map((c) => c.buffer),
    ));
    stored = separated.map(toInt16);
    if (import.meta.env.DEV) saveStems(file, stored);
  }
  if (id !== loadId) return;
  const [, drums, bass, other] = separated;
  const harmony = bass.map((ch, c) => ch.map((v, i) => v + other[c][i]));
  const energy = (stem) => stem.reduce((sum, ch) => sum + ch.reduce((s, v) => s + v * v, 0), 0);
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
  stems = stored;
  analysis.harmony = harmonyFrames;
  analysis.bassStem = bassFrames;
  showStatus(null);
  showStemRows();
  applyMixer();
  key = null;
  refresh();
}

// ---------- Chordino ----------

const CHORDINO_RATE = 44100;
// Chordino analyzes the harmony once the stems are there, else the full mix.
const chordinoSource = () => (prefs.source === 'harmony' && stems ? 'harmony' : 'mix');

// Results are kept per source and parameters.
const chordinoKey = () => `${chordinoSource()} ${JSON.stringify(prefs.chordino)}`;

// Starts Chordino for the current source and parameters when it is the chosen detector and
// hasn't run with them yet.
function ensureChordino() {
  if (prefs.detector !== 'chordino' || !analysis) return;
  const runKey = chordinoKey();
  if (analysis.chordino[runKey] || chordinoRunning.has(runKey)) return;
  chordinoRunning.add(runKey);
  runChordino(chordinoSource(), runKey, { ...prefs.chordino });
}

async function runChordino(which, runKey, parameters) {
  const id = loadId;
  showStatus('Running Chordino');
  try {
    let samples;
    if (which === 'mix') samples = await decodeToMono(await songFile.arrayBuffer(), CHORDINO_RATE);
    else {
      // Bass + other, in stereo at the model's 44.1 kHz rate, mixed down.
      const [, , bass, other] = stems;
      samples = new Float32Array(bass[0].length);
      for (const stem of [bass, other]) {
        for (const ch of stem) for (let i = 0; i < samples.length; i++) samples[i] += ch[i] / (2 * 32767);
      }
    }
    const { chords } = await runModel('chordino', { samples, sampleRate: CHORDINO_RATE, parameters }, [samples.buffer]);
    if (id !== loadId) return;
    analysis.chordino[runKey] = analysis.chordinoLast[which] = chords;
    showStatus(null);
    refresh();
  } catch (err) {
    console.error(err);
    if (id === loadId) showStatus('Chordino failed');
  }
}

// Chordino's labels as chord pieces, each lasting until the next.
function chordinoPieces(labels, duration) {
  const pieces = labels.map(({ time, label }, k) => ({
    start: time,
    end: k + 1 < labels.length ? labels[k + 1].time : duration,
    ...parseChordLabel(label),
  }));
  if (!pieces.length || pieces[0].start > 0) {
    pieces.unshift({ start: 0, end: pieces[0]?.start ?? duration, root: -1, quality: 'N', bass: -1 });
  }
  return pieces;
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

// Beat This! (its beats at ½, ×1 and ×2 once tracked, else one entry that runs it), then the
// steady-tempo candidates: the detected tempo, its double and half, and the others, slowest first.
function populateTempoOptions() {
  const { tempoCandidates: candidates, tracked } = analysis;
  const ai = document.createElement('optgroup');
  ai.label = 'Beat This! (AI, follows tempo changes)';
  if (tracked) {
    const bpm = medianBpm(tracked.times);
    ai.append(...[0.5, 1, 2].map((mult) => new Option(`${Math.round(bpm * mult)} BPM${mult === 1 ? ' (detected)' : ''}`, `ai:${mult}`)));
  } else ai.append(new Option('Beat This!', 'ai:1'));

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
  steady.append(...options.map(({ value, bpm }) => new Option(`${Math.round(bpm)} BPM${value === '0:1' ? ' (detected)' : ''}`, value)));
  if (!options.length) steady.append(new Option('120 BPM (no clear beat)', '0:1'));
  ui.tempoSelect.replaceChildren(ai, steady);
  view.tempo = ui.tempoSelect.value = prefs.tempo === 'ai' ? 'ai:1' : '0:1';
  view.halfBeat = ui.halfBeat.checked = false;
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
  ensureChordino();
  const { duration, tempoCandidates, tracked } = analysis;
  // Until Beat This! has run, its choice shows the detected steady tempo.
  const [index, multiplier] = (view.tempo.startsWith('ai') && !tracked ? '0:1' : view.tempo).split(':');
  const beatSource = index === 'ai' ? tracked : (tempoCandidates[Number(index)] ?? null);
  const { beats, downbeats } = buildBeats(beatSource, { mult: Number(multiplier), half: view.halfBeat }, duration);
  const frames = prefs.source === 'harmony' && analysis.harmony ? analysis.harmony : analysis;
  grid = { duration, beats, downbeats, ...beatSync(beats, duration, frames, analysis.bassStem ?? frames) };
  key ??= detectKey(grid);

  // The beat grid always gives the bars; the chords come from it too, or, with free timing, from
  // a plain time grid so they change wherever the harmony does.
  const decoding = {
    vocabulary: vocabularyFor(prefs.allowed),
    smoothing: prefs.smoothing,
    beatsPerBar: prefs.beatsPerBar,
    keyBias: prefs.keyBias * 0.02,
  };
  let { chords, bars } = decodeChords(grid, key, decoding);
  const free = chordTimingIsFree();
  const bassFrames = analysis.bassStem ?? frames;
  let chordGrid = grid;
  if (free) {
    const slots = timeSlots(duration);
    chordGrid = { duration, beats: slots, downbeats: null, uniform: true, ...beatSync(slots, duration, frames, bassFrames) };
    ({ chords } = decodeChords(chordGrid, key, decoding));
  }

  // Chordino's chords keep its slash chords, and its own timing unless chords change on beats;
  // their qualities are reduced to the allowed ones. While new parameters run, its previous chords
  // show; before its first run, chord-er's.
  const chordino =
    prefs.detector === 'chordino' ? (analysis.chordino[chordinoKey()] ?? analysis.chordinoLast[chordinoSource()]) : null;
  let pieces;
  if (chordino) {
    pieces = chordinoPieces(chordino, duration).map((p) => ({ ...p, quality: allowedQuality(p.quality, prefs.allowed) }));
    if (!free) pieces = snapToBeats(pieces, beats, duration);
  } else {
    if (prefs.allowed.power) chords = markPowerChords(chords, chordGrid);
    // Pieces of constant chord and bass note. The bass line needs the bass stem: in the full mix
    // the kick drum reads as bass notes.
    const detectedBass = analysis.bassStem ? decodeBassLine(chordGrid, prefs.smoothing) : null;
    pieces = detectedBass ? splitByBass(chords, detectedBass, chordGrid.beats) : chords.map((c) => ({ ...c, bass: -1 }));
    if (free) pieces = refineChanges(pieces, frames, bassFrames);
    const beatLength = 60 / medianBpm(beats);
    if (detectedBass && prefs.slash && prefs.early) pieces = anticipateChanges(pieces, beatLength);
    pieces = dropShortSlashes(pieces, prefs.smoothing, beatLength);
  }
  // The bass synth plays each piece's bass note (the root where the bass is unclear).
  song = { bass: pieces.map((p) => ({ start: p.start, pc: p.bass >= 0 ? p.bass : p.root })) };
  if (!prefs.slash) pieces = pieces.map((p) => ({ ...p, bass: -1 }));
  else {
    if (prefs.respell) pieces = pieces.map(respellSlash);
    if (prefs.rebuild && !chordino) pieces = rebuildOnBass(pieces, chordGrid, key);
  }
  pieces = prefs.merge ? mergeSimilar(pieces, frames) : mergeSameChord(pieces);

  const shownKey = transposeKey(key, view.transpose);
  Object.assign(song, {
    bars,
    chords: pieces.map((c) => {
      const root = transposeRoot(c.root, view.transpose);
      const bass = transposeRoot(c.bass ?? -1, view.transpose);
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
    bass: song.bass,
    chroma: { frameTimes: frames.frameTimes, values: frames.treble, names: noteNames(key) },
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
  ui.trValue.textContent = view.transpose > 0 ? `+${view.transpose}` : String(view.transpose);
  shown = {};
  resetSchedule();
}

// Free chord timing when chosen, or automatically for songs (nearly) without drums, whose beat
// grid is unreliable. Until the stems are separated, the drums' share is unknown: beats.
function chordTimingIsFree() {
  if (prefs.timing !== 'auto') return prefs.timing === 'free';
  return analysis.drumShare !== undefined && analysis.drumShare < 0.05;
}

// Joins neighbouring pieces of the same chord (that differ only in bass note).
function mergeSameChord(pieces) {
  const out = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last && last.root === p.root && last.quality === p.quality && last.bass === p.bass) last.end = p.end;
    else out.push({ ...p });
  }
  return out;
}

// ---------- Mixer ----------

// The volume each channel actually plays at (0–1), after mute and solo. Soloing a stem keeps the
// music channel on, playing only the soloed stems.
function audibleGains() {
  const m = prefs.mixer;
  const stemSolo = !!stems && STEM_NAMES.some((name) => m[name].solo);
  const anySolo = stemSolo || ['music', 'click', 'chordSynth', 'bassSynth'].some((c) => m[c].solo);
  const on = (c) => !m[c].mute && (!anySolo || m[c].solo || (c === 'music' && stemSolo));
  const level = (c) => (on(c) ? m[c].volume / 100 : 0);
  return {
    music: level('music'),
    click: level('click'),
    chordSynth: level('chordSynth'),
    bassSynth: level('bassSynth'),
    stems: STEM_NAMES.map((name) => (!m[name].mute && (!stemSolo || m[name].solo) ? m[name].volume / 100 : 0)),
  };
}

let appliedStemGains = ''; // the stem gains the playing audio was mixed with
let stemMixTimer = 0;
function applyMixer() {
  const gains = audibleGains();
  metronome.setVolume(gains.click);
  synth.setVolume(gains.chordSynth);
  bassSynth.setVolume(gains.bassSynth);
  if (musicGain) musicGain.gain.setTargetAtTime(gains.music, audioCtx.currentTime, 0.02);
  for (const row of ui.mixRows) {
    const c = prefs.mixer[row.dataset.channel];
    row.querySelector('[data-mute]').classList.toggle('on', c.mute);
    row.querySelector('[data-solo]').classList.toggle('on', c.solo);
  }
  // Remixing briefly reloads the song, so wait until the controls rest. Silent music needs none.
  if (stems && gains.music > 0 && gains.stems.join() !== appliedStemGains) {
    clearTimeout(stemMixTimer);
    stemMixTimer = setTimeout(() => applyStemMix(gains.stems), 250);
  }
}

function showStemRows() {
  ui.stemRows.hidden = !stems;
  ui.stemsMissing.hidden = !!stems;
  ui.separate.disabled = !analysis;
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

// Plays the stems mixed at these gains, or the original file when all are at full volume.
let mixToken = 0;
async function applyStemMix(gains) {
  const token = ++mixToken;
  appliedStemGains = gains.join();
  let url = objectUrl;
  if (gains.some((g) => g < 1)) url = URL.createObjectURL(mixToWav(stems, gains, MODEL_SAMPLE_RATE));
  if (token !== mixToken) return URL.revokeObjectURL(url);
  const time = audio.currentTime;
  const playing = !audio.paused;
  const old = mixUrl;
  mixUrl = url === objectUrl ? null : url;
  audio.src = url; // resets the playback rate and position
  audio.playbackRate = Number(ui.speed.value);
  audio.currentTime = time;
  lastAudioTime = -1;
  resetSchedule();
  if (playing) await audio.play().catch(() => {});
  if (old) URL.revokeObjectURL(old);
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

// Sets a chord name, shrinking its font when the name is too wide for its box. The line height
// stays, so the panels keep their height.
function showChord(el, label) {
  el.style.fontSize = el.style.lineHeight = '';
  el.textContent = label;
  if (el.scrollWidth > el.clientWidth) {
    const style = getComputedStyle(el);
    el.style.lineHeight = style.lineHeight;
    el.style.fontSize = `${(parseFloat(style.fontSize) * el.clientWidth) / el.scrollWidth}px`;
  }
}

let shown = {};
function updatePanel(t) {
  const { chords, bars } = song;
  const ci = indexAt(chords, t, (c) => c.start);
  const beat = indexAt(grid.beats, t);
  const next = chords[ci + 1];

  if (ci !== shown.chord) {
    showChord(ui.now, ci >= 0 ? chords[ci].label : '–');
    showChord(ui.next, next ? next.label : '–');
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
    musicGain.gain.value = audibleGains().music;
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

// Shows the preferences in the sidebar.
function syncControls() {
  ui.source.value = prefs.source;
  ui.timing.value = prefs.timing;
  ui.meter.value = prefs.beatsPerBar;
  if (analysis) ui.tempoSelect.value = view.tempo;
  ui.detector.value = prefs.detector;
  ui.chorderOptions.hidden = prefs.detector !== 'chorder';
  ui.chordinoOptions.hidden = prefs.detector !== 'chordino';
  for (const input of ui.chordinoInputs) {
    const value = prefs.chordino[input.dataset.chordino];
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
    showChordinoValue(input);
  }
  ui.smoothing.value = prefs.smoothing;
  ui.keyBias.value = prefs.keyBias;
  for (const box of ui.allow) box.checked = prefs.allowed[box.dataset.allow];
  ui.slash.checked = prefs.slash;
  ui.respell.checked = prefs.respell;
  ui.early.checked = prefs.early;
  ui.rebuild.checked = prefs.rebuild;
  ui.merge.checked = prefs.merge;
  ui.respell.disabled = !prefs.slash;
  // Early changes and rebuilding work on chord-er's own chords.
  ui.early.disabled = ui.rebuild.disabled = !prefs.slash || prefs.detector !== 'chorder';
  for (const row of ui.mixRows) row.querySelector('input').value = prefs.mixer[row.dataset.channel].volume;
  for (const section of ui.sections) section.open = prefs.sections[section.dataset.section];
}

function showChordinoValue(input) {
  const output = input.nextElementSibling;
  if (output?.tagName === 'OUTPUT') output.value = input.dataset.chordino === 'rollon' ? `${input.value}%` : input.value;
}

// A preference changed: remember it, then redraw (`rekey`: the key may change too).
function changed({ rekey = false } = {}) {
  savePrefs();
  syncControls();
  if (rekey) key = null;
  refresh();
  requestModels();
}

ui.file.addEventListener('change', () => {
  loadFile(ui.file.files[0]);
  ui.file.value = '';
});
ui.play.addEventListener('click', togglePlay);

ui.source.addEventListener('change', () => {
  prefs.source = ui.source.value;
  changed({ rekey: true });
});
ui.timing.addEventListener('change', () => {
  prefs.timing = ui.timing.value;
  changed();
});
ui.tempoSelect.addEventListener('change', () => {
  view.tempo = ui.tempoSelect.value;
  prefs.tempo = view.tempo.startsWith('ai') ? 'ai' : 'steady';
  changed();
});
ui.halfBeat.addEventListener('change', () => {
  view.halfBeat = ui.halfBeat.checked;
  refresh();
});
ui.meter.addEventListener('change', () => {
  prefs.beatsPerBar = Number(ui.meter.value);
  changed();
});
ui.detector.addEventListener('change', () => {
  prefs.detector = ui.detector.value;
  changed();
});
ui.smoothing.addEventListener('input', () => {
  prefs.smoothing = Number(ui.smoothing.value);
  changed();
});
ui.keyBias.addEventListener('input', () => {
  prefs.keyBias = Number(ui.keyBias.value);
  changed();
});
// Each change re-runs Chordino (a few seconds), so sliders apply when released.
for (const input of ui.chordinoInputs) {
  input.addEventListener('input', () => showChordinoValue(input));
  input.addEventListener('change', () => {
    prefs.chordino[input.dataset.chordino] = input.type === 'checkbox' ? input.checked : Number(input.value);
    changed();
  });
}
ui.chordinoReset.addEventListener('click', () => {
  prefs.chordino = { ...DEFAULTS.chordino };
  changed();
});
for (const box of ui.allow) {
  box.addEventListener('change', () => {
    prefs.allowed[box.dataset.allow] = box.checked;
    changed();
  });
}
for (const name of ['slash', 'respell', 'early', 'rebuild', 'merge']) {
  ui[name].addEventListener('change', () => {
    prefs[name] = ui[name].checked;
    changed();
  });
}
for (const section of ui.sections) {
  section.addEventListener('toggle', () => {
    prefs.sections[section.dataset.section] = section.open;
    savePrefs();
  });
}

for (const row of ui.mixRows) {
  const c = prefs.mixer[row.dataset.channel];
  row.querySelector('input').addEventListener('input', (e) => {
    startAudio();
    c.volume = Number(e.target.value);
    savePrefs();
    applyMixer();
  });
  for (const flag of ['mute', 'solo']) {
    row.querySelector(`[data-${flag}]`).addEventListener('click', () => {
      startAudio();
      c[flag] = !c[flag];
      savePrefs();
      applyMixer();
    });
  }
}
ui.separate.addEventListener('click', () => requestModel('stems', () => {}));

ui.zoom.addEventListener('input', () => timeline.setZoom(Number(ui.zoom.value)));
ui.speed.addEventListener('change', () => {
  audio.playbackRate = Number(ui.speed.value);
  resetSchedule();
});
for (const [button, delta] of [
  [ui.trDown, -1],
  [ui.trUp, 1],
]) {
  button.addEventListener('click', () => {
    view.transpose = Math.max(-11, Math.min(11, view.transpose + delta));
    refresh();
  });
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    e.preventDefault();
    // Blur first so the keyup doesn't also "click" a focused button or toggle a checkbox.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    togglePlay();
  } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    e.preventDefault();
    seek(audio.currentTime + (e.code === 'ArrowLeft' ? -5 : 5));
  }
});

// Re-fit the chord names to the new box widths.
window.addEventListener('resize', () => {
  for (const el of [ui.now, ui.next]) showChord(el, el.textContent);
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

syncControls();
showStemRows();
applyMixer();
