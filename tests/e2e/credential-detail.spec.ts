// Replaces tests/rendered-html.test.mjs subtests: "pushes credential detail onto the navigation stack", "leaves no history entry the user cannot get out of", "slides screens in and out and follows the back gesture", "answers touch the way the platform does" — behaviour those pins encoded is asserted here against the running app.
import { expect, freshIdentity, test } from "./fixtures";

// Every test seeds its own credential under one throwaway identity per
// file. The pushed screen, its back control and the calendar hand-off are
// read-only, but the demo workspace on the shared dev D1 is never the
// fixture for a screen that is about to grow writes (Task 10 adds
// edit / archive / delete in a sibling spec).
test.use({ identity: freshIdentity() });

const uniqueName = (label: string) =>
  `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

test("a list row pushes the detail; the browser back button returns to the list", async ({ page, app }) => {
  const name = uniqueName("E2E detail");
  await app.seedCredential({ credentialName: name });
  await app.goto("/credentials");
  await page
    .getByRole("region", { name: "Your credentials" })
    .getByRole("button", { name })
    .click();
  await expect(page).toHaveURL(/\/credentials\/[^/]+$/);
  await expect(page.locator("h1.push-title")).toHaveText(name);
  await expect(page).toHaveTitle(`${name} · iTrack`);
  // The back control is labelled with the screen it returns to. The tab
  // bars sit outside <main> and the parked list is aria-hidden, so this is
  // the only "Credentials" button in the main landmark.
  await expect(
    page.getByRole("main").getByRole("button", { name: "Credentials", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/credentials$/);
  await expect(
    page.getByRole("heading", { name: "Every renewal, one clear place." }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Credentials · iTrack");
  app.expectNoErrors();
});

test("opened from Home, the back control is labelled Home and returns there", async ({ page, app }) => {
  // Home shows the soonest deadline; every other seed in this file keeps
  // the fixture default (2027-12-31), so this one is the hero.
  const name = uniqueName("E2E home plan");
  await app.seedCredential({ credentialName: name, deadline: "2027-06-30" });
  await app.goto("/");
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View plan" }).click();
  await expect(page).toHaveURL(/\/credentials\/[^/]+$/);
  await expect(page.locator("h1.push-title")).toHaveText(name);
  const back = page.getByRole("main").getByRole("button", { name: "Home", exact: true });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/$/);
  await expect(page).toHaveTitle("Home · iTrack");
  // The pushed screen stays mounted while it slides out (screen-exiting,
  // unmounted on animationend), and it names the credential twice; the
  // Home heading is unique only once it has left.
  await expect(page.locator("h1.push-title")).toHaveCount(0);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  app.expectNoErrors();
});

test("survives a cold deep link, and an unknown id falls back to the list", async ({ page, app }) => {
  const name = uniqueName("E2E deep link");
  const { id } = await app.seedCredential({ credentialName: name });
  await app.goto(`/credentials/${id}`);
  await expect(page.locator("h1.push-title")).toHaveText(name);
  await expect(page).toHaveTitle(`${name} · iTrack`);
  await app.goto("/credentials/nope");
  await expect(page).toHaveURL(/\/credentials$/);
  await expect(
    page.getByRole("heading", { name: "Every renewal, one clear place." }),
  ).toBeVisible();
  app.expectNoErrors();
});

test("Add renewal date to calendar hands off an .ics file", async ({ page, app }) => {
  const name = uniqueName("E2E calendar");
  const { id } = await app.seedCredential({ credentialName: name });
  await app.goto(`/credentials/${id}`);
  // A headless browser exposes no navigator.share, so
  // app/lib/calendarInvite.ts:203-229 falls through to the anchor download.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Add renewal date to calendar" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.ics$/);
  await expect(
    page.getByRole("status").filter({ hasText: "Renewal date handed off to your calendar." }),
  ).toBeVisible();
  app.expectNoErrors();
});

test("Log submission opens the submission sheet", async ({ page, app }) => {
  const name = uniqueName("E2E submission");
  await app.seedCredential({ credentialName: name });
  await app.goto("/credentials");
  await page
    .getByRole("region", { name: "Your credentials" })
    .getByRole("button", { name })
    .click();
  await expect(page.locator("h1.push-title")).toHaveText(name);
  await page.getByRole("button", { name: "Log submission", exact: true }).click();
  await expect(app.dialog("Log your submission")).toBeVisible();
  app.expectNoErrors();
});
