// HTTP handlers for /auth/* plus the session-cookie and rate-limit helpers
// the gateway uses. Pages themselves are static files served by the gateway.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "itrack_session";
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
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
