// Request routing for the Railway proxy, extracted from serve.mjs so it can
// be tested against a stub upstream without spawning wrangler.
import http from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";

const WIDGET_FEED_PATH = "/api/widget-summary";
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

  function basicIdentity(header) {
    const credentials = decodeBasic(header);
    if (!credentials) return null;
    const envUser = users.get(credentials.username);
    // Always compare so unknown usernames cost the same time.
    const expected = envUser?.password ?? "missing-user-placeholder";
    if (envUser && safeEqual(credentials.password, expected)) {
      return { email: envUser.email, displayName: envUser.displayName };
    }
    // DB accounts authenticate with email as the Basic username.
    const attempt = store.authenticate(credentials.username, credentials.password);
    if (attempt.ok) {
      return { email: attempt.user.email, displayName: attempt.user.displayName };
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

  return async (req, res) => {
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
      : basicIdentity(req.headers.authorization);

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
  };
}
