/* Service Worker — Fabin Lanches PWA */
const CACHE_NAME = 'fabin-lanches-v195';
const DYNAMIC_MANIFEST_CACHE = 'fabin-store-manifest';
const ASSETS = [
  './',
  './index.html',
  './assets/css/style.css',
  './assets/script/api-config.js',
  './assets/script/script.js',
  './assets/images/barra-v-mobile.png',
  './assets/icons/icon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== DYNAMIC_MANIFEST_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function isManifestRequest(url) {
  const path = url.pathname || '';
  return path.endsWith('/manifest.json') || path.endsWith('/manifest.webmanifest');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (!request.url.startsWith(self.location.origin)) return;

  const url = new URL(request.url);
  if (isManifestRequest(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(DYNAMIC_MANIFEST_CACHE);
      const dynamic =
        (await cache.match('current')) ||
        (await cache.match(new URL('manifest.webmanifest', self.registration.scope).href));
      if (dynamic) return dynamic;
      try {
        return await fetch(request);
      } catch (_) {
        return (await caches.match('./manifest.json')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
