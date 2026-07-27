import type { CalendarInviteEvent } from "./calendarInvite";

type CalendarTaskInput = {
  id: string;
  title: string;
  kind: string;
  status: string;
  dueDate?: string | null;
};

export type CalendarCredentialInput = {
  id: string;
  ruleSetId?: string | null;
  credentialName: string;
  jurisdiction: string;
  status: string;
  deadline: string;
  submittedAt?: string | null;
  sourceUrl?: string | null;
  tasks: CalendarTaskInput[];
};

export type CalendarReminderInput = {
  key: string;
  credentialId?: string;
  kind?: "task" | "deadline" | "acceptance";
  title: string;
  body: string;
  eventDate: string;
};

function daysAfter(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isCompliancePeriod(ruleSetId: string | null | undefined) {
  return Boolean(
    ruleSetId &&
      [
        "fl-insurance-producer-",
        "ny-professional-classroom-teacher-",
        "ny-professional-esol-bilingual-",
        "nj-employed-teacher-annual-pd-",
        "pa-professional-educator-act-48-",
      ].some((prefix) => ruleSetId.startsWith(prefix)),
  );
}

function isIsc2(ruleSetId: string | null | undefined) {
  return ruleSetId?.startsWith("isc2-") ?? false;
}

export function normalizedCalendarLeadDays(
  savedLeadDays?: readonly number[],
) {
  if (savedLeadDays === undefined) return [30];
  return [
    ...new Set(
      savedLeadDays.filter(
        (day) =>
          Number.isFinite(day) &&
          Number.isInteger(day) &&
          day >= 0 &&
          day <= 365,
      ),
    ),
  ].sort((left, right) => right - left);
}

export function credentialDeadlineCalendarEvent(
  credential: CalendarCredentialInput,
  reminderDaysBefore: readonly number[],
): CalendarInviteEvent {
  const compliancePeriod = isCompliancePeriod(credential.ruleSetId);
  return {
    uid: `credential-${credential.id}-${credential.deadline}`,
    title: `${credential.credentialName} ${
      compliancePeriod ? "compliance" : "renewal"
    } deadline`,
    description: [
      `${credential.credentialName} ${
        compliancePeriod ? "compliance" : "renewal"
      } deadline in ${credential.jurisdiction}.`,
      compliancePeriod
        ? "Confirm current requirements and completion status with the official authority or employer record."
        : "Confirm current requirements with the licensing board or certifying body before submitting.",
    ].join(" "),
    date: credential.deadline,
    reminderDaysBefore: [...reminderDaysBefore],
    url: credential.sourceUrl,
  };
}

export function reminderCalendarEvent(
  reminder: CalendarReminderInput,
  reminderDaysBefore: readonly number[],
): CalendarInviteEvent {
  return {
    uid:
      reminder.kind === "deadline" && reminder.credentialId
        ? `credential-${reminder.credentialId}-${reminder.eventDate}`
        : reminder.key,
    title: reminder.title,
    description: `${reminder.body} Added from Vigilo.`,
    date: reminder.eventDate,
    reminderDaysBefore: [...reminderDaysBefore],
  };
}

function acceptanceFollowUpCalendarEvent(
  credential: CalendarCredentialInput,
  reminderDaysBefore: readonly number[],
): CalendarInviteEvent | null {
  const submittedDate = credential.submittedAt?.slice(0, 10);
  if (credential.status !== "submitted" || !submittedDate) return null;
  const ordinaryFollowUp = daysAfter(submittedDate, 7);
  const isDashboardCheckpoint = isIsc2(credential.ruleSetId);
  const isComplianceCheckpoint = isCompliancePeriod(
    credential.ruleSetId,
  );
  const eventDate =
    (isDashboardCheckpoint || isComplianceCheckpoint) &&
    ordinaryFollowUp < credential.deadline
      ? credential.deadline
      : ordinaryFollowUp;
  return {
    uid: `acceptance:${credential.id}:${submittedDate}`,
    title: isDashboardCheckpoint
      ? `${credential.credentialName}: check the ISC2 dashboard for renewal`
      : isComplianceCheckpoint
        ? `${credential.credentialName}: check the official next-period record`
        : `${credential.credentialName}: check renewal acceptance`,
    description: isDashboardCheckpoint
      ? "Confirm renewal only after ISC2 displays the renewed certification dates."
      : isComplianceCheckpoint
        ? "Confirm the next compliance-period dates from the official authority or employer record."
        : "Confirm the renewal decision and next cycle dates with the issuing authority.",
    date: eventDate,
    reminderDaysBefore: [...reminderDaysBefore],
    url: credential.sourceUrl,
  };
}

export function allCheckInCalendarEvents(
  credentials: readonly CalendarCredentialInput[],
  reminderDaysBefore: readonly number[],
) {
  const openCredentials = credentials.filter((credential) =>
    ["active", "submitted"].includes(credential.status),
  );
  const deadlineEvents = openCredentials
    .filter((credential) => credential.status === "active")
    .map((credential) =>
      credentialDeadlineCalendarEvent(
        credential,
        reminderDaysBefore,
      ),
    );
  const taskEvents = openCredentials.flatMap((credential) =>
    credential.tasks
      .filter(
        (task) =>
          task.status === "pending" &&
          task.kind !== "submission" &&
          Boolean(task.dueDate),
      )
      .map(
        (task): CalendarInviteEvent => ({
          uid: `task:${task.id}:${task.dueDate}`,
          title: `${credential.credentialName}: ${task.title}`,
          description:
            "Pending Vigilo checklist item. Confirm current requirements with the official authority or employer record.",
          date: task.dueDate!,
          reminderDaysBefore: [...reminderDaysBefore],
          url: credential.sourceUrl,
        }),
      ),
  );
  const acceptanceEvents = openCredentials
    .map((credential) =>
      acceptanceFollowUpCalendarEvent(
        credential,
        reminderDaysBefore,
      ),
    )
    .filter((event): event is CalendarInviteEvent => Boolean(event));
  return [...deadlineEvents, ...taskEvents, ...acceptanceEvents];
}
