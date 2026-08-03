# iTrack iOS App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A private TestFlight iOS app wrapping the hosted iTrack web app, adding APNs push reminders, WidgetKit widgets, and VisionKit certificate scanning; backend gains the APNs sender, widget endpoint, token registration, and re-enabled auth.

**Architecture:** Two codebases. Backend work (Tasks 1–8) lands in the existing iTrack repo (`~/Documents/New project/Vigilo`): a new APNs delivery lib mirroring the existing web-push delivery, two small API routes, env plumbing. iOS work (Tasks 9–13) lands in a NEW repo `~/Documents/New project/iTrack-iOS`: a Capacitor shell with `server.url` pointing at Railway prod, plus Swift for auth, push, widgets, and scanning.

**Tech Stack:** TypeScript (Cloudflare-Workers runtime, drizzle/D1), node:test with TS-transpile pattern, Capacitor (latest stable), Swift/SwiftUI (WidgetKit, VisionKit), Xcode 26.6.

## Global Constraints

- Node 22 required for all backend work: `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"`
- Backend gates must stay green after every task: `npm test && npm run typecheck && npm run lint` in the iTrack repo (test count grows from 122; never shrinks).
- Zero new npm runtime dependencies in the iTrack repo (WebCrypto only — the repo already does ES256-adjacent crypto in `app/lib/rfc8291Push.ts`).
- No color literals outside the two `:root` blocks of `app/globals.css` (unchanged by this plan; stated because reviewers enforce it).
- All identity-checked routes use `resolveRequestIdentity(request)` from `@/db/identity`; env access is `import { env } from "cloudflare:workers"` in app code and the `Env` type in `db/cloudflare.d.ts`.
- Bundle ID `com.kwvrs.itrack` (verify availability in the Apple Developer account at Task 9; if taken, `com.kwvrs.itrack.app`).
- Commit after every task; iTrack-repo pushes auto-deploy Railway prod, so push only at the checkpoints marked PUSH-SAFE.
- Do not commit secrets: the `.p8` APNs key, `ITRACK_USERS`, and `ITRACK_WIDGET_TOKEN` live only in Railway env vars / local `.env` files that are gitignored.

---

## Phase 1 — Backend (repo: `~/Documents/New project/Vigilo`)

### Task 1: APNs device + ledger schema (migration 0012)

**Files:**
- Modify: `db/schema.ts` (append after `pushDeliveryLedger`, ~line 610)
- Create: `drizzle/0012_*.sql` (generated)
- Test: `tests/real-sqlite-seed.test.mjs` (extend — read its header first; it seeds the real migration chain)

**Interfaces:**
- Produces: `apnsDevices`, `apnsDeliveryLedger` drizzle tables imported as `import { apnsDevices, apnsDeliveryLedger } from "@/db/schema"`.

- [ ] **Step 1: Add tables to `db/schema.ts`**, modeled exactly on `pushSubscriptions`/`pushDeliveryLedger` (same column style, text timestamps, `CURRENT_TIMESTAMP` defaults):

```ts
export const apnsDevices = sqliteTable(
  "apns_devices",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceToken: text("device_token").notNull(),
    environment: text("environment").notNull().default("production"),
    deviceLabel: text("device_label"),
    failureCount: integer("failure_count").notNull().default(0),
    lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    lastSuccessAt: text("last_success_at"),
    lastFailureAt: text("last_failure_at"),
    disabledAt: text("disabled_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("apns_devices_token_unique").on(table.deviceToken),
    index("apns_devices_user_active_idx").on(
      table.userId,
      table.disabledAt,
      table.updatedAt,
    ),
  ],
);

export const apnsDeliveryLedger = sqliteTable(
  "apns_delivery_ledger",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id")
      .notNull()
      .references(() => apnsDevices.id, { onDelete: "cascade" }),
    reminderKey: text("reminder_key").notNull(),
    scheduledFor: text("scheduled_for").notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: text("last_attempt_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("apns_ledger_device_reminder_unique").on(
      table.deviceId,
      table.reminderKey,
      table.scheduledFor,
    ),
  ],
);
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new `drizzle/0012_<name>.sql` containing both `CREATE TABLE`s and the three indexes. Read it to confirm.

- [ ] **Step 3: Extend the seed test** — open `tests/real-sqlite-seed.test.mjs`, find where it asserts tables exist after running migrations, and add `apns_devices` and `apns_delivery_ledger` to that assertion following the file's existing pattern.

- [ ] **Step 4: Run gates** — `npm test` (all pass, count grows), `npm run typecheck`, `npm run lint`.

- [ ] **Step 5: Commit** — `git add db/schema.ts drizzle tests/real-sqlite-seed.test.mjs && git commit -m "Add APNs device and delivery-ledger tables (migration 0012)"`

### Task 2: APNs ES256 JWT (`app/lib/apnsJwt.ts`)

**Files:**
- Create: `app/lib/apnsJwt.ts`
- Test: `tests/apns-jwt.test.mjs`

**Interfaces:**
- Produces: `createApnsJwt(config: ApnsJwtConfig, nowMs: number): Promise<string>` and `export type ApnsJwtConfig = { teamId: string; keyId: string; privateKeyPem: string }`. Deterministic given `nowMs`; callers cache.

- [ ] **Step 1: Write the failing test** `tests/apns-jwt.test.mjs`, using the repo's TS-transpile-and-data-URL-import pattern (copy the header of `tests/rfc8291-push.test.mjs` verbatim, pointing at `../app/lib/apnsJwt.ts`). Generate a throwaway P-256 key inside the test with WebCrypto, export as PKCS#8 PEM, then assert:

```js
test("createApnsJwt produces a verifiable ES256 JWT", async () => {
  const { pem, publicKey } = await generateTestKeyPem(); // helper in this test file: subtle.generateKey ECDSA P-256 -> exportKey pkcs8 -> PEM-wrap
  const jwt = await apnsJwt.createApnsJwt(
    { teamId: "TEAMID9999", keyId: "KEYID99999", privateKeyPem: pem },
    1_754_000_000_000,
  );
  const [h, p, sig] = jwt.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(header.alg, "ES256");
  assert.equal(header.kid, "KEYID99999");
  assert.equal(payload.iss, "TEAMID9999");
  assert.equal(payload.iat, 1_754_000_000); // seconds
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    Buffer.from(sig, "base64url"),
    Buffer.from(`${h}.${p}`),
  );
  assert.equal(ok, true);
});
test("rejects an unparseable PEM", async () => {
  await assert.rejects(
    apnsJwt.createApnsJwt(
      { teamId: "T", keyId: "K", privateKeyPem: "not-a-pem" },
      0,
    ),
  );
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/apns-jwt.test.mjs` fails (module missing).

- [ ] **Step 3: Implement `app/lib/apnsJwt.ts`** — PEM → strip header/footer/whitespace → base64 decode → `crypto.subtle.importKey("pkcs8", …, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])`; build `{alg:"ES256",kid}` header and `{iss,iat}` payload with base64url (no padding); sign `header.payload` with `{ name: "ECDSA", hash: "SHA-256" }` (WebCrypto emits the raw r||s signature JOSE expects — no DER conversion). Match the coding style of `rfc8291Push.ts` (typed config, thrown `Error` with actionable message on bad PEM).

- [ ] **Step 4: Run test to verify pass**, then full gates.

- [ ] **Step 5: Commit** — `git commit -m "Add APNs ES256 JWT builder"`

### Task 3: APNs HTTP sender (`app/lib/apnsPush.ts`)

**Files:**
- Create: `app/lib/apnsPush.ts`
- Test: `tests/apns-push.test.mjs`

**Interfaces:**
- Consumes: `createApnsJwt` from Task 2.
- Produces:
  - `export type ApnsConfig = ApnsJwtConfig & { bundleId: string; environment: "production" | "sandbox" }`
  - `export type ApnsSendOutcome = { ok: boolean; status: number; unregistered: boolean; reason: string | null }`
  - `sendApnsNotification(deviceToken: string, notification: PushNotificationData, config: ApnsConfig, fetchImpl?: typeof fetch): Promise<ApnsSendOutcome>` — `PushNotificationData` is the existing `{ title; body; tag; url }` from `app/lib/pushDelivery.ts` (import the type from there).
  - `normalizeApnsConfig(raw: Partial<Record<string,string|undefined>>): ApnsConfig | null` — returns null when any of team/key/pem/bundle is missing (mirrors `normalizeWebPushConfig`'s not-configured contract).

- [ ] **Step 1: Write failing tests** (same transpile pattern). Inject `fetchImpl` — never hit the network:

```js
test("sends to the right host with JWT auth and apns headers", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  };
  const outcome = await apns.sendApnsNotification(
    "devicetoken123", { title: "T", body: "B", tag: "renewal-x", url: "/today" },
    { ...TEST_JWT_CONFIG, bundleId: "com.kwvrs.itrack", environment: "production" },
    fakeFetch,
  );
  assert.equal(outcome.ok, true);
  assert.equal(calls[0].url, "https://api.push.apple.com/3/device/devicetoken123");
  assert.equal(calls[0].init.headers["apns-topic"], "com.kwvrs.itrack");
  assert.equal(calls[0].init.headers["apns-push-type"], "alert");
  assert.match(calls[0].init.headers.authorization, /^bearer .+\..+\..+$/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.aps.alert.title, "T");
  assert.equal(body.aps["thread-id"], "renewal-x");
  assert.equal(body.url, "/today");
});
test("maps 410 Unregistered to unregistered:true", async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ reason: "Unregistered" }), { status: 410 });
  const outcome = await apns.sendApnsNotification("t", NOTE, CONFIG, fakeFetch);
  assert.deepEqual(outcome, { ok: false, status: 410, unregistered: true, reason: "Unregistered" });
});
test("sandbox environment targets api.sandbox.push.apple.com", async () => {
  const calls = [];
  const fakeFetch = async (url) => { calls.push(String(url)); return new Response(null, { status: 200 }); };
  await apns.sendApnsNotification("t", NOTE, { ...CONFIG, environment: "sandbox" }, fakeFetch);
  assert.match(calls[0], /^https:\/\/api\.sandbox\.push\.apple\.com\//);
});
test("normalizeApnsConfig returns null when any field is missing", () => {
  const full = { teamId: "T", keyId: "K", privateKeyPem: "P", bundleId: "B", environment: "production" };
  assert.notEqual(apns.normalizeApnsConfig(full), null);
  for (const key of ["teamId", "keyId", "privateKeyPem", "bundleId"]) {
    assert.equal(apns.normalizeApnsConfig({ ...full, [key]: undefined }), null);
  }
});
```

- [ ] **Step 2: Verify fail.** — [ ] **Step 3: Implement** (host by environment; JWT cached in a module-level `{token, mintedAtMs}` reused under 50 minutes; payload `{ aps: { alert: {title, body}, sound: "default", "thread-id": tag }, url }`). — [ ] **Step 4: Verify pass + gates.** — [ ] **Step 5: Commit** `"Add APNs HTTP sender with 410 mapping"`.

### Task 4: Scheduled APNs delivery (`app/lib/apnsDelivery.ts`)

**Files:**
- Create: `app/lib/apnsDelivery.ts`
- Test: `tests/apns-delivery.test.mjs`

**Interfaces:**
- Consumes: `sendApnsNotification`/`normalizeApnsConfig` (Task 3); `loadReminderData`, `localReminderClock` from `app/lib/reminders.ts`; the tables from Task 1. **Read `app/lib/pushDelivery.ts` end-to-end first** — this file deliberately mirrors its structure (materialize due reminders into the ledger, then attempt pending rows with `MAX_ATTEMPTS = 4`), one channel simpler.
- Produces: `runScheduledApnsDelivery({ database, scheduledTime, config }: { database: D1Database; scheduledTime: number; config: Partial<Record<string,string|undefined>>; sendImpl?: typeof sendApnsNotification }): Promise<ApnsDeliveryResult>` where `ApnsDeliveryResult = { configured: boolean; devices: number; materialized: number; delivered: number; failed: number; disabled: number }`.

- [ ] **Step 1: Write failing tests** using the in-memory/real-sqlite harness from `tests/real-sqlite-seed.test.mjs` (same D1-compatible wrapper it uses) with a seeded user + credential + reminder due now + one active `apns_devices` row. Cases: (a) unconfigured env → `{configured:false}` and no send; (b) due reminder materializes one ledger row and calls `sendImpl` once with the device token and a `PushNotificationData` whose `url` matches the reminder target; (c) second run same scheduledTime sends nothing (ledger dedupe on device+reminderKey+scheduledFor); (d) `sendImpl` returning `{unregistered:true}` sets `disabledAt` on the device and does not retry it; (e) failure below MAX_ATTEMPTS leaves status pending with attemptCount incremented.

- [ ] **Step 2: Verify fail.** — [ ] **Step 3: Implement**, reusing the exact reminder-selection helpers `pushDelivery.ts` uses (`loadReminderData`, `localReminderClock`, `validReminderTimeZone`, respecting `reminder_preferences.pushHourLocal`). — [ ] **Step 4: Verify pass + gates.** — [ ] **Step 5: Commit** `"Add scheduled APNs reminder delivery"`.

### Task 5: Wire APNs into the cron + env plumbing

**Files:**
- Modify: `worker/index.ts` (scheduled handler, ~line 92; also the `/internal/run-scheduled` branch ~line 50)
- Modify: `db/cloudflare.d.ts` (`Env`, ~line 82)
- Modify: `deploy/railway/serve.mjs` (forwarded-vars list, ~line 118)

**Interfaces:**
- Consumes: `runScheduledApnsDelivery` (Task 4).
- Produces: env contract — `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY` (full `.p8` PEM text), `APNS_BUNDLE_ID`, `APNS_ENVIRONMENT`, `ITRACK_WIDGET_TOKEN` all typed on `Env` and forwarded by serve.mjs.

- [ ] **Step 1:** Add the six optional string fields to `Env` in `db/cloudflare.d.ts` beside `VAPID_PUBLIC_KEY`.
- [ ] **Step 2:** In `worker/index.ts` `scheduled`, after the web-push block (inside the same `waitUntil` async body, wrapped in its own try/catch so one channel's failure never blocks the other), call `runScheduledApnsDelivery({ database: env.DB, scheduledTime: controller.scheduledTime, config: { teamId: env.APNS_TEAM_ID, keyId: env.APNS_KEY_ID, privateKeyPem: env.APNS_PRIVATE_KEY, bundleId: env.APNS_BUNDLE_ID, environment: env.APNS_ENVIRONMENT } })` and `console.info` its JSON result. Mirror the same call in the `/internal/run-scheduled` fetch branch.
- [ ] **Step 3:** Append the five `APNS_*` names and `ITRACK_WIDGET_TOKEN` to the forwarded-vars array in `serve.mjs` (~line 118).
- [ ] **Step 4:** Gates. — [ ] **Step 5: Commit** `"Fan reminder delivery out to APNs beside web push"`. **PUSH-SAFE** (APNs stays dormant until env vars exist).

### Task 6: `POST /api/apns-token` route

**Files:**
- Create: `app/api/apns-token/route.ts`
- Test: `tests/apns-delivery.test.mjs` (extend with the upsert helper) — Create: `app/lib/apnsRegistration.ts`

**Interfaces:**
- Consumes: `resolveRequestIdentity`, `getDb`, `apnsDevices` table.
- Produces: `registerApnsDevice(db, { userId, deviceToken, environment, deviceLabel }): Promise<{ id: string; created: boolean }>` in `app/lib/apnsRegistration.ts` (testable core); route accepts JSON `{ deviceToken: string; environment?: "production"|"sandbox"; deviceLabel?: string }`, 401 without identity, 400 on missing/non-string token or token > 200 chars, 200 `{ ok: true }`; re-registration of an existing token updates `lastSeenAt`/`userId` and clears `disabledAt`/`failureCount` (a reinstalled app must resurrect its token).

- [ ] **Step 1:** Failing tests for `registerApnsDevice`: create, idempotent upsert clears `disabledAt`, second user claiming same token reassigns it.
- [ ] **Step 2:** Verify fail. — [ ] **Step 3:** Implement lib + thin route (copy the 401 shape from `app/api/catalog/route.ts`, `Cache-Control: no-store`). — [ ] **Step 4:** Gates. — [ ] **Step 5: Commit** `"Add APNs device registration endpoint"`. 

### Task 7: `GET /api/widget-summary` route

**Files:**
- Create: `app/lib/widgetSummary.ts`, `app/api/widget-summary/route.ts`
- Test: `tests/widget-summary.test.mjs`

**Interfaces:**
- Consumes: `getDb`; credential/cycle tables (mirror whatever query the dashboard hero uses — find it via `daysToRenewal`/readiness usage in `app/ITrackApp.tsx`'s workspace data source, `app/api/workspace/route.ts`).
- Produces:
  - `buildWidgetSummary(database: D1Database, userId: string, nowMs: number): Promise<WidgetSummary>` with `WidgetSummary = { generatedAt: string; credentials: Array<{ name: string; daysToRenewal: number | null; dueDate: string | null; creditsDone: number; creditsRequired: number; readinessPercent: number }> }` sorted by soonest due.
  - `constantTimeEquals(a: string, b: string): boolean` exported for test.
  - Route: `authorization: Bearer <ITRACK_WIDGET_TOKEN>` compared constant-time; 503 when the env var is unset; 401 on mismatch; `Cache-Control: no-store`. The single-user install serves the first (only) user's summary: resolve `userId` as the sole row of `users` and 404 if none.

- [ ] **Step 1:** Failing tests: summary shape/sort from seeded data; `constantTimeEquals` agrees with `===` on equal/unequal strings of equal and unequal length; token gate: 503 unset / 401 wrong / 200 right (invoke the route handler directly with a `Request`, setting env via the same mechanism existing route tests use — if none exists, keep the token check in a pure function `authorizeWidgetRequest(request, expectedToken)` and unit-test that).
- [ ] **Step 2:** Verify fail. — [ ] **Step 3:** Implement. — [ ] **Step 4:** Gates. — [ ] **Step 5: Commit** `"Add token-authenticated widget summary endpoint"`. **PUSH-SAFE.**

### Task 8: Production env cutover (operator + assistant, gated)

**Files:** none (Railway env). **This task is blocked on Chris supplying:** the `.p8` APNs key (create in developer.apple.com → Keys → enable APNs), its Key ID, the Team ID, and a chosen password.

- [ ] **Step 1:** Generate a widget token locally: `openssl rand -base64 32`.
- [ ] **Step 2:** Set Railway vars on the iTrack service (via `railway variables set` or dashboard): `ITRACK_USERS="chris:<password>:chris@kwvrs.com:Chris Skerritt"`, `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY` (paste full PEM), `APNS_BUNDLE_ID=com.kwvrs.itrack`, `APNS_ENVIRONMENT=production`, `ITRACK_WIDGET_TOKEN=<generated>`.
- [ ] **Step 3:** Remove `ITRACK_OPEN_IDENTITY`. Redeploy.
- [ ] **Step 4:** Verify: unauthenticated `curl -i https://itrack-production-da8b.up.railway.app/` → 401 with `WWW-Authenticate: Basic`; with credentials → 200; `curl -H "authorization: Bearer <token>" .../api/widget-summary` → 200 JSON; wrong token → 401.

## Phase 2 — iOS (new repo: `~/Documents/New project/iTrack-iOS`)

### Task 9: Scaffold Capacitor shell + Keychain Basic Auth

**Files (all new repo):**
- Create: repo via `npm init @capacitor/app@latest itrack-ios` then `npx cap add ios`; `capacitor.config.ts`; `ios/App/App/AuthChallengeHandler.swift`; `ios/App/App/SignInView.swift`; `ios/App/App/KeychainStore.swift`; `.gitignore` (Capacitor default + `ios/App/Pods`), `README.md` (how to build), git init + GitHub private repo `cskerritt/iTrack-iOS`.

**Interfaces:**
- Produces: `KeychainStore` with `static func save(service: String, account: String, secret: Data) -> Bool`, `static func load(service: String, account: String) -> Data?`, `static func delete(service: String, account: String)` — service strings `"itrack.basic-auth"` (payload: `user:pass` UTF-8) and `"itrack.widget-token"`; Task 11 reads the widget token via an **App Group** keychain access group `group.com.kwvrs.itrack` (set `kSecAttrAccessGroup`).

- [ ] **Step 1:** Scaffold; `capacitor.config.ts`:

```ts
import type { CapacitorConfig } from "@capacitor/cli";
const config: CapacitorConfig = {
  appId: "com.kwvrs.itrack",
  appName: "iTrack",
  webDir: "www",            // placeholder dir with a single redirect index.html
  server: { url: "https://itrack-production-da8b.up.railway.app", cleartext: false },
  ios: { contentInset: "always" },
};
export default config;
```

- [ ] **Step 2:** Implement `KeychainStore.swift` (SecItemAdd/CopyMatching/Delete, `kSecClassGenericPassword`, `kSecAttrAccessibleAfterFirstUnlock`).
- [ ] **Step 3:** Basic Auth: subclass the Capacitor `WKNavigationDelegate` hook — in `AppDelegate` adopt `capacitorDidLoad` bridging or simpler: implement `webView(_:didReceive challenge:completionHandler:)` via a `CAPBridgeViewController` subclass registered in `Main.storyboard`, answering `URLCredential(user:password:persistence:.forSession)` from `KeychainStore`; on `previousFailureCount > 0`, present `SignInView` (SwiftUI sheet: two fields + Save that validates by `URLSession` GET to the server expecting 200, then stores and reloads the webview).
- [ ] **Step 4:** In Xcode: set team/signing to the enrolled account, bundle ID `com.kwvrs.itrack`, deployment target iOS 17, app icon from `Vigilo/public/icon-512.png` + brand splash (dark `#163f36` background, brand mark centered).
- [ ] **Step 5:** Smoke on device/simulator: launches, prompts once, renders the live app in light and dark. Commit `"Scaffold Capacitor shell with Keychain Basic Auth"`.

### Task 10: APNs registration + notification taps

**Files:** Modify `ios/App/App/AppDelegate.swift`; add `@capacitor/push-notifications` plugin (`npm i @capacitor/push-notifications && npx cap sync ios`); enable Push Notifications capability + Background Modes → Remote notifications in Xcode.

**Interfaces:**
- Consumes: `POST /api/apns-token` (Task 6) with Basic Auth from `KeychainStore`; produces nothing downstream.

- [ ] **Step 1:** On launch after auth is known-good: `UNUserNotificationCenter.requestAuthorization([.alert,.badge,.sound])` → `registerForRemoteNotifications()`; in `didRegisterForRemoteNotificationsWithDeviceToken`, hex-encode and `POST /api/apns-token` `{ deviceToken, environment: "production", deviceLabel: UIDevice.current.name }` with the Basic Auth header; log failures, retry next launch (no queue).
- [ ] **Step 2:** In `userNotificationCenter(_:didReceive:)`, read `response.notification.request.content.userInfo["url"]` and load `serverURL + path` in the webview.
- [ ] **Step 3:** Smoke: with Task 8 done, run the backend's `/internal/run-scheduled` (or wait for cron with a due reminder) and confirm the phone gets the banner; tap opens the right screen. Commit `"Register for APNs and deep-link notification taps"`.

### Task 11: WidgetKit extension

**Files:** New target `iTrackWidgets` (File → New → Target → Widget Extension, no live activity); `ios/App/iTrackWidgets/SummaryProvider.swift`, `RenewalGaugeWidget.swift`, `RenewalCardWidget.swift`; App Groups capability `group.com.kwvrs.itrack` on BOTH targets; widget token entry field added to `SignInView` (stored via `KeychainStore` in the shared access group).

**Interfaces:**
- Consumes: `GET /api/widget-summary` with `authorization: Bearer <token>`; JSON decoded as:

```swift
struct WidgetSummary: Codable {
  struct Credential: Codable {
    let name: String; let daysToRenewal: Int?; let dueDate: String?
    let creditsDone: Double; let creditsRequired: Double; let readinessPercent: Int
  }
  let generatedAt: String; let credentials: [Credential]
}
```

- [ ] **Step 1:** `SummaryProvider: TimelineProvider` — fetch, cache last-good JSON to the App Group container (`FileManager.containerURL(forSecurityApplicationGroupIdentifier:)`, file `summary.json`); on error load cache and set `isStale = true` on the entry; timeline: 4 entries 6h apart, `.atEnd`.
- [ ] **Step 2:** `RenewalGaugeWidget` (`.accessoryCircular` + `.systemSmall`): `Gauge` of `daysToRenewal` for the soonest credential, label = days. `RenewalCardWidget` (`.systemMedium`): name, "N days to renewal", `ProgressView(value: creditsDone/creditsRequired)`, readiness %; stale entries render a small clock glyph. Colors: brand `#15352f`/`#8ad3b4` light, `#0d1917`/`#8fdec1` dark via asset-catalog color sets.
- [ ] **Step 3:** App foreground hook in `AppDelegate`: `WidgetCenter.shared.reloadAllTimelines()`.
- [ ] **Step 4:** Smoke: add both widgets, verify data, airplane-mode → stale render. Commit `"Add renewal gauge and card widgets"`.

### Task 12: VisionKit certificate scanner

**Files:** `ios/App/App/ScannerPlugin.swift` (+ `ScannerPlugin.m` bridging registration per Capacitor custom-plugin docs); a small JS injection registering a toolbar affordance is NOT needed — expose via the app's existing UI: implement as a floating native button overlaid on the webview only on `/records` paths (`WKNavigationDelegate` URL observation).

**Interfaces:**
- Consumes: the existing web upload endpoint — read `Vigilo/app/api/evidence/route.ts` + `_shared.ts` for the exact `POST` content type/fields and replicate the browser's multipart form (`URLSession` upload with Basic Auth). Produces: after upload, webview reloads current page so the new evidence appears in the normal flow.

- [ ] **Step 1:** `VNDocumentCameraViewController` presentation from the floating button; on `didFinishWith scan:`, JPEG-encode pages at 0.8, upload sequentially; show a native progress HUD; on completion reload webview; on failure show an alert with the server message (fail visibly — no offline queue, per spec).
- [ ] **Step 2:** Smoke: scan a real certificate, confirm it lands in Records and OCR review works. Commit `"Add VisionKit certificate scanning into the evidence flow"`.

### Task 13: TestFlight pipeline + smoke checklist

**Files:** `scripts/archive-and-upload.sh`; `docs/SMOKE.md`; App Store Connect app record (name "iTrack", private, no public listing).

- [ ] **Step 1:** `scripts/archive-and-upload.sh`: `xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Release archive -archivePath build/iTrack.xcarchive` → `xcodebuild -exportArchive` with an `ExportOptions.plist` (`method: app-store-connect`, `uploadSymbols: true`) → `xcrun altool --upload-app` (or `xcodebuild -exportArchive -allowProvisioningUpdates` + Transporter; use App Store Connect API key auth, key path from env `ASC_KEY_PATH`).
- [ ] **Step 2:** `docs/SMOKE.md` — the 8-line checklist: launch, auth once, light/dark, push banner + tap deep-link, both widgets fresh + stale, scan round-trip, external link opens Safari, 90-day re-upload command.
- [ ] **Step 3:** Upload build 1.0 (1), add Chris as internal tester, install via TestFlight on the phone, run the checklist. Commit `"Add TestFlight archive/upload pipeline"`.

---

## Self-review notes

- Spec coverage: shell (T9), push (T2–T6, T10), widgets (T7, T11), scanner (T12), auth switch (T8, T9), distribution (T13), error handling (T3 410-mapping, T4 retry/disable, T11 stale cache, T12 fail-visibly), testing scope per spec (backend TDD, iOS smoke).
- The dashboard-query detail in T7 deliberately points the implementer at `app/api/workspace/route.ts` rather than guessing field names; `WidgetSummary` is the contract both sides code to.
- iOS tasks carry smoke steps instead of test cycles by explicit spec decision.
