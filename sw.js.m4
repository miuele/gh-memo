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

const CACHE_NAME = 'notes-cache-v1';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  if (!allowedHosts.has(url.hostname)) {
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request))
  );
});
