import { defineConfig, devices } from "@playwright/test";
import type { LaunchOptions } from "@playwright/test";

const launchOptions: LaunchOptions = { args: ["--autoplay-policy=no-user-gesture-required"] };

const chromiumPath = process.env["CHROMIUM_PATH"];

if (chromiumPath !== undefined) launchOptions.executablePath = chromiumPath;

/**
 * End-to-end tests against a running [music] container: real Convex, real media service, real
 * audio. Start a fresh container with a library mounted at /music, then:
 *
 *   MUSIC_URL=http://localhost:8090 pnpm --filter web test:stack
 *
 * See e2e-stack/README.md.
 */
export default defineConfig({
  testDir: "./e2e-stack",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env["CI"]),
  timeout: 120_000,
  expect: { timeout: 20_000 },
  outputDir: "test-results/stack",
  use: {
    baseURL: process.env["MUSIC_URL"] ?? "http://localhost:8090",
    trace: "retain-on-failure",
    video: process.env["MUSIC_VIDEO"] === "1" ? "on" : "off",
    launchOptions,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
