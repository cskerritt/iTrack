// `app/lib/instruments.ts` is the one place the four instruments' numbers
// come from — ring arcs, credit-bar layout, ring value and state, the
// check-in dot's state, the twelve-month timeline (spec §5.1 Instruments).
// It is pure, so it is tested here against the ESM that
// `npm run build:lib-test` emits, exactly like tests/cycles.test.mjs. The
// clock is always a parameter: `NOW` is a fixed local instant (the
// tests/readiness.test.mjs convention) and every day count is cross-checked
// with `daysUntilDate`, so the cases hold in whatever zone the runner starts.
import assert from "node:assert/strict";
import test from "node:test";

import { addDaysIso } from "../.test-build/dates.js";
import { daysUntilDate } from "../.test-build/readiness.js";
import {
  DUE_SOON_DAYS,
  RING_SIZES,
  STATE_LABELS,
  creditBarLayout,
  daysBetweenIso,
  reminderState,
  ringArc,
  ringStateOf,
  ringValueOf,
  stateOf,
  timelineLayout,
} from "../.test-build/instruments.js";

// 09:00 local on 2026-09-15 — the mockup's "today" plus five days, so the
// demo LCSW deadline (2026-11-30) reads 77 days.
const NOW = Date.parse("2026-09-15T09:00:00");

function near(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < 0.01,
    `${message}: expected ≈ ${expected}, got ${actual}`,
  );
}

// The calendar date whose `daysUntilDate` from NOW is exactly `days`, found
// by walking a small window instead of assuming a zone (daysUntilDate reads
// the deadline in the runtime zone).
function deadlineAtDays(days) {
  for (let offset = days - 2; offset <= days + 2; offset += 1) {
    const candidate = addDaysIso("2026-09-15", offset);
    if (daysUntilDate(candidate, NOW) === days) return candidate;
  }
  assert.fail(`no calendar date reads ${days} days from NOW`);
}

function cycle(status, deadline, extra = {}) {
  return { id: "c", status, cycleStart: "2024-12-01", deadline, ...extra };
}

test("STATE_LABELS carries the six pill words and DUE_SOON_DAYS is the spec's 90-day boundary", () => {
  assert.deepEqual(STATE_LABELS, {
    overdue: "Overdue",
    "due-soon": "Due soon",
    "on-track": "On track",
    submitted: "Submitted",
    complete: "Renewed",
    none: "No cycle",
  });
  assert.equal(DUE_SOON_DAYS, 90);
});

test("ringArc reproduces the mockup's dasharrays for 72 / 56 / 40 and clamps the fraction", () => {
  // home-desktop.html L71: r 30, stroke 7, dasharray "23.6 188.5" for 5 of 40.
  const dueSoon = ringArc({ size: 72, fraction: 0.125 });
  assert.equal(dueSoon.r, 30);
  assert.equal(dueSoon.strokeWidth, 7);
  assert.equal(dueSoon.centre, 36);
  assert.ok(Math.abs(dueSoon.circumference - 188.4956) < 1e-3);
  assert.equal(dueSoon.dashArray, "23.56 188.50");
  assert.equal(dueSoon.fontSize, 17);
  assert.equal(dueSoon.textY, 41);
  assert.deepEqual(dueSoon.check, RING_SIZES[72].check);
  // L100: "116.9 188.5" for 62 of 100.
  assert.equal(ringArc({ size: 72, fraction: 0.62 }).dashArray, "116.87 188.50");
  // home-phone.html L46 / L63: r 23, stroke 6, "18 144.5" and "89.6 144.5".
  const phone = ringArc({ size: 56, fraction: 0.125 });
  assert.equal(phone.r, 23);
  assert.equal(phone.strokeWidth, 6);
  assert.equal(phone.centre, 28);
  assert.equal(phone.dashArray, "18.06 144.51");
  assert.equal(ringArc({ size: 56, fraction: 0.62 }).dashArray, "89.60 144.51");
  assert.deepEqual(phone.check, RING_SIZES[56].check);
  // The 40 px inline cut: at 100 % the dash IS the circumference (caps meet).
  const inline = ringArc({ size: 40, fraction: 1 });
  assert.equal(inline.r, 16);
  assert.equal(inline.strokeWidth, 5);
  assert.equal(inline.centre, 20);
  assert.equal(inline.dashArray, "100.53 100.53");
  assert.deepEqual(inline.check, RING_SIZES[40].check);
  // Over-earned, negative and NaN fractions clamp.
  const over = ringArc({ size: 72, fraction: 1.4 });
  assert.equal(over.fraction, 1);
  assert.equal(over.dashArray, "188.50 188.50");
  for (const fraction of [-1, Number.NaN]) {
    const arc = ringArc({ size: 72, fraction });
    assert.equal(arc.fraction, 0);
    assert.equal(arc.dashArray, "0.00 188.50");
  }
});

test("creditBarLayout keeps the fill unrounded and places the minimum and cap markers", () => {
  // The mockup's 5-of-40 row: a 12.5 % fill (the numeral rounds to 13
  // elsewhere) and the 20-credit clinical minimum at the halfway mark.
  assert.deepEqual(creditBarLayout({ counted: 5, required: 40, minimum: 20 }), {
    fillPercent: 12.5,
    minimumPercent: 50,
    capPercent: undefined,
    met: false,
    overflow: false,
  });
  // The 62-of-100 row: the 10-credit ethics minimum at 10 %.
  assert.deepEqual(creditBarLayout({ counted: 62, required: 100, minimum: 10 }), {
    fillPercent: 62,
    minimumPercent: 10,
    capPercent: undefined,
    met: false,
    overflow: false,
  });
  // A minimum equal to the total is the bar's end, not a marker.
  assert.deepEqual(creditBarLayout({ counted: 40, required: 40, minimum: 40 }), {
    fillPercent: 100,
    minimumPercent: undefined,
    capPercent: undefined,
    met: true,
    overflow: false,
  });
  // Over-earned: the fill stops at 100 % and the bar flags the overflow.
  assert.deepEqual(creditBarLayout({ counted: 45, required: 40 }), {
    fillPercent: 100,
    minimumPercent: undefined,
    capPercent: undefined,
    met: true,
    overflow: true,
  });
  // A cap (a "maximum" requirement) is a marker like a minimum.
  assert.deepEqual(creditBarLayout({ counted: 12, required: 40, cap: 10 }), {
    fillPercent: 30,
    minimumPercent: undefined,
    capPercent: 25,
    met: false,
    overflow: false,
  });
  // Nothing to earn reads full (the credentialProgress rule).
  assert.deepEqual(creditBarLayout({ counted: 0, required: 0 }), {
    fillPercent: 100,
    met: true,
    overflow: false,
  });
});

test("ringValueOf follows the list's rule: credits when counted, readiness for a checklist-only credential", () => {
  assert.deepEqual(
    ringValueOf({ totalRequired: 40, totalEarned: 5, requirements: [], tasks: [] }),
    { percent: 13, fraction: 0.13, basis: "credits" },
  );
  // readiness.test.mjs pins 60 for this shape (one met minimum, one pending task).
  assert.deepEqual(
    ringValueOf({
      totalRequired: 0,
      totalEarned: 0,
      requirements: [{ requiredUnits: 1, kind: "minimum", earnedUnits: 1 }],
      tasks: [{ status: "pending" }],
    }),
    { percent: 60, fraction: 0.6, basis: "readiness" },
  );
});

test("stateOf derives from cycles.ts: overdue below zero days, due soon within 90, on track beyond", () => {
  // The demo LCSW cycle: 77 days out on 2026-09-15.
  assert.equal(daysUntilDate("2026-11-30", NOW), 77);
  assert.equal(stateOf(cycle("active", "2026-11-30"), NOW), "due-soon");
  assert.equal(stateOf(cycle("active", "2028-03-31"), NOW), "on-track");
  assert.equal(stateOf(cycle("active", "2026-09-01"), NOW), "overdue");
  // Due today reads 1 day (daysUntilDate counts to the end of the day): due soon, not overdue.
  assert.equal(daysUntilDate("2026-09-15", NOW), 1);
  assert.equal(stateOf(cycle("active", "2026-09-15"), NOW), "due-soon");
  // The boundary, located through daysUntilDate so it holds in any zone
  // (2026-12-13 → 90 and 2026-12-14 → 91 in every zone the suite has run in).
  const at90 = deadlineAtDays(DUE_SOON_DAYS);
  const at91 = deadlineAtDays(DUE_SOON_DAYS + 1);
  assert.equal(stateOf(cycle("active", at90), NOW), "due-soon");
  assert.equal(stateOf(cycle("active", at91), NOW), "on-track");
  // Status beats the countdown: submitted waits, renewed is complete.
  assert.equal(stateOf(cycle("submitted", "2026-11-30"), NOW), "submitted");
  assert.equal(stateOf(cycle("submitted", "2026-09-01"), NOW), "submitted");
  assert.equal(
    stateOf(cycle("renewed", "2026-11-30", { acceptedAt: "2026-09-01" }), NOW),
    "complete",
  );
});

test("ringStateOf is complete only when credits are counted in full", () => {
  const counted = { requirements: [], tasks: [] };
  assert.equal(
    ringStateOf(cycle("active", "2026-11-30", { ...counted, totalRequired: 40, totalEarned: 40 }), NOW),
    "complete",
  );
  // The mockup's Submitted row: full green arc under a "Submitted" pill.
  assert.equal(
    ringStateOf(cycle("submitted", "2026-11-30", { ...counted, totalRequired: 40, totalEarned: 40 }), NOW),
    "complete",
  );
  assert.equal(
    ringStateOf(cycle("active", "2026-11-30", { ...counted, totalRequired: 40, totalEarned: 5 }), NOW),
    "due-soon",
  );
  // A checklist-only credential (readiness 100) never completes by credits.
  assert.equal(
    ringStateOf(cycle("active", "2026-11-30", { ...counted, totalRequired: 0, totalEarned: 0 }), NOW),
    "due-soon",
  );
  assert.equal(
    ringStateOf(cycle("renewed", "2026-11-30", { ...counted, totalRequired: 40, totalEarned: 5 }), NOW),
    "complete",
  );
});

test("reminderState maps urgency and kind to a pill state", () => {
  assert.equal(reminderState({ urgency: "overdue", kind: "deadline" }), "overdue");
  assert.equal(reminderState({ urgency: "overdue", kind: "acceptance" }), "overdue");
  assert.equal(reminderState({ urgency: "soon", kind: "acceptance" }), "submitted");
  assert.equal(reminderState({ urgency: "today", kind: "task" }), "due-soon");
  assert.equal(reminderState({ urgency: "soon", kind: "deadline" }), "due-soon");
});

test("daysBetweenIso counts UTC days, so a DST weekend is two days and a leap year is 366", () => {
  assert.equal(daysBetweenIso("2026-09-01", "2027-09-01"), 365);
  assert.equal(daysBetweenIso("2027-09-01", "2028-09-01"), 366);
  // The US spring-forward weekend (2026-03-08): still two days.
  assert.equal(daysBetweenIso("2026-03-07", "2026-03-09"), 2);
  assert.equal(daysBetweenIso("2026-09-15", "2026-09-15"), 0);
  assert.equal(daysBetweenIso("2026-09-15", "2026-09-01"), -14);
});

test("timelineLayout lays the window from the first of the month with the artboard's exact tick positions", () => {
  const layout = timelineLayout({
    today: "2026-09-15",
    deadlines: [
      { id: "crc", label: "CRC", date: "2028-03-31", state: "on-track" },
      { id: "lcsw", label: "LCSW", date: "2026-11-30", state: "due-soon" },
    ],
  });
  assert.equal(layout.start, "2026-09-01");
  assert.equal(layout.end, "2027-09-01");
  assert.equal(layout.span, 365);
  assert.deepEqual(layout.axis, { x1: 10, x2: 330, y: 52 });
  // home-desktop.html L168-173: ticks at 10/90/170/250/330, the last one
  // labelled with the window's last month and anchored end.
  assert.deepEqual(layout.ticks, [
    { x: 10, label: "Sep", end: false },
    { x: 90, label: "Dec", end: false },
    { x: 170, label: "Mar", end: false },
    { x: 250, label: "Jun", end: false },
    { x: 330, label: "Aug", end: true },
  ]);
  near(layout.todayX, 22.27, "today, 14 days into a 365-day window");
  // The artboard draws Nov 30 at x 82; the formula puts it at 88.90.
  assert.deepEqual(
    layout.markers.map(({ id, r, state }) => ({ id, r, state })),
    [{ id: "lcsw", r: 8, state: "due-soon" }],
  );
  near(layout.markers[0].x, 88.9, "Nov 30, 90 days into the window");
  assert.deepEqual(layout.beyond.map((deadline) => deadline.id), ["crc"]);
  // The mockup's own "today" (2026-09-10) sits at 17.89 — the artboard's 18.
  near(timelineLayout({ today: "2026-09-10", deadlines: [] }).todayX, 17.89, "the artboard's today");
});

test("timelineLayout pins an overdue deadline at the axis start and sends deadlines on or after the end beyond", () => {
  const layout = timelineLayout({
    today: "2026-09-15",
    deadlines: [
      { id: "end", label: "On the end", date: "2027-09-01", state: "on-track" },
      { id: "last", label: "Last day", date: "2027-08-31", state: "on-track" },
      { id: "late", label: "Overdue", date: "2026-08-20", state: "overdue" },
    ],
  });
  assert.deepEqual(
    layout.markers.map(({ id, x, r }) => ({ id, x: Number(x.toFixed(2)), r })),
    [
      { id: "late", x: 10, r: 8 },
      { id: "last", x: 329.12, r: 6 },
    ],
  );
  assert.deepEqual(layout.beyond.map((deadline) => deadline.id), ["end"]);
});

test("timelineLayout spans 366 days across a leap year", () => {
  const layout = timelineLayout({
    today: "2027-09-15",
    deadlines: [{ id: "lcsw", label: "LCSW", date: "2027-11-30", state: "due-soon" }],
  });
  assert.equal(layout.start, "2027-09-01");
  assert.equal(layout.end, "2028-09-01");
  assert.equal(layout.span, 366);
  near(layout.markers[0].x, 88.69, "Nov 30 in a 366-day window");
});
