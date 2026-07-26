import {
  EvidenceApiError,
  assertOwnedActivityEvidenceMutable,
  evidenceErrorResponse,
  evidenceIdFromContext,
  findOwnedEvidence,
  findOwnedEvidenceForDeletion,
  jsonNoStore,
  query,
  requireEvidenceContext,
  toPublicEvidence,
} from "../_shared";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const evidenceId = await evidenceIdFromContext(context);
    const { database, identity } = await requireEvidenceContext(request);
    const evidence = await findOwnedEvidence(
      database,
      identity.userId,
      evidenceId,
    );
    if (!evidence) {
      throw new EvidenceApiError(
        "Evidence file not found.",
        404,
        "evidence_not_found",
      );
    }
    return jsonNoStore({ evidence: toPublicEvidence(evidence) });
  } catch (error) {
    return evidenceErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const evidenceId = await evidenceIdFromContext(context);
    const { database, bucket, identity } =
      await requireEvidenceContext(request);
    const evidence = await findOwnedEvidenceForDeletion(
      database,
      identity.userId,
      evidenceId,
    );
    if (!evidence) {
      throw new EvidenceApiError(
        "Evidence file not found.",
        404,
        "evidence_not_found",
      );
    }

    if (evidence.status === "ready") {
      await assertOwnedActivityEvidenceMutable(
        database,
        identity.userId,
        evidence.activityId,
      );

      const transitionResults = await database.batch([
      query(
        database,
        `UPDATE evidence_files
         SET status = 'deleting', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND user_id = ?
           AND activity_id = ?
           AND status = 'ready'
           AND EXISTS (
             SELECT 1
             FROM activities activity
             WHERE activity.id = evidence_files.activity_id
               AND activity.user_id = evidence_files.user_id
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
           )`,
        [evidenceId, identity.userId, evidence.activityId],
      ),
      query(
        database,
        `UPDATE activities
         SET
           evidence_status = CASE
             WHEN EXISTS (
               SELECT 1
               FROM evidence_files stored
               WHERE stored.activity_id = activities.id
                 AND stored.user_id = activities.user_id
                 AND stored.status = 'ready'
             ) THEN 'attached'
             ELSE 'missing'
           END,
           evidence_reference = (
             SELECT stored.original_filename
             FROM evidence_files stored
             WHERE stored.activity_id = activities.id
               AND stored.user_id = activities.user_id
               AND stored.status = 'ready'
             ORDER BY stored.created_at DESC, stored.id DESC
             LIMIT 1
           ),
           revision = revision + 1,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND user_id = ?
           AND archived_at IS NULL
           AND EXISTS (
             SELECT 1
             FROM evidence_files deleting
             WHERE deleting.id = ?
               AND deleting.activity_id = activities.id
               AND deleting.user_id = activities.user_id
               AND deleting.status = 'deleting'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM activity_allocations allocation
             JOIN credentials credential
               ON credential.id = allocation.credential_id
             WHERE allocation.activity_id = activities.id
               AND credential.user_id = activities.user_id
               AND credential.status = 'renewed'
           )`,
        [evidence.activityId, identity.userId, evidenceId],
      ),
      ]);
      if (
        Number(transitionResults[0]?.meta?.changes ?? Number.NaN) !== 1 ||
        Number(transitionResults[1]?.meta?.changes ?? Number.NaN) !== 1
      ) {
        if (
          Number(transitionResults[0]?.meta?.changes ?? Number.NaN) === 1
        ) {
          await query(
            database,
            `UPDATE evidence_files
             SET status = 'ready', updated_at = CURRENT_TIMESTAMP
             WHERE id = ?
               AND user_id = ?
               AND activity_id = ?
               AND status = 'deleting'
               AND EXISTS (
                 SELECT 1
                 FROM activities activity
                 WHERE activity.id = evidence_files.activity_id
                   AND activity.user_id = evidence_files.user_id
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
               )`,
            [evidenceId, identity.userId, evidence.activityId],
          )
            .run()
            .catch(() => undefined);
        }
        await assertOwnedActivityEvidenceMutable(
          database,
          identity.userId,
          evidence.activityId,
        );
        throw new EvidenceApiError(
          "The proof file changed while it was being removed. Refresh and try again.",
          409,
          "evidence_changed",
        );
      }
    }

    try {
      await bucket.delete(evidence.objectKey);
    } catch {
      throw new EvidenceApiError(
        "The proof file is queued for removal. Retry removal when storage is available.",
        503,
        "evidence_delete_retry",
      );
    }

    await query(
      database,
      `DELETE FROM evidence_files
       WHERE id = ?
         AND user_id = ?
         AND activity_id = ?
         AND status = 'deleting'`,
      [evidenceId, identity.userId, evidence.activityId],
    ).run();

    return jsonNoStore({ ok: true, id: evidenceId });
  } catch (error) {
    return evidenceErrorResponse(error);
  }
}
