import * as ort from 'onnxruntime-web';
import { configureOrt, createSession, loadModelFile } from '../models.js';
import { SEPARATION_MODEL_URL } from '../modelFiles.js';
import { separate } from './demucs.js';

configureOrt(ort);

const progress = (stage, value) => self.postMessage({ type: 'progress', stage, value });

let ready = null;

self.onmessage = async ({ data }) => {
  try {
    progress('Loading separation model', 0);
    ready ??= loadModelFile(SEPARATION_MODEL_URL, (p) => progress('Downloading separation model (one time, 166 MB)', p)).then(
      (model) => createSession(ort, model),
    );
    const { session, backend } = await ready;
    const run = async (mix, mag, segment, bins, frames) => {
      const out = await session.run({
        mix: new ort.Tensor('float32', mix, [1, 2, segment]),
        mag: new ort.Tensor('float32', mag, [1, 4, bins, frames]),
      });
      return { freq: out.freq.data, time: out.time.data };
    };
    const stage = `Separating stems (${backend === 'webgpu' ? 'GPU' : 'CPU'})`;
    progress(stage, 0);
    const stems = await separate(data.left, data.right, data.groups, run, (p) => progress(stage, p));
    self.postMessage({ type: 'result', stems, backend }, stems.flat().map((c) => c.buffer));
  } catch (err) {
    ready = null; // let the next song retry a failed download
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};
