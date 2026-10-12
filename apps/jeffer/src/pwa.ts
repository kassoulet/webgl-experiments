// Offline as a PWA: the worker caches the shell and serves it, so once the page
// has loaded there is no network traffic at all — which for an endless set is
// the difference between a thing you can leave running and a thing you cannot.

export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return; // no workers on file://, and none needed
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((error) => {
      console.warn('[pwa] service worker registration failed', error);
    });
  });
}
