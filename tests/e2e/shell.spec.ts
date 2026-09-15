import { expect, test } from "./fixtures";

// The shell on ordinary routing (spec §5.1 Layout, §5.2 PageHeader / Rail /
// BottomNav): the rail is the desktop navigation and the bottom nav the
// phone's, both made of real links with one aria-current; every navigation
// changes the URL and the title and lands focus on the new screen's heading
// (a11y-03, a11y-M-02) while first paint keeps the browser's own focus so the
// skip link stays the first Tab stop; a modified click on a tab is left to
// the browser; the not-found route keeps the page frame. Read-only against
// the demo workspace, in all four projects.

const TABS = [
  ["Home", "/"],
  ["Credentials", "/credentials"],
  ["Activity log", "/history"],
  ["Account", "/profile"],
] as const;

const isPhone = () => test.info().project.name.startsWith("phone");

test("the rail is the desktop navigation and the bottom nav the phone's; tabs are links with the right href and one aria-current", async ({ page, context, app }) => {
  await app.goto("/credentials");
  const phone = isPhone();
  await expect(page.locator("aside.rail")).toBeVisible({ visible: !phone });
  await expect(page.locator("nav.bottom-nav")).toBeVisible({ visible: phone });
  for (const [name, href] of TABS) {
    const link = app.tab(name);
    await expect(link).toHaveAttribute("href", href);
    if (name === "Credentials") await expect(link).toHaveAttribute("aria-current", "page");
    else await expect(link).not.toHaveAttribute("aria-current", "page");
  }
  // The phone's third link shows "Activity" but is named "Activity log".
  if (phone) await expect(app.tab("Activity log")).toHaveText("Activity");
  await expect(page.getByRole("button", { name: "Log activity" }).first()).toBeVisible();
  if (!phone) {
    // spec §5.1 / home-desktop.html: the content column is 1120px at 1440×900
    // — the CONTENT box of main (shell.css: box-sizing content-box, the
    // padding outside --content-max), not its outer box. `available` is the
    // grid cell beside the 232px rail minus 44px of padding each side; it is
    // 1120 in headless Chromium (no scrollbar) and only ever smaller with one,
    // while the border-box mistake this guards against measures 1032.
    const { content, available } = await page.locator("main#main-content").evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        content: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        available: document.documentElement.clientWidth - 232 - 88,
      };
    });
    expect(content, "spec §5.1: the content column is 1120px at 1440×900 (content box, padding outside)").toBe(Math.min(1120, available));
    // A modified click is the browser's: a new tab opens on /history and this
    // page stays where it was. Desktop only — the phone projects emulate
    // touch, where a modifier click has no meaning.
    const opened = context.waitForEvent("page");
    await app.tab("Activity log").click({ modifiers: ["ControlOrMeta"] });
    const tab = await opened;
    await expect(tab).toHaveURL(/\/history$/);
    await expect(page).toHaveURL(/\/credentials$/);
    await tab.close();
  }
  app.expectNoErrors();
});

test("a tab click changes the URL and the title and moves focus to the heading; first paint does not", async ({ page, app }) => {
  await app.goto("/");
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await app.tab("Activity log").click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page).toHaveTitle("Activity log · iTrack");
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeFocused();
  await expect(app.tab("Activity log")).toHaveAttribute("aria-current", "page");
  await app.tab("Account").click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page).toHaveTitle("Account · iTrack");
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeFocused();
  // The browser's Back is a navigation too.
  await page.goBack();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page).toHaveTitle("Activity log · iTrack");
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeFocused();
  app.expectNoErrors();
});

test("the skip link is the first Tab stop and the next Tab lands inside main", async ({ page, app }) => {
  await app.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  // The link is followed natively (the URL gains the fragment). A fragment
  // jump is not a screen change — useNavigation ignores its popstate — so
  // nothing re-renders and the sequential focus start point is
  // #main-content: the next Tab is inside it, not back in the rail.
  await expect(page).toHaveURL(/\/#main-content$/);
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => {
      const active = document.activeElement;
      return active !== null && active !== document.body && active.closest("#main-content") !== null;
    }),
  ).toBe(true);
  app.expectNoErrors();
});

test("the not-found route keeps the page frame and links Home", async ({ page }) => {
  await page.goto("/nonexistent");
  await expect(page.locator("main#main-content.app-main")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  await page.getByRole("link", { name: "Go to Home" }).click();
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/$/);
});
