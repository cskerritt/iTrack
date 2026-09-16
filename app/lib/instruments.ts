/**
 * Instrument geometry: every number the four instruments draw (spec §5.1 —
 * CycleRing, CreditBar, StatusPill, DeadlineTimeline), derived once here from
 * the values app/lib/readiness.ts and app/lib/cycles.ts already compute. The
 * components in app/components/instruments/ lay these numbers out and never
 * re-derive a percentage, a day count or a state.
 *
 * Pure on purpose. The clock (`nowMs`) and `today` (YYYY-MM-DD, the app's
 * `todayLocal(dateZone)`) are parameters, never read here, so the callers keep
 * `Date.now()` in module-level helpers (ITrackApp.tsx's `credentialCountdown`)
 * and `react-hooks/purity` never meets it in a render. Day arithmetic for the
 * timeline uses `Date.UTC`, so a DST change is never a 23- or 25-hour day.
 *
 * Imports carry the `.js` suffix: `npm run build:lib-test` compiles this file
 * with `tsc --module nodenext` for tests/instruments.test.mjs, and the emitted
 * ESM must resolve `./readiness.js` under Node.
 */
import {
  credentialProgress,
  readinessScore,
  type ReadinessCredential,
} from "./readiness.js";
import { cycleCountdown, isClosedCycle, type CycleLike } from "./cycles.js";
import { addMonthsIso } from "./dates.js";

/**
 * One vocabulary for every instrument: the pill's fill/ink pair, the ring
 * arc, the bar fill and the timeline dot all key their colour on it.
 * `none` is the no-credential case and is only ever passed in by a caller.
 */
export type InstrumentState =
  | "overdue"
  | "due-soon"
  | "on-track"
  | "complete"
  | "submitted"
  | "none";

/** Spec §6: Home rows sort overdue, then "due within 90 days", then on track. */
export const DUE_SOON_DAYS = 90;

export const STATE_LABELS: Record<InstrumentState, string> = {
  overdue: "Overdue",
  "due-soon": "Due soon",
  "on-track": "On track",
  submitted: "Submitted",
  complete: "Renewed",
  none: "No cycle",
};

/**
 * The three ring sizes of the approved mockup (72 px desktop rows, 56 px
 * phone cards, 40 px inline). `r` and `strokeWidth` are the artboards' own
 * (`r="30" stroke-width="7"` / `r="23" stroke-width="6"`); the 40 px cut
 * scales the 72 px one by 40/72. The check path is the artboard's, drawn in
 * the same viewBox; `textY` is the centre numeral's baseline.
 */
export const RING_SIZES = {
  72: {
    r: 30,
    strokeWidth: 7,
    fontSize: 17,
    textY: 41,
    check: { d: "M26 37l7 7 13-14", strokeWidth: 3.5 },
  },
  56: {
    r: 23,
    strokeWidth: 6,
    fontSize: 13,
    textY: 32,
    check: { d: "M19 29l6 6 12-13", strokeWidth: 3 },
  },
  40: {
    r: 16,
    strokeWidth: 5,
    fontSize: 10,
    textY: 23.5,
    check: { d: "M14.4 20.6l3.9 3.9 7.2-7.8", strokeWidth: 2.5 },
  },
} as const;

export type RingSize = keyof typeof RING_SIZES;

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/**
 * The arc geometry for one ring: `dashArray` is the `stroke-dasharray` of an
 * arc drawn on the `r` circle and rotated -90° (12 o'clock start). At 100 %
 * the dash is exactly the circumference so the round caps meet without a
 * seam; the component omits the arc element altogether when `fraction` is 0
 * (a round cap would still paint a dot).
 */
export function ringArc({
  size,
  fraction,
}: {
  size: RingSize;
  fraction: number;
}): {
  size: RingSize;
  centre: number;
  r: number;
  strokeWidth: number;
  circumference: number;
  fraction: number;
  dashArray: string;
  fontSize: number;
  textY: number;
  check: { d: string; strokeWidth: number };
} {
  const geometry = RING_SIZES[size];
  const circumference = 2 * Math.PI * geometry.r;
  const clamped = clamp01(fraction);
  const dash = clamped >= 1 ? circumference : clamped * circumference;
  return {
    size,
    centre: size / 2,
    r: geometry.r,
    strokeWidth: geometry.strokeWidth,
    circumference,
    fraction: clamped,
    dashArray: `${dash.toFixed(2)} ${circumference.toFixed(2)}`,
    fontSize: geometry.fontSize,
    textY: geometry.textY,
    check: geometry.check,
  };
}

/**
 * The credit bar's layout in percent of its width. The fill is deliberately
 * unrounded (the mockup's 5-of-40 row is a 12.5 % fill under a "13%"
 * numeral); a marker is placed only strictly inside the bar — a minimum
 * equal to the total is the bar's end, not a marker. A zero requirement has
 * nothing left to earn (the `credentialProgress` rule), so it reads full.
 */
export function creditBarLayout({
  counted,
  required,
  minimum,
  cap,
}: {
  counted: number;
  required: number;
  minimum?: number;
  cap?: number;
}): {
  fillPercent: number;
  minimumPercent?: number;
  capPercent?: number;
  met: boolean;
  overflow: boolean;
} {
  if (required <= 0) return { fillPercent: 100, met: true, overflow: false };
  const fillPercent = Math.max(0, Math.min(100, (counted / required) * 100));
  const percentOf = (value: number | undefined): number | undefined =>
    value !== undefined && value > 0 && value < required
      ? (value / required) * 100
      : undefined;
  return {
    fillPercent,
    minimumPercent: percentOf(minimum),
    capPercent: percentOf(cap),
    met: counted >= required,
    overflow: counted > required,
  };
}

/**
 * The value a ring shows — the Credentials list's rule (ITrackApp.tsx
 * `CredentialsView`): credits counted vs required when the credential counts
 * credits, the readiness composite for a checklist-only credential (whose
 * `credentialProgress` would otherwise be a permanent 100). `percent` is the
 * rounded numeral; `fraction` drives the arc.
 */
export function ringValueOf(credential: ReadinessCredential): {
  percent: number;
  fraction: number;
  basis: "credits" | "readiness";
} {
  if (credential.totalRequired > 0) {
    const percent = credentialProgress(credential);
    return { percent, fraction: percent / 100, basis: "credits" };
  }
  const percent = readinessScore(credential);
  return { percent, fraction: percent / 100, basis: "readiness" };
}

/**
 * The cycle's state: closed cycles are complete, a submitted cycle waits for
 * acceptance, and an open one counts down through `cycleCountdown` — overdue
 * below zero days, due soon within `DUE_SOON_DAYS` (a deadline today reads
 * 1 day, so it is due soon, not overdue), on track beyond. The status
 * vocabulary is only ever compared through cycles.ts's helpers plus the one
 * `"submitted"` literal.
 */
export function stateOf(cycle: CycleLike, nowMs: number): InstrumentState {
  if (isClosedCycle(cycle)) return "complete";
  if (cycle.status === "submitted") return "submitted";
  const countdown = cycleCountdown(cycle, nowMs);
  if (countdown.kind === "closed") return "complete";
  if (countdown.kind === "overdue") return "overdue";
  return countdown.days <= DUE_SOON_DAYS ? "due-soon" : "on-track";
}

/**
 * A ring is complete when its credits are counted in full, even while the
 * cycle is still open or submitted (the mockup's Submitted row draws a full
 * green arc and a check under a "Submitted" pill): ring completeness is
 * credits-based, the pill is cycle-based. A checklist-only credential never
 * completes by credits; its ring follows the cycle.
 */
export function ringStateOf(
  cycle: CycleLike & ReadinessCredential,
  nowMs: number,
): InstrumentState {
  if (cycle.totalRequired > 0 && ringValueOf(cycle).fraction >= 1) {
    return "complete";
  }
  return stateOf(cycle, nowMs);
}

/**
 * The check-in row's dot (a11y-11). app/lib/reminders.ts is a D1-backed
 * server module, so this takes the plain `{ urgency, kind }` shape the client
 * `Reminder` type carries rather than importing it. An acceptance check-in is
 * the "submitted" green (the mockup's "Check for CLCP acceptance" dot);
 * "today" and "soon" are both due soon — the component words "Due today".
 */
export function reminderState(reminder: {
  urgency: "overdue" | "today" | "soon";
  kind: "task" | "deadline" | "acceptance";
}): InstrumentState {
  if (reminder.urgency === "overdue") return "overdue";
  if (reminder.kind === "acceptance") return "submitted";
  return "due-soon";
}

export type TimelineDeadline = {
  id: string;
  label: string;
  date: string;
  state: InstrumentState;
};

export type TimelineLayout = {
  /** The window: [start, end) as YYYY-MM-DD, and its length in days. */
  start: string;
  end: string;
  span: number;
  axis: { x1: number; x2: number; y: number };
  /** Quarter ticks from the window's first month; the last one is labelled with the window's LAST month and anchored `end`. */
  ticks: Array<{ x: number; label: string; end: boolean }>;
  todayX: number;
  /** Deadlines inside the window, by date; r 8 for overdue/due-soon, 6 otherwise. */
  markers: Array<TimelineDeadline & { x: number; r: 8 | 6 }>;
  /** Deadlines on or after `end`, by date — the card's "sit beyond this window" footnote. */
  beyond: TimelineDeadline[];
};

// A const array rather than Intl, so the labels are the same in every locale
// the tests run in.
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const utcDay = (iso: string): number => {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(year, month - 1, day);
};

/** Whole days from one YYYY-MM-DD to another, counted in UTC so DST never shortens or stretches a day. */
export function daysBetweenIso(from: string, to: string): number {
  return Math.round((utcDay(to) - utcDay(from)) / 86_400_000);
}

const markerRadius = (state: InstrumentState): 8 | 6 =>
  state === "overdue" || state === "due-soon" ? 8 : 6;

const compareDates = (a: TimelineDeadline, b: TimelineDeadline): number =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : 0;

/**
 * The twelve-month timeline in the artboard's coordinate space (viewBox
 * `0 0 340 92`, axis at y 52 from x 10 to width-10). The window starts on the
 * first of `today`'s month and runs `months` months; a marker's x is
 * proportional to its days from `start`, clamped to the axis, so an overdue
 * deadline before the window pins at `x1`. Quarter ticks sit at
 * `x1 + (x2 - x1) * m / months` — 10 / 90 / 170 / 250 / 330 for the default
 * width, the artboard's exact positions.
 */
export function timelineLayout({
  today,
  deadlines,
  months = 12,
  width = 340,
}: {
  today: string;
  deadlines: readonly TimelineDeadline[];
  months?: number;
  width?: number;
}): TimelineLayout {
  const start = `${today.slice(0, 7)}-01`;
  const end = addMonthsIso(start, months);
  const span = daysBetweenIso(start, end);
  const axis = { x1: 10, x2: width - 10, y: 52 };
  const x = (date: string): number =>
    Math.max(
      axis.x1,
      Math.min(
        axis.x2,
        axis.x1 + ((axis.x2 - axis.x1) * daysBetweenIso(start, date)) / span,
      ),
    );
  const startMonth = Number(start.slice(5, 7)) - 1;
  const ticks: TimelineLayout["ticks"] = [];
  for (let m = 0; m < months; m += 3) {
    ticks.push({
      x: axis.x1 + ((axis.x2 - axis.x1) * m) / months,
      label: MONTHS[(startMonth + m) % 12],
      end: false,
    });
  }
  ticks.push({
    x: axis.x2,
    label: MONTHS[(startMonth + months - 1) % 12],
    end: true,
  });
  const sorted = [...deadlines].sort(compareDates);
  return {
    start,
    end,
    span,
    axis,
    ticks,
    todayX: x(today),
    markers: sorted
      .filter((deadline) => deadline.date < end)
      .map((deadline) => ({
        ...deadline,
        x: x(deadline.date),
        r: markerRadius(deadline.state),
      })),
    beyond: sorted.filter((deadline) => deadline.date >= end),
  };
}
