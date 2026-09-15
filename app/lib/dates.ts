// Calendar dates for the app, computed in an IANA time zone rather than in
// UTC. Every default date the client offers (a completion date, a submission
// or acceptance date, a new credential's cycle window, a snooze) and every
// server-side "today" comparison goes through `todayLocal`, so a user in Los
// Angeles at 23:30 sees today's date, not tomorrow's (audit critic-01).
//
// Deliberately dependency-free and free of DOM/D1 types: `npm run
// build:lib-test` compiles this file standalone for tests/dates.test.mjs, and
// tests/rendered-html.test.mjs can inline it as raw TypeScript.

export const UTC_FALLBACK_ZONE = "UTC";
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function localClock(
  timeZone: string,
  now: Date = new Date(),
): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: isValidTimeZone(timeZone) ? timeZone : UTC_FALLBACK_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour")),
  };
}

export function todayLocal(timeZone: string, now: Date = new Date()): string {
  return localClock(timeZone, now).date;
}

// The stored reminder zone is the literal "UTC" for every account that has
// never chosen one (the column default and the ensureUser seed), so that
// literal — and only that literal — means "unset" here. "Etc/UTC" or any
// other spelling is a deliberate choice and is respected.
export function deviceZoneSuggestion(
  storedZone: string,
  deviceZone: string,
): string | null {
  if (storedZone !== UTC_FALLBACK_ZONE) return null;
  if (deviceZone === UTC_FALLBACK_ZONE) return null;
  return isValidTimeZone(deviceZone) ? deviceZone : null;
}

// The zone default dates are computed in: the chosen zone, or the device's
// while the account is still on the fallback (a dismissed offer must not
// keep the UTC off-by-one bug alive).
export function effectiveDateZone(
  storedZone: string,
  deviceZone: string,
): string {
  if (storedZone !== UTC_FALLBACK_ZONE) return storedZone;
  return isValidTimeZone(deviceZone) ? deviceZone : UTC_FALLBACK_ZONE;
}

export function addDaysIso(value: string, days: number): string {
  const date = new Date(`${value.slice(0, 10)}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function addMonthsIso(value: string, months: number): string {
  const date = new Date(`${value.slice(0, 10)}T12:00:00.000Z`);
  const targetDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(targetDay, lastDay));
  return date.toISOString().slice(0, 10);
}

// Whole years through the month arithmetic so 29 February clamps to the 28th
// instead of rolling into March the way `setFullYear` does.
export function addYearsIso(value: string, years: number): string {
  return addMonthsIso(value, years * 12);
}
