import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

export const ADMIN = {
  email: "admin@music.local",
  password: "password123",
  name: "Lucía",
} as const;

declare global {
  interface Window {
    /** Media elements the page started, recorded by the init script. */
    musicTestMedia?: Set<HTMLMediaElement>;
    /** Content-Security-Policy violations the page reported, recorded by the init script. */
    musicCspViolations?: Array<string>;
  }
}

const musicUrl = (): string => process.env["MUSIC_URL"] ?? "http://localhost:8090";

/**
 * Records every media element the page creates, including detached ones such as `new Audio()`,
 * so tests can check real playback.
 */
const trackMediaElements = async (page: Page): Promise<void> => {
  // Plain JavaScript: it runs in the page before the app and patches the media element prototype.
  await page.addInitScript({
    content: `
      window.musicTestMedia = new Set();
      window.musicCspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        window.musicCspViolations.push(event.violatedDirective + " " + event.blockedURI);
      });
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        window.musicTestMedia.add(this);
        return play.call(this);
      };
    `,
  });
};

/** Signs in through the sign-in screen and waits for the library. */
export const signIn = async (page: Page): Promise<void> => {
  await trackMediaElements(page);
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Desktop shows the Library sidebar, phone the tab bar.
  await expect(
    page
      .getByRole("navigation", { name: "Library" })
      .or(page.getByRole("navigation", { name: "Main" })),
  ).toBeVisible();
};

/** Seconds of audio the page has actually played, from its media elements. */
const playedSeconds = (page: Page): Promise<number> =>
  page.evaluate(() =>
    Math.max(
      0,
      ...[...(window.musicTestMedia ?? [])].map((element) =>
        element.paused ? 0 : element.currentTime,
      ),
    ),
  );

/** Waits until real audio has played past `seconds` (not just the UI saying it plays). */
export const expectAudioPast = async (page: Page, seconds: number): Promise<void> => {
  await expect.poll(() => playedSeconds(page), { timeout: 30_000 }).toBeGreaterThan(seconds);
};

/** Content-Security-Policy violations the page has reported since it loaded. */
export const cspViolations = (page: Page): Promise<ReadonlyArray<string>> =>
  page.evaluate(() => window.musicCspViolations ?? []);

/** Whether any media element on the page is playing. */
export const isPlayingAudio = (page: Page): Promise<boolean> =>
  page.evaluate(() => [...(window.musicTestMedia ?? [])].some((element) => !element.paused));

const cliPath = fileURLToPath(new URL("../../cli/dist/music.js", import.meta.url));

/** Runs the built `music` CLI against the container with an API key. */
export const cli = (key: string, args: ReadonlyArray<string>): string =>
  execFileSync("node", [cliPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      MUSIC_SERVER: `${musicUrl()}/convex`,
      MUSIC_API_KEY: key,
      XDG_CONFIG_HOME: "/tmp/music-stack-cli",
    },
  });

/** The container `scripts/stack-e2e.sh` started; empty when the suite runs against another server. */
export const container = (): string => process.env["MUSIC_CONTAINER"] ?? "";

/** Runs the container's own Convex CLI with the admin key, as `/app/bin/init` does. */
const CONVEX = `cd /app/backend && CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 \\
  CONVEX_SELF_HOSTED_ADMIN_KEY="$(cat /data/secrets/admin_key)" ./node_modules/.bin/convex`;

/** Runs `script` in the container's shell with `args` as its positional parameters. */
const inContainer = (script: string, args: ReadonlyArray<string>, input = ""): string =>
  execFileSync("docker", ["exec", "-i", container(), "sh", "-c", script, "convex", ...args], {
    encoding: "utf8",
    input,
  });

/**
 * Runs `convex <args>` against the container's backend with its admin key, as an operator would,
 * for example to run a cron's function now or read a table.
 */
export const convexAdmin = (args: ReadonlyArray<string>): string =>
  inContainer(`${CONVEX} "$@"`, args);

/** Appends rows the app cannot create, such as a device last seen weeks ago, to `table`. */
export const convexImport = (table: string, docs: ReadonlyArray<object>): void => {
  inContainer(
    `file="$(mktemp)" && cat > "$file" && ${CONVEX} import --format jsonLines --table "$1" --append -y "$file"`,
    [table],
    docs.map((doc) => JSON.stringify(doc)).join("\n"),
  );
};
