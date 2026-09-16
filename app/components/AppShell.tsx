"use client";

import type { ReactNode } from "react";
import { BottomNav } from "./BottomNav";
import { Rail } from "./Rail";
import type { TabName } from "../lib/navigation";

// The frame every routed screen renders inside (spec §5.1 Layout): the skip
// link, the desktop rail, the content column and the phone's bottom nav.
// `#main-content` is the one documented DOM anchor — the skip link's target.
// The Log activity action reaches the rail and the bottom nav only through
// the `onLogActivity` prop: no ids, no querySelector (architecture-14).
export function AppShell({
  activeTab,
  onNavigate,
  onLogActivity,
  children,
}: {
  activeTab: TabName;
  onNavigate: (tab: TabName) => void;
  onLogActivity: () => void;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Rail activeTab={activeTab} onNavigate={onNavigate} onLogActivity={onLogActivity} />
      <main id="main-content" className="app-main">
        {children}
      </main>
      <BottomNav activeTab={activeTab} onNavigate={onNavigate} onLogActivity={onLogActivity} />
    </div>
  );
}
