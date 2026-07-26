export const FLORIDA_MENTAL_HEALTH_ETHICS_RULE_SET_ID =
  "fl-lcsw-lmft-lmhc-ethics-boundaries-phase-2026-v1";

export const FLORIDA_MENTAL_HEALTH_TELEHEALTH_RULE_SET_ID =
  "fl-lcsw-lmft-lmhc-telehealth-phase-2026-v1";

export function oppositeFloridaMentalHealthRuleSetId(
  currentRuleSetId: string | null | undefined,
) {
  if (currentRuleSetId === FLORIDA_MENTAL_HEALTH_ETHICS_RULE_SET_ID) {
    return FLORIDA_MENTAL_HEALTH_TELEHEALTH_RULE_SET_ID;
  }
  if (currentRuleSetId === FLORIDA_MENTAL_HEALTH_TELEHEALTH_RULE_SET_ID) {
    return FLORIDA_MENTAL_HEALTH_ETHICS_RULE_SET_ID;
  }
  return null;
}

export function isFloridaMentalHealthCycle(
  cycleStart: string,
  deadline: string,
) {
  const startMatch = /^(\d{4})-04-01$/.exec(cycleStart);
  if (!startMatch) return false;
  const startYear = Number(startMatch[1]);
  if (!Number.isSafeInteger(startYear) || startYear % 2 !== 1) return false;
  return deadline === `${startYear + 2}-03-31`;
}

export function nextFloridaMentalHealthCycle(currentDeadline: string) {
  const deadlineMatch = /^(\d{4})-03-31$/.exec(currentDeadline);
  if (!deadlineMatch) return null;
  const startYear = Number(deadlineMatch[1]);
  if (!Number.isSafeInteger(startYear) || startYear % 2 !== 1) return null;
  return {
    cycleStart: `${startYear}-04-01`,
    deadline: `${startYear + 2}-03-31`,
  };
}
