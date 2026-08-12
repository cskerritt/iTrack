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
    const landing = await get(base, "/", { accept: "text/html" });
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /Free during beta/);
    const deep = await get(base, "/credentials", { accept: "text/html" });
    assert.equal(deep.status, 303);
    assert.equal(deep.headers.get("location"), "/login");
    const api = await get(base, "/api/export");
    assert.equal(api.status, 401);
    assert.match(api.headers.get("www-authenticate"), /Basic realm="iTrack"/);
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
