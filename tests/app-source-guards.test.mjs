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
