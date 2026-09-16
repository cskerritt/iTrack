import { defineConfig } from "@playwright/test";

// The unauthenticated live smoke (spec §9 Deploy: "live smoke (curl matrix +
// Playwright login) after every deploy"): tests/live/*.spec.ts against a
// deployed origin's GATEWAY (deploy/railway/gateway.mjs + auth-routes.mjs) —
// the Docker run-check container before a merge, itrackceu.com after a
// deploy. Its own config because playwright.config.ts starts a dev server,
// which has no gateway, and because these tests must never count as skipped
// inside `npm run test:e2e`. No webServer: the origin is already up. One
// desktop project; the login page is not scheme-aware.
//
//   LIVE_BASE_URL=https://itrackceu.com npx playwright test --config playwright.live.config.ts
const baseURL = process.env.LIVE_BASE_URL;
if (!baseURL) {
  throw new Error("set LIVE_BASE_URL, e.g. https://itrackceu.com or http://localhost:8080");
}

export default defineConfig({
  testDir: "tests/live",
  timeout: 60_000,
  retries: 0,
  reporter: "list",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  },
  projects: [{ name: "desktop-light" }],
});
