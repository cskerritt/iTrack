import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStore } from "../deploy/railway/auth.mjs";
import { createAuthRoutes, SESSION_COOKIE, signValue } from "../deploy/railway/auth-routes.mjs";
import { createGateway } from "../deploy/railway/gateway.mjs";

const pagesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "deploy", "railway", "pages",
);
export const BASE_URL = "http://gw.test";

export async function startStack({ upstreamHandler } = {}) {
  let lastUpstream = null;
  const upstream = http.createServer((req, res) => {
    lastUpstream = { url: req.url, method: req.method, headers: { ...req.headers } };
    if (upstreamHandler) return upstreamHandler(req, res);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("app-response");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const clock = { now: 1_800_000_000_000 };
  const now = () => clock.now;
  const store = new AuthStore(":memory:", { now });
  const sent = [];
  const authRoutes = createAuthRoutes({
    store,
    secret: "gw-secret",
    baseUrl: BASE_URL,
    now,
    sleep: async () => {},
    sendEmail: async (message) => { sent.push(message); return { ok: true }; },
  });
  const gateway = http.createServer(
    createGateway({ authRoutes, store, pagesDir, upstreamPort: upstream.address().port, now }),
  );
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${gateway.address().port}`;

  return {
    base, store, sent, clock,
    upstreamSeen: () => lastUpstream,
    close: async () => {
      await new Promise((resolve) => gateway.close(resolve));
      await new Promise((resolve) => upstream.close(resolve));
    },
  };
}

export const get = (base, pathname, headers = {}) =>
  fetch(`${base}${pathname}`, { headers, redirect: "manual" });
export const head = (base, pathname, headers = {}) =>
  fetch(`${base}${pathname}`, { method: "HEAD", headers, redirect: "manual" });
export const postForm = (base, pathname, fields, headers = {}) =>
  fetch(`${base}${pathname}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL, ...headers },
    body: new URLSearchParams(fields).toString(),
  });

// Creates a verified account and returns a Cookie header value for it.
export async function signedInCookie(stack, email = "user@e.co", password = "correct-pass-11") {
  const { userId } = stack.store.createVerifiedUser({ email, displayName: "User", password });
  const raw = stack.store.createSession(userId);
  return `${SESSION_COOKIE}=${signValue(raw, "gw-secret")}`;
}

const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const WKWEBVIEW_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

test("gateway routes by path and Accept, never by User-Agent", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const { base } = stack;

  await t.test("healthz open, internal paths blocked", async () => {
    assert.equal((await get(base, "/healthz")).status, 200);
    assert.equal((await get(base, "/internal/run-scheduled")).status, 404);
    assert.equal((await get(base, "/__scheduled")).status, 404);
    assert.equal((await get(base, "/cdn-cgi/x")).status, 404);
  });

  await t.test("GET / with an HTML Accept serves the landing page for every client", async () => {
    for (const headers of [
      { accept: "text/html" },
      { accept: "text/html", "user-agent": GOOGLEBOT_UA },
      { accept: "text/html", "user-agent": WKWEBVIEW_UA },
      { accept: "*/*" },
      {},
    ]) {
      const landing = await get(base, "/", headers);
      assert.equal(landing.status, 200, JSON.stringify(headers));
      assert.match(landing.headers.get("content-type"), /text\/html/);
      assert.match(await landing.text(), /Every credential\./);
      assert.equal(landing.headers.get("set-cookie"), null, "landing sets no cookie");
    }
  });

  await t.test("HEAD mirrors GET", async () => {
    const landing = await head(base, "/", { accept: "text/html" });
    assert.equal(landing.status, 200);
    assert.equal(await landing.text(), "");
    const deep = await head(base, "/credentials", { accept: "text/html" });
    assert.equal(deep.status, 303);
    const api = await head(base, "/api/workspace", { accept: "application/json" });
    assert.equal(api.status, 401);
  });

  await t.test("other HTML paths 303 to /login with a same-origin next", async () => {
    const deep = await get(base, "/credentials", { accept: "text/html" });
    assert.equal(deep.status, 303);
    assert.equal(deep.headers.get("location"), "/login?next=%2Fcredentials");
    const withQuery = await get(base, "/credentials/abc?tab=plan", { accept: "text/html", "user-agent": WKWEBVIEW_UA });
    assert.equal(withQuery.headers.get("location"), "/login?next=%2Fcredentials%2Fabc%3Ftab%3Dplan");
    const launch = await get(base, "/?delivery=push-7", { accept: "text/html" });
    assert.equal(launch.status, 303, "a push deep link on / is carried into next, not swallowed by the landing");
    assert.equal(launch.headers.get("location"), "/login?next=%2F%3Fdelivery%3Dpush-7");
    const utm = await get(base, "/?utm_source=x", { accept: "text/html" });
    assert.equal(utm.status, 200, "a marketing query on / still lands");
  });

  await t.test("/api/* and non-HTML requests get a JSON 401 with no WWW-Authenticate", async () => {
    for (const [pathname, headers] of [
      ["/api/workspace", { accept: "application/json" }],
      ["/api/workspace", { accept: "text/html" }],
      ["/api/export", {}],
      ["/credentials", { accept: "application/json" }],
    ]) {
      const response = await get(base, pathname, headers);
      assert.equal(response.status, 401, pathname);
      assert.match(response.headers.get("content-type"), /application\/json/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("www-authenticate"), null);
      assert.deepEqual(await response.json(), { error: "unauthenticated" });
    }
    const post = await fetch(`${base}/api/workspace`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(post.status, 401);
  });

  await t.test("Basic credentials are ignored, not accepted", async () => {
    const basic = `Basic ${Buffer.from("user@e.co:correct-pass-11").toString("base64")}`;
    const response = await get(base, "/api/workspace", { authorization: basic, accept: "application/json" });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), null);
  });

  await t.test("public allowlist proxies without auth", async () => {
    for (const pathname of [
      "/robots.txt", "/sitemap.xml", "/favicon.ico", "/manifest.webmanifest", "/icons/x.png",
      "/og.png", "/offline.html", "/sw.js", "/assets/app.js", "/_next/static/chunk.js", "/ocr/worker.min.js",
      "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png",
    ]) {
      const response = await get(base, pathname);
      assert.equal(response.status, 200, pathname);
      assert.equal(await response.text(), "app-response", pathname);
      assert.equal(stack.upstreamSeen().headers["oai-authenticated-user-email"], undefined, pathname);
      assert.equal(response.headers.get("cache-control"), "public, max-age=300", pathname);
    }
  });

  await t.test("auth pages are served as static HTML", async () => {
    for (const pathname of ["/signup", "/login", "/reset", "/verify?token=abc"]) {
      const page = await get(base, pathname, { accept: "text/html" });
      assert.equal(page.status, 200, pathname);
      assert.match(page.headers.get("content-type"), /text\/html/);
    }
  });

  await t.test("the widget feed no longer bypasses auth", async () => {
    const response = await get(base, "/api/widget-summary", { authorization: "Bearer widget-token" });
    assert.equal(response.status, 401);
  });

  await t.test("a session cookie proxies with identity headers; client oai headers are stripped", async () => {
    const cookie = await signedInCookie(stack);
    const response = await get(base, "/credentials", {
      accept: "text/html", cookie, "oai-authenticated-user-email": "forged@evil.example",
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "app-response");
    const seen = stack.upstreamSeen();
    assert.equal(seen.headers["oai-authenticated-user-email"], "user@e.co");
    assert.equal(seen.headers["oai-authenticated-user-full-name"], "User");
    assert.equal(seen.headers.authorization, undefined);
    assert.equal(seen.headers.cookie, cookie, "the session cookie still reaches the worker unchanged");
  });

  await t.test("signup -> verify -> session cookie -> app", async () => {
    const signup = await postForm(base, "/auth/signup", { email: "db@e.co", name: "DB User", password: "longenough1" });
    assert.equal(signup.status, 303);
    const token = stack.sent[0].text.match(/token=([A-Za-z0-9_-]+)/)[1];
    const verifyPage = await get(base, `/verify?token=${token}`, { accept: "text/html" });
    assert.equal(verifyPage.status, 200, "GET /verify renders a page and consumes nothing");
    assert.equal(verifyPage.headers.get("set-cookie"), null);
    assert.ok(stack.store.verifyEmail(token), "token is still valid after the GET");
    const login = await postForm(base, "/auth/login", { email: "db@e.co", password: "longenough1" });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
    const app = await get(base, "/", { accept: "text/html", cookie });
    assert.equal(app.status, 200);
    assert.equal(await app.text(), "app-response");
    assert.equal(stack.upstreamSeen().headers["oai-authenticated-user-email"], "db@e.co");
  });
});

test("a throwing store cannot crash the gateway (exception barrier)", async (t) => {
  const stubStore = {
    sessionUser() { throw new Error("boom"); },
  };
  const authRoutes = createAuthRoutes({
    store: stubStore, secret: "gw-secret", baseUrl: BASE_URL, sendEmail: async () => ({ ok: true }),
  });
  const gateway = http.createServer(
    createGateway({ authRoutes, store: stubStore, pagesDir, upstreamPort: 1 }),
  );
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const base = `http://127.0.0.1:${gateway.address().port}`;
  // A correctly signed cookie so the gateway actually reaches the throwing store.
  const app = await get(base, "/credentials", { accept: "text/html", cookie: `${SESSION_COOKIE}=${signValue("x", "gw-secret")}` });
  assert.equal(app.status, 500, "a throwing route responds 500 instead of crashing");
  const health = await get(base, "/healthz");
  assert.equal(health.status, 200, "the server survives the thrown error");
});


const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(self), microphone=(), geolocation=()",
  "x-frame-options": "DENY",
  "content-security-policy-report-only":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; frame-ancestors 'none'",
};

test("request-target normalisation, security headers, compression and caching", async (t) => {
  const stack = await startStack({
    upstreamHandler: (req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "x-frame-options": "SAMEORIGIN" });
      res.end(`upstream saw ${req.url}`);
    },
  });
  t.after(() => stack.close());
  const { base } = stack;

  await t.test("targets that do not start with exactly one slash are rejected", async () => {
    for (const target of ["//login", "//internal/run-scheduled", "//xmlrpc.php"]) {
      const response = await fetch(`${base}${target}`, { headers: { accept: "text/html" }, redirect: "manual" });
      assert.equal(response.status, 400, target);
      assert.deepEqual(await response.json(), { error: "bad_request_target" });
    }
  });

  await t.test("repeated slashes inside the path collapse before routing and proxying", async () => {
    const blocked = await get(base, "/internal//run-scheduled");
    assert.equal(blocked.status, 404);
    const cookie = await signedInCookie(stack);
    const proxied = await get(base, "/credentials//abc?x=1", { cookie, accept: "text/html" });
    assert.equal(proxied.status, 200);
    assert.equal(await proxied.text(), "upstream saw /credentials/abc?x=1");
    assert.equal(stack.upstreamSeen().url, "/credentials/abc?x=1");
  });

  await t.test("every response carries the security header set, including proxied ones", async () => {
    const cookie = await signedInCookie(stack, "hdr@e.co");
    const responses = [
      await get(base, "/", { accept: "text/html" }),
      await get(base, "/credentials", { accept: "text/html" }),
      await get(base, "/api/workspace", { accept: "application/json" }),
      await get(base, "/healthz"),
      await get(base, "/robots.txt"),
      await get(base, "/credentials", { accept: "text/html", cookie }),
      await get(base, "//bad"),
    ];
    for (const response of responses) {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        assert.equal(response.headers.get(name), value, `${name} on ${response.url} (${response.status})`);
      }
    }
    assert.equal(responses[5].headers.get("x-frame-options"), "DENY", "gateway header wins over upstream SAMEORIGIN");
  });

  await t.test("public pages are compressed on request and cached for five minutes", async () => {
    // Node's fetch injects `accept-encoding: gzip, deflate` when none is set,
    // so the uncompressed baseline must decline compression explicitly.
    const plain = await get(base, "/", { accept: "text/html", "accept-encoding": "identity" });
    assert.equal(plain.headers.get("content-encoding"), null);
    assert.equal(plain.headers.get("cache-control"), "public, max-age=300");
    assert.equal(plain.headers.get("vary"), "accept-encoding");
    const rawLength = Number(plain.headers.get("content-length"));
    assert.ok(rawLength > 1000);

    const gz = await fetch(`${base}/`, { headers: { accept: "text/html", "accept-encoding": "gzip" } });
    assert.equal(gz.headers.get("content-encoding"), "gzip");
    // Node's fetch transparently decodes; check the wire bytes via a raw socket-free route: content-length differs.
    assert.ok(Number(gz.headers.get("content-length")) < rawLength, "gzip body is smaller");
    assert.match(await gz.text(), /Every credential\./);

    const br = await fetch(`${base}/`, { headers: { accept: "text/html", "accept-encoding": "br, gzip" } });
    assert.equal(br.headers.get("content-encoding"), "br", "brotli preferred when offered");
    assert.match(await br.text(), /Every credential\./);

    const login = await get(base, "/login", { accept: "text/html" });
    assert.equal(login.headers.get("cache-control"), "public, max-age=300");
    const verify = await get(base, "/verify?token=x", { accept: "text/html" });
    assert.equal(verify.headers.get("cache-control"), "no-store", "the token-bearing page is never cached");
  });

  await t.test("HEAD on a compressed page sends headers only", async () => {
    const response = await fetch(`${base}/`, { method: "HEAD", headers: { accept: "text/html", "accept-encoding": "gzip" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-encoding"), "gzip");
    assert.equal(await response.text(), "");
  });
});

test("authenticated requests re-issue the session cookie once it is a day old", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const { base, clock } = stack;
  const cookie = await signedInCookie(stack, "slide@e.co");
  const fresh = await get(base, "/credentials", { accept: "text/html", cookie });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get("set-cookie"), null);
  clock.now += 24 * 60 * 60 * 1000 + 1;
  const stale = await get(base, "/api/workspace", { accept: "application/json", cookie });
  assert.equal(stale.status, 200);
  const reissued = stale.headers.get("set-cookie");
  assert.ok(reissued, "cookie re-issued");
  assert.equal(reissued.split(";")[0], cookie);
  assert.match(reissued, /Max-Age=2592000/);
  const again = await get(base, "/api/workspace", { accept: "application/json", cookie });
  assert.equal(again.headers.get("set-cookie"), null, "only once per day");
});

test("POST /api/client-error logs one structured line and is rate limited per session", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const { base } = stack;
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  t.after(() => { console.error = original; });
  const cookie = await signedInCookie(stack, "beacon@e.co");
  const report = { message: "TypeError: x is null", stack: "at a\nat b", route: "/credentials/abc", userAgent: "UA", at: "2026-09-10T12:00:00.000Z" };
  const post = (body, headers = {}) => fetch(`${base}/api/client-error`, {
    method: "POST", headers: { "content-type": "application/json", cookie, ...headers }, body,
  });
  const ok = await post(JSON.stringify(report));            // slot 1 of 10
  assert.equal(ok.status, 204);
  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0]);
  assert.equal(logged.event, "client_error");
  assert.equal(logged.message, report.message);
  assert.equal(logged.route, "/credentials/abc");
  assert.equal(logged.session, true);
  assert.equal(logged.stack, "at a\nat b");
  assert.equal((await post("not json")).status, 400);        // slot 2 (limiter counts before parsing)
  assert.equal((await post(JSON.stringify({ ...report, stack: "x".repeat(9000) }))).status, 413); // slot 3
  assert.equal(lines.length, 1, "rejected beacons are not logged");
  for (let i = 0; i < 7; i += 1) assert.equal((await post(JSON.stringify(report))).status, 204); // slots 4-10
  const limited = await post(JSON.stringify(report));
  assert.equal(limited.status, 429);
  assert.equal(lines.length, 8, "the 11th beacon is dropped, not logged");
  const anonymous = await fetch(`${base}/api/client-error`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report),
  });
  assert.equal(anonymous.status, 204, "an unauthenticated beacon is accepted (keyed by IP)");
  assert.equal(JSON.parse(lines[8]).session, false);
  assert.equal((await get(base, "/api/client-error")).status, 405);
});
