// Bump this whenever the asset list changes so the service worker re-caches.
const CACHE = 'anemo-calib-v6';
const ASSETS = [
  './',
  'index.html',
  'app.js',
  'style.css',
  'manifest.json',
  'icon.svg',
  'lib/chart.umd.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request))
  );
});
