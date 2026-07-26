export type RequirementCompatibilityItem = {
  id: string;
  name: string;
  ruleCategoryId?: string | null;
  exclusiveGroup?: string | null;
};

export type RequirementIncompatibility = {
  categoryIds: readonly [string, string];
  message: string;
};

function incompatibleWithEach(
  categoryId: string,
  incompatibleCategoryIds: readonly string[],
  message: string,
): RequirementIncompatibility[] {
  return incompatibleCategoryIds.map((incompatibleCategoryId) => ({
    categoryIds: [categoryId, incompatibleCategoryId],
    message,
  }));
}

export const REQUIREMENT_INCOMPATIBILITIES: readonly RequirementIncompatibility[] =
  [
    {
      categoryIds: [
        "ptcb-cpht-2026-bls-cpr-aed",
        "ptcb-cpht-2026-patient-safety",
      ],
      message:
        "BLS, CPR, or AED training cannot satisfy Patient Safety for the same activity. Choose only one of those tags.",
    },
    {
      categoryIds: [
        "ny-pharmacist-2026-self-study",
        "ny-pharmacist-2026-cdtm",
      ],
      message:
        "New York collaborative drug-therapy-management protocol hours cannot be self-study. Classify those hours as live or interactive.",
    },
    {
      categoryIds: [
        "nj-pharmacist-2026-confirmed-carryover",
        "nj-pharmacist-2026-prescription-opioids",
      ],
      message:
        "New Jersey prescription-opioid credit cannot carry forward. Use current-period credit for that subject.",
    },
    ...incompatibleWithEach(
      "ptcb-cpht-2026-bls-cpr-aed",
      [
        "ptcb-cpht-2026-technician-specific",
        "ptcb-cpht-2026-pharmacist-specific",
        "ptcb-cpht-2026-pharmacy-law",
      ],
      "BLS, CPR, or AED training cannot satisfy Technician-Specific CE, Pharmacist-Specific CE, or Pharmacy Law for the same activity. Choose the BLS activity type without those tags.",
    ),
    ...incompatibleWithEach(
      "nj-physician-2026-volunteer-care",
      [
        "nj-physician-2026-category-one",
        "nj-physician-2026-end-of-life",
        "nj-physician-2026-opioids",
        "nj-physician-2026-sexual-misconduct",
        "nj-physician-2026-perinatal-bias",
      ],
      "Qualifying volunteer medical care credit cannot satisfy Category I or a nested Category I subject for the same activity. Choose the volunteer-care classifier without those tags.",
    ),
    ...[
      "pmi-pmp-2026-giving-back",
      "pmi-pmp-2026-working-professional",
    ].flatMap((categoryId) =>
      incompatibleWithEach(
        categoryId,
        [
          "pmi-pmp-2026-ways-of-working",
          "pmi-pmp-2026-power-skills",
          "pmi-pmp-2026-business-acumen",
        ],
        "Giving Back PDUs, including Working as a Professional, cannot satisfy Talent Triangle Education minimums for the same activity. Choose the Giving Back activity type without Education child tags.",
      ),
    ),
    {
      categoryIds: [
        "ca-bbs-lmft-lcsw-lpcc-standard-2026-supervision-cpd",
        "ca-bbs-lmft-lcsw-lpcc-standard-2026-law-ethics",
      ],
      message:
        "California BBS supervision CPD cannot also satisfy the general Law and Ethics minimum for the same credited time.",
    },
    {
      categoryIds: [
        "nj-lpc-standard-renewal-2026-confirmed-carryover",
        "nj-lpc-standard-renewal-2026-opioid",
      ],
      message:
        "New Jersey LPC carryover cannot satisfy the current-period prescription-opioid requirement.",
    },
    {
      categoryIds: [
        "pa-lpc-standard-renewal-2026-ethics",
        "pa-lpc-standard-renewal-2026-suicide-prevention",
      ],
      message:
        "Pennsylvania LPC suicide-prevention credit cannot also satisfy the ethics minimum for the same credited time.",
    },
  ];

function matchingIncompatibility(
  leftCategoryId?: string | null,
  rightCategoryId?: string | null,
) {
  if (!leftCategoryId || !rightCategoryId) return null;
  return (
    REQUIREMENT_INCOMPATIBILITIES.find(
      ({ categoryIds: [first, second] }) =>
        (first === leftCategoryId && second === rightCategoryId) ||
        (first === rightCategoryId && second === leftCategoryId),
    ) ?? null
  );
}

export function requirementsAreIncompatible(
  left: RequirementCompatibilityItem,
  right: RequirementCompatibilityItem,
) {
  return Boolean(
    matchingIncompatibility(left.ruleCategoryId, right.ruleCategoryId),
  );
}

export function findRequirementIncompatibility(
  requirements: readonly RequirementCompatibilityItem[],
) {
  for (let leftIndex = 0; leftIndex < requirements.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < requirements.length;
      rightIndex += 1
    ) {
      const left = requirements[leftIndex];
      const right = requirements[rightIndex];
      const incompatibility = matchingIncompatibility(
        left.ruleCategoryId,
        right.ruleCategoryId,
      );
      if (incompatibility) {
        return { incompatibility, left, right };
      }
    }
  }
  return null;
}

export function requirementIncompatibilityMessage(
  requirement: RequirementCompatibilityItem,
  availableRequirements: readonly RequirementCompatibilityItem[],
) {
  const messages = new Set<string>();
  for (const candidate of availableRequirements) {
    if (candidate.id === requirement.id) continue;
    const incompatibility = matchingIncompatibility(
      requirement.ruleCategoryId,
      candidate.ruleCategoryId,
    );
    if (incompatibility) messages.add(incompatibility.message);
  }
  return messages.size ? [...messages].join(" ") : null;
}

export function nextRequirementSelection(
  selectedRequirementIds: readonly string[],
  requirement: RequirementCompatibilityItem,
  availableRequirements: readonly RequirementCompatibilityItem[],
  checked: boolean,
) {
  if (!checked) {
    return selectedRequirementIds.filter((id) => id !== requirement.id);
  }

  const requirementsById = new Map(
    availableRequirements.map((candidate) => [candidate.id, candidate]),
  );
  const compatibleSelection = selectedRequirementIds.filter((id) => {
    if (id === requirement.id) return false;
    const selected = requirementsById.get(id);
    if (!selected) return false;
    if (
      requirement.exclusiveGroup &&
      selected.exclusiveGroup === requirement.exclusiveGroup
    ) {
      return false;
    }
    return !requirementsAreIncompatible(requirement, selected);
  });
  return [...compatibleSelection, requirement.id];
}
