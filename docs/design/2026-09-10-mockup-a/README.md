# Approved design direction — "A · The professional's ledger"

**Status:** APPROVED by Chris on 2026-09-15 ("proceed with track A"). This is the mockup gate for Wave 3 of
`docs/superpowers/specs/2026-09-10-itrack-web-redesign-design.md` (spec §2 row 3, §5).

The three artboards in this directory are the exported design-canvas sources of the approved mockup
(canvas: https://claude.ai/code/artifact/2796c074-02de-499a-8b0a-ffa5c66c2e5e). They are static HTML with
inline styles and Google-Fonts links; they are a *visual reference*, not code to ship. Alternates B ("bold and
kinetic") and C ("instrument panel") were rejected.

| File | Artboard | Size |
|---|---|---|
| `home-desktop.html` | Home · desktop | 1440 × 960 |
| `home-phone.html` | Home · phone | 390 × 844 |
| `landing.html` | Landing page (Wave 5 reference only) | 1440 × 1880 |

## What the mockup fixes (binding for Wave 3)

Values below are the spec §5.1 identity as drawn; where the mockup and the spec disagree the spec wins,
and the differences are noted.

- **Palette (light):** paper `#F5F2EA`, paper-deep `#EBE7DC` (rail, phone header), card `#FFFDF8`, ink `#1C1A17`,
  ink-muted `#5E5A52`, line `#DAD5C8`, accent `#2743B8` (hover `#1B2F86`), accent-soft `#E3E8FA`; semantic
  overdue `#B3261E`/`#FBE4E2`, due-soon `#8A5A00`/`#FBEFD3` (row edge `#E5C98A`), complete `#22694E`/`#DDF0E6`.
  Inverse surface (the "Best next action" card) is ink `#1C1A17` with paper text and muted `#C9C2B4`.
  Dark scheme values are in spec §5.1 and were not drawn; they follow the same tokens.
- **Type:** Bricolage Grotesque (display: page titles, hero numerals, ring labels, brand; 600–800, `-0.02em`),
  Atkinson Hyperlegible (body), IBM Plex Mono (dates, counts, ids; `tabular-nums`). Eyebrows are 11–12 px
  uppercase `0.08em` tracked, muted, bold.
- **Desktop shell:** 232 px rail on paper-deep with a 1 px line at its right edge; brand "iTrack" (blue "i")
  at 26 px 800; nav items Home / Credentials / Activity log / Account (18 px stroke icons, 14 px 700 labels,
  active item = card surface with an inset 1 px line); a primary "Log activity" button (44 px, plus icon);
  a dashed-border source note pinned to the bottom of the rail. Content column padded 36/44 px; page header =
  eyebrow (full date) + 40 px display H1 + one muted sentence, actions right ("Renewal packet" secondary,
  "Log activity" primary). Home content is a two-column ledger `minmax(0,1fr) 380px` with 28 px gaps.
- **Phone shell:** top app bar on paper-deep (eyebrow short date + 28 px display title, brand right, safe-area
  padding), bottom navigation on card with a 1 px top line: Home · Credentials · [52 px blue Log button] ·
  Activity · Account (22 px icons, 11 px labels). No push/pop transitions, no grabbers, no parked screens.
- **Instruments as drawn:** `CycleRing` 72 px desktop / 56 px phone / 40 px inline (stroke 7 / 6 / 5, track
  paper-deep, arc coloured by state, centre percentage in display face; complete state = full arc + check
  mark); `CreditBar` 6 px track with a 1 px minimum marker; `StatusPill` (Due soon / On track / Submitted /
  Overdue) in the semantic soft fill + ink pair; `DeadlineTimeline` = 12-month axis with quarter ticks, dashed
  "today" marker, one circle per credential deadline coloured by state, label + mono date above.
- **Buttons:** primary (accent fill, card text), secondary (card fill, line border), quiet (transparent,
  accent text); 40 px tall, 8 px radius, 14 px 700 labels. Cards 12 px radius, 1 px line.
- **Rows on Home** (Wave 4 content, shown here for the shell's sake): ring · name+pill+issuer+credit bar ·
  countdown numeral (40 px 800) with "days left" eyebrow and mono date · one action + one-line hint.

## Decisions taken with the approval (Fable, 2026-09-15)

1. Wave 3 builds the design system and the shell only (spec §2 row 3): tokens, self-hosted type, primitives,
   instruments, rail/bottom-nav shell, ordinary page routing, error/not-found routes, contrast + axe gates,
   screenshots. Screen content (Home ledger, Credentials, Log activity, Activity log, Account, packet) is
   Wave 4 and stays inside `app/ITrackApp.tsx`, rendering on the new tokens through a legacy-alias block
   until each screen is extracted.
2. Navigation labels change now (Home, Credentials, Activity log, Account; phone label "Activity"); URLs do not
   (`/`, `/credentials`, `/credentials/:id`, `/history`, `/profile` are the contract in `app/lib/navigation.ts`).
3. The rail's "Weekly rhythm" coach is removed with the rail rebuild; Momentum lands on Account in Wave 4
   (app-ux-13). The rail's bottom slot carries the source note from the mockup.
4. Fonts are self-hosted woff2 subsets under `public/fonts/` (latin subset, `font-display: swap`, preloaded,
   ≤ 40 kB per file); no Google Fonts request from the app.
5. No WebKit Playwright project this wave (single browser install stays); axe runs on every route in all four
   Chromium projects with zero serious/critical violations as the gate.
6. Motion is limited to the three spec moments; screen push/pop, sheet slide, press scale and edge-swipe are
   removed rather than restyled.
