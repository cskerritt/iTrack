"use client";

import {
  ChangeEvent,
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CertificateFieldSuggestions,
  scanCertificateImage,
} from "./lib/certificateOcr";
import {
  ACTIVITY_DRAFT_MAX_UNITS,
  ACTIVITY_DRAFT_PROVIDER_MAX_LENGTH,
  ACTIVITY_DRAFT_TITLE_MAX_LENGTH,
  activityDraftStorageKey,
  activityDraftShouldBePurged,
  hasMeaningfulActivityDraft,
  legacyActivityDraftStorageKey,
  parseActivityDraft,
  serializeActivityDraft,
} from "./lib/activityDraft";
import {
  CalendarInviteEvent,
  offerCalendarInvite,
} from "./lib/calendarInvite";
import {
  allCheckInCalendarEvents,
  credentialDeadlineCalendarEvent,
  normalizedCalendarLeadDays,
  reminderCalendarEvent,
} from "./lib/checkInCalendar";
import { portalCarryoverLookbackMonths } from "./lib/carryover";
import {
  oppositeFloridaMentalHealthRuleSetId,
} from "./lib/floridaMentalHealth";
import {
  nextRequirementSelection,
  requirementIncompatibilityMessage,
} from "./lib/requirementCompatibility";

type Requirement = {
  id: string;
  ruleCategoryId?: string | null;
  name: string;
  requiredUnits: number;
  earnedUnits: number;
  rawEarned?: number;
  countableEarned?: number;
  excessUnits?: number;
  kind?: "minimum" | "maximum" | "informational";
  relation?: "independent" | "nested" | "overlapping";
  parentRequirementId?: string | null;
  applicability?: "always" | "conditional" | "optional";
  applicabilityStatus?: "applies" | "not_applicable" | "needs_confirmation";
  isActive?: boolean;
  conditionNote?: string | null;
  exclusiveGroup?: string | null;
};

type RenewalTask = {
  id: string;
  title: string;
  kind: string;
  status: "pending" | "completed";
  dueDate?: string | null;
  revision: number;
  isPersonal: boolean;
  archivedAt?: string | null;
};

type Credential = {
  id: string;
  ruleSetId?: string | null;
  credentialName: string;
  profession: string;
  jurisdiction: string;
  issuer?: string | null;
  cycleStart: string;
  deadline: string;
  totalRequired: number;
  unitLabel: string;
  cycleMonths: number;
  status: "active" | "submitted" | "renewed";
  seriesId?: string | null;
  previousCredentialId?: string | null;
  submittedAt?: string | null;
  confirmationNumber?: string | null;
  acceptedAt?: string | null;
  acceptanceReference?: string | null;
  nextCredentialId?: string | null;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  ruleReviewStatus?: string | null;
  totalEarned: number;
  totalRawEarned?: number;
  totalExcessUnits?: number;
  totalLoggedUnits?: number;
  unclassifiedUnits?: number;
  classificationIssues?: Array<{
    allocationId: string;
    activityId: string;
    activityTitle: string;
    unresolvedExclusiveGroups: string[];
    allocatedUnits: number;
    classificationMessage?: string;
  }>;
  requirements: Requirement[];
  tasks: RenewalTask[];
  archivedTasks: RenewalTask[];
};

type CatalogCategory = {
  id: string;
  name: string;
  requiredUnits: number;
  kind?: "minimum" | "maximum" | "informational";
  relation?: "independent" | "nested" | "overlapping";
  parentCategoryId?: string | null;
  applicability?: "always" | "conditional" | "optional";
  conditionNote?: string | null;
  exclusiveGroup?: string | null;
};

type CatalogRule = {
  id: string;
  profession: string;
  credentialName: string;
  jurisdiction: string;
  issuer: string;
  totalUnits: number;
  unitLabel: string;
  cycleMonths: number;
  sourceUrl?: string | null;
  sourceTitle?: string | null;
  effectiveDate?: string | null;
  lastVerifiedAt?: string | null;
  reviewStatus?: string | null;
  categories: CatalogCategory[];
};

type ActivityAllocation = {
  id: string;
  credentialId: string;
  credentialName: string;
  credentialRuleSetId?: string | null;
  requirementId?: string | null;
  categoryName?: string | null;
  requirementIds?: string[];
  categoryNames?: string[];
  requirementMatches?: Array<{
    requirementId: string;
    matchedUnits: number;
  }>;
  allocatedUnits: number;
  classificationStatus?: "classified" | "needs_classification";
  unresolvedExclusiveGroups?: string[];
  classificationMessage?: string;
};

type Activity = {
  id: string;
  title: string;
  provider?: string | null;
  completionDate: string;
  totalUnits: number;
  evidenceStatus: "missing" | "attached" | "not_required";
  evidenceCount: number;
  evidenceDeletionPendingCount?: number;
  credentialId?: string | null;
  credentialName?: string | null;
  requirementId?: string | null;
  categoryName?: string | null;
  allocatedUnits: number;
  allocations?: ActivityAllocation[];
  revision: number;
  archivedAt?: string | null;
};

type EvidenceFile = {
  id: string;
  activityId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  downloadUrl: string;
  deletionPending: boolean;
};

type Badge = {
  id: string;
  name: string;
  description: string;
  earnedAt?: string | null;
  earned?: boolean;
};

type WeeklyQuest = {
  key: string;
  title: string;
  description: string;
  target: number;
  progress: number;
  rewardXp: number;
  completed: boolean;
  claimed: boolean;
  claimable: boolean;
  claimedAt: string | null;
};

type Progression = {
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
  quests: WeeklyQuest[];
};

type Workspace = {
  user: {
    displayName: string;
    email: string;
    isDemo?: boolean;
    draftStorageNamespace: string;
  };
  profile: {
    xp: number;
    weekActions: number;
    weeklyGoal: number;
    nextWeeklyGoal?: number;
    nextWeeklyGoalEffectiveOn?: string | null;
    badges: Badge[];
  };
  progression: Progression;
  catalog: CatalogRule[];
  credentials: Credential[];
  activities: Activity[];
  archivedActivities: Activity[];
  reminderPreferences: {
    inAppEnabled: boolean;
    leadDays: number[];
    timeZone: string;
  };
  reminders: Reminder[];
};

type Reminder = {
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

type ViewName = "today" | "credentials" | "records" | "account";
type ToastState = {
  message: string;
  undo?: () => void;
};

type ActivityDraft = {
  title: string;
  completionDate: string;
  totalUnits: string;
  provider: string;
};

type ActivityScanState = {
  phase: "idle" | "scanning" | "success" | "manual" | "pdf" | "error";
  label: string;
  progress: number;
  suggestions: CertificateFieldSuggestions;
};

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const CFP_2027_GENERAL_CATEGORY_ID = "cfp-professional-2027-general";
const NJ_LCSW_CREDIT_CATEGORY_GROUP = "New Jersey LCSW credit category";

const todayIso = () => new Date().toISOString().slice(0, 10);

const nextYearIso = () => {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 1);
  return date.toISOString().slice(0, 10);
};

const yearAgoIso = () => {
  const date = new Date();
  date.setFullYear(date.getFullYear() - 1);
  return date.toISOString().slice(0, 10);
};

function formatDate(value?: string | null, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "Not set";
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...options,
  }).format(parsed);
}

function formatFileSize(bytes: number) {
  if (bytes < 1_048_576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function daysUntil(value: string) {
  const deadline = new Date(`${value.slice(0, 10)}T23:59:59`);
  const today = new Date();
  return Math.ceil((deadline.getTime() - today.getTime()) / 86_400_000);
}

function addDaysIso(value: string, days: number) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addMonthsIso(value: string, months: number) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00.000Z`);
  const targetDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(targetDay, lastDay));
  return date.toISOString().slice(0, 10);
}

function defaultCatalogCycleStart(
  rule: CatalogRule | null | undefined,
) {
  return rule
    ? addMonthsIso(nextYearIso(), -rule.cycleMonths)
    : yearAgoIso();
}

function confirmedCarryoverWindowStart(
  credential: Credential | null | undefined,
) {
  if (!credential) return null;
  const lookbacks = credential.requirements.flatMap((requirement) => {
    if (
      requirement.isActive === false ||
      requirement.applicabilityStatus !== "applies" ||
      !requirement.ruleCategoryId
    ) {
      return [];
    }
    const months = portalCarryoverLookbackMonths(
      requirement.ruleCategoryId,
    );
    return months === null ? [] : [months];
  });
  return lookbacks.length
    ? addMonthsIso(credential.cycleStart, -Math.max(...lookbacks))
    : null;
}

function activityDateFitsCredential(
  completionDate: string,
  credential: Credential,
) {
  if (
    completionDate >= credential.cycleStart &&
    completionDate <= credential.deadline
  ) {
    return true;
  }
  const carryoverStart = confirmedCarryoverWindowStart(credential);
  return Boolean(
    carryoverStart &&
      completionDate >= carryoverStart &&
      completionDate < credential.cycleStart,
  );
}

function allocationsFor(activity: Activity): ActivityAllocation[] {
  if (activity.allocations?.length) return activity.allocations;
  if (!activity.credentialId || !activity.credentialName) return [];
  return [
    {
      id: `${activity.id}:${activity.credentialId}`,
      credentialId: activity.credentialId,
      credentialName: activity.credentialName,
      requirementId: activity.requirementId,
      categoryName: activity.categoryName,
      allocatedUnits: activity.allocatedUnits,
    },
  ];
}

function activityIsMutable(
  activity: Activity,
  credentials: Credential[],
) {
  const credentialStatusById = new Map(
    credentials.map((credential) => [credential.id, credential.status]),
  );
  return allocationsFor(activity).every((allocation) => {
    const status = credentialStatusById.get(allocation.credentialId);
    return status === "active" || status === "submitted";
  });
}

function requirementEarned(requirement: Requirement) {
  return Number(
    requirement.countableEarned ??
      requirement.earnedUnits ??
      requirement.rawEarned ??
      0,
  );
}

function requirementRawEarned(requirement: Requirement) {
  return Number(requirement.rawEarned ?? requirement.earnedUnits ?? 0);
}

function requirementKind(requirement: Requirement) {
  return requirement.kind ?? "minimum";
}

function requirementStatus(requirement: Requirement) {
  return requirement.applicabilityStatus ?? "applies";
}

function activeMinimums(credential: Credential) {
  return credential.requirements.filter(
    (requirement) =>
      requirementStatus(requirement) === "applies" &&
      requirement.isActive !== false &&
      requirementKind(requirement) === "minimum",
  );
}

function allocationCategoryLabel(allocation: ActivityAllocation) {
  if (allocation.categoryNames?.length) {
    return allocation.categoryNames.join(" · ");
  }
  return allocation.categoryName ?? "General";
}

function catalogCategorySummary(category: CatalogCategory) {
  const qualifier =
    category.applicability === "conditional" ? " if applicable" : "";
  if (category.kind === "informational") {
    return `Track ${category.name}${qualifier}`;
  }
  const units = compactNumber(category.requiredUnits);
  const prefix =
    category.kind === "maximum" ? `Up to ${units}` : `${units}`;
  return `${prefix} ${category.name}${qualifier}`;
}

function ruleReviewLabel(reviewStatus?: string | null) {
  switch (reviewStatus) {
    case "verified":
      return "Official source verified";
    case "transition_rule_check_assigned_cycle":
      return "Transition rule · check assigned cycle";
    case "needs_review":
      return "Needs official review";
    case "source_linked_check_conditions":
      return "Source-linked · confirm conditions";
    default:
      return "Source-linked · review details";
  }
}

function ruleReviewClass(reviewStatus?: string | null) {
  switch (reviewStatus) {
    case "verified":
      return "verified";
    case "transition_rule_check_assigned_cycle":
      return "transition";
    case "needs_review":
      return "needs-review";
    default:
      return "conditional";
  }
}

function compactNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function firstName(displayName: string) {
  const candidate = displayName.includes("@")
    ? displayName.split("@")[0]
    : displayName.split(/\s+/)[0];
  return candidate || "there";
}

function credentialProgress(credential: Credential) {
  if (credential.totalRequired <= 0) return 100;
  return clampPercent(
    (credential.totalEarned / credential.totalRequired) * 100,
  );
}

function readinessScore(credential: Credential) {
  const unitProgress = Math.min(1, credentialProgress(credential) / 100);
  const minimums = activeMinimums(credential);
  const unresolved = credential.requirements.filter(
    (item) => requirementStatus(item) === "needs_confirmation",
  );
  const requirementCount = minimums.length + unresolved.length;
  const metRequirements = minimums.filter(
    (item) => requirementEarned(item) >= item.requiredUnits,
  ).length;
  const requirementProgressValue =
    requirementCount === 0 ? 1 : metRequirements / requirementCount;
  const taskCount = credential.tasks.length;
  const completedTasks = credential.tasks.filter(
    (item) => item.status === "completed",
  ).length;
  const taskProgress = taskCount === 0 ? 1 : completedTasks / taskCount;
  const score =
    credential.totalRequired <= 0
      ? clampPercent(requirementProgressValue * 60 + taskProgress * 40)
      : clampPercent(
          unitProgress * 70 +
            requirementProgressValue * 15 +
            taskProgress * 15,
        );
  return credential.classificationIssues?.length
    ? Math.min(99, score)
    : score;
}

function isIsc2AutomaticRenewalCredential(
  credential: Credential | null | undefined,
) {
  return credential?.ruleSetId?.startsWith("isc2-") ?? false;
}

function isNremtCredential(credential: Credential | null | undefined) {
  return credential?.ruleSetId?.startsWith("nremt-") ?? false;
}

function isNremtCatalogRule(rule: CatalogRule | null | undefined) {
  return rule?.id.startsWith("nremt-") ?? false;
}

function isFloridaMentalHealthCatalogRule(
  rule: CatalogRule | null | undefined,
) {
  return rule?.id.startsWith("fl-lcsw-lmft-lmhc-") ?? false;
}

function requiresOfficialCatalogDates(
  rule: CatalogRule | null | undefined,
) {
  return (
    isNremtCatalogRule(rule) ||
    isFloridaMentalHealthCatalogRule(rule)
  );
}

function nremtLevelKey(ruleSetId: string | null | undefined) {
  return /^nremt-(emr|emt|aemt|paramedic)-/.exec(ruleSetId ?? "")?.[1] ?? null;
}

function currentNremtCatalogRule(
  catalog: CatalogRule[],
  credential: Credential | null | undefined,
) {
  const level = nremtLevelKey(credential?.ruleSetId);
  if (!level) return null;
  return (
    catalog.find((rule) => rule.id.startsWith(`nremt-${level}-`)) ?? null
  );
}

type RequirementMatchPayload = {
  requirementId: string;
  matchedUnits: number;
};

function nremtRequirementMatchPayload(
  form: FormData,
  credential: Credential,
  allocatedUnits: number,
): RequirementMatchPayload[] {
  const requirements = credential.requirements.filter(
    (requirement) =>
      requirementStatus(requirement) === "applies" &&
      requirement.isActive !== false,
  );
  const amountFor = (requirement: Requirement) => {
    const value = Number(form.get(`requirementMatch:${requirement.id}`) ?? 0);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(
        `Enter a valid accepted-credit amount for ${requirement.name}.`,
      );
    }
    if (value > allocatedUnits + 0.0001) {
      throw new Error(
        `${requirement.name} cannot exceed the ${compactNumber(
          allocatedUnits,
        )} credits applied to this credential.`,
      );
    }
    return value;
  };
  const national = requirements.find((requirement) =>
    requirement.ruleCategoryId?.endsWith("-national"),
  );
  const local = requirements.find((requirement) =>
    requirement.ruleCategoryId?.endsWith("-local"),
  );
  const individual = requirements.find((requirement) =>
    requirement.ruleCategoryId?.endsWith("-individual"),
  );
  if (!national || !local || !individual) {
    throw new Error(
      "This National Registry template is missing a component requirement. Refresh the credential before saving.",
    );
  }

  const nationalUnits = amountFor(national);
  const localUnits = amountFor(local);
  const individualUnits = amountFor(individual);
  const componentTotal = nationalUnits + localUnits + individualUnits;
  if (Math.abs(componentTotal - allocatedUnits) > 0.0001) {
    throw new Error(
      `National, Local/State, and Individual must total ${compactNumber(
        allocatedUnits,
      )} credits.`,
    );
  }

  const nationalTopics = requirements.filter(
    (requirement) =>
      requirement.relation === "nested" &&
      requirement.parentRequirementId === national.id,
  );
  const topicTotal = nationalTopics.reduce(
    (sum, requirement) => sum + amountFor(requirement),
    0,
  );
  if (Math.abs(topicTotal - nationalUnits) > 0.0001) {
    throw new Error(
      `The five National topic amounts must total ${compactNumber(
        nationalUnits,
      )} National credits.`,
    );
  }

  const overlapping = requirements.filter(
    (requirement) => requirement.relation === "overlapping",
  );
  for (const requirement of overlapping) {
    if (amountFor(requirement) > nationalUnits + 0.0001) {
      throw new Error(
        `${requirement.name} is overlapping National content and cannot exceed the National amount.`,
      );
    }
  }
  if (form.get("acceptedEducationAttested") !== "on") {
    throw new Error(
      "Confirm that the provider, course, and post-cap credit are accepted by the National Registry.",
    );
  }

  return requirements
    .map((requirement) => ({
      requirementId: requirement.id,
      matchedUnits: amountFor(requirement),
    }))
    .filter((match) => match.matchedUnits > 0);
}

function hasPortalConfirmedCarryover(
  credential: Credential | null | undefined,
) {
  return Boolean(
    credential?.requirements.some(
      (requirement) =>
        requirement.isActive !== false &&
        requirement.applicabilityStatus !== "not_applicable" &&
        portalCarryoverLookbackMonths(requirement.ruleCategoryId) !== null,
    ),
  );
}

function isPriorPeriodCarryoverEntry(
  completionDate: string | null | undefined,
  credential: Credential | null | undefined,
) {
  return Boolean(
    completionDate &&
      credential &&
      completionDate < credential.cycleStart &&
      hasPortalConfirmedCarryover(credential),
  );
}

function isManagedPharmacistCredential(
  credential: Credential | null | undefined,
) {
  return Boolean(
    credential?.profession === "Pharmacy" && credential.ruleSetId,
  );
}

function isManagedNursingCredential(
  credential: Credential | null | undefined,
) {
  return Boolean(
    credential?.profession === "Nursing" && credential.ruleSetId,
  );
}

function isCompliancePeriodCredential(
  credential: Credential | null | undefined,
) {
  const ruleSetId = credential?.ruleSetId;
  return Boolean(
    ruleSetId &&
      (ruleSetId.startsWith("fl-insurance-producer-") ||
        ruleSetId.startsWith("ny-professional-classroom-teacher-") ||
        ruleSetId.startsWith("ny-professional-esol-bilingual-") ||
        ruleSetId.startsWith("nj-employed-teacher-annual-pd-") ||
        ruleSetId.startsWith("pa-professional-educator-act-48-")),
  );
}

function isFloridaInsuranceComplianceCredential(
  credential: Credential | null | undefined,
) {
  return (
    credential?.ruleSetId?.startsWith("fl-insurance-producer-") ?? false
  );
}

function isFloridaMentalHealthPhaseCredential(
  credential: Credential | null | undefined,
) {
  return (
    credential?.ruleSetId?.startsWith("fl-lcsw-lmft-lmhc-") ?? false
  );
}

function requiresCurrentNextTemplate(
  credential: Credential | null | undefined,
) {
  return (
    isFloridaInsuranceComplianceCredential(credential) ||
    isFloridaMentalHealthPhaseCredential(credential)
  );
}

function requiresOfficialNextPeriodAttestation(
  credential: Credential | null | undefined,
) {
  return (
    isIsc2AutomaticRenewalCredential(credential) ||
    isCompliancePeriodCredential(credential) ||
    isFloridaMentalHealthPhaseCredential(credential) ||
    isNremtCredential(credential) ||
    isManagedPharmacistCredential(credential) ||
    isManagedNursingCredential(credential)
  );
}

function requiresNonOverlappingNextPeriod(
  credential: Credential | null | undefined,
) {
  return (
    isIsc2AutomaticRenewalCredential(credential) ||
    isCompliancePeriodCredential(credential) ||
    isFloridaMentalHealthPhaseCredential(credential) ||
    isManagedPharmacistCredential(credential) ||
    isManagedNursingCredential(credential)
  );
}

type GuidedAction = {
  kind:
    | "acceptance"
    | "conditions"
    | "history"
    | "learning"
    | "records"
    | "checklist"
    | "submission";
  title: string;
  body: string;
  buttonLabel: string;
};

function bestNextAction(
  credential: Credential,
  missingEvidence: number,
): GuidedAction {
  if (credential.status === "renewed") {
    return {
      kind: "history",
      title: "Review the preserved record for this completed cycle",
      body: "Your credits, proof, submission, and acceptance remain together.",
      buttonLabel: "View cycle history",
    };
  }
  if (credential.status === "submitted") {
    if (isIsc2AutomaticRenewalCredential(credential)) {
      return {
        kind: "acceptance",
        title: "Confirm the renewed cycle shown in your ISC2 dashboard",
        body: "Keep this cycle open until ISC2 displays the new certification dates.",
        buttonLabel: "Confirm renewed cycle",
      };
    }
    if (isCompliancePeriodCredential(credential)) {
      return {
        kind: "acceptance",
        title: "Confirm the next compliance period from the official record",
        body: "Keep this period open until you have verified the new compliance dates.",
        buttonLabel: "Start next period",
      };
    }
    if (isNremtCredential(credential)) {
      return {
        kind: "acceptance",
        title: "Confirm the renewed dates in your National Registry dashboard",
        body: "Use the same current level template and enter the cycle start and fixed expiration exactly as displayed.",
        buttonLabel: "Confirm renewed cycle",
      };
    }
    return {
      kind: "acceptance",
      title: "Record acceptance when your renewal is approved",
      body: "Keep the cycle open until the issuing organization confirms it.",
      buttonLabel: "Record acceptance",
    };
  }

  const unresolvedRequirement = credential.requirements.find(
    (item) => requirementStatus(item) === "needs_confirmation",
  );
  if (unresolvedRequirement) {
    return {
      kind: "conditions",
      title: `Confirm whether ${unresolvedRequirement.name} applies this cycle`,
      body: "Your readiness score stays cautious until this rule is resolved.",
      buttonLabel: "Review conditions",
    };
  }

  const classificationIssueCount = credential.classificationIssues?.length ?? 0;
  if (classificationIssueCount > 0) {
    return {
      kind: "records",
      title: `Classify ${classificationIssueCount} learning ${
        classificationIssueCount === 1 ? "record" : "records"
      }`,
      body: `${compactNumber(
        credential.unclassifiedUnits ?? 0,
      )} ${credential.unitLabel} are preserved but excluded until each classification conflict is resolved.`,
      buttonLabel: "Review records",
    };
  }

  const overdueTask = credential.tasks.find(
    (task) =>
      task.status !== "completed" &&
      Boolean(task.dueDate) &&
      daysUntil(task.dueDate!) < 0,
  );
  if (overdueTask) {
    return {
      kind: "checklist",
      title: overdueTask.title,
      body: `This checklist step was due ${formatDate(overdueTask.dueDate)}.`,
      buttonLabel: "Open checklist",
    };
  }

  if (missingEvidence > 0) {
    return {
      kind: "records",
      title: `Attach proof to ${missingEvidence} learning ${
        missingEvidence === 1 ? "record" : "records"
      }`,
      body: "A complete audit trail is as important as the credit total.",
      buttonLabel: "Review records",
    };
  }

  const missingRequirement = activeMinimums(credential)
    .filter((item) => requirementEarned(item) < item.requiredUnits)
    .sort(
      (a, b) =>
        b.requiredUnits -
        requirementEarned(b) -
        (a.requiredUnits - requirementEarned(a)),
    )[0];

  if (missingRequirement) {
    const left =
      missingRequirement.requiredUnits - requirementEarned(missingRequirement);
    const overallRemaining = Math.max(
      0,
      credential.totalRequired - credential.totalEarned,
    );
    return {
      kind: "learning",
      title: `Complete ${compactNumber(left)} more ${missingRequirement.name} ${
        left === 1
          ? credential.unitLabel.replace(/s$/, "")
          : credential.unitLabel
      }`,
      body:
        overallRemaining === 0
          ? "Your overall total is met, but this active category minimum is still short."
          : `${compactNumber(overallRemaining)} ${credential.unitLabel} remain overall; prioritize this category.`,
      buttonLabel: "Log qualifying learning",
    };
  }

  const overallRemaining = Math.max(
    0,
    credential.totalRequired - credential.totalEarned,
  );
  if (overallRemaining > 0) {
    return {
      kind: "learning",
      title: `Complete ${compactNumber(overallRemaining)} more ${
        overallRemaining === 1
          ? credential.unitLabel.replace(/s$/, "")
          : credential.unitLabel
      }`,
      body: "Log completed learning as you go so the record stays current.",
      buttonLabel: "Add completed learning",
    };
  }

  const openTask = credential.tasks.find((task) => task.status !== "completed");
  if (openTask) {
    return {
      kind: "checklist",
      title: openTask.title,
      body: isIsc2AutomaticRenewalCredential(credential)
        ? "Credits are covered. Finish this dashboard step before confirming renewal."
        : isCompliancePeriodCredential(credential)
          ? "Credits are covered. Finish this official-record step before closing the period."
          : isNremtCredential(credential)
            ? "Credits are covered. Complete the Training Officer or Medical Director verification required for Active status, or confirm the Inactive pathway, before applying."
          : "Credits are covered. Finish this packet step before submitting.",
      buttonLabel: "Open checklist",
    };
  }
  if (isIsc2AutomaticRenewalCredential(credential)) {
    return {
      kind: "submission",
      title: "Check your ISC2 CPE and fee status in the dashboard",
      body: "Save an attested checkpoint, then wait for renewed dates after cycle end.",
      buttonLabel: "Save dashboard checkpoint",
    };
  }
  if (isCompliancePeriodCredential(credential)) {
    return {
      kind: "submission",
      title: "Verify this compliance period in the official record",
      body: "Save the official milestone before opening the next period.",
      buttonLabel: "Record compliance",
    };
  }
  if (isNremtCredential(credential)) {
    return {
      kind: "submission",
      title: "Verify the National Registry dashboard and submit",
      body: "Confirm accepted post-cap education, every NCCP component, status verification, and the current on-time or reinstatement path.",
      buttonLabel: "Save application record",
    };
  }
  return {
    kind: "submission",
    title: "Review and submit your renewal",
    body: "Your active minimums, overall credits, and checklist are complete.",
    buttonLabel: "Review submission",
  };
}

export function LicenseLanternApp() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<ViewName>("today");
  const [selectedCredentialId, setSelectedCredentialId] = useState("");
  const [activityOpen, setActivityOpen] = useState(false);
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [submissionOpen, setSubmissionOpen] = useState(false);
  const [nremtSubmissionDate, setNremtSubmissionDate] = useState(todayIso());
  const [acceptanceOpen, setAcceptanceOpen] = useState(false);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [allocationActivity, setAllocationActivity] =
    useState<Activity | null>(null);
  const [allocationCredentialId, setAllocationCredentialId] = useState("");
  const [classificationRepair, setClassificationRepair] = useState<{
    activity: Activity;
    allocation: ActivityAllocation;
  } | null>(null);
  const [evidenceActivity, setEvidenceActivity] = useState<Activity | null>(
    null,
  );
  const [editingActivity, setEditingActivity] = useState<Activity | null>(null);
  const [taskEditor, setTaskEditor] = useState<{
    credential: Credential;
    task: RenewalTask | null;
  } | null>(null);
  const [evidenceFiles, setEvidenceFiles] = useState<EvidenceFile[]>([]);
  const [evidencePending, setEvidencePending] = useState(false);
  const [customCredential, setCustomCredential] = useState(false);
  const [selectedRuleId, setSelectedRuleId] = useState("");
  const [catalogQuery, setCatalogQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<ToastState | null>(null);
  const [activityDraft, setActivityDraft] = useState<ActivityDraft>(() => ({
    title: "",
    completionDate: todayIso(),
    totalUnits: "",
    provider: "",
  }));
  const [activityEvidenceFile, setActivityEvidenceFile] =
    useState<File | null>(null);
  const [activityScan, setActivityScan] = useState<ActivityScanState>({
    phase: "idle",
    label: "",
    progress: 0,
    suggestions: {},
  });
  const [activityDraftRestored, setActivityDraftRestored] = useState(false);
  const [activityDraftCredentialWarning, setActivityDraftCredentialWarning] =
    useState("");
  const [activityDraftPersistenceStatus, setActivityDraftPersistenceStatus] =
    useState<"idle" | "saving" | "saved" | "unavailable">("idle");
  const [isOnline, setIsOnline] = useState(true);
  const [workspaceLoadFailed, setWorkspaceLoadFailed] = useState(false);
  const [workspaceLoadFailureStatus, setWorkspaceLoadFailureStatus] = useState<
    number | null
  >(null);
  const [installPrompt, setInstallPrompt] =
    useState<InstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);
  const activityScanSequence = useRef(0);
  const activityDraftPersistenceEnabled = useRef(false);
  const activityDraftPersistenceGeneration = useRef(0);
  const draftStorageKey = useMemo(
    () =>
      workspace?.user.draftStorageNamespace
        ? activityDraftStorageKey(workspace.user.draftStorageNamespace)
        : null,
    [workspace?.user.draftStorageNamespace],
  );
  const legacyDraftStorageKey = useMemo(
    () =>
      workspace?.user.email
        ? legacyActivityDraftStorageKey(workspace.user.email)
        : null,
    [workspace?.user.email],
  );

  const resetActivityEntry = useCallback(() => {
    activityScanSequence.current += 1;
    setActivityDraft({
      title: "",
      completionDate: todayIso(),
      totalUnits: "",
      provider: "",
    });
    setActivityEvidenceFile(null);
    setActivityScan({
      phase: "idle",
      label: "",
      progress: 0,
      suggestions: {},
    });
    setActivityDraftRestored(false);
    setActivityDraftCredentialWarning("");
    setActivityDraftPersistenceStatus("idle");
  }, []);

  const persistActivityDraftNow = useCallback(() => {
    if (!activityDraftPersistenceEnabled.current || !draftStorageKey) {
      return true;
    }
    try {
      if (!hasMeaningfulActivityDraft(activityDraft)) {
        window.localStorage.removeItem(draftStorageKey);
        setActivityDraftPersistenceStatus("idle");
        return true;
      }
      window.localStorage.setItem(
        draftStorageKey,
        serializeActivityDraft({
          credentialId: selectedCredentialId,
          ...activityDraft,
        }),
      );
      setActivityDraftPersistenceStatus("saved");
      return true;
    } catch {
      setActivityDraftPersistenceStatus("unavailable");
      return false;
    }
  }, [activityDraft, draftStorageKey, selectedCredentialId]);

  const openActivityEntry = useCallback(() => {
    activityDraftPersistenceGeneration.current += 1;
    activityDraftPersistenceEnabled.current = true;
    let restored = false;
    if (draftStorageKey && workspace) {
      try {
        const serialized = window.localStorage.getItem(draftStorageKey);
        const saved = parseActivityDraft(serialized);
        const credential = workspace.credentials.find(
          (candidate) =>
            candidate.id === saved?.credentialId &&
            candidate.status !== "renewed",
        );
        if (saved) {
          setActivityDraft({
            title: saved.title,
            completionDate: saved.completionDate,
            totalUnits: saved.totalUnits,
            provider: saved.provider,
          });
          if (credential) {
            setSelectedCredentialId(credential.id);
            setActivityDraftCredentialWarning("");
          } else {
            setSelectedCredentialId("");
            setActivityDraftCredentialWarning(
              "The credential originally linked to this draft is no longer active. Choose an active credential before saving.",
            );
          }
          setActivityEvidenceFile(null);
          setActivityScan({
            phase: "idle",
            label: "",
            progress: 0,
            suggestions: {},
          });
          setActivityDraftRestored(true);
          setActivityDraftPersistenceStatus("saved");
          restored = true;
        } else if (serialized) {
          window.localStorage.removeItem(draftStorageKey);
        }
      } catch {
        // Draft recovery is a convenience; storage restrictions must not block entry.
      }
    }
    if (!restored) resetActivityEntry();
    setActivityOpen(true);
  }, [draftStorageKey, resetActivityEntry, workspace]);

  const closeActivityEntry = useCallback(() => {
    const draftPersisted = persistActivityDraftNow();
    if (!draftPersisted) {
      setToast({
        message:
          "This browser couldn’t save your draft. Keep this form open or finish logging the activity before leaving.",
      });
      return;
    }
    activityDraftPersistenceEnabled.current = false;
    activityDraftPersistenceGeneration.current += 1;
    setActivityOpen(false);
    resetActivityEntry();
  }, [persistActivityDraftNow, resetActivityEntry]);

  const loadWorkspace = useCallback(async () => {
    setWorkspaceLoadFailed(false);
    setWorkspaceLoadFailureStatus(null);
    let responseStatus: number | null = null;
    try {
      const response = await fetch("/api/workspace", {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      responseStatus = response.status;
      const data = (await response.json()) as Workspace & { error?: string };
      if (!response.ok) {
        throw new Error(data.error || "We couldn’t load your renewal workspace.");
      }
      setWorkspace(data);
      setWorkspaceLoadFailed(false);
      setWorkspaceLoadFailureStatus(null);
      setError("");
      setSelectedCredentialId((current) => {
        if (
          current &&
          data.credentials.some((credential) => credential.id === current)
        ) {
          return current;
        }
        return [...data.credentials].sort(
          (a, b) =>
            new Date(a.deadline).getTime() - new Date(b.deadline).getTime(),
        )[0]?.id ?? "";
      });
      return true;
    } catch (loadError) {
      setWorkspaceLoadFailed(true);
      setWorkspaceLoadFailureStatus(responseStatus);
      setError(
        loadError instanceof Error
          ? loadError.message
          : "We couldn’t load your renewal workspace.",
      );
      return false;
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void loadWorkspace();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadWorkspace]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [view]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      void loadWorkspace();
    };
    const handleOffline = () => setIsOnline(false);
    const statusTimeout = window.setTimeout(
      () => setIsOnline(window.navigator.onLine),
      0,
    );
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.clearTimeout(statusTimeout);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [loadWorkspace]);

  useEffect(() => {
    if (
      "serviceWorker" in navigator &&
      window.location.protocol === "https:"
    ) {
      void navigator.serviceWorker
        .register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        })
        .catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      Boolean(
        (window.navigator as Navigator & { standalone?: boolean }).standalone,
      );
    const standaloneTimeout = window.setTimeout(
      () => setIsStandalone(standalone),
      0,
    );
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const handleInstalled = () => {
      setIsStandalone(true);
      setInstallPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    return () => {
      window.clearTimeout(standaloneTimeout);
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  useEffect(() => {
    if (!draftStorageKey) return;
    try {
      let serialized = window.localStorage.getItem(draftStorageKey);
      if (activityDraftShouldBePurged(serialized)) {
        window.localStorage.removeItem(draftStorageKey);
        serialized = null;
      }

      if (legacyDraftStorageKey && legacyDraftStorageKey !== draftStorageKey) {
        const legacySerialized =
          window.localStorage.getItem(legacyDraftStorageKey);
        const legacyDraft = parseActivityDraft(legacySerialized);
        if (!serialized && legacySerialized && legacyDraft) {
          window.localStorage.setItem(draftStorageKey, legacySerialized);
          serialized = legacySerialized;
        }
        if (serialized || (legacySerialized && !legacyDraft)) {
          window.localStorage.removeItem(legacyDraftStorageKey);
        }
      }
    } catch {
      // Browser storage restrictions should not block the workspace.
    }
  }, [draftStorageKey, legacyDraftStorageKey]);

  useEffect(() => {
    if (!activityOpen || !draftStorageKey) return;
    const hasDraft = hasMeaningfulActivityDraft(activityDraft);
    const generation = activityDraftPersistenceGeneration.current;
    const statusTimeout = window.setTimeout(() => {
      setActivityDraftPersistenceStatus(hasDraft ? "saving" : "idle");
    }, 0);
    const timeout = window.setTimeout(() => {
      if (generation !== activityDraftPersistenceGeneration.current) return;
      persistActivityDraftNow();
    }, 250);
    return () => {
      window.clearTimeout(statusTimeout);
      window.clearTimeout(timeout);
    };
  }, [
    activityDraft,
    activityOpen,
    draftStorageKey,
    persistActivityDraftNow,
  ]);

  useEffect(() => {
    if (!activityOpen) return;
    const flushActivityDraft = () => persistActivityDraftNow();
    window.addEventListener("pagehide", flushActivityDraft);
    return () => window.removeEventListener("pagehide", flushActivityDraft);
  }, [activityOpen, persistActivityDraftNow]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeActivityEntry();
      setCredentialOpen(false);
      setSubmissionOpen(false);
      setAcceptanceOpen(false);
      setRemindersOpen(false);
      setAllocationActivity(null);
      setClassificationRepair(null);
      setEvidenceActivity(null);
      setEditingActivity(null);
      setTaskEditor(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeActivityEntry]);

  const selectedCredential = useMemo(() => {
    if (!workspace) return null;
    return (
      workspace.credentials.find(
        (credential) => credential.id === selectedCredentialId,
      ) ??
      workspace.credentials[0] ??
      null
    );
  }, [selectedCredentialId, workspace]);

  const selectedNremtNextRule = useMemo(
    () =>
      currentNremtCatalogRule(
        workspace?.catalog ?? [],
        selectedCredential,
      ),
    [selectedCredential, workspace],
  );

  const selectedRule = useMemo(
    () =>
      workspace?.catalog.find((rule) => rule.id === selectedRuleId) ?? null,
    [selectedRuleId, workspace],
  );

  const catalogMatches = useMemo(() => {
    if (!workspace) return [];
    const query = catalogQuery.trim().toLowerCase();
    if (!query) return workspace.catalog;
    return workspace.catalog.filter((rule) =>
      [
        rule.profession,
        rule.credentialName,
        rule.jurisdiction,
        rule.issuer,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [catalogQuery, workspace]);

  const catalogGroups = useMemo(() => {
    const groups = new Map<string, CatalogRule[]>();
    for (const rule of catalogMatches) {
      const rules = groups.get(rule.profession) ?? [];
      rules.push(rule);
      groups.set(rule.profession, rules);
    }
    return [...groups.entries()].map(([profession, rules]) => ({
      profession,
      rules,
    }));
  }, [catalogMatches]);

  const eligibleAllocationCredentials = useMemo(() => {
    if (!workspace || !allocationActivity) return [];
    const existingIds = new Set(
      allocationsFor(allocationActivity).map(
        (allocation) => allocation.credentialId,
      ),
    );
    return workspace.credentials.filter(
      (credential) =>
        credential.status !== "renewed" &&
        !existingIds.has(credential.id) &&
        activityDateFitsCredential(
          allocationActivity.completionDate,
          credential,
        ),
    );
  }, [allocationActivity, workspace]);

  const allocationCredential =
    eligibleAllocationCredentials.find(
      (credential) => credential.id === allocationCredentialId,
    ) ??
    eligibleAllocationCredentials[0] ??
    null;
  const classificationCredential =
    workspace?.credentials.find(
      (credential) =>
        credential.id === classificationRepair?.allocation.credentialId,
    ) ?? null;

  const activityCredentials =
    workspace?.credentials.filter(
      (credential) => credential.status !== "renewed",
    ) ?? [];
  const activityCredential =
    activityCredentials.find(
      (credential) => credential.id === selectedCredentialId,
    ) ?? null;
  const scanningActivityEvidence = activityScan.phase === "scanning";
  const evidenceIsFrozen = Boolean(
    evidenceActivity &&
      workspace &&
      !activityIsMutable(evidenceActivity, workspace.credentials),
  );

  async function runAction(
    action: string,
    payload: Record<string, unknown>,
    successMessage: string,
  ) {
    if (!window.navigator.onLine) {
      setIsOnline(false);
      setError(
        "You’re offline. Your course draft stays in this browser; reconnect before saving changes.",
      );
      return null;
    }
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, payload }),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        code?: string;
        id?: string;
      };
      if (!response.ok) {
        if (
          [
            "activity_version_conflict",
            "activity_state_changed",
            "allocation_state_changed",
            "task_version_conflict",
            "task_state_changed",
            "cycle_closed",
          ].includes(result.code ?? "")
        ) {
          const refreshed = await loadWorkspace();
          if (refreshed) {
            setEditingActivity(null);
            setTaskEditor(null);
            setAllocationActivity(null);
            setClassificationRepair(null);
          }
          throw new Error(
            refreshed
              ? `${result.error || "That item changed in another session."} The latest version is loaded; reopen it to continue.`
              : `${result.error || "That item changed in another session."} The workspace could not be refreshed; keep this editor open and try Refresh when your connection is stable.`,
          );
        }
        throw new Error(result.error || "That update didn’t save.");
      }
      await loadWorkspace();
      setToast({ message: successMessage });
      return result;
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "That update didn’t save.",
      );
      return null;
    } finally {
      setPending(false);
    }
  }

  function clearSavedActivityDraft() {
    if (!draftStorageKey) return true;
    try {
      window.localStorage.removeItem(draftStorageKey);
      if (legacyDraftStorageKey) {
        window.localStorage.removeItem(legacyDraftStorageKey);
      }
      return true;
    } catch {
      return false;
    }
  }

  function discardActivityDraft() {
    activityDraftPersistenceGeneration.current += 1;
    const cleared = clearSavedActivityDraft();
    resetActivityEntry();
    setToast({
      message: cleared
        ? "The browser-saved course draft was cleared."
        : "The form was cleared, but this browser would not remove its saved draft. Clear License Lantern site data to remove it.",
    });
  }

  function finishSavedActivityEntry() {
    activityDraftPersistenceEnabled.current = false;
    activityDraftPersistenceGeneration.current += 1;
    const cleared = clearSavedActivityDraft();
    setActivityOpen(false);
    resetActivityEntry();
    if (!cleared) {
      setToast({
        message:
          "Activity saved, but this browser would not clear its local draft. Clear License Lantern site data to remove it.",
      });
    }
  }

  async function handleInstallApp() {
    if (!installPrompt) {
      setToast({
        message:
          "Use your browser’s Add to Home Screen or Install app option.",
      });
      return;
    }
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    setInstallPrompt(null);
    if (choice.outcome === "accepted") {
      setIsStandalone(true);
      setToast({ message: "License Lantern was added to this device." });
    }
  }

  function preferredCalendarLeadDays() {
    return normalizedCalendarLeadDays(
      workspace?.reminderPreferences.leadDays,
    );
  }

  function credentialCalendarEvent(
    credential: Credential,
  ): CalendarInviteEvent {
    return credentialDeadlineCalendarEvent(
      credential,
      preferredCalendarLeadDays(),
    );
  }

  async function deliverCalendarInvite(
    events: CalendarInviteEvent[],
    fileName: string,
    successMessage: string,
  ) {
    try {
      const delivery = await offerCalendarInvite(events, fileName);
      if (delivery !== "cancelled") {
        setToast({ message: successMessage });
      }
    } catch {
      setError(
        "The calendar file could not be opened on this device. Try again from your browser.",
      );
    }
  }

  async function addCredentialToCalendar(credential: Credential) {
    await deliverCalendarInvite(
      [credentialCalendarEvent(credential)],
      `${credential.credentialName}-${credential.deadline}`,
      isCompliancePeriodCredential(credential)
        ? "Compliance date handed off to your calendar."
        : "Renewal date handed off to your calendar.",
    );
  }

  async function addReminderToCalendar(reminder: Reminder) {
    await deliverCalendarInvite(
      [
        reminderCalendarEvent(
          reminder,
          preferredCalendarLeadDays(),
        ),
      ],
      `${reminder.credentialName}-${reminder.eventDate}`,
      "Check-in handed off to your calendar.",
    );
  }

  async function addAllCheckInsToCalendar() {
    const events = allCheckInCalendarEvents(
      workspace?.credentials ?? [],
      preferredCalendarLeadDays(),
    );
    if (!events.length) {
      setToast({ message: "There are no open check-ins to add yet." });
      return;
    }
    await deliverCalendarInvite(
      events,
      "license-lantern-check-ins",
      `${events.length} calendar ${
        events.length === 1 ? "check-in" : "check-ins"
      } handed off with your reminder schedule.`,
    );
  }

  async function handleActivityEvidenceSelection(file?: File) {
    if (!file) return;
    const maximumBytes = 10 * 1_048_576;
    const lowerName = file.name.toLowerCase();
    const isPdf =
      file.type === "application/pdf" || lowerName.endsWith(".pdf");
    const inferredImageType = lowerName.endsWith(".jpg")
      ? "image/jpeg"
      : lowerName.endsWith(".jpeg")
        ? "image/jpeg"
        : lowerName.endsWith(".png")
          ? "image/png"
          : lowerName.endsWith(".webp")
            ? "image/webp"
            : "";
    const imageType = ["image/jpeg", "image/png", "image/webp"].includes(
      file.type,
    )
      ? file.type
      : inferredImageType;

    activityScanSequence.current += 1;
    const sequence = activityScanSequence.current;

    if (file.size > maximumBytes) {
      setActivityEvidenceFile(null);
      setActivityScan({
        phase: "error",
        label: "That file is larger than 10 MB. Choose a smaller proof file.",
        progress: 0,
        suggestions: {},
      });
      return;
    }

    if (!isPdf && !imageType) {
      setActivityEvidenceFile(null);
      setActivityScan({
        phase: "error",
        label: "Choose a PDF, JPEG, PNG, or WebP certificate.",
        progress: 0,
        suggestions: {},
      });
      return;
    }

    const previousSuggestions = activityScan.suggestions;
    setActivityDraft((current) => ({
      title:
        previousSuggestions.title === current.title ? "" : current.title,
      provider:
        previousSuggestions.provider === current.provider
          ? ""
          : current.provider,
      completionDate:
        previousSuggestions.completionDate === current.completionDate
          ? todayIso()
          : current.completionDate,
      totalUnits:
        previousSuggestions.credits !== undefined &&
        String(previousSuggestions.credits) === current.totalUnits
          ? ""
          : current.totalUnits,
    }));
    setActivityEvidenceFile(file);
    if (isPdf) {
      setActivityScan({
        phase: "pdf",
        label:
          "PDF attached. On-device text recognition currently reads images, so enter the details manually. The PDF uploads only after you save.",
        progress: 0,
        suggestions: {},
      });
      return;
    }

    setActivityScan({
      phase: "scanning",
      label: "Preparing the image on this device",
      progress: 0.02,
      suggestions: {},
    });

    try {
      const ocrFile =
        file.type === imageType
          ? file
          : new File([file], file.name, {
              type: imageType,
              lastModified: file.lastModified,
            });
      const result = await scanCertificateImage(ocrFile, (scanProgress) => {
        if (activityScanSequence.current !== sequence) return;
        setActivityScan((current) => ({
          ...current,
          phase: "scanning",
          label: scanProgress.label,
          progress: scanProgress.progress,
        }));
      });
      if (activityScanSequence.current !== sequence) return;

      const suggestions =
        result.confidence >= 25 ? result.suggestions : {};
      const suggestionCount = Object.values(suggestions).filter(
        (value) => value !== undefined,
      ).length;

      if (suggestionCount) {
        setActivityDraft((current) => ({
          title: suggestions.title ?? current.title,
          provider: suggestions.provider ?? current.provider,
          completionDate:
            suggestions.completionDate ?? current.completionDate,
          totalUnits:
            suggestions.credits !== undefined
              ? String(suggestions.credits)
              : current.totalUnits,
        }));
        setActivityScan({
          phase: "success",
          label: `Found ${suggestionCount} ${
            suggestionCount === 1 ? "detail" : "details"
          }. Review every highlighted suggestion before saving.`,
          progress: 1,
          suggestions,
        });
      } else {
        setActivityScan({
          phase: "manual",
          label:
            result.recognizedTextLength > 0
              ? "Text was found, but no clearly labeled details were reliable enough to suggest. Enter them manually."
              : "No readable text was found. Enter the details manually; the image is still attached.",
          progress: 1,
          suggestions: {},
        });
      }
    } catch {
      if (activityScanSequence.current !== sequence) return;
      setActivityScan({
        phase: "error",
        label:
          "This image could not be read on this device. Enter the details manually; the image is still attached.",
        progress: 0,
        suggestions: {},
      });
    }
  }

  function removeActivityEvidence() {
    activityScanSequence.current += 1;
    setActivityEvidenceFile(null);
    setActivityScan({
      phase: "idle",
      label: "",
      progress: 0,
      suggestions: {},
    });
  }

  async function handleActivitySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const credentialId = String(form.get("credentialId") ?? "");
    const totalUnits = Number(form.get("totalUnits"));
    const credential =
      workspace?.credentials.find((item) => item.id === credentialId) ?? null;
    let nremtMatches: RequirementMatchPayload[] | undefined;
    if (isNremtCredential(credential)) {
      try {
        nremtMatches = nremtRequirementMatchPayload(
          form,
          credential!,
          totalUnits,
        );
      } catch (matchError) {
        setError(
          matchError instanceof Error
            ? matchError.message
            : "Review the National Registry credit allocation.",
        );
        return;
      }
    }
    const evidenceFile = activityEvidenceFile;
    const hasEvidenceFile = Boolean(evidenceFile && evidenceFile.size > 0);
    const result = await runAction(
      "addActivity",
      {
        title: String(form.get("title") ?? ""),
        provider: String(form.get("provider") ?? ""),
        completionDate: String(form.get("completionDate") ?? ""),
        totalUnits,
        credentialId,
        ...(nremtMatches
          ? {
              requirementMatches: nremtMatches,
              acceptedEducationAttested: true,
            }
          : {
              requirementIds: form
                .getAll("requirementIds")
                .map((value) => String(value))
                .filter(Boolean),
            }),
        allocatedUnits: totalUnits,
        evidenceStatus: String(form.get("evidenceStatus") ?? "missing"),
        portalCarryoverAttested:
          form.get("portalCarryoverAttested") === "on",
      },
      `${compactNumber(totalUnits)} ${
        totalUnits === 1 ? "credit" : "credits"
      } added to your record.`,
    );
    if (result?.id && hasEvidenceFile && evidenceFile) {
      const uploaded = await uploadEvidence(result.id, evidenceFile);
      if (!uploaded) {
        finishSavedActivityEntry();
        formElement.reset();
        setToast({
          message:
            "Activity saved, but the proof file did not upload. You can add it from Records.",
        });
        return;
      }
      setToast({
        message: `${compactNumber(totalUnits)} ${
          totalUnits === 1 ? "credit" : "credits"
        } and proof saved.`,
      });
    }
    if (result) {
      finishSavedActivityEntry();
      formElement.reset();
    }
  }

  async function uploadEvidence(activityId: string, file: File) {
    setEvidencePending(true);
    setError("");
    try {
      const payload = new FormData();
      payload.set("activityId", activityId);
      payload.set("file", file);
      const response = await fetch("/api/evidence", {
        method: "POST",
        body: payload,
      });
      const result = (await response.json()) as {
        evidence?: EvidenceFile;
        error?: string;
      };
      if (!response.ok || !result.evidence) {
        throw new Error(result.error || "The proof file did not upload.");
      }
      await loadWorkspace();
      setEvidenceFiles((current) => [result.evidence!, ...current]);
      return true;
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "The proof file did not upload.",
      );
      return false;
    } finally {
      setEvidencePending(false);
    }
  }

  async function openEvidence(activity: Activity) {
    setEvidenceActivity(activity);
    setEvidenceFiles([]);
    setEvidencePending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/evidence?activityId=${encodeURIComponent(activity.id)}`,
        { headers: { accept: "application/json" }, cache: "no-store" },
      );
      const result = (await response.json()) as {
        evidence?: EvidenceFile[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(result.error || "The proof files could not be loaded.");
      }
      setEvidenceFiles(result.evidence ?? []);
    } catch (evidenceError) {
      setError(
        evidenceError instanceof Error
          ? evidenceError.message
          : "The proof files could not be loaded.",
      );
    } finally {
      setEvidencePending(false);
    }
  }

  async function handleEvidenceUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!evidenceActivity) return;
    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setError("Choose a PDF or image to upload.");
      return;
    }
    const uploaded = await uploadEvidence(evidenceActivity.id, file);
    if (uploaded) {
      event.currentTarget.reset();
      setToast({ message: "Proof saved securely." });
    }
  }

  async function deleteEvidence(evidence: EvidenceFile) {
    setEvidencePending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/evidence/${encodeURIComponent(evidence.id)}`,
        { method: "DELETE" },
      );
      const result = (await response.json()) as {
        error?: string;
        code?: string;
      };
      if (!response.ok) {
        if (result.code === "evidence_delete_retry") {
          setEvidenceFiles((current) =>
            current.map((item) =>
              item.id === evidence.id
                ? { ...item, deletionPending: true }
                : item,
            ),
          );
        }
        throw new Error(result.error || "The proof file could not be removed.");
      }
      setEvidenceFiles((current) =>
        current.filter((item) => item.id !== evidence.id),
      );
      await loadWorkspace();
      setToast({ message: "Proof removed." });
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "The proof file could not be removed.",
      );
    } finally {
      setEvidencePending(false);
    }
  }

  async function handleCredentialSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const rule =
      workspace?.catalog.find(
        (item) => item.id === String(form.get("ruleSetId") ?? ""),
      ) ?? null;
    const customCategoryUnits = Number(form.get("categoryUnits") ?? 0);
    const categories = customCredential
      ? customCategoryUnits > 0
        ? [
            {
              name: String(form.get("categoryName") ?? "General"),
              requiredUnits: customCategoryUnits,
            },
          ]
        : []
      : (rule?.categories ?? []).map((category) => ({
          name: category.name,
          requiredUnits: category.requiredUnits,
        }));
    const totalRequired = customCredential
      ? Number(form.get("totalRequired") ?? 0)
      : (rule?.totalUnits ?? 0);
    const applicabilityChoices = (rule?.categories ?? [])
      .filter((category) => category.applicability === "conditional")
      .map((category) => ({
        ruleCategoryId: category.id,
        status: String(
          form.get(`applicability:${category.id}`) ?? "needs_confirmation",
        ),
      }));

    const success = await runAction(
      "createCredential",
      {
        ruleSetId: rule?.id ?? null,
        credentialName: customCredential
          ? String(form.get("credentialName") ?? "")
          : (rule?.credentialName ?? ""),
        profession: customCredential
          ? String(form.get("profession") ?? "")
          : (rule?.profession ?? ""),
        jurisdiction: customCredential
          ? String(form.get("jurisdiction") ?? "")
          : (rule?.jurisdiction ?? ""),
        issuer: customCredential
          ? String(form.get("issuer") ?? "")
          : (rule?.issuer ?? ""),
        cycleStart: String(form.get("cycleStart") ?? ""),
        deadline: String(form.get("deadline") ?? ""),
        templateEligibilityAttested:
          rule?.profession === "Pharmacy" ||
          rule?.profession === "Nursing"
            ? form.get("templateEligibilityAttested") === "on"
            : undefined,
        totalRequired,
        unitLabel: customCredential
          ? String(form.get("unitLabel") ?? "hours")
          : (rule?.unitLabel ?? "hours"),
        categories,
        applicabilityChoices,
        officialDatesAttested: requiresOfficialCatalogDates(rule)
          ? form.get("officialDatesAttested") === "on"
          : undefined,
      },
      "Credential added. Your renewal plan is ready.",
    );

    if (success) {
      setCredentialOpen(false);
      setSelectedRuleId("");
      setCatalogQuery("");
      setCustomCredential(false);
    }
  }

  async function handleSubmission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCredential) return;
    const form = new FormData(event.currentTarget);
    const success = await runAction(
      "markSubmitted",
      {
        credentialId: selectedCredential.id,
        submissionDate: String(form.get("submissionDate") ?? ""),
        confirmationNumber: String(form.get("confirmationNumber") ?? ""),
        complianceAttested:
          isIsc2AutomaticRenewalCredential(selectedCredential) ||
          isCompliancePeriodCredential(selectedCredential) ||
          isNremtCredential(selectedCredential)
            ? form.get("complianceAttested") === "on"
            : undefined,
        lateReinstatementAttested:
          isNremtCredential(selectedCredential) &&
          String(form.get("submissionDate") ?? "") >
            selectedCredential.deadline
            ? form.get("lateReinstatementAttested") === "on"
            : undefined,
      },
      isIsc2AutomaticRenewalCredential(selectedCredential)
        ? "ISC2 dashboard checkpoint saved. Confirm renewal only after the new dates appear."
        : isCompliancePeriodCredential(selectedCredential)
          ? "Compliance-period milestone saved. Confirm the next period from the official record."
          : isNremtCredential(selectedCredential)
            ? "National Registry application logged. Keep the dashboard approval with your record."
            : "Submission logged. Keep the confirmation until your renewal is accepted.",
    );
    if (success) setSubmissionOpen(false);
  }

  function openSubmission() {
    setNremtSubmissionDate(todayIso());
    setSubmissionOpen(true);
  }

  async function handleAcceptance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCredential) return;
    const form = new FormData(event.currentTarget);
    const result = await runAction(
      "markRenewalAccepted",
      {
        credentialId: selectedCredential.id,
        acceptedAt: String(form.get("acceptedAt") ?? ""),
        reference: String(form.get("reference") ?? ""),
        nextCycleStart: String(form.get("nextCycleStart") ?? ""),
        nextDeadline: String(form.get("nextDeadline") ?? ""),
        nextRuleSetId: requiresCurrentNextTemplate(selectedCredential)
          ? String(form.get("nextRuleSetId") ?? "")
          : isNremtCredential(selectedCredential)
            ? selectedNremtNextRule?.id
            : undefined,
        officialDatesAttested:
          requiresOfficialNextPeriodAttestation(selectedCredential)
            ? form.get("officialDatesAttested") === "on"
            : undefined,
        templateEligibilityAttested:
          isManagedPharmacistCredential(selectedCredential) ||
          isManagedNursingCredential(selectedCredential)
          ? form.get("templateEligibilityAttested") === "on"
          : undefined,
      },
      isCompliancePeriodCredential(selectedCredential)
        ? "Compliance period completed. Your next period is ready."
        : isNremtCredential(selectedCredential)
          ? "National Registry renewal confirmed. Your dashboard dates are preserved."
          : "Renewal accepted. Your next cycle is ready.",
    );
    if (result) {
      setAcceptanceOpen(false);
      if (result.id) setSelectedCredentialId(result.id);
    }
  }

  async function handleReminderPreferences(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const leadDays = form
      .getAll("leadDays")
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0);
    const result = await runAction(
      "updateReminderPreferences",
      {
        inAppEnabled: form.get("inAppEnabled") === "on",
        leadDays,
        timeZone: String(form.get("timeZone") ?? "UTC"),
      },
      "Reminder check-ins updated.",
    );
    if (result) setRemindersOpen(false);
  }

  async function setReminderState(
    reminder: Reminder,
    status: "dismissed" | "snoozed",
  ) {
    await runAction(
      "setReminderState",
      {
        reminderKey: reminder.key,
        credentialId: reminder.credentialId,
        status,
        snoozedUntil:
          status === "snoozed" ? addDaysIso(todayIso(), 7) : null,
      },
      status === "snoozed"
        ? "Reminder snoozed for one week."
        : "Reminder dismissed for this cycle.",
    );
  }

  async function handleAllocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!allocationActivity) return;
    const form = new FormData(event.currentTarget);
    const allocatedUnits = Number(form.get("allocatedUnits"));
    let nremtMatches: RequirementMatchPayload[] | undefined;
    if (isNremtCredential(allocationCredential)) {
      try {
        nremtMatches = nremtRequirementMatchPayload(
          form,
          allocationCredential!,
          allocatedUnits,
        );
      } catch (matchError) {
        setError(
          matchError instanceof Error
            ? matchError.message
            : "Review the National Registry credit allocation.",
        );
        return;
      }
    }
    const result = await runAction(
      "addActivityAllocation",
      {
        activityId: allocationActivity.id,
        credentialId: String(form.get("credentialId") ?? ""),
        ...(nremtMatches
          ? {
              requirementMatches: nremtMatches,
              acceptedEducationAttested: true,
            }
          : {
              requirementIds: form
                .getAll("requirementIds")
                .map((value) => String(value))
                .filter(Boolean),
            }),
        allocatedUnits,
        portalCarryoverAttested:
          form.get("portalCarryoverAttested") === "on",
      },
      `Activity applied to another credential.`,
    );
    if (result) {
      setAllocationActivity(null);
      setAllocationCredentialId("");
    }
  }

  async function handleClassificationRepair(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (!classificationRepair) return;
    const form = new FormData(event.currentTarget);
    let nremtMatches: RequirementMatchPayload[] | undefined;
    if (isNremtCredential(classificationCredential)) {
      try {
        nremtMatches = nremtRequirementMatchPayload(
          form,
          classificationCredential!,
          classificationRepair.allocation.allocatedUnits,
        );
      } catch (matchError) {
        setError(
          matchError instanceof Error
            ? matchError.message
            : "Review the National Registry credit allocation.",
        );
        return;
      }
    }
    const result = await runAction(
      "updateActivityAllocationRequirements",
      {
        allocationId: classificationRepair.allocation.id,
        ...(nremtMatches
          ? {
              requirementMatches: nremtMatches,
              acceptedEducationAttested: true,
            }
          : {
              requirementIds: form
                .getAll("requirementIds")
                .map((value) => String(value))
                .filter(Boolean),
            }),
        portalCarryoverAttested:
          form.get("portalCarryoverAttested") === "on",
      },
      "Activity classification updated and credit recalculated.",
    );
    if (result) setClassificationRepair(null);
  }

  async function setRequirementApplicability(
    credentialId: string,
    requirement: Requirement,
    applicabilityStatus: "applies" | "not_applicable",
  ) {
    await runAction(
      "updateRequirementApplicability",
      {
        credentialId,
        choices: [
          {
            requirementId: requirement.id,
            status: applicabilityStatus,
          },
        ],
      },
      applicabilityStatus === "applies"
        ? `${requirement.name} added to this cycle.`
        : `${requirement.name} marked not applicable for this cycle.`,
    );
  }

  async function updateActivityRecord(input: {
    title: string;
    provider: string;
    completionDate: string;
    totalUnits: number;
    acceptedEducationAttested?: boolean;
  }) {
    if (!editingActivity) return;
    const result = await runAction(
      "updateActivity",
      {
        activityId: editingActivity.id,
        expectedRevision: editingActivity.revision,
        ...input,
      },
      "Learning record corrected.",
    );
    if (result) setEditingActivity(null);
  }

  async function archiveActivityRecord(activity: Activity) {
    const result = await runAction(
      "archiveActivity",
      {
        activityId: activity.id,
        expectedRevision: activity.revision,
      },
      "Learning record archived.",
    );
    if (!result) return;
    setEditingActivity(null);
    setToast({
      message: "Learning record archived. Its proof remains saved.",
      undo: () => {
        void runAction(
          "restoreActivity",
          {
            activityId: activity.id,
            expectedRevision: activity.revision + 1,
          },
          "Learning record restored.",
        );
      },
    });
    window.setTimeout(
      () => document.getElementById("archived-records-summary")?.focus(),
      0,
    );
  }

  async function restoreActivityRecord(activity: Activity) {
    const result = await runAction(
      "restoreActivity",
      {
        activityId: activity.id,
        expectedRevision: activity.revision,
      },
      "Learning record restored.",
    );
    if (result) {
      window.setTimeout(
        () => document.getElementById("records-summary")?.focus(),
        0,
      );
    }
  }

  async function savePersonalTask(input: {
    title: string;
    dueDate: string;
  }) {
    if (!taskEditor) return;
    const { credential, task } = taskEditor;
    const result = await runAction(
      task ? "updatePersonalTask" : "createPersonalTask",
      task
        ? {
            taskId: task.id,
            expectedRevision: task.revision,
            ...input,
          }
        : {
            credentialId: credential.id,
            ...input,
          },
      task ? "Personal task updated." : "Personal task added.",
    );
    if (result) setTaskEditor(null);
  }

  async function archivePersonalTask(task: RenewalTask) {
    if (!task.isPersonal) return;
    const result = await runAction(
      "archivePersonalTask",
      {
        taskId: task.id,
        expectedRevision: task.revision,
      },
      "Personal task archived.",
    );
    if (!result) return;
    setTaskEditor(null);
    setToast({
      message: "Personal task archived.",
      undo: () => {
        void runAction(
          "restorePersonalTask",
          {
            taskId: task.id,
            expectedRevision: task.revision + 1,
          },
          "Personal task restored.",
        );
      },
    });
    window.setTimeout(
      () => document.getElementById("archived-tasks-summary")?.focus(),
      0,
    );
  }

  async function restorePersonalTask(task: RenewalTask) {
    if (!task.isPersonal) return;
    const result = await runAction(
      "restorePersonalTask",
      {
        taskId: task.id,
        expectedRevision: task.revision,
      },
      "Personal task restored.",
    );
    if (result) {
      window.setTimeout(
        () => document.getElementById("renewal-checklist")?.focus(),
        0,
      );
    }
  }

  async function toggleTask(task: RenewalTask) {
    const completed = task.status !== "completed";
    const success = await runAction(
      "toggleTask",
      {
        taskId: task.id,
        completed,
        expectedRevision: task.revision,
      },
      completed ? "Task checked off." : "Task reopened.",
    );
    if (success) {
      setToast({
        message: completed ? "Task checked off." : "Task reopened.",
        undo: () => {
          void runAction(
            "toggleTask",
            {
              taskId: task.id,
              completed: !completed,
              expectedRevision: task.revision + 1,
            },
            "Change undone.",
          );
        },
      });
    }
  }

  async function claimWeeklyQuest(quest: WeeklyQuest) {
    if (!workspace) return;
    await runAction(
      "claimWeeklyQuest",
      {
        questKey: quest.key,
        weekStart: workspace.progression.week.startsOn,
      },
      `${quest.rewardXp} XP claimed. Your real compliance work moved you forward.`,
    );
  }

  async function updateWeeklyGoal(weeklyGoal: number) {
    await runAction(
      "updateWeeklyGoal",
      { weeklyGoal },
      weeklyGoal === workspace?.profile.weeklyGoal
        ? "Your current weekly rhythm will continue."
        : "Your next weekly rhythm is scheduled.",
    );
  }

  const userName = workspace?.user.displayName ?? "Professional";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <DesktopSidebar
        view={view}
        onView={setView}
        onAdd={openActivityEntry}
        hasCredential={Boolean(selectedCredential)}
      />

      <div className="app-stage">
        <header className="mobile-header">
          <Brand />
          <button
            className="avatar-button"
            type="button"
            aria-label="Open account"
            onClick={() => setView("account")}
          >
            {firstName(userName).slice(0, 1).toUpperCase()}
          </button>
        </header>

        <main id="main-content" className="main-content">
          {!isOnline ? (
            <div className="offline-banner" role="status">
              <span aria-hidden="true">⌁</span>
              <div>
                <strong>Offline — your cloud record is protected</strong>
                <small>
                  Course text can remain in a browser-saved draft. Reconnect
                  to save changes or upload proof.
                </small>
              </div>
            </div>
          ) : null}

          {error && workspace ? (
            <div className="error-banner" role="alert">
              <div>
                <strong>Something needs attention</strong>
                <span>{error}</span>
              </div>
              <button type="button" onClick={() => void loadWorkspace()}>
                Try again
              </button>
            </div>
          ) : null}

          {!workspace ? (
            !isOnline ? (
              <OfflineWorkspace />
            ) : workspaceLoadFailed ? (
              <WorkspaceLoadFailure
                status={workspaceLoadFailureStatus}
                message={error}
                onRetry={() => void loadWorkspace()}
              />
            ) : (
              <LoadingDashboard />
            )
          ) : view === "today" ? (
            <TodayView
              workspace={workspace}
              credential={selectedCredential}
              onAddActivity={openActivityEntry}
              onAddCredential={() => setCredentialOpen(true)}
              onViewCredentials={() => setView("credentials")}
              onViewRecords={() => setView("records")}
              onSubmit={openSubmission}
              onAccept={() => setAcceptanceOpen(true)}
              onReminders={() => setRemindersOpen(true)}
              onReminderState={(reminder, status) =>
                void setReminderState(reminder, status)
              }
              onAddReminderToCalendar={(reminder) =>
                void addReminderToCalendar(reminder)
              }
              onToggleTask={toggleTask}
              onAddPersonalTask={(credential) => {
                setError("");
                setTaskEditor({ credential, task: null });
              }}
              onEditPersonalTask={(credential, task) => {
                setError("");
                setTaskEditor({ credential, task });
              }}
              onRestorePersonalTask={(task) =>
                void restorePersonalTask(task)
              }
              taskActionsDisabled={pending || !isOnline}
              onClaimQuest={(quest) => void claimWeeklyQuest(quest)}
              progressionPending={pending}
              onRequirementApplicability={(requirement, status) =>
                selectedCredential
                  ? void setRequirementApplicability(
                      selectedCredential.id,
                      requirement,
                      status,
                    )
                  : undefined
              }
            />
          ) : view === "credentials" ? (
            <CredentialsView
              credentials={workspace.credentials}
              selectedId={selectedCredential?.id ?? ""}
              onSelect={(id) => setSelectedCredentialId(id)}
              onAdd={() => setCredentialOpen(true)}
              onSubmit={openSubmission}
              onAccept={() => setAcceptanceOpen(true)}
              onReminders={() => setRemindersOpen(true)}
              onAddToCalendar={(credential) =>
                void addCredentialToCalendar(credential)
              }
              onRequirementApplicability={(
                credentialId,
                requirement,
                status,
              ) =>
                void setRequirementApplicability(
                  credentialId,
                  requirement,
                  status,
                )
              }
            />
          ) : view === "records" ? (
            <RecordsView
              activities={workspace.activities}
              archivedActivities={workspace.archivedActivities}
              credentials={workspace.credentials}
              onAdd={openActivityEntry}
              onEdit={(activity) => {
                setError("");
                setEditingActivity(activity);
              }}
              onRestore={(activity) => void restoreActivityRecord(activity)}
              actionsDisabled={pending || !isOnline}
              onEvidence={(activity) => void openEvidence(activity)}
              onAllocate={(activity) => {
                const existingIds = new Set(
                  allocationsFor(activity).map(
                    (allocation) => allocation.credentialId,
                  ),
                );
                const firstEligible = workspace.credentials.find(
                  (credential) =>
                    credential.status !== "renewed" &&
                    !existingIds.has(credential.id),
                );
                setAllocationCredentialId(firstEligible?.id ?? "");
                setAllocationActivity(activity);
              }}
              onClassify={(activity, allocation) =>
                setClassificationRepair({ activity, allocation })
              }
            />
          ) : (
            <AccountView
              workspace={workspace}
              onReminders={() => setRemindersOpen(true)}
              onWeeklyGoal={(weeklyGoal) =>
                void updateWeeklyGoal(weeklyGoal)
              }
              weeklyGoalPending={pending}
              isStandalone={isStandalone}
              installAvailable={Boolean(installPrompt)}
              onInstall={() => void handleInstallApp()}
              onAddAllCheckIns={() => void addAllCheckInsToCalendar()}
            />
          )}
        </main>
      </div>

      <MobileNavigation
        view={view}
        onView={setView}
        onAdd={openActivityEntry}
        hasCredential={Boolean(selectedCredential)}
      />

      {activityOpen && workspace ? (
        <Modal
          title="Log completed learning"
          eyebrow="Quick add"
          onClose={closeActivityEntry}
        >
          {activityCredentials.length === 0 ? (
            <EmptyModalState
              title="Add an active credential first"
              body="Credits need an open renewal cycle so License Lantern knows where to count them."
              action="Set up credential"
              onAction={() => {
                closeActivityEntry();
                setCredentialOpen(true);
              }}
            />
          ) : (
            <form className="form-stack" onSubmit={handleActivitySubmit}>
              <section
                className="certificate-capture"
                aria-labelledby="certificate-capture-title"
              >
                <div className="certificate-capture-heading">
                  <span className="capture-mark" aria-hidden="true">
                    ◎
                  </span>
                  <div>
                    <strong id="certificate-capture-title">
                      Start with the certificate
                    </strong>
                    <p>
                      Take a photo and License Lantern will suggest the details
                      it can read.
                    </p>
                  </div>
                </div>
                <div className="capture-actions">
                  <label className="capture-button capture-button-primary">
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      capture="environment"
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        void handleActivityEvidenceSelection(file);
                      }}
                    />
                    <span aria-hidden="true">◉</span>
                    Take photo
                  </label>
                  <label className="capture-button">
                    <input
                      type="file"
                      accept=".pdf,image/jpeg,image/png,image/webp"
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        void handleActivityEvidenceSelection(file);
                      }}
                    />
                    Choose photo or PDF
                  </label>
                </div>
                <p className="capture-privacy">
                  On-device scan: the reader and English model load from
                  License Lantern. The proof uploads only after Save activity;
                  suggested field values may be saved unencrypted in this
                  browser draft.
                </p>
                {activityDraftRestored ||
                hasMeaningfulActivityDraft(activityDraft) ? (
                  <div
                    className={`draft-safety-note ${
                      activityDraftRestored ? "restored" : ""
                    } ${activityDraftPersistenceStatus}`}
                    role="status"
                    aria-live="polite"
                  >
                    <span aria-hidden="true">
                      {activityDraftRestored ? "↺" : "▣"}
                    </span>
                    <div>
                      <strong>
                        {activityDraftPersistenceStatus === "saved"
                          ? "Saved in this browser"
                          : activityDraftPersistenceStatus === "unavailable"
                            ? "Browser draft unavailable"
                            : "Saving in this browser"}
                      </strong>
                      <small>
                        {activityDraftPersistenceStatus === "unavailable"
                          ? "This browser blocked local draft storage. Keep the form open until you can save to the cloud; proof files and raw OCR text were not placed in browser storage."
                          : activityDraftPersistenceStatus === "saved"
                            ? "Draft fields—including OCR-derived suggestions placed into them—are stored unencrypted in this browser. Proof files and raw OCR text are not saved there. Drafts are cleared on save or discard; drafts older than 30 days are cleared when this workspace next loads."
                            : "Draft fields are being written unencrypted to this browser. Proof files and raw OCR text are not included."}
                      </small>
                    </div>
                    <button
                      type="button"
                      onClick={discardActivityDraft}
                      disabled={pending}
                    >
                      Discard draft
                    </button>
                  </div>
                ) : null}
                {activityEvidenceFile ? (
                  <div className="capture-file">
                    <div>
                      <strong>{activityEvidenceFile.name}</strong>
                      <small>
                        {formatFileSize(activityEvidenceFile.size)} · kept as
                        your proof
                      </small>
                    </div>
                    <button
                      type="button"
                      onClick={removeActivityEvidence}
                      disabled={pending}
                    >
                      Remove
                    </button>
                  </div>
                ) : null}
                {activityScan.phase !== "idle" ? (
                  <div
                    className={`capture-status ${activityScan.phase}`}
                    role="status"
                    aria-live="polite"
                  >
                    {scanningActivityEvidence ? (
                      <div
                        className="capture-progress"
                        role="progressbar"
                        aria-label={activityScan.label}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(
                          activityScan.progress * 100,
                        )}
                      >
                        <span
                          style={{
                            width: `${Math.round(
                              activityScan.progress * 100,
                            )}%`,
                          }}
                        />
                      </div>
                    ) : (
                      <span className="capture-status-mark" aria-hidden="true">
                        {activityScan.phase === "success" ? "✓" : "i"}
                      </span>
                    )}
                    <p>{activityScan.label}</p>
                  </div>
                ) : null}
              </section>
              <label
                className={`field ${
                  activityScan.suggestions.title ? "scan-suggested" : ""
                }`}
              >
                <span>Course, conference, or activity</span>
                <input
                  name="title"
                  placeholder="e.g., Ethics in clinical practice"
                  value={activityDraft.title}
                  maxLength={ACTIVITY_DRAFT_TITLE_MAX_LENGTH}
                  disabled={scanningActivityEvidence}
                  onChange={(event) =>
                    setActivityDraft((current) => ({
                      ...current,
                      title: event.currentTarget.value,
                    }))
                  }
                  required
                />
                {activityScan.suggestions.title ? (
                  <small className="scan-suggestion-note">
                    Suggested from the scan — confirm or edit it.
                  </small>
                ) : null}
              </label>
              <div className="form-grid">
                <label
                  className={`field ${
                    activityScan.suggestions.completionDate
                      ? "scan-suggested"
                      : ""
                  }`}
                >
                  <span>Completion date</span>
                  <input
                    name="completionDate"
                    type="date"
                    value={activityDraft.completionDate}
                    disabled={scanningActivityEvidence}
                    onChange={(event) =>
                      setActivityDraft((current) => ({
                        ...current,
                        completionDate: event.currentTarget.value,
                      }))
                    }
                    min={
                      confirmedCarryoverWindowStart(activityCredential) ??
                      activityCredential?.cycleStart
                    }
                    max={activityCredential?.deadline}
                    required
                  />
                  <small
                    className={
                      activityScan.suggestions.completionDate
                        ? "scan-suggestion-note"
                        : undefined
                    }
                  >
                    {confirmedCarryoverWindowStart(activityCredential)
                      ? "Use a current-cycle date, or the actual prior-cycle date when selecting confirmed carryover."
                      : activityScan.suggestions.completionDate
                        ? "Suggested from the scan — confirm it falls within this renewal cycle."
                        : "Must fall within the selected renewal cycle."}
                  </small>
                </label>
                <label
                  className={`field ${
                    activityScan.suggestions.credits ? "scan-suggested" : ""
                  }`}
                >
                  <span>Credits earned</span>
                  <input
                    name="totalUnits"
                    type="number"
                    min="0.1"
                    max={ACTIVITY_DRAFT_MAX_UNITS}
                    step="0.1"
                    inputMode="decimal"
                    placeholder="1.0"
                    value={activityDraft.totalUnits}
                    disabled={scanningActivityEvidence}
                    onChange={(event) =>
                      setActivityDraft((current) => ({
                        ...current,
                        totalUnits: event.currentTarget.value,
                      }))
                    }
                    required
                  />
                  {activityScan.suggestions.credits ? (
                    <small className="scan-suggestion-note">
                      Suggested from the scan — confirm the units.
                    </small>
                  ) : null}
                </label>
              </div>
              <label className="field">
                <span>Apply to credential</span>
                <select
                  name="credentialId"
                  value={activityCredential?.id ?? ""}
                  required
                  aria-invalid={Boolean(activityDraftCredentialWarning)}
                  aria-describedby={
                    activityDraftCredentialWarning
                      ? "activity-credential-warning"
                      : undefined
                  }
                  onChange={(event) => {
                    setSelectedCredentialId(event.currentTarget.value);
                    setActivityDraftCredentialWarning("");
                  }}
                >
                  {!activityCredential ? (
                    <option value="" disabled>
                      Choose an active credential
                    </option>
                  ) : null}
                  {activityCredentials.map((credential) => (
                    <option key={credential.id} value={credential.id}>
                      {credential.credentialName} · {credential.jurisdiction}
                    </option>
                  ))}
                </select>
                {activityDraftCredentialWarning ? (
                  <small
                    className="field-warning"
                    id="activity-credential-warning"
                    role="alert"
                  >
                    {activityDraftCredentialWarning}
                  </small>
                ) : null}
              </label>
              {isNremtCredential(activityCredential) ? (
                <NremtRequirementAllocator
                  key={activityCredential?.id}
                  credential={activityCredential!}
                  availableUnits={Number(activityDraft.totalUnits) || 0}
                />
              ) : (
                <RequirementPicker
                  key={activityCredential?.id}
                  credential={activityCredential}
                />
              )}
              {isPriorPeriodCarryoverEntry(
                activityDraft.completionDate,
                activityCredential,
              ) ? (
                <label className="switch-row">
                  <span>
                    <strong>
                      The issuing portal posted this carryover
                    </strong>
                    <small>
                      I selected the portal-confirmed carryover source plus
                      only compatible classifiers, entered the actual
                      eligible prior-period date, and will retain the portal
                      record. A reference or uploaded proof is required
                      before cycle completion.
                    </small>
                  </span>
                  <input
                    name="portalCarryoverAttested"
                    type="checkbox"
                    required
                  />
                </label>
              ) : null}
              <label
                className={`field ${
                  activityScan.suggestions.provider ? "scan-suggested" : ""
                }`}
              >
                <span>
                  Provider or organizer{" "}
                  {!isNremtCredential(activityCredential) ? (
                    <em>Optional</em>
                  ) : null}
                </span>
                <input
                  name="provider"
                  placeholder={
                    isNremtCredential(activityCredential)
                      ? "State EMS-approved, CAPCE, or other accepted provider"
                      : "Organization or conference name"
                  }
                  value={activityDraft.provider}
                  maxLength={ACTIVITY_DRAFT_PROVIDER_MAX_LENGTH}
                  disabled={scanningActivityEvidence}
                  onChange={(event) =>
                    setActivityDraft((current) => ({
                      ...current,
                      provider: event.currentTarget.value,
                    }))
                  }
                  required={isNremtCredential(activityCredential)}
                />
                {activityScan.suggestions.provider ? (
                  <small className="scan-suggestion-note">
                    Suggested from the scan — confirm or edit it.
                  </small>
                ) : null}
              </label>
              <fieldset className="segmented-field">
                <legend>Proof requirement</legend>
                <label>
                  <input
                    type="radio"
                    name="evidenceStatus"
                    value="missing"
                    defaultChecked
                  />
                  <span>Add later</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="evidenceStatus"
                    value="not_required"
                    disabled={isPriorPeriodCarryoverEntry(
                      activityDraft.completionDate,
                      activityCredential,
                    )}
                  />
                  <span>Not required</span>
                </label>
              </fieldset>
              <div className="form-actions">
                <button
                  className="button button-ghost"
                  type="button"
                  onClick={() => closeActivityEntry()}
                >
                  Cancel
                </button>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={pending || scanningActivityEvidence || !isOnline}
                >
                  {pending
                    ? "Saving…"
                    : scanningActivityEvidence
                      ? "Reading certificate…"
                      : !isOnline
                        ? "Reconnect to save"
                        : "Save activity"}
                </button>
              </div>
            </form>
          )}
        </Modal>
      ) : null}

      {editingActivity ? (
        <ActivityEditorModal
          key={`${editingActivity.id}:${editingActivity.revision}`}
          activity={editingActivity}
          error={error}
          pending={pending}
          isOnline={isOnline}
          onClose={() => {
            setEditingActivity(null);
            setError("");
          }}
          onSave={(input) => void updateActivityRecord(input)}
          onArchive={() => void archiveActivityRecord(editingActivity)}
        />
      ) : null}

      {taskEditor ? (
        <PersonalTaskEditorModal
          key={`${taskEditor.task?.id ?? "new"}:${
            taskEditor.task?.revision ?? 0
          }`}
          credential={taskEditor.credential}
          task={taskEditor.task}
          error={error}
          pending={pending}
          isOnline={isOnline}
          onClose={() => {
            setTaskEditor(null);
            setError("");
          }}
          onSave={(input) => void savePersonalTask(input)}
          onArchive={
            taskEditor.task
              ? () => {
                  const task = taskEditor.task;
                  if (task) void archivePersonalTask(task);
                }
              : undefined
          }
        />
      ) : null}

      {credentialOpen && workspace ? (
        <Modal
          title="Set up a credential"
          eyebrow="Renewal plan"
          onClose={() => setCredentialOpen(false)}
        >
          <form className="form-stack" onSubmit={handleCredentialSubmit}>
            <div className="mode-switch" aria-label="Credential setup mode">
              <button
                className={!customCredential ? "active" : ""}
                type="button"
                aria-pressed={!customCredential}
                onClick={() => setCustomCredential(false)}
              >
                Use source-linked template
              </button>
              <button
                className={customCredential ? "active" : ""}
                type="button"
                aria-pressed={customCredential}
                onClick={() => setCustomCredential(true)}
              >
                Enter my own
              </button>
            </div>

            {customCredential ? (
              <>
                <div className="form-grid">
                  <label className="field">
                    <span>Profession</span>
                    <input name="profession" required placeholder="Nurse" />
                  </label>
                  <label className="field">
                    <span>State or jurisdiction</span>
                    <input name="jurisdiction" required placeholder="PA" />
                  </label>
                </div>
                <label className="field">
                  <span>Credential or license</span>
                  <input
                    autoFocus
                    name="credentialName"
                    required
                    placeholder="Registered Nurse"
                  />
                </label>
                <label className="field">
                  <span>Issuing organization <em>Optional</em></span>
                  <input name="issuer" placeholder="State licensing board" />
                </label>
                <div className="form-grid form-grid-three">
                  <label className="field">
                    <span>Total required</span>
                    <input
                      name="totalRequired"
                      type="number"
                      min="0"
                      step="0.1"
                      inputMode="decimal"
                      required
                    />
                  </label>
                  <label className="field">
                    <span>Unit label</span>
                    <input name="unitLabel" defaultValue="hours" required />
                  </label>
                  <label className="field">
                    <span>Special category</span>
                    <input name="categoryName" defaultValue="Ethics" />
                  </label>
                </div>
                <label className="field">
                  <span>Special-category minimum</span>
                  <input
                    name="categoryUnits"
                    type="number"
                    min="0"
                    step="0.1"
                    inputMode="decimal"
                    defaultValue="0"
                  />
                </label>
              </>
            ) : (
              <>
                <label className="field">
                  <span>Find a credential template</span>
                  <input
                    autoFocus
                    type="search"
                    value={catalogQuery}
                    onChange={(event) => {
                      setCatalogQuery(event.currentTarget.value);
                      setSelectedRuleId("");
                    }}
                    placeholder="Search profession, license, or state"
                  />
                  <small>
                    {workspace.catalog.length} researched starting templates ·
                    custom plans are always available
                  </small>
                </label>
                <label className="field">
                  <span>Profession, credential, and state</span>
                  <select
                    name="ruleSetId"
                    value={selectedRuleId}
                    onChange={(event) => {
                      setSelectedRuleId(event.currentTarget.value)
                      setCatalogQuery("");
                    }}
                    required
                  >
                    <option value="">Choose a rule template</option>
                    {catalogGroups.map((group) => (
                      <optgroup key={group.profession} label={group.profession}>
                        {group.rules.map((rule) => (
                          <option key={rule.id} value={rule.id}>
                            {rule.credentialName} · {rule.jurisdiction}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <small aria-live="polite">
                    {catalogMatches.length}{" "}
                    {catalogMatches.length === 1 ? "match" : "matches"}
                  </small>
                </label>
                {catalogMatches.length === 0 ? (
                  <button
                    className="button button-outline catalog-custom-button"
                    type="button"
                    onClick={() => {
                      setSelectedRuleId("");
                      setCatalogQuery("");
                      setCustomCredential(true);
                    }}
                  >
                    No exact match — enter my own requirements
                  </button>
                ) : null}
                {selectedRule ? (
                  <div className="source-card">
                    <div className="source-card-top">
                      <span
                        className={`verified-chip ${ruleReviewClass(
                          selectedRule.reviewStatus,
                        )}`}
                      >
                        {ruleReviewLabel(selectedRule.reviewStatus)}
                      </span>
                      <span>
                        {selectedRule.lastVerifiedAt
                          ? `Reviewed ${formatDate(
                              selectedRule.lastVerifiedAt,
                              {
                                month: "short",
                                year: "numeric",
                              },
                            )}`
                          : "Review date not set"}
                      </span>
                    </div>
                    <strong>
                      {selectedRule.totalUnits > 0
                        ? `${compactNumber(selectedRule.totalUnits)} ${
                            selectedRule.unitLabel
                          } every ${selectedRule.cycleMonths / 12} ${
                            selectedRule.cycleMonths === 12 ? "year" : "years"
                          }`
                        : "No general numeric CE total · mandated training is tracked by condition and checklist"}
                    </strong>
                    <p>
                      {selectedRule.categories
                        .map(catalogCategorySummary)
                        .join(" · ") || "No special minimums in this template"}
                    </p>
                    {selectedRule.sourceTitle ? (
                      <p className="source-caution">
                        {selectedRule.sourceTitle}
                      </p>
                    ) : null}
                    {selectedRule.sourceUrl ? (
                      <a
                        href={selectedRule.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Review official source ↗
                      </a>
                    ) : null}
                  </div>
                ) : (
                  <p className="form-hint">
                    Templates include the official source and review date. You
                    can edit dates before saving.
                  </p>
                )}
                {selectedRule?.categories.some(
                  (category) => category.applicability === "conditional",
                ) ? (
                  <fieldset className="condition-review">
                    <legend>Which conditions apply this cycle?</legend>
                    <p>
                      Answer each item so a conditional rule is never silently
                      added or left out.
                    </p>
                    <div className="condition-list">
                      {selectedRule.categories
                        .filter(
                          (category) =>
                            category.applicability === "conditional",
                        )
                        .map((category) => (
                          <article key={category.id}>
                            <div>
                              <strong>{category.name}</strong>
                              <small>
                                {category.conditionNote ??
                                  "Review the official source to decide whether this applies."}
                              </small>
                            </div>
                            <div
                              className="condition-options"
                              role="radiogroup"
                              aria-label={`Does ${category.name} apply?`}
                            >
                              <label>
                                <input
                                  type="radio"
                                  name={`applicability:${category.id}`}
                                  value="applies"
                                  required
                                />
                                <span>Applies</span>
                              </label>
                              <label>
                                <input
                                  type="radio"
                                  name={`applicability:${category.id}`}
                                  value="not_applicable"
                                  required
                                />
                                <span>Not this cycle</span>
                              </label>
                            </div>
                          </article>
                        ))}
                    </div>
                  </fieldset>
                ) : null}
                {selectedRule?.profession === "Pharmacy" ||
                selectedRule?.profession === "Nursing" ? (
                  <label className="switch-row">
                    <span>
                      <strong>
                        I confirmed this is a standard full-cycle{" "}
                        {selectedRule.profession === "Nursing"
                          ? "renewal or registration"
                          : "renewal"}
                      </strong>
                      <small>
                        {selectedRule.id === "tx-rn-2026-v1" ||
                        selectedRule.id === "tx-lvn-2026-v1"
                          ? "The regulator record matches the dates below, I am using the 20-hour CNE path rather than the certification alternative, and no initial, shortened, inactive, exempt, or other adjusted-status variant applies."
                          : "The regulator record matches the dates below, and no initial, shortened, inactive, prorated, exempt, or other adjusted-status variant applies."}
                      </small>
                    </span>
                    <input
                      name="templateEligibilityAttested"
                      type="checkbox"
                      required
                    />
                  </label>
                ) : null}
              </>
            )}

            <div className="form-grid">
              <label className="field">
                <span>Cycle started</span>
                <input
                  key={`cycle-start:${selectedRule?.id ?? "custom"}`}
                  name="cycleStart"
                  type="date"
                  defaultValue={
                    requiresOfficialCatalogDates(selectedRule)
                      ? ""
                      : defaultCatalogCycleStart(selectedRule)
                  }
                  required
                />
              </label>
              <label className="field">
                <span>Renewal deadline</span>
                <input
                  key={`deadline:${selectedRule?.id ?? "custom"}`}
                  name="deadline"
                  type="date"
                  defaultValue={
                    requiresOfficialCatalogDates(selectedRule)
                      ? ""
                      : nextYearIso()
                  }
                  required
                />
              </label>
            </div>

            {isNremtCatalogRule(selectedRule) ? (
              <label className="switch-row">
                <span>
                  <strong>I checked my National Registry dashboard</strong>
                  <small>
                    It assigns this 2025 NCCP level template, and the cycle
                    start and fixed expiration entered above match the
                    dashboard exactly.
                  </small>
                </span>
                <input
                  name="officialDatesAttested"
                  type="checkbox"
                  required
                />
              </label>
            ) : null}
            {isFloridaMentalHealthCatalogRule(selectedRule) ? (
              <label className="switch-row">
                <span>
                  <strong>I checked my CE Broker period and phase</strong>
                  <small>
                    CE Broker shows this Ethics and Boundaries or Telehealth
                    phase, beginning April 1 of an odd year and ending March
                    31 two years later.
                  </small>
                </span>
                <input
                  name="officialDatesAttested"
                  type="checkbox"
                  required
                />
              </label>
            ) : null}

            <div className="advisory-note">
              <span aria-hidden="true">i</span>
              <p>
                Confirm dates and requirements with your licensing board.
                License Lantern helps organize your records; it does not replace board
                guidance.
              </p>
            </div>

            <div className="form-actions">
              <button
                className="button button-ghost"
                type="button"
                onClick={() => setCredentialOpen(false)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                type="submit"
                disabled={pending}
              >
                {pending ? "Building plan…" : "Create renewal plan"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {submissionOpen && selectedCredential ? (
        <Modal
          title={
            isIsc2AutomaticRenewalCredential(selectedCredential)
              ? "Save an ISC2 dashboard checkpoint"
              : isCompliancePeriodCredential(selectedCredential)
                ? "Record compliance"
                : isNremtCredential(selectedCredential)
                  ? "Save the National Registry application"
                  : "Log your submission"
          }
          eyebrow={
            isIsc2AutomaticRenewalCredential(selectedCredential)
              ? "Automatic-renewal milestone"
              : isCompliancePeriodCredential(selectedCredential)
                ? "Compliance-period milestone"
                : isNremtCredential(selectedCredential)
                  ? "National Registry milestone"
                  : "Renewal milestone"
          }
          onClose={() => setSubmissionOpen(false)}
        >
          <form className="form-stack" onSubmit={handleSubmission}>
            <div className="celebration-panel">
              <span className="celebration-mark" aria-hidden="true">
                ✓
              </span>
              <div>
                <strong>
                  {isIsc2AutomaticRenewalCredential(selectedCredential)
                    ? "Record what the ISC2 dashboard shows"
                    : isCompliancePeriodCredential(selectedCredential)
                      ? "Save the official compliance milestone"
                      : isNremtCredential(selectedCredential)
                        ? "Save the National Registry application record"
                    : "One last record for your future self"}
                </strong>
                <p>
                  {isIsc2AutomaticRenewalCredential(selectedCredential)
                    ? "This checkpoint records your attestation that required CPEs and annual maintenance fees are satisfied. It does not mean ISC2 has renewed the certification."
                    : isCompliancePeriodCredential(selectedCredential)
                      ? "Record when the official record shows this period’s education requirement is complete."
                      : isNremtCredential(selectedCredential)
                        ? "Confirm the assigned NCCP model and every component in the National Registry dashboard before recording the application."
                    : "Logging the date and confirmation keeps “credits earned” separate from “renewal submitted.”"}
                </p>
              </div>
            </div>
            <label className="field">
              <span>
                {isIsc2AutomaticRenewalCredential(selectedCredential)
                  ? "Dashboard checked"
                  : isCompliancePeriodCredential(selectedCredential)
                    ? "Compliance confirmed"
                    : isNremtCredential(selectedCredential)
                      ? "Application submitted"
                  : "Submission date"}
              </span>
              <input
                autoFocus
                name="submissionDate"
                type="date"
                {...(isNremtCredential(selectedCredential)
                  ? {
                      value: nremtSubmissionDate,
                      onChange: (event: ChangeEvent<HTMLInputElement>) =>
                        setNremtSubmissionDate(event.currentTarget.value),
                    }
                  : { defaultValue: todayIso() })}
                required
              />
            </label>
            <label className="field">
              <span>
                {isIsc2AutomaticRenewalCredential(selectedCredential)
                  ? "Dashboard or payment reference"
                  : isCompliancePeriodCredential(selectedCredential)
                    ? "Official record reference"
                    : isNremtCredential(selectedCredential)
                      ? "Dashboard or application reference"
                  : "Confirmation or receipt number"}{" "}
                <em>Optional</em>
              </span>
              <input
                name="confirmationNumber"
                placeholder={
                  isIsc2AutomaticRenewalCredential(selectedCredential)
                    ? "e.g., dashboard receipt ID"
                    : isCompliancePeriodCredential(selectedCredential)
                      ? "e.g., portal or employer record ID"
                      : isNremtCredential(selectedCredential)
                        ? "e.g., National Registry application ID"
                    : "e.g., RNL-2048-194"
                }
              />
            </label>
            {isIsc2AutomaticRenewalCredential(selectedCredential) ||
            isCompliancePeriodCredential(selectedCredential) ||
            isNremtCredential(selectedCredential) ? (
              <label className="switch-row">
                <span>
                  <strong>
                    {isIsc2AutomaticRenewalCredential(selectedCredential)
                      ? "I checked the ISC2 Dashboard"
                      : isCompliancePeriodCredential(selectedCredential)
                        ? "I checked the official compliance record"
                        : "I checked the National Registry dashboard"}
                  </strong>
                  <small>
                    {isIsc2AutomaticRenewalCredential(selectedCredential)
                      ? "It shows this cycle’s required CPEs and annual maintenance fees as satisfied."
                      : isCompliancePeriodCredential(selectedCredential)
                        ? "It shows this period’s education requirement as complete."
                        : "It shows the assigned model, component totals, National topics, and pediatric content as satisfied."}
                  </small>
                </span>
                <input
                  name="complianceAttested"
                  type="checkbox"
                  required
                />
              </label>
            ) : null}
            {isNremtCredential(selectedCredential) &&
            nremtSubmissionDate > selectedCredential.deadline ? (
              <label className="switch-row">
                <span>
                  <strong>I am using the late reinstatement path</strong>
                  <small>
                    All continuing education was completed by the credential’s
                    expiration cutoff. Education completed during
                    reinstatement is not accepted, and late acceptance is not
                    guaranteed.
                  </small>
                </span>
                <input
                  name="lateReinstatementAttested"
                  type="checkbox"
                  required
                />
              </label>
            ) : null}
            <div className="advisory-note">
              <span aria-hidden="true">i</span>
              <p>
                {isIsc2AutomaticRenewalCredential(selectedCredential)
                  ? "ISC2 performs automatic recertification at the end of the three-year cycle when its requirements are met. Close this cycle only after the dashboard displays renewed certification dates."
                  : isCompliancePeriodCredential(selectedCredential)
                    ? "This records an education-compliance milestone, not a license-renewal filing. Close the period only after confirming the next official compliance dates."
                    : isNremtCredential(selectedCredential)
                      ? "For Active status, EMR and EMT skills are verified by a Training Officer; AEMT and Paramedic skills are verified by a Medical Director. Inactive status still requires the full continuing-education or RBE pathway. If expired, follow the dashboard’s current reinstatement process."
                  : "This records what you submitted. Mark the cycle renewed only after the issuing organization confirms acceptance."}
              </p>
            </div>
            <div className="form-actions">
              <button
                className="button button-ghost"
                type="button"
                onClick={() => setSubmissionOpen(false)}
              >
                Not yet
              </button>
              <button
                className="button button-primary"
                type="submit"
                disabled={pending}
              >
                {pending
                  ? "Saving…"
                  : isIsc2AutomaticRenewalCredential(selectedCredential)
                    ? "Save dashboard checkpoint"
                    : isCompliancePeriodCredential(selectedCredential)
                      ? "Mark compliant"
                    : "Mark submitted"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {acceptanceOpen &&
      selectedCredential?.status === "submitted" ? (
        <Modal
          title={
            isIsc2AutomaticRenewalCredential(selectedCredential)
              ? "Confirm the renewed ISC2 cycle"
              : isCompliancePeriodCredential(selectedCredential)
                ? "Start the next compliance period"
                : isNremtCredential(selectedCredential)
                  ? "Confirm the renewed National Registry cycle"
                  : "Close this renewal cycle"
          }
          eyebrow={
            isIsc2AutomaticRenewalCredential(selectedCredential)
              ? "Dashboard renewed"
              : isCompliancePeriodCredential(selectedCredential)
                ? "Official record updated"
                : isNremtCredential(selectedCredential)
                  ? "Dashboard renewal approved"
                  : "Acceptance received"
          }
          onClose={() => setAcceptanceOpen(false)}
        >
          <form className="form-stack" onSubmit={handleAcceptance}>
            <div className="celebration-panel">
              <span className="celebration-mark" aria-hidden="true">
                ✓
              </span>
              <div>
                <strong>
                  {isIsc2AutomaticRenewalCredential(selectedCredential)
                    ? "Your renewed certification starts a clean cycle"
                    : isCompliancePeriodCredential(selectedCredential)
                      ? "Your next compliance period starts clean"
                    : "Your renewed license starts a clean cycle"}
                </strong>
                <p>
                  The completed cycle stays in history. Credits, checked tasks,
                  and submission records will not be copied forward.
                </p>
              </div>
            </div>
            <div className="form-grid">
              <label className="field">
                <span>
                  {isCompliancePeriodCredential(selectedCredential)
                    ? "Compliance confirmation date"
                    : "Accepted or renewed date"}
                </span>
                <input
                  autoFocus
                  name="acceptedAt"
                  type="date"
                  defaultValue={todayIso()}
                  min={selectedCredential.submittedAt?.slice(0, 10)}
                  required
                />
              </label>
              <label className="field">
                <span>
                  {isCompliancePeriodCredential(selectedCredential)
                    ? "Official record reference"
                    : "Decision or license reference"}{" "}
                  <em>Optional</em>
                </span>
                <input name="reference" placeholder="e.g., license receipt ID" />
              </label>
            </div>
            {isNremtCredential(selectedCredential) ? (
              <div className="source-card nremt-current-template">
                <span className="section-kicker">
                  Current National Registry template
                </span>
                <strong>
                  {selectedNremtNextRule?.credentialName ??
                    selectedCredential.credentialName}
                </strong>
                <p>
                  The next cycle must stay on this current same-level catalog
                  template. Enter the cycle start and fixed expiration exactly
                  as displayed in the National Registry dashboard.
                </p>
              </div>
            ) : null}
            {requiresCurrentNextTemplate(selectedCredential) ? (
              <label className="field">
                <span>
                  {isFloridaMentalHealthPhaseCredential(selectedCredential)
                    ? "Next renewal’s Florida phase"
                    : "Next period’s official Florida template"}
                </span>
                <select name="nextRuleSetId" defaultValue="" required>
                  <option value="" disabled>
                    {isFloridaMentalHealthPhaseCredential(selectedCredential)
                      ? "Choose the phase shown by CE Broker"
                      : "Choose the variant shown by MyProfile"}
                  </option>
                  {(workspace?.catalog ?? [])
                    .filter((rule) =>
                      isFloridaMentalHealthPhaseCredential(
                        selectedCredential,
                      )
                        ? rule.id ===
                          oppositeFloridaMentalHealthRuleSetId(
                            selectedCredential.ruleSetId,
                          )
                        : rule.id.startsWith(
                            "fl-insurance-producer-",
                          ),
                    )
                    .map((rule) => (
                      <option key={rule.id} value={rule.id}>
                        {rule.credentialName}
                      </option>
                    ))}
                </select>
                <small>
                  {isFloridaMentalHealthPhaseCredential(selectedCredential)
                    ? "Florida alternates Ethics and Boundaries with Telehealth each biennium. Confirm the displayed opposite phase against CE Broker; the new cycle will reset every third-biennium and supervisor condition for review."
                    : "Reconfirm both license line and tenure tier. License Lantern will seed the new period from this current official template."}
                </small>
              </label>
            ) : null}
            <div className="cycle-rollover">
              <span className="section-kicker">
                {isCompliancePeriodCredential(selectedCredential)
                  ? "Next compliance period"
                  : "Next renewal cycle"}
              </span>
              <p>Confirm the dates shown by your issuing organization.</p>
              <div className="form-grid">
                <label className="field">
                  <span>
                    {isNremtCredential(selectedCredential)
                      ? "Dashboard cycle start"
                      : "New cycle starts"}
                  </span>
                  <input
                    name="nextCycleStart"
                    type="date"
                    defaultValue={
                      isNremtCredential(selectedCredential)
                        ? undefined
                        : addDaysIso(selectedCredential.deadline, 1)
                    }
                    min={
                      requiresNonOverlappingNextPeriod(
                        selectedCredential,
                      )
                        ? addDaysIso(selectedCredential.deadline, 1)
                        : undefined
                    }
                    required
                  />
                </label>
                <label className="field">
                  <span>
                    {isCompliancePeriodCredential(selectedCredential)
                      ? "Next compliance deadline"
                      : isNremtCredential(selectedCredential)
                        ? "Dashboard fixed expiration"
                      : "Next renewal deadline"}
                  </span>
                  <input
                    name="nextDeadline"
                    type="date"
                    defaultValue={
                      isNremtCredential(selectedCredential)
                        ? undefined
                        : addMonthsIso(
                            selectedCredential.deadline,
                            selectedCredential.cycleMonths || 12,
                          )
                    }
                    required
                  />
                </label>
              </div>
            </div>
            {requiresOfficialNextPeriodAttestation(selectedCredential) ? (
              <label className="switch-row">
                <span>
                  <strong>
                    {isNremtCredential(selectedCredential)
                      ? "I verified the current-template dashboard dates"
                      : "I verified the official next-period record"}
                  </strong>
                  <small>
                    {isNremtCredential(selectedCredential)
                      ? "The same-level template, cycle start, and fixed expiration above match the National Registry dashboard."
                      : "The confirmation and next cycle dates above match the issuer, authority, or employer record."}
                  </small>
                </span>
                <input
                  name="officialDatesAttested"
                  type="checkbox"
                  required
                />
              </label>
            ) : null}
            {isManagedPharmacistCredential(selectedCredential) ||
            isManagedNursingCredential(selectedCredential) ? (
              <label className="switch-row">
                <span>
                  <strong>
                    I confirmed the next period is a standard full-cycle
                    {isManagedNursingCredential(selectedCredential)
                      ? " renewal or registration"
                      : " renewal"}
                  </strong>
                  <small>
                    {selectedCredential.ruleSetId === "tx-rn-2026-v1" ||
                    selectedCredential.ruleSetId === "tx-lvn-2026-v1"
                      ? "I am using the 20-hour CNE path rather than the certification alternative, and no initial, shortened, inactive, exempt, or other adjusted-status variant applies."
                      : "No shortened, inactive, prorated, exempt, or other adjusted-status variant applies to the next period."}
                  </small>
                </span>
                <input
                  name="templateEligibilityAttested"
                  type="checkbox"
                  required
                />
              </label>
            ) : null}
            <div className="advisory-note">
              <span aria-hidden="true">i</span>
              <p>
                {isFloridaInsuranceComplianceCredential(selectedCredential)
                  ? "The next period will use the selected current template and will reset every conditional rule for confirmation."
                  : isFloridaMentalHealthPhaseCredential(selectedCredential)
                    ? "The next renewal will use the CE Broker-confirmed phase and reset every third-biennium and supervisor condition for review."
                    : isNremtCredential(selectedCredential)
                      ? "Do not infer the new cycle start from the old expiration. National Registry can assign an early rolling start while retaining the fixed expiration; the dashboard dates control."
                      : isManagedPharmacistCredential(selectedCredential)
                        ? "The next renewal will use the latest current version of this state pharmacist template and reset every conditional authorization for review."
                        : isManagedNursingCredential(selectedCredential)
                          ? "The next period will use the latest current version of this nursing template and reset every conditional training rule for review."
                        : "Requirements are copied as a starting snapshot. Review the current official rules before relying on the new plan."}
              </p>
            </div>
            <div className="form-actions">
              <button
                className="button button-ghost"
                type="button"
                onClick={() => setAcceptanceOpen(false)}
              >
                Not yet
              </button>
              <button
                className="button button-primary"
                type="submit"
                disabled={pending}
              >
                {pending
                  ? "Creating next cycle…"
                  : isIsc2AutomaticRenewalCredential(selectedCredential)
                    ? "Confirm renewal & continue"
                    : isCompliancePeriodCredential(selectedCredential)
                      ? "Start next period"
                    : "Mark accepted & continue"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {remindersOpen && workspace ? (
        <Modal
          title="Due-date check-ins"
          eyebrow="Reminder preferences"
          onClose={() => setRemindersOpen(false)}
        >
          <form className="form-stack" onSubmit={handleReminderPreferences}>
            <label className="switch-row">
              <span>
                <strong>Show in-app reminders</strong>
                <small>
                  See upcoming tasks and submission follow-ups on Today.
                </small>
              </span>
              <input
                name="inAppEnabled"
                type="checkbox"
                defaultChecked={workspace.reminderPreferences.inAppEnabled}
              />
            </label>
            <fieldset className="check-grid">
              <legend>Remind me before a due date</legend>
              {[90, 30, 7, 1].map((days) => (
                <label key={days}>
                  <input
                    name="leadDays"
                    type="checkbox"
                    value={days}
                    defaultChecked={workspace.reminderPreferences.leadDays.includes(
                      days,
                    )}
                  />
                  <span>
                    {days} {days === 1 ? "day" : "days"}
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="field">
              <span>Time zone</span>
              <input
                name="timeZone"
                defaultValue={workspace.reminderPreferences.timeZone}
                placeholder="America/New_York"
                required
              />
              <small>Use an IANA zone such as America/New_York.</small>
            </label>
            <div className="advisory-note">
              <span aria-hidden="true">i</span>
              <p>
                In-app check-ins stay inside License Lantern. When you import
                its calendar events, your phone calendar can alert on the lead days selected here;
                your calendar controls final delivery.
                Email and web push remain off.
              </p>
            </div>
            <div className="form-actions">
              <button
                className="button button-ghost"
                type="button"
                onClick={() => setRemindersOpen(false)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                type="submit"
                disabled={pending}
              >
                {pending ? "Saving…" : "Save reminders"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {allocationActivity && workspace ? (
        <Modal
          title="Reuse completed learning"
          eyebrow={allocationActivity.title}
          onClose={() => setAllocationActivity(null)}
        >
          {eligibleAllocationCredentials.length ? (
            <form className="form-stack" onSubmit={handleAllocation}>
              <div className="advisory-note">
                <span aria-hidden="true">i</span>
                <p>
                  One course may count toward more than one credential. Confirm
                  eligibility with each issuing organization.
                </p>
              </div>
              <label className="field">
                <span>Also apply to</span>
                <select
                  name="credentialId"
                  value={allocationCredential?.id ?? ""}
                  onChange={(event) =>
                    setAllocationCredentialId(event.currentTarget.value)
                  }
                  required
                >
                  {eligibleAllocationCredentials.map((credential) => (
                    <option key={credential.id} value={credential.id}>
                      {credential.credentialName} · {credential.jurisdiction}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Credits to apply</span>
                <input
                  name="allocatedUnits"
                  type="number"
                  min="0.1"
                  max={allocationActivity.totalUnits}
                  step="0.1"
                  defaultValue={allocationActivity.totalUnits}
                  required
                />
              </label>
              {isNremtCredential(allocationCredential) ? (
                <NremtRequirementAllocator
                  key={allocationCredential?.id}
                  credential={allocationCredential!}
                  availableUnits={allocationActivity.totalUnits}
                />
              ) : (
                <RequirementPicker
                  key={allocationCredential?.id}
                  credential={allocationCredential}
                />
              )}
              {isPriorPeriodCarryoverEntry(
                allocationActivity.completionDate,
                allocationCredential,
              ) ? (
                <label className="switch-row">
                  <span>
                    <strong>
                      The target portal posted this carryover
                    </strong>
                    <small>
                      Apply this prior-period record to the
                      portal-confirmed carryover source plus only compatible
                      classifiers, and retain the issuer’s supporting record.
                    </small>
                  </span>
                  <input
                    name="portalCarryoverAttested"
                    type="checkbox"
                    required
                  />
                </label>
              ) : null}
              <div className="form-actions">
                <button
                  className="button button-ghost"
                  type="button"
                  onClick={() => setAllocationActivity(null)}
                >
                  Cancel
                </button>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={pending}
                >
                  {pending ? "Applying…" : "Apply to credential"}
                </button>
              </div>
            </form>
          ) : (
            <EmptyModalState
              title="No other eligible credential"
              body="Add another active credential, or this activity is already applied everywhere it can be."
              action="Close"
              onAction={() => setAllocationActivity(null)}
            />
          )}
        </Modal>
      ) : null}

      {classificationRepair ? (
        <Modal
          title={
            classificationRepair.allocation.classificationStatus ===
            "needs_classification"
              ? "Classify this activity"
              : "Edit requirement tags"
          }
          eyebrow={classificationRepair.activity.title}
          onClose={() => setClassificationRepair(null)}
        >
          {classificationCredential ? (
            <form
              className="form-stack"
              onSubmit={handleClassificationRepair}
            >
              <div className="advisory-note">
                <span aria-hidden="true">i</span>
                {classificationRepair.allocation.classificationStatus ===
                "needs_classification" ? (
                  <p>
                    This record is preserved, but its{" "}
                    {compactNumber(
                      classificationRepair.allocation.allocatedUnits,
                    )}{" "}
                    credits stay outside progress until you resolve its
                    classification.{" "}
                    {classificationRepair.allocation.classificationMessage ??
                      `Choose exactly one option for ${
                        classificationRepair.allocation.unresolvedExclusiveGroups?.join(
                          " and ",
                        ) || "the required activity type"
                      }.`}
                  </p>
                ) : (
                  <p>
                    Update which requirements this preserved activity
                    satisfies. Its date, proof, and credit amount will not
                    change.
                  </p>
                )}
              </div>
              {isNremtCredential(classificationCredential) ? (
                <NremtRequirementAllocator
                  key={classificationRepair.allocation.id}
                  credential={classificationCredential!}
                  availableUnits={
                    classificationRepair.allocation.allocatedUnits
                  }
                  initialMatches={
                    classificationRepair.allocation.requirementMatches
                  }
                />
              ) : (
                <RequirementPicker
                  key={classificationRepair.allocation.id}
                  credential={classificationCredential}
                  initialRequirementIds={
                    classificationRepair.allocation.requirementIds
                  }
                />
              )}
              {isPriorPeriodCarryoverEntry(
                classificationRepair.activity.completionDate,
                classificationCredential,
              ) ? (
                <label className="switch-row">
                  <span>
                    <strong>
                      The issuing portal posted this carryover
                    </strong>
                    <small>
                      Keep this prior-period activity tagged to the
                      portal-confirmed carryover source plus only compatible
                      classifiers, and retain the official supporting record.
                    </small>
                  </span>
                  <input
                    name="portalCarryoverAttested"
                    type="checkbox"
                    required
                  />
                </label>
              ) : null}
              <div className="form-actions">
                <button
                  className="button button-ghost"
                  type="button"
                  onClick={() => setClassificationRepair(null)}
                >
                  Cancel
                </button>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={pending}
                >
                  {pending ? "Updating…" : "Update classification"}
                </button>
              </div>
            </form>
          ) : (
            <EmptyModalState
              title="Credential unavailable"
              body="This activity’s credential could not be opened for classification."
              action="Close"
              onAction={() => setClassificationRepair(null)}
            />
          )}
        </Modal>
      ) : null}

      {evidenceActivity ? (
        <Modal
          title="Proof and certificates"
          eyebrow={evidenceActivity.title}
          onClose={() => {
            setEvidenceActivity(null);
            setError("");
          }}
        >
          <div className="form-stack">
            {error ? (
              <div className="modal-error" role="alert">
                <strong>Proof could not be updated</strong>
                <span>{error}</span>
              </div>
            ) : null}
            {evidenceIsFrozen ? (
              <div className="advisory-note frozen-proof-advisory">
                <span aria-hidden="true">i</span>
                <p>
                  Proof is frozen with closed cycle history. You can view and
                  download saved files, but new uploads and removals are
                  locked. An interrupted removal can still be retried safely.
                </p>
              </div>
            ) : (
              <form className="evidence-upload" onSubmit={handleEvidenceUpload}>
                <label className="field file-field">
                  <span>Add a proof file</span>
                  <input
                    name="file"
                    type="file"
                    accept=".pdf,image/jpeg,image/png,image/webp"
                    required
                  />
                  <small>
                    Private to your account · PDF, JPEG, PNG, or WebP · up to 10
                    MB
                  </small>
                </label>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={evidencePending}
                >
                  {evidencePending ? "Saving…" : "Upload proof"}
                </button>
              </form>
            )}
            <div className="evidence-file-list" aria-live="polite">
              {evidencePending && evidenceFiles.length === 0 ? (
                <p className="form-hint">Loading proof files…</p>
              ) : evidenceFiles.length ? (
                evidenceFiles.map((evidence) => (
                  <article key={evidence.id}>
                    <div>
                      <strong>{evidence.fileName}</strong>
                      <small>
                        {(evidence.sizeBytes / 1_048_576).toFixed(1)} MB · saved{" "}
                        {formatDate(evidence.createdAt)}
                        {evidence.deletionPending
                          ? " · removal interrupted"
                          : ""}
                      </small>
                    </div>
                    <div className="evidence-file-actions">
                      {!evidence.deletionPending ? (
                        <a
                          className="button button-outline button-compact"
                          href={evidence.downloadUrl}
                        >
                          Download
                        </a>
                      ) : null}
                      {evidence.deletionPending || !evidenceIsFrozen ? (
                        <button
                          className="button button-ghost button-compact"
                          type="button"
                          disabled={evidencePending}
                          onClick={() => void deleteEvidence(evidence)}
                        >
                          {evidence.deletionPending
                            ? "Retry removal"
                            : "Remove"}
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))
              ) : error ? null : (
                <div className="evidence-empty">
                  <strong>No proof uploaded yet</strong>
                  <p>
                    {evidenceIsFrozen
                      ? "No proof was saved before this cycle became closed history."
                      : "Add the completion certificate, receipt, or attendance record above."}
                  </p>
                </div>
              )}
            </div>
          </div>
        </Modal>
      ) : null}

      {toast ? (
        <div className="toast" role="status" aria-live="polite">
          <span>{toast.message}</span>
          {toast.undo ? (
            <button
              type="button"
              onClick={() => {
                toast.undo?.();
                setToast(null);
              }}
            >
              Undo
            </button>
          ) : null}
          <button
            className="toast-close"
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Brand() {
  return (
    <div className="brand" aria-label="License Lantern">
      <span className="brand-mark" aria-hidden="true">
        L
      </span>
      <span>License Lantern</span>
    </div>
  );
}

function DesktopSidebar({
  view,
  onView,
  onAdd,
  hasCredential,
}: {
  view: ViewName;
  onView: (view: ViewName) => void;
  onAdd: () => void;
  hasCredential: boolean;
}) {
  return (
    <aside className="desktop-sidebar">
      <Brand />
      <nav aria-label="Primary navigation">
        <NavButton
          active={view === "today"}
          label="Today"
          symbol="⌂"
          onClick={() => onView("today")}
        />
        <NavButton
          active={view === "credentials"}
          label="Credentials"
          symbol="▣"
          onClick={() => onView("credentials")}
        />
        <NavButton
          active={view === "records"}
          label="Records"
          symbol="≡"
          onClick={() => onView("records")}
        />
        <NavButton
          active={view === "account"}
          label="Account"
          symbol="○"
          onClick={() => onView("account")}
        />
      </nav>
      <button
        className="sidebar-add"
        type="button"
        onClick={onAdd}
        disabled={!hasCredential}
      >
        <span aria-hidden="true">＋</span>
        Log activity
      </button>
      <div className="sidebar-coach">
        <span>Weekly rhythm</span>
        <strong>Small updates. Calm renewals.</strong>
        <p>Log proof while it’s easy to find.</p>
      </div>
    </aside>
  );
}

function MobileNavigation({
  view,
  onView,
  onAdd,
  hasCredential,
}: {
  view: ViewName;
  onView: (view: ViewName) => void;
  onAdd: () => void;
  hasCredential: boolean;
}) {
  return (
    <nav className="mobile-nav" aria-label="Primary navigation">
      <NavButton
        active={view === "today"}
        label="Today"
        symbol="⌂"
        onClick={() => onView("today")}
      />
      <NavButton
        active={view === "credentials"}
        label="Licenses"
        symbol="▣"
        onClick={() => onView("credentials")}
      />
      <button
        className="mobile-add"
        type="button"
        aria-label="Log completed learning"
        onClick={onAdd}
        disabled={!hasCredential}
      >
        +
      </button>
      <NavButton
        active={view === "records"}
        label="Records"
        symbol="≡"
        onClick={() => onView("records")}
      />
      <NavButton
        active={view === "account"}
        label="Account"
        symbol="○"
        onClick={() => onView("account")}
      />
    </nav>
  );
}

function NavButton({
  active,
  label,
  symbol,
  onClick,
}: {
  active: boolean;
  label: string;
  symbol: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`nav-button ${active ? "active" : ""}`}
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <span className="nav-symbol" aria-hidden="true">
        {symbol}
      </span>
      <span>{label}</span>
    </button>
  );
}

function TodayView({
  workspace,
  credential,
  onAddActivity,
  onAddCredential,
  onViewCredentials,
  onViewRecords,
  onSubmit,
  onAccept,
  onReminders,
  onReminderState,
  onAddReminderToCalendar,
  onToggleTask,
  onAddPersonalTask,
  onEditPersonalTask,
  onRestorePersonalTask,
  taskActionsDisabled,
  onClaimQuest,
  progressionPending,
  onRequirementApplicability,
}: {
  workspace: Workspace;
  credential: Credential | null;
  onAddActivity: () => void;
  onAddCredential: () => void;
  onViewCredentials: () => void;
  onViewRecords: () => void;
  onSubmit: () => void;
  onAccept: () => void;
  onReminders: () => void;
  onReminderState: (
    reminder: Reminder,
    status: "dismissed" | "snoozed",
  ) => void;
  onAddReminderToCalendar: (reminder: Reminder) => void;
  onToggleTask: (task: RenewalTask) => void;
  onAddPersonalTask: (credential: Credential) => void;
  onEditPersonalTask: (
    credential: Credential,
    task: RenewalTask,
  ) => void;
  onRestorePersonalTask: (task: RenewalTask) => void;
  taskActionsDisabled: boolean;
  onClaimQuest: (quest: WeeklyQuest) => void;
  progressionPending: boolean;
  onRequirementApplicability: (
    requirement: Requirement,
    status: "applies" | "not_applicable",
  ) => void;
}) {
  if (!credential) {
    return (
      <div className="view-stack">
        <PageGreeting
          eyebrow="Your renewal companion"
          title={`Welcome, ${firstName(workspace.user.displayName)}.`}
          body="Let’s turn your license requirements into a clear, manageable plan."
        />
        <section className="onboarding-hero">
          <div className="onboarding-copy">
            <span className="section-kicker">Start in about 2 minutes</span>
            <h2>Tell us what you renew. We’ll map the path.</h2>
            <p>
              Choose a source-linked rule template or enter your own
              requirements. You can change everything later.
            </p>
            <button
              className="button button-light"
              type="button"
              onClick={onAddCredential}
            >
              Set up my first credential
              <span aria-hidden="true">→</span>
            </button>
          </div>
          <ol className="onboarding-steps">
            <li>
              <span>1</span>
              <div>
                <strong>Choose credential + state</strong>
                <p>Match a template or create a custom plan.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Confirm your renewal dates</strong>
                <p>We organize credits around your real cycle.</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Log learning as you go</strong>
                <p>See what’s done and what deserves attention.</p>
              </div>
            </li>
          </ol>
        </section>
        <section className="trust-strip" aria-label="License Lantern principles">
          <div>
            <span className="trust-mark">✓</span>
            <p><strong>Source-linked rules</strong> with review dates</p>
          </div>
          <div>
            <span className="trust-mark">✓</span>
            <p><strong>Your activity history</strong> kept cycle by cycle</p>
          </div>
          <div>
            <span className="trust-mark">✓</span>
            <p><strong>Submission stays separate</strong> from credits earned</p>
          </div>
        </section>
      </div>
    );
  }

  const progress = credentialProgress(credential);
  const readiness = readinessScore(credential);
  const missingEvidence = workspace.activities.filter(
    (activity) =>
      allocationsFor(activity).some(
        (allocation) => allocation.credentialId === credential.id,
      ) &&
      activity.evidenceStatus === "missing",
  ).length;
  const deadlineDays = daysUntil(credential.deadline);
  const visibleReminders = workspace.reminders;
  const guidedAction = bestNextAction(credential, missingEvidence);
  const progression = workspace.progression;
  const xpToNextLevel = Math.max(
    0,
    progression.level.nextLevelXp - progression.lifetimeXp,
  );
  const runGuidedAction = () => {
    switch (guidedAction.kind) {
      case "acceptance":
        onAccept();
        break;
      case "conditions":
      case "history":
        onViewCredentials();
        break;
      case "learning":
        onAddActivity();
        break;
      case "records":
        onViewRecords();
        break;
      case "checklist": {
        const checklist = document.getElementById("renewal-checklist");
        checklist?.scrollIntoView({ behavior: "smooth", block: "center" });
        checklist?.focus({ preventScroll: true });
        break;
      }
      case "submission":
        onSubmit();
        break;
    }
  };

  return (
    <div className="view-stack">
      <PageGreeting
        eyebrow={
          workspace.user.isDemo
            ? "Private preview workspace"
            : "Your credential companion"
        }
        title={`Good ${dayPart()}, ${firstName(workspace.user.displayName)}.`}
        body="Here’s the clearest next step toward a calm deadline."
        action={
          <button
            className="button button-primary desktop-only"
            type="button"
            onClick={onAddActivity}
          >
            <span aria-hidden="true">＋</span>
            Log completed learning
          </button>
        }
      />

      <section className="renewal-hero" aria-labelledby="renewal-heading">
        <div className="renewal-hero-main">
          <div className="renewal-identity">
            <div>
              <span className="status-pill">
                <span aria-hidden="true" />
                {credential.status === "active"
                  ? isCompliancePeriodCredential(credential)
                    ? "Active compliance period"
                    : "Active renewal cycle"
                  : credential.status === "submitted"
                    ? isIsc2AutomaticRenewalCredential(credential)
                      ? "Awaiting ISC2 renewal"
                      : isCompliancePeriodCredential(credential)
                        ? "Compliance recorded"
                        : "Submitted"
                    : isCompliancePeriodCredential(credential)
                      ? "Completed"
                      : "Renewed"}
              </span>
              <h2 id="renewal-heading">{credential.credentialName}</h2>
              <p>
                {credential.jurisdiction}
                {credential.issuer ? ` · ${credential.issuer}` : ""}
              </p>
            </div>
            <button
              className="text-button"
              type="button"
              onClick={onViewCredentials}
            >
              View plan <span aria-hidden="true">→</span>
            </button>
          </div>

          <div className="deadline-row">
            <div className="deadline-number">
              <strong>{Math.abs(deadlineDays)}</strong>
              <span>
                {deadlineDays < 0
                  ? "days overdue"
                  : isCompliancePeriodCredential(credential)
                    ? "days to compliance"
                    : "days to renewal"}
              </span>
            </div>
            <div className="deadline-detail">
              <span>Due {formatDate(credential.deadline)}</span>
              {credential.totalRequired > 0 ? (
                <>
                  <div className="progress-track progress-track-light">
                    <span style={{ width: `${progress}%` }} />
                  </div>
                  <p>
                    <strong>
                      {compactNumber(credential.totalEarned)} of{" "}
                      {compactNumber(credential.totalRequired)}
                    </strong>{" "}
                    {credential.unitLabel} counted
                  </p>
                </>
              ) : (
                <p>
                  <strong>No general numeric CE total</strong>
                  <br />
                  Mandated training is tracked in conditions and the checklist.
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="readiness-panel">
          <span className="section-kicker section-kicker-light">
            {isCompliancePeriodCredential(credential)
              ? "Compliance readiness"
              : "Renewal readiness"}
          </span>
          <div
            className="readiness-ring"
            style={{ "--score": readiness } as React.CSSProperties}
            role="progressbar"
            aria-label={`${readiness}% ${
              isCompliancePeriodCredential(credential)
                ? "compliance"
                : "renewal"
            } readiness`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={readiness}
          >
            <span>
              <strong>{readiness}%</strong>
              <small>ready</small>
            </span>
          </div>
          <p>
            {credential.totalRequired > 0
              ? "Based on countable units, active minimums, and checklist steps."
              : "Based on applicable training conditions and checklist steps."}
          </p>
        </div>
      </section>

      {visibleReminders.length ? (
        <section className="reminder-inbox" aria-labelledby="reminder-title">
          <div className="reminder-inbox-heading">
            <div>
              <span className="section-kicker">Needs attention</span>
              <h2 id="reminder-title">
                {visibleReminders.length === 1
                  ? "One timely check-in"
                  : `${visibleReminders.length} timely check-ins`}
              </h2>
            </div>
            <button className="text-button" type="button" onClick={onReminders}>
              Settings
            </button>
          </div>
          <div className="reminder-list">
            {visibleReminders.slice(0, 3).map((reminder) => (
              <article className={reminder.urgency} key={reminder.key}>
                <span className="reminder-dot" aria-hidden="true" />
                <div>
                  <strong>{reminder.title}</strong>
                  <p>{reminder.body}</p>
                </div>
                <div>
                  <button
                    className="calendar-action"
                    type="button"
                    onClick={() => onAddReminderToCalendar(reminder)}
                  >
                    Add to calendar
                  </button>
                  <button
                    type="button"
                    onClick={() => onReminderState(reminder, "snoozed")}
                  >
                    Snooze 7 days
                  </button>
                  <button
                    type="button"
                    onClick={() => onReminderState(reminder, "dismissed")}
                  >
                    Dismiss
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="next-action-card">
        <span className="next-action-icon" aria-hidden="true">
          ↗
        </span>
        <div>
          <span className="section-kicker">Best next action</span>
          <h2>{guidedAction.title}</h2>
          <p>{guidedAction.body}</p>
        </div>
        <button
          className="button button-dark"
          type="button"
          onClick={runGuidedAction}
        >
          {guidedAction.buttonLabel}
        </button>
      </section>

      <div className="dashboard-grid">
        <section className="card progress-card" aria-labelledby="progress-title">
          <div className="card-heading">
            <div>
              <span className="section-kicker">Requirements</span>
              <h2 id="progress-title">
                {credential.totalRequired > 0
                  ? "Credit progress"
                  : "Training and checklist"}
              </h2>
            </div>
            <span className="card-summary">
              {credential.totalRequired > 0
                ? `${progress}% counted`
                : `${readiness}% ready`}
            </span>
          </div>
          <div className="requirement-list">
            {credential.totalRequired > 0 ? (
              <ProgressRow
                name="Overall"
                earned={credential.totalEarned}
                required={credential.totalRequired}
                unit={credential.unitLabel}
              />
            ) : (
              <p className="total-excess-note">
                No general numeric CE total applies. Resolve each training
                condition and use the renewal checklist as the completion
                record.
              </p>
            )}
            {Number(credential.totalExcessUnits ?? 0) > 0 ? (
              <p className="total-excess-note">
                {compactNumber(credential.totalRawEarned ?? 0)}{" "}
                {credential.unitLabel} are documented;{" "}
                {compactNumber(credential.totalExcessUnits ?? 0)} exceed a
                category limit and are excluded from the overall count.
              </p>
            ) : null}
            {Number(credential.unclassifiedUnits ?? 0) > 0 ? (
              <p className="total-excess-note">
                {compactNumber(credential.unclassifiedUnits ?? 0)}{" "}
                {credential.unitLabel} are preserved but excluded until their
                required activity type is classified.
              </p>
            ) : null}
            {credential.requirements.map((requirement) => (
              <ProgressRow
                key={requirement.id}
                name={requirement.name}
                earned={requirementEarned(requirement)}
                required={requirement.requiredUnits}
                unit={credential.unitLabel}
                requirement={requirement}
                onApplicability={
                  credential.status === "active"
                    ? (status) =>
                        onRequirementApplicability(requirement, status)
                    : undefined
                }
              />
            ))}
          </div>
          <button
            className="card-link"
            type="button"
            onClick={
              credential.status === "renewed"
                ? onViewRecords
                : onAddActivity
            }
          >
            {credential.status === "renewed"
              ? "View preserved records"
              : "Log an activity"}{" "}
            <span aria-hidden="true">
              {credential.status === "renewed" ? "→" : "＋"}
            </span>
          </button>
        </section>

        <section
          className="card coach-card progression-card"
          aria-labelledby="momentum-title"
        >
          <div className="card-heading">
            <div>
              <span className="section-kicker">Professional momentum</span>
              <h2 id="momentum-title">
                Level {progression.level.number} ·{" "}
                {progression.level.title}
              </h2>
            </div>
            <span className="xp-chip">{progression.lifetimeXp} XP</span>
          </div>
          <div className="level-summary">
            <span className="level-orb" aria-hidden="true">
              {progression.level.number}
            </span>
            <div>
              <div className="level-copy">
                <strong>{progression.level.progressPercent}% to level{" "}
                  {progression.level.number + 1}</strong>
                <small>{xpToNextLevel} XP to go</small>
              </div>
              <div
                className="level-track"
                role="progressbar"
                aria-label={`${progression.level.progressPercent}% toward level ${progression.level.number + 1}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progression.level.progressPercent}
              >
                <span
                  style={{
                    width: `${progression.level.progressPercent}%`,
                  }}
                />
              </div>
            </div>
          </div>

          <div className="quest-heading">
            <div>
              <strong>Weekly quests</strong>
              <small>
                {formatDate(progression.week.startsOn, {
                  month: "short",
                  day: "numeric",
                })}{" "}
                –{" "}
                {formatDate(progression.week.endsOn, {
                  month: "short",
                  day: "numeric",
                })}
              </small>
            </div>
            <span>
              {Math.min(progression.weekActions, progression.weeklyGoal)}/
              {progression.weeklyGoal} actions
            </span>
          </div>
          <div className="quest-list">
            {progression.quests.length ? (
              progression.quests.map((quest) => {
                const questPercent = clampPercent(
                  (Math.min(quest.progress, quest.target) / quest.target) * 100,
                );
                return (
                  <article
                    className={`quest-row ${
                      quest.claimed
                        ? "claimed"
                        : quest.claimable
                          ? "claimable"
                          : ""
                    }`}
                    key={quest.key}
                  >
                    <span className="quest-state" aria-hidden="true">
                      {quest.claimed ? "✓" : quest.completed ? "◆" : "◇"}
                    </span>
                    <div className="quest-copy">
                      <strong>{quest.title}</strong>
                      <small>{quest.description}</small>
                      <div
                        className="quest-track"
                        role="progressbar"
                        aria-label={`${quest.title}: ${Math.min(
                          quest.progress,
                          quest.target,
                        )} of ${quest.target}`}
                        aria-valuemin={0}
                        aria-valuemax={quest.target}
                        aria-valuenow={Math.min(quest.progress, quest.target)}
                      >
                        <span style={{ width: `${questPercent}%` }} />
                      </div>
                    </div>
                    {quest.claimable ? (
                      <button
                        type="button"
                        disabled={progressionPending}
                        onClick={() => onClaimQuest(quest)}
                      >
                        +{quest.rewardXp} XP
                      </button>
                    ) : (
                      <span className="quest-count">
                        {quest.claimed
                          ? "Claimed"
                          : `${Math.min(quest.progress, quest.target)}/${
                              quest.target
                            }`}
                      </span>
                    )}
                  </article>
                );
              })
            ) : (
              <p className="quest-empty">
                Nothing needs a quest right now. Your record is calm and clear.
              </p>
            )}
          </div>
          <div
            className={`momentum-note ${progression.momentum.status}`}
            role="status"
          >
            <span aria-hidden="true">
              {progression.momentum.activeThisWeek ? "↗" : "○"}
            </span>
            <p>
              <strong>
                {progression.momentum.activeThisWeek
                  ? `${progression.momentum.activeWeeks}-week rhythm`
                  : progression.momentum.status === "grace_week"
                    ? "A gentle grace week"
                    : "Ready when you are"}
              </strong>
              {progression.momentum.activeThisWeek
                ? " Meaningful work—not app opens—keeps this moving."
                : progression.momentum.status === "grace_week"
                  ? " One quiet week does not erase the work you already did."
                  : " Your first useful compliance action starts the rhythm."}
            </p>
          </div>
        </section>

        <section
          className="card checklist-card"
          id="renewal-checklist"
          tabIndex={-1}
          aria-labelledby="checklist-title"
        >
          <div className="card-heading">
            <div>
              <span className="section-kicker">Renewal checklist</span>
              <h2 id="checklist-title">Packet readiness</h2>
            </div>
            <div className="checklist-heading-actions">
              <span className="card-summary">
                {
                  credential.tasks.filter(
                    (task) => task.status === "completed",
                  ).length
                }
                /{credential.tasks.length} done
              </span>
              {credential.status !== "renewed" ? (
                <button
                  className="task-add-button"
                  type="button"
                  disabled={taskActionsDisabled}
                  onClick={() => onAddPersonalTask(credential)}
                >
                  <span aria-hidden="true">＋</span>
                  Add task
                </button>
              ) : null}
            </div>
          </div>
          {isNremtCredential(credential) ? (
            <div className="nremt-checklist-note">
              <strong>Confirm the status pathway shown in your dashboard</strong>
              <p>
                Active EMR/EMT status uses Training Officer skills
                verification; Active AEMT/Paramedic status uses Medical
                Director verification. Inactive status still requires all CE
                or RBE requirements. After expiration, use the dashboard’s
                current late reinstatement path and cutoff dates.
              </p>
            </div>
          ) : null}
          <div className="task-list">
            {credential.tasks.map((task) => {
              const taskOverdue =
                task.status !== "completed" &&
                task.dueDate !== null &&
                task.dueDate !== undefined &&
                daysUntil(task.dueDate) < 0;
              return (
                <article
                  className={`task-row ${
                    task.status === "completed" ? "completed" : ""
                  } ${taskOverdue ? "overdue" : ""} ${
                    credential.status === "renewed" ? "locked" : ""
                  }`}
                  key={task.id}
                >
                  <label className="task-toggle">
                    <input
                      type="checkbox"
                      checked={task.status === "completed"}
                      disabled={
                        credential.status === "renewed" ||
                        taskActionsDisabled
                      }
                      onChange={() => onToggleTask(task)}
                    />
                    <span className="custom-check" aria-hidden="true">
                      ✓
                    </span>
                    <span>
                      <strong>{task.title}</strong>
                      <small>
                        {task.kind === "evidence"
                          ? `${missingEvidence} records still need proof`
                          : task.dueDate
                            ? `${
                                taskOverdue ? "Overdue · " : ""
                              }Due ${formatDate(task.dueDate)}`
                            : credential.status === "renewed"
                              ? "Preserved in cycle history"
                              : task.isPersonal
                                ? "Personal task · no due date"
                                : "You can undo this anytime"}
                      </small>
                    </span>
                  </label>
                  {task.isPersonal &&
                  credential.status !== "renewed" ? (
                    <button
                      className="task-edit-button"
                      type="button"
                      aria-label={`Edit ${task.title}`}
                      disabled={taskActionsDisabled}
                      onClick={() => onEditPersonalTask(credential, task)}
                    >
                      Edit
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>
          {(credential.archivedTasks ?? []).length ? (
            <details className="archived-items archived-tasks">
              <summary id="archived-tasks-summary">
                <span>
                  Archived personal tasks
                  <small>
                    {credential.archivedTasks.length}{" "}
                    {credential.archivedTasks.length === 1 ? "task" : "tasks"}
                  </small>
                </span>
                <span aria-hidden="true">⌄</span>
              </summary>
              <div className="archived-item-list">
                {credential.archivedTasks.map((task) => (
                  <article className="archived-item" key={task.id}>
                    <div>
                      <strong>{task.title}</strong>
                      <small>
                        {task.dueDate
                          ? `Due ${formatDate(task.dueDate)}`
                          : "No due date"}
                      </small>
                    </div>
                    {credential.status === "renewed" ? (
                      <span className="archived-item-state">Cycle frozen</span>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Restore ${task.title}`}
                        disabled={taskActionsDisabled}
                        onClick={() => onRestorePersonalTask(task)}
                      >
                        Restore task
                      </button>
                    )}
                  </article>
                ))}
              </div>
            </details>
          ) : null}
          {credential.status === "active" ? (
            <button className="card-link" type="button" onClick={onSubmit}>
              {isIsc2AutomaticRenewalCredential(credential)
                ? "Save ISC2 dashboard checkpoint"
                : isCompliancePeriodCredential(credential)
                  ? "Record compliance"
                : "Log renewal submission"}{" "}
              <span aria-hidden="true">→</span>
            </button>
          ) : credential.status === "submitted" ? (
            <div className="submitted-note submitted-note-action">
              <span>
                {isIsc2AutomaticRenewalCredential(credential)
                  ? "Dashboard checkpoint saved"
                  : isCompliancePeriodCredential(credential)
                    ? "Compliance recorded"
                  : "Submitted"}{" "}
                {formatDate(credential.submittedAt)}
                {credential.confirmationNumber
                  ? ` · ${credential.confirmationNumber}`
                  : ""}
              </span>
              <button type="button" onClick={onAccept}>
                {isIsc2AutomaticRenewalCredential(credential)
                  ? "Confirm renewed cycle →"
                  : isCompliancePeriodCredential(credential)
                    ? "Start next period →"
                  : "Record acceptance →"}
              </button>
            </div>
          ) : (
            <div className="submitted-note">
              {isCompliancePeriodCredential(credential)
                ? "Completed"
                : "Renewed"}{" "}
              {formatDate(credential.acceptedAt)}
              {credential.acceptanceReference
                ? ` · ${credential.acceptanceReference}`
                : ""}
            </div>
          )}
        </section>

        <section className="card recent-card" aria-labelledby="recent-title">
          <div className="card-heading">
            <div>
              <span className="section-kicker">Your records</span>
              <h2 id="recent-title">Recent learning</h2>
            </div>
            <button className="text-button" type="button" onClick={onViewRecords}>
              See all
            </button>
          </div>
          {workspace.activities.length ? (
            <div className="recent-list">
              {workspace.activities.slice(0, 3).map((activity) => (
                <article key={activity.id}>
                  <span
                    className={`evidence-mark ${activity.evidenceStatus}`}
                    aria-hidden="true"
                  >
                    {activity.evidenceStatus === "attached"
                      ? "✓"
                      : activity.evidenceStatus === "missing"
                        ? "!"
                        : "—"}
                  </span>
                  <div>
                    <strong>{activity.title}</strong>
                    <p>
                      {formatDate(activity.completionDate, {
                        month: "short",
                        day: "numeric",
                      })}
                      {allocationsFor(activity).length
                        ? ` · ${allocationsFor(activity).length} ${
                            allocationsFor(activity).length === 1
                              ? "credential"
                              : "credentials"
                          }`
                        : ""}
                    </p>
                  </div>
                  <span className="credit-value">
                    +{compactNumber(activity.totalUnits)}
                  </span>
                </article>
              ))}
            </div>
          ) : (
            <EmptyInline
              title="No learning logged yet"
              body="Your first record will appear here."
              action="Add one"
              onAction={onAddActivity}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function CredentialsView({
  credentials,
  selectedId,
  onSelect,
  onAdd,
  onSubmit,
  onAccept,
  onReminders,
  onAddToCalendar,
  onRequirementApplicability,
}: {
  credentials: Credential[];
  selectedId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onSubmit: () => void;
  onAccept: () => void;
  onReminders: () => void;
  onAddToCalendar: (credential: Credential) => void;
  onRequirementApplicability: (
    credentialId: string,
    requirement: Requirement,
    status: "applies" | "not_applicable",
  ) => void;
}) {
  const selected =
    credentials.find((credential) => credential.id === selectedId) ??
    credentials[0];
  return (
    <div className="view-stack">
      <PageGreeting
        eyebrow="Credentials"
        title="Every renewal, one clear place."
        body="Requirements, sources, cycles, and submission status stay connected."
        action={
          <button className="button button-primary" type="button" onClick={onAdd}>
            <span aria-hidden="true">＋</span>
            Add credential
          </button>
        }
      />
      {selected ? (
        <div className="credentials-layout">
          <aside className="credential-picker" aria-label="Your credentials">
            {credentials.map((credential) => (
              <button
                key={credential.id}
                className={credential.id === selected.id ? "active" : ""}
                type="button"
                onClick={() => onSelect(credential.id)}
              >
                <span>
                  <strong>{credential.credentialName}</strong>
                  <small>
                    {credential.jurisdiction} ·{" "}
                    {credential.status === "renewed"
                      ? "history"
                      : credential.status === "submitted" &&
                          isIsc2AutomaticRenewalCredential(credential)
                        ? "awaiting ISC2 renewal"
                        : credential.status === "submitted" &&
                            isCompliancePeriodCredential(credential)
                          ? "compliance recorded"
                          : credential.status}
                  </small>
                </span>
                <span className="picker-progress">
                  {credential.totalRequired > 0
                    ? `${credentialProgress(credential)}%`
                    : `${readinessScore(credential)}% ready`}
                </span>
              </button>
            ))}
            <button className="add-picker" type="button" onClick={onAdd}>
              ＋ Add another credential
            </button>
          </aside>
          <section className="credential-detail">
            <div className="credential-detail-header">
              <div>
                <span className="status-pill status-pill-dark">
                  {isIsc2AutomaticRenewalCredential(selected)
                    ? selected.status === "active"
                      ? "active renewal cycle"
                      : selected.status === "submitted"
                        ? "awaiting ISC2 renewal"
                        : "renewed"
                    : isCompliancePeriodCredential(selected)
                      ? selected.status === "active"
                        ? "compliance period"
                        : selected.status === "submitted"
                          ? "compliance recorded"
                          : "completed"
                      : selected.status}
                </span>
                <h2>{selected.credentialName}</h2>
                <p>
                  {selected.jurisdiction}
                  {selected.issuer ? ` · ${selected.issuer}` : ""}
                </p>
              </div>
              <div className="deadline-chip">
                <span>
                  {isCompliancePeriodCredential(selected)
                    ? "Complete by"
                    : "Renew by"}
                </span>
                <strong>{formatDate(selected.deadline)}</strong>
              </div>
            </div>
            {selected.status !== "renewed" ? (
              <div className="credential-utility-actions">
                <button
                  className="reminder-setting-link"
                  type="button"
                  onClick={onReminders}
                >
                  ◷ Configure{" "}
                  {isCompliancePeriodCredential(selected)
                    ? "compliance"
                    : "renewal"}{" "}
                  check-ins
                </button>
                <button
                  className="reminder-setting-link"
                  type="button"
                  onClick={() => onAddToCalendar(selected)}
                >
                  ＋ Add{" "}
                  {isCompliancePeriodCredential(selected)
                    ? "compliance"
                    : "renewal"}{" "}
                  date to calendar
                </button>
              </div>
            ) : null}
            <div className="detail-stats">
              <div>
                <span>Counted</span>
                <strong>
                  {selected.totalRequired > 0
                    ? `${compactNumber(selected.totalEarned)} / ${compactNumber(
                        selected.totalRequired,
                      )}`
                    : "Checklist"}
                </strong>
                <small>
                  {selected.totalRequired > 0
                    ? selected.unitLabel
                    : "no general CE total"}
                </small>
              </div>
              <div>
                <span>Readiness</span>
                <strong>{readinessScore(selected)}%</strong>
                <small>credits + checklist</small>
              </div>
              <div>
                <span>
                  {daysUntil(selected.deadline) < 0
                    ? "Past deadline"
                    : "Time left"}
                </span>
                <strong>{Math.abs(daysUntil(selected.deadline))}</strong>
                <small>
                  {daysUntil(selected.deadline) < 0
                    ? "days overdue"
                    : "days"}
                </small>
              </div>
            </div>
            <div className="detail-section">
              <div className="card-heading">
                <div>
                  <span className="section-kicker">Requirements</span>
                  <h3>Rule progress and limits</h3>
                </div>
              </div>
              {selected.totalRequired > 0 ? (
                <ProgressRow
                  name="Overall"
                  earned={selected.totalEarned}
                  required={selected.totalRequired}
                  unit={selected.unitLabel}
                />
              ) : (
                <p className="total-excess-note">
                  This regulator does not set a general numeric nursing CE
                  total. Complete the applicable training conditions and
                  checklist using the official record.
                </p>
              )}
              {Number(selected.totalExcessUnits ?? 0) > 0 ? (
                <p className="total-excess-note">
                  {compactNumber(selected.totalRawEarned ?? 0)}{" "}
                  {selected.unitLabel} are documented;{" "}
                  {compactNumber(selected.totalExcessUnits ?? 0)} exceed a
                  category limit.
                </p>
              ) : null}
              {Number(selected.unclassifiedUnits ?? 0) > 0 ? (
                <p className="total-excess-note">
                  {compactNumber(selected.unclassifiedUnits ?? 0)}{" "}
                  {selected.unitLabel} are preserved but excluded until their
                  required activity type is classified.
                </p>
              ) : null}
              {selected.requirements.map((requirement) => (
                <ProgressRow
                  key={requirement.id}
                  name={requirement.name}
                  earned={requirementEarned(requirement)}
                  required={requirement.requiredUnits}
                  unit={selected.unitLabel}
                  requirement={requirement}
                  onApplicability={
                    selected.status === "active"
                      ? (status) =>
                          onRequirementApplicability(
                            selected.id,
                            requirement,
                            status,
                          )
                      : undefined
                  }
                />
              ))}
            </div>
            <div className="detail-section source-detail">
              <span className="section-kicker">Rule source</span>
              <h3>
                {selected.ruleReviewStatus === "custom"
                  ? "Custom requirements"
                  : "Source-linked template"}
              </h3>
              {selected.ruleReviewStatus !== "custom" ? (
                <span
                  className={`verified-chip ${ruleReviewClass(
                    selected.ruleReviewStatus,
                  )}`}
                >
                  {ruleReviewLabel(selected.ruleReviewStatus)}
                </span>
              ) : null}
              <p>
                {selected.sourceTitle ??
                  "Confirm requirements and dates with the issuing organization, especially when rules or your license status change."}
              </p>
              {selected.sourceUrl ? (
                <a
                  className="button button-outline"
                  href={selected.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open official guidance ↗
                </a>
              ) : (
                <span className="custom-rule-label">
                  Entered manually · no official source attached
                </span>
              )}
            </div>
            {selected.status === "active" ? (
              <div className="detail-footer">
                <div>
                  <strong>
                    {isIsc2AutomaticRenewalCredential(selected)
                      ? "Does the ISC2 Dashboard show CPEs and annual maintenance fees satisfied?"
                      : isCompliancePeriodCredential(selected)
                        ? "Does the official record show this period complete?"
                      : "Finished your board submission?"}
                  </strong>
                  <p>
                    {isIsc2AutomaticRenewalCredential(selected)
                      ? "Save this milestone separately from completed learning."
                      : isCompliancePeriodCredential(selected)
                        ? "Save this official milestone separately from completed learning."
                      : "Log it separately from completed learning."}
                  </p>
                </div>
                <button
                  className="button button-primary"
                  type="button"
                  onClick={onSubmit}
                >
                  {isIsc2AutomaticRenewalCredential(selected)
                    ? "Save dashboard checkpoint"
                    : isCompliancePeriodCredential(selected)
                      ? "Record compliance"
                    : "Log submission"}
                </button>
              </div>
            ) : selected.status === "submitted" ? (
              <div className="detail-footer submitted-footer">
                <div>
                  <strong>
                    {isIsc2AutomaticRenewalCredential(selected)
                      ? "Awaiting ISC2 renewal"
                      : isCompliancePeriodCredential(selected)
                        ? "Compliance recorded"
                      : "Renewal submitted"}{" "}
                    {formatDate(selected.submittedAt)}
                  </strong>
                  <p>
                    {selected.confirmationNumber
                      ? `Confirmation: ${selected.confirmationNumber}`
                      : "No confirmation number recorded."}
                  </p>
                </div>
                <button
                  className="button button-primary"
                  type="button"
                  onClick={onAccept}
                >
                  {isIsc2AutomaticRenewalCredential(selected)
                    ? "Confirm renewed cycle"
                    : isCompliancePeriodCredential(selected)
                      ? "Start next period"
                    : "Record acceptance"}
                </button>
              </div>
            ) : (
              <div className="detail-footer submitted-footer">
                <div>
                  <strong>
                    {isCompliancePeriodCredential(selected)
                      ? "Completed"
                      : "Renewed"}{" "}
                    {formatDate(selected.acceptedAt)}
                  </strong>
                  <p>
                    {selected.acceptanceReference
                      ? `Reference: ${selected.acceptanceReference}`
                      : "This completed cycle is preserved in history."}
                  </p>
                </div>
                <span className="verified-chip">Historical cycle</span>
              </div>
            )}
          </section>
        </div>
      ) : (
        <EmptyPage
          title="Add your first credential"
          body="Choose a source-linked rule template or make a custom plan from your licensing information."
          action="Set up credential"
          onAction={onAdd}
        />
      )}
    </div>
  );
}

function RecordsView({
  activities,
  archivedActivities,
  credentials,
  onAdd,
  onEdit,
  onRestore,
  actionsDisabled,
  onEvidence,
  onAllocate,
  onClassify,
}: {
  activities: Activity[];
  archivedActivities: Activity[];
  credentials: Credential[];
  onAdd: () => void;
  onEdit: (activity: Activity) => void;
  onRestore: (activity: Activity) => void;
  actionsDisabled: boolean;
  onEvidence: (activity: Activity) => void;
  onAllocate: (activity: Activity) => void;
  onClassify: (
    activity: Activity,
    allocation: ActivityAllocation,
  ) => void;
}) {
  const credentialStatusById = new Map(
    credentials.map((credential) => [credential.id, credential.status]),
  );
  const recordIsMutable = (activity: Activity) =>
    activityIsMutable(activity, credentials);
  const total = activities.reduce(
    (sum, activity) =>
      sum +
      allocationsFor(activity).reduce(
        (allocationSum, allocation) =>
          allocationSum + allocation.allocatedUnits,
        0,
      ),
    0,
  );
  const missingProof = activities.filter(
    (activity) => activity.evidenceStatus === "missing",
  ).length;
  return (
    <div className="view-stack">
      <PageGreeting
        eyebrow="Activity record"
        title="Your learning, organized as you go."
        body="Credits earned and proof status stay visible before renewal season."
        action={
          <button className="button button-primary" type="button" onClick={onAdd}>
            <span aria-hidden="true">＋</span>
            Log activity
          </button>
        }
      />
      <section className="record-summary" id="records-summary" tabIndex={-1}>
        <div>
          <span>Total allocated</span>
          <strong>{compactNumber(total)}</strong>
          <small>credits across recorded cycles</small>
        </div>
        <div>
          <span>Activities</span>
          <strong>{activities.length}</strong>
          <small>completed learning records</small>
        </div>
        <div>
          <span>Proof to add</span>
          <strong>{missingProof}</strong>
          <small>{missingProof ? "worth reviewing" : "all clear"}</small>
        </div>
        <a
          className={`button button-outline ${
            credentials.length === 0 ? "disabled" : ""
          }`}
          href={credentials.length ? "/api/export" : undefined}
          aria-disabled={credentials.length === 0}
        >
          Export CSV ↓
        </a>
      </section>
      {activities.length ? (
        <section className="records-card" aria-label="Completed activities">
          <div className="records-table records-table-head" aria-hidden="true">
            <span>Activity</span>
            <span>Credential</span>
            <span>Proof</span>
            <span>Credits</span>
            <span>Actions</span>
          </div>
          {activities.map((activity) => (
            <article
              className={`records-table ${
                recordIsMutable(activity) ? "" : "frozen"
              }`}
              key={activity.id}
            >
              <div className="record-title">
                <span
                  className={`evidence-mark ${activity.evidenceStatus}`}
                  aria-hidden="true"
                >
                  {activity.evidenceStatus === "attached"
                    ? "✓"
                    : activity.evidenceStatus === "missing"
                      ? "!"
                      : "—"}
                </span>
                <span>
                  <strong>{activity.title}</strong>
                  <small>
                    {formatDate(activity.completionDate)}
                    {activity.provider ? ` · ${activity.provider}` : ""}
                  </small>
                </span>
              </div>
              <span>
                {allocationsFor(activity).length ? (
                  <span className="allocation-stack">
                    {allocationsFor(activity).map((allocation) => (
                      <span key={allocation.id}>
                        {allocation.credentialName}
                        <small>
                          {allocationCategoryLabel(allocation)} ·{" "}
                          {compactNumber(allocation.allocatedUnits)}
                        </small>
                        {allocation.classificationStatus ===
                        "needs_classification" ? (
                          <>
                            <small>
                              {allocation.classificationMessage ??
                                `Needs ${
                                  allocation.unresolvedExclusiveGroups?.join(
                                    " and ",
                                  ) || "activity-type"
                                } classification`}
                              {" · excluded from progress"}
                            </small>
                            {credentialStatusById.get(
                              allocation.credentialId,
                            ) !== "renewed" ? (
                              <button
                                className="proof-action allocation-action"
                                type="button"
                                onClick={() =>
                                  onClassify(activity, allocation)
                                }
                              >
                                Classify activity
                              </button>
                            ) : (
                              <small>Historical cycle is frozen</small>
                            )}
                          </>
                        ) : credentials.some(
                            (credential) =>
                              credential.id === allocation.credentialId &&
                              credential.status !== "renewed",
                          ) ? (
                          <button
                            className="proof-action allocation-action"
                            type="button"
                            onClick={() => onClassify(activity, allocation)}
                          >
                            Edit requirement tags
                          </button>
                        ) : null}
                      </span>
                    ))}
                  </span>
                ) : (
                  "Unassigned"
                )}
                {credentials.some(
                  (credential) =>
                    credential.status !== "renewed" &&
                    !allocationsFor(activity).some(
                      (allocation) =>
                        allocation.credentialId === credential.id,
                    ),
                ) ? (
                  <button
                    className="proof-action allocation-action"
                    type="button"
                    onClick={() => onAllocate(activity)}
                  >
                    ＋ Use for another
                  </button>
                ) : null}
              </span>
              <span className="proof-cell">
                <span className={`proof-label ${activity.evidenceStatus}`}>
                  {activity.evidenceDeletionPendingCount
                    ? "Removal pending"
                    : activity.evidenceStatus === "attached"
                    ? `${activity.evidenceCount || 1} on file`
                    : activity.evidenceStatus === "missing"
                      ? "Add later"
                      : "Not required"}
                </span>
                {!recordIsMutable(activity) ? (
                  <>
                    {activity.evidenceStatus === "attached" ||
                    activity.evidenceDeletionPendingCount ? (
                      <button
                        className="proof-action"
                        type="button"
                        onClick={() => onEvidence(activity)}
                      >
                        View proof
                      </button>
                    ) : null}
                    <small className="frozen-proof-note">
                      Proof is frozen with closed cycle history
                    </small>
                  </>
                ) : activity.evidenceStatus !== "not_required" ||
                  activity.evidenceDeletionPendingCount ? (
                  <button
                    className="proof-action"
                    type="button"
                    onClick={() => onEvidence(activity)}
                  >
                    {activity.evidenceCount ? "Manage" : "Upload"}
                  </button>
                ) : null}
              </span>
              <strong className="record-credit">
                {compactNumber(activity.totalUnits)}
              </strong>
              <div className="record-manage">
                {recordIsMutable(activity) ? (
                  <button
                    type="button"
                    aria-label={`Edit ${activity.title}`}
                    disabled={actionsDisabled}
                    onClick={() => onEdit(activity)}
                  >
                    Edit record
                  </button>
                ) : (
                  <span>Frozen history</span>
                )}
              </div>
            </article>
          ))}
        </section>
      ) : (
        <EmptyPage
          title="Your learning record starts here"
          body="Log a course, conference, webinar, or other completed activity in under a minute."
          action="Log first activity"
          onAction={onAdd}
        />
      )}
      {archivedActivities.length ? (
        <details className="archived-items archived-records">
          <summary id="archived-records-summary">
            <span>
              Archived records
              <small>
                {archivedActivities.length}{" "}
                {archivedActivities.length === 1 ? "record" : "records"}
              </small>
            </span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <div className="archived-item-list">
            {archivedActivities.map((activity) => {
              const mutable = recordIsMutable(activity);
              return (
                <article className="archived-item" key={activity.id}>
                  <div>
                    <strong>{activity.title}</strong>
                    <small>
                      {formatDate(activity.completionDate)}
                      {activity.provider ? ` · ${activity.provider}` : ""}
                      {" · "}
                      {compactNumber(activity.totalUnits)} credits
                    </small>
                  </div>
                  <div className="archived-item-actions">
                    {activity.evidenceStatus === "attached" ||
                    activity.evidenceDeletionPendingCount ? (
                      <button
                        type="button"
                        aria-label={`View proof for ${activity.title}`}
                        onClick={() => onEvidence(activity)}
                      >
                        View proof
                      </button>
                    ) : null}
                    {mutable ? (
                      <button
                        type="button"
                        aria-label={`Restore ${activity.title}`}
                        disabled={actionsDisabled}
                        onClick={() => onRestore(activity)}
                      >
                        Restore record
                      </button>
                    ) : (
                      <span className="archived-item-state">
                        History frozen
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ActivityEditorModal({
  activity,
  error,
  pending,
  isOnline,
  onClose,
  onSave,
  onArchive,
}: {
  activity: Activity;
  error: string;
  pending: boolean;
  isOnline: boolean;
  onClose: () => void;
  onSave: (input: {
    title: string;
    provider: string;
    completionDate: string;
    totalUnits: number;
    acceptedEducationAttested?: boolean;
  }) => void;
  onArchive: () => void;
}) {
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const allocations = allocationsFor(activity);
  const hasNremtAllocation = allocations.some((allocation) =>
    allocation.credentialRuleSetId?.startsWith("nremt-"),
  );
  const proofSummary =
    activity.evidenceStatus === "attached"
      ? `${activity.evidenceCount || 1} proof ${
          (activity.evidenceCount || 1) === 1 ? "file" : "files"
        } attached`
      : activity.evidenceStatus === "missing"
        ? "Proof still needs to be added"
        : "Proof is marked not required";

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({
      title: String(form.get("title") ?? ""),
      provider: String(form.get("provider") ?? ""),
      completionDate: String(form.get("completionDate") ?? ""),
      totalUnits: Number(form.get("totalUnits")),
      acceptedEducationAttested: hasNremtAllocation
        ? form.get("acceptedEducationAttested") === "on"
        : undefined,
    });
  };

  return (
    <Modal
      title="Edit learning record"
      eyebrow="Correct saved details"
      onClose={onClose}
    >
      <div className="form-stack">
        {error ? (
          <div className="modal-error" role="alert">
            <strong>This correction did not save</strong>
            <span>{error}</span>
          </div>
        ) : null}
        {allocations.length ? (
          <div className="advisory-note">
            <span aria-hidden="true">i</span>
            <p>
              This learning is used by{" "}
              {allocations.map((allocation) => allocation.credentialName).join(
                ", ",
              )}
              .{" "}
              {hasNremtAllocation
                ? "National Registry component and topic amounts stay exact, so a credit-total correction that would change that allocation must be logged as a corrected replacement record."
                : "If the corrected credit total is lower, any larger linked allocation and its requirement counts will be reduced to match."}
            </p>
          </div>
        ) : (
          <div className="advisory-note">
            <span aria-hidden="true">i</span>
            <p>
              This record is not currently applied to a credential. Correcting
              it will not change renewal progress.
            </p>
          </div>
        )}
        <form className="form-stack" onSubmit={handleSubmit}>
          <label className="field">
            <span>Course, conference, or activity</span>
            <input
              autoFocus
              name="title"
              defaultValue={activity.title}
              maxLength={ACTIVITY_DRAFT_TITLE_MAX_LENGTH}
              required
            />
          </label>
          <div className="form-grid">
            <label className="field">
              <span>Completion date</span>
              <input
                name="completionDate"
                type="date"
                defaultValue={activity.completionDate}
                required
              />
              <small>
                Keep the date accurate for every linked credential cycle.
              </small>
            </label>
            <label className="field">
              <span>Credits earned</span>
              <input
                name="totalUnits"
                type="number"
                min="0.01"
                max={ACTIVITY_DRAFT_MAX_UNITS}
                step="0.01"
                inputMode="decimal"
                defaultValue={activity.totalUnits}
                required
              />
              <small>
                Linked allocations above the corrected total will be reduced.
              </small>
            </label>
          </div>
          <label className="field">
            <span>
              Provider or organizer{" "}
              <em>
                {hasNremtAllocation
                  ? "Required for National Registry"
                  : "Optional"}
              </em>
            </span>
            <input
              name="provider"
              defaultValue={activity.provider ?? ""}
              maxLength={ACTIVITY_DRAFT_PROVIDER_MAX_LENGTH}
              required={hasNremtAllocation}
            />
          </label>
          {hasNremtAllocation ? (
            <label className="switch-row nremt-education-attestation">
              <span>
                <strong>Reconfirm accepted National Registry education</strong>
                <small>
                  I rechecked the corrected provider, course, and post-cap
                  credits against the current National Registry record.
                </small>
              </span>
              <input
                name="acceptedEducationAttested"
                type="checkbox"
                required
              />
            </label>
          ) : null}
          <div className="read-only-status" aria-label="Current proof status">
            <span
              className={`proof-label ${activity.evidenceStatus}`}
              aria-hidden="true"
            >
              {activity.evidenceStatus === "attached"
                ? "On file"
                : activity.evidenceStatus === "missing"
                  ? "Add later"
                  : "Not required"}
            </span>
            <p>
              <strong>Proof status stays unchanged</strong>
              <small>{proofSummary}. Manage proof separately in Records.</small>
            </p>
          </div>
          <div className="form-actions">
            <button
              className="button button-ghost"
              type="button"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              className="button button-primary"
              type="submit"
              disabled={pending || !isOnline}
            >
              {pending
                ? "Saving…"
                : isOnline
                  ? "Save corrections"
                  : "Reconnect to save"}
            </button>
          </div>
        </form>
        <section className="archive-zone" aria-labelledby="archive-record-title">
          <div>
            <strong id="archive-record-title">Archive this record</strong>
            <p>
              Use archive when this learning should no longer count toward an
              open renewal.
            </p>
          </div>
          {!confirmingArchive ? (
            <button
              className="archive-trigger"
              type="button"
              disabled={pending || !isOnline}
              onClick={() => setConfirmingArchive(true)}
            >
              Archive record
            </button>
          ) : (
            <div className="archive-confirmation" role="alert">
              <p>
                <strong>Archive this learning record?</strong>
                Its credits will leave active progress and exports. Proof stays
                saved, and you can restore the record later.
              </p>
              <div>
                <button
                  className="button button-ghost"
                  type="button"
                  disabled={pending}
                  onClick={() => setConfirmingArchive(false)}
                >
                  Keep record
                </button>
                <button
                  autoFocus
                  className="button button-danger"
                  type="button"
                  disabled={pending || !isOnline}
                  onClick={onArchive}
                >
                  {pending ? "Archiving…" : "Archive record"}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}

function PersonalTaskEditorModal({
  credential,
  task,
  error,
  pending,
  isOnline,
  onClose,
  onSave,
  onArchive,
}: {
  credential: Credential;
  task: RenewalTask | null;
  error: string;
  pending: boolean;
  isOnline: boolean;
  onClose: () => void;
  onSave: (input: { title: string; dueDate: string }) => void;
  onArchive?: () => void;
}) {
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const editing = Boolean(task);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({
      title: String(form.get("title") ?? ""),
      dueDate: String(form.get("dueDate") ?? ""),
    });
  };

  return (
    <Modal
      title={editing ? "Edit personal task" : "Add a personal task"}
      eyebrow={credential.credentialName}
      onClose={onClose}
    >
      <div className="form-stack">
        {error ? (
          <div className="modal-error" role="alert">
            <strong>This task did not save</strong>
            <span>{error}</span>
          </div>
        ) : null}
        <div className="advisory-note">
          <span aria-hidden="true">i</span>
          <p>
            Personal tasks count toward Packet readiness. Complete or archive
            them before submission. They do not earn XP.
          </p>
        </div>
        <form className="form-stack" onSubmit={handleSubmit}>
          <label className="field">
            <span>Task</span>
            <input
              autoFocus
              name="title"
              defaultValue={task?.title ?? ""}
              maxLength={160}
              placeholder="e.g., Request transcript from provider"
              required
            />
          </label>
          <label className="field">
            <span>
              Due date <em>Optional</em>
            </span>
            <input
              name="dueDate"
              type="date"
              defaultValue={task?.dueDate ?? ""}
            />
            <small>
              Due dates appear in Today check-ins when reminders are on.
            </small>
          </label>
          <div className="form-actions">
            <button
              className="button button-ghost"
              type="button"
              onClick={onClose}
              disabled={pending}
            >
              Cancel
            </button>
            <button
              className="button button-primary"
              type="submit"
              disabled={pending || !isOnline}
            >
              {pending
                ? "Saving…"
                : !isOnline
                  ? "Reconnect to save"
                  : editing
                    ? "Save changes"
                    : "Add task"}
            </button>
          </div>
        </form>
        {task?.isPersonal && onArchive ? (
          <section className="archive-zone" aria-labelledby="archive-task-title">
            <div>
              <strong id="archive-task-title">Archive this task</strong>
              <p>
                Remove it from Packet readiness and reminders without deleting
                its history.
              </p>
            </div>
            {!confirmingArchive ? (
              <button
                className="archive-trigger"
                type="button"
                disabled={pending || !isOnline}
                onClick={() => setConfirmingArchive(true)}
              >
                Archive task
              </button>
            ) : (
              <div className="archive-confirmation" role="alert">
                <p>
                  <strong>Archive this personal task?</strong>
                  This removes it from Packet readiness and reminders. You can
                  restore it later.
                </p>
                <div>
                  <button
                    className="button button-ghost"
                    type="button"
                    disabled={pending}
                    onClick={() => setConfirmingArchive(false)}
                  >
                    Keep task
                  </button>
                  <button
                    autoFocus
                    className="button button-danger"
                    type="button"
                    disabled={pending || !isOnline}
                    onClick={onArchive}
                  >
                    {pending ? "Archiving…" : "Archive task"}
                  </button>
                </div>
              </div>
            )}
          </section>
        ) : null}
      </div>
    </Modal>
  );
}

function AccountView({
  workspace,
  onReminders,
  onWeeklyGoal,
  weeklyGoalPending,
  isStandalone,
  installAvailable,
  onInstall,
  onAddAllCheckIns,
}: {
  workspace: Workspace;
  onReminders: () => void;
  onWeeklyGoal: (weeklyGoal: number) => void;
  weeklyGoalPending: boolean;
  isStandalone: boolean;
  installAvailable: boolean;
  onInstall: () => void;
  onAddAllCheckIns: () => void;
}) {
  const currentWeeklyGoal = workspace.profile.weeklyGoal;
  const scheduledWeeklyGoal = workspace.profile.nextWeeklyGoal;
  const scheduledWeeklyGoalEffectiveOn =
    workspace.profile.nextWeeklyGoalEffectiveOn;
  const savedWeeklyGoal =
    typeof scheduledWeeklyGoal === "number"
      ? scheduledWeeklyGoal
      : currentWeeklyGoal;
  const [weeklyGoalChoice, setWeeklyGoalChoice] = useState<number | null>(null);
  const selectedWeeklyGoal = weeklyGoalChoice ?? savedWeeklyGoal;

  const weeklyGoalPresets = [
    { label: "Light", value: 1 },
    { label: "Steady", value: 3 },
    { label: "Balanced", value: 4 },
    { label: "Focused", value: 5 },
    { label: "Ambitious", value: 7 },
  ];
  const weeklyGoalChanged = selectedWeeklyGoal !== savedWeeklyGoal;

  const handleWeeklyGoalSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!weeklyGoalChanged || weeklyGoalPending) return;
    onWeeklyGoal(selectedWeeklyGoal);
  };

  return (
    <div className="view-stack">
      <PageGreeting
        eyebrow="Account"
        title="A renewal system that stays yours."
        body="Your identity, momentum, and product safeguards in one place."
      />
      <div className="account-grid">
        <section className="card account-profile">
          <span className="account-avatar">
            {firstName(workspace.user.displayName).slice(0, 1).toUpperCase()}
          </span>
          <div>
            <span className="section-kicker">Signed in as</span>
            <h2>{workspace.user.displayName}</h2>
            <p>{workspace.user.email}</p>
          </div>
          {workspace.user.isDemo ? (
            <span className="demo-label">Local preview</span>
          ) : (
            <a
              className="button button-outline"
              href="/signout-with-chatgpt?return_to=%2F"
            >
              Sign out
            </a>
          )}
        </section>
        <section className="card account-momentum">
          <span className="section-kicker">Meaningful momentum</span>
          <h2>
            Level {workspace.progression.level.number} ·{" "}
            {workspace.progression.level.title}
          </h2>
          <p>
            License Lantern rewards real compliance work—not opening the app or
            protecting a fragile daily streak.
          </p>
          <div className="account-level">
            <div>
              <strong>{workspace.progression.lifetimeXp} XP earned</strong>
              <small>
                {workspace.progression.momentum.activeWeeks > 0
                  ? `${workspace.progression.momentum.activeWeeks} active ${
                      workspace.progression.momentum.activeWeeks === 1
                        ? "week"
                        : "weeks"
                    } in your current rhythm`
                  : "Your first completed compliance action starts a rhythm"}
              </small>
            </div>
            <div
              className="level-track"
              role="progressbar"
              aria-label={`${workspace.progression.level.progressPercent}% toward level ${workspace.progression.level.number + 1}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={workspace.progression.level.progressPercent}
            >
              <span
                style={{
                  width: `${workspace.progression.level.progressPercent}%`,
                }}
              />
            </div>
          </div>
          <div className="badge-grid">
            {workspace.profile.badges.map((badge) => (
              <article
                className={badge.earned || badge.earnedAt ? "earned" : ""}
                key={badge.id}
              >
                <span aria-hidden="true">
                  {badge.earned || badge.earnedAt ? "◆" : "◇"}
                </span>
                <div>
                  <strong>{badge.name}</strong>
                  <small>{badge.description}</small>
                </div>
              </article>
            ))}
          </div>
        </section>
        <section
          className="card weekly-rhythm-card"
          aria-labelledby="weekly-rhythm-title"
        >
          <span className="section-kicker">Weekly rhythm</span>
          <h2 id="weekly-rhythm-title">Choose a pace that fits real life.</h2>
          <p>
            Your current target is {currentWeeklyGoal}{" "}
            {currentWeeklyGoal === 1 ? "action" : "actions"} each week.
            Changes start next Monday, so this week’s goal stays fair. Missed
            days do not break your rhythm.
          </p>
          {typeof scheduledWeeklyGoal === "number" &&
          scheduledWeeklyGoalEffectiveOn ? (
            <div className="weekly-goal-scheduled" role="status">
              <span aria-hidden="true">↗</span>
              <p>
                <strong>
                  {scheduledWeeklyGoal}{" "}
                  {scheduledWeeklyGoal === 1 ? "action" : "actions"} starting{" "}
                  {formatDate(scheduledWeeklyGoalEffectiveOn)}
                </strong>
                <small>
                  Choose another pace below to replace this scheduled change.
                </small>
              </p>
            </div>
          ) : null}
          <form
            className="weekly-goal-form"
            aria-busy={weeklyGoalPending}
            onSubmit={handleWeeklyGoalSubmit}
          >
            <fieldset disabled={weeklyGoalPending}>
              <legend>Weekly action target</legend>
              <div className="weekly-goal-options">
                {weeklyGoalPresets.map((preset) => (
                  <label className="weekly-goal-option" key={preset.value}>
                    <input
                      type="radio"
                      name="weeklyGoal"
                      value={preset.value}
                      checked={selectedWeeklyGoal === preset.value}
                      onChange={() => setWeeklyGoalChoice(preset.value)}
                    />
                    <span>
                      <strong>{preset.label}</strong>
                      <small>
                        {preset.value}{" "}
                        {preset.value === 1 ? "action" : "actions"}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="weekly-goal-actions">
              <button
                className="button button-primary"
                type="submit"
                disabled={!weeklyGoalChanged || weeklyGoalPending}
              >
                {weeklyGoalPending
                  ? "Scheduling…"
                  : selectedWeeklyGoal === currentWeeklyGoal &&
                      typeof scheduledWeeklyGoal === "number"
                    ? "Keep current pace"
                    : "Start next Monday"}
              </button>
              <span aria-live="polite">
                {weeklyGoalPending
                  ? "Saving your weekly target."
                  : weeklyGoalChanged
                    ? "Ready to schedule."
                    : "Your saved pace is selected."}
              </span>
            </div>
          </form>
        </section>
        <section className="card reminder-settings-card">
          <span className="section-kicker">Due-date check-ins</span>
          <h2>
            {workspace.reminderPreferences.inAppEnabled
              ? "In-app reminders are on."
              : "In-app reminders are paused."}
          </h2>
          <p>
            {workspace.reminderPreferences.leadDays.length
              ? `Check-ins are scheduled ${workspace.reminderPreferences.leadDays.join(
                  ", ",
                )} days before due dates.`
              : "Choose when upcoming due dates should appear on Today."}
          </p>
          <div className="account-card-actions">
            <button
              className="button button-outline"
              type="button"
              onClick={onReminders}
            >
              Manage reminders
            </button>
            <button
              className="button button-outline"
              type="button"
              onClick={onAddAllCheckIns}
            >
              Add all check-ins to calendar
            </button>
          </div>
        </section>
        <section className="card phone-companion-card">
          <span className="section-kicker">Phone companion</span>
          <h2>
            {isStandalone
              ? "Installed and ready from your home screen."
              : "Keep License Lantern one tap away."}
          </h2>
          <p>
            {isStandalone
              ? "The installed app uses a protected offline fallback and reconnects to your cloud record when online."
              : installAvailable
                ? "Install the app for a focused, full-screen renewal workspace."
                : "Use your browser’s Install app or Add to Home Screen option for a focused, full-screen workspace."}
          </p>
          {!isStandalone ? (
            <button
              className="button button-primary"
              type="button"
              onClick={onInstall}
            >
              {installAvailable ? "Install on this device" : "How to install"}
            </button>
          ) : (
            <span className="installed-pill">✓ Installed on this device</span>
          )}
        </section>
        <section className="card compliance-card">
          <span className="section-kicker">A careful boundary</span>
          <h2>Organizer, not licensing authority.</h2>
          <p>
            License Lantern helps you track information and prepare for renewal. It
            does not determine course eligibility, guarantee board acceptance,
            or replace official instructions.
          </p>
          <ul>
            <li>Rule templates show their official source.</li>
            <li>Custom plans remain clearly labeled.</li>
            <li>Credits, proof, submission, and acceptance stay distinct.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}

function ProgressRow({
  name,
  earned,
  required,
  unit,
  requirement,
  onApplicability,
}: {
  name: string;
  earned: number;
  required: number;
  unit: string;
  requirement?: Requirement;
  onApplicability?: (
    status: "applies" | "not_applicable",
  ) => void;
}) {
  const kind = requirement ? requirementKind(requirement) : "minimum";
  const status = requirement ? requirementStatus(requirement) : "applies";
  const rawEarned = requirement
    ? requirementRawEarned(requirement)
    : earned;
  const excess = requirement
    ? Number(
        requirement.excessUnits ??
          (kind === "maximum" ? Math.max(0, rawEarned - required) : 0),
      )
    : 0;
  const nested = requirement?.relation === "nested";
  const conditional = requirement?.applicability === "conditional";

  if (status !== "applies") {
    return (
      <div
        className={`progress-row requirement-condition ${
          nested ? "nested" : ""
        }`}
      >
        <div>
          <span>
            <strong>{name}</strong>
            <small>
              {status === "needs_confirmation"
                ? "Needs confirmation"
                : "Not applicable this cycle"}
            </small>
          </span>
          {requirement?.conditionNote ? (
            <p>{requirement.conditionNote}</p>
          ) : null}
        </div>
        {onApplicability ? (
          <div className="requirement-condition-actions">
            {status !== "not_applicable" ? (
              <button
                type="button"
                onClick={() => onApplicability("not_applicable")}
              >
                Not this cycle
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onApplicability("applies")}
            >
              {status === "not_applicable" ? "Add to plan" : "Applies"}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  if (kind === "informational") {
    return (
      <div
        className={`progress-row requirement-condition ${
          nested ? "nested" : ""
        }`}
      >
        <div>
          <span>
            <strong>{name}</strong>
            <small>Checklist checkpoint</small>
          </span>
          {requirement?.conditionNote ? (
            <p>{requirement.conditionNote}</p>
          ) : null}
        </div>
        {conditional && onApplicability ? (
          <div className="requirement-condition-actions">
            <button
              type="button"
              onClick={() => onApplicability("not_applicable")}
            >
              Not this cycle
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const progress =
    required <= 0
      ? kind === "maximum"
        ? 0
        : 100
      : clampPercent((rawEarned / required) * 100);
  const met = kind === "maximum" ? excess === 0 : earned >= required;
  const statusLabel =
    kind === "maximum"
      ? excess > 0
        ? `${compactNumber(excess)} over limit`
        : "Within limit"
      : met
        ? "Minimum met"
        : null;
  return (
    <div
      className={`progress-row ${nested ? "nested" : ""} ${
        kind === "maximum" ? "maximum" : ""
      } ${excess > 0 ? "over-limit" : ""}`}
    >
      <div className="progress-label">
        <span>
          <strong>{name}</strong>
          {statusLabel ? (
            <small className={excess > 0 ? "limit-label" : "met-label"}>
              {statusLabel}
            </small>
          ) : null}
        </span>
        <span>
          <strong>
            {kind === "maximum"
              ? `${compactNumber(rawEarned)} of ${compactNumber(required)} max`
              : `${compactNumber(earned)} / ${compactNumber(required)}`}
          </strong>{" "}
          {unit}
        </span>
      </div>
      <div
        className={`progress-track ${met ? "met" : ""} ${
          excess > 0 ? "over-limit" : ""
        }`}
        role="progressbar"
        aria-label={`${name}: ${compactNumber(rawEarned)} of ${compactNumber(
          required,
        )} ${unit}${kind === "maximum" ? " maximum" : ""}`}
        aria-valuemin={0}
        aria-valuemax={required}
        aria-valuenow={Math.min(rawEarned, required)}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
      {kind === "maximum" && excess > 0 ? (
        <p className="limit-note">
          {compactNumber(earned)} {unit} count toward this limit;{" "}
          {compactNumber(excess)} are preserved but excluded.
        </p>
      ) : conditional && onApplicability ? (
        <button
          className="condition-change"
          type="button"
          onClick={() => onApplicability("not_applicable")}
        >
          Doesn’t apply this cycle?
        </button>
      ) : null}
    </div>
  );
}

function NremtRequirementAllocator({
  credential,
  availableUnits,
  initialMatches = [],
}: {
  credential: Credential;
  availableUnits: number;
  initialMatches?: RequirementMatchPayload[];
}) {
  const initialUnits = new Map(
    initialMatches.map((match) => [
      match.requirementId,
      Number(match.matchedUnits),
    ]),
  );
  const selectable = credential.requirements.filter(
    (requirement) =>
      requirementStatus(requirement) === "applies" &&
      requirement.isActive !== false,
  );
  const national = selectable.find((requirement) =>
    requirement.ruleCategoryId?.endsWith("-national"),
  );
  const componentRequirements = selectable.filter(
    (requirement) =>
      requirement === national ||
      requirement.ruleCategoryId?.endsWith("-local") ||
      requirement.ruleCategoryId?.endsWith("-individual"),
  );
  const nationalTopics = selectable.filter(
    (requirement) =>
      requirement.relation === "nested" &&
      requirement.parentRequirementId === national?.id,
  );
  const overlappingRequirements = selectable.filter(
    (requirement) => requirement.relation === "overlapping",
  );

  const amountInput = (requirement: Requirement) => (
    <label className="nremt-allocation-row" key={requirement.id}>
      <span>
        <strong>{requirement.name}</strong>
        <small>
          {requirement.relation === "nested"
            ? "Included within National"
            : requirement.relation === "overlapping"
              ? "Overlaps National; does not add credit"
              : `Cycle minimum ${compactNumber(requirement.requiredUnits)}`}
        </small>
      </span>
      <input
        aria-label={`${requirement.name} accepted credits`}
        name={`requirementMatch:${requirement.id}`}
        type="number"
        min="0"
        max={availableUnits > 0 ? availableUnits : undefined}
        step="0.1"
        inputMode="decimal"
        defaultValue={initialUnits.get(requirement.id) ?? 0}
        required
      />
    </label>
  );

  return (
    <fieldset className="nremt-requirement-allocator">
      <legend>National Registry accepted-credit allocation</legend>
      <p>
        Enter the portion NREMT accepts after any published course cap—not raw
        provider contact hours.
      </p>
      <section>
        <div className="nremt-allocation-heading">
          <strong>Component amounts</strong>
          <small>
            National + Local/State + Individual must equal the credits applied
            to this credential.
          </small>
        </div>
        <div className="nremt-allocation-list">
          {componentRequirements.map(amountInput)}
        </div>
      </section>
      <section>
        <div className="nremt-allocation-heading">
          <strong>National topic amounts</strong>
          <small>
            The five topics must total the National amount above. Assign each
            credited portion once.
          </small>
        </div>
        <div className="nremt-allocation-list topics">
          {nationalTopics.map(amountInput)}
        </div>
      </section>
      <section>
        <div className="nremt-allocation-heading">
          <strong>Pediatric overlap</strong>
          <small>
            Enter pediatric content already included in a National topic. It
            does not increase National or overall credit.
          </small>
        </div>
        <div className="nremt-allocation-list">
          {overlappingRequirements.map(amountInput)}
        </div>
      </section>
      <label className="switch-row nremt-education-attestation">
        <span>
          <strong>This is accepted, post-cap NREMT education</strong>
          <small>
            I confirmed the provider and course qualify under current National
            Registry accepted-education rules, the content is direct EMS
            clinical patient care at or above this certification level, and
            these are the NREMT-accepted units after any standardized-course
            maximum. Academic courses are not used for National credit.
          </small>
        </span>
        <input
          name="acceptedEducationAttested"
          type="checkbox"
          required
        />
      </label>
    </fieldset>
  );
}

function RequirementPicker({
  credential,
  initialRequirementIds = [],
}: {
  credential: Credential | null;
  initialRequirementIds?: string[];
}) {
  const [selectedRequirementIds, setSelectedRequirementIds] = useState<
    string[]
  >(() => [...new Set(initialRequirementIds)]);
  const requiresCfpActivityType =
    credential?.requirements.some(
      (requirement) =>
        requirement.ruleCategoryId === CFP_2027_GENERAL_CATEGORY_ID,
    ) ?? false;
  const requiresMaximumClassification =
    credential?.requirements.some(
      (requirement) =>
        requirementKind(requirement) === "maximum" &&
        Boolean(requirement.exclusiveGroup) &&
        requirementStatus(requirement) === "applies" &&
        requirement.isActive !== false,
    ) ?? false;
  const requiresLcswCreditCategory =
    credential?.requirements.some(
      (requirement) =>
        requirement.exclusiveGroup === NJ_LCSW_CREDIT_CATEGORY_GROUP &&
        requirementStatus(requirement) === "applies" &&
        requirement.isActive !== false,
    ) ?? false;
  const selectable =
    credential?.requirements.filter(
      (requirement) =>
        requirementStatus(requirement) === "applies" &&
        requirement.isActive !== false &&
        requirement.ruleCategoryId !== CFP_2027_GENERAL_CATEGORY_ID,
    ) ?? [];
  const unresolved =
    credential?.requirements.filter(
      (requirement) =>
        requirementStatus(requirement) === "needs_confirmation",
    ).length ?? 0;

  const toggleRequirement = (requirement: Requirement, checked: boolean) => {
    setSelectedRequirementIds((current) =>
      nextRequirementSelection(current, requirement, selectable, checked),
    );
  };

  return (
    <fieldset className="requirement-picker">
      <legend>
        Requirements this activity satisfies{" "}
        <em>
          {requiresCfpActivityType ||
          requiresMaximumClassification ||
          requiresLcswCreditCategory
            ? "Activity type required"
            : "Optional"}
        </em>
      </legend>
      {selectable.length ? (
        <div className="requirement-choice-list">
          {selectable.map((requirement) => (
            <label
              className={
                requirement.relation === "nested"
                  ? "requirement-choice nested"
                  : "requirement-choice"
              }
              key={requirement.id}
            >
              <input
                type="checkbox"
                name="requirementIds"
                value={requirement.id}
                checked={selectedRequirementIds.includes(requirement.id)}
                onChange={(event) =>
                  toggleRequirement(requirement, event.currentTarget.checked)
                }
              />
              <span className="requirement-check" aria-hidden="true">
                ✓
              </span>
              <span>
                <strong>{requirement.name}</strong>
                <small>
                  {requirementIncompatibilityMessage(
                    requirement,
                    selectable,
                  ) ??
                    (requirementKind(requirement) === "maximum" &&
                    requirement.relation === "nested"
                      ? `Counts up to ${compactNumber(
                          requirement.requiredUnits,
                        )} ${credential?.unitLabel ?? "units"} and rolls up to its parent cap; select any other subject tags too`
                      : requirementKind(requirement) === "maximum"
                        ? `Counts up to ${compactNumber(
                            requirement.requiredUnits,
                          )} ${credential?.unitLabel ?? "units"}`
                        : requirement.relation === "nested"
                          ? "Also rolls up to its parent requirement"
                          : requirement.exclusiveGroup
                            ? "Choose only one activity type from this group"
                            : requirement.relation === "overlapping"
                              ? "May overlap another selected requirement"
                              : "Counts within the overall total")}
                </small>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="requirement-picker-empty">
          {requiresCfpActivityType
            ? "Choose a CFP activity type before saving."
            : "Save without a tag and it will count toward the overall total."}
        </p>
      )}
      <small className="requirement-picker-hint">
        {requiresCfpActivityType
          ? "Choose Principal Topics, Practice Management, or Ethics. General CE is calculated from the selected activity type."
          : requiresMaximumClassification
            ? "Choose exactly one option from each capped activity-type group, plus every other rule this learning genuinely satisfies."
            : "Select every rule this learning genuinely satisfies. Overall credits are still counted only once."}
        {unresolved
          ? ` Confirm ${unresolved} conditional ${
              unresolved === 1 ? "rule" : "rules"
            } in the credential plan before tagging them.`
          : ""}
      </small>
    </fieldset>
  );
}

function PageGreeting({
  eyebrow,
  title,
  body,
  action,
}: {
  eyebrow: string;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-greeting">
      <div>
        <span className="page-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{body}</p>
      </div>
      {action}
    </header>
  );
}

function Modal({
  title,
  eyebrow,
  children,
  onClose,
}: {
  title: string;
  eyebrow: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const backdrop = backdropRef.current;
    const dialog = dialogRef.current;
    if (!backdrop || !dialog) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const surroundingElements = backdrop.parentElement
      ? Array.from(backdrop.parentElement.children).filter(
          (element): element is HTMLElement =>
            element instanceof HTMLElement && element !== backdrop,
        )
      : [];
    const priorSurroundingState = surroundingElements.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    const priorBodyOverflow = document.body.style.overflow;

    for (const element of surroundingElements) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }
    document.body.style.overflow = "hidden";

    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled]):not([type='hidden'])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const getFocusableElements = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter(
        (element) =>
          !element.hasAttribute("hidden") &&
          element.getAttribute("aria-hidden") !== "true",
      );
    const requestedInitialFocus =
      dialog.querySelector<HTMLElement>("[autofocus]");
    (requestedInitialFocus ?? dialog).focus({ preventScroll: true });

    const keepFocusInside = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      const activeElement =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;

      if (
        event.shiftKey &&
        (activeElement === first ||
          activeElement === dialog ||
          !activeElement ||
          !dialog.contains(activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (activeElement === last ||
          activeElement === dialog ||
          !activeElement ||
          !dialog.contains(activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog.addEventListener("keydown", keepFocusInside);
    return () => {
      dialog.removeEventListener("keydown", keepFocusInside);
      document.body.style.overflow = priorBodyOverflow;
      for (const state of priorSurroundingState) {
        state.element.inert = state.inert;
        if (state.ariaHidden === null) {
          state.element.removeAttribute("aria-hidden");
        } else {
          state.element.setAttribute("aria-hidden", state.ariaHidden);
        }
      }
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <div className="modal-backdrop" ref={backdropRef}>
      <section
        className="modal-card"
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header className="modal-header">
          <div>
            <span className="section-kicker">{eyebrow}</span>
            <h2 id="modal-title">{title}</h2>
          </div>
          <button
            className="modal-close"
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}

function EmptyInline({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="empty-inline">
      <span aria-hidden="true">＋</span>
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
      <button type="button" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

function EmptyPage({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <section className="empty-page">
      <span className="empty-page-mark" aria-hidden="true">
        L
      </span>
      <span className="section-kicker">Ready when you are</span>
      <h2>{title}</h2>
      <p>{body}</p>
      <button className="button button-primary" type="button" onClick={onAction}>
        {action}
      </button>
    </section>
  );
}

function EmptyModalState({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="empty-modal">
      <span aria-hidden="true">＋</span>
      <h3>{title}</h3>
      <p>{body}</p>
      <button className="button button-primary" type="button" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

function LoadingDashboard() {
  return (
    <div className="view-stack" aria-busy="true" aria-label="Loading License Lantern">
      <div className="loading-heading">
        <span />
        <strong />
        <small />
      </div>
      <div className="loading-hero">
        <span />
        <span />
        <span />
      </div>
      <div className="loading-grid">
        <span />
        <span />
        <span />
        <span />
      </div>
      <p className="sr-only" role="status">
        Loading your renewal workspace
      </p>
    </div>
  );
}

function OfflineWorkspace() {
  return (
    <section className="offline-workspace" role="status">
      <span className="offline-workspace-mark" aria-hidden="true">
        ⌁
      </span>
      <span className="section-kicker">Connection paused</span>
      <h1>Your cloud record is still protected.</h1>
      <p>
        License Lantern could not load this device’s signed-in workspace while
        offline. Reconnect and it will retry automatically; no credential,
        certificate, or account data was cached here.
      </p>
    </section>
  );
}

function WorkspaceLoadFailure({
  status,
  message,
  onRetry,
}: {
  status: number | null;
  message: string;
  onRetry: () => void;
}) {
  const authenticationFailure = status === 401 || status === 403;
  const serviceFailure = status !== null && status >= 500;
  const title = authenticationFailure
    ? "Your sign-in needs to be refreshed."
    : serviceFailure
      ? "License Lantern is temporarily unavailable."
      : "We couldn’t reach your workspace.";
  const body = authenticationFailure
    ? "Reload to continue through the protected sign-in flow. Your private renewal record remains in the cloud."
    : serviceFailure
      ? "The cloud service could not load your renewal record. Try again in a moment; no private data was cached here."
      : message ||
        "Your signed-in cloud record did not load. Check the connection and try again; no private data was cached here.";

  return (
    <section
      className="offline-workspace workspace-load-failure"
      role="alert"
    >
      <span className="offline-workspace-mark" aria-hidden="true">
        !
      </span>
      <span className="section-kicker">
        {authenticationFailure ? "Protected workspace" : "Connection interrupted"}
      </span>
      <h1>{title}</h1>
      <p>{body}</p>
      <button
        className="button button-primary"
        type="button"
        onClick={
          authenticationFailure
            ? () => window.location.reload()
            : onRetry
        }
      >
        {authenticationFailure ? "Reload and sign in" : "Try again"}
      </button>
    </section>
  );
}

function dayPart() {
  const hour = new Date().getHours();
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}
