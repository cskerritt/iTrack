export type SavedActivityDraft = {
  version: 1;
  savedAt: string;
  credentialId: string;
  title: string;
  completionDate: string;
  totalUnits: string;
  allocatedUnits: string;
  provider: string;
};

export type ActivityDraftInput = Omit<
  SavedActivityDraft,
  "version" | "savedAt"
>;

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1_000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DRAFT_NAMESPACE_PATTERN = /^draft_[0-9a-f]{64}$/;
const MAX_RECOVERABLE_TEXT_LENGTH = 10_000;
const MAX_RECOVERABLE_SHORT_FIELD_LENGTH = 160;
export const ACTIVITY_DRAFT_TITLE_MAX_LENGTH = 180;
export const ACTIVITY_DRAFT_PROVIDER_MAX_LENGTH = 180;
export const ACTIVITY_DRAFT_MAX_UNITS = 10_000;

function legacyStableFingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (const character of value.trim().toLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// The "license-lantern:" localStorage prefix predates the iTrack product
// name and is load-bearing: renaming it would strand every draft already
// saved in a user's browser. Leave it as-is.
export function legacyActivityDraftStorageKey(ownerEmail: string) {
  return `license-lantern:activity-draft:v1:${legacyStableFingerprint(
    ownerEmail,
  )}`;
}

export function activityDraftStorageKey(draftStorageNamespace: string) {
  if (!DRAFT_NAMESPACE_PATTERN.test(draftStorageNamespace)) {
    throw new Error("The activity draft namespace is invalid.");
  }
  return `license-lantern:activity-draft:v1:${draftStorageNamespace}`;
}

export function hasMeaningfulActivityDraft(
  value: Pick<ActivityDraftInput, "title" | "totalUnits" | "provider">,
) {
  return Boolean(
    value.title.trim() || value.totalUnits.trim() || value.provider.trim(),
  );
}

function validDate(value: string) {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function recoverString(value: unknown, maximumLength: number) {
  return typeof value === "string" && value.length <= maximumLength
    ? value
    : "";
}

function boundedString(value: unknown, maximumLength: number) {
  return typeof value === "string" ? value.slice(0, maximumLength) : "";
}

function recoverDate(value: unknown) {
  if (value === "") return "";
  return typeof value === "string" && validDate(value) ? value : "";
}

function recoverUnits(value: unknown) {
  if (value === "") return "";
  if (
    typeof value !== "string" ||
    value.length > MAX_RECOVERABLE_SHORT_FIELD_LENGTH
  ) {
    return "";
  }
  const numericUnits = Number(value);
  return Number.isFinite(numericUnits) &&
    numericUnits > 0 &&
    numericUnits <= ACTIVITY_DRAFT_MAX_UNITS
    ? value
    : "";
}

export function serializeActivityDraft(
  value: ActivityDraftInput,
  savedAt = new Date(),
) {
  if (Number.isNaN(savedAt.getTime())) {
    throw new Error("The draft timestamp is invalid.");
  }
  const payload: SavedActivityDraft = {
    version: 1,
    savedAt: savedAt.toISOString(),
    credentialId: boundedString(
      value.credentialId,
      MAX_RECOVERABLE_SHORT_FIELD_LENGTH,
    ),
    title: boundedString(value.title, MAX_RECOVERABLE_TEXT_LENGTH),
    completionDate: recoverDate(value.completionDate),
    totalUnits: recoverUnits(value.totalUnits),
    allocatedUnits: recoverUnits(value.allocatedUnits),
    provider: boundedString(value.provider, MAX_RECOVERABLE_TEXT_LENGTH),
  };
  return JSON.stringify(payload);
}

export function parseActivityDraft(
  serialized: string | null,
  now = new Date(),
): SavedActivityDraft | null {
  if (!serialized || Number.isNaN(now.getTime())) return null;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;

  const candidate = value as Partial<SavedActivityDraft>;
  const savedAt = new Date(candidate.savedAt ?? "");
  if (
    candidate.version !== 1 ||
    Number.isNaN(savedAt.getTime()) ||
    savedAt.getTime() < now.getTime() - THIRTY_DAYS ||
    savedAt.getTime() > now.getTime() + 5 * 60 * 1_000
  ) {
    return null;
  }

  const recovered: SavedActivityDraft = {
    version: 1,
    savedAt: savedAt.toISOString(),
    credentialId: recoverString(
      candidate.credentialId,
      MAX_RECOVERABLE_SHORT_FIELD_LENGTH,
    ),
    // Recovery keeps over-limit text intact so the user can shorten it; the
    // form and API enforce the tighter submission limits for new input.
    title: recoverString(candidate.title, MAX_RECOVERABLE_TEXT_LENGTH),
    completionDate: recoverDate(candidate.completionDate),
    totalUnits: recoverUnits(candidate.totalUnits),
    allocatedUnits: recoverUnits(candidate.allocatedUnits),
    provider: recoverString(candidate.provider, MAX_RECOVERABLE_TEXT_LENGTH),
  };
  if (
    !hasMeaningfulActivityDraft({
      title: recovered.title,
      totalUnits: recovered.totalUnits,
      provider: recovered.provider,
    })
  ) {
    return null;
  }

  return recovered;
}

export function activityDraftShouldBePurged(
  serialized: string | null,
  now = new Date(),
) {
  return Boolean(serialized && !parseActivityDraft(serialized, now));
}
