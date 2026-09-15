ALTER TABLE `credentials` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `credentials` ADD `archived_at` text;--> statement-breakpoint
CREATE INDEX `credentials_user_archive_deadline_idx` ON `credentials` (`user_id`,`archived_at`,`deadline`);