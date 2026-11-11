import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";
import type { LaunchOptions } from "@playwright/test";

import { stackEnv } from "./e2e/stack/stack-env";

const stack = stackEnv();

const port = Number(process.env["E2E_PORT"] ?? stack?.webPort ?? 3011);

const accountUrl = new URL(stack?.accountUrl ?? `http://localhost:${port + 3}`);

const platformUrl = stack?.platformUrl ?? "http://127.0.0.1:3214";

const mediaUrl = stack?.mediaUrl ?? "";

/**
 * A Chromium to run instead of Playwright's download, for hosts that cannot run that build (NixOS
 * without nix-ld). It must decode H.264 and AAC, as the playback suites expect.
 */
const chromium = process.env["E2E_CHROMIUM"];

const launchOptions: LaunchOptions = {};

if (chromium !== undefined && chromium !== "") launchOptions.executablePath = chromium;

const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } };

/** One project of the stack chain: it runs `spec` after `after`, as the media service is shared. */
const chained = (name: string, spec: RegExp, after: string) => ({
  name,
  testMatch: spec,
  dependencies: [after],
  use: desktop,
});

/**
 * Browser tests against both dev servers on one origin: the movies client at `/movies/` and the
 * account client at `/`, which this server passes every other path to (ADR 0020). Every suite
 * needs the worktree's dev stack (`scripts/dev-stack.sh up`), since the movies client opens only
 * on the browser's one session, signed in at `/`; each skips without it.
 *
 * `kit` checks the UI kit gallery, the player's track menu and next-episode benches, and the
 * not-found and error screens. `session` signs in once at `/` and opens `/movies` signed in, on a
 * desktop and on a phone. `stack` runs Home, a title, My List, the keyboard, and error reports on
 * a scanned library with the real media service, which the suites start themselves from
 * `apps/media/.env.local`. `admin` then runs the movies admin screens, `metadata` scans an NFO
 * library for the title, person, genre, and collection pages, `player` plays generated clips,
 * `scrubbing` checks scrub thumbnails and chapters, `versions` chooses among a title's files,
 * `subtitles` delays subtitles, `migration` imports from a Jellyfin, and `liveness` pauses HLS
 * streams past the media service's idle time, one of them on a Quick Sync encoder that cannot
 * restart, last. The suites that run a media service take turns, as it owns the stack's port.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    launchOptions,
  },
  projects: [
    {
      name: "kit",
      testMatch: /e2e\/(kit|route-states|track-menu|autoplay-next)\.spec\.ts$/u,
      use: desktop,
    },
    {
      name: "session",
      testMatch: /e2e\/session\/.*\.spec\.ts$/u,
      use: desktop,
    },
    {
      name: "session phone",
      testMatch: /e2e\/session\/.*\.spec\.ts$/u,
      use: { ...devices["iPhone 15"], defaultBrowserType: "chromium" },
    },
    { name: "stack", testMatch: /e2e\/stack\/.*\.spec\.ts$/u, use: desktop },
    chained("admin", /e2e\/admin\/(libraries|not-found)\.spec\.ts$/u, "stack"),
    chained("metadata", /e2e\/metadata\/.*\.spec\.ts$/u, "admin"),
    chained("player", /e2e\/playback\/player\.spec\.ts$/u, "metadata"),
    chained("scrubbing", /e2e\/playback\/scrubbing\.spec\.ts$/u, "player"),
    chained("versions", /e2e\/playback\/versions\.spec\.ts$/u, "scrubbing"),
    chained("subtitles", /e2e\/playback\/subtitle-timing\.spec\.ts$/u, "versions"),
    chained("migration", /e2e\/admin\/migration\.spec\.ts$/u, "subtitles"),
    chained("liveness", /e2e\/playback\/stream-liveness\.spec\.ts$/u, "migration"),
  ],
  webServer: [
    {
      command: `pnpm exec vite --port ${accountUrl.port} --strictPort`,
      cwd: fileURLToPath(new URL("../web-account", import.meta.url)),
      url: accountUrl.origin,
      reuseExistingServer: true,
      env: { VITE_PLATFORM_URL: platformUrl, VITE_MEDIA_BASE_URL: mediaUrl },
    },
    {
      command: `pnpm exec vite --port ${port} --strictPort`,
      url: `http://localhost:${port}/movies/`,
      reuseExistingServer: true,
      env: {
        VITE_PLATFORM_URL: platformUrl,
        VITE_MEDIA_BASE_URL: mediaUrl,
        ACCOUNT_DEV_URL: accountUrl.origin,
      },
    },
  ],
});
