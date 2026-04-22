try {
  importScripts("./version.js");
} catch {
  // The app can still run without a build stamp in local previews.
}

const BUILD_ID = globalThis.PASSAGE_BUILD_ID || "dev";
const CACHE_PREFIX = "passage";
const CACHE_NAME = `${CACHE_PREFIX}-${BUILD_ID}`;
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./config.js",
  "./version.js",
  "./main.js",
  "./model.js",
  "./storage.js",
  "./sync.js",
  "./photos.js",
  "./manifest.webmanifest",
  "./icon.png"
];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(warmCache());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter(name => name.startsWith(`${CACHE_PREFIX}-`) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "./index.html"));
    return;
  }

  event.respondWith(networkFirst(request));
});

async function warmCache() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(APP_SHELL.map(async url => {
    try {
      const request = new Request(url, { cache: "reload" });
      const response = await fetch(request);
      if (response.ok) {
        await cache.put(request, response.clone());
      }
    } catch {
      // Cache what is reachable and let runtime fetches fill the rest.
    }
  }));
}

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);
    if (response.ok && shouldCache(request)) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;

    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl) || await cache.match("./");
      if (fallback) return fallback;
    }

    throw error;
  }
}

function shouldCache(request) {
  const url = new URL(request.url);
  return request.cache !== "no-store" && !url.search;
}
