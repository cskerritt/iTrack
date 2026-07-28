import { getD1 } from "@/db";
import {
  DENTAL_ADDITIONAL_TOTAL_BINDINGS,
  DENTAL_AGGREGATE_PARENT_CATEGORY_IDS,
  DENTAL_ANNUAL_REQUIREMENT_WINDOW_BINDINGS,
  DENTAL_CHECKPOINT_RULE_CATEGORY_IDS,
  DENTAL_DAILY_UNIT_LIMIT_BINDINGS,
  DENTAL_LINKED_APPLICABILITY_CATEGORY_GROUPS,
  DENTAL_PER_ACTIVITY_UNIT_LIMIT_BINDINGS,
  DENTAL_REQUIRED_SUBTYPE_CATEGORY_GROUPS,
  DENTAL_RENEWAL_TASK_COPY_BINDINGS,
} from "@/db/catalog/dental";
import { NURSING_RENEWAL_TASK_COPY_BINDINGS } from "@/db/catalog/nursing";
import {
  REHABILITATION_RENEWAL_TASK_COPY_BINDINGS,
} from "@/db/catalog/rehabilitation";
import {
  FINANCE_CERTIFICATION_RENEWAL_TASK_COPY_BINDINGS,
} from "@/db/catalog/finance-certifications";
import {
  PROFESSIONAL_CERTIFICATIONS_RENEWAL_TASK_COPY_BINDINGS,
} from "@/db/catalog/professional-certifications";
import {
  HEALTHCARE_CERTIFICATION_RENEWAL_TASK_COPY_BINDINGS,
} from "@/db/catalog/healthcare-certifications";
import {
  type RequestIdentity,
  resolveRequestIdentity,
} from "@/db/identity";
import { ensureUser, initializeDatabase } from "@/db/runtime";
import { env } from "cloudflare:workers";
import {
  isWebPushConfigured,
  sendWebPush,
} from "../../lib/pushDelivery";
import {
  validatePushEndpoint as validateBrowserPushEndpoint,
} from "../../lib/rfc8291Push";
import { loadReminderData } from "../../lib/reminders";
import {
  findRequirementIncompatibility,
  REQUIREMENT_INCOMPATIBILITIES,
} from "../../lib/requirementCompatibility";
import {
  calendarMonthsBefore,
  portalCarryoverCategoryIds,
  portalCarryoverLookbackMonths,
} from "../../lib/carryover";
import { cappedCreditTotals } from "../../lib/cappedCredit";
import {
  isFloridaMentalHealthCycle,
  nextFloridaMentalHealthCycle,
  oppositeFloridaMentalHealthRuleSetId,
} from "../../lib/floridaMentalHealth";
import { isExpandedCertificationRuleSetId } from "../../lib/expandedCertifications";

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
const CRCC_RULE_SET_PREFIX = "crcc-";
const ABVE_RULE_SET_PREFIX = "abve-";
const CRCC_PROGRAM_REFERENCE_PREFIX = "CRCC";
const ABVE_CURRENT_CYCLE_START = "2025-01-01";
const ABVE_CURRENT_CYCLE_DEADLINE = "2027-12-31";
const TEXAS_LPC_RULE_SET_ID = "tx-lpc-standard-renewal-2026-v1";
const FLORIDA_INSURANCE_RULE_SET_PREFIX = "fl-insurance-producer-";
const FLORIDA_MENTAL_HEALTH_RULE_SET_PREFIX = "fl-lcsw-lmft-lmhc-";
const FLORIDA_MENTAL_HEALTH_CREDIT_BUCKET_GROUP =
  "Florida mental-health CE credit bucket";
const NJ_PHARMACIST_CARRYOVER_CATEGORY_ID =
  "nj-pharmacist-2026-confirmed-carryover";
const NJ_PHARMACIST_CARRYOVER_OVERLAY_IDS = new Set([
  "nj-pharmacist-2026-didactic-live",
  "nj-pharmacist-2026-non-didactic",
  "nj-pharmacist-2026-law",
  "nj-pharmacist-2026-immunizer",
  "nj-pharmacist-2026-cdtm",
]);
const DENTAL_CARRYOVER_OVERLAY_IDS = new Map<string, ReadonlySet<string>>([
  [
    "nj-dentist-2026-confirmed-carryover",
    new Set([
      "nj-dentist-2026-live-interactive",
      "nj-dentist-2026-distance-learning",
      "nj-dentist-2026-other-approved-subject",
      "nj-dentist-2026-practice-management",
    ]),
  ],
  [
    "tx-dentist-2026-confirmed-carryover",
    new Set([
      "tx-dentist-2026-technical-scientific",
      "tx-dentist-2026-risk-management",
      "tx-dentist-2026-classroom-live",
    ]),
  ],
  [
    "tx-dental-hygienist-2026-confirmed-carryover",
    new Set([
      "tx-dental-hygienist-2026-technical-scientific",
      "tx-dental-hygienist-2026-risk-management",
      "tx-dental-hygienist-2026-classroom-live",
    ]),
  ],
]);
const TX_PHARMACIST_STERILE_COMPOUNDING_CATEGORY_IDS = [
  "tx-pharmacist-2026-sterile-standard",
  "tx-pharmacist-2026-sterile-high-risk",
] as const;
const TX_PHARMACIST_DTM_YEAR_WINDOWS = new Map<
  string,
  { startsAfterMonths: number; endsAfterMonths: number }
>([
  [
    "tx-pharmacist-2026-drug-therapy-management-year-1",
    { startsAfterMonths: 0, endsAfterMonths: 12 },
  ],
  [
    "tx-pharmacist-2026-drug-therapy-management-year-2",
    { startsAfterMonths: 12, endsAfterMonths: 24 },
  ],
]);
const FLORIDA_NURSING_DOMESTIC_VIOLENCE_CATEGORY_BY_RULE_SET = new Map([
  ["fl-rn-2026-v1", "fl-rn-2026-domestic-violence"],
  ["fl-lpn-2026-v1", "fl-lpn-2026-domestic-violence"],
]);
const FLORIDA_NURSING_DOMESTIC_VIOLENCE_CATEGORY_IDS = new Set(
  FLORIDA_NURSING_DOMESTIC_VIOLENCE_CATEGORY_BY_RULE_SET.values(),
);
const DENTAL_ADDITIONAL_CATEGORY_BY_RULE_SET = new Map<string, string>(
  DENTAL_ADDITIONAL_TOTAL_BINDINGS.map(
    ([ruleSetId, categoryId]) => [ruleSetId, categoryId] as const,
  ),
);
const DENTAL_ADDITIONAL_CATEGORY_IDS = new Set<string>(
  DENTAL_ADDITIONAL_CATEGORY_BY_RULE_SET.values(),
);
const DENTAL_ANNUAL_REQUIREMENT_YEAR_WINDOWS = new Map<
  string,
  { startsAfterMonths: number; endsAfterMonths: number }
>(
  DENTAL_ANNUAL_REQUIREMENT_WINDOW_BINDINGS.map(
    ([categoryId, startsAfterMonths, endsAfterMonths]) =>
      [
        categoryId,
        { startsAfterMonths, endsAfterMonths },
      ] as const,
  ),
);
const DENTAL_DAILY_UNIT_LIMIT_BY_RULE_SET = new Map<string, number>(
  DENTAL_DAILY_UNIT_LIMIT_BINDINGS,
);
const DENTAL_DAILY_UNIT_LIMIT_EPSILON = 0.000001;
const DENTAL_PER_ACTIVITY_UNIT_LIMIT_BY_CATEGORY_ID = new Map<
  string,
  number
>(
  DENTAL_PER_ACTIVITY_UNIT_LIMIT_BINDINGS,
);
const DENTAL_REQUIRED_SUBTYPES_BY_AGGREGATE_CATEGORY_ID = new Map<
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
const DENTAL_SUBTYPE_TO_AGGREGATE_CATEGORY_ID = new Map<string, string>(
  DENTAL_REQUIRED_SUBTYPE_CATEGORY_GROUPS.flatMap(
    ([aggregateCategoryId, subtypeCategoryIds]) =>
      subtypeCategoryIds.map(
        (subtypeCategoryId) =>
          [subtypeCategoryId, aggregateCategoryId] as const,
      ),
  ),
);
const DENTAL_LINKED_APPLICABILITY_CATEGORY_IDS = new Map<
  string,
  readonly string[]
>(
  DENTAL_LINKED_APPLICABILITY_CATEGORY_GROUPS.flatMap(
    (categoryIds) =>
      categoryIds.map(
        (categoryId) =>
          [
            categoryId,
            categoryIds.filter((candidateId) => candidateId !== categoryId),
          ] as const,
      ),
  ),
);
const DENTAL_AGGREGATE_PARENT_CATEGORY_ID_SET = new Set<string>(
  DENTAL_AGGREGATE_PARENT_CATEGORY_IDS,
);
const DENTAL_CHECKPOINT_RULE_CATEGORY_ID_SET = new Set<string>(
  DENTAL_CHECKPOINT_RULE_CATEGORY_IDS,
);
const DENTAL_CHECKPOINT_RULE_CATEGORY_IDS_SQL =
  DENTAL_CHECKPOINT_RULE_CATEGORY_IDS.map(
    (categoryId) => `'${categoryId.replaceAll("'", "''")}'`,
  ).join(", ");
const PHARMACIST_RENEWAL_TASK_COPY = new Map<
  string,
  readonly [review: string, progress: string, submission: string]
>([
  [
    "ca-pharmacist-2026-v1",
    [
      "Confirm Board dates, first-renewal or APP status, and the mandatory Board webinars",
      "Complete 30 hours plus law, ethics, and cultural competency, then retain every certificate",
      "Submit the California renewal and save the updated Board license record",
    ],
  ],
  [
    "tx-pharmacist-2026-v1",
    [
      "Confirm TSBP birth-month dates, initial-period status, and every held authorization",
      "Complete 30 hours, Texas law, trafficking, and every applicable certification requirement",
      "Submit the renewal under current TSBP tracking instructions and save confirmation",
    ],
  ],
  [
    "fl-pharmacist-2026-v1",
    [
      "Confirm MQA and CE Broker dates, first-renewal status, certifications, and fingerprints",
      "Complete and report the 26/2/2 credit buckets plus every applicable certification course",
      "Submit the Florida renewal and save both CE Broker and updated MQA proof",
    ],
  ],
  [
    "ny-pharmacist-2026-v1",
    [
      "Confirm NYSED registration dates, short-period proration, and CDTM participation",
      "Complete 45 hours, classify delivery mode, and finish the error and compounding topics",
      "Re-register with NYSED and save the official new registration period",
    ],
  ],
  [
    "nj-pharmacist-2026-v1",
    [
      "Confirm Board dates, first or reciprocal status, authorizations, CDTM protocols, and carryover",
      "Complete 30 credits and classify every activity by delivery mode and period source",
      "Submit the New Jersey renewal and save the updated Board license record",
    ],
  ],
  [
    "pa-pharmacist-2026-v1",
    [
      "Confirm PALS dates, graduate or reciprocity status, injectable authority, and DEA use",
      "Complete patient-safety and child-abuse training plus every applicable conditional topic",
      "Certify the Pennsylvania renewal in PALS and save the updated license record",
    ],
  ],
]);
const NURSING_RENEWAL_TASK_COPY = new Map<
  string,
  readonly [review: string, progress: string, submission: string]
>(
  NURSING_RENEWAL_TASK_COPY_BINDINGS.map(
    ([ruleSetId, review, progress, submission]) =>
      [ruleSetId, [review, progress, submission] as const] as const,
  ),
);
const DENTAL_RENEWAL_TASK_COPY = new Map<
  string,
  readonly [review: string, progress: string, submission: string]
>(
  DENTAL_RENEWAL_TASK_COPY_BINDINGS.map(
    ([ruleSetId, review, progress, submission]) =>
      [ruleSetId, [review, progress, submission] as const] as const,
  ),
);
const REHABILITATION_RENEWAL_TASK_COPY = new Map<
  string,
  readonly [review: string, progress: string, submission: string]
>(
  REHABILITATION_RENEWAL_TASK_COPY_BINDINGS.map(
    ([ruleSetId, review, progress, submission]) =>
      [ruleSetId, [review, progress, submission] as const] as const,
  ),
);
const EXPANDED_CERTIFICATION_RENEWAL_TASK_COPY = new Map<
  string,
  readonly [review: string, progress: string, submission: string]
>(
  [
    ...FINANCE_CERTIFICATION_RENEWAL_TASK_COPY_BINDINGS,
    ...PROFESSIONAL_CERTIFICATIONS_RENEWAL_TASK_COPY_BINDINGS,
    ...HEALTHCARE_CERTIFICATION_RENEWAL_TASK_COPY_BINDINGS,
  ].map(
    ([ruleSetId, review, progress, submission]) =>
      [ruleSetId, [review, progress, submission] as const] as const,
  ),
);
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
  [
    "nj-pharmacist-2026-v1",
    "Confirm Board-eligible New Jersey pharmacist carryover, then record only evidence-backed credit",
  ],
  [
    "nj-rn-2026-v1",
    "Confirm Board-eligible New Jersey RN carryover, then record only evidence-backed credit",
  ],
  [
    "nj-lpn-2026-v1",
    "Confirm Board-eligible New Jersey LPN carryover, then record only evidence-backed credit",
  ],
  [
    "nj-dentist-2026-v1",
    "Confirm Board-eligible New Jersey dentist carryover, then record only evidence-backed general credit",
  ],
  [
    "tx-dentist-2026-v1",
    "Confirm Texas classroom carryover from the one-year lookback, then record only evidence-backed credit",
  ],
  [
    "tx-dental-hygienist-2026-v1",
    "Confirm Texas classroom carryover from the one-year lookback, then record only evidence-backed credit",
  ],
]);
const REQUIREMENT_INCOMPATIBILITY_VALUES_SQL =
  REQUIREMENT_INCOMPATIBILITIES.map(
    ({ categoryIds: [firstCategoryId, secondCategoryId] }) =>
      `('${firstCategoryId.replaceAll("'", "''")}', '${secondCategoryId.replaceAll("'", "''")}')`,
  ).join(", ");

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
  // The "license-lantern:" prefix predates the iTrack product name and is
  // load-bearing: it seeds the namespace hash that names each browser's saved
  // draft key, so changing it would strand every existing draft.
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

function expectedRevisionField(payload: JsonRecord) {
  const revision = payload.expectedRevision;
  if (
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    revision < 1
  ) {
    throw new RequestError(
      "expectedRevision must be a positive integer",
      400,
      "invalid_revision",
    );
  }
  return revision;
}

function expectedCheckpointRevisionField(payload: JsonRecord) {
  const revision = payload.expectedRevision;
  if (
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    revision < 0
  ) {
    throw new RequestError(
      "expectedRevision must be a non-negative integer",
      400,
      "invalid_revision",
    );
  }
  return revision;
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
  options: {
    required?: boolean;
    context?: "nremt" | "crcc";
  } = {},
) {
  const raw = payload.requirementMatches;
  if (raw === undefined || raw === null) {
    if (options.required) {
      throw new RequestError(
        options.context === "crcc"
          ? "Enter the General, Professional Development, and Ethics portions for this CRC program."
          : "requirementMatches is required for National Registry credit.",
        409,
        options.context === "crcc"
          ? "crcc_requirement_amounts_required"
          : "nremt_requirement_amounts_required",
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
      options.context === "crcc"
        ? "Enter the CRCC-approved General, Professional Development, and Ethics amounts."
        : "Enter the National Registry component and topic credit amounts.",
      409,
      options.context === "crcc"
        ? "crcc_requirement_amounts_required"
        : "nremt_requirement_amounts_required",
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

type CrcRequirementRole =
  | "general"
  | "professional_development"
  | "ethics";

function crcRequirementRole(
  requirement: { ruleCategoryId: string | null },
): CrcRequirementRole | null {
  if (requirement.ruleCategoryId?.endsWith("-professional-development")) {
    return "professional_development";
  }
  if (requirement.ruleCategoryId?.endsWith("-general")) {
    return "general";
  }
  if (requirement.ruleCategoryId?.endsWith("-ethics")) {
    return "ethics";
  }
  return null;
}

function crcAllocationIssue(
  requirementsById: ReadonlyMap<string, NremtRequirementMetadata>,
  matches: readonly RequirementMatchInput[],
  allocatedUnits: number,
): NremtAllocationIssue | null {
  const activeRequirements = [...requirementsById.values()].filter(
    (requirement) =>
      Boolean(requirement.isActive) &&
      requirement.applicabilityStatus === "applies",
  );
  const byRole = new Map(
    activeRequirements.flatMap((requirement) =>
      crcRequirementRole(requirement)
        ? [[crcRequirementRole(requirement)!, requirement] as const]
        : [],
    ),
  );
  const expectedRoles: readonly CrcRequirementRole[] = [
    "general",
    "professional_development",
    "ethics",
  ] as const;
  if (
    expectedRoles.some(
      (role) =>
        activeRequirements.filter(
          (requirement) => crcRequirementRole(requirement) === role,
        ).length !== 1,
    )
  ) {
    return {
      code: "crcc_requirement_template_incomplete",
      message:
        "This CRC template is missing a required credit classification. Refresh the credential before recording hours.",
      unresolvedExclusiveGroups: ["CRCC CRC credit allocation"],
    };
  }
  if (
    matches.some((match) => {
      const requirement = requirementsById.get(match.requirementId);
      return (
        !requirement ||
        !Boolean(requirement.isActive) ||
        requirement.applicabilityStatus !== "applies" ||
        !crcRequirementRole(requirement)
      );
    })
  ) {
    return {
      code: "crcc_requirement_amount_invalid",
      message:
        "CRC credit amounts may use only General / Other Accepted, Professional Development, and Ethics classifications from this credential.",
      unresolvedExclusiveGroups: ["CRCC CRC credit allocation"],
    };
  }
  const amountFor = (role: CrcRequirementRole) => {
    const requirement = byRole.get(role);
    if (!requirement) return 0;
    return Number(
      matches.find(
        (match) => match.requirementId === requirement.id,
      )?.matchedUnits ?? 0,
    );
  };
  const generalUnits = amountFor("general");
  const professionalDevelopmentUnits = amountFor(
    "professional_development",
  );
  const ethicsUnits = amountFor("ethics");
  if (
    !unitsEqual(
      generalUnits + professionalDevelopmentUnits,
      allocatedUnits,
    )
  ) {
    return {
      code: "crcc_credit_type_total_invalid",
      message: `General / Other Accepted plus Professional Development must total the ${allocatedUnits} CRCC-approved hours applied to this credential.`,
      unresolvedExclusiveGroups: ["CRCC CRC credit allocation"],
    };
  }
  if (ethicsUnits > generalUnits + 0.001) {
    return {
      code: "crcc_ethics_amount_exceeds_general",
      message:
        "Ethics hours overlap General / Other Accepted CRC Credit and cannot exceed that portion of the program.",
      unresolvedExclusiveGroups: ["CRCC CRC credit allocation"],
    };
  }
  return null;
}

async function validateCrcRequirementMatches(
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
  const issue = crcAllocationIssue(
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

function crcProgramEvidenceReference(
  payload: JsonRecord,
  allocatedUnits: number,
) {
  const approvalType = textField(payload, "crcApprovalType", {
    required: true,
    max: 20,
  });
  if (
    approvalType !== "pre_approved" &&
    approvalType !== "post_approved"
  ) {
    throw new RequestError(
      "Choose whether CRCC pre-approved or post-approved the program.",
      409,
      "crcc_approval_type_required",
    );
  }
  const programReference = textField(payload, "crcProgramReference", {
    required: true,
    max: 320,
  })!;
  if (payload.crcApprovalAttested !== true) {
    throw new RequestError(
      approvalType === "pre_approved"
        ? "Confirm that the entered CRCC approval number and awarded credit types match the completion record."
        : "Confirm that CRCC approved the post-submission, the review fee is paid, and the entered credit types match the accepted result.",
      409,
      "crcc_program_approval_attestation_required",
    );
  }
  const normalizedReference = programReference
    .replace(/\s+/g, " ")
    .trim();
  if (
    approvalType === "pre_approved" &&
    !/^(?:60007|TRN)/i.test(normalizedReference)
  ) {
    throw new RequestError(
      "Enter the CRCC pre-approval number from the completion record. Current CRCC pre-approval numbers begin with 60007 or TRN.",
      409,
      "crcc_preapproval_number_invalid",
    );
  }
  if (approvalType === "post_approved" && allocatedUnits < 1) {
    throw new RequestError(
      "CRCC post-approved activities must contain at least 1 approved clock hour.",
      409,
      "crcc_post_approval_minimum_required",
    );
  }
  return `${CRCC_PROGRAM_REFERENCE_PREFIX} ${
    approvalType === "pre_approved"
      ? "pre-approved"
      : "post-approved"
  } | ${normalizedReference}`;
}

function isCrccProgramEvidenceReference(
  evidenceReference: string | null,
) {
  if (!evidenceReference) return false;
  const preApprovedPrefix =
    `${CRCC_PROGRAM_REFERENCE_PREFIX} pre-approved | `;
  if (evidenceReference.startsWith(preApprovedPrefix)) {
    return /^(?:60007|TRN)/i.test(
      evidenceReference.slice(preApprovedPrefix.length).trim(),
    );
  }
  const postApprovedPrefix =
    `${CRCC_PROGRAM_REFERENCE_PREFIX} post-approved | `;
  return (
    evidenceReference.startsWith(postApprovedPrefix) &&
    evidenceReference.slice(postApprovedPrefix.length).trim().length > 0
  );
}

function isCrccPostApprovedReference(evidenceReference: string | null) {
  return (
    evidenceReference?.startsWith(
      `${CRCC_PROGRAM_REFERENCE_PREFIX} post-approved | `,
    ) ?? false
  );
}

function crccProgramIdentity(evidenceReference: string) {
  const delimiterIndex = evidenceReference.indexOf("|");
  return evidenceReference
    .slice(delimiterIndex >= 0 ? delimiterIndex + 1 : 0)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function assertNoDuplicateCrcProgram(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
  evidenceReference: string,
  excludeActivityId?: string,
) {
  const duplicate = await query(
    database,
    `SELECT activity.id
     FROM activity_allocations allocation
     JOIN activities activity
       ON activity.id = allocation.activity_id
       AND activity.user_id = ?
       AND activity.archived_at IS NULL
     JOIN credentials credential
       ON credential.id = allocation.credential_id
       AND credential.user_id = activity.user_id
     WHERE allocation.credential_id = ?
       AND LOWER(
         TRIM(
           SUBSTR(
             activity.evidence_reference,
             INSTR(activity.evidence_reference, '|') + 1
           )
         )
       ) = ?
       AND (? IS NULL OR activity.id <> ?)
     LIMIT 1`,
    [
      identity.userId,
      credentialId,
      crccProgramIdentity(evidenceReference),
      excludeActivityId ?? null,
      excludeActivityId ?? null,
    ],
  ).first<{ id: string }>();
  if (duplicate) {
    throw new RequestError(
      "That CRCC approval or program reference is already recorded in this certification period. CRCC permits the same program to be submitted only once.",
      409,
      "crcc_duplicate_program",
    );
  }
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

async function isOwnedCrcCredential(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
) {
  const row = await query(
    database,
    `SELECT 1 AS isCrc
     FROM credentials
     WHERE id = ?
       AND user_id = ?
       AND rule_set_id LIKE 'crcc-%'`,
    [credentialId, identity.userId],
  ).first<{ isCrc: number }>();
  return Boolean(row?.isCrc);
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

function isCrccRuleSet(ruleSetId: string | null) {
  return ruleSetId?.startsWith(CRCC_RULE_SET_PREFIX) ?? false;
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

function abveAnnualStartYearField(payload: JsonRecord) {
  const year = payload.abveAnnualStartYear;
  if (
    typeof year !== "number" ||
    !Number.isInteger(year) ||
    year < 2025 ||
    year > 2027
  ) {
    throw new RequestError(
      "Choose the first year this ABVE credential was held in the current 2025–2027 cycle so annual renewal tasks start in the correct year.",
      409,
      "abve_annual_start_year_required",
    );
  }
  return year;
}

function assertRehabilitationCertificationDates(
  ruleSetId: string,
  cycleStart: string,
  deadline: string,
  payload: JsonRecord,
) {
  let abveAnnualStartYear: number | null = null;
  if (
    ruleSetId.startsWith(ABVE_RULE_SET_PREFIX) &&
    (cycleStart !== ABVE_CURRENT_CYCLE_START ||
      deadline !== ABVE_CURRENT_CYCLE_DEADLINE)
  ) {
    throw new RequestError(
      `The current ABVE Fellow and Diplomate templates cover the fixed ${ABVE_CURRENT_CYCLE_START} through ${ABVE_CURRENT_CYCLE_DEADLINE} recertification cycle.`,
      409,
      "abve_fixed_cycle_required",
    );
  }
  if (ruleSetId.startsWith(ABVE_RULE_SET_PREFIX)) {
    abveAnnualStartYear = abveAnnualStartYearField(payload);
  }
  if (
    ruleSetId.startsWith(CRCC_RULE_SET_PREFIX) &&
    !matchesFullCycleWindow(cycleStart, deadline, 60)
  ) {
    throw new RequestError(
      "The standard CRC template requires the exact five-year certification period shown in CRCCCONNECT. Create a custom plan for an extension, reinstatement, or other adjusted period.",
      409,
      "crcc_standard_cycle_required",
    );
  }
  if (payload.officialDatesAttested !== true) {
    throw new RequestError(
      ruleSetId.startsWith(ABVE_RULE_SET_PREFIX)
        ? "Confirm that the ABVE member record shows the selected Fellow or Diplomate credential and the fixed 2025–2027 cycle."
        : "Confirm that CRCCCONNECT shows the entered CRC certification period and valid-through date.",
      409,
      ruleSetId.startsWith(ABVE_RULE_SET_PREFIX)
        ? "abve_cycle_attestation_required"
        : "crcc_cycle_attestation_required",
    );
  }
  return abveAnnualStartYear;
}

function monthsBefore(isoDate: string, months: number) {
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  const targetDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(targetDay, lastDay));
  return date.toISOString().slice(0, 10);
}

function monthsAfter(isoDate: string, months: number) {
  return monthsBefore(isoDate, -months);
}

function confirmedCarryoverLookbackMonths(
  requirements: readonly { ruleCategoryId?: string | null }[],
) {
  const lookbacks = requirements.flatMap((requirement) => {
    if (!requirement.ruleCategoryId) return [];
    const months = portalCarryoverLookbackMonths(
      requirement.ruleCategoryId,
    );
    return months === null ? [] : [months];
  });
  return lookbacks.length ? Math.max(...lookbacks) : null;
}

function assertActivityDateFitsCredential(
  completionDate: string,
  credential: { cycleStart: string; deadline: string },
  requirements: readonly { ruleCategoryId?: string | null }[],
  label: "completion date" | "activity date",
) {
  const carryoverLookback = confirmedCarryoverLookbackMonths(requirements);
  if (carryoverLookback !== null) {
    const earliestCarryoverDate = monthsBefore(
      credential.cycleStart,
      carryoverLookback,
    );
    if (
      completionDate < earliestCarryoverDate ||
      completionDate >= credential.cycleStart
    ) {
      throw new RequestError(
        `Confirmed carryover must use the actual prior-cycle completion date from ${earliestCarryoverDate} through the day before ${credential.cycleStart}.`,
        409,
        "carryover_activity_outside_source_window",
      );
    }
    return;
  }
  const annualWindow = requirements
    .map((requirement) =>
      requirement.ruleCategoryId
        ? TX_PHARMACIST_DTM_YEAR_WINDOWS.get(requirement.ruleCategoryId)
        : undefined,
    )
    .find(Boolean);
  if (annualWindow) {
    const windowStart = monthsAfter(
      credential.cycleStart,
      annualWindow.startsAfterMonths,
    );
    const windowEndExclusive = monthsAfter(
      credential.cycleStart,
      annualWindow.endsAfterMonths,
    );
    const windowEndInclusive =
      credential.deadline <= windowEndExclusive
        ? credential.deadline
        : daysBefore(windowEndExclusive, 1);
    if (
      completionDate < windowStart ||
      completionDate > windowEndInclusive
    ) {
      throw new RequestError(
        `This annual drug-therapy-management requirement accepts activity from ${windowStart} through ${windowEndInclusive}.`,
        409,
        "pharmacist_annual_requirement_outside_year",
      );
    }
    return;
  }
  const dentalAnnualWindow = requirements
    .map((requirement) =>
      requirement.ruleCategoryId
        ? DENTAL_ANNUAL_REQUIREMENT_YEAR_WINDOWS.get(
            requirement.ruleCategoryId,
          )
        : undefined,
    )
    .find(Boolean);
  if (dentalAnnualWindow) {
    const windowStart = monthsAfter(
      credential.cycleStart,
      dentalAnnualWindow.startsAfterMonths,
    );
    const windowEndExclusive = monthsAfter(
      credential.cycleStart,
      dentalAnnualWindow.endsAfterMonths,
    );
    const windowEndInclusive =
      credential.deadline <= windowEndExclusive
        ? credential.deadline
        : daysBefore(windowEndExclusive, 1);
    if (
      completionDate < windowStart ||
      completionDate > windowEndInclusive
    ) {
      throw new RequestError(
        `This annual Texas dentist pain-management requirement accepts activity from ${windowStart} through ${windowEndInclusive}.`,
        409,
        "dental_annual_requirement_outside_year",
      );
    }
    return;
  }
  if (
    completionDate < credential.cycleStart ||
    completionDate > credential.deadline
  ) {
    const cycleLabel =
      label === "activity date"
        ? "the target renewal cycle"
        : "this renewal cycle";
    throw new RequestError(
      `The ${label} must fall within ${cycleLabel} (${credential.cycleStart} through ${credential.deadline}).`,
      409,
      "activity_outside_cycle",
    );
  }
}

function assertMutuallyExclusivePharmacistConditions(
  requirements: readonly {
    ruleCategoryId?: string | null;
    applicabilityStatus?: ApplicabilityStatus;
  }[],
) {
  const activeIds = new Set(
    requirements
      .filter(
        (requirement) => requirement.applicabilityStatus === "applies",
      )
      .map((requirement) => requirement.ruleCategoryId)
      .filter((id): id is string => Boolean(id)),
  );
  if (
    TX_PHARMACIST_STERILE_COMPOUNDING_CATEGORY_IDS.every((id) =>
      activeIds.has(id),
    )
  ) {
    throw new RequestError(
      "Choose either the two-hour standard sterile-compounding requirement or the four-hour higher-risk requirement, not both.",
      409,
      "conflicting_pharmacist_conditions",
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

function isManagedPharmacistCredential(
  profession: string,
  ruleSetId: string | null,
) {
  return profession === "Pharmacy" && Boolean(ruleSetId);
}

function isManagedNursingCredential(
  profession: string,
  ruleSetId: string | null,
) {
  return profession === "Nursing" && Boolean(ruleSetId);
}

function isManagedDentalCredential(
  profession: string,
  ruleSetId: string | null,
) {
  return profession === "Dental" && Boolean(ruleSetId);
}

function isManagedRehabilitationCredential(
  profession: string,
  ruleSetId: string | null,
) {
  return (
    profession === "Vocational Rehabilitation" &&
    Boolean(
      ruleSetId?.startsWith(CRCC_RULE_SET_PREFIX) ||
        ruleSetId?.startsWith(ABVE_RULE_SET_PREFIX),
    )
  );
}

function adjustedFloridaNursingTotal(
  ruleSetId: string | null,
  catalogTotal: number,
  requirements: Array<{
    ruleCategoryId: string | null;
    requiredUnits: number;
    applicabilityStatus: ApplicabilityStatus;
  }>,
) {
  if (!ruleSetId) return catalogTotal;
  const domesticViolenceCategoryId =
    FLORIDA_NURSING_DOMESTIC_VIOLENCE_CATEGORY_BY_RULE_SET.get(
      ruleSetId,
    );
  if (!domesticViolenceCategoryId) return catalogTotal;
  const domesticViolenceRequirement = requirements.find(
    (requirement) =>
      requirement.ruleCategoryId === domesticViolenceCategoryId,
  );
  return (
    catalogTotal +
    (domesticViolenceRequirement?.applicabilityStatus === "applies"
      ? Number(domesticViolenceRequirement.requiredUnits)
      : 0)
  );
}

function adjustedDentalTotal(
  ruleSetId: string | null,
  catalogTotal: number,
  requirements: Array<{
    ruleCategoryId: string | null;
    requiredUnits: number;
    applicabilityStatus: ApplicabilityStatus;
  }>,
) {
  if (!ruleSetId) return catalogTotal;
  const additionalCategoryId =
    DENTAL_ADDITIONAL_CATEGORY_BY_RULE_SET.get(ruleSetId);
  if (!additionalCategoryId) return catalogTotal;
  const additionalRequirement = requirements.find(
    (requirement) =>
      requirement.ruleCategoryId === additionalCategoryId,
  );
  return (
    catalogTotal +
    (additionalRequirement?.applicabilityStatus === "applies"
      ? Number(additionalRequirement.requiredUnits)
      : 0)
  );
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
  options: { abveAnnualStartYear?: number } = {},
) {
  const pharmacistTaskCopy = ruleSetId
    ? PHARMACIST_RENEWAL_TASK_COPY.get(ruleSetId)
    : null;
  const nursingTaskCopy = ruleSetId
    ? NURSING_RENEWAL_TASK_COPY.get(ruleSetId)
    : null;
  const dentalTaskCopy = ruleSetId
    ? DENTAL_RENEWAL_TASK_COPY.get(ruleSetId)
    : null;
  const rehabilitationTaskCopy = ruleSetId
    ? (REHABILITATION_RENEWAL_TASK_COPY.get(ruleSetId) ??
      (ruleSetId.startsWith(CRCC_RULE_SET_PREFIX)
        ? [...REHABILITATION_RENEWAL_TASK_COPY].find(([candidateId]) =>
            candidateId.startsWith(CRCC_RULE_SET_PREFIX),
          )?.[1]
        : null))
    : null;
  const expandedCertificationTaskCopy = ruleSetId
    ? EXPANDED_CERTIFICATION_RENEWAL_TASK_COPY.get(ruleSetId)
    : null;
  if (
    rehabilitationTaskCopy &&
    ruleSetId?.startsWith(ABVE_RULE_SET_PREFIX)
  ) {
    const credentialLabel = ruleSetId.startsWith("abve-fellow-")
      ? "Fellow"
      : "Diplomate";
    const annualTask = (year: number) => ({
      title: `Renew ABVE membership and ${credentialLabel} credential, pay annual fees, and reaffirm the Code of Ethics for ${year}`,
      kind: "review",
      dueDate: `${year}-12-31`,
    });
    const annualStartYear = options.abveAnnualStartYear ?? 2025;
    return [
      ...[2025, 2026]
        .filter((year) => year >= annualStartYear)
        .map(annualTask),
      {
        title: rehabilitationTaskCopy[1],
        kind: "progress",
        dueDate: daysBefore(deadline, 56),
      },
      ...(annualStartYear <= 2027 ? [annualTask(2027)] : []),
      {
        title: rehabilitationTaskCopy[2],
        kind: "submission",
        dueDate: deadline,
      },
    ];
  }
  const managedTaskCopy =
    pharmacistTaskCopy ??
    nursingTaskCopy ??
    dentalTaskCopy ??
    rehabilitationTaskCopy ??
    expandedCertificationTaskCopy;
  if (managedTaskCopy) {
    const isTexasNursing =
      ruleSetId === "tx-rn-2026-v1" ||
      ruleSetId === "tx-lvn-2026-v1";
    const submissionTitle =
      isTexasNursing
        ? deadline < "2026-09-01"
          ? "Renew in the Nurse Portal and save confirmation; keep certificates ready for audit"
          : "Upload all required verification in the Nurse Portal before renewing, then save confirmation"
        : managedTaskCopy[2];
    return [
      {
        title: reviewTitle ?? managedTaskCopy[0],
        kind: "review",
        dueDate: daysBefore(deadline, 120),
      },
      {
        title: managedTaskCopy[1],
        kind: "progress",
        dueDate: daysBefore(deadline, 30),
      },
      {
        title: submissionTitle,
        kind: "submission",
        dueDate: deadline,
      },
    ];
  }
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
const WEEKLY_GOAL_PRESETS = new Set([1, 3, 4, 5, 7]);

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

type WeeklyProgressionPeriodRow = {
  weekStart: string;
  weeklyGoal: number;
  timeZone: string;
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
  nextWeeklyGoal?: number;
  nextWeeklyGoalEffectiveOn?: string;
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

function isValidIsoCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function progressionGoal(value: unknown) {
  const goal = Number(value);
  return Number.isInteger(goal) && goal >= 1 && goal <= 20 ? goal : 4;
}

async function getOrCreateCurrentProgressionPeriod(
  database: D1Database,
  identity: RequestIdentity,
) {
  const [profile, preference, latestPeriod] = await Promise.all([
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
      `SELECT time_zone AS timeZone
       FROM reminder_preferences
       WHERE user_id = ?`,
      [identity.userId],
    ).first<{ timeZone: string }>(),
    query(
      database,
      `SELECT
        week_start AS weekStart,
        weekly_goal AS weeklyGoal,
        time_zone AS timeZone
       FROM weekly_progression_periods
       WHERE user_id = ?
       ORDER BY week_start DESC
       LIMIT 1`,
      [identity.userId],
    ).first<WeeklyProgressionPeriodRow>(),
  ]);

  const desiredWeeklyGoal = progressionGoal(profile?.weeklyGoal);
  const lifetimeXp = Math.max(0, Number(profile?.lifetimeXp ?? 0));
  if (
    latestPeriod &&
    isValidIsoCalendarDate(latestPeriod.weekStart) &&
    validTimeZone(latestPeriod.timeZone)
  ) {
    const today = todayInTimeZone(latestPeriod.timeZone);
    if (
      today >= latestPeriod.weekStart &&
      today <= daysAfter(latestPeriod.weekStart, 6)
    ) {
      return {
        desiredWeeklyGoal,
        lifetimeXp,
        period: {
          ...latestPeriod,
          weeklyGoal: progressionGoal(latestPeriod.weeklyGoal),
        },
      };
    }
  }

  const timeZone =
    preference?.timeZone && validTimeZone(preference.timeZone)
      ? preference.timeZone
      : "UTC";
  const attemptedPeriod: WeeklyProgressionPeriodRow = {
    weekStart: weekStartForDate(todayInTimeZone(timeZone)),
    weeklyGoal: desiredWeeklyGoal,
    timeZone,
  };
  await query(
    database,
    `INSERT OR IGNORE INTO weekly_progression_periods (
      user_id, week_start, weekly_goal, time_zone
    ) VALUES (?, ?, ?, ?)`,
    [
      identity.userId,
      attemptedPeriod.weekStart,
      attemptedPeriod.weeklyGoal,
      attemptedPeriod.timeZone,
    ],
  ).run();
  const storedPeriod = await query(
    database,
    `SELECT
      week_start AS weekStart,
      weekly_goal AS weeklyGoal,
      time_zone AS timeZone
     FROM weekly_progression_periods
     WHERE user_id = ? AND week_start = ?`,
    [identity.userId, attemptedPeriod.weekStart],
  ).first<WeeklyProgressionPeriodRow>();

  return {
    desiredWeeklyGoal,
    lifetimeXp,
    period: storedPeriod
      ? {
          ...storedPeriod,
          weeklyGoal: progressionGoal(storedPeriod.weeklyGoal),
        }
      : attemptedPeriod,
  };
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
  const { desiredWeeklyGoal, lifetimeXp, period } =
    await getOrCreateCurrentProgressionPeriod(database, identity);
  const [actions, claims, context] = await Promise.all([
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
            AND task.archived_at IS NULL
            AND task.is_personal = 0
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
            AND activity.archived_at IS NULL
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

  const { timeZone, weekStart: currentWeekStart, weeklyGoal } = period;
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
    ...(desiredWeeklyGoal !== weeklyGoal
      ? {
          nextWeeklyGoal: desiredWeeklyGoal,
          nextWeeklyGoalEffectiveOn: daysAfter(currentWeekStart, 7),
        }
      : {}),
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

async function getReminderData(
  database: D1Database,
  identity: RequestIdentity,
) {
  const shared = await loadReminderData(database, identity.userId, {
    channel: "in_app",
  });
  const publicKey =
    typeof env.VAPID_PUBLIC_KEY === "string"
      ? env.VAPID_PUBLIC_KEY.trim()
      : "";
  return {
    reminderPreferences: {
      ...shared.reminderPreferences,
      webPushConfigured: isWebPushConfigured({
        publicKey: publicKey || undefined,
        privateKey:
          typeof env.VAPID_PRIVATE_KEY === "string"
            ? env.VAPID_PRIVATE_KEY
            : undefined,
        subject:
          typeof env.VAPID_SUBJECT === "string"
            ? env.VAPID_SUBJECT
            : undefined,
      }),
      vapidPublicKey: publicKey || null,
    },
    reminders: shared.reminders,
  };
}

function estimatedCycleMonths(cycleStart: string, deadline: string) {
  const start = new Date(`${cycleStart}T00:00:00.000Z`).getTime();
  const end = new Date(`${deadline}T00:00:00.000Z`).getTime();
  const averageMonthMs = (365.2425 / 12) * 86_400_000;
  return Math.max(1, Math.round((end - start) / averageMonthMs));
}

function matchesFullCycleWindow(
  cycleStart: string,
  deadline: string,
  cycleMonths: number,
) {
  const nextCycleBoundary = monthsAfter(cycleStart, cycleMonths);
  const fixedFebruary28LeapCycle =
    nextCycleBoundary.endsWith("-03-01") &&
    daysBefore(nextCycleBoundary, 1).endsWith("-02-29") &&
    deadline === daysBefore(nextCycleBoundary, 2);
  return (
    deadline === nextCycleBoundary ||
    deadline === daysBefore(nextCycleBoundary, 1) ||
    fixedFebruary28LeapCycle
  );
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
        requirement.ruleCategoryId !== null &&
        DENTAL_CHECKPOINT_RULE_CATEGORY_ID_SET.has(
          requirement.ruleCategoryId,
        ),
    )
  ) {
    throw new RequestError(
      "Complete dental checkpoints in the checklist. Do not use them as CE activity tags; record any separately countable course hours under the applicable credit classifications.",
      409,
      "dental_checkpoint_activity_tag_not_allowed",
    );
  }
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
  if (
    selectedRequirements.some(
      (requirement) =>
        requirement.ruleCategoryId !== null &&
        DENTAL_AGGREGATE_PARENT_CATEGORY_ID_SET.has(
          requirement.ruleCategoryId,
        ),
    )
  ) {
    throw new RequestError(
      "Classify Texas pain-management credit to the first or second renewal year. The four-hour biennial parent is calculated automatically from those annual entries.",
      409,
      "dental_annual_child_category_required",
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

function assertDentalPerActivityRequirements(
  selectedRequirements: readonly {
    ruleCategoryId: string | null;
  }[],
  allocatedUnits: number,
) {
  const selectedCategoryIds = new Set(
    selectedRequirements.flatMap((requirement) =>
      requirement.ruleCategoryId ? [requirement.ruleCategoryId] : [],
    ),
  );
  for (const [
    aggregateCategoryId,
    subtypeCategoryIds,
  ] of DENTAL_REQUIRED_SUBTYPES_BY_AGGREGATE_CATEGORY_ID) {
    const aggregateSelected = selectedCategoryIds.has(aggregateCategoryId);
    const selectedSubtypeIds = [...subtypeCategoryIds].filter(
      (subtypeCategoryId) =>
        selectedCategoryIds.has(subtypeCategoryId),
    );
    if (aggregateSelected && selectedSubtypeIds.length !== 1) {
      throw new RequestError(
        "Choose exactly one New York cardiopulmonary course subtype with the combined CPR/BLS/ACLS/PALS classification.",
        409,
        "dental_cardiopulmonary_subtype_required",
      );
    }
    if (!aggregateSelected && selectedSubtypeIds.length > 0) {
      throw new RequestError(
        "A New York cardiopulmonary course subtype must also use the combined CPR/BLS/ACLS/PALS classification.",
        409,
        "dental_cardiopulmonary_aggregate_required",
      );
    }
    const perActivityLimit = selectedSubtypeIds
      .map((subtypeCategoryId) =>
        DENTAL_PER_ACTIVITY_UNIT_LIMIT_BY_CATEGORY_ID.get(
          subtypeCategoryId,
        ),
      )
      .find((limit) => limit !== undefined);
    if (
      perActivityLimit !== undefined &&
      allocatedUnits > perActivityLimit
    ) {
      throw new RequestError(
        `This New York cardiopulmonary course subtype may contribute no more than ${perActivityLimit} hours from one course record. Preserve the full activity total, but reduce the amount allocated to this credential.`,
        409,
        "dental_per_activity_unit_limit_exceeded",
      );
    }
  }
  for (const selectedCategoryId of selectedCategoryIds) {
    const aggregateCategoryId =
      DENTAL_SUBTYPE_TO_AGGREGATE_CATEGORY_ID.get(selectedCategoryId);
    if (
      aggregateCategoryId &&
      !selectedCategoryIds.has(aggregateCategoryId)
    ) {
      throw new RequestError(
        "A New York cardiopulmonary course subtype must also use the combined CPR/BLS/ACLS/PALS classification.",
        409,
        "dental_cardiopulmonary_aggregate_required",
      );
    }
  }
}

async function assertDentalDailyUnitLimit(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
  ruleSetId: string | null | undefined,
  completionDate: string,
  proposedAllocatedUnits: number,
  excludeActivityId?: string,
) {
  const resolvedRuleSetId =
    ruleSetId === undefined
      ? (
          await query(
            database,
            `SELECT rule_set_id AS ruleSetId
             FROM credentials
             WHERE id = ? AND user_id = ?`,
            [credentialId, identity.userId],
          ).first<{ ruleSetId: string | null }>()
        )?.ruleSetId ?? null
      : ruleSetId;
  const dailyLimit = resolvedRuleSetId
    ? DENTAL_DAILY_UNIT_LIMIT_BY_RULE_SET.get(resolvedRuleSetId)
    : undefined;
  if (dailyLimit === undefined) return;
  const existing = await query(
    database,
    `SELECT COALESCE(SUM(allocation.allocated_units), 0) AS allocatedUnits
     FROM activity_allocations allocation
     JOIN activities activity
       ON activity.id = allocation.activity_id
       AND activity.user_id = ?
       AND activity.archived_at IS NULL
     JOIN credentials credential
       ON credential.id = allocation.credential_id
       AND credential.user_id = activity.user_id
     WHERE allocation.credential_id = ?
       AND activity.completion_date = ?
       AND (? IS NULL OR activity.id <> ?)`,
    [
      identity.userId,
      credentialId,
      completionDate,
      excludeActivityId ?? null,
      excludeActivityId ?? null,
    ],
  ).first<{ allocatedUnits: number }>();
  const alreadyAllocated = Number(existing?.allocatedUnits ?? 0);
  if (
    alreadyAllocated + proposedAllocatedUnits <=
    dailyLimit + DENTAL_DAILY_UNIT_LIMIT_EPSILON
  ) {
    return;
  }
  const remaining = Math.max(
    0,
    Math.round((dailyLimit - alreadyAllocated) * 100) / 100,
  );
  throw new RequestError(
    `California permits no more than ${dailyLimit} countable CE units on one completion date. Preserve the full learning record, but allocate no more than ${remaining} additional units to this credential for ${completionDate}.`,
    409,
    "dental_daily_unit_limit_exceeded",
  );
}

async function assertDentalDailyTotalsWithinLimit(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
  ruleSetId: string | null,
) {
  const dailyLimit = ruleSetId
    ? DENTAL_DAILY_UNIT_LIMIT_BY_RULE_SET.get(ruleSetId)
    : undefined;
  if (dailyLimit === undefined) return;
  const violation = await query(
    database,
    `SELECT
      activity.completion_date AS completionDate,
      SUM(allocation.allocated_units) AS allocatedUnits
     FROM activity_allocations allocation
     JOIN activities activity
       ON activity.id = allocation.activity_id
       AND activity.user_id = ?
       AND activity.archived_at IS NULL
     JOIN credentials credential
       ON credential.id = allocation.credential_id
       AND credential.user_id = activity.user_id
     WHERE allocation.credential_id = ?
     GROUP BY activity.completion_date
     HAVING SUM(allocation.allocated_units) > ? + ?
     ORDER BY activity.completion_date
     LIMIT 1`,
    [
      identity.userId,
      credentialId,
      dailyLimit,
      DENTAL_DAILY_UNIT_LIMIT_EPSILON,
    ],
  ).first<{ completionDate: string; allocatedUnits: number }>();
  if (!violation) return;
  throw new RequestError(
    `Only ${dailyLimit} California CE units may count on ${violation.completionDate}; ${Number(violation.allocatedUnits)} are currently allocated. Reduce the countable allocation while preserving the full learning record.`,
    409,
    "dental_daily_unit_limit_exceeded",
  );
}

async function assertDentalPerActivityClassificationsReady(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
  ruleSetId: string | null,
) {
  if (!ruleSetId?.startsWith("ny-dent")) return;
  const rows = await query(
    database,
    `WITH selected_requirement AS (
       SELECT
         match.allocation_id AS allocation_id,
         requirement.rule_category_id AS rule_category_id
       FROM activity_requirement_matches match
       JOIN credential_requirements requirement
         ON requirement.id = match.requirement_id
       JOIN activity_allocations allocation
         ON allocation.id = match.allocation_id
       WHERE allocation.credential_id = ?
         AND match.user_id = ?
       UNION
       SELECT
         allocation.id AS allocation_id,
         requirement.rule_category_id AS rule_category_id
       FROM activity_allocations allocation
       JOIN credential_requirements requirement
         ON requirement.id = allocation.requirement_id
       WHERE allocation.credential_id = ?
         AND NOT EXISTS (
           SELECT 1
           FROM activity_requirement_matches existing_match
           WHERE existing_match.allocation_id = allocation.id
             AND existing_match.user_id = ?
         )
     )
     SELECT
       allocation.id AS allocationId,
       allocation.allocated_units AS allocatedUnits,
       selected_requirement.rule_category_id AS ruleCategoryId
     FROM activity_allocations allocation
     JOIN activities activity
       ON activity.id = allocation.activity_id
       AND activity.user_id = ?
       AND activity.archived_at IS NULL
     LEFT JOIN selected_requirement
       ON selected_requirement.allocation_id = allocation.id
     WHERE allocation.credential_id = ?
     ORDER BY allocation.id, selected_requirement.rule_category_id`,
    [
      credentialId,
      identity.userId,
      credentialId,
      identity.userId,
      identity.userId,
      credentialId,
    ],
  ).all<{
    allocationId: string;
    allocatedUnits: number;
    ruleCategoryId: string | null;
  }>();
  const byAllocation = new Map<
    string,
    { allocatedUnits: number; categoryIds: Set<string> }
  >();
  for (const row of rows.results) {
    const allocation =
      byAllocation.get(row.allocationId) ?? {
        allocatedUnits: Number(row.allocatedUnits),
        categoryIds: new Set<string>(),
      };
    if (row.ruleCategoryId) {
      allocation.categoryIds.add(row.ruleCategoryId);
    }
    byAllocation.set(row.allocationId, allocation);
  }
  for (const allocation of byAllocation.values()) {
    assertDentalPerActivityRequirements(
      [...allocation.categoryIds].map((ruleCategoryId) => ({
        ruleCategoryId,
      })),
      allocation.allocatedUnits,
    );
  }
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
    portalCarryoverLookbackMonths(requirement.ruleCategoryId),
  );
  const carryoverSelectionCount = policies.filter(
    (lookbackMonths) => lookbackMonths !== null,
  ).length;
  const isNewJerseyPharmacistCarryoverSelection =
    selectedRequirements.some(
      (requirement) =>
        requirement.ruleCategoryId ===
        NJ_PHARMACIST_CARRYOVER_CATEGORY_ID,
    ) &&
    selectedRequirements.every(
      (requirement) =>
        requirement.ruleCategoryId ===
          NJ_PHARMACIST_CARRYOVER_CATEGORY_ID ||
        NJ_PHARMACIST_CARRYOVER_OVERLAY_IDS.has(
          requirement.ruleCategoryId ?? "",
        ),
    );
  const selectedDentalCarryoverCategoryId =
    selectedRequirements.find(
      (requirement) =>
        requirement.ruleCategoryId !== null &&
        DENTAL_CARRYOVER_OVERLAY_IDS.has(requirement.ruleCategoryId),
    )?.ruleCategoryId ?? null;
  const dentalCarryoverOverlayIds = selectedDentalCarryoverCategoryId
    ? DENTAL_CARRYOVER_OVERLAY_IDS.get(selectedDentalCarryoverCategoryId)
    : null;
  const isSupportedDentalCarryoverSelection = Boolean(
    selectedDentalCarryoverCategoryId &&
      dentalCarryoverOverlayIds &&
      carryoverSelectionCount === 1 &&
      selectedRequirements.every(
        (requirement) =>
          requirement.ruleCategoryId ===
            selectedDentalCarryoverCategoryId ||
          dentalCarryoverOverlayIds.has(
            requirement.ruleCategoryId ?? "",
          ),
      ),
  );
  if (
    carryoverSelectionCount > 0 &&
    carryoverSelectionCount !== selectedRequirements.length &&
    !isNewJerseyPharmacistCarryoverSelection &&
    !isSupportedDentalCarryoverSelection
  ) {
    throw new RequestError(
      "An evidence-backed carryover entry cannot be mixed with current-period requirements except its required classification tags.",
      409,
      "mixed_carryover_requirement_tags",
    );
  }
  if (carryoverSelectionCount === 0) {
    if (completionDate >= cycleStart) return;
    throw new RequestError(
      `The activity date must fall within the target renewal cycle (${cycleStart} through ${deadline}). A prior-period date is allowed only with the evidence-backed carryover source and its compatible classification tags.`,
      409,
      "activity_outside_cycle",
    );
  }
  if (completionDate >= cycleStart) {
    throw new RequestError(
      "Evidence-backed carryover must use the actual eligible prior-period completion date, not a date inside the current cycle.",
      409,
      "carryover_requires_prior_period_date",
    );
  }
  const earliestEligibleDate = policies.reduce(
    (latest, lookbackMonths) => {
      if (lookbackMonths === null) return latest;
      const candidate = calendarMonthsBefore(
        cycleStart,
        lookbackMonths,
      );
      return candidate > latest ? candidate : latest;
    },
    "0000-01-01",
  );
  if (completionDate < earliestEligibleDate) {
    throw new RequestError(
      `This carryover must have been earned between ${earliestEligibleDate} and ${daysBefore(cycleStart, 1)}. Use the actual prior-period date and only the regulator-eligible amount for this consecutive cycle.`,
      409,
      "carryover_outside_eligible_lookback",
    );
  }
  if (!options.portalCarryoverAttested) {
    throw new RequestError(
      "Confirm that the issuing authority permits this carryover and that the recorded amount, date, and source are eligible for the current consecutive period.",
      409,
      "portal_carryover_attestation_required",
    );
  }
  if (options.evidenceStatus === "not_required") {
    throw new RequestError(
      "Evidence-backed carryover requires an authority reference or uploaded proof before the cycle can be completed.",
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
       AND activity.archived_at IS NULL
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
      "Add an issuing-authority reference or upload supporting proof for every prior-period carryover activity before completing this cycle.",
      409,
      "portal_carryover_evidence_required",
    );
  }
}

async function findUnresolvedExactClassification(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
  exactKind: "nremt" | "crcc",
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
           AND activity.archived_at IS NULL
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
           AND activity.archived_at IS NULL
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
    const issue =
      exactKind === "nremt"
        ? nremtAllocationIssue(
            requirementsById,
            matches,
            Number(allocation.allocatedUnits),
          )
        : crcAllocationIssue(
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
  if (isNremtRuleSet(ruleSetId) || isCrccRuleSet(ruleSetId)) {
    return findUnresolvedExactClassification(
      database,
      identity,
      credentialId,
      isCrccRuleSet(ruleSetId) ? "crcc" : "nremt",
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
           AND activity.archived_at IS NULL
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
           AND activity.archived_at IS NULL
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
        COALESCE(
          SUM(
            CASE
              WHEN activity.id IS NULL THEN 0
              ELSE MIN(
                allocation.allocated_units,
                activity.total_units
              )
            END
          ),
          0
        ) AS totalEarned,
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
        AND activity.archived_at IS NULL
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
        AND activity.archived_at IS NULL
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
      `iTrack records ${Number(total.totalEarned)} of ${Number(total.totalRequired)} required National Registry credits. Complete the local total before submitting.`,
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
  const errorMessage = error instanceof Error ? error.message : "";
  if (errorMessage.includes("activity_requirement_inactive")) {
    throw new RequestError(
      "A selected requirement changed while this activity was being saved. Refresh the plan, confirm the requirement still applies, and try again.",
      409,
      "requirement_inactive",
    );
  }
  await assertCredentialStillMutable(
    database,
    identity,
    credentialId,
    message,
  );
  throw error;
}

type CatalogRuleRow = {
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

type CatalogCategoryRow = {
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

// The catalog is global seed data, and every current template plus its
// categories serializes to roughly 700 KB. The workspace read runs on every
// load and after every mutation, so it selects only the templates one user's
// own credentials can reach: the exact template a credential was built from,
// the current template sharing its stable key (the same-level National
// Registry rollover the acceptance dialog names), and the sibling Florida
// families whose next-period template that dialog asks the user to choose.
// The full searchable catalog is served separately by GET /api/catalog.
const WORKSPACE_SCOPED_RULE_SET_IDS_SQL = `SELECT scoped_rule.id
       FROM rule_sets scoped_rule
       WHERE scoped_rule.is_current = 1
         AND EXISTS (
           SELECT 1
           FROM credentials owned_credential
           LEFT JOIN rule_sets owned_rule
             ON owned_rule.id = owned_credential.rule_set_id
           WHERE owned_credential.user_id = ?
             AND owned_credential.rule_set_id IS NOT NULL
             AND (
               owned_credential.rule_set_id = scoped_rule.id
               OR owned_rule.stable_key = scoped_rule.stable_key
               OR (
                 scoped_rule.id LIKE '${FLORIDA_INSURANCE_RULE_SET_PREFIX}%'
                 AND owned_credential.rule_set_id LIKE '${FLORIDA_INSURANCE_RULE_SET_PREFIX}%'
               )
               OR (
                 scoped_rule.id LIKE '${FLORIDA_MENTAL_HEALTH_RULE_SET_PREFIX}%'
                 AND owned_credential.rule_set_id LIKE '${FLORIDA_MENTAL_HEALTH_RULE_SET_PREFIX}%'
               )
             )
         )`;
const CURRENT_RULE_SET_IDS_SQL = `SELECT id FROM rule_sets WHERE is_current = 1`;

// Pass a userId to scope the catalog to that user's own templates; pass null
// for the whole current catalog served by GET /api/catalog.
async function loadRuleCatalog(database: D1Database, userId: string | null) {
  const ruleSetIdsSql = userId
    ? WORKSPACE_SCOPED_RULE_SET_IDS_SQL
    : CURRENT_RULE_SET_IDS_SQL;
  const bindings = userId ? [userId] : [];
  const [ruleResult, categoryResult] = await Promise.all([
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
      WHERE id IN (${ruleSetIdsSql})
      ORDER BY profession, credential_name, jurisdiction`,
      bindings,
    ).all<CatalogRuleRow>(),
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
      WHERE rule_set_id IN (${ruleSetIdsSql})
      ORDER BY rule_set_id, sort_order, name`,
      bindings,
    ).all<CatalogCategoryRow>(),
  ]);

  const categoriesByRule = new Map<string, CatalogCategoryRow[]>();
  for (const category of categoryResult.results) {
    const existing = categoriesByRule.get(category.ruleSetId) ?? [];
    existing.push({
      ...category,
      requiredUnits: Number(category.requiredUnits),
    });
    categoriesByRule.set(category.ruleSetId, existing);
  }

  return ruleResult.results.map((rule) => ({
    ...rule,
    totalUnits: Number(rule.totalUnits),
    cycleMonths: Number(rule.cycleMonths),
    version: Number(rule.version),
    categories: categoriesByRule.get(rule.id) ?? [],
  }));
}

export async function getRuleCatalog(database: D1Database) {
  return loadRuleCatalog(database, null);
}

export async function getWorkspace(
  database: D1Database,
  identity: RequestIdentity,
) {
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
    submissionAttestationKind: string | null;
    acceptedAt: string | null;
    acceptanceReference: string | null;
    officialRecordAttestedAt: string | null;
    nextCredentialId: string | null;
    sourceUrl: string | null;
    sourceTitle: string | null;
    ruleEffectiveDate: string | null;
    ruleLastVerifiedAt: string | null;
    ruleReviewStatus: string;
    ruleVersion: number | null;
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
    isDentalCheckpoint: boolean;
    checkpointStatus: "pending" | "completed" | null;
    checkpointCompletedAt: string | null;
    checkpointEvidenceNote: string | null;
    checkpointRevision: number;
  };
  type DentalCheckpointStateRow = {
    requirementId: string;
    status: "pending" | "completed";
    completedAt: string | null;
    evidenceNote: string | null;
    revision: number;
  };
  type TaskRow = {
    id: string;
    credentialId: string;
    title: string;
    kind: string;
    status: string;
    dueDate: string | null;
    completedAt: string | null;
    revision: number;
    isPersonal: number;
    archivedAt: string | null;
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
    evidenceDeletionPendingCount: number;
    revision: number;
    archivedAt: string | null;
    updatedAt: string;
    allocationId: string | null;
    credentialId: string | null;
    credentialName: string | null;
    credentialRuleSetId: string | null;
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
    archivedAt: string | null;
  };
  type BadgeRow = {
    id: string;
    name: string;
    description: string;
    icon: string;
    earnedAt: string | null;
  };

  const [
    catalog,
    credentialResult,
    requirementResult,
    dentalCheckpointStateResult,
    taskResult,
    activityResult,
    activityMatchResult,
    progression,
    badgeResult,
  ] = await Promise.all([
    loadRuleCatalog(database, identity.userId),
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
        rs.effective_date AS ruleEffectiveDate,
        rs.last_verified_at AS ruleLastVerifiedAt,
        COALESCE(rs.review_status, 'custom') AS ruleReviewStatus,
        rs.version AS ruleVersion,
        sub.submitted_at AS submittedAt,
        sub.confirmation_number AS confirmationNumber,
        sub.proof_reference AS submissionProof,
        sub.attestation_kind AS submissionAttestationKind,
        acceptance.accepted_at AS acceptedAt,
        acceptance.acceptance_reference AS acceptanceReference,
        acceptance.official_record_attested_at AS officialRecordAttestedAt,
        acceptance.next_credential_id AS nextCredentialId,
        COALESCE(
          SUM(
            CASE
              WHEN counted_activity.id IS NULL THEN 0
              ELSE MIN(
                alloc.allocated_units,
                counted_activity.total_units
              )
            END
          ),
          0
        ) AS totalEarned
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
      LEFT JOIN activities counted_activity
        ON counted_activity.id = alloc.activity_id
        AND counted_activity.user_id = c.user_id
        AND counted_activity.archived_at IS NULL
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
        AND activity.archived_at IS NULL
      WHERE c.user_id = ?
      GROUP BY req.id
      ORDER BY req.credential_id, req.sort_order, req.name`,
      [identity.userId],
    ).all<RequirementRow>(),
    query(
      database,
      `SELECT
        checkpoint.requirement_id AS requirementId,
        checkpoint.status,
        checkpoint.completed_at AS completedAt,
        checkpoint.evidence_note AS evidenceNote,
        checkpoint.revision
      FROM dental_checkpoint_states checkpoint
      JOIN credentials credential
        ON credential.id = checkpoint.credential_id
      JOIN credential_requirements requirement
        ON requirement.id = checkpoint.requirement_id
        AND requirement.credential_id = checkpoint.credential_id
      WHERE checkpoint.user_id = ?
        AND credential.user_id = checkpoint.user_id
      ORDER BY checkpoint.credential_id, requirement.sort_order`,
      [identity.userId],
    ).all<DentalCheckpointStateRow>(),
    query(
      database,
      `SELECT
        id,
        credential_id AS credentialId,
        title,
        kind,
        status,
        due_date AS dueDate,
        completed_at AS completedAt,
        revision,
        is_personal AS isPersonal,
        archived_at AS archivedAt
      FROM checklist_tasks
      WHERE user_id = ?
      ORDER BY
        credential_id,
        CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END,
        sort_order,
        due_date`,
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
        a.revision,
        a.archived_at AS archivedAt,
        a.updated_at AS updatedAt,
        (
          SELECT COUNT(*)
          FROM evidence_files stored
          WHERE stored.activity_id = a.id
            AND stored.user_id = a.user_id
            AND stored.status = 'ready'
        ) AS evidenceCount,
        (
          SELECT COUNT(*)
          FROM evidence_files deleting
          WHERE deleting.activity_id = a.id
            AND deleting.user_id = a.user_id
            AND deleting.status = 'deleting'
        ) AS evidenceDeletionPendingCount,
        CASE WHEN c.id IS NULL THEN NULL ELSE alloc.id END AS allocationId,
        c.id AS credentialId,
        c.credential_name AS credentialName,
        c.rule_set_id AS credentialRuleSetId,
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
      ORDER BY
        CASE WHEN a.archived_at IS NULL THEN 0 ELSE 1 END,
        a.completion_date DESC,
        a.created_at DESC`,
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
        activity.archived_at AS archivedAt,
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

  const requirementMetadataById = new Map(
    requirementResult.results.map((requirement) => [
      requirement.id,
      requirement,
    ]),
  );
  const dentalCheckpointStateByRequirementId = new Map(
    dentalCheckpointStateResult.results.map((checkpoint) => [
      checkpoint.requirementId,
      checkpoint,
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

    if (match.archivedAt) continue;
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
      activity.archivedAt ||
      !activity.allocationId ||
      !activity.credentialId ||
      !credential ||
      !["active", "submitted"].includes(credential.status) ||
      classificationIssueByAllocation.has(activity.allocationId)
    ) {
      continue;
    }
    if (
      isNremtRuleSet(credential.ruleSetId) ||
      isCrccRuleSet(credential.ruleSetId)
    ) {
      const exactRequirementsById = new Map(
        requirementResult.results
          .filter(
            (requirement) =>
              requirement.credentialId === activity.credentialId,
          )
          .map((requirement) => [requirement.id, requirement]),
      );
      const exactMatches = (
        matchesByAllocation.get(activity.allocationId) ?? []
      ).map((match) => ({
        requirementId: match.requirementId,
        matchedUnits: match.matchedUnits,
      }));
      const exactIssue = isNremtRuleSet(credential.ruleSetId)
        ? nremtAllocationIssue(
            exactRequirementsById,
            exactMatches,
            Number(activity.allocatedUnits),
          )
        : crcAllocationIssue(
            exactRequirementsById,
            exactMatches,
            Number(activity.allocatedUnits),
          );
      if (!exactIssue) continue;
      const issue = {
        allocationId: activity.allocationId,
        activityId: activity.id,
        activityTitle: activity.title,
        unresolvedExclusiveGroups:
          exactIssue.unresolvedExclusiveGroups,
        allocatedUnits: Number(activity.allocatedUnits),
        classificationMessage: exactIssue.message,
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
    if (match.archivedAt) continue;
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
    if (match.archivedAt) continue;
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
    const isDentalCheckpoint = Boolean(
      requirement.ruleCategoryId &&
        DENTAL_CHECKPOINT_RULE_CATEGORY_ID_SET.has(
          requirement.ruleCategoryId,
        ),
    );
    const checkpoint = isDentalCheckpoint
      ? dentalCheckpointStateByRequirementId.get(requirement.id)
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
      isDentalCheckpoint,
      checkpointStatus: isDentalCheckpoint
        ? checkpoint?.status ?? "pending"
        : null,
      checkpointCompletedAt: checkpoint?.completedAt ?? null,
      checkpointEvidenceNote: checkpoint?.evidenceNote ?? null,
      checkpointRevision: checkpoint ? Number(checkpoint.revision) : 0,
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
      activity.archivedAt ||
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
    if (isCrccRuleSet(credentialById.get(credentialId)?.ruleSetId ?? null)) {
      const professionalDevelopment = requirements.find(
        (requirement) =>
          requirement.ruleCategoryId?.endsWith(
            "-professional-development",
          ),
      );
      maximumExcessByCredential.set(
        credentialId,
        Number(professionalDevelopment?.excessUnits ?? 0),
      );
      continue;
    }
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

  type NormalizedTaskRow = Omit<TaskRow, "isPersonal"> & {
    isPersonal: boolean;
  };
  const tasksByCredential = new Map<string, NormalizedTaskRow[]>();
  const archivedTasksByCredential = new Map<
    string,
    NormalizedTaskRow[]
  >();
  for (const task of taskResult.results) {
    const normalizedTask: NormalizedTaskRow = {
      ...task,
      revision: Number(task.revision),
      isPersonal: Boolean(task.isPersonal),
    };
    const target = task.archivedAt
      ? archivedTasksByCredential
      : tasksByCredential;
    const existing = target.get(task.credentialId) ?? [];
    existing.push(normalizedTask);
    target.set(task.credentialId, existing);
  }

  const activitiesById = new Map<
    string,
    Omit<ActivityRow, "allocationId"> & {
      allocations: Array<{
        id: string;
        credentialId: string;
        credentialName: string;
        credentialRuleSetId: string | null;
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
        revision: Number(activity.revision),
        allocatedUnits: Number(activity.allocatedUnits),
        evidenceCount: Number(activity.evidenceCount),
        evidenceDeletionPendingCount: Number(
          activity.evidenceDeletionPendingCount,
        ),
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
        credentialRuleSetId: activity.credentialRuleSetId,
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
      ...(progression.nextWeeklyGoal !== undefined &&
      progression.nextWeeklyGoalEffectiveOn
        ? {
            nextWeeklyGoal: progression.nextWeeklyGoal,
            nextWeeklyGoalEffectiveOn:
              progression.nextWeeklyGoalEffectiveOn,
          }
        : {}),
      badges: badgeResult.results,
    },
    progression,
    catalog,
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
        lifecycleKind: isIsc2AutomaticRenewalRuleSet(
          credential.ruleSetId,
        )
          ? ("automatic_renewal" as const)
          : isCompliancePeriodRuleSet(credential.ruleSetId)
            ? ("compliance_period" as const)
            : ("renewal" as const),
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
        archivedTasks:
          archivedTasksByCredential.get(credential.id) ?? [],
      };
    }),
    activities: [...activitiesById.values()].filter(
      (activity) => !activity.archivedAt,
    ),
    archivedActivities: [...activitiesById.values()].filter(
      (activity) => Boolean(activity.archivedAt),
    ),
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
  let abveAnnualStartYear: number | null = null;

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
      ruleSetId.startsWith(CRCC_RULE_SET_PREFIX) ||
      ruleSetId.startsWith(ABVE_RULE_SET_PREFIX)
    ) {
      abveAnnualStartYear = assertRehabilitationCertificationDates(
        ruleSetId,
        cycleStart,
        deadline,
        payload,
      );
    }
    if (
      isExpandedCertificationRuleSetId(ruleSetId) &&
      payload.officialDatesAttested !== true
    ) {
      throw new RequestError(
        "Confirm that the credential or license path, status, cycle start, and deadline match the official issuer or regulator record.",
        409,
        "expanded_certification_dates_attestation_required",
      );
    }
    if (
      isExpandedCertificationRuleSetId(ruleSetId) &&
      payload.templateEligibilityAttested !== true
    ) {
      throw new RequestError(
        "Confirm that this is the standard full-cycle credential or license maintenance path and that no initial, shortened, waiver, inactive, retired, reinstatement, synchronized or multi-credential, exam-alternative, or other adjusted variant applies.",
        409,
        "expanded_certification_template_eligibility_required",
      );
    }
    if (
      rule.profession === "Pharmacy" &&
      payload.templateEligibilityAttested !== true
    ) {
      throw new RequestError(
        "Confirm that the official record shows a standard full pharmacist renewal period and that no shortened, inactive, prorated, exempt, or other adjusted-status variant applies.",
        409,
        "pharmacist_template_eligibility_required",
      );
    }
    if (
      rule.profession === "Nursing" &&
      payload.templateEligibilityAttested !== true
    ) {
      throw new RequestError(
        ruleSetId === "tx-rn-2026-v1" ||
          ruleSetId === "tx-lvn-2026-v1"
          ? "Confirm that the official record matches a standard full Texas nursing renewal using the 20-hour CNE path—not the certification alternative—and that no initial, shortened, inactive, exempt, or other adjusted-status path applies."
          : "Confirm that the official record matches this standard full nursing renewal or registration period and that no initial, shortened, inactive, prorated, exempt, or other adjusted-status path applies.",
        409,
        "nursing_template_eligibility_required",
      );
    }
    if (
      rule.profession === "Dental" &&
      payload.templateEligibilityAttested !== true
    ) {
      throw new RequestError(
        "Confirm that the official record matches this standard full dental renewal or registration period and that no initial, shortened, inactive, retired, prorated, exempt, or other adjusted-status path applies.",
        409,
        "dental_template_eligibility_required",
      );
    }
    if (
      rule.profession === "Pharmacy" &&
      !matchesFullCycleWindow(
        cycleStart,
        deadline,
        Number(rule.cycleMonths),
      )
    ) {
      throw new RequestError(
        `This pharmacist template requires a standard full ${rule.cycleMonths}-month period. Use the exact regulator dates or create a custom plan for a shortened or adjusted period.`,
        409,
        "pharmacist_standard_cycle_dates_required",
      );
    }
    if (
      rule.profession === "Nursing" &&
      !matchesFullCycleWindow(
        cycleStart,
        deadline,
        Number(rule.cycleMonths),
      )
    ) {
      throw new RequestError(
        `This nursing template requires a standard full ${rule.cycleMonths}-month period. Use the exact regulator dates or create a custom plan for an initial, shortened, or adjusted period.`,
        409,
        "nursing_standard_cycle_dates_required",
      );
    }
    if (
      rule.profession === "Dental" &&
      !matchesFullCycleWindow(
        cycleStart,
        deadline,
        Number(rule.cycleMonths),
      )
    ) {
      throw new RequestError(
        `This dental template requires a standard full ${rule.cycleMonths}-month period. Use the exact regulator dates or create a custom plan for an initial, shortened, or adjusted period.`,
        409,
        "dental_standard_cycle_dates_required",
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
    for (const linkedCategoryIds of DENTAL_LINKED_APPLICABILITY_CATEGORY_GROUPS) {
      if (
        !linkedCategoryIds.every((categoryId) =>
          knownCategoryIds.has(categoryId),
        )
      ) {
        continue;
      }
      const explicitStatuses = linkedCategoryIds.flatMap((categoryId) => {
        const status = applicabilityChoices.get(categoryId);
        return status ? [status] : [];
      });
      if (new Set(explicitStatuses).size > 1) {
        throw new RequestError(
          "The Texas direct-patient-care pain-management aggregate and both annual requirements must use the same applicability choice.",
          409,
          "dental_linked_applicability_conflict",
        );
      }
      const synchronizedStatus = explicitStatuses[0];
      if (synchronizedStatus) {
        for (const categoryId of linkedCategoryIds) {
          applicabilityChoices.set(categoryId, synchronizedStatus);
        }
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
    totalRequired = adjustedFloridaNursingTotal(
      ruleSetId,
      Number(rule.totalUnits),
      categories,
    );
    totalRequired = adjustedDentalTotal(
      ruleSetId,
      totalRequired,
      categories,
    );
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

  assertMutuallyExclusivePharmacistConditions(categories);
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

  const taskSpecs = renewalTaskSpecs(ruleSetId, deadline, undefined, {
    abveAnnualStartYear: abveAnnualStartYear ?? undefined,
  });
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
  let evidenceReference = textField(payload, "evidenceReference", {
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
  const [isNremt, isCrc] = await Promise.all([
    isOwnedNremtCredential(database, identity, credentialId),
    isOwnedCrcCredential(database, identity, credentialId),
  ]);
  const exactMatches = isNremt || isCrc
    ? requirementMatchesField(payload, {
        required: true,
        context: isCrc ? "crcc" : "nremt",
      })
    : [];
  if (isNremt) assertNremtAcceptedEducation(payload, provider);
  if (isCrc) {
    evidenceReference = crcProgramEvidenceReference(
      payload,
      allocatedUnits,
    );
    if (
      evidenceStatus === "not_required" &&
      isCrccPostApprovedReference(evidenceReference)
    ) {
      throw new RequestError(
        "CRCC requires an uploaded completion record for post-approved credit. Choose Add later and upload the accepted record before submission.",
        409,
        "crcc_post_approval_proof_required",
      );
    }
    await assertNoDuplicateCrcProgram(
      database,
      identity,
      credentialId,
      evidenceReference,
    );
  }
  const selectedRequirements = isNremt
    ? await validateNremtRequirementMatches(
        database,
        identity,
        credentialId,
        exactMatches,
        allocatedUnits,
      )
    : isCrc
      ? await validateCrcRequirementMatches(
          database,
          identity,
          credentialId,
          exactMatches,
          allocatedUnits,
        )
      : await validateRequirementTags(
          database,
          identity,
          credentialId,
          legacyRequirementIds,
        );
  const persistedMatches: RequirementMatchInput[] =
    isNremt || isCrc
    ? exactMatches
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
  assertActivityDateFitsCredential(
    completionDate,
    credential,
    selectedRequirements,
    "completion date",
  );
  assertDentalPerActivityRequirements(
    selectedRequirements,
    allocatedUnits,
  );
  await assertDentalDailyUnitLimit(
    database,
    identity,
    credentialId,
    undefined,
    completionDate,
    allocatedUnits,
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
        )
        SELECT ?, ?, allocation.id, ?, ?
        FROM activity_allocations allocation
        JOIN activities activity ON activity.id = allocation.activity_id
        JOIN credentials credential
          ON credential.id = allocation.credential_id
        WHERE allocation.id = ?
          AND allocation.activity_id = ?
          AND allocation.credential_id = ?
          AND activity.user_id = ?
          AND activity.archived_at IS NULL
          AND credential.user_id = activity.user_id
          AND credential.status IN ('active', 'submitted')`,
        [
          crypto.randomUUID(),
          identity.userId,
          match.requirementId,
          match.matchedUnits,
          allocationId,
          activityId,
          credentialId,
          identity.userId,
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
    const results = await database.batch(statements);
    if (Number(results[0]?.meta?.changes ?? Number.NaN) === 0) {
      await assertCredentialStillMutable(
        database,
        identity,
        credentialId,
        "This renewal cycle is closed and cannot receive activities.",
      );
      throw new RequestError(
        "This renewal cycle changed while the activity was being saved. Refresh and try again.",
        409,
        "activity_state_changed",
      );
    }
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

type ActivityMutationRow = {
  id: string;
  revision: number;
  archivedAt: string | null;
  completionDate: string;
  totalUnits: number;
  provider: string;
  evidenceStatus: string;
  evidenceReference: string | null;
};

type ActivityAllocationValidationRow = {
  id: string;
  credentialId: string;
  requirementId: string | null;
  allocatedUnits: number;
  ruleSetId: string | null;
  credentialStatus: string;
  cycleStart: string;
  deadline: string;
};

async function getActivityForMutation(
  database: D1Database,
  identity: RequestIdentity,
  activityId: string,
) {
  return query(
    database,
    `SELECT
      id,
      revision,
      archived_at AS archivedAt,
      completion_date AS completionDate,
      total_units AS totalUnits,
      provider,
      evidence_status AS evidenceStatus,
      evidence_reference AS evidenceReference
     FROM activities
     WHERE id = ? AND user_id = ?`,
    [activityId, identity.userId],
  ).first<ActivityMutationRow>();
}

function assertActivityMutationState(
  activity: ActivityMutationRow | null,
  expectedRevision: number,
  archiveState: "active" | "archived",
) {
  if (!activity) {
    throw new RequestError("Activity not found.", 404, "activity_not_found");
  }
  if (Number(activity.revision) !== expectedRevision) {
    throw new RequestError(
      "This learning record changed in another session. Refresh and try again.",
      409,
      "activity_version_conflict",
    );
  }
  if (archiveState === "active" && activity.archivedAt) {
    throw new RequestError(
      "This learning record is archived. Restore it before making changes.",
      409,
      "activity_archived",
    );
  }
  if (archiveState === "archived" && !activity.archivedAt) {
    throw new RequestError(
      "This learning record is already active.",
      409,
      "activity_not_archived",
    );
  }
}

async function getActivityAllocationValidationRows(
  database: D1Database,
  identity: RequestIdentity,
  activityId: string,
) {
  const [allocations, matches] = await Promise.all([
    query(
      database,
      `SELECT
        allocation.id,
        allocation.credential_id AS credentialId,
        allocation.requirement_id AS requirementId,
        allocation.allocated_units AS allocatedUnits,
        credential.rule_set_id AS ruleSetId,
        credential.status AS credentialStatus,
        credential.cycle_start AS cycleStart,
        credential.deadline
       FROM activity_allocations allocation
       JOIN activities activity ON activity.id = allocation.activity_id
       JOIN credentials credential
         ON credential.id = allocation.credential_id
       WHERE allocation.activity_id = ?
         AND activity.user_id = ?
         AND credential.user_id = activity.user_id
       ORDER BY allocation.id`,
      [activityId, identity.userId],
    ).all<ActivityAllocationValidationRow>(),
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
       WHERE allocation.activity_id = ?
         AND match.user_id = ?
         AND activity.user_id = match.user_id
         AND credential.user_id = match.user_id
       ORDER BY match.allocation_id, match.requirement_id`,
      [activityId, identity.userId],
    ).all<RequirementMatchInput & { allocationId: string }>(),
  ]);
  const requirementMatchesByAllocation = new Map<
    string,
    RequirementMatchInput[]
  >();
  for (const match of matches.results) {
    const requirementMatches =
      requirementMatchesByAllocation.get(match.allocationId) ?? [];
    requirementMatches.push({
      requirementId: match.requirementId,
      matchedUnits: Number(match.matchedUnits),
    });
    requirementMatchesByAllocation.set(
      match.allocationId,
      requirementMatches,
    );
  }
  return allocations.results.map((allocation) => ({
    ...allocation,
    allocatedUnits: Number(allocation.allocatedUnits),
    requirementMatches:
      requirementMatchesByAllocation.get(allocation.id) ??
      (allocation.requirementId
        ? [
            {
              requirementId: allocation.requirementId,
              matchedUnits: Number(allocation.allocatedUnits),
            },
          ]
        : []),
    requirementIds:
      requirementMatchesByAllocation
        .get(allocation.id)
        ?.map((match) => match.requirementId) ??
      (allocation.requirementId ? [allocation.requirementId] : []),
  }));
}

async function validateActivityMutationAllocations(
  database: D1Database,
  identity: RequestIdentity,
  activityId: string,
  completionDate: string,
  options: {
    revalidateTags?: boolean;
    currentTotalUnits: number;
    proposedTotalUnits?: number;
    provider: string;
    evidenceStatus: string;
  },
) {
  const allocations = await getActivityAllocationValidationRows(
    database,
    identity,
    activityId,
  );
  if (
    allocations.some(
      (allocation) =>
        !["active", "submitted"].includes(allocation.credentialStatus),
    )
  ) {
    throw new RequestError(
      "A renewal cycle using this learning record is closed, so the record is frozen.",
      409,
      "cycle_closed",
    );
  }
  if (options.revalidateTags === false) return;
  await Promise.all(
    allocations.map(async (allocation) => {
      const proposedTotalUnits =
        options.proposedTotalUnits ?? options.currentTotalUnits;
      const isNremt = isNremtRuleSet(allocation.ruleSetId);
      const isCrc = isCrccRuleSet(allocation.ruleSetId);
      const hasExactRequirementAmounts = isNremt || isCrc;
      const proposedAllocatedUnits =
        !hasExactRequirementAmounts &&
        unitsEqual(
          allocation.allocatedUnits,
          options.currentTotalUnits,
        )
          ? proposedTotalUnits
          : Math.min(allocation.allocatedUnits, proposedTotalUnits);
      if (
        hasExactRequirementAmounts &&
        !unitsEqual(proposedAllocatedUnits, allocation.allocatedUnits)
      ) {
        throw new RequestError(
          isNremt
            ? "National Registry component and topic amounts cannot be changed by a total-only correction. Archive this record and log the corrected credit with its exact component and topic amounts."
            : "CRC credit-type and ethics amounts cannot be changed by a total-only correction. Open the allocation and enter the corrected General, Professional Development, and Ethics split.",
          409,
          isNremt
            ? "nremt_allocation_revision_required"
            : "crcc_allocation_revision_required",
        );
      }
      if (isNremt && !options.provider.trim()) {
        throw new RequestError(
          "Provider is required for National Registry education.",
          409,
          "nremt_provider_required",
        );
      }
      const selectedRequirements = isNremt
        ? await validateNremtRequirementMatches(
            database,
            identity,
            allocation.credentialId,
            allocation.requirementMatches,
            allocation.allocatedUnits,
          )
        : isCrc
          ? await validateCrcRequirementMatches(
              database,
              identity,
              allocation.credentialId,
              allocation.requirementMatches,
              allocation.allocatedUnits,
            )
          : await validateRequirementTags(
              database,
              identity,
              allocation.credentialId,
              [...new Set(allocation.requirementIds)],
            );
      assertActivityDateAllowedForRequirements(
        completionDate,
        allocation.cycleStart,
        allocation.deadline,
        selectedRequirements,
        {
          portalCarryoverAttested: true,
          evidenceStatus: options.evidenceStatus,
        },
      );
      assertActivityDateFitsCredential(
        completionDate,
        allocation,
        selectedRequirements,
        "activity date",
      );
      assertDentalPerActivityRequirements(
        selectedRequirements,
        proposedAllocatedUnits,
      );
      await assertDentalDailyUnitLimit(
        database,
        identity,
        allocation.credentialId,
        allocation.ruleSetId,
        completionDate,
        proposedAllocatedUnits,
        activityId,
      );
    }),
  );
}

async function assertNoActivityEvidenceDeletion(
  database: D1Database,
  identity: RequestIdentity,
  activityId: string,
) {
  const deletingEvidence = await query(
    database,
    `SELECT evidence.id
     FROM evidence_files evidence
     JOIN activities activity ON activity.id = evidence.activity_id
     WHERE evidence.activity_id = ?
       AND evidence.user_id = ?
       AND activity.user_id = evidence.user_id
       AND evidence.status = 'deleting'
     LIMIT 1`,
    [activityId, identity.userId],
  ).first<{ id: string }>();
  if (deletingEvidence) {
    throw new RequestError(
      "Evidence is being removed from this learning record. Try archiving again in a moment.",
      409,
      "activity_busy",
    );
  }
}

async function diagnoseActivityMutationFailure(
  database: D1Database,
  identity: RequestIdentity,
  activityId: string,
  expectedRevision: number,
  archiveState: "active" | "archived",
  rejectEvidenceDeletion = false,
  revalidateTags = true,
): Promise<never> {
  const activity = await getActivityForMutation(
    database,
    identity,
    activityId,
  );
  assertActivityMutationState(activity, expectedRevision, archiveState);
  if (rejectEvidenceDeletion) {
    await assertNoActivityEvidenceDeletion(database, identity, activityId);
  }
  await validateActivityMutationAllocations(
    database,
    identity,
    activityId,
    activity!.completionDate,
    {
      revalidateTags,
      currentTotalUnits: Number(activity!.totalUnits),
      provider: activity!.provider,
      evidenceStatus: activity!.evidenceStatus,
    },
  );
  throw new RequestError(
    "This learning record changed while it was being saved. Refresh and try again.",
    409,
    "activity_state_changed",
  );
}

async function updateActivity(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const activityId = textField(payload, "activityId", {
    required: true,
    max: 160,
  })!;
  const expectedRevision = expectedRevisionField(payload);
  const title = textField(payload, "title", {
    required: true,
    max: 180,
  })!;
  const provider = textField(payload, "provider", { max: 180 }) ?? "";
  const completionDate = isoDateField(payload, "completionDate")!;
  const totalUnits = positiveNumber(payload, "totalUnits", {
    required: true,
  })!;

  const activity = await getActivityForMutation(
    database,
    identity,
    activityId,
  );
  assertActivityMutationState(activity, expectedRevision, "active");
  const managedAllocations = await query(
    database,
    `SELECT
      MAX(
        CASE
          WHEN credential.rule_set_id LIKE 'nremt-%' THEN 1
          ELSE 0
        END
      ) AS hasNremt,
      MAX(
        CASE
          WHEN credential.rule_set_id LIKE 'crcc-%' THEN 1
          ELSE 0
        END
      ) AS hasCrc
     FROM activity_allocations allocation
     JOIN credentials credential
       ON credential.id = allocation.credential_id
     WHERE allocation.activity_id = ?
       AND credential.user_id = ?`,
    [activityId, identity.userId],
  ).first<{ hasNremt: number; hasCrc: number }>();
  await validateActivityMutationAllocations(
    database,
    identity,
    activityId,
    completionDate,
    {
      currentTotalUnits: Number(activity!.totalUnits),
      proposedTotalUnits: totalUnits,
      provider,
      evidenceStatus: activity!.evidenceStatus,
    },
  );
  if (Boolean(managedAllocations?.hasNremt)) {
    assertNremtAcceptedEducation(payload, provider);
  }
  if (
    Boolean(managedAllocations?.hasCrc) &&
    payload.crcApprovalAttested !== true
  ) {
    throw new RequestError(
      "Confirm that the corrected activity title, provider, completion date, and credit total still match the saved CRCC approval record.",
      409,
      "crcc_activity_edit_attestation_required",
    );
  }

  const movesBeforeAllocationIncrease =
    completionDate !== activity!.completionDate &&
    totalUnits > Number(activity!.totalUnits);
  const allocationExpectedRevision = movesBeforeAllocationIncrease
    ? expectedRevision + 1
    : expectedRevision;
  // When the activity row is rewritten first, a bumped revision alone is not
  // proof that this batch performed the rewrite: evidence attach/delete and
  // allocation writes also bump the revision, without touching the completion
  // date or the total. Pin the guard to the values this batch writes so the
  // allocation and match statements cannot commit against a concurrently
  // bumped row while the guarded activity update itself matched no rows.
  const activityRewriteGuard = movesBeforeAllocationIncrease
    ? `
      AND activity.completion_date = ?
      AND activity.total_units = ?`
    : "";
  const activityRewriteGuardBindings: unknown[] = movesBeforeAllocationIncrease
    ? [completionDate, totalUnits]
    : [];
  const mutableActivityExists = `
    SELECT 1
    FROM activities activity
    WHERE activity.id = activity_allocations.activity_id
      AND activity.id = ?
      AND activity.user_id = ?
      AND activity.revision = ?${activityRewriteGuard}
      AND activity.archived_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM activity_allocations guarded_allocation
        JOIN credentials guarded_credential
          ON guarded_credential.id = guarded_allocation.credential_id
        WHERE guarded_allocation.activity_id = activity.id
          AND (
            guarded_credential.user_id <> activity.user_id
            OR guarded_credential.status NOT IN ('active', 'submitted')
          )
      )`;
  const allocationStatement = query(
    database,
    `UPDATE activity_allocations
     SET allocated_units = CASE
       WHEN EXISTS (
         SELECT 1
         FROM credentials allocation_credential
         WHERE allocation_credential.id =
           activity_allocations.credential_id
           AND (
             allocation_credential.rule_set_id LIKE 'nremt-%'
             OR allocation_credential.rule_set_id LIKE 'crcc-%'
           )
       ) THEN MIN(allocated_units, ?)
       WHEN allocated_units = ? THEN ?
       ELSE MIN(allocated_units, ?)
     END
     WHERE activity_id = ?
       AND EXISTS (${mutableActivityExists})`,
    [
      totalUnits,
      Number(activity!.totalUnits),
      totalUnits,
      totalUnits,
      activityId,
      activityId,
      identity.userId,
      allocationExpectedRevision,
      ...activityRewriteGuardBindings,
    ],
  );
  const matchStatement = query(
    database,
    `UPDATE activity_requirement_matches
     SET matched_units = (
       SELECT allocation.allocated_units
       FROM activity_allocations allocation
       WHERE allocation.id =
         activity_requirement_matches.allocation_id
     )
     WHERE user_id = ?
       AND allocation_id IN (
         SELECT activity_allocations.id
         FROM activity_allocations
         JOIN credentials
           ON credentials.id = activity_allocations.credential_id
         WHERE activity_allocations.activity_id = ?
           AND (
             credentials.rule_set_id IS NULL
             OR (
               credentials.rule_set_id NOT LIKE 'nremt-%'
               AND credentials.rule_set_id NOT LIKE 'crcc-%'
             )
           )
           AND EXISTS (${mutableActivityExists})
       )`,
    [
      identity.userId,
      activityId,
      activityId,
      identity.userId,
      allocationExpectedRevision,
      ...activityRewriteGuardBindings,
    ],
  );
  const activityStatement = query(
    database,
    `UPDATE activities
     SET
       title = ?,
       provider = ?,
       completion_date = ?,
       total_units = ?,
       revision = revision + 1,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND user_id = ?
       AND revision = ?
       AND archived_at IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM activity_allocations guarded_allocation
         JOIN credentials guarded_credential
           ON guarded_credential.id = guarded_allocation.credential_id
         WHERE guarded_allocation.activity_id = activities.id
           AND (
             guarded_credential.user_id <> activities.user_id
             OR guarded_credential.status NOT IN ('active', 'submitted')
           )
       )`,
    [
      title,
      provider,
      completionDate,
      totalUnits,
      activityId,
      identity.userId,
      expectedRevision,
    ],
  );
  const statements: D1PreparedStatement[] = movesBeforeAllocationIncrease
    ? [activityStatement, allocationStatement, matchStatement]
    : [allocationStatement, matchStatement, activityStatement];
  const results = await database.batch(statements);
  const activityResult = results[movesBeforeAllocationIncrease ? 0 : 2];
  const allocationResult = results[movesBeforeAllocationIncrease ? 1 : 0];
  const matchResult = results[movesBeforeAllocationIncrease ? 2 : 1];
  const allocationChanges = Number(
    allocationResult?.meta?.changes ?? Number.NaN,
  );
  const matchChanges = Number(matchResult?.meta?.changes ?? Number.NaN);
  if (Number(activityResult?.meta?.changes ?? Number.NaN) !== 1) {
    // The batch is one transaction that has already committed, so allocation or
    // match rows must never be rewritten when the activity update matched
    // nothing. Guards above make that unreachable; surface it loudly instead of
    // reporting a plain conflict if it ever happens.
    if (allocationChanges > 0 || matchChanges > 0) {
      throw new RequestError(
        "This learning record changed while it was being saved and its credit split may no longer match the saved total. Refresh and review the record before editing it again.",
        409,
        "activity_state_changed",
      );
    }
    return diagnoseActivityMutationFailure(
      database,
      identity,
      activityId,
      expectedRevision,
      "active",
    );
  }
  return activityId;
}

async function setActivityArchivedState(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
  restore: boolean,
) {
  const activityId = textField(payload, "activityId", {
    required: true,
    max: 160,
  })!;
  const expectedRevision = expectedRevisionField(payload);
  const expectedState = restore ? "archived" : "active";
  const activity = await getActivityForMutation(
    database,
    identity,
    activityId,
  );
  assertActivityMutationState(activity, expectedRevision, expectedState);
  if (!restore) {
    await assertNoActivityEvidenceDeletion(database, identity, activityId);
  }
  if (restore) {
    const crcAllocations = await query(
      database,
      `SELECT allocation.credential_id AS credentialId
       FROM activity_allocations allocation
       JOIN credentials credential
         ON credential.id = allocation.credential_id
       JOIN activities restored_activity
         ON restored_activity.id = allocation.activity_id
       WHERE allocation.activity_id = ?
         AND restored_activity.user_id = ?
         AND credential.user_id = restored_activity.user_id
         AND credential.rule_set_id LIKE 'crcc-%'
       ORDER BY allocation.credential_id`,
      [activityId, identity.userId],
    ).all<{ credentialId: string }>();
    if (crcAllocations.results.length > 0) {
      if (!isCrccProgramEvidenceReference(activity!.evidenceReference)) {
        throw new RequestError(
          "Add the CRCC approval number or accepted post-approval program reference before restoring this CRC activity.",
          409,
          "crcc_program_reference_required",
        );
      }
      await Promise.all(
        crcAllocations.results.map((allocation) =>
          assertNoDuplicateCrcProgram(
            database,
            identity,
            allocation.credentialId,
            activity!.evidenceReference!,
            activityId,
          ),
        ),
      );
    }
  }
  await validateActivityMutationAllocations(
    database,
    identity,
    activityId,
    activity!.completionDate,
    {
      revalidateTags: restore,
      currentTotalUnits: Number(activity!.totalUnits),
      provider: activity!.provider,
      evidenceStatus: activity!.evidenceStatus,
    },
  );

  const result = await query(
    database,
    `UPDATE activities
     SET
       archived_at = ${restore ? "NULL" : "CURRENT_TIMESTAMP"},
       revision = revision + 1,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND user_id = ?
       AND revision = ?
       AND archived_at IS ${restore ? "NOT NULL" : "NULL"}
       ${
         restore
           ? `AND NOT EXISTS (
         SELECT 1
         FROM activity_allocations restore_direct_allocation
         LEFT JOIN credential_requirements restore_direct_requirement
           ON restore_direct_requirement.id =
             restore_direct_allocation.requirement_id
         WHERE restore_direct_allocation.activity_id = activities.id
           AND restore_direct_allocation.requirement_id IS NOT NULL
           AND (
             restore_direct_requirement.id IS NULL
             OR restore_direct_requirement.credential_id <>
               restore_direct_allocation.credential_id
             OR restore_direct_requirement.is_active <> 1
             OR restore_direct_requirement.applicability_status <> 'applies'
           )
       )
       AND NOT EXISTS (
         SELECT 1
         FROM activity_allocations restore_allocation
         JOIN activity_requirement_matches restore_match
           ON restore_match.allocation_id = restore_allocation.id
         LEFT JOIN credential_requirements restore_requirement
           ON restore_requirement.id = restore_match.requirement_id
         WHERE restore_allocation.activity_id = activities.id
           AND (
             restore_match.user_id <> activities.user_id
             OR restore_requirement.id IS NULL
             OR restore_requirement.credential_id <>
               restore_allocation.credential_id
             OR restore_requirement.is_active <> 1
             OR restore_requirement.applicability_status <> 'applies'
           )
       )`
           : `AND NOT EXISTS (
         SELECT 1
         FROM evidence_files deleting_evidence
         WHERE deleting_evidence.activity_id = activities.id
           AND deleting_evidence.user_id = activities.user_id
           AND deleting_evidence.status = 'deleting'
       )`
       }
       AND NOT EXISTS (
         SELECT 1
         FROM activity_allocations guarded_allocation
         JOIN credentials guarded_credential
           ON guarded_credential.id = guarded_allocation.credential_id
         WHERE guarded_allocation.activity_id = activities.id
           AND (
             guarded_credential.user_id <> activities.user_id
             OR guarded_credential.status NOT IN ('active', 'submitted')
           )
       )`,
    [activityId, identity.userId, expectedRevision],
  ).run();
  if (Number(result.meta?.changes ?? Number.NaN) !== 1) {
    return diagnoseActivityMutationFailure(
      database,
      identity,
      activityId,
      expectedRevision,
      expectedState,
      !restore,
      restore,
    );
  }
  return activityId;
}

async function archiveActivity(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  return setActivityArchivedState(database, identity, payload, false);
}

async function restoreActivity(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  return setActivityArchivedState(database, identity, payload, true);
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

type TaskMutationRow = {
  id: string;
  credentialId: string;
  revision: number;
  isPersonal: number;
  archivedAt: string | null;
  credentialStatus: string;
};

async function getTaskForMutation(
  database: D1Database,
  identity: RequestIdentity,
  taskId: string,
  archiveState?: "active" | "archived",
) {
  return query(
    database,
    `SELECT
      task.id,
      task.credential_id AS credentialId,
      task.revision,
      task.is_personal AS isPersonal,
      task.archived_at AS archivedAt,
      credential.status AS credentialStatus
     FROM checklist_tasks task
     JOIN credentials credential ON credential.id = task.credential_id
     WHERE task.id = ?
       AND task.user_id = ?
       AND credential.user_id = task.user_id
       ${
         archiveState === "active"
           ? "AND task.archived_at IS NULL"
           : archiveState === "archived"
             ? "AND task.archived_at IS NOT NULL"
             : ""
       }`,
    [taskId, identity.userId],
  ).first<TaskMutationRow>();
}

function assertTaskMutationState(
  task: TaskMutationRow | null,
  expectedRevision: number,
  archiveState: "active" | "archived",
  personalOnly: boolean,
) {
  if (!task) {
    throw new RequestError("Task not found.", 404, "task_not_found");
  }
  if (personalOnly && !Boolean(task.isPersonal)) {
    throw new RequestError(
      "Managed renewal tasks cannot be edited or archived.",
      409,
      "managed_task_immutable",
    );
  }
  if (Number(task.revision) !== expectedRevision) {
    throw new RequestError(
      "This task changed in another session. Refresh and try again.",
      409,
      "task_version_conflict",
    );
  }
  if (archiveState === "active" && task.archivedAt) {
    throw new RequestError(
      "This task is archived. Restore it before making changes.",
      409,
      "task_archived",
    );
  }
  if (archiveState === "archived" && !task.archivedAt) {
    throw new RequestError(
      "This task is already active.",
      409,
      "task_not_archived",
    );
  }
  if (!["active", "submitted"].includes(task.credentialStatus)) {
    throw new RequestError(
      "This renewal cycle is closed and its checklist is frozen.",
      409,
      "cycle_closed",
    );
  }
}

async function diagnoseTaskMutationFailure(
  database: D1Database,
  identity: RequestIdentity,
  taskId: string,
  expectedRevision: number,
  archiveState: "active" | "archived",
  personalOnly: boolean,
): Promise<never> {
  const task = await getTaskForMutation(
    database,
    identity,
    taskId,
  );
  assertTaskMutationState(
    task,
    expectedRevision,
    archiveState,
    personalOnly,
  );
  throw new RequestError(
    "This task changed while it was being saved. Refresh and try again.",
    409,
    "task_state_changed",
  );
}

async function createPersonalTask(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const credentialId = textField(payload, "credentialId", {
    required: true,
    max: 160,
  })!;
  const title = textField(payload, "title", {
    required: true,
    max: 160,
  })!;
  const dueDate = isoDateField(payload, "dueDate", false);
  const credential = await query(
    database,
    `SELECT id, status
     FROM credentials
     WHERE id = ? AND user_id = ?`,
    [credentialId, identity.userId],
  ).first<{ id: string; status: string }>();
  if (!credential) {
    throw new RequestError(
      "Credential not found.",
      404,
      "credential_not_found",
    );
  }
  if (!["active", "submitted"].includes(credential.status)) {
    throw new RequestError(
      "This renewal cycle is closed and its checklist is frozen.",
      409,
      "cycle_closed",
    );
  }
  const personalTaskCount = await query(
    database,
    `SELECT COUNT(*) AS count
     FROM checklist_tasks
     WHERE credential_id = ?
       AND user_id = ?
       AND is_personal = 1
       AND archived_at IS NULL`,
    [credentialId, identity.userId],
  ).first<{ count: number }>();
  if (Number(personalTaskCount?.count ?? 0) >= 50) {
    throw new RequestError(
      "A credential can have at most 50 active personal tasks.",
      409,
      "personal_task_limit",
    );
  }

  const taskId = crypto.randomUUID();
  const result = await query(
    database,
    `INSERT INTO checklist_tasks (
      id, user_id, credential_id, title, kind, status, due_date,
      completed_at, sort_order, is_personal, revision, archived_at
    )
    SELECT
      ?,
      credential.user_id,
      credential.id,
      ?,
      'personal',
      'pending',
      ?,
      NULL,
      COALESCE(
        (
          SELECT MAX(existing_task.sort_order) + 1
          FROM checklist_tasks existing_task
          WHERE existing_task.credential_id = credential.id
            AND existing_task.user_id = credential.user_id
        ),
        0
      ),
      1,
      1,
      NULL
    FROM credentials credential
    WHERE credential.id = ?
      AND credential.user_id = ?
      AND credential.status IN ('active', 'submitted')
      AND (
        SELECT COUNT(*)
        FROM checklist_tasks personal_task
        WHERE personal_task.credential_id = credential.id
          AND personal_task.user_id = credential.user_id
          AND personal_task.is_personal = 1
          AND personal_task.archived_at IS NULL
      ) < 50`,
    [taskId, title, dueDate, credentialId, identity.userId],
  ).run();
  if (Number(result.meta?.changes ?? Number.NaN) !== 1) {
    await assertCredentialStillMutable(
      database,
      identity,
      credentialId,
      "This renewal cycle is closed and its checklist is frozen.",
    );
    const currentCount = await query(
      database,
      `SELECT COUNT(*) AS count
       FROM checklist_tasks
       WHERE credential_id = ?
         AND user_id = ?
         AND is_personal = 1
         AND archived_at IS NULL`,
      [credentialId, identity.userId],
    ).first<{ count: number }>();
    if (Number(currentCount?.count ?? 0) >= 50) {
      throw new RequestError(
        "A credential can have at most 50 active personal tasks.",
        409,
        "personal_task_limit",
      );
    }
    throw new RequestError(
      "This personal task changed while it was being saved. Refresh and try again.",
      409,
      "task_state_changed",
    );
  }
  return taskId;
}

async function updatePersonalTask(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const taskId = textField(payload, "taskId", {
    required: true,
    max: 160,
  })!;
  const expectedRevision = expectedRevisionField(payload);
  const title = textField(payload, "title", {
    required: true,
    max: 160,
  })!;
  const dueDate = isoDateField(payload, "dueDate", false);
  const task =
    (await getTaskForMutation(
      database,
      identity,
      taskId,
      "active",
    )) ??
    (await getTaskForMutation(database, identity, taskId));
  assertTaskMutationState(task, expectedRevision, "active", true);

  const result = await query(
    database,
    `UPDATE checklist_tasks
     SET
       title = ?,
       due_date = ?,
       revision = revision + 1,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND user_id = ?
       AND is_personal = 1
       AND revision = ?
       AND archived_at IS NULL
       AND EXISTS (
         SELECT 1
         FROM credentials credential
         WHERE credential.id = checklist_tasks.credential_id
           AND credential.user_id = checklist_tasks.user_id
           AND credential.status IN ('active', 'submitted')
       )`,
    [title, dueDate, taskId, identity.userId, expectedRevision],
  ).run();
  if (Number(result.meta?.changes ?? Number.NaN) !== 1) {
    return diagnoseTaskMutationFailure(
      database,
      identity,
      taskId,
      expectedRevision,
      "active",
      true,
    );
  }
  return taskId;
}

async function setPersonalTaskArchivedState(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
  restore: boolean,
) {
  const taskId = textField(payload, "taskId", {
    required: true,
    max: 160,
  })!;
  const expectedRevision = expectedRevisionField(payload);
  const expectedState = restore ? "archived" : "active";
  const task =
    (await getTaskForMutation(
      database,
      identity,
      taskId,
      expectedState,
    )) ??
    (await getTaskForMutation(database, identity, taskId));
  assertTaskMutationState(task, expectedRevision, expectedState, true);

  const result = await query(
    database,
    `UPDATE checklist_tasks
     SET
       archived_at = ${restore ? "NULL" : "CURRENT_TIMESTAMP"},
       revision = revision + 1,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND user_id = ?
       AND is_personal = 1
       AND revision = ?
       AND archived_at IS ${restore ? "NOT NULL" : "NULL"}
       ${
         restore
           ? `AND (
         SELECT COUNT(*)
         FROM checklist_tasks active_personal_task
         WHERE active_personal_task.credential_id =
           checklist_tasks.credential_id
           AND active_personal_task.user_id = checklist_tasks.user_id
           AND active_personal_task.is_personal = 1
           AND active_personal_task.archived_at IS NULL
       ) < 50`
           : ""
       }
       AND EXISTS (
         SELECT 1
         FROM credentials credential
         WHERE credential.id = checklist_tasks.credential_id
           AND credential.user_id = checklist_tasks.user_id
           AND credential.status IN ('active', 'submitted')
       )`,
    [taskId, identity.userId, expectedRevision],
  ).run();
  if (Number(result.meta?.changes ?? Number.NaN) !== 1) {
    if (restore) {
      const activePersonalTaskCount = await query(
        database,
        `SELECT COUNT(*) AS count
         FROM checklist_tasks
         WHERE credential_id = ?
           AND user_id = ?
           AND is_personal = 1
           AND archived_at IS NULL`,
        [task!.credentialId, identity.userId],
      ).first<{ count: number }>();
      if (Number(activePersonalTaskCount?.count ?? 0) >= 50) {
        throw new RequestError(
          "A credential can have at most 50 active personal tasks.",
          409,
          "personal_task_limit",
        );
      }
    }
    return diagnoseTaskMutationFailure(
      database,
      identity,
      taskId,
      expectedRevision,
      expectedState,
      true,
    );
  }
  return taskId;
}

async function archivePersonalTask(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  return setPersonalTaskArchivedState(database, identity, payload, false);
}

async function restorePersonalTask(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  return setPersonalTaskArchivedState(database, identity, payload, true);
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
  const expectedRevision = expectedRevisionField(payload);
  const task =
    (await getTaskForMutation(
      database,
      identity,
      taskId,
      "active",
    )) ??
    (await getTaskForMutation(database, identity, taskId));
  assertTaskMutationState(task, expectedRevision, "active", false);

  const statements: D1PreparedStatement[] = [
    query(
      database,
      `UPDATE checklist_tasks
       SET
         status = ?,
         completed_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END,
         revision = revision + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?
         AND revision = ?
         AND archived_at IS NULL
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
        expectedRevision,
      ],
    ),
  ];
  if (completed && !Boolean(task!.isPersonal)) {
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
          AND task.is_personal = 0
          AND task.archived_at IS NULL
          AND task.revision = ?
          AND task.status = 'completed'
          AND credential.user_id = task.user_id
          AND credential.status IN ('active', 'submitted')`,
        [
          crypto.randomUUID(),
          identity.userId,
          `${identity.userId}:task:${taskId}:completed`,
          taskId,
          taskId,
          identity.userId,
          expectedRevision + 1,
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
      task!.credentialId,
      "This renewal cycle is closed and its checklist is frozen.",
      error,
    );
  }
  if (Number(results[0]?.meta?.changes ?? Number.NaN) === 0) {
    return diagnoseTaskMutationFailure(
      database,
      identity,
      taskId,
      expectedRevision,
      "active",
      false,
    );
  }
  return taskId;
}

async function assertDentalCheckpointsComplete(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
) {
  const pending = await query(
    database,
    `SELECT requirement.name
     FROM credential_requirements requirement
     JOIN credentials credential
       ON credential.id = requirement.credential_id
     LEFT JOIN dental_checkpoint_states checkpoint
       ON checkpoint.requirement_id = requirement.id
       AND checkpoint.credential_id = credential.id
       AND checkpoint.user_id = credential.user_id
     WHERE requirement.credential_id = ?
       AND credential.user_id = ?
       AND credential.profession = 'Dental'
       AND requirement.rule_category_id IN (
         ${DENTAL_CHECKPOINT_RULE_CATEGORY_IDS_SQL}
       )
       AND requirement.kind = 'informational'
       AND requirement.required_units = 0
       AND requirement.is_active = 1
       AND requirement.applicability_status = 'applies'
       AND COALESCE(checkpoint.status, 'pending') <> 'completed'
     ORDER BY requirement.sort_order, requirement.name`,
    [credentialId, identity.userId],
  ).all<{ name: string }>();
  if (pending.results.length === 0) return;
  throw new RequestError(
    `Complete every applicable dental checkpoint before submitting. Still pending: ${pending.results
      .map((requirement) => requirement.name)
      .join(", ")}.`,
    409,
    "dental_checkpoint_incomplete",
  );
}

async function assertCrcProgramsReady(
  database: D1Database,
  identity: RequestIdentity,
  credentialId: string,
  submissionDate: string,
) {
  const [allocationRows, requirementRows, matchRows] = await Promise.all([
    query(
      database,
      `SELECT
        allocation.id,
        allocation.allocated_units AS allocatedUnits,
        activity.evidence_reference AS evidenceReference
       FROM activity_allocations allocation
       JOIN activities activity
         ON activity.id = allocation.activity_id
         AND activity.user_id = ?
         AND activity.archived_at IS NULL
       JOIN credentials credential
         ON credential.id = allocation.credential_id
         AND credential.user_id = activity.user_id
       WHERE allocation.credential_id = ?
       ORDER BY allocation.id`,
      [identity.userId, credentialId],
    ).all<{
      id: string;
      allocatedUnits: number;
      evidenceReference: string | null;
    }>(),
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
        match.allocation_id AS allocationId,
        match.requirement_id AS requirementId,
        match.matched_units AS matchedUnits
       FROM activity_requirement_matches match
       JOIN activity_allocations allocation
         ON allocation.id = match.allocation_id
       JOIN activities activity
         ON activity.id = allocation.activity_id
         AND activity.user_id = ?
         AND activity.archived_at IS NULL
       WHERE allocation.credential_id = ?
         AND match.user_id = activity.user_id
       ORDER BY match.allocation_id, match.requirement_id`,
      [identity.userId, credentialId],
    ).all<RequirementMatchInput & { allocationId: string }>(),
  ]);
  const requirementsById = new Map(
    requirementRows.results.map((requirement) => [
      requirement.id,
      requirement,
    ]),
  );
  const matchesByAllocation = new Map<string, RequirementMatchInput[]>();
  for (const match of matchRows.results) {
    const matches = matchesByAllocation.get(match.allocationId) ?? [];
    matches.push({
      requirementId: match.requirementId,
      matchedUnits: Number(match.matchedUnits),
    });
    matchesByAllocation.set(match.allocationId, matches);
  }
  for (const allocation of allocationRows.results) {
    const issue = crcAllocationIssue(
      requirementsById,
      matchesByAllocation.get(allocation.id) ?? [],
      Number(allocation.allocatedUnits),
    );
    if (issue) {
      throw new RequestError(issue.message, 409, issue.code);
    }
    if (!isCrccProgramEvidenceReference(allocation.evidenceReference)) {
      throw new RequestError(
        "Every CRC activity needs its CRCC pre-approval number or accepted post-approval program reference before renewal is submitted.",
        409,
        "crcc_program_reference_required",
      );
    }
  }
  const duplicate = await query(
    database,
    `SELECT LOWER(TRIM(activity.evidence_reference)) AS programReference
     FROM activity_allocations allocation
     JOIN activities activity
       ON activity.id = allocation.activity_id
       AND activity.user_id = ?
       AND activity.archived_at IS NULL
     WHERE allocation.credential_id = ?
       AND activity.evidence_reference LIKE 'CRCC %| %'
     GROUP BY LOWER(
       TRIM(
         SUBSTR(
           activity.evidence_reference,
           INSTR(activity.evidence_reference, '|') + 1
         )
       )
     )
     HAVING COUNT(*) > 1
     LIMIT 1`,
    [identity.userId, credentialId],
  ).first<{ programReference: string }>();
  if (duplicate) {
    throw new RequestError(
      "A CRCC approval or program reference appears more than once in this certification period. Keep only one record because CRCC permits the same program to be submitted once.",
      409,
      "crcc_duplicate_program",
    );
  }
  const postApprovalWithoutProof = await query(
    database,
    `SELECT activity.id
     FROM activity_allocations allocation
     JOIN activities activity
       ON activity.id = allocation.activity_id
       AND activity.user_id = ?
       AND activity.archived_at IS NULL
     WHERE allocation.credential_id = ?
       AND activity.evidence_reference LIKE 'CRCC post-approved | %'
       AND NOT EXISTS (
         SELECT 1
         FROM evidence_files evidence
         WHERE evidence.activity_id = activity.id
           AND evidence.user_id = activity.user_id
           AND evidence.status = 'ready'
       )
     LIMIT 1`,
    [identity.userId, credentialId],
  ).first<{ id: string }>();
  if (postApprovalWithoutProof) {
    throw new RequestError(
      "Upload CRCC's accepted post-approval record and supporting proof for every post-approved program before submitting the renewal.",
      409,
      "crcc_post_approval_proof_required",
    );
  }
  const [totals, thresholds] = await Promise.all([
    query(
      database,
      `SELECT
        COALESCE(SUM(
          CASE
            WHEN requirement.rule_category_id LIKE '%-general'
            THEN match.matched_units
            ELSE 0
          END
        ), 0) AS generalUnits,
        COALESCE(SUM(
          CASE
            WHEN requirement.rule_category_id LIKE
              '%-professional-development'
            THEN match.matched_units
            ELSE 0
          END
        ), 0) AS professionalDevelopmentUnits,
        COALESCE(SUM(
          CASE
            WHEN requirement.rule_category_id LIKE '%-ethics'
            THEN match.matched_units
            ELSE 0
          END
        ), 0) AS ethicsUnits,
        MAX(activity.completion_date) AS latestCompletionDate
       FROM activity_requirement_matches match
       JOIN activity_allocations allocation
         ON allocation.id = match.allocation_id
         AND allocation.credential_id = ?
       JOIN activities activity
         ON activity.id = allocation.activity_id
         AND activity.user_id = ?
         AND activity.archived_at IS NULL
       JOIN credential_requirements requirement
         ON requirement.id = match.requirement_id
         AND requirement.credential_id = allocation.credential_id
         AND requirement.is_active = 1
         AND requirement.applicability_status = 'applies'
       WHERE match.user_id = activity.user_id`,
      [credentialId, identity.userId],
    ).first<{
      generalUnits: number;
      professionalDevelopmentUnits: number;
      ethicsUnits: number;
      latestCompletionDate: string | null;
    }>(),
    query(
      database,
      `SELECT
        credential.total_required AS totalRequired,
        credential.deadline,
        (
          SELECT requirement.required_units
          FROM credential_requirements requirement
          WHERE requirement.credential_id = credential.id
            AND requirement.rule_category_id LIKE
              '%-professional-development'
            AND requirement.kind = 'maximum'
            AND requirement.is_active = 1
            AND requirement.applicability_status = 'applies'
          ORDER BY requirement.sort_order
          LIMIT 1
        ) AS professionalDevelopmentLimit,
        (
          SELECT requirement.required_units
          FROM credential_requirements requirement
          WHERE requirement.credential_id = credential.id
            AND requirement.rule_category_id LIKE '%-ethics'
            AND requirement.kind = 'minimum'
            AND requirement.is_active = 1
            AND requirement.applicability_status = 'applies'
          ORDER BY requirement.sort_order
          LIMIT 1
        ) AS ethicsMinimum
       FROM credentials credential
       WHERE credential.id = ?
         AND credential.user_id = ?`,
      [credentialId, identity.userId],
    ).first<{
      totalRequired: number;
      deadline: string;
      professionalDevelopmentLimit: number | null;
      ethicsMinimum: number | null;
    }>(),
  ]);
  const generalUnits = Number(totals?.generalUnits ?? 0);
  const professionalDevelopmentUnits = Number(
    totals?.professionalDevelopmentUnits ?? 0,
  );
  const ethicsUnits = Number(totals?.ethicsUnits ?? 0);
  const latestCompletionDate = totals?.latestCompletionDate ?? null;
  const totalRequired = Number(thresholds?.totalRequired ?? 0);
  const professionalDevelopmentLimit = Number(
    thresholds?.professionalDevelopmentLimit ?? 0,
  );
  const ethicsMinimum = Number(thresholds?.ethicsMinimum ?? 0);
  if (submissionDate > (thresholds?.deadline ?? "")) {
    throw new RequestError(
      `The standard CRC renewal must be submitted by the certification valid-through date, ${thresholds?.deadline}. Create a custom plan for an approved extension, reinstatement, or other adjusted period.`,
      409,
      "crcc_submission_after_deadline",
    );
  }
  if (latestCompletionDate && latestCompletionDate > submissionDate) {
    throw new RequestError(
      `The CRC submission date cannot be before the latest credited program, completed ${latestCompletionDate}.`,
      409,
      "crcc_activity_after_submission",
    );
  }
  if (
    totalRequired <= 0 ||
    professionalDevelopmentLimit <= 0 ||
    ethicsMinimum <= 0
  ) {
    throw new RequestError(
      "This CRC credential snapshot is missing its total, Professional Development maximum, or ethics minimum. Refresh the current template before submitting.",
      409,
      "crcc_requirement_template_incomplete",
    );
  }
  const countableTotal =
    generalUnits +
    Math.min(
      professionalDevelopmentLimit,
      professionalDevelopmentUnits,
    );
  if (
    countableTotal + 0.001 < totalRequired ||
    ethicsUnits + 0.001 < ethicsMinimum
  ) {
    throw new RequestError(
      `The CRC record must contain ${totalRequired} countable approved hours, including at least ${ethicsMinimum} ethics hours and no more than ${professionalDevelopmentLimit} counted Professional Development hours. Current accepted totals: ${countableTotal} countable, ${ethicsUnits} ethics.`,
      409,
      "crcc_requirements_incomplete",
    );
  }
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
  const isCrccSubmission =
    credential.ruleSetId?.startsWith(CRCC_RULE_SET_PREFIX) ?? false;
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
  if (isCrccSubmission && payload.complianceAttested !== true) {
    throw new RequestError(
      "Confirm that CRCCCONNECT shows every program accepted under the recorded credit types and the required countable total, ethics minimum, and Professional Development cap for this cycle satisfied.",
      409,
      "crcc_submission_attestation_required",
    );
  }
  await assertPortalCarryoverEvidenceReady(
    database,
    identity,
    credentialId,
  );
  await assertDentalCheckpointsComplete(
    database,
    identity,
    credentialId,
  );
  await assertDentalDailyTotalsWithinLimit(
    database,
    identity,
    credentialId,
    credential.ruleSetId,
  );
  await assertDentalPerActivityClassificationsReady(
    database,
    identity,
    credentialId,
    credential.ruleSetId,
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
  if (isCrccSubmission) {
    await assertCrcProgramsReady(
      database,
      identity,
      credentialId,
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
        : isCrccSubmission
          ? "crcc_requirements_satisfied"
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
         AND status IN ('active', 'submitted')
         AND NOT EXISTS (
           SELECT 1
           FROM credential_requirements checkpoint_requirement
           LEFT JOIN dental_checkpoint_states checkpoint_state
             ON checkpoint_state.requirement_id = checkpoint_requirement.id
             AND checkpoint_state.credential_id = credentials.id
             AND checkpoint_state.user_id = credentials.user_id
           WHERE checkpoint_requirement.credential_id = credentials.id
             AND credentials.profession = 'Dental'
             AND checkpoint_requirement.rule_category_id IN (
               ${DENTAL_CHECKPOINT_RULE_CATEGORY_IDS_SQL}
             )
             AND checkpoint_requirement.kind = 'informational'
             AND checkpoint_requirement.required_units = 0
             AND checkpoint_requirement.is_active = 1
             AND checkpoint_requirement.applicability_status = 'applies'
             AND COALESCE(checkpoint_state.status, 'pending') <>
               'completed'
         )`,
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
         revision = revision + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE credential_id = ? AND user_id = ? AND kind = 'submission'
         AND is_personal = 0
         AND archived_at IS NULL
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
    await assertDentalCheckpointsComplete(
      database,
      identity,
      credentialId,
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
        evidence_status AS evidenceStatus,
        evidence_reference AS evidenceReference,
        revision,
        archived_at AS archivedAt
       FROM activities
       WHERE id = ? AND user_id = ?`,
      [activityId, identity.userId],
    ).first<{
      id: string;
      totalUnits: number;
      completionDate: string;
      evidenceStatus: string;
      evidenceReference: string | null;
      revision: number;
      archivedAt: string | null;
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
  if (activity.archivedAt) {
    throw new RequestError(
      "Restore this learning record before changing its allocations.",
      409,
      "activity_archived",
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

  const [isNremt, isCrc] = await Promise.all([
    isOwnedNremtCredential(database, identity, credentialId),
    isOwnedCrcCredential(database, identity, credentialId),
  ]);
  const exactMatches = isNremt || isCrc
    ? requirementMatchesField(payload, {
        required: true,
        context: isCrc ? "crcc" : "nremt",
      })
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
  let crcEvidenceReference: string | null = null;
  if (isCrc) {
    crcEvidenceReference = crcProgramEvidenceReference(
      payload,
      allocatedUnits,
    );
    if (
      isCrccProgramEvidenceReference(activity.evidenceReference) &&
      activity.evidenceReference?.toLowerCase() !==
        crcEvidenceReference.toLowerCase()
    ) {
      throw new RequestError(
        "This learning record already has a different CRCC approval or program reference. Use the existing reference or create a separate record.",
        409,
        "crcc_program_reference_conflict",
      );
    }
    if (
      activity.evidenceStatus === "not_required" &&
      isCrccPostApprovedReference(crcEvidenceReference)
    ) {
      throw new RequestError(
        "CRCC requires an uploaded completion record for post-approved credit. This learning record is marked proof not required, so use a record that can retain the accepted post-approval proof.",
        409,
        "crcc_post_approval_proof_required",
      );
    }
    await assertNoDuplicateCrcProgram(
      database,
      identity,
      credentialId,
      crcEvidenceReference,
      activityId,
    );
  }
  const selectedRequirements = isNremt
    ? await validateNremtRequirementMatches(
        database,
        identity,
        credentialId,
        exactMatches,
        allocatedUnits,
      )
    : isCrc
      ? await validateCrcRequirementMatches(
          database,
          identity,
          credentialId,
          exactMatches,
          allocatedUnits,
        )
      : await validateRequirementTags(
          database,
          identity,
          credentialId,
          legacyRequirementIds,
        );
  const persistedMatches: RequirementMatchInput[] =
    isNremt || isCrc
    ? exactMatches
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
  assertActivityDateFitsCredential(
    activity.completionDate,
    credential,
    selectedRequirements,
    "activity date",
  );
  assertDentalPerActivityRequirements(
    selectedRequirements,
    allocatedUnits,
  );
  await assertDentalDailyUnitLimit(
    database,
    identity,
    credentialId,
    undefined,
    activity.completionDate,
    allocatedUnits,
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
        AND credential.status IN ('active', 'submitted')
        AND EXISTS (
          SELECT 1
          FROM activities activity
          WHERE activity.id = ?
            AND activity.user_id = credential.user_id
            AND activity.revision = ?
            AND activity.archived_at IS NULL
        )`,
      [
        allocationId,
        activityId,
        primaryRequirementId,
        allocatedUnits,
        credentialId,
        identity.userId,
        activityId,
        Number(activity.revision),
      ],
    ),
  ];
  for (const match of persistedMatches) {
    statements.push(
      query(
        database,
        `INSERT INTO activity_requirement_matches (
          id, user_id, allocation_id, requirement_id, matched_units
        )
        SELECT ?, ?, allocation.id, ?, ?
        FROM activity_allocations allocation
        JOIN activities mutable_activity
          ON mutable_activity.id = allocation.activity_id
        JOIN credentials mutable_credential
          ON mutable_credential.id = allocation.credential_id
        WHERE allocation.id = ?
          AND allocation.activity_id = ?
          AND allocation.credential_id = ?
          AND mutable_activity.user_id = ?
          AND mutable_activity.revision = ?
          AND mutable_activity.archived_at IS NULL
          AND mutable_credential.user_id = mutable_activity.user_id
          AND mutable_credential.status IN ('active', 'submitted')`,
        [
          crypto.randomUUID(),
          identity.userId,
          match.requirementId,
          match.matchedUnits,
          allocationId,
          activityId,
          credentialId,
          identity.userId,
          Number(activity.revision),
        ],
      ),
    );
  }
  const revisionResultIndex = statements.length;
  statements.push(
    query(
      database,
      `UPDATE activities
       SET
         evidence_reference = COALESCE(?, evidence_reference),
         revision = revision + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND user_id = ?
         AND revision = ?
         AND archived_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM activity_allocations saved_allocation
           JOIN credentials saved_credential
             ON saved_credential.id = saved_allocation.credential_id
           WHERE saved_allocation.id = ?
             AND saved_allocation.activity_id = activities.id
             AND saved_allocation.credential_id = ?
             AND saved_credential.user_id = activities.user_id
             AND saved_credential.status IN ('active', 'submitted')
         )`,
      [
        crcEvidenceReference,
        activityId,
        identity.userId,
        Number(activity.revision),
        allocationId,
        credentialId,
      ],
    ),
  );
  try {
    const results = await database.batch(statements);
    if (
      Number(results[0]?.meta?.changes ?? Number.NaN) === 0 ||
      Number(
        results[revisionResultIndex]?.meta?.changes ?? Number.NaN,
      ) === 0
    ) {
      const currentActivity = await query(
        database,
        `SELECT archived_at AS archivedAt
         FROM activities
         WHERE id = ? AND user_id = ?`,
        [activityId, identity.userId],
      ).first<{ archivedAt: string | null }>();
      if (!currentActivity) {
        throw new RequestError(
          "Activity not found.",
          404,
          "activity_not_found",
        );
      }
      if (currentActivity.archivedAt) {
        throw new RequestError(
          "Restore this learning record before changing its allocations.",
          409,
          "activity_archived",
        );
      }
      await assertCredentialStillMutable(
        database,
        identity,
        credentialId,
        "This renewal cycle is closed and cannot receive activities.",
      );
      throw new RequestError(
        "This learning record or renewal changed while the allocation was being saved. Refresh and try again.",
        409,
        "allocation_state_changed",
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
  const requestedAllocatedUnits = positiveNumber(
    payload,
    "allocatedUnits",
  );
  const legacyRequirementIds = requirementIdsField(payload);

  const allocation = await query(
    database,
    `SELECT
      allocation.id,
      allocation.credential_id AS credentialId,
      allocation.allocated_units AS allocatedUnits,
      activity.id AS activityId,
      activity.revision AS activityRevision,
      activity.completion_date AS completionDate,
      activity.total_units AS totalUnits,
      activity.evidence_status AS evidenceStatus,
      activity.archived_at AS archivedAt,
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
    activityId: string;
    activityRevision: number;
    completionDate: string;
    totalUnits: number;
    evidenceStatus: string;
    archivedAt: string | null;
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
  if (allocation.archivedAt) {
    throw new RequestError(
      "Restore this learning record before changing its classification.",
      409,
      "activity_archived",
    );
  }

  const [isNremt, isCrc] = await Promise.all([
    isOwnedNremtCredential(
      database,
      identity,
      allocation.credentialId,
    ),
    isOwnedCrcCredential(
      database,
      identity,
      allocation.credentialId,
    ),
  ]);
  const hasExactRequirementAmounts = isNremt || isCrc;
  if (
    hasExactRequirementAmounts &&
    requestedAllocatedUnits !== null &&
    !unitsEqual(
      requestedAllocatedUnits,
      Number(allocation.allocatedUnits),
    )
  ) {
    throw new RequestError(
      isNremt
        ? "National Registry component and topic amounts must stay exact. Archive this record and log the corrected replacement with its precise component and topic split."
        : "The total CRC hours applied to this credential stay fixed while you correct the General, Professional Development, and Ethics split.",
      409,
      isNremt
        ? "nremt_allocation_revision_required"
        : "crcc_allocation_revision_required",
    );
  }
  const updatesAllocatedUnits =
    !hasExactRequirementAmounts && requestedAllocatedUnits !== null;
  const allocatedUnits = updatesAllocatedUnits
    ? requestedAllocatedUnits
    : Number(allocation.allocatedUnits);
  if (allocatedUnits > Number(allocation.totalUnits)) {
    throw new RequestError(
      "allocatedUnits cannot exceed the activity total for one credential",
    );
  }
  const exactMatches = hasExactRequirementAmounts
    ? requirementMatchesField(payload, {
        required: true,
        context: isCrc ? "crcc" : "nremt",
      })
    : [];
  if (isCrc && payload.crcApprovalAttested !== true) {
    throw new RequestError(
      "Confirm that the corrected General, Professional Development, and Ethics amounts match the saved CRCC approval record.",
      409,
      "crcc_allocation_attestation_required",
    );
  }
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
        exactMatches,
        allocatedUnits,
      )
    : isCrc
      ? await validateCrcRequirementMatches(
          database,
          identity,
          allocation.credentialId,
          exactMatches,
          allocatedUnits,
        )
      : await validateRequirementTags(
          database,
          identity,
          allocation.credentialId,
          legacyRequirementIds,
        );
  const persistedMatches: RequirementMatchInput[] =
    hasExactRequirementAmounts
    ? exactMatches
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
  assertActivityDateFitsCredential(
    allocation.completionDate,
    allocation,
    selectedRequirements,
    "activity date",
  );
  assertDentalPerActivityRequirements(
    selectedRequirements,
    allocatedUnits,
  );
  if (updatesAllocatedUnits) {
    await assertDentalDailyUnitLimit(
      database,
      identity,
      allocation.credentialId,
      undefined,
      allocation.completionDate,
      allocatedUnits,
      allocation.activityId,
    );
  }

  const statements: D1PreparedStatement[] = [
    query(
      database,
      `UPDATE activity_allocations
       SET
         requirement_id = ?
         ${updatesAllocatedUnits ? ", allocated_units = ?" : ""}
       WHERE id = ? AND credential_id = ?
         AND EXISTS (
           SELECT 1
           FROM credentials credential
           JOIN activities activity
             ON activity.id = activity_allocations.activity_id
             AND activity.user_id = credential.user_id
             AND activity.revision = ?
             AND activity.archived_at IS NULL
           WHERE credential.id = activity_allocations.credential_id
             AND credential.user_id = ?
             AND credential.status IN ('active', 'submitted')
         )`,
      [
        primaryRequirementId,
        ...(updatesAllocatedUnits ? [allocatedUnits] : []),
        allocationId,
        allocation.credentialId,
        Number(allocation.activityRevision),
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
           JOIN activities activity
             ON activity.id = allocation.activity_id
             AND activity.archived_at IS NULL
           JOIN credentials credential
             ON credential.id = allocation.credential_id
           WHERE allocation.id =
             activity_requirement_matches.allocation_id
             AND activity.revision = ?
             AND credential.user_id = ?
             AND credential.status IN ('active', 'submitted')
         )`,
      [
        allocationId,
        identity.userId,
        Number(allocation.activityRevision),
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
        )
        SELECT ?, ?, allocation.id, ?, ${
          hasExactRequirementAmounts
            ? "?"
            : "allocation.allocated_units"
        }
        FROM activity_allocations allocation
        JOIN activities activity
          ON activity.id = allocation.activity_id
          AND activity.archived_at IS NULL
        JOIN credentials credential
          ON credential.id = allocation.credential_id
        WHERE allocation.id = ?
          AND allocation.credential_id = ?
          AND activity.revision = ?
          AND credential.user_id = ?
          AND credential.status IN ('active', 'submitted')`,
        [
          crypto.randomUUID(),
          identity.userId,
          match.requirementId,
          ...(hasExactRequirementAmounts ? [match.matchedUnits] : []),
          allocationId,
          allocation.credentialId,
          Number(allocation.activityRevision),
          identity.userId,
        ],
      ),
    );
  }
  const revisionResultIndex = statements.length;
  statements.push(
    query(
      database,
      `UPDATE activities
       SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
         AND user_id = ?
         AND revision = ?
         AND archived_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM activity_allocations saved_allocation
           JOIN credentials saved_credential
             ON saved_credential.id = saved_allocation.credential_id
           WHERE saved_allocation.id = ?
             AND saved_allocation.activity_id = activities.id
             AND saved_allocation.credential_id = ?
             AND saved_credential.user_id = activities.user_id
             AND saved_credential.status IN ('active', 'submitted')
         )`,
      [
        allocation.activityId,
        identity.userId,
        Number(allocation.activityRevision),
        allocationId,
        allocation.credentialId,
      ],
    ),
  );
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
  if (
    Number(results[0]?.meta?.changes ?? Number.NaN) === 0 ||
    Number(
      results[revisionResultIndex]?.meta?.changes ?? Number.NaN,
    ) === 0
  ) {
    const currentAllocation = await query(
      database,
      `SELECT
        activity.archived_at AS archivedAt,
        credential.status AS credentialStatus
       FROM activity_allocations current_allocation
       JOIN activities activity
         ON activity.id = current_allocation.activity_id
       JOIN credentials credential
         ON credential.id = current_allocation.credential_id
       WHERE current_allocation.id = ?
         AND activity.user_id = ?
         AND credential.user_id = activity.user_id`,
      [allocationId, identity.userId],
    ).first<{
      archivedAt: string | null;
      credentialStatus: string;
    }>();
    if (!currentAllocation) {
      throw new RequestError(
        "Activity allocation not found.",
        404,
        "allocation_not_found",
      );
    }
    if (currentAllocation.archivedAt) {
      throw new RequestError(
        "Restore this learning record before changing its classification.",
        409,
        "activity_archived",
      );
    }
    if (
      !["active", "submitted"].includes(
        currentAllocation.credentialStatus,
      )
    ) {
      throw new RequestError(
        "This renewal cycle is closed and cannot be changed.",
        409,
        "cycle_closed",
      );
    }
    throw new RequestError(
      "This activity allocation changed while it was being saved. Refresh and try again.",
      409,
      "allocation_state_changed",
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
  const isManagedPharmacistRenewal = isManagedPharmacistCredential(
    credential.profession,
    credential.ruleSetId,
  );
  const isManagedNursingRenewal = isManagedNursingCredential(
    credential.profession,
    credential.ruleSetId,
  );
  const isManagedDentalRenewal = isManagedDentalCredential(
    credential.profession,
    credential.ruleSetId,
  );
  const isExpandedCertificationRenewal =
    isExpandedCertificationRuleSetId(credential.ruleSetId);
  const isManagedRehabilitationRenewal =
    isManagedRehabilitationCredential(
      credential.profession,
      credential.ruleSetId,
    );
  const isAbveRenewal =
    credential.ruleSetId?.startsWith(ABVE_RULE_SET_PREFIX) ?? false;
  const isCrccRenewal =
    credential.ruleSetId?.startsWith(CRCC_RULE_SET_PREFIX) ?? false;
  const requiresOfficialNextPeriodAttestation =
    isIsc2AutomaticRenewal ||
    isCompliancePeriod ||
    replacementTemplateFamily === "florida_mental_health" ||
    isNremtRenewal ||
    isManagedPharmacistRenewal ||
    isManagedNursingRenewal ||
    isManagedDentalRenewal ||
    isManagedRehabilitationRenewal ||
    isExpandedCertificationRenewal;
  const requiresNonOverlappingNextPeriod =
    isIsc2AutomaticRenewal ||
    isCompliancePeriod ||
    replacementTemplateFamily === "florida_mental_health" ||
    isManagedPharmacistRenewal ||
    isManagedNursingRenewal ||
    isManagedDentalRenewal ||
    isManagedRehabilitationRenewal ||
    isExpandedCertificationRenewal;
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
  if (
    isManagedPharmacistRenewal &&
    payload.templateEligibilityAttested !== true
  ) {
    throw new RequestError(
      "Confirm that the official next-period record is a standard full pharmacist renewal and that no shortened, inactive, prorated, exempt, or other adjusted-status variant applies.",
      409,
      "pharmacist_next_template_eligibility_required",
    );
  }
  if (
    isManagedNursingRenewal &&
    payload.templateEligibilityAttested !== true
  ) {
    throw new RequestError(
      credential.ruleSetId === "tx-rn-2026-v1" ||
        credential.ruleSetId === "tx-lvn-2026-v1"
        ? "Confirm that the official next-period record matches a standard full Texas nursing renewal using the 20-hour CNE path—not the certification alternative—and that no initial, shortened, inactive, exempt, or other adjusted-status path applies."
        : "Confirm that the official next-period record matches a standard full nursing renewal or registration period and that no initial, shortened, inactive, prorated, exempt, or other adjusted-status path applies.",
      409,
      "nursing_next_template_eligibility_required",
    );
  }
  if (
    isManagedDentalRenewal &&
    payload.templateEligibilityAttested !== true
  ) {
    throw new RequestError(
      "Confirm that the official next-period record matches a standard full dental renewal or registration period and that no initial, shortened, inactive, retired, prorated, exempt, or other adjusted-status path applies.",
      409,
      "dental_next_template_eligibility_required",
    );
  }
  if (
    isExpandedCertificationRenewal &&
    payload.templateEligibilityAttested !== true
  ) {
    throw new RequestError(
      "Confirm that the official next-period record uses the same standard full-cycle credential or license path and that no initial, shortened, waiver, inactive, retired, reinstatement, synchronized or multi-credential, exam-alternative, or other adjusted variant applies.",
      409,
      "expanded_certification_next_template_eligibility_required",
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
  if (
    isManagedDentalRenewal &&
    nextCycleStart !== daysAfter(credential.deadline, 1)
  ) {
    throw new RequestError(
      `A standard dental renewal must begin immediately after the current period, on ${daysAfter(credential.deadline, 1)}. Create a custom plan if the regulator assigned a gap, reinstatement, or adjusted period.`,
      409,
      "dental_next_cycle_must_be_consecutive",
    );
  }
  if (
    isCrccRenewal &&
    nextCycleStart !== daysAfter(credential.deadline, 1)
  ) {
    throw new RequestError(
      `A standard CRC certification period must begin immediately after the current period, on ${daysAfter(credential.deadline, 1)}. Create a custom plan if CRCC assigned an extension, reinstatement, gap, or adjusted period.`,
      409,
      "crcc_next_cycle_must_be_consecutive",
    );
  }
  if (isAbveRenewal) {
    throw new RequestError(
      "ABVE has not yet published a verified Fellow or Diplomate template for the cycle after December 31, 2027. Keep this completed cycle open until the next official requirements and dates are available.",
      409,
      "abve_next_cycle_template_unavailable",
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
  } else if (isManagedPharmacistRenewal) {
    if (requestedNextRuleSetId) {
      throw new RequestError(
        "Pharmacist renewals automatically use the latest current version of the same official template.",
        400,
        "pharmacist_next_template_not_selectable",
      );
    }
    selectedNextRule = await query(
      database,
      `SELECT
        current_rule.id,
        current_rule.credential_name AS credentialName,
        current_rule.profession,
        current_rule.jurisdiction,
        current_rule.issuer,
        current_rule.total_units AS totalUnits,
        current_rule.unit_label AS unitLabel,
        current_rule.cycle_months AS cycleMonths
       FROM rule_sets prior_rule
       JOIN rule_sets current_rule
         ON current_rule.stable_key = prior_rule.stable_key
       WHERE prior_rule.id = ?
         AND prior_rule.stable_key IS ?
         AND current_rule.is_current = 1
         AND current_rule.profession = 'Pharmacy'
       ORDER BY current_rule.version DESC
       LIMIT 1`,
      [credential.ruleSetId, credential.ruleStableKey],
    ).first<NextRuleTemplate>();
    if (!selectedNextRule) {
      throw new RequestError(
        "The current pharmacist template is unavailable. Review the official rule and create the next plan manually.",
        409,
        "pharmacist_current_template_unavailable",
      );
    }
    if (
      !matchesFullCycleWindow(
        nextCycleStart,
        nextDeadline,
        Number(selectedNextRule.cycleMonths),
      )
    ) {
      throw new RequestError(
        `The next pharmacist plan must use the official standard ${selectedNextRule.cycleMonths}-month period. Create a custom plan if the regulator assigned a shortened or adjusted cycle.`,
        409,
        "pharmacist_next_cycle_dates_required",
      );
    }
  } else if (isManagedNursingRenewal) {
    if (requestedNextRuleSetId) {
      throw new RequestError(
        "Nursing renewals automatically use the latest current version of the same official template.",
        400,
        "nursing_next_template_not_selectable",
      );
    }
    selectedNextRule = await query(
      database,
      `SELECT
        current_rule.id,
        current_rule.credential_name AS credentialName,
        current_rule.profession,
        current_rule.jurisdiction,
        current_rule.issuer,
        current_rule.total_units AS totalUnits,
        current_rule.unit_label AS unitLabel,
        current_rule.cycle_months AS cycleMonths
       FROM rule_sets prior_rule
       JOIN rule_sets current_rule
         ON current_rule.stable_key = prior_rule.stable_key
       WHERE prior_rule.id = ?
         AND prior_rule.stable_key IS ?
         AND current_rule.is_current = 1
         AND current_rule.profession = 'Nursing'
       ORDER BY current_rule.version DESC
       LIMIT 1`,
      [credential.ruleSetId, credential.ruleStableKey],
    ).first<NextRuleTemplate>();
    if (!selectedNextRule) {
      throw new RequestError(
        "The current nursing template is unavailable. Review the official rule and create the next plan manually.",
        409,
        "nursing_current_template_unavailable",
      );
    }
    if (
      !matchesFullCycleWindow(
        nextCycleStart,
        nextDeadline,
        Number(selectedNextRule.cycleMonths),
      )
    ) {
      throw new RequestError(
        `The next nursing plan must use the official standard ${selectedNextRule.cycleMonths}-month period. Create a custom plan if the regulator assigned an initial, shortened, or adjusted cycle.`,
        409,
        "nursing_next_cycle_dates_required",
      );
    }
  } else if (isManagedDentalRenewal) {
    if (requestedNextRuleSetId) {
      throw new RequestError(
        "Dental renewals automatically use the latest current version of the same official template.",
        400,
        "dental_next_template_not_selectable",
      );
    }
    selectedNextRule = await query(
      database,
      `SELECT
        current_rule.id,
        current_rule.credential_name AS credentialName,
        current_rule.profession,
        current_rule.jurisdiction,
        current_rule.issuer,
        current_rule.total_units AS totalUnits,
        current_rule.unit_label AS unitLabel,
        current_rule.cycle_months AS cycleMonths
       FROM rule_sets prior_rule
       JOIN rule_sets current_rule
         ON current_rule.stable_key = prior_rule.stable_key
       WHERE prior_rule.id = ?
         AND prior_rule.stable_key IS ?
         AND current_rule.is_current = 1
         AND current_rule.profession = 'Dental'
       ORDER BY current_rule.version DESC
       LIMIT 1`,
      [credential.ruleSetId, credential.ruleStableKey],
    ).first<NextRuleTemplate>();
    if (!selectedNextRule) {
      throw new RequestError(
        "The current dental template is unavailable. Review the official rule and create the next plan manually.",
        409,
        "dental_current_template_unavailable",
      );
    }
    if (
      !matchesFullCycleWindow(
        nextCycleStart,
        nextDeadline,
        Number(selectedNextRule.cycleMonths),
      )
    ) {
      throw new RequestError(
        `The next dental plan must use the official standard ${selectedNextRule.cycleMonths}-month period. Create a custom plan if the regulator assigned an initial, shortened, or adjusted cycle.`,
        409,
        "dental_next_cycle_dates_required",
      );
    }
  } else if (isExpandedCertificationRenewal) {
    if (requestedNextRuleSetId) {
      throw new RequestError(
        "Credential and license maintenance renewals automatically use the latest current version of the same official template.",
        400,
        "expanded_certification_next_template_not_selectable",
      );
    }
    selectedNextRule = await query(
      database,
      `SELECT
        current_rule.id,
        current_rule.credential_name AS credentialName,
        current_rule.profession,
        current_rule.jurisdiction,
        current_rule.issuer,
        current_rule.total_units AS totalUnits,
        current_rule.unit_label AS unitLabel,
        current_rule.cycle_months AS cycleMonths
       FROM rule_sets prior_rule
       JOIN rule_sets current_rule
         ON current_rule.stable_key = prior_rule.stable_key
       WHERE prior_rule.id = ?
         AND prior_rule.stable_key IS ?
         AND current_rule.is_current = 1
       ORDER BY current_rule.version DESC
       LIMIT 1`,
      [credential.ruleSetId, credential.ruleStableKey],
    ).first<NextRuleTemplate>();
    if (!selectedNextRule) {
      throw new RequestError(
        "The current credential or license template is unavailable. Review the official issuer or regulator requirements and create the next plan manually.",
        409,
        "expanded_certification_current_template_unavailable",
      );
    }
  } else if (isCrccRenewal) {
    if (requestedNextRuleSetId) {
      throw new RequestError(
        "CRC renewals automatically use the latest current version of the same official template.",
        400,
        "crcc_next_template_not_selectable",
      );
    }
    selectedNextRule = await query(
      database,
      `SELECT
        current_rule.id,
        current_rule.credential_name AS credentialName,
        current_rule.profession,
        current_rule.jurisdiction,
        current_rule.issuer,
        current_rule.total_units AS totalUnits,
        current_rule.unit_label AS unitLabel,
        current_rule.cycle_months AS cycleMonths
       FROM rule_sets prior_rule
       JOIN rule_sets current_rule
         ON current_rule.stable_key = prior_rule.stable_key
       WHERE prior_rule.id = ?
         AND prior_rule.stable_key IS ?
         AND current_rule.is_current = 1
         AND current_rule.profession = 'Vocational Rehabilitation'
         AND current_rule.id LIKE 'crcc-%'
       ORDER BY current_rule.version DESC
       LIMIT 1`,
      [credential.ruleSetId, credential.ruleStableKey],
    ).first<NextRuleTemplate>();
    if (!selectedNextRule) {
      throw new RequestError(
        "The current CRC template is unavailable. Review CRCCCONNECT and create the next plan manually.",
        409,
        "crcc_current_template_unavailable",
      );
    }
    if (
      !matchesFullCycleWindow(
        nextCycleStart,
        nextDeadline,
        Number(selectedNextRule.cycleMonths),
      )
    ) {
      throw new RequestError(
        `The next CRC plan must use the exact standard ${selectedNextRule.cycleMonths}-month certification period. Create a custom plan if CRCC assigned an extension, reinstatement, or adjusted period.`,
        409,
        "crcc_next_cycle_dates_required",
      );
    }
  } else if (requestedNextRuleSetId) {
    throw new RequestError(
      "A replacement rule template may be selected only for a supported Florida rollover.",
      400,
      "next_template_not_allowed",
    );
  }
  if (selectedNextRule) {
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
  }
  const selectedNextCategoriesSnapshotJson = JSON.stringify(
    selectedNextCategories.map((category) => ({
      id: category.id,
      name: category.name,
      requiredUnits: Number(category.requiredUnits),
      kind: category.kind,
      relation: category.relation,
      parentCategoryId: category.parentCategoryId,
      applicability: category.applicability,
      conditionNote: category.conditionNote,
      exclusiveGroup: category.exclusiveGroup,
      sortOrder: Number(category.sortOrder),
    })),
  );
  const nextCatalogSnapshotGuard = selectedNextRule
    ? {
        sql: `EXISTS (
          SELECT 1
          FROM rule_sets selected_rule
          WHERE selected_rule.id = ?
            AND selected_rule.is_current = 1
            ${
              isManagedPharmacistRenewal ||
              isManagedNursingRenewal ||
              isManagedDentalRenewal ||
              isExpandedCertificationRenewal ||
              isCrccRenewal
                ? `AND NOT EXISTS (
                    SELECT 1
                    FROM rule_sets newer_rule
                    WHERE newer_rule.stable_key = selected_rule.stable_key
                      AND newer_rule.is_current = 1
                      AND newer_rule.version > selected_rule.version
                  )`
                : ""
            }
            ${
              isNremtRenewal ||
              isManagedPharmacistRenewal ||
              isManagedNursingRenewal ||
              isManagedDentalRenewal ||
              isExpandedCertificationRenewal ||
              isCrccRenewal
                ? "AND selected_rule.stable_key IS ?"
                : ""
            }
            ${
              isManagedPharmacistRenewal ||
              isManagedNursingRenewal ||
              isManagedDentalRenewal ||
              isExpandedCertificationRenewal ||
              isCrccRenewal
                ? `AND EXISTS (
                    SELECT 1
                    FROM rule_sets prior_rule_snapshot
                    WHERE prior_rule_snapshot.id = ?
                      AND prior_rule_snapshot.stable_key IS ?
                  )`
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
            ) = json_array_length(?)
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(?) snapshot_category
              WHERE NOT EXISTS (
                  SELECT 1
                  FROM rule_categories selected_category
                  WHERE selected_category.rule_set_id = selected_rule.id
                    AND selected_category.id IS
                      json_extract(snapshot_category.value, '$.id')
                    AND selected_category.name IS
                      json_extract(snapshot_category.value, '$.name')
                    AND selected_category.required_units IS
                      json_extract(
                        snapshot_category.value,
                        '$.requiredUnits'
                      )
                    AND selected_category.kind IS
                      json_extract(snapshot_category.value, '$.kind')
                    AND selected_category.relation IS
                      json_extract(snapshot_category.value, '$.relation')
                    AND selected_category.parent_category_id IS
                      json_extract(
                        snapshot_category.value,
                        '$.parentCategoryId'
                      )
                    AND selected_category.applicability IS
                      json_extract(
                        snapshot_category.value,
                        '$.applicability'
                      )
                    AND selected_category.condition_note IS
                      json_extract(
                        snapshot_category.value,
                        '$.conditionNote'
                      )
                    AND selected_category.exclusive_group IS
                      json_extract(
                        snapshot_category.value,
                        '$.exclusiveGroup'
                      )
                    AND selected_category.sort_order IS
                      json_extract(
                        snapshot_category.value,
                        '$.sortOrder'
                      )
              )
            )
        )`,
        bindings: [
          selectedNextRule.id,
          ...(
            isNremtRenewal ||
            isManagedPharmacistRenewal ||
            isManagedNursingRenewal ||
            isManagedDentalRenewal ||
            isExpandedCertificationRenewal ||
            isCrccRenewal
              ? [credential.ruleStableKey]
              : []
          ),
          ...(
            isManagedPharmacistRenewal ||
            isManagedNursingRenewal ||
            isManagedDentalRenewal ||
            isExpandedCertificationRenewal ||
            isCrccRenewal
              ? [credential.ruleSetId, credential.ruleStableKey]
              : []
          ),
          selectedNextRule.credentialName,
          selectedNextRule.profession,
          selectedNextRule.jurisdiction,
          selectedNextRule.issuer,
          Number(selectedNextRule.totalUnits),
          selectedNextRule.unitLabel,
          Number(selectedNextRule.cycleMonths),
          selectedNextCategoriesSnapshotJson,
          selectedNextCategoriesSnapshotJson,
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
      isManagedPharmacistRenewal
        ? "The current pharmacist template changed while the next renewal period was being created. Review the current template and try again."
        : isManagedNursingRenewal
          ? "The current nursing template changed while the next renewal period was being created. Review the current template and try again."
          : isManagedDentalRenewal
            ? "The current dental template changed while the next renewal period was being created. Review the current template and try again."
            : isExpandedCertificationRenewal
              ? "The current credential or license template changed while the next maintenance period was being created. Review the official requirements and current template, then try again."
              : isCrccRenewal
                ? "The current CRC template changed while the next certification period was being created. Review CRCCCONNECT and the current template, then try again."
        : isNremtRenewal
        ? "The selected National Registry template changed while the next cycle was being created. Review the current dashboard model and catalog template, then try again."
        : replacementTemplateFamily === "florida_mental_health"
          ? "The selected Florida mental-health phase changed while the next biennium was being created. Review the current CE Broker phase and catalog template, then try again."
          : "The selected Florida producer template changed while the next compliance period was being created. Review the current template and try again.",
      409,
      isManagedPharmacistRenewal
        ? "pharmacist_current_template_changed"
        : isManagedNursingRenewal
          ? "nursing_current_template_changed"
          : isManagedDentalRenewal
            ? "dental_current_template_changed"
            : isExpandedCertificationRenewal
              ? "expanded_certification_current_template_changed"
              : isCrccRenewal
                ? "crcc_current_template_changed"
        : isNremtRenewal
        ? "nremt_next_template_changed"
        : replacementTemplateFamily === "florida_mental_health"
          ? "florida_mental_health_next_template_changed"
          : "florida_next_template_changed",
    );
  };
  const linkedActivitySnapshot = await query(
    database,
    `SELECT DISTINCT
      activity.id,
      activity.revision
     FROM activity_allocations allocation
     JOIN activities activity ON activity.id = allocation.activity_id
     JOIN credentials linked_credential
       ON linked_credential.id = allocation.credential_id
     WHERE allocation.credential_id = ?
       AND activity.user_id = ?
       AND activity.archived_at IS NULL
       AND linked_credential.user_id = activity.user_id
     ORDER BY activity.id`,
    [credentialId, identity.userId],
  ).all<{ id: string; revision: number }>();
  const linkedActivitySnapshotRows = linkedActivitySnapshot.results.map(
    (activity) => ({
      id: activity.id,
      revision: Number(activity.revision),
    }),
  );
  const linkedActivitySnapshotJson = JSON.stringify(
    linkedActivitySnapshotRows,
  );
  if (isCrccRenewal) {
    await assertCrcProgramsReady(
      database,
      identity,
      credentialId,
      submission.submittedAt.slice(0, 10),
    );
  }
  const linkedActivitySnapshotCondition = `(
    (
      SELECT COUNT(DISTINCT current_activity.id)
      FROM activity_allocations current_allocation
      JOIN activities current_activity
        ON current_activity.id = current_allocation.activity_id
        AND current_activity.user_id = credentials.user_id
        AND current_activity.archived_at IS NULL
      WHERE current_allocation.credential_id = credentials.id
    ) = json_array_length(?)
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(?) snapshot
      WHERE NOT EXISTS (
          SELECT 1
          FROM activity_allocations snapshot_allocation
          JOIN activities snapshot_activity
            ON snapshot_activity.id = snapshot_allocation.activity_id
          WHERE snapshot_allocation.credential_id = credentials.id
            AND snapshot_activity.id =
              json_extract(snapshot.value, '$.id')
            AND snapshot_activity.user_id = credentials.user_id
            AND snapshot_activity.revision =
              CAST(json_extract(snapshot.value, '$.revision') AS INTEGER)
            AND snapshot_activity.archived_at IS NULL
      )
    )
  )`;
  const linkedActivitySnapshotBindings: readonly unknown[] = [
    linkedActivitySnapshotJson,
    linkedActivitySnapshotJson,
  ];
  const assertLinkedActivitySnapshotStillMatches = async () => {
    const current = await query(
      database,
      `SELECT DISTINCT
        activity.id,
        activity.revision
       FROM activity_allocations allocation
       JOIN activities activity ON activity.id = allocation.activity_id
       JOIN credentials linked_credential
         ON linked_credential.id = allocation.credential_id
       WHERE allocation.credential_id = ?
         AND activity.user_id = ?
         AND activity.archived_at IS NULL
         AND linked_credential.user_id = activity.user_id
       ORDER BY activity.id`,
      [credentialId, identity.userId],
    ).all<{ id: string; revision: number }>();
    const currentRows = current.results;
    const changed =
      currentRows.length !== linkedActivitySnapshotRows.length ||
      currentRows.some(
        (activity, index) =>
          activity.id !== linkedActivitySnapshotRows[index]?.id ||
          Number(activity.revision) !==
            linkedActivitySnapshotRows[index]?.revision,
      );
    if (changed) {
      throw new RequestError(
        "A linked learning record changed while acceptance was being recorded. Review the refreshed renewal and try again.",
        409,
        "acceptance_activity_state_changed",
      );
    }
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
  if (isManagedDentalRenewal) {
    await assertDentalCheckpointsComplete(
      database,
      identity,
      credentialId,
    );
  }
  await assertDentalDailyTotalsWithinLimit(
    database,
    identity,
    credentialId,
    credential.ruleSetId,
  );
  await assertDentalPerActivityClassificationsReady(
    database,
    identity,
    credentialId,
    credential.ruleSetId,
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
            AND owner.rule_set_id NOT LIKE 'crcc-%'
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
        AND (
          credentials.profession <> 'Dental'
          OR NOT EXISTS (
            SELECT 1
            FROM credential_requirements checkpoint_requirement
            LEFT JOIN dental_checkpoint_states checkpoint_state
              ON checkpoint_state.requirement_id =
                checkpoint_requirement.id
              AND checkpoint_state.credential_id = credentials.id
              AND checkpoint_state.user_id = credentials.user_id
            WHERE checkpoint_requirement.credential_id = credentials.id
              AND checkpoint_requirement.rule_category_id IN (
                ${DENTAL_CHECKPOINT_RULE_CATEGORY_IDS_SQL}
              )
              AND checkpoint_requirement.kind = 'informational'
              AND checkpoint_requirement.required_units = 0
              AND checkpoint_requirement.is_active = 1
              AND checkpoint_requirement.applicability_status = 'applies'
              AND COALESCE(checkpoint_state.status, 'pending') <>
                'completed'
          )
        )
        AND ${linkedActivitySnapshotCondition}
        ${
          nextCatalogSnapshotGuard
            ? `AND ${nextCatalogSnapshotGuard.sql}`
            : ""
        }
        AND NOT EXISTS (
          SELECT 1
          FROM activity_allocations allocation
          JOIN activities active_activity
            ON active_activity.id = allocation.activity_id
            AND active_activity.user_id = credentials.user_id
            AND active_activity.archived_at IS NULL
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
          JOIN activities active_activity
            ON active_activity.id = allocation.activity_id
            AND active_activity.user_id = credentials.user_id
            AND active_activity.archived_at IS NULL
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
            AND carryover_activity.archived_at IS NULL
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
        credentialId,
        identity.userId,
        submission.id,
        acceptedAt,
        ...linkedActivitySnapshotBindings,
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
            "Complete 38 general CE hours. Classify every general activity under the Principal Topics or Practice Management child category rather than tagging this parent directly. iTrack does not copy prior-cycle credit; manually record only CFP Board-confirmed eligible carryover and retain the confirmation.",
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
    const errorMessage = error instanceof Error ? error.message : "";
    if (errorMessage.includes("credential_evidence_busy")) {
      throw new RequestError(
        "Proof is being changed for an activity in this renewal. Wait for that change to finish, then try accepting the renewal again.",
        409,
        "evidence_change_in_progress",
      );
    }
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
    if (isManagedDentalRenewal) {
      await assertDentalCheckpointsComplete(
        database,
        identity,
        credentialId,
      );
    }
    await assertLinkedActivitySnapshotStillMatches();
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
    if (isManagedDentalRenewal) {
      await assertDentalCheckpointsComplete(
        database,
        identity,
        credentialId,
      );
    }
    await assertLinkedActivitySnapshotStillMatches();
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
    ruleCategoryId: string | null;
    requiredUnits: number;
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
        requirement.rule_category_id AS ruleCategoryId,
        requirement.required_units AS requiredUnits,
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
  const requirementByCategoryId = new Map(
    requirementResult.results.flatMap((requirement) =>
      requirement.ruleCategoryId
        ? [[requirement.ruleCategoryId, requirement] as const]
        : [],
    ),
  );
  for (const [requirementId, status] of [...normalizedChoices]) {
    const requirement = requirementsById.get(requirementId);
    const linkedCategoryIds = requirement?.ruleCategoryId
      ? DENTAL_LINKED_APPLICABILITY_CATEGORY_IDS.get(
          requirement.ruleCategoryId,
        )
      : undefined;
    if (!linkedCategoryIds) continue;
    for (const linkedCategoryId of linkedCategoryIds) {
      const linkedRequirement =
        requirementByCategoryId.get(linkedCategoryId);
      if (!linkedRequirement) continue;
      const linkedStatus = normalizedApplicabilityStatus(
        linkedRequirement.applicability,
        status,
        `status for ${linkedRequirement.name}`,
      );
      const explicitStatus = normalizedChoices.get(linkedRequirement.id);
      if (explicitStatus && explicitStatus !== linkedStatus) {
        throw new RequestError(
          "The Texas direct-patient-care pain-management aggregate and both annual requirements must use the same applicability choice.",
          409,
          "dental_linked_applicability_conflict",
        );
      }
      normalizedChoices.set(linkedRequirement.id, linkedStatus);
    }
  }
  const deactivatingRequirementIds = [...normalizedChoices]
    .filter(([, status]) => status !== "applies")
    .map(([requirementId]) => requirementId);
  const findAllocatedDeactivation = async () => {
    if (deactivatingRequirementIds.length === 0) return null;
    const placeholders = deactivatingRequirementIds
      .map(() => "?")
      .join(", ");
    return query(
      database,
      `SELECT requirement.id, requirement.name
       FROM credential_requirements requirement
       JOIN credentials credential
         ON credential.id = requirement.credential_id
       WHERE requirement.credential_id = ?
         AND credential.user_id = ?
         AND requirement.id IN (${placeholders})
         AND EXISTS (
           SELECT 1
           FROM activity_allocations allocation
           JOIN activities active_activity
             ON active_activity.id = allocation.activity_id
             AND active_activity.user_id = credential.user_id
             AND active_activity.archived_at IS NULL
           LEFT JOIN activity_requirement_matches match
             ON match.allocation_id = allocation.id
             AND match.user_id = credential.user_id
           WHERE allocation.credential_id = requirement.credential_id
             AND (
               allocation.requirement_id = requirement.id
               OR match.requirement_id = requirement.id
             )
         )
       LIMIT 1`,
      [
        credentialId,
        identity.userId,
        ...deactivatingRequirementIds,
      ],
    ).first<{ id: string; name: string }>();
  };
  const allocatedDeactivation = await findAllocatedDeactivation();
  if (allocatedDeactivation) {
    throw new RequestError(
      `${allocatedDeactivation.name} already has tagged credit. Reclassify or remove those activity allocations before marking this requirement inactive.`,
      409,
      "requirement_has_allocated_credit",
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
  assertMutuallyExclusivePharmacistConditions(
    [...requirementsById.values()].map((requirement) => ({
      ruleCategoryId: requirement.ruleCategoryId,
      applicabilityStatus: effectiveStatus(requirement.id),
    })),
  );
  const floridaNursingDomesticViolenceRequirement =
    [...requirementsById.values()].find(
      (requirement) =>
        requirement.ruleCategoryId !== null &&
        FLORIDA_NURSING_DOMESTIC_VIOLENCE_CATEGORY_IDS.has(
          requirement.ruleCategoryId,
        ),
    ) ?? null;
  const floridaNursingDomesticViolenceCategoryId =
    floridaNursingDomesticViolenceRequirement?.ruleCategoryId ?? null;
  const floridaNursingDomesticViolenceStatus =
    floridaNursingDomesticViolenceRequirement
      ? effectiveStatus(floridaNursingDomesticViolenceRequirement.id)
      : null;
  const floridaNursingDomesticViolenceUnits =
    floridaNursingDomesticViolenceRequirement &&
    floridaNursingDomesticViolenceStatus
      ? floridaNursingDomesticViolenceStatus === "applies"
        ? Number(floridaNursingDomesticViolenceRequirement.requiredUnits)
        : 0
      : null;
  const dentalAdditionalRequirement =
    [...requirementsById.values()].find(
      (requirement) =>
        requirement.ruleCategoryId !== null &&
        DENTAL_ADDITIONAL_CATEGORY_IDS.has(requirement.ruleCategoryId),
    ) ?? null;
  const dentalAdditionalCategoryId =
    dentalAdditionalRequirement?.ruleCategoryId ?? null;
  const dentalAdditionalStatus = dentalAdditionalRequirement
    ? effectiveStatus(dentalAdditionalRequirement.id)
    : null;
  const dentalAdditionalUnits =
    dentalAdditionalRequirement && dentalAdditionalStatus
      ? dentalAdditionalStatus === "applies"
        ? Number(dentalAdditionalRequirement.requiredUnits)
        : 0
      : null;

  const normalizedChoiceRows = [...normalizedChoices].map(
    ([requirementId, status]) => ({
      requirementId,
      status,
      isActive: status === "applies" ? 1 : 0,
    }),
  );
  const normalizedChoicesJson = JSON.stringify(normalizedChoiceRows);
  const deactivatingRequirementIdsJson = JSON.stringify(
    deactivatingRequirementIds,
  );
  const deactivationGuardSql =
    deactivatingRequirementIds.length === 0
      ? ""
      : `AND NOT EXISTS (
           SELECT 1
           FROM activity_allocations guarded_allocation
           JOIN activities guarded_activity
             ON guarded_activity.id = guarded_allocation.activity_id
             AND guarded_activity.user_id = ?
             AND guarded_activity.archived_at IS NULL
           LEFT JOIN activity_requirement_matches guarded_match
             ON guarded_match.allocation_id = guarded_allocation.id
             AND guarded_match.user_id = ?
           WHERE guarded_allocation.credential_id =
             credential_requirements.credential_id
             AND (
               guarded_allocation.requirement_id IN (
                 SELECT deactivating.value
                 FROM json_each(?) deactivating
               )
               OR guarded_match.requirement_id IN (
                 SELECT deactivating.value
                 FROM json_each(?) deactivating
               )
             )
         )`;
  const deactivationGuardBindings =
    deactivatingRequirementIds.length === 0
      ? []
      : [
          identity.userId,
          identity.userId,
          deactivatingRequirementIdsJson,
          deactivatingRequirementIdsJson,
        ];
  const statements: D1PreparedStatement[] = [
    query(
      database,
      `UPDATE credential_requirements
       SET
         applicability_status = (
           SELECT json_extract(choice.value, '$.status')
           FROM json_each(?) choice
           WHERE json_extract(choice.value, '$.requirementId') =
             credential_requirements.id
         ),
         is_active = (
           SELECT json_extract(choice.value, '$.isActive')
           FROM json_each(?) choice
           WHERE json_extract(choice.value, '$.requirementId') =
             credential_requirements.id
         )
       WHERE credential_id = ?
         AND id IN (
           SELECT json_extract(choice.value, '$.requirementId')
           FROM json_each(?) choice
         )
         AND EXISTS (
           SELECT 1
           FROM credentials credential
           WHERE credential.id = credential_requirements.credential_id
             AND credential.user_id = ?
             AND credential.status IN ('active', 'submitted')
         )
         AND (
           SELECT COUNT(*)
           FROM credential_requirements candidate
           WHERE candidate.credential_id = ?
             AND candidate.id IN (
               SELECT json_extract(choice.value, '$.requirementId')
               FROM json_each(?) choice
             )
         ) = json_array_length(?)
         ${deactivationGuardSql}`,
      [
        normalizedChoicesJson,
        normalizedChoicesJson,
        credentialId,
        normalizedChoicesJson,
        identity.userId,
        credentialId,
        normalizedChoicesJson,
        normalizedChoicesJson,
        ...deactivationGuardBindings,
      ],
    ),
  ];
  for (const [requirementId, status] of normalizedChoices) {
    if (status !== "needs_confirmation") {
      statements.push(
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
            AND credential.status IN ('active', 'submitted')
            AND requirement.applicability_status = ?
            AND requirement.is_active = ?
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(?) requested_choice
              WHERE NOT EXISTS (
                SELECT 1
                FROM credential_requirements applied_requirement
                WHERE applied_requirement.credential_id =
                    requirement.credential_id
                  AND applied_requirement.id =
                    json_extract(
                      requested_choice.value,
                      '$.requirementId'
                    )
                  AND applied_requirement.applicability_status =
                    json_extract(requested_choice.value, '$.status')
                  AND applied_requirement.is_active =
                    json_extract(requested_choice.value, '$.isActive')
              )
            )`,
          [
            crypto.randomUUID(),
            identity.userId,
            `${identity.userId}:requirement:${requirementId}:confirmed`,
            requirementId,
            requirementId,
            credentialId,
            identity.userId,
            status,
            status === "applies" ? 1 : 0,
            normalizedChoicesJson,
          ],
        ),
      );
    }
  }
  const applicabilityUpdateResultIndex = 0;
  let adjustedTotalResultIndex: number | null = null;
  if (
    floridaNursingDomesticViolenceUnits !== null &&
    floridaNursingDomesticViolenceRequirement &&
    floridaNursingDomesticViolenceCategoryId &&
    floridaNursingDomesticViolenceStatus
  ) {
    adjustedTotalResultIndex = statements.length;
    statements.push(
      query(
        database,
        `UPDATE credentials
         SET
           total_required = (
             SELECT catalog_rule.total_units + ?
             FROM rule_sets catalog_rule
             WHERE catalog_rule.id = credentials.rule_set_id
           ),
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND user_id = ?
           AND status IN ('active', 'submitted')
           AND EXISTS (
             SELECT 1
             FROM rule_sets catalog_rule
             WHERE catalog_rule.id = credentials.rule_set_id
               AND catalog_rule.profession = 'Nursing'
           )
           AND EXISTS (
             SELECT 1
             FROM credential_requirements requirement
             WHERE requirement.id = ?
               AND requirement.credential_id = credentials.id
               AND requirement.rule_category_id = ?
               AND requirement.applicability_status = ?
           )
           AND NOT EXISTS (
             SELECT 1
             FROM json_each(?) requested_choice
             WHERE NOT EXISTS (
               SELECT 1
               FROM credential_requirements applied_requirement
               WHERE applied_requirement.credential_id = credentials.id
                 AND applied_requirement.id =
                   json_extract(
                     requested_choice.value,
                     '$.requirementId'
                   )
                 AND applied_requirement.applicability_status =
                   json_extract(requested_choice.value, '$.status')
                 AND applied_requirement.is_active =
                   json_extract(requested_choice.value, '$.isActive')
             )
           )`,
        [
          floridaNursingDomesticViolenceUnits,
          credentialId,
          identity.userId,
          floridaNursingDomesticViolenceRequirement.id,
          floridaNursingDomesticViolenceCategoryId,
          floridaNursingDomesticViolenceStatus,
          normalizedChoicesJson,
        ],
      ),
    );
  }
  let dentalAdjustedTotalResultIndex: number | null = null;
  if (
    dentalAdditionalUnits !== null &&
    dentalAdditionalRequirement &&
    dentalAdditionalCategoryId &&
    dentalAdditionalStatus
  ) {
    dentalAdjustedTotalResultIndex = statements.length;
    statements.push(
      query(
        database,
        `UPDATE credentials
         SET
           total_required = (
             SELECT catalog_rule.total_units + ?
             FROM rule_sets catalog_rule
             WHERE catalog_rule.id = credentials.rule_set_id
           ),
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND user_id = ?
           AND status IN ('active', 'submitted')
           AND EXISTS (
             SELECT 1
             FROM rule_sets catalog_rule
             WHERE catalog_rule.id = credentials.rule_set_id
               AND catalog_rule.profession = 'Dental'
           )
           AND EXISTS (
             SELECT 1
             FROM credential_requirements requirement
             WHERE requirement.id = ?
               AND requirement.credential_id = credentials.id
               AND requirement.rule_category_id = ?
               AND requirement.applicability_status = ?
           )
           AND NOT EXISTS (
             SELECT 1
             FROM json_each(?) requested_choice
             WHERE NOT EXISTS (
               SELECT 1
               FROM credential_requirements applied_requirement
               WHERE applied_requirement.credential_id = credentials.id
                 AND applied_requirement.id =
                   json_extract(
                     requested_choice.value,
                     '$.requirementId'
                   )
                 AND applied_requirement.applicability_status =
                   json_extract(requested_choice.value, '$.status')
                 AND applied_requirement.is_active =
                   json_extract(requested_choice.value, '$.isActive')
             )
           )`,
        [
          dentalAdditionalUnits,
          credentialId,
          identity.userId,
          dentalAdditionalRequirement.id,
          dentalAdditionalCategoryId,
          dentalAdditionalStatus,
          normalizedChoicesJson,
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
      "This renewal cycle is closed and its requirements are frozen.",
      error,
    );
  }
  const applicabilityChangeCount = Number(
    results[applicabilityUpdateResultIndex]?.meta?.changes,
  );
  if (
    (Number.isFinite(applicabilityChangeCount) &&
      applicabilityChangeCount !== normalizedChoices.size) ||
    (adjustedTotalResultIndex !== null &&
      Number(results[adjustedTotalResultIndex]?.meta?.changes) === 0) ||
    (dentalAdjustedTotalResultIndex !== null &&
      Number(results[dentalAdjustedTotalResultIndex]?.meta?.changes) === 0)
  ) {
    const racedAllocatedDeactivation = await findAllocatedDeactivation();
    if (racedAllocatedDeactivation) {
      throw new RequestError(
        `${racedAllocatedDeactivation.name} received tagged credit while its status was changing. Reclassify or remove those allocations, then try again.`,
        409,
        "requirement_has_allocated_credit",
      );
    }
    await assertCredentialStillMutable(
      database,
      identity,
      credentialId,
      "This renewal cycle is closed and its requirements are frozen.",
    );
    throw new RequestError(
      "The requirement changed while its status was being updated. Refresh and try again.",
      409,
      "requirement_state_changed",
    );
  }
  return credentialId;
}

async function saveDentalCheckpoint(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const credentialId = textField(payload, "credentialId", {
    required: true,
    max: 160,
  })!;
  const requirementId = textField(payload, "requirementId", {
    required: true,
    max: 160,
  })!;
  const expectedRevision = expectedCheckpointRevisionField(payload);
  if (typeof payload.completed !== "boolean") {
    throw new RequestError("completed must be a boolean");
  }
  const completed = payload.completed;
  const evidenceNote = textField(payload, "evidenceNote", { max: 500 });
  if (completed && !evidenceNote) {
    throw new RequestError(
      "Add a concise certificate, portal, card, or assessment reference before completing this checkpoint.",
      409,
      "dental_checkpoint_evidence_required",
    );
  }

  const checkpointId = crypto.randomUUID();
  let result: D1Result;
  try {
    result = await query(
      database,
      `INSERT INTO dental_checkpoint_states (
        id, user_id, credential_id, requirement_id, status, completed_at,
        evidence_note, revision
      )
      SELECT
        ?, credential.user_id, credential.id, requirement.id, ?,
        CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END,
        ?, 1
      FROM credential_requirements requirement
      JOIN credentials credential
        ON credential.id = requirement.credential_id
      WHERE credential.id = ?
        AND credential.user_id = ?
        AND credential.status IN ('active', 'submitted')
        AND credential.profession = 'Dental'
        AND requirement.id = ?
        AND requirement.rule_category_id IN (
          ${DENTAL_CHECKPOINT_RULE_CATEGORY_IDS_SQL}
        )
        AND requirement.kind = 'informational'
        AND requirement.required_units = 0
        AND (
          ? = 'pending'
          OR (
            requirement.is_active = 1
            AND requirement.applicability_status = 'applies'
          )
        )
      ON CONFLICT(user_id, credential_id, requirement_id) DO UPDATE SET
        status = excluded.status,
        completed_at = CASE
          WHEN excluded.status = 'completed'
            THEN COALESCE(
              dental_checkpoint_states.completed_at,
              CURRENT_TIMESTAMP
            )
          ELSE NULL
        END,
        evidence_note = COALESCE(
          excluded.evidence_note,
          dental_checkpoint_states.evidence_note
        ),
        revision = dental_checkpoint_states.revision + 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE dental_checkpoint_states.revision = ?`,
      [
        checkpointId,
        completed ? "completed" : "pending",
        completed ? "completed" : "pending",
        evidenceNote,
        credentialId,
        identity.userId,
        requirementId,
        completed ? "completed" : "pending",
        expectedRevision,
      ],
    ).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("dental_checkpoint_not_mutable")) {
      return rethrowClosedCycleWrite(
        database,
        identity,
        credentialId,
        "This renewal cycle is closed and its dental checkpoints are frozen.",
        error,
      );
    }
    throw error;
  }
  if (Number(result.meta?.changes ?? Number.NaN) > 0) {
    return requirementId;
  }

  const current = await query(
    database,
    `SELECT
      credential.status AS credentialStatus,
      credential.profession,
      requirement.rule_category_id AS ruleCategoryId,
      requirement.kind,
      requirement.required_units AS requiredUnits,
      requirement.is_active AS isActive,
      requirement.applicability_status AS applicabilityStatus,
      checkpoint.revision
    FROM credential_requirements requirement
    JOIN credentials credential
      ON credential.id = requirement.credential_id
    LEFT JOIN dental_checkpoint_states checkpoint
      ON checkpoint.requirement_id = requirement.id
      AND checkpoint.credential_id = credential.id
      AND checkpoint.user_id = credential.user_id
    WHERE requirement.id = ?
      AND requirement.credential_id = ?
      AND credential.user_id = ?`,
    [requirementId, credentialId, identity.userId],
  ).first<{
    credentialStatus: string;
    profession: string;
    ruleCategoryId: string | null;
    kind: string;
    requiredUnits: number;
    isActive: number;
    applicabilityStatus: string;
    revision: number | null;
  }>();
  if (!current) {
    throw new RequestError(
      "Dental checkpoint not found for this credential.",
      404,
      "dental_checkpoint_not_found",
    );
  }
  if (!["active", "submitted"].includes(current.credentialStatus)) {
    throw new RequestError(
      "This renewal cycle is closed and its dental checkpoints are frozen.",
      409,
      "cycle_closed",
    );
  }
  if (
    current.profession !== "Dental" ||
    !current.ruleCategoryId ||
    !DENTAL_CHECKPOINT_RULE_CATEGORY_ID_SET.has(current.ruleCategoryId) ||
    current.kind !== "informational" ||
    Number(current.requiredUnits) !== 0
  ) {
    throw new RequestError(
      "This requirement is not a dental completion checkpoint.",
      409,
      "not_dental_checkpoint",
    );
  }
  if (
    completed &&
    (!Boolean(current.isActive) ||
      current.applicabilityStatus !== "applies")
  ) {
    throw new RequestError(
      "Confirm that this checkpoint applies to the current cycle before completing it.",
      409,
      "dental_checkpoint_not_applicable",
    );
  }
  if (Number(current.revision ?? 0) !== expectedRevision) {
    throw new RequestError(
      "This dental checkpoint changed in another session. Refresh and try again.",
      409,
      "dental_checkpoint_state_changed",
    );
  }
  throw new RequestError(
    "The dental checkpoint could not be saved. Refresh and try again.",
    409,
    "dental_checkpoint_state_changed",
  );
}

async function updateWeeklyGoal(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const weeklyGoal = payload.weeklyGoal;
  if (
    typeof weeklyGoal !== "number" ||
    !Number.isInteger(weeklyGoal) ||
    !WEEKLY_GOAL_PRESETS.has(weeklyGoal)
  ) {
    throw new RequestError(
      "weeklyGoal must be one of 1, 3, 4, 5, or 7",
      400,
      "invalid_weekly_goal",
    );
  }

  await getOrCreateCurrentProgressionPeriod(database, identity);
  await query(
    database,
    `UPDATE profiles
     SET weekly_goal = ?, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ?`,
    [weeklyGoal, identity.userId],
  ).run();
  return "weekly-goal";
}

const MAX_PUSH_DEVICES = 8;

type ValidPushSubscription = {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

function base64UrlBytes(value: string, field: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new RequestError(`${field} must use base64url encoding`);
  }
  try {
    const base64 = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new RequestError(`${field} must use valid base64url encoding`);
  }
}

function validPushEndpoint(value: unknown) {
  if (typeof value !== "string") {
    throw new RequestError("subscription.endpoint must be a string");
  }
  const endpoint = value.trim();
  if (!endpoint || endpoint.length > 4096) {
    throw new RequestError(
      "subscription.endpoint must be between 1 and 4096 characters",
    );
  }
  try {
    return validateBrowserPushEndpoint(endpoint).href;
  } catch {
    throw new RequestError(
      "subscription.endpoint must be a supported browser push-service URL",
      400,
      "invalid_push_endpoint",
    );
  }
}

function validPushSubscription(payload: JsonRecord): ValidPushSubscription {
  if (!isRecord(payload.subscription)) {
    throw new RequestError("subscription must be an object");
  }
  const subscription = payload.subscription;
  if (!isRecord(subscription.keys)) {
    throw new RequestError("subscription.keys must be an object");
  }
  const p256dh = textField(subscription.keys, "p256dh", {
    required: true,
    max: 180,
  })!;
  const auth = textField(subscription.keys, "auth", {
    required: true,
    max: 120,
  })!;
  const p256dhBytes = base64UrlBytes(p256dh, "subscription.keys.p256dh");
  const authBytes = base64UrlBytes(auth, "subscription.keys.auth");
  if (p256dhBytes.length !== 65 || p256dhBytes[0] !== 4) {
    throw new RequestError(
      "subscription.keys.p256dh must be an uncompressed P-256 public key",
    );
  }
  if (authBytes.length !== 16) {
    throw new RequestError(
      "subscription.keys.auth must decode to 16 bytes",
    );
  }
  const expirationValue = subscription.expirationTime;
  const expirationTime =
    expirationValue === null || expirationValue === undefined
      ? null
      : expirationValue;
  if (
    expirationTime !== null &&
    (typeof expirationTime !== "number" ||
      !Number.isSafeInteger(expirationTime) ||
      expirationTime <= Date.now())
  ) {
    throw new RequestError(
      "subscription.expirationTime must be null or a future timestamp",
    );
  }
  return {
    endpoint: validPushEndpoint(subscription.endpoint),
    expirationTime,
    keys: { p256dh, auth },
  };
}

async function savePushSubscription(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  if (typeof payload.enableAccountPush !== "boolean") {
    throw new RequestError("enableAccountPush must be a boolean");
  }
  const subscription = validPushSubscription(payload);
  const deviceLabel = textField(payload, "deviceLabel", { max: 80 });
  const existing = await query(
    database,
    `SELECT id, user_id AS userId
     FROM push_subscriptions
     WHERE endpoint = ?`,
    [subscription.endpoint],
  ).first<{ id: string; userId: string }>();
  if (existing && existing.userId !== identity.userId) {
    throw new RequestError(
      "This browser subscription belongs to another account.",
      409,
      "push_subscription_conflict",
    );
  }
  const subscriptionId = existing?.id ?? crypto.randomUUID();
  const now = Date.now();
  const saveStatement = query(
    database,
    `INSERT INTO push_subscriptions (
      id, user_id, endpoint, p256dh, auth, expiration_time, device_label
    )
    SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE (
      EXISTS (
        SELECT 1
        FROM push_subscriptions
        WHERE endpoint = ?
          AND user_id = ?
          AND disabled_at IS NULL
          AND (
            expiration_time IS NULL
            OR expiration_time > ?
          )
      )
      OR (
        SELECT COUNT(*)
        FROM push_subscriptions
        WHERE user_id = ?
          AND disabled_at IS NULL
          AND (
            expiration_time IS NULL
            OR expiration_time > ?
          )
      ) < ?
    )
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      expiration_time = excluded.expiration_time,
      device_label = excluded.device_label,
      failure_count = 0,
      last_seen_at = CURRENT_TIMESTAMP,
      disabled_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE push_subscriptions.user_id = excluded.user_id`,
    [
      subscriptionId,
      identity.userId,
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      subscription.expirationTime,
      deviceLabel,
      subscription.endpoint,
      identity.userId,
      now,
      identity.userId,
      now,
      MAX_PUSH_DEVICES,
    ],
  );
  const statements = [saveStatement];
  if (payload.enableAccountPush) {
    statements.push(
      query(
        database,
        `UPDATE reminder_preferences
         SET push_enabled = 1, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?
           AND EXISTS (
             SELECT 1
             FROM push_subscriptions
             WHERE endpoint = ?
               AND user_id = ?
               AND disabled_at IS NULL
               AND (
                 expiration_time IS NULL
                 OR expiration_time > ?
               )
           )`,
        [
          identity.userId,
          subscription.endpoint,
          identity.userId,
          now,
        ],
      ),
    );
  }
  const [saved] = await database.batch(statements);
  if (Number(saved.meta?.changes ?? 0) === 0) {
    const currentOwner = await query(
      database,
      `SELECT user_id AS userId
       FROM push_subscriptions
       WHERE endpoint = ?`,
      [subscription.endpoint],
    ).first<{ userId: string }>();
    if (currentOwner && currentOwner.userId !== identity.userId) {
      throw new RequestError(
        "This browser subscription belongs to another account.",
        409,
        "push_subscription_conflict",
      );
    }
    throw new RequestError(
      `iTrack supports up to ${MAX_PUSH_DEVICES} active alert devices.`,
      409,
      "push_device_limit",
    );
  }
  return subscriptionId;
}

async function removePushSubscription(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const endpoint = validPushEndpoint(payload.endpoint);
  const existing = await query(
    database,
    `SELECT id
     FROM push_subscriptions
     WHERE endpoint = ? AND user_id = ?`,
    [endpoint, identity.userId],
  ).first<{ id: string }>();
  if (!existing) return "push-subscription";

  await database.batch([
    query(
      database,
      `UPDATE push_subscriptions
       SET disabled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [existing.id, identity.userId],
    ),
    query(
      database,
      `UPDATE push_delivery_ledger
       SET status = 'cancelled',
           error_code = 'subscription_removed',
           next_attempt_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE subscription_id = ?
         AND user_id = ?
         AND status IN ('pending', 'retry', 'sending')`,
      [existing.id, identity.userId],
    ),
    query(
      database,
      `UPDATE reminder_preferences
       SET push_enabled = 0, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?
         AND NOT EXISTS (
           SELECT 1
           FROM push_subscriptions
           WHERE user_id = ?
             AND disabled_at IS NULL
             AND (
               expiration_time IS NULL
               OR expiration_time > ?
             )
         )`,
      [identity.userId, identity.userId, Date.now()],
    ),
  ]);
  return existing.id;
}

function runtimeWebPushConfig() {
  const publicKey =
    typeof env.VAPID_PUBLIC_KEY === "string"
      ? env.VAPID_PUBLIC_KEY.trim()
      : "";
  const privateKey =
    typeof env.VAPID_PRIVATE_KEY === "string"
      ? env.VAPID_PRIVATE_KEY.trim()
      : "";
  const subject =
    typeof env.VAPID_SUBJECT === "string" ? env.VAPID_SUBJECT.trim() : "";
  if (!publicKey || !privateKey || !subject) {
    throw new RequestError(
      "Phone-alert delivery is not configured yet.",
      503,
      "push_not_configured",
    );
  }
  return { publicKey, privateKey, subject };
}

async function sendTestPush(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  const endpoint = validPushEndpoint(payload.endpoint);
  const subscription = await query(
    database,
    `SELECT
       id,
       endpoint,
       p256dh,
       auth,
       expiration_time AS expirationTime,
       last_test_at AS lastTestAt
     FROM push_subscriptions
     WHERE endpoint = ?
       AND user_id = ?
       AND disabled_at IS NULL
       AND (
         expiration_time IS NULL
         OR expiration_time > ?
       )`,
    [endpoint, identity.userId, Date.now()],
  ).first<{
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    expirationTime: number | null;
    lastTestAt: string | null;
  }>();
  if (!subscription) {
    throw new RequestError(
      "This device is not connected for phone alerts.",
      404,
      "push_subscription_not_found",
    );
  }

  const now = new Date();
  const sqlTime = (date: Date) =>
    date.toISOString().slice(0, 19).replace("T", " ");
  const claimed = await query(
    database,
    `UPDATE push_subscriptions
     SET last_test_at = CURRENT_TIMESTAMP,
         last_seen_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND user_id = ?
       AND (
         last_test_at IS NULL
         OR last_test_at <= ?
       )`,
    [
      subscription.id,
      identity.userId,
      sqlTime(new Date(now.getTime() - 60_000)),
    ],
  ).run();
  if (Number(claimed.meta?.changes ?? 0) === 0) {
    throw new RequestError(
      "Wait a minute before sending another test alert.",
      429,
      "push_test_rate_limited",
    );
  }

  let response: Response;
  try {
    response = await sendWebPush(
      {
        endpoint: subscription.endpoint,
        expirationTime: subscription.expirationTime,
        keys: {
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        },
      },
      runtimeWebPushConfig(),
      {
        title: "iTrack check-in",
        body: "Your private test alert is working.",
        tag: `ll-test-${subscription.id
          .replace(/[^A-Za-z0-9_-]/g, "")
          .slice(0, 80)}`,
        url: "/",
      },
    );
  } catch {
    await query(
      database,
      `UPDATE push_subscriptions
       SET failure_count = failure_count + 1,
           last_failure_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [subscription.id, identity.userId],
    ).run();
    throw new RequestError(
      "The test alert could not reach the push service. Try again shortly.",
      502,
      "push_test_failed",
    );
  }

  if (response.ok) {
    await query(
      database,
      `UPDATE push_subscriptions
       SET failure_count = 0,
           last_success_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
      [subscription.id, identity.userId],
    ).run();
    return subscription.id;
  }
  if (response.status === 404 || response.status === 410) {
    await removePushSubscription(database, identity, { endpoint });
    throw new RequestError(
      "This device’s alert connection expired. Turn phone alerts on again.",
      410,
      "push_subscription_expired",
    );
  }
  await query(
    database,
    `UPDATE push_subscriptions
     SET failure_count = failure_count + 1,
         last_failure_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`,
    [subscription.id, identity.userId],
  ).run();
  throw new RequestError(
    "The push service did not accept the test alert. Try again shortly.",
    502,
    "push_test_failed",
  );
}

async function updateReminderPreferences(
  database: D1Database,
  identity: RequestIdentity,
  payload: JsonRecord,
) {
  if (typeof payload.inAppEnabled !== "boolean") {
    throw new RequestError("inAppEnabled must be a boolean");
  }
  if (typeof payload.pushEnabled !== "boolean") {
    throw new RequestError("pushEnabled must be a boolean");
  }
  if (
    typeof payload.pushHourLocal !== "number" ||
    !Number.isInteger(payload.pushHourLocal) ||
    payload.pushHourLocal < 0 ||
    payload.pushHourLocal > 23
  ) {
    throw new RequestError(
      "pushHourLocal must be a whole hour from 0 through 23",
      400,
      "invalid_push_hour",
    );
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
  if (payload.pushEnabled) {
    const activeSubscription = await query(
      database,
      `SELECT id
       FROM push_subscriptions
       WHERE user_id = ?
         AND disabled_at IS NULL
         AND (
           expiration_time IS NULL
           OR expiration_time > ?
         )
       LIMIT 1`,
      [identity.userId, Date.now()],
    ).first<{ id: string }>();
    if (!activeSubscription) {
      throw new RequestError(
        "Turn on phone alerts on at least one device before enabling push reminders.",
        409,
        "push_subscription_required",
      );
    }
  }

  await query(
    database,
    `INSERT INTO reminder_preferences (
      user_id, in_app_enabled, push_enabled, push_hour_local,
      lead_days, time_zone
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      in_app_enabled = excluded.in_app_enabled,
      push_enabled = excluded.push_enabled,
      push_hour_local = excluded.push_hour_local,
      lead_days = excluded.lead_days,
      time_zone = excluded.time_zone,
      updated_at = CURRENT_TIMESTAMP`,
    [
      identity.userId,
      payload.inAppEnabled ? 1 : 0,
      payload.pushEnabled ? 1 : 0,
      payload.pushHourLocal,
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
         AND task.archived_at IS NULL
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

async function resolvePushDelivery(
  database: D1Database,
  identity: RequestIdentity,
  value: string | null,
) {
  const unavailable = () =>
    new RequestError(
      "That check-in is no longer available.",
      404,
      "push_delivery_not_found",
    );
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  ) {
    throw unavailable();
  }
  const delivery = await query(
    database,
    `SELECT
       reminder_key AS reminderKey,
       scheduled_for AS scheduledFor
     FROM push_delivery_ledger
     WHERE id = ?
       AND user_id = ?
       AND dispatched_at IS NOT NULL`,
    [value, identity.userId],
  ).first<{ reminderKey: string; scheduledFor: string }>();
  if (!delivery) throw unavailable();

  const reminderData = await loadReminderData(database, identity.userId, {
    channel: "resolve",
  });
  const reminder = reminderData.reminders.find(
    (candidate) =>
      candidate.key === delivery.reminderKey &&
      candidate.scheduledFor === delivery.scheduledFor,
  );
  if (!reminder) throw unavailable();
  return {
    credentialId: reminder.credentialId,
    reminderKey: reminder.key,
  };
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
    const url = new URL(request.url);
    if (url.searchParams.has("delivery")) {
      if (
        url.searchParams.getAll("delivery").length !== 1 ||
        [...url.searchParams.keys()].some((key) => key !== "delivery")
      ) {
        throw new RequestError(
          "That check-in is no longer available.",
          404,
          "push_delivery_not_found",
        );
      }
      return json({
        target: await resolvePushDelivery(
          database,
          identity,
          url.searchParams.get("delivery"),
        ),
      });
    }
    return json(await getWorkspace(database, identity));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      throw new RequestError(
        "Request body must use application/json.",
        415,
        "invalid_content_type",
      );
    }
    const requestOrigin = new URL(request.url).origin;
    const suppliedOrigin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    if (
      (suppliedOrigin && suppliedOrigin !== requestOrigin) ||
      (fetchSite && fetchSite !== "same-origin")
    ) {
      throw new RequestError(
        "Cross-origin workspace updates are not allowed.",
        403,
        "cross_origin_request",
      );
    }
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
      case "updateActivity":
        id = await updateActivity(database, identity, body.payload);
        break;
      case "archiveActivity":
        id = await archiveActivity(database, identity, body.payload);
        break;
      case "restoreActivity":
        id = await restoreActivity(database, identity, body.payload);
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
      case "createPersonalTask":
        id = await createPersonalTask(database, identity, body.payload);
        break;
      case "updatePersonalTask":
        id = await updatePersonalTask(database, identity, body.payload);
        break;
      case "archivePersonalTask":
        id = await archivePersonalTask(database, identity, body.payload);
        break;
      case "restorePersonalTask":
        id = await restorePersonalTask(database, identity, body.payload);
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
      case "saveDentalCheckpoint":
        id = await saveDentalCheckpoint(
          database,
          identity,
          body.payload,
        );
        break;
      case "updateWeeklyGoal":
        id = await updateWeeklyGoal(database, identity, body.payload);
        break;
      case "updateReminderPreferences":
        id = await updateReminderPreferences(
          database,
          identity,
          body.payload,
        );
        break;
      case "savePushSubscription":
        id = await savePushSubscription(database, identity, body.payload);
        break;
      case "removePushSubscription":
        id = await removePushSubscription(database, identity, body.payload);
        break;
      case "sendTestPush":
        id = await sendTestPush(database, identity, body.payload);
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
  if (message.includes("dental_daily_unit_limit_exceeded")) {
    return json(
      {
        error:
          "California permits no more than eight countable CE units on one completion date. Another entry changed that day while this record was saving; review the day and reduce the countable allocation.",
        code: "dental_daily_unit_limit_exceeded",
      },
      { status: 409 },
    );
  }
  console.error(
    "CEU workspace API error",
    error instanceof Error ? (error.stack ?? message) : message,
  );
  return json(
    {
      error: "The CEU workspace could not be loaded. Please try again.",
      code: "internal_error",
    },
    { status: 500 },
  );
}
