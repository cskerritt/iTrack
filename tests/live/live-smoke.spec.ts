import { expect, test } from "@playwright/test";

// Live smoke, unauthenticated — the Playwright half of spec §9's "live smoke
// (curl matrix + Playwright login) after every deploy". Runs under
// playwright.live.config.ts against a gateway origin (LIVE_BASE_URL); needs
// no secret and never signs in. What it proves after a deploy: the login
// page renders its form, a wrong password gets the one generic answer and
// stays on /login (the gateway and its auth store are up), `/` unauthenticated
// is the landing page (not the app shell), and an app path round-trips
// through /login?next=. Not part of `npm run test:e2e` (tests/e2e is that
// suite's testDir); it imports @playwright/test directly — the e2e fixtures'
// identity header and hydration wait belong to the dev server, not to a
// gateway.
//
// Budget: exactly one failed login per run. The gateway's per-IP failure
// bucket is 10 in 15 minutes (auth-routes.mjs `loginLimiter`); the eleventh
// answers /login?error=rate-limited instead. Never loop this file.

const LOGIN_FORM = 'form[action="/auth/login"]';

test("the login page renders the email and password form", async ({ page }) => {
  await page.goto("/login");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { level: 1, name: "Welcome back" })).toBeVisible();
  await expect(page.locator(`${LOGIN_FORM} input[name="email"]`)).toBeVisible();
  await expect(page.locator(`${LOGIN_FORM} input[name="password"]`)).toBeVisible();
  await expect(page.locator(`${LOGIN_FORM} button[type="submit"]`)).toHaveText("Log in");
});

test("a wrong password gets the generic answer and stays on /login", async ({ page }) => {
  await page.goto("/login");
  await page.locator(`${LOGIN_FORM} input[name="email"]`).fill("nobody@example.test");
  await page.locator(`${LOGIN_FORM} input[name="password"]`).fill(`not-the-password-${Date.now().toString(36)}`);
  await page.locator(`${LOGIN_FORM} button[type="submit"]`).click();
  // auth-routes.mjs: a failed attempt 303s to /login?error=bad-credentials
  // and the page's inline script shows the matching flash. An unknown
  // address and a wrong password share the answer (security-04), so this
  // never reveals whether nobody@example.test exists.
  await expect(page).toHaveURL(/\/login\?error=bad-credentials$/);
  const flash = page.locator("#flash-bad-credentials");
  await expect(flash).toBeVisible();
  await expect(flash).toContainText("We couldn't sign you in with that email and password");
});

test("/ unauthenticated is the landing page, not the app", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page).toHaveTitle("iTrack — credential and CE renewal tracking");
  await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();
  // The app shell's navs are named "Primary navigation"; the landing has none.
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toHaveCount(0);
});

test("an app path unauthenticated round-trips through /login?next=", async ({ page }) => {
  await page.goto("/credentials");
  await expect(page).toHaveURL(/\/login\?next=%2Fcredentials$/);
  // login.html's inline script copies a same-origin `next` into the form.
  await expect(page.locator(`${LOGIN_FORM} input[name="next"]`)).toHaveValue("/credentials");
});
