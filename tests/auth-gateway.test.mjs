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
