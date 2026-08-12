import test from "node:test";
import assert from "node:assert/strict";
import { createResendSender } from "../deploy/railway/email.mjs";

test("unconfigured sender reports email-not-configured without fetching", async () => {
  let called = false;
  const send = createResendSender({
    apiKey: "", from: "", fetchImpl: async () => { called = true; },
  });
  assert.deepEqual(await send({ to: "a@b.co", subject: "s", html: "<p>h</p>", text: "t" }),
    { ok: false, error: "email-not-configured" });
  assert.equal(called, false);
});

test("posts to Resend with bearer auth and payload", async () => {
  let captured;
  const send = createResendSender({
    apiKey: "re_test_key",
    from: "iTrack <onboarding@example.com>",
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200, text: async () => "{}" };
    },
  });
  const result = await send({ to: "user@e.co", subject: "Verify", html: "<p>x</p>", text: "x" });
  assert.deepEqual(result, { ok: true });
  assert.equal(captured.url, "https://api.resend.com/emails");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.authorization, "Bearer re_test_key");
  const body = JSON.parse(captured.init.body);
  assert.deepEqual(body, {
    from: "iTrack <onboarding@example.com>",
    to: ["user@e.co"], subject: "Verify", html: "<p>x</p>", text: "x",
  });
});

test("non-2xx and thrown fetch both report send-failed", async () => {
  const failing = createResendSender({
    apiKey: "k", from: "f@e.co",
    fetchImpl: async () => ({ ok: false, status: 422, text: async () => "bad" }),
  });
  assert.deepEqual(await failing({ to: "a@b.co", subject: "s", html: "h", text: "t" }),
    { ok: false, error: "send-failed" });
  const throwing = createResendSender({
    apiKey: "k", from: "f@e.co",
    fetchImpl: async () => { throw new Error("network down"); },
  });
  assert.deepEqual(await throwing({ to: "a@b.co", subject: "s", html: "h", text: "t" }),
    { ok: false, error: "send-failed" });
});
