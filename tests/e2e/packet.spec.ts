// Replaces tests/rendered-html.test.mjs subtests: the `appSource` pins of "renders an escaped owner-scoped credential packet with countable progress" — behaviour those pins encoded is asserted here against the running app.
import { expect, freshIdentity, test } from "./fixtures";

test.use({ identity: freshIdentity() });

test("the detail screen links to the packet, which renders for its owner and 404s for anyone else", async ({ page, context, app }) => {
  const name = `E2E packet ${Date.now().toString(36)}`;
  const { id } = await app.seedCredential({ credentialName: name });
  await app.seedActivity(id, { title: "E2E packet course" });
  await app.goto(`/credentials/${id}`);
  const link = page.getByRole("link", { name: "Prepare credential packet" });
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  if (href === null) throw new Error("the packet link has no href");
  expect(href).toBe(`/api/export/packet?credentialId=${encodeURIComponent(id)}`);

  // The owner's packet: a document, not the app.
  const response = await page.goto(href);
  expect(response?.status()).toBe(200);
  await expect(page.locator("h1")).toHaveText(name);
  await expect(page.locator('meta[name="license-lantern-packet-version"]')).toHaveCount(1);
  await expect(page.getByText("E2E packet course")).toBeVisible();

  // A credential the caller does not own is not found — as a page and as JSON.
  const foreign = await page.goto("/api/export/packet?credentialId=not-mine");
  expect(foreign?.status()).toBe(404);
  await expect(page.locator("h1")).toHaveText("Packet unavailable");
  const json = await context.request.get(href.replace(id, "not-mine"), {
    headers: { accept: "application/json" },
  });
  expect(json.status()).toBe(404);
  expect(await json.json()).toEqual({ error: "Credential not found.", code: "credential_not_found" });
  app.expectNoErrors();
});
