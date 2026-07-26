import {
  EvidenceApiError,
  MAX_EVIDENCE_BYTES,
  MAX_EVIDENCE_PER_ACTIVITY,
  assertOwnedActivityEvidenceMutable,
  detectFileType,
  evidenceErrorResponse,
  findOwnedEvidence,
  jsonNoStore,
  query,
  requireEvidenceContext,
  sanitizeFilename,
  sha256,
  toPublicEvidence,
  validateActivityId,
  validateClaimedMimeType,
  type EvidenceRow,
} from "./_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { database, identity } = await requireEvidenceContext(request);
    const requestedActivityId = new URL(request.url).searchParams.get(
      "activityId",
    );
    const activityId = requestedActivityId
      ? validateActivityId(requestedActivityId)
      : null;
    const result = activityId
      ? await query(
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
            created_at AS createdAt,
            status
          FROM evidence_files
          WHERE user_id = ?
            AND activity_id = ?
            AND status IN ('ready', 'deleting')
          ORDER BY created_at DESC, id DESC
          LIMIT 200`,
          [identity.userId, activityId],
        ).all<EvidenceRow>()
      : await query(
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
            created_at AS createdAt,
            status
          FROM evidence_files
          WHERE user_id = ? AND status IN ('ready', 'deleting')
          ORDER BY created_at DESC, id DESC
          LIMIT 200`,
          [identity.userId],
        ).all<EvidenceRow>();

    return jsonNoStore({
      evidence: result.results.map(toPublicEvidence),
    });
  } catch (error) {
    return evidenceErrorResponse(error);
  }
}

export async function POST(request: Request) {
  let uploadedObjectKey: string | null = null;
  let bucketForCleanup: R2Bucket | null = null;

  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      throw new EvidenceApiError(
        "Upload evidence using multipart/form-data.",
        415,
        "multipart_required",
      );
    }
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_EVIDENCE_BYTES + 1024 * 1024
    ) {
      throw new EvidenceApiError(
        "Evidence files must be 10 MiB or smaller.",
        413,
        "file_too_large",
      );
    }

    const { database, bucket, identity } =
      await requireEvidenceContext(request);
    bucketForCleanup = bucket;
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new EvidenceApiError(
        "The upload form could not be read.",
        400,
        "invalid_multipart",
      );
    }
    if (
      form.has("userId") ||
      form.has("user_id") ||
      form.has("ownerId") ||
      form.has("owner_id")
    ) {
      throw new EvidenceApiError(
        "User identity is derived from the authenticated request and cannot be supplied by the client.",
        400,
        "client_identity_forbidden",
      );
    }
    const activityId = validateActivityId(form.get("activityId"));
    const files = form.getAll("file");
    if (
      files.length !== 1 ||
      typeof files[0] === "string" ||
      !(files[0] instanceof File)
    ) {
      throw new EvidenceApiError(
        "Provide exactly one evidence file.",
        400,
        "file_required",
      );
    }
    const file = files[0];
    if (file.size <= 0) {
      throw new EvidenceApiError(
        "The evidence file is empty.",
        400,
        "empty_file",
      );
    }
    if (file.size > MAX_EVIDENCE_BYTES) {
      throw new EvidenceApiError(
        "Evidence files must be 10 MiB or smaller.",
        413,
        "file_too_large",
      );
    }

    await assertOwnedActivityEvidenceMutable(
      database,
      identity.userId,
      activityId,
    );

    const buffer = await file.arrayBuffer();
    const detected = detectFileType(
      new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 16)),
    );
    if (!detected) {
      throw new EvidenceApiError(
        "Use a PDF, JPEG, PNG, or WebP evidence file.",
        415,
        "unsupported_file_type",
      );
    }
    validateClaimedMimeType(file.type, detected);
    const safeFilename = sanitizeFilename(file.name, detected);
    const checksum = await sha256(buffer);
    const [count, duplicate] = await Promise.all([
      query(
        database,
        `SELECT COUNT(*) AS count
         FROM evidence_files
         WHERE user_id = ? AND activity_id = ? AND status = 'ready'`,
        [identity.userId, activityId],
      ).first<{ count: number }>(),
      query(
        database,
        `SELECT id
         FROM evidence_files
         WHERE user_id = ? AND activity_id = ? AND sha256 = ?
         LIMIT 1`,
        [identity.userId, activityId, checksum.hex],
      ).first<{ id: string }>(),
    ]);
    if (Number(count?.count ?? 0) >= MAX_EVIDENCE_PER_ACTIVITY) {
      throw new EvidenceApiError(
        `An activity can have up to ${MAX_EVIDENCE_PER_ACTIVITY} evidence files.`,
        409,
        "activity_file_limit",
      );
    }
    if (duplicate) {
      throw new EvidenceApiError(
        "That evidence file is already attached to this activity.",
        409,
        "duplicate_evidence",
      );
    }

    const evidenceId = crypto.randomUUID();
    uploadedObjectKey = `evidence/${identity.userId}/${activityId}/${evidenceId}`;
    const stored = await bucket.put(uploadedObjectKey, buffer, {
      httpMetadata: { contentType: detected.contentType },
      customMetadata: { evidenceId, activityId },
      sha256: checksum.digest,
    });
    if (!stored) {
      throw new Error("R2 did not confirm the evidence upload.");
    }

    try {
      const results = await database.batch([
        query(
          database,
          `INSERT INTO evidence_files (
            id, user_id, activity_id, object_key, original_filename,
            content_type, size_bytes, sha256, storage_etag, status
          )
          SELECT ?, ?, activity.id, ?, ?, ?, ?, ?, ?, 'ready'
          FROM activities activity
          WHERE activity.id = ?
            AND activity.user_id = ?
            AND activity.archived_at IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM activity_allocations allocation
              JOIN credentials credential
                ON credential.id = allocation.credential_id
              WHERE allocation.activity_id = activity.id
                AND credential.user_id = activity.user_id
                AND credential.status = 'renewed'
            )
            AND (
              SELECT COUNT(*)
              FROM evidence_files existing_evidence
              WHERE existing_evidence.activity_id = activity.id
                AND existing_evidence.user_id = activity.user_id
                AND existing_evidence.status = 'ready'
            ) < ?`,
          [
            evidenceId,
            identity.userId,
            uploadedObjectKey,
            safeFilename,
            detected.contentType,
            file.size,
            checksum.hex,
            stored.etag,
            activityId,
            identity.userId,
            MAX_EVIDENCE_PER_ACTIVITY,
          ],
        ),
        query(
          database,
          `UPDATE activities
           SET
             evidence_status = 'attached',
             evidence_reference = ?,
             revision = revision + 1,
             updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND user_id = ?
             AND archived_at IS NULL
             AND NOT EXISTS (
               SELECT 1
               FROM activity_allocations allocation
               JOIN credentials credential
                 ON credential.id = allocation.credential_id
               WHERE allocation.activity_id = activities.id
                 AND credential.user_id = activities.user_id
                 AND credential.status = 'renewed'
             )
             AND EXISTS (
               SELECT 1
               FROM evidence_files stored
               WHERE stored.id = ?
                 AND stored.activity_id = activities.id
                 AND stored.user_id = activities.user_id
                 AND stored.status = 'ready'
             )`,
          [safeFilename, activityId, identity.userId, evidenceId],
        ),
        query(
          database,
          `INSERT OR IGNORE INTO badge_events (
            id, user_id, badge_id, idempotency_key, related_type, related_id
          )
          SELECT ?, ?, 'proof-ready', ?, 'evidence', stored.id
          FROM evidence_files stored
          WHERE stored.id = ? AND stored.user_id = ?`,
          [
            crypto.randomUUID(),
            identity.userId,
            `${identity.userId}:badge:proof-ready`,
            evidenceId,
            evidenceId,
            identity.userId,
          ],
        ),
        query(
          database,
          `INSERT OR IGNORE INTO xp_events (
            id, user_id, idempotency_key, event_type, points, related_type,
            related_id
          )
          SELECT ?, ?, ?, 'evidence_attached', 40, 'activity', stored.activity_id
          FROM evidence_files stored
          WHERE stored.id = ? AND stored.user_id = ?`,
          [
            crypto.randomUUID(),
            identity.userId,
            `${identity.userId}:activity:${activityId}:evidence-attached`,
            evidenceId,
            identity.userId,
          ],
        ),
      ]);
      if (Number(results[0]?.meta?.changes ?? Number.NaN) === 0) {
        const currentCount = await query(
          database,
          `SELECT COUNT(*) AS count
           FROM evidence_files
           WHERE user_id = ?
             AND activity_id = ?
             AND status = 'ready'`,
          [identity.userId, activityId],
        ).first<{ count: number }>();
        if (
          Number(currentCount?.count ?? 0) >=
          MAX_EVIDENCE_PER_ACTIVITY
        ) {
          throw new EvidenceApiError(
            `An activity can have up to ${MAX_EVIDENCE_PER_ACTIVITY} evidence files.`,
            409,
            "activity_file_limit",
          );
        }
        await assertOwnedActivityEvidenceMutable(
          database,
          identity.userId,
          activityId,
        );
        throw new EvidenceApiError(
          "The activity changed while evidence was being attached.",
          409,
          "evidence_upload_conflict",
        );
      }
    } catch (error) {
      await bucket.delete(uploadedObjectKey).catch(() => undefined);
      uploadedObjectKey = null;
      const message = error instanceof Error ? error.message : "";
      if (message.includes("UNIQUE constraint")) {
        throw new EvidenceApiError(
          "That evidence file is already attached to this activity.",
          409,
          "duplicate_evidence",
        );
      }
      throw error;
    }

    uploadedObjectKey = null;
    const evidence = await findOwnedEvidence(
      database,
      identity.userId,
      evidenceId,
    );
    if (!evidence) {
      throw new Error("Evidence metadata was not available after upload.");
    }
    return jsonNoStore(
      { ok: true, evidence: toPublicEvidence(evidence) },
      { status: 201 },
    );
  } catch (error) {
    if (uploadedObjectKey && bucketForCleanup) {
      await bucketForCleanup.delete(uploadedObjectKey).catch(() => undefined);
    }
    return evidenceErrorResponse(error);
  }
}
