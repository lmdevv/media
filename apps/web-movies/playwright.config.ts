import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";
import type { LaunchOptions, Project } from "@playwright/test";

import { stackEnv } from "./e2e/stack/stack-env";

const stack = stackEnv();

const port = Number(process.env["E2E_PORT"] ?? stack?.webPort ?? 3011);

const accountUrl = new URL(stack?.accountUrl ?? `http://localhost:${port + 3}`);

const platformUrl = stack?.platformUrl ?? "http://127.0.0.1:3214";

const mediaUrl = stack?.mediaUrl ?? "";

/** The stack's sign-in boundary, which the account client signs in through (ADR 0007). */
const signInUrl = stack?.signInUrl ?? "";

/**
 * A Chromium to run instead of Playwright's download, for hosts that cannot run that build (NixOS
 * without nix-ld). It must decode H.264 and AAC, as the playback suites expect.
 */
const chromium = process.env["E2E_CHROMIUM"];

const launchOptions: LaunchOptions = {};

if (chromium !== undefined && chromium !== "") launchOptions.executablePath = chromium;

const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } };

interface Suite {
  readonly name: string;
  readonly group: "core" | "player" | "streams";
  readonly testMatch: RegExp;
  readonly device?: Project["use"];
  /** Runs a media service, so it takes its turn after the suite before it in its group. */
  readonly chained: boolean;
}

const phone = { ...devices["iPhone 15"], defaultBrowserType: "chromium" };

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
 * restart, last. The suites that run a media service take turns in this order, as it owns the
 * stack's port.
 *
 * Each suite creates the people it signs in as, so CI runs each group on its own stack in its own
 * job, `E2E_GROUP` naming it.
 */
const suites: ReadonlyArray<Suite> = [
  {
    name: "kit",
    group: "core",
    testMatch: /e2e\/(kit|route-states|track-menu|autoplay-next)\.spec\.ts$/u,
    chained: false,
  },
  { name: "session", group: "core", testMatch: /e2e\/session\/.*\.spec\.ts$/u, chained: false },
  {
    name: "session phone",
    group: "core",
    testMatch: /e2e\/session\/.*\.spec\.ts$/u,
    device: phone,
    chained: false,
  },
  { name: "stack", group: "core", testMatch: /e2e\/stack\/.*\.spec\.ts$/u, chained: true },
  {
    name: "admin",
    group: "core",
    testMatch: /e2e\/admin\/(libraries|not-found)\.spec\.ts$/u,
    chained: true,
  },
  { name: "metadata", group: "core", testMatch: /e2e\/metadata\/.*\.spec\.ts$/u, chained: true },
  {
    name: "player",
    group: "player",
    testMatch: /e2e\/playback\/player\.spec\.ts$/u,
    chained: true,
  },
  {
    name: "scrubbing",
    group: "player",
    testMatch: /e2e\/playback\/scrubbing\.spec\.ts$/u,
    chained: true,
  },
  {
    name: "versions",
    group: "streams",
    testMatch: /e2e\/playback\/versions\.spec\.ts$/u,
    chained: true,
  },
  {
    name: "subtitles",
    group: "streams",
    testMatch: /e2e\/playback\/subtitle-timing\.spec\.ts$/u,
    chained: true,
  },
  {
    name: "migration",
    group: "streams",
    testMatch: /e2e\/admin\/migration\.spec\.ts$/u,
    chained: true,
  },
  {
    name: "liveness",
    group: "streams",
    testMatch: /e2e\/playback\/stream-liveness\.spec\.ts$/u,
    chained: true,
  },
];

const group = process.env["E2E_GROUP"] ?? "";

const chosen = suites.filter((suite) => group === "" || suite.group === group);

if (chosen.length === 0) throw new Error(`E2E_GROUP names no group: ${group}`);

const turns = chosen.filter((suite) => suite.chained);

const ci = Boolean(process.env["CI"]);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: ci,
  timeout: 60_000,
  reporter: ci ? [["dot"], ["json", { outputFile: "playwright-report/results.json" }]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    launchOptions,
  },
  projects: chosen.map((suite) => {
    const before = suite.chained ? turns[turns.indexOf(suite) - 1] : undefined;

    return {
      name: suite.name,
      testMatch: suite.testMatch,
      dependencies: before === undefined ? [] : [before.name],
      use: suite.device ?? desktop,
    };
  }),
  webServer: [
    {
      command: `pnpm exec vite --port ${accountUrl.port} --strictPort`,
      cwd: fileURLToPath(new URL("../web-account", import.meta.url)),
      url: accountUrl.origin,
      reuseExistingServer: true,
      env: {
        VITE_PLATFORM_URL: platformUrl,
        VITE_MEDIA_BASE_URL: mediaUrl,
        VITE_SIGN_IN_URL: signInUrl,
      },
    },
    {
      command: `pnpm exec vite --port ${port} --strictPort`,
      url: `http://localhost:${port}/movies/`,
      reuseExistingServer: true,
      env: {
        VITE_PLATFORM_URL: platformUrl,
        VITE_MEDIA_BASE_URL: mediaUrl,
        VITE_SIGN_IN_URL: signInUrl,
        ACCOUNT_DEV_URL: accountUrl.origin,
      },
    },
  ],
});
