import { defineConfig } from 'vite';

// The service worker is a second, tiny build: it must be a standalone
// classic script at a stable URL with the root scope — a service worker served
// as an ES module is still not portable across browsers — and it must not wipe
// the app build sitting beside it.
//
// `npm run build` runs the app build first, then this one.
export default defineConfig({
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: false,
    lib: {
      entry: 'src/sw.ts',
      formats: ['iife'],
      name: 'FOMyRaveWorker',
      fileName: () => 'sw.js',
    },
  },
});
