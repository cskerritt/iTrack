import { expect, freshIdentity, test } from "./fixtures";

// a11y-08: every confirmation lands in ONE live region that exists from first
// paint and is never inerted or unmounted; a plain toast replaces a plain one
// (the archive/toggle/proof flows post two back to back), a toast with Undo
// holds the slot and queues what follows; the timer waits while the card is
// hovered or focused and runs ten seconds with an action. Locators go through
// `.toast-region` rather than `getByRole("status")` alone: the offline and
// zone banners, the draft-safety note, the loading placeholder and the
// row-saving indicators are status regions too.

test("the notification region is mounted on load, empty, and stays outside a dialog's inert", async ({ page, app }) => {
  await app.goto("/");
  const region = page.locator(".toast-region");
  await expect(region).toHaveCount(1);
  await expect(region.locator('[role="status"][aria-live="polite"]')).toHaveCount(1);
  await expect(region.locator('[role="alert"]')).toHaveCount(1);
  await expect(region.locator(".toast")).toHaveCount(0);
  // A mounted sheet inerts the app root (Task 6's contract), never the region:
  // the region is a <body>-level sibling of `[data-app-root]`.
  await app.openLog();
  expect(await region.evaluate((element) => element.closest("[inert]") === null)).toBe(true);
  expect(await region.evaluate((element) => element.closest('[aria-hidden="true"]') === null)).toBe(true);
  app.expectNoErrors();
});

test("a toast waits while hovered and leaves on time once the pointer moves away", async ({ page, app }) => {
  // Fake timers are installed before navigation (Playwright's own guidance);
  // the clock keeps running through page load, then is frozen so only
  // runFor advances it and the 6 s budget is exact. The title wait is the
  // hydration proof (Task 6 gotcha: /styleguide has no loading placeholder).
  await page.clock.install({ time: new Date("2026-09-15T12:00:00") });
  await app.goto("/styleguide");
  await expect(page).toHaveTitle("Styleguide · iTrack");
  await page.clock.pauseAt(new Date("2026-09-15T12:01:00"));
  await page.getByRole("button", { name: "Show a toast", exact: true }).click();
  const card = page.locator(".toast-region .toast");
  await expect(card).toContainText("Sample notification");
  await page.clock.runFor(5000); // 5 s of the 6 s plain duration
  await expect(card).toBeVisible();
  await card.hover(); // pointerenter → pause
  await page.clock.runFor(6000); // would have expired twice over
  await expect(card).toBeVisible();
  await page.mouse.move(2, 2); // pointerleave → resume with ~1 s left
  await page.clock.runFor(1200);
  await expect(card).toHaveCount(0);
  app.expectNoErrors();
});

test("a plain toast replaces a plain one; a toast with Undo holds the slot for ten seconds and queues what follows", async ({ page, app }) => {
  await page.clock.install({ time: new Date("2026-09-15T12:00:00") });
  await app.goto("/styleguide");
  await expect(page).toHaveTitle("Styleguide · iTrack"); // hydrated (Task 6 gotcha)
  await page.clock.pauseAt(new Date("2026-09-15T12:01:00"));
  const card = page.locator(".toast-region .toast");
  const show = page.getByRole("button", { name: "Show a toast", exact: true });
  const showWithUndo = page.getByRole("button", { name: "Show a toast with Undo" });

  // plain → plain: replaced, nothing queued.
  await show.click();
  await expect(card).toContainText("Sample notification");
  await showWithUndo.click();
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Sample action taken.");

  // actionable → plain: the Undo toast stays for its ten seconds; the plain
  // one waits behind it and is promoted when it expires.
  await show.click();
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Sample action taken.");
  await page.clock.runFor(9000);
  await expect(card).toContainText("Sample action taken.");
  await page.clock.runFor(1200);
  await expect(card).toContainText("Sample notification");

  // Undo dismisses the card it sits on; the handler's own toast takes the slot.
  await showWithUndo.click();
  await expect(card).toContainText("Sample action taken.");
  await card.getByRole("button", { name: "Undo" }).click();
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Sample action undone.");
  app.expectNoErrors();
});

test.describe("a real confirmation", () => {
  test.use({ identity: freshIdentity() });

  test("archiving posts into the polite region without taking focus, and Undo restores the record", async ({ page, app }) => {
    const { id } = await app.seedCredential();
    await app.seedActivity(id, { title: "E2E toast me" });
    await app.goto("/history");
    const records = page.getByRole("region", { name: "Completed activities" });
    await records.getByRole("button", { name: "Edit E2E toast me" }).click();
    const editor = app.dialog("Edit learning record");
    // Archive is two steps: the trigger swaps for a confirmation that carries
    // the same label (tests/e2e/history.spec.ts does the same).
    await editor.getByRole("button", { name: "Archive record" }).click();
    await expect(editor.getByRole("alert")).toContainText("Archive this learning record?");
    await editor.getByRole("button", { name: "Archive record" }).click();
    await expect(editor).toHaveCount(0);

    const status = page.locator('.toast-region [role="status"] .toast');
    // runAction's plain "Learning record archived." was replaced by the Undo
    // toast, which is the one on screen.
    await expect(status).toContainText("Learning record archived. Its proof remains saved.");
    await expect(status.getByRole("button", { name: "Undo" })).toBeVisible();
    await expect(records.getByText("E2E toast me")).toHaveCount(0);
    // Focus went to the Archived records summary, never into the toast.
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".toast-region")))).toBe(false);

    await status.getByRole("button", { name: "Undo" }).click();
    // The restore's own success message takes the slot the Undo toast left.
    await expect(status).toContainText("Learning record restored.");
    await expect(records.getByText("E2E toast me")).toBeVisible();
    await expect(page.locator("summary").filter({ hasText: "Archived records" })).toHaveCount(0);
    app.expectNoErrors();
  });
});
