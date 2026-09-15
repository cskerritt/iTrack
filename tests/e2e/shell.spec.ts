import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// The shell on ordinary routing (spec §5.1 Layout, §5.2 PageHeader / Rail /
// BottomNav): the rail is the desktop navigation and the bottom nav the
// phone's, both made of real links with one aria-current; every navigation
// changes the URL and the title and lands focus on the new screen's heading
// (a11y-03, a11y-M-02) while first paint keeps the browser's own focus so the
// skip link stays the first Tab stop; a modified click on a tab is left to
// the browser; a new screen opens at its top and Back restores the offset it
// left (decision 7); the phone bar and the token that clears it agree; the
// not-found route keeps the page frame. Read-only against the demo
// workspace, in all four projects.

const TABS = [
  ["Home", "/"],
  ["Credentials", "/credentials"],
  ["Activity log", "/history"],
  ["Account", "/profile"],
] as const;

const isPhone = () => test.info().project.name.startsWith("phone");

// The offset once nothing is moving it any more: two reads ten frames apart
// agree. A single read right after a navigation would pass a restore that a
// later effect undoes — a screen-level scroll-to-top firing after the layout
// effect, animated across those frames by the stylesheet's smooth scroll.
async function settledScrollY(page: Page): Promise<number> {
  const afterTenFrames = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let frames = 0;
          const step = () => (frames++ >= 10 ? resolve(window.scrollY) : requestAnimationFrame(step));
          requestAnimationFrame(step);
        }),
    );
  let previous = await page.evaluate(() => window.scrollY);
  for (let i = 0; i < 20; i += 1) {
    const current = await afterTenFrames();
    if (current === previous) return current;
    previous = current;
  }
  return previous;
}

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
  if (phone) {
    // Decision (3) / home-phone.html: the brand sits at the RIGHT of the title
    // even when the title wraps — "Every renewal, one clear place." is two
    // lines at 390px — because the text block takes a zero flex basis and
    // shares the row instead of filling it and pushing the brand underneath.
    const text = await page.locator("header.page-header .page-header-text").boundingBox();
    const brand = await page.locator("header.page-header .page-header-brand").boundingBox();
    if (!text || !brand) throw new Error("the page header did not render its text block and brand");
    expect(brand.x, "the brand is to the right of the title block").toBeGreaterThanOrEqual(text.x + text.width);
    expect(brand.y, "the brand shares the title's row rather than a row under it").toBeLessThan(text.y + text.height);
    // --bottom-nav-height (tokens.css) mirrors the bar it exists to clear:
    // 10 + the 56px Log-button row + 10 + the 1px hairline. .app-main and the
    // toast region add their own slack on top, so a drift here shows nowhere
    // else.
    const bar = await page.locator("nav.bottom-nav").boundingBox();
    if (!bar) throw new Error("the bottom nav did not render");
    const token = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bottom-nav-height")),
    );
    expect(bar.height, "nav.bottom-nav renders at exactly --bottom-nav-height").toBeCloseTo(token, 1);
  }
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

test("Back restores the scroll offset of the screen it returns to; a new navigation opens at the top", async ({ page, app }) => {
  await app.goto("/");
  // Home is the longest demo screen at both viewports. The document decides
  // how far it can scroll, so the offset that took is what is expected back.
  const savedHome = await page.evaluate(() => {
    window.scrollTo({ top: 400, left: 0, behavior: "instant" });
    return window.scrollY;
  });
  expect(savedHome, "Home scrolls at this viewport").toBeGreaterThan(0);
  await app.tab("Activity log").click();
  await expect(page).toHaveTitle("Activity log · iTrack");
  // Decision (7): every new navigation opens its screen at the top.
  expect(await settledScrollY(page), "a new screen opens at its top").toBe(0);
  const savedLog = await page.evaluate(() => {
    window.scrollTo({ top: 250, left: 0, behavior: "instant" });
    return window.scrollY;
  });
  await page.goBack();
  await expect(page).toHaveTitle("Home · iTrack");
  // history.scrollRestoration is manual, so this is useNavigation's own
  // per-path memory landing in its layout effect — and nothing after it (no
  // screen-level scroll-to-top on a tab change) may move it again.
  expect(await settledScrollY(page), "Back lands where Home was left").toBe(savedHome);
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeFocused();
  // Forward is a popstate too: the log returns where it was left (0 where the
  // demo log is too short to scroll at this viewport).
  await page.goForward();
  await expect(page).toHaveTitle("Activity log · iTrack");
  expect(await settledScrollY(page), "Forward lands where the log was left").toBe(savedLog);
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
