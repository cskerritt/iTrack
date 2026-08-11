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
