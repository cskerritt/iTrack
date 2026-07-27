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
  relation: "independent" | "nested" | "overlapping",
  parentCategoryId: string | null,
  applicability: "always" | "conditional" | "optional",
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

type RuleSetSpec = Readonly<{
  id: string;
  stableKey: string;
  profession: string;
  credentialName: string;
  jurisdiction: string;
  issuer: string;
  totalUnits: number;
  unitLabel: string;
  cycleMonths: number;
  sourceUrl: string;
  sourceNote: string;
  effectiveDate?: string | null;
}>;

const LAST_VERIFIED_AT = "2026-07-26";
const IMA_MAINTENANCE_URL =
  "https://prodcm.imanet.org/-/media/IMA/Files/Home/IMA-Certifications/CMA-Certification/continuing-education-requirements-and-rules.ashx";
const ACFE_CPE_URL =
  "https://www.acfe.com/cfe-credential/continuing-professional-education-cpe-requirements/reporting-cpe";
const IIA_RENEWAL_URL =
  "https://www.theiia.org/globalassets/site/certifications/cpe-policy/annual-certification-renewal-policy.pdf";
const IRS_EA_URL =
  "https://www.irs.gov/tax-professionals/enrolled-agents/maintain-your-enrolled-agent-status";
const NASAA_IAR_CE_URL =
  "https://www.nasaa.org/industry-resources/investment-advisers/resources/iar-ce-faq/";
const NASAA_IAR_CE_MAP_URL =
  "https://www.nasaa.org/industry-resources/investment-advisers/investment-adviser-representative-continuing-education/iar-ce-map/";
const NMLS_CE_URL =
  "https://mortgage.nationwidelicensingsystem.org/knowledge/products/nmls/pubs/testingHbk/education/mlo_testing/mlo_test_faq/mlo_testing_hbk_FAQ_educ_CE.html";
const NMLS_STATE_REQUIREMENTS_URL =
  "https://mortgage.nationwidelicensingsystem.org/knowledge/Products/nmls/pubs/testingHbk/education/mlo_testing/state_specificReqs/mlo_testing_hbk_stateSpecific.html";
const NMLS_CREDIT_REPORTING_POLICY_URL =
  "https://mortgage.nationwidelicensingsystem.org/courseprovider/Course%20Provider%20Resources/Policy%20on%20Reporting%20of%20Course%20Completions.pdf";
const FINRA_REGULATORY_ELEMENT_URL =
  "https://www.finra.org/rules-guidance/rulebooks/finra-rules/1240";
const CFA_PROFESSIONAL_LEARNING_URL =
  "https://www.cfainstitute.org/membership/benefits/professional-learning-program";
const ACAMS_RECERTIFICATION_URL =
  "https://www.acams.org/en/certifications/recertification";
const ABA_CE_FAQ_URL =
  "https://www.aba.com/training-events/certifications/maintaining-your-certification/continuing-education-faqs";
const PRIVATE_CREDENTIAL_SCOPE =
  "This is maintenance of a privately issued professional credential, not a government occupational license.";

function ruleSet(spec: RuleSetSpec): RuleSetSeedBinding {
  return [
    spec.id,
    spec.stableKey,
    1,
    spec.profession,
    spec.credentialName,
    spec.jurisdiction,
    spec.issuer,
    spec.totalUnits,
    spec.unitLabel,
    spec.cycleMonths,
    spec.sourceUrl,
    spec.sourceNote,
    spec.effectiveDate ?? null,
    LAST_VERIFIED_AT,
    "source_linked_check_conditions",
    1,
  ];
}

function iiaSourceNote({
  credential,
  status,
  total,
  carryover,
}: {
  credential: "CIA" | "CRMA";
  status: "practicing" | "non-practicing";
  total: number;
  carryover: number;
}) {
  const statusDefinition =
    status === "practicing"
      ? "actively performs internal audit or related activities"
      : "is not retired and does not actively perform internal audit or related activities";
  return `The IIA Annual Certification Renewal Policy for an established active ${credential} holder who ${statusDefinition}: complete ${total} qualifying CPE hours during each January 1–December 31 reporting year, including two ethics hours, review the Global Internal Audit Standards, attest to Standards conformance or nonconformance, attest to conformance with The IIA's Standards of Ethics and Professionalism, report any criminal convictions, and complete renewal in CCMS by December 31. Ethics is included within the ${total}-hour total. Keep supporting records for at least three years. Up to ${carryover} surplus CPE hours may be carried into the immediately following reporting year under the policy, but Vigilo never creates carryover automatically; record only an amount confirmed for the new year in CCMS. A new certification's first renewal period runs from the award date through December 31 of the following year and is not this standard 12-month template. Retired, hardship-exempt, Grace, revoked, and National Institute-administered paths require separate handling. When one activity legitimately meets both CIA and CRMA content rules, it may be recorded against both credentials rather than treated as additional education. ${PRIVATE_CREDENTIAL_SCOPE}`;
}

function abaSourceNote({
  credential,
  total,
}: {
  credential: string;
  total: number;
}) {
  return `American Bankers Association maintenance requirements for the ${credential}: enter ${total} ABA-accepted CE credits during the holder's exact three-year cycle in Certification Manager, pay the certification fee annually by January 31, and continue to adhere to the ABA Professional Certifications Code of Ethics. ABA awards CE to a given program title only once every 1,095 days, even when that interval crosses CE cycles. CE is due no later than January 31 three years after the cycle start shown in Certification Manager. ABA automatically carries eligible excess reported on time into the next cycle up to one-third of the credential's minimum; Vigilo never predicts or copies that credit, so record carryover only after ABA posts it. Keep supporting evidence for the complete three-year cycle and use ABA's current activity-eligibility guidance. A late, deficient, decertified, reinstatement, or adjusted cycle must follow Certification Manager rather than dates inferred from an exam or award. Common CE guidance: ${ABA_CE_FAQ_URL}. ${PRIVATE_CREDENTIAL_SCOPE}`;
}

export const FINANCE_CERTIFICATION_RULE_SET_SEED_BINDINGS = [
  ruleSet({
    id: "ima-cma-2026-v1",
    stableKey: "ima-cma",
    profession: "Accounting",
    credentialName:
      "Certified Management Accountant (CMA) — established annual maintenance",
    jurisdiction: "Global",
    issuer: "Institute of Management Accountants",
    totalUnits: 30,
    unitLabel: "CPE hours",
    cycleMonths: 12,
    sourceUrl: IMA_MAINTENANCE_URL,
    sourceNote: `IMA Rules and Requirements for Maintaining Certifications for an established CMA calendar year: complete 30 qualifying CPE hours by December 31, including two hours of ethics, maintain IMA membership in good standing, and keep the IMA transcript current. The ethics hours are included within the 30-hour total. Up to 10 excess CPE hours may apply to the next calendar year, but Vigilo never copies carryover automatically; record only the eligible amount supported by the prior-year record. CPE begins under IMA's award-year timing rules, so use this template for a full reporting year shown in the account rather than assuming a partial initial year. Retired status, hardship waivers, delinquency remediation, CFM maintenance, and any employer or jurisdictional requirements are separate paths. ${PRIVATE_CREDENTIAL_SCOPE}`,
  }),
  ruleSet({
    id: "acfe-cfe-2026-v1",
    stableKey: "acfe-cfe",
    profession: "Fraud Examination",
    credentialName:
      "Certified Fraud Examiner (CFE) — established annual compliance period",
    jurisdiction: "Global",
    issuer: "Association of Certified Fraud Examiners",
    totalUnits: 20,
    unitLabel: "CPE credits",
    cycleMonths: 12,
    sourceUrl: ACFE_CPE_URL,
    sourceNote: `ACFE CPE requirements for an established CFE annual compliance period: earn 20 accepted CPE credits every 12 months, including at least 10 fraud-related credits and two ethics-related credits, pay annual membership dues, and certify compliance by the end of the holder's anniversary month. Ethics credit may also qualify as fraud-related when ACFE's field-of-study rules support both classifications. Retain acceptable proof for three years; ACFE does not maintain the complete record for the holder. Up to 10 excess credits may carry into the immediately following period only after the current 20-credit, fraud, and ethics requirements are met; Vigilo never copies carryover automatically. New CFEs are exempt through their next anniversary month, so the initial exemption period is not this template. A 30-day extension or additional discretionary relief must be approved by ACFE and is not assumed. ${PRIVATE_CREDENTIAL_SCOPE}`,
  }),
  ruleSet({
    id: "iia-cia-practicing-2026-v1",
    stableKey: "iia-cia-practicing",
    profession: "Internal Audit",
    credentialName:
      "Certified Internal Auditor (CIA) — active practicing annual renewal",
    jurisdiction: "Global",
    issuer: "The Institute of Internal Auditors",
    totalUnits: 40,
    unitLabel: "CPE hours",
    cycleMonths: 12,
    sourceUrl: IIA_RENEWAL_URL,
    sourceNote: iiaSourceNote({
      credential: "CIA",
      status: "practicing",
      total: 40,
      carryover: 20,
    }),
  }),
  ruleSet({
    id: "iia-cia-nonpracticing-2026-v1",
    stableKey: "iia-cia-nonpracticing",
    profession: "Internal Audit",
    credentialName:
      "Certified Internal Auditor (CIA) — active non-practicing annual renewal",
    jurisdiction: "Global",
    issuer: "The Institute of Internal Auditors",
    totalUnits: 20,
    unitLabel: "CPE hours",
    cycleMonths: 12,
    sourceUrl: IIA_RENEWAL_URL,
    sourceNote: iiaSourceNote({
      credential: "CIA",
      status: "non-practicing",
      total: 20,
      carryover: 20,
    }),
  }),
  ruleSet({
    id: "iia-crma-practicing-2026-v1",
    stableKey: "iia-crma-practicing",
    profession: "Internal Audit",
    credentialName:
      "Certification in Risk Management Assurance (CRMA) — active practicing annual renewal",
    jurisdiction: "Global",
    issuer: "The Institute of Internal Auditors",
    totalUnits: 20,
    unitLabel: "CPE hours",
    cycleMonths: 12,
    sourceUrl: IIA_RENEWAL_URL,
    sourceNote: iiaSourceNote({
      credential: "CRMA",
      status: "practicing",
      total: 20,
      carryover: 10,
    }),
  }),
  ruleSet({
    id: "iia-crma-nonpracticing-2026-v1",
    stableKey: "iia-crma-nonpracticing",
    profession: "Internal Audit",
    credentialName:
      "Certification in Risk Management Assurance (CRMA) — active non-practicing annual renewal",
    jurisdiction: "Global",
    issuer: "The Institute of Internal Auditors",
    totalUnits: 10,
    unitLabel: "CPE hours",
    cycleMonths: 12,
    sourceUrl: IIA_RENEWAL_URL,
    sourceNote: iiaSourceNote({
      credential: "CRMA",
      status: "non-practicing",
      total: 10,
      carryover: 10,
    }),
  }),
  ruleSet({
    id: "irs-enrolled-agent-full-cycle-2026-v1",
    stableKey: "irs-enrolled-agent-full-cycle",
    profession: "Tax",
    credentialName:
      "IRS Enrolled Agent — standard full three-year enrollment cycle",
    jurisdiction: "United States",
    issuer: "Internal Revenue Service",
    totalUnits: 72,
    unitLabel: "IRS CE credits",
    cycleMonths: 36,
    sourceUrl: IRS_EA_URL,
    sourceNote:
      "IRS requirements for a renewed Enrolled Agent's standard full three-calendar-year enrollment cycle: complete 72 credits of qualifying federal-tax or federal-tax-related continuing education from IRS-approved providers, including at least 16 credits in each calendar year and at least two ethics or professional-conduct credits in each calendar year. The six cycle ethics credits are included within the 72-credit total. Use the exact cycle associated with the last digit of the holder's SSN or the IRS-assigned group, complete CE by December 31 of the third enrollment year, renew with Form 8554 during the assigned window, and renew the PTIN separately each year. The first renewal after initial enrollment uses a prorated total of two CE credits for each enrolled month, with two of those total credits required in ethics or professional conduct for each enrollment year; that initial path is not this template. Waivers, inactive or terminated status, instructor limits, and other Circular 230 exceptions require separate handling. Label each activity with its actual cycle year; split an activity into supported entries when only part of it carries ethics credit. This tracks a federally issued practitioner credential rather than a state occupational license; active enrollment is required to retain Enrolled Agent status and its federal representation rights.",
  }),
  ruleSet({
    id: "nasaa-iar-ce-adopting-jurisdiction-2026-v1",
    stableKey: "nasaa-iar-ce-adopting-jurisdiction",
    profession: "Securities",
    credentialName:
      "Investment Adviser Representative — NASAA-model CE in an adopting jurisdiction",
    jurisdiction: "Adopting U.S. jurisdictions",
    issuer: "Applicable state or territorial securities regulator",
    totalUnits: 12,
    unitLabel: "IAR CE credits",
    cycleMonths: 12,
    sourceUrl: NASAA_IAR_CE_URL,
    sourceNote:
      `NASAA-model IAR CE for an Investment Adviser Representative registered in a jurisdiction that has adopted the requirement: complete 12 approved credits each calendar year, split exactly into six Ethics and Professional Responsibility credits and six Products and Practice credits. A credit represents at least 50 minutes. Approved providers report completion for the FinPro transcript; complete courses early enough for reporting before year-end. Excess does not carry, and a course with the same course ID never counts twice unless updated and issued a new ID. A dually registered broker-dealer agent may use completed FINRA Regulatory Element CE for the six Products and Practice credits only when the NASAA conditions and reporting fee are satisfied. The first registration in an IAR-CE jurisdiction generally begins CE on January 1 of the next full calendar year. Applicability depends on every current and prior in-scope registration; verify it against the current official jurisdiction map (${NASAA_IAR_CE_MAP_URL}) and FinPro. This template does not represent a Series exam renewal or a jurisdiction that has not adopted IAR CE.`,
  }),
  ruleSet({
    id: "nmls-state-mlo-federal-core-2026-v1",
    stableKey: "nmls-state-mlo-federal-core",
    profession: "Mortgage Lending",
    credentialName:
      "State-Licensed Mortgage Loan Originator — annual SAFE Act federal CE core",
    jurisdiction: "United States — state-issued MLO license",
    issuer: "Applicable state agency through NMLS",
    totalUnits: 8,
    unitLabel: "NMLS CE hours",
    cycleMonths: 12,
    sourceUrl: NMLS_CE_URL,
    sourceNote:
      `SAFE Act minimum for an established state-licensed Mortgage Loan Originator: complete at least eight hours of NMLS-approved CE in the renewal year, comprising three hours of federal law and regulations, two hours of ethics that includes fraud, consumer protection, and fair lending, two hours on nontraditional mortgage-product lending standards, and one elective hour. State agencies can require extra hours, state-specific content, and earlier deadlines; this base template is complete only when the current agency table (${NMLS_STATE_REQUIREMENTS_URL}) confirms that the eight-hour course satisfies every held license. NMLS blocks renewal until federal and state CE are posted, and provider reporting can take seven days. CE counts only in the calendar year in which the course is taken; excess hours cannot satisfy a later year's requirement under the NMLS reporting policy (${NMLS_CREDIT_REPORTING_POLICY_URL}). The same approved course or licensed course content may not be taken in successive years. Initial-year exceptions depend on federal pre-licensure compliance and approval timing, including special treatment for November–December approvals, and are not inferred here. Record each itemized course component as a separate activity entry so the 3/2/2/1 split can be verified, while retaining the common package certificate as evidence.`,
  }),
  ruleSet({
    id: "finra-regulatory-element-annual-2026-v1",
    stableKey: "finra-regulatory-element-annual",
    profession: "Securities",
    credentialName:
      "FINRA-Registered Person — annual Regulatory Element completion",
    jurisdiction: "United States",
    issuer: "Financial Industry Regulatory Authority",
    totalUnits: 1,
    unitLabel: "assigned learning plan",
    cycleMonths: 12,
    sourceUrl: FINRA_REGULATORY_ELEMENT_URL,
    sourceNote:
      "FINRA Rule 1240 Regulatory Element obligation for an established covered registered person: complete the Regulatory Element annually by December 31 for every representative or principal registration category held, subject to any earlier completion date imposed by the member firm. FINRA assigns content by registration category, and adding or dropping a registration can change the learning plan. This template intentionally uses one completion unit because FINRA does not prescribe a uniform credit-hour total; record the unit only after the complete current learning plan for every held registration category shows complete in FinPro. A person registering in a representative or principal category for the first time on or after January 1, 2023 generally first completes that category's Regulatory Element by December 31 of the subsequent calendar year, so do not apply this established annual template to that initial period. Reregistration under Rule 1240(a)(4) can instead require completion in the calendar year of reregistration unless the person already completed that category's content for the year, passed the category exam, or obtained an unconditional exam waiver; follow the exact FinPro and firm deadline rather than this template for a reregistration. Failure results in CE-inactive status unless FINRA grants additional time for good cause. The separately required Firm Element is employer-specific and is not included in this individual Regulatory Element template. This is a regulatory registration obligation, not maintenance of a private professional designation.",
    effectiveDate: "2023-01-01",
  }),
  ruleSet({
    id: "cfainstitute-cipm-2026-v1",
    stableKey: "cfainstitute-cipm",
    profession: "Investment Management",
    credentialName:
      "Certificate in Investment Performance Measurement (CIPM) — private-designation mandatory annual professional learning",
    jurisdiction: "Global",
    issuer: "CFA Institute",
    totalUnits: 15,
    unitLabel: "PL credits",
    cycleMonths: 12,
    sourceUrl: CFA_PROFESSIONAL_LEARNING_URL,
    sourceNote:
      "CFA Institute Mandatory Professional Learning for a CIPM designation holder: complete and record at least 15 qualifying Professional Learning credits annually following the year in which the designation was earned or renewed, attest to completion during membership renewal, keep supporting documentation for one year after the activity year, maintain the membership required to use the designation, and submit the annual Professional Conduct Statement. Use the membership account's exact period rather than inferring dates from an exam. The broader 20-credit and two Standards, Ethics, and Regulations target for CFA Institute members is recommended, not an additional CIPM minimum. The current CFA Institute Professional Learning page permits carryover after earning more than 20 PL credits, including two Standards, Ethics, and Regulations credits: up to 20 additional PL credits and two additional Standards, Ethics, and Regulations credits may carry to the next year. Vigilo never copies carryover automatically, so record only credit shown for the current period in the PL tracker. This template is for the privately issued CIPM designation, not a government license and not the voluntary Professional Learning target for a CFA charterholder.",
  }),
  ruleSet({
    id: "acams-cams-2026-v1",
    stableKey: "acams-cams",
    profession: "Financial Crime Compliance",
    credentialName:
      "Certified Anti-Money Laundering Specialist (CAMS) — three-year recertification",
    jurisdiction: "Global",
    issuer: "Association of Certified Anti-Money Laundering Specialists",
    totalUnits: 60,
    unitLabel: "recertification credits",
    cycleMonths: 36,
    sourceUrl: ACAMS_RECERTIFICATION_URL,
    sourceNote: `ACAMS CAMS recertification: maintain active ACAMS membership, earn 60 eligible recertification credits during the exact three-year cycle after certification or the last recertification, including at least 12 credits from ACAMS-provided training, and submit the online recertification application and fee. Credits earned before the current cycle do not count, and excess does not roll into the next cycle. Current ACAMS policy sets October 1 early, December 15 standard, and March 31 late application dates in the recertification year; the credit-earning deadline remains December 15, so the late application window is not extra time to earn CE. Record only credits accepted under the current ACAMS activity policy and use the deadline shown in My Account. An exceptional-circumstances extension must be approved during the recertification year and is not assumed. Other ACAMS specialist and advanced-specialist credentials have different totals and are not covered by this CAMS template. ${PRIVATE_CREDENTIAL_SCOPE}`,
  }),
  ruleSet({
    id: "aba-crcm-2026-v1",
    stableKey: "aba-crcm",
    profession: "Banking",
    credentialName:
      "Certified Regulatory Compliance Manager (CRCM) — standard maintenance cycle",
    jurisdiction: "United States",
    issuer: "American Bankers Association",
    totalUnits: 60,
    unitLabel: "ABA CE credits",
    cycleMonths: 36,
    sourceUrl:
      "https://www.aba.com/training-events/certifications/certified-regulatory-compliance-manager/maintain-crcm",
    sourceNote: abaSourceNote({
      credential: "Certified Regulatory Compliance Manager (CRCM)",
      total: 60,
    }),
  }),
  ruleSet({
    id: "aba-cerp-2026-v1",
    stableKey: "aba-cerp",
    profession: "Banking",
    credentialName:
      "Certified Enterprise Risk Professional (CERP) — standard maintenance cycle",
    jurisdiction: "United States",
    issuer: "American Bankers Association",
    totalUnits: 60,
    unitLabel: "ABA CE credits",
    cycleMonths: 36,
    sourceUrl:
      "https://www.aba.com/training-events/certifications/certified-enterprise-risk-professional/maintain-cerp",
    sourceNote: abaSourceNote({
      credential: "Certified Enterprise Risk Professional (CERP)",
      total: 60,
    }),
  }),
  ruleSet({
    id: "aba-ctfa-2026-v1",
    stableKey: "aba-ctfa",
    profession: "Banking",
    credentialName:
      "Certified Trust and Fiduciary Advisor (CTFA) — standard maintenance cycle",
    jurisdiction: "United States",
    issuer: "American Bankers Association",
    totalUnits: 45,
    unitLabel: "ABA CE credits",
    cycleMonths: 36,
    sourceUrl:
      "https://www.aba.com/training-events/certifications/certified-trust-and-fiduciary-advisor/maintain-ctfa",
    sourceNote: abaSourceNote({
      credential: "Certified Trust and Fiduciary Advisor (CTFA)",
      total: 45,
    }),
  }),
  ruleSet({
    id: "aba-cafp-2026-v1",
    stableKey: "aba-cafp",
    profession: "Banking",
    credentialName:
      "Certified AML and Fraud Professional (CAFP) — standard maintenance cycle",
    jurisdiction: "United States",
    issuer: "American Bankers Association",
    totalUnits: 45,
    unitLabel: "ABA CE credits",
    cycleMonths: 36,
    sourceUrl:
      "https://www.aba.com/training-events/certifications/certified-aml-and-fraud-professional/maintain-cafp",
    sourceNote: abaSourceNote({
      credential: "Certified AML and Fraud Professional (CAFP)",
      total: 45,
    }),
  }),
] as const satisfies readonly RuleSetSeedBinding[];

export const FINANCE_CERTIFICATION_CATEGORY_SEED_BINDINGS = [
  [
    "ima-cma-2026-ethics",
    "ima-cma-2026-v1",
    "Ethics",
    2,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least two of the 30 annual CPE hours must be in ethics. Enter only the ethics amount supported by the completion record.",
    null,
    0,
  ],
  [
    "acfe-cfe-2026-fraud",
    "acfe-cfe-2026-v1",
    "Fraud-Related CPE",
    10,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least 10 of the 20 annual credits must relate directly to fraud detection and deterrence under ACFE's current fields of study.",
    null,
    0,
  ],
  [
    "acfe-cfe-2026-ethics",
    "acfe-cfe-2026-v1",
    "Ethics-Related CPE",
    2,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least two annual credits must relate directly to ethics. ACFE permits the same supported activity to satisfy both fraud and ethics classifications.",
    null,
    1,
  ],
  [
    "iia-cia-practicing-2026-ethics",
    "iia-cia-practicing-2026-v1",
    "Ethics Training",
    2,
    "minimum",
    "overlapping",
    null,
    "always",
    "Complete at least two ethics CPE hours inside the annual reporting period; they are included within the 40-hour practicing-CIA total.",
    null,
    0,
  ],
  [
    "iia-cia-nonpracticing-2026-ethics",
    "iia-cia-nonpracticing-2026-v1",
    "Ethics Training",
    2,
    "minimum",
    "overlapping",
    null,
    "always",
    "Complete at least two ethics CPE hours inside the annual reporting period; they are included within the 20-hour non-practicing-CIA total.",
    null,
    0,
  ],
  [
    "iia-crma-practicing-2026-ethics",
    "iia-crma-practicing-2026-v1",
    "Ethics Training",
    2,
    "minimum",
    "overlapping",
    null,
    "always",
    "Complete at least two ethics CPE hours inside the annual reporting period; they are included within the 20-hour practicing-CRMA total.",
    null,
    0,
  ],
  [
    "iia-crma-nonpracticing-2026-ethics",
    "iia-crma-nonpracticing-2026-v1",
    "Ethics Training",
    2,
    "minimum",
    "overlapping",
    null,
    "always",
    "Complete at least two ethics CPE hours inside the annual reporting period; they are included within the 10-hour non-practicing-CRMA total.",
    null,
    0,
  ],
  [
    "irs-enrolled-agent-full-cycle-2026-year-1",
    "irs-enrolled-agent-full-cycle-2026-v1",
    "Enrollment Year 1 — Annual CE Minimum",
    16,
    "minimum",
    "independent",
    null,
    "always",
    "Classify at least 16 qualifying credits completed from January 1 through December 31 of the first calendar year in the official enrollment cycle.",
    "IRS EA enrollment year",
    0,
  ],
  [
    "irs-enrolled-agent-full-cycle-2026-year-1-ethics",
    "irs-enrolled-agent-full-cycle-2026-v1",
    "Enrollment Year 1 — Ethics or Professional Conduct",
    2,
    "minimum",
    "nested",
    "irs-enrolled-agent-full-cycle-2026-year-1",
    "always",
    "At least two of Enrollment Year 1's credits must be ethics or professional conduct. Select this nested ethics leaf instead of its annual-minimum parent; its credits roll up to Enrollment Year 1.",
    "IRS EA enrollment year",
    1,
  ],
  [
    "irs-enrolled-agent-full-cycle-2026-year-2",
    "irs-enrolled-agent-full-cycle-2026-v1",
    "Enrollment Year 2 — Annual CE Minimum",
    16,
    "minimum",
    "independent",
    null,
    "always",
    "Classify at least 16 qualifying credits completed from January 1 through December 31 of the second calendar year in the official enrollment cycle.",
    "IRS EA enrollment year",
    2,
  ],
  [
    "irs-enrolled-agent-full-cycle-2026-year-2-ethics",
    "irs-enrolled-agent-full-cycle-2026-v1",
    "Enrollment Year 2 — Ethics or Professional Conduct",
    2,
    "minimum",
    "nested",
    "irs-enrolled-agent-full-cycle-2026-year-2",
    "always",
    "At least two of Enrollment Year 2's credits must be ethics or professional conduct. Select this nested ethics leaf instead of its annual-minimum parent; its credits roll up to Enrollment Year 2.",
    "IRS EA enrollment year",
    3,
  ],
  [
    "irs-enrolled-agent-full-cycle-2026-year-3",
    "irs-enrolled-agent-full-cycle-2026-v1",
    "Enrollment Year 3 — Annual CE Minimum",
    16,
    "minimum",
    "independent",
    null,
    "always",
    "Classify at least 16 qualifying credits completed from January 1 through December 31 of the third calendar year in the official enrollment cycle.",
    "IRS EA enrollment year",
    4,
  ],
  [
    "irs-enrolled-agent-full-cycle-2026-year-3-ethics",
    "irs-enrolled-agent-full-cycle-2026-v1",
    "Enrollment Year 3 — Ethics or Professional Conduct",
    2,
    "minimum",
    "nested",
    "irs-enrolled-agent-full-cycle-2026-year-3",
    "always",
    "At least two of Enrollment Year 3's credits must be ethics or professional conduct. Select this nested ethics leaf instead of its annual-minimum parent; its credits roll up to Enrollment Year 3.",
    "IRS EA enrollment year",
    5,
  ],
  [
    "nasaa-iar-ce-adopting-jurisdiction-2026-ethics",
    "nasaa-iar-ce-adopting-jurisdiction-2026-v1",
    "Ethics and Professional Responsibility",
    6,
    "minimum",
    "independent",
    null,
    "always",
    "Complete exactly the six-credit category minimum with approved IAR CE courses reported under Ethics and Professional Responsibility.",
    "NASAA IAR CE content type",
    0,
  ],
  [
    "nasaa-iar-ce-adopting-jurisdiction-2026-products-practice",
    "nasaa-iar-ce-adopting-jurisdiction-2026-v1",
    "Products and Practice",
    6,
    "minimum",
    "independent",
    null,
    "always",
    "Complete exactly the six-credit category minimum with approved Products and Practice credit, including eligible FINRA Regulatory Element credit only after the required reporting and fee.",
    "NASAA IAR CE content type",
    1,
  ],
  [
    "nmls-state-mlo-federal-core-2026-federal-law",
    "nmls-state-mlo-federal-core-2026-v1",
    "Federal Law and Regulations",
    3,
    "minimum",
    "independent",
    null,
    "always",
    "Record the three-hour federal-law component awarded by the NMLS-approved provider as its own activity entry.",
    "NMLS CE content component",
    0,
  ],
  [
    "nmls-state-mlo-federal-core-2026-ethics",
    "nmls-state-mlo-federal-core-2026-v1",
    "Ethics, Fraud, Consumer Protection, and Fair Lending",
    2,
    "minimum",
    "independent",
    null,
    "always",
    "Record the two-hour ethics component, including fraud, consumer protection, and fair lending, as its own activity entry.",
    "NMLS CE content component",
    1,
  ],
  [
    "nmls-state-mlo-federal-core-2026-nontraditional",
    "nmls-state-mlo-federal-core-2026-v1",
    "Nontraditional Mortgage Product Lending Standards",
    2,
    "minimum",
    "independent",
    null,
    "always",
    "Record the two-hour nontraditional-mortgage component awarded by the NMLS-approved provider as its own activity entry.",
    "NMLS CE content component",
    2,
  ],
  [
    "nmls-state-mlo-federal-core-2026-elective",
    "nmls-state-mlo-federal-core-2026-v1",
    "Mortgage Origination Elective",
    1,
    "minimum",
    "independent",
    null,
    "always",
    "Record the one-hour elective component as its own activity entry and confirm whether the licensing agency requires state-specific content for this hour or additional CE.",
    "NMLS CE content component",
    3,
  ],
  [
    "finra-regulatory-element-annual-2026-complete",
    "finra-regulatory-element-annual-2026-v1",
    "Complete Assigned Regulatory Element Learning Plan",
    1,
    "minimum",
    "independent",
    null,
    "always",
    "Record one completion unit only when FinPro shows every current Regulatory Element course assigned for every held registration as complete.",
    null,
    0,
  ],
  [
    "cfainstitute-cipm-2026-professional-learning",
    "cfainstitute-cipm-2026-v1",
    "Qualifying Professional Learning",
    15,
    "minimum",
    "independent",
    null,
    "always",
    "Record at least 15 qualifying PL credits at the values supported by the CFA Institute tracker or retained third-party evidence.",
    null,
    0,
  ],
  [
    "acams-cams-2026-acams-training",
    "acams-cams-2026-v1",
    "ACAMS-Provided Training",
    12,
    "minimum",
    "overlapping",
    null,
    "always",
    "At least 12 of the 60 recertification credits must come from ACAMS-provided training. External-provider credits do not satisfy this minimum.",
    null,
    0,
  ],
  [
    "aba-crcm-2026-accepted-ce",
    "aba-crcm-2026-v1",
    "ABA-Accepted CRCM Continuing Education",
    60,
    "minimum",
    "independent",
    null,
    "always",
    "Classify only CE accepted for the CRCM under ABA's current eligibility rules and shown or entered in Certification Manager.",
    null,
    0,
  ],
  [
    "aba-cerp-2026-accepted-ce",
    "aba-cerp-2026-v1",
    "ABA-Accepted CERP Continuing Education",
    60,
    "minimum",
    "independent",
    null,
    "always",
    "Classify only CE accepted for the CERP under ABA's current eligibility rules and shown or entered in Certification Manager.",
    null,
    0,
  ],
  [
    "aba-ctfa-2026-accepted-ce",
    "aba-ctfa-2026-v1",
    "ABA-Accepted CTFA Continuing Education",
    45,
    "minimum",
    "independent",
    null,
    "always",
    "Classify only CE accepted for the CTFA under ABA's current eligibility rules and shown or entered in Certification Manager.",
    null,
    0,
  ],
  [
    "aba-cafp-2026-accepted-ce",
    "aba-cafp-2026-v1",
    "ABA-Accepted CAFP Continuing Education",
    45,
    "minimum",
    "independent",
    null,
    "always",
    "Classify only CE accepted for the CAFP under ABA's current eligibility rules and shown or entered in Certification Manager.",
    null,
    0,
  ],
] as const satisfies readonly CategorySeedBinding[];

export const FINANCE_CERTIFICATION_MAXIMUM_CLASSIFICATION_RULE_SET_IDS =
  [] as const;

export const FINANCE_CERTIFICATION_RENEWAL_TASK_COPY_BINDINGS = [
  [
    "ima-cma-2026-v1",
    "Confirm the full CMA calendar-year period, active IMA membership, transcript, and any supported carryover",
    "Record 30 qualifying CPE hours by December 31, including at least two ethics hours",
    "Confirm the IMA transcript and membership are current and save annual CMA compliance evidence",
  ],
  [
    "acfe-cfe-2026-v1",
    "Confirm the CFE anniversary-month compliance period, membership status, and any supported carryover",
    "Record 20 accepted credits, including 10 fraud-related and two ethics-related credits",
    "Certify CPE compliance by the end of the anniversary month, pay dues, and retain proof for three years",
  ],
  [
    "iia-cia-practicing-2026-v1",
    "Confirm active practicing CIA status, the calendar-year period, and CCMS carryover",
    "Record 40 CPE hours, including two ethics hours, and review the current Standards",
    "Complete the CCMS Standards-conformance, Ethics and Professionalism, and conviction attestations by December 31 and retain proof",
  ],
  [
    "iia-cia-nonpracticing-2026-v1",
    "Confirm active non-practicing CIA status, the calendar-year period, and CCMS carryover",
    "Record 20 CPE hours, including two ethics hours, and review the current Standards",
    "Complete the CCMS Standards-conformance, Ethics and Professionalism, and conviction attestations by December 31 and retain proof",
  ],
  [
    "iia-crma-practicing-2026-v1",
    "Confirm active practicing CRMA status, the calendar-year period, and CCMS carryover",
    "Record 20 CPE hours, including two ethics hours, and review the current Standards",
    "Complete the CCMS Standards-conformance, Ethics and Professionalism, and conviction attestations by December 31 and retain proof",
  ],
  [
    "iia-crma-nonpracticing-2026-v1",
    "Confirm active non-practicing CRMA status, the calendar-year period, and CCMS carryover",
    "Record 10 CPE hours, including two ethics hours, and review the current Standards",
    "Complete the CCMS Standards-conformance, Ethics and Professionalism, and conviction attestations by December 31 and retain proof",
  ],
  [
    "irs-enrolled-agent-full-cycle-2026-v1",
    "Confirm the IRS-assigned full three-year enrollment cycle, annual PTIN status, and Form 8554 window",
    "Record 72 IRS-approved credits with at least 16 and two ethics credits in each calendar year",
    "Finish CE by the third December 31, file Form 8554 in the assigned window, and save IRS confirmation",
  ],
  [
    "nasaa-iar-ce-adopting-jurisdiction-2026-v1",
    "Confirm every current and prior IAR registration, adopting-jurisdiction applicability, and FinPro status",
    "Complete six Ethics and Professional Responsibility plus six Products and Practice credits",
    "Ensure all 12 credits are reported before year-end processing and save the FinPro transcript",
  ],
  [
    "nmls-state-mlo-federal-core-2026-v1",
    "Check every held agency's current CE hours, state content, deadline, and initial-year applicability",
    "Complete NMLS-approved 3/2/2/1 federal-core CE before the SMART deadline and allow reporting time",
    "Confirm federal and state CE compliance in NMLS, submit each agency renewal, and save the record",
  ],
  [
    "finra-regulatory-element-annual-2026-v1",
    "Review every held FINRA registration and the complete assigned Regulatory Element learning plan",
    "Finish every assigned course in FinPro and separately confirm the firm's Firm Element process",
    "Verify Regulatory Element completion by December 31 and save the FinPro or firm record",
  ],
  [
    "cfainstitute-cipm-2026-v1",
    "Confirm the CIPM membership period, PL tracker, dues, and Professional Conduct Statement status",
    "Record at least 15 qualifying mandatory PL credits and retain supporting documents",
    "Attest to mandatory PL during membership renewal, submit the conduct statement, and save confirmation",
  ],
  [
    "acams-cams-2026-v1",
    "Confirm the exact CAMS three-year cycle, active ACAMS membership, and My Account credit totals",
    "Record 60 eligible credits by December 15, including at least 12 from ACAMS-provided training",
    "Submit the recertification application and fee by the applicable deadline and save approval",
  ],
  [
    "aba-crcm-2026-v1",
    "Confirm the CRCM three-year CE cycle, annual-fee status, and Certification Manager carryover",
    "Enter 60 ABA-accepted CRCM credits without reusing a program title within 1,095 days",
    "Pay the annual fee, complete the cycle by its January 31 due date, and save CRCM maintenance proof",
  ],
  [
    "aba-cerp-2026-v1",
    "Confirm the CERP three-year CE cycle, annual-fee status, and Certification Manager carryover",
    "Enter 60 ABA-accepted CERP credits without reusing a program title within 1,095 days",
    "Pay the annual fee, complete the cycle by its January 31 due date, and save CERP maintenance proof",
  ],
  [
    "aba-ctfa-2026-v1",
    "Confirm the CTFA three-year CE cycle, annual-fee status, and Certification Manager carryover",
    "Enter 45 ABA-accepted CTFA credits without reusing a program title within 1,095 days",
    "Pay the annual fee, complete the cycle by its January 31 due date, and save CTFA maintenance proof",
  ],
  [
    "aba-cafp-2026-v1",
    "Confirm the CAFP three-year CE cycle, annual-fee status, and Certification Manager carryover",
    "Enter 45 ABA-accepted CAFP credits without reusing a program title within 1,095 days",
    "Pay the annual fee, complete the cycle by its January 31 due date, and save CAFP maintenance proof",
  ],
] as const satisfies readonly RenewalTaskCopyBinding[];
