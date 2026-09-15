// Replaces tests/rendered-html.test.mjs subtests: the draft-persistence and calendar pins of "ships the installable phone companion without caching private data" — behaviour those pins encoded is asserted here against the running app. The typing regression below moved here verbatim from tests/e2e/log-activity-typing.spec.ts.
import { expect, freshIdentity, test } from "./fixtures";

// app-ux-01 / architecture-M-01: the second keystroke in any log-activity
// field used to throw inside a deferred state updater and unmount the app.
// Typing two characters into each field, slowly enough for the draft-persist
// effect to schedule its timeouts between keys, is the exact reproduction.
// Read-only against the demo workspace: the sheet is never submitted.
test("typing two characters into every log-activity field does not crash the app", async ({ app, page }) => {
  await app.goto("/");
  // No identity header on localhost resolves to the demo user; a spec that
  // saved anything here would mutate the shared dev D1 for every later run.
  expect((await app.workspace()).user.isDemo).toBe(true);
  const sheet = await app.openLog();

  // Checked after every field so a crash is reported as the thrown error
  // rather than as the input that vanished with the unmounted sheet.
  const title = sheet.locator('input[name="title"]');
  await title.click();
  await title.pressSequentially("Et", { delay: 300 });
  app.expectNoErrors();
  await expect(title).toHaveValue("Et");

  const units = sheet.locator('input[name="totalUnits"]');
  await units.click();
  await units.pressSequentially("12", { delay: 300 });
  app.expectNoErrors();
  await expect(units).toHaveValue("12");

  const allocated = sheet.locator('input[name="allocatedUnits"]');
  await allocated.click();
  await allocated.fill("");
  await allocated.pressSequentially("11", { delay: 300 });
  app.expectNoErrors();
  await expect(allocated).toHaveValue("11");

  const provider = sheet.locator('input[name="provider"]');
  await provider.click();
  await provider.pressSequentially("NB", { delay: 300 });
  app.expectNoErrors();
  await expect(provider).toHaveValue("NB");

  // A date input takes whole values; two fills 300 ms apart hit the same
  // pending-lane path a second keystroke does.
  const completion = sheet.locator('input[name="completionDate"]');
  await completion.fill("2026-01-05");
  await page.waitForTimeout(300);
  await completion.fill("2026-01-06");
  app.expectNoErrors();
  await expect(completion).toHaveValue("2026-01-06");

  await expect(sheet).toBeVisible();
  await expect(page.locator("#main-content")).toBeVisible();
  app.expectNoErrors();
});

test("the completion date defaults to a calendar date", async ({ app }) => {
  // Task 11 sharpens this to the local date under a fixed clock.
  await app.goto("/");
  const sheet = await app.openLog();
  await expect(sheet.locator('input[name="completionDate"]')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  app.expectNoErrors();
});

test.describe("as a new account", () => {
  test.use({ identity: freshIdentity() });

  test("a draft is saved in this browser, survives a reload, and saves as a record", async ({ page, app }) => {
    await app.seedCredential();
    await app.goto("/");
    let sheet = await app.openLog();
    await sheet.locator('input[name="title"]').fill("Draft course");
    // The note flips to "saving" as the draft changes and to "saved" 250 ms
    // later, once localStorage holds it.
    const note = sheet.getByRole("status").filter({ hasText: "in this browser" });
    await expect(note).toContainText("Saving in this browser");
    await expect(note).toContainText("Saved in this browser");

    // A fresh page load in the same browser context keeps localStorage, so
    // the sheet reopens on the draft.
    await app.goto("/");
    sheet = await app.openLog();
    await expect(sheet.locator('input[name="title"]')).toHaveValue("Draft course");
    await expect(
      sheet.getByRole("status").filter({ hasText: "in this browser" }),
    ).toContainText("Saved in this browser");

    await sheet.locator('input[name="totalUnits"]').fill("2");
    // Credits to apply follow the certificate amount until changed by hand.
    await expect(sheet.locator('input[name="allocatedUnits"]')).toHaveValue("2");
    await sheet.locator('input[name="completionDate"]').fill("2026-06-02");
    await sheet.getByRole("button", { name: "Save activity" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Recent learning" }).getByText("Draft course"),
    ).toBeVisible();
    app.expectNoErrors();
  });
});
