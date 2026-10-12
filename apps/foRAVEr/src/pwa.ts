// Offline as a PWA (spec §4, §6 "installable as a PWA; once loaded, it needs no
// network"). The worker itself is js-less about the app: it caches the shell and
// serves it, and adds the COOP/COEP headers a wasm engine would want later.

export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return; // no workers on file://, no problem
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((error) => {
      console.warn('[pwa] service worker registration failed', error);
    });
  });
}
