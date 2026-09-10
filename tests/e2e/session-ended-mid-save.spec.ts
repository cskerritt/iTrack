import { expect, test, type Locator, type Page } from "@playwright/test";

// app-ux-M-01 / architecture-M-04: a 401 on a write used to surface as a JSON
// parse error. Reading it as "session ended" drops the workspace so the
// Reload-and-sign-in state renders, but the personal-task editor is not gated
// on `workspace`, and a mounted Modal marks its surroundings inert, so the
// Reload state was on screen yet neither perceivable nor operable until the
// user happened to Cancel. The session-ended state has to be the only thing
// on screen, without cancelling anything.

const SESSION_ENDED = {
  status: 401,
  contentType: "application/json",
  headers: { "cache-control": "no-store" },
  body: JSON.stringify({ error: "unauthenticated" }),
};

const isWorkspaceApi = (url: URL) => url.pathname === "/api/workspace";

function collectPageErrors(page: Page) {
  // A render-time throw is uncaught in production (pageerror); under
  // `npm run dev` vinext's recovery boundary catches it and React reports it
  // through console.error. Collect both.
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && /^(?:[A-Z]\w*)?Error\b/.test(text)) {
      pageErrors.push(text.split("\n")[0]);
    }
  });
  return pageErrors;
}

async function openAddTask(page: Page) {
  await page.goto("/");
  // The shell is server-rendered before React hydrates; wait for the client
  // to have fetched the workspace before clicking.
  await expect(
    page.locator('[aria-busy="true"][aria-label="Loading iTrack"]'),
  ).toHaveCount(0, { timeout: 30_000 });
  await page.getByRole("button", { name: "Add task" }).first().click();
  const sheet = page.locator(".modal-card");
  await expect(sheet).toBeVisible();
  await sheet.locator('input[name="title"]').fill("Request transcript");
  return sheet;
}

async function expectSessionEndedState(page: Page, sheet: Locator) {
  await expect(sheet).toHaveCount(0);
  // getByRole ignores aria-hidden subtrees, so this also proves the Reload
  // state is exposed to assistive technology, not just painted.
  const reload = page.getByRole("button", { name: "Reload and sign in" });
  await expect(reload).toBeVisible();
  await expect(reload).toBeEnabled();
  await expect(
    page.getByRole("heading", { name: "Your sign-in needs to be refreshed." }),
  ).toBeVisible();
  const stage = page.locator(".screen-stack");
  await expect(stage).not.toHaveAttribute("aria-hidden", "true");
  expect(await stage.evaluate((element) => (element as HTMLElement).inert)).toBe(false);
  // The page-level banner belongs to a loaded workspace; nothing else is
  // asking for attention.
  await expect(page.locator(".error-banner")).toHaveCount(0);
}

test("a 401 while saving a personal task closes the editor and shows Reload and sign in", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  await page.route(isWorkspaceApi, async (route) => {
    if (route.request().method() === "POST") await route.fulfill(SESSION_ENDED);
    else await route.continue();
  });

  const sheet = await openAddTask(page);
  await sheet.getByRole("button", { name: "Add task" }).click();

  await expectSessionEndedState(page, sheet);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("a 401 on the workspace refetch after a write conflict shows Reload and sign in", async ({ page }) => {
  const pageErrors = collectPageErrors(page);
  // A stale-revision conflict makes runAction refetch the workspace while one
  // is still on screen; that refetch is the 401 here. The write itself never
  // reaches the dev server.
  let sessionEnded = false;
  await page.route(isWorkspaceApi, async (route) => {
    if (route.request().method() === "POST") {
      sessionEnded = true;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "That task changed in another session.",
          code: "task_version_conflict",
        }),
      });
    } else if (sessionEnded) {
      await route.fulfill(SESSION_ENDED);
    } else {
      await route.continue();
    }
  });

  const sheet = await openAddTask(page);
  await sheet.getByRole("button", { name: "Add task" }).click();

  await expectSessionEndedState(page, sheet);
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});
