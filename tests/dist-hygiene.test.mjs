// Build-output hygiene (audit perf-08). vinext copies its whole `.vinext/fonts`
// Google-Fonts cache into dist/client/assets/_vinext_fonts/ on every client
// build with no reference check, and its server build sets emptyOutDir: false,
// so a cache left behind by a removed `next/font` import ships dead woff2
// files until someone deletes it. Nothing in app/ requests a font. `npm test`
// builds before running this file, so the dist assertion sees the build it
// just made; with no dist at all it is vacuously true.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the build emits no cached Google-Fonts files (perf-08)", () => {
  assert.ok(
    !existsSync(path.join(root, "dist", "client", "assets", "_vinext_fonts")),
    "delete .vinext/fonts (vinext copies the whole cache into dist) plus any stale dist/client/assets/_vinext_fonts, then rebuild",
  );
  assert.match(
    readFileSync(path.join(root, ".dockerignore"), "utf8"),
    /^\.vinext$/m,
    ".dockerignore must list .vinext so a local docker build cannot carry the font cache into the image",
  );
});
