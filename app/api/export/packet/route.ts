import { getD1 } from "@/db";
import { resolveRequestIdentity } from "@/db/identity";
import { ensureUser, initializeDatabase } from "@/db/runtime";
import {
  type RenewalPacketData,
  RENEWAL_PACKET_PRINT_SCRIPT,
  credentialPacketFilename,
  renderRenewalPacket,
  renderRenewalPacketError,
} from "@/app/lib/renewalPacket";
import { getWorkspace } from "@/app/api/workspace/route";

export const dynamic = "force-dynamic";

type EvidenceInventoryRow = {
  id: string;
  activityId: string;
  activityTitle: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
};

function packetError(
  request: Request,
  error: string,
  code: string,
  status: number,
) {
  const commonHeaders = {
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, noarchive",
  };
  if (request.headers.get("accept")?.includes("application/json")) {
    return Response.json(
      { error, code },
      {
        status,
        headers: commonHeaders,
      },
    );
  }
  const title =
    status === 401
      ? "Sign in to continue"
      : status === 404
        ? "Packet unavailable"
        : status >= 500
          ? "Packet temporarily unavailable"
          : "Choose a credential";
  const headers = new Headers({
    ...commonHeaders,
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  });
  return new Response(renderRenewalPacketError(title, error), {
    status,
    headers,
  });
}

function credentialIdFromRequest(request: Request) {
  const url = new URL(request.url);
  const credentialIds = url.searchParams.getAll("credentialId");
  if (
    credentialIds.length !== 1 ||
    [...url.searchParams.keys()].some((key) => key !== "credentialId")
  ) {
    return null;
  }
  const credentialId = credentialIds[0];
  return /^[a-zA-Z0-9_-]{1,160}$/.test(credentialId)
    ? credentialId
    : null;
}

export async function GET(request: Request) {
  try {
    const identity = await resolveRequestIdentity(request);
    if (!identity) {
      return packetError(
        request,
        "Sign in with ChatGPT to prepare a credential packet.",
        "authentication_required",
        401,
      );
    }

    const credentialId = credentialIdFromRequest(request);
    if (!credentialId) {
      return packetError(
        request,
        "Choose one valid credential to prepare a credential packet.",
        "invalid_credential_id",
        400,
      );
    }

    const database = getD1();
    await initializeDatabase(database);
    await ensureUser(database, identity);

    const workspace = await getWorkspace(database, identity);
    const credential = workspace.credentials.find(
      (candidate) => candidate.id === credentialId,
    );
    if (!credential) {
      return packetError(
        request,
        "Credential not found.",
        "credential_not_found",
        404,
      );
    }

    const activities = workspace.activities.flatMap((activity) => {
      const allocation = activity.allocations.find(
        (candidate) => candidate.credentialId === credential.id,
      );
      if (!allocation) return [];
      return [
        {
          id: activity.id,
          title: activity.title,
          provider: activity.provider,
          completionDate: activity.completionDate,
          totalUnits: activity.totalUnits,
          allocatedUnits: allocation.allocatedUnits,
          categoryNames: allocation.categoryNames,
          classificationStatus: allocation.classificationStatus,
          evidenceStatus: activity.evidenceStatus,
          evidenceReference: activity.evidenceReference,
          evidenceDeletionPendingCount:
            activity.evidenceDeletionPendingCount,
        },
      ];
    });

    const evidenceResult = await database
      .prepare(
        `SELECT
          evidence.id,
          evidence.activity_id AS activityId,
          activity.title AS activityTitle,
          evidence.original_filename AS fileName,
          evidence.content_type AS contentType,
          evidence.size_bytes AS sizeBytes,
          evidence.sha256,
          evidence.created_at AS createdAt
        FROM evidence_files evidence
        JOIN activities activity
          ON activity.id = evidence.activity_id
          AND activity.user_id = evidence.user_id
        JOIN activity_allocations allocation
          ON allocation.activity_id = activity.id
        JOIN credentials credential
          ON credential.id = allocation.credential_id
          AND credential.user_id = evidence.user_id
        WHERE evidence.user_id = ?
          AND credential.id = ?
          AND evidence.status = 'ready'
          AND activity.archived_at IS NULL
        ORDER BY activity.completion_date DESC, evidence.created_at DESC`,
      )
      .bind(identity.userId, credential.id)
      .all<EvidenceInventoryRow>();

    const packet: RenewalPacketData = {
      owner: {
        displayName: identity.displayName,
        email: identity.email,
      },
      credential: {
        credentialName: credential.credentialName,
        profession: credential.profession,
        jurisdiction: credential.jurisdiction,
        issuer: credential.issuer,
        cycleStart: credential.cycleStart,
        deadline: credential.deadline,
        status: credential.status,
        lifecycleKind: credential.lifecycleKind,
        totalRequired: credential.totalRequired,
        totalLoggedUnits: credential.totalLoggedUnits,
        totalExcessUnits: credential.totalExcessUnits,
        totalEarned: credential.totalEarned,
        totalRemaining: credential.totalRemaining,
        unclassifiedUnits: credential.unclassifiedUnits,
        unitLabel: credential.unitLabel,
        submittedAt: credential.submittedAt,
        confirmationNumber: credential.confirmationNumber,
        submissionProof: credential.submissionProof,
        submissionAttestationKind: credential.submissionAttestationKind,
        acceptedAt: credential.acceptedAt,
        acceptanceReference: credential.acceptanceReference,
        officialRecordAttestedAt: credential.officialRecordAttestedAt,
      },
      source: {
        title: credential.sourceTitle,
        url: credential.sourceUrl,
        effectiveDate: credential.ruleEffectiveDate,
        lastVerifiedAt: credential.ruleLastVerifiedAt,
        reviewStatus: credential.ruleReviewStatus ?? "custom",
        version:
          credential.ruleVersion === null
            ? null
            : Number(credential.ruleVersion),
      },
      requirements: credential.requirements.map((requirement) => ({
        id: requirement.id,
        name: requirement.name,
        requiredUnits: requirement.requiredUnits,
        earnedUnits: requirement.earnedUnits,
        rawEarned: requirement.rawEarned,
        excessUnits: requirement.excessUnits,
        remainingUnits: requirement.remainingUnits,
        progressPercent: requirement.progressPercent,
        kind: requirement.kind,
        relation: requirement.relation,
        applicabilityStatus: requirement.applicabilityStatus,
        isActive: requirement.isActive,
        conditionNote: requirement.conditionNote,
      })),
      tasks: credential.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        kind: task.kind,
        status: task.status,
        dueDate: task.dueDate,
        completedAt: task.completedAt,
        isPersonal: task.isPersonal,
      })),
      activities,
      evidence: evidenceResult.results.map((file) => ({
        ...file,
        sizeBytes: Number(file.sizeBytes),
      })),
      generatedAt: new Date().toISOString(),
    };

    const printScriptDigest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(RENEWAL_PACKET_PRINT_SCRIPT),
    );
    const printScriptHash = btoa(
      String.fromCharCode(...new Uint8Array(printScriptDigest)),
    );
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Disposition": `inline; filename="${credentialPacketFilename(
        credential.credentialName,
        credential.deadline,
      )}"`,
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${printScriptHash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`,
      "Content-Type": "text/html; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex, noarchive",
    });
    return new Response(renderRenewalPacket(packet), { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("Credential packet error", message);
    return packetError(
      request,
      "The credential packet could not be prepared. Please try again.",
      "internal_error",
      500,
    );
  }
}
