import { networkInterfaces } from "node:os";

import { defineConfig, devices } from "@playwright/test";
import type { LaunchOptions } from "@playwright/test";

import { stackEnv } from "./e2e/stack";

const stack = stackEnv();

const port = Number(process.env["E2E_PORT"] ?? stack?.accountPort ?? 3012);

/**
 * A Chromium to run instead of Playwright's download, for hosts that cannot run that build (NixOS
 * without nix-ld).
 */
const chromium = process.env["E2E_CHROMIUM"];

const launchOptions: LaunchOptions = {};

if (chromium !== undefined && chromium !== "") launchOptions.executablePath = chromium;

/**
 * A non-loopback address of this host. A page served from it over plain HTTP is not a secure
 * context, as on a LAN or tailnet install, so APIs such as `crypto.randomUUID` are missing there.
 */
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)?.address;

const lanPort = port + 1;

const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } };

const platformUrl = stack?.platformUrl ?? "http://127.0.0.1:3214";

const mediaUrl = stack?.mediaUrl ?? "";

/** The stack's sign-in boundary, which the account client signs in through (ADR 0007). */
const signInUrl = stack?.signInUrl ?? "";

/** The admin pages that need the media server, which `server.spec.ts` starts on the stack's port. */
const SERVER_SPEC = /e2e\/server\.spec\.ts$/u;

/**
 * The account client against the worktree's core (`scripts/dev-stack.sh up`): sign in, accepting
 * an invite, and approving a device sign-in, on the desktop and again over a plain-HTTP LAN
 * address. `server` runs the admin Server and Backups pages once, against the media server it
 * starts from source on the stack's settings, as only one can hold the stack's media port. Each
 * skips without a stack.
 */
// A failed test's error context holds the page's text, such as an admin page's invite link.
process.env["PLAYWRIGHT_NO_COPY_PROMPT"] = "1";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  timeout: 60_000,
  // Pages and requests carry passwords, tokens, and link codes, so a failure keeps only text.
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "off",
    screenshot: "off",
    video: "off",
    launchOptions,
  },
  projects: [
    { name: "desktop", testIgnore: SERVER_SPEC, use: desktop },
    ...(lanAddress === undefined
      ? []
      : [
          {
            name: "plain HTTP",
            testIgnore: SERVER_SPEC,
            use: { ...desktop, baseURL: `http://${lanAddress}:${lanPort}` },
          },
        ]),
    { name: "server", testMatch: SERVER_SPEC, use: desktop },
  ],
  webServer: [
    {
      command: `pnpm exec vite --port ${port} --strictPort`,
      url: `http://localhost:${port}`,
      reuseExistingServer: true,
      env: {
        VITE_PLATFORM_URL: platformUrl,
        VITE_MEDIA_BASE_URL: mediaUrl,
        VITE_SIGN_IN_URL: signInUrl,
      },
    },
    ...(lanAddress === undefined
      ? []
      : [
          {
            command: `pnpm exec vite --host ${lanAddress} --port ${lanPort} --strictPort`,
            url: `http://${lanAddress}:${lanPort}`,
            reuseExistingServer: true,
            env: {
              VITE_PLATFORM_URL: platformUrl,
              VITE_MEDIA_BASE_URL: mediaUrl,
              VITE_SIGN_IN_URL: signInUrl,
            },
          },
        ]),
  ],
});
