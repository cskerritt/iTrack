CREATE TABLE `weekly_quest_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`week_start` text NOT NULL,
	`quest_key` text NOT NULL,
	`progress_at_claim` integer NOT NULL,
	`target` integer NOT NULL,
	`xp_reward` integer NOT NULL,
	`claimed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `weekly_quest_claims_user_week_quest_unique` ON `weekly_quest_claims` (`user_id`,`week_start`,`quest_key`);--> statement-breakpoint
CREATE INDEX `weekly_quest_claims_user_week_idx` ON `weekly_quest_claims` (`user_id`,`week_start`);