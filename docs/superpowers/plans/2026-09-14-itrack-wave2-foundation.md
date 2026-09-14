# iTrack Wave 2 — Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the codebase safe to decompose and correct at its data model: a two-identity isolation suite that lands before `route.ts` is touched, tests that assert behaviour instead of source text (Playwright per screen on four projects — both colour schemes at 1440×900 and 390×844 — unit tests for the pure modules the deleted pins encoded, a contrast audit that walks every stylesheet), the iOS residue gone with the seven legacy identifiers pinned, and three product fixes — credential edit/archive/restore/delete, local dates with a one-tap device-time-zone offer, and current-cycle selection with renewed cycles grouped under their credential.

**Architecture:** The worker keeps its shape (`app/api/workspace/route.ts` stays one file this wave; the decomposition is Wave 3/4 work that the new `tests/isolation.test.mjs` and the per-screen Playwright suite exist to protect). Server work is additive: one D1 migration (`0014_credential_archive`: `credentials.revision`, `credentials.archived_at`), four new revision-guarded workspace actions, an `activeCycleId` derivation in `getWorkspace`, and `todayLocal(tz)` from a new import-free `app/lib/dates.ts`; the reminder scheduler is unchanged because it already fires at `pushHourLocal` in the stored zone — the defect is only that the stored zone is the literal `'UTC'`. Client work stays inside `app/ITrackApp.tsx` (minimal markup, existing classes; Wave 3 restyles) plus two new pure modules (`app/lib/dates.ts`, `app/lib/cycles.ts`) compiled by the existing `tsc --outDir .test-build` pattern. Tests move from 196 source-regex pins over `ITrackApp.tsx`/`globals.css`/`layout.tsx`/the built chunk to `tests/e2e/*.spec.ts` (shared `fixtures.ts`, demo identity for read-only screens, a fresh `oai-authenticated-user-email` identity for anything that writes) and `tests/*.test.mjs` unit files; the ~111 server-source pins are deliberately left for the wave that splits `route.ts`.

**Tech Stack:** Node 22 (`node:sqlite` behind `--experimental-sqlite`, `node:crypto`, `node:test`), Vinext 0.0.50 / Next App Router on workerd via wrangler 4.92, React 19.2, Drizzle Kit 0.31 (sqlite), TypeScript 5.9 (`tsc --outDir .test-build` for pure-module tests), Playwright 1.63 (`@playwright/test`, four projects — scheme × viewport — e2e only), Docker, Railway. No new npm dependencies this wave (`@axe-core/playwright` is Wave 3).

**Spec:** `docs/superpowers/specs/2026-09-10-itrack-web-redesign-design.md` — this plan implements **section 4** (Wave 2 — Foundation, all seven bullets), the Wave 2 line of **section 8** (migrations continue in `drizzle/`; identity unchanged) and the Wave 2 rows of **section 9** (node:test for dates/navigation/extracted `app/lib/*`; built worker against real node:sqlite for seed, isolation and actions; Playwright against the dev server per screen; `tools/contrast-audit.mjs` across all stylesheets with zero literals outside token files; Docker run-check before merge, live smoke after deploy). Sections 5–7 are later waves and are deliberately not planned here. Audit finding ids cited per task refer to `docs/audits/2026-09-10-audit/findings.json`; the six verified code maps that accompany this plan are the source for every line number below (main @ `8ac172a`).

## Global Constraints

- **Node:** use Node 22 at `$HOME/.local/node/node-v22.22.0-darwin-arm64/bin` (Node 25 on this machine has an npm/TLS bug). Every shell in this plan starts with `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"`.
- **Repo / branch:** `/Users/chrisskerritt/Documents/New project/Vigilo`, remote `origin` = `https://github.com/cskerritt/iTrack.git`. Work on branch `feat/wave2-foundation` cut from `main` at `8ac172a` (Wave 1 merged and live); merge to `main` only in Task 13 (pushes to `main` auto-deploy to Railway). Run `git branch --show-current` before every commit — another session may share this tree.
- **Test entry points:** `npm test` = `npm run build && npm run build:lib-test && node --experimental-sqlite --test tests/*.test.mjs` (Task 5 renames `build:nav-test` to `build:lib-test` and keeps `build:nav-test` as an alias; until then the script is `build:nav-test`). A full worker build takes minutes: while iterating run only your file, `node --experimental-sqlite --test tests/<file>.test.mjs`. Tests that import `dist/server/index.js` (`tests/rendered-html.test.mjs`, `tests/real-sqlite-seed.test.mjs`, `tests/isolation.test.mjs`, `tests/workspace-credential-actions.test.mjs`, `tests/workspace-cycles.test.mjs`) need `npm run build` first. **Stop any `npm run dev` server on :3000 before `npm run build` / `npm test`** (they share `.wrangler/` state and the build clobbers it); start it again for Playwright. `npm run test:e2e` (all four projects), `npm run test:e2e:desktop` and `npm run test:e2e:phone` are separate scripts and are never chained into `npm test`. `npm run typecheck` (`tsc --noEmit`, which also typechecks `tests/e2e/*.ts`) and `npm run lint` (`eslint .`, which lints `tests/`) are safe at any time.
- **Green at every commit:** each task rewrites the tests its change breaks in the same commit; `npm test`, `npm run typecheck`, `npm run lint` must pass at every task's final step, and every task that touches `app/` or `tests/e2e/` also runs `npm run test:e2e` with the dev server up (all four projects green).
- **Isolation suite before any `route.ts` change (spec §4):** Task 1 (`tests/isolation.test.mjs`) is committed before any task edits `app/api/workspace/route.ts`, `app/api/evidence/**`, `app/api/export/**` or `db/**`. Tasks 2, 8, 9, 11 and 12 edit those files and depend on Task 1; Tasks 3–7 must not touch them. Every task that adds a workspace action adds its rows to `FOREIGN_ID_PROBES` and its name to `tests/helpers/workspaceActions.mjs` in the same commit.
- **Pins are deleted, never edited (ios-coupling-15):** a source-regex assertion is removed whole (with its `readFile` binding) or its whole subtest is removed; no regex is re-pointed at moved code. After Task 5 no file under `tests/` may read `app/ITrackApp.tsx`, `app/globals.css`, `app/layout.tsx` or `dist/**/ITrackApp-*.js` as text, except the generic walkers in `tests/app-source-guards.test.mjs` and `tests/protected-identifiers.test.mjs`, and `tests/app-source-guards.test.mjs` enforces that. Server-source pins (`runtimeSource`, `workspaceRouteSource`, `routeSource`, `categorySource`, `modelSource`, `schemaSource`, `workerSource`/`serviceWorkerSource` over `public/sw.js`, `pushDeliverySource`, `wranglerSource`) stay this wave.
- **E2E identity rule:** the demo identity (`demo@local.license-lantern`, seeded by `ensureDemoWorkspace`) is read-only in every spec; any spec that saves anything uses `test.use({ identity: freshIdentity() })` from `tests/e2e/fixtures.ts` and seeds through `/api/workspace`. Specs never put `userId`, `user_id`, `ownerId` or `owner_id` in a payload (400 `client_identity_forbidden`).
- **Keep-list (ios-coupling-10) — nothing in this wave edits:** `app/manifest.ts`; `app/layout.tsx:31-47` (manifest/icons/`appleWebApp`) and `:75-90` (viewport/theme colours); `public/sw.js`, `public/offline.html`, `public/*.png`, `public/favicon.ico`; `app/lib/webPush.ts`, `app/lib/rfc8291Push.ts`, `app/lib/pushDelivery.ts` (one comment line excepted, Task 7); the service-worker registration and install help in `ITrackApp.tsx` (2120-2191 region and the "Add iTrack to your phone" sheet); all 51 `env(safe-area-inset-*)` uses and the 16px zoom floor (`globals.css:644-654`); `.sheet-grabber`/`useSheetDragDismiss`/press tokens (Wave 3 inputs); `app/lib/navigation.ts` (one comment line excepted, Task 7) and the four route pages; `deploy/railway/pages/*.html` `.shell` class; `VAPID_*` on Railway.
- **Copy rules:** no "beta", no "Pro", no prices, no "ad-supported", no tiers anywhere (spec §1.3). New user-facing strings are exactly the ones written in each task's brief — Wave 4 rewrites copy, so add no other prose. No new string mentions Capacitor, TestFlight, "the shell", or native apps.
- **Dates:** after Task 11 no file under `app/` contains `new Date().toISOString().slice(0, 10)` or `const todayIso`; every default date comes from `todayLocal(zone)` in `app/lib/dates.ts`. `app/lib/dates.ts` and `app/lib/cycles.ts` carry no imports other than `./readiness` (cycles) and no DOM/D1 types, so they compile under `build:lib-test` and can be inlined by `importTypeScriptModule`; `app/lib/reminders.ts` keeps its own `localReminderClock` (the test inliner cannot resolve `./dates`).
- **Migrations:** exactly one this wave, `drizzle/0014_credential_archive.sql` (journal idx 14, generated with `npx drizzle-kit generate --name credential_archive`); `db/runtime.ts` (DDL + `RICH_RULE_COLUMNS` + `ensureRichRuleColumns` table list + index statements) is what the Railway volume actually executes and is mirrored in the same commit. No identity change (spec §8).
- **Protected identifiers (do not touch):** the `license-lantern:` hash salt (`db/identity.ts:49`), the demo email `demo@local.license-lantern` (`db/identity.ts:16`), the draft prefix `license-lantern:activity-draft:v1:` (`app/lib/activityDraft.ts:39,48`, `route.ts:427`), the ICS UID domain `@license-lantern` (`app/lib/calendarInvite.ts:143`), the push topic `license-lantern-check-in` (`app/lib/pushDelivery.ts:69`, `public/sw.js:159`), the SW cache prefix `license-lantern-static` (`public/sw.js:4`), the R2 bucket `vigilo-r2` (`vite.config.ts:35`), the `oai-authenticated-user-*` header names, the `itrack_session` cookie name. Task 7 pins the first seven; new client storage keys use the `itrack:` prefix.
- **Commit trailer:** every commit message ends with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk`

## File map (what changes, and who owns it)

| Path | Task | Change |
|---|---|---|
| `tests/isolation.test.mjs` | 1, 2, 9 | new two-identity suite over the built worker (own SQLite/R2 shims); probe table grows with each new action |
| `tests/helpers/workspaceActions.mjs` | 1, 9 | `WORKSPACE_ACTIONS` list (23 → 27) shared by the isolation suite and the dispatch-label guard |
| `app/api/workspace/route.ts` | 2, 8, 9, 11, 12 | push-endpoint reads scoped by user (2); `revision`/`archived_at` read side + `archivedCredentials` split + `credential_archived` gating + revision bumps (8); credential mutation helpers, `assertTemplateCycleDates` extraction, four new actions (9); `todayInTimeZone` → `todayLocal` (11); `activeCycleId` / `isCurrentCycle` / `previousCycleIds` (12) |
| `tests/e2e/fixtures.ts`, `playwright.config.ts`, `package.json` (`test:e2e:*`) | 3 | shared fixtures (`test`, `expect`, `freshIdentity`, `app`), four projects (both schemes × 1440×900 and 390×844), `workers: 1` |
| `tests/e2e/log-activity-typing.spec.ts`, `tests/e2e/session-ended-mid-save.spec.ts` | 3, 4 | moved onto fixtures (3); typing spec folded into `log-activity.spec.ts` and deleted (4) |
| `tests/e2e/home.spec.ts`, `credentials.spec.ts`, `credential-detail.spec.ts`, `log-activity.spec.ts`, `history.spec.ts`, `profile.spec.ts`, `packet.spec.ts` | 4 | one behavioural spec per screen, replacing the rendered-html pin subtests named in each header |
| `tests/rendered-html.test.mjs` | 5, 7, 8, 11 | 196 client/styles/layout/built-chunk pins deleted with their readers (5); one comment (7); `0014` appended to the migration-bindings subtest (8); 9:00-local scheduler proof (11) |
| `tests/helpers/clientSources.mjs`, `tests/app-source-guards.test.mjs` | 1, 5, 11, 12 | `readClientSources()` moved to a helper; new guards: dispatch labels = `WORKSPACE_ACTIONS` (1), no test file reads client source (5), no UTC "today" (11), no `!== "renewed"` outside `app/lib/cycles.ts` (12) |
| `tests/certificate-ocr.test.mjs`, `tests/activity-draft.test.mjs`, `tests/readiness.test.mjs`, `package.json` (`build:lib-test`) | 5 | unit tests for the pure modules the deleted pins encoded |
| `tools/contrast-audit.mjs`, `tests/contrast-audit.test.mjs`, `deploy/railway/pages/{landing,login,signup,verify,reset}.html` | 6 | audit walks `app/**/*.css` + every page `<style>`; three page literals tokenised (`--on-accent`, `--coral-ink`, `var(--card)`); gate wired into `npm test` |
| `docs/DESIGN-SYSTEM.md` | 5, 6, 7 | Tests section count (5); token-file vs consumer rule + claim count (6); Typography rationale (7) |
| `tests/protected-identifiers.test.mjs`, `tests/dist-hygiene.test.mjs`, `.dockerignore` | 7 | seven identifier pins; no `_vinext_fonts` in dist; `.vinext` excluded from the image |
| `app/ITrackApp.tsx` | 7, 10, 11, 12 | `hapticTap` deleted + one comment (7); credential edit/archive/delete UI (10); local dates + zone banner (11); selection, hero/detail guards, grouped list (12) |
| `app/globals.css`, `app/layout.tsx`, `app/credentials/page.tsx`, `app/lib/navigation.ts`, `app/lib/pushDelivery.ts`, `app/lib/renewalPacket.ts`, `README.md` | 7 | comment/prose sweep only (values unchanged) |
| `docs/superpowers/specs/2026-08-03-itrack-ios-design.md`, `specs/2026-08-11-ios-native-nav-retheme-design.md`, `specs/2026-08-11-itrack-public-signup-design.md`, `plans/2026-08-03-itrack-ios.md`, `plans/2026-08-11-ios-native-nav-retheme.md`, `plans/2026-08-11-itrack-public-signup.md`, `docs/TC/records/TC-002-08-03-26-ios-appstore-app/tc_record.json`, `docs/TC/tc_registry.json` | 7 | one-line Retired/Superseded headers; TC-002 → `retired` |
| `db/schema.ts`, `drizzle/0014_credential_archive.sql`, `drizzle/meta/0014_snapshot.json`, `drizzle/meta/_journal.json`, `db/runtime.ts` | 8 | `credentials.revision`, `credentials.archived_at`, `credentials_user_archive_deadline_idx` |
| `app/lib/reminders.ts`, `app/api/export/packet/route.ts` | 8 | archived credentials produce no reminders; packet still opens for an archived credential |
| `tests/workspace-credential-actions.test.mjs`, `tests/real-sqlite-seed.test.mjs` | 8, 9 | real-sqlite action suite (schema + read side in 8, the four actions in 9); `PRAGMA table_info(credentials)` assertion |
| `tests/e2e/credential-edit-archive-delete.spec.ts` | 10 | edit → archive → restore → delete through the UI on a fresh identity |
| `app/lib/dates.ts`, `tests/dates.test.mjs`, `app/api/export/route.ts`, `tests/e2e/local-dates.spec.ts` | 11 | local-date module + tests; CSV filename in the stored zone; fixed-clock browser proof |
| `app/lib/cycles.ts`, `tests/cycles.test.mjs`, `tests/workspace-cycles.test.mjs`, `tests/e2e/renewed-cycle-home.spec.ts` | 12 | cycle derivation module + unit/integration/e2e proof |
| `docs/superpowers/specs/2026-09-10-itrack-web-redesign-design.md` | 13 | docs only: §4 bullet 2 (push endpoints answer a neutral 409 on save / idempotent 200 on remove, never data) and bullet 5 (seed literal `UTC` = unset → device zone) amended to the shipped contract |
| (no source) | 13 | gates, Docker run-check, merge, live verification |

---

### Task 1: Two-identity isolation suite `tests/isolation.test.mjs` (critic-08) — lands before any route change

**Rationale:** critic-08 — ownership scoping is correct today (verified by the audit map's 42-probe replay against the built worker) but only by convention: every action re-derives `WHERE … user_id = ?` by hand (`app/api/workspace/route.ts`, e.g. `addActivity` at `:5902-5923`, `getTaskForMutation` at `:7031-7060`, `getActivityForMutation` at `:6193-6213`). The route decomposition and this wave's five `route.ts` tasks (2, 8, 9, 11, 12) are exactly the refactors that regress that clause. This file is the tripwire, so it imports only the built worker (`dist/server/index.js`) and never `app/**` or `db/**` source. Nothing under `app/api/**`, `app/api/export/**`, `app/api/evidence/**` or `db/**` may change before this commit exists (spec §4 bullet 2, §9 Integration).

**Files:**
- Create: `tests/isolation.test.mjs`
- Create: `tests/helpers/workspaceActions.mjs`
- Create: `tests/helpers/clientSources.mjs` (moved from `tests/app-source-guards.test.mjs:13-24`)
- Modify: `tests/app-source-guards.test.mjs:5-24` (import the helper; append the dispatch-label guard after line 131)
- Test: `tests/isolation.test.mjs`, `tests/app-source-guards.test.mjs`

**Interfaces:**
- Consumes: `dist/server/index.js` default export (`worker.fetch(request, { ASSETS, DB, EVIDENCE }, ctx)`, `worker/index.ts:55-95`); the shim classes copied verbatim (not imported — that suite is being dismantled) from `tests/rendered-html.test.mjs:158-224` (`SQLiteD1Statement` / `SQLiteD1Database`: `PRAGMA foreign_keys = ON`, `batch` = `BEGIN IMMEDIATE` + `runSync` per statement + `COMMIT`/`ROLLBACK`, statements return `{ meta: { changes, last_row_id } }` because the actions branch on `meta.changes`) and `:226-275` (`FakeEvidenceBucket` with `objects: Map<string, …>`); the `cloudflare:workers` loader shim and `?test=` cache-buster copied from `tests/real-sqlite-seed.test.mjs:14-38`. Identity is the `oai-authenticated-user-email` header on a non-local host (`db/identity.ts:57-77`: the demo fallback fires only for localhost, `:18-26,77-84`). Error bodies are `{ error, code }` (`route.ts:12474-12480`, `app/api/evidence/_shared.ts:74-80`, `app/api/export/packet/route.ts:26-45`).
- Produces:
  - `tests/helpers/workspaceActions.mjs` → `export const WORKSPACE_ACTIONS: string[]` — the 23 `case "<name>":` labels of `route.ts:12377-12459` in switch order.
  - `tests/helpers/clientSources.mjs` → `export function readClientSources(): Array<{ file: string; source: string }>` — walks every `.ts/.tsx/.mts` under `app/`, `file` relative to `app/` (e.g. `"api/workspace/route.ts"`); registers no tests.
  - Inside `tests/isolation.test.mjs` (module scope, above the `test(...)`): `FOREIGN_ID_PROBES: Array<{ action: string; payload: (seed: OwnerSeed) => object; expect: { status: number; code: string } | { status: 200; ok: true; id: string } }>` and `NO_FOREIGN_ID_ACTIONS: string[]`, where `OwnerSeed = { userId, credentialName, activityTitle, credentialId, deadline, requirementId, managedTaskId, managedTaskRevision, personalTaskId, personalTaskRevision, activityId, activityRevision, allocationId, evidenceId, evidenceKey, subscription: { endpoint, expirationTime: null, keys: { p256dh, auth } }, subscriptionId, deliveryId }` is what `seedOwner()` returns. Task 2 replaces the one row commented `// Documented exception … Task 2 replaces this row`; Task 9 appends four rows, four names to `WORKSPACE_ACTIONS`, and changes the `assert.equal(WORKSPACE_ACTIONS.length, 23)` literal to `27`.

- [ ] **Step 1: Be on the wave branch**

Run: `cd "/Users/chrisskerritt/Documents/New project/Vigilo" && git branch --show-current`
Expected: `feat/wave2-foundation`. If it prints `main`, run `git switch -c feat/wave2-foundation 8ac172a` (Wave 1's merge commit, the wave's base) and re-check. If it prints anything else, another session is using this tree — stop and resolve before editing.

- [ ] **Step 2: Write the failing suite**

Create `tests/isolation.test.mjs` with exactly this content (717 lines; the two shim classes and the bucket are verbatim copies of `tests/rendered-html.test.mjs:158-275`, the loader shim of `tests/real-sqlite-seed.test.mjs:14-38`):

```js
// Two-identity isolation suite (audit critic-08; spec 2026-09-10 §4).
//
// Ownership scoping in the workspace API is correct today, but only by
// convention: every action re-derives `WHERE ... user_id = ?` by hand. The
// route decomposition and the Wave 2 route.ts tasks are exactly the refactors
// that regress that clause, so this file is the tripwire. It boots the BUILT
// worker (dist/server/index.js) against a real node:sqlite database with two
// identities, seeds identity A through public routes only, then replays every
// id-taking action and route from identity B using A's ids. Each probe pins
// the exact refusal (status + code): validation runs before ownership in every
// action, so a naive "not 200" check would let a 400 pass silently.
//
// Nothing here imports app/** or db/**: the suite must keep passing across
// file moves and must fail only when behaviour changes.
//
// Needs `npm run build` first; run alone with
//   node --experimental-sqlite --test tests/isolation.test.mjs
import assert from "node:assert/strict";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WORKSPACE_ACTIONS } from "./helpers/workspaceActions.mjs";

const testCloudflareEnv = {};
globalThis.__LICENSE_LANTERN_TEST_ENV__ = testCloudflareEnv;

// The production bundle targets Cloudflare's `cloudflare:workers` virtual
// module; expose the same env-shaped object to the built worker under node.
const cloudflareWorkersMockUrl = `data:text/javascript,${encodeURIComponent(
  "export const env = globalThis.__LICENSE_LANTERN_TEST_ENV__;",
)}`;
const loaderSource = `
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        url: ${JSON.stringify(cloudflareWorkersMockUrl)},
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  }
`;
register(
  `data:text/javascript,${encodeURIComponent(loaderSource)}`,
  import.meta.url,
);

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
const workerPromise = import(workerUrl.href).then((module) => module.default);

// Real in-memory D1 over node:sqlite. Copied (not imported) from
// tests/rendered-html.test.mjs so this file survives that suite's retirement:
// foreign keys ON, batch = one BEGIN IMMEDIATE transaction, and every
// statement reports meta.changes because the actions branch on it.
class SQLiteD1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.bindings = [];
  }

  bind(...bindings) {
    this.bindings = bindings;
    return this;
  }

  statement() {
    return this.database.raw.prepare(this.sql);
  }

  async first() {
    return this.statement().get(...this.bindings) ?? null;
  }

  async all() {
    return { results: this.statement().all(...this.bindings) };
  }

  async run() {
    return this.runSync();
  }

  runSync() {
    const result = this.statement().run(...this.bindings);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

class SQLiteD1Database {
  constructor(DatabaseSync) {
    this.raw = new DatabaseSync(":memory:");
    this.raw.exec("PRAGMA foreign_keys = ON");
  }

  prepare(sql) {
    return new SQLiteD1Statement(this, sql);
  }

  async batch(statements) {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.raw.close();
  }
}

class FakeEvidenceBucket {
  constructor() {
    this.puts = [];
    this.gets = [];
    this.deletes = [];
    this.objects = new Map();
  }

  async head(key) {
    return this.objects.get(key) ?? null;
  }

  async get(key) {
    this.gets.push(key);
    return this.objects.get(key) ?? null;
  }

  async put(key, value, options = {}) {
    const buffer =
      value instanceof ArrayBuffer
        ? value
        : ArrayBuffer.isView(value)
          ? value.buffer.slice(
              value.byteOffset,
              value.byteOffset + value.byteLength,
            )
          : await new Response(value).arrayBuffer();
    const stored = {
      key,
      version: "test-version",
      size: buffer.byteLength,
      etag: "test-etag",
      httpEtag: '"test-etag"',
      uploaded: new Date("2026-07-25T12:00:00.000Z"),
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
      body: new Blob([buffer]).stream(),
      arrayBuffer: async () => buffer,
    };
    this.puts.push({ key, buffer, options });
    this.objects.set(key, stored);
    return stored;
  }

  async delete(keyOrKeys) {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    this.deletes.push(...keys);
    keys.forEach((key) => this.objects.delete(key));
  }
}

// initializeDatabase is memoised per worker import, so one database per file.
const db = new SQLiteD1Database(DatabaseSync);
const bucket = new FakeEvidenceBucket();
testCloudflareEnv.DB = db;
testCloudflareEnv.EVIDENCE = bucket;

// A non-local host: the demo-identity fallback only fires for localhost, so
// a request without the identity header is anonymous here, not the demo user.
const BASE = "https://itrack.example";
const executionContext = { waitUntil() {}, passThroughOnException() {} };

function identity(email) {
  return {
    email,
    headers: { accept: "application/json", "oai-authenticated-user-email": email },
  };
}
const A = identity("alpha@example.com");
const B = identity("bravo@example.com");
const ANONYMOUS = { email: null, headers: { accept: "application/json" } };

async function fetchAs(id, path, init = {}) {
  const worker = await workerPromise;
  return worker.fetch(
    new Request(BASE + path, { ...init, headers: { ...id.headers, ...(init.headers ?? {}) } }),
    { ASSETS: { fetch: async () => new Response("", { status: 404 }) }, DB: db, EVIDENCE: bucket },
    executionContext,
  );
}

// No Origin and no sec-fetch-site: the route's cross-origin check only rejects
// a mismatching value, and a real same-origin fetch sends none in tests.
async function post(id, action, payload) {
  return fetchAs(id, "/api/workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, payload }),
  });
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0)]);

async function upload(id, activityId, fileName) {
  const form = new FormData();
  form.set("activityId", activityId);
  form.set("file", new File([PNG_BYTES], fileName, { type: "image/png" }));
  return fetchAs(id, "/api/evidence", { method: "POST", body: form });
}

async function expectRefusal(response, { status, code }) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.code, code);
  assert.ok(!("credentials" in body) && !("activities" in body), "a refusal carries no workspace data");
}

function userIdOf(email) {
  return db.raw.prepare("SELECT id FROM users WHERE email = ?").get(email).id;
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Seeds one owner through public routes only (plus one raw ledger row, which
// no public route writes) and returns every id a probe could name.
async function seedOwner(id, { credentialName, activityTitle, taskTitle, device }) {
  assert.equal((await fetchAs(id, "/api/workspace")).status, 200, `${id.email}: ensureUser`);
  const userId = userIdOf(id.email);

  const credentialResponse = await post(id, "createCredential", {
    credentialName,
    profession: "Social work",
    jurisdiction: "New Jersey",
    issuer: `${credentialName} board`,
    totalRequired: 10,
    unitLabel: "hours",
    cycleStart: "2026-01-01",
    deadline: "2027-12-31",
    categories: [{ name: "General", requiredUnits: 10 }],
  });
  assert.equal(credentialResponse.status, 200, `${id.email}: createCredential`);
  const credentialId = (await credentialResponse.json()).id;

  const activityResponse = await post(id, "addActivity", {
    title: activityTitle,
    provider: `${credentialName} U`,
    completionDate: "2026-06-02",
    totalUnits: 2,
    allocatedUnits: 2,
    credentialId,
  });
  assert.equal(activityResponse.status, 200, `${id.email}: addActivity`);
  const activityId = (await activityResponse.json()).id;

  const taskResponse = await post(id, "createPersonalTask", { credentialId, title: taskTitle, dueDate: "2026-10-01" });
  assert.equal(taskResponse.status, 200, `${id.email}: createPersonalTask`);
  const personalTaskId = (await taskResponse.json()).id;

  const workspace = await (await fetchAs(id, "/api/workspace")).json();
  const credential = workspace.credentials.find((candidate) => candidate.id === credentialId);
  const activity = workspace.activities.find((candidate) => candidate.id === activityId);
  const managedTask = credential.tasks.find((task) => !task.isPersonal);
  const personalTask = credential.tasks.find((task) => task.id === personalTaskId);

  const uploadResponse = await upload(id, activityId, `${device}.png`);
  assert.equal(uploadResponse.status, 201, `${id.email}: evidence upload`);
  const evidenceId = (await uploadResponse.json()).evidence.id;
  const evidenceKey = `evidence/${userId}/${activityId}/${evidenceId}`;
  assert.ok(bucket.objects.has(evidenceKey), `${id.email}: evidence object stored under the owner's key`);

  const key = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const subscription = {
    endpoint: `https://fcm.googleapis.com/fcm/send/${device}-device`,
    expirationTime: null,
    keys: {
      p256dh: base64url(new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey))),
      auth: base64url(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
  const pushResponse = await post(id, "savePushSubscription", {
    subscription,
    deviceLabel: `${credentialName} browser`,
    enableAccountPush: false,
  });
  assert.equal(pushResponse.status, 200, `${id.email}: savePushSubscription`);
  const subscriptionId = (await pushResponse.json()).id;

  // A dispatched delivery, so `GET /api/workspace?delivery=<id>` has a row to
  // refuse. 2027-10-02 is the 90-day lead of the seeded deadline.
  const deliveryId = crypto.randomUUID();
  db.raw
    .prepare(
      `INSERT INTO push_delivery_ledger (id, user_id, subscription_id, reminder_key, scheduled_for, status, attempt_count, dispatched_at)
       VALUES (?, ?, ?, ?, ?, 'delivered', 1, CURRENT_TIMESTAMP)`,
    )
    .run(deliveryId, userId, subscriptionId, `deadline:${credentialId}:${credential.deadline}`, "2027-10-02");

  return {
    userId,
    credentialName,
    activityTitle,
    credentialId,
    deadline: credential.deadline,
    requirementId: credential.requirements[0].id,
    managedTaskId: managedTask?.id ?? personalTaskId,
    managedTaskRevision: managedTask?.revision ?? personalTask.revision,
    personalTaskId,
    personalTaskRevision: personalTask.revision,
    activityId,
    activityRevision: activity.revision,
    allocationId: activity.allocations[0].id,
    evidenceId,
    evidenceKey,
    subscription,
    subscriptionId,
    deliveryId,
  };
}

// Every table carrying user_id (db/schema.ts), plus the two scoped only
// through a parent, plus the bucket. `SELECT *` so a new column is covered
// without editing this list; rowid order because three of these tables have
// no `id` column.
const USER_SCOPED_TABLES = [
  "profiles",
  "weekly_progression_periods",
  "credentials",
  "dental_checkpoint_states",
  "activities",
  "evidence_files",
  "activity_requirement_matches",
  "checklist_tasks",
  "renewal_submissions",
  "credential_cycle_links",
  "renewal_acceptances",
  "reminder_preferences",
  "reminder_states",
  "push_subscriptions",
  "push_delivery_ledger",
  "xp_events",
  "weekly_quest_claims",
  "badge_events",
];

function ownerFingerprint(userId) {
  const tables = {};
  for (const table of USER_SCOPED_TABLES) {
    tables[table] = db.raw.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY rowid`).all(userId);
  }
  tables.credential_requirements = db.raw
    .prepare(
      `SELECT credential_requirements.* FROM credential_requirements
       JOIN credentials c ON c.id = credential_requirements.credential_id
       WHERE c.user_id = ? ORDER BY credential_requirements.rowid`,
    )
    .all(userId);
  tables.activity_allocations = db.raw
    .prepare(
      `SELECT activity_allocations.* FROM activity_allocations
       JOIN activities a ON a.id = activity_allocations.activity_id
       WHERE a.user_id = ? ORDER BY activity_allocations.rowid`,
    )
    .all(userId);
  return JSON.stringify({ tables, bucketKeys: [...bucket.objects.keys()].sort() });
}

// B sends A's ids. Every payload is otherwise valid so the request reaches
// the ownership lookup; `expect` is the exact refusal. Two rows are documented
// exceptions rather than 404s (see the comments on those rows).
const FOREIGN_ID_PROBES = [
  {
    action: "addActivity",
    payload: (s) => ({ title: "x", completionDate: "2026-06-02", totalUnits: 1, credentialId: s.credentialId }),
    expect: { status: 404, code: "credential_not_found" },
  },
  {
    action: "updateActivity",
    payload: (s) => ({
      activityId: s.activityId,
      expectedRevision: s.activityRevision,
      title: "hijack",
      provider: "",
      completionDate: "2026-06-01",
      totalUnits: 2,
    }),
    expect: { status: 404, code: "activity_not_found" },
  },
  {
    action: "archiveActivity",
    payload: (s) => ({ activityId: s.activityId, expectedRevision: s.activityRevision }),
    expect: { status: 404, code: "activity_not_found" },
  },
  {
    action: "restoreActivity",
    payload: (s) => ({ activityId: s.activityId, expectedRevision: s.activityRevision }),
    expect: { status: 404, code: "activity_not_found" },
  },
  {
    action: "addActivityAllocation",
    payload: (s) => ({ activityId: s.activityId, credentialId: s.credentialId, allocatedUnits: 1, requirementIds: [] }),
    expect: { status: 404, code: "activity_not_found" },
  },
  {
    action: "updateActivityAllocationRequirements",
    payload: (s) => ({ allocationId: s.allocationId, requirementIds: [s.requirementId] }),
    expect: { status: 404, code: "allocation_not_found" },
  },
  {
    action: "toggleTask",
    payload: (s) => ({ taskId: s.managedTaskId, completed: true, expectedRevision: s.managedTaskRevision }),
    expect: { status: 404, code: "task_not_found" },
  },
  {
    action: "createPersonalTask",
    payload: (s) => ({ credentialId: s.credentialId, title: "x", dueDate: "2026-10-01" }),
    expect: { status: 404, code: "credential_not_found" },
  },
  {
    action: "updatePersonalTask",
    payload: (s) => ({ taskId: s.personalTaskId, expectedRevision: s.personalTaskRevision, title: "x", dueDate: "2026-10-02" }),
    expect: { status: 404, code: "task_not_found" },
  },
  {
    action: "archivePersonalTask",
    payload: (s) => ({ taskId: s.personalTaskId, expectedRevision: s.personalTaskRevision, title: "x", dueDate: "2026-10-02" }),
    expect: { status: 404, code: "task_not_found" },
  },
  {
    action: "restorePersonalTask",
    payload: (s) => ({ taskId: s.personalTaskId, expectedRevision: s.personalTaskRevision, title: "x", dueDate: "2026-10-02" }),
    expect: { status: 404, code: "task_not_found" },
  },
  {
    action: "markSubmitted",
    payload: (s) => ({ credentialId: s.credentialId, submissionDate: "2026-06-01", confirmationNumber: "C1", complianceAttested: true }),
    expect: { status: 404, code: "credential_not_found" },
  },
  {
    action: "markRenewalAccepted",
    payload: (s) => ({
      credentialId: s.credentialId,
      acceptedAt: "2026-06-15",
      reference: "R1",
      nextCycleStart: "2028-01-01",
      nextDeadline: "2029-12-31",
      officialDatesAttested: true,
    }),
    expect: { status: 404, code: "credential_not_found" },
  },
  {
    action: "updateRequirementApplicability",
    payload: (s) => ({ credentialId: s.credentialId, choices: [{ requirementId: s.requirementId, status: "applies" }] }),
    expect: { status: 404, code: "credential_not_found" },
  },
  {
    action: "saveDentalCheckpoint",
    payload: (s) => ({ credentialId: s.credentialId, requirementId: s.requirementId, completed: false, evidenceNote: "", expectedRevision: 0 }),
    expect: { status: 404, code: "dental_checkpoint_not_found" },
  },
  {
    action: "setReminderState",
    payload: (s) => ({
      reminderKey: `deadline:${s.credentialId}:${s.deadline}`,
      credentialId: s.credentialId,
      status: "dismissed",
      snoozedUntil: null,
    }),
    expect: { status: 404, code: "credential_not_found" },
  },
  {
    action: "sendTestPush",
    payload: (s) => ({ endpoint: s.subscription.endpoint }),
    expect: { status: 404, code: "push_subscription_not_found" },
  },
  // Documented exception: the endpoint lookup is not user-scoped, so a foreign
  // endpoint answers 409 (an existence oracle, not a data leak; push endpoints
  // are unguessable capability URLs). Ownership cannot change: the raw-row
  // subtest below proves the subscription is still A's and still active.
  // Task 2 replaces this row when it neutralises the oracle.
  {
    action: "savePushSubscription",
    payload: (s) => ({ subscription: s.subscription, deviceLabel: "Bravo browser", enableAccountPush: false }),
    expect: { status: 409, code: "push_subscription_conflict" },
  },
  // Documented exception: removal is idempotent and user-scoped, so a foreign
  // endpoint is a silent no-op; the raw-row subtest proves A's subscription
  // and ledger row are untouched.
  {
    action: "removePushSubscription",
    payload: (s) => ({ endpoint: s.subscription.endpoint }),
    expect: { status: 200, ok: true, id: "push-subscription" },
  },
];

// Actions whose payload names no stored id of another user: catalog ids,
// per-user computed keys, or no ids at all.
const NO_FOREIGN_ID_ACTIONS = ["createCredential", "claimWeeklyQuest", "updateWeeklyGoal", "updateReminderPreferences"];

test("two-identity isolation over the built worker (critic-08)", async (t) => {
  const seedA = await seedOwner(A, {
    credentialName: "Alpha LCSW",
    activityTitle: "Alpha ethics course",
    taskTitle: "Alpha task",
    device: "alpha",
  });
  const seedB = await seedOwner(B, {
    credentialName: "Bravo LMHC",
    activityTitle: "Bravo course",
    taskTitle: "Bravo task",
    device: "bravo",
  });

  const fingerprintBefore = ownerFingerprint(seedA.userId);
  const workspaceBefore = await (await fetchAs(A, "/api/workspace")).text();
  assert.ok(workspaceBefore.includes(seedA.credentialId) && workspaceBefore.includes("Alpha ethics course"), "A sees its own data");

  await t.test("the probe table names every dispatch label exactly once", () => {
    const named = [...FOREIGN_ID_PROBES.map((probe) => probe.action), ...NO_FOREIGN_ID_ACTIONS];
    assert.equal(new Set(named).size, named.length, "no action is listed twice");
    assert.deepEqual(new Set(named), new Set(WORKSPACE_ACTIONS));
    assert.equal(WORKSPACE_ACTIONS.length, 23);
  });

  await t.test("the build dispatches every listed action and nothing else", async () => {
    await expectRefusal(await post(B, "nope", {}), { status: 400, code: "unsupported_action" });
    for (const action of WORKSPACE_ACTIONS) {
      const response = await post(B, action, {});
      const body = await response.json();
      assert.notEqual(response.status, 200, `${action}: an empty payload must be refused`);
      assert.notEqual(body.code, "unsupported_action", `${action}: the build no longer dispatches this action`);
    }
  });

  for (const probe of FOREIGN_ID_PROBES) {
    await t.test(`foreign id: ${probe.action} with A's ids as B`, async () => {
      const response = await post(B, probe.action, probe.payload(seedA));
      if ("ok" in probe.expect) {
        assert.equal(response.status, probe.expect.status);
        assert.deepEqual(await response.json(), { ok: true, action: probe.action, id: probe.expect.id });
      } else {
        await expectRefusal(response, probe.expect);
      }
    });
  }

  await t.test("the two documented non-404s leave A's push rows untouched", () => {
    const row = db.raw
      .prepare("SELECT user_id AS userId, disabled_at AS disabledAt FROM push_subscriptions WHERE id = ?")
      .get(seedA.subscriptionId);
    assert.equal(row.userId, seedA.userId);
    assert.equal(row.disabledAt, null);
    const ledger = db.raw.prepare("SELECT status FROM push_delivery_ledger WHERE id = ?").get(seedA.deliveryId);
    assert.equal(ledger.status, "delivered");
  });

  // B's own ids combined with A's: these exercise the parent joins on the two
  // tables that carry no user_id (credential_requirements, activity_allocations).
  const MIXED_PROBES = [
    {
      label: "addActivityAllocation with B's activity and A's credential",
      action: "addActivityAllocation",
      payload: { activityId: seedB.activityId, credentialId: seedA.credentialId, allocatedUnits: 1, requirementIds: [] },
      expect: { status: 404, code: "credential_not_found" },
    },
    {
      label: "addActivityAllocation with A's activity and B's credential",
      action: "addActivityAllocation",
      payload: { activityId: seedA.activityId, credentialId: seedB.credentialId, allocatedUnits: 1, requirementIds: [] },
      expect: { status: 404, code: "activity_not_found" },
    },
    {
      label: "addActivity to B's credential tagged with A's requirement",
      action: "addActivity",
      payload: { title: "x", completionDate: "2026-06-03", totalUnits: 1, credentialId: seedB.credentialId, requirementIds: [seedA.requirementId] },
      expect: { status: 404, code: "requirement_not_found" },
    },
    {
      label: "updateActivityAllocationRequirements on B's allocation with A's requirement",
      action: "updateActivityAllocationRequirements",
      payload: { allocationId: seedB.allocationId, requirementIds: [seedA.requirementId] },
      expect: { status: 404, code: "requirement_not_found" },
    },
    {
      label: "updateRequirementApplicability on B's credential with A's requirement",
      action: "updateRequirementApplicability",
      payload: { credentialId: seedB.credentialId, choices: [{ requirementId: seedA.requirementId, status: "applies" }] },
      expect: { status: 404, code: "requirement_not_found" },
    },
    {
      label: "saveDentalCheckpoint on B's credential with A's requirement",
      action: "saveDentalCheckpoint",
      payload: { credentialId: seedB.credentialId, requirementId: seedA.requirementId, completed: false, evidenceNote: "", expectedRevision: 0 },
      expect: { status: 404, code: "dental_checkpoint_not_found" },
    },
    {
      label: "setReminderState on B's credential with A's task key",
      action: "setReminderState",
      payload: { credentialId: seedB.credentialId, reminderKey: `task:${seedA.managedTaskId}:2026-10-01`, status: "dismissed", snoozedUntil: null },
      expect: { status: 404, code: "reminder_not_found" },
    },
  ];
  for (const probe of MIXED_PROBES) {
    await t.test(`mixed ownership: ${probe.label}`, async () => {
      await expectRefusal(await post(B, probe.action, probe.payload), probe.expect);
    });
  }

  await t.test("GET /api/workspace as B carries nothing of A's", async () => {
    const response = await fetchAs(B, "/api/workspace");
    assert.equal(response.status, 200);
    const text = await response.text();
    for (const needle of [
      seedA.credentialId,
      seedA.activityId,
      seedA.evidenceId,
      seedA.personalTaskId,
      seedA.allocationId,
      "Alpha LCSW",
      "Alpha ethics course",
    ]) {
      assert.ok(!text.includes(needle), `B's workspace must not mention ${needle}`);
    }
    assert.ok(text.includes(seedB.credentialId), "B still sees its own credential");
  });

  await t.test("GET /api/workspace?delivery= refuses A's delivery for B", async () => {
    await expectRefusal(await fetchAs(B, `/api/workspace?delivery=${seedA.deliveryId}`), {
      status: 404,
      code: "push_delivery_not_found",
    });
  });

  await t.test("GET /api/evidence?activityId= for A's activity lists nothing for B", async () => {
    // Scoped rather than refused: pinned as-is, it discloses nothing.
    const response = await fetchAs(B, `/api/evidence?activityId=${seedA.activityId}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { evidence: [] });
  });

  await t.test("GET /api/evidence/:id refuses A's evidence for B", async () => {
    await expectRefusal(await fetchAs(B, `/api/evidence/${seedA.evidenceId}`), { status: 404, code: "evidence_not_found" });
  });

  await t.test("GET /api/evidence/:id/download refuses A's evidence for B", async () => {
    await expectRefusal(await fetchAs(B, `/api/evidence/${seedA.evidenceId}/download`), {
      status: 404,
      code: "evidence_not_found",
    });
  });

  await t.test("DELETE /api/evidence/:id refuses A's evidence for B and keeps the object", async () => {
    await expectRefusal(await fetchAs(B, `/api/evidence/${seedA.evidenceId}`, { method: "DELETE" }), {
      status: 404,
      code: "evidence_not_found",
    });
    assert.ok(bucket.objects.has(seedA.evidenceKey), "A's object is still in the bucket");
  });

  await t.test("POST /api/evidence onto A's activity is refused for B and stores nothing", async () => {
    const sizeBefore = bucket.objects.size;
    await expectRefusal(await upload(B, seedA.activityId, "hijack.png"), { status: 404, code: "activity_not_found" });
    assert.equal(bucket.objects.size, sizeBefore);
  });

  await t.test("GET /api/export as B exports only B's activities", async () => {
    const response = await fetchAs(B, "/api/export");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/csv/);
    const csv = await response.text();
    assert.ok(!csv.includes("Alpha ethics course"), "A's activity is not in B's export");
    assert.ok(csv.includes("Bravo course"), "B's own activity is");
  });

  await t.test("GET /api/export/packet refuses A's credential for B in JSON and HTML", async () => {
    const asJson = await fetchAs(B, `/api/export/packet?credentialId=${seedA.credentialId}`);
    assert.equal(asJson.status, 404);
    assert.deepEqual(await asJson.json(), { error: "Credential not found.", code: "credential_not_found" });
    const asHtml = await fetchAs(B, `/api/export/packet?credentialId=${seedA.credentialId}`, {
      headers: { accept: "text/html" },
    });
    assert.equal(asHtml.status, 404);
    const html = await asHtml.text();
    assert.ok(html.includes("Packet unavailable"));
    assert.ok(!html.includes("Alpha LCSW"));
  });

  await t.test("a request without an identity header is anonymous, not the demo user", async () => {
    await expectRefusal(await fetchAs(ANONYMOUS, "/api/workspace"), { status: 401, code: "authentication_required" });
  });

  await t.test("control: the refusals are ownership, not breakage", async () => {
    // B's own upload succeeded during seeding (201); A cannot read it.
    await expectRefusal(await fetchAs(A, `/api/evidence/${seedB.evidenceId}`), { status: 404, code: "evidence_not_found" });
    const own = await fetchAs(B, `/api/evidence/${seedB.evidenceId}`);
    assert.equal(own.status, 200);
  });

  await t.test("identity A is byte-for-byte unchanged after every probe", async () => {
    assert.equal(ownerFingerprint(seedA.userId), fingerprintBefore);
    assert.equal(await (await fetchAs(A, "/api/workspace")).text(), workspaceBefore);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH" && node --experimental-sqlite --test tests/isolation.test.mjs`
Expected: FAIL before any probe runs —
```
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/tests/helpers/workspaceActions.mjs' imported from …/tests/isolation.test.mjs
not ok 1 - tests/isolation.test.mjs
# pass 0
# fail 1
```
(The helper does not exist yet. `dist/server/index.js` is not touched at this point because the static import fails first.)

- [ ] **Step 4: Create `tests/helpers/workspaceActions.mjs`**

```js
// The workspace actions the build dispatches, in the order of the `case`
// labels of the `switch (action)` in app/api/workspace/route.ts.
//
// Two tests hold this list to the truth from opposite sides:
// - tests/app-source-guards.test.mjs proves it equals the `case "<name>":`
//   labels of whichever file under app/api/ throws `unsupported_action`;
// - tests/isolation.test.mjs proves the build dispatches every name and that
//   every name has a foreign-id probe (or is listed as having no id surface).
// Adding an action therefore means adding it here AND adding its probe row.
export const WORKSPACE_ACTIONS = [
  "createCredential",
  "addActivity",
  "updateActivity",
  "archiveActivity",
  "restoreActivity",
  "addActivityAllocation",
  "updateActivityAllocationRequirements",
  "claimWeeklyQuest",
  "toggleTask",
  "createPersonalTask",
  "updatePersonalTask",
  "archivePersonalTask",
  "restorePersonalTask",
  "markSubmitted",
  "markRenewalAccepted",
  "updateRequirementApplicability",
  "saveDentalCheckpoint",
  "updateWeeklyGoal",
  "updateReminderPreferences",
  "savePushSubscription",
  "removePushSubscription",
  "sendTestPush",
  "setReminderState",
];
```

- [ ] **Step 5: Create `tests/helpers/clientSources.mjs`**

This is `walk` + `readClientSources` lifted out of `tests/app-source-guards.test.mjs:13-24` (Step 7 deletes them there). `appDir` now climbs two levels because the file lives one directory deeper:

```js
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
```

- [ ] **Step 6: Build the worker and run the suite to see it pass**

Stop any `npm run dev` server on :3000 first (it shares `.wrangler/` with the build). Then:

Run: `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH" && npm run build && node --experimental-sqlite --test tests/isolation.test.mjs`
Expected: the build finishes (minutes), then
```
ok 1 - two-identity isolation over the built worker (critic-08)
1..1
# tests 42
# pass 42
# fail 0
```
The 41 subtests under the outer test, in order: `the probe table names every dispatch label exactly once`; `the build dispatches every listed action and nothing else`; 19 × `foreign id: <action> with A's ids as B` (17 refusals at the pinned 404 codes, plus `savePushSubscription` → 409 `push_subscription_conflict` and `removePushSubscription` → 200 `{ ok: true, action, id: "push-subscription" }`, the two documented exceptions); `the two documented non-404s leave A's push rows untouched`; 7 × `mixed ownership: …`; the 10 route probes (`GET /api/workspace` clean, `?delivery=` 404 `push_delivery_not_found`, `GET /api/evidence?activityId=` → `{ evidence: [] }`, `GET /api/evidence/:id` / `/download` / `DELETE` 404 `evidence_not_found` with A's object still in the bucket, `POST /api/evidence` 404 `activity_not_found` with the bucket size unchanged, `GET /api/export` CSV without A's title, packet 404 as JSON `{ error: "Credential not found.", code: "credential_not_found" }` and as HTML containing `Packet unavailable`, and the 401 `authentication_required` row); `control: the refusals are ownership, not breakage`; `identity A is byte-for-byte unchanged after every probe` (20-table fingerprint + bucket keys, and the `/api/workspace` JSON text).

If a `foreign id:` subtest fails with a 400 instead of the pinned 404, the payload stopped satisfying validation (validation runs before the ownership lookup in every action) — fix the payload, never loosen the assertion to "not 200".

- [ ] **Step 7: Move the walker out of `tests/app-source-guards.test.mjs` and add the dispatch-label guard**

Verify the lines first: `grep -n "^export function readClientSources\|^function walk\|^const appDir\|^import" tests/app-source-guards.test.mjs` must print lines 5, 6, 7, 8, 9, 11, 13 and 22 exactly as quoted below (the file is 131 lines; nothing below line 24 references `readdirSync`, `readFileSync`, `statSync`, `path` or `fileURLToPath`).

Replace lines 5-24, which currently read:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|mts)$/.test(entry)) out.push(full);
  }
  return out;
}

export function readClientSources() {
  return walk(appDir).map((file) => ({ file: path.relative(appDir, file), source: readFileSync(file, "utf8") }));
}
```

with these four lines (lines 1-4, the header comment, stay as they are):

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readClientSources } from "./helpers/clientSources.mjs";
import { WORKSPACE_ACTIONS } from "./helpers/workspaceActions.mjs";
```

Then append this test at the end of the file (after the closing `});` of the `"the parked screen is inert …"` test, the current last line 131). The only `case "…":` labels under `app/api/` today are the 23 dispatch labels (`grep -rn 'case "' app/api` → `route.ts:12377-12459` only), so the collection needs no scoping to the switch:

```js
// tests/isolation.test.mjs probes every workspace action by name from
// WORKSPACE_ACTIONS; this guard ties that list to the build from the source
// side. It reads the `case "<name>":` labels out of whichever file under
// app/api/ throws `unsupported_action`, so it survives the route split.
test("every workspace dispatch label is in WORKSPACE_ACTIONS (critic-08)", () => {
  const labels = new Set();
  for (const { file, source } of readClientSources()) {
    if (!file.startsWith("api/") || !source.includes("unsupported_action")) continue;
    for (const match of source.matchAll(/^\s*case "([A-Za-z]+)":/gm)) labels.add(match[1]);
  }
  assert.ok(labels.size > 0, "found the workspace dispatch switch under app/api/");
  assert.deepEqual([...labels].sort(), [...WORKSPACE_ACTIONS].sort());
});
```

- [ ] **Step 8: Run the guards, lint and typecheck**

Run: `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH" && node --test tests/app-source-guards.test.mjs && npm run lint && npm run typecheck`
Expected: `# tests 6` / `# pass 6` / `# fail 0` (the five Wave 1 guards plus `every workspace dispatch label is in WORKSPACE_ACTIONS (critic-08)`); lint reports no findings for `tests/isolation.test.mjs`, `tests/helpers/*.mjs` or the guards file (ESLint runs over `tests/`); typecheck passes unchanged (`tsconfig.json` `include` has no `.mjs` pattern, so this is only a regression check).

Then run the whole node suite once, since `npm test` globs `tests/*.test.mjs` and the new file rides on the build from Step 6 (`build:nav-test` emits the `.test-build/` modules the navigation and route-title tests import):

Run: `npm run build:nav-test && node --experimental-sqlite --test tests/*.test.mjs`
Expected: every file passes; `tests/helpers/*.mjs` are not collected (they do not match `*.test.mjs`).

- [ ] **Step 9: Commit**

```bash
git branch --show-current   # must print feat/wave2-foundation
git add tests/isolation.test.mjs tests/helpers/workspaceActions.mjs tests/helpers/clientSources.mjs tests/app-source-guards.test.mjs
git commit -m "test: two-identity isolation suite over the built worker (critic-08)

19 foreign-id, 7 mixed-ownership and 10 route probes; A's 20-table fingerprint and workspace JSON unchanged. savePushSubscription's 409 existence oracle is pinned as a documented exception and neutralised in the next commit. Lands before any route.ts change (spec §4).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 2: Neutralise the push-endpoint existence oracle in `savePushSubscription` (map 2 finding)

**Rationale:** the isolation map's two-identity replay found no cross-identity data leak, but it found the one deviation from spec §4 bullet 2 ("refuse cross-identity ids (404, never data)"): `savePushSubscription` (`app/api/workspace/route.ts:11679`) reads `push_subscriptions WHERE endpoint = ?` **unscoped** twice (`:11689-11695` before the write, `:11790-11796` after it) and answers `409 push_subscription_conflict "This browser subscription belongs to another account."` when the endpoint belongs to someone else — an existence oracle (critic-08). Severity is low because a push endpoint is an unguessable browser-issued capability URL, and takeover is already impossible: the guarded upsert (`ON CONFLICT(endpoint) DO UPDATE … WHERE push_subscriptions.user_id = excluded.user_id`, `:11734-11743`) changes nothing for a foreign endpoint, and identity A's row is untouched (verified with node:sqlite against the real DDL: `changes: 0`, owner row still `user_id = A, disabled_at = NULL`). So the fix is read-side only: scope both reads by `AND user_id = ?`, and when the upsert changes nothing, answer `409 push_device_limit` only when the caller's own active-device count is genuinely at `MAX_PUSH_DEVICES`, otherwise a neutral `409 push_subscription_unavailable` that says nothing about who owns the endpoint. `removePushSubscription` (`:11813`) already scopes its read (`WHERE endpoint = ? AND user_id = ?`, `:11819-11825`) and stays a 200 no-op for a foreign endpoint — an idempotent delete discloses nothing. Task 1's suite lands first (spec §4: the isolation suite is committed before any `route.ts` change), so this task also flips the one probe row Task 1 wrote against the old behaviour.

**Files:**
- Modify: `app/api/workspace/route.ts:11689-11702` (first unscoped endpoint read + the `push_subscription_conflict` throw), `:11788-11810` (post-batch diagnosis)
- Modify: `tests/isolation.test.mjs` (the `savePushSubscription` row of `FOREIGN_ID_PROBES`)
- Modify: `tests/rendered-html.test.mjs:21237-21241` (the `push_subscription_conflict` expectation inside the subtest "owns, schedules, deduplicates, retries, and expires private phone alerts")
- Test: `tests/isolation.test.mjs`, `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: Task 1's probe table `FOREIGN_ID_PROBES` in `tests/isolation.test.mjs` (its `savePushSubscription` row currently expects `{ status: 409, code: "push_subscription_conflict" }` and carries a raw-row assertion that A still owns the subscription with `disabled_at` NULL — that assertion is kept verbatim); from `route.ts`: `class RequestError(message, status = 400, code = "invalid_request")` (`:398-406`), `query(database, sql, bindings)` (`:408-414`), `const MAX_PUSH_DEVICES = 8` (`:11581`), and the `const now = Date.now()` binding already declared inside `savePushSubscription` (`:11704`, the same instant the upsert's `expiration_time > ?` guards use).
- Produces: new error code `push_subscription_unavailable` (409) with message `This browser can’t be registered for alerts on this account. Clear this site’s notification permission in your browser settings and try again.`; `push_subscription_conflict` no longer exists anywhere (`grep -rn push_subscription_conflict app tests` → 0). `push_device_limit` (409, `iTrack supports up to 8 active alert devices.`) keeps its exact contract — `tests/rendered-html.test.mjs:21697-21703` (a 9th own device) continues to prove it. No later task consumes the new code; Task 9 adds its own rows to `FOREIGN_ID_PROBES` without touching this one.

- [ ] **Step 1: Confirm the starting point**

Run:

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
git branch --show-current
git log --oneline -3
grep -n "push_subscription_conflict" app/api/workspace/route.ts tests/rendered-html.test.mjs tests/isolation.test.mjs
```

Expected: branch `feat/wave2-foundation`; the newest commit is Task 1's (`tests/isolation.test.mjs` exists and is committed); exactly four hits — `route.ts:11700`, `route.ts:11801`, `rendered-html.test.mjs:21240`, and one line in `tests/isolation.test.mjs` (the `expect` of the `savePushSubscription` probe row). If the isolation file is missing or uncommitted, stop: Task 1 must land first. If `lsof -i :3000` shows a dev server, stop it now — it shares `.wrangler/` with the builds below.

- [ ] **Step 2: Write the failing tests (rendered-html expectation + isolation probe row)**

**2a — `tests/rendered-html.test.mjs`.** Inside the subtest "owns, schedules, deduplicates, retries, and expires private phone alerts", the `other@example.com` save of the owner's `firstSubscription` (`const conflict = await postWorkspace(` at line 21228) is followed at lines 21237-21241 by exactly this:

```js
      assert.equal(conflict.status, 409);
      assert.deepEqual(await conflict.json(), {
        error: "This browser subscription belongs to another account.",
        code: "push_subscription_conflict",
      });
```

Replace those five lines with:

```js
      assert.equal(conflict.status, 409);
      assert.deepEqual(await conflict.json(), {
        error:
          "This browser can’t be registered for alerts on this account. Clear this site’s notification permission in your browser settings and try again.",
        code: "push_subscription_unavailable",
      });
```

(Curly apostrophes — `can’t`, `site’s` — exactly as written; the JSON the worker returns must match byte for byte.)

**2b — `tests/isolation.test.mjs`.** Find the row of `FOREIGN_ID_PROBES` whose `action` is `"savePushSubscription"` (`grep -n push_subscription_conflict tests/isolation.test.mjs` points at its `expect`). Leave its `action`, its `payload` closure and the raw-row assertion Task 1 wrote (A still owns the row, `disabled_at` IS NULL) untouched. Change only the `expect` object — whatever its line layout — from

```js
    expect: { status: 409, code: "push_subscription_conflict" },
```

to

```js
    // Neutral 409 (Task 2, critic-08): whether A owns this endpoint is not disclosed.
    expect: { status: 409, code: "push_subscription_unavailable" },
```

and delete any comment on that row that describes the old 409 as a "documented exception" or "existence oracle" — after this task it is neither. Then confirm the edit with:

```bash
grep -c "push_subscription_unavailable" tests/isolation.test.mjs
grep -c "push_subscription_conflict" tests/isolation.test.mjs
```

Expected: `1` then `0`.

- [ ] **Step 3: Run both suites to see them fail against the current worker**

Run:

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
npm run build && node --experimental-sqlite --test tests/rendered-html.test.mjs tests/isolation.test.mjs
```

Expected: FAIL in both files, for the same reason — the worker still answers the old code:

- `tests/rendered-html.test.mjs`: `✖ iTrack product contract` with `✖ owns, schedules, deduplicates, retries, and expires private phone alerts` — `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal` showing `+ code: 'push_subscription_conflict'` / `- code: 'push_subscription_unavailable'` (and the `error` string likewise). Every other subtest still passes.
- `tests/isolation.test.mjs`: the `savePushSubscription` probe fails on the code — actual `push_subscription_conflict`, expected `push_subscription_unavailable`. Every other probe still passes (nothing else in the worker changed).

- [ ] **Step 4: Scope the first read and drop the throw (`route.ts:11689-11702`)**

Verify the anchor first: `sed -n 11689,11703p app/api/workspace/route.ts` must print exactly (line 11703, `const subscriptionId …`, stays):

```ts
  const existing = await query(
    database,
    `SELECT id, user_id AS userId
     FROM push_subscriptions
     WHERE endpoint = ?`,
    [subscription.endpoint],
  ).first<{ id: string; userId: string }>();
  if (existing && existing.userId !== identity.userId) {
    throw new RequestError(
      "This browser subscription belongs to another account.",
      409,
      "push_subscription_conflict",
    );
  }
  const subscriptionId = existing?.id ?? crypto.randomUUID();
```

Replace lines 11689-11702 (everything above `const subscriptionId`) with:

```ts
  // Scoped to the caller (critic-08): a foreign endpoint reads as "not ours".
  const existing = await query(
    database,
    `SELECT id
     FROM push_subscriptions
     WHERE endpoint = ? AND user_id = ?`,
    [subscription.endpoint, identity.userId],
  ).first<{ id: string }>();
```

`const subscriptionId = existing?.id ?? crypto.randomUUID();` is unchanged: for a foreign endpoint `existing` is now `null`, so a fresh id is generated, the upsert hits `ON CONFLICT(endpoint)`, its `WHERE push_subscriptions.user_id = excluded.user_id` guard is false, and the statement changes nothing — which is exactly what Step 5 diagnoses.

- [ ] **Step 5: Replace the post-batch diagnosis (`route.ts:11788-11810`, now shifted up by 6 lines — anchor by text)**

Find it with `grep -n "const currentOwner = await query(" app/api/workspace/route.ts` (one hit). The block from `const [saved] = await database.batch(statements);` through `return subscriptionId;` reads exactly:

```ts
  const [saved] = await database.batch(statements);
  if (Number(saved.meta?.changes ?? 0) === 0) {
    const currentOwner = await query(
      database,
      `SELECT user_id AS userId
       FROM push_subscriptions
       WHERE endpoint = ?`,
      [subscription.endpoint],
    ).first<{ userId: string }>();
    if (currentOwner && currentOwner.userId !== identity.userId) {
      throw new RequestError(
        "This browser subscription belongs to another account.",
        409,
        "push_subscription_conflict",
      );
    }
    throw new RequestError(
      `iTrack supports up to ${MAX_PUSH_DEVICES} active alert devices.`,
      409,
      "push_device_limit",
    );
  }
  return subscriptionId;
```

Replace that whole block with:

```ts
  const [saved] = await database.batch(statements);
  if (Number(saved.meta?.changes ?? 0) === 0) {
    const activeDevices = Number(
      (
        await query(
          database,
          `SELECT COUNT(*) AS n
           FROM push_subscriptions
           WHERE user_id = ?
             AND disabled_at IS NULL
             AND (
               expiration_time IS NULL
               OR expiration_time > ?
             )`,
          [identity.userId, now],
        ).first<{ n: number }>()
      )?.n ?? 0,
    );
    if (activeDevices >= MAX_PUSH_DEVICES) {
      throw new RequestError(
        `iTrack supports up to ${MAX_PUSH_DEVICES} active alert devices.`,
        409,
        "push_device_limit",
      );
    }
    // Deliberately neutral: whether another account already owns this
    // browser's endpoint is not disclosed (critic-08).
    throw new RequestError(
      "This browser can’t be registered for alerts on this account. Clear this site’s notification permission in your browser settings and try again.",
      409,
      "push_subscription_unavailable",
    );
  }
  return subscriptionId;
```

`now` is the `const now = Date.now();` declared just below `subscriptionId` in this function; the count uses the same `disabled_at IS NULL AND (expiration_time IS NULL OR expiration_time > ?)` predicate as the upsert's own `< MAX_PUSH_DEVICES` guard, so the two agree on what "active" means. The four outcomes of the upsert are now: own endpoint (new or re-registered) → saved; foreign endpoint with room → neutral 409; a 9th own endpoint → `push_device_limit`; foreign endpoint with no room → `push_device_limit` (still discloses nothing about the endpoint).

- [ ] **Step 6: Prove no unscoped read of `push_subscriptions` remains in the function**

Run:

```bash
awk '/^async function savePushSubscription\(/,/^async function removePushSubscription\(/' app/api/workspace/route.ts | grep -c "FROM push_subscriptions"
awk '/^async function savePushSubscription\(/,/^async function removePushSubscription\(/' app/api/workspace/route.ts | grep -A2 "FROM push_subscriptions" | grep -c "user_id = ?"
grep -rn "push_subscription_conflict\|belongs to another account" app tests
```

Expected: `5`, then `5` (before this task the second count was `3`: the two endpoint-only reads had no `user_id` within two lines of their `FROM`), then no output from the last grep (exit status 1).

- [ ] **Step 7: Rebuild and run both suites to see them pass**

Run:

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
npm run build && node --experimental-sqlite --test tests/rendered-html.test.mjs tests/isolation.test.mjs
```

Expected: PASS — `# fail 0` for both files. In rendered-html the `other@example.com` save now answers the neutral 409 and the 9th-device block at 21697-21703 still answers `push_device_limit`; in the isolation suite the `savePushSubscription` probe answers `409 push_subscription_unavailable` and its raw-row assertion still finds A's row owned by A with `disabled_at` NULL.

- [ ] **Step 8: Full gates, then e2e with the dev server up**

Run (no dev server on :3000):

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
npm test && npm run typecheck && npm run lint
```

Expected: PASS for every `tests/*.test.mjs` file (the isolation suite included), zero type errors, zero lint findings. If `npm run typecheck` stops with `Cannot find module '@playwright/test'` in `playwright.config.ts` / `tests/e2e/*.spec.ts`, this checkout's `node_modules` predates the Wave 1 devDependency (it is pinned in `package.json` and present in `package-lock.json`): run `npm ci` once under the Node 22 PATH and re-run the three commands.

Then, because this task touches `app/`, start the dev server in a second terminal (`export PATH=… && npm run dev`, wait for it to answer on `http://localhost:3000/`) and run:

```bash
npm run test:e2e
```

Expected: `3 passed` (the two Wave 1 specs; Task 3 has not added the projects yet). Stop the dev server (Ctrl-C) before doing anything else that builds.

- [ ] **Step 9: Commit**

```bash
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
git branch --show-current   # must print feat/wave2-foundation
git add app/api/workspace/route.ts tests/isolation.test.mjs tests/rendered-html.test.mjs
git commit -m "fix(workspace): never disclose whether a push endpoint belongs to another account

savePushSubscription read push_subscriptions WHERE endpoint = ? twice with no
user_id scope and answered 409 push_subscription_conflict for a foreign
endpoint: an existence oracle, the one deviation from \"never disclose\" the
isolation map found (critic-08). Both reads are now scoped by AND user_id = ?.
When the guarded upsert changes nothing, a genuine device-limit hit still
answers 409 push_device_limit; every other case answers the neutral 409
push_subscription_unavailable. The upsert's ON CONFLICT ... WHERE user_id
guard already prevented takeover, so the change is read-side only; the
isolation suite's raw-row assertion proves the owner's row is untouched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 3: Playwright foundation — shared fixtures, four projects, existing specs moved onto them

**Rationale:** spec §4 bullet 1 (a Playwright e2e suite under `tests/e2e/` driven against the dev server with the demo identity, one spec per screen, asserting behaviour not markup — architecture-03) and §9 E2E (both colour schemes, 1440×900 and 390×844). Every later e2e task (4, 10, 11, 12) writes against the fixtures this task creates, so they land first and the two Wave 1 specs move onto them before anything else changes.

**Why the header trick works:** `resolveRequestIdentity` (`db/identity.ts:57-85`) trusts a forwarded `oai-authenticated-user-email` header on any host (`:61-75`) and only falls back to the demo user `demo@local.license-lantern` when there is no header and the hostname is local (`:77-84`). The worker hands every non-internal request to the app handler untouched (`worker/index.ts:55-94`), and under `npm run dev` there is no gateway — the gateway strips inbound `oai-*` headers only in production (`deploy/railway/gateway.mjs:147-149`). So a Playwright context that sends that header is its own workspace, and the header set through the `extraHTTPHeaders` option applies to page navigations and `context.request` alike. Dev D1/R2 state persists across runs (`.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite`), so read-only specs use the demo seed and any spec that saves uses `freshIdentity()`.

**Three precisions over the sketch, each verified against 1.63.0:** (1) `openLog` ends in `.first()` — on desktop Home there are two visible matches for the name regex, the sidebar's "Log activity" (`app/ITrackApp.tsx:6812-6815`) and the greeting's `desktop-only` "Log completed learning" call to action (`:7110-7117`); without `.first()` the click is a strict-mode violation. On the phone projects both are `display: none` (`app/globals.css:5730-5732` and `:5860-5862`, inside `@media (max-width: 820px)` from `:5725`) and the mobile bar's `aria-label="Log completed learning"` button (`:6853-6858`) is the only match. (2) The identity header is injected by overriding the `extraHTTPHeaders` option rather than re-creating `context` with `browser.newContext(...)`: the stock `context`/`page` fixtures then build the context from the project's viewport, colour scheme, device and `baseURL`, and traces/screenshots keep working if a later wave turns them on. (3) `devices["iPhone 13"]` carries `defaultBrowserType: "webkit"`; the two phone projects pin `browserName: "chromium"` so the suite needs one browser install (a WebKit project is a Wave 3 gate decision). The iPhone user agent still makes `isIosLike()` (`app/lib/webPush.ts:30-40`) true on those projects, which is what a real iPhone shows. Four projects, not two diagonals: spec §9 asks for "both colour schemes, 1440×900 and 390×844" and defers only axe to Wave 3, so a dark-desktop or light-phone regression in this wave's new UI (Task 10's `.manage-credential-actions`, Task 11's `.zone-banner` under the dark token remap, Task 12's `.deadline-number-closed` / `.previous-cycles`) is covered here, not later.

**Files:**
- Create: `tests/e2e/fixtures.ts`
- Modify: `playwright.config.ts` (whole file)
- Modify: `package.json:16` (scripts `test:e2e:desktop`, `test:e2e:phone`)
- Modify: `tests/e2e/log-activity-typing.spec.ts`, `tests/e2e/session-ended-mid-save.spec.ts` (whole files)
- Test: `npm run test:e2e` (dev server up) — 3 tests × 4 projects

**Interfaces:**
- Consumes (no earlier task; repo contracts only): `GET /api/workspace` with `accept: application/json` → the `getWorkspace` JSON whose `user` is `{ displayName, email, isDemo, draftStorageNamespace }` (`app/api/workspace/route.ts:5142-5148`, served at `:12327`); `POST /api/workspace` body `{ action, payload }`, which requires `content-type: application/json` (`:12335-12341`), rejects a foreign `Origin` or a non-`same-origin` `sec-fetch-site` with 403 (`:12342-12354`; Playwright's `context.request` sends neither), answers `{ ok: true, action, id }` (`:12469`) and errors as `{ error, code }` (`:12475-12480`); `createCredential`'s custom branch (`:5611-5633`: `credentialName` ≤180, `profession` ≤120, `jurisdiction` ≤120, `issuer` ≤180, `totalRequired` > 0, `unitLabel` ≤40, plus `cycleStart`/`deadline` `YYYY-MM-DD` at `:5347-5348` and `categories[]` at `:5635-5697` whose active-minimum total may not exceed `totalRequired`, `:5719-5734`); `addActivity` (`:5876-5895`: `title` ≤180, `provider` ≤180, `completionDate`, `totalUnits` > 0, `allocatedUnits` ≤ `totalUnits`, `credentialId` owned by the caller or 404 `credential_not_found`, `:5918-5923`). DOM anchors: the hydration placeholder `<div className="view-stack" aria-busy="true" aria-label="Loading iTrack">` (`app/ITrackApp.tsx:10927`); both navs `aria-label="Primary navigation"` (`:6781` sidebar, `:6835` mobile bar) holding `NavButton` `<button>`s whose text is the tab label (`:6877-6901`); `Modal` renders `<section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">` with `<h2 id="modal-title">{title}</h2>` (`:10788-10805`); the activity sheet's title is `"Log completed learning"` (`:4422`); the personal-task editor's title is `"Add a personal task"` (`:9095`); Home's "Add task" button (`:7661-7670`).
- Produces (`tests/e2e/fixtures.ts`, consumed by Tasks 4, 10, 11, 12):

```ts
import { test as base, expect, devices, type BrowserContext, type Locator, type Page } from "@playwright/test";
export type Identity = { email: string; fresh: boolean };
export type Workspace = { user: { email: string; isDemo?: boolean; draftStorageNamespace: string }; credentials: Array<{ id: string; credentialName: string; status: string; deadline: string; revision?: number; [k: string]: unknown }>; archivedCredentials?: Array<{ id: string; credentialName: string }>; activities: Array<{ id: string; title: string; revision: number }>; reminderPreferences: { timeZone: string; pushHourLocal: number; leadDays: number[]; inAppEnabled: boolean; pushEnabled: boolean }; activeCycleId?: string | null };
//   `revision`/`archivedCredentials` are optional until Task 8 returns them; `activeCycleId` until Task 12.
export type CustomCredentialPayload = { credentialName: string; profession: string; jurisdiction: string; issuer: string; totalRequired: number; unitLabel: string; cycleStart: string; deadline: string; categories: Array<{ name: string; requiredUnits: number }> };
export type ActivityPayload = { title: string; provider: string; completionDate: string; totalUnits: number; allocatedUnits: number; credentialId: string };
export type AppFixture = {
  goto(path: string): Promise<void>;            // page.goto(path), then expect(page.locator('[aria-busy="true"][aria-label="Loading iTrack"]')).toHaveCount(0, { timeout: 30_000 })
  errors: string[];                              // pageerror messages + console errors whose first line matches /^(?:[A-Z]\w*)?Error\b/, wired before the test body runs
  expectNoErrors(): void;                        // expect(errors, errors.join("\n")).toEqual([])
  openLog(): Promise<Locator>;                   // click getByRole("button", { name: /^(Log activity|Log completed learning)$/ }).first() → page.getByRole("dialog", { name: "Log completed learning" }) once visible
  dialog(name: string): Locator;                 // page.getByRole("dialog", { name })
  tab(name: "Home" | "Credentials" | "History" | "Profile"): Locator; // page.getByRole("navigation", { name: "Primary navigation" }).getByRole("button", { name, exact: true }) — the display:none nav is excluded by getByRole
  workspace(): Promise<Workspace>;               // context.request.get("/api/workspace", { headers: { accept: "application/json" } }) → json; throws with status + body when !ok()
  act<T = { ok: boolean; id: string }>(action: string, payload: Record<string, unknown>): Promise<T>; // context.request.post("/api/workspace", { data: { action, payload } }); throws new Error(`${action}: ${status} ${body}`) when !ok()
  seedCredential(overrides?: Partial<CustomCredentialPayload>): Promise<{ id: string }>; // act("createCredential", { ...defaults, ...overrides })
  seedActivity(credentialId: string, overrides?: Partial<ActivityPayload>): Promise<{ id: string }>; // act("addActivity", { ...defaults, credentialId, ...overrides })
};
export const freshIdentity = (): Identity => ({ email: `e2e-${process.env.TEST_WORKER_INDEX ?? 0}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.test`, fresh: true });
export const test = base.extend<{ identity: Identity; app: AppFixture }>({
  identity: [{ email: "demo@local.license-lantern", fresh: false }, { option: true }],   // specs that write: test.use({ identity: freshIdentity() })
  extraHTTPHeaders: async ({ identity }, provide) => { await provide(identity.fresh ? { "oai-authenticated-user-email": identity.email } : undefined); },
  app: async ({ page, context }, provide) => { await provide(buildApp(page, context)); },
});
export { expect, devices };
```

  Defaults: `seedCredential` → `{ credentialName: "E2E custom credential", profession: "Counseling", jurisdiction: "Rhode Island", issuer: "E2E board", totalRequired: 10, unitLabel: "hours", cycleStart: "2026-01-01", deadline: "2027-12-31", categories: [{ name: "General", requiredUnits: 10 }] }`; `seedActivity` → `{ title: "E2E course", provider: "E2E provider", completionDate: "2026-06-02", totalUnits: 2, allocatedUnits: 2, credentialId }`. Also produced: Playwright projects `desktop-light` / `desktop-dark` (1440×900, light / dark) and `phone-dark` / `phone-light` (390×844, iPhone 13 descriptor on Chromium, dark / light) — the full spec §9 scheme × viewport matrix — with `fullyParallel: false`, `workers: 1`; npm scripts `test:e2e:desktop` (both desktop projects) and `test:e2e:phone` (both phone projects).

- [ ] **Step 1: Install the pinned Playwright package (precondition)**

`package-lock.json:2364` already pins `@playwright/test` 1.63.0 (Wave 1 added it from a worktree), but a checkout whose `node_modules` predates that has no `node_modules/@playwright/test`. `npm install` installs exactly what the lockfile names and leaves `package.json`/`package-lock.json` untouched; `npx playwright install chromium` is a no-op when the build (Chromium 1243 for 1.63.0) is already in `~/Library/Caches/ms-playwright`.

Run:

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
npm install
npx playwright install chromium
ls node_modules/@playwright/test/package.json
git status --short -- package.json package-lock.json
```

Expected: the `ls` prints `node_modules/@playwright/test/package.json`; the `git status` line prints nothing. If it prints `M package-lock.json`, the lockfile was out of sync with `package.json` before this task — stop and resolve that first; this task never commits the lockfile.

- [ ] **Step 2: Move the two specs onto `./fixtures` (the failing tests)**

Replace the whole of `tests/e2e/log-activity-typing.spec.ts` with (every field step is verbatim from Wave 1; the local error collector is gone and one assertion proves the default identity is the demo user):

```ts
import { expect, test } from "./fixtures";

// app-ux-01 / architecture-M-01: the second keystroke in any log-activity
// field used to throw inside a deferred state updater and unmount the app.
// Typing two characters into each field, slowly enough for the draft-persist
// effect to schedule its timeouts between keys, is the exact reproduction.
// Read-only against the demo workspace: the sheet is never submitted.
test("typing two characters into every log-activity field does not crash the app", async ({ app, page }) => {
  await app.goto("/");
  // No identity header on localhost resolves to the demo user; a spec that
  // saved anything here would mutate the shared dev D1 for every later run.
  expect((await app.workspace()).user.isDemo).toBe(true);
  const sheet = await app.openLog();

  // Checked after every field so a crash is reported as the thrown error
  // rather than as the input that vanished with the unmounted sheet.
  const title = sheet.locator('input[name="title"]');
  await title.click();
  await title.pressSequentially("Et", { delay: 300 });
  app.expectNoErrors();
  await expect(title).toHaveValue("Et");

  const units = sheet.locator('input[name="totalUnits"]');
  await units.click();
  await units.pressSequentially("12", { delay: 300 });
  app.expectNoErrors();
  await expect(units).toHaveValue("12");

  const allocated = sheet.locator('input[name="allocatedUnits"]');
  await allocated.click();
  await allocated.fill("");
  await allocated.pressSequentially("11", { delay: 300 });
  app.expectNoErrors();
  await expect(allocated).toHaveValue("11");

  const provider = sheet.locator('input[name="provider"]');
  await provider.click();
  await provider.pressSequentially("NB", { delay: 300 });
  app.expectNoErrors();
  await expect(provider).toHaveValue("NB");

  // A date input takes whole values; two fills 300 ms apart hit the same
  // pending-lane path a second keystroke does.
  const completion = sheet.locator('input[name="completionDate"]');
  await completion.fill("2026-01-05");
  await page.waitForTimeout(300);
  await completion.fill("2026-01-06");
  app.expectNoErrors();
  await expect(completion).toHaveValue("2026-01-06");

  await expect(sheet).toBeVisible();
  await expect(page.locator("#main-content")).toBeVisible();
  app.expectNoErrors();
});
```

Replace the whole of `tests/e2e/session-ended-mid-save.spec.ts` with (`SESSION_ENDED`, `isWorkspaceApi`, `expectSessionEndedState` and both tests are kept; `collectPageErrors` is gone in favour of `app.errors`; `openAddTask` goes through `app.goto` and `app.dialog`):

```ts
import type { Locator, Page } from "@playwright/test";
import { expect, test, type AppFixture } from "./fixtures";

// app-ux-M-01 / architecture-M-04: a 401 on a write used to surface as a JSON
// parse error. Reading it as "session ended" drops the workspace so the
// Reload-and-sign-in state renders, but the personal-task editor is not gated
// on `workspace`, and a mounted Modal marks its surroundings inert, so the
// Reload state was on screen yet neither perceivable nor operable until the
// user happened to Cancel. The session-ended state has to be the only thing
// on screen, without cancelling anything.
//
// Read-only against the demo workspace: every POST is intercepted before it
// reaches the dev server.

const SESSION_ENDED = {
  status: 401,
  contentType: "application/json",
  headers: { "cache-control": "no-store" },
  body: JSON.stringify({ error: "unauthenticated" }),
};

const isWorkspaceApi = (url: URL) => url.pathname === "/api/workspace";

async function openAddTask(app: AppFixture, page: Page) {
  await app.goto("/");
  await page.getByRole("button", { name: "Add task" }).first().click();
  const sheet = app.dialog("Add a personal task");
  await expect(sheet).toBeVisible();
  await sheet.locator('input[name="title"]').fill("Request transcript");
  return sheet;
}

async function expectSessionEndedState(page: Page, sheet: Locator) {
  await expect(sheet).toHaveCount(0);
  // getByRole ignores aria-hidden subtrees, so this also proves the Reload
  // state is exposed to assistive technology, not just painted.
  const reload = page.getByRole("button", { name: "Reload and sign in" });
  await expect(reload).toBeVisible();
  await expect(reload).toBeEnabled();
  await expect(
    page.getByRole("heading", { name: "Your sign-in needs to be refreshed." }),
  ).toBeVisible();
  const stage = page.locator(".screen-stack");
  await expect(stage).not.toHaveAttribute("aria-hidden", "true");
  expect(await stage.evaluate((element) => (element as HTMLElement).inert)).toBe(false);
  // The page-level banner belongs to a loaded workspace; nothing else is
  // asking for attention.
  await expect(page.locator(".error-banner")).toHaveCount(0);
}

test("a 401 while saving a personal task closes the editor and shows Reload and sign in", async ({ app, page }) => {
  await page.route(isWorkspaceApi, async (route) => {
    if (route.request().method() === "POST") await route.fulfill(SESSION_ENDED);
    else await route.continue();
  });

  const sheet = await openAddTask(app, page);
  await sheet.getByRole("button", { name: "Add task" }).click();

  await expectSessionEndedState(page, sheet);
  app.expectNoErrors();
});

test("a 401 on the workspace refetch after a write conflict shows Reload and sign in", async ({ app, page }) => {
  // A stale-revision conflict makes runAction refetch the workspace while one
  // is still on screen; that refetch is the 401 here. The write itself never
  // reaches the dev server.
  let sessionEnded = false;
  await page.route(isWorkspaceApi, async (route) => {
    if (route.request().method() === "POST") {
      sessionEnded = true;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "That task changed in another session.",
          code: "task_version_conflict",
        }),
      });
    } else if (sessionEnded) {
      await route.fulfill(SESSION_ENDED);
    } else {
      await route.continue();
    }
  });

  const sheet = await openAddTask(app, page);
  await sheet.getByRole("button", { name: "Add task" }).click();

  await expectSessionEndedState(page, sheet);
  app.expectNoErrors();
});
```

- [ ] **Step 3: Run to see them fail (no dev server needed)**

Run: `npx playwright test --list`
Expected: FAIL — `Error: Cannot find module './fixtures'` with `Require stack: - …/tests/e2e/log-activity-typing.spec.ts` (`--list` only loads the spec files; it does not start the `webServer`).

Run: `npm run typecheck`
Expected: FAIL — `tests/e2e/log-activity-typing.spec.ts(1,30): error TS2307: Cannot find module './fixtures' or its corresponding type declarations.` and the same TS2307 at `tests/e2e/session-ended-mid-save.spec.ts(2,47)`, followed by TS7031 `Binding element 'app' implicitly has an 'any' type` lines.

- [ ] **Step 4: Create `tests/e2e/fixtures.ts`**

```ts
import {
  test as base,
  expect,
  devices,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

// Shared fixtures for every spec under tests/e2e (spec §4 bullet 1,
// architecture-03).
//
// Identity. Under `npm run dev` there is no gateway: a request on localhost
// without an `oai-authenticated-user-email` header is the demo user
// (db/identity.ts resolveRequestIdentity), and a request carrying that header
// is whoever the header names — the gateway strips inbound `oai-*` headers
// only in production (deploy/railway/gateway.mjs). Dev D1/R2 state persists
// across runs (.wrangler/state/v3), so the demo workspace is READ-ONLY in
// every spec; a spec that saves anything declares
// `test.use({ identity: freshIdentity() })` and seeds through /api/workspace.
// The header rides on the `extraHTTPHeaders` option, so the stock `context`
// and `page` fixtures still build the context from the project's viewport,
// colour scheme and baseURL, and `context.request` carries the same header.

export type Identity = { email: string; fresh: boolean };

export type Workspace = {
  user: { email: string; isDemo?: boolean; draftStorageNamespace: string };
  credentials: Array<{
    id: string;
    credentialName: string;
    status: string;
    deadline: string;
    revision?: number;
    [k: string]: unknown;
  }>;
  archivedCredentials?: Array<{ id: string; credentialName: string }>;
  activities: Array<{ id: string; title: string; revision: number }>;
  reminderPreferences: {
    timeZone: string;
    pushHourLocal: number;
    leadDays: number[];
    inAppEnabled: boolean;
    pushEnabled: boolean;
  };
  activeCycleId?: string | null;
};

export type CustomCredentialPayload = {
  credentialName: string;
  profession: string;
  jurisdiction: string;
  issuer: string;
  totalRequired: number;
  unitLabel: string;
  cycleStart: string;
  deadline: string;
  categories: Array<{ name: string; requiredUnits: number }>;
};

export type ActivityPayload = {
  title: string;
  provider: string;
  completionDate: string;
  totalUnits: number;
  allocatedUnits: number;
  credentialId: string;
};

export type AppFixture = {
  goto(path: string): Promise<void>;
  errors: string[];
  expectNoErrors(): void;
  openLog(): Promise<Locator>;
  dialog(name: string): Locator;
  tab(name: "Home" | "Credentials" | "History" | "Profile"): Locator;
  workspace(): Promise<Workspace>;
  act<T = { ok: boolean; id: string }>(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<T>;
  seedCredential(
    overrides?: Partial<CustomCredentialPayload>,
  ): Promise<{ id: string }>;
  seedActivity(
    credentialId: string,
    overrides?: Partial<ActivityPayload>,
  ): Promise<{ id: string }>;
};

const DEMO_IDENTITY: Identity = {
  email: "demo@local.license-lantern",
  fresh: false,
};

// A workspace nobody else writes to: worker index, time and a random suffix
// keep two runs (and the four projects, which each load a spec file
// separately) apart. Rows accumulate in the dev D1 file; that is the point.
export const freshIdentity = (): Identity => ({
  email: `e2e-${process.env.TEST_WORKER_INDEX ?? 0}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.test`,
  fresh: true,
});

// The custom branch of createCredential (no ruleSetId): one "General"
// category equal to the total keeps the category-total check satisfied.
const CREDENTIAL_DEFAULTS: CustomCredentialPayload = {
  credentialName: "E2E custom credential",
  profession: "Counseling",
  jurisdiction: "Rhode Island",
  issuer: "E2E board",
  totalRequired: 10,
  unitLabel: "hours",
  cycleStart: "2026-01-01",
  deadline: "2027-12-31",
  categories: [{ name: "General", requiredUnits: 10 }],
};

// Inside the default cycle window above.
const ACTIVITY_DEFAULTS: Omit<ActivityPayload, "credentialId"> = {
  title: "E2E course",
  provider: "E2E provider",
  completionDate: "2026-06-02",
  totalUnits: 2,
  allocatedUnits: 2,
};

function buildApp(page: Page, context: BrowserContext): AppFixture {
  const errors: string[] = [];
  // A render-time throw is uncaught in production (pageerror); under
  // `npm run dev` vinext's recovery boundary catches it and React reports it
  // through console.error. Collect both so a crash is named as the thrown
  // error rather than as the control that vanished with the unmounted tree.
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && /^(?:[A-Z]\w*)?Error\b/.test(text)) {
      errors.push(text.split("\n")[0]);
    }
  });

  const act = async <T = { ok: boolean; id: string }>(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<T> => {
    // context.request sends `content-type: application/json` for object
    // data and neither Origin nor sec-fetch-site, so the worker's
    // same-origin check on POST /api/workspace is satisfied.
    const response = await context.request.post("/api/workspace", {
      data: { action, payload },
    });
    if (!response.ok()) {
      throw new Error(
        `${action}: ${response.status()} ${await response.text()}`,
      );
    }
    return (await response.json()) as T;
  };

  return {
    errors,
    async goto(path) {
      await page.goto(path);
      // The shell is server-rendered before React hydrates, so an early
      // click is lost. The placeholder is swapped out only after the client
      // has hydrated and fetched the workspace; wait for that first.
      await expect(
        page.locator('[aria-busy="true"][aria-label="Loading iTrack"]'),
      ).toHaveCount(0, { timeout: 30_000 });
    },
    expectNoErrors() {
      expect(errors, errors.join("\n")).toEqual([]);
    },
    async openLog() {
      // ≥ 821px: the sidebar's "Log activity" (Home's desktop-only
      // "Log completed learning" call to action also matches, hence
      // .first()); ≤ 820px: the mobile bar's button labelled
      // "Log completed learning". getByRole skips whichever is display:none.
      await page
        .getByRole("button", {
          name: /^(Log activity|Log completed learning)$/,
        })
        .first()
        .click();
      const sheet = page.getByRole("dialog", {
        name: "Log completed learning",
      });
      await expect(sheet).toBeVisible();
      return sheet;
    },
    dialog(name) {
      return page.getByRole("dialog", { name });
    },
    tab(name) {
      // Both the sidebar and the mobile bar are labelled "Primary
      // navigation"; only the one that is not display:none at the current
      // viewport is matched.
      return page
        .getByRole("navigation", { name: "Primary navigation" })
        .getByRole("button", { name, exact: true });
    },
    async workspace() {
      const response = await context.request.get("/api/workspace", {
        headers: { accept: "application/json" },
      });
      if (!response.ok()) {
        throw new Error(
          `GET /api/workspace: ${response.status()} ${await response.text()}`,
        );
      }
      return (await response.json()) as Workspace;
    },
    act,
    async seedCredential(overrides = {}) {
      const result = await act("createCredential", {
        ...CREDENTIAL_DEFAULTS,
        ...overrides,
      });
      return { id: result.id };
    },
    async seedActivity(credentialId, overrides = {}) {
      const result = await act("addActivity", {
        ...ACTIVITY_DEFAULTS,
        credentialId,
        ...overrides,
      });
      return { id: result.id };
    },
  };
}

export const test = base.extend<{ identity: Identity; app: AppFixture }>({
  identity: [DEMO_IDENTITY, { option: true }],
  // The callback is named `provide`, not Playwright's conventional `use`:
  // eslint-config-next's react-hooks/rules-of-hooks reads a bare `use(...)`
  // call as the React hook and fails `npm run lint`.
  extraHTTPHeaders: async ({ identity }, provide) => {
    await provide(
      identity.fresh
        ? { "oai-authenticated-user-email": identity.email }
        : undefined,
    );
  },
  app: async ({ page, context }, provide) => {
    await provide(buildApp(page, context));
  },
});

export { expect, devices };
```

Playwright's default `testMatch` is `**/*.@(spec|test).?(c|m)[jt]s?(x)`, so `fixtures.ts` is not collected as a spec; never name a helper under `tests/e2e/` `*.test.ts` or `*.spec.ts`.

- [ ] **Step 5: Replace `playwright.config.ts` (whole file)**

```ts
import { defineConfig, devices } from "@playwright/test";

// Browser regression tests against the dev server (demo identity on
// localhost; fresh identities via tests/e2e/fixtures.ts). Not part of
// `npm test`: run `npm run test:e2e` with the dev server up (it is started
// for you if :3000 is free). Four projects cover the whole spec §9 matrix
// (both colour schemes at 1440×900 and at 390×844); only the axe gate
// arrives with Wave 3.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  retries: 0,
  reporter: "list",
  // One dev server and one D1 file behind it: specs that write share them,
  // so nothing runs in parallel.
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
  },
  projects: [
    {
      name: "desktop-light",
      use: { viewport: { width: 1440, height: 900 }, colorScheme: "light" },
    },
    {
      name: "phone-dark",
      // The iPhone descriptor brings the Safari user agent, touch and the
      // 3x scale factor. Its defaultBrowserType is WebKit, pinned back to
      // Chromium so the suite needs one browser install (a WebKit project is
      // a Wave 3 gate decision), and its 390×664 viewport is replaced by
      // the spec's 390×844. phone-light below is the same descriptor in the
      // light scheme; desktop-dark is the desktop viewport in the dark one.
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        colorScheme: "dark",
      },
    },
    {
      name: "desktop-dark",
      use: { viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
    },
    {
      name: "phone-light",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        colorScheme: "light",
      },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000/",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
```

- [ ] **Step 6: Add the two project scripts to `package.json`**

`package.json:16` is exactly:

```json
    "test:e2e": "playwright test",
```

Replace that one line with:

```json
    "test:e2e": "playwright test",
    "test:e2e:desktop": "playwright test --project=desktop-light --project=desktop-dark",
    "test:e2e:phone": "playwright test --project=phone-dark --project=phone-light",
```

`npm test` (`package.json:12`) still globs `tests/*.test.mjs`, which does not descend into `tests/e2e/`; the e2e scripts stay separate and are never chained into it.

- [ ] **Step 7: List the matrix, typecheck, lint (still no dev server)**

Run: `npx playwright test --list`
Expected: PASS — exactly this listing (three tests, each under all four projects, grouped in the config's project order):

```
Listing tests:
  [desktop-light] › log-activity-typing.spec.ts:8:5 › typing two characters into every log-activity field does not crash the app
  [desktop-light] › session-ended-mid-save.spec.ts:51:5 › a 401 while saving a personal task closes the editor and shows Reload and sign in
  [desktop-light] › session-ended-mid-save.spec.ts:64:5 › a 401 on the workspace refetch after a write conflict shows Reload and sign in
  [phone-dark] › log-activity-typing.spec.ts:8:5 › typing two characters into every log-activity field does not crash the app
  [phone-dark] › session-ended-mid-save.spec.ts:51:5 › a 401 while saving a personal task closes the editor and shows Reload and sign in
  [phone-dark] › session-ended-mid-save.spec.ts:64:5 › a 401 on the workspace refetch after a write conflict shows Reload and sign in
  [desktop-dark] › log-activity-typing.spec.ts:8:5 › typing two characters into every log-activity field does not crash the app
  [desktop-dark] › session-ended-mid-save.spec.ts:51:5 › a 401 while saving a personal task closes the editor and shows Reload and sign in
  [desktop-dark] › session-ended-mid-save.spec.ts:64:5 › a 401 on the workspace refetch after a write conflict shows Reload and sign in
  [phone-light] › log-activity-typing.spec.ts:8:5 › typing two characters into every log-activity field does not crash the app
  [phone-light] › session-ended-mid-save.spec.ts:51:5 › a 401 while saving a personal task closes the editor and shows Reload and sign in
  [phone-light] › session-ended-mid-save.spec.ts:64:5 › a 401 on the workspace refetch after a write conflict shows Reload and sign in
Total: 12 tests in 2 files
```

Run: `npm run typecheck && npm run lint`
Expected: PASS / PASS. `tsc --noEmit` covers `tests/e2e/*.ts` (`tsconfig.json` includes `**/*.ts` with `lib: ["dom", …]` and `@types/node`, so `process.env` and `HTMLElement` both resolve); `eslint .` lints `tests/` with eslint-config-next, whose `react-hooks/rules-of-hooks` is why the fixture callbacks are named `provide` — a bare `use(...)` call there fails lint with `React Hook "use" is called in function "app" that is neither a React function component nor a custom React Hook function`.

- [ ] **Step 8: Run the suite on all four projects with the dev server up, then `npm test`**

In a second terminal (same `PATH` line): `npm run dev`, and wait until `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/` prints `200`.

Run: `npm run test:e2e`
Expected: PASS — `12 passed` (the `list` reporter shows each test once under each of `[desktop-light]`, `[phone-dark]`, `[desktop-dark]` and `[phone-light]`). On the two phone projects the log control that `openLog` clicks is the mobile bar's `aria-label="Log completed learning"` button and the sidebar is `display: none`; on the two desktop projects it is the sidebar's "Log activity". The colour scheme changes nothing these three tests assert; it is there so every later spec (Tasks 4, 10, 11, 12) runs under both schemes at both viewports, as spec §9 requires.

Run: `npm run test:e2e:desktop`
Expected: PASS — `6 passed`, every line prefixed `[desktop-light]` or `[desktop-dark]`.

Run: `npm run test:e2e:phone`
Expected: PASS — `6 passed`, every line prefixed `[phone-dark]` or `[phone-light]`.

Nothing was saved: both specs stay on the demo identity (the typing spec proves it with `user.isDemo === true`; the session-ended spec intercepts every POST). A failed run writes only under `test-results/`, which `.gitignore` already excludes (`/test-results/`, `/playwright-report/`).

Stop the dev server (Ctrl-C in the second terminal) — `npm run build` and `npm run dev` share `.wrangler/` state — then run the node suite, which this task does not change but which must be green at every task's final step:

Run: `npm test`
Expected: PASS (full `vinext build`, then `build:nav-test`, then `node --experimental-sqlite --test tests/*.test.mjs`).

- [ ] **Step 9: Commit**

```bash
git branch --show-current
```

Expected: `feat/wave2-foundation` (another session may share this tree; do not commit from any other branch).

```bash
git add tests/e2e/fixtures.ts tests/e2e/log-activity-typing.spec.ts tests/e2e/session-ended-mid-save.spec.ts playwright.config.ts package.json
git status --short
```

Expected: exactly those five paths staged (`A  tests/e2e/fixtures.ts` and four `M`), nothing else listed apart from untracked files.

```bash
git commit -m "test(e2e): shared fixtures, four scheme × viewport projects, fresh-identity support

tests/e2e/fixtures.ts: app fixture (goto/openLog/dialog/tab/workspace/act/
seedCredential/seedActivity, page-error collection) and an identity option;
a fresh identity forwards oai-authenticated-user-email on page navigations
and context.request alike, so writing specs get their own workspace and the
demo workspace stays read-only. Four Playwright projects — 1440×900 and
390×844 (Chromium with the iPhone 13 descriptor), each in light and dark, the
whole spec §9 matrix — workers: 1 over the shared dev D1, scripts
test:e2e:desktop / test:e2e:phone. The two Wave 1 specs move onto the
fixtures unchanged in behaviour.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 4: One behavioural Playwright spec per screen, written against the current UI

**Rationale:** spec §4 bullet 1 ("one spec per screen, asserting behaviour not markup") and §9 E2E; architecture-03 (the 196 source-regex pins over `app/ITrackApp.tsx` / `app/globals.css` in `tests/rendered-html.test.mjs` break on any file move) and ios-coupling-15 ("delete pins rather than editing regexes"). Task 5 deletes six whole subtests and the client-source asserts of eleven more; before it can, every behaviour those pins encoded needs a home that survives the Wave 3/4 screen split. That home is a Playwright spec per screen on the Task 3 fixtures, asserting only what a user can see and do: roles, accessible names, URLs, downloads, HTTP status. The only markup hooks allowed are the two already in use — `h1.push-title` and `.modal-card` (the latter lives inside `app.openLog()`; no spec here touches it directly). Each file's header names, by subtest title, the `tests/rendered-html.test.mjs` subtests it replaces, so Task 5's deletion commit can cite these files.

These are characterisation specs: they pin behaviour the app already has, so every run in this task is expected **green**. Nothing under `app/` changes here. A red assertion means the pin is wrong (re-read the cited line of `app/ITrackApp.tsx` and fix the spec), never that the app needs a change.

**Identity rule (Global Constraints):** read-only tests run as the demo identity — `demo@local.license-lantern`, seeded by `ensureDemoWorkspace` (`db/runtime.ts:6094-6400`: one credential "Licensed Clinical Social Worker" / New Jersey, `db/runtime.ts:6127`; one activity "Ethics in Digital Practice", `:6255-6268`; three tasks; display name "Alex Morgan", `db/identity.ts:82`). Anything that saves runs under `test.use({ identity: freshIdentity() })` and seeds through `app.seedCredential()` / `app.seedActivity()`. The demo workspace is never written to. The dev D1 is shared and persistent (`.wrangler/state/v3/d1/`), so a *human* may have hand-edited the demo workspace; if a demo assertion below fails on the row count or on the ethics record, stop the dev server, delete `.wrangler/state/v3/d1`, start it again — `ensureDemoWorkspace` re-seeds a demo user that has no credentials (`db/runtime.ts:6095-6100`).

**Files:**
- Create: `tests/e2e/home.spec.ts`, `tests/e2e/credentials.spec.ts`, `tests/e2e/credential-detail.spec.ts`, `tests/e2e/log-activity.spec.ts`, `tests/e2e/history.spec.ts`, `tests/e2e/profile.spec.ts`, `tests/e2e/packet.spec.ts`
- Delete: `tests/e2e/log-activity-typing.spec.ts` (its test moves verbatim into `log-activity.spec.ts`)
- Test: `npm run test:e2e` — every spec on all four projects

**Interfaces:**
- Consumes (Task 3, `tests/e2e/fixtures.ts`): `test`, `expect`, `freshIdentity(): Identity`, and the `app` fixture — `app.goto(path: string): Promise<void>` (navigates and waits for `[aria-busy="true"][aria-label="Loading iTrack"]` to be gone), `app.openLog(): Promise<Locator>` (clicks the "Log activity" / "Log completed learning" button and returns the "Log completed learning" dialog once visible), `app.dialog(name: string): Locator`, `app.tab(name: "Home" | "Credentials" | "History" | "Profile"): Locator` (the visible "Primary navigation" button), `app.seedCredential(overrides?: Partial<CustomCredentialPayload>): Promise<{ id: string }>` (defaults: `credentialName: "E2E custom credential"`, `cycleStart: "2026-01-01"`, `deadline: "2027-12-31"`, `totalRequired: 10`, `unitLabel: "hours"`, one "General" category), `app.seedActivity(credentialId: string, overrides?: Partial<ActivityPayload>): Promise<{ id: string }>` (defaults: `title: "E2E course"`, `completionDate: "2026-06-02"`, `totalUnits: 2`), `app.expectNoErrors(): void`; plus Playwright's own `page` and `context`. The `identity` option fixture accepts `test.use({ identity })` at file or `describe` scope. The four projects Task 3 configured in `playwright.config.ts` (desktop 1440×900 and phone 390×844, each in light and dark).
- Consumes (app contract, read only — the lines each pin was verified against at `main@8ac172a`): both `<nav aria-label="Primary navigation">` landmarks sit outside `<main id="main-content">` (`app/ITrackApp.tsx:4166`, `:4185-4411`, `:4414`), `NavButton` sets `aria-current="page"` (`:6892`); `document.title = routeTitle(...)` (`:2456`, `app/lib/routeTitle.ts:13-19`: `"<tab> · iTrack"` / `"<credential name> · iTrack"`); the parked root screen is `inert` + `aria-hidden` while a detail is pushed (`:4213-4220`); `nav.push` writes `/credentials/<id>` and `nav.pop` calls `history.back()` (`:1370-1382`, `:1405-1413`; `app/lib/navigation.ts:33-36`); an unknown detail id bounces to `/credentials` once the workspace has loaded (`:2556-2559`); the push header is a button labelled with the origin tab followed by `<h1 className="push-title">` (`:8087-8091`, `backLabel={TAB_LABELS[view]}` at `:4370`). Home: `<h2 id="renewal-heading">` (`:7141`), "View plan" (`:7152` → `openCredentialDetail`, `:4242`), kicker "Best next action" (`:7334`), readiness `role="progressbar"` with `aria-valuenow` (`:7203-7211`), "Needs attention" check-ins with "Log credits" on deadline reminders (`:7226-7286`; `app/lib/reminders.ts:127-139` activation = latest lead day ≤ today, lead days default `[90,30,7,1]`), "Add task" (`:7669`) → Modal "Add a personal task" (`:9095`), region "Recent learning" (`:7859-7863`). Credentials: `<h1>` "Every renewal, one clear place." (`:7943`, `PageGreeting` renders `<h1>` at `:10661`), region `aria-label="Your credentials"` of row buttons (`:7955-7985`), "Add credential" (`:7948`), empty `<h2>` "Add your first credential" (`:7993`), Modal "Set up a credential" (`:4949`) with mode buttons "Use source-linked template" / "Enter my own" (`:4964`, `:4972`; template mode is the default, `:1694`), search input `type="search"` with placeholder "Search profession, license, certification, or state" whose `onChange` clears `selectedRuleId` (`:5040-5050`), `<select name="ruleSetId">` grouped by `<optgroup>` per profession (`:5060-5080`), "0 matches" count and the "No exact match — enter my own requirements" button when nothing matches (`:5082-5108`), custom inputs `profession` / `jurisdiction` / `credentialName` / `issuer` / `totalRequired` / `unitLabel` (`:4976-5034`), prefilled `cycleStart` / `deadline` (`:5285-5314`), submit "Create renewal plan" (`:5443`), success closes the sheet (`:3575-3580`). Detail: packet link "Prepare credential packet" `href="/api/export/packet?credentialId=…"` (`:8162-8173`), "Add renewal date to calendar" (`:8200-8213` → `addCredentialToCalendar`, `:3026-3034`, toast "Renewal date handed off to your calendar."; `app/lib/calendarInvite.ts:203-229` — no `navigator.share` in a headless browser, so the anchor download at `:220-228` runs), "Log submission" (`:8384`) → Modal "Log your submission" for a custom credential (`:5450-5460`). Log sheet: Modal "Log completed learning" (`:4422`), draft note `role="status"` reading "Saving in this browser" then, 250 ms after the last change, "Saved in this browser" (`:4493-4529`, `:2374-2386`, `:1788-1810`), `select[name="credentialId"]` valued with the chosen credential (`:4719-4742`), `totalUnits` mirrors into an empty `allocatedUnits` (`:4669-4680`), submit "Save activity" (`:4897`), success closes the sheet (`finishSavedActivityEntry`). History: `<h1>` "Your learning, organized as you go." (`:8489`), region `aria-label="Completed activities"` (`:8526`), per-row button `aria-label="Edit <title>"` (`:8683-8689`), Modal "Edit learning record" (`:8846-8847`) with a two-step "Archive record" (`:9019-9052`), `<details>` whose `<summary>` reads "Archived records" (`:8707-8710`) and per-row `aria-label="Restore <title>"` (`:8746-8768`). Profile: kicker "Signed in as" + `<h2>{displayName}</h2>` (`:9323-9324`), demo shows "Local preview" instead of the sign-out form (`:9327-9336`), `<fieldset><legend>Weekly action target</legend>` with five radios Light/Steady/Balanced/Focused/Ambitious (`:9434-9452`, presets `:9259-9265`; rows are `min-height: 48px` at every viewport, `app/globals.css:3539-3544`), "Manage reminders" (`:9500`) → Modal "Due-date check-ins" (`:5953`). Packet: `app/api/export/packet/route.ts:26-67` (`packetError`: JSON `{ error, code }` when `accept` includes `application/json`, else an HTML page whose `<h1>` is "Packet unavailable" for 404) and `:110-121` (owner-scoped lookup → 404 `credential_not_found`); `app/lib/renewalPacket.ts:516` (`<meta name="license-lantern-packet-version" content="1">`), `:710` (`<h1>` = credential name), `:330` (activity titles as `<h3>`). Toasts render as `<div className="toast" role="status">` (`:6557-6559`) for 6 s (`:2403-2407`).
- Produces: the seven spec files, each beginning with `// Replaces tests/rendered-html.test.mjs subtests: "<title>", … — behaviour those pins encoded is asserted here against the running app.` Task 5's deletion commit cites these files by path and these subtests by title: home/credentials/credential-detail ← "pushes credential detail onto the navigation stack", "leaves no history entry the user cannot get out of", "slides screens in and out and follows the back gesture", "answers touch the way the platform does"; credentials ← also "keeps the larger template chooser and alternative tags mobile-accessible"; profile ← "ships an accessible phone-first weekly-rhythm control"; history ← the History-row pins of that same subtest; log-activity ← the draft/calendar pins of "ships the installable phone companion without caching private data"; packet ← the `appSource` pins of "renders an escaped owner-scoped credential packet with countable progress". Nothing here is imported by another file.

- [ ] **Step 1: Confirm the branch and record the coverage the screens have today**

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
git branch --show-current
ls tests/e2e
npx playwright test --list
```

Expected: `feat/wave2-foundation`; `fixtures.ts  log-activity-typing.spec.ts  session-ended-mid-save.spec.ts`; the listing names exactly three tests per project (`typing two characters into every log-activity field does not crash the app` and the two `session-ended-mid-save` cases) — twelve in total across the four projects, all on the Home screen's sheets. Credentials, the pushed detail, History, Profile and the packet have no browser coverage; that is the gap the seven files below close.

- [ ] **Step 2: Create `tests/e2e/home.spec.ts`**

```ts
// Replaces tests/rendered-html.test.mjs subtests: "pushes credential detail onto the navigation stack", "leaves no history entry the user cannot get out of", "slides screens in and out and follows the back gesture", "answers touch the way the platform does" — behaviour those pins encoded is asserted here against the running app.
import { expect, freshIdentity, test } from "./fixtures";

// The demo identity (localhost, no header) is read-only in every spec: its
// seed is one NJ LCSW credential, an ethics activity and three tasks
// (db/runtime.ts ensureDemoWorkspace). Nothing at this level saves.

test("Home is the current tab, names the credential, and scores it", async ({ page, app }) => {
  await app.goto("/");
  await expect(app.tab("Home")).toHaveAttribute("aria-current", "page");
  await expect(app.tab("Credentials")).not.toHaveAttribute("aria-current", "page");
  await expect(page).toHaveTitle("Home · iTrack");
  await expect(
    page.getByRole("heading", { name: "Licensed Clinical Social Worker", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Best next action")).toBeVisible();
  // The readiness ring and every other meter announce a value, not a shape.
  const bars = page.getByRole("progressbar");
  await expect(bars.first()).toBeVisible();
  for (const bar of await bars.all()) {
    await expect(bar).toHaveAttribute("aria-valuenow", /^\d+(\.\d+)?$/);
  }
  app.expectNoErrors();
});

test("View plan pushes the credential and the browser back button returns Home", async ({ page, app }) => {
  await app.goto("/");
  await page.getByRole("button", { name: "View plan" }).click();
  await expect(page).toHaveURL(/\/credentials\/[^/]+$/);
  await expect(page.locator("h1.push-title")).toHaveText("Licensed Clinical Social Worker");
  await expect(page).toHaveTitle("Licensed Clinical Social Worker · iTrack");
  await page.goBack();
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/$/);
  await expect(page).toHaveTitle("Home · iTrack");
  await expect(
    page.getByRole("heading", { name: "Licensed Clinical Social Worker", exact: true }),
  ).toBeVisible();
  app.expectNoErrors();
});

test("Add task opens the personal-task sheet", async ({ page, app }) => {
  await app.goto("/");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(app.dialog("Add a personal task")).toBeVisible();
  app.expectNoErrors();
});

test.describe("Log credits", () => {
  // Opening the sheet writes a browser draft only, but the check-in this
  // test needs must not depend on what a human has dismissed in the shared
  // demo workspace, so it is seeded under a throwaway identity.
  test.use({ identity: freshIdentity() });

  const isoDaysFromToday = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  test("a deadline check-in's Log credits opens the sheet with that credential chosen", async ({ page, app }) => {
    // A deadline 20 days out sits inside the 30-day lead window, so Home
    // shows a "Needs attention" check-in for it (app/lib/reminders.ts
    // reminderActivationDate; lead days default to [90, 30, 7, 1]).
    const { id } = await app.seedCredential({
      credentialName: "E2E deadline credential",
      cycleStart: isoDaysFromToday(-345),
      deadline: isoDaysFromToday(20),
    });
    await app.goto("/");
    await expect(page.getByText("Needs attention")).toBeVisible();
    await page.getByRole("button", { name: "Log credits" }).click();
    const sheet = app.dialog("Log completed learning");
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('select[name="credentialId"]')).toHaveValue(id);
    app.expectNoErrors();
  });
});
```

- [ ] **Step 3: Run it on all four projects**

Start the dev server in another terminal if it is not already running: `npm run dev`. Then:

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
npx playwright test tests/e2e/home.spec.ts
```

Expected: `16 passed` (4 tests × 4 projects). A red assertion here is a wrong pin: re-read the cited line in `app/ITrackApp.tsx` and correct the selector or text in the spec — nothing under `app/` changes in this task.

- [ ] **Step 4: Create `tests/e2e/credentials.spec.ts`**

```ts
// Replaces tests/rendered-html.test.mjs subtests: "pushes credential detail onto the navigation stack", "leaves no history entry the user cannot get out of", "slides screens in and out and follows the back gesture", "answers touch the way the platform does", "keeps the larger template chooser and alternative tags mobile-accessible" — behaviour those pins encoded is asserted here against the running app.
import { expect, freshIdentity, test } from "./fixtures";

test("the list names every credential and Add credential opens the setup sheet", async ({ page, app }) => {
  await app.goto("/credentials");
  await expect(page).toHaveTitle("Credentials · iTrack");
  await expect(app.tab("Credentials")).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Every renewal, one clear place." }),
  ).toBeVisible();
  const list = page.getByRole("region", { name: "Your credentials" });
  await expect(
    list.getByRole("button", { name: "Licensed Clinical Social Worker" }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Add credential", exact: true }).click();
  await expect(app.dialog("Set up a credential")).toBeVisible();
  app.expectNoErrors();
});

test("the template chooser groups templates by profession and a miss offers the custom path", async ({ page, app }) => {
  await app.goto("/credentials");
  await page.getByRole("button", { name: "Add credential", exact: true }).click();
  const sheet = app.dialog("Set up a credential");
  const templates = sheet.getByRole("combobox", { name: "Profession, credential, and state" });
  // The catalog is fetched when the sheet opens; the first optgroup is the
  // proof it arrived and is grouped by profession.
  await expect(templates.locator("optgroup").first()).toBeAttached({ timeout: 15_000 });
  await templates.selectOption({ index: 1 });
  await expect(templates).not.toHaveValue("");
  // Typing a new search drops the template that was chosen: the search and
  // the choice are one control, never two disagreeing ones.
  const search = sheet.getByPlaceholder("Search profession, license, certification, or state");
  await search.fill("zzzz");
  await expect(templates).toHaveValue("");
  await expect(templates.locator("optgroup")).toHaveCount(0);
  await expect(sheet.getByText("0 matches")).toBeVisible();
  await sheet
    .getByRole("button", { name: "No exact match — enter my own requirements" })
    .click();
  await expect(sheet.locator('input[name="credentialName"]')).toBeVisible();
  await expect(sheet.locator('input[name="totalRequired"]')).toBeVisible();
  app.expectNoErrors();
});

test.describe("as a new account", () => {
  test.use({ identity: freshIdentity() });

  test("starts empty, and a custom credential created through the sheet is listed", async ({ page, app }) => {
    await app.goto("/credentials");
    await expect(
      page.getByRole("heading", { name: "Add your first credential" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add credential", exact: true }).click();
    const sheet = app.dialog("Set up a credential");
    await sheet.getByRole("button", { name: "Enter my own", exact: true }).click();
    const name = `E2E created credential ${Date.now().toString(36)}`;
    await sheet.locator('input[name="profession"]').fill("Counseling");
    await sheet.locator('input[name="jurisdiction"]').fill("Rhode Island");
    await sheet.locator('input[name="credentialName"]').fill(name);
    await sheet.locator('input[name="totalRequired"]').fill("10");
    await expect(sheet.locator('input[name="unitLabel"]')).toHaveValue("hours");
    // The cycle dates arrive prefilled (a year back, a year ahead). Task 11
    // pins them to the local calendar under a fixed clock.
    await expect(sheet.locator('input[name="cycleStart"]')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    await expect(sheet.locator('input[name="deadline"]')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    await sheet.getByRole("button", { name: "Create renewal plan" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Credential added." }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Your credentials" }).getByRole("button", { name }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "Add your first credential" }),
    ).toHaveCount(0);
    app.expectNoErrors();
  });
});
```

- [ ] **Step 5: Run it on all four projects**

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
npx playwright test tests/e2e/credentials.spec.ts
```

Expected: `12 passed` (3 tests × 4 projects). The demo test's `toHaveCount(1)` counts row buttons naming the LCSW credential, so an extra hand-added credential in the shared demo workspace does not trip it — a second LCSW row does; see the identity rule above for the reset.

- [ ] **Step 6: Create `tests/e2e/credential-detail.spec.ts`**

```ts
// Replaces tests/rendered-html.test.mjs subtests: "pushes credential detail onto the navigation stack", "leaves no history entry the user cannot get out of", "slides screens in and out and follows the back gesture", "answers touch the way the platform does" — behaviour those pins encoded is asserted here against the running app.
import { expect, freshIdentity, test } from "./fixtures";

// Every test seeds its own credential under one throwaway identity per
// file. The pushed screen, its back control and the calendar hand-off are
// read-only, but the demo workspace on the shared dev D1 is never the
// fixture for a screen that is about to grow writes (Task 10 adds
// edit / archive / delete in a sibling spec).
test.use({ identity: freshIdentity() });

const uniqueName = (label: string) =>
  `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

test("a list row pushes the detail; the browser back button returns to the list", async ({ page, app }) => {
  const name = uniqueName("E2E detail");
  await app.seedCredential({ credentialName: name });
  await app.goto("/credentials");
  await page
    .getByRole("region", { name: "Your credentials" })
    .getByRole("button", { name })
    .click();
  await expect(page).toHaveURL(/\/credentials\/[^/]+$/);
  await expect(page.locator("h1.push-title")).toHaveText(name);
  await expect(page).toHaveTitle(`${name} · iTrack`);
  // The back control is labelled with the screen it returns to. The tab
  // bars sit outside <main> and the parked list is aria-hidden, so this is
  // the only "Credentials" button in the main landmark.
  await expect(
    page.getByRole("main").getByRole("button", { name: "Credentials", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/credentials$/);
  await expect(
    page.getByRole("heading", { name: "Every renewal, one clear place." }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Credentials · iTrack");
  app.expectNoErrors();
});

test("opened from Home, the back control is labelled Home and returns there", async ({ page, app }) => {
  // Home shows the soonest deadline; every other seed in this file keeps
  // the fixture default (2027-12-31), so this one is the hero.
  const name = uniqueName("E2E home plan");
  await app.seedCredential({ credentialName: name, deadline: "2027-06-30" });
  await app.goto("/");
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View plan" }).click();
  await expect(page).toHaveURL(/\/credentials\/[^/]+$/);
  await expect(page.locator("h1.push-title")).toHaveText(name);
  const back = page.getByRole("main").getByRole("button", { name: "Home", exact: true });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/$/);
  await expect(page).toHaveTitle("Home · iTrack");
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  app.expectNoErrors();
});

test("survives a cold deep link, and an unknown id falls back to the list", async ({ page, app }) => {
  const name = uniqueName("E2E deep link");
  const { id } = await app.seedCredential({ credentialName: name });
  await app.goto(`/credentials/${id}`);
  await expect(page.locator("h1.push-title")).toHaveText(name);
  await expect(page).toHaveTitle(`${name} · iTrack`);
  await app.goto("/credentials/nope");
  await expect(page).toHaveURL(/\/credentials$/);
  await expect(
    page.getByRole("heading", { name: "Every renewal, one clear place." }),
  ).toBeVisible();
  app.expectNoErrors();
});

test("Add renewal date to calendar hands off an .ics file", async ({ page, app }) => {
  const name = uniqueName("E2E calendar");
  const { id } = await app.seedCredential({ credentialName: name });
  await app.goto(`/credentials/${id}`);
  // A headless browser exposes no navigator.share, so
  // app/lib/calendarInvite.ts:203-229 falls through to the anchor download.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Add renewal date to calendar" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.ics$/);
  await expect(
    page.getByRole("status").filter({ hasText: "Renewal date handed off to your calendar." }),
  ).toBeVisible();
  app.expectNoErrors();
});

test("Log submission opens the submission sheet", async ({ page, app }) => {
  const name = uniqueName("E2E submission");
  await app.seedCredential({ credentialName: name });
  await app.goto("/credentials");
  await page
    .getByRole("region", { name: "Your credentials" })
    .getByRole("button", { name })
    .click();
  await expect(page.locator("h1.push-title")).toHaveText(name);
  await page.getByRole("button", { name: "Log submission", exact: true }).click();
  await expect(app.dialog("Log your submission")).toBeVisible();
  app.expectNoErrors();
});
```

- [ ] **Step 7: Run it on all four projects**

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
npx playwright test tests/e2e/credential-detail.spec.ts
```

Expected: `20 passed` (5 tests × 4 projects). The download assertion is the one to watch on the phone projects: if its browser ever advertises `navigator.share` for files, `offerCalendarInvite` returns `"shared"` without a download and the `waitForEvent("download")` times out — that would be a fixture/browser fact to record in Task 3's config, not a reason to weaken this pin.

- [ ] **Step 8: Create `tests/e2e/log-activity.spec.ts` and remove the file it absorbs**

The first test is the Wave 1 typing regression, moved from `tests/e2e/log-activity-typing.spec.ts` exactly as Task 3 left it (on the fixtures). Copy that test from the file rather than retyping it; on the fixtures it reads as below.

```ts
// Replaces tests/rendered-html.test.mjs subtests: the draft-persistence and calendar pins of "ships the installable phone companion without caching private data" — behaviour those pins encoded is asserted here against the running app. The typing regression below moved here verbatim from tests/e2e/log-activity-typing.spec.ts.
import { expect, freshIdentity, test } from "./fixtures";

// app-ux-01 / architecture-M-01: the second keystroke in any log-activity
// field used to throw inside a deferred state updater and unmount the app.
// Typing two characters into each field, slowly enough for the draft-persist
// effect to schedule its timeouts between keys, is the exact reproduction.
test("typing two characters into every log-activity field does not crash the app", async ({ page, app }) => {
  await app.goto("/");
  const sheet = await app.openLog();

  const title = sheet.locator('input[name="title"]');
  await title.click();
  await title.pressSequentially("Et", { delay: 300 });
  app.expectNoErrors();
  await expect(title).toHaveValue("Et");

  const units = sheet.locator('input[name="totalUnits"]');
  await units.click();
  await units.pressSequentially("12", { delay: 300 });
  app.expectNoErrors();
  await expect(units).toHaveValue("12");

  const allocated = sheet.locator('input[name="allocatedUnits"]');
  await allocated.click();
  await allocated.fill("");
  await allocated.pressSequentially("11", { delay: 300 });
  app.expectNoErrors();
  await expect(allocated).toHaveValue("11");

  const provider = sheet.locator('input[name="provider"]');
  await provider.click();
  await provider.pressSequentially("NB", { delay: 300 });
  app.expectNoErrors();
  await expect(provider).toHaveValue("NB");

  // A date input takes whole values; two fills 300 ms apart hit the same
  // pending-lane path a second keystroke does.
  const completion = sheet.locator('input[name="completionDate"]');
  await completion.fill("2026-01-05");
  await page.waitForTimeout(300);
  await completion.fill("2026-01-06");
  app.expectNoErrors();
  await expect(completion).toHaveValue("2026-01-06");

  await expect(sheet).toBeVisible();
  await expect(page.locator("#main-content")).toBeVisible();
  app.expectNoErrors();
});

test("the completion date defaults to a calendar date", async ({ app }) => {
  // Task 11 sharpens this to the local date under a fixed clock.
  await app.goto("/");
  const sheet = await app.openLog();
  await expect(sheet.locator('input[name="completionDate"]')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  app.expectNoErrors();
});

test.describe("as a new account", () => {
  test.use({ identity: freshIdentity() });

  test("a draft is saved in this browser, survives a reload, and saves as a record", async ({ page, app }) => {
    await app.seedCredential();
    await app.goto("/");
    let sheet = await app.openLog();
    await sheet.locator('input[name="title"]').fill("Draft course");
    // The note flips to "saving" as the draft changes and to "saved" 250 ms
    // later, once localStorage holds it.
    const note = sheet.getByRole("status").filter({ hasText: "in this browser" });
    await expect(note).toContainText("Saving in this browser");
    await expect(note).toContainText("Saved in this browser");

    // A fresh page load in the same browser context keeps localStorage, so
    // the sheet reopens on the draft.
    await app.goto("/");
    sheet = await app.openLog();
    await expect(sheet.locator('input[name="title"]')).toHaveValue("Draft course");
    await expect(
      sheet.getByRole("status").filter({ hasText: "in this browser" }),
    ).toContainText("Saved in this browser");

    await sheet.locator('input[name="totalUnits"]').fill("2");
    // Credits to apply follow the certificate amount until changed by hand.
    await expect(sheet.locator('input[name="allocatedUnits"]')).toHaveValue("2");
    await sheet.locator('input[name="completionDate"]').fill("2026-06-02");
    await sheet.getByRole("button", { name: "Save activity" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Recent learning" }).getByText("Draft course"),
    ).toBeVisible();
    app.expectNoErrors();
  });
});
```

Then remove the file this absorbs (staged as a deletion for the commit in Step 17):

```bash
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
git rm tests/e2e/log-activity-typing.spec.ts
ls tests/e2e
```

Expected: `rm 'tests/e2e/log-activity-typing.spec.ts'`; the listing shows `fixtures.ts`, the new specs, and `session-ended-mid-save.spec.ts` — no `log-activity-typing.spec.ts`.

- [ ] **Step 9: Run it on all four projects**

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
npx playwright test tests/e2e/log-activity.spec.ts
```

Expected: `12 passed` (3 tests × 4 projects). The "Saving in this browser" check runs immediately after `fill` returns and the note keeps that text for 250 ms after the last change, so it is not a race on a normal machine; if it ever reads "Saved" first, the draft-persist delay in `app/ITrackApp.tsx:2381-2384` changed and the spec's comment is what needs updating.

- [ ] **Step 10: Create `tests/e2e/history.spec.ts`**

```ts
// Replaces tests/rendered-html.test.mjs subtests: the History-row pins (the labelled per-row controls and sr-only field labels) of "ships an accessible phone-first weekly-rhythm control" — behaviour those pins encoded is asserted here against the running app.
import { expect, freshIdentity, test } from "./fixtures";

test("History lists the demo record with a labelled Edit control that opens the editor", async ({ page, app }) => {
  await app.goto("/history");
  await expect(page).toHaveTitle("History · iTrack");
  await expect(app.tab("History")).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Your learning, organized as you go." }),
  ).toBeVisible();
  const records = page.getByRole("region", { name: "Completed activities" });
  await expect(records.getByText("Ethics in Digital Practice")).toBeVisible();
  // The row's control names its record, so it is unambiguous read aloud.
  await records.getByRole("button", { name: "Edit Ethics in Digital Practice" }).click();
  const editor = app.dialog("Edit learning record");
  await expect(editor).toBeVisible();
  // Read-only against the demo: close without saving.
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toHaveCount(0);
  app.expectNoErrors();
});

test.describe("as a new account", () => {
  test.use({ identity: freshIdentity() });

  test("archiving a record moves it under Archived records, and Restore brings it back", async ({ page, app }) => {
    const { id: credentialId } = await app.seedCredential();
    await app.seedActivity(credentialId, { title: "E2E archive me" });
    await app.goto("/history");
    const records = page.getByRole("region", { name: "Completed activities" });
    await expect(records.getByText("E2E archive me")).toBeVisible();
    await records.getByRole("button", { name: "Edit E2E archive me" }).click();
    const editor = app.dialog("Edit learning record");
    // Archive is two steps: the trigger swaps for a confirmation that
    // carries the same label.
    await editor.getByRole("button", { name: "Archive record" }).click();
    await expect(editor.getByRole("alert")).toContainText("Archive this learning record?");
    await editor.getByRole("button", { name: "Archive record" }).click();
    await expect(editor).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Learning record archived." }),
    ).toBeVisible();
    await expect(records.getByText("E2E archive me")).toHaveCount(0);
    const archived = page.locator("summary").filter({ hasText: "Archived records" });
    await expect(archived).toBeVisible();
    await archived.click();
    await page.getByRole("button", { name: "Restore E2E archive me" }).click();
    await expect(records.getByText("E2E archive me")).toBeVisible();
    await expect(page.locator("summary").filter({ hasText: "Archived records" })).toHaveCount(0);
    app.expectNoErrors();
  });
});
```

- [ ] **Step 11: Run it on all four projects**

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
npx playwright test tests/e2e/history.spec.ts
```

Expected: `8 passed` (2 tests × 4 projects). `summary` is an element selector, not a class hook: Playwright has no role name for a disclosure summary, and its text is what the user reads.

- [ ] **Step 12: Create `tests/e2e/profile.spec.ts`**

```ts
// Replaces tests/rendered-html.test.mjs subtests: "ships an accessible phone-first weekly-rhythm control" — behaviour those pins encoded is asserted here against the running app.
import { expect, freshIdentity, test } from "./fixtures";

test("Profile names the signed-in person, and the weekly target is a labelled radio group of finger-sized rows", async ({ page, app }) => {
  await app.goto("/profile");
  await expect(page).toHaveTitle("Profile · iTrack");
  await expect(app.tab("Profile")).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Signed in as")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Alex Morgan", exact: true })).toBeVisible();
  const target = page.getByRole("group", { name: "Weekly action target" });
  const radios = target.getByRole("radio");
  await expect(radios).toHaveCount(5);
  for (const label of ["Light", "Steady", "Balanced", "Focused", "Ambitious"]) {
    await expect(target.getByRole("radio", { name: label })).toBeVisible();
  }
  // Each option's whole row is the tap target (≥ 44 px). The retired pin
  // read this off the phone stylesheet; the phone projects are the ones it
  // was about, and the rule holds at every viewport.
  for (const radio of await radios.all()) {
    const row = await radio.locator("..").boundingBox();
    expect(row?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  app.expectNoErrors();
});

test("Manage reminders opens the check-in settings", async ({ page, app }) => {
  await app.goto("/profile");
  await page.getByRole("button", { name: "Manage reminders" }).click();
  await expect(app.dialog("Due-date check-ins")).toBeVisible();
  app.expectNoErrors();
});

test("the local preview has no sign-out control", async ({ page, app }) => {
  await app.goto("/profile");
  await expect(page.getByText("Local preview")).toBeVisible();
  await expect(page.locator('form[method="post"][action="/auth/logout"]')).toHaveCount(0);
  app.expectNoErrors();
});

test.describe("as a signed-in account", () => {
  test.use({ identity: freshIdentity() });

  test("sign out is a POST form to /auth/logout", async ({ page, app }) => {
    await app.goto("/profile");
    const form = page.locator('form[method="post"][action="/auth/logout"]');
    await expect(form).toHaveCount(1);
    await expect(form.getByRole("button", { name: "Sign out" })).toBeVisible();
    // Never submitted here: /auth/logout belongs to the gateway, which
    // `npm run dev` does not run (it would 404).
    app.expectNoErrors();
  });
});
```

- [ ] **Step 13: Run it on all four projects**

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
npx playwright test tests/e2e/profile.spec.ts
```

Expected: `16 passed` (4 tests × 4 projects). The brief's sign-out assertion lives under the fresh identity on purpose: `app/ITrackApp.tsx:9327-9336` renders "Local preview" instead of the form for the demo user (`workspace.user.isDemo`), and a header identity is never the demo.

- [ ] **Step 14: Create `tests/e2e/packet.spec.ts`**

```ts
// Replaces tests/rendered-html.test.mjs subtests: the `appSource` pins of "renders an escaped owner-scoped credential packet with countable progress" — behaviour those pins encoded is asserted here against the running app.
import { expect, freshIdentity, test } from "./fixtures";

test.use({ identity: freshIdentity() });

test("the detail screen links to the packet, which renders for its owner and 404s for anyone else", async ({ page, context, app }) => {
  const name = `E2E packet ${Date.now().toString(36)}`;
  const { id } = await app.seedCredential({ credentialName: name });
  await app.seedActivity(id, { title: "E2E packet course" });
  await app.goto(`/credentials/${id}`);
  const link = page.getByRole("link", { name: "Prepare credential packet" });
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  if (href === null) throw new Error("the packet link has no href");
  expect(href).toBe(`/api/export/packet?credentialId=${encodeURIComponent(id)}`);

  // The owner's packet: a document, not the app.
  const response = await page.goto(href);
  expect(response?.status()).toBe(200);
  await expect(page.locator("h1")).toHaveText(name);
  await expect(page.locator('meta[name="license-lantern-packet-version"]')).toHaveCount(1);
  await expect(page.getByText("E2E packet course")).toBeVisible();

  // A credential the caller does not own is not found — as a page and as JSON.
  const foreign = await page.goto("/api/export/packet?credentialId=not-mine");
  expect(foreign?.status()).toBe(404);
  await expect(page.locator("h1")).toHaveText("Packet unavailable");
  const json = await context.request.get(href.replace(id, "not-mine"), {
    headers: { accept: "application/json" },
  });
  expect(json.status()).toBe(404);
  expect(await json.json()).toEqual({ error: "Credential not found.", code: "credential_not_found" });
  app.expectNoErrors();
});
```

- [ ] **Step 15: Run it on all four projects**

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
npx playwright test tests/e2e/packet.spec.ts
```

Expected: `4 passed` (1 test × 4 projects). `context.request` carries the context's `oai-authenticated-user-email` header (Task 3 sets it with `extraHTTPHeaders`), so the JSON 404 is an owner-scoped miss, not an unauthenticated one.

- [ ] **Step 16: Gate — typecheck, lint, the whole e2e suite on all four projects, then `npm test`**

With the dev server still up:

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
npm run typecheck && npm run lint
npx playwright test --list | tail -1
npm run test:e2e
grep -L "^// Replaces tests/rendered-html.test.mjs subtests:" tests/e2e/*.spec.ts
```

Expected: typecheck and lint silent (the specs are typechecked by `tsc --noEmit` and linted by `eslint .`); the listing ends `Total: 96 tests in 8 files` (home 4, credentials 3, credential-detail 5, log-activity 3, history 2, profile 4, packet 1, session-ended-mid-save 2 = 24 per project × 4); `npm run test:e2e` → `96 passed`; the `grep -L` prints only `tests/e2e/session-ended-mid-save.spec.ts` (the one spec that replaces no pins — every new file starts with the header comment Task 5 cites).

Then stop the dev server (Ctrl-C in its terminal — it shares `.wrangler/` with the build) and run the wave's every-commit gate; nothing this task touched feeds it, so it is unchanged from Task 3:

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
npm test
```

Expected: PASS.

- [ ] **Step 17: Commit**

```bash
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
git branch --show-current
git add tests/e2e/home.spec.ts tests/e2e/credentials.spec.ts tests/e2e/credential-detail.spec.ts tests/e2e/log-activity.spec.ts tests/e2e/history.spec.ts tests/e2e/profile.spec.ts tests/e2e/packet.spec.ts
git status --short tests/e2e
git commit -m "test(e2e): per-screen behavioural specs (home, credentials, detail, log activity, history, profile, packet)

Seven Playwright specs on the Task 3 fixtures, one per screen, asserting
rendered behaviour (roles, names, URLs, downloads, HTTP status) against
the running app on all four projects. Each file's header names the
tests/rendered-html.test.mjs subtests it replaces; Task 5 deletes those
pins and cites these files. The Wave 1 typing regression moves verbatim
into log-activity.spec.ts and log-activity-typing.spec.ts is removed.
Read-only specs run as the demo identity; anything that saves uses a
fresh header identity seeded through /api/workspace, so the demo
workspace is never written to.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

Expected: `feat/wave2-foundation`; the status shows seven `A` lines and `D  tests/e2e/log-activity-typing.spec.ts` (staged by `git rm` in Step 8); one commit with eight file changes.

---

### Task 5: Retire the 196 client/styles/layout/built-chunk pins; unit tests for the pure modules they encoded; no-source-read guard

**Rationale:** spec §4 bullet 1 (the 165 source-regex assertions and ~130 iOS-markup pins go; pure modules get unit tests) and §9 "Unit"; findings architecture-03 (source-text pins break on every refactor and catch no regression) and ios-coupling-15 (delete pins, never re-point a regex). At `8ac172a` `tests/rendered-html.test.mjs` (27,741 lines, one outer `test("iTrack product contract")` with 107 `t.test` subtests) holds 196 assertions whose subject is the *text* of `app/ITrackApp.tsx`, `app/globals.css`, `app/layout.tsx` or the built `dist/**/ITrackApp-*.js` chunk — `grep -cE 'clientSource|stylesSource|appSource|layoutSource|builtClientSource|phoneStyles|ITrackApp-'` reports 205 matching lines. Six subtests are 100 % pins and go whole; eleven mix pins with `fetchWorker`/rendered-HTML/db-calls assertions and are trimmed assertion-by-assertion. Task 4's seven Playwright specs already prove the screen behaviour those pins encoded; the three pure modules the pins reached into (`certificateOcr`, `activityDraft`, `readiness`) get real unit tests against tsc output, exactly like `tests/navigation.test.mjs` does today. A new guard in `tests/app-source-guards.test.mjs` makes the pattern unable to return.

Two details in the task brief do not match the source and are corrected below: `activityDraftStorageKey("draft_abc")` **throws** (`app/lib/activityDraft.ts:19,45` — a namespace is `draft_` + 64 hex characters), and `readinessScore` for a zero-hour credential with no tasks done is **60, not 0**, unless it also has an unmet minimum (`app/lib/readiness.ts:116` treats `requirementCount === 0` as fully met). The tests below pin what the code does.

**Files:**
- Modify: `tests/rendered-html.test.mjs` — delete whole subtests at `8ac172a` lines 684-751, 753-814, 816-925, 927-1040, 1042-1068, 9204-9311, 13371-13443; delete the client-source asserts and their `readFile` bindings inside the mixed subtests 1070-1191, 1193-1873, 1875-2282, 2284-3287, 4149-4693, 6662-6969, 7517-7823, 10985-11317, 21011-21933, 24287-24873; delete `readBuiltClientAppSource` (580-594) and the stale `dist/server/ssr/assets/ITrackApp-BvrpzBXC.js` read with its `readdir` fallback (1089-1110); drop the now-unused `readdir` import (line 2)
- Create: `tests/certificate-ocr.test.mjs`, `tests/activity-draft.test.mjs`, `tests/readiness.test.mjs`
- Modify: `package.json` (`build:lib-test`, `build:nav-test` alias, `test`)
- Modify: `tests/app-source-guards.test.mjs` (append the guard)
- Modify: `docs/DESIGN-SYSTEM.md:187-193` (the `## Tests` paragraph; the brief's 185-192 is off by two)
- Test: `tests/certificate-ocr.test.mjs`, `tests/activity-draft.test.mjs`, `tests/readiness.test.mjs`, `tests/app-source-guards.test.mjs`, `npm test`

**Interfaces:**
- Consumes: Task 4's specs `tests/e2e/home.spec.ts`, `credentials.spec.ts`, `credential-detail.spec.ts`, `log-activity.spec.ts`, `history.spec.ts`, `profile.spec.ts`, `packet.spec.ts` (named in the commit as the replacements; nothing is imported from them). The existing `.test-build` pattern: `tests/navigation.test.mjs:14-22` imports `../.test-build/navigation.js` emitted by the `tsc … --outDir .test-build --module nodenext --target es2022` script. `app/lib/readiness.ts` and `app/lib/activityDraft.ts` have no imports; `app/lib/certificateOcr.ts` only does `await import("tesseract.js")` inside `scanCertificateImage` (`certificateOcr.ts:285`), so `extractCertificateSuggestions` (`:194`) compiles and runs under node (verified: `tsc` of all seven files emits a flat `.test-build/` and `node` imports `certificateOcr.js` cleanly).
- Produces: `"build:lib-test": "tsc app/lib/navigation.ts app/lib/clientError.ts app/lib/apiResponse.ts app/lib/routeTitle.ts app/lib/readiness.ts app/lib/activityDraft.ts app/lib/certificateOcr.ts --outDir .test-build --module nodenext --target es2022"`, `"build:nav-test": "npm run build:lib-test"`, `"test": "npm run build && npm run build:lib-test && node --experimental-sqlite --test tests/*.test.mjs"`. Tasks 11 and 12 append `app/lib/dates.ts` and `app/lib/cycles.ts` to `build:lib-test`. `.test-build` stays flat because every input lives in `app/lib` (tsc infers `rootDir` from the common directory of the inputs; a file from another directory would nest the output and break the four existing `../.test-build/<name>.js` imports). `tests/app-source-guards.test.mjs` gains `test("no test file reads client source text (architecture-03)")`, which walks every `tests/*.test.mjs` except itself and `tests/protected-identifiers.test.mjs` (the two generic walkers the Global Constraints exempt) and fails if any `../app/ITrackApp.tsx`, `../app/globals.css`, `../app/layout.tsx` or `ITrackApp-` text appears in one of them. What stays in `rendered-html` this wave (recorded for Wave 3): the `public/sw.js` pins (`workerSource` 7619-7656, `serviceWorkerSource` 21792-21801), `pushDeliverySource`, `wranglerSource`, `manifestSource` (`app/manifest.ts` is keep-list PWA config), `ocrSource` (the on-device asset-path pins at 1124-1130), and every server-source pin (`runtimeSource`, `workspaceRouteSource`, `routeSource`, `categorySource`, `modelSource`, `schemaSource`, catalog sources).

- [ ] **Step 1: Write the failing guard**

Task 1 removed the `node:fs` import from `tests/app-source-guards.test.mjs` when it moved the walker into `tests/helpers/clientSources.mjs` (its Step 7 leaves exactly four imports, none from `node:fs`). Add `import { readdirSync, readFileSync } from "node:fs";` directly after `import assert from "node:assert/strict";`, then append this guard at the end of the file. It walks every `tests/*.test.mjs` rather than one named file, so the Global Constraint ("after Task 5 no file under `tests/` may read client source as text … and `tests/app-source-guards.test.mjs` enforces that") holds for Task 8's, Task 12's and any future test file, not only for `rendered-html`:

```js
// Screen behaviour lives in tests/e2e/, pure modules in tests/*.test.mjs
// against .test-build/. No test file may read the client's component or
// stylesheet source, or the built client chunk, as text: those pins broke on
// every refactor without catching a regression (architecture-03), and Wave 2
// retired all 196 of them. Every tests/*.test.mjs is walked except the two
// generic walkers (this file and tests/protected-identifiers.test.mjs), so
// the pattern cannot come back in a new file either.
test("no test file reads client source text (architecture-03)", () => {
  let scanned = 0;
  for (const name of readdirSync(new URL("./", import.meta.url))) {
    if (
      !/\.test\.mjs$/.test(name) ||
      name === "app-source-guards.test.mjs" ||
      name === "protected-identifiers.test.mjs"
    ) {
      continue;
    }
    scanned += 1;
    const suite = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      suite,
      /\.\.\/app\/(ITrackApp\.tsx|globals\.css|layout\.tsx)/,
      `${name}: a readFile of a client source file is back — prove the behaviour in tests/e2e/ or a unit test instead`,
    );
    assert.doesNotMatch(
      suite,
      /ITrackApp-/,
      `${name}: must not read the built ITrackApp-*.js chunk`,
    );
  }
  assert.ok(scanned > 0, "scanned the test files");
});
```

- [ ] **Step 2: Run the guard to see it fail**

Run:

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
node --test tests/app-source-guards.test.mjs
```

Expected: the new test FAILS with `rendered-html.test.mjs: a readFile of a client source file is back — prove the behaviour in tests/e2e/ or a unit test instead` (that suite still reads `../app/ITrackApp.tsx` in 17 places; every other `tests/*.test.mjs` the walk reaches is already clean — at `8ac172a` `grep -lE '\.\./app/(ITrackApp\.tsx|globals\.css|layout\.tsx)|ITrackApp-' tests/*.test.mjs` names only `rendered-html`); every other guard in the file still passes.

- [ ] **Step 3: Write the three failing unit tests**

Create `tests/certificate-ocr.test.mjs` — the two cases are the ones at `tests/rendered-html.test.mjs:1158-1189` verbatim, plus an empty-input case:

```js
// The certificate reader's field extraction is pure — OCR text in, field
// suggestions out — so it is tested here against the tsc output rather than
// through the built worker. `npm run build:lib-test` compiles
// app/lib/certificateOcr.ts into .test-build/; the tesseract.js import only
// happens inside scanCertificateImage, which this suite never calls.
import assert from "node:assert/strict";
import test from "node:test";

import { extractCertificateSuggestions } from "../.test-build/certificateOcr.js";

test("extractCertificateSuggestions reads labelled certificate lines", () => {
  assert.deepEqual(
    extractCertificateSuggestions(
      [
        "Course Title: Trauma-Informed Practice",
        "Provider: State Medical Society",
        "Completion Date: July 24, 2026",
        "3.5 CME credits",
      ].join("\n"),
    ),
    {
      title: "Trauma-Informed Practice",
      provider: "State Medical Society",
      completionDate: "2026-07-24",
      credits: 3.5,
    },
  );
});

test("extractCertificateSuggestions accepts alternative labels and numeric dates", () => {
  assert.deepEqual(
    extractCertificateSuggestions(
      [
        "Program: Patient Safety Essentials",
        "Issued by: Clinical Learning Institute",
        "Completed on: 7/22/2026",
        "CEUs: 2",
      ].join("\n"),
    ),
    {
      title: "Patient Safety Essentials",
      provider: "Clinical Learning Institute",
      completionDate: "2026-07-22",
      credits: 2,
    },
  );
});

test("extractCertificateSuggestions suggests nothing for empty text", () => {
  assert.deepEqual(extractCertificateSuggestions(""), {});
  assert.deepEqual(extractCertificateSuggestions("\n   \n"), {});
});
```

Create `tests/activity-draft.test.mjs` (signatures from `app/lib/activityDraft.ts:38-57, 101-181`: `serializeActivityDraft(value, savedAt = new Date())`, `parseActivityDraft(serialized, now = new Date())`, `activityDraftShouldBePurged(serialized, now = new Date())` — the round-trip passes the same `now` to both sides, otherwise a fixed `savedAt` in the past is older than the 30-day TTL by the time the test runs):

```js
// The log-activity sheet's browser draft is a pure module: storage keys,
// the "is there anything worth keeping" test, and a serialize/parse pair
// with a 30-day TTL. `npm run build:lib-test` compiles
// app/lib/activityDraft.ts into .test-build/ and this suite imports the
// emitted ESM. The e2e proof that the sheet actually saves and restores a
// draft lives in tests/e2e/log-activity.spec.ts.
import assert from "node:assert/strict";
import test from "node:test";

import {
  activityDraftShouldBePurged,
  activityDraftStorageKey,
  hasMeaningfulActivityDraft,
  legacyActivityDraftStorageKey,
  parseActivityDraft,
  serializeActivityDraft,
} from "../.test-build/activityDraft.js";

// A namespace is `draft_` + 64 hex characters (the server derives it from the
// user id); anything else is refused rather than silently keyed.
const NAMESPACE = `draft_${"ab".repeat(32)}`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-02T15:00:00.000Z");
const INPUT = {
  credentialId: "cred-1",
  title: "Ethics",
  provider: "Board",
  completionDate: "2026-06-02",
  totalUnits: "2",
  allocatedUnits: "1.5",
};

test("activityDraftStorageKey keeps the load-bearing license-lantern prefix and rejects a malformed namespace", () => {
  assert.equal(
    activityDraftStorageKey(NAMESPACE),
    `license-lantern:activity-draft:v1:${NAMESPACE}`,
  );
  assert.throws(() => activityDraftStorageKey("draft_abc"), /namespace is invalid/);
});

test("legacyActivityDraftStorageKey is a stable fingerprint of the email under the same prefix", () => {
  const key = legacyActivityDraftStorageKey("casey@example.com");
  assert.match(key, /^license-lantern:activity-draft:v1:[0-9a-f]+$/);
  assert.equal(legacyActivityDraftStorageKey("casey@example.com"), key, "stable across calls");
  assert.equal(legacyActivityDraftStorageKey("  Casey@Example.com "), key, "trimmed and lowercased first");
  assert.notEqual(legacyActivityDraftStorageKey("other@example.com"), key);
});

test("hasMeaningfulActivityDraft ignores the date and needs a title, units, or provider", () => {
  const empty = { title: "", completionDate: "2026-06-02", totalUnits: "", allocatedUnits: "", provider: "" };
  assert.equal(hasMeaningfulActivityDraft(empty), false);
  assert.equal(hasMeaningfulActivityDraft({ ...empty, title: "Ethics" }), true);
  assert.equal(hasMeaningfulActivityDraft({ ...empty, totalUnits: "2" }), true);
  assert.equal(hasMeaningfulActivityDraft({ ...empty, provider: "Board" }), true);
  assert.equal(hasMeaningfulActivityDraft({ ...empty, title: "   " }), false, "whitespace is not a title");
});

test("serializeActivityDraft and parseActivityDraft round-trip every field", () => {
  const parsed = parseActivityDraft(serializeActivityDraft(INPUT, NOW), NOW);
  assert.deepEqual(parsed, { version: 1, savedAt: NOW.toISOString(), ...INPUT });
});

test("parseActivityDraft rejects malformed, empty, or stale drafts", () => {
  const saved = serializeActivityDraft(INPUT, NOW);
  assert.equal(parseActivityDraft(null, NOW), null);
  assert.equal(parseActivityDraft("not json", NOW), null);
  assert.equal(
    parseActivityDraft(JSON.stringify({ version: 2, savedAt: NOW.toISOString(), title: "Ethics" }), NOW),
    null,
    "unknown version",
  );
  assert.equal(
    parseActivityDraft(serializeActivityDraft({ ...INPUT, title: "", provider: "", totalUnits: "" }, NOW), NOW),
    null,
    "a draft with nothing worth keeping is not restored",
  );
  assert.equal(parseActivityDraft(saved, new Date(NOW.getTime() + 31 * DAY)), null, "older than 30 days");
  assert.notEqual(parseActivityDraft(saved, new Date(NOW.getTime() + 29 * DAY)), null, "29 days is still recoverable");
  assert.equal(
    parseActivityDraft(saved, new Date(NOW.getTime() - 6 * 60 * 1000)),
    null,
    "a savedAt more than five minutes ahead of the clock is not trusted",
  );
});

test("activityDraftShouldBePurged is true only for a stored draft that no longer parses", () => {
  const saved = serializeActivityDraft(INPUT, NOW);
  assert.equal(activityDraftShouldBePurged(saved, new Date(NOW.getTime() + 31 * DAY)), true);
  assert.equal(activityDraftShouldBePurged(saved, new Date(NOW.getTime() + 29 * DAY)), false);
  assert.equal(activityDraftShouldBePurged(null, NOW), false, "nothing stored, nothing to purge");
  assert.equal(activityDraftShouldBePurged("garbage", NOW), true);
});
```

Create `tests/readiness.test.mjs` (`daysUntilDate(value, nowMs)` at `app/lib/readiness.ts:44-47` counts to the *local* end of the deadline day; `credentialProgress` `:92-97`; `readinessScore` `:99-133` with the 60/40 zero-hour split at `:122-124` and the 70/15/15 split at `:125-129`):

```js
// The hero's three numbers (days left, credit progress, readiness ring) are
// pure functions in app/lib/readiness.ts. `npm run build:lib-test` compiles
// them into .test-build/ and this suite imports the emitted ESM.
import assert from "node:assert/strict";
import test from "node:test";

import {
  clampPercent,
  credentialProgress,
  daysUntilDate,
  readinessScore,
} from "../.test-build/readiness.js";

// `Date.parse` of an ISO string without a zone is local time — the same clock
// the browser hands `daysUntilDate` through `Date.now()` — so these cases hold
// whatever zone the test runner starts in.
test("daysUntilDate counts to the local end of the deadline day", () => {
  assert.equal(daysUntilDate("2026-09-10", Date.parse("2026-09-10T20:00:00")), 1, "due today reads 1, not 0");
  assert.equal(daysUntilDate("2026-09-10", Date.parse("2026-09-10T00:00:00")), 1);
  assert.equal(daysUntilDate("2026-09-11", Date.parse("2026-09-10T20:00:00")), 2);
  assert.ok(daysUntilDate("2026-09-08", Date.parse("2026-09-10T08:00:00")) < 0, "two days back is overdue");
  assert.equal(daysUntilDate("2026-09-08", Date.parse("2026-09-10T08:00:00")), -1);
  assert.equal(
    daysUntilDate("2026-09-08T00:00:00.000Z", Date.parse("2026-09-10T08:00:00")),
    -1,
    "only the date part of a timestamp is read",
  );
});

test("credentialProgress is a clamped whole percentage and 100 for a zero-hour credential", () => {
  const base = { requirements: [], tasks: [] };
  assert.equal(credentialProgress({ ...base, totalRequired: 10, totalEarned: 2.5 }), 25);
  assert.equal(credentialProgress({ ...base, totalRequired: 3, totalEarned: 1 }), 33);
  assert.equal(credentialProgress({ ...base, totalRequired: 10, totalEarned: 14 }), 100, "over-earned caps at 100");
  assert.equal(credentialProgress({ ...base, totalRequired: 0, totalEarned: 0 }), 100, "no numeric total means nothing left to earn");
  assert.equal(clampPercent(-4), 0);
  assert.equal(clampPercent(140.4), 100);
});

test("readinessScore splits a zero-hour credential 60/40 between requirements and tasks", () => {
  const met = { requiredUnits: 1, kind: "minimum", earnedUnits: 1 };
  const unmet = { requiredUnits: 1, kind: "minimum", earnedUnits: 0 };
  const done = { status: "completed" };
  const pending = { status: "pending" };
  const zeroHour = (requirements, tasks) => ({ totalRequired: 0, totalEarned: 0, requirements, tasks });
  assert.equal(readinessScore(zeroHour([met], [done, done])), 100);
  assert.equal(readinessScore(zeroHour([unmet], [pending, pending])), 0);
  assert.equal(readinessScore(zeroHour([met], [pending, pending])), 60);
  assert.equal(readinessScore(zeroHour([unmet], [done, done])), 40);
  assert.equal(readinessScore(zeroHour([], [pending])), 60, "with no requirements the requirement share counts as met");
  assert.equal(readinessScore(zeroHour([unmet], [])), 40, "with no tasks the task share counts as met");
});

test("readinessScore weights an hour-based credential 70/15/15 and holds at 99 while credits are unclassified", () => {
  const credential = {
    totalRequired: 10,
    totalEarned: 10,
    requirements: [{ requiredUnits: 10, kind: "minimum", earnedUnits: 10 }],
    tasks: [{ status: "completed" }],
  };
  assert.equal(readinessScore(credential), 100);
  assert.equal(readinessScore({ ...credential, classificationIssues: [{ id: "x" }] }), 99);
  assert.equal(
    readinessScore({
      ...credential,
      totalEarned: 5,
      requirements: [{ requiredUnits: 10, kind: "minimum", earnedUnits: 5 }],
      tasks: [{ status: "pending" }],
    }),
    35,
  );
  assert.equal(
    readinessScore({ ...credential, requirements: [{ requiredUnits: 10, kind: "minimum", earnedUnits: 10, applicabilityStatus: "needs_confirmation" }] }),
    85,
    "an unresolved conditional counts as an unmet requirement",
  );
});
```

- [ ] **Step 4: Run the unit tests to see them fail**

Run:

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
npm run build:nav-test && node --experimental-sqlite --test tests/certificate-ocr.test.mjs tests/activity-draft.test.mjs tests/readiness.test.mjs
```

Expected: `build:nav-test` still emits only the four existing files, then each of the three files FAILS to load with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/.test-build/certificateOcr.js'` (and `activityDraft.js`, `readiness.js`), `# pass 0`, `# fail 3`.

- [ ] **Step 5: Rename the tsc script to `build:lib-test` and add the three modules**

In `package.json` the `scripts` block currently reads (lines 12-14 at `8ac172a`; Task 3 added `test:e2e:desktop`/`test:e2e:phone` below, so match on text, not line numbers):

```json
    "test": "npm run build && npm run build:nav-test && node --experimental-sqlite --test tests/*.test.mjs",
    "build:nav-test": "tsc app/lib/navigation.ts app/lib/clientError.ts app/lib/apiResponse.ts app/lib/routeTitle.ts --outDir .test-build --module nodenext --target es2022",
    "test:nav": "npm run build:nav-test && node --test tests/navigation.test.mjs",
```

Replace those three lines with:

```json
    "test": "npm run build && npm run build:lib-test && node --experimental-sqlite --test tests/*.test.mjs",
    "build:lib-test": "tsc app/lib/navigation.ts app/lib/clientError.ts app/lib/apiResponse.ts app/lib/routeTitle.ts app/lib/readiness.ts app/lib/activityDraft.ts app/lib/certificateOcr.ts --outDir .test-build --module nodenext --target es2022",
    "build:nav-test": "npm run build:lib-test",
    "test:nav": "npm run build:nav-test && node --test tests/navigation.test.mjs",
```

`test:nav` is unchanged and keeps working through the alias. Every input stays under `app/lib` so the emitted files stay flat (`.test-build/readiness.js`, not `.test-build/app/lib/readiness.js`).

- [ ] **Step 6: Run the unit tests to see them pass**

Run:

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
npm run build:lib-test && ls .test-build && node --experimental-sqlite --test tests/certificate-ocr.test.mjs tests/activity-draft.test.mjs tests/readiness.test.mjs tests/navigation.test.mjs tests/route-title.test.mjs tests/client-error.test.mjs tests/api-response.test.mjs
```

Expected: `tsc` exits 0 with no diagnostics; `ls` prints exactly `activityDraft.js apiResponse.js certificateOcr.js clientError.js navigation.js readiness.js routeTitle.js`; the three new files report 13 passing tests (3 + 6 + 4) and the four existing `.test-build` suites still pass. Also run `npm run build:nav-test` once to confirm the alias resolves.

- [ ] **Step 7: Retire the pins in `tests/rendered-html.test.mjs`**

Every edit is anchored on exact text (not a line number, so Task 2's edit at 21230-21245 does not disturb it), and every block removal is length- and end-checked so a drifted file fails loudly instead of deleting the wrong lines. Whole subtests are removed from their `await t.test(` line through the blank line before the next subtest; inside mixed subtests only the asserts whose subject is `clientSource` / `appSource` / `stylesSource` / `styles` / `phoneStyles` / `layoutSource` / `builtClientSource` / the loop variable `source`, their `readFile` bindings, and the helpers nothing else uses are removed. No regex is edited.

Run from the repo root:

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
node --input-type=module - <<'EOF'
// Retires every source-text pin over app/ITrackApp.tsx, app/globals.css,
// app/layout.tsx and the built ITrackApp-*.js chunk in
// tests/rendered-html.test.mjs (architecture-03, ios-coupling-15). Whole
// subtests go whole; inside mixed subtests only the client-source asserts,
// their readFile bindings, and the helpers nothing else uses are removed.
import { readFileSync, writeFileSync } from "node:fs";

const file = "tests/rendered-html.test.mjs";
const lines = readFileSync(file, "utf8").split("\n");
const before = lines.length;

const isSubtestOpener = (line) =>
  line === "  await t.test(" || line.startsWith('  await t.test("');

function find(needle, from = 0, exact = false) {
  for (let i = from; i < lines.length; i += 1) {
    if (exact ? lines[i] === needle : lines[i].includes(needle)) return i;
  }
  throw new Error(`not found: ${JSON.stringify(needle)}`);
}

function scope(title) {
  const hits = lines.filter((line) => line.includes(title)).length;
  if (hits !== 1) throw new Error(`subtest title is not unique (${hits}): ${title}`);
  return find(title);
}

// A whole subtest: from its `await t.test(` line up to (not including) the
// next subtest's opener, blank separator included.
function deleteSubtest(title) {
  const titleAt = scope(title);
  const start = isSubtestOpener(lines[titleAt]) ? titleAt : titleAt - 1;
  if (!isSubtestOpener(lines[start])) throw new Error(`no opener above: ${title}`);
  let end = start + 1;
  while (end < lines.length && !isSubtestOpener(lines[end])) end += 1;
  if (lines[end - 1] !== "") throw new Error(`no blank line before the next subtest after: ${title}`);
  lines.splice(start, end - start);
}

// `n` lines starting `before` lines above the first line at/after the
// subtest `within` that contains (or, with exact, equals) `anchor`.
function deleteBlock({ within, anchor, exact = false, before = 0, n, end }) {
  const start = find(anchor, within ? scope(within) : 0, exact) - before;
  const last = lines[start + n - 1];
  const endOk = end === undefined || (end === "" ? last === "" : last.includes(end));
  if (!endOk) {
    throw new Error(`block at ${JSON.stringify(anchor)} does not end with ${JSON.stringify(end)}: ${JSON.stringify(last)}`);
  }
  lines.splice(start, n);
}

function replaceLine({ within, match, replacement }) {
  lines[find(match, within ? scope(within) : 0, true)] = replacement;
}

// 1. The six all-pin subtests, plus "removes the disposable starter preview",
//    whose only content is source-residue pins (page.tsx / layout.tsx /
//    package.json reads) and which would otherwise keep a layout.tsx read.
for (const title of [
  "pushes credential detail onto the navigation stack",
  "leaves no history entry the user cannot get out of",
  "slides screens in and out and follows the back gesture",
  "answers touch the way the platform does",
  "removes the disposable starter preview",
  "ships an accessible phone-first weekly-rhythm control",
  "keeps the larger template chooser and alternative tags mobile-accessible",
]) {
  deleteSubtest(title);
}

// 2. Harness: the built-chunk reader and the `readdir` import only it and the
//    deleted blocks used.
replaceLine({
  match: 'import { readFile, readdir, stat } from "node:fs/promises";',
  replacement: 'import { readFile, stat } from "node:fs/promises";',
});
deleteBlock({ anchor: "async function readBuiltClientAppSource() {", n: 15, end: "" });

// 3. OCR subtest: keep the tesseract versions, the certificateOcr.ts asset-path
//    pins and the asset-size loop; drop the client/built-chunk copy pins, the
//    stale SSR-chunk read, and the extraction cases (moved to
//    tests/certificate-ocr.test.mjs).
const OCR = "keeps certificate OCR on-device and suggestions reviewable";
deleteBlock({ within: OCR, anchor: "        clientSource,", exact: true, n: 1 });
deleteBlock({ within: OCR, anchor: "        builtClientSource,", exact: true, n: 1 });
deleteBlock({ within: OCR, anchor: "        typescript,", exact: true, n: 1 });
deleteBlock({ within: OCR, anchor: 'new URL("../app/ITrackApp.tsx", import.meta.url),', before: 1, n: 4, end: "        )," });
deleteBlock({ within: OCR, anchor: "ITrackApp-BvrpzBXC.js", before: 2, n: 22, end: "        })," });
deleteBlock({ within: OCR, anchor: '        import("typescript"),', exact: true, n: 1 });
deleteBlock({ within: OCR, anchor: 'assert.match(clientSource, /capture="environment"/);', n: 7, end: "      );" });
deleteBlock({ within: OCR, anchor: "assert.match(builtClientSource, /Start with the certificate/);", n: 1 });
deleteBlock({ within: OCR, anchor: "const compiled = typescript.default.transpileModule(ocrSource, {", before: 1, n: 42, end: "      );" });

// 4. Catalog-seed subtests: the stray clientSource pins and their bindings.
const EMS = "seeds source-linked EMS, educator, and mental-health templates";
replaceLine({ within: EMS, match: "      const [runtimeSource, workspaceRouteSource, clientSource] =", replacement: "      const [runtimeSource, workspaceRouteSource] =" });
deleteBlock({ within: EMS, anchor: 'new URL("../app/ITrackApp.tsx", import.meta.url),', before: 1, n: 4, end: "          )," });
deleteBlock({ within: EMS, anchor: "/isFloridaMentalHealthPhaseCredential[", before: 2, n: 4, end: "      );" });

const PHARMACY = "seeds six source-linked pharmacist renewals";
deleteBlock({ within: PHARMACY, anchor: "        clientSource,", exact: true, n: 1 });
deleteBlock({ within: PHARMACY, anchor: 'new URL("../app/ITrackApp.tsx", import.meta.url),', before: 1, n: 4, end: "        )," });
deleteBlock({ within: PHARMACY, anchor: "/isManagedPharmacistCredential[", before: 2, n: 4, end: "      );" });

const REHAB = "seeds source-linked CRC and ABVE certifications";
replaceLine({ within: REHAB, match: "      const [runtimeSource, rehabilitationSource, routeSource, clientSource] =", replacement: "      const [runtimeSource, rehabilitationSource, routeSource] =" });
deleteBlock({ within: REHAB, anchor: 'new URL("../app/ITrackApp.tsx", import.meta.url),', before: 1, n: 4, end: "          )," });
deleteBlock({ within: REHAB, anchor: "/isRehabilitationCertificationCatalogRule[", before: 2, n: 4, end: "        );" });

const NURSING = "seeds twelve source-linked state-board nursing renewals";
deleteBlock({ within: NURSING, anchor: "        clientSource,", exact: true, n: 1 });
deleteBlock({ within: NURSING, anchor: 'new URL("../app/ITrackApp.tsx", import.meta.url),', before: 1, n: 4, end: "        )," });
deleteBlock({ within: NURSING, anchor: "Mandated training is tracked in conditions and the checklist/", before: 2, n: 4, end: "      );" });
deleteBlock({ within: NURSING, anchor: "// Same copy, same branches", before: 2, n: 7, end: "      );" });
deleteBlock({ within: NURSING, anchor: '=== "informational"[', before: 2, n: 4, end: "      );" });
deleteBlock({ within: NURSING, anchor: '"Training and checklist"[', before: 2, n: 4, end: "      );" });
deleteBlock({ within: NURSING, anchor: "I confirmed the next period is a standard full-cycle[", before: 2, n: 4, end: "      );" });
deleteBlock({ within: NURSING, anchor: "May overlap another selected requirement/", before: 2, n: 4, end: "      );" });

const COMPAT = "replaces incompatible requirement tags without blocking valid overlays";
replaceLine({ within: COMPAT, match: "      const [compatibilitySource, clientSource] = await Promise.all([", replacement: "      const [compatibilitySource] = await Promise.all([" });
deleteBlock({ within: COMPAT, anchor: 'new URL("../app/ITrackApp.tsx", import.meta.url),', before: 1, n: 4, end: "        )," });
deleteBlock({ within: COMPAT, anchor: "/nextRequirementSelection", before: 2, n: 8, end: "      );" });

const CYBER = "seeds current cyber and insurance templates";
replaceLine({ within: CYBER, match: "      const [runtimeSource, workspaceRouteSource, clientSource] =", replacement: "      const [runtimeSource, workspaceRouteSource] =" });
deleteBlock({ within: CYBER, anchor: 'new URL("../app/ITrackApp.tsx", import.meta.url),', before: 1, n: 4, end: "          )," });
deleteBlock({ within: CYBER, anchor: "Awaiting ISC2 renewal/,", before: 2, n: 4, end: "      );" });
deleteBlock({ within: CYBER, anchor: "Start next period/,", before: 2, n: 4, end: "      );" });

// 5. Phone companion: keep the manifest/icon/sw/offline/_headers equality and
//    the public/sw.js pins; drop layout/client/built/styles bindings, the
//    three layoutSource pins, and the 164-line copy/draft/safe-area block.
const PHONE = "ships the installable phone companion without caching private data";
for (const binding of ["        layoutSource,", "        clientSource,", "        builtClientSource,", "        stylesSource,"]) {
  deleteBlock({ within: PHONE, anchor: binding, exact: true, n: 1 });
}
deleteBlock({ within: PHONE, anchor: '        readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),', exact: true, n: 1 });
deleteBlock({ within: PHONE, anchor: 'new URL("../app/ITrackApp.tsx", import.meta.url),', before: 1, n: 4, end: "        )," });
deleteBlock({ within: PHONE, anchor: "        readBuiltClientAppSource(),", exact: true, n: 1 });
deleteBlock({ within: PHONE, anchor: '        readFile(new URL("../app/globals.css", import.meta.url), "utf8"),', exact: true, n: 1 });
deleteBlock({ within: PHONE, anchor: "for (const [fileName, expectedDimensions] of [", before: 4, n: 3, end: "viewportFit" });
deleteBlock({ within: PHONE, anchor: "for (const source of [clientSource, builtClientSource]) {", before: 1, n: 165, end: "      );" });

// 6. Push subtest: the client binding, its read, and the four clientSource pins
//    (the sw.js, pushDelivery.ts and wrangler.json pins stay this wave).
const PUSH = "owns, schedules, deduplicates, retries, and expires private phone alerts";
deleteBlock({ within: PUSH, anchor: "        clientSource,", exact: true, n: 1 });
deleteBlock({ within: PUSH, anchor: 'new URL("../app/ITrackApp.tsx", import.meta.url),', before: 1, n: 4, end: "          )," });
deleteBlock({ within: PUSH, anchor: "assert.match(clientSource, /handleEnablePhoneAlerts/);", n: 13, end: "      );" });

// 7. Packet subtest: the appSource read, its three pins and the gap-order slice.
const PACKET = "renders an escaped owner-scoped credential packet with countable progress";
deleteBlock({ within: PACKET, anchor: "      const appSource = await readFile(", exact: true, n: 22, end: "      );" });

writeFileSync(file, lines.join("\n"));
const leftovers = lines.join("\n").match(/clientSource|stylesSource|appSource|layoutSource|builtClientSource|phoneStyles|ITrackApp-/g) ?? [];
console.log(`${file}: ${before} -> ${lines.length} lines (${before - lines.length} removed); leftover pin subjects: ${leftovers.length}`);
if (leftovers.length > 0) process.exit(1);
EOF
```

Expected output: `tests/rendered-html.test.mjs: 27741 -> 26777 lines (964 removed); leftover pin subjects: 0`. If the script throws `not found` / `does not end with`, the file has drifted from `8ac172a` in that block: fix the anchor against `grep -n`, do not delete by hand.

What the script removes, with the lines at `8ac172a` for review:

| Region | Lines (`8ac172a`) | First line → last line removed | Pinned | Now proven by |
|---|---|---|---|---|
| Whole subtest "pushes credential detail onto the navigation stack" | 684-752 | `  await t.test("pushes credential detail onto the navigation stack", async () => {` → blank | 15 pins: `nav.push`, screen-stack classes, deep-link fallback, popstate mirroring, `indexOf` ordering (724-732), `.push-header/.push-back/.push-title` | `tests/e2e/credential-detail.spec.ts` |
| Whole subtest "leaves no history entry the user cannot get out of" | 753-815 | `  await t.test("leaves no history entry the user cannot get out of", async () => {` → blank | 13 pins on `useNavigation` internals (`onPop/adopt`, `depthRef`, `history.go(-depth)`, `withNavEntry`, `replaceDetail`, `parkedScrollRef`, `logCreditsFor`) | `tests/e2e/credential-detail.spec.ts` (real browser history); `tests/navigation.test.mjs` (`parseRoute/buildPath/routeAt/readNavEntry`) |
| Whole subtest "slides screens in and out and follows the back gesture" | 816-926 | `  await t.test("slides screens in and out and follows the back gesture", async () => {` → blank | 20 pins: `screen-in/out` keyframes, `--screen-drag`, `useEdgeSwipeBack`, reduced motion | none — iOS idiom (ios-coupling-07/15); Wave 3 redesign input |
| Whole subtest "answers touch the way the platform does" | 927-1041 | `  await t.test("answers touch the way the platform does", async () => {` → blank | 25 pins: tap-highlight, press scale, sheet grabber/drag, `Capacitor?.Plugins?.Haptics` + 4 `hapticTap` sites (985-1003, so Task 7 edits no regex), tab re-tap, reminder-open/Log credits wiring | `tests/e2e/home.spec.ts` (needs-attention card → detail; Log credits opens the dialog); haptics retired outright in Task 7 |
| Whole subtest "removes the disposable starter preview" | 1042-1069 | `  await t.test("removes the disposable starter preview", async () => {` → blank | Wave 0 residue: `page.tsx`/`layout.tsx`/`package.json` reads + `app/_sites-preview` readdir + a rendered-HTML doesNotMatch on the same strings — empty once its source reads go | nothing to replace (`app/_sites-preview` no longer exists) |
| Whole subtest "ships an accessible phone-first weekly-rhythm control" | 9204-9312 | `  await t.test(` / `"ships an accessible phone-first weekly-rhythm control",` → blank | 25 pins: `weeklyGoalPresets`, `<legend>Weekly action target</legend>`, readiness `role="progressbar"`, phone card `order:`, `mobile-add` aria-label, sr-only record labels, `--text-*` rules | `tests/e2e/profile.spec.ts` (legend + radios), `home.spec.ts` (progressbar), `history.spec.ts` (field labels) |
| Whole subtest "keeps the larger template chooser and alternative tags mobile-accessible" | 13371-13444 | `  await t.test(` / `"keeps the larger template chooser and alternative tags mobile-accessible",` → blank | 19 pins: `<optgroup group.profession`, `setCatalogQuery`/`setSelectedRuleId` bodies, "No exact match — enter my own requirements", `--tap-min` rules | `tests/e2e/credentials.spec.ts` |
| `readBuiltClientAppSource` | 580-594 | `async function readBuiltClientAppSource() {` → blank | built-chunk reader (only 7539 used it) | — |
| `readdir` import | 2 | `import { readFile, readdir, stat } from "node:fs/promises";` → `import { readFile, stat } from "node:fs/promises";` | unused once 581, 1047 and 1096 go (`stat` stays for the OCR asset sizes at 1142-1143) | — |
| OCR subtest, bindings + stale read | 1074, 1077, 1078, 1080-1083, 1089-1110, 1111 | `        clientSource,` … `        import("typescript"),` | `dist/server/ssr/assets/ITrackApp-BvrpzBXC.js` read + `readdir` fallback | — |
| OCR subtest, copy pins | 1117-1123, 1131 | `      assert.match(clientSource, /capture="environment"/);` → `      );`; `      assert.match(builtClientSource, /Start with the certificate/);` | 5 copy pins (`capture="environment"`, "Start with the certificate", "Review every highlighted suggestion", `uploadEvidence(result.id, evidenceFile)`, built chunk copy). The `ocrSource` pins 1124-1130 (local `workerPath/corePath/langPath`, no `fetch(`) and the tesseract versions 1115-1116 stay | `tests/e2e/log-activity.spec.ts` |
| OCR subtest, extraction cases | 1148-1189 | blank / `      const compiled = typescript.default.transpileModule(ocrSource, {` → `      );` | the two `extractCertificateSuggestions` cases | `tests/certificate-ocr.test.mjs` (moved verbatim) |
| EMS/educator/mental-health seed | 1198, 1205-1208, 1867-1870 | `      const [runtimeSource, workspaceRouteSource, clientSource] =` → `… workspaceRouteSource] =`; the ITrackApp `readFile`; `assert.match(clientSource, /isFloridaMentalHealthPhaseCredential…/)` | 1 pin | `tests/e2e/credentials.spec.ts` |
| Pharmacist seed | 1884, 1893-1896, 2276-2279 | `        clientSource,`; the ITrackApp `readFile`; `assert.match(clientSource, /isManagedPharmacistCredential…/)` | 1 pin | `tests/e2e/credentials.spec.ts` |
| CRC/ABVE seed | 2289, 2300-2303, 3279-3282 | `      const [runtimeSource, rehabilitationSource, routeSource, clientSource] =` → `… routeSource] =`; the ITrackApp `readFile`; `assert.match(clientSource, /isRehabilitationCertificationCatalogRule…/)` | 1 pin | `tests/e2e/credentials.spec.ts` |
| Nursing seed | 4159, 4168-4171, 4654-4668, 4679-4690 | `        clientSource,`; the ITrackApp `readFile`; six `assert.match(clientSource, …)` blocks (the `app/lib/readiness.ts` pin at 4672-4678 stays) | 6 pins (zero-hour copy, informational categories, "Training and checklist", nursing attestation, exclusive groups) | `tests/e2e/credential-detail.spec.ts`; `tests/readiness.test.mjs` |
| Requirement-compatibility | 6665, 6673-6676, 6960-6967 | `      const [compatibilitySource, clientSource] = await Promise.all([` → `      const [compatibilitySource] = await Promise.all([`; the ITrackApp `readFile`; two `assert.match(clientSource, …)` | 2 pins (`nextRequirementSelection(…)`, `requirementIncompatibilityMessage(…)` call shapes) | the module cases in the same subtest stay |
| Cyber/insurance seed | 10990, 10997-11000, 11303-11306, 11311-11314 | `      const [runtimeSource, workspaceRouteSource, clientSource] =` → `… workspaceRouteSource] =`; the ITrackApp `readFile`; two `assert.match(clientSource, …)` | 2 pins (ISC2 checkpoint copy, compliance-period copy) | `tests/e2e/credential-detail.spec.ts` |
| Phone companion, bindings | 7522-7524, 7531, 7534-7539, 7549 | `        layoutSource,` … `        readFile(new URL("../app/globals.css", import.meta.url), "utf8"),` | reads of `layout.tsx`, `ITrackApp.tsx`, the built chunk, `globals.css` | — |
| Phone companion, layout pins | 7588-7590 | `      assert.match(layoutSource, /manifest:\s*"\/manifest\.webmanifest"/);` → `      assert.match(layoutSource, /viewportFit:\s*"cover"/);` | 3 `layoutSource` pins (keep-list metadata, but source text) | `app/layout.tsx:31-47` is on the keep-list; the manifest itself is still fetched and checked at 7552-7587 |
| Phone companion, copy/draft/safe-area block | 7657-7821 | blank / `      for (const source of [clientSource, builtClientSource]) {` → `      );` | 13 loop pins + 30 `clientSource` + 8 `stylesSource` pins: draft copy, `activityDraftStorageKey(workspace.user.draftStorageNamespace)`, legacy-key migration, `Saving/Saved in this browser`, SW registration, online/offline listeners, focus trap, safe-area rules, `--text-*` scale, calendar wiring | `tests/e2e/log-activity.spec.ts` (draft autosave + restore), `tests/activity-draft.test.mjs` (keys, TTL), `tests/e2e/credential-detail.spec.ts` (calendar download) |
| Push subtest | 21771, 21780-21783, 21802-21814 | `        clientSource,`; the ITrackApp `readFile`; `      assert.match(clientSource, /handleEnablePhoneAlerts/);` → `      );` | 4 pins (`handleEnablePhoneAlerts`, `pushManager.subscribe({ userVisibleOnly: true …`, no bare `Notification.requestPermission()`). `serviceWorkerSource`/`pushDeliverySource`/`wranglerSource` pins stay | `tests/e2e/profile.spec.ts` ("Due-date check-ins" dialog) |
| Packet subtest | 24296-24317 | `      const appSource = await readFile(` → `      );` | 3 `appSource` pins (`credential-packet-card`, packet href with `target="_blank" rel="noopener noreferrer"`, "Reconnect to prepare packet") + the `requirementGapCount…proofGapCount` order slice | `tests/e2e/packet.spec.ts` (href from the detail screen, 200 HTML, foreign id 404) |

The five lines the script *replaces* rather than deletes (the only insertions in the diff):

```
import { readFile, stat } from "node:fs/promises";
      const [runtimeSource, workspaceRouteSource] =
      const [runtimeSource, rehabilitationSource, routeSource] =
      const [compatibilitySource] = await Promise.all([
      const [runtimeSource, workspaceRouteSource] =
```

- [ ] **Step 8: Verify the edit and see the guard pass**

Run:

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
node --check tests/rendered-html.test.mjs
grep -cE 'clientSource|stylesSource|appSource|layoutSource|builtClientSource|phoneStyles|ITrackApp-' tests/rendered-html.test.mjs
grep -c 'await t\.test(' tests/rendered-html.test.mjs
grep -cE 'readdir|readBuiltClientAppSource' tests/rendered-html.test.mjs
git diff --stat tests/rendered-html.test.mjs
node --test tests/app-source-guards.test.mjs
npm run lint
```

Expected, in order: silent (syntax OK); `0` (205 at `8ac172a`); `100` (107 at `8ac172a`); `0`; ` 1 file changed, 5 insertions(+), 969 deletions(-)`; every guard passes including `no test file reads client source text (architecture-03)`; lint PASS with no `no-unused-vars` warning for `tests/rendered-html.test.mjs` (the `readdir` import is gone, `stat` and `pngDimensions` are still used).

- [ ] **Step 9: Update `docs/DESIGN-SYSTEM.md`**

Lines 189-193 (under `## Tests` at 187) currently read:

```markdown
`tests/rendered-html.test.mjs` renders the real HTML/CSS and pins, among ~2,110
assertions: theme-color metas for both schemes, `color-scheme`, and
token-referencing rules. When a rule moves from a literal to a token, move the
assertion to pin the token. `tools/contrast-audit.mjs` is the separate gate for
the token values themselves.
```

Replace those five lines with:

```markdown
`tests/rendered-html.test.mjs` renders the real HTML/CSS through the built
worker and pins theme-color metas for both schemes, `color-scheme`, and the
rendered packet; it never reads component or stylesheet source (Playwright
specs under `tests/e2e/` cover screen behaviour, `tests/*.test.mjs` cover the
pure modules). `tools/contrast-audit.mjs` is the separate gate for the token
values themselves.
```

- [ ] **Step 10: Run the full gate**

Stop any `npm run dev` on :3000 first (the build shares `.wrangler/`). Run:

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
npm run typecheck && npm run lint && npm test
```

Expected: typecheck silent; lint PASS; `npm test` builds, runs `build:lib-test` (seven files into `.test-build/`), and every file under `tests/*.test.mjs` passes — `tests/rendered-html.test.mjs` with its 100 remaining subtests (the SSR shell subtests 604-682, the manifest/icon/sw/offline/_headers equality at 7552-7617, the packet HTML, push scheduling, catalog/rule 409s, and every db-calls and worker-http assertion are untouched), the three new unit files (13 tests), `tests/app-source-guards.test.mjs` with the new guard, and Task 1's `tests/isolation.test.mjs`. This task touches nothing under `app/` or `tests/e2e/`, so `npm run test:e2e` is not required here.

- [ ] **Step 11: Commit**

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
git branch --show-current   # must print feat/wave2-foundation
git add tests/rendered-html.test.mjs tests/certificate-ocr.test.mjs tests/activity-draft.test.mjs tests/readiness.test.mjs tests/app-source-guards.test.mjs package.json docs/DESIGN-SYSTEM.md
git commit -m "test: retire the 196 source-text pins over ITrackApp/globals/layout; unit tests for certificateOcr, activityDraft, readiness (architecture-03)

Deleted whole from tests/rendered-html.test.mjs (all-pin subtests):
- pushes credential detail onto the navigation stack -> tests/e2e/credential-detail.spec.ts
- leaves no history entry the user cannot get out of -> tests/e2e/credential-detail.spec.ts (+ tests/navigation.test.mjs)
- slides screens in and out and follows the back gesture -> no replacement (iOS idiom; Wave 3 redesign input)
- answers touch the way the platform does -> tests/e2e/home.spec.ts; haptics retired outright in Task 7
- ships an accessible phone-first weekly-rhythm control -> tests/e2e/profile.spec.ts, home.spec.ts, history.spec.ts
- keeps the larger template chooser and alternative tags mobile-accessible -> tests/e2e/credentials.spec.ts
- removes the disposable starter preview (Wave 0 residue pins; empty once its page/layout reads went)

Trimmed in place (client-source asserts and their readFile bindings only):
OCR copy pins and extraction cases -> tests/certificate-ocr.test.mjs; phone
companion draft/copy/safe-area pins -> tests/e2e/log-activity.spec.ts +
tests/activity-draft.test.mjs; packet appSource pins -> tests/e2e/packet.spec.ts;
push clientSource pins -> tests/e2e/profile.spec.ts; the 13 stray clientSource
pins in the catalog-seed subtests -> tests/e2e/credentials.spec.ts and
credential-detail.spec.ts; readiness arithmetic -> tests/readiness.test.mjs.
readBuiltClientAppSource and the stale dist/server/ssr ITrackApp-*.js read are
gone. public/sw.js, pushDelivery.ts, wrangler.json and every server-source pin
stay this wave (Wave 3).

build:nav-test -> build:lib-test (alias kept; readiness, activityDraft,
certificateOcr added). tests/app-source-guards.test.mjs now refuses any
client-source or built-chunk read in every tests/*.test.mjs. DESIGN-SYSTEM.md
Tests paragraph updated.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 6: Generalise `tools/contrast-audit.mjs` to every stylesheet; tokenise the public-page literals; wire the audit into `npm test`

**Rationale:** spec §4 bullet 1 ("`tools/contrast-audit.mjs` is generalised to walk every stylesheet under `app/` and `deploy/railway/pages/`") and spec §9 *Contrast* ("`tools/contrast-audit.mjs` across all stylesheets, zero literals outside token files"). Today the tool is hard-wired to one file (`CSS_PATH = resolve(ROOT, "app/globals.css")`, module-level `CSS`, `LIGHT_RANGE`/`DARK_RANGE`), nothing runs it (no npm script, no test, no CI), and it would misreport any file without a dark or forced-colors block: `CSS.indexOf(marker)` returns -1 and `blockRange(src, -1)` silently takes the first block in the file. Wave 3 splits `globals.css` into `app/styles/tokens.css` plus per-screen consumer stylesheets, so the token-file rule below is structural — the split needs no re-teaching. Four facts verified against the tree at `8ac172a`, each reflected in the steps: (1) `app/globals.css:1` is `@import "tailwindcss";`, so "first non-comment rule is `:root {`" must skip leading `@import`/`@charset` statements or the token file itself is classified as a consumer and every hex in its `:root` becomes a literal; (2) each of the five pages carries exactly three literals outside its `:root` — `color: #fff` (line 33), `background: #fff` (line 45), `color: #b3261e` (line 51) — 15 in all, and `landing.html` has two `<style>` blocks (lines 8-53 and 54-65); (3) `#b3261e` on `--coral-soft` (`#fde3e4`) measures **5.4:1** with the tool's own formula (AA for text is 4.5:1; the pages carry no claim comments, so nothing is documented and nothing needs to be); (4) today's `stripComments` replaces a multi-line comment with a run of spaces and so drops its newlines — a literal's reported line was low by the number of comment lines above it, invisible only because there has never been a literal to report. No file under `app/` or `tests/e2e/` changes, so this task has no Playwright step.

**Files:**
- Modify: `tools/contrast-audit.mjs` (whole file: `auditStylesheet`, `collectStylesheets`, `tokenBlocks`, optional blocks, per-file report; `parseColor`/`contrast`/`over`/`blockRange`, the claim grammar and the colour-name tables stay verbatim)
- Modify: `deploy/railway/pages/landing.html`, `login.html`, `signup.html`, `verify.html`, `reset.html` (identical edits: the `:root` line 16 gains `--on-accent`/`--coral-ink`; lines 33, 45, 51 use tokens)
- Create: `tests/contrast-audit.test.mjs`
- Modify: `docs/DESIGN-SYSTEM.md` — the opening paragraph (lines 3-9 at `8ac172a`, starts `The single source of truth is the two`) and the *Contrast discipline* paragraph (lines 89-92, contains `re-derives all 92 of them`); find both by content with `grep -n`, other tasks edit this file too
- Test: `node tools/contrast-audit.mjs`, `tests/contrast-audit.test.mjs`, `tests/auth-pages.test.mjs`

**Interfaces:**
- Consumes: nothing from another task (this task has no dependencies). It keeps, verbatim from the current tool, `parseColor(raw)`, `contrast(a, b)`, `over(fg, bg)`, `blockRange(src, from)`, the claim grammar/floors in `claimsIn`/`floorFor`, and `NAMED_COLORS`/`SYSTEM_COLORS`.
- Produces (module-level exports, so the tool is importable as well as runnable; nothing runs on import — the CLI is guarded on `process.argv[1]`):
  ```js
  export function auditStylesheet(css, { path, kind }) → { path, kind, claims: Claim[], failures: Failure[], literals: Literal[] }
    // kind: "tokens" | "consumer". Claim = { path, scheme: "light" | "dark", line, nthOnLine, claimed, subject,
    // surfaceExpr, owner, large, result: "pass" | "drift" | "floor" | "unresolved", actual?, floor?, detail? };
    // Failure = a Claim whose result !== "pass"; Literal = { path, line, text }. Claims are read only when
    // kind === "tokens" (zero claims is a pass); the literal scan runs for every kind, masking only that
    // file's light/dark blocks (a consumer masks nothing, so a `:root` in a consumer is itself a violation).
  export function collectStylesheets(root = ROOT) → Array<{ path, css, kind }>
    // every .css under app/ (recursive, sorted) then deploy/railway/pages/*.html (sorted); `path` is
    // repo-relative with "/" separators. For a page, `css` is every <style>…</style> block in document
    // order with everything outside the blocks blanked to spaces, newlines kept — i.e. the blocks
    // concatenated with the newlines that sit between them — so a reported line is the HTML file's own.
  export function tokenBlocks(css) → { light: [a, b] | null, dark: [a, b] | null, forced: [a, b] | null }
    // the first `:root {` block, the first `@media (prefers-color-scheme: dark)` block and the first
    // `@media (forced-colors` block, each null when absent (never "the first block in the file");
    // markers are searched with comments blanked. Never the responsive `@media (max-width: 1040px)
    // { :root … }` at globals.css:5684 nor the `:root` at :6574 — exactly today's two blocks.
  ```
  **Kind rule:** a `.css` file is `tokens` iff its first rule — after comments and any leading `@import …;`/`@charset …;` statements — is `:root {`; every page HTML is `tokens` (each inlines its own `:root`); everything else under `app/` is `consumer`. Today `app/globals.css` and the five pages qualify; after Wave 3 only `app/styles/tokens.css` and the pages will. System-colour keywords (`Canvas`, `ButtonText`, …) are allowed only inside a file's own `@media (forced-colors …)` block; a file without one allows none.
  **CLI, unchanged in spirit:** `node tools/contrast-audit.mjs [--list] [--json] [<path>…]` — `<path>` is a `.css` or `.html` file relative to the cwd (its kind decided by the same rule; a path outside the repo is reported as given), default `collectStylesheets(ROOT)`. Exit 1 on any failing claim or any literal. `--json` prints every resolved claim (now with `path` and `result`) sorted by path, line, `nthOnLine`, and exits 1 only on an unresolved claim, as today.
  **Report format:** per stylesheet `contrast-audit: <path> — <n> claims, <f> failing, <l> literals`, then each failure as `  FAIL <path>:L<line> <scheme> …` (the existing drift/floor/unresolved wording) and each literal as `  FAIL <path>:L<line> colour literal outside token blocks: <text>`; final line `contrast-audit: <files> stylesheets, <F> failing claims, <L> colour literals outside token blocks`.
  **Page tokens:** every page's `:root` gains `--on-accent: #ffffff` (the name and value `app/globals.css:168` already uses for text on the accent) and `--coral-ink: #b3261e` (5.4:1 on `--coral-soft`); `.btn-primary` reads `color: var(--on-accent)`, `input` reads `background: var(--card)`, `.flash.error` reads `color: var(--coral-ink)`. Rendered colours are unchanged (`#fff` ≡ `#ffffff` ≡ `--card`).
  **Gate:** `tests/contrast-audit.test.mjs` is build-free and is collected by `npm test`'s `tests/*.test.mjs` glob — no `package.json` change, and Task 5's `build:lib-test` rename does not touch it.

- [ ] **Step 1: Write the failing test**

Create `tests/contrast-audit.test.mjs`:

```js
// Gate for the design-system contrast invariant (spec §9 "Contrast"): every
// stylesheet under app/ and every public page's <style> blocks pass
// tools/contrast-audit.mjs — each documented claim holds, and no colour
// literal sits outside a token file's token blocks. The tool is run exactly
// as a person runs it, so the exit code and the report lines are what is
// pinned. Build-free: `node --test tests/contrast-audit.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditStylesheet, collectStylesheets, tokenBlocks } from "../tools/contrast-audit.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = ["landing", "login", "signup", "verify", "reset"];

const runAudit = (...args) =>
  spawnSync(process.execPath, ["tools/contrast-audit.mjs", ...args], { cwd: root, encoding: "utf8" });

test("every stylesheet and public page passes the contrast audit", () => {
  const run = runAudit();
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^contrast-audit: app\/globals\.css — \d+ claims, 0 failing, 0 literals$/m);
  for (const page of PAGES) {
    assert.match(
      run.stdout,
      new RegExp(`^contrast-audit: deploy/railway/pages/${page}\\.html — 0 claims, 0 failing, 0 literals$`, "m"),
    );
  }
  assert.match(run.stdout, /^contrast-audit: \d+ stylesheets, 0 failing claims, 0 colour literals outside token blocks$/m);
});

test("the walker classifies globals.css and every page as token files and reads their blocks", () => {
  const byPath = new Map(collectStylesheets(root).map((sheet) => [sheet.path, sheet]));
  const globals = byPath.get("app/globals.css");
  assert.ok(globals, "app/globals.css is walked");
  assert.equal(globals.kind, "tokens", "its first rule after `@import \"tailwindcss\";` is `:root {`");
  const blocks = tokenBlocks(globals.css);
  assert.ok(blocks.light && blocks.dark && blocks.forced, "globals.css has light, dark and forced-colors blocks");
  assert.ok(auditStylesheet(globals.css, globals).claims.length >= 90, "claims are read from the token blocks");
  for (const page of PAGES) {
    const sheet = byPath.get(`deploy/railway/pages/${page}.html`);
    assert.ok(sheet, `${page}.html is walked`);
    assert.equal(sheet.kind, "tokens", `${page}.html inlines its own :root`);
    const pageBlocks = tokenBlocks(sheet.css);
    assert.ok(pageBlocks.light, `${page}.html has a :root block`);
    assert.equal(pageBlocks.dark, null, `${page}.html has no dark block — an absent block is null, not the first block`);
    assert.equal(pageBlocks.forced, null, `${page}.html has no forced-colors block`);
  }
});

test("a consumer stylesheet masks nothing: a literal anywhere in it fails, even inside a :root", () => {
  const report = auditStylesheet(".card { color: #123456; }\n:root { --x: #ffffff; }\n", {
    path: "app/styles/example.css",
    kind: "consumer",
  });
  assert.equal(report.claims.length, 0);
  assert.deepEqual(report.literals.map((l) => `${l.line}:${l.text}`), ["1:#123456", "2:#ffffff"]);
});

test("a colour literal injected into a page fails the run and is named by file and line", () => {
  const source = readFileSync(path.join(root, "deploy", "railway", "pages", "login.html"), "utf8");
  const injected = source.replace(".btn-primary:hover {", ".btn-primary:hover { color: #123456;");
  assert.notEqual(injected, source, "the hover rule is where the literal is injected");
  const line = injected.split("\n").findIndex((text) => text.includes("#123456")) + 1;
  const dir = mkdtempSync(path.join(tmpdir(), "contrast-audit-"));
  try {
    const copy = path.join(dir, "login.html");
    writeFileSync(copy, injected);
    const run = runAudit(copy);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(
      run.stdout,
      new RegExp(`^  FAIL .*login\\.html:L${line} colour literal outside token blocks: #123456$`, "m"),
    );
    assert.match(run.stdout, /^contrast-audit: 1 stylesheets, 0 failing claims, 1 colour literals outside token blocks$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run:

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
node --experimental-sqlite --test tests/contrast-audit.test.mjs
```

Expected: FAIL at module link time — before any test runs and before the old tool's top-level audit can execute (ESM checks export names before it evaluates the module body):

```
# SyntaxError: The requested module '../tools/contrast-audit.mjs' does not provide an export named 'auditStylesheet'
…
# tests 1
# pass 0
# fail 1
```

- [ ] **Step 3: Rewrite `tools/contrast-audit.mjs`**

Replace the whole file with the following. The colour maths, `blockRange`, the claim grammar and the two colour-name tables are the existing code moved unchanged; what is new is `optionalBlock` (the `indexOf(-1)` fix), `tokenBlocks`, the kind rule (`isTokenStylesheet`, which skips the leading `@import "tailwindcss";`), `styleBlocksOf` (line-preserving `<style>` extraction), `collectStylesheets`, the helpers taking `css`/`tokens` as parameters instead of closing over module state, `auditStylesheet`, the per-file report, and the `process.argv[1]` guard so the module is importable. `stripComments` now blanks a comment with `blank` (newlines kept), which fixes the line-number bug noted in the rationale.

```js
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
```

- [ ] **Step 4: Run the tool — it must now fail on the five pages' literals, at the right lines**

Run: `node tools/contrast-audit.mjs; echo "exit=$?"`
Expected (exit 1; `globals.css` still 98 claims; every page three literals at HTML lines 33, 45, 51):

```
contrast-audit: app/globals.css — 98 claims, 0 failing, 0 literals
contrast-audit: deploy/railway/pages/landing.html — 0 claims, 0 failing, 3 literals
  FAIL deploy/railway/pages/landing.html:L33 colour literal outside token blocks: #fff
  FAIL deploy/railway/pages/landing.html:L45 colour literal outside token blocks: #fff
  FAIL deploy/railway/pages/landing.html:L51 colour literal outside token blocks: #b3261e
contrast-audit: deploy/railway/pages/login.html — 0 claims, 0 failing, 3 literals
  FAIL deploy/railway/pages/login.html:L33 colour literal outside token blocks: #fff
  FAIL deploy/railway/pages/login.html:L45 colour literal outside token blocks: #fff
  FAIL deploy/railway/pages/login.html:L51 colour literal outside token blocks: #b3261e
contrast-audit: deploy/railway/pages/reset.html — 0 claims, 0 failing, 3 literals
  FAIL deploy/railway/pages/reset.html:L33 colour literal outside token blocks: #fff
  FAIL deploy/railway/pages/reset.html:L45 colour literal outside token blocks: #fff
  FAIL deploy/railway/pages/reset.html:L51 colour literal outside token blocks: #b3261e
contrast-audit: deploy/railway/pages/signup.html — 0 claims, 0 failing, 3 literals
  FAIL deploy/railway/pages/signup.html:L33 colour literal outside token blocks: #fff
  FAIL deploy/railway/pages/signup.html:L45 colour literal outside token blocks: #fff
  FAIL deploy/railway/pages/signup.html:L51 colour literal outside token blocks: #b3261e
contrast-audit: deploy/railway/pages/verify.html — 0 claims, 0 failing, 3 literals
  FAIL deploy/railway/pages/verify.html:L33 colour literal outside token blocks: #fff
  FAIL deploy/railway/pages/verify.html:L45 colour literal outside token blocks: #fff
  FAIL deploy/railway/pages/verify.html:L51 colour literal outside token blocks: #b3261e
contrast-audit: 6 stylesheets, 0 failing claims, 15 colour literals outside token blocks
exit=1
```

Also confirm the 98 claims are the same 98 the old tool measured (the JSON records carry the same `line`, `subject`, `surfaceExpr`, `claimed`, `actual` — only `path` and `result` are new): `node tools/contrast-audit.mjs --json app/globals.css | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.length, [...new Set(j.map(c=>c.result))])})'` → `98 [ 'pass' ]`.

- [ ] **Step 5: Tokenise the five pages**

The five files are byte-identical from line 9 to line 52 (verify: `grep -n 'color: #fff\|background: #fff\|color: #b3261e\|--ok-ink: #18794e;' deploy/railway/pages/*.html` → 20 hits, four per file, at lines 16, 33, 45, 51). In **each** of `landing.html`, `login.html`, `signup.html`, `verify.html`, `reset.html` make these four line replacements (nothing else in the files changes; the line count is unchanged):

Line 16, inside `:root {`:
```css
    --ok-soft: #ddf3e4; --ok-ink: #18794e;
```
becomes
```css
    --ok-soft: #ddf3e4; --ok-ink: #18794e; --on-accent: #ffffff; --coral-ink: #b3261e;
```

Line 33:
```css
  .btn-primary { background: var(--accent); color: #fff; }
```
becomes
```css
  .btn-primary { background: var(--accent); color: var(--on-accent); }
```

Line 45 (inside `input { … }`):
```css
    border: 1px solid var(--line); border-radius: 10px; background: #fff; color: var(--ink);
```
becomes
```css
    border: 1px solid var(--line); border-radius: 10px; background: var(--card); color: var(--ink);
```

Line 51:
```css
  .flash.error { background: var(--coral-soft); color: #b3261e; }
```
becomes
```css
  .flash.error { background: var(--coral-soft); color: var(--coral-ink); }
```

One command does all twenty edits (each pattern is anchored on the full existing line, so a page that has already been edited is left alone):

```bash
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
for f in landing login signup verify reset; do
  perl -0pi -e 's/    --ok-soft: #ddf3e4; --ok-ink: #18794e;\n/    --ok-soft: #ddf3e4; --ok-ink: #18794e; --on-accent: #ffffff; --coral-ink: #b3261e;\n/; s/  \.btn-primary \{ background: var\(--accent\); color: #fff; \}/  .btn-primary { background: var(--accent); color: var(--on-accent); }/; s/border-radius: 10px; background: #fff; color: var\(--ink\);/border-radius: 10px; background: var(--card); color: var(--ink);/; s/  \.flash\.error \{ background: var\(--coral-soft\); color: #b3261e; \}/  .flash.error { background: var(--coral-soft); color: var(--coral-ink); }/' "deploy/railway/pages/$f.html"
done
git diff --stat deploy/railway/pages
grep -c -- '--coral-ink: #b3261e' deploy/railway/pages/*.html
grep -n 'color: #fff\|background: #fff\|color: #b3261e' deploy/railway/pages/*.html
```

Expected: `git diff --stat` lists the five pages with 8 changed lines each (`20 insertions(+), 20 deletions(-)` in total); the `grep -c` prints `1` for every file; the last `grep` prints nothing (its exit status 1 is the point). `git diff deploy/railway/pages/login.html` shows exactly lines 16, 33, 45, 51 changed as above.

- [ ] **Step 6: Run the tool — green**

Run: `node tools/contrast-audit.mjs; echo "exit=$?"`
Expected:

```
contrast-audit: app/globals.css — 98 claims, 0 failing, 0 literals
contrast-audit: deploy/railway/pages/landing.html — 0 claims, 0 failing, 0 literals
contrast-audit: deploy/railway/pages/login.html — 0 claims, 0 failing, 0 literals
contrast-audit: deploy/railway/pages/reset.html — 0 claims, 0 failing, 0 literals
contrast-audit: deploy/railway/pages/signup.html — 0 claims, 0 failing, 0 literals
contrast-audit: deploy/railway/pages/verify.html — 0 claims, 0 failing, 0 literals
contrast-audit: 6 stylesheets, 0 failing claims, 0 colour literals outside token blocks
exit=0
```

- [ ] **Step 7: Run the tests — green**

Run: `node --experimental-sqlite --test tests/contrast-audit.test.mjs tests/auth-pages.test.mjs`
Expected: `# tests 14` / `# pass 14` / `# fail 0` — the four new tests (the run is green; the walker classifies `globals.css` and the pages as token files with `dark`/`forced` null for the pages; a consumer masks nothing; a literal injected into a temp copy of `login.html` exits 1 naming `login.html:L34`) plus the ten existing page tests, including `old product names must not appear`.

- [ ] **Step 8: Update `docs/DESIGN-SYSTEM.md`**

Find the anchors first — `grep -n 'single source of truth\|re-derives all 92' docs/DESIGN-SYSTEM.md` → the opening paragraph at lines 3-9 and the *Contrast discipline* sentence at line 90 (at `8ac172a`; Tasks 5 and 7 also edit this file, so trust the grep, not these numbers).

Replace the opening paragraph (the seven lines from `The single source of truth is the two` through `per-scheme component rules.`):

```markdown
The single source of truth is the two `:root` blocks at the top of `app/globals.css`:
the light block defines every token; the `@media (prefers-color-scheme: dark)` block
remaps the color tokens. **No color literal may appear anywhere else in the
stylesheet or in components** — this invariant is enforced, not just asserted:
`node tools/contrast-audit.mjs` fails on any hex, `rgb()`, or named color outside
those two blocks. It is what makes dark mode a pure token remap with zero
per-scheme component rules.
```

with (eleven lines — everything below in this file moves down four lines):

```markdown
The single source of truth is the two `:root` blocks at the top of the **token file** —
`app/globals.css` today, `app/styles/tokens.css` after the Wave 3 split (a stylesheet is a
token file iff its first rule, after any leading `@import`, is `:root {`; every public page
is one too, because each inlines its own `:root`): the light block defines every token; the
`@media (prefers-color-scheme: dark)` block remaps the color tokens. **No color literal may
appear outside a token file's `:root`/dark blocks** — not in consumer stylesheets (the
per-screen CSS after Wave 3), not in components, not in `deploy/railway/pages/*.html`. This
is enforced, not just asserted: `node tools/contrast-audit.mjs` walks every stylesheet under
`app/` and every page's `<style>` blocks with one rule set and fails on any hex, `rgb()`, or
named color outside those blocks; `tests/contrast-audit.test.mjs` runs it under `npm test`.
It is what makes dark mode a pure token remap with zero per-scheme component rules.
```

Replace the four *Contrast discipline* lines:

```markdown
blocks**. Those comments are a contract, not a note: `tools/contrast-audit.mjs`
re-derives all 92 of them from the token values in the file and fails if any has
drifted by more than 0.05 or dropped below its floor. Run it before committing a
token change.
```

with:

```markdown
blocks**. Those comments are a contract, not a note: `tools/contrast-audit.mjs`
re-derives every documented claim (98 today) from the token values in the file and
fails if any has drifted by more than 0.05 or dropped below its floor. Run it before
committing a token change; `npm test` runs it too.
```

Verify: `grep -n 'all 92\|anywhere else in the' docs/DESIGN-SYSTEM.md` → nothing; `grep -c 'tokens.css' docs/DESIGN-SYSTEM.md` → `1`.

- [ ] **Step 9: Gates**

Stop any `npm run dev` server on :3000 first (`npm run build` inside `npm test` shares `.wrangler/` with it). Run:

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
node tools/contrast-audit.mjs && npm run lint && npm run typecheck && npm test
```

Expected: the audit prints the Step 6 report and exits 0; `eslint .` is silent (it lints `tools/` and `tests/`); `tsc --noEmit` is silent (`.mjs` files are outside `tsconfig`'s `include`); `npm test` builds, then every file under `tests/*.test.mjs` passes, `tests/contrast-audit.test.mjs` among them.

- [ ] **Step 10: Commit**

```bash
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
git branch --show-current   # must print feat/wave2-foundation
git add tools/contrast-audit.mjs tests/contrast-audit.test.mjs docs/DESIGN-SYSTEM.md \
  deploy/railway/pages/landing.html deploy/railway/pages/login.html deploy/railway/pages/signup.html \
  deploy/railway/pages/verify.html deploy/railway/pages/reset.html
git commit -m "feat(tools): contrast audit walks every stylesheet and public page; page literals tokenised; gate in npm test

The audit is importable (auditStylesheet, collectStylesheets, tokenBlocks) and
walks app/**/*.css plus the <style> blocks of deploy/railway/pages/*.html. A .css
file is a token file iff its first rule after any leading @import is \`:root {\`
(after Wave 3 only app/styles/tokens.css); every page is one. Claims are read
from token files only; the literal scan runs everywhere, masking only that
file's own :root/dark blocks. Absent dark/forced-colors blocks are null instead
of silently reading the first block; stripComments keeps newlines so reported
lines are right. The five pages' three literals each (#fff, #fff, #b3261e) are
now --on-accent, --card and --coral-ink (5.4:1 on --coral-soft).
tests/contrast-audit.test.mjs runs the tool under npm test and proves a planted
literal fails the run at its file and line. Spec §4 bullet 1, §9 Contrast.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 7: iOS residue sweep — protected-identifier pins first, then `hapticTap`, comments/prose, dead fonts, history docs

**Rationale:** spec §4 bullet 3 (iOS residue sweep, keep-list, "a test that pins the six protected legacy identifiers") and spec §1.1 (the Capacitor/TestFlight shell is retired; haptics go). Wave 1 already removed the big residue (Basic auth, the UA gate, APNs, the widget feed, the Dockerfile and README deployment prose — `Dockerfile:1-5` now reads "Railway container for iTrack … behind the session-cookie auth gateway" and has nothing to sweep). What is left at `main @ 8ac172a` is small and exact, all verified by grep:

- `hapticTap` — definition `app/ITrackApp.tsx:1638-1660` (comment + `type HapticsPlugin` + the function that reads `window.Capacitor?.Plugins?.Haptics`, the only Capacitor global in the repo, ios-coupling-16) and four calls at `:1815`, `:3327`, `:3675`, `:4129` (architecture-08, ios-coupling-06). No replacement: `navigator.vibrate` is Android-only and iOS Safari has no haptics API.
- Capacitor-shell rationale in prose: `app/globals.css:30-37` (TYPEFACE comment: "a Capacitor shell is a website"), `app/layout.tsx:101-105` ("no webfont variable"), `app/credentials/page.tsx:4-5` and `tests/rendered-html.test.mjs:654` ("the iOS shell reloading its `server.url`" — `server.url` is Capacitor's config key), `app/ITrackApp.tsx:2480` ("the shell's hardware back"), `app/lib/navigation.ts:1` ("iOS-style nav stack"), `README.md:120` ("native mobile packaging"), `docs/DESIGN-SYSTEM.md:18-20, 127-130` (ios-coupling-09, ios-coupling-12).
- Dead fonts (perf-08): they are **not** under `public/` (which holds zero font files). They are the gitignored `.vinext/fonts/` cache — 9 woff2 = 181,136 B dated 2026-07-27 (`git ls-files .vinext` → nothing; `git check-ignore -v .vinext/fonts` → `.gitignore:18:/.vinext/`) — which vinext 0.0.50's `writeBundle` hook (`node_modules/vinext/dist/plugins/fonts.js:583-609`) copies wholesale into `dist/client/assets/_vinext_fonts/` on every client build with no reference check. `.dockerignore` (`node_modules dist .wrangler .git .next *.log`) does not exclude `.vinext`, so a local `docker build` carries the cache into the image. The fix is a local `rm`, a `.dockerignore` line, and a test that keeps it gone.
- History (ios-coupling-12): the two iOS specs, the two iOS plans, the public-signup spec/plan (still describe Basic auth for the iOS client), and TC-002 (`status: "implemented"`).
- The seven load-bearing identifiers (ios-coupling-11), each with a "leave as-is" comment but no test: salt `` `license-lantern:${email}` `` `db/identity.ts:49`; draft prefix `license-lantern:activity-draft:v1:` `app/lib/activityDraft.ts:39,48` + `app/api/workspace/route.ts:427`; ICS UID domain `@license-lantern` `app/lib/calendarInvite.ts:143`; push topic `"license-lantern-check-in"` `app/lib/pushDelivery.ts:69` + `public/sw.js:159`; SW cache prefix `"license-lantern-static"` `public/sw.js:4`; R2 bucket `"vigilo-r2"` `vite.config.ts:35` (there is no wrangler.toml — bindings are inline); and the demo email `"demo@local.license-lantern"` `db/identity.ts:16`, which `db/identity.ts:12-15` calls load-bearing for the same reason (it feeds `stableUserId`, and the e2e suite runs as that identity) — decision: pin it as the seventh.

Everything else the grep terms touch is on the keep-list (ios-coupling-10/15) and is **not** edited here: `.app-shell` / pages `.shell` / "app shell" (the HTML shell, not Capacitor), the "iOS back gesture" comments at `app/ITrackApp.tsx:2439, 2537, 8005` and `tests/navigation.test.mjs:3` (iOS Safari's edge swipe is a real web input), the iOS-idiom design prose attached to code the redesign replaces (`app/globals.css:2580` PUSHED SCREEN HEADER, `app/ITrackApp.tsx:1282`, `:8005-8006`), the 16px zoom floor (`app/globals.css:644-654`), safe-area rules, `public/sw.js`, `public/offline.html`, `app/manifest.ts`, `app/layout.tsx:31-47` and `:75-90`, `app/lib/webPush.ts`, the route pages, `docs/audits/`, `.superpowers/sdd/`.

Five commits, each green. Line numbers below are `main @ 8ac172a` numbers; Tasks 1–6 do not touch `app/ITrackApp.tsx`, `app/globals.css`, `app/layout.tsx`, `app/credentials/page.tsx`, `app/lib/*`, `README.md`, `.dockerignore` or the docs under `docs/superpowers`/`docs/TC`, so those numbers hold. Two files are edited **above** the lines this task touches by earlier tasks — `tests/rendered-html.test.mjs` (Task 5 deletes `readBuiltClientAppSource` at 580-593, so `:654` becomes ≈`:640`) and `docs/DESIGN-SYSTEM.md` (Task 6 rewrites `:1-9` and `:89-92`) — so those two edits are located with the `grep -n` given in the step, never by number. Every edit is a deletion or comment/prose text; nothing under `app/api/**`, `db/**` or `drizzle/**` changes (Tasks 3–7 rule).

**Files:**
- Create: `tests/protected-identifiers.test.mjs`, `tests/dist-hygiene.test.mjs`
- Modify: `app/ITrackApp.tsx:1638-1661` (delete: comment, `type HapticsPlugin`, `function hapticTap`, trailing blank), `:1815`, `:3325-3327`, `:3673-3675`, `:4129` (delete the calls and their orphaned comments), `:2480-2481` (comment)
- Modify: `app/globals.css:30-37` (comment), `app/layout.tsx:101-105` (JSX comment), `app/credentials/page.tsx:4-6` (comment), `app/lib/navigation.ts:1` (comment), `tests/rendered-html.test.mjs:654` (comment; ≈640 after Task 5), `README.md:120`, `docs/DESIGN-SYSTEM.md:18-20, 127-130`, `app/lib/pushDelivery.ts:112` (one comment line above), `app/lib/renewalPacket.ts:511` (one comment line above the template that holds the `:516` meta)
- Modify: `.dockerignore` (append `.vinext`)
- Modify: `docs/superpowers/specs/2026-08-03-itrack-ios-design.md`, `docs/superpowers/specs/2026-08-11-ios-native-nav-retheme-design.md`, `docs/superpowers/specs/2026-08-11-itrack-public-signup-design.md`, `docs/superpowers/plans/2026-08-03-itrack-ios.md`, `docs/superpowers/plans/2026-08-11-ios-native-nav-retheme.md`, `docs/superpowers/plans/2026-08-11-itrack-public-signup.md` (one header line each), `docs/TC/records/TC-002-08-03-26-ios-appstore-app/tc_record.json`, `docs/TC/tc_registry.json`
- Test: `tests/protected-identifiers.test.mjs`, `tests/dist-hygiene.test.mjs`, `npm test`, `npm run test:e2e`

**Interfaces:**
- Consumes: Task 5 — the haptic pins at `tests/rendered-html.test.mjs:985-1004` were deleted with their whole subtest (927-1040) and no file under `tests/` reads `app/ITrackApp.tsx` as text any more except the generic walkers, so this task edits **no** test regex; `npm test` = `npm run build && npm run build:lib-test && node --experimental-sqlite --test tests/*.test.mjs` (the `tests/*.test.mjs` glob picks up both new files with no wiring). Task 3 — `npm run test:e2e` runs both Playwright projects against the dev server. Task 6 — `node tools/contrast-audit.mjs` walks every stylesheet and `tests/contrast-audit.test.mjs` runs it inside `npm test` (the `app/globals.css` comment rewrite below must leave it green).
- Produces: `grep -rn "hapticTap\|Capacitor" app tests` → 0 hits (Task 11 consumes this: the `hapticTap();` line inside `openActivityEntryFor` is already gone when it edits that function); `tests/protected-identifiers.test.mjs` (build-free, 10 `test()` calls) pins seven literals — the six from spec §4 plus `const DEMO_EMAIL = "demo@local.license-lantern";` — and fails on any renamed spelling; `tests/dist-hygiene.test.mjs` asserts `dist/client/assets/_vinext_fonts` is absent and `.dockerignore` matches `/^\.vinext$/m`; `.dockerignore` excludes `.vinext`; TC-002 status `retired` with revision `R7`, `tc_registry.json` `statistics.by_status.retired: 1`.

- [ ] **Step 0: Preflight**

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
node --version                                   # v22.22.0
git branch --show-current                        # feat/wave2-foundation
grep -c "hapticTap" tests/rendered-html.test.mjs # 0 — Task 5 has landed (it deleted the subtest that pinned hapticTap)
grep -c "build:lib-test" package.json            # 1 or more — Task 5's test script rename is in place
grep -rn "hapticTap\|Capacitor\|server\.url" app tests README.md docs/DESIGN-SYSTEM.md | wc -l   # 12 once Task 5 has landed: 8 in app/ITrackApp.tsx, app/globals.css:33, app/credentials/page.tsx:5, one tests/rendered-html.test.mjs comment (server.url), docs/DESIGN-SYSTEM.md:129 (17 at main, where the five rendered-html haptic pins still exist)
```

If `grep -c "hapticTap" tests/rendered-html.test.mjs` is not `0`, stop: Task 5 must land first — this task never edits a test regex (ios-coupling-15: pins are deleted whole, never re-pointed). If a `npm run dev` server is running on :3000, stop it before any `npm run build` step below (Steps 27 and 34) and start it again only for Step 35.

**Commit 1 of 5 — the identifier pins (ios-coupling-11), landed first so the sweep below is guarded.**

- [ ] **Step 1: Write the pin test**

Create `tests/protected-identifiers.test.mjs` with exactly this content:

```js
// Pins the six legacy identifiers that predate the iTrack product name and are
// load-bearing (audit ios-coupling-11; spec 2026-09-10 §4 "iOS residue sweep").
// Each is keyed into state that outlives a deploy — users.id hashes, browser
// localStorage, subscribers' calendars, installed service workers, and the R2
// volume — so a rename would orphan data, not tidy a name.
//
// Every pin is the literal inside the exact expression that uses it, searched
// across the runtime source trees rather than at a fixed path, so the Wave 2-4
// file moves cannot break it but a rename-happy cleanup cannot slip past it.
// Needs no build: `node --test tests/protected-identifiers.test.mjs`.
//
// Deliberately NOT pinned (renameable): the `ll-` notification tag prefix in
// app/lib/pushDelivery.ts (tags are per delivery), the
// `license-lantern-packet-version` meta in app/lib/renewalPacket.ts
// (informational), the `lantern-spin` keyframe in app/globals.css, and the
// tests' `__LICENSE_LANTERN_TEST_ENV__` global.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|mts|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

// The trees that hold runtime code, plus two single files: public/sw.js is
// served at /sw.js (its path is a URL contract, not layout) and the wrangler
// bindings live inline in vite.config.ts (there is no wrangler.toml).
const sources = [
  ...["db", "app", "worker"].flatMap((dir) => walk(path.join(root, dir))),
  path.join(root, "public", "sw.js"),
  path.join(root, "vite.config.ts"),
].map((file) => ({
  file: path.relative(root, file),
  source: readFileSync(file, "utf8"),
}));

function occurrences(pattern) {
  const found = [];
  for (const { file, source } of sources) {
    const count = (source.match(pattern) ?? []).length;
    if (count > 0) found.push(`${file} x${count}`);
  }
  return found;
}

const PROTECTED = {
  "workspace identity hash salt `license-lantern:`": {
    pattern: /new TextEncoder\(\)\.encode\(`license-lantern:\$\{email\}`\)/g,
    expectedIn: "db/identity.ts (stableUserId)",
    why: "users.id is usr_<sha256('license-lantern:' + email)>; a new salt orphans every workspace",
  },
  "activity draft localStorage prefix `license-lantern:activity-draft:v1:`": {
    pattern: /`license-lantern:activity-draft:v1:\$\{/g,
    expectedIn: "app/lib/activityDraft.ts (both key builders) and app/api/workspace/route.ts (legacy key)",
    why: "renaming strands every draft already saved in a user's browser",
  },
  "ICS UID domain `@license-lantern`": {
    pattern: /`UID:\$\{safeUid\(event\.uid\)\}@license-lantern`/g,
    expectedIn: "app/lib/calendarInvite.ts",
    why: "calendars match a re-downloaded event by UID; a new domain duplicates every check-in already added",
  },
  "web push topic `license-lantern-check-in`": {
    pattern: /"license-lantern-check-in"/g,
    expectedIn: "app/lib/pushDelivery.ts (GENERIC_TOPIC) and public/sw.js (safeNotificationTag fallback)",
    why: "collapses a device's pending alerts; the installed service worker falls back to the same string",
  },
  "service-worker cache prefix `license-lantern-static`": {
    pattern: /const CACHE_PREFIX = "license-lantern-static";/g,
    expectedIn: "public/sw.js",
    why: "the activate handler deletes every cache starting with it; a rename leaves old caches on every installed device forever",
  },
  "R2 bucket name `vigilo-r2`": {
    pattern: /bucket_name: "vigilo-r2"/g,
    expectedIn: "vite.config.ts (r2_buckets)",
    why: "miniflare keys on-disk R2 state by bucket_name; a rename orphans every evidence object on the Railway volume",
  },
};

for (const [name, { pattern, expectedIn, why }] of Object.entries(PROTECTED)) {
  test(`protected identifier: ${name}`, () => {
    const found = occurrences(pattern);
    assert.ok(
      found.length > 0,
      `${name} is gone from db/, app/, worker/, public/sw.js and vite.config.ts (last seen in ${expectedIn}). It is load-bearing: ${why}. Put the literal back — see audit ios-coupling-11.`,
    );
  });
}

test("the push topic is pinned on both sides: a server sender and public/sw.js", () => {
  const found = occurrences(/"license-lantern-check-in"/g);
  assert.ok(
    found.some((entry) => entry.startsWith(path.join("public", "sw.js"))),
    `public/sw.js lost its fallback topic; found in: ${found.join(", ") || "nowhere"}`,
  );
  assert.ok(
    found.some((entry) => !entry.startsWith(path.join("public", "sw.js"))),
    `no server-side sender declares the topic; found in: ${found.join(", ") || "nowhere"}`,
  );
});

test("the draft prefix is pinned on both sides: the client key builders and the server's legacy key", () => {
  const found = occurrences(/`license-lantern:activity-draft:v1:\$\{/g);
  assert.ok(found.some((entry) => entry.startsWith(path.join("app", "lib"))), `client key builder missing; found in: ${found.join(", ") || "nowhere"}`);
  assert.ok(found.some((entry) => entry.startsWith(path.join("app", "api"))), `server legacy key missing; found in: ${found.join(", ") || "nowhere"}`);
});

test("no renamed variant of a protected identifier has crept in", () => {
  for (const pattern of [
    /encode\(`itrack:\$\{email\}`\)/g,
    /`itrack:activity-draft:/g,
    /@itrack`/g,
    /"itrack-check-in"/g,
    /const CACHE_PREFIX = "itrack/g,
    /bucket_name: "itrack/g,
  ]) {
    assert.deepEqual(
      occurrences(pattern),
      [],
      `${pattern} found — the legacy spelling is the contract; the product rename never reaches these literals`,
    );
  }
});

// Not one of the six, but db/identity.ts calls it load-bearing for the same
// reason: the demo workspace's id derives from it, and the Wave 2 e2e suite
// runs as the demo identity.
test("demo identity email `demo@local.license-lantern`", () => {
  assert.ok(
    occurrences(/const DEMO_EMAIL = "demo@local\.license-lantern";/g).length > 0,
    "db/identity.ts DEMO_EMAIL changed — the demo workspace id is sha256 of the salt + this address",
  );
});
```

Never `import` this file (or `tests/app-source-guards.test.mjs`) from another test: importing a `*.test.mjs` re-registers its `test()` calls in the importing process. The walker is self-contained on purpose.

- [ ] **Step 2: Run it — it passes at HEAD, because it is a pin**

Run: `node --test tests/protected-identifiers.test.mjs`
Expected: `# tests 10` / `# pass 10` / `# fail 0` (six `protected identifier: …` tests, the two both-sides tests, the renamed-variant guard, the demo-email test). No build needed; it reads 60 files (58 `.ts`/`.tsx` under `db/`, `app/`, `worker/` plus `public/sw.js` and `vite.config.ts`) in about 60 ms.

- [ ] **Step 3: Prove it bites — rename one literal, see it fail, restore**

```bash
sed -i '' 's/bucket_name: "vigilo-r2"/bucket_name: "itrack-r2"/' vite.config.ts
grep -n bucket_name vite.config.ts        # 35:      bucket_name: "itrack-r2",
node --test tests/protected-identifiers.test.mjs
```

Expected: `# pass 8` / `# fail 2` — `not ok 6 - protected identifier: R2 bucket name \`vigilo-r2\`` with the error `R2 bucket name \`vigilo-r2\` is gone from db/, app/, worker/, public/sw.js and vite.config.ts (last seen in vite.config.ts (r2_buckets)). It is load-bearing: miniflare keys on-disk R2 state by bucket_name; a rename orphans every evidence object on the Railway volume. Put the literal back — see audit ios-coupling-11.` and `not ok 9 - no renamed variant of a protected identifier has crept in` with `/bucket_name: "itrack/g found — the legacy spelling is the contract; the product rename never reaches these literals`.

Then restore and confirm nothing but the new test is dirty:

```bash
git checkout -- vite.config.ts
grep -n bucket_name vite.config.ts        # 35:      bucket_name: "vigilo-r2",
node --test tests/protected-identifiers.test.mjs   # pass 10 again
git status --short                        # exactly: ?? tests/protected-identifiers.test.mjs
```

- [ ] **Step 4: Mark the two renameable near-misses as renameable (ios-coupling-11)**

`app/lib/pushDelivery.ts` — the keep-list exempts exactly this one comment line. Above line 112 `function safeNotificationTag(deliveryId: string) {` (verify: `grep -n "function safeNotificationTag" app/lib/pushDelivery.ts` → `112`) insert:

```ts
// Renameable: tags are per delivery, nothing stored depends on the "ll-" prefix (ios-coupling-11).
```

so lines 112-115 read:

```ts
// Renameable: tags are per delivery, nothing stored depends on the "ll-" prefix (ios-coupling-11).
function safeNotificationTag(deliveryId: string) {
  return `ll-${deliveryId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80)}`;
}
```

`app/lib/renewalPacket.ts` — the meta at line 516 (`  <meta name="license-lantern-packet-version" content="1">`) sits inside the HTML template string that starts at line 511, so the note goes as a JS comment on the line above the `return` (verify: `grep -n 'return `<!doctype html>' app/lib/renewalPacket.ts` → `511`). Insert above line 511:

```ts
  // <meta name="license-lantern-packet-version"> is renameable: informational meta, not a contract (ios-coupling-11).
```

so lines 510-513 read:

```ts

  // <meta name="license-lantern-packet-version"> is renameable: informational meta, not a contract (ios-coupling-11).
  return `<!doctype html>
<html lang="en">
```

The packet HTML output is unchanged (a JS comment is not emitted), so the rendered-html packet assertion on the meta (`/<meta name="license-lantern-packet-version" content="1">/`) still holds, and the four `pushDeliverySource` regexes in `tests/rendered-html.test.mjs` (`launchPath`, `claimDelivery`) do not span `safeNotificationTag`.

- [ ] **Step 5: Run the checks**

Run: `npm run typecheck && npm run lint && node --test tests/protected-identifiers.test.mjs`
Expected: typecheck silent, lint PASS (the new file lints clean under `eslint-config-next`), `# pass 10`.

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # feat/wave2-foundation
git add tests/protected-identifiers.test.mjs app/lib/pushDelivery.ts app/lib/renewalPacket.ts
git commit -m "test: pin the seven load-bearing legacy identifiers (ios-coupling-11)

Build-free walker over db/, app/, worker/, public/sw.js and vite.config.ts: the
license-lantern: salt, the activity-draft prefix (client + server), the ICS UID
domain, the push topic (server + service worker), the SW cache prefix, the
vigilo-r2 bucket, and the demo email; plus a guard against itrack-renamed
spellings. Marks the ll- tag prefix and the packet-version meta renameable.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

**Commit 2 of 5 — delete `hapticTap` (architecture-08, ios-coupling-06).** The red/green here is `npm run typecheck`: deleting the definition first leaves four dangling calls that TypeScript names, and deleting those turns it green. Edit from the bottom of the file upward within each step so the line numbers quoted stay valid.

- [ ] **Step 7: Confirm the five sites**

Run: `grep -n "hapticTap\|HapticsPlugin\|Capacitor" app/ITrackApp.tsx`
Expected, exactly:

```
1640: * Capacitor plugin injects itself into the page at runtime — so this looks the
1645:type HapticsPlugin = {
1649:function hapticTap(style: "light" | "medium" = "light") {
1653:      Capacitor?: { Plugins?: { Haptics?: HapticsPlugin } };
1655:  ).Capacitor?.Plugins?.Haptics;
1815:      hapticTap();
3327:    if (result) hapticTap("medium");
3675:      hapticTap("medium");
4129:    hapticTap();
```

- [ ] **Step 8: Delete the definition block (`app/ITrackApp.tsx:1638-1661`)**

Lines 1636-1662 currently read (1636 is the closing brace of `useSheetDragDismiss`, 1662 opens the component):

```ts
}

/*
 * The phone's own answer to a tap. Haptics are the shell's to provide — the
 * Capacitor plugin injects itself into the page at runtime — so this looks the
 * plugin up on every call and does nothing when it is not there. That is the
 * whole error path: on the web, and in any shell built before the plugin
 * landed, a missing rumble is not a failure worth reporting.
 */
type HapticsPlugin = {
  impact?: (options: { style: string }) => Promise<void> | void;
};

function hapticTap(style: "light" | "medium" = "light") {
  if (typeof window === "undefined") return;
  const haptics = (
    window as unknown as {
      Capacitor?: { Plugins?: { Haptics?: HapticsPlugin } };
    }
  ).Capacitor?.Plugins?.Haptics;
  const impact = haptics?.impact?.({
    style: style === "light" ? "LIGHT" : "MEDIUM",
  });
  void Promise.resolve(impact).catch(() => {});
}

export function ITrackApp() {
```

Delete lines 1638-1661 inclusive (the comment, the type, the function, and the blank line after it) so that exactly one blank line separates the two:

```ts
}

export function ITrackApp() {
```

- [ ] **Step 9: Run typecheck to see the four dangling calls**

Run: `npm run typecheck`
Expected: FAIL with four `error TS2304: Cannot find name 'hapticTap'.` in `app/ITrackApp.tsx` at lines 1791, 3303, 3651 and 4105 (the original 1815, 3327, 3675, 4129 shifted up by the 24 deleted lines). Confirm the same four with `grep -n "hapticTap" app/ITrackApp.tsx`.

- [ ] **Step 10: Delete the four calls and their orphaned comments (bottom-up)**

(a) `selectTab` — lines 4104-4106 read:

```ts
  function selectTab(tab: TabName) {
    hapticTap();
    if (tab !== view) {
```

Delete the `    hapticTap();` line (4105).

(b) `handleAcceptance` success path — lines 3648-3652 read:

```ts
    if (result) {
      // The end of a renewal cycle is the one moment in this app worth
      // feeling, so it gets the firmer of the two taps.
      hapticTap("medium");
      setAcceptanceOpen(false);
```

Delete the two comment lines and the call (3649-3651); keep `if (result) {` and `setAcceptanceOpen(false);`.

(c) `addActivity` success path — lines 3301-3304 read:

```ts
    // The record is saved at this point whatever happens to the proof file
    // below, and this is the confirmation the hand gets for it.
    if (result) hapticTap("medium");
    if (result?.id && hasEvidenceFile && evidenceFile) {
```

Delete the two comment lines and the call (3301-3303); the next line `if (result?.id && hasEvidenceFile && evidenceFile) {` stays.

(d) `openActivityEntryFor` — lines 1789-1792 read:

```ts
  const openActivityEntryFor = useCallback(
    (preselectCredentialId: string) => {
      hapticTap();
      // A stale message from an earlier attempt must not greet a fresh sheet.
```

Delete the `      hapticTap();` line (1791).

No replacement anywhere — do not add `navigator.vibrate`.

- [ ] **Step 11: Run to green**

Run: `grep -rn "hapticTap\|HapticsPlugin\|Capacitor" app tests; npm run typecheck && npm run lint && node --test tests/protected-identifiers.test.mjs tests/app-source-guards.test.mjs`
Expected: the grep prints exactly one line — `app/globals.css:33:   * face is the single loudest tell that a Capacitor shell is a website, and` (a comment, rewritten in Commit 3) — then typecheck silent, lint PASS, both test files PASS (`tests/app-source-guards.test.mjs` still finds `screen screen-root … inert={Boolean(detailCredential)}`, the `handleSessionEnded` modal set and the sign-out form; nothing it guards was touched).

- [ ] **Step 12: Commit**

```bash
git branch --show-current   # feat/wave2-foundation
git add app/ITrackApp.tsx
git commit -m "refactor: delete hapticTap and its four calls — the only Capacitor global (architecture-08, ios-coupling-06)

No replacement: navigator.vibrate is Android-only and iOS Safari has no
haptics API. The rendered-html pins on these lines went with Task 5.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

**Commit 3 of 5 — strip the Capacitor-shell rationale (ios-coupling-09/12).** Comments and prose only; no CSS value, no JS, no test regex changes. The red/green is the residue grep in Step 13, which must go from 7 hits to 0.

- [ ] **Step 13: The failing check**

Run:

```bash
grep -rn "Capacitor\|server\.url\|the shell's hardware\|iOS-style nav stack\|native mobile packaging\|There is no webfont\|no webfont variable\|on an iPhone it is San Francisco\|Francisco on the phone" app tests README.md docs/DESIGN-SYSTEM.md
```

Expected: 12 lines — `app/globals.css:31` and `:33`, `app/layout.tsx:103`, `app/credentials/page.tsx:5`, `app/lib/navigation.ts:1`, `app/ITrackApp.tsx` (the `the shell's hardware` line, 2456 after Commit 2), `tests/rendered-html.test.mjs` (the `server.url` comment line), `README.md:120`, and four `docs/DESIGN-SYSTEM.md` lines (`on an iPhone it is San Francisco`, `There is no webfont and no serif`, `Francisco on the phone`, `Capacitor shell is a website` — 18, 19, 128 and 129 at `main`, possibly shifted by Task 6). After Step 22 the same command prints nothing.

- [ ] **Step 14: `app/globals.css:30-37` — the TYPEFACE comment**

Verify: `grep -n "TYPEFACE" app/globals.css` → `31`. Lines 30-40 read:

```css
  /*
   * TYPEFACE — one stack for everything. There is no webfont: on the phone
   * this resolves to San Francisco, which is the point. A downloaded display
   * face is the single loudest tell that a Capacitor shell is a website, and
   * it also costs a render-blocking round trip on the first paint the app
   * shows. Display sizes are now the same face carried by weight and tracking
   * (600 and -0.02em or tighter) rather than by a second family.
   */
  --font-ui:
    -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI",
    Roboto, sans-serif;
```

Replace lines 30-37 (the comment only) with:

```css
  /*
   * TYPEFACE — one stack for everything. The constraint is that no font
   * request blocks first paint: a self-hosted subset with font-display: swap
   * is allowed, and the system stack is the fallback. Display sizes are the
   * same face carried by weight and tracking.
   */
```

The `--font-ui` value (38-40) is untouched — Wave 3 changes tokens, not this task. The comment carries no `--token n:1 on --surface` claim line, so `tools/contrast-audit.mjs` is unaffected (it strips comments before the literal scan).

- [ ] **Step 15: `app/layout.tsx:101-105` — the "no webfont" JSX comment**

Verify: `grep -n "No font className" app/layout.tsx` → `102`. Lines 101-105 read:

```tsx
      {/*
       * No font className: the app is set in the platform UI face
       * (--font-ui in globals.css), so there is no webfont variable to hang
       * on the body and no font request on the critical path.
       */}
```

Replace with:

```tsx
      {/*
       * No font className: nothing requests a font on the critical path;
       * --font-ui in globals.css is the system stack.
       */}
```

`<body>` and the metadata/viewport blocks (`:31-47`, `:75-90`, keep-list) are untouched.

- [ ] **Step 16: `app/credentials/page.tsx:3-6` — drop `server.url`**

Lines 3-6 read:

```ts
// A tab root from the URL contract in app/lib/navigation.ts. The client router
// only ever replaces the address bar, but a refresh, a deep link, or the iOS
// shell reloading its `server.url` all hit the server at this path — without a
// page here they would 404 instead of restoring the tab.
```

Replace with:

```ts
// A tab root from the URL contract in app/lib/navigation.ts. The client router
// only ever replaces the address bar, but a refresh or a deep link hits the
// server at this path — without a page here they would 404 instead of
// restoring the tab.
```

`app/history/page.tsx` and `app/profile/page.tsx` say "see app/credentials/page.tsx for why" and `app/credentials/[credentialId]/page.tsx` says "serve the same shell" (the HTML shell) — none needs a change.

- [ ] **Step 17: `app/lib/navigation.ts:1`**

Line 1 reads `// The URL contract for the iOS-style nav stack.` Replace with:

```ts
// The URL contract for the nav stack.
```

Line 6 (`` `popstate` from the hardware/edge-swipe back gesture ``) is web-accurate (Android hardware back, iOS Safari edge swipe) and stays. Nothing else in the keep-listed module changes.

- [ ] **Step 18: `app/ITrackApp.tsx` — "the shell's hardware back"**

Verify: `grep -n "the shell's hardware" app/ITrackApp.tsx` → one line (2456 after Commit 2; 2480 at `main`). The three lines around it read:

```ts
  // transition. This shape also means *every* pop animates — the back control,
  // the edge gesture, the browser's own back button, the shell's hardware
  // back — because it watches the route rather than the thing that moved it.
```

Replace those three lines with:

```ts
  // transition. This shape also means *every* pop animates — the back control,
  // the edge gesture, the browser's own back button — because it watches the
  // route rather than the thing that moved it.
```

- [ ] **Step 19: `tests/rendered-html.test.mjs` — the `server.url` comment**

Locate: `grep -n "the iOS shell reloading" tests/rendered-html.test.mjs` → one line (654 at `main`, ≈640 after Task 5). The comment under `await t.test("serves the app shell at every routed tab path", async () => {` reads:

```js
    // The nav stack writes real URLs (app/lib/navigation.ts), so a refresh, a
    // deep link, or the iOS shell reloading its `server.url` can land on any
    // of these. Each has to return the same shell rather than a 404, and each
    // has to hydrate against the home root — the server has no window, so the
    // tab is only adopted client-side.
```

Replace those five lines with:

```js
    // The nav stack writes real URLs (app/lib/navigation.ts), so a refresh or
    // a deep link can land on any of these. Each has to return the same shell
    // rather than a 404, and each has to hydrate against the home root — the
    // server has no window, so the tab is only adopted client-side.
```

"the same shell" here is the HTML app shell and stays. No assertion changes.

- [ ] **Step 20: `README.md:120`**

Line 120 reads `- richer offline capture, native mobile packaging, and regulator/provider integrations`. Replace with:

```markdown
- richer offline capture and regulator/provider integrations
```

(Spec §11: native apps are out of scope. Line 34 "home-screen and standalone-app support" is PWA installability and stays.)

- [ ] **Step 21: `docs/DESIGN-SYSTEM.md` — Character paragraph and Typography section**

Locate both by text (Task 6 edits lines above them):

```bash
grep -n "on an iPhone it is San Francisco\|There is no webfont and no serif\|^weight and tracking\.$\|One family for everything\|Francisco on the phone\|Capacitor shell is a website\|first paint the app shows\." docs/DESIGN-SYSTEM.md
```

Expected: seven hits (18, 19, 20, 127, 128, 129, 130 at `main`). The first three lines read:

```markdown
in small steps. Type is the system stack, so on an iPhone it is San Francisco.
There is no webfont and no serif: display sizes are the same face carried by
weight and tracking.
```

Replace those three lines with these two:

```markdown
in small steps. Type is the system stack; nothing loads on the critical path.
Display sizes are the same face carried by weight and tracking.
```

The last four lines (the paragraph directly under `## Typography`) read:

```markdown
One family for everything — `--font-ui`, the system stack, which resolves to San
Francisco on the phone. A downloaded display face is the loudest tell that a
Capacitor shell is a website, and it costs a render-blocking round trip on the
first paint the app shows.
```

Replace with:

```markdown
One family for everything — `--font-ui`, the system stack. The constraint is no
render-blocking font request on first paint; a self-hosted subset with
`font-display: swap` is allowed and the system stack is the fallback
(ios-coupling-09).
```

The line `` `--text-lg 17` · `--text-control 16` (editable values — the iOS zoom floor). `` further down stays (the 16px floor is a genuine iOS Safari rule, keep-list). The Sheets/grabber and "native controls" prose under Geometry and Scheme mechanics stays (Wave 3 inputs).

- [ ] **Step 22: Run to green**

Run the Step 13 grep again — Expected: no output. Then:

```bash
npm run typecheck && npm run lint && node tools/contrast-audit.mjs && node --test tests/protected-identifiers.test.mjs tests/app-source-guards.test.mjs
```

Expected: silent / PASS / the audit exits 0 with 0 failures and 0 literals / both files PASS.

- [ ] **Step 23: Commit**

```bash
git branch --show-current   # feat/wave2-foundation
git add app/globals.css app/layout.tsx app/credentials/page.tsx app/lib/navigation.ts app/ITrackApp.tsx tests/rendered-html.test.mjs README.md docs/DESIGN-SYSTEM.md
git commit -m "docs: strip the Capacitor-shell rationale from comments, README and DESIGN-SYSTEM (ios-coupling-09/12)

Comments and prose only: the typeface rule now states its real constraint (no
render-blocking font request on first paint; system stack as fallback), the
route/nav comments lose server.url and the shell's hardware back, README drops
native mobile packaging. No CSS value, JS or test assertion changes.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

**Commit 4 of 5 — the dead fonts (perf-08).** The deletion itself is local (the cache is gitignored); the commit is the `.dockerignore` line and the test that keeps the output clean.

- [ ] **Step 24: Write the failing test**

Create `tests/dist-hygiene.test.mjs`:

```js
// Build-output hygiene (audit perf-08). vinext copies its whole `.vinext/fonts`
// Google-Fonts cache into dist/client/assets/_vinext_fonts/ on every client
// build with no reference check, and its server build sets emptyOutDir: false,
// so a cache left behind by a removed `next/font` import ships dead woff2
// files until someone deletes it. Nothing in app/ requests a font. `npm test`
// builds before running this file, so the dist assertion sees the build it
// just made; with no dist at all it is vacuously true.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the build emits no cached Google-Fonts files (perf-08)", () => {
  assert.ok(
    !existsSync(path.join(root, "dist", "client", "assets", "_vinext_fonts")),
    "delete .vinext/fonts (vinext copies the whole cache into dist) plus any stale dist/client/assets/_vinext_fonts, then rebuild",
  );
  assert.match(
    readFileSync(path.join(root, ".dockerignore"), "utf8"),
    /^\.vinext$/m,
    ".dockerignore must list .vinext so a local docker build cannot carry the font cache into the image",
  );
});
```

- [ ] **Step 25: Run it to see it fail**

Run: `ls dist/client/assets/_vinext_fonts && node --test tests/dist-hygiene.test.mjs`
Expected: `ls` lists `manrope-76eca2803f7f newsreader-94c054835b7e` (left by the last build), then `not ok 1 - the build emits no cached Google-Fonts files (perf-08)` with `error: 'delete .vinext/fonts (vinext copies the whole cache into dist) plus any stale dist/client/assets/_vinext_fonts, then rebuild'`. (If `dist/` is absent on this machine the first assertion is vacuously true and the failure is the `.dockerignore` one instead: `.dockerignore must list .vinext …`.)

- [ ] **Step 26: Delete the cache locally and exclude it from the Docker context**

```bash
find .vinext/fonts -name '*.woff2' | wc -l      # 9
rm -rf .vinext/fonts dist/client/assets/_vinext_fonts
tail -c 1 .dockerignore | od -c                 # \n — the file ends with a newline, so the append is a clean line
printf '.vinext\n' >> .dockerignore
cat .dockerignore
```

Expected `.dockerignore` afterwards:

```
node_modules
dist
.wrangler
.git
.next
*.log
.vinext
```

`git status --short` shows ` M .dockerignore` and `?? tests/dist-hygiene.test.mjs` only — `.vinext/` is gitignored (`.gitignore:18`), so the `rm` is not a repo change and every other machine must run the same `rm -rf .vinext/fonts` once (the test's message says so).

- [ ] **Step 27: Rebuild and confirm the build no longer emits the fonts**

Stop any `npm run dev` server first (shared `.wrangler/` state). Run:

```bash
npm run build && ls dist/client/assets/_vinext_fonts
```

Expected: the build completes ("Build complete") and `ls` prints `ls: dist/client/assets/_vinext_fonts: No such file or directory`. The `writeBundle` hook returns early because `.vinext/fonts` no longer exists (`fonts.js:588`), and nothing under `app/` imports `next/font` to recreate it (`grep -rn "next/font" app` → nothing).

- [ ] **Step 28: Run to green**

Run: `node --test tests/dist-hygiene.test.mjs && npm run typecheck && npm run lint`
Expected: `# pass 1` / `# fail 0`, typecheck silent, lint PASS. (Task 13's Docker run-check is the gate for the image itself; to spot-check now with Docker running: `docker build -t itrack-wave2-fonts . && docker run --rm itrack-wave2-fonts find /app/dist -name '*.woff2'` prints nothing.)

- [ ] **Step 29: Commit**

```bash
git branch --show-current   # feat/wave2-foundation
git add .dockerignore tests/dist-hygiene.test.mjs
git commit -m "chore: exclude the vinext font cache from the image and pin dist hygiene (perf-08)

The 9 dead Manrope/Newsreader woff2 (181,136 B) were never in git: they are
the gitignored .vinext/fonts cache that vinext's writeBundle hook copies into
dist/client/assets/_vinext_fonts on every build. Deleted locally; .dockerignore
keeps the cache out of the Docker context; the new test fails any build that
emits _vinext_fonts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

**Commit 5 of 5 — history (ios-coupling-12).** The specs and plans stay as history with a one-line header; TC-002 closes as `retired`. `docs/audits/` and `.superpowers/sdd/` are not edited.

- [ ] **Step 30: Add the Retired / Superseded headers**

Each insertion is one blank line plus one blockquote line, so the header field block above stays intact and the quote renders as its own paragraph. Insert the Retired line into the four iOS docs:

```markdown
> Retired 2026-09-10 — the iOS shell is withdrawn; superseded by docs/superpowers/specs/2026-09-10-itrack-web-redesign-design.md.
```

(a) `docs/superpowers/specs/2026-08-03-itrack-ios-design.md` — after line 3 (`**Date:** 2026-08-03 · **Status:** Approved by Chris · **Tracking:** TC-002-08-03-26-ios-appstore-app`). Lines 3-7 become:

```markdown
**Date:** 2026-08-03 · **Status:** Approved by Chris · **Tracking:** TC-002-08-03-26-ios-appstore-app

> Retired 2026-09-10 — the iOS shell is withdrawn; superseded by docs/superpowers/specs/2026-09-10-itrack-web-redesign-design.md.

## Goal
```

(b) `docs/superpowers/specs/2026-08-11-ios-native-nav-retheme-design.md` — after line 4 (`**Status:** Approved by Chris (approach + design outline approved in session)`). Lines 4-8 become:

```markdown
**Status:** Approved by Chris (approach + design outline approved in session)

> Retired 2026-09-10 — the iOS shell is withdrawn; superseded by docs/superpowers/specs/2026-09-10-itrack-web-redesign-design.md.

## Problem
```

(c) `docs/superpowers/plans/2026-08-03-itrack-ios.md` — after line 5 (the `**Goal:** A private TestFlight iOS app wrapping the hosted iTrack web app, …` line). Lines 5-9 become:

```markdown
**Goal:** A private TestFlight iOS app wrapping the hosted iTrack web app, adding APNs push reminders, WidgetKit widgets, and VisionKit certificate scanning; backend gains the APNs sender, widget endpoint, token registration, and re-enabled auth.

> Retired 2026-09-10 — the iOS shell is withdrawn; superseded by docs/superpowers/specs/2026-09-10-itrack-web-redesign-design.md.

**Architecture:** Two codebases. Backend work (Tasks 1–8) lands in the existing iTrack repo (`~/Documents/New project/Vigilo`): a new APNs delivery lib mirroring the existing web-push delivery, two small API routes, env plumbing. iOS work (Tasks 9–13) lands in a NEW repo `~/Documents/New project/iTrack-iOS`: a Capacitor shell with `server.url` pointing at Railway prod, plus Swift for auth, push, widgets, and scanning.
```

(d) `docs/superpowers/plans/2026-08-11-ios-native-nav-retheme.md` — after line 5 (the `**Goal:** Make the iTrack web app (served into the Capacitor iPhone shell) navigate and look like a native iOS app: …` line), the same blank line + Retired line, before `**Architecture:**`. Its line 19 ("/ must keep rendering the app shell unchanged (widget/notification deep links depend on it)") is history under this header and is not edited.

Insert the Superseded line into the public-signup pair:

```markdown
> Superseded 2026-09-10 — Basic auth and the iOS client it served were removed in Wave 1 (docs/superpowers/plans/2026-09-10-itrack-wave1-stop-the-bleeding.md); the session-cookie gateway is authoritative.
```

(e) `docs/superpowers/specs/2026-08-11-itrack-public-signup-design.md` — after line 5 (`**Approach:** A — auth gateway in the Railway proxy (`deploy/railway/serve.mjs`)`, the last header field). Lines 5-9 become:

```markdown
**Approach:** A — auth gateway in the Railway proxy (`deploy/railway/serve.mjs`)

> Superseded 2026-09-10 — Basic auth and the iOS client it served were removed in Wave 1 (docs/superpowers/plans/2026-09-10-itrack-wave1-stop-the-bleeding.md); the session-cookie gateway is authoritative.

## Goal
```

(f) `docs/superpowers/plans/2026-08-11-itrack-public-signup.md` — after line 5 (the `**Goal:** Public visitors to iTrack get a marketing landing page … keeps working for the iOS app and env-var users.` line), blank line + Superseded line, before `**Architecture:**`.

Verify:

```bash
grep -n "^> Retired 2026-09-10\|^> Superseded 2026-09-10" docs/superpowers/specs/2026-08-03-itrack-ios-design.md docs/superpowers/specs/2026-08-11-ios-native-nav-retheme-design.md docs/superpowers/specs/2026-08-11-itrack-public-signup-design.md docs/superpowers/plans/2026-08-03-itrack-ios.md docs/superpowers/plans/2026-08-11-ios-native-nav-retheme.md docs/superpowers/plans/2026-08-11-itrack-public-signup.md
```

Expected: six hits at lines 5, 6, 7, 7, 7, 7 respectively, four `Retired` and two `Superseded`. No test reads these documents.

- [ ] **Step 31: Retire TC-002 in the record and the registry**

`docs/TC/records/TC-002-08-03-26-ios-appstore-app/tc_record.json` currently has `"status": "implemented"`, `"updated": "2026-08-04T03:59:49+00:00"`, `metadata.last_modified` equal to `updated` (the tracker keeps the two equal — R5 set both), and `revision_history` ending at `R6`. `docs/TC/tc_registry.json` has the TC-002 row at `"status": "implemented"` and `statistics.by_status` = `planned 0, in_progress 0, blocked 0, implemented 1, tested 0, deployed 1` with no `retired` key. Both files are 2-space JSON with a trailing newline and no non-ASCII, so re-serialising with `JSON.stringify(…, null, 2) + "\n"` changes only the intended lines. Run from the repo root (one timestamp, used in both files):

```bash
STAMP="$(date -u +%Y-%m-%dT%H:%M:%S+00:00)"
echo "$STAMP"
node --input-type=module - "$STAMP" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const stamp = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/.test(stamp)) throw new Error(`bad stamp: ${stamp}`);
const recordPath = "docs/TC/records/TC-002-08-03-26-ios-appstore-app/tc_record.json";
const record = JSON.parse(readFileSync(recordPath, "utf8"));
if (record.status !== "implemented") throw new Error(`expected status implemented, found ${record.status}`);
if (record.revision_history.at(-1).revision_id !== "R6") throw new Error("expected R6 to be the last revision");
record.status = "retired";
record.updated = stamp;
record.metadata.last_modified = stamp;
record.revision_history.push({
  revision_id: "R7",
  timestamp: stamp,
  author: "Claude",
  summary: "status: implemented -> retired (iOS shell withdrawn 2026-09-10; superseded by the web redesign spec)",
  field_changes: [
    { field: "status", action: "set", old_value: "implemented", new_value: "retired", reason: "web-only pivot" },
  ],
});
writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
const registryPath = "docs/TC/tc_registry.json";
const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const entry = registry.records.find((row) => row.tc_id === "TC-002-08-03-26-ios-appstore-app");
if (entry.status !== "implemented") throw new Error(`registry: expected implemented, found ${entry.status}`);
entry.status = "retired";
entry.updated = stamp;
registry.updated = stamp;
registry.statistics.by_status.implemented = 0;
registry.statistics.by_status.retired = 1;
writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
EOF
git diff --stat docs/TC
```

Expected `git diff --stat`: `tc_record.json | 21 ++++++++++++++++++---` (18 insertions, 3 deletions: `status`, `updated`, `metadata.last_modified`, and the 15-line R7 entry appended after R6's closing brace) and `tc_registry.json | 11 ++++++-----` (6 insertions, 5 deletions: top-level `updated`, the row's `status` and `updated`, `implemented: 0`, and `"retired": 1` added after `"deployed": 1`). `git diff docs/TC/tc_registry.json` ends with:

```
-      "deployed": 1
+      "deployed": 1,
+      "retired": 1
```

- [ ] **Step 32: Verify the two files agree**

```bash
node --input-type=module -e '
import { readFileSync } from "node:fs";
const record = JSON.parse(readFileSync("docs/TC/records/TC-002-08-03-26-ios-appstore-app/tc_record.json", "utf8"));
const registry = JSON.parse(readFileSync("docs/TC/tc_registry.json", "utf8"));
const entry = registry.records.find((row) => row.tc_id === "TC-002-08-03-26-ios-appstore-app");
const sum = Object.values(registry.statistics.by_status).reduce((a, b) => a + b, 0);
console.log(JSON.stringify({ recordStatus: record.status, lastRevision: record.revision_history.at(-1).revision_id, registryStatus: entry.status, retired: registry.statistics.by_status.retired, implemented: registry.statistics.by_status.implemented, sum, total: registry.statistics.total, stampsEqual: record.updated === entry.updated && entry.updated === registry.updated }));
'
```

Expected: `{"recordStatus":"retired","lastRevision":"R7","registryStatus":"retired","retired":1,"implemented":0,"sum":2,"total":2,"stampsEqual":true}`.

- [ ] **Step 33: Commit**

```bash
git branch --show-current   # feat/wave2-foundation
git add docs/superpowers/specs/2026-08-03-itrack-ios-design.md docs/superpowers/specs/2026-08-11-ios-native-nav-retheme-design.md docs/superpowers/specs/2026-08-11-itrack-public-signup-design.md docs/superpowers/plans/2026-08-03-itrack-ios.md docs/superpowers/plans/2026-08-11-ios-native-nav-retheme.md docs/superpowers/plans/2026-08-11-itrack-public-signup.md docs/TC/records/TC-002-08-03-26-ios-appstore-app/tc_record.json docs/TC/tc_registry.json
git commit -m "docs: retire the iOS specs/plans and TC-002 (ios-coupling-12)

One-line Retired header on the two iOS specs and plans, Superseded header on
the public-signup spec/plan (Basic auth went in Wave 1), TC-002 status
implemented -> retired with revision R7 and the registry counts mirrored.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

- [ ] **Step 34: Final verify — full suite**

Stop any `npm run dev` server. Run:

```bash
npm run typecheck && npm run lint && npm test
```

Expected: typecheck silent, lint PASS, `npm test` builds (the build log shows no `_vinext_fonts` copy), then every file under `tests/*.test.mjs` passes, including `tests/protected-identifiers.test.mjs` (10) and `tests/dist-hygiene.test.mjs` (1); `tests/contrast-audit.test.mjs` (Task 6) still exits 0 after the `globals.css` comment rewrite.

- [ ] **Step 35: Final verify — e2e (this task touched `app/`)**

Start the dev server in another terminal: `npm run dev` (leave it running). Then:

Run: `npm run test:e2e`
Expected: PASS on all four projects — every spec Tasks 3–4 wrote (home, credentials, credential-detail, log-activity, history, profile, packet, session-ended-mid-save); tapping tabs, opening the log sheet and accepting a renewal no longer call `hapticTap`, which was a no-op on the web, so nothing observable changed. Stop the dev server afterwards (before any later `npm run build`).

- [ ] **Step 36: Final verify — residue and the five commits**

```bash
grep -rn "hapticTap\|Capacitor\|server\.url" app tests README.md docs/DESIGN-SYSTEM.md   # no output
grep -rn "the shell's hardware\|iOS-style nav stack\|native mobile packaging\|no webfont" app tests README.md docs/DESIGN-SYSTEM.md   # no output
ls dist/client/assets/_vinext_fonts 2>&1                                                  # No such file or directory
grep -n "^\.vinext$" .dockerignore                                                        # 7:.vinext
git status --short                                                                        # clean
git log --oneline -5
```

Expected `git log` (newest first): `docs: retire the iOS specs/plans and TC-002 (ios-coupling-12)`, `chore: exclude the vinext font cache from the image and pin dist hygiene (perf-08)`, `docs: strip the Capacitor-shell rationale from comments, README and DESIGN-SYSTEM (ios-coupling-09/12)`, `refactor: delete hapticTap and its four calls — the only Capacitor global (architecture-08, ios-coupling-06)`, `test: pin the seven load-bearing legacy identifiers (ios-coupling-11)`.

---

### Task 8: Migration `0014_credential_archive` — `credentials.revision` + `archived_at`, read side (`archivedCredentials`), reminder/packet awareness, archived gating

**Rationale:** spec §4 bullet 4 (`archiveCredential`: hidden from Home/Credentials, visible under Activity log → Archived, reversible; revision-guarded like `updateActivity`), spec §8 (migrations continue in `drizzle/`), finding app-ux-03. This task lays the data foundation Task 9's four actions stand on; it adds **no** workspace action. **Why a column, not a status:** `status IN ('active','submitted')` / `status = 'renewed'` is load-bearing in 13+ trigger WHEN clauses (`db/runtime.ts:526-947`) and in every route guard; archive must be orthogonal and reversible, so it is a nullable `archived_at` exactly like `activities.archived_at` (`db/schema.ts:243-269`) and `checklist_tasks.archived_at`. **Why `db/runtime.ts` too:** `initializeDatabase` (`db/runtime.ts:5968-6006`), not drizzle, is what the Railway volume executes, and `ensureRichRuleColumns` (`:5619-5648`) iterates a fixed table list that omits `credentials` — without the list change an existing volume never gets the columns. **Why the rendered-html SQL matchers change:** the FakeDatabase resolvers in `tests/rendered-html.test.mjs` dispatch on the exact credential-lookup SQL (`isOwnedCredentialCycleLookup` at `:39-43` plus ten inline regexes); adding `archived_at AS archivedAt` to those lookups means each matcher gains an optional group, exactly as `isOwnedActivityCycleLookup` (`:45-49`) already carries `(?:, revision)?(?:, archived_at AS archivedAt)?` from the activities archive. These are stub dispatchers, not the client-source pins that ios-coupling-15 forbids editing; a fixture row without `archivedAt` reads as "not archived", so every existing fake keeps passing.

Line numbers below are at `main@8ac172a`. Task 2 (route.ts `:11689-11810`) and Task 5 (whole-subtest deletions in `tests/rendered-html.test.mjs`) land before this task on the branch and shift lines, so re-locate every site with the `grep` given in its step before editing; the quoted text, not the number, is the anchor.

**Files:**
- Modify: `db/schema.ts:116-142` (`credentials` table: two columns + one index)
- Create: `drizzle/0014_credential_archive.sql`, `drizzle/meta/0014_snapshot.json` (both generated); Modify: `drizzle/meta/_journal.json` (generated, idx 14)
- Modify: `db/runtime.ts:157-174` (credentials DDL), `RICH_RULE_COLUMNS:949-1072` (append two entries), `RICH_RULE_INDEX_STATEMENTS:1074-1083` (append one), `ensureRichRuleColumns:5619-5629` (+ `"credentials"` in the table list)
- Modify: `app/api/workspace/route.ts` — revision bumps at `:8035-8036`, `:10193-10194`, `:11195-11202`, `:11261-11268`; `CredentialRow:4149-4179`; credential SELECT `:4285-4348`; `getWorkspace` return `:5142-5218`; `assertCredentialStillMutable:3962-3983` (+ new `CREDENTIAL_ARCHIVED_MESSAGE` / `assertCredentialNotArchived` above it); inline lookups in `addActivity:5902-5930`, `createPersonalTask:7148-7166`, `markSubmitted:7881-7896`, `addActivityAllocation:8256-8289`, `markRenewalAccepted:9028-9140`, `updateRequirementApplicability:10818-10856`, `setReminderState:12141-12151`
- Modify: `app/lib/reminders.ts:250` and `:273` (two `AND credential.archived_at IS NULL` lines), `app/api/export/packet/route.ts:111-113`
- Create: `tests/workspace-credential-actions.test.mjs`
- Modify: `tests/real-sqlite-seed.test.mjs` (one new subtest after "APNs tables are dropped by initialization (migration 0013)"), `tests/rendered-html.test.mjs` (`:39-43` helper regex + inline matcher regexes at `:14633, 14855, 14934, 16529, 23935` / `:17652, 17740, 17822, 17913` / `:20891`; migration subtest `:7825-7995`; journal pins `:8069-8070` and `:8448-8449`)
- Test: `tests/workspace-credential-actions.test.mjs`, `tests/real-sqlite-seed.test.mjs`, `tests/rendered-html.test.mjs`, `tests/isolation.test.mjs`

**Interfaces:**
- Consumes: Task 1 — `tests/isolation.test.mjs` is committed and green before this task's first edit to `app/api/workspace/route.ts` or `db/**` (spec §4); its 23-action enumeration is unchanged by this task (no new action) and its `addActivity` / `createPersonalTask` / `markSubmitted` / `addActivityAllocation` / `markRenewalAccepted` / `updateRequirementApplicability` / `setReminderState` foreign-id probes still answer 404 `credential_not_found` because the ownership 404 stays ahead of the new 409. The real-SQLite shims (`SQLiteD1Statement`, `SQLiteD1Database`, `FakeEvidenceBucket`) are copied verbatim from `tests/rendered-html.test.mjs:158-275`, never imported.
- Produces:
  - Columns `credentials.revision INTEGER NOT NULL DEFAULT 1` and `credentials.archived_at TEXT`; index `credentials_user_archive_deadline_idx (user_id, archived_at, deadline)`; drizzle journal idx 14 tag `0014_credential_archive`.
  - `getWorkspace` returns `credentials[]` (non-archived rows, each with `revision: number` and `archivedAt: null`) and `archivedCredentials[]` (same shape, `archivedAt: string`), placed **before** `activities:` so the `archivedTasksByCredential…archivedActivities` order pin (`tests/rendered-html.test.mjs:8477-8480`) holds and the JSON key order is `credentials, archivedCredentials, activities, archivedActivities`.
  - `route.ts`: `const CREDENTIAL_ARCHIVED_MESSAGE = "This credential is archived. Restore it before making changes."` and `function assertCredentialNotArchived(credential: { archivedAt: string | null }): void` — throws `RequestError(CREDENTIAL_ARCHIVED_MESSAGE, 409, "credential_archived")`; Task 9's `assertCredentialMutationState` reuses both.
  - Every lifecycle write bumps `credentials.revision` (`markSubmitted`, `markRenewalAccepted`, both `total_required` rewrites in `updateRequirementApplicability`), so a stale `expectedRevision` cannot pass after one.
  - `tests/workspace-credential-actions.test.mjs` harness, reused in place by Task 9 (it adds subtests to this file): `boot({ legacyCredentialsTable?: boolean }) → { db, bucket, fetchAs(email, path, init), post(email, action, payload) → { status, body }, workspace(email) → json, raw(sql, ...bindings) → rows }` (`fetchAs` sets `accept: application/json` and `oai-authenticated-user-email: <email>` on every request, lets `init.headers` override them, and sets no `content-type` of its own; `post`/`workspace` layer `identityHeaders(email)` on top), `customCredential(overrides)`, `isoDaysFromToday(days)`, constants `BASE_URL = "https://itrack.example"`, `OWNER = "owner@example.com"`, `OTHER = "other@example.com"`.

- [ ] **Step 1: Confirm the branch and that Task 1's isolation suite is green before touching `route.ts` or `db/**`**

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
git branch --show-current
git log --oneline -1 -- tests/isolation.test.mjs
npm run build && node --experimental-sqlite --test tests/isolation.test.mjs
```
Expected: `feat/wave2-foundation`; one commit listed for `tests/isolation.test.mjs`; the isolation suite PASSes. (Stop any `npm run dev` on :3000 first — it shares `.wrangler/` with the build.) If the suite is not committed, stop: Task 1 must land first.

- [ ] **Step 2: Write the failing tests**

Create `tests/workspace-credential-actions.test.mjs`:

```js
import assert from "node:assert/strict";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Real-SQLite harness for the credential lifecycle. Task 8 covers migration
// 0014 (credentials.revision / archived_at), the workspace read side
// (credentials[] vs archivedCredentials[]), reminder and packet awareness of
// archived credentials, and the 409 credential_archived gate. Task 9 adds the
// updateCredential / archiveCredential / restoreCredential / deleteCredential
// cases to this same file and reuses boot(), post() and raw().
//
// Like tests/isolation.test.mjs it drives the BUILT worker
// (dist/server/index.js — run `npm run build` first) against node:sqlite with
// PRAGMA foreign_keys = ON and never imports app/** or db/** source, so the
// route.ts decomposition cannot break it. Every boot() imports its own copy of
// the bundle through a cache-busting query string: db/runtime.ts memoises
// initializeDatabase per module instance (`initializationPromise`), so a
// second database handed to an already-initialised instance would never get
// its schema. The non-local base URL keeps the demo identity out of the way.

const testCloudflareEnv = {};
globalThis.__LICENSE_LANTERN_TEST_ENV__ = testCloudflareEnv;

const cloudflareWorkersMockUrl = `data:text/javascript,${encodeURIComponent(
  "export const env = globalThis.__LICENSE_LANTERN_TEST_ENV__;",
)}`;
const loaderSource = `
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        url: ${JSON.stringify(cloudflareWorkersMockUrl)},
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  }
`;
register(
  `data:text/javascript,${encodeURIComponent(loaderSource)}`,
  import.meta.url,
);

const BASE_URL = "https://itrack.example";
const OWNER = "owner@example.com";
const OTHER = "other@example.com";

let bootSequence = 0;
async function importWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set(
    "test",
    `${process.pid}-${Date.now()}-${bootSequence++}`,
  );
  return (await import(workerUrl.href)).default;
}

// SQLiteD1Statement, SQLiteD1Database and FakeEvidenceBucket are copied
// verbatim from tests/rendered-html.test.mjs (importing a *.test.mjs would
// re-register its tests in this process).
class SQLiteD1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.bindings = [];
  }

  bind(...bindings) {
    this.bindings = bindings;
    return this;
  }

  statement() {
    return this.database.raw.prepare(this.sql);
  }

  async first() {
    return this.statement().get(...this.bindings) ?? null;
  }

  async all() {
    return { results: this.statement().all(...this.bindings) };
  }

  async run() {
    return this.runSync();
  }

  runSync() {
    const result = this.statement().run(...this.bindings);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

class SQLiteD1Database {
  constructor(DatabaseSync) {
    this.raw = new DatabaseSync(":memory:");
    this.raw.exec("PRAGMA foreign_keys = ON");
  }

  prepare(sql) {
    return new SQLiteD1Statement(this, sql);
  }

  async batch(statements) {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.raw.close();
  }
}

class FakeEvidenceBucket {
  constructor() {
    this.puts = [];
    this.gets = [];
    this.deletes = [];
    this.objects = new Map();
  }

  async head(key) {
    return this.objects.get(key) ?? null;
  }

  async get(key) {
    this.gets.push(key);
    return this.objects.get(key) ?? null;
  }

  async put(key, value, options = {}) {
    const buffer =
      value instanceof ArrayBuffer
        ? value
        : ArrayBuffer.isView(value)
          ? value.buffer.slice(
              value.byteOffset,
              value.byteOffset + value.byteLength,
            )
          : await new Response(value).arrayBuffer();
    const stored = {
      key,
      version: "test-version",
      size: buffer.byteLength,
      etag: "test-etag",
      httpEtag: '"test-etag"',
      uploaded: new Date("2026-07-25T12:00:00.000Z"),
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
      body: new Blob([buffer]).stream(),
      arrayBuffer: async () => buffer,
    };
    this.puts.push({ key, buffer, options });
    this.objects.set(key, stored);
    return stored;
  }

  async delete(keyOrKeys) {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    this.deletes.push(...keys);
    keys.forEach((key) => this.objects.delete(key));
  }
}

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

function identityHeaders(email) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "oai-authenticated-user-email": email,
  };
}

// The credentials table exactly as db/runtime.ts created it before migration
// 0014 — no revision, no archived_at. boot({ legacyCredentialsTable: true })
// creates it before the worker's first initializeDatabase so the test walks
// the ALTER TABLE backfill path an existing Railway volume goes through.
const LEGACY_CREDENTIALS_DDL = `CREATE TABLE credentials (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  rule_set_id TEXT,
  credential_name TEXT NOT NULL,
  profession TEXT NOT NULL,
  jurisdiction TEXT NOT NULL,
  issuer TEXT NOT NULL,
  cycle_start TEXT NOT NULL,
  deadline TEXT NOT NULL,
  total_required REAL NOT NULL,
  unit_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (rule_set_id) REFERENCES rule_sets(id) ON DELETE SET NULL
)`;

async function boot({ legacyCredentialsTable = false } = {}) {
  const db = new SQLiteD1Database(DatabaseSync);
  const bucket = new FakeEvidenceBucket();
  if (legacyCredentialsTable) db.raw.exec(LEGACY_CREDENTIALS_DDL);
  const worker = await importWorker();

  const fetchAs = (email, path, init = {}) => {
    // db/index.ts reads the bindings from the `cloudflare:workers` env, which
    // the loader shim maps to this shared global; point it at this boot's
    // database before every request so two boots can coexist in one file.
    testCloudflareEnv.DB = db;
    testCloudflareEnv.EVIDENCE = bucket;
    // The identity rides on every request: BASE_URL is non-local, so a bare
    // request would be anonymous (401), not the demo user. Explicit
    // init.headers win, and no content-type is set here so multipart
    // uploads keep the boundary FormData gives them.
    const headers = {
      accept: "application/json",
      "oai-authenticated-user-email": email,
      ...(init.headers ?? {}),
    };
    return worker.fetch(
      new Request(`${BASE_URL}${path}`, { ...init, headers }),
      {
        ASSETS: {
          fetch: async () => new Response("Not found", { status: 404 }),
        },
        DB: db,
        EVIDENCE: bucket,
      },
      executionContext,
    );
  };

  const post = async (email, action, payload) => {
    const response = await fetchAs(email, "/api/workspace", {
      method: "POST",
      headers: identityHeaders(email),
      body: JSON.stringify({ action, payload }),
    });
    return { status: response.status, body: await response.json() };
  };

  const workspace = async (email) => {
    const response = await fetchAs(email, "/api/workspace", {
      headers: identityHeaders(email),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text);
  };

  const raw = (sql, ...bindings) => db.raw.prepare(sql).all(...bindings);

  return { db, bucket, fetchAs, post, workspace, raw };
}

function isoDaysFromToday(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Task 3's seedCredential shape, with dates relative to today (UTC, the
// stored reminder zone every new user starts with) so the deadline sits
// inside the 30-day reminder lead window: a check-in must exist before the
// archive for "no reminders afterwards" to prove anything.
function customCredential(overrides = {}) {
  return {
    credentialName: "Task 8 custom credential",
    profession: "Counseling",
    jurisdiction: "Rhode Island",
    issuer: "Task 8 board",
    totalRequired: 10,
    unitLabel: "hours",
    cycleStart: isoDaysFromToday(-365),
    deadline: isoDaysFromToday(30),
    categories: [{ name: "General", requiredUnits: 10 }],
    ...overrides,
  };
}

test("credential archive foundation (migration 0014) on real SQLite", async (t) => {
  const api = await boot();
  let credentialId = "";
  let archivedId = "";

  await t.test(
    "a fresh boot creates credentials.revision, credentials.archived_at and the archive index",
    async () => {
      await api.workspace(OWNER); // the first request runs initializeDatabase
      const columns = api
        .raw("PRAGMA table_info(credentials)")
        .map((column) => column.name);
      assert.ok(
        columns.includes("revision"),
        `revision missing from ${columns.join(", ")}`,
      );
      assert.ok(
        columns.includes("archived_at"),
        `archived_at missing from ${columns.join(", ")}`,
      );
      const indexes = api
        .raw("PRAGMA index_list(credentials)")
        .map((index) => index.name);
      assert.ok(
        indexes.includes("credentials_user_archive_deadline_idx"),
        `archive index missing from ${indexes.join(", ")}`,
      );
    },
  );

  await t.test(
    "a new custom credential starts at revision 1 and is not archived",
    async () => {
      const created = await api.post(
        OWNER,
        "createCredential",
        customCredential(),
      );
      assert.equal(created.status, 200, JSON.stringify(created.body));
      credentialId = created.body.id;
      const workspace = await api.workspace(OWNER);
      const credential = workspace.credentials.find(
        (candidate) => candidate.id === credentialId,
      );
      assert.ok(credential, "the new credential is listed");
      assert.equal(credential.revision, 1);
      assert.equal(credential.archivedAt, null);
      assert.deepEqual(workspace.archivedCredentials, []);
    },
  );

  await t.test("markSubmitted bumps the credential revision from 1 to 2", async () => {
    const submitted = await api.post(OWNER, "markSubmitted", {
      credentialId,
      submissionDate: isoDaysFromToday(-1),
      confirmationNumber: "T8-0001",
    });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const workspace = await api.workspace(OWNER);
    assert.equal(
      workspace.credentials.find((candidate) => candidate.id === credentialId)
        ?.revision,
      2,
    );
    assert.deepEqual(
      api.raw(
        "SELECT revision, status FROM credentials WHERE id = ?",
        credentialId,
      ),
      [{ revision: 2, status: "submitted" }],
    );
  });

  await t.test(
    "a credential archived by raw SQL leaves credentials[] for archivedCredentials[]",
    async () => {
      const created = await api.post(
        OWNER,
        "createCredential",
        customCredential({ credentialName: "Task 8 archived credential" }),
      );
      assert.equal(created.status, 200, JSON.stringify(created.body));
      archivedId = created.body.id;

      const before = await api.workspace(OWNER);
      assert.ok(before.credentials.some((candidate) => candidate.id === archivedId));
      assert.ok(
        before.reminders.some((reminder) => reminder.credentialId === archivedId),
        "a deadline 30 days out produces a check-in before the archive",
      );

      api.db.raw
        .prepare(
          "UPDATE credentials SET archived_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .run(archivedId);

      const after = await api.workspace(OWNER);
      assert.equal(
        after.credentials.some((candidate) => candidate.id === archivedId),
        false,
        "archived credentials leave credentials[]",
      );
      const archived = after.archivedCredentials.find(
        (candidate) => candidate.id === archivedId,
      );
      assert.ok(archived, "archived credentials appear in archivedCredentials[]");
      assert.equal(typeof archived.archivedAt, "string");
      assert.equal(archived.revision, 1);
      assert.equal(archived.credentialName, "Task 8 archived credential");
      assert.ok(
        after.credentials.some((candidate) => candidate.id === credentialId),
        "the other credential stays visible",
      );
      const keys = Object.keys(after);
      assert.ok(
        keys.indexOf("credentials") < keys.indexOf("archivedCredentials") &&
          keys.indexOf("archivedCredentials") < keys.indexOf("activities"),
        `archivedCredentials must sit between credentials and activities: ${keys.join(", ")}`,
      );
    },
  );

  await t.test("an archived credential yields no reminders", async () => {
    const workspace = await api.workspace(OWNER);
    assert.deepEqual(
      workspace.reminders.filter(
        (reminder) => reminder.credentialId === archivedId,
      ),
      [],
    );
  });

  await t.test("an archived credential still opens as a packet", async () => {
    const response = await api.fetchAs(
      OWNER,
      `/api/export/packet?credentialId=${archivedId}`,
      {
        headers: {
          accept: "text/html",
          "oai-authenticated-user-email": OWNER,
        },
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await response.text(), /Task 8 archived credential/);
  });

  await t.test(
    "writes against an archived credential answer 409 credential_archived after the ownership 404",
    async () => {
      const activity = {
        title: "Ethics refresher",
        provider: "Task 8 provider",
        completionDate: isoDaysFromToday(-1),
        totalUnits: 2,
        allocatedUnits: 2,
        credentialId: archivedId,
      };

      const foreign = await api.post(OTHER, "addActivity", activity);
      assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
      assert.equal(foreign.body.code, "credential_not_found");

      const rejected = await api.post(OWNER, "addActivity", activity);
      assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
      assert.equal(rejected.body.code, "credential_archived");
      assert.equal(
        rejected.body.error,
        "This credential is archived. Restore it before making changes.",
      );

      const task = await api.post(OWNER, "createPersonalTask", {
        credentialId: archivedId,
        title: "Should not be created",
      });
      assert.equal(task.status, 409, JSON.stringify(task.body));
      assert.equal(task.body.code, "credential_archived");

      assert.deepEqual(api.raw("SELECT COUNT(*) AS count FROM activities"), [
        { count: 0 },
      ]);
      assert.deepEqual(
        api.raw(
          "SELECT COUNT(*) AS count FROM checklist_tasks WHERE credential_id = ? AND is_personal = 1",
          archivedId,
        ),
        [{ count: 0 }],
      );
    },
  );
});

test("booting over a pre-0014 credentials table backfills revision and archived_at", async () => {
  const api = await boot({ legacyCredentialsTable: true });
  assert.deepEqual(
    api
      .raw("PRAGMA table_info(credentials)")
      .map((column) => column.name)
      .filter((name) => name === "revision" || name === "archived_at"),
    [],
    "the legacy table must start without the two columns",
  );

  await api.workspace(OWNER); // first request: initializeDatabase + ensureRichRuleColumns

  const columns = api
    .raw("PRAGMA table_info(credentials)")
    .map((column) => column.name);
  assert.ok(columns.includes("revision"), `revision missing from ${columns.join(", ")}`);
  assert.ok(
    columns.includes("archived_at"),
    `archived_at missing from ${columns.join(", ")}`,
  );
  const indexes = api
    .raw("PRAGMA index_list(credentials)")
    .map((index) => index.name);
  assert.ok(
    indexes.includes("credentials_user_archive_deadline_idx"),
    `archive index missing from ${indexes.join(", ")}`,
  );

  const created = await api.post(OWNER, "createCredential", customCredential());
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual(
    api.raw(
      "SELECT revision, archived_at AS archivedAt FROM credentials WHERE id = ?",
      created.body.id,
    ),
    [{ revision: 1, archivedAt: null }],
  );
});
```

Then add one subtest to `tests/real-sqlite-seed.test.mjs`, immediately after the `"APNs tables are dropped by initialization (migration 0013)"` subtest (its closing `);` at line 220) and before the outer test's closing `});`:

```js
  await t.test(
    "credentials carry revision and archived_at (migration 0014)",
    async () => {
      const columnResult = await realDatabase
        .prepare("PRAGMA table_info(credentials)")
        .all();
      const columns = new Map(
        columnResult.results.map((column) => [column.name, column]),
      );
      assert.ok(columns.has("revision"), "credentials.revision must exist on a fresh boot");
      assert.ok(columns.has("archived_at"), "credentials.archived_at must exist on a fresh boot");
      assert.equal(columns.get("revision").notnull, 1);
      assert.equal(columns.get("revision").dflt_value, "1");
      assert.equal(columns.get("archived_at").notnull, 0);
      const indexResult = await realDatabase
        .prepare("PRAGMA index_list(credentials)")
        .all();
      assert.ok(
        indexResult.results.some(
          (index) => index.name === "credentials_user_archive_deadline_idx",
        ),
        "credentials_user_archive_deadline_idx must exist on a fresh boot",
      );
    },
  );
```

- [ ] **Step 3: Run the new tests to see them fail**

Run:
```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
npm run build && node --experimental-sqlite --test tests/workspace-credential-actions.test.mjs tests/real-sqlite-seed.test.mjs
```
Expected: FAIL — `workspace-credential-actions` reports `# tests 9 / # pass 1 / # fail 8`: subtest 1 `revision missing from id, user_id, rule_set_id, credential_name, profession, jurisdiction, issuer, cycle_start, deadline, total_required, unit_label, status, created_at, updated_at`; subtest 2 `undefined !== 1` (the `createCredential` POST itself answers 200 — the harness and the payload are sound); subtest 3 `undefined !== 2` (`markSubmitted` also answers 200); subtest 4 `no such column: archived_at` from the raw `UPDATE`; subtest 5 a deep-equal failure listing the credential's task and deadline check-ins (the archive never applied); subtest 6 passes (the packet opens for a live credential); subtest 7 `200 !== 409` — its foreign-identity assertion already passed, i.e. the ownership 404 fires first today; the legacy-boot test fails at the same `revision missing from …` message after a successful workspace load, which proves the second, cache-busted worker import boots cleanly over the pre-created table. In `real-sqlite-seed`: `credentials.revision must exist on a fresh boot`. Every other subtest in both files still passes.

- [ ] **Step 4: Add the columns and index to the drizzle schema**

In `db/schema.ts` (`export const credentials = sqliteTable(` at line 116), replace lines 134-141:

```ts
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("credentials_user_deadline_idx").on(table.userId, table.deadline),
    index("credentials_rule_set_idx").on(table.ruleSetId),
  ],
```

with:

```ts
    status: text("status").notNull().default("active"),
    // Migration 0014 (credential_archive): archive is a nullable timestamp,
    // never a status value — the active/submitted/renewed set is load-bearing
    // in db/runtime.ts trigger guards and every route guard. Mirrors the
    // activities / checklist_tasks revision + archived_at pair.
    revision: integer("revision").notNull().default(1),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("credentials_user_deadline_idx").on(table.userId, table.deadline),
    index("credentials_rule_set_idx").on(table.ruleSetId),
    index("credentials_user_archive_deadline_idx").on(
      table.userId,
      table.archivedAt,
      table.deadline,
    ),
  ],
```

`integer` is already imported at `db/schema.ts:6`. Verify: `grep -n 'archivedAt: text("archived_at")' db/schema.ts` → three hits (credentials, activities, checklist_tasks).

- [ ] **Step 5: Generate migration 0014**

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
npx drizzle-kit generate --name credential_archive
ls drizzle | tail -2
cat drizzle/0014_credential_archive.sql
node -e 'const s=require("./drizzle/meta/0014_snapshot.json");const j=require("./drizzle/meta/_journal.json");const e=j.entries.at(-1);console.log(s.prevId, e.idx, e.tag, e.version, s.tables.credentials.columns.revision.default, s.tables.credentials.columns.archived_at.notNull, s.tables.credentials.indexes.credentials_user_archive_deadline_idx.columns.join(","))'
git status --short drizzle
```
Expected: `drizzle/0014_credential_archive.sql` and `drizzle/meta/0014_snapshot.json` exist; the SQL reads exactly:

```sql
ALTER TABLE `credentials` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `credentials` ADD `archived_at` text;--> statement-breakpoint
CREATE INDEX `credentials_user_archive_deadline_idx` ON `credentials` (`user_id`,`archived_at`,`deadline`);
```

The `node -e` line prints `a2464b9b-ac39-4922-a0ff-0d6ee1ccfc1b 14 0014_credential_archive 6 1 false user_id,archived_at,deadline` (the `prevId` is 0013's snapshot id; journal idx 14, version "6"). `git status` shows exactly `?? drizzle/0014_credential_archive.sql`, `?? drizzle/meta/0014_snapshot.json`, ` M drizzle/meta/_journal.json`. If drizzle-kit emits any statement beyond those three, the schema drifted from the 0013 snapshot somewhere else — stop, `git diff drizzle`, and find the drift before continuing; never hand-edit a snapshot.

- [ ] **Step 6: Mirror the migration in `db/runtime.ts` (what the Railway volume actually runs)**

(a) DDL — in the `CREATE TABLE IF NOT EXISTS credentials (` statement (line 157), replace:

```ts
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (rule_set_id) REFERENCES rule_sets(id) ON DELETE SET NULL
  )`,
```

with:

```ts
    status TEXT NOT NULL DEFAULT 'active',
    revision INTEGER NOT NULL DEFAULT 1,
    archived_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (rule_set_id) REFERENCES rule_sets(id) ON DELETE SET NULL
  )`,
```

(That `status TEXT NOT NULL DEFAULT 'active',` line is the one directly under `unit_label TEXT NOT NULL,` — the only DDL block that also carries the `rule_set_id` foreign key.)

(b) `RICH_RULE_COLUMNS` (line 949) — replace its last entry and terminator:

```ts
  {
    table: "push_delivery_ledger",
    name: "dispatched_at",
    definition: "dispatched_at TEXT",
  },
] as const;
```

with:

```ts
  {
    table: "push_delivery_ledger",
    name: "dispatched_at",
    definition: "dispatched_at TEXT",
  },
  // Migration 0014 (credential_archive). Mirrored here because
  // initializeDatabase, not drizzle, is what an existing Railway volume runs;
  // ensureRichRuleColumns below must list `credentials` for these to apply.
  {
    table: "credentials",
    name: "revision",
    definition: "revision INTEGER NOT NULL DEFAULT 1",
  },
  {
    table: "credentials",
    name: "archived_at",
    definition: "archived_at TEXT",
  },
] as const;
```

(c) `RICH_RULE_INDEX_STATEMENTS` (line 1074) — replace the whole array:

```ts
const RICH_RULE_INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS rule_categories_parent_idx
    ON rule_categories (parent_category_id)`,
  `CREATE INDEX IF NOT EXISTS credential_requirements_parent_idx
    ON credential_requirements (parent_requirement_id)`,
  `CREATE INDEX IF NOT EXISTS activities_user_archive_date_idx
    ON activities (user_id, archived_at, completion_date)`,
  `CREATE INDEX IF NOT EXISTS checklist_tasks_user_credential_archive_idx
    ON checklist_tasks (user_id, credential_id, archived_at, sort_order)`,
] as const;
```

with:

```ts
const RICH_RULE_INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS rule_categories_parent_idx
    ON rule_categories (parent_category_id)`,
  `CREATE INDEX IF NOT EXISTS credential_requirements_parent_idx
    ON credential_requirements (parent_requirement_id)`,
  `CREATE INDEX IF NOT EXISTS activities_user_archive_date_idx
    ON activities (user_id, archived_at, completion_date)`,
  `CREATE INDEX IF NOT EXISTS checklist_tasks_user_credential_archive_idx
    ON checklist_tasks (user_id, credential_id, archived_at, sort_order)`,
  `CREATE INDEX IF NOT EXISTS credentials_user_archive_deadline_idx
    ON credentials (user_id, archived_at, deadline)`,
] as const;
```

(The index lives here rather than in `TABLE_STATEMENTS` because `initializeDatabase` runs these after `ensureRichRuleColumns`; on a pre-0014 volume the column must exist before the index can.)

(d) `ensureRichRuleColumns` (`grep -n "async function ensureRichRuleColumns" db/runtime.ts`) — replace its table list:

```ts
  for (const table of [
    "rule_categories",
    "credential_requirements",
    "renewal_submissions",
    "renewal_acceptances",
    "activities",
    "checklist_tasks",
    "reminder_preferences",
    "push_delivery_ledger",
  ] as const) {
```

with:

```ts
  for (const table of [
    "rule_categories",
    "credential_requirements",
    "renewal_submissions",
    "renewal_acceptances",
    "activities",
    "checklist_tasks",
    "reminder_preferences",
    "push_delivery_ledger",
    "credentials",
  ] as const) {
```

Verify: `grep -n '"credentials"' db/runtime.ts` shows the two `RICH_RULE_COLUMNS` entries and the list entry; `grep -c "credentials_user_archive_deadline_idx" db/runtime.ts db/schema.ts drizzle/0014_credential_archive.sql` → 1 each.

- [ ] **Step 7: Bump `credentials.revision` in the four lifecycle writes (`app/api/workspace/route.ts`)**

`grep -n "UPDATE credentials" app/api/workspace/route.ts` lists exactly four sites (8035, 10193, 11195, 11261 at 8ac172a).

(a) `markSubmitted` — replace:

```ts
      `UPDATE credentials
       SET status = 'submitted', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
```

with:

```ts
      `UPDATE credentials
       SET status = 'submitted', revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
```

(b) `markRenewalAccepted` — replace:

```ts
      UPDATE credentials
      SET status = 'renewed', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
```

with:

```ts
      UPDATE credentials
      SET status = 'renewed', revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
```

(c) and (d) `updateRequirementApplicability` — the Florida-nursing and dental `total_required` rewrites are byte-identical in their SET list; replace **both** occurrences of:

```ts
        `UPDATE credentials
         SET
           total_required = (
             SELECT catalog_rule.total_units + ?
             FROM rule_sets catalog_rule
             WHERE catalog_rule.id = credentials.rule_set_id
           ),
           updated_at = CURRENT_TIMESTAMP
```

with:

```ts
        `UPDATE credentials
         SET
           total_required = (
             SELECT catalog_rule.total_units + ?
             FROM rule_sets catalog_rule
             WHERE catalog_rule.id = credentials.rule_set_id
           ),
           revision = revision + 1,
           updated_at = CURRENT_TIMESTAMP
```

Verify: `grep -c "revision = revision + 1" app/api/workspace/route.ts` rises by exactly 4 (from 8 to 12 at 8ac172a). No bindings change, so every rendered-html `/UPDATE credentials SET status = 'renewed'/i` and `/^UPDATE credentials SET status = 'submitted'/i` prefix matcher still fires.

- [ ] **Step 8: Read side — `CredentialRow`, the credential SELECT, and the split return**

(a) `CredentialRow` inside `getWorkspace` (`grep -n "type CredentialRow = {" app/api/workspace/route.ts`) — replace:

```ts
    previousCredentialId: string | null;
    status: string;
    submittedAt: string | null;
```

with:

```ts
    previousCredentialId: string | null;
    status: string;
    revision: number;
    archivedAt: string | null;
    submittedAt: string | null;
```

(b) The credential SELECT (`grep -n "cycle.previous_credential_id AS previousCredentialId," app/api/workspace/route.ts` — the first hit, inside `getWorkspace`) — replace:

```ts
        cycle.previous_credential_id AS previousCredentialId,
        c.status,
        rs.source_url AS sourceUrl,
```

with:

```ts
        cycle.previous_credential_id AS previousCredentialId,
        c.status,
        c.revision,
        c.archived_at AS archivedAt,
        rs.source_url AS sourceUrl,
```

(The rendered-html resolvers for this query match `/FROM credentials c LEFT JOIN rule_sets rs/i`, which is unaffected.)

(c) The return object (`grep -n "credentials: credentialResult.results.map" app/api/workspace/route.ts`). Cut the whole `credentials:` entry — from `credentials: credentialResult.results.map((credential) => {` through its closing `}),` (lines 5165-5209) — out of the object literal and paste it as a `const` directly above `return {` (line 5142), then put two filtered entries where it was. The map body is byte-for-byte the same; the result reads:

```ts
  const mappedCredentials = credentialResult.results.map((credential) => {
    const totalRequired = Number(credential.totalRequired);
    const totalLoggedUnits = Number(credential.totalEarned);
    const unclassifiedUnits = Math.min(
      totalLoggedUnits,
      unclassifiedUnitsByCredential.get(credential.id) ?? 0,
    );
    const totalRawEarned = Math.max(
      0,
      totalLoggedUnits - unclassifiedUnits,
    );
    const totalExcessUnits = Math.min(
      totalRawEarned,
      maximumExcessByCredential.get(credential.id) ?? 0,
    );
    const totalEarned = Math.max(0, totalRawEarned - totalExcessUnits);
    return {
      ...credential,
      lifecycleKind: isIsc2AutomaticRenewalRuleSet(
        credential.ruleSetId,
      )
        ? ("automatic_renewal" as const)
        : isCompliancePeriodRuleSet(credential.ruleSetId)
          ? ("compliance_period" as const)
          : ("renewal" as const),
      totalRequired,
      totalLoggedUnits,
      unclassifiedUnits,
      classificationIssues:
        classificationIssuesByCredential.get(credential.id) ?? [],
      totalRawEarned,
      totalExcessUnits,
      totalEarned,
      totalRemaining: Math.max(0, totalRequired - totalEarned),
      totalProgressPercent:
        totalRequired > 0
          ? Math.min(100, Math.round((totalEarned / totalRequired) * 100))
          : 100,
      cycleMonths: Number(credential.cycleMonths),
      requirements: requirementsByCredential.get(credential.id) ?? [],
      tasks: tasksByCredential.get(credential.id) ?? [],
      archivedTasks:
        archivedTasksByCredential.get(credential.id) ?? [],
    };
  });

  return {
    user: {
      displayName: identity.displayName,
      email: identity.email,
      isDemo: identity.isDemo,
      draftStorageNamespace,
    },
    profile: {
      xp: progression.lifetimeXp,
      weekActions: progression.weekActions,
      weeklyGoal: progression.weeklyGoal,
      ...(progression.nextWeeklyGoal !== undefined &&
      progression.nextWeeklyGoalEffectiveOn
        ? {
            nextWeeklyGoal: progression.nextWeeklyGoal,
            nextWeeklyGoalEffectiveOn:
              progression.nextWeeklyGoalEffectiveOn,
          }
        : {}),
      badges: badgeResult.results,
    },
    progression,
    catalog,
    // Archived credentials leave Home and Credentials; History shows them
    // (Task 10). Both lists keep the same shape, so the packet route and
    // Task 9's actions address either by id. `archivedCredentials` must stay
    // ahead of `activities` — rendered-html pins the
    // archivedTasksByCredential…archivedActivities order.
    credentials: mappedCredentials.filter(
      (credential) => !credential.archivedAt,
    ),
    archivedCredentials: mappedCredentials.filter((credential) =>
      Boolean(credential.archivedAt),
    ),
    activities: [...activitiesById.values()].filter(
      (activity) => !activity.archivedAt,
    ),
    archivedActivities: [...activitiesById.values()].filter(
      (activity) => Boolean(activity.archivedAt),
    ),
    reminderPreferences: reminderData.reminderPreferences,
    reminders: reminderData.reminders,
  };
}
```

Activities allocated to an archived credential stay in `activities` unchanged. Verify: `grep -n "archivedCredentials" app/api/workspace/route.ts` → one hit; `npm run typecheck` is clean (the FakeDatabase fixtures in rendered-html return rows without `archivedAt`, so they all land in `credentials` as before).

- [ ] **Step 9: Archived gating — `assertCredentialStillMutable` plus the seven inline lookups**

The rule is the same everywhere: ownership 404 first, then the archive 409, then the existing status rules. Add the shared helper directly above `async function assertCredentialStillMutable(` (`grep -n "async function assertCredentialStillMutable" app/api/workspace/route.ts`):

```ts
const CREDENTIAL_ARCHIVED_MESSAGE =
  "This credential is archived. Restore it before making changes.";

// Archive is orthogonal to the active → submitted → renewed lifecycle (that
// status set is load-bearing in the db/runtime.ts trigger guards), so every
// credential write checks the nullable archived_at column after its ownership
// 404 and before any status rule. Task 9's credential actions reuse this.
function assertCredentialNotArchived(credential: {
  archivedAt: string | null;
}) {
  if (credential.archivedAt) {
    throw new RequestError(
      CREDENTIAL_ARCHIVED_MESSAGE,
      409,
      "credential_archived",
    );
  }
}
```

(a) `assertCredentialStillMutable` — replace its body:

```ts
  const credential = await query(
    database,
    `SELECT status FROM credentials WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ status: string }>();
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  if (!["active", "submitted"].includes(credential.status)) {
    throw new RequestError(message, 409, "cycle_closed");
  }
```

with:

```ts
  const credential = await query(
    database,
    `SELECT status, archived_at AS archivedAt
     FROM credentials
     WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ status: string; archivedAt: string | null }>();
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  assertCredentialNotArchived(credential);
  if (!["active", "submitted"].includes(credential.status)) {
    throw new RequestError(message, 409, "cycle_closed");
  }
```

(b) `addActivity` (`grep -n "^async function addActivity(" app/api/workspace/route.ts`; the lookup is the first `FROM credentials` SELECT below it, about 26 lines down) — replace:

```ts
  const credential = await query(
    database,
    `SELECT
      id,
      status,
      cycle_start AS cycleStart,
      deadline
     FROM credentials
     WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{
    id: string;
    status: string;
    cycleStart: string;
    deadline: string;
  }>();
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  if (credential.status === "renewed") {
```

with:

```ts
  const credential = await query(
    database,
    `SELECT
      id,
      status,
      cycle_start AS cycleStart,
      deadline,
      archived_at AS archivedAt
     FROM credentials
     WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{
    id: string;
    status: string;
    cycleStart: string;
    deadline: string;
    archivedAt: string | null;
  }>();
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  assertCredentialNotArchived(credential);
  if (credential.status === "renewed") {
```

(c) `createPersonalTask` (`grep -n "^async function createPersonalTask(" app/api/workspace/route.ts`; the lookup is the first `FROM credentials` SELECT below it, about 14 lines down — the "checklist is frozen" message appears four times in the file, so anchor on the function) — replace:

```ts
  const credential = await query(
    database,
    `SELECT id, status
     FROM credentials
     WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ id: string; status: string }>();
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  if (!["active", "submitted"].includes(credential.status)) {
    throw new RequestError(
      "This renewal cycle is closed and its checklist is frozen.",
```

with:

```ts
  const credential = await query(
    database,
    `SELECT id, status, archived_at AS archivedAt
     FROM credentials
     WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ id: string; status: string; archivedAt: string | null }>();
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  assertCredentialNotArchived(credential);
  if (!["active", "submitted"].includes(credential.status)) {
    throw new RequestError(
      "This renewal cycle is closed and its checklist is frozen.",
```

(d) `markSubmitted` (`grep -n "^async function markSubmitted(" app/api/workspace/route.ts`; the lookup is the first `FROM credentials` SELECT below it, and `grep -n "const isIsc2Checkpoint = isIsc2AutomaticRenewalRuleSet(" app/api/workspace/route.ts` — a unique line — sits directly under its 404 block) — replace:

```ts
  const credential = await query(
    database,
    `SELECT
      id,
      status,
      rule_set_id AS ruleSetId
     FROM credentials
     WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ id: string; status: string; ruleSetId: string | null }>();
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  const isIsc2Checkpoint = isIsc2AutomaticRenewalRuleSet(
```

with:

```ts
  const credential = await query(
    database,
    `SELECT
      id,
      status,
      rule_set_id AS ruleSetId,
      archived_at AS archivedAt
     FROM credentials
     WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{
    id: string;
    status: string;
    ruleSetId: string | null;
    archivedAt: string | null;
  }>();
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  assertCredentialNotArchived(credential);
  const isIsc2Checkpoint = isIsc2AutomaticRenewalRuleSet(
```

(e) `addActivityAllocation` (`grep -n "^async function addActivityAllocation(" app/api/workspace/route.ts`; the `Promise.all` about 20 lines below it holds the activity query and then this credential query — the "Restore this learning record" message also appears in `updateActivityAllocationRequirements`, so anchor on the function) — replace the credential query:

```ts
    query(
      database,
      `SELECT
        id,
        status,
        cycle_start AS cycleStart,
        deadline
       FROM credentials
       WHERE id = ? AND user_id = ?`,
      [credentialId, identity.userId],
    ).first<{
      id: string;
      status: string;
      cycleStart: string;
      deadline: string;
    }>(),
```

with:

```ts
    query(
      database,
      `SELECT
        id,
        status,
        cycle_start AS cycleStart,
        deadline,
        archived_at AS archivedAt
       FROM credentials
       WHERE id = ? AND user_id = ?`,
      [credentialId, identity.userId],
    ).first<{
      id: string;
      status: string;
      cycleStart: string;
      deadline: string;
      archivedAt: string | null;
    }>(),
```

and, below it, replace:

```ts
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  if (activity.archivedAt) {
    throw new RequestError(
      "Restore this learning record before changing its allocations.",
```

with:

```ts
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  assertCredentialNotArchived(credential);
  if (activity.archivedAt) {
    throw new RequestError(
      "Restore this learning record before changing its allocations.",
```

(f) `markRenewalAccepted` (`grep -n "type CycleCredential = {" app/api/workspace/route.ts`) — in the `CycleCredential` type replace:

```ts
    issuer: string;
    status: string;
    cycleStart: string;
```

with:

```ts
    issuer: string;
    status: string;
    archivedAt: string | null;
    cycleStart: string;
```

in the SELECT below it replace:

```ts
        credential.issuer,
        credential.status,
        credential.cycle_start AS cycleStart,
```

with:

```ts
        credential.issuer,
        credential.status,
        credential.archived_at AS archivedAt,
        credential.cycle_start AS cycleStart,
```

and after the `Promise.all` replace:

```ts
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  if (!submission || credential.status !== "submitted") {
```

with:

```ts
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  assertCredentialNotArchived(credential);
  if (!submission || credential.status !== "submitted") {
```

(The rendered-html resolvers for this query match `/FROM credentials credential\s+LEFT JOIN credential_cycle_links cycle/i` — unaffected.)

(g) `updateRequirementApplicability` (`grep -n "^async function updateRequirementApplicability(" app/api/workspace/route.ts`; the `Promise.all` about 50 lines below it holds this credential query — the "requirements are frozen" message appears three times in the file, so anchor on the function) — replace:

```ts
    query(
      database,
      `SELECT id, status
       FROM credentials
       WHERE id = ? AND user_id = ?`,
      [credentialId, identity.userId],
    ).first<{ id: string; status: string }>(),
```

with:

```ts
    query(
      database,
      `SELECT id, status, archived_at AS archivedAt
       FROM credentials
       WHERE id = ? AND user_id = ?`,
      [credentialId, identity.userId],
    ).first<{ id: string; status: string; archivedAt: string | null }>(),
```

and replace:

```ts
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  if (credential.status === "renewed") {
    throw new RequestError(
      "This renewal cycle is closed and its requirements are frozen.",
```

with:

```ts
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  assertCredentialNotArchived(credential);
  if (credential.status === "renewed") {
    throw new RequestError(
      "This renewal cycle is closed and its requirements are frozen.",
```

(h) `setReminderState` (`grep -n "SELECT id, deadline FROM credentials WHERE id = ? AND user_id = ?" app/api/workspace/route.ts`) — replace:

```ts
  const credential = await query(
    database,
    `SELECT id, deadline FROM credentials WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ id: string; deadline: string }>();
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }

  let validReminder = false;
```

with:

```ts
  const credential = await query(
    database,
    `SELECT id, deadline, archived_at AS archivedAt
     FROM credentials
     WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ id: string; deadline: string; archivedAt: string | null }>();
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  assertCredentialNotArchived(credential);

  let validReminder = false;
```

Verify: `grep -c "assertCredentialNotArchived(credential)" app/api/workspace/route.ts` → 8 (the helper's own definition is `assertCredentialNotArchived(credential: {`, which that pattern does not match); `grep -c "archived_at AS archivedAt" app/api/workspace/route.ts` → 18, up from 9 at 8ac172a (7 inline lookups + `assertCredentialStillMutable` here + the `c.archived_at AS archivedAt` column from Step 8).

- [ ] **Step 10: Reminders and the packet route stop pretending archived credentials are live**

(a) `app/lib/reminders.ts` — the task query: replace

```ts
      WHERE task.user_id = ?
        AND credential.user_id = task.user_id
        AND credential.status <> 'renewed'
        AND task.archived_at IS NULL
```

with

```ts
      WHERE task.user_id = ?
        AND credential.user_id = task.user_id
        AND credential.status <> 'renewed'
        AND credential.archived_at IS NULL
        AND task.archived_at IS NULL
```

and the cycle query: replace

```ts
      WHERE credential.user_id = ?
        AND (
          credential.status = 'active'
```

with

```ts
      WHERE credential.user_id = ?
        AND credential.archived_at IS NULL
        AND (
          credential.status = 'active'
```

This file is loaded as raw TypeScript by `tests/rendered-html.test.mjs` (`importTypeScriptModule`), so it gains no import; SQL text only. The rendered-html resolvers match `/FROM checklist_tasks task JOIN credentials credential/i` and `/FROM credentials credential LEFT JOIN renewal_submissions submission/i` — prefixes, unaffected. Because `runScheduledPushDelivery` (`app/lib/pushDelivery.ts`) derives its candidates through `loadReminderData`, archived credentials stop producing push check-ins too.

(b) `app/api/export/packet/route.ts` — replace

```ts
    const workspace = await getWorkspace(database, identity);
    const credential = workspace.credentials.find(
      (candidate) => candidate.id === credentialId,
    );
```

with

```ts
    const workspace = await getWorkspace(database, identity);
    // An archived credential is hidden from Home and Credentials, not from
    // its own paper trail: the packet keeps opening (spec §4, app-ux-03).
    const credential = [
      ...workspace.credentials,
      ...workspace.archivedCredentials,
    ].find((candidate) => candidate.id === credentialId);
```

- [ ] **Step 11: Run the new tests to see them pass**

Run:
```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
npm run typecheck && npm run build && node --experimental-sqlite --test tests/workspace-credential-actions.test.mjs tests/real-sqlite-seed.test.mjs tests/isolation.test.mjs
```
Expected: typecheck clean; all three files PASS — `workspace-credential-actions` 2 top-level tests / 7 subtests, `real-sqlite-seed` with the new 0014 subtest, and the isolation suite unchanged (its 23-action enumeration still balances and every credential probe still answers 404 first).

- [ ] **Step 12: Update the rendered-html SQL matchers, migration bindings subtest and journal pins**

Everything here is located by content; the line numbers are 8ac172a's and Task 5 has moved them.

(a) The shared helper near the top of the file (`grep -n "function isOwnedCredentialCycleLookup" tests/rendered-html.test.mjs`) — replace:

```js
  return /SELECT id, status,(?: rule_set_id AS ruleSetId,)? cycle_start AS cycleStart, deadline FROM credentials WHERE id = \? AND user_id = \?/i.test(
```

with:

```js
  return /SELECT id, status,(?: rule_set_id AS ruleSetId,)? cycle_start AS cycleStart, deadline(?:, archived_at AS archivedAt)? FROM credentials WHERE id = \? AND user_id = \?/i.test(
```

(b) Five inline resolvers (14633, 14855, 14934, 16529, 23935 at 8ac172a) — replace **every** occurrence of:

```js
            /SELECT id, status FROM credentials WHERE id = \? AND user_id = \?/i.test(
```

with:

```js
            /SELECT id, status(?:, archived_at AS archivedAt)? FROM credentials WHERE id = \? AND user_id = \?/i.test(
```

(c) Four inline resolvers (17652, 17740, 17822, 17913) — replace **every** occurrence of:

```js
/SELECT id, status, rule_set_id AS ruleSetId FROM credentials WHERE id = \? AND user_id = \?/i.test(
```

with:

```js
/SELECT id, status, rule_set_id AS ruleSetId(?:, archived_at AS archivedAt)? FROM credentials WHERE id = \? AND user_id = \?/i.test(
```

(one of the four is indented two spaces deeper than the others — match on the regex text, not the indentation).

(d) One inline resolver (20891) — replace:

```js
            /SELECT id, deadline FROM credentials WHERE id = \? AND user_id = \?/i.test(
```

with:

```js
            /SELECT id, deadline(?:, archived_at AS archivedAt)? FROM credentials WHERE id = \? AND user_id = \?/i.test(
```

Verify the counts (5, 4, 1, 1 at 8ac172a — if Task 5 removed a resolver the count is lower, and that is fine; what matters is that the old form is gone):

```bash
grep -cF 'SELECT id, status(?:, archived_at AS archivedAt)? FROM credentials WHERE id = \? AND user_id = \?/i.test(' tests/rendered-html.test.mjs
grep -cF 'SELECT id, status, rule_set_id AS ruleSetId(?:, archived_at AS archivedAt)? FROM credentials WHERE id = \? AND user_id = \?/i.test(' tests/rendered-html.test.mjs
grep -cF 'SELECT id, deadline(?:, archived_at AS archivedAt)? FROM credentials WHERE id = \? AND user_id = \?/i.test(' tests/rendered-html.test.mjs
grep -cF 'cycleStart, deadline(?:, archived_at AS archivedAt)? FROM credentials' tests/rendered-html.test.mjs
grep -cF 'SELECT id, status FROM credentials WHERE id = \? AND user_id = \?/i' tests/rendered-html.test.mjs
grep -cF 'SELECT id, status, rule_set_id AS ruleSetId FROM credentials WHERE id = \? AND user_id = \?/i' tests/rendered-html.test.mjs
grep -cF 'SELECT id, deadline FROM credentials WHERE id = \? AND user_id = \?/i' tests/rendered-html.test.mjs
```
Expected: `5`, `4`, `1`, `1`, then `0`, `0`, `0`.

(e) The `"ships durable D1, R2, and migration bindings"` subtest (`grep -n "ships durable D1, R2, and migration bindings" tests/rendered-html.test.mjs`). Four edits inside it:

1. In the destructuring list, replace

```js
      dropApnsMigration,
    ] = await Promise.all([
```

with

```js
      dropApnsMigration,
      credentialArchiveMigration,
    ] = await Promise.all([
```

2. At the end of that `Promise.all` array, replace

```js
        readFile(
          new URL("../drizzle/0013_drop_apns.sql", import.meta.url),
          "utf8",
        ),
      ]);
```

with

```js
        readFile(
          new URL("../drizzle/0013_drop_apns.sql", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../drizzle/0014_credential_archive.sql", import.meta.url),
          "utf8",
        ),
      ]);
```

3. In the concatenation line, replace the tail `\n${apnsMigration}\n${dropApnsMigration}`;` with `\n${apnsMigration}\n${dropApnsMigration}\n${credentialArchiveMigration}`;` — the full line becomes:

```js
    const migration = `${baseMigration}\n${evidenceMigration}\n${lifecycleMigration}\n${richRuleMigration}\n${progressionMigration}\n${exclusiveGroupMigration}\n${attestationMigration}\n${weeklyPeriodMigration}\n${archiveMigration}\n${pushMigration}\n${dentalCheckpointMigration}\n${apnsMigration}\n${dropApnsMigration}\n${credentialArchiveMigration}`;
```

4. Directly after the block ending

```js
    assert.ok(
      dropApnsMigration.indexOf("apns_delivery_ledger") < dropApnsMigration.indexOf("apns_devices"),
      "the ledger (child) is dropped before the devices table it references",
    );
```

add:

```js
    assert.match(
      credentialArchiveMigration,
      /ALTER TABLE `credentials` ADD `revision` integer DEFAULT 1 NOT NULL/,
    );
    assert.match(
      credentialArchiveMigration,
      /ALTER TABLE `credentials` ADD `archived_at` text/,
    );
    assert.match(
      credentialArchiveMigration,
      /CREATE INDEX `credentials_user_archive_deadline_idx` ON `credentials` \(`user_id`,`archived_at`,`deadline`\)/,
    );
```

(f) The two journal pins (`grep -n '"0013_drop_apns",' tests/rendered-html.test.mjs` → exactly two hits, each directly under an `.at(-1)?.tag,` line: one `migrationJournal.entries.at(-1)?.tag,` in the subtest above, one `journalEntries.at(-1)?.tag,` in `"migrates revisioned archives and keeps active-record queries coherent"`). Replace both

```js
      "0013_drop_apns",
```

with

```js
      "0014_credential_archive",
```

(keep each line's own indentation). Verify: `grep -c '"0014_credential_archive",' tests/rendered-html.test.mjs` → 2; `grep -c '0013_drop_apns' tests/rendered-html.test.mjs` → 1 (only the `readFile` of the 0013 SQL remains).

- [ ] **Step 13: Run the four test files, then the full gates**

Run:
```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
node --experimental-sqlite --test tests/workspace-credential-actions.test.mjs tests/real-sqlite-seed.test.mjs tests/rendered-html.test.mjs tests/isolation.test.mjs
```
Expected: all four PASS (the build from Step 11 is current — nothing under `app/` or `db/` changed since). If a rendered-html subtest fails with a 404 `credential_not_found` where a 200/409 was expected, a resolver's SQL matcher was missed in Step 12 — `grep -n "FROM credentials WHERE id = \\\\? AND user_id = \\\\?" tests/rendered-html.test.mjs` lists every remaining credential-lookup matcher.

Then the gates every task runs:
```bash
npm run typecheck && npm run lint && npm test
```
Expected: clean, clean, and `npm test` (build + `build:lib-test` + every `tests/*.test.mjs`) green — `tests/workspace-credential-actions.test.mjs` is picked up by the glob automatically.

`app/api/workspace/route.ts` lives under `app/`, so this task also runs the browser suite: start `npm run dev` (only after the build above has finished — they share `.wrangler/`), then

```bash
npm run test:e2e
```
Expected: every spec green on all four projects; nothing in this task changes markup, and the specs read `workspace.credentials` through Task 3's fixture, which still lists every non-archived credential. Stop the dev server afterwards.

- [ ] **Step 14: Commit**

```bash
git branch --show-current
git add db/schema.ts db/runtime.ts \
  drizzle/0014_credential_archive.sql drizzle/meta/0014_snapshot.json drizzle/meta/_journal.json \
  app/api/workspace/route.ts app/lib/reminders.ts app/api/export/packet/route.ts \
  tests/workspace-credential-actions.test.mjs tests/real-sqlite-seed.test.mjs tests/rendered-html.test.mjs
git status --short
git commit -m "feat(db): migration 0014 credential_archive — revision + archived_at, archivedCredentials in the workspace, archived gating

spec §4 (credential edit / delete / archive), §8 (migrations continue in drizzle/); app-ux-03.
Archive is a nullable archived_at column, not a status, because the active/submitted/renewed
set is load-bearing in the runtime trigger guards. db/runtime.ts mirrors the migration (DDL,
RICH_RULE_COLUMNS, ensureRichRuleColumns now lists credentials, archive index) because
initializeDatabase, not drizzle, runs on the Railway volume. getWorkspace splits credentials[]
from archivedCredentials[]; reminders and push skip archived credentials; the packet still
opens; every credential write answers 409 credential_archived after its ownership 404; the four
lifecycle writes bump credentials.revision. New real-SQLite harness in
tests/workspace-credential-actions.test.mjs (fresh boot + pre-0014 backfill boot).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```
Expected: `feat/wave2-foundation`; `git status --short` before the commit lists exactly the eleven paths above (three `??`, eight ` M`), nothing else.

---

### Task 9: Workspace actions `updateCredential`, `archiveCredential`, `restoreCredential`, `deleteCredential` (server) with isolation rows

**Rationale:** spec §4 bullet 4 (app-ux-03): a credential can never be edited, archived or deleted today, so a wrong template or date is permanent. This task ships the four server actions, revision-guarded like `updateActivity` (spec §4) and proven on real node:sqlite (spec §9 Integration), and adds their rows to the two-identity isolation suite in the same commit (Global Constraints). The client (Task 10) consumes the error contract below verbatim.

**Decisions:** archive / restore / delete act on the whole cycle series (`seriesId`; forced for delete by the `ON DELETE RESTRICT` foreign keys on `credential_cycle_links.previous_credential_id` and `renewal_acceptances.credential_id` / `next_credential_id`, `db/runtime.ts:357,376-378`). `restoreCredential` is the fourth action ("reversible"). On a `submitted` cycle only `credentialName` / `issuer` may change. The `categories` editor UI ships in Wave 4 but the server contract ships now. Proof linked only to the deleted series is deleted from R2 **by default** (spec §4 bullet 4: "evidence linked only to that credential is deleted from R2"); `deleteOrphanedEvidence: false` — Task 10's confirm-dialog checkbox, checked by default, unticked — is the explicit opt-out, because `evidence_files` belong to activities, which survive. XP rows are left alone. A renamed template credential's future cycle still takes the template name (`markRenewalAccepted` unchanged; recorded in the self-review). Two write-order rules keep every batch race-free without a content guard: in `updateCredential` the credential row's own `UPDATE` is the **last** statement, so every earlier guard tests the same pre-bump `revision` inside one `BEGIN IMMEDIATE`; in `deleteCredential` the target row's `DELETE ... AND revision = ?` is what proves freshness, every statement before it is guarded by `EXISTS (target row at the expected revision)` and every orphan sweep after it by `NOT EXISTS (target row)`, so a stale revision leaves the database byte-identical (verified: cascades pass the `BEFORE DELETE` guard triggers because SQLite runs foreign-key actions after the parent row is gone).

**Files:**
- Modify: `app/api/workspace/route.ts` — line 1 import; extract `assertTemplateCycleDates` from `createCredential` (the block `if (isNremtRuleSet(ruleSetId)) {` … `"rule_transition_outside_template"` `}` at `:5390-5515` on `main@8ac172a`); new helpers + four actions inserted immediately before `async function getActivityAllocationValidationRows(` (`:6246` on `main@8ac172a`); four `case` labels after `case "createCredential":` (`:12377-12379` on `main@8ac172a`). Task 8 edits this file first, so re-run every `grep -n` shown below before editing — the text anchors are stable, the numbers are not.
- Modify: `tests/workspace-credential-actions.test.mjs` (Task 8's file; append one top-level `test(...)` with nine subtests)
- Modify: `tests/isolation.test.mjs` (+4 `FOREIGN_ID_PROBES` rows), `tests/helpers/workspaceActions.mjs` (+4 names → 27)
- Test: `tests/workspace-credential-actions.test.mjs`, `tests/isolation.test.mjs`, `tests/app-source-guards.test.mjs`, `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes (route.ts, all module-level and already present at `main@8ac172a`): `RequestError(message, status, code)` (`:398-406`), `query(database, sql, bindings)` (`:408-414`), `isRecord` (`:436`), `textField(payload, key, { required?, max? })` (`:440-462`), `positiveNumber` (`:464-482`), `nonNegativeNumber` (`:484-500`), `expectedRevisionField(payload)` (`:502-516`, 400 `invalid_revision`), `enumField` (`:532-546`), `normalizedApplicabilityStatus` (`:554-577`), `isoDateField(payload, key, required = true)` (`:1269-1283`), `isNremtRuleSet` (`:1311`), `assertNremtCredentialDates` (`:1334`), `assertFloridaMentalHealthCredentialDates` (`:1421`), `assertRehabilitationCertificationDates` (`:1459`), `assertActivityDateFitsCredential(completionDate, { cycleStart, deadline }, requirements, label)` (`:1533-1638`), `renewalTaskSpecs(ruleSetId, deadline, reviewTitle?, { abveAnnualStartYear? })` (`:1775-2174`), `estimatedCycleMonths` (`:2814`), `matchesFullCycleWindow` (`:2821`), `type CredentialCategoryDraft` (`:5244`), `orderedCategoryDrafts` (`:5292`), `validateActiveCategoryParents` (`:5321`), `type CatalogRule` (`:5221`), the constants `REQUIREMENT_KINDS` / `REQUIREMENT_RELATIONS` / `REQUIREMENT_APPLICABILITIES` (`:68-82`), `NREMT_RULE_SET_PREFIX` / `CRCC_RULE_SET_PREFIX` / `ABVE_RULE_SET_PREFIX` / `FLORIDA_MENTAL_HEALTH_RULE_SET_PREFIX` / `CFP_PRE_2027_RULE_SET_ID` / `CFP_2027_CYCLE_START` (`:88-115`), `isExpandedCertificationRuleSetId` (imported at `:58`), `type RequestIdentity` (`@/db/identity`), `getEvidenceBucket()` (`db/index.ts:15-23`, returns `R2Bucket` whose `delete(keys: string | string[])` is at `db/cloudflare.d.ts:73`).
- Consumes (Task 8): `credentials.revision` / `credentials.archived_at`; `getWorkspace` returning `credentials[]` (non-archived, every status, each with `revision`) and `archivedCredentials[]`; `markSubmitted` / `markRenewalAccepted` bumping `revision`; 409 `credential_archived` (`This credential is archived. Restore it before making changes.`) from `addActivity` on an archived credential; and the real-sqlite harness at the top of `tests/workspace-credential-actions.test.mjs`: `boot()` (boots the built worker once against a fresh `SQLiteD1Database` + `FakeEvidenceBucket` and resolves an object carrying `fetchAs(email, path, init?)` — the identity-scoped `worker.fetch` wrapper that sets `oai-authenticated-user-email` and `accept: application/json`, lets `init.headers` win, and adds no `content-type` of its own — `bucket`, the `FakeEvidenceBucket` instance with `objects: Map` and `deletes: string[]`, and `raw(sql, ...bindings)`, rows from the underlying `DatabaseSync`; none of the three is a module-level binding, so the new test destructures all three from the object `boot()` resolves) and the module-scope constant `OWNER = "owner@example.com"`. Every Task 9 subtest reaches the harness through the `api` adapter at the top of the new test; `const { fetchAs, bucket, raw } = await boot();` is the only line that names the harness.
- Consumes (Task 1): `FOREIGN_ID_PROBES` rows `{ action, payload: (seed) => object, expect: { status, code } }` in `tests/isolation.test.mjs`; `WORKSPACE_ACTIONS` in `tests/helpers/workspaceActions.mjs`; the dispatch-label guard in `tests/app-source-guards.test.mjs` that compares the `case` labels of the workspace switch with `WORKSPACE_ACTIONS` in switch order.
- Produces (all four actions return the credentialId, so the `{ ok, action, id }` response shape is unchanged):

```ts
type CredentialMutationRow = { id: string; ruleSetId: string | null; credentialName: string; profession: string; jurisdiction: string; issuer: string; cycleStart: string; deadline: string; totalRequired: number; unitLabel: string; status: string; revision: number; archivedAt: string | null; seriesId: string; cycleMonths: number };
async function getCredentialForMutation(database: D1Database, identity: RequestIdentity, credentialId: string): Promise<CredentialMutationRow | null>
function assertCredentialMutationState(credential: CredentialMutationRow | null, expectedRevision: number, archiveState: "active" | "archived" | "any"): asserts credential is CredentialMutationRow
async function seriesCredentialIds(database: D1Database, identity: RequestIdentity, seriesId: string, fallbackId: string): Promise<string[]>   // always contains fallbackId
async function diagnoseCredentialMutationFailure(database: D1Database, identity: RequestIdentity, credentialId: string, expectedRevision: number, archiveState: "active" | "archived" | "any"): Promise<never>
function assertTemplateCycleDates(rule: CatalogRule, ruleSetId: string, cycleStart: string, deadline: string, payload: JsonRecord): number | null   // verbatim body of createCredential's template date/attestation block; returns abveAnnualStartYear; createCredential now calls it
async function updateCredential(database: D1Database, identity: RequestIdentity, payload: JsonRecord): Promise<string>
async function archiveCredential(database: D1Database, identity: RequestIdentity, payload: JsonRecord): Promise<string>
async function restoreCredential(database: D1Database, identity: RequestIdentity, payload: JsonRecord): Promise<string>
async function deleteCredential(database: D1Database, bucket: R2Bucket, identity: RequestIdentity, payload: JsonRecord): Promise<string>   // the switch passes getEvidenceBucket()
```

  Payloads: `updateCredential` `{ credentialId, expectedRevision, credentialName?, issuer?, cycleStart?, deadline?, officialDatesAttested?, templateEligibilityAttested?, abveAnnualStartYear?, jurisdiction?, profession?, totalRequired?, unitLabel?, categories?: Array<{ requirementId?, key?, name, requiredUnits, kind?, relation?, parentRequirementId?, applicability?, applicabilityStatus?, conditionNote?, exclusiveGroup? }> }` (limits as `createCredential`: name 180, issuer 180, jurisdiction 120, profession 120, unitLabel 40, ≤30 categories, category name ≤100; `categories` is a replace-set keyed by `requirementId` — known ids are updated in place, unknown items are inserted with a new id, existing requirements missing from the array are deleted; `parentRequirementId` names an existing requirement id or another item's `key`). `archiveCredential` / `restoreCredential` `{ credentialId, expectedRevision }`. `deleteCredential` `{ credentialId, expectedRevision, confirmName, deleteOrphanedEvidence?: boolean }` (`deleteOrphanedEvidence` defaults to `true` — the spec's path; only the literal `false` keeps solely-linked proof).

  Error contract (code → status, message):

  | code | status | message |
  |---|---|---|
  | `credential_not_found` | 404 | `Credential not found.` |
  | `credential_version_conflict` | 409 | `This credential changed in another session. Refresh and try again.` |
  | `credential_archived` | 409 | `This credential is archived. Restore it before making changes.` (Task 8 text) |
  | `credential_not_archived` | 409 | `This credential is already active.` |
  | `credential_state_changed` | 409 | `This credential changed while it was being saved. Refresh and try again.` |
  | `cycle_closed` | 409 | `This renewal cycle is closed; its record is frozen.` (status `renewed`) |
  | `cycle_closed` | 409 | `This cycle has a logged submission; its dates and requirements are frozen. Change the display name or issuer only.` (status `submitted` with any of `cycleStart`, `deadline`, `jurisdiction`, `profession`, `totalRequired`, `unitLabel`, `categories`) |
  | `template_field_locked` | 400 | `Source-linked credentials take their requirements from the template. Change dates or the display name only, or create a custom plan.` |
  | `requirement_in_use` | 409 | `These requirements have logged credits and can’t be removed: <names joined by ', '>.` |
  | `activities_outside_cycle` | 409 | `These learning records fall outside the new cycle dates: <titles joined by ', '>. Change their dates or keep the cycle dates.` |
  | `credential_name_mismatch` | 400 | `Type the credential name exactly as shown to confirm deletion.` |
  | `invalid_revision` | 400 | existing (`expectedRevisionField`) |
  | `rule_set_not_found` | 404 | existing (`createCredential` text) |
  | template date codes (`nremt_fixed_deadline_required`, `pharmacist_standard_cycle_dates_required`, …) | 409 | existing texts, now raised by `assertTemplateCycleDates` from both `createCredential` and a date change in `updateCredential` |

- [ ] **Step 1: Write the failing tests — nine subtests appended to `tests/workspace-credential-actions.test.mjs`**

Append this block at the end of the file (after Task 8's tests). It uses only `boot()` from the harness above it — and the `fetchAs`, `bucket` and `raw` members of the object it resolves (`raw` is not a module-level function) — plus `OWNER`, `test` and `assert`, which the file already declares and imports. Do not redeclare `OWNER`: a second module-scope `const OWNER` is `SyntaxError: Identifier 'OWNER' has already been declared`, which takes Task 8's tests down with it.

```js
// ---------------------------------------------------------------------------
// Task 9 — updateCredential / archiveCredential / restoreCredential /
// deleteCredential on the real-sqlite harness above: boot() and the
// fetchAs / bucket / raw members of the object it resolves. OWNER is Task 8's
// module-scope constant; it is not redeclared here.
// ---------------------------------------------------------------------------
const NREMT_EMT_RULE_SET_ID = "nremt-emt-nccp-ce-2025-v1";
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8,
]);

function shiftDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("credential mutation actions: update, archive, restore, delete (Task 9)", async (t) => {
  const { fetchAs, bucket, raw } = await boot();
  const api = {
    async post(email, action, payload) {
      const response = await fetchAs(email, "/api/workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, payload }),
      });
      return { status: response.status, body: await response.json() };
    },
    async workspace(email) {
      const response = await fetchAs(email, "/api/workspace");
      assert.equal(response.status, 200);
      return response.json();
    },
    async credential(email, id) {
      const workspace = await api.workspace(email);
      return {
        workspace,
        active: workspace.credentials.find((credential) => credential.id === id) ?? null,
        archived: (workspace.archivedCredentials ?? []).find((credential) => credential.id === id) ?? null,
      };
    },
    async upload(email, activityId, fileName) {
      const form = new FormData();
      form.set("activityId", activityId);
      form.set("file", new File([PNG_BYTES], fileName, { type: "image/png" }));
      const response = await fetchAs(email, "/api/evidence", { method: "POST", body: form });
      assert.equal(response.status, 201, await response.clone().text());
      return (await response.json()).evidence;
    },
    async count(table, column, value) {
      const rows = await raw(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, value);
      return Number(rows[0].n);
    },
  };
  const today = new Date().toISOString().slice(0, 10);
  const customPayload = (overrides = {}) => ({
    credentialName: "Alpha LCSW",
    profession: "Counseling",
    jurisdiction: "Rhode Island",
    issuer: "Alpha board",
    totalRequired: 10,
    unitLabel: "hours",
    cycleStart: "2026-01-01",
    deadline: "2027-12-31",
    categories: [
      { name: "Ethics", requiredUnits: 3 },
      { name: "General", requiredUnits: 7 },
    ],
    ...overrides,
  });
  async function createCustom(overrides) {
    const created = await api.post(OWNER, "createCredential", customPayload(overrides));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const { active } = await api.credential(OWNER, created.body.id);
    assert.ok(active, "a freshly created credential is listed under credentials[]");
    return active;
  }
  async function logActivity(credentialId, overrides = {}) {
    const logged = await api.post(OWNER, "addActivity", {
      title: "Ethics course",
      provider: "Alpha provider",
      completionDate: "2026-06-01",
      totalUnits: 2,
      allocatedUnits: 2,
      credentialId,
      ...overrides,
    });
    assert.equal(logged.status, 200, JSON.stringify(logged.body));
    const workspace = await api.workspace(OWNER);
    return workspace.activities.find((activity) => activity.id === logged.body.id);
  }
  function expectError(result, status, code, messagePattern) {
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.equal(result.body.code, code, JSON.stringify(result.body));
    if (messagePattern) assert.match(result.body.error, messagePattern);
  }

  await t.test("rename and issuer change bump the revision; stale and missing revisions are refused", async () => {
    const credential = await createCustom();
    assert.equal(credential.revision, 1);
    const renamed = await api.post(OWNER, "updateCredential", {
      credentialId: credential.id,
      expectedRevision: 1,
      credentialName: "Alpha LCSW (renamed)",
      issuer: "Alpha board, Providence",
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.deepEqual(renamed.body, { ok: true, action: "updateCredential", id: credential.id });
    const { active } = await api.credential(OWNER, credential.id);
    assert.equal(active.credentialName, "Alpha LCSW (renamed)");
    assert.equal(active.issuer, "Alpha board, Providence");
    assert.equal(active.revision, 2);
    expectError(
      await api.post(OWNER, "updateCredential", { credentialId: credential.id, expectedRevision: 1, credentialName: "stale" }),
      409,
      "credential_version_conflict",
      /changed in another session/,
    );
    expectError(
      await api.post(OWNER, "updateCredential", { credentialId: credential.id, credentialName: "no revision" }),
      400,
      "invalid_revision",
    );
    expectError(
      await api.post(OWNER, "updateCredential", { credentialId: "does-not-exist", expectedRevision: 1, credentialName: "x" }),
      404,
      "credential_not_found",
    );
  });

  await t.test("template-linked credentials re-run the template date rules and lock template fields", async () => {
    const catalogResponse = await fetchAs(OWNER, "/api/catalog");
    assert.equal(catalogResponse.status, 200);
    const { catalog } = await catalogResponse.json();
    const nremt = catalog.find((rule) => rule.id === NREMT_EMT_RULE_SET_ID);
    assert.ok(nremt, "the NREMT EMT NCCP template is in the current catalog");
    const created = await api.post(OWNER, "createCredential", {
      ruleSetId: nremt.id,
      cycleStart: "2026-04-01",
      deadline: "2028-03-31",
      officialDatesAttested: true,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const { active } = await api.credential(OWNER, created.body.id);
    expectError(
      await api.post(OWNER, "updateCredential", {
        credentialId: active.id,
        expectedRevision: active.revision,
        deadline: "2027-06-30",
        officialDatesAttested: true,
      }),
      409,
      "nremt_fixed_deadline_required",
      /March 31/,
    );
    expectError(
      await api.post(OWNER, "updateCredential", {
        credentialId: active.id,
        expectedRevision: active.revision,
        jurisdiction: "Texas",
      }),
      400,
      "template_field_locked",
      /Source-linked credentials take their requirements from the template/,
    );
    const renamed = await api.post(OWNER, "updateCredential", {
      credentialId: active.id,
      expectedRevision: active.revision,
      credentialName: "My EMT card",
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    const after = await api.credential(OWNER, active.id);
    assert.equal(after.active.credentialName, "My EMT card");
    assert.equal(after.active.ruleSetId, nremt.id, "the template link survives a rename");
  });

  await t.test("cycle dates are validated against allocated learning records and rewrite derived data", async () => {
    const credential = await createCustom();
    await logActivity(credential.id, { completionDate: "2026-06-01" });
    expectError(
      await api.post(OWNER, "updateCredential", {
        credentialId: credential.id,
        expectedRevision: credential.revision,
        cycleStart: "2026-07-01",
      }),
      409,
      "activities_outside_cycle",
      /These learning records fall outside the new cycle dates: Ethics course\. Change their dates or keep the cycle dates\./,
    );
    expectError(
      await api.post(OWNER, "updateCredential", {
        credentialId: credential.id,
        expectedRevision: credential.revision,
        cycleStart: "2026-02-01",
        deadline: "2026-01-15",
      }),
      400,
      "invalid_request",
      /deadline must be on or after cycleStart/,
    );
    const [linkBefore] = await raw(
      "SELECT cycle_months AS cycleMonths FROM credential_cycle_links WHERE credential_id = ?",
      credential.id,
    );
    assert.equal(Number(linkBefore.cycleMonths), 24);
    const moved = await api.post(OWNER, "updateCredential", {
      credentialId: credential.id,
      expectedRevision: credential.revision,
      cycleStart: "2026-02-01",
      deadline: "2027-09-30",
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const { active } = await api.credential(OWNER, credential.id);
    assert.equal(active.cycleStart, "2026-02-01");
    assert.equal(active.deadline, "2027-09-30");
    assert.equal(active.revision, credential.revision + 1);
    const [linkAfter] = await raw(
      "SELECT cycle_months AS cycleMonths FROM credential_cycle_links WHERE credential_id = ?",
      credential.id,
    );
    assert.equal(Number(linkAfter.cycleMonths), 20, "custom cycles re-estimate cycle_months from the new dates");
    const dueByKind = Object.fromEntries(
      active.tasks.filter((task) => !task.isPersonal).map((task) => [task.kind, task.dueDate]),
    );
    assert.deepEqual(dueByKind, {
      review: shiftDays("2027-09-30", -120),
      progress: shiftDays("2027-09-30", -30),
      submission: "2027-09-30",
    });
  });

  await t.test("custom requirements are a replace-set guarded by logged credits", async () => {
    const credential = await createCustom();
    const ethics = credential.requirements.find((requirement) => requirement.name === "Ethics");
    const general = credential.requirements.find((requirement) => requirement.name === "General");
    assert.ok(ethics && general);
    await logActivity(credential.id, { requirementIds: [ethics.id] });
    assert.equal(await api.count("activity_requirement_matches", "requirement_id", ethics.id), 1);
    const replaced = await api.post(OWNER, "updateCredential", {
      credentialId: credential.id,
      expectedRevision: credential.revision,
      categories: [
        { requirementId: ethics.id, name: "Ethics & law", requiredUnits: 3 },
        { name: "Supervision", requiredUnits: 2 },
      ],
    });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    const { active } = await api.credential(OWNER, credential.id);
    assert.deepEqual(
      active.requirements.map((requirement) => requirement.name),
      ["Ethics & law", "Supervision"],
    );
    assert.equal(active.requirements[0].id, ethics.id, "a known requirementId is updated in place");
    assert.equal(await api.count("credential_requirements", "id", general.id), 0, "the unused requirement is gone");
    assert.equal(await api.count("activity_requirement_matches", "requirement_id", ethics.id), 1, "the match survives the rename");
    expectError(
      await api.post(OWNER, "updateCredential", {
        credentialId: credential.id,
        expectedRevision: active.revision,
        categories: [{ name: "Only general", requiredUnits: 10 }],
      }),
      409,
      "requirement_in_use",
      /These requirements have logged credits and can’t be removed: Ethics & law\./,
    );
    expectError(
      await api.post(OWNER, "updateCredential", {
        credentialId: credential.id,
        expectedRevision: active.revision,
        categories: [
          { requirementId: ethics.id, name: "Ethics & law", requiredUnits: 8 },
          { name: "Supervision", requiredUnits: 5 },
        ],
      }),
      400,
      "invalid_request",
      /Category requirements cannot exceed the credential total\./,
    );
  });

  await t.test("a submitted cycle accepts a new name but freezes dates; a renewed series renames as one and deletes as one", async () => {
    const credential = await createCustom();
    const submitted = await api.post(OWNER, "markSubmitted", {
      credentialId: credential.id,
      submissionDate: "2026-09-01",
      confirmationNumber: "CONF-1",
    });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    let { active } = await api.credential(OWNER, credential.id);
    assert.equal(active.status, "submitted");
    expectError(
      await api.post(OWNER, "updateCredential", {
        credentialId: credential.id,
        expectedRevision: active.revision,
        deadline: "2027-11-30",
      }),
      409,
      "cycle_closed",
      /This cycle has a logged submission; its dates and requirements are frozen\. Change the display name or issuer only\./,
    );
    const renamedWhileSubmitted = await api.post(OWNER, "updateCredential", {
      credentialId: credential.id,
      expectedRevision: active.revision,
      credentialName: "Alpha LCSW II",
    });
    assert.equal(renamedWhileSubmitted.status, 200, JSON.stringify(renamedWhileSubmitted.body));
    const accepted = await api.post(OWNER, "markRenewalAccepted", {
      credentialId: credential.id,
      acceptedAt: "2026-09-02",
      reference: "ACC-1",
      nextCycleStart: "2028-01-01",
      nextDeadline: "2029-12-31",
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const successorId = accepted.body.id;
    assert.notEqual(successorId, credential.id);
    ({ active } = await api.credential(OWNER, credential.id));
    assert.equal(active.status, "renewed");
    expectError(
      await api.post(OWNER, "updateCredential", {
        credentialId: credential.id,
        expectedRevision: active.revision,
        credentialName: "frozen",
      }),
      409,
      "cycle_closed",
      /This renewal cycle is closed; its record is frozen\./,
    );
    const successor = (await api.credential(OWNER, successorId)).active;
    const renamedSeries = await api.post(OWNER, "updateCredential", {
      credentialId: successorId,
      expectedRevision: successor.revision,
      credentialName: "Alpha LCSW III",
    });
    assert.equal(renamedSeries.status, 200, JSON.stringify(renamedSeries.body));
    const [historyRow] = await raw("SELECT credential_name AS credentialName FROM credentials WHERE id = ?", credential.id);
    assert.equal(historyRow.credentialName, "Alpha LCSW III", "the renewed history row is renamed with its series");
    const deleted = await api.post(OWNER, "deleteCredential", {
      credentialId: successorId,
      expectedRevision: successor.revision + 1,
      confirmName: "Alpha LCSW III",
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    for (const id of [credential.id, successorId]) {
      assert.equal(await api.count("credentials", "id", id), 0, `credential row ${id} is gone`);
      assert.equal(await api.count("credential_cycle_links", "credential_id", id), 0);
      assert.equal(await api.count("renewal_submissions", "credential_id", id), 0);
      assert.equal(await api.count("renewal_acceptances", "credential_id", id), 0);
      assert.equal(await api.count("checklist_tasks", "credential_id", id), 0);
    }
  });

  await t.test("archive hides the credential and its reminders; restore brings it back", async () => {
    const credential = await createCustom({
      cycleStart: shiftDays(today, -345),
      deadline: shiftDays(today, 20),
    });
    const before = await api.workspace(OWNER);
    assert.ok(
      before.reminders.some((reminder) => reminder.credentialId === credential.id),
      "a deadline 20 days out produces a reminder before archiving",
    );
    const archived = await api.post(OWNER, "archiveCredential", {
      credentialId: credential.id,
      expectedRevision: credential.revision,
    });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    assert.deepEqual(archived.body, { ok: true, action: "archiveCredential", id: credential.id });
    let state = await api.credential(OWNER, credential.id);
    assert.equal(state.active, null, "archived credentials leave credentials[]");
    assert.ok(state.archived, "archived credentials appear under archivedCredentials[]");
    assert.equal(typeof state.archived.archivedAt, "string");
    assert.equal(state.archived.revision, credential.revision + 1);
    assert.ok(
      state.workspace.reminders.every((reminder) => reminder.credentialId !== credential.id),
      "archived credentials produce no reminders",
    );
    expectError(
      await api.post(OWNER, "addActivity", {
        title: "Late course",
        completionDate: shiftDays(today, -10),
        totalUnits: 1,
        credentialId: credential.id,
      }),
      409,
      "credential_archived",
    );
    expectError(
      await api.post(OWNER, "archiveCredential", { credentialId: credential.id, expectedRevision: credential.revision + 1 }),
      409,
      "credential_archived",
    );
    expectError(
      await api.post(OWNER, "restoreCredential", { credentialId: credential.id, expectedRevision: credential.revision }),
      409,
      "credential_version_conflict",
    );
    const restored = await api.post(OWNER, "restoreCredential", {
      credentialId: credential.id,
      expectedRevision: credential.revision + 1,
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    state = await api.credential(OWNER, credential.id);
    assert.ok(state.active, "restored credentials are back in credentials[]");
    assert.equal(state.active.archivedAt, null);
    assert.equal(state.active.revision, credential.revision + 2);
    assert.equal(state.archived, null);
    assert.ok(state.workspace.reminders.some((reminder) => reminder.credentialId === credential.id));
    expectError(
      await api.post(OWNER, "restoreCredential", { credentialId: credential.id, expectedRevision: credential.revision + 2 }),
      409,
      "credential_not_archived",
      /This credential is already active\./,
    );
  });

  await t.test("delete is name-confirmed, removes the cycle and its dependants, and keeps the learning record", async () => {
    const credential = await createCustom({
      cycleStart: shiftDays(today, -345),
      deadline: shiftDays(today, 20),
    });
    const ethics = credential.requirements.find((requirement) => requirement.name === "Ethics");
    const activity = await logActivity(credential.id, {
      completionDate: shiftDays(today, -10),
      requirementIds: [ethics.id],
    });
    const dismissed = await api.post(OWNER, "setReminderState", {
      reminderKey: `deadline:${credential.id}:${credential.deadline}`,
      credentialId: credential.id,
      status: "dismissed",
      snoozedUntil: null,
    });
    assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
    assert.equal(await api.count("reminder_states", "credential_id", credential.id), 1);
    expectError(
      await api.post(OWNER, "deleteCredential", {
        credentialId: credential.id,
        expectedRevision: credential.revision,
        confirmName: "Alpha",
      }),
      400,
      "credential_name_mismatch",
      /Type the credential name exactly as shown to confirm deletion\./,
    );
    expectError(
      await api.post(OWNER, "deleteCredential", {
        credentialId: credential.id,
        expectedRevision: credential.revision + 5,
        confirmName: "Alpha LCSW",
      }),
      409,
      "credential_version_conflict",
    );
    expectError(
      await api.post(OWNER, "deleteCredential", { credentialId: credential.id, expectedRevision: credential.revision }),
      400,
      "invalid_request",
      /confirmName is required/,
    );
    assert.equal(await api.count("credentials", "id", credential.id), 1, "refused deletes change nothing");
    const deleted = await api.post(OWNER, "deleteCredential", {
      credentialId: credential.id,
      expectedRevision: credential.revision,
      confirmName: "Alpha LCSW",
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.deepEqual(deleted.body, { ok: true, action: "deleteCredential", id: credential.id });
    for (const [table, column] of [
      ["credentials", "id"],
      ["credential_requirements", "credential_id"],
      ["checklist_tasks", "credential_id"],
      ["activity_allocations", "credential_id"],
      ["credential_cycle_links", "credential_id"],
      ["reminder_states", "credential_id"],
    ]) {
      assert.equal(await api.count(table, column, credential.id), 0, `${table} rows for the credential are gone`);
    }
    assert.equal(await api.count("activity_requirement_matches", "requirement_id", ethics.id), 0);
    const workspace = await api.workspace(OWNER);
    const kept = workspace.activities.find((candidate) => candidate.id === activity.id);
    assert.ok(kept, "the learning record itself is kept");
    assert.deepEqual(kept.allocations, [], "the learning record is unlinked");
    expectError(
      await api.post(OWNER, "deleteCredential", {
        credentialId: credential.id,
        expectedRevision: credential.revision,
        confirmName: "Alpha LCSW",
      }),
      404,
      "credential_not_found",
    );
  });

  await t.test("delete removes only proof that belonged solely to the deleted series, unless deleteOrphanedEvidence is false", async () => {
    const doomed = await createCustom({ credentialName: "Alpha LCSW" });
    const survivor = await createCustom({ credentialName: "Beta LPC" });
    const soloActivity = await logActivity(doomed.id, { title: "Solo course" });
    const sharedActivity = await logActivity(doomed.id, { title: "Shared course" });
    const shared = await api.post(OWNER, "addActivityAllocation", {
      activityId: sharedActivity.id,
      credentialId: survivor.id,
      allocatedUnits: 1,
      requirementIds: [],
    });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const soloEvidence = await api.upload(OWNER, soloActivity.id, "solo.png");
    const sharedEvidence = await api.upload(OWNER, sharedActivity.id, "shared.png");
    const [soloKey] = await raw("SELECT object_key AS objectKey FROM evidence_files WHERE id = ?", soloEvidence.id);
    const [sharedKey] = await raw("SELECT object_key AS objectKey FROM evidence_files WHERE id = ?", sharedEvidence.id);
    assert.ok(bucket.objects.has(soloKey.objectKey) && bucket.objects.has(sharedKey.objectKey));
    // No flag: the spec's default path deletes solely-linked proof.
    const deleted = await api.post(OWNER, "deleteCredential", {
      credentialId: doomed.id,
      expectedRevision: doomed.revision,
      confirmName: "Alpha LCSW",
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.ok(bucket.deletes.includes(soloKey.objectKey), "the solely-linked proof object is deleted from R2 by default");
    assert.ok(!bucket.deletes.includes(sharedKey.objectKey), "proof shared with another credential is not deleted");
    assert.ok(!bucket.objects.has(soloKey.objectKey));
    assert.ok(bucket.objects.has(sharedKey.objectKey));
    assert.equal(await api.count("evidence_files", "id", soloEvidence.id), 0);
    assert.equal(await api.count("evidence_files", "id", sharedEvidence.id), 1);
    const [solo] = await raw("SELECT evidence_status AS evidenceStatus FROM activities WHERE id = ?", soloActivity.id);
    const [sharedRow] = await raw("SELECT evidence_status AS evidenceStatus FROM activities WHERE id = ?", sharedActivity.id);
    assert.equal(solo.evidenceStatus, "missing");
    assert.equal(sharedRow.evidenceStatus, "attached");
    const workspace = await api.workspace(OWNER);
    const sharedAfter = workspace.activities.find((candidate) => candidate.id === sharedActivity.id);
    assert.deepEqual(
      sharedAfter.allocations.map((allocation) => allocation.credentialId),
      [survivor.id],
    );

    const keepEvidence = await createCustom({ credentialName: "Gamma RN" });
    const keptActivity = await logActivity(keepEvidence.id, { title: "Kept course" });
    const keptEvidence = await api.upload(OWNER, keptActivity.id, "kept.png");
    const [keptKey] = await raw("SELECT object_key AS objectKey FROM evidence_files WHERE id = ?", keptEvidence.id);
    const deletedWithOptOut = await api.post(OWNER, "deleteCredential", {
      credentialId: keepEvidence.id,
      expectedRevision: keepEvidence.revision,
      confirmName: "Gamma RN",
      deleteOrphanedEvidence: false,
    });
    assert.equal(deletedWithOptOut.status, 200, JSON.stringify(deletedWithOptOut.body));
    assert.ok(bucket.objects.has(keptKey.objectKey), "with the explicit opt-out, proof is kept");
    assert.equal(await api.count("evidence_files", "id", keptEvidence.id), 1);
  });

  await t.test("delete succeeds when an archived learning record is still allocated to the cycle", async () => {
    const credential = await createCustom({ credentialName: "Delta PT" });
    const activity = await logActivity(credential.id, { title: "Archived course" });
    const archivedActivity = await api.post(OWNER, "archiveActivity", {
      activityId: activity.id,
      expectedRevision: activity.revision,
    });
    assert.equal(archivedActivity.status, 200, JSON.stringify(archivedActivity.body));
    const deleted = await api.post(OWNER, "deleteCredential", {
      credentialId: credential.id,
      expectedRevision: credential.revision,
      confirmName: "Delta PT",
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(await api.count("credentials", "id", credential.id), 0);
    const workspace = await api.workspace(OWNER);
    const kept = workspace.archivedActivities.find((candidate) => candidate.id === activity.id);
    assert.ok(kept, "the archived learning record survives");
    assert.deepEqual(kept.allocations, []);
  });
});
```

- [ ] **Step 2: Add the four names to `tests/helpers/workspaceActions.mjs` and the four isolation rows**

Replace the whole export in `tests/helpers/workspaceActions.mjs` with the 27-name list (switch order; the four new names sit right after `"createCredential"` because that is where their `case` labels go):

```js
export const WORKSPACE_ACTIONS = [
  "createCredential",
  "updateCredential",
  "archiveCredential",
  "restoreCredential",
  "deleteCredential",
  "addActivity",
  "updateActivity",
  "archiveActivity",
  "restoreActivity",
  "addActivityAllocation",
  "updateActivityAllocationRequirements",
  "claimWeeklyQuest",
  "toggleTask",
  "createPersonalTask",
  "updatePersonalTask",
  "archivePersonalTask",
  "restorePersonalTask",
  "markSubmitted",
  "markRenewalAccepted",
  "updateRequirementApplicability",
  "saveDentalCheckpoint",
  "updateWeeklyGoal",
  "updateReminderPreferences",
  "savePushSubscription",
  "removePushSubscription",
  "sendTestPush",
  "setReminderState",
];
```

In `tests/isolation.test.mjs`, append these four rows at the end of `FOREIGN_ID_PROBES` (keep `deleteCredential` last). Validation runs before the ownership lookup in every action, so each payload is otherwise valid: `expectedRevision: 1` passes `expectedRevisionField`, and `confirmName` is present so `textField` does not 400 first.

```js
  {
    action: "updateCredential",
    payload: (seed) => ({ credentialId: seed.credentialId, expectedRevision: 1, credentialName: "hijack" }),
    expect: { status: 404, code: "credential_not_found" },
  },
  {
    action: "archiveCredential",
    payload: (seed) => ({ credentialId: seed.credentialId, expectedRevision: 1 }),
    expect: { status: 404, code: "credential_not_found" },
  },
  {
    action: "restoreCredential",
    payload: (seed) => ({ credentialId: seed.credentialId, expectedRevision: 1 }),
    expect: { status: 404, code: "credential_not_found" },
  },
  {
    action: "deleteCredential",
    payload: (seed) => ({
      credentialId: seed.credentialId,
      expectedRevision: 1,
      confirmName: "Alpha LCSW",
      deleteOrphanedEvidence: true,
    }),
    expect: { status: 404, code: "credential_not_found" },
  },
```

Still in `tests/isolation.test.mjs`, change the enumeration literal that Task 1 promised to this task: `assert.equal(WORKSPACE_ACTIONS.length, 23);` becomes `assert.equal(WORKSPACE_ACTIONS.length, 27);` (`grep -n 'WORKSPACE_ACTIONS.length' tests/isolation.test.mjs` → one hit, inside the subtest `the probe table names every dispatch label exactly once`; without it that subtest fails `27 !== 23` from Step 3 on and stays red through Step 7).

The suite's post-probe owner fingerprint (Task 1: every `user_id` table for A plus `[...bucket.objects.keys()]`) is what proves A's evidence object survives B's `deleteCredential` probe. Make it explicit as well: immediately after the `for (const probe of FOREIGN_ID_PROBES) { … }` loop and before the `the two documented non-404s leave A's push rows untouched` subtest, add this assertion. `bucket` and `seedA` are the suite's own names from Task 1 (`seed` exists only as the parameter name of each row's `payload` closure and is not in scope here):

```js
  assert.ok(
    [...bucket.objects.keys()].some((key) => key.endsWith(`/${seedA.evidenceId}`)),
    "A's evidence object survives B's deleteCredential probe",
  );
```

- [ ] **Step 3: Run the tests to see them fail**

Run:

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
npm run build && node --experimental-sqlite --test tests/workspace-credential-actions.test.mjs tests/isolation.test.mjs tests/app-source-guards.test.mjs
```

Expected: FAIL four ways — (1) the first Task 9 subtest stops at `assert.equal(renamed.status, 200, …)` with `400 !== 200` and the message body `{"error":"Unsupported action: updateCredential","code":"unsupported_action"}`; (2) every new isolation row reports `400 !== 404` (`unsupported_action` instead of `credential_not_found`); (3) the dispatch-label guard in `tests/app-source-guards.test.mjs` reports that `WORKSPACE_ACTIONS` (27) no longer equals the switch labels (23); (4) the isolation subtest `the build dispatches every listed action and nothing else` reports `the build no longer dispatches this action` for the four new names (`unsupported_action`) — red until Step 6. The subtest `the probe table names every dispatch label exactly once` already passes (27 names, 27 rows). Nothing else in those files changes state.

- [ ] **Step 4: Import the bucket accessor and extract `assertTemplateCycleDates` in `app/api/workspace/route.ts`**

Line 1 is exactly `import { getD1 } from "@/db";` (`grep -n 'from "@/db";' app/api/workspace/route.ts` → one hit, line 1). Replace it with:

```ts
import { getD1, getEvidenceBucket } from "@/db";
```

Locate the template date block inside `createCredential`: `grep -n '    if (isNremtRuleSet(ruleSetId)) {' app/api/workspace/route.ts` → one hit (5390 on `main@8ac172a`; the earlier `if (ruleSetId && isNremtRuleSet(ruleSetId)) {` at 5350 is a different line and stays), and `grep -n '"rule_transition_outside_template",' app/api/workspace/route.ts` → one hit (5512). The block to cut runs from the `if (isNremtRuleSet(ruleSetId)) {` line through the `    }` three lines after `"rule_transition_outside_template",` — 126 lines whose first three and last three are:

```ts
    if (isNremtRuleSet(ruleSetId)) {
      assertNremtCredentialDates(ruleSetId, deadline, payload);
    }
    …
        "rule_transition_outside_template",
      );
    }
```

and whose next line is `    const ruleCategories = await query(`. Replace those 126 lines with this single statement (the `let abveAnnualStartYear: number | null = null;` declaration above the `if (ruleSetId) {` branch stays):

```ts
    abveAnnualStartYear = assertTemplateCycleDates(
      rule,
      ruleSetId,
      cycleStart,
      deadline,
      payload,
    );
```

Then add the extracted function immediately **before** `async function createCredential(` (`grep -n '^async function createCredential(' app/api/workspace/route.ts` → 5341 on `main@8ac172a`). Its body is the cut block re-indented by two spaces, wrapped so it returns the ABVE start year:

```ts
// The template date and attestation rules that createCredential enforced at
// creation, shared with updateCredential so a date edit can never become a
// bypass of a fixed-deadline or full-cycle template (app-ux-03).
function assertTemplateCycleDates(
  rule: CatalogRule,
  ruleSetId: string,
  cycleStart: string,
  deadline: string,
  payload: JsonRecord,
) {
  let abveAnnualStartYear: number | null = null;
  if (isNremtRuleSet(ruleSetId)) {
    assertNremtCredentialDates(ruleSetId, deadline, payload);
  }
  if (ruleSetId.startsWith(FLORIDA_MENTAL_HEALTH_RULE_SET_PREFIX)) {
    assertFloridaMentalHealthCredentialDates(
      cycleStart,
      deadline,
      payload,
    );
  }
  if (
    ruleSetId.startsWith(CRCC_RULE_SET_PREFIX) ||
    ruleSetId.startsWith(ABVE_RULE_SET_PREFIX)
  ) {
    abveAnnualStartYear = assertRehabilitationCertificationDates(
      ruleSetId,
      cycleStart,
      deadline,
      payload,
    );
  }
  if (
    isExpandedCertificationRuleSetId(ruleSetId) &&
    payload.officialDatesAttested !== true
  ) {
    throw new RequestError(
      "Confirm that the credential or license path, status, cycle start, and deadline match the official issuer or regulator record.",
      409,
      "expanded_certification_dates_attestation_required",
    );
  }
  if (
    isExpandedCertificationRuleSetId(ruleSetId) &&
    payload.templateEligibilityAttested !== true
  ) {
    throw new RequestError(
      "Confirm that this is the standard full-cycle credential or license maintenance path and that no initial, shortened, waiver, inactive, retired, reinstatement, synchronized or multi-credential, exam-alternative, or other adjusted variant applies.",
      409,
      "expanded_certification_template_eligibility_required",
    );
  }
  if (
    rule.profession === "Pharmacy" &&
    payload.templateEligibilityAttested !== true
  ) {
    throw new RequestError(
      "Confirm that the official record shows a standard full pharmacist renewal period and that no shortened, inactive, prorated, exempt, or other adjusted-status variant applies.",
      409,
      "pharmacist_template_eligibility_required",
    );
  }
  if (
    rule.profession === "Nursing" &&
    payload.templateEligibilityAttested !== true
  ) {
    throw new RequestError(
      ruleSetId === "tx-rn-2026-v1" ||
        ruleSetId === "tx-lvn-2026-v1"
        ? "Confirm that the official record matches a standard full Texas nursing renewal using the 20-hour CNE path—not the certification alternative—and that no initial, shortened, inactive, exempt, or other adjusted-status path applies."
        : "Confirm that the official record matches this standard full nursing renewal or registration period and that no initial, shortened, inactive, prorated, exempt, or other adjusted-status path applies.",
      409,
      "nursing_template_eligibility_required",
    );
  }
  if (
    rule.profession === "Dental" &&
    payload.templateEligibilityAttested !== true
  ) {
    throw new RequestError(
      "Confirm that the official record matches this standard full dental renewal or registration period and that no initial, shortened, inactive, retired, prorated, exempt, or other adjusted-status path applies.",
      409,
      "dental_template_eligibility_required",
    );
  }
  if (
    rule.profession === "Pharmacy" &&
    !matchesFullCycleWindow(
      cycleStart,
      deadline,
      Number(rule.cycleMonths),
    )
  ) {
    throw new RequestError(
      `This pharmacist template requires a standard full ${rule.cycleMonths}-month period. Use the exact regulator dates or create a custom plan for a shortened or adjusted period.`,
      409,
      "pharmacist_standard_cycle_dates_required",
    );
  }
  if (
    rule.profession === "Nursing" &&
    !matchesFullCycleWindow(
      cycleStart,
      deadline,
      Number(rule.cycleMonths),
    )
  ) {
    throw new RequestError(
      `This nursing template requires a standard full ${rule.cycleMonths}-month period. Use the exact regulator dates or create a custom plan for an initial, shortened, or adjusted period.`,
      409,
      "nursing_standard_cycle_dates_required",
    );
  }
  if (
    rule.profession === "Dental" &&
    !matchesFullCycleWindow(
      cycleStart,
      deadline,
      Number(rule.cycleMonths),
    )
  ) {
    throw new RequestError(
      `This dental template requires a standard full ${rule.cycleMonths}-month period. Use the exact regulator dates or create a custom plan for an initial, shortened, or adjusted period.`,
      409,
      "dental_standard_cycle_dates_required",
    );
  }
  if (
    ruleSetId === CFP_PRE_2027_RULE_SET_ID &&
    cycleStart >= CFP_2027_CYCLE_START
  ) {
    throw new RequestError(
      "This 30-hour CFP template is only for certification periods beginning before April 1, 2027. Use the 40-hour CFP requirement for a later cycle, and record carryover only after CFP Board confirms the eligible general CE amount.",
      409,
      "rule_transition_outside_template",
    );
  }
  return abveAnnualStartYear;
}
```

Sanity check before moving on: `grep -c '"rule_transition_outside_template"' app/api/workspace/route.ts` → 1 (it lives only in the new function now) and `npm run typecheck` → clean.

- [ ] **Step 5: Add the credential mutation helpers and the four actions**

Insert the following block immediately **before** `async function getActivityAllocationValidationRows(` (`grep -n '^async function getActivityAllocationValidationRows(' app/api/workspace/route.ts` → 6246 on `main@8ac172a`; it is the function right after `assertActivityMutationState`). Every name is new — `grep -n 'getCredentialForMutation\|setCredentialArchivedState\|sqlPlaceholders\|CredentialRequirementRow' app/api/workspace/route.ts` returns nothing before this step.

```ts
// ---------------------------------------------------------------------------
// Credential mutations (app-ux-03). Same shape as the activity mutations
// above: load the owned row, assert its revision and archive state, write
// inside one batch, and diagnose a no-op batch into a precise 409.
// ---------------------------------------------------------------------------

type CredentialMutationRow = {
  id: string;
  ruleSetId: string | null;
  credentialName: string;
  profession: string;
  jurisdiction: string;
  issuer: string;
  cycleStart: string;
  deadline: string;
  totalRequired: number;
  unitLabel: string;
  status: string;
  revision: number;
  archivedAt: string | null;
  seriesId: string;
  cycleMonths: number;
};

type CredentialRequirementRow = {
  id: string;
  ruleCategoryId: string | null;
  name: string;
  requiredUnits: number;
  kind: RequirementKind;
  relation: RequirementRelation;
  parentRequirementId: string | null;
  applicability: RequirementApplicability;
  applicabilityStatus: ApplicabilityStatus;
  conditionNote: string | null;
  exclusiveGroup: string | null;
  isActive: number;
  sortOrder: number;
};

// Keys a submitted cycle refuses (its dates and requirements are frozen) and
// keys a template-linked credential refuses (the template owns them).
const CREDENTIAL_FROZEN_KEYS = [
  "cycleStart",
  "deadline",
  "jurisdiction",
  "profession",
  "totalRequired",
  "unitLabel",
  "categories",
] as const;
const CREDENTIAL_TEMPLATE_LOCKED_KEYS = [
  "jurisdiction",
  "profession",
  "issuer",
  "totalRequired",
  "unitLabel",
  "categories",
] as const;

function sqlPlaceholders(values: readonly unknown[]) {
  return values.map(() => "?").join(", ");
}

async function getCredentialForMutation(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
) {
  return query(
    database,
    `SELECT
      c.id,
      c.rule_set_id AS ruleSetId,
      c.credential_name AS credentialName,
      c.profession,
      c.jurisdiction,
      c.issuer,
      c.cycle_start AS cycleStart,
      c.deadline,
      c.total_required AS totalRequired,
      c.unit_label AS unitLabel,
      c.status,
      c.revision,
      c.archived_at AS archivedAt,
      COALESCE(cycle.series_id, c.id) AS seriesId,
      COALESCE(cycle.cycle_months, rs.cycle_months, 12) AS cycleMonths
     FROM credentials c
     LEFT JOIN credential_cycle_links cycle
       ON cycle.credential_id = c.id AND cycle.user_id = c.user_id
     LEFT JOIN rule_sets rs ON rs.id = c.rule_set_id
     WHERE c.id = ? AND c.user_id = ?`,
    [credentialId, identity.userId],
  ).first<CredentialMutationRow>();
}

function assertCredentialMutationState(
  credential: CredentialMutationRow | null,
  expectedRevision: number,
  archiveState: "active" | "archived" | "any",
): asserts credential is CredentialMutationRow {
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  if (Number(credential.revision) !== expectedRevision) {
    throw new RequestError(
      "This credential changed in another session. Refresh and try again.",
      409,
      "credential_version_conflict",
    );
  }
  if (archiveState === "active" && credential.archivedAt) {
    throw new RequestError(
      "This credential is archived. Restore it before making changes.",
      409,
      "credential_archived",
    );
  }
  if (archiveState === "archived" && !credential.archivedAt) {
    throw new RequestError(
      "This credential is already active.",
      409,
      "credential_not_archived",
    );
  }
}

async function seriesCredentialIds(
  database: D1Database,
  identity: RequestIdentity,
  seriesId: string,
  fallbackId: string,
) {
  const linked = await query(
    database,
    `SELECT credential_id AS credentialId
     FROM credential_cycle_links
     WHERE user_id = ? AND series_id = ?
     ORDER BY created_at, credential_id`,
    [identity.userId, seriesId],
  ).all<{ credentialId: string }>();
  const ids = new Set(linked.results.map((row) => row.credentialId));
  ids.add(fallbackId);
  return [...ids];
}

async function diagnoseCredentialMutationFailure(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
  expectedRevision: number,
  archiveState: "active" | "archived" | "any",
): Promise<never> {
  const credential = await getCredentialForMutation(
    database,
    identity,
    credentialId,
  );
  assertCredentialMutationState(credential, expectedRevision, archiveState);
  throw new RequestError(
    "This credential changed while it was being saved. Refresh and try again.",
    409,
    "credential_state_changed",
  );
}

// The custom-credential category parser from createCredential, keyed so a
// replace-set can address existing requirements by id.
function credentialCategoryDraftsFromPayload(
  payload: JsonRecord,
  totalRequired: number,
): CredentialCategoryDraft[] {
  const rawCategories = payload.categories;
  if (!Array.isArray(rawCategories) || rawCategories.length > 30) {
    throw new RequestError("categories must be an array of up to 30 items");
  }
  const categories: CredentialCategoryDraft[] = rawCategories.map(
    (item, index) => {
      if (!isRecord(item)) {
        throw new RequestError(`categories[${index}] must be an object`);
      }
      const kind = enumField(item, "kind", REQUIREMENT_KINDS, "minimum");
      const relation = enumField(
        item,
        "relation",
        REQUIREMENT_RELATIONS,
        "independent",
      );
      const applicability = enumField(
        item,
        "applicability",
        REQUIREMENT_APPLICABILITIES,
        "always",
      );
      const applicabilityStatus = normalizedApplicabilityStatus(
        applicability,
        item.applicabilityStatus,
        `categories[${index}].applicabilityStatus`,
      );
      const conditionNote = textField(item, "conditionNote", { max: 500 });
      const exclusiveGroup = textField(item, "exclusiveGroup", { max: 80 });
      if (applicability === "conditional" && !conditionNote) {
        throw new RequestError(
          `categories[${index}].conditionNote is required for a conditional rule`,
        );
      }
      const requiredUnits =
        kind === "informational"
          ? (nonNegativeNumber(item, "requiredUnits") ?? 0)
          : positiveNumber(item, "requiredUnits", { required: true })!;
      return {
        key:
          textField(item, "requirementId", { max: 160 }) ??
          textField(item, "key", { max: 160 }) ??
          `custom-category-${index}`,
        ruleCategoryId: null,
        name: textField(item, "name", { required: true, max: 100 })!,
        requiredUnits,
        kind,
        relation,
        parentKey: textField(item, "parentRequirementId", { max: 160 }),
        applicability,
        applicabilityStatus,
        conditionNote,
        exclusiveGroup,
        isActive: applicabilityStatus === "applies",
        sortOrder: index,
      };
    },
  );
  if (categories.length === 0) {
    return [
      {
        key: "general",
        ruleCategoryId: null,
        name: "General",
        requiredUnits: totalRequired,
        kind: "minimum",
        relation: "independent",
        parentKey: null,
        applicability: "always",
        applicabilityStatus: "applies",
        conditionNote: null,
        exclusiveGroup: null,
        isActive: true,
        sortOrder: 0,
      },
    ];
  }
  if (
    new Set(categories.map((category) => category.key)).size !==
    categories.length
  ) {
    throw new RequestError("Custom category keys must be unique");
  }
  return categories;
}

function credentialCategoryDraftsFromRows(
  rows: readonly CredentialRequirementRow[],
): CredentialCategoryDraft[] {
  return rows.map((row, index) => ({
    key: row.id,
    ruleCategoryId: row.ruleCategoryId,
    name: row.name,
    requiredUnits: Number(row.requiredUnits),
    kind: row.kind,
    relation: row.relation,
    parentKey: row.parentRequirementId,
    applicability: row.applicability,
    applicabilityStatus: row.applicabilityStatus,
    conditionNote: row.conditionNote,
    exclusiveGroup: row.exclusiveGroup,
    isActive: Number(row.isActive) === 1,
    sortOrder: index,
  }));
}

function assertCategoryTotalWithinCredential(
  categories: readonly CredentialCategoryDraft[],
  totalRequired: number,
) {
  const categoryTotal = categories.reduce(
    (sum, category) =>
      category.isActive &&
      category.kind === "minimum" &&
      category.relation === "independent" &&
      !category.parentKey
        ? sum + category.requiredUnits
        : sum,
    0,
  );
  if (categoryTotal > totalRequired + 0.001) {
    throw new RequestError(
      "Category requirements cannot exceed the credential total.",
    );
  }
}

async function updateCredential(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const credentialId = textField(payload, "credentialId", {
    required: true,
    max: 160,
  })!;
  const expectedRevision = expectedRevisionField(payload);
  const credential = await getCredentialForMutation(
    database,
    identity,
    credentialId,
  );
  assertCredentialMutationState(credential, expectedRevision, "active");
  const present = (key: string) => payload[key] !== undefined;
  if (credential.status === "renewed") {
    throw new RequestError(
      "This renewal cycle is closed; its record is frozen.",
      409,
      "cycle_closed",
    );
  }
  if (credential.status === "submitted" && CREDENTIAL_FROZEN_KEYS.some(present)) {
    throw new RequestError(
      "This cycle has a logged submission; its dates and requirements are frozen. Change the display name or issuer only.",
      409,
      "cycle_closed",
    );
  }
  if (
    credential.ruleSetId !== null &&
    CREDENTIAL_TEMPLATE_LOCKED_KEYS.some(present)
  ) {
    throw new RequestError(
      "Source-linked credentials take their requirements from the template. Change dates or the display name only, or create a custom plan.",
      400,
      "template_field_locked",
    );
  }

  const credentialName = present("credentialName")
    ? textField(payload, "credentialName", { required: true, max: 180 })!
    : credential.credentialName;
  const issuer = present("issuer")
    ? (textField(payload, "issuer", { max: 180 }) ?? "Self-managed credential")
    : credential.issuer;
  const jurisdiction = present("jurisdiction")
    ? textField(payload, "jurisdiction", { required: true, max: 120 })!
    : credential.jurisdiction;
  const profession = present("profession")
    ? textField(payload, "profession", { required: true, max: 120 })!
    : credential.profession;
  const totalRequired = present("totalRequired")
    ? positiveNumber(payload, "totalRequired", { required: true })!
    : Number(credential.totalRequired);
  const unitLabel = present("unitLabel")
    ? textField(payload, "unitLabel", { required: true, max: 40 })!
    : credential.unitLabel;
  const cycleStart = present("cycleStart")
    ? isoDateField(payload, "cycleStart")!
    : credential.cycleStart;
  const deadline = present("deadline")
    ? isoDateField(payload, "deadline")!
    : credential.deadline;
  if (cycleStart > deadline) {
    throw new RequestError("deadline must be on or after cycleStart");
  }
  const datesChanged =
    cycleStart !== credential.cycleStart || deadline !== credential.deadline;
  const deadlineChanged = deadline !== credential.deadline;

  let abveAnnualStartYear: number | null = null;
  if (datesChanged && credential.ruleSetId !== null) {
    const rule = await query(
      database,
      `SELECT
        id,
        credential_name AS credentialName,
        profession,
        jurisdiction,
        issuer,
        total_units AS totalUnits,
        unit_label AS unitLabel,
        cycle_months AS cycleMonths
      FROM rule_sets
      WHERE id = ? AND is_current = 1`,
      [credential.ruleSetId],
    ).first<CatalogRule>();
    if (!rule) {
      throw new RequestError(
        "The selected rule set was not found or is no longer current.",
        404,
        "rule_set_not_found",
      );
    }
    abveAnnualStartYear = assertTemplateCycleDates(
      rule,
      credential.ruleSetId,
      cycleStart,
      deadline,
      payload,
    );
  }

  if (datesChanged) {
    const allocated = await query(
      database,
      `SELECT
        a.id,
        a.title,
        a.completion_date AS completionDate,
        req.rule_category_id AS ruleCategoryId
      FROM activities a
      JOIN activity_allocations x ON x.activity_id = a.id
      LEFT JOIN activity_requirement_matches m
        ON m.allocation_id = x.id AND m.user_id = a.user_id
      LEFT JOIN credential_requirements req ON req.id = m.requirement_id
      WHERE x.credential_id = ?
        AND a.user_id = ?
        AND a.archived_at IS NULL
      ORDER BY a.completion_date, a.id`,
      [credentialId, identity.userId],
    ).all<{
      id: string;
      title: string;
      completionDate: string;
      ruleCategoryId: string | null;
    }>();
    const byActivity = new Map<
      string,
      { title: string; completionDate: string; requirements: { ruleCategoryId: string | null }[] }
    >();
    for (const row of allocated.results) {
      const entry = byActivity.get(row.id) ?? {
        title: row.title,
        completionDate: row.completionDate,
        requirements: [],
      };
      if (row.ruleCategoryId !== null) {
        entry.requirements.push({ ruleCategoryId: row.ruleCategoryId });
      }
      byActivity.set(row.id, entry);
    }
    const outside: string[] = [];
    for (const activity of byActivity.values()) {
      try {
        assertActivityDateFitsCredential(
          activity.completionDate,
          { cycleStart, deadline },
          activity.requirements,
          "completion date",
        );
      } catch (error) {
        if (!(error instanceof RequestError)) throw error;
        outside.push(activity.title);
      }
    }
    if (outside.length > 0) {
      throw new RequestError(
        `These learning records fall outside the new cycle dates: ${outside.join(", ")}. Change their dates or keep the cycle dates.`,
        409,
        "activities_outside_cycle",
      );
    }
  }

  const existingRequirements = await query(
    database,
    `SELECT
      req.id,
      req.rule_category_id AS ruleCategoryId,
      req.name,
      req.required_units AS requiredUnits,
      req.kind,
      req.relation,
      req.parent_requirement_id AS parentRequirementId,
      req.applicability,
      req.applicability_status AS applicabilityStatus,
      req.condition_note AS conditionNote,
      req.exclusive_group AS exclusiveGroup,
      req.is_active AS isActive,
      req.sort_order AS sortOrder
     FROM credential_requirements req
     JOIN credentials c ON c.id = req.credential_id
     WHERE req.credential_id = ? AND c.user_id = ?
     ORDER BY req.sort_order, req.name`,
    [credentialId, identity.userId],
  ).all<CredentialRequirementRow>();
  const categoriesChanged = present("categories");
  const categories = categoriesChanged
    ? credentialCategoryDraftsFromPayload(payload, totalRequired)
    : credentialCategoryDraftsFromRows(existingRequirements.results);
  let orderedCategories: CredentialCategoryDraft[] = [];
  if (categoriesChanged || present("totalRequired")) {
    orderedCategories = orderedCategoryDrafts(categories);
    validateActiveCategoryParents(categories);
    assertCategoryTotalWithinCredential(categories, totalRequired);
  }

  // Every guarded statement below tests the same pre-bump revision; the
  // credential row's own UPDATE is the last statement, so a stale revision
  // makes the whole batch a no-op instead of a partial write.
  const guard = `EXISTS (
    SELECT 1
    FROM credentials g
    WHERE g.id = ?
      AND g.user_id = ?
      AND g.revision = ?
      AND g.archived_at IS NULL
      AND g.status IN ('active', 'submitted')
  )`;
  const guardBindings = [credentialId, identity.userId, expectedRevision];
  const statements: D1PreparedStatement[] = [];

  if (categoriesChanged) {
    const existingById = new Map(
      existingRequirements.results.map((row) => [row.id, row]),
    );
    const requirementIdByKey = new Map(
      orderedCategories.map((category) => [
        category.key,
        existingById.has(category.key) ? category.key : crypto.randomUUID(),
      ]),
    );
    const removedIds = existingRequirements.results
      .map((row) => row.id)
      .filter((id) => !requirementIdByKey.has(id));
    if (removedIds.length > 0) {
      const inUse = await query(
        database,
        `SELECT name
         FROM credential_requirements
         WHERE credential_id = ?
           AND id IN (${sqlPlaceholders(removedIds)})
           AND (
             EXISTS (
               SELECT 1
               FROM activity_requirement_matches m
               WHERE m.requirement_id = credential_requirements.id
             )
             OR EXISTS (
               SELECT 1
               FROM activity_allocations x
               WHERE x.requirement_id = credential_requirements.id
             )
           )
         ORDER BY sort_order, name`,
        [credentialId, ...removedIds],
      ).all<{ name: string }>();
      if (inUse.results.length > 0) {
        throw new RequestError(
          `These requirements have logged credits and can’t be removed: ${inUse.results.map((row) => row.name).join(", ")}.`,
          409,
          "requirement_in_use",
        );
      }
    }
    for (const id of removedIds) {
      statements.push(
        query(
          database,
          `DELETE FROM credential_requirements
           WHERE id = ? AND credential_id = ? AND ${guard}`,
          [id, credentialId, ...guardBindings],
        ),
      );
    }
    for (const category of orderedCategories) {
      const id = requirementIdByKey.get(category.key)!;
      const parentId = category.parentKey
        ? (requirementIdByKey.get(category.parentKey) ?? null)
        : null;
      const values = [
        category.name,
        category.requiredUnits,
        category.kind,
        category.relation,
        parentId,
        category.applicability,
        category.applicabilityStatus,
        category.conditionNote,
        category.exclusiveGroup,
        category.isActive ? 1 : 0,
        category.sortOrder,
      ];
      if (existingById.has(id)) {
        statements.push(
          query(
            database,
            `UPDATE credential_requirements
             SET name = ?, required_units = ?, kind = ?, relation = ?,
               parent_requirement_id = ?, applicability = ?,
               applicability_status = ?, condition_note = ?,
               exclusive_group = ?, is_active = ?, sort_order = ?
             WHERE id = ? AND credential_id = ? AND ${guard}`,
            [...values, id, credentialId, ...guardBindings],
          ),
        );
      } else {
        statements.push(
          query(
            database,
            `INSERT INTO credential_requirements (
              id, credential_id, rule_category_id, name, required_units, kind,
              relation, parent_requirement_id, applicability,
              applicability_status, condition_note, exclusive_group, is_active,
              sort_order
            )
            SELECT ?, g.id, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            FROM credentials g
            WHERE g.id = ?
              AND g.user_id = ?
              AND g.revision = ?
              AND g.archived_at IS NULL
              AND g.status IN ('active', 'submitted')`,
            [id, ...values, ...guardBindings],
          ),
        );
      }
    }
  }

  if (datesChanged && credential.ruleSetId === null) {
    statements.push(
      query(
        database,
        `UPDATE credential_cycle_links
         SET cycle_months = ?
         WHERE credential_id = ? AND user_id = ? AND ${guard}`,
        [
          estimatedCycleMonths(cycleStart, deadline),
          credentialId,
          identity.userId,
          ...guardBindings,
        ],
      ),
    );
  }
  if (deadlineChanged) {
    const taskSpecs = renewalTaskSpecs(credential.ruleSetId, deadline, undefined, {
      abveAnnualStartYear: abveAnnualStartYear ?? undefined,
    });
    for (const task of taskSpecs) {
      statements.push(
        query(
          database,
          `UPDATE checklist_tasks
           SET due_date = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
           WHERE user_id = ?
             AND credential_id = ?
             AND is_personal = 0
             AND status = 'pending'
             AND archived_at IS NULL
             AND kind = ?
             AND title = ?
             AND ${guard}`,
          [
            task.dueDate,
            identity.userId,
            credentialId,
            task.kind,
            task.title,
            ...guardBindings,
          ],
        ),
      );
    }
  }
  const series = await seriesCredentialIds(
    database,
    identity,
    credential.seriesId,
    credentialId,
  );
  const siblings = series.filter((id) => id !== credentialId);
  if (
    siblings.length > 0 &&
    (credentialName !== credential.credentialName ||
      issuer !== credential.issuer)
  ) {
    statements.push(
      query(
        database,
        `UPDATE credentials
         SET credential_name = ?, issuer = ?, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?
           AND id IN (${sqlPlaceholders(siblings)})
           AND ${guard}`,
        [credentialName, issuer, identity.userId, ...siblings, ...guardBindings],
      ),
    );
  }
  statements.push(
    query(
      database,
      `UPDATE credentials
       SET
         credential_name = ?,
         issuer = ?,
         cycle_start = ?,
         deadline = ?,
         jurisdiction = ?,
         profession = ?,
         total_required = ?,
         unit_label = ?,
         revision = revision + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND user_id = ?
         AND revision = ?
         AND archived_at IS NULL
         AND status IN ('active', 'submitted')`,
      [
        credentialName,
        issuer,
        cycleStart,
        deadline,
        jurisdiction,
        profession,
        totalRequired,
        unitLabel,
        credentialId,
        identity.userId,
        expectedRevision,
      ],
    ),
  );
  const results = await database.batch(statements);
  const credentialResult = results[results.length - 1];
  if (Number(credentialResult?.meta?.changes ?? Number.NaN) !== 1) {
    return diagnoseCredentialMutationFailure(
      database,
      identity,
      credentialId,
      expectedRevision,
      "active",
    );
  }
  return credentialId;
}

async function setCredentialArchivedState(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
  restore: boolean,
) {
  const credentialId = textField(payload, "credentialId", {
    required: true,
    max: 160,
  })!;
  const expectedRevision = expectedRevisionField(payload);
  const expectedState = restore ? "archived" : "active";
  const credential = await getCredentialForMutation(
    database,
    identity,
    credentialId,
  );
  assertCredentialMutationState(credential, expectedRevision, expectedState);
  const series = await seriesCredentialIds(
    database,
    identity,
    credential.seriesId,
    credentialId,
  );
  const siblings = series.filter((id) => id !== credentialId);
  const archivedAtValue = restore ? "NULL" : "CURRENT_TIMESTAMP";
  const fromState = restore ? "IS NOT NULL" : "IS NULL";
  const toState = restore ? "IS NULL" : "IS NOT NULL";
  // The target row moves first under its expected revision; the rest of the
  // series follows only once the target is provably in the new state.
  const statements: D1PreparedStatement[] = [
    query(
      database,
      `UPDATE credentials
       SET archived_at = ${archivedAtValue},
         revision = revision + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND user_id = ?
         AND revision = ?
         AND archived_at ${fromState}`,
      [credentialId, identity.userId, expectedRevision],
    ),
  ];
  if (siblings.length > 0) {
    statements.push(
      query(
        database,
        `UPDATE credentials
         SET archived_at = ${archivedAtValue},
           revision = revision + 1,
           updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?
           AND archived_at ${fromState}
           AND id IN (${sqlPlaceholders(siblings)})
           AND EXISTS (
             SELECT 1
             FROM credentials t
             WHERE t.id = ?
               AND t.user_id = ?
               AND t.revision = ?
               AND t.archived_at ${toState}
           )`,
        [
          identity.userId,
          ...siblings,
          credentialId,
          identity.userId,
          expectedRevision + 1,
        ],
      ),
    );
  }
  const results = await database.batch(statements);
  if (Number(results[0]?.meta?.changes ?? Number.NaN) !== 1) {
    return diagnoseCredentialMutationFailure(
      database,
      identity,
      credentialId,
      expectedRevision,
      expectedState,
    );
  }
  return credentialId;
}

async function archiveCredential(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  return setCredentialArchivedState(database, identity, payload, false);
}

async function restoreCredential(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  return setCredentialArchivedState(database, identity, payload, true);
}

async function deleteCredential(
  database: D1Database,
  bucket: R2Bucket,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const credentialId = textField(payload, "credentialId", {
    required: true,
    max: 160,
  })!;
  const expectedRevision = expectedRevisionField(payload);
  const confirmName = textField(payload, "confirmName", {
    required: true,
    max: 180,
  })!;
  // Spec §4: proof linked only to this credential is deleted. Only the
  // literal `false` (the confirm dialog's unticked checkbox) opts out.
  const deleteOrphanedEvidence = payload.deleteOrphanedEvidence !== false;
  const credential = await getCredentialForMutation(
    database,
    identity,
    credentialId,
  );
  assertCredentialMutationState(credential, expectedRevision, "any");
  if (confirmName !== credential.credentialName) {
    throw new RequestError(
      "Type the credential name exactly as shown to confirm deletion.",
      400,
      "credential_name_mismatch",
    );
  }
  const series = await seriesCredentialIds(
    database,
    identity,
    credential.seriesId,
    credentialId,
  );
  const siblings = series.filter((id) => id !== credentialId);
  const seriesList = sqlPlaceholders(series);

  // Proof files belong to activities, which survive; only files whose
  // activity is allocated to nothing outside this series are candidates, and
  // none are when the caller opted out with deleteOrphanedEvidence: false.
  const orphans = deleteOrphanedEvidence
    ? (
        await query(
          database,
          `SELECT e.id, e.object_key AS objectKey, e.activity_id AS activityId
           FROM evidence_files e
           JOIN activities a ON a.id = e.activity_id AND a.user_id = e.user_id
           WHERE e.user_id = ?
             AND e.status IN ('ready', 'deleting')
             AND EXISTS (
               SELECT 1
               FROM activity_allocations x
               WHERE x.activity_id = a.id
                 AND x.credential_id IN (${seriesList})
             )
             AND NOT EXISTS (
               SELECT 1
               FROM activity_allocations y
               WHERE y.activity_id = a.id
                 AND y.credential_id NOT IN (${seriesList})
             )
           ORDER BY e.created_at, e.id`,
          [identity.userId, ...series, ...series],
        ).all<{ id: string; objectKey: string; activityId: string }>()
      ).results
    : [];
  const orphanIds = orphans.map((orphan) => orphan.id);

  // Statements before the target delete are guarded by "the target row still
  // sits at the expected revision"; the target delete itself carries the
  // revision; statements after it are guarded by "the target row is gone".
  // Restrict foreign keys force acceptances and links out before any
  // credential row; the credential rows then cascade their children, which
  // passes the BEFORE DELETE guard triggers because SQLite runs foreign-key
  // actions after the parent row has been removed.
  const stillExpected = `EXISTS (
    SELECT 1 FROM credentials t
    WHERE t.id = ? AND t.user_id = ? AND t.revision = ?
  )`;
  const stillExpectedBindings = [credentialId, identity.userId, expectedRevision];
  const gone = `NOT EXISTS (
    SELECT 1 FROM credentials t WHERE t.id = ? AND t.user_id = ?
  )`;
  const goneBindings = [credentialId, identity.userId];
  const statements: D1PreparedStatement[] = [
    query(
      database,
      `DELETE FROM renewal_acceptances
       WHERE user_id = ?
         AND (credential_id IN (${seriesList}) OR next_credential_id IN (${seriesList}))
         AND ${stillExpected}`,
      [identity.userId, ...series, ...series, ...stillExpectedBindings],
    ),
    query(
      database,
      `DELETE FROM credential_cycle_links
       WHERE user_id = ?
         AND (credential_id IN (${seriesList}) OR previous_credential_id IN (${seriesList}))
         AND ${stillExpected}`,
      [identity.userId, ...series, ...series, ...stillExpectedBindings],
    ),
    query(
      database,
      `DELETE FROM renewal_submissions
       WHERE user_id = ? AND credential_id IN (${seriesList}) AND ${stillExpected}`,
      [identity.userId, ...series, ...stillExpectedBindings],
    ),
    ...siblings.map((id) =>
      query(
        database,
        `DELETE FROM credentials WHERE user_id = ? AND id = ? AND ${stillExpected}`,
        [identity.userId, id, ...stillExpectedBindings],
      ),
    ),
    query(
      database,
      `DELETE FROM credentials WHERE id = ? AND user_id = ? AND revision = ?`,
      [credentialId, identity.userId, expectedRevision],
    ),
  ];
  const targetIndex = statements.length - 1;
  if (orphanIds.length > 0) {
    statements.push(
      query(
        database,
        `UPDATE evidence_files
         SET status = 'deleting', updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND id IN (${sqlPlaceholders(orphanIds)}) AND ${gone}`,
        [identity.userId, ...orphanIds, ...goneBindings],
      ),
    );
    // The activity recompute from app/api/evidence/[id]/route.ts, run while
    // the rows are in 'deleting' exactly as that route does.
    for (const activityId of new Set(orphans.map((orphan) => orphan.activityId))) {
      statements.push(
        query(
          database,
          `UPDATE activities
           SET
             evidence_status = CASE
               WHEN evidence_status = 'not_required' THEN 'not_required'
               WHEN EXISTS (
                 SELECT 1
                 FROM evidence_files stored
                 WHERE stored.activity_id = activities.id
                   AND stored.user_id = activities.user_id
                   AND stored.status = 'ready'
               ) THEN 'attached'
               ELSE 'missing'
             END,
             evidence_reference = CASE
               WHEN evidence_reference IS NULL
                 OR (
                   evidence_reference NOT LIKE 'CRCC pre-approved | %'
                   AND evidence_reference NOT LIKE 'CRCC post-approved | %'
                   AND EXISTS (
                     SELECT 1
                     FROM evidence_files derived
                     WHERE derived.activity_id = activities.id
                       AND derived.user_id = activities.user_id
                       AND derived.original_filename =
                         activities.evidence_reference
                   )
                 )
               THEN (
                 SELECT stored.original_filename
                 FROM evidence_files stored
                 WHERE stored.activity_id = activities.id
                   AND stored.user_id = activities.user_id
                   AND stored.status = 'ready'
                 ORDER BY stored.created_at DESC, stored.id DESC
                 LIMIT 1
               )
               ELSE evidence_reference
             END,
             revision = revision + 1,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND user_id = ? AND ${gone}`,
          [activityId, identity.userId, ...goneBindings],
        ),
      );
    }
  }
  // Orphan sweeps: no-ops when the cascades ran (foreign keys are on in D1,
  // miniflare and node:sqlite), correct if they ever did not.
  statements.push(
    query(
      database,
      `DELETE FROM activity_allocations
       WHERE credential_id IN (${seriesList}) AND ${gone}`,
      [...series, ...goneBindings],
    ),
    query(
      database,
      `DELETE FROM activity_requirement_matches
       WHERE user_id = ?
         AND allocation_id NOT IN (SELECT id FROM activity_allocations)
         AND ${gone}`,
      [identity.userId, ...goneBindings],
    ),
    query(
      database,
      `DELETE FROM dental_checkpoint_states
       WHERE user_id = ? AND credential_id IN (${seriesList}) AND ${gone}`,
      [identity.userId, ...series, ...goneBindings],
    ),
    query(
      database,
      `DELETE FROM checklist_tasks
       WHERE user_id = ? AND credential_id IN (${seriesList}) AND ${gone}`,
      [identity.userId, ...series, ...goneBindings],
    ),
    query(
      database,
      `DELETE FROM credential_requirements
       WHERE credential_id IN (${seriesList}) AND ${gone}`,
      [...series, ...goneBindings],
    ),
    query(
      database,
      `DELETE FROM reminder_states
       WHERE user_id = ? AND credential_id IN (${seriesList}) AND ${gone}`,
      [identity.userId, ...series, ...goneBindings],
    ),
  );
  const results = await database.batch(statements);
  if (Number(results[targetIndex]?.meta?.changes ?? Number.NaN) !== 1) {
    return diagnoseCredentialMutationFailure(
      database,
      identity,
      credentialId,
      expectedRevision,
      "any",
    );
  }

  if (orphanIds.length > 0) {
    try {
      await bucket.delete(orphans.map((orphan) => orphan.objectKey));
      await query(
        database,
        `DELETE FROM evidence_files
         WHERE user_id = ? AND status = 'deleting' AND id IN (${sqlPlaceholders(orphanIds)})`,
        [identity.userId, ...orphanIds],
      ).run();
    } catch (error) {
      // The rows stay in 'deleting'; DELETE /api/evidence/:id retries them.
      console.error("deleteCredential: evidence removal deferred", error);
    }
  }
  return credentialId;
}
```

- [ ] **Step 6: Dispatch the four actions**

`grep -n 'case "createCredential":' app/api/workspace/route.ts` → one hit (12377 on `main@8ac172a`). The three existing lines are:

```ts
      case "createCredential":
        id = await createCredential(database, identity, body.payload);
        break;
```

Insert directly after that `break;` (before `case "addActivity":`):

```ts
      case "updateCredential":
        id = await updateCredential(database, identity, body.payload);
        break;
      case "archiveCredential":
        id = await archiveCredential(database, identity, body.payload);
        break;
      case "restoreCredential":
        id = await restoreCredential(database, identity, body.payload);
        break;
      case "deleteCredential":
        id = await deleteCredential(
          database,
          getEvidenceBucket(),
          identity,
          body.payload,
        );
        break;
```

- [ ] **Step 7: Run the tests to see them pass**

Run:

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
npm run build && node --experimental-sqlite --test tests/workspace-credential-actions.test.mjs tests/isolation.test.mjs tests/app-source-guards.test.mjs tests/rendered-html.test.mjs
```

Expected: PASS — the nine Task 9 subtests, every isolation probe (the four new rows answer 404 `credential_not_found` and A's fingerprint and bucket key are unchanged), the dispatch-label guard (`WORKSPACE_ACTIONS.length === 27` equals the 27 `case` labels), and `rendered-html` unchanged: its `createCredential` template-date cases now exercise `assertTemplateCycleDates` over HTTP, and the only source pin that names a moved symbol — `assert.match(routeSource, /assertRehabilitationCertificationDates[\s\S]*?abve_fixed_cycle_required[\s\S]*?crcc_standard_cycle_required[\s\S]*?crcc_cycle_attestation_required/)` at `tests/rendered-html.test.mjs:3276-3279` — still matches because it anchors on the function's *definition* (`:1459-1503`, untouched; the three codes sit inside it at `:1474`, `:1487`, `:1498`), not on the call site that moved.

- [ ] **Step 8: Full gates**

Stop any `npm run dev` server on :3000 first, then:

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
npm run typecheck && npm run lint && npm test
```

Expected: `tsc --noEmit` clean (the `asserts credential is CredentialMutationRow` narrowing compiles because `assertCredentialMutationState` is a function declaration), `eslint .` clean (no unused symbols: `CredentialRequirementRow`, `CREDENTIAL_FROZEN_KEYS`, `CREDENTIAL_TEMPLATE_LOCKED_KEYS`, `sqlPlaceholders`, `credentialCategoryDraftsFromRows` and `assertCategoryTotalWithinCredential` are all referenced), and `npm test` green. Then start the dev server and run `npm run test:e2e` (all four projects) — this task changes `app/api/**` only, so every existing spec must still pass unchanged.

- [ ] **Step 9: Commit**

```bash
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
git branch --show-current   # must print feat/wave2-foundation
git add app/api/workspace/route.ts tests/workspace-credential-actions.test.mjs tests/isolation.test.mjs tests/helpers/workspaceActions.mjs
git commit -m "feat(workspace): updateCredential, archiveCredential, restoreCredential, deleteCredential — revision-guarded, series-scoped, isolation-probed (app-ux-03)

updateCredential re-runs the template date rules (assertTemplateCycleDates,
extracted from createCredential), validates allocated learning records
against the new cycle, rewrites managed task due dates and cycle_months,
and treats custom categories as a replace-set guarded by logged credits.
archive/restore/delete act on the whole cycle series; delete is
name-confirmed, unlinks activities without deleting them, and removes
solely-linked proof from R2 unless deleteOrphanedEvidence: false. Every
batch is a no-op on a stale revision (credential row written last / target
delete carries the revision). Isolation suite refuses all four with a
foreign id; WORKSPACE_ACTIONS is 27.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

**Self-review notes (recorded, not fixed here):** (1) a renamed template-linked credential's next cycle takes the template name again because `markRenewalAccepted` builds the successor from the rule set — Wave 4 decides whether display names carry forward; (2) a deadline change rewrites managed task due dates by `kind` + `title`, so a successor cycle whose review task was created with a carry-over `reviewTitle` keeps its old review date (the progress and submission rows still move); (3) `xp_events` / `badge_events` rows keyed to a deleted credential are left in place — they carry no foreign key and XP is cosmetic; (4) evidence deletion is the default (spec §4; `deleteOrphanedEvidence: false` is the opt-out) and the post-batch R2 delete is best-effort: on failure the rows stay `deleting` and `DELETE /api/evidence/:id` (which already handles that state) retries; (5) `restoreCredential` is a fourth action beyond the spec's three because "reversible" needs a server path back and `restoreActivity` is the house precedent.

---

### Task 10: Credential edit / archive / restore / delete in the client, with the e2e proof

**Rationale:** spec §4 bullet 4 (app-ux-03): a credential can never be edited or removed, so a wrong template or date is permanent and every mistake lives on Home forever. Task 9 shipped the four server actions; this task gives them a surface — an **Edit credential** control and a **Manage credential** section on the detail screen, an **Archived credentials** disclosure on History (archived credentials leave Home and Credentials, keep every record, and restore from there), and a delete confirmation whose button only enables once the exact credential name is typed. Every write is revision-guarded (`expectedRevision`) exactly like the activity editors.

Line numbers in this task are `main@8ac172a`. Task 7 removed 32 lines from `app/ITrackApp.tsx` before this task runs — the 24-line `hapticTap` block at `:1638-1661`, which sits above `:1687`, and the four calls with their orphaned comments at `:1815`, `:3325-3327`, `:3673-3675`, `:4129` — so every number from `:1687` on is 24–32 lines high at execution time (`:1687` is `:1663`, `:9062` is `:9030`). Locate every edit below by its quoted text with `grep -n`, never by number; each quoted block is unique in the file.

**Files:**
- Modify: `app/ITrackApp.tsx` — `type Credential` (137-178) and `type Workspace` (308-339); `type CredentialEditInput` after `type ToastState` (353-356); `credentialActionKey` after `activityActionKey` (1256-1258); state after line 1687; `handleSessionEnded` (1937-1947); `runAction` conflict list (2692-2700) and refresh branch (2703-2708); handlers before `savePersonalTask` (3990); detail-screen wiring at `credential={stagedDetail}` (4367); modal render sites before `{taskEditor ? (` (4921); `ICON_SHAPES` (6600); `CredentialDetailScreen` head (8010-8050), utility actions (8184-8215) and the section after `.source-detail` (8321-8355); `RecordsView` head (8439-8457) and tail (8781-8787); new `CredentialEditorModal` / `ConfirmDeleteCredentialModal` before `function PersonalTaskEditorModal(` (9062)
- Modify: `app/globals.css` — one rule after `.credential-utility-actions .reminder-setting-link` (2855-2857)
- Create: `tests/e2e/credential-edit-archive-delete.spec.ts`
- Test: `tests/app-source-guards.test.mjs` (the `handleSessionEnded closes every modal…` guard), `npm run test:e2e`, `npm test`

**Interfaces:**
- Consumes: Task 9 actions `updateCredential` / `archiveCredential` / `restoreCredential` / `deleteCredential` (each returns `{ ok, action, id }`) and their error codes `credential_version_conflict`, `credential_state_changed`, `credential_archived` (409, refresh-and-reopen), `template_field_locked` (400 — source-linked credentials accept only `credentialName`, `cycleStart`, `deadline` and the attestation flags, so the client never sends `issuer`/`jurisdiction`/`profession`/`totalRequired`/`unitLabel` for them), `credential_name_mismatch` (400); Task 8 `getWorkspace` → `credentials[]` (each with `revision: number`, `archivedAt: null`) and `archivedCredentials[]` (`archivedAt: string`), archive/restore bump `revision` by 1; Task 3 fixtures `test`, `expect`, `freshIdentity`, `app.goto`, `app.dialog(name)`, `app.tab(name)`, `app.workspace()`, `app.seedCredential()`, `app.expectNoErrors()`.
- Produces: `type Credential` += `revision: number; archivedAt?: string | null;`; `type Workspace` += `archivedCredentials: Credential[];`; `function credentialActionKey(id: string) { return \`credential:${id}\`; }`; `type CredentialEditInput = { credentialName: string; issuer: string; cycleStart: string; deadline: string; jurisdiction?: string; profession?: string; totalRequired?: number; unitLabel?: string; officialDatesAttested?: boolean; templateEligibilityAttested?: boolean }`; `CredentialDetailScreen` props += `onEdit: () => void; onArchive: () => void; onDelete: () => void;`; `RecordsView` props += `archivedCredentials: Credential[]; onRestoreCredential: (credential: Credential) => void; onDeleteCredential: (credential: Credential) => void;`; components `CredentialEditorModal({ credential, error, pending, onClose, onSave }: { credential: Credential; error: string; pending: boolean; onClose: () => void; onSave: (input: CredentialEditInput) => void })` and `ConfirmDeleteCredentialModal({ credential, error, pending, onClose, onConfirm }: { credential: Credential; error: string; pending: boolean; onClose: () => void; onConfirm: (confirmName: string, deleteOrphanedEvidence: boolean) => void })`; `ICON_SHAPES.edit`. Task 12 builds on this `Credential` type and detail screen.

- [ ] **Step 1: Write the failing e2e spec**

Create `tests/e2e/credential-edit-archive-delete.spec.ts`:

```ts
import { expect, freshIdentity, test } from "./fixtures";

// app-ux-03 / spec §4 "Credential edit / delete / archive": a credential can
// be renamed, archived (gone from Home and Credentials, listed under History →
// Archived credentials, restorable from there) and deleted, where delete only
// enables once the exact credential name is typed. Every write lands on a
// fresh identity; the demo workspace is never touched.
test.use({ identity: freshIdentity() });

test("a credential is renamed, archived, restored from History and deleted by typing its name", async ({ app, page }) => {
  const { id } = await app.seedCredential();
  await app.goto(`/credentials/${id}`);

  // Edit → rename. The heading is the credential name, so it proves the
  // refetched workspace carries the new name.
  await page.getByRole("button", { name: "Edit credential" }).click();
  const editor = app.dialog("Edit credential");
  await expect(editor).toBeVisible();
  await editor.locator('input[name="credentialName"]').fill("Renamed credential");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator("h1.push-title")).toHaveText("Renamed credential");

  // Archive → the pushed detail bounces to /credentials, which is empty for
  // this identity, and Home no longer names the credential either.
  await page.getByRole("button", { name: "Archive credential" }).click();
  await expect(page).toHaveURL(/\/credentials$/);
  await expect(page.locator("h1.push-title")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Your credentials" })).toHaveCount(0);
  await expect(page.getByText("Add your first credential")).toBeVisible();
  await app.tab("Home").click();
  await expect(page.getByText("Renamed credential")).toHaveCount(0);

  // History → Archived credentials → Restore, then it is listed again.
  await app.goto("/history");
  await page.locator("#archived-credentials-summary").click();
  await page.getByRole("button", { name: "Restore Renamed credential" }).click();
  await expect(page.locator("#archived-credentials-summary")).toHaveCount(0);
  await app.goto("/credentials");
  const list = page.getByRole("region", { name: "Your credentials" });
  await expect(list).toContainText("Renamed credential");

  // Delete: the confirm button is inert until the exact name is typed.
  await list.getByRole("button", { name: "Renamed credential" }).click();
  await expect(page).toHaveURL(new RegExp(`/credentials/${id}$`));
  await page.getByRole("button", { name: "Delete credential…" }).click();
  const confirm = app.dialog("Delete Renamed credential?");
  await expect(confirm).toBeVisible();
  const deleteButton = confirm.getByRole("button", { name: "Delete permanently" });
  await expect(deleteButton).toBeDisabled();
  await confirm.locator('input[name="confirmName"]').fill("Renamed credential");
  await expect(deleteButton).toBeEnabled();
  await deleteButton.click();
  await expect(page).toHaveURL(/\/credentials$/);
  await expect(page.getByText("Add your first credential")).toBeVisible();

  const workspace = await app.workspace();
  expect(workspace.credentials).toHaveLength(0);
  expect(workspace.archivedCredentials ?? []).toHaveLength(0);
  app.expectNoErrors();
});
```

- [ ] **Step 2: Run it to see it fail**

With the dev server up (`npm run dev` in another shell, Node 22 on PATH):

Run: `npm run test:e2e -- tests/e2e/credential-edit-archive-delete.spec.ts`
Expected: FAIL on all four projects — `Test timeout of 60000ms exceeded` while `waiting for getByRole('button', { name: 'Edit credential' })` (the detail screen has no such control yet).

- [ ] **Step 3: Extend the client types and add the action key**

In `app/ITrackApp.tsx` replace the end of `type Credential` (lines 176-178):

```ts
  tasks: RenewalTask[];
  archivedTasks: RenewalTask[];
};
```

with

```ts
  tasks: RenewalTask[];
  archivedTasks: RenewalTask[];
  // Bumped by every credential write on the server; sent back as
  // expectedRevision so a stale editor cannot overwrite a newer save.
  revision: number;
  archivedAt?: string | null;
};
```

Replace in `type Workspace` (lines 325-327 — the RecordsView props at 8452-8454 list the same three fields in a different order, so this three-line block is unique):

```ts
  credentials: Credential[];
  activities: Activity[];
  archivedActivities: Activity[];
```

with

```ts
  credentials: Credential[];
  archivedCredentials: Credential[];
  activities: Activity[];
  archivedActivities: Activity[];
```

Replace `type ToastState` (lines 353-356):

```ts
type ToastState = {
  message: string;
  undo?: () => void;
};
```

with

```ts
type ToastState = {
  message: string;
  undo?: () => void;
};

// What the credential editor hands back. `issuer` and the custom-only keys
// are only forwarded for custom credentials; a source-linked credential takes
// them from its template (the server answers 400 template_field_locked).
type CredentialEditInput = {
  credentialName: string;
  issuer: string;
  cycleStart: string;
  deadline: string;
  jurisdiction?: string;
  profession?: string;
  totalRequired?: number;
  unitLabel?: string;
  officialDatesAttested?: boolean;
  templateEligibilityAttested?: boolean;
};
```

Replace `activityActionKey` (lines 1256-1258):

```ts
function activityActionKey(activityId: string) {
  return `activity:${activityId}`;
}
```

with

```ts
function activityActionKey(activityId: string) {
  return `activity:${activityId}`;
}

function credentialActionKey(id: string) {
  return `credential:${id}`;
}
```

- [ ] **Step 4: Add the editor state and teach `runAction` the credential conflict codes**

Replace line 1687:

```ts
  const [editingActivity, setEditingActivity] = useState<Activity | null>(null);
```

with

```ts
  const [editingActivity, setEditingActivity] = useState<Activity | null>(null);
  const [credentialEditor, setCredentialEditor] = useState<Credential | null>(
    null,
  );
  const [credentialDeletion, setCredentialDeletion] =
    useState<Credential | null>(null);
```

In `runAction`, replace the tail of the conflict list (lines 2698-2700):

```ts
            "dental_checkpoint_state_changed",
            "cycle_closed",
          ].includes(result.code ?? "")
```

with

```ts
            "dental_checkpoint_state_changed",
            "cycle_closed",
            "credential_version_conflict",
            "credential_state_changed",
            "credential_archived",
          ].includes(result.code ?? "")
```

and the refresh branch (lines 2703-2708, the only `if (refreshed) {` in the file):

```ts
          if (refreshed) {
            setEditingActivity(null);
            setTaskEditor(null);
            setAllocationActivity(null);
            setClassificationRepair(null);
          }
```

with

```ts
          if (refreshed) {
            setEditingActivity(null);
            setTaskEditor(null);
            setAllocationActivity(null);
            setClassificationRepair(null);
            setCredentialEditor(null);
            setCredentialDeletion(null);
          }
```

(`handleSessionEnded` is deliberately left alone until Step 10 so the modal guard can be seen failing first.)

- [ ] **Step 5: Add the four handlers**

Insert immediately before line 3990 `  async function savePersonalTask(input: {` (after `restoreActivityRecord` ends):

```ts
  async function saveCredentialEdit(input: CredentialEditInput) {
    if (!credentialEditor) return;
    // A source-linked credential accepts only its display name, its cycle
    // dates and the attestations; the server refuses the template-owned keys
    // (400 template_field_locked) rather than ignoring them, so they are only
    // ever sent for a custom credential.
    const custom = credentialEditor.ruleReviewStatus === "custom";
    const result = await runAction(
      "updateCredential",
      {
        credentialId: credentialEditor.id,
        expectedRevision: credentialEditor.revision,
        credentialName: input.credentialName,
        cycleStart: input.cycleStart,
        deadline: input.deadline,
        ...(custom
          ? {
              issuer: input.issuer,
              jurisdiction: input.jurisdiction,
              profession: input.profession,
              totalRequired: input.totalRequired,
              unitLabel: input.unitLabel,
            }
          : {}),
        ...(input.officialDatesAttested ? { officialDatesAttested: true } : {}),
        ...(input.templateEligibilityAttested
          ? { templateEligibilityAttested: true }
          : {}),
      },
      "Credential updated.",
    );
    if (result) setCredentialEditor(null);
  }

  async function archiveCredentialRecord(credential: Credential) {
    const result = await runAction(
      "archiveCredential",
      {
        credentialId: credential.id,
        expectedRevision: credential.revision,
      },
      "Credential archived.",
      credentialActionKey(credential.id),
    );
    if (!result) return;
    // No nav.pop() here: the refetched workspace no longer lists the
    // credential, so the "deleted (or never existed)" effect above already
    // bounces a pushed detail to /credentials. Popping as well would queue a
    // second history move behind the one that effect asks for.
    setToast({
      message:
        "Credential archived. Find it under History → Archived credentials.",
      undo: () => {
        void runAction(
          "restoreCredential",
          {
            credentialId: credential.id,
            expectedRevision: credential.revision + 1,
          },
          "Credential restored.",
          credentialActionKey(credential.id),
        );
      },
    });
  }

  async function restoreCredentialRecord(credential: Credential) {
    await runAction(
      "restoreCredential",
      {
        credentialId: credential.id,
        expectedRevision: credential.revision,
      },
      "Credential restored.",
      credentialActionKey(credential.id),
    );
  }

  async function deleteCredentialRecord(
    credential: Credential,
    confirmName: string,
    deleteOrphanedEvidence: boolean,
  ) {
    const result = await runAction(
      "deleteCredential",
      {
        credentialId: credential.id,
        expectedRevision: credential.revision,
        confirmName,
        deleteOrphanedEvidence,
      },
      "Credential deleted.",
      credentialActionKey(credential.id),
    );
    if (!result) return;
    setCredentialDeletion(null);
    setSelectedCredentialId("");
    // Deleting from the History tab's archived list has no pushed detail for
    // the effect above to bounce, so land on the list explicitly; when a
    // detail was pushed the two calls collapse into one move (setTab re-aims
    // an unwind that is already in flight).
    navigateToTab("credentials");
  }

```

- [ ] **Step 6: Add the `edit` icon, the detail-screen controls, and their wiring**

In `ICON_SHAPES` replace line 6600:

```tsx
const ICON_SHAPES = {
```

with

```tsx
const ICON_SHAPES = {
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
```

Replace the head of `CredentialDetailScreen` (lines 8010-8024):

```tsx
function CredentialDetailScreen({
  credential,
  activities,
  isOnline,
  backLabel,
  onBack,
  onSubmit,
  onAccept,
  onReminders,
  onAddToCalendar,
  onRequirementApplicability,
  onDentalCheckpoint,
  actionsDisabled,
  pendingActionKeys,
}: {
```

with

```tsx
function CredentialDetailScreen({
  credential,
  activities,
  isOnline,
  backLabel,
  onBack,
  onSubmit,
  onAccept,
  onReminders,
  onAddToCalendar,
  onRequirementApplicability,
  onDentalCheckpoint,
  onEdit,
  onArchive,
  onDelete,
  actionsDisabled,
  pendingActionKeys,
}: {
```

and its prop types (lines 8042-8051; `const credentialActivities` occurs once in the file):

```tsx
  onDentalCheckpoint: (
    credentialId: string,
    requirement: Requirement,
    completed: boolean,
    evidenceNote: string,
  ) => void;
  actionsDisabled: boolean;
  pendingActionKeys: readonly string[];
}) {
  const credentialActivities = activities.filter((activity) =>
```

with

```tsx
  onDentalCheckpoint: (
    credentialId: string,
    requirement: Requirement,
    completed: boolean,
    evidenceNote: string,
  ) => void;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
  actionsDisabled: boolean;
  pendingActionKeys: readonly string[];
}) {
  const credentialActivities = activities.filter((activity) =>
```

Add the third utility button — replace lines 8211-8216 (`date to calendar` and `<div className="detail-stats">` each occur once):

```tsx
                date to calendar
              </span>
            </button>
          </div>
        ) : null}
        <div className="detail-stats">
```

with

```tsx
                date to calendar
              </span>
            </button>
            <button
              className="reminder-setting-link"
              type="button"
              onClick={onEdit}
            >
              <Icon name="edit" size={15} />
              <span>Edit credential</span>
            </button>
          </div>
        ) : null}
        <div className="detail-stats">
```

Add the manage section — replace lines 8352-8357 (`Entered manually · no official source attached` occurs once):

```tsx
            <span className="custom-rule-label">
              Entered manually · no official source attached
            </span>
          )}
        </div>
        {credential.status === "active" ? (
```

with

```tsx
            <span className="custom-rule-label">
              Entered manually · no official source attached
            </span>
          )}
        </div>
        <div className="detail-section">
          <span className="section-kicker">Manage credential</span>
          <h3>Archive or delete</h3>
          <p>
            Archived credentials leave Home and Credentials but keep every
            record; restore them any time. Deleting removes its cycles,
            checklist and check-ins permanently — learning records stay in
            your activity log.
          </p>
          <div className="manage-credential-actions">
            <button
              className="button button-outline"
              type="button"
              disabled={actionsDisabled}
              onClick={onArchive}
            >
              Archive credential
            </button>
            <button
              className="button button-danger"
              type="button"
              disabled={actionsDisabled}
              onClick={onDelete}
            >
              Delete credential…
            </button>
          </div>
        </div>
        {credential.status === "active" ? (
```

Wire the screen — replace lines 4366-4368 (`credential={stagedDetail}` occurs once; `stagedDetail` is a `const` already narrowed to `Credential` by the surrounding `{stagedDetail ? (`, and that narrowing carries into the arrow functions):

```tsx
                <CredentialDetailScreen
                  credential={stagedDetail}
                  activities={workspace?.activities ?? []}
```

with

```tsx
                <CredentialDetailScreen
                  credential={stagedDetail}
                  onEdit={() => {
                    setError("");
                    setCredentialEditor(stagedDetail);
                  }}
                  onArchive={() => void archiveCredentialRecord(stagedDetail)}
                  onDelete={() => {
                    setError("");
                    setCredentialDeletion(stagedDetail);
                  }}
                  activities={workspace?.activities ?? []}
```

- [ ] **Step 7: Write the two modals**

Insert immediately before line 9062 `function PersonalTaskEditorModal(`. Every label below is copied from the setup sheet (custom-credential fields at 4981-5020, cycle dates at 5286-5313, attestations at 5248-5279 and 5316-5415), keyed by the credential-level helpers that already exist (`isNremtCredential` 613, `isCrcCredential` 617, `isAbveCredential` 621, `isExpandedCertificationCredential` 655, `isManagedPharmacistCredential` 915, `isManagedNursingCredential` 923, `isManagedDentalCredential` 931, `isFloridaMentalHealthPhaseCredential` 971). The error line reuses the `.modal-error` block the activity editor renders at 8853.

```tsx
function CredentialEditorModal({
  credential,
  error,
  pending,
  onClose,
  onSave,
}: {
  credential: Credential;
  error: string;
  pending: boolean;
  onClose: () => void;
  onSave: (input: CredentialEditInput) => void;
}) {
  const custom = credential.ruleReviewStatus === "custom";
  const [cycleStart, setCycleStart] = useState(credential.cycleStart);
  const [deadline, setDeadline] = useState(credential.deadline);
  const datesChanged =
    cycleStart !== credential.cycleStart || deadline !== credential.deadline;
  // The setup sheet's attestations, asked the same way and only once a
  // source-linked credential's dates actually change — the server re-runs the
  // template date rules only then.
  const asksOfficialDates =
    !custom &&
    datesChanged &&
    (isNremtCredential(credential) ||
      isFloridaMentalHealthPhaseCredential(credential) ||
      isCrcCredential(credential) ||
      isAbveCredential(credential) ||
      isExpandedCertificationCredential(credential));
  const asksTemplateEligibility =
    !custom &&
    datesChanged &&
    (isManagedPharmacistCredential(credential) ||
      isManagedNursingCredential(credential) ||
      isManagedDentalCredential(credential) ||
      isExpandedCertificationCredential(credential));

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? "").trim();
    onSave({
      credentialName: text("credentialName"),
      // A disabled input is absent from FormData; carry the stored issuer so
      // the shape stays whole (saveCredentialEdit drops it for templates).
      issuer: custom ? text("issuer") : (credential.issuer ?? ""),
      cycleStart: text("cycleStart"),
      deadline: text("deadline"),
      ...(custom
        ? {
            jurisdiction: text("jurisdiction"),
            profession: text("profession"),
            totalRequired: Number(form.get("totalRequired")),
            unitLabel: text("unitLabel"),
          }
        : {}),
      officialDatesAttested:
        form.get("officialDatesAttested") === "on" ? true : undefined,
      templateEligibilityAttested:
        form.get("templateEligibilityAttested") === "on" ? true : undefined,
    });
  };

  return (
    <Modal eyebrow="Credential" title="Edit credential" onClose={onClose}>
      <form className="form-stack" onSubmit={handleSubmit}>
        {error ? (
          <div className="modal-error" role="alert">
            <span>{error}</span>
          </div>
        ) : null}
        <label className="field">
          <span>License or professional certification</span>
          <input
            autoFocus
            name="credentialName"
            defaultValue={credential.credentialName}
            maxLength={180}
            required
          />
        </label>
        <label className="field">
          <span>Issuing organization</span>
          <input
            name="issuer"
            defaultValue={credential.issuer ?? ""}
            maxLength={180}
            disabled={!custom}
          />
          {!custom ? (
            <small>
              Source-linked credentials take their issuer from the template.
            </small>
          ) : null}
        </label>
        {custom ? (
          <>
            <div className="form-grid">
              <label className="field">
                <span>Profession</span>
                <input
                  name="profession"
                  defaultValue={credential.profession}
                  maxLength={120}
                  required
                />
              </label>
              <label className="field">
                <span>State or jurisdiction</span>
                <input
                  name="jurisdiction"
                  defaultValue={credential.jurisdiction}
                  maxLength={120}
                  required
                />
              </label>
            </div>
            <div className="form-grid">
              <label className="field">
                <span>Total required</span>
                <input
                  name="totalRequired"
                  type="number"
                  min="0.25"
                  step="0.25"
                  defaultValue={credential.totalRequired}
                  required
                />
              </label>
              <label className="field">
                <span>Unit label</span>
                <input
                  name="unitLabel"
                  defaultValue={credential.unitLabel}
                  maxLength={40}
                  required
                />
              </label>
            </div>
          </>
        ) : null}
        {asksTemplateEligibility ? (
          <label className="switch-row">
            <span>
              <strong>
                I confirmed this is a standard full-cycle{" "}
                {isExpandedCertificationCredential(credential)
                  ? "credential or license maintenance path"
                  : isManagedNursingCredential(credential) ||
                      isManagedDentalCredential(credential)
                    ? "renewal or registration"
                    : "renewal"}
              </strong>
              <small>
                {isExpandedCertificationCredential(credential)
                  ? "The official issuer or regulator record matches this exact credential, status, maintenance path, and the dates below. No initial, shortened, waiver, inactive, retired, reinstatement, synchronized or multi-credential, exam-alternative, or other adjusted variant applies."
                  : credential.ruleSetId === "tx-rn-2026-v1" ||
                      credential.ruleSetId === "tx-lvn-2026-v1"
                    ? "The regulator record matches the dates below, I am using the 20-hour CNE path rather than the certification alternative, and no initial, shortened, inactive, exempt, or other adjusted-status variant applies."
                    : isManagedDentalCredential(credential)
                      ? "The regulator record matches the dates below, and no initial, shortened, inactive, retired, prorated, exempt, or other adjusted-status variant applies."
                      : "The official issuer or regulator record matches the dates below, and no initial, shortened, inactive, prorated, exempt, or other adjusted-status variant applies."}
              </small>
            </span>
            <input
              name="templateEligibilityAttested"
              type="checkbox"
              required
            />
          </label>
        ) : null}
        <div className="form-grid">
          <label className="field">
            <span>Cycle started</span>
            <input
              name="cycleStart"
              type="date"
              value={cycleStart}
              onChange={(event) => setCycleStart(event.currentTarget.value)}
              required
            />
          </label>
          <label className="field">
            <span>Renewal deadline</span>
            <input
              name="deadline"
              type="date"
              value={deadline}
              onChange={(event) => setDeadline(event.currentTarget.value)}
              required
            />
          </label>
        </div>
        {asksOfficialDates ? (
          <label className="switch-row">
            <span>
              <strong>
                {isNremtCredential(credential)
                  ? "I checked my National Registry dashboard"
                  : isFloridaMentalHealthPhaseCredential(credential)
                    ? "I checked my CE Broker period and phase"
                    : isAbveCredential(credential)
                      ? "I checked my ABVE member record"
                      : isCrcCredential(credential)
                        ? "I checked CRCCCONNECT"
                        : "I checked the official credential record"}
              </strong>
              <small>
                {isNremtCredential(credential)
                  ? "It assigns this 2025 NCCP level template, and the cycle start and fixed expiration entered above match the dashboard exactly."
                  : isFloridaMentalHealthPhaseCredential(credential)
                    ? "CE Broker shows this Ethics and Boundaries or Telehealth phase, beginning April 1 of an odd year and ending March 31 two years later."
                    : isAbveCredential(credential)
                      ? "It shows the selected Fellow or Diplomate credential, the year first held in this cycle, and the fixed January 1, 2025 through December 31, 2027 recertification cycle."
                      : isCrcCredential(credential)
                        ? "It shows the CRC certification-period start and valid-through date entered above."
                        : "The issuer, regulator, or official account shows this exact credential or license path, current status, cycle start, and deadline."}
              </small>
            </span>
            <input name="officialDatesAttested" type="checkbox" required />
          </label>
        ) : null}
        <div className="form-actions">
          <button
            type="button"
            className="button button-outline"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button button-primary"
            disabled={pending}
          >
            {pending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConfirmDeleteCredentialModal({
  credential,
  error,
  pending,
  onClose,
  onConfirm,
}: {
  credential: Credential;
  error: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: (confirmName: string, deleteOrphanedEvidence: boolean) => void;
}) {
  const [value, setValue] = useState("");
  // Checked by default (spec §4: proof linked only to this credential is
  // deleted); unticking sends deleteOrphanedEvidence: false, the opt-out.
  const [orphans, setOrphans] = useState(true);
  const matches = value.trim() === credential.credentialName;

  return (
    <Modal
      eyebrow="Delete credential"
      title={`Delete ${credential.credentialName}?`}
      onClose={onClose}
    >
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!matches || pending) return;
          onConfirm(value.trim(), orphans);
        }}
      >
        {error ? (
          <div className="modal-error" role="alert">
            <span>{error}</span>
          </div>
        ) : null}
        <ul>
          <li>
            Removes this credential, every past cycle, its checklist and
            check-ins.
          </li>
          <li>Keeps your learning records in the activity log.</li>
        </ul>
        <label className="field">
          <span>Type the credential name to confirm</span>
          <input
            name="confirmName"
            autoComplete="off"
            autoFocus
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
        </label>
        <label className="switch-row">
          <span>
            <strong>
              Also delete proof files that were only used for this credential
            </strong>
          </span>
          <input
            type="checkbox"
            name="deleteOrphanedEvidence"
            checked={orphans}
            onChange={(event) => setOrphans(event.currentTarget.checked)}
          />
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="button button-outline"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button button-danger"
            aria-busy={pending}
            disabled={!matches || pending}
          >
            Delete permanently
          </button>
        </div>
      </form>
    </Modal>
  );
}

```

(The `onChange` handlers read `event.currentTarget` directly and pass a value to the setter; none of them is a `set…((current) => …)` updater, which is what the updater guard in `tests/app-source-guards.test.mjs` forbids.)

- [ ] **Step 8: Render the modals beside the activity editor**

Replace lines 4921-4922 (`{taskEditor ? (` followed by `<PersonalTaskEditorModal` occurs once):

```tsx
      {taskEditor ? (
        <PersonalTaskEditorModal
```

with

```tsx
      {credentialEditor ? (
        <CredentialEditorModal
          key={`${credentialEditor.id}:${credentialEditor.revision}`}
          credential={credentialEditor}
          error={error}
          pending={
            pendingActionKeys.includes(FORM_ACTION_KEY) ||
            pendingActionKeys.includes(credentialActionKey(credentialEditor.id))
          }
          onClose={() => {
            setCredentialEditor(null);
            setError("");
          }}
          onSave={(input) => void saveCredentialEdit(input)}
        />
      ) : null}

      {credentialDeletion ? (
        <ConfirmDeleteCredentialModal
          key={credentialDeletion.id}
          credential={credentialDeletion}
          error={error}
          pending={
            pendingActionKeys.includes(FORM_ACTION_KEY) ||
            pendingActionKeys.includes(
              credentialActionKey(credentialDeletion.id),
            )
          }
          onClose={() => {
            setCredentialDeletion(null);
            setError("");
          }}
          onConfirm={(confirmName, deleteOrphanedEvidence) =>
            void deleteCredentialRecord(
              credentialDeletion,
              confirmName,
              deleteOrphanedEvidence,
            )
          }
        />
      ) : null}

      {taskEditor ? (
        <PersonalTaskEditorModal
```

- [ ] **Step 9: Run the modal guard to see it fail**

Run: `node --experimental-sqlite --test tests/app-source-guards.test.mjs`
Expected: FAIL — `handleSessionEnded closes every modal that is not gated on workspace (app-ux-M-01)` with `ITrackApp.tsx: the modal gated on \`credentialEditor\` would stay mounted over the Reload state; add setCredentialEditor(null|false) to handleSessionEnded` (the render sites from Step 8 are gated on state that `handleSessionEnded` does not reset yet).

- [ ] **Step 10: Close both modals in `handleSessionEnded`**

Replace lines 1945-1946 (`setError(SESSION_ENDED_MESSAGE)` occurs once):

```ts
    setEvidenceActivity(null);
    setError(SESSION_ENDED_MESSAGE);
```

with

```ts
    setEvidenceActivity(null);
    setCredentialEditor(null);
    setCredentialDeletion(null);
    setError(SESSION_ENDED_MESSAGE);
```

Run: `node --experimental-sqlite --test tests/app-source-guards.test.mjs`
Expected: PASS (all guards; the modal guard now counts two more ungated sites, both closed).

- [ ] **Step 11: The Archived credentials disclosure on History, its wiring, and the one CSS rule**

Replace the head of `RecordsView` (lines 8439-8457):

```tsx
function RecordsView({
  activities,
  archivedActivities,
  credentials,
  onAdd,
  onEdit,
  onRestore,
  actionsDisabled,
  pendingActionKeys,
  onEvidence,
  onAllocate,
  onClassify,
}: {
  activities: Activity[];
  archivedActivities: Activity[];
  credentials: Credential[];
  onAdd: () => void;
  onEdit: (activity: Activity) => void;
  onRestore: (activity: Activity) => void;
```

with

```tsx
function RecordsView({
  activities,
  archivedActivities,
  credentials,
  archivedCredentials,
  onAdd,
  onEdit,
  onRestore,
  onRestoreCredential,
  onDeleteCredential,
  actionsDisabled,
  pendingActionKeys,
  onEvidence,
  onAllocate,
  onClassify,
}: {
  activities: Activity[];
  archivedActivities: Activity[];
  credentials: Credential[];
  archivedCredentials: Credential[];
  onAdd: () => void;
  onEdit: (activity: Activity) => void;
  onRestore: (activity: Activity) => void;
  onRestoreCredential: (credential: Credential) => void;
  onDeleteCredential: (credential: Credential) => void;
```

Replace the tail of `RecordsView` (lines 8781-8787 — unique because the next function's name is part of it):

```tsx
        </details>
      ) : null}
    </div>
  );
}

function ActivityEditorModal({
```

with

```tsx
        </details>
      ) : null}
      {archivedCredentials.length ? (
        <details className="archived-items archived-records">
          <summary id="archived-credentials-summary">
            <span>
              Archived credentials
              <small>
                {archivedCredentials.length}{" "}
                {archivedCredentials.length === 1 ? "credential" : "credentials"}
              </small>
            </span>
            <span className="disclosure-chevron">
              <Icon name="chevronDown" size={16} />
            </span>
          </summary>
          <div className="archived-item-list">
            {archivedCredentials.map((credential) => {
              const busy = pendingActionKeys.includes(
                credentialActionKey(credential.id),
              );
              return (
                <article className="archived-item" key={credential.id}>
                  <div>
                    <strong>{credential.credentialName}</strong>
                    <small>
                      {credential.jurisdiction} · Renew by{" "}
                      {formatDate(credential.deadline)}
                    </small>
                  </div>
                  <div className="archived-item-actions">
                    <button
                      type="button"
                      aria-label={`Restore ${credential.credentialName}`}
                      disabled={actionsDisabled || busy}
                      aria-busy={busy}
                      onClick={() => onRestoreCredential(credential)}
                    >
                      {busy ? (
                        <>
                          <ActionSpinner />
                          Restoring…
                        </>
                      ) : (
                        "Restore"
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${credential.credentialName}`}
                      disabled={actionsDisabled || busy}
                      onClick={() => onDeleteCredential(credential)}
                    >
                      Delete…
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ActivityEditorModal({
```

Wire it — replace lines 4299-4303:

```tsx
                <RecordsView
                  activities={workspace.activities}
                  archivedActivities={workspace.archivedActivities}
                  credentials={workspace.credentials}
                  onAdd={openActivityEntry}
```

with

```tsx
                <RecordsView
                  activities={workspace.activities}
                  archivedActivities={workspace.archivedActivities}
                  credentials={workspace.credentials}
                  archivedCredentials={workspace.archivedCredentials}
                  onAdd={openActivityEntry}
```

and line 4308 (`onRestore={(activity) => void restoreActivityRecord(activity)}` occurs once):

```tsx
                  onRestore={(activity) => void restoreActivityRecord(activity)}
```

with

```tsx
                  onRestore={(activity) => void restoreActivityRecord(activity)}
                  onRestoreCredential={(credential) =>
                    void restoreCredentialRecord(credential)
                  }
                  onDeleteCredential={(credential) => {
                    setError("");
                    setCredentialDeletion(credential);
                  }}
```

(Archived rows do not push a detail screen this wave: `detailCredential` resolves only from `workspace.credentials`.)

In `app/globals.css` replace lines 2855-2857:

```css
.credential-utility-actions .reminder-setting-link {
  margin: 0;
}
```

with

```css
.credential-utility-actions .reminder-setting-link {
  margin: 0;
}

.manage-credential-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 12px;
}
```

- [ ] **Step 12: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both silent / PASS. (`tsc --noEmit` also typechecks the new spec against `tests/e2e/fixtures.ts`; `Workspace.archivedCredentials` and `Credential.revision` are required fields, and nothing under `app/` builds either literal by hand, so no other site needs a change.)

- [ ] **Step 13: Node suite**

Stop the dev server on :3000 first (it shares `.wrangler/` with the build), then:

Run: `npm test`
Expected: PASS — the build, `build:lib-test`, and every `tests/*.test.mjs` file including `tests/app-source-guards.test.mjs` (modal guard green after Step 10) and Task 9's `tests/workspace-credential-actions.test.mjs`.

- [ ] **Step 14: Browser proof**

Start the dev server again (`npm run dev`), then:

Run: `npm run test:e2e`
Expected: PASS on all four projects for every spec, including `credential-edit-archive-delete.spec.ts` — the credential is renamed, archived (gone from Credentials and Home, listed under History → Archived credentials, restored from there) and deleted (button disabled until the exact name is typed; lands on `/credentials` with "Add your first credential"; `app.workspace()` reports zero credentials and zero archived credentials; no page errors).

- [ ] **Step 15: Commit**

```bash
git branch --show-current   # must print feat/wave2-foundation
git add app/ITrackApp.tsx app/globals.css tests/e2e/credential-edit-archive-delete.spec.ts
git commit -m "feat(app): edit, archive, restore and delete credentials from the detail screen and the archived list (app-ux-03)

Edit credential (name, cycle dates; issuer/jurisdiction/profession/units for
custom plans, template attestations when a source-linked cycle's dates change),
Archive/Delete under a Manage credential section, an Archived credentials
disclosure on History with Restore and Delete…, and a delete confirmation that
only enables once the exact name is typed. Every write carries expectedRevision;
credential conflict codes refresh the workspace and close both editors, which
handleSessionEnded also closes. Proven by
tests/e2e/credential-edit-archive-delete.spec.ts on a fresh identity.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 11: Local dates and the one-tap device-time-zone offer (critic-01)

**Rationale:** spec §4 bullet 5 and audit critic-01. The client's "today" is `const todayIso = () => new Date().toISOString().slice(0, 10)` (`app/ITrackApp.tsx:409`, the UTC date), so after roughly 8 pm in the Americas every default date input — the log sheet's completion date, the submission and acceptance dates, a new credential's cycle window, the one-week snooze — is tomorrow's date while the countdown next to it (`daysUntilDate`, local end-of-day) still says today. The user's zone lives only in `reminder_preferences.time_zone`, which every account is seeded with as the literal `'UTC'` (`db/runtime.ts:6035-6041`), and nothing ever captures the device zone: the Manage-reminders "Use this device's time zone" button only fills a text input. The push scheduler already fires at `pushHourLocal` in the *stored* zone (`app/lib/pushDelivery.ts:764-773` gates on `localReminderClock(now, storedZone).hour`), so 9:00 "local" is 9:00 UTC for everyone until the stored zone is real. This task moves every default date onto a zone-aware `todayLocal(zone)` in a new import-free `app/lib/dates.ts`, adds a one-tap "Use <zone>" banner that persists the device zone through the existing `updateReminderPreferences` action, and pins the scheduler's 9:00-stored-local behaviour.

**Decisions (resolved ambiguities, recorded here so they are not re-litigated):**
- When the stored zone is still the literal `'UTC'` (fresh accounts, and accounts that tapped "Not now"), defaults use the **device** zone via `effectiveDateZone`. The spec's literal wording ("every default date uses the reminder time zone") would keep the original bug for dismissers; critic-01's intent is device-local, so `'UTC'` is treated as "unset". An explicitly chosen zone always wins.
- The countdown (`daysUntil` → `daysUntilDate`, `app/lib/readiness.ts:44-47`) and the `dayPart()` greeting (`ITrackApp.tsx:11019-11024`) stay device-local; they are not date defaults.
- The Manage-reminders "Use this device's time zone" button (`ITrackApp.tsx:6021-6036`) stays fill-only; the banner is the one-tap path.
- The DDL default `'UTC'` (`db/runtime.ts:394`, `drizzle/0002_lonely_green_goblin.sql:21`) and the `ensureUser` seed are untouched: the literal is exactly what `deviceZoneSuggestion` keys on.
- `app/lib/reminders.ts` and `app/lib/pushDelivery.ts` are untouched: `tests/rendered-html.test.mjs` loads `reminders.ts` as raw TypeScript through `importTypeScriptModule` (only `./catalog/*` imports are inlined), so `reminders.ts` cannot import `./dates` this wave and keeps its own `localReminderClock`. `tests/dates.test.mjs` asserts the same Kathmandu / New York DST instants the rendered-html suite pins on `localReminderClock`, so drift between the two implementations is visible.
- New client storage keys use the `itrack:` prefix (`itrack:time-zone-offer:v1:<draftStorageNamespace>`); the `license-lantern:activity-draft:v1:` prefix is a protected identifier and stays draft-only.
- No workspace action is added, so `tests/helpers/workspaceActions.mjs` and `FOREIGN_ID_PROBES` do not change. `app/api/workspace/route.ts` and `app/api/export/route.ts` are edited, which Task 1's isolation suite (already committed) permits.

**Files:**
- Create: `app/lib/dates.ts`, `tests/dates.test.mjs`, `tests/e2e/local-dates.spec.ts`
- Modify: `package.json` (`build:lib-test` gains `app/lib/dates.ts`)
- Modify: `app/ITrackApp.tsx` — delete the helpers at `:409-421` and `:444-461` (import from `./lib/dates`), rewrite `defaultCatalogCycleStart`/`defaultCatalogDeadline` (`:462-475`), add `TIME_ZONE_ACTION_KEY` next to `FORM_ACTION_KEY` (`:1246`), the `dateZone`/`today` pair after `isOnline` (`:1727`), call sites `:1674, 1709, 1771, 3123, 3622, 3704, 3724, 5295, 5310, 5525, 5709`, the banner after the error-banner block (`:4211`), Profile copy (`:9487-9493`)
- Modify: `app/globals.css` — `.zone-banner` rules after `.error-banner button` (`:5337-5346`) and in the `@media (max-width: 540px)` block (`:6417-6419`)
- Modify: `app/api/workspace/route.ts:2206-2216` (`todayInTimeZone` delegates to `todayLocal`; the three call sites `:2392, 2413, 12207` are unchanged), `app/api/export/route.ts:112`
- Modify: `tests/rendered-html.test.mjs` (scheduler 08:30 / 09:05 EDT proof inserted after `assert.equal(restoreLeadResponse.status, 200);`, `:21549`), `tests/app-source-guards.test.mjs` (no-UTC-"today" guard)
- Test: `tests/dates.test.mjs`, `tests/app-source-guards.test.mjs`, `tests/rendered-html.test.mjs`, `npm run test:e2e`

**Interfaces:**
- Consumes: Task 7 (the `hapticTap();` line in `openActivityEntryFor` is already gone; nothing here touches that function). Task 3 fixtures: `test`, `expect`, `freshIdentity`, `app.goto`, `app.openLog`, `app.workspace`, `app.seedCredential`, `app.expectNoErrors` from `tests/e2e/fixtures.ts`, and the `test:e2e:desktop` script. Task 5's `build:lib-test` script (flat `.test-build/` output). Task 1 (route.ts edits allowed; `readClientSources()` is imported into `tests/app-source-guards.test.mjs` from `./helpers/clientSources.mjs`). Existing: `deviceTimeZone()` (`app/lib/webPush.ts:180-186`, already imported in `ITrackApp.tsx:84`), `runAction(action, payload, successMessage, actionKey)` (`ITrackApp.tsx:2657`), `pendingActionKeys` (`:1702`), `updateReminderPreferences` (`route.ts:12033-12115`, all five fields required).
- Produces `app/lib/dates.ts` (zero imports, no DOM/D1 types — compiles under `build:lib-test`; verified with `tsc --module nodenext --target es2022` on Node 22):
  ```ts
  export const UTC_FALLBACK_ZONE = "UTC";
  export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  export function isValidTimeZone(value: string): boolean;                              // Intl ctor try/catch
  export function localClock(timeZone: string, now: Date = new Date()): { date: string; hour: number }; // formatToParts en-US, hourCycle h23; invalid zone → UTC
  export function todayLocal(timeZone: string, now: Date = new Date()): string;        // localClock(...).date, always YYYY-MM-DD
  export function deviceZoneSuggestion(storedZone: string, deviceZone: string): string | null; // deviceZone iff storedZone === UTC_FALLBACK_ZONE && deviceZone !== UTC_FALLBACK_ZONE && isValidTimeZone(deviceZone)
  export function effectiveDateZone(storedZone: string, deviceZone: string): string;   // storedZone unless it is the UTC fallback → deviceZone (falls back to UTC if invalid)
  export function addDaysIso(value: string, days: number): string;                     // moved verbatim from ITrackApp.tsx:444-448
  export function addMonthsIso(value: string, months: number): string;                 // moved verbatim from ITrackApp.tsx:450-461
  export function addYearsIso(value: string, years: number): string;                   // addMonthsIso(value, years * 12): Feb 29 clamps to Feb 28
  ```
  Client (`app/ITrackApp.tsx`): `const TIME_ZONE_ACTION_KEY = "time-zone"`; `function zoneOfferStorageKey(draftStorageNamespace: string): string` (`itrack:time-zone-offer:v1:${namespace}`); inside `ITrackApp()` the memo pair `dateZone: string` / `today(): string`; module-level `defaultCatalogCycleStart(rule, today: string)` and `defaultCatalogDeadline(rule, today: string)`. User-facing strings (exact, Wave 4 rewrites copy): `Your device is in {zone}`, `Reminders and default dates currently use UTC.`, `Use {zone}`, `Not now`, `Reminders now use {zone}.`, `Times use {zone}.`. Server: `route.ts` `todayInTimeZone(timeZone)` keeps its name and delegates to `todayLocal`; Task 12 imports `todayLocal` from `../../lib/dates` in `getWorkspace`.

**Line numbers** in this task are at `main@8ac172a`. Task 7 deleted 31 lines from `ITrackApp.tsx` (the `hapticTap` block and its four calls) and Task 10 added the credential editor, so everything after `:1637` has moved; every edit step below names a `grep -n` anchor that is unique in the file at the time this task runs — locate by anchor, never by number.

- [ ] **Step 1: Write the failing unit test**

Create `tests/dates.test.mjs`:

```js
// The app's calendar dates are computed in an IANA zone, never in UTC
// (audit critic-01): a user in Los Angeles at 23:30 sees today's date, not
// tomorrow's. `app/lib/dates.ts` has no bundler entry of its own, so
// `npm run build:lib-test` compiles it with `tsc --outDir .test-build` first
// and this suite imports the emitted ESM.
//
// The Kathmandu and New York instants below are the same literals
// tests/rendered-html.test.mjs pins on app/lib/reminders.ts's own
// `localReminderClock` (the scheduler's clock, which cannot import this
// module because the test inliner only resolves ./catalog/* imports). If the
// two implementations ever drift, one of the two suites fails.

import assert from "node:assert/strict";
import test from "node:test";

import {
  ISO_DATE_PATTERN,
  UTC_FALLBACK_ZONE,
  addDaysIso,
  addMonthsIso,
  addYearsIso,
  deviceZoneSuggestion,
  effectiveDateZone,
  isValidTimeZone,
  localClock,
  todayLocal,
} from "../.test-build/dates.js";

test("todayLocal returns the calendar date in the given zone, not the UTC date (critic-01)", () => {
  // 23:30 in Los Angeles on 10 September is already 11 September in UTC.
  const lateEvening = new Date("2026-09-11T06:30:00Z");
  assert.equal(todayLocal("America/Los_Angeles", lateEvening), "2026-09-10");
  assert.equal(todayLocal("UTC", lateEvening), "2026-09-11");
  // East of the date line the local date is ahead of UTC.
  assert.equal(
    todayLocal("Pacific/Kiritimati", new Date("2026-09-10T10:30:00Z")),
    "2026-09-11",
  );
  // The e2e spec's instant: 22:30 on the 9th in New York.
  assert.equal(
    todayLocal("America/New_York", new Date("2026-09-10T02:30:00Z")),
    "2026-09-09",
  );
  assert.match(todayLocal("Asia/Tokyo"), ISO_DATE_PATTERN);
});

test("localClock agrees with the reminder engine's clock at the pinned instants", () => {
  assert.deepEqual(
    localClock("Asia/Kathmandu", new Date("2026-07-26T03:15:00.000Z")),
    { date: "2026-07-26", hour: 9 },
  );
  assert.equal(
    localClock("America/New_York", new Date("2026-03-08T13:00:00.000Z")).hour,
    9,
    "first hour of EDT",
  );
  assert.equal(
    localClock("America/New_York", new Date("2026-11-01T14:00:00.000Z")).hour,
    9,
    "first hour of EST",
  );
  assert.equal(
    localClock("UTC", new Date("2026-07-27T00:10:00.000Z")).hour,
    0,
    "hourCycle h23: midnight is 0, never 24",
  );
});

test("an invalid zone falls back to UTC instead of throwing", () => {
  assert.equal(isValidTimeZone("Mars/Olympus_Mons"), false);
  assert.equal(isValidTimeZone("Etc/UTC"), true);
  const lateEvening = new Date("2026-09-11T06:30:00Z");
  assert.equal(
    todayLocal("Mars/Olympus_Mons", lateEvening),
    todayLocal(UTC_FALLBACK_ZONE, lateEvening),
  );
});

test("deviceZoneSuggestion offers the device zone only while the stored zone is the UTC fallback", () => {
  assert.equal(deviceZoneSuggestion("UTC", "America/New_York"), "America/New_York");
  assert.equal(deviceZoneSuggestion("UTC", "UTC"), null);
  assert.equal(deviceZoneSuggestion("America/Chicago", "America/New_York"), null);
  assert.equal(deviceZoneSuggestion("UTC", "Mars/Olympus_Mons"), null);
});

test("effectiveDateZone prefers a chosen zone and otherwise the device zone", () => {
  assert.equal(effectiveDateZone("UTC", "America/New_York"), "America/New_York");
  assert.equal(effectiveDateZone("Europe/Paris", "America/New_York"), "Europe/Paris");
  assert.equal(effectiveDateZone("UTC", "Mars/Olympus_Mons"), "UTC");
});

test("date arithmetic clamps to the end of a shorter month", () => {
  assert.equal(addYearsIso("2024-02-29", 1), "2025-02-28");
  assert.equal(addDaysIso("2026-12-31", 1), "2027-01-01");
  assert.equal(addMonthsIso("2026-01-31", 1), "2026-02-28");
  // A custom credential's default cycle start: one year back from today.
  assert.equal(addYearsIso("2026-09-10", -1), "2025-09-10");
  // A template's default cycle start: one year ahead minus its cycle length.
  assert.equal(addMonthsIso(addYearsIso("2026-09-10", 1), -24), "2025-09-10");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH" && npm run build:lib-test && node --experimental-sqlite --test tests/dates.test.mjs`
Expected: `build:lib-test` succeeds (it does not list `dates.ts` yet), then FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/.test-build/dates.js'`.

- [ ] **Step 3: Create `app/lib/dates.ts` and add it to `build:lib-test`**

Create `app/lib/dates.ts`:

```ts
// Calendar dates for the app, computed in an IANA time zone rather than in
// UTC. Every default date the client offers (a completion date, a submission
// or acceptance date, a new credential's cycle window, a snooze) and every
// server-side "today" comparison goes through `todayLocal`, so a user in Los
// Angeles at 23:30 sees today's date, not tomorrow's (audit critic-01).
//
// Deliberately dependency-free and free of DOM/D1 types: `npm run
// build:lib-test` compiles this file standalone for tests/dates.test.mjs, and
// tests/rendered-html.test.mjs can inline it as raw TypeScript.

export const UTC_FALLBACK_ZONE = "UTC";
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function localClock(
  timeZone: string,
  now: Date = new Date(),
): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: isValidTimeZone(timeZone) ? timeZone : UTC_FALLBACK_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour")),
  };
}

export function todayLocal(timeZone: string, now: Date = new Date()): string {
  return localClock(timeZone, now).date;
}

// The stored reminder zone is the literal "UTC" for every account that has
// never chosen one (the column default and the ensureUser seed), so that
// literal — and only that literal — means "unset" here. "Etc/UTC" or any
// other spelling is a deliberate choice and is respected.
export function deviceZoneSuggestion(
  storedZone: string,
  deviceZone: string,
): string | null {
  if (storedZone !== UTC_FALLBACK_ZONE) return null;
  if (deviceZone === UTC_FALLBACK_ZONE) return null;
  return isValidTimeZone(deviceZone) ? deviceZone : null;
}

// The zone default dates are computed in: the chosen zone, or the device's
// while the account is still on the fallback (a dismissed offer must not
// keep the UTC off-by-one bug alive).
export function effectiveDateZone(
  storedZone: string,
  deviceZone: string,
): string {
  if (storedZone !== UTC_FALLBACK_ZONE) return storedZone;
  return isValidTimeZone(deviceZone) ? deviceZone : UTC_FALLBACK_ZONE;
}

export function addDaysIso(value: string, days: number): string {
  const date = new Date(`${value.slice(0, 10)}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function addMonthsIso(value: string, months: number): string {
  const date = new Date(`${value.slice(0, 10)}T12:00:00.000Z`);
  const targetDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(targetDay, lastDay));
  return date.toISOString().slice(0, 10);
}

// Whole years through the month arithmetic so 29 February clamps to the 28th
// instead of rolling into March the way `setFullYear` does.
export function addYearsIso(value: string, years: number): string {
  return addMonthsIso(value, years * 12);
}
```

In `package.json`, the `build:lib-test` script (Task 5) is currently:

```json
"build:lib-test": "tsc app/lib/navigation.ts app/lib/clientError.ts app/lib/apiResponse.ts app/lib/routeTitle.ts app/lib/readiness.ts app/lib/activityDraft.ts app/lib/certificateOcr.ts --outDir .test-build --module nodenext --target es2022",
```

Replace it with (only `app/lib/dates.ts` is added, before `--outDir`; every input still lives in `app/lib`, so the output stays flat):

```json
"build:lib-test": "tsc app/lib/navigation.ts app/lib/clientError.ts app/lib/apiResponse.ts app/lib/routeTitle.ts app/lib/readiness.ts app/lib/activityDraft.ts app/lib/certificateOcr.ts app/lib/dates.ts --outDir .test-build --module nodenext --target es2022",
```

- [ ] **Step 4: Run the unit test to see it pass**

Run: `npm run build:lib-test && node --experimental-sqlite --test tests/dates.test.mjs`
Expected: PASS — 6 tests, 0 failures, and `ls .test-build/dates.js` exists.

- [ ] **Step 5: Write the failing source guard**

Append to the end of `tests/app-source-guards.test.mjs` (`readClientSources` is already imported at the top of the file from `./helpers/clientSources.mjs` — Task 1; it walks every `.ts/.tsx/.mts` under `app/`, API routes included):

```js
// critic-01: every default date comes from todayLocal(zone) in
// app/lib/dates.ts. A UTC "today" anywhere under app/ — a screen or an API
// route — reintroduces the evening off-by-one, so the expression is banned
// outright, and the retired helper's name is banned too so it cannot come
// back under a fresh alias.
test("no file under app/ computes today in UTC (critic-01)", () => {
  for (const { file, source } of readClientSources()) {
    assert.doesNotMatch(
      source,
      /new Date\(\)\s*\.toISOString\(\)\.slice\(0,\s*10\)/,
      `${file}: use todayLocal(zone) from app/lib/dates.ts, never the UTC date`,
    );
    assert.doesNotMatch(
      source,
      /\bconst todayIso\b/,
      `${file}: todayIso was retired by app/lib/dates.ts`,
    );
  }
});
```

- [ ] **Step 6: Run the guard to see it fail**

Run: `node --experimental-sqlite --test tests/app-source-guards.test.mjs`
Expected: FAIL — the new test's message names `ITrackApp.tsx` (`const todayIso` at `:409`) or `api/export/route.ts` (`:112`), whichever the directory walk reaches first; the guards that were already there still pass.

- [ ] **Step 7: Write the failing Playwright spec**

Create `tests/e2e/local-dates.spec.ts`:

```ts
import { expect, freshIdentity, test } from "./fixtures";

// critic-01: the app's "today" was the UTC date, so every default date input
// disagreed with the phone's own calendar after ~8 pm in the Americas, and
// nothing ever captured the device's zone (every account is seeded with the
// literal 'UTC'). A fresh account in New York at 22:30 on 9 September
// (02:30Z on the 10th) must see the 9th in the log sheet, and one tap on the
// offer banner must persist America/New_York as the reminder zone.
//
// A fresh identity: the tap writes reminder_preferences, and the demo
// identity is read-only in every spec.
test.use({ identity: freshIdentity(), timezoneId: "America/New_York" });

test("default dates are local and one tap adopts the device time zone", async ({ app, page }) => {
  await app.seedCredential();
  // Fixed wall clock for the page only; the server keeps real time (no server
  // write compares a date to "today" except the snooze check).
  await page.clock.setFixedTime(new Date("2026-09-10T02:30:00Z"));
  await app.goto("/");
  expect(
    await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    "the context fixture must apply timezoneId (spread contextOptions in browser.newContext)",
  ).toBe("America/New_York");

  const sheet = await app.openLog();
  await expect(sheet.locator('input[name="completionDate"]')).toHaveValue("2026-09-09");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  const adopt = page.getByRole("button", { name: "Use America/New_York" });
  await expect(adopt).toBeVisible();
  await adopt.click();
  await expect(page.locator(".zone-banner")).toHaveCount(0);

  await app.goto("/profile");
  await expect(page.getByText("Times use America/New_York.")).toBeVisible();
  expect((await app.workspace()).reminderPreferences.timeZone).toBe("America/New_York");
  app.expectNoErrors();
});
```

- [ ] **Step 8: Run the spec to see it fail**

Start the dev server if it is not running (`npm run dev` in another terminal; `:3000`), then run: `npm run test:e2e:desktop -- tests/e2e/local-dates.spec.ts`
Expected: FAIL at `toHaveValue("2026-09-09")` — `Received: "2026-09-10"` (the UTC date at the fixed instant). If the earlier `Intl` assertion fails instead, the `context` fixture in `tests/e2e/fixtures.ts` is dropping `contextOptions`; fix that there before continuing (it also means the phone projects' viewport is not applied).

- [ ] **Step 9: Client — move the date helpers into `app/lib/dates.ts`**

Locate: `grep -n "todayIso\|nextYearIso\|yearAgoIso\|^function addDaysIso\|^function addMonthsIso\|^function defaultCatalog" app/ITrackApp.tsx` — expected hits: the definitions (`:409, 411, 417, 444, 450, 462, 471`), the `defaultCatalog*` bodies (`:467-468, 474`), and the eight `todayIso()` call sites edited in Step 10.

Add the import immediately before `import { routeTitle } from "./lib/routeTitle";` (`:76`):

```ts
import {
  UTC_FALLBACK_ZONE,
  addDaysIso,
  addMonthsIso,
  addYearsIso,
  deviceZoneSuggestion,
  effectiveDateZone,
  todayLocal,
} from "./lib/dates";
```

Delete these 13 lines (`:409-421`, the blank line after them goes too):

```ts
const todayIso = () => new Date().toISOString().slice(0, 10);

const nextYearIso = () => {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 1);
  return date.toISOString().slice(0, 10);
};

const yearAgoIso = () => {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 1);
  return date.toISOString().slice(0, 10);
};
```

Replace this block (`:444-475`, from `function addDaysIso` through the closing brace of `defaultCatalogDeadline`):

```ts
function addDaysIso(value: string, days: number) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addMonthsIso(value: string, months: number) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00.000Z`);
  const targetDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(targetDay, lastDay));
  return date.toISOString().slice(0, 10);
}

function defaultCatalogCycleStart(
  rule: CatalogRule | null | undefined,
) {
  if (isAbveCatalogRule(rule)) return "2025-01-01";
  return rule
    ? addMonthsIso(nextYearIso(), -rule.cycleMonths)
    : yearAgoIso();
}

function defaultCatalogDeadline(
  rule: CatalogRule | null | undefined,
) {
  return isAbveCatalogRule(rule) ? "2027-12-31" : nextYearIso();
}
```

with:

```ts
// Default cycle window for a new credential, anchored on the caller's local
// `today` (app/lib/dates.ts) rather than the UTC date. ABVE's fixed cycle is
// the one template with hard-coded dates.
function defaultCatalogCycleStart(
  rule: CatalogRule | null | undefined,
  today: string,
) {
  if (isAbveCatalogRule(rule)) return "2025-01-01";
  return rule
    ? addMonthsIso(addYearsIso(today, 1), -rule.cycleMonths)
    : addYearsIso(today, -1);
}

function defaultCatalogDeadline(
  rule: CatalogRule | null | undefined,
  today: string,
) {
  return isAbveCatalogRule(rule) ? "2027-12-31" : addYearsIso(today, 1);
}
```

`confirmedCarryoverWindowStart` (`:495`) and the acceptance-form defaults (`:5803, 5809, 5830`) keep calling `addDaysIso`/`addMonthsIso` on credential dates; they now resolve to the imported functions and are otherwise untouched.

- [ ] **Step 10: Client — the `today()` pair and the eight default-date call sites**

After `const FORM_ACTION_KEY = "form";` (`:1246`, unique) add:

```ts
// The time-zone offer banner's own key: its Use button greys out while the
// preference write is on the wire without freezing any open sheet.
const TIME_ZONE_ACTION_KEY = "time-zone";

// Where "Not now" is remembered — per account and per device zone, under the
// `itrack:` prefix (the `license-lantern:` draft prefix is load-bearing and
// stays draft-only) — so the offer returns only after a genuine move.
function zoneOfferStorageKey(draftStorageNamespace: string) {
  return `itrack:time-zone-offer:v1:${draftStorageNamespace}`;
}
```

Inside `ITrackApp()`, replace `const [nremtSubmissionDate, setNremtSubmissionDate] = useState(todayIso());` (`:1674`, unique) with:

```ts
  // Pre-workspace placeholder in the device zone; openSubmission() replaces
  // it with today() when the sheet opens.
  const [nremtSubmissionDate, setNremtSubmissionDate] = useState(() =>
    todayLocal(deviceTimeZone()),
  );
```

In the `activityDraft` initialiser (`:1707-1714`, the `useState<ActivityDraft>(() => ({` block) replace `    completionDate: todayIso(),` with `    completionDate: todayLocal(deviceTimeZone()),` (this initial value is never shown: `resetActivityEntry` runs when the sheet opens).

After `const [isOnline, setIsOnline] = useState(true);` (`:1727`, unique) add:

```ts
  // The calendar "today" every default date comes from (critic-01): the
  // stored reminder zone once the user has chosen one, the device's zone
  // while it is still the 'UTC' fallback every account starts with.
  const dateZone = useMemo(
    () =>
      effectiveDateZone(
        workspace?.reminderPreferences.timeZone ?? UTC_FALLBACK_ZONE,
        deviceTimeZone(),
      ),
    [workspace?.reminderPreferences.timeZone],
  );
  const today = useCallback(() => todayLocal(dateZone), [dateZone]);
  // The one-tap offer: only while the stored zone is the literal 'UTC' and
  // the device reports a real, different zone. Never evaluated during SSR
  // because `workspace` is fetched on the client.
  const [zoneOfferDismissed, setZoneOfferDismissed] = useState(false);
  const zoneSuggestion = workspace
    ? deviceZoneSuggestion(
        workspace.reminderPreferences.timeZone,
        deviceTimeZone(),
      )
    : null;
  useEffect(() => {
    const namespace = workspace?.user.draftStorageNamespace;
    if (!namespace) return;
    try {
      setZoneOfferDismissed(
        window.localStorage.getItem(zoneOfferStorageKey(namespace)) ===
          deviceTimeZone(),
      );
    } catch {
      setZoneOfferDismissed(false);
    }
  }, [workspace?.user.draftStorageNamespace]);
```

In `resetActivityEntry` (`:1767-1786`) replace `      completionDate: todayIso(),` (`:1771`, the one inside `setActivityDraft({`) with `      completionDate: today(),` and change its dependency array — the three lines

```ts
    setActivityDraftCredentialWarning("");
    setActivityDraftPersistenceStatus("idle");
  }, []);
```

become

```ts
    setActivityDraftCredentialWarning("");
    setActivityDraftPersistenceStatus("idle");
  }, [today]);
```

(`openActivityEntryFor` already lists `resetActivityEntry` in its own deps, so no other array changes.)

Then the eight remaining one-line edits — locate all of them at once with `grep -n 'todayIso()\|?? "UTC")\|defaultCatalogCycleStart(selectedRule)\|defaultCatalogDeadline(selectedRule)' app/ITrackApp.tsx` (expected: exactly these eight hits once the edits above in Steps 9-10 are done):

| at `main` | existing line | replacement |
|---|---|---|
| `:3123` (inside the OCR `setActivityDraft((current) => …)` updater) | `          ? todayIso()` | `          ? today()` |
| `:3622` (`openSubmission`) | `    setNremtSubmissionDate(todayIso());` | `    setNremtSubmissionDate(today());` |
| `:3704` (`handleReminderPreferences`) | `        timeZone: String(form.get("timeZone") ?? "UTC"),` | `        timeZone: String(form.get("timeZone") ?? deviceTimeZone()),` |
| `:3724` (`setReminderState`) | `          status === "snoozed" ? addDaysIso(todayIso(), 7) : null,` | `          status === "snoozed" ? addDaysIso(today(), 7) : null,` |
| `:5295` (credential setup, `name="cycleStart"`) | `                      : defaultCatalogCycleStart(selectedRule)` | `                      : defaultCatalogCycleStart(selectedRule, today())` |
| `:5310` (credential setup, `name="deadline"`) | `                      : defaultCatalogDeadline(selectedRule)` | `                      : defaultCatalogDeadline(selectedRule, today())` |
| `:5525` (`name="submissionDate"`) | `                  : { defaultValue: todayIso() })}` | `                  : { defaultValue: today() })}` |
| `:5709` (`name="acceptedAt"`) | `                  defaultValue={todayIso()}` | `                  defaultValue={today()}` |

After these, `grep -n "todayIso\|nextYearIso\|yearAgoIso" app/ITrackApp.tsx` prints nothing.

- [ ] **Step 11: Client — the banner, its two handlers, and the Profile copy**

Handlers: immediately after `handleReminderPreferences` — i.e. after the two lines

```ts
    if (result) setRemindersOpen(false);
  }
```

and before `  async function setReminderState(` (`:3713`) — add:

```ts
  // The one-tap offer persists the device zone through the existing
  // preference action, so nothing new reaches the server. runAction's
  // refetch updates reminderPreferences.timeZone, which unmounts the banner.
  // A stale pushEnabled:true (the scheduler pauses push when the last device
  // expires) can answer 409 push_subscription_required; that surfaces in the
  // error banner with Try again, like any other write.
  async function adoptDeviceTimeZone() {
    if (!workspace || !zoneSuggestion) return;
    const prefs = workspace.reminderPreferences;
    await runAction(
      "updateReminderPreferences",
      {
        inAppEnabled: prefs.inAppEnabled,
        pushEnabled: prefs.pushEnabled,
        pushHourLocal: prefs.pushHourLocal ?? 9,
        leadDays: prefs.leadDays,
        timeZone: zoneSuggestion,
      },
      `Reminders now use ${zoneSuggestion}.`,
      TIME_ZONE_ACTION_KEY,
    );
  }

  function dismissZoneOffer() {
    if (workspace) {
      try {
        window.localStorage.setItem(
          zoneOfferStorageKey(workspace.user.draftStorageNamespace),
          deviceTimeZone(),
        );
      } catch {
        // Private mode or a full store: the offer simply returns next load.
      }
    }
    setZoneOfferDismissed(true);
  }
```

Markup: inside `<main id="main-content">`, immediately after the error-banner block — the lines

```tsx
              <button type="button" onClick={() => void loadWorkspace()}>
                Try again
              </button>
            </div>
          ) : null}

          <div className="screen-stack" ref={screenStackRef}>
```

become

```tsx
              <button type="button" onClick={() => void loadWorkspace()}>
                Try again
              </button>
            </div>
          ) : null}

          {workspace && isOnline && zoneSuggestion && !zoneOfferDismissed ? (
            <div className="zone-banner" role="status">
              <div>
                <strong>Your device is in {zoneSuggestion}</strong>
                <small>Reminders and default dates currently use UTC.</small>
              </div>
              <button
                type="button"
                disabled={pendingActionKeys.includes(TIME_ZONE_ACTION_KEY)}
                onClick={() => void adoptDeviceTimeZone()}
              >
                Use {zoneSuggestion}
              </button>
              <button
                type="button"
                className="link-button"
                onClick={dismissZoneOffer}
              >
                Not now
              </button>
            </div>
          ) : null}

          <div className="screen-stack" ref={screenStackRef}>
```

Profile copy: in `AccountView`'s `reminder-settings-card` (`grep -n 'className="card reminder-settings-card"' app/ITrackApp.tsx`), the paragraph

```tsx
          <p>
            {workspace.reminderPreferences.leadDays.length
              ? `Check-ins are scheduled ${workspace.reminderPreferences.leadDays.join(
                  ", ",
                )} days before due dates.`
              : "Choose when upcoming due dates should appear on Today."}
          </p>
```

becomes

```tsx
          <p>
            {workspace.reminderPreferences.leadDays.length
              ? `Check-ins are scheduled ${workspace.reminderPreferences.leadDays.join(
                  ", ",
                )} days before due dates.`
              : "Choose when upcoming due dates should appear on Today."}{" "}
            Times use {workspace.reminderPreferences.timeZone}.
          </p>
```

- [ ] **Step 12: Styles — `.zone-banner`**

In `app/globals.css`, immediately before `.offline-workspace {` (`grep -n "^\.offline-workspace {" app/globals.css` → `:5348`; the rule above it is `.error-banner button { … padding: 0 12px; }`) insert the offline banner's shape and tokens plus the two buttons (no colour literals — `tools/contrast-audit.mjs` runs in `npm test` since Task 6):

```css
/* The one-tap time-zone offer (critic-01): the offline banner's shape and
   tokens, plus its Use and Not-now buttons. */
.zone-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 18px;
  border: 1px solid var(--edge);
  border-radius: 13px;
  background: var(--wash-tint);
  color: var(--ink-tint-deep);
  padding: 12px 14px;
}

.zone-banner > div {
  flex: 1 1 auto;
}

.zone-banner strong,
.zone-banner small {
  display: block;
}

.zone-banner strong {
  font-size: var(--text-sm);
}

.zone-banner small {
  margin-top: 2px;
  color: var(--ink-muted);
  font-size: var(--text-xs);
}

.zone-banner button {
  min-height: var(--tap-min);
  border: 1px solid var(--edge);
  border-radius: 9px;
  background: var(--white);
  color: var(--ink-tint-deep);
  cursor: pointer;
  font-size: var(--text-sm);
  font-weight: 800;
  padding: 0 12px;
}

.zone-banner button:disabled {
  cursor: default;
  opacity: 0.6;
}

.zone-banner .link-button {
  border: 0;
  background: transparent;
  color: var(--ink-tint);
  padding: 0 4px;
}

.zone-banner .link-button:hover {
  text-decoration: underline;
}

```

Inside the `@media (max-width: 540px) {` block (`:6089`), the rule

```css
  .offline-banner {
    align-items: flex-start;
  }
```

becomes

```css
  .offline-banner,
  .zone-banner {
    align-items: flex-start;
  }

  .zone-banner {
    flex-wrap: wrap;
  }

  .zone-banner > div {
    flex-basis: 100%;
  }
```

- [ ] **Step 13: Server — `route.ts` delegates and the CSV filename uses the stored zone**

`app/api/workspace/route.ts`: after `import { env } from "cloudflare:workers";` (`:32`) add

```ts
import { todayLocal } from "../../lib/dates";
```

and replace the whole function (`:2206-2216`; `grep -n "^function todayInTimeZone" app/api/workspace/route.ts`)

```ts
function todayInTimeZone(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
```

with

```ts
// One implementation of "today in a zone" for the whole app (critic-01).
// The three callers (the weekly-progression period and the snooze check)
// validate the zone first; todayLocal falls back to UTC on its own anyway.
function todayInTimeZone(timeZone: string) {
  return todayLocal(timeZone);
}
```

The call sites at `:2392`, `:2413` and `:12207` are unchanged, and the existing rendered-html fixtures (fake preferences with `timeZone: "UTC"`) produce identical dates.

`app/api/export/route.ts`: after line 3 (`import { ensureUser, initializeDatabase } from "@/db/runtime";`) add

```ts
import { isValidTimeZone, todayLocal } from "../../lib/dates";
```

and replace `    const today = new Date().toISOString().slice(0, 10);` (`:112`) with

```ts
    // The download's date is the user's date, not the worker's UTC date.
    const preference = await database
      .prepare(
        `SELECT time_zone AS timeZone
         FROM reminder_preferences
         WHERE user_id = ?`,
      )
      .bind(identity.userId)
      .first<{ timeZone: string }>();
    const zone = preference?.timeZone ?? "UTC";
    const today = todayLocal(isValidTimeZone(zone) ? zone : "UTC");
```

(`database` and `identity` are in scope from `:28-41`; no test pins the CSV filename or this route's statement count — Task 1's isolation probe only checks the body.)

- [ ] **Step 14: Run the guard, the unit test, typecheck and lint**

Run: `npm run build:lib-test && node --experimental-sqlite --test tests/dates.test.mjs tests/app-source-guards.test.mjs && npm run typecheck && npm run lint`
Expected: PASS (both files, all tests), `tsc --noEmit` silent, eslint clean. If `react-hooks/exhaustive-deps` reports `resetActivityEntry`, its array is missing `today` (Step 10).

- [ ] **Step 15: Run the Playwright spec to see it pass**

Dev server up, then: `npm run test:e2e:desktop -- tests/e2e/local-dates.spec.ts`
Expected: PASS — completion date `2026-09-09`, the banner's `Use America/New_York` tap persists the zone, Profile reads `Times use America/New_York.`, no page errors.

- [ ] **Step 16: Pin the scheduler at 9:00 stored-local (rendered-html proof)**

In `tests/rendered-html.test.mjs`, inside the subtest `"owns, schedules, deduplicates, retries, and expires private phone alerts"`, locate `grep -n "assert.equal(restoreLeadResponse.status, 200);" tests/rendered-html.test.mjs` (`:21549` at `main`). At that point the preferences are `America/New_York`, `pushHourLocal: 9`, `leadDays: [1]`, push is enabled, the only active device is `firstSubscription` (its mocked endpoint answers 201), and the fixture's credential `credential-push-due` (deadline `2026-07-27`) has already been delivered for its `2026-07-26` lead day. Insert, between that assertion and the following `const secondSubscription = await makeSubscription(`, a second credential due one day later so its own lead-day reminder falls on `2026-07-27`:

```js
        // critic-01 / spec §4: alerts go out at pushHourLocal in the STORED
        // zone. A second credential due the next day (lead day 2026-07-27
        // with leadDays [1]) proves the gate on the one active device: at
        // 08:30 America/New_York nothing is materialised, at 09:05 one row is.
        database.raw
          .prepare(
            `INSERT INTO credentials (
               id, user_id, rule_set_id, credential_name, profession,
               jurisdiction, issuer, cycle_start, deadline, total_required,
               unit_label, status
             ) VALUES (
               'credential-push-local-clock',
               ?,
               NULL,
               'Local clock credential',
               'Testing',
               'New York',
               'Test board',
               '2026-01-01',
               '2026-07-28',
               1,
               'credit',
               'active'
             )`,
          )
          .run(ownerId);
        const localClockKey =
          "deadline:credential-push-local-clock:2026-07-28";
        const ledgerRows = () =>
          database.raw
            .prepare(`SELECT COUNT(*) AS count FROM push_delivery_ledger`)
            .get().count;
        const localClockRows = () =>
          database.raw
            .prepare(
              `SELECT COUNT(*) AS count
               FROM push_delivery_ledger
               WHERE reminder_key = ?`,
            )
            .get(localClockKey).count;
        const ledgerRowsBefore = ledgerRows();
        await runScheduled(Date.parse("2026-07-27T12:30:00.000Z"));
        assert.equal(
          ledgerRows(),
          ledgerRowsBefore,
          "08:30 EDT is before the 9:00 stored-local hour: nothing is materialised",
        );
        assert.equal(localClockRows(), 0);
        await runScheduled(Date.parse("2026-07-27T13:05:00.000Z"));
        assert.equal(
          localClockRows(),
          1,
          "09:05 EDT: the lead-day reminder is materialised for the one active device",
        );
```

The 09:05 run also delivers that row through the mocked endpoint (its 201 mode persists), so `pushCalls` grows by one; nothing after this point asserts on `pushCalls.length`, and the later runs at `2026-07-26T14:00Z` cannot see this credential (its lead day is the 27th), so the expired-device and retry-device assertions that follow are unaffected. `ownerId`, `runScheduled` and `database.raw` are already in scope.

- [ ] **Step 17: Run the built-worker suite**

Stop the dev server (it shares `.wrangler/` with the build), then run: `npm run build && node --experimental-sqlite --test tests/rendered-html.test.mjs`
Expected: PASS. This pins behaviour `app/lib/pushDelivery.ts:764-773` already has; to watch it bite, change `13:05` to `12:45` temporarily — the last assertion fails with `0 !== 1` — then revert.

- [ ] **Step 18: Full gates**

Run (dev server still stopped): `npm test && npm run typecheck && npm run lint`
Expected: PASS (`tests/*.test.mjs` all green, including `tests/isolation.test.mjs` for the two edited routes and the contrast audit), `tsc --noEmit` silent, eslint clean.
Then start the dev server again (`npm run dev`) and run: `npm run test:e2e`
Expected: PASS on all four projects — every spec, including `tests/e2e/local-dates.spec.ts`.

- [ ] **Step 19: Commit**

```bash
git branch --show-current   # must print feat/wave2-foundation
git add app/lib/dates.ts tests/dates.test.mjs tests/e2e/local-dates.spec.ts package.json app/ITrackApp.tsx app/globals.css app/api/workspace/route.ts app/api/export/route.ts tests/rendered-html.test.mjs tests/app-source-guards.test.mjs
git commit -m "feat: local dates from app/lib/dates.ts and a one-tap device time-zone offer (critic-01)

Every default date (completion, submission, acceptance, cycle window, snooze)
now comes from todayLocal(zone): the chosen reminder zone, or the device zone
while the account is still on the 'UTC' fallback. A one-tap banner persists
the device zone through updateReminderPreferences; Profile names the zone;
the CSV filename and route.ts share the one implementation. rendered-html
pins the scheduler at 9:00 stored-local (nothing at 08:30 EDT, one row at
09:05 EDT); app-source-guards forbids a UTC today under app/.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 12: Current-cycle selection and renewed cycles grouped under their credential (app-ux-04, app-ux-18)

**Rationale:** spec §4 bullet 6 ("`getWorkspace` derives `activeCycle` as the earliest open cycle whose end date is in the future, else the most recently opened cycle; Home never shows an accepted/closed cycle with a countdown") and bullet 7 ("closed cycles are grouped under the credential, not listed as siblings"). A cycle is a `credentials` row; `markRenewalAccepted` flips the source row to `status = 'renewed'` and inserts a successor row that shares its `seriesId` (`COALESCE(cycle.series_id, c.id)`, `route.ts:4310`). Today the client's default selection (`ITrackApp.tsx:1982-1992`) sorts every row by deadline with no status filter, so on every reload after a first renewal the renewed row — always the soonest deadline — wins, and the hero (`:7157-7170`) and the detail stat (`:8238-8250`) count it down with no renewed guard (app-ux-04, P1). `CredentialsView` (`:7921-8001`) lists every row as a sibling with only a bare percentage (app-ux-18). Vocabulary: "open" = `status IN ('active','submitted')` (a submitted cycle keeps a live deadline until acceptance), "closed" = `renewed`; "most recently opened" = largest `cycleStart` (the payload carries no `created_at`); every stored date passes `isoDateField`, so string comparison orders them. The SQL `ORDER BY` at `route.ts:4342-4343` is unchanged (`tests/rendered-html.test.mjs:22759-22779` requires renewed rows to stay in the flat `credentials[]`); the `[0]` fallbacks that depended on it go instead. Line numbers below are `main@8ac172a`; Tasks 7, 10 and 11 shift them, so every edit is anchored on quoted text and located with the `grep -n` given.

**Files:**
- Create: `app/lib/cycles.ts`, `tests/cycles.test.mjs`, `tests/workspace-cycles.test.mjs`, `tests/e2e/renewed-cycle-home.spec.ts`
- Modify: `package.json` (`build:lib-test` + `app/lib/cycles.ts`)
- Modify: `app/api/workspace/route.ts` (import next to `:39`; `getWorkspace` before its `return` at `:5142`; the credential map body `:5165-5209`; top-level `activeCycleId`)
- Modify: `app/ITrackApp.tsx` — react import `:3-14` (`Fragment`), lib imports after `:56`, `type Credential:137-178`, `type Workspace:308-339`, selection `:1982-1992`, `selectedCredential:2427-2436`, `openCredentialDetail:4152-4155`, the fourteen `status !== "renewed"` sites `:1835, 1846, 2285, 2621, 2644, 4321, 7403, 7661, 7743, 8184, 8296, 8588, 8605, 8623`, TodayView hero `:7051, 7157-7169`, `CredentialDetailScreen` stat `:8051, 8238-8250`, `CredentialsView:7921-8001`
- Modify: `app/globals.css` (two rule blocks: after `.deadline-number span` `:1142-1149`; after `.archived-item-state` `:3348-3352`)
- Modify: `tests/app-source-guards.test.mjs` (append one guard: no `!== "renewed"` outside `app/lib/cycles.ts`)
- Test: `tests/cycles.test.mjs`, `tests/workspace-cycles.test.mjs`, `tests/app-source-guards.test.mjs`, `tests/rendered-html.test.mjs`, `tests/isolation.test.mjs`, `npm run test:e2e`

**Interfaces:**
- Consumes: Task 11 `todayLocal(timeZone: string, now?: Date): string` from `app/lib/dates.ts` (already imported by `route.ts` and `ITrackApp.tsx`); `deviceTimeZone()` from `app/lib/webPush.ts` (already imported at `ITrackApp.tsx:84`); Task 10's `type Credential` (`revision`, `archivedAt`) and `CredentialDetailScreen`; Task 8's `archivedCredentials` and `CredentialRow.archivedAt`; Task 5's `build:lib-test`; Task 3 fixtures (`test`, `expect`, `freshIdentity`, `app.seedCredential/act/workspace/goto/expectNoErrors`); Task 1's `readClientSources()` import in `tests/app-source-guards.test.mjs`.
- Produces `app/lib/cycles.ts` (its only import is `./readiness.js` — the `.js` suffix is mandatory: `tsc --module nodenext` rejects a bare `./readiness` with TS2835, and the emitted `.test-build/cycles.js` must resolve under Node ESM; `moduleResolution: "bundler"` maps `./readiness.js` to `readiness.ts` for `npm run typecheck` and the vinext build):
  ```ts
  import { daysUntilDate } from "./readiness.js";
  export type CycleStatus = "active" | "submitted" | "renewed";
  export const OPEN_CYCLE_STATUSES: readonly string[] = ["active", "submitted"];
  export type CycleLike = { id: string; status: string; deadline: string; cycleStart: string; seriesId?: string | null; acceptedAt?: string | null };
  export type CycleSeries<T extends CycleLike> = { seriesId: string; current: T | null; previous: T[]; members: T[] };
  export function isOpenCycle(cycle: { status: string }): boolean;      // active | submitted
  export function isClosedCycle(cycle: { status: string }): boolean;    // renewed
  export function seriesKey(cycle: { id: string; seriesId?: string | null }): string; // seriesId ?? id
  export function compareCycleUrgency(a: CycleLike, b: CycleLike): number; // deadline asc, cycleStart asc, id asc
  export function activeCycleId(cycles: readonly CycleLike[], today: string): string | null;
    // 1 open && deadline >= today → smallest deadline; 2 else open → largest cycleStart (id desc tiebreak); 3 else any → largest cycleStart (a renewed cycle, shown without a countdown); 4 else null
  export function groupCycles<T extends CycleLike>(cycles: readonly T[], today: string): CycleSeries<T>[];
    // group by seriesKey; current = the member activeCycleId(members, today) names when it is open, else null; previous = renewed members by deadline desc; series ordered by current urgency, series without current last (by newest previous deadline desc)
  export function selectDefaultCredentialId(cycles: readonly { id: string; status: string }[], current: string, activeId: string | null): string; // keep current iff it exists && isOpenCycle, else activeId ?? ""
  export function cycleCountdown(cycle: CycleLike, nowMs: number): { kind: "closed"; acceptedAt: string | null } | { kind: "overdue" | "due"; days: number };
  ```
- Produces on the server: `getWorkspace` return += `activeCycleId: string | null` (computed with `todayLocal(reminderData.reminderPreferences.timeZone)` over `credentialResult.results` **excluding archived rows**); each credential (both lists) += `isCurrentCycle: boolean; previousCycleIds: string[]` — the series' renewed cycles other than the row itself, newest first (an archived row gets `false` / `[]`).
- Produces on the client: `type Credential` += `isCurrentCycle?: boolean; previousCycleIds?: string[]`; `type Workspace` += `activeCycleId?: string | null`; `CredentialsView` keeps its name and its position above `function CredentialDetailScreen(`; new client strings, exactly: hero `Renewed` / `Completed` + `Cycle ended <date>`; detail stat `Cycle ended` + `Renewed <date>` / `Completed <date>`; list row ` · Due <date> · N days left|overdue` / ` · Renewed <date>`; disclosure `N previous cycle|cycles`; past-cycle row `Renewed <date>` + `<start> – <end> · N%`.

- [ ] **Step 1: Write the failing unit test**

Create `tests/cycles.test.mjs`:

```js
// `app/lib/cycles.ts` decides which cycle Home points at and how the
// Credentials list folds renewed cycles under their credential (app-ux-04,
// app-ux-18). It is pure, so it is tested here against the ESM that
// `npm run build:lib-test` emits, exactly like tests/navigation.test.mjs.
// `today` is always passed in, never read from the clock, so every case is a
// fixed date.
import assert from "node:assert/strict";
import test from "node:test";

import { daysUntilDate } from "../.test-build/readiness.js";
import {
  OPEN_CYCLE_STATUSES,
  activeCycleId,
  compareCycleUrgency,
  cycleCountdown,
  groupCycles,
  isClosedCycle,
  isOpenCycle,
  selectDefaultCredentialId,
  seriesKey,
} from "../.test-build/cycles.js";

const TODAY = "2026-09-14";

function cycle(id, status, cycleStart, deadline, extra = {}) {
  return { id, status, cycleStart, deadline, ...extra };
}

test("open means active or submitted; closed means renewed", () => {
  assert.deepEqual([...OPEN_CYCLE_STATUSES], ["active", "submitted"]);
  assert.equal(isOpenCycle({ status: "active" }), true);
  assert.equal(isOpenCycle({ status: "submitted" }), true);
  assert.equal(isOpenCycle({ status: "renewed" }), false);
  assert.equal(isClosedCycle({ status: "renewed" }), true);
  assert.equal(isClosedCycle({ status: "submitted" }), false);
});

test("seriesKey falls back to the cycle's own id for a link-less legacy root", () => {
  assert.equal(seriesKey({ id: "root", seriesId: undefined }), "root");
  assert.equal(seriesKey({ id: "root", seriesId: null }), "root");
  assert.equal(seriesKey({ id: "next", seriesId: "root" }), "root");
});

test("compareCycleUrgency orders by deadline, then cycleStart, then id", () => {
  const sorted = [
    cycle("c", "active", "2026-01-01", "2027-06-30"),
    cycle("b", "active", "2025-01-01", "2027-06-30"),
    cycle("a", "active", "2025-01-01", "2027-06-30"),
    cycle("d", "active", "2020-01-01", "2026-12-31"),
  ].sort(compareCycleUrgency);
  assert.deepEqual(sorted.map((entry) => entry.id), ["d", "a", "b", "c"]);
});

test("activeCycleId never picks a renewed cycle over its open successor", () => {
  // app-ux-04's exact shape: the renewed cycle has the earliest deadline.
  const renewed = cycle("old", "renewed", "2024-01-01", "2026-09-16", {
    seriesId: "old",
    acceptedAt: "2026-09-08",
  });
  const successor = cycle("new", "active", "2026-09-17", "2028-08-16", {
    seriesId: "old",
  });
  assert.equal(activeCycleId([renewed, successor], TODAY), "new");
  assert.equal(activeCycleId([successor, renewed], TODAY), "new");
});

test("activeCycleId prefers the soonest open cycle whose deadline has not passed", () => {
  const overdue = cycle("overdue", "active", "2025-01-01", "2026-06-30");
  const future = cycle("future", "active", "2026-01-01", "2027-12-31");
  const later = cycle("later", "active", "2026-01-01", "2028-12-31");
  assert.equal(activeCycleId([later, overdue, future], TODAY), "future");
  // A deadline of exactly today still counts as live.
  const dueToday = cycle("today", "active", "2026-01-01", TODAY);
  assert.equal(activeCycleId([later, dueToday], TODAY), "today");
});

test("activeCycleId falls back to the most recently opened cycle when every open cycle is overdue", () => {
  const older = cycle("older", "active", "2024-01-01", "2025-12-31");
  const newer = cycle("newer", "active", "2025-01-01", "2026-01-31");
  assert.equal(activeCycleId([older, newer], TODAY), "newer");
  // Same start date: the larger id wins, so the answer is stable.
  const tieA = cycle("a", "active", "2025-01-01", "2026-01-31");
  const tieB = cycle("b", "active", "2025-01-01", "2026-01-31");
  assert.equal(activeCycleId([tieA, tieB], TODAY), "b");
});

test("activeCycleId names the most recently opened renewed cycle when nothing is open, and null when nothing exists", () => {
  const first = cycle("first", "renewed", "2020-01-01", "2022-12-31");
  const second = cycle("second", "renewed", "2023-01-01", "2025-12-31");
  assert.equal(activeCycleId([first, second], TODAY), "second");
  assert.equal(activeCycleId([], TODAY), null);
});

test("a submitted cycle counts as open", () => {
  const submitted = cycle("sub", "submitted", "2025-01-01", "2026-12-31");
  const renewed = cycle("ren", "renewed", "2023-01-01", "2024-12-31");
  assert.equal(activeCycleId([renewed, submitted], TODAY), "sub");
});

test("groupCycles folds a three-cycle chain under one series, previous newest first", () => {
  const legacyRoot = cycle("legacy", "active", "2026-03-01", "2028-02-28");
  const first = cycle("s1", "renewed", "2020-01-01", "2021-12-31", {
    seriesId: "s1",
    acceptedAt: "2022-01-10",
  });
  const second = cycle("s2", "renewed", "2022-01-01", "2023-12-31", {
    seriesId: "s1",
    acceptedAt: "2024-01-05",
  });
  const third = cycle("s3", "active", "2024-01-01", "2026-12-31", {
    seriesId: "s1",
  });
  const historyOnly = cycle("h1", "renewed", "2018-01-01", "2019-12-31", {
    seriesId: "h1",
    acceptedAt: "2020-01-15",
  });
  const series = groupCycles(
    [historyOnly, second, legacyRoot, third, first],
    TODAY,
  );
  assert.deepEqual(
    series.map((entry) => ({
      seriesId: entry.seriesId,
      current: entry.current?.id ?? null,
      previous: entry.previous.map((previous) => previous.id),
      members: entry.members.length,
    })),
    [
      // Series with a current cycle first, soonest deadline first …
      { seriesId: "s1", current: "s3", previous: ["s2", "s1"], members: 3 },
      { seriesId: "legacy", current: "legacy", previous: [], members: 1 },
      // … then series that are only history.
      { seriesId: "h1", current: null, previous: ["h1"], members: 1 },
    ],
  );
});

test("selectDefaultCredentialId keeps an open selection and drops a renewed one", () => {
  const cycles = [
    { id: "open", status: "active" },
    { id: "done", status: "renewed" },
  ];
  assert.equal(selectDefaultCredentialId(cycles, "open", "other"), "open");
  assert.equal(selectDefaultCredentialId(cycles, "done", "open"), "open");
  assert.equal(selectDefaultCredentialId(cycles, "missing", "open"), "open");
  assert.equal(selectDefaultCredentialId(cycles, "", "open"), "open");
  assert.equal(selectDefaultCredentialId(cycles, "done", null), "");
});

test("cycleCountdown is closed for a renewed cycle and counts days otherwise", () => {
  const renewed = cycle("ren", "renewed", "2024-01-01", "2026-09-10", {
    acceptedAt: "2026-06-15",
  });
  assert.deepEqual(cycleCountdown(renewed, Date.now()), {
    kind: "closed",
    acceptedAt: "2026-06-15",
  });
  const renewedWithoutDate = cycle("ren2", "renewed", "2024-01-01", "2026-09-10");
  assert.deepEqual(cycleCountdown(renewedWithoutDate, Date.now()), {
    kind: "closed",
    acceptedAt: null,
  });
  // 23:30 on 2026-09-10 in America/Los_Angeles is 06:30Z on the 11th
  // (critic-01's hour). Whether a deadline of 2026-09-10 is already overdue
  // depends on the zone the runtime counts in, so the assertion is parity
  // with daysUntilDate rather than a fixed sign.
  const nowMs = Date.parse("2026-09-11T06:30:00Z");
  const open = cycle("open", "active", "2026-01-01", "2026-09-10");
  const days = daysUntilDate("2026-09-10", nowMs);
  assert.deepEqual(cycleCountdown(open, nowMs), {
    kind: days < 0 ? "overdue" : "due",
    days,
  });
  const far = cycle("far", "active", "2026-01-01", "2027-12-31");
  const farDays = daysUntilDate("2027-12-31", nowMs);
  assert.ok(farDays > 400);
  assert.deepEqual(cycleCountdown(far, nowMs), { kind: "due", days: farDays });
  const past = cycle("past", "submitted", "2024-01-01", "2025-01-01");
  const pastDays = daysUntilDate("2025-01-01", nowMs);
  assert.ok(pastDays < 0);
  assert.deepEqual(cycleCountdown(past, nowMs), { kind: "overdue", days: pastDays });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH" && npm run build:lib-test && node --experimental-sqlite --test tests/cycles.test.mjs`
Expected: FAIL — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/.test-build/cycles.js'` (the build script does not yet compile `app/lib/cycles.ts`).

- [ ] **Step 3: Create `app/lib/cycles.ts` and add it to `build:lib-test`**

Create `app/lib/cycles.ts`:

```ts
/**
 * A "cycle" is one `credentials` row. `active` and `submitted` cycles are
 * open — the deadline still counts down until the board accepts the renewal —
 * and `renewed` cycles are closed: their successor row carries the next
 * deadline. Rows of one credential share a `seriesId`
 * (`COALESCE(cycle.series_id, c.id)` in getWorkspace), so a legacy root that
 * predates cycle links is a series of one.
 *
 * Everything here takes `today` (YYYY-MM-DD) as a parameter instead of reading
 * the clock, so the server (stored reminder zone) and the client (device zone)
 * derive the same answer and a unit test can pin a fixed date. Stored dates
 * are strict YYYY-MM-DD strings, so string comparison orders them correctly.
 *
 * `app/lib/cycles.ts` imports nothing but `./readiness.js`: it is compiled by
 * `npm run build:lib-test` (`tsc --module nodenext`) for `tests/cycles.test.mjs`,
 * which is why the relative import carries the `.js` suffix the emitted ESM needs.
 */
import { daysUntilDate } from "./readiness.js";

export type CycleStatus = "active" | "submitted" | "renewed";

export const OPEN_CYCLE_STATUSES: readonly string[] = ["active", "submitted"];

export type CycleLike = {
  id: string;
  status: string;
  deadline: string;
  cycleStart: string;
  seriesId?: string | null;
  acceptedAt?: string | null;
};

export type CycleSeries<T extends CycleLike> = {
  seriesId: string;
  current: T | null;
  previous: T[];
  members: T[];
};

export function isOpenCycle(cycle: { status: string }): boolean {
  return OPEN_CYCLE_STATUSES.includes(cycle.status);
}

export function isClosedCycle(cycle: { status: string }): boolean {
  return cycle.status === "renewed";
}

export function seriesKey(cycle: {
  id: string;
  seriesId?: string | null;
}): string {
  return cycle.seriesId ?? cycle.id;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Soonest deadline first; ties broken by cycle start, then id, so the order is stable. */
export function compareCycleUrgency(a: CycleLike, b: CycleLike): number {
  return (
    compareStrings(a.deadline, b.deadline) ||
    compareStrings(a.cycleStart, b.cycleStart) ||
    compareStrings(a.id, b.id)
  );
}

// "Most recently opened": the largest cycleStart (the payload carries no
// created_at), then id descending so two cycles opened the same day resolve
// the same way every time.
function compareRecency(a: CycleLike, b: CycleLike): number {
  return compareStrings(b.cycleStart, a.cycleStart) || compareStrings(b.id, a.id);
}

/**
 * The cycle Home should point at:
 *   1. an open cycle whose deadline is today or later — the soonest one;
 *   2. else an open cycle — the most recently opened (every open cycle is overdue);
 *   3. else any cycle — the most recently opened (a renewed cycle, which the
 *      hero shows without a countdown);
 *   4. else null (no credentials).
 */
export function activeCycleId(
  cycles: readonly CycleLike[],
  today: string,
): string | null {
  const open = cycles.filter(isOpenCycle);
  const live = open.filter((cycle) => cycle.deadline >= today);
  if (live.length) return [...live].sort(compareCycleUrgency)[0].id;
  if (open.length) return [...open].sort(compareRecency)[0].id;
  if (cycles.length) return [...cycles].sort(compareRecency)[0].id;
  return null;
}

function compareNewestDeadline(a: CycleLike, b: CycleLike): number {
  return compareStrings(b.deadline, a.deadline) || compareStrings(b.id, a.id);
}

/**
 * One entry per credential (series). `current` is the open cycle
 * `activeCycleId` names for that series, or null when every cycle in it is
 * renewed; `previous` lists the renewed cycles newest first. Series with a
 * current cycle come first, soonest deadline first; series with only history
 * follow, newest ended first.
 */
export function groupCycles<T extends CycleLike>(
  cycles: readonly T[],
  today: string,
): CycleSeries<T>[] {
  const bySeries = new Map<string, T[]>();
  for (const cycle of cycles) {
    const key = seriesKey(cycle);
    const members = bySeries.get(key);
    if (members) members.push(cycle);
    else bySeries.set(key, [cycle]);
  }
  const series: CycleSeries<T>[] = [];
  for (const [seriesId, members] of bySeries) {
    const activeId = activeCycleId(members, today);
    const active = members.find((member) => member.id === activeId) ?? null;
    series.push({
      seriesId,
      current: active && isOpenCycle(active) ? active : null,
      previous: members.filter(isClosedCycle).sort(compareNewestDeadline),
      members,
    });
  }
  return series.sort((a, b) => {
    if (a.current && b.current) return compareCycleUrgency(a.current, b.current);
    if (a.current) return -1;
    if (b.current) return 1;
    return (
      compareStrings(b.previous[0]?.deadline ?? "", a.previous[0]?.deadline ?? "") ||
      compareStrings(a.seriesId, b.seriesId)
    );
  });
}

/**
 * The app-wide selection after a workspace load: keep what the user had only
 * while it is still an open cycle; otherwise fall back to the server's
 * `activeCycleId`. A selection that just became `renewed` (the user accepted
 * a renewal) is dropped here, which is what stops Home from counting down a
 * closed cycle after a reload.
 */
export function selectDefaultCredentialId(
  cycles: readonly { id: string; status: string }[],
  current: string,
  activeId: string | null,
): string {
  const kept = current
    ? cycles.find((cycle) => cycle.id === current)
    : undefined;
  if (kept && isOpenCycle(kept)) return current;
  return activeId ?? "";
}

/** What the hero and the detail stat render: a closed marker, or the day count. */
export function cycleCountdown(
  cycle: CycleLike,
  nowMs: number,
):
  | { kind: "closed"; acceptedAt: string | null }
  | { kind: "overdue" | "due"; days: number } {
  if (isClosedCycle(cycle)) {
    return { kind: "closed", acceptedAt: cycle.acceptedAt ?? null };
  }
  const days = daysUntilDate(cycle.deadline, nowMs);
  return { kind: days < 0 ? "overdue" : "due", days };
}
```

In `package.json`, the `build:lib-test` script (as Task 11 left it) reads:

```json
"build:lib-test": "tsc app/lib/navigation.ts app/lib/clientError.ts app/lib/apiResponse.ts app/lib/routeTitle.ts app/lib/readiness.ts app/lib/activityDraft.ts app/lib/certificateOcr.ts app/lib/dates.ts --outDir .test-build --module nodenext --target es2022",
```

Insert ` app/lib/cycles.ts` immediately before ` --outDir` so it becomes:

```json
"build:lib-test": "tsc app/lib/navigation.ts app/lib/clientError.ts app/lib/apiResponse.ts app/lib/routeTitle.ts app/lib/readiness.ts app/lib/activityDraft.ts app/lib/certificateOcr.ts app/lib/dates.ts app/lib/cycles.ts --outDir .test-build --module nodenext --target es2022",
```

(`.test-build` stays flat because every input lives in `app/lib`; tsc follows the `./readiness.js` import and would emit `readiness.js` even if it were not listed.)

- [ ] **Step 4: Run the unit test to see it pass**

Run: `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH" && npm run build:lib-test && node --experimental-sqlite --test tests/cycles.test.mjs`
Expected: PASS — `# tests 11` / `# pass 11` / `# fail 0`.

- [ ] **Step 5: Write the failing integration test**

Create `tests/workspace-cycles.test.mjs`. It boots the built worker against real node:sqlite with a header identity on a non-local host (so no demo credential is seeded), copying the loader shim from `tests/real-sqlite-seed.test.mjs:14-38` and the `SQLiteD1Database` shim from `tests/rendered-html.test.mjs:157-221` rather than importing them (importing a `*.test.mjs` re-registers its tests):

```js
// The active-cycle derivation, end to end (app-ux-04): after a renewal is
// accepted, GET /api/workspace names the successor as `activeCycleId`, keeps
// the renewed row in the flat `credentials[]` (its totals are history) with
// `isCurrentCycle: false`, and folds it under the successor's
// `previousCycleIds`. Runs the built worker against real node:sqlite with a
// header identity on a non-local host, so no demo credential is seeded.
// Needs `npm run build` first (and no `npm run dev` on :3000 while building).
import assert from "node:assert/strict";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const testCloudflareEnv = {};
globalThis.__LICENSE_LANTERN_TEST_ENV__ = testCloudflareEnv;

const cloudflareWorkersMockUrl = `data:text/javascript,${encodeURIComponent(
  "export const env = globalThis.__LICENSE_LANTERN_TEST_ENV__;",
)}`;
const loaderSource = `
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        url: ${JSON.stringify(cloudflareWorkersMockUrl)},
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  }
`;
register(
  `data:text/javascript,${encodeURIComponent(loaderSource)}`,
  import.meta.url,
);

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
const workerPromise = import(workerUrl.href).then((module) => module.default);

class SQLiteD1Statement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.bindings = [];
  }

  bind(...bindings) {
    this.bindings = bindings;
    return this;
  }

  statement() {
    return this.database.raw.prepare(this.sql);
  }

  async first() {
    return this.statement().get(...this.bindings) ?? null;
  }

  async all() {
    return { results: this.statement().all(...this.bindings) };
  }

  async run() {
    return this.runSync();
  }

  runSync() {
    const result = this.statement().run(...this.bindings);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

class SQLiteD1Database {
  constructor() {
    this.raw = new DatabaseSync(":memory:");
    this.raw.exec("PRAGMA foreign_keys = ON");
  }

  prepare(sql) {
    return new SQLiteD1Statement(this, sql);
  }

  async batch(statements) {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.raw.exec("COMMIT");
      return results;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.raw.close();
  }
}

const evidenceBucketStub = {
  async get() {
    return null;
  },
  async head() {
    return null;
  },
  async put() {
    throw new Error("R2 writes are not expected in this suite");
  },
  async delete() {},
};

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

// A non-local host: the demo identity only exists on localhost, so this
// header is the whole identity and the workspace starts empty.
const BASE_URL = "https://itrack.example";
const IDENTITY = "cycles@example.test";

async function fetchWorker(path, init = {}) {
  const worker = await workerPromise;
  return worker.fetch(
    new Request(`${BASE_URL}${path}`, init),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
      DB: testCloudflareEnv.DB,
      EVIDENCE: testCloudflareEnv.EVIDENCE,
    },
    executionContext,
  );
}

async function act(action, payload) {
  const response = await fetchWorker("/api/workspace", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "oai-authenticated-user-email": IDENTITY,
    },
    body: JSON.stringify({ action, payload }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `${action}: ${JSON.stringify(body)}`);
  assert.equal(body.ok, true, `${action} reports ok`);
  return body.id;
}

async function workspace() {
  const response = await fetchWorker("/api/workspace", {
    headers: {
      accept: "application/json",
      "oai-authenticated-user-email": IDENTITY,
    },
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("getWorkspace derives the active cycle across a renewal", async (t) => {
  const database = new SQLiteD1Database();
  testCloudflareEnv.DB = database;
  testCloudflareEnv.EVIDENCE = evidenceBucketStub;
  try {
    const sourceId = await act("createCredential", {
      credentialName: "Cycles custom credential",
      profession: "Counseling",
      jurisdiction: "Rhode Island",
      issuer: "Cycles board",
      totalRequired: 10,
      unitLabel: "hours",
      cycleStart: "2026-01-01",
      deadline: "2027-12-31",
      categories: [{ name: "General", requiredUnits: 10 }],
    });

    await t.test("a fresh custom credential is its own current cycle", async () => {
      const data = await workspace();
      assert.equal(data.activeCycleId, sourceId);
      assert.equal(data.credentials.length, 1);
      const [only] = data.credentials;
      assert.equal(only.id, sourceId);
      assert.equal(only.isCurrentCycle, true);
      assert.deepEqual(only.previousCycleIds, []);
    });

    // markSubmitted returns the submission id, not the credential id.
    await act("markSubmitted", {
      credentialId: sourceId,
      submissionDate: "2026-06-01",
      confirmationNumber: "CONF-1",
    });

    await t.test("a submitted cycle is still the current cycle", async () => {
      const data = await workspace();
      assert.equal(data.activeCycleId, sourceId);
      const submitted = data.credentials.find((credential) => credential.id === sourceId);
      assert.equal(submitted?.status, "submitted");
      assert.equal(submitted?.isCurrentCycle, true);
    });

    const successorId = await act("markRenewalAccepted", {
      credentialId: sourceId,
      acceptedAt: "2026-06-15",
      reference: "REF-1",
      nextCycleStart: "2028-01-01",
      nextDeadline: "2029-12-31",
    });
    assert.notEqual(successorId, sourceId, "acceptance opens a successor row");

    await t.test("after acceptance the successor is active and the renewed row is history under it", async () => {
      const data = await workspace();
      assert.equal(data.activeCycleId, successorId);
      const renewed = data.credentials.find((credential) => credential.id === sourceId);
      const successor = data.credentials.find((credential) => credential.id === successorId);
      assert.ok(renewed, "the renewed row stays in the flat credentials list");
      assert.ok(successor, "the successor is in the credentials list");
      assert.equal(renewed.status, "renewed");
      assert.equal(renewed.isCurrentCycle, false);
      assert.deepEqual(renewed.previousCycleIds, []);
      assert.equal(successor.status, "active");
      assert.equal(successor.isCurrentCycle, true);
      assert.deepEqual(successor.previousCycleIds, [sourceId]);
      assert.equal(successor.seriesId, renewed.seriesId, "both rows share the series");
      assert.equal(successor.previousCredentialId, sourceId);
    });
  } finally {
    database.close();
  }
});
```

- [ ] **Step 6: Run it to see it fail**

Stop any `npm run dev` on :3000 first (it shares `.wrangler/` with the build).

Run: `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH" && npm run build && node --experimental-sqlite --test tests/workspace-cycles.test.mjs`
Expected: FAIL in the first subtest — `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: undefined !== '<sourceId>'` (`data.activeCycleId` is not in the payload yet).

- [ ] **Step 7: Derive `activeCycleId`, `isCurrentCycle` and `previousCycleIds` in `getWorkspace`**

In `app/api/workspace/route.ts`, after the existing import (locate with `grep -n 'from "../../lib/reminders"' app/api/workspace/route.ts`):

```ts
import { loadReminderData } from "../../lib/reminders";
```

add:

```ts
import { activeCycleId, groupCycles, seriesKey } from "../../lib/cycles";
```

(`todayLocal` is already imported from `"../../lib/dates"` by Task 11 — confirm with `grep -n 'todayLocal' app/api/workspace/route.ts`.)

Inside `getWorkspace`, after this statement (locate with `grep -n 'const \[reminderData, draftStorageNamespace\]' app/api/workspace/route.ts`):

```ts
  const [reminderData, draftStorageNamespace] = await Promise.all([
    getReminderData(database, identity),
    createDraftStorageNamespace(identity.userId),
  ]);
```

immediately after it — before `return {` and before any `credentialResult.results.map(...)` that Task 8 hoisted out of the return, since the map body reads `seriesByKey` — add:

```ts
  // The active cycle is derived over live rows only — an archived credential
  // (Task 8) is neither Home's target nor a member of a visible series — in
  // the user's stored reminder zone, the same "today" the scheduler uses.
  const liveRows = credentialResult.results.filter(
    (credential) => !credential.archivedAt,
  );
  const today = todayLocal(reminderData.reminderPreferences.timeZone);
  const activeId = activeCycleId(liveRows, today);
  const seriesByKey = new Map(
    groupCycles(liveRows, today).map((series) => [series.seriesId, series]),
  );
```

In the credential map body — the `return { ...credential, … }` object inside `const mappedCredentials = credentialResult.results.map((credential) => { … })`, which Task 8 Step 8(c) hoisted out of the return object, so on this branch the body sits two columns shallower than at `main@8ac172a` — locate the last two properties (`grep -n 'archivedTasksByCredential.get(credential.id)' app/api/workspace/route.ts`):

```ts
      archivedTasks:
        archivedTasksByCredential.get(credential.id) ?? [],
    };
```

and insert two properties before the closing `};` so it reads:

```ts
      archivedTasks:
        archivedTasksByCredential.get(credential.id) ?? [],
      isCurrentCycle:
        seriesByKey.get(seriesKey(credential))?.current?.id ===
        credential.id,
      previousCycleIds: (
        seriesByKey.get(seriesKey(credential))?.previous ?? []
      )
        .filter((previous) => previous.id !== credential.id)
        .map((previous) => previous.id),
    };
```

(Task 8 filters this same map into `credentials` and `archivedCredentials`; both lists carry the two fields — an archived row is absent from `seriesByKey`, so it gets `false` and `[]`.)

In the returned object, immediately before the line that begins `    credentials:` (locate with `grep -n '^    credentials:' app/api/workspace/route.ts`), add:

```ts
    activeCycleId: activeId,
```

- [ ] **Step 8: Run the integration test and the two route-contract suites to see them pass**

Run: `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH" && npm run build && node --experimental-sqlite --test tests/workspace-cycles.test.mjs tests/isolation.test.mjs tests/rendered-html.test.mjs`
Expected: PASS — `tests/workspace-cycles.test.mjs` 1 test / 3 subtests green; `tests/isolation.test.mjs` unchanged (the new fields are additive and identity A's before/after snapshots are taken in the same run); `tests/rendered-html.test.mjs` unchanged (`credential-nasm-real` is still returned inside `workspace.credentials` with `status: "renewed"`).

- [ ] **Step 9: Write the failing source guard and the failing e2e spec**

Append to `tests/app-source-guards.test.mjs` (it already imports `readClientSources` from `./helpers/clientSources.mjs`, Task 1):

```js
// One spelling of "open cycle" (app-ux-04, app-ux-18). The client used to
// hand-roll `status !== "renewed"` at fourteen sites while the Home hero and
// the detail stat, which had no such guard, counted down renewed cycles.
// `isOpenCycle` / `isClosedCycle` in app/lib/cycles.ts are now the only place
// the status vocabulary is compared, so a new screen cannot grow a fifteenth.
test("the open-cycle test is spelled out only in app/lib/cycles.ts (app-ux-04, app-ux-18)", () => {
  let scanned = 0;
  for (const { file, source } of readClientSources()) {
    if (file === "lib/cycles.ts") continue;
    scanned += 1;
    assert.doesNotMatch(
      source,
      /!==\s*["']renewed["']/,
      `${file}: compare through isOpenCycle() from app/lib/cycles.ts, not against "renewed"`,
    );
  }
  assert.ok(scanned > 0, "scanned the client sources");
});
```

Create `tests/e2e/renewed-cycle-home.spec.ts` (Task 3 fixtures; a fresh identity because it saves):

```ts
import { expect, freshIdentity, test } from "./fixtures";

// app-ux-04 / app-ux-18: after a renewal was accepted, a reload put the
// renewed cycle back on Home with a live countdown (it had the soonest
// deadline of every row), and the Credentials list showed it as a sibling
// row. Home must show the successor after a reload; a renewed cycle opened
// on purpose shows when it ended instead of days; the list shows one row per
// credential with its past cycles folded underneath.
test.use({ identity: freshIdentity() });

const LOADING = '[aria-busy="true"][aria-label="Loading iTrack"]';

test("after a renewal is accepted, Home shows the successor and the renewed cycle folds under its credential", async ({ app, page }) => {
  const { id: sourceId } = await app.seedCredential();
  await app.act("markSubmitted", {
    credentialId: sourceId,
    submissionDate: "2026-06-01",
    confirmationNumber: "CONF-1",
  });
  const { id: successorId } = await app.act("markRenewalAccepted", {
    credentialId: sourceId,
    acceptedAt: "2026-06-15",
    reference: "REF-1",
    nextCycleStart: "2028-01-01",
    nextDeadline: "2029-12-31",
  });
  expect(successorId).not.toBe(sourceId);
  const workspace = await app.workspace();
  expect(workspace.activeCycleId).toBe(successorId);

  // A cold load and a reload both land on the successor: the seeded cycle
  // ends Dec 31, 2027 and the successor Dec 31, 2029.
  await app.goto("/");
  await page.reload();
  await expect(page.locator(LOADING)).toHaveCount(0, { timeout: 30_000 });
  const hero = page.getByRole("region", { name: "E2E custom credential", exact: true });
  await expect(hero).toBeVisible();
  await expect(hero).toContainText("Due Dec 31, 2029");
  await expect(hero).toContainText("days to renewal");
  await expect(hero).not.toContainText("Dec 31, 2027");
  await expect(hero).not.toContainText("days overdue");
  await expect(hero).not.toContainText("Cycle ended");

  // One row per credential, with the renewed cycle folded underneath.
  await app.goto("/credentials");
  const list = page.getByRole("region", { name: "Your credentials" });
  const row = list.getByRole("button", { name: /E2E custom credential/ });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Due Dec 31, 2029");
  const disclosure = list.locator("summary", { hasText: "1 previous cycle" });
  await expect(disclosure).toBeVisible();
  await disclosure.click();
  await list.getByRole("button", { name: /^Renewed Jun 15, 2026/ }).click();

  // The renewed cycle, opened on purpose, shows when it ended — never days.
  await expect(page).toHaveURL(new RegExp(`/credentials/${sourceId}$`));
  const pushed = page.locator(".screen-pushed");
  await expect(pushed.getByRole("heading", { level: 1, name: "E2E custom credential" })).toBeVisible();
  await expect(pushed.getByText("Cycle ended", { exact: true })).toBeVisible();
  await expect(pushed).toContainText("Renewed Jun 15, 2026");
  await expect(pushed.getByText("Time left", { exact: true })).toHaveCount(0);
  await expect(pushed.getByText("Past deadline", { exact: true })).toHaveCount(0);

  // Looking at history does not re-point Home at it.
  await page.goBack();
  await expect(page).toHaveURL(/\/credentials$/);
  await app.goto("/");
  await expect(
    page.getByRole("region", { name: "E2E custom credential", exact: true }),
  ).toContainText("Due Dec 31, 2029");
  app.expectNoErrors();
});
```

- [ ] **Step 10: Run both to see them fail**

Run: `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH" && node --experimental-sqlite --test tests/app-source-guards.test.mjs`
Expected: FAIL — the new guard reports `ITrackApp.tsx: compare through isOpenCycle() from app/lib/cycles.ts, not against "renewed"` (fourteen sites; the other five guards stay green).

Then start the dev server in a second terminal (`export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH" && npm run dev`) and run: `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH" && npm run test:e2e:desktop -- tests/e2e/renewed-cycle-home.spec.ts`
Expected: FAIL at `expect(hero).toContainText("Due Dec 31, 2029")` — the hero reads `Due Dec 31, 2027` with a countdown (the server already names the successor in `activeCycleId`, but the client still sorts every row by deadline). Leave the dev server running for Step 15.

- [ ] **Step 11: Client types, selection, and the fourteen `!== "renewed"` sites**

All edits in `app/ITrackApp.tsx`.

(a) Imports. Change the react import (lines 3-14) from:

```ts
import {
  AnimationEvent,
  ChangeEvent,
  FormEvent,
  ReactNode,
  RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
```

to:

```ts
import {
  AnimationEvent,
  ChangeEvent,
  FormEvent,
  Fragment,
  ReactNode,
  RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
```

Immediately after the `./lib/readiness` import block (locate with `grep -n 'from "./lib/readiness"' app/ITrackApp.tsx`; the block ends `} from "./lib/readiness";`) add:

```ts
import {
  cycleCountdown,
  groupCycles,
  isClosedCycle,
  isOpenCycle,
  selectDefaultCredentialId,
} from "./lib/cycles";
```

Confirm `todayLocal` is in the `./lib/dates` import list (`grep -n 'todayLocal' app/ITrackApp.tsx` — Task 11 imports it for the `today()` memo); if it is not, add `todayLocal,` to that import.

(b) `type Credential` (`grep -n 'nextCredentialId?: string | null;' app/ITrackApp.tsx` — the one inside `type Credential`). After:

```ts
  nextCredentialId?: string | null;
```

add:

```ts
  isCurrentCycle?: boolean;
  previousCycleIds?: string[];
```

(c) `type Workspace` (`grep -n '^  credentials: Credential\[\];' app/ITrackApp.tsx`). After:

```ts
  credentials: Credential[];
```

add:

```ts
  activeCycleId?: string | null;
```

(d) Default selection in `loadWorkspace` (`grep -n 'new Date(a.deadline).getTime()' app/ITrackApp.tsx`). Replace:

```ts
      setSelectedCredentialId((current) => {
        if (
          current &&
          data.credentials.some((credential) => credential.id === current)
        ) {
          return current;
        }
        return [...data.credentials].sort(
          (a, b) =>
            new Date(a.deadline).getTime() - new Date(b.deadline).getTime(),
        )[0]?.id ?? "";
      });
```

with:

```ts
      setSelectedCredentialId((current) =>
        selectDefaultCredentialId(
          data.credentials,
          current,
          data.activeCycleId ?? null,
        ),
      );
```

(e) `selectedCredential` memo (`grep -n 'const selectedCredential = useMemo' app/ITrackApp.tsx`). Replace:

```ts
  const selectedCredential = useMemo(() => {
    if (!workspace) return null;
    return (
      workspace.credentials.find(
        (credential) => credential.id === selectedCredentialId,
      ) ??
      workspace.credentials[0] ??
      null
    );
  }, [selectedCredentialId, workspace]);
```

with:

```ts
  const selectedCredential = useMemo(() => {
    if (!workspace) return null;
    return (
      workspace.credentials.find(
        (credential) => credential.id === selectedCredentialId,
      ) ??
      workspace.credentials.find(
        (credential) => credential.id === workspace.activeCycleId,
      ) ??
      null
    );
  }, [selectedCredentialId, workspace]);
```

(f) `openCredentialDetail` (`grep -n 'function openCredentialDetail' app/ITrackApp.tsx`). Replace:

```ts
  function openCredentialDetail(id: string) {
    setSelectedCredentialId(id);
    nav.push({ kind: "credential", id });
  }
```

with:

```ts
  function openCredentialDetail(id: string) {
    // A renewed cycle is viewed by URL without re-pointing the app-wide
    // selection, so Home still shows the current cycle after Back.
    const target = workspace?.credentials.find(
      (credential) => credential.id === id,
    );
    if (target && isOpenCycle(target)) setSelectedCredentialId(id);
    nav.push({ kind: "credential", id });
  }
```

(g) The thirteen single-line `X.status !== "renewed"` sites (`:1835, 1846, 2285, 2621, 2644, 4321, 7403, 7661, 7743, 8184, 8296, 8605, 8623` — `X` is `candidate` or `credential`; each sits alone on its line, e.g. `candidate.status !== "renewed",`, `credential.status !== "renewed" &&`, `{credential.status !== "renewed" ? (`). Rewrite them in one pass:

```bash
perl -pi -e 's/\b(candidate|credential)\.status !== "renewed"/isOpenCycle($1)/g' app/ITrackApp.tsx
```

(h) The fourteenth site is a status map in `RecordsView`. Locate with `grep -n 'const credentialStatusById = new Map' app/ITrackApp.tsx` (the one inside `function RecordsView(`, not the one inside `activityIsMutable`) and replace:

```ts
  const credentialStatusById = new Map(
    credentials.map((credential) => [credential.id, credential.status]),
  );
```

with:

```ts
  const openCredentialIds = new Set(
    credentials.filter(isOpenCycle).map((credential) => credential.id),
  );
```

then (`grep -n 'credentialStatusById.get' app/ITrackApp.tsx` — one hit left) replace:

```tsx
                            {credentialStatusById.get(
                              allocation.credentialId,
                            ) !== "renewed" ? (
```

with:

```tsx
                            {openCredentialIds.has(allocation.credentialId) ? (
```

(An allocation whose credential is not in the list — an archived credential after Task 8 — now reads "Historical cycle is frozen" instead of offering a classify button the server would refuse with `credential_archived`; the neighbouring `credentials.some(…)` site already treated a missing credential that way.) The `=== "renewed"` label ternaries and `activityIsMutable`'s `status === "active" || status === "submitted"` are untouched: the guard forbids only the `!==` idiom.

Verify: `grep -c '!== "renewed"' app/ITrackApp.tsx` → `0`; `grep -c 'isOpenCycle(' app/ITrackApp.tsx` → `14` (thirteen rewritten sites plus `openCredentialDetail`; Step 13 adds a fifteenth).

- [ ] **Step 12: Never count down a renewed cycle — the Home hero and the detail stat**

Still in `app/ITrackApp.tsx`.

(a) In `TodayView`, locate `grep -n 'const deadlineDays = daysUntil(credential.deadline);' app/ITrackApp.tsx` and replace that line with:

```ts
  const countdown = cycleCountdown(credential, Date.now());
```

Then locate the hero countdown (`grep -n '"days to renewal"' app/ITrackApp.tsx`) and replace:

```tsx
          <div className="deadline-row">
            <div className="deadline-number">
              <strong>{Math.abs(deadlineDays)}</strong>
              <span>
                {deadlineDays < 0
                  ? "days overdue"
                  : isCompliancePeriodCredential(credential)
                    ? "days to compliance"
                    : "days to renewal"}
              </span>
            </div>
            <div className="deadline-detail">
              <span>Due {formatDate(credential.deadline)}</span>
```

with:

```tsx
          <div
            className={
              countdown.kind === "closed"
                ? "deadline-row deadline-row-closed"
                : "deadline-row"
            }
          >
            {countdown.kind === "closed" ? (
              <div className="deadline-number deadline-number-closed">
                <strong>
                  {isCompliancePeriodCredential(credential)
                    ? "Completed"
                    : "Renewed"}
                </strong>
                <span>{formatDate(countdown.acceptedAt)}</span>
              </div>
            ) : (
              <div className="deadline-number">
                <strong>{Math.abs(countdown.days)}</strong>
                <span>
                  {countdown.kind === "overdue"
                    ? "days overdue"
                    : isCompliancePeriodCredential(credential)
                      ? "days to compliance"
                      : "days to renewal"}
                </span>
              </div>
            )}
            <div className="deadline-detail">
              <span>
                {countdown.kind === "closed"
                  ? `Cycle ended ${formatDate(credential.deadline)}`
                  : `Due ${formatDate(credential.deadline)}`}
              </span>
```

The progress track and the credits copy that follow are unchanged; `deadlineDays` had no other reader. `bestNextAction` (its `status === "renewed"` "history" branch) stays: it is reached only when a renewed cycle is deliberately selected.

(b) In `CredentialDetailScreen`, locate the first statement of its body (`grep -n 'const credentialActivities = activities.filter' app/ITrackApp.tsx`) and insert before it:

```ts
  const detailCountdown = cycleCountdown(credential, Date.now());
```

Then locate the stat (`grep -n '"Time left"' app/ITrackApp.tsx`) and replace:

```tsx
          <div>
            <span>
              {daysUntil(credential.deadline) < 0
                ? "Past deadline"
                : "Time left"}
            </span>
            <strong>{Math.abs(daysUntil(credential.deadline))}</strong>
            <small>
              {daysUntil(credential.deadline) < 0
                ? "days overdue"
                : "days"}
            </small>
          </div>
```

with:

```tsx
          {detailCountdown.kind === "closed" ? (
            <div>
              <span>Cycle ended</span>
              <strong>{formatDate(credential.deadline)}</strong>
              <small>
                {isCompliancePeriodCredential(credential)
                  ? "Completed"
                  : "Renewed"}{" "}
                {formatDate(detailCountdown.acceptedAt)}
              </small>
            </div>
          ) : (
            <div>
              <span>
                {detailCountdown.kind === "overdue"
                  ? "Past deadline"
                  : "Time left"}
              </span>
              <strong>{Math.abs(detailCountdown.days)}</strong>
              <small>
                {detailCountdown.kind === "overdue" ? "days overdue" : "days"}
              </small>
            </div>
          )}
```

(`daysUntil` still has readers in `bestNextAction` and the task-overdue check, so it stays.)

(c) In `app/globals.css`, after this block (`grep -n '^\.deadline-number span {' app/globals.css`):

```css
.deadline-number span {
  display: block;
  margin-top: 10px;
  color: var(--on-dark-faint);
  font-size: var(--text-2xs);
  font-weight: 700;
  text-transform: uppercase;
}
```

add:

```css
/*
 * A renewed cycle has no countdown. The hero's number slot carries the word
 * "Renewed" (or "Completed") over the acceptance date instead, so the row
 * lets that cell size to its content rather than to the digit column. Two
 * classes on purpose: the phone breakpoints re-declare `.deadline-row` and
 * `.deadline-number strong` further down, and these must still win there.
 */
.deadline-row.deadline-row-closed {
  grid-template-columns: auto minmax(0, 1fr);
}

.deadline-number.deadline-number-closed strong {
  font-size: 30px;
  letter-spacing: -0.02em;
  line-height: 1.05;
}
```

- [ ] **Step 13: One row per credential in `CredentialsView`, past cycles folded underneath**

In `app/ITrackApp.tsx`, replace the whole of `function CredentialsView(` (from `grep -n '^function CredentialsView(' app/ITrackApp.tsx` down to the closing `}` before the `/*` comment that precedes `function CredentialDetailScreen(`) with the three functions below. `CredentialsView` keeps its name and stays above `CredentialDetailScreen`.

```tsx
function cycleStatusLabel(credential: Credential) {
  if (isClosedCycle(credential)) return "history";
  if (
    credential.status === "submitted" &&
    isIsc2AutomaticRenewalCredential(credential)
  ) {
    return "awaiting ISC2 renewal";
  }
  if (
    credential.status === "submitted" &&
    isCompliancePeriodCredential(credential)
  ) {
    return "compliance recorded";
  }
  return credential.status;
}

function cycleCountdownLabel(credential: Credential) {
  const countdown = cycleCountdown(credential, Date.now());
  if (countdown.kind === "closed") {
    return `Renewed ${formatDate(countdown.acceptedAt)}`;
  }
  return `${Math.abs(countdown.days)} days ${
    countdown.kind === "overdue" ? "overdue" : "left"
  }`;
}

function CredentialsView({
  credentials,
  selectedId,
  onSelect,
  onAdd,
}: {
  credentials: Credential[];
  selectedId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  // One row per credential: its current cycle (or, for a credential whose
  // every cycle is renewed, the newest of them) with the renewed cycles folded
  // underneath. Grouping is by series; which member is current comes from the
  // server's `isCurrentCycle` when the payload carries it, so the list agrees
  // with Home even when the device and stored zones straddle midnight.
  const series = groupCycles(credentials, todayLocal(deviceTimeZone())).map(
    (entry) => ({
      ...entry,
      current:
        entry.members.find((member) => member.isCurrentCycle) ??
        entry.current,
    }),
  );
  // The highlight marks the credential the rest of the app is pointed at —
  // Today's card, the log sheet's default — not a detail pane beside the list,
  // which now lives on its own pushed screen.
  const activeId =
    credentials.find((credential) => credential.id === selectedId)?.id ??
    series[0]?.current?.id ??
    "";
  return (
    <div className="view-stack">
      <PageGreeting
        eyebrow="Credentials"
        title="Every renewal, one clear place."
        body="Requirements, sources, cycles, and submission status stay connected."
        action={
          <button className="button button-primary" type="button" onClick={onAdd}>
            <Icon name="plus" size={16} />
            Add credential
          </button>
        }
      />
      {credentials.length ? (
        <section
          className="credential-picker credential-list"
          aria-label="Your credentials"
        >
          {series.map((entry) => {
            const lead = entry.current ?? entry.previous[0];
            if (!lead) return null;
            const pastCycles = entry.previous.filter(
              (previous) => previous.id !== lead.id,
            );
            return (
              <Fragment key={entry.seriesId}>
                <button
                  className={lead.id === activeId ? "active" : ""}
                  type="button"
                  onClick={() => onSelect(lead.id)}
                >
                  <span>
                    <strong>{lead.credentialName}</strong>
                    <small>
                      {lead.jurisdiction} · {cycleStatusLabel(lead)}
                      {isOpenCycle(lead)
                        ? ` · Due ${formatDate(lead.deadline)} · ${cycleCountdownLabel(lead)}`
                        : ` · ${cycleCountdownLabel(lead)}`}
                    </small>
                  </span>
                  <span className="picker-progress">
                    {lead.totalRequired > 0
                      ? `${credentialProgress(lead)}%`
                      : `${readinessScore(lead)}% ready`}
                  </span>
                </button>
                {pastCycles.length ? (
                  <details className="archived-items previous-cycles">
                    <summary>
                      <span>
                        {pastCycles.length} previous{" "}
                        {pastCycles.length === 1 ? "cycle" : "cycles"}
                      </span>
                      <span className="disclosure-chevron">
                        <Icon name="chevronDown" size={16} />
                      </span>
                    </summary>
                    <div className="archived-item-list">
                      {pastCycles.map((previous) => (
                        <button
                          className="archived-item"
                          type="button"
                          key={previous.id}
                          onClick={() => onSelect(previous.id)}
                        >
                          <strong>Renewed {formatDate(previous.acceptedAt)}</strong>
                          <small>
                            {formatDate(previous.cycleStart)} –{" "}
                            {formatDate(previous.deadline)} ·{" "}
                            {credentialProgress(previous)}%
                          </small>
                        </button>
                      ))}
                    </div>
                  </details>
                ) : null}
              </Fragment>
            );
          })}
          <button className="add-picker" type="button" onClick={onAdd}>
            <Icon name="plus" size={15} />
            Add another credential
          </button>
        </section>
      ) : (
        <EmptyPage
          title="Add your first credential"
          body="Choose a source-linked rule template or make a custom plan from your credential information."
          action="Set up credential"
          onAction={onAdd}
        />
      )}
    </div>
  );
}
```

The lead `<button>` and the `<details>` are both direct children of `.credential-picker`, so the existing `.credential-picker > button` rules and the grid gap still apply. In `app/globals.css`, after this block (`grep -n '^\.archived-item-state {' app/globals.css`; it is followed by `.archived-tasks {`):

```css
.archived-item-state {
  color: var(--ink-quiet);
  font-size: var(--text-xs);
  font-weight: 800;
}
```

add:

```css
/*
 * A credential's past cycles fold under its row on the Credentials list with
 * the same disclosure the History tab uses for archived records (the element
 * carries both classes). Each past cycle is a button that opens that cycle's
 * preserved record, so the row resets the button chrome and stacks its two
 * lines in one column.
 */
.previous-cycles {
  box-shadow: none;
}

.previous-cycles .archived-item {
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--line-soft);
  border-radius: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  gap: 0;
  grid-template-columns: minmax(0, 1fr);
  text-align: left;
}

.previous-cycles .archived-item:last-child {
  border-bottom: 0;
}
```

(`transparent` is not a literal for `tools/contrast-audit.mjs`; every colour above is a token.)

- [ ] **Step 14: Run the guard, typecheck and lint to see them pass**

Run: `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH" && node --experimental-sqlite --test tests/app-source-guards.test.mjs && npm run typecheck && npm run lint`
Expected: PASS (all guards, including the new one) / silent / PASS. If `typecheck` reports `Fragment` or `todayLocal` as not found, Step 11(a) was skipped.

- [ ] **Step 15: Run the e2e suite to see it pass**

With the dev server from Step 10 still running (`vinext dev` reloads the client and `route.ts` edits), run: `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH" && npm run test:e2e`
Expected: PASS on all four projects — `renewed-cycle-home.spec.ts` (1 test × 4 projects) plus every earlier spec (Tasks 3, 4, 10, 11) still green. Then stop the dev server (Ctrl-C in its terminal).

- [ ] **Step 16: Full gate**

Run (no dev server on :3000): `export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH" && npm test && npm run typecheck && npm run lint`
Expected: PASS — `tests/*.test.mjs` now includes `tests/cycles.test.mjs` (11) and `tests/workspace-cycles.test.mjs` (1 test, 3 subtests) alongside `tests/app-source-guards.test.mjs`, `tests/isolation.test.mjs` and `tests/rendered-html.test.mjs`; `grep -rn '!== "renewed"' app` returns nothing.

- [ ] **Step 17: Commit**

```bash
git branch --show-current   # must print feat/wave2-foundation
git add app/lib/cycles.ts app/api/workspace/route.ts app/ITrackApp.tsx app/globals.css package.json tests/cycles.test.mjs tests/workspace-cycles.test.mjs tests/app-source-guards.test.mjs tests/e2e/renewed-cycle-home.spec.ts
git commit -m "feat: derive the active cycle in getWorkspace, never count down a renewed cycle, group past cycles under the credential (app-ux-04, app-ux-18)

getWorkspace returns activeCycleId (earliest open cycle due today or later,
else the most recently opened) plus isCurrentCycle/previousCycleIds per row;
the client keeps a selection only while it is open, the hero and the detail
stat show Renewed/Cycle ended instead of days for a renewed cycle, and the
Credentials list shows one row per series with past cycles in a disclosure.
app/lib/cycles.ts is the only place the status vocabulary is compared.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

---

### Task 13: Gates, Docker run-check, merge, live verification

**Rationale:** spec §2 row "2 Foundation" — gate to finish is "tests green incl. isolation suite; live verification" — and spec §9 Deploy: "Docker build + run-check locally before every merge; live smoke (curl matrix + Playwright login) after every deploy." Spec §8: the only schema change this wave is `drizzle/0014_credential_archive.sql` (Task 8) and there is no identity change, so Chris's data under `christophertskerritt@gmail.com` is untouched; what the live Railway volume actually executes is `db/runtime.ts` `initializeDatabase` (line 5968) → `ensureRichRuleColumns` (line 5619), which `ALTER TABLE credentials ADD COLUMN revision` / `archived_at` on the existing table — so this task proves that upgrade path on a Wave 1-shaped volume *before* pushing, not after. Pushes to `main` auto-deploy to Railway (project iTrack, service `itrack`, environment `production`, live at https://itrackceu.com, currently deployment `3a89e2f8` at `8ac172a`).

**Files:**
- No source changes. Modify (docs only, Step 5, committed on the branch): `docs/superpowers/specs/2026-09-10-itrack-web-redesign-design.md` §4 bullets 2 and 5, so the approved spec describes the shipped contract. Produces: merged `main`, live itrackceu.com, memory note.
- Scratch only (outside the repo, in the session scratchpad): `wave2-runcheck.sh`, `ops-password.txt`, `session-secret.txt` — deleted at the end of Step 3.

**Interfaces:**
- Consumes: every previous task. Concretely, the checks below rely on: Task 2 (`grep -rn push_subscription_conflict app tests` → 0); Task 3's `CustomCredentialPayload` defaults (`{ credentialName, profession: "Counseling", jurisdiction: "Rhode Island", issuer: "E2E board", totalRequired: 10, unitLabel: "hours", cycleStart: "2026-01-01", deadline: "2027-12-31", categories: [{ name: "General", requiredUnits: 10 }] }`); Task 4/10/11/12's eleven `tests/e2e/*.spec.ts` files and Task 3's four Playwright projects; Task 5's `build:lib-test` script and `npm test`; Task 6's `node tools/contrast-audit.mjs` exit code and `tests/contrast-audit.test.mjs`; Task 7's `.dockerignore` `.vinext` line, `tests/protected-identifiers.test.mjs`, `tests/dist-hygiene.test.mjs`, `grep -rn "hapticTap\|Capacitor" app tests` → 0; Task 8's `getWorkspace` split (`credentials[]` with `revision: number`, `archivedAt: null`; `archivedCredentials[]` with `archivedAt: string`) and migration `0014_credential_archive` (journal idx 14); Task 9's actions `updateCredential`, `archiveCredential`, `restoreCredential`, `deleteCredential` and codes `credential_version_conflict` (409, "This credential changed in another session. Refresh and try again."), `credential_name_mismatch` (400, "Type the credential name exactly as shown to confirm deletion."), `credential_not_found` (404, "Credential not found."); Task 11's `todayLocal(zone)` defaults, the banner ("Your device is in America/New_York" / button "Use America/New_York") and the Profile line "Times use America/New_York."; Task 12's `activeCycleId: string | null` and per-credential `isCurrentCycle: boolean`.
- Produces: the Wave 2 live commit hash (`$WAVE2`, the merge commit on `main`) recorded in memory for Wave 3 (`main` at that hash is Wave 3's base).

- [ ] **Step 1: Full local gates on the branch**

Run from the checkout that holds the branch (the build workflow uses the worktree `/Users/chrisskerritt/Documents/New project/Vigilo-wt/wave2`; `git worktree list` shows which path has `[feat/wave2-foundation]`). Another session may share the tree, so the branch and a clean status are checked first.

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
git worktree list                                   # note the path that carries [feat/wave2-foundation]
cd "<that path>"
git branch --show-current                           # feat/wave2-foundation
git status --porcelain                              # empty — stop and ask if not
git fetch origin && git rev-parse --short origin/main   # 8ac172a — if main moved, `git merge main`, then re-run this whole step and Step 2 before continuing
git rev-list --count main..feat/wave2-foundation    # the Wave 2 task commits (>= 12)
git log main..feat/wave2-foundation --format=%B | grep -c '^Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk$'   # equals the count above: every commit carries the trailer
lsof -nP -iTCP:3000 -sTCP:LISTEN || echo "port 3000 free"   # must be free: the build clobbers .wrangler/ under a running dev server
```

Cross-task acceptance greps (each is an interface promised by an earlier task; all must hold on the branch tip):

```bash
grep -rn "push_subscription_conflict" app tests | wc -l                              # 0  (Task 2)
grep -rn "hapticTap\|Capacitor" app tests | wc -l                                    # 0  (Task 7)
grep -rln 'new Date().toISOString().slice(0, 10)' app | wc -l                        # 0  (Task 11)
grep -rn 'const todayIso' app | wc -l                                                # 0  (Task 11)
grep -c '^\.vinext$' .dockerignore                                                   # 1  (Task 7)
jq -r '.entries[-1] | "\(.idx) \(.tag)"' drizzle/meta/_journal.json                 # 14 0014_credential_archive  (Task 8)
node -e 'const s=require("./package.json").scripts; console.log(s["build:lib-test"] ? "build:lib-test ok" : "MISSING"); console.log(s.test)'
# build:lib-test ok
# npm run build && npm run build:lib-test && node --experimental-sqlite --test tests/*.test.mjs   (Task 5)
ls tests/e2e   # credential-detail.spec.ts credential-edit-archive-delete.spec.ts credentials.spec.ts fixtures.ts history.spec.ts home.spec.ts local-dates.spec.ts log-activity.spec.ts packet.spec.ts profile.spec.ts renewed-cycle-home.spec.ts session-ended-mid-save.spec.ts
```

Then the gates:

```bash
npm run typecheck && npm run lint && npm test 2>&1 | tee "$HOME/Desktop/wave2-npm-test.log" | tail -40
```
Expected: `typecheck` and `lint` exit 0 with no output; `npm test` builds, runs `build:lib-test`, then the `node --test` summary ends with `fail 0` and `cancelled 0`. Confirm the new files ran:

```bash
for f in isolation protected-identifiers dist-hygiene contrast-audit workspace-credential-actions workspace-cycles dates cycles certificate-ocr activity-draft readiness; do printf '%-32s ' "tests/$f.test.mjs"; grep -c "tests/$f.test.mjs" "$HOME/Desktop/wave2-npm-test.log"; done
```
Expected: every line prints a count ≥ 1 (each file appears in the run output). Then:

```bash
node tools/contrast-audit.mjs; echo "exit $?"        # per-file report, last line: exit 0
ls dist/client/assets/_vinext_fonts                  # ls: dist/client/assets/_vinext_fonts: No such file or directory
rm -f "$HOME/Desktop/wave2-npm-test.log"
```
If `ls` lists `.woff2` files instead, this machine still carries the gitignored `.vinext/fonts` cache: `rm -rf .vinext/fonts && npm run build`, then repeat `ls`; `tests/dist-hygiene.test.mjs` would have failed for the same reason.

Playwright, all four projects, against the dev server (start it now; it is stopped again before anything else builds):

```bash
npm run dev > "$HOME/Desktop/wave2-dev.log" 2>&1 &
curl -sf --retry 60 --retry-delay 2 --retry-all-errors --retry-connrefused -o /dev/null http://localhost:3000/ && echo "dev server ready"
npm run test:e2e 2>&1 | tail -60
```
Expected: the list reporter shows every spec file — `home`, `credentials`, `credential-detail`, `log-activity`, `history`, `profile`, `packet`, `session-ended-mid-save`, `credential-edit-archive-delete`, `local-dates`, `renewed-cycle-home` — under all four projects (`desktop-light`, `phone-dark`, `desktop-dark`, `phone-light`), and the summary line reads `N passed` with no `failed`, `flaky` or `skipped` count. Stop the server:

```bash
kill "$(lsof -t -nP -iTCP:3000 -sTCP:LISTEN)"; rm -f "$HOME/Desktop/wave2-dev.log"
lsof -nP -iTCP:3000 -sTCP:LISTEN || echo "port 3000 free"
```

- [ ] **Step 2: Docker build + run-check on a fresh volume (Wave 1 matrix + the Wave 2 actions through the gateway)**

`SCRATCH` below is the session scratchpad directory from the executor's system prompt (in the authoring session: `/private/tmp/claude-501/-Users-chrisskerritt/3ee5dc17-4860-4b7b-ac89-45188d184a50/scratchpad`). Shell state does not persist between tool calls, so the throwaway password and the session secret live in `chmod 600` scratch files for the duration of Steps 2–3 and are deleted at the end of Step 3; the checks live in one script so a single call runs them.

Save the script as `$SCRATCH/wave2-runcheck.sh`:

```bash
#!/usr/bin/env bash
# Wave 2 run-check. Modes:
#   matrix  — the Wave 1 gateway matrix, no login (25 checks)          usable against production
#   seed    — login + GET /api/workspace (3 checks)                     runs initializeDatabase + ensureUser
#   actions — seed + every Wave 2 action through the gateway (21)      NEVER against production (creates/deletes data, rewrites the time zone)
#   all     — matrix + actions (46)
# Usage: B=http://localhost:8080 OPS_PASSWORD=... bash wave2-runcheck.sh <mode>
set -u
B="${B:?set B, e.g. http://localhost:8080}"
MODE="${1:-all}"
TMP="$(mktemp -d)"
PASS=0; FAIL=0; C=""; ID=""
ok()    { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
bad()   { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n      got: %s\n' "$1" "$2"; }
check() { if printf '%s' "$3" | grep -qE -- "$2"; then ok "$1"; else bad "$1" "$3"; fi; }   # check <label> <ERE> <actual>
same()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$3"; fi; }                       # same  <label> <expected> <actual>
hdr()   { curl -si "$@" | tr -d '\r'; }                                                      # status line + headers + body
head_() { curl -sI "$@" | tr -d '\r'; }                                                      # HEAD: status line + headers
code()  { curl -s -o /dev/null -w '%{http_code}' "$@"; }

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
  matrix)  run_matrix ;;
  seed)    run_login; run_workspace ;;
  actions) run_login; run_workspace; run_actions ;;
  all)     run_matrix; run_login; run_workspace; run_actions ;;
  *) echo "unknown mode: $MODE"; rm -rf "$TMP"; exit 2 ;;
esac
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
rm -rf "$TMP"
[ "$FAIL" -eq 0 ]
```

Build and boot on a fresh volume (Docker Desktop must be running: `docker info >/dev/null && echo docker ok`):

```bash
cd "<the feat/wave2-foundation checkout from Step 1>"
SCRATCH="<session scratchpad directory>"
docker build -t itrack-wave2 .                       # from the working tree; .dockerignore now excludes .vinext (Task 7) as well as node_modules/dist/.wrangler
docker volume create itrack-wave2-data
umask 077
openssl rand -base64 18 > "$SCRATCH/ops-password.txt"    # throwaway, 24 chars (bootstrap minimum is 10); deleted in Step 3
openssl rand -hex 32   > "$SCRATCH/session-secret.txt"
docker run -d --name itrack-wave2 -p 8080:8080 \
  -v itrack-wave2-data:/data \
  -e AUTH_SESSION_SECRET="$(cat "$SCRATCH/session-secret.txt")" \
  -e PUBLIC_BASE_URL="http://localhost:8080" \
  -e AUTH_BOOTSTRAP_USERS="ops@example.test:$(cat "$SCRATCH/ops-password.txt")" \
  itrack-wave2
curl -sf --retry 40 --retry-delay 3 --retry-all-errors --retry-connrefused -o /dev/null http://localhost:8080/healthz && echo ready
docker logs itrack-wave2 2>&1 | grep -E 'bootstrap|gateway listening'
docker logs itrack-wave2 2>&1 | grep -c -- "$(cat "$SCRATCH/ops-password.txt")"
docker logs itrack-wave2 2>&1 | grep -iE 'error|duplicate column|no such column' || echo "no errors in the boot log"
```
Expected: `ready`; then exactly two matching log lines — `[auth] bootstrap created account ops@example.test` and `iTrack gateway listening on :8080 (session-cookie auth, self-serve signup enabled), state in /data/wrangler-state`; then `0` (the password never reaches the log); then `no errors in the boot log`. (The gateway only listens after the worker answers `/manifest.webmanifest`, so a 200 from `/healthz` means bootstrap has already run.)

Run the matrix and the actions:

```bash
B=http://localhost:8080 OPS_PASSWORD="$(cat "$SCRATCH/ops-password.txt")" bash "$SCRATCH/wave2-runcheck.sh" all
```
Expected: 46 `PASS` lines and the summary `46 passed, 0 failed` (exit 0). A `FAIL` line prints what was received; stop there — the branch is not mergeable until it passes.

Dead-font and restart checks:

```bash
docker exec itrack-wave2 find /app/dist -name '*.woff2'                                        # no output
docker exec itrack-wave2 sh -c 'test ! -e /app/dist/client/assets/_vinext_fonts && echo "no _vinext_fonts in the image"'
docker restart itrack-wave2
curl -sf --retry 40 --retry-delay 3 --retry-all-errors --retry-connrefused -o /dev/null http://localhost:8080/healthz && echo ready
docker logs itrack-wave2 2>&1 | grep bootstrap                                                   # boot 1: created …; boot 2: [auth] bootstrap skipped existing account ops@example.test
B=http://localhost:8080 OPS_PASSWORD="$(cat "$SCRATCH/ops-password.txt")" bash "$SCRATCH/wave2-runcheck.sh" seed   # 3 passed, 0 failed — the auth DB and the D1 volume survived the restart
docker rm -f itrack-wave2 && docker volume rm itrack-wave2-data
```

- [ ] **Step 3: Upgrade-path check on a Wave 1-shaped volume (what the live volume will go through)**

The live volume was created by pre-Wave 2 code, so its `credentials` table has no `revision`/`archived_at`; `ensureRichRuleColumns` must add them on the first Wave 2 boot. Reproduce that: boot the Wave 1 image (`main` at `8ac172a`) on a fresh volume, log in and load the workspace once (that request is what runs `initializeDatabase` + `ensureUser` — a bare boot only serves static assets), then boot the Wave 2 image on the same volume.

```bash
cd "/Users/chrisskerritt/Documents/New project/Vigilo"      # any checkout that has 8ac172a
SCRATCH="<session scratchpad directory>"
docker image inspect itrack-wave1 >/dev/null 2>&1 && docker tag itrack-wave1 itrack-wave1-base \
  || git archive 8ac172a | docker build -t itrack-wave1-base -      # the Wave 1 run-check image if it still exists, else build the exact live commit from a git tarball
docker volume create itrack-wave2-upgrade
docker run -d --name itrack-wave1-base -p 8080:8080 \
  -v itrack-wave2-upgrade:/data \
  -e AUTH_SESSION_SECRET="$(cat "$SCRATCH/session-secret.txt")" \
  -e PUBLIC_BASE_URL="http://localhost:8080" \
  -e AUTH_BOOTSTRAP_USERS="ops@example.test:$(cat "$SCRATCH/ops-password.txt")" \
  itrack-wave1-base
curl -sf --retry 40 --retry-delay 3 --retry-all-errors --retry-connrefused -o /dev/null http://localhost:8080/healthz && echo ready
B=http://localhost:8080 OPS_PASSWORD="$(cat "$SCRATCH/ops-password.txt")" bash "$SCRATCH/wave2-runcheck.sh" seed   # 3 passed, 0 failed — Wave 1 schema now exists on the volume
docker rm -f itrack-wave1-base
docker run -d --name itrack-wave2-upgrade -p 8080:8080 \
  -v itrack-wave2-upgrade:/data \
  -e AUTH_SESSION_SECRET="$(cat "$SCRATCH/session-secret.txt")" \
  -e PUBLIC_BASE_URL="http://localhost:8080" \
  -e AUTH_BOOTSTRAP_USERS="ops@example.test:$(cat "$SCRATCH/ops-password.txt")" \
  itrack-wave2
curl -sf --retry 40 --retry-delay 3 --retry-all-errors --retry-connrefused -o /dev/null http://localhost:8080/healthz && echo ready
docker logs itrack-wave2-upgrade 2>&1 | grep -E 'bootstrap|gateway listening'     # [auth] bootstrap skipped existing account ops@example.test + the listening line
B=http://localhost:8080 OPS_PASSWORD="$(cat "$SCRATCH/ops-password.txt")" bash "$SCRATCH/wave2-runcheck.sh" actions
docker logs itrack-wave2-upgrade 2>&1 | grep -iE 'error|duplicate column|no such column' || echo "no errors after the column upgrade"
```
Expected: `21 passed, 0 failed` — `createCredential` returns `revision: 1` and `archiveCredential`/`restoreCredential` work, which is only possible if the two columns were added to the pre-existing table — and `no errors after the column upgrade`. Clean up everything from Steps 2–3:

```bash
docker rm -f itrack-wave2-upgrade && docker volume rm itrack-wave2-upgrade
docker rmi itrack-wave1-base itrack-wave2      # optional; keeps the disk tidy
rm -f "$SCRATCH/ops-password.txt" "$SCRATCH/session-secret.txt"
docker ps -a --filter name=itrack- --format '{{.Names}}'   # nothing
```

- [ ] **Step 4: Railway pre-flight (nothing to set — confirm the target and record the baseline)**

No env var is added or removed this wave (`AUTH_BOOTSTRAP_USERS`, `PUBLIC_BASE_URL`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` and whatever else is set stay as they are). Two gotchas from Wave 1: the `railway` binary on the Node-22 `PATH` is an unauthenticated copy — call `/Users/chrisskerritt/.homebrew/bin/railway` by full path; and the CLI's project link is per-directory — run it from the linked main checkout, never from the worktree, and pass `--service itrack --environment production` anyway.

```bash
R=/Users/chrisskerritt/.homebrew/bin/railway
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
$R status 2>/dev/null | grep -E '^(Project|Environment):'                        # Project: iTrack / Environment: production
$R variables --service itrack --environment production --json | jq -r 'keys[]' | grep -vE '^RAILWAY_' | tee "$HOME/Desktop/wave2-railway-keys-before.txt"
# AUTH_BOOTSTRAP_USERS PUBLIC_BASE_URL VAPID_PRIVATE_KEY VAPID_PUBLIC_KEY VAPID_SUBJECT (one per line; keys only — never print values)
$R deployment list --service itrack --environment production --limit 1 --json | jq -c '.[0] | {id, status, commit: .meta.commitHash[0:7], branch: .meta.branch}'
# {"id":"3a89e2f8-19b8-407e-8f6d-91cfd3af10eb","status":"SUCCESS","commit":"8ac172a","branch":"main"}   (the Wave 1 deployment)
curl -s -o /dev/null -w '%{http_code}\n' https://itrackceu.com/healthz            # 200 — the current deployment is healthy before we replace it
```

- [ ] **Step 5: Merge and deploy**

First, one docs-only commit on the branch, so the approved spec describes the contract this wave ships rather than the two deliberate deviations recorded only in this plan (Tasks 1/2: push endpoints are browser-issued capability URLs, not ids, so `savePushSubscription` answers a neutral 409 and `removePushSubscription` an idempotent 200 — "never data" is proven by the fingerprint subtest; Task 11: the seed literal `UTC` is treated as "unset"). From the checkout that holds `feat/wave2-foundation` (the path noted in Step 1), edit `docs/superpowers/specs/2026-09-10-itrack-web-redesign-design.md`:

1. §4 bullet 2 (Two-identity isolation suite) — replace `(404, never data)` with `(404 — or, for push endpoints, which are browser-issued capability URLs rather than ids, a neutral 409 on save and an idempotent 200 on remove — never data)`.
2. §4 bullet 5 (Local dates and device time zone) — replace `every default date uses the user's reminder time zone;` with `every default date uses the user's reminder time zone (the seed literal \`UTC\` counts as unset and falls back to the device zone);`.

```bash
cd "<the feat/wave2-foundation checkout from Step 1>"
git branch --show-current                                                                                                  # feat/wave2-foundation
grep -c "a neutral 409 on save and an idempotent 200 on remove" docs/superpowers/specs/2026-09-10-itrack-web-redesign-design.md   # 1
grep -c "counts as unset and falls back to the device zone" docs/superpowers/specs/2026-09-10-itrack-web-redesign-design.md      # 1
git diff --stat                                                                                                            # 1 file changed, 2 insertions(+), 2 deletions(-)
git add docs/superpowers/specs/2026-09-10-itrack-web-redesign-design.md
git commit -m "docs(spec): §4 records the shipped push-endpoint refusals and the UTC-as-unset zone rule

savePushSubscription answers a neutral 409 and removePushSubscription an
idempotent 200 for a foreign endpoint (capability URLs, not ids; never data —
tests/isolation.test.mjs), and the seed literal UTC counts as an unset zone
(app/lib/dates.ts effectiveDateZone). Both were decided in the Wave 2 plan.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
```

Then, from the linked main checkout (the branch may be checked out in the worktree; merging it from here is fine — only a second checkout is refused).

```bash
export PATH="$HOME/.local/node/node-v22.22.0-darwin-arm64/bin:$PATH"
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
git branch --show-current            # main
git status --porcelain               # empty — another session may share this tree; stop and ask if not
git pull --ff-only
git rev-parse --short HEAD           # 8ac172a (if it moved, go back to Step 1's "if main moved" rule before merging)
git merge --no-ff feat/wave2-foundation -m "Merge feat/wave2-foundation: isolation suite, behavioural e2e, iOS residue sweep, credential edit/archive/delete, local dates, current-cycle selection

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VToavJMqYSQkJG4MRunbBk"
git push origin main
WAVE2="$(git rev-parse --short HEAD)"; echo "Wave 2 live commit: $WAVE2"; git log --oneline -1 origin/main    # same hash
```

Watch the Railway deployment until it is `SUCCESS` for `$WAVE2` (a build takes several minutes; poll, do not stream):

```bash
R=/Users/chrisskerritt/.homebrew/bin/railway
$R deployment list --service itrack --environment production --limit 1 --json | jq -c '.[0] | {id, status, commit: .meta.commitHash[0:7]}'
```
Expected, eventually: `{"id":"<DEP>","status":"SUCCESS","commit":"<the $WAVE2 hash>"}` (`BUILDING` → `DEPLOYING` → `SUCCESS`). Then the boot log of that deployment must show a clean migration:

```bash
DEP="<id from the line above>"
$R logs "$DEP" --service itrack --environment production --deployment --lines 300 | grep -E 'gateway listening|bootstrap|rror|duplicate column|no such column|Refusing to start'
```
Expected: `[auth] bootstrap skipped existing account christophertskerritt@gmail.com`, `iTrack gateway listening on :8080 (session-cookie auth, self-serve signup enabled), state in /data/wrangler-state`, and nothing else (no error, no `duplicate column`, no `no such column` — `initializeDatabase` adds `revision`/`archived_at` to the existing volume through `ensureRichRuleColumns` on the first API request, exactly as Step 3 rehearsed).

If the status becomes `FAILED` or `CRASHED`, do not re-deploy by hand: `git revert -m 1 "$WAVE2" && git push origin main` puts the Wave 1 code back on the next deploy (Wave 1 code never selects the two new columns, so a partially upgraded volume is harmless to it), then read `$R logs "$DEP" --service itrack --environment production --build --lines 300` and fix on the branch.

- [ ] **Step 6: Live verification on itrackceu.com**

curl first (no credentials involved — `wave2-runcheck.sh matrix` never logs in; never run `actions` against production):

```bash
SCRATCH="<session scratchpad directory>"
B=https://itrackceu.com bash "$SCRATCH/wave2-runcheck.sh" matrix                                # 25 passed, 0 failed
curl -sI https://itrackceu.com/ | grep -iE 'strict-transport|x-frame|content-security'          # the three headers
curl -s -o /dev/null -w '%{http_code}\n' 'https://itrackceu.com/api/export/packet?credentialId=not-mine' -H 'accept: application/json'   # 401 — the gateway answers before the worker; the ownership 404 behind it was proved by tests/isolation.test.mjs and by Step 2/3's cookie-bearing probe
R=/Users/chrisskerritt/.homebrew/bin/railway
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
$R variables --service itrack --environment production --json | jq -r 'keys[]' | grep -vE '^RAILWAY_' | diff "$HOME/Desktop/wave2-railway-keys-before.txt" - && echo "env unchanged"
rm -f "$HOME/Desktop/wave2-railway-keys-before.txt"
```

Browser (Chris logs in at https://itrackceu.com/login; his password never goes in a shell; the throwaway credential below is deleted again so his data is left as found — only the time-zone choice is meant to persist):

1. `/credentials` before login → `/login?next=%2Fcredentials`; after login lands on `/credentials`; Home shows the existing data (identity hash unchanged, spec §8). A user with no credentials sees the empty state "Add your first credential" — not an error.
2. Time-zone banner (Task 11): if the stored zone is still the seed default `UTC`, a banner "Your device is in America/New_York" with the button "Use America/New_York" appears once (Chris's device zone; a different device zone shows that name). Tap it → the banner disappears; reload → no banner; Profile reads "Times use America/New_York." (If Chris had already chosen a zone in Manage reminders, no banner is expected and Profile already names that zone — record which case it was.)
3. Credentials → "Add credential" → custom credential named `Wave 2 check` (profession/jurisdiction/units of Chris's choosing) → it opens in the detail screen at `/credentials/<id>`.
4. Detail → "Edit credential" → rename to `Wave 2 check renamed` → save → the heading shows the new name.
5. Detail → "Archive credential" → the app returns to Credentials and the credential is gone from the list and from Home.
6. History → "Archived credentials" disclosure → the row `Wave 2 check renamed` → "Restore" → it is back in Credentials.
7. Detail → "Delete credential…" → the confirm button stays disabled until `Wave 2 check renamed` is typed exactly → "Delete permanently" → back on Credentials without it; reload → still absent.
8. "Log activity" → the completion date input defaults to today's date in America/New_York (compare with the device clock; before Wave 2 this was the UTC date, so after ~8 pm EDT it was tomorrow). Close the sheet without saving.
9. If Chris's data contains a renewed cycle: Home shows the open successor cycle (no "days to renewal" countdown on a renewed cycle) and the Credentials list groups the closed cycle under its credential's "previous cycle" disclosure instead of listing it as a sibling. If no renewed cycle exists, note "no renewed cycle in live data — grouping verified by tests/e2e/renewed-cycle-home.spec.ts only".
10. Profile → Sign out → back on `/`; `curl -s -o /dev/null -w '%{http_code}\n' https://itrackceu.com/api/workspace -H 'accept: application/json'` → 401.

Railway logs after the browser pass contain no `CEU workspace API error` line:

```bash
$R logs --service itrack --environment production --deployment --lines 300 | grep -c 'CEU workspace API error'   # 0
```

- [ ] **Step 7: Hand-offs and memory**

Append to `/Users/chrisskerritt/.claude/projects/-Users-chrisskerritt/memory/project_itrack_web_redesign_2026_09_10.md` (fill `$WAVE2`, `<DEP>`, the date/time, and the banner case observed in Step 6):

```markdown
PROGRESS <YYYY-MM-DD HH:MM EDT> — WAVE 2 (Foundation) LIVE:
- feat/wave2-foundation MERGED to main @$WAVE2 + PUSHED; Railway deployment <DEP> SUCCESS; boot log clean (migration 0014 credentials.revision/archived_at applied to the live volume by ensureRichRuleColumns; upgrade path rehearsed locally on a Wave 1-shaped volume first). Local gates: typecheck, lint, npm test (fail 0 incl. isolation, protected-identifiers, dist-hygiene, contrast-audit, workspace-credential-actions, workspace-cycles, dates, cycles), contrast audit exit 0, Playwright all four projects green; Docker run-check 46/46 (matrix 25 + actions 21).
- Live itrackceu.com: matrix 25/25; packet?credentialId=not-mine → 401 at the gateway; env keys unchanged; browser (Chris): edit → archive → restore → delete on throwaway "Wave 2 check" OK; time-zone banner <appeared and persisted America/New_York | not shown: zone already set>; Log activity date = local date; <renewed-cycle grouping seen | no renewed cycle in live data>.
- **Wave 3 starts from main @$WAVE2** (its base). GATE before Wave 3 screens: Chris approves the mockup (spec §2; canvas https://claude.ai/code/artifact/2796c074-02de-499a-8b0a-ffa5c66c2e5e, A/B/C pick still pending).
- Deferred on purpose: the ~111 server-source pins in tests/rendered-html.test.mjs (runtimeSource, workspaceRouteSource, routeSource, categorySource, modelSource, schemaSource, workerSource/serviceWorkerSource over public/sw.js, pushDeliverySource, wranglerSource) are retired by the wave that splits app/api/workspace/route.ts (architecture-M-05), not before; the categories editor for custom credentials is Wave 4 UI over Task 9's updateCredential `categories` server contract (already live, unused by the client).
- Worktree Vigilo-wt/wave2 + branch feat/wave2-foundation: remove only after Chris confirms the live checks.
```

Replace the iTrack line in `/Users/chrisskerritt/.claude/projects/-Users-chrisskerritt/memory/MEMORY.md` (currently the line starting `- [iTrack WEB-ONLY redesign: Wave 1 LIVE 2026-09-10; dead env vars DELETED`) with:

```markdown
- [iTrack WEB-ONLY redesign: Wave 1 LIVE 2026-09-10; Wave 2 (Foundation) LIVE <YYYY-MM-DD> @$WAVE2](project_itrack_web_redesign_2026_09_10.md) — Wave 3 base = main @$WAVE2; GATE: Chris approves mockup A/B/C before Wave 3 screens; server-source pins + custom-credential categories editor deferred (see note); Chris: confirm live checks, revoke APNs key U3F4W5JABK, Resend/DNS
```

After Chris confirms the live checks (and only then), remove the branch and its worktree:

```bash
cd "/Users/chrisskerritt/Documents/New project/Vigilo"
git worktree list                                                                   # if a Vigilo-wt/wave2 entry exists:
git worktree remove "/Users/chrisskerritt/Documents/New project/Vigilo-wt/wave2"
git branch -d feat/wave2-foundation                                                 # -d succeeds only because it is merged
git ls-remote --heads origin feat/wave2-foundation | grep -q . && git push origin --delete feat/wave2-foundation
```
Then add one line to the memory note: `- Worktree Vigilo-wt/wave2 REMOVED + branch feat/wave2-foundation deleted <date> (Chris confirmed live checks).`

---
