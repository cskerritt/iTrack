import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Same transpile-and-data-URL-import pattern as the other library tests, with
// one addition: `apnsPush.ts` imports `createApnsJwt` from a sibling module,
// and a data: URL has no base to resolve "./apnsJwt" against. So the JWT
// module is transpiled to its own data URL first and the sender's import
// specifier is rewritten to point at it. (`PushNotificationData` is imported
// with `import type`, so that specifier is erased and needs no rewrite.)
function transpiled(relativePath) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
}

function moduleUrl(code) {
  return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}

const apnsJwtUrl = moduleUrl(transpiled("../app/lib/apnsJwt.ts"));
const senderSource = transpiled("../app/lib/apnsPush.ts");
const jwtImport = /(from\s+)["']\.\/apnsJwt["']/;
assert.match(
  senderSource,
  jwtImport,
  "apnsPush.ts is expected to import ./apnsJwt",
);
const apns = await import(
  moduleUrl(
    senderSource.replace(jwtImport, (_match, from) =>
      `${from}${JSON.stringify(apnsJwtUrl)}`,
    ),
  )
);

function pemBlock(pkcs8) {
  const body = Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g);
  return [
    "-----BEGIN PRIVATE KEY-----",
    ...body,
    "-----END PRIVATE KEY-----",
    "",
  ].join("\n");
}

async function generateTestKeyPem() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  return pemBlock(
    new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  );
}

const TEST_JWT_CONFIG = {
  teamId: "TEAMID9999",
  keyId: "KEYID99999",
  privateKeyPem: await generateTestKeyPem(),
};
const CONFIG = {
  ...TEST_JWT_CONFIG,
  bundleId: "com.kwvrs.itrack",
  environment: "production",
};
const NOTE = {
  title: "iTrack check-in",
  body: "You have a renewal item that needs attention.",
  tag: "ll-3fd2",
  url: "/?view=today&delivery=3fd2",
};

function recordingFetch(response = () => new Response(null, { status: 200 })) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return response();
    },
  };
}

test("sends to the right host with JWT auth and apns headers", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  };
  const outcome = await apns.sendApnsNotification(
    "devicetoken123",
    { title: "T", body: "B", tag: "renewal-x", url: "/today" },
    {
      ...TEST_JWT_CONFIG,
      bundleId: "com.kwvrs.itrack",
      environment: "production",
    },
    fakeFetch,
  );
  assert.equal(outcome.ok, true);
  assert.equal(
    calls[0].url,
    "https://api.push.apple.com/3/device/devicetoken123",
  );
  assert.equal(calls[0].init.headers["apns-topic"], "com.kwvrs.itrack");
  assert.equal(calls[0].init.headers["apns-push-type"], "alert");
  assert.match(calls[0].init.headers.authorization, /^bearer .+\..+\..+$/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.aps.alert.title, "T");
  assert.equal(body.aps["thread-id"], "renewal-x");
  assert.equal(body.url, "/today");
});

test("posts a complete alert payload with the expected headers", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const outcome = await apns.sendApnsNotification(
    "devicetoken123",
    NOTE,
    CONFIG,
    fetchImpl,
    1_754_000_000_000,
  );

  assert.deepEqual(outcome, {
    ok: true,
    status: 200,
    unregistered: false,
    reason: null,
  });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["apns-priority"], "10");
  assert.equal(
    calls[0].init.headers["apns-expiration"],
    String(1_754_000_000 + 86_400),
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    aps: {
      alert: { title: NOTE.title, body: NOTE.body },
      sound: "default",
      "thread-id": NOTE.tag,
    },
    url: NOTE.url,
  });
});

test("maps 410 Unregistered to unregistered:true", async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ reason: "Unregistered" }), { status: 410 });
  const outcome = await apns.sendApnsNotification("t", NOTE, CONFIG, fakeFetch);
  assert.deepEqual(outcome, {
    ok: false,
    status: 410,
    unregistered: true,
    reason: "Unregistered",
  });
});

test("maps a 410 with an empty body to unregistered:true", async () => {
  const outcome = await apns.sendApnsNotification(
    "t",
    NOTE,
    CONFIG,
    async () => new Response(null, { status: 410 }),
  );
  assert.deepEqual(outcome, {
    ok: false,
    status: 410,
    unregistered: true,
    reason: null,
  });
});

test("does not unregister on 400 BadDeviceToken", async () => {
  // Apple also returns BadDeviceToken when a valid token is sent to the wrong
  // environment, so one APNS_ENVIRONMENT mistake must not retire the fleet.
  const fakeFetch = async () =>
    new Response(JSON.stringify({ reason: "BadDeviceToken" }), { status: 400 });
  const outcome = await apns.sendApnsNotification("t", NOTE, CONFIG, fakeFetch);
  assert.deepEqual(outcome, {
    ok: false,
    status: 400,
    unregistered: false,
    reason: "BadDeviceToken",
  });
});

test("reports retryable failures without unregistering the device", async () => {
  const throttled = await apns.sendApnsNotification(
    "t",
    NOTE,
    CONFIG,
    async () =>
      new Response(JSON.stringify({ reason: "TooManyRequests" }), {
        status: 429,
      }),
  );
  assert.deepEqual(throttled, {
    ok: false,
    status: 429,
    unregistered: false,
    reason: "TooManyRequests",
  });

  const unavailable = await apns.sendApnsNotification(
    "t",
    NOTE,
    CONFIG,
    async () => new Response("<html>gateway</html>", { status: 503 }),
  );
  assert.deepEqual(unavailable, {
    ok: false,
    status: 503,
    unregistered: false,
    reason: null,
  });
});

test("sandbox environment targets api.sandbox.push.apple.com", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(String(url));
    return new Response(null, { status: 200 });
  };
  await apns.sendApnsNotification(
    "t",
    NOTE,
    { ...CONFIG, environment: "sandbox" },
    fakeFetch,
  );
  assert.match(calls[0], /^https:\/\/api\.sandbox\.push\.apple\.com\//);
});

test("reuses the provider token for under 50 minutes, then re-mints", async () => {
  const config = { ...CONFIG, privateKeyPem: await generateTestKeyPem() };
  const { calls, fetchImpl } = recordingFetch();
  const authorization = async (nowMs) => {
    await apns.sendApnsNotification("t", NOTE, config, fetchImpl, nowMs);
    return calls[calls.length - 1].init.headers.authorization;
  };

  const minted = await authorization(1_754_000_000_000);
  assert.equal(await authorization(1_754_000_000_000 + 49 * 60_000), minted);
  const reminted = await authorization(1_754_000_000_000 + 51 * 60_000);
  assert.notEqual(reminted, minted);
  // A different key must never reuse the *currently cached* token, so compare
  // against the freshest one: comparing against `minted` would also pass for a
  // cache that ignored the key material entirely.
  const other = { ...config, privateKeyPem: await generateTestKeyPem() };
  await apns.sendApnsNotification(
    "t",
    NOTE,
    other,
    fetchImpl,
    1_754_000_000_000 + 51 * 60_000,
  );
  assert.notEqual(calls[calls.length - 1].init.headers.authorization, reminted);
});

test("retires malformed device tokens without issuing a request", async () => {
  const { calls, fetchImpl } = recordingFetch();
  for (const deviceToken of [
    "",
    "  ",
    "../../3/device/someone-else",
    "token?override=1",
    "token#fragment",
    "token/extra",
    "toke n",
    "dG9rZW4+/w==",
    `token${"0".repeat(400)}`,
  ]) {
    // Self-retiring rather than throwing keeps one poison row from failing
    // every future cron run, while still issuing no request at all.
    assert.deepEqual(
      await apns.sendApnsNotification(deviceToken, NOTE, CONFIG, fetchImpl),
      {
        ok: false,
        status: 0,
        unregistered: true,
        reason: "MalformedDeviceToken",
      },
    );
  }
  assert.equal(calls.length, 0);
});

test("rejects a bundle id that could inject a header or topic", async () => {
  const { calls, fetchImpl } = recordingFetch();
  for (const bundleId of ["", "com.kwvrs.itrack\r\napns-priority: 1", "com/x"]) {
    await assert.rejects(
      apns.sendApnsNotification("t", NOTE, { ...CONFIG, bundleId }, fetchImpl),
      (error) => error instanceof Error && error.message.length > 0,
    );
  }
  assert.equal(calls.length, 0);
});

test("normalizeApnsConfig returns null when any field is missing", () => {
  const full = {
    teamId: "T",
    keyId: "K",
    privateKeyPem: "P",
    bundleId: "B",
    environment: "production",
  };
  assert.notEqual(apns.normalizeApnsConfig(full), null);
  for (const key of ["teamId", "keyId", "privateKeyPem", "bundleId"]) {
    assert.equal(apns.normalizeApnsConfig({ ...full, [key]: undefined }), null);
  }
});

test("normalizeApnsConfig trims values and defaults the environment", () => {
  assert.deepEqual(
    apns.normalizeApnsConfig({
      teamId: " TEAMID9999 ",
      keyId: "KEYID99999\n",
      privateKeyPem: "  pem-body  ",
      bundleId: " com.kwvrs.itrack ",
    }),
    {
      teamId: "TEAMID9999",
      keyId: "KEYID99999",
      privateKeyPem: "pem-body",
      bundleId: "com.kwvrs.itrack",
      environment: "production",
    },
  );
  const sandbox = { ...CONFIG, environment: " Sandbox " };
  assert.equal(apns.normalizeApnsConfig(sandbox).environment, "sandbox");
  assert.equal(
    apns.normalizeApnsConfig({ ...CONFIG, environment: "development" })
      .environment,
    "sandbox",
  );
  assert.equal(
    apns.normalizeApnsConfig({ ...CONFIG, environment: "" }).environment,
    "production",
  );
  assert.equal(apns.normalizeApnsConfig({ ...CONFIG, bundleId: "   " }), null);
});
