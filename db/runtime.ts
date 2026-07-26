import type { RequestIdentity } from "./identity";
import {
  COMPTIA_CATEGORY_SEED_BINDINGS,
  COMPTIA_RULE_SET_IDS,
  COMPTIA_RULE_SET_SEED_BINDINGS,
} from "./catalog/comptia";
import {
  ISC2_CATEGORY_SEED_BINDINGS,
  ISC2_RULE_SET_SEED_BINDINGS,
} from "./catalog/isc2";
import {
  INSURANCE_CATEGORY_SEED_BINDINGS,
  INSURANCE_RULE_SET_SEED_BINDINGS,
} from "./catalog/insurance";
import {
  NREMT_CATEGORY_SEED_BINDINGS,
  NREMT_RULE_SET_SEED_BINDINGS,
} from "./catalog/nremt";
import {
  EDUCATION_CATEGORY_SEED_BINDINGS,
  EDUCATION_MAXIMUM_CLASSIFICATION_RULE_SET_IDS,
  EDUCATION_RULE_SET_SEED_BINDINGS,
} from "./catalog/education";
import {
  MENTAL_HEALTH_CATEGORY_SEED_BINDINGS,
  MENTAL_HEALTH_MAXIMUM_CLASSIFICATION_RULE_SET_IDS,
  MENTAL_HEALTH_RULE_SET_SEED_BINDINGS,
} from "./catalog/mentalHealth";
import {
  PHARMACY_CATEGORY_SEED_BINDINGS,
  PHARMACY_MAXIMUM_CLASSIFICATION_RULE_SET_IDS,
  PHARMACY_RULE_SET_SEED_BINDINGS,
} from "./catalog/pharmacy";
import {
  NURSING_CATEGORY_SEED_BINDINGS,
  NURSING_MAXIMUM_CLASSIFICATION_RULE_SET_IDS,
  NURSING_RENEWAL_TASK_COPY_BINDINGS,
  NURSING_RULE_SET_SEED_BINDINGS,
} from "./catalog/nursing";

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
  `CREATE TABLE IF NOT EXISTS weekly_progression_periods (
    user_id TEXT NOT NULL,
    week_start TEXT NOT NULL,
    weekly_goal INTEGER NOT NULL,
    time_zone TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS weekly_progression_periods_user_week_unique
    ON weekly_progression_periods (user_id, week_start)`,
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
    kind TEXT NOT NULL DEFAULT 'minimum',
    relation TEXT NOT NULL DEFAULT 'independent',
    parent_category_id TEXT,
    applicability TEXT NOT NULL DEFAULT 'always',
    condition_note TEXT,
    exclusive_group TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (rule_set_id) REFERENCES rule_sets(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_category_id) REFERENCES rule_categories(id) ON DELETE SET NULL
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
    kind TEXT NOT NULL DEFAULT 'minimum',
    relation TEXT NOT NULL DEFAULT 'independent',
    parent_requirement_id TEXT,
    applicability TEXT NOT NULL DEFAULT 'always',
    applicability_status TEXT NOT NULL DEFAULT 'applies',
    condition_note TEXT,
    exclusive_group TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE CASCADE,
    FOREIGN KEY (rule_category_id) REFERENCES rule_categories(id) ON DELETE SET NULL,
    FOREIGN KEY (parent_requirement_id) REFERENCES credential_requirements(id) ON DELETE SET NULL
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
    revision INTEGER NOT NULL DEFAULT 1,
    archived_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS activities_user_date_idx
    ON activities (user_id, completion_date)`,
  `CREATE TABLE IF NOT EXISTS evidence_files (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    activity_id TEXT NOT NULL,
    object_key TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    storage_etag TEXT,
    status TEXT NOT NULL DEFAULT 'ready',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (activity_id) REFERENCES activities(id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS evidence_files_object_key_unique
    ON evidence_files (object_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS evidence_files_activity_hash_unique
    ON evidence_files (user_id, activity_id, sha256)`,
  `CREATE INDEX IF NOT EXISTS evidence_files_user_created_idx
    ON evidence_files (user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS evidence_files_activity_created_idx
    ON evidence_files (activity_id, created_at)`,
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
  `CREATE UNIQUE INDEX IF NOT EXISTS activity_allocations_activity_credential_unique
    ON activity_allocations (activity_id, credential_id)`,
  `CREATE INDEX IF NOT EXISTS activity_allocations_credential_idx
    ON activity_allocations (credential_id)`,
  `CREATE INDEX IF NOT EXISTS activity_allocations_requirement_idx
    ON activity_allocations (requirement_id)`,
  `CREATE TABLE IF NOT EXISTS activity_requirement_matches (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    allocation_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    matched_units REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (allocation_id) REFERENCES activity_allocations(id) ON DELETE CASCADE,
    FOREIGN KEY (requirement_id) REFERENCES credential_requirements(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS activity_requirement_matches_allocation_requirement_unique
    ON activity_requirement_matches (allocation_id, requirement_id)`,
  `CREATE INDEX IF NOT EXISTS activity_requirement_matches_user_idx
    ON activity_requirement_matches (user_id)`,
  `CREATE INDEX IF NOT EXISTS activity_requirement_matches_requirement_idx
    ON activity_requirement_matches (requirement_id)`,
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
    is_personal INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1,
    archived_at TEXT,
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
    attestation_kind TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS renewal_submissions_credential_unique
    ON renewal_submissions (credential_id)`,
  `CREATE INDEX IF NOT EXISTS renewal_submissions_user_idx
    ON renewal_submissions (user_id)`,
  `CREATE TABLE IF NOT EXISTS credential_cycle_links (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    series_id TEXT NOT NULL,
    previous_credential_id TEXT,
    cycle_months INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE CASCADE,
    FOREIGN KEY (previous_credential_id) REFERENCES credentials(id) ON DELETE RESTRICT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS credential_cycle_links_credential_unique
    ON credential_cycle_links (credential_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS credential_cycle_links_previous_unique
    ON credential_cycle_links (previous_credential_id)`,
  `CREATE INDEX IF NOT EXISTS credential_cycle_links_user_series_idx
    ON credential_cycle_links (user_id, series_id)`,
  `CREATE TABLE IF NOT EXISTS renewal_acceptances (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    accepted_at TEXT NOT NULL,
    acceptance_reference TEXT,
    official_record_attested_at TEXT,
    next_credential_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE RESTRICT,
    FOREIGN KEY (submission_id) REFERENCES renewal_submissions(id) ON DELETE RESTRICT,
    FOREIGN KEY (next_credential_id) REFERENCES credentials(id) ON DELETE RESTRICT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS renewal_acceptances_credential_unique
    ON renewal_acceptances (credential_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS renewal_acceptances_submission_unique
    ON renewal_acceptances (submission_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS renewal_acceptances_next_credential_unique
    ON renewal_acceptances (next_credential_id)`,
  `CREATE INDEX IF NOT EXISTS renewal_acceptances_user_created_idx
    ON renewal_acceptances (user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS reminder_preferences (
    user_id TEXT PRIMARY KEY NOT NULL,
    in_app_enabled INTEGER NOT NULL DEFAULT 1,
    lead_days TEXT NOT NULL DEFAULT '[90,30,7,1]',
    time_zone TEXT NOT NULL DEFAULT 'UTC',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS reminder_states (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    reminder_key TEXT NOT NULL,
    status TEXT NOT NULL,
    snoozed_until TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS reminder_states_user_key_unique
    ON reminder_states (user_id, reminder_key)`,
  `CREATE INDEX IF NOT EXISTS reminder_states_user_credential_idx
    ON reminder_states (user_id, credential_id)`,
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
  `CREATE TABLE IF NOT EXISTS weekly_quest_claims (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    week_start TEXT NOT NULL,
    quest_key TEXT NOT NULL,
    progress_at_claim INTEGER NOT NULL,
    target INTEGER NOT NULL,
    xp_reward INTEGER NOT NULL,
    claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS weekly_quest_claims_user_week_quest_unique
    ON weekly_quest_claims (user_id, week_start, quest_key)`,
  `CREATE INDEX IF NOT EXISTS weekly_quest_claims_user_week_idx
    ON weekly_quest_claims (user_id, week_start)`,
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

const INTEGRITY_TRIGGER_STATEMENTS = [
  `CREATE TRIGGER IF NOT EXISTS activity_requirement_matches_active_guard
   BEFORE INSERT ON activity_requirement_matches
   FOR EACH ROW
   WHEN NOT EXISTS (
     SELECT 1
     FROM credential_requirements requirement
     JOIN activity_allocations allocation
       ON allocation.id = NEW.allocation_id
     JOIN credentials credential
       ON credential.id = allocation.credential_id
     JOIN activities activity
       ON activity.id = allocation.activity_id
     WHERE requirement.id = NEW.requirement_id
       AND requirement.credential_id = allocation.credential_id
       AND requirement.is_active = 1
       AND requirement.applicability_status = 'applies'
       AND credential.user_id = NEW.user_id
       AND activity.user_id = NEW.user_id
   )
   BEGIN
     SELECT RAISE(ABORT, 'activity_requirement_inactive');
   END`,
  `CREATE TRIGGER IF NOT EXISTS activity_requirement_matches_active_update_guard_v2
   BEFORE UPDATE OF requirement_id ON activity_requirement_matches
   FOR EACH ROW
   WHEN NOT EXISTS (
     SELECT 1
     FROM credential_requirements requirement
     JOIN activity_allocations allocation
       ON allocation.id = NEW.allocation_id
     JOIN credentials credential
       ON credential.id = allocation.credential_id
     JOIN activities activity
       ON activity.id = allocation.activity_id
     WHERE requirement.id = NEW.requirement_id
       AND requirement.credential_id = allocation.credential_id
       AND requirement.is_active = 1
       AND requirement.applicability_status = 'applies'
       AND credential.user_id = NEW.user_id
       AND activity.user_id = NEW.user_id
   )
   BEGIN
     SELECT RAISE(ABORT, 'activity_requirement_inactive');
   END`,
  `CREATE TRIGGER IF NOT EXISTS activities_closed_cycle_core_guard_v2
   BEFORE UPDATE OF title, provider, completion_date, total_units,
     evidence_status, evidence_reference, archived_at
   ON activities
   FOR EACH ROW
   WHEN EXISTS (
     SELECT 1
     FROM activity_allocations allocation
     JOIN credentials credential
       ON credential.id = allocation.credential_id
     WHERE allocation.activity_id = OLD.id
       AND (
         credential.user_id <> OLD.user_id
         OR credential.status = 'renewed'
       )
   )
   BEGIN
     SELECT RAISE(ABORT, 'activity_cycle_closed');
   END`,
  `CREATE TRIGGER IF NOT EXISTS activities_evidence_transition_guard_v2
   BEFORE UPDATE OF archived_at ON activities
   FOR EACH ROW
   WHEN NEW.archived_at IS NOT OLD.archived_at
     AND EXISTS (
       SELECT 1
       FROM evidence_files evidence
       WHERE evidence.activity_id = OLD.id
         AND evidence.user_id = OLD.user_id
         AND evidence.status = 'deleting'
     )
   BEGIN
     SELECT RAISE(ABORT, 'activity_evidence_busy');
   END`,
  `CREATE TRIGGER IF NOT EXISTS credentials_evidence_transition_guard_v2
   BEFORE UPDATE OF status ON credentials
   FOR EACH ROW
   WHEN NEW.status = 'renewed'
     AND OLD.status <> 'renewed'
     AND EXISTS (
       SELECT 1
       FROM activity_allocations allocation
       JOIN activities activity
         ON activity.id = allocation.activity_id
       JOIN evidence_files evidence
         ON evidence.activity_id = activity.id
         AND evidence.user_id = activity.user_id
       WHERE allocation.credential_id = OLD.id
         AND activity.user_id = OLD.user_id
         AND evidence.status = 'deleting'
     )
   BEGIN
     SELECT RAISE(ABORT, 'credential_evidence_busy');
   END`,
  `CREATE TRIGGER IF NOT EXISTS activity_allocations_mutable_guard_v2
   BEFORE INSERT ON activity_allocations
   FOR EACH ROW
   WHEN NOT EXISTS (
     SELECT 1
     FROM activities activity
     JOIN credentials credential
       ON credential.id = NEW.credential_id
     WHERE activity.id = NEW.activity_id
       AND activity.archived_at IS NULL
       AND credential.user_id = activity.user_id
       AND credential.status IN ('active', 'submitted')
   )
   BEGIN
     SELECT RAISE(ABORT, 'activity_allocation_not_mutable');
   END`,
  `CREATE TRIGGER IF NOT EXISTS activity_allocations_update_guard_v2
   BEFORE UPDATE OF requirement_id, allocated_units ON activity_allocations
   FOR EACH ROW
   WHEN NOT EXISTS (
     SELECT 1
     FROM activities activity
     JOIN credentials credential
       ON credential.id = OLD.credential_id
     WHERE activity.id = OLD.activity_id
       AND activity.archived_at IS NULL
       AND credential.user_id = activity.user_id
       AND credential.status IN ('active', 'submitted')
   )
   BEGIN
     SELECT RAISE(ABORT, 'activity_allocation_not_mutable');
   END`,
  `CREATE TRIGGER IF NOT EXISTS activity_allocations_identity_guard_v2
   BEFORE UPDATE OF id, activity_id, credential_id ON activity_allocations
   FOR EACH ROW
   BEGIN
     SELECT RAISE(ABORT, 'activity_allocation_identity_immutable');
   END`,
  `CREATE TRIGGER IF NOT EXISTS activity_allocations_delete_guard_v2
   BEFORE DELETE ON activity_allocations
   FOR EACH ROW
   WHEN EXISTS (
     SELECT 1 FROM activities activity_parent
     WHERE activity_parent.id = OLD.activity_id
   )
     AND EXISTS (
       SELECT 1 FROM credentials credential_parent
       WHERE credential_parent.id = OLD.credential_id
     )
     AND NOT EXISTS (
     SELECT 1
     FROM activities activity
     JOIN credentials credential
       ON credential.id = OLD.credential_id
     WHERE activity.id = OLD.activity_id
       AND activity.archived_at IS NULL
       AND credential.user_id = activity.user_id
       AND credential.status IN ('active', 'submitted')
   )
   BEGIN
     SELECT RAISE(ABORT, 'activity_allocation_not_mutable');
   END`,
  `CREATE TRIGGER IF NOT EXISTS activity_requirement_matches_mutable_insert_guard_v2
   BEFORE INSERT ON activity_requirement_matches
   FOR EACH ROW
   WHEN NOT EXISTS (
     SELECT 1
     FROM activity_allocations allocation
     JOIN activities activity
       ON activity.id = allocation.activity_id
     JOIN credentials credential
       ON credential.id = allocation.credential_id
     WHERE allocation.id = NEW.allocation_id
       AND activity.archived_at IS NULL
       AND activity.user_id = NEW.user_id
       AND credential.user_id = NEW.user_id
       AND credential.status IN ('active', 'submitted')
   )
   BEGIN
     SELECT RAISE(ABORT, 'activity_match_not_mutable');
   END`,
  `CREATE TRIGGER IF NOT EXISTS activity_requirement_matches_mutable_update_guard_v2
   BEFORE UPDATE OF requirement_id, matched_units
   ON activity_requirement_matches
   FOR EACH ROW
   WHEN NOT EXISTS (
     SELECT 1
     FROM activity_allocations allocation
     JOIN activities activity
       ON activity.id = allocation.activity_id
     JOIN credentials credential
       ON credential.id = allocation.credential_id
     WHERE allocation.id = OLD.allocation_id
       AND activity.archived_at IS NULL
       AND activity.user_id = OLD.user_id
       AND credential.user_id = OLD.user_id
       AND credential.status IN ('active', 'submitted')
   )
   BEGIN
     SELECT RAISE(ABORT, 'activity_match_not_mutable');
   END`,
  `CREATE TRIGGER IF NOT EXISTS activity_requirement_matches_identity_guard_v2
   BEFORE UPDATE OF id, user_id, allocation_id
   ON activity_requirement_matches
   FOR EACH ROW
   BEGIN
     SELECT RAISE(ABORT, 'activity_match_identity_immutable');
   END`,
  `CREATE TRIGGER IF NOT EXISTS activity_requirement_matches_mutable_delete_guard_v2
   BEFORE DELETE ON activity_requirement_matches
   FOR EACH ROW
   WHEN EXISTS (
     SELECT 1 FROM activity_allocations allocation_parent
     WHERE allocation_parent.id = OLD.allocation_id
   )
     AND EXISTS (
       SELECT 1 FROM credential_requirements requirement_parent
       WHERE requirement_parent.id = OLD.requirement_id
     )
     AND NOT EXISTS (
     SELECT 1
     FROM activity_allocations allocation
     JOIN activities activity
       ON activity.id = allocation.activity_id
     JOIN credentials credential
       ON credential.id = allocation.credential_id
     WHERE allocation.id = OLD.allocation_id
       AND activity.archived_at IS NULL
       AND activity.user_id = OLD.user_id
       AND credential.user_id = OLD.user_id
       AND credential.status IN ('active', 'submitted')
   )
   BEGIN
     SELECT RAISE(ABORT, 'activity_match_not_mutable');
   END`,
  `CREATE TRIGGER IF NOT EXISTS checklist_tasks_closed_cycle_guard_v2
   BEFORE UPDATE OF title, kind, status, due_date, completed_at, is_personal,
     archived_at
   ON checklist_tasks
   FOR EACH ROW
   WHEN NOT EXISTS (
     SELECT 1
     FROM credentials credential
     WHERE credential.id = OLD.credential_id
       AND credential.user_id = OLD.user_id
       AND credential.status IN ('active', 'submitted')
   )
   BEGIN
     SELECT RAISE(ABORT, 'checklist_cycle_closed');
   END`,
] as const;

const RICH_RULE_COLUMNS = [
  {
    table: "rule_categories",
    name: "kind",
    definition: "kind TEXT NOT NULL DEFAULT 'minimum'",
  },
  {
    table: "rule_categories",
    name: "relation",
    definition: "relation TEXT NOT NULL DEFAULT 'independent'",
  },
  {
    table: "rule_categories",
    name: "parent_category_id",
    definition:
      "parent_category_id TEXT REFERENCES rule_categories(id) ON DELETE SET NULL",
  },
  {
    table: "rule_categories",
    name: "applicability",
    definition: "applicability TEXT NOT NULL DEFAULT 'always'",
  },
  {
    table: "rule_categories",
    name: "condition_note",
    definition: "condition_note TEXT",
  },
  {
    table: "rule_categories",
    name: "exclusive_group",
    definition: "exclusive_group TEXT",
  },
  {
    table: "credential_requirements",
    name: "kind",
    definition: "kind TEXT NOT NULL DEFAULT 'minimum'",
  },
  {
    table: "credential_requirements",
    name: "relation",
    definition: "relation TEXT NOT NULL DEFAULT 'independent'",
  },
  {
    table: "credential_requirements",
    name: "parent_requirement_id",
    definition:
      "parent_requirement_id TEXT REFERENCES credential_requirements(id) ON DELETE SET NULL",
  },
  {
    table: "credential_requirements",
    name: "applicability",
    definition: "applicability TEXT NOT NULL DEFAULT 'always'",
  },
  {
    table: "credential_requirements",
    name: "applicability_status",
    definition: "applicability_status TEXT NOT NULL DEFAULT 'applies'",
  },
  {
    table: "credential_requirements",
    name: "condition_note",
    definition: "condition_note TEXT",
  },
  {
    table: "credential_requirements",
    name: "exclusive_group",
    definition: "exclusive_group TEXT",
  },
  {
    table: "credential_requirements",
    name: "is_active",
    definition: "is_active INTEGER NOT NULL DEFAULT 1",
  },
  {
    table: "renewal_submissions",
    name: "attestation_kind",
    definition: "attestation_kind TEXT",
  },
  {
    table: "renewal_acceptances",
    name: "official_record_attested_at",
    definition: "official_record_attested_at TEXT",
  },
  {
    table: "activities",
    name: "revision",
    definition: "revision INTEGER NOT NULL DEFAULT 1",
  },
  {
    table: "activities",
    name: "archived_at",
    definition: "archived_at TEXT",
  },
  {
    table: "checklist_tasks",
    name: "is_personal",
    definition: "is_personal INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "checklist_tasks",
    name: "revision",
    definition: "revision INTEGER NOT NULL DEFAULT 1",
  },
  {
    table: "checklist_tasks",
    name: "archived_at",
    definition: "archived_at TEXT",
  },
] as const;

const RICH_RULE_INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS rule_categories_parent_idx
    ON rule_categories (parent_category_id)`,
  `CREATE INDEX IF NOT EXISTS credential_requirements_parent_idx
    ON credential_requirements (parent_requirement_id)`,
  `CREATE INDEX IF NOT EXISTS activities_user_archive_date_idx
    ON activities (user_id, archived_at, completion_date)`,
  `CREATE INDEX IF NOT EXISTS checklist_tasks_user_credential_archive_idx
    ON checklist_tasks (user_id, credential_id, archived_at, sort_order)`,
] as const;

const RULE_SET_ID = "nj-lcsw-sample-v1";
const RULE_GENERAL_ID = "nj-lcsw-sample-v1-general";
const RULE_CLINICAL_ID = "nj-lcsw-sample-v1-clinical";
const RULE_ETHICS_ID = "nj-lcsw-sample-v1-ethics";
const RULE_CULTURAL_ID = "nj-lcsw-sample-v1-cultural";
const RULE_OPIOID_ID = "nj-lcsw-sample-v1-opioid";
const NJ_LCSW_CREDIT_CATEGORY_GROUP = "New Jersey LCSW credit category";

const NJ_LCSW_RULE_SET_REFRESH_SQL = `UPDATE rule_sets
SET stable_key = ?, version = ?, profession = ?, credential_name = ?,
    jurisdiction = ?, issuer = ?, total_units = ?, unit_label = ?,
    cycle_months = ?, source_url = ?, source_title = ?, effective_date = ?,
    last_verified_at = ?, review_status = ?, is_current = ?
WHERE id = ?`;

const NJ_LCSW_RULE_SET_REFRESH_BINDINGS = [
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
  "N.J.A.C. 13:44G-6.2 (last revised April 15, 2024) — standard full biennial LCSW renewal. Allocate each credit once among General Social Work, Clinical Practice, Ethics, or Social and Cultural Competence; the opioid topic may overlap that allocation. Up to 8 surplus credits may carry into the next biennium, but License Lantern does not carry them automatically: record only Board-confirmed carryover manually with evidence. A license first issued in the second year is prorated to at least 20 total credits, including 10 clinical, 3 ethics, and 2 social/cultural; use a custom prorated cycle and confirm the opioid requirement with the Board.",
  "2020-03-02",
  "2026-07-26",
  "source_linked_check_conditions",
  1,
  RULE_SET_ID,
] as const;

const NJ_LCSW_CATEGORY_INSERT_SQL = `INSERT OR IGNORE INTO rule_categories (
  id, rule_set_id, name, required_units, kind, relation, parent_category_id,
  applicability, condition_note, exclusive_group, sort_order
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const NJ_LCSW_CATEGORY_REFRESH_SQL = `UPDATE rule_categories
SET rule_set_id = ?, name = ?, required_units = ?, kind = ?, relation = ?,
    parent_category_id = ?, applicability = ?, condition_note = ?,
    exclusive_group = ?, sort_order = ?
WHERE id = ?`;

const NJ_LCSW_CATEGORY_BINDINGS = [
  [
    RULE_GENERAL_ID,
    RULE_SET_ID,
    "General Social Work",
    0,
    "informational",
    "independent",
    null,
    "optional",
    "Catchall for eligible social-work credit not allocated to Clinical Practice, Ethics, or Social and Cultural Competence. Choose exactly one of those four categories for every credited time block.",
    NJ_LCSW_CREDIT_CATEGORY_GROUP,
    0,
  ],
  [
    RULE_CLINICAL_ID,
    RULE_SET_ID,
    "Clinical Practice",
    20,
    "minimum",
    "independent",
    null,
    "always",
    "At least 20 of the 40 credits must be directly related to clinical practice. The same time block cannot also be allocated to General Social Work, Ethics, or Social and Cultural Competence.",
    NJ_LCSW_CREDIT_CATEGORY_GROUP,
    1,
  ],
  [
    RULE_ETHICS_ID,
    RULE_SET_ID,
    "Ethics",
    5,
    "minimum",
    "independent",
    null,
    "always",
    "Allocate five credits to ethics. The same time block cannot also be allocated to General Social Work, Clinical Practice, or Social and Cultural Competence.",
    NJ_LCSW_CREDIT_CATEGORY_GROUP,
    2,
  ],
  [
    RULE_CULTURAL_ID,
    RULE_SET_ID,
    "Social and Cultural Competence",
    3,
    "minimum",
    "independent",
    null,
    "always",
    "Allocate three credits to social and cultural competence. The same time block cannot also be allocated to General Social Work, Clinical Practice, or Ethics.",
    NJ_LCSW_CREDIT_CATEGORY_GROUP,
    3,
  ],
  [
    RULE_OPIOID_ID,
    RULE_SET_ID,
    "Prescription Opioid Drugs",
    1,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least one prescribed credit must concern prescription opioid drugs, including risks and signs of abuse, addiction, and diversion. This topic tag may overlap the one substantive credit-category allocation for the same time block.",
    null,
    4,
  ],
] as const;

const RICH_RULE_CATEGORY_INSERT_SQL = `INSERT OR IGNORE INTO rule_categories (
  id, rule_set_id, name, required_units, kind, relation, parent_category_id,
  applicability, condition_note, sort_order
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const RICH_RULE_CATEGORY_UPDATE_SQL = `UPDATE rule_categories
SET kind = ?, relation = ?, parent_category_id = ?, applicability = ?,
    condition_note = ?
WHERE id = ?`;

const RICH_RULE_CATEGORY_SEED_BINDINGS = [
  [
    "ca-attorney-active-2026-participatory",
    "ca-attorney-active-2026-v1",
    "Participatory Credit",
    12.5,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least 12.5 of the 25 hours must be participatory; this delivery facet may overlap one substantive MCLE subject allocation for the same instructional time.",
    5,
  ],
  [
    "ca-attorney-active-2026-implicit-bias",
    "ca-attorney-active-2026-v1",
    "Implicit Bias and Bias-Reducing Strategies",
    1,
    "minimum",
    "nested",
    "ca-attorney-active-2026-elimination-bias",
    "always",
    "At least 1 of the 2 Elimination of Bias hours must address implicit bias and bias-reducing strategies. Select this leaf instead of its parent; split a multi-subfield course into separate activity entries by non-overlapping hours.",
    6,
  ],
  [
    "ca-attorney-active-2026-prevention-detection",
    "ca-attorney-active-2026-v1",
    "Prevention and Detection",
    1,
    "minimum",
    "nested",
    "ca-attorney-active-2026-competence",
    "always",
    "At least 1 of the 2 Competence hours must address prevention and detection. Select this leaf instead of its parent; split a multi-subfield course into separate activity entries by non-overlapping hours.",
    7,
  ],
  [
    "tx-attorney-active-2026-accredited",
    "tx-attorney-active-2026-v1",
    "Accredited CLE",
    12,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least 12 of the 15 hours must be accredited CLE; this delivery facet overlaps subject categories.",
    1,
  ],
  [
    "tx-attorney-active-2026-self-study",
    "tx-attorney-active-2026-v1",
    "Self-Study CLE",
    3,
    "maximum",
    "overlapping",
    null,
    "optional",
    "No more than 3 of the 15 credited hours may be self-study.",
    2,
  ],
  [
    "tx-attorney-active-2026-accredited-ethics",
    "tx-attorney-active-2026-v1",
    "Accredited Ethics",
    2,
    "minimum",
    "nested",
    "tx-attorney-active-2026-accredited",
    "always",
    "Use this allocation instead of Accredited CLE for accredited ethics hours; it rolls into Accredited CLE and must also be tagged Legal Ethics and Professional Responsibility.",
    3,
  ],
  [
    "ny-attorney-2026-non-cyber-ethics",
    "ny-attorney-experienced-2026-v1",
    "Non-Cybersecurity Ethics and Professionalism",
    1,
    "minimum",
    "nested",
    "ny-attorney-2026-ethics",
    "always",
    "At least 1 of the 4 Ethics and Professionalism hours must be non-cybersecurity ethics because no more than 3 cybersecurity ethics hours may satisfy that minimum.",
    3,
  ],
  [
    "ny-attorney-2026-cybersecurity-general",
    "ny-attorney-experienced-2026-v1",
    "Cybersecurity General",
    1,
    "informational",
    "nested",
    "ny-attorney-2026-cybersecurity",
    "always",
    "Allocation tag only; it rolls into the cybersecurity minimum but not Ethics and Professionalism. Split a 0.5 General/0.5 Ethics course into separate activity entries by non-overlapping hours.",
    4,
  ],
  [
    "ny-attorney-2026-cybersecurity-ethics",
    "ny-attorney-experienced-2026-v1",
    "Cybersecurity Ethics",
    1,
    "informational",
    "nested",
    "ny-attorney-2026-cybersecurity",
    "always",
    "Allocation tag only; it rolls into the cybersecurity minimum and must also be tagged Ethics and Professionalism. Split a 0.5 General/0.5 Ethics course into separate activity entries by non-overlapping hours.",
    5,
  ],
  [
    "fl-attorney-active-2026-technology",
    "fl-attorney-active-2026-v1",
    "Technology",
    3,
    "minimum",
    "independent",
    null,
    "always",
    "Included within the 30-hour total and must carry approved technology credit.",
    0,
  ],
  [
    "fl-attorney-active-2026-ethics-professionalism-wellness",
    "fl-attorney-active-2026-v1",
    "Legal Ethics, Professionalism, Substance Use Disorder, or Mental Health and Wellness",
    5,
    "minimum",
    "independent",
    null,
    "always",
    "A pooled 5-hour minimum that includes the nested mandatory Florida Legal Professionalism course.",
    1,
  ],
  [
    "fl-attorney-active-2026-florida-professionalism",
    "fl-attorney-active-2026-v1",
    "Florida Legal Professionalism Course",
    2,
    "minimum",
    "nested",
    "fl-attorney-active-2026-ethics-professionalism-wellness",
    "always",
    "Must be the 2-credit Bar-produced course approved by the Supreme Court of Florida.",
    2,
  ],
  [
    "nj-attorney-active-2026-ethics",
    "nj-attorney-active-2026-v1",
    "Ethics and Professionalism",
    5,
    "minimum",
    "independent",
    null,
    "always",
    "Includes the nested 2-credit Diversity, Inclusion and Elimination of Bias minimum.",
    0,
  ],
  [
    "nj-attorney-active-2026-diversity",
    "nj-attorney-active-2026-v1",
    "Diversity, Inclusion and Elimination of Bias",
    2,
    "minimum",
    "nested",
    "nj-attorney-active-2026-ethics",
    "always",
    "These 2 credits are part of, not additional to, the 5-credit Ethics and Professionalism minimum.",
    1,
  ],
  [
    "nj-attorney-active-2026-technology",
    "nj-attorney-active-2026-v1",
    "Technology-related",
    1,
    "minimum",
    "overlapping",
    null,
    "conditional",
    "Applies to compliance cycles ending December 31, 2027 or later; confirm the attorney's assigned cycle before activating.",
    2,
  ],
  [
    "nj-attorney-active-2026-live",
    "nj-attorney-active-2026-v1",
    "Live Instruction",
    12,
    "minimum",
    "overlapping",
    null,
    "conditional",
    "Qualifying interactive synchronous remote courses count as live; confirm the attorney's cycle and any applicable exceptions.",
    3,
  ],
  [
    "pa-attorney-active-2026-ethics",
    "pa-attorney-active-2026-v1",
    "Ethics, Professionalism, or Substance Abuse",
    2,
    "minimum",
    "independent",
    null,
    "always",
    "Included within the annual 12-credit total.",
    0,
  ],
  [
    "pa-attorney-active-2026-live",
    "pa-attorney-active-2026-v1",
    "Live Online or In-Person/Classroom",
    6,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least 6 of the annual 12 credits must use an eligible live online or in-person/classroom format.",
    1,
  ],
  [
    "pa-attorney-active-2026-on-demand",
    "pa-attorney-active-2026-v1",
    "Pre-Recorded/On-Demand",
    6,
    "maximum",
    "overlapping",
    null,
    "optional",
    "No more than 6 of the annual 12 credits may be earned through pre-recorded or on-demand formats.",
    2,
  ],
  [
    "ca-cpa-2026-technical",
    "ca-cpa-2026-v1",
    "Technical Subject Matter",
    40,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least 40 of 80 hours in a standard renewal must be technical; first-renewal totals are prorated and remain one-half technical.",
    1,
  ],
  [
    "ca-cpa-2026-government-auditing",
    "ca-cpa-2026-v1",
    "Government Auditing",
    24,
    "minimum",
    "nested",
    "ca-cpa-2026-technical",
    "conditional",
    "Applies to licensees performing qualifying government audit work; these hours also satisfy the A&A minimum when both apply.",
    2,
  ],
  [
    "ca-cpa-2026-accounting-auditing",
    "ca-cpa-2026-v1",
    "Accounting and Auditing",
    24,
    "minimum",
    "nested",
    "ca-cpa-2026-technical",
    "conditional",
    "Applies when performing audit, review, compilation, or other qualifying attestation work.",
    3,
  ],
  [
    "ca-cpa-2026-preparation-engagements",
    "ca-cpa-2026-v1",
    "Preparation Engagements",
    8,
    "minimum",
    "nested",
    "ca-cpa-2026-technical",
    "conditional",
    "Applies when preparation engagements are the highest applicable accounting service.",
    4,
  ],
  [
    "ca-cpa-2026-fraud",
    "ca-cpa-2026-v1",
    "Fraud",
    4,
    "minimum",
    "nested",
    "ca-cpa-2026-technical",
    "conditional",
    "Applies when any government auditing, A&A, or preparation-engagement requirement applies; nested within Technical Subject Matter but not within the related 24- or 8-hour minimum.",
    5,
  ],
  [
    "nj-cpa-2026-technical",
    "nj-cpa-2026-v1",
    "Technical Subjects",
    60,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least 60 of 120 credits in a standard, non-initial triennial renewal must be technical.",
    1,
  ],
  [
    "nj-cpa-2026-accounting-auditing",
    "nj-cpa-2026-v1",
    "Accounting and Auditing",
    24,
    "minimum",
    "nested",
    "nj-cpa-2026-technical",
    "conditional",
    "Applies when the licensee is engaged in public accountancy; may include review and compilation.",
    2,
  ],
  [
    "pmi-pmp-2026-education",
    "pmi-pmp-2026-v1",
    "Education",
    35,
    "minimum",
    "independent",
    null,
    "always",
    "At least 35 of the 60 PDUs must be Education PDUs.",
    0,
  ],
  [
    "pmi-pmp-2026-ways-of-working",
    "pmi-pmp-2026-v1",
    "Ways of Working",
    8,
    "minimum",
    "nested",
    "pmi-pmp-2026-education",
    "always",
    "Nested within Education; at least 8 PDUs are required.",
    1,
  ],
  [
    "pmi-pmp-2026-power-skills",
    "pmi-pmp-2026-v1",
    "Power Skills",
    8,
    "minimum",
    "nested",
    "pmi-pmp-2026-education",
    "always",
    "Nested within Education; at least 8 PDUs are required.",
    2,
  ],
  [
    "pmi-pmp-2026-business-acumen",
    "pmi-pmp-2026-v1",
    "Business Acumen",
    8,
    "minimum",
    "nested",
    "pmi-pmp-2026-education",
    "always",
    "Nested within Education; at least 8 PDUs are required.",
    3,
  ],
  [
    "pmi-pmp-2026-giving-back",
    "pmi-pmp-2026-v1",
    "Giving Back to the Profession",
    25,
    "maximum",
    "independent",
    null,
    "optional",
    "Optional; at most 25 PDUs may be credited in this category.",
    4,
  ],
  [
    "pmi-pmp-2026-working-professional",
    "pmi-pmp-2026-v1",
    "Working as a Professional",
    8,
    "maximum",
    "nested",
    "pmi-pmp-2026-giving-back",
    "optional",
    "Optional subset of Giving Back; at most 8 PDUs, claimable once per cycle, and these PDUs cannot carry over.",
    5,
  ],
  [
    "ca-physician-md-2026-geriatrics",
    "ca-physician-md-2026-v1",
    "Geriatric Medicine and Care of Older Patients",
    10,
    "minimum",
    "independent",
    null,
    "conditional",
    "Applies each cycle only to general internists and family physicians whose patient population is more than 25% age 65 or older; requirement is 20% of the 50-hour total.",
    0,
  ],
  [
    "tx-physician-2026-formal",
    "tx-physician-2026-v1",
    "Formal Category 1 or 1A",
    24,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least half of the 48-credit total must be formal Category 1 or 1A.",
    0,
  ],
  [
    "tx-physician-2026-ethics",
    "tx-physician-2026-v1",
    "Medical Ethics and Professional Responsibility",
    2,
    "minimum",
    "nested",
    "tx-physician-2026-formal",
    "always",
    "Must be formal Category 1 or 1A. Properly approved pain/opioid or human-trafficking coursework may also satisfy this requirement; tag both when applicable.",
    1,
  ],
  [
    "tx-physician-2026-pain-opioids",
    "tx-physician-2026-v1",
    "Pain Management and Opioid Prescribing",
    2,
    "minimum",
    "nested",
    "tx-physician-2026-formal",
    "conditional",
    "For physicians practicing direct patient care: due within one year of license issuance, again for the second renewal, then every fourth renewal/eight years. Confirm whether this is a due cycle.",
    2,
  ],
  [
    "tx-physician-2026-human-trafficking",
    "tx-physician-2026-v1",
    "Human Trafficking Prevention",
    1,
    "minimum",
    "nested",
    "tx-physician-2026-formal",
    "conditional",
    "For physicians practicing direct patient care: due in the first renewal period and every third renewal/six years thereafter. Course must be HHSC-approved.",
    3,
  ],
  [
    "tx-physician-2026-pain-clinic",
    "tx-physician-2026-v1",
    "Pain Management Clinic Training",
    10,
    "minimum",
    "overlapping",
    null,
    "conditional",
    "Applies to physicians providing patient care in a certified pain management clinic; requires 10 hours related to pain management in the preceding two years. Qualifying pain/opioid hours may overlap.",
    4,
  ],
  [
    "tx-physician-2026-forensic-evidence",
    "tx-physician-2026-v1",
    "Forensic Evidence Collection",
    2,
    "minimum",
    "overlapping",
    null,
    "conditional",
    "Applies only to renewals on or after September 1, 2026 for physicians treating qualifying patients in an emergency-room or urgent-care setting. TMB had not posted approved courses as of July 25, 2026.",
    5,
  ],
  [
    "fl-medical-doctor-md-2026-general",
    "fl-medical-doctor-md-2026-v1",
    "General AMA Category I",
    38,
    "minimum",
    "independent",
    null,
    "always",
    "Standard-renewal requirement; the first renewal follows materially different rules.",
    0,
  ],
  [
    "fl-medical-doctor-md-2026-medical-errors",
    "fl-medical-doctor-md-2026-v1",
    "Prevention of Medical Errors",
    2,
    "minimum",
    "independent",
    null,
    "always",
    "Must satisfy the Board's current course-content and provider requirements, including the specified commonly misdiagnosed conditions.",
    1,
  ],
  [
    "fl-medical-doctor-md-2026-controlled-substances",
    "fl-medical-doctor-md-2026-v1",
    "Prescribing Controlled Substances",
    2,
    "minimum",
    "nested",
    "fl-medical-doctor-md-2026-general",
    "conditional",
    "Applies to physicians registered with the U.S. DEA and authorized to prescribe controlled substances; must be a Board-approved course.",
    2,
  ],
  [
    "fl-medical-doctor-md-2026-domestic-violence",
    "fl-medical-doctor-md-2026-v1",
    "Domestic Violence",
    2,
    "minimum",
    "nested",
    "fl-medical-doctor-md-2026-general",
    "conditional",
    "Required every third biennium and included within the 38 general hours. Confirm whether this is the due cycle in CE Broker.",
    3,
  ],
  [
    "nj-physician-2026-category-one",
    "nj-physician-2026-v1",
    "Category I",
    40,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least 40 of the 100 biennial credits must be Category I.",
    0,
  ],
  [
    "nj-physician-2026-end-of-life",
    "nj-physician-2026-v1",
    "End-of-Life Care",
    2,
    "minimum",
    "nested",
    "nj-physician-2026-category-one",
    "always",
    "Two of the 40 Category I credits.",
    1,
  ],
  [
    "nj-physician-2026-opioids",
    "nj-physician-2026-v1",
    "Prescription Opioid Drugs",
    1,
    "minimum",
    "nested",
    "nj-physician-2026-category-one",
    "always",
    "One of the 40 Category I credits; topics include responsible prescribing, alternatives, and abuse, addiction, and diversion risks.",
    2,
  ],
  [
    "nj-physician-2026-sexual-misconduct",
    "nj-physician-2026-v1",
    "Sexual Misconduct Prevention",
    2,
    "minimum",
    "nested",
    "nj-physician-2026-category-one",
    "always",
    "Category I requirement beginning with the renewal period that started July 1, 2025; the course or course series must cover every topic listed in N.J.A.C. 13:35-6.15(e).",
    3,
  ],
  [
    "nj-physician-2026-perinatal-bias",
    "nj-physician-2026-v1",
    "Perinatal Explicit and Implicit Bias",
    1,
    "minimum",
    "nested",
    "nj-physician-2026-category-one",
    "conditional",
    "Applies to a licensee who provides perinatal treatment and care to pregnant persons; one of the 40 Category I credits.",
    4,
  ],
  [
    "nj-physician-2026-volunteer-care",
    "nj-physician-2026-v1",
    "Qualifying Volunteer Medical Care",
    10,
    "maximum",
    "independent",
    null,
    "optional",
    "Up to 10 credits per biennium, earned at one CME credit per two qualifying volunteer-care hours; these credits do not count toward the Category I minimum.",
    5,
  ],
  [
    "pa-medical-physician-md-2026-category-one",
    "pa-medical-physician-md-2026-v1",
    "AMA PRA Category 1",
    20,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least 20 of the 100 biennial hours must be AMA PRA Category 1.",
    0,
  ],
  [
    "pa-medical-physician-md-2026-patient-safety",
    "pa-medical-physician-md-2026-v1",
    "Patient Safety and Risk Management",
    12,
    "minimum",
    "overlapping",
    null,
    "always",
    "May be AMA PRA Category 1 or Category 2 and may overlap the Category 1 minimum when the activity qualifies for both.",
    1,
  ],
  [
    "pa-medical-physician-md-2026-child-abuse",
    "pa-medical-physician-md-2026-v1",
    "Child Abuse Recognition and Reporting",
    2,
    "minimum",
    "overlapping",
    null,
    "always",
    "Must be Board-approved training under 49 Pa. Code § 16.108(b) and is included in the 100-hour total; it cannot satisfy the patient-safety minimum.",
    2,
  ],
  [
    "pa-medical-physician-md-2026-opioid",
    "pa-medical-physician-md-2026-v1",
    "Pain, Addiction, or Opioid Prescribing",
    2,
    "minimum",
    "overlapping",
    null,
    "conditional",
    "Applies each renewal to a physician with a current DEA registration or who lawfully uses another person's or entity's DEA registration to prescribe controlled substances. Counts toward the 100-hour total but not the patient-safety minimum.",
    3,
  ],
] as const;

const RICH_RULE_CATEGORY_UPDATE_BINDINGS = [
  [
    "minimum",
    "independent",
    null,
    "always",
    null,
    "ca-attorney-active-2026-legal-ethics",
  ],
  [
    "minimum",
    "independent",
    null,
    "always",
    "Includes a nested 1-hour implicit-bias and bias-reducing-strategies minimum.",
    "ca-attorney-active-2026-elimination-bias",
  ],
  [
    "minimum",
    "independent",
    null,
    "always",
    "Includes a nested 1-hour prevention-and-detection minimum.",
    "ca-attorney-active-2026-competence",
  ],
  [
    "minimum",
    "independent",
    null,
    "always",
    null,
    "ca-attorney-active-2026-technology",
  ],
  [
    "minimum",
    "independent",
    null,
    "always",
    null,
    "ca-attorney-active-2026-civility",
  ],
  [
    "minimum",
    "independent",
    null,
    "always",
    "At least 2 of the 3 hours must be accredited; no more than 1 may be self-study.",
    "tx-attorney-active-2026-ethics",
  ],
  [
    "minimum",
    "nested",
    "ca-cpa-2026-technical",
    "conditional",
    "Not required on a first renewal unless the license has been held for a full two years and 80 CE hours are required; ethics is technical subject matter.",
    "ca-cpa-2026-ethics",
  ],
  [
    "minimum",
    "nested",
    "ca-cpa-2026-technical",
    "conditional",
    "Applies when any government auditing, A&A, or preparation-engagement requirement applies; nested within Technical Subject Matter but not within the related 24- or 8-hour minimum.",
    "ca-cpa-2026-fraud",
  ],
  [
    "minimum",
    "independent",
    null,
    "always",
    "New licensees complete the Board-approved orientation course within six months; the course is required again in each later triennial period.",
    "nj-cpa-2026-law-ethics",
  ],
] as const;

const ATTORNEY_RULE_SET_REFRESH_SQL = `UPDATE rule_sets
SET stable_key = ?, version = ?, profession = ?, credential_name = ?,
    jurisdiction = ?, issuer = ?, total_units = ?, unit_label = ?,
    cycle_months = ?, source_url = ?, source_title = ?, effective_date = ?,
    last_verified_at = ?, review_status = ?, is_current = ?
WHERE id = ?`;

const ATTORNEY_RULE_SET_REFRESH_BINDINGS = [
  [
    "ca-attorney-active",
    1,
    "Law",
    "Attorney — active",
    "California",
    "State Bar of California",
    25,
    "MCLE credit hours",
    36,
    "https://www.calbar.ca.gov/legal-professionals/maintaining-compliance/mcle/mcle-requirements",
    "MCLE Requirements | The State Bar of California; standard full-cycle active-licensee baseline—same instructional time may count in only one substantive MCLE subfield, so split multi-subfield courses into separate activity entries by non-overlapping hours; confirm compliance group, transitional cycle, proration, exemptions, and separate new-attorney/specialist duties",
    "2024-01-01",
    "2026-07-26",
    "source_linked_check_conditions",
    1,
    "ca-attorney-active-2026-v1",
  ],
  [
    "tx-attorney-active",
    1,
    "Law",
    "Attorney — active",
    "Texas",
    "State Bar of Texas",
    15,
    "CLE credit hours",
    12,
    "https://www.texasbar.com/AM/Template.cfm?ContentID=71381&Section=MCLE_Rules1&Template=%2FCM%2FContentDisplay.cfm",
    "Texas MCLE Regulations (effective April 24, 2026); standard annual active-member baseline—accredited ethics must be allocated as Accredited Ethics plus Legal Ethics, while self-study ethics must be allocated as Self-Study CLE plus Legal Ethics; confirm birth-month dates, the separate initial 24-month cycle, grace period, carryover, exemptions, and specialty duties",
    "2026-04-24",
    "2026-07-26",
    "source_linked_check_conditions",
    1,
    "tx-attorney-active-2026-v1",
  ],
  [
    "ny-attorney-experienced",
    1,
    "Law",
    "Attorney — experienced",
    "New York",
    "New York State Continuing Legal Education Board",
    24,
    "CLE credit hours",
    24,
    "https://www.nycourts.gov/LegacyPDFS/attorneys/cle/17b-Rules-1500-22a-Cybersecurity-Experienced-Attorney-Requirement.pdf",
    "22 NYCRR 1500.22(a) — Experienced Attorney Minimum Requirements (revised effective July 1, 2023); split General/Ethics cybersecurity hours into separate non-overlapping activity entries and confirm the assigned reporting cycle and deadline, partial-practice proration, cybersecurity overlap, admission cohort, newly admitted/transitional rules, exemptions, carryover, and format",
    "2023-07-01",
    "2026-07-26",
    "source_linked_check_conditions",
    1,
    "ny-attorney-experienced-2026-v1",
  ],
  [
    "fl-attorney-active",
    1,
    "Law",
    "Attorney — active",
    "Florida",
    "The Florida Bar",
    30,
    "CLE credit hours",
    36,
    "https://www-media.floridabar.org/uploads/2026/06/2026_12-JUNE-Chapter-6-RRTFB-1.pdf",
    "Rules Regulating The Florida Bar, Chapter 6 — Rule 6-10.3 (effective June 15, 2026); standard CLER baseline—confirm assigned reporting date, BSCR, exemptions, credit methods, and specialty/status duties",
    "2026-06-15",
    "2026-07-26",
    "source_linked_check_conditions",
    1,
    "fl-attorney-active-2026-v1",
  ],
  [
    "nj-attorney-active",
    1,
    "Law",
    "Attorney — active",
    "New Jersey",
    "Supreme Court of New Jersey Board on Continuing Legal Education",
    24,
    "CLE credit hours",
    24,
    "https://www.njcourts.gov/notices/notice-and-order-continuing-legal-education-amendments-court-rule-r-142-1-and-cle",
    "N.J. Ct. R. 1:42-1 and BCLE Regulation 201:1; 2026 technology amendment and cycle/live conditions apply—confirm cycle group, deadline, admission, waivers, exemptions, carryover, status, and format",
    "2021-01-01",
    "2026-07-26",
    "source_linked_check_conditions",
    1,
    "nj-attorney-active-2026-v1",
  ],
  [
    "pa-attorney-active",
    1,
    "Law",
    "Attorney — active",
    "Pennsylvania",
    "Pennsylvania Continuing Legal Education Board",
    12,
    "CLE credit hours",
    12,
    "https://www.pacle.org/rules-and-regulations",
    "Pennsylvania CLE Board Rules and Regulations — annual ethics and delivery requirements; confirm compliance group, deadline, carryover, exemptions, admission/status, and delivery limits",
    "2014-01-30",
    "2026-07-26",
    "source_linked_check_conditions",
    1,
    "pa-attorney-active-2026-v1",
  ],
] as const;

const ATTORNEY_RULE_CATEGORY_REFRESH_SQL = `UPDATE rule_categories
SET rule_set_id = ?, name = ?, required_units = ?, kind = ?, relation = ?,
    parent_category_id = ?, applicability = ?, condition_note = ?,
    exclusive_group = ?, sort_order = ?
WHERE id = ?`;

const ATTORNEY_RULE_CATEGORY_REFRESH_BINDINGS = [
  [
    "ca-attorney-active-2026-v1",
    "Legal Ethics",
    4,
    "minimum",
    "independent",
    null,
    "always",
    "Allocate only the instructional time designated Legal Ethics. If one course covers multiple substantive MCLE subfields, split it into separate activity entries by non-overlapping hours.",
    "California MCLE subject allocation",
    0,
    "ca-attorney-active-2026-legal-ethics",
  ],
  [
    "ca-attorney-active-2026-v1",
    "Elimination of Bias",
    2,
    "minimum",
    "independent",
    null,
    "always",
    "Includes a nested 1-hour implicit-bias and bias-reducing-strategies minimum. If one course covers multiple substantive MCLE subfields, split it into separate activity entries by non-overlapping hours.",
    "California MCLE subject allocation",
    1,
    "ca-attorney-active-2026-elimination-bias",
  ],
  [
    "ca-attorney-active-2026-v1",
    "Competence",
    2,
    "minimum",
    "independent",
    null,
    "always",
    "Includes a nested 1-hour prevention-and-detection minimum. If one course covers multiple substantive MCLE subfields, split it into separate activity entries by non-overlapping hours.",
    "California MCLE subject allocation",
    2,
    "ca-attorney-active-2026-competence",
  ],
  [
    "ca-attorney-active-2026-v1",
    "Technology",
    1,
    "minimum",
    "independent",
    null,
    "always",
    "Allocate only the instructional time designated Technology. If one course covers multiple substantive MCLE subfields, split it into separate activity entries by non-overlapping hours.",
    "California MCLE subject allocation",
    3,
    "ca-attorney-active-2026-technology",
  ],
  [
    "ca-attorney-active-2026-v1",
    "Civility",
    1,
    "minimum",
    "independent",
    null,
    "always",
    "Allocate only the instructional time designated Civility. If one course covers multiple substantive MCLE subfields, split it into separate activity entries by non-overlapping hours.",
    "California MCLE subject allocation",
    4,
    "ca-attorney-active-2026-civility",
  ],
  [
    "ca-attorney-active-2026-v1",
    "Participatory Credit",
    12.5,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least 12.5 of the 25 hours must be participatory; this delivery facet may overlap one substantive MCLE subject allocation for the same instructional time.",
    null,
    5,
    "ca-attorney-active-2026-participatory",
  ],
  [
    "ca-attorney-active-2026-v1",
    "Implicit Bias and Bias-Reducing Strategies",
    1,
    "minimum",
    "nested",
    "ca-attorney-active-2026-elimination-bias",
    "always",
    "At least 1 of the 2 Elimination of Bias hours must address implicit bias and bias-reducing strategies. Select this leaf instead of its parent; split a multi-subfield course into separate activity entries by non-overlapping hours.",
    "California MCLE subject allocation",
    6,
    "ca-attorney-active-2026-implicit-bias",
  ],
  [
    "ca-attorney-active-2026-v1",
    "Prevention and Detection",
    1,
    "minimum",
    "nested",
    "ca-attorney-active-2026-competence",
    "always",
    "At least 1 of the 2 Competence hours must address prevention and detection. Select this leaf instead of its parent; split a multi-subfield course into separate activity entries by non-overlapping hours.",
    "California MCLE subject allocation",
    7,
    "ca-attorney-active-2026-prevention-detection",
  ],
  [
    "tx-attorney-active-2026-v1",
    "Legal Ethics and Professional Responsibility",
    3,
    "minimum",
    "independent",
    null,
    "always",
    "At least 2 of the 3 hours used for this minimum must be accredited. For accredited ethics select Accredited Ethics plus this tag; for self-study ethics select Self-Study CLE plus this tag.",
    null,
    0,
    "tx-attorney-active-2026-ethics",
  ],
  [
    "tx-attorney-active-2026-v1",
    "Accredited CLE",
    12,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least 12 of the 15 hours must be accredited CLE. Select this delivery tag for non-ethics accredited hours; select Accredited Ethics instead for accredited ethics hours because that leaf rolls up here.",
    "Texas CLE delivery type",
    1,
    "tx-attorney-active-2026-accredited",
  ],
  [
    "tx-attorney-active-2026-v1",
    "Self-Study CLE",
    3,
    "maximum",
    "overlapping",
    null,
    "optional",
    "No more than 3 of the 15 credited hours may be self-study. A self-study ethics activity must also be tagged Legal Ethics and Professional Responsibility; there is no separate deduction for ethics hours within this overall cap.",
    "Texas CLE delivery type",
    2,
    "tx-attorney-active-2026-self-study",
  ],
  [
    "tx-attorney-active-2026-v1",
    "Accredited Ethics",
    2,
    "minimum",
    "nested",
    "tx-attorney-active-2026-accredited",
    "always",
    "Use this delivery allocation instead of Accredited CLE for accredited ethics hours. It rolls into Accredited CLE and must also be tagged Legal Ethics and Professional Responsibility.",
    "Texas CLE delivery type",
    3,
    "tx-attorney-active-2026-accredited-ethics",
  ],
  [
    "ny-attorney-experienced-2026-v1",
    "Ethics and Professionalism",
    4,
    "minimum",
    "independent",
    null,
    "always",
    "Four total hours are required. Designated Cybersecurity Ethics may overlap, but at least 1 hour must use the nested Non-Cybersecurity Ethics and Professionalism allocation so no more than 3 cybersecurity hours satisfy this minimum.",
    null,
    0,
    "ny-attorney-2026-ethics",
  ],
  [
    "ny-attorney-experienced-2026-v1",
    "Diversity, Inclusion and Elimination of Bias",
    1,
    "minimum",
    "independent",
    null,
    "always",
    null,
    null,
    1,
    "ny-attorney-2026-diversity",
  ],
  [
    "ny-attorney-experienced-2026-v1",
    "Cybersecurity, Privacy and Data Protection",
    1,
    "minimum",
    "overlapping",
    null,
    "always",
    "Use exactly one nested Cybersecurity General or Cybersecurity Ethics allocation for each time block. Split a 0.5 General/0.5 Ethics course into separate activity entries by non-overlapping hours; Cybersecurity Ethics must also be tagged Ethics and Professionalism.",
    null,
    2,
    "ny-attorney-2026-cybersecurity",
  ],
  [
    "ny-attorney-experienced-2026-v1",
    "Non-Cybersecurity Ethics and Professionalism",
    1,
    "minimum",
    "nested",
    "ny-attorney-2026-ethics",
    "always",
    "At least 1 of the 4 Ethics and Professionalism hours must use this non-cybersecurity allocation. Select this leaf instead of its Ethics and Professionalism parent for that time block.",
    "New York ethics/cybersecurity allocation",
    3,
    "ny-attorney-2026-non-cyber-ethics",
  ],
  [
    "ny-attorney-experienced-2026-v1",
    "Cybersecurity General",
    1,
    "informational",
    "nested",
    "ny-attorney-2026-cybersecurity",
    "always",
    "Allocation tag only; it rolls into the cybersecurity minimum but not Ethics and Professionalism. Split a 0.5 General/0.5 Ethics course into separate activity entries by non-overlapping hours.",
    "New York ethics/cybersecurity allocation",
    4,
    "ny-attorney-2026-cybersecurity-general",
  ],
  [
    "ny-attorney-experienced-2026-v1",
    "Cybersecurity Ethics",
    1,
    "informational",
    "nested",
    "ny-attorney-2026-cybersecurity",
    "always",
    "Allocation tag only; it rolls into the cybersecurity minimum and must also be tagged Ethics and Professionalism. At least 1 additional hour must use Non-Cybersecurity Ethics; split a 0.5/0.5 course into separate activity entries.",
    "New York ethics/cybersecurity allocation",
    5,
    "ny-attorney-2026-cybersecurity-ethics",
  ],
  [
    "fl-attorney-active-2026-v1",
    "Technology",
    3,
    "minimum",
    "independent",
    null,
    "always",
    "Included within the 30-hour total and must carry approved technology credit.",
    null,
    0,
    "fl-attorney-active-2026-technology",
  ],
  [
    "fl-attorney-active-2026-v1",
    "Legal Ethics, Professionalism, Substance Use Disorder, or Mental Health and Wellness",
    5,
    "minimum",
    "independent",
    null,
    "always",
    "A pooled 5-hour minimum that includes the nested mandatory Florida Legal Professionalism course.",
    null,
    1,
    "fl-attorney-active-2026-ethics-professionalism-wellness",
  ],
  [
    "fl-attorney-active-2026-v1",
    "Florida Legal Professionalism Course",
    2,
    "minimum",
    "nested",
    "fl-attorney-active-2026-ethics-professionalism-wellness",
    "always",
    "Must be the 2-credit Bar-produced course approved by the Supreme Court of Florida.",
    null,
    2,
    "fl-attorney-active-2026-florida-professionalism",
  ],
  [
    "nj-attorney-active-2026-v1",
    "Ethics and Professionalism",
    5,
    "minimum",
    "independent",
    null,
    "always",
    "Includes the nested 2-credit Diversity, Inclusion and Elimination of Bias minimum.",
    null,
    0,
    "nj-attorney-active-2026-ethics",
  ],
  [
    "nj-attorney-active-2026-v1",
    "Diversity, Inclusion and Elimination of Bias",
    2,
    "minimum",
    "nested",
    "nj-attorney-active-2026-ethics",
    "always",
    "These 2 credits are part of, not additional to, the 5-credit Ethics and Professionalism minimum.",
    null,
    1,
    "nj-attorney-active-2026-diversity",
  ],
  [
    "nj-attorney-active-2026-v1",
    "Technology-related",
    1,
    "minimum",
    "overlapping",
    null,
    "conditional",
    "Applies to compliance cycles ending December 31, 2027 or later; confirm the attorney's assigned cycle before activating.",
    null,
    2,
    "nj-attorney-active-2026-technology",
  ],
  [
    "nj-attorney-active-2026-v1",
    "Live Instruction",
    12,
    "minimum",
    "overlapping",
    null,
    "conditional",
    "Qualifying interactive synchronous remote courses count as live; confirm the attorney's cycle and any applicable exceptions.",
    null,
    3,
    "nj-attorney-active-2026-live",
  ],
  [
    "pa-attorney-active-2026-v1",
    "Ethics, Professionalism, or Substance Abuse",
    2,
    "minimum",
    "independent",
    null,
    "always",
    "Included within the annual 12-credit total.",
    null,
    0,
    "pa-attorney-active-2026-ethics",
  ],
  [
    "pa-attorney-active-2026-v1",
    "Live Online or In-Person/Classroom",
    6,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least 6 of the annual 12 credits must use an eligible live online or in-person/classroom format.",
    "Pennsylvania CLE delivery type",
    1,
    "pa-attorney-active-2026-live",
  ],
  [
    "pa-attorney-active-2026-v1",
    "Pre-Recorded/On-Demand",
    6,
    "maximum",
    "overlapping",
    null,
    "optional",
    "No more than 6 of the annual 12 credits may be earned through pre-recorded or on-demand formats.",
    "Pennsylvania CLE delivery type",
    2,
    "pa-attorney-active-2026-on-demand",
  ],
] as const;

const RETIRED_ATTORNEY_RULE_CATEGORY_BINDINGS = [
  [
    "Retired: Texas limits self-study to 3 hours overall; self-study ethics must be tagged as both Self-Study CLE and Legal Ethics and Professional Responsibility, without a separate 1-hour deduction.",
    "tx-attorney-active-2026-self-study-ethics",
  ],
] as const;

const RETIRE_ATTORNEY_CREDENTIAL_REQUIREMENT_SQL = `UPDATE credential_requirements
SET applicability_status = 'not_applicable', is_active = 0,
    condition_note = ?
WHERE rule_category_id = ?
  AND credential_id IN (
    SELECT credential.id
    FROM credentials credential
    WHERE credential.status = 'active'
  )`;

const DELETE_RETIRED_ATTORNEY_RULE_CATEGORY_SQL = `DELETE FROM rule_categories
WHERE id = ?`;

const ATTORNEY_CREDENTIAL_REQUIREMENT_SYNC_RULE_SET_IDS = [
  "ca-attorney-active-2026-v1",
  "tx-attorney-active-2026-v1",
  "ny-attorney-experienced-2026-v1",
] as const;

const BACKFILL_ATTORNEY_CREDENTIAL_REQUIREMENTS_SQL = `INSERT INTO credential_requirements (
  id, credential_id, rule_category_id, name, required_units, kind, relation,
  parent_requirement_id, applicability, applicability_status, condition_note,
  exclusive_group, is_active, sort_order
)
SELECT
  'catalog-sync:' || credential.id || ':' || category.id,
  credential.id,
  category.id,
  category.name,
  category.required_units,
  category.kind,
  category.relation,
  NULL,
  category.applicability,
  CASE
    WHEN category.applicability = 'conditional' THEN 'needs_confirmation'
    ELSE 'applies'
  END,
  category.condition_note,
  category.exclusive_group,
  CASE WHEN category.applicability = 'conditional' THEN 0 ELSE 1 END,
  category.sort_order
FROM credentials credential
JOIN rule_categories category
  ON category.rule_set_id = credential.rule_set_id
WHERE credential.rule_set_id IN (?, ?, ?)
  AND credential.status = 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM credential_requirements existing
    WHERE existing.credential_id = credential.id
      AND existing.rule_category_id = category.id
  )
ORDER BY credential.id, category.sort_order, category.id`;

const SYNC_ATTORNEY_CREDENTIAL_REQUIREMENTS_SQL = `UPDATE credential_requirements
SET
  name = (
    SELECT category.name
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  required_units = (
    SELECT category.required_units
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  kind = (
    SELECT category.kind
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  relation = (
    SELECT category.relation
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  parent_requirement_id = (
    SELECT parent_requirement.id
    FROM rule_categories category
    JOIN credential_requirements parent_requirement
      ON parent_requirement.credential_id =
        credential_requirements.credential_id
      AND parent_requirement.rule_category_id =
        category.parent_category_id
    WHERE category.id = credential_requirements.rule_category_id
  ),
  applicability = (
    SELECT category.applicability
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  condition_note = (
    SELECT category.condition_note
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  exclusive_group = (
    SELECT category.exclusive_group
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  sort_order = (
    SELECT category.sort_order
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  )
WHERE credential_id IN (
  SELECT credential.id
  FROM credentials credential
  WHERE credential.rule_set_id IN (?, ?, ?)
    AND credential.status = 'active'
)
  AND rule_category_id IN (
    SELECT category.id
    FROM rule_categories category
    WHERE category.rule_set_id IN (?, ?, ?)
  )
  AND EXISTS (
    SELECT 1
    FROM rule_categories category
    LEFT JOIN credential_requirements parent_requirement
      ON parent_requirement.credential_id =
        credential_requirements.credential_id
      AND parent_requirement.rule_category_id =
        category.parent_category_id
    WHERE category.id = credential_requirements.rule_category_id
      AND (
        credential_requirements.name IS NOT category.name
        OR credential_requirements.required_units IS NOT category.required_units
        OR credential_requirements.kind IS NOT category.kind
        OR credential_requirements.relation IS NOT category.relation
        OR credential_requirements.parent_requirement_id IS NOT
          parent_requirement.id
        OR credential_requirements.applicability IS NOT category.applicability
        OR credential_requirements.condition_note IS NOT category.condition_note
        OR credential_requirements.exclusive_group IS NOT category.exclusive_group
        OR credential_requirements.sort_order IS NOT category.sort_order
      )
  )`;

const BACKFILL_NJ_LCSW_CREDENTIAL_REQUIREMENTS_SQL = `INSERT INTO credential_requirements (
  id, credential_id, rule_category_id, name, required_units, kind, relation,
  parent_requirement_id, applicability, applicability_status, condition_note,
  exclusive_group, is_active, sort_order
)
SELECT
  'nj-lcsw-sync:' || credential.id || ':' || category.id,
  credential.id,
  category.id,
  category.name,
  category.required_units,
  category.kind,
  category.relation,
  NULL,
  category.applicability,
  CASE
    WHEN category.applicability = 'conditional' THEN 'needs_confirmation'
    ELSE 'applies'
  END,
  category.condition_note,
  category.exclusive_group,
  CASE WHEN category.applicability = 'conditional' THEN 0 ELSE 1 END,
  category.sort_order
FROM credentials credential
JOIN rule_categories category
  ON category.rule_set_id = credential.rule_set_id
WHERE credential.rule_set_id = ?
  AND credential.status = 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM credential_requirements existing
    WHERE existing.credential_id = credential.id
      AND existing.rule_category_id = category.id
  )
ORDER BY credential.id, category.sort_order, category.id`;

const SYNC_NJ_LCSW_CREDENTIAL_REQUIREMENTS_SQL = `UPDATE credential_requirements
SET
  name = (
    SELECT category.name
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  required_units = (
    SELECT category.required_units
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  kind = (
    SELECT category.kind
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  relation = (
    SELECT category.relation
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  parent_requirement_id = NULL,
  applicability = (
    SELECT category.applicability
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  condition_note = (
    SELECT category.condition_note
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  exclusive_group = (
    SELECT category.exclusive_group
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  sort_order = (
    SELECT category.sort_order
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  )
WHERE credential_id IN (
  SELECT credential.id
  FROM credentials credential
  WHERE credential.rule_set_id = ?
    AND credential.status = 'active'
)
  AND rule_category_id IN (
    SELECT category.id
    FROM rule_categories category
    WHERE category.rule_set_id = ?
  )
  AND EXISTS (
    SELECT 1
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
      AND (
        credential_requirements.name IS NOT category.name
        OR credential_requirements.required_units IS NOT category.required_units
        OR credential_requirements.kind IS NOT category.kind
        OR credential_requirements.relation IS NOT category.relation
        OR credential_requirements.parent_requirement_id IS NOT NULL
        OR credential_requirements.applicability IS NOT category.applicability
        OR credential_requirements.condition_note IS NOT category.condition_note
        OR credential_requirements.exclusive_group IS NOT category.exclusive_group
        OR credential_requirements.sort_order IS NOT category.sort_order
      )
  )`;

const BACKFILL_TEXAS_ETHICS_MATCHES_SQL = `INSERT OR IGNORE INTO activity_requirement_matches (
  id, user_id, allocation_id, requirement_id, matched_units
)
SELECT
  'catalog-sync-match:' || source_match.allocation_id || ':' ||
    target_requirement.id,
  source_match.user_id,
  source_match.allocation_id,
  target_requirement.id,
  source_match.matched_units
FROM activity_requirement_matches source_match
JOIN activity_allocations allocation
  ON allocation.id = source_match.allocation_id
JOIN activities activity
  ON activity.id = allocation.activity_id
JOIN credential_requirements source_requirement
  ON source_requirement.id = source_match.requirement_id
JOIN credentials credential
  ON credential.id = source_requirement.credential_id
JOIN credential_requirements target_requirement
  ON target_requirement.credential_id = credential.id
  AND target_requirement.is_active = 1
WHERE credential.rule_set_id = 'tx-attorney-active-2026-v1'
  AND credential.status = 'active'
  AND activity.archived_at IS NULL
  AND (
    (
      source_requirement.rule_category_id =
        'tx-attorney-active-2026-accredited-ethics'
      AND target_requirement.rule_category_id =
        'tx-attorney-active-2026-ethics'
    )
    OR (
      source_requirement.rule_category_id =
        'tx-attorney-active-2026-self-study-ethics'
      AND target_requirement.rule_category_id IN (
        'tx-attorney-active-2026-ethics',
        'tx-attorney-active-2026-self-study'
      )
    )
  )`;

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
      "fl-attorney-active-2026-v1",
      "fl-attorney-active",
      1,
      "Law",
      "Attorney — active",
      "Florida",
      "The Florida Bar",
      30,
      "CLE credit hours",
      36,
      "https://www-media.floridabar.org/uploads/2026/06/2026_12-JUNE-Chapter-6-RRTFB-1.pdf",
      "Rules Regulating The Florida Bar, Chapter 6 — Rule 6-10.3 (effective June 15, 2026); standard CLER baseline—confirm assigned reporting date, BSCR, exemptions, credit methods, and specialty/status duties",
      "2026-06-15",
      "2026-07-26",
      "source_linked_check_conditions",
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
      "nj-attorney-active-2026-v1",
      "nj-attorney-active",
      1,
      "Law",
      "Attorney — active",
      "New Jersey",
      "Supreme Court of New Jersey Board on Continuing Legal Education",
      24,
      "CLE credit hours",
      24,
      "https://www.njcourts.gov/notices/notice-and-order-continuing-legal-education-amendments-court-rule-r-142-1-and-cle",
      "N.J. Ct. R. 1:42-1 and BCLE Regulation 201:1; 2026 technology amendment and cycle/live conditions apply—confirm cycle group, deadline, admission, waivers, exemptions, carryover, status, and format",
      "2021-01-01",
      "2026-07-26",
      "source_linked_check_conditions",
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
      "pa-attorney-active-2026-v1",
      "pa-attorney-active",
      1,
      "Law",
      "Attorney — active",
      "Pennsylvania",
      "Pennsylvania Continuing Legal Education Board",
      12,
      "CLE credit hours",
      12,
      "https://www.pacle.org/rules-and-regulations",
      "Pennsylvania CLE Board Rules and Regulations — annual ethics and delivery requirements; confirm compliance group, deadline, carryover, exemptions, admission/status, and delivery limits",
      "2014-01-30",
      "2026-07-26",
      "source_linked_check_conditions",
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
      "CLE credit hours",
      24,
      "https://www.nycourts.gov/LegacyPDFS/attorneys/cle/17b-Rules-1500-22a-Cybersecurity-Experienced-Attorney-Requirement.pdf",
      "22 NYCRR 1500.22(a) — Experienced Attorney Minimum Requirements (revised effective July 1, 2023); split General/Ethics cybersecurity hours into separate non-overlapping activity entries and confirm the assigned reporting cycle and deadline, partial-practice proration, cybersecurity overlap, admission cohort, newly admitted/transitional rules, exemptions, carryover, and format",
      "2023-07-01",
      "2026-07-26",
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
      "Ethics and Professionalism",
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
      "Diversity, Inclusion and Elimination of Bias",
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
      "Cybersecurity, Privacy and Data Protection",
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
    sql: `INSERT OR IGNORE INTO rule_sets (
      id, stable_key, version, profession, credential_name, jurisdiction,
      issuer, total_units, unit_label, cycle_months, source_url, source_title,
      effective_date, last_verified_at, review_status, is_current
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindings: [
      "ca-rn-2026-v1",
      "ca-rn",
      1,
      "Nursing",
      "Registered Nurse",
      "California",
      "California Board of Registered Nursing",
      30,
      "contact hours",
      24,
      "https://www.rn.ca.gov/licensees/ce-renewal.shtml",
      "California BRN CE renewal requirements; first-renewal exemption, implicit-bias, and NP conditions must be checked",
      null,
      "2026-07-25",
      "source_linked_check_conditions",
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
      "tx-rn-2026-v1",
      "tx-rn",
      1,
      "Nursing",
      "Registered Nurse",
      "Texas",
      "Texas Board of Nursing",
      20,
      "CNE contact hours",
      24,
      "https://www.bon.texas.gov/education_continuing_education.asp",
      "Texas BON continuing competency requirements; certification alternative and role-, topic-, and cycle-specific requirements must be checked",
      null,
      "2026-07-25",
      "source_linked_check_conditions",
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
      "fl-rn-2026-v1",
      "fl-rn",
      1,
      "Nursing",
      "Registered Nurse",
      "Florida",
      "Florida Board of Nursing",
      24,
      "CE hours",
      24,
      "https://floridasnursing.gov/registered-nurse-renewal/",
      "Florida RN renewal requirements; first-renewal, rotating, additional, and exemption conditions must be checked",
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
      "fl-rn-2026-medical-errors",
      "fl-rn-2026-v1",
      "Prevention of Medical Errors",
      2,
      0,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      "fl-rn-2026-laws-rules",
      "fl-rn-2026-v1",
      "Florida Laws and Rules",
      2,
      1,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      "fl-rn-2026-human-trafficking",
      "fl-rn-2026-v1",
      "Human Trafficking",
      2,
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
      "ca-attorney-active-2026-v1",
      "ca-attorney-active",
      1,
      "Law",
      "Attorney — active",
      "California",
      "State Bar of California",
      25,
      "MCLE credit hours",
      36,
      "https://www.calbar.ca.gov/legal-professionals/maintaining-compliance/mcle/mcle-requirements",
      "MCLE Requirements | The State Bar of California; standard full-cycle active-licensee baseline—same instructional time may count in only one substantive MCLE subfield, so split multi-subfield courses into separate activity entries by non-overlapping hours; confirm compliance group, transitional cycle, proration, exemptions, and separate new-attorney/specialist duties",
      "2024-01-01",
      "2026-07-26",
      "source_linked_check_conditions",
      1,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      "ca-attorney-active-2026-legal-ethics",
      "ca-attorney-active-2026-v1",
      "Legal Ethics",
      4,
      0,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      "ca-attorney-active-2026-elimination-bias",
      "ca-attorney-active-2026-v1",
      "Elimination of Bias",
      2,
      1,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      "ca-attorney-active-2026-competence",
      "ca-attorney-active-2026-v1",
      "Competence",
      2,
      2,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      "ca-attorney-active-2026-technology",
      "ca-attorney-active-2026-v1",
      "Technology",
      1,
      3,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      "ca-attorney-active-2026-civility",
      "ca-attorney-active-2026-v1",
      "Civility",
      1,
      4,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_sets (
      id, stable_key, version, profession, credential_name, jurisdiction,
      issuer, total_units, unit_label, cycle_months, source_url, source_title,
      effective_date, last_verified_at, review_status, is_current
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bindings: [
      "tx-attorney-active-2026-v1",
      "tx-attorney-active",
      1,
      "Law",
      "Attorney — active",
      "Texas",
      "State Bar of Texas",
      15,
      "CLE credit hours",
      12,
      "https://www.texasbar.com/AM/Template.cfm?ContentID=71381&Section=MCLE_Rules1&Template=%2FCM%2FContentDisplay.cfm",
      "Texas MCLE Regulations (effective April 24, 2026); standard annual active-member baseline—accredited ethics must be allocated as Accredited Ethics plus Legal Ethics, while self-study ethics must be allocated as Self-Study CLE plus Legal Ethics; confirm birth-month dates, the separate initial 24-month cycle, grace period, carryover, exemptions, and specialty duties",
      "2026-04-24",
      "2026-07-26",
      "source_linked_check_conditions",
      1,
    ],
  },
  {
    sql: `INSERT OR IGNORE INTO rule_categories
      (id, rule_set_id, name, required_units, sort_order)
      VALUES (?, ?, ?, ?, ?)`,
    bindings: [
      "tx-attorney-active-2026-ethics",
      "tx-attorney-active-2026-v1",
      "Legal Ethics and Professional Responsibility",
      3,
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
      "ca-cpa-2026-v1",
      "ca-cpa",
      1,
      "Accounting",
      "Certified Public Accountant",
      "California",
      "California Board of Accountancy",
      80,
      "CE hours",
      24,
      "https://www.dca.ca.gov/cba/licensees/cequickref.shtml",
      "California CBA CE Quick Reference Guide; technical overlap, annual floors, service-specific categories, and proration must be checked",
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
      "ca-cpa-2026-ethics",
      "ca-cpa-2026-v1",
      "Ethics",
      4,
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
      "nj-cpa-2026-v1",
      "nj-cpa",
      1,
      "Accounting",
      "Certified Public Accountant",
      "New Jersey",
      "New Jersey State Board of Accountancy",
      120,
      "CPE credits",
      36,
      "https://www.njconsumeraffairs.gov/acc/Pages/FAQ.aspx",
      "New Jersey Board of Accountancy CE FAQ; technical overlap, annual floor, public-accountancy, and first-renewal conditions must be checked",
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
      "nj-cpa-2026-law-ethics",
      "nj-cpa-2026-v1",
      "New Jersey Law and Ethics",
      4,
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
      "pmi-pmp-2026-v1",
      "pmi-pmp",
      1,
      "Project Management",
      "Project Management Professional (PMP)",
      "Global",
      "Project Management Institute",
      60,
      "PDUs",
      36,
      "https://www.pmi.org/-/media/pmi/documents/public/pdf/certifications/ccr-certification-requirements-handbook.pdf",
      "PMI CCR Handbook, April 2026; up to 20 excess PDUs earned in the final 12 months may carry to the next cycle, except Working as a Professional",
      null,
      "2026-07-25",
      "verified",
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
      "ca-physician-md-2026-v1",
      "ca-physician-md",
      1,
      "Medicine",
      "Physician and Surgeon (MD)",
      "California",
      "Medical Board of California",
      50,
      "approved CME hours",
      24,
      "https://www.mbc.ca.gov/Licensing/Physicians-and-Surgeons/Renew/Current-Status/Continuing-Medical-Education.aspx",
      "Medical Board of California CME; confirm the one-time pain/end-of-life requirement, specialty credit rules, and any waiver or make-up cycle",
      null,
      "2026-07-25",
      "source_linked_check_conditions",
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
      "tx-physician-2026-v1",
      "tx-physician",
      1,
      "Medicine",
      "Physician — standard renewal",
      "Texas",
      "Texas Medical Board",
      48,
      "CME credits",
      24,
      "https://www.tmb.texas.gov/index.php/apply-renew/physician/continuing-education-requirements-for-physicians",
      "Texas Medical Board CME; first registration, cadence-specific courses, specialty duties, CE Broker transition, and carryover require individual review",
      null,
      "2026-07-25",
      "source_linked_check_conditions",
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
      "fl-medical-doctor-md-2026-v1",
      "fl-medical-doctor-md",
      1,
      "Medicine",
      "Medical Doctor (MD) — standard renewal",
      "Florida",
      "Florida Board of Medicine",
      40,
      "CME hours",
      24,
      "https://flboardofmedicine.gov/medical-doctor-renewal/",
      "Florida Board of Medicine MD renewal; first renewal is materially different, no hours carry over, and osteopathic physicians use a separate board",
      null,
      "2026-07-25",
      "source_linked_check_conditions",
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
      "nj-physician-2026-v1",
      "nj-physician",
      1,
      "Medicine",
      "Physician (MD/DO) — standard renewal",
      "New Jersey",
      "New Jersey State Board of Medical Examiners",
      100,
      "CME credits",
      24,
      "https://www.njconsumeraffairs.gov/Adoptions/bmeado_05052025.pdf",
      "Adopted N.J.A.C. 13:35-6.15 CME rules; initial-period, cultural-competency, office-anesthesia, and carryover conditions require individual review",
      "2025-07-01",
      "2026-07-25",
      "source_linked_check_conditions",
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
      "pa-medical-physician-md-2026-v1",
      "pa-medical-physician-md",
      1,
      "Medicine",
      "Medical Physician and Surgeon (MD) — standard renewal",
      "Pennsylvania",
      "Pennsylvania State Board of Medicine",
      100,
      "CME credit hours",
      24,
      "https://www.pacodeandbulletin.gov/Display/pacode?file=%2Fsecure%2Fpacode%2Fdata%2F049%2Fchapter16%2Fs16.19.html",
      "49 Pa. Code § 16.19; first renewal, the one-time organ-donation course, exemptions, and reactivation rules require individual review",
      null,
      "2026-07-25",
      "source_linked_check_conditions",
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

const CATALOG_2026_RULE_SET_INSERT_SQL = `INSERT INTO rule_sets (
  id, stable_key, version, profession, credential_name, jurisdiction, issuer,
  total_units, unit_label, cycle_months, source_url, source_title,
  effective_date, last_verified_at, review_status, is_current
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  stable_key = excluded.stable_key,
  version = excluded.version,
  profession = excluded.profession,
  credential_name = excluded.credential_name,
  jurisdiction = excluded.jurisdiction,
  issuer = excluded.issuer,
  total_units = excluded.total_units,
  unit_label = excluded.unit_label,
  cycle_months = excluded.cycle_months,
  source_url = excluded.source_url,
  source_title = excluded.source_title,
  effective_date = excluded.effective_date,
  last_verified_at = excluded.last_verified_at,
  review_status = excluded.review_status,
  is_current = excluded.is_current`;

const CATALOG_2026_RULE_SET_SEED_BINDINGS = [
  [
    "cisco-ccna-2026-v1",
    "cisco-ccna-ce",
    1,
    "Information Technology",
    "Cisco Certified Network Associate (CCNA) — Continuing Education path",
    "Global",
    "Cisco",
    30,
    "CE credits",
    36,
    "https://www.cisco.com/site/us/en/learn/training-certifications/certifications/recertification/index.html",
    "Cisco recertification policy; this template covers the 30-credit Continuing Education route only. Exams and qualifying higher certifications are alternative routes. Use Cisco's actual certification dates because a qualifying activity starts a new three-year period, and submit manual CE claims within Cisco's deadline.",
    null,
    "2026-07-26",
    "verified",
    1,
  ],
  [
    "arrt-rt-standard-2026-v1",
    "arrt-rt-standard",
    1,
    "Radiologic Technology",
    "Registered Technologist (R.T.) — standard non-Sonography CE",
    "United States",
    "American Registry of Radiologic Technologists",
    24,
    "Category A or A+ credits",
    24,
    "https://www.arrt.org/pages/resources/maintaining-credentials/continuing-education",
    "ARRT biennial CE guidance; use the assigned biennium dates. This template excludes Sonography, R.R.A., and Imaging Assistant pathways. Annual renewal, CQR, state licensing, and federal requirements are separate, and excess CE does not carry forward.",
    null,
    "2026-07-26",
    "source_linked_check_conditions",
    1,
  ],
  [
    "cfp-professional-pre-2027-v1",
    "cfp-professional-pre-2027",
    1,
    "Financial Planning",
    "CFP® Professional — cycle beginning before April 1, 2027",
    "United States",
    "CFP Board",
    30,
    "CE hours",
    24,
    "https://www.cfp.net/for-cfp-pros/continuing-education/continuing-education-requirements",
    "CFP Board's 30-hour standard applies to certification periods beginning before April 1, 2027. The first full two-year cycles beginning after Q1 2027 use the 40-hour standard. No hours carry into this 30-hour cycle. For a later eligible cycle, only CFP Board-confirmed excess general CE may carry from the immediately preceding cycle, up to 10 hours; Ethics CE never carries. Confirm the assigned cycle dates and any carryover in the CFP Board account. Initial-cycle proration and annual certification steps are separate.",
    null,
    "2026-07-26",
    "transition_rule_check_assigned_cycle",
    1,
  ],
  [
    "cfp-professional-2027-v1",
    "cfp-professional-2027",
    1,
    "Financial Planning",
    "CFP® Professional — cycle beginning April 1, 2027 or later",
    "United States",
    "CFP Board",
    40,
    "CE hours",
    24,
    "https://www.cfp.net/for-cfp-pros/continuing-education/continuing-education-requirements",
    "CFP Board's 40-hour standard applies to the first full two-year certification period beginning after Q1 2027, implemented here as a cycle start on or after April 1, 2027: 38 general hours and 2 Ethics CE hours. No more than 5 of the general hours may be Practice Management. Up to 10 excess general CE hours from the immediately preceding cycle may carry only when CFP Board confirms them; Ethics CE cannot carry. License Lantern never copies prior-cycle credit automatically, so confirm the assigned cycle and eligible amount in the CFP Board account before manually recording carryover with supporting evidence.",
    "2027-04-01",
    "2026-07-26",
    "source_linked_check_conditions",
    0,
  ],
  [
    "tx-real-estate-2026-v1",
    "tx-real-estate-standard-ce",
    1,
    "Real Estate",
    "Sales Agent or Broker — standard active CE renewal",
    "Texas",
    "Texas Real Estate Commission",
    18,
    "CE hours",
    24,
    "https://www.trec.texas.gov/agency-information/rules-and-laws/trec-rules",
    "TREC Rule §535.92; use the license's assigned dates. This standard CE template excludes a sales agent's first renewal under SAE, inactive renewal, and exemptions. Broker Responsibility is conditional; beginning in 2026 it applies to all brokers and also applies to delegated supervisors.",
    "2026-01-01",
    "2026-07-26",
    "source_linked_check_conditions",
    1,
  ],
  [
    "ny-architect-2026-v1",
    "ny-architect",
    1,
    "Architecture",
    "Registered Architect — full registration period",
    "New York",
    "New York State Education Department",
    36,
    "contact hours",
    36,
    "https://www.op.nysed.gov/professions/architecture/continuing-education",
    "NYSED architecture continuing-education guidance for a full three-year registration period. Short or adjusted periods are prorated, and up to six eligible prior-period hours may carry over; those cases need manual review because this template does not apply carryover automatically.",
    null,
    "2026-07-26",
    "source_linked_check_conditions",
    1,
  ],
  [
    "ptcb-cpht-2026-v1",
    "ptcb-cpht",
    1,
    "Pharmacy Technology",
    "Certified Pharmacy Technician (CPhT) — standard renewal",
    "United States",
    "Pharmacy Technician Certification Board",
    20,
    "CE hours",
    24,
    "https://ptcb.zendesk.com/hc/en-us/articles/37186583427469-Recertification-Policy",
    "PTCB Recertification Policy v3.5 for ordinary CPhT renewal; use the credential's actual approximately two-year cycle dates. This excludes reinstatement, CPhT-Adv, CSPT, and CPTEd. No CE carries over. Law and patient-safety hours overlap the total and may also be technician-specific; BLS/CPR/AED hours never satisfy patient safety.",
    "2026-05-01",
    "2026-07-26",
    "source_linked_check_conditions",
    1,
  ],
  [
    "asha-ccc-2026-v1",
    "asha-ccc",
    1,
    "Audiology and Speech-Language Pathology",
    "Certificate of Clinical Competence (CCC-A / CCC-SLP)",
    "United States",
    "American Speech-Language-Hearing Association",
    30,
    "PDHs",
    36,
    "https://www.asha.org/certification/maintain-ccc/",
    "ASHA certification maintenance for an assigned three-calendar-year interval. A dual CCC-A/CCC-SLP holder completes one 30-PDH requirement. The 2026 Content Area 2 wording replaces, rather than adds to, the former two-hour bucket. Split a dual-topic course into separate activity entries by non-overlapping hours; the same time block cannot satisfy both content buckets.",
    "2026-01-01",
    "2026-07-26",
    "source_linked_check_conditions",
    1,
  ],
  [
    "nasm-cpt-2026-v1",
    "nasm-cpt",
    1,
    "Fitness and Personal Training",
    "NASM Certified Personal Trainer (NASM-CPT) — standard recertification",
    "United States",
    "National Academy of Sports Medicine",
    2,
    "NASM CEUs",
    24,
    "https://www.nasm.org/certified-personal-trainer-renewal",
    "NASM-CPT recertification guidance and handbook; use the expiration date printed on the certificate. Complete 2.0 CEUs, including 0.1 CEU for current adult CPR/AED, and do not carry CEUs into another cycle or reuse the same course in a later credential window. Record non-preapproved education only after NASM approves its petition. NASM expressly accepts its own ASTI online CPR/AED course; confirm acceptance before counting a different third-party online-only course because NASM's official materials conflict.",
    null,
    "2026-07-26",
    "source_linked_check_conditions",
    1,
  ],
  [
    "hrci-phr-2026-v1",
    "hrci-phr",
    1,
    "Human Resources",
    "Professional in Human Resources (PHR) — standard full-cycle recertification credit path",
    "United States",
    "HRCI",
    60,
    "recertification credits",
    36,
    "https://www.hrci.org/docs/default-source/pdf-documents/recertification-handbook.pdf",
    "HRCI Recertification Handbook. This template models the standard full-cycle credit path: 60 HR-related credits tied to the PHR exam content outline over 36 months, including at least one ethics-themed activity. Initial cycles can be longer, later-added credentials can be synchronized, and the requirements displayed in the HRCI portal control; retaking the exam is an alternative. Self-directed learning is capped at 30 credits; audited college courses are instructor-led professional development capped at 10 credits. Professional achievement is capped at 40 credits in aggregate, including no more than 12 for HR membership. Record carryover only after HRCI posts eligible General HR credit; no more than 15 surplus credits earned in the final 12 months may carry, and membership credit does not carry.",
    "2021-01-01",
    "2026-07-26",
    "source_linked_check_conditions",
    1,
  ],
  [
    "hrci-sphr-2026-v1",
    "hrci-sphr",
    1,
    "Human Resources",
    "Senior Professional in Human Resources (SPHR) — standard full-cycle recertification credit path",
    "United States",
    "HRCI",
    60,
    "recertification credits",
    36,
    "https://www.hrci.org/docs/default-source/pdf-documents/recertification-handbook.pdf",
    "HRCI Recertification Handbook. This template models the standard full-cycle credit path: 60 HR-related credits tied to the SPHR exam content outline over 36 months, including 15 Business credits and at least one ethics-themed activity. Initial cycles can be longer, later-added credentials can be synchronized, specified-credit minimums can be prorated, and the requirements displayed in the HRCI portal control; retaking the exam is an alternative. Self-directed learning is capped at 30 credits; audited college courses are instructor-led professional development capped at 10 credits. Professional achievement is capped at 40 credits in aggregate, including no more than 12 for HR membership. Record carryover only after HRCI posts eligible General HR credit; no more than 15 surplus credits earned in the final 12 months may carry, and membership credit does not carry.",
    "2021-01-01",
    "2026-07-26",
    "source_linked_check_conditions",
    1,
  ],
  [
    "shrm-cp-2026-v1",
    "shrm-cp",
    1,
    "Human Resources",
    "SHRM Certified Professional (SHRM-CP) — PDC recertification path",
    "Global",
    "Society for Human Resource Management",
    60,
    "PDCs",
    36,
    "https://www.shrm.org/content/dam/en/shrm/credentials/shrm-certification/shrm_recertification_handbook.pdf",
    "SHRM Recertification Handbook and qualifying-activities guidance; use the cycle dates and accepted values shown in the SHRM portal. Earn 60 PDCs, with no more than 30 for Advance Your Organization and 30 for Advance Your Profession. SHRM has no general ethics or inclusion minimum. Current official materials conflict: the handbook lists 10 SHRM membership PDCs per year while current web guidance lists 3, and they disagree on whether all excess or only Education PDCs may carry. License Lantern does not auto-award membership or carryover; manually record only values accepted or posted by SHRM, with portal-confirmed carryover capped at 20 PDCs.",
    null,
    "2026-07-26",
    "source_linked_check_conditions",
    1,
  ],
  [
    "shrm-scp-2026-v1",
    "shrm-scp",
    1,
    "Human Resources",
    "SHRM Senior Certified Professional (SHRM-SCP) — PDC recertification path",
    "Global",
    "Society for Human Resource Management",
    60,
    "PDCs",
    36,
    "https://www.shrm.org/content/dam/en/shrm/credentials/shrm-certification/shrm_recertification_handbook.pdf",
    "SHRM Recertification Handbook and qualifying-activities guidance; use the cycle dates and accepted values shown in the SHRM portal. Earn 60 PDCs, with no more than 30 for Advance Your Organization and 30 for Advance Your Profession. SHRM has no general ethics or inclusion minimum. Current official materials conflict: the handbook lists 10 SHRM membership PDCs per year while current web guidance lists 3, and they disagree on whether all excess or only Education PDCs may carry. License Lantern does not auto-award membership or carryover; manually record only values accepted or posted by SHRM, with portal-confirmed carryover capped at 20 PDCs.",
    null,
    "2026-07-26",
    "source_linked_check_conditions",
    1,
  ],
  ...ISC2_RULE_SET_SEED_BINDINGS,
  ...COMPTIA_RULE_SET_SEED_BINDINGS,
  ...INSURANCE_RULE_SET_SEED_BINDINGS,
  ...NREMT_RULE_SET_SEED_BINDINGS,
  ...EDUCATION_RULE_SET_SEED_BINDINGS,
  ...MENTAL_HEALTH_RULE_SET_SEED_BINDINGS,
  ...PHARMACY_RULE_SET_SEED_BINDINGS,
  ...NURSING_RULE_SET_SEED_BINDINGS,
] as const;

const CATALOG_2026_CATEGORY_INSERT_SQL = `INSERT INTO rule_categories (
  id, rule_set_id, name, required_units, kind, relation, parent_category_id,
  applicability, condition_note, exclusive_group, sort_order
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  rule_set_id = excluded.rule_set_id,
  name = excluded.name,
  required_units = excluded.required_units,
  kind = excluded.kind,
  relation = excluded.relation,
  parent_category_id = excluded.parent_category_id,
  applicability = excluded.applicability,
  condition_note = excluded.condition_note,
  exclusive_group = excluded.exclusive_group,
  sort_order = excluded.sort_order`;

const CATALOG_2026_CATEGORY_SEED_BINDINGS = [
  [
    "arrt-rt-standard-2026-applications-training",
    "arrt-rt-standard-2026-v1",
    "Facility-Delivered Applications Training",
    8,
    "maximum",
    "independent",
    null,
    "optional",
    "At most 8 Category A credits from facility-delivered applications training may count in one biennium.",
    "ARRT capped activity type",
    0,
  ],
  [
    "arrt-rt-standard-2026-advanced-life-support",
    "arrt-rt-standard-2026-v1",
    "Advanced-Level Life-Support Certification",
    6,
    "maximum",
    "independent",
    null,
    "optional",
    "At most 6 credits may count for an eligible advanced-level life-support certification, usable once per biennium.",
    "ARRT capped activity type",
    1,
  ],
  [
    "arrt-rt-standard-2026-other-eligible-ce",
    "arrt-rt-standard-2026-v1",
    "Other Eligible Category A or A+ CE",
    0,
    "informational",
    "independent",
    null,
    "optional",
    "Use this activity-type classifier for eligible Category A or A+ credit that is neither facility-delivered applications training nor an advanced-level life-support certification. These credits remain subject only to the overall biennial total.",
    "ARRT capped activity type",
    2,
  ],
  [
    "cfp-professional-pre-2027-general",
    "cfp-professional-pre-2027-v1",
    "General CE",
    28,
    "minimum",
    "independent",
    null,
    "always",
    "Twenty-eight general hours plus two CFP Board-approved Ethics CE hours make up the 30-hour requirement for a cycle beginning before April 1, 2027.",
    "CFP CE type",
    0,
  ],
  [
    "cfp-professional-pre-2027-ethics",
    "cfp-professional-pre-2027-v1",
    "CFP Board-Approved Ethics CE",
    2,
    "minimum",
    "independent",
    null,
    "always",
    "Complete the current two-hour CFP Board-approved Ethics CE program; these hours are separate from the 28 general hours and cannot carry to another cycle.",
    "CFP CE type",
    1,
  ],
  [
    "cfp-professional-2027-general",
    "cfp-professional-2027-v1",
    "General CE",
    38,
    "minimum",
    "independent",
    null,
    "always",
    "Complete 38 general CE hours. Classify every general activity under the Principal Topics or Practice Management child category rather than tagging this parent directly. License Lantern does not copy prior-cycle credit; manually record only CFP Board-confirmed eligible carryover and retain the confirmation.",
    null,
    0,
  ],
  [
    "cfp-professional-2027-principal-topics",
    "cfp-professional-2027-v1",
    "General CE — Principal Topics Other Than Practice Management",
    33,
    "minimum",
    "nested",
    "cfp-professional-2027-general",
    "always",
    "At least 33 of the 38 general CE hours must cover CFP Board Principal Topics other than Practice Management. This derived floor enforces the five-hour Practice Management cap; tag each non-Practice-Management general activity here.",
    "CFP CE activity type",
    1,
  ],
  [
    "cfp-professional-2027-practice-management",
    "cfp-professional-2027-v1",
    "Practice Management General CE",
    5,
    "maximum",
    "nested",
    "cfp-professional-2027-general",
    "optional",
    "No more than 5 of the 38 general CE hours may focus on Practice Management. Tag every Practice Management activity here so excess hours cannot count toward the 40-hour total.",
    "CFP CE activity type",
    2,
  ],
  [
    "cfp-professional-2027-ethics",
    "cfp-professional-2027-v1",
    "CFP Board-Approved Ethics CE",
    2,
    "minimum",
    "independent",
    null,
    "always",
    "Complete the current two-hour CFP Board-approved Ethics CE program. Ethics CE is separate from the 38 general hours and cannot carry over from another certification period.",
    "CFP CE activity type",
    3,
  ],
  [
    "tx-real-estate-2026-legal-i",
    "tx-real-estate-2026-v1",
    "Legal Update I",
    4,
    "minimum",
    "independent",
    null,
    "always",
    "Four hours in the current TREC Legal Update I course.",
    "TREC course type",
    0,
  ],
  [
    "tx-real-estate-2026-legal-ii",
    "tx-real-estate-2026-v1",
    "Legal Update II",
    4,
    "minimum",
    "independent",
    null,
    "always",
    "Four hours in the current TREC Legal Update II course.",
    "TREC course type",
    1,
  ],
  [
    "tx-real-estate-2026-contracts",
    "tx-real-estate-2026-v1",
    "Real Estate Contracts",
    3,
    "minimum",
    "independent",
    null,
    "always",
    "Three hours in real estate contracts from a TREC-approved provider.",
    "TREC course type",
    2,
  ],
  [
    "tx-real-estate-2026-broker-responsibility",
    "tx-real-estate-2026-v1",
    "Broker Responsibility",
    6,
    "minimum",
    "independent",
    null,
    "conditional",
    "Applies to brokers and delegated supervisors. Beginning in 2026, TREC requires this six-hour course for all brokers; confirm the holder's role and assigned renewal cycle.",
    "TREC course type",
    3,
  ],
  [
    "ny-architect-2026-hsw",
    "ny-architect-2026-v1",
    "Health, Safety, and Welfare",
    24,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least 24 of the 36 contact hours in a full registration period must address health, safety, and welfare subjects.",
    null,
    0,
  ],
  [
    "nj-physician-2026-non-volunteer-credit",
    "nj-physician-2026-v1",
    "Non-Volunteer CME Credit",
    0,
    "informational",
    "independent",
    null,
    "optional",
    "Use this credit-source classifier for eligible CME that is not claimed from qualifying volunteer medical care. Select any applicable Category I or subject tags separately.",
    "New Jersey physician credit source",
    6,
  ],
  [
    "ptcb-cpht-2026-technician-specific",
    "ptcb-cpht-2026-v1",
    "Technician-Specific CE",
    15,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least 15 of the 20 counted hours must be technician-specific or otherwise accepted by PTCB for the PTCE Content Outline.",
    "PTCB provider audience",
    0,
  ],
  [
    "ptcb-cpht-2026-pharmacist-specific",
    "ptcb-cpht-2026-v1",
    "Pharmacist-Specific CE",
    5,
    "informational",
    "overlapping",
    null,
    "optional",
    "Classification tag for accepted pharmacist-specific CE. The separate 15-hour Technician-Specific CE minimum safely limits pharmacist-specific credit to no more than 5 of the 20 counted hours, so no second maximum deduction is applied.",
    "PTCB provider audience",
    1,
  ],
  [
    "ptcb-cpht-2026-pharmacy-law",
    "ptcb-cpht-2026-v1",
    "Pharmacy Law",
    1,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least one hour must address pharmacy law. It remains inside the 20-hour total and may also be technician-specific.",
    null,
    2,
  ],
  [
    "ptcb-cpht-2026-patient-safety",
    "ptcb-cpht-2026-v1",
    "Patient Safety",
    1,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least one hour must address patient safety. It remains inside the 20-hour total and may also be technician-specific; BLS, CPR, and AED hours do not satisfy this topic.",
    null,
    3,
  ],
  [
    "ptcb-cpht-2026-college-coursework",
    "ptcb-cpht-2026-v1",
    "Relevant College Coursework",
    10,
    "maximum",
    "independent",
    null,
    "optional",
    "At most 10 CE hours may count from qualifying relevant coursework completed during the cycle at a regionally accredited institution with at least three academic credits and a grade of C or better.",
    "PTCB capped activity type",
    4,
  ],
  [
    "ptcb-cpht-2026-bls-cpr-aed",
    "ptcb-cpht-2026-v1",
    "Eligible BLS, CPR, or AED Training",
    2,
    "maximum",
    "independent",
    null,
    "optional",
    "At most 2 hours may count for eligible American Heart Association or American Red Cross BLS, CPR, or AED training; these hours cannot satisfy Patient Safety.",
    "PTCB capped activity type",
    5,
  ],
  [
    "ptcb-cpht-2026-other-eligible-activity",
    "ptcb-cpht-2026-v1",
    "Other Eligible PTCB CE Activity",
    0,
    "informational",
    "independent",
    null,
    "optional",
    "Use this activity-type classifier for eligible PTCB CE that is neither relevant college coursework nor BLS, CPR, or AED training. Select technician/pharmacist audience and law or patient-safety tags separately when applicable.",
    "PTCB capped activity type",
    6,
  ],
  [
    "asha-ccc-2026-ethics",
    "asha-ccc-2026-v1",
    "Ethics",
    1,
    "minimum",
    "independent",
    null,
    "always",
    "Complete at least one PDH in ethics. When one course addresses both required content areas, split its non-overlapping hours into separate activity entries.",
    "ASHA required content allocation",
    0,
  ],
  [
    "asha-ccc-2026-content-area-2",
    "asha-ccc-2026-v1",
    "Content Area 2 — Responsive Service and Professional Interactions",
    2,
    "minimum",
    "independent",
    null,
    "always",
    "Complete at least two PDHs in any mix of service responsive to unique histories, values, and circumstances, and/or self-reflection, adaptability, or collaboration in professional and care-related interactions.",
    "ASHA required content allocation",
    1,
  ],
  [
    "nasm-cpt-2026-non-cpr-recertification",
    "nasm-cpt-2026-v1",
    "Non-CPR Recertification CEUs",
    1.9,
    "maximum",
    "independent",
    null,
    "optional",
    "No more than 1.9 of the 2.0 required CEUs may come from non-CPR recertification activity. Classify each activity under Category A, B, or C so its CEUs roll up to this aggregate cap once.",
    null,
    0,
  ],
  [
    "nasm-cpt-2026-category-a",
    "nasm-cpt-2026-v1",
    "Category A — NASM/AFAA Approved Provider Education",
    0,
    "informational",
    "nested",
    "nasm-cpt-2026-non-cpr-recertification",
    "optional",
    "NASM lists a 1.9 CEU maximum for Category A, enforced here through the shared 1.9 Non-CPR aggregate. Use this classifier for CEUs awarded through a NASM/AFAA approved provider, record only the value printed on the completion certificate, and follow the NASM portal for education completed during its 90-day grace period.",
    "NASM CEU activity type",
    1,
  ],
  [
    "nasm-cpt-2026-category-b",
    "nasm-cpt-2026-v1",
    "Category B — Industry Contributions",
    0,
    "informational",
    "nested",
    "nasm-cpt-2026-non-cpr-recertification",
    "optional",
    "NASM lists a 1.9 CEU maximum for Category B, enforced here through the shared 1.9 Non-CPR aggregate. Use this classifier for NASM-accepted industry contributions. A petitioned activity contributes zero until NASM approves it, so retain the approval with the activity evidence.",
    "NASM CEU activity type",
    2,
  ],
  [
    "nasm-cpt-2026-category-c",
    "nasm-cpt-2026-v1",
    "Category C — Collegiate Coursework",
    0,
    "informational",
    "nested",
    "nasm-cpt-2026-non-cpr-recertification",
    "optional",
    "NASM lists a 1.9 CEU maximum for Category C, enforced here through the shared 1.9 Non-CPR aggregate. Use this classifier for NASM-accepted collegiate coursework. Record the NASM-awarded CEU value rather than deriving CEUs locally from academic credits or contact hours.",
    "NASM CEU activity type",
    3,
  ],
  [
    "nasm-cpt-2026-category-d-cpr-aed",
    "nasm-cpt-2026-v1",
    "Category D — Adult CPR/AED",
    0.1,
    "maximum",
    "independent",
    null,
    "optional",
    "Exactly 0.1 of the 2.0 CEUs may count from current adult CPR and AED certification. Select the overlapping Current Adult CPR/AED requirement for the same record.",
    "NASM CEU activity type",
    4,
  ],
  [
    "nasm-cpt-2026-current-adult-cpr-aed",
    "nasm-cpt-2026-v1",
    "Current Adult CPR/AED",
    0.1,
    "minimum",
    "overlapping",
    null,
    "always",
    "Maintain current adult CPR and AED certification worth 0.1 NASM CEU. NASM expressly accepts its own ASTI online course; confirm acceptance before counting a different third-party online-only course because NASM's official materials conflict.",
    null,
    5,
  ],
  [
    "hrci-phr-2026-professional-development",
    "hrci-phr-2026-v1",
    "Professional Development — Preapproved or Instructor-Led",
    0,
    "informational",
    "independent",
    null,
    "optional",
    "Use this classifier for eligible preapproved or instructor-led professional development that is not self-directed learning or portal-confirmed carryover. This category has no separate cap.",
    "HRCI activity type",
    0,
  ],
  [
    "hrci-phr-2026-confirmed-carryover",
    "hrci-phr-2026-v1",
    "HRCI-Confirmed Carryover",
    15,
    "maximum",
    "independent",
    null,
    "conditional",
    "Record only General HR credits HRCI posts to the new cycle. At most 15 surplus credits earned in the final 12 months may carry, and HR membership credit is ineligible.",
    "HRCI activity type",
    1,
  ],
  [
    "hrci-phr-2026-self-directed-learning",
    "hrci-phr-2026-v1",
    "Self-Directed Learning",
    30,
    "maximum",
    "independent",
    null,
    "optional",
    "No more than 30 self-directed learning credits may count toward the 60-credit recertification total. Use this aggregate for eligible preapproved books, book discussions, and mentee coaching; audited college courses are instructor-led professional development and do not roll up here.",
    null,
    2,
  ],
  [
    "hrci-phr-2026-other-self-directed-learning",
    "hrci-phr-2026-v1",
    "Other Self-Directed Learning",
    0,
    "informational",
    "nested",
    "hrci-phr-2026-self-directed-learning",
    "optional",
    "Use this classifier for eligible self-directed learning such as preapproved books, book discussions, or mentee coaching. Its credits roll up to the 30-credit Self-Directed Learning aggregate cap.",
    "HRCI activity type",
    3,
  ],
  [
    "hrci-phr-2026-audited-college-course",
    "hrci-phr-2026-v1",
    "Audited College Course",
    10,
    "maximum",
    "nested",
    "hrci-phr-2026-professional-development",
    "optional",
    "No more than 10 credits may count for an eligible audited college course. HRCI treats this as instructor-led professional development, so it does not consume the 30-credit Self-Directed Learning cap.",
    "HRCI activity type",
    4,
  ],
  [
    "hrci-phr-2026-professional-achievement",
    "hrci-phr-2026-v1",
    "Professional Achievement",
    40,
    "maximum",
    "independent",
    null,
    "optional",
    "No more than 40 professional achievement credits may count in aggregate. Classify each achievement under Other Professional Achievement or HR Membership so its credits roll up to this cap once.",
    null,
    5,
  ],
  [
    "hrci-phr-2026-other-professional-achievement",
    "hrci-phr-2026-v1",
    "Other Professional Achievement",
    0,
    "informational",
    "nested",
    "hrci-phr-2026-professional-achievement",
    "optional",
    "Use this classifier for eligible professional achievement other than HR membership. Its credits roll up to the 40-credit Professional Achievement aggregate cap.",
    "HRCI activity type",
    6,
  ],
  [
    "hrci-phr-2026-hr-membership",
    "hrci-phr-2026-v1",
    "HR Membership",
    12,
    "maximum",
    "nested",
    "hrci-phr-2026-professional-achievement",
    "optional",
    "Award one HR membership credit after at least six months of membership, with no more than two credits per recertification cycle year per organization and 12 per cycle. These credits remain inside the 40-credit Professional Achievement aggregate cap and cannot carry into a later cycle.",
    "HRCI activity type",
    7,
  ],
  [
    "hrci-phr-2026-ethics",
    "hrci-phr-2026-v1",
    "Ethics-Themed Activity",
    1,
    "minimum",
    "overlapping",
    null,
    "always",
    "Complete at least one credit from an ethics-themed activity. The ethics credit remains inside the 60-credit total and may overlap the activity's applicable HRCI type.",
    null,
    8,
  ],
  [
    "hrci-sphr-2026-professional-development",
    "hrci-sphr-2026-v1",
    "Professional Development — Preapproved or Instructor-Led",
    0,
    "informational",
    "independent",
    null,
    "optional",
    "Use this classifier for eligible preapproved or instructor-led professional development that is not self-directed learning or portal-confirmed carryover. This category has no separate cap.",
    "HRCI activity type",
    0,
  ],
  [
    "hrci-sphr-2026-confirmed-carryover",
    "hrci-sphr-2026-v1",
    "HRCI-Confirmed Carryover",
    15,
    "maximum",
    "independent",
    null,
    "conditional",
    "Record only General HR credits HRCI posts to the new cycle. At most 15 surplus credits earned in the final 12 months may carry, and HR membership credit is ineligible.",
    "HRCI activity type",
    1,
  ],
  [
    "hrci-sphr-2026-self-directed-learning",
    "hrci-sphr-2026-v1",
    "Self-Directed Learning",
    30,
    "maximum",
    "independent",
    null,
    "optional",
    "No more than 30 self-directed learning credits may count toward the 60-credit recertification total. Use this aggregate for eligible preapproved books, book discussions, and mentee coaching; audited college courses are instructor-led professional development and do not roll up here.",
    null,
    2,
  ],
  [
    "hrci-sphr-2026-other-self-directed-learning",
    "hrci-sphr-2026-v1",
    "Other Self-Directed Learning",
    0,
    "informational",
    "nested",
    "hrci-sphr-2026-self-directed-learning",
    "optional",
    "Use this classifier for eligible self-directed learning such as preapproved books, book discussions, or mentee coaching. Its credits roll up to the 30-credit Self-Directed Learning aggregate cap.",
    "HRCI activity type",
    3,
  ],
  [
    "hrci-sphr-2026-audited-college-course",
    "hrci-sphr-2026-v1",
    "Audited College Course",
    10,
    "maximum",
    "nested",
    "hrci-sphr-2026-professional-development",
    "optional",
    "No more than 10 credits may count for an eligible audited college course. HRCI treats this as instructor-led professional development, so it does not consume the 30-credit Self-Directed Learning cap.",
    "HRCI activity type",
    4,
  ],
  [
    "hrci-sphr-2026-professional-achievement",
    "hrci-sphr-2026-v1",
    "Professional Achievement",
    40,
    "maximum",
    "independent",
    null,
    "optional",
    "No more than 40 professional achievement credits may count in aggregate. Classify each achievement under Other Professional Achievement or HR Membership so its credits roll up to this cap once.",
    null,
    5,
  ],
  [
    "hrci-sphr-2026-other-professional-achievement",
    "hrci-sphr-2026-v1",
    "Other Professional Achievement",
    0,
    "informational",
    "nested",
    "hrci-sphr-2026-professional-achievement",
    "optional",
    "Use this classifier for eligible professional achievement other than HR membership. Its credits roll up to the 40-credit Professional Achievement aggregate cap.",
    "HRCI activity type",
    6,
  ],
  [
    "hrci-sphr-2026-hr-membership",
    "hrci-sphr-2026-v1",
    "HR Membership",
    12,
    "maximum",
    "nested",
    "hrci-sphr-2026-professional-achievement",
    "optional",
    "Award one HR membership credit after at least six months of membership, with no more than two credits per recertification cycle year per organization and 12 per cycle. These credits remain inside the 40-credit Professional Achievement aggregate cap and cannot carry into a later cycle.",
    "HRCI activity type",
    7,
  ],
  [
    "hrci-sphr-2026-ethics",
    "hrci-sphr-2026-v1",
    "Ethics-Themed Activity",
    1,
    "minimum",
    "overlapping",
    null,
    "always",
    "Complete at least one credit from an ethics-themed activity. The ethics credit remains inside the 60-credit total and may overlap the activity's applicable HRCI type.",
    null,
    8,
  ],
  [
    "hrci-sphr-2026-business-credit",
    "hrci-sphr-2026-v1",
    "Business Credit",
    15,
    "minimum",
    "overlapping",
    null,
    "always",
    "For the standard full-cycle path, at least 15 of the 60 credits must qualify for HRCI Business credit. Business credit may overlap the activity's applicable HRCI type and the ethics tag when appropriate. If the HRCI portal displays a prorated Business minimum, that portal value overrides and this template requires individual review.",
    null,
    9,
  ],
  [
    "shrm-cp-2026-education",
    "shrm-cp-2026-v1",
    "Advance Your Education",
    0,
    "informational",
    "independent",
    null,
    "optional",
    "Use this classifier for SHRM-accepted Advance Your Education PDCs other than portal-confirmed carryover. Enter the value accepted by SHRM rather than deriving PDCs locally.",
    "SHRM PDC category",
    0,
  ],
  [
    "shrm-cp-2026-organization",
    "shrm-cp-2026-v1",
    "Advance Your Organization",
    30,
    "maximum",
    "independent",
    null,
    "optional",
    "No more than 30 SHRM-accepted PDCs may count for Advance Your Organization. Enter the portal-accepted value and retain the supporting activity evidence.",
    "SHRM PDC category",
    1,
  ],
  [
    "shrm-cp-2026-profession",
    "shrm-cp-2026-v1",
    "Advance Your Profession",
    30,
    "maximum",
    "independent",
    null,
    "optional",
    "No more than 30 SHRM-accepted PDCs may count for Advance Your Profession. Do not infer membership awards locally; use the value accepted in the SHRM portal.",
    "SHRM PDC category",
    2,
  ],
  [
    "shrm-cp-2026-confirmed-carryover",
    "shrm-cp-2026-v1",
    "SHRM-Confirmed Carryover",
    20,
    "maximum",
    "nested",
    "shrm-cp-2026-education",
    "conditional",
    "Record only the carryover amount SHRM posts in the new cycle. License Lantern tracks that portal-confirmed amount under Advance Your Education, caps it at 20 PDCs, and does not reconstruct it from prior activities.",
    "SHRM PDC category",
    3,
  ],
  [
    "shrm-scp-2026-education",
    "shrm-scp-2026-v1",
    "Advance Your Education",
    0,
    "informational",
    "independent",
    null,
    "optional",
    "Use this classifier for SHRM-accepted Advance Your Education PDCs other than portal-confirmed carryover. Enter the value accepted by SHRM rather than deriving PDCs locally.",
    "SHRM PDC category",
    0,
  ],
  [
    "shrm-scp-2026-organization",
    "shrm-scp-2026-v1",
    "Advance Your Organization",
    30,
    "maximum",
    "independent",
    null,
    "optional",
    "No more than 30 SHRM-accepted PDCs may count for Advance Your Organization. Enter the portal-accepted value and retain the supporting activity evidence.",
    "SHRM PDC category",
    1,
  ],
  [
    "shrm-scp-2026-profession",
    "shrm-scp-2026-v1",
    "Advance Your Profession",
    30,
    "maximum",
    "independent",
    null,
    "optional",
    "No more than 30 SHRM-accepted PDCs may count for Advance Your Profession. Do not infer membership awards locally; use the value accepted in the SHRM portal.",
    "SHRM PDC category",
    2,
  ],
  [
    "shrm-scp-2026-confirmed-carryover",
    "shrm-scp-2026-v1",
    "SHRM-Confirmed Carryover",
    20,
    "maximum",
    "nested",
    "shrm-scp-2026-education",
    "conditional",
    "Record only the carryover amount SHRM posts in the new cycle. License Lantern tracks that portal-confirmed amount under Advance Your Education, caps it at 20 PDCs, and does not reconstruct it from prior activities.",
    "SHRM PDC category",
    3,
  ],
  ...ISC2_CATEGORY_SEED_BINDINGS,
  ...COMPTIA_CATEGORY_SEED_BINDINGS,
  ...INSURANCE_CATEGORY_SEED_BINDINGS,
  ...NREMT_CATEGORY_SEED_BINDINGS,
  ...EDUCATION_CATEGORY_SEED_BINDINGS,
  ...MENTAL_HEALTH_CATEGORY_SEED_BINDINGS,
  ...PHARMACY_CATEGORY_SEED_BINDINGS,
  ...NURSING_CATEGORY_SEED_BINDINGS,
] as const;

const MANAGED_EXTERNAL_RULE_SET_IDS = [
  ...ISC2_RULE_SET_SEED_BINDINGS,
  ...COMPTIA_RULE_SET_SEED_BINDINGS,
  ...INSURANCE_RULE_SET_SEED_BINDINGS,
  ...NREMT_RULE_SET_SEED_BINDINGS,
  ...EDUCATION_RULE_SET_SEED_BINDINGS,
  ...MENTAL_HEALTH_RULE_SET_SEED_BINDINGS,
  ...PHARMACY_RULE_SET_SEED_BINDINGS,
  ...NURSING_RULE_SET_SEED_BINDINGS,
].map((bindings) => bindings[0]);

const MANAGED_EXTERNAL_CATEGORY_IDS = [
  ...ISC2_CATEGORY_SEED_BINDINGS,
  ...COMPTIA_CATEGORY_SEED_BINDINGS,
  ...INSURANCE_CATEGORY_SEED_BINDINGS,
  ...NREMT_CATEGORY_SEED_BINDINGS,
  ...EDUCATION_CATEGORY_SEED_BINDINGS,
  ...MENTAL_HEALTH_CATEGORY_SEED_BINDINGS,
  ...PHARMACY_CATEGORY_SEED_BINDINGS,
  ...NURSING_CATEGORY_SEED_BINDINGS,
].map((bindings) => bindings[0]);

function trustedSqlStringList(values: readonly string[]) {
  return values
    .map((value) => `'${value.replaceAll("'", "''")}'`)
    .join(", ");
}

const MANAGED_EXTERNAL_RULE_SET_ID_LITERALS = trustedSqlStringList(
  MANAGED_EXTERNAL_RULE_SET_IDS,
);
const MANAGED_EXTERNAL_CATEGORY_ID_LITERALS = trustedSqlStringList(
  MANAGED_EXTERNAL_CATEGORY_IDS,
);
const MANAGED_EXTERNAL_SCOPE_SQL = `(managed_rule.id LIKE 'isc2-%'
  OR managed_rule.id LIKE 'comptia-%'
  OR managed_rule.profession = 'Insurance'
  OR managed_rule.id LIKE 'nremt-%'
  OR managed_rule.id LIKE 'ca-child-development-permit-%'
  OR managed_rule.id LIKE 'tx-standard-classroom-teacher-%'
  OR managed_rule.id LIKE 'ny-professional-classroom-teacher-%'
  OR managed_rule.id LIKE 'ny-professional-esol-bilingual-%'
  OR managed_rule.id LIKE 'nj-employed-teacher-%'
  OR managed_rule.id LIKE 'pa-professional-educator-%'
  OR managed_rule.id LIKE 'ca-bbs-%'
  OR managed_rule.id LIKE 'tx-lpc-%'
  OR managed_rule.id LIKE 'ny-lmsw-lcsw-%'
  OR managed_rule.id LIKE 'nj-lpc-%'
  OR managed_rule.id LIKE 'pa-lpc-%'
  OR managed_rule.id LIKE 'fl-lcsw-lmft-lmhc-%'
  OR managed_rule.profession = 'Pharmacy'
  OR managed_rule.profession = 'Nursing')`;

const RETIRE_MISSING_MANAGED_RULE_SETS_SQL = `UPDATE rule_sets AS managed_rule
SET is_current = 0
WHERE ${MANAGED_EXTERNAL_SCOPE_SQL}
  AND managed_rule.id NOT IN (${MANAGED_EXTERNAL_RULE_SET_ID_LITERALS})
  AND managed_rule.is_current IS NOT 0`;

const DEACTIVATE_MISSING_MANAGED_REQUIREMENTS_SQL = `UPDATE credential_requirements
SET
  is_active = 0,
  condition_note = CASE
    WHEN condition_note IS NULL OR TRIM(condition_note) = ''
      THEN 'This category was retired from the managed catalog. Its historical snapshot is preserved, but it no longer counts in this active cycle.'
    WHEN INSTR(condition_note, 'This category was retired from the managed catalog.') > 0
      THEN condition_note
    ELSE condition_note || ' This category was retired from the managed catalog. Its historical snapshot is preserved, but it no longer counts in this active cycle.'
  END
WHERE rule_category_id IN (
  SELECT managed_category.id
  FROM rule_categories managed_category
  JOIN rule_sets managed_rule
    ON managed_rule.id = managed_category.rule_set_id
  WHERE ${MANAGED_EXTERNAL_SCOPE_SQL}
    AND managed_category.id NOT IN (${MANAGED_EXTERNAL_CATEGORY_ID_LITERALS})
)
  AND credential_id IN (
    SELECT credential.id
    FROM credentials credential
    WHERE credential.status = 'active'
  )`;

const DELETE_MISSING_MANAGED_CATEGORIES_SQL = `DELETE FROM rule_categories
WHERE id IN (
  SELECT managed_category.id
  FROM rule_categories managed_category
  JOIN rule_sets managed_rule
    ON managed_rule.id = managed_category.rule_set_id
  WHERE ${MANAGED_EXTERNAL_SCOPE_SQL}
    AND managed_category.id NOT IN (${MANAGED_EXTERNAL_CATEGORY_ID_LITERALS})
)`;

const MAXIMUM_CLASSIFICATION_CATEGORY_REFRESH_SQL = `UPDATE rule_categories SET
  required_units = ?,
  kind = ?,
  relation = ?,
  parent_category_id = ?,
  applicability = ?,
  condition_note = ?,
  exclusive_group = ?,
  sort_order = ?
WHERE id = ?`;

const MAXIMUM_CLASSIFICATION_CATEGORY_REFRESH_BINDINGS = [
  [
    35,
    "minimum",
    "independent",
    null,
    "always",
    "At least 35 of the 60 PDUs must be Education PDUs. Select this activity-type classifier for Education and add any applicable Talent Triangle child tags separately.",
    "PMI PDU activity type",
    0,
    "pmi-pmp-2026-education",
  ],
  [
    25,
    "maximum",
    "independent",
    null,
    "optional",
    "Optional; at most 25 PDUs may be credited in Giving Back. Select this activity type for Giving Back other than Working as a Professional.",
    "PMI PDU activity type",
    4,
    "pmi-pmp-2026-giving-back",
  ],
  [
    8,
    "maximum",
    "nested",
    "pmi-pmp-2026-giving-back",
    "optional",
    "Optional subset of Giving Back; at most 8 PDUs, claimable once per cycle, and these PDUs cannot carry over. Select this leaf instead of the Giving Back parent so the same units roll up once.",
    "PMI PDU activity type",
    5,
    "pmi-pmp-2026-working-professional",
  ],
  [
    10,
    "maximum",
    "independent",
    null,
    "optional",
    "Up to 10 credits per biennium, earned at one CME credit per two qualifying volunteer-care hours; these credits do not count toward the Category I minimum. Use the Non-Volunteer CME Credit classifier for every other activity.",
    "New Jersey physician credit source",
    5,
    "nj-physician-2026-volunteer-care",
  ],
  [
    5,
    "informational",
    "overlapping",
    null,
    "optional",
    "Classification tag for accepted pharmacist-specific CE. The separate 15-hour Technician-Specific CE minimum safely limits pharmacist-specific credit to no more than 5 of the 20 counted hours, so no second maximum deduction is applied.",
    "PTCB provider audience",
    1,
    "ptcb-cpht-2026-pharmacist-specific",
  ],
] as const;

const MAXIMUM_CLASSIFICATION_RULE_SET_IDS = [
  "tx-attorney-active-2026-v1",
  "pa-attorney-active-2026-v1",
  "pmi-pmp-2026-v1",
  "nj-physician-2026-v1",
  "arrt-rt-standard-2026-v1",
  "ptcb-cpht-2026-v1",
  "cfp-professional-2027-v1",
  "nasm-cpt-2026-v1",
  "hrci-phr-2026-v1",
  "hrci-sphr-2026-v1",
  "shrm-cp-2026-v1",
  "shrm-scp-2026-v1",
  "isc2-cissp-2026-v1",
  "isc2-ccsp-2026-v1",
  "isc2-sscp-2026-v1",
  "isc2-csslp-2026-v1",
  "isc2-cgrc-2026-v1",
  ...COMPTIA_RULE_SET_IDS,
  ...EDUCATION_MAXIMUM_CLASSIFICATION_RULE_SET_IDS,
  ...MENTAL_HEALTH_MAXIMUM_CLASSIFICATION_RULE_SET_IDS,
  ...PHARMACY_MAXIMUM_CLASSIFICATION_RULE_SET_IDS,
  ...NURSING_MAXIMUM_CLASSIFICATION_RULE_SET_IDS,
] as const;

const ACTIVE_CATALOG_SNAPSHOT_RULE_SET_IDS = [
  ...new Set([
    ...MAXIMUM_CLASSIFICATION_RULE_SET_IDS,
    ...MANAGED_EXTERNAL_RULE_SET_IDS,
  ]),
];

const ACTIVE_CATALOG_SNAPSHOT_RULE_SET_ID_LITERALS = trustedSqlStringList(
  ACTIVE_CATALOG_SNAPSHOT_RULE_SET_IDS,
);

const BACKFILL_MAXIMUM_CLASSIFICATION_REQUIREMENTS_SQL = `INSERT INTO credential_requirements (
  id, credential_id, rule_category_id, name, required_units, kind, relation,
  parent_requirement_id, applicability, applicability_status, condition_note,
  exclusive_group, is_active, sort_order
)
SELECT
  'maximum-classification:' || credential.id || ':' || category.id,
  credential.id,
  category.id,
  category.name,
  category.required_units,
  category.kind,
  category.relation,
  NULL,
  category.applicability,
  CASE
    WHEN category.applicability = 'conditional' THEN 'needs_confirmation'
    ELSE 'applies'
  END,
  category.condition_note,
  category.exclusive_group,
  CASE WHEN category.applicability = 'conditional' THEN 0 ELSE 1 END,
  category.sort_order
FROM credentials credential
JOIN rule_categories category
  ON category.rule_set_id = credential.rule_set_id
WHERE credential.rule_set_id IN (${ACTIVE_CATALOG_SNAPSHOT_RULE_SET_ID_LITERALS})
  AND credential.status = 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM credential_requirements existing
    WHERE existing.credential_id = credential.id
      AND existing.rule_category_id = category.id
  )
ORDER BY credential.id, category.sort_order, category.id`;

const SYNC_MAXIMUM_CLASSIFICATION_REQUIREMENTS_SQL = `UPDATE credential_requirements
SET
  name = (
    SELECT category.name
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  required_units = (
    SELECT category.required_units
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  kind = (
    SELECT category.kind
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  relation = (
    SELECT category.relation
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  parent_requirement_id = (
    SELECT parent_requirement.id
    FROM rule_categories category
    JOIN credential_requirements parent_requirement
      ON parent_requirement.credential_id =
        credential_requirements.credential_id
      AND parent_requirement.rule_category_id =
        category.parent_category_id
    WHERE category.id = credential_requirements.rule_category_id
  ),
  applicability = (
    SELECT category.applicability
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  applicability_status = CASE
    WHEN credential_requirements.applicability IS NOT (
      SELECT category.applicability
      FROM rule_categories category
      WHERE category.id = credential_requirements.rule_category_id
    )
      THEN CASE
        WHEN (
          SELECT category.applicability
          FROM rule_categories category
          WHERE category.id = credential_requirements.rule_category_id
        ) = 'conditional'
          THEN 'needs_confirmation'
        ELSE 'applies'
      END
    ELSE credential_requirements.applicability_status
  END,
  is_active = CASE
    WHEN credential_requirements.applicability IS NOT (
      SELECT category.applicability
      FROM rule_categories category
      WHERE category.id = credential_requirements.rule_category_id
    )
      THEN CASE
        WHEN (
          SELECT category.applicability
          FROM rule_categories category
          WHERE category.id = credential_requirements.rule_category_id
        ) = 'conditional'
          THEN 0
        ELSE 1
      END
    ELSE credential_requirements.is_active
  END,
  condition_note = (
    SELECT category.condition_note
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  exclusive_group = (
    SELECT category.exclusive_group
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  ),
  sort_order = (
    SELECT category.sort_order
    FROM rule_categories category
    WHERE category.id = credential_requirements.rule_category_id
  )
WHERE credential_id IN (
  SELECT credential.id
  FROM credentials credential
  WHERE credential.rule_set_id IN (${ACTIVE_CATALOG_SNAPSHOT_RULE_SET_ID_LITERALS})
    AND credential.status = 'active'
)
  AND rule_category_id IN (
    SELECT category.id
    FROM rule_categories category
    WHERE category.rule_set_id IN (${ACTIVE_CATALOG_SNAPSHOT_RULE_SET_ID_LITERALS})
  )
  AND EXISTS (
    SELECT 1
    FROM rule_categories category
    LEFT JOIN credential_requirements parent_requirement
      ON parent_requirement.credential_id =
        credential_requirements.credential_id
      AND parent_requirement.rule_category_id =
        category.parent_category_id
    WHERE category.id = credential_requirements.rule_category_id
      AND (
        credential_requirements.name IS NOT category.name
        OR credential_requirements.required_units IS NOT category.required_units
        OR credential_requirements.kind IS NOT category.kind
        OR credential_requirements.relation IS NOT category.relation
        OR credential_requirements.parent_requirement_id IS NOT
          parent_requirement.id
        OR credential_requirements.applicability IS NOT category.applicability
        OR credential_requirements.applicability_status IS NOT (
          CASE
            WHEN credential_requirements.applicability IS NOT
              category.applicability
              THEN CASE
                WHEN category.applicability = 'conditional'
                  THEN 'needs_confirmation'
                ELSE 'applies'
              END
            ELSE credential_requirements.applicability_status
          END
        )
        OR credential_requirements.is_active IS NOT (
          CASE
            WHEN credential_requirements.applicability IS NOT
              category.applicability
              THEN CASE
                WHEN category.applicability = 'conditional' THEN 0
                ELSE 1
              END
            ELSE credential_requirements.is_active
          END
        )
        OR credential_requirements.condition_note IS NOT category.condition_note
        OR credential_requirements.exclusive_group IS NOT category.exclusive_group
        OR credential_requirements.sort_order IS NOT category.sort_order
      )
  )`;

const ACTIVE_FLORIDA_NURSING_TOTAL_SQL = `(
  SELECT
    catalog_rule.total_units +
    COALESCE(
      (
        SELECT MAX(domestic_violence.required_units)
        FROM credential_requirements domestic_violence
        WHERE domestic_violence.credential_id = credentials.id
          AND domestic_violence.rule_category_id = CASE
            WHEN credentials.rule_set_id = 'fl-rn-2026-v1'
              THEN 'fl-rn-2026-domestic-violence'
            WHEN credentials.rule_set_id = 'fl-lpn-2026-v1'
              THEN 'fl-lpn-2026-domestic-violence'
          END
          AND domestic_violence.applicability_status = 'applies'
          AND domestic_violence.is_active = 1
      ),
      0
    )
  FROM rule_sets catalog_rule
  WHERE catalog_rule.id = credentials.rule_set_id
)`;

const SYNC_ACTIVE_FLORIDA_NURSING_TOTAL_SQL = `UPDATE credentials
SET
  total_required = ${ACTIVE_FLORIDA_NURSING_TOTAL_SQL},
  updated_at = CURRENT_TIMESTAMP
WHERE status = 'active'
  AND rule_set_id IN ('fl-rn-2026-v1', 'fl-lpn-2026-v1')
  AND total_required IS NOT ${ACTIVE_FLORIDA_NURSING_TOTAL_SQL}`;

const SYNC_NURSING_DEFAULT_TASK_SQL = `UPDATE checklist_tasks
SET title = ?, updated_at = CURRENT_TIMESTAMP
WHERE kind = ?
  AND title = ?
  AND status = 'pending'
  AND is_personal = 0
  AND archived_at IS NULL
  AND credential_id IN (
    SELECT credential.id
    FROM credentials credential
    WHERE credential.rule_set_id = ?
      AND credential.status = 'active'
  )`;

const NURSING_DEFAULT_TASK_REFRESH_BINDINGS =
  NURSING_RENEWAL_TASK_COPY_BINDINGS.flatMap(
    ([ruleSetId, review, progress, submission]) =>
      [
        [
          review,
          "review",
          "Review the renewal requirements",
          ruleSetId,
        ],
        [
          progress,
          "progress",
          "Complete and document required education",
          ruleSetId,
        ],
        [
          submission,
          "submission",
          "Submit renewal and save confirmation",
          ruleSetId,
        ],
      ] as const,
  );

const MERGE_CFP_BOUNDARY_GENERAL_MATCHES_SQL = `INSERT INTO activity_requirement_matches (
  id, user_id, allocation_id, requirement_id, matched_units, created_at
)
SELECT
  'cfp-boundary-general:' || source_match.allocation_id,
  source_match.user_id,
  source_match.allocation_id,
  target_requirement.id,
  MAX(source_match.matched_units),
  MIN(source_match.created_at)
FROM activity_requirement_matches source_match
JOIN activity_allocations allocation
  ON allocation.id = source_match.allocation_id
JOIN activities activity
  ON activity.id = allocation.activity_id
JOIN credential_requirements source_requirement
  ON source_requirement.id = source_match.requirement_id
JOIN credentials credential
  ON credential.id = source_requirement.credential_id
JOIN credential_requirements target_requirement
  ON target_requirement.credential_id = credential.id
  AND target_requirement.rule_category_id =
    'cfp-professional-2027-general'
WHERE credential.rule_set_id = 'cfp-professional-2027-v1'
  AND credential.status = 'active'
  AND activity.archived_at IS NULL
  AND credential.cycle_start >= '2027-01-01'
  AND credential.cycle_start < '2027-04-01'
  AND source_requirement.rule_category_id IN (
    'cfp-professional-2027-principal-topics',
    'cfp-professional-2027-practice-management'
  )
GROUP BY
  source_match.user_id,
  source_match.allocation_id,
  target_requirement.id
ON CONFLICT(allocation_id, requirement_id) DO UPDATE SET
  matched_units = MAX(
    activity_requirement_matches.matched_units,
    excluded.matched_units
  ),
  created_at = MIN(
    activity_requirement_matches.created_at,
    excluded.created_at
  )`;

const REPOINT_CFP_BOUNDARY_ALLOCATIONS_SQL = `UPDATE activity_allocations
SET requirement_id = (
  SELECT target_requirement.id
  FROM credential_requirements source_requirement
  JOIN credentials credential
    ON credential.id = source_requirement.credential_id
  JOIN credential_requirements target_requirement
    ON target_requirement.credential_id = credential.id
    AND target_requirement.rule_category_id =
      'cfp-professional-2027-general'
  WHERE source_requirement.id = activity_allocations.requirement_id
    AND credential.rule_set_id = 'cfp-professional-2027-v1'
    AND credential.status = 'active'
    AND credential.cycle_start >= '2027-01-01'
    AND credential.cycle_start < '2027-04-01'
    AND source_requirement.rule_category_id IN (
      'cfp-professional-2027-principal-topics',
      'cfp-professional-2027-practice-management'
    )
)
WHERE requirement_id IN (
  SELECT source_requirement.id
  FROM credential_requirements source_requirement
  JOIN credentials credential
    ON credential.id = source_requirement.credential_id
  WHERE credential.rule_set_id = 'cfp-professional-2027-v1'
    AND credential.status = 'active'
    AND credential.cycle_start >= '2027-01-01'
    AND credential.cycle_start < '2027-04-01'
    AND source_requirement.rule_category_id IN (
      'cfp-professional-2027-principal-topics',
      'cfp-professional-2027-practice-management'
    )
 )
  AND EXISTS (
    SELECT 1
    FROM activities activity
    WHERE activity.id = activity_allocations.activity_id
      AND activity.archived_at IS NULL
  )`;

const DELETE_CFP_BOUNDARY_SOURCE_MATCHES_SQL = `DELETE FROM activity_requirement_matches
WHERE requirement_id IN (
  SELECT source_requirement.id
  FROM credential_requirements source_requirement
  JOIN credentials credential
    ON credential.id = source_requirement.credential_id
  WHERE credential.rule_set_id = 'cfp-professional-2027-v1'
    AND credential.status = 'active'
    AND credential.cycle_start >= '2027-01-01'
    AND credential.cycle_start < '2027-04-01'
    AND source_requirement.rule_category_id IN (
      'cfp-professional-2027-principal-topics',
      'cfp-professional-2027-practice-management'
    )
 )
  AND EXISTS (
    SELECT 1
    FROM activity_allocations allocation
    JOIN activities activity ON activity.id = allocation.activity_id
    WHERE allocation.id = activity_requirement_matches.allocation_id
      AND activity.archived_at IS NULL
  )`;

const DELETE_CFP_BOUNDARY_OBSOLETE_REQUIREMENTS_SQL = `DELETE FROM credential_requirements
WHERE rule_category_id IN (
  'cfp-professional-2027-principal-topics',
  'cfp-professional-2027-practice-management'
)
  AND credential_id IN (
    SELECT credential.id
    FROM credentials credential
    WHERE credential.rule_set_id = 'cfp-professional-2027-v1'
      AND credential.status = 'active'
      AND credential.cycle_start >= '2027-01-01'
      AND credential.cycle_start < '2027-04-01'
  )`;

const SYNC_CFP_BOUNDARY_GENERAL_REQUIREMENT_SQL = `UPDATE credential_requirements
SET
  rule_category_id = 'cfp-professional-pre-2027-general',
  name = (
    SELECT category.name
    FROM rule_categories category
    WHERE category.id = 'cfp-professional-pre-2027-general'
  ),
  required_units = 28,
  kind = 'minimum',
  relation = 'independent',
  parent_requirement_id = NULL,
  applicability = 'always',
  applicability_status = 'applies',
  condition_note = (
    SELECT category.condition_note
    FROM rule_categories category
    WHERE category.id = 'cfp-professional-pre-2027-general'
  ),
  exclusive_group = 'CFP CE type',
  is_active = 1,
  sort_order = 0
WHERE rule_category_id = 'cfp-professional-2027-general'
  AND credential_id IN (
    SELECT credential.id
    FROM credentials credential
    WHERE credential.rule_set_id = 'cfp-professional-2027-v1'
      AND credential.status = 'active'
      AND credential.cycle_start >= '2027-01-01'
      AND credential.cycle_start < '2027-04-01'
  )`;

const SYNC_CFP_BOUNDARY_ETHICS_REQUIREMENT_SQL = `UPDATE credential_requirements
SET
  rule_category_id = 'cfp-professional-pre-2027-ethics',
  name = (
    SELECT category.name
    FROM rule_categories category
    WHERE category.id = 'cfp-professional-pre-2027-ethics'
  ),
  required_units = 2,
  kind = 'minimum',
  relation = 'independent',
  parent_requirement_id = NULL,
  applicability = 'always',
  applicability_status = 'applies',
  condition_note = (
    SELECT category.condition_note
    FROM rule_categories category
    WHERE category.id = 'cfp-professional-pre-2027-ethics'
  ),
  exclusive_group = 'CFP CE type',
  is_active = 1,
  sort_order = 1
WHERE rule_category_id = 'cfp-professional-2027-ethics'
  AND credential_id IN (
    SELECT credential.id
    FROM credentials credential
    WHERE credential.rule_set_id = 'cfp-professional-2027-v1'
      AND credential.status = 'active'
      AND credential.cycle_start >= '2027-01-01'
      AND credential.cycle_start < '2027-04-01'
  )`;

const RETITLE_CFP_BOUNDARY_REVIEW_TASK_SQL = `UPDATE checklist_tasks
SET
  title = 'Review this corrected pre-April CFP cycle and remove any carryover entered for it',
  updated_at = CURRENT_TIMESTAMP
WHERE kind = 'review'
  AND status = 'pending'
  AND title =
    'Confirm CFP Board carryover, then manually record only approved general CE'
  AND credential_id IN (
    SELECT credential.id
    FROM credentials credential
    WHERE credential.rule_set_id = 'cfp-professional-2027-v1'
      AND credential.status = 'active'
      AND credential.cycle_start >= '2027-01-01'
      AND credential.cycle_start < '2027-04-01'
  )`;

const INSERT_CFP_BOUNDARY_REVIEW_TASK_SQL = `INSERT OR IGNORE INTO checklist_tasks (
  id, user_id, credential_id, title, kind, status, due_date, sort_order
)
SELECT
  'cfp-boundary-review:' || credential.id,
  credential.user_id,
  credential.id,
  'Review this corrected pre-April CFP cycle and remove any carryover entered for it',
  'review',
  'pending',
  DATE(credential.deadline, '-120 days'),
  0
FROM credentials credential
WHERE credential.rule_set_id = 'cfp-professional-2027-v1'
  AND credential.status = 'active'
  AND credential.cycle_start >= '2027-01-01'
  AND credential.cycle_start < '2027-04-01'
  AND NOT EXISTS (
    SELECT 1
    FROM checklist_tasks task
    WHERE task.credential_id = credential.id
      AND task.status = 'pending'
      AND task.title =
        'Review this corrected pre-April CFP cycle and remove any carryover entered for it'
  )`;

const UPDATE_CFP_BOUNDARY_CREDENTIAL_SQL = `UPDATE credentials
SET
  rule_set_id = 'cfp-professional-pre-2027-v1',
  credential_name =
    'CFP® Professional — cycle beginning before April 1, 2027',
  total_required = 30,
  updated_at = CURRENT_TIMESTAMP
WHERE rule_set_id = 'cfp-professional-2027-v1'
  AND status = 'active'
  AND cycle_start >= '2027-01-01'
  AND cycle_start < '2027-04-01'`;

const CFP_TRANSITION_RULE_SET_REFRESH_SQL = `UPDATE rule_sets SET
  credential_name = ?,
  total_units = ?,
  source_url = ?,
  source_title = ?,
  effective_date = ?,
  last_verified_at = ?,
  review_status = ?,
  is_current = ?
WHERE id = ?`;

const CFP_TRANSITION_CATEGORY_REFRESH_SQL = `UPDATE rule_categories SET
  name = ?,
  required_units = ?,
  kind = ?,
  relation = ?,
  parent_category_id = ?,
  applicability = ?,
  condition_note = ?,
  exclusive_group = ?,
  sort_order = ?
WHERE id = ?`;

let initializationPromise: Promise<void> | null = null;

function statement(
  database: D1Database,
  sql: string,
  bindings: readonly unknown[] = [],
) {
  return database.prepare(sql).bind(...bindings);
}

async function ensureRichRuleColumns(database: D1Database) {
  for (const table of [
    "rule_categories",
    "credential_requirements",
    "renewal_submissions",
    "renewal_acceptances",
    "activities",
    "checklist_tasks",
  ] as const) {
    const result = await database
      .prepare(`PRAGMA table_info(${table})`)
      .all<{ name: string }>();
    const existing = new Set(result.results.map((column) => column.name));
    for (const column of RICH_RULE_COLUMNS) {
      if (column.table !== table || existing.has(column.name)) continue;
      await database
        .prepare(`ALTER TABLE ${table} ADD COLUMN ${column.definition}`)
        .run();
    }
  }
}

export async function initializeDatabase(database: D1Database): Promise<void> {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      await database.batch(
        TABLE_STATEMENTS.map((sql) => database.prepare(sql)),
      );
      await ensureRichRuleColumns(database);
      await database.batch(
        RICH_RULE_INDEX_STATEMENTS.map((sql) => database.prepare(sql)),
      );
      await database.batch(
        GLOBAL_SEED_STATEMENTS.map((seed) =>
          statement(database, seed.sql, seed.bindings),
        ),
      );
      await database.batch([
        statement(
          database,
          NJ_LCSW_RULE_SET_REFRESH_SQL,
          NJ_LCSW_RULE_SET_REFRESH_BINDINGS,
        ),
      ]);
      await database.batch(
        NJ_LCSW_CATEGORY_BINDINGS.map((bindings) =>
          statement(database, NJ_LCSW_CATEGORY_INSERT_SQL, bindings),
        ),
      );
      await database.batch(
        NJ_LCSW_CATEGORY_BINDINGS.map((bindings) =>
          statement(database, NJ_LCSW_CATEGORY_REFRESH_SQL, [
            ...bindings.slice(1),
            bindings[0],
          ]),
        ),
      );
      await database.batch(
        CATALOG_2026_RULE_SET_SEED_BINDINGS.map((bindings) =>
          statement(database, CATALOG_2026_RULE_SET_INSERT_SQL, bindings),
        ),
      );
      await database.batch(
        ATTORNEY_RULE_SET_REFRESH_BINDINGS.map((bindings) =>
          statement(database, ATTORNEY_RULE_SET_REFRESH_SQL, bindings),
        ),
      );
      await database.batch(
        RICH_RULE_CATEGORY_SEED_BINDINGS.map((bindings) =>
          statement(database, RICH_RULE_CATEGORY_INSERT_SQL, bindings),
        ),
      );
      await database.batch(
        CATALOG_2026_CATEGORY_SEED_BINDINGS.map((bindings) =>
          statement(database, CATALOG_2026_CATEGORY_INSERT_SQL, bindings),
        ),
      );
      await database.batch([
        statement(database, RETIRE_MISSING_MANAGED_RULE_SETS_SQL),
        statement(database, DEACTIVATE_MISSING_MANAGED_REQUIREMENTS_SQL),
        statement(database, DELETE_MISSING_MANAGED_CATEGORIES_SQL),
      ]);
      await database.batch(
        CATALOG_2026_RULE_SET_SEED_BINDINGS.filter(
          (bindings) =>
            bindings[0] === "cfp-professional-pre-2027-v1" ||
            bindings[0] === "cfp-professional-2027-v1",
        ).map((bindings) =>
          statement(database, CFP_TRANSITION_RULE_SET_REFRESH_SQL, [
            bindings[4],
            bindings[7],
            bindings[10],
            bindings[11],
            bindings[12],
            bindings[13],
            bindings[14],
            bindings[15],
            bindings[0],
          ]),
        ),
      );
      await database.batch(
        CATALOG_2026_CATEGORY_SEED_BINDINGS.filter(
          (bindings) =>
            bindings[1] === "cfp-professional-pre-2027-v1" ||
            bindings[1] === "cfp-professional-2027-v1",
        ).map((bindings) =>
          statement(database, CFP_TRANSITION_CATEGORY_REFRESH_SQL, [
            bindings[2],
            bindings[3],
            bindings[4],
            bindings[5],
            bindings[6],
            bindings[7],
            bindings[8],
            bindings[9],
            bindings[10],
            bindings[0],
          ]),
        ),
      );
      await database.batch(
        RICH_RULE_CATEGORY_UPDATE_BINDINGS.map((bindings) =>
          statement(database, RICH_RULE_CATEGORY_UPDATE_SQL, bindings),
        ),
      );
      await database.batch(
        ATTORNEY_RULE_CATEGORY_REFRESH_BINDINGS.map((bindings) =>
          statement(database, ATTORNEY_RULE_CATEGORY_REFRESH_SQL, bindings),
        ),
      );
      await database.batch(
        MAXIMUM_CLASSIFICATION_CATEGORY_REFRESH_BINDINGS.map((bindings) =>
          statement(
            database,
            MAXIMUM_CLASSIFICATION_CATEGORY_REFRESH_SQL,
            bindings,
          ),
        ),
      );
      await database.batch([
        statement(database, BACKFILL_NJ_LCSW_CREDENTIAL_REQUIREMENTS_SQL, [
          RULE_SET_ID,
        ]),
        statement(database, SYNC_NJ_LCSW_CREDENTIAL_REQUIREMENTS_SQL, [
          RULE_SET_ID,
          RULE_SET_ID,
        ]),
        statement(
          database,
          BACKFILL_ATTORNEY_CREDENTIAL_REQUIREMENTS_SQL,
          ATTORNEY_CREDENTIAL_REQUIREMENT_SYNC_RULE_SET_IDS,
        ),
        statement(database, SYNC_ATTORNEY_CREDENTIAL_REQUIREMENTS_SQL, [
          ...ATTORNEY_CREDENTIAL_REQUIREMENT_SYNC_RULE_SET_IDS,
          ...ATTORNEY_CREDENTIAL_REQUIREMENT_SYNC_RULE_SET_IDS,
        ]),
        statement(database, BACKFILL_MAXIMUM_CLASSIFICATION_REQUIREMENTS_SQL),
        statement(database, SYNC_MAXIMUM_CLASSIFICATION_REQUIREMENTS_SQL),
        statement(database, SYNC_ACTIVE_FLORIDA_NURSING_TOTAL_SQL),
        statement(database, MERGE_CFP_BOUNDARY_GENERAL_MATCHES_SQL),
        statement(database, REPOINT_CFP_BOUNDARY_ALLOCATIONS_SQL),
        statement(database, DELETE_CFP_BOUNDARY_SOURCE_MATCHES_SQL),
        statement(database, DELETE_CFP_BOUNDARY_OBSOLETE_REQUIREMENTS_SQL),
        statement(database, SYNC_CFP_BOUNDARY_GENERAL_REQUIREMENT_SQL),
        statement(database, SYNC_CFP_BOUNDARY_ETHICS_REQUIREMENT_SQL),
        statement(database, RETITLE_CFP_BOUNDARY_REVIEW_TASK_SQL),
        statement(database, INSERT_CFP_BOUNDARY_REVIEW_TASK_SQL),
        statement(database, UPDATE_CFP_BOUNDARY_CREDENTIAL_SQL),
        statement(database, BACKFILL_TEXAS_ETHICS_MATCHES_SQL),
        ...RETIRED_ATTORNEY_RULE_CATEGORY_BINDINGS.map((bindings) =>
          statement(
            database,
            RETIRE_ATTORNEY_CREDENTIAL_REQUIREMENT_SQL,
            bindings,
          ),
        ),
        ...RETIRED_ATTORNEY_RULE_CATEGORY_BINDINGS.map((bindings) =>
          statement(
            database,
            DELETE_RETIRED_ATTORNEY_RULE_CATEGORY_SQL,
            [bindings[1]],
          ),
        ),
      ]);
      await database.batch(
        NURSING_DEFAULT_TASK_REFRESH_BINDINGS.map((bindings) =>
          statement(database, SYNC_NURSING_DEFAULT_TASK_SQL, bindings),
        ),
      );
      await database.batch(
        INTEGRITY_TRIGGER_STATEMENTS.map((sql) => database.prepare(sql)),
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
    statement(
      database,
      `INSERT OR IGNORE INTO reminder_preferences (
        user_id, in_app_enabled, lead_days, time_zone
      ) VALUES (?, 1, '[90,30,7,1]', 'UTC')`,
      [identity.userId],
    ),
  ]);

  if (identity.isDemo) await ensureDemoWorkspace(database, identity.userId);

  await statement(
    database,
    `INSERT OR IGNORE INTO credential_cycle_links (
      id, user_id, credential_id, series_id, previous_credential_id, cycle_months
    )
    SELECT
      'cycle-link-' || c.id,
      c.user_id,
      c.id,
      c.id,
      NULL,
      COALESCE(rules.cycle_months, 12)
    FROM credentials c
    LEFT JOIN rule_sets rules ON rules.id = c.rule_set_id
    WHERE c.user_id = ?`,
    [identity.userId],
  ).run();

  await statement(
    database,
    `INSERT OR IGNORE INTO activity_requirement_matches (
      id, user_id, allocation_id, requirement_id, matched_units
    )
    SELECT
      'legacy-match-' || allocation.id,
      activity.user_id,
      allocation.id,
      requirement.id,
      allocation.allocated_units
    FROM activity_allocations allocation
    JOIN activities activity ON activity.id = allocation.activity_id
    JOIN credentials credential
      ON credential.id = allocation.credential_id
      AND credential.user_id = activity.user_id
    JOIN credential_requirements requirement
      ON requirement.id = allocation.requirement_id
      AND requirement.credential_id = allocation.credential_id
    WHERE activity.user_id = ?
      AND activity.archived_at IS NULL
      AND credential.status IN ('active', 'submitted')
      AND allocation.requirement_id IS NOT NULL
      AND requirement.is_active = 1
      AND requirement.applicability_status = 'applies'`,
    [identity.userId],
  ).run();
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
  const reqClinicalId = demoId("nj-lcsw-clinical");
  const reqEthicsId = demoId("nj-lcsw-ethics");
  const reqCulturalId = demoId("nj-lcsw-cultural");
  const reqOpioidId = demoId("nj-lcsw-opioid");
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
        (id, credential_id, rule_category_id, name, required_units, kind,
        relation, applicability, applicability_status, condition_note,
        exclusive_group, is_active, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reqGeneralId,
        credentialId,
        RULE_GENERAL_ID,
        "General Social Work",
        0,
        "informational",
        "independent",
        "optional",
        "applies",
        NJ_LCSW_CATEGORY_BINDINGS[0][8],
        NJ_LCSW_CREDIT_CATEGORY_GROUP,
        1,
        0,
      ],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO credential_requirements
        (id, credential_id, rule_category_id, name, required_units, kind,
        relation, applicability, applicability_status, condition_note,
        exclusive_group, is_active, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reqClinicalId,
        credentialId,
        RULE_CLINICAL_ID,
        "Clinical Practice",
        20,
        "minimum",
        "independent",
        "always",
        "applies",
        NJ_LCSW_CATEGORY_BINDINGS[1][8],
        NJ_LCSW_CREDIT_CATEGORY_GROUP,
        1,
        1,
      ],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO credential_requirements
        (id, credential_id, rule_category_id, name, required_units, kind,
        relation, applicability, applicability_status, condition_note,
        exclusive_group, is_active, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reqEthicsId,
        credentialId,
        RULE_ETHICS_ID,
        "Ethics",
        5,
        "minimum",
        "independent",
        "always",
        "applies",
        NJ_LCSW_CATEGORY_BINDINGS[2][8],
        NJ_LCSW_CREDIT_CATEGORY_GROUP,
        1,
        2,
      ],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO credential_requirements
        (id, credential_id, rule_category_id, name, required_units, kind,
        relation, applicability, applicability_status, condition_note,
        exclusive_group, is_active, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reqCulturalId,
        credentialId,
        RULE_CULTURAL_ID,
        "Social and Cultural Competence",
        3,
        "minimum",
        "independent",
        "always",
        "applies",
        NJ_LCSW_CATEGORY_BINDINGS[3][8],
        NJ_LCSW_CREDIT_CATEGORY_GROUP,
        1,
        3,
      ],
    ),
    statement(
      database,
      `INSERT OR IGNORE INTO credential_requirements
        (id, credential_id, rule_category_id, name, required_units, kind,
        relation, applicability, applicability_status, condition_note,
        exclusive_group, is_active, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reqOpioidId,
        credentialId,
        RULE_OPIOID_ID,
        "Prescription Opioid Drugs",
        1,
        "minimum",
        "overlapping",
        "always",
        "applies",
        NJ_LCSW_CATEGORY_BINDINGS[4][8],
        null,
        1,
        4,
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
