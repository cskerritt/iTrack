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

type RuleCategoryKind = "informational" | "maximum";
type RuleCategoryApplicability = "optional" | "conditional";

type CategorySeedBinding = readonly [
  id: string,
  ruleSetId: string,
  name: string,
  requiredUnits: number,
  kind: RuleCategoryKind,
  relation: "independent",
  parentCategoryId: null,
  applicability: RuleCategoryApplicability,
  conditionNote: string,
  exclusiveGroup: "CompTIA activity type",
  sortOrder: number,
];

type CapProfile = Readonly<{
  webinar: number;
  conference: number;
  teaching: number;
  materials: number;
  article: number;
  blog: number;
  book: number;
}>;

type CertificationSpec = Readonly<{
  id: string;
  stableKey: string;
  credentialName: string;
  totalUnits: number;
  profile: CapProfile;
  effectiveDate?: string;
  specialNote?: string;
  workRequiresConfirmation?: boolean;
}>;

const LAST_VERIFIED_AT = "2026-07-26";
const SOURCE_URL =
  "https://www.comptia.org/en-us/resources/ce/learn/earn-continuing-education-units-ceus/";
const EXCLUSIVE_GROUP = "CompTIA activity type" as const;

const PROFILE_15: CapProfile = {
  webinar: 2,
  conference: 2,
  teaching: 8,
  materials: 6,
  article: 3,
  blog: 6,
  book: 9,
};

const PROFILE_20: CapProfile = {
  webinar: 4,
  conference: 4,
  teaching: 10,
  materials: 10,
  article: 8,
  blog: 8,
  book: 15,
};

const PROFILE_30: CapProfile = {
  webinar: 6,
  conference: 6,
  teaching: 15,
  materials: 15,
  article: 12,
  blog: 12,
  book: 20,
};

const PROFILE_50: CapProfile = {
  webinar: 10,
  conference: 10,
  teaching: 20,
  materials: 20,
  article: 16,
  blog: 16,
  book: 40,
};

const PROFILE_60: CapProfile = {
  webinar: 15,
  conference: 15,
  teaching: 30,
  materials: 30,
  article: 18,
  blog: 18,
  book: 50,
};

const PROFILE_75: CapProfile = {
  webinar: 20,
  conference: 20,
  teaching: 40,
  materials: 40,
  article: 20,
  blog: 20,
  book: 60,
};

const CERTIFICATIONS = [
  {
    id: "comptia-secai-plus-2026-v1",
    stableKey: "comptia-secai-plus-ce",
    credentialName: "CompTIA SecAI+ — CE renewal",
    totalUnits: 15,
    profile: PROFILE_15,
    effectiveDate: "2026-02-17",
    specialNote:
      "SecAI+ launched February 17, 2026. Some older CompTIA policy and Help indexes lag this new credential, so use the current CEU table and the expiration shown in CompTIA Central.",
  },
  {
    id: "comptia-autoops-plus-2026-v1",
    stableKey: "comptia-autoops-plus-ce",
    credentialName: "CompTIA AutoOps+ — CE renewal",
    totalUnits: 15,
    profile: PROFILE_15,
    effectiveDate: "2026-06-02",
    specialNote:
      "AutoOps+ launched June 2, 2026. Some older CompTIA policy and Help indexes lag this new credential, so use the current CEU table and the expiration shown in CompTIA Central.",
  },
  {
    id: "comptia-a-plus-2026-v1",
    stableKey: "comptia-a-plus-ce",
    credentialName: "CompTIA A+ ce — standard renewal",
    totalUnits: 20,
    profile: PROFILE_20,
    effectiveDate: "2011-01-01",
    specialNote:
      "A+ earned before January 1, 2011 is Good-for-Life and must not be placed on this renewal template. Confirm that the credential carries the ce designation and an expiration date.",
  },
  {
    id: "comptia-data-plus-2026-v1",
    stableKey: "comptia-data-plus-ce",
    credentialName: "CompTIA Data+ ce — standard renewal",
    totalUnits: 20,
    profile: PROFILE_20,
  },
  {
    id: "comptia-datasys-plus-2026-v1",
    stableKey: "comptia-datasys-plus-ce",
    credentialName: "CompTIA DataSys+ ce — standard renewal",
    totalUnits: 30,
    profile: PROFILE_30,
    workRequiresConfirmation: true,
  },
  {
    id: "comptia-network-plus-2026-v1",
    stableKey: "comptia-network-plus-ce",
    credentialName: "CompTIA Network+ ce — standard renewal",
    totalUnits: 30,
    profile: PROFILE_30,
    effectiveDate: "2011-01-01",
    specialNote:
      "Network+ earned before January 1, 2011 is Good-for-Life and must not be placed on this renewal template. Confirm that the credential carries the ce designation and an expiration date.",
  },
  {
    id: "comptia-project-plus-2026-v1",
    stableKey: "comptia-project-plus-ce",
    credentialName: "CompTIA Project+ ce — CE-program credential",
    totalUnits: 30,
    profile: PROFILE_30,
    effectiveDate: "2025-10-01",
    specialNote:
      "Project+ moved into the CE Program effective October 1, 2025. CompTIA's official pages conflict about legacy Good-for-Life holders, while its transition notice assigns converted Project+ ce credentials an October 1, 2028 deadline. Use this template only when CompTIA Central displays a ce credential and expiration; preserve any separate Good-for-Life credential and use the portal date rather than deriving one from the exam date.",
  },
  {
    id: "comptia-server-plus-2026-v1",
    stableKey: "comptia-server-plus-ce",
    credentialName: "CompTIA Server+ ce — CE-program credential",
    totalUnits: 30,
    profile: PROFILE_30,
    effectiveDate: "2025-10-01",
    specialNote:
      "Server+ moved into the CE Program effective October 1, 2025. CompTIA's official pages conflict about legacy Good-for-Life holders, while its transition notice assigns converted Server+ ce credentials an October 1, 2027 deadline. Use this template only when CompTIA Central displays a ce credential and expiration; preserve any separate Good-for-Life credential and use the portal date rather than deriving one from the exam date.",
  },
  {
    id: "comptia-security-plus-2026-v1",
    stableKey: "comptia-security-plus-ce",
    credentialName: "CompTIA Security+ ce — standard renewal",
    totalUnits: 50,
    profile: PROFILE_50,
    effectiveDate: "2011-01-01",
    specialNote:
      "Security+ earned before January 1, 2011 is Good-for-Life and must not be placed on this renewal template. Confirm that the credential carries the ce designation and an expiration date.",
  },
  {
    id: "comptia-linux-plus-2026-v1",
    stableKey: "comptia-linux-plus-ce",
    credentialName: "CompTIA Linux+ ce — standard renewal",
    totalUnits: 50,
    profile: PROFILE_50,
  },
  {
    id: "comptia-cloud-plus-2026-v1",
    stableKey: "comptia-cloud-plus-ce",
    credentialName: "CompTIA Cloud+ ce — standard renewal",
    totalUnits: 50,
    profile: PROFILE_50,
    specialNote:
      "CompTIA's official hierarchy pages disagree about which Cloud+ exam versions fully renew lower certifications. Do not infer a lower credential's renewal from Cloud+; confirm the resulting status and expiration in CompTIA Central.",
  },
  {
    id: "comptia-pentest-plus-2026-v1",
    stableKey: "comptia-pentest-plus-ce",
    credentialName: "CompTIA PenTest+ ce — standard renewal",
    totalUnits: 60,
    profile: PROFILE_60,
  },
  {
    id: "comptia-cysa-plus-2026-v1",
    stableKey: "comptia-cysa-plus-ce",
    credentialName:
      "CompTIA Cybersecurity Analyst (CySA+) ce — standard renewal",
    totalUnits: 60,
    profile: PROFILE_60,
    specialNote:
      "Initial earning and later renewal of CySA+ and PenTest+ have different cross-credit behavior. Apply only the exact CEUs shown by CompTIA and confirm any automatic renewal in CompTIA Central.",
  },
  {
    id: "comptia-dataai-2026-v1",
    stableKey: "comptia-dataai-ce",
    credentialName: "CompTIA DataAI (formerly DataX) ce — standard renewal",
    totalUnits: 75,
    profile: PROFILE_75,
    effectiveDate: "2026-01-21",
    specialNote:
      "CompTIA DataX was renamed DataAI effective January 21, 2026. Active DataX holders remain recognized without retesting; treat DataX as an alias of this template and retain the account-displayed cycle dates.",
    workRequiresConfirmation: true,
  },
  {
    id: "comptia-cloudnetx-2026-v1",
    stableKey: "comptia-cloudnetx-ce",
    credentialName: "CompTIA CloudNetX ce — standard renewal",
    totalUnits: 75,
    profile: PROFILE_75,
    effectiveDate: "2025-02-18",
    workRequiresConfirmation: true,
  },
  {
    id: "comptia-securityx-2026-v1",
    stableKey: "comptia-securityx-ce",
    credentialName: "CompTIA SecurityX (formerly CASP+) ce — standard renewal",
    totalUnits: 75,
    profile: PROFILE_75,
    effectiveDate: "2024-12-17",
    specialNote:
      "CompTIA CASP+ was renamed SecurityX with the V5 exam on December 17, 2024. The rename did not end active CASP+ status or change its CE obligation; treat CASP+ as an alias of this template and retain the account-displayed cycle dates.",
  },
] as const satisfies readonly CertificationSpec[];

const SHARED_RULE_NOTE =
  "Use the exact certification and renewal dates displayed in CompTIA Central. Enter only the CEU value CompTIA accepts for the activity in the certification account, not raw course, publication, work, or creation hours. Every counted activity must be completed within that 36-month cycle, and at least 50% of its content must relate to one or more exam objectives for the certification being renewed; CompTIA retains final eligibility authority. The expiration date is the renewal deadline. CompTIA's 30-day post-expiration window is only for activating the grace process, paying an outstanding fee, or uploading CEUs earned before expiration: it does not extend the period for earning CEUs, completing CertMaster CE, or earning another certification. No official carryover permission is published, so do not carry, reuse, or automatically copy an activity into another cycle. Confirm all automatic or higher-level-certification renewals and replacement expiration dates in CompTIA Central. Passing a newer exam, eligible CertMaster CE, and qualifying CompTIA or non-CompTIA certifications are alternative renewal routes; officially mapped certifications may instead award fixed CEUs, and fees vary by route. CompTIA may audit at any time, including after cycle completion, and states that submitted CE documentation is retained for six years. Fee amounts are mutable and excluded from the compliance total; verify the current official fee page.";

const WORK_EXPERIENCE_CONFLICT_NOTE =
  "CompTIA's general Help guidance describes three work-experience CEUs per cycle year, up to nine, but its detailed work-experience table omits this certification. Leave Work Experience uncounted unless CompTIA or the holder's portal confirms that it applies.";

function makeRuleNote(spec: CertificationSpec): string {
  return [
    `CompTIA's current CEU table requires ${spec.totalUnits} CEUs for this standard three-year renewal path.`,
    SHARED_RULE_NOTE,
    spec.workRequiresConfirmation
      ? WORK_EXPERIENCE_CONFLICT_NOTE
      : undefined,
    spec.specialNote,
  ]
    .filter((note): note is string => Boolean(note))
    .join(" ");
}

function makeRuleSetBinding(spec: CertificationSpec): RuleSetSeedBinding {
  return [
    spec.id,
    spec.stableKey,
    1,
    "Information Technology",
    spec.credentialName,
    "Global",
    "CompTIA",
    spec.totalUnits,
    "CompTIA-accepted CEUs",
    36,
    SOURCE_URL,
    makeRuleNote(spec),
    spec.effectiveDate ?? null,
    LAST_VERIFIED_AT,
    "source_linked_check_conditions",
    1,
  ];
}

function makeCategoryBindings(
  spec: CertificationSpec,
): readonly CategorySeedBinding[] {
  const categoryPrefix = spec.id.replace(/-v1$/, "");
  const workApplicability: RuleCategoryApplicability =
    spec.workRequiresConfirmation ? "conditional" : "optional";
  const workNote = spec.workRequiresConfirmation
    ? WORK_EXPERIENCE_CONFLICT_NOTE
    : "Up to 9 CEUs may count from related work experience at 3 CEUs per completed cycle year. At least 50% of the work must relate to the certification's exam objectives, and the submission requires a signed employer letter on company letterhead.";

  return [
    [
      `${categoryPrefix}-other-full-total-eligible-activity`,
      spec.id,
      "Other Eligible Training, Higher Education, ACE, SME, or Officially Mapped Certification Activity",
      0,
      "informational",
      "independent",
      null,
      "optional",
      `Required activity-type catchall for eligible credit not classified under a separately capped activity. Training earns 1 CEU per hour; a qualifying 3- to 4-credit-hour college or ACE course earns 10 CEUs; a corresponding CompTIA SME exam-development workshop earns 1 CEU per hour. Each is limited by the ${spec.totalUnits}-CEU overall requirement. For another certification, record only the exact fixed CEUs in CompTIA's current credential-specific mapping; if it fully renews the credential, close the cycle only after CompTIA Central confirms the new status and expiration.`,
      EXCLUSIVE_GROUP,
      0,
    ],
    [
      `${categoryPrefix}-live-webinar`,
      spec.id,
      "Live Webinar",
      spec.profile.webinar,
      "maximum",
      "independent",
      null,
      "optional",
      `At most ${spec.profile.webinar} CEUs may count from live webinars, at 1 CEU per attended hour. On-demand webinars and YouTube videos count only with proof of registration or a completion certificate.`,
      EXCLUSIVE_GROUP,
      1,
    ],
    [
      `${categoryPrefix}-conference`,
      spec.id,
      "Conference Session",
      spec.profile.conference,
      "maximum",
      "independent",
      null,
      "optional",
      `At most ${spec.profile.conference} CEUs may count from conference sessions, at 1 CEU per attended hour. Retain the session outline and completion certificate or registration evidence showing the attendee, session, date, and hours.`,
      EXCLUSIVE_GROUP,
      2,
    ],
    [
      `${categoryPrefix}-work-experience`,
      spec.id,
      "Related Work Experience",
      9,
      "maximum",
      "independent",
      null,
      workApplicability,
      workNote,
      EXCLUSIVE_GROUP,
      3,
    ],
    [
      `${categoryPrefix}-teaching-mentoring`,
      spec.id,
      "Teaching or Mentoring",
      spec.profile.teaching,
      "maximum",
      "independent",
      null,
      "optional",
      `At most ${spec.profile.teaching} CEUs may count from teaching or mentoring, at 1 CEU per hour. The same teaching content may be submitted only once in the cycle; retain the syllabus or objectives, covered content, dates, hours, and the required instructor or mentee verification.`,
      EXCLUSIVE_GROUP,
      4,
    ],
    [
      `${categoryPrefix}-instructional-materials`,
      spec.id,
      "Create Instructional Materials",
      spec.profile.materials,
      "maximum",
      "independent",
      null,
      "optional",
      `At most ${spec.profile.materials} CEUs may count from creating instructional materials, at 2 CEUs per creation hour. The same materials may be submitted only once; retain the dated materials and a lesson plan or syllabus naming the author.`,
      EXCLUSIVE_GROUP,
      5,
    ],
    [
      `${categoryPrefix}-article-white-paper`,
      spec.id,
      "Published Article or White Paper",
      spec.profile.article,
      "maximum",
      "independent",
      null,
      "optional",
      `At most ${spec.profile.article} CEUs may count from published articles or white papers. Each work earns 4 CEUs and must be at least four pages; retain the URL or copy, author, publication date, and content description.`,
      EXCLUSIVE_GROUP,
      6,
    ],
    [
      `${categoryPrefix}-blog`,
      spec.id,
      "Published Blog Post",
      spec.profile.blog,
      "maximum",
      "independent",
      null,
      "optional",
      `At most ${spec.profile.blog} CEUs may count from published blog posts. Each post earns 1 CEU and must be at least 500 words; retain the URL or copy, author, publication date, and content description.`,
      EXCLUSIVE_GROUP,
      7,
    ],
    [
      `${categoryPrefix}-book`,
      spec.id,
      "Published Book",
      spec.profile.book,
      "maximum",
      "independent",
      null,
      "optional",
      `A qualifying book written and published during the cycle earns up to ${spec.profile.book} CEUs, which is also the cycle maximum for this activity type. Retain a link to the publisher, bookseller, or other page identifying the author and publication.`,
      EXCLUSIVE_GROUP,
      8,
    ],
  ];
}

export const COMPTIA_RULE_SET_SEED_BINDINGS =
  CERTIFICATIONS.map(makeRuleSetBinding);

export const COMPTIA_CATEGORY_SEED_BINDINGS = CERTIFICATIONS.flatMap((spec) =>
  makeCategoryBindings(spec),
);

export const COMPTIA_RULE_SET_IDS = CERTIFICATIONS.map((spec) => spec.id);
