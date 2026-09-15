// Walks every .ts/.tsx/.mts file under app/ for the static source guards.
// It lives under tests/helpers/ (not in a *.test.mjs) so that importing it
// never re-registers another file's tests under `node --test`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|mts)$/.test(entry)) out.push(full);
  }
  return out;
}

// `file` is relative to app/ (e.g. "api/workspace/route.ts").
export function readClientSources() {
  return walk(appDir).map((file) => ({ file: path.relative(appDir, file), source: readFileSync(file, "utf8") }));
}
