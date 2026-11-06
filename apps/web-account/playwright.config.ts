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

/**
 * The account client against the worktree's core (`scripts/dev-stack.sh up`): sign in, accepting
 * an invite, and approving a device sign-in. It skips without a stack.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  timeout: 60_000,
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure", launchOptions },
  projects: [
    { name: "desktop", use: desktop },
    ...(lanAddress === undefined
      ? []
      : [{ name: "plain HTTP", use: { ...desktop, baseURL: `http://${lanAddress}:${lanPort}` } }]),
  ],
  webServer: [
    {
      command: `pnpm exec vite --port ${port} --strictPort`,
      url: `http://localhost:${port}`,
      reuseExistingServer: true,
      env: { VITE_PLATFORM_URL: platformUrl },
    },
    ...(lanAddress === undefined
      ? []
      : [
          {
            command: `pnpm exec vite --host ${lanAddress} --port ${lanPort} --strictPort`,
            url: `http://${lanAddress}:${lanPort}`,
            reuseExistingServer: true,
            env: { VITE_PLATFORM_URL: platformUrl },
          },
        ]),
  ],
});
