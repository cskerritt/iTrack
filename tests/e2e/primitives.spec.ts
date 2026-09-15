// The Modal primitive (app/components/Modal.tsx) owns what the audit found
// spread across the shell: focus return to the opener after every close path
// (a11y-02), an Escape that closes only the top-most dialog and reaches every
// sheet including install help (a11y-07, architecture-10), a backdrop press
// that closes a clean form and is ignored on a dirty one (app-ux-23), and a
// per-instance accessible name (architecture-14). Read-only against the demo
// workspace: nothing here submits a form. Every case runs in all four
// projects; below 540px the same dialog is the bottom sheet.
import { expect, test } from "./fixtures";

// Profile's install control is named by the push state the browser reports:
// "How to install" (desktop Chromium, no install prompt), "Install on this
// device" (a browser that fired beforeinstallprompt) or "Add to Home Screen"
// (an iOS-like user agent, which the two phone projects carry). All three
// open the same "Add iTrack to your phone" sheet through handleInstallApp.
const INSTALL_CONTROL = /^(How to install|Install on this device|Add to Home Screen)$/;

test("Escape closes the top-most dialog and reaches the install-help sheet (architecture-10)", async ({ page, app }) => {
  await app.goto("/profile");
  await page.getByRole("button", { name: INSTALL_CONTROL }).first().click();
  const sheet = app.dialog("Add iTrack to your phone");
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  app.expectNoErrors();
});

test("a backdrop press closes a clean sheet and is ignored on a dirty one (app-ux-23)", async ({ page, app }) => {
  await app.goto("/");
  let sheet = await app.openLog();
  // (8, 8) is backdrop at every viewport: the desktop card is centred with
  // 24px of backdrop padding around it, and the phone sheet is bottom-anchored
  // with at least 24px of backdrop above it.
  await page.mouse.click(8, 8);
  await expect(sheet).toBeHidden();
  sheet = await app.openLog();
  await sheet.locator('input[name="title"]').fill("probe");
  await page.mouse.click(8, 8);
  await expect(sheet).toBeVisible();
  // Escape always closes the top-most dialog, dirty or not (the log sheet
  // persists its draft on the way out).
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  app.expectNoErrors();
});

// Three sheets whose first field carries React's autoFocus, opened by
// keyboard so the opener is unambiguous, closed by each of the three close
// paths. The trigger must hold focus again afterwards (a11y-02: 18/18 of
// these cases ended on <body> before this task).
for (const [route, opener, dialog, field, closeVia] of [
  ["/", "Add task", "Add a personal task", 'input[name="title"]', "escape"],
  ["/credentials", "Add credential", "Set up a credential", 'input[type="search"]', "close"],
  ["/history", "Edit Ethics in Digital Practice", "Edit learning record", 'input[name="title"]', "cancel"],
] as const) {
  test(`focus lands on the autoFocus field of "${dialog}" and returns to the opener on ${closeVia} (a11y-02)`, async ({ page, app }) => {
    await app.goto(route);
    const trigger = page.getByRole("button", { name: opener, exact: true }).first();
    await trigger.focus();
    await page.keyboard.press("Enter");
    const sheet = app.dialog(dialog);
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(field)).toBeFocused();
    if (closeVia === "escape") await page.keyboard.press("Escape");
    if (closeVia === "close") await sheet.getByRole("button", { name: "Close dialog" }).click();
    if (closeVia === "cancel") await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();
    app.expectNoErrors();
  });
}

test("the page behind an open dialog is inert and released on close", async ({ page, app }) => {
  await app.goto("/");
  const root = page.locator("[data-app-root]").first();
  const home = app.tab("Home");
  // Playwright 1.63's role engine does not model `inert` (it skips
  // aria-hidden and display:none only), so operability is proven the way the
  // browser enforces it: focus() on an element inside an inert subtree is a
  // no-op and the active element stays in the dialog.
  const canFocus = () =>
    home.evaluate((element) => {
      (element as HTMLElement).focus();
      return document.activeElement === element;
    });
  const sheet = await app.openLog();
  expect(await root.evaluate((element) => (element as HTMLElement).inert)).toBe(true);
  expect(await canFocus()).toBe(false);
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Close dialog" }).click();
  await expect(sheet).toHaveCount(0);
  expect(await root.evaluate((element) => (element as HTMLElement).inert)).toBe(false);
  expect(await canFocus()).toBe(true);
  app.expectNoErrors();
});

test("nested dialogs: only the top-most answers Escape, the lower one is inert, focus walks back one opener at a time", async ({ page, app }) => {
  // Two dialogs are never open at once in the app today; the development-only
  // styleguide is where the stack contract is exercised.
  await app.goto("/styleguide");
  // The route has no hydration placeholder for app.goto to wait on; the
  // client-side title is the proof that React is driving the page.
  await expect(page).toHaveTitle("Styleguide · iTrack");
  const opener = page.getByRole("button", { name: "Open a dialog" });
  await opener.focus();
  await page.keyboard.press("Enter");
  const first = app.dialog("Sample dialog");
  await expect(first).toBeVisible();
  await expect(first.locator('input[name="note"]')).toBeFocused();
  const second = first.getByRole("button", { name: "Open a second dialog" });
  await second.focus();
  await page.keyboard.press("Enter");
  await expect(app.dialog("Second dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(2);
  // The lower dialog's backdrop is inert; the page root stays inert too.
  expect(await page.locator(".modal-backdrop").first().evaluate((element) => (element as HTMLElement).inert)).toBe(true);
  expect(await page.locator("[data-app-root]").first().evaluate((element) => (element as HTMLElement).inert)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(first).toBeVisible();
  await expect(second).toBeFocused();
  expect(await page.locator(".modal-backdrop").first().evaluate((element) => (element as HTMLElement).inert)).toBe(false);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await page.locator("[data-app-root]").first().evaluate((element) => (element as HTMLElement).inert)).toBe(false);
  app.expectNoErrors();
});

test("focus is trapped inside an open sheet: Tab wraps at both ends and never reaches the page (spec §5.2)", async ({ page, app }) => {
  // The one Modal behaviour the spec names first. keepFocusInside moves over
  // from the old Modal verbatim; this is what keeps it honest: Shift+Tab from
  // the first control wraps to the last, sixty Tabs never leave the dialog,
  // and the inert page root never holds focus while a sheet is open.
  await app.goto("/");
  const sheet = await app.openLog();
  const inside = () => sheet.evaluate((el) => el.contains(document.activeElement));
  await sheet.getByRole("button", { name: "Close dialog" }).focus();
  await page.keyboard.press("Shift+Tab");
  expect(await inside(), "Shift+Tab from the first control wraps to the last").toBe(true);
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press("Tab");
    expect(await inside(), `Tab ${i + 1} stays inside the dialog`).toBe(true);
  }
  expect(await page.locator("[data-app-root]").first().evaluate((el) => el.contains(document.activeElement))).toBe(false);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  app.expectNoErrors();
});
