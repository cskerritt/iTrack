import test from "node:test";
import assert from "node:assert/strict";
import {
  AuthStore,
  AuthError,
  hashPassword,
  verifyPassword,
  VERIFY_TTL_MS,
  RESET_TTL_MS,
  SESSION_TTL_MS,
  UNVERIFIED_TTL_MS,
} from "../deploy/railway/auth.mjs";

function makeStore() {
  let clock = 1_000_000_000_000;
  const store = new AuthStore(":memory:", { now: () => clock });
  return { store, tick: (ms) => (clock += ms) };
}

test("hashPassword round-trips and rejects wrong passwords", () => {
  const stored = hashPassword("correct horse battery");
  assert.match(stored, /^scrypt:16384:8:1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.equal(verifyPassword("correct horse battery", stored), true);
  assert.equal(verifyPassword("wrong", stored), false);
  assert.equal(verifyPassword("anything", "garbage"), false);
  assert.equal(verifyPassword("anything", ""), false);
});

test("createUser + verifyEmail + authenticate happy path", () => {
  const { store } = makeStore();
  const { userId, verifyToken } = store.createUser({
    email: "Pat@Example.com",
    displayName: "Pat",
    password: "longenoughpass",
  });
  assert.ok(userId);
  // unverified users cannot log in
  assert.deepEqual(store.authenticate("pat@example.com", "longenoughpass"), {
    ok: false,
    reason: "unverified",
  });
  const verified = store.verifyEmail(verifyToken);
  assert.equal(verified.email, "pat@example.com"); // lowercased
  const auth = store.authenticate("PAT@example.com", "longenoughpass");
  assert.equal(auth.ok, true);
  assert.equal(auth.user.email, "pat@example.com");
  assert.equal(auth.user.displayName, "Pat");
  // wrong password
  assert.deepEqual(store.authenticate("pat@example.com", "nope"), {
    ok: false,
    reason: "bad-credentials",
  });
  // unknown user
  assert.deepEqual(store.authenticate("ghost@example.com", "whatever"), {
    ok: false,
    reason: "bad-credentials",
  });
});

test("duplicate email is rejected case-insensitively", () => {
  const { store } = makeStore();
  store.createUser({ email: "a@b.co", displayName: "A", password: "x".repeat(10) });
  assert.throws(
    () => store.createUser({ email: "A@B.CO", displayName: "A2", password: "y".repeat(10) }),
    (err) => err instanceof AuthError && err.code === "email-taken",
  );
});

test("verify tokens are single-use and expire", () => {
  const { store, tick } = makeStore();
  const { verifyToken } = store.createUser({
    email: "one@e.co", displayName: "One", password: "x".repeat(10),
  });
  assert.ok(store.verifyEmail(verifyToken));
  assert.equal(store.verifyEmail(verifyToken), null); // single-use
  const second = store.createUser({
    email: "two@e.co", displayName: "Two", password: "x".repeat(10),
  });
  tick(VERIFY_TTL_MS + 1);
  assert.equal(store.verifyEmail(second.verifyToken), null); // expired
});

test("newVerifyToken only for unverified existing users", () => {
  const { store } = makeStore();
  const { verifyToken } = store.createUser({
    email: "u@e.co", displayName: "U", password: "x".repeat(10),
  });
  const reissued = store.newVerifyToken("u@e.co");
  assert.ok(reissued.token);
  assert.equal(store.newVerifyToken("missing@e.co"), null);
  store.verifyEmail(verifyToken);
  assert.equal(store.newVerifyToken("u@e.co"), null); // already verified
});

test("sessions resolve, slide, expire, delete", () => {
  const { store, tick } = makeStore();
  const { userId, verifyToken } = store.createUser({
    email: "s@e.co", displayName: "S", password: "x".repeat(10),
  });
  store.verifyEmail(verifyToken);
  const sid = store.createSession(userId);
  assert.equal(store.sessionUser(sid).email, "s@e.co");
  tick(SESSION_TTL_MS - 1000);
  assert.ok(store.sessionUser(sid), "sliding expiry keeps active session alive");
  tick(SESSION_TTL_MS - 1000);
  assert.ok(store.sessionUser(sid), "slid forward again");
  tick(SESSION_TTL_MS + 1);
  assert.equal(store.sessionUser(sid), null, "expired after inactivity");
  const sid2 = store.createSession(userId);
  store.deleteSession(sid2);
  assert.equal(store.sessionUser(sid2), null);
  assert.equal(store.sessionUser("not-a-session"), null);
});

test("cleanup removes stale unverified users and expired rows", () => {
  const { store, tick } = makeStore();
  store.createUser({ email: "stale@e.co", displayName: "Stale", password: "x".repeat(10) });
  const kept = store.createUser({ email: "kept@e.co", displayName: "Kept", password: "x".repeat(10) });
  store.verifyEmail(kept.verifyToken);
  tick(UNVERIFIED_TTL_MS + 1);
  const { removedUsers } = store.cleanup();
  assert.equal(removedUsers, 1);
  assert.deepEqual(store.authenticate("stale@e.co", "x".repeat(10)),
    { ok: false, reason: "bad-credentials" }, "stale unverified account is gone");
  assert.equal(store.authenticate("kept@e.co", "x".repeat(10)).ok, true, "verified account survives");
});

test("password reset flow invalidates sessions and old tokens expire", () => {
  const { store, tick } = makeStore();
  const { userId, verifyToken } = store.createUser({
    email: "r@e.co", displayName: "R", password: "original-pass",
  });
  assert.equal(store.createResetToken("r@e.co"), null, "unverified gets no reset");
  store.verifyEmail(verifyToken);
  const sid = store.createSession(userId);
  const { token } = store.createResetToken("r@e.co");
  assert.equal(store.createResetToken("nobody@e.co"), null);
  const result = store.resetPassword(token, "brand-new-pass");
  assert.equal(result.email, "r@e.co");
  assert.equal(store.sessionUser(sid), null, "reset kills sessions");
  assert.equal(store.resetPassword(token, "again"), null, "single-use");
  assert.equal(store.authenticate("r@e.co", "original-pass").ok, false);
  assert.equal(store.authenticate("r@e.co", "brand-new-pass").ok, true);
  const { token: expiring } = store.createResetToken("r@e.co");
  tick(RESET_TTL_MS + 1);
  assert.equal(store.resetPassword(expiring, "too-late-pass"), null);
});
