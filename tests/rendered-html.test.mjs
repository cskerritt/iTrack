import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
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
  return /SELECT id, status,(?: rule_set_id AS ruleSetId,)? cycle_start AS cycleStart, deadline FROM credentials WHERE id = \? AND user_id = \?/i.test(
    sql,
  );
}

function isOwnedActivityCycleLookup(sql) {
  return /SELECT id, total_units AS totalUnits, completion_date AS completionDate, evidence_status AS evidenceStatus(?:, revision)?(?:, archived_at AS archivedAt)? FROM activities WHERE id = \? AND user_id = \?/i.test(
    sql,
  );
}

function isOwnedEvidenceForDeletionLookup(sql) {
  return /FROM evidence_files WHERE id = \? AND user_id = \? AND status IN \('ready', 'deleting'\)/i.test(
    sql,
  );
}

function isOwnedMutableActivityLookup(sql) {
  return /SELECT activity\.id, activity\.archived_at AS archivedAt, EXISTS \( SELECT 1 FROM activity_allocations allocation JOIN credentials credential ON credential\.id = allocation\.credential_id WHERE allocation\.activity_id = activity\.id AND credential\.user_id = activity\.user_id AND credential\.status = 'renewed' \) AS usedByClosedCycle FROM activities activity WHERE activity\.id = \? AND activity\.user_id = \?/i.test(
    sql,
  );
}

function isRequirementTagLookup(sql) {
  return /SELECT requirement\.id, requirement\.name,[\s\S]*?requirement\.is_active AS isActive,[\s\S]*?requirement\.applicability_status AS applicabilityStatus,[\s\S]*?requirement\.exclusive_group AS exclusiveGroup FROM credential_requirements requirement JOIN credentials credential[\s\S]*?requirement\.id IN \(/i.test(
    sql,
  );
}

function isRequiredMaximumGroupLookup(sql) {
  return (
    /SELECT DISTINCT requirement\.exclusive_group AS exclusiveGroup FROM credential_requirements requirement JOIN credentials credential/i.test(
      sql,
    ) &&
    /requirement\.kind = 'maximum'/i.test(sql) &&
    /requirement\.exclusive_group IS NOT NULL/i.test(sql)
  );
}

function isApplicabilityRequirementsLookup(sql) {
  return /SELECT requirement\.id, requirement\.name,[\s\S]*?requirement\.relation,[\s\S]*?requirement\.parent_requirement_id AS parentRequirementId,[\s\S]*?requirement\.applicability,[\s\S]*?requirement\.applicability_status AS applicabilityStatus[\s\S]*?FROM credential_requirements requirement JOIN credentials credential/i.test(
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
    const resolved = await this.database.resolveRun(call);
    if (resolved !== undefined) return resolved;
    return { success: true, meta: {} };
  }
}

class FakeDatabase {
  constructor({ resolveFirst, resolveAll, resolveBatch, resolveRun } = {}) {
    this.calls = [];
    this.batches = [];
    this.resolveFirst = resolveFirst ?? (() => null);
    this.resolveAll = resolveAll ?? (() => []);
    this.resolveBatch = resolveBatch ?? (() => undefined);
    this.resolveRun = resolveRun ?? (() => undefined);
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
    const resolved = await this.resolveBatch(snapshot);
    if (resolved !== undefined) return resolved;
    return snapshot.map(() => ({ success: true, results: [], meta: {} }));
  }
}

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

async function expectedDraftStorageNamespace(email) {
  const userId = await expectedStableUserId(email);
  const bytes = new TextEncoder().encode(
    `license-lantern:activity-draft:v1:${userId}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `draft_${hex}`;
}

function shiftIsoDate(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function mondayOfWeek(isoDate) {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function sourceLiteralArrayAround(source, marker) {
  const markerIndex = source.indexOf(`"${marker}"`);
  assert.notEqual(markerIndex, -1, `missing source marker ${marker}`);
  const start = source.lastIndexOf("[", markerIndex);
  assert.notEqual(start, -1, `missing array for ${marker}`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(
          source.slice(start, index + 1).replace(/,\s*]/g, "]"),
        );
      }
    }
  }
  assert.fail(`unterminated source array for ${marker}`);
}

function flattenedStatements(database) {
  return database.batches.flat();
}

const runtimeCatalogModules = [
  {
    moduleName: "comptia",
    sourceUrl: new URL("../db/catalog/comptia.ts", import.meta.url),
    exports: [
      "COMPTIA_CATEGORY_SEED_BINDINGS",
      "COMPTIA_RULE_SET_IDS",
      "COMPTIA_RULE_SET_SEED_BINDINGS",
    ],
  },
  {
    moduleName: "isc2",
    sourceUrl: new URL("../db/catalog/isc2.ts", import.meta.url),
    exports: [
      "ISC2_CATEGORY_SEED_BINDINGS",
      "ISC2_RULE_SET_SEED_BINDINGS",
    ],
  },
  {
    moduleName: "insurance",
    sourceUrl: new URL("../db/catalog/insurance.ts", import.meta.url),
    exports: [
      "INSURANCE_CATEGORY_SEED_BINDINGS",
      "INSURANCE_RULE_SET_SEED_BINDINGS",
    ],
  },
  {
    moduleName: "nremt",
    sourceUrl: new URL("../db/catalog/nremt.ts", import.meta.url),
    exports: [
      "NREMT_CATEGORY_SEED_BINDINGS",
      "NREMT_RULE_SET_SEED_BINDINGS",
    ],
  },
  {
    moduleName: "education",
    sourceUrl: new URL("../db/catalog/education.ts", import.meta.url),
    exports: [
      "EDUCATION_CATEGORY_SEED_BINDINGS",
      "EDUCATION_MAXIMUM_CLASSIFICATION_RULE_SET_IDS",
      "EDUCATION_RULE_SET_SEED_BINDINGS",
    ],
  },
  {
    moduleName: "mentalHealth",
    sourceUrl: new URL("../db/catalog/mentalHealth.ts", import.meta.url),
    exports: [
      "MENTAL_HEALTH_CATEGORY_SEED_BINDINGS",
      "MENTAL_HEALTH_MAXIMUM_CLASSIFICATION_RULE_SET_IDS",
      "MENTAL_HEALTH_RULE_SET_SEED_BINDINGS",
    ],
  },
  {
    moduleName: "pharmacy",
    sourceUrl: new URL("../db/catalog/pharmacy.ts", import.meta.url),
    exports: [
      "PHARMACY_CATEGORY_SEED_BINDINGS",
      "PHARMACY_MAXIMUM_CLASSIFICATION_RULE_SET_IDS",
      "PHARMACY_RULE_SET_SEED_BINDINGS",
    ],
  },
  {
    moduleName: "nursing",
    sourceUrl: new URL("../db/catalog/nursing.ts", import.meta.url),
    exports: [
      "NURSING_CATEGORY_SEED_BINDINGS",
      "NURSING_MAXIMUM_CLASSIFICATION_RULE_SET_IDS",
      "NURSING_RENEWAL_TASK_COPY_BINDINGS",
      "NURSING_RULE_SET_SEED_BINDINGS",
    ],
  },
];

async function importTypeScriptModule(source) {
  const typescript = await import("typescript");
  let expandedSource = source;
  const injectedBindings = [];
  for (const catalogModule of runtimeCatalogModules) {
    const namesPattern = catalogModule.exports.join("\\s*,\\s*");
    const importPattern = new RegExp(
      `import\\s*\\{\\s*${namesPattern}\\s*,?\\s*\\}\\s*from\\s*["']\\.\\/catalog\\/${catalogModule.moduleName}["'];?`,
    );
    if (!importPattern.test(expandedSource)) continue;
    const catalogSource = await readFile(catalogModule.sourceUrl, "utf8");
    const catalogCompiled = typescript.default.transpileModule(
      catalogSource,
      {
        compilerOptions: {
          module: typescript.default.ModuleKind.ES2022,
          target: typescript.default.ScriptTarget.ES2022,
        },
      },
    ).outputText;
    const loadedCatalog = await import(
      `data:text/javascript;base64,${Buffer.from(catalogCompiled).toString("base64")}`
    );
    for (const exportName of catalogModule.exports) {
      injectedBindings.push(
        `const ${exportName} = ${JSON.stringify(loadedCatalog[exportName])};`,
      );
    }
    expandedSource = expandedSource.replace(importPattern, "");
  }
  const compiled = typescript.default.transpileModule(
    `${injectedBindings.join("\n")}\n${expandedSource}`,
    {
    compilerOptions: {
      module: typescript.default.ModuleKind.ES2022,
      target: typescript.default.ScriptTarget.ES2022,
    },
    },
  ).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
  );
}

async function readBuiltClientAppSource() {
  const assets = await readdir(
    new URL("../dist/client/assets/", import.meta.url),
  );
  const appAsset = assets.find(
    (name) =>
      name.startsWith("LicenseLanternApp-") && name.endsWith(".js"),
  );
  assert.ok(appAsset, "missing built LicenseLanternApp client asset");
  return readFile(
    new URL(`../dist/client/assets/${appAsset}`, import.meta.url),
    "utf8",
  );
}

function pngDimensions(contents) {
  assert.equal(contents.subarray(1, 4).toString("ascii"), "PNG");
  return {
    width: contents.readUInt32BE(16),
    height: contents.readUInt32BE(20),
  };
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

  await t.test(
    "keeps certificate OCR on-device and suggestions reviewable",
    async () => {
      const [
        clientSource,
        ocrSource,
        packageSource,
        builtClientSource,
        typescript,
      ] = await Promise.all([
        readFile(
          new URL("../app/LicenseLanternApp.tsx", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../app/lib/certificateOcr.ts", import.meta.url),
          "utf8",
        ),
        readFile(new URL("../package.json", import.meta.url), "utf8"),
        readFile(
          new URL(
            "../dist/server/ssr/assets/LicenseLanternApp-BvrpzBXC.js",
            import.meta.url,
          ),
          "utf8",
        ).catch(async () => {
          const assets = await readdir(
            new URL("../dist/server/ssr/assets/", import.meta.url),
          );
          const appAsset = assets.find((name) =>
            name.startsWith("LicenseLanternApp-"),
          );
          assert.ok(appAsset);
          return readFile(
            new URL(
              `../dist/server/ssr/assets/${appAsset}`,
              import.meta.url,
            ),
            "utf8",
          );
        }),
        import("typescript"),
      ]);

      const packageJson = JSON.parse(packageSource);
      assert.equal(packageJson.dependencies["tesseract.js"], "7.0.0");
      assert.equal(packageJson.dependencies["@tesseract.js-data/eng"], "1.0.0");
      assert.match(clientSource, /capture="environment"/);
      assert.match(clientSource, /Start with the certificate/);
      assert.match(clientSource, /Review every highlighted suggestion/);
      assert.match(
        clientSource,
        /const evidenceFile = activityEvidenceFile[\s\S]*?result\?\.id && hasEvidenceFile[\s\S]*?uploadEvidence\(result\.id, evidenceFile\)/,
      );
      assert.match(
        ocrSource,
        /workerPath: new URL\("worker\.min\.js", assetRoot\)\.href/,
      );
      assert.match(ocrSource, /corePath: new URL\("core", assetRoot\)\.href/);
      assert.match(ocrSource, /langPath: new URL\("lang", assetRoot\)/);
      assert.doesNotMatch(ocrSource, /https?:\/\/|fetch\(/i);
      assert.match(builtClientSource, /Start with the certificate/);

      const requiredAssets = [
        "worker.min.js",
        "core/tesseract-core-relaxedsimd-lstm.wasm.js",
        "core/tesseract-core-simd-lstm.wasm.js",
        "core/tesseract-core-lstm.wasm.js",
        "lang/eng.traineddata.gz",
      ];
      for (const asset of requiredAssets) {
        const [sourceAsset, builtAsset] = await Promise.all([
          stat(new URL(`../public/ocr/${asset}`, import.meta.url)),
          stat(new URL(`../dist/client/ocr/${asset}`, import.meta.url)),
        ]);
        assert.ok(sourceAsset.size > 100_000, `${asset} source asset is empty`);
        assert.equal(builtAsset.size, sourceAsset.size);
      }

      const compiled = typescript.default.transpileModule(ocrSource, {
        compilerOptions: {
          module: typescript.default.ModuleKind.ES2022,
          target: typescript.default.ScriptTarget.ES2022,
        },
      }).outputText;
      const parser = await import(
        `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
      );
      assert.deepEqual(
        parser.extractCertificateSuggestions(
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
      assert.deepEqual(
        parser.extractCertificateSuggestions(
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
    },
  );

  await t.test(
    "seeds source-linked EMS, educator, and mental-health templates with enforceable boundaries",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new SQLiteD1Database(DatabaseSync);
      const [runtimeSource, workspaceRouteSource, clientSource] =
        await Promise.all([
          readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
          readFile(
            new URL("../app/api/workspace/route.ts", import.meta.url),
            "utf8",
          ),
          readFile(
            new URL("../app/LicenseLanternApp.tsx", import.meta.url),
            "utf8",
          ),
        ]);
      const runtimeModule = await importTypeScriptModule(
        `${runtimeSource}\nexport const __licensedProfessionCatalogNonce = "expanded";`,
      );
      await runtimeModule.initializeDatabase(database);
      testCloudflareEnv.DB = database;
      const raw = database.raw;
      const rows = (sql) =>
        raw
          .prepare(sql)
          .all()
          .map((row) => ({ ...row }));
      const newRuleScope = `(
        rule.id LIKE 'nremt-%'
        OR rule.id LIKE 'ca-child-development-permit-%'
        OR rule.id LIKE 'tx-standard-classroom-teacher-%'
        OR rule.id LIKE 'ny-professional-classroom-teacher-%'
        OR rule.id LIKE 'ny-professional-esol-bilingual-%'
        OR rule.id LIKE 'nj-employed-teacher-%'
        OR rule.id LIKE 'pa-professional-educator-%'
        OR rule.id LIKE 'ca-bbs-%'
        OR rule.id LIKE 'tx-lpc-%'
        OR rule.id LIKE 'ny-lmsw-lcsw-%'
        OR rule.id LIKE 'nj-lpc-%'
        OR rule.id LIKE 'pa-lpc-%'
        OR rule.id LIKE 'fl-lcsw-lmft-lmhc-%'
      )`;

      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 COUNT(*) AS totalRules,
                 SUM(CASE WHEN rule.is_current = 1 THEN 1 ELSE 0 END) AS currentRules,
                 SUM(
                   CASE
                     WHEN rule.last_verified_at = '2026-07-26'
                       AND rule.review_status = 'source_linked_check_conditions'
                       AND rule.source_url LIKE 'https://%'
                     THEN 1 ELSE 0
                   END
                 ) AS verifiedRules
               FROM rule_sets rule
               WHERE ${newRuleScope}`,
            )
            .get(),
        },
        { totalRules: 17, currentRules: 17, verifiedRules: 17 },
      );
      assert.equal(
        raw.prepare("SELECT COUNT(*) AS count FROM rule_categories").get()
          .count,
        505,
      );

      assert.deepEqual(
        rows(
          `SELECT
             rule.id,
             rule.total_units AS totalUnits,
             COUNT(category.id) AS categoryCount,
             SUM(category.required_units) AS requiredTotal,
             COUNT(DISTINCT category.exclusive_group) AS groupCount
           FROM rule_sets rule
           JOIN rule_categories category ON category.rule_set_id = rule.id
           WHERE rule.id LIKE 'nremt-%'
           GROUP BY rule.id, rule.total_units
           ORDER BY rule.total_units`,
        ),
        [
          {
            id: "nremt-emr-nccp-ce-2025-v1",
            totalUnits: 16,
            categoryCount: 9,
            requiredTotal: 24.8,
            groupCount: 1,
          },
          {
            id: "nremt-emt-nccp-ce-2025-v1",
            totalUnits: 40,
            categoryCount: 9,
            requiredTotal: 62,
            groupCount: 1,
          },
          {
            id: "nremt-aemt-nccp-ce-2025-v1",
            totalUnits: 50,
            categoryCount: 9,
            requiredTotal: 77.5,
            groupCount: 1,
          },
          {
            id: "nremt-paramedic-nccp-ce-2025-v1",
            totalUnits: 60,
            categoryCount: 9,
            requiredTotal: 93,
            groupCount: 1,
          },
        ],
      );
      assert.deepEqual(
        rows(
          `SELECT
             rule_set_id AS ruleSetId,
             COUNT(DISTINCT exclusive_group) AS groupCount
           FROM rule_categories
           WHERE rule_set_id LIKE 'fl-lcsw-lmft-lmhc-%'
           GROUP BY rule_set_id
           ORDER BY rule_set_id`,
        ),
        [
          {
            ruleSetId:
              "fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-v1",
            groupCount: 3,
          },
          {
            ruleSetId:
              "fl-lcsw-lmft-lmhc-telehealth-phase-2026-v1",
            groupCount: 3,
          },
        ],
      );
      assert.deepEqual(
        rows(
          `SELECT
             name,
             required_units AS requiredUnits,
             relation,
             parent_category_id AS parentCategoryId,
             exclusive_group AS exclusiveGroup
           FROM rule_categories
           WHERE rule_set_id = 'nremt-emt-nccp-ce-2025-v1'
           ORDER BY sort_order`,
        ),
        [
          {
            name: "National Component",
            requiredUnits: 20,
            relation: "independent",
            parentCategoryId: null,
            exclusiveGroup: "nremt-emt-nccp-ce-2025-component",
          },
          {
            name: "National Topic — Airway",
            requiredUnits: 4,
            relation: "nested",
            parentCategoryId: "nremt-emt-nccp-ce-2025-national",
            exclusiveGroup: null,
          },
          {
            name: "National Topic — Cardiology",
            requiredUnits: 5,
            relation: "nested",
            parentCategoryId: "nremt-emt-nccp-ce-2025-national",
            exclusiveGroup: null,
          },
          {
            name: "National Topic — Trauma",
            requiredUnits: 3,
            relation: "nested",
            parentCategoryId: "nremt-emt-nccp-ce-2025-national",
            exclusiveGroup: null,
          },
          {
            name: "National Topic — Medical",
            requiredUnits: 6,
            relation: "nested",
            parentCategoryId: "nremt-emt-nccp-ce-2025-national",
            exclusiveGroup: null,
          },
          {
            name: "National Topic — Operations",
            requiredUnits: 2,
            relation: "nested",
            parentCategoryId: "nremt-emt-nccp-ce-2025-national",
            exclusiveGroup: null,
          },
          {
            name: "National Pediatric Content",
            requiredUnits: 2,
            relation: "overlapping",
            parentCategoryId: null,
            exclusiveGroup: null,
          },
          {
            name: "Local/State Component",
            requiredUnits: 10,
            relation: "independent",
            parentCategoryId: null,
            exclusiveGroup: "nremt-emt-nccp-ce-2025-component",
          },
          {
            name: "Individual Component",
            requiredUnits: 10,
            relation: "independent",
            parentCategoryId: null,
            exclusiveGroup: "nremt-emt-nccp-ce-2025-component",
          },
        ],
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM rule_sets
             WHERE id LIKE 'nremt-%'
               AND source_title LIKE '%Recertification by Examination is a separate%'
               AND source_title LIKE '%state EMS license%'
               AND source_title LIKE '%post-cap credit%'
               AND (
                 source_title LIKE '%Training Officer%'
                 OR source_title LIKE '%Medical Director%'
               )`,
          )
          .get().count,
        4,
      );

      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 COUNT(DISTINCT rule.id) AS ruleCount,
                 COUNT(category.id) AS categoryCount
               FROM rule_sets rule
               JOIN rule_categories category ON category.rule_set_id = rule.id
               WHERE rule.profession = 'Education'`,
            )
            .get(),
        },
        { ruleCount: 6, categoryCount: 20 },
      );
      assert.deepEqual(
        rows(
          `SELECT
             rule_set_id AS ruleSetId,
             required_units AS requiredUnits
           FROM rule_categories
           WHERE name = 'Language Acquisition Addressing English Language Learners'
           ORDER BY required_units`,
        ),
        [
          {
            ruleSetId:
              "ny-professional-classroom-teacher-standard-ctle-2026-v1",
            requiredUnits: 15,
          },
          {
            ruleSetId: "ny-professional-esol-bilingual-ctle-2026-v1",
            requiredUnits: 50,
          },
        ],
      );
      assert.deepEqual(
        rows(
          `SELECT name, required_units AS requiredUnits, kind
           FROM rule_categories
           WHERE rule_set_id = 'tx-standard-classroom-teacher-2026-v1'
           ORDER BY sort_order`,
        ),
        [
          {
            name: "Other Approved CPE Activity",
            requiredUnits: 0,
            kind: "informational",
          },
          {
            name: "Independent Study",
            requiredUnits: 30,
            kind: "maximum",
          },
          {
            name: "Developing, Teaching, or Presenting CPE",
            requiredUnits: 15,
            kind: "maximum",
          },
          {
            name: "Mentoring Another Educator",
            requiredUnits: 45,
            kind: "maximum",
          },
          {
            name:
              "Listed Classroom-Teacher Topic Pool — confirm current TEA instruction",
            requiredUnits: 0,
            kind: "informational",
          },
        ],
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 source_url AS sourceUrl,
                 source_title LIKE '%§21.054(d-2)%' AS creditsExcess,
                 source_title LIKE '%does not enforce a 37.5-hour minimum%' AS noFalseFloor
               FROM rule_sets
               WHERE id = 'tx-standard-classroom-teacher-2026-v1'`,
            )
            .get(),
        },
        {
          sourceUrl:
            "https://tea.texas.gov/laws-and-rules/sbec-rules-tac/sbec-tac-currently-effect/ch232a-3.pdf",
          creditsExcess: 1,
          noFalseFloor: 1,
        },
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT required_units AS requiredUnits, applicability
               FROM rule_categories
               WHERE id = 'nj-employed-teacher-annual-pd-2026-dyslexia'`,
            )
            .get(),
        },
        { requiredUnits: 2, applicability: "conditional" },
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM rule_sets
             WHERE id = 'nj-employed-teacher-annual-pd-2026-v1'
               AND source_title LIKE '%media-specialist%'
               AND source_title LIKE '%July 1, 2025%'
               AND source_title LIKE '%no statewide numeric duration%'`,
          )
          .get().count,
        1,
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM rule_sets
             WHERE id = 'pa-professional-educator-act-48-2026-v1'
               AND source_title LIKE '%Act 55%'
               AND source_title LIKE '%three hours of school-safety%'
               AND source_title LIKE '%2028–29%'
               AND source_title LIKE '%custom plan%'`,
          )
          .get().count,
        1,
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM rule_sets
             WHERE profession = 'Education'
               AND (
                 jurisdiction = 'Florida'
                 OR credential_name LIKE '%Clear%'
                 OR credential_name LIKE '%Preliminary%'
               )`,
          )
          .get().count,
        0,
      );

      const mentalRuleScope = `(
        rule.id LIKE 'ca-bbs-%'
        OR rule.id LIKE 'tx-lpc-%'
        OR rule.id LIKE 'ny-lmsw-lcsw-%'
        OR rule.id LIKE 'nj-lpc-%'
        OR rule.id LIKE 'pa-lpc-%'
        OR rule.id LIKE 'fl-lcsw-lmft-lmhc-%'
      )`;
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 COUNT(DISTINCT rule.id) AS ruleCount,
                 COUNT(category.id) AS categoryCount,
                 SUM(CASE WHEN category.applicability = 'conditional' THEN 1 ELSE 0 END) AS conditionalCount
               FROM rule_sets rule
               JOIN rule_categories category ON category.rule_set_id = rule.id
               WHERE ${mentalRuleScope}`,
            )
            .get(),
        },
        { ruleCount: 7, categoryCount: 57, conditionalCount: 13 },
      );
      assert.deepEqual(
        rows(
          `SELECT
             rule_set_id AS ruleSetId,
             SUM(required_units) AS requiredTotal,
             COUNT(*) AS bucketCount,
             COUNT(DISTINCT exclusive_group) AS groupCount
           FROM rule_categories
           WHERE rule_set_id LIKE 'fl-lcsw-lmft-lmhc-%'
             AND kind = 'minimum'
             AND relation = 'independent'
           GROUP BY rule_set_id
           ORDER BY rule_set_id`,
        ),
        [
          {
            ruleSetId:
              "fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-v1",
            requiredTotal: 30,
            bucketCount: 3,
            groupCount: 1,
          },
          {
            ruleSetId:
              "fl-lcsw-lmft-lmhc-telehealth-phase-2026-v1",
            requiredTotal: 30,
            bucketCount: 3,
            groupCount: 1,
          },
        ],
      );
      assert.deepEqual(
        rows(
          `SELECT id, required_units AS requiredUnits, kind
           FROM rule_categories
           WHERE id IN (
             'ca-bbs-lmft-lcsw-lpcc-standard-2026-enforcement-case-review',
             'ca-bbs-lmft-lcsw-lpcc-standard-2026-occupational-analysis-survey',
             'nj-lpc-standard-renewal-2026-refereed-articles',
             'nj-lpc-standard-renewal-2026-new-course-program-presentation',
             'fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-administrative-nonclinical',
             'fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-presenter-moderator',
             'fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-disciplinary-board-meeting',
             'fl-lcsw-lmft-lmhc-telehealth-phase-2026-administrative-nonclinical',
             'fl-lcsw-lmft-lmhc-telehealth-phase-2026-presenter-moderator',
             'fl-lcsw-lmft-lmhc-telehealth-phase-2026-disciplinary-board-meeting'
           )
           ORDER BY id`,
        ),
        [
          {
            id: "ca-bbs-lmft-lcsw-lpcc-standard-2026-enforcement-case-review",
            requiredUnits: 6,
            kind: "maximum",
          },
          {
            id: "ca-bbs-lmft-lcsw-lpcc-standard-2026-occupational-analysis-survey",
            requiredUnits: 6,
            kind: "maximum",
          },
          {
            id: "fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-administrative-nonclinical",
            requiredUnits: 6,
            kind: "maximum",
          },
          {
            id: "fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-disciplinary-board-meeting",
            requiredUnits: 3,
            kind: "maximum",
          },
          {
            id: "fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-presenter-moderator",
            requiredUnits: 10,
            kind: "maximum",
          },
          {
            id: "fl-lcsw-lmft-lmhc-telehealth-phase-2026-administrative-nonclinical",
            requiredUnits: 6,
            kind: "maximum",
          },
          {
            id: "fl-lcsw-lmft-lmhc-telehealth-phase-2026-disciplinary-board-meeting",
            requiredUnits: 3,
            kind: "maximum",
          },
          {
            id: "fl-lcsw-lmft-lmhc-telehealth-phase-2026-presenter-moderator",
            requiredUnits: 10,
            kind: "maximum",
          },
          {
            id: "nj-lpc-standard-renewal-2026-new-course-program-presentation",
            requiredUnits: 9,
            kind: "maximum",
          },
          {
            id: "nj-lpc-standard-renewal-2026-refereed-articles",
            requiredUnits: 8,
            kind: "maximum",
          },
        ],
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM rule_sets
             WHERE id = 'ny-lmsw-lcsw-standard-registration-2026-v1'
               AND source_title LIKE '%November 17, 2026%'
               AND source_title LIKE '%15-minute addendum%'
               AND source_title LIKE '%15 hours per semester credit%'`,
          )
          .get().count,
        1,
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM rule_sets
             WHERE id LIKE 'fl-lcsw-lmft-lmhc-%'
               AND source_title LIKE '%two years following the renewal period%'
               AND source_title LIKE '%graduate-course instructor%'
               AND source_title LIKE '%initial two-hour Domestic Violence%'`,
          )
          .get().count,
        2,
      );
      assert.deepEqual(
        rows(
          `SELECT id, required_units AS requiredUnits, kind, applicability
           FROM rule_categories
           WHERE id IN (
             'ca-bbs-lmft-lcsw-lpcc-standard-2026-law-ethics',
             'ca-bbs-lmft-lcsw-lpcc-standard-2026-teaching',
             'tx-lpc-standard-renewal-2026-confirmed-carryover',
             'ny-lmsw-lcsw-standard-registration-2026-self-study',
             'nj-lpc-standard-renewal-2026-confirmed-carryover'
           )
           ORDER BY id`,
        ),
        [
          {
            id: "ca-bbs-lmft-lcsw-lpcc-standard-2026-law-ethics",
            requiredUnits: 6,
            kind: "minimum",
            applicability: "always",
          },
          {
            id: "ca-bbs-lmft-lcsw-lpcc-standard-2026-teaching",
            requiredUnits: 18,
            kind: "maximum",
            applicability: "optional",
          },
          {
            id: "nj-lpc-standard-renewal-2026-confirmed-carryover",
            requiredUnits: 10,
            kind: "maximum",
            applicability: "conditional",
          },
          {
            id: "ny-lmsw-lcsw-standard-registration-2026-self-study",
            requiredUnits: 12,
            kind: "maximum",
            applicability: "optional",
          },
          {
            id: "tx-lpc-standard-renewal-2026-confirmed-carryover",
            requiredUnits: 10,
            kind: "maximum",
            applicability: "conditional",
          },
        ],
      );
      assert.deepEqual(
        rows(
          `SELECT
             id,
             relation,
             exclusive_group AS exclusiveGroup
           FROM rule_categories
           WHERE id IN (
             'tx-lpc-standard-renewal-2026-confirmed-carryover',
             'nj-lpc-standard-renewal-2026-confirmed-carryover'
           )
           ORDER BY id`,
        ),
        [
          {
            id: "nj-lpc-standard-renewal-2026-confirmed-carryover",
            relation: "independent",
            exclusiveGroup: "New Jersey LPC CE activity source",
          },
          {
            id: "tx-lpc-standard-renewal-2026-confirmed-carryover",
            relation: "independent",
            exclusiveGroup: "Texas LPC CE activity source",
          },
        ],
      );

      assert.equal(
        raw
          .prepare(
            `WITH ranked AS (
               SELECT
                 category.sort_order AS sortOrder,
                 ROW_NUMBER() OVER (
                   PARTITION BY category.rule_set_id
                   ORDER BY category.sort_order, category.id
                 ) - 1 AS expectedSortOrder
               FROM rule_categories category
               JOIN rule_sets rule ON rule.id = category.rule_set_id
               WHERE ${newRuleScope}
             )
             SELECT COUNT(*) AS count
             FROM ranked
             WHERE sortOrder <> expectedSortOrder`,
          )
          .get().count,
        0,
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM rule_categories category
             JOIN rule_sets rule ON rule.id = category.rule_set_id
             LEFT JOIN rule_categories parent
               ON parent.id = category.parent_category_id
               AND parent.rule_set_id = category.rule_set_id
             WHERE ${newRuleScope}
               AND category.relation = 'nested'
               AND parent.id IS NULL`,
          )
          .get().count,
        0,
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM rule_categories category
             JOIN rule_sets rule ON rule.id = category.rule_set_id
             WHERE ${newRuleScope}
               AND category.applicability = 'conditional'
               AND (
                 category.condition_note IS NULL
                 OR LENGTH(TRIM(category.condition_note)) < 30
               )`,
          )
          .get().count,
        0,
      );

      assert.match(
        runtimeSource,
        /MAXIMUM_CLASSIFICATION_RULE_SET_IDS[\s\S]*?\.\.\.EDUCATION_MAXIMUM_CLASSIFICATION_RULE_SET_IDS[\s\S]*?\.\.\.MENTAL_HEALTH_MAXIMUM_CLASSIFICATION_RULE_SET_IDS/,
      );
      assert.match(
        workspaceRouteSource,
        /NREMT_RULE_SET_PREFIX[\s\S]*?Classify accepted credits as National, Local\/State, or Individual[\s\S]*?nremt_submission_attestation_required/,
      );
      assert.match(
        workspaceRouteSource,
        /COMPLIANCE_PERIOD_RULE_SET_PREFIXES[\s\S]*?ny-professional-classroom-teacher-[\s\S]*?ny-professional-esol-bilingual-[\s\S]*?nj-employed-teacher-annual-pd-[\s\S]*?pa-professional-educator-act-48-/,
      );
      assert.match(
        clientSource,
        /isFloridaMentalHealthPhaseCredential[\s\S]*?requiresCurrentNextTemplate[\s\S]*?Choose the phase shown by CE Broker/,
      );
      database.close();
    },
  );

  await t.test(
    "seeds six source-linked pharmacist renewals with bounded credit and rollover rules",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new SQLiteD1Database(DatabaseSync);
      const [
        runtimeSource,
        pharmacySource,
        workspaceRouteSource,
        clientSource,
        compatibilitySource,
      ] = await Promise.all([
        readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
        readFile(new URL("../db/catalog/pharmacy.ts", import.meta.url), "utf8"),
        readFile(
          new URL("../app/api/workspace/route.ts", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../app/LicenseLanternApp.tsx", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../app/lib/requirementCompatibility.ts", import.meta.url),
          "utf8",
        ),
      ]);
      const [runtimeModule, pharmacyModule, compatibilityModule] =
        await Promise.all([
          importTypeScriptModule(
            `${runtimeSource}\nexport const __pharmacistCatalogNonce = "catalog";`,
          ),
          importTypeScriptModule(pharmacySource),
          importTypeScriptModule(compatibilitySource),
        ]);
      await runtimeModule.initializeDatabase(database);
      const raw = database.raw;
      const rows = (sql) =>
        raw
          .prepare(sql)
          .all()
          .map((row) => ({ ...row }));

      assert.deepEqual(
        rows(
          `SELECT
             id,
             jurisdiction,
             total_units AS totalUnits,
             cycle_months AS cycleMonths,
             effective_date AS effectiveDate
           FROM rule_sets
           WHERE profession = 'Pharmacy'
           ORDER BY jurisdiction`,
        ),
        [
          {
            id: "ca-pharmacist-2026-v1",
            jurisdiction: "California",
            totalUnits: 30,
            cycleMonths: 24,
            effectiveDate: null,
          },
          {
            id: "fl-pharmacist-2026-v1",
            jurisdiction: "Florida",
            totalUnits: 30,
            cycleMonths: 24,
            effectiveDate: "2025-05-22",
          },
          {
            id: "nj-pharmacist-2026-v1",
            jurisdiction: "New Jersey",
            totalUnits: 30,
            cycleMonths: 24,
            effectiveDate: null,
          },
          {
            id: "ny-pharmacist-2026-v1",
            jurisdiction: "New York",
            totalUnits: 45,
            cycleMonths: 36,
            effectiveDate: "2023-01-01",
          },
          {
            id: "pa-pharmacist-2026-v1",
            jurisdiction: "Pennsylvania",
            totalUnits: 30,
            cycleMonths: 24,
            effectiveDate: "2026-04-11",
          },
          {
            id: "tx-pharmacist-2026-v1",
            jurisdiction: "Texas",
            totalUnits: 30,
            cycleMonths: 24,
            effectiveDate: null,
          },
        ],
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 COUNT(DISTINCT rule.id) AS ruleCount,
                 COUNT(category.id) AS categoryCount,
                 SUM(CASE WHEN category.kind = 'maximum' THEN 1 ELSE 0 END) AS maximumCount,
                 SUM(CASE WHEN category.applicability = 'conditional' THEN 1 ELSE 0 END) AS conditionalCount,
                 SUM(
                   CASE
                     WHEN rule.is_current = 1
                       AND rule.last_verified_at = '2026-07-26'
                       AND rule.review_status = 'source_linked_check_conditions'
                       AND rule.source_url LIKE 'https://%'
                     THEN 1 ELSE 0
                   END
                 ) AS sourceLinkedCategoryRows
               FROM rule_sets rule
               JOIN rule_categories category ON category.rule_set_id = rule.id
               WHERE rule.profession = 'Pharmacy'`,
            )
            .get(),
        },
        {
          ruleCount: 6,
          categoryCount: 37,
          maximumCount: 6,
          conditionalCount: 15,
          sourceLinkedCategoryRows: 37,
        },
      );
      assert.deepEqual(
        rows(
          `SELECT
             rule_set_id AS ruleSetId,
             COUNT(*) AS categoryCount,
             MIN(sort_order) AS firstSort,
             MAX(sort_order) AS lastSort
           FROM rule_categories
           WHERE rule_set_id LIKE '%-pharmacist-2026-v1'
           GROUP BY rule_set_id
           ORDER BY rule_set_id`,
        ),
        [
          {
            ruleSetId: "ca-pharmacist-2026-v1",
            categoryCount: 3,
            firstSort: 0,
            lastSort: 2,
          },
          {
            ruleSetId: "fl-pharmacist-2026-v1",
            categoryCount: 10,
            firstSort: 0,
            lastSort: 9,
          },
          {
            ruleSetId: "nj-pharmacist-2026-v1",
            categoryCount: 8,
            firstSort: 0,
            lastSort: 7,
          },
          {
            ruleSetId: "ny-pharmacist-2026-v1",
            categoryCount: 5,
            firstSort: 0,
            lastSort: 4,
          },
          {
            ruleSetId: "pa-pharmacist-2026-v1",
            categoryCount: 4,
            firstSort: 0,
            lastSort: 3,
          },
          {
            ruleSetId: "tx-pharmacist-2026-v1",
            categoryCount: 7,
            firstSort: 0,
            lastSort: 6,
          },
        ],
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 SUM(required_units) AS requiredTotal,
                 COUNT(*) AS bucketCount,
                 COUNT(DISTINCT exclusive_group) AS groupCount
               FROM rule_categories
               WHERE rule_set_id = 'fl-pharmacist-2026-v1'
                 AND kind = 'minimum'
                 AND relation = 'independent'`,
            )
            .get(),
        },
        { requiredTotal: 30, bucketCount: 3, groupCount: 1 },
      );
      assert.deepEqual(
        rows(
          `SELECT
             id,
             required_units AS requiredUnits,
             applicability,
             exclusive_group AS exclusiveGroup
           FROM rule_categories
           WHERE rule_set_id = 'tx-pharmacist-2026-v1'
           ORDER BY sort_order`,
        ),
        [
          {
            id: "tx-pharmacist-2026-texas-law-rules",
            requiredUnits: 1,
            applicability: "always",
            exclusiveGroup: null,
          },
          {
            id: "tx-pharmacist-2026-sterile-standard",
            requiredUnits: 2,
            applicability: "conditional",
            exclusiveGroup: "Texas pharmacist sterile-compounding tier",
          },
          {
            id: "tx-pharmacist-2026-sterile-high-risk",
            requiredUnits: 4,
            applicability: "conditional",
            exclusiveGroup: "Texas pharmacist sterile-compounding tier",
          },
          {
            id: "tx-pharmacist-2026-immunizer",
            requiredUnits: 3,
            applicability: "conditional",
            exclusiveGroup: null,
          },
          {
            id: "tx-pharmacist-2026-preceptor",
            requiredUnits: 3,
            applicability: "conditional",
            exclusiveGroup: null,
          },
          {
            id:
              "tx-pharmacist-2026-drug-therapy-management-year-1",
            requiredUnits: 6,
            applicability: "conditional",
            exclusiveGroup: "Texas pharmacist drug-therapy year",
          },
          {
            id:
              "tx-pharmacist-2026-drug-therapy-management-year-2",
            requiredUnits: 6,
            applicability: "conditional",
            exclusiveGroup: "Texas pharmacist drug-therapy year",
          },
        ],
      );
      assert.deepEqual(
        rows(
          `SELECT
             exclusive_group AS exclusiveGroup,
             COUNT(*) AS optionCount,
             SUM(CASE WHEN kind = 'maximum' THEN 1 ELSE 0 END) AS maximumCount,
             SUM(CASE WHEN kind = 'informational' THEN 1 ELSE 0 END) AS informationalCount
           FROM rule_categories
           WHERE rule_set_id IN (
             'fl-pharmacist-2026-v1',
             'ny-pharmacist-2026-v1',
             'nj-pharmacist-2026-v1'
           )
             AND exclusive_group IS NOT NULL
             AND (
               kind = 'maximum'
               OR kind = 'informational'
             )
           GROUP BY exclusive_group
           HAVING maximumCount > 0
           ORDER BY exclusive_group`,
        ),
        [
          {
            exclusiveGroup: "Florida pharmacist credit source",
            optionCount: 4,
            maximumCount: 3,
            informationalCount: 1,
          },
          {
            exclusiveGroup: "New Jersey pharmacist delivery mode",
            optionCount: 2,
            maximumCount: 1,
            informationalCount: 1,
          },
          {
            exclusiveGroup: "New Jersey pharmacist period source",
            optionCount: 2,
            maximumCount: 1,
            informationalCount: 1,
          },
          {
            exclusiveGroup: "New York pharmacist delivery mode",
            optionCount: 2,
            maximumCount: 1,
            informationalCount: 1,
          },
        ],
      );
      assert.deepEqual(
        [...pharmacyModule.PHARMACY_MAXIMUM_CLASSIFICATION_RULE_SET_IDS],
        [
          "fl-pharmacist-2026-v1",
          "ny-pharmacist-2026-v1",
          "nj-pharmacist-2026-v1",
        ],
      );
      assert.equal(
        new Set(
          pharmacyModule.PHARMACY_RULE_SET_SEED_BINDINGS.map(
            (binding) => binding[0],
          ),
        ).size,
        6,
      );
      assert.equal(
        new Set(
          pharmacyModule.PHARMACY_CATEGORY_SEED_BINDINGS.map(
            (binding) => binding[0],
          ),
        ).size,
        37,
      );

      const caveats = rows(
        `SELECT id, source_title AS sourceTitle
         FROM rule_sets
         WHERE profession = 'Pharmacy'
         ORDER BY id`,
      );
      assert.match(
        caveats.find((rule) => rule.id.startsWith("ca-")).sourceTitle,
        /first pharmacist renewal is exempt[\s\S]*?Advanced Practice[\s\S]*?four years/i,
      );
      assert.match(
        caveats.find((rule) => rule.id.startsWith("tx-")).sourceTitle,
        /human-trafficking[\s\S]*?does not prescribe a numeric duration[\s\S]*?two sterile-compounding hours[\s\S]*?four hours[\s\S]*?six drug-therapy-management hours annually[\s\S]*?No CE carries/i,
      );
      assert.match(
        caveats.find((rule) => rule.id.startsWith("fl-")).sourceTitle,
        /26 General[\s\S]*?stale 10-hour live[\s\S]*?one-time 2021[\s\S]*?fingerprint/i,
      );
      assert.match(
        caveats.find((rule) => rule.id.startsWith("ny-")).sourceTitle,
        /no more than 22[\s\S]*?shorter than 36 months[\s\S]*?No credit carries/i,
      );
      assert.match(
        caveats.find((rule) => rule.id.startsWith("nj-")).sourceTitle,
        /first renewal is exempt[\s\S]*?10 eligible excess[\s\S]*?never copies/i,
      );
      assert.match(
        caveats.find((rule) => rule.id.startsWith("pa-")).sourceTitle,
        /DEA registration[\s\S]*?No hours carry[\s\S]*?Newly graduated[\s\S]*?reciprocal/i,
      );

      assert.equal(
        compatibilityModule.requirementsAreIncompatible(
          {
            id: "ny-self-study",
            name: "Self-Study",
            ruleCategoryId: "ny-pharmacist-2026-self-study",
          },
          {
            id: "ny-cdtm",
            name: "CDTM",
            ruleCategoryId: "ny-pharmacist-2026-cdtm",
          },
        ),
        true,
      );
      assert.equal(
        compatibilityModule.requirementsAreIncompatible(
          {
            id: "nj-carryover",
            name: "Carryover",
            ruleCategoryId: "nj-pharmacist-2026-confirmed-carryover",
          },
          {
            id: "nj-opioids",
            name: "Opioids",
            ruleCategoryId: "nj-pharmacist-2026-prescription-opioids",
          },
        ),
        true,
      );
      assert.match(
        runtimeSource,
        /\.\.\.PHARMACY_RULE_SET_SEED_BINDINGS[\s\S]*?\.\.\.PHARMACY_CATEGORY_SEED_BINDINGS[\s\S]*?managed_rule\.profession = 'Pharmacy'[\s\S]*?\.\.\.PHARMACY_MAXIMUM_CLASSIFICATION_RULE_SET_IDS/,
      );
      assert.match(
        workspaceRouteSource,
        /PHARMACIST_RENEWAL_TASK_COPY[\s\S]*?every applicable certification requirement[\s\S]*?classify every activity by delivery mode and period source[\s\S]*?isManagedPharmacistCredential/,
      );
      assert.match(
        clientSource,
        /isManagedPharmacistCredential[\s\S]*?profession === "Pharmacy"[\s\S]*?requiresOfficialNextPeriodAttestation[\s\S]*?isManagedPharmacistCredential/,
      );
      database.close();
    },
  );

  await t.test(
    "seeds twelve source-linked nursing renewals with explicit zero-hour and conditional rules",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new SQLiteD1Database(DatabaseSync);
      const [
        runtimeSource,
        nursingSource,
        carryoverSource,
        workspaceRouteSource,
        clientSource,
      ] = await Promise.all([
        readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
        readFile(new URL("../db/catalog/nursing.ts", import.meta.url), "utf8"),
        readFile(new URL("../app/lib/carryover.ts", import.meta.url), "utf8"),
        readFile(
          new URL("../app/api/workspace/route.ts", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../app/LicenseLanternApp.tsx", import.meta.url),
          "utf8",
        ),
      ]);
      const [runtimeModule, nursingModule, carryoverModule] =
        await Promise.all([
          importTypeScriptModule(
            `${runtimeSource}\nexport const __nursingCatalogNonce = "catalog";`,
          ),
          importTypeScriptModule(nursingSource),
          importTypeScriptModule(carryoverSource),
        ]);
      await runtimeModule.initializeDatabase(database);
      const raw = database.raw;
      const rows = (sql) =>
        raw
          .prepare(sql)
          .all()
          .map((row) => ({ ...row }));

      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 COUNT(*) AS totalRules,
                 SUM(CASE WHEN is_current = 1 THEN 1 ELSE 0 END) AS currentRules
               FROM rule_sets`,
            )
            .get(),
        },
        { totalRules: 105, currentRules: 104 },
      );
      assert.equal(
        raw.prepare("SELECT COUNT(*) AS count FROM rule_categories").get()
          .count,
        505,
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 COUNT(DISTINCT rule.id) AS ruleCount,
                 COUNT(category.id) AS categoryCount,
                 COUNT(DISTINCT
                   CASE
                     WHEN rule.is_current = 1
                       AND rule.last_verified_at = '2026-07-26'
                       AND rule.review_status = 'source_linked_check_conditions'
                       AND rule.source_url LIKE 'https://%'
                     THEN rule.id
                   END
                 ) AS sourceLinkedRuleCount
               FROM rule_sets rule
               LEFT JOIN rule_categories category
                 ON category.rule_set_id = rule.id
               WHERE rule.profession = 'Nursing'`,
            )
            .get(),
        },
        {
          ruleCount: 12,
          categoryCount: 43,
          sourceLinkedRuleCount: 12,
        },
      );
      assert.deepEqual(
        rows(
          `SELECT id, total_units AS totalUnits
           FROM rule_sets
           WHERE profession = 'Nursing'
           ORDER BY id`,
        ),
        [
          { id: "ca-lvn-2026-v1", totalUnits: 30 },
          { id: "ca-rn-2026-v1", totalUnits: 30 },
          { id: "fl-lpn-2026-v1", totalUnits: 24 },
          { id: "fl-rn-2026-v1", totalUnits: 24 },
          { id: "nj-lpn-2026-v1", totalUnits: 30 },
          { id: "nj-rn-2026-v1", totalUnits: 30 },
          { id: "ny-lpn-2026-v1", totalUnits: 0 },
          { id: "ny-rn-2026-v1", totalUnits: 0 },
          { id: "pa-lpn-2026-v1", totalUnits: 2 },
          { id: "pa-rn-2026-v1", totalUnits: 30 },
          { id: "tx-lvn-2026-v1", totalUnits: 20 },
          { id: "tx-rn-2026-v1", totalUnits: 20 },
        ],
      );

      const priorNursingRuleSetIds = new Set([
        "ca-rn-2026-v1",
        "fl-rn-2026-v1",
        "nj-rn-2026-v1",
        "pa-rn-2026-v1",
        "tx-rn-2026-v1",
      ]);
      assert.deepEqual(
        nursingModule.NURSING_RULE_SET_SEED_BINDINGS.map(
          (binding) => binding[0],
        ).filter((ruleSetId) => !priorNursingRuleSetIds.has(ruleSetId)),
        [
          "ca-lvn-2026-v1",
          "fl-lpn-2026-v1",
          "nj-lpn-2026-v1",
          "ny-rn-2026-v1",
          "ny-lpn-2026-v1",
          "pa-lpn-2026-v1",
          "tx-lvn-2026-v1",
        ],
      );
      assert.equal(
        new Set(
          nursingModule.NURSING_RULE_SET_SEED_BINDINGS.map(
            (binding) => binding[0],
          ),
        ).size,
        12,
      );
      assert.equal(
        new Set(
          nursingModule.NURSING_CATEGORY_SEED_BINDINGS.map(
            (binding) => binding[0],
          ),
        ).size,
        43,
      );
      assert.deepEqual(
        nursingModule.NURSING_RENEWAL_TASK_COPY_BINDINGS.map(
          (binding) => binding[0],
        ),
        nursingModule.NURSING_RULE_SET_SEED_BINDINGS.map(
          (binding) => binding[0],
        ),
        "every managed nursing template must have regulator-specific renewal task copy",
      );
      for (const taskBinding of nursingModule.NURSING_RENEWAL_TASK_COPY_BINDINGS) {
        assert.equal(taskBinding.length, 4);
        for (const taskTitle of taskBinding.slice(1)) {
          assert.ok(
            taskTitle.trim().length > 20,
            `${taskBinding[0]} needs complete regulator-specific task copy`,
          );
        }
      }
      assert.equal(
        nursingModule.NURSING_CATEGORY_SEED_BINDINGS.length - 12,
        31,
      );
      assert.deepEqual(
        [...nursingModule.NURSING_MAXIMUM_CLASSIFICATION_RULE_SET_IDS],
        ["nj-rn-2026-v1", "nj-lpn-2026-v1"],
      );

      assert.deepEqual(
        rows(
          `SELECT
             rule_set_id AS ruleSetId,
             id,
             required_units AS requiredUnits,
             kind,
             applicability
           FROM rule_categories
           WHERE id IN (
             'ny-rn-2026-bsn-in-10',
             'ny-rn-2026-child-abuse',
             'ny-rn-2026-updated-mandated-reporter',
             'ny-lpn-2026-updated-mandated-reporter'
           )
           ORDER BY id`,
        ),
        [
          {
            ruleSetId: "ny-lpn-2026-v1",
            id: "ny-lpn-2026-updated-mandated-reporter",
            requiredUnits: 0,
            kind: "informational",
            applicability: "conditional",
          },
          {
            ruleSetId: "ny-rn-2026-v1",
            id: "ny-rn-2026-bsn-in-10",
            requiredUnits: 0,
            kind: "informational",
            applicability: "conditional",
          },
          {
            ruleSetId: "ny-rn-2026-v1",
            id: "ny-rn-2026-child-abuse",
            requiredUnits: 2,
            kind: "minimum",
            applicability: "conditional",
          },
          {
            ruleSetId: "ny-rn-2026-v1",
            id: "ny-rn-2026-updated-mandated-reporter",
            requiredUnits: 0,
            kind: "informational",
            applicability: "conditional",
          },
        ],
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 COUNT(*) AS categoryCount,
                 SUM(CASE WHEN kind = 'informational' THEN 1 ELSE 0 END)
                   AS informationalCount,
                 SUM(required_units) AS requiredUnits
               FROM rule_categories
               WHERE rule_set_id IN ('ny-rn-2026-v1', 'ny-lpn-2026-v1')`,
            )
            .get(),
        },
        {
          categoryCount: 6,
          informationalCount: 5,
          requiredUnits: 2,
        },
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 rule.total_units AS totalUnits,
                 category.required_units AS requiredUnits,
                 category.kind,
                 category.applicability
               FROM rule_sets rule
               JOIN rule_categories category
                 ON category.rule_set_id = rule.id
               WHERE rule.id = 'pa-lpn-2026-v1'
                 AND category.id = 'pa-lpn-2026-child-abuse'`,
            )
            .get(),
        },
        {
          totalUnits: 2,
          requiredUnits: 2,
          kind: "minimum",
          applicability: "always",
        },
      );
      assert.deepEqual(
        rows(
          `SELECT
             rule_set_id AS ruleSetId,
             required_units AS requiredUnits,
             kind,
             applicability,
             exclusive_group AS exclusiveGroup
           FROM rule_categories
           WHERE id IN (
             'nj-rn-2026-confirmed-carryover',
             'nj-lpn-2026-confirmed-carryover'
           )
           ORDER BY rule_set_id`,
        ),
        [
          {
            ruleSetId: "nj-lpn-2026-v1",
            requiredUnits: 15,
            kind: "maximum",
            applicability: "conditional",
            exclusiveGroup: "New Jersey nursing period source",
          },
          {
            ruleSetId: "nj-rn-2026-v1",
            requiredUnits: 15,
            kind: "maximum",
            applicability: "conditional",
            exclusiveGroup: "New Jersey nursing period source",
          },
        ],
      );
      for (const categoryId of [
        "nj-rn-2026-confirmed-carryover",
        "nj-lpn-2026-confirmed-carryover",
      ]) {
        assert.equal(
          carryoverModule.portalCarryoverLookbackMonths(categoryId),
          24,
        );
      }
      const texasNursingCategories = new Map(
        rows(
          `SELECT
             id,
             rule_set_id AS ruleSetId,
             required_units AS requiredUnits,
             kind,
             relation,
             applicability
           FROM rule_categories
           WHERE rule_set_id IN ('tx-rn-2026-v1', 'tx-lvn-2026-v1')`,
        ).map((category) => [category.id, category]),
      );
      for (const [prefix, ruleSetId] of [
        ["tx-rn-2026", "tx-rn-2026-v1"],
        ["tx-lvn-2026", "tx-lvn-2026-v1"],
      ]) {
        for (const suffix of [
          "human-trafficking",
          "forensic-exam-training",
          "sb25-nutrition-rule-refresh",
        ]) {
          assert.deepEqual(
            texasNursingCategories.get(`${prefix}-${suffix}`),
            {
              id: `${prefix}-${suffix}`,
              ruleSetId,
              requiredUnits: 0,
              kind: "informational",
              relation:
                suffix === "sb25-nutrition-rule-refresh"
                  ? "independent"
                  : "overlapping",
              applicability: "conditional",
            },
            `${prefix}-${suffix} must remain a zero-hour checkpoint`,
          );
        }
        assert.deepEqual(
          texasNursingCategories.get(`${prefix}-forensic-evidence`),
          {
            id: `${prefix}-forensic-evidence`,
            ruleSetId,
            requiredUnits: 2,
            kind: "minimum",
            relation: "overlapping",
            applicability: "conditional",
          },
          `${prefix} emergency-room forensic training must remain a distinct two-hour minimum`,
        );
      }
      assert.deepEqual(
        rows(
          `SELECT
             rule_set_id AS ruleSetId,
             required_units AS requiredUnits,
             kind,
             relation,
             applicability
           FROM rule_categories
           WHERE id IN (
             'fl-rn-2026-domestic-violence',
             'fl-lpn-2026-domestic-violence'
           )
           ORDER BY rule_set_id`,
        ),
        [
          {
            ruleSetId: "fl-lpn-2026-v1",
            requiredUnits: 2,
            kind: "minimum",
            relation: "independent",
            applicability: "conditional",
          },
          {
            ruleSetId: "fl-rn-2026-v1",
            requiredUnits: 2,
            kind: "minimum",
            relation: "independent",
            applicability: "conditional",
          },
        ],
      );
      assert.match(
        raw
          .prepare(
            `SELECT condition_note AS conditionNote
             FROM rule_categories
             WHERE id = 'tx-rn-2026-human-trafficking'`,
          )
          .get().conditionNote,
        /fixes no numeric duration/i,
      );
      assert.match(
        raw
          .prepare(
            `SELECT condition_note AS conditionNote
             FROM rule_categories
             WHERE id = 'fl-rn-2026-domestic-violence'`,
          )
          .get().conditionNote,
        /raises the credential total to 26/i,
      );
      assert.match(
        raw
          .prepare(
            `SELECT condition_note AS conditionNote
             FROM rule_categories
             WHERE id = 'ny-rn-2026-infection-control'`,
          )
          .get().conditionNote,
        /sepsis[\s\S]*HIV, HBV, HCV[\s\S]*infections that could lead to sepsis/i,
      );
      assert.deepEqual(
        rows(
          `SELECT id, effective_date AS effectiveDate
           FROM rule_sets
           WHERE id IN (
             'ny-rn-2026-v1',
             'ny-lpn-2026-v1',
             'tx-rn-2026-v1',
             'tx-lvn-2026-v1'
           )
           ORDER BY id`,
        ),
        [
          { id: "ny-lpn-2026-v1", effectiveDate: null },
          { id: "ny-rn-2026-v1", effectiveDate: null },
          { id: "tx-lvn-2026-v1", effectiveDate: "2026-09-01" },
          { id: "tx-rn-2026-v1", effectiveDate: "2026-09-01" },
        ],
      );
      assert.match(
        raw
          .prepare(
            `SELECT condition_note AS conditionNote
             FROM rule_categories
             WHERE id = 'tx-rn-2026-jurisprudence-ethics'`,
          )
          .get().conditionNote,
        /once at any point[\s\S]*three-cycle[\s\S]*six-year window[\s\S]*earlier period[\s\S]*Not this cycle/i,
      );
      assert.match(
        raw
          .prepare(
            `SELECT condition_note AS conditionNote
             FROM rule_categories
             WHERE id = 'tx-rn-2026-sb25-nutrition-rule-refresh'`,
          )
          .get().conditionNote,
        /every renewal application filed on or after January 1, 2027[\s\S]*adopted hours and content must replace this zero-value placeholder[\s\S]*does not invent a number/i,
      );
      assert.match(
        raw
          .prepare(
            `SELECT condition_note AS conditionNote
             FROM rule_categories
             WHERE id = 'pa-rn-2026-organ-tissue-donation'`,
          )
          .get().conditionNote,
        /licensed before[\s\S]*initially licensed[\s\S]*reactivated[\s\S]*five years/i,
      );
      assert.match(
        runtimeSource,
        /\.\.\.NURSING_RULE_SET_SEED_BINDINGS[\s\S]*?\.\.\.NURSING_CATEGORY_SEED_BINDINGS[\s\S]*?managed_rule\.profession = 'Nursing'[\s\S]*?\.\.\.NURSING_MAXIMUM_CLASSIFICATION_RULE_SET_IDS/,
      );
      assert.match(
        workspaceRouteSource,
        /isManagedNursingRenewal[\s\S]*?current_rule\.stable_key = prior_rule\.stable_key[\s\S]*?current_rule\.is_current = 1[\s\S]*?current_rule\.profession = 'Nursing'[\s\S]*?ORDER BY current_rule\.version DESC[\s\S]*?defaultApplicabilityStatus\(\s*category\.applicability/,
      );
      assert.match(
        workspaceRouteSource,
        /isTexasNursing[\s\S]*?deadline < "2026-09-01"[\s\S]*?keep certificates ready for audit[\s\S]*?Upload all required verification in the Nurse Portal/,
      );
      assert.match(
        workspaceRouteSource,
        /isManagedNursingRenewal[\s\S]*?nursing_current_template_changed/,
      );
      const floridaNursingTotalUpdate = workspaceRouteSource.match(
        /const applicabilityUpdateResultIndex[\s\S]*?let results: D1Result\[\];/,
      )?.[0];
      assert.ok(floridaNursingTotalUpdate);
      assert.match(
        floridaNursingTotalUpdate,
        /catalog_rule\.profession = 'Nursing'/,
      );
      assert.doesNotMatch(
        floridaNursingTotalUpdate,
        /catalog_rule\.is_current/,
      );
      assert.match(
        clientSource,
        /selectedRule\.totalUnits > 0[\s\S]*?No general numeric CE total[\s\S]*?credential\.totalRequired > 0[\s\S]*?Mandated training is tracked in conditions and the checklist/,
      );
      assert.match(
        clientSource,
        /selected\.totalRequired > 0[\s\S]*?"Checklist"[\s\S]*?selected\.totalRequired > 0[\s\S]*?This regulator does not set a general numeric nursing CE\s+total/,
      );
      assert.match(
        clientSource,
        /category\.kind === "informational"[\s\S]*?Track \$\{category\.name\}[\s\S]*?credential\.totalRequired <= 0[\s\S]*?requirementProgressValue \* 60[\s\S]*?taskProgress \* 40/,
      );
      assert.match(
        clientSource,
        /"Training and checklist"[\s\S]*?`\$\{readiness\}% ready`[\s\S]*?No general numeric CE total applies[\s\S]*?Checklist checkpoint/,
      );
      assert.match(
        clientSource,
        /I confirmed the next period is a standard full-cycle[\s\S]*?isManagedNursingCredential\(selectedCredential\)[\s\S]*?renewal or registration/,
      );
      assert.match(
        clientSource,
        /requirement\.exclusiveGroup[\s\S]*?Choose only one activity type from this group[\s\S]*?requirement\.relation === "overlapping"[\s\S]*?May overlap another selected requirement/,
      );
      database.close();
    },
  );

  await t.test(
    "preserves legacy New Jersey RN opioid snapshots and restores archived matched credit after a managed refresh",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new SQLiteD1Database(DatabaseSync);
      const runtimeSource = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const setupRuntime = await importTypeScriptModule(
        `${runtimeSource}\nexport const __nursingLegacySetupNonce = "setup";`,
      );
      await setupRuntime.initializeDatabase(database);
      const raw = database.raw;
      const userId = await expectedStableUserId("owner@example.com");
      const legacyCategoryId = "nj-rn-2026-opioids";
      const activeCredentialId = "credential-nj-rn-legacy-active";
      const submittedCredentialId = "credential-nj-rn-legacy-submitted";
      const renewedCredentialId = "credential-nj-rn-legacy-renewed";
      const activeRequirementId = "requirement-nj-rn-legacy-active-opioids";
      const submittedRequirementId =
        "requirement-nj-rn-legacy-submitted-opioids";
      const renewedRequirementId =
        "requirement-nj-rn-legacy-renewed-opioids";
      const activityId = "activity-nj-rn-legacy-opioids";
      const allocationId = "allocation-nj-rn-legacy-opioids";

      raw
        .prepare(
          `INSERT INTO rule_categories (
             id, rule_set_id, name, required_units, kind, relation,
             applicability, condition_note, sort_order
           ) VALUES (?, 'nj-rn-2026-v1', ?, 1, 'minimum', 'independent',
             'always', ?, 0)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             required_units = excluded.required_units,
             kind = excluded.kind,
             relation = excluded.relation,
             applicability = excluded.applicability,
             condition_note = excluded.condition_note,
             sort_order = excluded.sort_order`,
        )
        .run(
          legacyCategoryId,
          "Legacy prescription opioids",
          "Legacy snapshot marker",
        );
      raw
        .prepare(
          `INSERT INTO users (id, email, display_name, is_demo)
           VALUES (?, 'owner@example.com', 'Casey Owner', 0)`,
        )
        .run(userId);

      const insertCredential = raw.prepare(
        `INSERT INTO credentials (
           id, user_id, rule_set_id, credential_name, profession, jurisdiction,
           issuer, cycle_start, deadline, total_required, unit_label, status
         ) VALUES (
           ?, ?, 'nj-rn-2026-v1', 'Registered Nurse', 'Nursing', 'New Jersey',
           'New Jersey Board of Nursing', '2026-01-01', '2027-12-31', 30,
           'contact hours', ?
         )`,
      );
      for (const [credentialId, status] of [
        [activeCredentialId, "active"],
        [submittedCredentialId, "submitted"],
        [renewedCredentialId, "renewed"],
      ]) {
        insertCredential.run(credentialId, userId, status);
      }

      const insertRequirement = raw.prepare(
        `INSERT INTO credential_requirements (
           id, credential_id, rule_category_id, name, required_units, kind,
           relation, applicability, applicability_status, condition_note,
           is_active, sort_order
         ) VALUES (
           ?, ?, ?, ?, 1, 'minimum', 'independent', 'always', 'applies',
           ?, 1, 0
         )`,
      );
      insertRequirement.run(
        activeRequirementId,
        activeCredentialId,
        legacyCategoryId,
        "Legacy active opioid snapshot",
        "Legacy active condition",
      );
      insertRequirement.run(
        submittedRequirementId,
        submittedCredentialId,
        legacyCategoryId,
        "Legacy submitted opioid snapshot",
        "Legacy submitted condition",
      );
      insertRequirement.run(
        renewedRequirementId,
        renewedCredentialId,
        legacyCategoryId,
        "Legacy renewed opioid snapshot",
        "Legacy renewed condition",
      );

      raw
        .prepare(
          `INSERT INTO activities (
             id, user_id, title, provider, completion_date, total_units,
             evidence_status, revision, archived_at
           ) VALUES (?, ?, 'Legacy opioid course', 'Legacy Provider',
             '2027-05-01', 1, 'ready', 2, NULL)`,
        )
        .run(activityId, userId);
      raw
        .prepare(
          `INSERT INTO activity_allocations (
             id, activity_id, credential_id, requirement_id, allocated_units
           ) VALUES (?, ?, ?, ?, 1)`,
        )
        .run(
          allocationId,
          activityId,
          activeCredentialId,
          activeRequirementId,
        );
      raw
        .prepare(
          `INSERT INTO activity_requirement_matches (
             id, user_id, allocation_id, requirement_id, matched_units
           ) VALUES (
             'match-nj-rn-legacy-opioids', ?, ?, ?, 1
           )`,
        )
        .run(userId, allocationId, activeRequirementId);
      raw
        .prepare(
          `UPDATE activities
           SET archived_at = '2027-06-01 12:00:00', revision = 3
           WHERE id = ?`,
        )
        .run(activityId);

      const upgradeRuntime = await importTypeScriptModule(
        `${runtimeSource}\nexport const __nursingLegacyUpgradeNonce = "upgrade";`,
      );
      await upgradeRuntime.initializeDatabase(database);

      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT id, rule_set_id AS ruleSetId
               FROM rule_categories
               WHERE id = ?`,
            )
            .get(legacyCategoryId),
        },
        {
          id: legacyCategoryId,
          ruleSetId: "nj-rn-2026-v1",
        },
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 rule_category_id AS ruleCategoryId,
                 applicability_status AS applicabilityStatus,
                 is_active AS isActive
               FROM credential_requirements
               WHERE id = ?`,
            )
            .get(activeRequirementId),
        },
        {
          ruleCategoryId: legacyCategoryId,
          applicabilityStatus: "applies",
          isActive: 1,
        },
      );
      for (const [requirementId, expectedName, expectedCondition] of [
        [
          submittedRequirementId,
          "Legacy submitted opioid snapshot",
          "Legacy submitted condition",
        ],
        [
          renewedRequirementId,
          "Legacy renewed opioid snapshot",
          "Legacy renewed condition",
        ],
      ]) {
        assert.deepEqual(
          {
            ...raw
              .prepare(
                `SELECT
                   rule_category_id AS ruleCategoryId,
                   name,
                   applicability_status AS applicabilityStatus,
                   condition_note AS conditionNote,
                   is_active AS isActive
                 FROM credential_requirements
                 WHERE id = ?`,
              )
              .get(requirementId),
          },
          {
            ruleCategoryId: legacyCategoryId,
            name: expectedName,
            applicabilityStatus: "applies",
            conditionNote: expectedCondition,
            isActive: 1,
          },
        );
      }
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 allocation.requirement_id AS allocationRequirementId,
                 match.requirement_id AS matchRequirementId
               FROM activity_allocations allocation
               JOIN activity_requirement_matches match
                 ON match.allocation_id = allocation.id
               WHERE allocation.id = ?`,
            )
            .get(allocationId),
        },
        {
          allocationRequirementId: activeRequirementId,
          matchRequirementId: activeRequirementId,
        },
      );

      testCloudflareEnv.DB = database;
      const restoreResponse = await postWorkspace("restoreActivity", {
        activityId,
        expectedRevision: 3,
      });
      assert.equal(
        restoreResponse.status,
        200,
        JSON.stringify(await restoreResponse.clone().json()),
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT archived_at AS archivedAt, revision
               FROM activities
               WHERE id = ?`,
            )
            .get(activityId),
        },
        {
          archivedAt: null,
          revision: 4,
        },
      );
      database.close();
    },
  );

  await t.test(
    "reconciles active Florida nursing totals and buddy tasks without changing submitted snapshots",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new SQLiteD1Database(DatabaseSync);
      const runtimeSource = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const setupRuntime = await importTypeScriptModule(
        `${runtimeSource}\nexport const __nursingRefreshSetupNonce = "setup";`,
      );
      await setupRuntime.initializeDatabase(database);
      const raw = database.raw;
      const userId = await expectedStableUserId("owner@example.com");
      raw
        .prepare(
          `INSERT INTO users (id, email, display_name, is_demo)
           VALUES (?, 'owner@example.com', 'Casey Owner', 0)`,
        )
        .run(userId);
      const insertCredential = raw.prepare(
        `INSERT INTO credentials (
           id, user_id, rule_set_id, credential_name, profession,
           jurisdiction, issuer, cycle_start, deadline, total_required,
           unit_label, status
         ) VALUES (
           ?, ?, 'fl-rn-2026-v1', 'Registered Nurse', 'Nursing', 'Florida',
           'Florida Board of Nursing', '2026-01-01', '2027-12-31', ?,
           'CE hours', ?
         )`,
      );
      insertCredential.run(
        "credential-fl-rn-active-refresh",
        userId,
        24,
        "active",
      );
      insertCredential.run(
        "credential-fl-rn-submitted-refresh",
        userId,
        77,
        "submitted",
      );
      raw
        .prepare(
          `INSERT INTO credentials (
             id, user_id, rule_set_id, credential_name, profession,
             jurisdiction, issuer, cycle_start, deadline, total_required,
             unit_label, status
           ) VALUES (
             'credential-fl-lpn-active-refresh',
             ?,
             'fl-lpn-2026-v1',
             'Licensed Practical Nurse',
             'Nursing',
             'Florida',
             'Florida Board of Nursing',
             '2026-01-01',
             '2027-12-31',
             24,
             'CE hours',
             'active'
           )`,
        )
        .run(userId);
      raw
        .prepare(
          `INSERT INTO credential_requirements (
             id, credential_id, rule_category_id, name, required_units, kind,
             relation, applicability, applicability_status, condition_note,
             is_active, sort_order
           ) VALUES (
             'requirement-fl-rn-active-domestic-violence',
             'credential-fl-rn-active-refresh',
             'fl-rn-2026-domestic-violence',
             'Domestic Violence — additional two hours',
             2,
             'minimum',
             'independent',
             'conditional',
             'applies',
             'Legacy condition copy',
             1,
             4
           )`,
        )
        .run();
      raw
        .prepare(
          `INSERT INTO credential_requirements (
             id, credential_id, rule_category_id, name, required_units, kind,
             relation, applicability, applicability_status, condition_note,
             is_active, sort_order
           ) VALUES (
             'requirement-fl-lpn-active-domestic-violence',
             'credential-fl-lpn-active-refresh',
             'fl-lpn-2026-domestic-violence',
             'Domestic Violence — additional two hours',
             2,
             'minimum',
             'independent',
             'conditional',
             'applies',
             'Legacy LPN condition copy',
             1,
             4
           )`,
        )
        .run();
      raw
        .prepare(
          `INSERT INTO credential_requirements (
             id, credential_id, rule_category_id, name, required_units, kind,
             relation, applicability, applicability_status, condition_note,
             is_active, sort_order
           ) VALUES (
             'requirement-fl-rn-submitted-domestic-violence',
             'credential-fl-rn-submitted-refresh',
             'fl-rn-2026-domestic-violence',
             'Frozen submitted domestic-violence snapshot',
             9,
             'minimum',
             'independent',
             'conditional',
             'applies',
             'Frozen submitted condition',
             1,
             44
           )`,
        )
        .run();
      raw
        .prepare(
          `INSERT INTO activities (
             id, user_id, title, provider, completion_date, total_units,
             evidence_status
           ) VALUES (
             'activity-fl-rn-domestic-violence-refresh',
             ?,
             'Florida domestic-violence course',
             'Florida approved provider',
             '2027-05-01',
             2,
             'missing'
           )`,
        )
        .run(userId);
      raw
        .prepare(
          `INSERT INTO activity_allocations (
             id, activity_id, credential_id, requirement_id, allocated_units
           ) VALUES (
             'allocation-fl-rn-domestic-violence-refresh',
             'activity-fl-rn-domestic-violence-refresh',
             'credential-fl-rn-active-refresh',
             'requirement-fl-rn-active-domestic-violence',
             2
           )`,
        )
        .run();
      raw
        .prepare(
          `INSERT INTO activity_requirement_matches (
             id, user_id, allocation_id, requirement_id, matched_units
           ) VALUES (
             'match-fl-rn-domestic-violence-refresh',
             ?,
             'allocation-fl-rn-domestic-violence-refresh',
             'requirement-fl-rn-active-domestic-violence',
             2
           )`,
        )
        .run(userId);
      const insertTask = raw.prepare(
        `INSERT INTO checklist_tasks (
           id, user_id, credential_id, title, kind, status, due_date,
           sort_order
         ) VALUES (?, ?, 'credential-fl-rn-active-refresh', ?, ?, 'pending',
           ?, ?)`,
      );
      for (const [id, title, kind, dueDate, sortOrder] of [
        [
          "task-fl-rn-active-review",
          "Review the renewal requirements",
          "review",
          "2027-09-02",
          0,
        ],
        [
          "task-fl-rn-active-progress",
          "Complete and document required education",
          "progress",
          "2027-12-01",
          1,
        ],
        [
          "task-fl-rn-active-submit",
          "Submit renewal and save confirmation",
          "submission",
          "2027-12-31",
          2,
        ],
      ]) {
        insertTask.run(id, userId, title, kind, dueDate, sortOrder);
      }
      const insertTaskSentinel = raw.prepare(
        `INSERT INTO checklist_tasks (
           id, user_id, credential_id, title, kind, status, due_date,
           completed_at, is_personal, archived_at, revision, sort_order
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const sentinel of [
        [
          "task-fl-rn-completed-default",
          userId,
          "credential-fl-rn-active-refresh",
          "Review the renewal requirements",
          "review",
          "completed",
          "2027-08-01",
          "2027-07-01 12:00:00",
          0,
          null,
          7,
          10,
        ],
        [
          "task-fl-rn-personal-default",
          userId,
          "credential-fl-rn-active-refresh",
          "Complete and document required education",
          "progress",
          "pending",
          "2027-08-02",
          null,
          1,
          null,
          8,
          11,
        ],
        [
          "task-fl-rn-archived-default",
          userId,
          "credential-fl-rn-active-refresh",
          "Submit renewal and save confirmation",
          "submission",
          "pending",
          "2027-08-03",
          null,
          0,
          "2027-07-03 12:00:00",
          9,
          12,
        ],
        [
          "task-fl-rn-custom-pending",
          userId,
          "credential-fl-rn-active-refresh",
          "Call the hospital credentialing office",
          "review",
          "pending",
          "2027-08-04",
          null,
          0,
          null,
          10,
          13,
        ],
        [
          "task-fl-rn-submitted-default",
          userId,
          "credential-fl-rn-submitted-refresh",
          "Review the renewal requirements",
          "review",
          "pending",
          "2027-08-05",
          null,
          0,
          null,
          11,
          0,
        ],
      ]) {
        insertTaskSentinel.run(...sentinel);
      }
      raw
        .prepare(
          `UPDATE rule_categories
           SET
             relation = 'independent',
             condition_note = 'Stale legacy Florida category copy'
           WHERE id IN (
             'fl-rn-2026-medical-errors',
             'fl-rn-2026-laws-rules',
             'fl-rn-2026-human-trafficking'
           )`,
        )
        .run();

      const refreshRuntime = await importTypeScriptModule(
        `${runtimeSource}\nexport const __nursingRefreshUpgradeNonce = "upgrade";`,
      );
      await refreshRuntime.initializeDatabase(database);
      assert.deepEqual(
        raw
          .prepare(
            `SELECT id, relation
             FROM rule_categories
             WHERE id IN (
               'fl-rn-2026-medical-errors',
               'fl-rn-2026-laws-rules',
               'fl-rn-2026-human-trafficking'
             )
             ORDER BY id`,
          )
          .all()
          .map((row) => ({ ...row })),
        [
          {
            id: "fl-rn-2026-human-trafficking",
            relation: "overlapping",
          },
          {
            id: "fl-rn-2026-laws-rules",
            relation: "overlapping",
          },
          {
            id: "fl-rn-2026-medical-errors",
            relation: "overlapping",
          },
        ],
      );
      assert.match(
        raw
          .prepare(
            `SELECT condition_note AS conditionNote
             FROM rule_categories
             WHERE id = 'fl-rn-2026-human-trafficking'`,
          )
          .get().conditionNote,
        /does not have to be offered by a Florida Board of Nursing-approved provider/i,
      );
      assert.deepEqual(
        raw
          .prepare(
            `SELECT id, total_required AS totalRequired
             FROM credentials
             WHERE id IN (
               'credential-fl-lpn-active-refresh',
               'credential-fl-rn-active-refresh',
               'credential-fl-rn-submitted-refresh'
             )
             ORDER BY id`,
          )
          .all()
          .map((row) => ({ ...row })),
        [
          {
            id: "credential-fl-lpn-active-refresh",
            totalRequired: 26,
          },
          {
            id: "credential-fl-rn-active-refresh",
            totalRequired: 26,
          },
          {
            id: "credential-fl-rn-submitted-refresh",
            totalRequired: 77,
          },
        ],
      );
      assert.deepEqual(
        raw
          .prepare(
            `SELECT
               credential_id AS credentialId,
               COUNT(*) AS requirementCount,
               SUM(
                 CASE
                   WHEN applicability_status = 'applies' AND is_active = 1
                   THEN 1 ELSE 0
                 END
               ) AS activeCount,
               SUM(
                 CASE
                   WHEN applicability_status = 'needs_confirmation'
                     AND is_active = 0
                   THEN 1 ELSE 0
                 END
               ) AS pendingCount
             FROM credential_requirements
             WHERE credential_id IN (
               'credential-fl-lpn-active-refresh',
               'credential-fl-rn-active-refresh'
             )
             GROUP BY credential_id
             ORDER BY credential_id`,
          )
          .all()
          .map((row) => ({ ...row })),
        [
          {
            credentialId: "credential-fl-lpn-active-refresh",
            requirementCount: 6,
            activeCount: 4,
            pendingCount: 2,
          },
          {
            credentialId: "credential-fl-rn-active-refresh",
            requirementCount: 6,
            activeCount: 4,
            pendingCount: 2,
          },
        ],
        "active managed nursing snapshots must be backfilled without resetting confirmed conditions",
      );
      assert.deepEqual(
        raw
          .prepare(
            `SELECT
               id,
               credential_id AS credentialId,
               applicability_status AS applicabilityStatus,
               condition_note AS conditionNote,
               is_active AS isActive
             FROM credential_requirements
             WHERE id IN (
               'requirement-fl-lpn-active-domestic-violence',
               'requirement-fl-rn-active-domestic-violence'
             )
             ORDER BY id`,
          )
          .all()
          .map((row) => ({ ...row })),
        [
          {
            id: "requirement-fl-lpn-active-domestic-violence",
            credentialId: "credential-fl-lpn-active-refresh",
            applicabilityStatus: "applies",
            conditionNote:
              "Required every third biennium in addition to the standard 24 hours. Activating this condition raises the credential total to 26; complete two Board-approved hours and verify them in CE Broker.",
            isActive: 1,
          },
          {
            id: "requirement-fl-rn-active-domestic-violence",
            credentialId: "credential-fl-rn-active-refresh",
            applicabilityStatus: "applies",
            conditionNote:
              "Required every third biennium in addition to the standard 24 hours. Activating this condition raises the credential total to 26; complete two Board-approved hours and verify them in CE Broker.",
            isActive: 1,
          },
        ],
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 id,
                 name,
                 required_units AS requiredUnits,
                 condition_note AS conditionNote,
                 applicability_status AS applicabilityStatus,
                 is_active AS isActive,
                 sort_order AS sortOrder
               FROM credential_requirements
               WHERE credential_id = 'credential-fl-rn-submitted-refresh'`,
            )
            .get(),
        },
        {
          id: "requirement-fl-rn-submitted-domestic-violence",
          name: "Frozen submitted domestic-violence snapshot",
          requiredUnits: 9,
          conditionNote: "Frozen submitted condition",
          applicabilityStatus: "applies",
          isActive: 1,
          sortOrder: 44,
        },
        "submitted requirement snapshots must not be backfilled or refreshed",
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 allocation.requirement_id AS allocationRequirementId,
                 match.requirement_id AS matchRequirementId,
                 match.matched_units AS matchedUnits
               FROM activity_allocations allocation
               JOIN activity_requirement_matches match
                 ON match.allocation_id = allocation.id
               WHERE allocation.id =
                 'allocation-fl-rn-domestic-violence-refresh'`,
            )
            .get(),
        },
        {
          allocationRequirementId:
            "requirement-fl-rn-active-domestic-violence",
          matchRequirementId:
            "requirement-fl-rn-active-domestic-violence",
          matchedUnits: 2,
        },
        "managed snapshot refresh must preserve existing allocation identity and credit",
      );
      const expectedTaskTitles = [
        "Confirm MQA and CE Broker dates, impairment cadence, domestic-violence cycle, and fingerprints",
        "Complete and verify every applicable Florida nursing topic in CE Broker",
        "Renew through MQA and save the updated RN license and CE Broker record",
      ];
      assert.deepEqual(
        raw
          .prepare(
            `SELECT title
             FROM checklist_tasks
             WHERE credential_id = 'credential-fl-rn-active-refresh'
               AND sort_order < 3
             ORDER BY sort_order`,
          )
          .all()
          .map((task) => task.title),
        expectedTaskTitles,
      );

      const repeatRuntime = await importTypeScriptModule(
        `${runtimeSource}\nexport const __nursingRefreshRepeatNonce = "repeat";`,
      );
      await repeatRuntime.initializeDatabase(database);
      assert.deepEqual(
        raw
          .prepare(
            `SELECT title
             FROM checklist_tasks
             WHERE credential_id = 'credential-fl-rn-active-refresh'
               AND sort_order < 3
             ORDER BY sort_order`,
          )
          .all()
          .map((task) => task.title),
        expectedTaskTitles,
      );
      assert.deepEqual(
        raw
          .prepare(
            `SELECT
               id,
               credential_id AS credentialId,
               title,
               kind,
               status,
               due_date AS dueDate,
               is_personal AS isPersonal,
               archived_at AS archivedAt,
               revision
             FROM checklist_tasks
             WHERE id IN (
               'task-fl-rn-completed-default',
               'task-fl-rn-personal-default',
               'task-fl-rn-archived-default',
               'task-fl-rn-custom-pending',
               'task-fl-rn-submitted-default'
             )
             ORDER BY id`,
          )
          .all()
          .map((row) => ({ ...row })),
        [
          {
            id: "task-fl-rn-archived-default",
            credentialId: "credential-fl-rn-active-refresh",
            title: "Submit renewal and save confirmation",
            kind: "submission",
            status: "pending",
            dueDate: "2027-08-03",
            isPersonal: 0,
            archivedAt: "2027-07-03 12:00:00",
            revision: 9,
          },
          {
            id: "task-fl-rn-completed-default",
            credentialId: "credential-fl-rn-active-refresh",
            title: "Review the renewal requirements",
            kind: "review",
            status: "completed",
            dueDate: "2027-08-01",
            isPersonal: 0,
            archivedAt: null,
            revision: 7,
          },
          {
            id: "task-fl-rn-custom-pending",
            credentialId: "credential-fl-rn-active-refresh",
            title: "Call the hospital credentialing office",
            kind: "review",
            status: "pending",
            dueDate: "2027-08-04",
            isPersonal: 0,
            archivedAt: null,
            revision: 10,
          },
          {
            id: "task-fl-rn-personal-default",
            credentialId: "credential-fl-rn-active-refresh",
            title: "Complete and document required education",
            kind: "progress",
            status: "pending",
            dueDate: "2027-08-02",
            isPersonal: 1,
            archivedAt: null,
            revision: 8,
          },
          {
            id: "task-fl-rn-submitted-default",
            credentialId: "credential-fl-rn-submitted-refresh",
            title: "Review the renewal requirements",
            kind: "review",
            status: "pending",
            dueDate: "2027-08-05",
            isPersonal: 0,
            archivedAt: null,
            revision: 11,
          },
        ],
        "task refresh must leave completed, personal, archived, custom, and submitted tasks untouched",
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM credential_requirements
             WHERE credential_id = 'credential-fl-rn-active-refresh'
               AND rule_category_id = 'fl-rn-2026-domestic-violence'`,
          )
          .get().count,
        1,
      );
      database.close();
    },
  );

  await t.test(
    "creates zero-total New York nursing plans and atomically adjusts Florida domestic-violence totals",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new SQLiteD1Database(DatabaseSync);
      const runtimeSource = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const runtimeModule = await importTypeScriptModule(
        `${runtimeSource}\nexport const __nursingWorkflowNonce = "zero-and-dynamic";`,
      );
      await runtimeModule.initializeDatabase(database);
      testCloudflareEnv.DB = database;
      const raw = database.raw;

      const floridaDates = {
        ruleSetId: "fl-rn-2026-v1",
        cycleStart: "2026-01-01",
        deadline: "2027-12-31",
      };
      const unattestedFloridaResponse = await postWorkspace(
        "createCredential",
        floridaDates,
      );
      assert.equal(unattestedFloridaResponse.status, 409);
      assert.equal(
        (await unattestedFloridaResponse.json()).code,
        "nursing_template_eligibility_required",
      );
      const shortenedFloridaResponse = await postWorkspace(
        "createCredential",
        {
          ...floridaDates,
          deadline: "2027-11-30",
          templateEligibilityAttested: true,
        },
      );
      assert.equal(shortenedFloridaResponse.status, 409);
      assert.equal(
        (await shortenedFloridaResponse.json()).code,
        "nursing_standard_cycle_dates_required",
      );

      const floridaPayload = {
        ...floridaDates,
        templateEligibilityAttested: true,
      };
      const floridaDueResponse = await postWorkspace("createCredential", {
        ...floridaPayload,
        applicabilityChoices: [
          {
            ruleCategoryId: "fl-rn-2026-domestic-violence",
            status: "applies",
          },
        ],
      });
      assert.equal(
        floridaDueResponse.status,
        200,
        JSON.stringify(await floridaDueResponse.clone().json()),
      );
      const floridaDueCredentialId = (await floridaDueResponse.json()).id;

      const floridaNotDueResponse = await postWorkspace(
        "createCredential",
        {
          ...floridaPayload,
          applicabilityChoices: [
            {
              ruleCategoryId: "fl-rn-2026-domestic-violence",
              status: "not_applicable",
            },
          ],
        },
      );
      assert.equal(
        floridaNotDueResponse.status,
        200,
        JSON.stringify(await floridaNotDueResponse.clone().json()),
      );
      const floridaNotDueCredentialId =
        (await floridaNotDueResponse.json()).id;
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT total_required AS totalRequired
               FROM credentials
               WHERE id = ?`,
            )
            .get(floridaDueCredentialId),
        },
        { totalRequired: 26 },
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT total_required AS totalRequired
               FROM credentials
               WHERE id = ?`,
            )
            .get(floridaNotDueCredentialId),
        },
        { totalRequired: 24 },
      );

      const floridaLpnPayload = {
        ruleSetId: "fl-lpn-2026-v1",
        cycleStart: "2026-01-01",
        deadline: "2027-12-31",
        templateEligibilityAttested: true,
      };
      const floridaLpnDueResponse = await postWorkspace(
        "createCredential",
        {
          ...floridaLpnPayload,
          applicabilityChoices: [
            {
              ruleCategoryId: "fl-lpn-2026-domestic-violence",
              status: "applies",
            },
          ],
        },
      );
      assert.equal(
        floridaLpnDueResponse.status,
        200,
        JSON.stringify(await floridaLpnDueResponse.clone().json()),
      );
      const floridaLpnDueCredentialId =
        (await floridaLpnDueResponse.json()).id;
      const floridaLpnNotDueResponse = await postWorkspace(
        "createCredential",
        {
          ...floridaLpnPayload,
          applicabilityChoices: [
            {
              ruleCategoryId: "fl-lpn-2026-domestic-violence",
              status: "not_applicable",
            },
          ],
        },
      );
      assert.equal(
        floridaLpnNotDueResponse.status,
        200,
        JSON.stringify(await floridaLpnNotDueResponse.clone().json()),
      );
      const floridaLpnNotDueCredentialId =
        (await floridaLpnNotDueResponse.json()).id;
      assert.deepEqual(
        raw
          .prepare(
            `SELECT id, total_required AS totalRequired
             FROM credentials
             WHERE id IN (?, ?)
             ORDER BY total_required DESC`,
          )
          .all(
            floridaLpnDueCredentialId,
            floridaLpnNotDueCredentialId,
          )
          .map((credential) => ({ ...credential })),
        [
          { id: floridaLpnDueCredentialId, totalRequired: 26 },
          { id: floridaLpnNotDueCredentialId, totalRequired: 24 },
        ],
      );
      const floridaLpnDomesticViolenceRequirementId = raw
        .prepare(
          `SELECT id
           FROM credential_requirements
           WHERE credential_id = ?
             AND rule_category_id = 'fl-lpn-2026-domestic-violence'`,
        )
        .get(floridaLpnNotDueCredentialId).id;
      const activateLpnResponse = await postWorkspace(
        "updateRequirementApplicability",
        {
          credentialId: floridaLpnNotDueCredentialId,
          choices: [
            {
              requirementId:
                floridaLpnDomesticViolenceRequirementId,
              status: "applies",
            },
          ],
        },
      );
      assert.equal(
        activateLpnResponse.status,
        200,
        JSON.stringify(await activateLpnResponse.clone().json()),
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 credential.total_required AS totalRequired,
                 requirement.applicability_status AS applicabilityStatus,
                 requirement.is_active AS isActive
               FROM credentials credential
               JOIN credential_requirements requirement
                 ON requirement.credential_id = credential.id
               WHERE credential.id = ? AND requirement.id = ?`,
            )
            .get(
              floridaLpnNotDueCredentialId,
              floridaLpnDomesticViolenceRequirementId,
            ),
        },
        {
          totalRequired: 26,
          applicabilityStatus: "applies",
          isActive: 1,
        },
      );
      const deactivateLpnResponse = await postWorkspace(
        "updateRequirementApplicability",
        {
          credentialId: floridaLpnNotDueCredentialId,
          choices: [
            {
              requirementId:
                floridaLpnDomesticViolenceRequirementId,
              status: "not_applicable",
            },
          ],
        },
      );
      assert.equal(
        deactivateLpnResponse.status,
        200,
        JSON.stringify(await deactivateLpnResponse.clone().json()),
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 credential.total_required AS totalRequired,
                 requirement.applicability_status AS applicabilityStatus,
                 requirement.is_active AS isActive
               FROM credentials credential
               JOIN credential_requirements requirement
                 ON requirement.credential_id = credential.id
               WHERE credential.id = ? AND requirement.id = ?`,
            )
            .get(
              floridaLpnNotDueCredentialId,
              floridaLpnDomesticViolenceRequirementId,
            ),
        },
        {
          totalRequired: 24,
          applicabilityStatus: "not_applicable",
          isActive: 0,
        },
      );

      const domesticViolenceRequirementId = raw
        .prepare(
          `SELECT id
           FROM credential_requirements
           WHERE credential_id = ?
             AND rule_category_id = 'fl-rn-2026-domestic-violence'`,
        )
        .get(floridaNotDueCredentialId).id;
      const activateResponse = await postWorkspace(
        "updateRequirementApplicability",
        {
          credentialId: floridaNotDueCredentialId,
          choices: [
            {
              requirementId: domesticViolenceRequirementId,
              status: "applies",
            },
          ],
        },
      );
      assert.equal(
        activateResponse.status,
        200,
        JSON.stringify(await activateResponse.clone().json()),
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 credential.total_required AS totalRequired,
                 requirement.applicability_status AS applicabilityStatus,
                 requirement.is_active AS isActive
               FROM credentials credential
               JOIN credential_requirements requirement
                 ON requirement.credential_id = credential.id
               WHERE credential.id = ?
                 AND requirement.id = ?`,
            )
            .get(
              floridaNotDueCredentialId,
              domesticViolenceRequirementId,
            ),
        },
        {
          totalRequired: 26,
          applicabilityStatus: "applies",
          isActive: 1,
        },
      );
      const deactivateResponse = await postWorkspace(
        "updateRequirementApplicability",
        {
          credentialId: floridaNotDueCredentialId,
          choices: [
            {
              requirementId: domesticViolenceRequirementId,
              status: "not_applicable",
            },
          ],
        },
      );
      assert.equal(
        deactivateResponse.status,
        200,
        JSON.stringify(await deactivateResponse.clone().json()),
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 credential.total_required AS totalRequired,
                 requirement.applicability_status AS applicabilityStatus,
                 requirement.is_active AS isActive
               FROM credentials credential
               JOIN credential_requirements requirement
                 ON requirement.credential_id = credential.id
               WHERE credential.id = ?
                 AND requirement.id = ?`,
            )
            .get(
              floridaNotDueCredentialId,
              domesticViolenceRequirementId,
            ),
        },
        {
          totalRequired: 24,
          applicabilityStatus: "not_applicable",
          isActive: 0,
        },
      );

      const floridaSubmissionResponse = await postWorkspace(
        "markSubmitted",
        {
          credentialId: floridaDueCredentialId,
          submissionDate: "2027-12-31",
          confirmationNumber: "MQA-NURSING-COMPLETE",
        },
      );
      assert.equal(
        floridaSubmissionResponse.status,
        200,
        JSON.stringify(await floridaSubmissionResponse.clone().json()),
      );
      const floridaAcceptancePayload = {
        credentialId: floridaDueCredentialId,
        acceptedAt: "2028-01-01",
        reference: "MQA-RENEWED",
        nextCycleStart: "2028-01-01",
        nextDeadline: "2029-12-31",
      };
      const unattestedFloridaAcceptance = await postWorkspace(
        "markRenewalAccepted",
        floridaAcceptancePayload,
      );
      assert.equal(unattestedFloridaAcceptance.status, 409);
      assert.equal(
        (await unattestedFloridaAcceptance.json()).code,
        "official_next_period_attestation_required",
      );
      const ineligibleFloridaAcceptance = await postWorkspace(
        "markRenewalAccepted",
        {
          ...floridaAcceptancePayload,
          officialDatesAttested: true,
        },
      );
      assert.equal(ineligibleFloridaAcceptance.status, 409);
      assert.equal(
        (await ineligibleFloridaAcceptance.json()).code,
        "nursing_next_template_eligibility_required",
      );
      const floridaAcceptanceResponse = await postWorkspace(
        "markRenewalAccepted",
        {
          ...floridaAcceptancePayload,
          officialDatesAttested: true,
          templateEligibilityAttested: true,
        },
      );
      assert.equal(
        floridaAcceptanceResponse.status,
        200,
        JSON.stringify(await floridaAcceptanceResponse.clone().json()),
      );
      const nextFloridaCredentialId =
        (await floridaAcceptanceResponse.json()).id;
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 rule_set_id AS ruleSetId,
                 cycle_start AS cycleStart,
                 deadline,
                 total_required AS totalRequired,
                 status
               FROM credentials
               WHERE id = ?`,
            )
            .get(nextFloridaCredentialId),
        },
        {
          ruleSetId: "fl-rn-2026-v1",
          cycleStart: "2028-01-01",
          deadline: "2029-12-31",
          totalRequired: 24,
          status: "active",
        },
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 applicability_status AS applicabilityStatus,
                 is_active AS isActive
               FROM credential_requirements
               WHERE credential_id = ?
                 AND rule_category_id =
                   'fl-rn-2026-domestic-violence'`,
            )
            .get(nextFloridaCredentialId),
        },
        {
          applicabilityStatus: "needs_confirmation",
          isActive: 0,
        },
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 COUNT(*) AS conditionalCount,
                 SUM(
                   CASE
                     WHEN applicability_status = 'needs_confirmation'
                       AND is_active = 0
                     THEN 1 ELSE 0
                   END
                 ) AS resetCount
               FROM credential_requirements
               WHERE credential_id = ?
                 AND applicability = 'conditional'`,
            )
            .get(nextFloridaCredentialId),
        },
        { conditionalCount: 3, resetCount: 3 },
      );

      const floridaLpnSubmissionResponse = await postWorkspace(
        "markSubmitted",
        {
          credentialId: floridaLpnDueCredentialId,
          submissionDate: "2027-12-31",
          confirmationNumber: "MQA-LPN-COMPLETE",
        },
      );
      assert.equal(
        floridaLpnSubmissionResponse.status,
        200,
        JSON.stringify(
          await floridaLpnSubmissionResponse.clone().json(),
        ),
      );
      const floridaLpnAcceptanceResponse = await postWorkspace(
        "markRenewalAccepted",
        {
          credentialId: floridaLpnDueCredentialId,
          acceptedAt: "2028-01-01",
          reference: "MQA-LPN-RENEWED",
          nextCycleStart: "2028-01-01",
          nextDeadline: "2029-12-31",
          officialDatesAttested: true,
          templateEligibilityAttested: true,
        },
      );
      assert.equal(
        floridaLpnAcceptanceResponse.status,
        200,
        JSON.stringify(
          await floridaLpnAcceptanceResponse.clone().json(),
        ),
      );
      const nextFloridaLpnCredentialId =
        (await floridaLpnAcceptanceResponse.json()).id;
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 rule_set_id AS ruleSetId,
                 total_required AS totalRequired,
                 status
               FROM credentials
               WHERE id = ?`,
            )
            .get(nextFloridaLpnCredentialId),
        },
        {
          ruleSetId: "fl-lpn-2026-v1",
          totalRequired: 24,
          status: "active",
        },
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 applicability_status AS applicabilityStatus,
                 is_active AS isActive
               FROM credential_requirements
               WHERE credential_id = ?
                 AND rule_category_id =
                   'fl-lpn-2026-domestic-violence'`,
            )
            .get(nextFloridaLpnCredentialId),
        },
        {
          applicabilityStatus: "needs_confirmation",
          isActive: 0,
        },
        "a due LPN domestic-violence condition must reset instead of inflating the next biennium",
      );

      const newYorkResponse = await postWorkspace("createCredential", {
        ruleSetId: "ny-rn-2026-v1",
        cycleStart: "2026-01-01",
        deadline: "2028-12-31",
        templateEligibilityAttested: true,
      });
      assert.equal(
        newYorkResponse.status,
        200,
        JSON.stringify(await newYorkResponse.clone().json()),
      );
      const newYorkCredentialId = (await newYorkResponse.json()).id;
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT total_required AS totalRequired, unit_label AS unitLabel
               FROM credentials
               WHERE id = ?`,
            )
            .get(newYorkCredentialId),
        },
        { totalRequired: 0, unitLabel: "training hours" },
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 COUNT(*) AS requirementCount,
                 SUM(CASE WHEN required_units = 0 THEN 1 ELSE 0 END)
                   AS zeroUnitCount,
                 SUM(CASE WHEN required_units = 2 THEN 1 ELSE 0 END)
                   AS twoHourCount,
                 SUM(CASE WHEN applicability_status = 'needs_confirmation'
                   THEN 1 ELSE 0 END) AS pendingConditionCount
               FROM credential_requirements
               WHERE credential_id = ?`,
            )
            .get(newYorkCredentialId),
        },
        {
          requirementCount: 4,
          zeroUnitCount: 3,
          twoHourCount: 1,
          pendingConditionCount: 4,
        },
      );
      assert.deepEqual(
        raw
          .prepare(
            `SELECT title
             FROM checklist_tasks
             WHERE credential_id = ?
             ORDER BY sort_order`,
          )
          .all(newYorkCredentialId)
          .map((task) => task.title),
        [
          "Confirm NYSED dates, New York practice, exemptions, child-abuse status, and any BSN-in-10 milestone",
          "Complete due infection-control and mandated-reporter training; track any BSN-in-10 milestone separately without treating it as CE",
          "Re-register with NYSED, complete the RN workforce survey, and save confirmation",
        ],
      );

      const texasBeforeUploadResponse = await postWorkspace(
        "createCredential",
        {
          ruleSetId: "tx-rn-2026-v1",
          cycleStart: "2024-09-01",
          deadline: "2026-08-31",
          templateEligibilityAttested: true,
        },
      );
      assert.equal(
        texasBeforeUploadResponse.status,
        200,
        JSON.stringify(await texasBeforeUploadResponse.clone().json()),
      );
      const texasBeforeUploadCredentialId =
        (await texasBeforeUploadResponse.json()).id;
      const texasUploadResponse = await postWorkspace(
        "createCredential",
        {
          ruleSetId: "tx-lvn-2026-v1",
          cycleStart: "2024-09-02",
          deadline: "2026-09-01",
          templateEligibilityAttested: true,
        },
      );
      assert.equal(
        texasUploadResponse.status,
        200,
        JSON.stringify(await texasUploadResponse.clone().json()),
      );
      const texasUploadCredentialId = (await texasUploadResponse.json()).id;
      assert.deepEqual(
        raw
          .prepare(
            `SELECT title
             FROM checklist_tasks
             WHERE credential_id = ? AND kind = 'submission'`,
          )
          .all(texasBeforeUploadCredentialId)
          .map((task) => task.title),
        [
          "Renew in the Nurse Portal and save confirmation; keep certificates ready for audit",
        ],
      );
      assert.deepEqual(
        raw
          .prepare(
            `SELECT title
             FROM checklist_tasks
             WHERE credential_id = ? AND kind = 'submission'`,
          )
          .all(texasUploadCredentialId)
          .map((task) => task.title),
        [
          "Upload all required verification in the Nurse Portal before renewing, then save confirmation",
        ],
      );
      assert.match(
        raw
          .prepare(
            `SELECT title
             FROM checklist_tasks
             WHERE credential_id = ? AND kind = 'review'`,
          )
          .get(texasUploadCredentialId).title,
        /standard 20-hour CNE path[\s\S]*jurisprudence and ethics six-year window[\s\S]*2027 nutrition-rule update/i,
      );

      const workspaceResponse = await fetchWorker(
        "https://license-lantern.example/api/workspace",
        { headers: authHeaders() },
      );
      assert.equal(workspaceResponse.status, 200);
      const workspace = await workspaceResponse.json();
      const newYorkCredential = workspace.credentials.find(
        (credential) => credential.id === newYorkCredentialId,
      );
      assert.ok(newYorkCredential);
      assert.equal(newYorkCredential.totalRequired, 0);
      assert.equal(newYorkCredential.requirements.length, 4);
      database.close();
    },
  );

  await t.test(
    "blocks New Jersey nursing carryover from satisfying the current-biennium opioid minimum",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new SQLiteD1Database(DatabaseSync);
      const runtimeSource = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const runtimeModule = await importTypeScriptModule(
        `${runtimeSource}\nexport const __nursingCarryoverNonce = "opioid-incompatibility";`,
      );
      await runtimeModule.initializeDatabase(database);
      testCloudflareEnv.DB = database;
      const raw = database.raw;

      const createResponse = await postWorkspace("createCredential", {
        ruleSetId: "nj-rn-2026-v1",
        cycleStart: "2026-01-01",
        deadline: "2027-12-31",
        templateEligibilityAttested: true,
        applicabilityChoices: [
          {
            ruleCategoryId: "nj-rn-2026-confirmed-carryover",
            status: "applies",
          },
          {
            ruleCategoryId: "nj-rn-2026-perinatal-bias",
            status: "not_applicable",
          },
        ],
      });
      assert.equal(
        createResponse.status,
        200,
        JSON.stringify(await createResponse.clone().json()),
      );
      const credentialId = (await createResponse.json()).id;
      const requirementRows = raw
        .prepare(
          `SELECT id, rule_category_id AS ruleCategoryId
           FROM credential_requirements
           WHERE credential_id = ?
             AND rule_category_id IN (
               'nj-rn-2026-confirmed-carryover',
               'nj-rn-2026-opioids'
             )`,
        )
        .all(credentialId);
      const requirementId = (categoryId) =>
        requirementRows.find(
          (requirement) => requirement.ruleCategoryId === categoryId,
        )?.id;
      const carryoverRequirementId = requirementId(
        "nj-rn-2026-confirmed-carryover",
      );
      const opioidRequirementId = requirementId("nj-rn-2026-opioids");
      assert.ok(carryoverRequirementId);
      assert.ok(opioidRequirementId);

      const invalidAdd = await postWorkspace("addActivity", {
        title: "Prior-biennium opioid course",
        provider: "Board-accepted provider",
        completionDate: "2025-12-15",
        totalUnits: 1,
        credentialId,
        requirementIds: [
          carryoverRequirementId,
          opioidRequirementId,
        ],
        evidenceStatus: "attached",
        evidenceReference: "NJ Board carryover record 2026",
        portalCarryoverAttested: true,
      });
      assert.equal(invalidAdd.status, 409);
      assert.equal(
        (await invalidAdd.json()).code,
        "incompatible_requirement_conflict",
      );

      const validCarryover = await postWorkspace("addActivity", {
        title: "Board-confirmed prior-biennium carryover",
        provider: "New Jersey Board record",
        completionDate: "2025-12-15",
        totalUnits: 1,
        credentialId,
        requirementIds: [carryoverRequirementId],
        evidenceStatus: "attached",
        evidenceReference: "NJ Board carryover record 2026",
        portalCarryoverAttested: true,
      });
      assert.equal(
        validCarryover.status,
        200,
        JSON.stringify(await validCarryover.clone().json()),
      );
      const activityId = (await validCarryover.json()).id;
      const allocationId = raw
        .prepare(
          `SELECT id
           FROM activity_allocations
           WHERE activity_id = ? AND credential_id = ?`,
        )
        .get(activityId, credentialId).id;

      const invalidRetag = await postWorkspace(
        "updateActivityAllocationRequirements",
        {
          allocationId,
          requirementIds: [
            carryoverRequirementId,
            opioidRequirementId,
          ],
        },
      );
      assert.equal(invalidRetag.status, 409);
      assert.equal(
        (await invalidRetag.json()).code,
        "incompatible_requirement_conflict",
      );
      assert.deepEqual(
        raw
          .prepare(
            `SELECT requirement_id AS requirementId
             FROM activity_requirement_matches
             WHERE allocation_id = ?
             ORDER BY requirement_id`,
          )
          .all(allocationId)
          .map((match) => match.requirementId),
        [carryoverRequirementId],
      );
      database.close();
    },
  );

  await t.test(
    "round-trips opaque owner-scoped drafts, salvages fields, and expires them",
    async () => {
      const draftSource = await readFile(
        new URL("../app/lib/activityDraft.ts", import.meta.url),
        "utf8",
      );
      const draftModule = await importTypeScriptModule(draftSource);
      const savedAt = new Date("2026-06-01T12:30:00.000Z");
      const input = {
        credentialId: "credential-phone",
        title: "Trauma-informed practice",
        completionDate: "2026-05-30",
        totalUnits: "3.5",
        provider: "State Medical Society",
      };

      const serialized = draftModule.serializeActivityDraft(input, savedAt);
      assert.deepEqual(
        draftModule.parseActivityDraft(
          serialized,
          new Date("2026-06-15T12:30:00.000Z"),
        ),
        {
          version: 1,
          savedAt: "2026-06-01T12:30:00.000Z",
          ...input,
        },
      );

      const ownerNamespace = `draft_${"a".repeat(64)}`;
      const ownerKey = draftModule.activityDraftStorageKey(ownerNamespace);
      assert.equal(
        ownerKey,
        draftModule.activityDraftStorageKey(ownerNamespace),
      );
      assert.notEqual(
        ownerKey,
        draftModule.activityDraftStorageKey(`draft_${"b".repeat(64)}`),
      );
      assert.match(
        ownerKey,
        /^license-lantern:activity-draft:v1:draft_[0-9a-f]{64}$/,
      );
      assert.throws(
        () => draftModule.activityDraftStorageKey("owner@example.com"),
        /namespace is invalid/i,
      );
      const legacyOwnerKey =
        draftModule.legacyActivityDraftStorageKey(" Owner@Example.com ");
      assert.equal(
        legacyOwnerKey,
        draftModule.legacyActivityDraftStorageKey("owner@example.com"),
      );
      assert.match(
        legacyOwnerKey,
        /^license-lantern:activity-draft:v1:[0-9a-f]{8}$/,
      );
      assert.doesNotMatch(legacyOwnerKey, /owner|example|@/i);

      const boundaryDraft = draftModule.serializeActivityDraft(
        input,
        new Date("2026-01-01T00:00:00.000Z"),
      );
      assert.ok(
        draftModule.parseActivityDraft(
          boundaryDraft,
          new Date("2026-01-31T00:00:00.000Z"),
        ),
        "a draft remains valid at the 30-day boundary",
      );
      assert.equal(
        draftModule.parseActivityDraft(
          boundaryDraft,
          new Date("2026-01-31T00:00:00.001Z"),
        ),
        null,
      );
      assert.equal(
        draftModule.activityDraftShouldBePurged(
          boundaryDraft,
          new Date("2026-01-31T00:00:00.001Z"),
        ),
        true,
      );

      const futureDraft = draftModule.serializeActivityDraft(
        input,
        new Date("2026-06-01T12:35:00.001Z"),
      );
      assert.equal(
        draftModule.parseActivityDraft(futureDraft, savedAt),
        null,
      );

      const incompleteDraft = {
        ...input,
        completionDate: "",
        totalUnits: "",
        provider: "P".repeat(180),
      };
      const serializedIncomplete = draftModule.serializeActivityDraft(
        incompleteDraft,
        savedAt,
      );
      assert.deepEqual(
        draftModule.parseActivityDraft(serializedIncomplete, savedAt),
        {
          version: 1,
          savedAt: savedAt.toISOString(),
          ...incompleteDraft,
        },
      );
      assert.equal(
        draftModule.activityDraftShouldBePurged(serializedIncomplete, savedAt),
        false,
      );

      const maximumUnitsDraft = draftModule.serializeActivityDraft(
        { ...input, totalUnits: "10000" },
        savedAt,
      );
      assert.equal(
        draftModule.parseActivityDraft(maximumUnitsDraft, savedAt).totalUnits,
        "10000",
      );

      const losslessLongFields = {
        ...input,
        title: "T".repeat(181),
        provider: "P".repeat(181),
      };
      assert.deepEqual(
        draftModule.parseActivityDraft(
          draftModule.serializeActivityDraft(losslessLongFields, savedAt),
          savedAt,
        ),
        {
          version: 1,
          savedAt: savedAt.toISOString(),
          ...losslessLongFields,
        },
      );
      const boundedDraft = JSON.parse(
        draftModule.serializeActivityDraft(
          {
            ...input,
            credentialId: "C".repeat(161),
            title: "T".repeat(10_001),
            provider: "P".repeat(10_001),
          },
          savedAt,
        ),
      );
      assert.equal(boundedDraft.credentialId.length, 160);
      assert.equal(boundedDraft.title.length, 10_000);
      assert.equal(boundedDraft.provider.length, 10_000);

      const partiallyInvalid = JSON.stringify({
        version: 1,
        savedAt: savedAt.toISOString(),
        credentialId: 42,
        title: input.title,
        completionDate: "not-a-date",
        totalUnits: "10000.1",
        provider: input.provider,
      });
      assert.deepEqual(
        draftModule.parseActivityDraft(partiallyInvalid, savedAt),
        {
          version: 1,
          savedAt: savedAt.toISOString(),
          credentialId: "",
          title: input.title,
          completionDate: "",
          totalUnits: "",
          provider: input.provider,
        },
      );

      const serializedWithPrivateExtras =
        draftModule.serializeActivityDraft(
          {
            ...input,
            ownerEmail: "owner@example.com",
            evidenceFile: { name: "private-certificate.pdf" },
            certificateBytes: "private-binary-data",
            scanText: "private OCR output",
            scanSuggestions: { title: "private scan suggestion" },
            requirementIds: ["private-requirement-id"],
          },
          savedAt,
        );
      const persisted = JSON.parse(serializedWithPrivateExtras);
      assert.deepEqual(Object.keys(persisted), [
        "version",
        "savedAt",
        "credentialId",
        "title",
        "completionDate",
        "totalUnits",
        "provider",
      ]);
      assert.doesNotMatch(
        serializedWithPrivateExtras,
        /owner@example|private-certificate|private-binary|private OCR|private-requirement/i,
      );
    },
  );

  await t.test(
    "replaces incompatible requirement tags without blocking valid overlays",
    async () => {
      const [compatibilitySource, clientSource] = await Promise.all([
        readFile(
          new URL(
            "../app/lib/requirementCompatibility.ts",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(
          new URL("../app/LicenseLanternApp.tsx", import.meta.url),
          "utf8",
        ),
      ]);
      const compatibilityModule =
        await importTypeScriptModule(compatibilitySource);
      const college = {
        id: "requirement-college",
        name: "Relevant College Coursework",
        ruleCategoryId: "ptcb-cpht-2026-college-coursework",
        exclusiveGroup: "PTCB capped activity type",
      };
      const patientSafety = {
        id: "requirement-patient-safety",
        name: "Patient Safety",
        ruleCategoryId: "ptcb-cpht-2026-patient-safety",
        exclusiveGroup: null,
      };
      const bls = {
        id: "requirement-bls",
        name: "Eligible BLS, CPR, or AED Training",
        ruleCategoryId: "ptcb-cpht-2026-bls-cpr-aed",
        exclusiveGroup: "PTCB capped activity type",
      };
      const available = [college, patientSafety, bls];

      assert.equal(
        compatibilityModule.requirementsAreIncompatible(bls, patientSafety),
        true,
      );
      assert.equal(
        compatibilityModule.requirementsAreIncompatible(
          college,
          patientSafety,
        ),
        false,
      );
      assert.match(
        compatibilityModule.requirementIncompatibilityMessage(
          patientSafety,
          available,
        ),
        /BLS, CPR, or AED training cannot satisfy Patient Safety/i,
      );
      assert.deepEqual(
        compatibilityModule.nextRequirementSelection(
          [college.id],
          patientSafety,
          available,
          true,
        ),
        [college.id, patientSafety.id],
        "College Coursework and Patient Safety remain a valid overlay",
      );
      assert.deepEqual(
        compatibilityModule.nextRequirementSelection(
          [patientSafety.id],
          bls,
          available,
          true,
        ),
        [bls.id],
        "selecting BLS replaces Patient Safety",
      );
      assert.deepEqual(
        compatibilityModule.nextRequirementSelection(
          [bls.id],
          patientSafety,
          available,
          true,
        ),
        [patientSafety.id],
        "selecting Patient Safety replaces BLS",
      );
      const technicianSpecific = {
        id: "requirement-technician-specific",
        name: "Technician-Specific CE",
        ruleCategoryId: "ptcb-cpht-2026-technician-specific",
      };
      const volunteerCare = {
        id: "requirement-volunteer-care",
        name: "Qualifying Volunteer Medical Care",
        ruleCategoryId: "nj-physician-2026-volunteer-care",
      };
      const opioids = {
        id: "requirement-opioids",
        name: "Prescription Opioid Drugs",
        ruleCategoryId: "nj-physician-2026-opioids",
      };
      const givingBack = {
        id: "requirement-giving-back",
        name: "Giving Back to the Profession",
        ruleCategoryId: "pmi-pmp-2026-giving-back",
      };
      const waysOfWorking = {
        id: "requirement-ways-of-working",
        name: "Ways of Working",
        ruleCategoryId: "pmi-pmp-2026-ways-of-working",
      };
      const californiaSupervision = {
        id: "requirement-ca-supervision",
        name: "Supervision Continuing Professional Development",
        ruleCategoryId:
          "ca-bbs-lmft-lcsw-lpcc-standard-2026-supervision-cpd",
      };
      const californiaLawEthics = {
        id: "requirement-ca-law-ethics",
        name: "Law and Ethics",
        ruleCategoryId:
          "ca-bbs-lmft-lcsw-lpcc-standard-2026-law-ethics",
      };
      const newJerseyCarryover = {
        id: "requirement-nj-carryover",
        name: "Committee-Confirmed Carryover",
        ruleCategoryId:
          "nj-lpc-standard-renewal-2026-confirmed-carryover",
      };
      const newJerseyOpioid = {
        id: "requirement-nj-opioid",
        name: "Prescription Opioid Risks",
        ruleCategoryId: "nj-lpc-standard-renewal-2026-opioid",
      };
      const newJerseyRnCarryover = {
        id: "requirement-nj-rn-carryover",
        name: "Board-Eligible Confirmed Carryover",
        ruleCategoryId: "nj-rn-2026-confirmed-carryover",
      };
      const newJerseyRnOpioid = {
        id: "requirement-nj-rn-opioid",
        name: "Prescription Opioids",
        ruleCategoryId: "nj-rn-2026-opioids",
      };
      const newJerseyLpnCarryover = {
        id: "requirement-nj-lpn-carryover",
        name: "Board-Eligible Confirmed Carryover",
        ruleCategoryId: "nj-lpn-2026-confirmed-carryover",
      };
      const newJerseyLpnOpioid = {
        id: "requirement-nj-lpn-opioid",
        name: "Prescription Opioids",
        ruleCategoryId: "nj-lpn-2026-prescription-opioids",
      };
      const pennsylvaniaEthics = {
        id: "requirement-pa-ethics",
        name: "Ethics",
        ruleCategoryId: "pa-lpc-standard-renewal-2026-ethics",
      };
      const pennsylvaniaSuicidePrevention = {
        id: "requirement-pa-suicide",
        name: "Suicide Prevention",
        ruleCategoryId:
          "pa-lpc-standard-renewal-2026-suicide-prevention",
      };
      for (const [classifier, disallowedTag, messagePattern] of [
        [
          bls,
          technicianSpecific,
          /cannot satisfy Technician-Specific CE/i,
        ],
        [
          volunteerCare,
          opioids,
          /volunteer medical care credit cannot satisfy Category I/i,
        ],
        [
          givingBack,
          waysOfWorking,
          /Giving Back PDUs[\s\S]*?cannot satisfy Talent Triangle Education/i,
        ],
        [
          californiaSupervision,
          californiaLawEthics,
          /supervision CPD cannot also satisfy the general Law and Ethics/i,
        ],
        [
          newJerseyCarryover,
          newJerseyOpioid,
          /carryover cannot satisfy the current-period prescription-opioid/i,
        ],
        [
          newJerseyRnCarryover,
          newJerseyRnOpioid,
          /RN carryover cannot satisfy the current-biennium prescription-opioid/i,
        ],
        [
          newJerseyLpnCarryover,
          newJerseyLpnOpioid,
          /LPN carryover cannot satisfy the current-biennium prescription-opioid/i,
        ],
        [
          pennsylvaniaEthics,
          pennsylvaniaSuicidePrevention,
          /suicide-prevention credit cannot also satisfy the ethics/i,
        ],
      ]) {
        assert.equal(
          compatibilityModule.requirementsAreIncompatible(
            classifier,
            disallowedTag,
          ),
          true,
        );
        assert.match(
          compatibilityModule.requirementIncompatibilityMessage(
            classifier,
            [classifier, disallowedTag],
          ),
          messagePattern,
        );
        assert.deepEqual(
          compatibilityModule.nextRequirementSelection(
            [disallowedTag.id],
            classifier,
            [classifier, disallowedTag],
            true,
          ),
          [classifier.id],
          `${classifier.name} replaces the disallowed minimum tag`,
        );
      }
      assert.match(
        clientSource,
        /nextRequirementSelection\(current,\s*requirement,\s*selectable,\s*checked\)/,
      );
      assert.match(
        clientSource,
        /requirementIncompatibilityMessage\(\s*requirement,\s*selectable,\s*\)/,
      );
    },
  );

  await t.test(
    "models Florida mental-health phase alternation and fixed odd-year cycles",
    async () => {
      const floridaSource = await readFile(
        new URL("../app/lib/floridaMentalHealth.ts", import.meta.url),
        "utf8",
      );
      const floridaModule = await importTypeScriptModule(floridaSource);
      const ethics =
        "fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-v1";
      const telehealth =
        "fl-lcsw-lmft-lmhc-telehealth-phase-2026-v1";
      assert.equal(
        floridaModule.oppositeFloridaMentalHealthRuleSetId(ethics),
        telehealth,
      );
      assert.equal(
        floridaModule.oppositeFloridaMentalHealthRuleSetId(telehealth),
        ethics,
      );
      assert.equal(
        floridaModule.oppositeFloridaMentalHealthRuleSetId(
          "fl-lcsw-lmft-lmhc-unknown",
        ),
        null,
      );
      assert.equal(
        floridaModule.isFloridaMentalHealthCycle(
          "2025-04-01",
          "2027-03-31",
        ),
        true,
      );
      for (const [cycleStart, deadline] of [
        ["2026-04-01", "2028-03-31"],
        ["2025-04-02", "2027-03-31"],
        ["2025-04-01", "2028-03-31"],
        ["not-a-date", "2027-03-31"],
      ]) {
        assert.equal(
          floridaModule.isFloridaMentalHealthCycle(cycleStart, deadline),
          false,
        );
      }
      assert.deepEqual(
        floridaModule.nextFloridaMentalHealthCycle("2027-03-31"),
        {
          cycleStart: "2027-04-01",
          deadline: "2029-03-31",
        },
      );
      assert.equal(
        floridaModule.nextFloridaMentalHealthCycle("2028-03-31"),
        null,
      );
    },
  );

  await t.test(
    "uses explicit carryover policies and clamps leap-day lookbacks",
    async () => {
      const carryoverSource = await readFile(
        new URL("../app/lib/carryover.ts", import.meta.url),
        "utf8",
      );
      const carryoverModule =
        await importTypeScriptModule(carryoverSource);
      assert.equal(
        carryoverModule.portalCarryoverLookbackYears(
          "pa-professional-educator-act-48-2026-confirmed-carryover",
        ),
        2,
      );
      assert.equal(
        carryoverModule.portalCarryoverLookbackYears(
          "invented-confirmed-carryover",
        ),
        null,
      );
      assert.equal(
        carryoverModule.portalCarryoverLookbackMonths(
          "nj-pharmacist-2026-confirmed-carryover",
        ),
        6,
      );
      assert.equal(
        carryoverModule.calendarMonthsBefore("2028-08-31", 6),
        "2028-02-29",
      );
      assert.equal(
        carryoverModule.calendarYearsBefore("2028-02-29", 1),
        "2027-02-28",
      );
      assert.equal(
        carryoverModule.calendarYearsBefore("2028-02-29", 2),
        "2026-02-28",
      );
    },
  );

  await t.test(
    "solves overlapping capped credit as one exact feasible allocation",
    async () => {
      const cappedCreditSource = await readFile(
        new URL("../app/lib/cappedCredit.ts", import.meta.url),
        "utf8",
      );
      const cappedCreditModule =
        await importTypeScriptModule(cappedCreditSource);
      const solve = cappedCreditModule.cappedCreditTotals;

      assert.deepEqual(
        solve(
          [{ allocationId: "shared", allocatedUnits: 12 }],
          [
            {
              requirementId: "administrative",
              maximumUnits: 6,
              matches: [
                { allocationId: "shared", matchedUnits: 12 },
              ],
            },
            {
              requirementId: "presenter",
              maximumUnits: 10,
              matches: [
                { allocationId: "shared", matchedUnits: 12 },
              ],
            },
          ],
        ),
        { countableUnits: 6, excludedUnits: 6 },
      );

      const intersectionModel = {
        allocations: [
          { allocationId: "shared", allocatedUnits: 10 },
          { allocationId: "a-only", allocatedUnits: 10 },
          { allocationId: "b-only", allocatedUnits: 10 },
        ],
        constraints: [
          {
            requirementId: "a",
            maximumUnits: 10,
            matches: [
              { allocationId: "shared", matchedUnits: 10 },
              { allocationId: "a-only", matchedUnits: 10 },
            ],
          },
          {
            requirementId: "b",
            maximumUnits: 10,
            matches: [
              { allocationId: "shared", matchedUnits: 10 },
              { allocationId: "b-only", matchedUnits: 10 },
            ],
          },
        ],
      };
      assert.deepEqual(
        solve(
          intersectionModel.allocations,
          intersectionModel.constraints,
        ),
        { countableUnits: 20, excludedUnits: 10 },
      );
      assert.deepEqual(
        solve(
          [...intersectionModel.allocations].reverse(),
          [...intersectionModel.constraints].reverse(),
        ),
        { countableUnits: 20, excludedUnits: 10 },
      );
      assert.deepEqual(
        solve(
          [
            { allocationId: "a-only", allocatedUnits: 10 },
            { allocationId: "b-only", allocatedUnits: 10 },
          ],
          [
            {
              requirementId: "a",
              maximumUnits: 6,
              matches: [
                { allocationId: "a-only", matchedUnits: 10 },
              ],
            },
            {
              requirementId: "b",
              maximumUnits: 7,
              matches: [
                { allocationId: "b-only", matchedUnits: 10 },
              ],
            },
          ],
        ),
        { countableUnits: 13, excludedUnits: 7 },
      );
      assert.throws(
        () =>
          solve(
            [{ allocationId: "partial", allocatedUnits: 1 }],
            [
              {
                requirementId: "cap",
                maximumUnits: 1,
                matches: [
                  {
                    allocationId: "partial",
                    matchedUnits: 0.5,
                  },
                ],
              },
            ],
          ),
        /partial allocation match/i,
      );
    },
  );

  await t.test(
    "builds safe all-day calendar files with escaping and Unicode-aware folding",
    async () => {
      const calendarSource = await readFile(
        new URL("../app/lib/calendarInvite.ts", import.meta.url),
        "utf8",
      );
      const calendarModule = await importTypeScriptModule(calendarSource);
      const checkInCalendarSource = await readFile(
        new URL("../app/lib/checkInCalendar.ts", import.meta.url),
        "utf8",
      );
      const checkInCalendarModule = await importTypeScriptModule(
        checkInCalendarSource,
      );
      const generatedAt = new Date("2026-07-26T14:05:06.000Z");
      const baseEvent = {
        uid: "credential:one/renewal",
        title: "License renewal",
        description: "Confirm requirements before filing.",
        date: "2028-02-28",
        reminderDaysBefore: 30,
      };

      const allDayInvite = calendarModule.buildCalendarInvite(
        [baseEvent],
        generatedAt,
      );
      assert.match(allDayInvite, /\r\n$/);
      assert.match(
        allDayInvite,
        /\r\nX-WR-CALNAME:License Lantern check-ins\r\n/,
      );
      assert.match(allDayInvite, /\r\nDTSTAMP:20260726T140506Z\r\n/);
      assert.match(
        allDayInvite,
        /\r\nDTSTART;VALUE=DATE:20280228\r\n/,
      );
      assert.match(allDayInvite, /\r\nDTEND;VALUE=DATE:20280229\r\n/);
      assert.match(allDayInvite, /\r\nTRIGGER:-P30D\r\n/);
      assert.doesNotMatch(
        allDayInvite,
        /DTSTART(?:;[^:]*)?:\d{8}T\d{6}/,
      );

      const reminderSchedule = [1, 30, 7, 30, -4, 999];
      const reminderScheduleSnapshot = [...reminderSchedule];
      const multiAlarmInvite = calendarModule.buildCalendarInvite(
        [
          {
            ...baseEvent,
            reminderDaysBefore: reminderSchedule,
          },
        ],
        generatedAt,
      );
      assert.deepEqual(reminderSchedule, reminderScheduleSnapshot);
      assert.deepEqual(
        [...multiAlarmInvite.matchAll(/\r\nTRIGGER:([^\r]+)\r\n/g)].map(
          (match) => match[1],
        ),
        ["-P365D", "-P30D", "-P7D", "-P1D", "-PT0M"],
      );
      assert.equal(
        (multiAlarmInvite.match(/\r\nBEGIN:VALARM\r\n/g) ?? []).length,
        5,
      );
      const noAlarmInvite = calendarModule.buildCalendarInvite(
        [{ ...baseEvent, reminderDaysBefore: [] }],
        generatedAt,
      );
      assert.doesNotMatch(noAlarmInvite, /BEGIN:VALARM/);
      assert.deepEqual(
        checkInCalendarModule.normalizedCalendarLeadDays(undefined),
        [30],
      );
      assert.deepEqual(
        checkInCalendarModule.normalizedCalendarLeadDays([]),
        [],
      );
      assert.deepEqual(
        checkInCalendarModule.normalizedCalendarLeadDays([
          7, 30, 7,
        ]),
        [30, 7],
      );

      const bulkEvents =
        checkInCalendarModule.allCheckInCalendarEvents(
          [
            {
              id: "active",
              credentialName: "Active license",
              jurisdiction: "Test",
              status: "active",
              deadline: "2028-12-31",
              tasks: [
                {
                  id: "review",
                  title: "Review requirements",
                  kind: "review",
                  status: "pending",
                  dueDate: "2028-09-01",
                },
                {
                  id: "submission",
                  title: "Submit renewal",
                  kind: "submission",
                  status: "pending",
                  dueDate: "2028-12-31",
                },
              ],
            },
            {
              id: "submitted",
              ruleSetId:
                "ny-professional-classroom-teacher-standard-ctle-2026-v1",
              credentialName: "Submitted compliance period",
              jurisdiction: "New York",
              status: "submitted",
              submittedAt: "2028-02-01T12:00:00.000Z",
              deadline: "2028-12-31",
              tasks: [
                {
                  id: "progress",
                  title: "Retain official record",
                  kind: "progress",
                  status: "pending",
                  dueDate: "2028-06-01",
                },
              ],
            },
          ],
          [],
        );
      assert.deepEqual(
        bulkEvents.map((event) => event.uid),
        [
          "credential-active-2028-12-31",
          "task:review:2028-09-01",
          "task:progress:2028-06-01",
          "acceptance:submitted:2028-02-01",
        ],
      );
      assert.equal(
        bulkEvents.find(
          (event) =>
            event.uid === "acceptance:submitted:2028-02-01",
        ).date,
        "2028-12-31",
      );
      assert.ok(
        bulkEvents.every(
          (event) => event.reminderDaysBefore.length === 0,
        ),
      );
      assert.deepEqual(
        checkInCalendarModule.reminderCalendarEvent(
          {
            key: "reminder-one",
            title: "Check status",
            body: "Review the portal.",
            eventDate: "2028-03-01",
          },
          [30, 7],
        ).reminderDaysBefore,
        [30, 7],
      );
      assert.equal(
        checkInCalendarModule.reminderCalendarEvent(
          {
            key: "deadline:active:2028-12-31",
            credentialId: "active",
            kind: "deadline",
            title: "Active license renewal deadline",
            body: "Review the official record.",
            eventDate: "2028-12-31",
          },
          [],
        ).uid,
        "credential-active-2028-12-31",
      );

      const escapedInvite = calendarModule.buildCalendarInvite(
        [
          {
            ...baseEvent,
            title: "Ethics, law; \\ practice\nNext",
            description: "First, verify; then \\ file\r\nKeep proof",
          },
        ],
        generatedAt,
      );
      assert.ok(
        escapedInvite.includes(
          "SUMMARY:Ethics\\, law\\; \\\\ practice\\nNext",
        ),
      );
      assert.ok(
        escapedInvite.includes(
          "DESCRIPTION:First\\, verify\\; then \\\\ file\\nKeep proof",
        ),
      );
      const controlSafeInvite = calendarModule.buildCalendarInvite(
        [
          {
            ...baseEvent,
            title: "Before\u0000\u0007\u0085After\tTabbed\u2028Next",
            description: "Proof\u0001\u007f retained\u2029Review",
          },
        ],
        generatedAt,
      );
      assert.doesNotMatch(
        controlSafeInvite,
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/,
      );
      assert.ok(
        controlSafeInvite.includes(
          "SUMMARY:BeforeAfter\tTabbed\\nNext",
        ),
      );
      assert.ok(
        controlSafeInvite.includes(
          "DESCRIPTION:Proof retained\\nReview",
        ),
      );

      const injectedInvite = calendarModule.buildCalendarInvite(
        [
          {
            ...baseEvent,
            uid: "safe\r\nX-OWNER:attacker",
            title: "Safe\r\nEND:VEVENT\r\nBEGIN:VEVENT",
            description: "Details\r\nX-PRIVATE:secret",
            url: "https://example.com/\r\nX-EVIL:injected",
          },
        ],
        generatedAt,
      );
      const injectionLines = injectedInvite.split("\r\n");
      assert.equal(
        injectionLines.filter((line) => line === "BEGIN:VEVENT").length,
        1,
      );
      assert.equal(
        injectionLines.filter((line) => line === "END:VEVENT").length,
        1,
      );
      assert.ok(
        injectionLines.some((line) =>
          line.includes("Safe\\nEND:VEVENT\\nBEGIN:VEVENT"),
        ),
      );
      assert.ok(
        injectionLines.some((line) =>
          line.includes("Details\\nX-PRIVATE:secret"),
        ),
      );
      assert.doesNotMatch(injectedInvite, /\r\n(?:X-OWNER|X-PRIVATE|X-EVIL):/);
      assert.doesNotMatch(injectedInvite, /\r\nURL:/);

      const unicodeTitle =
        "Éthique ⚖️ · 資料保護 · renovación · renewal ".repeat(8).trim();
      const unicodeInvite = calendarModule.buildCalendarInvite(
        [{ ...baseEvent, title: unicodeTitle }],
        generatedAt,
      );
      assert.match(unicodeInvite, /\r\n /);
      for (const line of unicodeInvite.split("\r\n")) {
        assert.ok(
          Buffer.byteLength(line, "utf8") <= 75,
          `calendar line exceeds 75 UTF-8 octets: ${line}`,
        );
      }
      assert.ok(
        unicodeInvite
          .replaceAll("\r\n ", "")
          .includes(`SUMMARY:${unicodeTitle}`),
      );
      assert.doesNotMatch(unicodeInvite, /\uFFFD/);

      for (const invalidDate of [
        "2026-02-29",
        "2026-04-31",
        "2026-13-01",
        "2026-7-01",
        "2026-07-01\r\nX-EVIL:1",
      ]) {
        assert.throws(
          () =>
            calendarModule.buildCalendarInvite(
              [{ ...baseEvent, date: invalidDate }],
              generatedAt,
            ),
          /calendar event has an invalid date/i,
        );
      }
      assert.throws(
        () => calendarModule.buildCalendarInvite([], generatedAt),
        /at least one calendar event is required/i,
      );
      assert.throws(
        () =>
          calendarModule.buildCalendarInvite(
            [baseEvent],
            new Date("not-a-date"),
          ),
        /calendar generation time is invalid/i,
      );
      assert.match(
        calendarSource,
        /title: "License Lantern calendar check-ins"[\s\S]*?text: "Add these license and compliance check-ins to your calendar\."/,
      );
    },
  );

  await t.test(
    "ships the installable phone companion without caching private data",
    async () => {
      const [
        manifestSource,
        layoutSource,
        clientSource,
        builtClientSource,
        workerSource,
        builtWorkerSource,
        offlineSource,
        builtOfflineSource,
        headersSource,
        builtHeadersSource,
        stylesSource,
      ] = await Promise.all([
        readFile(new URL("../app/manifest.ts", import.meta.url), "utf8"),
        readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
        readFile(
          new URL("../app/LicenseLanternApp.tsx", import.meta.url),
          "utf8",
        ),
        readBuiltClientAppSource(),
        readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
        readFile(new URL("../dist/client/sw.js", import.meta.url), "utf8"),
        readFile(new URL("../public/offline.html", import.meta.url), "utf8"),
        readFile(
          new URL("../dist/client/offline.html", import.meta.url),
          "utf8",
        ),
        readFile(new URL("../public/_headers", import.meta.url), "utf8"),
        readFile(new URL("../dist/client/_headers", import.meta.url), "utf8"),
        readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
      ]);

      const manifestResponse = await fetchWorker(
        "http://localhost/manifest.webmanifest",
        { headers: { accept: "application/manifest+json" } },
      );
      assert.equal(manifestResponse.status, 200);
      assert.match(
        manifestResponse.headers.get("content-type") ?? "",
        /application\/manifest\+json|application\/json/i,
      );
      const manifest = await manifestResponse.json();
      assert.equal(
        manifest.name,
        "License Lantern — CE & Renewal Tracker",
      );
      assert.equal(manifest.short_name, "Lantern");
      assert.equal(manifest.start_url, "/");
      assert.equal(manifest.scope, "/");
      assert.equal(manifest.display, "standalone");
      assert.equal(manifest.background_color, "#f6f4ee");
      assert.equal(manifest.theme_color, "#163f36");
      assert.ok(
        manifest.icons.some(
          (icon) =>
            icon.src === "/icon-192.png" && icon.sizes === "192x192",
        ),
      );
      assert.ok(
        manifest.icons.some(
          (icon) =>
            icon.src === "/icon-512.png" && icon.sizes === "512x512",
        ),
      );
      assert.match(manifestSource, /display:\s*"standalone"/);
      assert.match(manifestSource, /start_url:\s*"\/"/);
      assert.match(layoutSource, /manifest:\s*"\/manifest\.webmanifest"/);
      assert.match(layoutSource, /appleWebApp:\s*\{/);
      assert.match(layoutSource, /viewportFit:\s*"cover"/);

      for (const [fileName, expectedDimensions] of [
        ["icon-192.png", { width: 192, height: 192 }],
        ["icon-512.png", { width: 512, height: 512 }],
        ["apple-touch-icon.png", { width: 180, height: 180 }],
      ]) {
        const [sourceIcon, builtIcon] = await Promise.all([
          readFile(new URL(`../public/${fileName}`, import.meta.url)),
          readFile(new URL(`../dist/client/${fileName}`, import.meta.url)),
        ]);
        assert.ok(sourceIcon.length > 1_000, `${fileName} is unexpectedly small`);
        assert.deepEqual(pngDimensions(sourceIcon), expectedDimensions);
        assert.deepEqual(builtIcon, sourceIcon);
      }

      assert.equal(builtWorkerSource, workerSource);
      assert.equal(builtOfflineSource, offlineSource);
      assert.equal(builtHeadersSource, headersSource);
      assert.match(
        offlineSource,
        /Account data,\s+APIs,\s+and certificates are never stored in this offline\s+page\./,
      );
      assert.doesNotMatch(
        offlineSource,
        /localStorage|indexedDB|\/api\/|certificate data/i,
      );
      assert.match(headersSource, /\/sw\.js[\s\S]*?no-cache, no-store/i);

      assert.match(
        workerSource,
        /request\.method !== "GET" \|\| url\.origin !== self\.location\.origin/,
      );
      assert.match(workerSource, /request\.headers\.has\("authorization"\)/);
      assert.match(workerSource, /request\.headers\.has\("range"\)/);
      assert.match(
        workerSource,
        /isPathOrDescendant\(url\.pathname, "\/api"\)/,
      );
      assert.match(
        workerSource,
        /AUTH_PATHS\.some\(\(path\) => isPathOrDescendant\(url\.pathname, path\)\)/,
      );
      const navigationBranch = workerSource.match(
        /if \(request\.mode === "navigate"\) \{[\s\S]*?\n  \}/,
      )?.[0];
      assert.ok(navigationBranch);
      assert.match(
        navigationBranch,
        /fetch\(request\)\.catch\(async \(\) => \{/,
      );
      assert.match(navigationBranch, /caches\.open\(CACHE_NAME\)/);
      assert.match(navigationBranch, /cache\.match\("\/offline\.html"\)/);
      assert.match(navigationBranch, /"cache-control": "no-store"/);
      assert.doesNotMatch(
        navigationBranch,
        /cache\.(?:put|add|addAll)\(/,
      );
      assert.match(
        workerSource,
        /responseUrl\.origin !== self\.location\.origin/,
      );
      assert.match(
        workerSource,
        /responseUrl\.pathname !== requestedUrl\.pathname/,
      );
      assert.match(workerSource, /\\bno-store\\b/);

      for (const source of [clientSource, builtClientSource]) {
        assert.match(source, /Saved in this browser/);
        assert.match(source, /Saving in this browser/);
        assert.match(source, /Browser draft unavailable/);
        assert.match(source, /stored unencrypted in this browser/);
        assert.match(source, /OCR-derived suggestions/);
        assert.match(source, /raw OCR text/);
        assert.doesNotMatch(
          source,
          /Draft protected on this device|device-only course draft|scan results are never stored/,
        );
        assert.match(source, /Offline — your cloud record is protected/);
        assert.match(source, /Reconnect to save/);
        assert.match(source, /Install on this device/);
        assert.match(source, /date to calendar/);
        assert.match(source, /Add all check-ins to calendar/);
        assert.match(
          source,
          /calendar can alert on the lead days selected here/,
        );
      }
      assert.match(
        clientSource,
        /＋ Add[\s\S]*?isCompliancePeriodCredential\(selected\)[\s\S]*?\? "compliance"[\s\S]*?: "renewal"[\s\S]*?date to calendar/,
      );
      assert.match(
        clientSource,
        /activityDraftStorageKey\(workspace\.user\.draftStorageNamespace\)/,
      );
      assert.doesNotMatch(
        clientSource,
        /activityDraftStorageKey\(workspace\.user\.email\)/,
      );
      assert.match(
        clientSource,
        /legacyActivityDraftStorageKey\(workspace\.user\.email\)/,
      );
      assert.match(
        clientSource,
        /localStorage\.setItem\(draftStorageKey, legacySerialized\)[\s\S]*?localStorage\.removeItem\(legacyDraftStorageKey\)/,
      );
      assert.match(
        clientSource,
        /activityDraftShouldBePurged\(serialized\)[\s\S]*?localStorage\.removeItem\(draftStorageKey\)/,
      );
      assert.match(
        clientSource,
        /localStorage\.setItem\([\s\S]*?setActivityDraftPersistenceStatus\("saved"\)[\s\S]*?catch[\s\S]*?setActivityDraftPersistenceStatus\("unavailable"\)/,
      );
      assert.match(
        clientSource,
        /const draftPersisted = persistActivityDraftNow\(\);[\s\S]*?if \(!draftPersisted\)[\s\S]*?couldn’t save your draft[\s\S]*?return;[\s\S]*?setActivityOpen\(false\)/,
      );
      assert.match(
        clientSource,
        /parseActivityDraft\(serialized\)[\s\S]*?setActivityDraftRestored\(true\)/,
      );
      assert.match(
        clientSource,
        /maxLength=\{ACTIVITY_DRAFT_TITLE_MAX_LENGTH\}/,
      );
      assert.match(
        clientSource,
        /maxLength=\{ACTIVITY_DRAFT_PROVIDER_MAX_LENGTH\}/,
      );
      assert.match(clientSource, /max=\{ACTIVITY_DRAFT_MAX_UNITS\}/);
      assert.match(
        clientSource,
        /navigator\.serviceWorker[\s\S]*?register\("\/sw\.js"/,
      );
      assert.match(clientSource, /window\.addEventListener\("offline"/);
      assert.match(clientSource, /window\.addEventListener\("online"/);
      assert.match(clientSource, /window\.addEventListener\("beforeinstallprompt"/);
      assert.match(clientSource, /window\.addEventListener\("appinstalled"/);
      assert.match(
        clientSource,
        /setSelectedCredentialId\(""\)[\s\S]*?credential originally linked to this draft is no longer active/,
      );
      assert.match(
        clientSource,
        /const activityCredential =[\s\S]*?selectedCredentialId,[\s\S]*?\?\? null/,
      );
      assert.match(
        clientSource,
        /workspaceLoadFailed[\s\S]*?<WorkspaceLoadFailure[\s\S]*?function WorkspaceLoadFailure/,
      );
      assert.match(clientSource, /element\.inert = true/);
      assert.match(clientSource, /event\.key !== "Tab"/);
      assert.match(clientSource, /previouslyFocused\.focus/);
      assert.match(clientSource, /status === 401 \|\| status === 403/);
      assert.match(clientSource, /Reload and sign in/);
      const baseStyles = stylesSource.split(
        "@media (max-width: 1040px)",
      )[0];
      assert.match(
        baseStyles,
        /\.desktop-sidebar[\s\S]*?safe-area-inset-top[\s\S]*?safe-area-inset-bottom[\s\S]*?safe-area-inset-left/,
      );
      assert.match(
        baseStyles,
        /\.main-content[\s\S]*?safe-area-inset-top[\s\S]*?safe-area-inset-right[\s\S]*?safe-area-inset-bottom[\s\S]*?safe-area-inset-left/,
      );
      assert.match(
        baseStyles,
        /\.modal-backdrop[\s\S]*?safe-area-inset-top[\s\S]*?safe-area-inset-right[\s\S]*?safe-area-inset-bottom[\s\S]*?safe-area-inset-left/,
      );
      assert.match(
        stylesSource,
        /mobile-header[\s\S]*?safe-area-inset-top[\s\S]*?safe-area-inset-right[\s\S]*?safe-area-inset-left/,
      );
      assert.match(
        stylesSource,
        /mobile-nav[\s\S]*?safe-area-inset-right[\s\S]*?safe-area-inset-bottom[\s\S]*?safe-area-inset-left/,
      );
      assert.match(
        stylesSource,
        /\.capture-privacy\s*\{[^}]*font-size:\s*11px/,
      );
      assert.match(
        stylesSource,
        /\.draft-safety-note small\s*\{[^}]*font-size:\s*11px/,
      );
      assert.match(
        stylesSource,
        /\.draft-safety-note button\s*\{[^}]*min-height:\s*44px/,
      );
      assert.match(
        clientSource,
        /reminderCalendarEvent\(\s*reminder,\s*preferredCalendarLeadDays\(\)/,
      );
      assert.match(
        clientSource,
        /credentialDeadlineCalendarEvent\(\s*credential,\s*preferredCalendarLeadDays\(\)/,
      );
    },
  );

  await t.test("ships durable D1, R2, and migration bindings", async () => {
    const [
      hostingSource,
      builtHostingSource,
      baseMigration,
      evidenceMigration,
      lifecycleMigration,
      richRuleMigration,
      progressionMigration,
      builtBaseMigration,
      builtEvidenceMigration,
      builtLifecycleMigration,
      builtRichRuleMigration,
      builtProgressionMigration,
      progressionSnapshotSource,
      migrationJournalSource,
      schemaSource,
      runtimeSource,
      exclusiveGroupMigration,
      builtExclusiveGroupMigration,
      exclusiveGroupSnapshotSource,
      attestationMigration,
      builtAttestationMigration,
      attestationSnapshotSource,
      weeklyPeriodMigration,
      builtWeeklyPeriodMigration,
      weeklyPeriodSnapshotSource,
      archiveMigration,
      builtArchiveMigration,
      archiveSnapshotSource,
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
          new URL("../drizzle/0004_nervous_mentallo.sql", import.meta.url),
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
        readFile(
          new URL(
            "../dist/.openai/drizzle/0004_nervous_mentallo.sql",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(
          new URL("../drizzle/meta/0004_snapshot.json", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../drizzle/meta/_journal.json", import.meta.url),
          "utf8",
        ),
        readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
        readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
        readFile(
          new URL("../drizzle/0005_smooth_mach_iv.sql", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL(
            "../dist/.openai/drizzle/0005_smooth_mach_iv.sql",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(
          new URL("../drizzle/meta/0005_snapshot.json", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../drizzle/0006_graceful_jackal.sql", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL(
            "../dist/.openai/drizzle/0006_graceful_jackal.sql",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(
          new URL("../drizzle/meta/0006_snapshot.json", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../drizzle/0007_damp_mandroid.sql", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL(
            "../dist/.openai/drizzle/0007_damp_mandroid.sql",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(
          new URL("../drizzle/meta/0007_snapshot.json", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../drizzle/0008_mighty_snowbird.sql", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL(
            "../dist/.openai/drizzle/0008_mighty_snowbird.sql",
            import.meta.url,
          ),
          "utf8",
        ),
        readFile(
          new URL("../drizzle/meta/0008_snapshot.json", import.meta.url),
          "utf8",
        ),
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
    assert.equal(builtProgressionMigration, progressionMigration);
    assert.equal(builtExclusiveGroupMigration, exclusiveGroupMigration);
    assert.equal(builtAttestationMigration, attestationMigration);
    assert.equal(builtWeeklyPeriodMigration, weeklyPeriodMigration);
    assert.equal(builtArchiveMigration, archiveMigration);

    const migration = `${baseMigration}\n${evidenceMigration}\n${lifecycleMigration}\n${richRuleMigration}\n${progressionMigration}\n${exclusiveGroupMigration}\n${attestationMigration}\n${weeklyPeriodMigration}\n${archiveMigration}`;
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
      "weekly_progression_periods",
      "weekly_quest_claims",
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
    assert.match(
      progressionMigration,
      /CREATE TABLE `weekly_quest_claims`[\s\S]*?`user_id` text NOT NULL[\s\S]*?`week_start` text NOT NULL[\s\S]*?`quest_key` text NOT NULL[\s\S]*?`progress_at_claim` integer NOT NULL[\s\S]*?`target` integer NOT NULL[\s\S]*?`xp_reward` integer NOT NULL[\s\S]*?FOREIGN KEY \(`user_id`\) REFERENCES `users`\(`id`\)[\s\S]*?ON DELETE cascade/i,
    );
    assert.match(
      progressionMigration,
      /CREATE UNIQUE INDEX `weekly_quest_claims_user_week_quest_unique`[\s\S]*?`user_id`,`week_start`,`quest_key`/i,
    );
    assert.match(
      progressionMigration,
      /CREATE INDEX `weekly_quest_claims_user_week_idx`[\s\S]*?`user_id`,`week_start`/i,
    );
    const progressionSnapshot = JSON.parse(progressionSnapshotSource);
    const questClaimSnapshot =
      progressionSnapshot.tables.weekly_quest_claims;
    assert.ok(questClaimSnapshot);
    assert.deepEqual(
      Object.keys(questClaimSnapshot.columns),
      [
        "id",
        "user_id",
        "week_start",
        "quest_key",
        "progress_at_claim",
        "target",
        "xp_reward",
        "claimed_at",
      ],
    );
    assert.deepEqual(
      questClaimSnapshot.indexes
        .weekly_quest_claims_user_week_quest_unique,
      {
        name: "weekly_quest_claims_user_week_quest_unique",
        columns: ["user_id", "week_start", "quest_key"],
        isUnique: true,
      },
    );
    const migrationJournal = JSON.parse(migrationJournalSource);
    assert.equal(
      migrationJournal.entries.at(-1)?.tag,
      "0008_mighty_snowbird",
    );
    assert.match(
      weeklyPeriodMigration,
      /CREATE TABLE `weekly_progression_periods`[\s\S]*?`user_id` text NOT NULL[\s\S]*?`week_start` text NOT NULL[\s\S]*?`weekly_goal` integer NOT NULL[\s\S]*?`time_zone` text NOT NULL[\s\S]*?FOREIGN KEY \(`user_id`\) REFERENCES `users`\(`id`\)[\s\S]*?ON DELETE cascade/i,
    );
    assert.match(
      weeklyPeriodMigration,
      /CREATE UNIQUE INDEX `weekly_progression_periods_user_week_unique`[\s\S]*?`user_id`,`week_start`/i,
    );
    const weeklyPeriodSnapshot = JSON.parse(weeklyPeriodSnapshotSource);
    assert.deepEqual(
      weeklyPeriodSnapshot.tables.weekly_progression_periods.indexes
        .weekly_progression_periods_user_week_unique,
      {
        name: "weekly_progression_periods_user_week_unique",
        columns: ["user_id", "week_start"],
        isUnique: true,
      },
    );
    const archiveSnapshot = JSON.parse(archiveSnapshotSource);
    assert.equal(
      archiveSnapshot.tables.activities.columns.revision.default,
      1,
    );
    assert.equal(
      archiveSnapshot.tables.activities.columns.archived_at.name,
      "archived_at",
    );
    assert.equal(
      archiveSnapshot.tables.checklist_tasks.columns.is_personal.default,
      false,
    );
    assert.equal(
      archiveSnapshot.tables.checklist_tasks.columns.revision.default,
      1,
    );
    assert.match(
      exclusiveGroupMigration,
      /ALTER TABLE `credential_requirements` ADD `exclusive_group` text/i,
    );
    assert.match(
      exclusiveGroupMigration,
      /ALTER TABLE `rule_categories` ADD `exclusive_group` text/i,
    );
    const exclusiveGroupSnapshot = JSON.parse(exclusiveGroupSnapshotSource);
    const expectedExclusiveGroupColumn = {
      name: "exclusive_group",
      type: "text",
      primaryKey: false,
      notNull: false,
      autoincrement: false,
    };
    assert.deepEqual(
      exclusiveGroupSnapshot.tables.credential_requirements.columns
        .exclusive_group,
      expectedExclusiveGroupColumn,
    );
    assert.deepEqual(
      exclusiveGroupSnapshot.tables.rule_categories.columns.exclusive_group,
      expectedExclusiveGroupColumn,
    );
    assert.match(attestationMigration, /Compatibility marker only/i);
    assert.match(attestationMigration, /SELECT 1/i);
    assert.doesNotMatch(
      attestationMigration,
      /ALTER TABLE[\s\S]*?(official_record_attested_at|attestation_kind)/i,
    );
    const attestationSnapshot = JSON.parse(attestationSnapshotSource);
    assert.equal(
      attestationSnapshot.tables.renewal_acceptances.columns
        .official_record_attested_at.name,
      "official_record_attested_at",
    );
    assert.equal(
      attestationSnapshot.tables.renewal_submissions.columns.attestation_kind
        .name,
      "attestation_kind",
    );
    assert.match(runtimeSource, /exclusive_group TEXT/i);
    assert.match(schemaSource, /exclusiveGroup:\s*text\("exclusive_group"\)/i);
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
      runtimeSource,
      /CREATE TABLE IF NOT EXISTS weekly_quest_claims[\s\S]*?CREATE UNIQUE INDEX IF NOT EXISTS weekly_quest_claims_user_week_quest_unique[\s\S]*?user_id, week_start, quest_key/i,
    );
    assert.match(
      schemaSource,
      /export const weeklyQuestClaims = sqliteTable\([\s\S]*?"weekly_quest_claims"[\s\S]*?weekly_quest_claims_user_week_quest_unique/i,
    );
    assert.match(
      runtimeSource,
      /CREATE TABLE IF NOT EXISTS weekly_progression_periods[\s\S]*?CREATE UNIQUE INDEX IF NOT EXISTS weekly_progression_periods_user_week_unique[\s\S]*?user_id, week_start/i,
    );
    assert.match(
      schemaSource,
      /export const weeklyProgressionPeriods = sqliteTable\([\s\S]*?"weekly_progression_periods"[\s\S]*?weekly_progression_periods_user_week_unique/i,
    );
    assert.match(
      migration,
      /FOREIGN KEY \(`user_id`\) REFERENCES `users`\(`id`\)[\s\S]*?ON DELETE cascade/i,
    );
  });

  await t.test(
    "migrates revisioned archives and keeps active-record queries coherent",
    async () => {
      const [
        schemaSource,
        runtimeSource,
        migrationSource,
        snapshotSource,
        journalSource,
        workspaceRouteSource,
        exportRouteSource,
        evidenceSharedSource,
        evidenceUploadSource,
        evidenceDeleteSource,
      ] = await Promise.all([
        readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
        readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
        readFile(
          new URL("../drizzle/0008_mighty_snowbird.sql", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../drizzle/meta/0008_snapshot.json", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../drizzle/meta/_journal.json", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../app/api/workspace/route.ts", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../app/api/export/route.ts", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../app/api/evidence/_shared.ts", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../app/api/evidence/route.ts", import.meta.url),
          "utf8",
        ),
        readFile(
          new URL("../app/api/evidence/[id]/route.ts", import.meta.url),
          "utf8",
        ),
      ]);

      const activitySchema = schemaSource.slice(
        schemaSource.indexOf("export const activities"),
        schemaSource.indexOf("export const evidenceFiles"),
      );
      const taskSchema = schemaSource.slice(
        schemaSource.indexOf("export const checklistTasks"),
        schemaSource.indexOf("export const renewalSubmissions"),
      );
      assert.match(
        activitySchema,
        /revision:\s*integer\("revision"\)\.notNull\(\)\.default\(1\)/,
      );
      assert.match(activitySchema, /archivedAt:\s*text\("archived_at"\)/);
      assert.match(
        activitySchema,
        /activities_user_archive_date_idx[\s\S]*?userId[\s\S]*?archivedAt[\s\S]*?completionDate/,
      );
      assert.match(
        taskSchema,
        /isPersonal:\s*integer\("is_personal",\s*\{\s*mode:\s*"boolean"\s*\}\)[\s\S]*?default\(false\)/,
      );
      assert.match(
        taskSchema,
        /revision:\s*integer\("revision"\)\.notNull\(\)\.default\(1\)/,
      );
      assert.match(taskSchema, /archivedAt:\s*text\("archived_at"\)/);
      assert.match(
        taskSchema,
        /checklist_tasks_user_credential_archive_idx[\s\S]*?userId[\s\S]*?credentialId[\s\S]*?archivedAt[\s\S]*?sortOrder/,
      );

      for (const pattern of [
        /ALTER TABLE `activities` ADD `revision` integer DEFAULT 1 NOT NULL/i,
        /ALTER TABLE `activities` ADD `archived_at` text/i,
        /CREATE INDEX `activities_user_archive_date_idx` ON `activities` \(`user_id`,`archived_at`,`completion_date`\)/i,
        /ALTER TABLE `checklist_tasks` ADD `is_personal` integer DEFAULT false NOT NULL/i,
        /ALTER TABLE `checklist_tasks` ADD `revision` integer DEFAULT 1 NOT NULL/i,
        /ALTER TABLE `checklist_tasks` ADD `archived_at` text/i,
        /CREATE INDEX `checklist_tasks_user_credential_archive_idx` ON `checklist_tasks` \(`user_id`,`credential_id`,`archived_at`,`sort_order`\)/i,
      ]) {
        assert.match(migrationSource, pattern);
      }

      const snapshot = JSON.parse(snapshotSource);
      assert.deepEqual(snapshot.tables.activities.columns.revision, {
        name: "revision",
        type: "integer",
        primaryKey: false,
        notNull: true,
        autoincrement: false,
        default: 1,
      });
      assert.equal(
        snapshot.tables.activities.columns.archived_at.name,
        "archived_at",
      );
      assert.deepEqual(
        snapshot.tables.activities.indexes.activities_user_archive_date_idx
          .columns,
        ["user_id", "archived_at", "completion_date"],
      );
      assert.equal(
        snapshot.tables.checklist_tasks.columns.is_personal.default,
        false,
      );
      assert.equal(
        snapshot.tables.checklist_tasks.columns.revision.default,
        1,
      );
      assert.deepEqual(
        snapshot.tables.checklist_tasks.indexes
          .checklist_tasks_user_credential_archive_idx.columns,
        ["user_id", "credential_id", "archived_at", "sort_order"],
      );
      assert.equal(
        JSON.parse(journalSource).entries.at(-1)?.tag,
        "0008_mighty_snowbird",
      );

      assert.match(
        runtimeSource,
        /activities_closed_cycle_core_guard_v2[\s\S]*?BEFORE UPDATE OF title, provider, completion_date, total_units,[\s\S]*?archived_at[\s\S]*?credential\.status = 'renewed'[\s\S]*?activity_cycle_closed/i,
      );
      assert.match(
        runtimeSource,
        /activity_allocations_mutable_guard_v2[\s\S]*?activity\.archived_at IS NULL[\s\S]*?credential\.status IN \('active', 'submitted'\)[\s\S]*?activity_allocation_not_mutable/i,
      );
      assert.match(
        runtimeSource,
        /activity_requirement_matches_mutable_insert_guard_v2[\s\S]*?activity\.archived_at IS NULL[\s\S]*?activity_match_not_mutable/i,
      );
      assert.match(
        runtimeSource,
        /checklist_tasks_closed_cycle_guard_v2[\s\S]*?BEFORE UPDATE OF title, kind, status, due_date, completed_at,[\s\S]*?archived_at[\s\S]*?credential\.status IN \('active', 'submitted'\)[\s\S]*?checklist_cycle_closed/i,
      );

      assert.match(
        workspaceRouteSource,
        /SUM\([\s\S]*?counted_activity\.id IS NULL THEN 0[\s\S]*?MIN\([\s\S]*?alloc\.allocated_units,[\s\S]*?counted_activity\.total_units[\s\S]*?counted_activity\.archived_at IS NULL/i,
      );
      assert.match(
        workspaceRouteSource,
        /AS rawEarned[\s\S]*?LEFT JOIN activities activity[\s\S]*?activity\.archived_at IS NULL/i,
      );
      assert.match(
        workspaceRouteSource,
        /archivedTasksByCredential[\s\S]*?archivedActivities/,
      );
      assert.match(
        workspaceRouteSource,
        /active_activity\.archived_at IS NULL[\s\S]*?required_classification_groups/,
      );
      assert.match(
        exportRouteSource,
        /WHERE a\.user_id = \?[\s\S]*?a\.archived_at IS NULL/,
      );

      assert.match(
        evidenceSharedSource,
        /assertOwnedActivityEvidenceMutable[\s\S]*?activity\.id = \? AND activity\.user_id = \?[\s\S]*?activity\.archivedAt[\s\S]*?usedByClosedCycle/,
      );
      assert.match(
        evidenceUploadSource,
        /INSERT INTO evidence_files[\s\S]*?activity\.archived_at IS NULL[\s\S]*?credential\.status = 'renewed'/,
      );
      assert.match(
        evidenceUploadSource,
        /UPDATE activities[\s\S]*?revision = revision \+ 1[\s\S]*?archived_at IS NULL/,
      );
      assert.match(
        evidenceDeleteSource,
        /assertOwnedActivityEvidenceMutable[\s\S]*?SET status = 'deleting'[\s\S]*?revision = revision \+ 1[\s\S]*?bucket\.delete/,
      );
      assert.match(
        evidenceDeleteSource,
        /findOwnedEvidenceForDeletion[\s\S]*?evidence\.status === "ready"[\s\S]*?evidence_delete_retry/,
      );
    },
  );

  await t.test(
    "enforces archive defaults and closed-cycle mutation guards in SQLite",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new SQLiteD1Database(DatabaseSync);
      const runtimeSource = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const isolatedRuntime = await importTypeScriptModule(
        `${runtimeSource}\nexport const __archiveGuardTestNonce = "archive-guard";`,
      );
      await isolatedRuntime.initializeDatabase(database);
      const raw = database.raw;

      try {
        raw
          .prepare(
            `INSERT INTO users (id, email, display_name, is_demo)
             VALUES (?, ?, ?, 0)`,
          )
          .run(
            "user-archive-guard",
            "archive-guard@example.com",
            "Archive Guard",
          );
        const insertCredential = raw.prepare(
          `INSERT INTO credentials (
             id, user_id, rule_set_id, credential_name, profession,
             jurisdiction, issuer, cycle_start, deadline, total_required,
             unit_label, status
           ) VALUES (?, 'user-archive-guard', NULL, ?, 'Testing', 'Test',
             'Test Board', '2026-01-01', '2026-12-31', 10, 'hours', ?)`,
        );
        insertCredential.run(
          "credential-archive-active",
          "Active archive credential",
          "active",
        );
        insertCredential.run(
          "credential-archive-closed",
          "Closed archive credential",
          "renewed",
        );
        raw
          .prepare(
            `INSERT INTO activities (
               id, user_id, title, provider, completion_date, total_units,
               evidence_status
             ) VALUES (
               'activity-archive-guard',
               'user-archive-guard',
               'Guarded activity',
               'Provider',
               '2026-06-15',
               2,
               'missing'
             )`,
          )
          .run();
        raw
          .prepare(
            `INSERT INTO activity_allocations (
               id, activity_id, credential_id, requirement_id,
               allocated_units
             ) VALUES (
               'allocation-archive-guard',
               'activity-archive-guard',
               'credential-archive-active',
               NULL,
               2
             )`,
          )
          .run();
        raw
          .prepare(
            `INSERT INTO credential_requirements (
               id, credential_id, name, required_units, kind, relation,
               applicability, applicability_status, is_active, sort_order
             ) VALUES (
               'requirement-archive-guard',
               'credential-archive-active',
               'Guarded requirement',
               2,
               'minimum',
               'independent',
               'always',
               'applies',
               1,
               0
             )`,
          )
          .run();
        raw
          .prepare(
            `INSERT INTO activity_requirement_matches (
               id, user_id, allocation_id, requirement_id, matched_units
             ) VALUES (
               'match-archive-guard',
               'user-archive-guard',
               'allocation-archive-guard',
               'requirement-archive-guard',
               2
             )`,
          )
          .run();
        raw
          .prepare(
            `INSERT INTO checklist_tasks (
               id, user_id, credential_id, title, kind, status,
               is_personal
             ) VALUES (
               'task-archive-guard',
               'user-archive-guard',
               'credential-archive-active',
               'Guarded task',
               'personal',
               'pending',
               1
             )`,
          )
          .run();

        assert.deepEqual(
          {
            ...raw
              .prepare(
                `SELECT revision, archived_at AS archivedAt
                 FROM activities
                 WHERE id = 'activity-archive-guard'`,
              )
              .get(),
          },
          { revision: 1, archivedAt: null },
        );
        assert.deepEqual(
          {
            ...raw
              .prepare(
                `SELECT
                   is_personal AS isPersonal,
                   revision,
                   archived_at AS archivedAt
                 FROM checklist_tasks
                 WHERE id = 'task-archive-guard'`,
              )
              .get(),
          },
          { isPersonal: 1, revision: 1, archivedAt: null },
        );

        assert.throws(
          () =>
            raw
              .prepare(
                `INSERT INTO activity_allocations (
                   id, activity_id, credential_id, requirement_id,
                   allocated_units
                 ) VALUES (?, ?, ?, NULL, 1)`,
              )
              .run(
                "allocation-archive-closed",
                "activity-archive-guard",
                "credential-archive-closed",
              ),
          /activity_allocation_not_mutable/i,
        );
        raw
          .prepare(
            `UPDATE credentials
             SET status = 'renewed'
             WHERE id = 'credential-archive-active'`,
          )
          .run();
        assert.throws(
          () =>
            raw
              .prepare(
                `UPDATE activities
                 SET archived_at = CURRENT_TIMESTAMP
                 WHERE id = 'activity-archive-guard'`,
              )
              .run(),
          /activity_cycle_closed/i,
        );
        assert.throws(
          () =>
            raw
              .prepare(
                `UPDATE activity_allocations
                 SET allocated_units = 1
                 WHERE id = 'allocation-archive-guard'`,
              )
              .run(),
          /activity_allocation_not_mutable/i,
        );
        assert.throws(
          () =>
            raw
              .prepare(
                `DELETE FROM activity_requirement_matches
                 WHERE id = 'match-archive-guard'`,
              )
              .run(),
          /activity_match_not_mutable/i,
        );
        assert.throws(
          () =>
            raw
              .prepare(
                `DELETE FROM activity_allocations
                 WHERE id = 'allocation-archive-guard'`,
              )
              .run(),
          /activity_allocation_not_mutable/i,
        );
        assert.throws(
          () =>
            raw
              .prepare(
                `UPDATE checklist_tasks
                 SET title = 'Changed after close'
                 WHERE id = 'task-archive-guard'`,
              )
              .run(),
          /checklist_cycle_closed/i,
        );
        assert.equal(
          raw
            .prepare(
              `SELECT archived_at
               FROM activities
               WHERE id = 'activity-archive-guard'`,
            )
            .get().archived_at,
          null,
        );
        assert.equal(
          raw
            .prepare(
              `SELECT allocated_units
               FROM activity_allocations
               WHERE id = 'allocation-archive-guard'`,
            )
            .get().allocated_units,
          2,
        );
        assert.equal(
          raw
            .prepare(
              `SELECT title
               FROM checklist_tasks
               WHERE id = 'task-archive-guard'`,
            )
            .get().title,
          "Guarded task",
        );
        raw
          .prepare(
            `DELETE FROM credential_requirements
             WHERE id = 'requirement-archive-guard'`,
          )
          .run();
        assert.equal(
          raw
            .prepare(
              `SELECT COUNT(*) AS count
               FROM activity_requirement_matches
               WHERE id = 'match-archive-guard'`,
            )
            .get().count,
          0,
        );
        raw
          .prepare(
            `DELETE FROM activities
             WHERE id = 'activity-archive-guard'`,
          )
          .run();
        assert.equal(
          raw
            .prepare(
              `SELECT COUNT(*) AS count
               FROM activity_allocations
               WHERE id = 'allocation-archive-guard'`,
            )
            .get().count,
          0,
        );

        const repeatRuntime = await importTypeScriptModule(
          `${runtimeSource}\nexport const __archiveGuardTestNonce = "archive-guard-repeat";`,
        );
        await repeatRuntime.initializeDatabase(database);
        assert.equal(
          raw
            .prepare(
              `SELECT COUNT(*) AS count
               FROM pragma_table_info('activities')
               WHERE name IN ('revision', 'archived_at')`,
            )
            .get().count,
          2,
        );
      } finally {
        database.close();
      }
    },
  );

  await t.test(
    "returns concise level, weekly quest, and grace-week progression",
    async () => {
      const userId = await expectedStableUserId("owner@example.com");
      const currentWeekStart = mondayOfWeek(
        new Date().toISOString().slice(0, 10),
      );
      const currentActionDate = shiftIsoDate(currentWeekStart, 2);
      const actions = [
        {
          id: "xp-credential",
          eventType: "credential_created",
          relatedType: "credential",
          relatedId: "credential-one",
          createdAt: `${currentActionDate}T12:00:00.000Z`,
        },
        {
          id: "xp-learning",
          eventType: "activity_logged",
          relatedType: "activity",
          relatedId: "activity-one",
          createdAt: `${currentActionDate}T13:00:00.000Z`,
        },
        {
          id: "xp-task",
          eventType: "task_completed",
          relatedType: "task",
          relatedId: "task-one",
          createdAt: `${currentActionDate}T14:00:00.000Z`,
        },
        {
          id: "xp-task-duplicate",
          eventType: "task_completed",
          relatedType: "task",
          relatedId: "task-one",
          createdAt: `${currentActionDate}T15:00:00.000Z`,
        },
        {
          id: "xp-prior-week",
          eventType: "renewal_submitted",
          relatedType: "submission",
          relatedId: "submission-one",
          createdAt: `${shiftIsoDate(currentWeekStart, -3)}T12:00:00.000Z`,
        },
        {
          id: "xp-two-weeks-prior",
          eventType: "renewal_accepted",
          relatedType: "acceptance",
          relatedId: "acceptance-one",
          createdAt: `${shiftIsoDate(currentWeekStart, -10)}T12:00:00.000Z`,
        },
      ];
      const database = new FakeDatabase({
        resolveFirst(call) {
          if (
            /AS lifetimeXp FROM profiles p WHERE p\.user_id = \?/i.test(
              call.sql,
            )
          ) {
            return { weeklyGoal: 3, lifetimeXp: 480 };
          }
          if (
            /^SELECT time_zone AS timeZone FROM reminder_preferences WHERE user_id = \?/i.test(
              call.sql,
            )
          ) {
            return { timeZone: "UTC" };
          }
          if (
            /SELECT in_app_enabled AS inAppEnabled, lead_days AS leadDays, time_zone AS timeZone FROM reminder_preferences/i.test(
              call.sql,
            )
          ) {
            return {
              inAppEnabled: 0,
              leadDays: "[90,30,7,1]",
              timeZone: "UTC",
            };
          }
          return null;
        },
        resolveAll(call) {
          if (
            /FROM xp_events WHERE user_id = \? AND event_type IN/i.test(
              call.sql,
            )
          ) {
            return actions;
          }
          if (
            /FROM weekly_quest_claims WHERE user_id = \? ORDER BY week_start/i.test(
              call.sql,
            )
          ) {
            return [
              {
                id: "claim-learning",
                weekStart: currentWeekStart,
                questKey: "learning-logged",
                progressAtClaim: 1,
                target: 1,
                xpReward: 40,
                claimedAt: `${currentActionDate}T16:00:00.000Z`,
              },
            ];
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
      assert.equal(
        workspace.user.draftStorageNamespace,
        await expectedDraftStorageNamespace("owner@example.com"),
      );
      assert.match(
        workspace.user.draftStorageNamespace,
        /^draft_[0-9a-f]{64}$/,
      );
      assert.doesNotMatch(
        workspace.user.draftStorageNamespace,
        /owner|example|@/i,
      );
      assert.deepEqual(workspace.profile, {
        xp: 480,
        weekActions: 3,
        weeklyGoal: 3,
        badges: [],
      });
      assert.deepEqual(workspace.progression.level, {
        number: 3,
        title: "Building rhythm",
        floorXp: 400,
        nextLevelXp: 900,
        progressPercent: 16,
      });
      assert.deepEqual(workspace.progression.week, {
        startsOn: currentWeekStart,
        endsOn: shiftIsoDate(currentWeekStart, 6),
        timeZone: "UTC",
      });
      assert.deepEqual(workspace.progression.momentum, {
        activeWeeks: 3,
        activeThisWeek: true,
        status: "active_this_week",
        graceUsed: false,
        graceAvailable: true,
        lastActiveWeekStart: currentWeekStart,
      });
      assert.deepEqual(
        workspace.progression.quests.map((quest) => ({
          key: quest.key,
          target: quest.target,
          progress: quest.progress,
          rewardXp: quest.rewardXp,
          completed: quest.completed,
          claimed: quest.claimed,
          claimable: quest.claimable,
        })),
        [
          {
            key: "compliance-momentum",
            target: 3,
            progress: 3,
            rewardXp: 75,
            completed: true,
            claimed: false,
            claimable: true,
          },
          {
            key: "learning-logged",
            target: 1,
            progress: 1,
            rewardXp: 40,
            completed: true,
            claimed: true,
            claimable: false,
          },
          {
            key: "checklist-progress",
            target: 1,
            progress: 1,
            rewardXp: 30,
            completed: true,
            claimed: false,
            claimable: true,
          },
        ],
        "duplicate XP rows for one task must not farm quest progress",
      );

      const actionLookup = database.calls.find(
        (call) =>
          call.method === "all" &&
          /FROM xp_events WHERE user_id = \? AND event_type IN/i.test(
            call.sql,
          ),
      );
      const claimLookup = database.calls.find(
        (call) =>
          call.method === "all" &&
          /FROM weekly_quest_claims WHERE user_id = \?/i.test(call.sql),
      );
      assert.ok(actionLookup);
      assert.ok(claimLookup);
      assert.equal(actionLookup.bindings[0], userId);
      assert.equal(claimLookup.bindings[0], userId);
    },
  );

  await t.test(
    "freezes the active weekly rhythm and schedules owner-scoped preset changes",
    async () => {
      const currentWeekStart = mondayOfWeek(
        new Date().toISOString().slice(0, 10),
      );
      const frozenPeriod = {
        weekStart: currentWeekStart,
        weeklyGoal: 4,
        timeZone: "UTC",
      };
      const pendingDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (
            /AS lifetimeXp FROM profiles p WHERE p\.user_id = \?/i.test(
              call.sql,
            )
          ) {
            return { weeklyGoal: 5, lifetimeXp: 0 };
          }
          if (
            /FROM weekly_progression_periods WHERE user_id = \? ORDER BY week_start DESC LIMIT 1/i.test(
              call.sql,
            )
          ) {
            return frozenPeriod;
          }
          if (
            /^SELECT time_zone AS timeZone FROM reminder_preferences WHERE user_id = \?/i.test(
              call.sql,
            )
          ) {
            return { timeZone: "Pacific/Kiritimati" };
          }
          if (
            /SELECT in_app_enabled AS inAppEnabled, lead_days AS leadDays, time_zone AS timeZone FROM reminder_preferences/i.test(
              call.sql,
            )
          ) {
            return {
              inAppEnabled: 1,
              leadDays: "[90,30,7,1]",
              timeZone: "Pacific/Kiritimati",
            };
          }
          return null;
        },
      });
      testCloudflareEnv.DB = pendingDatabase;

      const pendingResponse = await fetchWorker(
        "https://license-lantern.example/api/workspace",
        { headers: authHeaders() },
      );
      assert.equal(pendingResponse.status, 200);
      const pendingWorkspace = await pendingResponse.json();
      assert.deepEqual(pendingWorkspace.profile, {
        xp: 0,
        weekActions: 0,
        weeklyGoal: 4,
        nextWeeklyGoal: 5,
        nextWeeklyGoalEffectiveOn: shiftIsoDate(currentWeekStart, 7),
        badges: [],
      });
      assert.equal(pendingWorkspace.progression.week.timeZone, "UTC");
      assert.equal(
        pendingWorkspace.progression.week.startsOn,
        currentWeekStart,
      );
      assert.equal(pendingWorkspace.progression.weeklyGoal, 4);
      assert.equal(pendingWorkspace.progression.nextWeeklyGoal, 5);
      assert.equal(
        pendingWorkspace.progression.nextWeeklyGoalEffectiveOn,
        shiftIsoDate(currentWeekStart, 7),
      );
      assert.equal(
        pendingDatabase.calls.some((statement) =>
          /^INSERT OR IGNORE INTO weekly_progression_periods/i.test(
            statement.sql,
          ),
        ),
        false,
        "a reminder-timezone change must not replace the active weekly snapshot",
      );

      const updateDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (
            /AS lifetimeXp FROM profiles p WHERE p\.user_id = \?/i.test(
              call.sql,
            )
          ) {
            return { weeklyGoal: 4, lifetimeXp: 0 };
          }
          if (
            /FROM weekly_progression_periods WHERE user_id = \? ORDER BY week_start DESC LIMIT 1/i.test(
              call.sql,
            )
          ) {
            return frozenPeriod;
          }
          if (
            /^SELECT time_zone AS timeZone FROM reminder_preferences WHERE user_id = \?/i.test(
              call.sql,
            )
          ) {
            return { timeZone: "UTC" };
          }
          return null;
        },
      });
      testCloudflareEnv.DB = updateDatabase;

      const ownerResponse = await postWorkspace("updateWeeklyGoal", {
        weeklyGoal: 5,
      });
      assert.equal(ownerResponse.status, 200);
      assert.deepEqual(await ownerResponse.json(), {
        ok: true,
        action: "updateWeeklyGoal",
        id: "weekly-goal",
      });
      const colleagueResponse = await postWorkspace(
        "updateWeeklyGoal",
        { weeklyGoal: 3 },
        "colleague@example.com",
      );
      assert.equal(colleagueResponse.status, 200);
      const keepCurrentResponse = await postWorkspace("updateWeeklyGoal", {
        weeklyGoal: 4,
      });
      assert.equal(keepCurrentResponse.status, 200);

      for (const invalidGoal of [0, 2, 6, 8, 1.5, "5", null]) {
        const response = await postWorkspace("updateWeeklyGoal", {
          weeklyGoal: invalidGoal,
        });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, "invalid_weekly_goal");
      }

      const updates = updateDatabase.calls.filter(
        (statement) =>
          /^UPDATE profiles SET weekly_goal = \?, updated_at = CURRENT_TIMESTAMP WHERE user_id = \?$/i.test(
            statement.sql,
          ),
      );
      assert.deepEqual(
        updates.map((statement) => statement.bindings),
        [
          [5, await expectedStableUserId("owner@example.com")],
          [3, await expectedStableUserId("colleague@example.com")],
          [4, await expectedStableUserId("owner@example.com")],
        ],
      );
      assert.equal(
        updateDatabase.calls.some((statement) =>
          /INSERT(?: OR IGNORE)? INTO xp_events/i.test(statement.sql),
        ),
        false,
        "changing a setting must never award XP",
      );
    },
  );

  await t.test(
    "ships an accessible phone-first weekly-rhythm control",
    async () => {
      const [clientSource, stylesSource] = await Promise.all([
        readFile(
          new URL("../app/LicenseLanternApp.tsx", import.meta.url),
          "utf8",
        ),
        readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
      ]);

      assert.match(
        clientSource,
        /window\.scrollTo\(\{\s*top:\s*0,\s*left:\s*0,\s*behavior:\s*"auto"\s*\}\);[\s\S]*?\[view\]/,
      );
      assert.match(
        clientSource,
        /weeklyGoalPresets\s*=\s*\[[\s\S]*?Light[\s\S]*?Steady[\s\S]*?Balanced[\s\S]*?Focused[\s\S]*?Ambitious[\s\S]*?\];/,
      );
      assert.match(clientSource, /<legend>Weekly action target<\/legend>/);
      assert.match(
        clientSource,
        /Changes start next Monday[\s\S]*?Missed\s+days do not break your rhythm/i,
      );
      assert.match(
        clientSource,
        /className="readiness-ring"[\s\S]*?role="progressbar"[\s\S]*?aria-valuenow=\{readiness\}/,
      );
      assert.match(
        stylesSource,
        /\.weekly-goal-option\s*\{[^}]*min-height:\s*48px/,
      );
      assert.match(
        stylesSource,
        /@media \(max-width: 820px\)[\s\S]*?\.progression-card\s*\{[^}]*order:\s*-1/,
      );
      assert.match(
        stylesSource,
        /\.mobile-nav \.nav-button\s*\{[^}]*min-height:\s*48px[^}]*font-size:\s*10px/,
      );
      assert.match(
        stylesSource,
        /\.quest-copy small\s*\{[^}]*color:\s*#5f716a[^}]*font-size:\s*10px/,
      );
      assert.match(
        stylesSource,
        /\.quest-row button\s*\{[^}]*min-height:\s*44px[^}]*font-size:\s*10px/,
      );
      assert.doesNotMatch(
        stylesSource,
        /\.renewal-identity \.text-button\s*\{[^}]*font-size:\s*0/,
      );
    },
  );

  await t.test(
    "guards stale, unknown, and incomplete weekly quest claims",
    async () => {
      const currentWeekStart = mondayOfWeek(
        new Date().toISOString().slice(0, 10),
      );
      const cases = [
        {
          payload: {
            questKey: "learning-logged",
            weekStart: shiftIsoDate(currentWeekStart, -7),
          },
          status: 409,
          code: "quest_week_changed",
        },
        {
          payload: {
            questKey: "not-a-real-quest",
            weekStart: currentWeekStart,
          },
          status: 404,
          code: "quest_not_found",
        },
        {
          payload: {
            questKey: "learning-logged",
            weekStart: currentWeekStart,
          },
          status: 409,
          code: "quest_incomplete",
        },
      ];

      for (const guardCase of cases) {
        const database = new FakeDatabase({
          resolveFirst(call) {
            if (
              /AS lifetimeXp FROM profiles p WHERE p\.user_id = \?/i.test(
                call.sql,
              )
            ) {
              return { weeklyGoal: 4, lifetimeXp: 0 };
            }
            if (
              /^SELECT time_zone AS timeZone FROM reminder_preferences WHERE user_id = \?/i.test(
                call.sql,
              )
            ) {
              return { timeZone: "UTC" };
            }
            if (
              /AS activeCredentials,[\s\S]*?FROM users user WHERE user\.id = \?/i.test(
                call.sql,
              )
            ) {
              return {
                activeCredentials: 1,
                submittedCredentials: 0,
                pendingTasks: 0,
                pendingConditions: 0,
                missingEvidence: 0,
              };
            }
            return null;
          },
        });
        testCloudflareEnv.DB = database;
        const response = await postWorkspace(
          "claimWeeklyQuest",
          guardCase.payload,
        );
        const responseBody = await response.json();
        assert.equal(
          response.status,
          guardCase.status,
          JSON.stringify({ payload: guardCase.payload, responseBody }),
        );
        assert.equal(responseBody.code, guardCase.code);
        assert.equal(
          flattenedStatements(database).some(
            (statement) =>
              /^INSERT OR IGNORE INTO weekly_quest_claims/i.test(
                statement.sql,
              ) ||
              /'weekly_quest_claimed'/i.test(statement.sql),
          ),
          false,
        );
      }
    },
  );

  await t.test(
    "claims weekly quest XP once per owner and resists task-toggle farming",
    async () => {
      const currentWeekStart = mondayOfWeek(
        new Date().toISOString().slice(0, 10),
      );
      const currentActionDate = shiftIsoDate(currentWeekStart, 2);
      const database = new FakeDatabase({
        resolveFirst(call) {
          if (
            /AS lifetimeXp FROM profiles p WHERE p\.user_id = \?/i.test(
              call.sql,
            )
          ) {
            return { weeklyGoal: 4, lifetimeXp: 50 };
          }
          if (
            /^SELECT time_zone AS timeZone FROM reminder_preferences WHERE user_id = \?/i.test(
              call.sql,
            )
          ) {
            return { timeZone: "UTC" };
          }
          if (
            /^SELECT id FROM weekly_quest_claims WHERE user_id = \? AND week_start = \? AND quest_key = \?/i.test(
              call.sql,
            )
          ) {
            const [userId, weekStart, questKey] = call.bindings;
            const insert = flattenedStatements(this).find(
              (statement) =>
                /^INSERT OR IGNORE INTO weekly_quest_claims/i.test(
                  statement.sql,
                ) &&
                statement.bindings[1] === userId &&
                statement.bindings[2] === weekStart &&
                statement.bindings[3] === questKey,
            );
            return insert ? { id: insert.bindings[0] } : null;
          }
          return null;
        },
        resolveAll(call) {
          if (
            /FROM xp_events WHERE user_id = \? AND event_type IN/i.test(
              call.sql,
            )
          ) {
            const userId = call.bindings[0];
            return [
              {
                id: `xp-learning-${userId}`,
                eventType: "activity_logged",
                relatedType: "activity",
                relatedId: `activity-${userId}`,
                createdAt: `${currentActionDate}T12:00:00.000Z`,
              },
            ];
          }
          if (
            /FROM weekly_quest_claims WHERE user_id = \? ORDER BY week_start/i.test(
              call.sql,
            )
          ) {
            const userId = call.bindings[0];
            return flattenedStatements(this)
              .filter(
                (statement) =>
                  /^INSERT OR IGNORE INTO weekly_quest_claims/i.test(
                    statement.sql,
                  ) && statement.bindings[1] === userId,
              )
              .map((statement) => ({
                id: statement.bindings[0],
                weekStart: statement.bindings[2],
                questKey: statement.bindings[3],
                progressAtClaim: statement.bindings[4],
                target: statement.bindings[5],
                xpReward: statement.bindings[6],
                claimedAt: `${currentActionDate}T13:00:00.000Z`,
              }));
          }
          return [];
        },
      });
      testCloudflareEnv.DB = database;

      const firstOwnerResponse = await postWorkspace("claimWeeklyQuest", {
        questKey: "learning-logged",
        weekStart: currentWeekStart,
      });
      const firstOwnerResult = await firstOwnerResponse.json();
      assert.equal(firstOwnerResponse.status, 200);

      const retryOwnerResponse = await postWorkspace("claimWeeklyQuest", {
        questKey: "learning-logged",
        weekStart: currentWeekStart,
      });
      const retryOwnerResult = await retryOwnerResponse.json();
      assert.equal(retryOwnerResponse.status, 200);
      assert.equal(retryOwnerResult.id, firstOwnerResult.id);

      const otherOwnerResponse = await postWorkspace(
        "claimWeeklyQuest",
        {
          questKey: "learning-logged",
          weekStart: currentWeekStart,
        },
        "colleague@example.com",
      );
      const otherOwnerResult = await otherOwnerResponse.json();
      assert.equal(otherOwnerResponse.status, 200);
      assert.notEqual(otherOwnerResult.id, firstOwnerResult.id);

      const claimInserts = flattenedStatements(database).filter((statement) =>
        /^INSERT OR IGNORE INTO weekly_quest_claims/i.test(statement.sql),
      );
      const rewardInserts = flattenedStatements(database).filter(
        (statement) =>
          /^INSERT OR IGNORE INTO xp_events/i.test(statement.sql) &&
          /'weekly_quest_claimed'/i.test(statement.sql),
      );
      assert.equal(claimInserts.length, 2);
      assert.equal(rewardInserts.length, 2);
      assert.deepEqual(
        new Set(claimInserts.map((statement) => statement.bindings[1])),
        new Set([
          await expectedStableUserId("owner@example.com"),
          await expectedStableUserId("colleague@example.com"),
        ]),
      );
      assert.ok(
        rewardInserts.every(
          (statement) =>
            statement.bindings[2].includes(statement.bindings[1]) &&
            statement.bindings[3] === 40,
        ),
      );

      const taskDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (
            /SELECT[\s\S]*?task\.id,[\s\S]*?task\.credential_id AS credentialId,[\s\S]*?task\.revision,[\s\S]*?task\.is_personal AS isPersonal,[\s\S]*?task\.archived_at AS archivedAt,[\s\S]*?credential\.status AS credentialStatus[\s\S]*?FROM checklist_tasks task/i.test(
              call.sql,
            )
          ) {
            const completedUpdates = flattenedStatements(this).filter(
              (statement) =>
                /^UPDATE checklist_tasks SET/i.test(statement.sql),
            ).length;
            return {
              id: call.bindings[0],
              credentialId: "credential-task-stable",
              revision: completedUpdates + 1,
              isPersonal: 0,
              archivedAt: null,
              credentialStatus: "active",
            };
          }
          return null;
        },
      });
      testCloudflareEnv.DB = taskDatabase;
      for (const [index, completed] of [true, false, true].entries()) {
        const response = await postWorkspace("toggleTask", {
          taskId: "task-stable",
          completed,
          expectedRevision: index + 1,
        });
        assert.equal(response.status, 200);
      }
      const taskRewards = flattenedStatements(taskDatabase).filter(
        (statement) =>
          /^INSERT OR IGNORE INTO xp_events/i.test(statement.sql) &&
          /'task_completed'/i.test(statement.sql),
      );
      assert.equal(taskRewards.length, 2);
      assert.equal(taskRewards[0].bindings[2], taskRewards[1].bindings[2]);
      assert.equal(
        taskRewards[0].bindings[2],
        `${await expectedStableUserId("owner@example.com")}:task:task-stable:completed`,
      );
      assert.ok(
        flattenedStatements(taskDatabase)
          .filter((statement) =>
            /^UPDATE checklist_tasks SET/i.test(statement.sql),
          )
          .every((statement) =>
            /credential\.status IN \('active', 'submitted'\)/i.test(
              statement.sql,
            ),
          ),
      );
      assert.ok(
        taskRewards.every((statement) =>
          /credential\.status IN \('active', 'submitted'\)/i.test(
            statement.sql,
          ),
        ),
      );
    },
  );

  await t.test(
    "keeps five physician templates and their rich category graphs coherent",
    async () => {
      const runtimeSource = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const globalSeedSource = runtimeSource.slice(
        runtimeSource.indexOf("const GLOBAL_SEED_STATEMENTS"),
      );
      const richCategorySource = runtimeSource.slice(
        runtimeSource.indexOf("const RICH_RULE_CATEGORY_SEED_BINDINGS"),
        runtimeSource.indexOf("const RICH_RULE_CATEGORY_UPDATE_BINDINGS"),
      );
      const expectedTemplates = [
        {
          id: "ca-physician-md-2026-v1",
          stableKey: "ca-physician-md",
          credentialName: "Physician and Surgeon (MD)",
          jurisdiction: "California",
          issuer: "Medical Board of California",
          totalUnits: 50,
          unitLabel: "approved CME hours",
          cycleMonths: 24,
          categorySignatures: [
            [
              "ca-physician-md-2026-geriatrics",
              10,
              "minimum",
              "independent",
              null,
              "conditional",
            ],
          ],
        },
        {
          id: "tx-physician-2026-v1",
          stableKey: "tx-physician",
          credentialName: "Physician — standard renewal",
          jurisdiction: "Texas",
          issuer: "Texas Medical Board",
          totalUnits: 48,
          unitLabel: "CME credits",
          cycleMonths: 24,
          categorySignatures: [
            [
              "tx-physician-2026-formal",
              24,
              "minimum",
              "overlapping",
              null,
              "always",
            ],
            [
              "tx-physician-2026-ethics",
              2,
              "minimum",
              "nested",
              "tx-physician-2026-formal",
              "always",
            ],
            [
              "tx-physician-2026-pain-opioids",
              2,
              "minimum",
              "nested",
              "tx-physician-2026-formal",
              "conditional",
            ],
            [
              "tx-physician-2026-human-trafficking",
              1,
              "minimum",
              "nested",
              "tx-physician-2026-formal",
              "conditional",
            ],
            [
              "tx-physician-2026-pain-clinic",
              10,
              "minimum",
              "overlapping",
              null,
              "conditional",
            ],
            [
              "tx-physician-2026-forensic-evidence",
              2,
              "minimum",
              "overlapping",
              null,
              "conditional",
            ],
          ],
        },
        {
          id: "fl-medical-doctor-md-2026-v1",
          stableKey: "fl-medical-doctor-md",
          credentialName: "Medical Doctor (MD) — standard renewal",
          jurisdiction: "Florida",
          issuer: "Florida Board of Medicine",
          totalUnits: 40,
          unitLabel: "CME hours",
          cycleMonths: 24,
          categorySignatures: [
            [
              "fl-medical-doctor-md-2026-general",
              38,
              "minimum",
              "independent",
              null,
              "always",
            ],
            [
              "fl-medical-doctor-md-2026-medical-errors",
              2,
              "minimum",
              "independent",
              null,
              "always",
            ],
            [
              "fl-medical-doctor-md-2026-controlled-substances",
              2,
              "minimum",
              "nested",
              "fl-medical-doctor-md-2026-general",
              "conditional",
            ],
            [
              "fl-medical-doctor-md-2026-domestic-violence",
              2,
              "minimum",
              "nested",
              "fl-medical-doctor-md-2026-general",
              "conditional",
            ],
          ],
        },
        {
          id: "nj-physician-2026-v1",
          stableKey: "nj-physician",
          credentialName: "Physician (MD/DO) — standard renewal",
          jurisdiction: "New Jersey",
          issuer: "New Jersey State Board of Medical Examiners",
          totalUnits: 100,
          unitLabel: "CME credits",
          cycleMonths: 24,
          categorySignatures: [
            [
              "nj-physician-2026-category-one",
              40,
              "minimum",
              "overlapping",
              null,
              "always",
            ],
            [
              "nj-physician-2026-end-of-life",
              2,
              "minimum",
              "nested",
              "nj-physician-2026-category-one",
              "always",
            ],
            [
              "nj-physician-2026-opioids",
              1,
              "minimum",
              "nested",
              "nj-physician-2026-category-one",
              "always",
            ],
            [
              "nj-physician-2026-sexual-misconduct",
              2,
              "minimum",
              "nested",
              "nj-physician-2026-category-one",
              "always",
            ],
            [
              "nj-physician-2026-perinatal-bias",
              1,
              "minimum",
              "nested",
              "nj-physician-2026-category-one",
              "conditional",
            ],
            [
              "nj-physician-2026-volunteer-care",
              10,
              "maximum",
              "independent",
              null,
              "optional",
            ],
          ],
        },
        {
          id: "pa-medical-physician-md-2026-v1",
          stableKey: "pa-medical-physician-md",
          credentialName:
            "Medical Physician and Surgeon (MD) — standard renewal",
          jurisdiction: "Pennsylvania",
          issuer: "Pennsylvania State Board of Medicine",
          totalUnits: 100,
          unitLabel: "CME credit hours",
          cycleMonths: 24,
          categorySignatures: [
            [
              "pa-medical-physician-md-2026-category-one",
              20,
              "minimum",
              "overlapping",
              null,
              "always",
            ],
            [
              "pa-medical-physician-md-2026-patient-safety",
              12,
              "minimum",
              "overlapping",
              null,
              "always",
            ],
            [
              "pa-medical-physician-md-2026-child-abuse",
              2,
              "minimum",
              "overlapping",
              null,
              "always",
            ],
            [
              "pa-medical-physician-md-2026-opioid",
              2,
              "minimum",
              "overlapping",
              null,
              "conditional",
            ],
          ],
        },
      ];

      const allCategoryIds = new Set();
      for (const template of expectedTemplates) {
        const rule = sourceLiteralArrayAround(globalSeedSource, template.id);
        assert.deepEqual(
          {
            id: rule[0],
            stableKey: rule[1],
            version: rule[2],
            profession: rule[3],
            credentialName: rule[4],
            jurisdiction: rule[5],
            issuer: rule[6],
            totalUnits: rule[7],
            unitLabel: rule[8],
            cycleMonths: rule[9],
            lastVerifiedAt: rule[13],
            reviewStatus: rule[14],
            isCurrent: rule[15],
          },
          {
            id: template.id,
            stableKey: template.stableKey,
            version: 1,
            profession: "Medicine",
            credentialName: template.credentialName,
            jurisdiction: template.jurisdiction,
            issuer: template.issuer,
            totalUnits: template.totalUnits,
            unitLabel: template.unitLabel,
            cycleMonths: template.cycleMonths,
            lastVerifiedAt: "2026-07-25",
            reviewStatus: "source_linked_check_conditions",
            isCurrent: 1,
          },
        );
        assert.match(rule[10], /^https:\/\//);
        assert.ok(rule[11].length > 40, `${template.id} needs a source note`);

        const categoryRows = template.categorySignatures.map((signature) =>
          sourceLiteralArrayAround(richCategorySource, signature[0]),
        );
        assert.deepEqual(
          categoryRows.map((category) => [
            category[0],
            category[3],
            category[4],
            category[5],
            category[6],
            category[7],
          ]),
          template.categorySignatures,
        );
        const categoryIds = new Set(
          categoryRows.map((category) => category[0]),
        );
        assert.deepEqual(
          categoryRows.map((category) => category[9]),
          categoryRows.map((_, index) => index),
          `${template.id} category sort order must be contiguous`,
        );
        for (const category of categoryRows) {
          assert.equal(category[1], template.id);
          assert.ok(category[2].length > 3);
          assert.ok(category[3] > 0);
          assert.ok(category[3] <= template.totalUnits);
          assert.equal(allCategoryIds.has(category[0]), false);
          allCategoryIds.add(category[0]);
          if (category[5] === "nested") {
            assert.ok(
              category[6] && categoryIds.has(category[6]),
              `${category[0]} must name a parent in ${template.id}`,
            );
          }
          if (category[7] === "conditional") {
            assert.ok(
              category[8]?.length > 30,
              `${category[0]} needs an actionable condition note`,
            );
          }
        }
      }
      assert.equal(allCategoryIds.size, 21);
    },
  );

  await t.test(
    "keeps twelve additional inline official templates bounded and internally coherent",
    async () => {
      const [runtimeSource, workspaceRouteSource] = await Promise.all([
        readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
        readFile(
          new URL("../app/api/workspace/route.ts", import.meta.url),
          "utf8",
        ),
      ]);
      const ruleSource = runtimeSource.slice(
        runtimeSource.indexOf("const CATALOG_2026_RULE_SET_SEED_BINDINGS"),
        runtimeSource.indexOf("const CATALOG_2026_CATEGORY_INSERT_SQL"),
      );
      const globalSeedSource = runtimeSource.slice(
        runtimeSource.indexOf("const GLOBAL_SEED_STATEMENTS"),
        runtimeSource.indexOf("const CATALOG_2026_RULE_SET_INSERT_SQL"),
      );
      const categorySource = runtimeSource.slice(
        runtimeSource.indexOf("const CATALOG_2026_CATEGORY_SEED_BINDINGS"),
        runtimeSource.indexOf("let initializationPromise"),
      );
      const expectedRules = [
        [
          "cisco-ccna-2026-v1",
          "cisco-ccna-ce",
          "Information Technology",
          "Cisco Certified Network Associate (CCNA) — Continuing Education path",
          "Global",
          "Cisco",
          30,
          "CE credits",
          36,
          "verified",
          "www.cisco.com",
        ],
        [
          "arrt-rt-standard-2026-v1",
          "arrt-rt-standard",
          "Radiologic Technology",
          "Registered Technologist (R.T.) — standard non-Sonography CE",
          "United States",
          "American Registry of Radiologic Technologists",
          24,
          "Category A or A+ credits",
          24,
          "source_linked_check_conditions",
          "www.arrt.org",
        ],
        [
          "cfp-professional-pre-2027-v1",
          "cfp-professional-pre-2027",
          "Financial Planning",
          "CFP® Professional — cycle beginning before April 1, 2027",
          "United States",
          "CFP Board",
          30,
          "CE hours",
          24,
          "transition_rule_check_assigned_cycle",
          "www.cfp.net",
        ],
        [
          "tx-real-estate-2026-v1",
          "tx-real-estate-standard-ce",
          "Real Estate",
          "Sales Agent or Broker — standard active CE renewal",
          "Texas",
          "Texas Real Estate Commission",
          18,
          "CE hours",
          24,
          "source_linked_check_conditions",
          "www.trec.texas.gov",
        ],
        [
          "ny-architect-2026-v1",
          "ny-architect",
          "Architecture",
          "Registered Architect — full registration period",
          "New York",
          "New York State Education Department",
          36,
          "contact hours",
          36,
          "source_linked_check_conditions",
          "www.op.nysed.gov",
        ],
        [
          "ptcb-cpht-2026-v1",
          "ptcb-cpht",
          "Pharmacy Technology",
          "Certified Pharmacy Technician (CPhT) — standard renewal",
          "United States",
          "Pharmacy Technician Certification Board",
          20,
          "CE hours",
          24,
          "source_linked_check_conditions",
          "ptcb.zendesk.com",
        ],
        [
          "asha-ccc-2026-v1",
          "asha-ccc",
          "Audiology and Speech-Language Pathology",
          "Certificate of Clinical Competence (CCC-A / CCC-SLP)",
          "United States",
          "American Speech-Language-Hearing Association",
          30,
          "PDHs",
          36,
          "source_linked_check_conditions",
          "www.asha.org",
        ],
        [
          "nasm-cpt-2026-v1",
          "nasm-cpt",
          "Fitness and Personal Training",
          "NASM Certified Personal Trainer (NASM-CPT) — standard recertification",
          "United States",
          "National Academy of Sports Medicine",
          2,
          "NASM CEUs",
          24,
          "source_linked_check_conditions",
          "www.nasm.org",
        ],
        [
          "hrci-phr-2026-v1",
          "hrci-phr",
          "Human Resources",
          "Professional in Human Resources (PHR) — standard full-cycle recertification credit path",
          "United States",
          "HRCI",
          60,
          "recertification credits",
          36,
          "source_linked_check_conditions",
          "www.hrci.org",
        ],
        [
          "hrci-sphr-2026-v1",
          "hrci-sphr",
          "Human Resources",
          "Senior Professional in Human Resources (SPHR) — standard full-cycle recertification credit path",
          "United States",
          "HRCI",
          60,
          "recertification credits",
          36,
          "source_linked_check_conditions",
          "www.hrci.org",
        ],
        [
          "shrm-cp-2026-v1",
          "shrm-cp",
          "Human Resources",
          "SHRM Certified Professional (SHRM-CP) — PDC recertification path",
          "Global",
          "Society for Human Resource Management",
          60,
          "PDCs",
          36,
          "source_linked_check_conditions",
          "www.shrm.org",
        ],
        [
          "shrm-scp-2026-v1",
          "shrm-scp",
          "Human Resources",
          "SHRM Senior Certified Professional (SHRM-SCP) — PDC recertification path",
          "Global",
          "Society for Human Resource Management",
          60,
          "PDCs",
          36,
          "source_linked_check_conditions",
          "www.shrm.org",
        ],
      ];
      const expectedEffectiveDates = new Map([
        ["cisco-ccna-2026-v1", null],
        ["arrt-rt-standard-2026-v1", null],
        ["cfp-professional-pre-2027-v1", null],
        ["tx-real-estate-2026-v1", "2026-01-01"],
        ["ny-architect-2026-v1", null],
        ["ptcb-cpht-2026-v1", "2026-05-01"],
        ["asha-ccc-2026-v1", "2026-01-01"],
        ["nasm-cpt-2026-v1", null],
        ["hrci-phr-2026-v1", "2021-01-01"],
        ["hrci-sphr-2026-v1", "2021-01-01"],
        ["shrm-cp-2026-v1", null],
        ["shrm-scp-2026-v1", null],
      ]);
      assert.equal(
        [...ruleSource.matchAll(/\n  \[\n    "/g)].length,
        13,
        "twelve current rules plus one hidden CFP transition rule are expected",
      );
      assert.equal(
        [...categorySource.matchAll(/\n  \[\n    "/g)].length,
        57,
        "fifty-three current categories plus four hidden CFP transition categories are expected",
      );
      assert.equal(
        [...globalSeedSource.matchAll(/INSERT OR IGNORE INTO rule_sets/g)]
          .length + expectedRules.length,
        35,
      );
      for (const expected of expectedRules) {
        const rule = sourceLiteralArrayAround(ruleSource, expected[0]);
        assert.deepEqual(
          [
            rule[0],
            rule[1],
            rule[3],
            rule[4],
            rule[5],
            rule[6],
            rule[7],
            rule[8],
            rule[9],
            rule[14],
            new URL(rule[10]).hostname,
          ],
          expected,
        );
        assert.equal(rule[2], 1);
        assert.equal(rule[12], expectedEffectiveDates.get(rule[0]));
        assert.equal(rule[13], "2026-07-26");
        assert.equal(rule[15], 1);
        assert.ok(rule[11].length > 150, `${rule[0]} needs a precise caveat`);
        assert.match(
          rule[11],
          /actual|assigned|beginning|exclude|exempt|only|separate|split|carry/i,
        );
      }
      const futureCfp = sourceLiteralArrayAround(
        ruleSource,
        "cfp-professional-2027-v1",
      );
      assert.deepEqual(
        [
          futureCfp[0],
          futureCfp[1],
          futureCfp[7],
          futureCfp[12],
          futureCfp[14],
          futureCfp[15],
        ],
        [
          "cfp-professional-2027-v1",
          "cfp-professional-2027",
          40,
          "2027-04-01",
          "source_linked_check_conditions",
          0,
        ],
      );
      assert.match(
        futureCfp[11],
        /after Q1 2027[\s\S]*?April 1, 2027[\s\S]*?5[\s\S]*?Practice Management[\s\S]*?10 excess general[\s\S]*?Ethics CE cannot carry[\s\S]*?never copies/i,
      );

      const expectedHrciCategories = (level, includeBusiness) => {
        const prefix = `hrci-${level}-2026`;
        const ruleSetId = `${prefix}-v1`;
        return [
          [
            `${prefix}-professional-development`,
            ruleSetId,
            0,
            "informational",
            "independent",
            "optional",
            "HRCI activity type",
          ],
          [
            `${prefix}-confirmed-carryover`,
            ruleSetId,
            15,
            "maximum",
            "independent",
            "conditional",
            "HRCI activity type",
          ],
          [
            `${prefix}-self-directed-learning`,
            ruleSetId,
            30,
            "maximum",
            "independent",
            "optional",
            null,
          ],
          [
            `${prefix}-other-self-directed-learning`,
            ruleSetId,
            0,
            "informational",
            "nested",
            "optional",
            "HRCI activity type",
          ],
          [
            `${prefix}-audited-college-course`,
            ruleSetId,
            10,
            "maximum",
            "nested",
            "optional",
            "HRCI activity type",
          ],
          [
            `${prefix}-professional-achievement`,
            ruleSetId,
            40,
            "maximum",
            "independent",
            "optional",
            null,
          ],
          [
            `${prefix}-other-professional-achievement`,
            ruleSetId,
            0,
            "informational",
            "nested",
            "optional",
            "HRCI activity type",
          ],
          [
            `${prefix}-hr-membership`,
            ruleSetId,
            12,
            "maximum",
            "nested",
            "optional",
            "HRCI activity type",
          ],
          [
            `${prefix}-ethics`,
            ruleSetId,
            1,
            "minimum",
            "overlapping",
            "always",
            null,
          ],
          ...(includeBusiness
            ? [
                [
                  `${prefix}-business-credit`,
                  ruleSetId,
                  15,
                  "minimum",
                  "overlapping",
                  "always",
                  null,
                ],
              ]
            : []),
        ];
      };
      const expectedShrmCategories = (level) => {
        const prefix = `shrm-${level}-2026`;
        const ruleSetId = `${prefix}-v1`;
        return [
          [
            `${prefix}-education`,
            ruleSetId,
            0,
            "informational",
            "independent",
            "optional",
            "SHRM PDC category",
          ],
          [
            `${prefix}-organization`,
            ruleSetId,
            30,
            "maximum",
            "independent",
            "optional",
            "SHRM PDC category",
          ],
          [
            `${prefix}-profession`,
            ruleSetId,
            30,
            "maximum",
            "independent",
            "optional",
            "SHRM PDC category",
          ],
          [
            `${prefix}-confirmed-carryover`,
            ruleSetId,
            20,
            "maximum",
            "nested",
            "conditional",
            "SHRM PDC category",
          ],
        ];
      };
      const expectedCategories = [
        [
          "arrt-rt-standard-2026-applications-training",
          "arrt-rt-standard-2026-v1",
          8,
          "maximum",
          "independent",
          "optional",
          "ARRT capped activity type",
        ],
        [
          "arrt-rt-standard-2026-advanced-life-support",
          "arrt-rt-standard-2026-v1",
          6,
          "maximum",
          "independent",
          "optional",
          "ARRT capped activity type",
        ],
        [
          "arrt-rt-standard-2026-other-eligible-ce",
          "arrt-rt-standard-2026-v1",
          0,
          "informational",
          "independent",
          "optional",
          "ARRT capped activity type",
        ],
        [
          "cfp-professional-pre-2027-general",
          "cfp-professional-pre-2027-v1",
          28,
          "minimum",
          "independent",
          "always",
          "CFP CE type",
        ],
        [
          "cfp-professional-pre-2027-ethics",
          "cfp-professional-pre-2027-v1",
          2,
          "minimum",
          "independent",
          "always",
          "CFP CE type",
        ],
        [
          "tx-real-estate-2026-legal-i",
          "tx-real-estate-2026-v1",
          4,
          "minimum",
          "independent",
          "always",
          "TREC course type",
        ],
        [
          "tx-real-estate-2026-legal-ii",
          "tx-real-estate-2026-v1",
          4,
          "minimum",
          "independent",
          "always",
          "TREC course type",
        ],
        [
          "tx-real-estate-2026-contracts",
          "tx-real-estate-2026-v1",
          3,
          "minimum",
          "independent",
          "always",
          "TREC course type",
        ],
        [
          "tx-real-estate-2026-broker-responsibility",
          "tx-real-estate-2026-v1",
          6,
          "minimum",
          "independent",
          "conditional",
          "TREC course type",
        ],
        [
          "ny-architect-2026-hsw",
          "ny-architect-2026-v1",
          24,
          "minimum",
          "overlapping",
          "always",
          null,
        ],
        [
          "nj-physician-2026-non-volunteer-credit",
          "nj-physician-2026-v1",
          0,
          "informational",
          "independent",
          "optional",
          "New Jersey physician credit source",
        ],
        [
          "ptcb-cpht-2026-technician-specific",
          "ptcb-cpht-2026-v1",
          15,
          "minimum",
          "overlapping",
          "always",
          "PTCB provider audience",
        ],
        [
          "ptcb-cpht-2026-pharmacist-specific",
          "ptcb-cpht-2026-v1",
          5,
          "informational",
          "overlapping",
          "optional",
          "PTCB provider audience",
        ],
        [
          "ptcb-cpht-2026-pharmacy-law",
          "ptcb-cpht-2026-v1",
          1,
          "minimum",
          "overlapping",
          "always",
          null,
        ],
        [
          "ptcb-cpht-2026-patient-safety",
          "ptcb-cpht-2026-v1",
          1,
          "minimum",
          "overlapping",
          "always",
          null,
        ],
        [
          "ptcb-cpht-2026-college-coursework",
          "ptcb-cpht-2026-v1",
          10,
          "maximum",
          "independent",
          "optional",
          "PTCB capped activity type",
        ],
        [
          "ptcb-cpht-2026-bls-cpr-aed",
          "ptcb-cpht-2026-v1",
          2,
          "maximum",
          "independent",
          "optional",
          "PTCB capped activity type",
        ],
        [
          "ptcb-cpht-2026-other-eligible-activity",
          "ptcb-cpht-2026-v1",
          0,
          "informational",
          "independent",
          "optional",
          "PTCB capped activity type",
        ],
        [
          "asha-ccc-2026-ethics",
          "asha-ccc-2026-v1",
          1,
          "minimum",
          "independent",
          "always",
          "ASHA required content allocation",
        ],
        [
          "asha-ccc-2026-content-area-2",
          "asha-ccc-2026-v1",
          2,
          "minimum",
          "independent",
          "always",
          "ASHA required content allocation",
        ],
        [
          "nasm-cpt-2026-non-cpr-recertification",
          "nasm-cpt-2026-v1",
          1.9,
          "maximum",
          "independent",
          "optional",
          null,
        ],
        [
          "nasm-cpt-2026-category-a",
          "nasm-cpt-2026-v1",
          0,
          "informational",
          "nested",
          "optional",
          "NASM CEU activity type",
        ],
        [
          "nasm-cpt-2026-category-b",
          "nasm-cpt-2026-v1",
          0,
          "informational",
          "nested",
          "optional",
          "NASM CEU activity type",
        ],
        [
          "nasm-cpt-2026-category-c",
          "nasm-cpt-2026-v1",
          0,
          "informational",
          "nested",
          "optional",
          "NASM CEU activity type",
        ],
        [
          "nasm-cpt-2026-category-d-cpr-aed",
          "nasm-cpt-2026-v1",
          0.1,
          "maximum",
          "independent",
          "optional",
          "NASM CEU activity type",
        ],
        [
          "nasm-cpt-2026-current-adult-cpr-aed",
          "nasm-cpt-2026-v1",
          0.1,
          "minimum",
          "overlapping",
          "always",
          null,
        ],
        ...expectedHrciCategories("phr", false),
        ...expectedHrciCategories("sphr", true),
        ...expectedShrmCategories("cp"),
        ...expectedShrmCategories("scp"),
      ];
      const categoryRows = expectedCategories.map((expected) =>
        sourceLiteralArrayAround(categorySource, expected[0]),
      );
      assert.deepEqual(
        categoryRows.map((category) => [
          category[0],
          category[1],
          category[3],
          category[4],
          category[5],
          category[7],
          category[9],
        ]),
        expectedCategories,
      );
      assert.equal(new Set(categoryRows.map((category) => category[0])).size, 53);
      const futureCfpCategories = [
        sourceLiteralArrayAround(
          categorySource,
          "cfp-professional-2027-general",
        ),
        sourceLiteralArrayAround(
          categorySource,
          "cfp-professional-2027-principal-topics",
        ),
        sourceLiteralArrayAround(
          categorySource,
          "cfp-professional-2027-practice-management",
        ),
        sourceLiteralArrayAround(
          categorySource,
          "cfp-professional-2027-ethics",
        ),
      ];
      assert.deepEqual(
        futureCfpCategories.map((category) => [
          category[1],
          category[3],
          category[4],
          category[5],
          category[6],
          category[7],
          category[9],
          category[10],
        ]),
        [
          [
            "cfp-professional-2027-v1",
            38,
            "minimum",
            "independent",
            null,
            "always",
            null,
            0,
          ],
          [
            "cfp-professional-2027-v1",
            33,
            "minimum",
            "nested",
            "cfp-professional-2027-general",
            "always",
            "CFP CE activity type",
            1,
          ],
          [
            "cfp-professional-2027-v1",
            5,
            "maximum",
            "nested",
            "cfp-professional-2027-general",
            "optional",
            "CFP CE activity type",
            2,
          ],
          [
            "cfp-professional-2027-v1",
            2,
            "minimum",
            "independent",
            null,
            "always",
            "CFP CE activity type",
            3,
          ],
        ],
      );
      assert.match(
        futureCfpCategories[1][8],
        /33[\s\S]*?five-hour Practice Management cap/i,
      );
      assert.match(
        futureCfpCategories[2][8],
        /No more than 5[\s\S]*?Practice Management[\s\S]*?Tag every/i,
      );
      const expandedCategoryIds = [
        ...categorySource.matchAll(
          /\n  \[\n    "((?:nasm-cpt|hrci-(?:phr|sphr)|shrm-(?:cp|scp))-2026-[^"]+)"/g,
        ),
      ].map((match) => match[1]);
      assert.equal(expandedCategoryIds.length, 33);
      const expandedCategoryRows = expandedCategoryIds.map((id) =>
        sourceLiteralArrayAround(categorySource, id),
      );
      const expandedCategoryCounts = new Map([
        ["nasm-cpt-2026-v1", 6],
        ["hrci-phr-2026-v1", 9],
        ["hrci-sphr-2026-v1", 10],
        ["shrm-cp-2026-v1", 4],
        ["shrm-scp-2026-v1", 4],
      ]);
      const expectedExpandedParents = new Map([
        ...["a", "b", "c"].map((suffix) => [
          `nasm-cpt-2026-category-${suffix}`,
          "nasm-cpt-2026-non-cpr-recertification",
        ]),
        ...["phr", "sphr"].flatMap((level) => {
          const prefix = `hrci-${level}-2026`;
          return [
            [
              `${prefix}-confirmed-carryover`,
              null,
            ],
            [
              `${prefix}-other-self-directed-learning`,
              `${prefix}-self-directed-learning`,
            ],
            [
              `${prefix}-audited-college-course`,
              `${prefix}-professional-development`,
            ],
            [
              `${prefix}-other-professional-achievement`,
              `${prefix}-professional-achievement`,
            ],
            [
              `${prefix}-hr-membership`,
              `${prefix}-professional-achievement`,
            ],
          ];
        }),
        [
          "shrm-cp-2026-confirmed-carryover",
          "shrm-cp-2026-education",
        ],
        [
          "shrm-scp-2026-confirmed-carryover",
          "shrm-scp-2026-education",
        ],
      ]);
      assert.equal(expectedExpandedParents.size, 15);
      for (const [ruleSetId, expectedCount] of expandedCategoryCounts) {
        const rows = expandedCategoryRows.filter(
          (category) => category[1] === ruleSetId,
        );
        const categoryIds = new Set(rows.map((category) => category[0]));
        assert.equal(rows.length, expectedCount);
        assert.deepEqual(
          rows.map((category) => category[10]),
          rows.map((_, index) => index),
          `${ruleSetId} category sort order must be contiguous`,
        );
        assert.ok(rows.every((category) => category[8].length > 40));
        for (const category of rows) {
          assert.equal(
            category[6],
            expectedExpandedParents.get(category[0]) ?? null,
            `${category[0]} must keep its intended parent`,
          );
        }
        assert.ok(
          rows
            .filter((category) => category[5] === "nested")
            .every((category) => categoryIds.has(category[6])),
        );
        for (const category of rows.filter(
          (candidate) => candidate[5] === "nested",
        )) {
          const parent = rows.find(
            (candidate) => candidate[0] === category[6],
          );
          assert.ok(parent, `${category[0]} needs a parent in ${ruleSetId}`);
          assert.ok(
            parent[10] < category[10],
            `${category[0]} must sort after its parent`,
          );
        }
        assert.ok(
          rows.some(
            (category) =>
              category[4] === "informational" && category[9],
          ),
        );
        assert.ok(
          rows.some(
            (category) => category[4] === "maximum",
          ),
        );
      }
      assert.deepEqual(
        sourceLiteralArrayAround(
          categorySource,
          "nasm-cpt-2026-current-adult-cpr-aed",
        ).slice(3, 6),
        [0.1, "minimum", "overlapping"],
      );
      assert.deepEqual(
        sourceLiteralArrayAround(
          categorySource,
          "nasm-cpt-2026-non-cpr-recertification",
        ).slice(3, 6),
        [1.9, "maximum", "independent"],
      );
      for (const suffix of ["a", "b", "c"]) {
        const category = sourceLiteralArrayAround(
          categorySource,
          `nasm-cpt-2026-category-${suffix}`,
        );
        assert.deepEqual(category.slice(3, 7), [
          0,
          "informational",
          "nested",
          "nasm-cpt-2026-non-cpr-recertification",
        ]);
        assert.match(
          category[8],
          /1\.9 CEU maximum[\s\S]*?shared 1\.9 Non-CPR aggregate/i,
        );
      }
      assert.equal(
        sourceLiteralArrayAround(
          categorySource,
          "hrci-sphr-2026-business-credit",
        )[3],
        15,
      );
      assert.equal(
        sourceLiteralArrayAround(
          categorySource,
          "hrci-phr-2026-ethics",
        )[3],
        1,
      );
      for (const prefix of ["hrci-phr", "hrci-sphr"]) {
        assert.equal(
          sourceLiteralArrayAround(
            categorySource,
            `${prefix}-2026-audited-college-course`,
          )[6],
          `${prefix}-2026-professional-development`,
        );
      }
      for (const prefix of ["shrm-cp", "shrm-scp"]) {
        assert.equal(
          sourceLiteralArrayAround(
            categorySource,
            `${prefix}-2026-organization`,
          )[3],
          30,
        );
        assert.equal(
          sourceLiteralArrayAround(
            categorySource,
            `${prefix}-2026-confirmed-carryover`,
          )[3],
          20,
        );
      }
      const nasmRuleNote = sourceLiteralArrayAround(
        ruleSource,
        "nasm-cpt-2026-v1",
      )[11];
      assert.match(
        nasmRuleNote,
        /expiration date printed[\s\S]*?0\.1 CEU[\s\S]*?do not carry[\s\S]*?reuse the same course/i,
      );
      assert.match(
        nasmRuleNote,
        /ASTI online[\s\S]*?confirm acceptance[\s\S]*?third-party online-only/i,
      );
      for (const ruleSetId of [
        "hrci-phr-2026-v1",
        "hrci-sphr-2026-v1",
      ]) {
        const ruleNote = sourceLiteralArrayAround(
          ruleSource,
          ruleSetId,
        )[11];
        assert.match(
          ruleNote,
          /standard full-cycle[\s\S]*?HR-related credits[\s\S]*?exam content outline[\s\S]*?portal control[\s\S]*?retaking the exam/i,
        );
        assert.match(
          ruleNote,
          /30 credits[\s\S]*?10[\s\S]*?40 credits[\s\S]*?12/i,
        );
        assert.match(
          ruleNote,
          /HRCI posts[\s\S]*?15 surplus/i,
        );
        const carryover = sourceLiteralArrayAround(
          categorySource,
          ruleSetId.replace("-v1", "-confirmed-carryover"),
        );
        assert.deepEqual(carryover.slice(5, 7), ["independent", null]);
        assert.match(
          sourceLiteralArrayAround(
            categorySource,
            ruleSetId.replace("-v1", "-hr-membership"),
          )[8],
          /six months[\s\S]*?two credits[\s\S]*?12 per cycle/i,
        );
      }
      assert.match(
        sourceLiteralArrayAround(ruleSource, "hrci-sphr-2026-v1")[11],
        /15 Business credits/i,
      );
      for (const ruleSetId of [
        "shrm-cp-2026-v1",
        "shrm-scp-2026-v1",
      ]) {
        assert.match(
          sourceLiteralArrayAround(ruleSource, ruleSetId)[11],
          /30[\s\S]*?Organization[\s\S]*?30[\s\S]*?Profession[\s\S]*?no general ethics[\s\S]*?portal-confirmed carryover[\s\S]*?20/i,
        );
        assert.match(
          sourceLiteralArrayAround(ruleSource, ruleSetId)[11],
          /conflict[\s\S]*?10[\s\S]*?membership[\s\S]*?3[\s\S]*?all excess[\s\S]*?Education[\s\S]*?does not auto-award/i,
        );
      }
      for (const categoryId of [
        "hrci-phr-2026-confirmed-carryover",
        "hrci-sphr-2026-confirmed-carryover",
        "shrm-cp-2026-confirmed-carryover",
        "shrm-scp-2026-confirmed-carryover",
      ]) {
        const category = sourceLiteralArrayAround(
          categorySource,
          categoryId,
        );
        assert.equal(category[7], "conditional");
        assert.match(category[8], /Record only[\s\S]*?posts/i);
      }
      for (const rule of expectedRules.slice(0, 7)) {
        const rows = categoryRows.filter((category) => category[1] === rule[0]);
        assert.deepEqual(
          rows.map((category) => category[10]),
          rows.map((_, index) => index),
          `${rule[0]} category sort order must be contiguous`,
        );
        assert.ok(rows.every((category) => category[6] === null));
        assert.ok(rows.every((category) => category[8].length > 40));
      }
      assert.doesNotMatch(categorySource, /elective minimum/i);
      assert.match(
        sourceLiteralArrayAround(ruleSource, "cfp-professional-pre-2027-v1")[11],
        /before April 1, 2027[\s\S]*?after Q1 2027[\s\S]*?10 hours[\s\S]*?Ethics CE never carries/i,
      );
      assert.match(
        sourceLiteralArrayAround(categorySource, "ptcb-cpht-2026-bls-cpr-aed")[8],
        /cannot satisfy Patient Safety/i,
      );
      assert.match(
        sourceLiteralArrayAround(ruleSource, "asha-ccc-2026-v1")[11],
        /Split a dual-topic course[\s\S]*?same time block cannot satisfy both/i,
      );
      const activeSnapshotRefreshSource = runtimeSource.slice(
        runtimeSource.indexOf(
          "const MAXIMUM_CLASSIFICATION_RULE_SET_IDS",
        ),
        runtimeSource.indexOf("const CFP_TRANSITION_RULE_SET_REFRESH_SQL"),
      );
      assert.match(
        activeSnapshotRefreshSource,
        /MAXIMUM_CLASSIFICATION_RULE_SET_IDS[\s\S]*?"cfp-professional-2027-v1"[\s\S]*?"nasm-cpt-2026-v1"[\s\S]*?"hrci-phr-2026-v1"[\s\S]*?"hrci-sphr-2026-v1"[\s\S]*?"shrm-cp-2026-v1"[\s\S]*?"shrm-scp-2026-v1"/,
      );
      assert.match(
        activeSnapshotRefreshSource,
        /BACKFILL_MAXIMUM_CLASSIFICATION_REQUIREMENTS_SQL[\s\S]*?credential\.status = 'active'/,
      );
      assert.match(
        activeSnapshotRefreshSource,
        /SYNC_MAXIMUM_CLASSIFICATION_REQUIREMENTS_SQL[\s\S]*?credential\.status = 'active'[\s\S]*?AND EXISTS \([\s\S]*?credential_requirements\.kind IS NOT category\.kind/,
      );
      assert.doesNotMatch(
        activeSnapshotRefreshSource,
        /(?:credential\.)?status (?:!= 'renewed'|IN \('active', 'submitted'\))/,
      );
      assert.match(
        workspaceRouteSource,
        /CARRYOVER_REVIEW_TASK_TITLES[\s\S]*?hrci-phr-2026-v1[\s\S]*?posted General HR credits[\s\S]*?hrci-sphr-2026-v1[\s\S]*?posted General HR credits/i,
      );
      assert.match(
        workspaceRouteSource,
        /CARRYOVER_REVIEW_TASK_TITLES[\s\S]*?shrm-cp-2026-v1[\s\S]*?Advance Your Education PDCs[\s\S]*?shrm-scp-2026-v1[\s\S]*?Advance Your Education PDCs/i,
      );
    },
  );

  await t.test(
    "seeds current cyber and insurance templates with bounded rule graphs",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new SQLiteD1Database(DatabaseSync);
      const [runtimeSource, workspaceRouteSource, clientSource] =
        await Promise.all([
          readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
          readFile(
            new URL("../app/api/workspace/route.ts", import.meta.url),
            "utf8",
          ),
          readFile(
            new URL("../app/LicenseLanternApp.tsx", import.meta.url),
            "utf8",
          ),
        ]);
      const runtimeModule = await importTypeScriptModule(
        `${runtimeSource}\nexport const __expandedCatalogTestNonce = "expanded";`,
      );
      await runtimeModule.initializeDatabase(database);
      const raw = database.raw;
      const rows = (sql) =>
        raw
          .prepare(sql)
          .all()
          .map((row) => ({ ...row }));

      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 COUNT(*) AS totalRules,
                 SUM(CASE WHEN is_current = 1 THEN 1 ELSE 0 END) AS currentRules
               FROM rule_sets`,
            )
            .get(),
        },
        { totalRules: 105, currentRules: 104 },
      );
      assert.equal(
        raw
          .prepare(
            `SELECT is_current AS isCurrent
             FROM rule_sets
             WHERE id = 'cfp-professional-2027-v1'`,
          )
          .get().isCurrent,
        0,
      );

      assert.deepEqual(
        rows(
          `SELECT id, total_units AS totalUnits
           FROM rule_sets
           WHERE id LIKE 'isc2-%'
           ORDER BY id`,
        ),
        [
          { id: "isc2-cc-2026-v1", totalUnits: 45 },
          { id: "isc2-ccsp-2026-v1", totalUnits: 90 },
          { id: "isc2-cgrc-2026-v1", totalUnits: 60 },
          { id: "isc2-cissp-2026-v1", totalUnits: 120 },
          { id: "isc2-csslp-2026-v1", totalUnits: 90 },
          { id: "isc2-sscp-2026-v1", totalUnits: 60 },
        ],
      );
      assert.deepEqual(
        rows(
          `SELECT rule_set_id AS ruleSetId, required_units AS requiredUnits
           FROM rule_categories
           WHERE rule_set_id LIKE 'isc2-%' AND kind = 'maximum'
           ORDER BY rule_set_id`,
        ),
        [
          { ruleSetId: "isc2-ccsp-2026-v1", requiredUnits: 30 },
          { ruleSetId: "isc2-cgrc-2026-v1", requiredUnits: 15 },
          { ruleSetId: "isc2-cissp-2026-v1", requiredUnits: 30 },
          { ruleSetId: "isc2-csslp-2026-v1", requiredUnits: 30 },
          { ruleSetId: "isc2-sscp-2026-v1", requiredUnits: 15 },
        ],
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 required_units AS requiredUnits,
                 kind,
                 exclusive_group AS exclusiveGroup
               FROM rule_categories
               WHERE id = 'isc2-cc-2026-group-a'`,
            )
            .get(),
        },
        {
          requiredUnits: 45,
          kind: "minimum",
          exclusiveGroup: null,
        },
      );

      assert.deepEqual(
        rows(
          `SELECT total_units AS totalUnits, COUNT(*) AS count
           FROM rule_sets
           WHERE id LIKE 'comptia-%'
           GROUP BY total_units
           ORDER BY total_units`,
        ),
        [
          { totalUnits: 15, count: 2 },
          { totalUnits: 20, count: 2 },
          { totalUnits: 30, count: 4 },
          { totalUnits: 50, count: 3 },
          { totalUnits: 60, count: 2 },
          { totalUnits: 75, count: 3 },
        ],
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 COUNT(*) AS categoryCount,
                 COUNT(DISTINCT rule_set_id) AS ruleCount,
                 MIN(per_rule_count) AS minimumPerRule,
                 MAX(per_rule_count) AS maximumPerRule
               FROM (
                 SELECT
                   rule_set_id,
                   COUNT(*) AS per_rule_count
                 FROM rule_categories
                 WHERE rule_set_id LIKE 'comptia-%'
                 GROUP BY rule_set_id
               )`,
            )
            .get(),
        },
        {
          categoryCount: 16,
          ruleCount: 16,
          minimumPerRule: 9,
          maximumPerRule: 9,
        },
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM rule_categories
             WHERE rule_set_id LIKE 'comptia-%'`,
          )
          .get().count,
        144,
      );
      assert.deepEqual(
        rows(
          `SELECT rule_set_id AS ruleSetId
           FROM rule_categories
           WHERE id LIKE 'comptia-%-work-experience'
             AND applicability = 'conditional'
           ORDER BY rule_set_id`,
        ),
        [
          { ruleSetId: "comptia-cloudnetx-2026-v1" },
          { ruleSetId: "comptia-dataai-2026-v1" },
          { ruleSetId: "comptia-datasys-plus-2026-v1" },
        ],
      );
      assert.deepEqual(
        rows(
          `SELECT name, required_units AS requiredUnits, kind
           FROM rule_categories
           WHERE rule_set_id = 'comptia-security-plus-2026-v1'
           ORDER BY sort_order`,
        ),
        [
          {
            name: "Other Eligible Training, Higher Education, ACE, SME, or Officially Mapped Certification Activity",
            requiredUnits: 0,
            kind: "informational",
          },
          { name: "Live Webinar", requiredUnits: 10, kind: "maximum" },
          { name: "Conference Session", requiredUnits: 10, kind: "maximum" },
          {
            name: "Related Work Experience",
            requiredUnits: 9,
            kind: "maximum",
          },
          {
            name: "Teaching or Mentoring",
            requiredUnits: 20,
            kind: "maximum",
          },
          {
            name: "Create Instructional Materials",
            requiredUnits: 20,
            kind: "maximum",
          },
          {
            name: "Published Article or White Paper",
            requiredUnits: 16,
            kind: "maximum",
          },
          {
            name: "Published Blog Post",
            requiredUnits: 16,
            kind: "maximum",
          },
          { name: "Published Book", requiredUnits: 40, kind: "maximum" },
        ],
      );

      assert.deepEqual(
        rows(
          `SELECT jurisdiction, COUNT(*) AS count
           FROM rule_sets
           WHERE profession = 'Insurance'
           GROUP BY jurisdiction
           ORDER BY jurisdiction`,
        ),
        [
          { jurisdiction: "California", count: 1 },
          { jurisdiction: "Florida", count: 12 },
          { jurisdiction: "New Jersey", count: 1 },
          { jurisdiction: "New York", count: 2 },
          { jurisdiction: "Texas", count: 1 },
        ],
      );
      assert.deepEqual(
        rows(
          `SELECT total_units AS totalUnits, COUNT(*) AS count
           FROM rule_sets
           WHERE profession = 'Insurance'
           GROUP BY total_units
           ORDER BY total_units`,
        ),
        [
          { totalUnits: 10, count: 4 },
          { totalUnits: 15, count: 2 },
          { totalUnits: 20, count: 4 },
          { totalUnits: 24, count: 7 },
        ],
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM rule_categories
             WHERE rule_set_id IN (
               SELECT id FROM rule_sets WHERE profession = 'Insurance'
             )`,
          )
          .get().count,
        26,
      );
      assert.deepEqual(
        rows(
          `SELECT id, parent_category_id AS parentCategoryId
           FROM rule_categories
           WHERE rule_set_id IN (
             SELECT id FROM rule_sets WHERE profession = 'Insurance'
           )
             AND relation = 'nested'
           ORDER BY id`,
        ),
        [
          {
            id: "ca-insurance-producer-major-lines-2026-fraud",
            parentCategoryId:
              "ca-insurance-producer-major-lines-2026-ethics",
          },
          {
            id: "nj-insurance-producer-major-lines-2026-fraud-option",
            parentCategoryId:
              "nj-insurance-producer-major-lines-2026-ethics",
          },
        ],
      );
      assert.deepEqual(
        rows(
          `SELECT id
           FROM rule_categories
           WHERE rule_set_id IN (
             SELECT id FROM rule_sets WHERE profession = 'Insurance'
           )
             AND applicability = 'conditional'`,
        ),
        [
          {
            id: "ny-insurance-producer-property-casualty-2026-enhanced-nfip",
          },
        ],
      );

      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM rule_sets
             WHERE (
               id LIKE 'isc2-%'
               OR id LIKE 'comptia-%'
               OR profession = 'Insurance'
             )
               AND last_verified_at = '2026-07-26'
               AND review_status = 'source_linked_check_conditions'
               AND is_current = 1`,
          )
          .get().count,
        39,
      );
      assert.match(
        workspaceRouteSource,
        /ISC2_AUTOMATIC_RENEWAL_RULE_SET_PREFIX[\s\S]*?isIsc2AutomaticRenewalRuleSet[\s\S]*?startsWith\(ISC2_AUTOMATIC_RENEWAL_RULE_SET_PREFIX\)[\s\S]*?renewalTaskSpecs[\s\S]*?Submit required ISC2 CPEs and keep annual maintenance fees current[\s\S]*?Save an attested ISC2 requirements checkpoint/,
      );
      assert.match(
        clientSource,
        /isIsc2AutomaticRenewalCredential[\s\S]*?Save dashboard checkpoint[\s\S]*?Save an ISC2 dashboard checkpoint[\s\S]*?I checked the ISC2 Dashboard[\s\S]*?It shows this cycle’s required CPEs and annual maintenance[\s\S]*?fees as satisfied[\s\S]*?Close this cycle only after the dashboard displays renewed certification dates[\s\S]*?Awaiting ISC2 renewal/,
      );
      assert.match(
        workspaceRouteSource,
        /COMPLIANCE_PERIOD_RULE_SET_PREFIXES[\s\S]*?fl-insurance-producer-[\s\S]*?Verify official compliance status and save portal proof[\s\S]*?compliance_checkpoint_recorded[\s\S]*?compliance_checkpoint/,
      );
      assert.match(
        clientSource,
        /isCompliancePeriodCredential[\s\S]*?Active compliance period[\s\S]*?Record compliance[\s\S]*?Start next period/,
      );
      database.close();
    },
  );

  await t.test(
    "refreshes managed catalog corrections, freezes submitted snapshots, and retires removed entries idempotently",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new SQLiteD1Database(DatabaseSync);
      const runtimeSource = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const bootstrapRuntime = await importTypeScriptModule(
        `${runtimeSource}\nexport const __managedCatalogTestNonce = "bootstrap";`,
      );
      await bootstrapRuntime.initializeDatabase(database);

      const raw = database.raw;
      const dataSysRuleSetId = "comptia-datasys-plus-2026-v1";
      const dataSysWorkCategoryId =
        "comptia-datasys-plus-2026-work-experience";
      const staleRuleSetId = "comptia-retired-regression-2026-v1";
      const staleCategoryId =
        "comptia-retired-regression-2026-work-experience";

      raw
        .prepare(
          `INSERT INTO users (id, email, display_name, is_demo)
           VALUES (?, ?, ?, 0)`,
        )
        .run(
          "user-managed-catalog",
          "managed-catalog@example.com",
          "Managed Catalog Test",
        );
      raw
        .prepare(
          `UPDATE rule_sets
           SET
             total_units = 999,
             unit_label = 'raw hours',
             source_title = 'Stale CompTIA rule copy',
             is_current = 0
           WHERE id = ?`,
        )
        .run(dataSysRuleSetId);
      raw
        .prepare(
          `UPDATE rule_categories
           SET
             applicability = 'optional',
             condition_note = 'Legacy optional work-experience copy.'
           WHERE id = ?`,
        )
        .run(dataSysWorkCategoryId);

      const insertCredential = raw.prepare(
        `INSERT INTO credentials (
           id, user_id, rule_set_id, credential_name, profession,
           jurisdiction, issuer, cycle_start, deadline, total_required,
           unit_label, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertCredential.run(
        "credential-datasys-active",
        "user-managed-catalog",
        dataSysRuleSetId,
        "CompTIA DataSys+ ce — standard renewal",
        "Information Technology",
        "Global",
        "CompTIA",
        "2026-01-01",
        "2028-12-31",
        30,
        "CompTIA-accepted CEUs",
        "active",
      );
      insertCredential.run(
        "credential-datasys-submitted",
        "user-managed-catalog",
        dataSysRuleSetId,
        "CompTIA DataSys+ ce — standard renewal",
        "Information Technology",
        "Global",
        "CompTIA",
        "2026-01-01",
        "2028-12-31",
        30,
        "CompTIA-accepted CEUs",
        "submitted",
      );

      const insertRequirement = raw.prepare(
        `INSERT INTO credential_requirements (
           id, credential_id, rule_category_id, name, required_units, kind,
           relation, parent_requirement_id, applicability,
           applicability_status, condition_note, exclusive_group, is_active,
           sort_order
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertRequirement.run(
        "requirement-datasys-active-work",
        "credential-datasys-active",
        dataSysWorkCategoryId,
        "Related Work Experience",
        9,
        "maximum",
        "independent",
        null,
        "optional",
        "applies",
        "Legacy optional work-experience copy.",
        "CompTIA activity type",
        1,
        3,
      );
      insertRequirement.run(
        "requirement-datasys-submitted-work",
        "credential-datasys-submitted",
        dataSysWorkCategoryId,
        "Related Work Experience",
        9,
        "maximum",
        "independent",
        null,
        "optional",
        "applies",
        "Legacy optional work-experience copy.",
        "CompTIA activity type",
        1,
        3,
      );

      raw
        .prepare(
          `INSERT INTO rule_sets (
             id, stable_key, version, profession, credential_name,
             jurisdiction, issuer, total_units, unit_label, cycle_months,
             source_url, source_title, effective_date, last_verified_at,
             review_status, is_current
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          staleRuleSetId,
          "comptia-retired-regression-ce",
          1,
          "Information Technology",
          "Retired CompTIA regression credential",
          "Global",
          "CompTIA",
          9,
          "CEUs",
          36,
          "https://example.invalid/retired-comptia",
          "Stale managed rule that no longer exists in the catalog.",
          null,
          "2025-01-01",
          "source_linked_check_conditions",
          1,
        );
      raw
        .prepare(
          `INSERT INTO rule_categories (
             id, rule_set_id, name, required_units, kind, relation,
             parent_category_id, applicability, condition_note,
             exclusive_group, sort_order
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          staleCategoryId,
          staleRuleSetId,
          "Retired Related Work Experience",
          9,
          "maximum",
          "independent",
          null,
          "optional",
          "Stale category that must be retired.",
          "CompTIA activity type",
          0,
        );
      insertCredential.run(
        "credential-retired-comptia-active",
        "user-managed-catalog",
        staleRuleSetId,
        "Retired CompTIA regression credential",
        "Information Technology",
        "Global",
        "CompTIA",
        "2026-01-01",
        "2028-12-31",
        9,
        "CEUs",
        "active",
      );
      insertRequirement.run(
        "requirement-retired-comptia-active",
        "credential-retired-comptia-active",
        staleCategoryId,
        "Retired Related Work Experience",
        9,
        "maximum",
        "independent",
        null,
        "optional",
        "applies",
        "Stale category that must be retired.",
        "CompTIA activity type",
        1,
        0,
      );

      const migrationRuntime = await importTypeScriptModule(
        `${runtimeSource}\nexport const __managedCatalogTestNonce = "migration";`,
      );
      await migrationRuntime.initializeDatabase(database);

      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 total_units AS totalUnits,
                 unit_label AS unitLabel,
                 is_current AS isCurrent
               FROM rule_sets
               WHERE id = ?`,
            )
            .get(dataSysRuleSetId),
        },
        {
          totalUnits: 30,
          unitLabel: "CompTIA-accepted CEUs",
          isCurrent: 1,
        },
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT applicability, condition_note AS conditionNote
               FROM rule_categories
               WHERE id = ?`,
            )
            .get(dataSysWorkCategoryId),
        },
        {
          applicability: "conditional",
          conditionNote:
            "CompTIA's general Help guidance describes three work-experience CEUs per cycle year, up to nine, but its detailed work-experience table omits this certification. Leave Work Experience uncounted unless CompTIA or the holder's portal confirms that it applies.",
        },
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 applicability,
                 applicability_status AS applicabilityStatus,
                 is_active AS isActive
               FROM credential_requirements
               WHERE id = 'requirement-datasys-active-work'`,
            )
            .get(),
        },
        {
          applicability: "conditional",
          applicabilityStatus: "needs_confirmation",
          isActive: 0,
        },
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 applicability,
                 applicability_status AS applicabilityStatus,
                 is_active AS isActive,
                 condition_note AS conditionNote
               FROM credential_requirements
               WHERE id = 'requirement-datasys-submitted-work'`,
            )
            .get(),
        },
        {
          applicability: "optional",
          applicabilityStatus: "applies",
          isActive: 1,
          conditionNote: "Legacy optional work-experience copy.",
        },
      );
      assert.equal(
        raw
          .prepare(
            `SELECT is_current AS isCurrent
             FROM rule_sets
             WHERE id = ?`,
          )
          .get(staleRuleSetId).isCurrent,
        0,
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM rule_categories
             WHERE id = ?`,
          )
          .get(staleCategoryId).count,
        0,
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 rule_category_id AS ruleCategoryId,
                 is_active AS isActive
               FROM credential_requirements
               WHERE id = 'requirement-retired-comptia-active'`,
            )
            .get(),
        },
        {
          ruleCategoryId: null,
          isActive: 0,
        },
      );

      const catalogState = () => ({
        rules: raw
          .prepare(
            `SELECT
               id, total_units, unit_label, source_title, is_current
             FROM rule_sets
             WHERE id IN (?, ?)
             ORDER BY id`,
          )
          .all(dataSysRuleSetId, staleRuleSetId),
        categories: raw
          .prepare(
            `SELECT *
             FROM rule_categories
             WHERE id IN (?, ?)
             ORDER BY id`,
          )
          .all(dataSysWorkCategoryId, staleCategoryId),
        requirements: raw
          .prepare(
            `SELECT *
             FROM credential_requirements
             WHERE credential_id IN (
               'credential-datasys-active',
               'credential-datasys-submitted',
               'credential-retired-comptia-active'
             )
             ORDER BY credential_id, sort_order, id`,
          )
          .all(),
      });
      const stableState = JSON.stringify(catalogState());
      const repeatRuntime = await importTypeScriptModule(
        `${runtimeSource}\nexport const __managedCatalogTestNonce = "repeat";`,
      );
      await repeatRuntime.initializeDatabase(database);
      assert.equal(JSON.stringify(catalogState()), stableState);

      raw
        .prepare(
          `UPDATE credential_requirements
           SET applicability_status = 'not_applicable', is_active = 0
           WHERE id = 'requirement-datasys-active-work'`,
        )
        .run();
      await assert.rejects(
        database.batch([
          database
            .prepare(
              `INSERT INTO activities (
                 id, user_id, title, provider, completion_date, total_units,
                 evidence_status
               ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              "activity-stale-requirement-race",
              "user-managed-catalog",
              "Stale requirement race",
              "Test Provider",
              "2027-06-01",
              1,
              "missing",
            ),
          database
            .prepare(
              `INSERT INTO activity_allocations (
                 id, activity_id, credential_id, requirement_id,
                 allocated_units
               ) VALUES (?, ?, ?, ?, ?)`,
            )
            .bind(
              "allocation-stale-requirement-race",
              "activity-stale-requirement-race",
              "credential-datasys-active",
              "requirement-datasys-active-work",
              1,
            ),
          database
            .prepare(
              `INSERT INTO activity_requirement_matches (
                 id, user_id, allocation_id, requirement_id, matched_units
               ) VALUES (?, ?, ?, ?, ?)`,
            )
            .bind(
              "match-stale-requirement-race",
              "user-managed-catalog",
              "allocation-stale-requirement-race",
              "requirement-datasys-active-work",
              1,
            ),
        ]),
        /activity_requirement_inactive/i,
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM activities
             WHERE id = 'activity-stale-requirement-race'`,
          )
          .get().count,
        0,
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM activity_allocations
             WHERE id = 'allocation-stale-requirement-race'`,
          )
          .get().count,
        0,
      );
      database.close();
    },
  );

  await t.test(
    "adds lifecycle attestation columns to an existing database",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new SQLiteD1Database(DatabaseSync);
      const runtimeSource = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const bootstrapRuntime = await importTypeScriptModule(
        `${runtimeSource}\nexport const __attestationMigrationNonce = "bootstrap";`,
      );
      await bootstrapRuntime.initializeDatabase(database);
      const attestationMigration = await readFile(
        new URL("../drizzle/0006_graceful_jackal.sql", import.meta.url),
        "utf8",
      );
      assert.doesNotThrow(() => database.raw.exec(attestationMigration));
      database.raw.exec(
        `ALTER TABLE renewal_submissions DROP COLUMN attestation_kind;
         ALTER TABLE renewal_acceptances DROP COLUMN official_record_attested_at;`,
      );

      const columnNames = (table) =>
        database.raw
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((column) => column.name);
      assert.equal(
        columnNames("renewal_submissions").includes("attestation_kind"),
        false,
      );
      assert.equal(
        columnNames("renewal_acceptances").includes(
          "official_record_attested_at",
        ),
        false,
      );

      assert.doesNotThrow(() => database.raw.exec(attestationMigration));
      const upgradeRuntime = await importTypeScriptModule(
        `${runtimeSource}\nexport const __attestationMigrationNonce = "upgrade";`,
      );
      await upgradeRuntime.initializeDatabase(database);
      assert.ok(
        columnNames("renewal_submissions").includes("attestation_kind"),
      );
      assert.ok(
        columnNames("renewal_acceptances").includes(
          "official_record_attested_at",
        ),
      );
      database.close();
    },
  );

  await t.test(
    "atomically corrects active January-to-March 2027 CFP cycles without losing credit and preserves submitted snapshots",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new SQLiteD1Database(DatabaseSync);
      const runtimeSource = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const bootstrapRuntime = await importTypeScriptModule(
        `${runtimeSource}\nexport const __cfpBoundaryTestNonce = "bootstrap";`,
      );
      await bootstrapRuntime.initializeDatabase(database);

      const raw = database.raw;
      raw
        .prepare(
          `INSERT INTO users (id, email, display_name, is_demo)
           VALUES (?, ?, ?, 0)`,
        )
        .run("user-cfp-boundary", "cfp@example.com", "CFP Test");
      raw
        .prepare(
          `INSERT INTO credentials (
             id, user_id, rule_set_id, credential_name, profession,
             jurisdiction, issuer, cycle_start, deadline, total_required,
             unit_label, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "credential-cfp-boundary",
          "user-cfp-boundary",
          "cfp-professional-2027-v1",
          "CFP® Professional — cycle beginning April 1, 2027 or later",
          "Financial Planning",
          "United States",
          "CFP Board",
          "2027-02-01",
          "2029-02-01",
          40,
          "CE hours",
          "active",
        );
      raw
        .prepare(
          `INSERT INTO credentials (
             id, user_id, rule_set_id, credential_name, profession,
             jurisdiction, issuer, cycle_start, deadline, total_required,
             unit_label, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "credential-cfp-submitted",
          "user-cfp-boundary",
          "cfp-professional-2027-v1",
          "CFP® Professional — cycle beginning April 1, 2027 or later",
          "Financial Planning",
          "United States",
          "CFP Board",
          "2027-02-01",
          "2029-02-01",
          40,
          "CE hours",
          "submitted",
        );
      const insertRequirement = raw.prepare(
        `INSERT INTO credential_requirements (
           id, credential_id, rule_category_id, name, required_units, kind,
           relation, parent_requirement_id, applicability,
           applicability_status, condition_note, exclusive_group, is_active,
           sort_order
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertRequirement.run(
        "requirement-cfp-general",
        "credential-cfp-boundary",
        "cfp-professional-2027-general",
        "General CE",
        38,
        "minimum",
        "independent",
        null,
        "always",
        "applies",
        "Legacy future-cycle General CE.",
        null,
        1,
        0,
      );
      insertRequirement.run(
        "requirement-cfp-principal",
        "credential-cfp-boundary",
        "cfp-professional-2027-principal-topics",
        "General CE — Principal Topics Other Than Practice Management",
        33,
        "minimum",
        "nested",
        "requirement-cfp-general",
        "always",
        "applies",
        "Legacy future-cycle Principal Topics.",
        "CFP CE activity type",
        1,
        1,
      );
      insertRequirement.run(
        "requirement-cfp-practice",
        "credential-cfp-boundary",
        "cfp-professional-2027-practice-management",
        "Practice Management General CE",
        5,
        "maximum",
        "nested",
        "requirement-cfp-general",
        "optional",
        "applies",
        "Legacy future-cycle Practice Management.",
        "CFP CE activity type",
        1,
        2,
      );
      insertRequirement.run(
        "requirement-cfp-ethics",
        "credential-cfp-boundary",
        "cfp-professional-2027-ethics",
        "CFP Board-Approved Ethics CE",
        2,
        "minimum",
        "independent",
        null,
        "always",
        "applies",
        "Legacy future-cycle Ethics CE.",
        "CFP CE activity type",
        1,
        3,
      );
      insertRequirement.run(
        "requirement-cfp-custom",
        "credential-cfp-boundary",
        null,
        "Personal audit note",
        0,
        "informational",
        "independent",
        null,
        "optional",
        "applies",
        "User-created note that must survive.",
        null,
        1,
        4,
      );
      const insertActivity = raw.prepare(
        `INSERT INTO activities (
           id, user_id, title, provider, completion_date, total_units,
           evidence_status
         ) VALUES (?, ?, ?, ?, ?, ?, 'attached')`,
      );
      insertActivity.run(
        "activity-cfp-general",
        "user-cfp-boundary",
        "Practice management workshop",
        "CFP Test Provider",
        "2027-03-01",
        3,
      );
      insertActivity.run(
        "activity-cfp-ethics",
        "user-cfp-boundary",
        "CFP ethics program",
        "CFP Test Provider",
        "2027-03-15",
        2,
      );
      const insertAllocation = raw.prepare(
        `INSERT INTO activity_allocations (
           id, activity_id, credential_id, requirement_id, allocated_units
         ) VALUES (?, ?, ?, ?, ?)`,
      );
      insertAllocation.run(
        "allocation-cfp-general",
        "activity-cfp-general",
        "credential-cfp-boundary",
        "requirement-cfp-practice",
        3,
      );
      insertAllocation.run(
        "allocation-cfp-ethics",
        "activity-cfp-ethics",
        "credential-cfp-boundary",
        "requirement-cfp-ethics",
        2,
      );
      const insertMatch = raw.prepare(
        `INSERT INTO activity_requirement_matches (
           id, user_id, allocation_id, requirement_id, matched_units,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      insertMatch.run(
        "match-cfp-general-parent",
        "user-cfp-boundary",
        "allocation-cfp-general",
        "requirement-cfp-general",
        2,
        "2027-03-01 09:00:00",
      );
      insertMatch.run(
        "match-cfp-practice",
        "user-cfp-boundary",
        "allocation-cfp-general",
        "requirement-cfp-practice",
        3,
        "2027-03-01 09:05:00",
      );
      insertMatch.run(
        "match-cfp-ethics",
        "user-cfp-boundary",
        "allocation-cfp-ethics",
        "requirement-cfp-ethics",
        2,
        "2027-03-15 09:00:00",
      );
      raw
        .prepare(
          `INSERT INTO checklist_tasks (
             id, user_id, credential_id, title, kind, status, due_date,
             sort_order
           ) VALUES (?, ?, ?, ?, 'review', 'pending', ?, 0)`,
        )
        .run(
          "task-cfp-carryover",
          "user-cfp-boundary",
          "credential-cfp-boundary",
          "Confirm CFP Board carryover, then manually record only approved general CE",
          "2028-10-04",
        );

      const migrationRuntime = await importTypeScriptModule(
        `${runtimeSource}\nexport const __cfpBoundaryTestNonce = "migration";`,
      );
      await migrationRuntime.initializeDatabase(database);

      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 rule_set_id AS ruleSetId,
                 credential_name AS credentialName,
                 total_required AS totalRequired,
                 cycle_start AS cycleStart,
                 deadline,
                 status
               FROM credentials
               WHERE id = 'credential-cfp-boundary'`,
            )
            .get(),
        },
        {
          ruleSetId: "cfp-professional-pre-2027-v1",
          credentialName:
            "CFP® Professional — cycle beginning before April 1, 2027",
          totalRequired: 30,
          cycleStart: "2027-02-01",
          deadline: "2029-02-01",
          status: "active",
        },
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 rule_set_id AS ruleSetId,
                 credential_name AS credentialName,
                 total_required AS totalRequired,
                 status
               FROM credentials
               WHERE id = 'credential-cfp-submitted'`,
            )
            .get(),
        },
        {
          ruleSetId: "cfp-professional-2027-v1",
          credentialName:
            "CFP® Professional — cycle beginning April 1, 2027 or later",
          totalRequired: 40,
          status: "submitted",
        },
      );
      assert.deepEqual(
        raw
          .prepare(
            `SELECT id, rule_category_id AS ruleCategoryId, required_units AS requiredUnits
             FROM credential_requirements
             WHERE credential_id = 'credential-cfp-boundary'
             ORDER BY sort_order, id`,
          )
          .all()
          .map((row) => ({ ...row })),
        [
          {
            id: "requirement-cfp-general",
            ruleCategoryId: "cfp-professional-pre-2027-general",
            requiredUnits: 28,
          },
          {
            id: "requirement-cfp-ethics",
            ruleCategoryId: "cfp-professional-pre-2027-ethics",
            requiredUnits: 2,
          },
          {
            id: "requirement-cfp-custom",
            ruleCategoryId: null,
            requiredUnits: 0,
          },
        ],
      );
      assert.deepEqual(
        raw
          .prepare(
            `SELECT
               allocation_id AS allocationId,
               requirement_id AS requirementId,
               matched_units AS matchedUnits
             FROM activity_requirement_matches
             ORDER BY allocation_id, requirement_id`,
          )
          .all()
          .map((row) => ({ ...row })),
        [
          {
            allocationId: "allocation-cfp-ethics",
            requirementId: "requirement-cfp-ethics",
            matchedUnits: 2,
          },
          {
            allocationId: "allocation-cfp-general",
            requirementId: "requirement-cfp-general",
            matchedUnits: 3,
          },
        ],
      );
      assert.equal(
        raw
          .prepare(
            `SELECT requirement_id AS requirementId
             FROM activity_allocations
             WHERE id = 'allocation-cfp-general'`,
          )
          .get().requirementId,
        "requirement-cfp-general",
      );
      assert.equal(
        raw
          .prepare(
            `SELECT title
             FROM checklist_tasks
             WHERE id = 'task-cfp-carryover'`,
          )
          .get().title,
        "Review this corrected pre-April CFP cycle and remove any carryover entered for it",
      );

      const stableSnapshot = JSON.stringify({
        credential: raw
          .prepare(
            `SELECT * FROM credentials
             WHERE id = 'credential-cfp-boundary'`,
          )
          .get(),
        requirements: raw
          .prepare(
            `SELECT * FROM credential_requirements
             WHERE credential_id = 'credential-cfp-boundary'
             ORDER BY sort_order, id`,
          )
          .all(),
        allocations: raw
          .prepare(
            `SELECT * FROM activity_allocations
             WHERE credential_id = 'credential-cfp-boundary'
             ORDER BY id`,
          )
          .all(),
        matches: raw
          .prepare(
            `SELECT * FROM activity_requirement_matches
             ORDER BY allocation_id, requirement_id`,
          )
          .all(),
        tasks: raw
          .prepare(
            `SELECT * FROM checklist_tasks
             WHERE credential_id = 'credential-cfp-boundary'
             ORDER BY id`,
          )
          .all(),
      });
      const repeatRuntime = await importTypeScriptModule(
        `${runtimeSource}\nexport const __cfpBoundaryTestNonce = "repeat";`,
      );
      await repeatRuntime.initializeDatabase(database);
      assert.equal(
        JSON.stringify({
          credential: raw
            .prepare(
              `SELECT * FROM credentials
               WHERE id = 'credential-cfp-boundary'`,
            )
            .get(),
          requirements: raw
            .prepare(
              `SELECT * FROM credential_requirements
               WHERE credential_id = 'credential-cfp-boundary'
               ORDER BY sort_order, id`,
            )
            .all(),
          allocations: raw
            .prepare(
              `SELECT * FROM activity_allocations
               WHERE credential_id = 'credential-cfp-boundary'
               ORDER BY id`,
            )
            .all(),
          matches: raw
            .prepare(
              `SELECT * FROM activity_requirement_matches
               ORDER BY allocation_id, requirement_id`,
            )
            .all(),
          tasks: raw
            .prepare(
              `SELECT * FROM checklist_tasks
               WHERE credential_id = 'credential-cfp-boundary'
               ORDER BY id`,
            )
            .all(),
        }),
        stableSnapshot,
      );
      database.close();
    },
  );

  await t.test(
    "refreshes the official New Jersey LCSW rule without upgrading historical General credit",
    async () => {
      const [runtimeSource, routeSource] = await Promise.all([
        readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
        readFile(
          new URL("../app/api/workspace/route.ts", import.meta.url),
          "utf8",
        ),
      ]);
      const modelSource = runtimeSource.slice(
        runtimeSource.indexOf('const RULE_SET_ID = "nj-lcsw-sample-v1"'),
        runtimeSource.indexOf("const RICH_RULE_CATEGORY_INSERT_SQL"),
      );
      assert.match(
        modelSource,
        /RULE_GENERAL_ID = "nj-lcsw-sample-v1-general"/,
      );
      assert.match(
        modelSource,
        /RULE_CLINICAL_ID = "nj-lcsw-sample-v1-clinical"/,
      );
      assert.match(
        modelSource,
        /RULE_OPIOID_ID = "nj-lcsw-sample-v1-opioid"/,
      );
      assert.match(
        modelSource,
        /NJ_LCSW_RULE_SET_REFRESH_BINDINGS[\s\S]*?40,[\s\S]*?"credits"[\s\S]*?24,[\s\S]*?13:44G-6\.2[\s\S]*?8 surplus credits[\s\S]*?does not carry them automatically[\s\S]*?second year[\s\S]*?20 total credits[\s\S]*?10 clinical[\s\S]*?3 ethics[\s\S]*?2 social\/cultural/i,
      );
      assert.match(
        modelSource,
        /RULE_GENERAL_ID,[\s\S]*?"General Social Work",[\s\S]*?0,[\s\S]*?"informational"[\s\S]*?NJ_LCSW_CREDIT_CATEGORY_GROUP/,
      );
      assert.match(
        modelSource,
        /RULE_CLINICAL_ID,[\s\S]*?"Clinical Practice",[\s\S]*?20,[\s\S]*?"minimum"[\s\S]*?NJ_LCSW_CREDIT_CATEGORY_GROUP/,
      );
      assert.match(
        modelSource,
        /RULE_ETHICS_ID,[\s\S]*?"Ethics",[\s\S]*?5,[\s\S]*?"minimum"[\s\S]*?NJ_LCSW_CREDIT_CATEGORY_GROUP/,
      );
      assert.match(
        modelSource,
        /RULE_CULTURAL_ID,[\s\S]*?"Social and Cultural Competence",[\s\S]*?3,[\s\S]*?"minimum"[\s\S]*?NJ_LCSW_CREDIT_CATEGORY_GROUP/,
      );
      assert.match(
        modelSource,
        /RULE_OPIOID_ID,[\s\S]*?"Prescription Opioid Drugs",[\s\S]*?1,[\s\S]*?"minimum",[\s\S]*?"overlapping"[\s\S]*?null,[\s\S]*?4,/,
      );

      const snapshotSource = runtimeSource.slice(
        runtimeSource.indexOf(
          "const BACKFILL_NJ_LCSW_CREDENTIAL_REQUIREMENTS_SQL",
        ),
        runtimeSource.indexOf("const BACKFILL_TEXAS_ETHICS_MATCHES_SQL"),
      );
      assert.match(
        snapshotSource,
        /BACKFILL_NJ_LCSW_CREDENTIAL_REQUIREMENTS_SQL[\s\S]*?credential\.status = 'active'[\s\S]*?NOT EXISTS/,
      );
      assert.match(
        snapshotSource,
        /SYNC_NJ_LCSW_CREDENTIAL_REQUIREMENTS_SQL[\s\S]*?credential\.status = 'active'[\s\S]*?credential_requirements\.exclusive_group IS NOT category\.exclusive_group/,
      );
      assert.doesNotMatch(
        snapshotSource,
        /status (?:!= 'renewed'|IN \('active', 'submitted'\))/,
      );
      const syncSet = snapshotSource.slice(
        snapshotSource.indexOf(
          "const SYNC_NJ_LCSW_CREDENTIAL_REQUIREMENTS_SQL",
        ),
        snapshotSource.indexOf("WHERE credential_id IN"),
      );
      assert.doesNotMatch(syncSet, /applicability_status\s*=/);
      assert.doesNotMatch(syncSet, /is_active\s*=/);
      assert.doesNotMatch(
        runtimeSource,
        /RULE_GENERAL_ID[\s\S]{0,120}RULE_CLINICAL_ID[\s\S]{0,120}(UPDATE|INSERT)[\s\S]{0,120}activity_requirement_matches/i,
        "historical General matches must not be promoted to Clinical Practice",
      );

      const demoSource = runtimeSource.slice(
        runtimeSource.indexOf("async function ensureDemoWorkspace"),
        runtimeSource.indexOf("export async function getProgression"),
      );
      for (const categoryId of [
        "RULE_GENERAL_ID",
        "RULE_CLINICAL_ID",
        "RULE_ETHICS_ID",
        "RULE_CULTURAL_ID",
        "RULE_OPIOID_ID",
      ]) {
        assert.match(demoSource, new RegExp(`\\b${categoryId}\\b`));
      }
      assert.match(
        routeSource,
        /c\.rule_set_id AS ruleSetId[\s\S]*?credential\.ruleSetId !== NJ_LCSW_RULE_SET_ID[\s\S]*?groups\.add\(NJ_LCSW_CREDIT_CATEGORY_GROUP\)/,
        "legacy unclassified LCSW allocations must be excluded from progress",
      );
    },
  );

  await t.test(
    "refreshes six authoritative attorney templates with rich CLE rules",
    async () => {
      const runtimeSource = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const ruleRefreshSource = runtimeSource.slice(
        runtimeSource.indexOf("const ATTORNEY_RULE_SET_REFRESH_BINDINGS"),
        runtimeSource.indexOf("const ATTORNEY_RULE_CATEGORY_REFRESH_SQL"),
      );
      const categoryRefreshSource = runtimeSource.slice(
        runtimeSource.indexOf("const ATTORNEY_RULE_CATEGORY_REFRESH_BINDINGS"),
        runtimeSource.indexOf(
          "const RETIRED_ATTORNEY_RULE_CATEGORY_BINDINGS",
        ),
      );
      const retiredCategorySource = runtimeSource.slice(
        runtimeSource.indexOf(
          "const RETIRED_ATTORNEY_RULE_CATEGORY_BINDINGS",
        ),
        runtimeSource.indexOf("const GLOBAL_SEED_STATEMENTS"),
      );
      const templates = [
        {
          id: "ca-attorney-active-2026-v1",
          stableKey: "ca-attorney-active",
          jurisdiction: "California",
          sourceHost: "www.calbar.ca.gov",
          totalUnits: 25,
          cycleMonths: 36,
          effectiveDate: "2024-01-01",
          categories: [
            [
              "ca-attorney-active-2026-legal-ethics",
              "Legal Ethics",
              4,
              "minimum",
              "independent",
              null,
              "always",
              "California MCLE subject allocation",
            ],
            [
              "ca-attorney-active-2026-elimination-bias",
              "Elimination of Bias",
              2,
              "minimum",
              "independent",
              null,
              "always",
              "California MCLE subject allocation",
            ],
            [
              "ca-attorney-active-2026-competence",
              "Competence",
              2,
              "minimum",
              "independent",
              null,
              "always",
              "California MCLE subject allocation",
            ],
            [
              "ca-attorney-active-2026-technology",
              "Technology",
              1,
              "minimum",
              "independent",
              null,
              "always",
              "California MCLE subject allocation",
            ],
            [
              "ca-attorney-active-2026-civility",
              "Civility",
              1,
              "minimum",
              "independent",
              null,
              "always",
              "California MCLE subject allocation",
            ],
            [
              "ca-attorney-active-2026-participatory",
              "Participatory Credit",
              12.5,
              "minimum",
              "overlapping",
              null,
              "always",
              null,
            ],
            [
              "ca-attorney-active-2026-implicit-bias",
              "Implicit Bias and Bias-Reducing Strategies",
              1,
              "minimum",
              "nested",
              "ca-attorney-active-2026-elimination-bias",
              "always",
              "California MCLE subject allocation",
            ],
            [
              "ca-attorney-active-2026-prevention-detection",
              "Prevention and Detection",
              1,
              "minimum",
              "nested",
              "ca-attorney-active-2026-competence",
              "always",
              "California MCLE subject allocation",
            ],
          ],
        },
        {
          id: "tx-attorney-active-2026-v1",
          stableKey: "tx-attorney-active",
          jurisdiction: "Texas",
          sourceHost: "www.texasbar.com",
          totalUnits: 15,
          cycleMonths: 12,
          effectiveDate: "2026-04-24",
          categories: [
            [
              "tx-attorney-active-2026-ethics",
              "Legal Ethics and Professional Responsibility",
              3,
              "minimum",
              "independent",
              null,
              "always",
              null,
            ],
            [
              "tx-attorney-active-2026-accredited",
              "Accredited CLE",
              12,
              "minimum",
              "overlapping",
              null,
              "always",
              "Texas CLE delivery type",
            ],
            [
              "tx-attorney-active-2026-self-study",
              "Self-Study CLE",
              3,
              "maximum",
              "overlapping",
              null,
              "optional",
              "Texas CLE delivery type",
            ],
            [
              "tx-attorney-active-2026-accredited-ethics",
              "Accredited Ethics",
              2,
              "minimum",
              "nested",
              "tx-attorney-active-2026-accredited",
              "always",
              "Texas CLE delivery type",
            ],
          ],
        },
        {
          id: "ny-attorney-experienced-2026-v1",
          stableKey: "ny-attorney-experienced",
          jurisdiction: "New York",
          sourceHost: "www.nycourts.gov",
          totalUnits: 24,
          cycleMonths: 24,
          effectiveDate: "2023-07-01",
          categories: [
            [
              "ny-attorney-2026-ethics",
              "Ethics and Professionalism",
              4,
              "minimum",
              "independent",
              null,
              "always",
              null,
            ],
            [
              "ny-attorney-2026-diversity",
              "Diversity, Inclusion and Elimination of Bias",
              1,
              "minimum",
              "independent",
              null,
              "always",
              null,
            ],
            [
              "ny-attorney-2026-cybersecurity",
              "Cybersecurity, Privacy and Data Protection",
              1,
              "minimum",
              "overlapping",
              null,
              "always",
              null,
            ],
            [
              "ny-attorney-2026-non-cyber-ethics",
              "Non-Cybersecurity Ethics and Professionalism",
              1,
              "minimum",
              "nested",
              "ny-attorney-2026-ethics",
              "always",
              "New York ethics/cybersecurity allocation",
            ],
            [
              "ny-attorney-2026-cybersecurity-general",
              "Cybersecurity General",
              1,
              "informational",
              "nested",
              "ny-attorney-2026-cybersecurity",
              "always",
              "New York ethics/cybersecurity allocation",
            ],
            [
              "ny-attorney-2026-cybersecurity-ethics",
              "Cybersecurity Ethics",
              1,
              "informational",
              "nested",
              "ny-attorney-2026-cybersecurity",
              "always",
              "New York ethics/cybersecurity allocation",
            ],
          ],
        },
        {
          id: "fl-attorney-active-2026-v1",
          stableKey: "fl-attorney-active",
          jurisdiction: "Florida",
          sourceHost: "www-media.floridabar.org",
          totalUnits: 30,
          cycleMonths: 36,
          effectiveDate: "2026-06-15",
          categories: [
            [
              "fl-attorney-active-2026-technology",
              "Technology",
              3,
              "minimum",
              "independent",
              null,
              "always",
              null,
            ],
            [
              "fl-attorney-active-2026-ethics-professionalism-wellness",
              "Legal Ethics, Professionalism, Substance Use Disorder, or Mental Health and Wellness",
              5,
              "minimum",
              "independent",
              null,
              "always",
              null,
            ],
            [
              "fl-attorney-active-2026-florida-professionalism",
              "Florida Legal Professionalism Course",
              2,
              "minimum",
              "nested",
              "fl-attorney-active-2026-ethics-professionalism-wellness",
              "always",
              null,
            ],
          ],
        },
        {
          id: "nj-attorney-active-2026-v1",
          stableKey: "nj-attorney-active",
          jurisdiction: "New Jersey",
          sourceHost: "www.njcourts.gov",
          totalUnits: 24,
          cycleMonths: 24,
          effectiveDate: "2021-01-01",
          categories: [
            [
              "nj-attorney-active-2026-ethics",
              "Ethics and Professionalism",
              5,
              "minimum",
              "independent",
              null,
              "always",
              null,
            ],
            [
              "nj-attorney-active-2026-diversity",
              "Diversity, Inclusion and Elimination of Bias",
              2,
              "minimum",
              "nested",
              "nj-attorney-active-2026-ethics",
              "always",
              null,
            ],
            [
              "nj-attorney-active-2026-technology",
              "Technology-related",
              1,
              "minimum",
              "overlapping",
              null,
              "conditional",
              null,
            ],
            [
              "nj-attorney-active-2026-live",
              "Live Instruction",
              12,
              "minimum",
              "overlapping",
              null,
              "conditional",
              null,
            ],
          ],
        },
        {
          id: "pa-attorney-active-2026-v1",
          stableKey: "pa-attorney-active",
          jurisdiction: "Pennsylvania",
          sourceHost: "www.pacle.org",
          totalUnits: 12,
          cycleMonths: 12,
          effectiveDate: "2014-01-30",
          categories: [
            [
              "pa-attorney-active-2026-ethics",
              "Ethics, Professionalism, or Substance Abuse",
              2,
              "minimum",
              "independent",
              null,
              "always",
              null,
            ],
            [
              "pa-attorney-active-2026-live",
              "Live Online or In-Person/Classroom",
              6,
              "minimum",
              "overlapping",
              null,
              "always",
              "Pennsylvania CLE delivery type",
            ],
            [
              "pa-attorney-active-2026-on-demand",
              "Pre-Recorded/On-Demand",
              6,
              "maximum",
              "overlapping",
              null,
              "optional",
              "Pennsylvania CLE delivery type",
            ],
          ],
        },
      ];

      const expectedRuleIds = templates.map((template) => template.id);
      const expectedCategoryIds = templates.flatMap((template) =>
        template.categories.map((category) => category[0]),
      );
      assert.equal(expectedCategoryIds.length, 28);
      assert.equal(new Set(expectedCategoryIds).size, 28);

      const expectedRuleRows = [];
      const expectedCategoryRows = [];
      for (const template of templates) {
        const rule = sourceLiteralArrayAround(ruleRefreshSource, template.id);
        expectedRuleRows.push(rule);
        assert.deepEqual(
          [
            rule[15],
            rule[0],
            rule[1],
            rule[2],
            rule[4],
            rule[6],
            rule[8],
            new URL(rule[9]).hostname,
            rule[11],
            rule[12],
            rule[13],
            rule[14],
          ],
          [
            template.id,
            template.stableKey,
            1,
            "Law",
            template.jurisdiction,
            template.totalUnits,
            template.cycleMonths,
            template.sourceHost,
            template.effectiveDate,
            "2026-07-26",
            "source_linked_check_conditions",
            1,
          ],
        );
        assert.ok(
          rule[10].length > 100,
          `${template.id} needs a precise authoritative-source caveat`,
        );

        assert.equal(
          categoryRefreshSource.split(`"${template.id}"`).length - 1,
          template.categories.length,
          `${template.id} category count drifted`,
        );
        const categoryRows = template.categories.map((category) =>
          sourceLiteralArrayAround(categoryRefreshSource, category[0]),
        );
        expectedCategoryRows.push(...categoryRows);
        assert.deepEqual(
          categoryRows.map((category) => [
            category[10],
            category[1],
            category[2],
            category[3],
            category[4],
            category[5],
            category[6],
            category[8],
          ]),
          template.categories,
        );
        assert.deepEqual(
          categoryRows.map((category) => category[9]),
          categoryRows.map((_, index) => index),
          `${template.id} category sort order must be contiguous`,
        );

        const categoryIds = new Set(
          categoryRows.map((category) => category[10]),
        );
        for (const category of categoryRows) {
          assert.equal(category[0], template.id);
          assert.ok(category[2] <= template.totalUnits);
          if (category[4] === "nested") {
            assert.ok(
              category[5] && categoryIds.has(category[5]),
              `${category[10]} must reference a category in its rule set`,
            );
          }
          if (category[6] === "conditional") {
            assert.ok(
              category[7]?.length > 60,
              `${category[10]} needs an actionable applicability note`,
            );
          }
          if (category[3] === "maximum") {
            assert.equal(category[6], "optional");
          }
        }
      }

      const californiaSubjectIds = templates[0].categories
        .map((category) => category[0])
        .filter(
          (categoryId) =>
            categoryId !== "ca-attorney-active-2026-participatory",
        );
      const californiaSubjectRows = californiaSubjectIds.map((categoryId) =>
        sourceLiteralArrayAround(categoryRefreshSource, categoryId),
      );
      assert.ok(
        californiaSubjectRows.every(
          (category) =>
            category[8] === "California MCLE subject allocation",
        ),
        "California substantive MCLE allocations must be mutually exclusive",
      );
      assert.ok(
        californiaSubjectRows.every((category) =>
          /split[\s\S]*?separate activity entries[\s\S]*?non-overlapping hours/i.test(
            category[7],
          ),
        ),
        "California subject notes must require split entries for divided hours",
      );
      assert.equal(
        sourceLiteralArrayAround(
          categoryRefreshSource,
          "ca-attorney-active-2026-participatory",
        )[8],
        null,
        "California participatory credit remains a delivery overlay",
      );
      assert.match(
        sourceLiteralArrayAround(
          ruleRefreshSource,
          "ca-attorney-active-2026-v1",
        )[10],
        /same instructional time[\s\S]*?only one substantive MCLE subfield[\s\S]*?split/i,
      );

      assert.doesNotMatch(
        categoryRefreshSource,
        /tx-attorney-active-2026-self-study-ethics/,
        "Texas must not retain a standalone one-hour self-study-ethics cap",
      );
      assert.match(
        retiredCategorySource,
        /tx-attorney-active-2026-self-study-ethics/,
        "the unsafe previously seeded Texas category must be retired",
      );
      const texasAccreditedEthics = sourceLiteralArrayAround(
        categoryRefreshSource,
        "tx-attorney-active-2026-accredited-ethics",
      );
      assert.equal(
        texasAccreditedEthics[5],
        "tx-attorney-active-2026-accredited",
      );
      assert.equal(texasAccreditedEthics[8], "Texas CLE delivery type");
      assert.match(
        texasAccreditedEthics[7],
        /must also be tagged Legal Ethics and Professional Responsibility/i,
      );
      assert.match(
        sourceLiteralArrayAround(
          categoryRefreshSource,
          "tx-attorney-active-2026-self-study",
        )[7],
        /also be tagged Legal Ethics[\s\S]*?no separate deduction/i,
      );

      const newYorkAllocationIds = [
        "ny-attorney-2026-non-cyber-ethics",
        "ny-attorney-2026-cybersecurity-general",
        "ny-attorney-2026-cybersecurity-ethics",
      ];
      const newYorkAllocationRows = newYorkAllocationIds.map((categoryId) =>
        sourceLiteralArrayAround(categoryRefreshSource, categoryId),
      );
      assert.ok(
        newYorkAllocationRows.every(
          (category) =>
            category[8] === "New York ethics/cybersecurity allocation",
        ),
        "New York ethics/cybersecurity allocation leaves must be exclusive",
      );
      assert.match(newYorkAllocationRows[0][7], /At least 1 of the 4/i);
      assert.ok(
        newYorkAllocationRows.slice(1).every((category) =>
          /split[\s\S]*?separate activity entries/i.test(category[7]),
        ),
        "New York mixed cybersecurity credit must be split into entries",
      );
      assert.match(
        newYorkAllocationRows[2][7],
        /must also be tagged Ethics and Professionalism/i,
      );
      assert.match(
        sourceLiteralArrayAround(
          ruleRefreshSource,
          "ny-attorney-experienced-2026-v1",
        )[10],
        /reporting cycle and deadline[\s\S]*?partial-practice proration/i,
      );

      const runtimeModule = await importTypeScriptModule(runtimeSource);
      const deployedRichColumns = [
        "kind",
        "relation",
        "parent_category_id",
        "parent_requirement_id",
        "applicability",
        "applicability_status",
        "condition_note",
        "exclusive_group",
        "is_active",
      ].map((name) => ({ name }));
      const staleDatabase = new FakeDatabase({
        resolveAll(call) {
          if (/^PRAGMA table_info\(/i.test(call.sql)) {
            return deployedRichColumns;
          }
          return [];
        },
      });
      await runtimeModule.initializeDatabase(staleDatabase);

      const ruleRefreshBatch = staleDatabase.batches.find(
        (batch) =>
          batch.length === expectedRuleIds.length &&
          batch.every(({ sql }) =>
            /^UPDATE rule_sets SET stable_key = \?/i.test(sql),
          ),
      );
      const categoryRefreshBatch = staleDatabase.batches.find(
        (batch) =>
          batch.length === expectedCategoryIds.length &&
          batch.every(({ sql }) =>
            /^UPDATE rule_categories SET rule_set_id = \?/i.test(sql),
          ),
      );
      const snapshotMigrationBatch = staleDatabase.batches.find(
        (batch) =>
          batch.some(({ sql }) =>
            /'catalog-sync:' \|\| credential\.id \|\| ':' \|\| category\.id/i.test(
              sql,
            ),
          ) &&
          batch.some(({ sql }) =>
            /'catalog-sync-match:' \|\| source_match\.allocation_id/i.test(
              sql,
            ),
          ),
      );
      const oneStatement = (predicate) => {
        const found = snapshotMigrationBatch?.find(predicate);
        return found ? [found] : undefined;
      };
      const retiredRequirementBatch = oneStatement(({ sql }) =>
        /^UPDATE credential_requirements SET applicability_status = 'not_applicable'/i.test(
          sql,
        ),
      );
      const retiredCategoryBatch = oneStatement(({ sql }) =>
        /^DELETE FROM rule_categories WHERE id = \?/i.test(sql),
      );
      const attorneyRequirementBackfillBatch = oneStatement(
        ({ sql }) =>
          /^INSERT INTO credential_requirements \(/i.test(sql) &&
          /'catalog-sync:' \|\| credential\.id \|\| ':' \|\| category\.id/i.test(
            sql,
          ),
      );
      const attorneyRequirementSyncBatch = oneStatement(
        ({ sql }) =>
          /^UPDATE credential_requirements SET name = \( SELECT category\.name/i.test(
            sql,
          ) &&
          /parent_requirement\.rule_category_id = category\.parent_category_id/i.test(
            sql,
          ),
      );
      const texasEthicsMatchBackfillBatch = oneStatement(
        ({ sql }) =>
          /^INSERT OR IGNORE INTO activity_requirement_matches \(/i.test(
            sql,
          ) &&
          /'catalog-sync-match:' \|\| source_match\.allocation_id/i.test(
            sql,
          ),
      );
      assert.ok(ruleRefreshBatch, "attorney rule-set refresh batch did not run");
      assert.ok(
        categoryRefreshBatch,
        "attorney category refresh batch did not run",
      );
      assert.ok(
        snapshotMigrationBatch,
        "credential snapshot migrations did not run atomically",
      );
      assert.ok(
        retiredRequirementBatch,
        "retired Texas requirements were not disabled",
      );
      assert.ok(retiredCategoryBatch, "retired Texas category was not deleted");
      assert.ok(
        attorneyRequirementBackfillBatch,
        "existing attorney cycles did not receive missing safe requirements",
      );
      assert.ok(
        attorneyRequirementSyncBatch,
        "existing attorney requirement snapshots were not synchronized",
      );
      assert.ok(
        texasEthicsMatchBackfillBatch,
        "existing Texas ethics allocations were not preserved",
      );
      assert.equal(
        retiredRequirementBatch[0].bindings[1],
        "tx-attorney-active-2026-self-study-ethics",
      );
      assert.deepEqual(retiredCategoryBatch[0].bindings, [
        "tx-attorney-active-2026-self-study-ethics",
      ]);
      const synchronizedAttorneyRuleIds = [
        "ca-attorney-active-2026-v1",
        "tx-attorney-active-2026-v1",
        "ny-attorney-experienced-2026-v1",
      ];
      assert.deepEqual(
        attorneyRequirementBackfillBatch[0].bindings,
        synchronizedAttorneyRuleIds,
      );
      assert.deepEqual(attorneyRequirementSyncBatch[0].bindings, [
        ...synchronizedAttorneyRuleIds,
        ...synchronizedAttorneyRuleIds,
      ]);
      assert.match(
        attorneyRequirementBackfillBatch[0].sql,
        /NOT EXISTS \( SELECT 1 FROM credential_requirements existing/i,
      );
      assert.match(
        attorneyRequirementBackfillBatch[0].sql,
        /credential\.status = 'active'/i,
      );
      assert.match(
        attorneyRequirementSyncBatch[0].sql,
        /exclusive_group = \( SELECT category\.exclusive_group/i,
      );
      assert.match(
        attorneyRequirementSyncBatch[0].sql,
        /credential\.status = 'active'/i,
      );
      assert.match(
        attorneyRequirementSyncBatch[0].sql,
        /AND EXISTS \( SELECT 1 FROM rule_categories category[\s\S]*?credential_requirements\.name IS NOT category\.name/i,
        "attorney snapshot sync must skip already-current rows",
      );
      assert.doesNotMatch(
        attorneyRequirementSyncBatch[0].sql,
        /applicability_status\s*=|is_active\s*=/i,
        "snapshot sync must preserve user-confirmed applicability state",
      );
      assert.match(
        retiredRequirementBatch[0].sql,
        /credential\.status = 'active'/i,
      );
      assert.match(
        texasEthicsMatchBackfillBatch[0].sql,
        /source_requirement\.rule_category_id = 'tx-attorney-active-2026-accredited-ethics'[\s\S]*?target_requirement\.rule_category_id = 'tx-attorney-active-2026-ethics'/i,
      );
      assert.match(
        texasEthicsMatchBackfillBatch[0].sql,
        /source_requirement\.rule_category_id = 'tx-attorney-active-2026-self-study-ethics'[\s\S]*?target_requirement\.rule_category_id IN \( 'tx-attorney-active-2026-ethics', 'tx-attorney-active-2026-self-study' \)/i,
      );
      assert.match(
        texasEthicsMatchBackfillBatch[0].sql,
        /credential\.status = 'active'/i,
      );
      assert.deepEqual(
        ruleRefreshBatch.map(({ bindings }) => bindings),
        expectedRuleRows,
      );
      assert.deepEqual(
        categoryRefreshBatch.map(({ bindings }) => bindings),
        expectedCategoryRows,
      );
      assert.deepEqual(
        ruleRefreshBatch.map(({ bindings }) => bindings.at(-1)),
        expectedRuleIds,
      );
      assert.deepEqual(
        categoryRefreshBatch.map(({ bindings }) => bindings.at(-1)),
        expectedCategoryIds,
      );
      assert.ok(
        ruleRefreshBatch.every(({ sql }) => /WHERE id = \?$/i.test(sql)),
      );
      assert.ok(
        categoryRefreshBatch.every(({ sql }) => /WHERE id = \?$/i.test(sql)),
      );

      const ruleRefreshBatchIndex =
        staleDatabase.batches.indexOf(ruleRefreshBatch);
      const categoryRefreshBatchIndex =
        staleDatabase.batches.indexOf(categoryRefreshBatch);
      const snapshotMigrationBatchIndex =
        staleDatabase.batches.indexOf(snapshotMigrationBatch);
      const attorneyRequirementBackfillBatchIndex =
        snapshotMigrationBatch.indexOf(attorneyRequirementBackfillBatch[0]);
      const attorneyRequirementSyncBatchIndex =
        snapshotMigrationBatch.indexOf(attorneyRequirementSyncBatch[0]);
      const texasEthicsMatchBackfillBatchIndex =
        snapshotMigrationBatch.indexOf(texasEthicsMatchBackfillBatch[0]);
      const retiredRequirementBatchIndex =
        snapshotMigrationBatch.indexOf(retiredRequirementBatch[0]);
      const retiredCategoryBatchIndex =
        snapshotMigrationBatch.indexOf(retiredCategoryBatch[0]);
      assert.ok(
        staleDatabase.batches
          .slice(0, ruleRefreshBatchIndex)
          .some((batch) =>
            batch.some(({ sql }) =>
              /^INSERT OR IGNORE INTO rule_sets \(/i.test(sql),
            ),
          ),
      );
      assert.ok(
        staleDatabase.batches
          .slice(ruleRefreshBatchIndex + 1, categoryRefreshBatchIndex)
          .some((batch) =>
            batch.some(({ sql }) =>
              /^INSERT OR IGNORE INTO rule_categories \(/i.test(sql),
            ),
          ),
      );
      assert.ok(
        categoryRefreshBatchIndex < snapshotMigrationBatchIndex,
      );
      assert.ok(
        attorneyRequirementBackfillBatchIndex <
          attorneyRequirementSyncBatchIndex,
      );
      assert.ok(
        attorneyRequirementSyncBatchIndex <
          texasEthicsMatchBackfillBatchIndex,
      );
      assert.ok(
        texasEthicsMatchBackfillBatchIndex < retiredRequirementBatchIndex,
      );
      assert.ok(retiredRequirementBatchIndex < retiredCategoryBatchIndex);
    },
  );

  await t.test(
    "keeps the larger template chooser and alternative tags mobile-accessible",
    async () => {
      const [clientSource, styles] = await Promise.all([
        readFile(
          new URL("../app/LicenseLanternApp.tsx", import.meta.url),
          "utf8",
        ),
        readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
      ]);
      assert.match(clientSource, /<optgroup[\s\S]*?group\.profession/);
      assert.match(
        clientSource,
        /setCatalogQuery\(event\.currentTarget\.value\);[\s\S]*?setSelectedRuleId\(""\);/,
      );
      assert.match(
        clientSource,
        /setSelectedRuleId\(event\.currentTarget\.value\)[\s\S]*?setCatalogQuery\(""\)/,
      );
      assert.match(
        clientSource,
        /catalogMatches\.length[\s\S]*?matches[\s\S]*?No exact match — enter my own requirements/,
      );
      assert.match(
        clientSource,
        /setSelectedRuleId\(""\)[\s\S]*?setCatalogQuery\(""\)[\s\S]*?setCustomCredential\(true\)[\s\S]*?No exact match — enter my own requirements/,
      );
      assert.match(clientSource, /Official source verified/);
      assert.match(clientSource, /Transition rule · check assigned cycle/);
      assert.match(clientSource, /Review date not set/);
      assert.match(
        clientSource,
        /selectedRule\.sourceTitle[\s\S]*?className="source-caution"[\s\S]*?\{selectedRule\.sourceTitle\}/,
      );
      assert.match(
        clientSource,
        /selectedRequirementIds[\s\S]*?exclusiveGroup[\s\S]*?Choose only one activity type from this group/,
      );
      assert.match(
        clientSource,
        /allocation\.classificationMessage[\s\S]*?excluded from progress/,
      );
      assert.match(clientSource, /Historical cycle is frozen/);
      assert.match(
        styles,
        /\.source-card p\s*\{[\s\S]*?font-size:\s*11px[\s\S]*?line-height:\s*1\.5/,
      );
      assert.match(
        styles,
        /\.source-card a\s*\{[\s\S]*?min-height:\s*44px/,
      );
      assert.match(
        styles,
        /\.catalog-custom-button\s*\{[\s\S]*?min-height:\s*44px/,
      );
    },
  );

  await t.test(
    "stores evidence metadata under private, owner-scoped R2 keys",
    async () => {
      const userId = await expectedStableUserId("owner@example.com");
      const bucket = new FakeEvidenceBucket();
      const database = new FakeDatabase({
        resolveFirst(call) {
          if (isOwnedMutableActivityLookup(call.sql)) {
            return {
              id: call.bindings[0],
              archivedAt: null,
              usedByClosedCycle: 0,
            };
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
              activityId: inserted.bindings[8],
              objectKey: inserted.bindings[2],
              originalFilename: inserted.bindings[3],
              contentType: inserted.bindings[4],
              sizeBytes: inserted.bindings[5],
              sha256: inserted.bindings[6],
              storageEtag: inserted.bindings[7],
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
      const evidenceXpInsert = statements.find((statement) =>
        /INSERT OR IGNORE INTO xp_events[\s\S]*?'evidence_attached'/i.test(
          statement.sql,
        ),
      );
      assert.ok(evidenceInsert);
      assert.ok(activityUpdate);
      assert.ok(evidenceXpInsert);
      assert.deepEqual(evidenceInsert.bindings.slice(0, 4), [
        result.evidence.id,
        userId,
        upload.key,
        "ethics-certificate.pdf",
      ]);
      assert.deepEqual(evidenceInsert.bindings.slice(-3), [
        "activity-owner",
        userId,
        12,
      ]);
      assert.match(evidenceInsert.sql, /activity\.archived_at IS NULL/i);
      assert.match(evidenceInsert.sql, /credential\.status = 'renewed'/i);
      assert.deepEqual(activityUpdate.bindings, [
        "ethics-certificate.pdf",
        "activity-owner",
        userId,
        result.evidence.id,
      ]);
      assert.match(activityUpdate.sql, /revision = revision \+ 1/i);
      assert.match(activityUpdate.sql, /archived_at IS NULL/i);
      assert.deepEqual(evidenceXpInsert.bindings.slice(1), [
        userId,
        `${userId}:activity:activity-owner:evidence-attached`,
        result.evidence.id,
        userId,
      ]);
    },
  );

  await t.test(
    "blocks proof mutations for archived activities and closed cycles",
    async () => {
      const archivedBucket = new FakeEvidenceBucket();
      const archivedDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (isOwnedMutableActivityLookup(call.sql)) {
            return {
              id: call.bindings[0],
              archivedAt: "2026-07-25 12:00:00",
              usedByClosedCycle: 0,
            };
          }
          return null;
        },
      });
      testCloudflareEnv.DB = archivedDatabase;
      testCloudflareEnv.EVIDENCE = archivedBucket;

      const bytes = new Uint8Array([
        0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a,
      ]);
      const form = new FormData();
      form.set("activityId", "activity-archived-proof");
      form.set(
        "file",
        new File([bytes], "archived.pdf", {
          type: "application/pdf",
        }),
      );
      const archivedUpload = await postEvidence(form);
      assert.equal(archivedUpload.status, 409);
      assert.deepEqual(await archivedUpload.json(), {
        error: "Restore this archived activity before changing its proof.",
        code: "activity_archived",
      });
      assert.equal(archivedBucket.puts.length, 0);
      assert.equal(
        flattenedStatements(archivedDatabase).some((statement) =>
          /^INSERT INTO evidence_files|^UPDATE evidence_files/i.test(
            statement.sql,
          ),
        ),
        false,
      );

      const closedBucket = new FakeEvidenceBucket();
      const evidenceId = "9f45f407-6424-47d2-9e4d-6e5971014701";
      const closedDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (isOwnedEvidenceForDeletionLookup(call.sql)) {
            return {
              id: evidenceId,
              activityId: "activity-closed-proof",
              objectKey: "evidence/owner/activity-closed-proof/evidence",
              originalFilename: "closed.pdf",
              contentType: "application/pdf",
              sizeBytes: 9,
              sha256: "closed-proof-sha",
              storageEtag: "closed-proof-etag",
              createdAt: "2026-07-25T12:00:00.000Z",
              status: "ready",
            };
          }
          if (isOwnedMutableActivityLookup(call.sql)) {
            return {
              id: call.bindings[0],
              archivedAt: null,
              usedByClosedCycle: 1,
            };
          }
          return null;
        },
      });
      testCloudflareEnv.DB = closedDatabase;
      testCloudflareEnv.EVIDENCE = closedBucket;

      const closedDelete = await fetchWorker(
        `https://license-lantern.example/api/evidence/${evidenceId}`,
        {
          method: "DELETE",
          headers: authHeaders(),
        },
      );
      assert.equal(closedDelete.status, 409);
      assert.deepEqual(await closedDelete.json(), {
        error:
          "This record is used by a closed renewal cycle, so its proof is frozen.",
        code: "cycle_closed",
      });
      assert.equal(closedBucket.deletes.length, 0);
      assert.equal(
        flattenedStatements(closedDatabase).some((statement) =>
          /^UPDATE evidence_files SET status = 'deleting'/i.test(
            statement.sql,
          ),
        ),
        false,
      );
      const mutableLookup = closedDatabase.calls.find(
        (call) =>
          call.method === "first" &&
          isOwnedMutableActivityLookup(call.sql),
      );
      assert.ok(mutableLookup);
      assert.deepEqual(mutableLookup.bindings, [
        "activity-closed-proof",
        await expectedStableUserId("owner@example.com"),
      ]);
    },
  );

  await t.test(
    "freezes accepted-cycle evidence and closes upload and delete races",
    async () => {
      const userId = await expectedStableUserId("owner@example.com");
      const bytes = new Uint8Array([
        0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a,
      ]);
      const form = new FormData();
      form.set("activityId", "activity-racing-acceptance");
      form.set(
        "file",
        new File([bytes], "race-proof.pdf", {
          type: "application/pdf",
        }),
      );

      const uploadBucket = new FakeEvidenceBucket();
      const uploadDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (isOwnedMutableActivityLookup(call.sql)) {
            return {
              id: call.bindings[0],
              archivedAt: null,
              usedByClosedCycle: this.raceClosed ? 1 : 0,
            };
          }
          if (/SELECT COUNT\(\*\) AS count FROM evidence_files/i.test(call.sql)) {
            return { count: 0 };
          }
          return null;
        },
        resolveBatch(statements) {
          if (
            statements.some((statement) =>
              /^INSERT INTO evidence_files \(/i.test(statement.sql),
            )
          ) {
            this.raceClosed = true;
            return statements.map(() => ({
              success: true,
              results: [],
              meta: { changes: 0 },
            }));
          }
          return undefined;
        },
      });
      testCloudflareEnv.DB = uploadDatabase;
      testCloudflareEnv.EVIDENCE = uploadBucket;

      const uploadResponse = await postEvidence(form);
      assert.equal(uploadResponse.status, 409);
      assert.deepEqual(await uploadResponse.json(), {
        error:
          "This record is used by a closed renewal cycle, so its proof is frozen.",
        code: "cycle_closed",
      });
      assert.equal(uploadBucket.puts.length, 1);
      assert.deepEqual(uploadBucket.deletes, [uploadBucket.puts[0].key]);
      const guardedInsert = flattenedStatements(uploadDatabase).find(
        (statement) => /^INSERT INTO evidence_files \(/i.test(statement.sql),
      );
      assert.ok(guardedInsert);
      assert.match(
        guardedInsert.sql,
        /SELECT \?, \?, activity\.id,[\s\S]*?FROM activities activity[\s\S]*?activity\.archived_at IS NULL[\s\S]*?credential\.status = 'renewed'/i,
      );

      const evidenceId = "36d2e90b-a0e9-4f61-83a7-d14a5dd467a6";
      const deleteBucket = new FakeEvidenceBucket();
      const deleteDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (isOwnedEvidenceForDeletionLookup(call.sql)) {
            return {
              id: evidenceId,
              activityId: "activity-racing-acceptance",
              objectKey: `evidence/${userId}/activity-racing-acceptance/${evidenceId}`,
              originalFilename: "race-proof.pdf",
              contentType: "application/pdf",
              sizeBytes: bytes.byteLength,
              sha256: "a".repeat(64),
              storageEtag: "test-etag",
              createdAt: "2026-07-25T12:00:00.000Z",
              status: "ready",
            };
          }
          if (isOwnedMutableActivityLookup(call.sql)) {
            return {
              id: call.bindings[0],
              archivedAt: null,
              usedByClosedCycle: this.raceClosed ? 1 : 0,
            };
          }
          return null;
        },
        resolveBatch(statements) {
          if (
            /^UPDATE evidence_files SET status = 'deleting'/i.test(
              statements[0]?.sql ?? "",
            )
          ) {
            this.raceClosed = true;
            return statements.map(() => ({
              success: true,
              results: [],
              meta: { changes: 0 },
            }));
          }
          return undefined;
        },
      });
      testCloudflareEnv.DB = deleteDatabase;
      testCloudflareEnv.EVIDENCE = deleteBucket;

      const deleteResponse = await fetchWorker(
        `https://license-lantern.example/api/evidence/${evidenceId}`,
        { method: "DELETE", headers: authHeaders() },
      );
      assert.equal(deleteResponse.status, 409);
      assert.deepEqual(await deleteResponse.json(), {
        error:
          "This record is used by a closed renewal cycle, so its proof is frozen.",
        code: "cycle_closed",
      });
      assert.equal(deleteBucket.deletes.length, 0);
      const guardedTransition = flattenedStatements(deleteDatabase).find(
        (statement) =>
          /^UPDATE evidence_files SET status = 'deleting'/i.test(
            statement.sql,
          ),
      );
      assert.ok(guardedTransition);
      assert.match(
        guardedTransition.sql,
        /status = 'ready' AND EXISTS \( SELECT 1 FROM activities activity[\s\S]*?activity\.archived_at IS NULL[\s\S]*?credential\.status = 'renewed'/i,
      );
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
          isOwnedMutableActivityLookup(call.sql),
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
    "requires one New Jersey LCSW credit category while allowing the opioid topic overlay",
    async () => {
      const requirements = [
        {
          id: "requirement-lcsw-general",
          name: "General Social Work",
          ruleCategoryId: "nj-lcsw-sample-v1-general",
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: "New Jersey LCSW credit category",
        },
        {
          id: "requirement-lcsw-clinical",
          name: "Clinical Practice",
          ruleCategoryId: "nj-lcsw-sample-v1-clinical",
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: "New Jersey LCSW credit category",
        },
        {
          id: "requirement-lcsw-opioid",
          name: "Prescription Opioid Drugs",
          ruleCategoryId: "nj-lcsw-sample-v1-opioid",
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: null,
        },
      ];
      const makeDatabase = () =>
        new FakeDatabase({
          resolveFirst(call) {
            if (isOwnedCredentialCycleLookup(call.sql)) {
              return {
                id: "credential-lcsw",
                status: "active",
                cycleStart: "2026-09-01",
                deadline: "2028-08-31",
              };
            }
            if (isOwnedActivityCycleLookup(call.sql)) {
              return {
                id: "activity-lcsw",
                totalUnits: 1,
                completionDate: "2027-02-15",
                evidenceStatus: "missing",
                revision: 1,
                archivedAt: null,
              };
            }
            if (
              /SELECT rule_set_id AS ruleSetId FROM credentials WHERE id = \? AND user_id = \?/i.test(
                call.sql,
              )
            ) {
              return { ruleSetId: "nj-lcsw-sample-v1" };
            }
            return null;
          },
          resolveAll(call) {
            if (isRequirementTagLookup(call.sql)) {
              const requestedIds = new Set(call.bindings.slice(2));
              return requirements.filter((requirement) =>
                requestedIds.has(requirement.id),
              );
            }
            return [];
          },
        });
      const baseActivity = {
        title: "Clinical opioid-risk training",
        completionDate: "2027-02-15",
        totalUnits: 1,
        credentialId: "credential-lcsw",
        evidenceStatus: "missing",
      };

      const untaggedDatabase = makeDatabase();
      testCloudflareEnv.DB = untaggedDatabase;
      const untaggedResponse = await postWorkspace("addActivity", {
        ...baseActivity,
        requirementIds: [],
      });
      assert.equal(untaggedResponse.status, 409);
      assert.equal(
        (await untaggedResponse.json()).code,
        "nj_lcsw_credit_category_required",
      );

      const allocationDatabase = makeDatabase();
      testCloudflareEnv.DB = allocationDatabase;
      const allocationResponse = await postWorkspace(
        "addActivityAllocation",
        {
          activityId: "activity-lcsw",
          credentialId: "credential-lcsw",
          allocatedUnits: 1,
          requirementIds: [],
        },
      );
      assert.equal(allocationResponse.status, 409);
      assert.equal(
        (await allocationResponse.json()).code,
        "nj_lcsw_credit_category_required",
      );

      const overlayOnlyDatabase = makeDatabase();
      testCloudflareEnv.DB = overlayOnlyDatabase;
      const overlayOnlyResponse = await postWorkspace("addActivity", {
        ...baseActivity,
        requirementIds: ["requirement-lcsw-opioid"],
      });
      assert.equal(overlayOnlyResponse.status, 409);
      assert.equal(
        (await overlayOnlyResponse.json()).code,
        "nj_lcsw_credit_category_required",
      );

      const validDatabase = makeDatabase();
      testCloudflareEnv.DB = validDatabase;
      const validResponse = await postWorkspace("addActivity", {
        ...baseActivity,
        requirementIds: [
          "requirement-lcsw-clinical",
          "requirement-lcsw-opioid",
        ],
      });
      assert.equal(validResponse.status, 200);
      assert.equal(
        flattenedStatements(validDatabase).filter((statement) =>
          /^INSERT INTO activity_requirement_matches \(/i.test(statement.sql),
        ).length,
        2,
      );

      const conflictDatabase = makeDatabase();
      testCloudflareEnv.DB = conflictDatabase;
      const conflictResponse = await postWorkspace("addActivity", {
        ...baseActivity,
        requirementIds: [
          "requirement-lcsw-general",
          "requirement-lcsw-clinical",
        ],
      });
      assert.equal(conflictResponse.status, 409);
      assert.equal(
        (await conflictResponse.json()).code,
        "exclusive_requirement_conflict",
      );
    },
  );

  await t.test(
    "uses April 1, 2027 as the exact CFP 30-to-40-hour boundary",
    async () => {
      const ruleRow = {
        id: "cfp-professional-pre-2027-v1",
        credentialName:
          "CFP® Professional — cycle beginning before April 1, 2027",
        profession: "Financial Planning",
        jurisdiction: "United States",
        issuer: "CFP Board",
        totalUnits: 30,
        unitLabel: "CE hours",
        cycleMonths: 24,
      };
      const beforeBoundaryDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (
            /FROM rule_sets WHERE id = \? AND is_current = 1/i.test(call.sql)
          ) {
            return ruleRow;
          }
          return null;
        },
      });
      testCloudflareEnv.DB = beforeBoundaryDatabase;
      const beforeBoundaryResponse = await postWorkspace("createCredential", {
        ruleSetId: "cfp-professional-pre-2027-v1",
        cycleStart: "2027-03-31",
        deadline: "2029-03-30",
      });
      assert.equal(beforeBoundaryResponse.status, 200);

      const boundaryDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (
            /FROM rule_sets WHERE id = \? AND is_current = 1/i.test(call.sql)
          ) {
            return ruleRow;
          }
          return null;
        },
      });
      testCloudflareEnv.DB = boundaryDatabase;
      const response = await postWorkspace("createCredential", {
        ruleSetId: "cfp-professional-pre-2027-v1",
        cycleStart: "2027-04-01",
        deadline: "2029-03-31",
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error:
          "This 30-hour CFP template is only for certification periods beginning before April 1, 2027. Use the 40-hour CFP requirement for a later cycle, and record carryover only after CFP Board confirms the eligible general CE amount.",
        code: "rule_transition_outside_template",
      });
      assert.equal(
        flattenedStatements(boundaryDatabase).some((statement) =>
          /^INSERT INTO (credentials|credential_requirements|checklist_tasks) \(/i.test(
            statement.sql,
          ),
        ),
        false,
      );
    },
  );

  await t.test(
    "requires an auditable CFP activity type and accepts Practice Management tagging",
    async () => {
      const activityPayload = {
        title: "Practice operations workshop",
        provider: "CFP CE Sponsor",
        completionDate: "2027-06-15",
        totalUnits: 2,
        credentialId: "credential-cfp-2027",
        evidenceStatus: "missing",
      };
      const makeDatabase = (requirementRows = []) =>
        new FakeDatabase({
          resolveFirst(call) {
            if (isOwnedCredentialCycleLookup(call.sql)) {
              return {
                id: "credential-cfp-2027",
                status: "active",
                cycleStart: "2027-04-01",
                deadline: "2029-03-31",
              };
            }
            if (
              /SELECT rule_set_id AS ruleSetId FROM credentials WHERE id = \? AND user_id = \?/i.test(
                call.sql,
              )
            ) {
              return { ruleSetId: "cfp-professional-2027-v1" };
            }
            return null;
          },
          resolveAll(call) {
            if (!isRequirementTagLookup(call.sql)) return [];
            const requestedIds = new Set(call.bindings.slice(2));
            return requirementRows.filter((row) => requestedIds.has(row.id));
          },
        });

      const untaggedDatabase = makeDatabase();
      testCloudflareEnv.DB = untaggedDatabase;
      const untaggedResponse = await postWorkspace("addActivity", {
        ...activityPayload,
        requirementIds: [],
      });
      assert.equal(untaggedResponse.status, 409);
      assert.deepEqual(await untaggedResponse.json(), {
        error:
          "Classify every CFP CE activity as Principal Topics, Practice Management, or Ethics. General CE cannot be left unclassified.",
        code: "cfp_activity_type_required",
      });

      const parentDatabase = makeDatabase([
        {
          id: "requirement-cfp-general",
          name: "General CE",
          ruleCategoryId: "cfp-professional-2027-general",
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: null,
        },
      ]);
      testCloudflareEnv.DB = parentDatabase;
      const parentResponse = await postWorkspace("addActivity", {
        ...activityPayload,
        requirementIds: ["requirement-cfp-general"],
      });
      assert.equal(parentResponse.status, 409);
      assert.deepEqual(await parentResponse.json(), {
        error:
          "Classify every CFP CE activity as Principal Topics, Practice Management, or Ethics. Tagging the General CE parent directly is not allowed.",
        code: "cfp_activity_type_required",
      });

      const practiceDatabase = makeDatabase([
        {
          id: "requirement-cfp-practice",
          name: "Practice Management General CE",
          ruleCategoryId: "cfp-professional-2027-practice-management",
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: "CFP CE activity type",
        },
      ]);
      testCloudflareEnv.DB = practiceDatabase;
      const practiceResponse = await postWorkspace("addActivity", {
        ...activityPayload,
        requirementIds: ["requirement-cfp-practice"],
      });
      assert.equal(practiceResponse.status, 200);
      const practiceStatements = flattenedStatements(practiceDatabase);
      assert.equal(
        practiceStatements.filter((statement) =>
          /^INSERT INTO activity_requirement_matches \(/i.test(statement.sql),
        ).length,
        1,
      );
      assert.equal(
        practiceStatements.find((statement) =>
          /^INSERT INTO activity_allocations \(/i.test(statement.sql),
        )?.bindings[3],
        "requirement-cfp-practice",
      );
    },
  );

  await t.test(
    "requires pharmacist template eligibility, full-cycle dates, and one sterile-compounding tier",
    async () => {
      const texasCategories = [
        {
          id: "tx-pharmacist-2026-texas-law-rules",
          name: "Texas Pharmacy Law or Rules",
          requiredUnits: 1,
          kind: "minimum",
          relation: "independent",
          parentCategoryId: null,
          applicability: "always",
          conditionNote: null,
          exclusiveGroup: null,
        },
        {
          id: "tx-pharmacist-2026-sterile-standard",
          name: "Sterile Compounding — Standard Practice",
          requiredUnits: 2,
          kind: "minimum",
          relation: "independent",
          parentCategoryId: null,
          applicability: "conditional",
          conditionNote:
            "Applies when the pharmacist performs ordinary sterile compounding.",
          exclusiveGroup: "Texas pharmacist sterile-compounding tier",
        },
        {
          id: "tx-pharmacist-2026-sterile-high-risk",
          name: "Sterile Compounding — Higher-Risk Practice",
          requiredUnits: 4,
          kind: "minimum",
          relation: "independent",
          parentCategoryId: null,
          applicability: "conditional",
          conditionNote:
            "Applies instead for specified higher-risk Category 2 or Category 3 compounding.",
          exclusiveGroup: "Texas pharmacist sterile-compounding tier",
        },
      ];
      const database = new FakeDatabase({
        resolveFirst(call) {
          if (/FROM rule_sets WHERE id = \? AND is_current = 1/i.test(call.sql)) {
            return {
              id: "tx-pharmacist-2026-v1",
              credentialName:
                "Pharmacist — active full biennial renewal",
              profession: "Pharmacy",
              jurisdiction: "Texas",
              issuer: "Texas State Board of Pharmacy",
              totalUnits: 30,
              unitLabel: "CE hours",
              cycleMonths: 24,
            };
          }
          return null;
        },
        resolveAll(call) {
          if (/FROM rule_categories WHERE rule_set_id = \?/i.test(call.sql)) {
            return texasCategories;
          }
          return [];
        },
      });
      testCloudflareEnv.DB = database;
      const basePayload = {
        ruleSetId: "tx-pharmacist-2026-v1",
        cycleStart: "2027-01-01",
        deadline: "2028-12-31",
      };

      const unattested = await postWorkspace(
        "createCredential",
        basePayload,
      );
      assert.equal(unattested.status, 409);
      const unattestedBody = await unattested.json();
      assert.equal(
        unattestedBody.code,
        "pharmacist_template_eligibility_required",
      );
      assert.match(unattestedBody.error, /shortened[\s\S]*?adjusted-status/i);
      assert.doesNotMatch(unattestedBody.error, /\binitial\b/i);

      const shortened = await postWorkspace("createCredential", {
        ...basePayload,
        deadline: "2028-12-20",
        templateEligibilityAttested: true,
      });
      assert.equal(shortened.status, 409);
      assert.equal(
        (await shortened.json()).code,
        "pharmacist_standard_cycle_dates_required",
      );

      const conflicting = await postWorkspace("createCredential", {
        ...basePayload,
        templateEligibilityAttested: true,
        applicabilityChoices: [
          {
            ruleCategoryId: "tx-pharmacist-2026-sterile-standard",
            status: "applies",
          },
          {
            ruleCategoryId: "tx-pharmacist-2026-sterile-high-risk",
            status: "applies",
          },
        ],
      });
      assert.equal(conflicting.status, 409);
      assert.equal(
        (await conflicting.json()).code,
        "conflicting_pharmacist_conditions",
      );

      const accepted = await postWorkspace("createCredential", {
        ...basePayload,
        templateEligibilityAttested: true,
        applicabilityChoices: [
          {
            ruleCategoryId: "tx-pharmacist-2026-sterile-standard",
            status: "applies",
          },
          {
            ruleCategoryId: "tx-pharmacist-2026-sterile-high-risk",
            status: "not_applicable",
          },
        ],
      });
      assert.equal(accepted.status, 200);
      const requirementStatements = flattenedStatements(database).filter(
        (statement) =>
          /^INSERT INTO credential_requirements \(/i.test(statement.sql),
      );
      assert.equal(requirementStatements.length, 3);
      const highRiskRequirement = requirementStatements.find(
        (statement) =>
          statement.bindings[2] ===
          "tx-pharmacist-2026-sterile-high-risk",
      );
      assert.ok(highRiskRequirement);
      assert.equal(highRiskRequirement.bindings[9], "not_applicable");
      assert.equal(highRiskRequirement.bindings[12], 0);

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
          if (!isApplicabilityRequirementsLookup(call.sql)) return [];
          return [
            {
              id: "requirement-sterile-standard",
              name: "Sterile Compounding — Standard Practice",
              ruleCategoryId:
                "tx-pharmacist-2026-sterile-standard",
              relation: "independent",
              parentRequirementId: null,
              applicability: "conditional",
              applicabilityStatus: "not_applicable",
            },
            {
              id: "requirement-sterile-high-risk",
              name: "Sterile Compounding — Higher-Risk Practice",
              ruleCategoryId:
                "tx-pharmacist-2026-sterile-high-risk",
              relation: "independent",
              parentRequirementId: null,
              applicability: "conditional",
              applicabilityStatus: "needs_confirmation",
            },
          ];
        },
      });
      testCloudflareEnv.DB = updateDatabase;
      const conflictingUpdate = await postWorkspace(
        "updateRequirementApplicability",
        {
          credentialId: "credential-tx-pharmacist",
          choices: [
            {
              requirementId: "requirement-sterile-standard",
              status: "applies",
            },
            {
              requirementId: "requirement-sterile-high-risk",
              status: "applies",
            },
          ],
        },
      );
      assert.equal(conflictingUpdate.status, 409);
      assert.equal(
        (await conflictingUpdate.json()).code,
        "conflicting_pharmacist_conditions",
      );
      assert.equal(
        flattenedStatements(updateDatabase).some((statement) =>
          /^UPDATE credential_requirements /i.test(statement.sql),
        ),
        false,
      );
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
          exclusiveGroup: "Test activity type",
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
          exclusiveGroup: null,
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
          exclusiveGroup: null,
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
      assert.deepEqual(parentInsert.bindings.slice(4, 14), [
        4,
        "minimum",
        "independent",
        null,
        "always",
        "applies",
        null,
        "Test activity type",
        1,
        0,
      ]);
      assert.equal(
        conditionalInsert.bindings[7],
        parentInsert.bindings[0],
        "nested parent must use the credential requirement snapshot ID",
      );
      assert.deepEqual(conditionalInsert.bindings.slice(4, 14), [
        2,
        "minimum",
        "nested",
        parentInsert.bindings[0],
        "conditional",
        "not_applicable",
        "Applies only when serving in the special role.",
        null,
        0,
        1,
      ]);
      assert.deepEqual(maximumInsert.bindings.slice(4, 14), [
        3,
        "maximum",
        "overlapping",
        null,
        "always",
        "applies",
        null,
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
          /^UPDATE credential_requirements SET applicability_status = \( SELECT json_extract\(choice\.value, '\$\.status'\) FROM json_each\(\?\) choice/i.test(
            statement.sql,
          ),
      );
      assert.ok(applicabilityUpdate);
      assert.match(
        applicabilityUpdate.sql,
        /WHERE credential_id = \? AND id IN \( SELECT json_extract\(choice\.value, '\$\.requirementId'\) FROM json_each\(\?\) choice \)[\s\S]*?credential\.user_id = \? AND credential\.status IN \('active', 'submitted'\)[\s\S]*?json_array_length\(\?\)/i,
      );
      const normalizedChoiceJson = JSON.stringify([
        {
          requirementId: "requirement-special-role",
          status: "applies",
          isActive: 1,
        },
      ]);
      assert.deepEqual(applicabilityUpdate.bindings, [
        normalizedChoiceJson,
        normalizedChoiceJson,
        "credential-rich",
        normalizedChoiceJson,
        userId,
        "credential-rich",
        normalizedChoiceJson,
        normalizedChoiceJson,
      ]);
      const confirmationXpInsert = flattenedStatements(updateDatabase).find(
        (statement) =>
          /INSERT OR IGNORE INTO xp_events[\s\S]*?'requirement_confirmed'/i.test(
            statement.sql,
          ),
      );
      assert.ok(confirmationXpInsert);
      assert.deepEqual(confirmationXpInsert.bindings.slice(1), [
        userId,
        `${userId}:requirement:requirement-special-role:confirmed`,
        "requirement-special-role",
        "requirement-special-role",
        "credential-rich",
        userId,
        "applies",
        1,
        normalizedChoiceJson,
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
          /^UPDATE credential_requirements /i.test(statement.sql) ||
          /'requirement_confirmed'/i.test(statement.sql),
        ),
        false,
        "an optional earning path must not allow its cap to be disabled or earn XP",
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
          /^UPDATE credential_requirements /i.test(statement.sql) ||
          /'requirement_confirmed'/i.test(statement.sql),
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
    "keeps 50-condition updates within D1 limits and leaves no XP after an allocation race",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new SQLiteD1Database(DatabaseSync);
      const runtimeSource = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const runtimeModule = await importTypeScriptModule(
        `${runtimeSource}\nexport const __applicabilityBudgetNonce = "fifty-and-race";`,
      );
      await runtimeModule.initializeDatabase(database);
      testCloudflareEnv.DB = database;
      const raw = database.raw;
      const userId = await expectedStableUserId("owner@example.com");
      raw
        .prepare(
          `INSERT INTO users (id, email, display_name, is_demo)
           VALUES (?, 'owner@example.com', 'Casey Owner', 0)
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(userId);
      const insertCredential = raw.prepare(
        `INSERT INTO credentials (
           id, user_id, rule_set_id, credential_name, profession,
           jurisdiction, issuer, cycle_start, deadline, total_required,
           unit_label, status
         ) VALUES (?, ?, NULL, ?, 'Testing', 'Test State', 'Test Board',
           '2027-01-01', '2027-12-31', 50, 'hours', 'active')`,
      );
      insertCredential.run(
        "credential-fifty-conditions",
        userId,
        "Fifty-condition plan",
      );
      const insertRequirement = raw.prepare(
        `INSERT INTO credential_requirements (
           id, credential_id, rule_category_id, name, required_units, kind,
           relation, applicability, applicability_status, is_active,
           sort_order
         ) VALUES (?, ?, NULL, ?, 1, 'minimum', 'independent',
           'conditional', 'needs_confirmation', 0, ?)`,
      );
      const fiftyChoices = [];
      for (let index = 0; index < 50; index += 1) {
        const requirementId = `requirement-budget-${index}`;
        insertRequirement.run(
          requirementId,
          "credential-fifty-conditions",
          `Condition ${index + 1}`,
          index,
        );
        fiftyChoices.push({
          requirementId,
          status: "not_applicable",
        });
      }

      const preparedBindingCounts = [];
      const prepareBeforeBudget = database.prepare.bind(database);
      database.prepare = (sql) => {
        const prepared = prepareBeforeBudget(sql);
        const bindBeforeBudget = prepared.bind.bind(prepared);
        prepared.bind = (...bindings) => {
          preparedBindingCounts.push({
            sql: normalizedSql(sql),
            bindingCount: bindings.length,
          });
          return bindBeforeBudget(...bindings);
        };
        return prepared;
      };
      const fiftyResponse = await postWorkspace(
        "updateRequirementApplicability",
        {
          credentialId: "credential-fifty-conditions",
          choices: fiftyChoices,
        },
      );
      assert.equal(
        fiftyResponse.status,
        200,
        JSON.stringify(await fiftyResponse.clone().json()),
      );
      assert.equal(
        Math.max(...preparedBindingCounts.map((item) => item.bindingCount)),
        52,
        "the 50-ID preflight lookup is the largest statement and stays below D1's 100-binding limit",
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 COUNT(*) AS requirementCount,
                 SUM(
                   CASE
                     WHEN applicability_status = 'not_applicable'
                       AND is_active = 0
                     THEN 1 ELSE 0
                   END
                 ) AS updatedCount
               FROM credential_requirements
               WHERE credential_id = 'credential-fifty-conditions'`,
            )
            .get(),
        },
        { requirementCount: 50, updatedCount: 50 },
      );

      insertCredential.run(
        "credential-applicability-race",
        userId,
        "Allocation-race plan",
      );
      raw
        .prepare(
          `INSERT INTO credential_requirements (
             id, credential_id, rule_category_id, name, required_units, kind,
             relation, applicability, applicability_status, is_active,
             sort_order
           ) VALUES (
             'requirement-applicability-race',
             'credential-applicability-race',
             NULL,
             'Conditional requirement',
             1,
             'minimum',
             'independent',
             'conditional',
             'applies',
             1,
             0
           )`,
        )
        .run();

      const batchBeforeRace = database.batch.bind(database);
      let allocationInjected = false;
      database.batch = async (statements) => {
        if (
          !allocationInjected &&
          statements.some((statement) =>
            /^UPDATE credential_requirements SET applicability_status =/i.test(
              normalizedSql(statement.sql),
            ),
          )
        ) {
          allocationInjected = true;
          raw
            .prepare(
              `INSERT INTO activities (
                 id, user_id, title, provider, completion_date, total_units,
                 evidence_status
               ) VALUES (
                 'activity-applicability-race',
                 ?,
                 'Racing course',
                 'Test Provider',
                 '2027-05-01',
                 1,
                 'missing'
               )`,
            )
            .run(userId);
          raw
            .prepare(
              `INSERT INTO activity_allocations (
                 id, activity_id, credential_id, requirement_id,
                 allocated_units
               ) VALUES (
                 'allocation-applicability-race',
                 'activity-applicability-race',
                 'credential-applicability-race',
                 'requirement-applicability-race',
                 1
               )`,
            )
            .run();
        }
        return batchBeforeRace(statements);
      };

      const raceResponse = await postWorkspace(
        "updateRequirementApplicability",
        {
          credentialId: "credential-applicability-race",
          choices: [
            {
              requirementId: "requirement-applicability-race",
              status: "not_applicable",
            },
          ],
        },
      );
      assert.equal(raceResponse.status, 409);
      assert.equal(
        (await raceResponse.json()).code,
        "requirement_has_allocated_credit",
      );
      assert.equal(allocationInjected, true);
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 applicability_status AS applicabilityStatus,
                 is_active AS isActive
               FROM credential_requirements
               WHERE id = 'requirement-applicability-race'`,
            )
            .get(),
        },
        { applicabilityStatus: "applies", isActive: 1 },
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM xp_events
             WHERE related_id = 'requirement-applicability-race'`,
          )
          .get().count,
        0,
        "the failed raced update must not commit confirmation XP",
      );
      database.close();
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
      assert.match(
        activityInsert.sql,
        /credential\.status IN \('active', 'submitted'\)/i,
      );
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
          requirementId,
          2,
          allocationId,
          activityInserts[0].bindings[0],
          "credential-rich",
          userId,
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
    "rejects alternative activity types while preserving valid overlay tags",
    async () => {
      const requirementRows = [
        {
          id: "requirement-general",
          name: "Technician-Specific CE",
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: "PTCB provider audience",
        },
        {
          id: "requirement-ethics",
          name: "Pharmacist-Specific CE",
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: "PTCB provider audience",
        },
        {
          id: "requirement-law",
          name: "Pharmacy Law",
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: null,
        },
      ];
      const makeDatabase = () =>
        new FakeDatabase({
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
            if (!isRequirementTagLookup(call.sql)) return [];
            const requestedIds = new Set(call.bindings.slice(2));
            return requirementRows.filter((row) => requestedIds.has(row.id));
          },
        });

      const conflictDatabase = makeDatabase();
      testCloudflareEnv.DB = conflictDatabase;
      const conflictResponse = await postWorkspace("addActivity", {
        title: "Conflicting classification",
        completionDate: "2027-05-20",
        totalUnits: 2,
        credentialId: "credential-rich",
        requirementIds: ["requirement-general", "requirement-ethics"],
        evidenceStatus: "missing",
      });
      assert.equal(conflictResponse.status, 409);
      assert.deepEqual(await conflictResponse.json(), {
        error:
          "Technician-Specific CE and Pharmacist-Specific CE are alternative activity types. Choose only one for this activity.",
        code: "exclusive_requirement_conflict",
      });
      assert.equal(
        flattenedStatements(conflictDatabase).some((statement) =>
          /^INSERT INTO (activities|activity_allocations|activity_requirement_matches) \(/i.test(
            statement.sql,
          ),
        ),
        false,
      );

      const overlayDatabase = makeDatabase();
      testCloudflareEnv.DB = overlayDatabase;
      const overlayResponse = await postWorkspace("addActivity", {
        title: "Technician pharmacy-law update",
        completionDate: "2027-05-20",
        totalUnits: 1,
        credentialId: "credential-rich",
        requirementIds: ["requirement-general", "requirement-law"],
        evidenceStatus: "missing",
      });
      assert.equal(overlayResponse.status, 200);
      assert.equal(
        flattenedStatements(overlayDatabase).filter((statement) =>
          /^INSERT INTO activity_requirement_matches \(/i.test(statement.sql),
        ).length,
        2,
      );
    },
  );

  await t.test(
    "requires a capped activity classification before either write path and accepts the catch-all",
    async () => {
      const requirementRows = [
        {
          id: "requirement-facility",
          name: "Facility Applications Training",
          ruleCategoryId:
            "arrt-rt-standard-2026-applications-training",
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: "ARRT capped activity type",
        },
        {
          id: "requirement-other",
          name: "Other Eligible Category A or A+ CE",
          ruleCategoryId:
            "arrt-rt-standard-2026-other-eligible-ce",
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: "ARRT capped activity type",
        },
      ];
      const makeDatabase = () =>
        new FakeDatabase({
          resolveFirst(call) {
            if (isOwnedActivityCycleLookup(call.sql)) {
              return {
                id: call.bindings[0],
                totalUnits: 2,
                completionDate: "2027-05-20",
                evidenceStatus: "missing",
                revision: 1,
                archivedAt: null,
              };
            }
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
            if (isRequiredMaximumGroupLookup(call.sql)) {
              return [
                { exclusiveGroup: "ARRT capped activity type" },
              ];
            }
            if (isRequirementTagLookup(call.sql)) {
              const requestedIds = new Set(call.bindings.slice(2));
              return requirementRows.filter((row) =>
                requestedIds.has(row.id),
              );
            }
            return [];
          },
        });
      const hasActivityWrite = (database) =>
        flattenedStatements(database).some((statement) =>
          /^(?:INSERT INTO activities|INSERT INTO activity_allocations|INSERT INTO activity_requirement_matches) \(/i.test(
            statement.sql,
          ),
        );

      const directDatabase = makeDatabase();
      testCloudflareEnv.DB = directDatabase;
      const directResponse = await postWorkspace("addActivity", {
        title: "Unclassified imaging seminar",
        completionDate: "2027-05-20",
        totalUnits: 2,
        credentialId: "credential-arrt",
        requirementIds: [],
        evidenceStatus: "missing",
      });
      assert.equal(directResponse.status, 409);
      assert.deepEqual(await directResponse.json(), {
        error:
          "Choose one ARRT capped activity type option for this activity so capped credit can be counted safely.",
        code: "maximum_classification_required",
      });
      assert.equal(hasActivityWrite(directDatabase), false);

      const allocationDatabase = makeDatabase();
      testCloudflareEnv.DB = allocationDatabase;
      const allocationResponse = await postWorkspace(
        "addActivityAllocation",
        {
          activityId: "activity-arrt",
          credentialId: "credential-arrt",
          requirementIds: [],
          allocatedUnits: 2,
        },
      );
      assert.equal(allocationResponse.status, 409);
      assert.deepEqual(await allocationResponse.json(), {
        error:
          "Choose one ARRT capped activity type option for this activity so capped credit can be counted safely.",
        code: "maximum_classification_required",
      });
      assert.equal(hasActivityWrite(allocationDatabase), false);

      const catchAllDatabase = makeDatabase();
      testCloudflareEnv.DB = catchAllDatabase;
      const catchAllResponse = await postWorkspace("addActivity", {
        title: "Other eligible Category A seminar",
        completionDate: "2027-05-20",
        totalUnits: 2,
        credentialId: "credential-arrt",
        requirementIds: ["requirement-other"],
        evidenceStatus: "missing",
      });
      assert.equal(catchAllResponse.status, 200);
      const catchAllMatches = flattenedStatements(
        catchAllDatabase,
      ).filter((statement) =>
        /^INSERT INTO activity_requirement_matches \(/i.test(
          statement.sql,
        ),
      );
      assert.equal(catchAllMatches.length, 1);
      assert.equal(catchAllMatches[0].bindings[2], "requirement-other");
    },
  );

  await t.test(
    "repairs a legacy unclassified allocation without changing its units",
    async () => {
      const userId = await expectedStableUserId("owner@example.com");
      const makeDatabase = () =>
        new FakeDatabase({
          resolveFirst(call) {
            if (
              /FROM activity_allocations allocation JOIN activities activity ON activity\.id = allocation\.activity_id JOIN credentials credential ON credential\.id = allocation\.credential_id WHERE allocation\.id = \?/i.test(
                call.sql,
              )
            ) {
              return {
                id: "allocation-legacy",
                credentialId: "credential-arrt",
                allocatedUnits: 4,
                activityId: "activity-legacy",
                activityRevision: 1,
                completionDate: "2027-05-20",
                evidenceStatus: "missing",
                archivedAt: null,
                status: "active",
                cycleStart: "2027-01-01",
                deadline: "2027-12-31",
              };
            }
            return null;
          },
          resolveAll(call) {
            if (isRequiredMaximumGroupLookup(call.sql)) {
              return [
                { exclusiveGroup: "ARRT capped activity type" },
              ];
            }
            if (isRequirementTagLookup(call.sql)) {
              return [
                {
                  id: "requirement-other",
                  name: "Other Eligible Category A or A+ CE",
                  ruleCategoryId:
                    "arrt-rt-standard-2026-other-eligible-ce",
                  isActive: 1,
                  applicabilityStatus: "applies",
                  exclusiveGroup: "ARRT capped activity type",
                },
              ];
            }
            return [];
          },
        });

      const rejectedDatabase = makeDatabase();
      testCloudflareEnv.DB = rejectedDatabase;
      const rejectedResponse = await postWorkspace(
        "updateActivityAllocationRequirements",
        {
          allocationId: "allocation-legacy",
          requirementIds: [],
        },
      );
      assert.equal(rejectedResponse.status, 409);
      assert.equal(
        flattenedStatements(rejectedDatabase).some((statement) =>
          /^(?:UPDATE activity_allocations|DELETE FROM activity_requirement_matches)/i.test(
            statement.sql,
          ),
        ),
        false,
      );

      const repairedDatabase = makeDatabase();
      testCloudflareEnv.DB = repairedDatabase;
      const repairedResponse = await postWorkspace(
        "updateActivityAllocationRequirements",
        {
          allocationId: "allocation-legacy",
          requirementIds: ["requirement-other"],
        },
      );
      assert.equal(repairedResponse.status, 200);
      assert.deepEqual(await repairedResponse.json(), {
        ok: true,
        action: "updateActivityAllocationRequirements",
        id: "allocation-legacy",
      });
      const statements = flattenedStatements(repairedDatabase);
      const allocationUpdate = statements.find((statement) =>
        /^UPDATE activity_allocations SET requirement_id = \?/i.test(
          statement.sql,
        ),
      );
      const priorMatchDelete = statements.find((statement) =>
        /^DELETE FROM activity_requirement_matches/i.test(statement.sql),
      );
      const replacementMatch = statements.find((statement) =>
        /^INSERT INTO activity_requirement_matches \(/i.test(
          statement.sql,
        ),
      );
      assert.ok(allocationUpdate);
      assert.ok(priorMatchDelete);
      assert.ok(replacementMatch);
      assert.deepEqual(allocationUpdate.bindings, [
        "requirement-other",
        "allocation-legacy",
        "credential-arrt",
        1,
        userId,
      ]);
      assert.deepEqual(priorMatchDelete.bindings, [
        "allocation-legacy",
        userId,
        1,
        userId,
      ]);
      assert.deepEqual(replacementMatch.bindings.slice(1), [
        userId,
        "requirement-other",
        "allocation-legacy",
        "credential-arrt",
        1,
        userId,
      ]);
      const revisionUpdate = statements.find((statement) =>
        /^UPDATE activities SET revision = revision \+ 1/i.test(statement.sql),
      );
      assert.ok(revisionUpdate);
      assert.deepEqual(revisionUpdate.bindings, [
        "activity-legacy",
        userId,
        1,
        "allocation-legacy",
        "credential-arrt",
      ]);
      assert.match(
        allocationUpdate.sql,
        /credential\.status IN \('active', 'submitted'\)/i,
      );
      assert.match(
        priorMatchDelete.sql,
        /credential\.status IN \('active', 'submitted'\)/i,
      );
      assert.match(
        replacementMatch.sql,
        /credential\.status IN \('active', 'submitted'\)/i,
      );
    },
  );

  await t.test(
    "rejects incompatible PTCB tags before either activity write path",
    async () => {
      const requirementRows = [
        {
          id: "requirement-patient-safety",
          name: "Patient Safety",
          ruleCategoryId: "ptcb-cpht-2026-patient-safety",
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: null,
        },
        {
          id: "requirement-bls",
          name: "Eligible BLS, CPR, or AED Training",
          ruleCategoryId: "ptcb-cpht-2026-bls-cpr-aed",
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: "PTCB capped activity type",
        },
        {
          id: "requirement-college",
          name: "Relevant College Coursework",
          ruleCategoryId: "ptcb-cpht-2026-college-coursework",
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: "PTCB capped activity type",
        },
      ];
      const makeDatabase = () =>
        new FakeDatabase({
          resolveFirst(call) {
            if (isOwnedActivityCycleLookup(call.sql)) {
              return {
                id: call.bindings[0],
                totalUnits: 2,
                completionDate: "2027-05-20",
                evidenceStatus: "missing",
                revision: 1,
                archivedAt: null,
              };
            }
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
            if (!isRequirementTagLookup(call.sql)) return [];
            const requestedIds = new Set(call.bindings.slice(2));
            return requirementRows.filter((row) => requestedIds.has(row.id));
          },
        });
      const assertNoActivityWrites = (database) => {
        assert.equal(
          flattenedStatements(database).some((statement) =>
            /^INSERT INTO (activities|activity_allocations|activity_requirement_matches) \(/i.test(
              statement.sql,
            ),
          ),
          false,
        );
      };

      const directDatabase = makeDatabase();
      testCloudflareEnv.DB = directDatabase;
      const directResponse = await postWorkspace("addActivity", {
        title: "CPR patient-safety conflict",
        completionDate: "2027-05-20",
        totalUnits: 2,
        credentialId: "credential-ptcb",
        requirementIds: [
          "requirement-bls",
          "requirement-patient-safety",
        ],
        evidenceStatus: "missing",
      });
      assert.equal(directResponse.status, 409);
      assert.deepEqual(await directResponse.json(), {
        error:
          "BLS, CPR, or AED training cannot satisfy Patient Safety for the same activity. Choose only one of those tags.",
        code: "incompatible_requirement_conflict",
      });
      assertNoActivityWrites(directDatabase);

      const allocationDatabase = makeDatabase();
      testCloudflareEnv.DB = allocationDatabase;
      const allocationResponse = await postWorkspace(
        "addActivityAllocation",
        {
          activityId: "activity-ptcb",
          credentialId: "credential-ptcb",
          requirementIds: [
            "requirement-patient-safety",
            "requirement-bls",
          ],
          allocatedUnits: 2,
        },
      );
      assert.equal(allocationResponse.status, 409);
      assert.deepEqual(await allocationResponse.json(), {
        error:
          "BLS, CPR, or AED training cannot satisfy Patient Safety for the same activity. Choose only one of those tags.",
        code: "incompatible_requirement_conflict",
      });
      assertNoActivityWrites(allocationDatabase);

      const overlayDatabase = makeDatabase();
      testCloudflareEnv.DB = overlayDatabase;
      const overlayResponse = await postWorkspace("addActivity", {
        title: "College patient-safety course",
        completionDate: "2027-05-20",
        totalUnits: 1,
        credentialId: "credential-ptcb",
        requirementIds: [
          "requirement-college",
          "requirement-patient-safety",
        ],
        evidenceStatus: "missing",
      });
      assert.equal(overlayResponse.status, 200);
      assert.equal(
        flattenedStatements(overlayDatabase).filter((statement) =>
          /^INSERT INTO activity_requirement_matches \(/i.test(statement.sql),
        ).length,
        2,
      );
      const validationLookup = overlayDatabase.calls.find(
        (call) => call.method === "all" && isRequirementTagLookup(call.sql),
      );
      assert.ok(validationLookup);
      assert.match(
        validationLookup.sql,
        /requirement\.rule_category_id AS ruleCategoryId/i,
      );

      const legacyRepairDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (
            /FROM activity_allocations allocation JOIN activities activity ON activity\.id = allocation\.activity_id JOIN credentials credential ON credential\.id = allocation\.credential_id WHERE allocation\.id = \?/i.test(
              call.sql,
            )
          ) {
            return {
              id: "allocation-legacy-ptcb",
              credentialId: "credential-legacy-ptcb",
              allocatedUnits: 1,
              activityId: "activity-legacy-ptcb",
              activityRevision: 1,
              completionDate: "2027-05-20",
              evidenceStatus: "missing",
              archivedAt: null,
              status: "submitted",
              cycleStart: "2027-01-01",
              deadline: "2027-12-31",
            };
          }
          if (
            /SELECT rule_set_id AS ruleSetId FROM credentials WHERE id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return { ruleSetId: "ptcb-cpht-2026-v1" };
          }
          return null;
        },
        resolveAll(call) {
          if (isRequiredMaximumGroupLookup(call.sql)) return [];
          if (isRequirementTagLookup(call.sql)) {
            return [requirementRows[0]];
          }
          return [];
        },
      });
      testCloudflareEnv.DB = legacyRepairDatabase;
      const legacyRepairResponse = await postWorkspace(
        "updateActivityAllocationRequirements",
        {
          allocationId: "allocation-legacy-ptcb",
          requirementIds: ["requirement-patient-safety"],
        },
      );
      assert.equal(legacyRepairResponse.status, 200);
      assert.equal(
        (await legacyRepairResponse.json()).action,
        "updateActivityAllocationRequirements",
      );
    },
  );

  await t.test(
    "rejects capped service and exception credit from unrelated minimum tags",
    async () => {
      const cases = [
        {
          credentialId: "credential-ptcb",
          left: {
            id: "requirement-bls",
            name: "Eligible BLS, CPR, or AED Training",
            ruleCategoryId: "ptcb-cpht-2026-bls-cpr-aed",
            exclusiveGroup: "PTCB capped activity type",
          },
          right: {
            id: "requirement-technician",
            name: "Technician-Specific CE",
            ruleCategoryId: "ptcb-cpht-2026-technician-specific",
            exclusiveGroup: "PTCB provider audience",
          },
          error:
            "BLS, CPR, or AED training cannot satisfy Technician-Specific CE, Pharmacist-Specific CE, or Pharmacy Law for the same activity. Choose the BLS activity type without those tags.",
        },
        {
          credentialId: "credential-nj-physician",
          left: {
            id: "requirement-volunteer",
            name: "Qualifying Volunteer Medical Care",
            ruleCategoryId: "nj-physician-2026-volunteer-care",
            exclusiveGroup: "New Jersey physician credit source",
          },
          right: {
            id: "requirement-opioids",
            name: "Prescription Opioid Drugs",
            ruleCategoryId: "nj-physician-2026-opioids",
            exclusiveGroup: null,
          },
          error:
            "Qualifying volunteer medical care credit cannot satisfy Category I or a nested Category I subject for the same activity. Choose the volunteer-care classifier without those tags.",
        },
        {
          credentialId: "credential-pmi",
          left: {
            id: "requirement-working",
            name: "Working as a Professional",
            ruleCategoryId: "pmi-pmp-2026-working-professional",
            exclusiveGroup: "PMI PDU activity type",
          },
          right: {
            id: "requirement-power-skills",
            name: "Power Skills",
            ruleCategoryId: "pmi-pmp-2026-power-skills",
            exclusiveGroup: null,
          },
          error:
            "Giving Back PDUs, including Working as a Professional, cannot satisfy Talent Triangle Education minimums for the same activity. Choose the Giving Back activity type without Education child tags.",
        },
        {
          credentialId: "credential-ca-bbs",
          left: {
            id: "requirement-ca-supervision",
            name: "Supervision Continuing Professional Development",
            ruleCategoryId:
              "ca-bbs-lmft-lcsw-lpcc-standard-2026-supervision-cpd",
            exclusiveGroup: null,
          },
          right: {
            id: "requirement-ca-law-ethics",
            name: "Law and Ethics",
            ruleCategoryId:
              "ca-bbs-lmft-lcsw-lpcc-standard-2026-law-ethics",
            exclusiveGroup: null,
          },
          error:
            "California BBS supervision CPD cannot also satisfy the general Law and Ethics minimum for the same credited time.",
        },
        {
          credentialId: "credential-nj-lpc",
          left: {
            id: "requirement-nj-carryover",
            name: "Committee-Confirmed Carryover",
            ruleCategoryId:
              "nj-lpc-standard-renewal-2026-confirmed-carryover",
            exclusiveGroup: "New Jersey LPC CE activity source",
          },
          right: {
            id: "requirement-nj-opioid",
            name: "Prescription Opioid Risks",
            ruleCategoryId: "nj-lpc-standard-renewal-2026-opioid",
            exclusiveGroup: null,
          },
          error:
            "New Jersey LPC carryover cannot satisfy the current-period prescription-opioid requirement.",
        },
        {
          credentialId: "credential-pa-lpc",
          left: {
            id: "requirement-pa-ethics",
            name: "Ethics",
            ruleCategoryId: "pa-lpc-standard-renewal-2026-ethics",
            exclusiveGroup: null,
          },
          right: {
            id: "requirement-pa-suicide",
            name: "Suicide Prevention",
            ruleCategoryId:
              "pa-lpc-standard-renewal-2026-suicide-prevention",
            exclusiveGroup: null,
          },
          error:
            "Pennsylvania LPC suicide-prevention credit cannot also satisfy the ethics minimum for the same credited time.",
        },
      ];

      for (const testCase of cases) {
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
            if (!isRequirementTagLookup(call.sql)) return [];
            return [testCase.left, testCase.right].map((requirement) => ({
              ...requirement,
              isActive: 1,
              applicabilityStatus: "applies",
            }));
          },
        });
        testCloudflareEnv.DB = database;
        const response = await postWorkspace("addActivity", {
          title: "Incompatible allocation",
          completionDate: "2027-05-20",
          totalUnits: 1,
          credentialId: testCase.credentialId,
          requirementIds: [testCase.left.id, testCase.right.id],
          evidenceStatus: "missing",
        });
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), {
          error: testCase.error,
          code: "incompatible_requirement_conflict",
        });
        assert.equal(
          flattenedStatements(database).some((statement) =>
            /^(?:INSERT INTO activities|INSERT INTO activity_allocations|INSERT INTO activity_requirement_matches) \(/i.test(
              statement.sql,
            ),
          ),
          false,
        );
      }
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
          "The activity date must fall within the target renewal cycle (2026-01-01 through 2026-12-31). A prior-period date is allowed only when every selected requirement is a portal-confirmed carryover category.",
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
              evidenceStatus: "missing",
              revision: 1,
              archivedAt: null,
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
          "The activity date must not be after the target renewal deadline (2026-12-31).",
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
      {
      const deliveryGroup = "New Jersey pharmacist delivery mode";
      const periodSourceGroup = "New Jersey pharmacist period source";
      const carryoverRequirements = [
        {
          id: "requirement-nj-pharmacist-live",
          name: "Didactic CE With Live Interaction",
          ruleCategoryId: "nj-pharmacist-2026-didactic-live",
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: deliveryGroup,
        },
        {
          id: "requirement-nj-pharmacist-carryover",
          name: "Board-Eligible Confirmed Carryover",
          ruleCategoryId: "nj-pharmacist-2026-confirmed-carryover",
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: periodSourceGroup,
        },
      ];
      const currentPeriodRequirement = {
        id: "requirement-nj-pharmacist-current-period",
        name: "Current-Period CE",
        ruleCategoryId: "nj-pharmacist-2026-current-period",
        isActive: 1,
        applicabilityStatus: "applies",
        exclusiveGroup: periodSourceGroup,
      };
      const carryoverResolver = {
        resolveFirst(call) {
          if (isOwnedCredentialCycleLookup(call.sql)) {
            return {
              id: call.bindings[0],
              status: "active",
              cycleStart: "2027-07-01",
              deadline: "2029-06-30",
            };
          }
          if (
            /SELECT rule_set_id AS ruleSetId FROM credentials WHERE id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return { ruleSetId: "nj-pharmacist-2026-v1" };
          }
          return null;
        },
        resolveAll(call) {
          if (isRequiredMaximumGroupLookup(call.sql)) {
            return [
              { exclusiveGroup: deliveryGroup },
              { exclusiveGroup: periodSourceGroup },
            ];
          }
          if (isRequirementTagLookup(call.sql)) {
            return [
              ...carryoverRequirements,
              currentPeriodRequirement,
            ].filter((requirement) =>
              call.bindings.includes(requirement.id),
            );
          }
          return [];
        },
      };
      const carryoverDatabase = new FakeDatabase(carryoverResolver);
      testCloudflareEnv.DB = carryoverDatabase;
      const carryoverResponse = await postWorkspace("addActivity", {
        title: "Board-confirmed prior-cycle pharmacy law",
        completionDate: "2027-03-15",
        totalUnits: 2,
        credentialId: "credential-nj-pharmacist",
        requirementIds: carryoverRequirements.map(
          (requirement) => requirement.id,
        ),
        evidenceStatus: "certificate saved",
        portalCarryoverAttested: true,
      });
      assert.equal(
        carryoverResponse.status,
        200,
        JSON.stringify(await carryoverResponse.clone().json()),
      );
      assert.ok(
        flattenedStatements(carryoverDatabase).some((statement) =>
          /^INSERT INTO activities \(/i.test(statement.sql),
        ),
      );

      const staleCarryoverDatabase = new FakeDatabase(carryoverResolver);
      testCloudflareEnv.DB = staleCarryoverDatabase;
      const staleCarryoverResponse = await postWorkspace("addActivity", {
        title: "Carryover outside the final six months",
        completionDate: "2026-12-31",
        totalUnits: 2,
        credentialId: "credential-nj-pharmacist",
        requirementIds: carryoverRequirements.map(
          (requirement) => requirement.id,
        ),
        evidenceStatus: "certificate saved",
        portalCarryoverAttested: true,
      });
      assert.equal(staleCarryoverResponse.status, 409);
      assert.equal(
        (await staleCarryoverResponse.json()).code,
        "carryover_outside_eligible_lookback",
      );

      const reusedCarryoverDatabase = new FakeDatabase({
        ...carryoverResolver,
        resolveFirst(call) {
          if (isOwnedActivityCycleLookup(call.sql)) {
            return {
              id: call.bindings[0],
              totalUnits: 2,
              completionDate: "2027-04-20",
              evidenceStatus: "attached",
              revision: 1,
              archivedAt: null,
            };
          }
          return carryoverResolver.resolveFirst(call);
        },
      });
      testCloudflareEnv.DB = reusedCarryoverDatabase;
      const reusedCarryover = await postWorkspace(
        "addActivityAllocation",
        {
          activityId: "activity-prior-nj-cycle",
          credentialId: "credential-nj-pharmacist",
          requirementIds: carryoverRequirements.map(
            (requirement) => requirement.id,
          ),
          allocatedUnits: 2,
          portalCarryoverAttested: true,
        },
      );
      assert.equal(reusedCarryover.status, 200);
      assert.ok(
        flattenedStatements(reusedCarryoverDatabase).some((statement) =>
          /^INSERT INTO activity_allocations \(/i.test(statement.sql),
        ),
      );

      const makeCarryoverRepairDatabase = (completionDate) =>
        new FakeDatabase({
          ...carryoverResolver,
          resolveFirst(call) {
            if (
              /activity\.completion_date AS completionDate/i.test(
                call.sql,
              )
            ) {
              return {
                id: "allocation-nj-pharmacist",
                credentialId: "credential-nj-pharmacist",
                allocatedUnits: 2,
                completionDate,
                status: "active",
                cycleStart: "2027-07-01",
                deadline: "2029-06-30",
              };
            }
            return carryoverResolver.resolveFirst(call);
          },
        });

      const currentDateRepairDatabase =
        makeCarryoverRepairDatabase("2027-08-15");
      testCloudflareEnv.DB = currentDateRepairDatabase;
      const currentDateRetag = await postWorkspace(
        "updateActivityAllocationRequirements",
        {
          allocationId: "allocation-nj-pharmacist",
          requirementIds: carryoverRequirements.map(
            (requirement) => requirement.id,
          ),
        },
      );
      assert.equal(currentDateRetag.status, 409);
      assert.equal(
        (await currentDateRetag.json()).code,
        "carryover_requires_prior_period_date",
      );

      const priorDateRepairDatabase =
        makeCarryoverRepairDatabase("2027-04-20");
      testCloudflareEnv.DB = priorDateRepairDatabase;
      const priorDateRetag = await postWorkspace(
        "updateActivityAllocationRequirements",
        {
          allocationId: "allocation-nj-pharmacist",
          requirementIds: [
            "requirement-nj-pharmacist-live",
            "requirement-nj-pharmacist-current-period",
          ],
        },
      );
      assert.equal(priorDateRetag.status, 409);
      assert.equal(
        (await priorDateRetag.json()).code,
        "activity_outside_cycle",
      );
      for (const repairDatabase of [
        currentDateRepairDatabase,
        priorDateRepairDatabase,
      ]) {
        assert.equal(
          flattenedStatements(repairDatabase).some((statement) =>
            /^UPDATE activity_allocations /i.test(statement.sql),
          ),
          false,
        );
      }

      const carryoverDeactivationDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (
            /SELECT id, status FROM credentials WHERE id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return {
              id: "credential-nj-pharmacist",
              status: "active",
            };
          }
          if (
            /SELECT requirement\.id, requirement\.name FROM credential_requirements requirement/i.test(
              call.sql,
            )
          ) {
            return {
              id: "requirement-nj-pharmacist-carryover",
              name: "Board-Eligible Confirmed Carryover",
            };
          }
          return null;
        },
        resolveAll(call) {
          if (!isApplicabilityRequirementsLookup(call.sql)) return [];
          return [
            {
              id: "requirement-nj-pharmacist-carryover",
              name: "Board-Eligible Confirmed Carryover",
              ruleCategoryId:
                "nj-pharmacist-2026-confirmed-carryover",
              relation: "independent",
              parentRequirementId: null,
              applicability: "conditional",
              applicabilityStatus: "applies",
            },
          ];
        },
      });
      testCloudflareEnv.DB = carryoverDeactivationDatabase;
      const carryoverDeactivation = await postWorkspace(
        "updateRequirementApplicability",
        {
          credentialId: "credential-nj-pharmacist",
          choices: [
            {
              requirementId:
                "requirement-nj-pharmacist-carryover",
              status: "not_applicable",
            },
          ],
        },
      );
      assert.equal(carryoverDeactivation.status, 409);
      assert.equal(
        (await carryoverDeactivation.json()).code,
        "requirement_has_allocated_credit",
      );
      assert.equal(
        flattenedStatements(carryoverDeactivationDatabase).some(
          (statement) =>
            /^UPDATE credential_requirements /i.test(statement.sql),
        ),
        false,
      );

      const staleCarryoverWriteDatabase = new FakeDatabase(
        carryoverResolver,
      );
      const ordinaryBatch =
        staleCarryoverWriteDatabase.batch.bind(
          staleCarryoverWriteDatabase,
        );
      staleCarryoverWriteDatabase.batch = async (statements) => {
        if (
          statements.some((statement) =>
            /INSERT INTO activity_requirement_matches/i.test(
              statement.sql,
            ),
          )
        ) {
          throw new Error("activity_requirement_inactive");
        }
        return ordinaryBatch(statements);
      };
      testCloudflareEnv.DB = staleCarryoverWriteDatabase;
      const staleCarryoverWrite = await postWorkspace("addActivity", {
        title: "Carryover racing a status change",
        completionDate: "2027-03-15",
        totalUnits: 2,
        credentialId: "credential-nj-pharmacist",
        requirementIds: carryoverRequirements.map(
          (requirement) => requirement.id,
        ),
        evidenceStatus: "certificate saved",
        portalCarryoverAttested: true,
      });
      assert.equal(staleCarryoverWrite.status, 409);
      assert.equal(
        (await staleCarryoverWrite.json()).code,
        "requirement_inactive",
      );

      const dtmRequirements = [
        {
          id: "requirement-tx-dtm-year-1",
          name: "Drug-Therapy-Management Practice — Registration Year 1",
          ruleCategoryId:
            "tx-pharmacist-2026-drug-therapy-management-year-1",
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: "Texas pharmacist drug-therapy year",
        },
        {
          id: "requirement-tx-dtm-year-2",
          name: "Drug-Therapy-Management Practice — Registration Year 2",
          ruleCategoryId:
            "tx-pharmacist-2026-drug-therapy-management-year-2",
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: "Texas pharmacist drug-therapy year",
        },
      ];
      const makeDtmDatabase = () =>
        new FakeDatabase({
          resolveFirst(call) {
            if (isOwnedCredentialCycleLookup(call.sql)) {
              return {
                id: "credential-tx-pharmacist",
                status: "active",
                cycleStart: "2027-01-01",
                deadline: "2028-12-31",
              };
            }
            if (
              /SELECT rule_set_id AS ruleSetId FROM credentials WHERE id = \? AND user_id = \?/i.test(
                call.sql,
              )
            ) {
              return { ruleSetId: "tx-pharmacist-2026-v1" };
            }
            return null;
          },
          resolveAll(call) {
            if (!isRequirementTagLookup(call.sql)) return [];
            return dtmRequirements.filter((requirement) =>
              call.bindings.includes(requirement.id),
            );
          },
        });
      const wrongDtmYearDatabase = makeDtmDatabase();
      testCloudflareEnv.DB = wrongDtmYearDatabase;
      const wrongDtmYear = await postWorkspace("addActivity", {
        title: "Second-year drug-therapy program",
        completionDate: "2028-01-01",
        totalUnits: 3,
        credentialId: "credential-tx-pharmacist",
        requirementIds: ["requirement-tx-dtm-year-1"],
        evidenceStatus: "certificate saved",
      });
      assert.equal(wrongDtmYear.status, 409);
      assert.equal(
        (await wrongDtmYear.json()).code,
        "pharmacist_annual_requirement_outside_year",
      );

      const correctDtmYearDatabase = makeDtmDatabase();
      testCloudflareEnv.DB = correctDtmYearDatabase;
      const correctDtmYear = await postWorkspace("addActivity", {
        title: "Second-year drug-therapy program",
        completionDate: "2028-01-01",
        totalUnits: 3,
        credentialId: "credential-tx-pharmacist",
        requirementIds: ["requirement-tx-dtm-year-2"],
        evidenceStatus: "certificate saved",
      });
      assert.equal(correctDtmYear.status, 200);
      assert.ok(
        flattenedStatements(correctDtmYearDatabase).some((statement) =>
          /^INSERT INTO activities \(/i.test(statement.sql),
        ),
      );
      }

      const carryoverGroup = "Pennsylvania Act 48 activity type";
      const carryoverRequirement = {
        id: "requirement-pa-carryover",
        name: "PERMS-Confirmed Carryover",
        ruleCategoryId:
          "pa-professional-educator-act-48-2026-confirmed-carryover",
        isActive: 1,
        applicabilityStatus: "applies",
        exclusiveGroup: carryoverGroup,
      };
      const ordinaryRequirement = {
        id: "requirement-pa-act-126",
        name: "Act 126 Child-Abuse Recognition and Reporting",
        ruleCategoryId: "pa-professional-educator-act-48-2026-act-126",
        isActive: 1,
        applicabilityStatus: "applies",
        exclusiveGroup: null,
      };
      const carryoverDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (isOwnedCredentialCycleLookup(call.sql)) {
            return {
              id: call.bindings[0],
              status: "active",
              cycleStart: "2026-01-01",
              deadline: "2026-12-31",
            };
          }
          if (
            /SELECT rule_set_id AS ruleSetId FROM credentials WHERE id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return {
              ruleSetId: "pa-professional-educator-act-48-2026-v1",
            };
          }
          return null;
        },
        resolveAll(call) {
          if (isRequiredMaximumGroupLookup(call.sql)) {
            return [{ exclusiveGroup: carryoverGroup }];
          }
          if (isRequirementTagLookup(call.sql)) {
            return [carryoverRequirement, ordinaryRequirement].filter(
              (requirement) => call.bindings.includes(requirement.id),
            );
          }
          return [];
        },
      });
      testCloudflareEnv.DB = carryoverDatabase;
      const unattestedCarryover = await postWorkspace("addActivity", {
        title: "Unconfirmed prior-period credit",
        provider: "PERMS",
        completionDate: "2025-11-15",
        totalUnits: 10,
        credentialId: "credential-pa-current",
        requirementIds: [carryoverRequirement.id],
        evidenceStatus: "missing",
      });
      assert.equal(unattestedCarryover.status, 409);
      assert.equal(
        (await unattestedCarryover.json()).code,
        "portal_carryover_attestation_required",
      );

      const staleCarryover = await postWorkspace("addActivity", {
        title: "Too-old prior-period credit",
        provider: "PERMS",
        completionDate: "2023-12-31",
        totalUnits: 10,
        credentialId: "credential-pa-current",
        requirementIds: [carryoverRequirement.id],
        evidenceStatus: "missing",
        portalCarryoverAttested: true,
      });
      assert.equal(staleCarryover.status, 409);
      assert.equal(
        (await staleCarryover.json()).code,
        "carryover_outside_eligible_lookback",
      );

      const acceptedCarryover = await postWorkspace("addActivity", {
        title: "PERMS-posted prior-period credit",
        provider: "PERMS",
        completionDate: "2025-11-15",
        totalUnits: 10,
        credentialId: "credential-pa-current",
        requirementIds: [carryoverRequirement.id],
        evidenceStatus: "missing",
        portalCarryoverAttested: true,
      });
      assert.equal(acceptedCarryover.status, 200);
      assert.ok(
        flattenedStatements(carryoverDatabase).some((statement) =>
          /^INSERT INTO activities \(/i.test(statement.sql),
        ),
      );

      const reusedCarryoverDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (isOwnedActivityCycleLookup(call.sql)) {
            return {
              id: "activity-pa-prior",
              totalUnits: 10,
              completionDate: "2025-11-15",
              evidenceStatus: "attached",
              revision: 1,
              archivedAt: null,
            };
          }
          if (isOwnedCredentialCycleLookup(call.sql)) {
            return {
              id: "credential-pa-current",
              status: "active",
              cycleStart: "2026-01-01",
              deadline: "2026-12-31",
            };
          }
          if (
            /SELECT rule_set_id AS ruleSetId FROM credentials WHERE id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return {
              ruleSetId: "pa-professional-educator-act-48-2026-v1",
            };
          }
          return null;
        },
        resolveAll: carryoverDatabase.resolveAll,
      });
      testCloudflareEnv.DB = reusedCarryoverDatabase;
      const reusedCarryover = await postWorkspace(
        "addActivityAllocation",
        {
          activityId: "activity-pa-prior",
          credentialId: "credential-pa-current",
          requirementIds: [carryoverRequirement.id],
          allocatedUnits: 10,
          portalCarryoverAttested: true,
        },
      );
      assert.equal(reusedCarryover.status, 200);
      assert.ok(
        flattenedStatements(reusedCarryoverDatabase).some(
          (statement) =>
            /^INSERT INTO activity_allocations \(/i.test(
              statement.sql,
            ),
        ),
      );

      const mixedCarryoverDatabase = new FakeDatabase({
        resolveFirst: carryoverDatabase.resolveFirst,
        resolveAll: carryoverDatabase.resolveAll,
      });
      testCloudflareEnv.DB = mixedCarryoverDatabase;
      const mixedCarryover = await postWorkspace("addActivity", {
        title: "Mixed prior-period allocation",
        completionDate: "2025-11-15",
        totalUnits: 10,
        credentialId: "credential-pa-current",
        requirementIds: [
          carryoverRequirement.id,
          ordinaryRequirement.id,
        ],
        evidenceStatus: "missing",
      });
      assert.equal(mixedCarryover.status, 409);
      assert.equal(
        (await mixedCarryover.json()).code,
        "mixed_carryover_requirement_tags",
      );
      assert.equal(
        flattenedStatements(mixedCarryoverDatabase).some((statement) =>
          /^INSERT INTO (activities|activity_allocations|activity_requirement_matches) \(/i.test(
            statement.sql,
          ),
        ),
        false,
      );

      const currentPeriodCarryoverDatabase = new FakeDatabase({
        resolveFirst: carryoverDatabase.resolveFirst,
        resolveAll: carryoverDatabase.resolveAll,
      });
      testCloudflareEnv.DB = currentPeriodCarryoverDatabase;
      const currentPeriodCarryover = await postWorkspace("addActivity", {
        title: "Current-period credit mislabeled as carryover",
        completionDate: "2026-02-15",
        totalUnits: 10,
        credentialId: "credential-pa-current",
        requirementIds: [carryoverRequirement.id],
        evidenceStatus: "missing",
        portalCarryoverAttested: true,
      });
      assert.equal(currentPeriodCarryover.status, 409);
      assert.equal(
        (await currentPeriodCarryover.json()).code,
        "carryover_requires_prior_period_date",
      );

      const retagDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (
            /FROM activity_allocations allocation JOIN activities activity ON activity\.id = allocation\.activity_id JOIN credentials credential ON credential\.id = allocation\.credential_id WHERE allocation\.id = \?/i.test(
              call.sql,
            )
          ) {
            return {
              id: "allocation-pa-carryover",
              credentialId: "credential-pa-current",
              allocatedUnits: 10,
              activityId: "activity-pa-prior",
              activityRevision: 1,
              completionDate: "2025-11-15",
              evidenceStatus: "attached",
              archivedAt: null,
              status: "active",
              cycleStart: "2026-01-01",
              deadline: "2026-12-31",
            };
          }
          if (
            /SELECT rule_set_id AS ruleSetId FROM credentials WHERE id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return {
              ruleSetId: "pa-professional-educator-act-48-2026-v1",
            };
          }
          return null;
        },
        resolveAll(call) {
          if (isRequiredMaximumGroupLookup(call.sql)) return [];
          if (isRequirementTagLookup(call.sql)) {
            return [ordinaryRequirement];
          }
          return [];
        },
      });
      testCloudflareEnv.DB = retagDatabase;
      const unsafeRetag = await postWorkspace(
        "updateActivityAllocationRequirements",
        {
          allocationId: "allocation-pa-carryover",
          requirementIds: [ordinaryRequirement.id],
        },
      );
      assert.equal(unsafeRetag.status, 409);
      assert.equal((await unsafeRetag.json()).code, "activity_outside_cycle");
      assert.equal(
        flattenedStatements(retagDatabase).some((statement) =>
          /^INSERT INTO (activities|activity_allocations|activity_requirement_matches) \(/i.test(
            statement.sql,
          ),
        ),
        false,
      );
    },
  );

  await t.test(
    "rechecks portal-carryover proof when a submitted cycle changes before acceptance",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new SQLiteD1Database(DatabaseSync);
      const runtimeSource = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const runtimeModule = await importTypeScriptModule(
        `${runtimeSource}\nexport const __carryoverAcceptanceNonce = "proof-race";`,
      );
      await runtimeModule.initializeDatabase(database);
      testCloudflareEnv.DB = database;

      const carryoverCategoryId =
        "pa-professional-educator-act-48-2026-confirmed-carryover";
      const credentialResponse = await postWorkspace(
        "createCredential",
        {
          ruleSetId:
            "pa-professional-educator-act-48-2026-v1",
          cycleStart: "2026-01-01",
          deadline: "2030-12-31",
          applicabilityChoices: [
            {
              ruleCategoryId: carryoverCategoryId,
              status: "applies",
            },
            {
              ruleCategoryId:
                "pa-professional-educator-act-48-2026-act-126",
              status: "not_applicable",
            },
          ],
        },
      );
      assert.equal(credentialResponse.status, 200);
      const credentialId = (await credentialResponse.json()).id;
      const requirementId = database.raw
        .prepare(
          `SELECT id
           FROM credential_requirements
           WHERE credential_id = ?
             AND rule_category_id = ?`,
        )
        .get(credentialId, carryoverCategoryId).id;

      const checkpoint = await postWorkspace("markSubmitted", {
        credentialId,
        submissionDate: "2030-12-15",
        confirmationNumber: "PERMS-COMPLETE",
        complianceAttested: true,
      });
      assert.equal(checkpoint.status, 200);

      const lateCarryoverWrite = await postWorkspace("addActivity", {
        title: "PERMS-posted carryover after checkpoint",
        provider: "PERMS",
        completionDate: "2025-12-15",
        totalUnits: 10,
        credentialId,
        requirementIds: [requirementId],
        evidenceStatus: "missing",
        portalCarryoverAttested: true,
      });
      assert.equal(lateCarryoverWrite.status, 200);

      const acceptance = await postWorkspace(
        "markRenewalAccepted",
        {
          credentialId,
          acceptedAt: "2030-12-16",
          nextCycleStart: "2031-01-01",
          nextDeadline: "2035-12-31",
          officialDatesAttested: true,
        },
      );
      assert.equal(acceptance.status, 409);
      assert.equal(
        (await acceptance.json()).code,
        "portal_carryover_evidence_required",
      );
      assert.deepEqual(
        {
          ...database.raw
            .prepare(
              `SELECT status FROM credentials WHERE id = ?`,
            )
            .get(credentialId),
        },
        { status: "submitted" },
      );
      assert.equal(
        database.raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM renewal_acceptances
             WHERE credential_id = ?`,
          )
          .get(credentialId).count,
        0,
      );
      database.close();
    },
  );

  await t.test(
    "enforces NREMT level-specific transition deadlines",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const runtimeSource = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const runtimeModule = await importTypeScriptModule(
        `${runtimeSource}\nexport const __nremtTransitionNonce = "level-deadlines";`,
      );
      const database = new SQLiteD1Database(DatabaseSync);
      await runtimeModule.initializeDatabase(database);
      testCloudflareEnv.DB = database;

      const ruleSetId = "nremt-emr-nccp-ce-2025-v1";
      const preTransition = await postWorkspace("createCredential", {
        ruleSetId,
        cycleStart: "2023-10-01",
        deadline: "2025-09-30",
        officialDatesAttested: true,
      });
      assert.equal(preTransition.status, 409);
      assert.equal(
        (await preTransition.json()).code,
        "nremt_template_not_applicable",
      );

      const boundary = await postWorkspace("createCredential", {
        ruleSetId,
        cycleStart: "2024-10-01",
        deadline: "2026-09-30",
        officialDatesAttested: true,
      });
      assert.equal(boundary.status, 200);
      const credentialId = (await boundary.json()).id;
      assert.ok(credentialId);

      database.raw
        .prepare(
          `UPDATE credentials
           SET deadline = '2025-09-30'
           WHERE id = ?`,
        )
        .run(credentialId);
      const legacySubmission = await postWorkspace("markSubmitted", {
        credentialId,
        submissionDate: "2025-04-01",
        complianceAttested: true,
      });
      assert.equal(legacySubmission.status, 409);
      assert.equal(
        (await legacySubmission.json()).code,
        "nremt_template_not_applicable",
      );
      database.close();
    },
  );

  await t.test(
    "tracks split NREMT credit, gates filing, and rolls to an attested two-year cycle",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const runtimeSource = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const runtimeModule = await importTypeScriptModule(
        `${runtimeSource}\nexport const __nremtLifecycleNonce = "split-credit";`,
      );
      const database = new SQLiteD1Database(DatabaseSync);
      await runtimeModule.initializeDatabase(database);
      testCloudflareEnv.DB = database;

      const ruleSetId = "nremt-emt-nccp-ce-2025-v1";
      const createPayload = {
        ruleSetId,
        cycleStart: "2026-04-01",
        deadline: "2028-03-31",
      };
      const wrongDeadline = await postWorkspace("createCredential", {
        ...createPayload,
        deadline: "2028-04-01",
        officialDatesAttested: true,
      });
      assert.equal(wrongDeadline.status, 409);
      assert.equal(
        (await wrongDeadline.json()).code,
        "nremt_fixed_deadline_required",
      );
      const preTransition = await postWorkspace("createCredential", {
        ...createPayload,
        deadline: "2025-03-31",
        officialDatesAttested: true,
      });
      assert.equal(preTransition.status, 409);
      assert.equal(
        (await preTransition.json()).code,
        "nremt_template_not_applicable",
      );
      const unattestedDates = await postWorkspace(
        "createCredential",
        createPayload,
      );
      assert.equal(unattestedDates.status, 409);
      assert.equal(
        (await unattestedDates.json()).code,
        "nremt_model_dates_attestation_required",
      );

      const credentialResponse = await postWorkspace("createCredential", {
        ...createPayload,
        officialDatesAttested: true,
      });
      assert.equal(credentialResponse.status, 200);
      const credentialId = (await credentialResponse.json()).id;
      assert.ok(credentialId);

      const workspaceResponse = await fetchWorker(
        "https://license-lantern.example/api/workspace",
        { headers: authHeaders() },
      );
      assert.equal(workspaceResponse.status, 200);
      const workspace = await workspaceResponse.json();
      const credential = workspace.credentials.find(
        (item) => item.id === credentialId,
      );
      assert.ok(credential);
      assert.equal(credential.requirements.length, 9);
      const requirementId = (categoryId) =>
        credential.requirements.find(
          (requirement) => requirement.ruleCategoryId === categoryId,
        )?.id;
      const match = (categorySuffix, matchedUnits) => {
        const id = requirementId(`nremt-emt-nccp-ce-2025-${categorySuffix}`);
        assert.ok(id, `missing NREMT category ${categorySuffix}`);
        return { requirementId: id, matchedUnits };
      };
      const validMatches = [
        match("national", 20),
        match("national-airway", 4),
        match("national-cardiology", 5),
        match("national-trauma", 3),
        match("national-medical", 6),
        match("national-operations", 2),
        match("national-pediatric", 2),
        match("local", 10),
        match("individual", 10),
      ];
      const activityPayload = {
        title: "Integrated NCCP course",
        provider: "CAPCE Provider",
        completionDate: "2027-10-01",
        totalUnits: 40,
        credentialId,
        evidenceStatus: "missing",
        requirementMatches: validMatches,
      };

      const legacyUnclassified = await postWorkspace("addActivity", {
        ...activityPayload,
        requirementMatches: undefined,
        requirementIds: validMatches.map((item) => item.requirementId),
        acceptedEducationAttested: true,
      });
      assert.equal(legacyUnclassified.status, 409);
      assert.equal(
        (await legacyUnclassified.json()).code,
        "nremt_requirement_amounts_required",
      );
      const missingProvider = await postWorkspace("addActivity", {
        ...activityPayload,
        provider: "",
        acceptedEducationAttested: true,
      });
      assert.equal(missingProvider.status, 409);
      assert.equal(
        (await missingProvider.json()).code,
        "nremt_provider_required",
      );
      const unattestedEducation = await postWorkspace(
        "addActivity",
        activityPayload,
      );
      assert.equal(unattestedEducation.status, 409);
      assert.equal(
        (await unattestedEducation.json()).code,
        "nremt_accepted_education_attestation_required",
      );
      const componentMismatch = await postWorkspace("addActivity", {
        ...activityPayload,
        requirementMatches: validMatches.map((item) =>
          item.requirementId === requirementId(
            "nremt-emt-nccp-ce-2025-individual",
          )
            ? { ...item, matchedUnits: 9 }
            : item,
        ),
        acceptedEducationAttested: true,
      });
      assert.equal(componentMismatch.status, 409);
      assert.equal(
        (await componentMismatch.json()).code,
        "nremt_component_amount_mismatch",
      );
      const topicMismatch = await postWorkspace("addActivity", {
        ...activityPayload,
        requirementMatches: validMatches.map((item) =>
          item.requirementId === requirementId(
            "nremt-emt-nccp-ce-2025-national-airway",
          )
            ? { ...item, matchedUnits: 3 }
            : item,
        ),
        acceptedEducationAttested: true,
      });
      assert.equal(topicMismatch.status, 409);
      assert.equal(
        (await topicMismatch.json()).code,
        "nremt_national_topic_amount_mismatch",
      );
      const pediatricExcess = await postWorkspace("addActivity", {
        ...activityPayload,
        requirementMatches: validMatches.map((item) =>
          item.requirementId === requirementId(
            "nremt-emt-nccp-ce-2025-national-pediatric",
          )
            ? { ...item, matchedUnits: 21 }
            : item,
        ),
        acceptedEducationAttested: true,
      });
      assert.equal(pediatricExcess.status, 409);
      assert.equal(
        (await pediatricExcess.json()).code,
        "nremt_pediatric_amount_exceeds_national",
      );

      const activityResponse = await postWorkspace("addActivity", {
        ...activityPayload,
        acceptedEducationAttested: true,
      });
      assert.equal(activityResponse.status, 200);
      const activityId = (await activityResponse.json()).id;
      assert.ok(activityId);
      const raw = database.raw;
      const persistedMatches = Object.fromEntries(
        raw
          .prepare(
            `SELECT
               requirement.rule_category_id AS categoryId,
               match.matched_units AS matchedUnits
             FROM activity_requirement_matches match
             JOIN credential_requirements requirement
               ON requirement.id = match.requirement_id
             WHERE requirement.credential_id = ?`,
          )
          .all(credentialId)
          .map((row) => [row.categoryId, row.matchedUnits]),
      );
      assert.deepEqual(persistedMatches, {
        "nremt-emt-nccp-ce-2025-national": 20,
        "nremt-emt-nccp-ce-2025-national-airway": 4,
        "nremt-emt-nccp-ce-2025-national-cardiology": 5,
        "nremt-emt-nccp-ce-2025-national-trauma": 3,
        "nremt-emt-nccp-ce-2025-national-medical": 6,
        "nremt-emt-nccp-ce-2025-national-operations": 2,
        "nremt-emt-nccp-ce-2025-national-pediatric": 2,
        "nremt-emt-nccp-ce-2025-local": 10,
        "nremt-emt-nccp-ce-2025-individual": 10,
      });

      const unattestedSubmission = await postWorkspace("markSubmitted", {
        credentialId,
        submissionDate: "2027-10-02",
        confirmationNumber: "NREMT-0042",
      });
      assert.equal(unattestedSubmission.status, 409);
      assert.equal(
        (await unattestedSubmission.json()).code,
        "nremt_submission_attestation_required",
      );
      const beforeWindow = await postWorkspace("markSubmitted", {
        credentialId,
        submissionDate: "2027-09-30",
        complianceAttested: true,
      });
      assert.equal(beforeWindow.status, 409);
      assert.equal(
        (await beforeWindow.json()).code,
        "nremt_submission_window_not_open",
      );
      const unattestedLate = await postWorkspace("markSubmitted", {
        credentialId,
        submissionDate: "2028-04-01",
        complianceAttested: true,
      });
      assert.equal(unattestedLate.status, 409);
      assert.equal(
        (await unattestedLate.json()).code,
        "nremt_late_reinstatement_attestation_required",
      );
      const afterReinstatement = await postWorkspace("markSubmitted", {
        credentialId,
        submissionDate: "2028-05-01",
        complianceAttested: true,
        lateReinstatementAttested: true,
      });
      assert.equal(afterReinstatement.status, 409);
      assert.equal(
        (await afterReinstatement.json()).code,
        "nremt_reinstatement_window_closed",
      );
      const submission = await postWorkspace("markSubmitted", {
        credentialId,
        submissionDate: "2027-10-02",
        confirmationNumber: "NREMT-0042",
        complianceAttested: true,
      });
      assert.equal(submission.status, 200);
      assert.equal(
        raw
          .prepare(
            `SELECT attestation_kind AS attestationKind
             FROM renewal_submissions
             WHERE credential_id = ?`,
          )
          .get(credentialId).attestationKind,
        "nremt_requirements_satisfied",
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM xp_events
             WHERE event_type = 'renewal_submitted'
               AND related_id IN (
                 SELECT id FROM renewal_submissions WHERE credential_id = ?
               )`,
          )
          .get(credentialId).count,
        1,
      );

      const acceptancePayload = {
        credentialId,
        acceptedAt: "2027-10-03",
        reference: "NREMT-DASHBOARD-APPROVED",
        nextCycleStart: "2027-10-04",
        nextDeadline: "2030-03-31",
        nextRuleSetId: ruleSetId,
      };
      const unattestedAcceptance = await postWorkspace(
        "markRenewalAccepted",
        acceptancePayload,
      );
      assert.equal(unattestedAcceptance.status, 409);
      assert.equal(
        (await unattestedAcceptance.json()).code,
        "official_next_period_attestation_required",
      );
      const wrongNextDeadline = await postWorkspace(
        "markRenewalAccepted",
        {
          ...acceptancePayload,
          nextDeadline: "2029-03-31",
          officialDatesAttested: true,
        },
      );
      assert.equal(wrongNextDeadline.status, 409);
      assert.equal(
        (await wrongNextDeadline.json()).code,
        "nremt_next_deadline_invalid",
      );

      const batchBeforeArchiveRace = database.batch.bind(database);
      let archiveRaceInjected = false;
      database.batch = async (statements) => {
        if (
          !archiveRaceInjected &&
          statements.some((statement) =>
            /UPDATE credentials SET status = 'renewed'/i.test(
              normalizedSql(statement.sql),
            ),
          )
        ) {
          raw
            .prepare(
              `UPDATE activities
               SET
                 archived_at = CURRENT_TIMESTAMP,
                 revision = revision + 1
               WHERE id = ?`,
            )
            .run(activityId);
          archiveRaceInjected = true;
        }
        return batchBeforeArchiveRace(statements);
      };
      const racedAcceptance = await postWorkspace(
        "markRenewalAccepted",
        {
          ...acceptancePayload,
          officialDatesAttested: true,
        },
      );
      database.batch = batchBeforeArchiveRace;
      assert.equal(archiveRaceInjected, true);
      assert.equal(racedAcceptance.status, 409);
      assert.equal(
        (await racedAcceptance.json()).code,
        "acceptance_activity_state_changed",
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT status
               FROM credentials
               WHERE id = ?`,
            )
            .get(credentialId),
        },
        { status: "submitted" },
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM renewal_acceptances
             WHERE credential_id = ?`,
          )
          .get(credentialId).count,
        0,
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM credentials
             WHERE user_id = ?`,
          )
          .get(await expectedStableUserId("owner@example.com")).count,
        1,
      );
      const archivedActivity = raw
        .prepare(
          `SELECT
             revision,
             archived_at AS archivedAt
           FROM activities
           WHERE id = ?`,
        )
        .get(activityId);
      assert.ok(archivedActivity.archivedAt);
      const restoreResponse = await postWorkspace("restoreActivity", {
        activityId,
        expectedRevision: Number(archivedActivity.revision),
      });
      assert.equal(restoreResponse.status, 200);
      assert.equal(
        raw
          .prepare(
            `SELECT archived_at AS archivedAt
             FROM activities
             WHERE id = ?`,
          )
          .get(activityId).archivedAt,
        null,
      );

      const acceptancePreparedStatements = [];
      const prepareBeforeAcceptance = database.prepare.bind(database);
      database.prepare = (sql) => {
        const statement = prepareBeforeAcceptance(sql);
        const bindBeforeAcceptance = statement.bind.bind(statement);
        statement.bind = (...bindings) => {
          acceptancePreparedStatements.push({
            sql: normalizedSql(sql),
            bindingCount: bindings.length,
          });
          return bindBeforeAcceptance(...bindings);
        };
        return statement;
      };
      const acceptance = await postWorkspace("markRenewalAccepted", {
        ...acceptancePayload,
        officialDatesAttested: true,
      });
      database.prepare = prepareBeforeAcceptance;
      assert.equal(acceptance.status, 200);
      const catalogGuardStatement = acceptancePreparedStatements.find(
        (statement) =>
          /UPDATE credentials SET status = 'renewed'/i.test(statement.sql),
      );
      assert.ok(catalogGuardStatement);
      assert.match(
        catalogGuardStatement.sql,
        /json_each\(\?\) snapshot_category/i,
      );
      const maximumBindingCount = Math.max(
        ...acceptancePreparedStatements.map(
          (statement) => statement.bindingCount,
        ),
      );
      assert.ok(
        maximumBindingCount <= 100,
        `markRenewalAccepted prepared a statement with ${maximumBindingCount} bindings; D1 allows at most 100`,
      );
      const nextCredentialId = (await acceptance.json()).id;
      assert.ok(nextCredentialId);
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 status,
                 rule_set_id AS ruleSetId,
                 cycle_start AS cycleStart,
                 deadline
               FROM credentials
               WHERE id = ?`,
            )
            .get(nextCredentialId),
        },
        {
          status: "active",
          ruleSetId,
          cycleStart: "2027-10-04",
          deadline: "2030-03-31",
        },
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM credential_requirements
             WHERE credential_id = ?`,
          )
          .get(nextCredentialId).count,
        9,
      );
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM activity_allocations
             WHERE credential_id = ?`,
          )
          .get(nextCredentialId).count,
        0,
      );
      assert.equal(
        raw
          .prepare(`SELECT status FROM credentials WHERE id = ?`)
          .get(credentialId).status,
        "renewed",
      );
      database.close();
    },
  );

  await t.test(
    "records a submission without fabricating a learning activity",
    async () => {
      let submissionLookupCount = 0;
      const database = new FakeDatabase({
        resolveFirst(call) {
          if (
            /SELECT id, status, rule_set_id AS ruleSetId FROM credentials WHERE id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return {
              id: call.bindings[0],
              status: "active",
              ruleSetId: null,
            };
          }
          if (/FROM renewal_submissions WHERE credential_id = \? AND user_id = \?/i.test(call.sql)) {
            submissionLookupCount += 1;
            return submissionLookupCount === 1
              ? null
              : { id: "submission-concurrent-winner" };
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
      assert.equal(result.id, "submission-concurrent-winner");

      const statements = flattenedStatements(database);
      const submissionInsert = statements.find((statement) =>
        /^INSERT INTO renewal_submissions \(/i.test(statement.sql),
      );
      const credentialUpdate = statements.find((statement) =>
        /^UPDATE credentials SET status = 'submitted'/i.test(statement.sql),
      );
      assert.ok(submissionInsert);
      assert.ok(credentialUpdate);
      assert.deepEqual(submissionInsert.bindings.slice(1), [
        "2028-02-20",
        "CONF-2028-0042",
        "CONF-2028-0042",
        null,
        "credential-owner",
        await expectedStableUserId("owner@example.com"),
      ]);
      assert.deepEqual(credentialUpdate.bindings, [
        "credential-owner",
        await expectedStableUserId("owner@example.com"),
      ]);
      assert.match(
        credentialUpdate.sql,
        /status IN \('active', 'submitted'\)/i,
      );
      assert.equal(
        statements.some((statement) =>
          /^INSERT INTO activities \(/i.test(statement.sql),
        ),
        false,
      );
      const progressionEvent = statements.find((statement) =>
        /^INSERT OR IGNORE INTO xp_events \(/i.test(statement.sql),
      );
      const filingBadge = statements.find((statement) =>
        /^INSERT OR IGNORE INTO badge_events \(/i.test(statement.sql),
      );
      assert.match(
        progressionEvent?.sql ?? "",
        /persisted_submission\.id[\s\S]*?JOIN renewal_submissions persisted_submission/i,
      );
      assert.match(
        filingBadge?.sql ?? "",
        /persisted_submission\.id[\s\S]*?JOIN renewal_submissions persisted_submission/i,
      );
    },
  );

  await t.test(
    "keeps a retired ISC2 rule on the attested checkpoint path without claiming a filed renewal",
    async () => {
      let submissionLookupCount = 0;
      const database = new FakeDatabase({
        resolveFirst(call) {
          if (
            /SELECT id, status, rule_set_id AS ruleSetId FROM credentials WHERE id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return {
              id: call.bindings[0],
              status: "active",
              ruleSetId: "isc2-retired-regression-2024-v1",
            };
          }
          if (
            /FROM renewal_submissions WHERE credential_id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            submissionLookupCount += 1;
            return submissionLookupCount === 1
              ? null
              : { id: "submission-isc2-winner" };
          }
          return null;
        },
      });
      testCloudflareEnv.DB = database;

      const unattestedResponse = await postWorkspace("markSubmitted", {
        credentialId: "credential-isc2-owner",
        submissionDate: "2028-02-20",
        confirmationNumber: "ISC2-DASHBOARD-0042",
      });
      assert.equal(unattestedResponse.status, 409);
      assert.equal(
        (await unattestedResponse.json()).code,
        "isc2_checkpoint_attestation_required",
      );
      assert.equal(
        flattenedStatements(database).some((statement) =>
          /^(?:UPDATE credentials SET status = 'submitted'|INSERT INTO renewal_submissions|INSERT OR IGNORE INTO xp_events|INSERT OR IGNORE INTO badge_events)/i.test(
            statement.sql.trim(),
          ),
        ),
        false,
      );

      const attestedResponse = await postWorkspace("markSubmitted", {
        credentialId: "credential-isc2-owner",
        submissionDate: "2028-02-20",
        confirmationNumber: "ISC2-DASHBOARD-0042",
        complianceAttested: true,
      });
      assert.equal(attestedResponse.status, 200);
      assert.equal((await attestedResponse.json()).action, "markSubmitted");

      const statements = flattenedStatements(database);
      const checkpointXp = statements.find((statement) =>
        /^INSERT OR IGNORE INTO xp_events \(/i.test(statement.sql),
      );
      assert.ok(checkpointXp);
      assert.ok(checkpointXp.bindings.includes("renewal_checkpoint_recorded"));
      assert.ok(checkpointXp.bindings.includes("renewal_checkpoint"));
      assert.equal(
        statements.some((statement) =>
          statement.bindings.includes("renewal_submitted"),
        ),
        false,
      );
      assert.equal(
        statements.some((statement) =>
          /^INSERT OR IGNORE INTO badge_events \(/i.test(statement.sql),
        ),
        false,
      );
    },
  );

  await t.test(
    "records a compliance-period checkpoint without awarding a filed-renewal badge",
    async () => {
      let submissionLookupCount = 0;
      const database = new FakeDatabase({
        resolveFirst(call) {
          if (
            /SELECT id, status, rule_set_id AS ruleSetId FROM credentials WHERE id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return {
              id: call.bindings[0],
              status: "active",
              ruleSetId:
                "fl-insurance-producer-life-under-6-years-2026-v1",
            };
          }
          if (
            /FROM renewal_submissions WHERE credential_id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            submissionLookupCount += 1;
            return submissionLookupCount === 1
              ? null
              : { id: "submission-compliance-winner" };
          }
          return null;
        },
      });
      testCloudflareEnv.DB = database;

      const response = await postWorkspace("markSubmitted", {
        credentialId: "credential-compliance-owner",
        submissionDate: "2028-02-20",
        confirmationNumber: "MYPROFILE-0042",
        complianceAttested: true,
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).action, "markSubmitted");

      const statements = flattenedStatements(database);
      const checkpointXp = statements.find((statement) =>
        /^INSERT OR IGNORE INTO xp_events \(/i.test(statement.sql),
      );
      assert.ok(checkpointXp);
      assert.ok(
        checkpointXp.bindings.includes("compliance_checkpoint_recorded"),
      );
      assert.ok(checkpointXp.bindings.includes("compliance_checkpoint"));
      const checkpointInsert = statements.find((statement) =>
        /^INSERT INTO renewal_submissions \(/i.test(statement.sql),
      );
      assert.ok(checkpointInsert);
      assert.ok(
        checkpointInsert.bindings.includes("compliance_period_complete"),
      );
      assert.equal(
        statements.some((statement) =>
          statement.bindings.includes("renewal_submitted"),
        ),
        false,
      );
      assert.equal(
        statements.some((statement) =>
          /^INSERT OR IGNORE INTO badge_events \(/i.test(statement.sql),
        ),
        false,
      );
    },
  );

  await t.test(
    "treats educator registration and employment cycles as attested compliance periods",
    async () => {
      for (const [ruleSetId, credentialId] of [
        [
          "ny-professional-classroom-teacher-standard-ctle-2026-v1",
          "credential-ny-classroom-ctle",
        ],
        [
          "ny-professional-esol-bilingual-ctle-2026-v1",
          "credential-ny-esol-ctle",
        ],
        [
          "nj-employed-teacher-annual-pd-2026-v1",
          "credential-nj-teacher-pdp",
        ],
        [
          "pa-professional-educator-act-48-2026-v1",
          "credential-pa-act-48",
        ],
      ]) {
        let complianceSubmissionLookupCount = 0;
        const database = new FakeDatabase({
          resolveFirst(call) {
            if (
              /SELECT id, status, rule_set_id AS ruleSetId FROM credentials WHERE id = \? AND user_id = \?/i.test(
                call.sql,
              )
            ) {
              return {
                id: call.bindings[0],
                status: "active",
                ruleSetId,
              };
            }
            if (
              /FROM renewal_submissions WHERE credential_id = \? AND user_id = \?/i.test(
                call.sql,
              )
            ) {
              complianceSubmissionLookupCount += 1;
              return complianceSubmissionLookupCount === 1
                ? null
                : { id: `submission-${credentialId}` };
            }
            return null;
          },
        });
        testCloudflareEnv.DB = database;

        const unattested = await postWorkspace("markSubmitted", {
          credentialId,
          submissionDate: "2028-02-20",
          confirmationNumber: "OFFICIAL-COMPLIANCE-0042",
        });
        assert.equal(unattested.status, 409);
        assert.equal(
          (await unattested.json()).code,
          "compliance_checkpoint_attestation_required",
        );

        const attested = await postWorkspace("markSubmitted", {
          credentialId,
          submissionDate: "2028-02-20",
          confirmationNumber: "OFFICIAL-COMPLIANCE-0042",
          complianceAttested: true,
        });
        assert.equal(attested.status, 200);
        const statements = flattenedStatements(database);
        assert.ok(
          statements.some((statement) =>
            statement.bindings.includes("compliance_period_complete"),
          ),
        );
        assert.ok(
          statements.some((statement) =>
            statement.bindings.includes("compliance_checkpoint_recorded"),
          ),
        );
        assert.equal(
          statements.some((statement) =>
            statement.bindings.includes("renewal_submitted"),
          ),
          false,
        );
        assert.equal(
          statements.some((statement) =>
            /^INSERT OR IGNORE INTO badge_events \(/i.test(statement.sql),
          ),
          false,
        );
      }
    },
  );

  await t.test(
    "rolls both New York CTLE compliance variants with official dates and TEACH tasks",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new SQLiteD1Database(DatabaseSync);
      const runtimeSource = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const runtimeModule = await importTypeScriptModule(
        `${runtimeSource}\nexport const __nyCtleAcceptanceNonce = "teach";`,
      );
      await runtimeModule.initializeDatabase(database);
      testCloudflareEnv.DB = database;

      for (const ruleSetId of [
        "ny-professional-classroom-teacher-standard-ctle-2026-v1",
        "ny-professional-esol-bilingual-ctle-2026-v1",
      ]) {
        const createResponse = await postWorkspace(
          "createCredential",
          {
            ruleSetId,
            cycleStart: "2026-01-01",
            deadline: "2030-12-31",
          },
        );
        assert.equal(createResponse.status, 200);
        const credentialId = (await createResponse.json()).id;
        const checkpoint = await postWorkspace("markSubmitted", {
          credentialId,
          submissionDate: "2030-12-15",
          confirmationNumber: "TEACH-COMPLETE",
          complianceAttested: true,
        });
        assert.equal(checkpoint.status, 200);

        const unattested = await postWorkspace(
          "markRenewalAccepted",
          {
            credentialId,
            acceptedAt: "2030-12-16",
            nextCycleStart: "2031-01-01",
            nextDeadline: "2035-12-31",
          },
        );
        assert.equal(unattested.status, 409);
        assert.equal(
          (await unattested.json()).code,
          "official_next_period_attestation_required",
        );

        const overlapping = await postWorkspace(
          "markRenewalAccepted",
          {
            credentialId,
            acceptedAt: "2030-12-16",
            nextCycleStart: "2030-12-31",
            nextDeadline: "2035-12-31",
            officialDatesAttested: true,
          },
        );
        assert.equal(overlapping.status, 409);
        assert.equal(
          (await overlapping.json()).code,
          "next_cycle_overlaps_current_period",
        );

        const accepted = await postWorkspace(
          "markRenewalAccepted",
          {
            credentialId,
            acceptedAt: "2030-12-16",
            nextCycleStart: "2031-01-01",
            nextDeadline: "2035-12-31",
            officialDatesAttested: true,
          },
        );
        assert.equal(accepted.status, 200);
        const nextCredentialId = (await accepted.json()).id;
        assert.deepEqual(
          database.raw
            .prepare(
              `SELECT title
               FROM checklist_tasks
               WHERE credential_id = ?
               ORDER BY sort_order`,
            )
            .all(nextCredentialId)
            .map((row) => row.title),
          [
            "Confirm TEACH registration dates, practiced years, and any language-acquisition waiver",
            "Complete sponsor-approved CTLE and the applicable language-acquisition hours",
            "Attest and re-register in TEACH, then save the official CTLE record",
          ],
        );
        assert.deepEqual(
          {
            ...database.raw
              .prepare(
                `SELECT
                   event.event_type AS eventType,
                   event.related_type AS relatedType
                 FROM xp_events event
                 JOIN renewal_acceptances acceptance
                   ON acceptance.id = event.related_id
                 WHERE acceptance.credential_id = ?
                   AND event.related_type = 'compliance_completion'`,
              )
              .get(credentialId),
          },
          {
            eventType: "compliance_period_completed",
            relatedType: "compliance_completion",
          },
        );
        assert.ok(
          database.raw
            .prepare(
              `SELECT official_record_attested_at AS attestedAt
               FROM renewal_acceptances
               WHERE credential_id = ?`,
            )
            .get(credentialId).attestedAt,
        );
      }
      database.close();
    },
  );

  await t.test(
    "blocks a retired ISC2 cycle from closing without official dates or before cycle end",
    async () => {
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
            /FROM credentials credential\s+LEFT JOIN credential_cycle_links cycle/i.test(
              call.sql,
            )
          ) {
            return {
              id: "credential-isc2-submitted",
              ruleSetId: "isc2-retired-regression-2024-v1",
              credentialName: "Retired ISC2 regression credential",
              profession: "Cybersecurity",
              jurisdiction: "Global",
              issuer: "ISC2",
              status: "submitted",
              deadline: "2028-03-01",
              totalRequired: 120,
              unitLabel: "CPE credits",
              seriesId: "series-isc2",
              cycleMonths: 36,
            };
          }
          if (
            /FROM renewal_submissions WHERE credential_id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return {
              id: "submission-isc2",
              submittedAt: "2028-02-20T12:00:00.000Z",
            };
          }
          return null;
        },
      });
      testCloudflareEnv.DB = database;
      const payload = {
        credentialId: "credential-isc2-submitted",
        acceptedAt: "2028-02-25",
        reference: "ISC2-DASHBOARD-RENEWED",
        nextCycleStart: "2028-03-02",
        nextDeadline: "2031-03-01",
      };

      const unattested = await postWorkspace(
        "markRenewalAccepted",
        payload,
      );
      assert.equal(unattested.status, 409);
      assert.equal(
        (await unattested.json()).code,
        "official_next_period_attestation_required",
      );

      const beforeCycleEnd = await postWorkspace(
        "markRenewalAccepted",
        {
          ...payload,
          officialDatesAttested: true,
        },
      );
      assert.equal(beforeCycleEnd.status, 409);
      assert.equal(
        (await beforeCycleEnd.json()).code,
        "isc2_renewal_before_cycle_end",
      );
      const overlappingNextCycle = await postWorkspace(
        "markRenewalAccepted",
        {
          ...payload,
          acceptedAt: "2028-03-02",
          nextCycleStart: "2028-03-01",
          officialDatesAttested: true,
        },
      );
      assert.equal(overlappingNextCycle.status, 409);
      assert.equal(
        (await overlappingNextCycle.json()).code,
        "next_cycle_overlaps_current_period",
      );
      assert.equal(
        flattenedStatements(database).some((statement) =>
          /UPDATE credentials[\s\S]*?SET status = 'renewed'|INSERT INTO renewal_acceptances/i.test(
            statement.sql,
          ),
        ),
        false,
      );
    },
  );

  await t.test(
    "requires official non-overlapping pharmacist renewal dates and opens a state-specific next checklist",
    async () => {
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
            /FROM credentials credential\s+LEFT JOIN credential_cycle_links cycle/i.test(
              call.sql,
            )
          ) {
            return {
              id: "credential-nj-pharmacist-submitted",
              ruleSetId: "nj-pharmacist-2025-v0",
              credentialName:
                "Pharmacist — established full biennial renewal",
              profession: "Pharmacy",
              jurisdiction: "New Jersey",
              issuer: "New Jersey Board of Pharmacy",
              status: "submitted",
              deadline: "2028-06-30",
              totalRequired: 30,
              unitLabel: "CE credits",
              seriesId: "series-nj-pharmacist",
              cycleMonths: 24,
            };
          }
          if (
            /FROM renewal_submissions WHERE credential_id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return {
              id: "submission-nj-pharmacist",
              submittedAt: "2028-06-20T12:00:00.000Z",
            };
          }
          if (
            /FROM rule_sets prior_rule\s+JOIN rule_sets current_rule/i.test(
              call.sql,
            )
          ) {
            assert.equal(call.bindings[0], "nj-pharmacist-2025-v0");
            return {
              id: "nj-pharmacist-2026-v1",
              credentialName:
                "Pharmacist — established full biennial renewal",
              profession: "Pharmacy",
              jurisdiction: "New Jersey",
              issuer: "New Jersey Board of Pharmacy",
              totalUnits: 30,
              unitLabel: "CE credits",
              cycleMonths: 24,
            };
          }
          return null;
        },
        resolveAll(call) {
          if (/FROM rule_categories WHERE rule_set_id = \?/i.test(call.sql)) {
            assert.equal(call.bindings[0], "nj-pharmacist-2026-v1");
            return [
              {
                id: "nj-pharmacist-2026-confirmed-carryover",
                name: "Board-Eligible Confirmed Carryover",
                requiredUnits: 10,
                kind: "maximum",
                relation: "independent",
                parentCategoryId: null,
                applicability: "conditional",
                conditionNote:
                  "Use only after the Board confirms the credit is eligible.",
                exclusiveGroup: "New Jersey pharmacist period source",
                sortOrder: 0,
              },
            ];
          }
          return [];
        },
      });
      testCloudflareEnv.DB = database;
      const payload = {
        credentialId: "credential-nj-pharmacist-submitted",
        acceptedAt: "2028-07-01",
        reference: "NJ-BOP-RENEWED-0042",
        nextCycleStart: "2028-07-01",
        nextDeadline: "2030-06-30",
      };

      const unattested = await postWorkspace(
        "markRenewalAccepted",
        payload,
      );
      assert.equal(unattested.status, 409);
      assert.equal(
        (await unattested.json()).code,
        "official_next_period_attestation_required",
      );

      const eligibilityUnattested = await postWorkspace(
        "markRenewalAccepted",
        {
          ...payload,
          officialDatesAttested: true,
        },
      );
      assert.equal(eligibilityUnattested.status, 409);
      assert.equal(
        (await eligibilityUnattested.json()).code,
        "pharmacist_next_template_eligibility_required",
      );

      const overlapping = await postWorkspace(
        "markRenewalAccepted",
        {
          ...payload,
          nextCycleStart: "2028-06-30",
          officialDatesAttested: true,
          templateEligibilityAttested: true,
        },
      );
      assert.equal(overlapping.status, 409);
      assert.equal(
        (await overlapping.json()).code,
        "next_cycle_overlaps_current_period",
      );

      const shortened = await postWorkspace(
        "markRenewalAccepted",
        {
          ...payload,
          nextDeadline: "2030-06-20",
          officialDatesAttested: true,
          templateEligibilityAttested: true,
        },
      );
      assert.equal(shortened.status, 409);
      assert.equal(
        (await shortened.json()).code,
        "pharmacist_next_cycle_dates_required",
      );

      const accepted = await postWorkspace(
        "markRenewalAccepted",
        {
          ...payload,
          officialDatesAttested: true,
          templateEligibilityAttested: true,
        },
      );
      assert.equal(accepted.status, 200);
      const statements = flattenedStatements(database);
      const nextCredential = statements.find((statement) =>
        /^INSERT INTO credentials \(/i.test(statement.sql),
      );
      assert.ok(nextCredential);
      assert.equal(nextCredential.bindings[2], "nj-pharmacist-2026-v1");
      assert.equal(nextCredential.bindings[7], "2028-07-01");
      assert.equal(nextCredential.bindings[8], "2030-06-30");
      const carryoverRequirement = statements.find(
        (statement) =>
          /^INSERT INTO credential_requirements \(/i.test(statement.sql) &&
          statement.bindings[1] ===
            "nj-pharmacist-2026-confirmed-carryover",
      );
      assert.ok(carryoverRequirement);
      assert.equal(carryoverRequirement.bindings[8], "needs_confirmation");
      assert.equal(carryoverRequirement.bindings[11], 0);
      assert.ok(
        statements.some(
          (statement) =>
            /^INSERT INTO checklist_tasks \(/i.test(statement.sql) &&
            statement.bindings[1] ===
              "Confirm Board-eligible New Jersey pharmacist carryover, then record only evidence-backed credit",
        ),
      );
      assert.ok(
        statements.some(
          (statement) =>
            /^INSERT INTO checklist_tasks \(/i.test(statement.sql) &&
            statement.bindings[1] ===
              "Complete 30 credits and classify every activity by delivery mode and period source",
        ),
      );

      class RacingPharmacistDatabase extends FakeDatabase {
        async batch(statementsToRun) {
          if (
            statementsToRun.some((statement) =>
              /UPDATE credentials SET status = 'renewed'/i.test(
                normalizedSql(statement.sql),
              ),
            )
          ) {
            throw new Error("simulated pharmacist catalog race");
          }
          return super.batch(statementsToRun);
        }
      }
      const racingDatabase = new RacingPharmacistDatabase({
        resolveFirst: database.resolveFirst,
        resolveAll: database.resolveAll,
      });
      testCloudflareEnv.DB = racingDatabase;
      const raced = await postWorkspace("markRenewalAccepted", {
        ...payload,
        officialDatesAttested: true,
        templateEligibilityAttested: true,
      });
      assert.equal(raced.status, 409);
      assert.equal(
        (await raced.json()).code,
        "pharmacist_current_template_changed",
      );
    },
  );

  await t.test(
    "reports a nursing-specific conflict when the managed catalog changes during rollover",
    async () => {
      const resolver = {
        resolveFirst(call) {
          if (
            /SELECT next_credential_id AS nextCredentialId FROM renewal_acceptances/i.test(
              call.sql,
            )
          ) {
            return null;
          }
          if (
            /FROM credentials credential\s+LEFT JOIN credential_cycle_links cycle/i.test(
              call.sql,
            )
          ) {
            return {
              id: "credential-tx-rn-submitted-race",
              ruleSetId: "tx-rn-2026-v1",
              credentialName: "Registered Nurse — standard 20-hour CNE path",
              profession: "Nursing",
              jurisdiction: "Texas",
              issuer: "Texas Board of Nursing",
              status: "submitted",
              deadline: "2028-08-31",
              totalRequired: 20,
              unitLabel: "CNE contact hours",
              seriesId: "series-tx-rn-race",
              cycleMonths: 24,
            };
          }
          if (
            /FROM renewal_submissions WHERE credential_id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return {
              id: "submission-tx-rn-race",
              submittedAt: "2028-08-20T12:00:00.000Z",
            };
          }
          if (
            /FROM rule_sets prior_rule\s+JOIN rule_sets current_rule/i.test(
              call.sql,
            )
          ) {
            return {
              id: "tx-rn-2026-v1",
              credentialName: "Registered Nurse — standard 20-hour CNE path",
              profession: "Nursing",
              jurisdiction: "Texas",
              issuer: "Texas Board of Nursing",
              totalUnits: 20,
              unitLabel: "CNE contact hours",
              cycleMonths: 24,
            };
          }
          return null;
        },
        resolveAll(call) {
          if (/FROM rule_categories WHERE rule_set_id = \?/i.test(call.sql)) {
            return [];
          }
          return [];
        },
      };
      class RacingNursingDatabase extends FakeDatabase {
        async batch(statementsToRun) {
          if (
            statementsToRun.some((statement) =>
              /UPDATE credentials SET status = 'renewed'/i.test(
                normalizedSql(statement.sql),
              ),
            )
          ) {
            throw new Error("simulated nursing catalog race");
          }
          return super.batch(statementsToRun);
        }
      }
      testCloudflareEnv.DB = new RacingNursingDatabase(resolver);

      const response = await postWorkspace("markRenewalAccepted", {
        credentialId: "credential-tx-rn-submitted-race",
        acceptedAt: "2028-09-01",
        reference: "TX-NURSE-RENEWED-RACE",
        nextCycleStart: "2028-09-01",
        nextDeadline: "2030-08-31",
        officialDatesAttested: true,
        templateEligibilityAttested: true,
      });
      assert.equal(response.status, 409);
      assert.equal(
        (await response.json()).code,
        "nursing_current_template_changed",
      );
    },
  );

  await t.test(
    "requires a current Florida template before opening the next compliance period",
    async () => {
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
            /FROM credentials credential\s+LEFT JOIN credential_cycle_links cycle/i.test(
              call.sql,
            )
          ) {
            return {
              id: "credential-florida-submitted",
              ruleSetId:
                "fl-insurance-producer-life-under-6-years-2026-v1",
              credentialName: "Florida life producer",
              profession: "Insurance",
              jurisdiction: "Florida",
              issuer: "Florida Department of Financial Services",
              status: "submitted",
              deadline: "2028-03-01",
              totalRequired: 24,
              unitLabel: "CE hours",
              seriesId: "series-florida",
              cycleMonths: 24,
            };
          }
          if (
            /FROM renewal_submissions WHERE credential_id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return {
              id: "submission-florida",
              submittedAt: "2028-02-20T12:00:00.000Z",
            };
          }
          return null;
        },
      });
      testCloudflareEnv.DB = database;

      const response = await postWorkspace("markRenewalAccepted", {
        credentialId: "credential-florida-submitted",
        acceptedAt: "2028-03-02",
        reference: "MYPROFILE-COMPLETE",
        nextCycleStart: "2028-03-02",
        nextDeadline: "2030-03-01",
        officialDatesAttested: true,
      });
      assert.equal(response.status, 409);
      assert.equal(
        (await response.json()).code,
        "florida_next_template_required",
      );
    },
  );

  await t.test(
    "rolls back a Florida rollover when the selected catalog snapshot changes before the acceptance batch",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const selectedRuleSetId =
        "fl-insurance-producer-life-under-6-years-2026-v1";
      class RacingFloridaDatabase extends SQLiteD1Database {
        raced = false;
        racedCategory = null;

        async batch(statements) {
          if (
            !this.raced &&
            statements.some((statement) =>
              /UPDATE credentials SET status = 'renewed'/i.test(
                normalizedSql(statement.sql),
              ),
            )
          ) {
            this.racedCategory = this.raw
              .prepare(
                `SELECT id, required_units AS requiredUnits
                 FROM rule_categories
                 WHERE rule_set_id = ?
                 ORDER BY id
                 LIMIT 1`,
              )
              .get(selectedRuleSetId);
            this.raw
              .prepare(
                `UPDATE rule_categories
                 SET required_units = required_units + 1
                 WHERE id = ?`,
              )
              .run(this.racedCategory.id);
            this.raced = true;
          }
          return super.batch(statements);
        }
      }

      const database = new RacingFloridaDatabase(DatabaseSync);
      testCloudflareEnv.DB = database;
      const runtimeSource = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const bootstrapRuntime = await importTypeScriptModule(
        `${runtimeSource}\nexport const __floridaRaceBootstrapNonce = "florida-race";`,
      );
      await bootstrapRuntime.initializeDatabase(database);

      const userId = await expectedStableUserId("owner@example.com");
      database.raw
        .prepare(
          `INSERT INTO users (id, email, display_name)
           VALUES (?, ?, ?)`,
        )
        .run(userId, "owner@example.com", "Casey Owner");
      database.raw
        .prepare(
          `INSERT INTO credentials (
            id, user_id, rule_set_id, credential_name, profession,
            jurisdiction, issuer, cycle_start, deadline, total_required,
            unit_label, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted')`,
        )
        .run(
          "credential-florida-race",
          userId,
          selectedRuleSetId,
          "Florida life producer",
          "Insurance",
          "Florida",
          "Florida Department of Financial Services",
          "2026-03-02",
          "2028-03-01",
          24,
          "CE hours",
        );
      database.raw
        .prepare(
          `INSERT INTO renewal_submissions (
            id, user_id, credential_id, submitted_at,
            confirmation_number, proof_reference, attestation_kind
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "submission-florida-race",
          userId,
          "credential-florida-race",
          "2028-02-20T12:00:00.000Z",
          "MYPROFILE-RACE",
          "MYPROFILE-RACE",
          "compliance_period_complete",
        );
      assert.equal(
        database.raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM credential_cycle_links
             WHERE user_id = ?`,
          )
          .get(userId).count,
        0,
      );

      const response = await postWorkspace("markRenewalAccepted", {
        credentialId: "credential-florida-race",
        acceptedAt: "2028-03-02",
        reference: "MYPROFILE-COMPLETE",
        nextCycleStart: "2028-03-02",
        nextDeadline: "2030-03-01",
        nextRuleSetId: selectedRuleSetId,
        officialDatesAttested: true,
      });
      assert.equal(response.status, 409);
      assert.equal(
        (await response.json()).code,
        "florida_next_template_changed",
      );
      assert.equal(database.raced, true);
      assert.ok(database.racedCategory);
      assert.equal(
        database.raw
          .prepare(
            `SELECT status
             FROM credentials
             WHERE id = 'credential-florida-race'`,
          )
          .get().status,
        "submitted",
      );
      assert.equal(
        database.raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM credentials
             WHERE user_id = ?`,
          )
          .get(userId).count,
        1,
      );
      assert.equal(
        database.raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM renewal_acceptances
             WHERE credential_id = 'credential-florida-race'`,
          )
          .get().count,
        0,
      );
      assert.deepEqual(
        database.raw
          .prepare(
            `SELECT
               credential_id AS credentialId,
               previous_credential_id AS previousCredentialId
             FROM credential_cycle_links
             WHERE user_id = ?
             ORDER BY credential_id`,
          )
          .all(userId)
          .map((row) => ({ ...row })),
        [
          {
            credentialId: "credential-florida-race",
            previousCredentialId: null,
          },
        ],
      );
      database.raw
        .prepare(
          `UPDATE rule_categories
           SET required_units = ?
           WHERE id = ?`,
        )
        .run(
          database.racedCategory.requiredUnits,
          database.racedCategory.id,
        );
      const retryResponse = await postWorkspace("markRenewalAccepted", {
        credentialId: "credential-florida-race",
        acceptedAt: "2028-03-02",
        reference: "MYPROFILE-COMPLETE",
        nextCycleStart: "2028-03-02",
        nextDeadline: "2030-03-01",
        nextRuleSetId: selectedRuleSetId,
        officialDatesAttested: true,
      });
      assert.equal(retryResponse.status, 200);
      const retryResult = await retryResponse.json();
      assert.equal(retryResult.action, "markRenewalAccepted");
      assert.equal(
        database.raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM credential_requirements
             WHERE credential_id = ?`,
          )
          .get(retryResult.id).count,
        database.raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM rule_categories
             WHERE rule_set_id = ?`,
          )
          .get(selectedRuleSetId).count,
      );
      database.close();
    },
  );


  await t.test(
    "rolls a Florida mental-health renewal onto the CE Broker-confirmed phase with fresh conditions",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new SQLiteD1Database(DatabaseSync);
      const runtimeSource = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const runtimeModule = await importTypeScriptModule(
        `${runtimeSource}\nexport const __floridaMentalHealthRolloverNonce = "phase";`,
      );
      await runtimeModule.initializeDatabase(database);
      testCloudflareEnv.DB = database;
      const raw = database.raw;
      const userId = await expectedStableUserId("owner@example.com");
      const credentialId = "credential-fl-mental-health-ethics";
      const currentRuleSetId =
        "fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-v1";
      const nextRuleSetId =
        "fl-lcsw-lmft-lmhc-telehealth-phase-2026-v1";

      const invalidCycle = await postWorkspace("createCredential", {
        ruleSetId: currentRuleSetId,
        cycleStart: "2026-04-01",
        deadline: "2028-03-31",
        officialDatesAttested: true,
      });
      assert.equal(invalidCycle.status, 409);
      assert.equal(
        (await invalidCycle.json()).code,
        "florida_mental_health_cycle_invalid",
      );
      const unattestedCycle = await postWorkspace("createCredential", {
        ruleSetId: currentRuleSetId,
        cycleStart: "2025-04-01",
        deadline: "2027-03-31",
      });
      assert.equal(unattestedCycle.status, 409);
      assert.equal(
        (await unattestedCycle.json()).code,
        "florida_mental_health_dates_attestation_required",
      );

      raw
        .prepare(
          `INSERT OR IGNORE INTO users (id, email, display_name, is_demo)
           VALUES (?, ?, ?, 0)`,
        )
        .run(userId, "owner@example.com", "Owner");
      raw
        .prepare(
          `INSERT INTO credentials (
             id, user_id, rule_set_id, credential_name, profession,
             jurisdiction, issuer, cycle_start, deadline, total_required,
             unit_label, status
           )
           SELECT
             ?, ?, id, credential_name, profession, jurisdiction, issuer,
             '2025-04-01', '2027-03-31', total_units, unit_label,
             'submitted'
           FROM rule_sets
           WHERE id = ?`,
        )
        .run(credentialId, userId, currentRuleSetId);
      raw
        .prepare(
          `INSERT INTO credential_cycle_links (
             id, user_id, credential_id, series_id,
             previous_credential_id, cycle_months
           ) VALUES (?, ?, ?, ?, NULL, 24)`,
        )
        .run(
          "link-fl-mental-health-ethics",
          userId,
          credentialId,
          "series-fl-mental-health",
        );
      raw
        .prepare(
          `INSERT INTO credential_requirements (
             id, credential_id, rule_category_id, name, required_units,
             kind, relation, parent_requirement_id, applicability,
             applicability_status, condition_note, exclusive_group,
             is_active, sort_order
           )
           SELECT
             'current:' || category.id,
             ?,
             category.id,
             category.name,
             category.required_units,
             category.kind,
             category.relation,
             CASE
               WHEN category.parent_category_id IS NULL THEN NULL
               ELSE 'current:' || category.parent_category_id
             END,
             category.applicability,
             CASE
               WHEN category.applicability = 'conditional'
                 THEN 'needs_confirmation'
               ELSE 'applies'
             END,
             category.condition_note,
             category.exclusive_group,
             CASE
               WHEN category.applicability = 'conditional' THEN 0
               ELSE 1
             END,
             category.sort_order
           FROM rule_categories category
           WHERE category.rule_set_id = ?`,
        )
        .run(credentialId, currentRuleSetId);
      raw
        .prepare(
          `INSERT INTO renewal_submissions (
             id, user_id, credential_id, submitted_at,
             confirmation_number, proof_reference
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "submission-fl-mental-health",
          userId,
          credentialId,
          "2027-03-30",
          "FL-RENEWAL-0042",
          "FL-RENEWAL-0042",
        );
      const missingCreditBucket = await postWorkspace("addActivity", {
        title: "Unbucketed Florida CE",
        provider: "Approved Florida provider",
        completionDate: "2026-06-15",
        totalUnits: 1,
        credentialId,
        requirementIds: [
          "current:fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-clinical-other-content",
          "current:fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-other-qualifying-activity",
        ],
        evidenceStatus: "missing",
      });
      assert.equal(missingCreditBucket.status, 409);
      assert.equal(
        (await missingCreditBucket.json()).code,
        "florida_mental_health_credit_bucket_required",
      );
      const samePhase = await postWorkspace("markRenewalAccepted", {
        credentialId,
        acceptedAt: "2027-04-01",
        reference: "CE-BROKER-ETHICS",
        nextCycleStart: "2027-04-01",
        nextDeadline: "2029-03-31",
        nextRuleSetId: currentRuleSetId,
        officialDatesAttested: true,
      });
      assert.equal(samePhase.status, 409);
      assert.equal(
        (await samePhase.json()).code,
        "florida_mental_health_phase_must_alternate",
      );

      const invalidNextCycle = await postWorkspace(
        "markRenewalAccepted",
        {
          credentialId,
          acceptedAt: "2027-04-01",
          reference: "CE-BROKER-TELEHEALTH",
          nextCycleStart: "2028-04-01",
          nextDeadline: "2030-03-31",
          nextRuleSetId,
          officialDatesAttested: true,
        },
      );
      assert.equal(invalidNextCycle.status, 409);
      assert.equal(
        (await invalidNextCycle.json()).code,
        "florida_mental_health_next_cycle_invalid",
      );

      const response = await postWorkspace("markRenewalAccepted", {
        credentialId,
        acceptedAt: "2027-04-01",
        reference: "CE-BROKER-TELEHEALTH",
        nextCycleStart: "2027-04-01",
        nextDeadline: "2029-03-31",
        nextRuleSetId,
        officialDatesAttested: true,
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      const nextCredentialId = result.id;
      assert.ok(nextCredentialId);

      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT status FROM credentials WHERE id = ?`,
            )
            .get(credentialId),
        },
        { status: "renewed" },
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 rule_set_id AS ruleSetId,
                 total_required AS totalRequired,
                 cycle_start AS cycleStart,
                 deadline
               FROM credentials
               WHERE id = ?`,
            )
            .get(nextCredentialId),
        },
        {
          ruleSetId: nextRuleSetId,
          totalRequired: 30,
          cycleStart: "2027-04-01",
          deadline: "2029-03-31",
        },
      );
      assert.deepEqual(
        {
          ...raw
            .prepare(
              `SELECT
                 COUNT(*) AS categoryCount,
                 SUM(
                   CASE
                     WHEN applicability_status = 'needs_confirmation'
                       AND is_active = 0
                     THEN 1 ELSE 0
                   END
                 ) AS resetConditionCount,
                 SUM(CASE WHEN name = 'Telehealth' THEN 1 ELSE 0 END) AS telehealthCount,
                 SUM(CASE WHEN name = 'Ethics and Boundaries' THEN 1 ELSE 0 END) AS ethicsPhaseCount
               FROM credential_requirements
               WHERE credential_id = ?`,
            )
            .get(nextCredentialId),
        },
        {
          categoryCount: 11,
          resetConditionCount: 3,
          telehealthCount: 1,
          ethicsPhaseCount: 0,
        },
      );
      assert.deepEqual(
        raw
          .prepare(
            `SELECT title
             FROM checklist_tasks
             WHERE credential_id = ?
             ORDER BY sort_order`,
          )
          .all(nextCredentialId)
          .map((row) => row.title),
        [
          "Confirm the CE Broker phase, every-third-biennium topics, and supervisor status",
          "Complete and report the three separate Florida credit buckets",
          "Submit the Florida renewal and save CE Broker confirmation",
        ],
      );
      assert.ok(
        raw
          .prepare(
            `SELECT official_record_attested_at AS attestedAt
             FROM renewal_acceptances
             WHERE credential_id = ?`,
          )
          .get(credentialId).attestedAt,
      );

      const retry = await postWorkspace("markRenewalAccepted", {
        credentialId,
        acceptedAt: "2027-04-01",
        nextCycleStart: "2027-04-01",
        nextDeadline: "2029-03-31",
        nextRuleSetId: currentRuleSetId,
        officialDatesAttested: true,
      });
      assert.equal(retry.status, 200);
      assert.equal((await retry.json()).id, nextCredentialId);
      assert.equal(
        raw
          .prepare(
            `SELECT COUNT(*) AS count
             FROM credentials
             WHERE rule_set_id LIKE 'fl-lcsw-lmft-lmhc-%'
               AND user_id = ?`,
          )
          .get(userId).count,
        2,
      );
      database.close();
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
              evidenceStatus: "missing",
              revision: 1,
              archivedAt: null,
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
        requirementIds[0],
        3,
        "credential-second",
        userId,
        "activity-shared",
        1,
      ]);
      assert.match(
        allocationInsert.sql,
        /credential\.status IN \('active', 'submitted'\)/i,
      );
      const matchInserts = flattenedStatements(database).filter((statement) =>
        /^INSERT INTO activity_requirement_matches \(/i.test(statement.sql),
      );
      assert.equal(matchInserts.length, 2);
      assert.deepEqual(
        matchInserts.map((statement) => statement.bindings.slice(1)),
        requirementIds.map((requirementId) => [
          userId,
          requirementId,
          3,
          allocationInsert.bindings[0],
          "activity-shared",
          "credential-second",
          userId,
          1,
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
      assert.equal(taskReminder.eventDate, taskDueDate);
      assert.equal(deadlineReminder.eventDate, deadline);
      assert.equal(
        acceptanceReminder.eventDate,
        shiftIsoDate(submittedDate, 7),
      );
      assert.equal(taskReminder.urgency, "soon");
      assert.equal(deadlineReminder.urgency, "soon");
      assert.equal(acceptanceReminder.urgency, "overdue");
    },
  );

  await t.test(
    "applies caps while excluding missing and incompatible legacy classifications",
    async () => {
      const credentialId = "credential-arrt-dual-caps";
      const ptcbCredentialId = "credential-ptcb-legacy-conflict";
      const njLcswCredentialId = "credential-nj-lcsw-submitted";
      const requirementRows = [
        {
          id: "requirement-facility",
          credentialId,
          ruleCategoryId:
            "arrt-rt-standard-2026-applications-training",
          name: "Facility Applications Training",
          requiredUnits: 8,
          kind: "maximum",
          relation: "independent",
          parentRequirementId: null,
          applicability: "optional",
          applicabilityStatus: "applies",
          conditionNote: null,
          exclusiveGroup: "ARRT capped activity type",
          isActive: 1,
          rawEarned: 10,
        },
        {
          id: "requirement-als",
          credentialId,
          ruleCategoryId:
            "arrt-rt-standard-2026-advanced-life-support",
          name: "Advanced Life Support",
          requiredUnits: 6,
          kind: "maximum",
          relation: "independent",
          parentRequirementId: null,
          applicability: "optional",
          applicabilityStatus: "applies",
          conditionNote: null,
          exclusiveGroup: "ARRT capped activity type",
          isActive: 1,
          rawEarned: 8,
        },
        {
          id: "requirement-other",
          credentialId,
          ruleCategoryId:
            "arrt-rt-standard-2026-other-eligible-ce",
          name: "Other Eligible Category A or A+ CE",
          requiredUnits: 0,
          kind: "informational",
          relation: "independent",
          parentRequirementId: null,
          applicability: "optional",
          applicabilityStatus: "applies",
          conditionNote: null,
          exclusiveGroup: "ARRT capped activity type",
          isActive: 1,
          rawEarned: 10,
        },
        {
          id: "requirement-ptcb-bls",
          credentialId: ptcbCredentialId,
          ruleCategoryId: "ptcb-cpht-2026-bls-cpr-aed",
          name: "Eligible BLS, CPR, or AED Training",
          requiredUnits: 2,
          kind: "maximum",
          relation: "independent",
          parentRequirementId: null,
          applicability: "optional",
          applicabilityStatus: "applies",
          conditionNote: null,
          exclusiveGroup: "PTCB capped activity type",
          isActive: 1,
          rawEarned: 1,
        },
        {
          id: "requirement-ptcb-patient-safety",
          credentialId: ptcbCredentialId,
          ruleCategoryId: "ptcb-cpht-2026-patient-safety",
          name: "Patient Safety",
          requiredUnits: 1,
          kind: "minimum",
          relation: "overlapping",
          parentRequirementId: null,
          applicability: "always",
          applicabilityStatus: "applies",
          conditionNote: null,
          exclusiveGroup: null,
          isActive: 1,
          rawEarned: 1,
        },
        {
          id: "requirement-nj-lcsw-general",
          credentialId: njLcswCredentialId,
          ruleCategoryId: "nj-lcsw-general",
          name: "General Social Work",
          requiredUnits: 0,
          kind: "informational",
          relation: "independent",
          parentRequirementId: null,
          applicability: "always",
          applicabilityStatus: "applies",
          conditionNote: null,
          exclusiveGroup: "New Jersey LCSW credit category",
          isActive: 1,
          rawEarned: 0,
        },
      ];
      const activityRows = [
        ...[
        [
          "facility",
          "Facility applications series",
          10,
          "requirement-facility",
          "Facility Applications Training",
        ],
        [
          "als",
          "Advanced life support series",
          8,
          "requirement-als",
          "Advanced Life Support",
        ],
        [
          "other",
          "Other Category A series",
          10,
          "requirement-other",
          "Other Eligible Category A or A+ CE",
        ],
        [
          "legacy",
          "Legacy unclassified series",
          4,
          null,
          null,
        ],
        ].map(
        (
          [suffix, title, units, requirementId, categoryName],
          index,
        ) => ({
          id: `activity-${suffix}`,
          title,
          provider: "ARRT Test Provider",
          completionDate: `2027-0${index + 2}-01`,
          totalUnits: units,
          evidenceStatus: "attached",
          evidenceReference: null,
          evidenceCount: 1,
          allocationId: `allocation-${suffix}`,
          credentialId,
          credentialName: "ARRT Registered Technologist",
          requirementId,
          categoryName,
          allocatedUnits: units,
        }),
      ),
        {
          id: "activity-ptcb-conflict",
          title: "Legacy CPR safety entry",
          provider: "Legacy PTCB Provider",
          completionDate: "2027-06-15",
          totalUnits: 1,
          evidenceStatus: "attached",
          evidenceReference: null,
          evidenceCount: 1,
          allocationId: "allocation-ptcb-conflict",
          credentialId: ptcbCredentialId,
          credentialName: "PTCB CPhT",
          requirementId: "requirement-ptcb-bls",
          categoryName: "Eligible BLS, CPR, or AED Training",
          allocatedUnits: 1,
        },
        {
          id: "activity-ptcb-grandfathered",
          title: "Legacy ordinary pharmacy CE",
          provider: "Legacy PTCB Provider",
          completionDate: "2027-05-15",
          totalUnits: 2,
          evidenceStatus: "attached",
          evidenceReference: null,
          evidenceCount: 1,
          allocationId: "allocation-ptcb-grandfathered",
          credentialId: ptcbCredentialId,
          credentialName: "PTCB CPhT",
          requirementId: null,
          categoryName: null,
          allocatedUnits: 2,
        },
        {
          id: "activity-nj-lcsw-unclassified",
          title: "Legacy New Jersey social work CE",
          provider: "Legacy Social Work Provider",
          completionDate: "2027-04-15",
          totalUnits: 2,
          evidenceStatus: "attached",
          evidenceReference: null,
          evidenceCount: 1,
          allocationId: "allocation-nj-lcsw-unclassified",
          credentialId: njLcswCredentialId,
          credentialName: "New Jersey LCSW",
          requirementId: null,
          categoryName: null,
          allocatedUnits: 2,
        },
      ];
      const activityMatchRows = activityRows
        .filter((activity) => activity.requirementId)
        .map((activity) => ({
          id: `${activity.allocationId}-match`,
          activityId: activity.id,
          allocationId: activity.allocationId,
          credentialId: activity.credentialId,
          requirementId: activity.requirementId,
          categoryName: activity.categoryName,
          matchedUnits: activity.allocatedUnits,
        }));
      activityMatchRows.push({
        id: "allocation-ptcb-conflict-patient-safety",
        activityId: "activity-ptcb-conflict",
        allocationId: "allocation-ptcb-conflict",
        credentialId: ptcbCredentialId,
        requirementId: "requirement-ptcb-patient-safety",
        categoryName: "Patient Safety",
        matchedUnits: 1,
      });
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
                credentialName: "ARRT Registered Technologist",
                profession: "Radiologic Technology",
                jurisdiction: "National",
                issuer: "ARRT",
                deadline: "2027-12-31",
                cycleStart: "2027-01-01",
                totalRequired: 24,
                unitLabel: "credits",
                cycleMonths: 24,
                seriesId: credentialId,
                previousCredentialId: null,
                status: "active",
                submittedAt: null,
                confirmationNumber: null,
                submissionProof: null,
                acceptedAt: null,
                acceptanceReference: null,
                nextCredentialId: null,
                sourceUrl: null,
                sourceTitle: null,
                ruleReviewStatus: "verified",
                totalEarned: 32,
              },
              {
                id: ptcbCredentialId,
                credentialName: "PTCB CPhT",
                profession: "Pharmacy Technician",
                jurisdiction: "United States",
                issuer: "PTCB",
                deadline: "2027-12-31",
                cycleStart: "2027-01-01",
                totalRequired: 20,
                unitLabel: "CE hours",
                cycleMonths: 24,
                seriesId: ptcbCredentialId,
                previousCredentialId: null,
                status: "submitted",
                submittedAt: "2027-12-20T12:00:00.000Z",
                confirmationNumber: "PTCB-SUBMITTED",
                submissionProof: null,
                acceptedAt: null,
                acceptanceReference: null,
                nextCredentialId: null,
                sourceUrl: null,
                sourceTitle: null,
                ruleReviewStatus: "verified",
                totalEarned: 3,
              },
              {
                id: njLcswCredentialId,
                ruleSetId: "nj-lcsw-sample-v1",
                credentialName: "New Jersey LCSW",
                profession: "Social Work",
                jurisdiction: "New Jersey",
                issuer: "New Jersey Board of Social Work Examiners",
                deadline: "2027-08-31",
                cycleStart: "2025-09-01",
                totalRequired: 40,
                unitLabel: "CE hours",
                cycleMonths: 24,
                seriesId: njLcswCredentialId,
                previousCredentialId: null,
                status: "submitted",
                submittedAt: "2027-08-20T12:00:00.000Z",
                confirmationNumber: "NJ-LCSW-SUBMITTED",
                submissionProof: null,
                acceptedAt: null,
                acceptanceReference: null,
                nextCredentialId: null,
                sourceUrl: null,
                sourceTitle: null,
                ruleReviewStatus: "verified",
                totalEarned: 2,
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
          totalLoggedUnits: credential.totalLoggedUnits,
          unclassifiedUnits: credential.unclassifiedUnits,
          totalRawEarned: credential.totalRawEarned,
          totalExcessUnits: credential.totalExcessUnits,
          totalEarned: credential.totalEarned,
        },
        {
          totalLoggedUnits: 32,
          unclassifiedUnits: 4,
          totalRawEarned: 28,
          totalExcessUnits: 4,
          totalEarned: 24,
        },
      );
      assert.deepEqual(credential.classificationIssues, [
        {
          allocationId: "allocation-legacy",
          activityId: "activity-legacy",
          activityTitle: "Legacy unclassified series",
          unresolvedExclusiveGroups: ["ARRT capped activity type"],
          allocatedUnits: 4,
        },
      ]);
      const progressById = new Map(
        credential.requirements.map((requirement) => [
          requirement.id,
          requirement,
        ]),
      );
      assert.deepEqual(
        [
          "requirement-facility",
          "requirement-als",
        ].map((requirementId) => ({
          raw: progressById.get(requirementId).rawEarned,
          countable: progressById.get(requirementId).countableEarned,
          excess: progressById.get(requirementId).excessUnits,
        })),
        [
          { raw: 10, countable: 8, excess: 2 },
          { raw: 8, countable: 6, excess: 2 },
        ],
      );
      const legacyAllocation = workspace.activities
        .find((activity) => activity.id === "activity-legacy")
        .allocations[0];
      assert.equal(
        legacyAllocation.classificationStatus,
        "needs_classification",
      );
      assert.deepEqual(legacyAllocation.unresolvedExclusiveGroups, [
        "ARRT capped activity type",
      ]);
      const ptcbCredential = workspace.credentials.find(
        (candidate) => candidate.id === ptcbCredentialId,
      );
      assert.ok(ptcbCredential);
      assert.deepEqual(
        {
          totalLoggedUnits: ptcbCredential.totalLoggedUnits,
          unclassifiedUnits: ptcbCredential.unclassifiedUnits,
          totalRawEarned: ptcbCredential.totalRawEarned,
          totalEarned: ptcbCredential.totalEarned,
        },
        {
          totalLoggedUnits: 3,
          unclassifiedUnits: 1,
          totalRawEarned: 2,
          totalEarned: 2,
        },
      );
      assert.deepEqual(ptcbCredential.classificationIssues, [
        {
          allocationId: "allocation-ptcb-conflict",
          activityId: "activity-ptcb-conflict",
          activityTitle: "Legacy CPR safety entry",
          unresolvedExclusiveGroups: [],
          allocatedUnits: 1,
          classificationMessage:
            "BLS, CPR, or AED training cannot satisfy Patient Safety for the same activity. Choose only one of those tags.",
        },
      ]);
      const ptcbAllocation = workspace.activities
        .find((activity) => activity.id === "activity-ptcb-conflict")
        .allocations[0];
      assert.equal(
        ptcbAllocation.classificationStatus,
        "needs_classification",
      );
      assert.equal(
        ptcbAllocation.classificationMessage,
        ptcbCredential.classificationIssues[0].classificationMessage,
      );
      const grandfatheredPtcbAllocation = workspace.activities
        .find(
          (activity) => activity.id === "activity-ptcb-grandfathered",
        )
        .allocations[0];
      assert.equal(
        grandfatheredPtcbAllocation.classificationStatus,
        "classified",
      );
      const njLcswCredential = workspace.credentials.find(
        (candidate) => candidate.id === njLcswCredentialId,
      );
      assert.ok(njLcswCredential);
      assert.deepEqual(
        {
          totalLoggedUnits: njLcswCredential.totalLoggedUnits,
          unclassifiedUnits: njLcswCredential.unclassifiedUnits,
          totalEarned: njLcswCredential.totalEarned,
        },
        {
          totalLoggedUnits: 2,
          unclassifiedUnits: 2,
          totalEarned: 0,
        },
      );
      assert.deepEqual(njLcswCredential.classificationIssues, [
        {
          allocationId: "allocation-nj-lcsw-unclassified",
          activityId: "activity-nj-lcsw-unclassified",
          activityTitle: "Legacy New Jersey social work CE",
          unresolvedExclusiveGroups: [
            "New Jersey LCSW credit category",
          ],
          allocatedUnits: 2,
        },
      ]);
    },
  );

  await t.test(
    "applies intersecting Florida caps without double-subtracting one activity",
    async () => {
      const credentialId = "credential-florida-intersecting-caps";
      const requirements = [
        {
          id: "fl-requirement-general",
          credentialId,
          ruleCategoryId:
            "fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-general",
          name: "General",
          requiredUnits: 25,
          kind: "minimum",
          relation: "independent",
          parentRequirementId: null,
          applicability: "always",
          applicabilityStatus: "applies",
          conditionNote: null,
          exclusiveGroup: "Florida mental-health CE credit bucket",
          isActive: 1,
          rawEarned: 30,
        },
        {
          id: "fl-requirement-administrative",
          credentialId,
          ruleCategoryId:
            "fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-administrative-nonclinical",
          name: "Administrative, Office-Management, or Nonclinical Skills",
          requiredUnits: 6,
          kind: "maximum",
          relation: "independent",
          parentRequirementId: null,
          applicability: "optional",
          applicabilityStatus: "applies",
          conditionNote: null,
          exclusiveGroup: "Florida mental-health CE content type",
          isActive: 1,
          rawEarned: 12,
        },
        {
          id: "fl-requirement-clinical",
          credentialId,
          ruleCategoryId:
            "fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-clinical-other-content",
          name: "Clinical or Other Qualifying Content",
          requiredUnits: 0,
          kind: "informational",
          relation: "independent",
          parentRequirementId: null,
          applicability: "always",
          applicabilityStatus: "applies",
          conditionNote: null,
          exclusiveGroup: "Florida mental-health CE content type",
          isActive: 1,
          rawEarned: 18,
        },
        {
          id: "fl-requirement-presenter",
          credentialId,
          ruleCategoryId:
            "fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-presenter-moderator",
          name: "Presenter or Moderator",
          requiredUnits: 10,
          kind: "maximum",
          relation: "independent",
          parentRequirementId: null,
          applicability: "optional",
          applicabilityStatus: "applies",
          conditionNote: null,
          exclusiveGroup: "Florida mental-health CE activity source",
          isActive: 1,
          rawEarned: 12,
        },
        {
          id: "fl-requirement-other-source",
          credentialId,
          ruleCategoryId:
            "fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-other-qualifying-activity",
          name: "Other Qualifying CE Activity",
          requiredUnits: 0,
          kind: "informational",
          relation: "independent",
          parentRequirementId: null,
          applicability: "always",
          applicabilityStatus: "applies",
          conditionNote: null,
          exclusiveGroup: "Florida mental-health CE activity source",
          isActive: 1,
          rawEarned: 18,
        },
      ];
      const activities = [
        {
          id: "activity-florida-shared-cap",
          title: "Administrative presenter program",
          provider: "Approved Florida provider",
          completionDate: "2026-06-15",
          totalUnits: 12,
          evidenceStatus: "attached",
          evidenceReference: "shared.pdf",
          evidenceCount: 1,
          allocationId: "allocation-florida-shared-cap",
          credentialId,
          credentialName: "Florida LCSW",
          requirementId: "fl-requirement-general",
          categoryName: "General",
          allocatedUnits: 12,
        },
        {
          id: "activity-florida-ordinary",
          title: "Ordinary clinical education",
          provider: "Approved Florida provider",
          completionDate: "2026-07-15",
          totalUnits: 18,
          evidenceStatus: "attached",
          evidenceReference: "ordinary.pdf",
          evidenceCount: 1,
          allocationId: "allocation-florida-ordinary",
          credentialId,
          credentialName: "Florida LCSW",
          requirementId: "fl-requirement-general",
          categoryName: "General",
          allocatedUnits: 18,
        },
      ];
      const requirementById = new Map(
        requirements.map((requirement) => [
          requirement.id,
          requirement,
        ]),
      );
      const matchSpecs = [
        [
          "allocation-florida-shared-cap",
          "activity-florida-shared-cap",
          12,
          [
            "fl-requirement-general",
            "fl-requirement-administrative",
            "fl-requirement-presenter",
          ],
        ],
        [
          "allocation-florida-ordinary",
          "activity-florida-ordinary",
          18,
          [
            "fl-requirement-general",
            "fl-requirement-clinical",
            "fl-requirement-other-source",
          ],
        ],
      ];
      const matches = matchSpecs.flatMap(
        ([allocationId, activityId, matchedUnits, requirementIds]) =>
          requirementIds.map((requirementId) => ({
            id: `${allocationId}:${requirementId}`,
            activityId,
            allocationId,
            credentialId,
            requirementId,
            categoryName: requirementById.get(requirementId).name,
            matchedUnits,
          })),
      );
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
                ruleSetId:
                  "fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-v1",
                credentialName: "Florida LCSW",
                profession: "Mental Health",
                jurisdiction: "Florida",
                issuer: "Florida Board",
                deadline: "2027-03-31",
                cycleStart: "2025-04-01",
                totalRequired: 30,
                unitLabel: "CE hours",
                cycleMonths: 24,
                seriesId: credentialId,
                previousCredentialId: null,
                status: "active",
                submittedAt: null,
                confirmationNumber: null,
                submissionProof: null,
                acceptedAt: null,
                acceptanceReference: null,
                nextCredentialId: null,
                sourceUrl: null,
                sourceTitle: null,
                ruleReviewStatus: "source_linked_check_conditions",
                totalEarned: 30,
              },
            ];
          }
          if (
            /FROM credential_requirements req JOIN credentials c/i.test(
              call.sql,
            )
          ) {
            return requirements;
          }
          if (
            /FROM activities a LEFT JOIN activity_allocations alloc/i.test(
              call.sql,
            )
          ) {
            return activities;
          }
          if (
            /FROM activity_requirement_matches match JOIN activity_allocations allocation/i.test(
              call.sql,
            )
          ) {
            return matches;
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
      assert.deepEqual(credential.classificationIssues, []);
      assert.deepEqual(
        {
          totalLoggedUnits: credential.totalLoggedUnits,
          totalRawEarned: credential.totalRawEarned,
          totalExcessUnits: credential.totalExcessUnits,
          totalEarned: credential.totalEarned,
        },
        {
          totalLoggedUnits: 30,
          totalRawEarned: 30,
          totalExcessUnits: 6,
          totalEarned: 24,
        },
      );
      const progress = new Map(
        credential.requirements.map((requirement) => [
          requirement.id,
          requirement,
        ]),
      );
      assert.deepEqual(
        {
          administrative: {
            raw: progress.get("fl-requirement-administrative").rawEarned,
            countable:
              progress.get("fl-requirement-administrative")
                .countableEarned,
            excess:
              progress.get("fl-requirement-administrative").excessUnits,
          },
          presenter: {
            raw: progress.get("fl-requirement-presenter").rawEarned,
            countable:
              progress.get("fl-requirement-presenter").countableEarned,
            excess: progress.get("fl-requirement-presenter").excessUnits,
          },
        },
        {
          administrative: { raw: 12, countable: 6, excess: 6 },
          presenter: { raw: 12, countable: 10, excess: 2 },
        },
      );
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
      assert.match(
        totalQuery.sql,
        /SUM\( CASE WHEN counted_activity\.id IS NULL THEN 0 ELSE MIN\( alloc\.allocated_units, counted_activity\.total_units \) END \)/i,
      );
      assert.match(totalQuery.sql, /counted_activity\.archived_at IS NULL/i);
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
    "blocks renewal acceptance while a capped-category allocation remains unclassified",
    async () => {
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
              id: "credential-nasm-submitted",
              ruleSetId: "nasm-cpt-2026-v1",
              credentialName:
                "NASM Certified Personal Trainer (NASM-CPT) — standard recertification",
              profession: "Fitness and Personal Training",
              jurisdiction: "United States",
              issuer: "National Academy of Sports Medicine",
              status: "submitted",
              totalRequired: 2,
              unitLabel: "NASM CEUs",
              seriesId: "credential-nasm-submitted",
              cycleMonths: 24,
            };
          }
          if (
            /FROM renewal_submissions WHERE credential_id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return {
              id: "submission-nasm",
              submittedAt: "2028-02-20T15:00:00.000Z",
            };
          }
          return null;
        },
        resolveAll(call) {
          if (
            /requirement\.is_active AS isActive/i.test(call.sql)
          ) {
            return [
              {
                id: "requirement-nasm-category-a",
                name: "Category A — NASM/AFAA Approved Provider Education",
                ruleCategoryId: "nasm-cpt-2026-category-a",
                kind: "informational",
                isActive: 1,
                applicabilityStatus: "applies",
                exclusiveGroup: "NASM CEU activity type",
              },
              {
                id: "requirement-nasm-category-d",
                name: "Category D — Adult CPR/AED",
                ruleCategoryId: "nasm-cpt-2026-category-d-cpr-aed",
                kind: "maximum",
                isActive: 1,
                applicabilityStatus: "applies",
                exclusiveGroup: "NASM CEU activity type",
              },
            ];
          }
          if (
            /SELECT allocation\.id FROM activity_allocations allocation/i.test(
              call.sql,
            )
          ) {
            return [{ id: "allocation-nasm-unclassified" }];
          }
          if (
            /match\.allocation_id AS allocationId/i.test(call.sql)
          ) {
            return [];
          }
          return [];
        },
      });
      testCloudflareEnv.DB = database;

      const response = await postWorkspace("markRenewalAccepted", {
        credentialId: "credential-nasm-submitted",
        acceptedAt: "2028-02-25",
        reference: "NASM-ACCEPTANCE-PENDING",
        nextCycleStart: "2028-03-01",
        nextDeadline: "2030-03-01",
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error:
          "Resolve every activity classification conflict before marking this renewal accepted.",
        code: "classification_required_before_acceptance",
      });
      assert.equal(
        flattenedStatements(database).some(
          (statement) =>
            /UPDATE credentials[\s\S]*?SET status = 'renewed'|INSERT INTO renewal_acceptances/i.test(
              statement.sql,
            ),
        ),
        false,
      );
    },
  );

  await t.test(
    "atomically blocks, repairs, and closes a submitted NASM cycle while preserving its history",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const database = new SQLiteD1Database(DatabaseSync);
      const runtimeSource = await readFile(
        new URL("../db/runtime.ts", import.meta.url),
        "utf8",
      );
      const isolatedRuntime = await importTypeScriptModule(
        `${runtimeSource}\nexport const __nasmAcceptanceTestNonce = "nasm-acceptance";`,
      );
      await isolatedRuntime.initializeDatabase(database);
      const userId = await expectedStableUserId("owner@example.com");
      const raw = database.raw;

      try {
        raw
          .prepare(
            `INSERT INTO users (id, email, display_name, is_demo)
             VALUES (?, ?, ?, 0)`,
          )
          .run(userId, "owner@example.com", "Casey Owner");
        raw
          .prepare(
            `INSERT INTO credentials (
               id, user_id, rule_set_id, credential_name, profession,
               jurisdiction, issuer, cycle_start, deadline, total_required,
               unit_label, status
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted')`,
          )
          .run(
            "credential-nasm-real",
            userId,
            "nasm-cpt-2026-v1",
            "NASM Certified Personal Trainer (NASM-CPT) — standard recertification",
            "Fitness and Personal Training",
            "United States",
            "National Academy of Sports Medicine",
            "2026-03-01",
            "2028-02-29",
            2,
            "NASM CEUs",
          );
        raw
          .prepare(
            `INSERT INTO credential_cycle_links (
               id, user_id, credential_id, series_id,
               previous_credential_id, cycle_months
             ) VALUES (?, ?, ?, ?, NULL, 24)`,
          )
          .run(
            "cycle-link-nasm-real",
            userId,
            "credential-nasm-real",
            "series-nasm-real",
          );
        const insertRequirement = raw.prepare(
          `INSERT INTO credential_requirements (
             id, credential_id, rule_category_id, name, required_units, kind,
             relation, parent_requirement_id, applicability,
             applicability_status, condition_note, exclusive_group, is_active,
             sort_order
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'applies', ?, ?, 1, ?)`,
        );
        insertRequirement.run(
          "requirement-nasm-real-a",
          "credential-nasm-real",
          "nasm-cpt-2026-category-a",
          "Category A — NASM/AFAA Approved Provider Education",
          0,
          "informational",
          "independent",
          "optional",
          "Use this classifier for NASM-approved education.",
          "NASM CEU activity type",
          0,
        );
        insertRequirement.run(
          "requirement-nasm-real-d",
          "credential-nasm-real",
          "nasm-cpt-2026-category-d-cpr-aed",
          "Category D — Adult CPR/AED",
          0.1,
          "maximum",
          "independent",
          "optional",
          "At most 0.1 CEU counts for current adult CPR/AED.",
          "NASM CEU activity type",
          1,
        );
        raw
          .prepare(
            `INSERT INTO renewal_submissions (
               id, user_id, credential_id, submitted_at,
               confirmation_number
             ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            "submission-nasm-real",
            userId,
            "credential-nasm-real",
            "2028-02-20T15:00:00.000Z",
            "NASM-SUBMITTED",
          );
        raw
          .prepare(
            `INSERT INTO activities (
               id, user_id, title, provider, completion_date, total_units,
               evidence_status
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "activity-nasm-real",
            userId,
            "NASM approved education",
            "NASM Provider",
            "2027-10-15",
            1.9,
            "attached",
          );
        raw
          .prepare(
            `INSERT INTO activity_allocations (
               id, activity_id, credential_id, requirement_id,
               allocated_units
             ) VALUES (?, ?, ?, NULL, ?)`,
          )
          .run(
            "allocation-nasm-real",
            "activity-nasm-real",
            "credential-nasm-real",
            1.9,
          );
        testCloudflareEnv.DB = database;

        const acceptancePayload = {
          credentialId: "credential-nasm-real",
          acceptedAt: "2028-02-25",
          reference: "NASM-ACCEPTED",
          nextCycleStart: "2028-03-01",
          nextDeadline: "2030-03-01",
        };
        const blocked = await postWorkspace(
          "markRenewalAccepted",
          acceptancePayload,
        );
        assert.equal(blocked.status, 409);
        assert.equal(
          (await blocked.json()).code,
          "classification_required_before_acceptance",
        );
        assert.equal(
          raw
            .prepare(
              `SELECT status FROM credentials
               WHERE id = 'credential-nasm-real'`,
            )
            .get().status,
          "submitted",
        );
        assert.equal(
          raw.prepare(`SELECT COUNT(*) AS count FROM renewal_acceptances`).get()
            .count,
          0,
        );

        const repaired = await postWorkspace(
          "updateActivityAllocationRequirements",
          {
            allocationId: "allocation-nasm-real",
            requirementIds: ["requirement-nasm-real-a"],
          },
        );
        assert.equal(repaired.status, 200);

        const batchWithoutRace = database.batch.bind(database);
        let raceNextAcceptance = true;
        database.batch = async (statements) => {
          if (
            raceNextAcceptance &&
            /SET status = 'renewed'/i.test(statements[0]?.sql ?? "")
          ) {
            raceNextAcceptance = false;
            raw
              .prepare(
                `UPDATE renewal_submissions
                 SET submitted_at = '2028-02-26T09:00:00.000Z'
                 WHERE id = 'submission-nasm-real'`,
              )
              .run();
          }
          return batchWithoutRace(statements);
        };
        const racedAcceptance = await postWorkspace(
          "markRenewalAccepted",
          acceptancePayload,
        );
        assert.equal(racedAcceptance.status, 409);
        assert.equal(
          (await racedAcceptance.json()).code,
          "submission_state_changed",
        );
        assert.equal(
          raw
            .prepare(
              `SELECT status FROM credentials
               WHERE id = 'credential-nasm-real'`,
            )
            .get().status,
          "submitted",
        );
        assert.equal(
          raw.prepare(`SELECT COUNT(*) AS count FROM renewal_acceptances`).get()
            .count,
          0,
        );
        raw
          .prepare(
            `UPDATE renewal_submissions
             SET submitted_at = '2028-02-20T15:00:00.000Z'
             WHERE id = 'submission-nasm-real'`,
          )
          .run();
        database.batch = batchWithoutRace;

        const accepted = await postWorkspace(
          "markRenewalAccepted",
          acceptancePayload,
        );
        assert.equal(accepted.status, 200);
        const nextCredentialId = (await accepted.json()).id;
        assert.match(nextCredentialId, /^[0-9a-f-]{36}$/i);
        assert.equal(
          raw
            .prepare(
              `SELECT status FROM credentials
               WHERE id = 'credential-nasm-real'`,
            )
            .get().status,
          "renewed",
        );
        assert.equal(
          raw.prepare(`SELECT COUNT(*) AS count FROM renewal_acceptances`).get()
            .count,
          1,
        );
        assert.equal(
          raw
            .prepare(
              `SELECT COUNT(*) AS count FROM credentials
               WHERE user_id = ?`,
            )
            .get(userId).count,
          2,
        );

        assert.throws(
          () =>
            raw
              .prepare(
                `DELETE FROM activity_requirement_matches
                 WHERE allocation_id = 'allocation-nasm-real'`,
              )
              .run(),
          /activity_match_not_mutable/i,
        );
        assert.throws(
          () =>
            raw
              .prepare(
                `UPDATE activity_allocations
                 SET requirement_id = NULL
                 WHERE id = 'allocation-nasm-real'`,
              )
              .run(),
          /activity_allocation_not_mutable/i,
        );
        assert.equal(
          raw
            .prepare(
              `SELECT COUNT(*) AS count
               FROM activity_requirement_matches
               WHERE allocation_id = 'allocation-nasm-real'`,
            )
            .get().count,
          1,
        );
        assert.deepEqual(
          {
            ...raw
              .prepare(
              `SELECT
                 rule_set_id AS ruleSetId,
                 status
               FROM credentials
               WHERE id = 'credential-nasm-real'`,
              )
              .get(),
          },
          {
            ruleSetId: "nasm-cpt-2026-v1",
            status: "renewed",
          },
        );
        assert.deepEqual(
          raw
            .prepare(
              `SELECT
                 kind,
                 exclusive_group AS exclusiveGroup,
                 is_active AS isActive,
                 applicability_status AS applicabilityStatus
               FROM credential_requirements
               WHERE credential_id = 'credential-nasm-real'
               ORDER BY sort_order`,
            )
            .all()
            .map((row) => ({ ...row })),
          [
            {
              kind: "informational",
              exclusiveGroup: "NASM CEU activity type",
              isActive: 1,
              applicabilityStatus: "applies",
            },
            {
              kind: "maximum",
              exclusiveGroup: "NASM CEU activity type",
              isActive: 1,
              applicabilityStatus: "applies",
            },
          ],
        );
        const workspaceResponse = await fetchWorker(
          "https://license-lantern.example/api/workspace",
          { headers: authHeaders() },
        );
        assert.equal(workspaceResponse.status, 200);
        const workspace = await workspaceResponse.json();
        const historical = workspace.credentials.find(
          (credential) => credential.id === "credential-nasm-real",
        );
        assert.ok(historical);
        assert.deepEqual(
          {
            status: historical.status,
            totalLoggedUnits: historical.totalLoggedUnits,
            unclassifiedUnits: historical.unclassifiedUnits,
            totalEarned: historical.totalEarned,
            classificationIssues: historical.classificationIssues,
          },
          {
            status: "renewed",
            totalLoggedUnits: 1.9,
            unclassifiedUnits: 0,
            totalEarned: 1.9,
            classificationIssues: [],
          },
        );
      } finally {
        database.close();
      }
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
                exclusiveGroup: "Test activity type",
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
                exclusiveGroup: null,
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
                exclusiveGroup: null,
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
        /UPDATE credentials SET status = 'renewed'/i.test(statement.sql),
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
        "credential-prior",
        userId,
      ]);
      assert.deepEqual(nextCycleLink.bindings.slice(1), [
        "series-one",
        "credential-prior",
        24,
        nextCredentialId,
        userId,
      ]);
      assert.equal(requirementSnapshots.length, 3);
      const snapshotByName = new Map(
        requirementSnapshots.map((statement) => [
          statement.bindings[2],
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
        null,
        "General",
        10,
        "minimum",
        "independent",
        null,
        "always",
        "applies",
        null,
        "Test activity type",
        1,
        0,
        nextCredentialId,
        userId,
      ]);
      assert.notEqual(
        generalSnapshot.bindings[0],
        "requirement-general",
        "the new cycle must receive fresh requirement IDs",
      );
      assert.deepEqual(ethicsSnapshot.bindings.slice(1), [
        null,
        "Ethics",
        2,
        "minimum",
        "nested",
        generalSnapshot.bindings[0],
        "conditional",
        "needs_confirmation",
        "Confirm whether the ethics condition applies this cycle.",
        null,
        0,
        1,
        nextCredentialId,
        userId,
      ]);
      assert.notEqual(
        ethicsSnapshot.bindings[6],
        "requirement-general",
        "nested parents must be remapped away from the prior cycle",
      );
      assert.deepEqual(maximumSnapshot.bindings.slice(1), [
        null,
        "Self-study",
        4,
        "maximum",
        "overlapping",
        null,
        "optional",
        "applies",
        "No more than four self-study hours count.",
        null,
        1,
        2,
        nextCredentialId,
        userId,
      ]);
      assert.equal(nextTasks.length, 3);
      assert.ok(
        nextTasks.every(
          (statement) =>
            statement.bindings.at(-2) === nextCredentialId &&
            statement.bindings.at(-1) === userId,
        ),
      );
      assert.deepEqual(acceptanceInsert.bindings, [
        acceptanceInsert.bindings[0],
        "submission-prior",
        "2028-02-25",
        "ACCEPT-204",
        null,
        nextCredentialId,
        "credential-prior",
        userId,
      ]);
      const guardedCredentialBindingIndex =
        oldCycleUpdate.bindings.indexOf("credential-prior");
      assert.ok(guardedCredentialBindingIndex >= 0);
      assert.deepEqual(
        oldCycleUpdate.bindings.slice(
          guardedCredentialBindingIndex,
          guardedCredentialBindingIndex + 4,
        ),
        [
          "credential-prior",
          userId,
          "submission-prior",
          "2028-02-25",
        ],
      );
      assert.match(
        oldCycleUpdate.sql,
        /required_classification_groups[\s\S]*?incompatible_categories[\s\S]*?status = 'submitted'[\s\S]*?guarded_submission[\s\S]*?submitted_at, 1, 10\) <= \?/i,
      );
      assert.equal(
        database.batches.at(-1)[0],
        oldCycleUpdate,
        "the atomic classification/status guard must lead the acceptance batch",
      );
      assert.match(
        nextCredentialInsert.sql,
        /FROM credentials source[\s\S]*?source\.status = 'renewed'[\s\S]*?NOT EXISTS \([\s\S]*?FROM renewal_acceptances acceptance/i,
      );
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

  await t.test(
    "moves a pre-2027 CFP cycle onto the source-linked 40-hour rule",
    async () => {
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
              id: "credential-cfp-prior",
              ruleSetId: "cfp-professional-pre-2027-v1",
              credentialName:
                "CFP® Professional — cycle beginning before April 1, 2027",
              profession: "Financial Planning",
              jurisdiction: "United States",
              issuer: "CFP Board",
              status: "submitted",
              totalRequired: 30,
              unitLabel: "CE hours",
              seriesId: "series-cfp",
              cycleMonths: 24,
            };
          }
          if (
            /FROM renewal_submissions WHERE credential_id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return {
              id: "submission-cfp-prior",
              submittedAt: "2026-12-20T15:00:00.000Z",
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
                id: "requirement-cfp-general",
                ruleCategoryId: "cfp-professional-pre-2027-general",
                name: "General CE",
                requiredUnits: 28,
                kind: "minimum",
                relation: "independent",
                parentRequirementId: null,
                applicability: "always",
                conditionNote: "Twenty-eight general hours.",
                exclusiveGroup: "CFP CE type",
                sortOrder: 0,
              },
              {
                id: "requirement-cfp-ethics",
                ruleCategoryId: "cfp-professional-pre-2027-ethics",
                name: "CFP Board-Approved Ethics CE",
                requiredUnits: 2,
                kind: "minimum",
                relation: "independent",
                parentRequirementId: null,
                applicability: "always",
                conditionNote: "Two approved ethics hours.",
                exclusiveGroup: "CFP CE type",
                sortOrder: 1,
              },
            ];
          }
          return [];
        },
      });
      testCloudflareEnv.DB = database;
      const response = await postWorkspace("markRenewalAccepted", {
        credentialId: "credential-cfp-prior",
        acceptedAt: "2027-03-25",
        reference: "CFP-ACCEPTED",
        nextCycleStart: "2027-04-01",
        nextDeadline: "2029-03-31",
      });
      assert.equal(response.status, 200);
      const nextCredentialId = (await response.json()).id;
      const statements = flattenedStatements(database);
      const credentialInsert = statements.find((statement) =>
        /^INSERT INTO credentials \(/i.test(statement.sql),
      );
      assert.ok(credentialInsert);
      assert.deepEqual(credentialInsert.bindings, [
        nextCredentialId,
        await expectedStableUserId("owner@example.com"),
        "cfp-professional-2027-v1",
        "CFP® Professional — cycle beginning April 1, 2027 or later",
        "Financial Planning",
        "United States",
        "CFP Board",
        "2027-04-01",
        "2029-03-31",
        40,
        "CE hours",
        "credential-cfp-prior",
        await expectedStableUserId("owner@example.com"),
      ]);
      const requirementSnapshots = statements.filter((statement) =>
        /^INSERT INTO credential_requirements \(/i.test(statement.sql),
      );
      const snapshotByName = new Map(
        requirementSnapshots.map((statement) => [
          statement.bindings[2],
          statement,
        ]),
      );
      assert.deepEqual(
        [
          snapshotByName.get("General CE")?.bindings[1],
          snapshotByName.get("General CE")?.bindings[3],
          snapshotByName.get("General CE")?.bindings[10],
        ],
        ["cfp-professional-2027-general", 38, null],
      );
      assert.deepEqual(
        [
          snapshotByName.get(
            "General CE — Principal Topics Other Than Practice Management",
          )?.bindings[1],
          snapshotByName.get(
            "General CE — Principal Topics Other Than Practice Management",
          )?.bindings[3],
          snapshotByName.get(
            "General CE — Principal Topics Other Than Practice Management",
          )?.bindings[4],
          snapshotByName.get(
            "General CE — Principal Topics Other Than Practice Management",
          )?.bindings[5],
          snapshotByName.get(
            "General CE — Principal Topics Other Than Practice Management",
          )?.bindings[10],
        ],
        [
          "cfp-professional-2027-principal-topics",
          33,
          "minimum",
          "nested",
          "CFP CE activity type",
        ],
      );
      assert.deepEqual(
        [
          snapshotByName.get("Practice Management General CE")?.bindings[1],
          snapshotByName.get("Practice Management General CE")?.bindings[3],
          snapshotByName.get("Practice Management General CE")?.bindings[4],
          snapshotByName.get("Practice Management General CE")?.bindings[5],
          snapshotByName.get("Practice Management General CE")?.bindings[7],
          snapshotByName.get("Practice Management General CE")?.bindings[10],
        ],
        [
          "cfp-professional-2027-practice-management",
          5,
          "maximum",
          "nested",
          "optional",
          "CFP CE activity type",
        ],
      );
      assert.deepEqual(
        [
          snapshotByName.get("CFP Board-Approved Ethics CE")?.bindings[1],
          snapshotByName.get("CFP Board-Approved Ethics CE")?.bindings[3],
          snapshotByName.get("CFP Board-Approved Ethics CE")?.bindings[10],
        ],
        ["cfp-professional-2027-ethics", 2, "CFP CE activity type"],
      );
      assert.equal(requirementSnapshots.length, 4);
      assert.equal(
        snapshotByName.get(
          "General CE — Principal Topics Other Than Practice Management",
        )?.bindings[6],
        snapshotByName.get("General CE")?.bindings[0],
      );
      assert.equal(
        snapshotByName.get("Practice Management General CE")?.bindings[6],
        snapshotByName.get("General CE")?.bindings[0],
      );
      const reviewTask = statements.find(
        (statement) =>
          /^INSERT INTO checklist_tasks \(/i.test(statement.sql) &&
          statement.bindings[1] ===
            "Confirm CFP Board carryover, then manually record only approved general CE",
      );
      assert.ok(reviewTask);
      assert.equal(
        statements.some((statement) =>
          /^INSERT INTO (activities|activity_allocations|activity_requirement_matches) \(/i.test(
            statement.sql,
          ),
        ),
        false,
      );
    },
  );

  await t.test(
    "guards activity corrections, archive transitions, and National Registry exact amounts",
    async () => {
      const userId = await expectedStableUserId("owner@example.com");
      const activityId = "activity-correction";
      const isActivityMutationLookup = (sql) =>
        /SELECT id, revision, archived_at AS archivedAt, completion_date AS completionDate, total_units AS totalUnits, provider, evidence_status AS evidenceStatus FROM activities WHERE id = \? AND user_id = \?/i.test(
          sql,
        );
      const isAllocationValidationLookup = (sql) =>
        /SELECT allocation\.id, allocation\.credential_id AS credentialId, allocation\.requirement_id AS requirementId, allocation\.allocated_units AS allocatedUnits, credential\.rule_set_id AS ruleSetId, credential\.status AS credentialStatus/i.test(
          sql,
        );
      const isMatchValidationLookup = (sql) =>
        /SELECT match\.allocation_id AS allocationId, match\.requirement_id AS requirementId, match\.matched_units AS matchedUnits/i.test(
          sql,
        );
      const hasActivityMutationWrite = (database) =>
        database.calls.some((call) =>
          /^UPDATE (?:activity_allocations|activity_requirement_matches|activities) /i.test(
            call.sql,
          ),
        );
      const activeActivity = {
        id: activityId,
        revision: 3,
        archivedAt: null,
        completionDate: "2027-05-20",
        totalUnits: 2,
        provider: "Original Provider",
        evidenceStatus: "missing",
      };
      const genericRequirement = {
        id: "requirement-general",
        name: "General CE",
        ruleCategoryId: null,
        kind: "minimum",
        relation: "independent",
        parentRequirementId: null,
        isActive: 1,
        applicabilityStatus: "applies",
        exclusiveGroup: null,
      };
      const successDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (isActivityMutationLookup(call.sql)) return activeActivity;
          return null;
        },
        resolveAll(call) {
          if (isAllocationValidationLookup(call.sql)) {
            return [
              {
                id: "allocation-general",
                credentialId: "credential-general",
                requirementId: genericRequirement.id,
                allocatedUnits: 2,
                ruleSetId: null,
                credentialStatus: "active",
                cycleStart: "2027-01-01",
                deadline: "2027-12-31",
              },
            ];
          }
          if (isMatchValidationLookup(call.sql)) {
            return [
              {
                allocationId: "allocation-general",
                requirementId: genericRequirement.id,
                matchedUnits: 2,
              },
            ];
          }
          if (isRequirementTagLookup(call.sql)) return [genericRequirement];
          return [];
        },
        resolveBatch(statements) {
          return statements.map(() => ({
            success: true,
            results: [],
            meta: { changes: 1 },
          }));
        },
      });
      testCloudflareEnv.DB = successDatabase;
      const updateResponse = await postWorkspace("updateActivity", {
        activityId,
        expectedRevision: 3,
        title: "Corrected course title",
        provider: "Corrected Provider",
        completionDate: "2027-05-21",
        totalUnits: 3,
      });
      assert.equal(updateResponse.status, 200);
      assert.deepEqual(await updateResponse.json(), {
        ok: true,
        action: "updateActivity",
        id: activityId,
      });
      const correctionBatch = successDatabase.batches.at(-1);
      assert.equal(correctionBatch.length, 3);
      const allocationCorrection = correctionBatch[0];
      const matchCorrection = correctionBatch[1];
      const activityCorrection = correctionBatch[2];
      assert.match(
        allocationCorrection.sql,
        /SET allocated_units = CASE WHEN EXISTS \([\s\S]*?rule_set_id LIKE 'nremt-%'[\s\S]*?THEN MIN\(allocated_units, \?\) WHEN allocated_units = \? THEN \? ELSE MIN\(allocated_units, \?\) END/i,
      );
      assert.deepEqual(allocationCorrection.bindings, [
        3,
        2,
        3,
        3,
        activityId,
        activityId,
        userId,
        3,
      ]);
      assert.match(
        matchCorrection.sql,
        /SET matched_units = \( SELECT allocation\.allocated_units/i,
      );
      assert.match(
        matchCorrection.sql,
        /credentials\.rule_set_id NOT LIKE 'nremt-%'/i,
      );
      assert.deepEqual(activityCorrection.bindings, [
        "Corrected course title",
        "Corrected Provider",
        "2027-05-21",
        3,
        activityId,
        userId,
        3,
      ]);
      assert.match(activityCorrection.sql, /revision = revision \+ 1/i);
      assert.match(
        activityCorrection.sql,
        /guarded_credential\.status NOT IN \('active', 'submitted'\)/i,
      );

      const crossOwnerDatabase = new FakeDatabase();
      testCloudflareEnv.DB = crossOwnerDatabase;
      const crossOwnerResponse = await postWorkspace("updateActivity", {
        activityId: "activity-other-owner",
        expectedRevision: 1,
        title: "Unauthorized correction",
        provider: "",
        completionDate: "2027-05-20",
        totalUnits: 1,
      });
      assert.equal(crossOwnerResponse.status, 404);
      assert.deepEqual(await crossOwnerResponse.json(), {
        error: "Activity not found.",
        code: "activity_not_found",
      });
      assert.equal(hasActivityMutationWrite(crossOwnerDatabase), false);

      const staleDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (isActivityMutationLookup(call.sql)) {
            return { ...activeActivity, revision: 4 };
          }
          return null;
        },
      });
      testCloudflareEnv.DB = staleDatabase;
      const staleResponse = await postWorkspace("updateActivity", {
        activityId,
        expectedRevision: 3,
        title: "Stale correction",
        provider: "Original Provider",
        completionDate: "2027-05-20",
        totalUnits: 2,
      });
      assert.equal(staleResponse.status, 409);
      assert.deepEqual(await staleResponse.json(), {
        error:
          "This learning record changed in another session. Refresh and try again.",
        code: "activity_version_conflict",
      });
      assert.equal(hasActivityMutationWrite(staleDatabase), false);

      const makeArchiveDatabase = ({ archivedAt, revision }) =>
        new FakeDatabase({
          resolveFirst(call) {
            if (isActivityMutationLookup(call.sql)) {
              return { ...activeActivity, archivedAt, revision };
            }
            return null;
          },
          resolveRun(call) {
            if (/^UPDATE activities SET archived_at =/i.test(call.sql)) {
              return { success: true, results: [], meta: { changes: 1 } };
            }
            return undefined;
          },
        });
      const archiveDatabase = makeArchiveDatabase({
        archivedAt: null,
        revision: 4,
      });
      testCloudflareEnv.DB = archiveDatabase;
      const archiveResponse = await postWorkspace("archiveActivity", {
        activityId,
        expectedRevision: 4,
      });
      assert.equal(archiveResponse.status, 200);
      const archiveWrite = archiveDatabase.calls.find(
        (call) =>
          call.method === "run" &&
          /^UPDATE activities SET archived_at = CURRENT_TIMESTAMP/i.test(
            call.sql,
          ),
      );
      assert.ok(archiveWrite);
      assert.deepEqual(archiveWrite.bindings, [activityId, userId, 4]);
      assert.match(archiveWrite.sql, /revision = revision \+ 1/i);
      assert.match(
        archiveWrite.sql,
        /deleting_evidence\.status = 'deleting'/i,
      );
      assert.match(
        archiveWrite.sql,
        /guarded_credential\.status NOT IN \('active', 'submitted'\)/i,
      );

      const restoreDatabase = makeArchiveDatabase({
        archivedAt: "2027-06-01 12:00:00",
        revision: 5,
      });
      testCloudflareEnv.DB = restoreDatabase;
      const restoreResponse = await postWorkspace("restoreActivity", {
        activityId,
        expectedRevision: 5,
      });
      assert.equal(restoreResponse.status, 200);
      const restoreWrite = restoreDatabase.calls.find(
        (call) =>
          call.method === "run" &&
          /^UPDATE activities SET archived_at = NULL/i.test(call.sql),
      );
      assert.ok(restoreWrite);
      assert.deepEqual(restoreWrite.bindings, [activityId, userId, 5]);
      assert.match(restoreWrite.sql, /archived_at IS NOT NULL/i);
      assert.match(restoreWrite.sql, /revision = revision \+ 1/i);

      const makeClosedDatabase = (archivedAt) =>
        new FakeDatabase({
          resolveFirst(call) {
            if (isActivityMutationLookup(call.sql)) {
              return {
                ...activeActivity,
                archivedAt,
                revision: 7,
              };
            }
            return null;
          },
          resolveAll(call) {
            if (isAllocationValidationLookup(call.sql)) {
              return [
                {
                  id: "allocation-closed",
                  credentialId: "credential-closed",
                  requirementId: null,
                  allocatedUnits: 2,
                  ruleSetId: null,
                  credentialStatus: "renewed",
                  cycleStart: "2027-01-01",
                  deadline: "2027-12-31",
                },
              ];
            }
            return [];
          },
        });
      const closedCases = [
        {
          action: "updateActivity",
          archivedAt: null,
          payload: {
            activityId,
            expectedRevision: 7,
            title: "Closed correction",
            provider: "Original Provider",
            completionDate: "2027-05-20",
            totalUnits: 2,
          },
        },
        {
          action: "archiveActivity",
          archivedAt: null,
          payload: { activityId, expectedRevision: 7 },
        },
        {
          action: "restoreActivity",
          archivedAt: "2027-06-01 12:00:00",
          payload: { activityId, expectedRevision: 7 },
        },
      ];
      for (const closedCase of closedCases) {
        const closedDatabase = makeClosedDatabase(closedCase.archivedAt);
        testCloudflareEnv.DB = closedDatabase;
        const response = await postWorkspace(
          closedCase.action,
          closedCase.payload,
        );
        assert.equal(response.status, 409, closedCase.action);
        assert.equal((await response.json()).code, "cycle_closed");
        assert.equal(
          closedDatabase.calls.some(
            (call) =>
              call.method === "run" &&
              /^UPDATE activities SET/i.test(call.sql),
          ),
          false,
          `${closedCase.action} must not mutate a closed-cycle activity`,
        );
        assert.equal(hasActivityMutationWrite(closedDatabase), false);
      }

      const nremtRequirements = [
        {
          id: "nremt-national",
          name: "National Component",
          ruleCategoryId: "nremt-emt-2025-national",
          relation: "independent",
          parentRequirementId: null,
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: "nremt-emt-2025-component",
        },
        {
          id: "nremt-local",
          name: "Local or State Component",
          ruleCategoryId: "nremt-emt-2025-local",
          relation: "independent",
          parentRequirementId: null,
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: "nremt-emt-2025-component",
        },
        {
          id: "nremt-individual",
          name: "Individual Component",
          ruleCategoryId: "nremt-emt-2025-individual",
          relation: "independent",
          parentRequirementId: null,
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: "nremt-emt-2025-component",
        },
        ...[
          "airway",
          "cardiology",
          "trauma",
          "medical",
          "operations",
        ].map((topic) => ({
          id: `nremt-${topic}`,
          name: topic,
          ruleCategoryId: `nremt-emt-2025-national-${topic}`,
          relation: "nested",
          parentRequirementId: "nremt-national",
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: null,
        })),
        {
          id: "nremt-pediatric",
          name: "Pediatric",
          ruleCategoryId: "nremt-emt-2025-national-pediatric",
          relation: "overlapping",
          parentRequirementId: null,
          isActive: 1,
          applicabilityStatus: "applies",
          exclusiveGroup: null,
        },
      ];
      const makeNremtDatabase = () =>
        new FakeDatabase({
          resolveFirst(call) {
            if (isActivityMutationLookup(call.sql)) return activeActivity;
            if (
              /SELECT 1 AS isNremt FROM activity_allocations allocation JOIN credentials credential/i.test(
                call.sql,
              )
            ) {
              return { isNremt: 1 };
            }
            return null;
          },
          resolveAll(call) {
            if (isAllocationValidationLookup(call.sql)) {
              return [
                {
                  id: "allocation-nremt",
                  credentialId: "credential-nremt",
                  requirementId: "nremt-national",
                  allocatedUnits: 2,
                  ruleSetId: "nremt-emt-2025-v1",
                  credentialStatus: "active",
                  cycleStart: "2027-01-01",
                  deadline: "2027-12-31",
                },
              ];
            }
            if (isMatchValidationLookup(call.sql)) {
              return [
                {
                  allocationId: "allocation-nremt",
                  requirementId: "nremt-national",
                  matchedUnits: 2,
                },
                {
                  allocationId: "allocation-nremt",
                  requirementId: "nremt-airway",
                  matchedUnits: 2,
                },
              ];
            }
            if (
              /FROM credential_requirements requirement JOIN credentials credential ON credential\.id = requirement\.credential_id WHERE requirement\.credential_id = \? AND credential\.user_id = \?/i.test(
                call.sql,
              )
            ) {
              return nremtRequirements;
            }
            return [];
          },
          resolveBatch(statements) {
            return statements.map(() => ({
              success: true,
              results: [],
              meta: { changes: 1 },
            }));
          },
        });

      const unattestedCorrectionDatabase = makeNremtDatabase();
      testCloudflareEnv.DB = unattestedCorrectionDatabase;
      const unattestedCorrection = await postWorkspace("updateActivity", {
        activityId,
        expectedRevision: 3,
        title: "Unattested National Registry correction",
        provider: "Original Provider",
        completionDate: "2027-05-20",
        totalUnits: 2,
      });
      assert.equal(unattestedCorrection.status, 409);
      assert.equal(
        (await unattestedCorrection.json()).code,
        "nremt_accepted_education_attestation_required",
      );
      const nremtCorrectionLookup =
        unattestedCorrectionDatabase.calls.find(
          (call) =>
            call.method === "first" &&
            /SELECT 1 AS isNremt FROM activity_allocations allocation JOIN credentials credential/i.test(
              call.sql,
            ),
        );
      assert.ok(nremtCorrectionLookup);
      assert.deepEqual(nremtCorrectionLookup.bindings, [
        activityId,
        userId,
      ]);
      assert.equal(
        hasActivityMutationWrite(unattestedCorrectionDatabase),
        false,
      );

      const exactDatabase = makeNremtDatabase();
      testCloudflareEnv.DB = exactDatabase;
      const exactResponse = await postWorkspace("updateActivity", {
        activityId,
        expectedRevision: 3,
        title: "Corrected National Registry title",
        provider: "Original Provider",
        completionDate: "2027-05-20",
        totalUnits: 2,
        acceptedEducationAttested: true,
      });
      assert.equal(exactResponse.status, 200);
      assert.match(
        exactDatabase.batches.at(-1)[1].sql,
        /credentials\.rule_set_id NOT LIKE 'nremt-%'/i,
        "metadata-only corrections must retain exact National Registry amounts",
      );

      const closedNremtDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (isActivityMutationLookup(call.sql)) return activeActivity;
          if (
            /SELECT 1 AS isNremt FROM activity_allocations allocation JOIN credentials credential/i.test(
              call.sql,
            )
          ) {
            return { isNremt: 1 };
          }
          return null;
        },
        resolveAll(call) {
          if (isAllocationValidationLookup(call.sql)) {
            return [
              {
                id: "allocation-nremt-closed",
                credentialId: "credential-nremt-closed",
                requirementId: "nremt-national",
                allocatedUnits: 2,
                ruleSetId: "nremt-emt-2025-v1",
                credentialStatus: "renewed",
                cycleStart: "2027-01-01",
                deadline: "2027-12-31",
              },
            ];
          }
          return [];
        },
      });
      testCloudflareEnv.DB = closedNremtDatabase;
      const closedNremtResponse = await postWorkspace("updateActivity", {
        activityId,
        expectedRevision: 3,
        title: "Closed National Registry correction",
        provider: "",
        completionDate: "2027-05-20",
        totalUnits: 2,
      });
      assert.equal(closedNremtResponse.status, 409);
      assert.equal((await closedNremtResponse.json()).code, "cycle_closed");
      assert.equal(hasActivityMutationWrite(closedNremtDatabase), false);

      const expandedDatabase = makeNremtDatabase();
      testCloudflareEnv.DB = expandedDatabase;
      const expandedResponse = await postWorkspace("updateActivity", {
        activityId,
        expectedRevision: 3,
        title: "Invalid total-only National Registry correction",
        provider: "Original Provider",
        completionDate: "2027-05-20",
        totalUnits: 3,
        acceptedEducationAttested: true,
      });
      assert.equal(expandedResponse.status, 200);
      const expandedAllocationWrite = expandedDatabase.batches.at(-1)[0];
      assert.match(
        expandedAllocationWrite.sql,
        /rule_set_id LIKE 'nremt-%'[\s\S]*?THEN MIN\(allocated_units, \?\)/i,
      );
      assert.equal(
        expandedAllocationWrite.bindings[0],
        3,
        "raising the activity total must retain the exact two-unit National Registry allocation",
      );

      const reducedDatabase = makeNremtDatabase();
      testCloudflareEnv.DB = reducedDatabase;
      const reducedResponse = await postWorkspace("updateActivity", {
        activityId,
        expectedRevision: 3,
        title: "Invalid National Registry reduction",
        provider: "Original Provider",
        completionDate: "2027-05-20",
        totalUnits: 1,
        acceptedEducationAttested: true,
      });
      assert.equal(reducedResponse.status, 409);
      assert.equal(
        (await reducedResponse.json()).code,
        "nremt_allocation_revision_required",
      );
      assert.equal(hasActivityMutationWrite(reducedDatabase), false);
    },
  );

  await t.test(
    "supports personal task CRUD while keeping managed tasks immutable and XP-free",
    async () => {
      const userId = await expectedStableUserId("owner@example.com");
      const taskId = "personal-task";
      const isTaskMutationLookup = (sql) =>
        /SELECT task\.id, task\.credential_id AS credentialId, task\.revision, task\.is_personal AS isPersonal, task\.archived_at AS archivedAt, credential\.status AS credentialStatus FROM checklist_tasks task/i.test(
          sql,
        );
      const successfulRun = {
        success: true,
        results: [],
        meta: { changes: 1 },
      };
      const assertNoTaskXp = (database) => {
        assert.equal(
          database.calls.some((call) => /xp_events/i.test(call.sql)),
          false,
        );
      };

      const createDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (
            /SELECT id, status FROM credentials WHERE id = \? AND user_id = \?/i.test(
              call.sql,
            )
          ) {
            return { id: "credential-personal", status: "active" };
          }
          if (
            /SELECT COUNT\(\*\) AS count FROM checklist_tasks/i.test(call.sql)
          ) {
            return { count: 0 };
          }
          return null;
        },
        resolveRun(call) {
          if (/^INSERT INTO checklist_tasks \(/i.test(call.sql)) {
            return successfulRun;
          }
          return undefined;
        },
      });
      testCloudflareEnv.DB = createDatabase;
      const createResponse = await postWorkspace("createPersonalTask", {
        credentialId: "credential-personal",
        title: "Request transcript",
        dueDate: "",
      });
      assert.equal(createResponse.status, 200);
      const createdTaskId = (await createResponse.json()).id;
      const createWrite = createDatabase.calls.find(
        (call) =>
          call.method === "run" &&
          /^INSERT INTO checklist_tasks \(/i.test(call.sql),
      );
      assert.ok(createWrite);
      assert.equal(createWrite.bindings[0], createdTaskId);
      assert.deepEqual(createWrite.bindings.slice(1), [
        "Request transcript",
        null,
        "credential-personal",
        userId,
      ]);
      assert.match(
        createWrite.sql,
        /'personal', 'pending', \?, NULL,[\s\S]*?1, 1, NULL/i,
      );
      assert.match(
        createWrite.sql,
        /credential\.status IN \('active', 'submitted'\)/i,
      );
      assert.match(createWrite.sql, /\) < 50/i);
      assertNoTaskXp(createDatabase);

      const makeTaskDatabase = ({
        revision,
        isPersonal = 1,
        archivedAt = null,
        resolveBatch,
      }) =>
        new FakeDatabase({
          resolveFirst(call) {
            if (isTaskMutationLookup(call.sql)) {
              return {
                id: taskId,
                credentialId: "credential-personal",
                revision,
                isPersonal,
                archivedAt,
                credentialStatus: "active",
              };
            }
            return null;
          },
          resolveRun(call) {
            if (/^UPDATE checklist_tasks SET/i.test(call.sql)) {
              return successfulRun;
            }
            return undefined;
          },
          resolveBatch:
            resolveBatch ??
            ((statements) =>
              statements.map(() => ({
                success: true,
                results: [],
                meta: { changes: 1 },
              }))),
        });

      const updateDatabase = makeTaskDatabase({ revision: 1 });
      testCloudflareEnv.DB = updateDatabase;
      const updateResponse = await postWorkspace("updatePersonalTask", {
        taskId,
        expectedRevision: 1,
        title: "Request official transcript",
        dueDate: "2027-08-15",
      });
      assert.equal(updateResponse.status, 200);
      const updateWrite = updateDatabase.calls.find(
        (call) =>
          call.method === "run" &&
          /^UPDATE checklist_tasks SET title = \?/i.test(call.sql),
      );
      assert.ok(updateWrite);
      assert.deepEqual(updateWrite.bindings, [
        "Request official transcript",
        "2027-08-15",
        taskId,
        userId,
        1,
      ]);
      assert.match(updateWrite.sql, /is_personal = 1/i);
      assert.match(updateWrite.sql, /revision = revision \+ 1/i);
      assert.match(updateWrite.sql, /archived_at IS NULL/i);
      assertNoTaskXp(updateDatabase);

      const toggleDatabase = makeTaskDatabase({ revision: 2 });
      testCloudflareEnv.DB = toggleDatabase;
      const toggleResponse = await postWorkspace("toggleTask", {
        taskId,
        expectedRevision: 2,
        completed: true,
      });
      assert.equal(toggleResponse.status, 200);
      const toggleBatch = toggleDatabase.batches.at(-1);
      assert.equal(
        toggleBatch.length,
        1,
        "personal task completion must not enqueue an XP write",
      );
      assert.match(toggleBatch[0].sql, /revision = revision \+ 1/i);
      assert.deepEqual(toggleBatch[0].bindings.slice(-3), [
        taskId,
        userId,
        2,
      ]);
      assertNoTaskXp(toggleDatabase);

      const archiveDatabase = makeTaskDatabase({ revision: 3 });
      testCloudflareEnv.DB = archiveDatabase;
      const archiveResponse = await postWorkspace("archivePersonalTask", {
        taskId,
        expectedRevision: 3,
      });
      assert.equal(archiveResponse.status, 200);
      const archiveWrite = archiveDatabase.calls.find(
        (call) =>
          call.method === "run" &&
          /^UPDATE checklist_tasks SET archived_at = CURRENT_TIMESTAMP/i.test(
            call.sql,
          ),
      );
      assert.ok(archiveWrite);
      assert.deepEqual(archiveWrite.bindings, [taskId, userId, 3]);
      assert.match(archiveWrite.sql, /is_personal = 1/i);
      assert.match(archiveWrite.sql, /revision = revision \+ 1/i);
      assertNoTaskXp(archiveDatabase);

      const restoreDatabase = makeTaskDatabase({
        revision: 4,
        archivedAt: "2027-08-20 12:00:00",
      });
      testCloudflareEnv.DB = restoreDatabase;
      const restoreResponse = await postWorkspace("restorePersonalTask", {
        taskId,
        expectedRevision: 4,
      });
      assert.equal(restoreResponse.status, 200);
      const restoreWrite = restoreDatabase.calls.find(
        (call) =>
          call.method === "run" &&
          /^UPDATE checklist_tasks SET archived_at = NULL/i.test(call.sql),
      );
      assert.ok(restoreWrite);
      assert.deepEqual(restoreWrite.bindings, [taskId, userId, 4]);
      assert.match(restoreWrite.sql, /archived_at IS NOT NULL/i);
      assert.match(restoreWrite.sql, /\) < 50/i);
      assertNoTaskXp(restoreDatabase);

      for (const action of ["updatePersonalTask", "archivePersonalTask"]) {
        const managedDatabase = makeTaskDatabase({
          revision: 1,
          isPersonal: 0,
        });
        testCloudflareEnv.DB = managedDatabase;
        const response = await postWorkspace(
          action,
          action === "updatePersonalTask"
            ? {
                taskId,
                expectedRevision: 1,
                title: "Attempted managed edit",
                dueDate: null,
              }
            : { taskId, expectedRevision: 1 },
        );
        assert.equal(response.status, 409, action);
        assert.deepEqual(await response.json(), {
          error: "Managed renewal tasks cannot be edited or archived.",
          code: "managed_task_immutable",
        });
        assert.equal(
          managedDatabase.calls.some(
            (call) =>
              call.method === "run" &&
              /^UPDATE checklist_tasks SET/i.test(call.sql),
          ),
          false,
        );
        assertNoTaskXp(managedDatabase);
      }
    },
  );

  await t.test(
    "keeps failed R2 evidence deletion tombstoned and retries it durably",
    async () => {
      const userId = await expectedStableUserId("owner@example.com");
      const evidenceId = "9f45f407-6424-47d2-9e4d-6e5971014701";
      const activityId = "activity-evidence-rollback";
      const objectKey = `evidence/${userId}/${activityId}/${evidenceId}`;
      const evidenceRow = {
        id: evidenceId,
        activityId,
        objectKey,
        originalFilename: "certificate.pdf",
        contentType: "application/pdf",
        sizeBytes: 9,
        sha256: "proof-sha",
        storageEtag: "proof-etag",
        createdAt: "2027-05-20T12:00:00.000Z",
      };
      const isDeletionLookup = (sql) =>
        /FROM evidence_files WHERE id = \? AND user_id = \? AND status IN \('ready', 'deleting'\)/i.test(
          sql,
        );

      class FailingDeleteBucket extends FakeEvidenceBucket {
        async delete(keyOrKeys) {
          const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
          this.deletes.push(...keys);
          throw new Error("simulated R2 delete failure");
        }
      }

      const failingBucket = new FailingDeleteBucket();
      const tombstoneDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (isDeletionLookup(call.sql)) {
            return { ...evidenceRow, status: "ready" };
          }
          if (isOwnedMutableActivityLookup(call.sql)) {
            return {
              id: activityId,
              archivedAt: null,
              usedByClosedCycle: 0,
            };
          }
          return null;
        },
        resolveBatch(statements) {
          return statements.map(() => ({
            success: true,
            results: [],
            meta: { changes: 1 },
          }));
        },
      });
      testCloudflareEnv.DB = tombstoneDatabase;
      testCloudflareEnv.EVIDENCE = failingBucket;
      const failedResponse = await fetchWorker(
        `https://license-lantern.example/api/evidence/${evidenceId}`,
        {
          method: "DELETE",
          headers: authHeaders(),
        },
      );
      assert.equal(failedResponse.status, 503);
      assert.deepEqual(await failedResponse.json(), {
        error:
          "The proof file is queued for removal. Retry removal when storage is available.",
        code: "evidence_delete_retry",
      });
      assert.deepEqual(failingBucket.deletes, [objectKey]);
      const transitionBatch = tombstoneDatabase.batches.find((batch) =>
        /^UPDATE evidence_files SET status = 'deleting'/i.test(batch[0]?.sql),
      );
      const rollbackBatch = tombstoneDatabase.batches.find((batch) =>
        /^UPDATE evidence_files SET status = 'ready'/i.test(batch[0]?.sql),
      );
      assert.ok(transitionBatch);
      assert.equal(transitionBatch.length, 2);
      assert.match(transitionBatch[1].sql, /revision = revision \+ 1/i);
      assert.equal(
        rollbackBatch,
        undefined,
        "storage failure must preserve the logical deletion tombstone for retry",
      );

      const retryBucket = new FakeEvidenceBucket();
      const retryDatabase = new FakeDatabase({
        resolveFirst(call) {
          if (isDeletionLookup(call.sql)) {
            return { ...evidenceRow, status: "deleting" };
          }
          return null;
        },
        resolveRun(call) {
          if (/^DELETE FROM evidence_files/i.test(call.sql)) {
            return { success: true, results: [], meta: { changes: 1 } };
          }
          return undefined;
        },
      });
      testCloudflareEnv.DB = retryDatabase;
      testCloudflareEnv.EVIDENCE = retryBucket;
      const retryResponse = await fetchWorker(
        `https://license-lantern.example/api/evidence/${evidenceId}`,
        {
          method: "DELETE",
          headers: authHeaders(),
        },
      );
      assert.equal(retryResponse.status, 200);
      assert.deepEqual(await retryResponse.json(), {
        ok: true,
        id: evidenceId,
      });
      assert.deepEqual(retryBucket.deletes, [objectKey]);
      assert.equal(
        retryDatabase.batches.some((batch) =>
          /^UPDATE evidence_files SET status = 'deleting'/i.test(
            batch[0]?.sql,
          ),
        ),
        false,
        "a durable tombstone retry must not require the activity to remain mutable",
      );
      const tombstoneDelete = retryDatabase.calls.find(
        (call) =>
          call.method === "run" &&
          /^DELETE FROM evidence_files/i.test(call.sql),
      );
      assert.ok(tombstoneDelete);
      assert.deepEqual(tombstoneDelete.bindings, [
        evidenceId,
        userId,
        activityId,
      ]);
      assert.match(tombstoneDelete.sql, /status = 'deleting'/i);
    },
  );
});
