import assert from "node:assert/strict";
import test from "node:test";
import { routeTitle } from "../.test-build/routeTitle.js";

test("tab roots title by tab name", () => {
  assert.equal(routeTitle({ tab: "home", detail: null }, null), "Home · iTrack");
  assert.equal(routeTitle({ tab: "credentials", detail: null }, null), "Credentials · iTrack");
  assert.equal(routeTitle({ tab: "history", detail: null }, null), "History · iTrack");
  assert.equal(routeTitle({ tab: "profile", detail: null }, null), "Profile · iTrack");
});

test("a pushed credential titles by its name, with a fallback while loading", () => {
  const detail = { kind: "credential", id: "abc" };
  assert.equal(routeTitle({ tab: "credentials", detail }, "Licensed Clinical Social Worker"), "Licensed Clinical Social Worker · iTrack");
  assert.equal(routeTitle({ tab: "home", detail }, null), "Credential · iTrack");
  assert.equal(routeTitle({ tab: "home", detail }, "   "), "Credential · iTrack");
});
