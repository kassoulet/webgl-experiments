#!/usr/bin/env node
// Serve the build in dist/ on a fixed port: `npm run serve`.
//
// It serves the *build*, not the sources, because that is the thing the
// service worker and the static host both need and it is the only way to test
// them. `npm run dev` is the Vite dev server, for working on the app itself.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStaticServer } from './serve.ts';

const root = resolve(fileURLToPath(new URL('../dist', import.meta.url)));
const port = Number(process.env.PORT ?? 8090);

createStaticServer(root).listen(port, '127.0.0.1', () => {
  console.log(`Jeffer on http://127.0.0.1:${port}/`);
});
