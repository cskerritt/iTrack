CREATE TABLE `dental_checkpoint_states` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`requirement_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`completed_at` text,
	`evidence_note` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requirement_id`) REFERENCES `credential_requirements`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "dental_checkpoint_states_status_check" CHECK("dental_checkpoint_states"."status" IN ('pending', 'completed')),
	CONSTRAINT "dental_checkpoint_states_completion_shape_check" CHECK((
        (
          "dental_checkpoint_states"."status" = 'pending'
          AND "dental_checkpoint_states"."completed_at" IS NULL
        )
        OR (
          "dental_checkpoint_states"."status" = 'completed'
          AND "dental_checkpoint_states"."completed_at" IS NOT NULL
          AND "dental_checkpoint_states"."evidence_note" IS NOT NULL
          AND length(trim("dental_checkpoint_states"."evidence_note")) > 0
        )
      )),
	CONSTRAINT "dental_checkpoint_states_revision_check" CHECK("dental_checkpoint_states"."revision" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dental_checkpoint_states_scope_unique` ON `dental_checkpoint_states` (`user_id`,`credential_id`,`requirement_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dental_checkpoint_states_requirement_unique` ON `dental_checkpoint_states` (`requirement_id`);--> statement-breakpoint
CREATE INDEX `dental_checkpoint_states_credential_idx` ON `dental_checkpoint_states` (`user_id`,`credential_id`,`status`);--> statement-breakpoint
CREATE TRIGGER `dental_checkpoint_states_insert_guard_v1`
BEFORE INSERT ON `dental_checkpoint_states`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `credential_requirements` requirement
	JOIN `credentials` credential
		ON credential.id = requirement.credential_id
	WHERE requirement.id = NEW.requirement_id
		AND requirement.credential_id = NEW.credential_id
		AND credential.user_id = NEW.user_id
		AND credential.status IN ('active', 'submitted')
)
BEGIN
	SELECT RAISE(ABORT, 'dental_checkpoint_not_mutable');
END;--> statement-breakpoint
CREATE TRIGGER `dental_checkpoint_states_update_guard_v1`
BEFORE UPDATE OF status, completed_at, evidence_note, revision, updated_at
ON `dental_checkpoint_states`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1
	FROM `credential_requirements` requirement
	JOIN `credentials` credential
		ON credential.id = requirement.credential_id
	WHERE requirement.id = OLD.requirement_id
		AND requirement.credential_id = OLD.credential_id
		AND credential.user_id = OLD.user_id
		AND credential.status IN ('active', 'submitted')
)
BEGIN
	SELECT RAISE(ABORT, 'dental_checkpoint_not_mutable');
END;--> statement-breakpoint
CREATE TRIGGER `dental_checkpoint_states_identity_guard_v1`
BEFORE UPDATE OF id, user_id, credential_id, requirement_id, created_at
ON `dental_checkpoint_states`
FOR EACH ROW
BEGIN
	SELECT RAISE(ABORT, 'dental_checkpoint_identity_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `dental_checkpoint_credentials_scope_guard_v1`
BEFORE UPDATE OF user_id ON `credentials`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM `dental_checkpoint_states` checkpoint
	WHERE checkpoint.credential_id = OLD.id
)
BEGIN
	SELECT RAISE(ABORT, 'dental_checkpoint_scope_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `dental_checkpoint_requirements_scope_guard_v1`
BEFORE UPDATE OF credential_id ON `credential_requirements`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM `dental_checkpoint_states` checkpoint
	WHERE checkpoint.requirement_id = OLD.id
)
BEGIN
	SELECT RAISE(ABORT, 'dental_checkpoint_scope_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `dental_checkpoint_states_delete_guard_v1`
BEFORE DELETE ON `dental_checkpoint_states`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM `credential_requirements` requirement
	JOIN `credentials` credential
		ON credential.id = requirement.credential_id
	WHERE requirement.id = OLD.requirement_id
		AND requirement.credential_id = OLD.credential_id
		AND credential.user_id = OLD.user_id
		AND credential.status NOT IN ('active', 'submitted')
)
BEGIN
	SELECT RAISE(ABORT, 'dental_checkpoint_not_mutable');
END;--> statement-breakpoint
CREATE TRIGGER `dental_daily_unit_limit_allocation_insert_guard_v1`
BEFORE INSERT ON `activity_allocations`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM `activities` incoming_activity
	JOIN `credentials` incoming_credential
		ON incoming_credential.id = NEW.credential_id
		AND incoming_credential.user_id = incoming_activity.user_id
	JOIN (
		SELECT 'ca-dentist-2026-v1' AS rule_set_id, 8 AS maximum_units
		UNION ALL SELECT 'ca-dental-hygienist-2026-v1' AS rule_set_id, 8 AS maximum_units
	) daily_limit
		ON daily_limit.rule_set_id = incoming_credential.rule_set_id
	WHERE incoming_activity.id = NEW.activity_id
		AND incoming_activity.archived_at IS NULL
		AND (
			COALESCE((
				SELECT SUM(existing_allocation.allocated_units)
				FROM `activity_allocations` existing_allocation
				JOIN `activities` existing_activity
					ON existing_activity.id = existing_allocation.activity_id
					AND existing_activity.archived_at IS NULL
				WHERE existing_allocation.credential_id = NEW.credential_id
					AND existing_activity.completion_date =
						incoming_activity.completion_date
			), 0) + NEW.allocated_units
		) > daily_limit.maximum_units + 0.000001
)
BEGIN
	SELECT RAISE(ABORT, 'dental_daily_unit_limit_exceeded');
END;--> statement-breakpoint
CREATE TRIGGER `dental_daily_unit_limit_allocation_update_guard_v1`
BEFORE UPDATE OF allocated_units ON `activity_allocations`
FOR EACH ROW
WHEN EXISTS (
	SELECT 1
	FROM `activities` incoming_activity
	JOIN `credentials` incoming_credential
		ON incoming_credential.id = NEW.credential_id
		AND incoming_credential.user_id = incoming_activity.user_id
	JOIN (
		SELECT 'ca-dentist-2026-v1' AS rule_set_id, 8 AS maximum_units
		UNION ALL SELECT 'ca-dental-hygienist-2026-v1' AS rule_set_id, 8 AS maximum_units
	) daily_limit
		ON daily_limit.rule_set_id = incoming_credential.rule_set_id
	WHERE incoming_activity.id = NEW.activity_id
		AND incoming_activity.archived_at IS NULL
		AND (
			COALESCE((
				SELECT SUM(existing_allocation.allocated_units)
				FROM `activity_allocations` existing_allocation
				JOIN `activities` existing_activity
					ON existing_activity.id = existing_allocation.activity_id
					AND existing_activity.archived_at IS NULL
				WHERE existing_allocation.credential_id = NEW.credential_id
					AND existing_allocation.id <> OLD.id
					AND existing_activity.completion_date =
						incoming_activity.completion_date
			), 0) + NEW.allocated_units
		) > daily_limit.maximum_units + 0.000001
)
BEGIN
	SELECT RAISE(ABORT, 'dental_daily_unit_limit_exceeded');
END;--> statement-breakpoint
CREATE TRIGGER `dental_daily_unit_limit_activity_update_guard_v1`
BEFORE UPDATE OF completion_date, archived_at ON `activities`
FOR EACH ROW
WHEN NEW.archived_at IS NULL
	AND EXISTS (
		SELECT 1
		FROM `activity_allocations` moving_allocation
		JOIN `credentials` daily_credential
			ON daily_credential.id = moving_allocation.credential_id
			AND daily_credential.user_id = NEW.user_id
		JOIN (
			SELECT 'ca-dentist-2026-v1' AS rule_set_id, 8 AS maximum_units
			UNION ALL SELECT 'ca-dental-hygienist-2026-v1' AS rule_set_id, 8 AS maximum_units
		) daily_limit
			ON daily_limit.rule_set_id = daily_credential.rule_set_id
		WHERE moving_allocation.activity_id = OLD.id
			AND (
				COALESCE((
					SELECT SUM(existing_allocation.allocated_units)
					FROM `activity_allocations` existing_allocation
					JOIN `activities` existing_activity
						ON existing_activity.id = existing_allocation.activity_id
						AND existing_activity.archived_at IS NULL
					WHERE existing_allocation.credential_id =
						moving_allocation.credential_id
						AND existing_activity.id <> OLD.id
						AND existing_activity.completion_date = NEW.completion_date
				), 0) + moving_allocation.allocated_units
			) > daily_limit.maximum_units + 0.000001
	)
BEGIN
	SELECT RAISE(ABORT, 'dental_daily_unit_limit_exceeded');
END;
