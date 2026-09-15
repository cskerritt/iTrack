"use client";

import type { MouseEvent } from "react";
import { Icon, type IconName } from "./Icon";
import { buildPath, type TabName } from "../lib/navigation";

// Only a plain left click is the client router's. A modified click, a middle
// click or anything a handler already claimed is left to the browser, which
// does the right thing with a real href (a new tab, a bookmark, a copy).
export function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

// A tab is a real link (a11y-03): it is in a screen reader's link list, it has
// an href, and `aria-current="page"` marks the one the user is on. The phone's
// third item shows a shorter word but keeps the full name (the visible text
// is contained in it — WCAG 2.5.3).
export function NavItem({
  tab,
  active,
  label,
  shortLabel,
  icon,
  onNavigate,
}: {
  tab: TabName;
  active: boolean;
  label: string;
  shortLabel?: string;
  icon: IconName;
  onNavigate: (tab: TabName) => void;
}) {
  return (
    <a
      className="nav-item"
      href={buildPath({ tab, detail: null })}
      aria-current={active ? "page" : undefined}
      aria-label={shortLabel ? label : undefined}
      onClick={(event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        onNavigate(tab);
      }}
    >
      <Icon name={icon} strokeWidth={1.75} />
      <span>{shortLabel ?? label}</span>
    </a>
  );
}
