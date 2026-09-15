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
