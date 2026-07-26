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
  kind: "minimum",
  relation: "independent" | "nested" | "overlapping",
  parentCategoryId: string | null,
  applicability: "always",
  conditionNote: string,
  exclusiveGroup: string | null,
  sortOrder: number,
];

const NCCP_2025_MODEL_URL =
  "https://public.powerdms.com/Nat9346/documents/2703086";
const IMPORTANT_DATES_URL =
  "https://www.nremt.org/Handbooks/Recertification/Important-Dates-Time-Periods";
const RBE_URL =
  "https://www.nremt.org/Handbooks/Recertification/Recertification-by-Examination-%28RBE%29";
const DISTRIBUTIVE_EDUCATION_URL =
  "https://www.nremt.org/News/National-Registry-Board-Makes-Distributive-Educati";
const LAST_VERIFIED_AT = "2026-07-26";

function standardSourceNote({
  level,
  total,
  national,
  local,
  individual,
  expirationDate,
  reinstatementWindow,
  lapseDate,
  rbeApplicationDeadline,
  transitionDate,
  activeVerifier,
  additionalNote = "",
}: {
  level: string;
  total: number;
  national: number;
  local: number;
  individual: number;
  expirationDate: string;
  reinstatementWindow: string;
  lapseDate: string;
  rbeApplicationDeadline: string;
  transitionDate: string;
  activeVerifier: "Training Officer" | "Medical Director";
  additionalNote?: string;
}) {
  return `National Registry ${level} continuing-education path under the 2025 NCCP model: ${total} total credits, classified once as ${national} National, ${local} Local/State, and ${individual} Individual credits. Official model: ${NCCP_2025_MODEL_URL}. The 2025 model applies to cycles assigned under the transition beginning ${transitionDate}; use the exact model, cycle start, and expiration displayed in the National Registry account. This template records a nominal 24-month cycle, but an initial certification can receive a two- or three-year future expiration, and an early continuing-education approval starts the next rolling cycle the following day without moving the fixed expiration. Credits must be completed inside the assigned cycle and by ${expirationDate}. If all education was completed by that date but the application was not submitted, the current late reinstatement window is ${reinstatementWindow}; education dated during reinstatement is not accepted, acceptance is not guaranteed, and certification lapses ${lapseDate}. Recertification by Examination is a separate one-attempt alternative, not an education category: apply by ${rbeApplicationDeadline}, pass by ${expirationDate}, and do not apply a reinstatement window to RBE. Official deadlines: ${IMPORTANT_DATES_URL}. Official RBE guide: ${RBE_URL}. There is no cross-cycle credit carryover; early rolling approval merely opens the new cycle for education completed afterward. Use education directly related to EMS patient care, at or above this certification level, and approved by a U.S. state EMS office or Delegated Authorization Authority, accredited by CAPCE, or otherwise accepted under the National Registry's published Accepted Education, Academic Courses, or Alternative Recertification policies. Academic courses cannot satisfy the National Component. Standardized courses are subject to the National Registry's published course-credit maximums; record only the post-cap credit shown or accepted in the National Registry dashboard, not uncapped provider contact hours. Online/distributive education has no National Registry percentage cap when otherwise accepted; official removal: ${DISTRIBUTIVE_EDUCATION_URL}. Retain accepted course documentation for five years. Active status requires skills verification by the ${activeVerifier}; inactive status does not reduce the continuing-education or RBE requirements. This national-certification template does not infer compliance with any state EMS license. State expiration dates, mandatory Local topics, skills, BLS/CPR or ACLS conditions, reporting, and renewal rules must be tracked separately from official state and agency requirements.${additionalNote}`;
}

export const NREMT_RULE_SET_SEED_BINDINGS = [
  [
    "nremt-emr-nccp-ce-2025-v1",
    "nremt-emr-nccp-ce",
    1,
    "Emergency Medical Services",
    "Emergency Medical Responder (NREMR) — NCCP continuing-education path",
    "United States",
    "National Registry of Emergency Medical Technicians",
    16,
    "NREMT-accepted CE credits",
    24,
    "https://www.nremt.org/EMR/Recertification",
    standardSourceNote({
      level: "Emergency Medical Responder",
      total: 16,
      national: 8,
      local: 4,
      individual: 4,
      expirationDate: "September 30",
      reinstatementWindow: "October 1 through October 31",
      lapseDate: "November 1",
      rbeApplicationDeadline: "September 24",
      transitionDate: "October 1, 2025",
      activeVerifier: "Training Officer",
      additionalNote:
        " The current Important Dates page appears to contain an editorial error that labels September 30 itself as reinstatement; the level page and National Registry FAQ consistently identify September 30 as the normal deadline and October 1-31 as reinstatement, which is the cautious interpretation used here.",
    }),
    "2025-10-01",
    LAST_VERIFIED_AT,
    "source_linked_check_conditions",
    1,
  ],
  [
    "nremt-emt-nccp-ce-2025-v1",
    "nremt-emt-nccp-ce",
    1,
    "Emergency Medical Services",
    "Emergency Medical Technician (NREMT) — NCCP continuing-education path",
    "United States",
    "National Registry of Emergency Medical Technicians",
    40,
    "NREMT-accepted CE credits",
    24,
    "https://www.nremt.org/EMT/Recertification",
    standardSourceNote({
      level: "Emergency Medical Technician",
      total: 40,
      national: 20,
      local: 10,
      individual: 10,
      expirationDate: "March 31",
      reinstatementWindow: "April 1 through April 30",
      lapseDate: "May 1",
      rbeApplicationDeadline: "March 25",
      transitionDate: "April 1, 2025",
      activeVerifier: "Training Officer",
    }),
    "2025-04-01",
    LAST_VERIFIED_AT,
    "source_linked_check_conditions",
    1,
  ],
  [
    "nremt-aemt-nccp-ce-2025-v1",
    "nremt-aemt-nccp-ce",
    1,
    "Emergency Medical Services",
    "Advanced Emergency Medical Technician (NRAEMT) — NCCP continuing-education path",
    "United States",
    "National Registry of Emergency Medical Technicians",
    50,
    "NREMT-accepted CE credits",
    24,
    "https://www.nremt.org/AEMT/Recertification",
    standardSourceNote({
      level: "Advanced Emergency Medical Technician",
      total: 50,
      national: 25,
      local: 12.5,
      individual: 12.5,
      expirationDate: "March 31",
      reinstatementWindow: "April 1 through April 30",
      lapseDate: "May 1",
      rbeApplicationDeadline: "March 25",
      transitionDate: "April 1, 2025",
      activeVerifier: "Medical Director",
    }),
    "2025-04-01",
    LAST_VERIFIED_AT,
    "source_linked_check_conditions",
    1,
  ],
  [
    "nremt-paramedic-nccp-ce-2025-v1",
    "nremt-paramedic-nccp-ce",
    1,
    "Emergency Medical Services",
    "Paramedic (NRP) — NCCP continuing-education path",
    "United States",
    "National Registry of Emergency Medical Technicians",
    60,
    "NREMT-accepted CE credits",
    24,
    "https://www.nremt.org/Paramedic/Recertification",
    standardSourceNote({
      level: "Paramedic",
      total: 60,
      national: 30,
      local: 15,
      individual: 15,
      expirationDate: "March 31",
      reinstatementWindow: "April 1 through April 30",
      lapseDate: "May 1",
      rbeApplicationDeadline: "March 25",
      transitionDate: "April 1, 2025",
      activeVerifier: "Medical Director",
    }),
    "2025-04-01",
    LAST_VERIFIED_AT,
    "source_linked_check_conditions",
    1,
  ],
] as const satisfies readonly RuleSetSeedBinding[];

type NremtCategoryProfile = Readonly<{
  prefix: string;
  ruleSetId: string;
  total: number;
  national: number;
  airway: number;
  cardiology: number;
  trauma: number;
  medical: number;
  operations: number;
  pediatric: number;
  local: number;
  individual: number;
}>;

function nremtCategoryBindings({
  prefix,
  ruleSetId,
  total,
  national,
  airway,
  cardiology,
  trauma,
  medical,
  operations,
  pediatric,
  local,
  individual,
}: NremtCategoryProfile): readonly CategorySeedBinding[] {
  const nationalCategoryId = `${prefix}-national`;
  const componentGroup = `${prefix}-component`;
  const topicNote = (topic: string, credits: number) =>
    `Complete ${credits} National ${topic} credits. This topic is nested within the National Component, so its accepted credit also rolls into National without increasing the ${total}-credit overall total. Assign only the accepted credit portion for this topic; do not assign the same credited time to another National topic. Pediatric content may overlap.`;

  return [
    [
      nationalCategoryId,
      ruleSetId,
      "National Component",
      national,
      "minimum",
      "independent",
      null,
      "always",
      `Complete ${national} National credits across the five separately tracked topic minima. Classify each accepted credit as National and assign its post-cap credit to the applicable topic; nested topic credit rolls into this parent rather than adding to the ${total}-credit overall total. Track the pediatric content minimum with the separate overlapping category.`,
      componentGroup,
      0,
    ],
    [
      `${prefix}-national-airway`,
      ruleSetId,
      "National Topic — Airway",
      airway,
      "minimum",
      "nested",
      nationalCategoryId,
      "always",
      topicNote("Airway", airway),
      null,
      1,
    ],
    [
      `${prefix}-national-cardiology`,
      ruleSetId,
      "National Topic — Cardiology",
      cardiology,
      "minimum",
      "nested",
      nationalCategoryId,
      "always",
      topicNote("Cardiology", cardiology),
      null,
      2,
    ],
    [
      `${prefix}-national-trauma`,
      ruleSetId,
      "National Topic — Trauma",
      trauma,
      "minimum",
      "nested",
      nationalCategoryId,
      "always",
      topicNote("Trauma", trauma),
      null,
      3,
    ],
    [
      `${prefix}-national-medical`,
      ruleSetId,
      "National Topic — Medical",
      medical,
      "minimum",
      "nested",
      nationalCategoryId,
      "always",
      topicNote("Medical", medical),
      null,
      4,
    ],
    [
      `${prefix}-national-operations`,
      ruleSetId,
      "National Topic — Operations",
      operations,
      "minimum",
      "nested",
      nationalCategoryId,
      "always",
      topicNote("Operations", operations),
      null,
      5,
    ],
    [
      `${prefix}-national-pediatric`,
      ruleSetId,
      "National Pediatric Content",
      pediatric,
      "minimum",
      "overlapping",
      null,
      "always",
      `At least ${pediatric} of the same National credits must contain pediatric content. Select this overlapping category with the applicable National Component and topic credit; it tracks the pediatric minimum without adding credit to National, a topic minimum, or the ${total}-credit overall total.`,
      null,
      6,
    ],
    [
      `${prefix}-local`,
      ruleSetId,
      "Local/State Component",
      local,
      "minimum",
      "independent",
      null,
      "always",
      `Complete ${local} Local/State credits using accepted, direct EMS patient-care education at or above the certification level and after any applicable course-credit cap. A state, region, or agency may prescribe the topics; absent a prescription, accepted content is flexible. Do not also classify the same credited time as National or Individual.`,
      componentGroup,
      7,
    ],
    [
      `${prefix}-individual`,
      ruleSetId,
      "Individual Component",
      individual,
      "minimum",
      "independent",
      null,
      "always",
      `Complete ${individual} flexible Individual credits using accepted, direct EMS patient-care education at or above the certification level and after any applicable course-credit cap. Do not also classify the same credited time as National or Local/State.`,
      componentGroup,
      8,
    ],
  ];
}

export const NREMT_CATEGORY_SEED_BINDINGS = [
  ...nremtCategoryBindings({
    prefix: "nremt-emr-nccp-ce-2025",
    ruleSetId: "nremt-emr-nccp-ce-2025-v1",
    total: 16,
    national: 8,
    airway: 1.5,
    cardiology: 2,
    trauma: 1,
    medical: 2.5,
    operations: 1,
    pediatric: 0.8,
    local: 4,
    individual: 4,
  }),
  ...nremtCategoryBindings({
    prefix: "nremt-emt-nccp-ce-2025",
    ruleSetId: "nremt-emt-nccp-ce-2025-v1",
    total: 40,
    national: 20,
    airway: 4,
    cardiology: 5,
    trauma: 3,
    medical: 6,
    operations: 2,
    pediatric: 2,
    local: 10,
    individual: 10,
  }),
  ...nremtCategoryBindings({
    prefix: "nremt-aemt-nccp-ce-2025",
    ruleSetId: "nremt-aemt-nccp-ce-2025-v1",
    total: 50,
    national: 25,
    airway: 5,
    cardiology: 6,
    trauma: 4,
    medical: 7,
    operations: 3,
    pediatric: 2.5,
    local: 12.5,
    individual: 12.5,
  }),
  ...nremtCategoryBindings({
    prefix: "nremt-paramedic-nccp-ce-2025",
    ruleSetId: "nremt-paramedic-nccp-ce-2025-v1",
    total: 60,
    national: 30,
    airway: 6,
    cardiology: 7,
    trauma: 5,
    medical: 8,
    operations: 4,
    pediatric: 3,
    local: 15,
    individual: 15,
  }),
] as const satisfies readonly CategorySeedBinding[];
