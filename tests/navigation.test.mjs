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

import { buildPath, parseRoute } from "../.test-build/navigation.js";

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
