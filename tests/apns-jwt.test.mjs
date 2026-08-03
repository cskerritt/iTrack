import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(
  new URL("../app/lib/apnsJwt.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const apnsJwt = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

function pemBlock(pkcs8, label = "PRIVATE KEY", newline = "\n") {
  const body = Buffer.from(pkcs8).toString("base64").match(/.{1,64}/g);
  return [
    `-----BEGIN ${label}-----`,
    ...body,
    `-----END ${label}-----`,
    "",
  ].join(newline);
}

async function generateTestKeyPem() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  return { pem: pemBlock(pkcs8), pkcs8, publicKey: pair.publicKey };
}

async function verifiedSignature(jwt, publicKey) {
  const [header, payload, signature] = jwt.split(".");
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    Buffer.from(signature, "base64url"),
    Buffer.from(`${header}.${payload}`),
  );
}

test("createApnsJwt produces a verifiable ES256 JWT", async () => {
  const { pem, publicKey } = await generateTestKeyPem();
  const jwt = await apnsJwt.createApnsJwt(
    { teamId: "TEAMID9999", keyId: "KEYID99999", privateKeyPem: pem },
    1_754_000_000_000,
  );
  const [h, p, sig] = jwt.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(header.alg, "ES256");
  assert.equal(header.kid, "KEYID99999");
  assert.equal(payload.iss, "TEAMID9999");
  assert.equal(payload.iat, 1_754_000_000); // seconds
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    Buffer.from(sig, "base64url"),
    Buffer.from(`${h}.${p}`),
  );
  assert.equal(ok, true);
});

test("rejects an unparseable PEM", async () => {
  await assert.rejects(
    apnsJwt.createApnsJwt(
      { teamId: "T", keyId: "K", privateKeyPem: "not-a-pem" },
      0,
    ),
  );
});

test("the JWT segments are unpadded base64url and the signature is raw r||s", async () => {
  const { pem, publicKey } = await generateTestKeyPem();
  const jwt = await apnsJwt.createApnsJwt(
    { teamId: "TEAMID9999", keyId: "KEYID99999", privateKeyPem: pem },
    1_754_000_000_123,
  );
  const parts = jwt.split(".");

  assert.equal(parts.length, 3);
  for (const part of parts) {
    assert.match(part, /^[A-Za-z0-9_-]+$/);
  }
  assert.equal(Buffer.from(parts[2], "base64url").byteLength, 64);
  assert.equal(
    JSON.parse(Buffer.from(parts[1], "base64url").toString()).iat,
    1_754_000_000,
  );
  assert.equal(await verifiedSignature(jwt, publicKey), true);
});

test("accepts CRLF line endings and surrounding whitespace in the PEM", async () => {
  const { pkcs8, publicKey } = await generateTestKeyPem();
  const jwt = await apnsJwt.createApnsJwt(
    {
      teamId: "TEAMID9999",
      keyId: "KEYID99999",
      privateKeyPem: `\n  ${pemBlock(pkcs8, "PRIVATE KEY", "\r\n")}  \n`,
    },
    1_754_000_000_000,
  );

  assert.equal(await verifiedSignature(jwt, publicKey), true);
});

test("rejects truncated, mislabelled and non-P-256 key material", async () => {
  const { pem, pkcs8 } = await generateTestKeyPem();
  const rejected = [
    pem.replace("-----END PRIVATE KEY-----\n", ""),
    pem.replace("-----BEGIN PRIVATE KEY-----\n", ""),
    pemBlock(pkcs8, "EC PRIVATE KEY"),
    pemBlock(pkcs8, "ENCRYPTED PRIVATE KEY"),
    `${pem}-----BEGIN PRIVATE KEY-----\n`,
    pemBlock(new Uint8Array([1, 2, 3, 4])),
    "-----BEGIN PRIVATE KEY-----\nnot base64!\n-----END PRIVATE KEY-----\n",
    "-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n",
    "",
  ];

  for (const privateKeyPem of rejected) {
    await assert.rejects(
      apnsJwt.createApnsJwt(
        { teamId: "TEAMID9999", keyId: "KEYID99999", privateKeyPem },
        1_754_000_000_000,
      ),
      (error) => error instanceof Error && error.message.length > 0,
    );
  }
});

test("rejects a missing team id, key id or issue time", async () => {
  const { pem } = await generateTestKeyPem();
  const config = {
    teamId: "TEAMID9999",
    keyId: "KEYID99999",
    privateKeyPem: pem,
  };

  await assert.rejects(
    apnsJwt.createApnsJwt({ ...config, teamId: "  " }, 1_754_000_000_000),
  );
  await assert.rejects(
    apnsJwt.createApnsJwt({ ...config, keyId: undefined }, 1_754_000_000_000),
  );
  await assert.rejects(apnsJwt.createApnsJwt(config, Number.NaN));
  await assert.rejects(apnsJwt.createApnsJwt(config, Number.POSITIVE_INFINITY));
});
