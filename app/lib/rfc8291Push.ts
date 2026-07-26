export type PushSubscription = {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    auth: string;
    p256dh: string;
  };
};

export type WebPushConfig = {
  publicKey?: string;
  privateKey?: string;
  subject?: string;
};

export type ValidWebPushConfig = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

export type WebPushUrgency = "very-low" | "low" | "normal" | "high";

export type Rfc8291EncryptionOptions = {
  salt?: Uint8Array;
  ephemeralKeyPair?: CryptoKeyPair;
};

export type WebPushRequestOptions = {
  ttl?: number;
  urgency?: WebPushUrgency;
  topic?: string;
  now?: number;
  timeoutMilliseconds?: number;
  encryption?: Rfc8291EncryptionOptions;
};

export type Rfc8291EncryptedPayload = {
  body: Uint8Array;
  salt: Uint8Array;
  senderPublicKey: Uint8Array;
};

export type VapidAuthorization = {
  authorization: string;
  token: string;
  expiration: number;
};

export type BuiltWebPushRequest = {
  endpoint: string;
  init: RequestInit;
};

export class WebPushError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WebPushError";
    this.code = code;
  }
}

export const RFC8291_RECORD_SIZE = 4_096;
export const RFC8291_MAX_PAYLOAD_BYTES = 3_993;

const RFC8291_HEADER_BYTES = 16 + 4 + 1 + 65;
const VAPID_LIFETIME_SECONDS = 12 * 60 * 60;
const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 15_000;
const MAX_REQUEST_TIMEOUT_MILLISECONDS = 120_000;
const textEncoder = new TextEncoder();
const webPushInfo = textEncoder.encode("WebPush: info\0");
const contentEncryptionKeyInfo = textEncoder.encode(
  "Content-Encoding: aes128gcm\0",
);
const nonceInfo = textEncoder.encode("Content-Encoding: nonce\0");
const vapidHeader = encodeBase64Url(
  textEncoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })),
);

function fail(code: string, message: string): never {
  throw new WebPushError(code, message);
}

function copiedArrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function concatenate(...values: Uint8Array[]) {
  const byteLength = values.reduce(
    (total, value) => total + value.byteLength,
    0,
  );
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function encodeBase64Url(value: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < value.byteLength; offset += 1) {
    binary += String.fromCharCode(value[offset]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function decodeBase64Url(value: string, field = "value") {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]*$/.test(value) ||
    value.length % 4 === 1
  ) {
    return fail("invalid_base64url", `${field} is not canonical base64url.`);
  }
  let decoded: string;
  try {
    decoded = atob(
      value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "="),
    );
  } catch {
    return fail("invalid_base64url", `${field} is not canonical base64url.`);
  }
  const bytes = Uint8Array.from(
    decoded,
    (character) => character.charCodeAt(0),
  );
  if (encodeBase64Url(bytes) !== value) {
    return fail("invalid_base64url", `${field} is not canonical base64url.`);
  }
  return bytes;
}

function validSubject(subject: string) {
  if (
    !subject ||
    subject.length > 240 ||
    /[\u0000-\u001f\u007f]/.test(subject)
  ) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(subject);
  } catch {
    return false;
  }
  if (url.protocol === "mailto:") {
    return Boolean(url.pathname);
  }
  return (
    url.protocol === "https:" &&
    Boolean(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.hash
  );
}

export function normalizeWebPushConfig(
  config: WebPushConfig,
): ValidWebPushConfig | null {
  const publicKey = config.publicKey?.trim() ?? "";
  const privateKey = config.privateKey?.trim() ?? "";
  const subject = config.subject?.trim() ?? "";
  let publicKeyBytes: Uint8Array;
  let privateKeyBytes: Uint8Array;
  try {
    publicKeyBytes = decodeBase64Url(publicKey, "VAPID public key");
    privateKeyBytes = decodeBase64Url(privateKey, "VAPID private key");
  } catch {
    return null;
  }
  if (
    publicKeyBytes.byteLength !== 65 ||
    publicKeyBytes[0] !== 4 ||
    privateKeyBytes.byteLength !== 32 ||
    !validSubject(subject)
  ) {
    return null;
  }
  return { publicKey, privateKey, subject };
}

function permittedEndpointHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  const isDomainOrSubdomain = (root: string) =>
    normalized === root || normalized.endsWith(`.${root}`);
  return (
    normalized === "fcm.googleapis.com" ||
    normalized === "updates.push.services.mozilla.com" ||
    normalized === "push.services.mozilla.com" ||
    normalized === "web.push.apple.com" ||
    isDomainOrSubdomain("notify.windows.com")
  );
}

export function validatePushEndpoint(value: string) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > 4_096
  ) {
    return fail("invalid_endpoint", "The push endpoint is invalid.");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return fail("invalid_endpoint", "The push endpoint is invalid.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.port ||
    !permittedEndpointHostname(endpoint.hostname)
  ) {
    return fail(
      "invalid_endpoint",
      "The push endpoint is not a supported browser push service.",
    );
  }
  return endpoint;
}

type ValidatedPushSubscription = {
  endpoint: URL;
  expirationTime: number | null;
  userAgentPublicKey: CryptoKey;
  userAgentPublicKeyBytes: Uint8Array;
  authenticationSecret: Uint8Array;
};

export async function validatePushSubscription(
  subscription: PushSubscription,
  now = Date.now(),
): Promise<ValidatedPushSubscription> {
  if (!Number.isFinite(now)) {
    return fail("invalid_time", "The current time is invalid.");
  }
  const endpoint = validatePushEndpoint(subscription.endpoint);
  const expirationTime = subscription.expirationTime;
  if (
    expirationTime !== null &&
    (!Number.isFinite(expirationTime) || expirationTime < 0)
  ) {
    return fail(
      "malformed_subscription",
      "The push subscription expiration is invalid.",
    );
  }
  if (expirationTime !== null && expirationTime <= now) {
    return fail("expired_subscription", "The push subscription has expired.");
  }

  const userAgentPublicKeyBytes = decodeBase64Url(
    subscription.keys.p256dh,
    "subscription p256dh",
  );
  const authenticationSecret = decodeBase64Url(
    subscription.keys.auth,
    "subscription auth",
  );
  if (
    userAgentPublicKeyBytes.byteLength !== 65 ||
    userAgentPublicKeyBytes[0] !== 4 ||
    authenticationSecret.byteLength !== 16
  ) {
    return fail(
      "malformed_subscription",
      "The push subscription keys have invalid lengths.",
    );
  }

  let userAgentPublicKey: CryptoKey;
  try {
    userAgentPublicKey = await crypto.subtle.importKey(
      "raw",
      copiedArrayBuffer(userAgentPublicKeyBytes),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
  } catch {
    return fail(
      "malformed_subscription",
      "The push subscription public key is invalid.",
    );
  }

  return {
    endpoint,
    expirationTime,
    userAgentPublicKey,
    userAgentPublicKeyBytes,
    authenticationSecret,
  };
}

type ValidatedVapidConfig = ValidWebPushConfig & {
  publicKeyBytes: Uint8Array;
  signingKey: CryptoKey;
};

let cachedVapidConfig:
  | {
      publicKey: string;
      privateKey: string;
      subject: string;
      promise: Promise<ValidatedVapidConfig>;
    }
  | undefined;

async function importVapidConfig(config: ValidWebPushConfig) {
  const publicKeyBytes = decodeBase64Url(
    config.publicKey,
    "VAPID public key",
  );
  const privateKeyBytes = decodeBase64Url(
    config.privateKey,
    "VAPID private key",
  );
  let verificationKey: CryptoKey;
  let signingKey: CryptoKey;
  try {
    verificationKey = await crypto.subtle.importKey(
      "raw",
      copiedArrayBuffer(publicKeyBytes),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    signingKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: encodeBase64Url(publicKeyBytes.slice(1, 33)),
        y: encodeBase64Url(publicKeyBytes.slice(33, 65)),
        d: encodeBase64Url(privateKeyBytes),
        ext: false,
        key_ops: ["sign"],
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    return fail("invalid_vapid_keys", "The VAPID key material is invalid.");
  }

  const probe = textEncoder.encode("RFC 8292 VAPID key validation");
  try {
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        signingKey,
        copiedArrayBuffer(probe),
      ),
    );
    const matches =
      signature.byteLength === 64 &&
      (await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verificationKey,
        copiedArrayBuffer(signature),
        copiedArrayBuffer(probe),
      ));
    if (!matches) {
      return fail(
        "invalid_vapid_keys",
        "The VAPID public and private keys do not match.",
      );
    }
  } catch (error) {
    if (error instanceof WebPushError) throw error;
    return fail("invalid_vapid_keys", "The VAPID key material is invalid.");
  }

  return { ...config, publicKeyBytes, signingKey };
}

async function validatedVapidConfig(config: WebPushConfig) {
  const normalized = normalizeWebPushConfig(config);
  if (!normalized) {
    return fail(
      "invalid_vapid_config",
      "The VAPID configuration is incomplete or invalid.",
    );
  }
  if (
    cachedVapidConfig?.publicKey === normalized.publicKey &&
    cachedVapidConfig.privateKey === normalized.privateKey &&
    cachedVapidConfig.subject === normalized.subject
  ) {
    return cachedVapidConfig.promise;
  }
  const promise = importVapidConfig(normalized);
  cachedVapidConfig = { ...normalized, promise };
  try {
    return await promise;
  } catch (error) {
    if (cachedVapidConfig?.promise === promise) cachedVapidConfig = undefined;
    throw error;
  }
}

async function deriveHkdf(
  inputKeyMaterial: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  byteLength: number,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    copiedArrayBuffer(inputKeyMaterial),
    "HKDF",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: copiedArrayBuffer(salt),
        info: copiedArrayBuffer(info),
      },
      key,
      byteLength * 8,
    ),
  );
}

async function ephemeralKeyPair(options: Rfc8291EncryptionOptions) {
  if (options.ephemeralKeyPair) return options.ephemeralKeyPair;
  return (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  )) as CryptoKeyPair;
}

export async function encryptRfc8291Payload(
  payload: Uint8Array,
  userAgentPublicKeyBytes: Uint8Array,
  authenticationSecret: Uint8Array,
  options: Rfc8291EncryptionOptions = {},
): Promise<Rfc8291EncryptedPayload> {
  if (payload.byteLength > RFC8291_MAX_PAYLOAD_BYTES) {
    return fail(
      "payload_too_large",
      `The push payload exceeds ${RFC8291_MAX_PAYLOAD_BYTES} bytes.`,
    );
  }
  if (
    userAgentPublicKeyBytes.byteLength !== 65 ||
    userAgentPublicKeyBytes[0] !== 4 ||
    authenticationSecret.byteLength !== 16
  ) {
    return fail(
      "malformed_subscription",
      "The push subscription keys have invalid lengths.",
    );
  }

  const salt = options.salt
    ? Uint8Array.from(options.salt)
    : crypto.getRandomValues(new Uint8Array(16));
  if (salt.byteLength !== 16) {
    return fail("invalid_salt", "The RFC 8291 salt must be 16 bytes.");
  }

  let userAgentPublicKey: CryptoKey;
  try {
    userAgentPublicKey = await crypto.subtle.importKey(
      "raw",
      copiedArrayBuffer(userAgentPublicKeyBytes),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
  } catch {
    return fail(
      "malformed_subscription",
      "The push subscription public key is invalid.",
    );
  }

  const senderKeyPair = await ephemeralKeyPair(options);
  let senderPublicKey: Uint8Array;
  let sharedSecret: Uint8Array;
  try {
    senderPublicKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", senderKeyPair.publicKey),
    );
    sharedSecret = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "ECDH", public: userAgentPublicKey },
        senderKeyPair.privateKey,
        256,
      ),
    );
  } catch {
    return fail(
      "invalid_sender_key",
      "The RFC 8291 ephemeral key pair is invalid.",
    );
  }
  if (senderPublicKey.byteLength !== 65 || senderPublicKey[0] !== 4) {
    return fail(
      "invalid_sender_key",
      "The RFC 8291 sender public key is invalid.",
    );
  }
  if (equalBytes(senderPublicKey, userAgentPublicKeyBytes)) {
    return fail(
      "sender_key_reuse",
      "The sender and subscription keys must be different.",
    );
  }

  const keyInfo = concatenate(
    webPushInfo,
    userAgentPublicKeyBytes,
    senderPublicKey,
  );
  const inputKeyMaterial = await deriveHkdf(
    sharedSecret,
    authenticationSecret,
    keyInfo,
    32,
  );
  const contentEncryptionKey = await deriveHkdf(
    inputKeyMaterial,
    salt,
    contentEncryptionKeyInfo,
    16,
  );
  const nonce = await deriveHkdf(inputKeyMaterial, salt, nonceInfo, 12);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    copiedArrayBuffer(contentEncryptionKey),
    { name: "AES-GCM", length: 128 },
    false,
    ["encrypt"],
  );

  const record = new Uint8Array(payload.byteLength + 1);
  record.set(payload);
  record[record.byteLength - 1] = 2;
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: copiedArrayBuffer(nonce),
        tagLength: 128,
      },
      aesKey,
      copiedArrayBuffer(record),
    ),
  );

  const body = new Uint8Array(RFC8291_HEADER_BYTES + ciphertext.byteLength);
  body.set(salt, 0);
  new DataView(body.buffer).setUint32(16, RFC8291_RECORD_SIZE, false);
  body[20] = senderPublicKey.byteLength;
  body.set(senderPublicKey, 21);
  body.set(ciphertext, RFC8291_HEADER_BYTES);
  return { body, salt, senderPublicKey };
}

async function signVapidToken(
  endpoint: URL,
  config: ValidatedVapidConfig,
  now: number,
): Promise<VapidAuthorization> {
  if (!Number.isFinite(now)) {
    return fail("invalid_time", "The current time is invalid.");
  }
  const expiration = Math.floor(now / 1_000) + VAPID_LIFETIME_SECONDS;
  const claims = encodeBase64Url(
    textEncoder.encode(
      JSON.stringify({
        aud: endpoint.origin,
        exp: expiration,
        sub: config.subject,
      }),
    ),
  );
  const signingInput = `${vapidHeader}.${claims}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      config.signingKey,
      copiedArrayBuffer(textEncoder.encode(signingInput)),
    ),
  );
  if (signature.byteLength !== 64) {
    return fail(
      "invalid_vapid_signature",
      "The Web Crypto implementation returned an invalid ES256 signature.",
    );
  }
  const token = `${signingInput}.${encodeBase64Url(signature)}`;
  return {
    authorization: `vapid t=${token},k=${config.publicKey}`,
    token,
    expiration,
  };
}

export async function createVapidAuthorization(
  endpointValue: string,
  config: WebPushConfig,
  now = Date.now(),
) {
  const endpoint = validatePushEndpoint(endpointValue);
  const validatedConfig = await validatedVapidConfig(config);
  return signVapidToken(endpoint, validatedConfig, now);
}

function normalizedTtl(
  ttl: number,
  expirationTime: number | null,
  now: number,
) {
  if (!Number.isSafeInteger(ttl) || ttl < 0) {
    return fail("invalid_ttl", "The push TTL must be a non-negative integer.");
  }
  if (expirationTime === null) return ttl;
  return Math.min(ttl, Math.max(0, Math.floor((expirationTime - now) / 1_000)));
}

export async function buildRfc8291WebPushRequest(
  subscription: PushSubscription,
  config: WebPushConfig,
  payload: Uint8Array,
  options: WebPushRequestOptions = {},
): Promise<BuiltWebPushRequest> {
  const now = options.now ?? Date.now();
  const validatedSubscription = await validatePushSubscription(
    subscription,
    now,
  );
  const validatedConfig = await validatedVapidConfig(config);
  const ttl = normalizedTtl(
    options.ttl ?? 86_400,
    validatedSubscription.expirationTime,
    now,
  );
  const urgency = options.urgency;
  if (
    urgency !== undefined &&
    !["very-low", "low", "normal", "high"].includes(urgency)
  ) {
    return fail("invalid_urgency", "The push urgency is invalid.");
  }
  const topic = options.topic;
  if (
    topic !== undefined &&
    !/^[A-Za-z0-9_-]{1,32}$/.test(topic)
  ) {
    return fail(
      "invalid_topic",
      "The push topic must be 1-32 URL-safe base64 characters.",
    );
  }

  const vapid = await signVapidToken(
    validatedSubscription.endpoint,
    validatedConfig,
    now,
  );
  const encrypted = await encryptRfc8291Payload(
    payload,
    validatedSubscription.userAgentPublicKeyBytes,
    validatedSubscription.authenticationSecret,
    options.encryption,
  );
  if (equalBytes(encrypted.senderPublicKey, validatedConfig.publicKeyBytes)) {
    return fail(
      "sender_key_reuse",
      "The VAPID and content-encryption keys must be different.",
    );
  }

  const headers: Record<string, string> = {
    Authorization: vapid.authorization,
    "Content-Encoding": "aes128gcm",
    TTL: ttl.toString(),
  };
  if (urgency) headers.Urgency = urgency;
  if (topic) headers.Topic = topic;
  return {
    endpoint: subscription.endpoint,
    init: {
      method: "POST",
      headers,
      body: copiedArrayBuffer(encrypted.body),
      redirect: "manual",
    },
  };
}

export async function sendRfc8291WebPush(
  subscription: PushSubscription,
  config: WebPushConfig,
  payload: Uint8Array,
  options: WebPushRequestOptions = {},
  fetcher: typeof fetch = fetch,
) {
  const timeoutMilliseconds =
    options.timeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MILLISECONDS;
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1 ||
    timeoutMilliseconds > MAX_REQUEST_TIMEOUT_MILLISECONDS
  ) {
    return fail(
      "invalid_timeout",
      `The push timeout must be 1-${MAX_REQUEST_TIMEOUT_MILLISECONDS} milliseconds.`,
    );
  }
  const request = await buildRfc8291WebPushRequest(
    subscription,
    config,
    payload,
    options,
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("Push service request timed out."),
    timeoutMilliseconds,
  );
  try {
    const response = await fetcher(request.endpoint, {
      ...request.init,
      signal: controller.signal,
    });
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // Status and headers are sufficient for Web Push delivery handling.
      }
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}
