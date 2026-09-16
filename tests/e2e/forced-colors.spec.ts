import { expect, test } from "./fixtures";

// a11y-M-01: under forced colours (Windows high contrast) a checked box and
// an unchecked box must still differ, no unchecked box may show a check
// glyph, and a ring's arc must still read against its track. The rules
// under test are the `@media (forced-colors: active)` blocks the legacy
// choice rows (legacy-shared.css) and the instruments (instruments.css)
// carry; emulating the media feature is what makes them apply. Demo
// identity, read-only: the requirement row toggled below lives in the Log
// sheet, which is never submitted.
test("check rows and instruments keep their state under forced colours", async ({ page, app }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await app.goto("/");

  // Home's checklist: the demo seed has three tasks, one completed.
  const boxes = page.locator(".task-row .custom-check");
  await expect(boxes.first()).toBeVisible();
  const states = await boxes.evaluateAll((elements) =>
    elements.map((element) => ({
      checked:
        element.closest(".task-row")?.classList.contains("completed") ?? false,
      background: getComputedStyle(element).backgroundColor,
      adjust: getComputedStyle(element).getPropertyValue("forced-color-adjust"),
      glyphShown: Array.from(element.querySelectorAll("svg")).some(
        (svg) => getComputedStyle(svg).display !== "none",
      ),
    })),
  );
  const checked = states.filter((state) => state.checked);
  const unchecked = states.filter((state) => !state.checked);
  expect(checked.length, "the demo seed has a completed task").toBeGreaterThan(0);
  expect(unchecked.length, "the demo seed has a pending task").toBeGreaterThan(0);
  for (const state of states) {
    expect(state.adjust, "the box opts out of forced-colour adjustment").toBe("none");
  }
  for (const state of unchecked) {
    expect(state.glyphShown, "an unchecked box shows no glyph").toBe(false);
  }
  for (const state of checked) {
    expect(state.glyphShown, "a checked box shows its glyph").toBe(true);
  }
  expect(checked[0].background).not.toBe(unchecked[0].background);

  // The hero instruments: the arc (Highlight) against the track
  // (ButtonFace), the fill (Highlight) against the bar (ButtonFace) — both
  // opted out of adjustment so the value is not flattened away.
  const ring = page.locator(".cycle-ring").first();
  await expect(ring).toBeVisible();
  const strokes = await ring.evaluate((element) => {
    const track = element.querySelector(".cycle-ring-track");
    const arc = element.querySelector(".cycle-ring-arc");
    return {
      track: track ? getComputedStyle(track).stroke : null,
      arc: arc ? getComputedStyle(arc).stroke : null,
      adjust: arc
        ? getComputedStyle(arc).getPropertyValue("forced-color-adjust")
        : null,
    };
  });
  expect(strokes.arc, "the demo ring is 13% counted, so it draws an arc").not.toBeNull();
  expect(strokes.adjust).toBe("none");
  expect(strokes.arc).not.toBe(strokes.track);
  const bar = page.locator(".credit-bar").first();
  await expect(bar).toBeVisible();
  const fills = await bar.evaluate((element) => {
    const fill = element.querySelector(".credit-bar-fill");
    return {
      bar: getComputedStyle(element).backgroundColor,
      fill: fill ? getComputedStyle(fill).backgroundColor : null,
    };
  });
  expect(fills.fill).not.toBeNull();
  expect(fills.fill).not.toBe(fills.bar);

  // The Log sheet's requirement rows open unchecked; clicking one row (the
  // label — its opacity-0 input sits under the backdrop's hit test) checks
  // it, and only that row shows a glyph. Guarded: a seed without taggable
  // requirements must not fail this for the wrong reason.
  const sheet = await app.openLog();
  const rows = sheet.locator("label.requirement-choice");
  if ((await rows.count()) > 0) {
    await rows.first().click();
    const choices = await rows.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.querySelector(".requirement-check");
        const input = element.querySelector<HTMLInputElement>(
          'input[type="checkbox"]',
        );
        return {
          checked: input?.checked ?? false,
          background: box ? getComputedStyle(box).backgroundColor : null,
          glyphShown: box
            ? Array.from(box.querySelectorAll("svg")).some(
                (svg) => getComputedStyle(svg).display !== "none",
              )
            : false,
        };
      }),
    );
    expect(choices[0].checked, "the clicked row is checked").toBe(true);
    expect(choices[0].glyphShown, "the checked row shows its glyph").toBe(true);
    for (const row of choices.slice(1)) {
      expect(row.glyphShown, "an unchecked row shows no glyph").toBe(false);
    }
    if (choices.length > 1) {
      expect(choices[0].background).not.toBe(choices[1].background);
    }
  }
  app.expectNoErrors();
});

// WCAG 2.4.7 under forced colours: the current tab keeps a 2px inset
// Highlight line (shell.css) once its card fill and inset shadow are forced
// away, and that rule outranks the global :focus-visible ring — so, without
// its own focused rule, the focused current tab would look exactly like the
// unfocused one. Focused, it wears the shared ring, 3px and 2px out, the same
// geometry as every other focused control. Every outline takes the forced
// colour, so the geometry is the whole difference and is what is asserted.
// Programmatic focus alone is not :focus-visible in Chromium; a keyboard
// round trip (Tab away, Shift+Tab back) is.
test("the current tab shows a focus ring under forced colours (WCAG 2.4.7)", async ({ page, app }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await app.goto("/");
  const current = app.tab("Home");
  await expect(current).toHaveAttribute("aria-current", "page");
  const outline = (tab: typeof current) =>
    tab.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        style: computed.outlineStyle,
        width: parseFloat(computed.outlineWidth),
        offset: parseFloat(computed.outlineOffset),
      };
    });
  const idle = await outline(current);
  expect(idle, "unfocused, the current tab wears its 2px inset line").toEqual({ style: "solid", width: 2, offset: -2 });
  await current.focus();
  await page.keyboard.press("Tab");
  const other = app.tab("Credentials");
  await expect(other).toBeFocused();
  const otherFocused = await outline(other);
  await page.keyboard.press("Shift+Tab");
  await expect(current).toBeFocused();
  const focused = await outline(current);
  expect(focused, "focused, the current tab wears the shared ring — 3px, 2px out").toEqual({ style: "solid", width: 3, offset: 2 });
  expect(focused, "the same ring every other focused tab wears").toEqual(otherFocused);
  expect(focused).not.toEqual(idle);
  app.expectNoErrors();
});
