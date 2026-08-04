import {
  ApnsRegistrationError,
  registerApnsDevice,
} from "@/app/lib/apnsRegistration";
import { getD1 } from "@/db";
import { resolveRequestIdentity } from "@/db/identity";
import { ensureUser, initializeDatabase } from "@/db/runtime";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  try {
    const identity = await resolveRequestIdentity(request);
    if (!identity) {
      return Response.json(
        {
          // Not the "Sign in with ChatGPT" copy the browser-facing routes use:
          // this endpoint's only caller is the iOS shell, which authenticates
          // with Basic credentials and has no ChatGPT sign-in to offer.
          error: "Sign in to register this device for reminders.",
          code: "authentication_required",
        },
        { status: 401, headers: NO_STORE },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "Request body must be valid JSON.", code: "invalid_json" },
        { status: 400, headers: NO_STORE },
      );
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return Response.json(
        { error: "Request body must be an object.", code: "invalid_json" },
        { status: 400, headers: NO_STORE },
      );
    }
    const payload = body as Record<string, unknown>;

    const database = getD1();
    await initializeDatabase(database);
    await ensureUser(database, identity);

    try {
      await registerApnsDevice(database, {
        userId: identity.userId,
        deviceToken: payload.deviceToken,
        environment: payload.environment,
        deviceLabel: payload.deviceLabel,
      });
    } catch (error) {
      if (error instanceof ApnsRegistrationError) {
        return Response.json(
          { error: error.message, code: error.code },
          { status: 400, headers: NO_STORE },
        );
      }
      throw error;
    }

    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("APNs registration error", message);
    return Response.json(
      {
        error: "The device could not be registered. Please try again.",
        code: "internal_error",
      },
      { status: 500, headers: NO_STORE },
    );
  }
}
