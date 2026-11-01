import './style.css';
import { decodeToMono } from './audio.js';
import {
  beatInBar,
  chordLabel,
  decodeChords,
  detectKey,
  indexAt,
  keyLabel,
  transposeKey,
  transposeRoot,
} from './analysis/chords.js';
import { Timeline } from './view/timeline.js';

const ANALYSIS_SAMPLE_RATE = 22050;

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const ui = {
  file: $('file'),
  title: $('song-title'),
  key: $('key'),
  tempo: $('tempo'),
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

const settings = { vocabulary: 'sevenths', smoothing: 5, beatsPerBar: 4, transpose: 0 };
let analysis = null; // worker output, independent of the settings above
let key = null;
let song = null; // decoded chords with display labels
let worker = null;
let objectUrl = null;

const timeline = new Timeline($('timeline'), {
  onSeek: seek,
  onZoom: (pxPerSec) => (ui.zoom.value = pxPerSec),
});

// ---------- Loading & analysis ----------

async function loadFile(file) {
  if (!file) return;
  ui.dropError.hidden = true;
  showProgress('Decoding audio…', 0);
  audio.pause();
  try {
    const samples = await decodeToMono(await file.arrayBuffer(), ANALYSIS_SAMPLE_RATE);
    analysis = await runAnalysis(samples);
    key = detectKey(analysis);

    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    audio.src = objectUrl;
    audio.playbackRate = Number(ui.speed.value);
    ui.title.textContent = file.name.replace(/\.[^.]+$/, '');
    ui.dropzone.hidden = true;
    ui.player.hidden = false;
    refresh();
    seek(0);
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

function runAnalysis(samples) {
  worker?.terminate();
  worker = new Worker(new URL('./analysis/worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') showProgress(`${data.stage}…`, data.value);
      else if (data.type === 'result') resolve(data.result);
      else reject(new Error(data.message));
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Analysis worker failed'));
    worker.postMessage({ samples, sampleRate: ANALYSIS_SAMPLE_RATE }, [samples.buffer]);
  });
}

function showProgress(stage, value) {
  ui.overlay.hidden = false;
  ui.stage.textContent = stage;
  ui.progress.style.width = `${Math.round(value * 100)}%`;
}

// Re-decodes chords from the cached analysis; cheap enough to run on every slider move.
function refresh() {
  if (!analysis) return;
  const { chords, phase } = decodeChords(analysis, settings);
  const shownKey = transposeKey(key, settings.transpose);
  song = {
    phase,
    chords: chords.map((c) => {
      const root = transposeRoot(c.root, settings.transpose);
      return { ...c, root, label: chordLabel(root, c.quality, shownKey) };
    }),
  };
  timeline.setData({
    duration: analysis.duration,
    beats: analysis.beats,
    phase,
    beatsPerBar: settings.beatsPerBar,
    chords: song.chords,
    peaks: analysis.peaks,
    peaksPerSec: analysis.peaksPerSec,
  });

  ui.key.textContent = `Key: ${keyLabel(shownKey)}`;
  ui.tempo.textContent = `${Math.round(analysis.tempo)} BPM`;
  ui.key.hidden = ui.tempo.hidden = false;
  ui.trValue.textContent = settings.transpose > 0 ? `+${settings.transpose}` : String(settings.transpose);
  ui.barDots.replaceChildren(
    ...Array.from({ length: settings.beatsPerBar }, () => document.createElement('span')),
  );
  shown = {};
}

// ---------- Playback ----------

function seek(t) {
  if (!analysis) return;
  const clamped = Math.max(0, Math.min(analysis.duration, t));
  audio.currentTime = clamped;
  lastAudioTime = -1;
  timeline.setTime(clamped);
}

function togglePlay() {
  if (!analysis) return;
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
  const beat = indexAt(analysis.beats, t);
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

function frame() {
  if (song) {
    const t = playbackTime();
    timeline.setTime(t);
    updatePanel(t);
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
ui.zoom.addEventListener('input', () => timeline.setZoom(Number(ui.zoom.value)));
ui.speed.addEventListener('change', () => (audio.playbackRate = Number(ui.speed.value)));
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
