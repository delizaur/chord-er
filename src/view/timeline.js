import { beatInBar, indexAt } from '../analysis/chords.js';

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
};

// Hue follows the circle of fifths so harmonically close chords look alike.
function chordColor(root, quality, active) {
  if (root < 0) return active ? '#3a3f4d' : '#262a34';
  const hue = ((root * 7) % 12) * 30;
  const minorish = quality === 'min' || quality === 'm7' || quality === 'dim';
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

  setData(data) {
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

    const { duration, beats, phase, beatsPerBar, chords, peaks, peaksPerSec } = this.data;
    const t0 = this.xToTime(0);
    const t1 = this.xToTime(W);
    const chordTop = RULER_HEIGHT + 6;
    const chordHeight = Math.round((H - chordTop) * 0.55);
    const waveTop = chordTop + chordHeight + 12;
    const waveHeight = H - waveTop - 8;

    // Areas before the start / after the end of the song.
    ctx.fillStyle = COLORS.outside;
    if (t0 < 0) ctx.fillRect(0, 0, this.timeToX(0), H);
    if (t1 > duration) ctx.fillRect(this.timeToX(duration), 0, W, H);

    // Beat grid and bar numbers.
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let i = Math.max(0, indexAt(beats, t0)); i < beats.length && beats[i] <= t1; i++) {
      const x = Math.round(this.timeToX(beats[i])) + 0.5;
      const isBar = beatInBar(i, phase, beatsPerBar) === 0;
      ctx.strokeStyle = isBar ? COLORS.bar : COLORS.beat;
      ctx.beginPath();
      ctx.moveTo(x, isBar ? 4 : chordTop);
      ctx.lineTo(x, H);
      ctx.stroke();
      if (isBar) {
        ctx.fillStyle = COLORS.rulerText;
        ctx.fillText(String(Math.floor((i - phase) / beatsPerBar) + 1), x + 5, RULER_HEIGHT / 2 + 2);
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
    ctx.fillStyle = COLORS.playhead;
    ctx.fillRect(this.playX - 1, 0, 2, H);
    ctx.beginPath();
    ctx.moveTo(this.playX - 6, 0);
    ctx.lineTo(this.playX + 6, 0);
    ctx.lineTo(this.playX, 8);
    ctx.fill();
  }

  // The label sticks to the left edge while its chord scrolls out of view.
  drawLabel(chord, x0, x1, top, height) {
    const { ctx } = this;
    const width = x1 - x0;
    const size = Math.min(30, height * 0.42, Math.max(11, width * 0.45));
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    const textWidth = ctx.measureText(chord.label).width;
    const pad = 10;
    const x = Math.min(Math.max(x0 + pad, pad), x1 - textWidth - pad);
    if (x < x0 + 2) return;
    ctx.fillStyle = chord.root < 0 ? 'rgba(255,255,255,0.4)' : COLORS.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(chord.label, x, top + height / 2);
  }
}
