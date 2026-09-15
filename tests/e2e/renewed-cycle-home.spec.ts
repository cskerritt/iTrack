import { expect, freshIdentity, test } from "./fixtures";

// app-ux-04 / app-ux-18: after a renewal was accepted, a reload put the
// renewed cycle back on Home with a live countdown (it had the soonest
// deadline of every row), and the Credentials list showed it as a sibling
// row. Home must show the successor after a reload; a renewed cycle opened
// on purpose shows when it ended instead of days; the list shows one row per
// credential with its past cycles folded underneath.
test.use({ identity: freshIdentity() });

const LOADING = '[aria-busy="true"][aria-label="Loading iTrack"]';

test("after a renewal is accepted, Home shows the successor and the renewed cycle folds under its credential", async ({ app, page }) => {
  const { id: sourceId } = await app.seedCredential();
  await app.act("markSubmitted", {
    credentialId: sourceId,
    submissionDate: "2026-06-01",
    confirmationNumber: "CONF-1",
  });
  const { id: successorId } = await app.act("markRenewalAccepted", {
    credentialId: sourceId,
    acceptedAt: "2026-06-15",
    reference: "REF-1",
    nextCycleStart: "2028-01-01",
    nextDeadline: "2029-12-31",
  });
  expect(successorId).not.toBe(sourceId);
  const workspace = await app.workspace();
  expect(workspace.activeCycleId).toBe(successorId);

  // A cold load and a reload both land on the successor: the seeded cycle
  // ends Dec 31, 2027 and the successor Dec 31, 2029.
  await app.goto("/");
  await page.reload();
  await expect(page.locator(LOADING)).toHaveCount(0, { timeout: 30_000 });
  const hero = page.getByRole("region", { name: "E2E custom credential", exact: true });
  await expect(hero).toBeVisible();
  await expect(hero).toContainText("Due Dec 31, 2029");
  await expect(hero).toContainText("days to renewal");
  await expect(hero).not.toContainText("Dec 31, 2027");
  await expect(hero).not.toContainText("days overdue");
  await expect(hero).not.toContainText("Cycle ended");

  // One row per credential, with the renewed cycle folded underneath.
  await app.goto("/credentials");
  const list = page.getByRole("region", { name: "Your credentials" });
  const row = list.getByRole("button", { name: /E2E custom credential/ });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Due Dec 31, 2029");
  const disclosure = list.locator("summary", { hasText: "1 previous cycle" });
  await expect(disclosure).toBeVisible();
  await disclosure.click();
  await list.getByRole("button", { name: /^Renewed Jun 15, 2026/ }).click();

  // The renewed cycle, opened on purpose, shows when it ended — never days.
  await expect(page).toHaveURL(new RegExp(`/credentials/${sourceId}$`));
  const pushed = page.locator(".screen-pushed");
  await expect(pushed.getByRole("heading", { level: 1, name: "E2E custom credential" })).toBeVisible();
  await expect(pushed.getByText("Cycle ended", { exact: true })).toBeVisible();
  await expect(pushed).toContainText("Renewed Jun 15, 2026");
  await expect(pushed.getByText("Time left", { exact: true })).toHaveCount(0);
  await expect(pushed.getByText("Past deadline", { exact: true })).toHaveCount(0);

  // Looking at history does not re-point Home at it.
  await page.goBack();
  await expect(page).toHaveURL(/\/credentials$/);
  await app.goto("/");
  await expect(
    page.getByRole("region", { name: "E2E custom credential", exact: true }),
  ).toContainText("Due Dec 31, 2029");
  app.expectNoErrors();
});
