"use client";

import type { ReactNode } from "react";
import { STATE_LABELS, type InstrumentState } from "../../lib/instruments";

export type StatusPillProps = {
  state: InstrumentState;
  children?: ReactNode;
  compact?: boolean;
  className?: string;
};

/*
 * State in form and colour, with text: the colour comes from data-state, the
 * text is always in the DOM. The compact form is the 8px check-in dot; its
 * text is visually hidden, never absent (a11y-11).
 */
export function StatusPill({
  state,
  children,
  compact,
  className,
}: StatusPillProps) {
  const text = children ?? STATE_LABELS[state];
  return (
    <span
      className={["instrument", "status-pill", className]
        .filter(Boolean)
        .join(" ")}
      data-state={state}
      data-compact={compact ? "true" : undefined}
    >
      {compact ? <span className="sr-only">{text}</span> : text}
    </span>
  );
}
