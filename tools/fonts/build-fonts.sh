#!/usr/bin/env bash
# Builds the self-hosted latin subsets under public/fonts/ (spec §5.1 Type;
# audit perf-08; mockup decision 4). Sources: google/fonts
# @6ce172f74aa355ea43eb964fa4a91570a4d3064d — all three families are OFL.
# Needs curl and python3; a project-local venv with fonttools[woff] (brotli)
# is created on first run because the homebrew fontTools has no brotli and
# its pip is PEP 668-locked. Python only — never Node.
#
# Output is byte-reproducible (no timestamp is rewritten anywhere), so the
# content-hashed names it prints are the ones app/lib/fonts.ts and
# app/styles/fonts.css carry. Re-run when a face changes and paste what it
# prints: the seven names, then the three metric-matched fallback blocks.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD="$ROOT/.fonts-build"
VENV="$ROOT/.fonts-venv"
OUT="$ROOT/public/fonts"
SHA=6ce172f74aa355ea43eb964fa4a91570a4d3064d
RAW="https://raw.githubusercontent.com/google/fonts/$SHA"
# Google Fonts' latin range: bullets, €, ™, −, arrows and the typographic
# punctuation the app prints, for under 2 kB over the bare ASCII set.
UNI='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
FACES='bricolage-grotesque-700 bricolage-grotesque-800 atkinson-hyperlegible-400 atkinson-hyperlegible-700 atkinson-hyperlegible-400-italic itrack-mono-400 itrack-mono-500'

mkdir -p "$BUILD" "$OUT"
if [ ! -x "$VENV/bin/pyftsubset" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet 'fonttools[woff]==4.65.0'
fi

fetch() { # fetch <path under the pinned google/fonts tree> <local name>
  [ -f "$BUILD/$2" ] || curl -sSfL -o "$BUILD/$2" "$RAW/$1"
}
fetch 'ofl/bricolagegrotesque/BricolageGrotesque%5Bopsz%2Cwdth%2Cwght%5D.ttf' Bricolage.ttf
fetch ofl/atkinsonhyperlegible/AtkinsonHyperlegible-Regular.ttf Atkinson-Regular.ttf
fetch ofl/atkinsonhyperlegible/AtkinsonHyperlegible-Bold.ttf Atkinson-Bold.ttf
fetch ofl/atkinsonhyperlegible/AtkinsonHyperlegible-Italic.ttf Atkinson-Italic.ttf
fetch ofl/ibmplexmono/IBMPlexMono-Regular.ttf PlexMono-Regular.ttf
fetch ofl/ibmplexmono/IBMPlexMono-Medium.ttf PlexMono-Medium.ttf
fetch ofl/bricolagegrotesque/OFL.txt OFL-bricolage-grotesque.txt
fetch ofl/atkinsonhyperlegible/OFL.txt OFL-atkinson-hyperlegible.txt
fetch ofl/ibmplexmono/OFL.txt OFL-ibm-plex-mono.txt

# Bricolage ships as one variable file whose opsz axis alone is ~50 kB of
# GPOS variations, so the display weights are cut as static instances with
# opsz pinned at the family default (96, the display cut) and wdth at 100.
# --no-recalc-timestamp keeps head.modified, which is what keeps the bytes
# (and so the hash) identical on every run.
for w in 700 800; do
  "$VENV/bin/fonttools" varLib.instancer -q --no-recalc-timestamp \
    "$BUILD/Bricolage.ttf" wdth=100 wght=$w opsz=96 -o "$BUILD/bricolage-$w.ttf"
done

subset() { # subset <in.ttf> <out basename>
  # pyftsubset does not rewrite the timestamp by default.
  "$VENV/bin/pyftsubset" "$BUILD/$1" --flavor=woff2 --layout-features='*' --no-hinting \
    --name-IDs='0,1,2,3,4,5,6,13,14' --notdef-outline --unicodes="$UNI" \
    --output-file="$BUILD/$2.woff2"
}
subset bricolage-700.ttf bricolage-grotesque-700
subset bricolage-800.ttf bricolage-grotesque-800
subset Atkinson-Regular.ttf atkinson-hyperlegible-400
subset Atkinson-Bold.ttf atkinson-hyperlegible-700
subset Atkinson-Italic.ttf atkinson-hyperlegible-400-italic
subset PlexMono-Regular.ttf itrack-mono-400
subset PlexMono-Medium.ttf itrack-mono-500

# IBM Plex Mono has the Reserved Font Name "Plex" (OFL §1); a subset is a
# Modified Version and may not carry it (OFL FAQ 2.6, 2.8), so the family
# becomes "iTrack Mono" in the name records CSS and inspectors read.
# recalcTimestamp=False keeps head.modified so the file stays reproducible.
for f in itrack-mono-400 itrack-mono-500; do
  "$VENV/bin/python" - "$BUILD/$f.woff2" <<'PY'
import sys
from fontTools.ttLib import TTFont
path = sys.argv[1]
font = TTFont(path, recalcTimestamp=False)
for record in font["name"].names:
    if record.nameID in (1, 3, 4, 6, 16):
        record.string = record.toUnicode().replace("IBM Plex Mono", "iTrack Mono").replace("IBMPlexMono", "iTrackMono")
font.save(path)
PY
done

rm -f "$OUT"/*.woff2
for f in $FACES; do
  h=$(shasum -a 256 "$BUILD/$f.woff2" | cut -c1-8)
  cp "$BUILD/$f.woff2" "$OUT/$f-$h.woff2"
  printf '%-48s %6d bytes\n' "$f-$h.woff2" "$(wc -c < "$OUT/$f-$h.woff2" | tr -d ' ')"
done
cp "$BUILD"/OFL-*.txt "$OUT/"

# Metric-matched fallbacks for app/styles/fonts.css (perf-08): the local
# fallback face is scaled so its average lowercase advance equals the real
# face's, then its ascent/descent/line-gap are overridden to the real face's
# (divided by size-adjust, because the overrides are relative to the adjusted
# size), so the swap moves no line. "Average" = advance width of a–z weighted
# by English letter frequency. The OS/2 xAvgCharWidth field is NOT usable
# here: Arial's is the old lowercase-weighted value, Atkinson's a whole-font
# mean, and their ratio would scale the fallback up by a fifth.
# Fallback constants were measured from macOS Arial.ttf and Menlo-Regular
# (both 2048 units/em): weighted averages 977.74 and 1233.00 units.
"$VENV/bin/python" - "$BUILD" <<'PY'
import sys
from fontTools.ttLib import TTFont
FREQ = {"a": 8.167, "b": 1.492, "c": 2.782, "d": 4.253, "e": 12.702, "f": 2.228, "g": 2.015,
        "h": 6.094, "i": 6.966, "j": 0.153, "k": 0.772, "l": 4.025, "m": 2.406, "n": 6.749,
        "o": 7.507, "p": 1.929, "q": 0.095, "r": 5.987, "s": 6.327, "t": 9.056, "u": 2.758,
        "v": 0.978, "w": 2.360, "x": 0.150, "y": 1.974, "z": 0.074}
FALLBACKS = [
    ("atkinson-hyperlegible-400", "Atkinson Hyperlegible Fallback", 'local("Arial"), local("ArialMT")', 977.74 / 2048),
    ("bricolage-grotesque-700", "Bricolage Grotesque Fallback", 'local("Arial"), local("ArialMT")', 977.74 / 2048),
    ("itrack-mono-400", "iTrack Mono Fallback", 'local("Menlo"), local("Menlo-Regular")', 1233.0 / 2048),
]
build = sys.argv[1]
total = sum(FREQ.values())
pct = lambda v: f"{v * 100:.2f}%"
for name, family, src, fallback_avg in FALLBACKS:
    font = TTFont(f"{build}/{name}.woff2")
    upem = font["head"].unitsPerEm
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    avg = sum(hmtx[cmap[ord(c)]][0] * w for c, w in FREQ.items()) / total / upem
    adjust = avg / fallback_avg
    hhea = font["hhea"]
    print(f'@font-face {{ font-family: "{family}"; src: {src}; size-adjust: {pct(adjust)}; '
          f'ascent-override: {pct(hhea.ascent / upem / adjust)}; descent-override: {pct(abs(hhea.descent) / upem / adjust)}; '
          f'line-gap-override: {pct(hhea.lineGap / upem / adjust)}; }}')
PY
echo "Paste the seven names into app/lib/fonts.ts and app/styles/fonts.css, and the three fallback blocks into app/styles/fonts.css."
