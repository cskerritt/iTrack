# iTrack Public Landing + Self-Serve Sign-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Public visitors to iTrack get a marketing landing page and can sign up with email + password (Resend-verified), while the existing Basic Auth path keeps working for the iOS app and env-var users.

**Architecture:** The Railway proxy (`deploy/railway/serve.mjs`) becomes an auth gateway. New modules: `auth.mjs` (SQLite user/session/token store via `node:sqlite`), `email.mjs` (Resend), `auth-routes.mjs` (HTTP handlers + rate limiting + cookies), `gateway.mjs` (request routing extracted from serve.mjs, testable without wrangler), `pages/*.html` (5 self-contained static pages). The Cloudflare worker (`worker/`, `db/`, `app/`) changes **zero lines** — it keeps trusting `oai-authenticated-user-email` headers injected by the proxy.

**Tech Stack:** Node 22, `node:sqlite` (behind `--experimental-sqlite`), `node:crypto` scrypt, `node --test` runner, Resend HTTP API, plain HTML/CSS (no framework) for public pages.

**Spec:** `docs/superpowers/specs/2026-08-11-itrack-public-signup-design.md`

## Global Constraints

- **Local Node:** use Node 22 at `~/.local/node/node-v22.22.0-darwin-arm64/bin` (Node 25 has a TLS/npm bug on this machine). Prefix commands: `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"`.
- **No new runtime npm dependencies.** `node:sqlite` + `node:crypto` only.
- **Do not modify** anything under `worker/`, `app/`, `db/`, `drizzle/`.
- **`node:sqlite` requires the `--experimental-sqlite` flag on Node 22** — every test run and the Dockerfile CMD need it.
- Repo test entry: `npm test` runs a full build first. While iterating, run only your test file: `node --experimental-sqlite --test tests/<file>.test.mjs`.
- Copy rules (landing page): positioning is **"Free during beta"**; tiers are **Free ($0, ad-supported)** and **Pro ($9.99/mo or $79/yr, "coming soon")**. No checkout exists — never imply Pro is purchasable today.
- Existing security invariants that must survive: client-supplied `oai-*` headers are always stripped; `Authorization` is stripped before proxying authenticated requests; `/api/widget-summary` bypasses auth and keeps its `Authorization` header; `/internal/*`, `/cdn-cgi/*`, `/__scheduled` return 404; startup fails closed with no users configured.
- Every commit message ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01PefKB1aeFc2CpynzxQxoeN`
- Working directory: `~/Documents/New project/vigilo`, branch `main`. Verify `git branch --show-current` prints `main` before each commit (another session may share this tree).

---

### Task 1: Password hashing + AuthStore (`deploy/railway/auth.mjs`)

**Files:**
- Create: `deploy/railway/auth.mjs`
- Test: `tests/auth-store.test.mjs`

**Interfaces:**
- Consumes: nothing (foundation module).
- Produces (exact, later tasks import these):
  - `hashPassword(password: string): string` → `"scrypt:16384:8:1:<saltB64>:<hashB64>"`
  - `verifyPassword(password: string, stored: string): boolean`
  - `class AuthStore`:
    - `constructor(dbPath: string, { now = () => Date.now() } = {})` — `":memory:"` supported; creates schema idempotently.
    - `createUser({ email, displayName, password })` → `{ userId, verifyToken }`; throws `AuthError` with `.code === "email-taken"` on duplicate (case-insensitive).
    - `verifyEmail(rawToken)` → `{ userId, email, displayName }` or `null` (expired/used/unknown; single-use).
    - `newVerifyToken(email)` → `{ token, displayName }` or `null` (unknown email or already verified).
    - `authenticate(email, password)` → `{ ok: true, user: { id, email, displayName } }` | `{ ok: false, reason: "bad-credentials" | "unverified" }`.
    - `createSession(userId)` → raw session id (base64url string; DB stores SHA-256 hex only).
    - `sessionUser(rawSessionId)` → `{ id, email, displayName }` or `null`; slides expiry (updates `expires_at`, `last_seen_at`).
    - `deleteSession(rawSessionId)` → void.
    - `createResetToken(email)` → `{ token, displayName }` or `null` (only for existing **verified** users).
    - `resetPassword(rawToken, newPassword)` → `{ email }` or `null`; deletes **all** the user's sessions.
    - `cleanup()` → `{ removedUsers: number }` — deletes unverified users older than `UNVERIFIED_TTL_MS` (7 days; their tokens/sessions cascade) and expired token + session rows. Called from serve.mjs's existing 15-minute cron interval.
    - `close()` → void.
  - Constants: `VERIFY_TTL_MS = 24*60*60*1000`, `RESET_TTL_MS = 60*60*1000`, `SESSION_TTL_MS = 30*24*60*60*1000`, `UNVERIFIED_TTL_MS = 7*24*60*60*1000`.
  - `class AuthError extends Error` with `code` property.

- [ ] **Step 1: Write the failing test**

`tests/auth-store.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-sqlite --test tests/auth-store.test.mjs`
Expected: FAIL — `Cannot find module '../deploy/railway/auth.mjs'`

- [ ] **Step 3: Write the implementation**

`deploy/railway/auth.mjs`:

```js
// Auth store for the Railway gateway: users, one-time tokens, sessions.
// SQLite via node:sqlite (needs --experimental-sqlite on Node 22).
import { DatabaseSync } from "node:sqlite";
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const UNVERIFIED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export class AuthError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

export function hashPassword(password) {
  const salt = randomBytes(32);
  const hash = scryptSync(password, salt, 32, SCRYPT);
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString("base64")}:${hash.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored ?? "").split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  if (expected.length === 0) return false;
  let actual;
  try {
    actual = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  password_scrypt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  verified_at INTEGER
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('verify','reset')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  session_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
`;

export class AuthStore {
  constructor(dbPath, { now = () => Date.now() } = {}) {
    this.db = new DatabaseSync(dbPath);
    this.now = now;
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  #issueToken(userId, kind, ttlMs) {
    const token = randomBytes(32).toString("base64url");
    this.db
      .prepare(
        "INSERT INTO tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(sha256Hex(token), userId, kind, this.now() + ttlMs);
    return token;
  }

  #consumeToken(rawToken, kind) {
    const row = this.db
      .prepare(
        "SELECT token_hash, user_id, expires_at, used_at FROM tokens WHERE token_hash = ? AND kind = ?",
      )
      .get(sha256Hex(String(rawToken ?? "")), kind);
    if (!row || row.used_at !== null || row.expires_at < this.now()) return null;
    this.db
      .prepare("UPDATE tokens SET used_at = ? WHERE token_hash = ?")
      .run(this.now(), row.token_hash);
    return row.user_id;
  }

  #userById(id) {
    const row = this.db
      .prepare("SELECT id, email, display_name FROM users WHERE id = ?")
      .get(id);
    return row
      ? { id: row.id, email: row.email, displayName: row.display_name }
      : null;
  }

  createUser({ email, displayName, password }) {
    const normalized = String(email).trim().toLowerCase();
    const userId = `acct_${randomUUID()}`;
    try {
      this.db
        .prepare(
          "INSERT INTO users (id, email, display_name, password_scrypt, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(userId, normalized, displayName ?? null, hashPassword(password), this.now());
    } catch (error) {
      if (String(error?.message).includes("UNIQUE")) {
        throw new AuthError("email-taken");
      }
      throw error;
    }
    return { userId, verifyToken: this.#issueToken(userId, "verify", VERIFY_TTL_MS) };
  }

  verifyEmail(rawToken) {
    const userId = this.#consumeToken(rawToken, "verify");
    if (!userId) return null;
    this.db
      .prepare("UPDATE users SET verified_at = ? WHERE id = ? AND verified_at IS NULL")
      .run(this.now(), userId);
    const user = this.#userById(userId);
    return user ? { userId: user.id, email: user.email, displayName: user.displayName } : null;
  }

  newVerifyToken(email) {
    const row = this.db
      .prepare("SELECT id, display_name, verified_at FROM users WHERE email = ?")
      .get(String(email ?? "").trim().toLowerCase());
    if (!row || row.verified_at !== null) return null;
    return {
      token: this.#issueToken(row.id, "verify", VERIFY_TTL_MS),
      displayName: row.display_name,
    };
  }

  authenticate(email, password) {
    const row = this.db
      .prepare(
        "SELECT id, email, display_name, password_scrypt, verified_at FROM users WHERE email = ?",
      )
      .get(String(email ?? "").trim().toLowerCase());
    // Always burn a hash comparison so unknown emails cost the same time.
    const stored = row?.password_scrypt ?? hashPassword("missing-user-placeholder");
    const matches = verifyPassword(String(password ?? ""), stored);
    if (!row || !matches) return { ok: false, reason: "bad-credentials" };
    if (row.verified_at === null) return { ok: false, reason: "unverified" };
    return {
      ok: true,
      user: { id: row.id, email: row.email, displayName: row.display_name },
    };
  }

  createSession(userId) {
    const raw = randomBytes(32).toString("base64url");
    const now = this.now();
    this.db
      .prepare(
        "INSERT INTO sessions (session_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(sha256Hex(raw), userId, now, now + SESSION_TTL_MS, now);
    return raw;
  }

  sessionUser(rawSessionId) {
    const hash = sha256Hex(String(rawSessionId ?? ""));
    const row = this.db
      .prepare("SELECT user_id, expires_at FROM sessions WHERE session_hash = ?")
      .get(hash);
    const now = this.now();
    if (!row) return null;
    if (row.expires_at < now) {
      this.db.prepare("DELETE FROM sessions WHERE session_hash = ?").run(hash);
      return null;
    }
    this.db
      .prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE session_hash = ?")
      .run(now + SESSION_TTL_MS, now, hash);
    return this.#userById(row.user_id);
  }

  deleteSession(rawSessionId) {
    this.db
      .prepare("DELETE FROM sessions WHERE session_hash = ?")
      .run(sha256Hex(String(rawSessionId ?? "")));
  }

  createResetToken(email) {
    const row = this.db
      .prepare("SELECT id, display_name FROM users WHERE email = ? AND verified_at IS NOT NULL")
      .get(String(email ?? "").trim().toLowerCase());
    if (!row) return null;
    return {
      token: this.#issueToken(row.id, "reset", RESET_TTL_MS),
      displayName: row.display_name,
    };
  }

  resetPassword(rawToken, newPassword) {
    const userId = this.#consumeToken(rawToken, "reset");
    if (!userId) return null;
    this.db
      .prepare("UPDATE users SET password_scrypt = ? WHERE id = ?")
      .run(hashPassword(newPassword), userId);
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    const user = this.#userById(userId);
    return user ? { email: user.email } : null;
  }

  cleanup() {
    const now = this.now();
    const removed = this.db
      .prepare("DELETE FROM users WHERE verified_at IS NULL AND created_at < ?")
      .run(now - UNVERIFIED_TTL_MS);
    this.db.prepare("DELETE FROM tokens WHERE expires_at < ?").run(now);
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
    return { removedUsers: Number(removed.changes ?? 0) };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-sqlite --test tests/auth-store.test.mjs`
Expected: PASS (7 tests). An `ExperimentalWarning: SQLite` line on stderr is normal.

- [ ] **Step 5: Commit**

```bash
git add deploy/railway/auth.mjs tests/auth-store.test.mjs
git commit -m "feat: SQLite auth store with scrypt passwords, tokens, sessions"
```

---

### Task 2: Resend email sender (`deploy/railway/email.mjs`)

**Files:**
- Create: `deploy/railway/email.mjs`
- Test: `tests/auth-email.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `createResendSender({ apiKey, from, fetchImpl = fetch })` → `async ({ to, subject, html, text }) => { ok: boolean, error?: string }`.
  - Missing `apiKey` or `from` → resolves `{ ok: false, error: "email-not-configured" }` without calling fetch.
  - Non-2xx Resend response or thrown fetch → `{ ok: false, error: "send-failed" }`.

- [ ] **Step 1: Write the failing test**

`tests/auth-email.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createResendSender } from "../deploy/railway/email.mjs";

test("unconfigured sender reports email-not-configured without fetching", async () => {
  let called = false;
  const send = createResendSender({
    apiKey: "", from: "", fetchImpl: async () => { called = true; },
  });
  assert.deepEqual(await send({ to: "a@b.co", subject: "s", html: "<p>h</p>", text: "t" }),
    { ok: false, error: "email-not-configured" });
  assert.equal(called, false);
});

test("posts to Resend with bearer auth and payload", async () => {
  let captured;
  const send = createResendSender({
    apiKey: "re_test_key",
    from: "iTrack <onboarding@example.com>",
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200, text: async () => "{}" };
    },
  });
  const result = await send({ to: "user@e.co", subject: "Verify", html: "<p>x</p>", text: "x" });
  assert.deepEqual(result, { ok: true });
  assert.equal(captured.url, "https://api.resend.com/emails");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.authorization, "Bearer re_test_key");
  const body = JSON.parse(captured.init.body);
  assert.deepEqual(body, {
    from: "iTrack <onboarding@example.com>",
    to: ["user@e.co"], subject: "Verify", html: "<p>x</p>", text: "x",
  });
});

test("non-2xx and thrown fetch both report send-failed", async () => {
  const failing = createResendSender({
    apiKey: "k", from: "f@e.co",
    fetchImpl: async () => ({ ok: false, status: 422, text: async () => "bad" }),
  });
  assert.deepEqual(await failing({ to: "a@b.co", subject: "s", html: "h", text: "t" }),
    { ok: false, error: "send-failed" });
  const throwing = createResendSender({
    apiKey: "k", from: "f@e.co",
    fetchImpl: async () => { throw new Error("network down"); },
  });
  assert.deepEqual(await throwing({ to: "a@b.co", subject: "s", html: "h", text: "t" }),
    { ok: false, error: "send-failed" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-sqlite --test tests/auth-email.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`deploy/railway/email.mjs`:

```js
// Minimal Resend client. When unconfigured it fails soft with a distinct
// error code so callers can log the would-be link for manual onboarding.
export function createResendSender({ apiKey, from, fetchImpl = fetch }) {
  return async ({ to, subject, html, text }) => {
    if (!apiKey || !from) return { ok: false, error: "email-not-configured" };
    try {
      const response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ from, to: [to], subject, html, text }),
      });
      if (!response.ok) {
        console.error(`[email] resend responded ${response.status}: ${(await response.text()).slice(0, 300)}`);
        return { ok: false, error: "send-failed" };
      }
      return { ok: true };
    } catch (error) {
      console.error("[email] resend request failed", error);
      return { ok: false, error: "send-failed" };
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-sqlite --test tests/auth-email.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add deploy/railway/email.mjs tests/auth-email.test.mjs
git commit -m "feat: Resend email sender with fail-soft unconfigured mode"
```

---

### Task 3: Auth routes, rate limiting, cookies (`deploy/railway/auth-routes.mjs`)

**Files:**
- Create: `deploy/railway/auth-routes.mjs`
- Test: `tests/auth-routes.test.mjs`

**Interfaces:**
- Consumes: `AuthStore`, `AuthError` from `./auth.mjs` (Task 1); a `sendEmail` function shaped like Task 2's sender.
- Produces:
  - `class RateLimiter` — `constructor(limit, windowMs, { now = () => Date.now() } = {})`; `allow(key: string): boolean` (fixed window per key).
  - `readCookie(req, name)` → `string | null` (parses the `cookie` header).
  - `signValue(raw, secret)` → `"<raw>.<hmacSha256Base64url>"`; `unsignValue(signed, secret)` → `raw | null` (timing-safe).
  - `SESSION_COOKIE = "itrack_session"`.
  - `createAuthRoutes({ store, sendEmail, secret, baseUrl, now = () => Date.now() })` → object with:
    - `userForRequest(req)` → `{ id, email, displayName } | null` — resolves the signed session cookie.
    - `issueSessionCookie(res, userId)` → void — creates a session and sets the signed `set-cookie` header (used by login here and by the gateway's `/verify` handler in Task 5).
    - `async handle(req, res, pathname)` → `boolean` — `true` if the request was an auth route it answered (POST `/auth/signup|login|logout|request-reset|reset|resend`), `false` otherwise. GET pages are NOT handled here (gateway serves static files, Task 4/5).
  - POST bodies are `application/x-www-form-urlencoded`; responses are `303` redirects (`location` header) per the redirect map below.

**Redirect map (implement exactly):**

| Route | Outcome | Redirect |
| --- | --- | --- |
| `/auth/signup` | created, email sent | `/signup?sent=1` |
| `/auth/signup` | created, email send failed | `/signup?sent=1&mail=down` |
| `/auth/signup` | email already registered | `/signup?error=email-taken` |
| `/auth/signup` | invalid email / password < 10 chars / name > 80 chars | `/signup?error=invalid` |
| `/auth/signup` | rate limited | `/signup?error=rate-limited` |
| `/auth/login` | success (sets session cookie) | `/` |
| `/auth/login` | bad credentials | `/login?error=bad-credentials` |
| `/auth/login` | unverified account | `/login?error=unverified` |
| `/auth/login` | rate limited | `/login?error=rate-limited` |
| `/auth/logout` | always (clears cookie, deletes session) | `/` |
| `/auth/request-reset` | always (no enumeration) | `/reset?sent=1` |
| `/auth/request-reset` | rate limited | `/reset?error=rate-limited` |
| `/auth/reset` | success (valid token, new password ≥ 10) | `/login?reset=1` |
| `/auth/reset` | invalid/expired token | `/reset?error=expired` |
| `/auth/reset` | password too short | `/reset?error=invalid&token=<token>` |
| `/auth/resend` | re-send verification if eligible (no enumeration) | `/login?resent=1` |
| `/auth/resend` | rate limited | `/login?error=rate-limited` |
| any `/auth/*` | Origin/Referer host mismatch | `403` plain text, no redirect |
| any other `/auth/*` path or non-POST method | `404` plain text |

Rate limit keys are `<route>:<ip>` where ip = first entry of `x-forwarded-for` else `req.socket.remoteAddress`. Limits: signup 5/hour, login 10/15 min, reset+resend share 3/hour.

Validation: email must match `/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/` (≥2-char TLD — same rule KWVRS intake settled on); password `>= 10` chars; display name trimmed, 1–80 chars.

Email contents (exact copy):
- Verification — subject `Verify your iTrack email`; text `Hi <name>,\n\nConfirm your email to activate your iTrack account:\n<baseUrl>/verify?token=<token>\n\nThis link expires in 24 hours. If you didn't sign up, ignore this email.`; html: same content with the link as `<a>`.
- Reset — subject `Reset your iTrack password`; text `Hi <name>,\n\nReset your iTrack password:\n<baseUrl>/reset?token=<token>\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`; html likewise.
- When `sendEmail` reports `email-not-configured` or `send-failed`, log `[auth] verification link for <email>: <link>` (or `reset link`) via `console.log` so accounts can be onboarded manually while DNS is pending.

Session cookie attributes on login/verify: `itrack_session=<signed>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`. Logout sets `Max-Age=0` with an empty value. (`Secure` is fine even though wrangler-local serves http on 127.0.0.1 — the public edge is always https; tests read the header, they don't enforce Secure.)

- [ ] **Step 1: Write the failing test**

`tests/auth-routes.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-sqlite --test tests/auth-routes.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`deploy/railway/auth-routes.mjs`:

```js
// HTTP handlers for /auth/* plus the session-cookie and rate-limit helpers
// the gateway uses. Pages themselves are static files served by the gateway.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "itrack_session";
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_BODY_BYTES = 32 * 1024;

export class RateLimiter {
  constructor(limit, windowMs, { now = () => Date.now() } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.buckets = new Map();
  }
  allow(key) {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start >= this.windowMs) {
      this.buckets.set(key, { start: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }
}

function hmac(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function signValue(raw, secret) {
  return `${raw}.${hmac(raw, secret)}`;
}

export function unsignValue(signed, secret) {
  const dot = String(signed ?? "").lastIndexOf(".");
  if (dot === -1) return null;
  const raw = signed.slice(0, dot);
  const mac = signed.slice(dot + 1);
  const expected = hmac(raw, secret);
  const actual = Buffer.from(mac);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return null;
  return raw;
}

export function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}

function sessionCookieHeader(signed) {
  return `${SESSION_COOKIE}=${signed}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_S}`;
}

const CLEAR_COOKIE = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
}

function verificationEmail(baseUrl, name, token) {
  const link = `${baseUrl}/verify?token=${token}`;
  const greeting = name ? `Hi ${name},` : "Hi,";
  return {
    subject: "Verify your iTrack email",
    text: `${greeting}\n\nConfirm your email to activate your iTrack account:\n${link}\n\nThis link expires in 24 hours. If you didn't sign up, ignore this email.`,
    html: `<p>${escapeHtml(greeting)}</p><p>Confirm your email to activate your iTrack account:</p><p><a href="${link}">${link}</a></p><p>This link expires in 24 hours. If you didn't sign up, ignore this email.</p>`,
    link,
  };
}

function resetEmail(baseUrl, name, token) {
  const link = `${baseUrl}/reset?token=${token}`;
  const greeting = name ? `Hi ${name},` : "Hi,";
  return {
    subject: "Reset your iTrack password",
    text: `${greeting}\n\nReset your iTrack password:\n${link}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
    html: `<p>${escapeHtml(greeting)}</p><p>Reset your iTrack password:</p><p><a href="${link}">${link}</a></p><p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>`,
    link,
  };
}

export function createAuthRoutes({ store, sendEmail, secret, baseUrl, now = () => Date.now() }) {
  const signupLimiter = new RateLimiter(5, 60 * 60 * 1000, { now });
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000, { now });
  const resetLimiter = new RateLimiter(3, 60 * 60 * 1000, { now });

  function userForRequest(req) {
    const cookie = readCookie(req, SESSION_COOKIE);
    if (!cookie) return null;
    const raw = unsignValue(cookie, secret);
    if (!raw) return null;
    return store.sessionUser(raw);
  }

  function issueSessionCookie(res, userId) {
    const raw = store.createSession(userId);
    res.setHeader("set-cookie", sessionCookieHeader(signValue(raw, secret)));
  }

  async function deliver(kind, email, message) {
    const result = await sendEmail({
      to: email, subject: message.subject, html: message.html, text: message.text,
    });
    if (!result.ok) {
      console.log(`[auth] ${kind} link for ${email}: ${message.link} (email ${result.error})`);
    }
    return result;
  }

  async function handle(req, res, pathname) {
    if (!pathname.startsWith("/auth/")) return false;

    // CSRF: browsers always send Origin on cross-site POSTs; when present it
    // must match our host. Referer is the fallback for older clients.
    const host = req.headers.host;
    const declared = req.headers.origin ?? req.headers.referer;
    if (declared) {
      try {
        if (new URL(declared).host !== host) {
          res.writeHead(403, { "content-type": "text/plain" });
          res.end("Cross-origin request rejected");
          return true;
        }
      } catch {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Cross-origin request rejected");
        return true;
      }
    }

    const route = pathname.slice("/auth/".length);
    const known = ["signup", "login", "logout", "request-reset", "reset", "resend"];
    if (req.method !== "POST" || !known.includes(route)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
      return true;
    }

    let fields;
    try {
      fields = new URLSearchParams(await readBody(req));
    } catch {
      res.writeHead(413, { "content-type": "text/plain" });
      res.end("Request too large");
      return true;
    }
    const ip = clientIp(req);
    const email = (fields.get("email") ?? "").trim().toLowerCase();
    const password = fields.get("password") ?? "";
    const name = (fields.get("name") ?? "").trim();

    if (route === "signup") {
      if (!signupLimiter.allow(`signup:${ip}`)) return redirect(res, "/signup?error=rate-limited"), true;
      if (!EMAIL_RE.test(email) || password.length < 10 || name.length < 1 || name.length > 80) {
        return redirect(res, "/signup?error=invalid"), true;
      }
      let created;
      try {
        created = store.createUser({ email, displayName: name, password });
      } catch (error) {
        if (error?.code === "email-taken") return redirect(res, "/signup?error=email-taken"), true;
        throw error;
      }
      const result = await deliver("verification", email, verificationEmail(baseUrl, name, created.verifyToken));
      return redirect(res, result.ok ? "/signup?sent=1" : "/signup?sent=1&mail=down"), true;
    }

    if (route === "login") {
      if (!loginLimiter.allow(`login:${ip}`)) return redirect(res, "/login?error=rate-limited"), true;
      const attempt = store.authenticate(email, password);
      if (!attempt.ok) return redirect(res, `/login?error=${attempt.reason}`), true;
      issueSessionCookie(res, attempt.user.id);
      return redirect(res, "/"), true;
    }

    if (route === "logout") {
      const cookie = readCookie(req, SESSION_COOKIE);
      const raw = cookie ? unsignValue(cookie, secret) : null;
      if (raw) store.deleteSession(raw);
      res.setHeader("set-cookie", CLEAR_COOKIE);
      return redirect(res, "/"), true;
    }

    if (route === "request-reset") {
      if (!resetLimiter.allow(`reset:${ip}`)) return redirect(res, "/reset?error=rate-limited"), true;
      const issued = store.createResetToken(email);
      if (issued) await deliver("reset", email, resetEmail(baseUrl, issued.displayName, issued.token));
      return redirect(res, "/reset?sent=1"), true;
    }

    if (route === "reset") {
      const token = fields.get("token") ?? "";
      if (password.length < 10) {
        return redirect(res, `/reset?error=invalid&token=${encodeURIComponent(token)}`), true;
      }
      const result = store.resetPassword(token, password);
      return redirect(res, result ? "/login?reset=1" : "/reset?error=expired"), true;
    }

    // resend
    if (!resetLimiter.allow(`reset:${ip}`)) return redirect(res, "/login?error=rate-limited"), true;
    const reissued = store.newVerifyToken(email);
    if (reissued) {
      await deliver("verification", email, verificationEmail(baseUrl, reissued.displayName, reissued.token));
    }
    return redirect(res, "/login?resent=1"), true;
  }

  return { handle, userForRequest, issueSessionCookie };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-sqlite --test tests/auth-routes.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add deploy/railway/auth-routes.mjs tests/auth-routes.test.mjs
git commit -m "feat: /auth/* route handlers with rate limits, signed session cookies"
```

---

### Task 4: Static pages (`deploy/railway/pages/*.html`)

**Files:**
- Create: `deploy/railway/pages/landing.html`
- Create: `deploy/railway/pages/signup.html`
- Create: `deploy/railway/pages/login.html`
- Create: `deploy/railway/pages/verify.html`
- Create: `deploy/railway/pages/reset.html`
- Test: `tests/auth-pages.test.mjs`

**Interfaces:**
- Consumes: nothing at runtime (static files; forms POST to Task 3's routes).
- Produces: five self-contained HTML files the gateway (Task 5) serves verbatim. Form fields must be named exactly `email`, `password`, `name`, `token` (what Task 3 reads). Every page reads its query-string flags (`sent`, `error`, `mail`, `reset`, `resent`, `token`) with a small inline script.

All pages share this design language (from `app/globals.css`, hand-copied because these pages cannot import it): background `#f2f2f7`, cards `#ffffff`, text `#1d1d21`, muted `#55555e`, accent `#007aff`, amber badge `#e8a013` on `#fff0d0`, border `#e3e3e8`, font stack `-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif`, border-radius 12px, buttons 44px tall.

- [ ] **Step 1: Write the failing test**

`tests/auth-pages.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pagesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "deploy", "railway", "pages",
);
const page = (name) => readFileSync(path.join(pagesDir, name), "utf8");

test("all five pages exist and are self-contained", () => {
  for (const name of ["landing.html", "signup.html", "login.html", "verify.html", "reset.html"]) {
    assert.ok(existsSync(path.join(pagesDir, name)), `${name} missing`);
    const html = page(name);
    assert.match(html, /^<!doctype html>/i);
    assert.doesNotMatch(html, /src="http/i, `${name} must not load external scripts`);
    assert.doesNotMatch(html, /href="http.*\.css/i, `${name} must not load external styles`);
    assert.match(html, /<style>/, `${name} must inline its CSS`);
  }
});

test("landing page carries the agreed copy and links", () => {
  const html = page("landing.html");
  assert.match(html, /Free during beta/);
  assert.match(html, /\$9\.99\/mo/);
  assert.match(html, /\$79\/yr/);
  assert.match(html, /coming soon/i);
  assert.match(html, /href="\/signup"/);
  assert.match(html, /href="\/login"/);
  assert.doesNotMatch(html, /vigilo|lantern/i, "old product names must not appear");
});

test("signup form posts the fields auth-routes reads", () => {
  const html = page("signup.html");
  assert.match(html, /action="\/auth\/signup"/);
  assert.match(html, /method="post"/i);
  for (const field of ['name="name"', 'name="email"', 'name="password"']) {
    assert.match(html, new RegExp(field));
  }
  assert.match(html, /minlength="10"/);
});

test("login form posts credentials and links to reset + resend", () => {
  const html = page("login.html");
  assert.match(html, /action="\/auth\/login"/);
  assert.match(html, /name="email"/);
  assert.match(html, /name="password"/);
  assert.match(html, /href="\/reset"/);
  assert.match(html, /action="\/auth\/resend"/);
});

test("reset page has both request and set-password forms", () => {
  const html = page("reset.html");
  assert.match(html, /action="\/auth\/request-reset"/);
  assert.match(html, /action="\/auth\/reset"/);
  assert.match(html, /name="token"/);
});

test("verify page links back into the app and to login", () => {
  const html = page("verify.html");
  assert.match(html, /href="\/login"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-sqlite --test tests/auth-pages.test.mjs`
Expected: FAIL — files missing.

- [ ] **Step 3: Create the pages**

Shared `<style>` block — paste this identical block into ALL five pages (self-containment beats DRY here; a comment in each file says the block is duplicated deliberately):

```html
<style>
  /* Duplicated verbatim across deploy/railway/pages/*.html — these pages are
     deliberately self-contained. Tokens mirror app/globals.css. */
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --ink: #1d1d21; --ink-muted: #55555e; --paper: #f2f2f7; --card: #ffffff;
    --line: #e3e3e8; --accent: #007aff; --accent-deep: #0a63c9;
    --amber: #b97706; --amber-soft: #fff0d0; --coral: #e5484d; --coral-soft: #fde3e4;
    --ok-soft: #ddf3e4; --ok-ink: #18794e;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif;
    background: var(--paper); color: var(--ink); line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); text-decoration: none; }
  .shell { max-width: 980px; margin: 0 auto; padding: 0 20px; }
  .topbar { display: flex; align-items: center; justify-content: space-between; padding: 18px 0; }
  .brand { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; color: var(--ink); }
  .brand span { color: var(--accent); }
  .btn {
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 44px; padding: 0 22px; border-radius: 12px; border: 0;
    font-size: 15px; font-weight: 600; cursor: pointer;
  }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: var(--accent-deep); }
  .btn-quiet { background: transparent; color: var(--accent); }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 16px;
    padding: 28px; width: 100%; max-width: 420px; margin: 48px auto;
  }
  .card h1 { font-size: 22px; letter-spacing: -0.02em; margin-bottom: 6px; }
  .card p.sub { color: var(--ink-muted); font-size: 14px; margin-bottom: 20px; }
  label { display: block; font-size: 14px; font-weight: 600; margin: 14px 0 6px; }
  input {
    width: 100%; min-height: 44px; padding: 0 12px; font-size: 16px;
    border: 1px solid var(--line); border-radius: 10px; background: #fff; color: var(--ink);
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
  form .btn { width: 100%; margin-top: 20px; }
  .note { font-size: 13px; color: var(--ink-muted); margin-top: 16px; text-align: center; }
  .flash { display: none; border-radius: 10px; padding: 10px 12px; font-size: 14px; margin-bottom: 8px; }
  .flash.error { background: var(--coral-soft); color: #b3261e; }
  .flash.ok { background: var(--ok-soft); color: var(--ok-ink); }
  .badge {
    display: inline-block; background: var(--amber-soft); color: var(--amber);
    font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
    padding: 4px 10px; border-radius: 999px;
  }
</style>
```

`deploy/railway/pages/landing.html` (full file):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>iTrack — credential and CE renewal tracking</title>
<meta name="description" content="iTrack keeps your professional licenses, certifications, and CE hours in one place — and reminds you before anything lapses. Free during beta.">
[SHARED STYLE BLOCK]
<style>
  .hero { text-align: center; padding: 64px 0 48px; }
  .hero h1 { font-size: clamp(32px, 6vw, 52px); font-weight: 700; letter-spacing: -0.03em; line-height: 1.1; margin: 18px 0 14px; }
  .hero p.lede { font-size: 18px; color: var(--ink-muted); max-width: 560px; margin: 0 auto 28px; }
  .hero .cta-row { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
  .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; padding: 24px 0 48px; }
  .feature { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 22px; }
  .feature .glyph { font-size: 26px; margin-bottom: 10px; }
  .feature h3 { font-size: 16px; margin-bottom: 6px; letter-spacing: -0.01em; }
  .feature p { font-size: 14px; color: var(--ink-muted); }
  .pricing { padding: 24px 0 56px; text-align: center; }
  .pricing h2 { font-size: 28px; letter-spacing: -0.02em; margin-bottom: 6px; }
  .pricing p.sub { color: var(--ink-muted); margin-bottom: 24px; }
  .tiers { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; max-width: 640px; margin: 0 auto; text-align: left; }
  .tier { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 24px; display: flex; flex-direction: column; }
  .tier h3 { font-size: 18px; }
  .tier .price { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; margin: 8px 0 2px; }
  .tier .cadence { font-size: 13px; color: var(--ink-muted); margin-bottom: 14px; }
  .tier ul { list-style: none; margin-bottom: 18px; }
  .tier li { font-size: 14px; padding: 5px 0 5px 24px; position: relative; }
  .tier li::before { content: "✓"; position: absolute; left: 0; color: var(--accent); font-weight: 700; }
  .tier .btn { margin-top: auto; }
  footer { border-top: 1px solid var(--line); padding: 24px 0 40px; text-align: center; font-size: 13px; color: var(--ink-muted); }
</style>
</head>
<body>
<div class="shell">
  <nav class="topbar">
    <div class="brand">i<span>Track</span></div>
    <div>
      <a class="btn btn-quiet" href="/login">Log in</a>
      <a class="btn btn-primary" href="/signup">Get started</a>
    </div>
  </nav>

  <header class="hero">
    <span class="badge">Free during beta</span>
    <h1>Every credential.<br>Every renewal. On time.</h1>
    <p class="lede">iTrack keeps your professional licenses, certifications, and CE hours in one place — and reminds you before anything lapses.</p>
    <div class="cta-row">
      <a class="btn btn-primary" href="/signup">Create your free account</a>
      <a class="btn btn-quiet" href="/login">I already have one</a>
    </div>
  </header>

  <section class="features" aria-label="Features">
    <div class="feature"><div class="glyph">📅</div><h3>Renewal deadlines</h3><p>See every expiration date at a glance, with how much runway you have left on each credential.</p></div>
    <div class="feature"><div class="glyph">🎓</div><h3>CE progress</h3><p>Track continuing-education hours against each credential's requirement, cycle by cycle.</p></div>
    <div class="feature"><div class="glyph">🔔</div><h3>Push reminders</h3><p>Get nudged before deadlines on your phone and desktop — not after they've passed.</p></div>
    <div class="feature"><div class="glyph">🗂️</div><h3>Evidence vault</h3><p>Keep certificates and proof of completion beside each credential, and export everything when an auditor asks.</p></div>
  </section>

  <section class="pricing" aria-label="Pricing">
    <h2>Simple pricing</h2>
    <p class="sub">Everything is free while iTrack is in beta.</p>
    <div class="tiers">
      <div class="tier">
        <h3>Free</h3>
        <div class="price">$0</div>
        <div class="cadence">ad-supported</div>
        <ul>
          <li>Unlimited credentials</li>
          <li>Renewal &amp; CE reminders</li>
          <li>Evidence vault and export</li>
        </ul>
        <a class="btn btn-primary" href="/signup">Sign up free</a>
      </div>
      <div class="tier">
        <h3>Pro <span class="badge">coming soon</span></h3>
        <div class="price">$9.99<span style="font-size:15px; font-weight:400;">/mo</span></div>
        <div class="cadence">or $79/yr</div>
        <ul>
          <li>Everything in Free</li>
          <li>No ads</li>
          <li>Priority support</li>
        </ul>
        <a class="btn btn-quiet" href="/signup">Start free today</a>
      </div>
    </div>
  </section>

  <footer>
    iTrack is in beta — free while we build. Questions? <a href="mailto:christophertskerritt@gmail.com">Get in touch</a>.
  </footer>
</div>
</body>
</html>
```

(Replace `[SHARED STYLE BLOCK]` with the shared `<style>` block above — in every page.)

`deploy/railway/pages/signup.html` (full file):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign up — iTrack</title>
[SHARED STYLE BLOCK]
</head>
<body>
<div class="shell">
  <nav class="topbar">
    <a class="brand" href="/">i<span>Track</span></a>
    <a class="btn btn-quiet" href="/login">Log in</a>
  </nav>
  <main class="card">
    <h1>Create your account</h1>
    <p class="sub">Free during beta. No card required.</p>
    <div class="flash ok" id="flash-sent">Check your email — we sent a verification link. It expires in 24 hours.</div>
    <div class="flash error" id="flash-mail-down">Your account was created, but the verification email could not be sent. Contact us and we'll activate you manually.</div>
    <div class="flash error" id="flash-email-taken">That email already has an account. <a href="/login">Log in instead.</a></div>
    <div class="flash error" id="flash-invalid">Please use a valid email, a display name, and a password of at least 10 characters.</div>
    <div class="flash error" id="flash-rate-limited">Too many attempts from your network. Try again in an hour.</div>
    <form action="/auth/signup" method="post" id="signup-form">
      <label for="name">Name</label>
      <input id="name" name="name" type="text" required maxlength="80" autocomplete="name">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="email">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required minlength="10" autocomplete="new-password">
      <button class="btn btn-primary" type="submit">Create account</button>
    </form>
    <p class="note">Already have an account? <a href="/login">Log in</a></p>
  </main>
</div>
<script>
  const params = new URLSearchParams(location.search);
  if (params.get("sent")) {
    document.getElementById(params.get("mail") === "down" ? "flash-mail-down" : "flash-sent").style.display = "block";
    document.getElementById("signup-form").style.display = "none";
  }
  const error = params.get("error");
  const flash = error && document.getElementById("flash-" + error);
  if (flash) flash.style.display = "block";
</script>
</body>
</html>
```

`deploy/railway/pages/login.html` (full file):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Log in — iTrack</title>
[SHARED STYLE BLOCK]
</head>
<body>
<div class="shell">
  <nav class="topbar">
    <a class="brand" href="/">i<span>Track</span></a>
    <a class="btn btn-quiet" href="/signup">Sign up</a>
  </nav>
  <main class="card">
    <h1>Welcome back</h1>
    <p class="sub">Log in to your iTrack account.</p>
    <div class="flash ok" id="flash-reset">Password updated — log in with your new password.</div>
    <div class="flash ok" id="flash-resent">If that account needs verification, a fresh link is on its way.</div>
    <div class="flash error" id="flash-bad-credentials">That email and password don't match.</div>
    <div class="flash error" id="flash-rate-limited">Too many attempts. Wait a few minutes and try again.</div>
    <div class="flash error" id="flash-unverified">
      That account hasn't been verified yet. Check your email, or
      <form action="/auth/resend" method="post" style="display:inline">
        <input type="hidden" name="email" id="resend-email">
        <button class="btn btn-quiet" type="submit" style="min-height:0;padding:0;font-size:14px;">resend the link</button>
      </form>.
    </div>
    <form action="/auth/login" method="post">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="email">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required autocomplete="current-password">
      <button class="btn btn-primary" type="submit">Log in</button>
    </form>
    <p class="note"><a href="/reset">Forgot your password?</a></p>
    <p class="note">New here? <a href="/signup">Create an account</a></p>
  </main>
</div>
<script>
  const params = new URLSearchParams(location.search);
  for (const flag of ["reset", "resent"]) {
    if (params.get(flag)) document.getElementById("flash-" + flag).style.display = "block";
  }
  const error = params.get("error");
  const flash = error && document.getElementById("flash-" + error);
  if (flash) flash.style.display = "block";
  document.getElementById("email").addEventListener("input", (event) => {
    document.getElementById("resend-email").value = event.target.value;
  });
</script>
</body>
</html>
```

`deploy/railway/pages/verify.html` (full file — shown only on failure; success redirects into the app):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verify email — iTrack</title>
[SHARED STYLE BLOCK]
</head>
<body>
<div class="shell">
  <nav class="topbar">
    <a class="brand" href="/">i<span>Track</span></a>
  </nav>
  <main class="card">
    <h1>Verification link problem</h1>
    <div class="flash error" id="flash-expired" style="display:block">
      This verification link is invalid, already used, or expired.
    </div>
    <p class="sub">Log in to request a fresh link — we'll offer to resend it if your account still needs verification.</p>
    <a class="btn btn-primary" href="/login" style="width:100%">Go to login</a>
  </main>
</div>
</body>
</html>
```

`deploy/railway/pages/reset.html` (full file — request form by default; set-password form when `?token=` present):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reset password — iTrack</title>
[SHARED STYLE BLOCK]
</head>
<body>
<div class="shell">
  <nav class="topbar">
    <a class="brand" href="/">i<span>Track</span></a>
    <a class="btn btn-quiet" href="/login">Log in</a>
  </nav>
  <main class="card">
    <div id="request-view">
      <h1>Reset your password</h1>
      <p class="sub">Enter your email and we'll send a reset link.</p>
      <div class="flash ok" id="flash-sent">If that email has an iTrack account, a reset link is on its way. It expires in 1 hour.</div>
      <div class="flash error" id="flash-rate-limited">Too many requests. Try again in an hour.</div>
      <form action="/auth/request-reset" method="post">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required autocomplete="email">
        <button class="btn btn-primary" type="submit">Send reset link</button>
      </form>
    </div>
    <div id="set-view" style="display:none">
      <h1>Choose a new password</h1>
      <p class="sub">At least 10 characters.</p>
      <div class="flash error" id="flash-invalid">Password must be at least 10 characters.</div>
      <div class="flash error" id="flash-expired">This reset link is invalid or expired. <a href="/reset">Request a new one.</a></div>
      <form action="/auth/reset" method="post">
        <input type="hidden" name="token" id="token">
        <label for="password">New password</label>
        <input id="password" name="password" type="password" required minlength="10" autocomplete="new-password">
        <button class="btn btn-primary" type="submit">Set new password</button>
      </form>
    </div>
    <p class="note"><a href="/login">Back to login</a></p>
  </main>
</div>
<script>
  const params = new URLSearchParams(location.search);
  const token = params.get("token");
  const error = params.get("error");
  if (token || error === "invalid") {
    document.getElementById("request-view").style.display = "none";
    document.getElementById("set-view").style.display = "block";
    if (token) document.getElementById("token").value = token;
  }
  if (params.get("sent")) document.getElementById("flash-sent").style.display = "block";
  if (error === "expired") {
    document.getElementById("request-view").style.display = "none";
    document.getElementById("set-view").style.display = "block";
    document.getElementById("flash-expired").style.display = "block";
  }
  const flash = error && document.getElementById("flash-" + error);
  if (flash) flash.style.display = "block";
</script>
</body>
</html>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-sqlite --test tests/auth-pages.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Visual check**

Open each page locally and eyeball it (no server needed):
`open deploy/railway/pages/landing.html` (and the other four). Confirm: readable, centered card layout, blue accent, amber beta badge, no broken layout at iPhone width (resize the window narrow).

- [ ] **Step 6: Commit**

```bash
git add deploy/railway/pages tests/auth-pages.test.mjs
git commit -m "feat: public landing, signup, login, verify, reset pages"
```

---

### Task 5: Gateway extraction + integration (`gateway.mjs`, `serve.mjs`)

**Files:**
- Create: `deploy/railway/gateway.mjs`
- Modify: `deploy/railway/serve.mjs` (keep supervisor/cron; move request handling to gateway)
- Test: `tests/auth-gateway.test.mjs`

**Interfaces:**
- Consumes: `createAuthRoutes(...)` object from Task 3 (`handle`, `userForRequest`, `issueSessionCookie`); `AuthStore.verifyEmail` (Task 1); page files (Task 4).
- Produces: `createGateway(options)` → `(req, res) => void` request listener, where `options` is:

```js
{
  users,            // Map from parseUsers() — env Basic accounts
  openIdentity,     // {email, displayName} | null
  authRoutes,       // from createAuthRoutes(...)
  store,            // AuthStore (for verifyEmail + Basic against DB users)
  pagesDir,         // absolute path to deploy/railway/pages
  upstreamPort,     // worker port to proxy to
}
```

**Request-handling order (implement exactly — this preserves every existing invariant):**

1. `GET /healthz` → 200 `ok` (before everything, as today).
2. `/__scheduled`, `/cdn-cgi/*`, `/internal/*` → 404 (as today).
3. `/api/widget-summary` (exact match) → proxy with `Authorization` preserved, **no identity headers** (as today).
4. If `openIdentity` is set → skip ALL new routing (no landing/auth pages; every request proxies as the open identity, exactly today's behavior).
5. `POST /auth/*` → `authRoutes.handle()`.
6. `GET /verify?token=…` → `store.verifyEmail(token)`; on success `authRoutes.issueSessionCookie(res, userId)` then 303 → `/`; on failure serve `verify.html` (200).
7. `GET /signup`, `/login`, `/reset` → serve the matching page file (200, `content-type: text/html; charset=utf-8`, `cache-control: no-store`).
8. Resolve identity: session cookie via `authRoutes.userForRequest(req)` → else Basic header against env `users` (existing `authenticate()` logic) → else Basic against DB (`store.authenticate(email, password)` where Basic username is the account **email**; only `ok: true` counts).
9. Identity found → proxy with `oai-authenticated-user-email` (+ display-name headers), stripping inbound `oai-*` and `authorization` — today's exact header logic.
10. No identity: `GET /` with `accept` containing `text/html` → serve `landing.html`. Any other `GET` whose `accept` contains `text/html` → 303 → `/login`. Everything else → 401 with `WWW-Authenticate: Basic realm="iTrack", charset="UTF-8"` (today's response — this is what the iOS shell and API clients rely on).

`serve.mjs` keeps: user parsing, open-identity parsing, wrangler spawn, `waitForWorker`, cron loop, signal handling, listen + startup log. It builds the store/routes/gateway like this (replacing the whole `http.createServer((req, res) => {...})` block):

```js
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { AuthStore } from "./auth.mjs";
import { createAuthRoutes } from "./auth-routes.mjs";
import { createResendSender } from "./email.mjs";
import { createGateway } from "./gateway.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_ROOT = path.dirname(PERSIST_DIR); // /data in production
mkdirSync(STATE_ROOT, { recursive: true });

// Session-signing secret: env wins; otherwise generate once and persist so
// cookies survive deploys without requiring manual setup.
const secretFile = path.join(STATE_ROOT, "auth-session-secret");
let sessionSecret = process.env.AUTH_SESSION_SECRET;
if (!sessionSecret) {
  if (!existsSync(secretFile)) {
    writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  sessionSecret = readFileSync(secretFile, "utf8").trim();
}

const store = new AuthStore(process.env.AUTH_DB_PATH ?? path.join(STATE_ROOT, "auth.db"));
const baseUrl =
  process.env.PUBLIC_BASE_URL ??
  (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PUBLIC_PORT}`);
const authRoutes = createAuthRoutes({
  store,
  secret: sessionSecret,
  baseUrl,
  sendEmail: createResendSender({
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.AUTH_EMAIL_FROM,
  }),
});
const server = http.createServer(
  createGateway({
    users: USERS,
    openIdentity: OPEN_IDENTITY,
    authRoutes,
    store,
    pagesDir: path.join(HERE, "pages"),
    upstreamPort: WORKER_PORT,
  }),
);
```

Also wire cleanup into the existing cron loop — inside `fireCron()` (or beside its `setInterval`) add:

```js
try {
  const { removedUsers } = store.cleanup();
  if (removedUsers > 0) console.log(`[auth] cleaned up ${removedUsers} stale unverified account(s)`);
} catch (error) {
  console.error("[auth] cleanup failed", error);
}
```

Note: after moving `digest`/`safeEqual` into `gateway.mjs`, drop the now-unused `timingSafeEqual`/`createHash` names from serve.mjs's `node:crypto` import (`randomBytes` stays — the scheduled secret and session-secret bootstrap use it).

Also: the fail-closed startup check loosens to allow DB-only mode — replace `if (USERS.size === 0 && !OPEN_IDENTITY) { exit }` with a warning log when both are empty (self-serve accounts are now a valid sole auth source), and extend the startup log: `` `iTrack proxy listening on :${PUBLIC_PORT} (${mode}, self-serve signup enabled), state in ${PERSIST_DIR}` ``.

`gateway.mjs` (full file):

```js
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
```

- [ ] **Step 1: Write the failing test**

`tests/auth-gateway.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-sqlite --test tests/auth-gateway.test.mjs`
Expected: FAIL — `gateway.mjs` not found.

- [ ] **Step 3: Create `gateway.mjs`** (full code above) **and rewrite `serve.mjs`**

For `serve.mjs`: delete the `digest`/`safeEqual`/`authenticate` functions, the `WIDGET_FEED_PATH` constant, and the whole `http.createServer((req, res) => {...})` block (they move to `gateway.mjs`); add the imports and wiring block shown in the Interfaces section; keep `parseUsers`, `parseOpenIdentity`, the wrangler spawn, `waitForWorker`, `fireCron`, signal handlers, and the final `server.listen(...)` (update its log line to append `, self-serve signup enabled`). Replace the fail-closed exit with:

```js
if (USERS.size === 0 && !OPEN_IDENTITY) {
  console.warn(
    "No ITRACK_USERS or ITRACK_OPEN_IDENTITY configured; only self-serve accounts can log in",
  );
}
```

- [ ] **Step 4: Run the new test, then the full suite**

Run: `node --experimental-sqlite --test tests/auth-gateway.test.mjs`
Expected: PASS.
Run: `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH" && npm run build && node --experimental-sqlite --test tests/*.test.mjs`
Expected: all tests pass (existing suite + 4 new files). If any existing test spawns `serve.mjs` directly, fix forward until green.

- [ ] **Step 5: Syntax-check serve.mjs wiring without wrangler**

Run: `node --experimental-sqlite --check deploy/railway/serve.mjs`
Expected: no output (parse OK). (Full runtime check happens in Task 6's Docker smoke.)

- [ ] **Step 6: Commit**

```bash
git add deploy/railway/gateway.mjs deploy/railway/serve.mjs tests/auth-gateway.test.mjs
git commit -m "feat: auth gateway with landing page, sessions, and Basic compat"
```

---### Task 6: Dockerfile, test script flag, local Docker smoke

**Files:**
- Modify: `Dockerfile` (CMD line)
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: a runnable container identical to what Railway will run.

- [ ] **Step 1: Add the sqlite flag**

`Dockerfile` last line becomes:

```dockerfile
CMD ["node", "--experimental-sqlite", "deploy/railway/serve.mjs"]
```

`package.json` test script becomes:

```json
"test": "npm run build && npm run build:nav-test && node --experimental-sqlite --test tests/*.test.mjs",
```

- [ ] **Step 2: Run the full suite once more**

Run: `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH" && npm test`
Expected: PASS.

- [ ] **Step 3: Local Docker build + run (standing deploy rule — required before push)**

```bash
docker build -t itrack-signup-test .
docker run --rm -d --name itrack-smoke -p 18080:8080 \
  -e PORT=8080 \
  -e ITRACK_USERS="chris:localtest:chris@local.test:Chris" \
  -e PERSIST_DIR=/data/wrangler-state \
  itrack-signup-test
sleep 45   # wrangler runtime warm-up
```

- [ ] **Step 4: Smoke the container**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18080/healthz                     # expect 200
curl -s http://127.0.0.1:18080/ -H "Accept: text/html" | grep -c "Free during beta"          # expect >= 1 (landing)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18080/signup -H "Accept: text/html" # expect 200
curl -s -o /dev/null -w "%{http_code}\n" -u chris:localtest http://127.0.0.1:18080/           # expect 200 (app via Basic)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18080/api/export                    # expect 401
# full signup flow (email unconfigured -> link is logged)
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:18080/auth/signup \
  -H "Origin: http://127.0.0.1:18080" \
  -d "email=smoke@example.com&name=Smoke&password=longenough1"                                # expect 303
docker logs itrack-smoke 2>&1 | grep "verification link for smoke@example.com"               # link present
# extract token from the logged link, then:
# curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:18080/verify?token=<TOKEN>"     # expect 303 + set-cookie
docker rm -f itrack-smoke
```

Every expectation must hold before proceeding. If wrangler fails to boot, `docker logs itrack-smoke` and fix before continuing.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile package.json
git commit -m "chore: enable node:sqlite flag in container and test runner"
```

---

### Task 7: Deploy to Railway + production smoke + memory

**Files:** none (operational task).

**Interfaces:**
- Consumes: the pushed main branch; Railway project **iTrack** (`0d9241ed-5a83-4314-b790-06946473ea89`), service **itrack**, environment **production**.

- [ ] **Step 1: Verify branch and push**

```bash
git branch --show-current   # must print: main
git log origin/main..main --oneline   # review exactly what ships
git push origin main
```

- [ ] **Step 2: Set Railway variables**

Generate a session secret locally: `openssl rand -hex 32`. Then set via Railway MCP `set_variables` on service `itrack` / environment `production`:
- `AUTH_SESSION_SECRET=<generated>`
- (leave `RESEND_API_KEY` and `AUTH_EMAIL_FROM` unset for now — sign-up will log verification links to the deploy logs until Chris finishes Resend setup; this is the documented fail-soft mode)

Note: setting variables triggers a redeploy — set them while the push-triggered build is queued, or accept two deploys.

- [ ] **Step 3: Watch the deploy**

Use Railway MCP `list_deployments` / `get_logs` until the new deploy is SUCCESS and logs show `iTrack proxy listening on :8080 (1 user, self-serve signup enabled)`.

- [ ] **Step 4: Production smoke**

```bash
BASE=https://itrack-production-da8b.up.railway.app
curl -s -o /dev/null -w "%{http_code}\n" $BASE/healthz                                  # 200
curl -s $BASE/ -H "Accept: text/html" | grep -c "Free during beta"                       # >= 1
curl -s -o /dev/null -w "%{http_code}\n" $BASE/signup -H "Accept: text/html"             # 200
curl -s -o /dev/null -w "%{http_code}\n" -u "chris:IygTcyTWjnIHk6OhvkJN" $BASE/          # 200  <- iOS/Basic path intact
curl -s -o /dev/null -w "%{http_code}\n" $BASE/api/export                                # 401
```

Then a real browser pass: open the landing page, sign up with a test address, confirm the verification link appears in Railway logs (email unconfigured), open it, land in the app signed in.

- [ ] **Step 5: Update memory + report**

Update `~/.claude/projects/-Users-chrisskerritt/memory/project_itrack_ledgerlift.md` (or a new memory file): landing + self-serve signup LIVE, auth architecture summary (gateway modules, `/data/auth.db`, session cookie name), OPEN items — Chris: create Resend account, verify sending domain, then set `RESEND_API_KEY` + `AUTH_EMAIL_FROM`; Phase 2 monetization spec queued. Update `MEMORY.md` index pointer.

---

## Verification checklist (post-implementation)

- [ ] `npm test` green (existing suite + auth-store, auth-email, auth-routes, auth-pages, auth-gateway).
- [ ] Landing page renders for anonymous browsers at `/`; app renders for authed users at `/`.
- [ ] Full flow works in production: sign up → verify (via logged link until Resend is configured) → session → app.
- [ ] `chris` Basic Auth still returns 200 (iOS app unaffected); widget feed still bypasses auth.
- [ ] `oai-*` header forgery test passes (stripped at the proxy).
- [ ] No changes under `worker/`, `app/`, `db/`, `drizzle/` (`git diff --stat origin/main@{1} -- worker app db drizzle` is empty).

## Phase 2 (explicitly deferred, own spec later)

Stripe subscriptions ($9.99/mo / $79/yr), per-user entitlements, ad slots (AdSense web / AdMob iOS) for the free tier, consent banner + privacy policy, iOS tier honoring.
