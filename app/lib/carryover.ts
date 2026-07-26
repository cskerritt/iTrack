const PORTAL_CARRYOVER_LOOKBACK_YEARS = new Map<string, number>([
  ["hrci-phr-2026-confirmed-carryover", 1],
  ["hrci-sphr-2026-confirmed-carryover", 1],
  ["shrm-cp-2026-confirmed-carryover", 3],
  ["shrm-scp-2026-confirmed-carryover", 3],
  ["tx-lpc-standard-renewal-2026-confirmed-carryover", 2],
  ["nj-lpc-standard-renewal-2026-confirmed-carryover", 2],
  ["pa-professional-educator-act-48-2026-confirmed-carryover", 2],
]);

export function portalCarryoverLookbackYears(
  ruleCategoryId: string | null | undefined,
) {
  return ruleCategoryId
    ? PORTAL_CARRYOVER_LOOKBACK_YEARS.get(ruleCategoryId) ?? null
    : null;
}

export function portalCarryoverCategoryIds() {
  return [...PORTAL_CARRYOVER_LOOKBACK_YEARS.keys()];
}

export function calendarYearsBefore(
  isoDate: string,
  years: number,
) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const targetYear = year - years;
  const lastDayOfTargetMonth = new Date(
    Date.UTC(targetYear, month, 0),
  ).getUTCDate();
  return [
    String(targetYear).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(Math.min(day, lastDayOfTargetMonth)).padStart(2, "0"),
  ].join("-");
}
