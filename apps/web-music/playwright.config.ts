import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";
import type { LaunchOptions } from "@playwright/test";

import { stackEnv } from "./e2e/stack-env";

const stack = stackEnv();

const port = Number(process.env["E2E_PORT"] ?? stack?.musicPort ?? 3012);

const accountUrl = new URL(stack?.accountUrl ?? `http://localhost:${port + 1}`);

const env = {
  VITE_PLATFORM_URL: stack?.platformUrl ?? "http://127.0.0.1:3214",
  VITE_MEDIA_BASE_URL: stack?.mediaUrl ?? "",
  VITE_SIGN_IN_URL: stack?.signInUrl ?? "",
};

/** A Chromium to run instead of Playwright's download, for hosts that cannot run that build. */
const chromium = process.env["E2E_CHROMIUM"];

const launchOptions: LaunchOptions = { args: ["--autoplay-policy=no-user-gesture-required"] };

if (chromium !== undefined && chromium !== "") launchOptions.executablePath = chromium;

const ci = Boolean(process.env["CI"]);

/**
 * Browser tests against both dev servers on one origin: the music client at `/music/` and the
 * account client at `/`, which this server passes every other path to (ADR 0020). They need the
 * worktree's dev stack (`scripts/dev-stack.sh up`), since the music client opens only on the
 * browser's one session, signed in at `/`, and start the media service themselves from
 * `apps/media/.env.local` to scan and stream a fixture album; they skip without the stack.
 */
export default defineConfig({
  testDir: "./e2e",
  forbidOnly: ci,
  timeout: 120_000,
  reporter: ci ? "dot" : "list",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    actionTimeout: 15_000,
    launchOptions,
  },
  webServer: [
    {
      command: `pnpm exec vite --port ${accountUrl.port} --strictPort`,
      cwd: fileURLToPath(new URL("../web-account", import.meta.url)),
      url: accountUrl.origin,
      reuseExistingServer: true,
      env,
    },
    {
      command: `pnpm exec vite --port ${port} --strictPort`,
      url: `http://localhost:${port}/music/`,
      reuseExistingServer: true,
      env: { ...env, ACCOUNT_DEV_URL: accountUrl.origin },
    },
  ],
});
