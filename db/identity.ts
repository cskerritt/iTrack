export type RequestIdentity = {
  userId: string;
  email: string;
  displayName: string;
  isDemo: boolean;
};

const EMAIL_HEADER = "oai-authenticated-user-email";
const NAME_HEADER = "oai-authenticated-user-full-name";
const NAME_ENCODING_HEADER = "oai-authenticated-user-full-name-encoding";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";
// The app's product name is Vigilo, but the identifiers below predate the
// rename and are load-bearing: the demo email and the "license-lantern:"
// hash salt both feed stableUserId, so changing either would orphan every
// existing user's data. Leave them as-is.
const DEMO_EMAIL = "demo@local.license-lantern";

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function safeDecodeName(value: string | null, encoding: string | null) {
  if (!value || encoding !== PERCENT_ENCODED_UTF8) return null;
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded ? decoded.slice(0, 160) : null;
  } catch {
    return null;
  }
}

function displayNameFromEmail(email: string) {
  const localPart = email.split("@")[0] || "professional";
  const words = localPart
    .replace(/[._+-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.join(" ") || "Professional";
}

async function stableUserId(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(`license-lantern:${email}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `usr_${hex}`;
}

export async function resolveRequestIdentity(
  request: Request,
): Promise<RequestIdentity | null> {
  const requestUrl = new URL(request.url);
  const forwardedEmail = request.headers.get(EMAIL_HEADER)?.trim().toLowerCase();

  if (forwardedEmail) {
    const displayName =
      safeDecodeName(
        request.headers.get(NAME_HEADER),
        request.headers.get(NAME_ENCODING_HEADER),
      ) ?? displayNameFromEmail(forwardedEmail);
    return {
      userId: await stableUserId(forwardedEmail),
      email: forwardedEmail.slice(0, 320),
      displayName,
      isDemo: false,
    };
  }

  if (!isLocalHostname(requestUrl.hostname)) return null;

  return {
    userId: await stableUserId(DEMO_EMAIL),
    email: DEMO_EMAIL,
    displayName: "Alex Morgan",
    isDemo: true,
  };
}
