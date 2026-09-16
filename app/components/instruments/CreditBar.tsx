"use client";

import { creditBarLayout, type InstrumentState } from "../../lib/instruments";

export type CreditBarProps = {
  counted: number;
  required: number;
  minimum?: number;
  cap?: number;
  state: InstrumentState;
  label: string;
  valueText?: string;
  reducedMotion?: boolean;
  className?: string;
};

/*
 * A bar with no cap turns "complete" on its own once counted reaches
 * required (the hero bar, every minimum row) and stays complete however far
 * past required it runs — earning more than a minimum is the good outcome,
 * never a warning. A maximum row keeps the state its caller passes —
 * reaching a cap is not completion — and only a cap can overflow:
 * `data-overflow` marks counted past the cap, which instruments.css paints
 * in the overdue ink.
 */
export function CreditBar({
  counted,
  required,
  minimum,
  cap,
  state,
  label,
  valueText,
  reducedMotion,
  className,
}: CreditBarProps) {
  const layout = creditBarLayout({ counted, required, minimum, cap });
  const shownState: InstrumentState =
    cap === undefined && layout.met ? "complete" : state;
  return (
    <div
      className={["instrument", "credit-bar", className]
        .filter(Boolean)
        .join(" ")}
      data-state={shownState}
      data-overflow={cap !== undefined && layout.overflow ? "true" : undefined}
      data-reduced-motion={reducedMotion ? "true" : undefined}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={required}
      aria-valuenow={Math.min(counted, required)}
      aria-valuetext={valueText}
    >
      <span
        className="credit-bar-fill"
        style={{ width: `${layout.fillPercent}%` }}
      />
      {layout.minimumPercent !== undefined ? (
        <span
          className="credit-bar-mark"
          data-kind="minimum"
          style={{ left: `${layout.minimumPercent}%` }}
          aria-hidden="true"
        />
      ) : null}
      {layout.capPercent !== undefined ? (
        <span
          className="credit-bar-mark"
          data-kind="cap"
          style={{ left: `${layout.capPercent}%` }}
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
