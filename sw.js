/*
 * Service worker: guarda os arquivos do app no tablet para funcionar sem internet.
 * IMPORTANTE: ao alterar qualquer arquivo do app, aumente a VERSAO abaixo
 * (o tablet só baixa a nova versão quando este arquivo muda).
 */
const VERSAO = 'pesagem-v1.5.0';
const ARQUIVOS = [
  './',
  './index.html',
  './styles.css',
  './calc.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', function (ev) {
  ev.waitUntil(
    caches.open(VERSAO).then(function (cache) {
      return cache.addAll(ARQUIVOS.map(function (u) { return new Request(u, { cache: 'reload' }); }));
    })
  );
});

self.addEventListener('activate', function (ev) {
  ev.waitUntil(
    caches.keys().then(function (nomes) {
      return Promise.all(nomes.filter(function (n) { return n !== VERSAO; })
        .map(function (n) { return caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (ev) {
  if (ev.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (ev) {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // planilha: sempre pela rede
  if (url.pathname.indexOf('/escritorio/') >= 0) return; // painel do escritório: não é do tablet

  if (req.mode === 'navigate') {
    ev.respondWith(
      caches.match('./index.html').then(function (r) { return r || fetch(req); })
    );
    return;
  }
  ev.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (r) { return r || fetch(req); })
  );
});
