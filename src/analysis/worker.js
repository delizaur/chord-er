import { analyzeAudio } from './analyze.js';

self.onmessage = ({ data }) => {
  try {
    const result = analyzeAudio(data.samples, data.sampleRate, (stage, value) =>
      self.postMessage({ type: 'progress', stage, value }),
    );
    const transfer = ['frameTimes', 'treble', 'bass', 'energy', 'peaks'].map((k) => result[k].buffer);
    self.postMessage({ type: 'result', result }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};
