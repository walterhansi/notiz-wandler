// Service Worker: App-Gerüst offline, OCR-Bibliothek (CDN) beim ersten Gebrauch nachladen und merken.
const VERSION = 'ao-wandler-v2';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'core.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'lib/pdf.min.mjs', 'lib/pdf.worker.min.mjs',
  'lib/wasm/openjpeg.wasm', 'lib/wasm/jbig2.wasm', 'lib/wasm/qcms_bg.wasm',
  'lib/wasm/openjpeg_nowasm_fallback.js', 'lib/wasm/jbig2_nowasm_fallback.js',
];
const RUNTIME = 'ao-wandler-runtime-v1';
const CDN = ['https://cdn.jsdelivr.net/'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== RUNTIME).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // Sofort aus dem Cache, im Hintergrund auffrischen (Update greift beim nächsten Start)
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req.url, { cache: 'no-cache' }).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  } else if (CDN.some((p) => req.url.startsWith(p))) {
    e.respondWith(caches.open(RUNTIME).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok || r.type === 'opaque') c.put(req, r.clone());
      return r;
    }));
  }
});
