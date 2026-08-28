/// <reference lib="webworker" />

// Precaching service worker for offline solo play. Built by tsconfig.sw.json to
// public/service-worker.js (scope "/") and registered as a module worker.
//
// scripts/build-sw.mjs fills in the two tokens below at build time:
// __DISCO_PRECACHE_MANIFEST__ with every asset under public/, and
// __DISCO_SW_VERSION__ with a hash of their contents so this file changes
// whenever any asset does.

declare const __DISCO_PRECACHE_MANIFEST__: ReadonlyArray<{ url: string; revision: string }>;
declare const __DISCO_SW_VERSION__: string;

const sw = self as unknown as ServiceWorkerGlobalScope;

const PRECACHE_MANIFEST = __DISCO_PRECACHE_MANIFEST__;
const CACHE_NAME = 'disco-precache-' + __DISCO_SW_VERSION__;
const PRECACHE_PATHS = new Set(PRECACHE_MANIFEST.map(entry => entry.url));

// Disco has no client-side routing: every navigation is served this one
// document. The manifest lists it as "/index.html" (its path under public/),
// but the production host (Cloudflare) serves it at "/" and 307-redirects
// "/index.html" -> "/". So it is keyed in the cache as "/index.html" and
// requested from "/".
const APP_SHELL_KEY = '/index.html';
const APP_SHELL_URL = '/';

// Precache in small batches rather than one big Promise.all, to be gentle on
// the origin.
const PRECACHE_BATCH_SIZE = 6;

// A Response whose `redirected` flag is true cannot be returned from
// respondWith() for a navigation request — the browser fails the navigation
// with net::ERR_FAILED. Copy any precache fetch that followed a redirect into a
// fresh, non-redirected Response before it is stored or served.
async function withoutRedirect(response: Response): Promise<Response> {
  if (!response.redirected) return response;
  const body = await response.blob();
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

sw.addEventListener('install', event => {
  // Take over immediately. A predecessor worker that serves a broken response
  // bricks every page, and a bricked page can never post SKIP_WAITING, so this
  // worker must be able to replace it without the page's cooperation.
  void sw.skipWaiting();

  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      for (let i = 0; i < PRECACHE_MANIFEST.length; i += PRECACHE_BATCH_SIZE) {
        const batch = PRECACHE_MANIFEST.slice(i, i + PRECACHE_BATCH_SIZE);
        await Promise.all(
          batch.map(async entry => {
            const requestUrl = entry.url === APP_SHELL_KEY ? APP_SHELL_URL : entry.url;
            // 'reload' bypasses the HTTP cache so nothing stale is precached.
            const response = await fetch(new Request(requestUrl, { cache: 'reload' }));
            if (!response.ok) {
              throw new Error(`precache fetch failed for ${requestUrl}: ${response.status}`);
            }
            await cache.put(entry.url, await withoutRedirect(response));
          }),
        );
      }
    })(),
  );
});

sw.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(key => key.startsWith('disco-precache-') && key !== CACHE_NAME)
          .map(key => caches.delete(key)),
      );
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener('message', event => {
  const data = event.data as { type?: string } | null;
  if (data?.type === 'SKIP_WAITING') {
    void sw.skipWaiting();
  }
});

sw.addEventListener('fetch', event => {
  const { request } = event;

  // Only same-origin GETs are ours. The API is always cross-origin, so leaving
  // those alone lets the browser handle (and, offline, fail) them natively.
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== sw.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigate());
    return;
  }

  const { pathname } = new URL(request.url);
  if (PRECACHE_PATHS.has(pathname)) {
    event.respondWith(cacheFirst(pathname, request));
    return;
  }

  event.respondWith(networkFirst(request));
});

// Every navigation is answered with the app shell: from cache if precached,
// otherwise straight from the network (fetching the shell itself, since an
// unknown deep path would 404).
async function navigate(): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(APP_SHELL_KEY);
  if (cached) return cached;
  return withoutRedirect(await fetch(new Request(APP_SHELL_URL, { cache: 'no-store' })));
}

async function cacheFirst(cacheKey: string, request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  return fetch(request);
}

async function networkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  try {
    return await fetch(request);
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}
