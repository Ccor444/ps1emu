// Service worker: deixa o emulador funcionar offline depois da primeira visita (só em https:// ou localhost).
// Troque VERSAO ao publicar uma atualização; os arquivos novos entram no cache na visita seguinte (stale-while-revalidate).
const VERSAO = 'ps1emu-v26';
const ARQUIVOS = ['./', './index.html', './dist/ps1emu.js', './web/storage.js', './web/main.js', './web/ui.js', './manifest.webmanifest',
                  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-192.png', './icons/maskable-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  e.respondWith(caches.open(VERSAO).then(async c => {
    const hit = await c.match(r, { ignoreSearch: true });
    const net = fetch(r).then(res => { if (res.ok) c.put(r, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
