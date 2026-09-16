# iTrack

iTrack is a cloud-based, phone-first companion for continuing
education and renewals of professional licenses or certifications. It turns
requirements into a clear plan, keeps completed learning distinct from renewal
submission, and rewards meaningful record-keeping without punitive daily
streaks.

## What works today

- source-linked or custom credential setup
- cycle dates, renewal deadlines, total-credit requirements, minimums, and caps
- explicit conditional-rule answers with nested and overlapping requirements
- fast course, conference, and activity entry
- private, on-device certificate photo scanning with reviewable field suggestions
- durable per-user records in Cloudflare D1
- private certificate/photo/PDF evidence in Cloudflare R2
- one learning activity reusable across eligible credentials
- multiple requirement tags without double-counting overall credit
- renewal checklist with reversible completion
- submission date and confirmation tracking
- regulator acceptance, read-only cycle history, and clean next-cycle rollover
- configurable in-app due-date and acceptance check-ins with snooze/dismiss
- one-tap calendar handoff for renewal dates and timely check-ins
- activity CSV export
- owner-scoped, print-ready credential-cycle packets with exact requirement balances,
  counted activity tags, checklist and lifecycle history, and a private
  evidence inventory
- durable levels, weekly quests, gentle one-week-grace momentum, XP, and badges
- a user-selected weekly rhythm whose goal and time zone stay fixed for the active week
- installable phone companion with a privacy-safe offline fallback
- account-scoped, text-only activity drafts that recover in the same browser
- opt-in private web-push reminders with per-device controls
- responsive dashboard with home-screen and standalone-app support
- server-derived ownership from authenticated workspace identity
- zero-credit dental checkpoints with evidence references that never inflate CE totals
- source-linked CRC plus ABVE Fellow and Diplomate certification plans, including exact CRC credit splits and ABVE annual checkpoints
- source-linked healthcare, finance, accounting, securities, safety, quality,
  supply-chain, privacy, coaching, and allied-profession certification plans

The catalog contains 170 current, source-linked templates across 53 profession
labels and 98 issuing bodies. Seventy-nine templates are state-specific across
California, Florida, New Jersey, New York, Pennsylvania, and Texas; the
remainder are United States-wide, global, or scoped to an adopting
jurisdiction. A template can represent a phase, tenure tier, renewal path, or
other variant of the same credential, so this count does not mean every
template is a distinct credential type. Templates model applicable minimums,
nested subrequirements, overlapping facets, and reporting caps where the source
can be represented safely. Conditional rules require an explicit answer for
each cycle. Users can search the catalog or create a custom credential, and the
product reminds them to confirm requirements with the issuing authority.

## Product boundary

iTrack is an organizer, not an issuing authority. Rule templates
include official source links and review metadata, but current instructions
from the licensing board or certifying body control. Course eligibility,
official acceptance, and credential status are never inferred from a checked
box.

## Architecture

- Vinext App Router on Cloudflare Workers runtime (workerd)
- React 19 phone-first client experience
- Cloudflare D1 with versioned rule sets and user-owned lifecycle records
- private Cloudflare R2 evidence objects with owner-scoped metadata
- trusted `oai-authenticated-user-*` identity headers injected by the
  deployment's auth proxy in production
- localhost-only demo identity for development
- Drizzle schema and generated migrations

## Deployment

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

Structured activities and allocations are separate from renewal submissions.
This preserves the difference between learning completed, credit documented,
renewal submitted, and renewal accepted. Closing a cycle creates a fresh next
cycle without copying completed education, submissions, or checked tasks.

## Local development

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm run lint
npm test
```

Generate a migration after changing `db/schema.ts`:

```bash
npm run db:generate
```

Node.js `>=22.13.0` is required.

### Design system

[`docs/DESIGN-SYSTEM.md`](docs/DESIGN-SYSTEM.md) is the reference: the token file (`app/styles/tokens.css`), the three self-hosted faces, the primitives and instruments, the three motion moments, and every gate. The checks it names, from the repo root with Node 22:

```bash
node tools/contrast-audit.mjs                 # every stylesheet: claims hold, no colour literal outside app/styles/tokens.css
tools/fonts/build-fonts.sh                    # rebuild the faces under public/fonts/; paste the printed names into app/lib/fonts.ts and app/styles/fonts.css
E2E_BASE_URL=http://localhost:3100 npm run dev -- --port 3100   # then open http://localhost:3100/styleguide (dev only: every primitive and instrument in every state)
E2E_BASE_URL=http://localhost:3100 npm run test:e2e             # four projects; axe on every route, zero serious/critical
WAVE3_SCREENSHOTS=1 E2E_BASE_URL=http://localhost:3100 npx playwright test tests/e2e/screenshots.spec.ts   # the gate screenshots under docs/design/wave3/
B=http://localhost:8080 OPS_PASSWORD=… bash deploy/railway/runcheck.sh all    # the Docker run-check (matrix 46 · seed 4 · actions 22 · all 68)
B=https://itrackceu.com bash deploy/railway/runcheck.sh matrix                # live smoke, curl half; never `actions` or `seed` against production
LIVE_BASE_URL=https://itrackceu.com npx playwright test --config playwright.live.config.ts   # live smoke, Playwright half (unauthenticated: login form, generic error, landing, /login?next=)
```

## Next product phases

- a two-step mobile Quick Log with “save and add another” conference entry
- broader effective-dated profession/state rule research
- a repeatable catalog research/review pipeline with richer provenance
- evidence-bundle download and richer archive browsing
- richer offline capture and regulator/provider integrations
