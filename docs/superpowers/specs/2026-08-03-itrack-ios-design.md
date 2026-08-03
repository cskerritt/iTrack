# iTrack iOS — Design

**Date:** 2026-08-03 · **Status:** Approved by Chris · **Tracking:** TC-002-08-03-26-ios-appstore-app

## Goal

A private iOS app for Chris (single user) distributed via TestFlight that delivers
what the PWA cannot: reliable push reminders (APNs), real-app feel, home/lock-screen
widgets, and native document scanning for CE certificates. Not a public product.

## Constraints and facts

- Apple Developer Program: enrolled. Xcode 26.6 on the Mac mini builds locally.
- iTrack web app: React single-page UI served by a Cloudflare-Workers-style backend
  (vinext RSC, D1/R2 via drizzle) running on Railway under `deploy/railway/serve.mjs`,
  which injects identity headers. Prod currently runs `ITRACK_OPEN_IDENTITY`
  (no auth). A 15-minute cron delivers web-push reminders (`app/lib/webPush.ts`,
  `rfc8291Push.ts`, `pushDelivery.ts`).
- There is no JSON API; the UI is server-rendered. A native rewrite is out of scope.

## Approach (chosen: A — hybrid shell + native extensions)

A Capacitor iOS app whose web layer is **remote** (`server.url` = the Railway
deployment). All product UI stays in the web codebase; every web deploy appears in
the app immediately. Native Swift is reserved for the four things that need it.

Rejected: full SwiftUI rewrite (no API exists; weeks of duplicated UI for one
user); hand-rolled WKWebView wrapper (reimplements Capacitor's bridge for no gain).

## Components

### New repo: `iTrack-iOS` (~/Documents/New project/iTrack-iOS)

1. **App shell (Capacitor, latest stable major at scaffold time; Swift).** Full-screen WKWebView of the live app; no
   browser chrome; native splash using the brand mark; status-bar style follows
   the color scheme; external links open in Safari; pull-to-refresh.
   The shell contains no product logic.
2. **Push registration.** On launch, request notification permission, register
   with APNs, POST the device token to the backend (`POST /api/apns-token`,
   authenticated like every other request). Tapping a notification opens the app
   at the reminder's URL (payload carries a path).
3. **WidgetKit extension (SwiftUI).** Two widget families:
   - accessory/lock **circular gauge**: days to nearest renewal;
   - home **medium card**: credential name, days left, credits done/required as a
     progress bar, readiness %.
   Data from `GET /api/widget-summary` using a dedicated bearer token stored in
   the shared App Group Keychain. Timeline refresh ~4×/day plus reload on app
   foreground. On fetch failure, render last-known snapshot (cached in the App
   Group container) with a stale indicator.
4. **Certificate scanner.** A native button (Capacitor plugin) presents
   VisionKit's `VNDocumentCameraViewController`; scanned pages are uploaded
   through the same endpoint the web file-input uses, then the webview navigates
   to the existing OCR-review flow. The web input remains functional.
5. **Auth plumbing.** Credentials stored in the iOS Keychain; the shell answers
   the Basic Auth challenge (`WKWebView` `didReceive challenge`) so the webview
   never shows a login sheet. First launch shows a minimal native sign-in form
   that validates against the server before saving.

### Changes in the existing iTrack repo (this repo)

6. **APNs sender.** Alongside web push: ES256 JWT (`.p8` key, key ID, team ID
   from env vars) against `api.push.apple.com` HTTP/2. The reminder cron fans out
   to both channels; APNs tokens live in a new D1 table (drizzle migration 0012)
   with last-seen + invalidation on Apple's `410 Unregistered`.
7. **`GET /api/widget-summary`.** Tiny JSON: per credential — name, state, due
   date, credits done/required, readiness %. Auth: constant-time comparison
   against `ITRACK_WIDGET_TOKEN` env var. No PII beyond credential names.
8. **`POST /api/apns-token`.** Stores/refreshes the device token for the
   authenticated identity.
9. **Auth switch.** Railway env: remove `ITRACK_OPEN_IDENTITY`, set
   `ITRACK_USERS` (Chris's credentials) — closes the anyone-with-the-URL hole.
   No code change; `serve.mjs` already fails closed.

## Data flow

- Reminders: cron → reminder computation (existing) → web-push AND APNs.
- Widgets: WidgetKit timeline → `GET /api/widget-summary` (bearer token) → render;
  app foreground → `WidgetCenter.reloadAllTimelines()`.
- Scans: VisionKit → JPEG pages → existing upload endpoint (Basic Auth from
  Keychain) → existing OCR/filing flow in the webview.

## Error handling

- No network: webview shows the existing offline page; widgets show stale
  snapshot; scanner queues nothing (fails visibly — no offline queue, YAGNI).
- APNs failures: log per-token; drop token on 410; cron continues web-push
  regardless (channels are independent).
- Auth failure in shell: re-present the native sign-in form.

## Testing

- Backend (existing 122-test suite grows): APNs JWT construction + sender against
  a mocked endpoint incl. 410 handling; widget-summary auth (reject wrong/absent
  token, constant-time), shape, and no-PII assertion; apns-token store/refresh.
- iOS: manual smoke checklist (launch, login, push permission + test notification,
  both widgets, scan round-trip, dark/light) — no XCTest suite for ~300 lines of
  shell serving one user.
- Gates for the web repo remain: `npm test`, typecheck, lint (Node 22).

## Distribution

`xcodebuild` archive + upload scripts committed in `iTrack-iOS/scripts/` so the
~90-day TestFlight re-upload is one command. Bundle ID `com.kwvrs.itrack` (final
ID confirmed at scaffold time against the developer account).

## Out of scope (deliberate)

Offline mode, in-app theme toggle, multi-user signup, iPad-optimized layout,
public App Store listing, Android.
