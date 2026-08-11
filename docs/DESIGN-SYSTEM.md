# iTrack Design System

The single source of truth is the two `:root` blocks at the top of `app/globals.css`:
the light block defines every token; the `@media (prefers-color-scheme: dark)` block
remaps the color tokens. **No color literal may appear anywhere else in the
stylesheet or in components** — this invariant is enforced, not just asserted:
`node tools/contrast-audit.mjs` fails on any hex, `rgb()`, or named color outside
those two blocks. It is what makes dark mode a pure token remap with zero
per-scheme component rules.

## Character

The platform's, not a bespoke one. The page is a system grey group (`#f2f2f7`)
with cards lifted to plain white; the ink is a near-neutral rather than a hue;
the one saturated color is the system blue. Dark mode drops to a true near-black
(`#0b0b0e`) with no tint at all — a tinted near-black is the thing that reads as
"a website in dark mode" next to the platform's own — and the surfaces rise off it
in small steps. Type is the system stack, so on an iPhone it is San Francisco.
There is no webfont and no serif: display sizes are the same face carried by
weight and tracking.

Blue carries progress and choice, amber carries attention, coral carries
problems. The inverse surfaces (sidebar, hero, detail header, toast) are
graphite in both schemes.

## Color architecture

Two tiers, both fully dual-scheme (142 tokens in the light block, 122 restated
in dark).

**Tier 1 — brand surfaces and inks:**

| token | role | light | dark |
|---|---|---|---|
| `--paper` | page | `#f2f2f7` | `#0b0b0e` |
| `--card` | raised card | `#ffffff` | `#1c1c1e` |
| `--white` | inputs/controls surface | `#ffffff` | `#2c2c2e` |
| `--ink` | body text | `#1d1d21` | `#e5e5ea` |
| `--ink-deep` | display text | `#000000` | `#f5f5f7` |
| `--ink-label` … `--ink-placeholder` | muted-ink ladder | `#4b4b53`–`#6b6b74` | `#c7c7cf`–`#9d9da6` |
| `--tint` / `--accent` | soft blue fill / system blue | `#cfe3f9` `#007aff` | `#1e3a5c` `#0a84ff` |
| `--amber` / `--coral` | attention / problem | `#e8a013` `#e5484d` | `#ffd60a` `#ff453a` |
| `--line` / `--line-strong` | hairlines | `#e3e3e8` `#cdcdd4` | `#2c2c30` `#3d3d44` |

**Tier 2 — role tokens**, grouped by prefix:

- `--ink-surface*` — the graphite *surfaces* (sidebar, hero, detail header, FAB).
  Dark in both schemes; in dark mode they are tuned to sit **above** the page
  (1.31:1) instead of below it. Never use `--ink` as a background.
- `--on-dark`, `--on-accent`, `--on-mark` — text sitting on the inverse surfaces,
  on a filled accent control, and inside a solid mark respectively. Never
  hardcode white.
- `--accent-bright` — the accent as it reads *on* an inverse surface. Flat
  `--accent` is only 4.0:1 on graphite, so kickers and pill labels take this
  instead. It is the same value in both schemes, because the surfaces it sits on
  do not flip either.
- `--accent-control`, `--accent-control-hover` — the accent as a *filled control*:
  the system blue deepened until `--on-accent` clears AA on it. Every filled
  accent button uses these; only the 23px brand mark keeps flat `--accent`, where
  the large-text 3:1 floor applies.
- `--wash-*`, `--chip-*`, `--highlight-*` — tinted panel and chip fills per family
  (neutral/accent/amber/coral).
- `--track*`, `--edge-*` — progress-track beds and border colors, including the
  accent/amber/coral edge ramps.
- `--mark-*` — solid filled marks (checkboxes, progress fills, scan/celebration
  marks). In dark mode marks are *lighter* than their surface and carry
  `--on-mark` (dark) glyphs; in light they are deep fills with white glyphs.
- `--focus-ring*`, `--focus-glow*`, `--danger*` — interactive state colors.
- `--*-rgb` channel triples (`--card-rgb`, `--accent-rgb`, `--veil-rgb`,
  `--lift-rgb`, `--shade-rgb`, `--paper-rgb`, `--line-rgb`, `--wash-tint-rgb`) —
  used only as `rgb(var(--x) / α)` where translucency is intrinsic. `--veil-rgb`
  is deliberately the one color token with no dark override (it lifts surfaces
  that are dark in both schemes); a comment in the file explains it.

**Atmosphere:** the page glow and the accent radial sheens are token-driven
(`--page-glow`, `--accent-rgb`), so the haze follows the scheme and needs no
retuning when the accent moves.

**Historical names.** Two groups carry a suffix from the palette this one
replaced. `--sage`/`--mint` became `--tint`/`--accent`; the `*-sage` role tokens
became `*-tint` (`--ink-tint`, `--mark-tint`, `--chip-tint`, `--track-tint`,
`--edge-tint`) and the two rgba accent tints became `--tint-accent` and
`--ring-accent`. There is no green anywhere in the system.

## Contrast discipline

Every muted-ink token, accent ink and solid mark documents, in a comment beside
its value, its computed WCAG ratio on each surface it is approved for — **in both
blocks**. Those comments are a contract, not a note: `tools/contrast-audit.mjs`
re-derives all 92 of them from the token values in the file and fails if any has
drifted by more than 0.05 or dropped below its floor. Run it before committing a
token change.

The floors:

- normal-size text ≥ 4.5:1 against the *composited* background — including
  translucent stacks and the brightest point of any gradient it can sit on
  (the hero sheen peaks at `--accent-rgb` 0.17, which is what the on-dark inks
  are measured against);
- large text (≥ 24px, or ≥ 18.66px bold) and non-text marks, edges, fills and
  glyphs ≥ 3:1 against the lightest surface they sit on;
- consecutive elevation steps ≥ 1.15:1 **in the dark scheme**, where luminance is
  the only thing separating one surface from the next: page → card 1.16, card →
  wash 1.33, wash → chip 1.34, page → `--ink-surface` 1.31.

The light scheme does not meet that elevation floor and never has (it was
1.09 page → card under the old palette and is 1.12 now): near-white surfaces
separated by that much would stop being near-white. Light-mode cards are
separated the way the platform's own grouped lists are — a `--line` hairline and
a corner radius — and the measured steps are page → card 1.12, card → wash 1.07,
wash → chip 1.07, card → chip 1.15. Text and marks still answer to the full 4.5
and 3.0 floors on every one of those surfaces.

The audit understands a claim written as `4.8:1 on --chip`, `5.6:1 on
--card/--white`, `4.7:1 on --tint-amber over --highlight-amber`, or
`4.6:1 on --accent-rgb@0.17 over --ink-surface`; a trailing `(large …)` or
`(glyph …)` drops that one claim to the 3:1 floor. The floor for everything else
is inferred from the subject: inks and `--on-*` are text, `--mark-*`/`--edge-*`/
`--track-*` are objects, `--ink-surface*` is an elevation step.

When adding a color: pick the existing token whose surface family matches. If none
fits, add a token to **both** blocks, write the ratio comment, and run the audit.
Never introduce an ad-hoc value at a use site.

## Typography

One family for everything — `--font-ui`, the system stack, which resolves to San
Francisco on the phone. A downloaded display face is the loudest tell that a
Capacitor shell is a website, and it costs a render-blocking round trip on the
first paint the app shows.

Phone-first scale, all `font-size` via tokens (floor `--text-2xs`, one documented
exception: the 10px bottom-tab labels, carried by 20px icons):

`--text-2xs 12` · `--text-xs 13` · `--text-sm 14` · `--text-md 15` (body) ·
`--text-lg 17` · `--text-control 16` (editable values — the iOS zoom floor).
Display sizes sit outside the scale and are declared per component: same family,
600 weight, `-0.02em` tracking or tighter. Stats use `tabular-nums`.

## Geometry, depth, motion

- Radii: `--radius-sm 10` / `--radius-md 16` / `--radius-lg 24`; the brand mark's
  asymmetric corner (`11px 11px 11px 4px`) is its signature.
- Shadows: `--shadow-sm/md/lg`, graphite in light, deepened toward black in
  dark; one-off shadows use `rgb(var(--shade-rgb) / α)`.
- Touch: `--tap-min 44px`, `--tap-comfortable 48px` — enforced on every control.
- Press feedback: `--press-scale .98` over `--press-ease 180ms`; the
  reduced-motion block trades the scale for a dim by re-declaring the press tokens
  only (composes with the dark block without conflict).
- Screen transitions: `--screen-ease` (the platform push curve), `--screen-push
  340ms`, `--screen-pop 300ms`, `--screen-bleed 12px`. See the SCREEN STACK
  section of `globals.css` for how the pushed screen, the parked root and the
  edge-swipe drag share them.

## Scheme mechanics

- `html { color-scheme: light dark }` hands native controls, scrollbars and form
  widgets to the UA.
- `layout.tsx` ships media-scoped `themeColor` (`#f2f2f7` light / `#0b0b0e` dark)
  and `colorScheme: "light dark"`.
- `manifest.ts` stays light-only by design (a manifest cannot answer
  `prefers-color-scheme`; it paints the install splash once).
- `public/offline.html` carries its own inline mirror of the token pair — its
  values must track globals; a comment there names the deliberate divergences
  (`--card` at 0.92, and `--glow` as `--page-glow` pre-composited over `--paper`,
  because a gradient stop there cannot carry an alpha of its own).
- Icons are the inline `Icon` component (`stroke="currentColor"`), so they inherit
  every scheme for free. `ITrackApp.tsx` contains no color literals at all.

## Forced colors / high contrast

The `forced-colors: active` block opts out only three marks whose meaning is
color-carried and whose token pairs hold on both HC-light and HC-dark; everything
else — including the mobile add FAB, which is painted with system colors
(`ButtonText`/`ButtonFace`/`Canvas`) — defers to the user's theme. The audit
allows system color keywords inside that block and nowhere else.

## Tests

`tests/rendered-html.test.mjs` renders the real HTML/CSS and pins, among ~2,110
assertions: theme-color metas for both schemes, `color-scheme`, and
token-referencing rules. When a rule moves from a literal to a token, move the
assertion to pin the token. `tools/contrast-audit.mjs` is the separate gate for
the token values themselves.
