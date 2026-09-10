import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_ENDED_MESSAGE,
  UNEXPECTED_RESPONSE_MESSAGE,
  readApiResponse,
} from "../.test-build/apiResponse.js";

test("JSON responses come back typed with ok/status", async () => {
  const response = new Response(JSON.stringify({ ok: true, id: "a1" }), {
    status: 200, headers: { "content-type": "application/json; charset=utf-8" },
  });
  assert.deepEqual(await readApiResponse(response), { kind: "json", ok: true, status: 200, data: { ok: true, id: "a1" } });
  const failed = new Response(JSON.stringify({ error: "nope", code: "cycle_closed" }), {
    status: 409, headers: { "content-type": "application/json" },
  });
  assert.deepEqual(await readApiResponse(failed), { kind: "json", ok: false, status: 409, data: { error: "nope", code: "cycle_closed" } });
});

test("a 401 is session-ended regardless of body", async () => {
  for (const body of ['{"error":"unauthenticated"}', "Authentication required", ""]) {
    const response = new Response(body, { status: 401, headers: { "content-type": "text/plain" } });
    assert.deepEqual(await readApiResponse(response), { kind: "session-ended", status: 401 });
  }
});

test("non-JSON bodies and malformed JSON are unexpected, never a SyntaxError", async () => {
  const html = new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
  assert.deepEqual(await readApiResponse(html), { kind: "unexpected", status: 502, text: "<html>502 Bad Gateway</html>" });
  const broken = new Response("{not json", { status: 200, headers: { "content-type": "application/json" } });
  assert.deepEqual(await readApiResponse(broken), { kind: "unexpected", status: 200, text: "{not json" });
  const noType = new Response("Upstream unavailable", { status: 502 });
  assert.equal((await readApiResponse(noType)).kind, "unexpected");
});

test("messages are the exact spec copy", () => {
  assert.equal(UNEXPECTED_RESPONSE_MESSAGE, "The server returned an unexpected response.");
  assert.equal(SESSION_ENDED_MESSAGE, "Your sign-in needs to be refreshed.");
});
