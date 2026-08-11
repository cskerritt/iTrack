// The URL contract for the iOS-style nav stack.
//
// Every tab is a root route (`/`, `/credentials`, `/history`, `/profile`) and
// detail screens push on top of their tab (`/credentials/:id`). Keeping the
// parse/build pair pure — no `window`, no React — means a cold deep link, a
// `popstate` from the hardware/edge-swipe back gesture, and a programmatic
// `pushState` all resolve through the same code path, and it can be tested
// without a DOM.

export type TabName = "home" | "credentials" | "history" | "profile";
export type DetailRoute = { kind: "credential"; id: string };
export type Route = { tab: TabName; detail: DetailRoute | null };

// The lookup is intentionally typed as possibly-undefined: an unknown first
// segment must fall through to the home root rather than smuggle a bogus tab.
const TAB_PATHS: Record<string, TabName | undefined> = {
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

const TAB_NAMES: readonly string[] = [
  "home",
  "credentials",
  "history",
  "profile",
];

export function isTabName(value: unknown): value is TabName {
  return typeof value === "string" && TAB_NAMES.includes(value);
}

/*
 * The other half of the contract: what the app records *on* a history entry,
 * because the URL cannot carry it.
 *
 * `depth` is how many entries into its own stack that entry is. Counting it in
 * a variable instead goes wrong the moment the user presses forward, which
 * fires the same `popstate` a back press does; read off the entry the browser
 * landed on, it is right whichever direction they moved.
 *
 * `tab` is the tab the stack was built on. A detail path names its credential
 * and nothing else — `/credentials/<id>` is the URL whether the screen was
 * opened from the Credentials list or from a Home card — so without it,
 * back/forward (and a refresh, since a browser keeps the state with the entry)
 * would silently relocate the user to a tab they never chose.
 */
export const NAV_STATE_KEY = "itrackNav";
export type NavEntry = { depth: number; tab: TabName };

export function readNavEntry(state: unknown): NavEntry | null {
  if (typeof state !== "object" || state === null) return null;
  const entry = (state as Record<string, unknown>)[NAV_STATE_KEY];
  if (typeof entry !== "object" || entry === null) return null;
  const { depth, tab } = entry as { depth?: unknown; tab?: unknown };
  if (typeof depth !== "number" || !Number.isFinite(depth)) return null;
  if (!isTabName(tab)) return null;
  return { depth: Math.max(0, Math.floor(depth)), tab };
}

/** Stamp our entry onto whatever else the platform keeps in the state. */
export function withNavEntry(state: unknown, entry: NavEntry): unknown {
  const base =
    typeof state === "object" && state !== null && !Array.isArray(state)
      ? state
      : {};
  return { ...base, [NAV_STATE_KEY]: entry };
}

/** The route an entry stands for: its URL, plus the tab only it remembers. */
export function routeAt(pathname: string, entry: NavEntry | null): Route {
  const parsed = parseRoute(pathname);
  if (parsed.detail && entry) return { tab: entry.tab, detail: parsed.detail };
  return parsed;
}
