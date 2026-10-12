import { readdirSync } from 'node:fs';

import { defineConfig } from 'vite';

// The tools, as runnable ESM in `.tools/`.
//
// The sibling apps run their tools with `node --experimental-strip-types`, which
// is the tidier way to do it and what a fresh checkout would do. This
// container's node has no TypeScript support at all — `--experimental-strip-types`
// fails with ERR_NO_TYPESCRIPT — so the same sources are bundled here instead
// and the npm scripts run the bundle. Nothing in `tools/` knows the difference:
// they are ordinary TypeScript, imported by extension, either way.
//
// Only *runnable* tools are entries. `serve.ts` and `chrome.ts` are libraries
// that other tools import, and listing them as entries too would make the
// bundler split them into shared chunks — which renames the file and moves it,
// and any `import.meta.url` inside them then points somewhere else entirely.
// As libraries they keep their own name and their own location.
//
// `node:` builtins stay external, which is the rest of the config's cleverness —
// and it is what keeps `node:test` external too, so a bundled test file is still
// a real test file as far as the test runner is concerned.
//
// The tests are entries for the same reason the tools are: `node --test` cannot
// read a `.ts` file here either. The list is read off the directory rather than
// written out, so a new test file is bundled by being written and not by also
// being registered somewhere else.
const tests = readdirSync(new URL('./tests', import.meta.url))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => `tests/${name}`);
export default defineConfig({
  build: {
    target: 'node22',
    outDir: '.tools',
    emptyOutDir: true,
    ssr: true,
    minify: false,
    sourcemap: false,
    lib: {
      entry: [
        'tools/dev-server.ts',
        'tools/shaders.ts',
        'tools/smoke.ts',
        'tools/preview.ts',
        'tools/make-icons.ts',
        'tools/stars.ts',
        ...tests,
      ],
      formats: ['es'],
    },
    rollupOptions: {
      external: [/^node:/],
      output: {
        entryFileNames: '[name].mjs',
        chunkFileNames: '[name].mjs',
      },
    },
  },
});
