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

function isOwnedCredentialCycleLookup(sql) {
  return /SELECT id, status, cycle_start AS cycleStart, deadline FROM credentials WHERE id = \? AND user_id = \?/i.test(
    sql,
  );
}

function isOwnedActivityCycleLookup(sql) {
  return /SELECT id, total_units AS totalUnits, completion_date AS completionDate FROM activities WHERE id = \? AND user_id = \?/i.test(
    sql,
  );
}

function isRequirementTagLookup(sql) {
  return /SELECT requirement\.id, requirement\.name, requirement\.is_active AS isActive, requirement\.applicability_status AS applicabilityStatus FROM credential_requirements requirement JOIN credentials credential[\s\S]*?requirement\.id IN \(/i.test(
    sql,
  );
}

function isApplicabilityRequirementsLookup(sql) {
  return /SELECT requirement\.id, requirement\.name, requirement\.relation, requirement\.parent_requirement_id AS parentRequirementId, requirement\.applicability, requirement\.applicability_status AS applicabilityStatus FROM credential_requirements requirement JOIN credentials credential/i.test(
    sql,
  );
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

function runtimeEnvironment() {
  return {
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
    DB: testCloudflareEnv.DB,
    EVIDENCE: testCloudflareEnv.EVIDENCE,
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

async function postEvidence(form, email = "owner@example.com") {
  const headers = authHeaders(email);
  delete headers["content-type"];
  return fetchWorker("https://license-lantern.example/api/evidence", {
    method: "POST",
    headers,
    body: form,
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

function shiftIsoDate(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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

  await t.test("ships durable D1, R2, and migration bindings", async () => {
    const [
      hostingSource,
      builtHostingSource,
      baseMigration,
      evidenceMigration,
      lifecycleMigration,
      richRuleMigration,
      builtBaseMigration,
      builtEvidenceMigration,
      builtLifecycleMigration,
      builtRichRuleMigration,
      schemaSource,
      runtimeSource,
    ] = await Promise.all([
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
          new URL("../drizzle/0001_lethal_revanche.sql", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL(
            "../drizzle/0002_lonely_green_goblin.sql",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(
          new URL("../drizzle/0003_lazy_ironclad.sql", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL(
            "../dist/.openai/drizzle/0000_past_agent_zero.sql",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(
          new URL(
            "../dist/.openai/drizzle/0001_lethal_revanche.sql",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(
          new URL(
            "../dist/.openai/drizzle/0002_lonely_green_goblin.sql",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(
          new URL(
            "../dist/.openai/drizzle/0003_lazy_ironclad.sql",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
        readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
      ]);

    const hosting = JSON.parse(hostingSource);
    const builtHosting = JSON.parse(builtHostingSource);
    assert.equal(hosting.d1, "DB");
    assert.equal(builtHosting.d1, "DB");
    assert.equal(hosting.r2, "EVIDENCE");
    assert.equal(builtHosting.r2, "EVIDENCE");
    assert.equal(builtBaseMigration, baseMigration);
    assert.equal(builtEvidenceMigration, evidenceMigration);
    assert.equal(builtLifecycleMigration, lifecycleMigration);
    assert.equal(builtRichRuleMigration, richRuleMigration);

    const migration = `${baseMigration}\n${evidenceMigration}\n${lifecycleMigration}\n${richRuleMigration}`;
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
      "evidence_files",
      "activity_allocations",
      "activity_requirement_matches",
      "checklist_tasks",
      "renewal_submissions",
      "credential_cycle_links",
      "renewal_acceptances",
      "reminder_preferences",
      "reminder_states",
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
      lifecycleMigration,
      /DROP INDEX `activity_allocations_target_unique`[\s\S]*?CREATE UNIQUE INDEX `activity_allocations_activity_credential_unique`[\s\S]*?`activity_id`,`credential_id`/i,
    );
    assert.match(
      migration,
      /CREATE UNIQUE INDEX `renewal_submissions_credential_unique`/i,
    );
    assert.match(
      migration,
      /CREATE UNIQUE INDEX `evidence_files_object_key_unique`/i,
    );
    assert.match(
      migration,
      /CREATE UNIQUE INDEX `evidence_files_activity_hash_unique`[\s\S]*?`user_id`,`activity_id`,`sha256`/i,
    );
    assert.match(
      lifecycleMigration,
      /CREATE UNIQUE INDEX `renewal_acceptances_credential_unique`/i,
    );
    assert.match(
      lifecycleMigration,
      /CREATE UNIQUE INDEX `reminder_states_user_key_unique`[\s\S]*?`user_id`,`reminder_key`/i,
    );
    assert.match(
      richRuleMigration,
      /CREATE UNIQUE INDEX `activity_requirement_matches_allocation_requirement_unique`[\s\S]*?`allocation_id`,`requirement_id`/i,
    );
    assert.match(
      richRuleMigration,
      /INSERT OR IGNORE INTO `activity_requirement_matches`[\s\S]*?'legacy-match-' \|\| allocation\.`id`[\s\S]*?allocation\.`allocated_units`[\s\S]*?allocation\.`requirement_id` IS NOT NULL/i,
    );
    for (const column of [
      "kind",
      "relation",
      "parent_requirement_id",
      "applicability",
      "applicability_status",
      "condition_note",
      "is_active",
    ]) {
      assert.match(
        richRuleMigration,
        new RegExp(
          `ALTER TABLE \\\`credential_requirements\\\` ADD \\\`${column}\\\``,
          "i",
        ),
      );
      assert.match(runtimeSource, new RegExp(`\\b${column}\\b`, "i"));
      assert.match(schemaSource, new RegExp(`"${column}"`, "i"));
    }
    for (const column of [
      "kind",
      "relation",
      "parent_category_id",
      "applicability",
      "condition_note",
    ]) {
      assert.match(
        richRuleMigration,
        new RegExp(
          `ALTER TABLE \\\`rule_categories\\\` ADD \\\`${column}\\\``,
          "i",
        ),
      );
      assert.match(runtimeSource, new RegExp(`\\b${column}\\b`, "i"));
      assert.match(schemaSource, new RegExp(`"${column}"`, "i"));
    }
    assert.match(
      runtimeSource,
      /CREATE TABLE IF NOT EXISTS activity_requirement_matches/i,
    );
    assert.match(
      runtimeSource,
      /CREATE UNIQUE INDEX IF NOT EXISTS activity_requirement_matches_allocation_requirement_unique[\s\S]*?allocation_id, requirement_id/i,
    );
    assert.match(
      runtimeSource,
      /INSERT OR IGNORE INTO activity_requirement_matches[\s\S]*?'legacy-match-' \|\| allocation\.id[\s\S]*?allocation\.allocated_units[\s\S]*?allocation\.requirement_id IS NOT NULL/i,
    );
    assert.match(
      schemaSource,
      /export const activityRequirementMatches = sqliteTable\([\s\S]*?"activity_requirement_matches"/i,
    );
    assert.match(
      migration,
      /FOREIGN KEY \(`user_id`\) REFERENCES `users`\(`id`\)[\s\S]*?ON DELETE cascade/i,
    );
  });

  await t.test(
    "stores evidence metadata under private, owner-scoped R2 keys",
    async () => {
      const userId = await expectedStableUserId("owner@example.com");
      const bucket = new FakeEvidenceBucket();
      const database = new FakeDatabase({
        resolveFirst(call) {
          if (
            /SELECT id FROM activities WHERE id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return { id: call.bindings[0] };
          }
          if (/SELECT COUNT\(\*\) AS count FROM evidence_files/i.test(call.sql)) {
            return { count: 0 };
          }
          if (
            /SELECT id FROM evidence_files WHERE user_id = \? AND activity_id = \? AND sha256 = \?/i.test(
              call.sql,
            )
          ) {
            return null;
          }
          if (
            /FROM evidence_files WHERE id = \? AND user_id = \? AND status = 'ready'/i.test(
              call.sql,
            )
          ) {
            const inserted = flattenedStatements(this).find((statement) =>
              /^INSERT INTO evidence_files \(/i.test(statement.sql),
            );
            if (!inserted) return null;
            return {
              id: inserted.bindings[0],
              activityId: inserted.bindings[2],
              objectKey: inserted.bindings[3],
              originalFilename: inserted.bindings[4],
              contentType: inserted.bindings[5],
              sizeBytes: inserted.bindings[6],
              sha256: inserted.bindings[7],
              storageEtag: inserted.bindings[8],
              createdAt: "2026-07-25T12:00:00.000Z",
            };
          }
          return null;
        },
      });
      testCloudflareEnv.DB = database;
      testCloudflareEnv.EVIDENCE = bucket;

      const bytes = new Uint8Array([
        0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a,
      ]);
      const form = new FormData();
      form.set("activityId", "activity-owner");
      form.set(
        "file",
        new File([bytes], "ethics-certificate.pdf", {
          type: "application/pdf",
        }),
      );

      const response = await postEvidence(form);
      assert.equal(response.status, 201);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const result = await response.json();
      assert.equal(result.ok, true);
      assert.equal(result.evidence.activityId, "activity-owner");
      assert.equal(result.evidence.fileName, "ethics-certificate.pdf");
      assert.equal(result.evidence.contentType, "application/pdf");
      assert.equal(result.evidence.sizeBytes, bytes.byteLength);
      assert.equal(
        result.evidence.downloadUrl,
        `/api/evidence/${result.evidence.id}/download`,
      );
      assert.equal("objectKey" in result.evidence, false);
      assert.equal("storageEtag" in result.evidence, false);
      assert.equal("userId" in result.evidence, false);

      assert.equal(bucket.puts.length, 1);
      const upload = bucket.puts[0];
      assert.match(
        upload.key,
        new RegExp(
          `^evidence/${userId}/activity-owner/[0-9a-f-]{36}$`,
          "i",
        ),
      );
      assert.deepEqual(upload.options.customMetadata, {
        evidenceId: result.evidence.id,
        activityId: "activity-owner",
      });
      assert.equal(
        upload.options.httpMetadata.contentType,
        "application/pdf",
      );
      assert.ok(upload.options.sha256 instanceof ArrayBuffer);

      const statements = flattenedStatements(database);
      const evidenceInsert = statements.find((statement) =>
        /^INSERT INTO evidence_files \(/i.test(statement.sql),
      );
      const activityUpdate = statements.find((statement) =>
        /^UPDATE activities SET evidence_status = 'attached'/i.test(
          statement.sql,
        ),
      );
      assert.ok(evidenceInsert);
      assert.ok(activityUpdate);
      assert.deepEqual(evidenceInsert.bindings.slice(0, 4), [
        result.evidence.id,
        userId,
        "activity-owner",
        upload.key,
      ]);
      assert.deepEqual(activityUpdate.bindings, [
        "ethics-certificate.pdf",
        "activity-owner",
        userId,
      ]);
    },
  );

  await t.test(
    "rejects cross-owner evidence access before touching R2",
    async () => {
      const userId = await expectedStableUserId("owner@example.com");
      const bucket = new FakeEvidenceBucket();
      const database = new FakeDatabase();
      testCloudflareEnv.DB = database;
      testCloudflareEnv.EVIDENCE = bucket;

      const bytes = new Uint8Array([
        0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a,
      ]);
      const form = new FormData();
      form.set("activityId", "activity-owned-by-someone-else");
      form.set(
        "file",
        new File([bytes], "other-owner.pdf", {
          type: "application/pdf",
        }),
      );
      const uploadResponse = await postEvidence(form);
      assert.equal(uploadResponse.status, 404);
      assert.deepEqual(await uploadResponse.json(), {
        error: "Activity not found.",
        code: "activity_not_found",
      });
      assert.equal(bucket.puts.length, 0);

      const activityLookup = database.calls.find(
        (call) =>
          call.method === "first" &&
          /SELECT id FROM activities WHERE id = \? AND user_id = \?/i.test(
            call.sql,
          ),
      );
      assert.ok(activityLookup);
      assert.deepEqual(activityLookup.bindings, [
        "activity-owned-by-someone-else",
        userId,
      ]);

      const evidenceId = "36d2e90b-a0e9-4f61-83a7-d14a5dd467a6";
      const downloadResponse = await fetchWorker(
        `https://license-lantern.example/api/evidence/${evidenceId}/download`,
        { headers: authHeaders() },
      );
      assert.equal(downloadResponse.status, 404);
      assert.deepEqual(await downloadResponse.json(), {
        error: "Evidence file not found.",
        code: "evidence_not_found",
      });
      assert.equal(bucket.gets.length, 0);

      const evidenceLookup = database.calls.find(
        (call) =>
          call.method === "first" &&
          /FROM evidence_files WHERE id = \? AND user_id = \? AND status = 'ready'/i.test(
            call.sql,
          ),
      );
      assert.ok(evidenceLookup);
      assert.deepEqual(evidenceLookup.bindings, [evidenceId, userId]);
    },
  );

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
          isOwnedCredentialCycleLookup(call.sql),
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
        /FROM checklist_tasks task[\s\S]*?WHERE task\.id = \?[\s\S]*?AND task\.user_id = \?[\s\S]*?AND credential\.user_id = task\.user_id/i,
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
    "snapshots conditional rules, scopes updates, and rejects inactive tags",
    async () => {
      const userId = await expectedStableUserId("owner@example.com");
      const richRuleCategories = [
        {
          id: "category-core",
          name: "Professional Responsibility",
          requiredUnits: 4,
          kind: "minimum",
          relation: "independent",
          parentCategoryId: null,
          applicability: "always",
          conditionNote: null,
        },
        {
          id: "category-special-role",
          name: "Special Role Training",
          requiredUnits: 2,
          kind: "minimum",
          relation: "nested",
          parentCategoryId: "category-core",
          applicability: "conditional",
          conditionNote: "Applies only when serving in the special role.",
        },
        {
          id: "category-self-study",
          name: "Self-study",
          requiredUnits: 3,
          kind: "maximum",
          relation: "overlapping",
          parentCategoryId: null,
          applicability: "always",
          conditionNote: null,
        },
      ];
      const createDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (/FROM rule_sets WHERE id = \? AND is_current = 1/i.test(call.sql)) {
            return {
              id: "rule-rich",
              credentialName: "Rich Semantics License",
              profession: "Testing",
              jurisdiction: "Test State",
              issuer: "Test Board",
              totalUnits: 10,
              unitLabel: "hours",
              cycleMonths: 12,
            };
          }
          return null;
        },
        resolveAll(call) {
          if (/FROM rule_categories WHERE rule_set_id = \?/i.test(call.sql)) {
            return richRuleCategories;
          }
          return [];
        },
      });
      testCloudflareEnv.DB = createDatabase;

      const createResponse = await postWorkspace("createCredential", {
        ruleSetId: "rule-rich",
        cycleStart: "2027-01-01",
        deadline: "2027-12-31",
        applicabilityChoices: [
          {
            ruleCategoryId: "category-special-role",
            status: "not_applicable",
          },
        ],
      });
      assert.equal(createResponse.status, 200);
      const createResult = await createResponse.json();
      const requirementInserts = flattenedStatements(createDatabase).filter(
        (statement) => /^INSERT INTO credential_requirements \(/i.test(statement.sql),
      );
      assert.equal(requirementInserts.length, 3);
      const requirementByName = new Map(
        requirementInserts.map((statement) => [
          statement.bindings[3],
          statement,
        ]),
      );
      const parentInsert = requirementByName.get("Professional Responsibility");
      const conditionalInsert = requirementByName.get("Special Role Training");
      const maximumInsert = requirementByName.get("Self-study");
      assert.ok(parentInsert);
      assert.ok(conditionalInsert);
      assert.ok(maximumInsert);
      assert.equal(parentInsert.bindings[1], createResult.id);
      assert.deepEqual(parentInsert.bindings.slice(4, 13), [
        4,
        "minimum",
        "independent",
        null,
        "always",
        "applies",
        null,
        1,
        0,
      ]);
      assert.equal(
        conditionalInsert.bindings[7],
        parentInsert.bindings[0],
        "nested parent must use the credential requirement snapshot ID",
      );
      assert.deepEqual(conditionalInsert.bindings.slice(4, 13), [
        2,
        "minimum",
        "nested",
        parentInsert.bindings[0],
        "conditional",
        "not_applicable",
        "Applies only when serving in the special role.",
        0,
        1,
      ]);
      assert.deepEqual(maximumInsert.bindings.slice(4, 13), [
        3,
        "maximum",
        "overlapping",
        null,
        "always",
        "applies",
        null,
        1,
        2,
      ]);

      const updateRequirements = [
        {
          id: "requirement-core",
          name: "Professional Responsibility",
          relation: "independent",
          parentRequirementId: null,
          applicability: "always",
          applicabilityStatus: "applies",
        },
        {
          id: "requirement-special-role",
          name: "Special Role Training",
          relation: "nested",
          parentRequirementId: "requirement-core",
          applicability: "conditional",
          applicabilityStatus: "not_applicable",
        },
      ];
      const updateDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (
            /SELECT id, status FROM credentials WHERE id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return { id: call.bindings[0], status: "active" };
          }
          return null;
        },
        resolveAll(call) {
          if (isApplicabilityRequirementsLookup(call.sql)) {
            return updateRequirements;
          }
          return [];
        },
      });
      testCloudflareEnv.DB = updateDatabase;
      const updateResponse = await postWorkspace(
        "updateRequirementApplicability",
        {
          credentialId: "credential-rich",
          choices: [
            {
              requirementId: "requirement-special-role",
              status: "applies",
            },
          ],
        },
      );
      assert.equal(updateResponse.status, 200);
      const applicabilityUpdate = flattenedStatements(updateDatabase).find(
        (statement) =>
          /^UPDATE credential_requirements SET applicability_status = \?, is_active = \?/i.test(
            statement.sql,
          ),
      );
      assert.ok(applicabilityUpdate);
      assert.match(
        applicabilityUpdate.sql,
        /WHERE id = \? AND credential_id = \? AND EXISTS \( SELECT 1 FROM credentials credential[\s\S]*?credential\.user_id = \? \)/i,
      );
      assert.deepEqual(applicabilityUpdate.bindings, [
        "applies",
        1,
        "requirement-special-role",
        "credential-rich",
        userId,
      ]);

      const optionalCapDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (
            /SELECT id, status FROM credentials WHERE id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return { id: call.bindings[0], status: "active" };
          }
          return null;
        },
        resolveAll(call) {
          if (isApplicabilityRequirementsLookup(call.sql)) {
            return [
              {
                id: "requirement-self-study",
                name: "Self-study",
                relation: "overlapping",
                parentRequirementId: null,
                applicability: "optional",
                applicabilityStatus: "applies",
              },
            ];
          }
          return [];
        },
      });
      testCloudflareEnv.DB = optionalCapDatabase;
      const optionalCapResponse = await postWorkspace(
        "updateRequirementApplicability",
        {
          credentialId: "credential-rich",
          choices: [
            {
              requirementId: "requirement-self-study",
              status: "not_applicable",
            },
          ],
        },
      );
      assert.equal(optionalCapResponse.status, 400);
      assert.deepEqual(await optionalCapResponse.json(), {
        error:
          "status for Self-study must be applies for an always or optional rule",
        code: "invalid_request",
      });
      assert.equal(
        flattenedStatements(optionalCapDatabase).some((statement) =>
          /^UPDATE credential_requirements /i.test(statement.sql),
        ),
        false,
        "an optional earning path must not allow its cap to be disabled",
      );

      const crossOwnerDatabase = new FakeDatabase({
        resolveAll(call) {
          return isApplicabilityRequirementsLookup(call.sql)
            ? updateRequirements
            : [];
        },
      });
      testCloudflareEnv.DB = crossOwnerDatabase;
      const crossOwnerResponse = await postWorkspace(
        "updateRequirementApplicability",
        {
          credentialId: "credential-owned-by-someone-else",
          choices: [
            {
              requirementId: "requirement-special-role",
              status: "applies",
            },
          ],
        },
      );
      assert.equal(crossOwnerResponse.status, 404);
      assert.deepEqual(await crossOwnerResponse.json(), {
        error: "Credential not found.",
        code: "credential_not_found",
      });
      assert.equal(
        flattenedStatements(crossOwnerDatabase).some((statement) =>
          /^UPDATE credential_requirements /i.test(statement.sql),
        ),
        false,
      );

      const inactiveTagDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (isOwnedCredentialCycleLookup(call.sql)) {
            return {
              id: call.bindings[0],
              status: "active",
              cycleStart: "2027-01-01",
              deadline: "2027-12-31",
            };
          }
          return null;
        },
        resolveAll(call) {
          if (isRequirementTagLookup(call.sql)) {
            return [
              {
                id: "requirement-special-role",
                name: "Special Role Training",
                isActive: 0,
                applicabilityStatus: "not_applicable",
              },
            ];
          }
          return [];
        },
      });
      testCloudflareEnv.DB = inactiveTagDatabase;
      const inactiveTagResponse = await postWorkspace("addActivity", {
        title: "Special role seminar",
        provider: "Professional Institute",
        completionDate: "2027-05-20",
        totalUnits: 2,
        credentialId: "credential-rich",
        requirementIds: ["requirement-special-role"],
        evidenceStatus: "missing",
      });
      assert.equal(inactiveTagResponse.status, 409);
      assert.deepEqual(await inactiveTagResponse.json(), {
        error:
          "Special Role Training is not active for this renewal cycle.",
        code: "requirement_inactive",
      });
      assert.equal(
        flattenedStatements(inactiveTagDatabase).some((statement) =>
          /^INSERT INTO (activities|activity_allocations|activity_requirement_matches) \(/i.test(
            statement.sql,
          ),
        ),
        false,
      );
    },
  );

  await t.test(
    "calculates reminder dates and normalized activity allocation",
    async () => {
      const database = new FakeDatabase({
        resolveFirst(call) {
          if (isOwnedCredentialCycleLookup(call.sql)) {
            return {
              id: call.bindings[0],
              status: "active",
              cycleStart: "2026-03-01",
              deadline: "2028-03-01",
            };
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
    "writes one activity allocation with multiple requirement matches",
    async () => {
      const userId = await expectedStableUserId("owner@example.com");
      const requirementIds = [
        "requirement-ethics",
        "requirement-participatory",
      ];
      const database = new FakeDatabase({
        resolveFirst(call) {
          if (isOwnedCredentialCycleLookup(call.sql)) {
            return {
              id: call.bindings[0],
              status: "active",
              cycleStart: "2027-01-01",
              deadline: "2027-12-31",
            };
          }
          return null;
        },
        resolveAll(call) {
          if (isRequirementTagLookup(call.sql)) {
            return requirementIds.map((id) => ({
              id,
              name:
                id === "requirement-ethics" ? "Ethics" : "Participatory",
              isActive: 1,
              applicabilityStatus: "applies",
            }));
          }
          return [];
        },
      });
      testCloudflareEnv.DB = database;

      const response = await postWorkspace("addActivity", {
        title: "Live ethics workshop",
        provider: "Professional Institute",
        completionDate: "2027-05-20",
        totalUnits: 2,
        credentialId: "credential-rich",
        requirementIds,
        evidenceStatus: "missing",
      });
      assert.equal(response.status, 200);
      const statements = flattenedStatements(database);
      const activityInserts = statements.filter((statement) =>
        /^INSERT INTO activities \(/i.test(statement.sql),
      );
      const allocationInserts = statements.filter((statement) =>
        /^INSERT INTO activity_allocations \(/i.test(statement.sql),
      );
      const matchInserts = statements.filter((statement) =>
        /^INSERT INTO activity_requirement_matches \(/i.test(statement.sql),
      );
      assert.equal(activityInserts.length, 1);
      assert.equal(allocationInserts.length, 1);
      assert.equal(matchInserts.length, 2);
      const allocationId = allocationInserts[0].bindings[0];
      assert.deepEqual(allocationInserts[0].bindings.slice(1), [
        activityInserts[0].bindings[0],
        "credential-rich",
        requirementIds[0],
        2,
      ]);
      assert.deepEqual(
        matchInserts.map((statement) => statement.bindings.slice(1)),
        requirementIds.map((requirementId) => [
          userId,
          allocationId,
          requirementId,
          2,
        ]),
      );
      const validationLookup = database.calls.find(
        (call) => call.method === "all" && isRequirementTagLookup(call.sql),
      );
      assert.ok(validationLookup);
      assert.deepEqual(validationLookup.bindings, [
        "credential-rich",
        userId,
        ...requirementIds,
      ]);
    },
  );

  await t.test(
    "rejects activity dates outside the target renewal cycle before writing",
    async () => {
      const directActivityDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (isOwnedCredentialCycleLookup(call.sql)) {
            return {
              id: call.bindings[0],
              status: "active",
              cycleStart: "2026-01-01",
              deadline: "2026-12-31",
            };
          }
          return null;
        },
      });
      testCloudflareEnv.DB = directActivityDatabase;

      const directActivityResponse = await postWorkspace("addActivity", {
        title: "Prior-cycle ethics course",
        provider: "Professional Institute",
        completionDate: "2025-12-31",
        totalUnits: 2,
        credentialId: "credential-current-cycle",
        requirementId: null,
        evidenceStatus: "missing",
      });
      assert.equal(directActivityResponse.status, 409);
      assert.deepEqual(await directActivityResponse.json(), {
        error:
          "The completion date must fall within this renewal cycle (2026-01-01 through 2026-12-31).",
        code: "activity_outside_cycle",
      });
      assert.equal(
        flattenedStatements(directActivityDatabase).some((statement) =>
          /^INSERT INTO (activities|activity_allocations) \(/i.test(
            statement.sql,
          ),
        ),
        false,
      );

      const reusedActivityDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (isOwnedActivityCycleLookup(call.sql)) {
            return {
              id: call.bindings[0],
              totalUnits: 3,
              completionDate: "2027-01-01",
            };
          }
          if (isOwnedCredentialCycleLookup(call.sql)) {
            return {
              id: call.bindings[0],
              status: "active",
              cycleStart: "2026-01-01",
              deadline: "2026-12-31",
            };
          }
          return null;
        },
      });
      testCloudflareEnv.DB = reusedActivityDatabase;

      const reusedActivityResponse = await postWorkspace(
        "addActivityAllocation",
        {
          activityId: "activity-next-cycle",
          credentialId: "credential-current-cycle",
          requirementId: null,
          allocatedUnits: 3,
        },
      );
      assert.equal(reusedActivityResponse.status, 409);
      assert.deepEqual(await reusedActivityResponse.json(), {
        error:
          "The activity date must fall within the target renewal cycle (2026-01-01 through 2026-12-31).",
        code: "activity_outside_cycle",
      });
      assert.equal(
        reusedActivityDatabase.calls.some(
          (call) =>
            call.method === "run" &&
            /^INSERT INTO activity_allocations \(/i.test(call.sql),
        ),
        false,
      );
    },
  );

  await t.test(
    "records a submission without fabricating a learning activity",
    async () => {
      const database = new FakeDatabase({
        resolveFirst(call) {
          if (/SELECT id(?:, status)? FROM credentials WHERE id = \? AND user_id = \?/i.test(call.sql)) {
            return { id: call.bindings[0], status: "active" };
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

  await t.test(
    "reuses one activity with multiple tags while freezing closed cycles",
    async () => {
      const userId = await expectedStableUserId("owner@example.com");
      const requirementIds = [
        "requirement-second-ethics",
        "requirement-second-live",
      ];
      const database = new FakeDatabase({
        resolveFirst(call) {
          if (isOwnedActivityCycleLookup(call.sql)) {
            return {
              id: call.bindings[0],
              totalUnits: 3,
              completionDate: "2027-05-20",
            };
          }
          if (isOwnedCredentialCycleLookup(call.sql)) {
            return {
              id: call.bindings[0],
              status:
                call.bindings[0] === "credential-renewed"
                  ? "renewed"
                  : "active",
              cycleStart: "2027-01-01",
              deadline: "2028-01-01",
            };
          }
          if (
            /FROM activity_allocations WHERE activity_id = \? AND credential_id = \?/i.test(
              call.sql,
            )
          ) {
            return null;
          }
          return null;
        },
        resolveAll(call) {
          if (isRequirementTagLookup(call.sql)) {
            return requirementIds.map((id) => ({
              id,
              name:
                id === "requirement-second-ethics"
                  ? "Ethics"
                  : "Participatory",
              isActive: 1,
              applicabilityStatus: "applies",
            }));
          }
          return [];
        },
      });
      testCloudflareEnv.DB = database;

      const response = await postWorkspace("addActivityAllocation", {
        activityId: "activity-shared",
        credentialId: "credential-second",
        requirementIds,
        allocatedUnits: 3,
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.ok, true);
      assert.equal(result.action, "addActivityAllocation");

      const allocationInsert = flattenedStatements(database).find((statement) =>
        /^INSERT INTO activity_allocations \(/i.test(statement.sql),
      );
      assert.ok(allocationInsert);
      assert.deepEqual(allocationInsert.bindings.slice(1), [
        "activity-shared",
        "credential-second",
        requirementIds[0],
        3,
      ]);
      const matchInserts = flattenedStatements(database).filter((statement) =>
        /^INSERT INTO activity_requirement_matches \(/i.test(statement.sql),
      );
      assert.equal(matchInserts.length, 2);
      assert.deepEqual(
        matchInserts.map((statement) => statement.bindings.slice(1)),
        requirementIds.map((requirementId) => [
          userId,
          allocationInsert.bindings[0],
          requirementId,
          3,
        ]),
      );
      const activityLookup = database.calls.find(
        (call) =>
          call.method === "first" && isOwnedActivityCycleLookup(call.sql),
      );
      const credentialLookup = database.calls.find(
        (call) =>
          call.method === "first" &&
          isOwnedCredentialCycleLookup(call.sql),
      );
      const requirementLookup = database.calls.find(
        (call) =>
          call.method === "all" && isRequirementTagLookup(call.sql),
      );
      assert.deepEqual(activityLookup.bindings, ["activity-shared", userId]);
      assert.deepEqual(credentialLookup.bindings, [
        "credential-second",
        userId,
      ]);
      assert.deepEqual(requirementLookup.bindings, [
        "credential-second",
        userId,
        ...requirementIds,
      ]);

      const overAllocationResponse = await postWorkspace(
        "addActivityAllocation",
        {
          activityId: "activity-shared",
          credentialId: "credential-third",
          requirementId: null,
          allocatedUnits: 3.01,
        },
      );
      assert.equal(overAllocationResponse.status, 400);
      assert.match(
        (await overAllocationResponse.json()).error,
        /cannot exceed the activity total for one credential/i,
      );

      const closedCycleResponse = await postWorkspace(
        "addActivityAllocation",
        {
          activityId: "activity-shared",
          credentialId: "credential-renewed",
          requirementId: null,
          allocatedUnits: 1,
        },
      );
      assert.equal(closedCycleResponse.status, 409);
      assert.deepEqual(await closedCycleResponse.json(), {
        error: "This renewal cycle is closed and cannot receive activities.",
        code: "cycle_closed",
      });
    },
  );

  await t.test(
    "groups multi-credential allocations and calculates reminder occurrences",
    async () => {
      const today = new Date().toISOString().slice(0, 10);
      const taskDueDate = shiftIsoDate(today, 10);
      const deadline = shiftIsoDate(today, 2);
      const submittedDate = shiftIsoDate(today, -8);
      const database = new FakeDatabase({
        resolveFirst(call) {
          if (/FROM profiles p WHERE p\.user_id = \?/i.test(call.sql)) {
            return { weeklyGoal: 4, xp: 0, weekActions: 0 };
          }
          if (
            /FROM reminder_preferences WHERE user_id = \?/i.test(call.sql)
          ) {
            return {
              inAppEnabled: 1,
              leadDays: "[30,7,1]",
              timeZone: "UTC",
            };
          }
          return null;
        },
        resolveAll(call) {
          if (
            /FROM activities a LEFT JOIN activity_allocations alloc/i.test(
              call.sql,
            )
          ) {
            const base = {
              id: "activity-grouped",
              title: "Shared ethics course",
              provider: "Professional Institute",
              completionDate: shiftIsoDate(today, -14),
              totalUnits: 3,
              evidenceStatus: "attached",
              evidenceReference: "proof.pdf",
              evidenceCount: 1,
              allocatedUnits: 3,
            };
            return [
              {
                ...base,
                allocationId: "allocation-one",
                credentialId: "credential-one",
                credentialName: "License One",
                requirementId: "requirement-one",
                categoryName: "Ethics",
              },
              {
                ...base,
                allocationId: "allocation-two",
                credentialId: "credential-two",
                credentialName: "License Two",
                requirementId: "requirement-two",
                categoryName: "Ethics",
              },
            ];
          }
          if (
            /FROM checklist_tasks task JOIN credentials credential/i.test(
              call.sql,
            )
          ) {
            return [
              {
                taskId: "task-due",
                credentialId: "credential-one",
                credentialName: "License One",
                title: "Upload final proof",
                dueDate: taskDueDate,
              },
            ];
          }
          if (
            /FROM credentials credential LEFT JOIN renewal_submissions submission/i.test(
              call.sql,
            )
          ) {
            return [
              {
                credentialId: "credential-active",
                credentialName: "Active License",
                status: "active",
                deadline,
                submittedAt: null,
              },
              {
                credentialId: "credential-submitted",
                credentialName: "Submitted License",
                status: "submitted",
                deadline: shiftIsoDate(today, 30),
                submittedAt: `${submittedDate}T15:30:00.000Z`,
              },
            ];
          }
          if (/FROM reminder_states WHERE user_id = \?/i.test(call.sql)) {
            return [];
          }
          return [];
        },
      });
      testCloudflareEnv.DB = database;

      const response = await fetchWorker(
        "https://license-lantern.example/api/workspace",
        { headers: authHeaders() },
      );
      assert.equal(response.status, 200);
      const workspace = await response.json();
      assert.equal(workspace.activities.length, 1);
      assert.equal(workspace.activities[0].id, "activity-grouped");
      assert.deepEqual(
        workspace.activities[0].allocations.map((allocation) => ({
          id: allocation.id,
          credentialId: allocation.credentialId,
          allocatedUnits: allocation.allocatedUnits,
        })),
        [
          {
            id: "allocation-one",
            credentialId: "credential-one",
            allocatedUnits: 3,
          },
          {
            id: "allocation-two",
            credentialId: "credential-two",
            allocatedUnits: 3,
          },
        ],
      );
      assert.deepEqual(workspace.reminderPreferences, {
        inAppEnabled: true,
        leadDays: [30, 7, 1],
        timeZone: "UTC",
      });

      const taskReminder = workspace.reminders.find(
        (reminder) =>
          reminder.key === `task:task-due:${taskDueDate}`,
      );
      const deadlineReminder = workspace.reminders.find(
        (reminder) =>
          reminder.key ===
          `deadline:credential-active:${deadline}`,
      );
      const acceptanceReminder = workspace.reminders.find(
        (reminder) =>
          reminder.key ===
          `acceptance:credential-submitted:${submittedDate}`,
      );
      assert.ok(taskReminder);
      assert.ok(deadlineReminder);
      assert.ok(acceptanceReminder);
      assert.equal(
        taskReminder.scheduledFor,
        shiftIsoDate(taskDueDate, -30),
      );
      assert.equal(
        deadlineReminder.scheduledFor,
        shiftIsoDate(deadline, -7),
      );
      assert.equal(
        acceptanceReminder.scheduledFor,
        shiftIsoDate(submittedDate, 7),
      );
      assert.equal(taskReminder.urgency, "soon");
      assert.equal(deadlineReminder.urgency, "soon");
      assert.equal(acceptanceReminder.urgency, "overdue");
    },
  );

  await t.test(
    "dedupes nested rollups, groups tags, and caps maximum credit",
    async () => {
      const credentialId = "credential-rich-progress";
      const requirementRows = [
        {
          id: "requirement-parent",
          credentialId,
          name: "Professional Responsibility",
          requiredUnits: 3,
          kind: "minimum",
          relation: "independent",
          parentRequirementId: null,
          applicability: "always",
          applicabilityStatus: "applies",
          conditionNote: null,
          isActive: 1,
          rawEarned: 0,
        },
        {
          id: "requirement-ethics",
          credentialId,
          name: "Ethics",
          requiredUnits: 2,
          kind: "minimum",
          relation: "nested",
          parentRequirementId: "requirement-parent",
          applicability: "always",
          applicabilityStatus: "applies",
          conditionNote: null,
          isActive: 1,
          rawEarned: 10,
        },
        {
          id: "requirement-bias",
          credentialId,
          name: "Bias",
          requiredUnits: 1,
          kind: "minimum",
          relation: "nested",
          parentRequirementId: "requirement-parent",
          applicability: "always",
          applicabilityStatus: "applies",
          conditionNote: null,
          isActive: 1,
          rawEarned: 4,
        },
        {
          id: "requirement-participatory",
          credentialId,
          name: "Participatory",
          requiredUnits: 4,
          kind: "minimum",
          relation: "overlapping",
          parentRequirementId: null,
          applicability: "always",
          applicabilityStatus: "applies",
          conditionNote: null,
          isActive: 1,
          rawEarned: 4,
        },
        {
          id: "requirement-self-study",
          credentialId,
          name: "Self-study",
          requiredUnits: 4,
          kind: "maximum",
          relation: "overlapping",
          parentRequirementId: null,
          applicability: "always",
          applicabilityStatus: "applies",
          conditionNote: null,
          isActive: 1,
          rawEarned: 6,
        },
        {
          id: "requirement-special-role",
          credentialId,
          name: "Special Role Training",
          requiredUnits: 2,
          kind: "minimum",
          relation: "independent",
          parentRequirementId: null,
          applicability: "conditional",
          applicabilityStatus: "needs_confirmation",
          conditionNote: "Confirm the role for this cycle.",
          isActive: 0,
          rawEarned: 0,
        },
      ];
      const activityRows = [
        {
          id: "activity-a",
          title: "Equal-unit workshop A",
          provider: "Professional Institute",
          completionDate: "2027-02-01",
          totalUnits: 2,
          evidenceStatus: "attached",
          evidenceReference: null,
          evidenceCount: 1,
          allocationId: "allocation-a",
          credentialId,
          credentialName: "Rich Semantics License",
          requirementId: "requirement-ethics",
          categoryName: "Ethics",
          allocatedUnits: 2,
        },
        {
          id: "activity-b",
          title: "Equal-unit workshop B",
          provider: "Professional Institute",
          completionDate: "2027-03-01",
          totalUnits: 2,
          evidenceStatus: "attached",
          evidenceReference: null,
          evidenceCount: 1,
          allocationId: "allocation-b",
          credentialId,
          credentialName: "Rich Semantics License",
          requirementId: "requirement-ethics",
          categoryName: "Ethics",
          allocatedUnits: 2,
        },
        {
          id: "activity-c",
          title: "Self-study course C",
          provider: "Professional Institute",
          completionDate: "2027-04-01",
          totalUnits: 3,
          evidenceStatus: "missing",
          evidenceReference: null,
          evidenceCount: 0,
          allocationId: "allocation-c",
          credentialId,
          credentialName: "Rich Semantics License",
          requirementId: "requirement-ethics",
          categoryName: "Ethics",
          allocatedUnits: 3,
        },
        {
          id: "activity-d",
          title: "Self-study course D",
          provider: "Professional Institute",
          completionDate: "2027-05-01",
          totalUnits: 3,
          evidenceStatus: "missing",
          evidenceReference: null,
          evidenceCount: 0,
          allocationId: "allocation-d",
          credentialId,
          credentialName: "Rich Semantics License",
          requirementId: "requirement-ethics",
          categoryName: "Ethics",
          allocatedUnits: 3,
        },
      ];
      const activityMatchRows = [];
      const addMatches = (activityId, allocationId, units, requirements) => {
        requirements.forEach(([requirementId, categoryName], index) => {
          activityMatchRows.push({
            id: `${allocationId}-match-${index}`,
            activityId,
            allocationId,
            credentialId,
            requirementId,
            categoryName,
            matchedUnits: units,
          });
        });
      };
      addMatches("activity-a", "allocation-a", 2, [
        ["requirement-ethics", "Ethics"],
        ["requirement-bias", "Bias"],
        ["requirement-participatory", "Participatory"],
      ]);
      addMatches("activity-b", "allocation-b", 2, [
        ["requirement-ethics", "Ethics"],
        ["requirement-bias", "Bias"],
        ["requirement-participatory", "Participatory"],
      ]);
      addMatches("activity-c", "allocation-c", 3, [
        ["requirement-ethics", "Ethics"],
        ["requirement-self-study", "Self-study"],
      ]);
      addMatches("activity-d", "allocation-d", 3, [
        ["requirement-ethics", "Ethics"],
        ["requirement-self-study", "Self-study"],
      ]);

      const database = new FakeDatabase({
        resolveFirst(call) {
          if (/FROM profiles p WHERE p\.user_id = \?/i.test(call.sql)) {
            return { weeklyGoal: 4, xp: 0, weekActions: 0 };
          }
          return null;
        },
        resolveAll(call) {
          if (/FROM credentials c LEFT JOIN rule_sets rs/i.test(call.sql)) {
            return [
              {
                id: credentialId,
                credentialName: "Rich Semantics License",
                profession: "Testing",
                jurisdiction: "Test State",
                issuer: "Test Board",
                deadline: "2027-12-31",
                cycleStart: "2027-01-01",
                totalRequired: 10,
                unitLabel: "hours",
                cycleMonths: 12,
                seriesId: "series-rich",
                previousCredentialId: null,
                status: "active",
                submittedAt: null,
                confirmationNumber: null,
                submissionProof: null,
                acceptedAt: null,
                acceptanceReference: null,
                nextCredentialId: null,
                sourceUrl: null,
                ruleReviewStatus: "custom",
                totalEarned: 10,
              },
            ];
          }
          if (
            /FROM credential_requirements req JOIN credentials c/i.test(
              call.sql,
            )
          ) {
            return requirementRows;
          }
          if (
            /FROM activities a LEFT JOIN activity_allocations alloc/i.test(
              call.sql,
            )
          ) {
            return activityRows;
          }
          if (
            /FROM activity_requirement_matches match JOIN activity_allocations allocation/i.test(
              call.sql,
            )
          ) {
            return activityMatchRows;
          }
          return [];
        },
      });
      testCloudflareEnv.DB = database;

      const response = await fetchWorker(
        "https://license-lantern.example/api/workspace",
        { headers: authHeaders() },
      );
      assert.equal(response.status, 200);
      const workspace = await response.json();
      const credential = workspace.credentials.find(
        (candidate) => candidate.id === credentialId,
      );
      assert.ok(credential);
      assert.deepEqual(
        {
          totalRawEarned: credential.totalRawEarned,
          totalExcessUnits: credential.totalExcessUnits,
          totalEarned: credential.totalEarned,
          totalRemaining: credential.totalRemaining,
          totalProgressPercent: credential.totalProgressPercent,
        },
        {
          totalRawEarned: 10,
          totalExcessUnits: 2,
          totalEarned: 8,
          totalRemaining: 2,
          totalProgressPercent: 80,
        },
      );
      const progressById = new Map(
        credential.requirements.map((requirement) => [
          requirement.id,
          requirement,
        ]),
      );
      assert.deepEqual(
        {
          rawEarned: progressById.get("requirement-parent").rawEarned,
          countableEarned:
            progressById.get("requirement-parent").countableEarned,
          remainingUnits:
            progressById.get("requirement-parent").remainingUnits,
        },
        { rawEarned: 10, countableEarned: 10, remainingUnits: 0 },
        "two sibling matches on the same allocation must roll up once",
      );
      assert.deepEqual(
        {
          rawEarned: progressById.get("requirement-self-study").rawEarned,
          countableEarned:
            progressById.get("requirement-self-study").countableEarned,
          excessUnits: progressById.get("requirement-self-study").excessUnits,
          earnedUnits: progressById.get("requirement-self-study").earnedUnits,
          remainingUnits:
            progressById.get("requirement-self-study").remainingUnits,
          progressPercent:
            progressById.get("requirement-self-study").progressPercent,
        },
        {
          rawEarned: 6,
          countableEarned: 4,
          excessUnits: 2,
          earnedUnits: 4,
          remainingUnits: null,
          progressPercent: 100,
        },
      );
      assert.deepEqual(
        {
          isActive: progressById.get("requirement-special-role").isActive,
          rawEarned: progressById.get("requirement-special-role").rawEarned,
          countableEarned:
            progressById.get("requirement-special-role").countableEarned,
          applicabilityStatus:
            progressById.get("requirement-special-role").applicabilityStatus,
          remainingUnits:
            progressById.get("requirement-special-role").remainingUnits,
          progressPercent:
            progressById.get("requirement-special-role").progressPercent,
        },
        {
          isActive: false,
          rawEarned: 0,
          countableEarned: 0,
          applicabilityStatus: "needs_confirmation",
          remainingUnits: null,
          progressPercent: null,
        },
      );

      assert.equal(workspace.activities.length, 4);
      assert.deepEqual(
        workspace.activities
          .map((activity) => activity.totalUnits)
          .sort((a, b) => a - b),
        [2, 2, 3, 3],
        "equal-unit activities must remain distinct in the overall total",
      );
      const firstActivity = workspace.activities.find(
        (activity) => activity.id === "activity-a",
      );
      assert.ok(firstActivity);
      assert.equal(firstActivity.allocations.length, 1);
      assert.deepEqual(firstActivity.allocations[0].requirementIds, [
        "requirement-ethics",
        "requirement-bias",
        "requirement-participatory",
      ]);
      assert.deepEqual(firstActivity.allocations[0].categoryNames, [
        "Ethics",
        "Bias",
        "Participatory",
      ]);
      assert.equal(firstActivity.allocations[0].requirementMatches.length, 3);
      assert.equal(firstActivity.allocations[0].allocatedUnits, 2);

      const totalQuery = database.calls.find(
        (call) =>
          call.method === "all" &&
          /FROM credentials c LEFT JOIN rule_sets rs/i.test(call.sql),
      );
      assert.ok(totalQuery);
      assert.match(totalQuery.sql, /SUM\(alloc\.allocated_units\)/i);
      assert.doesNotMatch(
        totalQuery.sql,
        /activity_requirement_matches|SUM\(DISTINCT/i,
      );
    },
  );

  await t.test(
    "persists normalized reminder preferences and owner-scoped occurrence state",
    async () => {
      const userId = await expectedStableUserId("owner@example.com");
      const deadline = "2028-12-31";
      const database = new FakeDatabase({
        resolveFirst(call) {
          if (
            /SELECT id, deadline FROM credentials WHERE id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return { id: call.bindings[0], deadline };
          }
          if (
            /FROM reminder_states WHERE user_id = \? AND reminder_key = \?/i.test(
              call.sql,
            )
          ) {
            return null;
          }
          return null;
        },
      });
      testCloudflareEnv.DB = database;

      const preferenceResponse = await postWorkspace(
        "updateReminderPreferences",
        {
          inAppEnabled: true,
          leadDays: [7, 90, 7, 1],
          timeZone: "America/New_York",
        },
      );
      assert.equal(preferenceResponse.status, 200);
      assert.deepEqual(await preferenceResponse.json(), {
        ok: true,
        action: "updateReminderPreferences",
        id: "reminder-preferences",
      });
      const preferenceUpsert = database.calls.find(
        (call) =>
          call.method === "run" &&
          /^INSERT INTO reminder_preferences \(/i.test(call.sql),
      );
      assert.ok(preferenceUpsert);
      assert.deepEqual(preferenceUpsert.bindings, [
        userId,
        1,
        "[90,7,1]",
        "America/New_York",
      ]);

      const invalidZoneResponse = await postWorkspace(
        "updateReminderPreferences",
        {
          inAppEnabled: true,
          leadDays: [30],
          timeZone: "Mars/Olympus_Mons",
        },
      );
      assert.equal(invalidZoneResponse.status, 400);
      assert.deepEqual(await invalidZoneResponse.json(), {
        error: "timeZone must be a valid IANA time zone",
        code: "invalid_time_zone",
      });

      const reminderKey = `deadline:credential-reminder:${deadline}`;
      const stateResponse = await postWorkspace("setReminderState", {
        reminderKey,
        credentialId: "credential-reminder",
        status: "dismissed",
        snoozedUntil: null,
      });
      assert.equal(stateResponse.status, 200);
      const stateResult = await stateResponse.json();
      assert.equal(stateResult.ok, true);
      assert.equal(stateResult.action, "setReminderState");
      const stateUpsert = database.calls.find(
        (call) =>
          call.method === "run" &&
          /^INSERT INTO reminder_states \(/i.test(call.sql),
      );
      assert.ok(stateUpsert);
      assert.deepEqual(stateUpsert.bindings.slice(1), [
        userId,
        "credential-reminder",
        reminderKey,
        "dismissed",
        null,
      ]);
      assert.equal(
        database.calls.some((call) =>
          /^UPDATE credentials\b/i.test(call.sql),
        ),
        false,
      );

      const crossOwnerDatabase = new FakeDatabase();
      testCloudflareEnv.DB = crossOwnerDatabase;
      const crossOwnerResponse = await postWorkspace("setReminderState", {
        reminderKey,
        credentialId: "credential-reminder",
        status: "dismissed",
        snoozedUntil: null,
      });
      assert.equal(crossOwnerResponse.status, 404);
      assert.deepEqual(await crossOwnerResponse.json(), {
        error: "Credential not found.",
        code: "credential_not_found",
      });
      assert.equal(
        crossOwnerDatabase.calls.some(
          (call) =>
            call.method === "run" &&
            /^INSERT INTO reminder_states \(/i.test(call.sql),
        ),
        false,
      );
    },
  );

  await t.test(
    "rolls rich requirement snapshots forward idempotently without credit carryover",
    async () => {
      const userId = await expectedStableUserId("owner@example.com");
      const database = new FakeDatabase({
        resolveFirst(call) {
          if (
            /SELECT next_credential_id AS nextCredentialId FROM renewal_acceptances/i.test(
              call.sql,
            )
          ) {
            return null;
          }
          if (
            /FROM credentials credential LEFT JOIN credential_cycle_links cycle/i.test(
              call.sql,
            )
          ) {
            return {
              id: "credential-prior",
              ruleSetId: null,
              credentialName: "Certified Test Professional",
              profession: "Testing",
              jurisdiction: "Test State",
              issuer: "Test Board",
              status: "submitted",
              totalRequired: 12,
              unitLabel: "hours",
              seriesId: "series-one",
              cycleMonths: 24,
            };
          }
          if (
            /FROM renewal_submissions WHERE credential_id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return {
              id: "submission-prior",
              submittedAt: "2028-02-20T15:00:00.000Z",
            };
          }
          return null;
        },
        resolveAll(call) {
          if (
            /FROM credential_requirements requirement JOIN credentials credential/i.test(
              call.sql,
            )
          ) {
            return [
              {
                id: "requirement-general",
                ruleCategoryId: null,
                name: "General",
                requiredUnits: 10,
                kind: "minimum",
                relation: "independent",
                parentRequirementId: null,
                applicability: "always",
                conditionNote: null,
                sortOrder: 0,
              },
              {
                id: "requirement-ethics",
                ruleCategoryId: null,
                name: "Ethics",
                requiredUnits: 2,
                kind: "minimum",
                relation: "nested",
                parentRequirementId: "requirement-general",
                applicability: "conditional",
                conditionNote:
                  "Confirm whether the ethics condition applies this cycle.",
                sortOrder: 1,
              },
              {
                id: "requirement-self-study",
                ruleCategoryId: null,
                name: "Self-study",
                requiredUnits: 4,
                kind: "maximum",
                relation: "overlapping",
                parentRequirementId: null,
                applicability: "optional",
                conditionNote: "No more than four self-study hours count.",
                sortOrder: 2,
              },
            ];
          }
          return [];
        },
      });
      testCloudflareEnv.DB = database;

      const response = await postWorkspace("markRenewalAccepted", {
        credentialId: "credential-prior",
        acceptedAt: "2028-02-25",
        reference: "ACCEPT-204",
        nextCycleStart: "2028-03-01",
        nextDeadline: "2030-03-01",
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.ok, true);
      assert.equal(result.action, "markRenewalAccepted");
      const nextCredentialId = result.id;
      assert.match(nextCredentialId, /^[0-9a-f-]{36}$/i);

      const statements = flattenedStatements(database);
      const nextCredentialInsert = statements.find((statement) =>
        /^INSERT INTO credentials \(/i.test(statement.sql),
      );
      const nextCycleLink = statements.find((statement) =>
        /^INSERT INTO credential_cycle_links \(/i.test(statement.sql),
      );
      const acceptanceInsert = statements.find((statement) =>
        /^INSERT INTO renewal_acceptances \(/i.test(statement.sql),
      );
      const oldCycleUpdate = statements.find((statement) =>
        /^UPDATE credentials SET status = 'renewed'/i.test(statement.sql),
      );
      const requirementSnapshots = statements.filter((statement) =>
        /^INSERT INTO credential_requirements \(/i.test(statement.sql),
      );
      const nextTasks = statements.filter((statement) =>
        /^INSERT INTO checklist_tasks \(/i.test(statement.sql),
      );
      assert.ok(nextCredentialInsert);
      assert.ok(nextCycleLink);
      assert.ok(acceptanceInsert);
      assert.ok(oldCycleUpdate);
      assert.deepEqual(nextCredentialInsert.bindings, [
        nextCredentialId,
        userId,
        null,
        "Certified Test Professional",
        "Testing",
        "Test State",
        "Test Board",
        "2028-03-01",
        "2030-03-01",
        12,
        "hours",
      ]);
      assert.deepEqual(nextCycleLink.bindings.slice(1), [
        userId,
        nextCredentialId,
        "series-one",
        "credential-prior",
        24,
      ]);
      assert.equal(requirementSnapshots.length, 3);
      const snapshotByName = new Map(
        requirementSnapshots.map((statement) => [
          statement.bindings[3],
          statement,
        ]),
      );
      const generalSnapshot = snapshotByName.get("General");
      const ethicsSnapshot = snapshotByName.get("Ethics");
      const maximumSnapshot = snapshotByName.get("Self-study");
      assert.ok(generalSnapshot);
      assert.ok(ethicsSnapshot);
      assert.ok(maximumSnapshot);
      assert.deepEqual(generalSnapshot.bindings.slice(1), [
        nextCredentialId,
        null,
        "General",
        10,
        "minimum",
        "independent",
        null,
        "always",
        "applies",
        null,
        1,
        0,
      ]);
      assert.notEqual(
        generalSnapshot.bindings[0],
        "requirement-general",
        "the new cycle must receive fresh requirement IDs",
      );
      assert.deepEqual(ethicsSnapshot.bindings.slice(1), [
        nextCredentialId,
        null,
        "Ethics",
        2,
        "minimum",
        "nested",
        generalSnapshot.bindings[0],
        "conditional",
        "needs_confirmation",
        "Confirm whether the ethics condition applies this cycle.",
        0,
        1,
      ]);
      assert.notEqual(
        ethicsSnapshot.bindings[7],
        "requirement-general",
        "nested parents must be remapped away from the prior cycle",
      );
      assert.deepEqual(maximumSnapshot.bindings.slice(1), [
        nextCredentialId,
        null,
        "Self-study",
        4,
        "maximum",
        "overlapping",
        null,
        "optional",
        "applies",
        "No more than four self-study hours count.",
        1,
        2,
      ]);
      assert.equal(nextTasks.length, 3);
      assert.ok(
        nextTasks.every(
          (statement) =>
            statement.bindings[1] === userId &&
            statement.bindings[2] === nextCredentialId,
        ),
      );
      assert.deepEqual(acceptanceInsert.bindings, [
        acceptanceInsert.bindings[0],
        userId,
        "credential-prior",
        "submission-prior",
        "2028-02-25",
        "ACCEPT-204",
        nextCredentialId,
      ]);
      assert.deepEqual(oldCycleUpdate.bindings, [
        "credential-prior",
        userId,
      ]);
      assert.equal(
        statements.some((statement) =>
          /^INSERT INTO (activities|activity_allocations|activity_requirement_matches|renewal_submissions) \(/i.test(
            statement.sql,
          ),
        ),
        false,
      );

      const retryDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (
            /SELECT next_credential_id AS nextCredentialId FROM renewal_acceptances/i.test(
              call.sql,
            )
          ) {
            return { nextCredentialId: "credential-existing-next" };
          }
          return null;
        },
      });
      testCloudflareEnv.DB = retryDatabase;
      const retryResponse = await postWorkspace("markRenewalAccepted", {
        credentialId: "credential-prior",
        acceptedAt: "2028-02-25",
        reference: "ACCEPT-204",
        nextCycleStart: "2028-03-01",
        nextDeadline: "2030-03-01",
      });
      assert.equal(retryResponse.status, 200);
      assert.deepEqual(await retryResponse.json(), {
        ok: true,
        action: "markRenewalAccepted",
        id: "credential-existing-next",
      });
      assert.equal(
        flattenedStatements(retryDatabase).some((statement) =>
          /^INSERT INTO (credentials|credential_requirements) \(/i.test(
            statement.sql,
          ),
        ),
        false,
      );

      const routeSource = await readFile(
        new URL("../app/api/workspace/route.ts", import.meta.url),
        "utf8",
      );
      assert.match(
        routeSource,
        /LEFT JOIN renewal_acceptances acceptance[\s\S]*?acceptance\.accepted_at AS acceptedAt/i,
      );
      assert.match(
        routeSource,
        /WHERE c\.user_id = \?[\s\S]*?GROUP BY c\.id/i,
      );
    },
  );
});
