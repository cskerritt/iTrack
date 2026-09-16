"use client";

import { useId, type ReactNode } from "react";
import { Button } from "./Button";

// One empty state for the page (Credentials, Activity log), the inline row
// (Home's recent learning) and the in-sheet case (a sheet with nothing to
// act on). No default mark: a caller that has a glyph passes `icon`; the
// section is named by its heading, which stays an h2 because PageHeader
// owns the page's h1.
export function EmptyState({
  title,
  body,
  action,
  icon,
  compact = false,
}: {
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
  icon?: ReactNode;
  compact?: boolean;
}) {
  const titleId = useId();
  return (
    <section
      className={compact ? "empty-state empty-state-compact" : "empty-state"}
      aria-labelledby={titleId}
    >
      {icon ? (
        <span className="empty-state-mark" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <div className="empty-state-text">
        <h2 id={titleId}>{title}</h2>
        <p>{body}</p>
      </div>
      {action ? (
        <Button variant={compact ? "quiet" : "primary"} onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </section>
  );
}
