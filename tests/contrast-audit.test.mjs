// Gate for the design-system contrast invariant (spec §9 "Contrast"): every
// stylesheet under app/ and every public page's <style> blocks pass
// tools/contrast-audit.mjs — each documented claim holds, and no colour
// literal sits outside a token file's token blocks. After Wave 3 the ONLY
// token file under app/ is app/styles/tokens.css; every other stylesheet
// under app/ is a consumer with zero literals, and a new stylesheet may not
// even reference a legacy alias. The tool is run exactly as a person runs
// it, so the exit code and the report lines are what is pinned. Build-free:
// `node --test tests/contrast-audit.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditStylesheet, collectStylesheets, tokenBlocks } from "../tools/contrast-audit.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = ["landing", "login", "signup", "verify", "reset"];
const TOKEN_FILE = "app/styles/tokens.css";
// The stylesheets ITrackApp.tsx's un-extracted screens still render on. They
// may reference the LEGACY ALIASES block; Wave 4 deletes them with it.
// Everything else under app/ is new code and may not.
const LEGACY_STYLESHEETS = new Set([
  "app/styles/legacy-shared.css",
  "app/styles/home.css",
  "app/styles/credentials.css",
  "app/styles/credential-detail.css",
  "app/styles/log-activity.css",
  "app/styles/history.css",
  "app/styles/account.css",
]);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const runAudit = (...args) =>
  spawnSync(process.execPath, ["tools/contrast-audit.mjs", ...args], { cwd: root, encoding: "utf8" });

const appSheets = () => collectStylesheets(root).filter((sheet) => sheet.path.startsWith("app/"));

// Every `--name:` declared after the LEGACY ALIASES banner of tokens.css. The
// block is the last thing in the file, so everything after the banner is an
// alias declaration or a comment; the tool never reads claims from it.
function legacyAliasNames() {
  const css = readFileSync(path.join(root, TOKEN_FILE), "utf8");
  const start = css.indexOf("LEGACY ALIASES");
  assert.ok(start > 0, "tokens.css carries the LEGACY ALIASES banner");
  return [...css.slice(start).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]);
}

test("every stylesheet and public page passes the contrast audit", () => {
  const run = runAudit();
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^contrast-audit: app\/styles\/tokens\.css — \d+ claims, 0 failing, 0 literals$/m);
  for (const sheet of appSheets()) {
    if (sheet.path === TOKEN_FILE) continue;
    assert.match(
      run.stdout,
      new RegExp(`^contrast-audit: ${escapeRegExp(sheet.path)} — 0 claims, 0 failing, 0 literals$`, "m"),
      `${sheet.path} is a consumer: no claims, no literals`,
    );
  }
  for (const page of PAGES) {
    assert.match(
      run.stdout,
      new RegExp(`^contrast-audit: deploy/railway/pages/${page}\\.html — 0 claims, 0 failing, 0 literals$`, "m"),
    );
  }
  assert.match(run.stdout, /^contrast-audit: \d+ stylesheets, 0 failing claims, 0 colour literals outside token blocks$/m);
});

test("app/styles/tokens.css is the only token file under app/; every other stylesheet is a consumer", () => {
  const sheets = appSheets();
  assert.deepEqual(
    sheets.filter((sheet) => sheet.kind === "tokens").map((sheet) => sheet.path),
    [TOKEN_FILE],
    "a stylesheet whose first rule is `:root {` would be read for claims and masked for literals",
  );
  const tokens = sheets.find((sheet) => sheet.path === TOKEN_FILE);
  const blocks = tokenBlocks(tokens.css);
  assert.ok(blocks.light && blocks.dark, "tokens.css has a :root block and one prefers-color-scheme: dark remap");
  assert.equal(blocks.forced, null, "forced-colors blocks live in the consumer that owns the mark, never in tokens.css");
  const report = auditStylesheet(tokens.css, tokens);
  assert.ok(report.claims.length >= 75, "every ink, state pair, mark and focus ring documents its ratio in both blocks");
  // A lift — rgb(var(--lift-rgb) / a) laid over a panel — is a channel triple
  // no other claim reaches, so the inks consumers set on it claim their ratio
  // over it in BOTH schemes. A light lift under the light dark-scheme inks
  // (the Home check-in buttons at 1.4:1) is the regression this pins.
  for (const scheme of ["light", "dark"]) {
    const lifts = report.claims.filter(
      (claim) => claim.scheme === scheme && /^--lift-rgb@[\d.]+ over --/.test(claim.surfaceExpr),
    );
    assert.ok(lifts.length >= 3, `${scheme}: the inks that sit on a lift claim their ratio over it (${lifts.length})`);
    for (const claim of lifts) {
      assert.equal(claim.result, "pass", `${scheme} ${claim.subject} on ${claim.surfaceExpr}: ${claim.result}`);
      assert.ok(claim.actual >= 4.5, `${scheme} ${claim.subject} on ${claim.surfaceExpr} measures ${claim.actual}`);
    }
  }
  const globals = sheets.find((sheet) => sheet.path === "app/globals.css");
  assert.ok(globals, "app/globals.css is walked");
  assert.equal(globals.kind, "consumer", "globals.css opens with @import + resets, never :root");
  const byPath = new Map(collectStylesheets(root).map((sheet) => [sheet.path, sheet]));
  for (const page of PAGES) {
    const sheet = byPath.get(`deploy/railway/pages/${page}.html`);
    assert.ok(sheet, `${page}.html is walked`);
    assert.equal(sheet.kind, "tokens", `${page}.html inlines its own :root`);
    const pageBlocks = tokenBlocks(sheet.css);
    assert.ok(pageBlocks.light, `${page}.html has a :root block`);
    assert.equal(pageBlocks.dark, null, `${page}.html has no dark block — an absent block is null, not the first block`);
    assert.equal(pageBlocks.forced, null, `${page}.html has no forced-colors block`);
  }
});

test("no new stylesheet references a legacy alias", () => {
  const names = legacyAliasNames();
  assert.ok(names.length >= 100, `the alias block maps every pre-Wave-3 name (${names.length})`);
  assert.ok(names.includes("--white") && names.includes("--font-ui"), "the banner is followed by the alias declarations");
  const scanned = [];
  for (const sheet of appSheets()) {
    if (sheet.path === TOKEN_FILE || LEGACY_STYLESHEETS.has(sheet.path)) continue;
    scanned.push(sheet.path);
    for (const name of names) {
      assert.doesNotMatch(
        sheet.css,
        new RegExp(`var\\(${escapeRegExp(name)}[\\s,)]`),
        `${sheet.path} references the legacy alias ${name}`,
      );
    }
  }
  // Vacuous until the first new stylesheet exists (Task 4 adds fonts.css);
  // from then on every new file under app/ is scanned.
  assert.deepEqual(
    scanned,
    appSheets().map((sheet) => sheet.path).filter((p) => p !== TOKEN_FILE && !LEGACY_STYLESHEETS.has(p)),
  );
});

test("a consumer stylesheet masks nothing: a literal anywhere in it fails, even inside a :root", () => {
  const report = auditStylesheet(".card { color: #123456; }\n:root { --x: #ffffff; }\n", {
    path: "app/styles/example.css",
    kind: "consumer",
  });
  assert.equal(report.claims.length, 0);
  assert.deepEqual(report.literals.map((l) => `${l.line}:${l.text}`), ["1:#123456", "2:#ffffff"]);
});

test("a colour literal injected into a page fails the run and is named by file and line", () => {
  const source = readFileSync(path.join(root, "deploy", "railway", "pages", "login.html"), "utf8");
  const injected = source.replace(".btn-primary:hover {", ".btn-primary:hover { color: #123456;");
  assert.notEqual(injected, source, "the hover rule is where the literal is injected");
  const line = injected.split("\n").findIndex((text) => text.includes("#123456")) + 1;
  const dir = mkdtempSync(path.join(tmpdir(), "contrast-audit-"));
  try {
    const copy = path.join(dir, "login.html");
    writeFileSync(copy, injected);
    const run = runAudit(copy);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(
      run.stdout,
      new RegExp(`^  FAIL .*login\\.html:L${line} colour literal outside token blocks: #123456$`, "m"),
    );
    assert.match(run.stdout, /^contrast-audit: 1 stylesheets, 0 failing claims, 1 colour literals outside token blocks$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
