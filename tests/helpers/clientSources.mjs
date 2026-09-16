// Walks the client source under app/ for the static source guards: every
// .ts/.tsx/.mts file (readClientSources) and every .css file (readStylesheets).
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

function walkAll(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkAll(full, out);
    else out.push(full);
  }
  return out;
}

// `file` is relative to app/ (e.g. "api/workspace/route.ts").
export function readClientSources() {
  return walk(appDir).map((file) => ({ file: path.relative(appDir, file), source: readFileSync(file, "utf8") }));
}

// Every .css under app/ (`file` relative to app/, e.g. "globals.css" or "styles/home.css").
export function readStylesheets() {
  return walkAll(appDir)
    .filter((file) => file.endsWith(".css"))
    .map((file) => ({ file: path.relative(appDir, file), source: readFileSync(file, "utf8") }));
}
