CREATE TABLE `activity_requirement_matches` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`allocation_id` text NOT NULL,
	`requirement_id` text NOT NULL,
	`matched_units` real NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`allocation_id`) REFERENCES `activity_allocations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requirement_id`) REFERENCES `credential_requirements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_requirement_matches_allocation_requirement_unique` ON `activity_requirement_matches` (`allocation_id`,`requirement_id`);--> statement-breakpoint
CREATE INDEX `activity_requirement_matches_user_idx` ON `activity_requirement_matches` (`user_id`);--> statement-breakpoint
CREATE INDEX `activity_requirement_matches_requirement_idx` ON `activity_requirement_matches` (`requirement_id`);--> statement-breakpoint
ALTER TABLE `credential_requirements` ADD `kind` text DEFAULT 'minimum' NOT NULL;--> statement-breakpoint
ALTER TABLE `credential_requirements` ADD `relation` text DEFAULT 'independent' NOT NULL;--> statement-breakpoint
ALTER TABLE `credential_requirements` ADD `parent_requirement_id` text REFERENCES credential_requirements(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `credential_requirements` ADD `applicability` text DEFAULT 'always' NOT NULL;--> statement-breakpoint
ALTER TABLE `credential_requirements` ADD `applicability_status` text DEFAULT 'applies' NOT NULL;--> statement-breakpoint
ALTER TABLE `credential_requirements` ADD `condition_note` text;--> statement-breakpoint
ALTER TABLE `credential_requirements` ADD `is_active` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `credential_requirements_parent_idx` ON `credential_requirements` (`parent_requirement_id`);--> statement-breakpoint
ALTER TABLE `rule_categories` ADD `kind` text DEFAULT 'minimum' NOT NULL;--> statement-breakpoint
ALTER TABLE `rule_categories` ADD `relation` text DEFAULT 'independent' NOT NULL;--> statement-breakpoint
ALTER TABLE `rule_categories` ADD `parent_category_id` text REFERENCES rule_categories(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `rule_categories` ADD `applicability` text DEFAULT 'always' NOT NULL;--> statement-breakpoint
ALTER TABLE `rule_categories` ADD `condition_note` text;--> statement-breakpoint
CREATE INDEX `rule_categories_parent_idx` ON `rule_categories` (`parent_category_id`);--> statement-breakpoint
INSERT OR IGNORE INTO `activity_requirement_matches` (
	`id`,
	`user_id`,
	`allocation_id`,
	`requirement_id`,
	`matched_units`
)
SELECT
	'legacy-match-' || allocation.`id`,
	activity.`user_id`,
	allocation.`id`,
	requirement.`id`,
	allocation.`allocated_units`
FROM `activity_allocations` allocation
JOIN `activities` activity
	ON activity.`id` = allocation.`activity_id`
JOIN `credentials` credential
	ON credential.`id` = allocation.`credential_id`
	AND credential.`user_id` = activity.`user_id`
JOIN `credential_requirements` requirement
	ON requirement.`id` = allocation.`requirement_id`
	AND requirement.`credential_id` = allocation.`credential_id`
WHERE allocation.`requirement_id` IS NOT NULL;
