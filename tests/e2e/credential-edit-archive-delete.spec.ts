import { expect, freshIdentity, test } from "./fixtures";

// app-ux-03 / spec §4 "Credential edit / delete / archive": a credential can
// be renamed, archived (gone from Home and Credentials, listed under History →
// Archived credentials, restorable from there) and deleted, where delete only
// enables once the exact credential name is typed. Every write lands on a
// fresh identity; the demo workspace is never touched.
test.use({ identity: freshIdentity() });

test("a credential is renamed, archived, restored from History and deleted by typing its name", async ({ app, page }) => {
  const { id } = await app.seedCredential();
  await app.goto(`/credentials/${id}`);

  // Edit → rename. The heading is the credential name, so it proves the
  // refetched workspace carries the new name.
  await page.getByRole("button", { name: "Edit credential" }).click();
  const editor = app.dialog("Edit credential");
  await expect(editor).toBeVisible();
  await editor.locator('input[name="credentialName"]').fill("Renamed credential");
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(editor).toHaveCount(0);
  await expect(page.locator("h1.push-title")).toHaveText("Renamed credential");

  // Archive → the pushed detail bounces to /credentials, which is empty for
  // this identity, and Home no longer names the credential either.
  await page.getByRole("button", { name: "Archive credential" }).click();
  await expect(page).toHaveURL(/\/credentials$/);
  await expect(page.locator("h1.push-title")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Your credentials" })).toHaveCount(0);
  await expect(page.getByText("Add your first credential")).toBeVisible();
  await app.tab("Home").click();
  await expect(page.getByText("Renamed credential")).toHaveCount(0);

  // History → Archived credentials → Restore, then it is listed again.
  await app.goto("/history");
  await page.locator("#archived-credentials-summary").click();
  await page.getByRole("button", { name: "Restore Renamed credential" }).click();
  await expect(page.locator("#archived-credentials-summary")).toHaveCount(0);
  await app.goto("/credentials");
  const list = page.getByRole("region", { name: "Your credentials" });
  await expect(list).toContainText("Renamed credential");

  // Delete: the confirm button is inert until the exact name is typed.
  await list.getByRole("button", { name: "Renamed credential" }).click();
  await expect(page).toHaveURL(new RegExp(`/credentials/${id}$`));
  await page.getByRole("button", { name: "Delete credential…" }).click();
  const confirm = app.dialog("Delete Renamed credential?");
  await expect(confirm).toBeVisible();
  const deleteButton = confirm.getByRole("button", { name: "Delete permanently" });
  await expect(deleteButton).toBeDisabled();
  await confirm.locator('input[name="confirmName"]').fill("Renamed credential");
  await expect(deleteButton).toBeEnabled();
  await deleteButton.click();
  await expect(page).toHaveURL(/\/credentials$/);
  await expect(page.getByText("Add your first credential")).toBeVisible();

  const workspace = await app.workspace();
  expect(workspace.credentials).toHaveLength(0);
  expect(workspace.archivedCredentials ?? []).toHaveLength(0);
  app.expectNoErrors();
});
