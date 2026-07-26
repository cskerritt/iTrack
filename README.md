# License Lantern

License Lantern is a cloud-based, phone-first companion for continuing
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

The catalog contains 119 current, source-linked templates across 26 profession
labels and 64 issuing bodies. Seventy-nine templates are state-specific across
California, Florida, New Jersey, New York, Pennsylvania, and Texas; the
remainder are United States-wide or global. A template can represent a
phase, tenure tier, or other variant of the same credential, so this count
does not mean every template is a distinct credential type. Templates model applicable minimums, nested
subrequirements, overlapping facets, and reporting caps where the source can
be represented safely. Conditional rules require an explicit answer for each
cycle. Users can search the catalog or create a custom credential, and the
product reminds them to confirm requirements with the issuing authority.

## Product boundary

License Lantern is an organizer, not an issuing authority. Rule templates
include official source links and review metadata, but current instructions
from the licensing board or certifying body control. Course eligibility,
official acceptance, and credential status are never inferred from a checked
box.

## Architecture

- Vinext App Router on Cloudflare Workers
- React 19 phone-first client experience
- Cloudflare D1 with versioned rule sets and user-owned lifecycle records
- private Cloudflare R2 evidence objects with owner-scoped metadata
- workspace/SIWC identity headers in production
- localhost-only demo identity for development
- Drizzle schema and generated migrations

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

## Next product phases

- a two-step mobile Quick Log with “save and add another” conference entry
- broader effective-dated profession/state rule research
- a repeatable catalog research/review pipeline with richer provenance
- evidence-bundle download and richer archive browsing
- richer offline capture, native mobile packaging, and regulator/provider integrations
