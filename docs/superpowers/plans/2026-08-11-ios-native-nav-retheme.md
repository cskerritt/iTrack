# iTrack iOS-Native Nav + Re-theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the iTrack web app (served into the Capacitor iPhone shell) navigate and look like a native iOS app: history-backed nav stack with push/pop transitions and edge-swipe back, restructured tabs (Home / Credentials / **Log** / History / Profile), and a full re-theme from forest green to iOS-native neutral + blue.

**Architecture:** All UI lives in `app/ITrackApp.tsx` (~10.2k lines) + `app/globals.css` (~6.2k lines, two-tier token system). We add a small pure routing module (`app/lib/navigation.ts`) + a `useNavigation` hook wired to `history.pushState`/`popstate`, render pushed screens in a stack container with CSS transforms, and remap token *values* (not names, two exceptions) in both `:root` blocks.

**Tech Stack:** Next 16 via vinext/vite on Cloudflare worker, React 19, plain CSS tokens (no Tailwind in app CSS), `node --test` against the built worker (`npm test` = build + test), Playwright available via webapp-testing skill.

## Global Constraints

- Node >= 22.13 (`engines`); if npm misbehaves use `~/.local/node/node-v22.22.0-darwin-arm64/bin`.
- Never weaken existing tests — update assertions only where the UI legitimately changed (tab labels, fonts, colors).
- Design-system invariant holds: **no color literal outside the two `:root` blocks** of `app/globals.css` (light block at line ~3, dark block at `@media (prefers-color-scheme: dark)` ~line 282; blocks at ~5342 and ~6202 are layout/press-scale only, not color).
- Contrast floors (keep, recompute comments): text ≥ 4.5:1 composited, non-text marks ≥ 3:1, elevation steps ≥ 1.15:1.
- Work on branch `feat/ios-native-nav-retheme`; verify branch before every commit (shared working tree risk).
- Before merging to main: Docker build + run locally (standing rule), full `npm test`, `npm run typecheck`, `npm run lint`.
- The Capacitor shell loads the production URL; `/` must keep rendering the app shell unchanged (widget/notification deep links depend on it).

---

### Task 1: Pure routing module

**Files:**
- Create: `app/lib/navigation.ts`
- Test: `tests/navigation.test.mjs`

**Interfaces:**
- Produces: `type TabName = "home" | "credentials" | "history" | "profile"`;
  `type Route = { tab: TabName; detail: { kind: "credential"; id: string } | null }`;
  `parseRoute(pathname: string): Route`; `buildPath(route: Route): string`.
  Later tasks import these from `./lib/navigation`.

- [ ] **Step 1: Write the failing test**

```js
// tests/navigation.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { parseRoute, buildPath } from "../dist/navigation-test-entry.js";
```

Routing is pure TS; to test without a bundler entry, compile inline instead: add
`"test:nav": "tsc app/lib/navigation.ts --outDir .test-build --module nodenext --target es2022 && node --test tests/navigation.test.mjs"`
to `package.json` scripts, and in the test import `../.test-build/navigation.js`.
Assertions:

```js
test("parseRoute maps pathnames to routes", () => {
  assert.deepEqual(parseRoute("/"), { tab: "home", detail: null });
  assert.deepEqual(parseRoute("/credentials"), { tab: "credentials", detail: null });
  assert.deepEqual(parseRoute("/credentials/abc123"), {
    tab: "credentials",
    detail: { kind: "credential", id: "abc123" },
  });
  assert.deepEqual(parseRoute("/history"), { tab: "history", detail: null });
  assert.deepEqual(parseRoute("/profile"), { tab: "profile", detail: null });
  // unknown → home root (spec: deep-link fallback)
  assert.deepEqual(parseRoute("/nope/xyz"), { tab: "home", detail: null });
});

test("buildPath is the inverse of parseRoute", () => {
  for (const path of ["/", "/credentials", "/credentials/abc123", "/history", "/profile"]) {
    assert.equal(buildPath(parseRoute(path)), path === "/" ? "/" : path);
  }
});
```

- [ ] **Step 2: Run `npm run test:nav` — expect FAIL (module missing)**
- [ ] **Step 3: Implement `app/lib/navigation.ts`**

```ts
export type TabName = "home" | "credentials" | "history" | "profile";
export type DetailRoute = { kind: "credential"; id: string };
export type Route = { tab: TabName; detail: DetailRoute | null };

const TAB_PATHS: Record<string, TabName> = {
  "": "home",
  credentials: "credentials",
  history: "history",
  profile: "profile",
};

export function parseRoute(pathname: string): Route {
  const segments = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const tab = TAB_PATHS[segments[0] ?? ""];
  if (tab === undefined) return { tab: "home", detail: null };
  if (tab === "credentials" && segments[1]) {
    return { tab, detail: { kind: "credential", id: decodeURIComponent(segments[1]) } };
  }
  return { tab, detail: null };
}

export function buildPath(route: Route): string {
  if (route.detail) return `/credentials/${encodeURIComponent(route.detail.id)}`;
  return route.tab === "home" ? "/" : `/${route.tab}`;
}
```

- [ ] **Step 4: Run `npm run test:nav` — expect PASS**
- [ ] **Step 5: Commit** (`feat: add pure route parsing for nav stack`; include `.test-build` in `.gitignore`)

---

### Task 2: useNavigation hook + tab restructure (labels, no visuals yet)

**Files:**
- Modify: `app/ITrackApp.tsx` — `type ViewName` (line ~335), `const [view, setView]` (~1251), `history.replaceState` pin (~1769), render ternary (~3542–3706), `DesktopSidebar` (~6065), `MobileNavigation` (~6121)
- Modify: `tests/rendered-html.test.mjs:643-646` (tab label assertions)

**Interfaces:**
- Consumes: `parseRoute`, `buildPath`, `Route`, `TabName` from Task 1.
- Produces: hook used by all later tasks:

```ts
const nav = useNavigation();
// nav.route: Route            — current location
// nav.setTab(tab: TabName)    — replaceState to tab root (tab switch = replace, not push)
// nav.push(detail: DetailRoute) — pushState detail screen
// nav.pop()                   — history.back() if we pushed; else replace to tab root
// nav.popToRoot()             — re-tap active tab behavior
```

- [ ] **Step 1: Implement `useNavigation` inside ITrackApp.tsx**

```tsx
function useNavigation() {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === "undefined"
      ? { tab: "home", detail: null }
      : parseRoute(window.location.pathname),
  );
  const pushDepth = useRef(0);
  useEffect(() => {
    const onPop = () => {
      pushDepth.current = Math.max(0, pushDepth.current - 1);
      setRoute(parseRoute(window.location.pathname));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const setTab = useCallback((tab: TabName) => {
    const next: Route = { tab, detail: null };
    window.history.replaceState(window.history.state, "", buildPath(next));
    pushDepth.current = 0;
    setRoute(next);
  }, []);
  const push = useCallback((detail: DetailRoute) => {
    setRoute((current) => {
      const next: Route = { tab: current.tab, detail };
      window.history.pushState(null, "", buildPath(next));
      pushDepth.current += 1;
      return next;
    });
  }, []);
  const pop = useCallback(() => {
    if (pushDepth.current > 0) window.history.back();
    else setTab(parseRoute(window.location.pathname).tab);
  }, [setTab]);
  const popToRoot = pop; // single-level stack today; alias kept for tab re-tap
  return { route, setTab, push, pop, popToRoot };
}
```

- [ ] **Step 2: Replace `view` state.** Delete `useState<ViewName>` (~1251); derive `const view = nav.route.tab` and map old names in the render ternary: `today→home`, `records→history`, `account→profile`. Keep `ViewName` values updated (`"home" | "credentials" | "history" | "profile"`). Remove the `window.history.replaceState(..., "/")` URL pin at ~1769 (router owns the URL now). Search for **every** `setView(` call and replace with `nav.setTab(...)`.
- [ ] **Step 3: Relabel tabs.** In `MobileNavigation` and `DesktopSidebar`: `Today→Home`, `Records→History`, `Account→Profile` (icons: keep `home`, `layoutGrid`, `listRows`→keep, `userCircle`). Update `tests/rendered-html.test.mjs:643-646` to expect `>Home</span>`, `>History</span>`, `>Profile</span>`.
- [ ] **Step 4: Verify** — `npm run typecheck && npm test`. Expect PASS.
- [ ] **Step 5: Commit** (`feat: history-backed navigation + Home/History/Profile tabs`)

---

### Task 3: Pushed credential detail screen

**Files:**
- Modify: `app/ITrackApp.tsx` — `CredentialsView` (~7187) and the main render (~3599)

**Interfaces:**
- Consumes: `nav` from Task 2.
- Produces: `<CredentialDetailScreen credentialId={...} onBack={nav.pop} />` and a `screen-stack` DOM structure Task 4 animates:

```tsx
<div className="screen-stack">
  <div className={`screen screen-root ${nav.route.detail ? "screen-under" : ""}`}>{tabContent}</div>
  {nav.route.detail && (
    <div className="screen screen-pushed">
      <CredentialDetailScreen ... />
    </div>
  )}
</div>
```

- [ ] **Step 1: Extract detail rendering.** Today tapping a credential sets `selectedCredentialId` and detail renders inline in `CredentialsView`. Change credential taps to *also* call `nav.push({ kind: "credential", id })`; `CredentialsView` renders only the list. New `CredentialDetailScreen` wraps the existing detail JSX (move, don't rewrite) with an iOS header:

```tsx
<header className="push-header">
  <button type="button" className="push-back" onClick={onBack}>
    <Icon name="chevronLeft" size={22} />
    <span>Credentials</span>
  </button>
  <h1 className="push-title">{credential.name}</h1>
</header>
```

Add a `chevronLeft` entry to `ICON_SHAPES` if absent: `<path d="M15 18l-6-6 6-6" />`.
- [ ] **Step 2: Deep-link fallback.** If `nav.route.detail.id` matches no credential (deleted/unknown), render nothing and call `nav.setTab("credentials")` in an effect.
- [ ] **Step 3: Keep selection state coherent.** `selectedCredentialId` continues to drive data lookups; sync it from `nav.route.detail?.id` in an effect so back/forward restores selection.
- [ ] **Step 4: Verify** — `npm run typecheck && npm test`; manual: `npm run dev`, click credential → URL becomes `/credentials/<id>`, browser back returns to list.
- [ ] **Step 5: Commit** (`feat: push credential detail as a stacked screen`)

---

### Task 4: Push/pop transitions + edge-swipe back

**Files:**
- Modify: `app/globals.css` (screen-stack rules), `app/ITrackApp.tsx` (gesture handler on `.screen-pushed`)

**Interfaces:**
- Consumes: `.screen-stack` DOM from Task 3.

- [ ] **Step 1: Transition CSS** (tokens only, no color literals):

```css
.screen-stack { position: relative; overflow: clip; }
.screen-pushed {
  position: absolute; inset: 0; background: var(--paper);
  animation: screen-in 340ms cubic-bezier(0.32, 0.72, 0, 1);
  will-change: transform;
}
.screen-root { transition: transform 340ms cubic-bezier(0.32, 0.72, 0, 1), opacity 340ms; }
.screen-root.screen-under { transform: translateX(-28%); opacity: 0.92; }
@keyframes screen-in { from { transform: translateX(100%); } to { transform: translateX(0); } }
.screen-pushed.screen-exiting { animation: screen-out 300ms cubic-bezier(0.32, 0.72, 0, 1) forwards; }
@keyframes screen-out { from { transform: translateX(0); } to { transform: translateX(100%); } }
@media (prefers-reduced-motion: reduce) {
  .screen-pushed, .screen-root { animation: screen-fade 200ms ease; transition: none; transform: none; }
  @keyframes screen-fade { from { opacity: 0; } to { opacity: 1; } }
}
```

Pop plays `screen-exiting` then calls `nav.pop()` on `animationend` (state-driven: `const [exiting, setExiting] = useState(false)`; back button sets it).
- [ ] **Step 2: Edge-swipe gesture** on the pushed screen container:

```tsx
function useEdgeSwipeBack(ref: RefObject<HTMLElement>, onBack: () => void) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let startX = 0, startY = 0, tracking = false;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      tracking = t.clientX <= 24; // edge zone
      startX = t.clientX; startY = t.clientY;
      if (tracking) el.style.transition = "none";
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const dx = e.touches[0].clientX - startX;
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (dy > 40 && dy > dx) { tracking = false; el.style.transform = ""; return; }
      if (dx > 0) el.style.transform = `translateX(${dx}px)`;
    };
    const onEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const dx = e.changedTouches[0].clientX - startX;
      el.style.transition = ""; el.style.transform = "";
      if (dx > 80) onBack();
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd);
    return () => { el.removeEventListener("touchstart", onStart); el.removeEventListener("touchmove", onMove); el.removeEventListener("touchend", onEnd); };
  }, [ref, onBack]);
}
```

- [ ] **Step 3: Verify** — dev server + responsive/touch emulation: push animates in, edge-drag follows finger, release >80px pops, vertical scroll unaffected, reduced-motion crossfades.
- [ ] **Step 4: Commit** (`feat: iOS push/pop transitions and edge-swipe back`)

---

### Task 5: Re-theme Tier 1 — fonts + brand palette

**Files:**
- Modify: `app/layout.tsx` (drop `next/font` Google imports), `app/globals.css` light block (~3) and dark block (~282), `tests/rendered-html.test.mjs` (any font/color assertions that fail)

- [ ] **Step 1: System font stack.** Remove `Manrope`/`Newsreader` imports and their `variable` classNames from `app/layout.tsx`. In `globals.css` define `--font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif;` and point every `font-family: var(--font-manrope|--font-newsreader), …` rule at `var(--font-ui)` (display sizes keep weight/size distinctions — headings become semibold sans, not serif; `letter-spacing: -0.02em` on display sizes for SF-like tightness).
- [ ] **Step 2: Tier-1 remap.** Replace values in **both** blocks:

| token | light (new) | dark (new) |
|---|---|---|
| `--paper` | `#f2f2f7` | `#0b0b0e` |
| `--card` | `#ffffff` | `#1c1c1e` |
| `--white` | `#ffffff` | `#2c2c2e` |
| `--ink` | `#1d1d21` | `#e5e5ea` |
| `--ink-deep` | `#000000` | `#f5f5f7` |
| `--ink-label`…`--ink-placeholder` ladder | `#4b4b53` → `#6b6b74` (keep ≥4.5:1 on `--card`) | `#c7c7cf` → `#9d9da6` |
| `--sage` (soft positive fill) | `#cfe3f9` | `#1e3a5c` |
| `--mint` (primary accent) | `#007aff` | `#0a84ff` |
| `--amber` | `#e8a013` | `#ffd60a` |
| `--coral` | `#e5484d` | `#ff453a` |
| `--line` / `--line-strong` | `#e3e3e8` / `#cdcdd4` | `#2c2c30` / `#3d3d44` |

**Rename** the two tokens whose names now lie: `--sage`→`--tint` and `--mint`→`--accent` (project-wide find/replace including `--mint-rgb`→`--accent-rgb`, `--wash-sage*`→`--wash-tint*`; mechanical, no value logic).
- [ ] **Step 3: Fix broken pairings.** Old `--mint` was a mid-light fill carrying dark text; new `--accent` is saturated blue carrying white. Audit every `var(--accent)` use: fills get `color: var(--on-accent)` (set `--on-accent: #ffffff` light, `#ffffff` dark); places needing the old "light fill + dark text" pattern switch to `var(--tint)`. Run `npm run dev` and visually sweep every screen in both schemes.
- [ ] **Step 4: Verify** — `npm run typecheck && npm test`; update any test assertions that pinned old fonts/labels.
- [ ] **Step 5: Commit** (`feat: iOS-native system fonts and neutral+blue tier-1 palette`)

---

### Task 6: Re-theme Tier 2 — role tokens + contrast comments + docs

**Files:**
- Modify: `app/globals.css` (all Tier-2 tokens in both blocks), `docs/DESIGN-SYSTEM.md`
- Create: `tools/contrast-audit.mjs` (if no equivalent exists in `tools/`)

- [ ] **Step 1: Remap rule.** For every Tier-2 token (`--ink-surface*`, `--on-*`, `--wash-*`, `--chip-*`, `--highlight-*`, `--track*`, `--edge-*`, `--mark-*`, `--focus-*`, `--danger*`, `--accent-control`, `--*-rgb`): keep the token's **relative luminance within ±0.03 of its old value** and swap hue family — green→neutral gray (surfaces) or blue (accents/marks), amber→`#e8a013`/`#ffd60a` family, coral→`#e5484d`/`#ff453a` family. `--ink-surface*` (sidebar/hero/FAB surfaces) become graphite: light-scheme `#1f2024`-family, dark-scheme elevated `#26262b`-family. `--page-glow` + radial sheens: swap `--accent-rgb` (already renamed) so atmosphere turns cool blue at the same alpha.
- [ ] **Step 2: Contrast audit script.** `tools/contrast-audit.mjs`: parse both `:root` blocks, recompute WCAG ratios for every documented pairing comment, print failures. Update every ratio comment to the recomputed value (±0.05 discipline). Fix any floor violation by nudging L until it passes.
- [ ] **Step 3: Update `docs/DESIGN-SYSTEM.md`** — "Character" section rewritten (iOS neutral + blue, system type), token tables re-stated with new values, contrast discipline section unchanged.
- [ ] **Step 4: Verify** — `node tools/contrast-audit.mjs` → 0 failures; `npm test`; visual sweep light+dark.
- [ ] **Step 5: Commit** (`feat: retheme role tokens to iOS neutral+blue with recomputed contrast`)

---

### Task 7: Native-feel details

**Files:**
- Modify: `app/globals.css`, `app/ITrackApp.tsx` (Modal ~9905, sheets, tappables)

- [ ] **Step 1: Press states + tap highlight.** Global: `* { -webkit-tap-highlight-color: transparent; }`. All buttons/cards get `:active { opacity: var(--press-dim); transform: scale(var(--press-scale)); transition: transform 80ms, opacity 80ms; }` — tokens already exist (~6202 block).
- [ ] **Step 2: Sheet grabber + drag-dismiss.** The activity/log `Modal` on mobile becomes bottom-anchored with a grabber bar (`.sheet-grabber { width: 36px; height: 5px; border-radius: 3px; background: var(--line-strong); margin: 8px auto; }`), slide-up entrance, drag-down-to-dismiss (reuse the Task 4 touch pattern, vertical axis, threshold 120px, only when sheet content is scrolled to top).
- [ ] **Step 3: Haptics helper** (guarded, no shell rebuild required to ship):

```ts
function hapticTap(style: "light" | "medium" = "light") {
  const impact = (window as any).Capacitor?.Plugins?.Haptics?.impact;
  if (impact) impact({ style: style === "light" ? "LIGHT" : "MEDIUM" }).catch(() => {});
}
```

Call on: tab switch, log-sheet open, activity saved, credential renewal completion. (Plugin lands in the shell in Task 10; until then this is a no-op.)
- [ ] **Step 4: Home deep links.** In `TodayView` (~6199) "needs attention" cards: tapping a credential card → `nav.push({ kind: "credential", id })`; tapping a "log credits" suggestion → `openActivityEntry()` with that credential pre-selected (`setSelectedCredentialId(id)` before opening — the sheet already reads it).
- [ ] **Step 5: Re-tap active tab pops to root** — in tab button handler: `view === tab ? nav.popToRoot() : nav.setTab(tab)`.
- [ ] **Step 6: Verify + commit** (`feat: native press states, sheet grabber, haptics hooks, home deep links`)

---

### Task 8: Full verification

- [ ] `npm run typecheck && npm run lint && npm test` all green.
- [ ] Playwright smoke (webapp-testing skill), iPhone viewport 390×844, against `npm run dev`: tab switching, credential push + back (button and browser-back), log sheet open/dismiss, deep-link `/credentials/<real-id>` refresh, unknown-id fallback, dark-mode screenshots of all four tabs + detail. Save screenshots to scratchpad and review them for visual defects (spacing, contrast, leftover green).
- [ ] Docker build + run locally (standing rule): `docker build -t itrack-local . && docker run --rm -p 3000:3000 itrack-local` (adjust port per Dockerfile), smoke `/` renders.
- [ ] Commit any fixes.

### Task 9: Ship

- [ ] Merge `feat/ios-native-nav-retheme` → `main`, push → Railway auto-deploys itrack-production-da8b.up.railway.app.
- [ ] Verify production URL renders the new UI (curl + browser), both schemes.
- [ ] Confirm iPhone shell picks it up (remote `server.url` — no TestFlight rebuild needed).

### Task 10 (follow-up, separate repo): Haptics plugin in shell

- [ ] In `~/Documents/New project/iTrack-iOS`: `npm i @capacitor/haptics && npx cap sync ios`; commit. Note: reaches the phone only with the **next** TestFlight build — UI degrades gracefully until then.

## Self-Review

- Spec coverage: nav stack (T1–T4), tabs (T2), fewer taps (T7.4–7.5), re-theme (T5–T6), native details (T7), testing (T8), deploy (T9), haptics shell (T10). Widget re-theme explicitly out of scope. ✔
- No placeholders; all code steps carry real code. ✔
- Type consistency: `Route`/`TabName`/`DetailRoute` defined T1, consumed T2–T4; `nav.*` API defined T2, consumed T3/T4/T7. Token renames (`--tint`, `--accent`) applied consistently in T5→T6. ✔
