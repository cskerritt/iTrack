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
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

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
  const verified = store.verifyEmail(verifyToken, "longenoughpass");
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

test("duplicate verified email is rejected case-insensitively", () => {
  const { store } = makeStore();
  const { verifyToken } = store.createUser({ email: "a@b.co", displayName: "A", password: "x".repeat(10) });
  store.verifyEmail(verifyToken, "x".repeat(10));
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
  assert.ok(store.verifyEmail(verifyToken, "x".repeat(10)));
  assert.equal(store.verifyEmail(verifyToken, "x".repeat(10)), null); // single-use
  const second = store.createUser({
    email: "two@e.co", displayName: "Two", password: "x".repeat(10),
  });
  tick(VERIFY_TTL_MS + 1);
  assert.equal(store.verifyEmail(second.verifyToken, "x".repeat(10)), null); // expired
});

test("newVerifyToken only for unverified existing users", () => {
  const { store } = makeStore();
  const { verifyToken } = store.createUser({
    email: "u@e.co", displayName: "U", password: "x".repeat(10),
  });
  const reissued = store.newVerifyToken("u@e.co");
  assert.ok(reissued.token);
  assert.equal(store.newVerifyToken("missing@e.co"), null);
  store.verifyEmail(verifyToken, "x".repeat(10));
  assert.equal(store.newVerifyToken("u@e.co"), null); // already verified
});

test("sessions resolve, slide, expire, delete", () => {
  const { store, tick } = makeStore();
  const { userId, verifyToken } = store.createUser({
    email: "s@e.co", displayName: "S", password: "x".repeat(10),
  });
  store.verifyEmail(verifyToken, "x".repeat(10));
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
  store.verifyEmail(kept.verifyToken, "x".repeat(10));
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
  store.verifyEmail(verifyToken, "original-pass");
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

test("re-signup of an UNVERIFIED email replaces name + hash and reissues the link", () => {
  const { store } = makeStore();
  const first = store.createUser({ email: "claim@e.co", displayName: "Squatter", password: "squatter-pass-1" });
  assert.equal(first.replaced, false);
  const second = store.createUser({ email: "Claim@E.co", displayName: "Owner", password: "owner-pass-123" });
  assert.equal(second.replaced, true);
  assert.equal(second.userId, first.userId, "same account row is kept");
  assert.notEqual(second.verifyToken, first.verifyToken);
  assert.equal(store.verifyEmail(first.verifyToken, "squatter-pass-1"), null, "the squatter's link is dead");
  const verified = store.verifyEmail(second.verifyToken, "owner-pass-123");
  assert.equal(verified.displayName, "Owner");
  assert.equal(store.authenticate("claim@e.co", "squatter-pass-1").ok, false, "old password gone");
  assert.equal(store.authenticate("claim@e.co", "owner-pass-123").ok, true);
});

test("re-signup of a VERIFIED email still throws email-taken", () => {
  const { store } = makeStore();
  const { verifyToken } = store.createUser({ email: "v@e.co", displayName: "V", password: "x".repeat(10) });
  store.verifyEmail(verifyToken, "x".repeat(10));
  assert.throws(
    () => store.createUser({ email: "v@e.co", displayName: "V2", password: "y".repeat(10) }),
    (err) => err instanceof AuthError && err.code === "email-taken",
  );
  assert.equal(store.authenticate("v@e.co", "x".repeat(10)).ok, true, "verified account untouched");
});

test("createVerifiedUser creates once and never touches an existing account", () => {
  const { store } = makeStore();
  const made = store.createVerifiedUser({ email: "Boot@E.co", displayName: null, password: "boot-pass-1234" });
  assert.equal(made.created, true);
  assert.equal(store.authenticate("boot@e.co", "boot-pass-1234").ok, true, "verified immediately");
  const again = store.createVerifiedUser({ email: "boot@e.co", displayName: null, password: "other-pass-1234" });
  assert.equal(again.created, false);
  assert.equal(again.userId, made.userId);
  assert.equal(store.authenticate("boot@e.co", "boot-pass-1234").ok, true, "password unchanged");
  assert.equal(store.authenticate("boot@e.co", "other-pass-1234").ok, false);
  const pending = store.createUser({ email: "pend@e.co", displayName: "P", password: "pending-pass-1" });
  const skip = store.createVerifiedUser({ email: "pend@e.co", displayName: null, password: "boot-pass-1234" });
  assert.equal(skip.created, false, "an unverified account is also left alone");
  assert.equal(skip.userId, pending.userId);
  assert.equal(store.authenticate("pend@e.co", "pending-pass-1").ok, false, "still unverified");
});

test("sessions record when the cookie was issued and can be marked re-issued", () => {
  const { store, tick } = makeStore();
  const { userId, verifyToken } = store.createUser({ email: "c@e.co", displayName: "C", password: "x".repeat(10) });
  store.verifyEmail(verifyToken, "x".repeat(10));
  const sid = store.createSession(userId);
  const issuedAt = store.sessionUser(sid).cookieIssuedAt;
  assert.equal(typeof issuedAt, "number");
  tick(25 * 60 * 60 * 1000);
  assert.equal(store.sessionUser(sid).cookieIssuedAt, issuedAt, "reading does not bump it");
  store.markCookieIssued(sid);
  assert.equal(store.sessionUser(sid).cookieIssuedAt, issuedAt + 25 * 60 * 60 * 1000);
});

test("an auth.db created before cookie_issued_at existed is upgraded on open", () => {
  const { DatabaseSync } = require("node:sqlite");
  const dbPath = `${process.env.TMPDIR ?? "/tmp"}/auth-upgrade-${process.pid}.db`;
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT, password_scrypt TEXT NOT NULL, created_at INTEGER NOT NULL, verified_at INTEGER);
    CREATE TABLE tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('verify','reset')), expires_at INTEGER NOT NULL, used_at INTEGER);
    CREATE TABLE sessions (session_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);`);
  legacy.close();
  const store = new AuthStore(dbPath);
  const columns = store.db.prepare("PRAGMA table_info(sessions)").all().map((row) => row.name);
  assert.ok(columns.includes("cookie_issued_at"));
  store.close();
  require("node:fs").rmSync(dbPath, { force: true });
});

test("verifyEmail needs the account's current password; a wrong one leaves the link live", () => {
  const { store } = makeStore();
  const { userId, verifyToken } = store.createUser({ email: "pw@e.co", displayName: "P", password: "right-pass-11" });
  assert.deepEqual(store.peekVerifyToken(verifyToken), { userId, email: "pw@e.co" });
  assert.equal(store.verifyEmail(verifyToken, "wrong-pass-11"), null, "wrong password is refused");
  assert.equal(store.verifyEmail(verifyToken), null, "no password is refused");
  assert.equal(store.verifyEmail(verifyToken, ""), null, "empty password is refused");
  assert.ok(store.peekVerifyToken(verifyToken), "the refusals did not consume the link");
  assert.equal(store.authenticate("pw@e.co", "right-pass-11").reason, "unverified", "…or verify anything");
  const verified = store.verifyEmail(verifyToken, "right-pass-11");
  assert.equal(verified.email, "pw@e.co");
  assert.equal(store.peekVerifyToken(verifyToken), null, "consumed");
  assert.equal(store.authenticate("pw@e.co", "right-pass-11").ok, true);
});

test("peekVerifyToken ignores unknown, used, expired, and reset tokens", () => {
  const { store, tick } = makeStore();
  assert.equal(store.peekVerifyToken("nope"), null);
  assert.equal(store.peekVerifyToken(undefined), null);
  const a = store.createUser({ email: "a@e.co", displayName: "A", password: "x".repeat(10) });
  store.verifyEmail(a.verifyToken, "x".repeat(10));
  assert.equal(store.peekVerifyToken(a.verifyToken), null, "used");
  const { token: reset } = store.createResetToken("a@e.co");
  assert.equal(store.peekVerifyToken(reset), null, "a reset token is not a verify link");
  const b = store.createUser({ email: "b@e.co", displayName: "B", password: "x".repeat(10) });
  tick(VERIFY_TTL_MS + 1);
  assert.equal(store.peekVerifyToken(b.verifyToken), null, "expired");
});

test("owner-first squat: neither the squatter's link nor a resend confirms a password the owner never set", () => {
  const { store } = makeStore();
  // The owner signs up first; a squatter re-signs-up before the owner clicks.
  const owner = store.createUser({ email: "own@e.co", displayName: "Owner", password: "owner-pass-111" });
  const squat = store.createUser({ email: "own@e.co", displayName: "Squatter", password: "squatter-pass-1" });
  assert.equal(squat.replaced, true);
  assert.equal(store.verifyEmail(owner.verifyToken, "owner-pass-111"), null, "the owner's original link is dead");
  // The squatter's link lands in the OWNER's inbox, and so does whatever the
  // resend form issues — both belong to a row that now carries the squatter's hash.
  const resent = store.newVerifyToken("own@e.co");
  for (const token of [squat.verifyToken, resent.token]) {
    assert.equal(store.verifyEmail(token, "owner-pass-111"), null, "a password the owner never set cannot be confirmed");
    assert.ok(store.peekVerifyToken(token), "…and the refusal does not burn the link");
  }
  assert.equal(store.authenticate("own@e.co", "squatter-pass-1").reason, "unverified", "nothing was verified");
  // Recovery: signing up again replaces the squatter's hash and kills every outstanding link.
  const again = store.createUser({ email: "own@e.co", displayName: "Owner", password: "owner-pass-222" });
  assert.equal(again.replaced, true);
  assert.equal(store.peekVerifyToken(squat.verifyToken), null);
  assert.equal(store.peekVerifyToken(resent.token), null);
  assert.ok(store.verifyEmail(again.verifyToken, "owner-pass-222"));
  assert.equal(store.authenticate("own@e.co", "owner-pass-222").ok, true);
  assert.equal(store.authenticate("own@e.co", "squatter-pass-1").ok, false, "the squatter's password never survives");
});
