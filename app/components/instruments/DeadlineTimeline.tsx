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

// Text baselines (px). A marker's name and mono date stack above the axis;
// the "today" flag takes the band below the dates and above the marker
// circles. At 12px the mono em box is 15px tall (ascent 12, descent 3) and
// the body face's 14px (11 / 3), so the three rows occupy y 3–17, 14–29 and
// 30–45: the flag never shares a band with a marker's labels. The artboard
// draws the name and date two pixels lower and centres "today" at the
// dates' own baseline — where any deadline within a few weeks of today (an
// overdue one pins at the axis start, and today sits in the first third for
// half of every month) had the two labels overprint each other.
const MARKER_NAME_Y = 14;
const MARKER_DATE_Y = 26;
const TODAY_LABEL_Y = 42;
// The flag starts this many px right of the dashed line.
const TODAY_LABEL_GAP = 6;

// Which side a marker's tooltip and labels hang from. In the middle third of
// the axis they are centred on the marker (the artboard's text-anchor
// middle); in the outer thirds they are anchored to the marker's own side, so
// neither the SVG (which clips) nor the page (whose scrollable overflow a
// hidden tooltip still counts toward) sees a label run past the plot. The
// `<li>` carries the answer as data-edge for instruments.css.
type TimelineEdge = "start" | "end" | undefined;
const edgeOf = (
  x: number,
  axis: { x1: number; x2: number },
): TimelineEdge => {
  const third = (axis.x2 - axis.x1) / 3;
  if (x < axis.x1 + third) return "start";
  if (x > axis.x2 - third) return "end";
  return undefined;
};

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
  const markers = layout.markers.map((marker) => ({
    ...marker,
    edge: edgeOf(marker.x, axis),
  }));
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
          {/*
           * Start-anchored beside the top of the dashed line. Today always
           * falls inside the first ~9% of the axis (the window starts on the
           * first of its month), so a flag hanging to the right never leaves
           * the plot, and its band (TODAY_LABEL_Y) is its own.
           */}
          <text
            className="deadline-timeline-today-label"
            x={pct(layout.todayX)}
            dx={TODAY_LABEL_GAP}
            y={TODAY_LABEL_Y}
            textAnchor="start"
          >
            today
          </text>
          {markers.map((marker) => (
            <g key={marker.id}>
              <text
                className="deadline-timeline-marker-name"
                x={pct(marker.x)}
                y={MARKER_NAME_Y}
                textAnchor={marker.edge ?? "middle"}
              >
                {marker.label}
              </text>
              <text
                className="deadline-timeline-marker-date"
                x={pct(marker.x)}
                y={MARKER_DATE_Y}
                textAnchor={marker.edge ?? "middle"}
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
          {markers.map((marker) => {
            const tipId = `${tipBase}-${marker.id}`;
            return (
              <li
                key={marker.id}
                className="instrument"
                data-state={marker.state}
                data-r={marker.r}
                data-edge={marker.edge}
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
                  {marker.label} ·{" "}
                  <span className="deadline-timeline-tip-part">
                    {formatDate(marker.date)}
                  </span>{" "}
                  ·{" "}
                  <span className="deadline-timeline-tip-part">
                    {STATE_LABELS[marker.state]}
                  </span>
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
