# iTrack public landing page + self-serve sign-up

**Date:** 2026-08-11
**Status:** Approved by Chris (brainstorming session)
**Approach:** A — auth gateway in the Railway proxy (`deploy/railway/serve.mjs`)

## Goal

Open iTrack to the public: an unauthenticated visitor lands on a marketing
page, signs up with email + password, verifies their address, and uses the
app. Positioning is **free during beta**. The app stays on
`itrack-production-da8b.up.railway.app` for now (no custom domain).

## Decisions made

| Question | Decision |
| --- | --- |
| Audience | Fully public, open sign-up (no approval gate, no invites) |
| Email | Resend API for verification + password-reset mail |
| Domain | Stay on railway.app URL; custom domain later |
| iOS app | Keep Basic Auth working alongside sessions — iOS app/widget unchanged |
| Pricing copy | "Free during beta" |
| Architecture | A: proxy gateway (not worker/D1, not third-party auth) |

## Background / constraints

- The app is Next.js built for Cloudflare Workers, run under wrangler's local
  runtime inside the Railway container. The worker trusts
  `oai-authenticated-user-email` (+ display-name) headers injected by the
  proxy in `deploy/railway/serve.mjs`; user identity/data is keyed by a
  SHA-256 of the email (`db/identity.ts`). The worker is therefore already
  multi-user — only account *management* is missing.
- Today the proxy authenticates via HTTP Basic against the static
  `ITRACK_USERS` env var (or signs everyone in via `ITRACK_OPEN_IDENTITY`).
- `/api/widget-summary` bypasses Basic Auth and is checked in-worker against
  `ITRACK_WIDGET_TOKEN` (iOS widget). This must not change.
- The container is Node 22 (`node:22-bookworm-slim`); a Railway volume is
  mounted at `/data`.

## Architecture

`deploy/railway/serve.mjs` grows into a small auth gateway. New modules
under `deploy/railway/`:

- `serve.mjs` — existing supervisor + proxy loop; routes public auth paths
  to the auth module, everything else through the auth gate to the worker.
- `auth.mjs` — user store, sessions, tokens, rate limiting, `/auth/*`
  handlers, Resend client.
- `pages/` — self-contained static HTML (inline CSS, no external assets):
  `landing.html`, `signup.html`, `login.html`, `verify.html`, `reset.html`
  (request form + set-new-password form).

Auth state lives in `/data/auth.db` (SQLite via Node's built-in
`node:sqlite`; Dockerfile CMD gains `--experimental-sqlite`). No new runtime
npm dependencies. The Cloudflare worker and the Next app change **zero
lines**.

## Routes

Public (no auth required):

- `GET /` when the request carries no valid session/Basic credentials →
  landing page. (Logged in → proxied to the app as today.)
- `GET /signup`, `/login`, `/verify?token=…`, `/reset`, `/reset?token=…`
- `POST /auth/signup`, `/auth/login`, `/auth/logout`,
  `/auth/request-reset`, `/auth/reset`
- `GET /healthz` (existing), `GET /api/widget-summary` (existing exemption)

Everything else requires authentication:

1. Valid session cookie, or
2. HTTP Basic — checked against `ITRACK_USERS` env entries first, then
   against **verified** DB accounts (so the iOS wrapper can use either).

Either way the proxy injects the same trusted identity headers as today and
strips client-supplied `oai-*` and `Authorization` headers unchanged.

## Data model (`/data/auth.db`)

- `users(id, email UNIQUE COLLATE NOCASE, display_name, password_scrypt,
  created_at, verified_at NULL)`
- `tokens(token_hash PRIMARY KEY, user_id, kind CHECK(kind IN
  ('verify','reset')), expires_at, used_at NULL)` — raw token only ever in
  the emailed link; 24 h expiry (verify), 1 h (reset); single-use.
- `sessions(session_hash PRIMARY KEY, user_id, created_at, expires_at,
  last_seen_at)` — 30-day sliding expiry; raw session id only in the cookie.

## Flows

- **Sign-up:** email + display name + password (min 10 chars) → account
  created unverified → verification email → link hits `/verify?token=` →
  `verified_at` set → session issued, redirect into the app.
- **Login:** email + password; unverified accounts are refused with a
  "check your email" message and a re-send affordance (rate-limited).
- **Reset:** request form always responds "if that account exists, we sent
  a link" (no enumeration); link sets a new password, invalidates all the
  user's sessions, issues a fresh one.
- **Logout:** deletes the session row, clears the cookie.

## Email (Resend)

- `RESEND_API_KEY` env var; `AUTH_EMAIL_FROM` for the sender address.
- ⚠️ **Gate:** without a verified sending domain in Resend, only the
  account owner's own address is deliverable. Chris must add Resend's DNS
  records to a domain he owns (e.g. a kwvrs.com subdomain) before sign-up
  works for the public. Links in emails point at the railway.app URL; the
  sending domain is independent of the app URL.
- Email send failures surface to the user ("couldn't send, try again");
  sign-up rows without verification are eligible for cleanup after 7 days.

## Security

- scrypt (`node:crypto`, N=16384, r=8, p=1, 32-byte salt) password hashes;
  timing-safe comparisons everywhere (pattern already in serve.mjs).
- Session cookie: `httpOnly; Secure; SameSite=Lax; Path=/`, value is a
  256-bit random id; DB stores its SHA-256 only. `AUTH_SESSION_SECRET` env
  var HMAC-signs the cookie value (defense in depth if the DB leaks).
- Per-IP in-memory rate limits: sign-up 5/hr, login 10/15 min,
  reset/re-send 3/hr. 429 with plain message on breach.
- POST handlers check `Origin`/`Referer` against the request host (CSRF,
  belt-and-braces on top of SameSite).
- No user enumeration: identical responses for existing/missing emails on
  sign-up conflict is the exception — respond "account exists, log in
  instead" only after the rate limiter, accepted trade-off for usability.
- Existing protections unchanged: `oai-*` header stripping, widget-path
  scoping, `/internal/*` and `/__scheduled` 404s, fail-closed startup.

## Landing page

Self-contained static HTML in the app's iOS neutral+blue design language
(match `app/globals.css` tokens by hand — the page can't import them):

- Hero: product name, one-line pitch ("Track your professional credentials
  and never miss a CE renewal"), **Free during beta** badge, primary CTA →
  `/signup`, secondary "Log in".
- Three-to-four feature blurbs: renewal deadlines & progress, push
  reminders, evidence vault, calendar/ICS + export.
- Footer: beta note, contact mailto.
- No screenshots at launch (no asset pipeline in the proxy); revisit later.

## Compatibility

- `ITRACK_USERS` env accounts keep working (Basic) — Chris's login and data
  untouched; same email via web sign-up would map to the same identity
  (email-keyed), which is fine and intentional.
- `ITRACK_OPEN_IDENTITY`, if ever set, keeps today's semantics (bypasses
  everything, including the new pages — it wins before routing).
- iOS app + widget: no changes required or made.

## Testing

- Vitest unit tests for `auth.mjs`: hashing round-trip, token lifecycle,
  session expiry/sliding, rate limiter, email normalization.
- Integration test: boot the proxy against a stub worker; assert landing vs
  app routing, full sign-up→verify→login→logout flow (Resend mocked),
  Basic Auth for env + DB users, widget-path exemption, header stripping.
- Local Docker build + run before push (standing deploy rule); manual smoke
  on Railway after deploy.

## Ops / rollout

- New env vars: `RESEND_API_KEY`, `AUTH_EMAIL_FROM`, `AUTH_SESSION_SECRET`.
- Dockerfile: CMD gains `--experimental-sqlite`.
- Deploy: push to main → Railway auto-deploys. Rollback = revert commit.
- Open item for Chris: Resend account + sending-domain DNS verification.

## Out of scope (YAGNI)

Custom domain, paid tiers/billing, OAuth/social login, admin user list UI,
email change flow, account deletion UI, migrating iOS app off Basic Auth,
screenshots on the landing page.
