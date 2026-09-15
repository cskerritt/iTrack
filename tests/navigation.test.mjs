// The URL contract lives in two pure functions, so it is tested directly
// rather than through the app shell: `parseRoute` is what a cold deep link or
// a popstate resolves to, and `buildPath` is what useNavigation hands to
// pushState/replaceState. If those two ever disagree, Back and Forward
// silently land on the wrong screen.
//
// `app/lib/navigation.ts` has no bundler entry of its own, so `npm run
// build:lib-test` compiles it with `tsc --outDir .test-build` first and this
// suite imports the emitted ESM.

import assert from "node:assert/strict";
import test from "node:test";

import { buildPath, isTabName, parseRoute } from "../.test-build/navigation.js";

test("parseRoute maps pathnames to routes", () => {
  assert.deepEqual(parseRoute("/"), { tab: "home", detail: null });
  assert.deepEqual(parseRoute("/credentials"), { tab: "credentials", detail: null });
  assert.deepEqual(parseRoute("/credentials/abc123"), {
    tab: "credentials",
    detail: { kind: "credential", id: "abc123" },
  });
  assert.deepEqual(parseRoute("/history"), { tab: "history", detail: null });
  assert.deepEqual(parseRoute("/profile"), { tab: "profile", detail: null });
  // unknown → home root (spec: deep-link fallback)
  assert.deepEqual(parseRoute("/nope/xyz"), { tab: "home", detail: null });
});

test("buildPath is the inverse of parseRoute", () => {
  for (const path of ["/", "/credentials", "/credentials/abc123", "/history", "/profile"]) {
    assert.equal(buildPath(parseRoute(path)), path === "/" ? "/" : path);
  }
});

test("isTabName accepts only the four tabs", () => {
  for (const tab of ["home", "credentials", "history", "profile"]) {
    assert.equal(isTabName(tab), true, tab);
  }
  for (const value of ["today", "records", "account", "", null, undefined, 3, {}]) {
    assert.equal(isTabName(value), false, String(value));
  }
});

// spec §5.1: the URL is the whole story. Nothing is stamped on a history
// entry any more, so nothing can read a tab or a depth back off one.
test("the depth/origin-tab history state is gone (spec §5.1)", async () => {
  const navigation = await import("../.test-build/navigation.js");
  for (const name of ["NAV_STATE_KEY", "readNavEntry", "withNavEntry", "routeAt"]) {
    assert.equal(name in navigation, false, `${name} is no longer exported`);
  }
});
