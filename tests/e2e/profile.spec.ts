// Replaces tests/rendered-html.test.mjs subtests: "ships an accessible phone-first weekly-rhythm control" — behaviour those pins encoded is asserted here against the running app.
import { expect, freshIdentity, test } from "./fixtures";

test("Profile names the signed-in person, and the weekly target is a labelled radio group of finger-sized rows", async ({ page, app }) => {
  await app.goto("/profile");
  await expect(page).toHaveTitle("Account · iTrack");
  await expect(app.tab("Account")).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Signed in as")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Alex Morgan", exact: true })).toBeVisible();
  const target = page.getByRole("group", { name: "Weekly action target" });
  const radios = target.getByRole("radio");
  await expect(radios).toHaveCount(5);
  for (const label of ["Light", "Steady", "Balanced", "Focused", "Ambitious"]) {
    await expect(target.getByRole("radio", { name: label })).toBeVisible();
  }
  // Each option's whole row is the tap target (≥ 44 px). The retired pin
  // read this off the phone stylesheet; the phone projects are the ones it
  // was about, and the rule holds at every viewport.
  for (const radio of await radios.all()) {
    const row = await radio.locator("..").boundingBox();
    expect(row?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  app.expectNoErrors();
});

test("Manage reminders opens the check-in settings", async ({ page, app }) => {
  await app.goto("/profile");
  await page.getByRole("button", { name: "Manage reminders" }).click();
  await expect(app.dialog("Due-date check-ins")).toBeVisible();
  app.expectNoErrors();
});

test("the local preview has no sign-out control", async ({ page, app }) => {
  await app.goto("/profile");
  await expect(page.getByText("Local preview")).toBeVisible();
  await expect(page.locator('form[method="post"][action="/auth/logout"]')).toHaveCount(0);
  app.expectNoErrors();
});

test.describe("as a signed-in account", () => {
  test.use({ identity: freshIdentity() });

  test("sign out is a POST form to /auth/logout", async ({ page, app }) => {
    await app.goto("/profile");
    const form = page.locator('form[method="post"][action="/auth/logout"]');
    await expect(form).toHaveCount(1);
    await expect(form.getByRole("button", { name: "Sign out" })).toBeVisible();
    // Never submitted here: /auth/logout belongs to the gateway, which
    // `npm run dev` does not run (it would 404).
    app.expectNoErrors();
  });
});
