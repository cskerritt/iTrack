// The widget feed is derived, not stored: every number it publishes has to be
// the number the dashboard hero already shows. So this suite runs the real
// derivation (`getWorkspace` -> `readinessScore`) over a real migrated
// schema and asserts hand-computed values, rather than asserting whatever the
// code happens to return.
process.env.TZ = "UTC";

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

// Three harnesses meet in this file.
//
// 1. The TS-transpile-and-data-URL module graph from
//    `tests/apns-delivery.test.mjs`, extended two ways because
//    `widgetSummary.ts` reaches `app/api/workspace/route.ts`: "@/..." aliases
//    are resolved against the repo root (with `index.ts` fallback), and bare
//    package specifiers (e.g. `drizzle-orm/d1`) are re-resolved from the repo
//    root, since a data: URL has no parent directory to resolve either from.
// 2. The D1-compatible SQLite wrapper from `tests/real-sqlite-seed.test.mjs`.
// 3. The real migrated schema, read out of the built worker exactly as the
//    APNs suite does, then cloned per case.

const repoRoot = new URL("../", import.meta.url);

const inProgressModules = new Set();
const moduleUrls = new Map();

function resolveSpecifier(specifier, fileUrl) {
  const base = specifier.startsWith("@/")
    ? new URL(specifier.slice(2), repoRoot)
    : new URL(specifier, fileUrl);
  for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`]) {
    if (existsSync(new URL(candidate))) return new URL(candidate);
  }
  throw new Error(`Cannot resolve ${specifier} from ${fileUrl.href}`);
}

function moduleUrlFor(fileUrl) {
  const key = fileUrl.href;
  const cached = moduleUrls.get(key);
  if (cached) return cached;
  if (inProgressModules.has(key)) {
    throw new Error(`Import cycle through ${key} cannot be transpiled.`);
  }
  inProgressModules.add(key);
  const transpiled = ts.transpileModule(readFileSync(fileUrl, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  // Type-only imports are erased by the transpile, so only specifiers that
  // survive as runtime imports are rewritten.
  const rewritten = transpiled.replace(
    /(\bfrom\s*)["'](\.[^"']*|@\/[^"']*)["']/g,
    (_match, from, specifier) =>
      `${from}${JSON.stringify(
        moduleUrlFor(resolveSpecifier(specifier, fileUrl)),
      )}`,
  );
  const url = `data:text/javascript;base64,${Buffer.from(rewritten).toString(
    "base64",
  )}`;
  inProgressModules.delete(key);
  moduleUrls.set(key, url);
  return url;
}

const testCloudflareEnv = {};
globalThis.__LICENSE_LANTERN_TEST_ENV__ = testCloudflareEnv;

const cloudflareWorkersMockUrl = `data:text/javascript,${encodeURIComponent(
  "export const env = globalThis.__LICENSE_LANTERN_TEST_ENV__;",
)}`;
const loaderSource = `
  const ROOT = ${JSON.stringify(`${repoRoot.href}tests/harness.mjs`)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return {
        url: ${JSON.stringify(cloudflareWorkersMockUrl)},
        shortCircuit: true,
      };
    }
    if (
      context.parentURL?.startsWith("data:") &&
      !specifier.startsWith(".") &&
      !specifier.startsWith("data:") &&
      !specifier.startsWith("node:")
    ) {
      return nextResolve(specifier, { ...context, parentURL: ROOT });
    }
    return nextResolve(specifier, context);
  }
`;
register(
  `data:text/javascript,${encodeURIComponent(loaderSource)}`,
  import.meta.url,
);

const widgetSummary = await import(
  moduleUrlFor(new URL("../app/lib/widgetSummary.ts", import.meta.url))
);

function normalizeBinding(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function wrapDatabase(database) {
  function makeStatement(sql, bindings) {
    return {
      bind(...next) {
        return makeStatement(sql, next.map(normalizeBinding));
      },
      async all() {
        return {
          success: true,
          results: database.prepare(sql).all(...bindings),
          meta: { changes: 0 },
        };
      },
      async first() {
        return database.prepare(sql).get(...bindings) ?? null;
      },
      async run() {
        const info = database.prepare(sql).run(...bindings);
        return {
          success: true,
          results: [],
          meta: { changes: Number(info.changes) },
        };
      },
    };
  }
  return {
    prepare(sql) {
      return makeStatement(sql, []);
    },
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const prepared of statements) results.push(await prepared.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const evidence = {
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

// One real initialization run produces the authoritative schema; every test
// case then clones it instead of reseeding the catalog. The worker itself is
// kept so the route (token gate, single-user resolution, cache headers) can
// be exercised end to end rather than only through its library.
const { schemaStatements, worker } = await (async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const worker = (await import(workerUrl.href)).default;
  const sqlite = new DatabaseSync(":memory:");
  const database = wrapDatabase(sqlite);
  testCloudflareEnv.DB = database;
  testCloudflareEnv.EVIDENCE = evidence;
  const response = await worker.fetch(
    new Request("http://localhost/api/workspace", {
      headers: { accept: "application/json" },
    }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
      DB: database,
      EVIDENCE: evidence,
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200, "schema bootstrap request must succeed");
  const objects = sqlite
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`,
    )
    .all();
  assert.ok(
    objects.some((object) => object.sql.includes("credential_requirements")),
    "the initialized schema must contain credential requirements",
  );
  return { schemaStatements: objects.map((object) => object.sql), worker };
})();

const NOW_MS = Date.parse("2026-08-03T15:00:00.000Z");
const USER_ID = "user-widget-1";

// Seeds one user with three credentials whose hero numbers are all
// hand-computable:
//
//   "RI RN license"  deadline 2026-09-01, 20 required, 12 earned (2 ethics +
//                    10 general), 2 rules (1 met), 2 tasks (1 done)
//   "NBCC NCC"       deadline 2026-08-10, 10 required, nothing logged
//   "Legacy card"    no usable deadline, nothing required
function seedWorkspace() {
  const sqlite = new DatabaseSync(":memory:");
  for (const statement of schemaStatements) sqlite.exec(statement);
  const run = (sql, ...bindings) => sqlite.prepare(sql).run(...bindings);

  run(
    `INSERT INTO users (id, email, display_name, created_at)
     VALUES (?, ?, ?, ?)`,
    USER_ID,
    "chris@example.test",
    "Chris",
    "2026-01-01 00:00:00",
  );

  const insertCredential = (id, name, deadline, totalRequired, status) =>
    run(
      `INSERT INTO credentials (
         id, user_id, credential_name, profession, jurisdiction, issuer,
         cycle_start, deadline, total_required, unit_label, status
       ) VALUES (?, ?, ?, 'Nursing', 'RI', 'RI DOH', '2026-01-01', ?, ?,
                 'hours', ?)`,
      id,
      USER_ID,
      name,
      deadline,
      totalRequired,
      status ?? "active",
    );

  insertCredential("cred-rn", "RI RN license", "2026-09-01", 20);
  insertCredential("cred-ncc", "NBCC NCC", "2026-08-10", 10);
  // `deadline` is NOT NULL in the schema, so an unusable deadline is how a
  // row expresses "no due date" — the widget must publish null for it and
  // sort it last rather than emitting NaN. Reminder scheduling refuses to do
  // date arithmetic on such a row at all, so the only status that can carry
  // one is a closed-out ("renewed") credential.
  insertCredential("cred-legacy", "Legacy card", "", 0, "renewed");

  const insertRequirement = (id, name, requiredUnits, sortOrder) =>
    run(
      `INSERT INTO credential_requirements (
         id, credential_id, name, required_units, kind, sort_order
       ) VALUES (?, 'cred-rn', ?, ?, 'minimum', ?)`,
      id,
      name,
      requiredUnits,
      sortOrder,
    );
  insertRequirement("req-ethics", "Ethics", 2, 0);
  insertRequirement("req-general", "General", 18, 1);

  const logActivity = (id, title, units, requirementId) => {
    run(
      `INSERT INTO activities (
         id, user_id, title, provider, completion_date, total_units
       ) VALUES (?, ?, ?, 'Provider', '2026-03-01', ?)`,
      id,
      USER_ID,
      title,
      units,
    );
    run(
      `INSERT INTO activity_allocations (
         id, activity_id, credential_id, requirement_id, allocated_units
       ) VALUES (?, ?, 'cred-rn', ?, ?)`,
      `alloc-${id}`,
      id,
      requirementId,
      units,
    );
    run(
      `INSERT INTO activity_requirement_matches (
         id, user_id, allocation_id, requirement_id, matched_units
       ) VALUES (?, ?, ?, ?, ?)`,
      `match-${id}`,
      USER_ID,
      `alloc-${id}`,
      requirementId,
      units,
    );
  };
  logActivity("act-ethics", "Ethics course", 2, "req-ethics");
  logActivity("act-general", "General CE", 10, "req-general");

  const insertTask = (id, title, status, sortOrder) =>
    run(
      `INSERT INTO checklist_tasks (
         id, user_id, credential_id, title, kind, status, sort_order
       ) VALUES (?, ?, 'cred-rn', ?, 'renewal', ?, ?)`,
      id,
      USER_ID,
      title,
      status,
      sortOrder,
    );
  insertTask("task-1", "Gather certificates", "completed", 0);
  insertTask("task-2", "Submit renewal", "pending", 1);

  return { sqlite, database: wrapDatabase(sqlite) };
}

// A second seed for the ordering and clock cases, where the readiness inputs
// are beside the point: just a user, an optional reminder time zone, and
// credentials described by name/deadline/status.
function seedCredentials(credentials, { timeZone } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const statement of schemaStatements) sqlite.exec(statement);
  const run = (sql, ...bindings) => sqlite.prepare(sql).run(...bindings);
  run(
    `INSERT INTO users (id, email, display_name, created_at)
     VALUES (?, ?, ?, ?)`,
    USER_ID,
    "chris@example.test",
    "Chris",
    "2026-01-01 00:00:00",
  );
  if (timeZone) {
    run(
      `INSERT INTO reminder_preferences (
         user_id, in_app_enabled, push_enabled, push_hour_local, lead_days,
         time_zone
       ) VALUES (?, 1, 0, 9, '[90,30,7,1]', ?)`,
      USER_ID,
      timeZone,
    );
  }
  for (const [index, credential] of credentials.entries()) {
    run(
      `INSERT INTO credentials (
         id, user_id, credential_name, profession, jurisdiction, issuer,
         cycle_start, deadline, total_required, unit_label, status
       ) VALUES (?, ?, ?, 'Nursing', 'RI', 'RI DOH', '2026-01-01', ?, 0,
                 'hours', ?)`,
      `cred-${index}`,
      USER_ID,
      credential.name,
      credential.deadline,
      credential.status ?? "active",
    );
  }
  return { sqlite, database: wrapDatabase(sqlite) };
}

test("summary lists every credential soonest-due first with nulls last", async () => {
  const { database } = seedWorkspace();
  const summary = await widgetSummary.buildWidgetSummary(
    database,
    USER_ID,
    NOW_MS,
  );

  assert.deepEqual(
    summary.credentials.map((credential) => credential.name),
    ["NBCC NCC", "RI RN license", "Legacy card"],
  );
  assert.deepEqual(
    summary.credentials.map((credential) => credential.dueDate),
    ["2026-08-10", "2026-09-01", null],
  );
  // Both dates are end-of-day on the deadline, counted from 15:00 UTC on
  // 2026-08-03: 7d09h -> 8, and 29d09h -> 30.
  assert.deepEqual(
    summary.credentials.map((credential) => credential.daysToRenewal),
    [8, 30, null],
  );
  assert.deepEqual(Object.keys(summary), ["generatedAt", "credentials"]);
  for (const credential of summary.credentials) {
    assert.deepEqual(Object.keys(credential), [
      "name",
      "daysToRenewal",
      "dueDate",
      "creditsDone",
      "creditsRequired",
      "readinessPercent",
    ]);
  }
});

test("credits and readiness match the dashboard derivation", async () => {
  const { database } = seedWorkspace();
  const summary = await widgetSummary.buildWidgetSummary(
    database,
    USER_ID,
    NOW_MS,
  );
  const byName = new Map(
    summary.credentials.map((credential) => [credential.name, credential]),
  );

  // 2 + 10 counted units of the 20 required.
  // unitProgress .6, 1 of 2 minimums met (.5), 1 of 2 tasks done (.5)
  //   -> round(.6*70 + .5*15 + .5*15) = 57
  assert.deepEqual(byName.get("RI RN license"), {
    name: "RI RN license",
    daysToRenewal: 30,
    dueDate: "2026-09-01",
    creditsDone: 12,
    creditsRequired: 20,
    readinessPercent: 57,
  });

  // Nothing logged, no rules and no tasks: both of those count as complete,
  // so readiness is round(0*70 + 1*15 + 1*15) = 30.
  assert.deepEqual(byName.get("NBCC NCC"), {
    name: "NBCC NCC",
    daysToRenewal: 8,
    dueDate: "2026-08-10",
    creditsDone: 0,
    creditsRequired: 10,
    readinessPercent: 30,
  });

  // No unit requirement at all falls to the rules/tasks-only branch:
  // round(1*60 + 1*40) = 100.
  assert.deepEqual(byName.get("Legacy card"), {
    name: "Legacy card",
    daysToRenewal: null,
    dueDate: null,
    creditsDone: 0,
    creditsRequired: 0,
    readinessPercent: 100,
  });
});

test("a renewed credential never outranks a live one, however old its deadline", async () => {
  // The renewed row keeps the deadline it was renewed against, so a
  // date-only sort would put this dead credential — counting down past zero
  // — on the widget's top line the moment a renewal completes.
  const { database } = seedCredentials([
    { name: "Live licence", deadline: "2026-12-01", status: "active" },
    { name: "Last cycle", deadline: "2026-06-01", status: "renewed" },
    { name: "Filed licence", deadline: "2027-01-01", status: "submitted" },
  ]);
  const summary = await widgetSummary.buildWidgetSummary(
    database,
    USER_ID,
    NOW_MS,
  );

  assert.deepEqual(
    summary.credentials.map((credential) => credential.name),
    ["Live licence", "Filed licence", "Last cycle"],
  );
  // The renewed one is kept, not dropped, and still counts down honestly.
  assert.equal(summary.credentials.at(-1).daysToRenewal, -62);
});

test("credentials due the same day fall back to name order", async () => {
  const { database } = seedCredentials([
    { name: "Zebra cert", deadline: "2026-09-01" },
    { name: "Alpha cert", deadline: "2026-09-01" },
  ]);
  const summary = await widgetSummary.buildWidgetSummary(
    database,
    USER_ID,
    NOW_MS,
  );
  assert.deepEqual(
    summary.credentials.map((credential) => credential.name),
    ["Alpha cert", "Zebra cert"],
  );
});

test("day counts are read in the user's zone, not the worker's", async () => {
  // 02:00 UTC on the 4th is still 22:00 on the 3rd in New York, so the two
  // zones disagree about what "today" is at this instant — and therefore
  // about how many days are left.
  const instant = Date.parse("2026-08-04T02:00:00.000Z");
  const credentials = [{ name: "RI RN license", deadline: "2026-08-10" }];

  const newYork = await widgetSummary.buildWidgetSummary(
    seedCredentials(credentials, { timeZone: "America/New_York" }).database,
    USER_ID,
    instant,
  );
  assert.equal(newYork.credentials[0].daysToRenewal, 8);

  const utc = await widgetSummary.buildWidgetSummary(
    seedCredentials(credentials, { timeZone: "UTC" }).database,
    USER_ID,
    instant,
  );
  assert.equal(utc.credentials[0].daysToRenewal, 7);
});

test("generatedAt is the ISO form of the supplied clock", async () => {
  const { database } = seedWorkspace();
  const summary = await widgetSummary.buildWidgetSummary(
    database,
    USER_ID,
    NOW_MS,
  );
  assert.equal(summary.generatedAt, "2026-08-03T15:00:00.000Z");
});

test("the summary carries no identifying data beyond credential names", async () => {
  const { database } = seedWorkspace();
  const summary = await widgetSummary.buildWidgetSummary(
    database,
    USER_ID,
    NOW_MS,
  );
  const serialized = JSON.stringify(summary);
  for (const secret of ["chris@example.test", "Chris", USER_ID, "cred-rn"]) {
    assert.ok(
      !serialized.includes(secret),
      `summary must not leak ${secret}`,
    );
  }
});

test("constantTimeEquals agrees with === regardless of length", () => {
  const pairs = [
    ["", ""],
    ["a", "a"],
    ["token", "token"],
    ["token", "tokeN"],
    ["token", "tokem"],
    ["token", ""],
    ["", "token"],
    ["token", "token-longer"],
    ["token-longer", "token"],
    [" ", ""],
    ["ab", "ba"],
  ];
  for (const [left, right] of pairs) {
    assert.equal(
      widgetSummary.constantTimeEquals(left, right),
      left === right,
      `constantTimeEquals(${JSON.stringify(left)}, ${JSON.stringify(right)})`,
    );
  }
});

function widgetRequest(authorization) {
  return new Request("http://localhost/api/widget-summary", {
    headers: authorization ? { authorization } : {},
  });
}

test("an unset widget token disables the endpoint rather than opening it", () => {
  // Whitespace-only counts as unset: a token pasted into a hosting dashboard
  // routinely arrives padded, and a token made of spaces must never be one a
  // caller could present.
  for (const expected of [undefined, "", "   ", "\n", " \t "]) {
    assert.deepEqual(
      widgetSummary.authorizeWidgetRequest(
        widgetRequest("Bearer anything"),
        expected,
      ),
      { ok: false, status: 503 },
    );
  }
});

test("a missing or wrong bearer token is rejected", () => {
  const expected = "s3cret-widget-token";
  const rejected = [
    undefined,
    "",
    "Bearer",
    "Bearer ",
    "Bearer wrong",
    `Bearer ${expected}x`,
    `Bearer ${expected.slice(0, -1)}`,
    expected,
    `Basic ${expected}`,
  ];
  for (const authorization of rejected) {
    assert.deepEqual(
      widgetSummary.authorizeWidgetRequest(
        widgetRequest(authorization),
        expected,
      ),
      { ok: false, status: 401 },
      `authorization ${JSON.stringify(authorization)} must be rejected`,
    );
  }
});

test("the exact bearer token is accepted", () => {
  const expected = "s3cret-widget-token";
  assert.deepEqual(
    widgetSummary.authorizeWidgetRequest(
      widgetRequest(`Bearer ${expected}`),
      expected,
    ),
    { ok: true },
  );
  // A stored token with stray padding still authenticates the clean one.
  assert.deepEqual(
    widgetSummary.authorizeWidgetRequest(
      widgetRequest(`Bearer ${expected}`),
      `  ${expected}\n`,
    ),
    { ok: true },
  );
});

const ROUTE_TOKEN = "route-widget-token";

function fetchWidgetRoute(database, { token, authorization } = {}) {
  testCloudflareEnv.DB = database;
  testCloudflareEnv.EVIDENCE = evidence;
  testCloudflareEnv.ITRACK_WIDGET_TOKEN = token;
  return worker.fetch(
    new Request("http://localhost/api/widget-summary", {
      headers: authorization ? { authorization } : {},
    }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
      DB: database,
      EVIDENCE: evidence,
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("the route serves the single install's summary, uncacheable", async () => {
  const { database } = seedWorkspace();
  const response = await fetchWidgetRoute(database, {
    token: ROUTE_TOKEN,
    authorization: `Bearer ${ROUTE_TOKEN}`,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(
    body.credentials.map((credential) => credential.name),
    ["NBCC NCC", "RI RN license", "Legacy card"],
  );
  assert.deepEqual(
    body.credentials.map((credential) => credential.readinessPercent),
    [30, 57, 100],
  );
  assert.equal(body.credentials.at(-1).daysToRenewal, null);
});

test("the route refuses callers the token gate rejects", async () => {
  const { database } = seedWorkspace();
  const unconfigured = await fetchWidgetRoute(database, {
    token: undefined,
    authorization: `Bearer ${ROUTE_TOKEN}`,
  });
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.headers.get("cache-control"), "no-store");

  const wrong = await fetchWidgetRoute(database, {
    token: ROUTE_TOKEN,
    authorization: "Bearer nope",
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("cache-control"), "no-store");
  assert.equal(wrong.headers.get("www-authenticate"), 'Bearer realm="iTrack"');
});

// The Railway proxy's request handling lives in deploy/railway/gateway.mjs
// (behaviour is exercised end to end in tests/auth-gateway.test.mjs); the two
// widget exemptions are additionally pinned by reading the source so a
// refactor cannot silently widen them. Without them the endpoint is
// unreachable in production: the auth gate 401s a bearer request, and the
// header strip would remove the token before the worker ever sees it.
test("the Railway proxy lets the widget feed through with its token", async () => {
  const source = readFileSync(
    new URL("../deploy/railway/gateway.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const WIDGET_FEED_PATH = "\/api\/widget-summary";/,
    "the exemption must be an exact path, not a prefix",
  );
  assert.match(
    source,
    /if \(pathname === WIDGET_FEED_PATH\) \{\s*proxy\(req, res, null, \{ keepAuthorization: true \}\);/,
    "the widget feed proxies with no identity and keeps its bearer token",
  );
  // The widget branch must come before every auth path — open identity,
  // /auth/* routes, and the session/Basic identity resolution — so it can
  // never be given an identity or gated behind one.
  const widgetAt = source.indexOf("pathname === WIDGET_FEED_PATH");
  assert.ok(widgetAt !== -1);
  assert.ok(
    widgetAt < source.indexOf("if (openIdentity)"),
    "the widget feed must dispatch before open-identity handling",
  );
  assert.ok(
    widgetAt < source.indexOf("basicIdentity(req.headers.authorization)"),
    "the widget feed must skip the auth gate",
  );
  // The strip stays the default for every authenticated path: it is what
  // stops a caller supplying its own credentials to the worker. Only the
  // widget feed opts out via keepAuthorization.
  assert.match(
    source,
    /if \(!keepAuthorization\) delete headers\.authorization;/,
  );
  assert.equal(
    source.match(/delete headers\.authorization;/g)?.length,
    1,
    "authorization is deleted in exactly one place — the shared proxy strip",
  );
  assert.equal(
    source.match(/keepAuthorization: true/g)?.length,
    1,
    "only the widget feed keeps its Authorization header",
  );
});

test("the route reports 404 before any workspace exists", async () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const statement of schemaStatements) sqlite.exec(statement);
  const response = await fetchWidgetRoute(wrapDatabase(sqlite), {
    token: ROUTE_TOKEN,
    authorization: `Bearer ${ROUTE_TOKEN}`,
  });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).code, "widget_user_not_found");
});
