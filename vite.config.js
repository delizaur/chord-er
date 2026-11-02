import { defineConfig } from 'vite';

// Cross-origin isolation lets onnxruntime-web use multiple threads for stem separation.
// 'credentialless' still allows the CORS download of the model from Hugging Face.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
});
