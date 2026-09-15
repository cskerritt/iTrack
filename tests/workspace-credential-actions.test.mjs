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
