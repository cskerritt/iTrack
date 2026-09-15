import { defineConfig, devices } from "@playwright/test";

// Browser regression tests against the dev server (demo identity on
// localhost; fresh identities via tests/e2e/fixtures.ts). Not part of
// `npm test`: run `npm run test:e2e` with the dev server up (it is started
// for you if the port is free). Four projects cover the whole spec §9 matrix
// (both colour schemes at 1440×900 and at 390×844); only the axe gate
// arrives with Wave 3.
//
// One env var drives everything: E2E_BASE_URL (default http://localhost:3000)
// is the browser's baseURL, the readiness URL the runner polls, and the port
// the dev server is told to listen on — so a machine whose :3000 is taken by
// something else runs the same suite unchanged with
// E2E_BASE_URL=http://localhost:3100.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const baseOrigin = new URL(baseURL);
const port = baseOrigin.port || "3000";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  retries: 0,
  reporter: "list",
  // One dev server and one D1 file behind it: specs that write share them,
  // so nothing runs in parallel.
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL,
  },
  projects: [
    {
      name: "desktop-light",
      use: { viewport: { width: 1440, height: 900 }, colorScheme: "light" },
    },
    {
      name: "phone-dark",
      // The iPhone descriptor brings the Safari user agent, touch and the
      // 3x scale factor. Its defaultBrowserType is WebKit, pinned back to
      // Chromium so the suite needs one browser install (a WebKit project is
      // a Wave 3 gate decision), and its 390×664 viewport is replaced by
      // the spec's 390×844. phone-light below is the same descriptor in the
      // light scheme; desktop-dark is the desktop viewport in the dark one.
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        colorScheme: "dark",
      },
    },
    {
      name: "desktop-dark",
      use: { viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
    },
    {
      name: "phone-light",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        colorScheme: "light",
      },
    },
  ],
  webServer: {
    // vinext accepts -p/--port; the `--` hands it through npm.
    command: `npm run dev -- --port ${port}`,
    url: new URL("/", baseOrigin).href,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
