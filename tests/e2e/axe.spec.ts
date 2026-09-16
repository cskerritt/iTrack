import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// spec §9: axe on every route with zero serious/critical violations, in all
// four projects (mockup README decision 5: no WebKit project, all four
// Chromium projects). One test per surface, so a failure names the surface
// and the other surfaces are still audited in the same run. The full axe
// result is attached per surface; moderate/minor counts are annotated,
// never asserted. No rule is excluded and no tag narrows the run — the
// gate is impact-based. Demo identity, read-only: the Log sheet is opened,
// never submitted.

// axe-core's types are not imported directly: the hoisted axe-core is
// eslint's 4.11, not the 4.13 nested under @axe-core/playwright.
type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;

const BLOCKING = new Set(["serious", "critical"]);

async function audit(page: Page, label: string): Promise<AxeResults> {
  const results = await new AxeBuilder({ page }).analyze();
  const info = test.info();
  await info.attach(`axe-${label}`, {
    body: JSON.stringify(results, null, 2),
    contentType: "application/json",
  });
  const counts: Record<string, number> = { minor: 0, moderate: 0, serious: 0, critical: 0 };
  for (const violation of results.violations) counts[violation.impact ?? "minor"] += 1;
  info.annotations.push({
    type: "axe",
    description: `${label} (${info.project.name}): ${JSON.stringify(counts)}`,
  });
  const blocking = results.violations.filter((violation) =>
    BLOCKING.has(violation.impact ?? ""),
  );
  expect(
    blocking.map(
      (violation) =>
        `${violation.id} [${violation.impact}] ${violation.help}\n  ${violation.nodes
          .map((node) => node.target.join(" "))
          .join("\n  ")}`,
    ),
    `${label}: serious/critical axe violations`,
  ).toEqual([]);
  return results;
}

// The demo credential's id is read from the workspace, so the detail route
// is the real one; app.goto waits for the hydration placeholder to leave,
// so axe never audits the skeleton. The 404 and the styleguide render no
// placeholder and resolve at once.
const ROUTES: ReadonlyArray<[label: string, path: string | ((id: string) => string)]> = [
  ["home", "/"],
  ["credentials", "/credentials"],
  ["credential-detail", (id) => `/credentials/${id}`],
  ["activity-log", "/history"],
  ["account", "/profile"],
  ["not-found", "/nonexistent"],
  ["styleguide", "/styleguide"],
];

for (const [label, path] of ROUTES) {
  test(`${label} passes axe with no serious or critical violations`, async ({ page, app }) => {
    const id = await app.demoCredentialId();
    await app.goto(typeof path === "function" ? path(id) : path);
    await audit(page, label);
    app.expectNoErrors();
  });
}

test("the Log activity sheet passes axe while open", async ({ page, app }) => {
  await app.goto("/");
  await app.openLog();
  await audit(page, "log-activity-sheet");
  app.expectNoErrors();
});

test("the workspace-load-failure state passes axe", async ({ page, app }) => {
  // A 500 from the workspace fetch renders WorkspaceLoadFailure in place of
  // the loading placeholder, titled for a status >= 500. Nothing reaches
  // the dev server.
  await page.route(
    (url) => url.pathname === "/api/workspace",
    (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "boom", code: "boom" }),
      }),
  );
  await app.goto("/");
  await expect(
    page.getByRole("heading", { name: "iTrack is temporarily unavailable." }),
  ).toBeVisible();
  await audit(page, "load-failure");
});
