/**
 * A "cycle" is one `credentials` row. `active` and `submitted` cycles are
 * open — the deadline still counts down until the board accepts the renewal —
 * and `renewed` cycles are closed: their successor row carries the next
 * deadline. Rows of one credential share a `seriesId`
 * (`COALESCE(cycle.series_id, c.id)` in getWorkspace), so a legacy root that
 * predates cycle links is a series of one.
 *
 * Everything here takes `today` (YYYY-MM-DD) as a parameter instead of reading
 * the clock, so the server (stored reminder zone) and the client (device zone)
 * derive the same answer and a unit test can pin a fixed date. Stored dates
 * are strict YYYY-MM-DD strings, so string comparison orders them correctly.
 *
 * `app/lib/cycles.ts` imports nothing but `./readiness.js`: it is compiled by
 * `npm run build:lib-test` (`tsc --module nodenext`) for `tests/cycles.test.mjs`,
 * which is why the relative import carries the `.js` suffix the emitted ESM needs.
 */
import { daysUntilDate } from "./readiness.js";

export type CycleStatus = "active" | "submitted" | "renewed";

export const OPEN_CYCLE_STATUSES: readonly string[] = ["active", "submitted"];

export type CycleLike = {
  id: string;
  status: string;
  deadline: string;
  cycleStart: string;
  seriesId?: string | null;
  acceptedAt?: string | null;
};

export type CycleSeries<T extends CycleLike> = {
  seriesId: string;
  current: T | null;
  previous: T[];
  members: T[];
};

export function isOpenCycle(cycle: { status: string }): boolean {
  return OPEN_CYCLE_STATUSES.includes(cycle.status);
}

export function isClosedCycle(cycle: { status: string }): boolean {
  return cycle.status === "renewed";
}

export function seriesKey(cycle: {
  id: string;
  seriesId?: string | null;
}): string {
  return cycle.seriesId ?? cycle.id;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Soonest deadline first; ties broken by cycle start, then id, so the order is stable. */
export function compareCycleUrgency(a: CycleLike, b: CycleLike): number {
  return (
    compareStrings(a.deadline, b.deadline) ||
    compareStrings(a.cycleStart, b.cycleStart) ||
    compareStrings(a.id, b.id)
  );
}

// "Most recently opened": the largest cycleStart (the payload carries no
// created_at), then id descending so two cycles opened the same day resolve
// the same way every time.
function compareRecency(a: CycleLike, b: CycleLike): number {
  return compareStrings(b.cycleStart, a.cycleStart) || compareStrings(b.id, a.id);
}

/**
 * The cycle Home should point at:
 *   1. an open cycle whose deadline is today or later — the soonest one;
 *   2. else an open cycle — the most recently opened (every open cycle is overdue);
 *   3. else any cycle — the most recently opened (a renewed cycle, which the
 *      hero shows without a countdown);
 *   4. else null (no credentials).
 */
export function activeCycleId(
  cycles: readonly CycleLike[],
  today: string,
): string | null {
  const open = cycles.filter(isOpenCycle);
  const live = open.filter((cycle) => cycle.deadline >= today);
  if (live.length) return [...live].sort(compareCycleUrgency)[0].id;
  if (open.length) return [...open].sort(compareRecency)[0].id;
  if (cycles.length) return [...cycles].sort(compareRecency)[0].id;
  return null;
}

function compareNewestDeadline(a: CycleLike, b: CycleLike): number {
  return compareStrings(b.deadline, a.deadline) || compareStrings(b.id, a.id);
}

/**
 * One entry per credential (series). `current` is the open cycle
 * `activeCycleId` names for that series, or null when every cycle in it is
 * renewed; `previous` lists the renewed cycles newest first. Series with a
 * current cycle come first, soonest deadline first; series with only history
 * follow, newest ended first.
 */
export function groupCycles<T extends CycleLike>(
  cycles: readonly T[],
  today: string,
): CycleSeries<T>[] {
  const bySeries = new Map<string, T[]>();
  for (const cycle of cycles) {
    const key = seriesKey(cycle);
    const members = bySeries.get(key);
    if (members) members.push(cycle);
    else bySeries.set(key, [cycle]);
  }
  const series: CycleSeries<T>[] = [];
  for (const [seriesId, members] of bySeries) {
    const activeId = activeCycleId(members, today);
    const active = members.find((member) => member.id === activeId) ?? null;
    series.push({
      seriesId,
      current: active && isOpenCycle(active) ? active : null,
      previous: members.filter(isClosedCycle).sort(compareNewestDeadline),
      members,
    });
  }
  return series.sort((a, b) => {
    if (a.current && b.current) return compareCycleUrgency(a.current, b.current);
    if (a.current) return -1;
    if (b.current) return 1;
    return (
      compareStrings(b.previous[0]?.deadline ?? "", a.previous[0]?.deadline ?? "") ||
      compareStrings(a.seriesId, b.seriesId)
    );
  });
}

/**
 * The app-wide selection after a workspace load: keep what the user had only
 * while it is still an open cycle; otherwise fall back to the server's
 * `activeCycleId`. A selection that just became `renewed` (the user accepted
 * a renewal) is dropped here, which is what stops Home from counting down a
 * closed cycle after a reload.
 */
export function selectDefaultCredentialId(
  cycles: readonly { id: string; status: string }[],
  current: string,
  activeId: string | null,
): string {
  const kept = current
    ? cycles.find((cycle) => cycle.id === current)
    : undefined;
  if (kept && isOpenCycle(kept)) return current;
  return activeId ?? "";
}

/** What the hero and the detail stat render: a closed marker, or the day count. */
export function cycleCountdown(
  cycle: CycleLike,
  nowMs: number,
):
  | { kind: "closed"; acceptedAt: string | null }
  | { kind: "overdue" | "due"; days: number } {
  if (isClosedCycle(cycle)) {
    return { kind: "closed", acceptedAt: cycle.acceptedAt ?? null };
  }
  const days = daysUntilDate(cycle.deadline, nowMs);
  return { kind: days < 0 ? "overdue" : "due", days };
}
