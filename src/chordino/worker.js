// Runs Chordino (NNLS Chroma, compiled to WebAssembly from ../../chordino) on a mono signal and
// returns its chord labels with their start times.
import createChordino from './chordino.js';

// Chordino's parameters, in the order chordino_run (chordino/web/host.cpp) takes them.
const PARAMETERS = ['useNNLS', 'shape', 'whitening', 'rollon', 'boostN', 'tuning'];

let ready = null;

self.onmessage = async ({ data }) => {
  try {
    // The plugin's own diagnostics (stderr) are warnings, not errors.
    ready ??= createChordino({ printErr: (text) => console.warn(text) });
    const chordino = await ready;
    const { samples, sampleRate, parameters } = data;
    const pointer = chordino._malloc(samples.length * 4);
    const values = chordino._malloc(PARAMETERS.length * 4);
    chordino.HEAPF32.set(samples, pointer >> 2);
    chordino.HEAPF32.set(PARAMETERS.map((name) => Number(parameters[name])), values >> 2);
    const text = chordino.UTF8ToString(chordino._chordino_run(pointer, samples.length, sampleRate, values));
    chordino._free(pointer);
    chordino._free(values);
    if (text.startsWith('error')) throw new Error(`Chordino: ${text}`);
    const chords = text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [time, label] = line.split('\t');
        return { time: Number(time), label };
      });
    self.postMessage({ type: 'result', chords });
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};
