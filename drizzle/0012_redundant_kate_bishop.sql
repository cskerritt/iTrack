CREATE TABLE `apns_delivery_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`reminder_key` text NOT NULL,
	`scheduled_for` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_id`) REFERENCES `apns_devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apns_ledger_device_reminder_unique` ON `apns_delivery_ledger` (`device_id`,`reminder_key`,`scheduled_for`);--> statement-breakpoint
CREATE TABLE `apns_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_token` text NOT NULL,
	`environment` text DEFAULT 'production' NOT NULL,
	`device_label` text,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_seen_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_success_at` text,
	`last_failure_at` text,
	`disabled_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apns_devices_token_unique` ON `apns_devices` (`device_token`);--> statement-breakpoint
CREATE INDEX `apns_devices_user_active_idx` ON `apns_devices` (`user_id`,`disabled_at`,`updated_at`);