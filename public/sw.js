// Network-first service worker: always fresh when online, cached app shell when offline.
const CACHE = 'flowlane-shell-v2';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/config.js', '/icon.svg', '/manifest.webmanifest',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const sameOrigin = url.origin === self.location.origin;
  // Supabase API/auth/realtime traffic is never cached; only the app shell, fonts and the client library are.
  const cacheable = sameOrigin || url.hostname === 'cdn.jsdelivr.net'
    || url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com');
  if (!cacheable) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok || res.type === 'opaque') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || (e.request.mode === 'navigate' ? caches.match('/') : Response.error())))
  );
});
