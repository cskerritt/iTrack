export type PushDeviceState =
  | "checking"
  | "install_required"
  | "unconfigured"
  | "available"
  | "subscribed"
  | "denied"
  | "unsupported"
  | "error";

export type SerializedPushSubscription = {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

export type ReminderLaunchTarget = {
  deliveryId: string;
  path: string;
};

const ALLOWED_LAUNCH_PARAMETERS = new Set([
  "view",
  "delivery",
]);

export function isIosLike(
  navigatorValue: Pick<
    Navigator,
    "maxTouchPoints" | "platform" | "userAgent"
  > = window.navigator,
) {
  return (
    /iPad|iPhone|iPod/i.test(navigatorValue.userAgent) ||
    (navigatorValue.platform === "MacIntel" &&
      navigatorValue.maxTouchPoints > 1)
  );
}

export function installedDisplayMode() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    Boolean(
      (window.navigator as Navigator & { standalone?: boolean }).standalone,
    )
  );
}

export function detectedPushCapability(
  isStandalone: boolean,
): Exclude<
  PushDeviceState,
  "checking" | "unconfigured" | "subscribed" | "error"
> {
  if (typeof window === "undefined") return "unsupported";
  if (isIosLike(window.navigator) && !isStandalone) {
    return "install_required";
  }
  if (
    !window.isSecureContext ||
    !("serviceWorker" in window.navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return "unsupported";
  }
  return window.Notification.permission === "denied"
    ? "denied"
    : "available";
}

export function applicationServerKeyBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const decoded = window.atob(padded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export function pushSubscriptionUsesApplicationServerKey(
  subscription: PushSubscription,
  expectedKey: string,
) {
  const applicationServerKey = subscription.options.applicationServerKey;
  if (!applicationServerKey) return false;
  const actual = new Uint8Array(applicationServerKey);
  const expected = applicationServerKeyBytes(expectedKey);
  if (actual.byteLength !== expected.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < actual.byteLength; index += 1) {
    difference |= actual[index] ^ expected[index];
  }
  return difference === 0;
}

export function serializePushSubscription(
  subscription: PushSubscription,
): SerializedPushSubscription {
  const serialized = subscription.toJSON();
  const p256dh = serialized.keys?.p256dh;
  const auth = serialized.keys?.auth;
  if (!serialized.endpoint || !p256dh || !auth) {
    throw new Error("This browser returned an incomplete push subscription.");
  }
  return {
    endpoint: serialized.endpoint,
    expirationTime: serialized.expirationTime ?? null,
    keys: { p256dh, auth },
  };
}

export function safeReminderLaunchTarget(
  value: string,
  origin = window.location.origin,
): ReminderLaunchTarget | null {
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  if (
    url.origin !== origin ||
    url.pathname !== "/" ||
    url.hash ||
    [...url.searchParams.keys()].some(
      (parameter) => !ALLOWED_LAUNCH_PARAMETERS.has(parameter),
    )
  ) {
    return null;
  }
  if (
    url.searchParams.getAll("view").length !== 1 ||
    url.searchParams.get("view") !== "today" ||
    url.searchParams.getAll("delivery").length !== 1
  ) {
    return null;
  }
  const deliveryId = url.searchParams.get("delivery") ?? "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      deliveryId,
    )
  ) {
    return null;
  }
  const search = new URLSearchParams({
    view: "today",
    delivery: deliveryId,
  });
  return {
    deliveryId,
    path: `/?${search.toString()}`,
  };
}

export function friendlyDeviceLabel(
  navigatorValue: Pick<
    Navigator,
    "maxTouchPoints" | "platform" | "userAgent"
  > = window.navigator,
) {
  if (isIosLike(navigatorValue)) {
    return /iPad/i.test(navigatorValue.userAgent) ||
      (navigatorValue.platform === "MacIntel" &&
        navigatorValue.maxTouchPoints > 1)
      ? "This iPad"
      : "This iPhone";
  }
  if (/Android/i.test(navigatorValue.userAgent)) return "This Android device";
  return "This browser";
}

export function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
