# iTrack Design System

The single source of truth is **`app/styles/tokens.css`**. Its first rule is `:root {` —
the light tokens, 71 first-class names; the `@media (prefers-color-scheme: dark)` block
restates the 39 colour tokens that change after dark; a `@media (prefers-reduced-motion:
reduce)` block zeroes the three motion durations; and a final `:root` — the **LEGACY
ALIASES** — maps every pre-Wave-3 token name (112 of them) onto the palette with `var()`
references only. A stylesheet is a *token file* iff its first rule, after any leading
`@import`/`@charset`, is `:root {`; `tokens.css` and the five gateway pages under
`deploy/railway/pages/` (each inlines its own `:root`) are the only ones. Every other
stylesheet is a *consumer*.

**No colour literal may appear outside a token file's `:root`/dark blocks** — not in
`app/globals.css` (imports + the reset), not in `app/styles/fonts.css`, `primitives.css`,
`instruments.css`, `shell.css`, `legacy-shared.css` or the six screen files (`home`,
`credentials`, `credential-detail`, `log-activity`, `history`, `account`), not in a
component (`app/**/*.tsx` paints SVG through CSS classes), not in a gateway page outside
its own `:root`. System colour keywords (`Canvas`, `ButtonText`, `Highlight` …) are
allowed only inside a file's own `@media (forced-colors: active)` block. This is enforced,
not asserted: `node tools/contrast-audit.mjs` walks every `.css` under `app/` and every
page's `<style>` blocks — 18 stylesheets today — re-derives every documented contrast
claim and fails on any hex, `rgb()` without `var(--`, named colour or stray system
colour; `tests/contrast-audit.test.mjs` runs it under `npm test`, pins `tokens.css` as
the only token file under `app/`, and fails any stylesheet outside the seven legacy
files that references a name from the alias block. It is what makes dark mode a pure
token remap with zero per-scheme component rules.

## Character

The professional's ledger: bone paper, ink, one fountain-pen blue, and instruments that
read at a glance. It is a website, on every device.

- **Paper.** The page is bone paper (`--paper #f5f2ea`); the rail and the phone app bar
  sit on a deeper paper (`--paper-deep #ebe7dc`); a card is warm near-white
  (`--card #fffdf8`). Cards are separated by a hairline (`--line #dad5c8`) and a 12 px
  radius, never by luminance.
- **Ink.** Body ink `--ink #1c1a17`; muted `--ink-muted #5e5a52` for secondary copy,
  eyebrows and hints.
- **One blue.** `--accent #2743b8` is text on every paper surface, the filled control
  (carrying `--on-accent` — the card in light, the paper in dark), the focus ring and the
  "on track" state; hover `--accent-hover #1b2f86`; soft fill `--accent-soft #e3e8fa`.
- **Semantic state, separate from the accent.** Overdue `--state-overdue #b3261e` on
  `--state-overdue-soft #fbe4e2`; due soon `--state-due-soon #8a5a00` on
  `--state-due-soon-soft #fbefd3`, with a decorative row edge `--edge-due-soon #e5c98a`;
  complete `--state-complete #22694e` on `--state-complete-soft #ddf0e6`; neutral
  `--state-neutral` (the muted ink) on `--state-neutral-soft` (the deep paper in light,
  the line colour after dark).
- **The inverse surface.** `--inverse-surface` is the other scheme's page — ink in light,
  paper in dark — carrying `--on-inverse`, `--on-inverse-muted` and
  `--accent-on-inverse`. The toast paints on it.
- **Instruments** read their trough from `--track` and their 1 px minimum marker from
  `--marker`.
- **Dark** is the same ledger after dark: paper `#15130f`, paper-deep `#0f0e0b`, card
  `#1f1c16`, ink `#ede8dc`, ink-muted `#a8a196`, line `#332f27`, accent `#93a6ff` (hover
  `#b4c1ff`, soft `#1e2750`), overdue `#f08a80` / `#3d1f1c`, due-soon `#e6b85c` /
  `#3a2a12`, complete `#7fcba4` / `#163326`.

No Times, no forest green, no system blue.

## Color architecture

One tier of first-class names, dual-scheme wherever colour is involved; every value sits
in `tokens.css` beside its ratio comment. This is the map.

| Family | Tokens | Purpose |
|---|---|---|
| Surfaces | `--paper`, `--paper-deep`, `--card` | the page; the rail and the phone app bar; a card |
| Inks | `--ink`, `--ink-muted` | body text; secondary text, eyebrows, hints, the neutral state |
| Lines | `--line`, `--line-strong` | the structural hairline (decorative, no claim); the text-input boundary, ≥ 3:1 on card and paper (a11y-05) |
| Accent | `--accent`, `--accent-hover`, `--accent-soft`, `--on-accent` | text, links, filled controls, the focus ring, "on track"; the hover fill; the soft fill; the label on an accent or destructive fill |
| Semantic state | `--state-overdue`, `--state-overdue-soft`, `--state-due-soon`, `--state-due-soon-soft`, `--state-complete`, `--state-complete-soft`, `--state-neutral`, `--state-neutral-soft` | a solid ink (pill text, ring arc, bar fill, timeline dot stroke) with its soft fill (pill and dot fill) |
| Due-soon edge | `--edge-due-soon` | the mockup's row edge; decorative only, never the sole signal |
| Instruments | `--track`, `--marker` | the unfilled trough of a ring or bar; the 1 px minimum/cap marker |
| Inverse | `--inverse-surface`, `--on-inverse`, `--on-inverse-muted`, `--accent-on-inverse` | the other scheme's page and the text and action colour on it (the toast) |
| Focus | `--focus-ring` | the one ring: `3px solid`, `outline-offset: 2px`, on everything focusable including form fields (a11y-06) |
| Channel triples | `--paper-rgb`, `--card-rgb`, `--ink-rgb`, `--accent-rgb`, `--line-rgb`, `--on-inverse-rgb`, `--lift-rgb`, `--shade-rgb` | used only as `rgb(var(--card-rgb) / a)` and friends, where translucency is intrinsic. `--lift-rgb` is the card surface in **both** schemes, never the ink: laid over a panel at an alpha it lightens light paper and reads as a card-coloured inset after dark, and every ink a consumer sets on a lift claims its ratio over it in both blocks |
| Scrim | `--scrim` | the modal backdrop |
| Shadows | `--shadow-sm`, `--shadow-md`, `--shadow-lg` | ink (light) or black (dark) at low alpha: the modal, the toast, a dragged card — sparingly |
| Radii | `--radius-sm` 8px, `--radius-md` 12px, `--radius-lg` 16px, `--radius-pill` | controls; cards; sheets and modals; pills |
| Type | `--font-display`, `--font-body`, `--font-mono`, `--tracking-display`, `--tracking-eyebrow` | see Typography |
| Scale | `--text-2xs` … `--text-4xl`, `--text-control` | see Typography |
| Controls | `--control-height` 40px, `--control-height-lg` 44px, `--control-height-sm` 32px, `--tap-min` 44px, `--tap-comfortable` 48px | button heights (default; touch or narrow; small); the tap floors |
| Shell | `--rail-width` 232px, `--content-max` 1120px, `--ledger-aside-width` 380px, `--bottom-nav-height` 77px | the rail; the content column (its content box — the padding sits outside); the Home ledger's right column (`minmax(0, 1fr) 380px`, 28 px gap — spec §5.1 Layout, mockup README "Desktop shell"), declared now and consumed in Wave 4 with the Home extraction; the phone bar's height above the safe-area inset, which the content and the toast clear — `.bottom-nav` in `shell.css` is authoritative (10 + 56 + 10 px + a 1 px hairline) and `tests/e2e/shell.spec.ts` checks the two agree |
| Motion | `--ease-out`, `--duration-fill` 400ms, `--duration-complete` 320ms, `--duration-fold` 360ms | see Geometry, depth, motion |

**LEGACY ALIASES.** The last `:root` in `tokens.css` maps every pre-Wave-3 name — the old
grey ladder, the graphite inverse family, the amber and coral ramps, the wash and chip
fills, the edge and mark ramps, the press and screen-transition timings, the old font
token — onto the palette above. Every value is a `var()` reference or an inert keyword,
so the block holds no literal and can carry no claim. It exists for one reason: the
screens still live inside `app/ITrackApp.tsx` on their old class names (mockup README,
decision 1). Who may reference an alias: `app/styles/legacy-shared.css`, `home.css`,
`credentials.css`, `credential-detail.css`, `log-activity.css`, `history.css`,
`account.css` — and nothing else. `fonts.css`, `primitives.css`, `instruments.css`,
`shell.css`, `globals.css` and every component reference first-class names only;
`tests/contrast-audit.test.mjs` ("no new stylesheet references a legacy alias") fails the
build otherwise. Wave 4 deletes the block with the last extracted screen. The Home hero
is the one place the aliases are re-scoped on an element: `home.css` sets the inverse-
family aliases on `.renewal-hero` to card and ink values so the instruments sit on a card,
where their state inks clear 3:1 (on the ink surface in light they measure 2.1–2.9:1).

## Contrast discipline

Every ink, state ink, mark and the focus ring documents, in a comment beside its value,
the WCAG ratio it holds against each surface it is approved for — **in both blocks**.
Those comments are a contract: `tools/contrast-audit.mjs` re-derives every claim from the
values in the file (93 today — 47 in the light block, 46 in dark) and fails if one has
drifted by more than 0.05 or dropped below its floor. Run it before committing a token
change; `npm test` runs it too.

The floors:

- text ≥ 4.5:1 against the *composited* background — a soft fill, or any
  `rgb(var(--lift-rgb) / a)`-style stack it sits on;
- large text, marks, edges and troughs ≥ 3:1 against the lightest surface they sit on —
  the ring arc and the bar fill on `--track`, the input boundary on `--card` and
  `--paper`, the focus ring on `--paper` and `--card`;
- **elevation is not used.** Light paper → card measures 1.10:1 and dark 1.09:1 by
  design (spec §5.1's values, kept). Cards separate by the `--line` hairline (1.28:1 on
  `--card` in dark) and a 12 px radius, never by luminance; no elevation claim is written
  anywhere.

The claim grammar is the tool's own (`tools/contrast-audit.mjs`, CLAIM GRAMMAR): one
claim per ratio, `<ratio>:1 on <surface>`, on a comment line that names its token first —
`--ink-muted  6.1:1 on --paper, 5.6:1 on --paper-deep, 6.8:1 on --card`. The surface may
be two tokens, `--card/--paper` (both checked); a composite, `--lift-rgb@0.8 over --card`
(the first laid over the second at that alpha — the form every ink that sits on a lift
claims, in both schemes) or a translucent token `over` another at its own alpha; a
trailing `(large …)`, `(glyph …)` or `(mark)` drops that one claim to the 3:1 floor —
`7.3:1 on --paper (mark)` is the focus ring, and a ring arc or bar fill claims
`on --track (mark)`. Otherwise the floor comes from the subject's name: `--mark-*`,
`--edge-*`, `--track*` and `--line*` are objects (3:1); a subject prefixed `ink-surface`
would be an elevation step (1.15:1 — no first-class token carries that prefix, and the
alias block yields no claims, so the rule is dormant); everything else is text (4.5:1).
That rule is why the input boundary is named `--line-strong` and why a ring or bar claim
ends in `(mark)`.

When adding a colour: pick the family whose surface it sits on; add the token to **both**
blocks with its ratio comment; run `node tools/contrast-audit.mjs` (`--json` prints every
measured ratio, for retuning the comments in bulk). Never introduce a value at a use
site; never add to the alias block.

## Typography

Three faces, self-hosted as latin woff2 subsets under `public/fonts/`, built by
`tools/fonts/build-fonts.sh` from google/fonts @6ce172f (all SIL OFL 1.1; the licence
texts `OFL-bricolage-grotesque.txt`, `OFL-atkinson-hyperlegible.txt`,
`OFL-ibm-plex-mono.txt` ship beside the files):

| Face | Token and use | Files under `public/fonts/` | Bytes |
|---|---|---|---|
| **Bricolage Grotesque** 700 / 800 — static instances, `wdth` 100, `opsz` pinned at 96 at every size (a live optical-size axis alone exceeds the budget; the mockup artboards drew the variable font at auto optical size, so 13–26 px display text differs from them — a text-cut instance is the Wave 4 follow-up if wanted) | `--font-display`: page titles, hero numerals, ring labels, the brand; `--tracking-display` −0.02em | `bricolage-grotesque-700-<hash8>.woff2` · `bricolage-grotesque-800-<hash8>.woff2` | 25,848 B · 25,244 B |
| **Atkinson Hyperlegible** 400 / 700 / 400 italic | `--font-body`: everything else; eyebrows are `--text-2xs` 700 uppercase with `--tracking-eyebrow` 0.08em | `atkinson-hyperlegible-400-<hash8>.woff2` · `atkinson-hyperlegible-700-<hash8>.woff2` · `atkinson-hyperlegible-400-italic-<hash8>.woff2` | 11,056 B · 11,156 B · 11,912 B |
| **iTrack Mono** 400 / 500 — IBM Plex Mono renamed: a subset is a Modified Version under the OFL and may not carry the Reserved Font Name "Plex" | `--font-mono`: dates, counts, ids, any column of digits (`font-variant-numeric: tabular-nums`) | `itrack-mono-400-<hash8>.woff2` · `itrack-mono-500-<hash8>.woff2` | 10,520 B · 10,516 B |

`<hash8>` is the first eight hex characters of the file's sha256, printed by the build
script; `app/lib/fonts.ts` (`FONT_FILES`, `FONT_PRELOADS`, `FONT_BUDGET_BYTES` = 40 × 1024)
carries the current names, and `tests/fonts.test.mjs` fails if `public/fonts/` and the
manifest disagree or a file is over budget.

The constraint is **no render-blocking font request**: the four first-paint faces (body
400/700, display 700/800) are preloaded from `app/layout.tsx`; every face is
`font-display: swap`; `app/styles/fonts.css` declares a metric-matched `local()` fallback
per family (`"Atkinson Hyperlegible Fallback"`, `"Bricolage Grotesque Fallback"`,
`"iTrack Mono Fallback"` — `size-adjust`, `ascent-override`, `descent-override`,
`line-gap-override` against Arial and Menlo) so the swap does not reflow (perf-08).
Nothing requests `fonts.googleapis.com` or `fonts.gstatic.com` (`tests/e2e/fonts.spec.ts`);
the build carries no font cache (`tests/dist-hygiene.test.mjs`); no rule sets
`font-optical-sizing` or `font-variation-settings` (the faces are static); `/fonts/*` is
served public and immutable (`public/_headers`, `deploy/railway/gateway.mjs`) and is not
precached by the service worker. Until Wave 4 rewrites the screens, one rule in
`legacy-shared.css` (LEGACY DISPLAY FACE) gives the legacy titles, numerals and the brand
the display face.

The scale is `rem` against the browser default — no root `font-size` is declared
(a11y-14): `--text-2xs` 0.75 (eyebrows, pills, bottom-nav labels — the old 10 px
tab-label exception is retired) · `--text-xs` 0.8125 · `--text-sm` 0.875 (labels,
buttons, nav) · `--text-md` 1 (body) · `--text-lg` 1.125 · `--text-xl` 1.375 (card
headings, modal titles) · `--text-2xl` 1.75 (phone page title) · `--text-3xl` 2.25
(desktop page title) · `--text-4xl` 3 (hero numerals). `--text-control: 16px` is the one
px in the system — the iOS zoom floor for editable values, consumed only through
`input, select, textarea { font-size: max(var(--text-control), 1em); }`.
`tests/app-source-guards.test.mjs` ("no font-size in px under app/**/*.css except the
documented --text-control floor") fails any other px size. Weights are not tokenised:
body 400/700, display 700/800, mono 400/500.

## Primitives

`app/components/`, each with its class contract in `app/styles/primitives.css`
(`shell.css` for the shell, `instruments.css` for the instruments), all on first-class
tokens. The dev-only `/styleguide` route (`app/styleguide/`; `notFound()` in production)
mounts the Button, Modal, Form, Toast, EmptyState and ErrorFallback primitives and the
four instruments in every state, under its own `PageHeader` and `data-app-root`; it is
where axe and the screenshot gate see the cases no real screen reaches yet (nested
dialogs, a focused error summary, every ring size and state).

- **Button** (`Button.tsx`, `app/lib/buttonClass.ts`) — `variant` primary | secondary
  (the default) | quiet | destructive, `size` md | sm, `pending`, `pendingLabel`, `icon`;
  `type` defaults to `"button"`. Classes `.btn .btn-primary .btn-secondary .btn-quiet
  .btn-destructive .btn-sm .btn-spinner`. 40 px (`--control-height`), 44 px on touch or
  at ≤ 820 px (`--control-height-lg`), 32 px small; 8 px radius; `--text-sm` 700 label.
  Pending is `aria-disabled="true" aria-busy="true"` plus a click guard — focus stays on
  the control while the write is in flight; native `disabled` is for a control that
  cannot act. No transform on hover or press. `buttonClassName(variant, size, extra)`
  dresses a `<Link>` in a server component (`app/not-found.tsx`). The legacy `.button*`
  family carries the same declarations in `legacy-shared.css` until Wave 4.
- **Modal / Sheet** (`Modal.tsx`, `app/lib/modalStack.ts`; `Sheet` is the same component)
  — `title`, `eyebrow?`, `onClose`, `size?` md | lg, `isDirty?`, `closeLabel?`. Portalled
  to `document.body`; `aria-labelledby` from `useId()`; a module-level modal stack marks
  every `[data-app-root]` element and every lower dialog's backdrop `inert` (never the
  toast region) and locks body scroll while anything is open; Tab cycles inside the
  dialog; Escape closes the top-most dialog only and honours `defaultPrevented` /
  `isComposing`; a pointer-down-and-click on the backdrop closes a clean form
  (`isDirty()` false, else a `FormData` snapshot of the dialog's first form); initial
  focus lands on `[data-autofocus]`, else the card; focus returns to the opener, captured
  before any child's `autoFocus` commits. Classes `.modal-backdrop .modal-card
  .modal-header .modal-eyebrow .modal-title .modal-body .modal-close`. Below 540 px the
  card is a bottom sheet: full width, 16 px top radius, no grabber, no drag, no slide.
  Every page root that must go inert carries `data-app-root`.
- **Form** (`Form.tsx`, `app/lib/selectFilter.ts`) — `Field` (`label`, `hint`, `error`,
  `optional`) wires `htmlFor`/`id`, `aria-describedby` (hint, then error) and
  `aria-invalid` into its control through context; `TextInput`; `DateInput` (ISO
  `YYYY-MM-DD` in and out, the mono face); `Select` (a native `<select>`; at ≥ 12 options
  — `SEARCHABLE_OPTION_COUNT` — a search input narrows it through `filterOptions`,
  groups preserved, the match count in a polite live region); `Checkbox` (a visible
  native input with `accent-color`, so forced colours draw it); `FieldError`;
  `ErrorSummary` (`role="alert"`, "Check the form" by default, focuses itself when its
  errors change, links to each field); `ModalError` (a shim over `ErrorSummary`). Classes
  `.field .field-label .field-optional .field-control .field-control-mono .field-hint
  .field-error .field-invalid .checkbox .checkbox-label .checkbox-description
  .select-search .select-search-count .error-summary .form-stack .form-grid
  .form-grid-three .form-actions`. Every field wears the `--line-strong` boundary and the
  global `--focus-ring`; a control given `autoFocus` also carries `data-autofocus`.
- **Toast** (`Toast.tsx`, `app/lib/toastQueue.ts`) — `ToastProvider` is mounted once in
  `app/layout.tsx`, outside every app root, and renders `.toast-region` from first paint:
  a polite `role="status"` slot and an assertive `role="alert"` slot (tone `error`).
  `useToast().show({ message, tone?, duration?, action? })` returns an id; a plain toast
  replaces a plain one and queues behind one that has an action; 6 s (`TOAST_DURATION`),
  10 s with an action (`TOAST_ACTION_DURATION`), `duration: 0` sticky; the timer pauses on
  pointer-enter and focus-in and resumes with the remaining time. The card (`.toast
  .toast-message .toast-action .toast-close`) paints on `--inverse-surface`; on the phone
  it sits `--bottom-nav-height` + 12 px above the bottom edge.
- **EmptyState** (`EmptyState.tsx`) — `title`, `body`, `action?`, `icon?`, `compact?`; a
  `section` named by its `h2` (`PageHeader` owns the page's `h1`), the action a primary
  `Button` (quiet when compact);
  `.empty-state[.empty-state-compact] .empty-state-mark .empty-state-text`; no default
  glyph (the legacy "L" mark is gone).
- **PageHeader** (`PageHeader.tsx`, `RouteAnnouncement.tsx`) — `eyebrow?`, `title`,
  `lede?`, `actions?`, `documentTitle?`; `.page-header .page-header-text .eyebrow
  .page-title .page-lede .page-header-brand .page-header-actions`. Sets `document.title`
  through `routeTitle()` from the route context (or `documentTitle` off-route) and moves
  focus to its `h1[tabindex="-1"]` after every navigation — never on first paint, so the
  skip link stays the first Tab stop. At ≤ 820 px it *is* the sticky paper-deep app bar,
  brand at right, lede hidden, actions wrapped beneath: one H1 per page.
- **Rail / BottomNav** (`Rail.tsx`, `BottomNav.tsx`, `NavItem.tsx`, `Brand.tsx`,
  `AppShell.tsx`) — both navs are `aria-label="Primary navigation"` and server-rendered;
  items are real links (`<a class="nav-item" href aria-current="page">`; a modified click
  is left to the browser); labels Home / Credentials / Activity log / Account, the phone
  shortening only "Activity" while keeping the full name as its accessible name
  (`TAB_LABELS`, `TAB_SHORT_LABELS` in `app/lib/routeTitle.ts`). The rail carries the
  brand (`.brand .brand-i`, sized by `.brand-rail` / `.brand-bar` — visible text, no
  `aria-label`), a `Button` "Log activity" (`.rail-log`) and the source note
  (`.rail-note`); the bottom nav a 52 px `button.bottom-nav-log[aria-label="Log
  activity"]`. `AppShell` = skip link + Rail + `main#main-content.app-main` + BottomNav.
- **ErrorBoundary** (`ErrorBoundary.tsx`) — `resetKey?`, `fallback?`; the routed screen
  is wrapped with `resetKey={buildPath(route)}` so a crashed screen keeps the rail and
  any navigation resets it. `ErrorFallback` (`title?`, `body?`) is
  `section.error-fallback[role="alert"]` with Reload / Copy details / Try again and a
  `<details>` "Technical details" holding the raw message; `app/error.tsx` renders it,
  `app/not-found.tsx` renders a PageHeader and a primary link inside
  `.app-main.app-main-solo`.
- **Instruments** (`app/components/instruments/`, geometry in `app/lib/instruments.ts`)
  — every instrument is `.instrument[data-state]` and reads two element-scoped
  properties `instruments.css` sets from the state, `--state-ink` / `--state-soft`
  (overdue, due-soon, complete and submitted → the semantic pairs; on-track → `--accent`
  / `--accent-soft`; none → `--state-neutral` / `--state-neutral-soft`). `CycleRing`
  (72 / 56 / 40 px, `RING_SIZES`; `role="progressbar"` with a numeric `aria-valuenow`;
  centre numeral in the display face; complete = soft track, full arc, check, no numeral),
  `CreditBar` (a 6 px trough on `--track`, fill in `--state-ink`, 1 px `--marker` minimum
  and cap marks; `data-overflow` only past a cap, painted in the overdue ink; an uncapped
  bar at or past required reads complete), `StatusPill`
  (`.status-pill[data-state][data-compact]`; every mounted pill — the check-in rows
  included — shows its state word (a11y-11); the compact 8 px dot keeps its text in the
  DOM as `.sr-only` and is a styleguide sample only this wave), `DeadlineTimeline` (a
  decorative SVG, 92 px tall and as wide as its card — every x is a percentage of the
  mockup's 340-unit plot, no `viewBox`, so labels and strokes stay 1:1 at any width —
  under `ul.deadline-timeline-list` of 44 px `button.deadline-timeline-hit` markers with
  `role="tooltip"` tips, each `li` carrying `data-state`, `data-r` and `data-edge`, and a
  caption; `today` is a prop, the app's local date). Labels come from `STATE_LABELS`
  (Overdue / Due soon / On track / Submitted / Renewed / No cycle).

## Geometry, depth, motion

- Radii: `--radius-sm` 8px controls, `--radius-md` 12px cards, `--radius-lg` 16px sheets
  and modals, `--radius-pill`.
- Shadows: `--shadow-sm`, `--shadow-md`, `--shadow-lg` — ink at low alpha in light,
  black in dark; the modal, the toast and a dragged card, nothing else. A one-off
  translucency is `rgb(var(--shade-rgb) / a)` or `rgb(var(--lift-rgb) / a)`, never a
  literal.
- Touch: `--tap-min` 44px on every control and every timeline marker; `--tap-comfortable`
  48px on form fields; buttons drop to 40 px only with a fine pointer at desktop widths.
- **Motion is three moments, and nothing else moves.** (1) A credit bar filling to its
  new value: `.credit-bar-fill { transition: width var(--duration-fill) var(--ease-out) }`
  (400 ms). (2) A ring segment completing, then its check drawing: the arc eases
  `stroke-dasharray` over `--duration-fill`, and `cycle-ring-check-draw` runs for
  `--duration-complete` (320 ms) after that same delay — only when the value crosses 1
  after mount (`data-motion="complete"`), never on first paint. (3) A card folding to the
  ledger row when a cycle closes — `--duration-fold` (360 ms), consumed in Wave 4. No
  motion duration literal appears outside `tokens.css` in a new stylesheet or component:
  the two instrument moments read the tokens, and the only other animation in the system
  is the Button pending spinner (`spin`, 0.7 s, hidden under reduced motion). The
  un-extracted screens keep their pre-Wave-3 transitions in `legacy-shared.css` and
  `log-activity.css` (the level and quest track fills and the capture-progress fill at
  180 ms, the archived-items chevron at 160 ms, the loading shimmer at 1.8 s, the legacy
  `.action-spinner`) until Wave 4 rewrites them. Everything else is instant: no press
  scale, no hover lift, no sheet slide, no scrim fade, no screen push, no edge-swipe or
  drag-dismiss gesture (mockup README, decision 6). `prefers-reduced-motion` zeroes the
  three durations in `tokens.css`, `globals.css` clamps every animation and transition to
  0.01 ms, `instruments.css` sets the two moments to `none` at their own specificity (and
  honours a `reducedMotion` prop the same way), and the check keyframes carry their own
  start value so a frozen animation still leaves the check visible.

## Layout and shell

- Desktop (> 820 px): `.app-shell` is a two-column grid — a sticky 232 px rail (`.rail`,
  `--rail-width`) on `--paper-deep` with a 1 px `--line` at its right edge, padded
  28 px 20 px, holding the brand, the four links, "Log activity" and the source note;
  then `main.app-main`, a column whose content box is at most `--content-max` (1120 px —
  `box-sizing: content-box`, the padding outside it), padded 36 px 44 px 48 px.
- Home's own two-column ledger — `minmax(0, 1fr) var(--ledger-aside-width)` (380 px) with a
  28 px gap: credentials column, timeline + next-actions column (spec §5.1 Layout, mockup
  README "Desktop shell") — is Wave 4's, with the Home extraction (decision 1). Until then
  the "Next twelve months" card sits full-width under the hero.
- Phone (≤ 820 px): the rail is gone; `PageHeader` is the sticky paper-deep app bar;
  `.bottom-nav` is fixed on `--card` with a 1 px top line — Home · Credentials · the 52 px
  accent Log button · Activity · Account, 22 px icons with `--text-2xs` labels;
  `.app-main` pads its bottom by `--bottom-nav-height` + 24 px + the safe-area inset,
  and the toast region sits above the bar by the same token + 12 px. Every
  `env(safe-area-inset-*)` use is kept.
- Navigation is ordinary routing (`app/lib/useNavigation.ts`): `route`, `navigations`,
  `setTab(tab, { replace? })`, `openCredential(id, { replace? })`, `back()`,
  `scrubQuery()` over `pushState` / `replaceState` / `popstate`; a navigation to a URL
  that no longer resolves replaces, so Back never lands on a dead entry; re-tapping the
  active tab scrolls to the top and pushes nothing; `history.scrollRestoration =
  "manual"` with a per-path scroll memory restored on popstate (`behavior: "instant"`);
  the `navigations` counter (0 after the mount-time adopt) is what `PageHeader` reads to
  focus its heading. No parked screen, no pushed screen, no depth or origin-tab history
  state. URLs are unchanged — `/`, `/credentials`, `/credentials/:id`, `/history`,
  `/profile` (`parseRoute` / `buildPath` in `app/lib/navigation.ts`). History is written
  only by `useNavigation` (`tests/app-source-guards.test.mjs`).

## Scheme mechanics

- `html { color-scheme: light dark }` hands native controls, scrollbars and form widgets
  to the UA.
- `app/layout.tsx` ships media-scoped `themeColor` — `#ebe7dc` light / `#0f0e0b` dark,
  `--paper-deep`, the surface under the phone status bar — and `colorScheme: "light
  dark"`; `tests/rendered-html.test.mjs` pins both.
- `app/manifest.ts` is light-only by design: `background_color #f5f2ea` (the page,
  painted once for the splash) and `theme_color #ebe7dc` (the app bar).
- `public/offline.html` carries an inline mirror of only the tokens it paints (paper,
  card, line, ink, ink-muted, the inverse surface and its inks, one shadow) in both
  schemes, flat — no haze, no alpha — and keeps the system font stack: the woff2 files
  are HTTP-cached (immutable), not precached by `public/sw.js`.
- The gateway pages under `deploy/railway/pages/` keep their own inline `:root` mirrors
  (0 claims) until Wave 5 rebuilds the funnel.
- Icons are the inline `Icon` component (`app/components/Icon.tsx`,
  `stroke="currentColor"`), so they inherit every scheme; instrument SVGs take `stroke`
  and `fill` from CSS classes. No TSX carries a colour literal.

## Forced colors / high contrast

Each consumer that paints a colour-carried meaning owns a `@media (forced-colors: active)`
block; the audit allows system colour keywords there and nowhere else. `instruments.css`:
the ring arc and bar fill are `Highlight` with `forced-color-adjust: none`, the trough
`ButtonFace`, the compact pill dot `Highlight`. `shell.css`: the bottom-nav Log button is
a `ButtonText` fill with a `ButtonFace` glyph, and the active nav item keeps a `Highlight`
outline. `legacy-shared.css`: the legacy custom check rows (`.custom-check`,
`.requirement-check`, the segmented, check-grid and condition spans) are `Canvas` /
`CanvasText` with a `ButtonText` border when unchecked, `Highlight` / `HighlightText`
when checked, and the check glyph is hidden while unchecked. The `Checkbox` primitive
needs no rule: it is a native input. `tokens.css` carries no forced-colours block
(`tests/contrast-audit.test.mjs` pins that). `tests/e2e/forced-colors.spec.ts` proves a
checked and an unchecked row differ and a ring's arc still reads against its track.

## Tests

Build-free, from the repo root with Node 22:

- `node tools/contrast-audit.mjs` — every claim holds, no literal outside `tokens.css`
  (`--list` prints the passing claims, `--json` the measurements, a path argument audits
  one file).
- `node --experimental-sqlite --test tests/contrast-audit.test.mjs` — `tokens.css` is the
  only token file under `app/`, every other stylesheet is a literal-free consumer, no new
  stylesheet references an alias.
- `node --experimental-sqlite --test tests/app-source-guards.test.mjs` — the rem scale (no
  px `font-size` but `--text-control`), no screen stack, history written only by
  `useNavigation`, `document.title` from `routeTitle()`, the modal-site count, no test
  reads `app/styles/` or `app/components/` as text.
- `node --experimental-sqlite --test tests/fonts.test.mjs` (after `npm run build:lib-test`)
  — the seven faces, the budget, the licences, the four preloads.

Under `npm test` (a full build first): `tests/dist-hygiene.test.mjs` (the built CSS
self-hosts every face, requests nothing from Google, carries no px `font-size`;
`dist/client/fonts/` matches `public/fonts/`) and `tests/rendered-html.test.mjs` (the
theme-colour metas, the four preloads, the brand and nav labels, the 404, the styleguide's
production 404).

Playwright, four projects (`desktop-light` and `desktop-dark` at 1440×900; `phone-dark`
and `phone-light` at 390×844), against the dev server on 3100
(`E2E_BASE_URL=http://localhost:3100 npm run dev -- --port 3100`, then
`E2E_BASE_URL=http://localhost:3100 npm run test:e2e`): `axe.spec.ts` (zero serious or
critical violations on `/`, `/credentials`, `/credentials/:id`, `/history`, `/profile`,
`/nonexistent`, `/styleguide`, the Log activity sheet and the load-failure state),
`reflow.spec.ts` (nothing scrolls sideways at 320 px), `forced-colors.spec.ts`,
`fonts.spec.ts`, `shell.spec.ts`, `primitives.spec.ts`, `toast.spec.ts`,
`instruments.spec.ts`, `error-surfaces.spec.ts`, plus the screen specs.
`WAVE3_SCREENSHOTS=1 E2E_BASE_URL=http://localhost:3100 npx playwright test
tests/e2e/screenshots.spec.ts` writes the 32 gate screenshots under `docs/design/wave3/`;
`WAVE3_PARITY=1 E2E_BASE_URL=http://localhost:3100 npx playwright test
tests/e2e/parity.spec.ts` compares against local baselines taken on a parent commit
(never committed).

Before a merge, the Docker run-check: `B=http://localhost:8080 OPS_PASSWORD=… bash
deploy/railway/runcheck.sh all` (matrix 46 · seed 4 · actions 22 · all 68), then the
unauthenticated Playwright live smoke against the same container:
`LIVE_BASE_URL=http://localhost:8080 npx playwright test --config playwright.live.config.ts`
(`tests/live/live-smoke.spec.ts`: the login form, the generic bad-credentials answer, the
landing at `/`, `/credentials` → `/login?next=%2Fcredentials`; its own config, no dev
server, never part of `npm run test:e2e`). After a deploy: the same two with
`B=https://itrackceu.com` / `LIVE_BASE_URL=https://itrackceu.com` — never `actions` or
`seed` against production.
