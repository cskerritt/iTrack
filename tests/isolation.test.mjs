// Two-identity isolation suite (audit critic-08; spec 2026-09-10 §4).
//
// Ownership scoping in the workspace API is correct today, but only by
// convention: every action re-derives `WHERE ... user_id = ?` by hand. The
// route decomposition and the Wave 2 route.ts tasks are exactly the refactors
// that regress that clause, so this file is the tripwire. It boots the BUILT
// worker (dist/server/index.js) against a real node:sqlite database with two
// identities, seeds identity A through public routes only, then replays every
// id-taking action and route from identity B using A's ids. Each probe pins
// the exact refusal (status + code): validation runs before ownership in every
// action, so a naive "not 200" check would let a 400 pass silently.
//
// Nothing here imports app/** or db/**: the suite must keep passing across
// file moves and must fail only when behaviour changes.
//
// Needs `npm run build` first; run alone with
//   node --experimental-sqlite --test tests/isolation.test.mjs
import assert from "node:assert/strict";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WORKSPACE_ACTIONS } from "./helpers/workspaceActions.mjs";

const testCloudflareEnv = {};
globalThis.__LICENSE_LANTERN_TEST_ENV__ = testCloudflareEnv;

// The production bundle targets Cloudflare's `cloudflare:workers` virtual
// module; expose the same env-shaped object to the built worker under node.
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

// Real in-memory D1 over node:sqlite. Copied (not imported) from
// tests/rendered-html.test.mjs so this file survives that suite's retirement:
// foreign keys ON, batch = one BEGIN IMMEDIATE transaction, and every
// statement reports meta.changes because the actions branch on it.
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

// initializeDatabase is memoised per worker import, so one database per file.
const db = new SQLiteD1Database(DatabaseSync);
const bucket = new FakeEvidenceBucket();
testCloudflareEnv.DB = db;
testCloudflareEnv.EVIDENCE = bucket;

// A non-local host: the demo-identity fallback only fires for localhost, so
// a request without the identity header is anonymous here, not the demo user.
const BASE = "https://itrack.example";
const executionContext = { waitUntil() {}, passThroughOnException() {} };

function identity(email) {
  return {
    email,
    headers: { accept: "application/json", "oai-authenticated-user-email": email },
  };
}
const A = identity("alpha@example.com");
const B = identity("bravo@example.com");
const ANONYMOUS = { email: null, headers: { accept: "application/json" } };

async function fetchAs(id, path, init = {}) {
  const worker = await workerPromise;
  return worker.fetch(
    new Request(BASE + path, { ...init, headers: { ...id.headers, ...(init.headers ?? {}) } }),
    { ASSETS: { fetch: async () => new Response("", { status: 404 }) }, DB: db, EVIDENCE: bucket },
    executionContext,
  );
}

// No Origin and no sec-fetch-site: the route's cross-origin check only rejects
// a mismatching value, and a real same-origin fetch sends none in tests.
async function post(id, action, payload) {
  return fetchAs(id, "/api/workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, payload }),
  });
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0)]);

async function upload(id, activityId, fileName) {
  const form = new FormData();
  form.set("activityId", activityId);
  form.set("file", new File([PNG_BYTES], fileName, { type: "image/png" }));
  return fetchAs(id, "/api/evidence", { method: "POST", body: form });
}

async function expectRefusal(response, { status, code }) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.code, code);
  assert.ok(!("credentials" in body) && !("activities" in body), "a refusal carries no workspace data");
}

function userIdOf(email) {
  return db.raw.prepare("SELECT id FROM users WHERE email = ?").get(email).id;
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Seeds one owner through public routes only (plus one raw ledger row, which
// no public route writes) and returns every id a probe could name.
async function seedOwner(id, { credentialName, activityTitle, taskTitle, device }) {
  assert.equal((await fetchAs(id, "/api/workspace")).status, 200, `${id.email}: ensureUser`);
  const userId = userIdOf(id.email);

  const credentialResponse = await post(id, "createCredential", {
    credentialName,
    profession: "Social work",
    jurisdiction: "New Jersey",
    issuer: `${credentialName} board`,
    totalRequired: 10,
    unitLabel: "hours",
    cycleStart: "2026-01-01",
    deadline: "2027-12-31",
    categories: [{ name: "General", requiredUnits: 10 }],
  });
  assert.equal(credentialResponse.status, 200, `${id.email}: createCredential`);
  const credentialId = (await credentialResponse.json()).id;

  const activityResponse = await post(id, "addActivity", {
    title: activityTitle,
    provider: `${credentialName} U`,
    completionDate: "2026-06-02",
    totalUnits: 2,
    allocatedUnits: 2,
    credentialId,
  });
  assert.equal(activityResponse.status, 200, `${id.email}: addActivity`);
  const activityId = (await activityResponse.json()).id;

  const taskResponse = await post(id, "createPersonalTask", { credentialId, title: taskTitle, dueDate: "2026-10-01" });
  assert.equal(taskResponse.status, 200, `${id.email}: createPersonalTask`);
  const personalTaskId = (await taskResponse.json()).id;

  const workspace = await (await fetchAs(id, "/api/workspace")).json();
  const credential = workspace.credentials.find((candidate) => candidate.id === credentialId);
  const activity = workspace.activities.find((candidate) => candidate.id === activityId);
  const managedTask = credential.tasks.find((task) => !task.isPersonal);
  const personalTask = credential.tasks.find((task) => task.id === personalTaskId);

  const uploadResponse = await upload(id, activityId, `${device}.png`);
  assert.equal(uploadResponse.status, 201, `${id.email}: evidence upload`);
  const evidenceId = (await uploadResponse.json()).evidence.id;
  const evidenceKey = `evidence/${userId}/${activityId}/${evidenceId}`;
  assert.ok(bucket.objects.has(evidenceKey), `${id.email}: evidence object stored under the owner's key`);

  const key = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const subscription = {
    endpoint: `https://fcm.googleapis.com/fcm/send/${device}-device`,
    expirationTime: null,
    keys: {
      p256dh: base64url(new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey))),
      auth: base64url(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
  const pushResponse = await post(id, "savePushSubscription", {
    subscription,
    deviceLabel: `${credentialName} browser`,
    enableAccountPush: false,
  });
  assert.equal(pushResponse.status, 200, `${id.email}: savePushSubscription`);
  const subscriptionId = (await pushResponse.json()).id;

  // A dispatched delivery, so `GET /api/workspace?delivery=<id>` has a row to
  // refuse. 2027-10-02 is the 90-day lead of the seeded deadline.
  const deliveryId = crypto.randomUUID();
  db.raw
    .prepare(
      `INSERT INTO push_delivery_ledger (id, user_id, subscription_id, reminder_key, scheduled_for, status, attempt_count, dispatched_at)
       VALUES (?, ?, ?, ?, ?, 'delivered', 1, CURRENT_TIMESTAMP)`,
    )
    .run(deliveryId, userId, subscriptionId, `deadline:${credentialId}:${credential.deadline}`, "2027-10-02");

  return {
    userId,
    credentialName,
    activityTitle,
    credentialId,
    deadline: credential.deadline,
    requirementId: credential.requirements[0].id,
    managedTaskId: managedTask?.id ?? personalTaskId,
    managedTaskRevision: managedTask?.revision ?? personalTask.revision,
    personalTaskId,
    personalTaskRevision: personalTask.revision,
    activityId,
    activityRevision: activity.revision,
    allocationId: activity.allocations[0].id,
    evidenceId,
    evidenceKey,
    subscription,
    subscriptionId,
    deliveryId,
  };
}

// Every table carrying user_id (db/schema.ts), plus the two scoped only
// through a parent, plus the bucket. `SELECT *` so a new column is covered
// without editing this list; rowid order because three of these tables have
// no `id` column.
const USER_SCOPED_TABLES = [
  "profiles",
  "weekly_progression_periods",
  "credentials",
  "dental_checkpoint_states",
  "activities",
  "evidence_files",
  "activity_requirement_matches",
  "checklist_tasks",
  "renewal_submissions",
  "credential_cycle_links",
  "renewal_acceptances",
  "reminder_preferences",
  "reminder_states",
  "push_subscriptions",
  "push_delivery_ledger",
  "xp_events",
  "weekly_quest_claims",
  "badge_events",
];

function ownerFingerprint(userId) {
  const tables = {};
  for (const table of USER_SCOPED_TABLES) {
    tables[table] = db.raw.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY rowid`).all(userId);
  }
  tables.credential_requirements = db.raw
    .prepare(
      `SELECT credential_requirements.* FROM credential_requirements
       JOIN credentials c ON c.id = credential_requirements.credential_id
       WHERE c.user_id = ? ORDER BY credential_requirements.rowid`,
    )
    .all(userId);
  tables.activity_allocations = db.raw
    .prepare(
      `SELECT activity_allocations.* FROM activity_allocations
       JOIN activities a ON a.id = activity_allocations.activity_id
       WHERE a.user_id = ? ORDER BY activity_allocations.rowid`,
    )
    .all(userId);
  return JSON.stringify({ tables, bucketKeys: [...bucket.objects.keys()].sort() });
}

// B sends A's ids. Every payload is otherwise valid so the request reaches
// the ownership lookup; `expect` is the exact refusal. Two rows are documented
// exceptions rather than 404s (see the comments on those rows).
const FOREIGN_ID_PROBES = [
  {
    action: "addActivity",
    payload: (s) => ({ title: "x", completionDate: "2026-06-02", totalUnits: 1, credentialId: s.credentialId }),
    expect: { status: 404, code: "credential_not_found" },
  },
  {
    action: "updateActivity",
    payload: (s) => ({
      activityId: s.activityId,
      expectedRevision: s.activityRevision,
      title: "hijack",
      provider: "",
      completionDate: "2026-06-01",
      totalUnits: 2,
    }),
    expect: { status: 404, code: "activity_not_found" },
  },
  {
    action: "archiveActivity",
    payload: (s) => ({ activityId: s.activityId, expectedRevision: s.activityRevision }),
    expect: { status: 404, code: "activity_not_found" },
  },
  {
    action: "restoreActivity",
    payload: (s) => ({ activityId: s.activityId, expectedRevision: s.activityRevision }),
    expect: { status: 404, code: "activity_not_found" },
  },
  {
    action: "addActivityAllocation",
    payload: (s) => ({ activityId: s.activityId, credentialId: s.credentialId, allocatedUnits: 1, requirementIds: [] }),
    expect: { status: 404, code: "activity_not_found" },
  },
  {
    action: "updateActivityAllocationRequirements",
    payload: (s) => ({ allocationId: s.allocationId, requirementIds: [s.requirementId] }),
    expect: { status: 404, code: "allocation_not_found" },
  },
  {
    action: "toggleTask",
    payload: (s) => ({ taskId: s.managedTaskId, completed: true, expectedRevision: s.managedTaskRevision }),
    expect: { status: 404, code: "task_not_found" },
  },
  {
    action: "createPersonalTask",
    payload: (s) => ({ credentialId: s.credentialId, title: "x", dueDate: "2026-10-01" }),
    expect: { status: 404, code: "credential_not_found" },
  },
  {
    action: "updatePersonalTask",
    payload: (s) => ({ taskId: s.personalTaskId, expectedRevision: s.personalTaskRevision, title: "x", dueDate: "2026-10-02" }),
    expect: { status: 404, code: "task_not_found" },
  },
  {
    action: "archivePersonalTask",
    payload: (s) => ({ taskId: s.personalTaskId, expectedRevision: s.personalTaskRevision, title: "x", dueDate: "2026-10-02" }),
    expect: { status: 404, code: "task_not_found" },
  },
  {
    action: "restorePersonalTask",
    payload: (s) => ({ taskId: s.personalTaskId, expectedRevision: s.personalTaskRevision, title: "x", dueDate: "2026-10-02" }),
    expect: { status: 404, code: "task_not_found" },
  },
  {
    action: "markSubmitted",
    payload: (s) => ({ credentialId: s.credentialId, submissionDate: "2026-06-01", confirmationNumber: "C1", complianceAttested: true }),
    expect: { status: 404, code: "credential_not_found" },
  },
  {
    action: "markRenewalAccepted",
    payload: (s) => ({
      credentialId: s.credentialId,
      acceptedAt: "2026-06-15",
      reference: "R1",
      nextCycleStart: "2028-01-01",
      nextDeadline: "2029-12-31",
      officialDatesAttested: true,
    }),
    expect: { status: 404, code: "credential_not_found" },
  },
  {
    action: "updateRequirementApplicability",
    payload: (s) => ({ credentialId: s.credentialId, choices: [{ requirementId: s.requirementId, status: "applies" }] }),
    expect: { status: 404, code: "credential_not_found" },
  },
  {
    action: "saveDentalCheckpoint",
    payload: (s) => ({ credentialId: s.credentialId, requirementId: s.requirementId, completed: false, evidenceNote: "", expectedRevision: 0 }),
    expect: { status: 404, code: "dental_checkpoint_not_found" },
  },
  {
    action: "setReminderState",
    payload: (s) => ({
      reminderKey: `deadline:${s.credentialId}:${s.deadline}`,
      credentialId: s.credentialId,
      status: "dismissed",
      snoozedUntil: null,
    }),
    expect: { status: 404, code: "credential_not_found" },
  },
  {
    action: "sendTestPush",
    payload: (s) => ({ endpoint: s.subscription.endpoint }),
    expect: { status: 404, code: "push_subscription_not_found" },
  },
  // Documented exception: the endpoint lookup is not user-scoped, so a foreign
  // endpoint answers 409 (an existence oracle, not a data leak; push endpoints
  // are unguessable capability URLs). Ownership cannot change: the raw-row
  // subtest below proves the subscription is still A's and still active.
  // Task 2 replaces this row when it neutralises the oracle.
  {
    action: "savePushSubscription",
    payload: (s) => ({ subscription: s.subscription, deviceLabel: "Bravo browser", enableAccountPush: false }),
    expect: { status: 409, code: "push_subscription_conflict" },
  },
  // Documented exception: removal is idempotent and user-scoped, so a foreign
  // endpoint is a silent no-op; the raw-row subtest proves A's subscription
  // and ledger row are untouched.
  {
    action: "removePushSubscription",
    payload: (s) => ({ endpoint: s.subscription.endpoint }),
    expect: { status: 200, ok: true, id: "push-subscription" },
  },
];

// Actions whose payload names no stored id of another user: catalog ids,
// per-user computed keys, or no ids at all.
const NO_FOREIGN_ID_ACTIONS = ["createCredential", "claimWeeklyQuest", "updateWeeklyGoal", "updateReminderPreferences"];

test("two-identity isolation over the built worker (critic-08)", async (t) => {
  const seedA = await seedOwner(A, {
    credentialName: "Alpha LCSW",
    activityTitle: "Alpha ethics course",
    taskTitle: "Alpha task",
    device: "alpha",
  });
  const seedB = await seedOwner(B, {
    credentialName: "Bravo LMHC",
    activityTitle: "Bravo course",
    taskTitle: "Bravo task",
    device: "bravo",
  });

  const fingerprintBefore = ownerFingerprint(seedA.userId);
  const workspaceBefore = await (await fetchAs(A, "/api/workspace")).text();
  assert.ok(workspaceBefore.includes(seedA.credentialId) && workspaceBefore.includes("Alpha ethics course"), "A sees its own data");

  await t.test("the probe table names every dispatch label exactly once", () => {
    const named = [...FOREIGN_ID_PROBES.map((probe) => probe.action), ...NO_FOREIGN_ID_ACTIONS];
    assert.equal(new Set(named).size, named.length, "no action is listed twice");
    assert.deepEqual(new Set(named), new Set(WORKSPACE_ACTIONS));
    assert.equal(WORKSPACE_ACTIONS.length, 23);
  });

  await t.test("the build dispatches every listed action and nothing else", async () => {
    await expectRefusal(await post(B, "nope", {}), { status: 400, code: "unsupported_action" });
    for (const action of WORKSPACE_ACTIONS) {
      const response = await post(B, action, {});
      const body = await response.json();
      assert.notEqual(response.status, 200, `${action}: an empty payload must be refused`);
      assert.notEqual(body.code, "unsupported_action", `${action}: the build no longer dispatches this action`);
    }
  });

  for (const probe of FOREIGN_ID_PROBES) {
    await t.test(`foreign id: ${probe.action} with A's ids as B`, async () => {
      const response = await post(B, probe.action, probe.payload(seedA));
      if ("ok" in probe.expect) {
        assert.equal(response.status, probe.expect.status);
        assert.deepEqual(await response.json(), { ok: true, action: probe.action, id: probe.expect.id });
      } else {
        await expectRefusal(response, probe.expect);
      }
    });
  }

  await t.test("the two documented non-404s leave A's push rows untouched", () => {
    const row = db.raw
      .prepare("SELECT user_id AS userId, disabled_at AS disabledAt FROM push_subscriptions WHERE id = ?")
      .get(seedA.subscriptionId);
    assert.equal(row.userId, seedA.userId);
    assert.equal(row.disabledAt, null);
    const ledger = db.raw.prepare("SELECT status FROM push_delivery_ledger WHERE id = ?").get(seedA.deliveryId);
    assert.equal(ledger.status, "delivered");
  });

  // B's own ids combined with A's: these exercise the parent joins on the two
  // tables that carry no user_id (credential_requirements, activity_allocations).
  const MIXED_PROBES = [
    {
      label: "addActivityAllocation with B's activity and A's credential",
      action: "addActivityAllocation",
      payload: { activityId: seedB.activityId, credentialId: seedA.credentialId, allocatedUnits: 1, requirementIds: [] },
      expect: { status: 404, code: "credential_not_found" },
    },
    {
      label: "addActivityAllocation with A's activity and B's credential",
      action: "addActivityAllocation",
      payload: { activityId: seedA.activityId, credentialId: seedB.credentialId, allocatedUnits: 1, requirementIds: [] },
      expect: { status: 404, code: "activity_not_found" },
    },
    {
      label: "addActivity to B's credential tagged with A's requirement",
      action: "addActivity",
      payload: { title: "x", completionDate: "2026-06-03", totalUnits: 1, credentialId: seedB.credentialId, requirementIds: [seedA.requirementId] },
      expect: { status: 404, code: "requirement_not_found" },
    },
    {
      label: "updateActivityAllocationRequirements on B's allocation with A's requirement",
      action: "updateActivityAllocationRequirements",
      payload: { allocationId: seedB.allocationId, requirementIds: [seedA.requirementId] },
      expect: { status: 404, code: "requirement_not_found" },
    },
    {
      label: "updateRequirementApplicability on B's credential with A's requirement",
      action: "updateRequirementApplicability",
      payload: { credentialId: seedB.credentialId, choices: [{ requirementId: seedA.requirementId, status: "applies" }] },
      expect: { status: 404, code: "requirement_not_found" },
    },
    {
      label: "saveDentalCheckpoint on B's credential with A's requirement",
      action: "saveDentalCheckpoint",
      payload: { credentialId: seedB.credentialId, requirementId: seedA.requirementId, completed: false, evidenceNote: "", expectedRevision: 0 },
      expect: { status: 404, code: "dental_checkpoint_not_found" },
    },
    {
      label: "setReminderState on B's credential with A's task key",
      action: "setReminderState",
      payload: { credentialId: seedB.credentialId, reminderKey: `task:${seedA.managedTaskId}:2026-10-01`, status: "dismissed", snoozedUntil: null },
      expect: { status: 404, code: "reminder_not_found" },
    },
  ];
  for (const probe of MIXED_PROBES) {
    await t.test(`mixed ownership: ${probe.label}`, async () => {
      await expectRefusal(await post(B, probe.action, probe.payload), probe.expect);
    });
  }

  await t.test("GET /api/workspace as B carries nothing of A's", async () => {
    const response = await fetchAs(B, "/api/workspace");
    assert.equal(response.status, 200);
    const text = await response.text();
    for (const needle of [
      seedA.credentialId,
      seedA.activityId,
      seedA.evidenceId,
      seedA.personalTaskId,
      seedA.allocationId,
      "Alpha LCSW",
      "Alpha ethics course",
    ]) {
      assert.ok(!text.includes(needle), `B's workspace must not mention ${needle}`);
    }
    assert.ok(text.includes(seedB.credentialId), "B still sees its own credential");
  });

  await t.test("GET /api/workspace?delivery= refuses A's delivery for B", async () => {
    await expectRefusal(await fetchAs(B, `/api/workspace?delivery=${seedA.deliveryId}`), {
      status: 404,
      code: "push_delivery_not_found",
    });
  });

  await t.test("GET /api/evidence?activityId= for A's activity lists nothing for B", async () => {
    // Scoped rather than refused: pinned as-is, it discloses nothing.
    const response = await fetchAs(B, `/api/evidence?activityId=${seedA.activityId}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { evidence: [] });
  });

  await t.test("GET /api/evidence/:id refuses A's evidence for B", async () => {
    await expectRefusal(await fetchAs(B, `/api/evidence/${seedA.evidenceId}`), { status: 404, code: "evidence_not_found" });
  });

  await t.test("GET /api/evidence/:id/download refuses A's evidence for B", async () => {
    await expectRefusal(await fetchAs(B, `/api/evidence/${seedA.evidenceId}/download`), {
      status: 404,
      code: "evidence_not_found",
    });
  });

  await t.test("DELETE /api/evidence/:id refuses A's evidence for B and keeps the object", async () => {
    await expectRefusal(await fetchAs(B, `/api/evidence/${seedA.evidenceId}`, { method: "DELETE" }), {
      status: 404,
      code: "evidence_not_found",
    });
    assert.ok(bucket.objects.has(seedA.evidenceKey), "A's object is still in the bucket");
  });

  await t.test("POST /api/evidence onto A's activity is refused for B and stores nothing", async () => {
    const sizeBefore = bucket.objects.size;
    await expectRefusal(await upload(B, seedA.activityId, "hijack.png"), { status: 404, code: "activity_not_found" });
    assert.equal(bucket.objects.size, sizeBefore);
  });

  await t.test("GET /api/export as B exports only B's activities", async () => {
    const response = await fetchAs(B, "/api/export");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/csv/);
    const csv = await response.text();
    assert.ok(!csv.includes("Alpha ethics course"), "A's activity is not in B's export");
    assert.ok(csv.includes("Bravo course"), "B's own activity is");
  });

  await t.test("GET /api/export/packet refuses A's credential for B in JSON and HTML", async () => {
    const asJson = await fetchAs(B, `/api/export/packet?credentialId=${seedA.credentialId}`);
    assert.equal(asJson.status, 404);
    assert.deepEqual(await asJson.json(), { error: "Credential not found.", code: "credential_not_found" });
    const asHtml = await fetchAs(B, `/api/export/packet?credentialId=${seedA.credentialId}`, {
      headers: { accept: "text/html" },
    });
    assert.equal(asHtml.status, 404);
    const html = await asHtml.text();
    assert.ok(html.includes("Packet unavailable"));
    assert.ok(!html.includes("Alpha LCSW"));
  });

  await t.test("a request without an identity header is anonymous, not the demo user", async () => {
    await expectRefusal(await fetchAs(ANONYMOUS, "/api/workspace"), { status: 401, code: "authentication_required" });
  });

  await t.test("control: the refusals are ownership, not breakage", async () => {
    // B's own upload succeeded during seeding (201); A cannot read it.
    await expectRefusal(await fetchAs(A, `/api/evidence/${seedB.evidenceId}`), { status: 404, code: "evidence_not_found" });
    const own = await fetchAs(B, `/api/evidence/${seedB.evidenceId}`);
    assert.equal(own.status, 200);
  });

  await t.test("identity A is byte-for-byte unchanged after every probe", async () => {
    assert.equal(ownerFingerprint(seedA.userId), fingerprintBefore);
    assert.equal(await (await fetchAs(A, "/api/workspace")).text(), workspaceBefore);
  });
});
