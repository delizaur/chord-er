import { indexAt, QUALITIES } from '../analysis/chords.js';

const PLAYHEAD_RATIO = 0.25; // playhead position as a fraction of the width
const RULER_HEIGHT = 22;
const EDGE_GRAB = 6; // px around the boundary between two chords that grab it for resizing
const DRAG_START = 3; // px the pointer moves before a press becomes a drag

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
  selected: '#ffcc4d',
  marquee: 'rgba(255,204,77,0.12)',
  range: 'rgba(255,204,77,0.08)',
  rangeRuler: 'rgba(255,204,77,0.35)',
  remove: '#e05a5a',
  frozen: '#ffffff',
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

// Hue follows the circle of fifths so harmonically close chords look alike; chords with a minor
// third and no major one are darker. Frozen chords are paler, nearer white.
function chordColor(root, quality, sounding, frozen) {
  if (root < 0) return frozen ? (sounding ? '#5a5f6c' : '#474b57') : sounding ? '#3a3f4d' : '#262a34';
  const hue = ((root * 7) % 12) * 30;
  const intervals = QUALITIES[quality]?.intervals ?? [];
  const minorish = intervals.includes(3) && !intervals.includes(4);
  const sat = (minorish ? 38 : 55) * (frozen ? 0.6 : 1);
  const light = (minorish ? 30 : 38) + (sounding ? 14 : 0) + (frozen ? 20 : 0);
  return `hsl(${hue} ${sat}% ${light}%)`;
}

// Canvas view that scrolls the song past a fixed playhead: the chord timeline, the chromagram and
// the waveform. Chords (frozen or not; each has a selection `key`) are selected with clicks and
// marquees, moved by dragging, deleted by dragging them off the timeline, and resized by dragging
// the boundary between two chords; a double click freezes or unfreezes a chord, and a click on the
// chromagram turns that note on or off in the chord there. Edits go to `onEdit`.
export class Timeline {
  constructor(canvas, { onSeek, onZoom, onEdit, onSelect }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSeek = onSeek;
    this.onZoom = onZoom;
    this.onEdit = onEdit;
    this.onSelect = onSelect;
    this.shownSelection = '';
    this.pxPerSec = 110;
    this.time = 0;
    this.data = null;
    this.selected = new Set();
    this.range = null; // the selected duration, { start, end }, chosen on the ruler
    this.gesture = null;
    this.width = 0;
    this.height = 0;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.bindInput();
  }

  // Merges `data` into the shown data: { duration, beats, bars, chords, overlay: { chords, bass }
  // (for the chromagram), chroma: { frameTimes, values, names }, peaks, peaksPerSec }.
  setData(data) {
    if (data.chroma && data.chroma.values !== this.chromaValues) {
      this.chromaValues = data.chroma.values;
      this.chromaImage = renderChroma(data.chroma);
    }
    // Chords that are gone (rebuilt by a settings change, or frozen) leave the selection.
    if (data.chords) {
      const keys = new Set(data.chords.map((c) => c.key));
      for (const key of [...this.selected]) if (!keys.has(key)) this.selected.delete(key);
    }
    this.data = { ...this.data, ...data };
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

  select(keys = []) {
    this.selected = new Set(keys);
    this.draw();
  }

  // Clears the selected chords and the selected duration.
  clearSelection() {
    this.selected.clear();
    this.range = null;
    this.draw();
  }

  selectedKeys() {
    return [...this.selected];
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

  // The nearest beat to `t`, within the song.
  snap(t) {
    const { beats, duration } = this.data;
    const i = indexAt(beats, t);
    let best = i < 0 ? beats[0] : beats[i];
    if (i + 1 < beats.length && (i < 0 || beats[i + 1] - t < t - beats[i])) best = beats[i + 1];
    return Math.max(0, Math.min(duration, best ?? t));
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

  // Rows from the top: ruler, chords, chromagram, waveform.
  layout() {
    const H = this.height;
    const chordsTop = RULER_HEIGHT + 6;
    const room = H - chordsTop - 8;
    const rowHeight = Math.round(Math.min(80, Math.max(44, room * 0.24)));
    const waveHeight = Math.round(Math.min(56, Math.max(28, room * 0.14)));
    const chromaTop = chordsTop + rowHeight + 8;
    const chromaHeight = Math.max(24, room - rowHeight - waveHeight - 16);
    const waveTop = chromaTop + chromaHeight + 8;
    return {
      chords: { top: chordsTop, height: rowHeight },
      chroma: { top: chromaTop, height: chromaHeight },
      wave: { top: waveTop, height: waveHeight },
    };
  }

  onChords(y) {
    const { chords } = this.layout();
    return y >= chords.top && y < chords.top + chords.height;
  }

  // The chord sounding at `t`, or null.
  chordAt(t) {
    return this.data.chords[indexAt(this.data.chords, t, (c) => c.start)] ?? null;
  }

  // The chord box under (x, y), or null.
  boxAt(x, y) {
    if (!this.data || !this.onChords(y)) return null;
    const item = this.chordAt(this.xToTime(x));
    return item && this.timeToX(item.end) >= x ? item : null;
  }

  // The boundary between two chords within reach of (x, y): { left, right, from }, or null.
  edgeAt(x, y) {
    if (!this.onChords(y)) return null;
    const { chords } = this.data;
    let best = null;
    for (let i = Math.max(1, indexAt(chords, this.xToTime(x - EDGE_GRAB), (c) => c.start)); i < chords.length; i++) {
      const distance = Math.abs(this.timeToX(chords[i].start) - x);
      if (this.timeToX(chords[i].start) > x + EDGE_GRAB) break;
      if (distance <= EDGE_GRAB && (!best || distance < best.distance)) best = { left: chords[i - 1], right: chords[i], from: chords[i].start, distance };
    }
    return best;
  }

  // On the chromagram: { time, pc } of the note under (x, y), or null.
  noteAt(x, y) {
    const { chroma } = this.layout();
    if (y < chroma.top || y >= chroma.top + chroma.height) return null;
    return { time: this.xToTime(x), pc: 11 - Math.floor(((y - chroma.top) * 12) / chroma.height) };
  }

  selectedItems() {
    return this.data.chords.filter((c) => this.selected.has(c.key));
  }

  // Where dragged chords land, shifted by `dt` and with each edge snapped to the nearest beat.
  landing(items, dt) {
    return items
      .map((item) => ({ item, start: this.snap(item.start + dt), end: this.snap(item.end + dt) }))
      .filter((p) => p.end > p.start);
  }

  bindInput() {
    const { canvas } = this;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // Keep the middle button from starting the browser's autoscroll.
    canvas.addEventListener('mousedown', (e) => e.button === 1 && e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.data) return;
      canvas.setPointerCapture(e.pointerId);
      const { offsetX: x, offsetY: y } = e;
      const { wave } = this.layout();
      if (e.button === 2) {
        this.clearSelection();
        return;
      }
      if (e.button === 1) {
        this.gesture = { type: 'pan', x, time: this.time };
      } else if (e.button === 0) {
        if (y < RULER_HEIGHT) {
          // The ruler selects a duration, from beat to beat; a click (no drag) seeks there.
          const at = this.snap(this.xToTime(x));
          this.gesture = { type: 'range', x, from: at, to: at, moved: false };
          return;
        }
        if (y >= wave.top) {
          // The waveform seeks: click to jump, drag to scrub.
          this.gesture = { type: 'seek', x, time: this.time, moved: false };
          return;
        }
        const edge = this.edgeAt(x, y);
        const box = this.boxAt(x, y);
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        if (edge) {
          this.gesture = { type: 'resize', ...edge, time: edge.from };
        } else if (box) {
          if (!this.selected.has(box.key) && !additive) this.selected.clear();
          const wasSelected = this.selected.has(box.key);
          this.selected.add(box.key);
          this.gesture = { type: 'press', x, y, box, additive, wasSelected, grabTime: this.xToTime(x) };
        } else {
          this.gesture = { type: 'marquee', x, y, x1: x, y1: y, time: this.xToTime(x), additive };
        }
      }
      this.draw();
    });

    canvas.addEventListener('pointermove', (e) => {
      const { offsetX: x, offsetY: y } = e;
      const g = this.gesture;
      if (!g) {
        this.updateCursor(x, y);
        return;
      }
      if (g.type === 'pan' || g.type === 'seek') {
        if (Math.abs(x - g.x) > DRAG_START) g.moved = true;
        if (g.type === 'pan' || g.moved) this.onSeek(g.time - (x - g.x) / this.pxPerSec);
      } else if (g.type === 'range') {
        if (Math.abs(x - g.x) > DRAG_START) g.moved = true;
        g.to = this.snap(this.xToTime(x));
      } else if (g.type === 'press') {
        if (Math.hypot(x - g.x, y - g.y) > DRAG_START) {
          this.gesture = { type: 'drag', items: this.selectedItems(), grabTime: g.grabTime, x, y };
        }
      } else if (g.type === 'drag') {
        Object.assign(g, { x, y });
      } else if (g.type === 'marquee') {
        Object.assign(g, { x1: x, y1: y });
      } else if (g.type === 'resize') {
        // The boundary stays inside the two chords it separates.
        const t = e.shiftKey ? this.xToTime(x) : this.snap(this.xToTime(x));
        g.time = Math.max(g.left.start + 0.05, Math.min(t, g.right.end - 0.05));
      }
      this.draw();
    });

    canvas.addEventListener('pointerup', (e) => {
      const g = this.gesture;
      this.gesture = null;
      if (!g) return;
      const { offsetX: x, offsetY: y } = e;
      if (g.type === 'seek' && !g.moved) this.onSeek(this.xToTime(x));
      else if (g.type === 'range') this.finishRange(g, x);
      else if (g.type === 'press') {
        // A click on a chord selects just it; with Shift/Ctrl it toggles it in the selection.
        if (g.additive) {
          if (g.wasSelected) this.selected.delete(g.box.key);
        } else this.selected = new Set([g.box.key]);
      } else if (g.type === 'marquee') {
        // A click (no drag) on the chromagram edits the notes of the chord there.
        const note = Math.hypot(x - g.x, y - g.y) <= DRAG_START ? this.noteAt(x, y) : null;
        if (note && this.chordAt(note.time)) this.onEdit({ type: 'toggle', ...note });
        else this.finishMarquee(g);
      } else if (g.type === 'drag') this.finishDrag(g, y);
      else if (g.type === 'resize' && Math.abs(g.time - g.from) > 1e-6) {
        this.onEdit({ type: 'resize', left: g.left.key, right: g.right.key, from: g.from, time: g.time });
      }
      this.updateCursor(x, y);
      this.draw();
    });
    // Double-clicking a chord freezes or unfreezes it.
    canvas.addEventListener('dblclick', (e) => {
      const box = this.boxAt(e.offsetX, e.offsetY);
      if (box) this.select(this.onEdit({ type: 'freeze', keys: [box.key] }));
    });
    canvas.addEventListener('pointercancel', () => {
      this.gesture = null;
      this.draw();
    });

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

  updateCursor(x, y) {
    if (!this.data) return;
    const { wave } = this.layout();
    let cursor = 'default';
    if (y < RULER_HEIGHT) cursor = 'text';
    else if (y >= wave.top) cursor = 'pointer';
    else if (this.edgeAt(x, y)) cursor = 'ew-resize';
    else if (this.noteAt(x, y) && this.chordAt(this.xToTime(x))) cursor = 'pointer';
    else if (this.boxAt(x, y)) cursor = 'grab';
    this.canvas.style.cursor = cursor;
  }

  // Selects the dragged duration and the chords inside it, or for a click, clears it and seeks.
  finishRange(g, x) {
    const [start, end] = [Math.min(g.from, g.to), Math.max(g.from, g.to)];
    if (!g.moved || end - start < 0.05) {
      this.range = null;
      this.onSeek(this.xToTime(x));
      return;
    }
    this.range = { start, end };
    const inside = this.data.chords.filter((c) => c.start >= start - 0.02 && c.end <= end + 0.02);
    this.selected = new Set(inside.map((c) => c.key));
  }

  // Selects the chords the marquee touches.
  finishMarquee(g) {
    const { chords } = this.layout();
    if (!g.additive) this.selected.clear();
    const [left, right] = [Math.min(g.x, g.x1), Math.max(g.x, g.x1)];
    const [top, bottom] = [Math.min(g.y, g.y1), Math.max(g.y, g.y1)];
    if (bottom < chords.top || top > chords.top + chords.height) return;
    for (const item of this.data.chords) {
      if (this.timeToX(item.end) >= left && this.timeToX(item.start) <= right) this.selected.add(item.key);
    }
  }

  // Drops dragged chords: on the timeline they move there (frozen); off it, frozen ones are deleted
  // (unfrozen).
  finishDrag(g, y) {
    const dt = this.xToTime(g.x) - g.grabTime;
    if (this.onChords(y)) {
      const moved = this.landing(g.items, dt).map(({ item, start, end }) => ({ key: item.key, start, end }));
      this.select(this.onEdit({ type: 'move', items: moved }));
    } else {
      this.onEdit({ type: 'delete', keys: g.items.map((item) => item.key) });
    }
  }

  draw() {
    const { ctx, width: W, height: H } = this;
    if (!W || !H) return;
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, W, H);
    if (!this.data) return;
    // Every change of the selection ends in a redraw: report it from here.
    const selection = [...this.selected].sort().join();
    if (selection !== this.shownSelection) {
      this.shownSelection = selection;
      this.onSelect?.();
    }

    const { duration, beats, bars, peaks, peaksPerSec } = this.data;
    const t0 = this.xToTime(0);
    const t1 = this.xToTime(W);
    const { chords, chroma, wave } = this.layout();

    // Areas before the start / after the end of the song.
    ctx.fillStyle = COLORS.outside;
    if (t0 < 0) ctx.fillRect(0, 0, this.timeToX(0), H);
    if (t1 > duration) ctx.fillRect(this.timeToX(duration), 0, W, H);

    this.drawChroma(chroma.top, chroma.height, t0, t1);

    // Beat grid and bar numbers.
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let i = Math.max(0, indexAt(beats, t0)); i < beats.length && beats[i] <= t1; i++) {
      const x = Math.round(this.timeToX(beats[i])) + 0.5;
      const isBar = bars.pos[i] === 0;
      ctx.strokeStyle = isBar ? COLORS.bar : COLORS.beat;
      ctx.beginPath();
      ctx.moveTo(x, isBar ? 4 : chords.top);
      ctx.lineTo(x, H);
      ctx.stroke();
      if (isBar) {
        ctx.fillStyle = COLORS.rulerText;
        ctx.fillText(String(bars.number[i]), x + 5, RULER_HEIGHT / 2 + 2);
      }
    }

    this.drawChords(chords, t0, t1);
    this.drawGesture(chords);
    this.drawRange(H);

    // Waveform overview.
    const mid = wave.top + wave.height / 2;
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
        const h = Math.max(1, peak * wave.height * 0.5);
        ctx.fillRect(x, mid - h, 1, 2 * h);
      }
    }

    // Dim what has already been played, then the playhead.
    ctx.fillStyle = COLORS.past;
    for (const r of [chords, chroma]) ctx.fillRect(0, r.top, this.playX, r.height);
    ctx.fillStyle = COLORS.playhead;
    ctx.fillRect(this.playX - 1, 0, 2, H);
    ctx.beginPath();
    ctx.moveTo(this.playX - 6, 0);
    ctx.lineTo(this.playX + 6, 0);
    ctx.lineTo(this.playX, 8);
    ctx.fill();
  }

  // The chord timeline. Frozen chords have a thick white outline (yellow when selected); the others
  // a thin one when sounding or selected.
  drawChords({ top, height }, t0, t1) {
    const { ctx } = this;
    const items = this.data.chords;
    const g = this.gesture;
    const current = indexAt(items, this.time, (c) => c.start);
    const first = Math.max(0, indexAt(items, t0, (c) => c.start));
    for (let i = first; i < items.length && items[i].start <= t1; i++) {
      let c = items[i];
      // A boundary being dragged shows where it would go.
      if (g?.type === 'resize' && g.left.key === c.key) c = { ...c, end: g.time };
      if (g?.type === 'resize' && g.right.key === c.key) c = { ...c, start: g.time };
      const x0 = this.timeToX(c.start) + 1;
      const x1 = this.timeToX(c.end) - 1;
      if (x1 <= x0) continue;
      const sounding = i === current && this.time < c.end;
      const selected = this.selected.has(c.key);
      ctx.fillStyle = chordColor(c.root, c.quality, sounding, c.frozen);
      ctx.beginPath();
      ctx.roundRect(x0, top, x1 - x0, height, 8);
      ctx.fill();
      if (c.frozen || selected || sounding) {
        ctx.save();
        ctx.clip();
        ctx.strokeStyle = selected ? COLORS.selected : c.frozen ? COLORS.frozen : 'rgba(255,255,255,0.85)';
        // Inside the box, so neighbours' outlines don't overlap.
        ctx.lineWidth = c.frozen ? 6 : 4;
        ctx.stroke();
        ctx.restore();
      }
      this.drawLabel(c, x0, x1, top, height);
    }
  }

  // The selected duration (or the one being dragged on the ruler), shaded down the whole timeline.
  drawRange(H) {
    const { ctx } = this;
    const g = this.gesture;
    const range = g?.type === 'range' && g.moved ? { start: Math.min(g.from, g.to), end: Math.max(g.from, g.to) } : this.range;
    if (!range) return;
    const x0 = this.timeToX(range.start);
    const x1 = this.timeToX(range.end);
    ctx.fillStyle = COLORS.range;
    ctx.fillRect(x0, 0, x1 - x0, H);
    ctx.fillStyle = COLORS.rangeRuler;
    ctx.fillRect(x0, 0, x1 - x0, RULER_HEIGHT);
    ctx.fillStyle = COLORS.selected;
    ctx.fillRect(Math.round(x0) - 1, 0, 2, H);
    ctx.fillRect(Math.round(x1) - 1, 0, 2, H);
  }

  // The marquee, or the chords being dragged where they would land (red where a drop deletes).
  drawGesture(row) {
    const { ctx } = this;
    const g = this.gesture;
    if (g?.type === 'marquee') {
      const [x, y] = [Math.min(g.x, g.x1), Math.min(g.y, g.y1)];
      ctx.fillStyle = COLORS.marquee;
      ctx.fillRect(x, y, Math.abs(g.x1 - g.x), Math.abs(g.y1 - g.y));
      ctx.strokeStyle = COLORS.selected;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(g.x1 - g.x), Math.abs(g.y1 - g.y));
    }
    if (g?.type !== 'drag') return;
    const onRow = this.onChords(g.y);
    const dt = this.xToTime(g.x) - g.grabTime;
    const { top, height } = onRow ? row : { top: g.y - row.height / 2, height: row.height };
    const items = onRow ? this.landing(g.items, dt) : g.items.map((item) => ({ item, start: item.start + dt, end: item.end + dt }));
    ctx.globalAlpha = 0.75;
    for (const { item, start, end } of items) {
      const x0 = this.timeToX(start) + 1;
      const x1 = this.timeToX(end) - 1;
      if (x1 <= x0) continue;
      // Off the timeline, frozen chords would be deleted; the others wouldn't change.
      const deleting = !onRow && item.frozen;
      ctx.fillStyle = chordColor(item.root, item.quality, false, true);
      ctx.beginPath();
      ctx.roundRect(x0, top, x1 - x0, height, 8);
      ctx.fill();
      ctx.strokeStyle = deleting ? COLORS.remove : COLORS.selected;
      ctx.lineWidth = 2;
      ctx.setLineDash(deleting || onRow ? (deleting ? [5, 4] : []) : [2, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      this.drawLabel(item, x0, x1, top, height);
    }
    ctx.globalAlpha = 1;
  }

  // The chromagram, the chords' tones (yellow) and bass note (blue) over it, and the note
  // names along the left edge.
  drawChroma(top, height, t0, t1) {
    const { ctx } = this;
    const { overlay, duration, chroma } = this.data;
    const { chords, bass } = overlay;
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
