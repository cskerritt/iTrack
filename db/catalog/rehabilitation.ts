type RuleSetSeedBinding = readonly [
  id: string,
  stableKey: string,
  version: number,
  profession: string,
  credentialName: string,
  jurisdiction: string,
  issuer: string,
  totalUnits: number,
  unitLabel: string,
  cycleMonths: number,
  sourceUrl: string,
  sourceTitle: string,
  effectiveDate: string | null,
  lastVerifiedAt: string,
  reviewStatus: "source_linked_check_conditions",
  isCurrent: 1,
];

type CategorySeedBinding = readonly [
  id: string,
  ruleSetId: string,
  name: string,
  requiredUnits: number,
  kind: "minimum" | "maximum" | "informational",
  relation: "independent" | "overlapping",
  parentCategoryId: null,
  applicability: "always",
  conditionNote: string,
  exclusiveGroup: string | null,
  sortOrder: number,
];

type RenewalTaskCopyBinding = readonly [
  ruleSetId: string,
  review: string,
  progress: string,
  submission: string,
];

const LAST_VERIFIED_AT = "2026-07-26";
const CRCC_RENEWAL_GUIDE_URL =
  "https://crccertification.com/wp-content/uploads/2020/10/CRCRenewalCriteria.pdf";
const ABVE_EVENTS_URL = "https://www.abve.net/conferences-and-events";
const ABVE_JOIN_URL = "https://www.abve.net/join";
const CRCC_CREDIT_TYPE_GROUP = "CRCC CRC credit type";

const CRCC_SOURCE_NOTE =
  `CRCC Certification Renewal Guide (revised July 1, 2026): renew the CRC every five years with 100 CRCC-approved clock hours completed inside the holder's current certification period, including at least 10 ethics hours. No more than 50 hours may be Professional Development, the same program may be submitted only once, and excess hours do not carry to the next cycle. Use the valid-through date and accepted totals shown in CRCCCONNECT; the renewal application generally opens about four months before that date. Pre-approved activities use the CRCC approval number from the completion record. Post-approved activities require supporting documentation and a review fee, and an unpaid post-approval submission is deleted after seven days. Optional 30-day and 12-month extensions must be requested and paid for before expiration and are not assumed by this template. Current guide: ${CRCC_RENEWAL_GUIDE_URL}. This template is for the plain CRC; it does not add CRC-MAC or CRC-CS conditions. The current guide does not publish a certificant record-retention term, and older materials conflict on an exam-renewal alternative, so confirm either point directly with CRCC rather than inferring it here.`;

const ABVE_COMPETENCIES =
  "forensic testimony and related law; standardized vocational testing and work samples; statistics; research methodology and forensic applications; standardized psychological and neuropsychological testing; vocational theory and forensic applications; job surveys and placement; seminal vocational texts; ABVE standards, ethics, and professional conduct; transferable skills analysis; physical capacity, functionality, and work applications; O*NET applications; life care planning; pain measurement, management, work implications, and treatment; occupational density; and earning capacity";

function abveSourceNote(credential: "Fellow" | "Diplomate") {
  return `ABVE certification-maintenance guidance for the fixed January 1, 2025 through December 31, 2027 recertification cycle: the ${credential} credential requires 42 ABVE-approved CEUs. Keep annual membership and the ${credential} credential renewal current by December 31 each year and reaffirm allegiance to the ABVE Code of Ethics during membership renewal. Record the ABVE-awarded CEU value shown on the approval or completion record rather than automatically converting attendance hours; ABVE can award values that differ from clock hours. Pre-approved education requires the applicable CEU form and attendance or completion verification. Non-pre-approved education requires one Alternative CEU application per event plus verification and materials showing forensic applicability; ABVE advises allowing six to eight weeks for review. Submission guidance: ${ABVE_EVENTS_URL}. Membership guidance: ${ABVE_JOIN_URL}. Accepted core forensic competency areas include ${ABVE_COMPETENCIES}. ABVE publishes no separate ethics minimum, carryover allowance, mid-cycle proration rule, grace period, or individual record-retention term in its current public guidance, so confirm those points directly. Active Emeritus and IPEC are separate variants and are not covered by this ${credential} template. The 2025 application says annual fees are due January 1 while the current maintenance page says December 31; follow the current ABVE account instructions.`;
}

export const REHABILITATION_RULE_SET_SEED_BINDINGS = [
  [
    "crcc-crc-2026-v1",
    "crcc-crc",
    1,
    "Vocational Rehabilitation",
    "Certified Rehabilitation Counselor (CRC) — standard five-year renewal",
    "United States",
    "Commission on Rehabilitation Counselor Certification",
    100,
    "CRCC-approved clock hours",
    60,
    "https://crccertification.com/stay-certified/crc/",
    CRCC_SOURCE_NOTE,
    null,
    LAST_VERIFIED_AT,
    "source_linked_check_conditions",
    1,
  ],
  [
    "abve-fellow-2025-v1",
    "abve-fellow",
    1,
    "Vocational Rehabilitation",
    "Fellow of the American Board of Vocational Experts (ABVE/F) — 2025–2027 recertification",
    "United States",
    "American Board of Vocational Experts",
    42,
    "ABVE-approved CEUs",
    36,
    "https://www.abve.net/certification-main",
    abveSourceNote("Fellow"),
    "2025-01-01",
    LAST_VERIFIED_AT,
    "source_linked_check_conditions",
    1,
  ],
  [
    "abve-diplomate-2025-v1",
    "abve-diplomate",
    1,
    "Vocational Rehabilitation",
    "Diplomate of the American Board of Vocational Experts (ABVE/D) — 2025–2027 recertification",
    "United States",
    "American Board of Vocational Experts",
    42,
    "ABVE-approved CEUs",
    36,
    "https://www.abve.net/certification-main",
    abveSourceNote("Diplomate"),
    "2025-01-01",
    LAST_VERIFIED_AT,
    "source_linked_check_conditions",
    1,
  ],
] as const satisfies readonly RuleSetSeedBinding[];

export const REHABILITATION_CATEGORY_SEED_BINDINGS = [
  [
    "crcc-crc-2026-general",
    "crcc-crc-2026-v1",
    "General / Other Accepted CRC Credit",
    0,
    "informational",
    "independent",
    null,
    "always",
    "Choose this activity type for CRCC-approved General, Ethics, Addiction Counseling, or Clinical Supervision credit that is not claimed as Professional Development. Select the Ethics overlap too when the completion record supports ethics credit.",
    CRCC_CREDIT_TYPE_GROUP,
    0,
  ],
  [
    "crcc-crc-2026-professional-development",
    "crcc-crc-2026-v1",
    "Professional Development",
    50,
    "maximum",
    "independent",
    null,
    "always",
    "No more than 50 of the 100 countable hours may be CRCC-approved Professional Development. Classify every activity as this type or General / Other Accepted CRC Credit so the cap can be enforced.",
    CRCC_CREDIT_TYPE_GROUP,
    1,
  ],
  [
    "crcc-crc-2026-ethics",
    "crcc-crc-2026-v1",
    "Ethics",
    10,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least 10 of the 100 hours must be ethics. Enter only the ethics portion awarded on the completion record or supported by the program materials; it overlaps General / Other Accepted CRC Credit and does not increase the activity's total hours.",
    null,
    2,
  ],
  [
    "abve-fellow-2025-core-competency",
    "abve-fellow-2025-v1",
    "ABVE-Approved Core Forensic Competency",
    0,
    "informational",
    "independent",
    null,
    "always",
    `Optional classification tag for an activity whose awarded CEUs ABVE has accepted in one or more core forensic competency areas: ${ABVE_COMPETENCIES}. This is not a separate minimum and does not imply that every competency area must be covered.`,
    null,
    0,
  ],
  [
    "abve-diplomate-2025-core-competency",
    "abve-diplomate-2025-v1",
    "ABVE-Approved Core Forensic Competency",
    0,
    "informational",
    "independent",
    null,
    "always",
    `Optional classification tag for an activity whose awarded CEUs ABVE has accepted in one or more core forensic competency areas: ${ABVE_COMPETENCIES}. This is not a separate minimum and does not imply that every competency area must be covered.`,
    null,
    0,
  ],
] as const satisfies readonly CategorySeedBinding[];

export const REHABILITATION_MAXIMUM_CLASSIFICATION_RULE_SET_IDS = [
  "crcc-crc-2026-v1",
] as const;

const ABVE_FELLOW_TASK_COPY = [
  "Confirm the fixed 2025–2027 ABVE cycle, Fellow status, current annual dues, and ethics reaffirmation",
  "Submit any alternative-credit requests at least eight weeks before cycle end, record 42 ABVE-approved CEUs at the awarded values, and retain approval evidence",
  "Confirm all 42 accepted CEUs are on file by December 31, 2027 and save ABVE Fellow recertification proof",
] as const;

const ABVE_DIPLOMATE_TASK_COPY = [
  "Confirm the fixed 2025–2027 ABVE cycle, Diplomate status, current annual dues, and ethics reaffirmation",
  "Submit any alternative-credit requests at least eight weeks before cycle end, record 42 ABVE-approved CEUs at the awarded values, and retain approval evidence",
  "Confirm all 42 accepted CEUs are on file by December 31, 2027 and save ABVE Diplomate recertification proof",
] as const;

export const REHABILITATION_RENEWAL_TASK_COPY_BINDINGS = [
  [
    "crcc-crc-2026-v1",
    "Confirm CRCCCONNECT dates, profile information, five-year window, and pre- or post-approved CE status",
    "Report 100 approved clock hours, including at least 10 ethics and no more than 50 Professional Development hours",
    "Complete the CRC attestations and disclosures, submit payment, and save CRCCCONNECT renewal confirmation",
  ],
  [
    "abve-fellow-2025-v1",
    ...ABVE_FELLOW_TASK_COPY,
  ],
  [
    "abve-diplomate-2025-v1",
    ...ABVE_DIPLOMATE_TASK_COPY,
  ],
] as const satisfies readonly RenewalTaskCopyBinding[];
