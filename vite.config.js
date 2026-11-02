import { defineConfig } from 'vite';

// Cross-origin isolation lets onnxruntime-web use multiple threads for stem separation.
// 'credentialless' still allows the CORS download of the model from Hugging Face. Static hosts
// that can't send these headers (GitHub Pages) get them from public/coi-serviceworker.js.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  base: './', // relative asset paths, so the build works from any subpath (e.g. /chord-er/)
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
});
