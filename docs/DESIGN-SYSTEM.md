# iTrack Design System

The single source of truth is the two `:root` blocks at the top of `app/globals.css`:
the light block defines every token; the `@media (prefers-color-scheme: dark)` block
remaps the color tokens. **No color literal may appear anywhere else in the
stylesheet or in components** — this invariant is real today (verified by audit) and
is what makes dark mode a pure token remap with zero per-scheme component rules.

## Character

Calm forest green. Light mode is warm paper (`#f6f4ee`) with deep green ink; dark
mode keeps the same 168° hue family, running from a near-black green page
(`#0d1917`) up through elevated cards rather than flipping to neutral gray or pure
black. Serif display (Newsreader) over a Manrope UI voice; mint and sage carry
positive/progress meaning, amber carries attention, coral carries problems.

## Color architecture

Two tiers, both fully dual-scheme (121 dark overrides over 136 tokens):

**Tier 1 — brand surfaces and inks** (the original palette):

| token | role | light | dark |
|---|---|---|---|
| `--paper` | page | `#f6f4ee` | `#0d1917` |
| `--card` | raised card | `#fffefa` | `#1b2d2a` |
| `--white` | inputs/controls surface | `#ffffff` | `#253d38` |
| `--ink` | body text | `#15352f` | `#cedcd8` |
| `--ink-deep` | display text | `#102c27` | `#ecf1ef` |
| `--ink-label` … `--ink-placeholder` | muted-ink ladder | `#536762`–`#66766f` | `#c8d6d2`–`#a0b1ac` |
| `--sage` / `--mint` / `--amber` / `--coral` | accents | `#b9d9ca` `#8ad3b4` `#f3c76b` `#dd7c66` | `#51ab8a` `#8fdec1` `#e8cb86` `#da7b63` |
| `--line` / `--line-strong` | hairlines | `#dcded5` `#c8cdc2` | `#364b47` `#485f5a` |

**Tier 2 — role tokens** (added 2026-08 when all 296 stray literals were collapsed),
grouped by prefix:

- `--ink-surface*` — the brand-green *surfaces* (sidebar, hero, detail header, FAB).
  Dark in both schemes; in dark mode they are tuned to sit **above** the page
  (1.5–1.9:1 elevation) instead of below it. Never use `--ink` as a background.
- `--on-dark`, `--on-accent`, `--on-mark` — text sitting on dark surfaces, on
  mint/amber accent fills, and on solid marks respectively. Never hardcode white.
- `--wash-*`, `--chip-*`, `--highlight-*` — tinted panel and chip fills per family
  (sage/amber/coral/blue).
- `--track*`, `--edge-*` — progress-track beds and border colors, including the
  accent/amber/coral edge ramps.
- `--mark-*` — solid filled marks (checkboxes, progress fills, scan/celebration
  marks). In dark mode marks are *lighter* than their surface and carry
  `--on-mark` (dark) glyphs; in light they are deep fills with white glyphs.
- `--focus-ring*`, `--focus-glow*`, `--danger*`, `--accent-control` — interactive
  state colors.
- `--*-rgb` channel triples (`--card-rgb`, `--mint-rgb`, `--veil-rgb`, `--lift-rgb`,
  `--shade-rgb`, `--paper-rgb`, `--line-rgb`, `--wash-sage-rgb`) — used only as
  `rgb(var(--x) / α)` where translucency is intrinsic. `--veil-rgb` is deliberately
  the one color token with no dark override (it lifts surfaces that are dark in
  both schemes); a comment in the file explains it.

**Atmosphere:** the page glow and the six mint radial sheens are token-driven
(`--page-glow`, `--mint-rgb`), so gradients follow the scheme too.

## Contrast discipline

Every muted-ink token documents, in a comment beside its value, its computed WCAG
ratio on each surface it is approved for — **in both blocks**. These comments are
kept exactly accurate (audited to ±0.05, 58 claims light + dark). The floors:

- normal-size text ≥ 4.5:1 against the *composited* background — including
  translucent stacks and the brightest point of any gradient it can sit on;
- non-text marks, edges, and fills ≥ 3:1 against the lightest surface they sit on;
- consecutive elevation steps (page → card → wash → chip) ≥ 1.15:1.

When adding a color: pick the existing token whose surface family matches. If none
fits, add a token to **both** blocks, compute the ratios (WCAG relative luminance —
scripts pattern lives in tooling history), and write them into the comment. Never
introduce an ad-hoc value at a use site.

## Typography

Phone-first scale, all `font-size` via tokens (floor `--text-2xs`, one documented
exception: the 10px bottom-tab labels, carried by 20px icons):

`--text-2xs 12` · `--text-xs 13` · `--text-sm 14` · `--text-md 15` (body) ·
`--text-lg 17` · `--text-control 16` (editable values — the iOS zoom floor).
Newsreader serif display sizes sit outside the scale, declared per component.
Stats use `tabular-nums`.

## Geometry, depth, motion

- Radii: `--radius-sm 10` / `--radius-md 16` / `--radius-lg 24`; the brand mark's
  asymmetric corner (`11px 11px 11px 4px`) is its signature.
- Shadows: `--shadow-sm/md/lg`, green-tinted in light, deepened toward black in
  dark; one-off shadows use `rgb(var(--shade-rgb) / α)`.
- Touch: `--tap-min 44px`, `--tap-comfortable 48px` — enforced on every control.
- Press feedback: `--press-scale .98` over `--press-ease 180ms`; the
  reduced-motion block trades the scale for a dim by re-declaring the press tokens
  only (composes with the dark block without conflict).

## Scheme mechanics

- `html { color-scheme: light dark }` hands native controls, scrollbars and form
  widgets to the UA.
- `layout.tsx` ships media-scoped `themeColor` (`#163f36` light — historical brand
  green for browser chrome; `#0d1917` dark) and `colorScheme: "light dark"`.
- `manifest.ts` stays light-only by design (a manifest cannot answer
  `prefers-color-scheme`; it paints the install splash once).
- `public/offline.html` carries its own inline mirror of the token pair — its
  values must track globals; a comment there names the deliberate divergences.
- Icons are the inline `Icon` component (`stroke="currentColor"`), so they inherit
  every scheme for free. `ITrackApp.tsx` contains no color literals at all.

## Forced colors / high contrast

The `forced-colors: active` block opts out only three marks whose meaning is
color-carried and whose token pairs hold on both HC-light and HC-dark; everything
else — including the mobile add FAB, which is painted with system colors
(`ButtonText`/`ButtonFace`/`Canvas`) — defers to the user's theme.

## Tests

`tests/rendered-html.test.mjs` renders the real HTML/CSS and pins, among ~2,110
assertions: theme-color metas for both schemes, `color-scheme`, and
token-referencing rules. When a rule moves from a literal to a token, move the
assertion to pin the token.
