import * as ort from 'onnxruntime-web';
import { createSession, loadModelFile } from '../models.js';
import { beatsFromLogits, logMel, predict } from './beatThis.js';

// Beat This! final0 (MIT, CPJKU) exported to ONNX; frontend.json holds its STFT window and mel
// filterbank. Pinned to a commit.
const REPO = 'https://huggingface.co/aaatmy/beat-this-onnx/resolve/e2c0d4376fac8141905a8312c1b327849751d59c';
const MODEL_URL = `${REPO}/beat-this-final0.onnx`;
const FRONTEND_URL = `${REPO}/frontend.json`;

ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;

const progress = (stage, value) => self.postMessage({ type: 'progress', stage, value });

let ready = null;

async function load() {
  const frontend = JSON.parse(new TextDecoder().decode(await loadModelFile(FRONTEND_URL)));
  const model = await loadModelFile(MODEL_URL, (p) => progress('Downloading beat model (one time, 82 MB)', p));
  return {
    window: Float64Array.from(frontend.window),
    melFilters: Float32Array.from(frontend.mel_filters.flat()),
    ...(await createSession(ort, model)),
  };
}

// Input: mono samples at 22.05 kHz. Output: beat times (s) and a downbeat flag per beat.
self.onmessage = async ({ data }) => {
  try {
    progress('Loading beat model', 0);
    ready ??= load();
    const { window, melFilters, session } = await ready;
    const { spect, frames } = logMel(data.samples, window, melFilters);
    const run = async (chunk, length) => {
      const out = await session.run({ spectrogram: new ort.Tensor('float32', chunk, [1, length, 128]) });
      return { beat: out.beat.data, downbeat: out.downbeat.data };
    };
    const logits = await predict(spect, frames, run, (p) => progress('Detecting beats', p));
    const { beats, downbeats } = beatsFromLogits(logits);
    const times = Float64Array.from(beats);
    self.postMessage({ type: 'result', beats: times, downbeats }, [times.buffer, downbeats.buffer]);
  } catch (err) {
    ready = null;
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};
