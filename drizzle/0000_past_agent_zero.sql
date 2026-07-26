CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`provider` text NOT NULL,
	`completion_date` text NOT NULL,
	`total_units` real NOT NULL,
	`evidence_status` text DEFAULT 'missing' NOT NULL,
	`evidence_reference` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `activities_user_date_idx` ON `activities` (`user_id`,`completion_date`);--> statement-breakpoint
CREATE TABLE `activity_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`requirement_id` text,
	`allocated_units` real NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requirement_id`) REFERENCES `credential_requirements`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_allocations_target_unique` ON `activity_allocations` (`activity_id`,`credential_id`,`requirement_id`);--> statement-breakpoint
CREATE INDEX `activity_allocations_credential_idx` ON `activity_allocations` (`credential_id`);--> statement-breakpoint
CREATE INDEX `activity_allocations_requirement_idx` ON `activity_allocations` (`requirement_id`);--> statement-breakpoint
CREATE TABLE `badge_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`icon` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `badge_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`badge_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`related_type` text,
	`related_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`badge_id`) REFERENCES `badge_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `badge_events_idempotency_unique` ON `badge_events` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `badge_events_user_badge_unique` ON `badge_events` (`user_id`,`badge_id`);--> statement-breakpoint
CREATE INDEX `badge_events_user_created_idx` ON `badge_events` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `checklist_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`due_date` text,
	`completed_at` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `checklist_tasks_user_credential_idx` ON `checklist_tasks` (`user_id`,`credential_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `credential_requirements` (
	`id` text PRIMARY KEY NOT NULL,
	`credential_id` text NOT NULL,
	`rule_category_id` text,
	`name` text NOT NULL,
	`required_units` real NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rule_category_id`) REFERENCES `rule_categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `credential_requirements_credential_idx` ON `credential_requirements` (`credential_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`rule_set_id` text,
	`credential_name` text NOT NULL,
	`profession` text NOT NULL,
	`jurisdiction` text NOT NULL,
	`issuer` text NOT NULL,
	`cycle_start` text NOT NULL,
	`deadline` text NOT NULL,
	`total_required` real NOT NULL,
	`unit_label` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rule_set_id`) REFERENCES `rule_sets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `credentials_user_deadline_idx` ON `credentials` (`user_id`,`deadline`);--> statement-breakpoint
CREATE INDEX `credentials_rule_set_idx` ON `credentials` (`rule_set_id`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`weekly_goal` integer DEFAULT 4 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `renewal_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`submitted_at` text NOT NULL,
	`confirmation_number` text NOT NULL,
	`proof_reference` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_submissions_credential_unique` ON `renewal_submissions` (`credential_id`);--> statement-breakpoint
CREATE INDEX `renewal_submissions_user_idx` ON `renewal_submissions` (`user_id`);--> statement-breakpoint
CREATE TABLE `rule_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_set_id` text NOT NULL,
	`name` text NOT NULL,
	`required_units` real NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`rule_set_id`) REFERENCES `rule_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rule_categories_rule_name_unique` ON `rule_categories` (`rule_set_id`,`name`);--> statement-breakpoint
CREATE INDEX `rule_categories_rule_idx` ON `rule_categories` (`rule_set_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `rule_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`stable_key` text NOT NULL,
	`version` integer NOT NULL,
	`profession` text NOT NULL,
	`credential_name` text NOT NULL,
	`jurisdiction` text NOT NULL,
	`issuer` text NOT NULL,
	`total_units` real NOT NULL,
	`unit_label` text NOT NULL,
	`cycle_months` integer NOT NULL,
	`source_url` text NOT NULL,
	`source_title` text NOT NULL,
	`effective_date` text,
	`last_verified_at` text,
	`review_status` text DEFAULT 'needs_review' NOT NULL,
	`is_current` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rule_sets_stable_key_version_unique` ON `rule_sets` (`stable_key`,`version`);--> statement-breakpoint
CREATE INDEX `rule_sets_current_idx` ON `rule_sets` (`is_current`,`profession`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `xp_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`event_type` text NOT NULL,
	`points` integer NOT NULL,
	`related_type` text,
	`related_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `xp_events_idempotency_unique` ON `xp_events` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `xp_events_user_created_idx` ON `xp_events` (`user_id`,`created_at`);