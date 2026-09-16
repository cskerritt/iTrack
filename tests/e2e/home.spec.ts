// Replaces tests/rendered-html.test.mjs subtests: "pushes credential detail onto the navigation stack", "leaves no history entry the user cannot get out of", "slides screens in and out and follows the back gesture", "answers touch the way the platform does" — behaviour those pins encoded is asserted here against the running app.
import { expect, freshIdentity, test } from "./fixtures";

// The demo identity (localhost, no header) is read-only in every spec: its
// seed is one NJ LCSW credential, an ethics activity and three tasks
// (db/runtime.ts ensureDemoWorkspace). Nothing at this level saves.

test("Home is the current tab, names the credential, and scores it", async ({ page, app }) => {
  await app.goto("/");
  await expect(app.tab("Home")).toHaveAttribute("aria-current", "page");
  await expect(app.tab("Credentials")).not.toHaveAttribute("aria-current", "page");
  await expect(page).toHaveTitle("Home · iTrack");
  await expect(
    page.getByRole("heading", { name: "Licensed Clinical Social Worker", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Best next action")).toBeVisible();
  // The readiness ring and every other meter announce a value, not a shape.
  const bars = page.getByRole("progressbar");
  await expect(bars.first()).toBeVisible();
  for (const bar of await bars.all()) {
    await expect(bar).toHaveAttribute("aria-valuenow", /^\d+(\.\d+)?$/);
  }
  // The hero ring counts credits (spec §5.1), the timeline lists the demo
  // deadline as a real button, and both are named for assistive technology.
  await expect(
    page.getByRole("progressbar", { name: "Licensed Clinical Social Worker: 5 of 40 credits counted" }),
  ).toHaveAttribute("aria-valuenow", "13");
  await expect(
    page
      .getByRole("list", { name: "Deadlines in the next twelve months" })
      .getByRole("button", { name: /Licensed Clinical Social Worker, Nov 30, 2026/ }),
  ).toBeVisible();
  app.expectNoErrors();
});

test("View plan opens the credential and the browser back button returns Home with focus on its heading", async ({ page, app }) => {
  await app.goto("/");
  await page.getByRole("button", { name: "View plan" }).click();
  await expect(page).toHaveURL(/\/credentials\/[^/]+$/);
  const detailHeading = page
    .getByRole("main")
    .getByRole("heading", { level: 1, name: "Licensed Clinical Social Worker", exact: true });
  await expect(detailHeading).toBeVisible();
  // a11y-03 / a11y-M-02: every navigation lands focus on the new heading.
  await expect(detailHeading).toBeFocused();
  await expect(page).toHaveTitle("Licensed Clinical Social Worker · iTrack");
  await page.goBack();
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/$/);
  await expect(page).toHaveTitle("Home · iTrack");
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeFocused();
  // One screen is mounted at a time, so the hero heading is unique at once.
  await expect(
    page.getByRole("heading", { name: "Licensed Clinical Social Worker", exact: true }),
  ).toBeVisible();
  app.expectNoErrors();
});

test("Add task opens the personal-task sheet", async ({ page, app }) => {
  await app.goto("/");
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(app.dialog("Add a personal task")).toBeVisible();
  app.expectNoErrors();
});

test.describe("Log credits", () => {
  // Opening the sheet writes a browser draft only, but the check-in this
  // test needs must not depend on what a human has dismissed in the shared
  // demo workspace, so it is seeded under a throwaway identity.
  test.use({ identity: freshIdentity() });

  const isoDaysFromToday = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  test("a deadline check-in's Log credits opens the sheet with that credential chosen", async ({ page, app }) => {
    // A deadline 20 days out sits inside the 30-day lead window, so Home
    // shows a "Needs attention" check-in for it (app/lib/reminders.ts
    // reminderActivationDate; lead days default to [90, 30, 7, 1]).
    const { id } = await app.seedCredential({
      credentialName: "E2E deadline credential",
      cycleStart: isoDaysFromToday(-345),
      deadline: isoDaysFromToday(20),
    });
    await app.goto("/");
    await expect(page.getByText("Needs attention")).toBeVisible();
    await page.getByRole("button", { name: "Log credits" }).click();
    const sheet = app.dialog("Log completed learning");
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('select[name="credentialId"]')).toHaveValue(id);
    app.expectNoErrors();
  });
});
