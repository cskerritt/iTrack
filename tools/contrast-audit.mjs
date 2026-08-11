#!/usr/bin/env node
/**
 * Contrast audit for app/globals.css.
 *
 * The stylesheet documents, beside each muted/accent ink and each solid mark,
 * the WCAG ratio it holds against the surfaces it is approved for. Those
 * comments are a contract: they are what a future change is checked against.
 * This script re-derives every one of them from the token values actually in
 * the file and fails if a claim has drifted or dropped below its floor. It
 * also enforces the design-system invariant that no colour literal appears
 * outside the two :root blocks.
 *
 *   node tools/contrast-audit.mjs          audit, exit 1 on any failure
 *   node tools/contrast-audit.mjs --list   also print every passing claim
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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CSS_PATH = resolve(ROOT, "app/globals.css");
const CSS = readFileSync(CSS_PATH, "utf8");

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

const LIGHT_RANGE = blockRange(CSS, CSS.indexOf(":root {"));
const DARK_RANGE = blockRange(
  CSS,
  CSS.indexOf("@media (prefers-color-scheme: dark)"),
);

const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));

function tokensIn([a, b]) {
  // Comments are stripped first: prose like "not --accent: the platform blue"
  // otherwise reads as a declaration and swallows the one that follows it.
  const body = stripComments(CSS.slice(a, b));
  const tokens = new Map();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens.set(m[1], m[2].trim());
  }
  return tokens;
}

const LIGHT = tokensIn(LIGHT_RANGE);
const DARK = tokensIn(DARK_RANGE);

/** Resolve a token in a scheme, falling back to the light block. */
function resolve0(token, scheme) {
  const raw = scheme === "dark" ? (DARK.get(token) ?? LIGHT.get(token)) : LIGHT.get(token);
  if (raw === undefined) return null;
  return parseColor(raw);
}

const ALIASES = new Map([["the amber card", "--amber-card-from"]]);

/**
 * Resolve a surface expression to an opaque colour.
 * Understands "--a", "--a over --b" and "--a@0.2 over --b".
 */
function resolveSurface(expr, scheme, selfToken) {
  const text = expr.trim();
  if (text === "the fill") return resolve0(selfToken, scheme);
  if (ALIASES.has(text)) return resolve0(ALIASES.get(text), scheme);

  const composite = /^(--[a-z0-9-]+)(?:@([\d.]+))?\s+over\s+(.+)$/i.exec(text);
  if (composite) {
    const base = resolveSurface(composite[3], scheme, selfToken);
    const top = resolve0(composite[1], scheme);
    if (!base || !top) return null;
    const layer = [...top];
    layer.a = composite[2] !== undefined ? Number(composite[2]) : top.a;
    if (layer.a === undefined) return null;
    return over(layer, base);
  }
  if (/^--[a-z0-9-]+$/.test(text)) {
    const c = resolve0(text, scheme);
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
 * Pull every documented claim out of the comments inside a :root block.
 * A claim line looks like `*   --token   4.8:1 on --surface, 5.6:1 on --card`.
 */
function claimsIn([a, b], scheme) {
  const claims = [];
  const lines = CSS.slice(a, b).split("\n");
  const start = CSS.slice(0, a).split("\n").length;

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

/* -------------------------------------------------------------------- audit */

const failures = [];
const passes = [];

for (const claim of [
  ...claimsIn(LIGHT_RANGE, "light"),
  ...claimsIn(DARK_RANGE, "dark"),
]) {
  const bg = resolveSurface(claim.surfaceExpr, claim.scheme, claim.owner);
  const rawFg = resolve0(claim.subject, claim.scheme);
  if (!bg || !rawFg) {
    failures.push({
      ...claim,
      kind: "unresolved",
      detail: `cannot resolve ${!rawFg ? claim.subject : claim.surfaceExpr}`,
    });
    continue;
  }
  const actual = contrast(over(rawFg, bg), bg);
  const floor = claim.large ? OBJECT_FLOOR : floorFor(claim.subject);
  const record = { ...claim, actual, floor };
  if (Math.abs(actual - claim.claimed) > DRIFT) {
    failures.push({ ...record, kind: "drift" });
  } else if (actual + 0.005 < floor) {
    failures.push({ ...record, kind: "floor" });
  } else {
    passes.push(record);
  }
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

/** Blank a span out while keeping every newline, so line numbers still hold. */
const blank = (s) => s.replace(/[^\n]/g, " ");

const literals = [];
{
  const masked =
    CSS.slice(0, LIGHT_RANGE[0]) +
    blank(CSS.slice(...LIGHT_RANGE)) +
    CSS.slice(LIGHT_RANGE[1], DARK_RANGE[0]) +
    blank(CSS.slice(...DARK_RANGE)) +
    CSS.slice(DARK_RANGE[1]);
  // Strip comments so prose that mentions a hex is not a violation.
  const code = stripComments(masked);
  const lineOf = (index) => code.slice(0, index).split("\n").length;
  const forcedColors = blockRange(code, code.indexOf("@media (forced-colors"));

  for (const m of code.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
    literals.push({ line: lineOf(m.index), text: m[0] });
  }
  for (const m of code.matchAll(/\brgba?\(([^)]*)\)/gi)) {
    if (/var\(--/.test(m[1])) continue; // rgb(var(--x) / a) is the token form
    literals.push({ line: lineOf(m.index), text: m[0] });
  }
  // Only the value side of a declaration can name a colour, and a token
  // reference is not a name — --mark-coral is a token, not the colour coral.
  const noTokens = code.replace(/--[a-z0-9-]+/gi, blank);
  for (const m of noTokens.matchAll(/:\s*([^;{}]+)[;}]/g)) {
    const valueStart = m.index + m[0].indexOf(m[1]);
    const inForced = m.index >= forcedColors[0] && m.index < forcedColors[1];
    for (const w of m[1].matchAll(/[a-z][a-z]{2,}/gi)) {
      const word = w[0].toLowerCase();
      if (NAMED_COLORS.has(word) || (SYSTEM_COLORS.has(word) && !inForced)) {
        literals.push({ line: lineOf(valueStart + w.index), text: w[0] });
      }
    }
  }
}

/* ------------------------------------------------------------------ report */

if (process.argv.includes("--json")) {
  // Every claim with its measurement, for retuning the comments in bulk.
  console.log(
    JSON.stringify(
      [...passes, ...failures.filter((f) => f.kind !== "unresolved")].sort(
        (a, b) => a.line - b.line || a.nthOnLine - b.nthOnLine,
      ),
    ),
  );
  process.exit(failures.some((f) => f.kind === "unresolved") ? 1 : 0);
}

const listAll = process.argv.includes("--list");
const pad = (s, n) => String(s).padEnd(n);

if (listAll) {
  for (const scheme of ["light", "dark"]) {
    console.log(`\n${scheme.toUpperCase()} — ${passes.filter((p) => p.scheme === scheme).length} claims`);
    for (const p of passes.filter((x) => x.scheme === scheme)) {
      console.log(
        `  ${pad(p.subject, 22)} ${p.actual.toFixed(2)}:1 on ${pad(p.surfaceExpr, 34)} (claims ${p.claimed})`,
      );
    }
  }
}

console.log(
  `\ncontrast-audit: ${passes.length + failures.length} documented claims, ` +
    `${failures.length} failing; ${literals.length} colour literals outside the :root blocks`,
);

for (const f of failures) {
  if (f.kind === "unresolved") {
    console.log(`  FAIL ${f.scheme} L${f.line} ${f.subject}: ${f.detail}`);
  } else if (f.kind === "drift") {
    console.log(
      `  FAIL ${f.scheme} L${f.line} ${pad(f.subject, 22)} on ${pad(f.surfaceExpr, 30)} ` +
        `claims ${f.claimed}:1, measures ${f.actual.toFixed(2)}:1`,
    );
  } else {
    console.log(
      `  FAIL ${f.scheme} L${f.line} ${pad(f.subject, 22)} on ${pad(f.surfaceExpr, 30)} ` +
        `${f.actual.toFixed(2)}:1 is below the ${f.floor}:1 floor`,
    );
  }
}
for (const l of literals) {
  console.log(`  FAIL colour literal outside :root — line ${l.line}: ${l.text}`);
}

process.exit(failures.length + literals.length > 0 ? 1 : 0);
