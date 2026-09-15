// Cheap, always-on regression guards over the client source. Each guard
// pins a bug class the audit found, in a form that survives file moves
// (Wave 2 extracts screens out of ITrackApp.tsx): they scan every .tsx/.ts
// file under app/, not one path.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { readClientSources, readStylesheets } from "./helpers/clientSources.mjs";
import { WORKSPACE_ACTIONS } from "./helpers/workspaceActions.mjs";

// Returns the text of every `setX((current) => …)` updater body, found by
// balancing parentheses from the opening `(` of the set call.
function updaterBodies(source) {
  const bodies = [];
  const opener = /\bset[A-Z]\w*\(\s*\(\s*(?:current|previous|prev|state)\s*\)\s*=>/g;
  let match;
  while ((match = opener.exec(source)) !== null) {
    let depth = 0;
    let index = match.index + match[0].indexOf("(");
    for (; index < source.length; index += 1) {
      const ch = source[index];
      if (ch === "(") depth += 1;
      if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push({ at: match.index, text: source.slice(match.index, index + 1) });
  }
  return bodies;
}

test("no state updater reads event.currentTarget or event.target (app-ux-01 / architecture-M-01)", () => {
  let seen = 0;
  for (const { file, source } of readClientSources()) {
    for (const body of updaterBodies(source)) {
      seen += 1;
      assert.doesNotMatch(
        body.text,
        /\bevent\.(currentTarget|target)\b/,
        `${file}@${body.at}: read the value into a local before calling the updater:\n${body.text.slice(0, 200)}`,
      );
    }
  }
  assert.ok(seen >= 7, `expected to scan at least the seven setActivityDraft updaters, scanned ${seen}`);
});

test("client code never calls .json() on a fetch Response directly (app-ux-M-01 / architecture-M-04)", () => {
  for (const { file, source } of readClientSources()) {
    if (file.startsWith("api/") || file === "lib/apiResponse.ts") continue;
    // Any receiver: `response.json()`, `res.json()`, `.then((r) => r.json())`.
    // `Response.json(data)` (the static constructor) takes arguments, so it
    // is not matched.
    assert.doesNotMatch(source, /\.json\(\s*\)/, `${file}: use readApiResponse() from app/lib/apiResponse.ts`);
  }
});

// A mounted Modal marks its surroundings inert and aria-hidden, so a
// Reload-and-sign-in state rendered behind one is neither perceivable nor
// operable. Every modal whose render condition is not gated on `workspace`
// (or `selectedCredential`, which is derived from it) therefore has to be
// closed by handleSessionEnded, in the same commit that drops the workspace.
test("handleSessionEnded closes every modal that is not gated on workspace (app-ux-M-01)", () => {
  const sources = readClientSources();
  const owner = sources.find(({ source }) => /const handleSessionEnded = useCallback\(/.test(source));
  assert.ok(owner, "handleSessionEnded is defined in a client source");
  const body = owner.source.match(/const handleSessionEnded = useCallback\(\(\) => \{([\s\S]*?)\n\s*\}, \[\]\);/)?.[1];
  assert.ok(body, "handleSessionEnded body found");
  assert.match(body, /\bsetWorkspace\(null\)/, "handleSessionEnded drops the workspace");

  let gated = 0;
  const ungated = [];
  for (const { file, source } of sources) {
    // `{condition ? (\n <Modal …` / `<…Modal …` render sites and their conditions.
    const site = /\{([^{}]+?)\s\?\s\(\s*<\w*Modal\b/g;
    let match;
    while ((match = site.exec(source)) !== null) {
      const condition = match[1].trim();
      if (/\b(workspace|selectedCredential)\b/.test(condition)) {
        gated += 1;
        continue;
      }
      for (const name of condition.match(/\b[a-z]\w*\b/g) ?? []) {
        const setter = `set${name[0].toUpperCase()}${name.slice(1)}`;
        assert.match(
          body,
          new RegExp(`\\b${setter}\\((null|false)\\)`),
          `${file}: the modal gated on \`${condition}\` would stay mounted over the Reload state; add ${setter}(null|false) to handleSessionEnded`,
        );
        ungated.push(name);
      }
    }
  }
  assert.ok(
    gated >= 6 && ungated.length >= 5,
    `expected to scan the gated (${gated}) and ungated (${ungated.length}) modal render sites`,
  );
});

test("sign out is a POST form to /auth/logout, not a link (app-ux-02)", () => {
  const sources = readClientSources();
  assert.ok(sources.every(({ source }) => !source.includes("/signout-with-chatgpt")), "dead sign-out URL removed");
  assert.ok(
    sources.some(({ source }) => /<form[^>]*method="post"[^>]*action="\/auth\/logout"/.test(source)),
    "a POST form to /auth/logout exists",
  );
});

test("the parked screen is inert while a credential is pushed, and routes set document.title (app-ux-09, a11y-01, app-ux-17, a11y-03)", () => {
  const sources = readClientSources();
  assert.ok(
    sources.some(({ source }) => /screen screen-root[\s\S]{0,200}?inert=\{Boolean\(detailCredential\)\}/.test(source)),
    "screen-root carries inert={Boolean(detailCredential)}",
  );
  assert.ok(sources.some(({ source }) => /document\.title = routeTitle\(/.test(source)), "document.title is set from routeTitle()");
});

// tests/isolation.test.mjs probes every workspace action by name from
// WORKSPACE_ACTIONS; this guard ties that list to the build from the source
// side. It reads the `case "<name>":` labels out of whichever file under
// app/api/ throws `unsupported_action`, so it survives the route split.
test("every workspace dispatch label is in WORKSPACE_ACTIONS (critic-08)", () => {
  const labels = new Set();
  for (const { file, source } of readClientSources()) {
    if (!file.startsWith("api/") || !source.includes("unsupported_action")) continue;
    for (const match of source.matchAll(/^\s*case "([A-Za-z]+)":/gm)) labels.add(match[1]);
  }
  assert.ok(labels.size > 0, "found the workspace dispatch switch under app/api/");
  assert.deepEqual([...labels].sort(), [...WORKSPACE_ACTIONS].sort());
});

// Screen behaviour lives in tests/e2e/, pure modules in tests/*.test.mjs
// against .test-build/. No test file may read the client's component or
// stylesheet source, or the built client chunk, as text: those pins broke on
// every refactor without catching a regression (architecture-03), and Wave 2
// retired all 196 of them. Every tests/*.test.mjs is walked except the two
// generic walkers (this file and tests/protected-identifiers.test.mjs), so
// the pattern cannot come back in a new file either.
test("no test file reads client source text (architecture-03)", () => {
  let scanned = 0;
  for (const name of readdirSync(new URL("./", import.meta.url))) {
    if (
      !/\.test\.mjs$/.test(name) ||
      name === "app-source-guards.test.mjs" ||
      name === "protected-identifiers.test.mjs"
    ) {
      continue;
    }
    scanned += 1;
    const suite = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      suite,
      /\.\.\/app\/(ITrackApp\.tsx|globals\.css|layout\.tsx)/,
      `${name}: a readFile of a client source file is back — prove the behaviour in tests/e2e/ or a unit test instead`,
    );
    assert.doesNotMatch(
      suite,
      /ITrackApp-/,
      `${name}: must not read the built ITrackApp-*.js chunk`,
    );
  }
  assert.ok(scanned > 0, "scanned the test files");
});

// critic-01: every default date comes from todayLocal(zone) in
// app/lib/dates.ts. A UTC "today" anywhere under app/ — a screen or an API
// route — reintroduces the evening off-by-one, so the expression is banned
// outright, and the retired helper's name is banned too so it cannot come
// back under a fresh alias.
test("no file under app/ computes today in UTC (critic-01)", () => {
  for (const { file, source } of readClientSources()) {
    assert.doesNotMatch(
      source,
      /new Date\(\)\s*\.toISOString\(\)\.slice\(0,\s*10\)/,
      `${file}: use todayLocal(zone) from app/lib/dates.ts, never the UTC date`,
    );
    assert.doesNotMatch(
      source,
      /\bconst todayIso\b/,
      `${file}: todayIso was retired by app/lib/dates.ts`,
    );
  }
});

// One spelling of "open cycle" (app-ux-04, app-ux-18). The client used to
// hand-roll `status !== "renewed"` at fourteen sites while the Home hero and
// the detail stat, which had no such guard, counted down renewed cycles.
// `isOpenCycle` / `isClosedCycle` in app/lib/cycles.ts are now the only place
// the status vocabulary is compared, so a new screen cannot grow a fifteenth.
test("the open-cycle test is spelled out only in app/lib/cycles.ts (app-ux-04, app-ux-18)", () => {
  let scanned = 0;
  for (const { file, source } of readClientSources()) {
    if (file === "lib/cycles.ts") continue;
    scanned += 1;
    assert.doesNotMatch(
      source,
      /!==\s*["']renewed["']/,
      `${file}: compare through isOpenCycle() from app/lib/cycles.ts, not against "renewed"`,
    );
  }
  assert.ok(scanned > 0, "scanned the client sources");
});

// a11y-14 / spec §5.1: the type scale is rem so a browser font-size
// preference scales the UI. The one px allowed is --text-control (16px), the
// iOS zoom floor for editable values, declared once in app/styles/tokens.css
// and consumed only through max(var(--text-control), 1em). Comments are
// blanked (newlines kept) so a claim comment cannot trip the regexes.
test("no font-size in px under app/**/*.css except the documented --text-control floor (a11y-14)", () => {
  const blank = (text) => text.replace(/[^\n]/g, " ");
  let scanned = 0;
  let controls = 0;
  for (const { file, source } of readStylesheets()) {
    scanned += 1;
    const code = source.replace(/\/\*[\s\S]*?\*\//g, blank);
    for (const match of code.matchAll(/^\s*font-size\s*:\s*([^;{}]+);/gm)) {
      assert.doesNotMatch(
        match[1],
        /\b\d*\.?\d+px\b/,
        `${file}: \`${match[0].trim()}\` — use a --text-* token or rem`,
      );
    }
    for (const match of code.matchAll(/^\s*(--text-[a-z0-9-]+)\s*:\s*([^;]+);/gm)) {
      if (match[1] === "--text-control") {
        controls += 1;
        assert.equal(file, "styles/tokens.css", "--text-control is declared in tokens.css only");
        assert.equal(match[2].trim(), "16px", "--text-control is the 16px iOS zoom floor");
        continue;
      }
      assert.match(match[2], /^\s*\d*\.?\d+rem\s*$/, `${file}: ${match[1]} must be declared in rem`);
    }
  }
  assert.ok(scanned >= 9, "walked app/globals.css and app/styles/*.css");
  assert.equal(controls, 1, "--text-control is declared exactly once");
});
