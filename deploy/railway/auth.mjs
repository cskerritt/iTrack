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
    this.name = "AuthError";
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

// Precomputed dummy hash so unknown-email logins cost exactly one scrypt,
// same as known emails (avoids a timing oracle on account existence).
const DUMMY_STORED = hashPassword("missing-user-placeholder");

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
    const stored = row?.password_scrypt ?? DUMMY_STORED;
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
