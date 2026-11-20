// Service Worker – MediCalc (Blutbild, Medikations-Plan, Zeitreihen, MediCalc, Spinnennetz, Befund)
// Strategy:
//   - Cache-first for app files (instant navigation, no network involved —
//     the app is offline-first by default. New versions are only ever
//     fetched when the user explicitly taps "Update" in the header, which
//     calls registration.update(); see update.js)
//   - Cache-first for external CDN (so offline still works)
// The app cache is tied to the app version; its old versions are purged on
// activation. The CDN cache is NOT versioned: CDN URLs are pinned to exact
// versions (…/lib@x.y.z/…) and therefore immutable — re-downloading OpenCV
// (8 MB) and the OCR models on every app update would be pure waste.
//
// A new version installs but then WAITS — there is deliberately no
// skipWaiting() in 'install'. Browsers check sw.js on their own during
// navigation; activating such an update immediately would reload the page
// under the user's hands. It is activated only via the "Update" button
// (update.js posts 'skipWaiting') or once every tab of the app was closed.
//
// Versioning: `npm run bump` changes APP_VERSION here AND "version" in
// manifest.json; `npm run check` verifies both and the precache list.

const APP_VERSION = '7.0.0';
// Only caches with this prefix belong to this app — other apps on the same
// origin (e.g. on the same GitHub Pages host) keep theirs.
const CACHE_PREFIX = 'blutbild-';
const CACHE_NAME = `${CACHE_PREFIX}v${APP_VERSION}`;
const CDN_CACHE = `${CACHE_PREFIX}cdn`;

// Files to pre-cache on install (core shell)
const PRECACHE_URLS = [
  './index.html',
  './blutbild.html',
  './radar.html',
  './befund.html',
  './app.js',
  './blood-data.js',
  './radar.js',
  './befund.js',
  './style.css',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-1024.png',
  './icons/icon-180.png',
  './favicon.ico',
  './apple-touch-icon.png',
  './apple-touch-icon-precomposed.png',
  './plan.html',
  './data.html',
  './medicalc.html',
  './update.js',
  './save-file.js',
  './bulk-import.js',
  './config-system.js',
  './config.js',
  './config-user.example.js',
  './chart-crosshair.js',
  './EKG.html',
  './header-menu.js',
  './fonts/plus-jakarta-sans-latin.woff2',
  './fonts/plus-jakarta-sans-latin-ext.woff2'
];

// Persönliche Dateien (nicht im Repository): config-user.js und die darin
// unter privateScripts genannten Module. Fehlen sie (z.B. auf GitHub Pages),
// bricht nichts ab — sie werden nur vorgeladen, wenn es sie gibt. Weil
// config-user.js hier per importScripts mitgelesen wird, prüft der Browser
// sie bei jeder Update-Suche mit: eine geänderte config-user.js zählt als
// neue Version (Update-Button), wie eine geänderte sw.js.
try { importScripts('./config-user.js'); } catch (_) { /* keine config-user.js */ }
const OPTIONAL_PRECACHE_URLS = ['./config-user.js', ...(
  (self.USER_CONFIG && Array.isArray(self.USER_CONFIG.privateScripts)) ? self.USER_CONFIG.privateScripts : []
).filter(src => typeof src === 'string' && /^[\w./-]+\.js$/.test(src) && !src.includes('..')).map(src => './' + src.replace(/^\.\//, ''))];

// CDN hosts that should use cache-first strategy for offline support.
// paddle-model-ecology.bj.bcebos.com serves the (multi-MB) PaddleOCR .tar
// model files — without the longer CDN_FETCH_TIMEOUT_MS and local caching
// this gets, a mobile connection can't finish the download in time and
// the download is aborted, which PaddleOCR then reports as a false "HTTP 503".
// OpenCV comes from cdn.jsdelivr.net (byte-identical to docs.opencv.org's
// build, but with CORS headers — see blutbild.html).
const CDN_ORIGINS = [
  'cdn.jsdelivr.net',
  'paddle-model-ecology.bj.bcebos.com',
];

// Entries from earlier versions that must not linger in the CDN cache:
// opencv.js used to be loaded no-cors from docs.opencv.org and cached as an
// opaque response (8 MB, status unverifiable).
const CDN_OBSOLETE = ['https://docs.opencv.org/4.5.2/opencv.js'];

// A stalled connection (flaky wifi, captive portal, ...) can leave fetch()
// pending indefinitely instead of rejecting, which would block the app even
// though a cached response is available. Abort and fall back after this long.
const FETCH_TIMEOUT_MS = 3000;

// CDN payloads (e.g. the PaddleOCR module + its WASM deps) are much larger
// than the app shell and can legitimately take longer than FETCH_TIMEOUT_MS
// on a normal connection. A short timeout here would abort a perfectly good
// download and fall through to the offline placeholder below.
const CDN_FETCH_TIMEOUT_MS = 60000;

// LLM API calls legitimately need a much larger budget than FETCH_TIMEOUT_MS —
// DeepSeek's reasoning models emit their first token only after a thinking
// phase. fetchWithTimeout clears its timer as soon as the response *headers*
// arrive, so this bounds time-to-first-byte, not the total streaming duration.
const AI_API_HOSTS = ['api.anthropic.com', 'api.deepseek.com'];
const AI_FETCH_TIMEOUT_MS = 60000;

// Precache fetches during install are all small same-origin files, but there
// are ~25 of them requested in parallel, some of which queue behind the
// browser's per-origin connection limit — longer than FETCH_TIMEOUT_MS, but
// still bounded, so one stalled connection can't leave the worker stuck in
// 'installing' forever (which update.js's own 30s client-side timeout would
// then have to wait out on every single "Update" click, without the install
// itself ever actually failing/retrying).
const INSTALL_FETCH_TIMEOUT_MS = 15000;

function fetchWithTimeout(request, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Safari refuses to render a navigation answered with a response that was
// itself redirected (e.g. a host rewriting index.html → ./). A fresh copy
// of the body without the "redirected" flag is accepted everywhere.
async function unredirect(response) {
  return new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers: response.headers });
}

// ── Install: pre-cache shell ──────────────────────────────────────────────────
// Plain cache.addAll() lets the browser serve these fetches from its own
// HTTP cache if the server's Cache-Control headers allow it — which, on a
// host that doesn't set strict no-cache for these files, can precache STALE
// copies even though the SW update itself was correctly detected (that
// detection is separately hardened via updateViaCache: 'none' in
// index.html's register() call, but that only covers sw.js itself, not the
// other files fetched here). { cache: 'reload' } forces each of these to
// bypass the HTTP cache and hit the network for real.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.all(
        PRECACHE_URLS.map(url => fetchWithTimeout(new Request(url, { cache: 'reload' }), INSTALL_FETCH_TIMEOUT_MS).then(response => {
          // Match cache.addAll()'s original all-or-nothing behavior: fail
          // the whole install if any single precache file 404s, instead of
          // silently caching an error page under that URL.
          if (!response.ok) throw new Error(`Precache fetch failed for ${url}: HTTP ${response.status}`);
          return response.redirected ? unredirect(response).then(r => cache.put(url, r)) : cache.put(url, response);
        })).concat(OPTIONAL_PRECACHE_URLS.map(url =>
          // Optional: fehlt die Datei oder schlägt der Abruf fehl, wird sie
          // einfach nicht vorgeladen — die Installation geht trotzdem durch.
          fetchWithTimeout(new Request(url, { cache: 'reload' }), INSTALL_FETCH_TIMEOUT_MS)
            .then(response => (response.ok && !response.redirected) ? cache.put(url, response) : null)
            .catch(() => null)
        ))
      ))
      // No skipWaiting() here — see the header comment.
  );
});

// ── Activate: delete all caches from previous versions ───────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME && key !== CDN_CACHE)
          .map(key => caches.delete(key))
      ))
      .then(() => caches.open(CDN_CACHE))
      .then(cache => Promise.all(CDN_OBSOLETE.map(url => cache.delete(url))))
      .then(() => self.clients.claim())
  );
});

// ── CDN download: once, completely, with one retry ───────────────────────────
// opencv.js is 8 MB. index.html warms it up while blutbild.html may request
// it at the same time; two parallel downloads halve the bandwidth and on a
// mobile connection one of them could abort. Concurrent requests for the
// same URL therefore share ONE download,
// which is written to the cache completely before anyone is answered from
// it. Network errors and 5xx answers are retried (with a short pause).
const CDN_MAX_ATTEMPTS = 3;
const cdnInflight = new Map();

function cdnFetchAndCache(request) {
  // Mode is part of the key: an opaque (no-cors) result must not be handed
  // to a cors request for the same URL.
  const key = `${request.mode} ${request.url}`;
  if (cdnInflight.has(key)) return cdnInflight.get(key);

  const download = (async () => {
    let lastError;
    for (let attempt = 1; attempt <= CDN_MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) await new Promise(r => setTimeout(r, 1500 * (attempt - 1)));
      try {
        const response = await fetchWithTimeout(request, CDN_FETCH_TIMEOUT_MS);
        // CDNs answer 503 now and then (docs.opencv.org did regularly) —
        // transient, a moment later the same request succeeds. Retry before
        // handing the error to the page.
        if (response.status >= 500 && attempt < CDN_MAX_ATTEMPTS) {
          lastError = new Error(`HTTP ${response.status}`);
          continue;
        }
        // Only verified responses are cached. An OPAQUE response (a no-cors
        // request: <script> without crossorigin, or a host without CORS
        // headers) hides its status — a 503 error page would be cached
        // forever. All CDN scripts are therefore loaded with
        // crossorigin="anonymous" from hosts that send CORS headers.
        if (!response.ok) return response;
        const cache = await caches.open(CDN_CACHE);
        await cache.put(request, response); // reads the whole body
        return await cache.match(request);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  })().finally(() => cdnInflight.delete(key));

  cdnInflight.set(key, download);
  return download;
}

// ── Fetch: hybrid strategy ────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // AI provider calls: never cached, never rewritten — just a generous TTB
  // budget. A plain reject here would surface as an unhelpful "Failed to
  // fetch" in befund.js; returning a body instead routes it through
  // describeHttpError() and shows a readable message.
  if (AI_API_HOSTS.includes(url.hostname)) {
    event.respondWith(
      fetchWithTimeout(event.request, AI_FETCH_TIMEOUT_MS).catch(() =>
        new Response('Zeitüberschreitung oder Netzwerkfehler bei der KI-Anfrage.', { status: 504 })
      )
    );
    return;
  }

  // Same-origin requests: cache-first. The app is offline-by-default — every
  // page navigation and asset load is served straight from the precached
  // shell with zero network round-trip (no more multi-second wait per page
  // switch while offline/on a bad connection). New app versions are only
  // ever fetched when the user explicitly taps "Update" (see update.js),
  // which drives the browser's own registration.update() check — that
  // mechanism always bypasses this handler by spec, so it isn't affected by
  // the cache-first strategy here.
  if (url.origin === self.location.origin && event.request.method === 'GET') {
    event.respondWith(
      // ignoreSearch: precached shell URLs (e.g. './EKG.html') have no query
      // string, but pages link to them with one (e.g. 'EKG.html?QT=350' for
      // the QT-simulator deep link) — without this, that's a cache miss and
      // the offline fallback fires even though the page itself is cached.
      caches.match(event.request, { ignoreSearch: true })
        .then(cached => {
          if (cached) return cached;
          // Not precached yet (e.g. a file added after the last install) —
          // fall back to network once, and cache it for next time.
          return fetchWithTimeout(event.request)
            .then(response => {
              if (response.status === 200 && !response.redirected) {
                const copy = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
              }
              return response;
            })
            .catch(() => new Response('Offline – Datei nicht im Cache verfügbar.', { status: 503 }));
        })
    );
    return;
  }

  // Known CDN hosts: cache-first (offline support for libraries)
  if (event.request.method === 'GET' && CDN_ORIGINS.includes(url.hostname)) {
    event.respondWith(
      caches.match(event.request)
        .then(response => {
          // An opaque entry (cached from a no-cors request) must never answer
          // a cors-mode request — the browser would reject it and the script
          // or module would fail to load. Refetch and replace it instead.
          if (response && !(response.type === 'opaque' && event.request.mode === 'cors')) return response;

          const download = cdnFetchAndCache(event.request);
          // Keep the worker alive until the (possibly 8 MB) body is fully in
          // the cache — even if the page that asked for it navigates away
          // (index.html prefetch → user opens blutbild.html).
          event.waitUntil(download.catch(() => {}));
          // Every consumer gets its own copy of the shared response.
          return download.then(r => r.clone());
        })
        .catch(() => {
          // Offline + not in cache: a <script> tag treats any 200
          // response as a successful load and fires `onload`, even if
          // the body is empty. Pages that assign to globals the real
          // script would have defined (e.g. opencv.js's
          // `cv.onRuntimeInitialized = ...`) then crash with a
          // ReferenceError instead of running their `onerror` handler.
          // Response.error() is a genuine network-error response, so the
          // browser fires `onerror`/rejects `import()` as it would for a
          // real failed request.
          if (event.request.destination === 'script') {
            return Response.error();
          }
          if (event.request.destination === 'image') {
            return new Response('', { status: 404 });
          }
          return new Response('Offline', { status: 503 });
        })
    );
    return;
  }

  // Any other cross-origin GET request is outside the offline shell (not
  // pre-cached, not a known CDN): pass it straight to the network, still
  // bounded by the timeout so it can't hang the page.
  if (event.request.method === 'GET') {
    event.respondWith(
      fetchWithTimeout(event.request).catch(() => new Response('Offline', { status: 503 }))
    );
    return;
  }

  // Passthrough for non-GET requests
  event.respondWith(fetchWithTimeout(event.request).catch(() => new Response('Offline', { status: 503 })));
});

// ── Message: force-update trigger from the app ────────────────────────────────
self.addEventListener('message', event => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

