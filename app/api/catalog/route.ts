import { getRuleCatalog } from "@/app/api/workspace/route";
import { getD1 } from "@/db";
import { resolveRequestIdentity } from "@/db/identity";
import { initializeDatabase } from "@/db/runtime";

export const dynamic = "force-dynamic";

// Every current template plus its categories serializes to roughly 700 KB of
// global seed data that only changes on deploy. It used to ride along on every
// workspace read; it now loads once, when someone opens the template chooser,
// and stays revalidatable so a repeat visit costs a 304 instead of the body.
const CATALOG_CACHE_CONTROL = "private, max-age=900, must-revalidate";

async function catalogEntityTag(body: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  const fingerprint = Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `"${fingerprint}"`;
}

export async function GET(request: Request) {
  try {
    const identity = await resolveRequestIdentity(request);
    if (!identity) {
      return Response.json(
        {
          error: "Sign in with ChatGPT to browse credential templates.",
          code: "authentication_required",
        },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }

    const database = getD1();
    await initializeDatabase(database);
    const body = JSON.stringify({ catalog: await getRuleCatalog(database) });
    const entityTag = await catalogEntityTag(body);
    if (request.headers.get("if-none-match") === entityTag) {
      return new Response(null, {
        status: 304,
        headers: { "Cache-Control": CATALOG_CACHE_CONTROL, ETag: entityTag },
      });
    }

    return new Response(body, {
      headers: {
        "Cache-Control": CATALOG_CACHE_CONTROL,
        "Content-Type": "application/json",
        ETag: entityTag,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("CEU catalog error", message);
    return Response.json(
      {
        error:
          "The credential template catalog could not be loaded. Please try again.",
        code: "internal_error",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
