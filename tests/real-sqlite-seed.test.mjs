import assert from "node:assert/strict";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Runs the built worker's full database initialization — schema, column
// migrations, and the entire managed-catalog seed — against a real SQLite
// database instead of the FakeDatabase used elsewhere. This is the only test
// that actually executes every seed statement, so it catches SQL that the
// fake accepts but SQLite rejects (unsupported syntax, malformed statements,
// and regressions like the managed-external scope growing into an OR chain
// deep enough to exceed the runtime's expression-depth limit).

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

function normalizeBinding(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function createRealD1Database() {
  const database = new DatabaseSync(":memory:");
  const statementCounts = { total: 0 };

  function makeStatement(sql, bindings) {
    return {
      bind(...next) {
        return makeStatement(sql, next.map(normalizeBinding));
      },
      async all() {
        statementCounts.total += 1;
        const prepared = database.prepare(sql);
        const results = prepared.all(...bindings);
        return { success: true, results, meta: { changes: 0 } };
      },
      async first() {
        statementCounts.total += 1;
        const prepared = database.prepare(sql);
        const row = prepared.get(...bindings);
        return row ?? null;
      },
      async run() {
        statementCounts.total += 1;
        const prepared = database.prepare(sql);
        const info = prepared.run(...bindings);
        return {
          success: true,
          results: [],
          meta: { changes: Number(info.changes) },
        };
      },
    };
  }

  return {
    statementCounts,
    prepare(sql) {
      return makeStatement(sql, []);
    },
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const prepared of statements) {
          results.push(await prepared.run());
        }
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const evidenceBucketStub = {
  async get() {
    return null;
  },
  async head() {
    return null;
  },
  async put() {
    throw new Error("R2 writes are not expected during workspace reads");
  },
  async delete() {},
};

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

async function fetchWorker(url, init = {}) {
  const worker = await workerPromise;
  return worker.fetch(
    new Request(url, init),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
      DB: testCloudflareEnv.DB,
      EVIDENCE: testCloudflareEnv.EVIDENCE,
    },
    executionContext,
  );
}

test("full initialization and managed-catalog seed run against real SQLite", async (t) => {
  const realDatabase = createRealD1Database();
  testCloudflareEnv.DB = realDatabase;
  testCloudflareEnv.EVIDENCE = evidenceBucketStub;

  await t.test("workspace loads for a fresh database", async () => {
    const response = await fetchWorker("http://localhost/api/workspace", {
      headers: { accept: "application/json" },
    });
    assert.equal(response.status, 200);
    const workspace = await response.json();
    assert.equal(workspace.user.isDemo, true);
    assert.ok(Array.isArray(workspace.catalog));
  });

  await t.test("seeded catalog is queryable and current", async () => {
    const catalogResponse = await fetchWorker("http://localhost/api/catalog", {
      headers: { accept: "application/json" },
    });
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.ok(Array.isArray(catalog.catalog));
    assert.ok(
      catalog.catalog.length >= 150,
      `expected the full managed catalog, saw ${catalog.catalog.length} rules`,
    );
  });

  await t.test(
    "second load skips the catalog seed via the recorded fingerprint",
    async () => {
      const seededStatements = realDatabase.statementCounts.total;
      const response = await fetchWorker("http://localhost/api/workspace", {
        headers: { accept: "application/json" },
      });
      assert.equal(response.status, 200);
      const secondLoadStatements =
        realDatabase.statementCounts.total - seededStatements;
      assert.ok(
        secondLoadStatements < 100,
        `expected a warm load to skip the ~640-statement seed, ran ${secondLoadStatements}`,
      );
    },
  );

  await t.test(
    "managed-external scope stays clear of the expression-depth limit",
    async () => {
      // Workers' SQLite enforces SQLITE_MAX_EXPR_DEPTH 100 while Node's build
      // allows 1000, so executing the seed above cannot catch a depth
      // regression by itself. Guard the structure instead: the scope fragment
      // must keep its prefix matching inside the VALUES join (constant parse
      // depth) rather than growing an OR chain of LIKE terms, which is what
      // previously pushed the parse tree past the runtime limit and made
      // every workspace load fail.
      const { readFile } = await import("node:fs/promises");
      const source = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const scopeMatch = source.match(
        /const MANAGED_EXTERNAL_SCOPE_SQL = `([\s\S]*?)`;/,
      );
      assert.ok(scopeMatch, "MANAGED_EXTERNAL_SCOPE_SQL not found");
      assert.match(
        scopeMatch[1],
        /FROM \(VALUES /,
        "prefix matching must stay inside a VALUES join",
      );
      const orChain = scopeMatch[1].match(/ OR /g) ?? [];
      assert.ok(
        orChain.length <= 10,
        `managed scope must stay flat, found ${orChain.length} OR terms`,
      );
    },
  );
});
