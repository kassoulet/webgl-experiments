// The service worker. It caches the shell so the set plays with no network, and
// it adds the cross-origin isolation headers a wasm audio engine would want
// (spec §5: "This needs cross-origin isolation headers (COOP/COEP) on the host"
// — here, and in the Vite dev server config).
//
// The app ships no WebWorker lib (`types: []`, DOM only), so the worker global
// is described here: just the members this file actually uses.

interface ExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface WorkerGlobal {
  readonly location: Location;
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
}

const worker = self as unknown as WorkerGlobal;

const VERSION = 'fo-v1';
// Written by hand and kept in step with the build: the app bundle is emitted at
// these stable paths (see vite.config.ts), so there is nothing hashed to chase.
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  // The app bundle, emitted at a stable path (see vite.config.ts).
  'js/index.js',
];

const ISOLATION: Record<string, string> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

worker.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => worker.skipWaiting()),
  );
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => worker.clients.claim()),
  );
});

worker.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin) return; // nothing off-origin is fetched, ever

  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
      if (cached) {
        return withIsolation(cached, request.mode === 'navigate');
      }
      try {
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return withIsolation(response, request.mode === 'navigate');
      } catch (error) {
        if (request.mode === 'navigate') {
          const fallback = await cache.match('index.html');
          if (fallback) return withIsolation(fallback, true);
        }
        throw error;
      }
    })(),
  );
});

/** Only the document needs isolation; assets are left untouched. */
function withIsolation(response: Response, isDocument: boolean): Response {
  if (!isDocument) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(ISOLATION)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
