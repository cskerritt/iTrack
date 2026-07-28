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

type CredentialSpec = Readonly<{
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
  effectiveDate?: string;
  reviewTask: string;
  progressTask: string;
  submissionTask: string;
}>;

const LAST_VERIFIED_AT = "2026-07-26";

const ASCM_MAINTENANCE_URL =
  "https://www.ascm.org/learning-development/certifications-credentials/certification-maintenance/";
const ASQ_RECERTIFICATION_URL = "https://www.asq.org/cert/recertification";
const BCSP_AT_A_GLANCE_URL =
  "https://www.bcsp.org/hubfs/Website/Downloads-PDFs-and-PPTs/BCSP-At-A-Glance.pdf?hsLang=en";
const BCSP_RECERTIFICATION_URL = "https://www.bcsp.org/recertification";
const GBCI_CMP_URL =
  "https://www.gbci.org/sites/default/files/2023-CMP-Guide-101923.pdf";
const ICF_RENEWAL_URL =
  "https://coachingfederation.org/credentialing/renew-your-credential/";
const ICF_RENEWAL_GUIDE_URL =
  "https://coachingfederation.org/wp-content/uploads/2024/12/icf-cs-credential-renewal-candidate-guide.pdf";
const ICF_MENTOR_QUALIFICATION_HANDBOOK_URL =
  "https://coachingfederation.org/wp-content/uploads/2026/04/icf-cs-mentor-qualification-handbook.pdf";
const INTERNACHI_CE_URL = "https://www.nachi.org/cont_education.htm";
const IFMA_CFM_RECERTIFICATION_URL =
  "https://www.ifma.org/media/e01bpo2g/cfm-recertification-guide_july-2026-_final.pdf";
const ATD_RECERTIFICATION_URL =
  "https://assets.td.org/m/4f458395c053022c/original/ATD_May2024_Recertification_Guide.pdf";
const GIAC_RENEWAL_URL = "https://www.giac.org/knowledge-base/renewal";
const IAPP_CPE_POLICY_URL =
  "https://assets.contentstack.io/v3/assets/bltd4dd5b2d705252bc/blt25df7f1b0d8c84f7/CPE_Policy.pdf";
const IAPP_MAINTENANCE_URL = "https://iapp.org/certify/stay-certified";
const ACE_RECERTIFICATION_URL =
  "https://www.acefitness.org/fitness-certifications/recertification/";
const ACE_HANDBOOK_URL =
  "https://www.acefitness.org/fitness-certifications/pdfs/Certification-Exam-Candidate-Handbook.pdf";

const ASCM_COMMON_NOTE =
  "ASCM's current APICS certification-maintenance guidance for a standard, non-Fellow credential requires 75 professional-development maintenance points every five years. Use the exact maintenance-cycle dates in My Account and record only the point value ASCM accepts for an eligible supply-chain activity. ASCM membership currently earns six points per year, but do not auto-award membership credit; enter it only for an active membership year supported by the account record. The holder may apply as early as 30 days after the cycle begins once the full requirement is earned, and ASCM may audit the application. A credential not maintained by its due date enters a 90-day suspension period; this template models ordinary on-time maintenance and does not treat suspension as extra time to earn points. Fellow designations require 100 points and are excluded. Any lifetime conversion, expired-credential retest, audit adjustment, or other exception requires separate handling. ASCM's public page does not authorize automatic point carryover, so iTrack does not copy prior-cycle activity.";

const ASQ_COMMON_NOTE =
  "ASQ's current journal-renewal path requires 18 recertification units tied to at least one area of the credential's Body of Knowledge during the assigned three-year period. Use the exact June 30 or December 31 date displayed by ASQ. Professional Development has no cycle maximum; Employment is capped at 10.8 RUs and Giving Back is capped at 6 RUs. Record the RU value calculated under ASQ's current activity table rather than raw attendance or work hours, and retain the listed evidence. Retaking the current exam is an alternative to the journal path. The 60-day journal grace period permits submission of the completed journal, but credit earned after the recertification date belongs to the next cycle. ASQ synchronization can allow one 18-RU journal to maintain multiple synchronized credentials; do not duplicate the same journal unless ASQ confirms the synchronized dates. Retirement, waiver, lapsed, and exam-only paths are outside this standard template.";

const BCSP_COMMON_NOTE =
  `BCSP's current Credentials At-A-Glance document requires 25 recertification points in a five-year CSP or ASP cycle, including 0.5 points from at least five hours of ethics courses for cycles beginning July 1, 2023 or later. Use this template only when My Profile confirms a cycle start on or after that date; an older still-open cycle needs a custom plan without a fabricated ethics minimum. BCSP's current schedule page (${BCSP_RECERTIFICATION_URL}) says cycles normally run July 1 through June 30 of the fifth year and the worksheet is due by July 31. Use the exact dates and accepted point values in My Profile, log points as earned, retain original supporting documentation, and keep annual renewal fees current. This template covers a standard active cycle; retired status, waivers, invalidation, reinstatement, and other Board-approved exceptions require separate review.`;

const GBCI_COMMON_NOTE =
  "GBCI's Credential Maintenance Program Guide uses fixed two-year reporting periods beginning on the exam or enrollment date and ending two years minus one day later. Enter only CE hours eligible under the current activity rules. Education, eligible registered-project participation, and authorship have no cycle maximum; volunteering may supply no more than 50% of the required total. A LEED credential can become inactive for up to 12 months after the reporting period, but late earning shortens the next fixed reporting period. This template models an ordinary active reporting period and does not extend its dates. Do not automatically copy excess hours; rely on the USGBC account for any posted carry-forward. Renewal fees, inactive reactivation, hardship, and expired-retest paths are separate.";

const GIAC_COMMON_NOTE =
  "GIAC's current CPE renewal path requires 36 approved CPEs during the certification's four-year active period. Use the exact dates in the GIAC Account Dashboard, assign and justify every CPE to the specific credential, and retain the required English-language evidence. Current category ceilings are 36 for GIAC/SANS Affiliated Programs, 36 for Career Development Activities, 18 for Other Industry Training, and 12 each for SANS NetWars, Cyber Ranges, Work Experience, and Community Participation. CPE submissions and the maintenance fee are due by expiration; GIAC recommends submitting a complete package at least 30 days early to allow processing, but that lead time is not a separate earning deadline. Retaking the current certification exam is an alternative. An approved renewal extends four years from the current expiration date rather than the submission date. Portfolio-certification rules, abeyance, post-expiration relief, and other exceptions are outside this template; no unconfirmed CPE carryover is applied.";

const RULE_SPECS = [
  {
    id: "ascm-cpim-2026-v1",
    stableKey: "ascm-cpim",
    profession: "Supply Chain Management",
    credentialName:
      "Certified in Planning and Inventory Management (CPIM) — standard maintenance",
    jurisdiction: "Global",
    issuer: "Association for Supply Chain Management",
    totalUnits: 75,
    unitLabel: "ASCM maintenance points",
    cycleMonths: 60,
    sourceUrl: ASCM_MAINTENANCE_URL,
    sourceNote: `CPIM maintenance. ${ASCM_COMMON_NOTE}`,
    reviewTask:
      "Confirm the CPIM designation, non-Fellow status, and exact five-year maintenance dates in ASCM My Account",
    progressTask:
      "Record 75 ASCM-accepted supply-chain maintenance points and retain audit evidence for every claimed value",
    submissionTask:
      "Submit the CPIM maintenance application and fee before suspension, then save the updated ASCM status and deadline",
  },
  {
    id: "ascm-cscp-2026-v1",
    stableKey: "ascm-cscp",
    profession: "Supply Chain Management",
    credentialName:
      "Certified Supply Chain Professional (CSCP) — standard maintenance",
    jurisdiction: "Global",
    issuer: "Association for Supply Chain Management",
    totalUnits: 75,
    unitLabel: "ASCM maintenance points",
    cycleMonths: 60,
    sourceUrl: ASCM_MAINTENANCE_URL,
    sourceNote: `CSCP maintenance. ${ASCM_COMMON_NOTE}`,
    reviewTask:
      "Confirm the CSCP designation, non-Fellow status, and exact five-year maintenance dates in ASCM My Account",
    progressTask:
      "Record 75 ASCM-accepted supply-chain maintenance points and retain audit evidence for every claimed value",
    submissionTask:
      "Submit the CSCP maintenance application and fee before suspension, then save the updated ASCM status and deadline",
  },
  {
    id: "ascm-cltd-2026-v1",
    stableKey: "ascm-cltd",
    profession: "Supply Chain Management",
    credentialName:
      "Certified in Logistics, Transportation and Distribution (CLTD) — standard maintenance",
    jurisdiction: "Global",
    issuer: "Association for Supply Chain Management",
    totalUnits: 75,
    unitLabel: "ASCM maintenance points",
    cycleMonths: 60,
    sourceUrl: ASCM_MAINTENANCE_URL,
    sourceNote: `CLTD maintenance. ${ASCM_COMMON_NOTE}`,
    reviewTask:
      "Confirm the CLTD designation, non-Fellow status, and exact five-year maintenance dates in ASCM My Account",
    progressTask:
      "Record 75 ASCM-accepted supply-chain maintenance points and retain audit evidence for every claimed value",
    submissionTask:
      "Submit the CLTD maintenance application and fee before suspension, then save the updated ASCM status and deadline",
  },
  {
    id: "asq-cqe-2026-v1",
    stableKey: "asq-cqe",
    profession: "Quality",
    credentialName:
      "ASQ Certified Quality Engineer (CQE) — recertification-journal path",
    jurisdiction: "Global",
    issuer: "American Society for Quality",
    totalUnits: 18,
    unitLabel: "ASQ recertification units (RUs)",
    cycleMonths: 36,
    sourceUrl: ASQ_RECERTIFICATION_URL,
    sourceNote: `CQE journal renewal. ${ASQ_COMMON_NOTE}`,
    reviewTask:
      "Confirm the CQE credential, journal path, ASQ-assigned three-year dates, and any synchronized certifications",
    progressTask:
      "Classify and document 18 CQE Body-of-Knowledge RUs within the Employment and Giving Back caps",
    submissionTask:
      "Submit the CQE recertification journal and fee on time and save ASQ approval and the next cycle dates",
  },
  {
    id: "asq-cqa-2026-v1",
    stableKey: "asq-cqa",
    profession: "Quality",
    credentialName:
      "ASQ Certified Quality Auditor (CQA) — recertification-journal path",
    jurisdiction: "Global",
    issuer: "American Society for Quality",
    totalUnits: 18,
    unitLabel: "ASQ recertification units (RUs)",
    cycleMonths: 36,
    sourceUrl: ASQ_RECERTIFICATION_URL,
    sourceNote: `CQA journal renewal. ${ASQ_COMMON_NOTE}`,
    reviewTask:
      "Confirm the CQA credential, journal path, ASQ-assigned three-year dates, and any synchronized certifications",
    progressTask:
      "Classify and document 18 CQA Body-of-Knowledge RUs within the Employment and Giving Back caps",
    submissionTask:
      "Submit the CQA recertification journal and fee on time and save ASQ approval and the next cycle dates",
  },
  {
    id: "asq-cssbb-2026-v1",
    stableKey: "asq-cssbb",
    profession: "Quality",
    credentialName:
      "ASQ Certified Six Sigma Black Belt (CSSBB) — recertification-journal path",
    jurisdiction: "Global",
    issuer: "American Society for Quality",
    totalUnits: 18,
    unitLabel: "ASQ recertification units (RUs)",
    cycleMonths: 36,
    sourceUrl: ASQ_RECERTIFICATION_URL,
    sourceNote: `CSSBB journal renewal. ${ASQ_COMMON_NOTE} ASQ's Six Sigma Green Belt and Yellow Belt credentials are lifetime credentials and are deliberately not represented by this recurring CSSBB template.`,
    reviewTask:
      "Confirm the CSSBB credential, journal path, ASQ-assigned three-year dates, and any synchronized certifications",
    progressTask:
      "Classify and document 18 CSSBB Body-of-Knowledge RUs within the Employment and Giving Back caps",
    submissionTask:
      "Submit the CSSBB recertification journal and fee on time and save ASQ approval and the next cycle dates",
  },
  {
    id: "bcsp-csp-2026-v1",
    stableKey: "bcsp-csp",
    profession: "Occupational Safety",
    credentialName:
      "Certified Safety Professional (CSP) — cycle beginning July 1, 2023 or later",
    jurisdiction: "Global",
    issuer: "Board of Certified Safety Professionals",
    totalUnits: 25,
    unitLabel: "BCSP recertification points",
    cycleMonths: 60,
    sourceUrl: BCSP_AT_A_GLANCE_URL,
    sourceNote: `CSP recertification. ${BCSP_COMMON_NOTE}`,
    effectiveDate: "2023-07-01",
    reviewTask:
      "Confirm active CSP status, annual renewal standing, and the exact July-to-June five-year cycle in My Profile",
    progressTask:
      "Log 25 accepted BCSP points, including 0.5 ethics points from at least five documented course hours",
    submissionTask:
      "Submit the CSP worksheet by the assigned July deadline and save BCSP confirmation and audit-ready evidence",
  },
  {
    id: "bcsp-asp-2026-v1",
    stableKey: "bcsp-asp",
    profession: "Occupational Safety",
    credentialName:
      "Associate Safety Professional (ASP) — cycle beginning July 1, 2023 or later",
    jurisdiction: "Global",
    issuer: "Board of Certified Safety Professionals",
    totalUnits: 25,
    unitLabel: "BCSP recertification points",
    cycleMonths: 60,
    sourceUrl: BCSP_AT_A_GLANCE_URL,
    sourceNote: `ASP recertification. ${BCSP_COMMON_NOTE}`,
    effectiveDate: "2023-07-01",
    reviewTask:
      "Confirm active ASP status, annual renewal standing, and the exact July-to-June five-year cycle in My Profile",
    progressTask:
      "Log 25 accepted BCSP points, including 0.5 ethics points from at least five documented course hours",
    submissionTask:
      "Submit the ASP worksheet by the assigned July deadline and save BCSP confirmation and audit-ready evidence",
  },
  {
    id: "gbci-leed-green-associate-2026-v1",
    stableKey: "gbci-leed-green-associate",
    profession: "Sustainability and Green Building",
    credentialName: "LEED Green Associate — active reporting period",
    jurisdiction: "Global",
    issuer: "Green Business Certification Inc.",
    totalUnits: 15,
    unitLabel: "GBCI CE hours",
    cycleMonths: 24,
    sourceUrl: GBCI_CMP_URL,
    sourceNote: `LEED Green Associate maintenance requires 15 CE hours, including at least 3 LEED-specific hours. ${GBCI_COMMON_NOTE}`,
    reviewTask:
      "Confirm the LEED Green Associate status and exact two-year-minus-one-day reporting period in the USGBC account",
    progressTask:
      "Report 15 eligible CE hours, including 3 LEED-specific hours, with volunteering limited to 7.5 hours",
    submissionTask:
      "Renew while active, pay the applicable fee, and save the updated credential status and reporting-period dates",
  },
  {
    id: "gbci-leed-ap-single-specialty-2026-v1",
    stableKey: "gbci-leed-ap-single-specialty",
    profession: "Sustainability and Green Building",
    credentialName:
      "LEED AP with Specialty — active reporting period, one specialty",
    jurisdiction: "Global",
    issuer: "Green Business Certification Inc.",
    totalUnits: 30,
    unitLabel: "GBCI CE hours",
    cycleMonths: 24,
    sourceUrl: GBCI_CMP_URL,
    sourceNote: `A LEED AP with one specialty requires 30 CE hours, including at least 6 LEED-specific hours directly related to that specialty. ${GBCI_COMMON_NOTE} This template covers exactly one specialty. A holder with multiple specialties needs six additional specialty-specific hours for each additional specialty and must use a custom plan.`,
    reviewTask:
      "Confirm the exact LEED AP specialty, single-specialty scope, and two-year-minus-one-day reporting period",
    progressTask:
      "Report 30 eligible CE hours, including 6 hours specific to the held specialty, with volunteering limited to 15 hours",
    submissionTask:
      "Renew while active, pay the applicable fee, and save the updated specialty status and reporting-period dates",
  },
  {
    id: "icf-acc-2026-v1",
    stableKey: "icf-acc",
    profession: "Professional Coaching",
    credentialName: "Associate Certified Coach (ACC) — standard renewal",
    jurisdiction: "Global",
    issuer: "International Coaching Federation",
    totalUnits: 40,
    unitLabel: "Continuing Coach Education (CCE) credits",
    cycleMonths: 36,
    sourceUrl: ICF_RENEWAL_URL,
    sourceNote: `ICF ACC renewal requires 40 CCE credits in the three years since award or last renewal. At least 24 must be Core Competency credits made up of 10 mentor-coaching hours, at least 3 coaching-ethics credits, and at least 11 other Core Competency credits; the remaining 16 may be Core Competency or Resource Development credit. Under the renewal guide (${ICF_RENEWAL_GUIDE_URL}), complete the 10 mentor-coaching hours over 12 full weeks, with at least 3 hours one-to-one and the remainder one-to-one or in a group of no more than 10 participants. Under the mentor-qualification handbook (${ICF_MENTOR_QUALIFICATION_HANDBOOK_URL}), sessions through December 31, 2026 may use an active PCC or MCC, or an ACC who has renewed at least once; beginning January 1, 2027, ACC renewal mentor coaching must use a holder of the MCQ-ACC or MCQ-PCC qualification. Use the exact credential dates in the ICF account. An application may be submitted up to 10 months early and review commonly takes six to eight weeks. Record only accepted CCE values and retain mentor-coaching and education evidence. Upgrades, hardship, lapsed credentials, and other exceptions require separate review.`,
    reviewTask:
      "Confirm the ACC dates and plan 10 qualified mentor-coaching hours over 12 full weeks, including 3 one-to-one hours",
    progressTask:
      "Complete 40 CCEs with distinct Core components of 10 mentor-coaching, 3 ethics, and 11 other Core credits",
    submissionTask:
      "Submit the ACC renewal early enough for review, pay the fee, and save ICF approval and the new expiration date",
  },
  {
    id: "icf-pcc-2026-v1",
    stableKey: "icf-pcc",
    profession: "Professional Coaching",
    credentialName: "Professional Certified Coach (PCC) — standard renewal",
    jurisdiction: "Global",
    issuer: "International Coaching Federation",
    totalUnits: 40,
    unitLabel: "Continuing Coach Education (CCE) credits",
    cycleMonths: 36,
    sourceUrl: ICF_RENEWAL_URL,
    sourceNote: `ICF PCC renewal requires 40 CCE credits in the three years since award or last renewal. At least 24 must be Core Competency credits, including at least 3 in coaching ethics; the remaining 16 may be Core Competency or Resource Development credit. Under the renewal guide (${ICF_RENEWAL_GUIDE_URL}), accepted mentor coaching may count for no more than 10 Core Competency credits and accepted coaching supervision may count for no more than 10 Core Competency credits. Mentor coaching is not a separate PCC renewal minimum. Under the mentor-qualification handbook (${ICF_MENTOR_QUALIFICATION_HANDBOOK_URL}), beginning January 1, 2027, mentor coaching claimed by a PCC renewal applicant must use a holder of the MCQ-PCC or MCQ-MCC qualification. Use the exact dates in the ICF account. An application may be submitted up to 10 months early and review commonly takes six to eight weeks. Record only accepted CCE values. Upgrades, hardship, lapsed credentials, and other exceptions require separate review.`,
    reviewTask:
      "Confirm the PCC dates, Core and ethics totals, and 2027 qualification level for any claimed mentor coaching",
    progressTask:
      "Complete 40 CCEs with 24 Core and 3 ethics credits, capping mentor coaching and coaching supervision at 10 each",
    submissionTask:
      "Submit the PCC renewal early enough for review, pay the fee, and save ICF approval and the new expiration date",
  },
  {
    id: "internachi-cpi-2026-v1",
    stableKey: "internachi-cpi",
    profession: "Home Inspection",
    credentialName:
      "InterNACHI Certified Professional Inspector (CPI) — annual CE maintenance",
    jurisdiction: "Global",
    issuer: "International Association of Certified Home Inspectors",
    totalUnits: 24,
    unitLabel: "qualifying CE hours",
    cycleMonths: 12,
    sourceUrl: INTERNACHI_CE_URL,
    sourceNote:
      "InterNACHI's CE policy applies to an All-Access Member who has become an InterNACHI Certified Inspector and intends to maintain that certification. Complete 24 CE hours every year, maintain the Official Education Record, abide by the Code of Ethics and applicable Standards of Practice, maintain All-Access membership, and pass the InterNACHI Online Inspector Examination every three years. Use the exact certification, membership, annual CE, and triennial-exam dates shown in the member account rather than assuming they share an anniversary. This is professional-certification maintenance, not a substitute for any state or provincial home-inspector license and CE requirement. Record qualifying external education only with the evidence InterNACHI requires.",
    reviewTask:
      "Confirm active CPI and All-Access membership status plus the account's annual CE and three-year exam dates",
    progressTask:
      "Complete and document 24 qualifying annual CE hours and keep the Official Education Record current",
    submissionTask:
      "Verify membership, ethics and standards commitments, complete the online exam when due, and save current CPI proof",
  },
  {
    id: "ifma-cfm-2026-v1",
    stableKey: "ifma-cfm",
    profession: "Facility Management",
    credentialName:
      "Certified Facility Manager (CFM) — July 2026 activity-based recertification",
    jurisdiction: "Global",
    issuer: "International Facility Management Association",
    totalUnits: 6,
    unitLabel: "qualifying recertification activities",
    cycleMonths: 36,
    sourceUrl: IFMA_CFM_RECERTIFICATION_URL,
    sourceNote:
      "IFMA's July 2026 CFM Recertification Process requires at least six qualifying activities completed during the three-year active period, drawn from at least two of four categories: FM-Related Education, FM Practice, Professional Leadership, and Development of the Profession. The five-activity maximum modeled for each category is the enforceable complement of that two-category rule, not a published per-category ceiling. Record each qualifying activity as one unit only after it meets IFMA's threshold and evidence rule. Examples include one industry conference of at least one day; each five or more hours of relevant education; at least 750 annual hours of FM practice; one year in a qualifying leadership role; or an accepted profession-development activity under the guide. Every six years, or every other renewal, IFMA also requires the Ethics Training Assessment; when CAMP shows it due, complete it and record the qualifying ethics training within FM-Related Education. Upload documentation for each activity. The CFM expires December 31 three years after it is earned; confirm the exact CAMP date. The guide provides a 90-day grace period and a further 90-day late-fee period, after which the credential is cancelled and retesting is required. This template models ordinary active renewal; inactive status and late restoration require separate handling.",
    reviewTask:
      "Confirm the CFM CAMP expiration date, whether the every-other-renewal ethics assessment is due, and a two-category plan",
    progressTask:
      "Record six evidenced activities across at least two categories and complete the ethics assessment when CAMP requires it",
    submissionTask:
      "Submit the CAMP recertification application and payment, allow four to six weeks, and save IFMA confirmation",
  },
  {
    id: "atd-aptd-2026-v1",
    stableKey: "atd-aptd",
    profession: "Talent Development",
    credentialName:
      "Associate Professional in Talent Development (APTD) — recertification-points path",
    jurisdiction: "Global",
    issuer: "Association for Talent Development Certification Institute",
    totalUnits: 40,
    unitLabel: "ATD recertification points",
    cycleMonths: 36,
    sourceUrl: ATD_RECERTIFICATION_URL,
    sourceNote:
      "ATD CI's current APTD points path requires 40 points in the assigned three-year cycle, including at least 15 Continuing Education points. Speaking and Instructing, On-the-Job Experience, Research and Publishing, and Leadership and Recognition are each capped at 15 points; Professional Membership is capped at 10. Activities must align to the Talent Development Capability Model. Use the portal's exact cycle: the first cycle begins the day after exam success and ends at month-end three years later. No points carry over. Retaking the current exam before expiration is an alternative. The renewal application opens only within 90 days of expiration; a 30-day post-expiration grace period permits application submission, after which the holder is decertified. Record the guide-calculated point value and retain audit evidence.",
    reviewTask:
      "Confirm the APTD points path, exact portal dates, and Talent Development Capability Model alignment",
    progressTask:
      "Earn 40 classified points, including 15 Continuing Education points, without exceeding any activity-category cap",
    submissionTask:
      "Submit the APTD application and fee within its 90-day window and save approval and the next expiration date",
  },
  {
    id: "atd-cptd-2026-v1",
    stableKey: "atd-cptd",
    profession: "Talent Development",
    credentialName:
      "Certified Professional in Talent Development (CPTD) — recertification-points path",
    jurisdiction: "Global",
    issuer: "Association for Talent Development Certification Institute",
    totalUnits: 60,
    unitLabel: "ATD recertification points",
    cycleMonths: 36,
    sourceUrl: ATD_RECERTIFICATION_URL,
    sourceNote:
      "ATD CI's current CPTD points path requires 60 points in the assigned three-year cycle, including at least 20 Continuing Education points. Speaking and Instructing, On-the-Job Experience, Research and Publishing, and Leadership and Recognition are each capped at 20 points; Professional Membership is capped at 15. Activities must align to the Talent Development Capability Model. Use the portal's exact cycle: the first cycle begins the day after exam success and ends at month-end three years later. No points carry over. Retaking the current exam before expiration is an alternative. The renewal application opens only within 90 days of expiration; a 30-day post-expiration grace period permits application submission, after which the holder is decertified. Record the guide-calculated point value and retain audit evidence.",
    reviewTask:
      "Confirm the CPTD points path, exact portal dates, and Talent Development Capability Model alignment",
    progressTask:
      "Earn 60 classified points, including 20 Continuing Education points, without exceeding any activity-category cap",
    submissionTask:
      "Submit the CPTD application and fee within its 90-day window and save approval and the next expiration date",
  },
  {
    id: "giac-gsec-2026-v1",
    stableKey: "giac-gsec",
    profession: "Cybersecurity",
    credentialName:
      "GIAC Security Essentials (GSEC) — standard CPE renewal path",
    jurisdiction: "Global",
    issuer: "GIAC",
    totalUnits: 36,
    unitLabel: "GIAC-approved CPEs",
    cycleMonths: 48,
    sourceUrl: GIAC_RENEWAL_URL,
    sourceNote: `GSEC renewal. ${GIAC_COMMON_NOTE}`,
    reviewTask:
      "Confirm the GSEC credential, CPE path, and exact four-year dates in the GIAC Account Dashboard",
    progressTask:
      "Assign and justify 36 approved GSEC CPEs using the current category ceilings and English-language evidence",
    submissionTask:
      "Register the GSEC renewal, submit complete CPEs and payment with GIAC's recommended 30-day processing lead, and save approval",
  },
  {
    id: "giac-gcih-2026-v1",
    stableKey: "giac-gcih",
    profession: "Cybersecurity",
    credentialName:
      "GIAC Certified Incident Handler (GCIH) — standard CPE renewal path",
    jurisdiction: "Global",
    issuer: "GIAC",
    totalUnits: 36,
    unitLabel: "GIAC-approved CPEs",
    cycleMonths: 48,
    sourceUrl: GIAC_RENEWAL_URL,
    sourceNote: `GCIH renewal. ${GIAC_COMMON_NOTE}`,
    reviewTask:
      "Confirm the GCIH credential, CPE path, and exact four-year dates in the GIAC Account Dashboard",
    progressTask:
      "Assign and justify 36 approved GCIH CPEs using the current category ceilings and English-language evidence",
    submissionTask:
      "Register the GCIH renewal, submit complete CPEs and payment with GIAC's recommended 30-day processing lead, and save approval",
  },
  {
    id: "iapp-cipp-us-2026-v1",
    stableKey: "iapp-cipp-us",
    profession: "Privacy",
    credentialName:
      "Certified Information Privacy Professional/United States (CIPP/US) — standard maintenance term",
    jurisdiction: "Global",
    issuer: "International Association of Privacy Professionals",
    totalUnits: 20,
    unitLabel: "IAPP-approved CPE credits",
    cycleMonths: 24,
    sourceUrl: IAPP_CPE_POLICY_URL,
    sourceNote: `IAPP CPE Policy v3.3.1, approved and effective April 7, 2026, requires 20 CPEs by the end of each two-year certification term and applies per-activity ceilings to specified speaking, teaching, training, board-service, academic-class, and reading sources. Use the exact CIPP/US term dates in MyIAPP, classify every activity under the policy, and submit only education relevant to the CIPP/US designation at the value IAPP accepts. IAPP recommends rolling submission within 90 days of an activity. Relevant activities may apply to multiple IAPP credentials. Up to 10 surplus CPEs earned in the final six months may carry to the next term, but iTrack does not infer or copy them; record only carryover confirmed in MyIAPP with evidence. Maintain continuous IAPP membership or purchase the Certification Maintenance Fee described on the current maintenance page (${IAPP_MAINTENANCE_URL}). A suspended credential, aligned multi-credential term, fee interruption, reinstatement, or policy exception requires direct IAPP review.`,
    effectiveDate: "2026-04-07",
    reviewTask:
      "Confirm the CIPP/US term dates, financial coverage, activity classifications, and any confirmed carryover",
    progressTask:
      "Classify and submit 20 relevant CPEs within Policy v3.3.1 activity caps and retain evidence",
    submissionTask:
      "Verify the full term's financial coverage and 20 accepted CPEs, then save the renewed CIPP/US status",
  },
  {
    id: "ace-certified-personal-trainer-2026-v1",
    stableKey: "ace-certified-personal-trainer",
    profession: "Fitness and Personal Training",
    credentialName:
      "ACE Certified Personal Trainer — standard two-year renewal",
    jurisdiction: "Global",
    issuer: "American Council on Exercise",
    totalUnits: 2,
    unitLabel: "ACE continuing education credits (CECs)",
    cycleMonths: 24,
    sourceUrl: ACE_HANDBOOK_URL,
    sourceNote: `ACE Certified Personal Trainer renewal requires 20 hours, equal to 2.0 ACE-approved CECs, during the exact two-year cycle shown in My ACE. At least one hour, equal to 0.1 CEC, must address Professional Conduct and Ethics. Maintain a current adult CPR certificate that includes a hands-on skills check conducted in person or virtually; AED is also required for credential holders in the United States and Canada, while the handbook states adult CPR only for holders elsewhere. The credential is a separate renewal checkpoint. ACE's current recertification page (${ACE_RECERTIFICATION_URL}) allows up to 0.4 CECs from approved CPR/AED education. Alternative-source ceilings are 0.5 for presentations, 0.5 for authorship, 0.2 for clinical observation, 0.2 for an internship, and 0.1 for community outreach. Enter ACE course credits from the account or the approved provider's course number and awarded value. A non-approved course counts only after a successful petition. The same course cannot be repeated for renewal, and excess CECs do not carry to another cycle. Retain CE documentation for the recommended four years. This template covers the NCCA-accredited ACE Personal Trainer certification, not a superseded or non-renewable certificate variant. Late renewal, reinstatement, and multi-credential fee handling require separate review.`,
    effectiveDate: "2023-09-13",
    reviewTask:
      "Confirm the ACE credential, My ACE dates, region, and current adult CPR with hands-on skills check and AED if required",
    progressTask:
      "Complete 2.0 classified CECs, including 0.1 ethics, without exceeding alternative-activity caps or repeating a course",
    submissionTask:
      "Update CPR and region-required AED, enter all CECs, submit the affirmation and fee, and save the renewed credential",
  },
] as const satisfies readonly CredentialSpec[];

function toRuleSetBinding(spec: CredentialSpec): RuleSetSeedBinding {
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

function ascmCategories(
  ruleSetId:
    | "ascm-cpim-2026-v1"
    | "ascm-cscp-2026-v1"
    | "ascm-cltd-2026-v1",
): readonly CategorySeedBinding[] {
  const prefix = ruleSetId.replace(/-v1$/, "");
  return [
    [
      `${prefix}-accepted-maintenance`,
      ruleSetId,
      "ASCM-Accepted Supply-Chain Maintenance Points",
      75,
      "minimum",
      "independent",
      null,
      "always",
      "All 75 points must come from activities ASCM accepts as relevant professional development for the held APICS certification. Record the awarded or handbook-calculated point value, not an assumed clock-hour conversion.",
      null,
      0,
    ],
  ];
}

function asqCategories(
  ruleSetId:
    | "asq-cqe-2026-v1"
    | "asq-cqa-2026-v1"
    | "asq-cssbb-2026-v1",
): readonly CategorySeedBinding[] {
  const prefix = ruleSetId.replace(/-v1$/, "");
  const credential =
    ruleSetId === "asq-cqe-2026-v1"
      ? "CQE"
      : ruleSetId === "asq-cqa-2026-v1"
        ? "CQA"
        : "CSSBB";
  const group = `ASQ ${credential} RU source`;
  const givingBackId = `${prefix}-giving-back`;
  return [
    [
      `${prefix}-professional-development`,
      ruleSetId,
      "Professional Development",
      0,
      "informational",
      "independent",
      null,
      "always",
      "Classify certification, continuing education, publishing, presenting, and meeting or event RUs here. ASQ currently places no cycle maximum on this source, but each activity must use its published RU formula and relate to the credential's Body of Knowledge.",
      group,
      0,
    ],
    [
      `${prefix}-employment`,
      ruleSetId,
      "Employment",
      10.8,
      "maximum",
      "independent",
      null,
      "optional",
      "At most 10.8 RUs may count from qualifying employment. ASQ currently awards 0.3 RU per full-time month or 0.15 RU per part-time month when work relates to the credential's Body of Knowledge.",
      group,
      1,
    ],
    [
      givingBackId,
      ruleSetId,
      "Giving Back — Combined Cap",
      6,
      "maximum",
      "independent",
      null,
      "optional",
      "Aggregate parent: at most 6 RUs may count from all Giving Back sources combined. Classify the activity with the applicable child source instead of selecting this parent directly, so both its individual sublimit and this combined cap can be calculated.",
      null,
      2,
    ],
    [
      `${prefix}-volunteering`,
      ruleSetId,
      "Giving Back — Volunteering",
      1,
      "maximum",
      "nested",
      givingBackId,
      "optional",
      "At most 1 RU may count from volunteering, currently calculated at 0.1 RU per qualifying hour. These units also roll into the 6-RU combined Giving Back cap.",
      group,
      3,
    ],
    [
      `${prefix}-professional-membership`,
      ruleSetId,
      "Giving Back — Professional Membership",
      1.5,
      "maximum",
      "nested",
      givingBackId,
      "optional",
      "At most 1.5 RUs may count from professional membership, currently calculated at 0.5 RU per qualifying year. These units also roll into the 6-RU combined Giving Back cap.",
      group,
      4,
    ],
    [
      `${prefix}-mentoring`,
      ruleSetId,
      "Giving Back — Mentoring",
      1.5,
      "maximum",
      "nested",
      givingBackId,
      "optional",
      "At most 1.5 RUs may count from mentoring, currently calculated at 0.1 RU per qualifying hour. These units also roll into the 6-RU combined Giving Back cap.",
      group,
      5,
    ],
    [
      `${prefix}-committees`,
      ruleSetId,
      "Giving Back — Committee Service",
      4.5,
      "maximum",
      "nested",
      givingBackId,
      "optional",
      "At most 4.5 RUs may count from qualifying committee service, currently calculated at 1.5 RUs per qualifying year. These units also roll into the 6-RU combined Giving Back cap.",
      group,
      6,
    ],
  ];
}

function bcspCategories(
  ruleSetId: "bcsp-csp-2026-v1" | "bcsp-asp-2026-v1",
): readonly CategorySeedBinding[] {
  const prefix = ruleSetId.replace(/-v1$/, "");
  return [
    [
      `${prefix}-ethics`,
      ruleSetId,
      "Ethics Courses",
      0.5,
      "minimum",
      "overlapping",
      null,
      "always",
      "Complete at least five hours of ethics courses during the cycle and claim the resulting 0.5 BCSP recertification points within the 25-point total. Retain completion evidence for audit.",
      null,
      0,
    ],
  ];
}

function leedCategories(
  ruleSetId:
    | "gbci-leed-green-associate-2026-v1"
    | "gbci-leed-ap-single-specialty-2026-v1",
): readonly CategorySeedBinding[] {
  const isAssociate = ruleSetId === "gbci-leed-green-associate-2026-v1";
  const prefix = ruleSetId.replace(/-v1$/, "");
  const group = `GBCI ${ruleSetId} CE activity type`;
  const volunteeringCap = isAssociate ? 7.5 : 15;
  const specificMinimum = isAssociate ? 3 : 6;
  return [
    [
      `${prefix}-education`,
      ruleSetId,
      "Education Courses",
      0,
      "informational",
      "independent",
      null,
      "always",
      "Eligible education has no cycle maximum. Record the GBCI-eligible duration and classify it as LEED-specific separately only when its content meets the credential's rating-system rule.",
      group,
      0,
    ],
    [
      `${prefix}-project-participation`,
      ruleSetId,
      "Eligible Project Participation",
      0,
      "informational",
      "independent",
      null,
      "optional",
      "Eligible registered-project participation has no cycle maximum. Apply the current per-project and per-measure values and exclusions in the CMP Guide.",
      group,
      1,
    ],
    [
      `${prefix}-authorship`,
      ruleSetId,
      "Authorship",
      0,
      "informational",
      "independent",
      null,
      "optional",
      "Eligible technical authorship has no cycle maximum. The current guide awards 3 CE hours per published article and 10 per published book.",
      group,
      2,
    ],
    [
      `${prefix}-volunteering`,
      ruleSetId,
      "Volunteering",
      volunteeringCap,
      "maximum",
      "independent",
      null,
      "optional",
      `Volunteering may supply no more than half of the credential total, so at most ${volunteeringCap} CE hours count in this reporting period.`,
      group,
      3,
    ],
    [
      `${prefix}-leed-specific`,
      ruleSetId,
      isAssociate
        ? "LEED-Specific CE"
        : "LEED-Specific CE for the Held Specialty",
      specificMinimum,
      "minimum",
      "overlapping",
      null,
      "always",
      isAssociate
        ? "At least 3 of the 15 CE hours must explicitly connect to a current LEED rating system. Additional LEED-specific hours may count toward the remaining total."
        : "At least 6 of the 30 CE hours must directly relate to the exact LEED AP specialty held. Other LEED rating-system content is general CE for this specialty.",
      null,
      4,
    ],
  ];
}

function icfCategories(
  ruleSetId: "icf-acc-2026-v1" | "icf-pcc-2026-v1",
): readonly CategorySeedBinding[] {
  const prefix = ruleSetId.replace(/-v1$/, "");
  const coreId = `${prefix}-core-competencies`;
  if (ruleSetId === "icf-acc-2026-v1") {
    const sourceGroup = "ICF ACC CCE source";
    const nonMentorCoreGroup = "ICF ACC non-mentor Core component";
    return [
      [
        coreId,
        ruleSetId,
        "Core Competencies",
        24,
        "minimum",
        "overlapping",
        null,
        "always",
        "At least 24 of the 40 CCE credits must be accepted as Core Competency credit. Mentor Coaching, Coaching Ethics, and Other Core Competency Education roll into this minimum.",
        null,
        0,
      ],
      [
        `${prefix}-mentor-coaching`,
        ruleSetId,
        "Mentor Coaching",
        10,
        "maximum",
        "nested",
        coreId,
        "always",
        "Classify all qualified mentor-coaching hours here. The 10-credit cap, paired with the 30-credit Non-Mentor CCE cap and 40-credit total, enforces exactly 10 mentor-coaching hours. Complete them over 12 full weeks, including at least 3 one-to-one hours; remaining hours may be one-to-one or in a group of no more than 10 participants. Through December 31, 2026 use an active PCC/MCC or an ACC renewed at least once; beginning January 1, 2027 use an MCQ-ACC or MCQ-PCC holder.",
        sourceGroup,
        1,
      ],
      [
        `${prefix}-non-mentor-cce`,
        ruleSetId,
        "Non-Mentor CCE",
        30,
        "maximum",
        "independent",
        null,
        "always",
        "Classify every CCE credit other than Mentor Coaching here. At most 30 of the 40 total credits may be non-mentor CCE, which combines with the 10-credit Mentor Coaching cap to preserve the required 10-hour mentor component.",
        sourceGroup,
        2,
      ],
      [
        `${prefix}-coaching-ethics`,
        ruleSetId,
        "Coaching Ethics",
        3,
        "minimum",
        "nested",
        coreId,
        "always",
        "At least 3 non-mentor Core Competency credits must address coaching ethics. Select this component in addition to the Non-Mentor CCE source classifier.",
        nonMentorCoreGroup,
        3,
      ],
      [
        `${prefix}-other-core-competency-education`,
        ruleSetId,
        "Other Core Competency Education",
        11,
        "minimum",
        "nested",
        coreId,
        "always",
        "At least 11 non-mentor Core Competency credits must be distinct from Coaching Ethics. Select this component in addition to the Non-Mentor CCE source classifier.",
        nonMentorCoreGroup,
        4,
      ],
    ];
  }

  const sourceGroup = "ICF PCC CCE source";
  return [
    [
      coreId,
      ruleSetId,
      "Core Competencies",
      24,
      "minimum",
      "overlapping",
      null,
      "always",
      "At least 24 of the 40 CCE credits must be accepted by ICF as Core Competency credit. Accepted Mentor Coaching and Coaching Supervision roll into this minimum.",
      null,
      0,
    ],
    [
      `${prefix}-coaching-ethics`,
      ruleSetId,
      "Coaching Ethics",
      3,
      "minimum",
      "nested",
      coreId,
      "always",
      "At least 3 Core Competency credits must address coaching ethics. These credits sit within both the 24-credit Core Competency minimum and the 40-credit total.",
      null,
      1,
    ],
    [
      `${prefix}-other-cce`,
      ruleSetId,
      "Other CCE",
      0,
      "informational",
      "independent",
      null,
      "optional",
      "Use this source classifier for accepted Core Competency or Resource Development CCE that is neither Mentor Coaching nor Coaching Supervision. Add the Coaching Ethics tag when applicable.",
      sourceGroup,
      2,
    ],
    [
      `${prefix}-mentor-coaching`,
      ruleSetId,
      "Mentor Coaching",
      10,
      "maximum",
      "nested",
      coreId,
      "optional",
      "At most 10 accepted mentor-coaching credits may count as Core Competency professional development. Beginning January 1, 2027, a PCC renewal applicant claiming mentor coaching must use an MCQ-PCC or MCQ-MCC holder.",
      sourceGroup,
      3,
    ],
    [
      `${prefix}-coaching-supervision`,
      ruleSetId,
      "Coaching Supervision",
      10,
      "maximum",
      "nested",
      coreId,
      "optional",
      "At most 10 accepted coaching-supervision credits may count as Core Competency professional development during the renewal cycle.",
      sourceGroup,
      4,
    ],
  ];
}

function ifmaCategories(): readonly CategorySeedBinding[] {
  const ruleSetId = "ifma-cfm-2026-v1";
  const group = "IFMA CFM recertification category";
  const sharedNote =
    "The CFM needs six qualifying activities across at least two IFMA categories. The modeled maximum of five in any one category enforces that distribution and is not an IFMA-published category ceiling. Record one unit only when the activity meets the category threshold and has uploadable evidence.";
  return [
    [
      "ifma-cfm-2026-fm-education",
      ruleSetId,
      "FM-Related Education",
      5,
      "maximum",
      "independent",
      null,
      "optional",
      `${sharedNote} Each qualifying conference of at least one day or each aggregate of at least five relevant education hours counts as one activity under the current guide.`,
      group,
      0,
    ],
    [
      "ifma-cfm-2026-fm-practice",
      ruleSetId,
      "FM Practice",
      5,
      "maximum",
      "independent",
      null,
      "optional",
      `${sharedNote} At least 750 hours of facility-management practice or consulting in a calendar year counts as one activity.`,
      group,
      1,
    ],
    [
      "ifma-cfm-2026-professional-leadership",
      ruleSetId,
      "Professional Leadership",
      5,
      "maximum",
      "independent",
      null,
      "optional",
      `${sharedNote} One year in a qualifying association leadership, committee, mentoring, advisory, or editorial role counts as one activity.`,
      group,
      2,
    ],
    [
      "ifma-cfm-2026-development-profession",
      ruleSetId,
      "Development of the Profession",
      5,
      "maximum",
      "independent",
      null,
      "optional",
      `${sharedNote} Apply the current guide's accepted thresholds for presentations, publications, teaching, research, standards work, and other profession-development activities.`,
      group,
      3,
    ],
    [
      "ifma-cfm-2026-ethics-assessment",
      ruleSetId,
      "Ethics Training Assessment",
      1,
      "minimum",
      "nested",
      "ifma-cfm-2026-fm-education",
      "conditional",
      "Required every six years, or every other renewal. Confirm the cadence in CAMP. When it applies, complete the Ethics Training Assessment and classify its qualifying training here as an FM-Related Education activity.",
      group,
      4,
    ],
  ];
}

function atdCategories(
  ruleSetId: "atd-aptd-2026-v1" | "atd-cptd-2026-v1",
): readonly CategorySeedBinding[] {
  const isAptd = ruleSetId === "atd-aptd-2026-v1";
  const prefix = ruleSetId.replace(/-v1$/, "");
  const group = `ATD ${isAptd ? "APTD" : "CPTD"} recertification activity`;
  const educationMinimum = isAptd ? 15 : 20;
  const commonCap = isAptd ? 15 : 20;
  const membershipCap = isAptd ? 10 : 15;
  return [
    [
      `${prefix}-continuing-education`,
      ruleSetId,
      "Continuing Education",
      educationMinimum,
      "minimum",
      "independent",
      null,
      "always",
      `At least ${educationMinimum} points must come from learning activities aligned with the Talent Development Capability Model. Use the guide's contact-hour, CEU, academic-credit, or reading conversion and retain evidence.`,
      group,
      0,
    ],
    [
      `${prefix}-speaking-instructing`,
      ruleSetId,
      "Speaking and Instructing",
      commonCap,
      "maximum",
      "independent",
      null,
      "optional",
      `At most ${commonCap} points may count from qualifying speaking and instructing under the current guide.`,
      group,
      1,
    ],
    [
      `${prefix}-on-the-job`,
      ruleSetId,
      "On-the-Job Experience",
      commonCap,
      "maximum",
      "independent",
      null,
      "optional",
      `At most ${commonCap} points may count from qualifying on-the-job talent-development experience.`,
      group,
      2,
    ],
    [
      `${prefix}-research-publishing`,
      ruleSetId,
      "Research and Publishing",
      commonCap,
      "maximum",
      "independent",
      null,
      "optional",
      `At most ${commonCap} points may count from qualifying talent-development research and publishing.`,
      group,
      3,
    ],
    [
      `${prefix}-leadership-recognition`,
      ruleSetId,
      "Leadership and Recognition",
      commonCap,
      "maximum",
      "independent",
      null,
      "optional",
      `At most ${commonCap} points may count from qualifying leadership, volunteer, award, and recognition activities.`,
      group,
      4,
    ],
    [
      `${prefix}-professional-membership`,
      ruleSetId,
      "Professional Membership",
      membershipCap,
      "maximum",
      "independent",
      null,
      "optional",
      `At most ${membershipCap} points may count from eligible ATD and other talent-development professional memberships. Use the guide's per-completed-year values.`,
      group,
      5,
    ],
  ];
}

function giacCategories(
  ruleSetId: "giac-gsec-2026-v1" | "giac-gcih-2026-v1",
): readonly CategorySeedBinding[] {
  const prefix = ruleSetId.replace(/-v1$/, "");
  const credential = ruleSetId === "giac-gsec-2026-v1" ? "GSEC" : "GCIH";
  const group = `GIAC ${credential} CPE category`;
  return [
    [
      `${prefix}-giac-sans`,
      ruleSetId,
      "GIAC/SANS Affiliated Programs",
      0,
      "informational",
      "independent",
      null,
      "optional",
      "GIAC/SANS affiliated programs may supply all 36 CPEs. Use the dashboard-awarded value and required evidence.",
      group,
      0,
    ],
    [
      `${prefix}-career-development`,
      ruleSetId,
      "Career Development Activities",
      0,
      "informational",
      "independent",
      null,
      "optional",
      "Qualifying accredited training, certifications, graduate courses, and published technical work may supply all 36 CPEs when GIAC accepts their relevance and evidence.",
      group,
      1,
    ],
    [
      `${prefix}-industry-training`,
      ruleSetId,
      "Other Industry Training",
      18,
      "maximum",
      "independent",
      null,
      "optional",
      "At most 18 CPEs may count from other qualifying industry training and conferences.",
      group,
      2,
    ],
    [
      `${prefix}-netwars`,
      ruleSetId,
      "SANS NetWars",
      12,
      "maximum",
      "independent",
      null,
      "optional",
      "At most 12 CPEs may count from SANS NetWars tournament or continuous activities.",
      group,
      3,
    ],
    [
      `${prefix}-cyber-ranges`,
      ruleSetId,
      "Cyber Ranges",
      12,
      "maximum",
      "independent",
      null,
      "optional",
      "At most 12 CPEs may count from qualifying hands-on cyber-range or capture-the-flag activities.",
      group,
      4,
    ],
    [
      `${prefix}-work-experience`,
      ruleSetId,
      "Work Experience",
      12,
      "maximum",
      "independent",
      null,
      "optional",
      "At most 12 CPEs may count from relevant technical and management work experience.",
      group,
      5,
    ],
    [
      `${prefix}-community-participation`,
      ruleSetId,
      "Community Participation",
      12,
      "maximum",
      "independent",
      null,
      "optional",
      "At most 12 CPEs may count from qualifying webcasts, exam development, articles, and other GIAC community participation.",
      group,
      6,
    ],
  ];
}

function iappCategories(): readonly CategorySeedBinding[] {
  const ruleSetId = "iapp-cipp-us-2026-v1";
  const parentId = "iapp-cipp-us-2026-relevant-cpe";
  const group = "IAPP CIPP/US CPE activity type";
  return [
    [
      parentId,
      ruleSetId,
      "CIPP/US-Relevant Continuing Privacy Education",
      20,
      "minimum",
      "independent",
      null,
      "always",
      "All 20 CPEs must be relevant to the CIPP/US designation and accepted in MyIAPP for this term. Activity-type children roll into this total; record only the posted value and do not infer carryover.",
      null,
      0,
    ],
    [
      "iapp-cipp-us-2026-other-policy-activity",
      ruleSetId,
      "Other Policy Activity Without a Term Cap",
      0,
      "informational",
      "nested",
      parentId,
      "optional",
      "Use only for Policy v3.3.1 activities whose maximum is listed as N/A, including attendance at IAPP conferences, KnowledgeNet meetings, or live/recorded webinars; qualifying coaching or mentoring; general publications; books or book chapters; and qualifying non-IAPP event attendance. Do not use this option to bypass a listed cap.",
      group,
      1,
    ],
    [
      "iapp-cipp-us-2026-iapp-event-speaker",
      ruleSetId,
      "IAPP Event, KnowledgeNet, or Online-Course Speaker",
      12,
      "maximum",
      "nested",
      parentId,
      "optional",
      "At most 12 CPEs may count during the certification term from speaking at an IAPP event or KnowledgeNet meeting, or presenting an IAPP online course, under Policy v3.3.1.",
      group,
      2,
    ],
    [
      "iapp-cipp-us-2026-iapp-training-instructor",
      ruleSetId,
      "IAPP Training Instructor",
      16,
      "maximum",
      "nested",
      parentId,
      "optional",
      "At most 16 CPEs may count during the certification term from instructing IAPP training under Policy v3.3.1.",
      group,
      3,
    ],
    [
      "iapp-cipp-us-2026-iapp-training-attendee",
      ruleSetId,
      "IAPP Training Attendee",
      13,
      "maximum",
      "nested",
      parentId,
      "optional",
      "At most 13 CPEs may count during the certification term from attending IAPP training under Policy v3.3.1.",
      group,
      4,
    ],
    [
      "iapp-cipp-us-2026-major-board-service",
      ruleSetId,
      "Major IAPP Board Service",
      10,
      "maximum",
      "nested",
      parentId,
      "optional",
      "At most 10 CPEs may count during the certification term from service on an IAPP Board of Directors or other major board listed by Policy v3.3.1.",
      group,
      5,
    ],
    [
      "iapp-cipp-us-2026-other-advisory-board",
      ruleSetId,
      "Other IAPP Advisory Board Service",
      6,
      "maximum",
      "nested",
      parentId,
      "optional",
      "At most 6 CPEs may count during the certification term from other qualifying IAPP advisory-board service under Policy v3.3.1.",
      group,
      6,
    ],
    [
      "iapp-cipp-us-2026-knowledgenet-chair",
      ruleSetId,
      "KnowledgeNet Chapter Chair Service",
      6,
      "maximum",
      "nested",
      parentId,
      "optional",
      "At most 6 CPEs may count during the certification term from qualifying KnowledgeNet chapter-chair service under Policy v3.3.1.",
      group,
      7,
    ],
    [
      "iapp-cipp-us-2026-academic-class",
      ruleSetId,
      "Academic Class",
      12,
      "maximum",
      "nested",
      parentId,
      "optional",
      "At most 12 CPEs may count during the certification term from a qualifying academic class under Policy v3.3.1.",
      group,
      8,
    ],
    [
      "iapp-cipp-us-2026-reading",
      ruleSetId,
      "Reading",
      5,
      "maximum",
      "nested",
      parentId,
      "optional",
      "At most 5 CPEs may count during the certification term from qualifying reading under Policy v3.3.1.",
      group,
      9,
    ],
    [
      "iapp-cipp-us-2026-non-iapp-speaker",
      ruleSetId,
      "Non-IAPP Event Speaker",
      12,
      "maximum",
      "nested",
      parentId,
      "optional",
      "At most 12 CPEs may count during the certification term from speaking at qualifying non-IAPP events under Policy v3.3.1.",
      group,
      10,
    ],
    [
      "iapp-cipp-us-2026-non-iapp-training-instructor",
      ruleSetId,
      "Non-IAPP Training Instructor",
      16,
      "maximum",
      "nested",
      parentId,
      "optional",
      "At most 16 CPEs may count during the certification term from instructing qualifying non-IAPP training under Policy v3.3.1.",
      group,
      11,
    ],
    [
      "iapp-cipp-us-2026-non-iapp-training-attendee",
      ruleSetId,
      "Non-IAPP Training Attendee",
      12,
      "maximum",
      "nested",
      parentId,
      "optional",
      "At most 12 CPEs may count during the certification term from attending qualifying non-IAPP training under Policy v3.3.1.",
      group,
      12,
    ],
  ];
}

function aceCategories(): readonly CategorySeedBinding[] {
  const ruleSetId = "ace-certified-personal-trainer-2026-v1";
  const group = "ACE Personal Trainer CEC source";
  return [
    [
      "ace-certified-personal-trainer-2026-other-eligible-education",
      ruleSetId,
      "Other Eligible Education",
      0,
      "informational",
      "independent",
      null,
      "optional",
      "Use for ACE-approved or successfully petitioned education and other accepted sources that are not subject to one of the separately modeled alternative-source caps. Enter only the value posted or awarded by ACE.",
      group,
      0,
    ],
    [
      "ace-certified-personal-trainer-2026-cpr-aed-education",
      ruleSetId,
      "CPR/AED Education",
      0.4,
      "maximum",
      "independent",
      null,
      "optional",
      "At most 0.4 CECs may count from approved CPR/AED education. This credit cap does not replace the separate requirement for a current adult CPR certificate with a hands-on skills check or the AED requirement for holders in the United States and Canada.",
      group,
      1,
    ],
    [
      "ace-certified-personal-trainer-2026-presentations",
      ruleSetId,
      "Presentations",
      0.5,
      "maximum",
      "independent",
      null,
      "optional",
      "At most 0.5 CECs may count from qualifying professional presentations during the renewal cycle.",
      group,
      2,
    ],
    [
      "ace-certified-personal-trainer-2026-authorship",
      ruleSetId,
      "Authorship",
      0.5,
      "maximum",
      "independent",
      null,
      "optional",
      "At most 0.5 CECs may count from qualifying authorship during the renewal cycle.",
      group,
      3,
    ],
    [
      "ace-certified-personal-trainer-2026-clinical-observation",
      ruleSetId,
      "Clinical Observation",
      0.2,
      "maximum",
      "independent",
      null,
      "optional",
      "At most 0.2 CECs may count from qualifying clinical observation during the renewal cycle.",
      group,
      4,
    ],
    [
      "ace-certified-personal-trainer-2026-internship",
      ruleSetId,
      "Internship",
      0.2,
      "maximum",
      "independent",
      null,
      "optional",
      "At most 0.2 CECs may count from a qualifying internship during the renewal cycle.",
      group,
      5,
    ],
    [
      "ace-certified-personal-trainer-2026-community-outreach",
      ruleSetId,
      "Community Outreach",
      0.1,
      "maximum",
      "independent",
      null,
      "optional",
      "At most 0.1 CEC may count from qualifying community outreach during the renewal cycle.",
      group,
      6,
    ],
    [
      "ace-certified-personal-trainer-2026-ethics",
      ruleSetId,
      "Professional Conduct and Ethics",
      0.1,
      "minimum",
      "overlapping",
      null,
      "always",
      "At least 0.1 of the 2.0 CECs, equal to one approved hour, must address ACE Professional Conduct and Ethics. Add this tag alongside the applicable CEC source classification.",
      null,
      7,
    ],
  ];
}

export const PROFESSIONAL_CERTIFICATIONS_RULE_SET_SEED_BINDINGS =
  RULE_SPECS.map(toRuleSetBinding);

export const PROFESSIONAL_CERTIFICATIONS_CATEGORY_SEED_BINDINGS = [
  ...ascmCategories("ascm-cpim-2026-v1"),
  ...ascmCategories("ascm-cscp-2026-v1"),
  ...ascmCategories("ascm-cltd-2026-v1"),
  ...asqCategories("asq-cqe-2026-v1"),
  ...asqCategories("asq-cqa-2026-v1"),
  ...asqCategories("asq-cssbb-2026-v1"),
  ...bcspCategories("bcsp-csp-2026-v1"),
  ...bcspCategories("bcsp-asp-2026-v1"),
  ...leedCategories("gbci-leed-green-associate-2026-v1"),
  ...leedCategories("gbci-leed-ap-single-specialty-2026-v1"),
  ...icfCategories("icf-acc-2026-v1"),
  ...icfCategories("icf-pcc-2026-v1"),
  [
    "internachi-cpi-2026-qualifying-ce",
    "internachi-cpi-2026-v1",
    "Qualifying Annual Inspector CE",
    24,
    "minimum",
    "independent",
    null,
    "always",
    "Complete 24 qualifying CE hours every year and keep the Official Education Record current. This annual total does not replace the separate three-year online examination or any state/provincial license requirement.",
    null,
    0,
  ],
  ...ifmaCategories(),
  ...atdCategories("atd-aptd-2026-v1"),
  ...atdCategories("atd-cptd-2026-v1"),
  ...giacCategories("giac-gsec-2026-v1"),
  ...giacCategories("giac-gcih-2026-v1"),
  ...iappCategories(),
  ...aceCategories(),
] as const satisfies readonly CategorySeedBinding[];

export const PROFESSIONAL_CERTIFICATIONS_RENEWAL_TASK_COPY_BINDINGS =
  RULE_SPECS.map(
    (spec): RenewalTaskCopyBinding => [
      spec.id,
      spec.reviewTask,
      spec.progressTask,
      spec.submissionTask,
    ],
  );

export const PROFESSIONAL_CERTIFICATIONS_MAXIMUM_CLASSIFICATION_RULE_SET_IDS = [
  "asq-cqe-2026-v1",
  "asq-cqa-2026-v1",
  "asq-cssbb-2026-v1",
  "gbci-leed-green-associate-2026-v1",
  "gbci-leed-ap-single-specialty-2026-v1",
  "atd-aptd-2026-v1",
  "atd-cptd-2026-v1",
  "giac-gsec-2026-v1",
  "giac-gcih-2026-v1",
  "ifma-cfm-2026-v1",
  "icf-acc-2026-v1",
  "icf-pcc-2026-v1",
  "iapp-cipp-us-2026-v1",
  "ace-certified-personal-trainer-2026-v1",
] as const;
