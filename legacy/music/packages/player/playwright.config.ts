import { defineConfig, devices } from "@playwright/test";

import { harnessPort, mediaPort } from "./harness/config.ts";

const chromiumPath = process.env["CHROMIUM_PATH"];

/** Browser args for the engine tests, which start audio without a click. */
const autoplay = ["--autoplay-policy=no-user-gesture-required"];

/** Desktop Chrome's real policy; headless Chromium otherwise allows audio without a gesture. */
const desktopAutoplay = ["--autoplay-policy=document-user-activation-required"];

const launch = (args: ReadonlyArray<string>) =>
  chromiumPath === undefined
    ? { args: [...args] }
    : { args: [...args], executablePath: chromiumPath };

/**
 * Browser tests for the player. `engine` needs only the media stub; `session` also needs the dev
 * backend from `scripts/dev-backend.sh`. Set CHROMIUM_PATH to use a system Chromium (NixOS).
 */
export default defineConfig({
  testDir: "./browser",
  workers: 1,
  timeout: 60_000,
  forbidOnly: Boolean(process.env["CI"]),
  use: { baseURL: `http://127.0.0.1:${harnessPort}`, trace: "retain-on-failure" },
  projects: [
    {
      name: "engine",
      testMatch: "engine.spec.ts",
      use: { ...devices["Desktop Chrome"], launchOptions: launch(autoplay) },
    },
    {
      name: "session",
      testMatch: "session.spec.ts",
      // A handoff meets the same autoplay rules as in a real browser. Tracing stays off: its
      // snapshots run script in every page, which grants the user activation under test.
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: launch(desktopAutoplay),
        trace: "off",
      },
    },
  ],
  webServer: [
    {
      command: "node harness/media-stub.ts",
      url: `http://127.0.0.1:${mediaPort}/media/health`,
      reuseExistingServer: false,
    },
    {
      command: "pnpm exec vite --config harness/vite.config.ts",
      url: `http://127.0.0.1:${harnessPort}/engine.html`,
      reuseExistingServer: false,
    },
  ],
});
