// Fetches model files once and keeps them in the browser's Cache Storage, and sets up ONNX
// Runtime. For use in workers.

import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?url';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';
import { MODEL_CACHE } from './modelFiles.js';

// Threads need cross-origin isolation (vite.config.js, or public/coi-serviceworker.js on static
// hosts). ORT starts its threads from its own runtime script, so it is pointed at the standalone
// files: inside a bundled worker it would otherwise load the worker bundle instead, and hang.
export function configureOrt(ort) {
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
  ort.env.wasm.wasmPaths = { mjs: new URL(ortMjsUrl, self.location.href).href, wasm: new URL(ortWasmUrl, self.location.href).href };
}

// Cache Storage can be unavailable (private windows, storage errors); then files are simply
// downloaded again next time.
async function openCache() {
  try {
    return await caches.open(MODEL_CACHE);
  } catch (err) {
    console.warn('Model cache unavailable', err);
    return null;
  }
}

// Returns the file's bytes. `onProgress(fraction)` is called while downloading.
export async function loadModelFile(url, onProgress = () => {}) {
  const cache = await openCache();
  const cached = await cache?.match(url);
  if (cached) return new Uint8Array(await cached.arrayBuffer());

  // A large download can drop midway; retry a couple of times before giving up.
  let bytes;
  for (let attempt = 1; !bytes; attempt++) {
    try {
      bytes = await download(url, onProgress);
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`Download of ${url} failed (attempt ${attempt}), retrying`, err);
    }
  }
  try {
    await cache?.put(url, new Response(bytes));
  } catch (err) {
    console.warn('Could not cache the model', err);
  }
  return bytes;
}

async function download(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Model download failed (HTTP ${response.status})`);
  const size = Number(response.headers.get('content-length')) || 0;
  const chunks = [];
  let received = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (size) onProgress(received / size);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

// ONNX Runtime session on WebGPU when available, otherwise WebAssembly. Errors only in the log:
// ORT otherwise warns that it runs some shape ops on the CPU, which it does on purpose.
export async function createSession(ort, model) {
  const create = (provider) => ort.InferenceSession.create(model, { executionProviders: [provider], logSeverityLevel: 3 });
  if (self.navigator.gpu) {
    try {
      return { session: await create('webgpu'), backend: 'webgpu' };
    } catch (err) {
      console.warn('WebGPU unavailable, using WebAssembly', err);
    }
  }
  return { session: await create('wasm'), backend: 'wasm' };
}
