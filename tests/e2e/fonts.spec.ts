import { FONT_BUDGET_BYTES, FONT_PRELOADS } from "../../app/lib/fonts";
import { expect, test } from "./fixtures";

// Spec §5.1 Type / audit perf-08 / mockup decision 4: the three ledger faces
// are self-hosted latin subsets. On every project: no font request leaves the
// origin and none goes to Google Fonts; the four preloaded faces are loaded
// once the first screen has painted; every font resource is under /fonts/
// and within the 40 kB budget; the H1 and the body resolve to the display
// and body faces. Read-only against the demo workspace.

const GOOGLE_FONTS = /fonts\.googleapis\.com|fonts\.gstatic\.com/i;
const FONT_FILE = /\.woff2?(\?|$)/i;

test("the ledger faces load from /fonts/ and nothing loads from Google", async ({ page, app }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await app.goto("/");
  // A FontFace is "loaded" only once text needs it: the H1 is the first
  // display-face element, so wait for layout before reading document.fonts.
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const origin = new URL(page.url()).origin;
  expect(requests.filter((url) => GOOGLE_FONTS.test(url))).toEqual([]);
  expect(
    requests.filter((url) => FONT_FILE.test(url) && !url.startsWith(`${origin}/fonts/`)),
  ).toEqual([]);

  // Chromium reports FontFace.family with its quotes; strip them.
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.fonts]
          .filter((face) => face.status === "loaded")
          .map((face) => `${face.family.replace(/["']/g, "")} ${face.weight} ${face.style}`),
      ),
    )
    .toEqual(
      expect.arrayContaining([
        "Atkinson Hyperlegible 400 normal",
        "Atkinson Hyperlegible 700 normal",
        "Bricolage Grotesque 700 normal",
        "Bricolage Grotesque 800 normal",
      ]),
    );

  // encodedBodySize is populated for same-origin resources: the honest
  // in-browser size check against the 40 kB budget.
  const fonts = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((entry) => /\.woff2(\?|$)/.test(entry.name))
      .map((entry) => ({
        path: new URL(entry.name).pathname,
        bytes: (entry as PerformanceResourceTiming).encodedBodySize,
      })),
  );
  expect(fonts.map((font) => font.path)).toEqual(expect.arrayContaining([...FONT_PRELOADS]));
  for (const font of fonts) {
    expect(font.path).toMatch(/^\/fonts\/[a-z0-9-]+-[0-9a-f]{8}\.woff2$/);
    expect(font.bytes).toBeLessThanOrEqual(FONT_BUDGET_BYTES);
  }

  await expect(heading).toHaveCSS("font-family", /Bricolage Grotesque/);
  await expect(page.locator("body")).toHaveCSS("font-family", /Atkinson Hyperlegible/);
  app.expectNoErrors();
});
