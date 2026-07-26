export type SavedActivityDraft = {
  version: 1;
  savedAt: string;
  credentialId: string;
  title: string;
  completionDate: string;
  totalUnits: string;
  provider: string;
};

export type ActivityDraftInput = Omit<
  SavedActivityDraft,
  "version" | "savedAt"
>;

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1_000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function stableFingerprint(value: string) {
  let hash = 0x811c9dc5;
  for (const character of value.trim().toLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function activityDraftStorageKey(ownerEmail: string) {
  return `license-lantern:activity-draft:v1:${stableFingerprint(ownerEmail)}`;
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

function validString(value: unknown, maximumLength: number) {
  return typeof value === "string" && value.length <= maximumLength;
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
    credentialId: value.credentialId.slice(0, 160),
    title: value.title.slice(0, 180),
    completionDate: value.completionDate,
    totalUnits: value.totalUnits.slice(0, 24),
    provider: value.provider.slice(0, 120),
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
    savedAt.getTime() > now.getTime() + 5 * 60 * 1_000 ||
    !validString(candidate.credentialId, 160) ||
    !validString(candidate.title, 180) ||
    !validString(candidate.provider, 120) ||
    !validString(candidate.totalUnits, 24) ||
    typeof candidate.completionDate !== "string" ||
    !validDate(candidate.completionDate)
  ) {
    return null;
  }
  const numericUnits = candidate.totalUnits
    ? Number(candidate.totalUnits)
    : null;
  if (
    numericUnits !== null &&
    (!Number.isFinite(numericUnits) || numericUnits <= 0 || numericUnits > 1_000)
  ) {
    return null;
  }
  if (
    !hasMeaningfulActivityDraft({
      title: candidate.title ?? "",
      totalUnits: candidate.totalUnits ?? "",
      provider: candidate.provider ?? "",
    })
  ) {
    return null;
  }

  return candidate as SavedActivityDraft;
}
