import { expect, test } from "./fixtures";

// a11y-13 (WCAG 1.4.10): no route scrolls horizontally at 320 CSS px — the
// screen-stack bleed that made pages 322px wide is gone with the stack, and
// this keeps it gone. A per-file viewport override: the four projects
// (scheme, user agent, touch) stay as they are, so this runs 320px wide
// under both schemes with and without the phone descriptor. The measure is
// honest only while nothing hides horizontal overflow at the root, so that
// is asserted alongside it. Demo identity, read-only.
test.describe("320px reflow", () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test("no route or sheet overflows the viewport", async ({ page, app }) => {
    const id = await app.demoCredentialId();
    const expectNoOverflow = async (label: string) => {
      const measured = await page.evaluate(() => ({
        excess:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        rootOverflowX: getComputedStyle(document.documentElement).overflowX,
        bodyOverflowX: getComputedStyle(document.body).overflowX,
      }));
      expect(measured.rootOverflowX, `${label}: html hides overflow`).not.toMatch(
        /^(hidden|clip)$/,
      );
      expect(measured.bodyOverflowX, `${label}: body hides overflow`).not.toMatch(
        /^(hidden|clip)$/,
      );
      expect(measured.excess, `${label}: horizontal overflow in CSS px`).toBeLessThanOrEqual(0);
    };

    for (const route of [
      "/",
      "/credentials",
      `/credentials/${id}`,
      "/history",
      "/profile",
      "/nonexistent",
      "/styleguide",
    ]) {
      await app.goto(route);
      await expectNoOverflow(route);
    }

    // An open sheet locks body scrolling (Modal), so the document measure
    // stands alone here and the card is measured as well.
    await app.goto("/");
    await app.openLog();
    const sheet = await page.evaluate(() => {
      const card = document.querySelector(".modal-card");
      return {
        excess:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        cardExcess: card
          ? card.scrollWidth - card.clientWidth
          : Number.POSITIVE_INFINITY,
      };
    });
    expect(sheet.excess, "log sheet: document overflow in CSS px").toBeLessThanOrEqual(0);
    expect(sheet.cardExcess, "log sheet: modal card overflow in CSS px").toBeLessThanOrEqual(0);
    app.expectNoErrors();
  });
});
