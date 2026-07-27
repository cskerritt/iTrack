/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { runScheduledPushDelivery } from "../app/lib/pushDelivery";
import { initializeDatabase } from "../db/runtime";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
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
        const result = await runScheduledPushDelivery({
          database: env.DB,
          scheduledTime: Date.now(),
          config: {
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY,
            subject: env.VAPID_SUBJECT,
          },
        });
        return Response.json({ ok: true, result });
      } catch (error) {
        console.error(
          "Vigilo internal scheduled run failed.",
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
        console.info("Vigilo scheduled push delivery started.");
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
            "Vigilo scheduled push delivery completed.",
            JSON.stringify(result),
          );
        } catch (error) {
          console.error(
            "Vigilo scheduled push delivery failed.",
            error instanceof Error ? (error.stack ?? error.message) : String(error),
          );
          throw new Error("Scheduled push delivery failed.");
        }
      })(),
    );
  },
};

export default worker;
