CREATE TABLE `credential_cycle_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`series_id` text NOT NULL,
	`previous_credential_id` text,
	`cycle_months` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`previous_credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credential_cycle_links_credential_unique` ON `credential_cycle_links` (`credential_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `credential_cycle_links_previous_unique` ON `credential_cycle_links` (`previous_credential_id`);--> statement-breakpoint
CREATE INDEX `credential_cycle_links_user_series_idx` ON `credential_cycle_links` (`user_id`,`series_id`);--> statement-breakpoint
CREATE TABLE `reminder_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`in_app_enabled` integer DEFAULT true NOT NULL,
	`lead_days` text DEFAULT '[90,30,7,1]' NOT NULL,
	`time_zone` text DEFAULT 'UTC' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `reminder_states` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`reminder_key` text NOT NULL,
	`status` text NOT NULL,
	`snoozed_until` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reminder_states_user_key_unique` ON `reminder_states` (`user_id`,`reminder_key`);--> statement-breakpoint
CREATE INDEX `reminder_states_user_credential_idx` ON `reminder_states` (`user_id`,`credential_id`);--> statement-breakpoint
CREATE TABLE `renewal_acceptances` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`submission_id` text NOT NULL,
	`accepted_at` text NOT NULL,
	`acceptance_reference` text,
	`next_credential_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`submission_id`) REFERENCES `renewal_submissions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`next_credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_acceptances_credential_unique` ON `renewal_acceptances` (`credential_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_acceptances_submission_unique` ON `renewal_acceptances` (`submission_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `renewal_acceptances_next_credential_unique` ON `renewal_acceptances` (`next_credential_id`);--> statement-breakpoint
CREATE INDEX `renewal_acceptances_user_created_idx` ON `renewal_acceptances` (`user_id`,`created_at`);--> statement-breakpoint
DROP INDEX `activity_allocations_target_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `activity_allocations_activity_credential_unique` ON `activity_allocations` (`activity_id`,`credential_id`);