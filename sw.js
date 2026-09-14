// FleetCapture service worker
// Caches the app shell + CDN libraries so the app opens with no connection.
// Deliberately never touches Supabase API traffic -- that's handled by the app's own
// online/offline queue logic, not by this service worker.
const CACHE_NAME = 'fleetcapture-v2';
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept writes
  if (req.url.includes('supabase.co')) return; // never intercept the live database/auth API

  // The app page itself: try the network first so a new deploy shows up on the very next
  // reload (no waiting on a background refresh). Only fall back to the cached shell when offline.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req).then(res => {
        if (res && res.status === 200) caches.open(CACHE_NAME).then(cache => cache.put(req, res.clone()));
        return res;
      }).catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
    );
    return;
  }

  // Everything else (CDN libraries, icons): cache-first with a background refresh, since these
  // rarely change and speed matters more here.
  event.respondWith(
    caches.match(req).then(cached => {
      const networkFetch = fetch(req).then(res => {
        if (res && res.status === 200) {
          caches.open(CACHE_NAME).then(cache => cache.put(req, res.clone()));
        }
        return res;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});
