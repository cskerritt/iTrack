import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(
  new URL("../app/lib/rfc8291Push.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const webPush = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

const RFC8291_VECTOR = {
  plaintext: "When I grow up, I want to be a watermelon",
  userAgentPublicKey:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  senderPublicKey:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  senderPrivateKey: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  authenticationSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

function arrayBuffer(value) {
  return Uint8Array.from(value).buffer;
}

function decodedJson(value) {
  return JSON.parse(
    new TextDecoder().decode(webPush.decodeBase64Url(value)),
  );
}

async function deterministicSenderKeyPair() {
  const publicKeyBytes = webPush.decodeBase64Url(
    RFC8291_VECTOR.senderPublicKey,
  );
  const privateKeyBytes = webPush.decodeBase64Url(
    RFC8291_VECTOR.senderPrivateKey,
  );
  const publicKey = await crypto.subtle.importKey(
    "raw",
    arrayBuffer(publicKeyBytes),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: webPush.encodeBase64Url(publicKeyBytes.slice(1, 33)),
      y: webPush.encodeBase64Url(publicKeyBytes.slice(33, 65)),
      d: webPush.encodeBase64Url(privateKeyBytes),
      ext: true,
      key_ops: ["deriveBits"],
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  return { publicKey, privateKey };
}

async function generatedVapidConfig(subject = "mailto:push@example.com") {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    pair,
    config: {
      publicKey: webPush.encodeBase64Url(publicKey),
      privateKey: privateJwk.d,
      subject,
    },
  };
}

async function generatedSubscription(
  endpoint = "https://fcm.googleapis.com/fcm/send/capability-token",
) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return {
    endpoint,
    expirationTime: null,
    keys: {
      p256dh: webPush.encodeBase64Url(publicKey),
      auth: webPush.encodeBase64Url(
        crypto.getRandomValues(new Uint8Array(16)),
      ),
    },
  };
}

test("RFC 8291 Appendix A encrypts to the published aes128gcm vector", async () => {
  const encrypted = await webPush.encryptRfc8291Payload(
    new TextEncoder().encode(RFC8291_VECTOR.plaintext),
    webPush.decodeBase64Url(RFC8291_VECTOR.userAgentPublicKey),
    webPush.decodeBase64Url(RFC8291_VECTOR.authenticationSecret),
    {
      salt: webPush.decodeBase64Url(RFC8291_VECTOR.salt),
      ephemeralKeyPair: await deterministicSenderKeyPair(),
    },
  );

  assert.equal(webPush.encodeBase64Url(encrypted.body), RFC8291_VECTOR.body);
  assert.equal(encrypted.body.byteLength, 144);
  assert.equal(new DataView(encrypted.body.buffer).getUint32(16), 4_096);
  assert.equal(encrypted.body[20], 65);
});

test("RFC 8291 enforces the 3993-byte single-record payload limit", async () => {
  const userAgentPublicKey = webPush.decodeBase64Url(
    RFC8291_VECTOR.userAgentPublicKey,
  );
  const authenticationSecret = webPush.decodeBase64Url(
    RFC8291_VECTOR.authenticationSecret,
  );
  const encryptionOptions = {
    salt: webPush.decodeBase64Url(RFC8291_VECTOR.salt),
    ephemeralKeyPair: await deterministicSenderKeyPair(),
  };
  const largest = await webPush.encryptRfc8291Payload(
    new Uint8Array(webPush.RFC8291_MAX_PAYLOAD_BYTES),
    userAgentPublicKey,
    authenticationSecret,
    encryptionOptions,
  );
  assert.equal(largest.body.byteLength, webPush.RFC8291_RECORD_SIZE);

  await assert.rejects(
    webPush.encryptRfc8291Payload(
      new Uint8Array(webPush.RFC8291_MAX_PAYLOAD_BYTES + 1),
      userAgentPublicKey,
      authenticationSecret,
      encryptionOptions,
    ),
    (error) => error?.code === "payload_too_large",
  );
});

test("RFC 8292 VAPID JWT has the endpoint origin audience and raw ES256 signature", async () => {
  const { pair, config } = await generatedVapidConfig();
  const now = 1_453_480_568_000;
  const result = await webPush.createVapidAuthorization(
    "https://updates.push.services.mozilla.com/wpush/v2/secret",
    config,
    now,
  );
  const parts = result.token.split(".");

  assert.equal(parts.length, 3);
  assert.deepEqual(decodedJson(parts[0]), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(decodedJson(parts[1]), {
    aud: "https://updates.push.services.mozilla.com",
    exp: 1_453_523_768,
    sub: "mailto:push@example.com",
  });
  const signature = webPush.decodeBase64Url(parts[2]);
  assert.equal(signature.byteLength, 64);
  assert.equal(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      arrayBuffer(signature),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    ),
    true,
  );
  assert.equal(
    result.authorization,
    `vapid t=${result.token},k=${config.publicKey}`,
  );
});

test("sender emits aes128gcm/VAPID headers and never follows a redirect", async () => {
  const subscription = await generatedSubscription();
  const { config } = await generatedVapidConfig();
  const calls = [];
  const fetcher = async (endpoint, init) => {
    calls.push({ endpoint, init });
    return new Response(null, {
      status: 307,
      headers: { location: "https://attacker.example/other" },
    });
  };

  const response = await webPush.sendRfc8291WebPush(
    subscription,
    config,
    new TextEncoder().encode(JSON.stringify({ path: "/" })),
    {
      now: 1_800_000_000_000,
      ttl: 86_400,
      urgency: "normal",
      topic: "ll-test",
    },
    fetcher,
  );

  assert.equal(response.status, 307);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, subscription.endpoint);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("content-encoding"), "aes128gcm");
  assert.equal(headers.get("ttl"), "86400");
  assert.equal(headers.get("urgency"), "normal");
  assert.equal(headers.get("topic"), "ll-test");
  assert.match(
    headers.get("authorization"),
    /^vapid t=[^.]+\.[^.]+\.[A-Za-z0-9_-]+,k=[A-Za-z0-9_-]+$/,
  );
  assert.equal(headers.has("crypto-key"), false);
  assert.equal(headers.has("encryption"), false);
  assert.ok(calls[0].init.body instanceof ArrayBuffer);
});

test("expired subscriptions and malformed base64url fail before fetch", async () => {
  const now = 1_800_000_000_000;
  const subscription = {
    ...(await generatedSubscription()),
    expirationTime: now,
  };
  const { config } = await generatedVapidConfig();
  let fetchCount = 0;

  await assert.rejects(
    webPush.sendRfc8291WebPush(
      subscription,
      config,
      new Uint8Array(),
      { now },
      async () => {
        fetchCount += 1;
        return new Response(null, { status: 201 });
      },
    ),
    (error) => error?.code === "expired_subscription",
  );
  assert.equal(fetchCount, 0);
  assert.throws(
    () => webPush.decodeBase64Url("AQ=="),
    (error) => error?.code === "invalid_base64url",
  );
  assert.throws(
    () => webPush.validatePushEndpoint("https://127.0.0.1/push"),
    (error) => error?.code === "invalid_endpoint",
  );
  assert.throws(
    () =>
      webPush.validatePushEndpoint(
        "https://attacker.example.net/browser-shaped/path",
      ),
    (error) => error?.code === "invalid_endpoint",
  );
});

test("push endpoints are restricted to mainstream browser push services", () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/wp/subscription-token",
    "https://fcm.googleapis.com/fcm/send/legacy-token",
    "https://updates.push.services.mozilla.com/wpush/v2/token",
    "https://push.services.mozilla.com/wpush/v2/token",
    "https://web.push.apple.com/QHh5/token",
    "https://api.push.apple.com/3/device/token",
    "https://wns2-db5p.notify.windows.com/w/?token=value",
  ]) {
    assert.equal(webPush.validatePushEndpoint(endpoint).href, endpoint);
  }

  for (const endpoint of [
    "https://push.example.net/message/token",
    "https://fcm.googleapis.com.attacker.example/message/token",
    "https://web.push.apple.com.attacker.example/message/token",
    "https://notify.windows.com.attacker.example/message/token",
    "https://web.push.apple.com./message/token",
    "https://fcm.googleapis.com:444/message/token",
  ]) {
    assert.throws(
      () => webPush.validatePushEndpoint(endpoint),
      (error) => error?.code === "invalid_endpoint",
    );
  }
});
