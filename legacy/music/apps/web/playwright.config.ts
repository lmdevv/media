import { defineConfig, devices } from "@playwright/test";
import type { LaunchOptions } from "@playwright/test";

import { e2eConvexUrl, e2eMediaPort } from "./e2e/env";

const port = Number(process.env["E2E_PORT"] ?? "3002");

const launchOptions: LaunchOptions = {};

// A system Chromium, for hosts such as NixOS where Playwright's own build does not run.
const chromiumPath = process.env["CHROMIUM_PATH"];

if (chromiumPath !== undefined) launchOptions.executablePath = chromiumPath;

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
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure", launchOptions },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: `pnpm exec vite --port ${port} --strictPort`,
      url: `http://localhost:${port}`,
      reuseExistingServer: true,
      env: { VITE_CONVEX_URL: e2eConvexUrl() },
    },
    {
      // Never a real media service already on that port (`pnpm dev`): it has no files for the
      // seeded songs, so playing would fail. Playwright stops with "port already used" instead.
      command: `node e2e/media-stand-in.ts ${String(e2eMediaPort())}`,
      url: `http://127.0.0.1:${String(e2eMediaPort())}/media/health`,
      reuseExistingServer: false,
    },
  ],
});
