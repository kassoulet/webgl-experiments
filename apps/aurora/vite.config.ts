import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: '/webgl-experiments/aurora/',
  publicDir: 'public',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: 'index.html',
      output: {
        entryFileNames: 'js/index.js',
        chunkFileNames: 'js/[name].js',
        assetFileNames: (info) => {
          if (info.names?.[0]?.endsWith('.css')) return 'styles.css';
          if (info.names?.[0]?.match(/\.(png|svg|webp)$/)) return 'icons/[name][extname]';
          return 'assets/[name][extname]';
        },
      },
    },
  },
  server: { port: 8091, host: true },
});