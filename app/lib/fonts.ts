/**
 * The self-hosted faces (spec §5.1 Type; audit perf-08). The names carry a
 * content hash because /fonts/* is served immutable (public/_headers):
 * rebuild with tools/fonts/build-fonts.sh and paste the printed names here
 * and into app/styles/fonts.css — tests/fonts.test.mjs fails until every
 * name below is a file under public/fonts/. Only what is on every first
 * paint is preloaded: copy is body 400; eyebrows, nav labels and buttons are
 * body 700; the H1 and the numerals are display 700; the brand is display
 * 800. Mono and the italic load on first use through @font-face with
 * font-display: swap behind metric-matched fallbacks.
 *
 * Pure and import-free: compiled by `npm run build:lib-test` for
 * tests/fonts.test.mjs and imported by app/layout.tsx (a server component).
 */
export const FONT_FILES = {
  displayBold: "/fonts/bricolage-grotesque-700-173536fe.woff2",
  displayBlack: "/fonts/bricolage-grotesque-800-202ac87c.woff2",
  body: "/fonts/atkinson-hyperlegible-400-7d34b8b4.woff2",
  bodyBold: "/fonts/atkinson-hyperlegible-700-532ece55.woff2",
  bodyItalic: "/fonts/atkinson-hyperlegible-400-italic-c8316744.woff2",
  mono: "/fonts/itrack-mono-400-92fca17d.woff2",
  monoMedium: "/fonts/itrack-mono-500-ee11a094.woff2",
} as const;

export const FONT_PRELOADS: readonly string[] = [
  FONT_FILES.body,
  FONT_FILES.bodyBold,
  FONT_FILES.displayBold,
  FONT_FILES.displayBlack,
];

/** spec §5.1: 40 kB per face. */
export const FONT_BUDGET_BYTES = 40 * 1024;
