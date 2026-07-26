const CACHE_PREFIX = "license-lantern-static";
const CACHE_NAME = `${CACHE_PREFIX}-v3`;
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
const ALLOWED_LAUNCH_PARAMETERS = new Set([
  "view",
  "delivery",
]);
const GENERIC_NOTIFICATION_TITLE = "License Lantern check-in";
const GENERIC_NOTIFICATION_BODY =
  "You have a renewal item that needs attention.";

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

function safeLaunchTarget(value) {
  if (value === "/") return "/";
  if (typeof value !== "string") return "/";
  let url;
  try {
    url = new URL(value, self.location.origin);
  } catch {
    return "/";
  }
  if (
    url.origin !== self.location.origin ||
    url.pathname !== "/" ||
    url.hash ||
    [...url.searchParams.keys()].some(
      (parameter) => !ALLOWED_LAUNCH_PARAMETERS.has(parameter),
    ) ||
    url.searchParams.getAll("view").length !== 1 ||
    url.searchParams.get("view") !== "today" ||
    url.searchParams.getAll("delivery").length !== 1
  ) {
    return "/";
  }
  const deliveryId = url.searchParams.get("delivery") || "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      deliveryId,
    )
  ) {
    return "/";
  }
  const search = new URLSearchParams({
    view: "today",
    delivery: deliveryId,
  });
  return `/?${search.toString()}`;
}

function safeNotificationTag(value) {
  return typeof value === "string" &&
    /^[a-zA-Z0-9:_-]{1,160}$/.test(value)
    ? value
    : "license-lantern-check-in";
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    payload = {};
  }
  const launchTarget = safeLaunchTarget(
    payload.path ?? payload.url ?? payload.launchTarget,
  );
  event.waitUntil(
    self.registration.showNotification(GENERIC_NOTIFICATION_TITLE, {
      body: GENERIC_NOTIFICATION_BODY,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: safeNotificationTag(payload.tag),
      renotify: false,
      data: { launchTarget },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const launchTarget = safeLaunchTarget(
    event.notification.data?.launchTarget,
  );
  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existingClient =
        windowClients.find((client) => {
          try {
            const clientUrl = new URL(client.url);
            return (
              clientUrl.origin === self.location.origin &&
              clientUrl.pathname === "/"
            );
          } catch {
            return false;
          }
        }) ?? null;
      if (existingClient) {
        let targetClient = existingClient;
        if (launchTarget !== "/") {
          try {
            targetClient =
              (await existingClient.navigate(launchTarget)) ??
              existingClient;
          } catch {
            existingClient.postMessage({
              type: "OPEN_REMINDER",
              path: launchTarget,
            });
          }
        }
        await targetClient.focus();
        return;
      }
      await self.clients.openWindow(launchTarget);
    })(),
  );
});

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
