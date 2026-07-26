const PORTAL_CARRYOVER_LOOKBACK_MONTHS = new Map<string, number>([
  ["hrci-phr-2026-confirmed-carryover", 12],
  ["hrci-sphr-2026-confirmed-carryover", 12],
  ["shrm-cp-2026-confirmed-carryover", 36],
  ["shrm-scp-2026-confirmed-carryover", 36],
  ["tx-lpc-standard-renewal-2026-confirmed-carryover", 24],
  ["nj-lpc-standard-renewal-2026-confirmed-carryover", 24],
  ["pa-professional-educator-act-48-2026-confirmed-carryover", 24],
  ["nj-pharmacist-2026-confirmed-carryover", 6],
  ["nj-rn-2026-confirmed-carryover", 24],
  ["nj-lpn-2026-confirmed-carryover", 24],
  ["nj-dentist-2026-confirmed-carryover", 24],
  ["tx-dentist-2026-confirmed-carryover", 12],
  ["tx-dental-hygienist-2026-confirmed-carryover", 12],
]);

export function portalCarryoverLookbackMonths(
  ruleCategoryId: string | null | undefined,
) {
  return ruleCategoryId
    ? PORTAL_CARRYOVER_LOOKBACK_MONTHS.get(ruleCategoryId) ?? null
    : null;
}

export function portalCarryoverLookbackYears(
  ruleCategoryId: string | null | undefined,
) {
  const months = portalCarryoverLookbackMonths(ruleCategoryId);
  return months === null ? null : months / 12;
}

export function portalCarryoverCategoryIds() {
  return [...PORTAL_CARRYOVER_LOOKBACK_MONTHS.keys()];
}

export function calendarMonthsBefore(
  isoDate: string,
  months: number,
) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const absoluteMonth = year * 12 + (month - 1) - months;
  const targetYear = Math.floor(absoluteMonth / 12);
  const targetMonth = ((absoluteMonth % 12) + 12) % 12 + 1;
  const lastDayOfTargetMonth = new Date(
    Date.UTC(targetYear, targetMonth, 0),
  ).getUTCDate();
  return [
    String(targetYear).padStart(4, "0"),
    String(targetMonth).padStart(2, "0"),
    String(Math.min(day, lastDayOfTargetMonth)).padStart(2, "0"),
  ].join("-");
}

export function calendarYearsBefore(
  isoDate: string,
  years: number,
) {
  return calendarMonthsBefore(isoDate, years * 12);
}
