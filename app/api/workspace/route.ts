import { getD1 } from "@/db";
import {
  type RequestIdentity,
  resolveRequestIdentity,
} from "@/db/identity";
import { ensureUser, initializeDatabase } from "@/db/runtime";

export const dynamic = "force-dynamic";

type JsonRecord = Record<string, unknown>;
type RequirementKind = "minimum" | "maximum" | "informational";
type RequirementRelation = "independent" | "nested" | "overlapping";
type RequirementApplicability = "always" | "conditional" | "optional";
type ApplicabilityStatus =
  | "applies"
  | "not_applicable"
  | "needs_confirmation";

const REQUIREMENT_KINDS = new Set<RequirementKind>([
  "minimum",
  "maximum",
  "informational",
]);
const REQUIREMENT_RELATIONS = new Set<RequirementRelation>([
  "independent",
  "nested",
  "overlapping",
]);
const REQUIREMENT_APPLICABILITIES = new Set<RequirementApplicability>([
  "always",
  "conditional",
  "optional",
]);
const APPLICABILITY_STATUSES = new Set<ApplicabilityStatus>([
  "applies",
  "not_applicable",
  "needs_confirmation",
]);

class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid_request",
  ) {
    super(message);
  }
}

function query(
  database: D1Database,
  sql: string,
  bindings: readonly unknown[] = [],
) {
  return database.prepare(sql).bind(...bindings);
}

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(data, { ...init, headers });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textField(
  payload: JsonRecord,
  key: string,
  options: { required?: boolean; max?: number } = {},
) {
  const value = payload[key];
  if (value === undefined || value === null) {
    if (options.required) throw new RequestError(`${key} is required`);
    return null;
  }
  if (typeof value !== "string") {
    throw new RequestError(`${key} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized && options.required) {
    throw new RequestError(`${key} is required`);
  }
  const max = options.max ?? 240;
  if (normalized.length > max) {
    throw new RequestError(`${key} must be ${max} characters or fewer`);
  }
  return normalized || null;
}

function positiveNumber(
  payload: JsonRecord,
  key: string,
  options: { required?: boolean; max?: number } = {},
) {
  const raw = payload[key];
  if (raw === undefined || raw === null || raw === "") {
    if (options.required) throw new RequestError(`${key} is required`);
    return null;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new RequestError(`${key} must be a positive number`);
  }
  const max = options.max ?? 10000;
  if (raw > max) throw new RequestError(`${key} must not exceed ${max}`);
  return Math.round(raw * 100) / 100;
}

function nonNegativeNumber(
  payload: JsonRecord,
  key: string,
  options: { required?: boolean; max?: number } = {},
) {
  const raw = payload[key];
  if (raw === undefined || raw === null || raw === "") {
    if (options.required) throw new RequestError(`${key} is required`);
    return null;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new RequestError(`${key} must be a non-negative number`);
  }
  const max = options.max ?? 10000;
  if (raw > max) throw new RequestError(`${key} must not exceed ${max}`);
  return Math.round(raw * 100) / 100;
}

function enumField<T extends string>(
  payload: JsonRecord,
  key: string,
  allowed: ReadonlySet<T>,
  fallback: T,
) {
  const value = textField(payload, key, { max: 40 });
  if (!value) return fallback;
  if (!allowed.has(value as T)) {
    throw new RequestError(
      `${key} must be one of ${[...allowed].join(", ")}`,
    );
  }
  return value as T;
}

function defaultApplicabilityStatus(
  applicability: RequirementApplicability,
): ApplicabilityStatus {
  return applicability === "conditional" ? "needs_confirmation" : "applies";
}

function normalizedApplicabilityStatus(
  applicability: RequirementApplicability,
  requested: unknown,
  fieldName: string,
) {
  const status =
    requested === undefined || requested === null || requested === ""
      ? defaultApplicabilityStatus(applicability)
      : requested;
  if (
    typeof status !== "string" ||
    !APPLICABILITY_STATUSES.has(status as ApplicabilityStatus)
  ) {
    throw new RequestError(
      `${fieldName} must be applies, not_applicable, or needs_confirmation`,
    );
  }
  if (applicability !== "conditional" && status !== "applies") {
    throw new RequestError(
      `${fieldName} must be applies for an always or optional rule`,
    );
  }
  return status as ApplicabilityStatus;
}

function requirementIdsField(payload: JsonRecord) {
  const raw = payload.requirementIds;
  if (raw === undefined) {
    const legacy = textField(payload, "requirementId", { max: 160 });
    return legacy ? [legacy] : [];
  }
  if (!Array.isArray(raw) || raw.length > 30) {
    throw new RequestError(
      "requirementIds must be an array of up to 30 requirement IDs",
    );
  }
  const ids = raw.map((value, index) => {
    if (typeof value !== "string") {
      throw new RequestError(`requirementIds[${index}] must be a string`);
    }
    const id = value.trim();
    if (!id || id.length > 160) {
      throw new RequestError(
        `requirementIds[${index}] must be 1 to 160 characters`,
      );
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) {
    throw new RequestError("requirementIds cannot contain duplicates");
  }
  return ids;
}

function isoDateField(payload: JsonRecord, key: string, required = true) {
  const value = textField(payload, key, { required, max: 10 });
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RequestError(`${key} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new RequestError(`${key} must be a valid calendar date`);
  }
  return value;
}

function rejectClientIdentity(payload: JsonRecord) {
  const forbidden = ["userId", "user_id", "ownerId", "owner_id"];
  if (forbidden.some((key) => key in payload)) {
    throw new RequestError(
      "User identity is derived from the authenticated request and cannot be supplied by the client.",
      400,
      "client_identity_forbidden",
    );
  }
}

function daysBefore(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function daysAfter(isoDate: string, days: number) {
  return daysBefore(isoDate, -days);
}

const DEFAULT_LEAD_DAYS = [90, 30, 7, 1] as const;
const ALLOWED_LEAD_DAYS = new Set<number>(DEFAULT_LEAD_DAYS);

function normalizeLeadDays(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new RequestError("leadDays must be an array");
  }
  const normalized = value.map((day) => {
    if (
      typeof day !== "number" ||
      !Number.isInteger(day) ||
      !ALLOWED_LEAD_DAYS.has(day)
    ) {
      throw new RequestError("leadDays may contain only 90, 30, 7, and 1");
    }
    return day;
  });
  return [...new Set(normalized)].sort((a, b) => b - a);
}

function parsedLeadDays(value: string | null | undefined) {
  if (!value) return [...DEFAULT_LEAD_DAYS];
  try {
    return normalizeLeadDays(JSON.parse(value));
  } catch {
    return [...DEFAULT_LEAD_DAYS];
  }
}

function validTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function todayInTimeZone(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const PROGRESSION_ACTION_TYPES = [
  "credential_created",
  "activity_logged",
  "evidence_attached",
  "requirement_confirmed",
  "task_completed",
  "renewal_submitted",
  "renewal_accepted",
] as const;

type ProgressionActionType = (typeof PROGRESSION_ACTION_TYPES)[number];

type ProgressionActionRow = {
  id: string;
  eventType: ProgressionActionType;
  relatedType: string | null;
  relatedId: string | null;
  createdAt: string;
};

type WeeklyQuestClaimRow = {
  id: string;
  weekStart: string;
  questKey: string;
  progressAtClaim: number;
  target: number;
  xpReward: number;
  claimedAt: string;
};

type ProgressionQuest = {
  key: string;
  title: string;
  description: string;
  target: number;
  progress: number;
  completed: boolean;
  claimed: boolean;
  claimable: boolean;
  rewardXp: number;
  claimedAt: string | null;
};

type ProgressionContext = {
  activeCredentials: number;
  submittedCredentials: number;
  pendingTasks: number;
  pendingConditions: number;
  missingEvidence: number;
};

type ProgressionData = {
  lifetimeXp: number;
  weeklyGoal: number;
  weekActions: number;
  level: {
    number: number;
    title: string;
    floorXp: number;
    nextLevelXp: number;
    progressPercent: number;
  };
  week: {
    startsOn: string;
    endsOn: string;
    timeZone: string;
  };
  momentum: {
    activeWeeks: number;
    activeThisWeek: boolean;
    status: "active_this_week" | "grace_week" | "ready_to_start";
    graceUsed: boolean;
    graceAvailable: boolean;
    lastActiveWeekStart: string | null;
  };
  quests: ProgressionQuest[];
};

function dateInTimeZone(value: string, timeZone: string) {
  const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? `${value}T12:00:00.000Z`
      : value;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function weekStartForDate(isoDate: string) {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

function progressionLevel(lifetimeXp: number) {
  const number = Math.floor(Math.sqrt(lifetimeXp / 100)) + 1;
  const floorXp = (number - 1) ** 2 * 100;
  const nextLevelXp = number ** 2 * 100;
  const progressPercent = Math.min(
    100,
    Math.max(
      0,
      Math.round(
        ((lifetimeXp - floorXp) / (nextLevelXp - floorXp)) * 100,
      ),
    ),
  );
  const title =
    number >= 12
      ? "Master record keeper"
      : number >= 8
        ? "Seasoned record keeper"
        : number >= 5
          ? "Steady record keeper"
          : number >= 3
            ? "Building rhythm"
            : "Getting organized";
  return { number, title, floorXp, nextLevelXp, progressPercent };
}

function weeklyQuests(
  weeklyGoal: number,
  currentActions: ProgressionActionRow[],
  currentClaims: WeeklyQuestClaimRow[],
  context: ProgressionContext,
): ProgressionQuest[] {
  const claimsByKey = new Map(
    currentClaims.map((claim) => [claim.questKey, claim]),
  );
  const progressFor = (...eventTypes: ProgressionActionType[]) =>
    currentActions.filter((action) => eventTypes.includes(action.eventType))
      .length;
  const hasOpenWork =
    context.activeCredentials > 0 ||
    context.submittedCredentials > 0 ||
    context.pendingTasks > 0 ||
    context.pendingConditions > 0 ||
    context.missingEvidence > 0;
  const specs = [
    {
      key: "compliance-momentum",
      title: "Move compliance forward",
      description: `Complete ${weeklyGoal} meaningful compliance actions this week.`,
      target: weeklyGoal,
      progress: currentActions.length,
      rewardXp: 75,
      available: hasOpenWork,
    },
    {
      key: "acceptance-recorded",
      title: "Close the renewal loop",
      description: "Record an issuer’s acceptance for one submitted renewal.",
      target: 1,
      progress: progressFor("renewal_accepted"),
      rewardXp: 60,
      available: context.submittedCredentials > 0,
    },
    {
      key: "rule-confirmed",
      title: "Resolve a rule condition",
      description: "Confirm whether one conditional requirement applies.",
      target: 1,
      progress: progressFor("requirement_confirmed"),
      rewardXp: 20,
      available: context.pendingConditions > 0,
    },
    {
      key: "evidence-secured",
      title: "Protect one learning record",
      description: "Attach audit-ready proof to an activity that needs it.",
      target: 1,
      progress: progressFor("evidence_attached"),
      rewardXp: 40,
      available: context.missingEvidence > 0,
    },
    {
      key: "learning-logged",
      title: "Log a learning win",
      description: "Record one completed course or professional learning activity.",
      target: 1,
      progress: progressFor("activity_logged"),
      rewardXp: 40,
      available: context.activeCredentials > 0,
    },
    {
      key: "checklist-progress",
      title: "Clear one next step",
      description: "Complete one renewal checklist item.",
      target: 1,
      progress: progressFor("task_completed"),
      rewardXp: 30,
      available: context.pendingTasks > 0,
    },
  ];
  return specs
    .map((spec) => {
      const claim = claimsByKey.get(spec.key);
      const completed = spec.progress >= spec.target;
      return {
        key: spec.key,
        title: spec.title,
        description: spec.description,
        target: spec.target,
        progress: spec.progress,
        rewardXp: spec.rewardXp,
        completed,
        claimed: Boolean(claim),
        claimable: completed && !claim,
        claimedAt: claim?.claimedAt ?? null,
        available: spec.available,
      };
    })
    .filter(
      (quest) =>
        quest.available ||
        quest.progress > 0 ||
        quest.claimed ||
        quest.claimable,
    )
    .map((quest) => ({
      key: quest.key,
      title: quest.title,
      description: quest.description,
      target: quest.target,
      progress: quest.progress,
      rewardXp: quest.rewardXp,
      completed: quest.completed,
      claimed: quest.claimed,
      claimable: quest.claimable,
      claimedAt: quest.claimedAt,
    }));
}

function momentumForWeeks(activeWeekStarts: Set<string>, currentWeekStart: string) {
  let cursor = currentWeekStart;
  let activeWeeks = 0;
  let graceUsed = false;
  for (let index = 0; index < 5200; index += 1) {
    if (activeWeekStarts.has(cursor)) {
      activeWeeks += 1;
      cursor = daysBefore(cursor, 7);
      continue;
    }
    const weekBeforeGap = daysBefore(cursor, 7);
    if (!graceUsed && activeWeekStarts.has(weekBeforeGap)) {
      graceUsed = true;
      cursor = weekBeforeGap;
      continue;
    }
    break;
  }
  const activeThisWeek = activeWeekStarts.has(currentWeekStart);
  const lastActiveWeekStart =
    [...activeWeekStarts].sort((left, right) => right.localeCompare(left))[0] ??
    null;
  return {
    activeWeeks,
    activeThisWeek,
    status: activeThisWeek
      ? ("active_this_week" as const)
      : activeWeeks > 0
        ? ("grace_week" as const)
        : ("ready_to_start" as const),
    graceUsed: activeWeeks > 0 && graceUsed,
    graceAvailable: activeWeeks > 0 && !graceUsed,
    lastActiveWeekStart,
  };
}

async function getProgressionData(
  database: D1Database,
  identity: RequestIdentity,
): Promise<ProgressionData> {
  const [profile, actions, claims, preference, context] = await Promise.all([
    query(
      database,
      `SELECT
        p.weekly_goal AS weeklyGoal,
        COALESCE(
          (SELECT SUM(points) FROM xp_events WHERE user_id = p.user_id),
          0
        ) AS lifetimeXp
      FROM profiles p
      WHERE p.user_id = ?`,
      [identity.userId],
    ).first<{ weeklyGoal: number; lifetimeXp: number }>(),
    query(
      database,
      `SELECT
        id,
        event_type AS eventType,
        related_type AS relatedType,
        related_id AS relatedId,
        created_at AS createdAt
      FROM xp_events
      WHERE user_id = ?
        AND event_type IN (${PROGRESSION_ACTION_TYPES.map(() => "?").join(", ")})
      ORDER BY created_at DESC`,
      [identity.userId, ...PROGRESSION_ACTION_TYPES],
    ).all<ProgressionActionRow>(),
    query(
      database,
      `SELECT
        id,
        week_start AS weekStart,
        quest_key AS questKey,
        progress_at_claim AS progressAtClaim,
        target,
        xp_reward AS xpReward,
        claimed_at AS claimedAt
      FROM weekly_quest_claims
      WHERE user_id = ?
      ORDER BY week_start DESC, claimed_at DESC`,
      [identity.userId],
    ).all<WeeklyQuestClaimRow>(),
    query(
      database,
      `SELECT time_zone AS timeZone
       FROM reminder_preferences
       WHERE user_id = ?`,
      [identity.userId],
    ).first<{ timeZone: string }>(),
    query(
      database,
      `SELECT
        (
          SELECT COUNT(*)
          FROM credentials credential
          WHERE credential.user_id = user.id
            AND credential.status = 'active'
        ) AS activeCredentials,
        (
          SELECT COUNT(*)
          FROM credentials credential
          WHERE credential.user_id = user.id
            AND credential.status = 'submitted'
        ) AS submittedCredentials,
        (
          SELECT COUNT(*)
          FROM checklist_tasks task
          JOIN credentials credential
            ON credential.id = task.credential_id
            AND credential.user_id = task.user_id
          WHERE task.user_id = user.id
            AND task.status = 'pending'
            AND credential.status <> 'renewed'
        ) AS pendingTasks,
        (
          SELECT COUNT(*)
          FROM credential_requirements requirement
          JOIN credentials credential
            ON credential.id = requirement.credential_id
          WHERE credential.user_id = user.id
            AND credential.status = 'active'
            AND requirement.applicability_status = 'needs_confirmation'
        ) AS pendingConditions,
        (
          SELECT COUNT(*)
          FROM activities activity
          WHERE activity.user_id = user.id
            AND activity.evidence_status = 'missing'
            AND EXISTS (
              SELECT 1
              FROM activity_allocations allocation
              JOIN credentials credential
                ON credential.id = allocation.credential_id
              WHERE allocation.activity_id = activity.id
                AND credential.user_id = user.id
                AND credential.status <> 'renewed'
            )
        ) AS missingEvidence
      FROM users user
      WHERE user.id = ?`,
      [identity.userId],
    ).first<ProgressionContext>(),
  ]);

  const timeZone =
    preference?.timeZone && validTimeZone(preference.timeZone)
      ? preference.timeZone
      : "UTC";
  const weeklyGoal = Math.min(
    20,
    Math.max(1, Number(profile?.weeklyGoal ?? 4)),
  );
  const lifetimeXp = Math.max(0, Number(profile?.lifetimeXp ?? 0));
  const currentWeekStart = weekStartForDate(todayInTimeZone(timeZone));
  const currentActionsByKey = new Map<string, ProgressionActionRow>();
  for (const action of actions.results) {
    if (
      weekStartForDate(dateInTimeZone(action.createdAt, timeZone)) !==
      currentWeekStart
    ) {
      continue;
    }
    const stableActionKey =
      action.relatedType && action.relatedId
        ? `${action.eventType}:${action.relatedType}:${action.relatedId}`
        : action.id;
    currentActionsByKey.set(stableActionKey, action);
  }
  const currentActions = [...currentActionsByKey.values()];
  const currentClaims = claims.results.filter(
    (claim) => claim.weekStart === currentWeekStart,
  );
  const activeWeekStarts = new Set(
    actions.results.map((action) =>
      weekStartForDate(dateInTimeZone(action.createdAt, timeZone)),
    ),
  );
  const progressionContext: ProgressionContext = {
    activeCredentials: Number(context?.activeCredentials ?? 0),
    submittedCredentials: Number(context?.submittedCredentials ?? 0),
    pendingTasks: Number(context?.pendingTasks ?? 0),
    pendingConditions: Number(context?.pendingConditions ?? 0),
    missingEvidence: Number(context?.missingEvidence ?? 0),
  };

  return {
    lifetimeXp,
    weeklyGoal,
    weekActions: currentActions.length,
    level: progressionLevel(lifetimeXp),
    week: {
      startsOn: currentWeekStart,
      endsOn: daysAfter(currentWeekStart, 6),
      timeZone,
    },
    momentum: momentumForWeeks(activeWeekStarts, currentWeekStart),
    quests: weeklyQuests(
      weeklyGoal,
      currentActions,
      currentClaims,
      progressionContext,
    ),
  };
}

function reminderActivationDate(
  dueDate: string,
  leadDays: number[],
  today: string,
) {
  return leadDays
    .map((leadDay) => daysBefore(dueDate, leadDay))
    .filter((scheduledFor) => scheduledFor <= today)
    .sort()
    .at(-1) ?? null;
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

async function getReminderData(
  database: D1Database,
  identity: RequestIdentity,
) {
  type PreferenceRow = {
    inAppEnabled: number;
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

  const [preference, tasks, cycles, states] = await Promise.all([
    query(
      database,
      `SELECT
        in_app_enabled AS inAppEnabled,
        lead_days AS leadDays,
        time_zone AS timeZone
      FROM reminder_preferences
      WHERE user_id = ?`,
      [identity.userId],
    ).first<PreferenceRow>(),
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
        AND task.status <> 'completed'
        AND task.kind <> 'submission'
        AND task.due_date IS NOT NULL`,
      [identity.userId],
    ).all<TaskCandidate>(),
    query(
      database,
      `SELECT
        credential.id AS credentialId,
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
      [identity.userId],
    ).all<CycleCandidate>(),
    query(
      database,
      `SELECT
        reminder_key AS reminderKey,
        status,
        snoozed_until AS snoozedUntil
      FROM reminder_states
      WHERE user_id = ?`,
      [identity.userId],
    ).all<ReminderStateRow>(),
  ]);

  const leadDays = parsedLeadDays(preference?.leadDays);
  const timeZone =
    preference?.timeZone && validTimeZone(preference.timeZone)
      ? preference.timeZone
      : "UTC";
  const reminderPreferences = {
    inAppEnabled: Boolean(preference?.inAppEnabled ?? 1),
    leadDays,
    timeZone,
  };
  if (!reminderPreferences.inAppEnabled) {
    return { reminderPreferences, reminders: [] };
  }

  const today = todayInTimeZone(timeZone);
  const reminders: Array<{
    key: string;
    credentialId: string;
    credentialName: string;
    kind: "task" | "deadline" | "acceptance";
    title: string;
    body: string;
    scheduledFor: string;
    eventDate: string;
    urgency: "overdue" | "today" | "soon";
  }> = [];

  for (const task of tasks.results) {
    const scheduledFor = reminderActivationDate(
      task.dueDate,
      leadDays,
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
      const scheduledFor = reminderActivationDate(
        cycle.deadline,
        leadDays,
        today,
      );
      if (!scheduledFor) continue;
      reminders.push({
        key: `deadline:${cycle.credentialId}:${cycle.deadline}`,
        credentialId: cycle.credentialId,
        credentialName: cycle.credentialName,
        kind: "deadline",
        title: `${cycle.credentialName} renewal deadline`,
        body: `Renewal is due ${reminderDateLabel(cycle.deadline)}.`,
        scheduledFor,
        eventDate: cycle.deadline,
        urgency: reminderUrgency(cycle.deadline, today),
      });
      continue;
    }

    if (cycle.status === "submitted" && cycle.submittedAt) {
      const scheduledFor = daysAfter(cycle.submittedAt.slice(0, 10), 7);
      if (scheduledFor > today) continue;
      reminders.push({
        key: `acceptance:${cycle.credentialId}:${cycle.submittedAt.slice(
          0,
          10,
        )}`,
        credentialId: cycle.credentialId,
        credentialName: cycle.credentialName,
        kind: "acceptance",
        title: "Check renewal acceptance",
        body: `${cycle.credentialName} was submitted ${reminderDateLabel(
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
      .filter((reminder) => {
        const state = statesByKey.get(reminder.key);
        if (!state) return true;
        if (state.status === "dismissed") return false;
        return !(
          state.status === "snoozed" &&
          state.snoozedUntil &&
          state.snoozedUntil > today
        );
      })
      .sort(
        (a, b) =>
          urgencyOrder[a.urgency] - urgencyOrder[b.urgency] ||
          a.scheduledFor.localeCompare(b.scheduledFor) ||
          a.title.localeCompare(b.title),
      ),
  };
}

function estimatedCycleMonths(cycleStart: string, deadline: string) {
  const start = new Date(`${cycleStart}T00:00:00.000Z`).getTime();
  const end = new Date(`${deadline}T00:00:00.000Z`).getTime();
  const averageMonthMs = (365.2425 / 12) * 86_400_000;
  return Math.max(1, Math.round((end - start) / averageMonthMs));
}

async function validateRequirementTags(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
  requirementIds: string[],
) {
  if (requirementIds.length === 0) return [];
  type RequirementTagRow = {
    id: string;
    name: string;
    isActive: number;
    applicabilityStatus: string;
    exclusiveGroup: string | null;
  };
  const placeholders = requirementIds.map(() => "?").join(", ");
  const result = await query(
    database,
    `SELECT
      requirement.id,
      requirement.name,
      requirement.is_active AS isActive,
      requirement.applicability_status AS applicabilityStatus,
      requirement.exclusive_group AS exclusiveGroup
    FROM credential_requirements requirement
    JOIN credentials credential
      ON credential.id = requirement.credential_id
    WHERE requirement.credential_id = ?
      AND credential.user_id = ?
      AND requirement.id IN (${placeholders})`,
    [credentialId, identity.userId, ...requirementIds],
  ).all<RequirementTagRow>();
  const byId = new Map(result.results.map((requirement) => [requirement.id, requirement]));
  for (const requirementId of requirementIds) {
    const requirement = byId.get(requirementId);
    if (!requirement) {
      throw new RequestError(
        "Requirement not found for this credential.",
        404,
        "requirement_not_found",
      );
    }
    if (
      !Boolean(requirement.isActive) ||
      requirement.applicabilityStatus !== "applies"
    ) {
      throw new RequestError(
        `${requirement.name} is not active for this renewal cycle.`,
        409,
        "requirement_inactive",
      );
    }
  }
  const selectedExclusiveGroups = new Map<string, string>();
  for (const requirementId of requirementIds) {
    const requirement = byId.get(requirementId)!;
    if (!requirement.exclusiveGroup) continue;
    const existingName = selectedExclusiveGroups.get(requirement.exclusiveGroup);
    if (existingName) {
      throw new RequestError(
        `${existingName} and ${requirement.name} are alternative activity types. Choose only one for this activity.`,
        409,
        "exclusive_requirement_conflict",
      );
    }
    selectedExclusiveGroups.set(
      requirement.exclusiveGroup,
      requirement.name,
    );
  }
  return requirementIds.map((requirementId) => byId.get(requirementId)!);
}

async function getWorkspace(
  database: D1Database,
  identity: RequestIdentity,
) {
  type CatalogRow = {
    id: string;
    profession: string;
    credentialName: string;
    jurisdiction: string;
    issuer: string;
    totalUnits: number;
    unitLabel: string;
    cycleMonths: number;
    sourceUrl: string;
    sourceTitle: string;
    effectiveDate: string | null;
    lastVerifiedAt: string | null;
    reviewStatus: string;
    version: number;
  };
  type CategoryRow = {
    id: string;
    ruleSetId: string;
    name: string;
    requiredUnits: number;
    kind: RequirementKind;
    relation: RequirementRelation;
    parentCategoryId: string | null;
    applicability: RequirementApplicability;
    conditionNote: string | null;
    exclusiveGroup: string | null;
  };
  type CredentialRow = {
    id: string;
    credentialName: string;
    profession: string;
    jurisdiction: string;
    issuer: string;
    deadline: string;
    cycleStart: string;
    totalRequired: number;
    unitLabel: string;
    cycleMonths: number;
    seriesId: string;
    previousCredentialId: string | null;
    status: string;
    submittedAt: string | null;
    confirmationNumber: string | null;
    submissionProof: string | null;
    acceptedAt: string | null;
    acceptanceReference: string | null;
    nextCredentialId: string | null;
    sourceUrl: string | null;
    sourceTitle: string | null;
    ruleReviewStatus: string;
    totalEarned: number;
  };
  type RequirementRow = {
    id: string;
    credentialId: string;
    name: string;
    requiredUnits: number;
    kind: RequirementKind;
    relation: RequirementRelation;
    parentRequirementId: string | null;
    applicability: RequirementApplicability;
    applicabilityStatus: ApplicabilityStatus;
    conditionNote: string | null;
    exclusiveGroup: string | null;
    isActive: number;
    rawEarned: number;
  };
  type RequirementProgress = Omit<
    RequirementRow,
    "isActive" | "rawEarned"
  > & {
    isActive: boolean;
    rawEarned: number;
    countableEarned: number;
    excessUnits: number;
    earnedUnits: number;
    remainingUnits: number | null;
    progressPercent: number | null;
  };
  type TaskRow = {
    id: string;
    credentialId: string;
    title: string;
    kind: string;
    status: string;
    dueDate: string | null;
  };
  type ActivityRow = {
    id: string;
    title: string;
    provider: string;
    completionDate: string;
    totalUnits: number;
    evidenceStatus: string;
    evidenceReference: string | null;
    evidenceCount: number;
    allocationId: string | null;
    credentialId: string | null;
    credentialName: string | null;
    requirementId: string | null;
    categoryName: string | null;
    allocatedUnits: number;
  };
  type ActivityMatchRow = {
    id: string;
    activityId: string;
    allocationId: string;
    credentialId: string;
    requirementId: string;
    categoryName: string;
    matchedUnits: number;
  };
  type BadgeRow = {
    id: string;
    name: string;
    description: string;
    icon: string;
    earnedAt: string | null;
  };

  const [
    catalogResult,
    categoryResult,
    credentialResult,
    requirementResult,
    taskResult,
    activityResult,
    activityMatchResult,
    progression,
    badgeResult,
  ] = await Promise.all([
    query(
      database,
      `SELECT
        id,
        profession,
        credential_name AS credentialName,
        jurisdiction,
        issuer,
        total_units AS totalUnits,
        unit_label AS unitLabel,
        cycle_months AS cycleMonths,
        source_url AS sourceUrl,
        source_title AS sourceTitle,
        effective_date AS effectiveDate,
        last_verified_at AS lastVerifiedAt,
        review_status AS reviewStatus,
        version
      FROM rule_sets
      WHERE is_current = 1
      ORDER BY profession, credential_name, jurisdiction`,
    ).all<CatalogRow>(),
    query(
      database,
      `SELECT
        id,
        rule_set_id AS ruleSetId,
        name,
        required_units AS requiredUnits,
        kind,
        relation,
        parent_category_id AS parentCategoryId,
        applicability,
        condition_note AS conditionNote,
        exclusive_group AS exclusiveGroup
      FROM rule_categories
      ORDER BY rule_set_id, sort_order, name`,
    ).all<CategoryRow>(),
    query(
      database,
      `SELECT
        c.id,
        c.credential_name AS credentialName,
        c.profession,
        c.jurisdiction,
        c.issuer,
        c.deadline,
        c.cycle_start AS cycleStart,
        c.total_required AS totalRequired,
        c.unit_label AS unitLabel,
        COALESCE(cycle.cycle_months, rs.cycle_months, 12) AS cycleMonths,
        COALESCE(cycle.series_id, c.id) AS seriesId,
        cycle.previous_credential_id AS previousCredentialId,
        c.status,
        rs.source_url AS sourceUrl,
        rs.source_title AS sourceTitle,
        COALESCE(rs.review_status, 'custom') AS ruleReviewStatus,
        sub.submitted_at AS submittedAt,
        sub.confirmation_number AS confirmationNumber,
        sub.proof_reference AS submissionProof,
        acceptance.accepted_at AS acceptedAt,
        acceptance.acceptance_reference AS acceptanceReference,
        acceptance.next_credential_id AS nextCredentialId,
        COALESCE(SUM(alloc.allocated_units), 0) AS totalEarned
      FROM credentials c
      LEFT JOIN rule_sets rs ON rs.id = c.rule_set_id
      LEFT JOIN credential_cycle_links cycle
        ON cycle.credential_id = c.id AND cycle.user_id = c.user_id
      LEFT JOIN renewal_submissions sub
        ON sub.credential_id = c.id AND sub.user_id = c.user_id
      LEFT JOIN renewal_acceptances acceptance
        ON acceptance.credential_id = c.id
        AND acceptance.user_id = c.user_id
      LEFT JOIN activity_allocations alloc ON alloc.credential_id = c.id
      WHERE c.user_id = ?
      GROUP BY c.id
      ORDER BY
        CASE c.status WHEN 'active' THEN 0 WHEN 'submitted' THEN 1 ELSE 2 END,
        c.deadline`,
      [identity.userId],
    ).all<CredentialRow>(),
    query(
      database,
      `SELECT
        req.id,
        req.credential_id AS credentialId,
        req.name,
        req.required_units AS requiredUnits,
        req.kind,
        req.relation,
        req.parent_requirement_id AS parentRequirementId,
        req.applicability,
        req.applicability_status AS applicabilityStatus,
        req.condition_note AS conditionNote,
        req.exclusive_group AS exclusiveGroup,
        req.is_active AS isActive,
        COALESCE(
          SUM(
            CASE
              WHEN activity.id IS NULL THEN 0
              ELSE MIN(
                match.matched_units,
                alloc.allocated_units,
                activity.total_units
              )
            END
          ),
          0
        ) AS rawEarned
      FROM credential_requirements req
      JOIN credentials c ON c.id = req.credential_id
      LEFT JOIN activity_requirement_matches match
        ON match.requirement_id = req.id
        AND match.user_id = c.user_id
      LEFT JOIN activity_allocations alloc
        ON alloc.id = match.allocation_id
        AND alloc.credential_id = req.credential_id
      LEFT JOIN activities activity
        ON activity.id = alloc.activity_id
        AND activity.user_id = c.user_id
      WHERE c.user_id = ?
      GROUP BY req.id
      ORDER BY req.credential_id, req.sort_order, req.name`,
      [identity.userId],
    ).all<RequirementRow>(),
    query(
      database,
      `SELECT
        id,
        credential_id AS credentialId,
        title,
        kind,
        status,
        due_date AS dueDate
      FROM checklist_tasks
      WHERE user_id = ?
      ORDER BY credential_id, sort_order, due_date`,
      [identity.userId],
    ).all<TaskRow>(),
    query(
      database,
      `SELECT
        a.id,
        a.title,
        a.provider,
        a.completion_date AS completionDate,
        a.total_units AS totalUnits,
        a.evidence_status AS evidenceStatus,
        a.evidence_reference AS evidenceReference,
        (
          SELECT COUNT(*)
          FROM evidence_files stored
          WHERE stored.activity_id = a.id
            AND stored.user_id = a.user_id
            AND stored.status = 'ready'
        ) AS evidenceCount,
        CASE WHEN c.id IS NULL THEN NULL ELSE alloc.id END AS allocationId,
        c.id AS credentialId,
        c.credential_name AS credentialName,
        req.id AS requirementId,
        req.name AS categoryName,
        CASE
          WHEN c.id IS NULL THEN 0
          ELSE COALESCE(alloc.allocated_units, 0)
        END AS allocatedUnits
      FROM activities a
      LEFT JOIN activity_allocations alloc ON alloc.activity_id = a.id
      LEFT JOIN credentials c
        ON c.id = alloc.credential_id AND c.user_id = a.user_id
      LEFT JOIN credential_requirements req
        ON req.id = alloc.requirement_id AND req.credential_id = c.id
      WHERE a.user_id = ?
      ORDER BY a.completion_date DESC, a.created_at DESC`,
      [identity.userId],
    ).all<ActivityRow>(),
    query(
      database,
      `SELECT
        match.id,
        allocation.activity_id AS activityId,
        match.allocation_id AS allocationId,
        allocation.credential_id AS credentialId,
        match.requirement_id AS requirementId,
        requirement.name AS categoryName,
        MIN(
          match.matched_units,
          allocation.allocated_units,
          activity.total_units
        ) AS matchedUnits
      FROM activity_requirement_matches match
      JOIN activity_allocations allocation
        ON allocation.id = match.allocation_id
      JOIN activities activity
        ON activity.id = allocation.activity_id
        AND activity.user_id = match.user_id
      JOIN credentials credential
        ON credential.id = allocation.credential_id
        AND credential.user_id = match.user_id
      JOIN credential_requirements requirement
        ON requirement.id = match.requirement_id
        AND requirement.credential_id = allocation.credential_id
      WHERE match.user_id = ?
      ORDER BY allocation.id, requirement.sort_order, requirement.name`,
      [identity.userId],
    ).all<ActivityMatchRow>(),
    getProgressionData(database, identity),
    query(
      database,
      `SELECT
        def.id,
        def.name,
        def.description,
        def.icon,
        event.created_at AS earnedAt
      FROM badge_definitions def
      LEFT JOIN badge_events event
        ON event.badge_id = def.id
        AND event.user_id = ?
      ORDER BY
        CASE WHEN event.created_at IS NULL THEN 1 ELSE 0 END,
        event.created_at DESC,
        def.name`,
      [identity.userId],
    ).all<BadgeRow>(),
  ]);

  const categoriesByRule = new Map<string, CategoryRow[]>();
  for (const category of categoryResult.results) {
    const existing = categoriesByRule.get(category.ruleSetId) ?? [];
    existing.push({
      ...category,
      requiredUnits: Number(category.requiredUnits),
    });
    categoriesByRule.set(category.ruleSetId, existing);
  }

  const requirementMetadataById = new Map(
    requirementResult.results.map((requirement) => [
      requirement.id,
      requirement,
    ]),
  );
  const unitsByRequirementAllocation = new Map<
    string,
    Map<string, number>
  >();
  const addMatchedUnits = (
    requirementId: string,
    allocationId: string,
    matchedUnits: number,
  ) => {
    const byAllocation =
      unitsByRequirementAllocation.get(requirementId) ?? new Map<string, number>();
    byAllocation.set(
      allocationId,
      Math.max(byAllocation.get(allocationId) ?? 0, matchedUnits),
    );
    unitsByRequirementAllocation.set(requirementId, byAllocation);
  };
  for (const match of activityMatchResult.results) {
    const directRequirement = requirementMetadataById.get(match.requirementId);
    if (
      !directRequirement ||
      directRequirement.credentialId !== match.credentialId
    ) {
      continue;
    }
    const matchedUnits = Number(match.matchedUnits);
    addMatchedUnits(directRequirement.id, match.allocationId, matchedUnits);
    let current = directRequirement;
    const visited = new Set<string>();
    while (
      current.relation === "nested" &&
      current.parentRequirementId &&
      !visited.has(current.id)
    ) {
      visited.add(current.id);
      const parent = requirementMetadataById.get(current.parentRequirementId);
      if (!parent || parent.credentialId !== current.credentialId) break;
      addMatchedUnits(parent.id, match.allocationId, matchedUnits);
      current = parent;
    }
  }

  const requirementsByCredential = new Map<string, RequirementProgress[]>();
  for (const requirement of requirementResult.results) {
    const existing =
      requirementsByCredential.get(requirement.credentialId) ?? [];
    const requiredUnits = Number(requirement.requiredUnits);
    const rolledUpAllocations = unitsByRequirementAllocation.get(
      requirement.id,
    );
    const rawEarned = rolledUpAllocations
      ? [...rolledUpAllocations.values()].reduce(
          (sum, matchedUnits) => sum + matchedUnits,
          0,
        )
      : Number(requirement.rawEarned);
    const isActive =
      Boolean(requirement.isActive) &&
      requirement.applicabilityStatus === "applies";
    const countableEarned = !isActive
      ? 0
      : requirement.kind === "maximum"
        ? Math.min(rawEarned, requiredUnits)
        : rawEarned;
    const excessUnits =
      isActive && requirement.kind === "maximum"
        ? Math.max(0, rawEarned - requiredUnits)
        : 0;
    const remainingUnits =
      isActive && requirement.kind === "minimum"
        ? Math.max(0, requiredUnits - countableEarned)
        : null;
    const progressPercent =
      isActive &&
      requirement.kind !== "informational" &&
      requiredUnits > 0
        ? Math.min(100, Math.round((countableEarned / requiredUnits) * 100))
        : null;
    existing.push({
      ...requirement,
      requiredUnits,
      isActive,
      rawEarned,
      countableEarned,
      excessUnits,
      earnedUnits: countableEarned,
      remainingUnits,
      progressPercent,
    });
    requirementsByCredential.set(requirement.credentialId, existing);
  }

  const maximumExcessByCredential = new Map<string, number>();
  for (const [credentialId, requirements] of requirementsByCredential) {
    const byId = new Map(
      requirements.map((requirement) => [requirement.id, requirement]),
    );
    const excessByGraph = new Map<string, number>();
    for (const requirement of requirements) {
      if (
        !requirement.isActive ||
        requirement.kind !== "maximum" ||
        requirement.excessUnits <= 0
      ) {
        continue;
      }
      let graphRoot = requirement.id;
      let current: RequirementProgress | undefined = requirement;
      const visited = new Set<string>();
      while (
        current &&
        current.parentRequirementId &&
        current.relation !== "independent" &&
        !visited.has(current.id)
      ) {
        visited.add(current.id);
        graphRoot = current.parentRequirementId;
        current = byId.get(current.parentRequirementId);
      }
      excessByGraph.set(
        graphRoot,
        Math.max(excessByGraph.get(graphRoot) ?? 0, requirement.excessUnits),
      );
    }
    maximumExcessByCredential.set(
      credentialId,
      [...excessByGraph.values()].reduce((sum, excess) => sum + excess, 0),
    );
  }

  const tasksByCredential = new Map<string, TaskRow[]>();
  for (const task of taskResult.results) {
    const existing = tasksByCredential.get(task.credentialId) ?? [];
    existing.push(task);
    tasksByCredential.set(task.credentialId, existing);
  }

  const matchesByAllocation = new Map<string, ActivityMatchRow[]>();
  for (const match of activityMatchResult.results) {
    const existing = matchesByAllocation.get(match.allocationId) ?? [];
    existing.push({
      ...match,
      matchedUnits: Number(match.matchedUnits),
    });
    matchesByAllocation.set(match.allocationId, existing);
  }

  const activitiesById = new Map<
    string,
    Omit<ActivityRow, "allocationId"> & {
      allocations: Array<{
        id: string;
        credentialId: string;
        credentialName: string;
        requirementId: string | null;
        categoryName: string | null;
        requirementIds: string[];
        categoryNames: string[];
        requirementMatches: Array<{
          id: string;
          requirementId: string;
          categoryName: string;
          matchedUnits: number;
        }>;
        allocatedUnits: number;
      }>;
    }
  >();
  for (const activity of activityResult.results) {
    const { allocationId, ...baseActivity } = activity;
    let grouped = activitiesById.get(activity.id);
    if (!grouped) {
      grouped = {
        ...baseActivity,
        totalUnits: Number(activity.totalUnits),
        allocatedUnits: Number(activity.allocatedUnits),
        evidenceCount: Number(activity.evidenceCount),
        allocations: [],
      };
      activitiesById.set(activity.id, grouped);
    }
    if (
      allocationId &&
      activity.credentialId &&
      activity.credentialName
    ) {
      const matches = matchesByAllocation.get(allocationId) ?? [];
      const firstMatch = matches[0];
      grouped.allocations.push({
        id: allocationId,
        credentialId: activity.credentialId,
        credentialName: activity.credentialName,
        requirementId: firstMatch?.requirementId ?? activity.requirementId,
        categoryName: firstMatch?.categoryName ?? activity.categoryName,
        requirementIds: matches.length
          ? matches.map((match) => match.requirementId)
          : activity.requirementId
            ? [activity.requirementId]
            : [],
        categoryNames: matches.length
          ? matches.map((match) => match.categoryName)
          : activity.categoryName
            ? [activity.categoryName]
            : [],
        requirementMatches: matches.map((match) => ({
          id: match.id,
          requirementId: match.requirementId,
          categoryName: match.categoryName,
          matchedUnits: match.matchedUnits,
        })),
        allocatedUnits: Number(activity.allocatedUnits),
      });
    }
  }

  const reminderData = await getReminderData(database, identity);

  return {
    user: {
      displayName: identity.displayName,
      email: identity.email,
      isDemo: identity.isDemo,
    },
    profile: {
      xp: progression.lifetimeXp,
      weekActions: progression.weekActions,
      weeklyGoal: progression.weeklyGoal,
      badges: badgeResult.results,
    },
    progression,
    catalog: catalogResult.results.map((rule) => ({
      ...rule,
      totalUnits: Number(rule.totalUnits),
      cycleMonths: Number(rule.cycleMonths),
      version: Number(rule.version),
      categories: categoriesByRule.get(rule.id) ?? [],
    })),
    credentials: credentialResult.results.map((credential) => {
      const totalRequired = Number(credential.totalRequired);
      const totalRawEarned = Number(credential.totalEarned);
      const totalExcessUnits = Math.min(
        totalRawEarned,
        maximumExcessByCredential.get(credential.id) ?? 0,
      );
      const totalEarned = Math.max(0, totalRawEarned - totalExcessUnits);
      return {
        ...credential,
        totalRequired,
        totalRawEarned,
        totalExcessUnits,
        totalEarned,
        totalRemaining: Math.max(0, totalRequired - totalEarned),
        totalProgressPercent:
          totalRequired > 0
            ? Math.min(100, Math.round((totalEarned / totalRequired) * 100))
            : 100,
        cycleMonths: Number(credential.cycleMonths),
        requirements: requirementsByCredential.get(credential.id) ?? [],
        tasks: tasksByCredential.get(credential.id) ?? [],
      };
    }),
    activities: [...activitiesById.values()],
    reminderPreferences: reminderData.reminderPreferences,
    reminders: reminderData.reminders,
  };
}

type CatalogRule = {
  id: string;
  credentialName: string;
  profession: string;
  jurisdiction: string;
  issuer: string;
  totalUnits: number;
  unitLabel: string;
  cycleMonths: number;
};

type CatalogCategory = {
  id: string;
  name: string;
  requiredUnits: number;
  kind: RequirementKind;
  relation: RequirementRelation;
  parentCategoryId: string | null;
  applicability: RequirementApplicability;
  conditionNote: string | null;
  exclusiveGroup: string | null;
};

type CredentialCategoryDraft = {
  key: string;
  ruleCategoryId: string | null;
  name: string;
  requiredUnits: number;
  kind: RequirementKind;
  relation: RequirementRelation;
  parentKey: string | null;
  applicability: RequirementApplicability;
  applicabilityStatus: ApplicabilityStatus;
  conditionNote: string | null;
  exclusiveGroup: string | null;
  isActive: boolean;
  sortOrder: number;
};

function applicabilityChoicesField(payload: JsonRecord) {
  const raw = payload.applicabilityChoices;
  if (raw === undefined) return new Map<string, ApplicabilityStatus>();
  if (!Array.isArray(raw) || raw.length > 50) {
    throw new RequestError(
      "applicabilityChoices must be an array of up to 50 choices",
    );
  }
  const choices = new Map<string, ApplicabilityStatus>();
  raw.forEach((value, index) => {
    if (!isRecord(value)) {
      throw new RequestError(
        `applicabilityChoices[${index}] must be an object`,
      );
    }
    const ruleCategoryId = textField(value, "ruleCategoryId", {
      required: true,
      max: 160,
    })!;
    const status = enumField(
      value,
      "status",
      APPLICABILITY_STATUSES,
      "needs_confirmation",
    );
    if (choices.has(ruleCategoryId)) {
      throw new RequestError(
        "applicabilityChoices cannot contain duplicate ruleCategoryId values",
      );
    }
    choices.set(ruleCategoryId, status);
  });
  return choices;
}

function orderedCategoryDrafts(categories: CredentialCategoryDraft[]) {
  const byKey = new Map(categories.map((category) => [category.key, category]));
  const ordered: CredentialCategoryDraft[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (category: CredentialCategoryDraft) => {
    if (visited.has(category.key)) return;
    if (visiting.has(category.key)) {
      throw new RequestError("Requirement parent relationships cannot cycle");
    }
    visiting.add(category.key);
    if (category.parentKey) {
      const parent = byKey.get(category.parentKey);
      if (!parent) {
        throw new RequestError(
          `${category.name} references an unknown parent requirement`,
        );
      }
      visit(parent);
    }
    visiting.delete(category.key);
    visited.add(category.key);
    ordered.push(category);
  };
  categories.forEach(visit);
  return ordered;
}

function validateActiveCategoryParents(categories: CredentialCategoryDraft[]) {
  const byKey = new Map(categories.map((category) => [category.key, category]));
  for (const category of categories) {
    if (
      category.isActive &&
      category.relation === "nested" &&
      category.parentKey &&
      !byKey.get(category.parentKey)?.isActive
    ) {
      throw new RequestError(
        `${category.name} cannot apply while its parent requirement is inactive.`,
        409,
        "inactive_parent_requirement",
      );
    }
  }
}

async function createCredential(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const ruleSetId = textField(payload, "ruleSetId", { max: 160 });
  const cycleStart = isoDateField(payload, "cycleStart")!;
  const deadline = isoDateField(payload, "deadline")!;
  if (cycleStart > deadline) {
    throw new RequestError("deadline must be on or after cycleStart");
  }

  let credentialName: string;
  let profession: string;
  let jurisdiction: string;
  let issuer: string;
  let totalRequired: number;
  let unitLabel: string;
  let cycleMonths: number;
  let categories: CredentialCategoryDraft[];

  if (ruleSetId) {
    const applicabilityChoices = applicabilityChoicesField(payload);
    const rule = await query(
      database,
      `SELECT
        id,
        credential_name AS credentialName,
        profession,
        jurisdiction,
        issuer,
        total_units AS totalUnits,
        unit_label AS unitLabel,
        cycle_months AS cycleMonths
      FROM rule_sets
      WHERE id = ? AND is_current = 1`,
      [ruleSetId],
    ).first<CatalogRule>();
    if (!rule) {
      throw new RequestError(
        "The selected rule set was not found or is no longer current.",
        404,
        "rule_set_not_found",
      );
    }
    if (
      ruleSetId === "cfp-professional-pre-2027-v1" &&
      cycleStart >= "2027-01-01"
    ) {
      throw new RequestError(
        "This CFP template is only for certification periods beginning before Q1 2027. Enter the newer 40-hour requirement as a custom plan while its carryover eligibility is confirmed.",
        409,
        "rule_transition_outside_template",
      );
    }
    const ruleCategories = await query(
      database,
      `SELECT
        id,
        name,
        required_units AS requiredUnits,
        kind,
        relation,
        parent_category_id AS parentCategoryId,
        applicability,
        condition_note AS conditionNote,
        exclusive_group AS exclusiveGroup
       FROM rule_categories
       WHERE rule_set_id = ?
       ORDER BY sort_order, name`,
      [ruleSetId],
    ).all<CatalogCategory>();
    credentialName = rule.credentialName;
    profession = rule.profession;
    jurisdiction = rule.jurisdiction;
    issuer = rule.issuer;
    totalRequired = Number(rule.totalUnits);
    unitLabel = rule.unitLabel;
    cycleMonths = Number(rule.cycleMonths);
    const knownCategoryIds = new Set(
      ruleCategories.results.map((category) => category.id),
    );
    for (const categoryId of applicabilityChoices.keys()) {
      if (!knownCategoryIds.has(categoryId)) {
        throw new RequestError(
          "An applicability choice does not belong to the selected rule set.",
          404,
          "rule_category_not_found",
        );
      }
    }
    categories = ruleCategories.results.map((category, index) => {
      const applicability = category.applicability;
      const applicabilityStatus = normalizedApplicabilityStatus(
        applicability,
        applicabilityChoices.get(category.id),
        `applicabilityChoices for ${category.name}`,
      );
      return {
        key: category.id,
        ruleCategoryId: category.id,
        name: category.name,
        requiredUnits: Number(category.requiredUnits),
        kind: category.kind,
        relation: category.relation,
        parentKey: category.parentCategoryId,
        applicability,
        applicabilityStatus,
        conditionNote: category.conditionNote,
        exclusiveGroup: category.exclusiveGroup,
        isActive: applicabilityStatus === "applies",
        sortOrder: index,
      };
    });
  } else {
    credentialName = textField(payload, "credentialName", {
      required: true,
      max: 180,
    })!;
    profession = textField(payload, "profession", {
      required: true,
      max: 120,
    })!;
    jurisdiction = textField(payload, "jurisdiction", {
      required: true,
      max: 120,
    })!;
    issuer =
      textField(payload, "issuer", { max: 180 }) ?? "Self-managed credential";
    totalRequired = positiveNumber(payload, "totalRequired", {
      required: true,
    })!;
    unitLabel = textField(payload, "unitLabel", {
      required: true,
      max: 40,
    })!;
    cycleMonths = estimatedCycleMonths(cycleStart, deadline);

    const rawCategories = payload.categories;
    if (
      rawCategories !== undefined &&
      (!Array.isArray(rawCategories) || rawCategories.length > 30)
    ) {
      throw new RequestError("categories must be an array of up to 30 items");
    }
    categories = (rawCategories ?? []).map((item, index) => {
      if (!isRecord(item)) {
        throw new RequestError(`categories[${index}] must be an object`);
      }
      const kind = enumField(
        item,
        "kind",
        REQUIREMENT_KINDS,
        "minimum",
      );
      const relation = enumField(
        item,
        "relation",
        REQUIREMENT_RELATIONS,
        "independent",
      );
      const applicability = enumField(
        item,
        "applicability",
        REQUIREMENT_APPLICABILITIES,
        "always",
      );
      const applicabilityStatus = normalizedApplicabilityStatus(
        applicability,
        item.applicabilityStatus,
        `categories[${index}].applicabilityStatus`,
      );
      const conditionNote = textField(item, "conditionNote", { max: 500 });
      const exclusiveGroup = textField(item, "exclusiveGroup", { max: 80 });
      if (applicability === "conditional" && !conditionNote) {
        throw new RequestError(
          `categories[${index}].conditionNote is required for a conditional rule`,
        );
      }
      const requiredUnits =
        kind === "informational"
          ? (nonNegativeNumber(item, "requiredUnits") ?? 0)
          : positiveNumber(item, "requiredUnits", { required: true })!;
      return {
        key:
          textField(item, "key", { max: 160 }) ??
          `custom-category-${index}`,
        ruleCategoryId: null,
        name: textField(item, "name", { required: true, max: 100 })!,
        requiredUnits,
        kind,
        relation,
        parentKey: textField(item, "parentKey", { max: 160 }),
        applicability,
        applicabilityStatus,
        conditionNote,
        exclusiveGroup,
        isActive: applicabilityStatus === "applies",
        sortOrder: index,
      };
    });
    if (categories.length === 0) {
      categories = [
        {
          key: "general",
          ruleCategoryId: null,
          name: "General",
          requiredUnits: totalRequired,
          kind: "minimum",
          relation: "independent",
          parentKey: null,
          applicability: "always",
          applicabilityStatus: "applies",
          conditionNote: null,
          exclusiveGroup: null,
          isActive: true,
          sortOrder: 0,
        },
      ];
    }
    if (new Set(categories.map((category) => category.key)).size !== categories.length) {
      throw new RequestError("Custom category keys must be unique");
    }
    orderedCategoryDrafts(categories);
    const categoryTotal = categories.reduce(
      (sum, category) =>
        category.isActive &&
        category.kind === "minimum" &&
        category.relation === "independent" &&
        !category.parentKey
          ? sum + category.requiredUnits
          : sum,
      0,
    );
    if (categoryTotal > totalRequired + 0.001) {
      throw new RequestError(
        "Category requirements cannot exceed the credential total.",
      );
    }
  }

  const orderedCategories = orderedCategoryDrafts(categories);
  validateActiveCategoryParents(categories);
  const requirementIdByKey = new Map(
    categories.map((category) => [category.key, crypto.randomUUID()]),
  );
  const credentialId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    query(
      database,
      `INSERT INTO credentials (
        id, user_id, rule_set_id, credential_name, profession, jurisdiction,
        issuer, cycle_start, deadline, total_required, unit_label, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        credentialId,
        identity.userId,
        ruleSetId,
        credentialName,
        profession,
        jurisdiction,
        issuer,
        cycleStart,
        deadline,
        totalRequired,
        unitLabel,
      ],
    ),
    query(
      database,
      `INSERT INTO credential_cycle_links (
        id, user_id, credential_id, series_id, previous_credential_id,
        cycle_months
      ) VALUES (?, ?, ?, ?, NULL, ?)`,
      [
        crypto.randomUUID(),
        identity.userId,
        credentialId,
        credentialId,
        cycleMonths,
      ],
    ),
  ];

  orderedCategories.forEach((category) => {
    statements.push(
      query(
        database,
        `INSERT INTO credential_requirements (
          id, credential_id, rule_category_id, name, required_units, kind,
          relation, parent_requirement_id, applicability,
          applicability_status, condition_note, exclusive_group, is_active,
          sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          requirementIdByKey.get(category.key),
          credentialId,
          category.ruleCategoryId,
          category.name,
          category.requiredUnits,
          category.kind,
          category.relation,
          category.parentKey
            ? requirementIdByKey.get(category.parentKey)
            : null,
          category.applicability,
          category.applicabilityStatus,
          category.conditionNote,
          category.exclusiveGroup,
          category.isActive ? 1 : 0,
          category.sortOrder,
        ],
      ),
    );
  });

  const taskSpecs = [
    {
      title: "Review the renewal requirements",
      kind: "review",
      dueDate: daysBefore(deadline, 120),
    },
    {
      title: "Complete and document required education",
      kind: "progress",
      dueDate: daysBefore(deadline, 30),
    },
    {
      title: "Submit renewal and save confirmation",
      kind: "submission",
      dueDate: deadline,
    },
  ];
  taskSpecs.forEach((task, index) => {
    statements.push(
      query(
        database,
        `INSERT INTO checklist_tasks (
          id, user_id, credential_id, title, kind, status, due_date, sort_order
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
          crypto.randomUUID(),
          identity.userId,
          credentialId,
          task.title,
          task.kind,
          task.dueDate,
          index,
        ],
      ),
    );
  });
  statements.push(
    query(
      database,
      `INSERT OR IGNORE INTO xp_events (
        id, user_id, idempotency_key, event_type, points, related_type, related_id
      ) VALUES (?, ?, ?, 'credential_created', 25, 'credential', ?)`,
      [
        crypto.randomUUID(),
        identity.userId,
        `${identity.userId}:credential:${credentialId}:created`,
        credentialId,
      ],
    ),
  );

  await database.batch(statements);
  return credentialId;
}

function normalizedEvidenceStatus(payload: JsonRecord) {
  const raw = textField(payload, "evidenceStatus", { max: 40 }) ?? "missing";
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, string> = {
    complete: "attached",
    certificate_saved: "attached",
    saved: "attached",
    on_file: "attached",
    uploaded: "attached",
    verified: "attached",
    waived: "not_required",
  };
  const status = aliases[normalized] ?? normalized;
  if (!["missing", "attached", "not_required"].includes(status)) {
    throw new RequestError(
      "evidenceStatus must be missing, attached, or not_required",
    );
  }
  return status;
}

async function addActivity(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const title = textField(payload, "title", { required: true, max: 180 })!;
  const provider = textField(payload, "provider", { max: 180 }) ?? "";
  const completionDate = isoDateField(payload, "completionDate")!;
  const totalUnits = positiveNumber(payload, "totalUnits", {
    required: true,
  })!;
  const allocatedUnits =
    positiveNumber(payload, "allocatedUnits") ?? totalUnits;
  if (allocatedUnits > totalUnits) {
    throw new RequestError("allocatedUnits cannot exceed totalUnits");
  }
  const credentialId = textField(payload, "credentialId", {
    required: true,
    max: 160,
  })!;
  const requirementIds = requirementIdsField(payload);
  const requirementId = requirementIds[0] ?? null;
  const evidenceStatus = normalizedEvidenceStatus(payload);
  const evidenceReference = textField(payload, "evidenceReference", {
    max: 500,
  });

  const credential = await query(
    database,
    `SELECT
      id,
      status,
      cycle_start AS cycleStart,
      deadline
     FROM credentials
     WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{
    id: string;
    status: string;
    cycleStart: string;
    deadline: string;
  }>();
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  if (credential.status === "renewed") {
    throw new RequestError(
      "This renewal cycle is closed and cannot receive activities.",
      409,
      "cycle_closed",
    );
  }
  if (
    completionDate < credential.cycleStart ||
    completionDate > credential.deadline
  ) {
    throw new RequestError(
      `The completion date must fall within this renewal cycle (${credential.cycleStart} through ${credential.deadline}).`,
      409,
      "activity_outside_cycle",
    );
  }

  await validateRequirementTags(
    database,
    identity,
    credentialId,
    requirementIds,
  );

  const activityId = crypto.randomUUID();
  const allocationId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    query(
      database,
      `INSERT INTO activities (
        id, user_id, title, provider, completion_date, total_units,
        evidence_status, evidence_reference
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        activityId,
        identity.userId,
        title,
        provider,
        completionDate,
        totalUnits,
        evidenceStatus,
        evidenceReference,
      ],
    ),
    query(
      database,
      `INSERT INTO activity_allocations (
        id, activity_id, credential_id, requirement_id, allocated_units
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        allocationId,
        activityId,
        credentialId,
        requirementId,
        allocatedUnits,
      ],
    ),
    query(
      database,
      `INSERT OR IGNORE INTO xp_events (
        id, user_id, idempotency_key, event_type, points, related_type, related_id
      ) VALUES (?, ?, ?, 'activity_logged', 50, 'activity', ?)`,
      [
        crypto.randomUUID(),
        identity.userId,
        `${identity.userId}:activity:${activityId}:logged`,
        activityId,
      ],
    ),
    query(
      database,
      `INSERT OR IGNORE INTO badge_events (
        id, user_id, badge_id, idempotency_key, related_type, related_id
      ) VALUES (?, ?, 'first-credit', ?, 'activity', ?)`,
      [
        crypto.randomUUID(),
        identity.userId,
        `${identity.userId}:badge:first-credit`,
        activityId,
      ],
    ),
  ];
  for (const matchedRequirementId of requirementIds) {
    statements.push(
      query(
        database,
        `INSERT INTO activity_requirement_matches (
          id, user_id, allocation_id, requirement_id, matched_units
        ) VALUES (?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          identity.userId,
          allocationId,
          matchedRequirementId,
          allocatedUnits,
        ],
      ),
    );
  }
  if (evidenceStatus === "attached") {
    statements.push(
      query(
        database,
        `INSERT OR IGNORE INTO badge_events (
          id, user_id, badge_id, idempotency_key, related_type, related_id
        ) VALUES (?, ?, 'proof-ready', ?, 'activity', ?)`,
        [
          crypto.randomUUID(),
          identity.userId,
          `${identity.userId}:badge:proof-ready`,
          activityId,
        ],
      ),
    );
  }

  await database.batch(statements);
  return activityId;
}

async function claimWeeklyQuest(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const questKey = textField(payload, "questKey", {
    required: true,
    max: 80,
  })!;
  const requestedWeekStart = isoDateField(payload, "weekStart", false);
  const progression = await getProgressionData(database, identity);
  if (
    requestedWeekStart &&
    requestedWeekStart !== progression.week.startsOn
  ) {
    throw new RequestError(
      "That quest week has ended. Refresh to see this week’s quests.",
      409,
      "quest_week_changed",
    );
  }
  const quest = progression.quests.find(
    (candidate) => candidate.key === questKey,
  );
  if (!quest) {
    throw new RequestError("Weekly quest not found.", 404, "quest_not_found");
  }

  const existing = await query(
    database,
    `SELECT id
     FROM weekly_quest_claims
     WHERE user_id = ? AND week_start = ? AND quest_key = ?`,
    [identity.userId, progression.week.startsOn, quest.key],
  ).first<{ id: string }>();
  if (existing) return existing.id;
  if (!quest.completed) {
    throw new RequestError(
      "Complete the quest before claiming its XP reward.",
      409,
      "quest_incomplete",
    );
  }

  const claimId = crypto.randomUUID();
  const rewardKey = `${identity.userId}:weekly-quest:${progression.week.startsOn}:${quest.key}`;
  await database.batch([
    query(
      database,
      `INSERT OR IGNORE INTO weekly_quest_claims (
        id, user_id, week_start, quest_key, progress_at_claim, target,
        xp_reward
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        claimId,
        identity.userId,
        progression.week.startsOn,
        quest.key,
        quest.progress,
        quest.target,
        quest.rewardXp,
      ],
    ),
    query(
      database,
      `INSERT OR IGNORE INTO xp_events (
        id, user_id, idempotency_key, event_type, points, related_type,
        related_id
      ) VALUES (?, ?, ?, 'weekly_quest_claimed', ?, 'weekly_quest', ?)`,
      [
        crypto.randomUUID(),
        identity.userId,
        rewardKey,
        quest.rewardXp,
        `${progression.week.startsOn}:${quest.key}`,
      ],
    ),
  ]);

  const saved = await query(
    database,
    `SELECT id
     FROM weekly_quest_claims
     WHERE user_id = ? AND week_start = ? AND quest_key = ?`,
    [identity.userId, progression.week.startsOn, quest.key],
  ).first<{ id: string }>();
  if (!saved) {
    throw new Error("Weekly quest claim was not saved");
  }
  return saved.id;
}

async function toggleTask(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const taskId = textField(payload, "taskId", {
    required: true,
    max: 160,
  })!;
  if (typeof payload.completed !== "boolean") {
    throw new RequestError("completed must be a boolean");
  }
  const completed = payload.completed;
  const task = await query(
    database,
    `SELECT task.id, credential.status AS credentialStatus
     FROM checklist_tasks task
     JOIN credentials credential ON credential.id = task.credential_id
     WHERE task.id = ?
       AND task.user_id = ?
       AND credential.user_id = task.user_id`,
    [taskId, identity.userId],
  ).first<{ id: string; credentialStatus: string }>();
  if (!task) {
    throw new RequestError("Task not found.", 404, "task_not_found");
  }
  if (task.credentialStatus === "renewed") {
    throw new RequestError(
      "This renewal cycle is closed and its checklist is frozen.",
      409,
      "cycle_closed",
    );
  }

  const statements: D1PreparedStatement[] = [
    query(
      database,
      `UPDATE checklist_tasks
       SET
         status = ?,
         completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [
        completed ? "completed" : "pending",
        completed ? 1 : 0,
        taskId,
        identity.userId,
      ],
    ),
  ];
  if (completed) {
    statements.push(
      query(
        database,
        `INSERT OR IGNORE INTO xp_events (
          id, user_id, idempotency_key, event_type, points, related_type, related_id
        ) VALUES (?, ?, ?, 'task_completed', 30, 'task', ?)`,
        [
          crypto.randomUUID(),
          identity.userId,
          `${identity.userId}:task:${taskId}:completed`,
          taskId,
        ],
      ),
    );
  }
  await database.batch(statements);
  return taskId;
}

async function markSubmitted(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const credentialId = textField(payload, "credentialId", {
    required: true,
    max: 160,
  })!;
  const submissionDate = isoDateField(payload, "submissionDate")!;
  const confirmationNumber =
    textField(payload, "confirmationNumber", { max: 180 }) ?? "";
  const proofReference = textField(payload, "proofReference", { max: 500 });

  const credential = await query(
    database,
    `SELECT id, status FROM credentials WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ id: string; status: string }>();
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  if (credential.status === "renewed") {
    throw new RequestError(
      "This renewal cycle is closed and cannot be submitted again.",
      409,
      "cycle_closed",
    );
  }
  const existing = await query(
    database,
    `SELECT id
     FROM renewal_submissions
     WHERE credential_id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ id: string }>();
  const submissionId = existing?.id ?? crypto.randomUUID();

  await database.batch([
    query(
      database,
      `INSERT INTO renewal_submissions (
        id, user_id, credential_id, submitted_at, confirmation_number,
        proof_reference
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(credential_id) DO UPDATE SET
        submitted_at = excluded.submitted_at,
        confirmation_number = excluded.confirmation_number,
        proof_reference = excluded.proof_reference,
        updated_at = CURRENT_TIMESTAMP`,
      [
        submissionId,
        identity.userId,
        credentialId,
        submissionDate,
        confirmationNumber,
        (proofReference ?? confirmationNumber) || null,
      ],
    ),
    query(
      database,
      `UPDATE credentials
       SET status = 'submitted', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [credentialId, identity.userId],
    ),
    query(
      database,
      `UPDATE checklist_tasks
       SET
         status = 'completed',
         completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
       WHERE credential_id = ? AND user_id = ? AND kind = 'submission'`,
      [credentialId, identity.userId],
    ),
    query(
      database,
      `INSERT OR IGNORE INTO xp_events (
        id, user_id, idempotency_key, event_type, points, related_type, related_id
      ) VALUES (?, ?, ?, 'renewal_submitted', 150, 'submission', ?)`,
      [
        crypto.randomUUID(),
        identity.userId,
        `${identity.userId}:credential:${credentialId}:submitted`,
        submissionId,
      ],
    ),
    query(
      database,
      `INSERT OR IGNORE INTO badge_events (
        id, user_id, badge_id, idempotency_key, related_type, related_id
      ) VALUES (?, ?, 'renewal-filed', ?, 'submission', ?)`,
      [
        crypto.randomUUID(),
        identity.userId,
        `${identity.userId}:badge:renewal-filed`,
        submissionId,
      ],
    ),
  ]);
  return submissionId;
}

async function addActivityAllocation(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const activityId = textField(payload, "activityId", {
    required: true,
    max: 160,
  })!;
  const credentialId = textField(payload, "credentialId", {
    required: true,
    max: 160,
  })!;
  const requirementIds = requirementIdsField(payload);
  const requirementId = requirementIds[0] ?? null;
  const allocatedUnits = positiveNumber(payload, "allocatedUnits", {
    required: true,
  })!;

  const [activity, credential, existing] = await Promise.all([
    query(
      database,
      `SELECT
        id,
        total_units AS totalUnits,
        completion_date AS completionDate
       FROM activities
       WHERE id = ? AND user_id = ?`,
      [activityId, identity.userId],
    ).first<{ id: string; totalUnits: number; completionDate: string }>(),
    query(
      database,
      `SELECT
        id,
        status,
        cycle_start AS cycleStart,
        deadline
       FROM credentials
       WHERE id = ? AND user_id = ?`,
      [credentialId, identity.userId],
    ).first<{
      id: string;
      status: string;
      cycleStart: string;
      deadline: string;
    }>(),
    query(
      database,
      `SELECT id
       FROM activity_allocations
       WHERE activity_id = ? AND credential_id = ?
       LIMIT 1`,
      [activityId, credentialId],
    ).first<{ id: string }>(),
  ]);
  if (!activity) {
    throw new RequestError("Activity not found.", 404, "activity_not_found");
  }
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  if (credential.status === "renewed") {
    throw new RequestError(
      "This renewal cycle is closed and cannot receive activities.",
      409,
      "cycle_closed",
    );
  }
  if (
    activity.completionDate < credential.cycleStart ||
    activity.completionDate > credential.deadline
  ) {
    throw new RequestError(
      `The activity date must fall within the target renewal cycle (${credential.cycleStart} through ${credential.deadline}).`,
      409,
      "activity_outside_cycle",
    );
  }
  if (existing) {
    throw new RequestError(
      "This activity is already applied to that credential.",
      409,
      "allocation_exists",
    );
  }
  if (allocatedUnits > Number(activity.totalUnits)) {
    throw new RequestError(
      "allocatedUnits cannot exceed the activity total for one credential",
    );
  }

  await validateRequirementTags(
    database,
    identity,
    credentialId,
    requirementIds,
  );

  const allocationId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    query(
      database,
      `INSERT INTO activity_allocations (
        id, activity_id, credential_id, requirement_id, allocated_units
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        allocationId,
        activityId,
        credentialId,
        requirementId,
        allocatedUnits,
      ],
    ),
  ];
  for (const matchedRequirementId of requirementIds) {
    statements.push(
      query(
        database,
        `INSERT INTO activity_requirement_matches (
          id, user_id, allocation_id, requirement_id, matched_units
        ) VALUES (?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          identity.userId,
          allocationId,
          matchedRequirementId,
          allocatedUnits,
        ],
      ),
    );
  }
  try {
    await database.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE constraint")) {
      throw new RequestError(
        "This activity is already applied to that credential.",
        409,
        "allocation_exists",
      );
    }
    throw error;
  }
  return allocationId;
}

async function markRenewalAccepted(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const credentialId = textField(payload, "credentialId", {
    required: true,
    max: 160,
  })!;
  const acceptedAt = isoDateField(payload, "acceptedAt")!;
  const reference = textField(payload, "reference", { max: 300 });
  const nextCycleStart = isoDateField(payload, "nextCycleStart")!;
  const nextDeadline = isoDateField(payload, "nextDeadline")!;
  if (nextCycleStart >= nextDeadline) {
    throw new RequestError("nextDeadline must be after nextCycleStart");
  }

  const priorAcceptance = await query(
    database,
    `SELECT next_credential_id AS nextCredentialId
     FROM renewal_acceptances
     WHERE credential_id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ nextCredentialId: string }>();
  if (priorAcceptance) return priorAcceptance.nextCredentialId;

  type CycleCredential = {
    id: string;
    ruleSetId: string | null;
    credentialName: string;
    profession: string;
    jurisdiction: string;
    issuer: string;
    status: string;
    totalRequired: number;
    unitLabel: string;
    seriesId: string;
    cycleMonths: number;
  };
  type RequirementSnapshot = {
    id: string;
    ruleCategoryId: string | null;
    name: string;
    requiredUnits: number;
    kind: RequirementKind;
    relation: RequirementRelation;
    parentRequirementId: string | null;
    applicability: RequirementApplicability;
    conditionNote: string | null;
    exclusiveGroup: string | null;
    sortOrder: number;
  };
  const [credential, submission, requirements] = await Promise.all([
    query(
      database,
      `SELECT
        credential.id,
        credential.rule_set_id AS ruleSetId,
        credential.credential_name AS credentialName,
        credential.profession,
        credential.jurisdiction,
        credential.issuer,
        credential.status,
        credential.total_required AS totalRequired,
        credential.unit_label AS unitLabel,
        COALESCE(cycle.series_id, credential.id) AS seriesId,
        COALESCE(cycle.cycle_months, rules.cycle_months, 12) AS cycleMonths
      FROM credentials credential
      LEFT JOIN credential_cycle_links cycle
        ON cycle.credential_id = credential.id
        AND cycle.user_id = credential.user_id
      LEFT JOIN rule_sets rules ON rules.id = credential.rule_set_id
      WHERE credential.id = ? AND credential.user_id = ?`,
      [credentialId, identity.userId],
    ).first<CycleCredential>(),
    query(
      database,
      `SELECT id, submitted_at AS submittedAt
       FROM renewal_submissions
       WHERE credential_id = ? AND user_id = ?`,
      [credentialId, identity.userId],
    ).first<{ id: string; submittedAt: string }>(),
    query(
      database,
      `SELECT
        requirement.id,
        requirement.rule_category_id AS ruleCategoryId,
        requirement.name,
        requirement.required_units AS requiredUnits,
        requirement.kind,
        requirement.relation,
        requirement.parent_requirement_id AS parentRequirementId,
        requirement.applicability,
        requirement.condition_note AS conditionNote,
        requirement.exclusive_group AS exclusiveGroup,
        requirement.sort_order AS sortOrder
      FROM credential_requirements requirement
      JOIN credentials credential
        ON credential.id = requirement.credential_id
      WHERE requirement.credential_id = ?
        AND credential.user_id = ?
      ORDER BY requirement.sort_order, requirement.name`,
      [credentialId, identity.userId],
    ).all<RequirementSnapshot>(),
  ]);
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  if (!submission || credential.status !== "submitted") {
    throw new RequestError(
      "Record the renewal submission before marking it accepted.",
      409,
      "submission_required",
    );
  }
  if (acceptedAt < submission.submittedAt.slice(0, 10)) {
    throw new RequestError(
      "acceptedAt cannot be before the submission date",
      400,
      "acceptance_before_submission",
    );
  }

  const nextCredentialId = crypto.randomUUID();
  const acceptanceId = crypto.randomUUID();
  const transitionsToFortyHourCfp =
    credential.ruleSetId === "cfp-professional-pre-2027-v1" &&
    nextCycleStart >= "2027-01-01";
  const nextCredentialName = transitionsToFortyHourCfp
    ? "CFP® Professional — cycle beginning Q1 2027 or later"
    : credential.credentialName;
  const nextRuleSetId = transitionsToFortyHourCfp
    ? "cfp-professional-2027-v1"
    : credential.ruleSetId;
  const nextTotalRequired = transitionsToFortyHourCfp
    ? 40
    : Number(credential.totalRequired);
  const statements: D1PreparedStatement[] = [
    query(
      database,
      `INSERT OR IGNORE INTO credential_cycle_links (
        id, user_id, credential_id, series_id, previous_credential_id,
        cycle_months
      ) VALUES (?, ?, ?, ?, NULL, ?)`,
      [
        crypto.randomUUID(),
        identity.userId,
        credentialId,
        credential.seriesId,
        Number(credential.cycleMonths),
      ],
    ),
    query(
      database,
      `INSERT INTO credentials (
        id, user_id, rule_set_id, credential_name, profession, jurisdiction,
        issuer, cycle_start, deadline, total_required, unit_label, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        nextCredentialId,
        identity.userId,
        nextRuleSetId,
        nextCredentialName,
        credential.profession,
        credential.jurisdiction,
        credential.issuer,
        nextCycleStart,
        nextDeadline,
        nextTotalRequired,
        credential.unitLabel,
      ],
    ),
    query(
      database,
      `INSERT INTO credential_cycle_links (
        id, user_id, credential_id, series_id, previous_credential_id,
        cycle_months
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        identity.userId,
        nextCredentialId,
        credential.seriesId,
        credentialId,
        Number(credential.cycleMonths),
      ],
    ),
  ];

  const rolloverDrafts: CredentialCategoryDraft[] = requirements.results.map(
    (requirement) => {
      const applicabilityStatus = defaultApplicabilityStatus(
        requirement.applicability,
      );
      return {
        key: requirement.id,
        ruleCategoryId:
          transitionsToFortyHourCfp &&
          requirement.ruleCategoryId === "cfp-professional-pre-2027-general"
            ? "cfp-professional-2027-general"
            : transitionsToFortyHourCfp &&
                requirement.ruleCategoryId ===
                  "cfp-professional-pre-2027-ethics"
              ? "cfp-professional-2027-ethics"
              : requirement.ruleCategoryId,
        name: requirement.name,
        requiredUnits:
          transitionsToFortyHourCfp &&
          requirement.ruleCategoryId === "cfp-professional-pre-2027-general"
            ? 38
            : Number(requirement.requiredUnits),
        kind: requirement.kind,
        relation: requirement.relation,
        parentKey: requirement.parentRequirementId,
        applicability: requirement.applicability,
        applicabilityStatus,
        conditionNote: requirement.conditionNote,
        exclusiveGroup: requirement.exclusiveGroup,
        isActive: applicabilityStatus === "applies",
        sortOrder: Number(requirement.sortOrder),
      };
    },
  );
  const nextRequirementIdByPriorId = new Map(
    rolloverDrafts.map((requirement) => [
      requirement.key,
      crypto.randomUUID(),
    ]),
  );
  validateActiveCategoryParents(rolloverDrafts);
  for (const requirement of orderedCategoryDrafts(rolloverDrafts)) {
    statements.push(
      query(
        database,
        `INSERT INTO credential_requirements (
          id, credential_id, rule_category_id, name, required_units, kind,
          relation, parent_requirement_id, applicability,
          applicability_status, condition_note, exclusive_group, is_active,
          sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          nextRequirementIdByPriorId.get(requirement.key),
          nextCredentialId,
          requirement.ruleCategoryId,
          requirement.name,
          Number(requirement.requiredUnits),
          requirement.kind,
          requirement.relation,
          requirement.parentKey
            ? nextRequirementIdByPriorId.get(requirement.parentKey)
            : null,
          requirement.applicability,
          requirement.applicabilityStatus,
          requirement.conditionNote,
          requirement.exclusiveGroup,
          requirement.isActive ? 1 : 0,
          Number(requirement.sortOrder),
        ],
      ),
    );
  }
  const taskSpecs = [
    {
      title: transitionsToFortyHourCfp
        ? "Confirm CFP Board carryover eligibility for the 40-hour cycle"
        : "Review the renewal requirements",
      kind: "review",
      dueDate: daysBefore(nextDeadline, 120),
    },
    {
      title: "Complete and document required education",
      kind: "progress",
      dueDate: daysBefore(nextDeadline, 30),
    },
    {
      title: "Submit renewal and save confirmation",
      kind: "submission",
      dueDate: nextDeadline,
    },
  ];
  taskSpecs.forEach((task, index) => {
    statements.push(
      query(
        database,
        `INSERT INTO checklist_tasks (
          id, user_id, credential_id, title, kind, status, due_date, sort_order
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [
          crypto.randomUUID(),
          identity.userId,
          nextCredentialId,
          task.title,
          task.kind,
          task.dueDate,
          index,
        ],
      ),
    );
  });
  statements.push(
    query(
      database,
      `INSERT INTO renewal_acceptances (
        id, user_id, credential_id, submission_id, accepted_at,
        acceptance_reference, next_credential_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        acceptanceId,
        identity.userId,
        credentialId,
        submission.id,
        acceptedAt,
        reference,
        nextCredentialId,
      ],
    ),
    query(
      database,
      `UPDATE credentials
       SET status = 'renewed', updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND status = 'submitted'`,
      [credentialId, identity.userId],
    ),
    query(
      database,
      `INSERT OR IGNORE INTO xp_events (
        id, user_id, idempotency_key, event_type, points, related_type, related_id
      ) VALUES (?, ?, ?, 'renewal_accepted', 200, 'acceptance', ?)`,
      [
        crypto.randomUUID(),
        identity.userId,
        `${identity.userId}:credential:${credentialId}:accepted`,
        acceptanceId,
      ],
    ),
  );

  try {
    await database.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE constraint")) {
      const racedAcceptance = await query(
        database,
        `SELECT next_credential_id AS nextCredentialId
         FROM renewal_acceptances
         WHERE credential_id = ? AND user_id = ?`,
        [credentialId, identity.userId],
      ).first<{ nextCredentialId: string }>();
      if (racedAcceptance) return racedAcceptance.nextCredentialId;
    }
    throw error;
  }
  return nextCredentialId;
}

async function updateRequirementApplicability(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const credentialId = textField(payload, "credentialId", {
    required: true,
    max: 160,
  })!;
  const rawChoices = payload.choices;
  if (
    !Array.isArray(rawChoices) ||
    rawChoices.length === 0 ||
    rawChoices.length > 50
  ) {
    throw new RequestError("choices must be an array of 1 to 50 items");
  }
  const choices = new Map<string, ApplicabilityStatus>();
  rawChoices.forEach((value, index) => {
    if (!isRecord(value)) {
      throw new RequestError(`choices[${index}] must be an object`);
    }
    const requirementId = textField(value, "requirementId", {
      required: true,
      max: 160,
    })!;
    const status = enumField(
      value,
      "status",
      APPLICABILITY_STATUSES,
      "needs_confirmation",
    );
    if (choices.has(requirementId)) {
      throw new RequestError(
        "choices cannot contain duplicate requirementId values",
      );
    }
    choices.set(requirementId, status);
  });

  type ApplicabilityRequirementRow = {
    id: string;
    name: string;
    relation: RequirementRelation;
    parentRequirementId: string | null;
    applicability: RequirementApplicability;
    applicabilityStatus: ApplicabilityStatus;
  };
  const [credential, requirementResult] = await Promise.all([
    query(
      database,
      `SELECT id, status
       FROM credentials
       WHERE id = ? AND user_id = ?`,
      [credentialId, identity.userId],
    ).first<{ id: string; status: string }>(),
    query(
      database,
      `SELECT
        requirement.id,
        requirement.name,
        requirement.relation,
        requirement.parent_requirement_id AS parentRequirementId,
        requirement.applicability,
        requirement.applicability_status AS applicabilityStatus
      FROM credential_requirements requirement
      JOIN credentials credential
        ON credential.id = requirement.credential_id
      WHERE requirement.credential_id = ?
        AND credential.user_id = ?`,
      [credentialId, identity.userId],
    ).all<ApplicabilityRequirementRow>(),
  ]);
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  if (credential.status === "renewed") {
    throw new RequestError(
      "This renewal cycle is closed and its requirements are frozen.",
      409,
      "cycle_closed",
    );
  }

  const requirementsById = new Map(
    requirementResult.results.map((requirement) => [
      requirement.id,
      requirement,
    ]),
  );
  const normalizedChoices = new Map<string, ApplicabilityStatus>();
  for (const [requirementId, requestedStatus] of choices) {
    const requirement = requirementsById.get(requirementId);
    if (!requirement) {
      throw new RequestError(
        "Requirement not found for this credential.",
        404,
        "requirement_not_found",
      );
    }
    normalizedChoices.set(
      requirementId,
      normalizedApplicabilityStatus(
        requirement.applicability,
        requestedStatus,
        `status for ${requirement.name}`,
      ),
    );
  }

  const effectiveStatus = (requirementId: string) =>
    normalizedChoices.get(requirementId) ??
    requirementsById.get(requirementId)?.applicabilityStatus;
  for (const requirement of requirementsById.values()) {
    if (
      effectiveStatus(requirement.id) === "applies" &&
      requirement.relation === "nested" &&
      requirement.parentRequirementId &&
      effectiveStatus(requirement.parentRequirementId) !== "applies"
    ) {
      throw new RequestError(
        `${requirement.name} cannot apply while its parent requirement is inactive.`,
        409,
        "inactive_parent_requirement",
      );
    }
  }

  const statements = [...normalizedChoices].flatMap(
    ([requirementId, status]) => {
      const update = query(
        database,
        `UPDATE credential_requirements
         SET applicability_status = ?, is_active = ?
         WHERE id = ?
           AND credential_id = ?
           AND EXISTS (
             SELECT 1
             FROM credentials credential
             WHERE credential.id = credential_requirements.credential_id
               AND credential.user_id = ?
           )`,
        [
          status,
          status === "applies" ? 1 : 0,
          requirementId,
          credentialId,
          identity.userId,
        ],
      );
      if (status === "needs_confirmation") return [update];
      return [
        update,
        query(
          database,
          `INSERT OR IGNORE INTO xp_events (
            id, user_id, idempotency_key, event_type, points, related_type,
            related_id
          ) VALUES (?, ?, ?, 'requirement_confirmed', 20, 'requirement', ?)`,
          [
            crypto.randomUUID(),
            identity.userId,
            `${identity.userId}:requirement:${requirementId}:confirmed`,
            requirementId,
          ],
        ),
      ];
    },
  );
  await database.batch(statements);
  return credentialId;
}

async function updateReminderPreferences(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  if (typeof payload.inAppEnabled !== "boolean") {
    throw new RequestError("inAppEnabled must be a boolean");
  }
  const leadDays = normalizeLeadDays(payload.leadDays);
  const timeZone = textField(payload, "timeZone", {
    required: true,
    max: 100,
  })!;
  if (!validTimeZone(timeZone)) {
    throw new RequestError(
      "timeZone must be a valid IANA time zone",
      400,
      "invalid_time_zone",
    );
  }

  await query(
    database,
    `INSERT INTO reminder_preferences (
      user_id, in_app_enabled, lead_days, time_zone
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      in_app_enabled = excluded.in_app_enabled,
      lead_days = excluded.lead_days,
      time_zone = excluded.time_zone,
      updated_at = CURRENT_TIMESTAMP`,
    [
      identity.userId,
      payload.inAppEnabled ? 1 : 0,
      JSON.stringify(leadDays),
      timeZone,
    ],
  ).run();
  return "reminder-preferences";
}

async function setReminderState(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const reminderKey = textField(payload, "reminderKey", {
    required: true,
    max: 240,
  })!;
  const credentialId = textField(payload, "credentialId", {
    required: true,
    max: 160,
  })!;
  const status = textField(payload, "status", {
    required: true,
    max: 20,
  })!;
  if (!["dismissed", "snoozed"].includes(status)) {
    throw new RequestError("status must be dismissed or snoozed");
  }
  const snoozedUntil =
    status === "snoozed"
      ? isoDateField(payload, "snoozedUntil")
      : null;

  const credential = await query(
    database,
    `SELECT id, deadline FROM credentials WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ id: string; deadline: string }>();
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }

  let validReminder = false;
  if (reminderKey === `deadline:${credentialId}:${credential.deadline}`) {
    validReminder = true;
  } else if (reminderKey.startsWith(`acceptance:${credentialId}:`)) {
    const submission = await query(
      database,
      `SELECT submitted_at AS submittedAt
       FROM renewal_submissions
       WHERE credential_id = ? AND user_id = ?`,
      [credentialId, identity.userId],
    ).first<{ submittedAt: string }>();
    validReminder =
      reminderKey ===
      `acceptance:${credentialId}:${submission?.submittedAt.slice(0, 10)}`;
  } else {
    const taskMatch = /^task:(.+):(\d{4}-\d{2}-\d{2})$/.exec(reminderKey);
    const taskId = taskMatch?.[1] ?? "";
    const occurrenceDate = taskMatch?.[2] ?? "";
    const task = await query(
      database,
      `SELECT task.id
       FROM checklist_tasks task
       JOIN credentials credential ON credential.id = task.credential_id
       WHERE task.id = ?
         AND task.credential_id = ?
         AND task.user_id = ?
         AND task.due_date = ?
         AND credential.user_id = task.user_id`,
      [taskId, credentialId, identity.userId, occurrenceDate],
    ).first<{ id: string }>();
    validReminder = Boolean(taskMatch && task);
  }
  if (!validReminder) {
    throw new RequestError(
      "Reminder not found for this credential.",
      404,
      "reminder_not_found",
    );
  }

  if (snoozedUntil) {
    const preference = await query(
      database,
      `SELECT time_zone AS timeZone
       FROM reminder_preferences
       WHERE user_id = ?`,
      [identity.userId],
    ).first<{ timeZone: string }>();
    const timeZone =
      preference?.timeZone && validTimeZone(preference.timeZone)
        ? preference.timeZone
        : "UTC";
    if (snoozedUntil < todayInTimeZone(timeZone)) {
      throw new RequestError("snoozedUntil cannot be in the past");
    }
  }

  const existing = await query(
    database,
    `SELECT id
     FROM reminder_states
     WHERE user_id = ? AND reminder_key = ?`,
    [identity.userId, reminderKey],
  ).first<{ id: string }>();
  const stateId = existing?.id ?? crypto.randomUUID();
  await query(
    database,
    `INSERT INTO reminder_states (
      id, user_id, credential_id, reminder_key, status, snoozed_until
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, reminder_key) DO UPDATE SET
      credential_id = excluded.credential_id,
      status = excluded.status,
      snoozed_until = excluded.snoozed_until,
      updated_at = CURRENT_TIMESTAMP`,
    [
      stateId,
      identity.userId,
      credentialId,
      reminderKey,
      status,
      snoozedUntil,
    ],
  ).run();
  return stateId;
}

async function authenticatedContext(request: Request) {
  const identity = await resolveRequestIdentity(request);
  if (!identity) {
    throw new RequestError(
      "Sign in with ChatGPT to access your CEU workspace.",
      401,
      "authentication_required",
    );
  }
  const database = getD1();
  await initializeDatabase(database);
  await ensureUser(database, identity);
  return { database, identity };
}

export async function GET(request: Request) {
  try {
    const { database, identity } = await authenticatedContext(request);
    return json(await getWorkspace(database, identity));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 100_000) {
      throw new RequestError("Request body is too large.", 413, "body_too_large");
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new RequestError("Request body must be valid JSON.");
    }
    if (!isRecord(body)) throw new RequestError("Request body must be an object.");
    rejectClientIdentity(body);
    const action = textField(body, "action", { required: true, max: 40 })!;
    if (!isRecord(body.payload)) {
      throw new RequestError("payload must be an object");
    }
    rejectClientIdentity(body.payload);

    const { database, identity } = await authenticatedContext(request);
    let id: string;
    switch (action) {
      case "createCredential":
        id = await createCredential(database, identity, body.payload);
        break;
      case "addActivity":
        id = await addActivity(database, identity, body.payload);
        break;
      case "addActivityAllocation":
        id = await addActivityAllocation(database, identity, body.payload);
        break;
      case "claimWeeklyQuest":
        id = await claimWeeklyQuest(database, identity, body.payload);
        break;
      case "toggleTask":
        id = await toggleTask(database, identity, body.payload);
        break;
      case "markSubmitted":
        id = await markSubmitted(database, identity, body.payload);
        break;
      case "markRenewalAccepted":
        id = await markRenewalAccepted(database, identity, body.payload);
        break;
      case "updateRequirementApplicability":
        id = await updateRequirementApplicability(
          database,
          identity,
          body.payload,
        );
        break;
      case "updateReminderPreferences":
        id = await updateReminderPreferences(
          database,
          identity,
          body.payload,
        );
        break;
      case "setReminderState":
        id = await setReminderState(database, identity, body.payload);
        break;
      default:
        throw new RequestError(
          `Unsupported action: ${action}`,
          400,
          "unsupported_action",
        );
    }
    return json({ ok: true, action, id });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  if (error instanceof RequestError) {
    return json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error("CEU workspace API error", message);
  return json(
    {
      error: "The CEU workspace could not be loaded. Please try again.",
      code: "internal_error",
    },
    { status: 500 },
  );
}
