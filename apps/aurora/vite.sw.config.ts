import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: '/',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    rollupOptions: {
      input: 'src/sw.ts',
      output: {
        entryFileNames: 'sw.js',
        format: 'es',
      },
    },
  },
});