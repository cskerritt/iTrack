// Gate for the design-system contrast invariant (spec §9 "Contrast"): every
// stylesheet under app/ and every public page's <style> blocks pass
// tools/contrast-audit.mjs — each documented claim holds, and no colour
// literal sits outside a token file's token blocks. The tool is run exactly
// as a person runs it, so the exit code and the report lines are what is
// pinned. Build-free: `node --test tests/contrast-audit.test.mjs`.
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

const runAudit = (...args) =>
  spawnSync(process.execPath, ["tools/contrast-audit.mjs", ...args], { cwd: root, encoding: "utf8" });

test("every stylesheet and public page passes the contrast audit", () => {
  const run = runAudit();
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^contrast-audit: app\/globals\.css — \d+ claims, 0 failing, 0 literals$/m);
  for (const page of PAGES) {
    assert.match(
      run.stdout,
      new RegExp(`^contrast-audit: deploy/railway/pages/${page}\\.html — 0 claims, 0 failing, 0 literals$`, "m"),
    );
  }
  assert.match(run.stdout, /^contrast-audit: \d+ stylesheets, 0 failing claims, 0 colour literals outside token blocks$/m);
});

test("the walker classifies globals.css and every page as token files and reads their blocks", () => {
  const byPath = new Map(collectStylesheets(root).map((sheet) => [sheet.path, sheet]));
  const globals = byPath.get("app/globals.css");
  assert.ok(globals, "app/globals.css is walked");
  assert.equal(globals.kind, "tokens", "its first rule after `@import \"tailwindcss\";` is `:root {`");
  const blocks = tokenBlocks(globals.css);
  assert.ok(blocks.light && blocks.dark && blocks.forced, "globals.css has light, dark and forced-colors blocks");
  assert.ok(auditStylesheet(globals.css, globals).claims.length >= 90, "claims are read from the token blocks");
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
