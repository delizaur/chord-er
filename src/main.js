import './style.css';
import { decodeToMono, decodeToStereo, resampleToMono } from './audio.js';
import {
  beatInBar,
  chordLabel,
  decodeChords,
  detectKey,
  indexAt,
  keyLabel,
  noteNames,
  QUALITIES,
  transposeKey,
  transposeRoot,
} from './analysis/chords.js';
import { beatSync, buildBeats } from './analysis/grid.js';
import { MODEL_SAMPLE_RATE } from './separation/demucs.js';
import { ChordSynth, Metronome, chordVoicing } from './synth.js';
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
  stems: $('stems'),
  source: $('source'),
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
  clickVolume: $('click-volume'),
  zoom: $('zoom'),
  tempoSelect: $('tempo-select'),
  halfBeat: $('half-beat'),
  speed: $('speed'),
  vocabulary: $('vocabulary'),
  smoothing: $('smoothing'),
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
  tempo: '0:1', // "<candidate index>:<tempo multiplier>"
  halfBeat: false,
  vocabulary: 'sevenths',
  smoothing: 5,
  beatsPerBar: 4,
  transpose: 0,
};
let analysis = null; // worker output, independent of the settings above; .harmony once separated
let grid = null; // beat grid and beat-synchronous chroma for the current tempo settings
let key = null;
let song = null; // decoded chords with display labels
let separator = null; // stem separation worker, kept alive so the model loads once
let separating = false;
let loadId = 0; // identifies the current song, so results for a replaced song are dropped
let objectUrl = null;

const volumeOf = (slider) => Number(slider.value) / 100;
const synth = new ChordSynth(volumeOf(ui.synthVolume));
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
  if (separating) {
    // The worker is busy with the previous song; restart it (the model reloads from cache).
    separator.terminate();
    separator = null;
    separating = false;
  }
  try {
    const samples = await decodeToMono(await file.arrayBuffer(), ANALYSIS_SAMPLE_RATE);
    analysis = await runAnalysis({ samples, sampleRate: ANALYSIS_SAMPLE_RATE }, showProgress);
    key = null;
    populateTempoOptions(analysis.tempoCandidates);
    settings.source = ui.source.value = 'mix';
    ui.source.querySelector('[value=harmony]').disabled = true;
    ui.source.parentElement.hidden = false;

    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    audio.src = objectUrl;
    audio.playbackRate = Number(ui.speed.value);
    ui.title.textContent = file.name.replace(/\.[^.]+$/, '');
    ui.dropzone.hidden = true;
    ui.player.hidden = false;
    refresh();
    seek(0);
    separateHarmony(file, id);
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

// Separates the song's stems in the background, then analyzes the harmony (bass + other:
// no vocals, no drums) and switches the chords to it. Tempo stays on the full mix.
async function separateHarmony(file, id) {
  showStemStatus('Preparing stem separation', 0);
  try {
    const stereo = await decodeToStereo(await file.arrayBuffer(), MODEL_SAMPLE_RATE);
    if (id !== loadId) return;
    separator ??= new Worker(new URL('./separation/worker.js', import.meta.url), { type: 'module' });
    separating = true;
    const { left, right } = await runJob(
      separator,
      { left: stereo[0], right: stereo[1], sources: ['bass', 'other'] },
      stereo.map((c) => c.buffer),
      showStemStatus,
    );
    separating = false;
    if (id !== loadId) return;
    const samples = await resampleToMono([left, right], MODEL_SAMPLE_RATE, ANALYSIS_SAMPLE_RATE);
    const harmony = await runAnalysis({ samples, sampleRate: ANALYSIS_SAMPLE_RATE, mode: 'chroma' }, showStemStatus);
    if (id !== loadId) return;
    analysis.harmony = harmony;
    ui.source.querySelector('[value=harmony]').disabled = false;
    settings.source = ui.source.value = 'harmony';
    key = null;
    refresh();
    showStemStatus(null);
  } catch (err) {
    if (id !== loadId) return;
    console.error(err);
    separating = false;
    showStemStatus(`Stem separation failed: ${err.message || err}`);
  }
}

function showStemStatus(stage, value) {
  ui.stems.hidden = !stage;
  if (stage) ui.stems.textContent = value == null ? stage : `${stage}… ${Math.round(value * 100)}%`;
}

function showProgress(stage, value) {
  ui.overlay.hidden = false;
  ui.stage.textContent = stage;
  ui.progress.style.width = `${Math.round(value * 100)}%`;
}

// The detected tempo, its double and half, and the other candidates, slowest first.
function populateTempoOptions(candidates) {
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
  ui.tempoSelect.replaceChildren(
    ...options.map(({ value, bpm }) => new Option(`${Math.round(bpm)} BPM${value === '0:1' ? ' (detected)' : ''}`, value)),
  );
  if (!options.length) ui.tempoSelect.append(new Option('120 BPM (no clear beat)', '0:1'));
  settings.tempo = ui.tempoSelect.value = '0:1';
  settings.halfBeat = ui.halfBeat.checked = false;
}

// Rebuilds the beat grid and re-decodes chords from the cached analysis; cheap enough to run
// on every slider move.
function refresh() {
  if (!analysis) return;
  const { duration, tempoCandidates } = analysis;
  const [index, mult] = settings.tempo.split(':').map(Number);
  const candidate = tempoCandidates[index] ?? null;
  const beats = buildBeats(candidate, { mult, half: settings.halfBeat }, duration);
  const frames = settings.source === 'harmony' && analysis.harmony ? analysis.harmony : analysis;
  grid = { duration, beats, ...beatSync(beats, duration, frames) };
  key ??= detectKey(grid);

  const { chords, phase } = decodeChords(grid, settings);
  const shownKey = transposeKey(key, settings.transpose);
  song = {
    phase,
    chords: chords.map((c) => {
      const root = transposeRoot(c.root, settings.transpose);
      // The synth and note graph use the untransposed chord so it can be checked against the recording.
      return {
        ...c,
        root,
        label: chordLabel(root, c.quality, shownKey),
        voicing: chordVoicing(c.root, c.quality),
        tones: c.root < 0 ? [] : QUALITIES[c.quality].intervals.map((iv) => (c.root + iv) % 12),
      };
    }),
  };
  timeline.setData({
    duration,
    beats,
    phase,
    beatsPerBar: settings.beatsPerBar,
    chords: song.chords,
    peaks: analysis.peaks,
    peaksPerSec: analysis.peaksPerSec,
  });
  noteGraph.setData({ frameTimes: frames.frameTimes, chroma: frames.treble, names: noteNames(key) });
  ui.notesLabel.textContent = frames === analysis ? 'Notes in the audio' : 'Notes in the harmony';

  ui.key.textContent = `Key: ${keyLabel(shownKey)}`;
  ui.tempo.textContent = `${Math.round(candidate ? candidate.bpm * mult : 120)} BPM`;
  ui.key.hidden = ui.tempo.hidden = false;
  ui.trValue.textContent = settings.transpose > 0 ? `+${settings.transpose}` : String(settings.transpose);
  ui.barDots.replaceChildren(
    ...Array.from({ length: settings.beatsPerBar }, () => document.createElement('span')),
  );
  shown = {};
  resetSchedule();
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
  const { chords, phase } = song;
  const ci = indexAt(chords, t, (c) => c.start);
  const beat = indexAt(grid.beats, t);
  const next = chords[ci + 1];

  if (ci !== shown.chord) {
    ui.now.textContent = ci >= 0 ? chords[ci].label : '–';
    ui.next.textContent = next ? next.label : '–';
    shown.chord = ci;
  }

  const beatsLeft = next && beat >= 0 ? next.startBeat - beat : null;
  if (beatsLeft !== shown.beatsLeft) {
    ui.nextIn.textContent = beatsLeft == null ? '' : `in ${beatsLeft} beat${beatsLeft === 1 ? '' : 's'}`;
    shown.beatsLeft = beatsLeft;
  }

  const pos = beat >= 0 ? beatInBar(beat, phase, settings.beatsPerBar) : -1;
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
  metronome.stopAll();
}

// Schedules clicks on every beat, and chord strikes on each chord's first beat and on every
// downbeat while it lasts, on the AudioContext clock so they land exactly on the grid.
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
  const { chords, phase } = song;
  const chordAt = (t) => chords[indexAt(chords, t, (c) => c.start)];
  if (scheduledUntil === null) {
    synth.play(chordAt(songNow)?.voicing ?? [], audioCtx.currentTime);
    scheduledUntil = songNow;
  }
  const until = songNow + LOOKAHEAD * rate;
  for (let i = indexAt(beats, scheduledUntil) + 1; i < beats.length && beats[i] <= until; i++) {
    const when = Math.max(audioCtx.currentTime, offset + beats[i] / rate);
    const downbeat = beatInBar(i, phase, settings.beatsPerBar) === 0;
    metronome.click(when, downbeat);
    const chord = chordAt(beats[i]);
    if (chord && (chord.startBeat === i || downbeat)) synth.play(chord.voicing, when);
  }
  scheduledUntil = until;
}

function frame() {
  if (song) {
    const t = playbackTime();
    timeline.setTime(t);
    updatePanel(t);
    schedule();
    noteGraph.update(t, song.chords[indexAt(song.chords, t, (c) => c.start)]?.tones);
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
