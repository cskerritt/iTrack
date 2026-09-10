// Startup account bootstrap. AUTH_BOOTSTRAP_USERS="email:password[;...]"
// creates a VERIFIED account for each address that has no account yet, so an
// operator can sign in before transactional email exists. Existing rows are
// never modified, which makes the variable safe to leave set and safe to
// delete after the first boot. The password is read, hashed, and dropped —
// it is never logged and never echoed in an error.
import { EMAIL_RE } from "./auth-routes.mjs";

const MIN_PASSWORD_LENGTH = 10;

export function parseBootstrapUsers(raw) {
  const entries = [];
  for (const piece of String(raw ?? "").split(";")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      throw new Error("AUTH_BOOTSTRAP_USERS entries must look like email:password");
    }
    const email = trimmed.slice(0, colon).trim().toLowerCase();
    const password = trimmed.slice(colon + 1).trim();
    if (!EMAIL_RE.test(email)) {
      throw new Error("AUTH_BOOTSTRAP_USERS entry has an invalid email address");
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`AUTH_BOOTSTRAP_USERS password for ${email} must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    entries.push({ email, password });
  }
  return entries;
}

export function applyBootstrapUsers(store, entries, log = console.log) {
  const summary = { created: [], skipped: [] };
  for (const { email, password } of entries) {
    const result = store.createVerifiedUser({ email, displayName: null, password });
    if (result.created) {
      summary.created.push(email);
      log(`[auth] bootstrap created account ${email}`);
    } else {
      summary.skipped.push(email);
      log(`[auth] bootstrap skipped existing account ${email}`);
    }
  }
  return summary;
}
