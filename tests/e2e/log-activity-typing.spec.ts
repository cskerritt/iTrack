import { expect, test } from "@playwright/test";

// app-ux-01 / architecture-M-01: the second keystroke in any log-activity
// field used to throw inside a deferred state updater and unmount the app.
// Typing two characters into each field, slowly enough for the draft-persist
// effect to schedule its timeouts between keys, is the exact reproduction.
test("typing two characters into every log-activity field does not crash the app", async ({ page }) => {
  // A render-time throw is uncaught in production (pageerror), but under
  // `npm run dev` vinext mounts a recovery boundary that catches it, and React
  // then reports it through console.error. Collect both so the spec names the
  // thrown error either way.
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && /^(?:[A-Z]\w*)?Error\b/.test(text)) {
      pageErrors.push(text.split("\n")[0]);
    }
  });
  // Checked after every field so a crash is reported as the thrown error
  // rather than as the input that vanished with the unmounted sheet.
  const expectNoPageErrors = () =>
    expect(pageErrors, pageErrors.join("\n")).toEqual([]);

  await page.goto("/");
  // The shell is server-rendered before React hydrates, so a click that lands
  // early is lost. The loading placeholder is swapped out only after the
  // client has hydrated and fetched the workspace; wait for that first.
  await expect(
    page.locator('[aria-busy="true"][aria-label="Loading iTrack"]'),
  ).toHaveCount(0, { timeout: 30_000 });
  await page.getByRole("button", { name: "Log activity" }).first().click();
  const sheet = page.locator(".modal-card");
  await expect(sheet).toBeVisible();

  const title = sheet.locator('input[name="title"]');
  await title.click();
  await title.pressSequentially("Et", { delay: 300 });
  expectNoPageErrors();
  await expect(title).toHaveValue("Et");

  const units = sheet.locator('input[name="totalUnits"]');
  await units.click();
  await units.pressSequentially("12", { delay: 300 });
  expectNoPageErrors();
  await expect(units).toHaveValue("12");

  const allocated = sheet.locator('input[name="allocatedUnits"]');
  await allocated.click();
  await allocated.fill("");
  await allocated.pressSequentially("11", { delay: 300 });
  expectNoPageErrors();
  await expect(allocated).toHaveValue("11");

  const provider = sheet.locator('input[name="provider"]');
  await provider.click();
  await provider.pressSequentially("NB", { delay: 300 });
  expectNoPageErrors();
  await expect(provider).toHaveValue("NB");

  // A date input takes whole values; two fills 300 ms apart hit the same
  // pending-lane path a second keystroke does.
  const completion = sheet.locator('input[name="completionDate"]');
  await completion.fill("2026-01-05");
  await page.waitForTimeout(300);
  await completion.fill("2026-01-06");
  expectNoPageErrors();
  await expect(completion).toHaveValue("2026-01-06");

  await expect(sheet).toBeVisible();
  await expect(page.locator("#main-content")).toBeVisible();
  expectNoPageErrors();
});
