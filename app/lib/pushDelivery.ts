import {
  normalizeWebPushConfig,
  sendRfc8291WebPush,
  validatePushSubscription,
  WebPushError,
  type PushSubscription,
  type ValidWebPushConfig,
  type WebPushConfig,
} from "./rfc8291Push";
import {
  loadReminderData,
  localReminderClock,
  type Reminder,
  validReminderTimeZone,
} from "./reminders";

export type { WebPushConfig } from "./rfc8291Push";

export type PushNotificationData = {
  title: string;
  body: string;
  tag: string;
  url: string;
};

type SubscriptionRow = {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime: number | null;
  timeZone: string;
  pushHourLocal: number;
};

type DeliveryRow = SubscriptionRow & {
  deliveryId: string;
  reminderKey: string;
  scheduledFor: string;
  attemptCount: number;
};

export type PushDeliveryResult = {
  configured: boolean;
  scanned: number;
  materialized: number;
  considered: number;
  delivered: number;
  retried: number;
  expired: number;
  cancelled: number;
  deferred: number;
  failed: number;
};

const MAX_ATTEMPTS = 4;
const SUBSCRIPTION_SCAN_BUDGET = 64;
const MAX_DELIVERIES_PER_RUN = 8;
const DELIVERY_CONCURRENCY = 4;
const READY_FETCH_LIMIT = MAX_DELIVERIES_PER_RUN * 4;
const GENERIC_TITLE = "License Lantern check-in";
const GENERIC_BODY = "You have a renewal item that needs attention.";
const CONFIGURATION_ERROR_CODES = new Set([
  "invalid_vapid_config",
  "invalid_vapid_keys",
  "invalid_vapid_signature",
]);

function query(
  database: D1Database,
  sql: string,
  bindings: readonly unknown[] = [],
) {
  return database.prepare(sql).bind(...bindings);
}

function sqlTimestamp(date: Date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function addMilliseconds(date: Date, milliseconds: number) {
  return new Date(date.getTime() + milliseconds);
}

function changes(result: D1Result) {
  return Number(result.meta?.changes ?? 0);
}

export function isWebPushConfigured(config: WebPushConfig) {
  return Boolean(normalizeWebPushConfig(config));
}

async function validStoredSubscription(
  subscription: PushSubscription,
  now: number,
) {
  try {
    await validatePushSubscription(subscription, now);
    return true;
  } catch {
    return false;
  }
}

function safeNotificationTag(deliveryId: string) {
  return `ll-${deliveryId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80)}`;
}

function launchPath(deliveryId: string) {
  const search = new URLSearchParams({
    view: "today",
    delivery: deliveryId,
  });
  return `/?${search.toString()}`;
}

function subscriptionFromRow(row: SubscriptionRow): PushSubscription {
  return {
    endpoint: row.endpoint,
    expirationTime: row.expirationTime,
    keys: { p256dh: row.p256dh, auth: row.auth },
  };
}

export async function sendWebPush(
  subscription: PushSubscription,
  config: ValidWebPushConfig,
  data: PushNotificationData,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<Response> {
  const payload = new TextEncoder().encode(
    JSON.stringify({
      title: data.title,
      body: data.body,
      tag: data.tag,
      path: data.url,
    }),
  );
  return sendRfc8291WebPush(
    subscription,
    config,
    payload,
    {
      ttl: 86_400,
      urgency: "normal",
      topic: data.tag.slice(0, 32),
      now,
    },
    fetcher,
  );
}

function retryDelayMilliseconds(attempt: number) {
  if (attempt <= 1) return 15 * 60_000;
  if (attempt === 2) return 60 * 60_000;
  return 6 * 60 * 60_000;
}

function retryAt(response: Response | null, now: Date, attempt: number) {
  const fallback = retryDelayMilliseconds(attempt);
  const retryAfter = response?.headers.get("retry-after")?.trim();
  if (!retryAfter) return addMilliseconds(now, fallback);
  let milliseconds: number | null = null;
  if (/^\d+$/.test(retryAfter)) {
    milliseconds = Number(retryAfter) * 1000;
  } else {
    const parsed = Date.parse(retryAfter);
    if (Number.isFinite(parsed)) milliseconds = parsed - now.getTime();
  }
  if (milliseconds === null || !Number.isFinite(milliseconds)) {
    return addMilliseconds(now, fallback);
  }
  return addMilliseconds(
    now,
    Math.min(24 * 60 * 60_000, Math.max(15 * 60_000, milliseconds)),
  );
}

async function disableSubscription(
  database: D1Database,
  row: DeliveryRow,
  nowSql: string,
  nowEpochMilliseconds: number,
  errorCode: string,
  httpStatus: number | null,
) {
  await database.batch([
    query(
      database,
      `UPDATE push_subscriptions
       SET disabled_at = ?,
           failure_count = failure_count + 1,
           last_failure_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [nowSql, nowSql, nowSql, row.id],
    ),
    query(
      database,
      `UPDATE push_delivery_ledger
       SET status = 'expired',
           http_status = ?,
           error_code = ?,
           next_attempt_at = NULL,
           updated_at = ?
      WHERE id = ? AND status = 'sending'`,
      [httpStatus, errorCode, nowSql, row.deliveryId],
    ),
    query(
      database,
      `UPDATE reminder_preferences
       SET push_enabled = 0,
           updated_at = ?
       WHERE user_id = ?
         AND NOT EXISTS (
           SELECT 1
           FROM push_subscriptions
           WHERE user_id = ?
             AND disabled_at IS NULL
             AND (
               expiration_time IS NULL
               OR expiration_time > ?
             )
         )`,
      [nowSql, row.userId, row.userId, nowEpochMilliseconds],
    ),
  ]);
}

async function markPermanentFailure(
  database: D1Database,
  row: DeliveryRow,
  nowSql: string,
  errorCode: string,
  httpStatus: number | null,
) {
  await database.batch([
    query(
      database,
      `UPDATE push_delivery_ledger
       SET status = 'failed',
           http_status = ?,
           error_code = ?,
           next_attempt_at = NULL,
           updated_at = ?
       WHERE id = ? AND status = 'sending'`,
      [httpStatus, errorCode, nowSql, row.deliveryId],
    ),
    query(
      database,
      `UPDATE push_subscriptions
       SET failure_count = failure_count + 1,
           last_failure_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [nowSql, nowSql, row.id],
    ),
  ]);
}

async function markRetry(
  database: D1Database,
  row: DeliveryRow,
  now: Date,
  response: Response | null,
  errorCode: string,
  httpStatus: number | null,
) {
  const nowSql = sqlTimestamp(now);
  if (row.attemptCount >= MAX_ATTEMPTS) {
    await markPermanentFailure(
      database,
      row,
      nowSql,
      `${errorCode}_attempts_exhausted`,
      httpStatus,
    );
    return false;
  }
  await database.batch([
    query(
      database,
      `UPDATE push_delivery_ledger
       SET status = 'retry',
           http_status = ?,
           error_code = ?,
           next_attempt_at = ?,
           updated_at = ?
       WHERE id = ? AND status = 'sending'`,
      [
        httpStatus,
        errorCode,
        sqlTimestamp(retryAt(response, now, row.attemptCount)),
        nowSql,
        row.deliveryId,
      ],
    ),
    query(
      database,
      `UPDATE push_subscriptions
       SET failure_count = failure_count + 1,
           last_failure_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [nowSql, nowSql, row.id],
    ),
  ]);
  return true;
}

async function markConfigurationRetry(
  database: D1Database,
  row: DeliveryRow,
  now: Date,
  errorCode: string,
  httpStatus: number | null,
) {
  const nowSql = sqlTimestamp(now);
  await query(
    database,
    `UPDATE push_delivery_ledger
     SET status = 'retry',
         attempt_count = CASE
           WHEN attempt_count > 0 THEN attempt_count - 1
           ELSE 0
         END,
         http_status = ?,
         error_code = ?,
         next_attempt_at = ?,
         updated_at = ?
     WHERE id = ? AND status = 'sending'`,
    [
      httpStatus,
      errorCode,
      sqlTimestamp(addMilliseconds(now, 15 * 60_000)),
      nowSql,
      row.deliveryId,
    ],
  ).run();
}

async function claimDelivery(
  database: D1Database,
  row: DeliveryRow,
  nowSql: string,
) {
  const result = await query(
    database,
    `UPDATE push_delivery_ledger
     SET status = 'sending',
         attempt_count = attempt_count + 1,
         next_attempt_at = NULL,
         updated_at = ?
     WHERE id = ?
       AND attempt_count < ?
       AND (
         status = 'pending'
         OR (
           status = 'retry'
           AND next_attempt_at IS NOT NULL
           AND next_attempt_at <= ?
         )
       )`,
    [nowSql, row.deliveryId, MAX_ATTEMPTS, nowSql],
  ).run();
  if (changes(result) === 0) return null;
  return { ...row, attemptCount: row.attemptCount + 1 };
}

async function deliver(
  database: D1Database,
  row: DeliveryRow,
  config: ValidWebPushConfig,
  now: Date,
  fetcher: typeof fetch,
  totals: PushDeliveryResult,
): Promise<"continue" | "stop"> {
  const nowSql = sqlTimestamp(now);
  const claimed = await claimDelivery(database, row, nowSql);
  if (!claimed) return "continue";
  totals.considered += 1;
  const subscription = subscriptionFromRow(claimed);
  if (!(await validStoredSubscription(subscription, now.getTime()))) {
    await disableSubscription(
      database,
      claimed,
      nowSql,
      now.getTime(),
      "malformed_subscription",
      null,
    );
    totals.expired += 1;
    return "continue";
  }

  let response: Response;
  try {
    response = await sendWebPush(
      subscription,
      config,
      {
        title: GENERIC_TITLE,
        body: GENERIC_BODY,
        tag: safeNotificationTag(claimed.deliveryId),
        url: launchPath(claimed.deliveryId),
      },
      fetcher,
      now.getTime(),
    );
  } catch (error) {
    if (
      error instanceof WebPushError &&
      CONFIGURATION_ERROR_CODES.has(error.code)
    ) {
      await markConfigurationRetry(
        database,
        claimed,
        now,
        error.code,
        null,
      );
      totals.retried += 1;
      return "stop";
    }
    const retrying = await markRetry(
      database,
      claimed,
      now,
      null,
      "push_network_error",
      null,
    );
    if (retrying) totals.retried += 1;
    else totals.failed += 1;
    return "continue";
  }

  if (response.ok) {
    await database.batch([
      query(
        database,
        `UPDATE push_delivery_ledger
         SET status = 'delivered',
             http_status = ?,
             error_code = NULL,
             next_attempt_at = NULL,
             delivered_at = ?,
             updated_at = ?
         WHERE id = ? AND status = 'sending'`,
        [response.status, nowSql, nowSql, claimed.deliveryId],
      ),
      query(
        database,
        `UPDATE push_subscriptions
         SET failure_count = 0,
             last_success_at = ?,
             last_seen_at = ?,
             updated_at = ?
         WHERE id = ?`,
        [nowSql, nowSql, nowSql, claimed.id],
      ),
    ]);
    totals.delivered += 1;
    return "continue";
  }
  if (response.status === 404 || response.status === 410) {
    await disableSubscription(
      database,
      claimed,
      nowSql,
      now.getTime(),
      `push_http_${response.status}`,
      response.status,
    );
    totals.expired += 1;
    return "continue";
  }
  if (response.status === 429 || response.status >= 500) {
    const retrying = await markRetry(
      database,
      claimed,
      now,
      response,
      `push_http_${response.status}`,
      response.status,
    );
    if (retrying) totals.retried += 1;
    else totals.failed += 1;
    return "continue";
  }
  if (response.status === 401 || response.status === 403) {
    await markConfigurationRetry(
      database,
      claimed,
      now,
      "vapid_rejected",
      response.status,
    );
    totals.retried += 1;
    return "stop";
  }
  await markPermanentFailure(
    database,
    claimed,
    nowSql,
    `push_http_${response.status}`,
    response.status,
  );
  totals.failed += 1;
  return "continue";
}

async function activeReminderForDelivery(
  database: D1Database,
  row: DeliveryRow,
  now: Date,
  cache: Map<string, Promise<Reminder[]>>,
) {
  let remindersPromise = cache.get(row.userId);
  if (!remindersPromise) {
    remindersPromise = loadReminderData(database, row.userId, {
      channel: "push",
      now,
    }).then((result) => result.reminders);
    cache.set(row.userId, remindersPromise);
  }
  const reminders = await remindersPromise;
  return (
    reminders.find(
      (reminder) =>
        reminder.key === row.reminderKey &&
        reminder.scheduledFor === row.scheduledFor,
    ) ?? null
  );
}

function roundRobinDeliveries(rows: DeliveryRow[], limit: number) {
  const queues = new Map<string, DeliveryRow[]>();
  for (const row of rows) {
    const queue = queues.get(row.userId) ?? [];
    queue.push(row);
    queues.set(row.userId, queue);
  }
  const selected: DeliveryRow[] = [];
  while (selected.length < limit) {
    let added = false;
    for (const queue of queues.values()) {
      const row = queue.shift();
      if (!row) continue;
      selected.push(row);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return selected;
}

export async function runScheduledPushDelivery({
  database,
  scheduledTime,
  config,
  fetcher = fetch,
}: {
  database: D1Database;
  scheduledTime: number;
  config: WebPushConfig;
  fetcher?: typeof fetch;
}): Promise<PushDeliveryResult> {
  const totals: PushDeliveryResult = {
    configured: false,
    scanned: 0,
    materialized: 0,
    considered: 0,
    delivered: 0,
    retried: 0,
    expired: 0,
    cancelled: 0,
    deferred: 0,
    failed: 0,
  };
  const validConfig = normalizeWebPushConfig(config);
  if (!validConfig) return totals;
  totals.configured = true;

  const now = new Date(
    Number.isFinite(scheduledTime) ? scheduledTime : Date.now(),
  );
  const nowSql = sqlTimestamp(now);
  const staleSql = sqlTimestamp(addMilliseconds(now, -30 * 60_000));
  await database.batch([
    query(
      database,
      `UPDATE push_subscriptions
       SET disabled_at = ?,
           updated_at = ?
       WHERE disabled_at IS NULL
         AND expiration_time IS NOT NULL
         AND expiration_time <= ?`,
      [nowSql, nowSql, now.getTime()],
    ),
    query(
      database,
      `UPDATE push_delivery_ledger
       SET status = 'expired',
           error_code = 'subscription_expired',
           next_attempt_at = NULL,
           updated_at = ?
       WHERE status IN ('pending', 'retry', 'sending')
         AND subscription_id IN (
           SELECT id
           FROM push_subscriptions
           WHERE disabled_at IS NOT NULL
         )`,
      [nowSql],
    ),
    query(
      database,
      `UPDATE reminder_preferences
       SET push_enabled = 0,
           updated_at = ?
       WHERE push_enabled = 1
         AND NOT EXISTS (
           SELECT 1
           FROM push_subscriptions subscription
           WHERE subscription.user_id = reminder_preferences.user_id
             AND subscription.disabled_at IS NULL
             AND (
               subscription.expiration_time IS NULL
               OR subscription.expiration_time > ?
             )
         )`,
      [nowSql, now.getTime()],
    ),
    query(
      database,
      `UPDATE push_delivery_ledger
       SET status = 'retry',
           error_code = 'stale_claim',
           next_attempt_at = ?,
           updated_at = ?
       WHERE status = 'sending'
         AND attempt_count < ?
         AND updated_at <= ?`,
      [nowSql, nowSql, MAX_ATTEMPTS, staleSql],
    ),
    query(
      database,
      `UPDATE push_delivery_ledger
       SET status = 'failed',
           error_code = 'stale_claim_attempts_exhausted',
           next_attempt_at = NULL,
           updated_at = ?
       WHERE status = 'sending'
         AND attempt_count >= ?
         AND updated_at <= ?`,
      [nowSql, MAX_ATTEMPTS, staleSql],
    ),
  ]);

  const subscriptionRows = await query(
    database,
    `SELECT
       subscription.id,
       subscription.user_id AS userId,
       subscription.endpoint,
       subscription.p256dh,
       subscription.auth,
       subscription.expiration_time AS expirationTime,
       preference.time_zone AS timeZone,
       preference.push_hour_local AS pushHourLocal
     FROM push_subscriptions subscription
     JOIN reminder_preferences preference
       ON preference.user_id = subscription.user_id
     WHERE preference.push_enabled = 1
       AND subscription.disabled_at IS NULL
       AND (
         subscription.expiration_time IS NULL
         OR subscription.expiration_time > ?
       )
     ORDER BY subscription.updated_at, subscription.id
     LIMIT ?`,
    [now.getTime(), SUBSCRIPTION_SCAN_BUDGET],
  ).all<SubscriptionRow>();
  totals.scanned = subscriptionRows.results.length;
  if (subscriptionRows.results.length > 0) {
    await query(
      database,
      `UPDATE push_subscriptions
       SET updated_at = ?
       WHERE id IN (${subscriptionRows.results.map(() => "?").join(", ")})`,
      [
        nowSql,
        ...subscriptionRows.results.map((subscription) => subscription.id),
      ],
    ).run();
  }

  const subscriptionsByUser = new Map<string, SubscriptionRow[]>();
  for (const subscription of subscriptionRows.results) {
    const existing = subscriptionsByUser.get(subscription.userId) ?? [];
    existing.push(subscription);
    subscriptionsByUser.set(subscription.userId, existing);
  }

  for (const [userId, subscriptions] of subscriptionsByUser) {
    const first = subscriptions[0];
    const clock = localReminderClock(
      now,
      validReminderTimeZone(first.timeZone) ? first.timeZone : "UTC",
    );
    const pushHour = Number(first.pushHourLocal);
    if (clock.hour < (Number.isInteger(pushHour) ? pushHour : 9)) continue;
    const reminderData = await loadReminderData(database, userId, {
      channel: "push",
      now,
    });
    for (const subscription of subscriptions) {
      for (const reminder of reminderData.reminders) {
        const deliveryId = crypto.randomUUID();
        const inserted = await query(
          database,
          `INSERT OR IGNORE INTO push_delivery_ledger (
             id, user_id, subscription_id, reminder_key, scheduled_for,
             status, attempt_count
           )
           SELECT ?, ?, ?, ?, ?, 'pending', 0
           WHERE NOT EXISTS (
             SELECT 1
             FROM push_delivery_ledger prior
             WHERE prior.subscription_id = ?
               AND prior.reminder_key = ?
               AND prior.scheduled_for >= ?
           )`,
          [
            deliveryId,
            userId,
            subscription.id,
            reminder.key,
            reminder.scheduledFor,
            subscription.id,
            reminder.key,
            reminder.scheduledFor,
          ],
        ).run();
        totals.materialized += changes(inserted);
      }
    }
  }

  const dueRows = await query(
    database,
    `SELECT
       delivery.id AS deliveryId,
       delivery.user_id AS userId,
       delivery.reminder_key AS reminderKey,
       delivery.scheduled_for AS scheduledFor,
       delivery.attempt_count AS attemptCount,
       subscription.id,
       subscription.endpoint,
       subscription.p256dh,
       subscription.auth,
       subscription.expiration_time AS expirationTime,
       preference.time_zone AS timeZone,
       preference.push_hour_local AS pushHourLocal
     FROM push_delivery_ledger delivery
     JOIN push_subscriptions subscription
       ON subscription.id = delivery.subscription_id
       AND subscription.user_id = delivery.user_id
     JOIN reminder_preferences preference
       ON preference.user_id = delivery.user_id
     WHERE (
         delivery.status = 'pending'
         OR (
           delivery.status = 'retry'
           AND delivery.next_attempt_at IS NOT NULL
           AND delivery.next_attempt_at <= ?
         )
       )
       AND delivery.attempt_count < ?
       AND preference.push_enabled = 1
       AND subscription.disabled_at IS NULL
       AND (
         subscription.expiration_time IS NULL
         OR subscription.expiration_time > ?
       )
     ORDER BY
       CASE WHEN delivery.status = 'retry' THEN 0 ELSE 1 END,
       COALESCE(delivery.next_attempt_at, delivery.created_at),
       delivery.id
     LIMIT ?`,
    [
      nowSql,
      MAX_ATTEMPTS,
      now.getTime(),
      READY_FETCH_LIMIT,
    ],
  ).all<DeliveryRow>();

  const selectedRows = roundRobinDeliveries(
    dueRows.results,
    MAX_DELIVERIES_PER_RUN,
  );
  totals.deferred = Math.max(0, dueRows.results.length - selectedRows.length);
  const reminderCache = new Map<string, Promise<Reminder[]>>();
  for (
    let index = 0;
    index < selectedRows.length;
    index += DELIVERY_CONCURRENCY
  ) {
    const chunk = selectedRows.slice(
      index,
      index + DELIVERY_CONCURRENCY,
    );
    const outcomes = await Promise.all(
      chunk.map(async (row) => {
        const reminder = await activeReminderForDelivery(
          database,
          row,
          now,
          reminderCache,
        );
        if (!reminder) {
          const cancelled = await query(
            database,
            `UPDATE push_delivery_ledger
             SET status = 'cancelled',
                 error_code = 'reminder_occurrence_inactive',
                 next_attempt_at = NULL,
                 updated_at = ?
             WHERE id = ? AND status IN ('pending', 'retry')`,
            [nowSql, row.deliveryId],
          ).run();
          totals.cancelled += changes(cancelled);
          return "continue" as const;
        }
        return deliver(
          database,
          row,
          validConfig,
          now,
          fetcher,
          totals,
        );
      }),
    );
    if (outcomes.includes("stop")) {
      totals.deferred += Math.max(
        0,
        selectedRows.length - index - chunk.length,
      );
      break;
    }
  }

  const subscriptionCutoff = sqlTimestamp(
    addMilliseconds(now, -90 * 24 * 60 * 60_000),
  );
  await query(
    database,
    `DELETE FROM push_subscriptions
     WHERE disabled_at IS NOT NULL
       AND disabled_at < ?`,
    [subscriptionCutoff],
  ).run();
  return totals;
}
