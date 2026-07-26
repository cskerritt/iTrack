import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    isDemo: integer("is_demo", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const profiles = sqliteTable("profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  weeklyGoal: integer("weekly_goal").notNull().default(4),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const weeklyProgressionPeriods = sqliteTable(
  "weekly_progression_periods",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    weekStart: text("week_start").notNull(),
    weeklyGoal: integer("weekly_goal").notNull(),
    timeZone: text("time_zone").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("weekly_progression_periods_user_week_unique").on(
      table.userId,
      table.weekStart,
    ),
  ],
);

export const ruleSets = sqliteTable(
  "rule_sets",
  {
    id: text("id").primaryKey(),
    stableKey: text("stable_key").notNull(),
    version: integer("version").notNull(),
    profession: text("profession").notNull(),
    credentialName: text("credential_name").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    issuer: text("issuer").notNull(),
    totalUnits: real("total_units").notNull(),
    unitLabel: text("unit_label").notNull(),
    cycleMonths: integer("cycle_months").notNull(),
    sourceUrl: text("source_url").notNull(),
    sourceTitle: text("source_title").notNull(),
    effectiveDate: text("effective_date"),
    lastVerifiedAt: text("last_verified_at"),
    reviewStatus: text("review_status").notNull().default("needs_review"),
    isCurrent: integer("is_current", { mode: "boolean" })
      .notNull()
      .default(true),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("rule_sets_stable_key_version_unique").on(
      table.stableKey,
      table.version,
    ),
    index("rule_sets_current_idx").on(table.isCurrent, table.profession),
  ],
);

export const ruleCategories = sqliteTable(
  "rule_categories",
  {
    id: text("id").primaryKey(),
    ruleSetId: text("rule_set_id")
      .notNull()
      .references(() => ruleSets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    requiredUnits: real("required_units").notNull(),
    kind: text("kind").notNull().default("minimum"),
    relation: text("relation").notNull().default("independent"),
    parentCategoryId: text("parent_category_id").references(
      (): AnySQLiteColumn => ruleCategories.id,
      { onDelete: "set null" },
    ),
    applicability: text("applicability").notNull().default("always"),
    conditionNote: text("condition_note"),
    exclusiveGroup: text("exclusive_group"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    uniqueIndex("rule_categories_rule_name_unique").on(
      table.ruleSetId,
      table.name,
    ),
    index("rule_categories_rule_idx").on(table.ruleSetId, table.sortOrder),
    index("rule_categories_parent_idx").on(table.parentCategoryId),
  ],
);

export const credentials = sqliteTable(
  "credentials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ruleSetId: text("rule_set_id").references(() => ruleSets.id, {
      onDelete: "set null",
    }),
    credentialName: text("credential_name").notNull(),
    profession: text("profession").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    issuer: text("issuer").notNull(),
    cycleStart: text("cycle_start").notNull(),
    deadline: text("deadline").notNull(),
    totalRequired: real("total_required").notNull(),
    unitLabel: text("unit_label").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("credentials_user_deadline_idx").on(table.userId, table.deadline),
    index("credentials_rule_set_idx").on(table.ruleSetId),
  ],
);

export const credentialRequirements = sqliteTable(
  "credential_requirements",
  {
    id: text("id").primaryKey(),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credentials.id, { onDelete: "cascade" }),
    ruleCategoryId: text("rule_category_id").references(
      () => ruleCategories.id,
      { onDelete: "set null" },
    ),
    name: text("name").notNull(),
    requiredUnits: real("required_units").notNull(),
    kind: text("kind").notNull().default("minimum"),
    relation: text("relation").notNull().default("independent"),
    parentRequirementId: text("parent_requirement_id").references(
      (): AnySQLiteColumn => credentialRequirements.id,
      { onDelete: "set null" },
    ),
    applicability: text("applicability").notNull().default("always"),
    applicabilityStatus: text("applicability_status")
      .notNull()
      .default("applies"),
    conditionNote: text("condition_note"),
    exclusiveGroup: text("exclusive_group"),
    isActive: integer("is_active", { mode: "boolean" })
      .notNull()
      .default(true),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    index("credential_requirements_credential_idx").on(
      table.credentialId,
      table.sortOrder,
    ),
    index("credential_requirements_parent_idx").on(table.parentRequirementId),
  ],
);

export const activities = sqliteTable(
  "activities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    provider: text("provider").notNull(),
    completionDate: text("completion_date").notNull(),
    totalUnits: real("total_units").notNull(),
    evidenceStatus: text("evidence_status").notNull().default("missing"),
    evidenceReference: text("evidence_reference"),
    revision: integer("revision").notNull().default(1),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("activities_user_date_idx").on(table.userId, table.completionDate),
    index("activities_user_archive_date_idx").on(
      table.userId,
      table.archivedAt,
      table.completionDate,
    ),
  ],
);

export const evidenceFiles = sqliteTable(
  "evidence_files",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    activityId: text("activity_id")
      .notNull()
      .references(() => activities.id),
    objectKey: text("object_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    storageEtag: text("storage_etag"),
    status: text("status").notNull().default("ready"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("evidence_files_object_key_unique").on(table.objectKey),
    uniqueIndex("evidence_files_activity_hash_unique").on(
      table.userId,
      table.activityId,
      table.sha256,
    ),
    index("evidence_files_user_created_idx").on(table.userId, table.createdAt),
    index("evidence_files_activity_created_idx").on(
      table.activityId,
      table.createdAt,
    ),
  ],
);

export const activityAllocations = sqliteTable(
  "activity_allocations",
  {
    id: text("id").primaryKey(),
    activityId: text("activity_id")
      .notNull()
      .references(() => activities.id, { onDelete: "cascade" }),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credentials.id, { onDelete: "cascade" }),
    requirementId: text("requirement_id").references(
      () => credentialRequirements.id,
      { onDelete: "set null" },
    ),
    allocatedUnits: real("allocated_units").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("activity_allocations_activity_credential_unique").on(
      table.activityId,
      table.credentialId,
    ),
    index("activity_allocations_credential_idx").on(table.credentialId),
    index("activity_allocations_requirement_idx").on(table.requirementId),
  ],
);

export const activityRequirementMatches = sqliteTable(
  "activity_requirement_matches",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    allocationId: text("allocation_id")
      .notNull()
      .references(() => activityAllocations.id, { onDelete: "cascade" }),
    requirementId: text("requirement_id")
      .notNull()
      .references(() => credentialRequirements.id, { onDelete: "cascade" }),
    matchedUnits: real("matched_units").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("activity_requirement_matches_allocation_requirement_unique").on(
      table.allocationId,
      table.requirementId,
    ),
    index("activity_requirement_matches_user_idx").on(table.userId),
    index("activity_requirement_matches_requirement_idx").on(
      table.requirementId,
    ),
  ],
);

export const checklistTasks = sqliteTable(
  "checklist_tasks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credentials.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    dueDate: text("due_date"),
    completedAt: text("completed_at"),
    sortOrder: integer("sort_order").notNull().default(0),
    isPersonal: integer("is_personal", { mode: "boolean" })
      .notNull()
      .default(false),
    revision: integer("revision").notNull().default(1),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("checklist_tasks_user_credential_idx").on(
      table.userId,
      table.credentialId,
      table.sortOrder,
    ),
    index("checklist_tasks_user_credential_archive_idx").on(
      table.userId,
      table.credentialId,
      table.archivedAt,
      table.sortOrder,
    ),
  ],
);

export const renewalSubmissions = sqliteTable(
  "renewal_submissions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credentials.id, { onDelete: "cascade" }),
    submittedAt: text("submitted_at").notNull(),
    confirmationNumber: text("confirmation_number").notNull(),
    proofReference: text("proof_reference"),
    attestationKind: text("attestation_kind"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("renewal_submissions_credential_unique").on(
      table.credentialId,
    ),
    index("renewal_submissions_user_idx").on(table.userId),
  ],
);

export const credentialCycleLinks = sqliteTable(
  "credential_cycle_links",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credentials.id, { onDelete: "cascade" }),
    seriesId: text("series_id").notNull(),
    previousCredentialId: text("previous_credential_id").references(
      () => credentials.id,
      { onDelete: "restrict" },
    ),
    cycleMonths: integer("cycle_months").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("credential_cycle_links_credential_unique").on(
      table.credentialId,
    ),
    uniqueIndex("credential_cycle_links_previous_unique").on(
      table.previousCredentialId,
    ),
    index("credential_cycle_links_user_series_idx").on(
      table.userId,
      table.seriesId,
    ),
  ],
);

export const renewalAcceptances = sqliteTable(
  "renewal_acceptances",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credentials.id, { onDelete: "restrict" }),
    submissionId: text("submission_id")
      .notNull()
      .references(() => renewalSubmissions.id, { onDelete: "restrict" }),
    acceptedAt: text("accepted_at").notNull(),
    acceptanceReference: text("acceptance_reference"),
    officialRecordAttestedAt: text("official_record_attested_at"),
    nextCredentialId: text("next_credential_id")
      .notNull()
      .references(() => credentials.id, { onDelete: "restrict" }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("renewal_acceptances_credential_unique").on(
      table.credentialId,
    ),
    uniqueIndex("renewal_acceptances_submission_unique").on(
      table.submissionId,
    ),
    uniqueIndex("renewal_acceptances_next_credential_unique").on(
      table.nextCredentialId,
    ),
    index("renewal_acceptances_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
  ],
);

export const reminderPreferences = sqliteTable("reminder_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  inAppEnabled: integer("in_app_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
  leadDays: text("lead_days").notNull().default("[90,30,7,1]"),
  timeZone: text("time_zone").notNull().default("UTC"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const reminderStates = sqliteTable(
  "reminder_states",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id")
      .notNull()
      .references(() => credentials.id, { onDelete: "cascade" }),
    reminderKey: text("reminder_key").notNull(),
    status: text("status").notNull(),
    snoozedUntil: text("snoozed_until"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("reminder_states_user_key_unique").on(
      table.userId,
      table.reminderKey,
    ),
    index("reminder_states_user_credential_idx").on(
      table.userId,
      table.credentialId,
    ),
  ],
);

export const badgeDefinitions = sqliteTable("badge_definitions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  icon: text("icon").notNull(),
});

export const xpEvents = sqliteTable(
  "xp_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    eventType: text("event_type").notNull(),
    points: integer("points").notNull(),
    relatedType: text("related_type"),
    relatedId: text("related_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("xp_events_idempotency_unique").on(table.idempotencyKey),
    index("xp_events_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const weeklyQuestClaims = sqliteTable(
  "weekly_quest_claims",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    weekStart: text("week_start").notNull(),
    questKey: text("quest_key").notNull(),
    progressAtClaim: integer("progress_at_claim").notNull(),
    target: integer("target").notNull(),
    xpReward: integer("xp_reward").notNull(),
    claimedAt: text("claimed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("weekly_quest_claims_user_week_quest_unique").on(
      table.userId,
      table.weekStart,
      table.questKey,
    ),
    index("weekly_quest_claims_user_week_idx").on(
      table.userId,
      table.weekStart,
    ),
  ],
);

export const badgeEvents = sqliteTable(
  "badge_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    badgeId: text("badge_id")
      .notNull()
      .references(() => badgeDefinitions.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    relatedType: text("related_type"),
    relatedId: text("related_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("badge_events_idempotency_unique").on(table.idempotencyKey),
    uniqueIndex("badge_events_user_badge_unique").on(
      table.userId,
      table.badgeId,
    ),
    index("badge_events_user_created_idx").on(table.userId, table.createdAt),
  ],
);
