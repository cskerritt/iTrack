import { getD1 } from "@/db";
import {
  type RequestIdentity,
  resolveRequestIdentity,
} from "@/db/identity";
import { ensureUser, initializeDatabase } from "@/db/runtime";
import {
  findRequirementIncompatibility,
  REQUIREMENT_INCOMPATIBILITIES,
} from "../../lib/requirementCompatibility";
import {
  calendarYearsBefore,
  portalCarryoverCategoryIds,
  portalCarryoverLookbackYears,
} from "../../lib/carryover";
import { cappedCreditTotals } from "../../lib/cappedCredit";
import {
  isFloridaMentalHealthCycle,
  nextFloridaMentalHealthCycle,
  oppositeFloridaMentalHealthRuleSetId,
} from "../../lib/floridaMentalHealth";

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
const CFP_2027_CYCLE_START = "2027-04-01";
const CFP_PRE_2027_RULE_SET_ID = "cfp-professional-pre-2027-v1";
const CFP_2027_RULE_SET_ID = "cfp-professional-2027-v1";
const CFP_2027_GENERAL_CATEGORY_ID = "cfp-professional-2027-general";
const CFP_2027_ACTIVITY_TYPE_CATEGORY_IDS = new Set([
  "cfp-professional-2027-principal-topics",
  "cfp-professional-2027-practice-management",
  "cfp-professional-2027-ethics",
]);
const NJ_LCSW_RULE_SET_ID = "nj-lcsw-sample-v1";
const NJ_LCSW_CREDIT_CATEGORY_GROUP = "New Jersey LCSW credit category";
const ISC2_AUTOMATIC_RENEWAL_RULE_SET_PREFIX = "isc2-";
const COMPLIANCE_PERIOD_RULE_SET_PREFIXES = [
  "fl-insurance-producer-",
  "ny-professional-classroom-teacher-",
  "ny-professional-esol-bilingual-",
  "nj-employed-teacher-annual-pd-",
  "pa-professional-educator-act-48-",
] as const;
const NREMT_RULE_SET_PREFIX = "nremt-";
const TEXAS_LPC_RULE_SET_ID = "tx-lpc-standard-renewal-2026-v1";
const FLORIDA_INSURANCE_RULE_SET_PREFIX = "fl-insurance-producer-";
const FLORIDA_MENTAL_HEALTH_RULE_SET_PREFIX = "fl-lcsw-lmft-lmhc-";
const FLORIDA_MENTAL_HEALTH_CREDIT_BUCKET_GROUP =
  "Florida mental-health CE credit bucket";
const CARRYOVER_REVIEW_TASK_TITLES = new Map([
  [
    CFP_2027_RULE_SET_ID,
    "Confirm CFP Board carryover, then manually record only approved general CE",
  ],
  [
    "hrci-phr-2026-v1",
    "Confirm HRCI carryover in the portal, then record only posted General HR credits",
  ],
  [
    "hrci-sphr-2026-v1",
    "Confirm HRCI carryover in the portal, then record only posted General HR credits",
  ],
  [
    "shrm-cp-2026-v1",
    "Confirm SHRM carryover in the portal, then record only posted Advance Your Education PDCs",
  ],
  [
    "shrm-scp-2026-v1",
    "Confirm SHRM carryover in the portal, then record only posted Advance Your Education PDCs",
  ],
]);
const REQUIREMENT_INCOMPATIBILITY_VALUES_SQL =
  REQUIREMENT_INCOMPATIBILITIES.map(() => "(?, ?)").join(", ");
const REQUIREMENT_INCOMPATIBILITY_BINDINGS =
  REQUIREMENT_INCOMPATIBILITIES.flatMap(
    ({ categoryIds }) => categoryIds,
  );

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

async function createDraftStorageNamespace(userId: string) {
  const bytes = new TextEncoder().encode(
    `license-lantern:activity-draft:v1:${userId}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `draft_${hex}`;
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

type RequirementMatchInput = {
  requirementId: string;
  matchedUnits: number;
};

type NremtRequirementMetadata = {
  id: string;
  name: string;
  ruleCategoryId: string | null;
  relation: RequirementRelation;
  parentRequirementId: string | null;
  isActive: number;
  applicabilityStatus: ApplicabilityStatus;
  exclusiveGroup: string | null;
};

type NremtAllocationIssue = {
  code: string;
  message: string;
  unresolvedExclusiveGroups: string[];
};

function requirementMatchesField(
  payload: JsonRecord,
  options: { required?: boolean } = {},
) {
  const raw = payload.requirementMatches;
  if (raw === undefined || raw === null) {
    if (options.required) {
      throw new RequestError(
        "requirementMatches is required for National Registry credit.",
        409,
        "nremt_requirement_amounts_required",
      );
    }
    return [] as RequirementMatchInput[];
  }
  if (!Array.isArray(raw) || raw.length > 30) {
    throw new RequestError(
      "requirementMatches must be an array of up to 30 requirement amounts",
    );
  }
  if (options.required && raw.length === 0) {
    throw new RequestError(
      "Enter the National Registry component and topic credit amounts.",
      409,
      "nremt_requirement_amounts_required",
    );
  }
  const matches = raw.map((value, index) => {
    if (!isRecord(value)) {
      throw new RequestError(
        `requirementMatches[${index}] must be an object`,
      );
    }
    return {
      requirementId: textField(value, "requirementId", {
        required: true,
        max: 160,
      })!,
      matchedUnits: positiveNumber(value, "matchedUnits", {
        required: true,
      })!,
    };
  });
  if (
    new Set(matches.map((match) => match.requirementId)).size !==
    matches.length
  ) {
    throw new RequestError(
      "requirementMatches cannot contain duplicate requirementId values",
    );
  }
  return matches;
}

function unitsEqual(left: number, right: number) {
  return Math.abs(left - right) <= 0.001;
}

function nremtComponentRole(
  requirement: NremtRequirementMetadata,
): "national" | "local" | "individual" | null {
  if (
    requirement.relation !== "independent" ||
    !requirement.exclusiveGroup?.endsWith("-component") ||
    !requirement.ruleCategoryId
  ) {
    return null;
  }
  if (requirement.ruleCategoryId.endsWith("-national")) return "national";
  if (requirement.ruleCategoryId.endsWith("-local")) return "local";
  if (requirement.ruleCategoryId.endsWith("-individual")) return "individual";
  return null;
}

function nremtAllocationIssue(
  requirementsById: ReadonlyMap<string, NremtRequirementMetadata>,
  matches: readonly RequirementMatchInput[],
  allocatedUnits: number,
): NremtAllocationIssue | null {
  const activeRequirements = [...requirementsById.values()].filter(
    (requirement) =>
      Boolean(requirement.isActive) &&
      requirement.applicabilityStatus === "applies",
  );
  const componentRequirements = activeRequirements
    .map((requirement) => ({
      requirement,
      role: nremtComponentRole(requirement),
    }))
    .filter(
      (
        item,
      ): item is {
        requirement: NremtRequirementMetadata;
        role: "national" | "local" | "individual";
      } => item.role !== null,
    );
  const componentsByRole = new Map<
    "national" | "local" | "individual",
    NremtRequirementMetadata
  >();
  for (const { requirement, role } of componentRequirements) {
    componentsByRole.set(role, requirement);
  }
  const componentGroup =
    componentsByRole.get("national")?.exclusiveGroup ??
    componentsByRole.get("local")?.exclusiveGroup ??
    componentsByRole.get("individual")?.exclusiveGroup ??
    "National Registry component";
  const unresolvedExclusiveGroups = [componentGroup];
  const componentGroups = new Set(
    componentRequirements.map(
      ({ requirement }) => requirement.exclusiveGroup,
    ),
  );
  if (
    componentRequirements.length !== 3 ||
    componentsByRole.size !== 3 ||
    componentGroups.size !== 1
  ) {
    return {
      code: "nremt_current_template_required",
      message:
        "This credential does not contain the current National, Local/State, and Individual component structure. Create or roll into the current National Registry template.",
      unresolvedExclusiveGroups,
    };
  }
  const nationalRequirement = componentsByRole.get("national")!;
  const topicRequirements = activeRequirements.filter(
    (requirement) =>
      requirement.relation === "nested" &&
      requirement.parentRequirementId === nationalRequirement.id,
  );
  const requiredTopicSuffixes = [
    "-national-airway",
    "-national-cardiology",
    "-national-trauma",
    "-national-medical",
    "-national-operations",
  ];
  const topicSuffixes = new Set(
    topicRequirements.flatMap((requirement) => {
      const suffix = requiredTopicSuffixes.find((candidate) =>
        requirement.ruleCategoryId?.endsWith(candidate),
      );
      return suffix ? [suffix] : [];
    }),
  );
  const pediatricRequirements = activeRequirements.filter(
    (requirement) =>
      requirement.relation === "overlapping" &&
      requirement.ruleCategoryId?.endsWith("-national-pediatric"),
  );
  if (
    topicRequirements.length !== requiredTopicSuffixes.length ||
    topicSuffixes.size !== requiredTopicSuffixes.length ||
    pediatricRequirements.length !== 1
  ) {
    return {
      code: "nremt_current_template_required",
      message:
        "This credential does not contain the current five National topic minima and overlapping pediatric minimum. Create or roll into the current National Registry template.",
      unresolvedExclusiveGroups,
    };
  }

  const topicIds = new Set(topicRequirements.map((requirement) => requirement.id));
  const pediatricId = pediatricRequirements[0].id;
  const componentAmounts = {
    national: 0,
    local: 0,
    individual: 0,
  };
  let topicTotal = 0;
  let pediatricAmount = 0;
  for (const match of matches) {
    const requirement = requirementsById.get(match.requirementId);
    if (
      !requirement ||
      !Boolean(requirement.isActive) ||
      requirement.applicabilityStatus !== "applies" ||
      !Number.isFinite(match.matchedUnits) ||
      match.matchedUnits <= 0 ||
      match.matchedUnits > allocatedUnits + 0.001
    ) {
      return {
        code: "nremt_invalid_requirement_amount",
        message:
          "Each National Registry requirement amount must be positive, within the allocation, and belong to an active requirement on this credential.",
        unresolvedExclusiveGroups,
      };
    }
    const componentRole = nremtComponentRole(requirement);
    if (componentRole) {
      componentAmounts[componentRole] += match.matchedUnits;
    } else if (topicIds.has(requirement.id)) {
      topicTotal += match.matchedUnits;
    } else if (requirement.id === pediatricId) {
      pediatricAmount += match.matchedUnits;
    } else {
      return {
        code: "nremt_invalid_requirement_amount",
        message:
          "Use only the current National Registry component, National topic, and pediatric requirements for this allocation.",
        unresolvedExclusiveGroups,
      };
    }
  }

  const componentTotal =
    componentAmounts.national +
    componentAmounts.local +
    componentAmounts.individual;
  if (!unitsEqual(componentTotal, allocatedUnits)) {
    return {
      code: "nremt_component_amount_mismatch",
      message:
        "National, Local/State, and Individual amounts must add up exactly to the allocated credit.",
      unresolvedExclusiveGroups,
    };
  }
  if (!unitsEqual(topicTotal, componentAmounts.national)) {
    return {
      code: "nremt_national_topic_amount_mismatch",
      message:
        "National topic amounts must add up exactly to the National Component amount.",
      unresolvedExclusiveGroups,
    };
  }
  if (pediatricAmount > componentAmounts.national + 0.001) {
    return {
      code: "nremt_pediatric_amount_exceeds_national",
      message:
        "Overlapping pediatric credit cannot exceed the National Component amount for this allocation.",
      unresolvedExclusiveGroups,
    };
  }
  return null;
}

async function validateNremtRequirementMatches(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
  matches: readonly RequirementMatchInput[],
  allocatedUnits: number,
) {
  const requirements = await query(
    database,
    `SELECT
      requirement.id,
      requirement.name,
      requirement.rule_category_id AS ruleCategoryId,
      requirement.relation,
      requirement.parent_requirement_id AS parentRequirementId,
      requirement.is_active AS isActive,
      requirement.applicability_status AS applicabilityStatus,
      requirement.exclusive_group AS exclusiveGroup
    FROM credential_requirements requirement
    JOIN credentials credential ON credential.id = requirement.credential_id
    WHERE requirement.credential_id = ?
      AND credential.user_id = ?`,
    [credentialId, identity.userId],
  ).all<NremtRequirementMetadata>();
  const requirementsById = new Map(
    requirements.results.map((requirement) => [requirement.id, requirement]),
  );
  const issue = nremtAllocationIssue(
    requirementsById,
    matches,
    allocatedUnits,
  );
  if (issue) {
    throw new RequestError(issue.message, 409, issue.code);
  }
  return matches.map((match) => ({
    ...requirementsById.get(match.requirementId)!,
    matchedUnits: match.matchedUnits,
  }));
}

function assertNremtAcceptedEducation(
  payload: JsonRecord,
  provider: string,
) {
  if (!provider.trim()) {
    throw new RequestError(
      "Provider is required for National Registry education.",
      409,
      "nremt_provider_required",
    );
  }
  if (payload.acceptedEducationAttested !== true) {
    throw new RequestError(
      "Confirm that the provider and course are accepted by the National Registry and that every amount is post-cap credit shown or accepted in the dashboard.",
      409,
      "nremt_accepted_education_attestation_required",
    );
  }
}

async function isOwnedNremtCredential(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
) {
  const row = await query(
    database,
    `SELECT 1 AS isNremt
     FROM credentials
     WHERE id = ?
       AND user_id = ?
       AND rule_set_id LIKE 'nremt-%'`,
    [credentialId, identity.userId],
  ).first<{ isNremt: number }>();
  return Boolean(row?.isNremt);
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

function yearsAfter(isoDate: string, years: number) {
  const year = Number(isoDate.slice(0, 4)) + years;
  return `${String(year).padStart(4, "0")}${isoDate.slice(4)}`;
}

function isNremtRuleSet(ruleSetId: string | null) {
  return ruleSetId?.startsWith(NREMT_RULE_SET_PREFIX) ?? false;
}

function isNremtEmrRuleSet(ruleSetId: string | null) {
  return ruleSetId?.startsWith("nremt-emr-") ?? false;
}

function nremtMinimumDeadline(ruleSetId: string | null) {
  return isNremtEmrRuleSet(ruleSetId) ? "2026-09-30" : "2026-03-31";
}

function nremtActiveVerifier(ruleSetId: string | null) {
  return isNremtEmrRuleSet(ruleSetId) ||
    ruleSetId?.startsWith("nremt-emt-")
    ? "Training Officer"
    : "Medical Director";
}

function assertNremtCredentialDates(
  ruleSetId: string,
  deadline: string,
  payload: JsonRecord,
) {
  const isEmr = isNremtEmrRuleSet(ruleSetId);
  const requiredMonthDay = isEmr ? "09-30" : "03-31";
  const minimumDeadline = nremtMinimumDeadline(ruleSetId);
  if (deadline.slice(5) !== requiredMonthDay) {
    throw new RequestError(
      isEmr
        ? "National Registry EMR expiration must be September 30."
        : "National Registry EMT, AEMT, and Paramedic expiration must be March 31.",
      409,
      "nremt_fixed_deadline_required",
    );
  }
  if (deadline < minimumDeadline) {
    throw new RequestError(
      isEmr
        ? "The 2025 EMR NCCP template applies to September 30, 2026 or later expirations. Use the model assigned in the National Registry dashboard."
        : "The 2025 EMT, AEMT, and Paramedic NCCP templates apply to March 31, 2026 or later expirations. Use the model assigned in the National Registry dashboard.",
      409,
      "nremt_template_not_applicable",
    );
  }
  if (payload.officialDatesAttested !== true) {
    throw new RequestError(
      "Confirm that the National Registry dashboard assigns this 2025 NCCP model and shows the entered cycle start and fixed expiration date.",
      409,
      "nremt_model_dates_attestation_required",
    );
  }
}

function assertNremtSubmissionWindow(
  ruleSetId: string,
  deadline: string,
  submissionDate: string,
  payload: JsonRecord,
) {
  const deadlineYear = Number(deadline.slice(0, 4));
  const isEmr = isNremtEmrRuleSet(ruleSetId);
  const expectedMonthDay = isEmr ? "09-30" : "03-31";
  const minimumDeadline = nremtMinimumDeadline(ruleSetId);
  if (
    deadline.slice(5) !== expectedMonthDay ||
    deadline < minimumDeadline
  ) {
    throw new RequestError(
      "This credential does not use an applicable fixed National Registry expiration. Verify the assigned dashboard model and create a current-template credential.",
      409,
      "nremt_template_not_applicable",
    );
  }
  const windowStart = isEmr
    ? `${deadlineYear}-04-01`
    : `${deadlineYear - 1}-10-01`;
  const reinstatementEnd = isEmr
    ? `${deadlineYear}-10-31`
    : `${deadlineYear}-04-30`;
  if (submissionDate < windowStart) {
    throw new RequestError(
      `The National Registry continuing-education application window opens ${windowStart}.`,
      409,
      "nremt_submission_window_not_open",
    );
  }
  if (submissionDate > reinstatementEnd) {
    throw new RequestError(
      `The National Registry late reinstatement window closed ${reinstatementEnd}.`,
      409,
      "nremt_reinstatement_window_closed",
    );
  }
  if (
    submissionDate > deadline &&
    payload.lateReinstatementAttested !== true
  ) {
    throw new RequestError(
      `This is a late reinstatement application. Confirm that every continuing-education credit was completed by ${deadline}; education completed after expiration is not accepted, and reinstatement is not guaranteed.`,
      409,
      "nremt_late_reinstatement_attestation_required",
    );
  }
}

function assertFloridaMentalHealthCredentialDates(
  cycleStart: string,
  deadline: string,
  payload: JsonRecord,
) {
  if (!isFloridaMentalHealthCycle(cycleStart, deadline)) {
    throw new RequestError(
      "A standard Florida mental-health biennium must run from April 1 of an odd year through March 31 two years later. Use the exact CE Broker period, or create a custom plan for a nonstandard period.",
      409,
      "florida_mental_health_cycle_invalid",
    );
  }
  if (payload.officialDatesAttested !== true) {
    throw new RequestError(
      "Confirm that CE Broker shows the selected alternating phase and the entered biennium dates.",
      409,
      "florida_mental_health_dates_attestation_required",
    );
  }
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
  return ruleSetId?.startsWith(ISC2_AUTOMATIC_RENEWAL_RULE_SET_PREFIX) ?? false;
}

function nextTemplateFamily(ruleSetId: string | null) {
  if (ruleSetId?.startsWith(FLORIDA_INSURANCE_RULE_SET_PREFIX)) {
    return "florida_insurance" as const;
  }
  if (ruleSetId?.startsWith(FLORIDA_MENTAL_HEALTH_RULE_SET_PREFIX)) {
    return "florida_mental_health" as const;
  }
  return null;
}

function renewalTaskSpecs(
  ruleSetId: string | null,
  deadline: string,
  reviewTitle?: string | null,
) {
  if (isIsc2AutomaticRenewalRuleSet(ruleSetId)) {
    return [
      {
        title:
          reviewTitle ??
          "Confirm ISC2 dashboard dates, eligible Group A rollover, and annual maintenance fee",
        kind: "review",
        dueDate: daysBefore(deadline, 120),
      },
      {
        title: "Submit required ISC2 CPEs and keep annual maintenance fees current",
        kind: "progress",
        dueDate: daysBefore(deadline, 30),
      },
      {
        title: "Save an attested ISC2 requirements checkpoint",
        kind: "submission",
        dueDate: deadline,
      },
    ];
  }
  if (ruleSetId?.startsWith(NREMT_RULE_SET_PREFIX)) {
    const verifier = nremtActiveVerifier(ruleSetId);
    const submissionWindow = isNremtEmrRuleSet(ruleSetId)
      ? "April 1 through September 30; late reinstatement is October 1-31 only when all education was complete by September 30"
      : "October 1 through March 31; late reinstatement is April 1-30 only when all education was complete by March 31";
    return [
      {
        title:
          reviewTitle ??
          `Confirm dashboard dates, the assigned NCCP model, Local/State topics, and active ${verifier} verification or inactive status`,
        kind: "review",
        dueDate: daysBefore(deadline, 120),
      },
      {
        title:
          "Classify accepted credits as National, Local/State, or Individual; verify post-cap amounts and split National credit across topics, including pediatric overlap",
        kind: "progress",
        dueDate: daysBefore(deadline, 30),
      },
      {
        title:
          `Submit in the National Registry CE window (${submissionWindow}) and save dashboard approval`,
        kind: "submission",
        dueDate: deadline,
      },
    ];
  }
  if (ruleSetId === TEXAS_LPC_RULE_SET_ID) {
    return [
      {
        title:
          reviewTitle ??
          "Confirm the official license period, supervisor status, and any CE Broker-supported carryover",
        kind: "review",
        dueDate: daysBefore(deadline, 120),
      },
      {
        title:
          "Complete the required CE and pass the Texas jurisprudence examination",
        kind: "progress",
        dueDate: daysBefore(deadline, 30),
      },
      {
        title: "Submit the LPC renewal and save CE Broker confirmation",
        kind: "submission",
        dueDate: deadline,
      },
    ];
  }
  if (ruleSetId === "ca-child-development-permit-2026-v1") {
    return [
      {
        title:
          "Confirm CTC validity dates, permit level, and the professional-growth plan with your advisor",
        kind: "review",
        dueDate: daysBefore(deadline, 120),
      },
      {
        title:
          "Complete and document advisor-approved professional growth",
        kind: "progress",
        dueDate: daysBefore(deadline, 30),
      },
      {
        title:
          "Submit the permit renewal and self-verification, then save the receipt",
        kind: "submission",
        dueDate: deadline,
      },
    ];
  }
  if (ruleSetId === "tx-standard-classroom-teacher-2026-v1") {
    return [
      {
        title:
          "Confirm ECOS dates, approved providers, and required disabilities and dyslexia training",
        kind: "review",
        dueDate: daysBefore(deadline, 120),
      },
      {
        title:
          "Complete approved CPE and classify every capped activity type",
        kind: "progress",
        dueDate: daysBefore(deadline, 30),
      },
      {
        title: "Renew and attest in TEAL/ECOS, then save confirmation",
        kind: "submission",
        dueDate: deadline,
      },
    ];
  }
  if (
    ruleSetId ===
      "ny-professional-classroom-teacher-standard-ctle-2026-v1" ||
    ruleSetId === "ny-professional-esol-bilingual-ctle-2026-v1"
  ) {
    return [
      {
        title:
          "Confirm TEACH registration dates, practiced years, and any language-acquisition waiver",
        kind: "review",
        dueDate: daysBefore(deadline, 120),
      },
      {
        title:
          "Complete sponsor-approved CTLE and the applicable language-acquisition hours",
        kind: "progress",
        dueDate: daysBefore(deadline, 30),
      },
      {
        title:
          "Attest and re-register in TEACH, then save the official CTLE record",
        kind: "submission",
        dueDate: deadline,
      },
    ];
  }
  if (ruleSetId === "ny-lmsw-lcsw-standard-registration-2026-v1") {
    return [
      {
        title:
          "Confirm NYSED registration dates, initial-period status, and child-abuse training",
        kind: "review",
        dueDate: daysBefore(deadline, 120),
      },
      {
        title:
          "Complete the updated NYSED child-abuse curriculum and 15-minute addendum by November 17, 2026 if not already documented",
        kind: "progress",
        dueDate:
          deadline < "2026-11-17" ? deadline : "2026-11-17",
      },
      {
        title:
          "Complete approved CE, including boundaries, and classify self-study",
        kind: "progress",
        dueDate: daysBefore(deadline, 30),
      },
      {
        title: "Re-register with NYSED and save the official confirmation",
        kind: "submission",
        dueDate: deadline,
      },
    ];
  }
  if (ruleSetId === "pa-lpc-standard-renewal-2026-v1") {
    return [
      {
        title:
          "Confirm the PALS biennium, full-cycle status, and electronically reported Act 31 training",
        kind: "review",
        dueDate: daysBefore(deadline, 120),
      },
      {
        title:
          "Complete approved CE, including ethics, Act 31 child-abuse training, and suicide prevention",
        kind: "progress",
        dueDate: daysBefore(deadline, 30),
      },
      {
        title:
          "Renew in PALS and save the receipt plus the Act 31 provider record",
        kind: "submission",
        dueDate: deadline,
      },
    ];
  }
  if (ruleSetId?.startsWith(FLORIDA_MENTAL_HEALTH_RULE_SET_PREFIX)) {
    return [
      {
        title:
          "Confirm the CE Broker phase, every-third-biennium topics, and supervisor status",
        kind: "review",
        dueDate: daysBefore(deadline, 120),
      },
      {
        title:
          "Complete and report the three separate Florida credit buckets",
        kind: "progress",
        dueDate: daysBefore(deadline, 30),
      },
      {
        title: "Submit the Florida renewal and save CE Broker confirmation",
        kind: "submission",
        dueDate: deadline,
      },
    ];
  }
  if (ruleSetId === "nj-employed-teacher-annual-pd-2026-v1") {
    return [
      {
        title:
          "Confirm the annual PDP, supervisor-approved scope, and role-specific rolling duties",
        kind: "review",
        dueDate: daysBefore(deadline, 120),
      },
      {
        title: "Complete and document supervisor-approved PDP learning",
        kind: "progress",
        dueDate: daysBefore(deadline, 30),
      },
      {
        title:
          "Track role-specific foundational-literacy and other rolling New Jersey professional-development duties",
        kind: "progress",
        dueDate: daysBefore(deadline, 30),
      },
      {
        title:
          "Verify annual PDP completion with the employer and save the record",
        kind: "submission",
        dueDate: deadline,
      },
    ];
  }
  if (ruleSetId === "pa-professional-educator-act-48-2026-v1") {
    return [
      {
        title:
          "Confirm the PERMS period, posted carryover, and any Act 126 duty",
        kind: "review",
        dueDate: daysBefore(deadline, 120),
      },
      {
        title: "Complete PDE-approved Act 48 learning and verify PERMS posts it",
        kind: "progress",
        dueDate: daysBefore(deadline, 30),
      },
      {
        title:
          "Review and maintain the employer’s separate annual Act 55 school-safety records; this one reminder does not certify each covered school year",
        kind: "review",
        dueDate: daysBefore(deadline, 120),
      },
      {
        title:
          "Before the 2028–29 school year, confirm Act 47 coverage and the official local start date, then complete the PDE-approved structured-literacy program if required",
        kind: "review",
        dueDate:
          deadline < "2028-07-01" ? deadline : "2028-07-01",
      },
      {
        title:
          "Verify active Act 48 status in PERMS and save the official record",
        kind: "submission",
        dueDate: deadline,
      },
    ];
  }
  if (isCompliancePeriodRuleSet(ruleSetId)) {
    return [
      {
        title:
          reviewTitle ??
          "Confirm the official compliance-period requirements and dates",
        kind: "review",
        dueDate: daysBefore(deadline, 120),
      },
      {
        title: "Complete and document required education",
        kind: "progress",
        dueDate: daysBefore(deadline, 30),
      },
      {
        title: "Verify official compliance status and save portal proof",
        kind: "submission",
        dueDate: deadline,
      },
    ];
  }
  return [
    {
      title: reviewTitle ?? "Review the renewal requirements",
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
  "renewal_checkpoint_recorded",
  "compliance_checkpoint_recorded",
  "renewal_accepted",
  "compliance_period_completed",
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
      title: "Confirm the next official cycle",
      description:
        "Confirm an issuer or authority’s official next-period record for one ready cycle.",
      target: 1,
      progress: progressFor(
        "renewal_accepted",
        "compliance_period_completed",
      ),
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
      const isCompliancePeriod = isCompliancePeriodRuleSet(
        cycle.ruleSetId,
      );
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
      const isIsc2Checkpoint = isIsc2AutomaticRenewalRuleSet(
        cycle.ruleSetId,
      );
      const isComplianceCheckpoint = isCompliancePeriodRuleSet(
        cycle.ruleSetId,
      );
      const ordinaryFollowUp = daysAfter(
        cycle.submittedAt.slice(0, 10),
        7,
      );
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
  type RequiredMaximumGroupRow = {
    exclusiveGroup: string;
  };
  const getRequiredMaximumGroups = () =>
    query(
      database,
      `SELECT DISTINCT
        requirement.exclusive_group AS exclusiveGroup
      FROM credential_requirements requirement
      JOIN credentials credential
        ON credential.id = requirement.credential_id
      WHERE requirement.credential_id = ?
        AND credential.user_id = ?
        AND requirement.is_active = 1
        AND requirement.applicability_status = 'applies'
        AND requirement.exclusive_group IS NOT NULL
        AND (
          (
            requirement.kind = 'maximum'
            AND (
              credential.status = 'active'
              OR credential.rule_set_id = ?
              OR EXISTS (
                SELECT 1
                FROM credential_requirements complete_group
                WHERE complete_group.credential_id =
                  requirement.credential_id
                  AND complete_group.kind = 'informational'
                  AND complete_group.is_active = 1
                  AND complete_group.applicability_status = 'applies'
                  AND complete_group.exclusive_group =
                    requirement.exclusive_group
              )
            )
          )
          OR (
            credential.rule_set_id LIKE 'nremt-%'
            AND credential.status IN ('active', 'submitted')
            AND requirement.kind = 'minimum'
          )
          OR (
            credential.rule_set_id LIKE 'fl-lcsw-lmft-lmhc-%'
            AND credential.status IN ('active', 'submitted')
            AND requirement.kind = 'minimum'
            AND requirement.exclusive_group = ?
          )
        )
      ORDER BY requirement.exclusive_group`,
      [
        credentialId,
        identity.userId,
        CFP_2027_RULE_SET_ID,
        FLORIDA_MENTAL_HEALTH_CREDIT_BUCKET_GROUP,
      ],
    ).all<RequiredMaximumGroupRow>();
  const credential = await query(
    database,
    `SELECT rule_set_id AS ruleSetId
     FROM credentials
     WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ ruleSetId: string | null }>();
  if (requirementIds.length === 0) {
    if (credential?.ruleSetId === CFP_2027_RULE_SET_ID) {
      throw new RequestError(
        "Classify every CFP CE activity as Principal Topics, Practice Management, or Ethics. General CE cannot be left unclassified.",
        409,
        "cfp_activity_type_required",
      );
    }
    if (credential?.ruleSetId === NJ_LCSW_RULE_SET_ID) {
      throw new RequestError(
        "Choose exactly one New Jersey LCSW credit category—General Social Work, Clinical Practice, Ethics, or Social and Cultural Competence—for every credited time block.",
        409,
        "nj_lcsw_credit_category_required",
      );
    }
    const requiredMaximumGroups = await getRequiredMaximumGroups();
    const missingGroup = requiredMaximumGroups.results[0]?.exclusiveGroup;
    if (missingGroup) {
      if (credential?.ruleSetId?.startsWith(NREMT_RULE_SET_PREFIX)) {
        throw new RequestError(
          "Classify every National Registry credit as National, Local/State, or Individual.",
          409,
          "nremt_component_required",
        );
      }
      if (
        missingGroup === FLORIDA_MENTAL_HEALTH_CREDIT_BUCKET_GROUP
      ) {
        throw new RequestError(
          "Choose exactly one Florida credit bucket—General CE, Prevention of Medical Errors, or the current Ethics and Boundaries or Telehealth phase—for every credited time block.",
          409,
          "florida_mental_health_credit_bucket_required",
        );
      }
      throw new RequestError(
        `Choose one ${missingGroup} option for this activity so capped credit can be counted safely.`,
        409,
        "maximum_classification_required",
      );
    }
    return [];
  }
  type RequirementTagRow = {
    id: string;
    name: string;
    ruleCategoryId: string | null;
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
      requirement.rule_category_id AS ruleCategoryId,
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
  const selectedRequirements = requirementIds.map(
    (requirementId) => byId.get(requirementId)!,
  );
  if (
    selectedRequirements.some(
      (requirement) =>
        requirement.ruleCategoryId === CFP_2027_GENERAL_CATEGORY_ID ||
        (requirement.ruleCategoryId?.startsWith("cfp-professional-2027-") &&
          !CFP_2027_ACTIVITY_TYPE_CATEGORY_IDS.has(
            requirement.ruleCategoryId,
          )),
    )
  ) {
    throw new RequestError(
      "Classify every CFP CE activity as Principal Topics, Practice Management, or Ethics. Tagging the General CE parent directly is not allowed.",
      409,
      "cfp_activity_type_required",
    );
  }
  const incompatibility = findRequirementIncompatibility(selectedRequirements);
  if (incompatibility) {
    throw new RequestError(
      incompatibility.incompatibility.message,
      409,
      "incompatible_requirement_conflict",
    );
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
  if (
    credential?.ruleSetId === NJ_LCSW_RULE_SET_ID &&
    !selectedExclusiveGroups.has(NJ_LCSW_CREDIT_CATEGORY_GROUP)
  ) {
    throw new RequestError(
      "Choose exactly one New Jersey LCSW credit category—General Social Work, Clinical Practice, Ethics, or Social and Cultural Competence—for every credited time block.",
      409,
      "nj_lcsw_credit_category_required",
    );
  }
  const requiredMaximumGroups = await getRequiredMaximumGroups();
  const missingGroup = requiredMaximumGroups.results.find(
    (group) => !selectedExclusiveGroups.has(group.exclusiveGroup),
  )?.exclusiveGroup;
  if (missingGroup) {
    if (credential?.ruleSetId?.startsWith(NREMT_RULE_SET_PREFIX)) {
      throw new RequestError(
        "Classify every National Registry credit as National, Local/State, or Individual.",
        409,
        "nremt_component_required",
      );
    }
    if (
      missingGroup === FLORIDA_MENTAL_HEALTH_CREDIT_BUCKET_GROUP
    ) {
      throw new RequestError(
        "Choose exactly one Florida credit bucket—General CE, Prevention of Medical Errors, or the current Ethics and Boundaries or Telehealth phase—for every credited time block.",
        409,
        "florida_mental_health_credit_bucket_required",
      );
    }
    throw new RequestError(
      `Choose one ${missingGroup} option for this activity so capped credit can be counted safely.`,
      409,
      "maximum_classification_required",
    );
  }
  return selectedRequirements;
}

function assertActivityDateAllowedForRequirements(
  completionDate: string,
  cycleStart: string,
  deadline: string,
  selectedRequirements: Array<{ ruleCategoryId: string | null }>,
  options: {
    portalCarryoverAttested: boolean;
    evidenceStatus: string;
  },
) {
  if (completionDate > deadline) {
    throw new RequestError(
      `The activity date must not be after the target renewal deadline (${deadline}).`,
      409,
      "activity_outside_cycle",
    );
  }
  const policies = selectedRequirements.map((requirement) =>
    portalCarryoverLookbackYears(requirement.ruleCategoryId),
  );
  const carryoverSelectionCount = policies.filter(
    (lookbackYears) => lookbackYears !== null,
  ).length;
  if (
    carryoverSelectionCount > 0 &&
    carryoverSelectionCount !== selectedRequirements.length
  ) {
    throw new RequestError(
      "A portal-confirmed carryover entry cannot be mixed with current-period requirement tags.",
      409,
      "mixed_carryover_requirement_tags",
    );
  }
  if (carryoverSelectionCount === 0) {
    if (completionDate >= cycleStart) return;
    throw new RequestError(
      `The activity date must fall within the target renewal cycle (${cycleStart} through ${deadline}). A prior-period date is allowed only when every selected requirement is a portal-confirmed carryover category.`,
      409,
      "activity_outside_cycle",
    );
  }
  if (completionDate >= cycleStart) {
    throw new RequestError(
      "Portal-confirmed carryover must use the actual eligible prior-period completion date, not a date inside the current cycle.",
      409,
      "carryover_requires_prior_period_date",
    );
  }
  const earliestEligibleDate = policies.reduce(
    (latest, lookbackYears) => {
      const candidate = calendarYearsBefore(
        cycleStart,
        lookbackYears!,
      );
      return candidate > latest ? candidate : latest;
    },
    "0000-01-01",
  );
  if (completionDate < earliestEligibleDate) {
    throw new RequestError(
      `This portal-confirmed carryover must have been earned between ${earliestEligibleDate} and ${daysBefore(cycleStart, 1)}. Use the actual prior-period date and only the amount posted for this consecutive cycle.`,
      409,
      "carryover_outside_eligible_lookback",
    );
  }
  if (!options.portalCarryoverAttested) {
    throw new RequestError(
      "Confirm that the issuing portal posted this carryover into the current consecutive period before saving the prior-period activity.",
      409,
      "portal_carryover_attestation_required",
    );
  }
  if (options.evidenceStatus === "not_required") {
    throw new RequestError(
      "Portal-confirmed carryover requires a portal reference or uploaded proof before the cycle can be completed.",
      409,
      "portal_carryover_evidence_required",
    );
  }
}

async function assertPortalCarryoverEvidenceReady(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
) {
  const carryoverCategoryIds = portalCarryoverCategoryIds();
  const placeholders = carryoverCategoryIds.map(() => "?").join(", ");
  const missingEvidence = await query(
    database,
    `SELECT activity.id
     FROM activity_allocations allocation
     JOIN activities activity ON activity.id = allocation.activity_id
     JOIN credentials credential ON credential.id = allocation.credential_id
     JOIN activity_requirement_matches match
       ON match.allocation_id = allocation.id
       AND match.user_id = activity.user_id
     JOIN credential_requirements requirement
       ON requirement.id = match.requirement_id
       AND requirement.credential_id = credential.id
     WHERE allocation.credential_id = ?
       AND activity.user_id = ?
       AND credential.user_id = activity.user_id
       AND activity.completion_date < credential.cycle_start
       AND requirement.rule_category_id IN (${placeholders})
       AND COALESCE(TRIM(activity.evidence_reference), '') = ''
       AND NOT EXISTS (
         SELECT 1
         FROM evidence_files evidence
         WHERE evidence.activity_id = activity.id
           AND evidence.user_id = activity.user_id
           AND evidence.status = 'ready'
       )
     LIMIT 1`,
    [
      credentialId,
      identity.userId,
      ...carryoverCategoryIds,
    ],
  ).first<{ id: string }>();
  if (missingEvidence) {
    throw new RequestError(
      "Add the issuing portal reference or upload the portal record for every prior-period carryover activity before completing this cycle.",
      409,
      "portal_carryover_evidence_required",
    );
  }
}

async function findUnresolvedNremtClassification(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
) {
  const [requirementResult, allocationResult, matchResult] =
    await Promise.all([
      query(
        database,
        `SELECT
          requirement.id,
          requirement.name,
          requirement.rule_category_id AS ruleCategoryId,
          requirement.relation,
          requirement.parent_requirement_id AS parentRequirementId,
          requirement.is_active AS isActive,
          requirement.applicability_status AS applicabilityStatus,
          requirement.exclusive_group AS exclusiveGroup
        FROM credential_requirements requirement
        JOIN credentials credential
          ON credential.id = requirement.credential_id
        WHERE requirement.credential_id = ?
          AND credential.user_id = ?`,
        [credentialId, identity.userId],
      ).all<NremtRequirementMetadata>(),
      query(
        database,
        `SELECT
           allocation.id,
           allocation.allocated_units AS allocatedUnits
         FROM activity_allocations allocation
         JOIN activities activity ON activity.id = allocation.activity_id
         JOIN credentials credential
           ON credential.id = allocation.credential_id
         WHERE allocation.credential_id = ?
           AND activity.user_id = ?
           AND credential.user_id = ?`,
        [credentialId, identity.userId, identity.userId],
      ).all<{ id: string; allocatedUnits: number }>(),
      query(
        database,
        `SELECT
          match.allocation_id AS allocationId,
          match.requirement_id AS requirementId,
          match.matched_units AS matchedUnits
         FROM activity_requirement_matches match
         JOIN activity_allocations allocation
           ON allocation.id = match.allocation_id
         JOIN activities activity ON activity.id = allocation.activity_id
         JOIN credentials credential
           ON credential.id = allocation.credential_id
         WHERE allocation.credential_id = ?
           AND match.user_id = ?
           AND activity.user_id = match.user_id
           AND credential.user_id = match.user_id`,
        [credentialId, identity.userId],
      ).all<{
        allocationId: string;
        requirementId: string;
        matchedUnits: number;
      }>(),
    ]);
  const requirementsById = new Map(
    requirementResult.results.map((requirement) => [
      requirement.id,
      requirement,
    ]),
  );
  const matchesByAllocation = new Map<string, RequirementMatchInput[]>();
  for (const match of matchResult.results) {
    const matches = matchesByAllocation.get(match.allocationId) ?? [];
    matches.push({
      requirementId: match.requirementId,
      matchedUnits: Number(match.matchedUnits),
    });
    matchesByAllocation.set(match.allocationId, matches);
  }
  for (const allocation of allocationResult.results) {
    const matches = matchesByAllocation.get(allocation.id) ?? [];
    const issue = nremtAllocationIssue(
      requirementsById,
      matches,
      Number(allocation.allocatedUnits),
    );
    if (issue) {
      return {
        allocationId: allocation.id,
        unresolvedExclusiveGroups: issue.unresolvedExclusiveGroups,
        classificationMessage: issue.message,
      };
    }
  }
  return null;
}

async function findUnresolvedCredentialClassification(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
  ruleSetId: string | null,
) {
  if (isNremtRuleSet(ruleSetId)) {
    return findUnresolvedNremtClassification(
      database,
      identity,
      credentialId,
    );
  }
  type ClassificationRequirementRow = {
    id: string;
    name: string;
    ruleCategoryId: string | null;
    kind: RequirementKind;
    isActive: number;
    applicabilityStatus: ApplicabilityStatus;
    exclusiveGroup: string | null;
  };
  type ClassificationAllocationRow = {
    id: string;
  };
  type ClassificationMatchRow = {
    allocationId: string;
    requirementId: string;
  };
  const [requirementResult, allocationResult, matchResult] =
    await Promise.all([
      query(
        database,
        `SELECT
          requirement.id,
          requirement.name,
          requirement.rule_category_id AS ruleCategoryId,
          requirement.kind,
          requirement.is_active AS isActive,
          requirement.applicability_status AS applicabilityStatus,
          requirement.exclusive_group AS exclusiveGroup
        FROM credential_requirements requirement
        JOIN credentials credential
          ON credential.id = requirement.credential_id
        WHERE requirement.credential_id = ?
          AND credential.user_id = ?`,
        [credentialId, identity.userId],
      ).all<ClassificationRequirementRow>(),
      query(
        database,
        `SELECT allocation.id
         FROM activity_allocations allocation
         JOIN activities activity ON activity.id = allocation.activity_id
         JOIN credentials credential
           ON credential.id = allocation.credential_id
         WHERE allocation.credential_id = ?
           AND activity.user_id = ?
           AND credential.user_id = ?`,
        [credentialId, identity.userId, identity.userId],
      ).all<ClassificationAllocationRow>(),
      query(
        database,
        `SELECT
          match.allocation_id AS allocationId,
          match.requirement_id AS requirementId
         FROM activity_requirement_matches match
         JOIN activity_allocations allocation
           ON allocation.id = match.allocation_id
         JOIN activities activity ON activity.id = allocation.activity_id
         JOIN credentials credential
           ON credential.id = allocation.credential_id
         WHERE allocation.credential_id = ?
           AND match.user_id = ?
           AND activity.user_id = match.user_id
           AND credential.user_id = match.user_id`,
        [credentialId, identity.userId],
      ).all<ClassificationMatchRow>(),
    ]);
  const activeRequirements = requirementResult.results.filter(
    (requirement) =>
      Boolean(requirement.isActive) &&
      requirement.applicabilityStatus === "applies",
  );
  const requirementsById = new Map(
    activeRequirements.map((requirement) => [requirement.id, requirement]),
  );
  const completeClassificationGroups = new Set(
    activeRequirements
      .filter(
        (requirement) =>
          requirement.kind === "informational" &&
          requirement.exclusiveGroup,
      )
      .map((requirement) => requirement.exclusiveGroup!),
  );
  const requiredGroups = new Set(
    activeRequirements
      .filter(
        (requirement) =>
          requirement.kind === "maximum" &&
          requirement.exclusiveGroup &&
          (ruleSetId === CFP_2027_RULE_SET_ID ||
            completeClassificationGroups.has(requirement.exclusiveGroup)),
      )
      .map((requirement) => requirement.exclusiveGroup!),
  );
  if (ruleSetId === NJ_LCSW_RULE_SET_ID) {
    requiredGroups.add(NJ_LCSW_CREDIT_CATEGORY_GROUP);
  }
  if (
    ruleSetId?.startsWith(FLORIDA_MENTAL_HEALTH_RULE_SET_PREFIX)
  ) {
    requiredGroups.add(
      FLORIDA_MENTAL_HEALTH_CREDIT_BUCKET_GROUP,
    );
  }
  const matchesByAllocation = new Map<
    string,
    ClassificationRequirementRow[]
  >();
  for (const match of matchResult.results) {
    const requirement = requirementsById.get(match.requirementId);
    if (!requirement) continue;
    const matches = matchesByAllocation.get(match.allocationId) ?? [];
    matches.push(requirement);
    matchesByAllocation.set(match.allocationId, matches);
  }
  for (const allocation of allocationResult.results) {
    const matches = matchesByAllocation.get(allocation.id) ?? [];
    const selectedGroupCounts = new Map<string, number>();
    for (const requirement of matches) {
      if (!requirement.exclusiveGroup) continue;
      selectedGroupCounts.set(
        requirement.exclusiveGroup,
        (selectedGroupCounts.get(requirement.exclusiveGroup) ?? 0) + 1,
      );
    }
    const unresolvedExclusiveGroups = [...requiredGroups].filter(
      (group) => (selectedGroupCounts.get(group) ?? 0) !== 1,
    );
    const incompatibility = findRequirementIncompatibility(matches);
    if (unresolvedExclusiveGroups.length > 0 || incompatibility) {
      return {
        allocationId: allocation.id,
        unresolvedExclusiveGroups,
        classificationMessage:
          incompatibility?.incompatibility.message ?? null,
      };
    }
  }
  return null;
}

async function assertNremtSubmissionComplete(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
  ruleSetId: string,
  deadline: string,
  submissionDate: string,
) {
  const unresolvedClassification =
    await findUnresolvedCredentialClassification(
      database,
      identity,
      credentialId,
      ruleSetId,
    );
  if (unresolvedClassification) {
    throw new RequestError(
      unresolvedClassification.classificationMessage ??
        "Every National Registry allocation must have complete component and topic amounts.",
      409,
      "nremt_classification_incomplete",
    );
  }
  const [total, requirementProgress] = await Promise.all([
    query(
      database,
      `SELECT
        credential.total_required AS totalRequired,
        COALESCE(SUM(allocation.allocated_units), 0) AS totalEarned,
        MAX(activity.completion_date) AS latestCompletionDate,
        COALESCE(
          SUM(
            CASE
              WHEN activity.completion_date > credential.deadline THEN 1
              ELSE 0
            END
          ),
          0
        ) AS postDeadlineActivityCount
      FROM credentials credential
      LEFT JOIN activity_allocations allocation
        ON allocation.credential_id = credential.id
      LEFT JOIN activities activity
        ON activity.id = allocation.activity_id
        AND activity.user_id = credential.user_id
      WHERE credential.id = ? AND credential.user_id = ?
      GROUP BY credential.id`,
      [credentialId, identity.userId],
    ).first<{
      totalRequired: number;
      totalEarned: number;
      latestCompletionDate: string | null;
      postDeadlineActivityCount: number;
    }>(),
    query(
      database,
      `SELECT
        requirement.name,
        requirement.required_units AS requiredUnits,
        COALESCE(
          SUM(
            MIN(
              match.matched_units,
              allocation.allocated_units,
              activity.total_units
            )
          ),
          0
        ) AS earnedUnits
      FROM credential_requirements requirement
      JOIN credentials credential
        ON credential.id = requirement.credential_id
      LEFT JOIN activity_requirement_matches match
        ON match.requirement_id = requirement.id
        AND match.user_id = credential.user_id
      LEFT JOIN activity_allocations allocation
        ON allocation.id = match.allocation_id
        AND allocation.credential_id = credential.id
      LEFT JOIN activities activity
        ON activity.id = allocation.activity_id
        AND activity.user_id = credential.user_id
      WHERE requirement.credential_id = ?
        AND credential.user_id = ?
        AND requirement.kind = 'minimum'
        AND requirement.is_active = 1
        AND requirement.applicability_status = 'applies'
      GROUP BY requirement.id
      ORDER BY requirement.sort_order, requirement.name`,
      [credentialId, identity.userId],
    ).all<{
      name: string;
      requiredUnits: number;
      earnedUnits: number;
    }>(),
  ]);
  if (!total) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  if (Number(total.postDeadlineActivityCount) > 0) {
    throw new RequestError(
      `National Registry education must be completed by the ${deadline} expiration cutoff, including during late reinstatement.`,
      409,
      "nremt_completion_after_expiration",
    );
  }
  if (
    total.latestCompletionDate &&
    total.latestCompletionDate > submissionDate
  ) {
    throw new RequestError(
      "The application date cannot be before the latest credited activity.",
      409,
      "nremt_submission_before_completion",
    );
  }
  if (
    Number(total.totalEarned) + 0.001 <
    Number(total.totalRequired)
  ) {
    throw new RequestError(
      `License Lantern records ${Number(total.totalEarned)} of ${Number(total.totalRequired)} required National Registry credits. Complete the local total before submitting.`,
      409,
      "nremt_total_incomplete",
    );
  }
  const incompleteRequirements = requirementProgress.results.filter(
    (requirement) =>
      Number(requirement.earnedUnits) + 0.001 <
      Number(requirement.requiredUnits),
  );
  if (incompleteRequirements.length > 0) {
    throw new RequestError(
      `Complete every National Registry component, National topic, and pediatric minimum before submitting. Still incomplete: ${incompleteRequirements
        .map(
          (requirement) =>
            `${requirement.name} (${Number(requirement.earnedUnits)}/${Number(requirement.requiredUnits)})`,
        )
        .join(", ")}.`,
      409,
      "nremt_requirement_incomplete",
    );
  }
}

async function assertCredentialStillMutable(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
  message: string,
) {
  const credential = await query(
    database,
    `SELECT status FROM credentials WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ status: string }>();
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  if (!["active", "submitted"].includes(credential.status)) {
    throw new RequestError(message, 409, "cycle_closed");
  }
}

async function rethrowClosedCycleWrite(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
  message: string,
  error: unknown,
): Promise<never> {
  await assertCredentialStillMutable(
    database,
    identity,
    credentialId,
    message,
  );
  throw error;
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
    ruleSetId: string | null;
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
    ruleCategoryId: string | null;
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
        c.rule_set_id AS ruleSetId,
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
        req.rule_category_id AS ruleCategoryId,
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
  type ClassificationIssue = {
    allocationId: string;
    activityId: string;
    activityTitle: string;
    unresolvedExclusiveGroups: string[];
    allocatedUnits: number;
    classificationMessage?: string;
  };
  const matchesByAllocation = new Map<string, ActivityMatchRow[]>();
  const selectedGroupCountsByAllocation = new Map<
    string,
    Map<string, number>
  >();
  for (const match of activityMatchResult.results) {
    const normalizedMatch = {
      ...match,
      matchedUnits: Number(match.matchedUnits),
    };
    const existing = matchesByAllocation.get(match.allocationId) ?? [];
    existing.push(normalizedMatch);
    matchesByAllocation.set(match.allocationId, existing);

    const requirement = requirementMetadataById.get(match.requirementId);
    if (
      !requirement?.exclusiveGroup ||
      !Boolean(requirement.isActive) ||
      requirement.applicabilityStatus !== "applies"
    ) {
      continue;
    }
    const groupCounts =
      selectedGroupCountsByAllocation.get(match.allocationId) ??
      new Map<string, number>();
    groupCounts.set(
      requirement.exclusiveGroup,
      (groupCounts.get(requirement.exclusiveGroup) ?? 0) + 1,
    );
    selectedGroupCountsByAllocation.set(match.allocationId, groupCounts);
  }
  const requiredMaximumGroupsByCredential = new Map<string, Set<string>>();
  const credentialById = new Map(
    credentialResult.results.map((credential) => [
      credential.id,
      credential,
    ]),
  );
  const completeClassificationGroupsByCredential = new Map<
    string,
    Set<string>
  >();
  for (const requirement of requirementResult.results) {
    if (
      requirement.kind !== "informational" ||
      !requirement.exclusiveGroup ||
      !Boolean(requirement.isActive) ||
      requirement.applicabilityStatus !== "applies"
    ) {
      continue;
    }
    const groups =
      completeClassificationGroupsByCredential.get(
        requirement.credentialId,
      ) ?? new Set<string>();
    groups.add(requirement.exclusiveGroup);
    completeClassificationGroupsByCredential.set(
      requirement.credentialId,
      groups,
    );
  }
  for (const requirement of requirementResult.results) {
    const credential = credentialById.get(requirement.credentialId);
    const isNremtComponent =
      credential?.ruleSetId?.startsWith(NREMT_RULE_SET_PREFIX) &&
      requirement.kind === "minimum" &&
      requirement.exclusiveGroup?.startsWith(NREMT_RULE_SET_PREFIX);
    const isFloridaMentalHealthCreditBucket =
      credential?.ruleSetId?.startsWith(
        FLORIDA_MENTAL_HEALTH_RULE_SET_PREFIX,
      ) &&
      requirement.kind === "minimum" &&
      requirement.exclusiveGroup ===
        FLORIDA_MENTAL_HEALTH_CREDIT_BUCKET_GROUP;
    if (
      !credential ||
      !["active", "submitted"].includes(credential.status) ||
      (requirement.kind !== "maximum" &&
        !isNremtComponent &&
        !isFloridaMentalHealthCreditBucket) ||
      !requirement.exclusiveGroup ||
      !Boolean(requirement.isActive) ||
      requirement.applicabilityStatus !== "applies"
    ) {
      continue;
    }
    const snapshotSupportsCompleteClassification =
      isNremtComponent ||
      isFloridaMentalHealthCreditBucket ||
      credential.status === "active" ||
      credential.ruleSetId === CFP_2027_RULE_SET_ID ||
      completeClassificationGroupsByCredential
        .get(requirement.credentialId)
        ?.has(requirement.exclusiveGroup);
    if (!snapshotSupportsCompleteClassification) continue;
    const groups =
      requiredMaximumGroupsByCredential.get(requirement.credentialId) ??
      new Set<string>();
    groups.add(requirement.exclusiveGroup);
    requiredMaximumGroupsByCredential.set(requirement.credentialId, groups);
  }
  for (const credential of credentialResult.results) {
    if (
      !["active", "submitted"].includes(credential.status) ||
      credential.ruleSetId !== NJ_LCSW_RULE_SET_ID
    ) {
      continue;
    }
    const groups =
      requiredMaximumGroupsByCredential.get(credential.id) ??
      new Set<string>();
    groups.add(NJ_LCSW_CREDIT_CATEGORY_GROUP);
    requiredMaximumGroupsByCredential.set(credential.id, groups);
  }
  const classificationIssueByAllocation = new Map<
    string,
    ClassificationIssue
  >();
  const classificationIssuesByCredential = new Map<
    string,
    ClassificationIssue[]
  >();
  const unclassifiedUnitsByCredential = new Map<string, number>();
  for (const activity of activityResult.results) {
    const credential = activity.credentialId
      ? credentialById.get(activity.credentialId)
      : null;
    if (
      !activity.allocationId ||
      !activity.credentialId ||
      !credential ||
      !["active", "submitted"].includes(credential.status) ||
      classificationIssueByAllocation.has(activity.allocationId)
    ) {
      continue;
    }
    if (isNremtRuleSet(credential.ruleSetId)) {
      const nremtRequirementsById = new Map(
        requirementResult.results
          .filter(
            (requirement) =>
              requirement.credentialId === activity.credentialId,
          )
          .map((requirement) => [requirement.id, requirement]),
      );
      const nremtIssue = nremtAllocationIssue(
        nremtRequirementsById,
        (matchesByAllocation.get(activity.allocationId) ?? []).map(
          (match) => ({
            requirementId: match.requirementId,
            matchedUnits: match.matchedUnits,
          }),
        ),
        Number(activity.allocatedUnits),
      );
      if (!nremtIssue) continue;
      const issue = {
        allocationId: activity.allocationId,
        activityId: activity.id,
        activityTitle: activity.title,
        unresolvedExclusiveGroups:
          nremtIssue.unresolvedExclusiveGroups,
        allocatedUnits: Number(activity.allocatedUnits),
        classificationMessage: nremtIssue.message,
      };
      classificationIssueByAllocation.set(activity.allocationId, issue);
      const credentialIssues =
        classificationIssuesByCredential.get(activity.credentialId) ?? [];
      credentialIssues.push(issue);
      classificationIssuesByCredential.set(
        activity.credentialId,
        credentialIssues,
      );
      unclassifiedUnitsByCredential.set(
        activity.credentialId,
        (unclassifiedUnitsByCredential.get(activity.credentialId) ?? 0) +
          issue.allocatedUnits,
      );
      continue;
    }
    const requiredGroups = [
      ...(requiredMaximumGroupsByCredential.get(activity.credentialId) ??
        new Set<string>()),
    ];
    const selectedGroupCounts = selectedGroupCountsByAllocation.get(
      activity.allocationId,
    );
    const unresolvedExclusiveGroups = requiredGroups.filter(
      (group) => (selectedGroupCounts?.get(group) ?? 0) !== 1,
    );
    const matchedRequirements = (
      matchesByAllocation.get(activity.allocationId) ?? []
    )
      .map((match) => requirementMetadataById.get(match.requirementId))
      .filter(
        (requirement): requirement is RequirementRow =>
          Boolean(requirement?.isActive) &&
          requirement?.applicabilityStatus === "applies",
      );
    const partialMaximumMatch = (
      matchesByAllocation.get(activity.allocationId) ?? []
    ).find((match) => {
      const requirement = requirementMetadataById.get(
        match.requirementId,
      );
      return (
        requirement?.kind === "maximum" &&
        Boolean(requirement.isActive) &&
        requirement.applicabilityStatus === "applies" &&
        Math.abs(
          Number(match.matchedUnits) -
            Number(activity.allocatedUnits),
        ) > 0.000_001
      );
    });
    const incompatibility =
      findRequirementIncompatibility(matchedRequirements);
    if (
      unresolvedExclusiveGroups.length === 0 &&
      !incompatibility &&
      !partialMaximumMatch
    ) {
      continue;
    }
    const issue = {
      allocationId: activity.allocationId,
      activityId: activity.id,
      activityTitle: activity.title,
      unresolvedExclusiveGroups,
      allocatedUnits: Number(activity.allocatedUnits),
      ...(partialMaximumMatch
        ? {
            classificationMessage:
              "A capped classification must cover the allocation’s full credited amount. Reclassify this preserved activity before it can count.",
          }
        : incompatibility
        ? {
            classificationMessage:
              incompatibility.incompatibility.message,
          }
        : {}),
    };
    classificationIssueByAllocation.set(activity.allocationId, issue);
    const credentialIssues =
      classificationIssuesByCredential.get(activity.credentialId) ?? [];
    credentialIssues.push(issue);
    classificationIssuesByCredential.set(
      activity.credentialId,
      credentialIssues,
    );
    unclassifiedUnitsByCredential.set(
      activity.credentialId,
      (unclassifiedUnitsByCredential.get(activity.credentialId) ?? 0) +
        issue.allocatedUnits,
    );
  }
  const unitsByRequirementAllocation = new Map<
    string,
    Map<string, number>
  >();
  const requirementsWithAllocationMatches = new Set<string>();
  for (const match of activityMatchResult.results) {
    let current = requirementMetadataById.get(match.requirementId);
    const visited = new Set<string>();
    while (
      current &&
      current.credentialId === match.credentialId &&
      !visited.has(current.id)
    ) {
      visited.add(current.id);
      requirementsWithAllocationMatches.add(current.id);
      if (current.relation !== "nested" || !current.parentRequirementId) break;
      current = requirementMetadataById.get(current.parentRequirementId);
    }
  }
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
    if (classificationIssueByAllocation.has(match.allocationId)) continue;
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
      : requirementsWithAllocationMatches.has(requirement.id)
        ? 0
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
  const classifiedAllocationsByCredential = new Map<
    string,
    Map<string, number>
  >();
  for (const activity of activityResult.results) {
    if (
      !activity.allocationId ||
      !activity.credentialId ||
      classificationIssueByAllocation.has(activity.allocationId)
    ) {
      continue;
    }
    const allocations =
      classifiedAllocationsByCredential.get(activity.credentialId) ??
      new Map<string, number>();
    allocations.set(
      activity.allocationId,
      Number(activity.allocatedUnits),
    );
    classifiedAllocationsByCredential.set(
      activity.credentialId,
      allocations,
    );
  }
  for (const [credentialId, requirements] of requirementsByCredential) {
    const allocations =
      classifiedAllocationsByCredential.get(credentialId) ??
      new Map<string, number>();
    const cappedTotals = cappedCreditTotals(
      [...allocations].map(([allocationId, allocatedUnits]) => ({
        allocationId,
        allocatedUnits,
      })),
      requirements
        .filter(
          (requirement) =>
            requirement.isActive && requirement.kind === "maximum",
        )
        .map((requirement) => ({
          requirementId: requirement.id,
          maximumUnits: requirement.requiredUnits,
          matches: [
            ...(unitsByRequirementAllocation.get(requirement.id) ??
              new Map<string, number>()),
          ]
            .filter(([allocationId]) => allocations.has(allocationId))
            .map(([allocationId, matchedUnits]) => ({
              allocationId,
              matchedUnits,
            })),
        })),
    );
    maximumExcessByCredential.set(
      credentialId,
      cappedTotals.excludedUnits,
    );
  }

  const tasksByCredential = new Map<string, TaskRow[]>();
  for (const task of taskResult.results) {
    const existing = tasksByCredential.get(task.credentialId) ?? [];
    existing.push(task);
    tasksByCredential.set(task.credentialId, existing);
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
        classificationStatus: "classified" | "needs_classification";
        unresolvedExclusiveGroups: string[];
        classificationMessage?: string;
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
      const classificationIssue =
        classificationIssueByAllocation.get(allocationId);
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
        classificationStatus: classificationIssue
          ? "needs_classification"
          : "classified",
        unresolvedExclusiveGroups:
          classificationIssue?.unresolvedExclusiveGroups ?? [],
        ...(classificationIssue?.classificationMessage
          ? {
              classificationMessage:
                classificationIssue.classificationMessage,
            }
          : {}),
      });
    }
  }

  const [reminderData, draftStorageNamespace] = await Promise.all([
    getReminderData(database, identity),
    createDraftStorageNamespace(identity.userId),
  ]);

  return {
    user: {
      displayName: identity.displayName,
      email: identity.email,
      isDemo: identity.isDemo,
      draftStorageNamespace,
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
      const totalLoggedUnits = Number(credential.totalEarned);
      const unclassifiedUnits = Math.min(
        totalLoggedUnits,
        unclassifiedUnitsByCredential.get(credential.id) ?? 0,
      );
      const totalRawEarned = Math.max(
        0,
        totalLoggedUnits - unclassifiedUnits,
      );
      const totalExcessUnits = Math.min(
        totalRawEarned,
        maximumExcessByCredential.get(credential.id) ?? 0,
      );
      const totalEarned = Math.max(0, totalRawEarned - totalExcessUnits);
      return {
        ...credential,
        totalRequired,
        totalLoggedUnits,
        unclassifiedUnits,
        classificationIssues:
          classificationIssuesByCredential.get(credential.id) ?? [],
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
    if (ruleSetId && isNremtRuleSet(ruleSetId)) {
      assertNremtCredentialDates(ruleSetId, deadline, payload);
    }
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
    if (isNremtRuleSet(ruleSetId)) {
      assertNremtCredentialDates(ruleSetId, deadline, payload);
    }
    if (ruleSetId.startsWith(FLORIDA_MENTAL_HEALTH_RULE_SET_PREFIX)) {
      assertFloridaMentalHealthCredentialDates(
        cycleStart,
        deadline,
        payload,
      );
    }
    if (
      ruleSetId === CFP_PRE_2027_RULE_SET_ID &&
      cycleStart >= CFP_2027_CYCLE_START
    ) {
      throw new RequestError(
        "This 30-hour CFP template is only for certification periods beginning before April 1, 2027. Use the 40-hour CFP requirement for a later cycle, and record carryover only after CFP Board confirms the eligible general CE amount.",
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

  const taskSpecs = renewalTaskSpecs(ruleSetId, deadline);
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
  const legacyRequirementIds = requirementIdsField(payload);
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
  const isNremt = await isOwnedNremtCredential(
    database,
    identity,
    credentialId,
  );
  const nremtMatches = isNremt
    ? requirementMatchesField(payload, { required: true })
    : [];
  if (isNremt) assertNremtAcceptedEducation(payload, provider);
  const selectedRequirements = isNremt
    ? await validateNremtRequirementMatches(
        database,
        identity,
        credentialId,
        nremtMatches,
        allocatedUnits,
      )
    : await validateRequirementTags(
        database,
        identity,
        credentialId,
        legacyRequirementIds,
      );
  const persistedMatches: RequirementMatchInput[] = isNremt
    ? nremtMatches
    : legacyRequirementIds.map((requirementId) => ({
        requirementId,
        matchedUnits: allocatedUnits,
      }));
  const primaryRequirementId =
    selectedRequirements.find((requirement) =>
      nremtComponentRole(requirement as NremtRequirementMetadata),
    )?.id ??
    persistedMatches[0]?.requirementId ??
    null;
  assertActivityDateAllowedForRequirements(
    completionDate,
    credential.cycleStart,
    credential.deadline,
    selectedRequirements,
    {
      portalCarryoverAttested:
        payload.portalCarryoverAttested === true,
      evidenceStatus,
    },
  );

  const activityId = crypto.randomUUID();
  const allocationId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    query(
      database,
      `INSERT INTO activities (
        id, user_id, title, provider, completion_date, total_units,
        evidence_status, evidence_reference
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      FROM credentials credential
      WHERE credential.id = ?
        AND credential.user_id = ?
        AND credential.status IN ('active', 'submitted')`,
      [
        activityId,
        identity.userId,
        title,
        provider,
        completionDate,
        totalUnits,
        evidenceStatus,
        evidenceReference,
        credentialId,
        identity.userId,
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
        primaryRequirementId,
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
  for (const match of persistedMatches) {
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
          match.requirementId,
          match.matchedUnits,
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

  try {
    await database.batch(statements);
  } catch (error) {
    return rethrowClosedCycleWrite(
      database,
      identity,
      credentialId,
      "This renewal cycle is closed and cannot receive activities.",
      error,
    );
  }
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
    `SELECT
      task.id,
      task.credential_id AS credentialId,
      credential.status AS credentialStatus
     FROM checklist_tasks task
     JOIN credentials credential ON credential.id = task.credential_id
     WHERE task.id = ?
       AND task.user_id = ?
       AND credential.user_id = task.user_id`,
    [taskId, identity.userId],
  ).first<{
    id: string;
    credentialId: string;
    credentialStatus: string;
  }>();
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
       WHERE id = ? AND user_id = ?
         AND EXISTS (
           SELECT 1
           FROM credentials credential
           WHERE credential.id = checklist_tasks.credential_id
             AND credential.user_id = checklist_tasks.user_id
             AND credential.status IN ('active', 'submitted')
         )`,
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
        )
        SELECT ?, ?, ?, 'task_completed', 30, 'task', ?
        FROM checklist_tasks task
        JOIN credentials credential ON credential.id = task.credential_id
        WHERE task.id = ?
          AND task.user_id = ?
          AND credential.user_id = task.user_id
          AND credential.status IN ('active', 'submitted')`,
        [
          crypto.randomUUID(),
          identity.userId,
          `${identity.userId}:task:${taskId}:completed`,
          taskId,
          taskId,
          identity.userId,
        ],
      ),
    );
  }
  let results: D1Result[];
  try {
    results = await database.batch(statements);
  } catch (error) {
    return rethrowClosedCycleWrite(
      database,
      identity,
      task.credentialId,
      "This renewal cycle is closed and its checklist is frozen.",
      error,
    );
  }
  if (Number(results[0]?.meta?.changes ?? Number.NaN) === 0) {
    await assertCredentialStillMutable(
      database,
      identity,
      task.credentialId,
      "This renewal cycle is closed and its checklist is frozen.",
    );
  }
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
    `SELECT
      id,
      status,
      rule_set_id AS ruleSetId
     FROM credentials
     WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ id: string; status: string; ruleSetId: string | null }>();
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  const isIsc2Checkpoint = isIsc2AutomaticRenewalRuleSet(
    credential.ruleSetId,
  );
  const isComplianceCheckpoint = isCompliancePeriodRuleSet(
    credential.ruleSetId,
  );
  const isNremtSubmission =
    credential.ruleSetId?.startsWith(NREMT_RULE_SET_PREFIX) ?? false;
  const isLifecycleCheckpoint =
    isIsc2Checkpoint || isComplianceCheckpoint;
  let isNremtLateReinstatement = false;
  const closedCycleMessage = isIsc2Checkpoint
    ? "This renewal cycle is closed and cannot receive another ISC2 dashboard checkpoint."
    : isComplianceCheckpoint
      ? "This compliance period is closed and cannot receive another completion checkpoint."
      : "This renewal cycle is closed and cannot be submitted again.";
  if (credential.status === "renewed") {
    throw new RequestError(
      closedCycleMessage,
      409,
      "cycle_closed",
    );
  }
  if (isIsc2Checkpoint && payload.complianceAttested !== true) {
    throw new RequestError(
      "Confirm that the ISC2 Dashboard shows this cycle’s required CPEs and annual maintenance fees as satisfied before saving the checkpoint.",
      409,
      "isc2_checkpoint_attestation_required",
    );
  }
  if (isComplianceCheckpoint && payload.complianceAttested !== true) {
    throw new RequestError(
      "Confirm that the official record shows this compliance period complete before saving the checkpoint.",
      409,
      "compliance_checkpoint_attestation_required",
    );
  }
  if (isNremtSubmission && payload.complianceAttested !== true) {
    throw new RequestError(
      "Confirm that the National Registry dashboard shows the assigned model, all component and National-topic requirements, and the application as ready before submitting.",
      409,
      "nremt_submission_attestation_required",
    );
  }
  await assertPortalCarryoverEvidenceReady(
    database,
    identity,
    credentialId,
  );
  if (isNremtSubmission) {
    const nremtCycle = await query(
      database,
      `SELECT deadline
       FROM credentials
       WHERE id = ? AND user_id = ?`,
      [credentialId, identity.userId],
    ).first<{ deadline: string }>();
    if (!nremtCycle) {
      throw new RequestError(
        "Credential not found.",
        404,
        "credential_not_found",
      );
    }
    assertNremtSubmissionWindow(
      credential.ruleSetId!,
      nremtCycle.deadline,
      submissionDate,
      payload,
    );
    isNremtLateReinstatement = submissionDate > nremtCycle.deadline;
    await assertNremtSubmissionComplete(
      database,
      identity,
      credentialId,
      credential.ruleSetId!,
      nremtCycle.deadline,
      submissionDate,
    );
  }
  const attestationKind = isIsc2Checkpoint
    ? "isc2_requirements_satisfied"
    : isComplianceCheckpoint
      ? "compliance_period_complete"
      : isNremtSubmission
        ? isNremtLateReinstatement
          ? "nremt_late_reinstatement_requirements_satisfied"
          : "nremt_requirements_satisfied"
        : null;
  const existing = await query(
    database,
    `SELECT id
     FROM renewal_submissions
     WHERE credential_id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ id: string }>();
  const submissionId = existing?.id ?? crypto.randomUUID();

  const statements: D1PreparedStatement[] = [
    query(
      database,
      `UPDATE credentials
       SET status = 'submitted', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND user_id = ?
         AND status IN ('active', 'submitted')`,
      [credentialId, identity.userId],
    ),
    query(
      database,
      `INSERT INTO renewal_submissions (
        id, user_id, credential_id, submitted_at, confirmation_number,
        proof_reference, attestation_kind
      )
      SELECT ?, credential.user_id, credential.id, ?, ?, ?, ?
      FROM credentials credential
      WHERE credential.id = ?
        AND credential.user_id = ?
        AND credential.status = 'submitted'
      ON CONFLICT(credential_id) DO UPDATE SET
        submitted_at = excluded.submitted_at,
        confirmation_number = excluded.confirmation_number,
        proof_reference = excluded.proof_reference,
        attestation_kind = excluded.attestation_kind,
        updated_at = CURRENT_TIMESTAMP`,
      [
        submissionId,
        submissionDate,
        confirmationNumber,
        (proofReference ?? confirmationNumber) || null,
        attestationKind,
        credentialId,
        identity.userId,
      ],
    ),
    query(
      database,
      `UPDATE checklist_tasks
       SET
         status = 'completed',
         completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
       WHERE credential_id = ? AND user_id = ? AND kind = 'submission'
         AND EXISTS (
           SELECT 1
           FROM credentials credential
           WHERE credential.id = checklist_tasks.credential_id
             AND credential.user_id = checklist_tasks.user_id
             AND credential.status = 'submitted'
         )`,
      [credentialId, identity.userId],
    ),
    query(
      database,
      `INSERT OR IGNORE INTO xp_events (
        id, user_id, idempotency_key, event_type, points, related_type,
        related_id
      )
      SELECT ?, ?, ?, ?, 150, ?, persisted_submission.id
      FROM credentials credential
      JOIN renewal_submissions persisted_submission
        ON persisted_submission.credential_id = credential.id
        AND persisted_submission.user_id = credential.user_id
      WHERE credential.id = ?
        AND credential.user_id = ?
        AND credential.status = 'submitted'`,
      [
        crypto.randomUUID(),
        identity.userId,
        isIsc2Checkpoint
          ? `${identity.userId}:credential:${credentialId}:isc2-checkpoint`
          : isComplianceCheckpoint
            ? `${identity.userId}:credential:${credentialId}:compliance-checkpoint`
            : `${identity.userId}:credential:${credentialId}:submitted`,
        isLifecycleCheckpoint
          ? isComplianceCheckpoint
            ? "compliance_checkpoint_recorded"
            : "renewal_checkpoint_recorded"
          : "renewal_submitted",
        isIsc2Checkpoint
          ? "renewal_checkpoint"
          : isComplianceCheckpoint
            ? "compliance_checkpoint"
            : "submission",
        credentialId,
        identity.userId,
      ],
    ),
  ];
  if (!isLifecycleCheckpoint) {
    statements.push(
      query(
        database,
        `INSERT OR IGNORE INTO badge_events (
          id, user_id, badge_id, idempotency_key, related_type, related_id
        )
        SELECT
          ?, ?, 'renewal-filed', ?, 'submission', persisted_submission.id
        FROM credentials credential
        JOIN renewal_submissions persisted_submission
          ON persisted_submission.credential_id = credential.id
          AND persisted_submission.user_id = credential.user_id
        WHERE credential.id = ?
          AND credential.user_id = ?
          AND credential.status = 'submitted'`,
        [
          crypto.randomUUID(),
          identity.userId,
          `${identity.userId}:badge:renewal-filed`,
          credentialId,
          identity.userId,
        ],
      ),
    );
  }

  let results: D1Result[];
  try {
    results = await database.batch(statements);
  } catch (error) {
    return rethrowClosedCycleWrite(
      database,
      identity,
      credentialId,
      closedCycleMessage,
      error,
    );
  }
  if (Number(results[0]?.meta?.changes ?? Number.NaN) === 0) {
    await assertCredentialStillMutable(
      database,
      identity,
      credentialId,
      closedCycleMessage,
    );
  }
  const persistedSubmission = await query(
    database,
    `SELECT id
     FROM renewal_submissions
     WHERE credential_id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ id: string }>();
  if (!persistedSubmission) {
    throw new RequestError(
      "The renewal submission changed while it was being recorded. Refresh and try again.",
      409,
      "submission_state_changed",
    );
  }
  return persistedSubmission.id;
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
  const legacyRequirementIds = requirementIdsField(payload);
  const allocatedUnits = positiveNumber(payload, "allocatedUnits", {
    required: true,
  })!;

  const [activity, credential, existing] = await Promise.all([
    query(
      database,
      `SELECT
        id,
        total_units AS totalUnits,
        completion_date AS completionDate,
        evidence_status AS evidenceStatus
       FROM activities
       WHERE id = ? AND user_id = ?`,
      [activityId, identity.userId],
    ).first<{
      id: string;
      totalUnits: number;
      completionDate: string;
      evidenceStatus: string;
    }>(),
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

  const isNremt = await isOwnedNremtCredential(
    database,
    identity,
    credentialId,
  );
  const nremtMatches = isNremt
    ? requirementMatchesField(payload, { required: true })
    : [];
  if (isNremt) {
    const activityProvider = await query(
      database,
      `SELECT provider
       FROM activities
       WHERE id = ? AND user_id = ?`,
      [activityId, identity.userId],
    ).first<{ provider: string }>();
    assertNremtAcceptedEducation(payload, activityProvider?.provider ?? "");
  }
  const selectedRequirements = isNremt
    ? await validateNremtRequirementMatches(
        database,
        identity,
        credentialId,
        nremtMatches,
        allocatedUnits,
      )
    : await validateRequirementTags(
        database,
        identity,
        credentialId,
        legacyRequirementIds,
      );
  const persistedMatches: RequirementMatchInput[] = isNremt
    ? nremtMatches
    : legacyRequirementIds.map((requirementId) => ({
        requirementId,
        matchedUnits: allocatedUnits,
      }));
  const primaryRequirementId =
    selectedRequirements.find((requirement) =>
      nremtComponentRole(requirement as NremtRequirementMetadata),
    )?.id ??
    persistedMatches[0]?.requirementId ??
    null;
  assertActivityDateAllowedForRequirements(
    activity.completionDate,
    credential.cycleStart,
    credential.deadline,
    selectedRequirements,
    {
      portalCarryoverAttested:
        payload.portalCarryoverAttested === true,
      evidenceStatus: activity.evidenceStatus,
    },
  );

  const allocationId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    query(
      database,
      `INSERT INTO activity_allocations (
        id, activity_id, credential_id, requirement_id, allocated_units
      )
      SELECT ?, ?, credential.id, ?, ?
      FROM credentials credential
      WHERE credential.id = ?
        AND credential.user_id = ?
        AND credential.status IN ('active', 'submitted')`,
      [
        allocationId,
        activityId,
        primaryRequirementId,
        allocatedUnits,
        credentialId,
        identity.userId,
      ],
    ),
  ];
  for (const match of persistedMatches) {
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
          match.requirementId,
          match.matchedUnits,
        ],
      ),
    );
  }
  try {
    const results = await database.batch(statements);
    if (Number(results[0]?.meta?.changes ?? Number.NaN) === 0) {
      await assertCredentialStillMutable(
        database,
        identity,
        credentialId,
        "This renewal cycle is closed and cannot receive activities.",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE constraint")) {
      throw new RequestError(
        "This activity is already applied to that credential.",
        409,
        "allocation_exists",
      );
    }
    return rethrowClosedCycleWrite(
      database,
      identity,
      credentialId,
      "This renewal cycle is closed and cannot receive activities.",
      error,
    );
  }
  return allocationId;
}

async function updateActivityAllocationRequirements(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const allocationId = textField(payload, "allocationId", {
    required: true,
    max: 160,
  })!;
  const legacyRequirementIds = requirementIdsField(payload);

  const allocation = await query(
    database,
    `SELECT
      allocation.id,
      allocation.credential_id AS credentialId,
      allocation.allocated_units AS allocatedUnits,
      activity.completion_date AS completionDate,
      activity.evidence_status AS evidenceStatus,
      credential.status,
      credential.cycle_start AS cycleStart,
      credential.deadline
     FROM activity_allocations allocation
     JOIN activities activity ON activity.id = allocation.activity_id
     JOIN credentials credential ON credential.id = allocation.credential_id
     WHERE allocation.id = ?
       AND activity.user_id = ?
       AND credential.user_id = ?`,
    [allocationId, identity.userId, identity.userId],
  ).first<{
    id: string;
    credentialId: string;
    allocatedUnits: number;
    completionDate: string;
    evidenceStatus: string;
    status: string;
    cycleStart: string;
    deadline: string;
  }>();
  if (!allocation) {
    throw new RequestError(
      "Activity allocation not found.",
      404,
      "allocation_not_found",
    );
  }
  if (allocation.status === "renewed") {
    throw new RequestError(
      "This renewal cycle is closed and cannot be changed.",
      409,
      "cycle_closed",
    );
  }

  const isNremt = await isOwnedNremtCredential(
    database,
    identity,
    allocation.credentialId,
  );
  const nremtMatches = isNremt
    ? requirementMatchesField(payload, { required: true })
    : [];
  if (isNremt) {
    const activityProvider = await query(
      database,
      `SELECT activity.provider
       FROM activity_allocations allocation
       JOIN activities activity ON activity.id = allocation.activity_id
       JOIN credentials credential ON credential.id = allocation.credential_id
       WHERE allocation.id = ?
         AND activity.user_id = ?
         AND credential.user_id = ?`,
      [allocationId, identity.userId, identity.userId],
    ).first<{ provider: string }>();
    assertNremtAcceptedEducation(payload, activityProvider?.provider ?? "");
  }
  const selectedRequirements = isNremt
    ? await validateNremtRequirementMatches(
        database,
        identity,
        allocation.credentialId,
        nremtMatches,
        Number(allocation.allocatedUnits),
      )
    : await validateRequirementTags(
        database,
        identity,
        allocation.credentialId,
        legacyRequirementIds,
      );
  const persistedMatches: RequirementMatchInput[] = isNremt
    ? nremtMatches
    : legacyRequirementIds.map((requirementId) => ({
        requirementId,
        matchedUnits: Number(allocation.allocatedUnits),
      }));
  const primaryRequirementId =
    selectedRequirements.find((requirement) =>
      nremtComponentRole(requirement as NremtRequirementMetadata),
    )?.id ??
    persistedMatches[0]?.requirementId ??
    null;
  assertActivityDateAllowedForRequirements(
    allocation.completionDate,
    allocation.cycleStart,
    allocation.deadline,
    selectedRequirements,
    {
      portalCarryoverAttested:
        payload.portalCarryoverAttested === true,
      evidenceStatus: allocation.evidenceStatus,
    },
  );

  const statements: D1PreparedStatement[] = [
    query(
      database,
      `UPDATE activity_allocations
       SET requirement_id = ?
       WHERE id = ? AND credential_id = ?
         AND EXISTS (
           SELECT 1
           FROM credentials credential
           WHERE credential.id = activity_allocations.credential_id
             AND credential.user_id = ?
             AND credential.status IN ('active', 'submitted')
         )`,
      [
        primaryRequirementId,
        allocationId,
        allocation.credentialId,
        identity.userId,
      ],
    ),
    query(
      database,
      `DELETE FROM activity_requirement_matches
       WHERE allocation_id = ? AND user_id = ?
         AND EXISTS (
           SELECT 1
           FROM activity_allocations allocation
           JOIN credentials credential
             ON credential.id = allocation.credential_id
           WHERE allocation.id =
             activity_requirement_matches.allocation_id
             AND credential.user_id = ?
             AND credential.status IN ('active', 'submitted')
         )`,
      [allocationId, identity.userId, identity.userId],
    ),
  ];
  for (const match of persistedMatches) {
    statements.push(
      query(
        database,
        `INSERT INTO activity_requirement_matches (
          id, user_id, allocation_id, requirement_id, matched_units
        )
        SELECT ?, ?, allocation.id, ?, ${
          isNremt ? "?" : "allocation.allocated_units"
        }
        FROM activity_allocations allocation
        JOIN credentials credential
          ON credential.id = allocation.credential_id
        WHERE allocation.id = ?
          AND allocation.credential_id = ?
          AND credential.user_id = ?
          AND credential.status IN ('active', 'submitted')`,
        [
          crypto.randomUUID(),
          identity.userId,
          match.requirementId,
          ...(isNremt ? [match.matchedUnits] : []),
          allocationId,
          allocation.credentialId,
          identity.userId,
        ],
      ),
    );
  }
  let results: D1Result[];
  try {
    results = await database.batch(statements);
  } catch (error) {
    return rethrowClosedCycleWrite(
      database,
      identity,
      allocation.credentialId,
      "This renewal cycle is closed and cannot be changed.",
      error,
    );
  }
  if (Number(results[0]?.meta?.changes ?? Number.NaN) === 0) {
    await assertCredentialStillMutable(
      database,
      identity,
      allocation.credentialId,
      "This renewal cycle is closed and cannot be changed.",
    );
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
  const requestedNextRuleSetId = textField(payload, "nextRuleSetId", {
    max: 160,
  });
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
    ruleStableKey: string | null;
    credentialName: string;
    profession: string;
    jurisdiction: string;
    issuer: string;
    status: string;
    cycleStart: string;
    deadline: string;
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
  type NextRuleTemplate = {
    id: string;
    credentialName: string;
    profession: string;
    jurisdiction: string;
    issuer: string;
    totalUnits: number;
    unitLabel: string;
    cycleMonths: number;
  };
  type NextRuleCategory = {
    id: string;
    name: string;
    requiredUnits: number;
    kind: RequirementKind;
    relation: RequirementRelation;
    parentCategoryId: string | null;
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
        rules.stable_key AS ruleStableKey,
        credential.credential_name AS credentialName,
        credential.profession,
        credential.jurisdiction,
        credential.issuer,
        credential.status,
        credential.cycle_start AS cycleStart,
        credential.deadline,
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
  const isIsc2AutomaticRenewal = isIsc2AutomaticRenewalRuleSet(
    credential.ruleSetId,
  );
  const isCompliancePeriod = isCompliancePeriodRuleSet(
    credential.ruleSetId,
  );
  const replacementTemplateFamily = nextTemplateFamily(
    credential.ruleSetId,
  );
  const isNremtRenewal =
    credential.ruleSetId?.startsWith(NREMT_RULE_SET_PREFIX) ?? false;
  const requiresOfficialNextPeriodAttestation =
    isIsc2AutomaticRenewal ||
    isCompliancePeriod ||
    replacementTemplateFamily === "florida_mental_health" ||
    isNremtRenewal;
  const requiresNonOverlappingNextPeriod =
    isIsc2AutomaticRenewal ||
    isCompliancePeriod ||
    replacementTemplateFamily === "florida_mental_health";
  if (
    requiresOfficialNextPeriodAttestation &&
    payload.officialDatesAttested !== true
  ) {
    throw new RequestError(
      "Confirm that the completion record and next cycle dates match the official source before closing this period.",
      409,
      "official_next_period_attestation_required",
    );
  }
  if (replacementTemplateFamily === "florida_mental_health") {
    const expectedNextCycle = nextFloridaMentalHealthCycle(
      credential.deadline,
    );
    if (
      !isFloridaMentalHealthCycle(
        credential.cycleStart,
        credential.deadline,
      ) ||
      !expectedNextCycle ||
      nextCycleStart !== expectedNextCycle.cycleStart ||
      nextDeadline !== expectedNextCycle.deadline
    ) {
      throw new RequestError(
        "The next standard Florida mental-health biennium must immediately follow the current odd-year April 1 through March 31 period.",
        409,
        "florida_mental_health_next_cycle_invalid",
      );
    }
  }
  if (
    isNremtRenewal &&
    nextDeadline !== yearsAfter(credential.deadline, 2)
  ) {
    throw new RequestError(
      `The next National Registry expiration must be exactly two years after the current expiration: ${yearsAfter(credential.deadline, 2)}.`,
      409,
      "nremt_next_deadline_invalid",
    );
  }
  if (isNremtRenewal && nextCycleStart <= acceptedAt) {
    throw new RequestError(
      "Enter the next cycle start shown in the National Registry dashboard; it must follow the recorded approval date.",
      409,
      "nremt_next_cycle_start_invalid",
    );
  }
  if (isIsc2AutomaticRenewal && acceptedAt < credential.deadline) {
    throw new RequestError(
      "ISC2 renewal cannot be confirmed before the current certification cycle ends.",
      409,
      "isc2_renewal_before_cycle_end",
    );
  }
  if (
    requiresNonOverlappingNextPeriod &&
    nextCycleStart <= credential.deadline
  ) {
    throw new RequestError(
      "The next period must start after the current period ends.",
      409,
      "next_cycle_overlaps_current_period",
    );
  }
  let selectedNextRule: NextRuleTemplate | null = null;
  let selectedNextCategories: NextRuleCategory[] = [];
  if (replacementTemplateFamily) {
    const expectedPrefix =
      replacementTemplateFamily === "florida_insurance"
        ? FLORIDA_INSURANCE_RULE_SET_PREFIX
        : FLORIDA_MENTAL_HEALTH_RULE_SET_PREFIX;
    const expectedProfession =
      replacementTemplateFamily === "florida_insurance"
        ? "Insurance"
        : "Mental Health";
    if (!requestedNextRuleSetId?.startsWith(expectedPrefix)) {
      throw new RequestError(
        replacementTemplateFamily === "florida_insurance"
          ? "Choose the current Florida producer template shown for the next MyProfile compliance period."
          : "Choose the Florida mental-health phase shown by CE Broker for the next renewal period.",
        409,
        replacementTemplateFamily === "florida_insurance"
          ? "florida_next_template_required"
          : "florida_mental_health_next_template_required",
      );
    }
    if (
      replacementTemplateFamily === "florida_mental_health" &&
      requestedNextRuleSetId !==
        oppositeFloridaMentalHealthRuleSetId(credential.ruleSetId)
    ) {
      throw new RequestError(
        "Florida Ethics and Boundaries and Telehealth phases alternate each biennium. Choose the opposite phase for the next CE Broker period.",
        409,
        "florida_mental_health_phase_must_alternate",
      );
    }
    selectedNextRule = await query(
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
       WHERE id = ?
         AND is_current = 1
         AND profession = ?
         AND jurisdiction = 'Florida'
         AND id LIKE ?`,
      [requestedNextRuleSetId, expectedProfession, `${expectedPrefix}%`],
    ).first<NextRuleTemplate>();
    if (!selectedNextRule) {
      throw new RequestError(
        replacementTemplateFamily === "florida_insurance"
          ? "The selected Florida producer template is unavailable or no longer current."
          : "The selected Florida mental-health phase is unavailable or no longer current.",
        409,
        replacementTemplateFamily === "florida_insurance"
          ? "florida_next_template_unavailable"
          : "florida_mental_health_next_template_unavailable",
      );
    }
    const categoryResult = await query(
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
        exclusive_group AS exclusiveGroup,
        sort_order AS sortOrder
       FROM rule_categories
       WHERE rule_set_id = ?
       ORDER BY sort_order, name`,
      [selectedNextRule.id],
    ).all<NextRuleCategory>();
    selectedNextCategories = categoryResult.results;
  } else if (isNremtRenewal) {
    if (!requestedNextRuleSetId) {
      throw new RequestError(
        "Choose the current same-level National Registry template shown in the catalog for the next cycle.",
        409,
        "nremt_next_template_required",
      );
    }
    selectedNextRule = await query(
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
       WHERE id = ?
         AND is_current = 1
         AND stable_key = ?
         AND id LIKE 'nremt-%'`,
      [requestedNextRuleSetId, credential.ruleStableKey],
    ).first<NextRuleTemplate>();
    if (!selectedNextRule) {
      throw new RequestError(
        "The selected National Registry template is not the current same-level template. Refresh the catalog and verify the model shown in the dashboard.",
        409,
        "nremt_next_template_unavailable",
      );
    }
    const categoryResult = await query(
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
        exclusive_group AS exclusiveGroup,
        sort_order AS sortOrder
       FROM rule_categories
       WHERE rule_set_id = ?
       ORDER BY sort_order, name`,
      [selectedNextRule.id],
    ).all<NextRuleCategory>();
    selectedNextCategories = categoryResult.results;
  } else if (requestedNextRuleSetId) {
    throw new RequestError(
      "A replacement rule template may be selected only for a supported Florida rollover.",
      400,
      "next_template_not_allowed",
    );
  }
  const nextCatalogSnapshotGuard = selectedNextRule
    ? {
        sql: `EXISTS (
          SELECT 1
          FROM rule_sets selected_rule
          WHERE selected_rule.id = ?
            AND selected_rule.is_current = 1
            ${
              isNremtRenewal
                ? "AND selected_rule.stable_key IS ?"
                : ""
            }
            AND selected_rule.credential_name IS ?
            AND selected_rule.profession IS ?
            AND selected_rule.jurisdiction IS ?
            AND selected_rule.issuer IS ?
            AND selected_rule.total_units IS ?
            AND selected_rule.unit_label IS ?
            AND selected_rule.cycle_months IS ?
            AND (
              SELECT COUNT(*)
              FROM rule_categories counted_category
              WHERE counted_category.rule_set_id = selected_rule.id
            ) = ?
            ${selectedNextCategories
              .map(
                () => `AND EXISTS (
                  SELECT 1
                  FROM rule_categories selected_category
                  WHERE selected_category.rule_set_id = selected_rule.id
                    AND selected_category.id = ?
                    AND selected_category.name IS ?
                    AND selected_category.required_units IS ?
                    AND selected_category.kind IS ?
                    AND selected_category.relation IS ?
                    AND selected_category.parent_category_id IS ?
                    AND selected_category.applicability IS ?
                    AND selected_category.condition_note IS ?
                    AND selected_category.exclusive_group IS ?
                    AND selected_category.sort_order IS ?
                )`,
              )
              .join("\n")}
        )`,
        bindings: [
          selectedNextRule.id,
          ...(isNremtRenewal ? [credential.ruleStableKey] : []),
          selectedNextRule.credentialName,
          selectedNextRule.profession,
          selectedNextRule.jurisdiction,
          selectedNextRule.issuer,
          Number(selectedNextRule.totalUnits),
          selectedNextRule.unitLabel,
          Number(selectedNextRule.cycleMonths),
          selectedNextCategories.length,
          ...selectedNextCategories.flatMap((category) => [
            category.id,
            category.name,
            Number(category.requiredUnits),
            category.kind,
            category.relation,
            category.parentCategoryId,
            category.applicability,
            category.conditionNote,
            category.exclusiveGroup,
            Number(category.sortOrder),
          ]),
        ] as readonly unknown[],
      }
    : null;
  const nextCatalogSnapshotStillMatches = async () => {
    if (!nextCatalogSnapshotGuard) return true;
    const result = await query(
      database,
      `SELECT 1 AS matches
       WHERE ${nextCatalogSnapshotGuard.sql}`,
      nextCatalogSnapshotGuard.bindings,
    ).first<{ matches: number }>();
    return Boolean(result?.matches);
  };
  const throwIfNextCatalogSnapshotChanged = async () => {
    if (await nextCatalogSnapshotStillMatches()) return;
    throw new RequestError(
      isNremtRenewal
        ? "The selected National Registry template changed while the next cycle was being created. Review the current dashboard model and catalog template, then try again."
        : replacementTemplateFamily === "florida_mental_health"
          ? "The selected Florida mental-health phase changed while the next biennium was being created. Review the current CE Broker phase and catalog template, then try again."
          : "The selected Florida producer template changed while the next compliance period was being created. Review the current template and try again.",
      409,
      isNremtRenewal
        ? "nremt_next_template_changed"
        : replacementTemplateFamily === "florida_mental_health"
          ? "florida_mental_health_next_template_changed"
          : "florida_next_template_changed",
    );
  };
  const unresolvedClassification =
    await findUnresolvedCredentialClassification(
      database,
      identity,
      credentialId,
      credential.ruleSetId,
    );
  if (unresolvedClassification) {
    throw new RequestError(
      "Resolve every activity classification conflict before marking this renewal accepted.",
      409,
      "classification_required_before_acceptance",
    );
  }
  await assertPortalCarryoverEvidenceReady(
    database,
    identity,
    credentialId,
  );
  if (isNremtRenewal) {
    const nremtSubmissionState = await query(
      database,
      `SELECT attestation_kind AS attestationKind
       FROM renewal_submissions
       WHERE id = ?
         AND credential_id = ?
         AND user_id = ?`,
      [submission.id, credentialId, identity.userId],
    ).first<{ attestationKind: string | null }>();
    assertNremtSubmissionWindow(
      credential.ruleSetId!,
      credential.deadline,
      submission.submittedAt.slice(0, 10),
      {
        lateReinstatementAttested:
          nremtSubmissionState?.attestationKind ===
          "nremt_late_reinstatement_requirements_satisfied",
      },
    );
    await assertNremtSubmissionComplete(
      database,
      identity,
      credentialId,
      credential.ruleSetId!,
      credential.deadline,
      submission.submittedAt.slice(0, 10),
    );
  }
  const assertSubmissionStillAcceptable = async () => {
    const current = await query(
      database,
      `SELECT
        credential.status,
        submission.id AS submissionId,
        submission.submitted_at AS submittedAt
       FROM credentials credential
       LEFT JOIN renewal_submissions submission
         ON submission.credential_id = credential.id
         AND submission.user_id = credential.user_id
       WHERE credential.id = ? AND credential.user_id = ?`,
      [credentialId, identity.userId],
    ).first<{
      status: string;
      submissionId: string | null;
      submittedAt: string | null;
    }>();
    if (
      !current ||
      current.status !== "submitted" ||
      current.submissionId !== submission.id ||
      !current.submittedAt ||
      acceptedAt < current.submittedAt.slice(0, 10)
    ) {
      throw new RequestError(
        "The renewal submission changed while acceptance was being recorded. Refresh and try again.",
        409,
        "submission_state_changed",
      );
    }
  };

  const nextCredentialId = crypto.randomUUID();
  const acceptanceId = crypto.randomUUID();
  const transitionsToFortyHourCfp =
    credential.ruleSetId === CFP_PRE_2027_RULE_SET_ID &&
    nextCycleStart >= CFP_2027_CYCLE_START;
  const nextCredentialName =
    selectedNextRule?.credentialName ??
    (transitionsToFortyHourCfp
      ? "CFP® Professional — cycle beginning April 1, 2027 or later"
      : credential.credentialName);
  const nextRuleSetId =
    selectedNextRule?.id ??
    (transitionsToFortyHourCfp
      ? CFP_2027_RULE_SET_ID
      : credential.ruleSetId);
  const nextProfession = selectedNextRule?.profession ?? credential.profession;
  const nextJurisdiction =
    selectedNextRule?.jurisdiction ?? credential.jurisdiction;
  const nextIssuer = selectedNextRule?.issuer ?? credential.issuer;
  const nextTotalRequired =
    selectedNextRule?.totalUnits ??
    (transitionsToFortyHourCfp
      ? 40
      : Number(credential.totalRequired));
  const nextUnitLabel = selectedNextRule?.unitLabel ?? credential.unitLabel;
  const nextCycleMonths =
    selectedNextRule?.cycleMonths ?? Number(credential.cycleMonths);
  const officialRecordAttestedAt =
    requiresOfficialNextPeriodAttestation
      ? new Date().toISOString()
      : null;
  const carryoverReviewTaskTitle =
    nextRuleSetId === null
      ? null
      : (CARRYOVER_REVIEW_TASK_TITLES.get(nextRuleSetId) ?? null);
  const portalCarryoverCategoryIdsForGuard =
    portalCarryoverCategoryIds();
  const portalCarryoverPlaceholders =
    portalCarryoverCategoryIdsForGuard.map(() => "?").join(", ");
  const statements: D1PreparedStatement[] = [
    query(
      database,
      `WITH
        complete_classification_groups AS (
          SELECT DISTINCT
            requirement.credential_id AS credential_id,
            requirement.exclusive_group AS exclusive_group
          FROM credential_requirements requirement
          WHERE requirement.kind = 'informational'
            AND requirement.is_active = 1
            AND requirement.applicability_status = 'applies'
            AND requirement.exclusive_group IS NOT NULL
        ),
        required_classification_groups AS (
          SELECT DISTINCT
            requirement.credential_id AS credential_id,
            requirement.exclusive_group AS exclusive_group
          FROM credential_requirements requirement
          JOIN credentials owner
            ON owner.id = requirement.credential_id
          WHERE requirement.is_active = 1
            AND requirement.applicability_status = 'applies'
            AND requirement.exclusive_group IS NOT NULL
            AND requirement.kind = 'maximum'
            AND (
              owner.rule_set_id = ?
              OR EXISTS (
                SELECT 1
                FROM complete_classification_groups complete_group
                WHERE complete_group.credential_id =
                  requirement.credential_id
                  AND complete_group.exclusive_group =
                    requirement.exclusive_group
                )
              )
          UNION
          SELECT credential.id, ?
          FROM credentials credential
          WHERE credential.rule_set_id = ?
          UNION
          SELECT credential.id, ?
          FROM credentials credential
          WHERE credential.rule_set_id LIKE ?
        ),
        incompatible_categories (
          first_category_id,
          second_category_id
        ) AS (
          VALUES ${REQUIREMENT_INCOMPATIBILITY_VALUES_SQL}
        )
      UPDATE credentials
      SET status = 'renewed', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND user_id = ?
        AND status = 'submitted'
        AND EXISTS (
          SELECT 1
          FROM renewal_submissions guarded_submission
          WHERE guarded_submission.id = ?
            AND guarded_submission.credential_id = credentials.id
            AND guarded_submission.user_id = credentials.user_id
            AND substr(guarded_submission.submitted_at, 1, 10) <= ?
        )
        ${
          nextCatalogSnapshotGuard
            ? `AND ${nextCatalogSnapshotGuard.sql}`
            : ""
        }
        AND NOT EXISTS (
          SELECT 1
          FROM activity_allocations allocation
          JOIN required_classification_groups required_group
            ON required_group.credential_id = allocation.credential_id
          WHERE allocation.credential_id = credentials.id
            AND (
              SELECT COUNT(*)
              FROM activity_requirement_matches match
              JOIN credential_requirements selected_requirement
                ON selected_requirement.id = match.requirement_id
                AND selected_requirement.credential_id =
                  allocation.credential_id
              WHERE match.allocation_id = allocation.id
                AND match.user_id = credentials.user_id
                AND selected_requirement.is_active = 1
                AND selected_requirement.applicability_status = 'applies'
                AND selected_requirement.exclusive_group =
                  required_group.exclusive_group
            ) <> 1
        )
        AND NOT EXISTS (
          SELECT 1
          FROM activity_allocations allocation
          JOIN activity_requirement_matches first_match
            ON first_match.allocation_id = allocation.id
          JOIN credential_requirements first_requirement
            ON first_requirement.id = first_match.requirement_id
            AND first_requirement.credential_id =
              allocation.credential_id
          JOIN activity_requirement_matches second_match
            ON second_match.allocation_id = allocation.id
            AND second_match.requirement_id >
              first_match.requirement_id
          JOIN credential_requirements second_requirement
            ON second_requirement.id = second_match.requirement_id
            AND second_requirement.credential_id =
              allocation.credential_id
          JOIN incompatible_categories incompatibility
            ON (
              (
                incompatibility.first_category_id =
                  first_requirement.rule_category_id
                AND incompatibility.second_category_id =
                  second_requirement.rule_category_id
              )
              OR (
                incompatibility.second_category_id =
                  first_requirement.rule_category_id
                AND incompatibility.first_category_id =
                  second_requirement.rule_category_id
              )
            )
          WHERE allocation.credential_id = credentials.id
            AND first_match.user_id = credentials.user_id
            AND second_match.user_id = credentials.user_id
            AND first_requirement.is_active = 1
            AND first_requirement.applicability_status = 'applies'
            AND second_requirement.is_active = 1
            AND second_requirement.applicability_status = 'applies'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM activity_allocations carryover_allocation
          JOIN activities carryover_activity
            ON carryover_activity.id =
              carryover_allocation.activity_id
            AND carryover_activity.user_id = credentials.user_id
          JOIN activity_requirement_matches carryover_match
            ON carryover_match.allocation_id =
              carryover_allocation.id
            AND carryover_match.user_id = credentials.user_id
          JOIN credential_requirements carryover_requirement
            ON carryover_requirement.id =
              carryover_match.requirement_id
            AND carryover_requirement.credential_id =
              carryover_allocation.credential_id
          WHERE carryover_allocation.credential_id = credentials.id
            AND carryover_activity.completion_date <
              credentials.cycle_start
            AND carryover_requirement.rule_category_id IN (
              ${portalCarryoverPlaceholders}
            )
            AND COALESCE(
              TRIM(carryover_activity.evidence_reference),
              ''
            ) = ''
            AND NOT EXISTS (
              SELECT 1
              FROM evidence_files carryover_evidence
              WHERE carryover_evidence.activity_id =
                carryover_activity.id
                AND carryover_evidence.user_id =
                  credentials.user_id
                AND carryover_evidence.status = 'ready'
            )
        )`,
      [
        CFP_2027_RULE_SET_ID,
        NJ_LCSW_CREDIT_CATEGORY_GROUP,
        NJ_LCSW_RULE_SET_ID,
        FLORIDA_MENTAL_HEALTH_CREDIT_BUCKET_GROUP,
        `${FLORIDA_MENTAL_HEALTH_RULE_SET_PREFIX}%`,
        ...REQUIREMENT_INCOMPATIBILITY_BINDINGS,
        credentialId,
        identity.userId,
        submission.id,
        acceptedAt,
        ...(nextCatalogSnapshotGuard?.bindings ?? []),
        ...portalCarryoverCategoryIdsForGuard,
      ],
    ),
    query(
      database,
      `INSERT OR IGNORE INTO credential_cycle_links (
        id, user_id, credential_id, series_id, previous_credential_id,
        cycle_months
      )
      SELECT ?, source.user_id, source.id, ?, NULL, ?
      FROM credentials source
      WHERE source.id = ?
        AND source.user_id = ?
        AND source.status = 'renewed'`,
      [
        crypto.randomUUID(),
        credential.seriesId,
        Number(credential.cycleMonths),
        credentialId,
        identity.userId,
      ],
    ),
    query(
      database,
      `INSERT INTO credentials (
        id, user_id, rule_set_id, credential_name, profession, jurisdiction,
        issuer, cycle_start, deadline, total_required, unit_label, status
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active'
      FROM credentials source
      WHERE source.id = ?
        AND source.user_id = ?
        AND source.status = 'renewed'
        AND NOT EXISTS (
          SELECT 1
          FROM renewal_acceptances acceptance
          WHERE acceptance.credential_id = source.id
            AND acceptance.user_id = source.user_id
        )`,
      [
        nextCredentialId,
        identity.userId,
        nextRuleSetId,
        nextCredentialName,
        nextProfession,
        nextJurisdiction,
        nextIssuer,
        nextCycleStart,
        nextDeadline,
        nextTotalRequired,
        nextUnitLabel,
        credentialId,
        identity.userId,
      ],
    ),
    query(
      database,
      `INSERT INTO credential_cycle_links (
        id, user_id, credential_id, series_id, previous_credential_id,
        cycle_months
      )
      SELECT ?, next_credential.user_id, next_credential.id, ?, ?, ?
      FROM credentials next_credential
      WHERE next_credential.id = ?
        AND next_credential.user_id = ?
        AND next_credential.status = 'active'`,
      [
        crypto.randomUUID(),
        credential.seriesId,
        credentialId,
        nextCycleMonths,
        nextCredentialId,
        identity.userId,
      ],
    ),
  ];

  const rolloverDrafts: CredentialCategoryDraft[] = transitionsToFortyHourCfp
    ? [
        {
          key: CFP_2027_GENERAL_CATEGORY_ID,
          ruleCategoryId: CFP_2027_GENERAL_CATEGORY_ID,
          name: "General CE",
          requiredUnits: 38,
          kind: "minimum",
          relation: "independent",
          parentKey: null,
          applicability: "always",
          applicabilityStatus: "applies",
          conditionNote:
            "Complete 38 general CE hours. Classify every general activity under the Principal Topics or Practice Management child category rather than tagging this parent directly. License Lantern does not copy prior-cycle credit; manually record only CFP Board-confirmed eligible carryover and retain the confirmation.",
          exclusiveGroup: null,
          isActive: true,
          sortOrder: 0,
        },
        {
          key: "cfp-professional-2027-principal-topics",
          ruleCategoryId: "cfp-professional-2027-principal-topics",
          name: "General CE — Principal Topics Other Than Practice Management",
          requiredUnits: 33,
          kind: "minimum",
          relation: "nested",
          parentKey: CFP_2027_GENERAL_CATEGORY_ID,
          applicability: "always",
          applicabilityStatus: "applies",
          conditionNote:
            "At least 33 of the 38 general CE hours must cover CFP Board Principal Topics other than Practice Management. This derived floor enforces the five-hour Practice Management cap; tag each non-Practice-Management general activity here.",
          exclusiveGroup: "CFP CE activity type",
          isActive: true,
          sortOrder: 1,
        },
        {
          key: "cfp-professional-2027-practice-management",
          ruleCategoryId: "cfp-professional-2027-practice-management",
          name: "Practice Management General CE",
          requiredUnits: 5,
          kind: "maximum",
          relation: "nested",
          parentKey: CFP_2027_GENERAL_CATEGORY_ID,
          applicability: "optional",
          applicabilityStatus: "applies",
          conditionNote:
            "No more than 5 of the 38 general CE hours may focus on Practice Management. Tag every Practice Management activity here so excess hours cannot count toward the 40-hour total.",
          exclusiveGroup: "CFP CE activity type",
          isActive: true,
          sortOrder: 2,
        },
        {
          key: "cfp-professional-2027-ethics",
          ruleCategoryId: "cfp-professional-2027-ethics",
          name: "CFP Board-Approved Ethics CE",
          requiredUnits: 2,
          kind: "minimum",
          relation: "independent",
          parentKey: null,
          applicability: "always",
          applicabilityStatus: "applies",
          conditionNote:
            "Complete the current two-hour CFP Board-approved Ethics CE program. Ethics CE is separate from the 38 general hours and cannot carry over from another certification period.",
          exclusiveGroup: "CFP CE activity type",
          isActive: true,
          sortOrder: 3,
        },
      ]
    : selectedNextRule
      ? selectedNextCategories.map((category) => {
          const applicabilityStatus = defaultApplicabilityStatus(
            category.applicability,
          );
          return {
            key: category.id,
            ruleCategoryId: category.id,
            name: category.name,
            requiredUnits: Number(category.requiredUnits),
            kind: category.kind,
            relation: category.relation,
            parentKey: category.parentCategoryId,
            applicability: category.applicability,
            applicabilityStatus,
            conditionNote: category.conditionNote,
            exclusiveGroup: category.exclusiveGroup,
            isActive: applicabilityStatus === "applies",
            sortOrder: Number(category.sortOrder),
          };
        })
      : requirements.results.map((requirement) => {
        const applicabilityStatus = defaultApplicabilityStatus(
          requirement.applicability,
        );
        return {
          key: requirement.id,
          ruleCategoryId: requirement.ruleCategoryId,
          name: requirement.name,
          requiredUnits: Number(requirement.requiredUnits),
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
        });
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
        )
        SELECT
          ?, next_credential.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM credentials next_credential
        WHERE next_credential.id = ?
          AND next_credential.user_id = ?
          AND next_credential.status = 'active'`,
        [
          nextRequirementIdByPriorId.get(requirement.key),
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
          nextCredentialId,
          identity.userId,
        ],
      ),
    );
  }
  const taskSpecs = renewalTaskSpecs(
    nextRuleSetId,
    nextDeadline,
    carryoverReviewTaskTitle,
  );
  taskSpecs.forEach((task, index) => {
    statements.push(
      query(
        database,
        `INSERT INTO checklist_tasks (
          id, user_id, credential_id, title, kind, status, due_date, sort_order
        )
        SELECT
          ?, next_credential.user_id, next_credential.id, ?, ?,
          'pending', ?, ?
        FROM credentials next_credential
        WHERE next_credential.id = ?
          AND next_credential.user_id = ?
          AND next_credential.status = 'active'`,
        [
          crypto.randomUUID(),
          task.title,
          task.kind,
          task.dueDate,
          index,
          nextCredentialId,
          identity.userId,
        ],
      ),
    );
  });
  statements.push(
    query(
      database,
      `INSERT INTO renewal_acceptances (
        id, user_id, credential_id, submission_id, accepted_at,
        acceptance_reference, official_record_attested_at,
        next_credential_id
      )
      SELECT
        ?, source.user_id, source.id, ?, ?, ?, ?, next_credential.id
      FROM credentials source
      JOIN credentials next_credential
        ON next_credential.id = ?
        AND next_credential.user_id = source.user_id
        AND next_credential.status = 'active'
      WHERE source.id = ?
        AND source.user_id = ?
        AND source.status = 'renewed'`,
      [
        acceptanceId,
        submission.id,
        acceptedAt,
        reference,
        officialRecordAttestedAt,
        nextCredentialId,
        credentialId,
        identity.userId,
      ],
    ),
    query(
      database,
      `INSERT OR IGNORE INTO xp_events (
        id, user_id, idempotency_key, event_type, points, related_type, related_id
      )
      SELECT
        ?, acceptance.user_id, ?, ?, 200, ?, acceptance.id
      FROM renewal_acceptances acceptance
      WHERE acceptance.id = ?
        AND acceptance.user_id = ?`,
      [
        crypto.randomUUID(),
        isCompliancePeriod
          ? `${identity.userId}:credential:${credentialId}:compliance-completed`
          : `${identity.userId}:credential:${credentialId}:accepted`,
        isCompliancePeriod
          ? "compliance_period_completed"
          : "renewal_accepted",
        isCompliancePeriod ? "compliance_completion" : "acceptance",
        acceptanceId,
        identity.userId,
      ],
    ),
  );

  let acceptanceResults: D1Result[];
  try {
    acceptanceResults = await database.batch(statements);
  } catch (error) {
    const racedAcceptance = await query(
      database,
      `SELECT next_credential_id AS nextCredentialId
       FROM renewal_acceptances
       WHERE credential_id = ? AND user_id = ?`,
      [credentialId, identity.userId],
    ).first<{ nextCredentialId: string }>();
    if (racedAcceptance) return racedAcceptance.nextCredentialId;
    await throwIfNextCatalogSnapshotChanged();
    const racedClassification =
      await findUnresolvedCredentialClassification(
        database,
        identity,
        credentialId,
        credential.ruleSetId,
      );
    if (racedClassification) {
      throw new RequestError(
        "Resolve every activity classification conflict before marking this renewal accepted.",
        409,
        "classification_required_before_acceptance",
      );
    }
    await assertPortalCarryoverEvidenceReady(
      database,
      identity,
      credentialId,
    );
    await assertSubmissionStillAcceptable();
    throw error;
  }
  if (
    Number(acceptanceResults[0]?.meta?.changes ?? Number.NaN) === 0
  ) {
    const racedAcceptance = await query(
      database,
      `SELECT next_credential_id AS nextCredentialId
       FROM renewal_acceptances
       WHERE credential_id = ? AND user_id = ?`,
      [credentialId, identity.userId],
    ).first<{ nextCredentialId: string }>();
    if (racedAcceptance) return racedAcceptance.nextCredentialId;
    await throwIfNextCatalogSnapshotChanged();
    const racedClassification =
      await findUnresolvedCredentialClassification(
        database,
        identity,
        credentialId,
        credential.ruleSetId,
      );
    if (racedClassification) {
      throw new RequestError(
        "Resolve every activity classification conflict before marking this renewal accepted.",
        409,
        "classification_required_before_acceptance",
      );
    }
    await assertPortalCarryoverEvidenceReady(
      database,
      identity,
      credentialId,
    );
    await assertSubmissionStillAcceptable();
    throw new RequestError(
      "The renewal changed while acceptance was being recorded. Refresh and try again.",
      409,
      "acceptance_state_changed",
    );
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
               AND credential.status IN ('active', 'submitted')
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
          )
          SELECT ?, ?, ?, 'requirement_confirmed', 20, 'requirement', ?
          FROM credential_requirements requirement
          JOIN credentials credential
            ON credential.id = requirement.credential_id
          WHERE requirement.id = ?
            AND requirement.credential_id = ?
            AND credential.user_id = ?
            AND credential.status IN ('active', 'submitted')`,
          [
            crypto.randomUUID(),
            identity.userId,
            `${identity.userId}:requirement:${requirementId}:confirmed`,
            requirementId,
            requirementId,
            credentialId,
            identity.userId,
          ],
        ),
      ];
    },
  );
  let results: D1Result[];
  try {
    results = await database.batch(statements);
  } catch (error) {
    return rethrowClosedCycleWrite(
      database,
      identity,
      credentialId,
      "This renewal cycle is closed and its requirements are frozen.",
      error,
    );
  }
  if (Number(results[0]?.meta?.changes ?? Number.NaN) === 0) {
    await assertCredentialStillMutable(
      database,
      identity,
      credentialId,
      "This renewal cycle is closed and its requirements are frozen.",
    );
  }
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
      case "updateActivityAllocationRequirements":
        id = await updateActivityAllocationRequirements(
          database,
          identity,
          body.payload,
        );
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
