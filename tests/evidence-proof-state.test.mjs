import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const [
  nextConfigSource,
  evidenceSharedSource,
  uploadSource,
  deleteSource,
  runtimeSource,
] = await Promise.all([
  readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/evidence/_shared.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/evidence/route.ts", import.meta.url), "utf8"),
  readFile(
    new URL("../app/api/evidence/[id]/route.ts", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../db/runtime.ts", import.meta.url), "utf8"),
]);

async function importTypeScriptModule(source) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(
    `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
  );
}

// `10 * 1024 * 1024` and friends, without evaluating arbitrary source.
function multiplicativeExpression(expression) {
  const factors = expression.split("*").map((factor) => Number(factor.trim()));
  assert.ok(
    factors.every((factor) => Number.isFinite(factor)),
    `expected a numeric literal expression, received ${expression}`,
  );
  return factors.reduce((total, factor) => total * factor, 1);
}

// Mirrors vinext's parseBodySizeLimit (config/next-config.js), which turns
// experimental.serverActions.bodySizeLimit into __MAX_ACTION_BODY_SIZE.
const BODY_SIZE_UNITS = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
};

function parseBodySizeLimit(value) {
  if (value === undefined || value === null) return 1024 * 1024;
  if (typeof value === "number") return value;
  const match = String(value)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i);
  assert.ok(match, `unsupported bodySizeLimit value ${value}`);
  const unit = BODY_SIZE_UNITS[(match[2] ?? "b").toLowerCase()];
  return Math.floor(Number(match[1]) * unit);
}

// The batched `UPDATE activities …` statement each evidence route runs. Both
// literals are plain template strings, so slicing to the closing backtick keeps
// the test bound to the SQL that actually ships.
function activityUpdateSql(source) {
  const start = source.indexOf("`UPDATE activities");
  assert.notEqual(start, -1, "expected an UPDATE activities statement");
  const end = source.indexOf("`", start + 1);
  assert.notEqual(end, -1, "expected a terminated template literal");
  return source.slice(start + 1, end);
}

const uploadUpdateSql = activityUpdateSql(uploadSource);
const removeUpdateSql = activityUpdateSql(deleteSource);

const USER_ID = "usr_test";
const ACTIVITY_ID = "activity-test";

function seededDatabase(activity) {
  const database = new DatabaseSync(":memory:");
  for (const [, statement] of runtimeSource.matchAll(
    /`(CREATE TABLE IF NOT EXISTS [\s\S]*?)`/g,
  )) {
    database.exec(statement);
  }
  database
    .prepare(
      `INSERT INTO users (id, email, display_name)
       VALUES (?, 'owner@example.com', 'Casey Owner')`,
    )
    .run(USER_ID);
  database
    .prepare(
      `INSERT INTO activities (
        id, user_id, title, provider, completion_date, total_units,
        evidence_status, evidence_reference
      ) VALUES (?, ?, 'Ethics', 'Provider', '2026-05-01', 3, ?, ?)`,
    )
    .run(
      ACTIVITY_ID,
      USER_ID,
      activity.evidenceStatus,
      activity.evidenceReference ?? null,
    );
  return database;
}

function attachEvidence(database, id, filename, createdAt, status = "ready") {
  database
    .prepare(
      `INSERT INTO evidence_files (
        id, user_id, activity_id, object_key, original_filename,
        content_type, size_bytes, sha256, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'application/pdf', 1024, ?, ?, ?)`,
    )
    .run(
      id,
      USER_ID,
      ACTIVITY_ID,
      `evidence/${USER_ID}/${ACTIVITY_ID}/${id}`,
      filename,
      `sha-${id}`,
      status,
      createdAt,
    );
}

function activityRow(database) {
  const row = database
    .prepare(
      `SELECT evidence_status AS evidenceStatus,
              evidence_reference AS evidenceReference
       FROM activities WHERE id = ?`,
    )
    .get(ACTIVITY_ID);
  return { ...row };
}

function runUpload(database, evidenceId, filename) {
  return database
    .prepare(uploadUpdateSql)
    .run(filename, ACTIVITY_ID, USER_ID, evidenceId);
}

function runRemove(database, evidenceId) {
  database
    .prepare(
      `UPDATE evidence_files SET status = 'deleting'
       WHERE id = ? AND user_id = ? AND activity_id = ?`,
    )
    .run(evidenceId, USER_ID, ACTIVITY_ID);
  return database.prepare(removeUpdateSql).run(ACTIVITY_ID, USER_ID, evidenceId);
}

test("evidence uploads survive the server action body cap", async () => {
  const nextConfig = (await importTypeScriptModule(nextConfigSource)).default;
  const configuredLimit = parseBodySizeLimit(
    nextConfig?.experimental?.serverActions?.bodySizeLimit,
  );

  const maxEvidenceBytes = multiplicativeExpression(
    /export const MAX_EVIDENCE_BYTES = ([\d*\s]+);/.exec(
      evidenceSharedSource,
    )[1],
  );
  const multipartOverhead = multiplicativeExpression(
    /contentLength > MAX_EVIDENCE_BYTES \+ ([\d*\s]+)/.exec(uploadSource)[1],
  );

  // POST /api/evidence is multipart with no action id, so the app router
  // screens it against this cap before the route handler ever runs. Anything at
  // or below the default 1 MiB turns realistic certificate photos into a bare
  // text/plain 413.
  assert.ok(
    configuredLimit > maxEvidenceBytes + multipartOverhead,
    `server action body limit ${configuredLimit} must exceed the evidence route budget ${
      maxEvidenceBytes + multipartOverhead
    }`,
  );
  assert.ok(configuredLimit > 8 * 1024 * 1024);
});

test("attaching proof keeps a not-required activity not required", async () => {
  const database = seededDatabase({ evidenceStatus: "not_required" });
  attachEvidence(database, "ev-1", "courtesy.pdf", "2026-07-01T00:00:00Z");
  assert.equal(runUpload(database, "ev-1", "courtesy.pdf").changes, 1);
  assert.deepEqual(activityRow(database), {
    evidenceStatus: "not_required",
    evidenceReference: "courtesy.pdf",
  });
  database.close();
});

test("attaching proof keeps a user-entered evidence reference", async () => {
  const database = seededDatabase({
    evidenceStatus: "missing",
    evidenceReference: "Cert #ABC-123",
  });
  attachEvidence(database, "ev-1", "first.pdf", "2026-07-01T00:00:00Z");
  runUpload(database, "ev-1", "first.pdf");
  assert.deepEqual(activityRow(database), {
    evidenceStatus: "attached",
    evidenceReference: "Cert #ABC-123",
  });
  database.close();
});

test("attaching proof keeps a CRCC program reference", async () => {
  const database = seededDatabase({
    evidenceStatus: "missing",
    evidenceReference: "CRCC pre-approved | Program 42",
  });
  attachEvidence(database, "ev-1", "first.pdf", "2026-07-01T00:00:00Z");
  runUpload(database, "ev-1", "first.pdf");
  assert.deepEqual(activityRow(database), {
    evidenceStatus: "attached",
    evidenceReference: "CRCC pre-approved | Program 42",
  });
  database.close();
});

test("attaching proof rolls a derived filename reference forward", async () => {
  const database = seededDatabase({
    evidenceStatus: "attached",
    evidenceReference: "first.pdf",
  });
  attachEvidence(database, "ev-1", "first.pdf", "2026-07-01T00:00:00Z");
  attachEvidence(database, "ev-2", "second.pdf", "2026-07-02T00:00:00Z");
  runUpload(database, "ev-2", "second.pdf");
  assert.deepEqual(activityRow(database), {
    evidenceStatus: "attached",
    evidenceReference: "second.pdf",
  });
  database.close();
});

test("removing proof keeps a not-required activity not required", async () => {
  const database = seededDatabase({
    evidenceStatus: "not_required",
    evidenceReference: "courtesy.pdf",
  });
  attachEvidence(database, "ev-1", "courtesy.pdf", "2026-07-01T00:00:00Z");
  assert.equal(runRemove(database, "ev-1").changes, 1);
  assert.deepEqual(activityRow(database), {
    evidenceStatus: "not_required",
    evidenceReference: null,
  });
  database.close();
});

test("removing proof keeps a user-entered evidence reference", async () => {
  const database = seededDatabase({
    evidenceStatus: "attached",
    evidenceReference: "Cert #ABC-123",
  });
  attachEvidence(database, "ev-1", "proof.pdf", "2026-07-01T00:00:00Z");
  runRemove(database, "ev-1");
  assert.deepEqual(activityRow(database), {
    evidenceStatus: "missing",
    evidenceReference: "Cert #ABC-123",
  });
  database.close();
});

test("removing one of several files still derives the newest filename", async () => {
  const database = seededDatabase({
    evidenceStatus: "attached",
    evidenceReference: "second.pdf",
  });
  attachEvidence(database, "ev-1", "first.pdf", "2026-07-01T00:00:00Z");
  attachEvidence(database, "ev-2", "second.pdf", "2026-07-02T00:00:00Z");
  runRemove(database, "ev-2");
  assert.deepEqual(activityRow(database), {
    evidenceStatus: "attached",
    evidenceReference: "first.pdf",
  });
  database.close();
});

test("removing the last file of a tracked activity still reports missing", async () => {
  const database = seededDatabase({
    evidenceStatus: "attached",
    evidenceReference: "proof.pdf",
  });
  attachEvidence(database, "ev-1", "proof.pdf", "2026-07-01T00:00:00Z");
  runRemove(database, "ev-1");
  assert.deepEqual(activityRow(database), {
    evidenceStatus: "missing",
    evidenceReference: null,
  });
  database.close();
});
