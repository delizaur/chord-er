import { analyzeAudio } from './analyze.js';
import { computeChroma } from './chroma.js';

// mode 'full': tempo, chroma and waveform of the song; mode 'chroma': chroma only (for a stem).
self.onmessage = ({ data }) => {
  try {
    const report = (stage, value) => self.postMessage({ type: 'progress', stage, value });
    const result =
      data.mode === 'chroma'
        ? computeChroma(data.samples, data.sampleRate, (p) => report('Analyzing harmony', p))
        : analyzeAudio(data.samples, data.sampleRate, report);
    const transfer = ['frameTimes', 'treble', 'bass', 'energy', 'peaks'].filter((k) => result[k]).map((k) => result[k].buffer);
    self.postMessage({ type: 'result', result }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};
