import { indexAt } from '../analysis/chords.js';

const PLAYHEAD_RATIO = 0.25; // playhead position as a fraction of the width
const RULER_HEIGHT = 22;

const COLORS = {
  background: '#11131a',
  outside: '#0b0c10',
  beat: 'rgba(255,255,255,0.06)',
  bar: 'rgba(255,255,255,0.2)',
  rulerText: 'rgba(255,255,255,0.45)',
  past: 'rgba(11,12,16,0.5)',
  wavePlayed: '#4f5a73',
  waveAhead: '#8a97b8',
  playhead: '#ffcc4d',
  text: '#ffffff',
  chromaRule: 'rgba(255,255,255,0.05)',
  chromaLabels: 'rgba(17,19,26,0.8)',
  chordTone: 'rgba(255,204,77,0.45)',
  bassTone: 'rgba(79,195,247,0.55)',
};

// Chromagram brightness: from the timeline's background (silent) to white. The chord-tone and bass
// overlays add the only tint.
const CHROMA_DARK = [17, 19, 26]; // COLORS.background
const CHROMA_LIGHT = [245, 245, 245];

// Renders the chromagram once into a 12-pixel-tall image, one column per frame and C on the
// bottom row. Each frame is scaled to its loudest note, so the brightest note of every moment
// stands out, except that frames much quieter than the song's loud parts stay dim. Also returns
// those per-frame levels (0–1), which light up the note names.
function renderChroma({ frameTimes, values }) {
  const n = frameTimes.length;
  const maxima = Array.from({ length: n }, (_, f) => Math.max(...values.subarray(f * 12, f * 12 + 12)));
  const reference = [...maxima].sort((a, b) => a - b)[Math.floor(0.95 * (n - 1))] || 1;
  const floor = 0.25 * reference;
  const canvas = document.createElement('canvas');
  canvas.width = n;
  canvas.height = 12;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(n, 12);
  const levels = new Float32Array(n * 12);
  for (let f = 0; f < n; f++) {
    const scale = 1 / Math.max(maxima[f], floor);
    for (let c = 0; c < 12; c++) {
      const v = Math.min(1, values[f * 12 + c] * scale) ** 1.5;
      levels[f * 12 + c] = v;
      const i = ((11 - c) * n + f) * 4;
      for (let k = 0; k < 3; k++) image.data[i + k] = CHROMA_DARK[k] + (CHROMA_LIGHT[k] - CHROMA_DARK[k]) * v;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { canvas, levels, start: frameTimes[0], step: n > 1 ? frameTimes[1] - frameTimes[0] : 1 };
}

// Hue follows the circle of fifths so harmonically close chords look alike.
function chordColor(root, quality, active) {
  if (root < 0) return active ? '#3a3f4d' : '#262a34';
  const hue = ((root * 7) % 12) * 30;
  const minorish = ['min', 'm7', 'm9', 'm6', 'm7b5', 'dim'].includes(quality);
  const sat = minorish ? 38 : 55;
  const light = (minorish ? 30 : 38) + (active ? 14 : 0);
  return `hsl(${hue} ${sat}% ${light}%)`;
}

// Canvas view that scrolls the song past a fixed playhead.
export class Timeline {
  constructor(canvas, { onSeek, onZoom }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSeek = onSeek;
    this.onZoom = onZoom;
    this.pxPerSec = 110;
    this.time = 0;
    this.data = null;
    this.width = 0;
    this.height = 0;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.bindInput();
  }

  // `data.chroma` is { frameTimes, values (12 per frame), names }; `data.bass` the bass line as
  // [{ start, pc }], which also splits the chord-tone overlay.
  setData(data) {
    if (data.chroma.values !== this.chromaValues) {
      this.chromaValues = data.chroma.values;
      this.chromaImage = renderChroma(data.chroma);
    }
    this.data = data;
    this.draw();
  }

  setTime(t) {
    if (t === this.time) return;
    this.time = t;
    this.draw();
  }

  setZoom(pxPerSec) {
    this.pxPerSec = Math.max(30, Math.min(320, pxPerSec));
    this.draw();
  }

  get playX() {
    return Math.round(this.width * PLAYHEAD_RATIO);
  }

  timeToX(t) {
    return this.playX + (t - this.time) * this.pxPerSec;
  }

  xToTime(x) {
    return this.time + (x - this.playX) / this.pxPerSec;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  bindInput() {
    const { canvas } = this;
    let drag = null;

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      drag = { x: e.offsetX, time: this.time, moved: false };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.offsetX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      if (drag.moved) this.onSeek(drag.time - dx / this.pxPerSec);
    });
    canvas.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved) this.onSeek(this.xToTime(e.offsetX));
      drag = null;
    });
    canvas.addEventListener('pointercancel', () => (drag = null));

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.ctrlKey) {
          this.setZoom(this.pxPerSec * Math.exp(-e.deltaY * 0.002));
          this.onZoom(this.pxPerSec);
        } else {
          this.onSeek(this.time + (e.deltaX || e.deltaY) / this.pxPerSec);
        }
      },
      { passive: false },
    );
  }

  draw() {
    const { ctx, width: W, height: H } = this;
    if (!W || !H) return;
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, W, H);
    if (!this.data) return;

    const { duration, beats, bars, chords, peaks, peaksPerSec } = this.data;
    const t0 = this.xToTime(0);
    const t1 = this.xToTime(W);
    // Rows: ruler, chords, chromagram, waveform.
    const chordTop = RULER_HEIGHT + 6;
    const room = H - chordTop - 8;
    const chordHeight = Math.round(Math.min(90, Math.max(56, room * 0.3)));
    const waveHeight = Math.round(Math.min(56, Math.max(28, room * 0.16)));
    const chromaTop = chordTop + chordHeight + 8;
    const chromaHeight = Math.max(24, room - chordHeight - waveHeight - 16);
    const waveTop = chromaTop + chromaHeight + 8;

    // Areas before the start / after the end of the song.
    ctx.fillStyle = COLORS.outside;
    if (t0 < 0) ctx.fillRect(0, 0, this.timeToX(0), H);
    if (t1 > duration) ctx.fillRect(this.timeToX(duration), 0, W, H);

    this.drawChroma(chromaTop, chromaHeight, t0, t1);

    // Beat grid and bar numbers.
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let i = Math.max(0, indexAt(beats, t0)); i < beats.length && beats[i] <= t1; i++) {
      const x = Math.round(this.timeToX(beats[i])) + 0.5;
      const isBar = bars.pos[i] === 0;
      ctx.strokeStyle = isBar ? COLORS.bar : COLORS.beat;
      ctx.beginPath();
      ctx.moveTo(x, isBar ? 4 : chordTop);
      ctx.lineTo(x, H);
      ctx.stroke();
      if (isBar) {
        ctx.fillStyle = COLORS.rulerText;
        ctx.fillText(String(bars.number[i]), x + 5, RULER_HEIGHT / 2 + 2);
      }
    }

    // Chord blocks.
    const current = indexAt(chords, this.time, (c) => c.start);
    const first = Math.max(0, indexAt(chords, t0, (c) => c.start));
    for (let i = first; i < chords.length && chords[i].start <= t1; i++) {
      const c = chords[i];
      const x0 = this.timeToX(c.start) + 1;
      const x1 = this.timeToX(c.end) - 1;
      if (x1 <= x0) continue;
      const active = i === current;
      ctx.fillStyle = chordColor(c.root, c.quality, active);
      ctx.beginPath();
      ctx.roundRect(x0, chordTop, x1 - x0, chordHeight, 8);
      ctx.fill();
      if (active) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      this.drawLabel(c, x0, x1, chordTop, chordHeight);
    }

    // Waveform overview.
    const mid = waveTop + waveHeight / 2;
    for (const [from, to, color] of [
      [0, this.playX, COLORS.wavePlayed],
      [this.playX, W, COLORS.waveAhead],
    ]) {
      ctx.fillStyle = color;
      for (let x = from; x < to; x++) {
        const a = Math.floor(this.xToTime(x) * peaksPerSec);
        const b = Math.max(a + 1, Math.floor(this.xToTime(x + 1) * peaksPerSec));
        if (b <= 0 || a >= peaks.length) continue;
        let peak = 0;
        for (let k = Math.max(0, a); k < Math.min(peaks.length, b); k++) peak = Math.max(peak, peaks[k]);
        const h = Math.max(1, peak * waveHeight * 0.5);
        ctx.fillRect(x, mid - h, 1, 2 * h);
      }
    }

    // Dim what has already been played, then the playhead.
    ctx.fillStyle = COLORS.past;
    ctx.fillRect(0, chordTop, this.playX, chordHeight);
    ctx.fillRect(0, chromaTop, this.playX, chromaHeight);
    ctx.fillStyle = COLORS.playhead;
    ctx.fillRect(this.playX - 1, 0, 2, H);
    ctx.beginPath();
    ctx.moveTo(this.playX - 6, 0);
    ctx.lineTo(this.playX + 6, 0);
    ctx.lineTo(this.playX, 8);
    ctx.fill();
  }

  // The chromagram, the detected chord tones (yellow) and bass note (blue) over it, and the note
  // names along the left edge.
  drawChroma(top, height, t0, t1) {
    const { ctx } = this;
    const { chords, bass, duration, chroma } = this.data;
    const rowHeight = height / 12;
    const rowY = (pc) => top + (11 - pc) * rowHeight;

    const { canvas: image, levels, start, step } = this.chromaImage;
    const from = Math.max(t0, start - step / 2, 0);
    const to = Math.min(t1, duration, start + (image.width - 0.5) * step);
    if (to > from) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, (from - start) / step + 0.5, 0, (to - from) / step, 12, this.timeToX(from), top, (to - from) * this.pxPerSec, height);
      ctx.imageSmoothingEnabled = true;
    }

    // Per bass segment: the chord sounding at its start supplies the tones.
    for (let i = Math.max(0, indexAt(bass, t0, (b) => b.start)); i < bass.length && bass[i].start <= t1; i++) {
      const end = i + 1 < bass.length ? bass[i + 1].start : duration;
      const x0 = this.timeToX(bass[i].start);
      const w = this.timeToX(end) - x0;
      const chord = chords[indexAt(chords, bass[i].start + 1e-6, (c) => c.start)];
      ctx.fillStyle = COLORS.chordTone;
      for (const pc of chord?.tones ?? []) if (pc !== bass[i].pc) ctx.fillRect(x0, rowY(pc), w, rowHeight);
      if (bass[i].pc >= 0) {
        ctx.fillStyle = COLORS.bassTone;
        ctx.fillRect(x0, rowY(bass[i].pc), w, rowHeight);
      }
    }

    ctx.fillStyle = COLORS.chromaRule;
    for (let pc = 1; pc < 12; pc++) ctx.fillRect(0, Math.round(rowY(pc) + rowHeight) - 0.5, this.width, 1);

    if (rowHeight < 7) return;
    ctx.fillStyle = COLORS.chromaLabels;
    ctx.fillRect(0, top, 26, height);
    // Each name is as bright as its note at the playhead.
    const frame = Math.round((this.time - start) / step);
    const inSong = frame >= 0 && frame < image.width;
    ctx.font = `600 ${Math.min(10, rowHeight - 1)}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    chroma.names.forEach((name, pc) => {
      const level = inSong ? levels[frame * 12 + pc] : 0;
      ctx.fillStyle = `rgba(255,255,255,${0.3 + 0.7 * level})`;
      ctx.fillText(name, 5, rowY(pc) + rowHeight / 2 + 0.5);
    });
  }

  // The label sticks to the left edge while its chord scrolls out of view.
  drawLabel(chord, x0, x1, top, height) {
    const { ctx } = this;
    const pad = 8;
    const room = x1 - x0 - 2 * pad;
    // Shrink the font to fit short chords, down to a legible minimum; a slash chord that still
    // doesn't fit shows just its bass note ("/E").
    let label = chord.label;
    let size;
    let textWidth;
    for (const candidate of label.includes('/') ? [label, label.slice(label.indexOf('/'))] : [label]) {
      label = candidate;
      size = Math.min(30, height * 0.42);
      ctx.font = `700 ${size}px system-ui, sans-serif`;
      textWidth = ctx.measureText(label).width;
      if (textWidth > room) {
        size = Math.max(10, (size * room) / textWidth);
        ctx.font = `700 ${size}px system-ui, sans-serif`;
        textWidth = ctx.measureText(label).width;
      }
      if (textWidth <= room) break;
    }
    const x = Math.min(Math.max(x0 + pad, pad), x1 - textWidth - pad);
    if (x < x0 + 2) return;
    ctx.fillStyle = chord.root < 0 ? 'rgba(255,255,255,0.4)' : COLORS.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, top + height / 2);
  }
}
