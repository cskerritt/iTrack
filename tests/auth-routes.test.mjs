import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AuthStore } from "../deploy/railway/auth.mjs";
import {
  EMAIL_RE,
  RESPONSE_FLOOR_MS,
  RateLimiter,
  clientIp,
  createAuthRoutes,
  readCookie,
  signValue,
  unsignValue,
  SESSION_COOKIE,
} from "../deploy/railway/auth-routes.mjs";

const SECRET = "test-secret";

// `sleeps` records every delay the routes asked for: the 250 ms response
// floor on signup/reset/resend and the 2 s account-lock delay on login.
// `burns` records each dummy-scrypt burn on a branch that hashed nothing.
function makeRoutes({ sendResult = { ok: true }, mailConfigured, onSend } = {}) {
  let clock = 1_700_000_000_000;
  const store = new AuthStore(":memory:", { now: () => clock });
  const burns = [];
  const burn = store.burnPasswordCheck.bind(store);
  store.burnPasswordCheck = (password) => { burns.push(password); burn(password); };
  const sent = [];
  const sleeps = [];
  const tick = (ms) => (clock += ms);
  const routes = createAuthRoutes({
    store,
    secret: SECRET,
    baseUrl: "https://itrack.test",
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); },
    sendEmail: async (message) => { sent.push(message); onSend?.(tick); return sendResult; },
    ...(mailConfigured === undefined ? {} : { mailConfigured }),
  });
  return { store, routes, sent, sleeps, burns, tick };
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
  sleeps.length = 0; // the signup's response floor, not a lockout delay
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
  const session = routes.sessionForRequest({ headers: { cookie: `${SESSION_COOKIE}=${signed}` } });
  assert.equal(session.user.email, "l@e.co");
  assert.equal(routes.userForRequest, undefined, "no production caller; not exported");
  ({ res } = await post(routes, "/auth/login", form({ email: "l@e.co", password: "wrong-pass-1" })));
  assert.equal(res.headers.location, "/login?error=bad-credentials");
  ({ res } = await post(routes, "/auth/logout", "", { cookie: `${SESSION_COOKIE}=${signed}` }));
  assert.equal(res.headers.location, "/");
  assert.equal(routes.sessionForRequest({ headers: { cookie: `${SESSION_COOKIE}=${signed}` } }), null);
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
    // Outside printable ASCII 0x21-0x7E: a Location header cannot carry it
    // (Node refuses anything above U+00FF outright), so it collapses to `/`
    // rather than turning a successful login into a 500.
    ["/caf\u00e9", "/"],
    ["/credentials/\u0100", "/"],
    ["/a b", "/"],
    ["/tab\tx", "/"],
    ["/ok-!$&'()*+,;=:@~?q=1#f", "/ok-!$&'()*+,;=:@~?q=1#f"],
  ]) {
    const { res } = await post(routes, "/auth/login", form({ email: "n@e.co", password: "longenough1", next }));
    assert.equal(res.headers.location, expected, `next=${next}`);
  }
});

test("EMAIL_RE accepts printable ASCII only: a non-ASCII address is refused at signup", async () => {
  for (const email of ["first.last+tag@sub.example.co", "a!#$%&'*/=?^_`{|}~-@e.co"]) {
    assert.equal(EMAIL_RE.test(email), true, email);
  }
  for (const email of ["jos\u00e9@e.co", "a@\u00e9.co", "a@e.c\u00f6", "a b@e.co", "a@b@e.co", "a@e.c", "\u0100@e.co"]) {
    assert.equal(EMAIL_RE.test(email), false, email);
  }
  const { routes, sent } = makeRoutes();
  const { res } = await post(routes, "/auth/signup", form({ email: "jos\u00e9@e.co", name: "J", password: "longenough1" }));
  assert.equal(res.headers.location, "/signup?error=invalid");
  assert.equal(sent.length, 0);
});

test("the per-IP login limiter counts failures only: a dozen logins from one address do not lock it", async () => {
  const { store, routes } = makeRoutes();
  store.createVerifiedUser({ email: "ok@e.co", displayName: "O", password: "longenough1" });
  for (let i = 0; i < 12; i += 1) {
    const { res } = await post(routes, "/auth/login", form({ email: "ok@e.co", password: "longenough1" }));
    assert.equal(res.headers.location, "/", `login ${i + 1}`);
    assert.match(res.headers["set-cookie"], new RegExp(`^${SESSION_COOKIE}=`));
  }
  // Ten failures — spread over unknown accounts so the per-account bucket
  // stays out of the picture — still lock the address for everyone.
  for (let i = 0; i < 10; i += 1) {
    const { res } = await post(routes, "/auth/login", form({ email: `x${i}@e.co`, password: "wrong-pass-1" }));
    assert.equal(res.headers.location, "/login?error=bad-credentials");
  }
  let { res } = await post(routes, "/auth/login", form({ email: "ok@e.co", password: "longenough1" }));
  assert.equal(res.headers.location, "/login?error=rate-limited", "even the right password is refused from a locked address");
  assert.equal(res.headers["set-cookie"], undefined);
  ({ res } = await post(routes, "/auth/login", form({ email: "ok@e.co", password: "longenough1" }),
    { "x-forwarded-for": "198.51.100.7" }));
  assert.equal(res.headers.location, "/", "another address is unaffected");
});

test("signup, request-reset and resend pad every branch to the response floor and burn a scrypt where nothing was hashed", async () => {
  assert.equal(RESPONSE_FLOOR_MS, 250);
  const { store, routes, sent, sleeps, burns } = makeRoutes();
  const slept = () => sleeps.splice(0);
  let { res } = await post(routes, "/auth/signup", form({ email: "t@e.co", name: "T", password: "longenough1" }));
  assert.equal(res.headers.location, "/signup?sent=1&email=t%40e.co");
  assert.deepEqual(slept(), [250]);
  assert.deepEqual(burns, [], "a fresh signup hashed a real password");
  store.verifyEmail(sent[0].text.match(/token=([A-Za-z0-9_-]+)/)[1], "longenough1");
  ({ res } = await post(routes, "/auth/signup", form({ email: "t@e.co", name: "T2", password: "another-pass1" })));
  assert.equal(res.headers.location, "/signup?sent=1&email=t%40e.co");
  assert.deepEqual(slept(), [250]);
  assert.deepEqual(burns, ["another-pass1"], "the taken branch pays for the hash it skipped");
  ({ res } = await post(routes, "/auth/signup", form({ email: "bad", name: "B", password: "longenough1" })));
  assert.equal(res.headers.location, "/signup?error=invalid");
  assert.deepEqual(slept(), [250], "even a rejected form waits out the floor");

  ({ res } = await post(routes, "/auth/request-reset", form({ email: "t@e.co" })));
  assert.equal(res.headers.location, "/reset?sent=1");
  assert.deepEqual(slept(), [250]);
  assert.equal(burns.length, 1, "a real reset issues a token instead of burning");
  ({ res } = await post(routes, "/auth/request-reset", form({ email: "ghost@e.co" })));
  assert.equal(res.headers.location, "/reset?sent=1");
  assert.deepEqual(slept(), [250]);
  assert.equal(burns.length, 2, "an unknown reset address burns a scrypt");

  await post(routes, "/auth/signup", form({ email: "u@e.co", name: "U", password: "longenough1" }));
  slept();
  ({ res } = await post(routes, "/auth/resend", form({ email: "u@e.co" })));
  assert.equal(res.headers.location, "/login?sent=1");
  assert.deepEqual(slept(), [250]);
  assert.equal(burns.length, 2, "a real resend issues a token instead of burning");
  ({ res } = await post(routes, "/auth/resend", form({ email: "ghost@e.co" })));
  assert.equal(res.headers.location, "/login?sent=1");
  assert.deepEqual(slept(), [250]);
  assert.equal(burns.length, 3, "an unknown resend address burns a scrypt");
  await post(routes, "/auth/resend", form({ email: "u@e.co" }));
  slept();
  ({ res } = await post(routes, "/auth/resend", form({ email: "u@e.co" })));
  assert.equal(res.headers.location, "/login?error=rate-limited");
  assert.deepEqual(slept(), [250], "the rate-limited answer waits out the floor too");
});

test("the response floor is measured from request start: slow work shortens or removes the wait", async () => {
  const slow = makeRoutes({ onSend: (tick) => tick(300) });
  let { res } = await post(slow.routes, "/auth/signup", form({ email: "s@e.co", name: "S", password: "longenough1" }));
  assert.equal(res.headers.location, "/signup?sent=1&email=s%40e.co");
  assert.deepEqual(slow.sleeps, [], "300 ms of real work already clears a 250 ms floor");
  const partial = makeRoutes({ onSend: (tick) => tick(100) });
  ({ res } = await post(partial.routes, "/auth/signup", form({ email: "p@e.co", name: "P", password: "longenough1" })));
  assert.equal(res.headers.location, "/signup?sent=1&email=p%40e.co");
  assert.deepEqual(partial.sleeps, [150], "only the remainder is slept");
});

test("mail unconfigured: signup, request-reset and resend show the support copy, decided by configuration, not by account existence", async () => {
  const { store, routes, sent } = makeRoutes({ mailConfigured: false, sendResult: { ok: false, error: "mail_unconfigured" } });
  store.createVerifiedUser({ email: "known@e.co", displayName: "K", password: "longenough1" });
  store.createUser({ email: "pending@e.co", displayName: "P", password: "longenough1" });
  for (const email of ["known@e.co", "ghost@e.co"]) {
    const { res } = await post(routes, "/auth/request-reset", form({ email }));
    assert.equal(res.headers.location, "/reset?sent=1&mail=unconfigured", email);
  }
  let ip = 0;
  for (const email of ["pending@e.co", "ghost@e.co", "known@e.co"]) {
    let { res } = await post(routes, "/auth/resend", form({ email }), { "x-forwarded-for": `10.1.0.${ip += 1}` });
    assert.equal(res.headers.location, "/login?sent=1&mail=unconfigured", email);
    ({ res } = await post(routes, "/auth/resend", form({ email, return: "signup" }), { "x-forwarded-for": `10.1.0.${ip += 1}` }));
    assert.equal(res.headers.location, `/signup?sent=1&mail=unconfigured&email=${encodeURIComponent(email)}`, email);
  }
  for (const email of ["known@e.co", "fresh@e.co"]) {
    const { res } = await post(routes, "/auth/signup", form({ email, name: "N", password: "longenough1" }));
    assert.equal(res.headers.location, `/signup?sent=1&mail=unconfigured&email=${encodeURIComponent(email)}`, email);
  }
  assert.equal(sent.length, 0, "nothing is handed to the sender while mail is unconfigured");
  assert.equal(store.authenticate("fresh@e.co", "longenough1").reason, "unverified", "the account exists and can be verified once mail works");
  assert.equal(store.authenticate("known@e.co", "longenough1").ok, true, "the existing account is untouched");

  // The flag defaults to what the sender itself reports (email.mjs).
  const send = Object.assign(async () => ({ ok: false, error: "mail_unconfigured" }), { mailConfigured: false });
  const fromSender = createAuthRoutes({
    store: new AuthStore(":memory:"), secret: SECRET, baseUrl: "https://itrack.test", sleep: async () => {}, sendEmail: send,
  });
  const { res } = await post(fromSender, "/auth/request-reset", form({ email: "any@e.co" }));
  assert.equal(res.headers.location, "/reset?sent=1&mail=unconfigured", "read off the sender when not passed explicitly");
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
