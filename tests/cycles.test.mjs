// `app/lib/cycles.ts` decides which cycle Home points at and how the
// Credentials list folds renewed cycles under their credential (app-ux-04,
// app-ux-18). It is pure, so it is tested here against the ESM that
// `npm run build:lib-test` emits, exactly like tests/navigation.test.mjs.
// `today` is always passed in, never read from the clock, so every case is a
// fixed date.
import assert from "node:assert/strict";
import test from "node:test";

import { daysUntilDate } from "../.test-build/readiness.js";
import {
  OPEN_CYCLE_STATUSES,
  activeCycleId,
  compareCycleUrgency,
  cycleCountdown,
  groupCycles,
  isClosedCycle,
  isOpenCycle,
  selectDefaultCredentialId,
  seriesKey,
} from "../.test-build/cycles.js";

const TODAY = "2026-09-14";

function cycle(id, status, cycleStart, deadline, extra = {}) {
  return { id, status, cycleStart, deadline, ...extra };
}

test("open means active or submitted; closed means renewed", () => {
  assert.deepEqual([...OPEN_CYCLE_STATUSES], ["active", "submitted"]);
  assert.equal(isOpenCycle({ status: "active" }), true);
  assert.equal(isOpenCycle({ status: "submitted" }), true);
  assert.equal(isOpenCycle({ status: "renewed" }), false);
  assert.equal(isClosedCycle({ status: "renewed" }), true);
  assert.equal(isClosedCycle({ status: "submitted" }), false);
});

test("seriesKey falls back to the cycle's own id for a link-less legacy root", () => {
  assert.equal(seriesKey({ id: "root", seriesId: undefined }), "root");
  assert.equal(seriesKey({ id: "root", seriesId: null }), "root");
  assert.equal(seriesKey({ id: "next", seriesId: "root" }), "root");
});

test("compareCycleUrgency orders by deadline, then cycleStart, then id", () => {
  const sorted = [
    cycle("c", "active", "2026-01-01", "2027-06-30"),
    cycle("b", "active", "2025-01-01", "2027-06-30"),
    cycle("a", "active", "2025-01-01", "2027-06-30"),
    cycle("d", "active", "2020-01-01", "2026-12-31"),
  ].sort(compareCycleUrgency);
  assert.deepEqual(sorted.map((entry) => entry.id), ["d", "a", "b", "c"]);
});

test("activeCycleId never picks a renewed cycle over its open successor", () => {
  // app-ux-04's exact shape: the renewed cycle has the earliest deadline.
  const renewed = cycle("old", "renewed", "2024-01-01", "2026-09-16", {
    seriesId: "old",
    acceptedAt: "2026-09-08",
  });
  const successor = cycle("new", "active", "2026-09-17", "2028-08-16", {
    seriesId: "old",
  });
  assert.equal(activeCycleId([renewed, successor], TODAY), "new");
  assert.equal(activeCycleId([successor, renewed], TODAY), "new");
});

test("activeCycleId prefers the soonest open cycle whose deadline has not passed", () => {
  const overdue = cycle("overdue", "active", "2025-01-01", "2026-06-30");
  const future = cycle("future", "active", "2026-01-01", "2027-12-31");
  const later = cycle("later", "active", "2026-01-01", "2028-12-31");
  assert.equal(activeCycleId([later, overdue, future], TODAY), "future");
  // A deadline of exactly today still counts as live.
  const dueToday = cycle("today", "active", "2026-01-01", TODAY);
  assert.equal(activeCycleId([later, dueToday], TODAY), "today");
});

test("activeCycleId falls back to the most recently opened cycle when every open cycle is overdue", () => {
  const older = cycle("older", "active", "2024-01-01", "2025-12-31");
  const newer = cycle("newer", "active", "2025-01-01", "2026-01-31");
  assert.equal(activeCycleId([older, newer], TODAY), "newer");
  // Same start date: the larger id wins, so the answer is stable.
  const tieA = cycle("a", "active", "2025-01-01", "2026-01-31");
  const tieB = cycle("b", "active", "2025-01-01", "2026-01-31");
  assert.equal(activeCycleId([tieA, tieB], TODAY), "b");
});

test("activeCycleId names the most recently opened renewed cycle when nothing is open, and null when nothing exists", () => {
  const first = cycle("first", "renewed", "2020-01-01", "2022-12-31");
  const second = cycle("second", "renewed", "2023-01-01", "2025-12-31");
  assert.equal(activeCycleId([first, second], TODAY), "second");
  assert.equal(activeCycleId([], TODAY), null);
});

test("a submitted cycle counts as open", () => {
  const submitted = cycle("sub", "submitted", "2025-01-01", "2026-12-31");
  const renewed = cycle("ren", "renewed", "2023-01-01", "2024-12-31");
  assert.equal(activeCycleId([renewed, submitted], TODAY), "sub");
});

test("groupCycles folds a three-cycle chain under one series, previous newest first", () => {
  const legacyRoot = cycle("legacy", "active", "2026-03-01", "2028-02-28");
  const first = cycle("s1", "renewed", "2020-01-01", "2021-12-31", {
    seriesId: "s1",
    acceptedAt: "2022-01-10",
  });
  const second = cycle("s2", "renewed", "2022-01-01", "2023-12-31", {
    seriesId: "s1",
    acceptedAt: "2024-01-05",
  });
  const third = cycle("s3", "active", "2024-01-01", "2026-12-31", {
    seriesId: "s1",
  });
  const historyOnly = cycle("h1", "renewed", "2018-01-01", "2019-12-31", {
    seriesId: "h1",
    acceptedAt: "2020-01-15",
  });
  const series = groupCycles(
    [historyOnly, second, legacyRoot, third, first],
    TODAY,
  );
  assert.deepEqual(
    series.map((entry) => ({
      seriesId: entry.seriesId,
      current: entry.current?.id ?? null,
      previous: entry.previous.map((previous) => previous.id),
      members: entry.members.length,
    })),
    [
      // Series with a current cycle first, soonest deadline first …
      { seriesId: "s1", current: "s3", previous: ["s2", "s1"], members: 3 },
      { seriesId: "legacy", current: "legacy", previous: [], members: 1 },
      // … then series that are only history.
      { seriesId: "h1", current: null, previous: ["h1"], members: 1 },
    ],
  );
});

test("selectDefaultCredentialId keeps an open selection and drops a renewed one", () => {
  const cycles = [
    { id: "open", status: "active" },
    { id: "done", status: "renewed" },
  ];
  assert.equal(selectDefaultCredentialId(cycles, "open", "other"), "open");
  assert.equal(selectDefaultCredentialId(cycles, "done", "open"), "open");
  assert.equal(selectDefaultCredentialId(cycles, "missing", "open"), "open");
  assert.equal(selectDefaultCredentialId(cycles, "", "open"), "open");
  assert.equal(selectDefaultCredentialId(cycles, "done", null), "");
});

test("cycleCountdown is closed for a renewed cycle and counts days otherwise", () => {
  const renewed = cycle("ren", "renewed", "2024-01-01", "2026-09-10", {
    acceptedAt: "2026-06-15",
  });
  assert.deepEqual(cycleCountdown(renewed, Date.now()), {
    kind: "closed",
    acceptedAt: "2026-06-15",
  });
  const renewedWithoutDate = cycle("ren2", "renewed", "2024-01-01", "2026-09-10");
  assert.deepEqual(cycleCountdown(renewedWithoutDate, Date.now()), {
    kind: "closed",
    acceptedAt: null,
  });
  // 23:30 on 2026-09-10 in America/Los_Angeles is 06:30Z on the 11th
  // (critic-01's hour). Whether a deadline of 2026-09-10 is already overdue
  // depends on the zone the runtime counts in, so the assertion is parity
  // with daysUntilDate rather than a fixed sign.
  const nowMs = Date.parse("2026-09-11T06:30:00Z");
  const open = cycle("open", "active", "2026-01-01", "2026-09-10");
  const days = daysUntilDate("2026-09-10", nowMs);
  assert.deepEqual(cycleCountdown(open, nowMs), {
    kind: days < 0 ? "overdue" : "due",
    days,
  });
  const far = cycle("far", "active", "2026-01-01", "2027-12-31");
  const farDays = daysUntilDate("2027-12-31", nowMs);
  assert.ok(farDays > 400);
  assert.deepEqual(cycleCountdown(far, nowMs), { kind: "due", days: farDays });
  const past = cycle("past", "submitted", "2024-01-01", "2025-01-01");
  const pastDays = daysUntilDate("2025-01-01", nowMs);
  assert.ok(pastDays < 0);
  assert.deepEqual(cycleCountdown(past, nowMs), { kind: "overdue", days: pastDays });
});
