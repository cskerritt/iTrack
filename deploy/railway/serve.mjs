// Railway entrypoint for iTrack.
//
// The app is built for Cloudflare Workers, so this process supervises
// wrangler's local runtime (workerd) serving the production build with
// file-backed D1/R2 state, and fronts it with the auth gateway (gateway.mjs)
// that turns a signed session cookie into the trusted
// `oai-authenticated-user-*` identity headers the worker expects. It also
// fires the */15 cron trigger that delivers scheduled push reminders.
//
// Configuration (environment):
//   PORT                 public listen port (Railway sets this)
//   PERSIST_DIR          durable state directory (default /data/wrangler-state);
//                        mount a Railway volume at /data or all data is lost
//   AUTH_SESSION_SECRET  optional; otherwise generated once and persisted in
//                        /data/auth-session-secret
//   AUTH_DB_PATH         optional; default /data/auth.db
//   AUTH_BOOTSTRAP_USERS "email:password[;email:password]" — creates VERIFIED
//                        accounts at startup for addresses with no account;
//                        existing accounts are never touched (see bootstrap.mjs)
//   PUBLIC_BASE_URL      canonical origin, e.g. https://itrackceu.com; the
//                        CSRF check and email links use it, and it is the
//                        Host the worker is told on every proxied request
//   RESEND_API_KEY, AUTH_EMAIL_FROM   transactional email
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT   web push
//
// Fail-closed at startup: a session secret must exist and the auth database
// must open; otherwise the process exits 1 before listening.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { AuthStore } from "./auth.mjs";
import { createAuthRoutes } from "./auth-routes.mjs";
import { applyBootstrapUsers, parseBootstrapUsers } from "./bootstrap.mjs";
import { createResendSender } from "./email.mjs";
import { createGateway } from "./gateway.mjs";

const PUBLIC_PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const WORKER_PORT = 8787;
const PERSIST_DIR = process.env.PERSIST_DIR ?? "/data/wrangler-state";
const CRON_INTERVAL_MS = 15 * 60 * 1000;

// Shared only between this process and the worker it spawns; authorizes the
// internal scheduled-delivery route that replaces cron triggers here.
const INTERNAL_SCHEDULED_SECRET = randomBytes(32).toString("hex");

// Worker vars are not inherited from the process environment; forward the
// ones the worker reads (VAPID push credentials) explicitly.
const workerVarArgs = [
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
].flatMap((name) =>
  process.env[name] ? ["--var", `${name}:${process.env[name]}`] : [],
);
workerVarArgs.push(
  "--var",
  `INTERNAL_SCHEDULED_SECRET:${INTERNAL_SCHEDULED_SECRET}`,
);

const worker = spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "--config",
    "dist/server/wrangler.json",
    "--port",
    String(WORKER_PORT),
    "--ip",
    "127.0.0.1",
    "--persist-to",
    PERSIST_DIR,
    ...workerVarArgs,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      CI: "true",
      WRANGLER_SEND_METRICS: "false",
      WRANGLER_LOG_PATH: "/tmp/wrangler-logs",
    },
  },
);

worker.on("exit", (code, signal) => {
  console.error(`wrangler runtime exited (code ${code}, signal ${signal})`);
  process.exit(code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    worker.kill(signal);
    process.exit(0);
  });
}

async function waitForWorker() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${WORKER_PORT}/manifest.webmanifest`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  console.error("wrangler runtime never became ready");
  process.exit(1);
}

async function fireCron() {
  try {
    const response = await fetch(
      `http://127.0.0.1:${WORKER_PORT}/internal/run-scheduled`,
      {
        method: "POST",
        headers: { "x-internal-scheduled-secret": INTERNAL_SCHEDULED_SECRET },
      },
    );
    const body = await response.text();
    console.log(
      `[cron] scheduled delivery -> ${response.status} ${body.slice(0, 200)}`,
    );
  } catch (error) {
    console.error("[cron] trigger failed", error);
  }
  try {
    const { removedUsers } = store.cleanup();
    if (removedUsers > 0) console.log(`[auth] cleaned up ${removedUsers} stale unverified account(s)`);
  } catch (error) {
    console.error("[auth] cleanup failed", error);
  }
}

// Request handling (session auth, public pages, allowlist, proxying) lives in
// gateway.mjs so it can be tested against a stub upstream without spawning
// wrangler.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_ROOT = path.dirname(PERSIST_DIR); // /data in production
mkdirSync(STATE_ROOT, { recursive: true });

// Session-signing secret: env wins; otherwise generate once and persist so
// cookies survive deploys without requiring manual setup.
const secretFile = path.join(STATE_ROOT, "auth-session-secret");
let sessionSecret = process.env.AUTH_SESSION_SECRET?.trim();
if (!sessionSecret) {
  if (!existsSync(secretFile)) {
    writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  sessionSecret = readFileSync(secretFile, "utf8").trim();
}
if (!sessionSecret) {
  console.error(
    `Refusing to start: session secret is empty (set AUTH_SESSION_SECRET or delete ${secretFile} to regenerate)`,
  );
  process.exit(1);
}

let store;
try {
  store = new AuthStore(process.env.AUTH_DB_PATH ?? path.join(STATE_ROOT, "auth.db"));
} catch (error) {
  console.error("Refusing to start: the auth database could not be opened", error);
  process.exit(1);
}
try {
  applyBootstrapUsers(store, parseBootstrapUsers(process.env.AUTH_BOOTSTRAP_USERS));
} catch (error) {
  console.error(`Refusing to start: ${error.message}`);
  process.exit(1);
}
const baseUrl =
  process.env.PUBLIC_BASE_URL ??
  (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PUBLIC_PORT}`);
const authRoutes = createAuthRoutes({
  store,
  secret: sessionSecret,
  baseUrl,
  sendEmail: createResendSender({
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.AUTH_EMAIL_FROM,
  }),
});
const server = http.createServer(
  createGateway({
    authRoutes,
    baseUrl,
    pagesDir: path.join(HERE, "pages"),
    upstreamPort: WORKER_PORT,
  }),
);

await waitForWorker();
setInterval(fireCron, CRON_INTERVAL_MS);
fireCron();
server.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(
    `iTrack gateway listening on :${PUBLIC_PORT} (session-cookie auth, self-serve signup enabled), state in ${PERSIST_DIR}`,
  );
});
