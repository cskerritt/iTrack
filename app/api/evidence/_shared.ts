import { getD1, getEvidenceBucket } from "@/db";
import {
  type RequestIdentity,
  resolveRequestIdentity,
} from "@/db/identity";
import { ensureUser, initializeDatabase } from "@/db/runtime";

export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
export const MAX_EVIDENCE_PER_ACTIVITY = 12;

export class EvidenceApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid_request",
  ) {
    super(message);
  }
}

export type EvidenceContext = {
  database: D1Database;
  bucket: R2Bucket;
  identity: RequestIdentity;
};

export type EvidenceRow = {
  id: string;
  activityId: string;
  objectKey: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  storageEtag: string | null;
  createdAt: string;
};

export type PublicEvidence = {
  id: string;
  activityId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  downloadUrl: string;
};

export type DetectedFile = {
  contentType: "application/pdf" | "image/jpeg" | "image/png" | "image/webp";
  extension: "pdf" | "jpg" | "png" | "webp";
};

export function query(
  database: D1Database,
  sql: string,
  bindings: readonly unknown[] = [],
) {
  return database.prepare(sql).bind(...bindings);
}

export function jsonNoStore(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(data, { ...init, headers });
}

export function evidenceErrorResponse(error: unknown) {
  if (error instanceof EvidenceApiError) {
    return jsonNoStore(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error("Evidence API error", message);
  return jsonNoStore(
    {
      error: "Evidence storage is temporarily unavailable. Please try again.",
      code: "internal_error",
    },
    { status: 500 },
  );
}

export async function requireEvidenceContext(
  request: Request,
): Promise<EvidenceContext> {
  const identity = await resolveRequestIdentity(request);
  if (!identity) {
    throw new EvidenceApiError(
      "Sign in with ChatGPT to manage evidence files.",
      401,
      "authentication_required",
    );
  }

  const database = getD1();
  await initializeDatabase(database);
  await ensureUser(database, identity);
  return { database, bucket: getEvidenceBucket(), identity };
}

export function validateActivityId(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9_-]{1,160}$/.test(value)
  ) {
    throw new EvidenceApiError("activityId is invalid.");
  }
  return value;
}

export function validateEvidenceId(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new EvidenceApiError(
      "Evidence file not found.",
      404,
      "evidence_not_found",
    );
  }
  return value;
}

export async function evidenceIdFromContext(context: {
  params: Promise<{ id: string }> | { id: string };
}) {
  const params = await context.params;
  return validateEvidenceId(params.id);
}

export function toPublicEvidence(row: EvidenceRow): PublicEvidence {
  return {
    id: row.id,
    activityId: row.activityId,
    fileName: row.originalFilename,
    contentType: row.contentType,
    sizeBytes: Number(row.sizeBytes),
    sha256: row.sha256,
    createdAt: row.createdAt,
    downloadUrl: `/api/evidence/${encodeURIComponent(row.id)}/download`,
  };
}

export async function findOwnedEvidence(
  database: D1Database,
  userId: string,
  evidenceId: string,
) {
  return query(
    database,
    `SELECT
      id,
      activity_id AS activityId,
      object_key AS objectKey,
      original_filename AS originalFilename,
      content_type AS contentType,
      size_bytes AS sizeBytes,
      sha256,
      storage_etag AS storageEtag,
      created_at AS createdAt
    FROM evidence_files
    WHERE id = ? AND user_id = ? AND status = 'ready'`,
    [evidenceId, userId],
  ).first<EvidenceRow>();
}

export async function assertActivityEvidenceMutable(
  database: D1Database,
  userId: string,
  activityId: string,
) {
  const closedCycle = await query(
    database,
    `SELECT 1 AS isClosed
     FROM activity_allocations allocation
     JOIN credentials credential
       ON credential.id = allocation.credential_id
      AND credential.user_id = ?
     WHERE allocation.activity_id = ?
       AND credential.status = 'renewed'
     LIMIT 1`,
    [userId, activityId],
  ).first<{ isClosed: number }>();
  if (closedCycle) {
    throw new EvidenceApiError(
      "Evidence linked to an accepted renewal cycle cannot be changed.",
      409,
      "cycle_closed",
    );
  }
}

export function sanitizeFilename(value: string, detected: DetectedFile) {
  const leaf = value.split(/[\\/]/).pop() ?? "";
  let safe = leaf
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 180);
  if (!safe || safe === "." || safe === "..") {
    safe = `evidence.${detected.extension}`;
  }
  if (!safe.includes(".")) safe = `${safe}.${detected.extension}`;
  return safe;
}

export function detectFileType(bytes: Uint8Array): DetectedFile | null {
  const startsWith = (signature: number[]) =>
    signature.every((value, index) => bytes[index] === value);

  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return { contentType: "application/pdf", extension: "pdf" };
  }
  if (startsWith([0xff, 0xd8, 0xff])) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { contentType: "image/png", extension: "png" };
  }
  if (
    bytes.length >= 12 &&
    startsWith([0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { contentType: "image/webp", extension: "webp" };
  }
  return null;
}

export function validateClaimedMimeType(
  claimedType: string,
  detected: DetectedFile,
) {
  const normalized = claimedType.toLowerCase().split(";")[0].trim();
  if (!normalized || normalized === "application/octet-stream") return;
  const aliases: Record<string, string> = {
    "image/jpg": "image/jpeg",
    "image/pjpeg": "image/jpeg",
  };
  if ((aliases[normalized] ?? normalized) !== detected.contentType) {
    throw new EvidenceApiError(
      "The file contents do not match its reported type.",
      415,
      "file_type_mismatch",
    );
  }
}

export async function sha256(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return { digest, hex };
}

export function contentDisposition(filename: string) {
  const asciiFallback =
    filename
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_")
      .slice(0, 180) || "evidence";
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
