CREATE TABLE `weekly_progression_periods` (
	`user_id` text NOT NULL,
	`week_start` text NOT NULL,
	`weekly_goal` integer NOT NULL,
	`time_zone` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `weekly_progression_periods_user_week_unique` ON `weekly_progression_periods` (`user_id`,`week_start`);