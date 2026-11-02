import { QUALITIES } from './analysis/chords.js';

// Partial amplitudes of a soft, piano-like tone.
const PARTIALS = [0, 1, 0.45, 0.25, 0.18, 0.1, 0.07, 0.04, 0.03];

// Bass note in octave 2 plus a close-position voicing around middle C.
export function chordVoicing(root, quality) {
  if (root < 0) return [];
  const base = 60 + root > 66 ? 48 + root : 60 + root;
  return [36 + root, ...QUALITIES[quality].intervals.map((iv) => base + iv)];
}

const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);

// Fades out and stops the given voices from `when` (AudioContext time).
function release(voices, when) {
  for (const { osc, gain } of voices) {
    const g = gain.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(when);
    else {
      g.cancelScheduledValues(when);
      g.setValueAtTime(g.value, when);
    }
    g.setTargetAtTime(0, when, 0.01);
    osc.stop(when + 0.1);
  }
  voices.clear();
}

// Sounds are scheduled on the AudioContext clock (`when`), so they land exactly on the beat.
export class ChordSynth {
  constructor(volume) {
    this.volume = volume;
    this.ctx = null;
    this.voices = new Set();
  }

  attach(ctx) {
    this.ctx = ctx;
    this.wave = ctx.createPeriodicWave(Float32Array.from(PARTIALS, () => 0), Float32Array.from(PARTIALS));
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 3500;
    const limiter = ctx.createDynamicsCompressor();
    this.master.connect(lowpass).connect(limiter).connect(ctx.destination);
  }

  setVolume(volume) {
    this.volume = volume;
    if (this.ctx) this.master.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.02);
  }

  // Strikes a chord at `when`, releasing whatever is sounding at that moment.
  play(notes, when) {
    if (!this.ctx) return;
    release(this.voices, when);
    if (this.volume === 0) return;
    for (const midi of notes) {
      const osc = this.ctx.createOscillator();
      osc.setPeriodicWave(this.wave);
      osc.frequency.value = midiToHz(midi);
      const gain = this.ctx.createGain();
      const peak = midi < 48 ? 0.16 : 0.1;
      const decay = midi < 48 ? 1.2 : 0.8; // time constant, seconds
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(peak, when + 0.006);
      gain.gain.setTargetAtTime(0, when + 0.006, decay);
      osc.connect(gain).connect(this.master);
      osc.start(when);
      osc.stop(when + 8 * decay);
      this.track(osc, gain);
    }
  }

  track(osc, gain) {
    const voice = { osc, gain };
    this.voices.add(voice);
    osc.onended = () => this.voices.delete(voice);
  }

  stopAll() {
    if (this.ctx) release(this.voices, this.ctx.currentTime);
  }
}

// Short woodblock-like click; the first beat of each bar is higher.
export class Metronome extends ChordSynth {
  attach(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);
  }

  click(when, accent) {
    if (!this.ctx || this.volume === 0) return;
    const osc = this.ctx.createOscillator();
    osc.frequency.value = accent ? 1760 : 1320;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(accent ? 0.6 : 0.4, when + 0.001);
    gain.gain.setTargetAtTime(0, when + 0.001, 0.012);
    osc.connect(gain).connect(this.master);
    osc.start(when);
    osc.stop(when + 0.1);
    this.track(osc, gain);
  }
}
