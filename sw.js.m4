m4_changequote([[, ]])
m4_changecom(<!--, -->)

m4_include([[resources.m4]])

const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './icon.png',
  './favicon.ico',
  'URL_JSDIFF_JS',
  'URL_MARKED_JS',
  'URL_DOMPURIFY_JS',
  'URL_KATEX_CSS',
  'URL_KATEX_JS',
  'URL_HIGHLIGHT_JS',
  'URL_HIGHLIGHT_GITHUB_CSS',
  'URL_MARKED_KATEX_EXTENSION_JS',

  FOREACH([[FONT]], [[URL_KATEX_FONTS_WOFF2]], [['URL_KATEX_FONTS_BASE/FONT',
  ]])
];

const allowedHosts = new Set(
  urlsToCache.map(requestUrl => new URL(requestUrl, location.origin).hostname)
);

// One cache per build (BUILD_ID comes from make), so a new build installs a
// new worker with fresh copies of the app files. The new worker waits until
// the page tells it to take over (app/boot shows "New version available").
const CACHE_PREFIX = 'notes-cache-';
const CACHE_NAME = CACHE_PREFIX + 'BUILD_ID';

const isLocal = (requestUrl) => new URL(requestUrl, location.href).origin === location.origin;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => Promise.all(urlsToCache.map(async requestUrl => {
    if (isLocal(requestUrl)) {
      // Bypass the HTTP cache, which may still hold the previous build.
      return cache.add(new Request(requestUrl, { cache: 'reload' }));
    }
    // CDN URLs are versioned and never change: reuse a copy from an older cache.
    const cached = await caches.match(requestUrl);
    return cached ? cache.put(requestUrl, cached) : cache.add(requestUrl);
  }))));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names
        .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map(name => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  if (!allowedHosts.has(url.hostname)) {
    return;
  }

  // Only this build's cache: a waiting worker's newer files must not leak
  // into a page still run by the old one.
  event.respondWith(
    caches.open(CACHE_NAME)
      .then(cache => cache.match(event.request))
      .then(response => response || fetch(event.request))
  );
});
