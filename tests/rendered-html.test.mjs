import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

const testCloudflareEnv = {};
globalThis.__LICENSE_LANTERN_TEST_ENV__ = testCloudflareEnv;

// The production bundle correctly targets Cloudflare's `cloudflare:workers`
// virtual module. Node's test runner does not provide that module, so expose the
// same env-shaped object while exercising the built worker.
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

function normalizedSql(value) {
  return value.replace(/\s+/g, " ").trim();
}

class FakeStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.bindings = [];
  }

  bind(...bindings) {
    this.bindings = bindings;
    return this;
  }

  async first() {
    const call = {
      method: "first",
      sql: normalizedSql(this.sql),
      bindings: [...this.bindings],
    };
    this.database.calls.push(call);
    return this.database.resolveFirst(call);
  }

  async all() {
    const call = {
      method: "all",
      sql: normalizedSql(this.sql),
      bindings: [...this.bindings],
    };
    this.database.calls.push(call);
    return { results: this.database.resolveAll(call) };
  }

  async run() {
    const call = {
      method: "run",
      sql: normalizedSql(this.sql),
      bindings: [...this.bindings],
    };
    this.database.calls.push(call);
    return { success: true, meta: {} };
  }
}

class FakeDatabase {
  constructor({ resolveFirst, resolveAll } = {}) {
    this.calls = [];
    this.batches = [];
    this.resolveFirst = resolveFirst ?? (() => null);
    this.resolveAll = resolveAll ?? (() => []);
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    const snapshot = statements.map((statement) => ({
      method: "batch",
      sql: normalizedSql(statement.sql),
      bindings: [...statement.bindings],
    }));
    this.batches.push(snapshot);
    this.calls.push(...snapshot);
    return snapshot.map(() => ({ success: true, results: [], meta: {} }));
  }
}

function runtimeEnvironment() {
  return {
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
    DB: testCloudflareEnv.DB,
  };
}

const executionContext = {
  waitUntil() {},
  passThroughOnException() {},
};

async function fetchWorker(url, init = {}) {
  const worker = await workerPromise;
  return worker.fetch(
    new Request(url, init),
    runtimeEnvironment(),
    executionContext,
  );
}

function authHeaders(email = "owner@example.com") {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "oai-authenticated-user-email": email,
    "oai-authenticated-user-full-name": "Casey%20Owner",
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  };
}

async function postWorkspace(action, payload, email = "owner@example.com") {
  return fetchWorker("https://license-lantern.example/api/workspace", {
    method: "POST",
    headers: authHeaders(email),
    body: JSON.stringify({ action, payload }),
  });
}

async function expectedStableUserId(email) {
  const bytes = new TextEncoder().encode(`license-lantern:${email}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `usr_${hex}`;
}

function flattenedStatements(database) {
  return database.batches.flat();
}

test("License Lantern product contract", async (t) => {
  await t.test("server-renders the product shell and metadata", async () => {
    const response = await fetchWorker("http://localhost/", {
      headers: { accept: "text/html" },
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

    const html = await response.text();
    assert.match(
      html,
      /<title>License Lantern — A clear path to renewal<\/title>/i,
    );
    assert.match(
      html,
      /<meta name="description" content="A calm continuing-education companion for tracking credits, proof, deadlines, and professional-license renewals\."\/>/i,
    );
    assert.match(
      html,
      /<meta name="application-name" content="License Lantern"\/>/i,
    );
    assert.match(html, /<link rel="manifest"[^>]*manifest\.webmanifest/i);
    assert.match(html, /<meta name="theme-color" content="#163f36"\/>/i);

    assert.match(html, /aria-label="License Lantern"/i);
    assert.match(html, /Skip to content/i);
    assert.match(html, /aria-label="Primary navigation"/i);
    assert.match(html, />Today<\/span>/i);
    assert.match(html, />Credentials<\/span>/i);
    assert.match(html, />Records<\/span>/i);
    assert.match(html, />Account<\/span>/i);
    assert.match(html, /aria-label="Loading License Lantern"/i);
    assert.match(html, /Loading your renewal workspace/i);
  });

  await t.test("removes the disposable starter preview", async () => {
    const [page, layout, packageJson, previewFiles] = await Promise.all([
      readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readdir(new URL("../app/_sites-preview", import.meta.url)).catch(
        (error) => {
          if (error?.code === "ENOENT") return [];
          throw error;
        },
      ),
    ]);

    assert.deepEqual(previewFiles, []);
    assert.doesNotMatch(page, /SkeletonPreview|codex-preview/i);
    assert.doesNotMatch(layout, /Starter Project|_sites-preview|codex-preview/i);
    assert.doesNotMatch(packageJson, /react-loading-skeleton/i);

    const response = await fetchWorker("http://localhost/", {
      headers: { accept: "text/html" },
    });
    const html = await response.text();
    assert.doesNotMatch(
      html,
      /Your site is taking shape|Building your site|codex-preview|react-loading-skeleton/i,
    );
  });

  await t.test("ships a durable D1 binding and migration", async () => {
    const [hostingSource, builtHostingSource, migration, builtMigration] =
      await Promise.all([
        readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
        readFile(
          new URL("../dist/.openai/hosting.json", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../drizzle/0000_past_agent_zero.sql", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL(
            "../dist/.openai/drizzle/0000_past_agent_zero.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      ]);

    const hosting = JSON.parse(hostingSource);
    const builtHosting = JSON.parse(builtHostingSource);
    assert.equal(hosting.d1, "DB");
    assert.equal(builtHosting.d1, "DB");
    assert.equal(hosting.r2, null);
    assert.equal(builtMigration, migration);

    const migratedTables = new Set(
      [...migration.matchAll(/CREATE TABLE `([^`]+)`/g)].map(
        (match) => match[1],
      ),
    );
    const requiredTables = [
      "users",
      "profiles",
      "rule_sets",
      "rule_categories",
      "credentials",
      "credential_requirements",
      "activities",
      "activity_allocations",
      "checklist_tasks",
      "renewal_submissions",
      "badge_definitions",
      "xp_events",
      "badge_events",
    ];
    assert.deepEqual(
      requiredTables.filter((tableName) => !migratedTables.has(tableName)),
      [],
    );
    assert.match(
      migration,
      /CREATE UNIQUE INDEX `activity_allocations_target_unique`/i,
    );
    assert.match(
      migration,
      /CREATE UNIQUE INDEX `renewal_submissions_credential_unique`/i,
    );
    assert.match(
      migration,
      /FOREIGN KEY \(`user_id`\) REFERENCES `users`\(`id`\)[\s\S]*?ON DELETE cascade/i,
    );
  });

  await t.test(
    "requires server-derived identity and guards owned records",
    async () => {
      const anonymousResponse = await fetchWorker(
        "https://license-lantern.example/api/workspace",
        { headers: { accept: "application/json" } },
      );
      assert.equal(anonymousResponse.status, 401);
      assert.equal(anonymousResponse.headers.get("cache-control"), "no-store");
      assert.deepEqual(await anonymousResponse.json(), {
        error: "Sign in with ChatGPT to access your CEU workspace.",
        code: "authentication_required",
      });

      const injectedIdentityResponse = await postWorkspace("addActivity", {
        userId: "usr_attacker_supplied",
        title: "Injected owner",
      });
      assert.equal(injectedIdentityResponse.status, 400);
      assert.deepEqual(await injectedIdentityResponse.json(), {
        error:
          "User identity is derived from the authenticated request and cannot be supplied by the client.",
        code: "client_identity_forbidden",
      });

      const database = new FakeDatabase();
      testCloudflareEnv.DB = database;
      const crossOwnerResponse = await postWorkspace("addActivity", {
        title: "Ethics conference",
        provider: "Professional Institute",
        completionDate: "2026-06-15",
        totalUnits: 2,
        credentialId: "credential-owned-by-someone-else",
        requirementId: null,
        evidenceStatus: "missing",
      });
      assert.equal(crossOwnerResponse.status, 404);
      assert.deepEqual(await crossOwnerResponse.json(), {
        error: "Credential not found.",
        code: "credential_not_found",
      });

      const ownerLookup = database.calls.find(
        (call) =>
          call.method === "first" &&
          /SELECT id FROM credentials WHERE id = \? AND user_id = \?/i.test(
            call.sql,
          ),
      );
      assert.ok(ownerLookup, "credential lookup must include the owner");
      assert.deepEqual(ownerLookup.bindings, [
        "credential-owned-by-someone-else",
        await expectedStableUserId("owner@example.com"),
      ]);

      const routeSource = await readFile(
        new URL("../app/api/workspace/route.ts", import.meta.url),
        "utf8",
      );
      assert.match(
        routeSource,
        /SELECT id FROM checklist_tasks WHERE id = \? AND user_id = \?/i,
      );
      assert.match(
        routeSource,
        /WHERE credential_id = \? AND user_id = \?/i,
      );
      assert.match(
        routeSource,
        /UPDATE credentials[\s\S]*?WHERE id = \? AND user_id = \?/i,
      );
    },
  );

  await t.test(
    "keeps learning activities distinct from renewal submissions",
    async () => {
      const [schema, routeSource, migration] = await Promise.all([
        readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
        readFile(
          new URL("../app/api/workspace/route.ts", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../drizzle/0000_past_agent_zero.sql", import.meta.url),
          "utf8",
        ),
      ]);

      const activitiesBlock = schema.slice(
        schema.indexOf("export const activities"),
        schema.indexOf("export const activityAllocations"),
      );
      const submissionsBlock = schema.slice(
        schema.indexOf("export const renewalSubmissions"),
        schema.indexOf("export const badgeDefinitions"),
      );
      assert.ok(activitiesBlock.length > 0);
      assert.ok(submissionsBlock.length > 0);
      assert.match(activitiesBlock, /completionDate: text\("completion_date"\)/);
      assert.match(activitiesBlock, /totalUnits: real\("total_units"\)/);
      assert.match(activitiesBlock, /evidenceStatus: text\("evidence_status"\)/);
      assert.doesNotMatch(activitiesBlock, /confirmationNumber|submittedAt/);

      assert.match(
        submissionsBlock,
        /submittedAt: text\("submitted_at"\)\.notNull\(\)/,
      );
      assert.match(
        submissionsBlock,
        /confirmationNumber: text\("confirmation_number"\)\.notNull\(\)/,
      );
      assert.match(
        submissionsBlock,
        /proofReference: text\("proof_reference"\)/,
      );
      assert.doesNotMatch(submissionsBlock, /completionDate|totalUnits/);

      assert.match(routeSource, /INSERT INTO activities \(/i);
      assert.match(routeSource, /INSERT INTO activity_allocations \(/i);
      assert.match(routeSource, /INSERT INTO renewal_submissions \(/i);
      assert.match(
        routeSource,
        /UPDATE credentials[\s\S]*?SET status = 'submitted'/i,
      );
      assert.match(migration, /CREATE TABLE `activities`/i);
      assert.match(migration, /CREATE TABLE `renewal_submissions`/i);
    },
  );

  await t.test(
    "rejects invalid dates, units, category totals, and evidence states",
    async () => {
      const database = new FakeDatabase();
      testCloudflareEnv.DB = database;

      const baseCredential = {
        ruleSetId: null,
        credentialName: "Test Credential",
        profession: "Testing",
        jurisdiction: "Test State",
        issuer: "Test Board",
        cycleStart: "2026-01-01",
        deadline: "2027-01-01",
        totalRequired: 10,
        unitLabel: "hours",
        categories: [{ name: "Ethics", requiredUnits: 2 }],
      };
      const baseActivity = {
        title: "Test activity",
        provider: "Test provider",
        completionDate: "2026-06-15",
        totalUnits: 2,
        credentialId: "credential-owner",
        requirementId: null,
        evidenceStatus: "missing",
      };
      const invalidCases = [
        {
          action: "createCredential",
          payload: { ...baseCredential, cycleStart: "2026-02-30" },
          message: /cycleStart must be a valid calendar date/i,
        },
        {
          action: "createCredential",
          payload: {
            ...baseCredential,
            cycleStart: "2027-02-01",
            deadline: "2027-01-01",
          },
          message: /deadline must be on or after cycleStart/i,
        },
        {
          action: "createCredential",
          payload: {
            ...baseCredential,
            totalRequired: 4,
            categories: [
              { name: "Ethics", requiredUnits: 3 },
              { name: "Safety", requiredUnits: 2 },
            ],
          },
          message: /Category requirements cannot exceed the credential total/i,
        },
        {
          action: "addActivity",
          payload: { ...baseActivity, totalUnits: 0 },
          message: /totalUnits must be a positive number/i,
        },
        {
          action: "addActivity",
          payload: { ...baseActivity, allocatedUnits: 2.5 },
          message: /allocatedUnits cannot exceed totalUnits/i,
        },
        {
          action: "addActivity",
          payload: { ...baseActivity, evidenceStatus: "trust me" },
          message: /evidenceStatus must be missing, attached, or not_required/i,
        },
      ];

      for (const invalidCase of invalidCases) {
        const response = await postWorkspace(
          invalidCase.action,
          invalidCase.payload,
        );
        const body = await response.json();
        assert.equal(
          response.status,
          400,
          `${invalidCase.action}: ${JSON.stringify(body)}`,
        );
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(body.code, "invalid_request");
        assert.match(body.error, invalidCase.message);
      }
    },
  );

  await t.test(
    "calculates reminder dates and normalized activity allocation",
    async () => {
      const database = new FakeDatabase({
        resolveFirst(call) {
          if (/SELECT id FROM credentials WHERE id = \? AND user_id = \?/i.test(call.sql)) {
            return { id: call.bindings[0] };
          }
          return null;
        },
      });
      testCloudflareEnv.DB = database;

      const credentialResponse = await postWorkspace("createCredential", {
        ruleSetId: null,
        credentialName: "Certified Test Professional",
        profession: "Testing",
        jurisdiction: "Test State",
        issuer: "Test Board",
        cycleStart: "2026-03-01",
        deadline: "2028-03-01",
        totalRequired: 10.239,
        unitLabel: "hours",
        categories: [{ name: "Ethics", requiredUnits: 2.345 }],
      });
      assert.equal(credentialResponse.status, 200);
      const credentialResult = await credentialResponse.json();
      assert.equal(credentialResult.ok, true);
      assert.equal(credentialResult.action, "createCredential");

      let statements = flattenedStatements(database);
      const credentialInsert = statements.find((statement) =>
        /^INSERT INTO credentials \(/i.test(statement.sql),
      );
      const requirementInsert = statements.find((statement) =>
        /^INSERT INTO credential_requirements \(/i.test(statement.sql),
      );
      const taskInserts = statements.filter((statement) =>
        /^INSERT INTO checklist_tasks \(/i.test(statement.sql),
      );
      assert.ok(credentialInsert);
      assert.ok(requirementInsert);
      assert.equal(credentialInsert.bindings[9], 10.24);
      assert.equal(requirementInsert.bindings[4], 2.35);
      assert.deepEqual(
        taskInserts.map((statement) => ({
          title: statement.bindings[3],
          kind: statement.bindings[4],
          dueDate: statement.bindings[5],
        })),
        [
          {
            title: "Review the renewal requirements",
            kind: "review",
            dueDate: "2027-11-02",
          },
          {
            title: "Complete and document required education",
            kind: "progress",
            dueDate: "2028-01-31",
          },
          {
            title: "Submit renewal and save confirmation",
            kind: "submission",
            dueDate: "2028-03-01",
          },
        ],
      );

      const activityResponse = await postWorkspace("addActivity", {
        title: "Evidence-based ethics",
        provider: "Professional Institute",
        completionDate: "2027-05-20",
        totalUnits: 1.239,
        credentialId: credentialResult.id,
        requirementId: null,
        evidenceStatus: "certificate saved",
      });
      assert.equal(activityResponse.status, 200);

      statements = flattenedStatements(database);
      const activityInsert = statements.find((statement) =>
        /^INSERT INTO activities \(/i.test(statement.sql),
      );
      const allocationInsert = statements.find((statement) =>
        /^INSERT INTO activity_allocations \(/i.test(statement.sql),
      );
      assert.ok(activityInsert);
      assert.ok(allocationInsert);
      assert.equal(activityInsert.bindings[5], 1.24);
      assert.equal(activityInsert.bindings[6], "attached");
      assert.equal(allocationInsert.bindings[2], credentialResult.id);
      assert.equal(allocationInsert.bindings[4], 1.24);
    },
  );

  await t.test(
    "records a submission without fabricating a learning activity",
    async () => {
      const database = new FakeDatabase({
        resolveFirst(call) {
          if (/SELECT id FROM credentials WHERE id = \? AND user_id = \?/i.test(call.sql)) {
            return { id: call.bindings[0] };
          }
          if (/FROM renewal_submissions WHERE credential_id = \? AND user_id = \?/i.test(call.sql)) {
            return null;
          }
          return null;
        },
      });
      testCloudflareEnv.DB = database;

      const response = await postWorkspace("markSubmitted", {
        credentialId: "credential-owner",
        submissionDate: "2028-02-20",
        confirmationNumber: "CONF-2028-0042",
        proofReference: "",
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.ok, true);
      assert.equal(result.action, "markSubmitted");

      const statements = flattenedStatements(database);
      const submissionInsert = statements.find((statement) =>
        /^INSERT INTO renewal_submissions \(/i.test(statement.sql),
      );
      const credentialUpdate = statements.find((statement) =>
        /^UPDATE credentials SET status = 'submitted'/i.test(statement.sql),
      );
      assert.ok(submissionInsert);
      assert.ok(credentialUpdate);
      assert.deepEqual(submissionInsert.bindings.slice(2), [
        "credential-owner",
        "2028-02-20",
        "CONF-2028-0042",
        "CONF-2028-0042",
      ]);
      assert.deepEqual(credentialUpdate.bindings, [
        "credential-owner",
        await expectedStableUserId("owner@example.com"),
      ]);
      assert.equal(
        statements.some((statement) =>
          /^INSERT INTO activities \(/i.test(statement.sql),
        ),
        false,
      );
    },
  );
});
