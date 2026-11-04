import { defineConfig, devices } from "@playwright/test";

import { harnessPort, mediaPort } from "./harness/config.ts";

const chromiumPath = process.env["CHROMIUM_PATH"];

const autoplay = ["--autoplay-policy=no-user-gesture-required"];

const desktopAutoplay = ["--autoplay-policy=document-user-activation-required"];

const firefoxAutoplay = {
  "media.autoplay.default": 0,
  "media.autoplay.block-webaudio": false,
};

const launch = (args: ReadonlyArray<string>) =>
  chromiumPath === undefined
    ? { args: [...args] }
    : { args: [...args], executablePath: chromiumPath };

/**
 * Browser tests for the player. `engine` and the `gapless-*` and `transcoded-*` projects need only
 * the media stub (and ffmpeg); `session` also needs the dev backend from `scripts/dev-backend.sh`.
 * The gapless and transcoded tests run in Chromium, Firefox, and WebKit: install the latter with
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
      name: "transcoded-chromium",
      testMatch: "transcoded.spec.ts",
      use: { ...devices["Desktop Chrome"], launchOptions: launch(autoplay) },
    },
    {
      name: "transcoded-firefox",
      testMatch: "transcoded.spec.ts",
      use: { ...devices["Desktop Firefox"], launchOptions: { firefoxUserPrefs: firefoxAutoplay } },
    },
    {
      name: "transcoded-webkit",
      testMatch: "transcoded.spec.ts",
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "session",
      testMatch: "session.spec.ts",
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
