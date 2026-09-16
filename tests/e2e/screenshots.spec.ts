import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

// The spec §2 finish-gate evidence: every surface in every project, written
// under docs/design/wave3/ and committed. Off by default so the ordinary
// e2e run never writes into docs/; WAVE3_SCREENSHOTS=1 captures the
// viewport, =full the whole page (for a local look only — never committed).
// Demo identity, read-only. The clock and the time zone are fixed so the
// greeting and the countdowns read the same in all four projects; fonts are
// awaited so the shots show the shipped faces, not the metric-matched
// fallbacks; `scale: "css"` keeps the phone shots at 390×844 rather than
// the descriptor's 3×.
const OUT = fileURLToPath(new URL("../../docs/design/wave3/", import.meta.url));
const FULL = process.env.WAVE3_SCREENSHOTS === "full";

test.skip(
  !process.env.WAVE3_SCREENSHOTS,
  "set WAVE3_SCREENSHOTS=1 (or =full) to capture the Wave 3 gate screenshots",
);
test.use({ timezoneId: "America/New_York" });

test("captures every surface in this project's scheme and viewport", async ({ page, app }) => {
  await page.clock.setFixedTime(new Date("2026-09-15T15:00:00"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  const project = test.info().project.name;
  const id = await app.demoCredentialId();
  const shoot = async (slug: string, fullPage: boolean) => {
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.screenshot({
      path: path.join(OUT, `${slug}-${project}.png`),
      fullPage,
      animations: "disabled",
      scale: "css",
    });
  };
  const surfaces: ReadonlyArray<[slug: string, route: string]> = [
    ["home", "/"],
    ["credentials", "/credentials"],
    ["credential-detail", `/credentials/${id}`],
    ["activity-log", "/history"],
    ["account", "/profile"],
    ["not-found", "/nonexistent"],
    ["styleguide", "/styleguide"],
  ];
  for (const [slug, route] of surfaces) {
    await app.goto(route);
    await shoot(slug, FULL);
  }
  await app.goto("/");
  await app.openLog();
  // A fixed-position sheet is captured with the viewport, never full-page.
  await shoot("log-activity", false);
  app.expectNoErrors();
});
