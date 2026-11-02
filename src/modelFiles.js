// The AI model files, pinned to commits, and the Cache Storage they are kept in. Shared by the
// model workers (which download them) and the page (which asks before the first download).

export const MODEL_CACHE = 'chord-er-models-v1';

// Beat This! final0 (MIT, CPJKU) exported to ONNX; frontend.json holds its STFT window and mel
// filterbank.
const BEAT_THIS = 'https://huggingface.co/aaatmy/beat-this-onnx/resolve/e2c0d4376fac8141905a8312c1b327849751d59c';
export const BEAT_MODEL_URL = `${BEAT_THIS}/beat-this-final0.onnx`;
export const BEAT_FRONTEND_URL = `${BEAT_THIS}/frontend.json`;

// HTDemucs v4 (MIT, Meta) exported to ONNX with the STFT outside the graph.
export const SEPARATION_MODEL_URL =
  'https://huggingface.co/Ghilda/htdemucs-onnx/resolve/850cd89461d0817276337061c29e6abceb86d75f/htdemucs.onnx';

export const MODEL_URLS = [BEAT_FRONTEND_URL, BEAT_MODEL_URL, SEPARATION_MODEL_URL];
