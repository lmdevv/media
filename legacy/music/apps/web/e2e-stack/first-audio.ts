/**
 * Measures time to first audio against a running [music] container: for each song of one album,
 * the time from tapping its play button to its audio actually advancing in Chromium. Run it on a
 * fresh container so every song is a first play (an uncached transcode):
 *
 *   NAME=music-measure PORT=8098 MUSIC_DIR=~/music-demo/demo-music KEEP=1 scripts/stack-e2e.sh
 *   MUSIC_URL=http://localhost:8098 ALBUM="Vienna Blue" node apps/web/e2e-stack/first-audio.ts
 *
 * Signs in as the stack suite's admin, creating it and the `/music` library on a fresh container.
 * Prints one line per song and the median. Set CHROMIUM_PATH to use a system Chromium.
 */
import { chromium } from "@playwright/test";
import type { LaunchOptions, Page } from "@playwright/test";

import { ADMIN } from "./support.ts";

const baseUrl = process.env["MUSIC_URL"] ?? "http://localhost:8090";

const album = process.env["ALBUM"] ?? "Vienna Blue";

const launchOptions: LaunchOptions = { args: ["--autoplay-policy=no-user-gesture-required"] };

const chromiumPath = process.env["CHROMIUM_PATH"];

if (chromiumPath !== undefined) launchOptions.executablePath = chromiumPath;

/**
 * Taps the play button of the song in row `index` and resolves with the milliseconds until a
 * media element plays a new source past its first 20 ms.
 */
const timeToFirstAudio = (page: Page, index: number): Promise<number> =>
  page.evaluate(async (target) => {
    const before = new Map([...(window.musicTestMedia ?? [])].map((media) => [media, media.src]));

    // One button per row: the album's own play button can share a song's label.
    const button = [...document.querySelectorAll("main [role=row]")]
      .flatMap((row) => row.querySelector<HTMLButtonElement>("button[aria-label^='Play ']") ?? [])
      .at(target);

    if (button === undefined) throw new Error(`No play button for song ${target + 1}`);
    const started = performance.now();
    button.click();

    return new Promise<number>((resolve, reject) => {
      const poll = setInterval(() => {
        const playing = [...(window.musicTestMedia ?? [])].some(
          (media) => !media.paused && media.currentTime > 0.02 && before.get(media) !== media.src,
        );

        if (playing) {
          clearInterval(poll);
          resolve(performance.now() - started);
        } else if (performance.now() - started > 60_000) {
          clearInterval(poll);
          reject(new Error("No audio within a minute"));
        }
      }, 5);
    });
  }, index);

const browser = await chromium.launch(launchOptions);

const page = await browser.newPage({ baseURL: baseUrl, viewport: { width: 1440, height: 900 } });

// Plain JavaScript run before the app: remembers every media element that starts playing.
await page.addInitScript({
  content: `
    window.musicTestMedia = new Set();
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      window.musicTestMedia.add(this);
      return play.call(this);
    };
  `,
});

await page.goto("/");

await page.waitForURL(/\/(setup|sign-in)/u);

if (page.url().includes("/setup")) {
  await page.getByLabel("Name").fill(ADMIN.name);
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Create admin account" }).click();
  await page.getByLabel("Library folder").fill("/music");
  await page.getByRole("button", { name: "Start scanning" }).click();
  await page.getByRole("heading", { name: "Your library is ready" }).waitFor({ timeout: 300_000 });
  await page.getByRole("button", { name: "Open my library" }).click();
} else {
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

const library = page.getByRole("navigation", { name: "Library" });

await library.getByRole("link", { name: "Albums" }).click();

await page.locator("main").getByText(album, { exact: true }).first().click({ timeout: 180_000 });

await page.getByRole("heading", { level: 1, name: album }).waitFor();

const rows = page.locator("main [role=row]").filter({
  has: page.locator("button[aria-label^='Play ']"),
});

const count = await rows.count();

/** Plays the songs one after another, from row `index` on. */
const measureFrom = async (
  index: number,
  results: ReadonlyArray<number>,
): Promise<ReadonlyArray<number>> => {
  if (index >= count) return results;
  const button = rows.nth(index).locator("button[aria-label^='Play ']").first();
  const label = (await button.getAttribute("aria-label")) ?? `song ${index + 1}`;
  const milliseconds = await timeToFirstAudio(page, index);

  console.log(`${label}: ${Math.round(milliseconds)} ms`);
  await page.waitForTimeout(1500);

  return measureFrom(index + 1, [...results, milliseconds]);
};

const results = await measureFrom(0, []);

// The upper median: the value with half of the others below it.
const median =
  results.find(
    (value) =>
      results.filter((other) => other < value).length <= results.length / 2 &&
      results.filter((other) => other <= value).length > results.length / 2,
  ) ?? 0;

console.log(`median ${Math.round(median)} ms over ${results.length} songs`);

await browser.close();
