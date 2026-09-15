// The self-hosted type contract (spec §5.1 Type; audit perf-08; mockup
// decision 4): exactly the faces named by app/lib/fonts.ts exist under
// public/fonts/, each a woff2 within the 40 kB budget under a content-hashed
// name (the /fonts/ cache rule is immutable), with the OFL texts beside them;
// the preload list is the four first-paint faces. Reads public/fonts and the
// compiled manifest only — never a stylesheet or a component as text
// (architecture-03). Build-free after `npm run build:lib-test`.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FONT_BUDGET_BYTES, FONT_FILES, FONT_PRELOADS } from "../.test-build/fonts.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONTS = path.join(root, "public", "fonts");
const LICENCES = ["OFL-bricolage-grotesque.txt", "OFL-atkinson-hyperlegible.txt", "OFL-ibm-plex-mono.txt"];
// .DS_Store and friends are not part of the contract.
const entries = () => readdirSync(FONTS).filter((name) => !name.startsWith("."));

test("public/fonts holds exactly the manifest's seven faces, each a hashed woff2 within the 40 kB budget (perf-08)", () => {
  const expected = Object.values(FONT_FILES).map((href) => path.basename(href)).sort();
  assert.equal(expected.length, 7, "display 700/800, body 400/700/400 italic, mono 400/500");
  assert.deepEqual(entries().filter((name) => name.endsWith(".woff2")).sort(), expected);
  for (const name of expected) {
    const file = path.join(FONTS, name);
    const size = statSync(file).size;
    assert.ok(
      size <= FONT_BUDGET_BYTES,
      `${name} is ${size} B; the budget is ${FONT_BUDGET_BYTES} B — re-run tools/fonts/build-fonts.sh (a Bricolage instance over budget means the opsz axis was left live)`,
    );
    assert.equal(readFileSync(file).subarray(0, 4).toString("ascii"), "wOF2", `${name} is not a woff2 file`);
    assert.match(name, /^[a-z0-9-]+-[0-9a-f]{8}\.woff2$/, `${name} carries an 8-hex content hash`);
  }
  for (const [key, href] of Object.entries(FONT_FILES)) {
    assert.match(href, /^\/fonts\/[a-z0-9-]+-[0-9a-f]{8}\.woff2$/, `${key} is served from /fonts/ under a hashed name`);
  }
});

test("the OFL licence text ships beside every family, and Plex is renamed for its Reserved Font Name", () => {
  assert.deepEqual(
    entries().filter((name) => !name.endsWith(".woff2")).sort(),
    [...LICENCES].sort(),
    "public/fonts holds the seven subsets and the three licence texts, nothing else",
  );
  for (const name of LICENCES) {
    assert.match(readFileSync(path.join(FONTS, name), "utf8"), /SIL Open Font License, Version 1\.1/, name);
  }
  assert.match(readFileSync(path.join(FONTS, "OFL-ibm-plex-mono.txt"), "utf8"), /Reserved Font Name "Plex"/);
  // A subset is a Modified Version (OFL §1; FAQ 2.6, 2.8) and may not carry
  // the reserved name, so the mono faces ship as "iTrack Mono".
  assert.match(FONT_FILES.mono, /^\/fonts\/itrack-mono-400-/);
  assert.match(FONT_FILES.monoMedium, /^\/fonts\/itrack-mono-500-/);
});

test("only the four first-paint faces are preloaded, in the order they are needed", () => {
  assert.deepEqual(
    [...FONT_PRELOADS],
    [FONT_FILES.body, FONT_FILES.bodyBold, FONT_FILES.displayBold, FONT_FILES.displayBlack],
  );
  assert.equal(new Set(FONT_PRELOADS).size, 4);
});
