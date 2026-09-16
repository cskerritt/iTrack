"use client";

import { useId } from "react";
import { addMonthsIso } from "../../lib/dates";
import {
  STATE_LABELS,
  timelineLayout,
  type TimelineDeadline,
} from "../../lib/instruments";

export type DeadlineTimelineProps = {
  today: string;
  deadlines: readonly TimelineDeadline[];
  months?: number;
  formatDate: (iso: string) => string;
  formatShortDate: (iso: string) => string;
  formatMonth: (iso: string) => string;
  onSelect?: (id: string) => void;
  className?: string;
};

// The mockup's plot: 340 × 92, the axis at y 52. Every x comes out of
// timelineLayout in that 340-unit space and is laid out as a percentage of
// the rendered width — for the SVG marks and the HTML hit areas alike, so the
// two stay aligned — while y is absolute in a 92px-tall SVG. A viewBox would
// scale the 0.75rem labels and the strokes with the card (2.7× on the
// full-width Wave 3 mount, 0.85× at 320px); percentages keep them 1:1 at any
// width, and at the mockup's 340px they are the artboard's exact pixels.
const PLOT_WIDTH = 340;
const PLOT_HEIGHT = 92;
const pct = (x: number) => `${((x / PLOT_WIDTH) * 100).toFixed(3)}%`;

/*
 * The SVG is decorative (axis, ticks, the dashed today line, one name and
 * short date per deadline). The list laid over it is the real content: one
 * 44px button per deadline, named "<label>, <date>, <state>", with a tooltip
 * that shows on hover and keyboard focus. `today` is the app's local date
 * (todayLocal in the reminder zone), passed down — never read here.
 */
export function DeadlineTimeline({
  today,
  deadlines,
  months = 12,
  formatDate,
  formatShortDate,
  formatMonth,
  onSelect,
  className,
}: DeadlineTimelineProps) {
  const layout = timelineLayout({
    today,
    deadlines,
    months,
    width: PLOT_WIDTH,
  });
  const tipBase = useId();
  const lastMonth = addMonthsIso(layout.start, months - 1);
  const { axis } = layout;
  return (
    <figure
      className={["instrument", "deadline-timeline", className]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="deadline-timeline-plot">
        <svg
          width="100%"
          height={PLOT_HEIGHT}
          aria-hidden="true"
          focusable="false"
        >
          <line
            className="deadline-timeline-axis"
            x1={pct(axis.x1)}
            y1={axis.y}
            x2={pct(axis.x2)}
            y2={axis.y}
          />
          {layout.ticks.map((tick, index) => {
            const tall = index === 0 || tick.end;
            return (
              <g key={`${tick.label}-${tick.x}`}>
                <line
                  className="deadline-timeline-tick"
                  x1={pct(tick.x)}
                  y1={tall ? 46 : 47}
                  x2={pct(tick.x)}
                  y2={tall ? 58 : 57}
                />
                <text
                  className="deadline-timeline-tick-label"
                  x={pct(tick.x)}
                  y={76}
                  textAnchor={tick.end ? "end" : "middle"}
                >
                  {tick.label}
                </text>
              </g>
            );
          })}
          <line
            className="deadline-timeline-today"
            x1={pct(layout.todayX)}
            y1={34}
            x2={pct(layout.todayX)}
            y2={70}
          />
          <text
            className="deadline-timeline-today-label"
            x={pct(layout.todayX)}
            y={28}
            textAnchor="middle"
          >
            today
          </text>
          {layout.markers.map((marker) => (
            <g key={marker.id}>
              <text
                className="deadline-timeline-marker-name"
                x={pct(marker.x)}
                y={16}
                textAnchor="middle"
              >
                {marker.label}
              </text>
              <text
                className="deadline-timeline-marker-date"
                x={pct(marker.x)}
                y={28}
                textAnchor="middle"
              >
                {formatShortDate(marker.date)}
              </text>
            </g>
          ))}
        </svg>
        <ul
          className="deadline-timeline-list"
          aria-label="Deadlines in the next twelve months"
        >
          {layout.markers.map((marker) => {
            const tipId = `${tipBase}-${marker.id}`;
            return (
              <li
                key={marker.id}
                className="instrument"
                data-state={marker.state}
                data-r={marker.r}
                style={{ left: pct(marker.x) }}
              >
                <button
                  type="button"
                  className="deadline-timeline-hit"
                  aria-describedby={tipId}
                  onClick={() => onSelect?.(marker.id)}
                >
                  <span className="sr-only">
                    {marker.label}, {formatDate(marker.date)},{" "}
                    {STATE_LABELS[marker.state].toLowerCase()}
                  </span>
                </button>
                <span
                  role="tooltip"
                  id={tipId}
                  className="deadline-timeline-tip"
                >
                  {marker.label} · {formatDate(marker.date)} ·{" "}
                  {STATE_LABELS[marker.state]}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <figcaption>
        <span className="deadline-timeline-range">
          {formatMonth(layout.start)} – {formatMonth(lastMonth)}
        </span>
        {layout.beyond.length ? (
          <span className="deadline-timeline-beyond">
            {layout.beyond.map((deadline) => deadline.label).join(" and ")} sit
            beyond this window.
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}
