import { expect, test } from "./fixtures";

// Pixel-parity proof for a stylesheet reorganisation that is not meant to
// change a single rendered pixel (Task 2's split of globals.css, Task 3's
// Tailwind removal). Off by default: set WAVE3_PARITY=1. Baselines are taken
// on the parent commit with --update-snapshots and live under
// tests/e2e/parity.spec.ts-snapshots/ (gitignored) — they are a local
// instrument, never evidence, and never committed.
//
// Read-only against the demo workspace: it only reads routes and opens the
// Log sheet; nothing is submitted.
test.skip(!process.env.WAVE3_PARITY, "set WAVE3_PARITY=1 to compare against the baseline snapshots");

test("every route renders pixel-identical to the baseline", async ({ page, app }) => {
  // The greeting (dayPart), the countdowns and every date read the clock:
  // pin it so a baseline taken before noon still matches a run after it.
  await page.clock.setFixedTime(new Date("2026-09-15T15:00:00"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  const detailId = (await app.workspace()).credentials[0].id;
  const routes: Array<[string, string]> = [
    ["home", "/"],
    ["credentials", "/credentials"],
    ["credential-detail", `/credentials/${detailId}`],
    ["history", "/history"],
    ["profile", "/profile"],
  ];
  for (const [slug, route] of routes) {
    await app.goto(route);
    await expect(page).toHaveScreenshot(`${slug}.png`, {
      fullPage: true,
      animations: "disabled",
      maxDiffPixels: 0,
    });
  }
  await app.goto("/");
  await app.openLog();
  await expect(page).toHaveScreenshot("log-activity.png", {
    animations: "disabled",
    maxDiffPixels: 0,
  });
  app.expectNoErrors();
});
