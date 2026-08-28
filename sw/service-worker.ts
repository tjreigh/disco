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

// Every navigation is served this document — Disco has no client-side routing.
const APP_SHELL_URL = '/index.html';

// Precache in small batches rather than one big Promise.all, to be gentle on
// the origin.
const PRECACHE_BATCH_SIZE = 6;

sw.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      for (let i = 0; i < PRECACHE_MANIFEST.length; i += PRECACHE_BATCH_SIZE) {
        const batch = PRECACHE_MANIFEST.slice(i, i + PRECACHE_BATCH_SIZE);
        await Promise.all(
          batch.map(async entry => {
            // 'reload' bypasses the HTTP cache so nothing stale is precached.
            const response = await fetch(new Request(entry.url, { cache: 'reload' }));
            if (!response.ok) {
              throw new Error(`precache fetch failed for ${entry.url}: ${response.status}`);
            }
            await cache.put(entry.url, response);
          }),
        );
      }
      // No skipWaiting() here: a first install activates on its own, while an
      // update waits until the page posts SKIP_WAITING (see below). That's what
      // lets the client offer a non-blocking "reload to update" toast.
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
    event.respondWith(cacheFirst(APP_SHELL_URL, request));
    return;
  }

  const { pathname } = new URL(request.url);
  if (PRECACHE_PATHS.has(pathname)) {
    event.respondWith(cacheFirst(pathname, request));
    return;
  }

  event.respondWith(networkFirst(request));
});

async function cacheFirst(cacheKey: string, request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch (error) {
    // Fall back to the shell for navigations if the cache was evicted offline.
    if (request.mode === 'navigate') {
      const shell = await cache.match(APP_SHELL_URL);
      if (shell) return shell;
    }
    throw error;
  }
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
