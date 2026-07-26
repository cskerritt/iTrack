import { getD1 } from "@/db";
import { resolveRequestIdentity } from "@/db/identity";
import { ensureUser, initializeDatabase } from "@/db/runtime";

export const dynamic = "force-dynamic";

type ExportRow = {
  title: string;
  provider: string;
  completionDate: string;
  totalUnits: number;
  evidenceStatus: string;
  evidenceReference: string | null;
  credentialName: string | null;
  jurisdiction: string | null;
  requirementName: string | null;
  allocatedUnits: number;
};

function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export async function GET(request: Request) {
  try {
    const identity = await resolveRequestIdentity(request);
    if (!identity) {
      return Response.json(
        {
          error: "Sign in with ChatGPT to export your CEU activities.",
          code: "authentication_required",
        },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }

    const database = getD1();
    await initializeDatabase(database);
    await ensureUser(database, identity);
    const result = await database
      .prepare(
        `SELECT
          a.title,
          a.provider,
          a.completion_date AS completionDate,
          a.total_units AS totalUnits,
          a.evidence_status AS evidenceStatus,
          a.evidence_reference AS evidenceReference,
          c.credential_name AS credentialName,
          c.jurisdiction,
          req.name AS requirementName,
          CASE
            WHEN c.id IS NULL THEN 0
            ELSE COALESCE(alloc.allocated_units, 0)
          END AS allocatedUnits
        FROM activities a
        LEFT JOIN activity_allocations alloc ON alloc.activity_id = a.id
        LEFT JOIN credentials c
          ON c.id = alloc.credential_id AND c.user_id = a.user_id
        LEFT JOIN credential_requirements req
          ON req.id = alloc.requirement_id AND req.credential_id = c.id
        WHERE a.user_id = ?
        ORDER BY a.completion_date DESC, a.created_at DESC`,
      )
      .bind(identity.userId)
      .all<ExportRow>();

    const header = [
      "Activity",
      "Provider",
      "Completion date",
      "Activity units",
      "Evidence status",
      "Evidence reference",
      "Credential",
      "Jurisdiction",
      "Requirement category",
      "Allocated units",
    ];
    const rows = result.results.map((row) => [
      row.title,
      row.provider,
      row.completionDate,
      Number(row.totalUnits),
      row.evidenceStatus,
      row.evidenceReference,
      row.credentialName,
      row.jurisdiction,
      row.requirementName,
      Number(row.allocatedUnits),
    ]);
    const csv = `\uFEFF${[header, ...rows]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n")}\r\n`;
    const today = new Date().toISOString().slice(0, 10);

    return new Response(csv, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="ceu-activities-${today}.csv"`,
        "Content-Type": "text/csv; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("CEU export error", message);
    return Response.json(
      {
        error: "The activity export could not be created. Please try again.",
        code: "internal_error",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
