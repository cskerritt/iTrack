# Wave 3 gate screenshots

Captured 2026-09-16 by `tests/e2e/screenshots.spec.ts` (`WAVE3_SCREENSHOTS=1`) against the dev
server at the Wave 3 branch tip, demo identity, clock fixed at 2026-09-15 15:00
America/New_York, reduced motion, CSS pixels (`scale: "css"`). Four Playwright projects:
`desktop-light` / `desktop-dark` (1440×900) and `phone-light` / `phone-dark` (390×844,
iPhone 13 descriptor on Chromium).

| Surface | Route |
|---|---|
| home | `/` |
| credentials | `/credentials` |
| credential-detail | `/credentials/<demo id>` |
| activity-log | `/history` |
| account | `/profile` |
| not-found | `/nonexistent` |
| styleguide | `/styleguide` (dev only) |
| log-activity | `/` with the Log activity sheet open |

File names are `<surface>-<project>.png` — 32 files. These are the spec §2 finish-gate
evidence for Wave 3 (design system + shell) and the source material Wave 5's landing page
draws on. Re-capture with the dev server on :3100:

    WAVE3_SCREENSHOTS=1 E2E_BASE_URL=http://localhost:3100 npx playwright test tests/e2e/screenshots.spec.ts

`WAVE3_SCREENSHOTS=full` writes full-page shots for a local look; those are not committed.
