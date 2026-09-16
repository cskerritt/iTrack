"use client";

import { Icon } from "./Icon";
import { NavItem } from "./NavItem";
import { TAB_LABELS, TAB_SHORT_LABELS } from "../lib/routeTitle";
import type { TabName } from "../lib/navigation";

export function BottomNav({
  activeTab,
  onNavigate,
  onLogActivity,
}: {
  activeTab: TabName;
  onNavigate: (tab: TabName) => void;
  onLogActivity: () => void;
}) {
  return (
    <nav className="bottom-nav" aria-label="Primary navigation">
      <NavItem tab="home" active={activeTab === "home"} label={TAB_LABELS.home} icon="home" onNavigate={onNavigate} />
      <NavItem
        tab="credentials"
        active={activeTab === "credentials"}
        label={TAB_LABELS.credentials}
        icon="credentials"
        onNavigate={onNavigate}
      />
      {/* Never inert — see Rail. Named like the rail's button so one fixture finds both. */}
      <button type="button" className="bottom-nav-log" aria-label="Log activity" onClick={onLogActivity}>
        <Icon name="plus" size={22} strokeWidth={2.25} />
      </button>
      <NavItem
        tab="history"
        active={activeTab === "history"}
        label={TAB_LABELS.history}
        shortLabel={TAB_SHORT_LABELS.history}
        icon="activityLog"
        onNavigate={onNavigate}
      />
      <NavItem
        tab="profile"
        active={activeTab === "profile"}
        label={TAB_LABELS.profile}
        icon="account"
        onNavigate={onNavigate}
      />
    </nav>
  );
}
