"use client";

import { createContext, useContext } from "react";
import type { Route } from "../lib/navigation";

// What every PageHeader reads from the shell: the route it names the document
// after, the credential a detail is showing (for the title), and how many
// navigations have happened since mount — 0 on first paint, so a heading is
// focused only after a navigation the user made or the browser replayed.
export type RouteAnnouncement = {
  route: Route;
  credentialName: string | null;
  navigations: number;
};

export const RouteAnnouncementContext = createContext<RouteAnnouncement | null>(null);

export function useRouteAnnouncement(): RouteAnnouncement | null {
  return useContext(RouteAnnouncementContext);
}
