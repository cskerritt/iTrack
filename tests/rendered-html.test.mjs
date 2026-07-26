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
  return /SELECT requirement\.id, requirement\.name,[\s\S]*?requirement\.is_active AS isActive,[\s\S]*?requirement\.applicability_status AS applicabilityStatus,[\s\S]*?requirement\.exclusive_group AS exclusiveGroup FROM credential_requirements requirement JOIN credentials credential[\s\S]*?requirement\.id IN \(/i.test(
    sql,
  );
}

function isRequiredMaximumGroupLookup(sql) {
  return /SELECT DISTINCT requirement\.exclusive_group AS exclusiveGroup FROM credential_requirements requirement JOIN credentials credential[\s\S]*?requirement\.kind = 'maximum'[\s\S]*?requirement\.exclusive_group IS NOT NULL/i.test(
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
    "builds safe all-day calendar files with escaping and Unicode-aware folding",
    async () => {
      const calendarSource = await readFile(
        new URL("../app/lib/calendarInvite.ts", import.meta.url),
        "utf8",
      );
      const calendarModule = await importTypeScriptModule(calendarSource);
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
        assert.match(source, /Add renewal dates to calendar/);
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
        /date:\s*reminder\.eventDate/,
      );
      assert.match(
        clientSource,
        /date:\s*credential\.deadline/,
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

    const migration = `${baseMigration}\n${evidenceMigration}\n${lifecycleMigration}\n${richRuleMigration}\n${progressionMigration}\n${exclusiveGroupMigration}\n${attestationMigration}`;
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
      "0006_graceful_jackal",
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
      migration,
      /FOREIGN KEY \(`user_id`\) REFERENCES `users`\(`id`\)[\s\S]*?ON DELETE cascade/i,
    );
  });

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
            /SELECT[\s\S]*?task\.id,[\s\S]*?task\.credential_id AS credentialId,[\s\S]*?credential\.status AS credentialStatus[\s\S]*?FROM checklist_tasks task/i.test(
              call.sql,
            )
          ) {
            return {
              id: call.bindings[0],
              credentialId: "credential-task-stable",
              credentialStatus: "active",
            };
          }
          return null;
        },
      });
      testCloudflareEnv.DB = taskDatabase;
      for (const completed of [true, false, true]) {
        const response = await postWorkspace("toggleTask", {
          taskId: "task-stable",
          completed,
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
    "keeps thirteen additional official templates bounded and internally coherent",
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
          "ca-pharmacist-2026-v1",
          "ca-pharmacist-standard",
          "Pharmacy",
          "Pharmacist — standard active renewal",
          "California",
          "California State Board of Pharmacy",
          30,
          "CE hours",
          24,
          "source_linked_check_conditions",
          "www.pharmacy.ca.gov",
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
        ["ca-pharmacist-2026-v1", null],
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
        14,
        "thirteen current rules plus one hidden CFP transition rule are expected",
      );
      assert.equal(
        [...categorySource.matchAll(/\n  \[\n    "/g)].length,
        60,
        "fifty-six current categories plus four hidden CFP transition categories are expected",
      );
      assert.equal(
        [...globalSeedSource.matchAll(/INSERT OR IGNORE INTO rule_sets/g)]
          .length + expectedRules.length,
        36,
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
          "ca-pharmacist-2026-law-webinar",
          "ca-pharmacist-2026-v1",
          1,
          "minimum",
          "independent",
          "always",
          "California pharmacist mandatory course",
        ],
        [
          "ca-pharmacist-2026-ethics-webinar",
          "ca-pharmacist-2026-v1",
          1,
          "minimum",
          "independent",
          "always",
          "California pharmacist mandatory course",
        ],
        [
          "ca-pharmacist-2026-cultural-competency",
          "ca-pharmacist-2026-v1",
          1,
          "minimum",
          "independent",
          "always",
          "California pharmacist mandatory course",
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
      assert.equal(new Set(categoryRows.map((category) => category[0])).size, 56);
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
      for (const rule of expectedRules.slice(0, 8)) {
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
    "seeds current ISC2, CompTIA, and state insurance templates with bounded rule graphs",
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
        { totalRules: 76, currentRules: 75 },
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
        /COMPLIANCE_PERIOD_RULE_SET_PREFIXES[\s\S]*?fl-insurance-producer-[\s\S]*?Verify official compliance status and save portal proof[\s\S]*?renewal_checkpoint_recorded[\s\S]*?compliance_checkpoint/,
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
        "activity-owner",
        upload.key,
      ]);
      assert.deepEqual(activityUpdate.bindings, [
        "ethics-certificate.pdf",
        "activity-owner",
        userId,
      ]);
      assert.deepEqual(evidenceXpInsert.bindings.slice(1), [
        userId,
        `${userId}:activity:activity-owner:evidence-attached`,
        "activity-owner",
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
          /^UPDATE credential_requirements SET applicability_status = \?, is_active = \?/i.test(
            statement.sql,
          ),
      );
      assert.ok(applicabilityUpdate);
      assert.match(
        applicabilityUpdate.sql,
        /WHERE id = \? AND credential_id = \? AND EXISTS \( SELECT 1 FROM credentials credential[\s\S]*?credential\.user_id = \? AND credential\.status IN \('active', 'submitted'\) \)/i,
      );
      assert.deepEqual(applicabilityUpdate.bindings, [
        "applies",
        1,
        "requirement-special-role",
        "credential-rich",
        userId,
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
      assert.equal(catchAllMatches[0].bindings[3], "requirement-other");
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
                status: "active",
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
        userId,
      ]);
      assert.deepEqual(priorMatchDelete.bindings, [
        "allocation-legacy",
        userId,
        userId,
      ]);
      assert.deepEqual(replacementMatch.bindings.slice(1), [
        userId,
        "requirement-other",
        "allocation-legacy",
        "credential-arrt",
        userId,
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
              status: "submitted",
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
      assert.ok(checkpointXp.bindings.includes("renewal_checkpoint_recorded"));
      assert.ok(checkpointXp.bindings.includes("compliance_checkpoint"));
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
        requirementIds[0],
        3,
        "credential-second",
        userId,
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

        raw
          .prepare(
            `DELETE FROM activity_requirement_matches
             WHERE allocation_id = 'allocation-nasm-real'`,
          )
          .run();
        raw
          .prepare(
            `UPDATE activity_allocations
             SET requirement_id = NULL
             WHERE id = 'allocation-nasm-real'`,
          )
          .run();
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
      assert.deepEqual(oldCycleUpdate.bindings.slice(-4), [
        "credential-prior",
        userId,
        "submission-prior",
        "2028-02-25",
      ]);
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
});
