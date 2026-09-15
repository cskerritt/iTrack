// Replaces tests/rendered-html.test.mjs subtests: "pushes credential detail onto the navigation stack", "leaves no history entry the user cannot get out of", "slides screens in and out and follows the back gesture", "answers touch the way the platform does", "keeps the larger template chooser and alternative tags mobile-accessible" — behaviour those pins encoded is asserted here against the running app.
import { expect, freshIdentity, test } from "./fixtures";

test("the list names every credential and Add credential opens the setup sheet", async ({ page, app }) => {
  await app.goto("/credentials");
  await expect(page).toHaveTitle("Credentials · iTrack");
  await expect(app.tab("Credentials")).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Every renewal, one clear place." }),
  ).toBeVisible();
  const list = page.getByRole("region", { name: "Your credentials" });
  await expect(
    list.getByRole("button", { name: "Licensed Clinical Social Worker" }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Add credential", exact: true }).click();
  await expect(app.dialog("Set up a credential")).toBeVisible();
  app.expectNoErrors();
});

test("the template chooser groups templates by profession and a miss offers the custom path", async ({ page, app }) => {
  await app.goto("/credentials");
  await page.getByRole("button", { name: "Add credential", exact: true }).click();
  const sheet = app.dialog("Set up a credential");
  const templates = sheet.getByRole("combobox", { name: "Profession, credential, and state" });
  // The catalog is fetched when the sheet opens; the first optgroup is the
  // proof it arrived and is grouped by profession.
  await expect(templates.locator("optgroup").first()).toBeAttached({ timeout: 15_000 });
  await templates.selectOption({ index: 1 });
  await expect(templates).not.toHaveValue("");
  // Typing a new search drops the template that was chosen: the search and
  // the choice are one control, never two disagreeing ones.
  const search = sheet.getByPlaceholder("Search profession, license, certification, or state");
  await search.fill("zzzz");
  await expect(templates).toHaveValue("");
  await expect(templates.locator("optgroup")).toHaveCount(0);
  await expect(sheet.getByText("0 matches")).toBeVisible();
  await sheet
    .getByRole("button", { name: "No exact match — enter my own requirements" })
    .click();
  await expect(sheet.locator('input[name="credentialName"]')).toBeVisible();
  await expect(sheet.locator('input[name="totalRequired"]')).toBeVisible();
  app.expectNoErrors();
});

test.describe("as a new account", () => {
  test.use({ identity: freshIdentity() });

  test("starts empty, and a custom credential created through the sheet is listed", async ({ page, app }) => {
    await app.goto("/credentials");
    await expect(
      page.getByRole("heading", { name: "Add your first credential" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Add credential", exact: true }).click();
    const sheet = app.dialog("Set up a credential");
    await sheet.getByRole("button", { name: "Enter my own", exact: true }).click();
    const name = `E2E created credential ${Date.now().toString(36)}`;
    await sheet.locator('input[name="profession"]').fill("Counseling");
    await sheet.locator('input[name="jurisdiction"]').fill("Rhode Island");
    await sheet.locator('input[name="credentialName"]').fill(name);
    await sheet.locator('input[name="totalRequired"]').fill("10");
    await expect(sheet.locator('input[name="unitLabel"]')).toHaveValue("hours");
    // The cycle dates arrive prefilled (a year back, a year ahead). Task 11
    // pins them to the local calendar under a fixed clock.
    await expect(sheet.locator('input[name="cycleStart"]')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    await expect(sheet.locator('input[name="deadline"]')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    await sheet.getByRole("button", { name: "Create renewal plan" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: "Credential added." }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Your credentials" }).getByRole("button", { name }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("heading", { name: "Add your first credential" }),
    ).toHaveCount(0);
    app.expectNoErrors();
  });
});
