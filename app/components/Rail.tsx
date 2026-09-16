"use client";

import { Brand } from "./Brand";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { NavItem } from "./NavItem";
import { TAB_LABELS } from "../lib/routeTitle";
import type { TabName } from "../lib/navigation";

const RAIL_NOTE =
  "Rules come from the issuing body's published requirements, with a source link and review date on every template. The board's current instructions control.";

export function Rail({
  activeTab,
  onNavigate,
  onLogActivity,
}: {
  activeTab: TabName;
  onNavigate: (tab: TabName) => void;
  onLogActivity: () => void;
}) {
  return (
    <aside className="rail">
      <Brand size="rail" />
      <nav className="rail-nav" aria-label="Primary navigation">
        <NavItem tab="home" active={activeTab === "home"} label={TAB_LABELS.home} icon="home" onNavigate={onNavigate} />
        <NavItem
          tab="credentials"
          active={activeTab === "credentials"}
          label={TAB_LABELS.credentials}
          icon="credentials"
          onNavigate={onNavigate}
        />
        <NavItem
          tab="history"
          active={activeTab === "history"}
          label={TAB_LABELS.history}
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
      {/*
       * Never inert. Before a first credential exists the sheet opens on its
       * own empty state, which explains why credits need a cycle and routes
       * to credential setup; a dead button explains nothing.
       */}
      <Button
        variant="primary"
        className="rail-log"
        icon={<Icon name="plus" size={16} strokeWidth={2} />}
        onClick={onLogActivity}
      >
        Log activity
      </Button>
      <p className="rail-note">{RAIL_NOTE}</p>
    </aside>
  );
}
