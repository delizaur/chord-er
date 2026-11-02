import * as ort from 'onnxruntime-web';
import { separate } from './demucs.js';

// HTDemucs v4 (MIT, Meta) exported to ONNX with the STFT outside the graph; pinned to a commit.
const MODEL_URL =
  'https://huggingface.co/Ghilda/htdemucs-onnx/resolve/850cd89461d0817276337061c29e6abceb86d75f/htdemucs.onnx';
const MODEL_CACHE = 'chord-er-models-v1';

// Threads need cross-origin isolation (set up by vite.config.js).
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;

const progress = (stage, value) => self.postMessage({ type: 'progress', stage, value });

// Cache Storage can be unavailable (private windows, storage errors); then the model is
// simply downloaded again next time.
async function openCache() {
  try {
    return await caches.open(MODEL_CACHE);
  } catch (err) {
    console.warn('Model cache unavailable', err);
    return null;
  }
}

// The model is downloaded once and then served from the browser's Cache Storage.
async function loadModel() {
  const cache = await openCache();
  const cached = await cache?.match(MODEL_URL);
  if (cached) return new Uint8Array(await cached.arrayBuffer());

  // A large download can drop midway; retry a couple of times before giving up.
  let model;
  for (let attempt = 1; !model; attempt++) {
    try {
      model = await download();
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`Model download failed (attempt ${attempt}), retrying`, err);
    }
  }
  try {
    await cache?.put(MODEL_URL, new Response(model));
  } catch (err) {
    console.warn('Could not cache the model', err);
  }
  return model;
}

async function download() {
  const response = await fetch(MODEL_URL);
  if (!response.ok) throw new Error(`Model download failed (HTTP ${response.status})`);
  const size = Number(response.headers.get('content-length')) || 174266088;
  const model = new Uint8Array(size);
  const reader = response.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    model.set(value, received);
    received += value.length;
    progress('Downloading separation model (one time, 166 MB)', received / size);
  }
  return model;
}

async function createSession(model) {
  if (self.navigator.gpu) {
    try {
      return { session: await ort.InferenceSession.create(model, { executionProviders: ['webgpu'] }), backend: 'webgpu' };
    } catch (err) {
      console.warn('WebGPU unavailable for separation, using WebAssembly', err);
    }
  }
  return { session: await ort.InferenceSession.create(model, { executionProviders: ['wasm'] }), backend: 'wasm' };
}

let ready = null;

self.onmessage = async ({ data }) => {
  try {
    progress('Loading separation model', 0);
    ready ??= loadModel().then(createSession);
    const { session, backend } = await ready;
    const run = async (mix, mag, segment, bins, frames) => {
      const out = await session.run({
        mix: new ort.Tensor('float32', mix, [1, 2, segment]),
        mag: new ort.Tensor('float32', mag, [1, 4, bins, frames]),
      });
      return { freq: out.freq.data, time: out.time.data };
    };
    progress(`Separating stems (${backend === 'webgpu' ? 'GPU' : 'CPU'})`, 0);
    const [left, right] = await separate(data.left, data.right, data.sources, run, (p) =>
      progress(`Separating stems (${backend === 'webgpu' ? 'GPU' : 'CPU'})`, p),
    );
    self.postMessage({ type: 'result', left, right, backend }, [left.buffer, right.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};
