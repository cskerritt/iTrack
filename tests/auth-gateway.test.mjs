import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStore } from "../deploy/railway/auth.mjs";
import { createAuthRoutes, SESSION_COOKIE } from "../deploy/railway/auth-routes.mjs";
import { createGateway } from "../deploy/railway/gateway.mjs";

const pagesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "deploy", "railway", "pages",
);

async function startStack({ openIdentity = null } = {}) {
  let lastUpstream = null;
  const upstream = http.createServer((req, res) => {
    lastUpstream = { url: req.url, headers: { ...req.headers } };
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("app-response");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const store = new AuthStore(":memory:");
  const sent = [];
  const authRoutes = createAuthRoutes({
    store,
    secret: "gw-secret",
    baseUrl: "http://gw.test",
    sendEmail: async (message) => { sent.push(message); return { ok: true }; },
  });
  const users = new Map([
    ["chris", { password: "env-pass-123", email: "chris@kwvrs.com", displayName: "Chris" }],
  ]);
  const gateway = http.createServer(
    createGateway({
      users, openIdentity, authRoutes, store, pagesDir,
      upstreamPort: upstream.address().port,
    }),
  );
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${gateway.address().port}`;

  return {
    base, store, sent,
    upstreamSeen: () => lastUpstream,
    close: async () => {
      await new Promise((resolve) => gateway.close(resolve));
      await new Promise((resolve) => upstream.close(resolve));
    },
  };
}

const get = (base, pathname, headers = {}) =>
  fetch(`${base}${pathname}`, { headers, redirect: "manual" });

// The production iOS app is a Capacitor WKWebView shell whose UA has NO
// "Safari/" token; every mainstream browser carries one (desktop Firefox
// carries "Firefox/" instead).
const WKWEBVIEW_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

test("gateway routing end to end", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const { base } = stack;

  await t.test("healthz open, internal paths blocked", async () => {
    assert.equal((await get(base, "/healthz")).status, 200);
    assert.equal((await get(base, "/internal/run-scheduled")).status, 404);
    assert.equal((await get(base, "/__scheduled")).status, 404);
    assert.equal((await get(base, "/cdn-cgi/x")).status, 404);
  });

  await t.test("anonymous browser gets landing at /, login redirect elsewhere, 401 for API", async () => {
    const landing = await get(base, "/", { accept: "text/html", "user-agent": SAFARI_UA });
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /Free during beta/);
    const deep = await get(base, "/credentials", { accept: "text/html", "user-agent": SAFARI_UA });
    assert.equal(deep.status, 303);
    assert.equal(deep.headers.get("location"), "/login");
    const firefox = await get(base, "/credentials", {
      accept: "text/html",
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
    });
    assert.equal(firefox.status, 303, "desktop Firefox (no Safari/ token) still redirects");
    const api = await get(base, "/api/export");
    assert.equal(api.status, 401);
    assert.match(api.headers.get("www-authenticate"), /Basic realm="iTrack"/);
  });

  // iOS REGRESSION TEST: the Capacitor WKWebView shell signs in by answering
  // the 401 Basic challenge. It sends GET / with a text/html Accept, no
  // Authorization header, no cookie, and a UA without "Safari/". If the
  // landing page (or the /login redirect) ever swallows this challenge, the
  // shipped iOS app can never present its sign-in prompt.
  await t.test("WKWebView shell (no Safari/ token) receives the 401 Basic challenge, not HTML", async () => {
    const shell = await get(base, "/", { accept: "text/html", "user-agent": WKWEBVIEW_UA });
    assert.equal(shell.status, 401);
    assert.equal(
      shell.headers.get("www-authenticate"),
      'Basic realm="iTrack", charset="UTF-8"',
    );
    const deep = await get(base, "/credentials", { accept: "text/html", "user-agent": WKWEBVIEW_UA });
    assert.equal(deep.status, 401, "deep paths challenge the shell instead of redirecting");
    assert.equal(
      deep.headers.get("www-authenticate"),
      'Basic realm="iTrack", charset="UTF-8"',
    );
  });

  await t.test("public pages are served", async () => {
    for (const pathname of ["/signup", "/login", "/reset"]) {
      const page = await get(base, pathname, { accept: "text/html" });
      assert.equal(page.status, 200, pathname);
      assert.match(page.headers.get("content-type"), /text\/html/);
    }
  });

  await t.test("env Basic user proxies with identity headers, authorization stripped", async () => {
    const auth = `Basic ${Buffer.from("chris:env-pass-123").toString("base64")}`;
    const response = await get(base, "/credentials", { authorization: auth });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "app-response");
    const seen = stack.upstreamSeen();
    assert.equal(seen.headers["oai-authenticated-user-email"], "chris@kwvrs.com");
    assert.equal(seen.headers["oai-authenticated-user-full-name"], "Chris");
    assert.equal(seen.headers.authorization, undefined);
  });

  await t.test("client-supplied oai headers are stripped", async () => {
    const auth = `Basic ${Buffer.from("chris:env-pass-123").toString("base64")}`;
    await get(base, "/credentials", {
      authorization: auth,
      "oai-authenticated-user-email": "forged@evil.example",
    });
    assert.equal(
      stack.upstreamSeen().headers["oai-authenticated-user-email"],
      "chris@kwvrs.com",
    );
  });

  await t.test("widget feed bypasses auth and keeps its bearer token", async () => {
    const response = await get(base, "/api/widget-summary", { authorization: "Bearer widget-token" });
    assert.equal(response.status, 200);
    const seen = stack.upstreamSeen();
    assert.equal(seen.headers.authorization, "Bearer widget-token");
    assert.equal(seen.headers["oai-authenticated-user-email"], undefined);
  });

  await t.test("signup -> verify -> session cookie -> app; Basic works for DB user", async () => {
    const signup = await fetch(`${base}/auth/signup`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "db@e.co", name: "DB User", password: "longenough1" }).toString(),
    });
    assert.equal(signup.status, 303);
    const token = stack.sent[0].text.match(/token=([A-Za-z0-9_-]+)/)[1];
    const verify = await get(base, `/verify?token=${token}`);
    assert.equal(verify.status, 303);
    assert.equal(verify.headers.get("location"), "/");
    const cookie = verify.headers.get("set-cookie").split(";")[0];
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
    const app = await get(base, "/", { accept: "text/html", cookie });
    assert.equal(app.status, 200);
    assert.equal(await app.text(), "app-response");
    assert.equal(stack.upstreamSeen().headers["oai-authenticated-user-email"], "db@e.co");
    const basic = `Basic ${Buffer.from("db@e.co:longenough1").toString("base64")}`;
    const viaBasic = await get(base, "/credentials", { authorization: basic });
    assert.equal(viaBasic.status, 200);
    assert.equal(stack.upstreamSeen().headers["oai-authenticated-user-email"], "db@e.co");
    const reused = await get(base, `/verify?token=${token}`, { accept: "text/html" });
    assert.equal(reused.status, 200, "used token renders the error page");
  });
});

test("a throwing store cannot crash the gateway (exception barrier)", async (t) => {
  const stubStore = {
    verifyEmail() { throw new Error("boom"); },
    authenticate() { return { ok: false, reason: "bad-credentials" }; },
  };
  const authRoutes = createAuthRoutes({
    store: stubStore,
    secret: "gw-secret",
    baseUrl: "http://gw.test",
    sendEmail: async () => ({ ok: true }),
  });
  const gateway = http.createServer(
    createGateway({
      users: new Map(),
      openIdentity: null,
      authRoutes,
      store: stubStore,
      pagesDir,
      upstreamPort: 1,
    }),
  );
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const base = `http://127.0.0.1:${gateway.address().port}`;

  const verify = await get(base, "/verify?token=x");
  assert.equal(verify.status, 500, "a throwing route responds 500 instead of crashing");
  const health = await get(base, "/healthz");
  assert.equal(health.status, 200, "the server survives the thrown error");
});

test("junk Basic floods are rate limited without breaking sessions", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const { base, store } = stack;
  const ip = { "x-forwarded-for": "203.0.113.9" };

  const { verifyToken } = store.createUser({
    email: "flood@e.co", displayName: "Flood", password: "correct-pass-11",
  });
  const verified = await get(base, `/verify?token=${verifyToken}`);
  assert.equal(verified.status, 303);
  const cookie = verified.headers.get("set-cookie").split(";")[0];

  const bad = `Basic ${Buffer.from("flood@e.co:wrong-pass").toString("base64")}`;
  for (let attempt = 0; attempt < 21; attempt += 1) {
    const response = await get(base, "/api/export", { ...ip, authorization: bad });
    assert.equal(response.status, 401);
  }

  const good = `Basic ${Buffer.from("flood@e.co:correct-pass-11").toString("base64")}`;
  const blocked = await get(base, "/api/export", { ...ip, authorization: good });
  assert.equal(blocked.status, 401, "the limiter gates the scrypt path for the flooded IP");

  const viaSession = await get(base, "/credentials", { ...ip, accept: "text/html", cookie });
  assert.equal(viaSession.status, 200, "session-cookie auth is unaffected by the Basic limiter");
  assert.equal(await viaSession.text(), "app-response");
});

test("correct DB Basic credentials are served from the success cache", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const { base, store } = stack;
  const ip = { "x-forwarded-for": "198.51.100.7" };

  const { verifyToken } = store.createUser({
    email: "cache@e.co", displayName: "Cache", password: "correct-pass-22",
  });
  store.verifyEmail(verifyToken);

  const original = store.authenticate.bind(store);
  let scryptCalls = 0;
  store.authenticate = (...args) => { scryptCalls += 1; return original(...args); };

  const auth = `Basic ${Buffer.from("cache@e.co:correct-pass-22").toString("base64")}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await get(base, "/credentials", { ...ip, authorization: auth });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "app-response");
    assert.equal(
      stack.upstreamSeen().headers["oai-authenticated-user-email"],
      "cache@e.co",
    );
  }
  assert.equal(scryptCalls, 1, "the second identical request is served from the cache");
});

test("rate limiting keys on the LAST x-forwarded-for entry (Railway appends the real IP)", async (t) => {
  // The first XFF entries are client-supplied; only the last one is written
  // by Railway's edge. If the limiter keyed on the first entry, varying a
  // fake prefix would mint a fresh budget on every request.
  const stack = await startStack();
  t.after(() => stack.close());
  const { base, store } = stack;

  const { verifyToken } = store.createUser({
    email: "spoof@e.co", displayName: "Spoof", password: "correct-pass-33",
  });
  store.verifyEmail(verifyToken);

  const bad = `Basic ${Buffer.from("spoof@e.co:wrong-pass").toString("base64")}`;
  for (let attempt = 0; attempt < 21; attempt += 1) {
    const response = await get(base, "/api/export", {
      "x-forwarded-for": `1.2.3.${attempt}, 10.0.0.9`,
      authorization: bad,
    });
    assert.equal(response.status, 401);
  }

  const good = `Basic ${Buffer.from("spoof@e.co:correct-pass-33").toString("base64")}`;
  const blocked = await get(base, "/api/export", {
    "x-forwarded-for": "9.9.9.9, 10.0.0.9",
    authorization: good,
  });
  assert.equal(
    blocked.status, 401,
    "a fresh fake FIRST entry must not grant a fresh budget: the shared LAST entry is still limited",
  );
});

test("open-identity mode bypasses all public pages", async (t) => {
  const stack = await startStack({
    openIdentity: { email: "open@e.co", displayName: "Open" },
  });
  t.after(() => stack.close());
  const landing = await get(stack.base, "/", { accept: "text/html" });
  assert.equal(landing.status, 200);
  assert.equal(await landing.text(), "app-response");
  assert.equal(stack.upstreamSeen().headers["oai-authenticated-user-email"], "open@e.co");
  const page = await get(stack.base, "/signup", { accept: "text/html" });
  assert.equal(await page.text(), "app-response", "signup proxies to app in open mode");
});
