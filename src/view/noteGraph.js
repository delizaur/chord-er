import { indexAt } from '../analysis/chords.js';

const LABEL_HEIGHT = 20;
const EASING = 0.35; // per-frame approach toward the target level

const COLORS = {
  bar: '#4a5470',
  chordTone: '#ffcc4d',
  bass: '#4fc3f7',
  track: 'rgba(255,255,255,0.04)',
  label: 'rgba(255,255,255,0.5)',
};

// Live bar graph of the 12 pitch-class strengths at the playback position.
// Chord tones of the current chord are highlighted, and the current bass note in its own color.
export class NoteGraph {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = null;
    this.levels = new Float64Array(12);
    this.tones = [];
    this.bass = -1;
    this.width = 0;
    this.height = 0;
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  // `chroma` holds 12 values per frame at `frameTimes`.
  setData({ frameTimes, chroma, names }) {
    // Frames quieter than the loud parts of the song are drawn shorter.
    const maxima = [];
    for (let f = 0; f < frameTimes.length; f++) {
      maxima.push(Math.max(...chroma.subarray(f * 12, f * 12 + 12)));
    }
    maxima.sort((a, b) => a - b);
    const reference = maxima[Math.floor(0.95 * (maxima.length - 1))] || 1;
    this.data = { frameTimes, chroma, names, floor: 0.25 * reference };
    this.draw();
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

  update(t, tones = [], bass = -1) {
    if (!this.data) return;
    const { frameTimes, chroma, floor } = this.data;
    const target = new Float64Array(12);

    // Linear interpolation between the two frames around t.
    const f = Math.max(0, indexAt(frameTimes, t));
    const g = Math.min(frameTimes.length - 1, f + 1);
    const span = frameTimes[g] - frameTimes[f];
    const w = span > 0 ? Math.max(0, Math.min(1, (t - frameTimes[f]) / span)) : 0;
    let max = 0;
    for (let c = 0; c < 12; c++) {
      target[c] = (1 - w) * chroma[f * 12 + c] + w * chroma[g * 12 + c];
      max = Math.max(max, target[c]);
    }
    const scale = 1 / Math.max(max, floor);
    for (let c = 0; c < 12; c++) this.levels[c] += (target[c] * scale - this.levels[c]) * EASING;

    this.tones = tones;
    this.bass = bass;
    this.draw();
  }

  draw() {
    const { ctx, width: W, height: H } = this;
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);
    if (!this.data) return;

    const slot = W / 12;
    const barWidth = Math.max(4, slot * 0.62);
    const barArea = H - LABEL_HEIGHT;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let c = 0; c < 12; c++) {
      const x = c * slot + (slot - barWidth) / 2;
      const isTone = this.tones.includes(c);
      const isBass = c === this.bass;
      const color = isBass ? COLORS.bass : isTone ? COLORS.chordTone : null;
      ctx.fillStyle = COLORS.track;
      ctx.fillRect(x, 0, barWidth, barArea);
      const h = Math.max(2, Math.min(1, this.levels[c]) * barArea);
      ctx.fillStyle = color ?? COLORS.bar;
      ctx.beginPath();
      ctx.roundRect(x, barArea - h, barWidth, h, [3, 3, 0, 0]);
      ctx.fill();

      ctx.fillStyle = color ?? COLORS.label;
      ctx.font = `${c === this.tones[0] ? 800 : 600} 11px system-ui, sans-serif`;
      ctx.fillText(this.data.names[c], c * slot + slot / 2, barArea + LABEL_HEIGHT / 2 + 1);
    }
  }
}
