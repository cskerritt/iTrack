import assert from "node:assert/strict";
import test from "node:test";
import {
  ClientErrorThrottle,
  STACK_LIMIT,
  buildClientErrorReport,
  describeError,
} from "../.test-build/clientError.js";

test("describeError handles Error, string, and junk", () => {
  const fromError = describeError(new Error("x is null"));
  assert.equal(fromError.message, "x is null");
  assert.match(fromError.stack, /^Error: x is null/);
  assert.deepEqual(describeError("plain string"), { message: "plain string", stack: "" });
  assert.deepEqual(describeError(null), { message: "Unknown error", stack: "" });
  assert.deepEqual(describeError({ message: 42 }), { message: "Unknown error", stack: "" });
});

test("buildClientErrorReport clips the stack to 2 kB and carries the context", () => {
  const error = new Error("boom");
  error.stack = `Error: boom\n${"at frame\n".repeat(600)}`;
  const report = buildClientErrorReport(error, { route: "/credentials/abc", userAgent: "UA", at: "2026-09-10T12:00:00.000Z" });
  assert.equal(report.message, "boom");
  assert.equal(report.stack.length, STACK_LIMIT);
  assert.equal(report.route, "/credentials/abc");
  assert.equal(report.userAgent, "UA");
  assert.equal(report.at, "2026-09-10T12:00:00.000Z");
});

test("ClientErrorThrottle allows 10 per minute", () => {
  const throttle = new ClientErrorThrottle();
  for (let i = 0; i < 10; i += 1) assert.equal(throttle.allow(1_000 + i), true, `report ${i}`);
  assert.equal(throttle.allow(1_010), false);
  assert.equal(throttle.allow(1_000 + 60_000), true, "window rolls over");
});
