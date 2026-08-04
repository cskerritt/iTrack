import {
  normalizeApnsConfig,
  sendApnsNotification,
  type ApnsConfig,
  type ApnsSendOutcome,
} from "./apnsPush";
import {
  GENERIC_BODY,
  GENERIC_TITLE,
  type PushNotificationData,
} from "./pushDelivery";
import {
  loadReminderData,
  localReminderClock,
  type Reminder,
  validReminderTimeZone,
} from "./reminders";

type DeviceRow = {
  id: string;
  userId: string;
  deviceToken: string;
  timeZone: string;
  pushHourLocal: number;
};

type DeliveryRow = {
  deliveryId: string;
  userId: string;
  deviceId: string;
  deviceToken: string;
  reminderKey: string;
  scheduledFor: string;
  attemptCount: number;
};

export type ApnsDeliveryResult = {
  configured: boolean;
  /** Active devices scanned this run. */
  devices: number;
  /** Ledger rows created (or re-armed) for a due reminder occurrence. */
  materialized: number;
  delivered: number;
  /** Attempts Apple rejected; a row below the cap stays queued for the next run. */
  failed: number;
  /** Devices retired because Apple no longer knows their token. */
  disabled: number;
  /**
   * Ledger rows the queue still owes once this run has finished: pending,
   * inside the attempt cap, past the retry floor, and belonging to an enabled
   * device in this run's APNs environment — the same predicate the run itself
   * selects work with. A run that drains its queue reports 0, and so does one
   * whose only rows are waiting out the retry floor.
   */
  duePending: number;
};

const MAX_ATTEMPTS = 4;
const DEVICE_SCAN_BUDGET = 64;
const MAX_DELIVERIES_PER_RUN = 8;
// Shorter than the 15-minute cron so ordinary jitter never skips a retry,
// long enough that repeated manual runs cannot burn the attempt budget.
const RETRY_DELAY_MILLISECONDS = 10 * 60_000;
const STALE_CLAIM_MILLISECONDS = 30 * 60_000;
// An occurrence that spent its four attempts is parked for a day rather than
// re-armed on the next run: the cap has to mean something while Apple is
// failing, but a reminder whose scheduled date will not move for weeks must
// not be lost to an hour-long outage either.
const FAILED_RETRY_DELAY_MILLISECONDS = 24 * 60 * 60_000;
const DISABLED_DEVICE_RETENTION_MILLISECONDS = 90 * 24 * 60 * 60_000;
const DEFAULT_PUSH_HOUR_LOCAL = 9;
// The iOS app opens this path in its web view when the banner is tapped.
// No delivery id rides along: /api/workspace?delivery= resolves web-push
// ledger ids only, so an APNs id would answer the tap with "no longer
// available" instead of the reminder.
const LAUNCH_PATH = "/?view=today";

// The work this run can actually attempt. Both the due-row query and the
// end-of-run `duePending` count read from these two fragments rather than
// keeping their own copies: a count that drifted from the selection would
// make the stuck-queue signal report on a queue the run never looks at.
// Bindings, in order: MAX_ATTEMPTS, the retry floor, the APNs environment.
const DUE_DELIVERY_FROM = `FROM apns_delivery_ledger delivery
     JOIN apns_devices device
       ON device.id = delivery.device_id
       AND device.user_id = delivery.user_id`;
const DUE_DELIVERY_WHERE = `WHERE delivery.status = 'pending'
       AND delivery.attempt_count < ?
       AND (
         delivery.last_attempt_at IS NULL
         OR delivery.last_attempt_at <= ?
       )
       AND device.disabled_at IS NULL
       AND device.environment = ?`;

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

function safeNotificationTag(deliveryId: string) {
  return `ll-${deliveryId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80)}`;
}

function reminderNotification(deliveryId: string): PushNotificationData {
  return {
    title: GENERIC_TITLE,
    body: GENERIC_BODY,
    tag: safeNotificationTag(deliveryId),
    url: LAUNCH_PATH,
  };
}

async function claimDelivery(
  database: D1Database,
  row: DeliveryRow,
  nowSql: string,
) {
  const result = await query(
    database,
    `UPDATE apns_delivery_ledger
     SET status = 'sending',
         attempt_count = attempt_count + 1,
         last_attempt_at = ?,
         updated_at = ?
     WHERE id = ?
       AND status = 'pending'
       AND attempt_count < ?
       AND EXISTS (
         SELECT 1
         FROM apns_devices device
         WHERE device.id = apns_delivery_ledger.device_id
           AND device.user_id = apns_delivery_ledger.user_id
           AND device.disabled_at IS NULL
       )`,
    [nowSql, nowSql, row.deliveryId, MAX_ATTEMPTS],
  ).run();
  if (changes(result) === 0) return null;
  return { ...row, attemptCount: row.attemptCount + 1 };
}

async function markDelivered(
  database: D1Database,
  row: DeliveryRow,
  nowSql: string,
) {
  await database.batch([
    query(
      database,
      `UPDATE apns_delivery_ledger
       SET status = 'delivered',
           updated_at = ?
       WHERE id = ? AND status = 'sending'`,
      [nowSql, row.deliveryId],
    ),
    query(
      database,
      `UPDATE apns_devices
       SET failure_count = 0,
           last_success_at = ?,
           last_seen_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [nowSql, nowSql, nowSql, row.deviceId],
    ),
  ]);
}

async function markFailure(
  database: D1Database,
  row: DeliveryRow,
  nowSql: string,
) {
  // A row that has spent its budget stops here; anything below the cap simply
  // returns to the queue and is picked up once the retry delay has passed.
  const status = row.attemptCount >= MAX_ATTEMPTS ? "failed" : "pending";
  await database.batch([
    query(
      database,
      `UPDATE apns_delivery_ledger
       SET status = ?,
           updated_at = ?
       WHERE id = ? AND status = 'sending'`,
      [status, nowSql, row.deliveryId],
    ),
    query(
      database,
      `UPDATE apns_devices
       SET failure_count = failure_count + 1,
           last_failure_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [nowSql, nowSql, row.deviceId],
    ),
  ]);
}

async function disableDevice(
  database: D1Database,
  row: DeliveryRow,
  nowSql: string,
) {
  await database.batch([
    query(
      database,
      `UPDATE apns_devices
       SET disabled_at = ?,
           failure_count = failure_count + 1,
           last_failure_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [nowSql, nowSql, nowSql, row.deviceId],
    ),
    query(
      database,
      `UPDATE apns_delivery_ledger
       SET status = 'expired',
           updated_at = ?
       WHERE device_id = ?
         AND status IN ('pending', 'sending')`,
      [nowSql, row.deviceId],
    ),
  ]);
}

/**
 * Hands the row back untouched. The sender only throws for reasons no other
 * row would survive either — a misconfigured bundle id or send time, or the
 * transport itself being unavailable — so the attempt is refunded rather than
 * charged to a device that did nothing wrong.
 */
async function refundAttempt(
  database: D1Database,
  row: DeliveryRow,
  nowSql: string,
) {
  await query(
    database,
    `UPDATE apns_delivery_ledger
     SET status = 'pending',
         attempt_count = CASE
           WHEN attempt_count > 0 THEN attempt_count - 1
           ELSE 0
         END,
         updated_at = ?
     WHERE id = ? AND status = 'sending'`,
    [nowSql, row.deliveryId],
  ).run();
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
      channel: "apns",
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

async function deliver(
  database: D1Database,
  row: DeliveryRow,
  config: ApnsConfig,
  now: Date,
  sendImpl: typeof sendApnsNotification,
  totals: ApnsDeliveryResult,
): Promise<"continue" | "stop"> {
  const nowSql = sqlTimestamp(now);
  const claimed = await claimDelivery(database, row, nowSql);
  if (!claimed) return "continue";
  let outcome: ApnsSendOutcome;
  try {
    outcome = await sendImpl(
      claimed.deviceToken,
      reminderNotification(claimed.deliveryId),
      config,
      fetch,
      now.getTime(),
    );
  } catch {
    await refundAttempt(database, claimed, nowSql);
    return "stop";
  }
  if (outcome.unregistered) {
    await disableDevice(database, claimed, nowSql);
    totals.disabled += 1;
    return "continue";
  }
  if (outcome.ok) {
    await markDelivered(database, claimed, nowSql);
    totals.delivered += 1;
    return "continue";
  }
  await markFailure(database, claimed, nowSql);
  totals.failed += 1;
  return "continue";
}

/**
 * Mirrors `runScheduledPushDelivery`, one channel simpler: every due reminder
 * occurrence is materialized into `apns_delivery_ledger` (unique per device,
 * reminder and scheduled date, so a reminder alerts a device once), then the
 * queued rows are attempted up to `MAX_ATTEMPTS` times across runs.
 */
export async function runScheduledApnsDelivery({
  database,
  scheduledTime,
  config,
  sendImpl = sendApnsNotification,
}: {
  database: D1Database;
  scheduledTime: number;
  config: Partial<Record<string, string | undefined>>;
  sendImpl?: typeof sendApnsNotification;
}): Promise<ApnsDeliveryResult> {
  const totals: ApnsDeliveryResult = {
    configured: false,
    devices: 0,
    materialized: 0,
    delivered: 0,
    failed: 0,
    disabled: 0,
    duePending: 0,
  };
  const validConfig = normalizeApnsConfig(config);
  if (!validConfig) return totals;
  totals.configured = true;

  const now = new Date(
    Number.isFinite(scheduledTime) ? scheduledTime : Date.now(),
  );
  const nowSql = sqlTimestamp(now);
  const staleSql = sqlTimestamp(
    addMilliseconds(now, -STALE_CLAIM_MILLISECONDS),
  );
  const retrySql = sqlTimestamp(
    addMilliseconds(now, -RETRY_DELAY_MILLISECONDS),
  );
  const failedRetrySql = sqlTimestamp(
    addMilliseconds(now, -FAILED_RETRY_DELAY_MILLISECONDS),
  );
  await database.batch([
    query(
      database,
      `UPDATE apns_delivery_ledger
       SET status = 'pending',
           updated_at = ?
       WHERE status = 'sending'
         AND attempt_count < ?
         AND updated_at <= ?`,
      [nowSql, MAX_ATTEMPTS, staleSql],
    ),
    query(
      database,
      `UPDATE apns_delivery_ledger
       SET status = 'failed',
           updated_at = ?
       WHERE status = 'sending'
         AND attempt_count >= ?
         AND updated_at <= ?`,
      [nowSql, MAX_ATTEMPTS, staleSql],
    ),
    query(
      database,
      `UPDATE apns_delivery_ledger
       SET status = 'expired',
           updated_at = ?
       WHERE status IN ('pending', 'sending')
         AND device_id IN (
           SELECT id
           FROM apns_devices
           WHERE disabled_at IS NOT NULL
         )`,
      [nowSql],
    ),
  ]);

  const deviceRows = await query(
    database,
    `SELECT
       device.id,
       device.user_id AS userId,
       device.device_token AS deviceToken,
       COALESCE(preference.time_zone, 'UTC') AS timeZone,
       COALESCE(preference.push_hour_local, ?) AS pushHourLocal
     FROM apns_devices device
     LEFT JOIN reminder_preferences preference
       ON preference.user_id = device.user_id
     WHERE device.disabled_at IS NULL
       AND device.environment = ?
     ORDER BY device.updated_at, device.id
     LIMIT ?`,
    // A device registered against the other APNs environment is skipped
    // entirely rather than sent to this run's host: Apple answers such a token
    // with 400 BadDeviceToken, which is deliberately not treated as
    // unregistered, so the row would otherwise spend its four attempts and be
    // re-armed to spend four more every day forever.
    [DEFAULT_PUSH_HOUR_LOCAL, validConfig.environment, DEVICE_SCAN_BUDGET],
  ).all<DeviceRow>();
  totals.devices = deviceRows.results.length;
  if (deviceRows.results.length > 0) {
    await query(
      database,
      `UPDATE apns_devices
       SET updated_at = ?
       WHERE id IN (${deviceRows.results.map(() => "?").join(", ")})`,
      [nowSql, ...deviceRows.results.map((device) => device.id)],
    ).run();
  }

  const devicesByUser = new Map<string, DeviceRow[]>();
  for (const device of deviceRows.results) {
    const existing = devicesByUser.get(device.userId) ?? [];
    existing.push(device);
    devicesByUser.set(device.userId, existing);
  }

  for (const [userId, devices] of devicesByUser) {
    const first = devices[0];
    const clock = localReminderClock(
      now,
      validReminderTimeZone(first.timeZone) ? first.timeZone : "UTC",
    );
    const pushHour = Number(first.pushHourLocal);
    if (
      clock.hour <
      (Number.isInteger(pushHour) ? pushHour : DEFAULT_PUSH_HOUR_LOCAL)
    ) {
      continue;
    }
    const reminderData = await loadReminderData(database, userId, {
      channel: "apns",
      now,
    });
    for (const device of devices) {
      for (const reminder of reminderData.reminders) {
        const deliveryId = crypto.randomUUID();
        const inserted = await query(
          database,
          `INSERT OR IGNORE INTO apns_delivery_ledger (
             id, user_id, device_id, reminder_key, scheduled_for,
             status, attempt_count
           )
           SELECT ?, ?, ?, ?, ?, 'pending', 0
           WHERE NOT EXISTS (
             SELECT 1
             FROM apns_delivery_ledger prior
             WHERE prior.device_id = ?
               AND prior.reminder_key = ?
               AND prior.scheduled_for >= ?
               AND prior.status NOT IN ('cancelled', 'expired', 'failed')
           )
           ON CONFLICT (device_id, reminder_key, scheduled_for)
           DO UPDATE SET
             status = 'pending',
             attempt_count = 0,
             last_attempt_at = NULL,
             updated_at = ?
           WHERE apns_delivery_ledger.status IN ('cancelled', 'expired')
              OR (
                apns_delivery_ledger.status = 'failed'
                AND (
                  apns_delivery_ledger.last_attempt_at IS NULL
                  OR apns_delivery_ledger.last_attempt_at <= ?
                )
              )`,
          [
            deliveryId,
            userId,
            device.id,
            reminder.key,
            reminder.scheduledFor,
            device.id,
            reminder.key,
            reminder.scheduledFor,
            nowSql,
            failedRetrySql,
          ],
        ).run();
        totals.materialized += changes(inserted);
      }
    }
  }

  const dueBindings = [MAX_ATTEMPTS, retrySql, validConfig.environment];
  const dueRows = await query(
    database,
    `SELECT
       delivery.id AS deliveryId,
       delivery.user_id AS userId,
       delivery.device_id AS deviceId,
       delivery.reminder_key AS reminderKey,
       delivery.scheduled_for AS scheduledFor,
       delivery.attempt_count AS attemptCount,
       device.device_token AS deviceToken
     ${DUE_DELIVERY_FROM}
     ${DUE_DELIVERY_WHERE}
     ORDER BY delivery.created_at, delivery.id
     LIMIT ?`,
    [...dueBindings, MAX_DELIVERIES_PER_RUN],
  ).all<DeliveryRow>();

  const reminderCache = new Map<string, Promise<Reminder[]>>();
  // Rows are attempted one at a time: a retired device expires the rest of its
  // own queue as it goes, so a later row for that device simply fails to claim.
  for (const row of dueRows.results) {
    const reminder = await activeReminderForDelivery(
      database,
      row,
      now,
      reminderCache,
    );
    if (!reminder) {
      await query(
        database,
        `UPDATE apns_delivery_ledger
         SET status = 'cancelled',
             updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        [nowSql, row.deliveryId],
      ).run();
      continue;
    }
    const outcome = await deliver(
      database,
      row,
      validConfig,
      now,
      sendImpl,
      totals,
    );
    if (outcome === "stop") break;
  }

  const deviceCutoff = sqlTimestamp(
    addMilliseconds(now, -DISABLED_DEVICE_RETENTION_MILLISECONDS),
  );
  await query(
    database,
    `DELETE FROM apns_devices
     WHERE disabled_at IS NOT NULL
       AND disabled_at < ?`,
    [deviceCutoff],
  ).run();

  // Counted last, so it reflects the statuses this run just wrote: a row
  // delivered, failed or refunded above carries this run's `last_attempt_at`
  // and is therefore inside the retry floor, leaving only the work that is
  // genuinely still waiting. A head-of-line throw stops the loop without
  // touching the rows behind it, so those stay counted here even though the
  // pending row blocks re-materialization and drives `materialized` to 0.
  const duePendingRow = await query(
    database,
    `SELECT COUNT(*) AS duePending
     ${DUE_DELIVERY_FROM}
     ${DUE_DELIVERY_WHERE}`,
    dueBindings,
  ).first<{ duePending: number }>();
  totals.duePending = Number(duePendingRow?.duePending ?? 0);
  return totals;
}
