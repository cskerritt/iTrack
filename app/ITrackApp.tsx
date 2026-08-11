"use client";

import {
  AnimationEvent,
  ChangeEvent,
  FormEvent,
  ReactNode,
  RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DENTAL_AGGREGATE_PARENT_CATEGORY_IDS,
  DENTAL_LINKED_APPLICABILITY_CATEGORY_GROUPS,
  DENTAL_REQUIRED_SUBTYPE_CATEGORY_GROUPS,
} from "@/db/catalog/dental";
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
  activeDentalCheckpoints,
  activeMinimums,
  clampPercent,
  credentialProgress,
  daysUntilDate,
  readinessScore,
  requirementEarned,
  requirementKind,
  requirementStatus,
} from "./lib/readiness";
import {
  oppositeFloridaMentalHealthRuleSetId,
} from "./lib/floridaMentalHealth";
import { isExpandedCertificationRuleSetId } from "./lib/expandedCertifications";
import {
  buildPath,
  parseRoute,
  readNavEntry,
  routeAt,
  withNavEntry,
  type DetailRoute,
  type Route,
  type TabName,
} from "./lib/navigation";
import {
  nextRequirementSelection,
  requirementIncompatibilityMessage,
} from "./lib/requirementCompatibility";
import {
  applicationServerKeyBytes,
  detectedPushCapability,
  deviceTimeZone,
  friendlyDeviceLabel,
  installedDisplayMode,
  isIosLike,
  pushSubscriptionUsesApplicationServerKey,
  safeReminderLaunchTarget,
  serializePushSubscription,
  type PushDeviceState,
  type ReminderLaunchTarget,
} from "./lib/webPush";

const DENTAL_LINKED_APPLICABILITY_CHILD_CATEGORY_IDS = new Set<string>(
  DENTAL_LINKED_APPLICABILITY_CATEGORY_GROUPS.flatMap((categoryIds) =>
    categoryIds.slice(1),
  ),
);

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
  isDentalCheckpoint?: boolean;
  checkpointStatus?: "pending" | "completed" | null;
  checkpointCompletedAt?: string | null;
  checkpointEvidenceNote?: string | null;
  checkpointRevision?: number;
};

type RenewalTask = {
  id: string;
  title: string;
  kind: string;
  status: "pending" | "completed";
  dueDate?: string | null;
  completedAt?: string | null;
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
  lifecycleKind?: "renewal" | "compliance_period" | "automatic_renewal";
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
  totalRemaining?: number;
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
  evidenceReference?: string | null;
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
    pushEnabled: boolean;
    pushHourLocal: number;
    webPushConfigured: boolean;
    vapidPublicKey: string | null;
    activePushDeviceCount: number;
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

type ToastState = {
  message: string;
  undo?: () => void;
};

type ActivityDraft = {
  title: string;
  completionDate: string;
  totalUnits: string;
  allocatedUnits: string;
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
const DENTAL_AGGREGATE_PARENT_CATEGORY_ID_SET = new Set<string>(
  DENTAL_AGGREGATE_PARENT_CATEGORY_IDS,
);
const DENTAL_AGGREGATE_BY_SUBTYPE_CATEGORY_ID = new Map<string, string>(
  DENTAL_REQUIRED_SUBTYPE_CATEGORY_GROUPS.flatMap(
    ([aggregateCategoryId, subtypeCategoryIds]) =>
      subtypeCategoryIds.map(
        (subtypeCategoryId) =>
          [subtypeCategoryId, aggregateCategoryId] as const,
      ),
  ),
);
const DENTAL_SUBTYPE_CATEGORY_IDS_BY_AGGREGATE = new Map<
  string,
  ReadonlySet<string>
>(
  DENTAL_REQUIRED_SUBTYPE_CATEGORY_GROUPS.map(
    ([aggregateCategoryId, subtypeCategoryIds]) => [
      aggregateCategoryId,
      new Set<string>(subtypeCategoryIds),
    ],
  ),
);

const pushSubscriptionIdentity = (
  subscription: ReturnType<typeof serializePushSubscription>,
) =>
  `${subscription.endpoint}|${subscription.keys.p256dh}|${subscription.keys.auth}`;

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
  return daysUntilDate(value, Date.now());
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
  if (isAbveCatalogRule(rule)) return "2025-01-01";
  return rule
    ? addMonthsIso(nextYearIso(), -rule.cycleMonths)
    : yearAgoIso();
}

function defaultCatalogDeadline(
  rule: CatalogRule | null | undefined,
) {
  return isAbveCatalogRule(rule) ? "2027-12-31" : nextYearIso();
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

function requirementRawEarned(requirement: Requirement) {
  return Number(requirement.rawEarned ?? requirement.earnedUnits ?? 0);
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

function firstName(displayName: string) {
  const candidate = displayName.includes("@")
    ? displayName.split("@")[0]
    : displayName.split(/\s+/)[0];
  return candidate || "there";
}

function isIsc2AutomaticRenewalCredential(
  credential: Credential | null | undefined,
) {
  return credential?.ruleSetId?.startsWith("isc2-") ?? false;
}

function isNremtCredential(credential: Credential | null | undefined) {
  return credential?.ruleSetId?.startsWith("nremt-") ?? false;
}

function isCrcCredential(credential: Credential | null | undefined) {
  return credential?.ruleSetId?.startsWith("crcc-") ?? false;
}

function isAbveCredential(credential: Credential | null | undefined) {
  return credential?.ruleSetId?.startsWith("abve-") ?? false;
}

function isNremtCatalogRule(rule: CatalogRule | null | undefined) {
  return rule?.id.startsWith("nremt-") ?? false;
}

function isFloridaMentalHealthCatalogRule(
  rule: CatalogRule | null | undefined,
) {
  return rule?.id.startsWith("fl-lcsw-lmft-lmhc-") ?? false;
}

function isCrccCatalogRule(rule: CatalogRule | null | undefined) {
  return rule?.id.startsWith("crcc-") ?? false;
}

function isAbveCatalogRule(rule: CatalogRule | null | undefined) {
  return rule?.id.startsWith("abve-") ?? false;
}

function isRehabilitationCertificationCatalogRule(
  rule: CatalogRule | null | undefined,
) {
  return isCrccCatalogRule(rule) || isAbveCatalogRule(rule);
}

function isExpandedCertificationCatalogRule(
  rule: CatalogRule | null | undefined,
) {
  return isExpandedCertificationRuleSetId(rule?.id);
}

function isExpandedCertificationCredential(
  credential: Credential | null | undefined,
) {
  return isExpandedCertificationRuleSetId(credential?.ruleSetId);
}

function requiresOfficialCatalogDates(
  rule: CatalogRule | null | undefined,
) {
  return (
    isNremtCatalogRule(rule) ||
    isFloridaMentalHealthCatalogRule(rule) ||
    isRehabilitationCertificationCatalogRule(rule) ||
    isExpandedCertificationCatalogRule(rule)
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

type CrcApprovalPayload = {
  crcApprovalType: "pre_approved" | "post_approved";
  crcProgramReference: string;
  crcApprovalAttested: true;
};

function crcRequirementMatchPayload(
  form: FormData,
  credential: Credential,
  allocatedUnits: number,
): RequirementMatchPayload[] {
  const requirements = credential.requirements.filter(
    (requirement) =>
      requirementStatus(requirement) === "applies" &&
      requirement.isActive !== false,
  );
  const general = requirements.find((requirement) =>
    requirement.ruleCategoryId?.endsWith("-general"),
  );
  const professionalDevelopment = requirements.find((requirement) =>
    requirement.ruleCategoryId?.endsWith("-professional-development"),
  );
  const ethics = requirements.find((requirement) =>
    requirement.ruleCategoryId?.endsWith("-ethics"),
  );
  if (!general || !professionalDevelopment || !ethics) {
    throw new Error(
      "This CRC template is missing an exact-allocation requirement. Refresh the credential before saving.",
    );
  }

  const amountFor = (requirement: Requirement) => {
    const value = Number(form.get(`requirementMatch:${requirement.id}`) ?? 0);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Enter a valid clock-hour amount for ${requirement.name}.`);
    }
    if (value > allocatedUnits + 0.0001) {
      throw new Error(
        `${requirement.name} cannot exceed the ${compactNumber(
          allocatedUnits,
        )} clock hours applied to this CRC.`,
      );
    }
    return value;
  };

  const generalUnits = amountFor(general);
  const professionalDevelopmentUnits = amountFor(professionalDevelopment);
  const ethicsUnits = amountFor(ethics);
  if (
    Math.abs(
      generalUnits + professionalDevelopmentUnits - allocatedUnits,
    ) > 0.0001
  ) {
    throw new Error(
      `General / Other Accepted CRC Credit and Professional Development must total ${compactNumber(
        allocatedUnits,
      )} clock hours.`,
    );
  }
  if (ethicsUnits > generalUnits + 0.0001) {
    throw new Error(
      "Ethics overlaps General / Other Accepted CRC Credit and cannot exceed the General amount.",
    );
  }

  return [
    { requirementId: general.id, matchedUnits: generalUnits },
    {
      requirementId: professionalDevelopment.id,
      matchedUnits: professionalDevelopmentUnits,
    },
    { requirementId: ethics.id, matchedUnits: ethicsUnits },
  ].filter((match) => match.matchedUnits > 0);
}

function crcApprovalPayload(form: FormData): CrcApprovalPayload {
  const approvalType = String(form.get("crcApprovalType") ?? "");
  if (
    approvalType !== "pre_approved" &&
    approvalType !== "post_approved"
  ) {
    throw new Error("Choose the CRCC pre-approved or post-approved pathway.");
  }
  const programReference = String(
    form.get("crcProgramReference") ?? "",
  ).trim();
  if (!programReference) {
    throw new Error(
      "Enter the CRCC approval number or post-approval program reference.",
    );
  }
  if (form.get("crcApprovalAttested") !== "on") {
    throw new Error(
      "Confirm that the activity and entered hours are accepted by CRCC.",
    );
  }
  return {
    crcApprovalType: approvalType,
    crcProgramReference: programReference,
    crcApprovalAttested: true,
  };
}

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

function isManagedDentalCredential(
  credential: Credential | null | undefined,
) {
  return Boolean(
    credential?.profession === "Dental" && credential.ruleSetId,
  );
}

function isManagedRehabilitationCredential(
  credential: Credential | null | undefined,
) {
  return Boolean(
    credential?.profession === "Vocational Rehabilitation" &&
      (credential.ruleSetId?.startsWith("crcc-") ||
        credential.ruleSetId?.startsWith("abve-")),
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
    isManagedNursingCredential(credential) ||
    isManagedDentalCredential(credential) ||
    isManagedRehabilitationCredential(credential) ||
    isExpandedCertificationCredential(credential)
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
    isManagedNursingCredential(credential) ||
    isManagedDentalCredential(credential) ||
    isManagedRehabilitationCredential(credential) ||
    isExpandedCertificationCredential(credential)
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

  const pendingDentalCheckpoint = activeDentalCheckpoints(credential).find(
    (requirement) => requirement.checkpointStatus !== "completed",
  );
  if (pendingDentalCheckpoint) {
    return {
      kind: "conditions",
      title: `Complete ${pendingDentalCheckpoint.name}`,
      body:
        "Save a concise certificate, card, portal, or assessment reference. This checkpoint does not add CE units.",
      buttonLabel: "Open requirements",
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

/*
 * In-flight mutations are tracked by key so the control that was actually used
 * is the only thing that changes state while the write is on the wire. Modal
 * and sheet submits share FORM_ACTION_KEY, so a background row write never
 * greys out an open sheet's Save button, and a sheet submit never freezes the
 * rows behind it. Nothing here writes optimistically: the workspace is still
 * only trusted after the server confirms and the refetch lands.
 */
const FORM_ACTION_KEY = "form";

function taskActionKey(taskId: string) {
  return `task:${taskId}`;
}

function requirementActionKey(requirementId: string) {
  return `requirement:${requirementId}`;
}

function activityActionKey(activityId: string) {
  return `activity:${activityId}`;
}

function questActionKey(questKey: string) {
  return `quest:${questKey}`;
}

const WEEKLY_GOAL_ACTION_KEY = "weeklyGoal";

const HOME_ROUTE: Route = { tab: "home", detail: null };

// What each tab is called, in one place: the two nav bars label their buttons
// from it and a pushed screen names the screen it returns to from it.
const TAB_LABELS: Record<TabName, string> = {
  home: "Home",
  credentials: "Credentials",
  history: "History",
  profile: "Profile",
};

/**
 * The app's navigation stack, backed by real browser history.
 *
 * Tabs are roots and switching between them *replaces* the entry, so the
 * hardware/edge-swipe back gesture never walks backwards through a trail of
 * tab taps — it leaves the app, which is what iOS does. Detail screens push,
 * so back pops them. Depth tracks only the entries this app created: without
 * it `pop()` on a cold deep link would call `history.back()` into whatever
 * page the user was on before iTrack.
 *
 * A tab switch taken *from* a pushed screen therefore has two jobs, not one:
 * it shows the new tab, and it unwinds the entries the app pushed. Skipping
 * the unwind is what would leave an orphan behind — the entry the push was
 * made from, still sitting under the tab root the switch wrote — and back
 * would then return to the tab the user just left instead of leaving the app.
 * The unwind is a `history.go`, so it lands a beat later; the tab is shown
 * immediately and `pendingTab` finishes the job when the entry arrives.
 */
function useNavigation() {
  // Deliberately *not* seeded from `window.location` — the server renders this
  // component with no window, so it always emits the home root. Seeding the
  // client differently would make a deep link like /credentials disagree with
  // the server HTML and throw the hydrated tree away; the mount effect below
  // adopts the real URL one render later instead.
  const [route, setRoute] = useState<Route>(HOME_ROUTE);
  // The same route, readable during an event rather than a render, so nothing
  // here has to reach for it through a state updater — a `pushState` inside
  // one would fire twice under StrictMode's double invocation.
  const routeRef = useRef<Route>(HOME_ROUTE);
  const depthRef = useRef(0);
  const pendingTabRef = useRef<TabName | null>(null);

  const applyRoute = useCallback((next: Route) => {
    routeRef.current = next;
    setRoute(next);
  }, []);

  const commitTab = useCallback(
    (tab: TabName) => {
      const next: Route = { tab, detail: null };
      depthRef.current = 0;
      window.history.replaceState(
        withNavEntry(window.history.state, { depth: 0, tab }),
        "",
        buildPath(next),
      );
      applyRoute(next);
    },
    [applyRoute],
  );

  useEffect(() => {
    const adopt = (state: unknown) => {
      const entry = readNavEntry(state);
      depthRef.current = entry?.depth ?? 0;
      applyRoute(routeAt(window.location.pathname, entry));
    };
    adopt(window.history.state);
    const onPop = (event: PopStateEvent) => {
      const pending = pendingTabRef.current;
      if (pending !== null) {
        pendingTabRef.current = null;
        commitTab(pending);
        return;
      }
      adopt(event.state);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [applyRoute, commitTab]);

  const setTab = useCallback(
    (tab: TabName) => {
      if (pendingTabRef.current !== null) {
        // An unwind is already on its way back; a second `go` would travel
        // past the tab root and out of the app. Re-aim the one in flight.
        pendingTabRef.current = tab;
        applyRoute({ tab, detail: null });
        return;
      }
      if (depthRef.current > 0) {
        pendingTabRef.current = tab;
        // The tab is shown now and the history is squared away on the popstate
        // this asks for; until then the URL still names the screen being left.
        applyRoute({ tab, detail: null });
        window.history.go(-depthRef.current);
        return;
      }
      commitTab(tab);
    },
    [applyRoute, commitTab],
  );

  const push = useCallback(
    (detail: DetailRoute) => {
      const tab = routeRef.current.tab;
      const depth = depthRef.current + 1;
      depthRef.current = depth;
      window.history.pushState(
        withNavEntry(null, { depth, tab }),
        "",
        buildPath({ tab, detail }),
      );
      applyRoute({ tab, detail });
    },
    [applyRoute],
  );

  // The screen stays where it is in the stack and swaps which credential it is
  // showing — what an accepted renewal does, having just replaced the cycle
  // the screen was opened on with its successor.
  const replaceDetail = useCallback(
    (detail: DetailRoute) => {
      const { tab, detail: current } = routeRef.current;
      if (!current) return;
      window.history.replaceState(
        withNavEntry(window.history.state, {
          depth: depthRef.current,
          tab,
        }),
        "",
        buildPath({ tab, detail }),
      );
      applyRoute({ tab, detail });
    },
    [applyRoute],
  );

  const pop = useCallback(() => {
    if (depthRef.current > 0) {
      window.history.back();
      return;
    }
    // Nothing of ours underneath — a cold deep link. Drop to the tab root
    // rather than calling `back()` out of the app entirely.
    commitTab(routeRef.current.tab);
  }, [commitTab]);
  const popToRoot = pop; // single-level stack today; alias kept for tab re-tap
  return { route, setTab, push, replaceDetail, pop, popToRoot };
}

// The left-hand band the back gesture may start in, how far it then has to
// travel before letting go means "go back" rather than "never mind", and the
// vertical travel past which the finger is plainly scrolling instead.
const EDGE_SWIPE_ZONE = 24;
const EDGE_SWIPE_COMMIT = 80;
const EDGE_SWIPE_ABANDON = 40;

/**
 * The platform back gesture: drag from the left edge and the pushed screen
 * comes with the finger; let go past the threshold and it leaves.
 *
 * The listeners sit on the document rather than on the stack because the edge
 * band overlaps the page gutter, and a touch that lands in the gutter never
 * reaches the stack to bubble out of it. The drag is published as a custom
 * property on the stack instead of as React state — see SCREEN STACK in
 * globals.css, where both screens read it — because this runs on every frame
 * of a drag and a re-render per frame is a dropped one.
 */
function useEdgeSwipeBack(
  stackRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  onBack: () => void,
) {
  useEffect(() => {
    const stack = stackRef.current;
    if (!enabled || !stack) return;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    const release = () => {
      tracking = false;
      stack.classList.remove("screen-dragging");
    };
    const rest = () => {
      release();
      stack.style.removeProperty("--screen-drag");
    };
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      // Whatever is on top owns the finger. A sheet covers the whole viewport,
      // so an edge drag over one belongs to it — without this, pushing a sheet
      // away would also pop the screen it is sitting on.
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".modal-backdrop") !== null
      ) {
        return;
      }
      tracking = touch.clientX <= EDGE_SWIPE_ZONE;
      startX = touch.clientX;
      startY = touch.clientY;
      if (tracking) stack.classList.add("screen-dragging");
    };
    const onMove = (event: TouchEvent) => {
      if (!tracking) return;
      const touch = event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = Math.abs(touch.clientY - startY);
      if (dy > EDGE_SWIPE_ABANDON && dy > Math.abs(dx)) {
        rest();
        return;
      }
      // Only forwards: dragging back past the edge would peel the screen off
      // its own left side, which is not a thing this stack can show.
      stack.style.setProperty("--screen-drag", `${Math.max(0, dx)}px`);
    };
    const onEnd = (event: TouchEvent) => {
      if (!tracking) return;
      const dx = event.changedTouches[0]
        ? event.changedTouches[0].clientX - startX
        : 0;
      if (dx > EDGE_SWIPE_COMMIT) {
        // The offset deliberately stays where the finger left it: the exit
        // animation reads it as its starting point, so the screen carries on
        // from the release instead of snapping back and then leaving.
        release();
        onBack();
        return;
      }
      rest();
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
      // The class goes, the offset stays: this teardown runs on the pop that a
      // committed drag just asked for, and the exit animation about to start
      // is the one thing still reading that offset. Whatever it leaves behind
      // is cleared when the animation ends.
      release();
    };
  }, [enabled, onBack, stackRef]);
}

// Below this width every modal is anchored to the bottom edge (see SHEET in
// globals.css), which is the only shape a downward drag is a dismissal of.
// Above it the dialog is centred and the gesture does not exist.
const SHEET_MEDIA = "(max-width: 540px)";
// How far the sheet has to be pushed before letting go means "close this", and
// the sideways travel past which the finger is plainly doing something else.
const SHEET_DISMISS_COMMIT = 120;
const SHEET_DISMISS_ABANDON = 30;

/**
 * The platform's sheet dismissal: push the sheet back down and it goes.
 *
 * It may only start from the top of the sheet's own scroll — below that the
 * finger belongs to the content, and a sheet that slides away while its reader
 * is scrolling back up is the most irritating gesture a phone can have. The
 * offset is published as a custom property rather than as React state for the
 * same reason the back gesture does it: this runs on every frame of a drag.
 */
function useSheetDragDismiss(
  cardRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
) {
  // Read through a ref so the listeners are attached once, at mount, rather
  // than re-attached — mid-drag, losing the gesture — every time the sheet's
  // owner re-renders and hands down a fresh closure.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  // The gesture exists only at the width where the dialog *is* a bottom sheet,
  // and that width can change under an open sheet — a phone rotates. Tracked
  // live rather than read once at mount, so the gesture and the grabber that
  // advertises it are never out of step with each other.
  const [isSheet, setIsSheet] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(SHEET_MEDIA);
    const sync = () => setIsSheet(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const card = cardRef.current;
    if (!card || !isSheet) return;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    const release = () => {
      tracking = false;
      card.classList.remove("sheet-dragging");
    };
    const rest = () => {
      release();
      card.style.removeProperty("--sheet-drag");
    };
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      tracking = card.scrollTop <= 0;
      startX = touch.clientX;
      startY = touch.clientY;
      if (tracking) card.classList.add("sheet-dragging");
    };
    const onMove = (event: TouchEvent) => {
      if (!tracking) return;
      const touch = event.touches[0];
      if (!touch) return;
      const dy = touch.clientY - startY;
      const dx = Math.abs(touch.clientX - startX);
      // Upwards is the content's own scroll, and a sideways drag is a swipe
      // through something inside the sheet; neither is this gesture.
      if (dy < 0 || (dx > SHEET_DISMISS_ABANDON && dx > dy)) {
        rest();
        return;
      }
      card.style.setProperty("--sheet-drag", `${dy}px`);
    };
    const onEnd = (event: TouchEvent) => {
      if (!tracking) return;
      const dy = event.changedTouches[0]
        ? event.changedTouches[0].clientY - startY
        : 0;
      if (dy > SHEET_DISMISS_COMMIT) {
        // The offset stays where the finger left it deliberately: the sheet
        // unmounts on the next render, so clearing it here would paint one
        // frame of the sheet snapping back up before it disappeared.
        //
        // Unless the owner refuses to close — the log sheet holds itself open
        // when a draft cannot be saved — in which case the sheet is still
        // here a frame later and has to come back up, or it would sit parked
        // at the drag offset with its controls pushed off-screen.
        release();
        dismissRef.current();
        window.requestAnimationFrame(() => {
          if (card.isConnected) card.style.removeProperty("--sheet-drag");
        });
        return;
      }
      rest();
    };
    card.addEventListener("touchstart", onStart, { passive: true });
    card.addEventListener("touchmove", onMove, { passive: true });
    card.addEventListener("touchend", onEnd);
    card.addEventListener("touchcancel", onEnd);
    return () => {
      card.removeEventListener("touchstart", onStart);
      card.removeEventListener("touchmove", onMove);
      card.removeEventListener("touchend", onEnd);
      card.removeEventListener("touchcancel", onEnd);
      // A sheet that stops being a sheet mid-drag — the phone rotated — keeps
      // neither the drag class nor the offset it was placed by.
      rest();
    };
  }, [cardRef, isSheet]);
}

/*
 * The phone's own answer to a tap. Haptics are the shell's to provide — the
 * Capacitor plugin injects itself into the page at runtime — so this looks the
 * plugin up on every call and does nothing when it is not there. That is the
 * whole error path: on the web, and in any shell built before the plugin
 * landed, a missing rumble is not a failure worth reporting.
 */
type HapticsPlugin = {
  impact?: (options: { style: string }) => Promise<void> | void;
};

function hapticTap(style: "light" | "medium" = "light") {
  if (typeof window === "undefined") return;
  const haptics = (
    window as unknown as {
      Capacitor?: { Plugins?: { Haptics?: HapticsPlugin } };
    }
  ).Capacitor?.Plugins?.Haptics;
  const impact = haptics?.impact?.({
    style: style === "light" ? "LIGHT" : "MEDIUM",
  });
  void Promise.resolve(impact).catch(() => {});
}

export function ITrackApp() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const nav = useNavigation();
  const view = nav.route.tab;
  // Pulled out because it is stable for the component's lifetime (a
  // no-dependency useCallback) while `nav` itself is a fresh object every
  // render — effects can depend on this without re-running constantly.
  const navigateToTab = nav.setTab;
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
  const [catalogRules, setCatalogRules] = useState<CatalogRule[] | null>(null);
  const [catalogStatus, setCatalogStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [pendingActionKeys, setPendingActionKeys] = useState<string[]>([]);
  // Sheet and modal submits only. Row-level writes carry their own key so the
  // surface behind an open sheet keeps working.
  const pending = pendingActionKeys.includes(FORM_ACTION_KEY);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<ToastState | null>(null);
  const [activityDraft, setActivityDraft] = useState<ActivityDraft>(() => ({
    title: "",
    completionDate: todayIso(),
    totalUnits: "",
    allocatedUnits: "",
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
  const [installHelpOpen, setInstallHelpOpen] = useState(false);
  const [pushDeviceState, setPushDeviceState] =
    useState<PushDeviceState>("checking");
  const [pushPending, setPushPending] = useState(false);
  const [currentPushSubscription, setCurrentPushSubscription] =
    useState<PushSubscription | null>(null);
  const [pendingReminderLaunch, setPendingReminderLaunch] =
    useState<ReminderLaunchTarget | null>(null);
  const [highlightedReminderKey, setHighlightedReminderKey] = useState("");
  const pushRegistrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const savedPushSubscriptionRef = useRef<string | null>(null);
  const selectionBeforeActivityEntry = useRef<string | null>(null);
  const activityScanSequence = useRef(0);
  const activityDraftPersistenceEnabled = useRef(false);
  const activityDraftPersistenceGeneration = useRef(0);
  const catalogRequest = useRef<Promise<boolean> | null>(null);
  const workspaceLoadSequence = useRef(0);
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
      allocatedUnits: "",
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

  const openActivityEntryFor = useCallback(
    (preselectCredentialId: string) => {
      hapticTap();
      // A stale message from an earlier attempt must not greet a fresh sheet.
      setError("");
      activityDraftPersistenceGeneration.current += 1;
      activityDraftPersistenceEnabled.current = true;
      // Every credential choice made inside this sheet — a restored draft's
      // credential or one picked from "Apply to credential" — targets this entry
      // only. The dashboard's own credential is captured here and put back when
      // the sheet closes without saving, so Today never re-points silently.
      if (selectionBeforeActivityEntry.current === null) {
        selectionBeforeActivityEntry.current = selectedCredentialId;
      }
      // A shortcut that names a credential — Home's "Log credits" card — is the
      // user pointing at one explicitly, so it outranks the credential a
      // restored draft was aimed at. The draft's typed fields are still put
      // back; only where they would land changes.
      const preselected =
        workspace?.credentials.find(
          (candidate) =>
            candidate.id === preselectCredentialId &&
            candidate.status !== "renewed",
        ) ?? null;
      if (preselected) setSelectedCredentialId(preselected.id);
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
              allocatedUnits: saved.allocatedUnits || saved.totalUnits,
              provider: saved.provider,
            });
            // The restored draft only re-targets the credential for this form;
            // the app-wide selection captured above is restored when the form
            // closes unsaved.
            const target = preselected ?? credential;
            if (target) {
              setSelectedCredentialId(target.id);
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
    },
    [draftStorageKey, resetActivityEntry, selectedCredentialId, workspace],
  );

  // The plain "log something" entry point. Kept separate from the shortcut
  // above because it is handed straight to `onClick`, which would otherwise
  // call it with a mouse event where the credential id belongs.
  const openActivityEntry = useCallback(() => {
    openActivityEntryFor("");
  }, [openActivityEntryFor]);

  const restoreSelectionBeforeActivityEntry = useCallback(() => {
    const previousSelection = selectionBeforeActivityEntry.current;
    selectionBeforeActivityEntry.current = null;
    if (previousSelection === null) return;
    setSelectedCredentialId(previousSelection);
  }, []);

  const closeActivityEntry = useCallback(() => {
    const draftPersisted = persistActivityDraftNow();
    if (!draftPersisted) {
      setToast({
        message:
          "This browser couldn’t save your draft. Keep this form open or finish logging the activity before leaving.",
      });
      return;
    }
    // Only the sheet's own message is dropped here. Escape also runs this
    // helper when nothing is open, and a workspace-load failure message has to
    // survive that.
    if (activityOpen) setError("");
    activityDraftPersistenceEnabled.current = false;
    activityDraftPersistenceGeneration.current += 1;
    restoreSelectionBeforeActivityEntry();
    setActivityOpen(false);
    resetActivityEntry();
  }, [
    activityOpen,
    persistActivityDraftNow,
    resetActivityEntry,
    restoreSelectionBeforeActivityEntry,
  ]);

  const loadWorkspace = useCallback(async () => {
    // Two row-level writes can now be in flight at once, so two refetches can
    // be too. A response that has been overtaken is dropped rather than
    // allowed to paint an older snapshot of the record over a newer one.
    const requestId = (workspaceLoadSequence.current += 1);
    const superseded = () => requestId !== workspaceLoadSequence.current;
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
      if (superseded()) return true;
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
      if (superseded()) return false;
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

  // The searchable template catalog is global reference data, so it is fetched
  // once per session — when the chooser first opens — instead of riding along
  // on every workspace read. A failed attempt clears the cached request so the
  // next open retries.
  const loadCatalog = useCallback(async () => {
    if (catalogRequest.current) return catalogRequest.current;
    setCatalogStatus("loading");
    const request = (async () => {
      try {
        const response = await fetch("/api/catalog", {
          headers: { accept: "application/json" },
        });
        const data = (await response.json()) as {
          catalog?: CatalogRule[];
          error?: string;
        };
        if (!response.ok || !Array.isArray(data.catalog)) {
          throw new Error(
            data.error || "We couldn’t load the credential templates.",
          );
        }
        setCatalogRules(data.catalog);
        setCatalogStatus("ready");
        return true;
      } catch {
        catalogRequest.current = null;
        setCatalogStatus("error");
        return false;
      }
    })();
    catalogRequest.current = request;
    return request;
  }, []);

  const openCredentialSetup = useCallback(() => {
    setError("");
    setCredentialOpen(true);
    void loadCatalog();
  }, [loadCatalog]);

  const workspaceLoaded = Boolean(workspace);
  const webPushConfigured = Boolean(
    workspace?.reminderPreferences.webPushConfigured,
  );
  const vapidPublicKey = workspace?.reminderPreferences.vapidPublicKey ?? null;

  const refreshPushDeviceState = useCallback(async () => {
    const capability = detectedPushCapability(isStandalone);
    if (capability !== "available") {
      setCurrentPushSubscription(null);
      setPushDeviceState(capability);
      return;
    }
    if (!workspaceLoaded) {
      setPushDeviceState("checking");
      return;
    }
    if (!webPushConfigured || !vapidPublicKey) {
      setCurrentPushSubscription(null);
      setPushDeviceState("unconfigured");
      return;
    }
    try {
      const registration =
        pushRegistrationRef.current ??
        (await navigator.serviceWorker.ready);
      pushRegistrationRef.current = registration;
      const subscription = await registration.pushManager.getSubscription();
      if (
        subscription &&
        !pushSubscriptionUsesApplicationServerKey(
          subscription,
          vapidPublicKey,
        )
      ) {
        setCurrentPushSubscription(subscription);
        setPushDeviceState("available");
        return;
      }
      if (subscription) {
        const serializedSubscription = serializePushSubscription(subscription);
        const identity = pushSubscriptionIdentity(serializedSubscription);
        if (savedPushSubscriptionRef.current !== identity) {
          const response = await fetch("/api/workspace", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "savePushSubscription",
              payload: {
                subscription: serializedSubscription,
                deviceLabel: friendlyDeviceLabel(),
                enableAccountPush: false,
              },
            }),
          });
          if (!response.ok) {
            throw new Error(
              "This device could not refresh its alert connection.",
            );
          }
          savedPushSubscriptionRef.current = identity;
        }
      }
      setCurrentPushSubscription(subscription);
      setPushDeviceState(subscription ? "subscribed" : "available");
    } catch {
      setCurrentPushSubscription(null);
      setPushDeviceState("error");
    }
  }, [
    isStandalone,
    vapidPublicKey,
    webPushConfigured,
    workspaceLoaded,
  ]);

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
      window.isSecureContext
    ) {
      void navigator.serviceWorker
        .register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        })
        .then((registration) => {
          pushRegistrationRef.current = registration;
        })
        .catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const standalone = installedDisplayMode();
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
    const timeout = window.setTimeout(() => {
      void refreshPushDeviceState();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [refreshPushDeviceState]);

  useEffect(() => {
    const launchTarget = safeReminderLaunchTarget(window.location.href);
    const launchTimeout = launchTarget
      ? window.setTimeout(() => setPendingReminderLaunch(launchTarget), 0)
      : null;

    const handleServiceWorkerMessage = (event: MessageEvent<unknown>) => {
      if (
        !event.data ||
        typeof event.data !== "object" ||
        !("type" in event.data) ||
        event.data.type !== "OPEN_REMINDER" ||
        !("path" in event.data) ||
        typeof event.data.path !== "string"
      ) {
        return;
      }
      const target = safeReminderLaunchTarget(event.data.path);
      if (target) setPendingReminderLaunch(target);
    };
    navigator.serviceWorker?.addEventListener(
      "message",
      handleServiceWorkerMessage,
    );
    return () => {
      if (launchTimeout !== null) window.clearTimeout(launchTimeout);
      navigator.serviceWorker?.removeEventListener(
        "message",
        handleServiceWorkerMessage,
      );
    };
  }, []);

  useEffect(() => {
    if (!workspace || !pendingReminderLaunch) return;
    const controller = new AbortController();
    // Scrub the one-time `?delivery=` token out of the address bar so a
    // refresh cannot replay it. The path itself belongs to the router now, so
    // keep whatever route we are on rather than pinning back to "/".
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname,
    );
    void (async () => {
      try {
        const response = await fetch(
          `/api/workspace?delivery=${encodeURIComponent(
            pendingReminderLaunch.deliveryId,
          )}`,
          {
            headers: { accept: "application/json" },
            cache: "no-store",
            signal: controller.signal,
          },
        );
        const result = (await response.json()) as {
          target?: {
            credentialId?: unknown;
            reminderKey?: unknown;
          };
        };
        if (controller.signal.aborted) return;
        setPendingReminderLaunch(null);
        if (
          !response.ok ||
          typeof result.target?.credentialId !== "string" ||
          typeof result.target.reminderKey !== "string"
        ) {
          setHighlightedReminderKey("");
          setToast({
            message:
              "That check-in is no longer available in this signed-in workspace.",
          });
          return;
        }
        const credential = workspace.credentials.find(
          (candidate) =>
            candidate.id === result.target?.credentialId &&
            candidate.status !== "renewed",
        );
        const reminder = workspace.reminders.find(
          (candidate) =>
            candidate.key === result.target?.reminderKey &&
            candidate.credentialId === result.target?.credentialId,
        );
        if (!credential) {
          setHighlightedReminderKey("");
          setToast({
            message:
              "That check-in is no longer available in this signed-in workspace.",
          });
          return;
        }
        setSelectedCredentialId(credential.id);
        navigateToTab("home");
        setHighlightedReminderKey(reminder?.key ?? "");
        if (!reminder) {
          setToast({
            message:
              "That check-in may already be complete. The related credential is open.",
          });
        }
      } catch {
        if (controller.signal.aborted) return;
        setPendingReminderLaunch(null);
        setHighlightedReminderKey("");
        setToast({
          message:
            "That check-in could not be opened. Reconnect and try the alert again.",
        });
      }
    })();
    return () => controller.abort();
  }, [navigateToTab, pendingReminderLaunch, workspace]);

  useEffect(() => {
    if (!highlightedReminderKey || view !== "home") return;
    const timeout = window.setTimeout(() => {
      const reminderElement = Array.from(
        document.querySelectorAll<HTMLElement>("[data-reminder-key]"),
      ).find(
        (element) =>
          element.dataset.reminderKey === highlightedReminderKey,
      );
      reminderElement?.scrollIntoView({ behavior: "smooth", block: "center" });
      reminderElement?.focus({ preventScroll: true });
    }, 100);
    return () => window.clearTimeout(timeout);
  }, [highlightedReminderKey, view, workspace?.reminders]);

  useEffect(() => {
    const refreshOnVisibility = () => {
      if (document.visibilityState === "visible") {
        void refreshPushDeviceState();
      }
    };
    document.addEventListener("visibilitychange", refreshOnVisibility);
    return () =>
      document.removeEventListener("visibilitychange", refreshOnVisibility);
  }, [refreshPushDeviceState]);

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

  // The pushed screen is addressed by URL, not by the app-wide selection, so
  // a cold /credentials/<id> load and a `popstate` from the iOS back gesture
  // resolve the same way a tap does.
  const detailCredentialId = nav.route.detail?.id ?? "";
  const detailCredential = useMemo(() => {
    if (!workspace || !detailCredentialId) return null;
    return (
      workspace.credentials.find(
        (credential) => credential.id === detailCredentialId,
      ) ?? null
    );
  }, [detailCredentialId, workspace]);

  // A pop is a navigation, so the route drops the detail the instant it
  // happens — but the screen still has to leave the stage. Hold the departing
  // credential for as long as its exit animation is playing.
  //
  // Worked out during render rather than in an effect on purpose: an effect
  // would unmount the screen for a frame and put it straight back, so the exit
  // would play on a freshly mounted element, which is a flash rather than a
  // transition. This shape also means *every* pop animates — the back control,
  // the edge gesture, the browser's own back button, the shell's hardware
  // back — because it watches the route rather than the thing that moved it.
  const [lastDetailCredential, setLastDetailCredential] =
    useState<Credential | null>(null);
  const [exitingDetail, setExitingDetail] = useState<Credential | null>(null);
  if (detailCredential !== lastDetailCredential) {
    setLastDetailCredential(detailCredential);
    setExitingDetail(detailCredential ? null : lastDetailCredential);
  }
  const stagedDetail = detailCredential ?? exitingDetail;
  const screenStackRef = useRef<HTMLDivElement | null>(null);
  useEdgeSwipeBack(screenStackRef, Boolean(detailCredential), nav.pop);

  const finishScreenExit = useCallback(
    (event: AnimationEvent<HTMLDivElement>) => {
      // Both screen animations end on this element and plenty of others end
      // inside it; only the screen's own are this handler's business.
      if (event.target !== event.currentTarget) return;
      screenStackRef.current?.style.removeProperty("--screen-drag");
      setExitingDetail(null);
    },
    [],
  );

  // Backstop. An exit that never reports its end — a browser that skips the
  // animation outright, a tab hidden mid-pop — would otherwise leave the
  // departing screen parked on top of the app for good.
  useEffect(() => {
    if (!exitingDetail) return;
    const timeout = window.setTimeout(() => setExitingDetail(null), 700);
    return () => window.clearTimeout(timeout);
  }, [exitingDetail]);

  // A pushed screen opens at its own top the way a native one does, and the
  // screen it covered comes back to where it was left. Both share the document
  // scroller, so this is the only place that memory can live.
  //
  // The offset is remembered with the tab it was taken from, because leaving a
  // pushed screen is not always a pop: a tab tap also clears the detail, and
  // dropping the History tab 800px down the Credentials list it never showed
  // is worse than any scroll restoration is worth.
  const parkedScrollRef = useRef<{ tab: TabName; y: number } | null>(null);
  useEffect(() => {
    if (detailCredentialId) {
      parkedScrollRef.current = { tab: view, y: window.scrollY };
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      return;
    }
    const parked = parkedScrollRef.current;
    parkedScrollRef.current = null;
    if (parked && parked.tab === view && parked.y) {
      window.scrollTo({ top: parked.y, left: 0, behavior: "auto" });
    }
  }, [detailCredentialId, view]);

  // Tapping a credential sets the selection and then pushes, but the URL is an
  // external system that also moves on its own: a cold deep link, the browser
  // back button and the iOS back gesture all change which credential is open
  // without any tap. Mirror those into the app-wide selection — "Log
  // submission" and "Record acceptance" on the pushed screen act on
  // `selectedCredential` — by subscribing to the same events the router reads,
  // so the write lands in an event callback instead of a render-driven effect.
  useEffect(() => {
    const adoptRouteSelection = () => {
      const routedId = parseRoute(window.location.pathname).detail?.id;
      if (routedId) setSelectedCredentialId(routedId);
    };
    adoptRouteSelection();
    window.addEventListener("popstate", adoptRouteSelection);
    return () => window.removeEventListener("popstate", adoptRouteSelection);
  }, []);

  // A link naming a credential that was deleted (or never existed) falls back
  // to the list root instead of stranding the user on an empty screen. The
  // workspace guard matters: without it a cold /credentials/<id> load would
  // bounce off before the credential it names had arrived.
  useEffect(() => {
    if (!workspace || !detailCredentialId || detailCredential) return;
    navigateToTab("credentials");
  }, [detailCredential, detailCredentialId, navigateToTab, workspace]);

  const selectedNremtNextRule = useMemo(
    () =>
      currentNremtCatalogRule(
        workspace?.catalog ?? [],
        selectedCredential,
      ),
    [selectedCredential, workspace],
  );

  // The workspace payload carries only the templates this user's credentials
  // already reach; the chooser searches the lazily loaded global catalog and
  // falls back to those owned templates until it arrives.
  const catalogTemplates = useMemo(
    () => catalogRules ?? workspace?.catalog ?? [],
    [catalogRules, workspace],
  );

  const selectedRule = useMemo(
    () => catalogTemplates.find((rule) => rule.id === selectedRuleId) ?? null,
    [catalogTemplates, selectedRuleId],
  );

  const catalogMatches = useMemo(() => {
    const query = catalogQuery.trim().toLowerCase();
    if (!query) return catalogTemplates;
    return catalogTemplates.filter((rule) =>
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
  }, [catalogQuery, catalogTemplates]);

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
    actionKey: string = FORM_ACTION_KEY,
  ) {
    if (!window.navigator.onLine) {
      setIsOnline(false);
      setError(
        "You’re offline. Your course draft stays in this browser; reconnect before saving changes.",
      );
      return null;
    }
    setPendingActionKeys((current) => [...current, actionKey]);
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
            "dental_checkpoint_state_changed",
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
      setPendingActionKeys((current) => {
        const index = current.indexOf(actionKey);
        if (index === -1) return current;
        const next = current.slice();
        next.splice(index, 1);
        return next;
      });
    }
  }

  async function postPushAction(
    action: string,
    payload: Record<string, unknown>,
  ) {
    if (!window.navigator.onLine) {
      setIsOnline(false);
      throw new Error(
        "Reconnect before changing phone-alert settings on this device.",
      );
    }
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
      throw new Error(result.error || "Phone-alert setup did not save.");
    }
    return result;
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
        : "The form was cleared, but this browser would not remove its saved draft. Clear iTrack site data to remove it.",
    });
  }

  function finishSavedActivityEntry() {
    activityDraftPersistenceEnabled.current = false;
    activityDraftPersistenceGeneration.current += 1;
    // The saved activity used the credential shown in this form, so that
    // selection stands instead of the one captured when the form opened.
    selectionBeforeActivityEntry.current = null;
    const cleared = clearSavedActivityDraft();
    setActivityOpen(false);
    resetActivityEntry();
    if (!cleared) {
      setToast({
        message:
          "Activity saved, but this browser would not clear its local draft. Clear iTrack site data to remove it.",
      });
    }
  }

  async function handleInstallApp() {
    if (!installPrompt) {
      setInstallHelpOpen(true);
      return;
    }
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    setInstallPrompt(null);
    if (choice.outcome === "accepted") {
      setIsStandalone(true);
      setToast({ message: "iTrack was added to this device." });
    }
  }

  async function handleEnablePhoneAlerts() {
    if (!workspace) return;
    const capability = detectedPushCapability(isStandalone);
    if (capability === "install_required") {
      setInstallHelpOpen(true);
      return;
    }
    if (capability === "denied") {
      setPushDeviceState("denied");
      setToast({
        message:
          "Alerts are blocked in this device’s notification settings. Change that setting, then return here.",
      });
      return;
    }
    if (
      capability !== "available" ||
      !workspace.reminderPreferences.webPushConfigured ||
      !workspace.reminderPreferences.vapidPublicKey
    ) {
      setToast({
        message:
          "Phone alerts are not available on this device yet. Calendar check-ins still work.",
      });
      return;
    }

    setPushPending(true);
    setError("");
    let createdSubscription: PushSubscription | null = null;
    let savedOnServer = false;
    try {
      const registration =
        pushRegistrationRef.current ??
        (await navigator.serviceWorker.ready);
      pushRegistrationRef.current = registration;
      let subscription = await registration.pushManager.getSubscription();
      let replacedEndpoint: string | null = null;
      if (
        subscription &&
        !pushSubscriptionUsesApplicationServerKey(
          subscription,
          workspace.reminderPreferences.vapidPublicKey,
        )
      ) {
        replacedEndpoint = subscription.endpoint;
        await subscription.unsubscribe();
        subscription = null;
      }
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKeyBytes(
            workspace.reminderPreferences.vapidPublicKey,
          ),
        });
        createdSubscription = subscription;
      }
      const serializedSubscription = serializePushSubscription(subscription);
      await postPushAction("savePushSubscription", {
        subscription: serializedSubscription,
        deviceLabel: friendlyDeviceLabel(),
        enableAccountPush: true,
      });
      savedOnServer = true;
      savedPushSubscriptionRef.current = pushSubscriptionIdentity(
        serializedSubscription,
      );
      if (replacedEndpoint && replacedEndpoint !== subscription.endpoint) {
        await postPushAction("removePushSubscription", {
          endpoint: replacedEndpoint,
        }).catch(() => undefined);
      }
      setCurrentPushSubscription(subscription);
      setPushDeviceState("subscribed");
      await loadWorkspace();
      setToast({
        message:
          "Phone alerts are on for this device. Lock-screen previews stay private.",
      });
    } catch (pushError) {
      if (createdSubscription && !savedOnServer) {
        await createdSubscription.unsubscribe().catch(() => false);
      }
      setPushDeviceState(
        Notification.permission === "denied"
          ? "denied"
          : savedOnServer
            ? "subscribed"
            : "error",
      );
      setError(
        pushError instanceof Error
          ? pushError.message
          : "Phone-alert setup did not finish.",
      );
    } finally {
      setPushPending(false);
    }
  }

  async function handleDisablePhoneAlerts() {
    if (!workspace) return;
    setPushPending(true);
    setError("");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription =
        currentPushSubscription ??
        (await registration.pushManager.getSubscription());
      if (subscription) {
        await postPushAction("removePushSubscription", {
          endpoint: subscription.endpoint,
        });
        await subscription.unsubscribe();
      }
      savedPushSubscriptionRef.current = null;
      setCurrentPushSubscription(null);
      setPushDeviceState("available");
      await loadWorkspace();
      setToast({
        message:
          workspace.reminderPreferences.activePushDeviceCount > 1
            ? "Phone alerts are off on this device. Other connected devices are unchanged."
            : "Phone alerts are off.",
      });
    } catch (pushError) {
      setError(
        pushError instanceof Error
          ? pushError.message
          : "Phone alerts could not be turned off on this device.",
      );
      await refreshPushDeviceState();
    } finally {
      setPushPending(false);
    }
  }

  async function handleTestPhoneAlert() {
    const subscription = currentPushSubscription;
    if (!subscription) {
      await refreshPushDeviceState();
      setToast({
        message: "Turn on phone alerts for this device before sending a test.",
      });
      return;
    }
    setPushPending(true);
    setError("");
    try {
      await postPushAction("sendTestPush", {
        endpoint: subscription.endpoint,
      });
      setToast({
        message:
          "Test sent. Your device will show a private iTrack check-in.",
      });
    } catch (pushError) {
      setError(
        pushError instanceof Error
          ? pushError.message
          : "The test alert could not be sent.",
      );
    } finally {
      setPushPending(false);
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
      "itrack-check-ins",
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
      allocatedUnits:
        previousSuggestions.credits !== undefined &&
        String(previousSuggestions.credits) === current.totalUnits &&
        current.allocatedUnits === current.totalUnits
          ? ""
          : current.allocatedUnits,
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
        setActivityDraft((current) => {
          const suggestedUnits =
            suggestions.credits !== undefined
              ? String(suggestions.credits)
              : current.totalUnits;
          return {
            title: suggestions.title ?? current.title,
            provider: suggestions.provider ?? current.provider,
            completionDate:
              suggestions.completionDate ?? current.completionDate,
            totalUnits: suggestedUnits,
            allocatedUnits:
              !current.allocatedUnits ||
              current.allocatedUnits === current.totalUnits
                ? suggestedUnits
                : current.allocatedUnits,
          };
        });
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
    const allocatedUnits = Number(form.get("allocatedUnits"));
    const credential =
      workspace?.credentials.find((item) => item.id === credentialId) ?? null;
    let nremtMatches: RequirementMatchPayload[] | undefined;
    let crcMatches: RequirementMatchPayload[] | undefined;
    let crcApproval: CrcApprovalPayload | undefined;
    if (isNremtCredential(credential)) {
      try {
        nremtMatches = nremtRequirementMatchPayload(
          form,
          credential!,
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
    } else if (isCrcCredential(credential)) {
      try {
        crcMatches = crcRequirementMatchPayload(
          form,
          credential!,
          allocatedUnits,
        );
        crcApproval = crcApprovalPayload(form);
      } catch (matchError) {
        setError(
          matchError instanceof Error
            ? matchError.message
            : "Review the CRC clock-hour allocation.",
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
          : crcMatches && crcApproval
            ? {
                requirementMatches: crcMatches,
                ...crcApproval,
              }
          : {
              requirementIds: form
                .getAll("requirementIds")
                .map((value) => String(value))
                .filter(Boolean),
            }),
        allocatedUnits,
        evidenceStatus: String(form.get("evidenceStatus") ?? "missing"),
        portalCarryoverAttested:
          form.get("portalCarryoverAttested") === "on",
      },
      allocatedUnits === totalUnits
        ? `${compactNumber(totalUnits)} ${
            totalUnits === 1 ? "credit" : "credits"
          } added to your record.`
        : `${compactNumber(totalUnits)} earned; ${compactNumber(
            allocatedUnits,
          )} applied to this credential.`,
    );
    // The record is saved at this point whatever happens to the proof file
    // below, and this is the confirmation the hand gets for it.
    if (result) hapticTap("medium");
    if (result?.id && hasEvidenceFile && evidenceFile) {
      const uploaded = await uploadEvidence(result.id, evidenceFile);
      if (!uploaded) {
        finishSavedActivityEntry();
        formElement.reset();
        setToast({
          message:
            "Activity saved, but the proof file did not upload. You can add it from History.",
        });
        return;
      }
      setToast({
        message:
          allocatedUnits === totalUnits
            ? `${compactNumber(totalUnits)} ${
                totalUnits === 1 ? "credit" : "credits"
              } and proof saved.`
            : `${compactNumber(totalUnits)} earned; ${compactNumber(
                allocatedUnits,
              )} applied, with proof saved.`,
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
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setError("Choose a PDF or image to upload.");
      return;
    }
    const uploaded = await uploadEvidence(evidenceActivity.id, file);
    if (uploaded) {
      formElement.reset();
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
      catalogTemplates.find(
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
    const applicabilityChoiceByCategoryId = new Map(
      (rule?.categories ?? [])
        .filter((category) => category.applicability === "conditional")
        .map((category) => [
          category.id,
          String(
            form.get(`applicability:${category.id}`) ?? "needs_confirmation",
          ),
        ]),
    );
    for (const categoryIds of DENTAL_LINKED_APPLICABILITY_CATEGORY_GROUPS) {
      const synchronizedStatus = applicabilityChoiceByCategoryId.get(
        categoryIds[0],
      );
      if (!synchronizedStatus) continue;
      for (const categoryId of categoryIds) {
        applicabilityChoiceByCategoryId.set(
          categoryId,
          synchronizedStatus,
        );
      }
    }
    const applicabilityChoices = [...applicabilityChoiceByCategoryId].map(
      ([ruleCategoryId, status]) => ({ ruleCategoryId, status }),
    );

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
          rule?.profession === "Nursing" ||
          rule?.profession === "Dental" ||
          isExpandedCertificationCatalogRule(rule)
            ? form.get("templateEligibilityAttested") === "on"
            : undefined,
        totalRequired,
        unitLabel: customCredential
          ? String(form.get("unitLabel") ?? "hours")
          : (rule?.unitLabel ?? "hours"),
        categories,
        applicabilityChoices,
        abveAnnualStartYear: isAbveCatalogRule(rule)
          ? Number(form.get("abveAnnualStartYear"))
          : undefined,
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
          isNremtCredential(selectedCredential) ||
          isCrcCredential(selectedCredential)
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
            : isCrcCredential(selectedCredential)
              ? "CRC renewal logged. Keep the CRCCCONNECT confirmation with your program records."
            : "Submission logged. Keep the confirmation until your renewal is accepted.",
    );
    if (success) setSubmissionOpen(false);
  }

  function openSubmission() {
    setError("");
    setNremtSubmissionDate(todayIso());
    setSubmissionOpen(true);
  }

  function openAcceptance() {
    setError("");
    if (isAbveCredential(selectedCredential)) {
      setError(
        "ABVE has not yet published a verified Fellow or Diplomate template for the cycle after December 31, 2027. Keep this completed cycle open until the next official requirements and dates are available.",
      );
      return;
    }
    setAcceptanceOpen(true);
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
          isManagedNursingCredential(selectedCredential) ||
          isManagedDentalCredential(selectedCredential) ||
          isExpandedCertificationCredential(selectedCredential)
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
      // The end of a renewal cycle is the one moment in this app worth
      // feeling, so it gets the firmer of the two taps.
      hapticTap("medium");
      setAcceptanceOpen(false);
      if (result.id) {
        setSelectedCredentialId(result.id);
        // Accepting a renewal ends the cycle the screen was opened on and
        // starts its successor. A pushed detail screen is addressed by URL, so
        // it has to be re-pointed at the new cycle or it would sit there
        // showing the finished one while everything else had moved on.
        if (nav.route.detail) {
          nav.replaceDetail({ kind: "credential", id: result.id });
        }
      }
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
        pushEnabled: form.get("pushEnabled") === "on",
        pushHourLocal: Number(form.get("pushHourLocal") ?? 9),
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
    let crcMatches: RequirementMatchPayload[] | undefined;
    let crcApproval: CrcApprovalPayload | undefined;
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
    } else if (isCrcCredential(allocationCredential)) {
      try {
        crcMatches = crcRequirementMatchPayload(
          form,
          allocationCredential!,
          allocatedUnits,
        );
        crcApproval = crcApprovalPayload(form);
      } catch (matchError) {
        setError(
          matchError instanceof Error
            ? matchError.message
            : "Review the CRC clock-hour allocation.",
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
          : crcMatches && crcApproval
            ? {
                requirementMatches: crcMatches,
                ...crcApproval,
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
    let crcMatches: RequirementMatchPayload[] | undefined;
    const isNremt = isNremtCredential(classificationCredential);
    if (isNremt) {
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
    } else if (isCrcCredential(classificationCredential)) {
      try {
        crcMatches = crcRequirementMatchPayload(
          form,
          classificationCredential!,
          classificationRepair.allocation.allocatedUnits,
        );
      } catch (matchError) {
        setError(
          matchError instanceof Error
            ? matchError.message
            : "Review the CRC clock-hour allocation.",
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
          : crcMatches
            ? {
                requirementMatches: crcMatches,
                crcApprovalAttested:
                  form.get("crcApprovalAttested") === "on",
              }
          : {
              requirementIds: form
                .getAll("requirementIds")
                .map((value) => String(value))
                .filter(Boolean),
              allocatedUnits: Number(form.get("allocatedUnits")),
            }),
        portalCarryoverAttested:
          form.get("portalCarryoverAttested") === "on",
      },
      "Activity allocation updated and progress recalculated.",
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
      requirementActionKey(requirement.id),
    );
  }

  async function saveDentalCheckpoint(
    credentialId: string,
    requirement: Requirement,
    completed: boolean,
    evidenceNote: string,
  ) {
    await runAction(
      "saveDentalCheckpoint",
      {
        credentialId,
        requirementId: requirement.id,
        completed,
        evidenceNote,
        expectedRevision: requirement.checkpointRevision ?? 0,
      },
      completed
        ? `${requirement.name} completion saved without adding CE units.`
        : `${requirement.name} reopened.`,
      requirementActionKey(requirement.id),
    );
  }

  async function updateActivityRecord(input: {
    title: string;
    provider: string;
    completionDate: string;
    totalUnits: number;
    acceptedEducationAttested?: boolean;
    crcApprovalAttested?: boolean;
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
          activityActionKey(activity.id),
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
      activityActionKey(activity.id),
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
          taskActionKey(task.id),
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
      taskActionKey(task.id),
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
      taskActionKey(task.id),
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
            taskActionKey(task.id),
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
      questActionKey(quest.key),
    );
  }

  async function updateWeeklyGoal(weeklyGoal: number) {
    await runAction(
      "updateWeeklyGoal",
      { weeklyGoal },
      weeklyGoal === workspace?.profile.weeklyGoal
        ? "Your current weekly rhythm will continue."
        : "Your next weekly rhythm is scheduled.",
      WEEKLY_GOAL_ACTION_KEY,
    );
  }

  const userName = workspace?.user.displayName ?? "Professional";

  /*
   * Tapping the tab you are already on is not a navigation. On this platform
   * it means "take me back to the start of this tab": it pops whatever is
   * stacked on it, and with nothing stacked it returns the tab to its own top.
   * The scroll is left at `auto` so the stylesheet's smooth behaviour applies
   * and the reduced-motion block can still take it away.
   */
  function selectTab(tab: TabName) {
    hapticTap();
    if (tab !== view) {
      nav.setTab(tab);
      return;
    }
    if (nav.route.detail) {
      nav.popToRoot();
      return;
    }
    window.scrollTo({ top: 0 });
  }

  /*
   * The two shortcuts Home's cards take. Both re-point the app at the
   * credential, because the pushed screen, the log sheet and the submission
   * actions all read that one selection; the log sheet additionally remembers
   * what the selection was and puts it back if the sheet closes without
   * saving, so a shortcut taken and abandoned leaves no trace.
   *
   * The log shortcut hands the credential *to* the sheet rather than selecting
   * it first: a restored draft picks its own credential as it opens, and the
   * later write would otherwise land on top of this one.
   */
  function openCredentialDetail(id: string) {
    setSelectedCredentialId(id);
    nav.push({ kind: "credential", id });
  }

  function logCreditsFor(id: string) {
    openActivityEntryFor(id);
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <DesktopSidebar
        view={view}
        onView={selectTab}
        onAdd={openActivityEntry}
      />

      <div className="app-stage">
        <header className="mobile-header">
          <Brand />
          <button
            className="avatar-button"
            type="button"
            aria-label="Open account"
            onClick={() => nav.setTab("profile")}
          >
            {firstName(userName).slice(0, 1).toUpperCase()}
          </button>
        </header>

        <main id="main-content" className="main-content">
          {!isOnline ? (
            <div className="offline-banner" role="status">
              <span>
                <Icon name="zap" size={18} />
              </span>
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

          <div className="screen-stack" ref={screenStackRef}>
            <div
              className={`screen screen-root${
                detailCredential ? " screen-under" : ""
              }`}
            >
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
              ) : view === "home" ? (
                <TodayView
                  workspace={workspace}
                  credential={selectedCredential}
                  isOnline={isOnline}
                  highlightedReminderKey={highlightedReminderKey}
                  onAddActivity={openActivityEntry}
                  onAddCredential={openCredentialSetup}
                  onViewRecords={() => nav.setTab("history")}
                  onOpenCredential={openCredentialDetail}
                  onLogCreditsFor={logCreditsFor}
                  onSubmit={openSubmission}
                  onAccept={openAcceptance}
                  onReminders={() => {
                    setError("");
                    setRemindersOpen(true);
                  }}
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
                  taskActionsDisabled={!isOnline}
                  pendingActionKeys={pendingActionKeys}
                  onClaimQuest={(quest) => void claimWeeklyQuest(quest)}
                  onRequirementApplicability={(requirement, status) =>
                    selectedCredential
                      ? void setRequirementApplicability(
                          selectedCredential.id,
                          requirement,
                          status,
                        )
                      : undefined
                  }
                  onDentalCheckpoint={(requirement, completed, evidenceNote) =>
                    selectedCredential
                      ? void saveDentalCheckpoint(
                          selectedCredential.id,
                          requirement,
                          completed,
                          evidenceNote,
                        )
                      : undefined
                  }
                />
              ) : view === "credentials" ? (
                <CredentialsView
                  credentials={workspace.credentials}
                  selectedId={selectedCredential?.id ?? ""}
                  onSelect={openCredentialDetail}
                  onAdd={openCredentialSetup}
                />
              ) : view === "history" ? (
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
                  actionsDisabled={!isOnline}
                  pendingActionKeys={pendingActionKeys}
                  onEvidence={(activity) => void openEvidence(activity)}
                  onAllocate={(activity) => {
                    setError("");
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
                  onClassify={(activity, allocation) => {
                    setError("");
                    setClassificationRepair({ activity, allocation });
                  }}
                />
              ) : (
                <AccountView
                  workspace={workspace}
                  onReminders={() => {
                    setError("");
                    setRemindersOpen(true);
                  }}
                  onWeeklyGoal={(weeklyGoal) =>
                    void updateWeeklyGoal(weeklyGoal)
                  }
                  weeklyGoalPending={pendingActionKeys.includes(
                    WEEKLY_GOAL_ACTION_KEY,
                  )}
                  isStandalone={isStandalone}
                  installAvailable={Boolean(installPrompt)}
                  onInstall={() => void handleInstallApp()}
                  onAddAllCheckIns={() => void addAllCheckInsToCalendar()}
                  pushDeviceState={pushDeviceState}
                  pushPending={pushPending}
                  isOnline={isOnline}
                  onEnablePhoneAlerts={() => void handleEnablePhoneAlerts()}
                  onDisablePhoneAlerts={() => void handleDisablePhoneAlerts()}
                  onTestPhoneAlert={() => void handleTestPhoneAlert()}
                  onRefreshPhoneAlerts={() => void refreshPushDeviceState()}
                />
              )}
            </div>
            {stagedDetail ? (
              <div
                className={`screen screen-pushed${
                  detailCredential ? "" : " screen-exiting"
                }`}
                onAnimationEnd={finishScreenExit}
              >
                <CredentialDetailScreen
                  credential={stagedDetail}
                  activities={workspace?.activities ?? []}
                  isOnline={isOnline}
                  backLabel={TAB_LABELS[view]}
                  onBack={nav.pop}
                  onSubmit={openSubmission}
                  onAccept={openAcceptance}
                  onReminders={() => {
                    setError("");
                    setRemindersOpen(true);
                  }}
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
                  onDentalCheckpoint={(
                    credentialId,
                    requirement,
                    completed,
                    evidenceNote,
                  ) =>
                    void saveDentalCheckpoint(
                      credentialId,
                      requirement,
                      completed,
                      evidenceNote,
                    )
                  }
                  actionsDisabled={!isOnline}
                  pendingActionKeys={pendingActionKeys}
                />
              </div>
            ) : null}
          </div>
        </main>
      </div>

      <MobileNavigation
        view={view}
        onView={selectTab}
        onAdd={openActivityEntry}
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
              body="Credits need an open renewal cycle so iTrack knows where to count them."
              action="Set up credential"
              onAction={() => {
                closeActivityEntry();
                openCredentialSetup();
              }}
            />
          ) : (
            <form className="form-stack" onSubmit={handleActivitySubmit}>
              <section
                className="certificate-capture"
                aria-labelledby="certificate-capture-title"
              >
                <div className="certificate-capture-heading">
                  <span className="capture-mark">
                    <Icon name="target" size={21} />
                  </span>
                  <div>
                    <strong id="certificate-capture-title">
                      Start with the certificate
                    </strong>
                    <p>
                      Take a photo and iTrack will suggest the details
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
                    <Icon name="camera" size={17} />
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
                  <Icon name="shield" size={15} />
                  <span>
                    On-device scan: the reader and English model load from
                    iTrack. The proof uploads only after Save activity;
                    suggested field values may be saved unencrypted in this
                    browser draft.
                  </span>
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
                    <span>
                      <Icon
                        name={activityDraftRestored ? "refresh" : "save"}
                        size={15}
                      />
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
                      <span className="capture-status-mark">
                        <Icon
                          name={
                            activityScan.phase === "success" ? "check" : "info"
                          }
                          size={13}
                        />
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
                    min={isCrcCredential(activityCredential) ? 0.01 : 0.1}
                    max={ACTIVITY_DRAFT_MAX_UNITS}
                    step={isCrcCredential(activityCredential) ? 0.01 : 0.1}
                    inputMode="decimal"
                    placeholder="1.0"
                    value={activityDraft.totalUnits}
                    disabled={scanningActivityEvidence}
                    onChange={(event) =>
                      setActivityDraft((current) => {
                        const totalUnits = event.currentTarget.value;
                        return {
                          ...current,
                          totalUnits,
                          allocatedUnits:
                            !current.allocatedUnits ||
                            current.allocatedUnits === current.totalUnits
                              ? totalUnits
                              : current.allocatedUnits,
                        };
                      })
                    }
                    required
                  />
                  {activityScan.suggestions.credits ? (
                    <small className="scan-suggestion-note">
                      Suggested from the scan — confirm the units.
                    </small>
                  ) : null}
                </label>
                <label className="field">
                  <span>Credits to apply to this credential</span>
                  <input
                    name="allocatedUnits"
                    type="number"
                    min={isCrcCredential(activityCredential) ? 0.01 : 0.1}
                    max={
                      Number(activityDraft.totalUnits) > 0
                        ? Number(activityDraft.totalUnits)
                        : ACTIVITY_DRAFT_MAX_UNITS
                    }
                    step={isCrcCredential(activityCredential) ? 0.01 : 0.1}
                    inputMode="decimal"
                    placeholder="1.0"
                    value={activityDraft.allocatedUnits}
                    disabled={scanningActivityEvidence}
                    onChange={(event) =>
                      setActivityDraft((current) => ({
                        ...current,
                        allocatedUnits: event.currentTarget.value,
                      }))
                    }
                    required
                  />
                  <small>
                    Keep the full certificate amount above. Lower this only
                    when the regulator limits how much may count here.
                  </small>
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
                <small>
                  Choosing here files this activity only. Today keeps its
                  current credential unless you save this entry to another one.
                </small>
              </label>
              {isNremtCredential(activityCredential) ? (
                <NremtRequirementAllocator
                  key={activityCredential?.id}
                  credential={activityCredential!}
                  availableUnits={Number(activityDraft.allocatedUnits) || 0}
                />
              ) : isCrcCredential(activityCredential) ? (
                <CrcRequirementAllocator
                  key={activityCredential?.id}
                  credential={activityCredential!}
                  availableUnits={Number(activityDraft.allocatedUnits) || 0}
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
                      The issuing authority permits this carryover
                    </strong>
                    <small>
                      I selected the evidence-backed carryover source plus only
                      compatible classifiers, entered the actual eligible
                      prior-period date, and will retain the authority record.
                      A reference or uploaded proof is required before cycle
                      completion.
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
                    defaultChecked={!isCrcCredential(activityCredential)}
                  />
                  <span>Add later</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="evidenceStatus"
                    value="not_required"
                    disabled={
                      isPriorPeriodCarryoverEntry(
                        activityDraft.completionDate,
                        activityCredential,
                      )
                    }
                    defaultChecked={isCrcCredential(activityCredential)}
                  />
                  <span>
                    {isCrcCredential(activityCredential)
                      ? "Not required for CRCC pre-approved credit"
                      : "Not required"}
                  </span>
                </label>
              </fieldset>
              {error ? (
                <ModalError
                  title="This activity was not saved"
                  message={error}
                />
              ) : null}
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
                  disabled={
                    pending ||
                    evidencePending ||
                    scanningActivityEvidence ||
                    !isOnline
                  }
                >
                  {pending
                    ? "Saving…"
                    : evidencePending
                      ? "Uploading proof…"
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
          onClose={() => {
            setCredentialOpen(false);
            setError("");
          }}
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
                  <span>License or professional certification</span>
                  <input
                    autoFocus
                    name="credentialName"
                    required
                    placeholder="Registered Nurse"
                  />
                </label>
                <label className="field">
                  <span>Issuing organization <em>Optional</em></span>
                  <input
                    name="issuer"
                    placeholder="Licensing board or certifying body"
                  />
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
                    placeholder="Search profession, license, certification, or state"
                  />
                  <small aria-live="polite">
                    {catalogStatus === "loading"
                      ? "Loading researched starting templates · custom plans are always available"
                      : catalogStatus === "error"
                        ? "Templates couldn’t be loaded · custom plans are always available"
                        : `${catalogTemplates.length} researched starting templates · custom plans are always available`}
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
                {catalogStatus === "error" ? (
                  <button
                    className="button button-outline catalog-custom-button"
                    type="button"
                    onClick={() => {
                      void loadCatalog();
                    }}
                  >
                    Templates didn’t load — try again
                  </button>
                ) : null}
                {catalogStatus !== "loading" && catalogMatches.length === 0 ? (
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
                        Review official source
                        <Icon name="arrowUpRight" size={14} />
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
                  (category) =>
                    category.applicability === "conditional" &&
                    !DENTAL_LINKED_APPLICABILITY_CHILD_CATEGORY_IDS.has(
                      category.id,
                    ),
                ) ? (
                  <fieldset className="condition-review">
                    <legend>Which conditions apply this cycle?</legend>
                    <p>
                      Answer what you know. Anything left as{" "}
                      <strong>Not sure yet</strong> is saved as needing
                      confirmation: it is not added to this cycle&apos;s
                      requirements, your readiness score stays cautious, and it
                      appears on Today until you resolve it.
                    </p>
                    <div className="condition-list">
                      {selectedRule.categories
                        .filter(
                          (category) =>
                            category.applicability === "conditional" &&
                            !DENTAL_LINKED_APPLICABILITY_CHILD_CATEGORY_IDS.has(
                              category.id,
                            ),
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
                                />
                                <span>Applies</span>
                              </label>
                              <label>
                                <input
                                  type="radio"
                                  name={`applicability:${category.id}`}
                                  value="not_applicable"
                                />
                                <span>Not this cycle</span>
                              </label>
                              {/*
                               * The stored model has always had a third state,
                               * and the rest of the product is built around it:
                               * an unresolved rule is held out of the readiness
                               * score and surfaced as the top guided action.
                               * Defaulting here matches what the server already
                               * stores for an unanswered conditional rule, so a
                               * guess is never forced at 11pm.
                               */}
                              <label>
                                <input
                                  type="radio"
                                  name={`applicability:${category.id}`}
                                  value="needs_confirmation"
                                  defaultChecked
                                />
                                <span>Not sure yet</span>
                              </label>
                            </div>
                          </article>
                        ))}
                    </div>
                  </fieldset>
                ) : null}
                {selectedRule &&
                (selectedRule.profession === "Pharmacy" ||
                  selectedRule.profession === "Nursing" ||
                  selectedRule.profession === "Dental" ||
                  isExpandedCertificationCatalogRule(selectedRule)) ? (
                  <label className="switch-row">
                    <span>
                      <strong>
                        I confirmed this is a standard full-cycle{" "}
                        {isExpandedCertificationCatalogRule(selectedRule)
                          ? "credential or license maintenance path"
                          : selectedRule.profession === "Nursing" ||
                              selectedRule.profession === "Dental"
                            ? "renewal or registration"
                            : "renewal"}
                      </strong>
                      <small>
                        {isExpandedCertificationCatalogRule(selectedRule)
                          ? "The official issuer or regulator record matches this exact credential, status, maintenance path, and the dates below. No initial, shortened, waiver, inactive, retired, reinstatement, synchronized or multi-credential, exam-alternative, or other adjusted variant applies."
                          : selectedRule.id === "tx-rn-2026-v1" ||
                        selectedRule.id === "tx-lvn-2026-v1"
                          ? "The regulator record matches the dates below, I am using the 20-hour CNE path rather than the certification alternative, and no initial, shortened, inactive, exempt, or other adjusted-status variant applies."
                          : selectedRule.profession === "Dental"
                            ? "The regulator record matches the dates below, and no initial, shortened, inactive, retired, prorated, exempt, or other adjusted-status variant applies."
                            : "The official issuer or regulator record matches the dates below, and no initial, shortened, inactive, prorated, exempt, or other adjusted-status variant applies."}
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
                    requiresOfficialCatalogDates(selectedRule) &&
                    !isAbveCatalogRule(selectedRule)
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
                    requiresOfficialCatalogDates(selectedRule) &&
                    !isAbveCatalogRule(selectedRule)
                      ? ""
                      : defaultCatalogDeadline(selectedRule)
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
            {isRehabilitationCertificationCatalogRule(selectedRule) ? (
              <>
                {isAbveCatalogRule(selectedRule) ? (
                  <label className="field">
                    <span>
                      First year this ABVE credential was held in this cycle
                    </span>
                    <select name="abveAnnualStartYear" defaultValue="" required>
                      <option value="" disabled>
                        Choose 2025, 2026, or 2027
                      </option>
                      <option value="2025">2025</option>
                      <option value="2026">2026</option>
                      <option value="2027">2027</option>
                    </select>
                    <small>
                      Annual membership, credential renewal, fees, and ethics
                      tasks begin with the year you first held this ABVE
                      credential during the current cycle.
                    </small>
                  </label>
                ) : null}
                <label className="switch-row">
                  <span>
                    <strong>
                      {isAbveCatalogRule(selectedRule)
                        ? "I checked my ABVE member record"
                        : "I checked CRCCCONNECT"}
                    </strong>
                    <small>
                      {isAbveCatalogRule(selectedRule)
                        ? "It shows the selected Fellow or Diplomate credential, the year first held in this cycle, and the fixed January 1, 2025 through December 31, 2027 recertification cycle."
                        : "It shows the CRC certification-period start and valid-through date entered above."}
                    </small>
                  </span>
                  <input
                    name="officialDatesAttested"
                    type="checkbox"
                    required
                  />
                </label>
              </>
            ) : null}
            {isExpandedCertificationCatalogRule(selectedRule) ? (
              <label className="switch-row">
                <span>
                  <strong>I checked the official credential record</strong>
                  <small>
                    The issuer, regulator, or official account shows this
                    exact credential or license path, current status, cycle
                    start, and deadline.
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
                Confirm dates and requirements with your issuing organization.
                iTrack helps organize your records; it does not replace
                official guidance.
              </p>
            </div>

            {error ? (
              <ModalError
                title="This renewal plan was not created"
                message={error}
              />
            ) : null}
            <div className="form-actions">
              <button
                className="button button-ghost"
                type="button"
                onClick={() => {
                  setCredentialOpen(false);
                  setError("");
                }}
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
          onClose={() => {
            setSubmissionOpen(false);
            setError("");
          }}
        >
          <form className="form-stack" onSubmit={handleSubmission}>
            <div className="celebration-panel">
              <span className="celebration-mark">
                <Icon name="check" size={20} />
              </span>
              <div>
                <strong>
                  {isIsc2AutomaticRenewalCredential(selectedCredential)
                    ? "Record what the ISC2 dashboard shows"
                    : isCompliancePeriodCredential(selectedCredential)
                      ? "Save the official compliance milestone"
                      : isNremtCredential(selectedCredential)
                        ? "Save the National Registry application record"
                      : isCrcCredential(selectedCredential)
                        ? "Confirm the accepted CRCCCONNECT totals"
                    : "One last record for your future self"}
                </strong>
                <p>
                  {isIsc2AutomaticRenewalCredential(selectedCredential)
                    ? "This checkpoint records your attestation that required CPEs and annual maintenance fees are satisfied. It does not mean ISC2 has renewed the certification."
                    : isCompliancePeriodCredential(selectedCredential)
                      ? "Record when the official record shows this period’s education requirement is complete."
                      : isNremtCredential(selectedCredential)
                        ? "Confirm the assigned NCCP model and every component in the National Registry dashboard before recording the application."
                      : isCrcCredential(selectedCredential)
                        ? "Confirm every program is accepted once and the exact credit-type amounts satisfy the countable total, ethics minimum, and Professional Development cap shown for this cycle."
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
            isNremtCredential(selectedCredential) ||
            isCrcCredential(selectedCredential) ? (
              <label className="switch-row">
                <span>
                  <strong>
                    {isIsc2AutomaticRenewalCredential(selectedCredential)
                      ? "I checked the ISC2 Dashboard"
                      : isCompliancePeriodCredential(selectedCredential)
                        ? "I checked the official compliance record"
                        : isNremtCredential(selectedCredential)
                          ? "I checked the National Registry dashboard"
                          : "I checked CRCCCONNECT"}
                  </strong>
                  <small>
                    {isIsc2AutomaticRenewalCredential(selectedCredential)
                      ? "It shows this cycle’s required CPEs and annual maintenance fees as satisfied."
                      : isCompliancePeriodCredential(selectedCredential)
                        ? "It shows this period’s education requirement as complete."
                        : isNremtCredential(selectedCredential)
                          ? "It shows the assigned model, component totals, National topics, and pediatric content as satisfied."
                          : "It shows each program accepted under the recorded credit type and the countable total, ethics minimum, and Professional Development cap shown for this cycle as satisfied."}
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
                    : isCrcCredential(selectedCredential)
                      ? "Post-approved programs must have CRCC’s accepted decision and supporting proof on file. The same program may be submitted only once, and excess hours do not carry forward."
                  : "This records what you submitted. Mark the cycle renewed only after the issuing organization confirms acceptance."}
              </p>
            </div>
            {error ? (
              <ModalError
                title="This record was not saved"
                message={error}
              />
            ) : null}
            <div className="form-actions">
              <button
                className="button button-ghost"
                type="button"
                onClick={() => {
                  setSubmissionOpen(false);
                  setError("");
                }}
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
          onClose={() => {
            setAcceptanceOpen(false);
            setError("");
          }}
        >
          <form className="form-stack" onSubmit={handleAcceptance}>
            <div className="celebration-panel">
              <span className="celebration-mark">
                <Icon name="check" size={20} />
              </span>
              <div>
                <strong>
                  {isIsc2AutomaticRenewalCredential(selectedCredential)
                    ? "Your renewed certification starts a clean cycle"
                    : isCompliancePeriodCredential(selectedCredential)
                      ? "Your next compliance period starts clean"
                    : "Your renewed credential starts a clean cycle"}
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
                    : "Decision or credential reference"}{" "}
                  <em>Optional</em>
                </span>
                <input
                  name="reference"
                  placeholder="e.g., renewal receipt ID"
                />
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
                    : "Reconfirm both license line and tenure tier. iTrack will seed the new period from this current official template."}
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
                      isNremtCredential(selectedCredential) ||
                      isExpandedCertificationCredential(selectedCredential)
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
                      isNremtCredential(selectedCredential) ||
                      isExpandedCertificationCredential(selectedCredential)
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
            isManagedNursingCredential(selectedCredential) ||
            isManagedDentalCredential(selectedCredential) ||
            isExpandedCertificationCredential(selectedCredential) ? (
              <label className="switch-row">
                <span>
                  <strong>
                    I confirmed the next period is a standard full-cycle
                    {isExpandedCertificationCredential(selectedCredential)
                      ? " credential or license maintenance path"
                      : isManagedNursingCredential(selectedCredential) ||
                    isManagedDentalCredential(selectedCredential)
                      ? " renewal or registration"
                      : " renewal"}
                  </strong>
                  <small>
                    {isExpandedCertificationCredential(selectedCredential)
                      ? "The official account confirms the same credential and path. No initial, shortened, waiver, inactive, retired, reinstatement, synchronized or multi-credential, exam-alternative, or other adjusted variant applies."
                      : selectedCredential.ruleSetId === "tx-rn-2026-v1" ||
                    selectedCredential.ruleSetId === "tx-lvn-2026-v1"
                      ? "I am using the 20-hour CNE path rather than the certification alternative, and no initial, shortened, inactive, exempt, or other adjusted-status variant applies."
                      : isManagedDentalCredential(selectedCredential)
                        ? "No initial, shortened, inactive, retired, prorated, exempt, or other adjusted-status variant applies to the next period."
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
                          : isManagedDentalCredential(selectedCredential)
                            ? "The next period will use the latest current version of this dental template and reset every conditional permit, training, and cadence rule for review."
                            : isExpandedCertificationCredential(
                                  selectedCredential,
                                )
                              ? "The next period will use the latest current version of the same credential template and reset every conditional rule for confirmation."
                              : "Requirements are copied as a starting snapshot. Review the current official rules before relying on the new plan."}
              </p>
            </div>
            {error ? (
              <ModalError
                title="This cycle was not closed"
                message={error}
              />
            ) : null}
            <div className="form-actions">
              <button
                className="button button-ghost"
                type="button"
                onClick={() => {
                  setAcceptanceOpen(false);
                  setError("");
                }}
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
          onClose={() => {
            setRemindersOpen(false);
            setError("");
          }}
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
            <label className="switch-row">
              <span>
                <strong>Send phone alerts</strong>
                <small>
                  {workspace.reminderPreferences.activePushDeviceCount === 0 &&
                  !workspace.reminderPreferences.pushEnabled
                    ? "Connect this device from Profile before turning on phone alerts."
                    : "Deliver private check-ins to devices you explicitly connect."}
                </small>
              </span>
              <input
                name="pushEnabled"
                type="checkbox"
                defaultChecked={workspace.reminderPreferences.pushEnabled}
                disabled={
                  workspace.reminderPreferences.activePushDeviceCount === 0 &&
                  !workspace.reminderPreferences.pushEnabled
                }
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
                id="reminder-time-zone"
                name="timeZone"
                defaultValue={workspace.reminderPreferences.timeZone}
                placeholder="America/New_York"
                required
              />
              <small>Use an IANA zone such as America/New_York.</small>
            </label>
            <button
              className="field-inline-action"
              type="button"
              onClick={(event) => {
                const input = event.currentTarget.form?.elements.namedItem(
                  "timeZone",
                );
                if (input instanceof HTMLInputElement) {
                  input.value = deviceTimeZone();
                  input.focus();
                }
              }}
            >
              Use this device’s time zone
            </button>
            <label className="field">
              <span>Phone-alert delivery time</span>
              <select
                name="pushHourLocal"
                defaultValue={String(
                  workspace.reminderPreferences.pushHourLocal ?? 9,
                )}
              >
                {Array.from({ length: 24 }, (_, hour) => (
                  <option key={hour} value={hour}>
                    {new Intl.DateTimeFormat("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                    }).format(new Date(2020, 0, 1, hour))}
                  </option>
                ))}
              </select>
              <small>
                Alerts use this hour in the saved time zone. Delivery can vary
                slightly by phone.
              </small>
            </label>
            <div className="advisory-note">
              <span aria-hidden="true">i</span>
              <p>
                In-app check-ins stay inside iTrack. Phone alerts use
                generic lock-screen copy and only reach devices you connect
                from Profile. Your calendar can alert on the lead days selected here;
                your calendar controls final delivery.
              </p>
            </div>
            {error ? (
              <ModalError
                title="These check-in settings were not saved"
                message={error}
              />
            ) : null}
            <div className="form-actions">
              <button
                className="button button-ghost"
                type="button"
                onClick={() => {
                  setRemindersOpen(false);
                  setError("");
                }}
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

      {installHelpOpen ? (
        <Modal
          title="Add iTrack to your phone"
          eyebrow="Phone companion"
          onClose={() => setInstallHelpOpen(false)}
        >
          <div className="install-help">
            {isIosLike() ? (
              <>
                <p>
                  Apple enables web alerts only after iTrack is opened
                  from your Home Screen.
                </p>
                <ol>
                  <li>Open iTrack in Safari.</li>
                  <li>
                    Tap the Share button, then choose <strong>Add to Home Screen</strong>.
                  </li>
                  <li>
                    Open the new iTrack icon and return to Profile to turn on
                    phone alerts.
                  </li>
                </ol>
              </>
            ) : (
              <>
                <p>
                  Open your browser menu and choose <strong>Install app</strong>{" "}
                  or <strong>Add to Home Screen</strong>.
                </p>
                <p>
                  Then open iTrack from its new icon for a focused,
                  full-screen workspace.
                </p>
              </>
            )}
            <div className="advisory-note">
              <span aria-hidden="true">i</span>
              <p>
                Installing does not turn on alerts. iTrack asks for
                notification permission only after you tap the separate
                phone-alert button.
              </p>
            </div>
            <div className="form-actions">
              <button
                className="button button-primary"
                type="button"
                onClick={() => setInstallHelpOpen(false)}
              >
                Got it
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {allocationActivity && workspace ? (
        <Modal
          title="Reuse completed learning"
          eyebrow={allocationActivity.title}
          onClose={() => {
            setAllocationActivity(null);
            setError("");
          }}
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
                  min={isCrcCredential(allocationCredential) ? 0.01 : 0.1}
                  max={allocationActivity.totalUnits}
                  step={isCrcCredential(allocationCredential) ? 0.01 : 0.1}
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
              ) : isCrcCredential(allocationCredential) ? (
                <CrcRequirementAllocator
                  key={allocationCredential?.id}
                  credential={allocationCredential!}
                  availableUnits={allocationActivity.totalUnits}
                  initialProgramReference={
                    allocationsFor(allocationActivity).some(
                      (allocation) =>
                        allocation.credentialRuleSetId?.startsWith("crcc-"),
                    )
                      ? allocationActivity.evidenceReference ?? ""
                      : ""
                  }
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
                      The issuing authority permits this carryover
                    </strong>
                    <small>
                      Apply this prior-period record to the evidence-backed
                      carryover source plus only compatible classifiers, and
                      retain the issuer’s supporting record.
                    </small>
                  </span>
                  <input
                    name="portalCarryoverAttested"
                    type="checkbox"
                    required
                  />
                </label>
              ) : null}
              {error ? (
                <ModalError
                  title="This activity was not applied"
                  message={error}
                />
              ) : null}
              <div className="form-actions">
                <button
                  className="button button-ghost"
                  type="button"
                  onClick={() => {
                    setAllocationActivity(null);
                    setError("");
                  }}
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
          onClose={() => {
            setClassificationRepair(null);
            setError("");
          }}
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
                    satisfies
                    {isNremtCredential(classificationCredential)
                      ? ". Its National Registry amount stays exact."
                      : isCrcCredential(classificationCredential)
                        ? ". Its CRC-applied amount and existing CRCC approval record stay exact."
                      : ", and correct how much of the full learning record counts here."}{" "}
                    Its date and proof will not change.
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
              ) : isCrcCredential(classificationCredential) ? (
                <CrcRequirementAllocator
                  key={classificationRepair.allocation.id}
                  credential={classificationCredential}
                  availableUnits={
                    classificationRepair.allocation.allocatedUnits
                  }
                  initialMatches={
                    classificationRepair.allocation.requirementMatches
                  }
                  includeApprovalFields={false}
                />
              ) : (
                <>
                  <label className="field">
                    <span>Credits to apply to this credential</span>
                    <input
                      name="allocatedUnits"
                      type="number"
                      min="0.01"
                      max={classificationRepair.activity.totalUnits}
                      step="0.01"
                      inputMode="decimal"
                      defaultValue={
                        classificationRepair.allocation.allocatedUnits
                      }
                      required
                    />
                    <small>
                      The full learning record remains{" "}
                      {compactNumber(
                        classificationRepair.activity.totalUnits,
                      )}{" "}
                      credits; change only the amount this credential may
                      count.
                    </small>
                  </label>
                  <RequirementPicker
                    key={classificationRepair.allocation.id}
                    credential={classificationCredential}
                    initialRequirementIds={
                      classificationRepair.allocation.requirementIds
                    }
                  />
                </>
              )}
              {isPriorPeriodCarryoverEntry(
                classificationRepair.activity.completionDate,
                classificationCredential,
              ) ? (
                <label className="switch-row">
                  <span>
                    <strong>
                      The issuing authority permits this carryover
                    </strong>
                    <small>
                      Keep this prior-period activity tagged to the
                      evidence-backed carryover source plus only compatible
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
              {error ? (
                <ModalError
                  title="This allocation was not updated"
                  message={error}
                />
              ) : null}
              <div className="form-actions">
                <button
                  className="button button-ghost"
                  type="button"
                  onClick={() => {
                    setClassificationRepair(null);
                    setError("");
                  }}
                >
                  Cancel
                </button>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={pending}
                >
                  {pending ? "Updating…" : "Update allocation"}
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
            <Icon name="close" size={17} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/*
 * ICONS
 * One shape per meaning, all drawn on the same 24px grid at one stroke weight,
 * so marks set at the same `size` read as one set. The stroke is in viewBox
 * units and therefore scales with `size` — a 13px mark carries a lighter line
 * than a 21px one, which is what keeps a small mark from going blobby. Keep
 * adjacent icons on the same size for them to weigh the same. Inline SVG
 * rather than a font or sprite: the app ships no icon dependency and has to
 * paint from the offline cache. Every icon is decorative — the label next to
 * it carries the meaning — so it stays out of the accessibility tree and the
 * surrounding element keeps whatever accessible name it already had.
 *
 * Filled variants exist only where the UI already distinguished filled from
 * outline (an earned badge, a completed quest). Everything else is outline.
 */
const ICON_SHAPES = {
  home: (
    <>
      <path d="M3 10a2 2 0 0 1 .71-1.53l7-6a2 2 0 0 1 2.58 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
    </>
  ),
  layoutGrid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.4" />
      <rect x="14" y="3" width="7" height="7" rx="1.4" />
      <rect x="3" y="14" width="7" height="7" rx="1.4" />
      <rect x="14" y="14" width="7" height="7" rx="1.4" />
    </>
  ),
  listRows: (
    <>
      <path d="M8 5h13" />
      <path d="M8 12h13" />
      <path d="M8 19h13" />
      <path d="M3 5h.01" />
      <path d="M3 12h.01" />
      <path d="M3 19h.01" />
    </>
  ),
  userCircle: (
    <>
      <circle cx="12" cy="12" r="9.4" />
      <circle cx="12" cy="10" r="3" />
      <path d="M6.6 19.9V19a2 2 0 0 1 2-2h6.8a2 2 0 0 1 2 2v.9" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  check: <path d="M20 6 9 17l-5-5" />,
  close: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  arrowRight: (
    <>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </>
  ),
  arrowUpRight: (
    <>
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </>
  ),
  arrowDown: (
    <>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronLeft: <path d="M15 18l-6-6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  refresh: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9.4" />
      <path d="M12 6.6V12l3.8 2.2" />
    </>
  ),
  diamond: (
    <path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.4l7.6 7.6a2.41 2.41 0 0 0 3.4 0l7.6-7.6a2.41 2.41 0 0 0 0-3.4l-7.6-7.6a2.41 2.41 0 0 0-3.4 0z" />
  ),
  diamondFilled: (
    <path
      d="M2.7 10.3a2.41 2.41 0 0 0 0 3.4l7.6 7.6a2.41 2.41 0 0 0 3.4 0l7.6-7.6a2.41 2.41 0 0 0 0-3.4l-7.6-7.6a2.41 2.41 0 0 0-3.4 0z"
      fill="currentColor"
    />
  ),
  circle: <circle cx="12" cy="12" r="9.4" />,
  target: (
    <>
      <circle cx="12" cy="12" r="9.4" />
      <circle cx="12" cy="12" r="3.6" />
    </>
  ),
  camera: (
    <>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
      <circle cx="12" cy="13" r="3.2" />
    </>
  ),
  save: (
    <>
      <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M17 21v-8H7v8" />
      <path d="M7 3v4h8" />
    </>
  ),
  shield: (
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9.4" />
      <path d="M12 16.4v-4.6" />
      <path d="M12 7.9h.01" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="9.4" />
      <path d="M12 7.6v4.8" />
      <path d="M12 16.4h.01" />
    </>
  ),
  trendingUp: (
    <>
      <path d="M16 7h6v6" />
      <path d="m22 7-8.5 8.5-5-5L2 17" />
    </>
  ),
  zap: (
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
  ),
};

type IconName = keyof typeof ICON_SHAPES;

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_SHAPES[name]}
    </svg>
  );
}

function Brand() {
  return (
    <div className="brand" aria-label="iTrack">
      <span className="brand-mark" aria-hidden="true">
        i
      </span>
      <span>iTrack</span>
    </div>
  );
}

function DesktopSidebar({
  view,
  onView,
  onAdd,
}: {
  view: TabName;
  onView: (view: TabName) => void;
  onAdd: () => void;
}) {
  return (
    <aside className="desktop-sidebar">
      <Brand />
      <nav aria-label="Primary navigation">
        <NavButton
          active={view === "home"}
          label={TAB_LABELS.home}
          icon="home"
          onClick={() => onView("home")}
        />
        <NavButton
          active={view === "credentials"}
          label={TAB_LABELS.credentials}
          icon="layoutGrid"
          onClick={() => onView("credentials")}
        />
        <NavButton
          active={view === "history"}
          label={TAB_LABELS.history}
          icon="listRows"
          onClick={() => onView("history")}
        />
        <NavButton
          active={view === "profile"}
          label={TAB_LABELS.profile}
          icon="userCircle"
          onClick={() => onView("profile")}
        />
      </nav>
      {/*
       * Never inert. Before a first credential exists the sheet opens on its
       * own empty state, which explains why credits need a cycle and routes to
       * credential setup; a dead button explains nothing.
       */}
      <button className="sidebar-add" type="button" onClick={onAdd}>
        <Icon name="plus" size={18} />
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
}: {
  view: TabName;
  onView: (view: TabName) => void;
  onAdd: () => void;
}) {
  return (
    <nav className="mobile-nav" aria-label="Primary navigation">
      <NavButton
        active={view === "home"}
        label={TAB_LABELS.home}
        icon="home"
        onClick={() => onView("home")}
      />
      <NavButton
        active={view === "credentials"}
        label={TAB_LABELS.credentials}
        icon="layoutGrid"
        onClick={() => onView("credentials")}
      />
      {/*
       * Never inert: with no credential yet the sheet opens on its own empty
       * state, which explains the gap and routes to credential setup. A dead
       * primary button explains nothing.
       */}
      <button
        className="mobile-add"
        type="button"
        aria-label="Log completed learning"
        onClick={onAdd}
      >
        <Icon name="plus" size={24} />
      </button>
      <NavButton
        active={view === "history"}
        label={TAB_LABELS.history}
        icon="listRows"
        onClick={() => onView("history")}
      />
      <NavButton
        active={view === "profile"}
        label={TAB_LABELS.profile}
        icon="userCircle"
        onClick={() => onView("profile")}
      />
    </nav>
  );
}

function NavButton({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: IconName;
  onClick: () => void;
}) {
  return (
    <button
      className={`nav-button ${active ? "active" : ""}`}
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <span className="nav-symbol">
        <Icon name={icon} size={20} />
      </span>
      <span>{label}</span>
    </button>
  );
}

function TodayView({
  workspace,
  credential,
  isOnline,
  highlightedReminderKey,
  onAddActivity,
  onAddCredential,
  onViewRecords,
  onOpenCredential,
  onLogCreditsFor,
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
  pendingActionKeys,
  onClaimQuest,
  onRequirementApplicability,
  onDentalCheckpoint,
}: {
  workspace: Workspace;
  credential: Credential | null;
  isOnline: boolean;
  highlightedReminderKey: string;
  onAddActivity: () => void;
  onAddCredential: () => void;
  onViewRecords: () => void;
  onOpenCredential: (credentialId: string) => void;
  onLogCreditsFor: (credentialId: string) => void;
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
  pendingActionKeys: readonly string[];
  onClaimQuest: (quest: WeeklyQuest) => void;
  onRequirementApplicability: (
    requirement: Requirement,
    status: "applies" | "not_applicable",
  ) => void;
  onDentalCheckpoint: (
    requirement: Requirement,
    completed: boolean,
    evidenceNote: string,
  ) => void;
}) {
  // The inbox heading counts every timely check-in, so every counted check-in
  // has to be reachable from this view rather than cut off after the third.
  const [showAllReminders, setShowAllReminders] = useState(false);

  if (!credential) {
    return (
      <div className="view-stack">
        <PageGreeting
          eyebrow="Your renewal companion"
          title={`Welcome, ${firstName(workspace.user.displayName)}.`}
          body="Let’s turn your license or certification requirements into a clear, manageable plan."
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
              <Icon name="arrowRight" size={16} />
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
        <section className="trust-strip" aria-label="iTrack principles">
          <div>
            <span className="trust-mark">
              <Icon name="check" size={15} />
            </span>
            <p><strong>Source-linked rules</strong> with review dates</p>
          </div>
          <div>
            <span className="trust-mark">
              <Icon name="check" size={15} />
            </span>
            <p><strong>Your activity history</strong> kept cycle by cycle</p>
          </div>
          <div>
            <span className="trust-mark">
              <Icon name="check" size={15} />
            </span>
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
  const highlightedReminder = workspace.reminders.find(
    (reminder) => reminder.key === highlightedReminderKey,
  );
  const visibleReminders = highlightedReminder
    ? [
        highlightedReminder,
        ...workspace.reminders.filter(
          (reminder) => reminder.key !== highlightedReminder.key,
        ),
      ]
    : workspace.reminders;
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
      // Both of these are about *this* credential — its unresolved rules, its
      // preserved cycle — and both live on its own screen, so they open it
      // rather than dropping the reader on the list to find it again.
      case "conditions":
      case "history":
        onOpenCredential(credential.id);
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
            <Icon name="plus" size={16} />
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
              onClick={() => onOpenCredential(credential.id)}
            >
              View plan
              <Icon name="arrowRight" size={15} />
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
              ? "Based on countable units, active minimums, required checkpoints, and checklist steps."
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
          <div className="reminder-list" id="reminder-inbox-list">
            {(showAllReminders
              ? visibleReminders
              : visibleReminders.slice(0, 3)
            ).map((reminder) => (
              <article
                className={`${reminder.urgency} ${
                  reminder.key === highlightedReminderKey ? "highlighted" : ""
                }`}
                data-reminder-key={reminder.key}
                key={reminder.key}
                tabIndex={
                  reminder.key === highlightedReminderKey ? -1 : undefined
                }
              >
                <span className="reminder-dot" aria-hidden="true" />
                <button
                  className="reminder-open"
                  type="button"
                  onClick={() => onOpenCredential(reminder.credentialId)}
                >
                  <span>
                    <strong>{reminder.title}</strong>
                    <small>{reminder.body}</small>
                  </span>
                  <span className="reminder-chevron" aria-hidden="true">
                    <Icon name="chevronRight" size={16} />
                  </span>
                </button>
                <div>
                  {/*
                   * A deadline is a check-in about credits still to earn, so
                   * the log is offered here with this credential already
                   * chosen. The other two kinds — a checklist step, a
                   * submission waiting on its issuer — are not about credits,
                   * and an action that does not fit the card is noise.
                   */}
                  {reminder.kind === "deadline" ? (
                    <button
                      className="reminder-log"
                      type="button"
                      onClick={() => onLogCreditsFor(reminder.credentialId)}
                    >
                      Log credits
                    </button>
                  ) : null}
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
          {visibleReminders.length > 3 ? (
            <div className="reminder-inbox-footer">
              <button
                className="text-button"
                type="button"
                aria-controls="reminder-inbox-list"
                aria-expanded={showAllReminders}
                onClick={() => setShowAllReminders((current) => !current)}
              >
                {showAllReminders
                  ? "Show the first 3 check-ins"
                  : `View all ${visibleReminders.length} check-ins`}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="next-action-card">
        <span className="next-action-icon">
          {/* arrowRight, not arrowUpRight: this card's action stays in-app. */}
          <Icon name="arrowRight" size={21} />
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
                  credential.status !== "renewed"
                    ? (status) =>
                        onRequirementApplicability(requirement, status)
                    : undefined
                }
                onDentalCheckpoint={
                  credential.status === "renewed"
                    ? undefined
                    : (completed, evidenceNote) =>
                        onDentalCheckpoint(
                          requirement,
                          completed,
                          evidenceNote,
                        )
                }
                actionsDisabled={taskActionsDisabled}
                pendingActionKeys={pendingActionKeys}
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
            <Icon
              name={credential.status === "renewed" ? "arrowRight" : "plus"}
              size={16}
            />
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
                    <span className="quest-state">
                      <Icon
                        name={
                          quest.claimed
                            ? "check"
                            : quest.completed
                              ? "diamondFilled"
                              : "diamond"
                        }
                        size={15}
                      />
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
                        disabled={pendingActionKeys.includes(
                          questActionKey(quest.key),
                        )}
                        aria-busy={pendingActionKeys.includes(
                          questActionKey(quest.key),
                        )}
                        onClick={() => onClaimQuest(quest)}
                      >
                        {pendingActionKeys.includes(
                          questActionKey(quest.key),
                        ) ? (
                          <>
                            <ActionSpinner />
                            Claiming…
                          </>
                        ) : (
                          `+${quest.rewardXp} XP`
                        )}
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
            <span>
              <Icon
                name={
                  progression.momentum.activeThisWeek ? "trendingUp" : "circle"
                }
                size={14}
              />
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
              {isOnline ? (
                <a
                  className="task-add-button packet-link"
                  href={`/api/export/packet?credentialId=${encodeURIComponent(
                    credential.id,
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Prepare packet
                  <Icon name="arrowUpRight" size={14} />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : (
                <button
                  className="task-add-button packet-link"
                  type="button"
                  disabled
                  title="Reconnect to prepare a credential packet"
                >
                  Reconnect for packet
                </button>
              )}
              {credential.status !== "renewed" ? (
                <button
                  className="task-add-button"
                  type="button"
                  disabled={taskActionsDisabled}
                  onClick={() => onAddPersonalTask(credential)}
                >
                  <Icon name="plus" size={15} />
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
              const taskSaving = pendingActionKeys.includes(
                taskActionKey(task.id),
              );
              return (
                <article
                  className={`task-row ${
                    task.status === "completed" ? "completed" : ""
                  } ${taskOverdue ? "overdue" : ""} ${
                    credential.status === "renewed" ? "locked" : ""
                  } ${taskSaving ? "saving" : ""}`}
                  key={task.id}
                  aria-busy={taskSaving}
                >
                  <label className="task-toggle">
                    <input
                      type="checkbox"
                      checked={task.status === "completed"}
                      disabled={
                        credential.status === "renewed" ||
                        taskActionsDisabled ||
                        taskSaving
                      }
                      onChange={() => onToggleTask(task)}
                    />
                    <span className="custom-check">
                      <Icon name="check" size={14} />
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
                  {taskSaving ? (
                    <span className="row-saving" role="status">
                      <ActionSpinner />
                      Saving…
                    </span>
                  ) : task.isPersonal &&
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
                <span className="disclosure-chevron">
                  <Icon name="chevronDown" size={16} />
                </span>
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
                        disabled={
                          taskActionsDisabled ||
                          pendingActionKeys.includes(taskActionKey(task.id))
                        }
                        aria-busy={pendingActionKeys.includes(
                          taskActionKey(task.id),
                        )}
                        onClick={() => onRestorePersonalTask(task)}
                      >
                        {pendingActionKeys.includes(
                          taskActionKey(task.id),
                        ) ? (
                          <>
                            <ActionSpinner />
                            Restoring…
                          </>
                        ) : (
                          "Restore task"
                        )}
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
              <Icon name="arrowRight" size={16} />
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
                  ? "Confirm renewed cycle"
                  : isCompliancePeriodCredential(credential)
                    ? "Start next period"
                  : "Record acceptance"}
                <Icon name="arrowRight" size={15} />
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
                  <span className={`evidence-mark ${activity.evidenceStatus}`}>
                    <Icon
                      name={
                        activity.evidenceStatus === "attached"
                          ? "check"
                          : activity.evidenceStatus === "missing"
                            ? "alert"
                            : "minus"
                      }
                      size={14}
                    />
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
}: {
  credentials: Credential[];
  selectedId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  // The highlight marks the credential the rest of the app is pointed at —
  // Today's card, the log sheet's default — not a detail pane beside the list,
  // which now lives on its own pushed screen.
  const activeId =
    credentials.find((credential) => credential.id === selectedId)?.id ??
    credentials[0]?.id ??
    "";
  return (
    <div className="view-stack">
      <PageGreeting
        eyebrow="Credentials"
        title="Every renewal, one clear place."
        body="Requirements, sources, cycles, and submission status stay connected."
        action={
          <button className="button button-primary" type="button" onClick={onAdd}>
            <Icon name="plus" size={16} />
            Add credential
          </button>
        }
      />
      {credentials.length ? (
        <section
          className="credential-picker credential-list"
          aria-label="Your credentials"
        >
          {credentials.map((credential) => (
            <button
              key={credential.id}
              className={credential.id === activeId ? "active" : ""}
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
            <Icon name="plus" size={15} />
            Add another credential
          </button>
        </section>
      ) : (
        <EmptyPage
          title="Add your first credential"
          body="Choose a source-linked rule template or make a custom plan from your credential information."
          action="Set up credential"
          onAction={onAdd}
        />
      )}
    </div>
  );
}

/*
 * The credential detail is a *pushed* screen, not a pane: it owns a history
 * entry, so the iOS back gesture, the browser back button and a refresh all
 * behave the way the platform promises. Its header carries the iOS pairing of
 * a back control labelled with the screen it returns to and this screen's own
 * title.
 */
function CredentialDetailScreen({
  credential,
  activities,
  isOnline,
  backLabel,
  onBack,
  onSubmit,
  onAccept,
  onReminders,
  onAddToCalendar,
  onRequirementApplicability,
  onDentalCheckpoint,
  actionsDisabled,
  pendingActionKeys,
}: {
  credential: Credential;
  activities: Activity[];
  isOnline: boolean;
  // The tab this screen was pushed from, which is not always the Credentials
  // list: Home opens credentials too, and the control has to name the screen
  // the user will actually land back on.
  backLabel: string;
  onBack: () => void;
  onSubmit: () => void;
  onAccept: () => void;
  onReminders: () => void;
  onAddToCalendar: (credential: Credential) => void;
  onRequirementApplicability: (
    credentialId: string,
    requirement: Requirement,
    status: "applies" | "not_applicable",
  ) => void;
  onDentalCheckpoint: (
    credentialId: string,
    requirement: Requirement,
    completed: boolean,
    evidenceNote: string,
  ) => void;
  actionsDisabled: boolean;
  pendingActionKeys: readonly string[];
}) {
  const credentialActivities = activities.filter((activity) =>
    allocationsFor(activity).some(
      (allocation) => allocation.credentialId === credential.id,
    ),
  );
  const requirementGapCount = Math.max(
    Number(credential.totalRemaining ?? 0) > 0 ? 1 : 0,
    credential.requirements.filter(
      (requirement) =>
        requirement.applicabilityStatus === "needs_confirmation" ||
        (requirement.isActive !== false &&
          requirement.kind === "minimum" &&
          requirement.applicabilityStatus !== "not_applicable" &&
          Math.max(
            0,
            requirement.requiredUnits - requirementEarned(requirement),
          ) > 0),
    ).length,
  );
  const proofGapCount = credentialActivities.filter(
    (activity) =>
      activity.evidenceStatus === "missing" ||
      Number(activity.evidenceDeletionPendingCount ?? 0) > 0,
  ).length;
  const classificationGapCount = credential.classificationIssues?.length ?? 0;
  const openTaskCount = credential.tasks.filter(
    (task) => task.status !== "completed",
  ).length;
  const trackedGapCount =
    requirementGapCount +
    proofGapCount +
    classificationGapCount +
    openTaskCount;
  return (
    <div className="view-stack">
      <header className="push-header">
        <button type="button" className="push-back" onClick={onBack}>
          <Icon name="chevronLeft" size={22} />
          <span>{backLabel}</span>
        </button>
        <h1 className="push-title">{credential.credentialName}</h1>
      </header>
      <section className="credential-detail">
        <div className="credential-detail-header">
          <div>
            <span className="status-pill status-pill-dark">
              {isIsc2AutomaticRenewalCredential(credential)
                ? credential.status === "active"
                  ? "active renewal cycle"
                  : credential.status === "submitted"
                    ? "awaiting ISC2 renewal"
                    : "renewed"
                : isCompliancePeriodCredential(credential)
                  ? credential.status === "active"
                    ? "compliance period"
                    : credential.status === "submitted"
                      ? "compliance recorded"
                      : "completed"
                  : credential.status}
            </span>
            <h2>{credential.credentialName}</h2>
            <p>
              {credential.jurisdiction}
              {credential.issuer ? ` · ${credential.issuer}` : ""}
            </p>
          </div>
          <div className="deadline-chip">
            <span>
              {isCompliancePeriodCredential(credential)
                ? "Complete by"
                : "Renew by"}
            </span>
            <strong>{formatDate(credential.deadline)}</strong>
          </div>
        </div>
        <section
          className={`credential-packet-card ${
            trackedGapCount ? "has-gaps" : "tracked-complete"
          }`}
          aria-labelledby="credential-packet-title"
        >
          <div className="credential-packet-copy">
            <span className="section-kicker">Credential packet</span>
            <h3 id="credential-packet-title">
              {credential.status === "renewed"
                ? "Preserve this completed-cycle record."
                : credential.status === "submitted"
                  ? isCompliancePeriodCredential(credential)
                    ? "Keep this compliance checkpoint together."
                    : isIsc2AutomaticRenewalCredential(credential)
                      ? "Keep this dashboard checkpoint together."
                      : "Keep the submission record together."
                  : trackedGapCount
                    ? "Review tracked gaps before the next official step."
                    : "No tracked gaps found—ready for official review."}
            </h3>
            <p>
              Opens a private, print-ready summary. Evidence files stay
              separate and require your signed-in account.
            </p>
            <div
              className="credential-packet-gaps"
              aria-label={`${trackedGapCount} tracked packet gaps`}
            >
              <span>{requirementGapCount} requirement gaps</span>
              <span>{proofGapCount} proof flags</span>
              <span>{classificationGapCount} classification gaps</span>
              <span>{openTaskCount} checklist tasks</span>
            </div>
          </div>
          {isOnline ? (
            <a
              className="button button-outline credential-packet-action"
              href={`/api/export/packet?credentialId=${encodeURIComponent(
                credential.id,
              )}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Prepare credential packet
              <Icon name="arrowUpRight" size={15} />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            <button
              className="button button-outline credential-packet-action"
              type="button"
              disabled
            >
              Reconnect to prepare packet
            </button>
          )}
        </section>
        {credential.status !== "renewed" ? (
          <div className="credential-utility-actions">
            <button
              className="reminder-setting-link"
              type="button"
              onClick={onReminders}
            >
              <Icon name="clock" size={15} />
              <span>
                Configure{" "}
                {isCompliancePeriodCredential(credential)
                  ? "compliance"
                  : "renewal"}{" "}
                check-ins
              </span>
            </button>
            <button
              className="reminder-setting-link"
              type="button"
              onClick={() => onAddToCalendar(credential)}
            >
              <Icon name="plus" size={15} />
              <span>
                Add{" "}
                {isCompliancePeriodCredential(credential)
                  ? "compliance"
                  : "renewal"}{" "}
                date to calendar
              </span>
            </button>
          </div>
        ) : null}
        <div className="detail-stats">
          <div>
            <span>Counted</span>
            <strong>
              {credential.totalRequired > 0
                ? `${compactNumber(credential.totalEarned)} / ${compactNumber(
                    credential.totalRequired,
                  )}`
                : "Checklist"}
            </strong>
            <small>
              {credential.totalRequired > 0
                ? credential.unitLabel
                : "no general CE total"}
            </small>
          </div>
          <div>
            <span>Readiness</span>
            <strong>{readinessScore(credential)}%</strong>
            <small>credits + checklist</small>
          </div>
          <div>
            <span>
              {daysUntil(credential.deadline) < 0
                ? "Past deadline"
                : "Time left"}
            </span>
            <strong>{Math.abs(daysUntil(credential.deadline))}</strong>
            <small>
              {daysUntil(credential.deadline) < 0
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
          {credential.totalRequired > 0 ? (
            <ProgressRow
              name="Overall"
              earned={credential.totalEarned}
              required={credential.totalRequired}
              unit={credential.unitLabel}
            />
          ) : (
            <p className="total-excess-note">
              This issuing organization does not set a general numeric
              continuing-education total. Complete the applicable training
              conditions and checklist using the official record.
            </p>
          )}
          {Number(credential.totalExcessUnits ?? 0) > 0 ? (
            <p className="total-excess-note">
              {compactNumber(credential.totalRawEarned ?? 0)}{" "}
              {credential.unitLabel} are documented;{" "}
              {compactNumber(credential.totalExcessUnits ?? 0)} exceed a
              category limit.
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
                credential.status !== "renewed"
                  ? (status) =>
                      onRequirementApplicability(
                        credential.id,
                        requirement,
                        status,
                      )
                  : undefined
              }
              onDentalCheckpoint={
                credential.status === "renewed"
                  ? undefined
                  : (completed, evidenceNote) =>
                      onDentalCheckpoint(
                        credential.id,
                        requirement,
                        completed,
                        evidenceNote,
                      )
              }
              actionsDisabled={actionsDisabled}
              pendingActionKeys={pendingActionKeys}
            />
          ))}
        </div>
        <div className="detail-section source-detail">
          <span className="section-kicker">Rule source</span>
          <h3>
            {credential.ruleReviewStatus === "custom"
              ? "Custom requirements"
              : "Source-linked template"}
          </h3>
          {credential.ruleReviewStatus !== "custom" ? (
            <span
              className={`verified-chip ${ruleReviewClass(
                credential.ruleReviewStatus,
              )}`}
            >
              {ruleReviewLabel(credential.ruleReviewStatus)}
            </span>
          ) : null}
          <p>
            {credential.sourceTitle ??
              "Confirm requirements and dates with the issuing organization, especially when rules or your credential status change."}
          </p>
          {credential.sourceUrl ? (
            <a
              className="button button-outline"
              href={credential.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open official guidance
              <Icon name="arrowUpRight" size={15} />
            </a>
          ) : (
            <span className="custom-rule-label">
              Entered manually · no official source attached
            </span>
          )}
        </div>
        {credential.status === "active" ? (
          <div className="detail-footer">
            <div>
              <strong>
                {isIsc2AutomaticRenewalCredential(credential)
                  ? "Does the ISC2 Dashboard show CPEs and annual maintenance fees satisfied?"
                  : isCompliancePeriodCredential(credential)
                    ? "Does the official record show this period complete?"
                  : "Finished your renewal submission?"}
              </strong>
              <p>
                {isIsc2AutomaticRenewalCredential(credential)
                  ? "Save this milestone separately from completed learning."
                  : isCompliancePeriodCredential(credential)
                    ? "Save this official milestone separately from completed learning."
                  : "Log it separately from completed learning."}
              </p>
            </div>
            <button
              className="button button-primary"
              type="button"
              onClick={onSubmit}
            >
              {isIsc2AutomaticRenewalCredential(credential)
                ? "Save dashboard checkpoint"
                : isCompliancePeriodCredential(credential)
                  ? "Record compliance"
                : "Log submission"}
            </button>
          </div>
        ) : credential.status === "submitted" ? (
          <div className="detail-footer submitted-footer">
            <div>
              <strong>
                {isIsc2AutomaticRenewalCredential(credential)
                  ? "Awaiting ISC2 renewal"
                  : isCompliancePeriodCredential(credential)
                    ? "Compliance recorded"
                  : "Renewal submitted"}{" "}
                {formatDate(credential.submittedAt)}
              </strong>
              <p>
                {credential.confirmationNumber
                  ? `Confirmation: ${credential.confirmationNumber}`
                  : "No confirmation number recorded."}
              </p>
            </div>
            <button
              className="button button-primary"
              type="button"
              onClick={onAccept}
            >
              {isIsc2AutomaticRenewalCredential(credential)
                ? "Confirm renewed cycle"
                : isCompliancePeriodCredential(credential)
                  ? "Start next period"
                : "Record acceptance"}
            </button>
          </div>
        ) : (
          <div className="detail-footer submitted-footer">
            <div>
              <strong>
                {isCompliancePeriodCredential(credential)
                  ? "Completed"
                  : "Renewed"}{" "}
                {formatDate(credential.acceptedAt)}
              </strong>
              <p>
                {credential.acceptanceReference
                  ? `Reference: ${credential.acceptanceReference}`
                  : "This completed cycle is preserved in history."}
              </p>
            </div>
            <span className="verified-chip">Historical cycle</span>
          </div>
        )}
      </section>
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
  pendingActionKeys,
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
  pendingActionKeys: readonly string[];
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
            <Icon name="plus" size={16} />
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
          Export CSV
          <Icon name="arrowDown" size={15} />
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
                <span className={`evidence-mark ${activity.evidenceStatus}`}>
                  <Icon
                    name={
                      activity.evidenceStatus === "attached"
                        ? "check"
                        : activity.evidenceStatus === "missing"
                          ? "alert"
                          : "minus"
                    }
                    size={14}
                  />
                </span>
                <span>
                  <span className="sr-only">Activity: </span>
                  <strong>{activity.title}</strong>
                  <small>
                    {formatDate(activity.completionDate)}
                    {activity.provider ? ` · ${activity.provider}` : ""}
                  </small>
                </span>
              </div>
              <span>
                <span className="sr-only record-field-label">Credential</span>
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
                    className="proof-action allocation-action with-icon"
                    type="button"
                    onClick={() => onAllocate(activity)}
                  >
                    <Icon name="plus" size={14} />
                    <span>Use for another</span>
                  </button>
                ) : null}
              </span>
              <span className="proof-cell">
                <span className="sr-only record-field-label">Proof</span>
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
                <span className="sr-only record-field-label">Credits</span>
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
            <span className="disclosure-chevron">
              <Icon name="chevronDown" size={16} />
            </span>
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
                        disabled={
                          actionsDisabled ||
                          pendingActionKeys.includes(
                            activityActionKey(activity.id),
                          )
                        }
                        aria-busy={pendingActionKeys.includes(
                          activityActionKey(activity.id),
                        )}
                        onClick={() => onRestore(activity)}
                      >
                        {pendingActionKeys.includes(
                          activityActionKey(activity.id),
                        ) ? (
                          <>
                            <ActionSpinner />
                            Restoring…
                          </>
                        ) : (
                          "Restore record"
                        )}
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
    crcApprovalAttested?: boolean;
  }) => void;
  onArchive: () => void;
}) {
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const allocations = allocationsFor(activity);
  const hasNremtAllocation = allocations.some((allocation) =>
    allocation.credentialRuleSetId?.startsWith("nremt-"),
  );
  const hasCrcAllocation = allocations.some((allocation) =>
    allocation.credentialRuleSetId?.startsWith("crcc-"),
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
      crcApprovalAttested: hasCrcAllocation
        ? form.get("crcApprovalAttested") === "on"
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
                : hasCrcAllocation
                  ? "CRC credit-type and ethics amounts stay exact. Recheck any corrected activity details against the saved CRCC approval record."
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
          {hasCrcAllocation ? (
            <label className="switch-row nremt-education-attestation">
              <span>
                <strong>Reconfirm the saved CRCC approval record</strong>
                <small>
                  The corrected activity title, provider, completion date, and
                  credit total still match the saved CRCC approval or accepted
                  post-approval record.
                </small>
              </span>
              <input
                name="crcApprovalAttested"
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
              <small>{proofSummary}. Manage proof separately in History.</small>
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
  pushDeviceState,
  pushPending,
  isOnline,
  onEnablePhoneAlerts,
  onDisablePhoneAlerts,
  onTestPhoneAlert,
  onRefreshPhoneAlerts,
}: {
  workspace: Workspace;
  onReminders: () => void;
  onWeeklyGoal: (weeklyGoal: number) => void;
  weeklyGoalPending: boolean;
  isStandalone: boolean;
  installAvailable: boolean;
  onInstall: () => void;
  onAddAllCheckIns: () => void;
  pushDeviceState: PushDeviceState;
  pushPending: boolean;
  isOnline: boolean;
  onEnablePhoneAlerts: () => void;
  onDisablePhoneAlerts: () => void;
  onTestPhoneAlert: () => void;
  onRefreshPhoneAlerts: () => void;
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
  const phoneAlertHeading =
    pushDeviceState === "checking"
      ? "Checking phone-alert support…"
      : pushDeviceState === "install_required"
        ? "Add iTrack to your Home Screen first."
        : pushDeviceState === "unconfigured"
          ? "Phone alerts are being prepared."
          : pushDeviceState === "unsupported"
            ? "Use calendar alerts on this device."
            : pushDeviceState === "denied"
              ? "Alerts are blocked in device settings."
              : pushDeviceState === "subscribed"
                ? workspace.reminderPreferences.pushEnabled
                  ? "Phone alerts are on for this device."
                  : "This device is connected, but alerts are paused."
                : pushDeviceState === "error"
                  ? "Phone-alert status needs another check."
                  : workspace.reminderPreferences.activePushDeviceCount > 0
                    ? "Add this device to your phone alerts."
                    : "Get renewal check-ins on this device.";
  const phoneAlertBody =
    pushDeviceState === "install_required"
      ? "On iPhone and iPad, Apple enables web alerts only for apps opened from the Home Screen."
      : pushDeviceState === "unconfigured"
        ? "Calendar and in-app check-ins remain available while delivery setup is completed."
        : pushDeviceState === "unsupported"
          ? "This browser cannot receive web push, but your phone calendar can still deliver the same lead-day schedule."
          : pushDeviceState === "denied"
            ? "Allow notifications for iTrack in your phone or browser settings, then check again."
            : pushDeviceState === "subscribed"
              ? workspace.reminderPreferences.pushEnabled
                ? `Private check-ins arrive around ${
                    workspace.reminderPreferences.pushHourLocal ?? 9
                  }:00 in ${workspace.reminderPreferences.timeZone}.`
                : "Resume delivery when you are ready; the device connection is still saved."
              : "Permission is requested only after you tap the button below.";

  const handleWeeklyGoalSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!weeklyGoalChanged || weeklyGoalPending) return;
    onWeeklyGoal(selectedWeeklyGoal);
  };

  return (
    <div className="view-stack">
      <PageGreeting
        eyebrow="Profile"
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
            iTrack rewards real compliance work—not opening the app or
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
                <span>
                  <Icon
                    name={
                      badge.earned || badge.earnedAt
                        ? "diamondFilled"
                        : "diamond"
                    }
                    size={17}
                  />
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
              <span>
                <Icon name="clock" size={16} />
              </span>
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
          <h2>{phoneAlertHeading}</h2>
          <p>{phoneAlertBody}</p>
          <div
            className={`phone-alert-status ${pushDeviceState}`}
            aria-busy={pushPending}
            aria-live="polite"
          >
            <span>
              {/* shield, not diamond: diamond is the milestone mark above. */}
              <Icon
                name={
                  pushDeviceState === "subscribed"
                    ? "check"
                    : pushDeviceState === "denied"
                      ? "alert"
                      : "shield"
                }
                size={17}
              />
            </span>
            <p>
              <strong>
                {pushPending
                  ? "Updating this device…"
                  : pushDeviceState === "subscribed"
                    ? "This device is connected"
                    : "Private by default"}
              </strong>
              <small>
                Alerts show “iTrack check-in,” not credential or
                certificate details.
              </small>
            </p>
          </div>
          <div className="account-card-actions phone-alert-actions">
            {pushDeviceState === "install_required" ? (
              <button
                className="button button-primary"
                type="button"
                disabled={pushPending}
                onClick={onInstall}
              >
                Add to Home Screen
              </button>
            ) : pushDeviceState === "available" ||
              pushDeviceState === "error" ? (
              <button
                className="button button-primary"
                type="button"
                disabled={pushPending || !isOnline}
                onClick={onEnablePhoneAlerts}
              >
                {workspace.reminderPreferences.pushEnabled
                  ? "Add this device"
                  : "Turn on phone alerts"}
              </button>
            ) : pushDeviceState === "denied" ? (
              <button
                className="button button-outline"
                type="button"
                disabled={pushPending}
                onClick={onRefreshPhoneAlerts}
              >
                Check again
              </button>
            ) : pushDeviceState === "subscribed" ? (
              <>
                {!workspace.reminderPreferences.pushEnabled ? (
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={pushPending || !isOnline}
                    onClick={onEnablePhoneAlerts}
                  >
                    Resume phone alerts
                  </button>
                ) : null}
                <button
                  className="button button-outline"
                  type="button"
                  disabled={
                    pushPending ||
                    !isOnline ||
                    !workspace.reminderPreferences.pushEnabled
                  }
                  onClick={onTestPhoneAlert}
                >
                  Send test alert
                </button>
                <button
                  className="button button-ghost"
                  type="button"
                  disabled={pushPending || !isOnline}
                  onClick={onDisablePhoneAlerts}
                >
                  Turn off on this device
                </button>
              </>
            ) : null}
          </div>
          {workspace.reminderPreferences.activePushDeviceCount > 0 ? (
            <small className="connected-device-count">
              {workspace.reminderPreferences.activePushDeviceCount} connected{" "}
              {workspace.reminderPreferences.activePushDeviceCount === 1
                ? "device"
                : "devices"}{" "}
              on this account
            </small>
          ) : null}
          {!isStandalone && pushDeviceState !== "install_required" ? (
            <div className="install-companion-row">
              <p>
                Install iTrack for a focused, full-screen workspace with a
                protected offline fallback.
              </p>
              <button
                className="button button-outline"
                type="button"
                onClick={onInstall}
              >
                {installAvailable ? "Install on this device" : "How to install"}
              </button>
            </div>
          ) : isStandalone ? (
            <span className="installed-pill">
              <Icon name="check" size={14} />
              Installed on this device
            </span>
          ) : null}
        </section>
        <section className="card compliance-card">
          <span className="section-kicker">A careful boundary</span>
          <h2>Organizer, not an issuing authority.</h2>
          <p>
            iTrack helps you track information and prepare for renewal. It
            does not determine course eligibility, guarantee acceptance by a
            licensing board or certifying body, or replace official instructions.
          </p>
          <ul>
            <li>
              <Icon name="check" size={14} />
              <span>Rule templates show their official source.</span>
            </li>
            <li>
              <Icon name="check" size={14} />
              <span>Custom plans remain clearly labeled.</span>
            </li>
            <li>
              <Icon name="check" size={14} />
              <span>
                Credits, proof, submission, and acceptance stay distinct.
              </span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}

/*
 * The single in-flight mark used by every control that can start a write. It
 * is decorative — the visible label beside it ("Saving…", "Claiming…") carries
 * the meaning for assistive technology — so it is hidden from the a11y tree.
 */
function ActionSpinner() {
  return <span className="action-spinner" aria-hidden="true" />;
}

function ProgressRow({
  name,
  earned,
  required,
  unit,
  requirement,
  onApplicability,
  onDentalCheckpoint,
  actionsDisabled = false,
  pendingActionKeys = [],
}: {
  name: string;
  earned: number;
  required: number;
  unit: string;
  requirement?: Requirement;
  onApplicability?: (
    status: "applies" | "not_applicable",
  ) => void;
  onDentalCheckpoint?: (
    completed: boolean,
    evidenceNote: string,
  ) => void;
  actionsDisabled?: boolean;
  pendingActionKeys?: readonly string[];
}) {
  const kind = requirement ? requirementKind(requirement) : "minimum";
  const status = requirement ? requirementStatus(requirement) : "applies";
  // Only this rule's own write shows progress; the rest of the list stays live.
  const requirementSaving = requirement
    ? pendingActionKeys.includes(requirementActionKey(requirement.id))
    : false;
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
        } ${requirementSaving ? "saving" : ""}`}
        aria-busy={requirementSaving}
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
            {requirementSaving ? (
              <span className="row-saving" role="status">
                <ActionSpinner />
                Saving…
              </span>
            ) : (
              <>
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
              </>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  if (kind === "informational") {
    const isDentalCheckpoint = requirement?.isDentalCheckpoint === true;
    const checkpointCompleted =
      requirement?.checkpointStatus === "completed";
    return (
      <div
        className={`progress-row requirement-condition ${
          nested ? "nested" : ""
        } ${isDentalCheckpoint ? "dental-checkpoint" : ""} ${
          checkpointCompleted ? "completed" : ""
        } ${requirementSaving ? "saving" : ""}`}
        aria-busy={requirementSaving}
      >
        <div>
          <span>
            <strong>{name}</strong>
            <small>
              {isDentalCheckpoint
                ? checkpointCompleted
                  ? "Completion documented · 0 CE units"
                  : "Completion required · 0 CE units"
                : "Checklist checkpoint"}
            </small>
          </span>
          {requirement?.conditionNote ? (
            <p>{requirement.conditionNote}</p>
          ) : null}
          {isDentalCheckpoint &&
          requirement?.checkpointEvidenceNote &&
          !onDentalCheckpoint ? (
            <p className="checkpoint-reference">
              Reference: {requirement.checkpointEvidenceNote}
            </p>
          ) : null}
          {isDentalCheckpoint &&
          requirement?.checkpointCompletedAt &&
          !onDentalCheckpoint ? (
            <small className="checkpoint-date">
              Completed{" "}
              {formatDate(requirement.checkpointCompletedAt.slice(0, 10))}
            </small>
          ) : null}
        </div>
        {isDentalCheckpoint && onDentalCheckpoint ? (
          <form
            className="dental-checkpoint-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              onDentalCheckpoint(
                true,
                String(form.get("checkpointEvidenceNote") ?? "").trim(),
              );
            }}
          >
            <label>
              <span>Evidence or official-record reference</span>
              <input
                key={`${requirement?.id}:${requirement?.checkpointRevision ?? 0}`}
                name="checkpointEvidenceNote"
                type="text"
                maxLength={500}
                required
                defaultValue={requirement?.checkpointEvidenceNote ?? ""}
                placeholder="Certificate, CPR card, portal, or assessment reference"
                disabled={actionsDisabled}
              />
            </label>
            <div className="dental-checkpoint-actions">
              <button
                type="submit"
                disabled={actionsDisabled || requirementSaving}
                aria-busy={requirementSaving}
              >
                {requirementSaving ? (
                  <>
                    <ActionSpinner />
                    Saving…
                  </>
                ) : checkpointCompleted ? (
                  "Update reference"
                ) : (
                  "Mark complete"
                )}
              </button>
              {checkpointCompleted ? (
                <button
                  type="button"
                  disabled={actionsDisabled || requirementSaving}
                  onClick={() =>
                    onDentalCheckpoint(
                      false,
                      requirement?.checkpointEvidenceNote ?? "",
                    )
                  }
                >
                  Reopen
                </button>
              ) : null}
              {conditional && onApplicability ? (
                <button
                  type="button"
                  disabled={actionsDisabled || requirementSaving}
                  onClick={() => onApplicability("not_applicable")}
                >
                  Not this cycle
                </button>
              ) : null}
            </div>
          </form>
        ) : conditional && onApplicability ? (
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

/*
 * Live feedback for the exact-allocation forms. The submit-time validators are
 * unchanged and still decide whether a payload is legal — this only shows the
 * running arithmetic while it is still cheap to fix, instead of leaving the
 * user to balance nine fields in their head and find out on Save.
 *   "exact"   — the parts have to add up to the target exactly.
 *   "ceiling" — the amount overlaps the target and may not exceed it.
 */
/*
 * These forms are exact to the entered step — CRC hours go to 0.01 — so the
 * tally must not borrow compactNumber's single-decimal rounding, which would
 * report 2.25 as "2.3" and a 0.05 shortfall as "0.1". Rounding at four places
 * removes float noise and nothing else.
 */
function allocationFigure(value: number) {
  return String(Number(value.toFixed(4)));
}

function AllocationTally({
  label,
  total,
  target,
  targetLabel,
  mode,
}: {
  label: string;
  total: number;
  target: number;
  targetLabel: string;
  mode: "exact" | "ceiling";
}) {
  const difference = Number((total - target).toFixed(4));
  const balanced =
    mode === "exact" ? Math.abs(difference) <= 0.0001 : difference <= 0.0001;
  const state = balanced
    ? mode === "exact"
      ? "Balanced"
      : "Within the limit"
    : difference > 0
      ? `${allocationFigure(difference)} over`
      : `${allocationFigure(-difference)} left to assign`;
  return (
    <p
      className={`allocation-tally ${balanced ? "balanced" : "unbalanced"}`}
      aria-live="polite"
    >
      <span className="allocation-tally-label">{label}</span>
      <span className="allocation-tally-figure">
        {allocationFigure(total)} of {allocationFigure(target)} {targetLabel}
      </span>
      <span className="allocation-tally-state">{state}</span>
    </p>
  );
}

function seedAllocationAmounts(initialMatches: RequirementMatchPayload[]) {
  const seeded: Record<string, string> = {};
  for (const match of initialMatches) {
    seeded[match.requirementId] = String(Number(match.matchedUnits));
  }
  return seeded;
}

function allocationAmount(
  amounts: Record<string, string>,
  requirementId: string,
) {
  const parsed = Number(amounts[requirementId] ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
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
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    seedAllocationAmounts(initialMatches),
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
        value={amounts[requirement.id] ?? "0"}
        onChange={(event) => {
          const entered = event.currentTarget.value;
          setAmounts((current) => ({
            ...current,
            [requirement.id]: entered,
          }));
        }}
        required
      />
    </label>
  );

  const componentTotal = componentRequirements.reduce(
    (sum, requirement) => sum + allocationAmount(amounts, requirement.id),
    0,
  );
  const nationalAmount = national
    ? allocationAmount(amounts, national.id)
    : 0;
  const topicTotal = nationalTopics.reduce(
    (sum, requirement) => sum + allocationAmount(amounts, requirement.id),
    0,
  );
  const overlapTotal = overlappingRequirements.reduce(
    (highest, requirement) =>
      Math.max(highest, allocationAmount(amounts, requirement.id)),
    0,
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
        {availableUnits > 0 ? (
          <AllocationTally
            label="Components"
            total={componentTotal}
            target={availableUnits}
            targetLabel="applied credits"
            mode="exact"
          />
        ) : (
          <p className="allocation-tally waiting">
            <span className="allocation-tally-label">Components</span>
            <span className="allocation-tally-figure">
              Enter the credits to apply first
            </span>
          </p>
        )}
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
        <AllocationTally
          label="Topics"
          total={topicTotal}
          target={nationalAmount}
          targetLabel="National credits"
          mode="exact"
        />
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
        {overlappingRequirements.length ? (
          <AllocationTally
            label="Pediatric"
            total={overlapTotal}
            target={nationalAmount}
            targetLabel="National credits"
            mode="ceiling"
          />
        ) : null}
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

function CrcRequirementAllocator({
  credential,
  availableUnits,
  initialMatches = [],
  includeApprovalFields = true,
  initialProgramReference = "",
}: {
  credential: Credential;
  availableUnits: number;
  initialMatches?: RequirementMatchPayload[];
  includeApprovalFields?: boolean;
  initialProgramReference?: string;
}) {
  const parsedInitialReference =
    /^CRCC (pre-approved|post-approved) \| (.+)$/.exec(
      initialProgramReference,
    );
  const initialApprovalType =
    parsedInitialReference?.[1] === "post-approved"
      ? "post_approved"
      : "pre_approved";
  const displayedProgramReference =
    parsedInitialReference?.[2] ?? initialProgramReference;
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    seedAllocationAmounts(initialMatches),
  );
  const selectable = credential.requirements.filter(
    (requirement) =>
      requirementStatus(requirement) === "applies" &&
      requirement.isActive !== false,
  );
  const general = selectable.find((requirement) =>
    requirement.ruleCategoryId?.endsWith("-general"),
  );
  const professionalDevelopment = selectable.find((requirement) =>
    requirement.ruleCategoryId?.endsWith("-professional-development"),
  );
  const ethics = selectable.find((requirement) =>
    requirement.ruleCategoryId?.endsWith("-ethics"),
  );
  const exactRequirements = [
    general,
    professionalDevelopment,
    ethics,
  ].filter((requirement): requirement is Requirement =>
    Boolean(requirement),
  );

  const amountInput = (requirement: Requirement) => (
    <label className="nremt-allocation-row" key={requirement.id}>
      <span>
        <strong>{requirement.name}</strong>
        <small>
          {requirement === ethics
            ? "Overlaps General / Other; does not add clock hours"
            : requirement === professionalDevelopment
              ? "Separate activity type; no more than 50 hours per cycle"
              : "Accepted CRC credit that is not Professional Development"}
        </small>
      </span>
      <input
        aria-label={`${requirement.name} accepted clock hours`}
        name={`requirementMatch:${requirement.id}`}
        type="number"
        min="0"
        max={availableUnits > 0 ? availableUnits : undefined}
        step="0.01"
        inputMode="decimal"
        value={amounts[requirement.id] ?? "0"}
        onChange={(event) => {
          const entered = event.currentTarget.value;
          setAmounts((current) => ({
            ...current,
            [requirement.id]: entered,
          }));
        }}
        required
      />
    </label>
  );

  const generalAmount = general ? allocationAmount(amounts, general.id) : 0;
  const creditTypeTotal =
    generalAmount +
    (professionalDevelopment
      ? allocationAmount(amounts, professionalDevelopment.id)
      : 0);
  const ethicsAmount = ethics ? allocationAmount(amounts, ethics.id) : 0;

  return (
    <fieldset className="nremt-requirement-allocator">
      <legend>CRCC accepted clock-hour allocation</legend>
      <p>
        Enter the exact hours CRCC accepts. General / Other plus Professional
        Development must equal the hours applied to this CRC; Ethics is the
        overlapping portion of General / Other.
      </p>
      {exactRequirements.length === 3 ? (
        <section>
          <div className="nremt-allocation-heading">
            <strong>Credit-type and ethics amounts</strong>
            <small>
              Assign every applied hour once between the two credit types, then
              enter any ethics portion already included in General / Other.
            </small>
          </div>
          {availableUnits > 0 ? (
            <AllocationTally
              label="General / Other + Professional Development"
              total={creditTypeTotal}
              target={availableUnits}
              targetLabel="applied hours"
              mode="exact"
            />
          ) : (
            <p className="allocation-tally waiting">
              <span className="allocation-tally-label">
                General / Other + Professional Development
              </span>
              <span className="allocation-tally-figure">
                Enter the hours to apply first
              </span>
            </p>
          )}
          <AllocationTally
            label="Ethics"
            total={ethicsAmount}
            target={generalAmount}
            targetLabel="General / Other hours"
            mode="ceiling"
          />
          <div className="nremt-allocation-list">
            {exactRequirements.map(amountInput)}
          </div>
        </section>
      ) : (
        <p>
          This CRC template is missing an exact-allocation requirement. Refresh
          the credential before saving.
        </p>
      )}
      {includeApprovalFields ? (
        <>
          <label className="field">
            <span>CRCC approval pathway</span>
            <select
              name="crcApprovalType"
              defaultValue={initialApprovalType}
              required
            >
              <option value="pre_approved">
                CRCC pre-approved activity
              </option>
              <option value="post_approved">
                CRCC post-approved activity
              </option>
            </select>
            <small>
              Choose post-approved only when the activity was submitted through
              CRCC&apos;s individual review process.
            </small>
          </label>
          <label className="field">
            <span>CRCC approval number or program reference</span>
            <input
              name="crcProgramReference"
              defaultValue={displayedProgramReference}
              placeholder="Approval number, program ID, or post-approval reference"
              maxLength={500}
              required
            />
            <small>
              A current pre-approval number begins with 60007 or TRN. For
              post-approval, use the CRCC submission or decision reference.
            </small>
          </label>
          <label className="switch-row nremt-education-attestation">
            <span>
              <strong>These are CRCC-accepted hours</strong>
              <small>
                I confirmed the activity, approval pathway, program reference,
                and exact accepted hours in the current CRCC record. For a
                post-approved activity, CRCC accepted the submission, the
                review fee is paid, and I will keep the supporting decision
                and program proof. This same program has not already been
                submitted in this certification period.
              </small>
            </span>
            <input
              name="crcApprovalAttested"
              type="checkbox"
              required
            />
          </label>
        </>
      ) : (
        <label className="switch-row nremt-education-attestation">
          <span>
            <strong>I rechecked this exact CRCC allocation</strong>
            <small>
              The corrected General / Other, Professional Development, and
              Ethics amounts match the saved CRCC approval record.
            </small>
          </span>
          <input
            name="crcApprovalAttested"
            type="checkbox"
            required
          />
        </label>
      )}
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
        requirement.isDentalCheckpoint !== true &&
        requirement.ruleCategoryId !== CFP_2027_GENERAL_CATEGORY_ID &&
        !DENTAL_AGGREGATE_PARENT_CATEGORY_ID_SET.has(
          requirement.ruleCategoryId ?? "",
        ),
    ) ?? [];
  const unresolved =
    credential?.requirements.filter(
      (requirement) =>
        requirementStatus(requirement) === "needs_confirmation",
    ).length ?? 0;

  const toggleRequirement = (requirement: Requirement, checked: boolean) => {
    setSelectedRequirementIds((current) => {
      let next = nextRequirementSelection(current, requirement, selectable, checked);
      const categoryId = requirement.ruleCategoryId ?? "";
      const aggregateCategoryId =
        DENTAL_AGGREGATE_BY_SUBTYPE_CATEGORY_ID.get(categoryId);
      const categoryIdByRequirementId = new Map(
        selectable.map((candidate) => [
          candidate.id,
          candidate.ruleCategoryId ?? "",
        ]),
      );
      const categoryIdOf = (requirementId: string) =>
        categoryIdByRequirementId.get(requirementId) ?? "";
      if (checked && aggregateCategoryId) {
        const aggregateRequirement = selectable.find(
          (candidate) =>
            candidate.ruleCategoryId === aggregateCategoryId,
        );
        if (
          aggregateRequirement &&
          !next.includes(aggregateRequirement.id)
        ) {
          // The aggregate belongs to its own exclusive group, so add it the
          // same way a direct click would; a raw append would leave two
          // members of that group checked and the save would conflict.
          next = nextRequirementSelection(
            next,
            aggregateRequirement,
            selectable,
            true,
          );
        }
      }
      if (!checked && aggregateCategoryId) {
        // Clearing the last subtype orphans the aggregate that was added with
        // it, and the server rejects an aggregate without a subtype.
        const subtypeCategoryIds =
          DENTAL_SUBTYPE_CATEGORY_IDS_BY_AGGREGATE.get(aggregateCategoryId);
        const keepsAnySubtype = next.some((requirementId) =>
          Boolean(subtypeCategoryIds?.has(categoryIdOf(requirementId))),
        );
        if (!keepsAnySubtype) {
          next = next.filter(
            (requirementId) =>
              categoryIdOf(requirementId) !== aggregateCategoryId,
          );
        }
      }
      // A subtype may only stay selected while its aggregate is. Unchecking
      // the aggregate, or replacing it through its exclusive group, drops the
      // subtypes the server would otherwise reject as orphaned.
      for (const [
        parentCategoryId,
        subtypeCategoryIds,
      ] of DENTAL_SUBTYPE_CATEGORY_IDS_BY_AGGREGATE) {
        const aggregateOffered = selectable.some(
          (candidate) => candidate.ruleCategoryId === parentCategoryId,
        );
        if (!aggregateOffered) continue;
        const aggregateSelected = next.some(
          (requirementId) => categoryIdOf(requirementId) === parentCategoryId,
        );
        if (aggregateSelected) continue;
        next = next.filter(
          (requirementId) =>
            !subtypeCategoryIds.has(categoryIdOf(requirementId)),
        );
      }
      return next;
    });
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
              <span className="requirement-check">
                <Icon name="check" size={14} />
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
  useSheetDragDismiss(dialogRef, onClose);

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
          {/*
           * Decorative: it says the sheet can be pushed away, and the gesture
           * and the close button are what actually do it. Hung off the sticky
           * header so scrolling the sheet cannot carry the handle out of view.
           */}
          <span className="sheet-grabber" aria-hidden="true" />
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
            <Icon name="close" size={19} />
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
      <span>
        <Icon name="plus" size={16} />
      </span>
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

/*
 * A rejected save has to be readable from inside the sheet that caused it: the
 * page-level error banner sits under `.modal-backdrop` and is marked inert
 * while a modal is open, so it can never be seen or announced from there. Each
 * modal renders this immediately above its own submit row, and it pulls itself
 * into view because a phone sheet is usually already scrolled to that row.
 */
function ModalError({ title, message }: { title: string; message: string }) {
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = errorRef.current;
    if (!node) return;
    node.scrollIntoView({ block: "center" });
    node.focus({ preventScroll: true });
  }, [message]);

  return (
    <div className="modal-error" role="alert" ref={errorRef} tabIndex={-1}>
      <strong>{title}</strong>
      <span>{message}</span>
    </div>
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
      <span>
        <Icon name="plus" size={24} />
      </span>
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
    <div className="view-stack" aria-busy="true" aria-label="Loading iTrack">
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
      <span className="offline-workspace-mark">
        <Icon name="zap" size={26} />
      </span>
      <span className="section-kicker">Connection paused</span>
      <h1>Your cloud record is still protected.</h1>
      <p>
        iTrack could not load this device’s signed-in workspace while
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
      ? "iTrack is temporarily unavailable."
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
      <span className="offline-workspace-mark">
        <Icon name="alert" size={26} />
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
