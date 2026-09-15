// The hero's three numbers (days left, credit progress, readiness ring) are
// pure functions in app/lib/readiness.ts. `npm run build:lib-test` compiles
// them into .test-build/ and this suite imports the emitted ESM.
import assert from "node:assert/strict";
import test from "node:test";

import {
  clampPercent,
  credentialProgress,
  daysUntilDate,
  readinessScore,
} from "../.test-build/readiness.js";

// `Date.parse` of an ISO string without a zone is local time — the same clock
// the browser hands `daysUntilDate` through `Date.now()` — so these cases hold
// whatever zone the test runner starts in.
test("daysUntilDate counts to the local end of the deadline day", () => {
  assert.equal(daysUntilDate("2026-09-10", Date.parse("2026-09-10T20:00:00")), 1, "due today reads 1, not 0");
  assert.equal(daysUntilDate("2026-09-10", Date.parse("2026-09-10T00:00:00")), 1);
  assert.equal(daysUntilDate("2026-09-11", Date.parse("2026-09-10T20:00:00")), 2);
  assert.ok(daysUntilDate("2026-09-08", Date.parse("2026-09-10T08:00:00")) < 0, "two days back is overdue");
  assert.equal(daysUntilDate("2026-09-08", Date.parse("2026-09-10T08:00:00")), -1);
  assert.equal(
    daysUntilDate("2026-09-08T00:00:00.000Z", Date.parse("2026-09-10T08:00:00")),
    -1,
    "only the date part of a timestamp is read",
  );
});

test("credentialProgress is a clamped whole percentage and 100 for a zero-hour credential", () => {
  const base = { requirements: [], tasks: [] };
  assert.equal(credentialProgress({ ...base, totalRequired: 10, totalEarned: 2.5 }), 25);
  assert.equal(credentialProgress({ ...base, totalRequired: 3, totalEarned: 1 }), 33);
  assert.equal(credentialProgress({ ...base, totalRequired: 10, totalEarned: 14 }), 100, "over-earned caps at 100");
  assert.equal(credentialProgress({ ...base, totalRequired: 0, totalEarned: 0 }), 100, "no numeric total means nothing left to earn");
  assert.equal(clampPercent(-4), 0);
  assert.equal(clampPercent(140.4), 100);
});

test("readinessScore splits a zero-hour credential 60/40 between requirements and tasks", () => {
  const met = { requiredUnits: 1, kind: "minimum", earnedUnits: 1 };
  const unmet = { requiredUnits: 1, kind: "minimum", earnedUnits: 0 };
  const done = { status: "completed" };
  const pending = { status: "pending" };
  const zeroHour = (requirements, tasks) => ({ totalRequired: 0, totalEarned: 0, requirements, tasks });
  assert.equal(readinessScore(zeroHour([met], [done, done])), 100);
  assert.equal(readinessScore(zeroHour([unmet], [pending, pending])), 0);
  assert.equal(readinessScore(zeroHour([met], [pending, pending])), 60);
  assert.equal(readinessScore(zeroHour([unmet], [done, done])), 40);
  assert.equal(readinessScore(zeroHour([], [pending])), 60, "with no requirements the requirement share counts as met");
  assert.equal(readinessScore(zeroHour([unmet], [])), 40, "with no tasks the task share counts as met");
});

test("readinessScore weights an hour-based credential 70/15/15 and holds at 99 while credits are unclassified", () => {
  const credential = {
    totalRequired: 10,
    totalEarned: 10,
    requirements: [{ requiredUnits: 10, kind: "minimum", earnedUnits: 10 }],
    tasks: [{ status: "completed" }],
  };
  assert.equal(readinessScore(credential), 100);
  assert.equal(readinessScore({ ...credential, classificationIssues: [{ id: "x" }] }), 99);
  assert.equal(
    readinessScore({
      ...credential,
      totalEarned: 5,
      requirements: [{ requiredUnits: 10, kind: "minimum", earnedUnits: 5 }],
      tasks: [{ status: "pending" }],
    }),
    35,
  );
  assert.equal(
    readinessScore({ ...credential, requirements: [{ requiredUnits: 10, kind: "minimum", earnedUnits: 10, applicabilityStatus: "needs_confirmation" }] }),
    85,
    "an unresolved conditional counts as an unmet requirement",
  );
});
