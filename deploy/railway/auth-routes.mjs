// HTTP handlers for /auth/* plus the session-cookie and rate-limit helpers
// the gateway uses. Pages themselves are static files served by the gateway.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "itrack_session";
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
export const COOKIE_REISSUE_AFTER_MS = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_BODY_BYTES = 32 * 1024;

const RATE_LIMITER_SWEEP_THRESHOLD = 50000;

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
      // Bound memory under key-churn floods (e.g. spoofed addresses): once
      // the map is large, sweep expired buckets before inserting. O(n), but
      // only on this rare trigger, so steady-state stays O(1).
      if (this.buckets.size > RATE_LIMITER_SWEEP_THRESHOLD) {
        for (const [staleKey, staleBucket] of this.buckets) {
          if (now - staleBucket.start >= this.windowMs) this.buckets.delete(staleKey);
        }
      }
      this.buckets.set(key, { start: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }
  // Non-counting probe: would `allow(key)` succeed right now?
  check(key) {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start >= this.windowMs) return true;
    return bucket.count < this.limit;
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

export function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    // Railway's edge APPENDS the real client address as the LAST entry of
    // x-forwarded-for; anything before it is client-supplied. Keying rate
    // limits on the first entry would let an attacker mint a fresh budget
    // per request by varying a fake prefix.
    const entries = String(forwarded).split(",");
    return entries[entries.length - 1].trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

const AUTH_PAGE_PREFIXES = ["/login", "/signup", "/reset", "/verify", "/auth/"];

// Where to send someone after they sign in. Only a same-origin relative path
// survives; anything else (absolute URL, protocol-relative `//host`, a
// backslash trick, control characters, an auth page) collapses to `/`.
export function safeNextPath(value) {
  if (typeof value !== "string") return "/";
  if (value.length === 0 || value.length > 2048) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return "/";
  if (AUTH_PAGE_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix}`))) return "/";
  return value;
}

export function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
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

// landing-auth-M-01: nothing user-controlled goes into an email body. The
// greeting is fixed; the address is the envelope, not the copy.
function verificationEmail(baseUrl, token) {
  const link = `${baseUrl}/verify?token=${token}`;
  return {
    subject: "Verify your iTrack email",
    text: `Hi,\n\nConfirm your email to activate your iTrack account:\n${link}\n\nThis link expires in 24 hours. If you didn't sign up, ignore this email.`,
    html: `<p>Hi,</p><p>Confirm your email to activate your iTrack account:</p><p><a href="${link}">${link}</a></p><p>This link expires in 24 hours. If you didn't sign up, ignore this email.</p>`,
  };
}

function resetEmail(baseUrl, token) {
  const link = `${baseUrl}/reset?token=${token}`;
  return {
    subject: "Reset your iTrack password",
    text: `Hi,\n\nReset your iTrack password:\n${link}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
    html: `<p>Hi,</p><p>Reset your iTrack password:</p><p><a href="${link}">${link}</a></p><p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>`,
  };
}

const ACCOUNT_LOCK_DELAY_MS = 2000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createAuthRoutes({ store, sendEmail, secret, baseUrl, now = () => Date.now(), sleep = defaultSleep }) {
  const signupLimiter = new RateLimiter(5, 60 * 60 * 1000, { now });
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000, { now });
  const accountLimiter = new RateLimiter(10, 15 * 60 * 1000, { now });
  const resetLimiter = new RateLimiter(3, 60 * 60 * 1000, { now });
  const resendLimiter = new RateLimiter(3, 60 * 60 * 1000, { now });
  const expectedOrigin = new URL(baseUrl).origin;

  function sessionForRequest(req) {
    const cookie = readCookie(req, SESSION_COOKIE);
    if (!cookie) return null;
    const raw = unsignValue(cookie, secret);
    if (!raw) return null;
    const user = store.sessionUser(raw);
    if (!user) return null;
    return { user, raw, cookie };
  }

  function userForRequest(req) {
    return sessionForRequest(req)?.user ?? null;
  }

  function issueSessionCookie(res, userId) {
    const raw = store.createSession(userId);
    res.setHeader("set-cookie", sessionCookieHeader(signValue(raw, secret)));
  }

  // landing-auth-M-03: the DB row slides on every request but the browser
  // discards the cookie at its original Max-Age. Once a day, send the same
  // signed value again with a fresh 30-day Max-Age.
  function slideSessionCookie(session, nowMs = now()) {
    if (!session) return null;
    if (nowMs - session.user.cookieIssuedAt < COOKIE_REISSUE_AFTER_MS) return null;
    store.markCookieIssued(session.raw);
    return sessionCookieHeader(session.cookie);
  }

  // security-M-03: never the link, never the address. The event kind and the
  // sender's error code are all an operator needs to know mail is broken.
  async function deliver(kind, email, message) {
    const result = await sendEmail({
      to: email, subject: message.subject, html: message.html, text: message.text,
    });
    if (!result.ok) {
      console.log(JSON.stringify({ event: "auth_mail_failed", kind, error: result.error }));
    }
    return result;
  }

  async function handle(req, res, pathname) {
    if (!pathname.startsWith("/auth/")) return false;

    // security-07: browsers send Origin on every cross-site POST and on
    // same-site form posts; Referer covers the rare client that omits it.
    // Neither present means a non-browser client or a stripped header —
    // reject, because SameSite=Lax cannot protect a login that sets a brand
    // new cookie.
    const declared = req.headers.origin ?? req.headers.referer;
    let declaredOrigin = null;
    try {
      declaredOrigin = declared ? new URL(declared).origin : null;
    } catch {
      declaredOrigin = null;
    }
    if (declaredOrigin !== expectedOrigin) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Cross-origin request rejected");
      return true;
    }

    const route = pathname.slice("/auth/".length);
    const known = ["signup", "login", "logout", "request-reset", "reset", "resend", "verify"];
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
      const sentPage = `/signup?sent=1&email=${encodeURIComponent(email)}`;
      let created;
      try {
        created = store.createUser({ email, displayName: name, password });
      } catch (error) {
        // A verified account already owns this address. Say exactly what a
        // fresh signup says (infra-M-02) and send nothing.
        if (error?.code === "email-taken") return redirect(res, sentPage), true;
        throw error;
      }
      const result = await deliver("verification", email, verificationEmail(baseUrl, created.verifyToken));
      if (result.ok) return redirect(res, sentPage), true;
      const reason = result.error === "mail_unconfigured" ? "unconfigured" : "failed";
      return redirect(res, `/signup?sent=1&mail=${reason}&email=${encodeURIComponent(email)}`), true;
    }

    if (route === "login") {
      if (!loginLimiter.allow(`login:${ip}`)) return redirect(res, "/login?error=rate-limited"), true;
      const accountKey = `account:${email}`;
      if (!accountLimiter.check(accountKey)) {
        // Tripped: fixed delay, generic answer, no scrypt.
        await sleep(ACCOUNT_LOCK_DELAY_MS);
        return redirect(res, "/login?error=bad-credentials"), true;
      }
      const attempt = store.authenticate(email, password);
      if (!attempt.ok) {
        // security-04: `unverified` and `bad-credentials` collapse into one
        // answer; the resend form on the login page covers the unverified case.
        accountLimiter.allow(accountKey);
        return redirect(res, "/login?error=bad-credentials"), true;
      }
      issueSessionCookie(res, attempt.user.id);
      return redirect(res, safeNextPath(fields.get("next"))), true;
    }

    if (route === "verify") {
      // security-03 / landing-auth-05: the token is consumed here, on an
      // explicit POST from the confirm page, never on the GET a mail scanner
      // makes.
      const verified = store.verifyEmail(fields.get("token") ?? "");
      if (!verified) return redirect(res, "/verify?error=expired"), true;
      issueSessionCookie(res, verified.userId);
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
      if (issued) await deliver("reset", email, resetEmail(baseUrl, issued.token));
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

    // resend — its own limiter and its own email field (landing-auth-06).
    const returnTo = fields.get("return") === "signup"
      ? `/signup?sent=1&email=${encodeURIComponent(email)}`
      : "/login?sent=1";
    const limitedTo = fields.get("return") === "signup" ? "/signup?error=rate-limited" : "/login?error=rate-limited";
    if (!resendLimiter.allow(`resend:${ip}`)) return redirect(res, limitedTo), true;
    const reissued = EMAIL_RE.test(email) ? store.newVerifyToken(email) : null;
    if (reissued) {
      await deliver("verification", email, verificationEmail(baseUrl, reissued.token));
    }
    return redirect(res, returnTo), true;
  }

  return { handle, userForRequest, sessionForRequest, issueSessionCookie, slideSessionCookie };
}
