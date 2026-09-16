import type { Route, TabName } from "./navigation.js";

// What each screen is called, in one place: the rail and the bottom nav label
// their links from it, the document title is built from it, and the phone's
// narrowest label is the one exception it spells out.
export const TAB_LABELS: Record<TabName, string> = {
  home: "Home",
  credentials: "Credentials",
  history: "Activity log",
  profile: "Account",
};

export const TAB_SHORT_LABELS: Record<TabName, string> = {
  ...TAB_LABELS,
  history: "Activity",
};

// The document title for a route: "<screen> · iTrack". A routed credential
// is named by the credential; before the workspace has loaded it, a neutral
// noun stands in so the tab never reads as the wrong screen.
export function routeTitle(route: Route, credentialName: string | null): string {
  if (route.detail) {
    const name = credentialName?.trim();
    return `${name && name.length > 0 ? name : "Credential"} · iTrack`;
  }
  return `${TAB_LABELS[route.tab]} · iTrack`;
}
