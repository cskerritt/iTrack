// Railway entrypoint for iTrack.
//
// The app is built for Cloudflare Workers, so this process supervises
// wrangler's local runtime (workerd) serving the production build with
// file-backed D1/R2 state, and fronts it with an auth proxy (Basic Auth
// plus self-serve signup accounts; see gateway.mjs) that injects the
// trusted `oai-authenticated-user-*` identity headers the worker expects
// from its normal hosting platform. It also fires the */15 cron trigger
// that delivers scheduled push reminders.
//
// One path opts out of auth entirely — the iOS widget feed, which carries
// its own bearer token for the worker to check; see WIDGET_FEED_PATH in
// gateway.mjs.
//
// Configuration (environment):
//   PORT          public listen port (Railway sets this)
//   ITRACK_USERS  semicolon-separated "username:password:email[:Display Name]"
//                 entries; optional — self-serve signup accounts (SQLite) are
//                 a valid sole auth source, so an empty config only warns
//                 (VIGILO_USERS, then LANTERN_USERS, are accepted as legacy
//                 fallbacks from the product's earlier names)
//   ITRACK_OPEN_IDENTITY
//                 "email[:Display Name]" — DISABLES authentication entirely and
//                 signs every visitor in as this identity. Anyone with the URL
//                 can read and write that identity's data; only use it while
//                 the deployment URL is private. Remove the variable to restore
//                 Basic Auth via ITRACK_USERS.
//   PERSIST_DIR   durable state directory (default /data/wrangler-state);
//                 mount a Railway volume at /data or all data is lost on deploy

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { AuthStore } from "./auth.mjs";
import { createAuthRoutes } from "./auth-routes.mjs";
import { createResendSender } from "./email.mjs";
import { createGateway } from "./gateway.mjs";

const PUBLIC_PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const WORKER_PORT = 8787;
const PERSIST_DIR = process.env.PERSIST_DIR ?? "/data/wrangler-state";
const CRON_INTERVAL_MS = 15 * 60 * 1000;

function parseUsers(raw) {
  const users = new Map();
  for (const entry of (raw ?? "").split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [username, password, email, ...nameParts] = trimmed.split(":");
    if (!username || !password || !email || !email.includes("@")) {
      console.error(
        "ITRACK_USERS entries must look like username:password:email[:Display Name]",
      );
      process.exit(1);
    }
    users.set(username, {
      password,
      email: email.toLowerCase(),
      displayName: nameParts.join(":") || null,
    });
  }
  return users;
}

function parseOpenIdentity(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const [email, ...nameParts] = trimmed.split(":");
  if (!email || !email.includes("@")) {
    console.error("ITRACK_OPEN_IDENTITY must look like email[:Display Name]");
    process.exit(1);
  }
  return {
    email: email.toLowerCase(),
    displayName: nameParts.join(":") || null,
  };
}

const OPEN_IDENTITY = parseOpenIdentity(process.env.ITRACK_OPEN_IDENTITY);

const USERS = parseUsers(
  process.env.ITRACK_USERS ??
    process.env.VIGILO_USERS ??
    process.env.LANTERN_USERS,
);
if (USERS.size === 0 && !OPEN_IDENTITY) {
  console.warn(
    "No ITRACK_USERS or ITRACK_OPEN_IDENTITY configured; only self-serve accounts can log in",
  );
}

// Shared only between this process and the worker it spawns; authorizes the
// internal scheduled-delivery route that replaces cron triggers here.
const INTERNAL_SCHEDULED_SECRET = randomBytes(32).toString("hex");

// Worker vars are not inherited from the process environment; forward the
// ones the worker reads (VAPID push + APNs credentials, widget token)
// explicitly.
const workerVarArgs = [
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "APNS_TEAM_ID",
  "APNS_KEY_ID",
  "APNS_PRIVATE_KEY",
  "APNS_BUNDLE_ID",
  "APNS_ENVIRONMENT",
  "ITRACK_WIDGET_TOKEN",
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

// Request handling (Basic Auth, widget-feed exemption, self-serve auth
// routes, public pages, proxying) lives in gateway.mjs so it can be tested
// against a stub upstream without spawning wrangler.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_ROOT = path.dirname(PERSIST_DIR); // /data in production
mkdirSync(STATE_ROOT, { recursive: true });

// Session-signing secret: env wins; otherwise generate once and persist so
// cookies survive deploys without requiring manual setup.
const secretFile = path.join(STATE_ROOT, "auth-session-secret");
let sessionSecret = process.env.AUTH_SESSION_SECRET;
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

const store = new AuthStore(process.env.AUTH_DB_PATH ?? path.join(STATE_ROOT, "auth.db"));
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
    users: USERS,
    openIdentity: OPEN_IDENTITY,
    authRoutes,
    store,
    pagesDir: path.join(HERE, "pages"),
    upstreamPort: WORKER_PORT,
  }),
);

await waitForWorker();
setInterval(fireCron, CRON_INTERVAL_MS);
fireCron();
server.listen(PUBLIC_PORT, "0.0.0.0", () => {
  const mode = OPEN_IDENTITY
    ? `OPEN ACCESS — no authentication, all visitors act as ${OPEN_IDENTITY.email}`
    : `${USERS.size} user${USERS.size === 1 ? "" : "s"}`;
  console.log(
    `iTrack proxy listening on :${PUBLIC_PORT} (${mode}, self-serve signup enabled), state in ${PERSIST_DIR}`,
  );
});
