# iTrack iOS-Native Navigation + Re-theme — Design

**Date:** 2026-08-11
**Status:** Approved by Chris (approach + design outline approved in session)

## Problem

The iPhone app (Capacitor shell over this web app) feels like a website, not an app.
Chris identified four navigation problems — all four apply:

1. **Feels like a website** — no native transitions, no swipe-back, flat taps.
2. **Tab structure is off** — Today / Credentials / Records / Account split isn't right.
3. **Too many taps** — common actions (logging activity, opening a credential) take too long.
4. **Disorienting** — hard to tell where you are or how to get back.

Root cause: navigation is a bare `useState<ViewName>` swap in `app/ITrackApp.tsx`.
There is no navigation stack, no URL/history integration (the app pins the URL to
`/`), no transitions, and detail content renders inline inside tab views or in
modals. The forest-green palette ("calm forest green", 136 tokens in
`app/globals.css`) is also rejected — Chris wants an iOS-native look.

## Decision

**Approach B — rebuild the web app's navigation architecture + full iOS-native
re-theme.** Keep the Capacitor shell and the hosted web app (web users benefit
too). A native SwiftUI rebuild was considered and rejected for this pass (weeks of
work, two UIs to maintain).

## Design

### 1. Navigation stack (fixes "website feel" + "disorienting")

- History-backed router inside `ITrackApp.tsx`: each tab is a root route; detail
  screens **push** onto a stack (`pushState`), browser/hardware back **pops**.
- iOS-style transitions: push = slide-in-from-right with parallax on the outgoing
  screen; pop = reverse. Respect `prefers-reduced-motion`.
- **Edge-swipe back gesture** on pushed screens (touch-tracked, interactive).
- Every pushed screen has an iOS-style header: back chevron + previous screen's
  title on the left, current title centered/large.
- URL reflects location (e.g. `/credentials/:id`) so refresh/deep-link restores it.

### 2. Tab structure (fixes "tab structure is off")

Four tabs + center Log button, bottom bar, SF-Symbols-style icons:

| Tab | Was | Contents |
|---|---|---|
| **Home** | Today | Status overview, "needs attention" cards, one-tap actions |
| **Credentials** | Credentials | List → **pushed** credential detail screen |
| **(Log)** | center + | Bottom sheet with grabber, native-style; unchanged trigger |
| **History** | Records | Activity/cycle history (renamed to what it is) |
| **Profile** | Account | Account, settings, sign-out |

Tab switching is instant (no push animation between roots), and re-tapping the
active tab pops its stack to root / scrolls to top — standard iOS behavior.

### 3. Fewer taps

- Home leads with "what needs attention now" cards that deep-link straight to the
  relevant credential detail or open the Log sheet **pre-filled** for that
  credential.
- Log stays one tap from anywhere (center tab-bar button).

### 4. iOS-native visual language (replaces all green)

- **Typography:** system font stack (`-apple-system, system-ui, …` → SF on
  iPhone); drop Newsreader/Manrope. iOS type scale; large collapsing titles on
  root screens.
- **Light:** white + system-gray grouped surfaces (`#f2f2f7`-family), inset
  grouped lists/cards, hairline separators.
- **Accent:** iOS blue family (light `#007aff`, dark `#0a84ff`). Semantic colors:
  green only for success glyphs (iOS system green), amber → iOS orange/yellow,
  coral → iOS red.
- **Dark:** true neutral (near-black `#000`/`#1c1c1e` ladder) + blue. No green
  tint anywhere.
- **Mechanism:** value-level remap of the existing two-tier token system in
  `globals.css` (both `:root` blocks). Token *names* stay (`--sage`, `--mint` etc.
  may be renamed where the name would now lie — rename is in scope where cheap).
  Contrast comments recomputed; existing floors kept (4.5:1 text, 3:1 marks,
  1.15:1 elevation steps).

### 5. Native-feel details

- Haptics on key actions via Capacitor Haptics (guarded — no-op on web).
- Press states (opacity/scale) on all tappables; `-webkit-tap-highlight-color`
  removed; `touch-action` tuned.
- Sheets: bottom-anchored, grabber handle, drag-to-dismiss, backdrop.
- Safe-area insets respected (already partially handled by shell's
  `contentInset: always` — verify and keep).

## Error handling / edge cases

- Back with unsaved sheet state: keep existing draft-preservation behavior.
- Deep links (`/credentials/:id`) to deleted/unknown ids: fall back to tab root.
- Reduced motion: crossfade instead of slide; gesture still works.
- Widget/notification deep links from the shell must keep working (shell reads
  `server.url`; routes only added, `/` unchanged).

## Testing

- Existing suite must stay green: `npm test` (build + node --test), `typecheck`,
  `lint`. `rendered-html.test.mjs` will need updates for renamed tabs/markup.
- New tests: router push/pop/back-button semantics, deep-link fallback.
- Playwright smoke (mobile viewport): tab switching, push/pop, log sheet, dark
  mode screenshots.
- Verify in the real iPhone app (TestFlight build points at production; verify on
  dev/prod URL after deploy).

## Out of scope

- Native SwiftUI rebuild.
- Widget re-theme (widgets render natively; separate pass if wanted).
- Feature changes to logging/credential logic.

## Deploy

Standard flow: Docker build/run locally before push (standing rule), then push to
main → Railway auto-deploy (itrack-production-da8b.up.railway.app). The iOS shell
picks up the new UI immediately (remote `server.url`) — no TestFlight rebuild
needed.
