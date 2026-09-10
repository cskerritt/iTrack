import test from "node:test";
import assert from "node:assert/strict";
import { AuthStore } from "../deploy/railway/auth.mjs";
import { applyBootstrapUsers, parseBootstrapUsers } from "../deploy/railway/bootstrap.mjs";

test("parseBootstrapUsers splits entries on ; and each on the first : only", () => {
  assert.deepEqual(parseBootstrapUsers(undefined), []);
  assert.deepEqual(parseBootstrapUsers("  "), []);
  assert.deepEqual(
    parseBootstrapUsers("Ops@Example.test:pa:ss:word-1; two@example.test:another-secret-2 ;"),
    [
      { email: "ops@example.test", password: "pa:ss:word-1" },
      { email: "two@example.test", password: "another-secret-2" },
    ],
  );
});

test("parseBootstrapUsers rejects malformed entries without echoing the password", () => {
  for (const raw of ["nocolon", "not-an-email:longenough-1", "ok@example.test:short"]) {
    assert.throws(() => parseBootstrapUsers(raw), (error) => {
      assert.match(error.message, /AUTH_BOOTSTRAP_USERS/);
      assert.doesNotMatch(error.message, /longenough-1|short/);
      return true;
    }, raw);
  }
});

test("applyBootstrapUsers creates verified accounts once and never touches existing ones", () => {
  const store = new AuthStore(":memory:");
  const pending = store.createUser({ email: "pending@example.test", displayName: "P", password: "pending-pass-1" });
  const lines = [];
  const entries = parseBootstrapUsers("new@example.test:new-secret-123;pending@example.test:boot-secret-123");
  const first = applyBootstrapUsers(store, entries, (line) => lines.push(line));
  assert.deepEqual(first, { created: ["new@example.test"], skipped: ["pending@example.test"] });
  assert.equal(store.authenticate("new@example.test", "new-secret-123").ok, true, "verified on creation");
  assert.equal(store.authenticate("pending@example.test", "boot-secret-123").ok, false, "existing row untouched");
  assert.equal(
    store.authenticate("pending@example.test", "boot-secret-123").reason,
    "bad-credentials",
    "the bootstrap password was not written over the pending user's hash",
  );
  assert.ok(store.verifyEmail(pending.verifyToken, "pending-pass-1"), "the pending user's own link still works");
  assert.equal(
    store.authenticate("pending@example.test", "pending-pass-1").ok,
    true,
    "the pending user's own password still works once verified",
  );
  const second = applyBootstrapUsers(store, entries, (line) => lines.push(line));
  assert.deepEqual(second, { created: [], skipped: ["new@example.test", "pending@example.test"] });
  for (const line of lines) {
    assert.doesNotMatch(line, /secret-123/, "passwords never reach the log");
  }
  assert.match(lines[0], /^\[auth\] bootstrap created account new@example\.test$/);
});
