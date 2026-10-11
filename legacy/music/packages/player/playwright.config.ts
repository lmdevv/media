import { defineConfig, devices } from "@playwright/test";

import { harnessPort, mediaPort } from "./harness/config.ts";

const chromiumPath = process.env["CHROMIUM_PATH"];

/** Browser args for the engine tests, which start audio without a click. */
const autoplay = ["--autoplay-policy=no-user-gesture-required"];

/** Desktop Chrome's real policy; headless Chromium otherwise allows audio without a gesture. */
const desktopAutoplay = ["--autoplay-policy=document-user-activation-required"];

/** Firefox's equivalent of `autoplay`, for the gapless tests. */
const firefoxAutoplay = {
  "media.autoplay.default": 0,
  "media.autoplay.block-webaudio": false,
};

const launch = (args: ReadonlyArray<string>) =>
  chromiumPath === undefined
    ? { args: [...args] }
    : { args: [...args], executablePath: chromiumPath };

/**
 * Browser tests for the player. `engine` and the `gapless-*` projects need only the media stub
 * (and ffmpeg); `session` also needs the dev backend from `scripts/dev-backend.sh`. The gapless
 * tests run in Chromium, Firefox, and WebKit: install the latter with
 * `pnpm exec playwright install firefox webkit`. Set CHROMIUM_PATH to use a system Chromium; on
 * NixOS run through `scripts/nixos-browsers.sh` so Playwright's Firefox and WebKit find their
 * libraries.
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
      name: "gapless-chromium",
      testMatch: "gapless.spec.ts",
      use: { ...devices["Desktop Chrome"], launchOptions: launch(autoplay) },
    },
    {
      name: "gapless-firefox",
      testMatch: "gapless.spec.ts",
      use: { ...devices["Desktop Firefox"], launchOptions: { firefoxUserPrefs: firefoxAutoplay } },
    },
    {
      name: "gapless-webkit",
      testMatch: "gapless.spec.ts",
      use: { ...devices["Desktop Safari"] },
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
      command: "node --import ./harness/resolve-ts.ts harness/media-stub.ts",
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
