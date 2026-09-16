"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Brand } from "./Brand";
import { useRouteAnnouncement } from "./RouteAnnouncement";
import { usePublishedHeight } from "./usePublishedHeight";
import { buildPath } from "../lib/navigation";
import { routeTitle } from "../lib/routeTitle";

// The one H1 of a screen. It names the document after the route (app-ux-17)
// and takes focus after every navigation (a11y-03, a11y-M-02) — but not on
// first paint, where navigations is 0 and the browser's own focus stays put so
// the skip link is the first Tab stop. Pages outside the route contract (the
// not-found route, the styleguide) pass `documentTitle` and never take focus.
export function PageHeader({
  eyebrow,
  title,
  lede,
  actions,
  documentTitle,
}: {
  eyebrow?: ReactNode;
  title: string;
  lede?: ReactNode;
  actions?: ReactNode;
  documentTitle?: string;
}) {
  const announcement = useRouteAnnouncement();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const route = announcement?.route ?? null;
  const credentialName = announcement?.credentialName ?? null;
  const navigations = announcement?.navigations ?? 0;
  const routeKey = route ? buildPath(route) : null;

  useEffect(() => {
    if (documentTitle !== undefined) {
      document.title = documentTitle;
      return;
    }
    if (!route) return;
    document.title = routeTitle(route, credentialName);
  }, [documentTitle, route, credentialName]);

  // Fires when this header mounts (a tab change swaps the whole screen) and
  // when the route it belongs to changes underneath it (an accepted renewal
  // re-points the detail at its successor).
  useEffect(() => {
    if (routeKey === null || navigations === 0) return;
    headingRef.current?.focus({ preventScroll: true });
  }, [routeKey, navigations]);

  // At ≤ 820px this header is the sticky app bar, and the root's
  // scroll-padding-top (shell.css) clears --app-bar-height so a control that
  // Tab or scrollIntoView brings to the top edge never lands behind it (WCAG
  // 2.2 2.4.11). The height follows the title's wrap and the actions wrapped
  // beneath it, so it is measured rather than declared; the desktop consumes
  // nothing — the header is in flow there.
  usePublishedHeight(headerRef, "--app-bar-height");

  return (
    <header ref={headerRef} className="page-header">
      <div className="page-header-text">
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1 ref={headingRef} tabIndex={-1} className="page-title">
          {title}
        </h1>
        {lede ? <p className="page-lede">{lede}</p> : null}
      </div>
      <Brand size="bar" className="page-header-brand" />
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
}
