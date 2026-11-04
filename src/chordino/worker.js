// Runs Chordino (NNLS Chroma, compiled to WebAssembly from ../../chordino) on a mono signal and
// returns its chord labels with their start times.
import createChordino from './chordino.js';

let ready = null;

self.onmessage = async ({ data }) => {
  try {
    ready ??= createChordino();
    const chordino = await ready;
    const { samples, sampleRate } = data;
    const pointer = chordino._malloc(samples.length * 4);
    chordino.HEAPF32.set(samples, pointer >> 2);
    const text = chordino.UTF8ToString(chordino._chordino_run(pointer, samples.length, sampleRate));
    chordino._free(pointer);
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
