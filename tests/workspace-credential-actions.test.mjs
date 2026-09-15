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

  // node:sqlite hands back null-prototype rows; spread them into plain
  // objects so strict deepEqual against object literals compares values only
  // (the same normalisation tests/rendered-html.test.mjs applies to raw rows).
  const raw = (sql, ...bindings) =>
    db.raw
      .prepare(sql)
      .all(...bindings)
      .map((row) => ({ ...row }));

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
