import { expect, freshIdentity, test } from "./fixtures";

// spec §2 (Wave 3 ships the error/not-found routes) and §5.2 EmptyState /
// ErrorBoundary; architecture-09 (the legacy 'L' glyph). The 404 is served by
// the root layout outside the app shell. Nothing in the app throws on demand,
// so the boundary's contract — the fallback, the raw message only inside a
// disclosure, recovery on a resetKey change or on Try again — is proven on
// the dev-only /styleguide samples, which mount exactly the components the
// shell mounts. Runs in all four projects.

test("the 404 keeps the page frame, titles itself and links home", async ({ page, app }) => {
  await app.goto("/nonexistent");
  await expect(
    page.getByRole("heading", { level: 1, name: "Page not found" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Page not found · iTrack");
  await expect(page.locator("#main-content")).toHaveCount(1);
  // A 404 is not an alert. The Toast region's assertive slot is always
  // mounted by the root layout, so the check is scoped to the page frame.
  await expect(page.locator("#main-content").getByRole("alert")).toHaveCount(0);
  await page.getByRole("link", { name: "Go to Home" }).click();
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/$/);
  app.expectNoErrors();
});

test("the error fallback keeps the raw message inside a disclosure", async ({ page, app }) => {
  await app.goto("/styleguide");
  await expect(page).toHaveTitle("Styleguide · iTrack"); // hydrated before the first click (Task 6 gotcha)
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "Something broke on our side" });
  await expect(alert).toBeVisible();
  await expect(
    alert.getByRole("heading", { level: 1, name: "Something broke on our side" }),
  ).toBeVisible();
  // The message is in the DOM but closed away until the disclosure opens.
  await expect(alert.getByText("Styleguide sample error")).toBeHidden();
  await alert.getByText("Technical details").click();
  await expect(alert.getByText("Styleguide sample error")).toBeVisible();
  await expect(alert.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(alert.getByRole("button", { name: "Copy details" })).toBeVisible();
  app.expectNoErrors();
});

test("the boundary catches a render error and recovers on a reset-key change or Try again", async ({ page, app }) => {
  await app.goto("/styleguide");
  await expect(page).toHaveTitle("Styleguide · iTrack"); // hydrated before the first click (Task 6 gotcha)
  const sample = page.locator(".styleguide-boundary");
  await expect(sample.getByText("Sample screen rendered.")).toBeVisible();
  // Under `npm run dev` vinext paints its own runtime-error overlay over the
  // page for every error a boundary catches (React's onCaughtError; dev only,
  // node_modules/vinext/dist/server/app-browser-entry.js) and its backdrop
  // swallows clicks. It is not part of the app and never ships, so it is
  // dismissed before the fallback underneath is exercised; if it does not
  // appear, nothing is clicked. Escape and the backdrop only minimise it.
  const dismissDevOverlay = async () => {
    const dismiss = page
      .locator("#__vinext_dev_error_overlay_root")
      .getByRole("button", { name: "Dismiss" });
    await dismiss.waitFor({ state: "visible", timeout: 2_000 }).catch(() => undefined);
    if (await dismiss.isVisible()) await dismiss.click();
  };

  await sample.getByRole("button", { name: "Throw a sample error" }).click();
  const alert = sample.getByRole("alert");
  await expect(
    alert.getByRole("heading", { level: 1, name: "Something broke on our side" }),
  ).toBeVisible();
  await expect(alert.getByText("Styleguide sample crash")).toBeHidden();
  await dismissDevOverlay();
  await alert.getByText("Technical details").click();
  await expect(alert.getByText("Styleguide sample crash")).toBeVisible();

  // resetKey: what the shell passes as the current path; a change clears it.
  await sample.getByRole("button", { name: "Change the reset key" }).click();
  await expect(sample.getByRole("alert")).toHaveCount(0);
  await expect(sample.getByText("Sample screen rendered.")).toBeVisible();

  // fallback render prop + reset(): Try again clears it on demand.
  await sample.getByRole("button", { name: "Throw a sample error" }).click();
  await expect(sample.getByRole("alert")).toBeVisible();
  await dismissDevOverlay();
  await sample.getByRole("button", { name: "Try again" }).click();
  await expect(sample.getByRole("alert")).toHaveCount(0);
  await expect(sample.getByText("Sample screen rendered.")).toBeVisible();
  // React reports a caught render error through console.error by design, so
  // app.expectNoErrors() is deliberately not asserted here.
});

test.describe("a new account", () => {
  test.use({ identity: freshIdentity() });

  test("the empty Credentials page is one EmptyState with no legacy glyph", async ({ page, app }) => {
    await app.goto("/credentials");
    const empty = page.locator(".empty-state");
    await expect(empty).toHaveCount(1);
    await expect(
      empty.getByRole("heading", { level: 2, name: "Add your first credential" }),
    ).toBeVisible();
    // The section is named by its heading and the heading is its first text:
    // no glyph, no kicker precedes it, and a page-level state draws no mark.
    await expect(empty).toHaveAttribute("aria-labelledby", /.+/);
    await expect(empty).toHaveText(/^\s*Add your first credential/);
    await expect(empty.locator(".empty-state-mark")).toHaveCount(0);
    await expect(empty.locator('[aria-hidden="true"]')).toHaveCount(0);
    await empty.getByRole("button", { name: "Set up credential" }).click();
    await expect(app.dialog("Set up a credential")).toBeVisible();
    app.expectNoErrors();
  });

  test("the Log sheet's in-sheet empty state is the compact form with a mark and a quiet action", async ({ app }) => {
    await app.goto("/");
    const sheet = await app.openLog();
    const empty = sheet.locator(".empty-state.empty-state-compact");
    await expect(
      empty.getByRole("heading", { level: 2, name: "Add an active credential first" }),
    ).toBeVisible();
    await expect(empty.locator(".empty-state-mark")).toHaveCount(1);
    await expect(empty.locator(".empty-state-mark")).toHaveAttribute("aria-hidden", "true");
    await empty.getByRole("button", { name: "Set up credential" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(app.dialog("Set up a credential")).toBeVisible();
    app.expectNoErrors();
  });
});
