import { createApnsJwt, type ApnsJwtConfig } from "./apnsJwt";
import type { PushNotificationData } from "./pushDelivery";

export type ApnsEnvironment = "production" | "sandbox";

export type ApnsConfig = ApnsJwtConfig & {
  bundleId: string;
  environment: ApnsEnvironment;
};

export type ApnsSendOutcome = {
  ok: boolean;
  status: number;
  unregistered: boolean;
  reason: string | null;
};

const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};
// Apple's provider tokens are valid for an hour and must not be re-minted more
// than once every 20 minutes, so a single token is reused just inside the hour.
const TOKEN_REUSE_MILLISECONDS = 50 * 60_000;
const NOTIFICATION_LIFETIME_SECONDS = 86_400;
const REQUEST_TIMEOUT_MILLISECONDS = 15_000;
// Device tokens are hex from APNs, but stay permissive on the alphabet and
// strict about anything that could steer the request off /3/device/<token>.
const DEVICE_TOKEN = /^[A-Za-z0-9]{1,200}$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
const APNS_REASON = /^[A-Za-z0-9]{1,64}$/;

let cachedProviderToken:
  | (ApnsJwtConfig & { mintedAtMs: number; promise: Promise<string> })
  | undefined;

function trimmed(value: string | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

function validDeviceToken(deviceToken: string) {
  const token = trimmed(deviceToken);
  if (!DEVICE_TOKEN.test(token)) {
    throw new Error(
      "The APNs device token must be the alphanumeric token the device " +
        "registered with (1-200 characters).",
    );
  }
  return token;
}

function validTopic(bundleId: string) {
  const topic = trimmed(bundleId);
  if (!BUNDLE_ID.test(topic)) {
    throw new Error(
      "The APNs topic must be the app's bundle identifier, for example " +
        "com.kwvrs.itrack.",
    );
  }
  return topic;
}

/**
 * Mints the provider token, reusing the cached one while it is comfortably
 * inside Apple's one-hour lifetime. The cache is keyed on the signing material
 * so a rotated key never keeps sending the previous key's token.
 */
async function providerToken(config: ApnsJwtConfig, nowMs: number) {
  const cached = cachedProviderToken;
  if (
    cached &&
    cached.teamId === config.teamId &&
    cached.keyId === config.keyId &&
    cached.privateKeyPem === config.privateKeyPem &&
    nowMs >= cached.mintedAtMs &&
    nowMs - cached.mintedAtMs < TOKEN_REUSE_MILLISECONDS
  ) {
    return cached.promise;
  }
  const entry = {
    teamId: config.teamId,
    keyId: config.keyId,
    privateKeyPem: config.privateKeyPem,
    mintedAtMs: nowMs,
    promise: createApnsJwt(config, nowMs),
  };
  cachedProviderToken = entry;
  try {
    return await entry.promise;
  } catch (error) {
    if (cachedProviderToken === entry) cachedProviderToken = undefined;
    throw error;
  }
}

async function failureReason(response: Response) {
  let payload: string;
  try {
    payload = await response.text();
  } catch {
    return null;
  }
  let reason: unknown;
  try {
    reason = (JSON.parse(payload) as { reason?: unknown }).reason;
  } catch {
    return null;
  }
  if (typeof reason !== "string" || !APNS_REASON.test(reason)) return null;
  return reason;
}

async function discardBody(response: Response) {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // Status and headers are all the delivery ledger needs.
  }
}

/**
 * Delivers one alert to a single device over Apple's HTTP/2 push API.
 * Transport failures reject; APNs responses resolve to an outcome so callers
 * can retry, back off, or disable the device from the status alone.
 */
export async function sendApnsNotification(
  deviceToken: string,
  notification: PushNotificationData,
  config: ApnsConfig,
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<ApnsSendOutcome> {
  const token = validDeviceToken(deviceToken);
  const topic = validTopic(config.bundleId);
  if (!Number.isFinite(nowMs)) {
    throw new Error(
      "The APNs send time must be a finite epoch-milliseconds value.",
    );
  }
  const host = APNS_HOSTS[config.environment] ?? APNS_HOSTS.production;
  const jwt = await providerToken(config, nowMs);
  const body = JSON.stringify({
    aps: {
      alert: { title: notification.title, body: notification.body },
      sound: "default",
      "thread-id": notification.tag,
    },
    url: notification.url,
  });

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("APNs request timed out."),
    REQUEST_TIMEOUT_MILLISECONDS,
  );
  let response: Response;
  try {
    response = await fetchImpl(`${host}/3/device/${token}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${jwt}`,
        "apns-topic": topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(
          Math.floor(nowMs / 1_000) + NOTIFICATION_LIFETIME_SECONDS,
        ),
        "content-type": "application/json",
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (response.ok) {
    await discardBody(response);
    return {
      ok: true,
      status: response.status,
      unregistered: false,
      reason: null,
    };
  }
  const reason = await failureReason(response);
  return {
    ok: false,
    status: response.status,
    // 410 retires a token Apple no longer knows; 400 BadDeviceToken means the
    // token was never valid for this topic. Both must stop future sends.
    unregistered:
      response.status === 410 ||
      (response.status === 400 && reason === "BadDeviceToken"),
    reason,
  };
}

/**
 * Mirrors `normalizeWebPushConfig`: returns null when the channel is simply not
 * configured. Key material is only checked for presence here — `createApnsJwt`
 * is the authority on whether it can actually sign.
 */
export function normalizeApnsConfig(
  raw: Partial<Record<string, string | undefined>>,
): ApnsConfig | null {
  const teamId = trimmed(raw.teamId);
  const keyId = trimmed(raw.keyId);
  const privateKeyPem = trimmed(raw.privateKeyPem);
  const bundleId = trimmed(raw.bundleId);
  if (!teamId || !keyId || !privateKeyPem || !bundleId) return null;
  const environment = trimmed(raw.environment).toLowerCase();
  return {
    teamId,
    keyId,
    privateKeyPem,
    bundleId,
    environment:
      environment === "sandbox" || environment === "development"
        ? "sandbox"
        : "production",
  };
}
