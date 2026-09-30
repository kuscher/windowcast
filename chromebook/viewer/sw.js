// Network first, so a new deployment is picked up on the next load; the cache only helps the app install
// and open while offline (it then shows "Waiting for your Chromebook").
const CACHE = 'windowcast-viewer';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['./'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Navigations are cached under the bare page address, never under the requested one: a pairing link's
  // fragment can show up in the request, and the key must not end up in the cache.
  const key = event.request.mode === 'navigate' ? new Request(url.origin + url.pathname) : event.request;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(key, copy));
        return response;
      })
      .catch(() => caches.match(key, { ignoreSearch: true })),
  );
});
