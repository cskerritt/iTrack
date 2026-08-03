export type ApnsJwtConfig = {
  teamId: string;
  keyId: string;
  privateKeyPem: string;
};

const PKCS8_PEM =
  /^-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/;
const BASE64_BODY = /^[A-Za-z0-9+/]+={0,2}$/;
const APNS_IDENTIFIER = /^[A-Za-z0-9]{1,64}$/;
const textEncoder = new TextEncoder();

function copiedArrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function encodeBase64Url(value: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < value.byteLength; offset += 1) {
    binary += String.fromCharCode(value[offset]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function encodeJsonSegment(value: unknown) {
  return encodeBase64Url(textEncoder.encode(JSON.stringify(value)));
}

function apnsIdentifier(value: string, field: string) {
  const identifier = typeof value === "string" ? value.trim() : "";
  if (!APNS_IDENTIFIER.test(identifier)) {
    throw new Error(
      `The APNs ${field} must be the alphanumeric identifier shown in the Apple Developer portal.`,
    );
  }
  return identifier;
}

function decodePkcs8Pem(privateKeyPem: string) {
  const pem = typeof privateKeyPem === "string" ? privateKeyPem.trim() : "";
  const block = PKCS8_PEM.exec(pem);
  if (!block) {
    throw new Error(
      "The APNs private key must be a single unencrypted PKCS#8 PEM block between " +
        "-----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY----- (the .p8 file Apple issues); " +
        "convert an EC PRIVATE KEY or ENCRYPTED PRIVATE KEY block with `openssl pkcs8` first.",
    );
  }
  const base64 = block[1].replace(/\s+/g, "");
  if (base64.length % 4 !== 0 || !BASE64_BODY.test(base64)) {
    throw new Error(
      "The APNs private key PEM body is not valid base64; re-copy the .p8 file without editing it.",
    );
  }
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error(
      "The APNs private key PEM body is not valid base64; re-copy the .p8 file without editing it.",
    );
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importSigningKey(privateKeyPem: string) {
  const pkcs8 = decodePkcs8Pem(privateKeyPem);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      copiedArrayBuffer(pkcs8),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new Error(
      "The APNs private key is not a P-256 (prime256v1) signing key; download a fresh APNs auth key (.p8) from the Apple Developer portal.",
    );
  }
}

/**
 * Builds the ES256 provider token APNs expects in the `authorization` header.
 * The result is deterministic for a given `nowMs`, so callers cache it and
 * refresh well inside Apple's one-hour token lifetime.
 */
export async function createApnsJwt(
  config: ApnsJwtConfig,
  nowMs: number,
): Promise<string> {
  const teamId = apnsIdentifier(config.teamId, "team id");
  const keyId = apnsIdentifier(config.keyId, "key id");
  if (!Number.isFinite(nowMs)) {
    throw new Error(
      "The APNs token issue time must be a finite epoch-milliseconds value.",
    );
  }
  const signingKey = await importSigningKey(config.privateKeyPem);

  const signingInput = `${encodeJsonSegment({
    alg: "ES256",
    kid: keyId,
  })}.${encodeJsonSegment({ iss: teamId, iat: Math.floor(nowMs / 1_000) })}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signingKey,
      copiedArrayBuffer(textEncoder.encode(signingInput)),
    ),
  );
  if (signature.byteLength !== 64) {
    throw new Error(
      "The Web Crypto implementation returned an invalid ES256 signature.",
    );
  }
  return `${signingInput}.${encodeBase64Url(signature)}`;
}
