ALTER TABLE `activities` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `activities` ADD `archived_at` text;--> statement-breakpoint
CREATE INDEX `activities_user_archive_date_idx` ON `activities` (`user_id`,`archived_at`,`completion_date`);--> statement-breakpoint
ALTER TABLE `checklist_tasks` ADD `is_personal` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `checklist_tasks` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `checklist_tasks` ADD `archived_at` text;--> statement-breakpoint
CREATE INDEX `checklist_tasks_user_credential_archive_idx` ON `checklist_tasks` (`user_id`,`credential_id`,`archived_at`,`sort_order`);