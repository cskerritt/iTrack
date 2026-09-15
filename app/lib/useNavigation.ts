"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { buildPath, parseRoute, type Route, type TabName } from "./navigation";

export const HOME_ROUTE: Route = { tab: "home", detail: null };

export type NavigateOptions = { replace?: boolean };

export type Navigation = {
  route: Route;
  // 0 until the first navigation after mount; PageHeader focuses its heading
  // only while this is above 0, so first paint keeps the browser's own focus
  // and the skip link stays the first Tab stop.
  navigations: number;
  setTab(tab: TabName, options?: NavigateOptions): void;
  openCredential(id: string, options?: NavigateOptions): void;
  back(): void;
  // replaceState(state, "", pathname): drops a launch query the app has
  // consumed (`?delivery=`) without moving.
  scrubQuery(): void;
};

// Scroll offsets by pathname, restored on popstate: the document scroller is
// shared by every screen, so this is the only place that memory can live.
const scrollMemory = new Map<string, number>();

/**
 * Ordinary page routing (spec §5.1): every screen is a URL, a tab change or a
 * credential open is a pushState, Back and Forward are the browser's own, and
 * nothing is stamped on a history entry. The only rules of our own are the
 * same-URL rule (a re-tap of the active tab scrolls to the top and pushes
 * nothing), the replace option (a URL that no longer resolves is replaced so
 * Back never lands on it), and the scroll memory.
 */
export function useNavigation(): Navigation {
  // Seeded from HOME_ROUTE, not window.location: the server renders every
  // route page as the home root, and a different client seed would throw the
  // hydrated tree away. The mount effect adopts the real URL one render later.
  const [route, setRoute] = useState<Route>(HOME_ROUTE);
  const [navigations, setNavigations] = useState(0);
  // The offset to restore on the next commit (set by popstate only).
  const restore = useRef<number | null>(null);
  // The pathname the screen on stage was rendered for. A fragment jump — the
  // skip link's #main-content — also fires popstate in Chromium; comparing
  // pathnames is what keeps it from counting as a screen change.
  const lastPathname = useRef<string | null>(null);
  const apply = useCallback((next: Route) => setRoute(next), []);

  useEffect(() => {
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
    const adopt = () => {
      lastPathname.current = window.location.pathname;
      apply(parseRoute(window.location.pathname));
    };
    adopt();
    const onPop = () => {
      const pathname = window.location.pathname;
      if (pathname === lastPathname.current) return;
      lastPathname.current = pathname;
      restore.current = scrollMemory.get(pathname) ?? 0;
      apply(parseRoute(pathname));
      setNavigations((count) => count + 1);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [apply]);

  // Runs after the screen for `route` is in the DOM, before paint — the one
  // moment a restored offset can land on the right document height.
  useLayoutEffect(() => {
    const top = restore.current;
    if (top === null) return;
    restore.current = null;
    window.scrollTo({ top, left: 0, behavior: "auto" });
  }, [route]);

  const navigate = useCallback(
    (next: Route, replace: boolean) => {
      const path = buildPath(next);
      if (path === window.location.pathname) {
        // Re-tapping the tab you are on: back to its top, no history entry.
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
        return;
      }
      scrollMemory.set(window.location.pathname, window.scrollY);
      window.history[replace ? "replaceState" : "pushState"](window.history.state, "", path);
      lastPathname.current = path;
      apply(next);
      setNavigations((count) => count + 1);
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    },
    [apply],
  );

  const setTab = useCallback(
    (tab: TabName, options?: NavigateOptions) =>
      navigate({ tab, detail: null }, Boolean(options?.replace)),
    [navigate],
  );
  const openCredential = useCallback(
    (id: string, options?: NavigateOptions) =>
      navigate({ tab: "credentials", detail: { kind: "credential", id } }, Boolean(options?.replace)),
    [navigate],
  );
  const back = useCallback(() => window.history.back(), []);
  const scrubQuery = useCallback(() => {
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }, []);

  return { route, navigations, setTab, openCredential, back, scrubQuery };
}
