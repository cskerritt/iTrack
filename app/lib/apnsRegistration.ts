export type ApnsEnvironment = "production" | "sandbox";

export type RegisterApnsDeviceInput = {
  userId: string;
  /** Validated below rather than typed as `string`: this is the "testable
   * core" behind an API route, so untrusted JSON fields arrive as `unknown`. */
  deviceToken: unknown;
  environment?: unknown;
  deviceLabel?: unknown;
};

export type RegisterApnsDeviceResult = {
  id: string;
  created: boolean;
};

const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9]+$/;
const MAX_DEVICE_TOKEN_LENGTH = 200;
const MAX_DEVICE_LABEL_LENGTH = 120;

export class ApnsRegistrationError extends Error {
  constructor(
    message: string,
    readonly code: string = "invalid_request",
  ) {
    super(message);
  }
}

function normalizeDeviceToken(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ApnsRegistrationError(
      "deviceToken is required",
      "invalid_device_token",
    );
  }
  if (value.length > MAX_DEVICE_TOKEN_LENGTH) {
    throw new ApnsRegistrationError(
      `deviceToken must be ${MAX_DEVICE_TOKEN_LENGTH} characters or fewer`,
      "invalid_device_token",
    );
  }
  // The same charset the sender enforces (hex-ish alphanumeric APNs device
  // tokens) — reject early what could never be sent to Apple anyway.
  if (!DEVICE_TOKEN_PATTERN.test(value)) {
    throw new ApnsRegistrationError(
      "deviceToken must contain only letters and digits",
      "invalid_device_token",
    );
  }
  return value;
}

function normalizeEnvironment(value: unknown): ApnsEnvironment {
  if (value === undefined || value === null) return "production";
  if (value === "production" || value === "sandbox") return value;
  throw new ApnsRegistrationError(
    'environment must be "production" or "sandbox"',
    "invalid_environment",
  );
}

function normalizeDeviceLabel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ApnsRegistrationError(
      "deviceLabel must be a string",
      "invalid_device_label",
    );
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_DEVICE_LABEL_LENGTH);
}

function query(
  database: D1Database,
  sql: string,
  bindings: readonly unknown[] = [],
) {
  return database.prepare(sql).bind(...bindings);
}

/**
 * Registers (or re-registers) a device token for APNs push. This call is the
 * opt-in signal for the channel: unlike web push, there is no
 * `push_enabled` gate consulted at delivery time (see apnsDelivery.ts) — a
 * device row existing and not disabled is sufficient to receive reminders.
 *
 * A device token is unique across the whole table, not per user: if the
 * token already exists, this is an upsert rather than an insert. A second
 * user registering the same token (a shared or reissued device) reassigns
 * it to them, and a token coming back from a disabled state (app
 * reinstalled, notifications re-enabled) has its `disabledAt` cleared and
 * `failureCount` reset to zero so it can resurrect rather than staying
 * retired.
 */
export async function registerApnsDevice(
  database: D1Database,
  input: RegisterApnsDeviceInput,
): Promise<RegisterApnsDeviceResult> {
  const deviceToken = normalizeDeviceToken(input.deviceToken);
  const environment = normalizeEnvironment(input.environment);
  const deviceLabel = normalizeDeviceLabel(input.deviceLabel);

  const existing = await query(
    database,
    `SELECT id FROM apns_devices WHERE device_token = ?`,
    [deviceToken],
  ).first<{ id: string }>();
  const id = existing?.id ?? crypto.randomUUID();

  await query(
    database,
    `INSERT INTO apns_devices (
       id, user_id, device_token, environment, device_label
     )
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (device_token) DO UPDATE SET
       user_id = excluded.user_id,
       environment = excluded.environment,
       device_label = excluded.device_label,
       failure_count = 0,
       disabled_at = NULL,
       last_seen_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP`,
    [id, input.userId, deviceToken, environment, deviceLabel],
  ).run();

  return { id, created: !existing };
}
