import { getD1 } from "@/db";
import {
  type RequestIdentity,
  resolveRequestIdentity,
} from "@/db/identity";
import { ensureUser, initializeDatabase } from "@/db/runtime";

export const dynamic = "force-dynamic";

type JsonRecord = Record<string, unknown>;

class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid_request",
  ) {
    super(message);
  }
}

function query(
  database: D1Database,
  sql: string,
  bindings: readonly unknown[] = [],
) {
  return database.prepare(sql).bind(...bindings);
}

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(data, { ...init, headers });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textField(
  payload: JsonRecord,
  key: string,
  options: { required?: boolean; max?: number } = {},
) {
  const value = payload[key];
  if (value === undefined || value === null) {
    if (options.required) throw new RequestError(`${key} is required`);
    return null;
  }
  if (typeof value !== "string") {
    throw new RequestError(`${key} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized && options.required) {
    throw new RequestError(`${key} is required`);
  }
  const max = options.max ?? 240;
  if (normalized.length > max) {
    throw new RequestError(`${key} must be ${max} characters or fewer`);
  }
  return normalized || null;
}

function positiveNumber(
  payload: JsonRecord,
  key: string,
  options: { required?: boolean; max?: number } = {},
) {
  const raw = payload[key];
  if (raw === undefined || raw === null || raw === "") {
    if (options.required) throw new RequestError(`${key} is required`);
    return null;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new RequestError(`${key} must be a positive number`);
  }
  const max = options.max ?? 10000;
  if (raw > max) throw new RequestError(`${key} must not exceed ${max}`);
  return Math.round(raw * 100) / 100;
}

function isoDateField(payload: JsonRecord, key: string, required = true) {
  const value = textField(payload, key, { required, max: 10 });
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RequestError(`${key} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new RequestError(`${key} must be a valid calendar date`);
  }
  return value;
}

function rejectClientIdentity(payload: JsonRecord) {
  const forbidden = ["userId", "user_id", "ownerId", "owner_id"];
  if (forbidden.some((key) => key in payload)) {
    throw new RequestError(
      "User identity is derived from the authenticated request and cannot be supplied by the client.",
      400,
      "client_identity_forbidden",
    );
  }
}

function daysBefore(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

async function getWorkspace(
  database: D1Database,
  identity: RequestIdentity,
) {
  type CatalogRow = {
    id: string;
    profession: string;
    credentialName: string;
    jurisdiction: string;
    issuer: string;
    totalUnits: number;
    unitLabel: string;
    cycleMonths: number;
    sourceUrl: string;
    sourceTitle: string;
    effectiveDate: string | null;
    lastVerifiedAt: string | null;
    reviewStatus: string;
    version: number;
  };
  type CategoryRow = {
    id: string;
    ruleSetId: string;
    name: string;
    requiredUnits: number;
  };
  type CredentialRow = {
    id: string;
    credentialName: string;
    profession: string;
    jurisdiction: string;
    issuer: string;
    deadline: string;
    cycleStart: string;
    totalRequired: number;
    unitLabel: string;
    status: string;
    submittedAt: string | null;
    confirmationNumber: string | null;
    submissionProof: string | null;
    sourceUrl: string | null;
    ruleReviewStatus: string;
    totalEarned: number;
  };
  type RequirementRow = {
    id: string;
    credentialId: string;
    name: string;
    requiredUnits: number;
    earnedUnits: number;
  };
  type TaskRow = {
    id: string;
    credentialId: string;
    title: string;
    kind: string;
    status: string;
    dueDate: string | null;
  };
  type ActivityRow = {
    id: string;
    title: string;
    provider: string;
    completionDate: string;
    totalUnits: number;
    evidenceStatus: string;
    evidenceReference: string | null;
    credentialId: string | null;
    credentialName: string | null;
    requirementId: string | null;
    categoryName: string | null;
    allocatedUnits: number;
  };
  type BadgeRow = {
    id: string;
    name: string;
    description: string;
    icon: string;
    earnedAt: string;
  };

  const [
    catalogResult,
    categoryResult,
    credentialResult,
    requirementResult,
    taskResult,
    activityResult,
    profile,
    badgeResult,
  ] = await Promise.all([
    query(
      database,
      `SELECT
        id,
        profession,
        credential_name AS credentialName,
        jurisdiction,
        issuer,
        total_units AS totalUnits,
        unit_label AS unitLabel,
        cycle_months AS cycleMonths,
        source_url AS sourceUrl,
        source_title AS sourceTitle,
        effective_date AS effectiveDate,
        last_verified_at AS lastVerifiedAt,
        review_status AS reviewStatus,
        version
      FROM rule_sets
      WHERE is_current = 1
      ORDER BY profession, credential_name, jurisdiction`,
    ).all<CatalogRow>(),
    query(
      database,
      `SELECT
        id,
        rule_set_id AS ruleSetId,
        name,
        required_units AS requiredUnits
      FROM rule_categories
      ORDER BY rule_set_id, sort_order, name`,
    ).all<CategoryRow>(),
    query(
      database,
      `SELECT
        c.id,
        c.credential_name AS credentialName,
        c.profession,
        c.jurisdiction,
        c.issuer,
        c.deadline,
        c.cycle_start AS cycleStart,
        c.total_required AS totalRequired,
        c.unit_label AS unitLabel,
        c.status,
        rs.source_url AS sourceUrl,
        COALESCE(rs.review_status, 'custom') AS ruleReviewStatus,
        sub.submitted_at AS submittedAt,
        sub.confirmation_number AS confirmationNumber,
        sub.proof_reference AS submissionProof,
        COALESCE(SUM(alloc.allocated_units), 0) AS totalEarned
      FROM credentials c
      LEFT JOIN rule_sets rs ON rs.id = c.rule_set_id
      LEFT JOIN renewal_submissions sub
        ON sub.credential_id = c.id AND sub.user_id = c.user_id
      LEFT JOIN activity_allocations alloc ON alloc.credential_id = c.id
      WHERE c.user_id = ?
      GROUP BY c.id
      ORDER BY
        CASE c.status WHEN 'active' THEN 0 WHEN 'submitted' THEN 1 ELSE 2 END,
        c.deadline`,
      [identity.userId],
    ).all<CredentialRow>(),
    query(
      database,
      `SELECT
        req.id,
        req.credential_id AS credentialId,
        req.name,
        req.required_units AS requiredUnits,
        COALESCE(SUM(alloc.allocated_units), 0) AS earnedUnits
      FROM credential_requirements req
      JOIN credentials c ON c.id = req.credential_id
      LEFT JOIN activity_allocations alloc ON alloc.requirement_id = req.id
      WHERE c.user_id = ?
      GROUP BY req.id
      ORDER BY req.credential_id, req.sort_order, req.name`,
      [identity.userId],
    ).all<RequirementRow>(),
    query(
      database,
      `SELECT
        id,
        credential_id AS credentialId,
        title,
        kind,
        status,
        due_date AS dueDate
      FROM checklist_tasks
      WHERE user_id = ?
      ORDER BY credential_id, sort_order, due_date`,
      [identity.userId],
    ).all<TaskRow>(),
    query(
      database,
      `SELECT
        a.id,
        a.title,
        a.provider,
        a.completion_date AS completionDate,
        a.total_units AS totalUnits,
        a.evidence_status AS evidenceStatus,
        a.evidence_reference AS evidenceReference,
        c.id AS credentialId,
        c.credential_name AS credentialName,
        req.id AS requirementId,
        req.name AS categoryName,
        CASE
          WHEN c.id IS NULL THEN 0
          ELSE COALESCE(alloc.allocated_units, 0)
        END AS allocatedUnits
      FROM activities a
      LEFT JOIN activity_allocations alloc ON alloc.activity_id = a.id
      LEFT JOIN credentials c
        ON c.id = alloc.credential_id AND c.user_id = a.user_id
      LEFT JOIN credential_requirements req
        ON req.id = alloc.requirement_id AND req.credential_id = c.id
      WHERE a.user_id = ?
      ORDER BY a.completion_date DESC, a.created_at DESC`,
      [identity.userId],
    ).all<ActivityRow>(),
    query(
      database,
      `SELECT
        p.weekly_goal AS weeklyGoal,
        COALESCE(
          (SELECT SUM(points) FROM xp_events WHERE user_id = p.user_id),
          0
        ) AS xp,
        COALESCE(
          (
            SELECT COUNT(*)
            FROM xp_events
            WHERE user_id = p.user_id
              AND created_at >= datetime('now', '-7 days')
          ),
          0
        ) AS weekActions
      FROM profiles p
      WHERE p.user_id = ?`,
      [identity.userId],
    ).first<{ weeklyGoal: number; xp: number; weekActions: number }>(),
    query(
      database,
      `SELECT
        def.id,
        def.name,
        def.description,
        def.icon,
        event.created_at AS earnedAt
      FROM badge_events event
      JOIN badge_definitions def ON def.id = event.badge_id
      WHERE event.user_id = ?
      ORDER BY event.created_at DESC`,
      [identity.userId],
    ).all<BadgeRow>(),
  ]);

  const categoriesByRule = new Map<string, CategoryRow[]>();
  for (const category of categoryResult.results) {
    const existing = categoriesByRule.get(category.ruleSetId) ?? [];
    existing.push({
      ...category,
      requiredUnits: Number(category.requiredUnits),
    });
    categoriesByRule.set(category.ruleSetId, existing);
  }

  const requirementsByCredential = new Map<string, RequirementRow[]>();
  for (const requirement of requirementResult.results) {
    const existing =
      requirementsByCredential.get(requirement.credentialId) ?? [];
    existing.push({
      ...requirement,
      requiredUnits: Number(requirement.requiredUnits),
      earnedUnits: Number(requirement.earnedUnits),
    });
    requirementsByCredential.set(requirement.credentialId, existing);
  }

  const tasksByCredential = new Map<string, TaskRow[]>();
  for (const task of taskResult.results) {
    const existing = tasksByCredential.get(task.credentialId) ?? [];
    existing.push(task);
    tasksByCredential.set(task.credentialId, existing);
  }

  return {
    user: {
      displayName: identity.displayName,
      email: identity.email,
      isDemo: identity.isDemo,
    },
    profile: {
      xp: Number(profile?.xp ?? 0),
      weekActions: Number(profile?.weekActions ?? 0),
      weeklyGoal: Number(profile?.weeklyGoal ?? 4),
      badges: badgeResult.results,
    },
    catalog: catalogResult.results.map((rule) => ({
      ...rule,
      totalUnits: Number(rule.totalUnits),
      cycleMonths: Number(rule.cycleMonths),
      version: Number(rule.version),
      categories: categoriesByRule.get(rule.id) ?? [],
    })),
    credentials: credentialResult.results.map((credential) => ({
      ...credential,
      totalRequired: Number(credential.totalRequired),
      totalEarned: Number(credential.totalEarned),
      requirements: requirementsByCredential.get(credential.id) ?? [],
      tasks: tasksByCredential.get(credential.id) ?? [],
    })),
    activities: activityResult.results.map((activity) => ({
      ...activity,
      totalUnits: Number(activity.totalUnits),
      allocatedUnits: Number(activity.allocatedUnits),
    })),
  };
}

type CatalogRule = {
  id: string;
  credentialName: string;
  profession: string;
  jurisdiction: string;
  issuer: string;
  totalUnits: number;
  unitLabel: string;
};

type CatalogCategory = {
  id: string;
  name: string;
  requiredUnits: number;
};

async function createCredential(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const ruleSetId = textField(payload, "ruleSetId", { max: 160 });
  const cycleStart = isoDateField(payload, "cycleStart")!;
  const deadline = isoDateField(payload, "deadline")!;
  if (cycleStart > deadline) {
    throw new RequestError("deadline must be on or after cycleStart");
  }

  let credentialName: string;
  let profession: string;
  let jurisdiction: string;
  let issuer: string;
  let totalRequired: number;
  let unitLabel: string;
  let categories: Array<{
    ruleCategoryId: string | null;
    name: string;
    requiredUnits: number;
  }>;

  if (ruleSetId) {
    const rule = await query(
      database,
      `SELECT
        id,
        credential_name AS credentialName,
        profession,
        jurisdiction,
        issuer,
        total_units AS totalUnits,
        unit_label AS unitLabel
      FROM rule_sets
      WHERE id = ? AND is_current = 1`,
      [ruleSetId],
    ).first<CatalogRule>();
    if (!rule) {
      throw new RequestError(
        "The selected rule set was not found or is no longer current.",
        404,
        "rule_set_not_found",
      );
    }
    const ruleCategories = await query(
      database,
      `SELECT id, name, required_units AS requiredUnits
       FROM rule_categories
       WHERE rule_set_id = ?
       ORDER BY sort_order, name`,
      [ruleSetId],
    ).all<CatalogCategory>();
    credentialName = rule.credentialName;
    profession = rule.profession;
    jurisdiction = rule.jurisdiction;
    issuer = rule.issuer;
    totalRequired = Number(rule.totalUnits);
    unitLabel = rule.unitLabel;
    categories = ruleCategories.results.map((category) => ({
      ruleCategoryId: category.id,
      name: category.name,
      requiredUnits: Number(category.requiredUnits),
    }));
  } else {
    credentialName = textField(payload, "credentialName", {
      required: true,
      max: 180,
    })!;
    profession = textField(payload, "profession", {
      required: true,
      max: 120,
    })!;
    jurisdiction = textField(payload, "jurisdiction", {
      required: true,
      max: 120,
    })!;
    issuer =
      textField(payload, "issuer", { max: 180 }) ?? "Self-managed credential";
    totalRequired = positiveNumber(payload, "totalRequired", {
      required: true,
    })!;
    unitLabel = textField(payload, "unitLabel", {
      required: true,
      max: 40,
    })!;

    const rawCategories = payload.categories;
    if (
      rawCategories !== undefined &&
      (!Array.isArray(rawCategories) || rawCategories.length > 30)
    ) {
      throw new RequestError("categories must be an array of up to 30 items");
    }
    categories = (rawCategories ?? []).map((item, index) => {
      if (!isRecord(item)) {
        throw new RequestError(`categories[${index}] must be an object`);
      }
      return {
        ruleCategoryId: null,
        name: textField(item, "name", { required: true, max: 100 })!,
        requiredUnits: positiveNumber(item, "requiredUnits", {
          required: true,
        })!,
      };
    });
    if (categories.length === 0) {
      categories = [
        {
          ruleCategoryId: null,
          name: "General",
          requiredUnits: totalRequired,
        },
      ];
    }
    const categoryTotal = categories.reduce(
      (sum, category) => sum + category.requiredUnits,
      0,
    );
    if (categoryTotal > totalRequired + 0.001) {
      throw new RequestError(
        "Category requirements cannot exceed the credential total.",
      );
    }
  }

  const credentialId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    query(
      database,
      `INSERT INTO credentials (
        id, user_id, rule_set_id, credential_name, profession, jurisdiction,
        issuer, cycle_start, deadline, total_required, unit_label, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        credentialId,
        identity.userId,
        ruleSetId,
        credentialName,
        profession,
        jurisdiction,
        issuer,
        cycleStart,
        deadline,
        totalRequired,
        unitLabel,
      ],
    ),
  ];

  categories.forEach((category, index) => {
    statements.push(
      query(
        database,
        `INSERT INTO credential_requirements (
          id, credential_id, rule_category_id, name, required_units, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          credentialId,
          category.ruleCategoryId,
          category.name,
          category.requiredUnits,
          index,
        ],
      ),
    );
  });

  const taskSpecs = [
    {
      title: "Review the renewal requirements",
      kind: "review",
      dueDate: daysBefore(deadline, 120),
    },
    {
      title: "Complete and document required education",
      kind: "progress",
      dueDate: daysBefore(deadline, 30),
    },
    {
      title: "Submit renewal and save confirmation",
      kind: "submission",
      dueDate: deadline,
    },
  ];
  taskSpecs.forEach((task, index) => {
    statements.push(
      query(
        database,
        `INSERT INTO checklist_tasks (
          id, user_id, credential_id, title, kind, status, due_date, sort_order
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
          crypto.randomUUID(),
          identity.userId,
          credentialId,
          task.title,
          task.kind,
          task.dueDate,
          index,
        ],
      ),
    );
  });
  statements.push(
    query(
      database,
      `INSERT OR IGNORE INTO xp_events (
        id, user_id, idempotency_key, event_type, points, related_type, related_id
      ) VALUES (?, ?, ?, 'credential_created', 25, 'credential', ?)`,
      [
        crypto.randomUUID(),
        identity.userId,
        `${identity.userId}:credential:${credentialId}:created`,
        credentialId,
      ],
    ),
  );

  await database.batch(statements);
  return credentialId;
}

function normalizedEvidenceStatus(payload: JsonRecord) {
  const raw = textField(payload, "evidenceStatus", { max: 40 }) ?? "missing";
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, string> = {
    complete: "attached",
    certificate_saved: "attached",
    saved: "attached",
    on_file: "attached",
    uploaded: "attached",
    verified: "attached",
    waived: "not_required",
  };
  const status = aliases[normalized] ?? normalized;
  if (!["missing", "attached", "not_required"].includes(status)) {
    throw new RequestError(
      "evidenceStatus must be missing, attached, or not_required",
    );
  }
  return status;
}

async function addActivity(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const title = textField(payload, "title", { required: true, max: 180 })!;
  const provider = textField(payload, "provider", { max: 180 }) ?? "";
  const completionDate = isoDateField(payload, "completionDate")!;
  const totalUnits = positiveNumber(payload, "totalUnits", {
    required: true,
  })!;
  const allocatedUnits =
    positiveNumber(payload, "allocatedUnits") ?? totalUnits;
  if (allocatedUnits > totalUnits) {
    throw new RequestError("allocatedUnits cannot exceed totalUnits");
  }
  const credentialId = textField(payload, "credentialId", {
    required: true,
    max: 160,
  })!;
  const requirementId = textField(payload, "requirementId", { max: 160 });
  const evidenceStatus = normalizedEvidenceStatus(payload);
  const evidenceReference = textField(payload, "evidenceReference", {
    max: 500,
  });

  const credential = await query(
    database,
    `SELECT id FROM credentials WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ id: string }>();
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }

  if (requirementId) {
    const requirement = await query(
      database,
      `SELECT req.id
       FROM credential_requirements req
       JOIN credentials c ON c.id = req.credential_id
       WHERE req.id = ? AND req.credential_id = ? AND c.user_id = ?`,
      [requirementId, credentialId, identity.userId],
    ).first<{ id: string }>();
    if (!requirement) {
      throw new RequestError(
        "Requirement not found for this credential.",
        404,
        "requirement_not_found",
      );
    }
  }

  const activityId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    query(
      database,
      `INSERT INTO activities (
        id, user_id, title, provider, completion_date, total_units,
        evidence_status, evidence_reference
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        activityId,
        identity.userId,
        title,
        provider,
        completionDate,
        totalUnits,
        evidenceStatus,
        evidenceReference,
      ],
    ),
    query(
      database,
      `INSERT INTO activity_allocations (
        id, activity_id, credential_id, requirement_id, allocated_units
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        activityId,
        credentialId,
        requirementId,
        allocatedUnits,
      ],
    ),
    query(
      database,
      `INSERT OR IGNORE INTO xp_events (
        id, user_id, idempotency_key, event_type, points, related_type, related_id
      ) VALUES (?, ?, ?, 'activity_logged', 50, 'activity', ?)`,
      [
        crypto.randomUUID(),
        identity.userId,
        `${identity.userId}:activity:${activityId}:logged`,
        activityId,
      ],
    ),
    query(
      database,
      `INSERT OR IGNORE INTO badge_events (
        id, user_id, badge_id, idempotency_key, related_type, related_id
      ) VALUES (?, ?, 'first-credit', ?, 'activity', ?)`,
      [
        crypto.randomUUID(),
        identity.userId,
        `${identity.userId}:badge:first-credit`,
        activityId,
      ],
    ),
  ];
  if (evidenceStatus === "attached") {
    statements.push(
      query(
        database,
        `INSERT OR IGNORE INTO badge_events (
          id, user_id, badge_id, idempotency_key, related_type, related_id
        ) VALUES (?, ?, 'proof-ready', ?, 'activity', ?)`,
        [
          crypto.randomUUID(),
          identity.userId,
          `${identity.userId}:badge:proof-ready`,
          activityId,
        ],
      ),
    );
  }

  await database.batch(statements);
  return activityId;
}

async function toggleTask(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const taskId = textField(payload, "taskId", {
    required: true,
    max: 160,
  })!;
  if (typeof payload.completed !== "boolean") {
    throw new RequestError("completed must be a boolean");
  }
  const completed = payload.completed;
  const task = await query(
    database,
    `SELECT id FROM checklist_tasks WHERE id = ? AND user_id = ?`,
    [taskId, identity.userId],
  ).first<{ id: string }>();
  if (!task) {
    throw new RequestError("Task not found.", 404, "task_not_found");
  }

  const statements: D1PreparedStatement[] = [
    query(
      database,
      `UPDATE checklist_tasks
       SET
         status = ?,
         completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [
        completed ? "completed" : "pending",
        completed ? 1 : 0,
        taskId,
        identity.userId,
      ],
    ),
  ];
  if (completed) {
    statements.push(
      query(
        database,
        `INSERT OR IGNORE INTO xp_events (
          id, user_id, idempotency_key, event_type, points, related_type, related_id
        ) VALUES (?, ?, ?, 'task_completed', 30, 'task', ?)`,
        [
          crypto.randomUUID(),
          identity.userId,
          `${identity.userId}:task:${taskId}:completed`,
          taskId,
        ],
      ),
    );
  }
  await database.batch(statements);
  return taskId;
}

async function markSubmitted(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const credentialId = textField(payload, "credentialId", {
    required: true,
    max: 160,
  })!;
  const submissionDate = isoDateField(payload, "submissionDate")!;
  const confirmationNumber = textField(payload, "confirmationNumber", {
    required: true,
    max: 180,
  })!;
  const proofReference = textField(payload, "proofReference", { max: 500 });

  const credential = await query(
    database,
    `SELECT id FROM credentials WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ id: string }>();
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  const existing = await query(
    database,
    `SELECT id
     FROM renewal_submissions
     WHERE credential_id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ id: string }>();
  const submissionId = existing?.id ?? crypto.randomUUID();

  await database.batch([
    query(
      database,
      `INSERT INTO renewal_submissions (
        id, user_id, credential_id, submitted_at, confirmation_number,
        proof_reference
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(credential_id) DO UPDATE SET
        submitted_at = excluded.submitted_at,
        confirmation_number = excluded.confirmation_number,
        proof_reference = excluded.proof_reference,
        updated_at = CURRENT_TIMESTAMP`,
      [
        submissionId,
        identity.userId,
        credentialId,
        submissionDate,
        confirmationNumber,
        proofReference ?? confirmationNumber,
      ],
    ),
    query(
      database,
      `UPDATE credentials
       SET status = 'submitted', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [credentialId, identity.userId],
    ),
    query(
      database,
      `UPDATE checklist_tasks
       SET
         status = 'completed',
         completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
       WHERE credential_id = ? AND user_id = ? AND kind = 'submission'`,
      [credentialId, identity.userId],
    ),
    query(
      database,
      `INSERT OR IGNORE INTO xp_events (
        id, user_id, idempotency_key, event_type, points, related_type, related_id
      ) VALUES (?, ?, ?, 'renewal_submitted', 150, 'submission', ?)`,
      [
        crypto.randomUUID(),
        identity.userId,
        `${identity.userId}:credential:${credentialId}:submitted`,
        submissionId,
      ],
    ),
    query(
      database,
      `INSERT OR IGNORE INTO badge_events (
        id, user_id, badge_id, idempotency_key, related_type, related_id
      ) VALUES (?, ?, 'renewal-filed', ?, 'submission', ?)`,
      [
        crypto.randomUUID(),
        identity.userId,
        `${identity.userId}:badge:renewal-filed`,
        submissionId,
      ],
    ),
  ]);
  return submissionId;
}

async function authenticatedContext(request: Request) {
  const identity = await resolveRequestIdentity(request);
  if (!identity) {
    throw new RequestError(
      "Sign in with ChatGPT to access your CEU workspace.",
      401,
      "authentication_required",
    );
  }
  const database = getD1();
  await initializeDatabase(database);
  await ensureUser(database, identity);
  return { database, identity };
}

export async function GET(request: Request) {
  try {
    const { database, identity } = await authenticatedContext(request);
    return json(await getWorkspace(database, identity));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 100_000) {
      throw new RequestError("Request body is too large.", 413, "body_too_large");
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new RequestError("Request body must be valid JSON.");
    }
    if (!isRecord(body)) throw new RequestError("Request body must be an object.");
    rejectClientIdentity(body);
    const action = textField(body, "action", { required: true, max: 40 })!;
    if (!isRecord(body.payload)) {
      throw new RequestError("payload must be an object");
    }
    rejectClientIdentity(body.payload);

    const { database, identity } = await authenticatedContext(request);
    let id: string;
    switch (action) {
      case "createCredential":
        id = await createCredential(database, identity, body.payload);
        break;
      case "addActivity":
        id = await addActivity(database, identity, body.payload);
        break;
      case "toggleTask":
        id = await toggleTask(database, identity, body.payload);
        break;
      case "markSubmitted":
        id = await markSubmitted(database, identity, body.payload);
        break;
      default:
        throw new RequestError(
          `Unsupported action: ${action}`,
          400,
          "unsupported_action",
        );
    }
    return json({ ok: true, action, id });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof RequestError) {
    return json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error("CEU workspace API error", message);
  return json(
    {
      error: "The CEU workspace could not be loaded. Please try again.",
      code: "internal_error",
    },
    { status: 500 },
  );
}
