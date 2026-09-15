#!/usr/bin/env node
/**
 * Contrast audit for every stylesheet in the repo.
 *
 * Two invariants, one tool:
 *
 *   1. CLAIMS. A token file documents, beside each muted/accent ink and each
 *      solid mark, the WCAG ratio it holds against the surfaces it is approved
 *      for. Those comments are a contract: this script re-derives every one of
 *      them from the token values actually in the file and fails if a claim has
 *      drifted or dropped below its floor. Claims are read only from token
 *      files; a token file with no claims (each public page) passes with 0.
 *
 *   2. LITERALS. No colour literal — hex, rgb()/rgba(), a named colour, or a
 *      system colour outside a `@media (forced-colors …)` block — may appear
 *      outside a token file's token blocks. A consumer stylesheet has no token
 *      blocks, so every literal in it is a violation.
 *
 * WHICH FILES. `collectStylesheets` walks every .css under app/ (recursively)
 * and the <style> blocks of deploy/railway/pages/*.html. A .css file is a TOKEN
 * file iff its first rule — after comments and any leading `@import …;` /
 * `@charset …;` statements; app/globals.css opens with `@import "tailwindcss";`
 * — is `:root {`. Every page is a token file because each inlines its own
 * :root. Everything else under app/ is a CONSUMER. Today app/globals.css and
 * the five pages qualify; after the Wave 3 split only app/styles/tokens.css and
 * the pages will, and every per-screen stylesheet is a consumer.
 *
 * TOKEN BLOCKS of a token file are the first `:root {` block and, when present,
 * the `@media (prefers-color-scheme: dark)` block — never a later :root such as
 * globals.css's responsive `@media (max-width: 1040px) { :root … }`. System
 * colour keywords are allowed only inside `@media (forced-colors …)`; a file
 * without that block allows none.
 *
 *   node tools/contrast-audit.mjs            audit every stylesheet; exit 1 on any failure or literal
 *   node tools/contrast-audit.mjs --list     also print every passing claim
 *   node tools/contrast-audit.mjs --json     every claim with its measurement, as JSON, for retuning
 *                                            the comments in bulk (exit 1 only on an unresolved claim)
 *   node tools/contrast-audit.mjs <path>…    audit just those .css/.html files (paths relative to the cwd)
 *
 * Importable as well as runnable: auditStylesheet(css, { path, kind }),
 * collectStylesheets(root), tokenBlocks(css).
 *
 * CLAIM GRAMMAR (inside the token comments, one claim per ratio):
 *
 *     <ratio>:1 [<subject>] on <surface> [(large|glyph …)]
 *     <ratio>:1 [<subject>] over <surface>          (elevation step)
 *
 *   <subject>  a token; defaults to the token the comment line names
 *   <surface>  --token
 *              --a/--b                two surfaces, both checked
 *              --a over --b           --a composited over --b (--a's own alpha)
 *              --a@0.16 over --b      --a composited over --b at that alpha
 *              the fill               the comment line's own token
 *              the amber card         --amber-card-from
 *
 * FLOORS are derived from what the subject *is*, which is the same rule the
 * design system states in prose:
 *   text (ink, on-*)                4.5:1
 *   objects (mark-, edge-, track-)  3.0:1
 *   surfaces (ink-surface*)         1.15:1   — an elevation step, not contrast
 *
 * A trailing "(large …)", "(glyph …)" or "(mark …)" drops that one claim to
 * the 3:1 object floor: large text, a tick drawn inside a fill and a mark that
 * carries its value in its fill (a bar, a ring) are all non-text under WCAG,
 * and each case is rare enough to be worth naming at the site.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TEXT_FLOOR = 4.5;
const OBJECT_FLOOR = 3;
const ELEVATION_FLOOR = 1.15;
const DRIFT = 0.05;

/* ------------------------------------------------------------------ colour */

const srgb = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]) =>
  0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);

const contrast = (a, b) => {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** Composite a possibly-translucent colour over an opaque one. */
const over = (fg, bg) =>
  fg.a === undefined || fg.a === 1
    ? [fg[0], fg[1], fg[2]]
    : [0, 1, 2].map((i) => fg[i] * fg.a + bg[i] * (1 - fg.a));

function parseColor(raw) {
  const value = raw.trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(value);
  if (m) {
    const n = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    const c = n.slice(0, 3);
    if (n.length > 3) c.a = n[3];
    return c;
  }
  // bare channel triple, as the --*-rgb tokens are held
  m = /^(\d+)\s+(\d+)\s+(\d+)$/.exec(value);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

/* ------------------------------------------------------------------ parsing */

/** Blank a span out while keeping every newline, so every index and line number still holds. */
const blank = (s) => s.replace(/[^\n]/g, " ");

/** Replace every comment with blanks of the same shape (newlines kept). */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, blank);

/** Byte range of the block whose opening brace follows `from`. */
function blockRange(src, from) {
  const open = src.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return [from, i + 1];
  }
  throw new Error(`unbalanced block at ${from}`);
}

/**
 * Range of the block that follows the first `marker`, or null when the file
 * has no such block. (A bare `indexOf` of -1 would silently hand `blockRange`
 * the first block in the file — which is how a page with no dark block used
 * to read its :root as the dark block.)
 */
function optionalBlock(src, marker) {
  const at = src.indexOf(marker);
  return at < 0 ? null : blockRange(src, at);
}

/**
 * The token blocks of a stylesheet: the first `:root {` block, the dark
 * remap, and the forced-colors block, each `null` when absent. Markers are
 * searched with comments blanked, so prose that mentions a block does not
 * count as one.
 */
export function tokenBlocks(css) {
  const code = stripComments(css);
  return {
    light: optionalBlock(code, ":root {"),
    dark: optionalBlock(code, "@media (prefers-color-scheme: dark)"),
    forced: optionalBlock(code, "@media (forced-colors"),
  };
}

const LEADING_AT_STATEMENT = /^\s*@[a-z-]+[^;{}]*;/i;

/** A .css file is a token file iff its first rule is `:root {`. */
function isTokenStylesheet(css) {
  let code = stripComments(css);
  while (LEADING_AT_STATEMENT.test(code)) code = code.replace(LEADING_AT_STATEMENT, "");
  return /^\s*:root \{/.test(code);
}

/**
 * The CSS of an HTML page: the content of every <style>…</style> block, in
 * order, with everything outside the blocks blanked to spaces (newlines
 * kept), so a line number in the report is the HTML file's own.
 */
function styleBlocksOf(html) {
  let css = "";
  let cursor = 0;
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const start = m.index + m[0].length - "</style>".length - m[1].length;
    css += blank(html.slice(cursor, start)) + m[1];
    cursor = start + m[1].length;
  }
  return css + blank(html.slice(cursor));
}

function displayPath(root, file) {
  const rel = relative(root, file);
  return rel.startsWith("..") || isAbsolute(rel) ? file : rel.split(sep).join("/");
}

function loadStylesheet(root, file) {
  const raw = readFileSync(file, "utf8");
  const page = /\.html?$/i.test(file);
  const css = page ? styleBlocksOf(raw) : raw;
  return {
    path: displayPath(root, file),
    css,
    kind: page || isTokenStylesheet(css) ? "tokens" : "consumer",
  };
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Every stylesheet the audit covers: app/**.css (recursive) + the pages' <style> blocks. */
export function collectStylesheets(root = ROOT) {
  const files = [
    ...walk(join(root, "app")).filter((file) => file.endsWith(".css")),
    ...walk(join(root, "deploy", "railway", "pages")).filter((file) => file.endsWith(".html")),
  ];
  return files.map((file) => loadStylesheet(root, file));
}

function tokensIn(css, range) {
  const tokens = new Map();
  if (!range) return tokens;
  // Comments are stripped first: prose like "not --accent: the platform blue"
  // otherwise reads as a declaration and swallows the one that follows it.
  const body = stripComments(css.slice(range[0], range[1]));
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens.set(m[1], m[2].trim());
  }
  return tokens;
}

/** Resolve a token in a scheme, falling back to the light block. */
function resolve0(tokens, token, scheme) {
  const raw =
    scheme === "dark"
      ? (tokens.dark.get(token) ?? tokens.light.get(token))
      : tokens.light.get(token);
  if (raw === undefined) return null;
  return parseColor(raw);
}

const ALIASES = new Map([["the amber card", "--amber-card-from"]]);

/**
 * Resolve a surface expression to an opaque colour.
 * Understands "--a", "--a over --b" and "--a@0.2 over --b".
 */
function resolveSurface(tokens, expr, scheme, selfToken) {
  const text = expr.trim();
  if (text === "the fill") return resolve0(tokens, selfToken, scheme);
  if (ALIASES.has(text)) return resolve0(tokens, ALIASES.get(text), scheme);

  const composite = /^(--[a-z0-9-]+)(?:@([\d.]+))?\s+over\s+(.+)$/i.exec(text);
  if (composite) {
    const base = resolveSurface(tokens, composite[3], scheme, selfToken);
    const top = resolve0(tokens, composite[1], scheme);
    if (!base || !top) return null;
    const layer = [...top];
    layer.a = composite[2] !== undefined ? Number(composite[2]) : top.a;
    if (layer.a === undefined) return null;
    return over(layer, base);
  }
  if (/^--[a-z0-9-]+$/.test(text)) {
    const c = resolve0(tokens, text, scheme);
    return c && c.a !== undefined ? null : c;
  }
  return null;
}

function floorFor(subject) {
  if (/^--ink-surface/.test(subject)) return ELEVATION_FLOOR;
  if (/^--(mark|edge|track|line)/.test(subject)) return OBJECT_FLOOR;
  return TEXT_FLOOR;
}

/**
 * Pull every documented claim out of the comments inside a token block.
 * A claim line looks like `*   --token   4.8:1 on --surface, 5.6:1 on --card`.
 */
function claimsIn(css, range, scheme) {
  const claims = [];
  if (!range) return claims;
  const [a, b] = range;
  const lines = css.slice(a, b).split("\n");
  const start = css.slice(0, a).split("\n").length;

  // A claim's owning token is the last `*  --token` seen; continuation lines
  // (a wrapped clause) inherit it.
  let owner = null;
  lines.forEach((line, i) => {
    if (!/^\s*\*/.test(line)) {
      owner = null;
      return;
    }
    const named = /^\s*\*\s+(--[a-z0-9-]+)\b/.exec(line);
    if (named) owner = named[1];
    if (!owner) return;

    let nth = 0;
    for (const m of line.matchAll(
      /([\d.]+):1\s+(?:(--[a-z0-9-]+)\s+)?(?:on|over)\s+((?:--[a-z0-9-]+(?:@[\d.]+)?(?:\s+over\s+--[a-z0-9-]+)?(?:\/--[a-z0-9-]+)?)|the fill|the amber card)(\s*\((?:large|glyph|mark))?/gi,
    )) {
      const subject = m[2] ?? owner;
      const nthOnLine = nth++;
      for (const surface of m[3].split("/")) {
        claims.push({
          scheme,
          line: start + i,
          nthOnLine,
          claimed: Number(m[1]),
          subject,
          surfaceExpr: surface.trim(),
          owner,
          large: Boolean(m[4]),
        });
      }
    }
  });
  return claims;
}

/* ------------------------------------------------- token-literal invariant */

// Named colours are literals too. `transparent` and `currentColor` are not —
// they carry no value of their own — and the CSS system colours are allowed,
// but only inside the forced-colors block, where deferring to the user's theme
// is the whole point.
const NAMED_COLORS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond
   blue blueviolet brown burlywood cadetblue chartreuse chocolate coral
   cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray
   darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid
   darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey
   darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue
   firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod
   gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
   lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
   lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon
   lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue
   lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue
   mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen
   mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin
   navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod
   palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
   powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon
   sandybrown seagreen seashell sienna silver skyblue slateblue slategray
   slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet
   wheat white whitesmoke yellow yellowgreen`
    .trim()
    .split(/\s+/),
);

const SYSTEM_COLORS = new Set([
  "canvas",
  "canvastext",
  "buttonface",
  "buttontext",
  "buttonborder",
  "linktext",
  "visitedtext",
  "activetext",
  "highlight",
  "highlighttext",
  "selecteditem",
  "selecteditemtext",
  "graytext",
  "accentcolor",
  "accentcolortext",
  "field",
  "fieldtext",
  "mark",
  "marktext",
]);

/** Every colour literal outside the given token blocks (both may be null). */
function literalsIn(css, { light, dark, forced }, path) {
  let masked = css;
  for (const range of [light, dark]) {
    if (!range) continue;
    masked = masked.slice(0, range[0]) + blank(masked.slice(range[0], range[1])) + masked.slice(range[1]);
  }
  // Strip comments so prose that mentions a hex is not a violation.
  const code = stripComments(masked);
  const lineOf = (index) => code.slice(0, index).split("\n").length;
  const inForced = (index) => Boolean(forced) && index >= forced[0] && index < forced[1];
  const literals = [];

  for (const m of code.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
    literals.push({ path, line: lineOf(m.index), text: m[0] });
  }
  for (const m of code.matchAll(/\brgba?\(([^)]*)\)/gi)) {
    if (/var\(--/.test(m[1])) continue; // rgb(var(--x) / a) is the token form
    literals.push({ path, line: lineOf(m.index), text: m[0] });
  }
  // Only the value side of a declaration can name a colour, and a token
  // reference is not a name — --mark-coral is a token, not the colour coral.
  const noTokens = code.replace(/--[a-z0-9-]+/gi, blank);
  for (const m of noTokens.matchAll(/:\s*([^;{}]+)[;}]/g)) {
    const valueStart = m.index + m[0].indexOf(m[1]);
    for (const w of m[1].matchAll(/[a-z][a-z]{2,}/gi)) {
      const word = w[0].toLowerCase();
      if (NAMED_COLORS.has(word) || (SYSTEM_COLORS.has(word) && !inForced(m.index))) {
        literals.push({ path, line: lineOf(valueStart + w.index), text: w[0] });
      }
    }
  }
  return literals.sort((x, y) => x.line - y.line);
}

/* -------------------------------------------------------------------- audit */

/**
 * Audit one stylesheet. `kind` is "tokens" or "consumer": claims are read and
 * token blocks masked only for a token file; a consumer file masks nothing.
 * Returns { path, kind, claims, failures, literals } where every claim carries
 * `result` ("pass" | "drift" | "floor" | "unresolved") and `failures` is the
 * subset whose result is not "pass".
 */
export function auditStylesheet(css, { path, kind }) {
  const blocks = tokenBlocks(css);
  const light = kind === "tokens" ? blocks.light : null;
  const dark = kind === "tokens" ? blocks.dark : null;
  const tokens = { light: tokensIn(css, light), dark: tokensIn(css, dark) };

  const claims = [...claimsIn(css, light, "light"), ...claimsIn(css, dark, "dark")].map((claim) => {
    const bg = resolveSurface(tokens, claim.surfaceExpr, claim.scheme, claim.owner);
    const rawFg = resolve0(tokens, claim.subject, claim.scheme);
    if (!bg || !rawFg) {
      return {
        ...claim,
        path,
        result: "unresolved",
        detail: `cannot resolve ${!rawFg ? claim.subject : claim.surfaceExpr}`,
      };
    }
    const actual = contrast(over(rawFg, bg), bg);
    const floor = claim.large ? OBJECT_FLOOR : floorFor(claim.subject);
    const record = { ...claim, path, actual, floor };
    if (Math.abs(actual - claim.claimed) > DRIFT) return { ...record, result: "drift" };
    if (actual + 0.005 < floor) return { ...record, result: "floor" };
    return { ...record, result: "pass" };
  });

  return {
    path,
    kind,
    claims,
    failures: claims.filter((claim) => claim.result !== "pass"),
    literals: literalsIn(css, { light, dark, forced: blocks.forced }, path),
  };
}

/* ------------------------------------------------------------------ report */

const pad = (s, n) => String(s).padEnd(n);

function printReport(reports, { list }) {
  for (const report of reports) {
    if (list) {
      for (const scheme of ["light", "dark"]) {
        const passes = report.claims.filter((c) => c.result === "pass" && c.scheme === scheme);
        if (passes.length === 0) continue;
        console.log(`\n${report.path} ${scheme.toUpperCase()} — ${passes.length} claims`);
        for (const p of passes) {
          console.log(
            `  ${pad(p.subject, 22)} ${p.actual.toFixed(2)}:1 on ${pad(p.surfaceExpr, 34)} (claims ${p.claimed})`,
          );
        }
      }
    }
    console.log(
      `contrast-audit: ${report.path} — ${report.claims.length} claims, ` +
        `${report.failures.length} failing, ${report.literals.length} literals`,
    );
    for (const f of report.failures) {
      const at = `${report.path}:L${f.line}`;
      if (f.result === "unresolved") {
        console.log(`  FAIL ${at} ${f.scheme} ${f.subject}: ${f.detail}`);
      } else if (f.result === "drift") {
        console.log(
          `  FAIL ${at} ${f.scheme} ${pad(f.subject, 22)} on ${pad(f.surfaceExpr, 30)} ` +
            `claims ${f.claimed}:1, measures ${f.actual.toFixed(2)}:1`,
        );
      } else {
        console.log(
          `  FAIL ${at} ${f.scheme} ${pad(f.subject, 22)} on ${pad(f.surfaceExpr, 30)} ` +
            `${f.actual.toFixed(2)}:1 is below the ${f.floor}:1 floor`,
        );
      }
    }
    for (const l of report.literals) {
      console.log(`  FAIL ${report.path}:L${l.line} colour literal outside token blocks: ${l.text}`);
    }
  }
  const failing = reports.reduce((n, r) => n + r.failures.length, 0);
  const literals = reports.reduce((n, r) => n + r.literals.length, 0);
  console.log(
    `contrast-audit: ${reports.length} stylesheets, ${failing} failing claims, ` +
      `${literals} colour literals outside token blocks`,
  );
  return failing + literals > 0 ? 1 : 0;
}

function main(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const paths = argv.filter((arg) => !arg.startsWith("--"));
  const sheets = paths.length
    ? paths.map((p) => loadStylesheet(ROOT, resolve(p)))
    : collectStylesheets(ROOT);
  const reports = sheets.map((sheet) => auditStylesheet(sheet.css, sheet));

  if (flags.has("--json")) {
    // Every claim with its measurement, for retuning the comments in bulk.
    const claims = reports
      .flatMap((r) => r.claims.filter((c) => c.result !== "unresolved"))
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.nthOnLine - b.nthOnLine);
    console.log(JSON.stringify(claims));
    return reports.some((r) => r.claims.some((c) => c.result === "unresolved")) ? 1 : 0;
  }
  return printReport(reports, { list: flags.has("--list") });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
