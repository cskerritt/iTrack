// Pins the six legacy identifiers that predate the iTrack product name and are
// load-bearing (audit ios-coupling-11; spec 2026-09-10 §4 "iOS residue sweep").
// Each is keyed into state that outlives a deploy — users.id hashes, browser
// localStorage, subscribers' calendars, installed service workers, and the R2
// volume — so a rename would orphan data, not tidy a name.
//
// Every pin is the literal inside the exact expression that uses it, searched
// across the runtime source trees rather than at a fixed path, so the Wave 2-4
// file moves cannot break it but a rename-happy cleanup cannot slip past it.
// Needs no build: `node --test tests/protected-identifiers.test.mjs`.
//
// Deliberately NOT pinned (renameable): the `ll-` notification tag prefix in
// app/lib/pushDelivery.ts (tags are per delivery), the
// `license-lantern-packet-version` meta in app/lib/renewalPacket.ts
// (informational), the `lantern-spin` keyframe in app/globals.css, and the
// tests' `__LICENSE_LANTERN_TEST_ENV__` global.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|mts|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

// The trees that hold runtime code, plus two single files: public/sw.js is
// served at /sw.js (its path is a URL contract, not layout) and the wrangler
// bindings live inline in vite.config.ts (there is no wrangler.toml).
const sources = [
  ...["db", "app", "worker"].flatMap((dir) => walk(path.join(root, dir))),
  path.join(root, "public", "sw.js"),
  path.join(root, "vite.config.ts"),
].map((file) => ({
  file: path.relative(root, file),
  source: readFileSync(file, "utf8"),
}));

function occurrences(pattern) {
  const found = [];
  for (const { file, source } of sources) {
    const count = (source.match(pattern) ?? []).length;
    if (count > 0) found.push(`${file} x${count}`);
  }
  return found;
}

const PROTECTED = {
  "workspace identity hash salt `license-lantern:`": {
    pattern: /new TextEncoder\(\)\.encode\(`license-lantern:\$\{email\}`\)/g,
    expectedIn: "db/identity.ts (stableUserId)",
    why: "users.id is usr_<sha256('license-lantern:' + email)>; a new salt orphans every workspace",
  },
  "activity draft localStorage prefix `license-lantern:activity-draft:v1:`": {
    pattern: /`license-lantern:activity-draft:v1:\$\{/g,
    expectedIn: "app/lib/activityDraft.ts (both key builders) and app/api/workspace/route.ts (legacy key)",
    why: "renaming strands every draft already saved in a user's browser",
  },
  "ICS UID domain `@license-lantern`": {
    pattern: /`UID:\$\{safeUid\(event\.uid\)\}@license-lantern`/g,
    expectedIn: "app/lib/calendarInvite.ts",
    why: "calendars match a re-downloaded event by UID; a new domain duplicates every check-in already added",
  },
  "web push topic `license-lantern-check-in`": {
    pattern: /"license-lantern-check-in"/g,
    expectedIn: "app/lib/pushDelivery.ts (GENERIC_TOPIC) and public/sw.js (safeNotificationTag fallback)",
    why: "collapses a device's pending alerts; the installed service worker falls back to the same string",
  },
  "service-worker cache prefix `license-lantern-static`": {
    pattern: /const CACHE_PREFIX = "license-lantern-static";/g,
    expectedIn: "public/sw.js",
    why: "the activate handler deletes every cache starting with it; a rename leaves old caches on every installed device forever",
  },
  "R2 bucket name `vigilo-r2`": {
    pattern: /bucket_name: "vigilo-r2"/g,
    expectedIn: "vite.config.ts (r2_buckets)",
    why: "miniflare keys on-disk R2 state by bucket_name; a rename orphans every evidence object on the Railway volume",
  },
};

for (const [name, { pattern, expectedIn, why }] of Object.entries(PROTECTED)) {
  test(`protected identifier: ${name}`, () => {
    const found = occurrences(pattern);
    assert.ok(
      found.length > 0,
      `${name} is gone from db/, app/, worker/, public/sw.js and vite.config.ts (last seen in ${expectedIn}). It is load-bearing: ${why}. Put the literal back — see audit ios-coupling-11.`,
    );
  });
}

test("the push topic is pinned on both sides: a server sender and public/sw.js", () => {
  const found = occurrences(/"license-lantern-check-in"/g);
  assert.ok(
    found.some((entry) => entry.startsWith(path.join("public", "sw.js"))),
    `public/sw.js lost its fallback topic; found in: ${found.join(", ") || "nowhere"}`,
  );
  assert.ok(
    found.some((entry) => !entry.startsWith(path.join("public", "sw.js"))),
    `no server-side sender declares the topic; found in: ${found.join(", ") || "nowhere"}`,
  );
});

test("the draft prefix is pinned on both sides: the client key builders and the server's legacy key", () => {
  const found = occurrences(/`license-lantern:activity-draft:v1:\$\{/g);
  assert.ok(found.some((entry) => entry.startsWith(path.join("app", "lib"))), `client key builder missing; found in: ${found.join(", ") || "nowhere"}`);
  assert.ok(found.some((entry) => entry.startsWith(path.join("app", "api"))), `server legacy key missing; found in: ${found.join(", ") || "nowhere"}`);
});

test("no renamed variant of a protected identifier has crept in", () => {
  for (const pattern of [
    /encode\(`itrack:\$\{email\}`\)/g,
    /`itrack:activity-draft:/g,
    /@itrack`/g,
    /"itrack-check-in"/g,
    /const CACHE_PREFIX = "itrack/g,
    /bucket_name: "itrack/g,
  ]) {
    assert.deepEqual(
      occurrences(pattern),
      [],
      `${pattern} found — the legacy spelling is the contract; the product rename never reaches these literals`,
    );
  }
});

// Not one of the six, but db/identity.ts calls it load-bearing for the same
// reason: the demo workspace's id derives from it, and the Wave 2 e2e suite
// runs as the demo identity.
test("demo identity email `demo@local.license-lantern`", () => {
  assert.ok(
    occurrences(/const DEMO_EMAIL = "demo@local\.license-lantern";/g).length > 0,
    "db/identity.ts DEMO_EMAIL changed — the demo workspace id is sha256 of the salt + this address",
  );
});
