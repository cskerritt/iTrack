import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { wranglerDevArgs } from "../deploy/railway/worker-args.mjs";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

test("the worker runtime is told the public origin, so request.url carries the scheme the browser's Origin has", () => {
  const args = wranglerDevArgs({
    configPath: "dist/server/wrangler.json", port: 8787, persistDir: "/data/wrangler-state",
    baseUrl: "https://itrackceu.com", vars: { VAPID_SUBJECT: "mailto:x@e.co", INTERNAL_SCHEDULED_SECRET: "s3cret" },
  });
  assert.deepEqual(args, [
    "wrangler", "dev", "--config", "dist/server/wrangler.json", "--port", "8787", "--ip", "127.0.0.1",
    "--persist-to", "/data/wrangler-state", "--local-upstream", "itrackceu.com", "--upstream-protocol", "https",
    "--var", "VAPID_SUBJECT:mailto:x@e.co", "--var", "INTERNAL_SCHEDULED_SECRET:s3cret",
  ]);
  // The Docker run-check runs with PUBLIC_BASE_URL=http://localhost:8080.
  const local = wranglerDevArgs({ configPath: "c", port: 1, persistDir: "p", baseUrl: "http://localhost:8080" });
  assert.deepEqual(local.slice(local.indexOf("--local-upstream")), ["--local-upstream", "localhost:8080", "--upstream-protocol", "http"]);
  assert.throws(() => wranglerDevArgs({ configPath: "c", port: 1, persistDir: "p", baseUrl: "ftp://x" }), /PUBLIC_BASE_URL/);
});

test("serve.mjs spawns wrangler with those args from PUBLIC_BASE_URL, and the installed wrangler knows the flags", () => {
  const serve = read("../deploy/railway/serve.mjs");
  assert.match(serve, /import \{ wranglerDevArgs \} from "\.\/worker-args\.mjs"/);
  assert.match(serve, /spawn\(\s*"npx",\s*wranglerDevArgs\(\{[^}]*\bbaseUrl,/);
  assert.doesNotMatch(serve, /"wrangler",\s*"dev"/, "no second, hand-written argument list");
  // A wrangler upgrade that dropped either flag would make the runtime exit
  // at boot; catch it here instead.
  const cli = read("../node_modules/wrangler/wrangler-dist/cli.js");
  assert.match(cli, /"local-upstream": \{/);
  assert.match(cli, /"upstream-protocol": \{/);
});
