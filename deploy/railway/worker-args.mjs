// The `wrangler dev` command line serve.mjs runs the built worker with. A pure
// function so the flags can be pinned by a test without spawning anything.
//
// --local-upstream / --upstream-protocol tell the runtime which origin to
// report in request.url. Without them it is `http://<Host>/…`: the Host
// header alone, scheme fixed at http, whatever X-Forwarded-Proto says (the
// gateway strips that header anyway). app/api/workspace's POST compares the
// browser's Origin — `https://itrackceu.com` on every same-origin save —
// against `new URL(request.url).origin` and answers 403 cross_origin_request
// on a mismatch, so the runtime has to be told the public origin: request.url
// then reads `https://itrackceu.com/…` and the comparison holds. The gateway
// pins the forwarded Host to the same host (gateway.mjs), so the two agree.
// Locally (PUBLIC_BASE_URL=http://localhost:8080) the same flags keep the
// worker's localhost demo path working under the Docker run-check.
export function wranglerDevArgs({ configPath, port, persistDir, baseUrl, vars = {} }) {
  const { host, protocol } = new URL(baseUrl);
  const upstreamProtocol = protocol.replace(/:$/, "");
  if (upstreamProtocol !== "http" && upstreamProtocol !== "https") {
    throw new Error(`PUBLIC_BASE_URL must be an http(s) origin, got ${protocol}`);
  }
  const args = [
    "wrangler",
    "dev",
    "--config",
    configPath,
    "--port",
    String(port),
    "--ip",
    "127.0.0.1",
    "--persist-to",
    persistDir,
    "--local-upstream",
    host,
    "--upstream-protocol",
    upstreamProtocol,
  ];
  for (const [name, value] of Object.entries(vars)) {
    args.push("--var", `${name}:${value}`);
  }
  return args;
}
