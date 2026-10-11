import { defineConfig, devices } from "@playwright/test";

import { e2eConvexUrl } from "./e2e/env";

const port = Number(process.env["E2E_PORT"] ?? "3002");

/**
 * End-to-end tests against a real Convex backend. They read the backend URL from E2E_CONVEX_URL,
 * or VITE_CONVEX_URL in apps/web/.env.local (written by scripts/dev-backend.sh). See e2e/README.md.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env["CI"]),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    env: { VITE_CONVEX_URL: e2eConvexUrl() },
  },
});
