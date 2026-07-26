CREATE TABLE `evidence_files` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`activity_id` text NOT NULL,
	`object_key` text NOT NULL,
	`original_filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_etag` text,
	`status` text DEFAULT 'ready' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_files_object_key_unique` ON `evidence_files` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_files_activity_hash_unique` ON `evidence_files` (`user_id`,`activity_id`,`sha256`);--> statement-breakpoint
CREATE INDEX `evidence_files_user_created_idx` ON `evidence_files` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `evidence_files_activity_created_idx` ON `evidence_files` (`activity_id`,`created_at`);