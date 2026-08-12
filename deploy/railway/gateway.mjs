// Request routing for the Railway proxy, extracted from serve.mjs so it can
// be tested against a stub upstream without spawning wrangler.
import http from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { RateLimiter } from "./auth-routes.mjs";

const WIDGET_FEED_PATH = "/api/widget-summary";
// Basic-auth success cache: repeated identical credentials (the iOS app
// sends Basic on every request) cost one sha256 instead of one synchronous
// scrypt. Entries are keyed by a hash of the credentials, expire quickly,
// and the map is capped so junk cannot grow it without bound.
const BASIC_CACHE_TTL_MS = 5 * 60 * 1000;
const BASIC_CACHE_MAX = 1000;
const PAGE_ROUTES = new Map([
  ["/signup", "signup.html"],
  ["/login", "login.html"],
  ["/reset", "reset.html"],
]);

function digest(value) {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left, right) {
  return timingSafeEqual(digest(left), digest(right));
}

function decodeBasic(header) {
  if (!header?.startsWith("Basic ")) return null;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator === -1) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

export function createGateway({ users, openIdentity, authRoutes, store, pagesDir, upstreamPort }) {
  const pageCache = new Map();
  function servePage(res, name, status = 200) {
    if (!pageCache.has(name)) {
      pageCache.set(name, readFileSync(path.join(pagesDir, name)));
    }
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(pageCache.get(name));
  }

  const basicCache = new Map();
  // Gates the synchronous-scrypt path in store.authenticate: without it, a
  // stream of junk Basic headers would block the event loop for every client
  // (widget feed included). Cache hits above never touch this limiter, so a
  // legitimate client consumes at most ~one slot per cache TTL.
  const basicFailLimiter = new RateLimiter(20, 15 * 60 * 1000);

  function clientIp(req) {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) return String(forwarded).split(",")[0].trim();
    return req.socket?.remoteAddress ?? "unknown";
  }

  function basicIdentity(header, req) {
    const credentials = decodeBasic(header);
    if (!credentials) return null;
    const envUser = users.get(credentials.username);
    // Always compare so unknown usernames cost the same time.
    const expected = envUser?.password ?? "missing-user-placeholder";
    if (envUser && safeEqual(credentials.password, expected)) {
      return { email: envUser.email, displayName: envUser.displayName };
    }
    // DB accounts authenticate with email as the Basic username.
    const cacheKey = createHash("sha256")
      .update(`${credentials.username}:${credentials.password}`)
      .digest("hex");
    const cached = basicCache.get(cacheKey);
    if (cached) {
      if (cached.expires > Date.now()) return cached.identity;
      basicCache.delete(cacheKey);
    }
    if (!basicFailLimiter.allow(`basic:${clientIp(req)}`)) return null;
    const attempt = store.authenticate(credentials.username, credentials.password);
    if (attempt.ok) {
      const identity = { email: attempt.user.email, displayName: attempt.user.displayName };
      if (basicCache.size >= BASIC_CACHE_MAX) {
        // Maps iterate in insertion order; drop the oldest entry.
        basicCache.delete(basicCache.keys().next().value);
      }
      basicCache.set(cacheKey, { identity, expires: Date.now() + BASIC_CACHE_TTL_MS });
      return identity;
    }
    return null;
  }

  function proxy(req, res, identity, { keepAuthorization = false } = {}) {
    const headers = { ...req.headers };
    for (const name of Object.keys(headers)) {
      if (name.startsWith("oai-")) delete headers[name];
    }
    delete headers.connection;
    if (!keepAuthorization) delete headers.authorization;
    if (identity) {
      headers["oai-authenticated-user-email"] = identity.email;
      if (identity.displayName) {
        headers["oai-authenticated-user-full-name"] = encodeURIComponent(identity.displayName);
        headers["oai-authenticated-user-full-name-encoding"] = "percent-encoded-utf-8";
      }
    }
    const upstream = http.request(
      { host: "127.0.0.1", port: upstreamPort, method: req.method, path: req.url, headers },
      (workerResponse) => {
        res.writeHead(workerResponse.statusCode ?? 502, workerResponse.headers);
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
    const url = new URL(req.url ?? "/", "http://placeholder");
    const pathname = url.pathname;

    if (pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
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

    if (pathname === WIDGET_FEED_PATH) {
      proxy(req, res, null, { keepAuthorization: true });
      return;
    }

    // Open-identity mode keeps its historical behavior: everything proxies,
    // no public pages, no self-serve auth.
    if (openIdentity) {
      proxy(req, res, openIdentity);
      return;
    }

    if (pathname.startsWith("/auth/")) {
      await authRoutes.handle(req, res, pathname);
      return;
    }

    if (req.method === "GET" && pathname === "/verify") {
      const verified = store.verifyEmail(url.searchParams.get("token") ?? "");
      if (verified) {
        authRoutes.issueSessionCookie(res, verified.userId);
        res.writeHead(303, { location: "/" });
        res.end();
      } else {
        servePage(res, "verify.html");
      }
      return;
    }

    if (req.method === "GET" && PAGE_ROUTES.has(pathname)) {
      servePage(res, PAGE_ROUTES.get(pathname));
      return;
    }

    const sessionUser = authRoutes.userForRequest(req);
    const identity = sessionUser
      ? { email: sessionUser.email, displayName: sessionUser.displayName }
      : basicIdentity(req.headers.authorization, req);

    if (identity) {
      proxy(req, res, identity);
      return;
    }

    const wantsHtml = req.method === "GET" && (req.headers.accept ?? "").includes("text/html");
    if (wantsHtml && pathname === "/") {
      servePage(res, "landing.html");
      return;
    }
    if (wantsHtml) {
      res.writeHead(303, { location: "/login" });
      res.end();
      return;
    }
    res.writeHead(401, {
      "www-authenticate": 'Basic realm="iTrack", charset="UTF-8"',
      "content-type": "text/plain",
    });
    res.end("Authentication required");
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
