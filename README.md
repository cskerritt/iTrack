# License Lantern

License Lantern is a cloud-based, phone-first companion for continuing
education and professional-license renewals. It turns requirements into a
clear plan, keeps completed learning distinct from renewal submission, and
rewards meaningful record-keeping without punitive daily streaks.

## What works today

- source-linked or custom credential setup
- cycle dates, renewal deadlines, total-credit and category minimums
- fast course, conference, and activity entry
- durable per-user records in Cloudflare D1
- renewal checklist with reversible completion
- submission date and confirmation tracking
- activity CSV export
- weekly momentum, XP, and milestone badges
- responsive dashboard and installable web-app manifest
- server-derived ownership from authenticated workspace identity

The starter catalog contains a small, current, source-linked set of rules for
representative nursing, legal, accounting, engineering, psychology, and social
work credentials. Templates with conditions are labeled accordingly. Users can
always create a custom credential, and the product reminds them to confirm
requirements with the issuing authority.

## Product boundary

License Lantern is an organizer, not a licensing authority. Rule templates
include official source links and review metadata, but the issuing board's
current instructions control. Course eligibility, regulator acceptance, and
license status are never inferred from a checked box.

## Architecture

- Vinext App Router on Cloudflare Workers
- React 19 phone-first client experience
- Cloudflare D1 with versioned rule sets and user-owned records
- workspace/SIWC identity headers in production
- localhost-only demo identity for development
- Drizzle schema and generated migrations

Structured activities and allocations are separate from renewal submissions.
This preserves the difference between learning completed, credit documented,
renewal submitted, and renewal accepted.

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

- certificate/photo/PDF uploads backed by R2
- evidence review and OCR-assisted entry
- notifications and renewal reminders
- multi-credential allocation for one activity
- broader effective-dated profession/state rule research
- packet-style PDF export and prior-cycle archive
- native mobile packaging and regulator/provider integrations
