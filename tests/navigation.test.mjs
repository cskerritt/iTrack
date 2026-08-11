// The nav stack's URL contract lives in two pure functions, so it is tested
// directly rather than through the app shell: `parseRoute` is what a cold
// deep-link (or a `popstate` from the iOS back gesture) resolves to, and
// `buildPath` is what we hand to `pushState`/`replaceState`. If those two ever
// disagree, back/forward silently lands on the wrong screen.
//
// `app/lib/navigation.ts` has no bundler entry of its own, so `npm run test:nav`
// compiles just that file with `tsc --outDir .test-build` first and this suite
// imports the emitted ESM.

import assert from "node:assert/strict";
import test from "node:test";

import {
  NAV_STATE_KEY,
  buildPath,
  isTabName,
  parseRoute,
  readNavEntry,
  routeAt,
  withNavEntry,
} from "../.test-build/navigation.js";

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

test("a history entry carries its own depth and origin tab", () => {
  const stamped = withNavEntry(null, { depth: 2, tab: "home" });
  assert.deepEqual(readNavEntry(stamped), { depth: 2, tab: "home" });

  // Whatever else the platform keeps in the state survives the stamp.
  const shared = withNavEntry({ __next: "scroll" }, { depth: 1, tab: "history" });
  assert.equal(shared.__next, "scroll");
  assert.deepEqual(readNavEntry(shared), { depth: 1, tab: "history" });

  // Anything that is not ours reads as "no entry", which the app treats as
  // depth 0 — the floor that stops `pop()` calling history.back() out of the
  // app on a cold deep link.
  for (const foreign of [null, undefined, "", 7, [], { other: 1 }]) {
    assert.equal(readNavEntry(foreign), null, JSON.stringify(foreign) ?? "undefined");
  }
  for (const malformed of [
    { [NAV_STATE_KEY]: null },
    { [NAV_STATE_KEY]: { depth: 1 } },
    { [NAV_STATE_KEY]: { tab: "home" } },
    { [NAV_STATE_KEY]: { depth: "1", tab: "home" } },
    { [NAV_STATE_KEY]: { depth: Number.NaN, tab: "home" } },
    { [NAV_STATE_KEY]: { depth: 1, tab: "nope" } },
  ]) {
    assert.equal(readNavEntry(malformed), null, JSON.stringify(malformed));
  }
  assert.deepEqual(readNavEntry(withNavEntry(null, { depth: -3, tab: "profile" })), {
    depth: 0,
    tab: "profile",
  });
});

test("routeAt restores the tab a detail screen was pushed from", () => {
  // /credentials/<id> is the same URL whether the screen was opened from the
  // Credentials list or from a Home card, so the entry is what remembers.
  assert.deepEqual(routeAt("/credentials/abc123", { depth: 1, tab: "home" }), {
    tab: "home",
    detail: { kind: "credential", id: "abc123" },
  });
  assert.deepEqual(routeAt("/credentials/abc123", { depth: 1, tab: "credentials" }), {
    tab: "credentials",
    detail: { kind: "credential", id: "abc123" },
  });
  // A cold deep link has no entry of ours; the URL is then the whole story.
  assert.deepEqual(routeAt("/credentials/abc123", null), {
    tab: "credentials",
    detail: { kind: "credential", id: "abc123" },
  });
  // A tab root is never overridden by a stale entry: the URL names the tab.
  assert.deepEqual(routeAt("/history", { depth: 0, tab: "home" }), {
    tab: "history",
    detail: null,
  });
});
