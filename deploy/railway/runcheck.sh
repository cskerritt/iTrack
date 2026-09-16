#!/usr/bin/env bash
# iTrack gateway run-check (Waves 1-3). Modes:
#   matrix  — gateway matrix, no login (25) + the self-hosted fonts, unauthenticated (21)   usable against production
#   seed    — login + GET /api/workspace + the shell's font preloads (4)                     runs initializeDatabase + ensureUser
#   actions — seed + every credential/preference action through the gateway (22)            NEVER against production (creates/deletes data, rewrites the time zone)
#   all     — matrix + actions (68)
# Usage: B=http://localhost:8080 OPS_PASSWORD=... bash deploy/railway/runcheck.sh <mode>
set -u
B="${B:?set B, e.g. http://localhost:8080}"
MODE="${1:-all}"
TMP="$(mktemp -d)"
PASS=0; FAIL=0; C=""; ID=""
ok()      { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
bad()     { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n      got: %s\n' "$1" "$2"; }
check()   { if printf '%s' "$3" | grep -qE -- "$2"; then ok "$1"; else bad "$1" "$3"; fi; }   # check <label> <ERE> <actual>
same()    { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$3"; fi; }                       # same  <label> <expected> <actual>
hdr()     { curl -si "$@" | tr -d '\r'; }                                                      # status line + headers + body
head_()   { curl -sI "$@" | tr -d '\r'; }                                                      # HEAD: status line + headers
hdronly() { curl -s -D - -o /dev/null "$@" | tr -d '\r'; }                                     # GET: status line + headers, body discarded (binary assets)
code()    { curl -s -o /dev/null -w '%{http_code}' "$@"; }

run_matrix() {
  local r
  r=$(hdr "$B/" -H 'accept: text/html')
  check 'landing 200'                       '^HTTP/[0-9.]+ 200'                                    "$r"
  check 'landing HSTS'                      '^strict-transport-security: max-age=31536000'          "$r"
  check 'landing x-frame-options DENY'      '^x-frame-options: DENY'                                "$r"
  check 'landing CSP report-only'           '^content-security-policy-report-only: '                "$r"
  check 'landing cache-control public'      '^cache-control: public, max-age=300'                   "$r"
  if printf '%s' "$r" | grep -qi '^set-cookie:'; then bad 'landing sets no cookie' 'set-cookie present'; else ok 'landing sets no cookie'; fi
  check 'HEAD / 200'                        '^HTTP/[0-9.]+ 200'   "$(head_ "$B/")"
  same  'no Accept header -> landing 200'   '200'                 "$(code "$B/" -H 'Accept:')"
  r=$(hdr "$B/api/workspace" -H 'accept: application/json')
  check '/api/workspace 401'                '^HTTP/[0-9.]+ 401'                 "$r"
  check '/api/workspace JSON'               '^content-type: application/json'   "$r"
  check '/api/workspace no-store'           '^cache-control: no-store'          "$r"
  check '/api/workspace body unauthenticated' '"error":"unauthenticated"'       "$r"
  if printf '%s' "$r" | grep -qi '^www-authenticate:'; then bad '/api/workspace has no WWW-Authenticate' 'header present'; else ok '/api/workspace has no WWW-Authenticate'; fi
  check '/credentials -> /login?next=%2Fcredentials' '^location: /login\?next=%2Fcredentials$' "$(hdr "$B/credentials" -H 'accept: text/html')"
  same  '//login 400'                       '400'  "$(code "$B//login")"
  local p
  for p in /robots.txt /sitemap.xml /favicon.ico /og.png /manifest.webmanifest /offline /sw.js /healthz; do
    same "allowlist $p 200" '200' "$(code "$B$p")"
  done
  check '/offline.html 307 -> /offline (vinext redirect; both public)' '^location: /offline$' "$(hdr "$B/offline.html")"
  check 'br encoding offered'               '^content-encoding: br' "$(head_ "$B/" -H 'accept: text/html' -H 'accept-encoding: br')"
}

# The seven latin subsets Task 4 committed. Read from the checkout this script
# lives in, so `matrix` must run from a checkout whose public/fonts matches the
# deployment it probes (the worktree before the merge, main after it).
FONT_DIR="$(cd "$(dirname "$0")/../.." && pwd)/public/fonts"
run_fonts() {   # spec §5.1 self-hosted type: /fonts/ is a public prefix, immutable, woff2
  local f name r
  if ! ls "$FONT_DIR"/*.woff2 >/dev/null 2>&1; then bad 'public/fonts holds the woff2 subsets' "no *.woff2 under $FONT_DIR"; return; fi
  for f in "$FONT_DIR"/*.woff2; do
    name=$(basename "$f")
    r=$(hdronly "$B/fonts/$name" -H 'accept: */*')
    check "font $name 200 unauthenticated"  '^HTTP/[0-9.]+ 200'                                        "$r"
    check "font $name content-type woff2"   '^content-type: font/woff2'                                 "$r"
    check "font $name cache immutable"      '^cache-control: public, max-age=31536000, immutable'       "$r"
  done
}

run_login() {
  : "${OPS_PASSWORD:?set OPS_PASSWORD}"
  curl -si -X POST "$B/auth/login" -H "origin: $B" \
    --data-urlencode 'email=ops@example.test' --data-urlencode "password=$OPS_PASSWORD" \
    | tr -d '\r' > "$TMP/login.txt"
  check 'login 303'                  '^HTTP/[0-9.]+ 303'            "$(cat "$TMP/login.txt")"
  check 'login sets itrack_session'  '^set-cookie: itrack_session=' "$(cat "$TMP/login.txt")"
  C=$(awk 'tolower($1)=="set-cookie:" && $2 ~ /^itrack_session=/ { sub(/;.*/, "", $2); print $2 }' "$TMP/login.txt")
}

ws()   { curl -s "$B/api/workspace" -H 'accept: application/json' -H "cookie: $C"; }
post() { # post <action> <payload-json> -> "<status> <body>"
  local status
  status=$(curl -s -o "$TMP/body.json" -w '%{http_code}' -X POST "$B/api/workspace" \
    -H 'accept: application/json' -H 'content-type: application/json' \
    -H "origin: $B" -H "cookie: $C" --data "{\"action\":\"$1\",\"payload\":$2}")
  printf '%s %s' "$status" "$(cat "$TMP/body.json")"
}

run_workspace() {
  check 'workspace 200 for ops@example.test' '"email":"ops@example.test"' "$(ws)"
}

run_preloads() { # needs the cookie from run_login: the app shell HTML names the preloaded body face
  check 'app shell preloads a /fonts/ face' '/fonts/atkinson-hyperlegible-400-[0-9a-f]{8}\.woff2' "$(curl -s "$B/" -H 'accept: text/html' -H "cookie: $C")"
}

run_actions() {
  local r
  same  'login without Origin 403' '403' "$(code -X POST "$B/auth/login" --data-urlencode 'email=ops@example.test' --data-urlencode "password=$OPS_PASSWORD")"
  r=$(post createCredential '{"credentialName":"Wave 2 check","profession":"Counseling","jurisdiction":"Rhode Island","issuer":"E2E board","totalRequired":10,"unitLabel":"hours","cycleStart":"2026-01-01","deadline":"2027-12-31","categories":[{"name":"General","requiredUnits":10}]}')
  check 'createCredential 200 ok+id' '^200 \{"ok":true,"action":"createCredential","id":"' "$r"
  ID=$(jq -r .id "$TMP/body.json")
  same  'new credential: revision 1, not archived, current cycle' '{"revision":1,"archivedAt":null,"isCurrentCycle":true}' \
        "$(ws | jq -c --arg id "$ID" '.credentials[] | select(.id==$id) | {revision, archivedAt, isCurrentCycle}')"
  same  'activeCycleId is the new credential' "$ID" "$(ws | jq -r .activeCycleId)"
  r=$(post updateCredential "{\"credentialId\":\"$ID\",\"expectedRevision\":1,\"credentialName\":\"Wave 2 check renamed\",\"issuer\":\"E2E board\",\"cycleStart\":\"2026-01-01\",\"deadline\":\"2027-12-31\"}")
  check 'updateCredential rename (expectedRevision 1) 200' '^200 \{"ok":true,"action":"updateCredential"' "$r"
  r=$(post updateCredential "{\"credentialId\":\"$ID\",\"expectedRevision\":1,\"credentialName\":\"Wave 2 check renamed\",\"issuer\":\"E2E board\",\"cycleStart\":\"2026-01-01\",\"deadline\":\"2027-12-31\"}")
  check 'stale expectedRevision 1 -> 409 credential_version_conflict' '^409 .*"code":"credential_version_conflict"' "$r"
  same  'renamed and at revision 2' 'Wave 2 check renamed rev=2' \
        "$(ws | jq -r --arg id "$ID" '.credentials[] | select(.id==$id) | "\(.credentialName) rev=\(.revision)"')"
  r=$(post archiveCredential "{\"credentialId\":\"$ID\",\"expectedRevision\":2}")
  check 'archiveCredential 200' '^200 \{"ok":true,"action":"archiveCredential"' "$r"
  same  'archived: absent from credentials, under archivedCredentials (rev 3), activeCycleId null' \
        "{\"active\":[],\"archived\":[{\"id\":\"$ID\",\"revision\":3,\"archived\":true}],\"activeCycleId\":null}" \
        "$(ws | jq -c '{active: [.credentials[].id], archived: [.archivedCredentials[] | {id, revision, archived: (.archivedAt != null)}], activeCycleId}')"
  r=$(post restoreCredential "{\"credentialId\":\"$ID\",\"expectedRevision\":3}")
  check 'restoreCredential 200' '^200 \{"ok":true,"action":"restoreCredential"' "$r"
  same  'restored: back in credentials (rev 4), archivedCredentials empty, activeCycleId set' \
        "{\"active\":[{\"id\":\"$ID\",\"revision\":4}],\"archived\":[],\"activeCycleId\":\"$ID\"}" \
        "$(ws | jq -c '{active: [.credentials[] | {id, revision}], archived: [.archivedCredentials[].id], activeCycleId}')"
  r=$(post deleteCredential "{\"credentialId\":\"$ID\",\"expectedRevision\":4,\"confirmName\":\"Wave 2 check\"}")
  check 'deleteCredential with the old name -> 400 credential_name_mismatch' '^400 .*"code":"credential_name_mismatch"' "$r"
  r=$(post deleteCredential "{\"credentialId\":\"$ID\",\"expectedRevision\":4,\"confirmName\":\"Wave 2 check renamed\"}")
  check 'deleteCredential with the typed name 200' '^200 \{"ok":true,"action":"deleteCredential"' "$r"
  same  'deleted: credentials [], archivedCredentials [], activeCycleId null' \
        '{"credentials":[],"archivedCredentials":[],"activeCycleId":null}' \
        "$(ws | jq -c '{credentials, archivedCredentials, activeCycleId}')"
  r=$(post updateCredential '{"credentialId":"not-mine","expectedRevision":1,"credentialName":"x","issuer":"x","cycleStart":"2026-01-01","deadline":"2027-12-31"}')
  check 'foreign credentialId -> 404 credential_not_found through the gateway' '^404 .*"code":"credential_not_found"' "$r"
  same  'packet for a foreign credentialId 404' '404' "$(code "$B/api/export/packet?credentialId=not-mine" -H 'accept: application/json' -H "cookie: $C")"
  r=$(post updateReminderPreferences '{"inAppEnabled":true,"pushEnabled":false,"pushHourLocal":9,"leadDays":[90,30,7,1],"timeZone":"America/New_York"}')
  check 'updateReminderPreferences America/New_York 200' '^200 \{"ok":true,"action":"updateReminderPreferences","id":"reminder-preferences"\}$' "$r"
  same  'stored time zone is America/New_York' 'America/New_York' "$(ws | jq -r .reminderPreferences.timeZone)"
}

echo "run-check against $B (mode: $MODE)"
case "$MODE" in
  matrix)  run_matrix; run_fonts ;;
  seed)    run_login; run_workspace; run_preloads ;;
  actions) run_login; run_workspace; run_preloads; run_actions ;;
  all)     run_matrix; run_fonts; run_login; run_workspace; run_preloads; run_actions ;;
  *) echo "unknown mode: $MODE"; rm -rf "$TMP"; exit 2 ;;
esac
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
rm -rf "$TMP"
[ "$FAIL" -eq 0 ]
