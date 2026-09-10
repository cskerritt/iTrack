import type { Route, TabName } from "./navigation.js";

const TAB_TITLES: Record<TabName, string> = {
  home: "Home",
  credentials: "Credentials",
  history: "History",
  profile: "Profile",
};

// The document title for a route: "<screen> · iTrack". A pushed credential
// is named by the credential; before the workspace has loaded it, a neutral
// noun stands in so the tab never reads as the wrong screen.
export function routeTitle(route: Route, credentialName: string | null): string {
  if (route.detail) {
    const name = credentialName?.trim();
    return `${name && name.length > 0 ? name : "Credential"} · iTrack`;
  }
  return `${TAB_TITLES[route.tab]} · iTrack`;
}
