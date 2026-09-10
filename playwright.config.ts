import { defineConfig } from "@playwright/test";

// Browser regression tests against the dev server (demo identity on
// localhost). Not part of `npm test`: run `npm run test:e2e` with the dev
// server up (it is started for you if :3000 is free).
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000/",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
