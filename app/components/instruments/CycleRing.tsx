"use client";

import { useLayoutEffect, useRef } from "react";
import {
  ringArc,
  type InstrumentState,
  type RingSize,
} from "../../lib/instruments";

export type CycleRingProps = {
  size: RingSize;
  fraction: number;
  percent: number;
  state: InstrumentState;
  label: string;
  valueText?: string;
  showNumeral?: boolean;
  reducedMotion?: boolean;
  className?: string;
};

/*
 * The ring is a progressbar for assistive technology (label + numeric value,
 * as home.spec.ts asserts); the SVG inside is decorative. The geometry —
 * radius, stroke, dash array, numeral size, check path — comes from
 * app/lib/instruments.ts and is never re-derived here.
 */
export function CycleRing({
  size,
  fraction,
  percent,
  state,
  label,
  valueText,
  showNumeral = size !== 40,
  reducedMotion,
  className,
}: CycleRingProps) {
  const arc = ringArc({ size, fraction });
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef<number | null>(null);
  // The check draws only when a value crosses complete after mount; a ring
  // that mounts complete renders instantly. Written as a DOM attribute from
  // a layout effect — no state, no ref read during render. The comparison
  // is per instance, so a mount that can change credential in place (the
  // Home hero, a Wave 4 ledger row) carries key={credential.id}: a different
  // credential is a fresh mount, never a completion.
  useLayoutEffect(() => {
    const node = root.current;
    if (
      node &&
      previous.current !== null &&
      previous.current < 1 &&
      arc.fraction >= 1
    ) {
      node.setAttribute("data-motion", "complete");
    }
    previous.current = arc.fraction;
  }, [arc.fraction]);
  return (
    <div
      ref={root}
      className={["instrument", "cycle-ring", className]
        .filter(Boolean)
        .join(" ")}
      data-size={size}
      data-state={state}
      data-reduced-motion={reducedMotion ? "true" : undefined}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={valueText}
    >
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
        <circle
          className="cycle-ring-track"
          cx={arc.centre}
          cy={arc.centre}
          r={arc.r}
          strokeWidth={arc.strokeWidth}
        />
        {arc.fraction > 0 ? (
          <circle
            className="cycle-ring-arc"
            cx={arc.centre}
            cy={arc.centre}
            r={arc.r}
            strokeWidth={arc.strokeWidth}
            strokeDasharray={arc.dashArray}
            transform={`rotate(-90 ${arc.centre} ${arc.centre})`}
          />
        ) : null}
        {state === "complete" ? (
          <path
            className="cycle-ring-check"
            d={arc.check.d}
            strokeWidth={arc.check.strokeWidth}
            pathLength={1}
          />
        ) : showNumeral ? (
          <text
            className="cycle-ring-label"
            x={arc.centre}
            y={arc.textY}
            textAnchor="middle"
            fontSize={arc.fontSize}
          >
            {percent}%
          </text>
        ) : null}
      </svg>
    </div>
  );
}
