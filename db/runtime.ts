import type { RequestIdentity } from "./identity";

const TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email)`,
  `CREATE TABLE IF NOT EXISTS profiles (
    user_id TEXT PRIMARY KEY NOT NULL,
    weekly_goal INTEGER NOT NULL DEFAULT 4,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS rule_sets (
    id TEXT PRIMARY KEY NOT NULL,
    stable_key TEXT NOT NULL,
    version INTEGER NOT NULL,
    profession TEXT NOT NULL,
    credential_name TEXT NOT NULL,
    jurisdiction TEXT NOT NULL,
    issuer TEXT NOT NULL,
    total_units REAL NOT NULL,
    unit_label TEXT NOT NULL,
    cycle_months INTEGER NOT NULL,
    source_url TEXT NOT NULL,
    source_title TEXT NOT NULL,
    effective_date TEXT,
    last_verified_at TEXT,
    review_status TEXT NOT NULL DEFAULT 'needs_review',
    is_current INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS rule_sets_stable_key_version_unique
    ON rule_sets (stable_key, version)`,
  `CREATE INDEX IF NOT EXISTS rule_sets_current_idx
    ON rule_sets (is_current, profession)`,
  `CREATE TABLE IF NOT EXISTS rule_categories (
    id TEXT PRIMARY KEY NOT NULL,
    rule_set_id TEXT NOT NULL,
    name TEXT NOT NULL,
    required_units REAL NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (rule_set_id) REFERENCES rule_sets(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS rule_categories_rule_name_unique
    ON rule_categories (rule_set_id, name)`,
  `CREATE INDEX IF NOT EXISTS rule_categories_rule_idx
    ON rule_categories (rule_set_id, sort_order)`,
  `CREATE TABLE IF NOT EXISTS credentials (
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
  )`,
  `CREATE INDEX IF NOT EXISTS credentials_user_deadline_idx
    ON credentials (user_id, deadline)`,
  `CREATE INDEX IF NOT EXISTS credentials_rule_set_idx
    ON credentials (rule_set_id)`,
  `CREATE TABLE IF NOT EXISTS credential_requirements (
    id TEXT PRIMARY KEY NOT NULL,
    credential_id TEXT NOT NULL,
    rule_category_id TEXT,
    name TEXT NOT NULL,
    required_units REAL NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE CASCADE,
    FOREIGN KEY (rule_category_id) REFERENCES rule_categories(id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS credential_requirements_credential_idx
    ON credential_requirements (credential_id, sort_order)`,
  `CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    provider TEXT NOT NULL,
    completion_date TEXT NOT NULL,
    total_units REAL NOT NULL,
    evidence_status TEXT NOT NULL DEFAULT 'missing',
    evidence_reference TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS activities_user_date_idx
    ON activities (user_id, completion_date)`,
  `CREATE TABLE IF NOT EXISTS activity_allocations (
    id TEXT PRIMARY KEY NOT NULL,
    activity_id TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    requirement_id TEXT,
    allocated_units REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE,
    FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE CASCADE,
    FOREIGN KEY (requirement_id) REFERENCES credential_requirements(id) ON DELETE SET NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS activity_allocations_target_unique
    ON activity_allocations (activity_id, credential_id, requirement_id)`,
  `CREATE INDEX IF NOT EXISTS activity_allocations_credential_idx
    ON activity_allocations (credential_id)`,
  `CREATE INDEX IF NOT EXISTS activity_allocations_requirement_idx
    ON activity_allocations (requirement_id)`,
  `CREATE TABLE IF NOT EXISTS checklist_tasks (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    due_date TEXT,
    completed_at TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS checklist_tasks_user_credential_idx
    ON checklist_tasks (user_id, credential_id, sort_order)`,
  `CREATE TABLE IF NOT EXISTS renewal_submissions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    confirmation_number TEXT NOT NULL,
    proof_reference TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS renewal_submissions_credential_unique
    ON renewal_submissions (credential_id)`,
  `CREATE INDEX IF NOT EXISTS renewal_submissions_user_idx
    ON renewal_submissions (user_id)`,
  `CREATE TABLE IF NOT EXISTS badge_definitions (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    icon TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS xp_events (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    event_type TEXT NOT NULL,
    points INTEGER NOT NULL,
    related_type TEXT,
    related_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS xp_events_idempotency_unique
    ON xp_events (idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS xp_events_user_created_idx
    ON xp_events (user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS badge_events (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    badge_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    related_type TEXT,
    related_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (badge_id) REFERENCES badge_definitions(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS badge_events_idempotency_unique
    ON badge_events (idempotency_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS badge_events_user_badge_unique
    ON badge_events (user_id, badge_id)`,
  `CREATE INDEX IF NOT EXISTS badge_events_user_created_idx
    ON badge_events (user_id, created_at)`,
] as const;

const RULE_SET_ID = "nj-lcsw-sample-v1";
const RULE_GENERAL_ID = "nj-lcsw-sample-v1-general";
const RULE_ETHICS_ID = "nj-lcsw-sample-v1-ethics";
const RULE_CULTURAL_ID = "nj-lcsw-sample-v1-cultural";

const GLOBAL_SEED_STATEMENTS = [
  {
    sql: `INSERT OR IGNORE INTO rule_sets (
      id, stable_key, version, profession, credential_name, jurisdiction,
      issuer, total_units, unit_label, cycle_months, source_url, source_title,
      effective_date, last_verified_at, review_status, is_current
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindings: [
      RULE_SET_ID,
      "nj-lcsw",
      1,
      "Social Work",
      "Licensed Clinical Social Worker",
      "New Jersey",
      "New Jersey State Board of Social Work Examiners",
      40,
      "credits",
      24,
      "https://www.njconsumeraffairs.gov/regulations/Chapter-44G-State-Board-of-Social-Work-Examiners.pdf",
      "N.J.A.C. 13:44G — State Board of Social Work Examiners",
      null,
      null,
      "needs_review",
      1,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [RULE_GENERAL_ID, RULE_SET_ID, "General", 32, 0],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [RULE_ETHICS_ID, RULE_SET_ID, "Ethics", 5, 1],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      RULE_CULTURAL_ID,
      RULE_SET_ID,
      "Social and cultural competence",
      3,
      2,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_sets (
      id, stable_key, version, profession, credential_name, jurisdiction,
      issuer, total_units, unit_label, cycle_months, source_url, source_title,
      effective_date, last_verified_at, review_status, is_current
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindings: [
      "pa-rn-2026-v1",
      "pa-rn",
      1,
      "Nursing",
      "Registered Nurse",
      "Pennsylvania",
      "Pennsylvania State Board of Nursing",
      30,
      "hours",
      24,
      "https://www.pa.gov/agencies/dos/department-and-offices/bpoa/boards-commissions/nursing/registered-nurses-licensure-snapshot",
      "PA RN licensure snapshot; check the one-time organ and tissue donation requirement",
      "2026-05-01",
      "2026-07-25",
      "source_linked_check_conditions",
      1,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      "pa-rn-2026-child-abuse",
      "pa-rn-2026-v1",
      "Child abuse recognition and reporting",
      2,
      0,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_sets (
      id, stable_key, version, profession, credential_name, jurisdiction,
      issuer, total_units, unit_label, cycle_months, source_url, source_title,
      effective_date, last_verified_at, review_status, is_current
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindings: [
      "nj-rn-2026-v1",
      "nj-rn",
      1,
      "Nursing",
      "Registered Nurse",
      "New Jersey",
      "New Jersey Board of Nursing",
      30,
      "contact hours",
      24,
      "https://www.njconsumeraffairs.gov/nur/pages/continuing-education-faq.aspx",
      "NJ Board of Nursing CE FAQ; perinatal-care bias training may also apply",
      "2025-07-07",
      "2026-07-25",
      "source_linked_check_conditions",
      1,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      "nj-rn-2026-opioids",
      "nj-rn-2026-v1",
      "Prescription opioids",
      1,
      0,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_sets (
      id, stable_key, version, profession, credential_name, jurisdiction,
      issuer, total_units, unit_label, cycle_months, source_url, source_title,
      effective_date, last_verified_at, review_status, is_current
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindings: [
      "ny-attorney-experienced-2026-v1",
      "ny-attorney-experienced",
      1,
      "Law",
      "Attorney — experienced",
      "New York",
      "New York State Continuing Legal Education Board",
      24,
      "credits",
      24,
      "https://www.nycourts.gov/node/50601",
      "NY CLE requirements for experienced attorneys; cybersecurity overlap rules apply",
      "2023-07-01",
      "2026-07-25",
      "source_linked_check_conditions",
      1,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      "ny-attorney-2026-ethics",
      "ny-attorney-experienced-2026-v1",
      "Ethics and professionalism",
      4,
      0,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      "ny-attorney-2026-diversity",
      "ny-attorney-experienced-2026-v1",
      "Diversity, inclusion, and elimination of bias",
      1,
      1,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      "ny-attorney-2026-cybersecurity",
      "ny-attorney-experienced-2026-v1",
      "Cybersecurity, privacy, and data protection",
      1,
      2,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_sets (
      id, stable_key, version, profession, credential_name, jurisdiction,
      issuer, total_units, unit_label, cycle_months, source_url, source_title,
      effective_date, last_verified_at, review_status, is_current
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindings: [
      "fl-cpa-2026-v1",
      "fl-cpa",
      1,
      "Accounting",
      "Certified Public Accountant",
      "Florida",
      "Florida Board of Accountancy",
      80,
      "CPE hours",
      24,
      "https://www2.myfloridalicense.com/certified-public-accounting/",
      "Florida Board of Accountancy renewal requirements; governmental-audit conditions may apply",
      "2023-10-26",
      "2026-07-25",
      "source_linked_check_conditions",
      1,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      "fl-cpa-2026-accounting-auditing",
      "fl-cpa-2026-v1",
      "Accounting and auditing",
      8,
      0,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      "fl-cpa-2026-ethics",
      "fl-cpa-2026-v1",
      "Florida Board-approved ethics",
      4,
      1,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_sets (
      id, stable_key, version, profession, credential_name, jurisdiction,
      issuer, total_units, unit_label, cycle_months, source_url, source_title,
      effective_date, last_verified_at, review_status, is_current
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindings: [
      "tx-pe-2026-transition-v1",
      "tx-pe-2026-transition",
      1,
      "Engineering",
      "Professional Engineer — 2026 transition cycle",
      "Texas",
      "Texas Board of Professional Engineers and Land Surveyors",
      15,
      "PDH",
      12,
      "https://pels.texas.gov/two_year_renewal_faq.html",
      "Texas two-year renewal transition FAQ; use the interval on your assigned expiration",
      "2026-01-07",
      "2026-07-25",
      "transition_rule_check_assigned_cycle",
      1,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      "tx-pe-2026-ethics",
      "tx-pe-2026-transition-v1",
      "Ethics and professional responsibility",
      1,
      0,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_sets (
      id, stable_key, version, profession, credential_name, jurisdiction,
      issuer, total_units, unit_label, cycle_months, source_url, source_title,
      effective_date, last_verified_at, review_status, is_current
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindings: [
      "ca-psychologist-2026-v1",
      "ca-psychologist",
      1,
      "Psychology",
      "Licensed Psychologist",
      "California",
      "California Board of Psychology",
      36,
      "CPD hours",
      24,
      "https://www.psychology.ca.gov/licensees/cpd_faqs.shtml",
      "California Board of Psychology CPD FAQ; activity-category and supervisor conditions may apply",
      null,
      "2026-07-25",
      "source_linked_check_conditions",
      1,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      "ca-psychologist-2026-law-ethics",
      "ca-psychologist-2026-v1",
      "Laws and ethics",
      4,
      0,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      "ca-psychologist-2026-cultural",
      "ca-psychologist-2026-v1",
      "Cultural diversity and social justice",
      4,
      1,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO badge_definitions
      (id, name, description, icon) VALUES (?, ?, ?, ?)`,
    bindings: [
      "first-credit",
      "First credit",
      "Log your first continuing-education activity.",
      "sparkles",
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO badge_definitions
      (id, name, description, icon) VALUES (?, ?, ?, ?)`,
    bindings: [
      "proof-ready",
      "Proof ready",
      "Keep evidence attached and ready for an audit.",
      "shield-check",
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO badge_definitions
      (id, name, description, icon) VALUES (?, ?, ?, ?)`,
    bindings: [
      "renewal-filed",
      "Renewal filed",
      "Record a completed renewal submission.",
      "badge-check",
    ],
  },
] as const;

let initializationPromise: Promise<void> | null = null;

function statement(
  database: D1Database,
  sql: string,
  bindings: readonly unknown[] = [],
) {
  return database.prepare(sql).bind(...bindings);
}

export async function initializeDatabase(database: D1Database): Promise<void> {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      await database.batch(
        TABLE_STATEMENTS.map((sql) => database.prepare(sql)),
      );
      await database.batch(
        GLOBAL_SEED_STATEMENTS.map((seed) =>
          statement(database, seed.sql, seed.bindings),
        ),
      );
    })().catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }

  await initializationPromise;
}

export async function ensureUser(
  database: D1Database,
  identity: RequestIdentity,
): Promise<void> {
  await database.batch([
    statement(
      database,
      `INSERT INTO users (id, email, display_name, is_demo)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         display_name = excluded.display_name,
         is_demo = excluded.is_demo,
         updated_at = CURRENT_TIMESTAMP`,
      [
        identity.userId,
        identity.email,
        identity.displayName,
        identity.isDemo ? 1 : 0,
      ],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO profiles (user_id, weekly_goal) VALUES (?, ?)`,
      [identity.userId, 4],
    ),
  ]);

  if (identity.isDemo) await ensureDemoWorkspace(database, identity.userId);
}

async function ensureDemoWorkspace(database: D1Database, userId: string) {
  const existing = await statement(
    database,
    `SELECT id FROM credentials WHERE user_id = ? LIMIT 1`,
    [userId],
  ).first<{ id: string }>();
  if (existing) return;

  const demoId = (label: string) =>
    `demo-${label}-${userId.slice(-12)}`;
  const credentialId = demoId("nj-lcsw-2026");
  const reqGeneralId = demoId("nj-lcsw-general");
  const reqEthicsId = demoId("nj-lcsw-ethics");
  const reqCulturalId = demoId("nj-lcsw-cultural");
  const activityId = demoId("ethics-symposium");
  const allocationId = demoId("ethics-allocation");
  const proofTaskId = demoId("task-proof");
  const remainingTaskId = demoId("task-remaining");
  const submitTaskId = demoId("task-submit");

  await database.batch([
    statement(
      database,
      `INSERT OR IGNORE INTO credentials (
        id, user_id, rule_set_id, credential_name, profession, jurisdiction,
        issuer, cycle_start, deadline, total_required, unit_label, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        credentialId,
        userId,
        RULE_SET_ID,
        "Licensed Clinical Social Worker",
        "Social Work",
        "New Jersey",
        "New Jersey State Board of Social Work Examiners",
        "2024-12-01",
        "2026-11-30",
        40,
        "credits",
        "active",
      ],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO credential_requirements
        (id, credential_id, rule_category_id, name, required_units, sort_order)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [reqGeneralId, credentialId, RULE_GENERAL_ID, "General", 32, 0],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO credential_requirements
        (id, credential_id, rule_category_id, name, required_units, sort_order)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [reqEthicsId, credentialId, RULE_ETHICS_ID, "Ethics", 5, 1],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO credential_requirements
        (id, credential_id, rule_category_id, name, required_units, sort_order)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [
        reqCulturalId,
        credentialId,
        RULE_CULTURAL_ID,
        "Social and cultural competence",
        3,
        2,
      ],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO activities (
        id, user_id, title, provider, completion_date, total_units,
        evidence_status, evidence_reference
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        activityId,
        userId,
        "Ethics in Digital Practice",
        "Garden State Social Work Conference",
        "2026-03-14",
        5,
        "attached",
        "Certificate on file",
      ],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO activity_allocations (
        id, activity_id, credential_id, requirement_id, allocated_units
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        allocationId,
        activityId,
        credentialId,
        reqEthicsId,
        5,
      ],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO checklist_tasks (
        id, user_id, credential_id, title, kind, status, due_date,
        completed_at, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        proofTaskId,
        userId,
        credentialId,
        "Save the ethics certificate",
        "evidence",
        "completed",
        "2026-03-21",
        "2026-03-14T17:00:00.000Z",
        0,
      ],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO checklist_tasks (
        id, user_id, credential_id, title, kind, status, due_date, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        remainingTaskId,
        userId,
        credentialId,
        "Complete the remaining 35 credits",
        "progress",
        "pending",
        "2026-10-31",
        1,
      ],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO checklist_tasks (
        id, user_id, credential_id, title, kind, status, due_date, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        submitTaskId,
        userId,
        credentialId,
        "Submit renewal to the board",
        "submission",
        "pending",
        "2026-11-30",
        2,
      ],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO xp_events (
        id, user_id, idempotency_key, event_type, points, related_type, related_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        demoId("xp-onboarding"),
        userId,
        `${userId}:demo:onboarding`,
        "onboarding_complete",
        600,
        "profile",
        userId,
      ],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO xp_events (
        id, user_id, idempotency_key, event_type, points, related_type, related_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        demoId("xp-first-activity"),
        userId,
        `${userId}:activity:${activityId}:logged`,
        "activity_logged",
        50,
        "activity",
        activityId,
      ],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO xp_events (
        id, user_id, idempotency_key, event_type, points, related_type, related_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        demoId("xp-proof-task"),
        userId,
        `${userId}:task:${proofTaskId}:completed`,
        "task_completed",
        30,
        "task",
        proofTaskId,
      ],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO badge_events (
        id, user_id, badge_id, idempotency_key, related_type, related_id
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        demoId("badge-first-credit"),
        userId,
        "first-credit",
        `${userId}:badge:first-credit`,
        "activity",
        activityId,
      ],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO badge_events (
        id, user_id, badge_id, idempotency_key, related_type, related_id
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        demoId("badge-proof-ready"),
        userId,
        "proof-ready",
        `${userId}:badge:proof-ready`,
        "activity",
        activityId,
      ],
    ),
  ]);
}
