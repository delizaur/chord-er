import * as ort from 'onnxruntime-web';
import { configureOrt, createSession, loadModelFile } from '../models.js';
import { BEAT_FRONTEND_URL, BEAT_MODEL_URL } from '../modelFiles.js';
import { beatsFromLogits, logMel, predict } from './beatThis.js';

configureOrt(ort);

const progress = (stage, value) => self.postMessage({ type: 'progress', stage, value });

let ready = null;

async function load() {
  const frontend = JSON.parse(new TextDecoder().decode(await loadModelFile(BEAT_FRONTEND_URL)));
  const model = await loadModelFile(BEAT_MODEL_URL, (p) => progress('Downloading beat model (one time, 82 MB)', p));
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
