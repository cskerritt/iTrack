import type { Page } from "@playwright/test";
import { expect, freshIdentity, test } from "./fixtures";

// The credential detail is a routed screen (spec §5.1 Layout): opening one
// pushes an ordinary history entry for /credentials/:id, its header is a
// PageHeader whose eyebrow is a breadcrumb link naming the URL parent
// ("Credentials" — never the tab it was opened from), and Back and Forward
// are the browser's own. Every navigation lands focus on the new screen's H1
// (a11y-03, a11y-M-02).
//
// Every test seeds its own credential under one throwaway identity per file:
// the demo workspace on the shared dev D1 is never the fixture for a screen
// that carries writes (edit / archive / delete live in a sibling spec).
test.use({ identity: freshIdentity() });

const uniqueName = (label: string) =>
  `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// The rail sits outside <main>, so "the H1 in main" is the screen's own.
const detailHeading = (page: Page, name: string) =>
  page.getByRole("main").getByRole("heading", { level: 1, name, exact: true });

const breadcrumb = (page: Page) =>
  page.getByRole("main").getByRole("link", { name: "Credentials", exact: true });

test("a list row opens the detail; the browser back button returns to the list", async ({ page, app }) => {
  const name = uniqueName("E2E detail");
  await app.seedCredential({ credentialName: name });
  await app.goto("/credentials");
  await page
    .getByRole("region", { name: "Your credentials" })
    .getByRole("button", { name })
    .click();
  await expect(page).toHaveURL(/\/credentials\/[^/]+$/);
  await expect(detailHeading(page, name)).toBeVisible();
  await expect(detailHeading(page, name)).toBeFocused();
  await expect(page).toHaveTitle(`${name} · iTrack`);
  // The breadcrumb names the URL parent; the rail's own Credentials link is
  // outside the main landmark, so this is the only one in it.
  await expect(breadcrumb(page)).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/credentials$/);
  await expect(
    page.getByRole("heading", { name: "Every renewal, one clear place." }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Credentials · iTrack");
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeFocused();
  app.expectNoErrors();
});

test("opened from Home, the breadcrumb still names Credentials and the browser back button returns Home", async ({ page, app }) => {
  // Home shows the soonest deadline; every other seed in this file keeps
  // the fixture default (2027-12-31), so this one is the hero.
  const name = uniqueName("E2E home plan");
  await app.seedCredential({ credentialName: name, deadline: "2027-06-30" });
  await app.goto("/");
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View plan" }).click();
  await expect(page).toHaveURL(/\/credentials\/[^/]+$/);
  await expect(detailHeading(page, name)).toBeFocused();
  // The URL parent, not the origin tab: the breadcrumb reads Credentials
  // even though Home opened it, and nothing in main is a "Home" link.
  await expect(breadcrumb(page)).toBeVisible();
  await expect(
    page.getByRole("main").getByRole("link", { name: "Home", exact: true }),
  ).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/$/);
  await expect(page).toHaveTitle("Home · iTrack");
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeFocused();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  app.expectNoErrors();
});

test("survives a cold deep link, and first paint keeps the browser's own focus", async ({ page, app }) => {
  const name = uniqueName("E2E deep link");
  const { id } = await app.seedCredential({ credentialName: name });
  await app.goto(`/credentials/${id}`);
  await expect(detailHeading(page, name)).toBeVisible();
  await expect(page).toHaveTitle(`${name} · iTrack`);
  // Adopting the URL on mount is not a navigation: the skip link stays the
  // first Tab stop.
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  app.expectNoErrors();
});

test("an unknown id falls back to the list and replaces its own entry, so Back leaves the app", async ({ page, app }) => {
  await app.goto("/credentials/nope");
  await expect(page).toHaveURL(/\/credentials$/);
  await expect(
    page.getByRole("heading", { name: "Every renewal, one clear place." }),
  ).toBeVisible();
  // The dead URL was REPLACED, not pushed over: the list is the first entry
  // the app owns, and Back leaves iTrack instead of bouncing again.
  await page.goBack();
  await expect(page).toHaveURL("about:blank");
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

test("switching tabs from a detail is ordinary routing: Back returns to the detail", async ({ page, app }) => {
  const name = uniqueName("E2E tab switch");
  await app.seedCredential({ credentialName: name });
  await app.goto("/credentials");
  await page
    .getByRole("region", { name: "Your credentials" })
    .getByRole("button", { name })
    .click();
  await expect(page).toHaveURL(/\/credentials\/[^/]+$/);
  await expect(detailHeading(page, name)).toBeVisible();
  await app.tab("Home").click();
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/$/);
  await expect(page).toHaveTitle("Home · iTrack");
  await expect(app.tab("Home")).toHaveAttribute("aria-current", "page");
  await expect(detailHeading(page, name)).toHaveCount(0);
  // Nothing was unwound: the detail is the previous entry, so Back returns
  // to it, with focus on its heading.
  await page.goBack();
  await expect(page).toHaveURL(/\/credentials\/[^/]+$/);
  await expect(detailHeading(page, name)).toBeVisible();
  await expect(detailHeading(page, name)).toBeFocused();
  app.expectNoErrors();
});

test("re-tapping Credentials from a detail returns to the list, and Back returns to the detail", async ({ page, app }) => {
  const name = uniqueName("E2E re-tap");
  await app.seedCredential({ credentialName: name });
  await app.goto("/credentials");
  await page
    .getByRole("region", { name: "Your credentials" })
    .getByRole("button", { name })
    .click();
  await expect(page).toHaveURL(/\/credentials\/[^/]+$/);
  await expect(detailHeading(page, name)).toBeVisible();
  await expect(app.tab("Credentials")).toHaveAttribute("aria-current", "page");
  await app.tab("Credentials").click();
  await expect(page).toHaveURL(/\/credentials$/);
  await expect(page).toHaveTitle("Credentials · iTrack");
  await expect(detailHeading(page, name)).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Every renewal, one clear place." }),
  ).toBeVisible();
  // /credentials was pushed over the detail (ordinary routing), so Back
  // returns to the detail rather than leaving the app.
  await page.goBack();
  await expect(page).toHaveURL(/\/credentials\/[^/]+$/);
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
  await expect(detailHeading(page, name)).toBeVisible();
  await page.getByRole("button", { name: "Log submission", exact: true }).click();
  await expect(app.dialog("Log your submission")).toBeVisible();
  app.expectNoErrors();
});
