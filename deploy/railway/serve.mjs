// Railway entrypoint for Vigilo.
//
// The app is built for Cloudflare Workers, so this process supervises
// wrangler's local runtime (workerd) serving the production build with
// file-backed D1/R2 state, and fronts it with a Basic Auth proxy that
// injects the trusted `oai-authenticated-user-*` identity headers the
// worker expects from its normal hosting platform. It also fires the
// */15 cron trigger that delivers scheduled push reminders.
//
// Configuration (environment):
//   PORT          public listen port (Railway sets this)
//   VIGILO_USERS  semicolon-separated "username:password:email[:Display Name]"
//                 entries; REQUIRED — the proxy fails closed without it
//                 (LANTERN_USERS is accepted as a legacy fallback)
//   PERSIST_DIR   durable state directory (default /data/wrangler-state);
//                 mount a Railway volume at /data or all data is lost on deploy

import { spawn } from "node:child_process";
import { timingSafeEqual, createHash, randomBytes } from "node:crypto";
import http from "node:http";

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
        "VIGILO_USERS entries must look like username:password:email[:Display Name]",
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

const USERS = parseUsers(
  process.env.VIGILO_USERS ?? process.env.LANTERN_USERS,
);
if (USERS.size === 0) {
  console.error(
    "Refusing to start: set VIGILO_USERS (username:password:email[:Display Name]; ...)",
  );
  process.exit(1);
}

function digest(value) {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left, right) {
  return timingSafeEqual(digest(left), digest(right));
}

function authenticate(header) {
  if (!header?.startsWith("Basic ")) return null;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator === -1) return null;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  const user = USERS.get(username);
  // Always compare against something so unknown usernames cost the same time.
  const expected = user?.password ?? "missing-user-placeholder";
  const matches = safeEqual(password, expected);
  return user && matches ? user : null;
}

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
}

const server = http.createServer((req, res) => {
  const pathname = (req.url ?? "/").split("?")[0];

  if (pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  // Scheduled-trigger and internal endpoints are never reachable from outside.
  if (
    pathname === "/__scheduled" ||
    pathname.startsWith("/cdn-cgi/") ||
    pathname.startsWith("/internal/")
  ) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  const user = authenticate(req.headers.authorization);
  if (!user) {
    res.writeHead(401, {
      "www-authenticate": 'Basic realm="Vigilo", charset="UTF-8"',
      "content-type": "text/plain",
    });
    res.end("Authentication required");
    return;
  }

  const headers = { ...req.headers };
  // Never forward client-supplied identity or hop-by-hop headers.
  for (const name of Object.keys(headers)) {
    if (name.startsWith("oai-")) delete headers[name];
  }
  delete headers.authorization;
  delete headers.connection;
  headers["oai-authenticated-user-email"] = user.email;
  if (user.displayName) {
    headers["oai-authenticated-user-full-name"] = encodeURIComponent(
      user.displayName,
    );
    headers["oai-authenticated-user-full-name-encoding"] =
      "percent-encoded-utf-8";
  }

  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: WORKER_PORT,
      method: req.method,
      path: req.url,
      headers,
    },
    (workerResponse) => {
      res.writeHead(workerResponse.statusCode ?? 502, workerResponse.headers);
      workerResponse.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    console.error("proxy upstream error", error);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
    }
    res.end("Upstream unavailable");
  });
  req.pipe(upstream);
});

await waitForWorker();
setInterval(fireCron, CRON_INTERVAL_MS);
fireCron();
server.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(
    `Vigilo proxy listening on :${PUBLIC_PORT} (${USERS.size} user${USERS.size === 1 ? "" : "s"}), state in ${PERSIST_DIR}`,
  );
});
