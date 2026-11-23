// Yumeiro 的 Service Worker：只缓存图标和离线提示页，不缓存任何接口或页面内容（避免旧数据 / 泄露登录后内容）。
const CACHE = 'yumeiro-shell-v3';
const SHELL = ['/icon.svg', '/icon-192.png', '/icon-512.png', '/mascot.png', '/offline.html'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
    return;
  }
  if (SHELL.includes(url.pathname) && url.pathname !== '/offline.html') event.respondWith(caches.match(request).then(hit => hit || fetch(request)));
});
