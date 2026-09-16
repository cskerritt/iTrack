// Replaces tests/rendered-html.test.mjs subtests: the History-row pins (the labelled per-row controls and sr-only field labels) of "ships an accessible phone-first weekly-rhythm control" — behaviour those pins encoded is asserted here against the running app.
import { expect, freshIdentity, test } from "./fixtures";

test("History lists the demo record with a labelled Edit control that opens the editor", async ({ page, app }) => {
  await app.goto("/history");
  await expect(page).toHaveTitle("Activity log · iTrack");
  await expect(app.tab("Activity log")).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Your learning, organized as you go." }),
  ).toBeVisible();
  const records = page.getByRole("region", { name: "Completed activities" });
  await expect(records.getByText("Ethics in Digital Practice")).toBeVisible();
  // The row's control names its record, so it is unambiguous read aloud.
  await records.getByRole("button", { name: "Edit Ethics in Digital Practice" }).click();
  const editor = app.dialog("Edit learning record");
  await expect(editor).toBeVisible();
  // Read-only against the demo: close without saving.
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toHaveCount(0);
  app.expectNoErrors();
});

test.describe("as a new account", () => {
  test.use({ identity: freshIdentity() });

  test("archiving a record moves it under Archived records, and Restore brings it back", async ({ page, app }) => {
    const { id: credentialId } = await app.seedCredential();
    await app.seedActivity(credentialId, { title: "E2E archive me" });
    await app.goto("/history");
    const records = page.getByRole("region", { name: "Completed activities" });
    await expect(records.getByText("E2E archive me")).toBeVisible();
    await records.getByRole("button", { name: "Edit E2E archive me" }).click();
    const editor = app.dialog("Edit learning record");
    // Archive is two steps: the trigger swaps for a confirmation that
    // carries the same label.
    await editor.getByRole("button", { name: "Archive record" }).click();
    await expect(editor.getByRole("alert")).toContainText("Archive this learning record?");
    await editor.getByRole("button", { name: "Archive record" }).click();
    await expect(editor).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Learning record archived." }),
    ).toBeVisible();
    await expect(records.getByText("E2E archive me")).toHaveCount(0);
    const archived = page.locator("summary").filter({ hasText: "Archived records" });
    await expect(archived).toBeVisible();
    await archived.click();
    await page.getByRole("button", { name: "Restore E2E archive me" }).click();
    await expect(records.getByText("E2E archive me")).toBeVisible();
    await expect(page.locator("summary").filter({ hasText: "Archived records" })).toHaveCount(0);
    app.expectNoErrors();
  });
});
