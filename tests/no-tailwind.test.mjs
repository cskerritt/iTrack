// architecture-12: Tailwind was imported and compiled on every build while no
// utility class was ever used, so Wave 3 removed it and ported its preflight
// into app/globals.css as the explicit reset (Task 3). At main @4bc32b5 the
// client stylesheet opened with Tailwind's theme/base/utilities/properties
// layers and 31 `--tw-*` properties — 7.5 kB before the first app token. This
// gate keeps the toolchain and the runtime gone. package.json and
// postcss.config.mjs are project configuration, not client source, and the
// second test reads build output, so nothing here trips the source-read guard.
// `npm test` builds before running this file; with no dist at all the dist
// half is vacuously true, like tests/dist-hygiene.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("no Tailwind package is declared and no PostCSS config remains (architecture-12)", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const declared = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];
  assert.deepEqual(
    declared.filter((name) => /tailwind/i.test(name)),
    [],
    "package.json still declares a Tailwind package — `npm uninstall tailwindcss @tailwindcss/postcss` under the Node 22 PATH",
  );
  assert.ok(
    !existsSync(path.join(root, "postcss.config.mjs")),
    "postcss.config.mjs only ever registered @tailwindcss/postcss — delete it; Vite needs no PostCSS config for plain CSS and inlines the @imports itself",
  );
});

test("the built client stylesheet carries no Tailwind runtime (architecture-12)", () => {
  const assets = path.join(root, "dist", "client", "assets");
  if (!existsSync(assets)) return;
  const sheets = readdirSync(assets).filter((name) => name.endsWith(".css"));
  assert.ok(sheets.length > 0, "the client build emits at least one stylesheet under dist/client/assets");
  for (const name of sheets) {
    const css = readFileSync(path.join(assets, name), "utf8");
    assert.doesNotMatch(css, /--tw-/, `${name}: Tailwind's --tw-* properties are back`);
    assert.doesNotMatch(
      css,
      /@layer\s+(theme|components|utilities|properties)\b/,
      `${name}: a Tailwind cascade layer is back — the only layer the app declares is \`@layer base\` (app/globals.css)`,
    );
  }
});
