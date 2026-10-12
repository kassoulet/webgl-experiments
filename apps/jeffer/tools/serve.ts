// A static server. One module, no dependencies, used by the local dev command
// and by every headless tool that needs a real origin (a service worker and an
// AudioWorklet will not load from `file://`).
//
// The root is an argument rather than something derived from this file's own
// location. These sources are sometimes run straight from TypeScript and
// sometimes from a bundle, and in the second case this module may have been
// split into a shared chunk whose depth in the output directory is not the
// depth of the tool that called it. A path that depends on where the bundler
// happened to put a file is a path that breaks the first time a second importer
// appears.
//
// It sends the cross-origin isolation headers (COOP/COEP) the sibling apps send
// — harmless today, and already there the day anything here wants a
// SharedArrayBuffer. Any static host needs the same two headers; see README.md.

import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

// Base path for GitHub Pages deployment; strip from requests in smoke test
const BASE_PATH = '/webgl-experiments/jeffer/';

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

export function createStaticServer(root: string) {
  const base = resolve(root);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      // Strip base path prefix for smoke test / CI compatibility
      if (pathname.startsWith(BASE_PATH)) {
        pathname = pathname.slice(BASE_PATH.length);
        if (!pathname.startsWith('/')) pathname = '/' + pathname;
      }
      if (pathname.endsWith('/')) pathname += 'index.html';
      const target = resolve(join(base, normalize(pathname)));
      if (!target.startsWith(base)) {
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
