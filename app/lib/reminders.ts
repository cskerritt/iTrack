const DEFAULT_LEAD_DAYS = [90, 30, 7, 1] as const;
const ALLOWED_LEAD_DAYS = new Set<number>(DEFAULT_LEAD_DAYS);
const COMPLIANCE_PERIOD_RULE_SET_PREFIXES = [
  "fl-insurance-producer-",
  "ny-professional-classroom-teacher-",
  "ny-professional-esol-bilingual-",
  "nj-employed-teacher-annual-pd-",
  "pa-professional-educator-act-48-",
] as const;

export type ReminderChannel = "in_app" | "push" | "resolve";

export type Reminder = {
  key: string;
  credentialId: string;
  credentialName: string;
  kind: "task" | "deadline" | "acceptance";
  title: string;
  body: string;
  scheduledFor: string;
  eventDate: string;
  urgency: "overdue" | "today" | "soon";
};

export type ReminderPreferenceData = {
  inAppEnabled: boolean;
  pushEnabled: boolean;
  pushHourLocal: number;
  leadDays: number[];
  timeZone: string;
  activePushDeviceCount: number;
};

type PreferenceRow = {
  inAppEnabled: number;
  pushEnabled: number;
  pushHourLocal: number;
  leadDays: string;
  timeZone: string;
};

type TaskCandidate = {
  taskId: string;
  credentialId: string;
  credentialName: string;
  title: string;
  dueDate: string;
};

type CycleCandidate = {
  credentialId: string;
  ruleSetId: string | null;
  credentialName: string;
  status: string;
  deadline: string;
  submittedAt: string | null;
};

type ReminderStateRow = {
  reminderKey: string;
  status: string;
  snoozedUntil: string | null;
};

function query(
  database: D1Database,
  sql: string,
  bindings: readonly unknown[] = [],
) {
  return database.prepare(sql).bind(...bindings);
}

function daysBefore(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function daysAfter(isoDate: string, days: number) {
  return daysBefore(isoDate, -days);
}

function parsedLeadDays(value: string | null | undefined) {
  if (!value) return [...DEFAULT_LEAD_DAYS];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [...DEFAULT_LEAD_DAYS];
    const normalized = parsed.filter(
      (day): day is number =>
        typeof day === "number" &&
        Number.isInteger(day) &&
        ALLOWED_LEAD_DAYS.has(day),
    );
    if (normalized.length !== parsed.length) return [...DEFAULT_LEAD_DAYS];
    return [...new Set(normalized)].sort((a, b) => b - a);
  } catch {
    return [...DEFAULT_LEAD_DAYS];
  }
}

export function validReminderTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function localReminderClock(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour")),
  };
}

function reminderActivationDate(
  dueDate: string,
  leadDays: number[],
  today: string,
) {
  return (
    leadDays
      .map((leadDay) => daysBefore(dueDate, leadDay))
      .filter((scheduledFor) => scheduledFor <= today)
      .sort()
      .at(-1) ?? null
  );
}

function reminderUrgency(
  comparisonDate: string,
  today: string,
): "overdue" | "today" | "soon" {
  if (comparisonDate < today) return "overdue";
  if (comparisonDate === today) return "today";
  return "soon";
}

function reminderDateLabel(isoDate: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T12:00:00.000Z`));
}

function isCompliancePeriodRuleSet(ruleSetId: string | null) {
  return Boolean(
    ruleSetId &&
      COMPLIANCE_PERIOD_RULE_SET_PREFIXES.some((prefix) =>
        ruleSetId.startsWith(prefix),
      ),
  );
}

function isIsc2AutomaticRenewalRuleSet(ruleSetId: string | null) {
  return ruleSetId?.startsWith("isc2-") ?? false;
}

export async function loadReminderData(
  database: D1Database,
  userId: string,
  options: {
    channel?: ReminderChannel;
    now?: Date;
  } = {},
): Promise<{
  reminderPreferences: ReminderPreferenceData;
  reminders: Reminder[];
}> {
  const channel = options.channel ?? "in_app";
  const now = options.now ?? new Date();
  const [preference, activeDeviceCount] = await Promise.all([
    query(
      database,
      `SELECT
        in_app_enabled AS inAppEnabled,
        push_enabled AS pushEnabled,
        push_hour_local AS pushHourLocal,
        lead_days AS leadDays,
        time_zone AS timeZone
      FROM reminder_preferences
      WHERE user_id = ?`,
      [userId],
    ).first<PreferenceRow>(),
    query(
      database,
      `SELECT COUNT(*) AS count
       FROM push_subscriptions
       WHERE user_id = ?
         AND disabled_at IS NULL
         AND (
           expiration_time IS NULL
           OR expiration_time > ?
         )`,
      [userId, now.getTime()],
    ).first<{ count: number }>(),
  ]);

  const timeZone =
    preference?.timeZone && validReminderTimeZone(preference.timeZone)
      ? preference.timeZone
      : "UTC";
  const pushHourLocal =
    Number.isInteger(preference?.pushHourLocal) &&
    Number(preference?.pushHourLocal) >= 0 &&
    Number(preference?.pushHourLocal) <= 23
      ? Number(preference?.pushHourLocal)
      : 9;
  const reminderPreferences: ReminderPreferenceData = {
    inAppEnabled: Boolean(preference?.inAppEnabled ?? 1),
    pushEnabled: Boolean(preference?.pushEnabled ?? 0),
    pushHourLocal,
    leadDays: parsedLeadDays(preference?.leadDays),
    timeZone,
    activePushDeviceCount: Number(activeDeviceCount?.count ?? 0),
  };
  if (
    (channel === "in_app" && !reminderPreferences.inAppEnabled) ||
    (channel === "push" && !reminderPreferences.pushEnabled)
  ) {
    return { reminderPreferences, reminders: [] };
  }

  const [tasks, cycles, states] = await Promise.all([
    query(
      database,
      `SELECT
        task.id AS taskId,
        credential.id AS credentialId,
        credential.credential_name AS credentialName,
        task.title,
        task.due_date AS dueDate
      FROM checklist_tasks task
      JOIN credentials credential ON credential.id = task.credential_id
      WHERE task.user_id = ?
        AND credential.user_id = task.user_id
        AND credential.status <> 'renewed'
        AND task.archived_at IS NULL
        AND task.status <> 'completed'
        AND task.kind <> 'submission'
        AND task.due_date IS NOT NULL`,
      [userId],
    ).all<TaskCandidate>(),
    query(
      database,
      `SELECT
        credential.id AS credentialId,
        credential.rule_set_id AS ruleSetId,
        credential.credential_name AS credentialName,
        credential.status,
        credential.deadline,
        submission.submitted_at AS submittedAt
      FROM credentials credential
      LEFT JOIN renewal_submissions submission
        ON submission.credential_id = credential.id
        AND submission.user_id = credential.user_id
      LEFT JOIN renewal_acceptances acceptance
        ON acceptance.credential_id = credential.id
        AND acceptance.user_id = credential.user_id
      WHERE credential.user_id = ?
        AND (
          credential.status = 'active'
          OR (
            credential.status = 'submitted'
            AND acceptance.id IS NULL
            AND submission.id IS NOT NULL
          )
        )`,
      [userId],
    ).all<CycleCandidate>(),
    query(
      database,
      `SELECT
        reminder_key AS reminderKey,
        status,
        snoozed_until AS snoozedUntil
      FROM reminder_states
      WHERE user_id = ?`,
      [userId],
    ).all<ReminderStateRow>(),
  ]);

  const today = localReminderClock(now, timeZone).date;
  const reminders: Reminder[] = [];

  for (const task of tasks.results) {
    const scheduledFor = reminderActivationDate(
      task.dueDate,
      reminderPreferences.leadDays,
      today,
    );
    if (!scheduledFor) continue;
    reminders.push({
      key: `task:${task.taskId}:${task.dueDate}`,
      credentialId: task.credentialId,
      credentialName: task.credentialName,
      kind: "task",
      title: task.title,
      body: `${task.credentialName} · due ${reminderDateLabel(task.dueDate)}.`,
      scheduledFor,
      eventDate: task.dueDate,
      urgency: reminderUrgency(task.dueDate, today),
    });
  }

  for (const cycle of cycles.results) {
    if (cycle.status === "active") {
      const isCompliancePeriod = isCompliancePeriodRuleSet(cycle.ruleSetId);
      const scheduledFor = reminderActivationDate(
        cycle.deadline,
        reminderPreferences.leadDays,
        today,
      );
      if (!scheduledFor) continue;
      reminders.push({
        key: `deadline:${cycle.credentialId}:${cycle.deadline}`,
        credentialId: cycle.credentialId,
        credentialName: cycle.credentialName,
        kind: "deadline",
        title: `${cycle.credentialName} ${
          isCompliancePeriod ? "compliance" : "renewal"
        } deadline`,
        body: `${
          isCompliancePeriod ? "Compliance" : "Renewal"
        } is due ${reminderDateLabel(cycle.deadline)}.`,
        scheduledFor,
        eventDate: cycle.deadline,
        urgency: reminderUrgency(cycle.deadline, today),
      });
      continue;
    }

    if (cycle.status === "submitted" && cycle.submittedAt) {
      const isIsc2Checkpoint = isIsc2AutomaticRenewalRuleSet(cycle.ruleSetId);
      const isComplianceCheckpoint = isCompliancePeriodRuleSet(
        cycle.ruleSetId,
      );
      const ordinaryFollowUp = daysAfter(cycle.submittedAt.slice(0, 10), 7);
      const scheduledFor =
        (isIsc2Checkpoint || isComplianceCheckpoint) &&
        ordinaryFollowUp < cycle.deadline
          ? cycle.deadline
          : ordinaryFollowUp;
      if (scheduledFor > today) continue;
      reminders.push({
        key: `acceptance:${cycle.credentialId}:${cycle.submittedAt.slice(
          0,
          10,
        )}`,
        credentialId: cycle.credentialId,
        credentialName: cycle.credentialName,
        kind: "acceptance",
        title: isIsc2Checkpoint
          ? "Check the ISC2 dashboard for renewal"
          : isComplianceCheckpoint
            ? "Check the official record for the next compliance period"
            : "Check renewal acceptance",
        body: isIsc2Checkpoint
          ? `${cycle.credentialName} had a requirements checkpoint saved ${reminderDateLabel(
              cycle.submittedAt.slice(0, 10),
            )}. Confirm renewal only after ISC2 displays the renewed certification dates.`
          : isComplianceCheckpoint
            ? `${cycle.credentialName} had compliance recorded ${reminderDateLabel(
                cycle.submittedAt.slice(0, 10),
              )}. Start the next period only after confirming its official dates.`
            : `${cycle.credentialName} was submitted ${reminderDateLabel(
                cycle.submittedAt.slice(0, 10),
              )}. Record acceptance when the issuer confirms it.`,
        scheduledFor,
        eventDate: scheduledFor,
        urgency: reminderUrgency(scheduledFor, today),
      });
    }
  }

  const statesByKey = new Map(
    states.results.map((state) => [state.reminderKey, state]),
  );
  const urgencyOrder = { overdue: 0, today: 1, soon: 2 };
  return {
    reminderPreferences,
    reminders: reminders
      .flatMap((reminder) => {
        const state = statesByKey.get(reminder.key);
        if (!state) return [reminder];
        if (state.status === "dismissed") return [];
        if (
          state.status === "snoozed" &&
          state.snoozedUntil &&
          state.snoozedUntil > today
        ) {
          return [];
        }
        if (
          state.status === "snoozed" &&
          state.snoozedUntil &&
          state.snoozedUntil > reminder.scheduledFor
        ) {
          return [{ ...reminder, scheduledFor: state.snoozedUntil }];
        }
        return [reminder];
      })
      .sort(
        (a, b) =>
          urgencyOrder[a.urgency] - urgencyOrder[b.urgency] ||
          a.scheduledFor.localeCompare(b.scheduledFor) ||
          a.title.localeCompare(b.title),
      ),
  };
}
