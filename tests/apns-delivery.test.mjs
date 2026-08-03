import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

// Two harnesses meet in this file.
//
// 1. The TS-transpile-and-data-URL import used by the other library tests,
//    generalized to a module graph: `apnsDelivery.ts` imports three siblings
//    (which import siblings of their own), and a data: URL has no base to
//    resolve "./reminders" against, so every relative specifier is rewritten
//    to the dependency's own data URL.
// 2. The D1-compatible SQLite wrapper from `tests/real-sqlite-seed.test.mjs`.
//    Delivery is almost entirely SQL, so a fake database would prove nothing;
//    the schema is taken from the real worker (the same migration chain that
//    runs in production) and cloned into a fresh in-memory database per case
//    so that runs cannot see each other's devices or ledger rows.

const inProgressModules = new Set();
const moduleUrls = new Map();

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
    /(\bfrom\s*)["'](\.[^"']*)["']/g,
    (_match, from, specifier) =>
      `${from}${JSON.stringify(
        moduleUrlFor(new URL(`${specifier}.ts`, fileUrl)),
      )}`,
  );
  const url = `data:text/javascript;base64,${Buffer.from(rewritten).toString(
    "base64",
  )}`;
  inProgressModules.delete(key);
  moduleUrls.set(key, url);
  return url;
}

const apnsDelivery = await import(
  moduleUrlFor(new URL("../app/lib/apnsDelivery.ts", import.meta.url))
);

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

// One real initialization run produces the authoritative schema; every test
// case then clones it (about a millisecond) instead of reseeding the catalog.
const schemaStatements = await (async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const worker = (await import(workerUrl.href)).default;
  const sqlite = new DatabaseSync(":memory:");
  const database = wrapDatabase(sqlite);
  const evidence = {
    async get() {
      return null;
    },
    async head() {
      return null;
    },
    async put() {
      throw new Error("R2 writes are not expected while reading the schema");
    },
    async delete() {},
  };
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
    objects.some((object) => object.sql.includes("apns_delivery_ledger")),
    "the initialized schema must contain the APNs ledger",
  );
  return objects.map((object) => object.sql);
})();

const SCHEDULED_TIME = Date.parse("2026-08-03T15:00:00.000Z");
const TODAY = "2026-08-03";
const DEADLINE = "2026-08-04";
const USER_ID = "user-apns-1";
const CREDENTIAL_ID = "credential-apns-1";
const DEVICE_ID = "device-apns-1";
const DEVICE_TOKEN = "a1b2c3d4e5f6a7b8c9d0";
const REMINDER_KEY = `deadline:${CREDENTIAL_ID}:${DEADLINE}`;
const CONFIG = {
  teamId: "TEAMID9999",
  keyId: "KEYID99999",
  privateKeyPem: "pem-body",
  bundleId: "com.kwvrs.itrack",
  environment: "production",
};

function createWorkspace({
  pushEnabled = 1,
  pushHourLocal = 9,
  timeZone = "UTC",
  deadline = DEADLINE,
  devices = [{ id: DEVICE_ID, token: DEVICE_TOKEN }],
} = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const statement of schemaStatements) sqlite.exec(statement);
  sqlite
    .prepare(
      `INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)`,
    )
    .run(USER_ID, "chris@example.test", "Chris");
  sqlite
    .prepare(
      `INSERT INTO reminder_preferences (
         user_id, in_app_enabled, push_enabled, push_hour_local, lead_days,
         time_zone
       ) VALUES (?, 1, ?, ?, '[90,30,7,1]', ?)`,
    )
    .run(USER_ID, pushEnabled, pushHourLocal, timeZone);
  sqlite
    .prepare(
      `INSERT INTO credentials (
         id, user_id, credential_name, profession, jurisdiction, issuer,
         cycle_start, deadline, total_required, unit_label, status
       ) VALUES (?, ?, ?, 'Nursing', 'RI', 'RI DOH', '2026-01-01', ?, 20, 'hours', 'active')`,
    )
    .run(CREDENTIAL_ID, USER_ID, "RI RN license", deadline);
  for (const device of devices) {
    sqlite
      .prepare(
        `INSERT INTO apns_devices (id, user_id, device_token) VALUES (?, ?, ?)`,
      )
      .run(device.id, USER_ID, device.token);
  }
  return { sqlite, database: wrapDatabase(sqlite) };
}

function recordingSend(outcomeFor = () => ({
  ok: true,
  status: 200,
  unregistered: false,
  reason: null,
})) {
  const calls = [];
  return {
    calls,
    sendImpl: async (deviceToken, notification, config, fetchImpl, nowMs) => {
      calls.push({ deviceToken, notification, config, nowMs });
      return outcomeFor(deviceToken, calls.length);
    },
  };
}

function ledgerRows(sqlite) {
  return sqlite
    .prepare(
      `SELECT id, device_id AS deviceId, reminder_key AS reminderKey,
              scheduled_for AS scheduledFor, status,
              attempt_count AS attemptCount, last_attempt_at AS lastAttemptAt
       FROM apns_delivery_ledger
       ORDER BY created_at, id`,
    )
    .all();
}

function deviceRow(sqlite, id = DEVICE_ID) {
  return sqlite
    .prepare(
      `SELECT disabled_at AS disabledAt, failure_count AS failureCount,
              last_success_at AS lastSuccessAt, last_failure_at AS lastFailureAt
       FROM apns_devices WHERE id = ?`,
    )
    .get(id);
}

function run(database, { sendImpl, config = CONFIG, at = SCHEDULED_TIME }) {
  return apnsDelivery.runScheduledApnsDelivery({
    database,
    scheduledTime: at,
    config,
    sendImpl,
  });
}

test("reports not-configured and sends nothing without APNs credentials", async () => {
  const { sqlite, database } = createWorkspace();
  const { calls, sendImpl } = recordingSend();
  const result = await run(database, {
    sendImpl,
    config: { bundleId: "com.kwvrs.itrack" },
  });

  assert.deepEqual(result, {
    configured: false,
    devices: 0,
    materialized: 0,
    delivered: 0,
    failed: 0,
    disabled: 0,
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(ledgerRows(sqlite), []);
});

test("materializes a due reminder and delivers it to the device", async () => {
  const { sqlite, database } = createWorkspace();
  const { calls, sendImpl } = recordingSend();
  const result = await run(database, { sendImpl });

  assert.deepEqual(result, {
    configured: true,
    devices: 1,
    materialized: 1,
    delivered: 1,
    failed: 0,
    disabled: 0,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].deviceToken, DEVICE_TOKEN);
  assert.equal(calls[0].nowMs, SCHEDULED_TIME);
  assert.deepEqual(Object.keys(calls[0].notification).sort(), [
    "body",
    "tag",
    "title",
    "url",
  ]);
  // The reminder target is the app's today view. No delivery id is attached:
  // /api/workspace?delivery= only resolves web-push ledger ids, so an APNs id
  // there would greet the tap with "no longer available".
  assert.equal(calls[0].notification.url, "/?view=today");
  assert.match(calls[0].notification.tag, /^ll-[A-Za-z0-9_-]+$/);
  assert.ok(calls[0].notification.title.length > 0);
  assert.ok(calls[0].notification.body.length > 0);
  // Nothing about the credential may leak into a payload Apple can read.
  const payload = JSON.stringify(calls[0].notification);
  assert.ok(!payload.includes("RI RN license"));
  assert.deepEqual(calls[0].config, {
    teamId: CONFIG.teamId,
    keyId: CONFIG.keyId,
    privateKeyPem: CONFIG.privateKeyPem,
    bundleId: CONFIG.bundleId,
    environment: "production",
  });

  const rows = ledgerRows(sqlite);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deviceId, DEVICE_ID);
  assert.equal(rows[0].reminderKey, REMINDER_KEY);
  assert.equal(rows[0].scheduledFor, TODAY);
  assert.equal(rows[0].status, "delivered");
  assert.equal(rows[0].attemptCount, 1);
  const device = deviceRow(sqlite);
  assert.equal(device.disabledAt, null);
  assert.equal(device.failureCount, 0);
  assert.ok(device.lastSuccessAt);
});

test("a second run at the same scheduled time sends nothing", async () => {
  const { sqlite, database } = createWorkspace();
  const { calls, sendImpl } = recordingSend();
  await run(database, { sendImpl });
  const second = await run(database, { sendImpl });

  assert.equal(calls.length, 1);
  assert.equal(second.materialized, 0);
  assert.equal(second.delivered, 0);
  assert.equal(second.devices, 1);
  const rows = ledgerRows(sqlite);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "delivered");
  assert.equal(rows[0].attemptCount, 1);
});

test("an unregistered token disables the device and is never retried", async () => {
  const { sqlite, database } = createWorkspace();
  const { calls, sendImpl } = recordingSend(() => ({
    ok: false,
    status: 410,
    unregistered: true,
    reason: "Unregistered",
  }));
  const first = await run(database, { sendImpl });

  assert.equal(first.disabled, 1);
  assert.equal(first.delivered, 0);
  assert.equal(first.failed, 0);
  const device = deviceRow(sqlite);
  assert.ok(device.disabledAt, "the device must be retired");
  assert.ok(device.lastFailureAt);
  const rows = ledgerRows(sqlite);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].status, "pending");
  assert.notEqual(rows[0].status, "sending");

  const second = await run(database, {
    sendImpl,
    at: SCHEDULED_TIME + 60 * 60_000,
  });
  assert.equal(calls.length, 1, "a retired device must not be attempted again");
  assert.equal(second.devices, 0);
  assert.equal(second.materialized, 0);
});

test("a retryable failure leaves the row pending with the attempt counted", async () => {
  const { sqlite, database } = createWorkspace();
  const { calls, sendImpl } = recordingSend(() => ({
    ok: false,
    status: 503,
    unregistered: false,
    reason: null,
  }));
  const result = await run(database, { sendImpl });

  assert.equal(result.delivered, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.disabled, 0);
  const rows = ledgerRows(sqlite);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].attemptCount, 1);
  assert.ok(rows[0].lastAttemptAt);
  assert.equal(deviceRow(sqlite).failureCount, 1);

  // A second run inside the retry window must not burn another attempt.
  await run(database, { sendImpl, at: SCHEDULED_TIME + 60_000 });
  assert.equal(calls.length, 1);
  assert.equal(ledgerRows(sqlite)[0].attemptCount, 1);
});

test("repeated failures stop at the attempt cap", async () => {
  const { sqlite, database } = createWorkspace();
  const { calls, sendImpl } = recordingSend(() => ({
    ok: false,
    status: 500,
    unregistered: false,
    reason: null,
  }));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await run(database, {
      sendImpl,
      at: SCHEDULED_TIME + attempt * 20 * 60_000,
    });
  }

  assert.equal(calls.length, 4, "the attempt cap must hold across runs");
  const rows = ledgerRows(sqlite);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].attemptCount, 4);

  // A day later the same occurrence — whose scheduled date will not move for
  // weeks — is re-armed, so an outage costs a delay rather than the reminder.
  const nextDay = await run(database, {
    sendImpl,
    at: SCHEDULED_TIME + 25 * 60 * 60_000,
  });
  assert.equal(nextDay.materialized, 1);
  assert.equal(calls.length, 5);
  assert.equal(ledgerRows(sqlite)[0].attemptCount, 1);
});

test("a thrown send is refunded and stops the run", async () => {
  const { sqlite, database } = createWorkspace();
  const calls = [];
  const sendImpl = async (deviceToken) => {
    calls.push(deviceToken);
    // The sender rejects with a bare string when its abort timer fires, so the
    // delivery loop must not assume an Error instance.
    throw "APNs request timed out.";
  };
  const result = await run(database, { sendImpl });

  assert.equal(calls.length, 1);
  assert.equal(result.delivered, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.disabled, 0);
  const rows = ledgerRows(sqlite);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "pending");
  assert.equal(
    rows[0].attemptCount,
    0,
    "a configuration or transport failure must not spend the row's budget",
  );
});

test("waits for the local push hour before materializing", async () => {
  const { sqlite, database } = createWorkspace({
    pushHourLocal: 20,
    timeZone: "America/New_York",
  });
  const { calls, sendImpl } = recordingSend();
  const result = await run(database, { sendImpl });

  assert.equal(result.devices, 1);
  assert.equal(result.materialized, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(ledgerRows(sqlite), []);
});

test("delivers even when the browser push toggle is off", async () => {
  // Registering the iOS device is the opt-in for this channel, and the
  // web-push cron clears `push_enabled` for anyone without a browser
  // subscription — gating on it would silence the phone permanently.
  const { database } = createWorkspace({ pushEnabled: 0 });
  const { calls, sendImpl } = recordingSend();
  const result = await run(database, { sendImpl });

  assert.equal(result.delivered, 1);
  assert.equal(calls.length, 1);
});

test("cancels a materialized row once the reminder stops being active", async () => {
  const { sqlite, database } = createWorkspace();
  const { calls, sendImpl } = recordingSend(() => ({
    ok: false,
    status: 503,
    unregistered: false,
    reason: null,
  }));
  await run(database, { sendImpl });
  assert.equal(ledgerRows(sqlite)[0].status, "pending");

  sqlite
    .prepare(
      `INSERT INTO reminder_states (
         id, user_id, credential_id, reminder_key, status
       ) VALUES (?, ?, ?, ?, 'dismissed')`,
    )
    .run("state-1", USER_ID, CREDENTIAL_ID, REMINDER_KEY);
  const result = await run(database, {
    sendImpl,
    at: SCHEDULED_TIME + 20 * 60_000,
  });

  assert.equal(calls.length, 1, "a dismissed reminder must not alert");
  assert.equal(result.delivered, 0);
  assert.equal(ledgerRows(sqlite)[0].status, "cancelled");
});

test("fans one reminder out to every registered device", async () => {
  const { sqlite, database } = createWorkspace({
    devices: [
      { id: DEVICE_ID, token: DEVICE_TOKEN },
      { id: "device-apns-2", token: "ffeeddccbbaa99887766" },
    ],
  });
  const { calls, sendImpl } = recordingSend();
  const result = await run(database, { sendImpl });

  assert.equal(result.devices, 2);
  assert.equal(result.materialized, 2);
  assert.equal(result.delivered, 2);
  assert.deepEqual(
    calls.map((call) => call.deviceToken).sort(),
    [DEVICE_TOKEN, "ffeeddccbbaa99887766"].sort(),
  );
  assert.equal(ledgerRows(sqlite).length, 2);
});

test("retiring one device leaves the other device's delivery alone", async () => {
  const secondToken = "ffeeddccbbaa99887766";
  const { sqlite, database } = createWorkspace({
    devices: [
      { id: DEVICE_ID, token: DEVICE_TOKEN },
      { id: "device-apns-2", token: secondToken },
    ],
  });
  const { calls, sendImpl } = recordingSend((deviceToken) =>
    deviceToken === DEVICE_TOKEN
      ? { ok: false, status: 410, unregistered: true, reason: "Unregistered" }
      : { ok: true, status: 200, unregistered: false, reason: null },
  );
  const result = await run(database, { sendImpl });

  assert.equal(calls.length, 2);
  assert.equal(result.disabled, 1);
  assert.equal(result.delivered, 1);
  assert.ok(deviceRow(sqlite).disabledAt);
  assert.equal(deviceRow(sqlite, "device-apns-2").disabledAt, null);
  const rows = ledgerRows(sqlite);
  assert.equal(
    rows.find((row) => row.deviceId === DEVICE_ID).status,
    "expired",
  );
  assert.equal(
    rows.find((row) => row.deviceId === "device-apns-2").status,
    "delivered",
  );
});
