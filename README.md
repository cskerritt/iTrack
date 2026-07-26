# License Lantern

License Lantern is a cloud-based, phone-first companion for continuing
education and professional-license renewals. It turns requirements into a
clear plan, keeps completed learning distinct from renewal submission, and
rewards meaningful record-keeping without punitive daily streaks.

## What works today

- source-linked or custom credential setup
- cycle dates, renewal deadlines, total-credit requirements, minimums, and caps
- explicit conditional-rule answers with nested and overlapping requirements
- fast course, conference, and activity entry
- durable per-user records in Cloudflare D1
- private certificate/photo/PDF evidence in Cloudflare R2
- one learning activity reusable across eligible credentials
- multiple requirement tags without double-counting overall credit
- renewal checklist with reversible completion
- submission date and confirmation tracking
- regulator acceptance, read-only cycle history, and clean next-cycle rollover
- configurable in-app due-date and acceptance check-ins with snooze/dismiss
- activity CSV export
- weekly momentum, XP, and milestone badges
- responsive dashboard and installable web-app manifest
- server-derived ownership from authenticated workspace identity

The starter catalog contains 15 current, source-linked templates spanning
nursing, legal, accounting, engineering, project management, psychology, and
social work credentials. Templates model applicable minimums, nested
subrequirements, overlapping facets, and reporting caps where the source can
be represented safely. Conditional rules require an explicit answer for each
cycle. Users can search the catalog or create a custom credential, and the
product reminds them to confirm requirements with the issuing authority.

## Product boundary

License Lantern is an organizer, not a licensing authority. Rule templates
include official source links and review metadata, but the issuing board's
current instructions control. Course eligibility, regulator acceptance, and
license status are never inferred from a checked box.

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

- evidence review and OCR-assisted entry
- opt-in email and push reminder delivery
- broader effective-dated profession/state rule research
- packet-style PDF export and richer archive browsing
- native mobile packaging and regulator/provider integrations
