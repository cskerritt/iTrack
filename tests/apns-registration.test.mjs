import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

// Harness lifted from tests/apns-delivery.test.mjs: a TS-transpile-and-data-URL
// import (generalized to a module graph) over a D1-compatible SQLite wrapper
// built from the real migration chain. Registration is almost entirely SQL,
// so a fake database would prove nothing about the upsert semantics this
// file exists to pin down. Kept as its own file (rather than folded into the
// delivery tests) because the two libraries only share this bootstrap, not
// any fixtures or assertions.

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

const apnsRegistration = await import(
  moduleUrlFor(new URL("../app/lib/apnsRegistration.ts", import.meta.url))
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
// case then clones it instead of reseeding the catalog.
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
    objects.some((object) => object.sql.includes("apns_devices")),
    "the initialized schema must contain the APNs devices table",
  );
  return objects.map((object) => object.sql);
})();

const USER_ID = "user-apns-reg-1";
const OTHER_USER_ID = "user-apns-reg-2";
const DEVICE_TOKEN = "a1b2c3d4e5f6a7b8c9d0";

function createWorkspace() {
  const sqlite = new DatabaseSync(":memory:");
  for (const statement of schemaStatements) sqlite.exec(statement);
  sqlite
    .prepare(`INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)`)
    .run(USER_ID, "chris@example.test", "Chris");
  sqlite
    .prepare(`INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)`)
    .run(OTHER_USER_ID, "other@example.test", "Other");
  return { sqlite, database: wrapDatabase(sqlite) };
}

function deviceRow(sqlite, token = DEVICE_TOKEN) {
  return sqlite
    .prepare(
      `SELECT id, user_id AS userId, device_token AS deviceToken,
              environment, device_label AS deviceLabel,
              failure_count AS failureCount, last_seen_at AS lastSeenAt,
              disabled_at AS disabledAt
       FROM apns_devices WHERE device_token = ?`,
    )
    .get(token);
}

function deviceCount(sqlite) {
  return sqlite.prepare(`SELECT COUNT(*) AS n FROM apns_devices`).get().n;
}

test("creates a new device and returns created:true", async () => {
  const { sqlite, database } = createWorkspace();
  const result = await apnsRegistration.registerApnsDevice(database, {
    userId: USER_ID,
    deviceToken: DEVICE_TOKEN,
    environment: "sandbox",
    deviceLabel: "  Chris's iPhone  ",
  });

  assert.equal(result.created, true);
  assert.ok(result.id);
  const row = deviceRow(sqlite);
  assert.equal(row.id, result.id);
  assert.equal(row.userId, USER_ID);
  assert.equal(row.deviceToken, DEVICE_TOKEN);
  assert.equal(row.environment, "sandbox");
  assert.equal(row.deviceLabel, "Chris's iPhone");
  assert.equal(row.failureCount, 0);
  assert.equal(row.disabledAt, null);
});

test("defaults environment to production when omitted", async () => {
  const { sqlite, database } = createWorkspace();
  await apnsRegistration.registerApnsDevice(database, {
    userId: USER_ID,
    deviceToken: DEVICE_TOKEN,
  });

  assert.equal(deviceRow(sqlite).environment, "production");
});

test("idempotent re-register updates lastSeenAt, clears disabledAt, resets failureCount, and keeps the same id", async () => {
  const { sqlite, database } = createWorkspace();
  const first = await apnsRegistration.registerApnsDevice(database, {
    userId: USER_ID,
    deviceToken: DEVICE_TOKEN,
  });
  // Simulate a device that had previously failed and been retired.
  sqlite
    .prepare(
      `UPDATE apns_devices
       SET failure_count = 4,
           disabled_at = '2020-01-01 00:00:00',
           last_seen_at = '2020-01-01 00:00:00'
       WHERE id = ?`,
    )
    .run(first.id);

  const second = await apnsRegistration.registerApnsDevice(database, {
    userId: USER_ID,
    deviceToken: DEVICE_TOKEN,
  });

  assert.equal(second.created, false);
  assert.equal(second.id, first.id, "the same device token must not mint a new row");
  const row = deviceRow(sqlite);
  assert.equal(row.failureCount, 0, "a reinstalled app must resurrect its token");
  assert.equal(row.disabledAt, null);
  assert.notEqual(row.lastSeenAt, "2020-01-01 00:00:00");
  assert.equal(deviceCount(sqlite), 1, "re-registration must not create a second row");
});

test("a second user claiming the same token reassigns it", async () => {
  const { sqlite, database } = createWorkspace();
  const first = await apnsRegistration.registerApnsDevice(database, {
    userId: USER_ID,
    deviceToken: DEVICE_TOKEN,
  });

  const second = await apnsRegistration.registerApnsDevice(database, {
    userId: OTHER_USER_ID,
    deviceToken: DEVICE_TOKEN,
  });

  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  const row = deviceRow(sqlite);
  assert.equal(row.userId, OTHER_USER_ID);
  assert.equal(deviceCount(sqlite), 1);
});

test("rejects an empty device token before touching the database", async () => {
  const { sqlite, database } = createWorkspace();
  await assert.rejects(() =>
    apnsRegistration.registerApnsDevice(database, {
      userId: USER_ID,
      deviceToken: "",
    }),
  );
  assert.equal(deviceCount(sqlite), 0);
});

test("rejects a device token over 200 characters", async () => {
  const { sqlite, database } = createWorkspace();
  await assert.rejects(() =>
    apnsRegistration.registerApnsDevice(database, {
      userId: USER_ID,
      deviceToken: "a".repeat(201),
    }),
  );
  assert.equal(deviceCount(sqlite), 0);
});

test("rejects a device token with non-alphanumeric characters", async () => {
  const { sqlite, database } = createWorkspace();
  await assert.rejects(() =>
    apnsRegistration.registerApnsDevice(database, {
      userId: USER_ID,
      deviceToken: "not-hex-!!",
    }),
  );
  assert.equal(deviceCount(sqlite), 0);
});

test("rejects an invalid environment", async () => {
  const { sqlite, database } = createWorkspace();
  await assert.rejects(() =>
    apnsRegistration.registerApnsDevice(database, {
      userId: USER_ID,
      deviceToken: DEVICE_TOKEN,
      environment: "staging",
    }),
  );
  assert.equal(deviceCount(sqlite), 0);
});

test("rejects a non-string device token", async () => {
  const { sqlite, database } = createWorkspace();
  await assert.rejects(() =>
    apnsRegistration.registerApnsDevice(database, {
      userId: USER_ID,
      deviceToken: 12345,
    }),
  );
  assert.equal(deviceCount(sqlite), 0);
});

test("trims and caps an overlong device label", async () => {
  const { sqlite, database } = createWorkspace();
  await apnsRegistration.registerApnsDevice(database, {
    userId: USER_ID,
    deviceToken: DEVICE_TOKEN,
    deviceLabel: `  ${"x".repeat(150)}  `,
  });

  assert.equal(deviceRow(sqlite).deviceLabel.length, 120);
});
