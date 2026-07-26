const CACHE_PREFIX = "license-lantern-static";
const CACHE_NAME = `${CACHE_PREFIX}-v2`;
const PRECACHE = [
  "/offline.html",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];
const RUNTIME_STATIC_PATHS = [
  "/og.png",
  "/ocr/worker.min.js",
  "/ocr/core/tesseract-core-lstm.wasm.js",
  "/ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js",
  "/ocr/core/tesseract-core-simd-lstm.wasm.js",
  "/ocr/lang/eng.traineddata.gz",
];
const CACHEABLE_STATIC_PATHS = new Set([...PRECACHE, ...RUNTIME_STATIC_PATHS]);
const AUTH_PATHS = [
  "/signin-with-chatgpt",
  "/signout-with-chatgpt",
  "/callback",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isCacheableStaticPath(pathname) {
  return CACHEABLE_STATIC_PATHS.has(pathname);
}

function isPathOrDescendant(pathname, rootPath) {
  return pathname === rootPath || pathname.startsWith(`${rootPath}/`);
}

function shouldBypass(request, url) {
  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return true;
  }
  if (
    request.headers.has("authorization") ||
    request.headers.has("range") ||
    isPathOrDescendant(url.pathname, "/api") ||
    AUTH_PATHS.some((path) => isPathOrDescendant(url.pathname, path))
  ) {
    return true;
  }
  return false;
}

function isSafeStaticResponse(response, requestedUrl) {
  if (!response.ok || response.type !== "basic" || response.redirected) {
    return false;
  }
  const responseUrl = new URL(response.url);
  if (
    responseUrl.origin !== self.location.origin ||
    responseUrl.pathname !== requestedUrl.pathname
  ) {
    return false;
  }
  return !/\bno-store\b/i.test(response.headers.get("cache-control") || "");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (shouldBypass(request, url)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        const fallback = await cache.match("/offline.html");
        return (
          fallback ||
          new Response("License Lantern is offline. Reconnect and try again.", {
            status: 503,
            headers: {
              "cache-control": "no-store",
              "content-type": "text/plain; charset=utf-8",
            },
          })
        );
      }),
    );
    return;
  }

  if (url.search || !isCacheableStaticPath(url.pathname)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (isSafeStaticResponse(response, url)) {
        await cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
