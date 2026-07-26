CREATE TABLE `push_delivery_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`reminder_key` text NOT NULL,
	`scheduled_for` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`http_status` integer,
	`error_code` text,
	`delivered_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscription_id`) REFERENCES `push_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_delivery_ledger_occurrence_unique` ON `push_delivery_ledger` (`subscription_id`,`reminder_key`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `push_delivery_ledger_retry_idx` ON `push_delivery_ledger` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `push_delivery_ledger_user_created_idx` ON `push_delivery_ledger` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`expiration_time` integer,
	`device_label` text,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_success_at` text,
	`last_failure_at` text,
	`last_test_at` text,
	`disabled_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_active_idx` ON `push_subscriptions` (`user_id`,`disabled_at`,`updated_at`);--> statement-breakpoint
ALTER TABLE `reminder_preferences` ADD `push_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `reminder_preferences` ADD `push_hour_local` integer DEFAULT 9 NOT NULL;