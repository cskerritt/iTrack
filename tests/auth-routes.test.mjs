import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AuthStore } from "../deploy/railway/auth.mjs";
import {
  RateLimiter,
  clientIp,
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
  const sleeps = [];
  const routes = createAuthRoutes({
    store,
    secret: SECRET,
    baseUrl: "https://itrack.test",
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); },
    sendEmail: async (message) => { sent.push(message); return sendResult; },
  });
  return { store, routes, sent, sleeps, tick: (ms) => (clock += ms) };
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

test("rate limiter sweeps expired buckets once the map grows large", () => {
  let clock = 0;
  const limiter = new RateLimiter(2, 1000, { now: () => clock });
  for (let i = 0; i < 50001; i += 1) limiter.allow(`spoofed-${i}`);
  assert.equal(limiter.buckets.size, 50001);
  clock = 1001; // every existing bucket is now expired
  assert.equal(limiter.allow("fresh-key"), true);
  assert.equal(limiter.buckets.size, 1, "expired buckets are swept before the insert");
});

test("clientIp uses the LAST x-forwarded-for entry, falling back to the socket", () => {
  // Railway's edge appends the real client IP last; earlier entries are
  // client-controlled and must never key a rate limit.
  const socket = { remoteAddress: "203.0.113.9" };
  assert.equal(clientIp({ headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.9" }, socket }), "10.0.0.9");
  assert.equal(clientIp({ headers: { "x-forwarded-for": " 10.0.0.9 " }, socket }), "10.0.0.9");
  assert.equal(clientIp({ headers: {}, socket }), "203.0.113.9");
  assert.equal(clientIp({ headers: {} }), "unknown");
});

test("signup happy path sends verification and redirects", async () => {
  const { routes, sent } = makeRoutes();
  const { handled, res } = await post(routes, "/auth/signup",
    form({ email: "new@e.co", name: "New User", password: "longenough1" }));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, "/signup?sent=1&email=new%40e.co");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "new@e.co");
  assert.equal(sent[0].subject, "Verify your iTrack email");
  assert.match(sent[0].text, /https:\/\/itrack\.test\/verify\?token=[A-Za-z0-9_-]+/);
});

test("signup is enumeration-neutral: unverified duplicate re-sends, verified duplicate says sent silently", async () => {
  const { store, routes, sent } = makeRoutes();
  let { res } = await post(routes, "/auth/signup", form({ email: "dup@e.co", name: "D", password: "longenough1" }));
  assert.equal(res.headers.location, "/signup?sent=1&email=dup%40e.co");
  ({ res } = await post(routes, "/auth/signup", form({ email: "dup@e.co", name: "D2", password: "another-pass1" })));
  assert.equal(res.headers.location, "/signup?sent=1&email=dup%40e.co");
  assert.equal(sent.length, 2, "unverified duplicate gets a fresh link");
  store.verifyEmail(sent[1].text.match(/token=([A-Za-z0-9_-]+)/)[1], "another-pass1");
  ({ res } = await post(routes, "/auth/signup", form({ email: "dup@e.co", name: "D3", password: "third-pass-1" })));
  assert.equal(res.headers.location, "/signup?sent=1&email=dup%40e.co", "verified duplicate looks identical");
  assert.equal(sent.length, 2, "…but nothing is sent and nothing changes");
  assert.equal(store.authenticate("dup@e.co", "another-pass1").ok, true);
  ({ res } = await post(routes, "/auth/signup", form({ email: "bad@no-tld.x", name: "B", password: "longenough1" })));
  assert.equal(res.headers.location, "/signup?error=invalid");
  ({ res } = await post(routes, "/auth/signup", form({ email: "ok@e.co", name: "O", password: "short" })));
  assert.equal(res.headers.location, "/signup?error=invalid");
  const down = makeRoutes({ sendResult: { ok: false, error: "mail_unconfigured" } });
  ({ res } = await post(down.routes, "/auth/signup", form({ email: "x@e.co", name: "X", password: "longenough1" })));
  assert.equal(res.headers.location, "/signup?sent=1&mail=unconfigured&email=x%40e.co");
  const failed = makeRoutes({ sendResult: { ok: false, error: "send_failed" } });
  ({ res } = await post(failed.routes, "/auth/signup", form({ email: "y@e.co", name: "Y", password: "longenough1" })));
  assert.equal(res.headers.location, "/signup?sent=1&mail=failed&email=y%40e.co");
});

test("verify is a POST: needs the token AND the current password, consumes the token, signs in, fails closed", async () => {
  const { store, routes, sent } = makeRoutes();
  await post(routes, "/auth/signup", form({ email: "v@e.co", name: "V", password: "longenough1" }));
  const token = sent[0].text.match(/token=([A-Za-z0-9_-]+)/)[1];
  let { res } = await post(routes, "/auth/verify", form({ token: "bogus", password: "longenough1" }));
  assert.equal(res.headers.location, "/verify?error=expired");
  assert.equal(res.headers["set-cookie"], undefined);
  ({ res } = await post(routes, "/auth/verify", form({ token, password: "wrong-pass-11" })));
  assert.equal(res.headers.location, `/verify?error=password&token=${token}`, "wrong password: back to the confirm form");
  assert.equal(res.headers["set-cookie"], undefined);
  ({ res } = await post(routes, "/auth/verify", form({ token })));
  assert.equal(res.headers.location, `/verify?error=password&token=${token}`, "missing password: same answer");
  assert.equal(res.headers["set-cookie"], undefined);
  assert.equal(store.authenticate("v@e.co", "longenough1").reason, "unverified", "nothing verified yet");
  ({ res } = await post(routes, "/auth/verify", form({ token, password: "longenough1" })));
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, "/");
  assert.match(res.headers["set-cookie"], new RegExp(`^${SESSION_COOKIE}=`));
  ({ res } = await post(routes, "/auth/verify", form({ token, password: "longenough1" })));
  assert.equal(res.headers.location, "/verify?error=expired", "single use");
});

test("owner-first squat over HTTP: the owner cannot confirm the squatter's password and recovers by signing up again", async () => {
  const { store, routes, sent } = makeRoutes();
  const link = (i) => sent[i].text.match(/token=([A-Za-z0-9_-]+)/)[1];
  await post(routes, "/auth/signup", form({ email: "own@e.co", name: "Owner", password: "owner-pass-111" }));
  await post(routes, "/auth/signup", form({ email: "own@e.co", name: "Squatter", password: "squatter-pass-1" }),
    { "x-forwarded-for": "198.51.100.7" });
  assert.equal(sent.length, 2, "both links went to the owner's inbox");
  let { res } = await post(routes, "/auth/verify", form({ token: link(0), password: "owner-pass-111" }));
  assert.equal(res.headers.location, "/verify?error=expired", "the owner's first link is dead");
  ({ res } = await post(routes, "/auth/resend", form({ email: "own@e.co" })));
  assert.equal(res.headers.location, "/login?sent=1");
  assert.equal(sent.length, 3, "the resend issues a link for the row the squatter now owns");
  for (const token of [link(1), link(2)]) {
    ({ res } = await post(routes, "/auth/verify", form({ token, password: "owner-pass-111" })));
    assert.equal(res.headers.location, `/verify?error=password&token=${token}`);
    assert.equal(res.headers["set-cookie"], undefined, "no session for a password the owner never set");
  }
  assert.equal(store.authenticate("own@e.co", "squatter-pass-1").reason, "unverified", "the squatter's password was never confirmed");
  await post(routes, "/auth/signup", form({ email: "own@e.co", name: "Owner", password: "owner-pass-222" }));
  ({ res } = await post(routes, "/auth/verify", form({ token: link(3), password: "owner-pass-222" })));
  assert.equal(res.headers.location, "/");
  assert.match(res.headers["set-cookie"], new RegExp(`^${SESSION_COOKIE}=`));
  assert.equal(store.authenticate("own@e.co", "owner-pass-222").ok, true);
  assert.equal(store.authenticate("own@e.co", "squatter-pass-1").ok, false);
});

test("verify shares the per-account limiter with login: 10 wrong passwords lock the address for both", async () => {
  const { store, routes, sent, sleeps } = makeRoutes();
  await post(routes, "/auth/signup", form({ email: "acct@e.co", name: "A", password: "longenough1" }));
  const token = sent[0].text.match(/token=([A-Za-z0-9_-]+)/)[1];
  for (let i = 0; i < 10; i += 1) {
    const { res } = await post(routes, "/auth/verify", form({ token, password: "wrong-pass-1" }),
      { "x-forwarded-for": `10.0.${i}.1` });
    assert.equal(res.headers.location, `/verify?error=password&token=${token}`);
  }
  assert.deepEqual(sleeps, [], "no delay while under the limit");
  let scrypts = 0;
  for (const method of ["verifyEmail", "authenticate"]) {
    const original = store[method].bind(store);
    store[method] = (...args) => { scrypts += 1; return original(...args); };
  }
  let { res } = await post(routes, "/auth/verify", form({ token, password: "longenough1" }), { "x-forwarded-for": "10.9.9.9" });
  assert.equal(res.headers.location, `/verify?error=password&token=${token}`, "even the right password is refused while tripped");
  assert.equal(res.headers["set-cookie"], undefined);
  ({ res } = await post(routes, "/auth/login", form({ email: "acct@e.co", password: "longenough1" }), { "x-forwarded-for": "10.9.9.8" }));
  assert.equal(res.headers.location, "/login?error=bad-credentials", "login is locked by the same bucket");
  assert.deepEqual(sleeps, [2000, 2000]);
  assert.equal(scrypts, 0, "scrypt is not burned for a tripped account");
  assert.ok(store.peekVerifyToken(token), "the link survives the lockout for a retry after the window");
});

test("verify counts against the per-IP login limiter and keeps the token for a retry", async () => {
  const { routes, sent } = makeRoutes();
  await post(routes, "/auth/signup", form({ email: "ip@e.co", name: "I", password: "longenough1" }));
  const token = sent[0].text.match(/token=([A-Za-z0-9_-]+)/)[1];
  for (let i = 0; i < 10; i += 1) {
    await post(routes, "/auth/login", form({ email: `x${i}@e.co`, password: "wrong-pass-1" }));
  }
  const { res } = await post(routes, "/auth/verify", form({ token, password: "longenough1" }));
  assert.equal(res.headers.location, `/verify?error=rate-limited&token=${token}`);
  assert.equal(res.headers["set-cookie"], undefined);
});

test("resend has its own email field, its own limiter, and neutral outcomes", async () => {
  const { routes, sent } = makeRoutes();
  await post(routes, "/auth/signup", form({ email: "r@e.co", name: "R", password: "longenough1" }));
  let { res } = await post(routes, "/auth/resend", form({ email: "r@e.co" }));
  assert.equal(res.headers.location, "/login?sent=1");
  assert.equal(sent.length, 2);
  ({ res } = await post(routes, "/auth/resend", form({ email: "r@e.co", return: "signup" })));
  assert.equal(res.headers.location, "/signup?sent=1&email=r%40e.co");
  ({ res } = await post(routes, "/auth/resend", form({ email: "ghost@e.co" })));
  assert.equal(res.headers.location, "/login?sent=1", "unknown address answers the same");
  assert.equal(sent.length, 3, "nothing sent for an unknown address");
  ({ res } = await post(routes, "/auth/resend", form({ email: "r@e.co" })));
  assert.equal(res.headers.location, "/login?error=rate-limited", "4th resend in the hour is limited");
  ({ res } = await post(routes, "/auth/request-reset", form({ email: "r@e.co" })));
  assert.equal(res.headers.location, "/reset?sent=1", "the reset limiter is a separate bucket");
});

test("signup rate limit trips at 5 per hour per ip", async () => {
  const { routes } = makeRoutes();
  for (let i = 0; i < 5; i += 1) {
    await post(routes, "/auth/signup", form({ email: `u${i}@e.co`, name: "U", password: "longenough1" }));
  }
  const { res } = await post(routes, "/auth/signup", form({ email: "u6@e.co", name: "U", password: "longenough1" }));
  assert.equal(res.headers.location, "/signup?error=rate-limited");
});

test("login flow: unverified and wrong password share one generic error; verified logs in; logout clears", async () => {
  const { store, routes, sent } = makeRoutes();
  await post(routes, "/auth/signup", form({ email: "l@e.co", name: "L", password: "longenough1" }));
  let { res } = await post(routes, "/auth/login", form({ email: "l@e.co", password: "longenough1" }));
  assert.equal(res.headers.location, "/login?error=bad-credentials", "unverified is not distinguishable");
  const token = sent[0].text.match(/token=([A-Za-z0-9_-]+)/)[1];
  assert.ok(store.verifyEmail(token, "longenough1"));
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

test("login honours a same-origin next and collapses everything else to /", async () => {
  const { store, routes } = makeRoutes();
  store.createVerifiedUser({ email: "n@e.co", displayName: "N", password: "longenough1" });
  for (const [next, expected] of [
    ["/credentials/abc?tab=plan", "/credentials/abc?tab=plan"],
    ["/?delivery=push-1", "/?delivery=push-1"],
    ["https://evil.example/", "/"],
    ["//evil.example/", "/"],
    ["/login", "/"],
    ["/auth/logout", "/"],
    ["/x\\y", "/"],
    ["", "/"],
  ]) {
    const { res } = await post(routes, "/auth/login", form({ email: "n@e.co", password: "longenough1", next }));
    assert.equal(res.headers.location, expected, `next=${next}`);
  }
});

test("per-account limiter: after 10 failures the account answers generically after a 2 s delay", async () => {
  const { store, routes, sleeps } = makeRoutes();
  store.createVerifiedUser({ email: "acct@e.co", displayName: "A", password: "longenough1" });
  for (let i = 0; i < 10; i += 1) {
    const { res } = await post(routes, "/auth/login", form({ email: "acct@e.co", password: "wrong-pass-1" }),
      { "x-forwarded-for": `10.0.${i}.1` });
    assert.equal(res.headers.location, "/login?error=bad-credentials");
  }
  assert.deepEqual(sleeps, [], "no delay while under the limit");
  let authenticateCalls = 0;
  const original = store.authenticate.bind(store);
  store.authenticate = (...args) => { authenticateCalls += 1; return original(...args); };
  const { res } = await post(routes, "/auth/login", form({ email: "acct@e.co", password: "longenough1" }),
    { "x-forwarded-for": "10.9.9.9" });
  assert.equal(res.headers.location, "/login?error=bad-credentials", "even the right password is refused while tripped");
  assert.deepEqual(sleeps, [2000]);
  assert.equal(authenticateCalls, 0, "scrypt is not burned for a tripped account");
});

test("CSRF: /auth/* POST without Origin and Referer is rejected; a matching Referer suffices", async () => {
  const { routes } = makeRoutes();
  let { res } = await post(routes, "/auth/login", form({ email: "a@e.co", password: "longenough1" }), { origin: undefined });
  assert.equal(res.statusCode, 403);
  ({ res } = await post(routes, "/auth/login", form({ email: "a@e.co", password: "longenough1" }),
    { origin: undefined, referer: "https://itrack.test/login?next=%2F" }));
  assert.equal(res.statusCode, 303);
  ({ res } = await post(routes, "/auth/login", form({ email: "a@e.co", password: "longenough1" }),
    { origin: "https://itrack.test.evil.example" }));
  assert.equal(res.statusCode, 403);
});

test("emails never carry the display name and failures never log the link", async () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.map(String).join(" "));
  try {
    const { routes, sent } = makeRoutes({ sendResult: { ok: false, error: "send_failed" } });
    await post(routes, "/auth/signup", form({
      email: "lure@e.co", name: "URGENT: your RN license lapses Friday", password: "longenough1",
    }));
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0].text, /URGENT/);
    assert.doesNotMatch(sent[0].html, /URGENT/);
    assert.match(sent[0].text, /^Hi,\n/);
    assert.equal(lines.length, 1);
    assert.doesNotMatch(lines[0], /token=/, "no link in logs");
    assert.doesNotMatch(lines[0], /lure@e\.co/, "no address in logs");
    assert.deepEqual(JSON.parse(lines[0]), { event: "auth_mail_failed", kind: "verification", error: "send_failed" });
  } finally {
    console.log = original;
  }
});

test("RateLimiter.check probes without counting", () => {
  let clock = 0;
  const limiter = new RateLimiter(2, 1000, { now: () => clock });
  assert.equal(limiter.check("k"), true);
  assert.equal(limiter.check("k"), true);
  limiter.allow("k"); limiter.allow("k");
  assert.equal(limiter.check("k"), false);
  assert.equal(limiter.check("other"), true);
});

test("reset flow: request always says sent, reset changes password", async () => {
  const { store, routes, sent } = makeRoutes();
  await post(routes, "/auth/signup", form({ email: "r@e.co", name: "R", password: "longenough1" }));
  store.verifyEmail(sent[0].text.match(/token=([A-Za-z0-9_-]+)/)[1], "longenough1");
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

test("slideSessionCookie re-issues the same cookie only once it is older than 24h", async () => {
  const { store, routes, tick } = makeRoutes();
  const { userId } = store.createVerifiedUser({ email: "slide@e.co", displayName: "S", password: "longenough1" });
  const raw = store.createSession(userId);
  const cookie = `${SESSION_COOKIE}=${signValue(raw, SECRET)}`;
  const req = { headers: { cookie } };
  const session = routes.sessionForRequest(req);
  assert.equal(routes.slideSessionCookie(session, session.user.cookieIssuedAt + 1000), null, "fresh cookie: nothing to do");
  tick(24 * 60 * 60 * 1000 + 1);
  const reissued = routes.slideSessionCookie(routes.sessionForRequest(req), session.user.cookieIssuedAt + 24 * 60 * 60 * 1000 + 1);
  assert.ok(reissued);
  assert.equal(reissued.split(";")[0], cookie, "same signed value");
  assert.match(reissued, /Max-Age=2592000/);
  assert.match(reissued, /HttpOnly/);
  assert.equal(routes.slideSessionCookie(routes.sessionForRequest(req), session.user.cookieIssuedAt + 24 * 60 * 60 * 1000 + 2), null, "marked issued; not re-issued again");
});
