// The service worker. It caches the shell so the set plays with no network, and
// it adds the cross-origin isolation headers a wasm audio engine would want
// later — here, in the Vite dev server config and on the static host.
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

// Bump this when the shell below changes, or the old cache is kept forever.
const VERSION = 'jeffer-v1';

// Written by hand and kept in step with the build: the app bundle is emitted at
// these stable paths (see vite.config.ts), so there is nothing hashed to chase.
// Nothing else is listed because nothing else is fetched: the GLSL and the
// AudioWorklet source are embedded in the bundle, and the icons are only needed
// by the browser chrome, not by the running app.
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'styles.css',
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
      // The seed lives in the fragment, which is never sent to the server, so a
      // navigation is the same document whatever the seed is and `ignoreSearch`
      // is not merely a nicety here — it is what makes the seed box work while
      // the service worker is in charge.
      const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
      if (cached) return withIsolation(cached, request.mode === 'navigate');
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
