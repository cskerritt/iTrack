// The app's calendar dates are computed in an IANA zone, never in UTC
// (audit critic-01): a user in Los Angeles at 23:30 sees today's date, not
// tomorrow's. `app/lib/dates.ts` has no bundler entry of its own, so
// `npm run build:lib-test` compiles it with `tsc --outDir .test-build` first
// and this suite imports the emitted ESM.
//
// The Kathmandu and New York instants below are the same literals
// tests/rendered-html.test.mjs pins on app/lib/reminders.ts's own
// `localReminderClock` (the scheduler's clock, which cannot import this
// module because the test inliner only resolves ./catalog/* imports). If the
// two implementations ever drift, one of the two suites fails.

import assert from "node:assert/strict";
import test from "node:test";

import {
  ISO_DATE_PATTERN,
  UTC_FALLBACK_ZONE,
  addDaysIso,
  addMonthsIso,
  addYearsIso,
  deviceZoneSuggestion,
  effectiveDateZone,
  isValidTimeZone,
  localClock,
  todayLocal,
} from "../.test-build/dates.js";

test("todayLocal returns the calendar date in the given zone, not the UTC date (critic-01)", () => {
  // 23:30 in Los Angeles on 10 September is already 11 September in UTC.
  const lateEvening = new Date("2026-09-11T06:30:00Z");
  assert.equal(todayLocal("America/Los_Angeles", lateEvening), "2026-09-10");
  assert.equal(todayLocal("UTC", lateEvening), "2026-09-11");
  // East of the date line the local date is ahead of UTC.
  assert.equal(
    todayLocal("Pacific/Kiritimati", new Date("2026-09-10T10:30:00Z")),
    "2026-09-11",
  );
  // The e2e spec's instant: 22:30 on the 9th in New York.
  assert.equal(
    todayLocal("America/New_York", new Date("2026-09-10T02:30:00Z")),
    "2026-09-09",
  );
  assert.match(todayLocal("Asia/Tokyo"), ISO_DATE_PATTERN);
});

test("localClock agrees with the reminder engine's clock at the pinned instants", () => {
  assert.deepEqual(
    localClock("Asia/Kathmandu", new Date("2026-07-26T03:15:00.000Z")),
    { date: "2026-07-26", hour: 9 },
  );
  assert.equal(
    localClock("America/New_York", new Date("2026-03-08T13:00:00.000Z")).hour,
    9,
    "first hour of EDT",
  );
  assert.equal(
    localClock("America/New_York", new Date("2026-11-01T14:00:00.000Z")).hour,
    9,
    "first hour of EST",
  );
  assert.equal(
    localClock("UTC", new Date("2026-07-27T00:10:00.000Z")).hour,
    0,
    "hourCycle h23: midnight is 0, never 24",
  );
});

test("an invalid zone falls back to UTC instead of throwing", () => {
  assert.equal(isValidTimeZone("Mars/Olympus_Mons"), false);
  assert.equal(isValidTimeZone("Etc/UTC"), true);
  const lateEvening = new Date("2026-09-11T06:30:00Z");
  assert.equal(
    todayLocal("Mars/Olympus_Mons", lateEvening),
    todayLocal(UTC_FALLBACK_ZONE, lateEvening),
  );
});

test("deviceZoneSuggestion offers the device zone only while the stored zone is the UTC fallback", () => {
  assert.equal(deviceZoneSuggestion("UTC", "America/New_York"), "America/New_York");
  assert.equal(deviceZoneSuggestion("UTC", "UTC"), null);
  assert.equal(deviceZoneSuggestion("America/Chicago", "America/New_York"), null);
  assert.equal(deviceZoneSuggestion("UTC", "Mars/Olympus_Mons"), null);
});

test("effectiveDateZone prefers a chosen zone and otherwise the device zone", () => {
  assert.equal(effectiveDateZone("UTC", "America/New_York"), "America/New_York");
  assert.equal(effectiveDateZone("Europe/Paris", "America/New_York"), "Europe/Paris");
  assert.equal(effectiveDateZone("UTC", "Mars/Olympus_Mons"), "UTC");
});

test("date arithmetic clamps to the end of a shorter month", () => {
  assert.equal(addYearsIso("2024-02-29", 1), "2025-02-28");
  assert.equal(addDaysIso("2026-12-31", 1), "2027-01-01");
  assert.equal(addMonthsIso("2026-01-31", 1), "2026-02-28");
  // A custom credential's default cycle start: one year back from today.
  assert.equal(addYearsIso("2026-09-10", -1), "2025-09-10");
  // A template's default cycle start: one year ahead minus its cycle length.
  assert.equal(addMonthsIso(addYearsIso("2026-09-10", 1), -24), "2025-09-10");
});
