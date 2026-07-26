import {
  EvidenceApiError,
  contentDisposition,
  evidenceErrorResponse,
  evidenceIdFromContext,
  findOwnedEvidence,
  requireEvidenceContext,
} from "../../_shared";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const evidenceId = await evidenceIdFromContext(context);
    const { database, bucket, identity } =
      await requireEvidenceContext(request);
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
    const object = await bucket.get(evidence.objectKey);
    if (!object) {
      throw new EvidenceApiError(
        "Evidence file not found.",
        404,
        "evidence_object_not_found",
      );
    }

    return new Response(object.body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": contentDisposition(evidence.originalFilename),
        "Content-Length": String(object.size),
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Type": evidence.contentType,
        ETag: object.httpEtag || `"${object.etag}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return evidenceErrorResponse(error);
  }
}
