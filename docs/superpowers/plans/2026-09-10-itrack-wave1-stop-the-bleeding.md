# iTrack Wave 1 — Stop the Bleeding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make itrackceu.com safe to invite strangers to: session-cookie-only gateway (no Basic, no User-Agent gate, no widget bypass), a verification flow that survives mail scanners and squatters, the log-activity crash fixed and fenced by an error boundary + beacon, a working sign-out, no pricing/beta copy, APNs and the widget feed deleted, and a bootstrap account that replaces Chris's env login.

**Architecture:** The Railway gateway (`deploy/railway/gateway.mjs`, `serve.mjs`, `auth-routes.mjs`, `auth.mjs`, `email.mjs`, `pages/*.html`) is rewritten around one credential — the signed `itrack_session` cookie — and routes by path + Accept only. The Cloudflare worker keeps trusting the `oai-authenticated-user-*` headers the gateway injects; worker-side changes are deletions (widget feed, APNs) plus D1 migration `0013_drop_apns.sql`. The React client (`app/ITrackApp.tsx`) gets targeted triage: five handler fixes, an `ErrorBoundary` + `/api/client-error` beacon, a POST sign-out form, a JSON-safe fetch helper (`app/lib/apiResponse.ts`), per-route titles + focus (`app/lib/routeTitle.ts`), and `inert` on the parked screen. Tests are rewritten alongside each change so `npm test` is green at every commit.

**Tech Stack:** Node 22 (`node:sqlite` behind `--experimental-sqlite`, `node:zlib`, `node:crypto`), `node --test`, Vinext/Next App Router on workerd via wrangler 4.92, React 19.2, Drizzle Kit 0.31 (sqlite), Playwright (`@playwright/test`, new devDependency, e2e only), Docker, Railway.

**Spec:** `docs/superpowers/specs/2026-09-10-itrack-web-redesign-design.md` — this plan implements **section 3** (3.1 gateway/auth model, 3.2 app triage, 3.3 verification), the Wave 1 parts of **section 8** (migration `0013_drop_apns.sql`, identity unchanged) and **section 10** items 5–6 (bootstrap password, env deletion order). Sections 4–7 are later waves and are deliberately not planned here. Audit finding ids cited per task refer to `docs/audits/2026-09-10-audit/findings.json`.

## Global Constraints

- **Node:** use Node 22 at `$HOME/.local/node/node-v22.22.0-darwin-arm64/bin` (Node 25 on this machine has an npm/TLS bug). Every shell in this plan starts with `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"`.
- **Repo / branch:** `/Users/chrisskerritt/Documents/New project/Vigilo`, remote `origin` = `https://github.com/cskerritt/iTrack.git`. Work on branch `feat/wave1-stop-the-bleeding` cut from `main`; merge to `main` only in Task 15 (pushes to `main` auto-deploy to Railway). Run `git branch --show-current` before every commit — another session may share this tree.
- **Test entry points:** `npm test` = `npm run build && npm run build:nav-test && node --experimental-sqlite --test tests/*.test.mjs` (a full worker build, ~minutes). While iterating run only your file: `node --experimental-sqlite --test tests/<file>.test.mjs`. Tests that import `dist/server/index.js` (`tests/rendered-html.test.mjs`, `tests/real-sqlite-seed.test.mjs`) need `npm run build` first. **Stop any `npm run dev` server on :3000 before `npm run build` / `npm test`** (they share `.wrangler/` state and the build clobbers it); start it again for the Playwright task. `npm run typecheck` (`tsc --noEmit`) and `npm run lint` (`eslint .`) are safe at any time.
- **Green at every commit:** each task rewrites the tests its change breaks in the same commit; `npm test`, `npm run typecheck`, `npm run lint` must pass at every task's final step.
- **Session cookie is the only credential** (spec 3.1). No HTTP Basic acceptance anywhere; no `ITRACK_USERS` / `VIGILO_USERS` / `LANTERN_USERS` / `ITRACK_OPEN_IDENTITY` handling; no Basic success cache; no Basic limiter.
- **Routing by path and Accept, never by User-Agent** (spec 3.1). The string `user-agent` must not appear in `deploy/railway/gateway.mjs` after Task 3.
- **Unauthenticated contract** (spec 3.1, verbatim): `GET /` with an HTML Accept serves `landing.html`; any other app path with an HTML Accept 303s to `/login?next=<path+query>` (only same-origin relative paths are accepted for `next`, else `/`); `/api/*` and any non-HTML request answer `401 {"error":"unauthenticated"}` with `Cache-Control: no-store` and **no** `WWW-Authenticate` header. `HEAD` mirrors `GET` semantics.
- **Public allowlist** (spec 3.1): `/robots.txt`, `/sitemap.xml`, `/favicon.ico`, `/manifest.webmanifest`, `/icons/*`, `/og.png`, `/offline.html`, `/sw.js`, `/_next/static/*` and the built asset directory (`/assets/*` in this build, plus `/ocr/*` and the three icon PNGs the service worker precaches), `/healthz` — served without auth, with caching.
- **Security headers on every response** (spec 3.1, verbatim): `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self), microphone=(), geolocation=()`, `X-Frame-Options: DENY`, and `Content-Security-Policy-Report-Only: default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; frame-ancestors 'none'`. Public pages are gzip/brotli compressed and sent with `Cache-Control: public, max-age=300`.
- **Copy rules:** no "beta", no "Pro", no prices, no "ad-supported", no tiers anywhere (spec §1.3). Neutral auth copy is exactly: `If that address can be used, we've sent an email to it.` Mail-unconfigured copy is exactly: `Email delivery is not set up yet; contact support@itrackceu.com`. Display names are never interpolated into email bodies. Verification/reset links are never written to logs.
- **CSRF:** every `/auth/*` POST requires an `Origin` or `Referer` whose origin equals `PUBLIC_BASE_URL`'s origin; absence is rejected with 403.
- **Rate limits:** per-IP limiters keyed on the **last** `x-forwarded-for` entry stay; add a per-account login limiter (10 failures / 15 min → generic error after a fixed 2 s delay).
- **Bootstrap:** `AUTH_BOOTSTRAP_USERS="email:password[;email:password]"` read once at startup; creates **verified** accounts for emails with no account; never touches existing accounts; never logs the password. **Never write a real password into this plan, a commit, a test fixture, or a doc.** The only allowed placeholder anywhere in this plan is `<generated>` for an operator-supplied secret.
- **Env deletion order (code before env, spec 3.1 + §10.6):** code merged → deployed → live curl matrix green → Chris confirms bootstrap login → then delete `ITRACK_USERS` (and any `VIGILO_USERS`/`LANTERN_USERS`), then `ITRACK_WIDGET_TOKEN`, then `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, `APNS_BUNDLE_ID`, `APNS_ENVIRONMENT` on Railway. Chris then revokes APNs key `U3F4W5JABK`.
- **Protected identifiers (do not touch):** the `license-lantern:` hash salt, the `oai-authenticated-user-*` header names, the `vigilo-r2` bucket name, `license-lantern-static` SW cache prefix, the `itrack_session` cookie name.
- **Commit trailer:** every commit message ends with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk`

## File map (what changes, and who owns it)

| Path | Task | Change |
|---|---|---|
| `deploy/railway/pages/landing.html`, `signup.html` | 1, 7 | pricing/beta copy out; noindex; resend forms |
| `public/robots.txt`, `public/sitemap.xml`, `public/favicon.ico` | 1 | new static files |
| `deploy/railway/auth.mjs` | 2 | replace-unverified signup, verified bootstrap create, `cookie_issued_at` on sessions |
| `deploy/railway/gateway.mjs` | 3, 4, 5 | full rewrite: session-only routing, allowlist, normalisation, headers, compression, sliding cookie, client-error beacon |
| `deploy/railway/serve.mjs` | 3, 8, 9, 10 | drop env users/open identity; fail-closed = secret + DB; bootstrap; drop widget/APNs var forwarding |
| `deploy/railway/auth-routes.mjs` | 5, 6, 7 | `sessionForRequest`, `slideSessionCookie`, `safeNextPath`, strict CSRF, account limiter, `next`, no-name emails, no link logging, `/auth/verify`, resend limiter |
| `deploy/railway/email.mjs` | 6 | `mail_unconfigured` / `send_failed` result codes |
| `deploy/railway/pages/login.html`, `verify.html`, `reset.html` | 7 | `next` field, generic error, POST confirm, resend forms, neutral copy, noindex |
| `deploy/railway/bootstrap.mjs` | 8 | `parseBootstrapUsers`, `applyBootstrapUsers` |
| `README.md`, `Dockerfile` | 3, 8 | prose only |
| `app/api/widget-summary/`, `app/lib/widgetSummary.ts`, `tests/widget-summary.test.mjs` | 9 | deleted |
| `app/lib/apns*.ts`, `app/api/apns-token/`, `tests/apns-*.test.mjs` | 10 | deleted |
| `worker/index.ts`, `db/schema.ts`, `db/runtime.ts`, `db/cloudflare.d.ts`, `app/lib/reminders.ts`, `app/lib/pushDelivery.ts`, `app/lib/readiness.ts` | 9, 10 | remove widget/APNs surface |
| `drizzle/0013_drop_apns.sql`, `drizzle/meta/0013_snapshot.json`, `drizzle/meta/_journal.json` | 10 | generated migration |
| `app/ITrackApp.tsx` | 11, 13, 14 | five handler fixes; sign-out form; fetch helper wiring; titles/focus/inert |
| `tests/app-source-guards.test.mjs` | 11, 13, 14 | static regression guards over the client source |
| `tests/e2e/log-activity-typing.spec.ts`, `playwright.config.ts`, `package.json` | 11 | Playwright regression test + `test:e2e` |
| `app/components/ErrorBoundary.tsx`, `app/components/ClientErrorBeacon.tsx`, `app/lib/clientError.ts`, `app/error.tsx`, `app/not-found.tsx`, `app/layout.tsx` | 12 | boundary + beacon + route error pages |
| `app/lib/apiResponse.ts` | 13 | JSON-safe response reader |
| `app/lib/routeTitle.ts` | 14 | per-route `document.title` |
| `tests/auth-*.test.mjs`, `tests/rendered-html.test.mjs`, `tests/real-sqlite-seed.test.mjs`, new `tests/*.test.mjs` | each | rewritten alongside |

---

### Task 1: Remove pricing/beta copy, add robots/sitemap/favicon, noindex on auth pages

**Rationale:** landing-auth-08 (P2, CONFIRMED — landing sells "Free during beta", a $0 ad-supported tier and a $9.99/mo "Pro coming soon"; `tests/auth-pages.test.mjs:25-28` and `tests/auth-gateway.test.mjs:79` pin that copy), architecture-18 (tests pin copy that product decision 3 removes), landing-auth-04 / infra-09 (no robots/sitemap). Verified locations: `deploy/railway/pages/landing.html:7` (meta description tail "Free during beta."), `:53-57` (`.badge` CSS), `:69-80` (`.pricing`/`.tiers`/`.tier` CSS), `:95` (badge), `:111-138` (pricing section), `:140-142` (footer sentence); `deploy/railway/pages/signup.html:67` ("Free during beta. No card required."). `tests/rendered-html.test.mjs` pins **none** of this copy (grep for `beta`, `$9`, `$79`, `ad-supported`, `coming soon` returns nothing), so only the two auth test files change.

**Files:**
- Modify: `deploy/railway/pages/landing.html:7, 53-57, 69-80, 95, 111-138, 140-142`
- Modify: `deploy/railway/pages/signup.html:6-7, 67`
- Modify: `deploy/railway/pages/login.html:6-7`, `verify.html:6-7`, `reset.html:6-7` (noindex meta only)
- Create: `public/robots.txt`, `public/sitemap.xml`, `public/favicon.ico`
- Test: `tests/auth-pages.test.mjs:23-32`, `tests/auth-gateway.test.mjs:79`

**Interfaces:**
- Consumes: nothing.
- Produces: static files under `public/` that the build copies to `dist/client/` and the worker serves via its `ASSETS` binding; Task 3 allowlists their paths in the gateway. Auth pages carry `<meta name="robots" content="noindex">`; landing does not.

- [ ] **Step 1: Create the branch**

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
git checkout main && git pull --ff-only && git checkout -b feat/wave1-stop-the-bleeding
```

- [ ] **Step 2: Rewrite the landing-copy test to assert absence**

Replace `tests/auth-pages.test.mjs` lines 23-32 (the `landing page carries the agreed copy and links` test) with:

```js
test("landing page carries no pricing, tier, or beta copy and keeps its links", () => {
  const html = page("landing.html");
  assert.doesNotMatch(html, /\$\d/, "no prices");
  assert.doesNotMatch(html, /\bbeta\b/i, "no beta copy");
  assert.doesNotMatch(html, /ad-supported/i, "no ad tier");
  assert.doesNotMatch(html, /coming soon/i, "no Pro teaser");
  assert.doesNotMatch(html, /<h3>Pro\b/, "no Pro tier");
  assert.doesNotMatch(html, /class="tier"|class="pricing"/, "pricing section removed");
  assert.match(html, /href="\/signup"/);
  assert.match(html, /href="\/login"/);
  assert.match(html, /mailto:support@itrackceu\.com/);
  assert.doesNotMatch(html, /name="robots"/, "landing is indexable");
  assert.doesNotMatch(html, /vigilo|lantern/i, "old product names must not appear");
});

test("auth pages are noindex and signup carries no beta copy", () => {
  for (const name of ["signup.html", "login.html", "verify.html", "reset.html"]) {
    assert.match(page(name), /<meta name="robots" content="noindex">/, `${name} must be noindex`);
  }
  assert.doesNotMatch(page("signup.html"), /\bbeta\b/i);
  assert.match(page("signup.html"), /No card required\./);
});

test("robots.txt and sitemap.xml exist and name only the public routes", () => {
  const publicDir = path.join(pagesDir, "..", "..", "..", "public");
  const robots = readFileSync(path.join(publicDir, "robots.txt"), "utf8");
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.match(robots, /^Sitemap: https:\/\/itrackceu\.com\/sitemap\.xml$/m);
  const sitemap = readFileSync(path.join(publicDir, "sitemap.xml"), "utf8");
  for (const loc of ["https://itrackceu.com/", "https://itrackceu.com/login", "https://itrackceu.com/signup"]) {
    assert.match(sitemap, new RegExp(`<loc>${loc.replace(/[/.]/g, "\\$&")}</loc>`));
  }
  assert.doesNotMatch(sitemap, /credentials|history|profile/);
  const favicon = readFileSync(path.join(publicDir, "favicon.ico"));
  assert.equal(favicon.readUInt16LE(2), 1, "favicon.ico is an ICO container (type 1)");
});
```

Also change `tests/auth-gateway.test.mjs:79` from `assert.match(await landing.text(), /Free during beta/);` to `assert.match(await landing.text(), /Every credential\./);` (Task 3 rewrites this file entirely; this keeps it green meanwhile).

- [ ] **Step 3: Run the page test to see it fail**

Run: `node --experimental-sqlite --test tests/auth-pages.test.mjs`
Expected: FAIL — `no prices`, missing `name="robots"`, missing `public/robots.txt`.

- [ ] **Step 4: Edit landing.html**

1. Line 7: change the description to `<meta name="description" content="iTrack keeps your professional licenses, certifications, and CE hours in one place — and reminds you before anything lapses.">`.
2. Delete lines 53-57 (`.badge { ... }` rule) and lines 69-80 (`.pricing`, `.pricing h2`, `.pricing p.sub`, `.tiers`, `.tier`, `.tier h3`, `.tier .price`, `.tier .cadence`, `.tier ul`, `.tier li`, `.tier li::before`, `.tier .btn`).
3. Delete line 95 (`<span class="badge">Free during beta</span>`).
4. Delete lines 111-138 (the whole `<section class="pricing" aria-label="Pricing">…</section>`).
5. Replace the footer (lines 140-142) with:

```html
  <footer>
    Questions? <a href="mailto:support@itrackceu.com">Get in touch</a>.
  </footer>
```

- [ ] **Step 5: Edit the four auth pages**

In `signup.html`, `login.html`, `verify.html`, `reset.html` insert directly after the `<meta name="viewport" …>` line (line 5 in each):

```html
<meta name="robots" content="noindex">
```

In `signup.html` line 67 change `<p class="sub">Free during beta. No card required.</p>` to `<p class="sub">No card required.</p>`. Delete the `.badge` CSS rule (lines 52-56) from all four auth pages as well — it is unused once the landing badge is gone.

- [ ] **Step 6: Create the public files**

`public/robots.txt`:

```
User-agent: *
Disallow: /api/
Disallow: /auth/
Disallow: /credentials
Disallow: /history
Disallow: /profile
Disallow: /verify
Disallow: /reset
Sitemap: https://itrackceu.com/sitemap.xml
```

`public/sitemap.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://itrackceu.com/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>https://itrackceu.com/login</loc><changefreq>monthly</changefreq><priority>0.3</priority></url>
  <url><loc>https://itrackceu.com/signup</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>
</urlset>
```

`public/favicon.ico` — there is no ICO in the repo; wrap the existing 192 px PNG in an ICO container (PNG-in-ICO is supported by every current browser):

```bash
node -e '
const fs = require("node:fs");
const png = fs.readFileSync("public/icon-192.png");
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry.writeUInt8(192, 0); entry.writeUInt8(192, 1); entry.writeUInt8(0, 2); entry.writeUInt8(0, 3);
entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6); entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12);
fs.writeFileSync("public/favicon.ico", Buffer.concat([header, entry, png]));
console.log("favicon.ico", 22 + png.length, "bytes");
'
```

- [ ] **Step 7: Run the tests**

Run: `node --experimental-sqlite --test tests/auth-pages.test.mjs tests/auth-gateway.test.mjs`
Expected: PASS (all subtests).

- [ ] **Step 8: Commit**

```bash
git add deploy/railway/pages public/robots.txt public/sitemap.xml public/favicon.ico tests/auth-pages.test.mjs tests/auth-gateway.test.mjs
git commit -m "feat(public): remove pricing/beta copy, add robots, sitemap, favicon, noindex auth pages

Closes landing-auth-08 and architecture-18 from the 2026-09-10 audit.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 2: AuthStore — claimable unverified accounts, verified bootstrap create, cookie issue time

**Rationale:** security-M-01 (P2 — pre-verification squatting: `auth.mjs:127-143` refuses a repeat signup for an unverified address, so a squatter's password survives), landing-auth-M-02 (same root, UX side), landing-auth-M-03 (P3 — sessions slide only in the DB; the cookie needs an issue time to know when to re-issue), spec 3.1 bootstrap account. Verified: `deploy/railway/auth.mjs:58-81` schema, `:127-143` `createUser`, `:183-209` sessions.

**Files:**
- Modify: `deploy/railway/auth.mjs:58-81, 127-143, 183-209`
- Test: `tests/auth-store.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks depend on these exact shapes):
  - `createUser({ email, displayName, password })` → `{ userId: string, verifyToken: string, replaced: boolean }`; throws `AuthError("email-taken")` **only** when a *verified* account exists. For an *unverified* existing account it replaces `display_name`, `password_scrypt`, resets `created_at`, deletes that user's outstanding verify tokens, issues a fresh one, and returns `replaced: true`.
  - `createVerifiedUser({ email, displayName, password })` → `{ userId: string, created: boolean }`; when an account (verified or not) already exists returns `created: false` and changes nothing.
  - `sessionUser(raw)` → `{ id, email, displayName, cookieIssuedAt: number } | null` (slides `expires_at` as before).
  - `markCookieIssued(raw)` → `void`; sets `sessions.cookie_issued_at = now`.
  - `createSession(userId)` also sets `cookie_issued_at = now`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/auth-store.test.mjs`:

```js
test("re-signup of an UNVERIFIED email replaces name + hash and reissues the link", () => {
  const { store } = makeStore();
  const first = store.createUser({ email: "claim@e.co", displayName: "Squatter", password: "squatter-pass-1" });
  assert.equal(first.replaced, false);
  const second = store.createUser({ email: "Claim@E.co", displayName: "Owner", password: "owner-pass-123" });
  assert.equal(second.replaced, true);
  assert.equal(second.userId, first.userId, "same account row is kept");
  assert.notEqual(second.verifyToken, first.verifyToken);
  assert.equal(store.verifyEmail(first.verifyToken), null, "the squatter's link is dead");
  const verified = store.verifyEmail(second.verifyToken);
  assert.equal(verified.displayName, "Owner");
  assert.equal(store.authenticate("claim@e.co", "squatter-pass-1").ok, false, "old password gone");
  assert.equal(store.authenticate("claim@e.co", "owner-pass-123").ok, true);
});

test("re-signup of a VERIFIED email still throws email-taken", () => {
  const { store } = makeStore();
  const { verifyToken } = store.createUser({ email: "v@e.co", displayName: "V", password: "x".repeat(10) });
  store.verifyEmail(verifyToken);
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
  store.verifyEmail(verifyToken);
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
```

Add at the top of the file (after the existing imports) `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);` so the last test's `require` calls work in this ESM file.

- [ ] **Step 2: Run to see them fail**

Run: `node --experimental-sqlite --test tests/auth-store.test.mjs`
Expected: FAIL — `email-taken` thrown on re-signup; `createVerifiedUser is not a function`; `cookieIssuedAt` undefined.

- [ ] **Step 3: Implement in `deploy/railway/auth.mjs`**

Replace the `sessions` table in `SCHEMA` (lines 74-80) with:

```js
CREATE TABLE IF NOT EXISTS sessions (
  session_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  cookie_issued_at INTEGER NOT NULL DEFAULT 0
);
```

In the constructor (line 88, after `this.db.exec(SCHEMA);`) add:

```js
    this.#upgradeSchema();
```

and add this private method right after `close()`:

```js
  // Additive migrations for auth.db files created by earlier builds. Each
  // guard is idempotent so the constructor can run on every boot.
  #upgradeSchema() {
    const sessionColumns = this.db
      .prepare("PRAGMA table_info(sessions)")
      .all()
      .map((row) => row.name);
    if (!sessionColumns.includes("cookie_issued_at")) {
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN cookie_issued_at INTEGER NOT NULL DEFAULT 0",
      );
      this.db.exec("UPDATE sessions SET cookie_issued_at = created_at WHERE cookie_issued_at = 0");
    }
  }
```

Replace `createUser` (lines 127-143) with:

```js
  createUser({ email, displayName, password }) {
    const normalized = String(email).trim().toLowerCase();
    const existing = this.db
      .prepare("SELECT id, verified_at FROM users WHERE email = ?")
      .get(normalized);
    if (existing && existing.verified_at !== null) throw new AuthError("email-taken");
    if (existing) {
      // An unverified address is still claimable: whoever proves they own the
      // inbox wins, so the earlier name, hash and links are all replaced.
      this.db
        .prepare(
          "UPDATE users SET display_name = ?, password_scrypt = ?, created_at = ? WHERE id = ?",
        )
        .run(displayName ?? null, hashPassword(password), this.now(), existing.id);
      this.db
        .prepare("DELETE FROM tokens WHERE user_id = ? AND kind = 'verify'")
        .run(existing.id);
      return {
        userId: existing.id,
        verifyToken: this.#issueToken(existing.id, "verify", VERIFY_TTL_MS),
        replaced: true,
      };
    }
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
    return {
      userId,
      verifyToken: this.#issueToken(userId, "verify", VERIFY_TTL_MS),
      replaced: false,
    };
  }

  // Startup bootstrap: creates a VERIFIED account only when no row exists for
  // the address. Existing rows (verified or not) are never modified.
  createVerifiedUser({ email, displayName, password }) {
    const normalized = String(email).trim().toLowerCase();
    const existing = this.db.prepare("SELECT id FROM users WHERE email = ?").get(normalized);
    if (existing) return { userId: existing.id, created: false };
    const userId = `acct_${randomUUID()}`;
    const now = this.now();
    this.db
      .prepare(
        "INSERT INTO users (id, email, display_name, password_scrypt, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(userId, normalized, displayName ?? null, hashPassword(password), now, now);
    return { userId, created: true };
  }
```

Replace `createSession` and `sessionUser` (lines 183-209) with:

```js
  createSession(userId) {
    const raw = randomBytes(32).toString("base64url");
    const now = this.now();
    this.db
      .prepare(
        "INSERT INTO sessions (session_hash, user_id, created_at, expires_at, last_seen_at, cookie_issued_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(sha256Hex(raw), userId, now, now + SESSION_TTL_MS, now, now);
    return raw;
  }

  sessionUser(rawSessionId) {
    const hash = sha256Hex(String(rawSessionId ?? ""));
    const row = this.db
      .prepare("SELECT user_id, expires_at, cookie_issued_at FROM sessions WHERE session_hash = ?")
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
    const user = this.#userById(row.user_id);
    return user ? { ...user, cookieIssuedAt: Number(row.cookie_issued_at) } : null;
  }

  markCookieIssued(rawSessionId) {
    this.db
      .prepare("UPDATE sessions SET cookie_issued_at = ? WHERE session_hash = ?")
      .run(this.now(), sha256Hex(String(rawSessionId ?? "")));
  }
```

- [ ] **Step 4: Run the store tests**

Run: `node --experimental-sqlite --test tests/auth-store.test.mjs`
Expected: PASS. Then run `node --experimental-sqlite --test tests/auth-routes.test.mjs tests/auth-gateway.test.mjs` — expected: `signup maps duplicate…` in `auth-routes.test.mjs` now FAILS (`/signup?error=email-taken` no longer produced for an unverified duplicate). Edit that test now so the tree stays green: in `tests/auth-routes.test.mjs:117-129` change the duplicate expectation to

```js
  await post(routes, "/auth/signup", form({ email: "dup@e.co", name: "D", password: "longenough1" }));
  let { res } = await post(routes, "/auth/signup", form({ email: "dup@e.co", name: "D", password: "longenough1" }));
  assert.equal(res.headers.location, "/signup?sent=1", "unverified duplicate is re-sent, not refused");
```

(Task 7 rewrites this test again with the final `?sent=1&email=` shape.) Re-run both files: PASS.

- [ ] **Step 5: Commit**

```bash
git add deploy/railway/auth.mjs tests/auth-store.test.mjs tests/auth-routes.test.mjs
git commit -m "feat(auth): claimable unverified accounts, verified bootstrap create, cookie issue time

security-M-01, landing-auth-M-02, landing-auth-M-03 groundwork.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 3: Gateway core rewrite — session cookie only, path + Accept routing, public allowlist, `next`

**Rationale:** the audit's first theme ("one root cause reported ~20 ways"): ios-coupling-01/02/03/08/14, ios-coupling-M-01/M-02/M-03, landing-auth-03/07/12, landing-auth-M-04/M-06, infra-03/06/07/12, perf-09, architecture-M-04 (401 Basic on JSON fetches), app-ux-M-01, security-05, security-01 (widget bypass at `gateway.mjs:9,146-149`). Verified: `deploy/railway/gateway.mjs:9` (`WIDGET_FEED_PATH`), `:10-15` and `:56-93` (Basic cache + limiter + `basicIdentity`), `:126-216` (`handleRequest`: `/healthz`, blocklist, widget bypass `:146-149`, open identity `:153-156`, GET `/verify` consuming the token `:163-173`, UA gate `:190-210`, Basic challenge `:211-215`); `serve.mjs:17-29` (env docs), `:49-99` (`parseUsers`, `parseOpenIdentity`, fail-closed on users), `:240-249` (`createGateway` call), `:254-260` (listen log).

**Files:**
- Rewrite: `deploy/railway/gateway.mjs` (whole file)
- Modify: `deploy/railway/serve.mjs:1-31, 49-99, 201-203, 225, 240-249, 254-260`
- Modify: `deploy/railway/auth-routes.mjs` (add `safeNextPath`, `sessionForRequest`; export `readBody`)
- Modify: `Dockerfile:1-4` (comment)
- Rewrite: `tests/auth-gateway.test.mjs` (whole file)

**Interfaces:**
- Consumes: `AuthStore.sessionUser(raw)` → `{ id, email, displayName, cookieIssuedAt }` (Task 2).
- Produces:
  - `createGateway({ authRoutes, store, pagesDir, upstreamPort, now = () => Date.now() })` → `(req, res) => Promise<void>` (no `users`, no `openIdentity`).
  - From `auth-routes.mjs`: `export function safeNextPath(value: unknown): string` (returns `/` unless `value` is a same-origin relative path: starts with exactly one `/`, no `\\`, no control characters, ≤ 2048 chars, and not an auth page: `/login`, `/signup`, `/reset`, `/verify`, `/auth/`); `sessionForRequest(req)` → `{ user, raw, cookie } | null` on the routes object; `export function readBody(req, maxBytes = 32 * 1024): Promise<string>`.
  - Gateway hook points used by Tasks 4 and 5: `applySecurityHeaders(res)` (Task 4 fills it), `proxy(req, res, target, identity, { publicAsset = false, extraHeaders = {} } = {})`, `servePage(req, res, name, { cacheControl })`.
  - `/verify` is a **static page** (`pages/verify.html`) served like `/login`; the token is consumed only by `POST /auth/verify` (Task 7). Until Task 7 lands, `/auth/verify` 404s; the end-to-end signup test in this task verifies through `store.verifyEmail` directly.

- [ ] **Step 1: Add the helpers to `deploy/railway/auth-routes.mjs`**

Change `function readBody(req)` (line 83) to an exported, parameterised version:

```js
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
```

Add after `clientIp` (after line 81):

```js
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
```

Inside `createAuthRoutes`, replace `userForRequest` (lines 145-151) with:

```js
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
```

and change the return (line 267) to `return { handle, userForRequest, sessionForRequest, issueSessionCookie };`

The gateway tests post forms with `Origin: http://gw.test` while the socket host is `127.0.0.1:<port>`, so the CSRF check must compare against the configured base URL rather than the `Host` header from now on. Add `const expectedOrigin = new URL(baseUrl).origin;` as the first line inside `createAuthRoutes` and replace the CSRF block (lines 171-187) with this interim version (Task 6 tightens it to reject a missing header):

```js
    const declared = req.headers.origin ?? req.headers.referer;
    if (declared) {
      try {
        if (new URL(declared).origin !== expectedOrigin) {
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
```.

- [ ] **Step 2: Write the new gateway test file**

Replace `tests/auth-gateway.test.mjs` entirely with:

```js
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStore } from "../deploy/railway/auth.mjs";
import { createAuthRoutes, SESSION_COOKIE, signValue } from "../deploy/railway/auth-routes.mjs";
import { createGateway } from "../deploy/railway/gateway.mjs";

const pagesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)), "..", "deploy", "railway", "pages",
);
export const BASE_URL = "http://gw.test";

export async function startStack({ upstreamHandler } = {}) {
  let lastUpstream = null;
  const upstream = http.createServer((req, res) => {
    lastUpstream = { url: req.url, method: req.method, headers: { ...req.headers } };
    if (upstreamHandler) return upstreamHandler(req, res);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("app-response");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

  const clock = { now: 1_800_000_000_000 };
  const now = () => clock.now;
  const store = new AuthStore(":memory:", { now });
  const sent = [];
  const authRoutes = createAuthRoutes({
    store,
    secret: "gw-secret",
    baseUrl: BASE_URL,
    now,
    sleep: async () => {},
    sendEmail: async (message) => { sent.push(message); return { ok: true }; },
  });
  const gateway = http.createServer(
    createGateway({ authRoutes, store, pagesDir, upstreamPort: upstream.address().port, now }),
  );
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${gateway.address().port}`;

  return {
    base, store, sent, clock,
    upstreamSeen: () => lastUpstream,
    close: async () => {
      await new Promise((resolve) => gateway.close(resolve));
      await new Promise((resolve) => upstream.close(resolve));
    },
  };
}

export const get = (base, pathname, headers = {}) =>
  fetch(`${base}${pathname}`, { headers, redirect: "manual" });
export const head = (base, pathname, headers = {}) =>
  fetch(`${base}${pathname}`, { method: "HEAD", headers, redirect: "manual" });
export const postForm = (base, pathname, fields, headers = {}) =>
  fetch(`${base}${pathname}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL, ...headers },
    body: new URLSearchParams(fields).toString(),
  });

// Creates a verified account and returns a Cookie header value for it.
export async function signedInCookie(stack, email = "user@e.co", password = "correct-pass-11") {
  const { userId } = stack.store.createVerifiedUser({ email, displayName: "User", password });
  const raw = stack.store.createSession(userId);
  return `${SESSION_COOKIE}=${signValue(raw, "gw-secret")}`;
}

const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const WKWEBVIEW_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

test("gateway routes by path and Accept, never by User-Agent", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const { base } = stack;

  await t.test("healthz open, internal paths blocked", async () => {
    assert.equal((await get(base, "/healthz")).status, 200);
    assert.equal((await get(base, "/internal/run-scheduled")).status, 404);
    assert.equal((await get(base, "/__scheduled")).status, 404);
    assert.equal((await get(base, "/cdn-cgi/x")).status, 404);
  });

  await t.test("GET / with an HTML Accept serves the landing page for every client", async () => {
    for (const headers of [
      { accept: "text/html" },
      { accept: "text/html", "user-agent": GOOGLEBOT_UA },
      { accept: "text/html", "user-agent": WKWEBVIEW_UA },
      { accept: "*/*" },
      {},
    ]) {
      const landing = await get(base, "/", headers);
      assert.equal(landing.status, 200, JSON.stringify(headers));
      assert.match(landing.headers.get("content-type"), /text\/html/);
      assert.match(await landing.text(), /Every credential\./);
      assert.equal(landing.headers.get("set-cookie"), null, "landing sets no cookie");
    }
  });

  await t.test("HEAD mirrors GET", async () => {
    const landing = await head(base, "/", { accept: "text/html" });
    assert.equal(landing.status, 200);
    assert.equal(await landing.text(), "");
    const deep = await head(base, "/credentials", { accept: "text/html" });
    assert.equal(deep.status, 303);
    const api = await head(base, "/api/workspace", { accept: "application/json" });
    assert.equal(api.status, 401);
  });

  await t.test("other HTML paths 303 to /login with a same-origin next", async () => {
    const deep = await get(base, "/credentials", { accept: "text/html" });
    assert.equal(deep.status, 303);
    assert.equal(deep.headers.get("location"), "/login?next=%2Fcredentials");
    const withQuery = await get(base, "/credentials/abc?tab=plan", { accept: "text/html", "user-agent": WKWEBVIEW_UA });
    assert.equal(withQuery.headers.get("location"), "/login?next=%2Fcredentials%2Fabc%3Ftab%3Dplan");
    const launch = await get(base, "/?delivery=push-7", { accept: "text/html" });
    assert.equal(launch.status, 303, "a push deep link on / is carried into next, not swallowed by the landing");
    assert.equal(launch.headers.get("location"), "/login?next=%2F%3Fdelivery%3Dpush-7");
    const utm = await get(base, "/?utm_source=x", { accept: "text/html" });
    assert.equal(utm.status, 200, "a marketing query on / still lands");
  });

  await t.test("/api/* and non-HTML requests get a JSON 401 with no WWW-Authenticate", async () => {
    for (const [pathname, headers] of [
      ["/api/workspace", { accept: "application/json" }],
      ["/api/workspace", { accept: "text/html" }],
      ["/api/export", {}],
      ["/credentials", { accept: "application/json" }],
    ]) {
      const response = await get(base, pathname, headers);
      assert.equal(response.status, 401, pathname);
      assert.match(response.headers.get("content-type"), /application\/json/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("www-authenticate"), null);
      assert.deepEqual(await response.json(), { error: "unauthenticated" });
    }
    const post = await fetch(`${base}/api/workspace`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(post.status, 401);
  });

  await t.test("Basic credentials are ignored, not accepted", async () => {
    const basic = `Basic ${Buffer.from("user@e.co:correct-pass-11").toString("base64")}`;
    const response = await get(base, "/api/workspace", { authorization: basic, accept: "application/json" });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), null);
  });

  await t.test("public allowlist proxies without auth", async () => {
    for (const pathname of [
      "/robots.txt", "/sitemap.xml", "/favicon.ico", "/manifest.webmanifest", "/icons/x.png",
      "/og.png", "/offline.html", "/sw.js", "/assets/app.js", "/_next/static/chunk.js", "/ocr/worker.min.js",
      "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png",
    ]) {
      const response = await get(base, pathname);
      assert.equal(response.status, 200, pathname);
      assert.equal(await response.text(), "app-response", pathname);
      assert.equal(stack.upstreamSeen().headers["oai-authenticated-user-email"], undefined, pathname);
      assert.equal(response.headers.get("cache-control"), "public, max-age=300", pathname);
    }
  });

  await t.test("auth pages are served as static HTML", async () => {
    for (const pathname of ["/signup", "/login", "/reset", "/verify?token=abc"]) {
      const page = await get(base, pathname, { accept: "text/html" });
      assert.equal(page.status, 200, pathname);
      assert.match(page.headers.get("content-type"), /text\/html/);
    }
  });

  await t.test("the widget feed no longer bypasses auth", async () => {
    const response = await get(base, "/api/widget-summary", { authorization: "Bearer widget-token" });
    assert.equal(response.status, 401);
  });

  await t.test("a session cookie proxies with identity headers; client oai headers are stripped", async () => {
    const cookie = await signedInCookie(stack);
    const response = await get(base, "/credentials", {
      accept: "text/html", cookie, "oai-authenticated-user-email": "forged@evil.example",
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "app-response");
    const seen = stack.upstreamSeen();
    assert.equal(seen.headers["oai-authenticated-user-email"], "user@e.co");
    assert.equal(seen.headers["oai-authenticated-user-full-name"], "User");
    assert.equal(seen.headers.authorization, undefined);
    assert.equal(seen.headers.cookie, cookie, "the session cookie still reaches the worker unchanged");
  });

  await t.test("signup -> verify -> session cookie -> app", async () => {
    const signup = await postForm(base, "/auth/signup", { email: "db@e.co", name: "DB User", password: "longenough1" });
    assert.equal(signup.status, 303);
    const token = stack.sent[0].text.match(/token=([A-Za-z0-9_-]+)/)[1];
    const verifyPage = await get(base, `/verify?token=${token}`, { accept: "text/html" });
    assert.equal(verifyPage.status, 200, "GET /verify renders a page and consumes nothing");
    assert.equal(verifyPage.headers.get("set-cookie"), null);
    assert.ok(stack.store.verifyEmail(token), "token is still valid after the GET");
    const login = await postForm(base, "/auth/login", { email: "db@e.co", password: "longenough1" });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
    const app = await get(base, "/", { accept: "text/html", cookie });
    assert.equal(app.status, 200);
    assert.equal(await app.text(), "app-response");
    assert.equal(stack.upstreamSeen().headers["oai-authenticated-user-email"], "db@e.co");
  });
});

test("a throwing store cannot crash the gateway (exception barrier)", async (t) => {
  const stubStore = {
    sessionUser() { throw new Error("boom"); },
  };
  const authRoutes = createAuthRoutes({
    store: stubStore, secret: "gw-secret", baseUrl: BASE_URL, sendEmail: async () => ({ ok: true }),
  });
  const gateway = http.createServer(
    createGateway({ authRoutes, store: stubStore, pagesDir, upstreamPort: 1 }),
  );
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const base = `http://127.0.0.1:${gateway.address().port}`;
  // A correctly signed cookie so the gateway actually reaches the throwing store.
  const app = await get(base, "/credentials", { accept: "text/html", cookie: `${SESSION_COOKIE}=${signValue("x", "gw-secret")}` });
  assert.equal(app.status, 500, "a throwing route responds 500 instead of crashing");
  const health = await get(base, "/healthz");
  assert.equal(health.status, 200, "the server survives the thrown error");
});
```

- [ ] **Step 3: Run to see it fail**

Run: `node --experimental-sqlite --test tests/auth-gateway.test.mjs`
Expected: FAIL — WKWebView UA gets 401; `/credentials` redirects to `/login` without `next`; `www-authenticate` present; allowlist paths 303.

- [ ] **Step 4: Write the new `deploy/railway/gateway.mjs`**

Replace the whole file with:

```js
// Request routing for the Railway gateway, extracted from serve.mjs so it can
// be tested against a stub upstream without spawning wrangler.
//
// One credential: the signed `itrack_session` cookie. Routing decisions use
// the request path and the Accept header only — never the User-Agent.
import http from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import { safeNextPath } from "./auth-routes.mjs";

const PAGE_ROUTES = new Map([
  ["/signup", "signup.html"],
  ["/login", "login.html"],
  ["/reset", "reset.html"],
  ["/verify", "verify.html"],
]);
// Served without a session, with caching. Everything here is either a static
// file the build copies into dist/client or a worker route that reads no
// identity (the manifest).
const PUBLIC_EXACT = new Set([
  "/robots.txt",
  "/sitemap.xml",
  "/favicon.ico",
  "/manifest.webmanifest",
  "/og.png",
  "/offline.html",
  "/sw.js",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
]);
const PUBLIC_PREFIXES = ["/icons/", "/assets/", "/_next/static/", "/ocr/"];
const PUBLIC_CACHE_CONTROL = "public, max-age=300";
// Query keys the service worker's notificationclick opens `/` with. A bare
// `/` is the landing page; `/` carrying one of these is an app deep link and
// must round-trip through /login?next= instead of being swallowed.
const LAUNCH_PARAMETERS = ["delivery", "view"];

export function isPublicPath(pathname) {
  return PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function wantsHtml(req) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const accept = req.headers.accept;
  if (accept === undefined || accept === "") return true;
  return accept.includes("text/html") || accept.includes("*/*");
}

export function applySecurityHeaders(res) {
  // Filled in by Task 4 (security header set from spec 3.1).
}

export function createGateway({ authRoutes, store, pagesDir, upstreamPort, now = () => Date.now() }) {
  const pageCache = new Map();
  function loadPage(name) {
    if (!pageCache.has(name)) {
      pageCache.set(name, { raw: readFileSync(path.join(pagesDir, name)) });
    }
    return pageCache.get(name);
  }

  function servePage(req, res, name, { cacheControl = PUBLIC_CACHE_CONTROL, status = 200 } = {}) {
    const page = loadPage(name);
    const body = page.raw;
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": cacheControl,
      "content-length": body.length,
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  function sendJson(req, res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  function proxy(req, res, target, identity, { publicAsset = false, extraHeaders = {} } = {}) {
    const headers = { ...req.headers };
    for (const name of Object.keys(headers)) {
      if (name.startsWith("oai-")) delete headers[name];
    }
    delete headers.connection;
    delete headers.authorization;
    if (identity) {
      headers["oai-authenticated-user-email"] = identity.email;
      if (identity.displayName) {
        headers["oai-authenticated-user-full-name"] = encodeURIComponent(identity.displayName);
        headers["oai-authenticated-user-full-name-encoding"] = "percent-encoded-utf-8";
      }
    }
    const upstream = http.request(
      { host: "127.0.0.1", port: upstreamPort, method: req.method, path: target, headers },
      (workerResponse) => {
        const responseHeaders = { ...workerResponse.headers, ...extraHeaders };
        if (publicAsset && !responseHeaders["cache-control"]) {
          responseHeaders["cache-control"] = PUBLIC_CACHE_CONTROL;
        }
        res.writeHead(workerResponse.statusCode ?? 502, responseHeaders);
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

  async function handleRequest(req, res) {
    applySecurityHeaders(res);
    const rawTarget = req.url ?? "/";
    const url = new URL(rawTarget, "http://placeholder");
    const pathname = url.pathname;
    const target = pathname + url.search;

    if (pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : "ok");
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

    if (pathname.startsWith("/auth/")) {
      await authRoutes.handle(req, res, pathname);
      return;
    }

    if ((req.method === "GET" || req.method === "HEAD") && PAGE_ROUTES.has(pathname)) {
      // The verify page is reached from a secret URL; keep it out of caches.
      servePage(req, res, PAGE_ROUTES.get(pathname), {
        cacheControl: pathname === "/verify" ? "no-store" : PUBLIC_CACHE_CONTROL,
      });
      return;
    }

    if (isPublicPath(pathname)) {
      proxy(req, res, target, null, { publicAsset: true });
      return;
    }

    const session = authRoutes.sessionForRequest(req);
    if (session) {
      const identity = { email: session.user.email, displayName: session.user.displayName };
      proxy(req, res, target, identity);
      return;
    }

    if (wantsHtml(req) && !pathname.startsWith("/api/")) {
      const isLaunchLink = LAUNCH_PARAMETERS.some((key) => url.searchParams.has(key));
      if (pathname === "/" && !isLaunchLink) {
        servePage(req, res, "landing.html");
        return;
      }
      const next = safeNextPath(target);
      res.writeHead(303, {
        location: `/login?next=${encodeURIComponent(next)}`,
        "cache-control": "no-store",
      });
      res.end();
      return;
    }
    sendJson(req, res, 401, { error: "unauthenticated" });
  }

  // Exception barrier: a throwing route (bad token, unreadable page file,
  // store error) must produce a 500, never an unhandled rejection that takes
  // down the supervisor process.
  return async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (error) {
      console.error("gateway error", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
      }
      if (!res.writableEnded) {
        res.end("Internal error");
      }
    }
  };
}
```

(`now` is accepted now and used by Task 5's sliding cookie; `servePage`/`loadPage` are reshaped by Task 4's compression.)

- [ ] **Step 5: Update `deploy/railway/serve.mjs`**

Replace lines 1-31 (header comment) with:

```js
// Railway entrypoint for iTrack.
//
// The app is built for Cloudflare Workers, so this process supervises
// wrangler's local runtime (workerd) serving the production build with
// file-backed D1/R2 state, and fronts it with the auth gateway (gateway.mjs)
// that turns a signed session cookie into the trusted
// `oai-authenticated-user-*` identity headers the worker expects. It also
// fires the */15 cron trigger that delivers scheduled push reminders.
//
// Configuration (environment):
//   PORT                 public listen port (Railway sets this)
//   PERSIST_DIR          durable state directory (default /data/wrangler-state);
//                        mount a Railway volume at /data or all data is lost
//   AUTH_SESSION_SECRET  optional; otherwise generated once and persisted in
//                        /data/auth-session-secret
//   AUTH_DB_PATH         optional; default /data/auth.db
//   AUTH_BOOTSTRAP_USERS "email:password[;email:password]" — creates VERIFIED
//                        accounts at startup for addresses with no account;
//                        existing accounts are never touched (see bootstrap.mjs)
//   PUBLIC_BASE_URL      canonical origin, e.g. https://itrackceu.com; the
//                        CSRF check and email links use it
//   RESEND_API_KEY, AUTH_EMAIL_FROM   transactional email
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT   web push
//
// Fail-closed at startup: a session secret must exist and the auth database
// must open; otherwise the process exits 1 before listening.
```

Delete lines 49-99 (`parseUsers`, `parseOpenIdentity`, `OPEN_IDENTITY`, `USERS`, the fail-closed block) entirely.

Replace lines 201-203 (the comment above `HERE`) with:

```js
// Request handling (session auth, public pages, allowlist, proxying) lives in
// gateway.mjs so it can be tested against a stub upstream without spawning
// wrangler.
```

Replace line 225 (`const store = new AuthStore(...)`) with:

```js
let store;
try {
  store = new AuthStore(process.env.AUTH_DB_PATH ?? path.join(STATE_ROOT, "auth.db"));
} catch (error) {
  console.error("Refusing to start: the auth database could not be opened", error);
  process.exit(1);
}
```

Replace lines 240-249 (`http.createServer(createGateway({...}))`) with:

```js
const server = http.createServer(
  createGateway({
    authRoutes,
    store,
    pagesDir: path.join(HERE, "pages"),
    upstreamPort: WORKER_PORT,
  }),
);
```

Replace lines 254-260 (listen callback) with:

```js
server.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(
    `iTrack gateway listening on :${PUBLIC_PORT} (session-cookie auth, self-serve signup enabled), state in ${PERSIST_DIR}`,
  );
});
```

Note: `store` is referenced by `fireCron()` (line 194) which is defined before line 225 but only *called* after — fine as `let store` is hoisted at module scope. Move the `let store` declaration block **above** `fireCron` if `node --check deploy/railway/serve.mjs` complains about TDZ (it will not: `fireCron` runs after `await waitForWorker()`).

In `Dockerfile` lines 1-4 change the comment to:

```dockerfile
# Railway container for iTrack.
# The app targets Cloudflare Workers; this image runs the production build
# under wrangler's local workerd runtime behind the session-cookie auth
# gateway (deploy/railway/serve.mjs). Mount a volume at /data for durable
# D1/R2 state and the auth database.
```

- [ ] **Step 6: Run the gateway and route tests**

Run: `node --experimental-sqlite --test tests/auth-gateway.test.mjs tests/auth-routes.test.mjs tests/auth-store.test.mjs`
Expected: `auth-gateway` PASS. `auth-routes` FAILS on the CSRF expectation? No — `fakeReq` already sends an `origin`; it passes. If `origin mismatch is rejected` still passes, good. Note `createAuthRoutes` ignores the unknown `sleep` option until Task 6.

Also run: `node --check deploy/railway/serve.mjs && grep -n -i "user-agent\|basic\|ITRACK_USERS\|OPEN_IDENTITY\|widget" deploy/railway/gateway.mjs deploy/railway/serve.mjs`
Expected: `--check` silent; grep prints only the `ITRACK_WIDGET_TOKEN` line in `serve.mjs`'s `workerVarArgs` (removed in Task 9) and nothing from `gateway.mjs`.

- [ ] **Step 7: Lint and commit**

Run: `npm run lint` → PASS.

```bash
git add deploy/railway/gateway.mjs deploy/railway/serve.mjs deploy/railway/auth-routes.mjs Dockerfile tests/auth-gateway.test.mjs
git commit -m "feat(gateway): session cookie is the only credential; route by path + Accept

Deletes HTTP Basic, the User-Agent gate, ITRACK_USERS/VIGILO_USERS/LANTERN_USERS,
ITRACK_OPEN_IDENTITY, the Basic cache + limiter and the widget-feed bypass.
Unauthenticated HTML -> landing (bare /) or 303 /login?next=; /api and
non-HTML -> 401 JSON without WWW-Authenticate; HEAD mirrors GET; public
allowlist served without auth. Closes ios-coupling-01/02/03/08, security-01
(bypass), security-05, architecture-M-04, landing-auth-03/07, ios-coupling-M-03.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 4: Request-target normalisation, security headers, compressed + cached public pages

**Rationale:** critic-07 (P3 — gateway classifies a parsed pathname but proxies the raw target; `//login` and `//internal/run-scheduled` reach different classifications; verified `gateway.mjs:127-128` parse and `:110` `path: req.url` in the old file — the Task 3 rewrite already proxies `pathname + search`, this task adds the reject + collapse), infra-06/07 (no HSTS or security headers), perf-09 (uncompressed, uncacheable public pages). Spec 3.1 lists the exact header set and `Cache-Control: public, max-age=300` with gzip/brotli.

**Files:**
- Modify: `deploy/railway/gateway.mjs` (`applySecurityHeaders`, `loadPage`/`servePage`, top of `handleRequest`)
- Test: `tests/auth-gateway.test.mjs` (append one `test(...)` block)

**Interfaces:**
- Consumes: Task 3 gateway.
- Produces: `applySecurityHeaders(res)` sets the six spec headers; `proxy` re-applies them over upstream headers so ours win; `servePage` negotiates `br` / `gzip` / identity from `Accept-Encoding`, sends `Vary: Accept-Encoding`, `Content-Length`; request targets not starting with exactly one `/` get `400 {"error":"bad_request_target"}`; repeated slashes inside the path collapse before routing and proxying.

- [ ] **Step 1: Append the failing tests**

Append to `tests/auth-gateway.test.mjs`:

```js
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(self), microphone=(), geolocation=()",
  "x-frame-options": "DENY",
  "content-security-policy-report-only":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; frame-ancestors 'none'",
};

test("request-target normalisation, security headers, compression and caching", async (t) => {
  const stack = await startStack({
    upstreamHandler: (req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "x-frame-options": "SAMEORIGIN" });
      res.end(`upstream saw ${req.url}`);
    },
  });
  t.after(() => stack.close());
  const { base } = stack;

  await t.test("targets that do not start with exactly one slash are rejected", async () => {
    for (const target of ["//login", "//internal/run-scheduled", "//xmlrpc.php"]) {
      const response = await fetch(`${base}${target}`, { headers: { accept: "text/html" }, redirect: "manual" });
      assert.equal(response.status, 400, target);
      assert.deepEqual(await response.json(), { error: "bad_request_target" });
    }
  });

  await t.test("repeated slashes inside the path collapse before routing and proxying", async () => {
    const blocked = await get(base, "/internal//run-scheduled");
    assert.equal(blocked.status, 404);
    const cookie = await signedInCookie(stack);
    const proxied = await get(base, "/credentials//abc?x=1", { cookie, accept: "text/html" });
    assert.equal(proxied.status, 200);
    assert.equal(await proxied.text(), "upstream saw /credentials/abc?x=1");
    assert.equal(stack.upstreamSeen().url, "/credentials/abc?x=1");
  });

  await t.test("every response carries the security header set, including proxied ones", async () => {
    const cookie = await signedInCookie(stack, "hdr@e.co");
    const responses = [
      await get(base, "/", { accept: "text/html" }),
      await get(base, "/credentials", { accept: "text/html" }),
      await get(base, "/api/workspace", { accept: "application/json" }),
      await get(base, "/healthz"),
      await get(base, "/robots.txt"),
      await get(base, "/credentials", { accept: "text/html", cookie }),
      await get(base, "//bad"),
    ];
    for (const response of responses) {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        assert.equal(response.headers.get(name), value, `${name} on ${response.url} (${response.status})`);
      }
    }
    assert.equal(responses[5].headers.get("x-frame-options"), "DENY", "gateway header wins over upstream SAMEORIGIN");
  });

  await t.test("public pages are compressed on request and cached for five minutes", async () => {
    const plain = await get(base, "/", { accept: "text/html" });
    assert.equal(plain.headers.get("content-encoding"), null);
    assert.equal(plain.headers.get("cache-control"), "public, max-age=300");
    assert.equal(plain.headers.get("vary"), "accept-encoding");
    const rawLength = Number(plain.headers.get("content-length"));
    assert.ok(rawLength > 1000);

    const gz = await fetch(`${base}/`, { headers: { accept: "text/html", "accept-encoding": "gzip" } });
    assert.equal(gz.headers.get("content-encoding"), "gzip");
    // Node's fetch transparently decodes; check the wire bytes via a raw socket-free route: content-length differs.
    assert.ok(Number(gz.headers.get("content-length")) < rawLength, "gzip body is smaller");
    assert.match(await gz.text(), /Every credential\./);

    const br = await fetch(`${base}/`, { headers: { accept: "text/html", "accept-encoding": "br, gzip" } });
    assert.equal(br.headers.get("content-encoding"), "br", "brotli preferred when offered");
    assert.match(await br.text(), /Every credential\./);

    const login = await get(base, "/login", { accept: "text/html" });
    assert.equal(login.headers.get("cache-control"), "public, max-age=300");
    const verify = await get(base, "/verify?token=x", { accept: "text/html" });
    assert.equal(verify.headers.get("cache-control"), "no-store", "the token-bearing page is never cached");
  });

  await t.test("HEAD on a compressed page sends headers only", async () => {
    const response = await fetch(`${base}/`, { method: "HEAD", headers: { accept: "text/html", "accept-encoding": "gzip" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-encoding"), "gzip");
    assert.equal(await response.text(), "");
  });
});
```

(`brotliDecompressSync`/`gunzipSync` are imported for use in a follow-up assertion if Node's fetch ever stops auto-decoding; ESLint's `no-unused-vars` is not enabled for `.mjs` in this repo's config — if `npm run lint` flags them, delete the import line.)

- [ ] **Step 2: Run to see it fail**

Run: `node --experimental-sqlite --test tests/auth-gateway.test.mjs`
Expected: FAIL — `//login` returns 200 landing; no `strict-transport-security`; no `content-encoding`.

- [ ] **Step 3: Implement in `deploy/railway/gateway.mjs`**

Add to the imports: `import { brotliCompressSync, gzipSync, constants as zlib } from "node:zlib";`

Replace the `applySecurityHeaders` stub with:

```js
// Spec 3.1 header set. Applied before routing so every branch — pages, JSON
// errors, redirects, proxied worker responses — carries it. CSP is
// report-only in Wave 1; Wave 5 enforces it once the redesign settles its
// font and script needs.
export const SECURITY_HEADERS = Object.freeze({
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(self), microphone=(), geolocation=()",
  "x-frame-options": "DENY",
  "content-security-policy-report-only":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; frame-ancestors 'none'",
});

export function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}
```

Replace `loadPage` and `servePage` with:

```js
  function loadPage(name) {
    if (!pageCache.has(name)) {
      const raw = readFileSync(path.join(pagesDir, name));
      pageCache.set(name, {
        raw,
        gzip: gzipSync(raw, { level: 9 }),
        br: brotliCompressSync(raw, {
          params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: raw.length },
        }),
      });
    }
    return pageCache.get(name);
  }

  function chooseEncoding(req) {
    const offered = String(req.headers["accept-encoding"] ?? "");
    if (/\bbr\b/.test(offered)) return "br";
    if (/\bgzip\b/.test(offered)) return "gzip";
    return null;
  }

  function servePage(req, res, name, { cacheControl = PUBLIC_CACHE_CONTROL, status = 200 } = {}) {
    const page = loadPage(name);
    const encoding = chooseEncoding(req);
    const body = encoding ? page[encoding] : page.raw;
    const headers = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": cacheControl,
      vary: "accept-encoding",
      "content-length": body.length,
    };
    if (encoding) headers["content-encoding"] = encoding;
    res.writeHead(status, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  }
```

In `proxy`, change the response-header merge line to put the security headers last so they override upstream values:

```js
        const responseHeaders = { ...workerResponse.headers, ...extraHeaders, ...SECURITY_HEADERS };
```

Replace the first lines of `handleRequest` (from `applySecurityHeaders(res);` through `const target = …`) with:

```js
    applySecurityHeaders(res);
    const rawTarget = req.url ?? "/";
    // critic-07: a `//host/path` target parses as host + path and a `//x`
    // target classifies differently from `/x`. Reject anything that does not
    // start with exactly one slash, then collapse repeated slashes inside the
    // path so routing and proxying agree on one normalised target.
    if (!rawTarget.startsWith("/") || rawTarget.startsWith("//")) {
      sendJson(req, res, 400, { error: "bad_request_target" });
      return;
    }
    const url = new URL(rawTarget, "http://placeholder");
    const pathname = url.pathname.replace(/\/{2,}/g, "/");
    const target = pathname + url.search;
```

- [ ] **Step 4: Run the tests**

Run: `node --experimental-sqlite --test tests/auth-gateway.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add deploy/railway/gateway.mjs tests/auth-gateway.test.mjs
git commit -m "feat(gateway): reject // targets, collapse repeated slashes, security headers, compressed cached public pages

critic-07, infra-06, infra-07, perf-09.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 5: Sliding session cookie re-issue and the `/api/client-error` beacon endpoint

**Rationale:** landing-auth-M-03 (P3 — `auth-routes.mjs:106-108` fixed `Max-Age`, `:145-151` never sets a cookie, `gateway.mjs` proxy never adds `set-cookie`, so every daily user is hard-logged-out on day 30), critic-04 (P2 — no error telemetry anywhere; the beacon needs a server endpoint that logs one structured line, rate-limited 10/min per session — spec 3.2). The endpoint lives in the gateway: it already holds the session cookie, `RateLimiter`, and stdout, and it must accept beacons before the auth check (an error boundary can fire on an expired session).

**Files:**
- Modify: `deploy/railway/auth-routes.mjs` (add `COOKIE_REISSUE_AFTER_MS`, `slideSessionCookie`)
- Modify: `deploy/railway/gateway.mjs` (session branch; `/api/client-error`)
- Test: `tests/auth-gateway.test.mjs`, `tests/auth-routes.test.mjs`

**Interfaces:**
- Consumes: `store.sessionUser().cookieIssuedAt`, `store.markCookieIssued(raw)` (Task 2); `readBody(req, maxBytes)`, `RateLimiter`, `clientIp` (auth-routes).
- Produces: `authRoutes.slideSessionCookie(session, nowMs)` → `string | null` (a `Set-Cookie` header value re-issuing the *same* signed value with a fresh 30-day `Max-Age` when `nowMs - session.user.cookieIssuedAt >= COOKIE_REISSUE_AFTER_MS` (24 h), after calling `store.markCookieIssued`; `null` otherwise). `POST /api/client-error` accepts JSON `{ message, stack, route, userAgent, at }`, logs one line `{"event":"client_error", ...}` via `console.error`, answers `204`; `429 {"error":"rate_limited"}` past 10/min per session (keyed by a hash of the session id, else by client IP); `413` over 8 kB; `400` on non-JSON; `405` on non-POST. Task 12's client posts to it.

- [ ] **Step 1: Write the failing tests**

Append to `tests/auth-routes.test.mjs`:

```js
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
```

Append to `tests/auth-gateway.test.mjs`:

```js
test("authenticated requests re-issue the session cookie once it is a day old", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const { base, clock } = stack;
  const cookie = await signedInCookie(stack, "slide@e.co");
  const fresh = await get(base, "/credentials", { accept: "text/html", cookie });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get("set-cookie"), null);
  clock.now += 24 * 60 * 60 * 1000 + 1;
  const stale = await get(base, "/api/workspace", { accept: "application/json", cookie });
  assert.equal(stale.status, 200);
  const reissued = stale.headers.get("set-cookie");
  assert.ok(reissued, "cookie re-issued");
  assert.equal(reissued.split(";")[0], cookie);
  assert.match(reissued, /Max-Age=2592000/);
  const again = await get(base, "/api/workspace", { accept: "application/json", cookie });
  assert.equal(again.headers.get("set-cookie"), null, "only once per day");
});

test("POST /api/client-error logs one structured line and is rate limited per session", async (t) => {
  const stack = await startStack();
  t.after(() => stack.close());
  const { base } = stack;
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(" "));
  t.after(() => { console.error = original; });
  const cookie = await signedInCookie(stack, "beacon@e.co");
  const report = { message: "TypeError: x is null", stack: "at a\nat b", route: "/credentials/abc", userAgent: "UA", at: "2026-09-10T12:00:00.000Z" };
  const post = (body, headers = {}) => fetch(`${base}/api/client-error`, {
    method: "POST", headers: { "content-type": "application/json", cookie, ...headers }, body,
  });
  const ok = await post(JSON.stringify(report));            // slot 1 of 10
  assert.equal(ok.status, 204);
  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0]);
  assert.equal(logged.event, "client_error");
  assert.equal(logged.message, report.message);
  assert.equal(logged.route, "/credentials/abc");
  assert.equal(logged.session, true);
  assert.equal(logged.stack, "at a\nat b");
  assert.equal((await post("not json")).status, 400);        // slot 2 (limiter counts before parsing)
  assert.equal((await post(JSON.stringify({ ...report, stack: "x".repeat(9000) }))).status, 413); // slot 3
  assert.equal(lines.length, 1, "rejected beacons are not logged");
  for (let i = 0; i < 7; i += 1) assert.equal((await post(JSON.stringify(report))).status, 204); // slots 4-10
  const limited = await post(JSON.stringify(report));
  assert.equal(limited.status, 429);
  assert.equal(lines.length, 8, "the 11th beacon is dropped, not logged");
  const anonymous = await fetch(`${base}/api/client-error`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report),
  });
  assert.equal(anonymous.status, 204, "an unauthenticated beacon is accepted (keyed by IP)");
  assert.equal(JSON.parse(lines[8]).session, false);
  assert.equal((await get(base, "/api/client-error")).status, 405);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --experimental-sqlite --test tests/auth-routes.test.mjs tests/auth-gateway.test.mjs`
Expected: FAIL — `slideSessionCookie is not a function`; `/api/client-error` → 401.

- [ ] **Step 3: Implement in `deploy/railway/auth-routes.mjs`**

After `const SESSION_MAX_AGE_S = …` (line 6) add:

```js
export const COOKIE_REISSUE_AFTER_MS = 24 * 60 * 60 * 1000;
```

Inside `createAuthRoutes`, after `issueSessionCookie`, add:

```js
  // landing-auth-M-03: the DB row slides on every request but the browser
  // discards the cookie at its original Max-Age. Once a day, send the same
  // signed value again with a fresh 30-day Max-Age.
  function slideSessionCookie(session, nowMs = now()) {
    if (!session) return null;
    if (nowMs - session.user.cookieIssuedAt < COOKIE_REISSUE_AFTER_MS) return null;
    store.markCookieIssued(session.raw);
    return sessionCookieHeader(session.cookie);
  }
```

and add it to the returned object: `return { handle, userForRequest, sessionForRequest, issueSessionCookie, slideSessionCookie };`

- [ ] **Step 4: Implement in `deploy/railway/gateway.mjs`**

Imports: `import { RateLimiter, clientIp, readBody, safeNextPath } from "./auth-routes.mjs";` and `import { createHash } from "node:crypto";`

Inside `createGateway`, before `handleRequest`, add:

```js
  const CLIENT_ERROR_MAX_BYTES = 8 * 1024;
  const clientErrorLimiter = new RateLimiter(10, 60 * 1000, { now });

  function clip(value, max) {
    return typeof value === "string" ? value.slice(0, max) : "";
  }

  async function handleClientError(req, res) {
    if (req.method !== "POST") {
      sendJson(req, res, 405, { error: "method_not_allowed" });
      return;
    }
    const session = authRoutes.sessionForRequest(req);
    const key = session
      ? `beacon:s:${createHash("sha256").update(session.raw).digest("hex").slice(0, 16)}`
      : `beacon:ip:${clientIp(req)}`;
    if (!clientErrorLimiter.allow(key)) {
      sendJson(req, res, 429, { error: "rate_limited" });
      return;
    }
    // Check the declared size first: readBody() destroys the socket when the
    // stream overruns, which would swallow the 413. Browsers and fetch()
    // always send Content-Length for a string body.
    if (Number(req.headers["content-length"] ?? 0) > CLIENT_ERROR_MAX_BYTES) {
      sendJson(req, res, 413, { error: "too_large" });
      return;
    }
    let body;
    try {
      body = await readBody(req, CLIENT_ERROR_MAX_BYTES);
    } catch {
      sendJson(req, res, 413, { error: "too_large" });
      return;
    }
    let report;
    try {
      report = JSON.parse(body);
    } catch {
      sendJson(req, res, 400, { error: "invalid_json" });
      return;
    }
    if (typeof report !== "object" || report === null) {
      sendJson(req, res, 400, { error: "invalid_json" });
      return;
    }
    // One structured line; the stack is already capped client-side at 2 kB
    // and again here. Nothing from the body is interpolated into a template.
    console.error(JSON.stringify({
      event: "client_error",
      at: clip(report.at, 40) || new Date(now()).toISOString(),
      route: clip(report.route, 200),
      message: clip(report.message, 500),
      stack: clip(report.stack, 2048),
      userAgent: clip(report.userAgent, 300),
      session: Boolean(session),
    }));
    res.writeHead(204, { "cache-control": "no-store" });
    res.end();
  }
```

In `handleRequest`, immediately after the blocklist `404` branch and before the `/auth/` branch, add:

```js
    if (pathname === "/api/client-error") {
      await handleClientError(req, res);
      return;
    }
```

Replace the session branch with:

```js
    const session = authRoutes.sessionForRequest(req);
    if (session) {
      const identity = { email: session.user.email, displayName: session.user.displayName };
      const reissued = authRoutes.slideSessionCookie(session, now());
      proxy(req, res, target, identity, reissued ? { extraHeaders: { "set-cookie": reissued } } : {});
      return;
    }
```

- [ ] **Step 5: Run the tests**

Run: `node --experimental-sqlite --test tests/auth-routes.test.mjs tests/auth-gateway.test.mjs tests/auth-store.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add deploy/railway/auth-routes.mjs deploy/railway/gateway.mjs tests/auth-routes.test.mjs tests/auth-gateway.test.mjs
git commit -m "feat(gateway): re-issue the session cookie daily; add POST /api/client-error beacon endpoint

landing-auth-M-03, critic-04 (server side).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 6: Auth routes hardening — strict CSRF, per-account login limiter, `next`, name-free emails, no link logging

**Rationale:** security-07 (P3 — `auth-routes.mjs:171-187` allows `/auth/*` POSTs with neither Origin nor Referer), security-M-03 (P2 — `auth-routes.mjs:162-164` writes single-use verification/reset links to stdout on every mail failure, i.e. on 100 % of sends today), landing-auth-M-01 (P3 — `:118-127` and `:129-138` interpolate the display name as the first line of the email; the signup form becomes a phishing relay), security-04 (login says `unverified` vs `bad-credentials`; `:229`), ios-coupling-M-03 (`:231` always redirects to `/`), spec 3.1 rate limiting ("per-account limiter on login (10 failures / 15 min → generic error with a fixed 2-second delay)"), spec 3.1 email hardening (`mail_unconfigured` result).

**Files:**
- Modify: `deploy/railway/auth-routes.mjs:12-37, 118-138, 140-143, 158-166, 168-195, 226-232`
- Modify: `deploy/railway/email.mjs:5, 17, 22`
- Test: `tests/auth-routes.test.mjs`, `tests/auth-email.test.mjs`

**Interfaces:**
- Consumes: `safeNextPath` (Task 3).
- Produces:
  - `createAuthRoutes({ store, sendEmail, secret, baseUrl, now, sleep })` — new option `sleep(ms): Promise<void>` (default real `setTimeout`) used for the fixed 2 s delay so tests inject a stub.
  - `RateLimiter.check(key): boolean` — non-incrementing "would `allow` succeed" probe.
  - `sendEmail` results: `{ ok: true }` | `{ ok: false, error: "mail_unconfigured" }` | `{ ok: false, error: "send_failed" }`.
  - `deliver(kind, email, message)` logs only `{"event":"auth_mail_failed","kind":…,"error":…}` — never the link, never the address.
  - Login: failures (wrong password **or** unverified) → `303 /login?error=bad-credentials`; success → `303 <safeNextPath(fields.next)>`; when the per-account limiter is tripped: `await sleep(2000)` then `303 /login?error=bad-credentials` without touching scrypt.
  - Email builders: `verificationEmail(baseUrl, token)`, `resetEmail(baseUrl, token)` — no name parameter; greeting is `Hi,`.

- [ ] **Step 1: Update the tests**

In `tests/auth-routes.test.mjs` change `makeRoutes` to record sleeps and accept a `sleep` stub:

```js
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
```

Replace the `login flow: unverified, verified, wrong password, cookie, logout` test with:

```js
test("login flow: unverified and wrong password share one generic error; verified logs in; logout clears", async () => {
  const { store, routes, sent } = makeRoutes();
  await post(routes, "/auth/signup", form({ email: "l@e.co", name: "L", password: "longenough1" }));
  let { res } = await post(routes, "/auth/login", form({ email: "l@e.co", password: "longenough1" }));
  assert.equal(res.headers.location, "/login?error=bad-credentials", "unverified is not distinguishable");
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
```

In `tests/auth-email.test.mjs` change the three expected error codes: `email-not-configured` → `mail_unconfigured` (line 11), `send-failed` → `send_failed` (lines 43 and 49). In `tests/auth-routes.test.mjs:126` (the mail-down signup case) change only the error code, `{ ok: false, error: "email-not-configured" }` → `{ ok: false, error: "mail_unconfigured" }`; its expected location stays `"/signup?sent=1&mail=down"` until Task 7 rewrites that test.

- [ ] **Step 2: Run to see them fail**

Run: `node --experimental-sqlite --test tests/auth-routes.test.mjs tests/auth-email.test.mjs`
Expected: FAIL — `/login?error=unverified`; `next` ignored; no sleep; missing-Origin accepted; name in email; link logged; `check` undefined; email codes.

- [ ] **Step 3: Implement in `deploy/railway/email.mjs`**

```js
// Minimal Resend client. When unconfigured it reports `mail_unconfigured`
// so the caller can show the support address instead of pretending to send.
export function createResendSender({ apiKey, from, fetchImpl = fetch }) {
  return async ({ to, subject, html, text }) => {
    if (!apiKey || !from) return { ok: false, error: "mail_unconfigured" };
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
        return { ok: false, error: "send_failed" };
      }
      return { ok: true };
    } catch (error) {
      console.error("[email] resend request failed", error);
      return { ok: false, error: "send_failed" };
    }
  };
}
```

- [ ] **Step 4: Implement in `deploy/railway/auth-routes.mjs`**

Add to `RateLimiter` (after `allow`):

```js
  // Non-counting probe: would `allow(key)` succeed right now?
  check(key) {
    const now = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start >= this.windowMs) return true;
    return bucket.count < this.limit;
  }
```

Replace `verificationEmail` and `resetEmail` (lines 118-138) with:

```js
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
```

Delete `escapeHtml` (lines 112-116) — nothing user-supplied is rendered any more.

Change the signature and limiters (lines 140-143):

```js
const ACCOUNT_LOCK_DELAY_MS = 2000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createAuthRoutes({ store, sendEmail, secret, baseUrl, now = () => Date.now(), sleep = defaultSleep }) {
  const signupLimiter = new RateLimiter(5, 60 * 60 * 1000, { now });
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000, { now });
  const accountLimiter = new RateLimiter(10, 15 * 60 * 1000, { now });
  const resetLimiter = new RateLimiter(3, 60 * 60 * 1000, { now });
  const expectedOrigin = new URL(baseUrl).origin; // already present from Task 3; keep one copy
```

Replace `deliver` (lines 158-166):

```js
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
```

Replace the interim CSRF block from Task 3 (the `const declared = …; if (declared) { … }` block):

```js
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
```

Replace the login branch (lines 226-232):

```js
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
```

Update the three remaining callers of the email builders (signup `:222` and resend `:262`, request-reset `:245`) to the new two-argument form: `verificationEmail(baseUrl, created.verifyToken)`, `verificationEmail(baseUrl, reissued.token)`, `resetEmail(baseUrl, issued.token)`.

- [ ] **Step 5: Run the tests**

Run: `node --experimental-sqlite --test tests/auth-routes.test.mjs tests/auth-email.test.mjs tests/auth-gateway.test.mjs`
Expected: PASS (the gateway harness already sends `origin: BASE_URL`; the `signup maps duplicate…` mail-down assertion still expects `/signup?sent=1&mail=down` until Task 7).

- [ ] **Step 6: Commit**

```bash
git add deploy/railway/auth-routes.mjs deploy/railway/email.mjs tests/auth-routes.test.mjs tests/auth-email.test.mjs
git commit -m "feat(auth): strict CSRF, per-account login limiter, next redirect, name-free emails, no link logging

security-07, security-M-03, landing-auth-M-01, security-04, ios-coupling-M-03.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 7: Verification flow as one unit — POST confirm page, claimable re-signup, neutral copy, resend forms

**Rationale:** the audit's third theme: landing-auth-05 / security-03 (P2 — GET `/verify` consumes the token and mints a session; mail scanners burn the link; old `gateway.mjs:163-173`, already removed in Task 3 — this task adds the POST route), security-M-01 (squatting; store side done in Task 2 — this task makes signup use it), landing-auth-06 (P2 — the login page's resend form posts an empty hidden email; `login.html:72-78, 98-100`), landing-auth-M-05 (signup "sent" state has no resend; `signup.html:68, 87-90`), infra-M-02 / security-04 (`?error=email-taken` enumerates; `auth-routes.mjs:219`, `signup.html:70`), landing-auth-M-02 (resend shares the reset limiter, `auth-routes.mjs:259`).

**Files:**
- Modify: `deploy/railway/auth-routes.mjs` (signup, resend, new `verify` route)
- Rewrite: `deploy/railway/pages/verify.html` (body + script)
- Modify: `deploy/railway/pages/signup.html:68-72, 85-94`, `login.html:68-78, 79-85, 90-101`, `reset.html:69`
- Test: `tests/auth-routes.test.mjs`, `tests/auth-pages.test.mjs`, `tests/auth-gateway.test.mjs`

**Interfaces:**
- Consumes: `store.createUser` with `replaced` (Task 2), `store.verifyEmail`, `store.newVerifyToken`, `issueSessionCookie`, `deliver` (Task 6), `safeNextPath`.
- Produces:
  - `POST /auth/signup` → always `303 /signup?sent=1&email=<enc>` on success; `…&mail=unconfigured&email=` or `…&mail=failed&email=` when delivery fails; a *verified* duplicate → `303 /signup?sent=1&email=<enc>` with no mail sent (enumeration-neutral); `?error=invalid` / `?error=rate-limited` unchanged.
  - `POST /auth/verify` with `token` → success: session cookie + `303 /`; failure: `303 /verify?error=expired`.
  - `POST /auth/resend` with `email` (+ optional `return=signup`) → `303 /login?sent=1` (or `303 /signup?sent=1&email=<enc>` when `return=signup`); own limiter `resend:<ip>` 3/hour → `?error=rate-limited` on the same page.
  - `POST /auth/request-reset` → `303 /reset?sent=1` (unchanged) and `reset.html` shows the neutral copy.
  - Pages: `verify.html` shows a confirm form (`<form action="/auth/verify" method="post">` + hidden `token` + button "Confirm my email") when `?token=` is present and no `error`, else a problem view with a resend form; `login.html` has hidden `next` and a separate resend form with its own visible email input; `signup.html`'s sent state shows the address and a resend form.

- [ ] **Step 1: Update the tests**

In `tests/auth-routes.test.mjs` replace `signup maps duplicate, invalid, and mail-down outcomes` with:

```js
test("signup is enumeration-neutral: unverified duplicate re-sends, verified duplicate says sent silently", async () => {
  const { store, routes, sent } = makeRoutes();
  let { res } = await post(routes, "/auth/signup", form({ email: "dup@e.co", name: "D", password: "longenough1" }));
  assert.equal(res.headers.location, "/signup?sent=1&email=dup%40e.co");
  ({ res } = await post(routes, "/auth/signup", form({ email: "dup@e.co", name: "D2", password: "another-pass1" })));
  assert.equal(res.headers.location, "/signup?sent=1&email=dup%40e.co");
  assert.equal(sent.length, 2, "unverified duplicate gets a fresh link");
  store.verifyEmail(sent[1].text.match(/token=([A-Za-z0-9_-]+)/)[1]);
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

test("verify is a POST: consumes the token, signs in, and fails closed", async () => {
  const { routes, sent } = makeRoutes();
  await post(routes, "/auth/signup", form({ email: "v@e.co", name: "V", password: "longenough1" }));
  const token = sent[0].text.match(/token=([A-Za-z0-9_-]+)/)[1];
  let { res } = await post(routes, "/auth/verify", form({ token: "bogus" }));
  assert.equal(res.headers.location, "/verify?error=expired");
  assert.equal(res.headers["set-cookie"], undefined);
  ({ res } = await post(routes, "/auth/verify", form({ token })));
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, "/");
  assert.match(res.headers["set-cookie"], new RegExp(`^${SESSION_COOKIE}=`));
  ({ res } = await post(routes, "/auth/verify", form({ token })));
  assert.equal(res.headers.location, "/verify?error=expired", "single use");
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
```

Replace `tests/auth-pages.test.mjs` tests `login form posts credentials and links to reset + resend` and `verify page links back into the app and to login` with:

```js
test("login page: next field, generic error, and a resend form with its own email input", () => {
  const html = page("login.html");
  assert.match(html, /action="\/auth\/login"/);
  assert.match(html, /name="email"/);
  assert.match(html, /name="password"/);
  assert.match(html, /<input type="hidden" name="next" id="next">/);
  assert.match(html, /href="\/reset"/);
  assert.doesNotMatch(html, /flash-unverified/, "no unverified-specific state");
  assert.match(html, /id="flash-sent">If that address can be used, we've sent an email to it\./);
  const resendForm = html.match(/<form action="\/auth\/resend" method="post"[\s\S]*?<\/form>/);
  assert.ok(resendForm, "resend form present");
  assert.match(resendForm[0], /<input id="resend-email" name="email" type="email" required/, "resend has its own visible email input");
  assert.doesNotMatch(resendForm[0], /type="hidden" name="email"/);
});

test("verify page: POST confirm form and a problem view with resend", () => {
  const html = page("verify.html");
  assert.match(html, /<form action="\/auth\/verify" method="post"/);
  assert.match(html, /<input type="hidden" name="token" id="token">/);
  assert.match(html, />Confirm my email</);
  assert.match(html, /If you already confirmed, just log in\./);
  assert.match(html, /action="\/auth\/resend"/);
  assert.match(html, /href="\/login"/);
});

test("signup sent state names the address, shows neutral copy, and offers resend", () => {
  const html = page("signup.html");
  assert.match(html, /id="flash-sent">If that address can be used, we've sent an email to it\./);
  assert.match(html, /id="flash-mail-unconfigured">Email delivery is not set up yet; contact support@itrackceu\.com/);
  assert.doesNotMatch(html, /email-taken|already has an account/i);
  assert.match(html, /<form action="\/auth\/resend" method="post" id="resend-form"/);
  assert.match(html, /<input type="hidden" name="return" value="signup">/);
});

test("reset page uses the neutral sent copy", () => {
  assert.match(page("reset.html"), /id="flash-sent">If that address can be used, we've sent an email to it\./);
});
```

In `tests/auth-gateway.test.mjs`, in the `signup -> verify -> session cookie -> app` subtest, replace the lines from `assert.ok(stack.store.verifyEmail(token), …)` through the `login` POST with the real POST confirm:

```js
    const confirm = await postForm(base, "/auth/verify", { token });
    assert.equal(confirm.status, 303);
    assert.equal(confirm.headers.get("location"), "/");
    const cookie = confirm.headers.get("set-cookie").split(";")[0];
```

(keep the following `assert.match(cookie, …)` and app-fetch lines).

- [ ] **Step 2: Run to see them fail**

Run: `node --experimental-sqlite --test tests/auth-routes.test.mjs tests/auth-pages.test.mjs tests/auth-gateway.test.mjs`
Expected: FAIL — `/auth/verify` 404; signup location shapes; page markup.

- [ ] **Step 3: Implement the routes in `deploy/railway/auth-routes.mjs`**

Add `"verify"` to `known` and a resend limiter next to the others: `const resendLimiter = new RateLimiter(3, 60 * 60 * 1000, { now });`

Replace the signup branch:

```js
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
```

Add the verify branch after the login branch:

```js
    if (route === "verify") {
      // security-03 / landing-auth-05: the token is consumed here, on an
      // explicit POST from the confirm page, never on the GET a mail scanner
      // makes.
      const verified = store.verifyEmail(fields.get("token") ?? "");
      if (!verified) return redirect(res, "/verify?error=expired"), true;
      issueSessionCookie(res, verified.userId);
      return redirect(res, "/"), true;
    }
```

Replace the resend tail (the `// resend` block):

```js
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
```

- [ ] **Step 4: Rewrite `deploy/railway/pages/verify.html` body and script**

Keep the `<head>` (with the noindex meta from Task 1 and the shared `<style>`), and replace everything from `<body>` to `</html>` with:

```html
<body>
<div class="shell">
  <nav class="topbar">
    <a class="brand" href="/">i<span>Track</span></a>
  </nav>
  <main class="card">
    <div id="confirm-view" style="display:none">
      <h1>Confirm your email</h1>
      <p class="sub">One more step: confirm that this address is yours and you'll be signed in.</p>
      <form action="/auth/verify" method="post">
        <input type="hidden" name="token" id="token">
        <button class="btn btn-primary" type="submit">Confirm my email</button>
      </form>
    </div>
    <div id="problem-view" style="display:none">
      <h1>That link didn't work</h1>
      <div class="flash error" id="flash-expired" style="display:block">
        This verification link is invalid, already used, or expired. If you already confirmed, just log in.
      </div>
      <div class="flash ok" id="flash-sent">If that address can be used, we've sent an email to it.</div>
      <div class="flash error" id="flash-rate-limited">Too many requests. Try again in an hour.</div>
      <p class="sub">Need a new link? Enter your email and we'll send one if the account still needs verification.</p>
      <form action="/auth/resend" method="post">
        <label for="resend-email">Email</label>
        <input id="resend-email" name="email" type="email" required autocomplete="email">
        <button class="btn btn-primary" type="submit">Send a new link</button>
      </form>
      <p class="note"><a href="/login">Go to login</a></p>
    </div>
  </main>
</div>
<script>
  const params = new URLSearchParams(location.search);
  const token = params.get("token");
  const error = params.get("error");
  if (token && !error) {
    document.getElementById("token").value = token;
    document.getElementById("confirm-view").style.display = "block";
  } else {
    document.getElementById("problem-view").style.display = "block";
  }
</script>
</body>
</html>
```

- [ ] **Step 5: Edit `deploy/railway/pages/login.html`**

Replace lines 68-78 (the five flashes including the nested resend form) with:

```html
    <div class="flash ok" id="flash-reset">Password updated — log in with your new password.</div>
    <div class="flash ok" id="flash-sent">If that address can be used, we've sent an email to it.</div>
    <div class="flash error" id="flash-bad-credentials">We couldn't sign you in with that email and password. If you just signed up, confirm your email first — you can request a new link below.</div>
    <div class="flash error" id="flash-rate-limited">Too many attempts. Wait a few minutes and try again.</div>
```

In the login form (lines 79-85) add the hidden field as the first child of `<form action="/auth/login" method="post">`:

```html
      <input type="hidden" name="next" id="next">
```

After the login form's closing `</form>` and before `<p class="note"><a href="/reset">…`, add:

```html
    <details class="resend">
      <summary>Need a new verification link?</summary>
      <form action="/auth/resend" method="post">
        <label for="resend-email">Email</label>
        <input id="resend-email" name="email" type="email" required autocomplete="email">
        <button class="btn btn-quiet" type="submit">Send a new link</button>
      </form>
    </details>
```

Add to the page's `<style>` block: `.resend { margin-top: 18px; font-size: 14px; } .resend summary { cursor: pointer; color: var(--accent); }`

Replace the script (lines 90-101) with:

```html
<script>
  const params = new URLSearchParams(location.search);
  for (const flag of ["reset", "sent"]) {
    if (params.get(flag)) document.getElementById("flash-" + flag).style.display = "block";
  }
  const error = params.get("error");
  const flash = error && document.getElementById("flash-" + error);
  if (flash) flash.style.display = "block";
  const next = params.get("next");
  if (next && next.startsWith("/") && !next.startsWith("//")) {
    document.getElementById("next").value = next;
  }
</script>
```

- [ ] **Step 6: Edit `deploy/railway/pages/signup.html`**

Replace lines 68-72 (flashes) with:

```html
    <div class="flash ok" id="flash-sent">If that address can be used, we've sent an email to it.</div>
    <div class="flash error" id="flash-mail-unconfigured">Email delivery is not set up yet; contact support@itrackceu.com</div>
    <div class="flash error" id="flash-mail-failed">We couldn't send the email just now. Try again in a minute, or contact support@itrackceu.com.</div>
    <div class="flash error" id="flash-invalid">Please use a valid email, a display name, and a password of at least 10 characters.</div>
    <div class="flash error" id="flash-rate-limited">Too many attempts from your network. Try again in an hour.</div>
```

After the signup `</form>` (line 81) add the sent-state resend form:

```html
    <div id="sent-view" style="display:none">
      <p class="sub">We used <strong id="sent-address"></strong>. Didn't get it? Check spam, or send it again.</p>
      <form action="/auth/resend" method="post" id="resend-form">
        <input type="hidden" name="return" value="signup">
        <label for="resend-email">Email</label>
        <input id="resend-email" name="email" type="email" required autocomplete="email">
        <button class="btn btn-quiet" type="submit">Resend the link</button>
      </form>
      <p class="note">Wrong address? <a href="/signup">Start over</a></p>
    </div>
```

Replace the script (lines 85-94) with:

```html
<script>
  const params = new URLSearchParams(location.search);
  const error = params.get("error");
  if (params.get("sent")) {
    const mail = params.get("mail");
    const flashId = mail === "unconfigured" ? "flash-mail-unconfigured" : mail === "failed" ? "flash-mail-failed" : "flash-sent";
    document.getElementById(flashId).style.display = "block";
    document.getElementById("signup-form").style.display = "none";
    document.getElementById("sent-view").style.display = "block";
    const email = params.get("email") || "";
    document.getElementById("sent-address").textContent = email;
    document.getElementById("resend-email").value = email;
  }
  const flash = error && document.getElementById("flash-" + error);
  if (flash) flash.style.display = "block";
</script>
```

- [ ] **Step 7: Edit `deploy/railway/pages/reset.html:69`**

Change the sent flash to `<div class="flash ok" id="flash-sent">If that address can be used, we've sent an email to it.</div>`.

- [ ] **Step 8: Run the tests**

Run: `node --experimental-sqlite --test tests/auth-routes.test.mjs tests/auth-pages.test.mjs tests/auth-gateway.test.mjs tests/auth-store.test.mjs tests/auth-email.test.mjs`
Expected: PASS. Then `npm run lint` → PASS.

- [ ] **Step 9: Commit**

```bash
git add deploy/railway/auth-routes.mjs deploy/railway/pages tests/auth-routes.test.mjs tests/auth-pages.test.mjs tests/auth-gateway.test.mjs
git commit -m "feat(auth): verify by POST confirm, claimable re-signup, neutral copy, resend forms with their own email field

landing-auth-05, security-03, security-M-01, landing-auth-06, landing-auth-M-05,
landing-auth-M-02, infra-M-02, security-04.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 8: `AUTH_BOOTSTRAP_USERS` startup bootstrap (replaces Chris's env login)

**Rationale:** spec 3.1 "Bootstrap account": Basic + `ITRACK_USERS` are gone (Task 3), so the operator needs a way to create the first verified account without email working (theme 2: email is Chris-owned and may lag). ios-coupling-14 ordering: this must exist *before* `ITRACK_USERS` is deleted on Railway. Because workspace identity is `sha256("license-lantern:" + email)` (`db/identity.ts:48-55`), an account for `christophertskerritt@gmail.com` lands on Chris's existing data with no migration (spec §8).

**Files:**
- Create: `deploy/railway/bootstrap.mjs`
- Modify: `deploy/railway/serve.mjs` (call after the store opens, before `listen`)
- Modify: `README.md:73-83`
- Test: `tests/auth-bootstrap.test.mjs`

**Interfaces:**
- Consumes: `store.createVerifiedUser({ email, displayName, password })` → `{ userId, created }` (Task 2).
- Produces: `parseBootstrapUsers(raw: string | undefined): Array<{ email: string, password: string }>` — splits on `;`, splits each entry on the **first** `:` only (passwords may contain colons), lowercases the email, throws `Error` on a malformed entry (message never contains the password); `applyBootstrapUsers(store, entries, log = console.log): { created: string[], skipped: string[] }` — logs `[auth] bootstrap created account <email>` / `[auth] bootstrap skipped existing account <email>`.

- [ ] **Step 1: Write the failing test**

Create `tests/auth-bootstrap.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { AuthStore } from "../deploy/railway/auth.mjs";
import { applyBootstrapUsers, parseBootstrapUsers } from "../deploy/railway/bootstrap.mjs";

test("parseBootstrapUsers splits entries on ; and each on the first : only", () => {
  assert.deepEqual(parseBootstrapUsers(undefined), []);
  assert.deepEqual(parseBootstrapUsers("  "), []);
  assert.deepEqual(
    parseBootstrapUsers("Ops@Example.test:pa:ss:word-1; two@example.test:another-secret-2 ;"),
    [
      { email: "ops@example.test", password: "pa:ss:word-1" },
      { email: "two@example.test", password: "another-secret-2" },
    ],
  );
});

test("parseBootstrapUsers rejects malformed entries without echoing the password", () => {
  for (const raw of ["nocolon", "not-an-email:longenough-1", "ok@example.test:short"]) {
    assert.throws(() => parseBootstrapUsers(raw), (error) => {
      assert.match(error.message, /AUTH_BOOTSTRAP_USERS/);
      assert.doesNotMatch(error.message, /longenough-1|short/);
      return true;
    }, raw);
  }
});

test("applyBootstrapUsers creates verified accounts once and never touches existing ones", () => {
  const store = new AuthStore(":memory:");
  const pending = store.createUser({ email: "pending@example.test", displayName: "P", password: "pending-pass-1" });
  const lines = [];
  const entries = parseBootstrapUsers("new@example.test:new-secret-123;pending@example.test:boot-secret-123");
  const first = applyBootstrapUsers(store, entries, (line) => lines.push(line));
  assert.deepEqual(first, { created: ["new@example.test"], skipped: ["pending@example.test"] });
  assert.equal(store.authenticate("new@example.test", "new-secret-123").ok, true, "verified on creation");
  assert.equal(store.authenticate("pending@example.test", "boot-secret-123").ok, false, "existing row untouched");
  assert.ok(store.verifyEmail(pending.verifyToken), "the pending user's own link still works");
  const second = applyBootstrapUsers(store, entries, (line) => lines.push(line));
  assert.deepEqual(second, { created: [], skipped: ["new@example.test", "pending@example.test"] });
  for (const line of lines) {
    assert.doesNotMatch(line, /secret-123/, "passwords never reach the log");
  }
  assert.match(lines[0], /^\[auth\] bootstrap created account new@example\.test$/);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --experimental-sqlite --test tests/auth-bootstrap.test.mjs`
Expected: FAIL — cannot find module `bootstrap.mjs`.

- [ ] **Step 3: Create `deploy/railway/bootstrap.mjs`**

```js
// Startup account bootstrap. AUTH_BOOTSTRAP_USERS="email:password[;...]"
// creates a VERIFIED account for each address that has no account yet, so an
// operator can sign in before transactional email exists. Existing rows are
// never modified, which makes the variable safe to leave set and safe to
// delete after the first boot. The password is read, hashed, and dropped —
// it is never logged and never echoed in an error.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD_LENGTH = 10;

export function parseBootstrapUsers(raw) {
  const entries = [];
  for (const piece of String(raw ?? "").split(";")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      throw new Error("AUTH_BOOTSTRAP_USERS entries must look like email:password");
    }
    const email = trimmed.slice(0, colon).trim().toLowerCase();
    const password = trimmed.slice(colon + 1).trim();
    if (!EMAIL_RE.test(email)) {
      throw new Error("AUTH_BOOTSTRAP_USERS entry has an invalid email address");
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`AUTH_BOOTSTRAP_USERS password for ${email} must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    entries.push({ email, password });
  }
  return entries;
}

export function applyBootstrapUsers(store, entries, log = console.log) {
  const summary = { created: [], skipped: [] };
  for (const { email, password } of entries) {
    const result = store.createVerifiedUser({ email, displayName: null, password });
    if (result.created) {
      summary.created.push(email);
      log(`[auth] bootstrap created account ${email}`);
    } else {
      summary.skipped.push(email);
      log(`[auth] bootstrap skipped existing account ${email}`);
    }
  }
  return summary;
}
```

- [ ] **Step 4: Wire it into `deploy/railway/serve.mjs`**

Add the import: `import { applyBootstrapUsers, parseBootstrapUsers } from "./bootstrap.mjs";`

Immediately after the `store` open block (Task 3's `try { store = new AuthStore(...) }`) add:

```js
try {
  applyBootstrapUsers(store, parseBootstrapUsers(process.env.AUTH_BOOTSTRAP_USERS));
} catch (error) {
  console.error(`Refusing to start: ${error.message}`);
  process.exit(1);
}
```

- [ ] **Step 5: Update `README.md` deployment paragraph (lines 73-83)**

Replace with:

```markdown
Production runs on Railway: pushes to `main` auto-deploy. The container
(`Dockerfile` + `deploy/railway/serve.mjs`) builds the app, runs it under
wrangler's local workerd runtime with file-backed D1/R2 state on a volume
mounted at `/data`, and fronts it with a session-cookie auth gateway that
injects the identity headers. Accounts are self-serve (email + password,
verified by email via Resend: `RESEND_API_KEY`, `AUTH_EMAIL_FROM`,
`PUBLIC_BASE_URL`). To create the first verified account before email works,
set `AUTH_BOOTSTRAP_USERS="email:password"` for one boot; existing accounts
are never modified by it. Set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` /
`VAPID_SUBJECT` for web push. The gateway fires scheduled push delivery
every 15 minutes through a secret-guarded internal route.
```

- [ ] **Step 6: Run the tests and a syntax check**

Run: `node --experimental-sqlite --test tests/auth-bootstrap.test.mjs && node --check deploy/railway/serve.mjs && npm run lint`
Expected: PASS / silent / PASS.

- [ ] **Step 7: Commit**

```bash
git add deploy/railway/bootstrap.mjs deploy/railway/serve.mjs README.md tests/auth-bootstrap.test.mjs
git commit -m "feat(auth): AUTH_BOOTSTRAP_USERS creates verified accounts at startup

Replaces the env Basic login; existing accounts untouched; password never logged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 9: Delete the widget feed

**Rationale:** security-01 (P1, CONFIRMED live in prod — `/api/widget-summary` authorises with one shared static token and returns the *first* user's credentials: `app/api/widget-summary/route.ts:59-61` `SELECT id FROM users ORDER BY created_at, id LIMIT 1`; gateway bypass at old `gateway.mjs:9,146-149` already gone in Task 3), ios-coupling-04 (REMOVE classification; blast radius verified by grep: `worker/index.ts:22`, `db/cloudflare.d.ts:92`, `serve.mjs:117`, comments in `app/lib/readiness.ts:4-5,53` and `tests/rendered-html.test.mjs:4661`, plus `tests/widget-summary.test.mjs` 738 lines). `app/lib/widgetSummary.ts` is imported by nothing except the route (grep confirms).

**Files:**
- Delete: `app/api/widget-summary/route.ts`, `app/lib/widgetSummary.ts`, `tests/widget-summary.test.mjs`
- Modify: `worker/index.ts:22`, `db/cloudflare.d.ts:92`, `deploy/railway/serve.mjs` (`workerVarArgs` entry `"ITRACK_WIDGET_TOKEN"` and the comment above it), `app/lib/readiness.ts:1-6, 50-56`, `tests/rendered-html.test.mjs:4661`

**Interfaces:**
- Consumes: Task 3 (gateway no longer exempts the path).
- Produces: nothing; `grep -rni widget app db worker deploy tests` returns no hits.

- [ ] **Step 1: Delete the files**

```bash
git rm -q app/api/widget-summary/route.ts app/lib/widgetSummary.ts tests/widget-summary.test.mjs
```

- [ ] **Step 2: Remove the remaining references**

- `worker/index.ts:22` — delete the line `ITRACK_WIDGET_TOKEN?: string;`.
- `db/cloudflare.d.ts:92` — delete the line `ITRACK_WIDGET_TOKEN?: string;`.
- `deploy/railway/serve.mjs` — in `workerVarArgs` delete the `"ITRACK_WIDGET_TOKEN",` element and change the comment above the array to:

```js
// Worker vars are not inherited from the process environment; forward the
// ones the worker reads (VAPID push credentials) explicitly.
```

- `app/lib/readiness.ts` lines 1-6: replace the opening comment with:

```ts
/**
 * The dashboard hero's three numbers — days to renewal, counted credits, and
 * the readiness ring — used to live only inside `ITrackApp.tsx`. They live
 * here so that anything else publishing them derives them with the *same*
 * arithmetic instead of growing a second, quietly diverging notion of "ready".
 *
```

  and lines 50-56: replace `Server-side renderers (the iOS widget feed) run on workerd, whose zone is always UTC,` with `Server-side callers run on workerd, whose zone is always UTC,`.

- `tests/rendered-html.test.mjs:4661` — change `// module (the iOS widget feed derives the same score), so the contract` to `// module, so the contract`.

- [ ] **Step 3: Verify nothing is left and the tree typechecks**

Run:
```bash
grep -rni "widget" app db worker deploy tests; echo "exit=$?"
npm run typecheck && npm run lint
```
Expected: the only hit is the negative subtest `the widget feed no longer bypasses auth` in `tests/auth-gateway.test.mjs` (two lines); typecheck and lint PASS.

- [ ] **Step 4: Build and run the suites that import the worker**

Stop the dev server if running. Run: `npm run build && node --experimental-sqlite --test tests/rendered-html.test.mjs tests/real-sqlite-seed.test.mjs tests/auth-gateway.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A app/api app/lib/widgetSummary.ts app/lib/readiness.ts worker/index.ts db/cloudflare.d.ts deploy/railway/serve.mjs tests/rendered-html.test.mjs tests/widget-summary.test.mjs
git commit -m "feat: delete the widget feed (route, lib, tests, worker env, serve forwarding)

security-01, ios-coupling-04. ITRACK_WIDGET_TOKEN is deleted on Railway after deploy (Task 15).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 10: Delete APNs — libs, route, tests, cron fan-out, env, and migration `0013_drop_apns.sql`

**Rationale:** ios-coupling-05 (P2 — all five `APNS_*` vars set in prod; `runApnsChannel` runs on every 15-minute cron for zero web value; ~3,780 lines), ios-coupling-M-04 (the PKCS#8 PEM is passed to wrangler as argv), spec 3.1 + §8 (migration `0013` dropping `apns_devices` and `apns_delivery_ledger`). Verified locations: `worker/index.ts:4-8` (import), `:17-21` (Env), `:50-124` (`runApnsChannel`), `:147-183` and `:214-249` (fan-out); `db/schema.ts:612-666`; `db/runtime.ts:461-495` (six `CREATE` statements inside `TABLE_STATEMENTS`, which `initializeDatabase` at `:5998-6003` runs on every boot — this, not drizzle, is what the Railway volume's D1 file actually gets, so the DROP must live here too); `db/cloudflare.d.ts:87-91`; `serve.mjs` `workerVarArgs` `APNS_*`; `app/lib/reminders.ts:11-14` (`"apns"` channel member); `app/lib/pushDelivery.ts:62` (comment); `tests/real-sqlite-seed.test.mjs:210-238`; `tests/rendered-html.test.mjs:7840, 7928, 7937, 7968-7969, 8049-8053, 8429-8432`. `ReminderChannel`'s `"apns"` value is used only inside `apnsDelivery.ts` (grep).

**Files:**
- Delete: `app/lib/apnsJwt.ts`, `app/lib/apnsPush.ts`, `app/lib/apnsDelivery.ts`, `app/lib/apnsRegistration.ts`, `app/api/apns-token/route.ts`, `tests/apns-jwt.test.mjs`, `tests/apns-push.test.mjs`, `tests/apns-registration.test.mjs`, `tests/apns-delivery.test.mjs`
- Modify: `worker/index.ts`, `db/schema.ts:612-666`, `db/runtime.ts:461-495`, `db/cloudflare.d.ts:87-91`, `deploy/railway/serve.mjs`, `app/lib/reminders.ts:11-14`, `app/lib/pushDelivery.ts:62`
- Create (generated): `drizzle/0013_drop_apns.sql`, `drizzle/meta/0013_snapshot.json`; modify `drizzle/meta/_journal.json`
- Test: `tests/real-sqlite-seed.test.mjs:210-238`, `tests/rendered-html.test.mjs` (six spots)

**Interfaces:**
- Consumes: nothing.
- Produces: `worker/index.ts` runs only `runScheduledPushDelivery`; `Env` has no `APNS_*`; D1 boots drop both tables; drizzle journal's last tag is `0013_drop_apns`.

- [ ] **Step 1: Update the tests first**

`tests/real-sqlite-seed.test.mjs:210-238` — replace the `APNs tables are created by migrations` subtest with:

```js
  await t.test(
    "APNs tables are dropped by initialization (migration 0013)",
    async () => {
      const getTableColumns = async (table) => {
        const result = await realDatabase.prepare(`PRAGMA table_info(${table})`).all();
        return result.results;
      };
      assert.equal((await getTableColumns("apns_devices")).length, 0, "apns_devices must not exist");
      assert.equal((await getTableColumns("apns_delivery_ledger")).length, 0, "apns_delivery_ledger must not exist");
    },
  );
```

`tests/rendered-html.test.mjs`:
- line 7840: change the destructured name `apnsMigration,` to `apnsMigration,\n      dropApnsMigration,` and after the `readFile(... "../drizzle/0012_redundant_kate_bishop.sql" ...)` entry (ends at line 7930) add another entry:

```js
        readFile(
          new URL("../drizzle/0013_drop_apns.sql", import.meta.url),
          "utf8",
        ),
```

- line 7937: keep `${apnsMigration}` in the concatenation (it still creates the tables historically) and append `\n${dropApnsMigration}`.
- lines 7968-7969: delete `"apns_devices",` and `"apns_delivery_ledger",` from `requiredTables`.
- after the `assert.deepEqual(requiredTables.filter(...), [])` add:

```js
    assert.match(dropApnsMigration, /DROP TABLE `apns_delivery_ledger`;/);
    assert.match(dropApnsMigration, /DROP TABLE `apns_devices`;/);
    assert.ok(
      dropApnsMigration.indexOf("apns_delivery_ledger") < dropApnsMigration.indexOf("apns_devices"),
      "the ledger (child) is dropped before the devices table it references",
    );
```

- lines 8049-8053 and 8429-8432: change both `"0012_redundant_kate_bishop"` last-tag expectations to `"0013_drop_apns"`.

- [ ] **Step 2: Delete the files**

```bash
git rm -q app/lib/apnsJwt.ts app/lib/apnsPush.ts app/lib/apnsDelivery.ts app/lib/apnsRegistration.ts app/api/apns-token/route.ts tests/apns-jwt.test.mjs tests/apns-push.test.mjs tests/apns-registration.test.mjs tests/apns-delivery.test.mjs
```

- [ ] **Step 3: Rewrite `worker/index.ts`**

Replace the whole file with:

```ts
/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { runScheduledPushDelivery } from "../app/lib/pushDelivery";
import { initializeDatabase } from "../db/runtime";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /**
   * When set, POST /internal/run-scheduled with a matching
   * x-internal-scheduled-secret header runs the same push delivery as the
   * cron trigger. Used by self-hosted deployments (e.g. Railway) whose local
   * workerd runtime cannot fire cron triggers; unset on platform hosting, so
   * the route does not exist there.
   */
  INTERNAL_SCHEDULED_SECRET?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

function pushConfig(env: Env) {
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  };
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/internal/run-scheduled") {
      const secret = env.INTERNAL_SCHEDULED_SECRET;
      const provided = request.headers.get("x-internal-scheduled-secret");
      if (!secret || request.method !== "POST" || provided !== secret) {
        return new Response("Not Found", { status: 404 });
      }
      try {
        // A scheduled run can beat the first user request on a fresh
        // database; make sure the schema exists before delivery reads it.
        await initializeDatabase(env.DB);
        const result = await runScheduledPushDelivery({
          database: env.DB,
          scheduledTime: Date.now(),
          config: pushConfig(env),
        });
        return Response.json({ ok: true, result });
      } catch (error) {
        console.error(
          "iTrack internal scheduled run failed.",
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        );
        return Response.json({ ok: false }, { status: 500 });
      }
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        console.info("iTrack scheduled push delivery started.");
        try {
          await initializeDatabase(env.DB);
          const result = await runScheduledPushDelivery({
            database: env.DB,
            scheduledTime: controller.scheduledTime,
            config: pushConfig(env),
          });
          console.info(
            "iTrack scheduled push delivery completed.",
            JSON.stringify(result),
          );
        } catch (error) {
          console.error(
            "iTrack scheduled push delivery failed.",
            error instanceof Error ? (error.stack ?? error.message) : String(error),
          );
          throw new Error("Scheduled push delivery failed.");
        }
      })(),
    );
  },
};

export default worker;
```

- [ ] **Step 4: Remove the schema, env, channel and forwarding references**

- `db/schema.ts:612-666` — delete `export const apnsDevices = sqliteTable(...)` and `export const apnsDeliveryLedger = sqliteTable(...)` entirely (both blocks end at the `);` before `export const badgeDefinitions`). `index`/`uniqueIndex` imports stay (the push tables use them).
- `db/cloudflare.d.ts:87-91` — delete the five `APNS_*` lines.
- `deploy/railway/serve.mjs` `workerVarArgs` — delete the five `"APNS_*"` strings, leaving `["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]`.
- `app/lib/reminders.ts:11-14` — replace with:

```ts
export type ReminderChannel = "in_app" | "push" | "resolve";
```

- `app/lib/pushDelivery.ts:62` — change `// Exported so the APNs channel alerts with the same words: the copy stays` to `// Exported so every channel alerts with the same words: the copy stays`.

- [ ] **Step 5: Replace the runtime CREATE statements with DROPs**

In `db/runtime.ts:461-495` delete the six `apns_*` statements and put in their place, at the same position in `TABLE_STATEMENTS`:

```ts
  // Migration 0013: the APNs channel is gone. Existing volumes still carry
  // these tables; drop the ledger (child) first, then the devices table it
  // references. Both statements are no-ops on a fresh database.
  `DROP TABLE IF EXISTS apns_delivery_ledger`,
  `DROP TABLE IF EXISTS apns_devices`,
```

- [ ] **Step 6: Generate migration 0013**

```bash
npx drizzle-kit generate --name drop_apns
ls drizzle | tail -2
cat drizzle/0013_drop_apns.sql
tail -12 drizzle/meta/_journal.json
```
Expected: `drizzle/0013_drop_apns.sql` exists, `drizzle/meta/0013_snapshot.json` exists, the journal's last entry has `"tag": "0013_drop_apns"`. The SQL must read:

```sql
DROP TABLE `apns_delivery_ledger`;--> statement-breakpoint
DROP TABLE `apns_devices`;
```

If drizzle-kit emitted `apns_devices` first, reorder the two statements by hand so the ledger goes first (the ledger has a FOREIGN KEY to `apns_devices`; with `PRAGMA foreign_keys = ON` dropping the parent first performs an implicit delete that must not fail).

- [ ] **Step 7: Verify nothing is left; typecheck, lint, build, test**

Run:
```bash
grep -rni "apns" app db worker deploy tests | grep -v "^drizzle/"; echo "exit=$?"
```
Expected: only `db/runtime.ts` (the two DROP lines + comment), `tests/real-sqlite-seed.test.mjs` (the drop test) and `tests/rendered-html.test.mjs` (migration checks). Then:

```bash
npm run typecheck && npm run lint && npm run build && npm run build:nav-test && node --experimental-sqlite --test tests/*.test.mjs
```
Expected: all PASS (this is the first full `npm test`-equivalent run of the branch; the `tests/*.test.mjs` glob no longer includes any `apns-*` or `widget-summary` file).

- [ ] **Step 8: Commit**

```bash
git add -A app/lib app/api worker/index.ts db/schema.ts db/runtime.ts db/cloudflare.d.ts deploy/railway/serve.mjs drizzle tests
git commit -m "feat: delete APNs (libs, route, cron fan-out, env) and drop its tables in migration 0013

ios-coupling-05, ios-coupling-M-04. APNS_* are deleted on Railway after deploy (Task 15);
Chris revokes key U3F4W5JABK afterwards.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 11: Fix the log-activity crash and fence it with a static guard + Playwright regression test

**Rationale:** app-ux-01 / architecture-M-01 (P1, CONFIRMED, in production — the second keystroke in any log-activity text field throws `TypeError: Cannot read properties of null (reading 'value')` because five `onChange` handlers read `event.currentTarget.value` *inside* the `setActivityDraft` updater; after the draft-persist effect at `app/ITrackApp.tsx:2336-2353` schedules its timeouts, React defers the updater to render and has already nulled `currentTarget`). Verified handler locations: `app/ITrackApp.tsx:4520-4525` (title), `:4548-4553` (completionDate), `:4591-4604` (totalUnits), `:4629-4634` (allocatedUnits), `:4748-4753` (provider). The repo has no React testing library and no jsdom; the crash needs a real DOM with React's concurrent lanes, so the regression test is a **Playwright spec under `tests/e2e/`** run by a new `npm run test:e2e` against the dev server (demo identity on localhost). A cheap `node:test` static guard runs in `npm test` on every commit so the pattern cannot return unnoticed between e2e runs.

**Files:**
- Modify: `app/ITrackApp.tsx:4520-4525, 4548-4553, 4591-4604, 4629-4634, 4748-4753`
- Create: `tests/app-source-guards.test.mjs`, `tests/e2e/log-activity-typing.spec.ts`, `playwright.config.ts`
- Modify: `package.json` (`test:e2e` script, `@playwright/test` devDependency), `.gitignore` (`/test-results/`, `/playwright-report/`)

**Interfaces:**
- Consumes: nothing.
- Produces: `tests/app-source-guards.test.mjs` (extended by Tasks 13 and 14 — each adds one `test(...)`); `npm run test:e2e` = `playwright test`; `playwright.config.ts` with `baseURL` `http://localhost:3000`, `reuseExistingServer: true`.

- [ ] **Step 1: Write the static guard test**

Create `tests/app-source-guards.test.mjs`:

```js
// Cheap, always-on regression guards over the client source. Each guard
// pins a bug class the audit found, in a form that survives file moves
// (Wave 2 extracts screens out of ITrackApp.tsx): they scan every .tsx/.ts
// file under app/, not one path.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|mts)$/.test(entry)) out.push(full);
  }
  return out;
}

export function readClientSources() {
  return walk(appDir).map((file) => ({ file: path.relative(appDir, file), source: readFileSync(file, "utf8") }));
}

// Returns the text of every `setX((current) => …)` updater body, found by
// balancing parentheses from the opening `(` of the set call.
function updaterBodies(source) {
  const bodies = [];
  const opener = /\bset[A-Z]\w*\(\s*\(\s*(?:current|previous|prev|state)\s*\)\s*=>/g;
  let match;
  while ((match = opener.exec(source)) !== null) {
    let depth = 0;
    let index = match.index + match[0].indexOf("(");
    for (; index < source.length; index += 1) {
      const ch = source[index];
      if (ch === "(") depth += 1;
      if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push({ at: match.index, text: source.slice(match.index, index + 1) });
  }
  return bodies;
}

test("no state updater reads event.currentTarget or event.target (app-ux-01 / architecture-M-01)", () => {
  let seen = 0;
  for (const { file, source } of readClientSources()) {
    for (const body of updaterBodies(source)) {
      seen += 1;
      assert.doesNotMatch(
        body.text,
        /\bevent\.(currentTarget|target)\b/,
        `${file}@${body.at}: read the value into a local before calling the updater:\n${body.text.slice(0, 200)}`,
      );
    }
  }
  assert.ok(seen >= 7, `expected to scan at least the seven setActivityDraft updaters, scanned ${seen}`);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --experimental-sqlite --test tests/app-source-guards.test.mjs`
Expected: FAIL naming `ITrackApp.tsx@…` five times (title, completionDate, totalUnits, allocatedUnits, provider).

- [ ] **Step 3: Fix the five handlers in `app/ITrackApp.tsx`**

Lines 4520-4525 (title):

```tsx
                  onChange={(event) => {
                    const title = event.currentTarget.value;
                    setActivityDraft((current) => ({ ...current, title }));
                  }}
```

Lines 4548-4553 (completionDate):

```tsx
                    onChange={(event) => {
                      const completionDate = event.currentTarget.value;
                      setActivityDraft((current) => ({ ...current, completionDate }));
                    }}
```

Lines 4591-4604 (totalUnits):

```tsx
                    onChange={(event) => {
                      const totalUnits = event.currentTarget.value;
                      setActivityDraft((current) => ({
                        ...current,
                        totalUnits,
                        allocatedUnits:
                          !current.allocatedUnits ||
                          current.allocatedUnits === current.totalUnits
                            ? totalUnits
                            : current.allocatedUnits,
                      }));
                    }}
```

Lines 4629-4634 (allocatedUnits):

```tsx
                    onChange={(event) => {
                      const allocatedUnits = event.currentTarget.value;
                      setActivityDraft((current) => ({ ...current, allocatedUnits }));
                    }}
```

Lines 4748-4753 (provider):

```tsx
                  onChange={(event) => {
                    const provider = event.currentTarget.value;
                    setActivityDraft((current) => ({ ...current, provider }));
                  }}
```

- [ ] **Step 4: Run the guard, typecheck, lint**

Run: `node --experimental-sqlite --test tests/app-source-guards.test.mjs && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Add Playwright**

```bash
npm install --save-dev --save-exact "@playwright/test@$(npm view @playwright/test version)"
npx playwright install chromium
```

Add to `package.json` `scripts`: `"test:e2e": "playwright test"`. Append to `.gitignore`:

```
/test-results/
/playwright-report/
```

Create `playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

// Browser regression tests against the dev server (demo identity on
// localhost). Not part of `npm test`: run `npm run test:e2e` with the dev
// server up (it is started for you if :3000 is free).
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000/",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
```

- [ ] **Step 6: Write the e2e regression test**

Create `tests/e2e/log-activity-typing.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

// app-ux-01 / architecture-M-01: the second keystroke in any log-activity
// field used to throw inside a deferred state updater and unmount the app.
// Typing two characters into each field, slowly enough for the draft-persist
// effect to schedule its timeouts between keys, is the exact reproduction.
test("typing two characters into every log-activity field does not crash the app", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await page.getByRole("button", { name: "Log activity" }).first().click();
  const sheet = page.locator(".modal-card");
  await expect(sheet).toBeVisible();

  const title = sheet.locator('input[name="title"]');
  await title.click();
  await title.pressSequentially("Et", { delay: 300 });
  await expect(title).toHaveValue("Et");

  const units = sheet.locator('input[name="totalUnits"]');
  await units.click();
  await units.pressSequentially("12", { delay: 300 });
  await expect(units).toHaveValue("12");

  const allocated = sheet.locator('input[name="allocatedUnits"]');
  await allocated.click();
  await allocated.fill("");
  await allocated.pressSequentially("11", { delay: 300 });
  await expect(allocated).toHaveValue("11");

  const provider = sheet.locator('input[name="provider"]');
  await provider.click();
  await provider.pressSequentially("NB", { delay: 300 });
  await expect(provider).toHaveValue("NB");

  // A date input takes whole values; two fills 300 ms apart hit the same
  // pending-lane path a second keystroke does.
  const completion = sheet.locator('input[name="completionDate"]');
  await completion.fill("2026-01-05");
  await page.waitForTimeout(300);
  await completion.fill("2026-01-06");
  await expect(completion).toHaveValue("2026-01-06");

  await expect(sheet).toBeVisible();
  await expect(page.locator("#main-content")).toBeVisible();
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});
```

- [ ] **Step 7: Run the e2e test (dev server up)**

Start the dev server in another terminal if not already running: `npm run dev`. Then:

Run: `npm run test:e2e`
Expected: `1 passed`. Sanity check that the test detects the bug: temporarily revert one handler (`git stash push app/ITrackApp.tsx`), re-run → `1 failed` with `Cannot read properties of null (reading 'value')`; `git stash pop`.

- [ ] **Step 8: Commit**

```bash
git add app/ITrackApp.tsx tests/app-source-guards.test.mjs tests/e2e/log-activity-typing.spec.ts playwright.config.ts package.json package-lock.json .gitignore
git commit -m "fix(app): read event.currentTarget.value before the setActivityDraft updater in all five handlers

app-ux-01 / architecture-M-01. Adds a static source guard (npm test) and a
Playwright regression spec (npm run test:e2e) that types two characters into
every log-activity field.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 12: ErrorBoundary, client error beacon, `app/error.tsx`, `app/not-found.tsx`

**Rationale:** architecture-M-02 (P2 — no error boundary, `error.tsx` or `not-found.tsx` anywhere; one render exception blanks the whole app; unknown URLs get a bare text/plain `Not Found`), critic-04 (P2 — no client error/unhandledrejection handler; the P1 crash was invisible to the team). Spec 3.2: fallback shows "Something broke on our side" with a Reload button and a "Copy details" control; `window.onerror` and `unhandledrejection` post `{message, stack (first 2 kB), route, userAgent, at}` to `POST /api/client-error` (Task 5), rate-limited 10/min per session (client-side throttle mirrors the server's). Verified: `app/layout.tsx:92-107` (`RootLayout` renders `<body>{children}</body>`), `find app -name error.tsx -o -name not-found.tsx` → empty.

**Files:**
- Create: `app/lib/clientError.ts`, `app/components/ClientErrorBeacon.tsx`, `app/components/ErrorBoundary.tsx`, `app/error.tsx`, `app/not-found.tsx`
- Modify: `app/layout.tsx:92-107`, `app/globals.css` (append), `package.json` (`build:nav-test` compiles `clientError.ts` too)
- Test: `tests/client-error.test.mjs`, `tests/rendered-html.test.mjs` (one new subtest)

**Interfaces:**
- Consumes: `POST /api/client-error` (Task 5).
- Produces (imported by Task 13's guard and by later waves):
  - `app/lib/clientError.ts`: `export const CLIENT_ERROR_ENDPOINT = "/api/client-error"`, `export const STACK_LIMIT = 2048`, `export type ClientErrorReport = { message: string; stack: string; route: string; userAgent: string; at: string }`, `export function describeError(input: unknown): { message: string; stack: string }`, `export function buildClientErrorReport(input: unknown, context: { route: string; userAgent: string; at: string }): ClientErrorReport`, `export class ClientErrorThrottle { constructor(limit?: number, windowMs?: number); allow(nowMs: number): boolean }`.
  - `app/components/ClientErrorBeacon.tsx`: `export function reportClientError(input: unknown): void`, `export function ClientErrorBeacon(): null` (mounts the window listeners once).
  - `app/components/ErrorBoundary.tsx`: `export class ErrorBoundary extends Component<{ children: ReactNode }>`, `export function ErrorFallback({ error, onReset }: { error: unknown; onReset?: () => void })`.

- [ ] **Step 1: Write the failing unit test**

Change `package.json` `build:nav-test` to: `"build:nav-test": "tsc app/lib/navigation.ts app/lib/clientError.ts --outDir .test-build --module nodenext --target es2022"`.

Create `tests/client-error.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  ClientErrorThrottle,
  STACK_LIMIT,
  buildClientErrorReport,
  describeError,
} from "../.test-build/clientError.js";

test("describeError handles Error, string, and junk", () => {
  const fromError = describeError(new Error("x is null"));
  assert.equal(fromError.message, "x is null");
  assert.match(fromError.stack, /^Error: x is null/);
  assert.deepEqual(describeError("plain string"), { message: "plain string", stack: "" });
  assert.deepEqual(describeError(null), { message: "Unknown error", stack: "" });
  assert.deepEqual(describeError({ message: 42 }), { message: "Unknown error", stack: "" });
});

test("buildClientErrorReport clips the stack to 2 kB and carries the context", () => {
  const error = new Error("boom");
  error.stack = `Error: boom\n${"at frame\n".repeat(600)}`;
  const report = buildClientErrorReport(error, { route: "/credentials/abc", userAgent: "UA", at: "2026-09-10T12:00:00.000Z" });
  assert.equal(report.message, "boom");
  assert.equal(report.stack.length, STACK_LIMIT);
  assert.equal(report.route, "/credentials/abc");
  assert.equal(report.userAgent, "UA");
  assert.equal(report.at, "2026-09-10T12:00:00.000Z");
});

test("ClientErrorThrottle allows 10 per minute", () => {
  const throttle = new ClientErrorThrottle();
  for (let i = 0; i < 10; i += 1) assert.equal(throttle.allow(1_000 + i), true, `report ${i}`);
  assert.equal(throttle.allow(1_010), false);
  assert.equal(throttle.allow(1_000 + 60_000), true, "window rolls over");
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npm run build:nav-test; node --experimental-sqlite --test tests/client-error.test.mjs`
Expected: `tsc` errors on the missing file / test FAIL importing `clientError.js`.

- [ ] **Step 3: Create `app/lib/clientError.ts`**

```ts
// Pure helpers for the client error beacon: no window access here so the
// module compiles and tests under plain node.
export const CLIENT_ERROR_ENDPOINT = "/api/client-error";
export const STACK_LIMIT = 2048;
const MESSAGE_LIMIT = 500;

export type ClientErrorReport = {
  message: string;
  stack: string;
  route: string;
  userAgent: string;
  at: string;
};

export function describeError(input: unknown): { message: string; stack: string } {
  if (input instanceof Error) {
    return { message: input.message || input.name || "Unknown error", stack: input.stack ?? "" };
  }
  if (typeof input === "string" && input.length > 0) return { message: input, stack: "" };
  return { message: "Unknown error", stack: "" };
}

export function buildClientErrorReport(
  input: unknown,
  context: { route: string; userAgent: string; at: string },
): ClientErrorReport {
  const { message, stack } = describeError(input);
  return {
    message: message.slice(0, MESSAGE_LIMIT),
    stack: stack.slice(0, STACK_LIMIT),
    route: context.route.slice(0, 200),
    userAgent: context.userAgent.slice(0, 300),
    at: context.at,
  };
}

// Mirrors the gateway's 10/min per-session limit so a render loop cannot
// flood the network from the client side either.
export class ClientErrorThrottle {
  private readonly limit: number;
  private readonly windowMs: number;
  private windowStart = 0;
  private count = 0;

  constructor(limit = 10, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(nowMs: number): boolean {
    if (nowMs - this.windowStart >= this.windowMs) {
      this.windowStart = nowMs;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.limit;
  }
}
```

- [ ] **Step 4: Create the beacon and boundary components**

`app/components/ClientErrorBeacon.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import {
  CLIENT_ERROR_ENDPOINT,
  ClientErrorThrottle,
  buildClientErrorReport,
} from "../lib/clientError";

const throttle = new ClientErrorThrottle();

export function reportClientError(input: unknown): void {
  if (typeof window === "undefined") return;
  if (!throttle.allow(Date.now())) return;
  const report = buildClientErrorReport(input, {
    route: `${window.location.pathname}${window.location.search}`,
    userAgent: window.navigator.userAgent,
    at: new Date().toISOString(),
  });
  try {
    void fetch(CLIENT_ERROR_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // A beacon must never throw into the page it is reporting on.
  }
}

// Mounted once in the root layout: turns window-level errors and
// unhandled rejections into one POST each (throttled).
export function ClientErrorBeacon() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => reportClientError(event.error ?? event.message);
    const onRejection = (event: PromiseRejectionEvent) => reportClientError(event.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
```

`app/components/ErrorBoundary.tsx`:

```tsx
"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { describeError } from "../lib/clientError";
import { reportClientError } from "./ClientErrorBeacon";

type ErrorBoundaryState = { error: unknown | null };

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportClientError(error);
    console.error("iTrack render error", error, info.componentStack);
  }

  render() {
    if (this.state.error === null) return this.props.children;
    return <ErrorFallback error={this.state.error} />;
  }
}

export function ErrorFallback({ error, onReset }: { error: unknown; onReset?: () => void }) {
  const details = describeError(error);
  const copyDetails = () => {
    const text = `${details.message}\n${details.stack}\n${window.location.href}\n${new Date().toISOString()}`;
    void window.navigator.clipboard?.writeText(text).catch(() => {});
  };
  return (
    <section className="error-fallback" role="alert">
      <h1>Something broke on our side</h1>
      <p>Your data is safe on the server. Reload to pick up where you left off.</p>
      <div className="error-fallback-actions">
        <button className="button button-primary" type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
        <button className="button button-outline" type="button" onClick={copyDetails}>
          Copy details
        </button>
        {onReset ? (
          <button className="button button-outline" type="button" onClick={onReset}>
            Try again
          </button>
        ) : null}
      </div>
    </section>
  );
}
```

`app/error.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { reportClientError } from "./components/ClientErrorBeacon";
import { ErrorFallback } from "./components/ErrorBoundary";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError(error);
  }, [error]);
  return <ErrorFallback error={error} onReset={reset} />;
}
```

`app/not-found.tsx`:

```tsx
export default function NotFound() {
  return (
    <main id="main-content" className="main-content not-found">
      <section className="error-fallback">
        <h1>Page not found</h1>
        <p>That address doesn&rsquo;t match anything in iTrack.</p>
        <p>
          <a className="button button-primary" href="/">
            Go to Home
          </a>
        </p>
      </section>
    </main>
  );
}
```

Append to `app/globals.css`:

```css
/* Error fallback (ErrorBoundary, app/error.tsx, app/not-found.tsx). */
.error-fallback {
  max-width: 520px;
  margin: 15vh auto 0;
  padding: 0 20px;
  text-align: center;
}
.error-fallback h1 {
  font-size: 1.5rem;
  margin-bottom: 0.5rem;
}
.error-fallback p {
  color: var(--ink-muted);
  margin-bottom: 1rem;
}
.error-fallback-actions {
  display: flex;
  gap: 12px;
  justify-content: center;
  flex-wrap: wrap;
}
```

(`--ink-muted` already exists in `app/globals.css` — confirm with `grep -n -- "--ink-muted" app/globals.css`; if the token is named differently there, use the name that exists.)

- [ ] **Step 5: Mount in `app/layout.tsx`**

Add imports at the top: `import { ClientErrorBeacon } from "./components/ClientErrorBeacon";` and `import { ErrorBoundary } from "./components/ErrorBoundary";`. Replace `<body>{children}</body>` (line 104) with:

```tsx
      <body>
        <ClientErrorBeacon />
        <ErrorBoundary>{children}</ErrorBoundary>
      </body>
```

- [ ] **Step 6: Add the not-found assertion to the worker test**

In `tests/rendered-html.test.mjs`, after the `serves the app shell at every routed tab path` subtest (ends around line 668), add:

```js
  await t.test("unknown paths render the not-found route with a 404", async () => {
    const response = await fetchWorker("http://localhost/definitely-not-a-route", {
      headers: { accept: "text/html" },
    });
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
    assert.match(await response.text(), /Page not found/);
  });
```

- [ ] **Step 7: Build, run the unit + worker tests, typecheck, lint**

Stop the dev server. Run: `npm run build && npm run build:nav-test && node --experimental-sqlite --test tests/client-error.test.mjs tests/rendered-html.test.mjs && npm run typecheck && npm run lint`
Expected: PASS. If the not-found subtest still receives `text/plain Not Found` from the worker (vinext 0.0.50 not mounting the root `not-found.tsx` for unmatched URLs), add a catch-all route that forces the boundary and re-run:

`app/[...missing]/page.tsx`:

```tsx
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default function MissingRoute() {
  notFound();
}
```

- [ ] **Step 8: Commit**

```bash
git add app/lib/clientError.ts app/components app/error.tsx app/not-found.tsx app/layout.tsx app/globals.css package.json tests/client-error.test.mjs tests/rendered-html.test.mjs
git add app/\[...missing\]/page.tsx 2>/dev/null || true
git commit -m "feat(app): ErrorBoundary + client error beacon, error.tsx and not-found.tsx

architecture-M-02, critic-04 (client side). Beacons POST /api/client-error,
throttled 10/min; fallback offers Reload and Copy details.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 13: Sign-out as a POST form; JSON-safe fetch helper with session-ended handling

**Rationale:** app-ux-02 (P1 — Profile's Sign out is `<a href="/signout-with-chatgpt?return_to=%2F">`, a dead URL; `app/ITrackApp.tsx:9256-9263`; only `POST /auth/logout` exists), app-ux-M-01 / architecture-M-04 (`runAction` at `app/ITrackApp.tsx:2619` calls `response.json()` before checking status or content type, so a 401 or a proxy 502 surfaces as `Unexpected token … is not valid JSON`; the cold-load path at `:10906-10942` already handles 401 with "Reload and sign in"). Spec 3.2: the fetch helper treats 401 as "session ended" (shows the existing Reload-and-sign-in state) and any non-JSON body as "The server returned an unexpected response". Verified `response.json()` call sites: `:1940` (loadWorkspace), `:1987` (catalog), `:2224` (reminder launch), `:2619` (runAction), `:2688` (postPushAction), `:3296` (evidence upload), `:3328` (evidence list), `:3372` (evidence delete).

**Files:**
- Create: `app/lib/apiResponse.ts`
- Modify: `app/ITrackApp.tsx` (import; `handleSessionEnded`; the eight call sites; sign-out markup at `:9256-9263`)
- Modify: `package.json` (`build:nav-test` adds `apiResponse.ts`)
- Test: `tests/api-response.test.mjs`, `tests/app-source-guards.test.mjs` (two new guards)

**Interfaces:**
- Consumes: `WorkspaceLoadFailure` (existing, renders when `workspace === null && workspaceLoadFailed`), `POST /auth/logout` (existing; CSRF satisfied by the browser's same-origin `Origin` header).
- Produces (`app/lib/apiResponse.ts`):
  - `export const UNEXPECTED_RESPONSE_MESSAGE = "The server returned an unexpected response."`
  - `export const SESSION_ENDED_MESSAGE = "Your sign-in needs to be refreshed."`
  - `export type ApiResult<T> = { kind: "json"; ok: boolean; status: number; data: T } | { kind: "session-ended"; status: 401 } | { kind: "unexpected"; status: number; text: string }`
  - `export async function readApiResponse<T>(response: Response): Promise<ApiResult<T>>`
  - In `ITrackApp`: `const handleSessionEnded = useCallback(() => { setWorkspace(null); setWorkspaceLoadFailed(true); setWorkspaceLoadFailureStatus(401); setError(""); }, [])`.

- [ ] **Step 1: Write the failing tests**

Change `build:nav-test` to: `"build:nav-test": "tsc app/lib/navigation.ts app/lib/clientError.ts app/lib/apiResponse.ts --outDir .test-build --module nodenext --target es2022"`.

Create `tests/api-response.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_ENDED_MESSAGE,
  UNEXPECTED_RESPONSE_MESSAGE,
  readApiResponse,
} from "../.test-build/apiResponse.js";

test("JSON responses come back typed with ok/status", async () => {
  const response = new Response(JSON.stringify({ ok: true, id: "a1" }), {
    status: 200, headers: { "content-type": "application/json; charset=utf-8" },
  });
  assert.deepEqual(await readApiResponse(response), { kind: "json", ok: true, status: 200, data: { ok: true, id: "a1" } });
  const failed = new Response(JSON.stringify({ error: "nope", code: "cycle_closed" }), {
    status: 409, headers: { "content-type": "application/json" },
  });
  assert.deepEqual(await readApiResponse(failed), { kind: "json", ok: false, status: 409, data: { error: "nope", code: "cycle_closed" } });
});

test("a 401 is session-ended regardless of body", async () => {
  for (const body of ['{"error":"unauthenticated"}', "Authentication required", ""]) {
    const response = new Response(body, { status: 401, headers: { "content-type": "text/plain" } });
    assert.deepEqual(await readApiResponse(response), { kind: "session-ended", status: 401 });
  }
});

test("non-JSON bodies and malformed JSON are unexpected, never a SyntaxError", async () => {
  const html = new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
  assert.deepEqual(await readApiResponse(html), { kind: "unexpected", status: 502, text: "<html>502 Bad Gateway</html>" });
  const broken = new Response("{not json", { status: 200, headers: { "content-type": "application/json" } });
  assert.deepEqual(await readApiResponse(broken), { kind: "unexpected", status: 200, text: "{not json" });
  const noType = new Response("Upstream unavailable", { status: 502 });
  assert.equal((await readApiResponse(noType)).kind, "unexpected");
});

test("messages are the exact spec copy", () => {
  assert.equal(UNEXPECTED_RESPONSE_MESSAGE, "The server returned an unexpected response.");
  assert.equal(SESSION_ENDED_MESSAGE, "Your sign-in needs to be refreshed.");
});
```

Append to `tests/app-source-guards.test.mjs`:

```js
test("client code never calls response.json() directly (app-ux-M-01 / architecture-M-04)", () => {
  for (const { file, source } of readClientSources()) {
    if (file.startsWith("api/") || file === "lib/apiResponse.ts") continue;
    assert.doesNotMatch(source, /\bresponse\.json\(\)/, `${file}: use readApiResponse() from app/lib/apiResponse.ts`);
  }
});

test("sign out is a POST form to /auth/logout, not a link (app-ux-02)", () => {
  const sources = readClientSources();
  assert.ok(sources.every(({ source }) => !source.includes("/signout-with-chatgpt")), "dead sign-out URL removed");
  assert.ok(
    sources.some(({ source }) => /<form[^>]*method="post"[^>]*action="\/auth\/logout"/.test(source)),
    "a POST form to /auth/logout exists",
  );
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm run build:nav-test; node --experimental-sqlite --test tests/api-response.test.mjs tests/app-source-guards.test.mjs`
Expected: FAIL — missing module; eight `response.json()` hits; sign-out link present.

- [ ] **Step 3: Create `app/lib/apiResponse.ts`**

```ts
// One place that turns a fetch Response into something the UI can reason
// about. A lapsed session is a state, not a parse error; a proxy error page
// is "unexpected", not a SyntaxError in a banner.
export const UNEXPECTED_RESPONSE_MESSAGE = "The server returned an unexpected response.";
export const SESSION_ENDED_MESSAGE = "Your sign-in needs to be refreshed.";

export type ApiResult<T> =
  | { kind: "json"; ok: boolean; status: number; data: T }
  | { kind: "session-ended"; status: 401 }
  | { kind: "unexpected"; status: number; text: string };

export async function readApiResponse<T>(response: Response): Promise<ApiResult<T>> {
  if (response.status === 401) return { kind: "session-ended", status: 401 };
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType)) {
    return { kind: "unexpected", status: response.status, text: (await response.text()).slice(0, 500) };
  }
  const text = await response.text();
  try {
    return { kind: "json", ok: response.ok, status: response.status, data: JSON.parse(text) as T };
  } catch {
    return { kind: "unexpected", status: response.status, text: text.slice(0, 500) };
  }
}
```

- [ ] **Step 4: Wire it into `app/ITrackApp.tsx`**

Add the import next to the other `./lib/*` imports (after the `./lib/navigation` block at line 70):

```ts
import {
  SESSION_ENDED_MESSAGE,
  UNEXPECTED_RESPONSE_MESSAGE,
  readApiResponse,
} from "./lib/apiResponse";
```

Immediately before `const loadWorkspace = useCallback(async () => {` (line 1925) add:

```ts
  // A 401 from any fetch means the session lapsed. Drop the workspace so the
  // existing WorkspaceLoadFailure "Reload and sign in" state renders.
  const handleSessionEnded = useCallback(() => {
    setWorkspace(null);
    setWorkspaceLoadFailed(true);
    setWorkspaceLoadFailureStatus(401);
    setError("");
  }, []);
```

**loadWorkspace** (lines 1940-1943) — replace

```ts
      const data = (await response.json()) as Workspace & { error?: string };
      if (!response.ok) {
        throw new Error(data.error || "We couldn’t load your renewal workspace.");
      }
```

with

```ts
      const parsed = await readApiResponse<Workspace & { error?: string }>(response);
      if (parsed.kind === "session-ended") throw new Error(SESSION_ENDED_MESSAGE);
      if (parsed.kind === "unexpected") throw new Error(UNEXPECTED_RESPONSE_MESSAGE);
      const data = parsed.data;
      if (!response.ok) {
        throw new Error(data.error || "We couldn’t load your renewal workspace.");
      }
```

(the existing `catch` records `responseStatus` = 401 in `workspaceLoadFailureStatus`, which is what `WorkspaceLoadFailure` keys its "Reload and sign in" copy on).

**catalog** (lines 1987-1995) — replace

```ts
        const data = (await response.json()) as {
          catalog?: CatalogRule[];
          error?: string;
        };
        if (!response.ok || !Array.isArray(data.catalog)) {
```

with

```ts
        const parsed = await readApiResponse<{ catalog?: CatalogRule[]; error?: string }>(response);
        if (parsed.kind === "session-ended") {
          handleSessionEnded();
          throw new Error(SESSION_ENDED_MESSAGE);
        }
        if (parsed.kind === "unexpected") throw new Error(UNEXPECTED_RESPONSE_MESSAGE);
        const data = parsed.data;
        if (!response.ok || !Array.isArray(data.catalog)) {
```

**reminder launch** (lines 2224-2229) — replace

```ts
        const result = (await response.json()) as {
          target?: {
            credentialId?: unknown;
            reminderKey?: unknown;
          };
        };
```

with

```ts
        const parsed = await readApiResponse<{
          target?: { credentialId?: unknown; reminderKey?: unknown };
        }>(response);
        if (parsed.kind === "session-ended") {
          if (!controller.signal.aborted) handleSessionEnded();
          return;
        }
        const result = parsed.kind === "json" ? parsed.data : {};
```

**runAction** (lines 2619-2624) — replace

```ts
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        code?: string;
        id?: string;
      };
```

with

```ts
      const parsed = await readApiResponse<{
        ok?: boolean;
        error?: string;
        code?: string;
        id?: string;
      }>(response);
      if (parsed.kind === "session-ended") {
        handleSessionEnded();
        return null;
      }
      if (parsed.kind === "unexpected") throw new Error(UNEXPECTED_RESPONSE_MESSAGE);
      const result = parsed.data;
```

**postPushAction** (lines 2688-2693) — replace

```ts
    const result = (await response.json()) as {
      ok?: boolean;
      error?: string;
      code?: string;
      id?: string;
    };
```

with

```ts
    const parsed = await readApiResponse<{
      ok?: boolean;
      error?: string;
      code?: string;
      id?: string;
    }>(response);
    if (parsed.kind === "session-ended") {
      handleSessionEnded();
      throw new Error(SESSION_ENDED_MESSAGE);
    }
    if (parsed.kind === "unexpected") throw new Error(UNEXPECTED_RESPONSE_MESSAGE);
    const result = parsed.data;
```

**evidence upload** (lines 3296-3299) — replace

```ts
      const result = (await response.json()) as {
        evidence?: EvidenceFile;
        error?: string;
      };
```

with

```ts
      const parsed = await readApiResponse<{ evidence?: EvidenceFile; error?: string }>(response);
      if (parsed.kind === "session-ended") {
        handleSessionEnded();
        throw new Error(SESSION_ENDED_MESSAGE);
      }
      if (parsed.kind === "unexpected") throw new Error(UNEXPECTED_RESPONSE_MESSAGE);
      const result = parsed.data;
```

**evidence list** (lines 3328-3331) — replace

```ts
      const result = (await response.json()) as {
        evidence?: EvidenceFile[];
        error?: string;
      };
```

with

```ts
      const parsed = await readApiResponse<{ evidence?: EvidenceFile[]; error?: string }>(response);
      if (parsed.kind === "session-ended") {
        handleSessionEnded();
        throw new Error(SESSION_ENDED_MESSAGE);
      }
      if (parsed.kind === "unexpected") throw new Error(UNEXPECTED_RESPONSE_MESSAGE);
      const result = parsed.data;
```

**evidence delete** (lines 3372-3375) — replace

```ts
      const result = (await response.json()) as {
        error?: string;
        code?: string;
      };
```

with

```ts
      const parsed = await readApiResponse<{ error?: string; code?: string }>(response);
      if (parsed.kind === "session-ended") {
        handleSessionEnded();
        throw new Error(SESSION_ENDED_MESSAGE);
      }
      if (parsed.kind === "unexpected") throw new Error(UNEXPECTED_RESPONSE_MESSAGE);
      const result = parsed.data;
```

Each of these sits inside an existing `try { … } catch` that already turns thrown `Error.message` into the banner or modal error, so throwing is the least invasive way to surface the two fixed messages. Where `handleSessionEnded` is used inside a `useCallback`/`useEffect`, add it to that hook's dependency array (ESLint `react-hooks/exhaustive-deps` will name each one).

**Sign-out** (lines 9256-9263) — replace

```tsx
            <a
              className="button button-outline"
              href="/signout-with-chatgpt?return_to=%2F"
            >
              Sign out
            </a>
```

with

```tsx
            <form method="post" action="/auth/logout" className="account-signout">
              <button className="button button-outline" type="submit">
                Sign out
              </button>
            </form>
```

- [ ] **Step 5: Run the tests, typecheck, lint**

Run: `npm run build:nav-test && node --experimental-sqlite --test tests/api-response.test.mjs tests/app-source-guards.test.mjs && npm run typecheck && npm run lint`
Expected: PASS. Then stop the dev server and run `npm run build && node --experimental-sqlite --test tests/rendered-html.test.mjs` — expected PASS (the pins at `tests/rendered-html.test.mjs:7753-7757` — `status === 401 || status === 403`, `Reload and sign in` — are untouched).

- [ ] **Step 6: Manual check on the dev server**

Start `npm run dev`, open `http://localhost:3000/profile`: the demo identity shows "Local preview", not a sign-out button (expected — demo users never see it). Open DevTools → Network, block `/api/workspace`, add a task: the banner reads `The server returned an unexpected response.` (Playwright route abort returns a non-JSON error). This is a spot check, not a gate.

- [ ] **Step 7: Commit**

```bash
git add app/lib/apiResponse.ts app/ITrackApp.tsx package.json tests/api-response.test.mjs tests/app-source-guards.test.mjs
git commit -m "feat(app): sign out via POST /auth/logout form; JSON-safe fetch helper with session-ended state

app-ux-02, app-ux-M-01, architecture-M-04.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 14: Route titles + focus on navigation; `inert` on the parked screen

**Rationale:** app-ux-17 / a11y-03 (P3/P2 — `document.title` is always "iTrack — A clear path to renewal"; SPA navigation never moves focus; `app/ITrackApp.tsx:1303-1306` `applyRoute` only sets state), app-ux-09 / a11y-01 (P2 — the parked list under a pushed credential screen is still focusable and read by screen readers; `app/ITrackApp.tsx:4134-4138` `.screen-root.screen-under` has no `inert`; `Modal` at `:10634-10637` already uses `element.inert = true` for its siblings). Verified headings: Home `PageGreeting` at `:6900` (`Welcome, <name>.`), Credentials `:7869` (`Every renewal, one clear place.`), History `:8415`, Profile `:9240` — all render `<h1>` inside `.screen-root`; the pushed screen's `<h1 className="push-title">` is at `:8019`. `TAB_LABELS` at `:1264-1269`.

**Files:**
- Create: `app/lib/routeTitle.ts`
- Modify: `app/ITrackApp.tsx` (import; effect after `detailCredential` at `:2404-2412`; screen-root div at `:4134-4138`), `package.json` (`build:nav-test`)
- Test: `tests/route-title.test.mjs`, `tests/app-source-guards.test.mjs` (one new guard)

**Interfaces:**
- Consumes: `Route`, `TabName`, `buildPath` from `app/lib/navigation.ts` (unchanged).
- Produces: `export function routeTitle(route: Route, credentialName: string | null): string` → `"Home · iTrack"`, `"Credentials · iTrack"`, `"History · iTrack"`, `"Profile · iTrack"`, `"<credential name> · iTrack"` (`"Credential · iTrack"` while the name is unknown). Focus management: on every route change after the first paint, the new screen's `<h1>` receives focus (`tabindex="-1"` added if missing, `preventScroll: true`). `inert` + `aria-hidden="true"` on `.screen-root` whenever `detailCredential` is set.

- [ ] **Step 1: Write the failing tests**

Change `build:nav-test` to: `"build:nav-test": "tsc app/lib/navigation.ts app/lib/clientError.ts app/lib/apiResponse.ts app/lib/routeTitle.ts --outDir .test-build --module nodenext --target es2022"`.

Create `tests/route-title.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { routeTitle } from "../.test-build/routeTitle.js";

test("tab roots title by tab name", () => {
  assert.equal(routeTitle({ tab: "home", detail: null }, null), "Home · iTrack");
  assert.equal(routeTitle({ tab: "credentials", detail: null }, null), "Credentials · iTrack");
  assert.equal(routeTitle({ tab: "history", detail: null }, null), "History · iTrack");
  assert.equal(routeTitle({ tab: "profile", detail: null }, null), "Profile · iTrack");
});

test("a pushed credential titles by its name, with a fallback while loading", () => {
  const detail = { kind: "credential", id: "abc" };
  assert.equal(routeTitle({ tab: "credentials", detail }, "Licensed Clinical Social Worker"), "Licensed Clinical Social Worker · iTrack");
  assert.equal(routeTitle({ tab: "home", detail }, null), "Credential · iTrack");
  assert.equal(routeTitle({ tab: "home", detail }, "   "), "Credential · iTrack");
});
```

Append to `tests/app-source-guards.test.mjs`:

```js
test("the parked screen is inert while a credential is pushed, and routes set document.title (app-ux-09, a11y-01, app-ux-17, a11y-03)", () => {
  const sources = readClientSources();
  assert.ok(
    sources.some(({ source }) => /screen screen-root[\s\S]{0,200}?inert=\{Boolean\(detailCredential\)\}/.test(source)),
    "screen-root carries inert={Boolean(detailCredential)}",
  );
  assert.ok(sources.some(({ source }) => /document\.title = routeTitle\(/.test(source)), "document.title is set from routeTitle()");
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm run build:nav-test; node --experimental-sqlite --test tests/route-title.test.mjs tests/app-source-guards.test.mjs`
Expected: FAIL — missing module; guard assertions fail.

- [ ] **Step 3: Create `app/lib/routeTitle.ts`**

```ts
import type { Route, TabName } from "./navigation";

const TAB_TITLES: Record<TabName, string> = {
  home: "Home",
  credentials: "Credentials",
  history: "History",
  profile: "Profile",
};

// The document title for a route: "<screen> · iTrack". A pushed credential
// is named by the credential; before the workspace has loaded it, a neutral
// noun stands in so the tab never reads as the wrong screen.
export function routeTitle(route: Route, credentialName: string | null): string {
  if (route.detail) {
    const name = credentialName?.trim();
    return `${name && name.length > 0 ? name : "Credential"} · iTrack`;
  }
  return `${TAB_TITLES[route.tab]} · iTrack`;
}
```

- [ ] **Step 4: Wire into `app/ITrackApp.tsx`**

Import (after the `./lib/apiResponse` import): `import { routeTitle } from "./lib/routeTitle";`

After the `detailCredential` memo (ends at line 2412) add:

```ts
  // app-ux-17 / a11y-03: every route names itself in the tab and hands focus
  // to its heading, so screen readers hear the move and keyboard users start
  // at the top. The first paint keeps the browser's own focus (skip link).
  const announcedRouteRef = useRef<string | null>(null);
  useEffect(() => {
    document.title = routeTitle(nav.route, detailCredential?.credentialName ?? null);
    const key = buildPath(nav.route);
    if (announcedRouteRef.current === null) {
      announcedRouteRef.current = key;
      return;
    }
    if (announcedRouteRef.current === key) return;
    announcedRouteRef.current = key;
    const heading = document.querySelector<HTMLElement>(
      nav.route.detail ? ".screen-pushed h1" : ".screen-root h1",
    );
    if (!heading) return;
    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: true });
  }, [nav.route, detailCredential]);
```

Replace the screen-root element opening tag (lines 4134-4138):

```tsx
            <div
              className={`screen screen-root${
                detailCredential ? " screen-under" : ""
              }`}
              inert={Boolean(detailCredential)}
              aria-hidden={detailCredential ? "true" : undefined}
            >
```

- [ ] **Step 5: Run tests, typecheck, lint, and the worker suite**

Run: `npm run build:nav-test && node --experimental-sqlite --test tests/route-title.test.mjs tests/app-source-guards.test.mjs && npm run typecheck && npm run lint`
Expected: PASS (React 19's `inert` boolean prop types exist in `@types/react` 19.2). Stop the dev server, then `npm run build && node --experimental-sqlite --test tests/rendered-html.test.mjs` — expected PASS; the pin at `tests/rendered-html.test.mjs:689-692` (`className="screen-stack"[\s\S]{0,240}?screen screen-root[\s\S]{0,240}?screen-under`) still matches because the `inert` prop follows the `className` template.

- [ ] **Step 6: Manual check on the dev server**

Start `npm run dev`; open `http://localhost:3000/`, press the Credentials tab: `document.title` is `Credentials · iTrack` and focus sits on "Every renewal, one clear place."; open a credential: title is the credential name, `document.querySelector(".screen-root").inert === true`, Tab never reaches "Add credential" underneath; press back: title returns, `inert` is false.

- [ ] **Step 7: Commit**

```bash
git add app/lib/routeTitle.ts app/ITrackApp.tsx package.json tests/route-title.test.mjs tests/app-source-guards.test.mjs
git commit -m "feat(app): per-route document.title + heading focus; inert parked screen under a pushed credential

app-ux-17, a11y-03, app-ux-09, a11y-01.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 15: Gates, Docker run-check, merge, live verification, env deletion (in order)

**Rationale:** spec 3.3 (Wave 1 verification) and ios-coupling-14 (code before env: deleting `ITRACK_USERS` before the new gateway is live would crash-loop the *old* image; the widget token and `APNS_*` go last). Chris-owned items from spec §10: 5 (bootstrap password), 6 (post-live deletions and key revocation). Nothing in this task writes a secret anywhere but the Railway variable itself.

**Files:**
- No source changes. Produces: merged `main`, live itrackceu.com, Railway variables removed.

- [ ] **Step 1: Full local gates on the branch**

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
git branch --show-current   # feat/wave1-stop-the-bleeding
# stop any dev server on :3000 first
npm run typecheck && npm run lint && npm test
```
Expected: all green. Then start `npm run dev` and run `npm run test:e2e` → `1 passed`. Stop the dev server again.

- [ ] **Step 2: Docker build + run-check with only the bootstrap variable and a session secret**

```bash
docker build -t itrack-wave1 .
docker volume create itrack-wave1-data
OPS_PASSWORD="$(openssl rand -base64 18)"   # throwaway, lives only in this shell
docker run --rm -d --name itrack-wave1 -p 8080:8080 \
  -v itrack-wave1-data:/data \
  -e AUTH_SESSION_SECRET="$(openssl rand -hex 32)" \
  -e PUBLIC_BASE_URL="http://localhost:8080" \
  -e AUTH_BOOTSTRAP_USERS="ops@example.test:$OPS_PASSWORD" \
  itrack-wave1
sleep 20 && docker logs itrack-wave1 | tail -20
```
Expected log lines: `[auth] bootstrap created account ops@example.test` and `iTrack gateway listening on :8080 (session-cookie auth, self-serve signup enabled)`; the log must not contain `$OPS_PASSWORD`.

Then the curl matrix (spec 3.3):

```bash
B=http://localhost:8080
curl -si $B/ -H 'accept: text/html' | head -12                       # 200, text/html, HSTS, x-frame-options: DENY, CSP-RO, cache-control: public, max-age=300, no set-cookie
curl -si $B/ -A 'Googlebot/2.1' -H 'accept: text/html' | head -1     # 200
curl -sI $B/ -H 'accept: text/html' | head -1                        # HEAD 200
curl -si $B/ -H 'Accept:' | head -1                                  # no Accept header -> 200 landing
curl -si $B/api/workspace -H 'accept: application/json'              # 401 application/json {"error":"unauthenticated"}, cache-control: no-store, NO www-authenticate
curl -si $B/credentials -H 'accept: text/html' | grep -i '^location' # /login?next=%2Fcredentials
curl -si "$B//login" | head -1                                       # 400
for p in /robots.txt /sitemap.xml /favicon.ico /og.png /manifest.webmanifest /offline.html /sw.js /healthz; do printf '%s ' $p; curl -s -o /dev/null -w '%{http_code}\n' $B$p; done   # all 200
curl -si $B/api/widget-summary -H 'authorization: Bearer x' | head -1  # 401
curl -si $B/ -H 'accept: text/html' -H 'accept-encoding: br' | grep -i '^content-encoding'  # br
curl -si -X POST $B/auth/login -H 'origin: http://localhost:8080' --data-urlencode 'email=ops@example.test' --data-urlencode "password=$OPS_PASSWORD" | grep -iE '^(HTTP|location|set-cookie)'   # 303 / + itrack_session cookie
curl -si -X POST $B/auth/login --data-urlencode 'email=ops@example.test' --data-urlencode "password=$OPS_PASSWORD" | head -1   # 403 (no Origin)
```
Then with the cookie value from the login response in `$C`:
```bash
curl -s $B/api/workspace -H 'accept: application/json' -H "cookie: $C" | head -c 200   # 200 JSON workspace for ops@example.test
curl -si -X POST $B/auth/logout -H 'origin: http://localhost:8080' -H "cookie: $C" | grep -iE '^(HTTP|set-cookie)'   # 303, Max-Age=0
curl -s -o /dev/null -w '%{http_code}\n' $B/api/workspace -H 'accept: application/json' -H "cookie: $C"   # 401 after logout
```
Also confirm a second boot with the same volume skips: `docker restart itrack-wave1 && sleep 20 && docker logs itrack-wave1 | grep bootstrap` → `skipped existing account`. Finally `docker rm -f itrack-wave1 && docker volume rm itrack-wave1-data`.

Signup → verify → confirm cannot complete inside the container without Resend (links are no longer logged, by design); that path is covered by `tests/auth-gateway.test.mjs` and re-checked live once Chris's Resend setup (spec §10.1) exists. Check instead that `POST /auth/signup` (with Origin) 303s to `/signup?sent=1&mail=unconfigured&email=…` and that `GET /signup?sent=1&mail=unconfigured` renders the `support@itrackceu.com` line.

- [ ] **Step 3: Railway pre-flight (before merging)**

On Railway service `itrack` (production):
1. Set `AUTH_BOOTSTRAP_USERS="christophertskerritt@gmail.com:<generated>"` — Chris generates the password (spec §10.5) or Claude generates it with `openssl rand -base64 18` and sets it without recording it anywhere.
2. Set `PUBLIC_BASE_URL=https://itrackceu.com` if unset (the CSRF check compares against it; `RAILWAY_PUBLIC_DOMAIN` is the fallback).
3. Leave `ITRACK_USERS`, `ITRACK_WIDGET_TOKEN`, `APNS_*` in place for now — the new image ignores them; the old image needs them until it is replaced.

- [ ] **Step 4: Merge and deploy**

```bash
git checkout main && git pull --ff-only
git merge --no-ff feat/wave1-stop-the-bleeding -m "Merge feat/wave1-stop-the-bleeding: gateway rewrite, verification flow, app triage, widget/APNs removal

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
git push origin main
```
Watch the Railway deployment (dashboard, or `railway logs --service itrack` / the Railway MCP `list_deployments` + `get_logs`) until the log shows `[auth] bootstrap created account christophertskerritt@gmail.com` and `iTrack gateway listening`.

- [ ] **Step 5: Live verification on itrackceu.com**

Re-run the Step 2 curl matrix with `B=https://itrackceu.com` (skip the login/logout lines — do not put Chris's password in a shell history; Chris logs in through the browser). Additionally:
- Playwright/browser: open https://itrackceu.com/ → landing; `/credentials` → `/login?next=%2Fcredentials`; log in as Chris → lands on `/credentials`; Home shows the existing data (identity hash unchanged); open Log activity and type several characters into Title, Credits earned, Provider → no crash; Profile → Sign out → back on `/`; `/api/workspace` afterwards → 401 JSON.
- `curl -sI https://itrackceu.com/ | grep -iE 'strict-transport|x-frame|content-security'` → the three headers present.
- `https://itrackceu.com/api/widget-summary` → 401 JSON without `WWW-Authenticate` (unauthenticated) — the route itself is gone.
- Railway logs contain no `token=` and no `link for` lines.

- [ ] **Step 6: Chris confirms, then delete variables in order**

After Chris confirms the bootstrap login works (spec §10.6), delete on Railway service `itrack`, one at a time, confirming `/healthz` → 200 and a landing 200 after each redeploy:
1. `ITRACK_USERS` (and `VIGILO_USERS`, `LANTERN_USERS` if present)
2. `ITRACK_WIDGET_TOKEN`
3. `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY`, `APNS_BUNDLE_ID`, `APNS_ENVIRONMENT`
4. Optionally `AUTH_BOOTSTRAP_USERS` (harmless if left: existing accounts are never touched).

Use the Railway dashboard (service → Variables → delete) or the CLI if the installed version supports removal (`railway variables --help`); the Railway MCP `set_variables` tool sets values and is not used for deletion.

- [ ] **Step 7: Hand-offs**

- Chris: revoke APNs key `U3F4W5JABK` in Apple Developer; archive the iTrack-iOS repo (spec §10.6).
- Chris: Resend + DNS (spec §10.1-10.3) — the live signup → verify → confirm path is re-verified the day that lands (`POST /auth/signup` → email → `GET /verify?token=` page → "Confirm my email" → app).
- Record in memory: Wave 1 live commit hash, the env deletions done, and that Wave 2 starts from `main` at that hash.

---

## Self-review notes (run after writing; kept for the executors)

**Spec coverage (section 3 → task):** session-cookie-only + env-user deletion → T3; path+Accept routing, landing / 303 `next` / 401 JSON / HEAD → T3; public allowlist + `robots.txt` + `sitemap.xml` + noindex → T1, T3; request-target normalisation → T4; security headers + compression + `max-age=300` → T4; sign-out POST form → T13; sliding cookie → T2, T5; verification flow (GET page + POST confirm, claimable re-signup, neutral copy, generic login error, resend forms with own email field) → T2, T6, T7; email hardening (no name, no link logging, `mail_unconfigured` + support copy) → T6, T7; login CSRF → T6; per-account limiter with 2 s delay → T6; bootstrap account → T2, T8; widget + APNs deletion + migration 0013 + env order → T9, T10, T15; push deep links keep path+query in `next` → T3, T6; crash fix + regression test → T11; ErrorBoundary + beacon + `error.tsx` + `not-found.tsx` → T5, T12; route titles + focus → T14; inert parked screen → T14; pricing copy + test pins → T1; non-JSON / 401 fetch handling → T13; 3.3 verification → T15; §8 migration 0013 → T10; §10.5/10.6 → T15.

**Ambiguities resolved (and how):**
1. *"no-Accept" must land (spec 3.3) vs "HTML Accept → landing" (3.1).* `wantsHtml()` treats an absent Accept and `*/*` as HTML for `GET`/`HEAD`; `/api/*` is JSON 401 regardless of Accept. curl (`*/*`), Googlebot and HEAD all get the landing; `fetch()` with `accept: application/json` gets JSON.
2. *Landing for `/` vs push deep links `/?delivery=…` (ios-coupling-M-03).* `/` with a `delivery` or `view` query (the service worker's only launch parameters) 303s to `/login?next=…`; `/` with any other query (UTM etc.) lands.
3. *"collapse repeated slashes" vs "reject targets not starting with a single `/`".* Both: `//…` and non-`/` targets → 400 `bad_request_target`; interior `//` collapses before routing and proxying.
4. *Where `/api/client-error` lives.* In the gateway (it holds the session cookie, `RateLimiter`, stdout, and must accept beacons before the auth check); unauthenticated beacons are accepted keyed by IP. In `npm run dev` (no gateway) the beacon 404s harmlessly.
5. *Sliding cookie without changing the cookie format.* `sessions.cookie_issued_at` (additive column, upgraded on open) + re-sending the *same* signed value with a fresh `Max-Age`; existing cookies stay valid.
6. *Crash regression test with no React test harness.* Playwright spec under `tests/e2e/` (`npm run test:e2e`, dev server, demo identity) is the reproduction; a `node:test` static guard runs in `npm test` on every commit. `@playwright/test` is the one new devDependency.
7. *Sitemap lists `/login` and `/signup` while those pages are `noindex`.* Implemented exactly as the spec states; flagged for Wave 5's SEO pass.
8. *`next` after login for auth pages.* `safeNextPath` rejects `/login`, `/signup`, `/reset`, `/verify`, `/auth/*` (they would loop or 404) in addition to non-relative targets.
9. *Verify page caching.* Public pages get `public, max-age=300`; `/verify` (reached from a secret URL) is `no-store`.
10. *Repeat signup for a **verified** email.* Same `?sent=1` redirect, nothing sent (enumeration-neutral); the "you already have an account" email suggested by infra-M-02 is left to Wave 5.
11. *`/favicon.ico` did not exist.* Generated as a PNG-in-ICO container from `public/icon-192.png` so the allowlisted path is a real 200.
12. *`not-found.tsx` under vinext 0.0.50.* Asserted via the worker test; a catch-all `app/[...missing]/page.tsx` calling `notFound()` is the documented fallback if the root boundary is not mounted for unmatched URLs.
