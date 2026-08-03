import {
  authorizeWidgetRequest,
  buildWidgetSummary,
  WidgetSummaryUserNotFoundError,
} from "@/app/lib/widgetSummary";
import { getD1 } from "@/db";
import { initializeDatabase } from "@/db/runtime";
import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

// Every response, including the failures: a widget feed is a per-install
// secret behind a bearer token, and neither it nor its 401/503/404 shells
// should ever sit in an intermediary cache.
const NO_STORE = { "Cache-Control": "no-store" };

const UNAVAILABLE = {
  error: "The widget feed is not configured on this deployment.",
  code: "widget_not_configured",
};
const UNAUTHORIZED = {
  error: "This widget token is not valid.",
  code: "widget_unauthorized",
};
const NO_USER = {
  error: "This install has no workspace yet. Open iTrack and sign in first.",
  code: "widget_user_not_found",
};

export async function GET(request: Request) {
  // The token gate runs before anything touches the database, so an
  // unauthenticated caller cannot make the endpoint do work.
  const authorization = authorizeWidgetRequest(
    request,
    env.ITRACK_WIDGET_TOKEN,
  );
  if (!authorization.ok) {
    if (authorization.status === 503) {
      return Response.json(UNAVAILABLE, { status: 503, headers: NO_STORE });
    }
    return Response.json(UNAUTHORIZED, {
      status: 401,
      // Names the scheme the caller should have used, per RFC 7235: a 401
      // without it tells a client nothing about how to authenticate.
      headers: { ...NO_STORE, "WWW-Authenticate": 'Bearer realm="iTrack"' },
    });
  }

  try {
    const database = getD1();
    await initializeDatabase(database);

    // iTrack is a single-user install: the widget token authenticates the
    // device, not a person, so there is no identity in the request to look
    // the workspace up by. The one `users` row is the workspace. If a second
    // row somehow exists, the earliest-created one wins — the original
    // account rather than whatever landed last — so the widget's answer
    // stays stable instead of flipping between rows.
    const user = await database
      .prepare(`SELECT id FROM users ORDER BY created_at, id LIMIT 1`)
      .first<{ id: string }>();
    if (!user) {
      return Response.json(NO_USER, { status: 404, headers: NO_STORE });
    }

    const summary = await buildWidgetSummary(database, user.id, Date.now());
    return Response.json(summary, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof WidgetSummaryUserNotFoundError) {
      return Response.json(NO_USER, { status: 404, headers: NO_STORE });
    }
    const message = error instanceof Error ? error.message : "Unexpected error";
    console.error("Widget summary error", message);
    return Response.json(
      {
        error: "The widget summary could not be built. Please try again.",
        code: "internal_error",
      },
      { status: 500, headers: NO_STORE },
    );
  }
}
