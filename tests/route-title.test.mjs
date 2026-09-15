import assert from "node:assert/strict";
import test from "node:test";
import { TAB_LABELS, TAB_SHORT_LABELS, routeTitle } from "../.test-build/routeTitle.js";

test("tab roots title by tab name", () => {
  assert.equal(routeTitle({ tab: "home", detail: null }, null), "Home · iTrack");
  assert.equal(routeTitle({ tab: "credentials", detail: null }, null), "Credentials · iTrack");
  assert.equal(routeTitle({ tab: "history", detail: null }, null), "Activity log · iTrack");
  assert.equal(routeTitle({ tab: "profile", detail: null }, null), "Account · iTrack");
});

test("a routed credential titles by its name, with a fallback while loading", () => {
  const detail = { kind: "credential", id: "abc" };
  assert.equal(routeTitle({ tab: "credentials", detail }, "Licensed Clinical Social Worker"), "Licensed Clinical Social Worker · iTrack");
  assert.equal(routeTitle({ tab: "home", detail }, null), "Credential · iTrack");
  assert.equal(routeTitle({ tab: "home", detail }, "   "), "Credential · iTrack");
});

// architecture-15: the rail, the bottom nav and the document title read one
// record. A label that changed in one place and not the other is the bug.
test("the labels are the single source: the title is built from them", () => {
  assert.deepEqual(TAB_LABELS, {
    home: "Home",
    credentials: "Credentials",
    history: "Activity log",
    profile: "Account",
  });
  for (const tab of Object.keys(TAB_LABELS)) {
    assert.equal(routeTitle({ tab, detail: null }, null), `${TAB_LABELS[tab]} · iTrack`);
  }
});

test("the phone label shortens only Activity log", () => {
  assert.equal(TAB_SHORT_LABELS.history, "Activity");
  for (const tab of ["home", "credentials", "profile"]) {
    assert.equal(TAB_SHORT_LABELS[tab], TAB_LABELS[tab], tab);
  }
});
