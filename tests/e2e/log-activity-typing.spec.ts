import { expect, test } from "./fixtures";

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
