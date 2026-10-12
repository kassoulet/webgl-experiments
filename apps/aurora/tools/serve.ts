#!/usr/bin/env node
// A static server, for local work only, and used by the smoke test: it serves the
// build in dist/ (no dependencies — `npm run serve`).
//
// It sends the cross-origin isolation headers (COOP/COEP) the spec asks for —
// today they are harmless, and the day the engine moves to wasm with a
// SharedArrayBuffer render-ahead ring, they are already there. Any static host
// needs the same two headers; see README.md.

import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The build, found by walking up out of wherever this file is running from:
// `tools/serve.ts` on a node with TypeScript support, `tools-dist/tools/serve.js`
// on one without. Both are one level below the package root, so stripping the
// build directory off the end gives the same answer as `../dist` did.
const ROOT = join(
  resolve(fileURLToPath(new URL('..', import.meta.url))).replace(/\/tools-dist$/, ''),
  'dist',
);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

export function createStaticServer(root = ROOT) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const target = resolve(join(root, normalize(pathname)));
      if (!target.startsWith(root)) {
        response.writeHead(403).end('forbidden');
        return;
      }
      let info;
      try {
        info = await fs.stat(target);
      } catch {
        response.writeHead(404).end('not found');
        return;
      }
      if (info.isDirectory()) {
        response.writeHead(302, { location: `${pathname}/` }).end();
        return;
      }
      response.writeHead(200, {
        'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
        'content-length': info.size,
        'cache-control': 'no-store',
        // Cross-origin isolation: needed by SharedArrayBuffer, harmless now.
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'same-origin',
        'service-worker-allowed': '/',
      });
      createReadStream(target).pipe(response);
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 8092);
  createStaticServer().listen(port, '127.0.0.1', () => {
    console.log(`Aurora on http://127.0.0.1:${port}/`);
  });
}
