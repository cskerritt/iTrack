import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AuthStore } from "../deploy/railway/auth.mjs";
import {
  RateLimiter,
  createAuthRoutes,
  readCookie,
  signValue,
  unsignValue,
  SESSION_COOKIE,
} from "../deploy/railway/auth-routes.mjs";

const SECRET = "test-secret";

function makeRoutes({ sendResult = { ok: true } } = {}) {
  let clock = 1_700_000_000_000;
  const store = new AuthStore(":memory:", { now: () => clock });
  const sent = [];
  const routes = createAuthRoutes({
    store,
    secret: SECRET,
    baseUrl: "https://itrack.test",
    now: () => clock,
    sendEmail: async (message) => { sent.push(message); return sendResult; },
  });
  return { store, routes, sent, tick: (ms) => (clock += ms) };
}

function fakeReq({ method = "POST", url = "/", body = "", headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: "itrack.test", origin: "https://itrack.test", ...headers };
  req.socket = { remoteAddress: "203.0.113.9" };
  process.nextTick(() => {
    if (body) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function fakeRes() {
  return {
    statusCode: null, headers: {}, body: "",
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers ?? {}); },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(chunk) { this.body += chunk ?? ""; this.ended = true; },
  };
}

async function post(routes, pathname, body, headers) {
  const req = fakeReq({ url: pathname, body, headers });
  const res = fakeRes();
  const handled = await routes.handle(req, res, pathname);
  return { handled, res };
}

const form = (fields) => new URLSearchParams(fields).toString();

test("cookie signing round-trips and rejects tampering", () => {
  const signed = signValue("abc123", SECRET);
  assert.equal(unsignValue(signed, SECRET), "abc123");
  assert.equal(unsignValue(signed + "x", SECRET), null);
  assert.equal(unsignValue("abc123.forged", SECRET), null);
  assert.equal(unsignValue("no-dot", SECRET), null);
  const req = { headers: { cookie: `a=1; ${SESSION_COOKIE}=${signed}; b=2` } };
  assert.equal(readCookie(req, SESSION_COOKIE), signed);
  assert.equal(readCookie({ headers: {} }, SESSION_COOKIE), null);
});

test("rate limiter enforces fixed windows per key", () => {
  let clock = 0;
  const limiter = new RateLimiter(2, 1000, { now: () => clock });
  assert.equal(limiter.allow("k"), true);
  assert.equal(limiter.allow("k"), true);
  assert.equal(limiter.allow("k"), false);
  assert.equal(limiter.allow("other"), true);
  clock = 1001;
  assert.equal(limiter.allow("k"), true);
});

test("signup happy path sends verification and redirects", async () => {
  const { routes, sent } = makeRoutes();
  const { handled, res } = await post(routes, "/auth/signup",
    form({ email: "new@e.co", name: "New User", password: "longenough1" }));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, "/signup?sent=1");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "new@e.co");
  assert.equal(sent[0].subject, "Verify your iTrack email");
  assert.match(sent[0].text, /https:\/\/itrack\.test\/verify\?token=[A-Za-z0-9_-]+/);
});

test("signup maps duplicate, invalid, and mail-down outcomes", async () => {
  const { routes } = makeRoutes();
  await post(routes, "/auth/signup", form({ email: "dup@e.co", name: "D", password: "longenough1" }));
  let { res } = await post(routes, "/auth/signup", form({ email: "dup@e.co", name: "D", password: "longenough1" }));
  assert.equal(res.headers.location, "/signup?error=email-taken");
  ({ res } = await post(routes, "/auth/signup", form({ email: "bad@no-tld.x", name: "B", password: "longenough1" })));
  assert.equal(res.headers.location, "/signup?error=invalid");
  ({ res } = await post(routes, "/auth/signup", form({ email: "ok@e.co", name: "O", password: "short" })));
  assert.equal(res.headers.location, "/signup?error=invalid");
  const down = makeRoutes({ sendResult: { ok: false, error: "email-not-configured" } });
  ({ res } = await post(down.routes, "/auth/signup", form({ email: "x@e.co", name: "X", password: "longenough1" })));
  assert.equal(res.headers.location, "/signup?sent=1&mail=down");
});

test("signup rate limit trips at 5 per hour per ip", async () => {
  const { routes } = makeRoutes();
  for (let i = 0; i < 5; i += 1) {
    await post(routes, "/auth/signup", form({ email: `u${i}@e.co`, name: "U", password: "longenough1" }));
  }
  const { res } = await post(routes, "/auth/signup", form({ email: "u6@e.co", name: "U", password: "longenough1" }));
  assert.equal(res.headers.location, "/signup?error=rate-limited");
});

test("login flow: unverified, verified, wrong password, cookie, logout", async () => {
  const { store, routes, sent } = makeRoutes();
  await post(routes, "/auth/signup", form({ email: "l@e.co", name: "L", password: "longenough1" }));
  let { res } = await post(routes, "/auth/login", form({ email: "l@e.co", password: "longenough1" }));
  assert.equal(res.headers.location, "/login?error=unverified");
  const token = sent[0].text.match(/token=([A-Za-z0-9_-]+)/)[1];
  assert.ok(store.verifyEmail(token));
  ({ res } = await post(routes, "/auth/login", form({ email: "l@e.co", password: "longenough1" })));
  assert.equal(res.headers.location, "/");
  const setCookie = res.headers["set-cookie"];
  assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const signed = setCookie.split(";")[0].split("=")[1];
  const user = routes.userForRequest({ headers: { cookie: `${SESSION_COOKIE}=${signed}` } });
  assert.equal(user.email, "l@e.co");
  ({ res } = await post(routes, "/auth/login", form({ email: "l@e.co", password: "wrong-pass-1" })));
  assert.equal(res.headers.location, "/login?error=bad-credentials");
  ({ res } = await post(routes, "/auth/logout", "", { cookie: `${SESSION_COOKIE}=${signed}` }));
  assert.equal(res.headers.location, "/");
  assert.equal(routes.userForRequest({ headers: { cookie: `${SESSION_COOKIE}=${signed}` } }), null);
});

test("reset flow: request always says sent, reset changes password", async () => {
  const { store, routes, sent } = makeRoutes();
  await post(routes, "/auth/signup", form({ email: "r@e.co", name: "R", password: "longenough1" }));
  store.verifyEmail(sent[0].text.match(/token=([A-Za-z0-9_-]+)/)[1]);
  let { res } = await post(routes, "/auth/request-reset", form({ email: "r@e.co" }));
  assert.equal(res.headers.location, "/reset?sent=1");
  ({ res } = await post(routes, "/auth/request-reset", form({ email: "ghost@e.co" })));
  assert.equal(res.headers.location, "/reset?sent=1", "no enumeration");
  const resetToken = sent[1].text.match(/token=([A-Za-z0-9_-]+)/)[1];
  ({ res } = await post(routes, "/auth/reset", form({ token: resetToken, password: "short" })));
  assert.equal(res.headers.location, `/reset?error=invalid&token=${resetToken}`);
  ({ res } = await post(routes, "/auth/reset", form({ token: resetToken, password: "another-good-one" })));
  assert.equal(res.headers.location, "/login?reset=1");
  ({ res } = await post(routes, "/auth/reset", form({ token: "bogus", password: "another-good-one" })));
  assert.equal(res.headers.location, "/reset?error=expired");
  assert.equal(store.authenticate("r@e.co", "another-good-one").ok, true);
});

test("origin mismatch is rejected, unknown auth paths 404", async () => {
  const { routes } = makeRoutes();
  const { res } = await post(routes, "/auth/login",
    form({ email: "a@e.co", password: "longenough1" }), { origin: "https://evil.example" });
  assert.equal(res.statusCode, 403);
  const { handled, res: notFound } = await post(routes, "/auth/unknown", "");
  assert.equal(handled, true);
  assert.equal(notFound.statusCode, 404);
  const req = fakeReq({ method: "GET", url: "/auth/login" });
  const getRes = fakeRes();
  assert.equal(await routes.handle(req, getRes, "/auth/login"), true);
  assert.equal(getRes.statusCode, 404);
});
