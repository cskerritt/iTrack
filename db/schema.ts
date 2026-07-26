import { sql } from "drizzle-orm";
import {
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
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    uniqueIndex("rule_categories_rule_name_unique").on(
      table.ruleSetId,
      table.name,
    ),
    index("rule_categories_rule_idx").on(table.ruleSetId, table.sortOrder),
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
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (table) => [
    index("credential_requirements_credential_idx").on(
      table.credentialId,
      table.sortOrder,
    ),
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
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("activities_user_date_idx").on(table.userId, table.completionDate),
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
    uniqueIndex("activity_allocations_target_unique").on(
      table.activityId,
      table.credentialId,
      table.requirementId,
    ),
    index("activity_allocations_credential_idx").on(table.credentialId),
    index("activity_allocations_requirement_idx").on(table.requirementId),
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
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("checklist_tasks_user_credential_idx").on(
      table.userId,
      table.credentialId,
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
