# iTrack web-only pivot, remediation, and redesign — design spec

Date: 2026-09-10. Status: approved direction (Chris, 2026-09-10 08:50–10:31 EDT); visual identity gated on a mockup review before Wave 3 screens are built.

Audit this spec answers: `docs/audits/2026-09-10-audit/` (findings.json, README.md; report artifact https://claude.ai/code/artifact/b6272b2c-75f3-41a5-b668-aab099979b9b). Finding ids in this document refer to that file.

## 1. Decisions in force

1. **Web is the only product.** The Capacitor/TestFlight shell (repo iTrack-iOS) is retired. Every code path that exists only for it is removed: the Safari/Firefox user-agent gate, HTTP Basic auth, the widget feed, APNs, haptics, the pushed-screen nav idiom.
2. **Public self-serve SaaS.** Strangers land on itrackceu.com, understand it, sign up, verify by email, and get value alone.
3. **Everything is free.** No tiers, no "Pro", no pricing, no ads, anywhere. Copy and tests that mention them are removed.
4. **Framework stays.** Django was considered and rejected for this codebase: the gaps are configuration, a ~150-line gateway rewrite, and product bugs; a port would rewrite a 12.5k-line rules engine and 170 TypeScript templates with no domain test net. Stack remains Vinext (Next App Router) on the Cloudflare worker runtime, D1 + R2 via wrangler, Railway container, Node gateway.
5. **Decompose while restyling.** `app/ITrackApp.tsx` is split into screen files and a small component library as each screen is redesigned; `app/globals.css` is split per screen. No fresh client.
6. **Design direction (Chris delegated):** warm editorial surfaces with instrument-panel data displays. No Times, no forest green, no iOS-blue system look. Theme is tokens so a palette change is a swap.
7. **Process:** audit first (done); this spec; one implementation plan per wave; every wave built by max-effort Fable agents in a Workflow with adversarial review; Fable verifies gates and live state before declaring a wave done; a mockup of Home + landing is approved by Chris before Wave 3.

## 2. Waves and gates

| Wave | Name | Ships | Gate to start | Gate to finish |
|---|---|---|---|---|
| 1 | Stop the bleeding | gateway rewrite, crash + boundary + beacon, sign-out, widget/APNs removal, pricing copy removal, bootstrap account | this spec committed | tests green, Docker run-check, live verification on itrackceu.com |
| 2 | Foundation | test decoupling, isolation suite, iOS residue sweep, data-model fixes (credential edit/delete/archive, local-date + device time zone, current-cycle selection) | Wave 1 live | tests green incl. isolation suite; live verification |
| 3 | Design system + shell | tokens, type, primitives (Modal, ScreenStack, forms, instruments), app shell + navigation, error/not-found routes | **Chris approves mockup** | contrast audit green, both schemes, desktop + phone screenshots |
| 4 | Screens | Home, Credentials, Credential detail, Log activity, Activity log (History), Account (Profile), packet — each extracted to its own file as redesigned; copy rewritten | Wave 3 live | Playwright e2e per screen; no code left in ITrackApp.tsx beyond composition |
| 5 | Public funnel + ops floor | landing, signup/verify/reset flow, privacy + terms, SEO fundamentals, funnel logging; backups, uptime, quotas, CI, dependency hygiene, runtime hardening | Wave 4 live (landing needs real screenshots) | crawler + preview checks live; backup restore rehearsed |

Chris-owned items run in parallel from day one (section 10). Wave 1 does not wait for them, but the funnel cannot be verified end-to-end until email works.

## 3. Wave 1 — Stop the bleeding

### 3.1 Gateway and auth model (closes the "one root cause reported 20 ways" theme)

`deploy/railway/gateway.mjs`, `serve.mjs`, `auth-routes.mjs`, `auth.mjs`; tests `tests/auth-gateway.test.mjs`, `tests/auth-pages.test.mjs`.

- **Session cookie is the only credential.** HTTP Basic acceptance, the `ITRACK_USERS` / `VIGILO_USERS` / `LANTERN_USERS` env users, the 5-minute Basic success cache, the Basic fail limiter, and `ITRACK_OPEN_IDENTITY` are deleted. The startup fail-closed check becomes: a session secret must exist (env or persisted file) and the auth DB must open.
- **Routing by path and Accept, never by User-Agent.** For unauthenticated requests: `GET /` with an HTML Accept serves `landing.html`; any other app path with an HTML Accept 303s to `/login?next=<path+query>` (only same-origin relative paths are accepted for `next`, else `/`); `/api/*` and any non-HTML request answer `401 {"error":"unauthenticated"}` with `Cache-Control: no-store` and **no** `WWW-Authenticate` header. `HEAD` mirrors `GET` semantics.
- **Public allowlist served without auth, with caching:** `/robots.txt`, `/sitemap.xml`, `/favicon.ico`, `/manifest.webmanifest`, `/icons/*`, `/og.png`, `/offline.html`, `/sw.js`, `/_next/static/*` and the built asset directory, `/healthz`. `robots.txt` and `sitemap.xml` are new static files in `public/` (sitemap lists `/`, `/login`, `/signup`; auth pages carry `<meta name="robots" content="noindex">`; landing does not).
- **Request-target normalisation (critic-07):** collapse repeated slashes and reject targets that do not start with a single `/` before routing, and proxy the normalised target.
- **Security headers on every response** (public pages and proxied app): `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self), microphone=(), geolocation=()`, `X-Frame-Options: DENY`, and `Content-Security-Policy-Report-Only` with `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; frame-ancestors 'none'` (report-only in Wave 1; enforced in Wave 5 after the redesign settles its font and script needs). Public pages are gzip/brotli compressed and sent with `Cache-Control: public, max-age=300`.
- **Sign-out** is `POST /auth/logout` (exists) and the app renders it as a form, not a link (app-ux-02 family). Logout clears the session row and the cookie.
- **Sliding session (landing-auth-M-03):** on any authenticated request where the cookie is older than 24 h, re-issue the cookie with a fresh 30-day `Max-Age` and bump the DB row.
- **Verification flow redesigned as one unit** (landing-auth-05, security-03, landing-auth-M-02, security-M-01, security-04, infra-M-02): `GET /verify?token=` renders a page with a "Confirm my email" **POST** form; the token is consumed only on POST; success signs the user in and redirects to `/`. Signing up again with an email that has an **unverified** account replaces the stored name and password hash and re-sends the link (so a squatter's password never survives). Because that makes the row claimable in *either* order — a squatter can also re-sign-up after the owner and before the owner clicks, and the resend form issues links for whatever hash is current — the confirm form also takes the account's **current password** (branch review, 2026-09-10): the token is consumed only when it matches, a wrong password keeps the link and is limited like login (per IP and per account, shared bucket), and an owner whose password no longer matches signs up again to restore it. Signup, login-unverified, resend and reset all end on the same neutral copy: "If that address can be used, we've sent an email to it." Login with wrong credentials or unverified account returns the same generic error; the resend control lives on the signup "sent" page and on the login page as a POST form with its own email field (fixes landing-auth-06/M-05).
- **Email content hardening (landing-auth-M-01, security-M-03):** the display name is never interpolated into email bodies; verification and reset links are never written to logs. When email is unconfigured, `deliver()` returns a `mail_unconfigured` result and the page shows "Email delivery is not set up yet; contact support@itrackceu.com" — nothing is logged beyond the event kind.
- **Login CSRF (security-07):** `/auth/*` POSTs require an `Origin` or `Referer` matching `PUBLIC_BASE_URL`; absence is rejected.
- **Rate limiting:** per-IP limiter keyed on the last `x-forwarded-for` entry stays, plus a per-account limiter on login (10 failures / 15 min → generic error with a fixed 2-second delay). The Basic limiter is deleted with Basic.
- **Bootstrap account (replaces Chris's env login):** env `AUTH_BOOTSTRAP_USERS="email:password[;email:password]"` is read once at startup; for each entry that has no existing account, a **verified** account is created; existing accounts are left untouched (so the variable can stay set harmlessly and is deleted after first boot). Because workspace identity is `sha256(email)`, signing in with `christophertskerritt@gmail.com` keeps Chris's existing data. The plan must never write the password into any document; it is generated by the operator.
- **Widget feed and APNs (security-01, ios-coupling-04/05):** delete `app/api/widget-summary`, `app/lib/widgetSummary*`, the gateway exemption, `ITRACK_WIDGET_TOKEN`; delete `app/api/apns-token`, `apnsJwt`/`apnsPush`/`apnsDelivery`, the cron fan-out to APNs, and add migration `0013` dropping `apns_devices` and `apns_delivery_ledger`. Env deletion order per ios-coupling-14: code first, deploy, verify, then delete `ITRACK_USERS`, `ITRACK_WIDGET_TOKEN`, `APNS_*` on Railway, then Chris revokes the `.p8` key in Apple Developer.
- **Push deep links (ios-coupling-M-03):** unauthenticated HTML requests carry the full path and query into `next`, and `/auth/login` honours it.

### 3.2 App triage

- **Crash (app-ux-01 / architecture-M-01):** the five `onChange` handlers in the log-activity editor read `event.currentTarget.value` into a local before calling `setActivityDraft`. A regression test renders the editor and types two characters into each field.
- **Error boundary + beacon (architecture-M-02, critic-04):** `app/components/ErrorBoundary.tsx` wraps the app; fallback shows "Something broke on our side" with a Reload button and a "Copy details" control. `window.onerror` and `unhandledrejection` post `{message, stack (first 2 kB), route, userAgent, at}` to `POST /api/client-error`, which logs one structured line and is rate-limited 10/min per session. `app/error.tsx` and `app/not-found.tsx` are added.
- **Route titles (app-ux-17, a11y-03):** each route sets `document.title` ("Home · iTrack", "Credentials · iTrack", "<credential name> · iTrack", …) and moves focus to the screen heading on navigation.
- **Parked screen inert (app-ux-09, a11y-01):** the underlying list gets the `inert` attribute while a credential screen is pushed. (The push/pop idiom itself is replaced in Wave 3.)
- **Pricing copy (landing-auth-08, architecture-18):** remove "Free during beta", the Free/Pro tier cards, "Pro coming soon", and every test assertion that pins them. Landing gets no replacement section in Wave 1; the Wave 5 landing replaces the page.
- **Non-JSON error handling (app-ux-M-01, architecture-M-04):** the client's fetch helper treats a 401 as "session ended" (shows the existing Reload-and-sign-in state) and any non-JSON body as "The server returned an unexpected response" instead of a JSON parse error.

### 3.3 Wave 1 verification

`npm test` green (after test rewrite for the gateway), `npm run typecheck`, `npm run lint`; Docker build + run-check with only `AUTH_BOOTSTRAP_USERS` set, including a sign-in through the gateway as that account and an authenticated `POST /api/workspace` that the worker answers (400 `action is required`), not `403 cross_origin_request` — the worker runtime builds `request.url` from the Host alone (scheme fixed at http) unless `serve.mjs` passes `--local-upstream`/`--upstream-protocol` derived from `PUBLIC_BASE_URL`, and the worker's same-origin check on saves compares the browser's `Origin` against that; Playwright: landing 200 for curl-with-Accept, Googlebot UA, HEAD, no-Accept; `/api/workspace` unauthenticated → JSON 401 without `WWW-Authenticate`; signup → verify page → POST confirm → app; log-activity typing does not crash; sign out works; robots/sitemap/favicon/og 200 unauthenticated; headers present. Then live on itrackceu.com after merge.

## 4. Wave 2 — Foundation

- **Test decoupling (architecture-03):** `tests/rendered-html.test.mjs` source-regex assertions (165) and iOS-markup pins (~130) are deleted and replaced by (a) a Playwright e2e suite under `tests/e2e/` driven against the dev server with the demo identity, one spec per screen, asserting behaviour not markup; (b) unit tests for pure modules as they are extracted (`app/lib/*`). `tools/contrast-audit.mjs` is generalised to walk every stylesheet under `app/` and `deploy/railway/pages/`.
- **Two-identity isolation suite (critic-08):** `tests/isolation.test.mjs` boots the built worker against real node:sqlite with identities A and B and asserts that every workspace action, `/api/evidence` read/write, `/api/export/*`, and the packet route refuse cross-identity ids (404 — or, for push endpoints, which are browser-issued capability URLs rather than ids, a neutral 409 on save and an idempotent 200 on remove — never data). This lands before any change to `route.ts`.
- **iOS residue sweep (architecture-08, ios-coupling-06/09/11/12/15/16, perf-08):** `hapticTap`, Capacitor references, the "no webfont" rule, dead Manrope/Newsreader woff2, README/DESIGN-SYSTEM/TC-002 prose, Dockerfile comments. Keep-list honoured (ios-coupling-10): manifest, service worker, offline page, icons, VAPID web push, iOS-Safari install helpers, safe-area rules, route pages. Add a test that pins the six protected legacy identifiers (`license-lantern:` salt, draft prefix, ICS UID domain, push topic, SW cache prefix, R2 bucket name).
- **Credential edit / delete / archive (app-ux-03):** new workspace actions `updateCredential` (name, issuing body, cycle dates, renewal deadline, requirement overrides for custom credentials; template-linked credentials may change dates and custom name only), `archiveCredential` (hidden from Home/Credentials, visible under Activity log → Archived, reversible), `deleteCredential` (permanent; requires typing the credential name; deletes its cycles, checklist, check-ins, and unlinks activities without deleting them; evidence linked only to that credential is deleted from R2). Revision-guarded like `updateActivity`.
- **Local dates and device time zone (critic-01):** `app/lib/dates.ts` exports `todayLocal(tz)`; every default date uses the user's reminder time zone (the seed literal `UTC` counts as unset and falls back to the device zone); on first load after this ships, if the stored zone is `UTC` and `Intl.DateTimeFormat().resolvedOptions().timeZone` differs, the client offers a one-tap "Use <zone>" banner and the reminder scheduler uses the stored zone for 9:00 local.
- **Current-cycle selection (app-ux-04):** `getWorkspace` derives `activeCycle` as the earliest open cycle whose end date is in the future, else the most recently opened cycle; Home never shows an accepted/closed cycle with a countdown.
- **Renewed cycles in the list (app-ux-18):** closed cycles are grouped under the credential, not listed as siblings.

## 5. Wave 3 — Design system and shell

### 5.1 Identity (to be confirmed at the mockup gate)

The metaphor is the professional's ledger: bone paper, ink, one fountain-pen blue, and instruments that read at a glance. It is a website, on every device.

- **Palette (light):** paper `#F5F2EA`, paper-deep `#EBE7DC`, card `#FFFDF8`, ink `#1C1A17`, ink-muted `#5E5A52`, line `#DAD5C8`, accent (ink blue) `#2743B8`, accent-soft `#E3E8FA`. Semantic, separate from accent: overdue `#B3261E` / `#FBE4E2`, due-soon `#8A5A00` / `#FBEFD3`, complete `#22694E` / `#DDF0E6`, neutral-state `#5E5A52`.
- **Palette (dark):** paper `#15130F`, paper-deep `#0F0E0B`, card `#1F1C16`, ink `#EDE8DC`, ink-muted `#A8A196`, line `#332F27`, accent `#93A6FF`, accent-soft `#1E2750`; semantic overdue `#F08A80` / `#3D1F1C`, due-soon `#E6B85C` / `#3A2A12`, complete `#7FCBA4` / `#163326`.
- **Type:** display **Bricolage Grotesque** (Google Fonts, variable; 600–800, tight tracking, optical size for numerals ≥ 32 px) for page titles, hero numerals, and ring labels; body **Atkinson Hyperlegible** (legibility-first, a deliberate choice for a compliance audience and the a11y findings); data **IBM Plex Mono** for dates, credit counts in tables, ids, tabular numerals everywhere digits align. Fonts self-hosted under `public/fonts/` as woff2 subsets, preloaded, `font-display: swap`, a 40 kB per-face budget (perf-08). Type scale in `rem` (a11y-14): 0.75, 0.8125, 0.875, 1, 1.125, 1.375, 1.75, 2.25, 3.
- **Instruments:** `CycleRing` (SVG, credits counted vs required, colour by state, centre numeral in display face), `DeadlineTimeline` (horizontal, next 12 months, one tick per credential deadline, today marker, hover/focus reveals), `CreditBar` (per-requirement stacked bar with minimum and cap markers), `StatusPill` (state in form and colour, with text). All accept `reduced-motion`.
- **Motion:** three moments only: logging an activity (bar fills to new value, 400 ms ease-out), a requirement crossing its threshold (ring segment completes, checkmark draws), closing a cycle (card folds to the ledger row). Everything else is instant.
- **Layout:** desktop is a persistent left rail (brand, Home / Credentials / Activity log / Account, a Log activity button) with a 1120 px content column; content is a two-column ledger on Home (credentials column, timeline + next actions column). Phone is a top app bar with the screen title and a bottom navigation bar with the same four items plus a Log button; no push/pop transitions, no grabbers, no parked screens — navigation is ordinary page routing with URL per screen (kept from `app/lib/navigation.ts`, minus depth/origin-tab state).

### 5.2 Primitives (`app/components/`)

`Modal` (focus trap, `inert` on the page, Escape closes the top-most only, backdrop click closes when the form is clean, returns focus to the opener, `autoFocus` honoured), `Sheet` (phone presentation of Modal), `Form` primitives (`Field`, `TextInput`, `DateInput` local-date aware, `Select` with search for ≥ 12 options, `Checkbox`, inline `FieldError` with `aria-invalid` and `aria-describedby`, persistent error summary), `Button` (primary / secondary / quiet / destructive; pending state per action key), `Toast` (persistent `aria-live` region mounted once), `EmptyState`, `PageHeader` (sets `document.title`, receives focus on route change), `Rail`/`BottomNav`, `ErrorBoundary`. Tokens in `app/styles/tokens.css`; per-screen styles in `app/styles/<screen>.css`; `globals.css` shrinks to resets + tokens import.

## 6. Wave 4 — Screens and copy

- **Home** ("Your renewals"): all credentials as ledger rows sorted by urgency (overdue, due within 90 days, on track, no cycle), each with `CycleRing`, days to deadline, credits counted/required, and one next action; right column `DeadlineTimeline` + "Needs attention" check-ins (with Undo on snooze/dismiss, app-ux-08) + "Best next action". Gamification (levels, XP, quests, pace presets, sidebar coach) leaves Home and becomes a collapsed "Momentum" section on Account (app-ux-13). First-run state: a single guided "Add your first credential" card.
- **Credentials**: list with search and state filter; **Credential detail** with sections Plan (requirements with `CreditBar`s, conditional-rule answers), Activities (this credential's logged activities — app-ux-10), Checklist, Submission & acceptance, History (closed cycles), and Edit / Archive / Delete. A "Log activity for this credential" button pre-selects it.
- **Log activity**: two steps. Essentials (title, completion date defaulting to local today, credits, credentials/requirements, evidence drop zone) then optional details (provider, format, notes, allocator for NREMT/CRC). Save is always visible (sticky footer). Certificate OCR becomes a secondary "Scan a certificate" action that states the 4.5 MB one-time download (perf-07, app-ux-20).
- **Activity log** (was History): paginated table (50 per page, perf-M-02), filters by credential, date range, tag; CSV export here; archived credentials section.
- **Account** (was Profile): display name, email change (re-verify), password change, reminders (time zone auto-detected, quiet hours), install instructions, data export (full JSON + CSV + evidence zip — critic-06), Momentum, delete account (types email; deletes auth row, D1 rows by identity hash, R2 objects — architecture-M-03). Sign out.
- **Packet** re-themed in the new tokens; internal ids removed (app-ux-19).
- **Copy rules:** one verb for logging ("Log activity") everywhere (app-ux-12); no "Today" (app-ux-14); check-in titles ≤ 9 words; no "countable units" / "classification gaps" — say "credits that count" / "credits still needed"; functional screens have functional H1s; errors say what happened and what to do; server strings are never shown raw.

## 7. Wave 5 — Public funnel and ops floor

- **Landing** (`deploy/railway/pages/landing.html`, rebuilt in the same tokens as the app, dark mode supported): hero with the product thesis and a real Home screenshot; "Who it is for" (53 professions, six states named, 170 source-linked templates); "How it works" (add credential → log activity → renewal packet); trust (private evidence, source links with review dates, organizer-not-authority boundary, no ads, free); "What happens after you sign up"; footer with privacy, terms, support. AA contrast, `main` landmark, proper heading order, no emoji glyphs (a11y-10, landing-auth-11). Copy is written with the marketing-skills copywriting guidance and reviewed for the objective-tone rule.
- **Auth pages** rebuilt as one family with the app's form primitives (server-rendered HTML, no React), autofocus, show-password, password guidance (12+ characters, checked against a top-10k list), `autocomplete` attributes, persistent inline errors, return-to support, logged-in users redirected away from auth pages.
- **Privacy policy and terms** pages (landing-auth-10), linked from footer and signup consent line.
- **SEO** (landing-auth-04, infra-09): canonical, OG/Twitter meta, `SoftwareApplication` JSON-LD, `www` CNAME → apex with 301, the railway.app host 301s to itrackceu.com, `PUBLIC_BASE_URL` set.
- **Funnel logging** (landing-auth-M-07): one structured gateway log line per signup, verify, login, reset event (no PII beyond a hashed email) — no third-party analytics.
- **Ops floor** (infra-04/10/11/14/16, critic-02/03): nightly `deploy/railway/backup.mjs` (SQLite `.backup` of D1 + auth.db, tar of R2 directory, upload to an S3-compatible bucket Chris provisions; 30-day retention; documented restore rehearsed once), `/healthz` that runs a worker round-trip, external uptime monitor (Chris), per-user storage quota 250 MB with a clear in-app message, per-IP `/api` rate limit (600/min), GitHub Actions CI (typecheck, lint, test, Docker build) on PRs, Dependabot weekly, `npm audit` fixes with the runtime pinned, Dockerfile base image pinned, secrets passed to wrangler via env not argv (ios-coupling-M-04), CSP enforced.
- **Rule governance** (critic-05): `db/catalog/README.md` documents owner, review cadence (quarterly), per-template `lastVerifiedAt`, and a changelog; the chooser shows "verified <month year>".

## 8. Data, migrations, and identity

- D1 migrations continue in `drizzle/`; `0013_drop_apns.sql` (Wave 1). No identity change: workspace identity remains `sha256(email)` with the `license-lantern:` salt; the auth DB (`/data/auth.db`) remains the account store; a `users` row and an auth row are joined by that hash. Account deletion and email change (Wave 4) are the first operations that touch both stores; they are implemented as a gateway-orchestrated sequence (auth row → worker action `deleteWorkspace(identity)` → R2 prefix delete) with an idempotent retry.
- Chris's existing production data is under `christophertskerritt@gmail.com`; the bootstrap account uses the same email so nothing migrates.

## 9. Testing strategy

- Unit: node:test for gateway, auth, dates, navigation, extracted `app/lib/*` modules.
- Integration: built worker against real node:sqlite (seed, isolation, actions).
- E2E: Playwright against the dev server (demo identity) per screen, both colour schemes, 1440×900 and 390×844; axe on every route with zero serious/critical violations as a gate from Wave 3.
- Contrast: `tools/contrast-audit.mjs` across all stylesheets, zero literals outside token files.
- Deploy: Docker build + run-check locally before every merge; live smoke (curl matrix + Playwright login) after every deploy.

## 10. Chris-owned checklist

1. **Resend:** add domain itrackceu.com, create the DKIM/SPF records at Name.com, create an API key; set `RESEND_API_KEY`, `AUTH_EMAIL_FROM="iTrack <no-reply@itrackceu.com>"`, `PUBLIC_BASE_URL=https://itrackceu.com` on Railway (or hand the key to Claude to set).
2. **DMARC:** `_dmarc.itrackceu.com TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@itrackceu.com"`.
3. **Receiving mail:** Name.com email forwarding for support@ and dmarc@ → Gmail (adds MX records).
4. **www:** CNAME `www` → Railway custom domain target; add `www.itrackceu.com` as a Railway custom domain.
5. **Bootstrap password:** generate one, set `AUTH_BOOTSTRAP_USERS="christophertskerritt@gmail.com:<password>"` on Railway before the Wave 1 deploy (Claude can generate and set it; it is never written to a document).
6. **After Wave 1 is live:** confirm login works, then Claude deletes `ITRACK_USERS`, `ITRACK_WIDGET_TOKEN`, `APNS_*`; Chris revokes APNs key `U3F4W5JABK` in Apple Developer and archives the iTrack-iOS repo.
7. **Git history purge** of the committed password (already rotated 2026-09-10 10:35 EDT): rewrite `docs/superpowers/plans/2026-08-11-itrack-public-signup.md` history or accept that the rotated value is dead; recommendation: accept, since Basic auth is deleted in Wave 1 and the value no longer authenticates anything.
8. **Wave 5:** provision an S3-compatible bucket for backups; pick an uptime monitor; enable GitHub branch protection on main once CI exists.

## 11. Out of scope

Native apps of any kind; paid tiers; ads; Django or any backend port; multi-user organisations; new credential templates (catalog content changes are governance, not this program).
