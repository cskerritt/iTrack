// Build-output hygiene (audit perf-08). vinext copies its whole `.vinext/fonts`
// Google-Fonts cache into dist/client/assets/_vinext_fonts/ on every client
// build with no reference check, and its server build sets emptyOutDir: false,
// so a cache left behind by a removed `next/font` import ships dead woff2
// files until someone deletes it. The only fonts the app requests are the
// self-hosted subsets under public/fonts/ (tests/fonts.test.mjs), which the
// build copies to dist/client/fonts/ and the stylesheet declares with
// @font-face (spec §5.1 Type). `npm test` builds before running this file,
// so the dist assertions see the build it just made; with no dist at all they
// are vacuously true.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FONT_FILES } from "../.test-build/fonts.js";

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

test("the built stylesheet self-hosts every face and requests none elsewhere (perf-08, a11y-14)", () => {
  // Build-free half: the immutable cache rule for the hashed files.
  assert.match(
    readFileSync(path.join(root, "public", "_headers"), "utf8"),
    /^\/fonts\/\*\n\s+Cache-Control: public, max-age=31536000, immutable$/m,
    "public/_headers must serve /fonts/* immutable — the names carry a content hash",
  );
  const assets = path.join(root, "dist", "client", "assets");
  if (!existsSync(assets)) return;
  const css = readdirSync(assets)
    .filter((name) => name.endsWith(".css"))
    .map((name) => readFileSync(path.join(assets, name), "utf8"))
    .join("\n");
  assert.ok(css.length > 0, "the build emitted a stylesheet under dist/client/assets");
  assert.doesNotMatch(css, /fonts\.googleapis\.com|fonts\.gstatic\.com/, "no Google Fonts request");
  const referenced = [...css.matchAll(/url\((?:"|')?(\/fonts\/[^"')]+)/g)].map((match) => match[1]);
  const files = new Set(Object.values(FONT_FILES));
  for (const href of referenced) {
    assert.ok(files.has(href), `${href} is referenced by the stylesheet but is not in app/lib/fonts.ts`);
  }
  for (const href of files) {
    assert.ok(referenced.includes(href), `${href} has no @font-face in the built stylesheet`);
  }
  // a11y-14: the scale is rem. The one px, --text-control, is a custom
  // property declaration this regex does not match.
  assert.doesNotMatch(css, /font-size:\s*(?:[\d.]+px|clamp\([^)]*px)/, "no px font-size in the built CSS");
  assert.deepEqual(
    readdirSync(path.join(root, "dist", "client", "fonts")).filter((name) => name.endsWith(".woff2")).sort(),
    [...files].map((href) => path.basename(href)).sort(),
    "dist/client/fonts holds exactly the seven subsets",
  );
});
