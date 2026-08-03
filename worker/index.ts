/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { runScheduledPushDelivery } from "../app/lib/pushDelivery";
import { runScheduledApnsDelivery } from "../app/lib/apnsDelivery";
import { initializeDatabase } from "../db/runtime";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_PRIVATE_KEY?: string;
  APNS_BUNDLE_ID?: string;
  APNS_ENVIRONMENT?: string;
  ITRACK_WIDGET_TOKEN?: string;
  /**
   * When set, POST /internal/run-scheduled with a matching
   * x-internal-scheduled-secret header runs the same push delivery as the
   * cron trigger. Used by self-hosted deployments (e.g. Railway) whose local
   * workerd runtime cannot fire cron triggers; unset on platform hosting, so
   * the route does not exist there.
   */
  INTERNAL_SCHEDULED_SECRET?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

/**
 * Runs the APNs channel and logs its own outcome. Kept entirely
 * self-contained (own try/catch, never rethrows) so a failure here can
 * never block or delay the web-push channel it runs alongside.
 */
async function runApnsChannel(env: Env, scheduledTime: number): Promise<void> {
  try {
    const result = await runScheduledApnsDelivery({
      database: env.DB,
      scheduledTime,
      config: {
        teamId: env.APNS_TEAM_ID,
        keyId: env.APNS_KEY_ID,
        privateKeyPem: env.APNS_PRIVATE_KEY,
        bundleId: env.APNS_BUNDLE_ID,
        environment: env.APNS_ENVIRONMENT,
      },
    });
    // `failed` counts attempts (not give-ups — a row below the cap stays
    // queued for the next run) and `materialized` includes re-arms of
    // previously cancelled/expired/failed rows, not only brand-new ones;
    // the log names them accordingly so the raw JSON isn't misread as a
    // simple pass/fail tally.
    console.info(
      "iTrack scheduled APNs delivery completed. " +
        `attemptsFailed=${result.failed} materializedOrRearmed=${result.materialized}`,
      JSON.stringify(result),
    );
    if (
      result.configured &&
      result.devices > 0 &&
      result.delivered + result.failed + result.disabled === 0 &&
      result.materialized > 0
    ) {
      console.warn(
        "iTrack APNs delivery appears stuck: devices and materialized rows exist but nothing delivered, failed, or disabled this run.",
        JSON.stringify(result),
      );
    }
  } catch (error) {
    console.error(
      "iTrack scheduled APNs delivery failed.",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  }
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/internal/run-scheduled") {
      const secret = env.INTERNAL_SCHEDULED_SECRET;
      const provided = request.headers.get("x-internal-scheduled-secret");
      if (!secret || request.method !== "POST" || provided !== secret) {
        return new Response("Not Found", { status: 404 });
      }
      try {
        // A scheduled run can beat the first user request on a fresh
        // database; make sure the schema exists before delivery reads it.
        await initializeDatabase(env.DB);
        const scheduledTime = Date.now();
        const result = await runScheduledPushDelivery({
          database: env.DB,
          scheduledTime,
          config: {
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY,
            subject: env.VAPID_SUBJECT,
          },
        });
        // Its own try/catch lives inside runApnsChannel, so a failure here
        // never blocks the web-push response above.
        await runApnsChannel(env, scheduledTime);
        return Response.json({ ok: true, result });
      } catch (error) {
        console.error(
          "iTrack internal scheduled run failed.",
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        );
        return Response.json({ ok: false }, { status: 500 });
      }
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        console.info("iTrack scheduled push delivery started.");
        // Tracked rather than rethrown immediately so a web-push failure
        // cannot skip the APNs block below; the failure is still signalled
        // to the caller (Cloudflare's cron failure detection) once both
        // channels have had their turn.
        let pushFailed = false;
        try {
          await initializeDatabase(env.DB);
          const result = await runScheduledPushDelivery({
            database: env.DB,
            scheduledTime: controller.scheduledTime,
            config: {
              publicKey: env.VAPID_PUBLIC_KEY,
              privateKey: env.VAPID_PRIVATE_KEY,
              subject: env.VAPID_SUBJECT,
            },
          });
          console.info(
            "iTrack scheduled push delivery completed.",
            JSON.stringify(result),
          );
        } catch (error) {
          pushFailed = true;
          console.error(
            "iTrack scheduled push delivery failed.",
            error instanceof Error ? (error.stack ?? error.message) : String(error),
          );
        }

        // Its own try/catch lives inside runApnsChannel, so this channel's
        // failure can never block (or be blocked by) the web-push channel
        // above.
        await runApnsChannel(env, controller.scheduledTime);

        if (pushFailed) {
          throw new Error("Scheduled push delivery failed.");
        }
      })(),
    );
  },
};

export default worker;
