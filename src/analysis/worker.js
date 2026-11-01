import { analyzeAudio } from './analyze.js';

self.onmessage = ({ data }) => {
  try {
    const result = analyzeAudio(data.samples, data.sampleRate, (stage, value) =>
      self.postMessage({ type: 'progress', stage, value }),
    );
    const transfer = ['beats', 'treble', 'bass', 'loudness', 'peaks'].map((k) => result[k].buffer);
    self.postMessage({ type: 'result', result }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};
