// Cheap, always-on regression guards over the client source. Each guard
// pins a bug class the audit found, in a form that survives file moves
// (Wave 2 extracts screens out of ITrackApp.tsx): they scan every .tsx/.ts
// file under app/, not one path.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|mts)$/.test(entry)) out.push(full);
  }
  return out;
}

export function readClientSources() {
  return walk(appDir).map((file) => ({ file: path.relative(appDir, file), source: readFileSync(file, "utf8") }));
}

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
