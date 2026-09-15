// The log-activity sheet's browser draft is a pure module: storage keys,
// the "is there anything worth keeping" test, and a serialize/parse pair
// with a 30-day TTL. `npm run build:lib-test` compiles
// app/lib/activityDraft.ts into .test-build/ and this suite imports the
// emitted ESM. The e2e proof that the sheet actually saves and restores a
// draft lives in tests/e2e/log-activity.spec.ts.
import assert from "node:assert/strict";
import test from "node:test";

import {
  activityDraftShouldBePurged,
  activityDraftStorageKey,
  hasMeaningfulActivityDraft,
  legacyActivityDraftStorageKey,
  parseActivityDraft,
  serializeActivityDraft,
} from "../.test-build/activityDraft.js";

// A namespace is `draft_` + 64 hex characters (the server derives it from the
// user id); anything else is refused rather than silently keyed.
const NAMESPACE = `draft_${"ab".repeat(32)}`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-02T15:00:00.000Z");
const INPUT = {
  credentialId: "cred-1",
  title: "Ethics",
  provider: "Board",
  completionDate: "2026-06-02",
  totalUnits: "2",
  allocatedUnits: "1.5",
};

test("activityDraftStorageKey keeps the load-bearing license-lantern prefix and rejects a malformed namespace", () => {
  assert.equal(
    activityDraftStorageKey(NAMESPACE),
    `license-lantern:activity-draft:v1:${NAMESPACE}`,
  );
  assert.throws(() => activityDraftStorageKey("draft_abc"), /namespace is invalid/);
});

test("legacyActivityDraftStorageKey is a stable fingerprint of the email under the same prefix", () => {
  const key = legacyActivityDraftStorageKey("casey@example.com");
  assert.match(key, /^license-lantern:activity-draft:v1:[0-9a-f]+$/);
  assert.equal(legacyActivityDraftStorageKey("casey@example.com"), key, "stable across calls");
  assert.equal(legacyActivityDraftStorageKey("  Casey@Example.com "), key, "trimmed and lowercased first");
  assert.notEqual(legacyActivityDraftStorageKey("other@example.com"), key);
});

test("hasMeaningfulActivityDraft ignores the date and needs a title, units, or provider", () => {
  const empty = { title: "", completionDate: "2026-06-02", totalUnits: "", allocatedUnits: "", provider: "" };
  assert.equal(hasMeaningfulActivityDraft(empty), false);
  assert.equal(hasMeaningfulActivityDraft({ ...empty, title: "Ethics" }), true);
  assert.equal(hasMeaningfulActivityDraft({ ...empty, totalUnits: "2" }), true);
  assert.equal(hasMeaningfulActivityDraft({ ...empty, provider: "Board" }), true);
  assert.equal(hasMeaningfulActivityDraft({ ...empty, title: "   " }), false, "whitespace is not a title");
});

test("serializeActivityDraft and parseActivityDraft round-trip every field", () => {
  const parsed = parseActivityDraft(serializeActivityDraft(INPUT, NOW), NOW);
  assert.deepEqual(parsed, { version: 1, savedAt: NOW.toISOString(), ...INPUT });
});

test("parseActivityDraft rejects malformed, empty, or stale drafts", () => {
  const saved = serializeActivityDraft(INPUT, NOW);
  assert.equal(parseActivityDraft(null, NOW), null);
  assert.equal(parseActivityDraft("not json", NOW), null);
  assert.equal(
    parseActivityDraft(JSON.stringify({ version: 2, savedAt: NOW.toISOString(), title: "Ethics" }), NOW),
    null,
    "unknown version",
  );
  assert.equal(
    parseActivityDraft(serializeActivityDraft({ ...INPUT, title: "", provider: "", totalUnits: "" }, NOW), NOW),
    null,
    "a draft with nothing worth keeping is not restored",
  );
  assert.equal(parseActivityDraft(saved, new Date(NOW.getTime() + 31 * DAY)), null, "older than 30 days");
  assert.notEqual(parseActivityDraft(saved, new Date(NOW.getTime() + 29 * DAY)), null, "29 days is still recoverable");
  assert.equal(
    parseActivityDraft(saved, new Date(NOW.getTime() - 6 * 60 * 1000)),
    null,
    "a savedAt more than five minutes ahead of the clock is not trusted",
  );
});

test("activityDraftShouldBePurged is true only for a stored draft that no longer parses", () => {
  const saved = serializeActivityDraft(INPUT, NOW);
  assert.equal(activityDraftShouldBePurged(saved, new Date(NOW.getTime() + 31 * DAY)), true);
  assert.equal(activityDraftShouldBePurged(saved, new Date(NOW.getTime() + 29 * DAY)), false);
  assert.equal(activityDraftShouldBePurged(null, NOW), false, "nothing stored, nothing to purge");
  assert.equal(activityDraftShouldBePurged("garbage", NOW), true);
});
