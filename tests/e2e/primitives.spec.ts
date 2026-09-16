// The Modal primitive (app/components/Modal.tsx) owns what the audit found
// spread across the shell: focus return to the opener after every close path
// (a11y-02), an Escape that closes only the top-most dialog and reaches every
// sheet including install help (a11y-07, architecture-10), a backdrop press
// that closes a clean form and is ignored on a dirty one (app-ux-23), a
// per-instance accessible name (architecture-14), and a sticky header that
// never covers the field focus scrolled under it (WCAG 2.2 2.4.11).
// Read-only against the demo workspace: nothing here submits a form. Every
// case runs in all four projects; below 540px the same dialog is the bottom
// sheet.
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

// ---------------------------------------------------------------------------
// Task 7 — Form primitives (a11y-05, a11y-06, a11y-09). The styleguide's
// sample form proves the aria wiring of Field/TextInput/Select/ErrorSummary;
// the Log activity sheet proves the boundary and the ring reach the LEGACY
// label-wrapped fields too; the personal-task editor is the first real form
// on the primitives. Nothing here saves: the editor's submit is stopped by
// its own validation before any request is made.
// ---------------------------------------------------------------------------

test("the styleguide form wires aria-invalid, aria-describedby and a focused error summary (a11y-09)", async ({ page, app }) => {
  await app.goto("/styleguide");
  // No hydration placeholder on this route (Task 6 gotcha): the client-side
  // title proves React is driving the page before the first click — a
  // pre-hydration Save would submit the form natively and reload the page.
  await expect(page).toHaveTitle("Styleguide · iTrack");
  const form = page.getByRole("region", { name: "Form", exact: true });
  const name = form.getByLabel("Name", { exact: true });
  // The hint is described-by before any error exists.
  await expect(name).toHaveAttribute("aria-describedby", /-hint$/);
  await expect(name).not.toHaveAttribute("aria-invalid", "true");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  const summary = form.getByRole("alert").filter({ hasText: "Check the form" });
  await expect(summary).toBeVisible();
  await expect(summary).toBeFocused();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  const described = (await name.getAttribute("aria-describedby")) ?? "";
  const errorId = described.split(" ").find((id) => id.endsWith("-error"));
  expect(errorId).toBeTruthy();
  // useId() values are not selector-safe; match the attribute, not a #id.
  await expect(form.locator(`[id="${errorId}"]`)).toHaveText("Enter a name");
  await summary.getByRole("link", { name: "Enter a name" }).click();
  await expect(name).toBeFocused();
  await name.fill("Alex Morgan");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveCount(0);
  await expect(name).not.toHaveAttribute("aria-invalid", "true");
  app.expectNoErrors();
});

test("a select with twelve or more options gets a search that narrows it", async ({ page, app }) => {
  await app.goto("/styleguide");
  await expect(page).toHaveTitle("Styleguide · iTrack"); // hydrated (Task 6 gotcha)
  const form = page.getByRole("region", { name: "Form", exact: true });
  const select = form.getByRole("combobox", { name: "Profession", exact: true });
  // Fourteen professions plus the placeholder option.
  await expect(select.locator("option")).toHaveCount(15);
  const search = form.getByRole("searchbox", { name: "Search options" });
  await search.fill("therapy");
  // Occupational, Physical and Respiratory therapy, plus the placeholder.
  await expect(select.locator("option")).toHaveCount(4);
  await expect(form.getByText("3 matches", { exact: true })).toBeVisible();
  await search.press("Tab");
  await expect(select).toBeFocused();
  await search.fill("zzzz");
  await expect(select.locator("option")).toHaveCount(1);
  await expect(form.getByText("0 matches", { exact: true })).toBeVisible();
  app.expectNoErrors();
});

test("every field wears the 3:1 boundary and the shared focus ring (a11y-05, a11y-06)", async ({ page, app }) => {
  await app.goto("/");
  const sheet = await app.openLog();
  // A LEGACY label-wrapped field: primitives.css restyles `.field input`
  // too, so the whole app moved at once.
  const title = sheet.locator('input[name="title"]');
  const styles = await title.evaluate((element) => {
    const computed = getComputedStyle(element);
    const root = getComputedStyle(document.documentElement);
    const rgb = (value: string) =>
      (value.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
    const hex = (value: string) => {
      const digits = value.trim().replace("#", "");
      return [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16));
    };
    const luminance = ([r, g, b]: number[]) => {
      const channel = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const contrast = (a: number[], b: number[]) => {
      const [high, low] = [luminance(a), luminance(b)].sort((p, q) => q - p);
      return (high + 0.05) / (low + 0.05);
    };
    const border = rgb(computed.borderTopColor);
    const background = rgb(computed.backgroundColor);
    return {
      border,
      expectedBorder: hex(root.getPropertyValue("--line-strong")),
      ratio: contrast(border, background),
      outlineBeforeFocus: computed.outlineStyle,
    };
  });
  expect(styles.border).toEqual(styles.expectedBorder);
  expect(styles.ratio).toBeGreaterThanOrEqual(3);
  expect(styles.outlineBeforeFocus).toBe("none");
  // Programmatic focus alone is not :focus-visible in Chromium; a keyboard
  // round trip (Tab away, Shift+Tab back) is.
  await title.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(title).toBeFocused();
  const ring = await title.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      style: computed.outlineStyle,
      width: parseFloat(computed.outlineWidth),
      color: computed.outlineColor,
    };
  });
  expect(ring.style).toBe("solid");
  expect(ring.width).toBeGreaterThanOrEqual(3);
  const focusRing = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--focus-ring").trim(),
  );
  const expectedRing = `rgb(${[0, 2, 4]
    .map((offset) => parseInt(focusRing.slice(1 + offset, 3 + offset), 16))
    .join(",")})`;
  expect(ring.color.replace(/\s/g, "")).toBe(expectedRing);
  app.expectNoErrors();
});

test("the personal-task editor validates inline instead of with native bubbles", async ({ page, app }) => {
  await app.goto("/");
  await page.getByRole("button", { name: "Add task", exact: true }).first().click();
  const sheet = app.dialog("Add a personal task");
  await expect(sheet).toBeVisible();
  const title = sheet.locator('input[name="title"]');
  await expect(title).toBeFocused();
  await title.fill("");
  await sheet.getByRole("button", { name: "Add task", exact: true }).click();
  const summary = sheet.getByRole("alert").filter({ hasText: "Enter a task name" });
  await expect(summary).toBeVisible();
  await expect(summary).toBeFocused();
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(title).toHaveAttribute("aria-describedby", /-error$/);
  await expect(sheet).toBeVisible();
  await summary.getByRole("link", { name: "Enter a task name" }).click();
  await expect(title).toBeFocused();
  // Read-only against the demo workspace: the sheet is closed, never saved.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  app.expectNoErrors();
});

// ---------------------------------------------------------------------------
// WCAG 2.2 2.4.11 (Focus Not Obscured). The card is the sheet's scroll
// container and its header is sticky inside it, so a field that Shift+Tab
// brings to the card's top edge would sit under the header. The card's
// scroll-padding-top (primitives.css) clears the height Modal publishes as
// --modal-header-height. The Log sheet is the longest dialog in the app and
// scrolls at every project viewport; walked forward and back, no field in
// its body may share a pixel with the header while it holds focus.
// ---------------------------------------------------------------------------

test("the sheet's sticky header never covers the field a Tab or Shift+Tab lands on (WCAG 2.2 2.4.11)", async ({ page, app }) => {
  await app.goto("/");
  const sheet = await app.openLog();
  const card = page.locator(".modal-card");
  const geometry = await card.evaluate((element) => {
    const header = element.querySelector(".modal-header");
    if (!header) throw new Error("the sheet did not render its header");
    return {
      scrolls: element.scrollHeight > element.clientHeight,
      headerHeight: header.getBoundingClientRect().height,
      headerPosition: getComputedStyle(header).position,
      padding: parseFloat(getComputedStyle(element).scrollPaddingTop),
      // Modal.tsx's own tab order: what keepFocusInside cycles through.
      controls: element.querySelectorAll(
        "a[href],button:not([disabled]),input:not([disabled]):not([type='hidden']),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])",
      ).length,
    };
  });
  expect(geometry.scrolls, "the Log sheet scrolls inside its card at this viewport").toBe(true);
  expect(geometry.headerPosition).toBe("sticky");
  expect(geometry.padding, "the card clears the header plus 12px of air").toBeCloseTo(geometry.headerHeight + 12, 1);
  expect(geometry.controls).toBeGreaterThan(10);

  const focusedAgainstHeader = () =>
    page.evaluate(() => {
      const active = document.activeElement;
      const header = document.querySelector(".modal-header");
      if (!(active instanceof HTMLElement) || !header) return null;
      const rect = active.getBoundingClientRect();
      const bar = header.getBoundingClientRect();
      const name = active.getAttribute("name") ?? active.getAttribute("aria-label") ?? active.textContent ?? "";
      return {
        control: `${active.tagName.toLowerCase()} "${name.trim().slice(0, 40)}"`,
        inBody: active.closest(".modal-body") !== null,
        hidden:
          rect.top < bar.bottom && rect.bottom > bar.top && rect.left < bar.right && rect.right > bar.left,
        rect: { top: rect.top, bottom: rect.bottom },
        header: { top: bar.top, bottom: bar.bottom },
      };
    });
  const walk = async (key: "Tab" | "Shift+Tab") => {
    let visited = 0;
    for (let step = 1; step < geometry.controls; step += 1) {
      await page.keyboard.press(key);
      const focused = await focusedAgainstHeader();
      if (!focused || !focused.inBody) continue;
      visited += 1;
      expect(
        focused.hidden,
        `${key} ${step}: ${focused.control} at ${JSON.stringify(focused.rect)} is behind the header at ${JSON.stringify(focused.header)}`,
      ).toBe(false);
    }
    return visited;
  };
  // From the header's close button — the first control — to the last, and
  // back: the card scrolls to its bottom and returns to its top.
  await sheet.getByRole("button", { name: "Close dialog" }).focus();
  expect(await walk("Tab"), "the forward walk visited the body's fields").toBeGreaterThan(10);
  expect(await card.evaluate((element) => element.scrollTop), "the walk scrolled the card").toBeGreaterThan(0);
  expect(await walk("Shift+Tab"), "the backward walk visited the body's fields").toBeGreaterThan(10);
  // Read-only against the demo workspace: closed, never saved.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  app.expectNoErrors();
});
