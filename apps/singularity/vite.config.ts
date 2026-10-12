import { defineConfig } from 'vite';

// The app build. Deliberately unexciting: one ES bundle at a *stable* path, so
// the service worker's precache list stays readable and diffable (see
// src/sw.ts), and no asset hashing to chase across two builds.
//
// AudioWorklet code is not a separate entry: it is embedded as a string and
// loaded from a Blob URL (src/audio/meter-worklet.ts), the same discipline the
// GLSL follows, so there is no worklet chunk to name or precache.
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: 'js/[name].js',
        chunkFileNames: 'js/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: {
    port: 8088,
    host: '127.0.0.1',
    // Not needed yet — nothing uses SharedArrayBuffer until Motif's wasm engine
    // (M8) arrives — but they cost nothing and make that move a drop-in.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
