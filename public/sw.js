const CACHE = 'vnc-v1';
const PRECACHE = ['/', '/index.html', '/pcm-worklet.js', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Only cache GET requests for static assets, not WebSocket upgrades or API
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/websockify') ||
      url.pathname.startsWith('/audio-') ||
      url.pathname.startsWith('/camera') ||
      url.pathname === '/health') return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && url.pathname.match(/\.(js|css|html|png|json)$|\/$/) ) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
