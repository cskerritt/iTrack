import { getWorkspace } from "@/app/api/workspace/route";
import { daysUntilDateFromToday, readinessScore } from "./readiness";
import { localReminderClock } from "./reminders";

/**
 * The payload an iOS WidgetKit extension renders. Deliberately tiny and
 * deliberately free of identifiers: a widget feed is fetched by a
 * long-lived token on a device that may be locked, so it carries the same
 * three numbers the dashboard hero shows and the credential's display name,
 * and nothing else — no user id, no email, no credential ids, no activity
 * titles.
 */
export type WidgetSummary = {
  generatedAt: string;
  credentials: Array<{
    name: string;
    daysToRenewal: number | null;
    dueDate: string | null;
    creditsDone: number;
    creditsRequired: number;
    readinessPercent: number;
  }>;
};

export class WidgetSummaryUserNotFoundError extends Error {
  constructor() {
    super("No user row exists for this widget summary request.");
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `credentials.deadline` is NOT NULL, so a row with no usable due date
 * carries a blank or malformed string rather than SQL NULL. Normalizing here
 * is what keeps `daysToRenewal` from becoming NaN (which JSON-encodes as
 * `null` anyway, but only after every comparison against it has silently
 * gone false).
 */
function normalizedDueDate(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const date = value.slice(0, 10);
  if (!ISO_DATE.test(date)) return null;
  return Number.isNaN(Date.parse(`${date}T00:00:00.000Z`)) ? null : date;
}

/**
 * Builds the widget feed from the *same* workspace payload the dashboard
 * renders, so the widget can never disagree with the app it mirrors.
 * `getWorkspace` is heavier than a hand-rolled aggregate would be, but the
 * hero numbers it produces are the product of a long tail of rules —
 * capped-credit maximums, unclassified units, dental checkpoints, per-rule
 * countable earnings — and reproducing any of that here would fork the
 * definition of "ready" the first time one of those rules changed.
 *
 * `nowMs` is passed in rather than read here so `generatedAt` and every
 * `daysToRenewal` in one response come from a single instant.
 */
export async function buildWidgetSummary(
  database: D1Database,
  userId: string,
  nowMs: number,
): Promise<WidgetSummary> {
  // `getWorkspace` takes the full request identity; the widget request has no
  // signed-in identity of its own, so it is rebuilt from the stored row. The
  // email and display name below feed only the part of the workspace payload
  // this function discards — they never reach the response.
  const user = await database
    .prepare(
      `SELECT id, email, display_name AS displayName, is_demo AS isDemo
       FROM users WHERE id = ?`,
    )
    .bind(userId)
    .first<{
      id: string;
      email: string;
      displayName: string;
      isDemo: number;
    }>();
  if (!user) throw new WidgetSummaryUserNotFoundError();

  const workspace = await getWorkspace(database, {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    isDemo: Boolean(user.isDemo),
  });

  // workerd's zone is always UTC, so counting days from an epoch here would
  // show a user in the Americas a different number than the app shows them
  // for most of every day. The workspace already carries the zone the user
  // set for reminders; today's date is resolved in it once, with the same
  // clock the reminder and push schedulers use.
  const today = localReminderClock(
    new Date(nowMs),
    workspace.reminderPreferences.timeZone,
  ).date;

  const credentials = workspace.credentials.map((credential) => {
    const dueDate = normalizedDueDate(credential.deadline);
    return {
      name: credential.credentialName,
      daysToRenewal:
        dueDate === null ? null : daysUntilDateFromToday(dueDate, today),
      dueDate,
      creditsDone: credential.totalEarned,
      creditsRequired: credential.totalRequired,
      readinessPercent: readinessScore(credential),
      status: credential.status,
    };
  });

  // Same order the app puts credentials in: live ones first, then submitted,
  // then closed-out history. Sorting on the date alone would float a renewed
  // credential — which keeps the deadline it was renewed against — to the top
  // of the widget the moment a renewal completes, so the one line the widget
  // has room for would show a dead credential counting down past zero.
  //
  // Within a bucket: soonest due first, undated last (they can never be the
  // urgent one), name as the tiebreak so the widget does not reshuffle
  // between refreshes.
  const lifecycleRank = (status: string) =>
    status === "active" ? 0 : status === "submitted" ? 1 : 2;
  credentials.sort((left, right) => {
    const rankDifference =
      lifecycleRank(left.status) - lifecycleRank(right.status);
    if (rankDifference !== 0) return rankDifference;
    if (left.dueDate !== right.dueDate) {
      if (left.dueDate === null) return 1;
      if (right.dueDate === null) return -1;
      return left.dueDate < right.dueDate ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    // Rebuilt field by field: `status` is a sort key, not something the feed
    // publishes, and listing the shape here keeps it from growing by accident.
    credentials: credentials.map((credential) => ({
      name: credential.name,
      daysToRenewal: credential.daysToRenewal,
      dueDate: credential.dueDate,
      creditsDone: credential.creditsDone,
      creditsRequired: credential.creditsRequired,
      readinessPercent: credential.readinessPercent,
    })),
  };
}

/**
 * Compares two strings without letting the comparison's duration depend on
 * how much of the secret matched. Unlike a plain `===`, this neither returns
 * early on the first differing character nor on a length mismatch: unequal
 * lengths are folded into the same accumulator as the characters, and the
 * loop always runs the longer of the two. (Out-of-range `charCodeAt` is NaN,
 * which `|| 0` turns into the same padding value on both sides.)
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/**
 * Pure so the token gate can be tested without a Cloudflare environment.
 *
 * An unset token means the endpoint was never provisioned, which is a 503
 * (the feature is unavailable) rather than a 401 (your credential is wrong)
 * — and, more importantly, it must never be treated as "no token required".
 */
export function authorizeWidgetRequest(
  request: Request,
  expectedToken: string | undefined,
): { ok: true } | { ok: false; status: 503 | 401 } {
  // Trimmed because a token pasted into a hosting dashboard routinely arrives
  // with a trailing newline; whitespace-only is the same as unset, and must
  // not become a token made of spaces that some caller could guess.
  const token = expectedToken?.trim();
  if (!token) return { ok: false, status: 503 };
  // The whole header is compared in one pass, so not even the scheme prefix
  // gets its own early exit.
  const authorization = request.headers.get("authorization") ?? "";
  return constantTimeEquals(authorization, `Bearer ${token}`)
    ? { ok: true }
    : { ok: false, status: 401 };
}
