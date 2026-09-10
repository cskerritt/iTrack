// Request routing for the Railway gateway, extracted from serve.mjs so it can
// be tested against a stub upstream without spawning wrangler.
//
// One credential: the signed `itrack_session` cookie. Routing decisions use
// the request path and the Accept header only; the client's UA string is
// never consulted (no browser or bot sniffing).
import http from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import { brotliCompressSync, gzipSync, constants as zlib } from "node:zlib";
import { safeNextPath } from "./auth-routes.mjs";

const PAGE_ROUTES = new Map([
  ["/signup", "signup.html"],
  ["/login", "login.html"],
  ["/reset", "reset.html"],
  ["/verify", "verify.html"],
]);
// Served without a session, with caching. Everything here is either a static
// file the build copies into dist/client or a worker route that reads no
// identity (the manifest).
const PUBLIC_EXACT = new Set([
  "/robots.txt",
  "/sitemap.xml",
  "/favicon.ico",
  "/manifest.webmanifest",
  "/og.png",
  "/offline.html",
  "/sw.js",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
]);
const PUBLIC_PREFIXES = ["/icons/", "/assets/", "/_next/static/", "/ocr/"];
const PUBLIC_CACHE_CONTROL = "public, max-age=300";
// Query keys the service worker's notificationclick opens `/` with. A bare
// `/` is the landing page; `/` carrying one of these is an app deep link and
// must round-trip through /login?next= instead of being swallowed.
const LAUNCH_PARAMETERS = ["delivery", "view"];

export function isPublicPath(pathname) {
  return PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function wantsHtml(req) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const accept = req.headers.accept;
  if (accept === undefined || accept === "") return true;
  return accept.includes("text/html") || accept.includes("*/*");
}

// Spec 3.1 header set. Applied before routing so every branch — pages, JSON
// errors, redirects, proxied worker responses — carries it. CSP is
// report-only in Wave 1; Wave 5 enforces it once the redesign settles its
// font and script needs.
export const SECURITY_HEADERS = Object.freeze({
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(self), microphone=(), geolocation=()",
  "x-frame-options": "DENY",
  "content-security-policy-report-only":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; frame-ancestors 'none'",
});

export function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

export function createGateway({ authRoutes, store, pagesDir, upstreamPort, now = () => Date.now() }) {
  const pageCache = new Map();
  function loadPage(name) {
    if (!pageCache.has(name)) {
      const raw = readFileSync(path.join(pagesDir, name));
      pageCache.set(name, {
        raw,
        gzip: gzipSync(raw, { level: 9 }),
        br: brotliCompressSync(raw, {
          params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: raw.length },
        }),
      });
    }
    return pageCache.get(name);
  }

  function chooseEncoding(req) {
    const offered = String(req.headers["accept-encoding"] ?? "");
    if (/\bbr\b/.test(offered)) return "br";
    if (/\bgzip\b/.test(offered)) return "gzip";
    return null;
  }

  function servePage(req, res, name, { cacheControl = PUBLIC_CACHE_CONTROL, status = 200 } = {}) {
    const page = loadPage(name);
    const encoding = chooseEncoding(req);
    const body = encoding ? page[encoding] : page.raw;
    const headers = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": cacheControl,
      vary: "accept-encoding",
      "content-length": body.length,
    };
    if (encoding) headers["content-encoding"] = encoding;
    res.writeHead(status, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  }

  function sendJson(req, res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  function proxy(req, res, target, identity, { publicAsset = false, extraHeaders = {} } = {}) {
    const headers = { ...req.headers };
    for (const name of Object.keys(headers)) {
      if (name.startsWith("oai-")) delete headers[name];
    }
    delete headers.connection;
    delete headers.authorization;
    if (identity) {
      headers["oai-authenticated-user-email"] = identity.email;
      if (identity.displayName) {
        headers["oai-authenticated-user-full-name"] = encodeURIComponent(identity.displayName);
        headers["oai-authenticated-user-full-name-encoding"] = "percent-encoded-utf-8";
      }
    }
    const upstream = http.request(
      { host: "127.0.0.1", port: upstreamPort, method: req.method, path: target, headers },
      (workerResponse) => {
        const responseHeaders = { ...workerResponse.headers, ...extraHeaders, ...SECURITY_HEADERS };
        if (publicAsset && !responseHeaders["cache-control"]) {
          responseHeaders["cache-control"] = PUBLIC_CACHE_CONTROL;
        }
        res.writeHead(workerResponse.statusCode ?? 502, responseHeaders);
        workerResponse.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      console.error("proxy upstream error", error);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
      }
      res.end("Upstream unavailable");
    });
    req.pipe(upstream);
  }

  async function handleRequest(req, res) {
    applySecurityHeaders(res);
    const rawTarget = req.url ?? "/";
    // critic-07: a `//host/path` target parses as host + path and a `//x`
    // target classifies differently from `/x`. Reject anything that does not
    // start with exactly one slash, then collapse repeated slashes inside the
    // path so routing and proxying agree on one normalised target.
    if (!rawTarget.startsWith("/") || rawTarget.startsWith("//")) {
      sendJson(req, res, 400, { error: "bad_request_target" });
      return;
    }
    const url = new URL(rawTarget, "http://placeholder");
    const pathname = url.pathname.replace(/\/{2,}/g, "/");
    const target = pathname + url.search;

    if (pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : "ok");
      return;
    }

    if (
      pathname === "/__scheduled" ||
      pathname.startsWith("/cdn-cgi/") ||
      pathname.startsWith("/internal/")
    ) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    if (pathname.startsWith("/auth/")) {
      await authRoutes.handle(req, res, pathname);
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && PAGE_ROUTES.has(pathname)) {
      // The verify page is reached from a secret URL; keep it out of caches.
      servePage(req, res, PAGE_ROUTES.get(pathname), {
        cacheControl: pathname === "/verify" ? "no-store" : PUBLIC_CACHE_CONTROL,
      });
      return;
    }

    if (isPublicPath(pathname)) {
      proxy(req, res, target, null, { publicAsset: true });
      return;
    }

    const session = authRoutes.sessionForRequest(req);
    if (session) {
      const identity = { email: session.user.email, displayName: session.user.displayName };
      proxy(req, res, target, identity);
      return;
    }

    if (wantsHtml(req) && !pathname.startsWith("/api/")) {
      const isLaunchLink = LAUNCH_PARAMETERS.some((key) => url.searchParams.has(key));
      if (pathname === "/" && !isLaunchLink) {
        servePage(req, res, "landing.html");
        return;
      }
      const next = safeNextPath(target);
      res.writeHead(303, {
        location: `/login?next=${encodeURIComponent(next)}`,
        "cache-control": "no-store",
      });
      res.end();
      return;
    }
    sendJson(req, res, 401, { error: "unauthenticated" });
  }

  // Exception barrier: a throwing route (bad token, unreadable page file,
  // store error) must produce a 500, never an unhandled rejection that takes
  // down the supervisor process.
  return async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (error) {
      console.error("gateway error", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
      }
      if (!res.writableEnded) {
        res.end("Internal error");
      }
    }
  };
}
